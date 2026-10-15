import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { format } from 'node:util';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import { ROOT, loadConfig, updateEnvFile } from './config.js';
import { splitMessage, downloadToFile } from './telegram-util.js';
import { authorizeMessage, authorizeCallback, isForwarded } from './auth.js';
import { resolveSite } from './sites.js';
import { makeJobDir, localDate } from './jobdir.js';
import { Store, StateError } from './state.js';
import { BROWSERS, buildSettings, decidePermission, describeRequest, grantKeys, siteDisablesHooks, siteWeakensSandbox } from './policy.js';
import { systemPrompt, userMessage } from './prompts.js';
import { buildArgs, startTurn, statusFromEvent } from './runner.js';
import { startBridge } from './permission-bridge.js';
import { inlineImages, unembeddedRefs, summaryFromMarkdown, renderReport, renderQaReport, parseQaReport, qaSummary } from './report.js';
import { createBatchTimer, isBatchClose } from './batch.js';
import { COMMANDS, LANGS, createT } from './i18n.js';
import { buildSiteIndex } from './site-index.js';
import { initWithRetry, isFatalTelegramError, sendNotices } from './startup.js';
import { extractHosts, matchSite, siteQuery } from './detect.js';

// Node prueba IPv6 e IPv4 a la vez y da 250 ms a cada intento. En esta máquina IPv6 no tiene
// ruta y la conexión IPv4 con api.telegram.org tarda 300-450 ms: con el plazo por defecto casi
// todas las llamadas fallan con ETIMEDOUT y getMe puede tardar minutos en el arranque. 5 s
// cubren también los ratos en que la red va lenta (se han visto 2 s de RTT).
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const cfg = loadConfig();
if (!cfg.token) {
  console.error('Falta TELEGRAM_TOKEN en .env');
  process.exit(1);
}
if (!BROWSERS.includes(cfg.chromiumBin)) {
  console.error(`CHROMIUM_BIN tiene que ser uno de: ${BROWSERS.join(', ')}`);
  process.exit(1);
}
if (!LANGS.includes(cfg.lang)) {
  console.error(`BOT_LANG tiene que ser uno de: ${LANGS.join(', ')}`);
  process.exit(1);
}
const t = createT(cfg.lang);

const redact = (s) => String(s).split(cfg.token).join('<token>');
// grammY y su runner meten la URL de la API, con el token, en los errores que escriben en
// consola. El journal no debe guardarlo.
for (const level of ['log', 'info', 'warn', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(redact(format(...args)));
}
// Node escribe los errores no capturados directo en stderr, sin pasar por console: el HttpError
// de grammY guarda en .error el error original, con la URL y el token.
// El código 1 queda para los fallos de configuración, que la unidad no reintenta
// (RestartPreventExitStatus=1). Un fallo inesperado sale con otro código para que systemd
// vuelva a arrancar el bot.
const EXIT_CRASH = 70;
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(`${event}:`, err);
    process.exit(EXIT_CRASH);
  });
}
const chat = () => cfg.chatId ?? cfg.ownerId;

const bot = new Bot(cfg.token);
const store = new Store(cfg.statePath);
store.load();
if (store.recovered) console.error(`state.json ilegible: apartado en ${store.recovered}; arranco sin trabajo`);

let busy = false;
let killCurrent = null;
const permissions = new Map();
// Permisos del botón «Permitir en este trabajo». Viven en memoria hasta cerrar el trabajo.
const grants = new Set();
// Lote de mensajes: se cierra solo tras cfg.batchIdleMs sin mensajes nuevos (equivale a /plan).
const batch = createBatchTimer(cfg.batchIdleMs, () => closeBatch());
const idleText = () => (cfg.batchIdleMs >= 60_000 ? `${Math.round(cfg.batchIdleMs / 60_000)} min` : `${Math.round(cfg.batchIdleMs / 1000)} s`);
const notFoundText = (name, site) => `${t('notFound', { root: cfg.sitesRoot, name })}${site.suggestions.length ? t('notFoundMaybe', { list: site.suggestions.join(', ') }) : ''}`;
// Se reconstruye en cada detección: son unos pocos ficheros y así nunca queda viejo.
const buildIndex = () => buildSiteIndex({ sitesRoot: cfg.sitesRoot, vhostDir: cfg.vhostDir });
const batchHosts = () => [...new Set(store.nextBatch.flatMap((it) => it.hosts ?? []))];
// Una captura ya descargada vuelve a ser fileId para descargarse en la carpeta de otro trabajo.
const unmaterialize = (it) => (it.type === 'image' && it.fileId ? { ...it, path: undefined } : it);
let conflict = null; // { site, sid } mientras se decide «Cambiar a Y» / «Añadir a X»
let lastPrompt = ''; // hosts de la última pregunta de sitio, para no repetirla en cada foto de un álbum

const phaseLabel = (phase) => t(`phase_${phase}`);

async function say(text, extra = {}) {
  const parts = splitMessage(text);
  let last;
  for (let i = 0; i < parts.length; i++) {
    last = await bot.api.sendMessage(chat(), parts[i], i === parts.length - 1 ? extra : {});
  }
  return last;
}

// Updates en curso: un despliegue espera a que terminen (una captura a medio descargar
// todavía no está en state.json).
bot.use(async (ctx, next) => {
  inflight++;
  try {
    await next();
  } finally {
    inflight--;
    if (draining) setImmediate(exitIfIdle);
  }
});

// --- Autorización -----------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    if (!authorizeCallback(ctx.callbackQuery.from, cfg.ownerId, cfg.chatId, ctx.callbackQuery.message?.chat)) return;
    return next();
  }
  const msg = ctx.message;
  if (!msg) return;
  if (msg.migrate_to_chat_id && msg.chat?.id === chat()) {
    cfg.chatId = msg.migrate_to_chat_id;
    updateEnvFile(cfg.envPath, { CHAT_ID: String(cfg.chatId) });
    console.log(`Grupo migrado a supergrupo. CHAT_ID actualizado: ${cfg.chatId}`);
    return;
  }
  const verdict = authorizeMessage(msg, cfg.ownerId, cfg.chatId);
  if (verdict === 'ignore') return;
  if (verdict === 'register') {
    cfg.ownerId = msg.from.id;
    cfg.chatId = msg.chat.id;
    updateEnvFile(cfg.envPath, { OWNER_ID: String(cfg.ownerId), CHAT_ID: String(cfg.chatId) });
    console.log(`OWNER_ID registrado: ${cfg.ownerId}, CHAT_ID: ${cfg.chatId}`);
    await ctx.reply(t('registered', { owner: cfg.ownerId, chat: cfg.chatId }));
    return;
  }
  return next();
});

// Los reenvíos son contenido de QA aunque empiecen por «/»: no pasan por los comandos.
bot.use((ctx, next) => (ctx.message && isForwarded(ctx.message) ? handleContent(ctx) : next()));

// --- Comandos ---------------------------------------------------------------

bot.command('start', (ctx) => ctx.reply(t('start')));

// Los nombres en español e inglés valen siempre, sea cual sea BOT_LANG.
bot.command(COMMANDS.new, async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) return ctx.reply(t('askSite'));
  if (!store.job) return openJob(name);
  // /nuevo explícito gana a la detección mientras el lote se está recogiendo.
  if (busy || store.job.phase !== 'collecting') return ctx.reply(t('jobAlreadyOpen', { site: store.job.site }));
  const target = resolveSite(name, cfg.sitesRoot);
  if (!target.ok) return ctx.reply(notFoundText(name, target));
  if (target.name === store.job.site) return ctx.reply(t('sameSite', { site: target.name }));
  const from = store.job.site;
  for (const it of store.takePending()) store.addToNextBatch(unmaterialize(it));
  closeJob();
  return openJob(target.name, '', t('switching', { from, to: target.name }));
});

bot.command('plan', () => batch.flush());

bot.command(COMMANDS.status, (ctx) => {
  const j = store.job;
  const next = store.nextBatch.length ? t('nextBatch', { n: store.nextBatch.length }) : '';
  if (!j) return ctx.reply(`${t('noJob')}${next}`);
  return ctx.reply(t('statusJob', { site: j.site, phase: phaseLabel(j.phase), working: busy ? t('working') : '', round: j.round ?? 1, pending: j.pending.length, next, tokens: j.contextTokens, dir: j.jobDir }));
});

bot.command(COMMANDS.cancel, (ctx) => {
  if (!killCurrent) return ctx.reply(t('noTurn'));
  killCurrent();
  return ctx.reply(t('cancelling'));
});

bot.command(COMMANDS.close, async (ctx) => {
  if (!store.job) {
    if (busy || !store.nextBatch.length) return ctx.reply(t('noJob'));
    // Sin trabajo, /cerrar descarta el lote sin sitio: si no, se arrastra de un arranque a otro.
    const dropped = store.takeNextBatch().length;
    batch.cancel();
    return ctx.reply(t('dropped', { n: dropped }));
  }
  if (busy) return ctx.reply(t('claudeBusyClose'));
  const site = store.job.site;
  closeJob();
  await ctx.reply(t('jobClosed', { site }));
  return processNextBatch();
});

// --- Contenido --------------------------------------------------------------

async function downloadFile(fileId, fallbackExt) {
  const file = await bot.api.getFile(fileId);
  const ext = (path.extname(file.file_path || '').slice(1) || fallbackExt).toLowerCase();
  const name = store.nextImageName(ext);
  const dest = path.join(store.job.jobDir, 'img', name);
  return downloadToFile(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`, dest, { lang: cfg.lang });
}

// Las capturas viajan como fileId hasta que hay trabajo; se descargan al entrar en él.
async function addToJob(items) {
  for (const it of items) {
    if (it.type !== 'image' || it.path) {
      store.addPending(it);
      continue;
    }
    try {
      store.addPending({ ...it, path: await downloadFile(it.fileId, it.ext) });
      continue;
    } catch {
      // Un fallo de red puntual no debe perder la captura: se reintenta una vez.
    }
    try {
      store.addPending({ ...it, path: await downloadFile(it.fileId, it.ext) });
    } catch (e) {
      store.addToNextBatch(it);
      await say(t('downloadFailed', { error: redact(e.message) }));
    }
  }
}

// Abre el trabajo y adopta el lote guardado. Hasta store.open no hay ningún await: los updates
// de un álbum se atienden en paralelo y los siguientes tienen que ver el trabajo ya abierto.
// `before` es el aviso del cierre anterior: se manda ya con el trabajo nuevo abierto, para que
// ningún update se cuele entre el cierre y la apertura.
async function openJob(name, reason = '', before = '') {
  const site = resolveSite(name, cfg.sitesRoot);
  if (!site.ok) {
    if (before) await say(before);
    return say(notFoundText(name, site));
  }
  const busyMsg = () => t('jobAlreadyOpen', { site: store.job.site });
  if (store.job) {
    if (before) await say(before);
    return say(busyMsg());
  }
  batch.cancel();
  const jobDir = makeJobDir(cfg.auditsRoot, site.name);
  try {
    store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  } catch (e) {
    if (!(e instanceof StateError) || e.code !== 'job-open') throw e;
    if (before) await say(before);
    return say(busyMsg());
  }
  const sessionId = store.job.sessionId;
  lastPrompt = '';
  const saved = store.takeNextBatch();
  let dirty = '';
  try { dirty = execFileSync('git', ['-C', site.path, 'status', '--short'], { encoding: 'utf8' }).trim(); } catch { dirty = ''; }
  // Con el repo sucio el lote no se cierra solo hasta que el dueño diga Seguir.
  if (dirty) store.setAwaitingDirty(true);

  if (before) await say(before);
  await addToJob(saved);
  if (store.job?.sessionId !== sessionId) return;
  if (!dirty && store.job.phase === 'collecting' && store.job.pending.length) batch.touch();

  const opened = reason ? t('openedReason', { site: site.name, reason }) : t('opened', { site: site.name });
  if (dirty) {
    const sid = sessionId.slice(0, 8);
    const kb = new InlineKeyboard().text(t('btnGo'), `dirty:go:${sid}`).text(t('btnCancel'), `dirty:cancel:${sid}`);
    return say(t('dirtyRepo', { opened, dirty: dirty.slice(0, 3000) }), { reply_markup: kb });
  }
  const count = store.job.pending.length;
  const next = count
    ? t('batchProgress', { count, idle: idleText() })
    : t('sendIssues');
  return say(t('openedFull', { opened, dir: jobDir, next }));
}

function closeJob() {
  batch.cancel();
  grants.clear();
  conflict = null;
  store.close();
}

async function receive(ctx, items, { forwarded, hosts = [] }) {
  const tagged = items.map((it) => ({ ...it, forwarded, hosts }));
  const job = store.job;
  if (!job) {
    // Lote sin sitio: se guarda y, si el mensaje trae URLs, se intenta detectar el sitio del lote.
    for (const it of tagged) store.addToNextBatch(it);
    batch.touch();
    if (hosts.length) return detectAndOpen(batchHosts());
    return;
  }
  if (forwarded && job.phase === 'reported' && !busy) {
    // Reenvío tras el informe: lote nuevo de QA.
    for (const it of tagged) store.addToNextBatch(it);
    return processNextBatch();
  }
  if (forwarded && (busy || job.phase === 'plan' || job.phase === 'implement')) {
    for (const it of tagged) store.addToNextBatch(it);
    return say(t('savedForNext'));
  }
  if (forwarded && job.phase === 'collecting') {
    if (conflict) {
      // El resto del reenvío en disputa (fotos de un álbum sin URL) espera a la respuesta.
      for (const it of tagged) store.addToNextBatch(it);
      return;
    }
    const m = hosts.length ? matchSite(hosts, buildIndex()) : { kind: 'none' };
    if (m.kind === 'one' && m.site !== job.site) {
      for (const it of tagged) store.addToNextBatch(it);
      const sid = job.sessionId.slice(0, 8);
      conflict = { site: m.site, sid };
      const kb = new InlineKeyboard().text(t('btnSwitch', { site: m.site }), `switch:${sid}`).text(t('btnKeep', { site: job.site }), `keep:${sid}`);
      return say(t('forwardConflict', { other: m.site, host: m.host, site: job.site }), { reply_markup: kb });
    }
  }
  await addToJob(tagged);
  if (!store.job || !store.job.pending.length) return;
  if (store.job.phase === 'collecting') {
    if (!store.job.awaitingDirty) batch.touch();
    return;
  }
  if (busy) return ctx.reply(t('noted'));
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

// Lote guardado sin turno en curso: tras el informe cierra el trabajo y empieza otro.
async function processNextBatch() {
  if (busy || !store.nextBatch.length) return;
  let before = '';
  if (store.job) {
    if (store.job.phase !== 'reported') return;
    before = t('newBatch', { site: store.job.site });
    closeJob();
  }
  batch.touch();
  return detectAndOpen(batchHosts(), before);
}

function siteKeyboard(sites) {
  const kb = new InlineKeyboard();
  for (const s of sites.slice(0, 5)) {
    if (Buffer.byteLength(`site:${s}`) <= 64) kb.text(s, `site:${s}`).row();
  }
  return kb.text(t('btnOther'), 'site-other');
}

// Sin trabajo abierto: un solo sitio abre el trabajo; varios o ninguno, botones. Nunca adivina.
// `before` se manda después de abrir (si hay un solo sitio) o antes de preguntar.
async function detectAndOpen(hosts, before = '') {
  if (store.job || !hosts.length) {
    if (before) await say(before);
    return;
  }
  const index = buildIndex();
  const m = matchSite(hosts, index);
  if (m.kind === 'one') return openJob(m.site, t('detectedBy', { host: m.host }), before);
  if (before) await say(before);
  const key = hosts.join(' ');
  if (key === lastPrompt) return;
  lastPrompt = key;
  if (m.kind === 'many') {
    return say(t('manySites', { sites: m.sites.join(', ') }), { reply_markup: siteKeyboard(m.sites) });
  }
  const candidates = [...new Set(hosts.flatMap((h) => {
    const r = resolveSite(siteQuery(h), cfg.sitesRoot);
    return r.ok ? [r.name] : r.suggestions;
  }))];
  const ask = candidates.length ? t('askAnyOf') : '';
  return say(t('noSiteKnown', { hosts: hosts.join(', '), ask }), { reply_markup: siteKeyboard(candidates) });
}

async function handleContent(ctx) {
  const msg = ctx.message;
  const forwarded = isForwarded(msg);
  let items;
  if (typeof msg.text === 'string') {
    const text = msg.text;
    if (!forwarded) {
      if (text.startsWith('/')) return ctx.reply(t('unknownCommand'));
      const batchOpen = store.job ? store.job.phase === 'collecting' : store.nextBatch.length > 0;
      if (batchOpen && isBatchClose(text)) return batch.flush();
    }
    items = [{ type: 'text', text }];
  } else if (msg.photo) {
    items = [{ type: 'image', fileId: msg.photo.at(-1).file_id, ext: 'jpg' }];
  } else if (msg.document) {
    const mime = msg.document.mime_type ?? '';
    if (!mime.startsWith('image/')) return ctx.reply(t('onlyImages'));
    items = [{ type: 'image', fileId: msg.document.file_id, ext: mime.split('/')[1].split('+')[0] }];
  } else {
    return;
  }
  if (msg.caption) items.push({ type: 'text', text: msg.caption });
  const hosts = extractHosts(msg.text ?? msg.caption ?? '', msg.entities ?? msg.caption_entities ?? []);
  return receive(ctx, items, { forwarded, hosts });
}

bot.on(['message:text', 'message:photo', 'message:document'], handleContent);

// Cierre del lote: por el temporizador, /plan o «eso es todo».
async function closeBatch() {
  try {
    if (conflict) return await say(t('conflictPending', { other: conflict.site, site: store.job?.site }));
    if (store.job?.awaitingDirty) return await say(t('dirtyPending'));
    if (!store.job && store.nextBatch.length) {
      return await say(batchHosts().length ? t('pickSite') : t('askSite'));
    }
    return await requestPlan();
  } catch (e) {
    console.error('Error cerrando el lote:', redact(e?.stack ?? e));
  }
}

async function requestPlan() {
  try {
    store.startPlan();
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    const msg = { 'no-job': t('planNoJob'), empty: t('planEmpty'), 'bad-phase': t('planBadPhase') };
    return say(msg[e.code] ?? e.message);
  }
  if (busy) return say(t('noted'));
  return runTurn();
}

// --- Botones ----------------------------------------------------------------

bot.callbackQuery(/^dirty:go:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (store.job?.sessionId.slice(0, 8) !== ctx.match[1]) return;
  store.setAwaitingDirty(false);
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job?.phase === 'collecting' && store.job.pending.length) batch.touch();
  return say(t('goOn', { idle: idleText() }));
});

bot.callbackQuery(/^dirty:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (store.job?.sessionId.slice(0, 8) !== ctx.match[1]) return;
  if (busy) return say(t('dirtyCancelBusy'));
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job?.sessionId.slice(0, 8) !== ctx.match[1] || busy) return;
  closeJob();
  return say(t('jobCancelled'));
});

bot.callbackQuery(/^site:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job) return say(t('jobAlreadyOpenShort', { site: store.job.site }));
  return openJob(ctx.match[1]);
});

bot.callbackQuery('site-other', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  return say(t('useNew'));
});

const conflictIs = (sid) => conflict?.sid === sid && store.job?.sessionId.slice(0, 8) === sid;

bot.callbackQuery(/^switch:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (!conflictIs(ctx.match[1])) return say(t('staleQuestion'));
  const { site } = conflict;
  const from = store.job.site;
  closeJob();
  return openJob(site, '', t('jobClosed', { site: from }));
});

bot.callbackQuery(/^keep:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (!conflictIs(ctx.match[1])) return say(t('staleQuestion'));
  conflict = null;
  const site = store.job.site;
  await addToJob(store.takeNextBatch());
  if (store.job && !store.job.awaitingDirty) batch.touch();
  return say(t('addedTo', { site }));
});

// approve:<sid8>:<ronda>:<turno de plan>. Solo vale el botón del último turno de plan del trabajo.
const approveData = (job) => `approve:${job.sessionId.slice(0, 8)}:${job.round ?? 1}:${job.planTurns ?? 0}`;

bot.callbackQuery(/^approve(?::.*)?$/, async (ctx) => {
  const j = store.job;
  if (!j || j.phase !== 'plan' || ctx.callbackQuery.data !== approveData(j)) {
    await ctx.answerCallbackQuery({ text: t('stalePlan') });
    return ctx.editMessageReplyMarkup().catch(() => {});
  }
  await ctx.answerCallbackQuery();
  if (busy) return say(t('claudeStillWorking'));
  try { store.approve(); } catch { return say(t('noPlanPending')); }
  await ctx.editMessageReplyMarkup().catch(() => {});
  store.addPending({ type: 'text', text: t('planApproved') });
  return runTurn();
});

bot.callbackQuery(/^perm:(.+):(allow|deny|always)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, id, choice] = ctx.match;
  const p = permissions.get(id);
  if (!p) return;
  if (choice === 'always') for (const k of p.keys ?? []) grants.add(k);
  p.resolve(choice === 'deny' ? { behavior: 'deny', message: t('permDeniedByOwner') } : { behavior: 'allow' });
  const outcome = { allow: t('permAllowed'), deny: t('permDenied'), always: t('permAlways', { label: p.label }) }[choice];
  await ctx.editMessageText(t('permOutcome', { text: p.text, outcome }));
});

// --- Permisos ---------------------------------------------------------------

async function onPermission({ tool_name, input }) {
  const decision = decidePermission(tool_name, input, { botDir: ROOT });
  if (decision.action === 'deny') return { behavior: 'deny', message: decision.message };
  if (!busy) return { behavior: 'deny', message: t('permNoTurn') };
  const keys = grantKeys(tool_name, input);
  if (keys?.every((k) => grants.has(k))) return { behavior: 'allow' };
  const id = randomUUID().slice(0, 8);
  const text = t('permText', { request: describeRequest(tool_name, input) });
  const label = keys ? keys[0].replace(/^(?:Bash|edit):/, '') : '';
  const kb = new InlineKeyboard().text(t('btnAllow'), `perm:${id}:allow`).text(t('btnDeny'), `perm:${id}:deny`);
  if (keys) kb.row().text(t('btnAlways', { label }), `perm:${id}:always`);
  const msg = await say(text, { reply_markup: kb });
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      permissions.delete(id);
      resolve({ behavior: 'deny', message: t('permTimeout') });
      await bot.api.editMessageText(chat(), msg.message_id, t('permOutcome', { text, outcome: t('permTimeoutOutcome') })).catch(() => {});
    }, cfg.permissionTimeoutMs);
    permissions.set(id, {
      text,
      keys,
      label,
      resolve: (r) => { clearTimeout(timer); permissions.delete(id); resolve(r); },
    });
  });
}

// --- Turnos -----------------------------------------------------------------

async function runTurn() {
  const job = store.job;
  if (!job || busy) return;
  // Con un despliegue pendiente no se abre otro turno: lo pendiente queda en state.json.
  if (draining) return setImmediate(exitIfIdle);
  // Sin el hook PreToolUse los allow del sitio saltarían la política del bot: no se arranca.
  if (siteDisablesHooks(job.sitePath)) {
    return say(t('hooksDisabled', { site: job.site }));
  }
  // El hook da por aislado lo que corre en el sandbox: si un settings lo debilita, no se arranca.
  if (siteWeakensSandbox(job.sitePath)) {
    return say(t('sandboxDefined', { site: job.site }));
  }
  busy = true;
  let restored = false;
  try {
    const phase = job.phase === 'implement' ? 'implement' : 'plan';
    const status = await say(phase === 'plan' ? t('analyzing') : t('implementing'));
    const items = store.takePending();
    if (phase === 'plan') store.beginPlanTurn();
    const turnStart = new Date();
    let lastEdit = 0;

    let args;
    let turn;
    try {
      args = buildArgs({
        sessionId: job.sessionId,
        resume: job.started,
        mode: phase === 'plan' ? 'plan' : 'manual',
        systemPrompt: systemPrompt({ phase, lang: cfg.lang, site: job.site, sitePath: job.sitePath, jobDir: job.jobDir, browser: cfg.chromiumBin }),
        settings: buildSettings({ phase, sitePath: job.sitePath, jobDir: job.jobDir, botEnvPath: cfg.envPath, botDir: ROOT, nodeBin: process.execPath }),
        mcpConfig: { mcpServers: { bot: { command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-permission.js')], env: { BOT_SOCKET: cfg.socketPath } } } },
      });

      turn = startTurn({
        bin: cfg.claudeBin,
        cwd: job.sitePath,
        args,
        prompt: userMessage(items, { lang: cfg.lang }),
        timeoutMs: cfg.turnTimeoutMs,
        env: { MCP_TOOL_TIMEOUT: String(cfg.permissionTimeoutMs + 60_000) },
        onEvent: (e) => {
          if (e.type === 'system' && e.subtype === 'init' && !store.job?.started) store.markStarted();
          const s = statusFromEvent(e);
          if (!s || Date.now() - lastEdit < 4000) return;
          lastEdit = Date.now();
          bot.api.editMessageText(chat(), status.message_id, t(phase === 'plan' ? 'analyzingLive' : 'implementingLive', { status: s })).catch(() => {});
        },
      });
    } catch (e) {
      // Fallo síncrono antes de lanzar claude: los elementos vuelven a la cola para «sigue».
      if (store.job?.sessionId === job.sessionId) store.returnPending(items);
      restored = true;
      await bot.api.deleteMessage(chat(), status.message_id).catch(() => {});
      await say(t('launchFailed', { error: redact(e.message) })).catch(() => {});
      return;
    }
    killCurrent = turn.kill;
    const r = await turn.promise;

    if (r.sessionSeen && !job.started) store.markStarted();
    // Sin sesión Claude no llegó a leer nada: los elementos vuelven a la cola para «sigue».
    if (!r.sessionSeen && store.job?.sessionId === job.sessionId) {
      store.returnPending(items);
      restored = true;
    }
    if (r.contextTokens) store.setContextTokens(r.contextTokens);
    await bot.api.deleteMessage(chat(), status.message_id).catch(() => {});

    try {
      if (r.timedOut) await say(t('turnTimedOut'));
      else if (r.killed) await say(t('turnKilled'));
      else if (r.isError) {
        const limit = /limit/i.test(r.text) ? t('usageLimit') : '';
        await say(t('claudeError', { limit, text: r.text || r.stderr }));
      } else if (!r.ok) await say(t('claudeNoResponse', { code: r.exitCode, stderr: r.stderr }));
      else if (phase === 'plan') {
        await say(r.text || t('emptyResponse'), { reply_markup: new InlineKeyboard().text(t('btnApprove'), approveData(store.job)) });
      } else {
        await say(r.text || t('implDone'));
        await deliverReport(turnStart);
      }

      if (store.job && store.job.contextTokens > cfg.contextWarnTokens) {
        await say(t('contextWarn', { tokens: store.job.contextTokens }));
      }
    } catch (e) {
      await say(t('deliverError', { error: redact(e.message) })).catch(() => {});
    }
  } finally {
    busy = false;
    killCurrent = null;
  }
  if (draining) return setImmediate(exitIfIdle);
  // Los elementos devueltos esperan a «sigue»: reintentar aquí sería un bucle si claude no arranca.
  if (restored) return;
  if (store.job?.pending.length && store.job.phase !== 'collecting') {
    if (store.job.phase === 'reported') store.startPlan();
    return runTurn();
  }
  return processNextBatch();
}

async function deliverReport(turnStart) {
  const job = store.job;
  const htmlPath = path.join(job.jobDir, 'informe.html');
  const jsonPath = path.join(job.jobDir, 'informe.json');
  const mdPath = path.join(job.jobDir, 'informe.md');
  const isFresh = (p) => existsSync(p) && (!turnStart || statSync(p).mtime >= turnStart);

  let htmlSource;
  let summary = '';
  if (isFresh(jsonPath)) {
    let report;
    try {
      report = parseQaReport(readFileSync(jsonPath, 'utf8'), { lang: cfg.lang });
      htmlSource = renderQaReport(report, { site: job.site, date: localDate(), lang: cfg.lang });
      summary = qaSummary(report, { lang: cfg.lang });
    } catch (err) {
      return say(t('fixReport', { error: err.message }));
    }
    writeFileSync(htmlPath, htmlSource);
  } else if (isFresh(htmlPath)) {
    htmlSource = readFileSync(htmlPath, 'utf8');
  } else if (isFresh(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    htmlSource = renderReport(md, { title: `QA ${job.site} ${localDate()}`, lang: cfg.lang });
    writeFileSync(htmlPath, htmlSource);
  } else {
    return say(t('noReportWritten', { path: jsonPath }));
  }

  const html = inlineImages(htmlSource, job.jobDir);
  const missing = unembeddedRefs(html);
  if (!summary && existsSync(mdPath)) summary = summaryFromMarkdown(readFileSync(mdPath, 'utf8'));
  await bot.api.sendDocument(chat(), new InputFile(Buffer.from(html), t('reportFile', { site: job.site, date: localDate() })));
  store.finishImplement();
  if (summary) await say(summary);
  if (missing.length) await say(t('missingImages', { list: missing.join(', ') }));
  return say(t('reviewDiff'));
}

// --- Despliegue -------------------------------------------------------------

// bin/deploy.sh manda SIGUSR2: el bot deja de abrir turnos, sale con código 0 cuando no hay
// turno ni update en curso, y el despliegue actualiza el árbol y lo vuelve a arrancar. El
// árbol no cambia mientras corre un turno: sus hooks y su MCP cargan código de aquí.
const DEPLOY_NOTICE = path.join(ROOT, 'deploy-notice.txt');
const READY_FILE = path.join(ROOT, 'bot.ready');
const POLLING_FILE = path.join(ROOT, 'bot.polling');
let draining = false;
let inflight = 0;
let runner = null;
let stopping = null;

async function exitIfIdle() {
  if (!draining || busy || inflight > 0) return;
  // runner.stop() devuelve la tarea solo la primera vez; las siguientes llamadas la reutilizan.
  stopping ??= Promise.resolve(runner?.stop()).catch(() => {});
  await stopping;
  if (busy || inflight > 0) return;
  console.log('Despliegue: salgo para cargar el código nuevo');
  process.exit(0);
}

process.on('SIGUSR2', () => {
  if (draining) return;
  draining = true;
  console.log(busy ? 'Despliegue pedido: salgo al terminar el turno en curso' : 'Despliegue pedido');
  setImmediate(exitIfIdle);
});

// --- Arranque ---------------------------------------------------------------

bot.catch((err) => console.error('Error del bot:', redact(err.error?.stack ?? err.error ?? err)));

await startBridge(cfg.socketPath, onPermission);

const restartHint = (phase) => t(['collecting', 'plan', 'implement', 'reported'].includes(phase) ? `hint_${phase}` : 'hint_default');

// Los avisos de arranque salen en segundo plano: con la red saturada tardan minutos y
// deploy-apply.sh solo espera READY_TIMEOUT a bot.ready (y luego vigila la unidad READY_GRACE s).
const notices = [];
if (existsSync(DEPLOY_NOTICE)) {
  const notice = readFileSync(DEPLOY_NOTICE, 'utf8').trim();
  // El fichero se borra al enviarse: si un SIGUSR2 corta el arranque antes, el aviso sigue ahí.
  if (cfg.ownerId && notice) {
    notices.push({ label: 'Aviso de despliegue', send: async () => { await say(t('deployed', { notice })); unlinkSync(DEPLOY_NOTICE); } });
  } else {
    unlinkSync(DEPLOY_NOTICE);
  }
}
if (cfg.ownerId && store.recovered) {
  notices.push({ label: 'Aviso de state.json dañado', send: () => say(t('stateCorrupt', { path: store.recovered })) });
}
if (cfg.ownerId && store.job) {
  // Valores capturados ahora: el aviso puede salir minutos después, con el trabajo ya cambiado.
  const { site, phase } = store.job;
  const hint = restartHint(phase);
  notices.push({ label: 'Aviso de trabajo abierto', send: () => say(t('restarted', { site, phase: phaseLabel(phase), hint })) });
}
void sendNotices(notices);
// El lote guardado no se anuncia al arrancar ni rearma el temporizador: sin trabajo abierto,
// cada arranque del sistema volvería a preguntar por el sitio. /estado lo muestra, y el siguiente
// mensaje o /plan lo retoma.
if (store.job?.phase === 'collecting' && store.job.pending.length && !store.job.awaitingDirty) batch.touch();

console.log(`Índice de sitios: ${buildIndex().size} hosts`);
// bot.ready dice que el proceso arrancó (puente, estado, manejadores), no que Telegram responda:
// con el enlace saturado getMe tarda minutos y un despliegue sano se revertiría. Pero grammY
// necesita botInfo (getMe) para tratar los updates, así que el sondeo empieza cuando getMe
// funciona, reintentándolo en segundo plano.
// deploy-apply.sh espera este fichero para dar por bueno el arranque.
writeFileSync(READY_FILE, `${process.pid}\n`);
console.log('issue-bot listo; conectando con Telegram');
void (async () => {
  try {
    if (!(await initWithRetry(() => bot.init(), { shouldStop: () => draining, isPermanent: isFatalTelegramError }))) return;
  } catch (err) {
    // Token inválido: igual que un fallo de configuración, la unidad no lo reintenta.
    console.error('getMe rechazado por Telegram, no reintento:', err?.message ?? err);
    process.exit(1);
  }
  runner = run(bot);
  // Con esto deploy-apply.sh da por terminado el periodo de vigilancia sin agotarlo.
  writeFileSync(POLLING_FILE, `${process.pid}\n`);
  console.log('issue-bot escuchando');
})();

import { readFileSync, writeFileSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import { ROOT, loadConfig, setEnvValue } from './config.js';
import { splitMessage } from './telegram-util.js';
import { authorizeMessage, authorizeCallback } from './auth.js';
import { resolveSite } from './sites.js';
import { makeJobDir, localDate } from './jobdir.js';
import { Store, StateError } from './state.js';
import { buildSettings, decidePermission, describeRequest } from './policy.js';
import { systemPrompt, userMessage } from './prompts.js';
import { buildArgs, startTurn, statusFromEvent } from './runner.js';
import { startBridge } from './permission-bridge.js';
import { inlineImages, unembeddedRefs, summaryFromMarkdown, renderReport } from './report.js';

const cfg = loadConfig();
if (!cfg.token) {
  console.error('Falta TELEGRAM_TOKEN en .env');
  process.exit(1);
}

const redact = (s) => String(s).split(cfg.token).join('<token>');
const chat = () => cfg.chatId ?? cfg.ownerId;

const bot = new Bot(cfg.token);
const store = new Store(cfg.statePath);
store.load();

let busy = false;
let killCurrent = null;
const orphans = [];
const permissions = new Map();

const PHASE_LABEL = { collecting: 'recogida', plan: 'plan', implement: 'implementación', reported: 'informe entregado' };

async function say(text, extra = {}) {
  const parts = splitMessage(text);
  let last;
  for (let i = 0; i < parts.length; i++) {
    last = await bot.api.sendMessage(chat(), parts[i], i === parts.length - 1 ? extra : {});
  }
  return last;
}

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
    const text = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, 'utf8') : '';
    writeFileSync(cfg.envPath, setEnvValue(text, 'CHAT_ID', String(cfg.chatId)), { mode: 0o600 });
    console.log(`Grupo migrado a supergrupo. CHAT_ID actualizado: ${cfg.chatId}`);
    return;
  }
  const verdict = authorizeMessage(msg, cfg.ownerId, cfg.chatId);
  if (verdict === 'ignore') return;
  if (verdict === 'register') {
    cfg.ownerId = msg.from.id;
    cfg.chatId = msg.chat.id;
    const text = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, 'utf8') : '';
    const updated = setEnvValue(setEnvValue(text, 'OWNER_ID', String(cfg.ownerId)), 'CHAT_ID', String(cfg.chatId));
    writeFileSync(cfg.envPath, updated, { mode: 0o600 });
    console.log(`OWNER_ID registrado: ${cfg.ownerId}, CHAT_ID: ${cfg.chatId}`);
    await ctx.reply(`Registrado: dueño ${cfg.ownerId}, chat ${cfg.chatId}. Solo atiendo al dueño en este chat.`);
    return;
  }
  return next();
});

// --- Comandos ---------------------------------------------------------------

bot.command('start', (ctx) => ctx.reply('Comandos: /nuevo <sitio>, /plan, /estado, /cancelar, /cerrar'));

bot.command('nuevo', async (ctx) => {
  if (store.job) return ctx.reply(`Ya hay un trabajo abierto en ${store.job.site}. Ciérralo con /cerrar.`);
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio>.');
  const site = resolveSite(name, cfg.sitesRoot);
  if (!site.ok) {
    const list = site.suggestions.length ? `\n¿Quizá: ${site.suggestions.join(', ')}?` : '';
    return ctx.reply(`No existe ${cfg.sitesRoot}/${name}.${list}`);
  }
  const jobDir = makeJobDir(cfg.auditsRoot, site.name);
  store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  for (const item of orphans.splice(0)) store.addPending(item);

  let dirty = '';
  try { dirty = execFileSync('git', ['-C', site.path, 'status', '--short'], { encoding: 'utf8' }).trim(); } catch { dirty = ''; }
  if (dirty) {
    const sid = store.job.sessionId.slice(0, 8);
    const kb = new InlineKeyboard().text('Seguir', `dirty:go:${sid}`).text('Cancelar', `dirty:cancel:${sid}`);
    return say(`Trabajo abierto en ${site.name}, pero el repo tiene cambios sin commitear:\n${dirty.slice(0, 3000)}\n¿Sigo?`, { reply_markup: kb });
  }
  return ctx.reply(`Trabajo abierto en ${site.name}.\nCarpeta: ${jobDir}\nMándame los issues y termina con /plan.`);
});

bot.command('plan', (ctx) => requestPlan(ctx));

bot.command('estado', (ctx) => {
  const j = store.job;
  if (!j) return ctx.reply('No hay trabajo abierto.');
  return ctx.reply(`Sitio: ${j.site}\nFase: ${PHASE_LABEL[j.phase]}${busy ? ' (Claude trabajando)' : ''}\nPendientes: ${j.pending.length}\nContexto: ${j.contextTokens} tokens\nCarpeta: ${j.jobDir}`);
});

bot.command('cancelar', (ctx) => {
  if (!killCurrent) return ctx.reply('No hay ningún turno en curso.');
  killCurrent();
  return ctx.reply('Cortando el turno…');
});

bot.command('cerrar', async (ctx) => {
  if (!store.job) return ctx.reply('No hay trabajo abierto.');
  if (busy) return ctx.reply('Claude está trabajando. Usa /cancelar primero.');
  const site = store.job.site;
  store.close();
  return ctx.reply(`Trabajo en ${site} cerrado.`);
});

// --- Contenido --------------------------------------------------------------

async function downloadFile(fileId, fallbackExt) {
  const file = await bot.api.getFile(fileId);
  const ext = (path.extname(file.file_path || '').slice(1) || fallbackExt).toLowerCase();
  const name = store.nextImageName(ext);
  const dest = path.join(store.job.jobDir, 'img', name);
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`descarga ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

async function receive(ctx, items) {
  if (!store.job) {
    orphans.push(...items);
    return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio> y lo añado al trabajo.');
  }
  for (const item of items) store.addPending(item);
  if (store.job.phase === 'collecting') return;
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return ctx.reply('Comando desconocido. Usa /start para ver la lista.');
  if (store.job?.phase === 'collecting' && /^eso es todo\.?$/i.test(text.trim())) return requestPlan(ctx);
  return receive(ctx, [{ type: 'text', text }]);
});

bot.on('message:photo', async (ctx) => {
  if (!store.job) return ctx.reply('Primero /nuevo <sitio>; luego reenvía la captura.');
  const photo = ctx.message.photo.at(-1);
  let dest;
  try {
    dest = await downloadFile(photo.file_id, 'jpg');
  } catch (e) {
    return ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  const items = [{ type: 'image', path: dest }];
  if (ctx.message.caption) items.push({ type: 'text', text: ctx.message.caption });
  return receive(ctx, items);
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) return ctx.reply('Solo acepto imágenes como archivo.');
  if (!store.job) return ctx.reply('Primero /nuevo <sitio>; luego reenvía la captura.');
  let dest;
  try {
    dest = await downloadFile(doc.file_id, doc.mime_type.split('/')[1].split('+')[0]);
  } catch (e) {
    return ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  const items = [{ type: 'image', path: dest }];
  if (ctx.message.caption) items.push({ type: 'text', text: ctx.message.caption });
  return receive(ctx, items);
});

async function requestPlan(ctx) {
  try {
    store.startPlan();
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    const msg = { 'no-job': 'No hay trabajo abierto. Usa /nuevo <sitio>.', empty: 'Aún no me has mandado ningún issue.', 'bad-phase': 'El plan ya está en marcha.' };
    return ctx.reply(msg[e.code] ?? e.message);
  }
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  return runTurn();
}

// --- Botones ----------------------------------------------------------------

bot.callbackQuery(/^dirty:go:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (store.job?.sessionId.slice(0, 8) !== ctx.match[1]) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
  return say('Sigo. Mándame los issues y termina con /plan.');
});

bot.callbackQuery(/^dirty:cancel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (store.job?.sessionId.slice(0, 8) !== ctx.match[1]) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job && !busy) store.close();
  return say('Trabajo cancelado.');
});

bot.callbackQuery('approve', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (busy) return say('Claude sigue trabajando; espera a que termine.');
  try { store.approve(); } catch { return say('No hay ningún plan pendiente de aprobar.'); }
  await ctx.editMessageReplyMarkup().catch(() => {});
  store.addPending({ type: 'text', text: 'Plan aprobado. Implementa lo aprobado y escribe el informe.' });
  return runTurn();
});

bot.callbackQuery(/^perm:(.+):(allow|deny)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, id, choice] = ctx.match;
  const p = permissions.get(id);
  if (!p) return;
  p.resolve(choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denegado por el dueño.' });
  await ctx.editMessageText(`${p.text}\n→ ${choice === 'allow' ? 'Permitido' : 'Denegado'}`);
});

// --- Permisos ---------------------------------------------------------------

async function onPermission({ tool_name, input }) {
  const decision = decidePermission(tool_name, input);
  if (decision.action === 'deny') return { behavior: 'deny', message: decision.message };
  if (!busy) return { behavior: 'deny', message: 'No hay turno en curso.' };
  const id = randomUUID().slice(0, 8);
  const text = `Permiso: ${describeRequest(tool_name, input)}`;
  const kb = new InlineKeyboard().text('Permitir', `perm:${id}:allow`).text('Denegar', `perm:${id}:deny`);
  const msg = await say(text, { reply_markup: kb });
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      permissions.delete(id);
      resolve({ behavior: 'deny', message: 'Sin respuesta del dueño en 30 minutos.' });
      await bot.api.editMessageText(chat(), msg.message_id, `${text}\n→ Denegado por tiempo`).catch(() => {});
    }, cfg.permissionTimeoutMs);
    permissions.set(id, {
      text,
      resolve: (r) => { clearTimeout(timer); permissions.delete(id); resolve(r); },
    });
  });
}

// --- Turnos -----------------------------------------------------------------

async function runTurn() {
  const job = store.job;
  if (!job || busy) return;
  busy = true;
  try {
    const phase = job.phase === 'implement' ? 'implement' : 'plan';
    const status = await say(phase === 'plan' ? 'Analizando…' : 'Implementando…');
    const items = store.takePending();
    const turnStart = new Date();
    let lastEdit = 0;

    const args = buildArgs({
      sessionId: job.sessionId,
      resume: job.started,
      mode: phase === 'plan' ? 'plan' : 'manual',
      systemPrompt: systemPrompt({ phase, site: job.site, sitePath: job.sitePath, jobDir: job.jobDir }),
      settings: buildSettings({ phase, sitePath: job.sitePath, jobDir: job.jobDir, botEnvPath: cfg.envPath }),
      mcpConfig: { mcpServers: { bot: { command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-permission.js')], env: { BOT_SOCKET: cfg.socketPath } } } },
    });

    const turn = startTurn({
      bin: cfg.claudeBin,
      cwd: job.sitePath,
      args,
      prompt: userMessage(items),
      timeoutMs: cfg.turnTimeoutMs,
      env: { MCP_TOOL_TIMEOUT: String(cfg.permissionTimeoutMs + 60_000) },
      onEvent: (e) => {
        if (e.type === 'system' && e.subtype === 'init' && !store.job?.started) store.markStarted();
        const s = statusFromEvent(e);
        if (!s || Date.now() - lastEdit < 4000) return;
        lastEdit = Date.now();
        bot.api.editMessageText(chat(), status.message_id, `${phase === 'plan' ? 'Analizando' : 'Implementando'}… ${s}`).catch(() => {});
      },
    });
    killCurrent = turn.kill;
    const r = await turn.promise;

    if (r.sessionSeen && !job.started) store.markStarted();
    if (r.contextTokens) store.setContextTokens(r.contextTokens);
    await bot.api.deleteMessage(chat(), status.message_id).catch(() => {});

    try {
      if (r.timedOut) await say('Turno cortado a los 45 minutos. Escribe «sigue» para retomarlo.');
      else if (r.killed) await say('Turno cancelado. Escribe «sigue» para retomarlo.');
      else if (r.isError) {
        const limit = /limit/i.test(r.text) ? 'Límite de uso alcanzado. ' : '';
        await say(`${limit}Error de Claude: ${r.text || r.stderr}\nCuando puedas, escribe «sigue».`);
      } else if (!r.ok) await say(`Claude terminó sin respuesta (código ${r.exitCode}).\n${r.stderr}\nEscribe «sigue» para reintentar.`);
      else if (phase === 'plan') {
        await say(r.text || '(respuesta vacía)', { reply_markup: new InlineKeyboard().text('Aprobar plan', 'approve') });
      } else {
        await say(r.text || 'Implementación terminada.');
        await deliverReport(turnStart);
      }

      if (store.job && store.job.contextTokens > cfg.contextWarnTokens) {
        await say(`El contexto va por ${store.job.contextTokens} tokens. Conviene /cerrar y abrir otro trabajo.`);
      }
    } catch (e) {
      await say(`Error entregando el resultado: ${redact(e.message)}. Escribe «sigue» para reintentar.`).catch(() => {});
    }
  } finally {
    busy = false;
    killCurrent = null;
  }
  if (store.job?.pending.length && store.job.phase !== 'collecting') {
    if (store.job.phase === 'reported') store.startPlan();
    return runTurn();
  }
}

async function deliverReport(turnStart) {
  const job = store.job;
  const htmlPath = path.join(job.jobDir, 'informe.html');
  const mdPath = path.join(job.jobDir, 'informe.md');
  const isFresh = (p) => existsSync(p) && (!turnStart || statSync(p).mtime >= turnStart);

  let htmlSource;
  if (isFresh(htmlPath)) {
    htmlSource = readFileSync(htmlPath, 'utf8');
  } else if (isFresh(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    htmlSource = renderReport(md, { title: `QA ${job.site} ${localDate()}` });
    writeFileSync(htmlPath, htmlSource);
  } else {
    return say(`Claude terminó sin escribir ${mdPath}. Escribe «sigue» para pedírselo.`);
  }

  const html = inlineImages(htmlSource, job.jobDir);
  const missing = unembeddedRefs(html);
  const summary = existsSync(mdPath) ? summaryFromMarkdown(readFileSync(mdPath, 'utf8')) : '';
  await bot.api.sendDocument(chat(), new InputFile(Buffer.from(html), `informe-${job.site}-${localDate()}.html`));
  store.finishImplement();
  if (summary) await say(summary);
  if (missing.length) await say(`Imágenes que no encontré: ${missing.join(', ')}`);
  return say('Revisa el diff en el repo. Si hay correcciones, escríbelas; si no, /cerrar.');
}

// --- Arranque ---------------------------------------------------------------

bot.catch((err) => console.error('Error del bot:', redact(err.error?.stack ?? err.error ?? err)));

await startBridge(cfg.socketPath, onPermission);

const RESTART_HINT = {
  collecting: 'Sigue mandando issues y termina con /plan. O /cerrar.',
  plan: 'Escribe «sigue» para continuar. O /cerrar.',
  implement: 'Escribe «sigue» para continuar. O /cerrar.',
  reported: 'Escribe correcciones o /cerrar.',
};

if (cfg.ownerId && store.job) {
  const hint = RESTART_HINT[store.job.phase] ?? 'Escribe «sigue» para continuar o /cerrar.';
  await say(`Bot reiniciado. Trabajo abierto en ${store.job.site}, fase ${PHASE_LABEL[store.job.phase]}. ${hint}`).catch(() => {});
}

await bot.init();
run(bot);
console.log('issue-bot escuchando');

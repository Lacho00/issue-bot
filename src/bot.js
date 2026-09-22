import { readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs';
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
import { inlineImages, unembeddedRefs, summaryFromMarkdown } from './report.js';

const cfg = loadConfig();
if (!cfg.token) {
  console.error('Falta TELEGRAM_TOKEN en .env');
  process.exit(1);
}

const redact = (s) => String(s).split(cfg.token).join('<token>');

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
    last = await bot.api.sendMessage(cfg.ownerId, parts[i], i === parts.length - 1 ? extra : {});
  }
  return last;
}

// --- Autorización -----------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    if (!authorizeCallback(ctx.callbackQuery.from, cfg.ownerId)) return;
    return next();
  }
  const msg = ctx.message;
  if (!msg) return;
  const verdict = authorizeMessage(msg, cfg.ownerId);
  if (verdict === 'ignore') return;
  if (verdict === 'register') {
    cfg.ownerId = msg.from.id;
    const text = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, 'utf8') : '';
    writeFileSync(cfg.envPath, setEnvValue(text, 'OWNER_ID', String(cfg.ownerId)), { mode: 0o600 });
    console.log(`OWNER_ID registrado: ${cfg.ownerId}`);
    await ctx.reply(`Registrado como dueño (ID ${cfg.ownerId}). No aceptaré mensajes de nadie más.`);
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
    const kb = new InlineKeyboard().text('Seguir', 'dirty:go').text('Cancelar', 'dirty:cancel');
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

async function receive(ctx, item) {
  if (!store.job) {
    orphans.push(item);
    return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio> y lo añado al trabajo.');
  }
  store.addPending(item);
  if (store.job.phase === 'collecting') return;
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return ctx.reply('Comando desconocido. Usa /start para ver la lista.');
  if (store.job?.phase === 'collecting' && /^eso es todo\.?$/i.test(text.trim())) return requestPlan(ctx);
  return receive(ctx, { type: 'text', text });
});

bot.on('message:photo', async (ctx) => {
  if (!store.job) return receive(ctx, { type: 'text', text: '(captura enviada antes de /nuevo: reenvíala)' });
  const photo = ctx.message.photo.at(-1);
  let dest;
  try {
    dest = await downloadFile(photo.file_id, 'jpg');
  } catch (e) {
    await ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  if (dest) await receive(ctx, { type: 'image', path: dest });
  if (ctx.message.caption) await receive(ctx, { type: 'text', text: ctx.message.caption });
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) return ctx.reply('Solo acepto imágenes como archivo.');
  if (!store.job) return receive(ctx, { type: 'text', text: '(captura enviada antes de /nuevo: reenvíala)' });
  let dest;
  try {
    dest = await downloadFile(doc.file_id, doc.mime_type.split('/')[1]);
  } catch (e) {
    await ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  if (dest) await receive(ctx, { type: 'image', path: dest });
  if (ctx.message.caption) await receive(ctx, { type: 'text', text: ctx.message.caption });
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

bot.callbackQuery('dirty:go', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  return say('Sigo. Mándame los issues y termina con /plan.');
});

bot.callbackQuery('dirty:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
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
      await bot.api.editMessageText(cfg.ownerId, msg.message_id, `${text}\n→ Denegado por tiempo`).catch(() => {});
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
    const items = store.takePending();
    const status = await say(phase === 'plan' ? 'Analizando…' : 'Implementando…');
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
        const s = statusFromEvent(e);
        if (!s || Date.now() - lastEdit < 4000) return;
        lastEdit = Date.now();
        bot.api.editMessageText(cfg.ownerId, status.message_id, `${phase === 'plan' ? 'Analizando' : 'Implementando'}… ${s}`).catch(() => {});
      },
    });
    killCurrent = turn.kill;
    const r = await turn.promise;

    if (r.sessionSeen && !job.started) store.markStarted();
    if (r.contextTokens) store.setContextTokens(r.contextTokens);
    await bot.api.deleteMessage(cfg.ownerId, status.message_id).catch(() => {});

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
      await deliverReport();
    }

    if (store.job && store.job.contextTokens > cfg.contextWarnTokens) {
      await say(`El contexto va por ${store.job.contextTokens} tokens. Conviene /cerrar y abrir otro trabajo.`);
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

async function deliverReport() {
  const job = store.job;
  const htmlPath = path.join(job.jobDir, 'informe.html');
  if (!existsSync(htmlPath)) {
    return say(`Claude terminó sin escribir ${htmlPath}. Escribe «sigue» para pedírselo.`);
  }
  store.finishImplement();
  const html = inlineImages(readFileSync(htmlPath, 'utf8'), job.jobDir);
  const missing = unembeddedRefs(html);
  const mdPath = path.join(job.jobDir, 'informe.md');
  const summary = existsSync(mdPath) ? summaryFromMarkdown(readFileSync(mdPath, 'utf8')) : '';
  await bot.api.sendDocument(cfg.ownerId, new InputFile(Buffer.from(html), `informe-${job.site}-${localDate()}.html`));
  if (summary) await say(summary);
  if (missing.length) await say(`Imágenes que no encontré: ${missing.join(', ')}`);
  return say('Revisa el diff en el repo. Si hay correcciones, escríbelas; si no, /cerrar.');
}

// --- Arranque ---------------------------------------------------------------

bot.catch((err) => console.error('Error del bot:', redact(err.error?.stack ?? err.error ?? err)));

await startBridge(cfg.socketPath, onPermission);

if (cfg.ownerId && store.job) {
  await say(`Bot reiniciado. Trabajo abierto en ${store.job.site}, fase ${PHASE_LABEL[store.job.phase]}. Escribe «sigue» para continuar o /cerrar.`).catch(() => {});
}

run(bot);
console.log('issue-bot escuchando');

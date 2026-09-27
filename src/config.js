import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function setEnvValue(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  const base = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

const positiveInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function loadConfig(envPath = path.join(ROOT, '.env')) {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return {
    envPath,
    token: env.TELEGRAM_TOKEN || '',
    ownerId: env.OWNER_ID ? Number(env.OWNER_ID) : null,
    chatId: env.CHAT_ID ? Number(env.CHAT_ID) : null,
    sitesRoot: env.SITES_ROOT || '/srv/http',
    vhostDir: env.VHOST_DIR || '/etc/httpd/conf/extra',
    auditsRoot: env.AUDITS_ROOT || '/home/lacho/audits',
    claudeBin: env.CLAUDE_BIN || 'claude',
    statePath: path.join(ROOT, 'state.json'),
    socketPath: env.BOT_SOCKET || path.join(ROOT, 'bot.sock'),
    turnTimeoutMs: 45 * 60 * 1000,
    permissionTimeoutMs: 30 * 60 * 1000,
    contextWarnTokens: 200_000,
    batchIdleMs: positiveInt(env.BATCH_IDLE_MS, 120_000),
  };
}

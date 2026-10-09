import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv, setEnvValue, loadConfig, updateEnvFile } from '../src/config.js';

test('parseEnv lee claves y valores', () => {
  assert.deepEqual(parseEnv('TELEGRAM_TOKEN=abc:1\nOWNER_ID=\n# nota\n'), {
    TELEGRAM_TOKEN: 'abc:1',
    OWNER_ID: '',
  });
});

test('setEnvValue reemplaza una clave existente', () => {
  assert.equal(setEnvValue('A=1\nOWNER_ID=\n', 'OWNER_ID', '42'), 'A=1\nOWNER_ID=42\n');
});

test('setEnvValue añade una clave que falta', () => {
  assert.equal(setEnvValue('A=1\n', 'OWNER_ID', '42'), 'A=1\nOWNER_ID=42\n');
});

test('loadConfig: OWNER_ID vacío es null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=\n');
  const cfg = loadConfig(envPath);
  assert.equal(cfg.token, 't');
  assert.equal(cfg.ownerId, null);
  assert.equal(cfg.turnTimeoutMs, 45 * 60 * 1000);
  assert.equal(cfg.permissionTimeoutMs, 30 * 60 * 1000);
});

test('loadConfig: OWNER_ID numérico', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=123\n');
  assert.equal(loadConfig(envPath).ownerId, 123);
});

test('loadConfig: sin CHAT_ID es null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=123\n');
  assert.equal(loadConfig(envPath).chatId, null);
});

test('loadConfig: CHAT_ID numérico (puede ser negativo, grupo)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=123\nCHAT_ID=-100987654321\n');
  assert.equal(loadConfig(envPath).chatId, -100987654321);
});

test('loadConfig: BATCH_IDLE_MS por defecto 120000; vacío o inválido cae al defecto', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=abc\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
});

test('loadConfig: BATCH_IDLE_MS numérico', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=5000\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 5000);
});

test('loadConfig: VHOST_DIR por defecto y configurable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\n');
  assert.equal(loadConfig(envPath).vhostDir, '/etc/httpd/conf/extra');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nVHOST_DIR=/tmp/vhosts-prueba\n');
  assert.equal(loadConfig(envPath).vhostDir, '/tmp/vhosts-prueba');
});

test('updateEnvFile cambia varias claves, conserva el resto y deja permisos 600', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=\n', { mode: 0o644 });
  updateEnvFile(envPath, { OWNER_ID: '1', CHAT_ID: '-2' });
  assert.equal(readFileSync(envPath, 'utf8'), 'TELEGRAM_TOKEN=t\nOWNER_ID=1\nCHAT_ID=-2\n');
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['.env']);
});

test('updateEnvFile crea el fichero si no existe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  updateEnvFile(envPath, { CHAT_ID: '5' });
  assert.equal(readFileSync(envPath, 'utf8'), 'CHAT_ID=5\n');
});

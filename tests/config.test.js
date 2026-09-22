import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv, setEnvValue, loadConfig } from '../src/config.js';

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

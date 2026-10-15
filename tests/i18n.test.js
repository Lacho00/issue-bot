import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANGS, COMMANDS, DICTIONARIES, createT } from '../src/i18n.js';
import { isBatchClose } from '../src/batch.js';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

test('es y en tienen las mismas claves y los mismos marcadores', () => {
  assert.deepEqual(LANGS, ['es', 'en']);
  const es = Object.keys(DICTIONARIES.es).sort();
  const en = Object.keys(DICTIONARIES.en).sort();
  assert.deepEqual(en, es);
  for (const key of es) {
    assert.deepEqual(placeholders(DICTIONARIES.en[key]), placeholders(DICTIONARIES.es[key]), key);
  }
});

test('t sustituye marcadores y lanza con una clave desconocida', () => {
  const t = createT('en');
  assert.equal(t('jobClosed', { site: 'x' }), 'Job on x closed.');
  assert.equal(createT('es').jobClosed, undefined);
  assert.equal(createT('es')('jobClosed', { site: 'x' }), 'Trabajo en x cerrado.');
  assert.throws(() => t('no.such.key'), /desconocida/);
  assert.throws(() => createT('fr'), /soportado/);
});

test('el español conserva los textos de siempre', () => {
  const t = createT('es');
  assert.equal(t('start'), 'Reenvíame los mensajes de la QA: detecto el sitio por sus URLs. Comandos: /nuevo <sitio>, /plan, /estado, /cancelar, /cerrar');
  assert.equal(t('planApproved'), 'Plan aprobado. Implementa lo aprobado y escribe el informe.');
});

test('la ayuda en inglés lista los comandos en inglés', () => {
  const start = createT('en')('start');
  for (const c of ['/new', '/plan', '/status', '/cancel', '/close']) assert.ok(start.includes(c), c);
  assert.doesNotMatch(start, /\/nuevo|\/estado|\/cancelar|\/cerrar/);
});

test('alias de comandos en español e inglés', () => {
  assert.deepEqual(COMMANDS, {
    new: ['nuevo', 'new'],
    status: ['estado', 'status'],
    cancel: ['cancelar', 'cancel'],
    close: ['cerrar', 'close'],
  });
  const bot = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  for (const k of Object.keys(COMMANDS)) assert.ok(bot.includes(`bot.command(COMMANDS.${k},`), k);
});

test('«eso es todo» y «that\'s all» cierran el lote en cualquier idioma', () => {
  for (const ok of ['eso es todo', 'Eso es todo.', "that's all", "That's all.", 'THAT IS ALL', 'that is all.', '  that’s all  ']) {
    assert.equal(isBatchClose(ok), true, ok);
  }
  for (const no of ['eso es todo, gracias', "that's all folks", 'all', '']) assert.equal(isBatchClose(no), false, no);
});

test('BOT_LANG: es por defecto y toma el valor del .env', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lang-'));
  const envPath = path.join(dir, '.env');
  assert.equal(loadConfig(envPath).lang, 'es');
  writeFileSync(envPath, 'BOT_LANG=en\n');
  assert.equal(loadConfig(envPath).lang, 'en');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, userMessage } from '../src/prompts.js';

const ctx = { site: 'tienda-demo', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21' };

test('plan: solo lectura, formato de plan y valores medidos', () => {
  const p = systemPrompt({ ...ctx, phase: 'plan' });
  assert.match(p, /no edites/i);
  assert.match(p, /Causa/);
  assert.match(p, /getComputedStyle/);
  assert.match(p, /tienda-demo/);
});

test('ninguna fase pide leer el CLAUDE.md: se carga solo con --setting-sources', () => {
  assert.doesNotMatch(systemPrompt({ ...ctx, phase: 'plan' }), /CLAUDE\.md/);
  assert.doesNotMatch(systemPrompt({ ...ctx, phase: 'implement' }), /CLAUDE\.md/);
});

test('implement: solo lo aprobado, informe en la carpeta del trabajo', () => {
  const p = systemPrompt({ ...ctx, phase: 'implement' });
  assert.match(p, /solo lo aprobado/i);
  assert.match(p, /informe\.json/);
  assert.match(p, /qa-2026-09-21/);
  assert.match(p, /sin commitear/i);
});

test('implement: pide el informe en español con Antes y Después', () => {
  const p = systemPrompt({ ...ctx, phase: 'implement' });
  assert.match(p, /informe\.json \(UTF-8, en español\)/i);
  assert.match(p, /"qa": \{ "message"/);
  assert.match(p, /"after"/);
});

test('userMessage junta textos y rutas de capturas', () => {
  const m = userMessage([
    { type: 'text', text: '1. flechas pixeladas' },
    { type: 'image', path: '/x/img/qa-01.jpg' },
  ]);
  assert.match(m, /1\. flechas pixeladas/);
  assert.match(m, /\/x\/img\/qa-01\.jpg/);
});

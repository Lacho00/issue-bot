import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, userMessage } from '../src/prompts.js';

const ctx = { site: 'tienda-demo', sitePath: '/srv/http/tienda-demo', jobDir: '/home/user/audits/tienda-demo/results/qa-2026-09-21' };

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

test('inglés: instrucciones en inglés, mismas claves JSON y mismos status', () => {
  const es = systemPrompt({ ...ctx, phase: 'implement' });
  const en = systemPrompt({ ...ctx, phase: 'implement', lang: 'en' });
  assert.match(en, /Write in English/);
  assert.match(en, /only what was approved/i);
  assert.match(en, /informe\.json \(UTF-8, in English\)/);
  assert.match(en, /corregido \| mitigado \| no-codigo \| pendiente/);
  assert.match(en, /"corregido" = fixed/);
  const keys = (p) => [...p.matchAll(/"(\w+)":/g)].map((m) => m[1]).filter((k) => k !== 'status').sort();
  for (const k of ['context', 'branch', 'issues', 'title', 'qa', 'message', 'images', 'before', 'cause', 'fix', 'files', 'measurements', 'after', 'notes', 'element', 'viewport', 'property', 'src', 'label']) {
    assert.ok(en.includes(`"${k}":`), k);
  }
  assert.deepEqual([...new Set(keys(en))], [...new Set(keys(es))]);
  assert.doesNotMatch(en, /Escribe en español|solo lo aprobado|Nunca hagas/i);
  assert.match(en, /chromium/);
});

test('inglés: fase de plan', () => {
  const p = systemPrompt({ ...ctx, phase: 'plan', lang: 'en', browser: 'google-chrome' });
  assert.match(p, /read-only/i);
  assert.match(p, /Cause:/);
  assert.match(p, /getComputedStyle/);
  assert.match(p, /google-chrome/);
  assert.match(p, /if available/);
  assert.doesNotMatch(p, /Escribe en español|solo lectura|Causa:/i);
});

test('el grafo codebase-memory es condicional en ambos idiomas', () => {
  assert.match(systemPrompt({ ...ctx, phase: 'plan' }), /si está disponible/);
});

test('userMessage: marcador de captura por idioma', () => {
  const items = [{ type: 'image', path: '/x/a.jpg' }];
  assert.equal(userMessage(items), '[Captura: /x/a.jpg]');
  assert.equal(userMessage(items, { lang: 'en' }), '[Screenshot: /x/a.jpg]');
});

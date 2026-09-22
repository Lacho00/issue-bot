import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSite } from '../src/sites.js';

function root() {
  const r = mkdtempSync(path.join(tmpdir(), 'sites-'));
  for (const d of ['tienda-demo', 'cien-pinos', 'consultoria-juridica', '.claude']) mkdirSync(path.join(r, d));
  return r;
}

test('nombre exacto resuelve la ruta', () => {
  const r = root();
  assert.deepEqual(resolveSite('tienda-demo', r), { ok: true, name: 'tienda-demo', path: path.join(r, 'tienda-demo') });
});

test('nombre parecido devuelve sugerencias con el más cercano primero', () => {
  const res = resolveSite('consultoria', root());
  assert.equal(res.ok, false);
  assert.equal(res.suggestions[0], 'consultoria-juridica');
});

test('rechaza rutas y carpetas ocultas', () => {
  const r = root();
  assert.equal(resolveSite('../etc', r).ok, false);
  assert.equal(resolveSite('.claude', r).ok, false);
  assert.equal(resolveSite('a/b', r).ok, false);
});

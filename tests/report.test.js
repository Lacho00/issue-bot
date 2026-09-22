import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inlineImages, unembeddedRefs, summaryFromMarkdown } from '../src/report.js';

test('embebe imágenes locales y deja las externas', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  mkdirSync(path.join(dir, 'img'));
  writeFileSync(path.join(dir, 'img', 'a.png'), Buffer.from([1, 2, 3]));
  const html = '<img src="img/a.png" alt=""><img alt="x" src="https://e.com/b.png">';
  const out = inlineImages(html, dir);
  assert.match(out, /src="data:image\/png;base64,AQID"/);
  assert.match(out, /https:\/\/e\.com\/b\.png/);
  assert.deepEqual(unembeddedRefs(out), []);
});

test('una imagen que no existe queda como referencia sin embeber', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  const out = inlineImages('<img src="img/falta.jpg">', dir);
  assert.deepEqual(unembeddedRefs(out), ['img/falta.jpg']);
});

test('summaryFromMarkdown extrae la primera tabla', () => {
  const md = '# QA\n\ntexto\n\n| # | Issue | Estado |\n|---|---|---|\n| 1 | Flechas | Corregido |\n\n## 1. Flechas\n';
  assert.equal(summaryFromMarkdown(md), '| # | Issue | Estado |\n|---|---|---|\n| 1 | Flechas | Corregido |');
});

test('summaryFromMarkdown sin tabla devuelve cadena vacía', () => {
  assert.equal(summaryFromMarkdown('# QA\n\nnada'), '');
});

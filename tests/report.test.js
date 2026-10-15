import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inlineImages, unembeddedRefs, summaryFromMarkdown, renderReport, renderQaReport, parseQaReport, qaSummary } from '../src/report.js';

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

test('path traversal: ../secreto.png afuera de baseDir queda sin embeber', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  const parentDir = path.join(dir, '..');
  writeFileSync(path.join(parentDir, 'secreto.png'), Buffer.from([1, 2, 3]));
  const html = '<img src="../secreto.png">';
  const out = inlineImages(html, dir);
  assert.deepEqual(unembeddedRefs(out), ['../secreto.png']);
});

test('URI malformada 50%off.png no lanza y queda sin embeber', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  const html = '<img src="50%off.png">';
  const out = inlineImages(html, dir);
  assert.doesNotThrow(() => { unembeddedRefs(out); });
  assert.deepEqual(unembeddedRefs(out), ['50%off.png']);
});

test('renderReport genera una tabla a partir de una tabla Markdown', () => {
  const md = '| # | Issue |\n|---|---|\n| 1 | Flechas |\n';
  const out = renderReport(md, { title: 'QA sitio 2026-09-21' });
  assert.match(out, /<table>/);
});

test('renderReport convierte una imagen Markdown en <img src="...">', () => {
  const md = '![Antes](img/a.png)';
  const out = renderReport(md, { title: 'QA' });
  assert.match(out, /<img src="img\/a\.png"/);
});

test('renderReport incluye el meta viewport', () => {
  const out = renderReport('texto', { title: 'QA' });
  assert.match(out, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
});

test('renderReport + inlineImages embebe una imagen existente', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  mkdirSync(path.join(dir, 'img'));
  writeFileSync(path.join(dir, 'img', 'a.png'), Buffer.from([1, 2, 3]));
  const md = '![Antes](img/a.png)';
  const html = renderReport(md, { title: 'QA' });
  const out = inlineImages(html, dir);
  assert.match(out, /src="data:image\/png;base64,AQID"/);
});

const REPORT = {
  site: 'sitio',
  date: '2026-09-26',
  context: 'Probado en local, escritorio y móvil. Cambios sin commitear en `main`.',
  issues: [
    {
      title: 'Icono de búsqueda negro',
      status: 'corregido',
      qa: { message: 'El icono de la lupa sale negro <b>', images: ['img/qa-01.jpg'] },
      before: ['img/01-antes-local.png'],
      cause: 'El reset `btn-reset` pisa `text-white`.',
      fix: 'Orden de las clases.',
      files: ['assets/css/main.css'],
      measurements: [{ element: '.icon-search', property: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 255, 255)' }],
      after: [{ src: 'img/01-escritorio.png', label: 'Escritorio' }, 'img/01-movil.png'],
    },
    { title: 'Texto legal', status: 'no-codigo', qa: { message: 'Falta el aviso', images: [] }, cause: 'Contenido del editor.' },
  ],
};

test('renderQaReport pone Antes y Después lado a lado con las fotos de la QA', () => {
  const out = renderQaReport(REPORT);
  assert.match(out, /class="ba"/);
  assert.match(out, /<img src="img\/qa-01\.jpg"/);
  assert.match(out, /<img src="img\/01-antes-local\.png"/);
  assert.match(out, /<img src="img\/01-escritorio\.png"[^>]*alt="Escritorio"/);
  assert.match(out, /<img src="img\/01-movil\.png"/);
  const card = out.slice(out.indexOf('id="issue-1"'));
  assert.ok(card.indexOf('qa-01.jpg') < card.indexOf('01-escritorio.png'), 'Antes va antes que Después');
});

test('renderQaReport escapa el mensaje de la QA y convierte `code`', () => {
  const out = renderQaReport(REPORT);
  assert.match(out, /sale negro &lt;b&gt;/);
  assert.match(out, /<code>btn-reset<\/code>/);
});

test('renderQaReport cuenta los estados en los KPIs y usa el estilo de wp-audit', () => {
  const out = renderQaReport(REPORT);
  assert.match(out, /<div class="kpi big"><b>2<\/b>/);
  assert.match(out, /chip st-corregido/);
  assert.match(out, /chip st-no-codigo/);
  assert.match(out, /--canvas:/);
  assert.match(out, /prefers-color-scheme:dark/);
  assert.match(out, /<meta name="viewport"/);
});

test('renderQaReport sin fotos Después lo indica en vez de dejar la columna vacía', () => {
  const out = renderQaReport(REPORT);
  const card = out.slice(out.indexOf('id="issue-2"'));
  assert.match(card, /Sin captura/);
});

test('renderQaReport rechaza un src que no es ruta relativa ni data:', () => {
  const out = renderQaReport({ ...REPORT, issues: [{ title: 'x', status: 'corregido', after: ['javascript:alert(1)'] }] });
  assert.doesNotMatch(out, /javascript:/);
});

test('parseQaReport valida la forma mínima', () => {
  assert.throws(() => parseQaReport('{}'), /issues/);
  assert.throws(() => parseQaReport('no json'), /JSON/);
  assert.equal(parseQaReport(JSON.stringify(REPORT)).issues.length, 2);
});

test('qaSummary da una línea por issue con su estado', () => {
  assert.equal(qaSummary(REPORT), '1. Icono de búsqueda negro — Corregido\n2. Texto legal — No es de código');
});

test('renderQaReport ignora medidas que no son objetos', () => {
  const out = renderQaReport({ issues: [{ title: 'X', status: 'pendiente', measurements: [null, 'texto', { element: 'h1', property: 'color', before: 'a', after: 'b' }] }] });
  assert.match(out, /<code>h1<\/code>/);
});

test('renderQaReport trata un estado heredado de Object.prototype como otro', () => {
  const out = renderQaReport({ issues: [{ title: 'X', status: 'constructor' }] });
  assert.match(out, /chip st-otro/);
});

test('informe en inglés: etiquetas, lang y estados traducidos', () => {
  const report = { issues: [{ title: 'Arrows', status: 'corregido', cause: 'c', fix: 'f', files: ['a.php'], measurements: [{ element: '.a', property: 'color', before: '1', after: '2' }], after: [] }, { title: 'B', status: 'no-codigo' }], context: 'ctx' };
  const out = renderQaReport(report, { site: 'demo', date: '2026-01-01', lang: 'en' });
  assert.match(out, /<html lang="en">/);
  for (const w of ['QA report', 'Before', 'After', 'Summary', 'Fixed', 'Not a code issue', 'Cause', 'Fix', 'Files', 'Measurements', 'No screenshot', 'Dark', 'Light']) assert.ok(out.includes(w), w);
  assert.match(out, /st-corregido/);
  assert.doesNotMatch(out, /Informe de QA|Antes|Después|Resumen|Corregido|Oscuro/);
  assert.match(qaSummary(report, { lang: 'en' }), /1\. Arrows — Fixed/);
  assert.throws(() => parseQaReport('{', { lang: 'en' }), /not valid JSON/);
  assert.throws(() => parseQaReport('{"issues":[]}', { lang: 'en' }), /at least one issue/);
  assert.match(renderReport('# x', { lang: 'en' }), /<html lang="en">[\s\S]*Report/);
});

test('informe: el español es el valor por defecto', () => {
  const out = renderQaReport({ issues: [{ title: 'A', status: 'corregido' }] }, { site: 's', date: 'd' });
  assert.match(out, /<html lang="es">/);
  assert.match(out, /Informe de QA/);
  assert.match(out, /Corregidos/);
});

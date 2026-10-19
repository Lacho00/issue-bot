import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, mascotSvg, reportMood } from '../src/mascot.js';
import { renderQaReport, renderReport } from '../src/report.js';

test('reportMood: contenta si todo está corregido o no es de código', () => {
  assert.equal(reportMood(['corregido', 'no-codigo']), 'happy');
});

test('reportMood: preocupada si queda algo pendiente', () => {
  assert.equal(reportMood(['corregido', 'pendiente']), 'worried');
});

test('reportMood: neutral con mitigados, estados desconocidos o sin issues', () => {
  assert.equal(reportMood(['corregido', 'mitigado']), 'neutral');
  assert.equal(reportMood(['otro']), 'neutral');
  assert.equal(reportMood([]), 'neutral');
});

test('mascotSvg: cada expresión da un SVG decorativo distinto', () => {
  const svgs = MOODS.map((m) => mascotSvg(m));
  assert.equal(new Set(svgs).size, MOODS.length);
  for (const svg of svgs) assert.match(svg, /^<svg class="mascot"[^>]*aria-hidden="true"/);
});

test('mascotSvg: una expresión desconocida cae en neutral', () => {
  assert.equal(mascotSvg('nope'), mascotSvg('neutral'));
});

test('el informe lleva la mascota según el resultado', () => {
  const ok = renderQaReport({ issues: [{ title: 'A', status: 'Corregido' }] });
  const bad = renderQaReport({ issues: [{ title: 'A', status: 'pendiente' }] });
  assert.ok(ok.includes(mascotSvg('happy')));
  assert.ok(bad.includes(mascotSvg('worried')));
  assert.ok(renderReport('# x').includes(mascotSvg('neutral')));
});

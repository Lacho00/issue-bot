import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../src/telegram-util.js';

test('texto corto queda en un trozo', () => {
  assert.deepEqual(splitMessage('hola'), ['hola']);
});

test('texto largo se parte por saltos de línea sin pasar del máximo', () => {
  const text = Array.from({ length: 50 }, (_, i) => `linea ${i}`).join('\n');
  const parts = splitMessage(text, 60);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 60);
  assert.equal(parts.join('\n'), text);
});

test('una línea más larga que el máximo se corta en seco', () => {
  const parts = splitMessage('x'.repeat(130), 50);
  assert.deepEqual(parts.map((p) => p.length), [50, 50, 30]);
});

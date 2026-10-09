import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitMessage, downloadToFile } from '../src/telegram-util.js';

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

const dest = () => path.join(mkdtempSync(path.join(tmpdir(), 'dl-')), 'qa-01.png');
const ok = (body) => new Response(body, { status: 200 });
const fake = (...steps) => {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(opts);
    const step = steps.shift();
    return typeof step === 'function' ? step(opts) : step;
  };
  return { impl, calls };
};
const opts = (fetchImpl) => ({ fetchImpl, retryDelayMs: 1, timeoutMs: 50 });

test('downloadToFile escribe el cuerpo y pasa un signal con plazo', async () => {
  const f = dest();
  const { impl, calls } = fake(ok('png'));
  assert.equal(await downloadToFile('u', f, opts(impl)), f);
  assert.equal(readFileSync(f, 'utf8'), 'png');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('downloadToFile reintenta un fallo de red y un 502', async () => {
  const f = dest();
  const { impl, calls } = fake(() => { throw new TypeError('fetch failed'); }, new Response('', { status: 502 }), ok('x'));
  await downloadToFile('u', f, opts(impl));
  assert.equal(calls.length, 3);
  assert.equal(readFileSync(f, 'utf8'), 'x');
});

test('downloadToFile no reintenta un 404 y no deja fichero', async () => {
  const f = dest();
  const { impl, calls } = fake(new Response('', { status: 404 }), ok('x'));
  await assert.rejects(downloadToFile('u', f, opts(impl)), /descarga 404/);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(f), false);
});

test('downloadToFile corta una respuesta colgada por plazo y se rinde tras los intentos', async () => {
  const f = dest();
  const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const { impl, calls } = fake(hang, hang, hang);
  await assert.rejects(downloadToFile('u', f, opts(impl)), /sin respuesta en 0.05 s/);
  assert.equal(calls.length, 3);
  assert.equal(existsSync(f), false);
});

test('downloadToFile corta un cuerpo que se queda a medias', async () => {
  const f = dest();
  const stalled = ({ signal }) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('par'));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    return new Response(body, { status: 200 });
  };
  const { impl } = fake(stalled, stalled, ok('entero'));
  await downloadToFile('u', f, opts(impl));
  assert.equal(readFileSync(f, 'utf8'), 'entero');
});

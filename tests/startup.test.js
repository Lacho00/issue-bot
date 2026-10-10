import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireAndForget, sendNotices, initWithRetry } from '../src/startup.js';

test('fireAndForget no propaga el fallo: lo registra', async () => {
  const logs = [];
  await fireAndForget(() => Promise.reject(new Error('ETIMEDOUT')), 'Aviso', (m) => logs.push(m));
  assert.deepEqual(logs, ['Aviso: ETIMEDOUT']);
});

test('fireAndForget recoge también un throw síncrono', async () => {
  const logs = [];
  await fireAndForget(() => { throw new Error('boom'); }, 'X', (m) => logs.push(m));
  assert.equal(logs.length, 1);
});

test('sendNotices no espera a quien lo llama y no se detiene ante un fallo', async () => {
  const order = [];
  const logs = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const done = sendNotices([
    { label: 'a', send: async () => { await gate; order.push('a'); throw new Error('red'); } },
    { label: 'b', send: async () => { order.push('b'); } },
  ], (m) => logs.push(m));
  assert.deepEqual(order, []); // la llamada volvió sin esperar al envío
  release();
  await done;
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(logs, ['a: red']);
});

test('initWithRetry reintenta con espera creciente hasta que funciona', async () => {
  let calls = 0;
  const sleeps = [];
  const ok = await initWithRetry(
    async () => { if (++calls < 4) throw new Error('timeout'); },
    { sleep: async (ms) => { sleeps.push(ms); }, log: () => {} },
  );
  assert.equal(ok, true);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
});

test('initWithRetry limita la espera', async () => {
  let calls = 0;
  const sleeps = [];
  await initWithRetry(
    async () => { if (++calls < 8) throw new Error('x'); },
    { sleep: async (ms) => { sleeps.push(ms); }, log: () => {} },
  );
  assert.equal(Math.max(...sleeps), 30000);
});

test('initWithRetry para cuando shouldStop lo pide', async () => {
  let calls = 0;
  let stop = false;
  const ok = await initWithRetry(
    async () => { calls++; throw new Error('x'); },
    { sleep: async () => { stop = true; }, log: () => {}, shouldStop: () => stop },
  );
  assert.equal(ok, false);
  assert.equal(calls, 1);
});

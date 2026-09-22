import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchTimer } from '../src/batch.js';

test('touch rebota: solo dispara tras ms sin toques nuevos', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  assert.equal(b.pending, false);
  b.touch();
  assert.equal(b.pending, true);
  t.mock.timers.tick(119_999);
  assert.equal(fired, 0);
  b.touch();
  t.mock.timers.tick(119_999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  assert.equal(b.pending, false);
  t.mock.timers.tick(500_000);
  assert.equal(fired, 1);
});

test('flush dispara ya, devuelve el resultado y anula la espera', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; return 'hecho'; });
  b.touch();
  assert.equal(b.flush(), 'hecho');
  assert.equal(fired, 1);
  assert.equal(b.pending, false);
  t.mock.timers.tick(200_000);
  assert.equal(fired, 1);
});

test('flush sin espera pendiente también dispara', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  b.flush();
  assert.equal(fired, 1);
});

test('cancel anula sin disparar', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  b.touch();
  b.cancel();
  assert.equal(b.pending, false);
  t.mock.timers.tick(200_000);
  assert.equal(fired, 0);
});

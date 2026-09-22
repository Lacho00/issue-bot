import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, StateError } from '../src/state.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json');
const base = { site: 's', sitePath: '/srv/http/s', jobDir: '/tmp/j', sessionId: '00000000-0000-4000-8000-000000000000' };

test('recorrido completo', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.job.phase, 'collecting');
  st.addPending({ type: 'text', text: 'issue 1' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.deepEqual(st.takePending(), [{ type: 'text', text: 'issue 1' }]);
  assert.deepEqual(st.job.pending, []);
  st.approve();
  assert.equal(st.job.phase, 'implement');
  st.finishImplement();
  assert.equal(st.job.phase, 'reported');
  st.addPending({ type: 'text', text: 'corrige esto' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  st.close();
  assert.equal(st.job, null);
});

test('transiciones inválidas', () => {
  const st = new Store(file());
  assert.throws(() => st.startPlan(), (e) => e instanceof StateError && e.code === 'no-job');
  st.open(base);
  assert.throws(() => st.open(base), (e) => e.code === 'job-open');
  assert.throws(() => st.startPlan(), (e) => e.code === 'empty');
  assert.throws(() => st.approve(), (e) => e.code === 'bad-phase');
  assert.throws(() => st.finishImplement(), (e) => e.code === 'bad-phase');
});

test('persistencia: otro Store lee el mismo trabajo', () => {
  const f = file();
  const a = new Store(f);
  a.open(base);
  a.addPending({ type: 'text', text: 'x' });
  a.markStarted();
  const b = new Store(f);
  b.load();
  assert.equal(b.job.site, 's');
  assert.equal(b.job.started, true);
  assert.equal(b.job.pending.length, 1);
});

test('nombres de captura correlativos', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.nextImageName('jpg'), 'qa-01.jpg');
  assert.equal(st.nextImageName('png'), 'qa-02.png');
});

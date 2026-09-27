import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, StateError } from '../src/state.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json');
const base = { site: 's', sitePath: '/srv/http/s', jobDir: '/tmp/j', sessionId: '00000000-0000-4000-8000-000000000000' };

test('recorrido completo', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.job.phase, 'collecting');
  assert.equal(st.job.round, 1);
  st.addPending({ type: 'text', text: 'issue 1' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.equal(st.job.round, 1);
  assert.deepEqual(st.takePending(), [{ type: 'text', text: 'issue 1', forwarded: false }]);
  assert.deepEqual(st.job.pending, []);
  st.approve();
  assert.equal(st.job.phase, 'implement');
  st.finishImplement();
  assert.equal(st.job.phase, 'reported');
  st.addPending({ type: 'text', text: 'corrige esto' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.equal(st.job.round, 2);
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

test('addPending guarda forwarded como booleano', () => {
  const st = new Store(file());
  st.open(base);
  st.addPending({ type: 'text', text: 'de la QA', forwarded: true });
  st.addPending({ type: 'text', text: 'mío' });
  st.addPending({ type: 'image', path: '/tmp/j/img/qa-01.jpg', forwarded: 'sí' });
  assert.deepEqual(st.job.pending.map((i) => i.forwarded), [true, false, false]);
});

test('round: empieza en 1 y sube solo en correcciones tras reported', () => {
  const st = new Store(file());
  st.open(base);
  st.addPending({ type: 'text', text: 'a' });
  st.startPlan();
  st.approve();
  st.finishImplement();
  assert.equal(st.job.round, 1);
  for (const expected of [2, 3]) {
    st.addPending({ type: 'text', text: 'corrige' });
    st.startPlan();
    assert.equal(st.job.round, expected);
    st.approve();
    st.finishImplement();
  }
});

test('nextBatch: vive fuera del trabajo, se persiste y sobrevive a close', () => {
  const f = file();
  const a = new Store(f);
  a.addToNextBatch({ type: 'text', text: 'sin trabajo', forwarded: true });
  a.open(base);
  a.addToNextBatch({ type: 'image', fileId: 'F1', ext: 'jpg' });
  a.close();
  const b = new Store(f);
  b.load();
  assert.equal(b.job, null);
  assert.deepEqual(b.nextBatch, [
    { type: 'text', text: 'sin trabajo', forwarded: true },
    { type: 'image', fileId: 'F1', ext: 'jpg', forwarded: false },
  ]);
  assert.equal(b.takeNextBatch().length, 2);
  const c = new Store(f);
  c.load();
  assert.deepEqual(c.nextBatch, []);
});

test('state.json anterior sin round ni nextBatch se carga', () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ job: { ...base, phase: 'reported', started: true, pending: [], imageCount: 0, contextTokens: 0 } }));
  const st = new Store(f);
  st.load();
  assert.deepEqual(st.nextBatch, []);
  st.addPending({ type: 'text', text: 'corrección' });
  st.startPlan();
  assert.equal(st.job.round, 2);
});

test('returnPending devuelve los elementos al frente de pending y persiste', () => {
  const f = file();
  const st = new Store(f);
  st.open(base);
  st.addPending({ type: 'text', text: 'a' });
  const taken = st.takePending();
  st.addPending({ type: 'text', text: 'b' });
  st.returnPending(taken);
  assert.deepEqual(st.job.pending.map((i) => i.text), ['a', 'b']);
  const again = new Store(f);
  again.load();
  assert.deepEqual(again.job.pending.map((i) => i.text), ['a', 'b']);
  st.close();
  assert.throws(() => st.returnPending(taken), (e) => e.code === 'no-job');
});

test('awaitingDirty se guarda en el trabajo y se limpia', () => {
  const f = file();
  const st = new Store(f);
  st.open(base);
  assert.equal(st.job.awaitingDirty, false);
  st.setAwaitingDirty(true);
  const again = new Store(f);
  again.load();
  assert.equal(again.job.awaitingDirty, true);
  st.setAwaitingDirty(false);
  assert.equal(st.job.awaitingDirty, false);
});

test('beginPlanTurn numera los turnos de plan del trabajo', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.job.planTurns, 0);
  assert.equal(st.beginPlanTurn(), 1);
  assert.equal(st.beginPlanTurn(), 2);
  delete st.job.planTurns; // trabajo guardado por una versión anterior
  assert.equal(st.beginPlanTurn(), 1);
});

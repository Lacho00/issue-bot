import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const tag = (item) => ({ ...item, forwarded: item.forwarded === true });

export class StateError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.job = null;
    this.nextBatch = [];
  }

  load() {
    const data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    this.job = data.job ?? null;
    this.nextBatch = Array.isArray(data.nextBatch) ? data.nextBatch : [];
    return this.job;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ job: this.job, nextBatch: this.nextBatch }, null, 2));
    renameSync(tmp, this.file);
  }

  #require(...phases) {
    if (!this.job) throw new StateError('no-job');
    if (phases.length && !phases.includes(this.job.phase)) throw new StateError('bad-phase');
  }

  open({ site, sitePath, jobDir, sessionId }) {
    if (this.job) throw new StateError('job-open');
    this.job = { site, sitePath, jobDir, sessionId, phase: 'collecting', round: 1, started: false, pending: [], imageCount: 0, contextTokens: 0, awaitingDirty: false, planTurns: 0 };
    this.save();
  }

  addPending(item) {
    this.#require();
    this.job.pending.push(tag(item));
    this.save();
  }

  addToNextBatch(item) {
    this.nextBatch.push(tag(item));
    this.save();
  }

  takeNextBatch() {
    const items = this.nextBatch;
    this.nextBatch = [];
    this.save();
    return items;
  }

  takePending() {
    this.#require();
    const items = this.job.pending;
    this.job.pending = [];
    this.save();
    return items;
  }

  // Un turno que falló antes de crear la sesión no llegó a Claude: sus elementos vuelven a la cola.
  returnPending(items) {
    this.#require();
    this.job.pending = [...items, ...this.job.pending];
    this.save();
  }

  setAwaitingDirty(value) {
    this.#require();
    this.job.awaitingDirty = value === true;
    this.save();
  }

  // Cada turno de plan invalida los botones «Aprobar plan» de los anteriores.
  beginPlanTurn() {
    this.#require();
    this.job.planTurns = (this.job.planTurns ?? 0) + 1;
    this.save();
    return this.job.planTurns;
  }

  startPlan() {
    this.#require('collecting', 'reported');
    if (this.job.pending.length === 0) throw new StateError('empty');
    if (this.job.phase === 'reported') this.job.round = (this.job.round ?? 1) + 1;
    this.job.phase = 'plan';
    this.save();
  }

  approve() {
    this.#require('plan');
    this.job.phase = 'implement';
    this.save();
  }

  finishImplement() {
    this.#require('implement');
    this.job.phase = 'reported';
    this.save();
  }

  markStarted() {
    this.#require();
    this.job.started = true;
    this.save();
  }

  setContextTokens(n) {
    this.#require();
    this.job.contextTokens = n;
    this.save();
  }

  nextImageName(ext) {
    this.#require();
    this.job.imageCount += 1;
    this.save();
    return `qa-${String(this.job.imageCount).padStart(2, '0')}.${ext}`;
  }

  close() {
    this.job = null;
    this.save();
  }
}

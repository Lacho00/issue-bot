import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

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
  }

  load() {
    this.job = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')).job ?? null : null;
    return this.job;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ job: this.job }, null, 2));
    renameSync(tmp, this.file);
  }

  #require(...phases) {
    if (!this.job) throw new StateError('no-job');
    if (phases.length && !phases.includes(this.job.phase)) throw new StateError('bad-phase');
  }

  open({ site, sitePath, jobDir, sessionId }) {
    if (this.job) throw new StateError('job-open');
    this.job = { site, sitePath, jobDir, sessionId, phase: 'collecting', started: false, pending: [], imageCount: 0, contextTokens: 0 };
    this.save();
  }

  addPending(item) {
    this.#require();
    this.job.pending.push(item);
    this.save();
  }

  takePending() {
    this.#require();
    const items = this.job.pending;
    this.job.pending = [];
    this.save();
    return items;
  }

  startPlan() {
    this.#require('collecting', 'reported');
    if (this.job.pending.length === 0) throw new StateError('empty');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('bin/install-service.sh');
const ROOT = path.resolve('.');

// systemctl falso: apunta cada llamada en un fichero.
function run(args = [], { before } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-service-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "$*" >>"$DIR/calls"\n');
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  const unitDir = path.join(dir, 'config', 'systemd', 'user');
  before?.(unitDir);
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(dir, 'config'), DIR: dir },
  });
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  return { ...r, unit: path.join(unitDir, 'issue-bot.service'), calls: read(path.join(dir, 'calls')) };
}

test('install-service: escribe la unidad con la carpeta del clon y activa el servicio', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const unit = readFileSync(r.unit, 'utf8');
  assert.match(unit, new RegExp(`^WorkingDirectory=${ROOT}$`, 'm'));
  assert.match(unit, new RegExp(`^ExecStart=${ROOT}/bin/start.sh$`, 'm'));
  assert.doesNotMatch(unit, /@ROOT@/);
  assert.equal(r.calls, '--user daemon-reload\n--user enable --now issue-bot\n');
});

test('install-service: --no-start solo recarga, y reemplaza un enlace antiguo por un fichero', () => {
  const r = run(['--no-start'], {
    before: (unitDir) => {
      mkdirSync(unitDir, { recursive: true });
      symlinkSync('/no/existe/issue-bot.service', path.join(unitDir, 'issue-bot.service'));
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lstatSync(r.unit).isFile());
  assert.equal(r.calls, '--user daemon-reload\n');
});

test('install-service: rechaza argumentos desconocidos sin tocar nada', () => {
  const r = run(['--start']);
  assert.equal(r.status, 2);
  assert.equal(r.calls, '');
});

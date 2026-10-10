import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('bin/deploy-apply.sh');

// systemctl y sleep falsos: el estado vive en ficheros; sleep avanza un contador y, al llegar a
// STUB_AT, aplica STUB_EVENT (dead | pid | restarts | polling | ready).
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-apply-'));
  const bin = path.join(dir, 'bin');
  const write = (name, body) => { writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(path.join(dir, 'pid'), '100');
  writeFileSync(path.join(dir, 'restarts'), '0');
  write('systemctl', `
case "$2" in
  start) exit 0;;
  is-active) [[ -f "$DIR/dead" ]] && exit 3; exit 0;;
  show) [[ "$4" == MainPID ]] && cat "$DIR/pid" || cat "$DIR/restarts";;
esac`);
  write('sleep', `
n=$(( $(cat "$DIR/n" 2>/dev/null || echo 0) + 1 )); echo $n >"$DIR/n"
if [[ $n -eq \${STUB_AT:-0} ]]; then
  case "$STUB_EVENT" in
    dead) touch "$DIR/dead";;
    pid) echo 200 >"$DIR/pid";;
    restarts) echo 1 >"$DIR/restarts";;
    polling) touch "$DIR/bot.polling";;
    ready) touch "$DIR/bot.ready";;
  esac
fi`);
  return dir;
}

function run(env, { ready = true } = {}) {
  const dir = sandbox();
  if (ready) writeFileSync(path.join(dir, 'bot.ready'), '1\n');
  // start_and_wait borra bot.ready: el sleep falso lo vuelve a crear en el primer ciclo.
  const code = `
    export DEPLOY_APPLY_LIB=1 REPO='${dir}' DIR='${dir}' PATH='${dir}/bin':"$PATH"
    source '${SCRIPT}'
    start_and_wait; echo "rc=$?"`;
  const r = spawnSync('bash', ['-c', code], {
    env: { ...process.env, ...env, STUB_AT_READY: '1' },
    encoding: 'utf8',
  });
  return { ...r, dir, rc: /rc=(\d+)/.exec(r.stdout)?.[1] };
}

// Variante: el bot "escribe" bot.ready en el primer sleep.
function runFlow(env) {
  const dir = sandbox();
  writeFileSync(path.join(dir, 'bin', 'sleep'), `#!/usr/bin/env bash
n=$(( $(cat "$DIR/n" 2>/dev/null || echo 0) + 1 )); echo $n >"$DIR/n"
[[ $n -eq 1 ]] && touch "$DIR/bot.ready"
if [[ $n -eq \${STUB_AT:-0} ]]; then
  case "$STUB_EVENT" in
    dead) touch "$DIR/dead";;
    pid) echo 200 >"$DIR/pid";;
    restarts) echo 1 >"$DIR/restarts";;
    polling) touch "$DIR/bot.polling";;
  esac
fi
`);
  const r = spawnSync('bash', ['-c', `
    export DEPLOY_APPLY_LIB=1 REPO='${dir}' DIR='${dir}' PATH='${dir}/bin':"$PATH"
    source '${SCRIPT}'
    start_and_wait; echo "rc=$?"; echo "sleeps=$(cat "$DIR/n")"`], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return { ...r, rc: /rc=(\d+)/.exec(r.stdout)?.[1], sleeps: Number(/sleeps=(\d+)/.exec(r.stdout)?.[1]) };
}

test('sin incidencias agota el periodo de vigilancia y acepta', () => {
  const r = runFlow({ READY_GRACE: '10' });
  assert.equal(r.rc, '0');
  assert.equal(r.sleeps, 1 + 5); // un ciclo hasta ready + 10/2 de vigilancia
});

test('la unidad que se para durante la vigilancia hace fallar', () => {
  const r = runFlow({ READY_GRACE: '10', STUB_AT: '3', STUB_EVENT: 'dead' });
  assert.equal(r.rc, '1');
});

test('un cambio de MainPID durante la vigilancia hace fallar', () => {
  assert.equal(runFlow({ READY_GRACE: '10', STUB_AT: '3', STUB_EVENT: 'pid' }).rc, '1');
});

test('un aumento de NRestarts durante la vigilancia hace fallar', () => {
  assert.equal(runFlow({ READY_GRACE: '10', STUB_AT: '3', STUB_EVENT: 'restarts' }).rc, '1');
});

test('bot.polling corta la vigilancia antes de tiempo', () => {
  const r = runFlow({ READY_GRACE: '40', STUB_AT: '2', STUB_EVENT: 'polling' });
  assert.equal(r.rc, '0');
  assert.ok(r.sleeps < 6, `sleeps=${r.sleeps}`);
});

test('sin bot.ready en READY_TIMEOUT falla', () => {
  const r = run({ READY_TIMEOUT: '4', READY_GRACE: '4' }, { ready: false });
  assert.equal(r.rc, '1');
});

test('READY_TIMEOUT y READY_GRACE no numéricos vuelven al valor por defecto con aviso', () => {
  const r = spawnSync('bash', ['-c', `
    export DEPLOY_APPLY_LIB=1 REPO=/tmp
    source '${SCRIPT}'
    echo "t=$READY_TIMEOUT g=$READY_GRACE"`], {
    env: { ...process.env, READY_TIMEOUT: 'abc', READY_GRACE: '-3' }, encoding: 'utf8',
  });
  assert.match(r.stdout, /t=180 g=45/);
  assert.match(r.stderr, /READY_TIMEOUT='abc'/);
  assert.match(r.stderr, /READY_GRACE='-3'/);
});

test('valores numéricos se respetan', () => {
  const r = spawnSync('bash', ['-c', `
    export DEPLOY_APPLY_LIB=1 REPO=/tmp
    source '${SCRIPT}'
    echo "t=$READY_TIMEOUT g=$READY_GRACE"`], {
    env: { ...process.env, READY_TIMEOUT: '300', READY_GRACE: '20' }, encoding: 'utf8',
  });
  assert.match(r.stdout, /t=300 g=20/);
});

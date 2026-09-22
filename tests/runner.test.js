import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildArgs, startTurn, statusFromEvent } from '../src/runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
const run = (mode, extra = {}) => startTurn({
  bin: FAKE, cwd: process.cwd(), args: [], prompt: 'hola', timeoutMs: 2000,
  env: { FAKE_MODE: mode }, onEvent: () => {}, ...extra,
});

test('buildArgs: primer turno usa --session-id, luego --resume', () => {
  const common = { sessionId: 'u', mode: 'plan', systemPrompt: 'sp', settings: { a: 1 }, mcpConfig: { mcpServers: {} } };
  const first = buildArgs({ ...common, resume: false });
  assert.deepEqual(first.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'u']);
  assert.ok(first.includes('--permission-prompt-tool'));
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(first[first.indexOf('--settings') + 1], '{"a":1}');
  const next = buildArgs({ ...common, resume: true });
  assert.equal(next[next.indexOf('--resume') + 1], 'u');
  assert.ok(!next.includes('--session-id'));
});

test('turno correcto devuelve texto, sesión y tokens de contexto', async () => {
  const events = [];
  const r = await run('ok', { onEvent: (e) => events.push(e.type) }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, 'eco: hola');
  assert.equal(r.sessionSeen, true);
  assert.equal(r.contextTokens, 1015);
  assert.deepEqual(events, ['system', 'assistant', 'result']);
});

test('error del resultado se marca isError', async () => {
  const r = await run('error').promise;
  assert.equal(r.ok, false);
  assert.equal(r.isError, true);
  assert.match(r.text, /limit/);
});

test('crash sin resultado', async () => {
  const r = await run('crash').promise;
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /boom/);
  assert.equal(r.sessionSeen, false);
});

test('timeout mata el proceso', async () => {
  const r = await run('hang', { timeoutMs: 300 }).promise;
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('kill cancela el turno', async () => {
  const t = run('hang', { timeoutMs: 5000 });
  setTimeout(() => t.kill(), 200);
  const r = await t.promise;
  assert.equal(r.killed, true);
});

test('statusFromEvent describe herramientas', () => {
  const e = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/functions.php' } }] } };
  assert.equal(statusFromEvent(e), 'Read functions.php');
  assert.equal(statusFromEvent({ type: 'system' }), null);
});

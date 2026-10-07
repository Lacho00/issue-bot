import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings } from '../src/policy.js';

const SCRIPT = fileURLToPath(new URL('../src/policy-hook.js', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'hook-'));
const sitePath = path.join(root, 'tienda-demo');
const jobDir = path.join(root, 'audits', 'qa-2026-09-21');
const botDir = path.join(root, 'bot-sandbox');
for (const d of [sitePath, jobDir, botDir]) mkdirSync(d, { recursive: true });
symlinkSync(botDir, path.join(sitePath, 'enlace'));

const ctxArg = (phase) => Buffer.from(JSON.stringify({ phase, sitePath, jobDir, botDir })).toString('base64');
const run = (event, arg = ctxArg('implement')) => spawnSync(process.execPath, [SCRIPT, arg], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: sitePath, ...event }), encoding: 'utf8',
});
const decision = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'fallthrough');

test('hook script: deny con el formato de hookSpecificOutput', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git checkout .' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /prohibido/i);
});

test('hook script: ask para Bash fuera de la lista; sin salida para lo permitido', () => {
  assert.equal(decision(run({ tool_name: 'Bash', tool_input: { command: 'node -e "1"' } })), 'ask');
  const ok = run({ tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});

test('hook script: resuelve enlaces simbólicos hacia el directorio del bot', () => {
  assert.equal(decision(run({ tool_name: 'Write', tool_input: { file_path: path.join(sitePath, 'enlace', 'x.js') } })), 'deny');
  assert.equal(decision(run({ tool_name: 'Write', tool_input: { file_path: 'enlace/x.js' } })), 'deny');
  assert.equal(decision(run({ tool_name: 'Write', tool_input: { file_path: path.join(sitePath, 'nuevo', 'a.css') } })), 'fallthrough');
});

test('hook script: falla cerrado si el contexto o la entrada no valen', () => {
  const bad = run({ tool_name: 'Bash', tool_input: { command: 'git status' } }, 'no-es-base64-json');
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const r = spawnSync(process.execPath, [SCRIPT, ctxArg('plan')], { input: '{roto', encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('hook script: el comando de buildSettings se ejecuta tal cual por la shell', () => {
  const s = buildSettings({ phase: 'plan', sitePath, jobDir, botEnvPath: path.join(botDir, '.env'), botDir });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: sitePath, tool_name: 'Edit', tool_input: { file_path: path.join(sitePath, 'a.css') } }),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('hook script: allow para órdenes compuestas de la lista fuera del sandbox', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'git log | head -5' } });
  assert.equal(r.status, 0);
  assert.equal(decision(r), 'allow');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings, decidePermission, describeRequest } from '../src/policy.js';

test('settings permiten editar solo en el sitio y en la carpeta del trabajo', () => {
  const s = buildSettings({ sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21' });
  assert.ok(s.permissions.allow.includes('Edit(//srv/http/tienda-demo/**)'));
  assert.ok(s.permissions.allow.includes('Write(//home/lacho/audits/tienda-demo/results/qa-2026-09-21/**)'));
  assert.ok(!s.permissions.allow.some((r) => r.startsWith('Edit(//srv/http/**')));
  assert.ok(s.permissions.allow.includes('Bash(npm run build)'));
  assert.ok(s.permissions.deny.includes('Bash(git commit:*)'));
  assert.ok(s.permissions.deny.includes('Bash(git push:*)'));
  assert.ok(s.permissions.deny.includes('Bash(npx playwright install:*)'));
});

test('segunda capa deniega commit, push e instalación de Playwright', () => {
  for (const command of ['git commit -m x', 'cd a && git push', 'npx playwright install chromium', 'npm i -D playwright', 'npm install @playwright/test']) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
  assert.equal(decidePermission('mcp__playwright__browser_install', {}).action, 'deny');
});

test('ExitPlanMode y AskUserQuestion se deniegan con instrucción', () => {
  const a = decidePermission('ExitPlanMode', { plan: 'x' });
  assert.equal(a.action, 'deny');
  assert.match(a.message, /Telegram/);
  assert.equal(decidePermission('AskUserQuestion', {}).action, 'deny');
});

test('lo demás se pregunta', () => {
  assert.deepEqual(decidePermission('Bash', { command: 'wp option update blogname x' }), { action: 'ask' });
  assert.deepEqual(decidePermission('Edit', { file_path: '/etc/hosts' }), { action: 'ask' });
});

test('describeRequest resume comando o ruta', () => {
  assert.equal(describeRequest('Bash', { command: 'npm install' }), 'Bash: npm install');
  assert.equal(describeRequest('Edit', { file_path: '/etc/hosts' }), 'Edit: /etc/hosts');
  assert.ok(describeRequest('Otro', { a: 'x'.repeat(2000) }).length <= 700);
});

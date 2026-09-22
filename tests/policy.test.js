import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings, decidePermission, describeRequest } from '../src/policy.js';

test('settings permiten editar solo en el sitio y en la carpeta del trabajo', () => {
  const s = buildSettings({ phase: 'implement', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(s.permissions.allow.includes('Edit(//srv/http/tienda-demo/**)'));
  assert.ok(s.permissions.allow.includes('Write(//home/lacho/audits/tienda-demo/results/qa-2026-09-21/**)'));
  assert.ok(!s.permissions.allow.some((r) => r.startsWith('Edit(//srv/http/**')));
  assert.ok(s.permissions.allow.includes('Bash(npm run build)'));
  assert.ok(s.permissions.deny.includes('Bash(git commit:*)'));
  assert.ok(s.permissions.deny.includes('Bash(git push:*)'));
  assert.ok(s.permissions.deny.includes('Bash(npx playwright install:*)'));
});

test('plan: sin Edit/Write/MultiEdit ni npm run build', () => {
  const s = buildSettings({ phase: 'plan', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(!s.permissions.allow.some((r) => /^(Edit|Write|MultiEdit)\(/.test(r)));
  assert.ok(!s.permissions.allow.includes('Bash(npm run build)'));
  assert.ok(!s.permissions.allow.includes('Bash(npm run build:*)'));
});

test('implement: sí incluye Edit/Write/MultiEdit y npm run build', () => {
  const s = buildSettings({ phase: 'implement', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(s.permissions.allow.includes('Edit(//srv/http/tienda-demo/**)'));
  assert.ok(s.permissions.allow.includes('MultiEdit(//srv/http/tienda-demo/**)'));
  assert.ok(s.permissions.allow.includes('Bash(npm run build)'));
  assert.ok(s.permissions.allow.includes('Bash(npm run build:*)'));
});

test('playwright: solo herramientas explícitas, sin run_code_unsafe ni file_upload', () => {
  const s = buildSettings({ phase: 'implement', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(!s.permissions.allow.includes('mcp__playwright'));
  assert.ok(s.permissions.allow.includes('mcp__playwright__browser_navigate'));
  assert.ok(s.permissions.allow.includes('mcp__playwright__browser_snapshot'));
  assert.ok(!s.permissions.allow.some((r) => r === 'mcp__playwright__browser_run_code_unsafe'));
  assert.ok(!s.permissions.allow.some((r) => r === 'mcp__playwright__browser_file_upload'));
  assert.ok(s.permissions.deny.includes('mcp__playwright__browser_run_code_unsafe'));
});

test('codebase-memory: solo herramientas de lectura, sin wildcard', () => {
  const s = buildSettings({ phase: 'implement', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(!s.permissions.allow.includes('mcp__codebase-memory-mcp'));
  assert.ok(s.permissions.allow.includes('mcp__codebase-memory-mcp__search_graph'));
  assert.ok(s.permissions.allow.includes('mcp__codebase-memory-mcp__trace_path'));
});

test('deniega leer el .env del propio bot', () => {
  const s = buildSettings({ phase: 'implement', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' });
  assert.ok(s.permissions.deny.includes('Read(//srv/http/issue-bot/.env)'));
});

test('segunda capa deniega commit, push e instalación de Playwright', () => {
  for (const command of ['git commit -m x', 'cd a && git push', 'npx playwright install chromium', 'npm i -D playwright', 'npm install @playwright/test', 'yarn add playwright', 'pnpm add -D @playwright/test', 'bun add playwright', 'GIT COMMIT -m x']) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
  assert.equal(decidePermission('mcp__playwright__browser_install', {}).action, 'deny');
  assert.equal(decidePermission('mcp__playwright__browser_run_code_unsafe', {}).action, 'deny');
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

const SETTINGS_ARGS = { sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' };

test('settings: deny de git y wp db destructivos en ambas fases, sin perder los de antes', () => {
  const rules = [
    'Bash(git add:*)', 'Bash(git reset --hard:*)', 'Bash(git checkout -- :*)', 'Bash(git clean:*)',
    'Bash(wp db drop:*)', 'Bash(wp db reset:*)', 'Bash(wp db import:*)',
    'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npx playwright install:*)', 'Bash(npm i playwright:*)',
    'Bash(npm install playwright:*)', 'mcp__playwright__browser_install', 'mcp__playwright__browser_run_code_unsafe',
    'Read(//srv/http/issue-bot/.env)',
  ];
  for (const phase of ['plan', 'implement']) {
    const s = buildSettings({ ...SETTINGS_ARGS, phase });
    for (const rule of rules) assert.ok(s.permissions.deny.includes(rule), `${phase}: ${rule}`);
  }
});

test('segunda capa deniega git add, reset --hard, checkout --, clean y wp db drop/reset/import', () => {
  for (const command of [
    'git add .', 'git add -A', 'cd x && git add style.css', 'git -C /srv/http/tienda-demo add style.css',
    'git reset --hard', 'git reset HEAD~1 --hard', 'git checkout -- style.css', 'git checkout HEAD -- style.css',
    'git clean -fd', 'wp db drop --yes', 'wp db reset --yes', 'wp db import copia.sql',
    'wp --path=/srv/http/tienda-demo db import copia.sql',
  ]) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
});

test('variantes no destructivas se siguen preguntando', () => {
  for (const command of [
    'git checkout -b arreglo', 'git checkout --theirs style.css', 'git reset HEAD style.css', 'git stash',
    'git log --grep add', 'wp db export copia.sql', 'wp db query "SELECT 1"',
  ]) {
    assert.deepEqual(decidePermission('Bash', { command }), { action: 'ask' }, command);
  }
});

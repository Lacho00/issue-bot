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
    'git checkout --theirs style.css', 'git checkout .', 'git restore style.css',
    'git clean -fd', 'wp db drop --yes', 'wp db reset --yes', 'wp db import copia.sql',
    'wp --path=/srv/http/tienda-demo db import copia.sql',
  ]) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
});

test('variantes no destructivas se siguen preguntando', () => {
  for (const command of [
    'git checkout -b arreglo', 'git switch main', 'git reset HEAD style.css', 'git stash',
    'git log --grep add', 'wp db export copia.sql', 'wp db query "SELECT 1"',
  ]) {
    assert.deepEqual(decidePermission('Bash', { command }), { action: 'ask' }, command);
  }
});

// --- Hook PreToolUse: la política del bot manda aunque el sitio permita el comando ------------

import { hookDecision, BASH_ALLOW } from '../src/policy.js';

const CTX = {
  sitePath: '/srv/http/tienda-demo',
  jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21',
  botDir: '/srv/http/bot-sandbox',
};
const imp = { ...CTX, phase: 'implement' };
const plan = { ...CTX, phase: 'plan' };
const bash = (command, ctx = imp) => hookDecision('Bash', { command }, ctx);
const decisionOf = (r) => r?.decision ?? 'fallthrough';

test('hook: deniega lo que ya deniega decidePermission', () => {
  for (const command of ['git commit -m x', 'git push', 'git add .', 'git clean -fd', 'wp db drop --yes', 'npx playwright install']) {
    assert.equal(decisionOf(bash(command)), 'deny', command);
  }
});

test('hook: deniega git checkout/restore/reset --hard en cualquier forma', () => {
  for (const command of [
    'git checkout .', 'git checkout HEAD -- style.css', 'git checkout main -- a.php', 'git checkout -- style.css',
    'git checkout HEAD style.css', 'git checkout --theirs style.css', 'git restore style.css', 'git restore --staged .',
    'git reset HEAD~1 --hard', 'git reset --hard', 'git -C /srv/http/tienda-demo checkout .',
    'git -c core.pager=cat reset --hard', 'git --git-dir=.git checkout -- a',
  ]) {
    assert.equal(decisionOf(bash(command)), 'deny', command);
  }
});

test('hook: deniega git diff --no-index y --output, y file:// en Bash', () => {
  for (const command of [
    'git diff --no-index /dev/null /srv/http/bot-sandbox/.env', 'git diff --output=/tmp/x', 'git diff --output /tmp/x',
    'git log -p --output=/tmp/x', 'chromium --headless --dump-dom file:///srv/http/bot-sandbox/.env',
    'chromium --headless --dump-dom FILE:///etc/passwd',
  ]) {
    assert.equal(decisionOf(bash(command)), 'deny', command);
  }
});

test('hook: deniega cualquier Bash que toque el directorio o el .env del bot', () => {
  for (const command of ['cat /srv/http/bot-sandbox/.env', 'git log -- /srv/http/bot-sandbox/src', 'head ../bot-sandbox/.env']) {
    assert.equal(decisionOf(bash(command)), 'deny', command);
  }
});

test('hook: node -e con git push dentro se deniega', () => {
  assert.equal(decisionOf(bash(`node -e "require('child_process').execSync('git push')"`)), 'deny');
});

test('hook: Bash fuera de la lista del bot se pregunta aunque el sitio lo permita', () => {
  for (const command of ['node -e "console.log(1)"', 'php -r "echo 1;"', 'npm run dev', 'git stash', 'git -C /srv/http/otro status', 'rm -rf node_modules', 'GIT_PAGER=cat git log']) {
    assert.equal(decisionOf(bash(command)), 'ask', command);
  }
});

test('hook: composición de shell se pregunta aunque cada parte esté permitida', () => {
  for (const command of ['git status; git log', 'git status && git log', 'git log || true', 'git log | head', 'git log `x`', 'git log $(x)', 'git log > f.txt', 'git log < f', 'git status\ngit log', 'git log &', 'git log $HOME']) {
    assert.equal(decisionOf(bash(command)), 'ask', JSON.stringify(command));
  }
});

test('hook: comandos de la lista del bot, sin composición, siguen el flujo normal', () => {
  for (const command of ['git status', 'git status --short', 'git diff', 'git diff HEAD -- style.css', 'git log --oneline -5', 'wp option get blogname', 'wp post list --post_type=page', 'npm run build', 'npm run build:css', 'chromium --headless --screenshot --window-size=1280,800 https://tienda-demo.example.com/']) {
    assert.equal(bash(command), null, command);
  }
});

test('hook: npm run build solo se permite en implementación', () => {
  assert.equal(decisionOf(bash('npm run build', plan)), 'ask');
  assert.equal(bash('git status', plan), null);
});

test('hook: prefijo exacto, no por subcadena', () => {
  assert.equal(decisionOf(bash('npm run buildx')), 'ask');
  assert.equal(decisionOf(bash('git statusx')), 'ask');
  assert.equal(decisionOf(bash('npm run build-and-deploy')), 'ask');
});

test('hook: wp con --exec, --require o --ssh se pregunta', () => {
  for (const command of ['wp option get blogname --exec="system(1);"', 'wp post list --require=/tmp/x.php', 'wp option get x --ssh=prod']) {
    assert.equal(decisionOf(bash(command)), 'ask', command);
  }
});

test('hook: chromium con banderas fuera de la lista o salida fuera del sitio se pregunta', () => {
  for (const command of [
    'chromium --headless --renderer-cmd-prefix=/bin/sh https://example.com/',
    'chromium --headless --screenshot=/tmp/x.png https://example.com/',
    'chromium --headless --print-to-pdf=/srv/http/otro/x.pdf https://example.com/',
    'chromium --headless --dump-dom ftp://example.com/',
  ]) {
    assert.equal(decisionOf(bash(command)), 'ask', command);
  }
  assert.equal(bash('chromium --headless --screenshot=/home/lacho/audits/tienda-demo/results/qa-2026-09-21/img/a.png https://example.com/'), null);
});

test('hook: Edit/Write deniega .claude, .git y el directorio del bot', () => {
  for (const [tool, file_path] of [
    ['Edit', '/srv/http/tienda-demo/.claude/settings.json'], ['Write', '/srv/http/tienda-demo/.claude/settings.local.json'],
    ['MultiEdit', '/srv/http/tienda-demo/.git/config'], ['Write', '/srv/http/tienda-demo/.git/hooks/pre-commit'],
    ['Write', '/srv/http/tienda-demo/wp-content/themes/t/.git/config'], ['Write', '/home/lacho/.claude/settings.json'],
    ['Edit', '/srv/http/bot-sandbox/src/policy.js'], ['Write', '/srv/http/bot-sandbox/.env'],
    ['Edit', '.claude/settings.json'], ['Write', '/srv/http/tienda-demo/sub/../.git/config'],
  ]) {
    assert.equal(decisionOf(hookDecision(tool, { file_path }, imp)), 'deny', `${tool} ${file_path}`);
  }
  assert.equal(decisionOf(hookDecision('NotebookEdit', { notebook_path: '/srv/http/tienda-demo/.git/x.ipynb' }, imp)), 'deny');
});

test('hook: package.json y composer.json siempre se preguntan', () => {
  for (const file_path of ['/srv/http/tienda-demo/package.json', '/srv/http/tienda-demo/wp-content/themes/t/composer.json']) {
    assert.equal(decisionOf(hookDecision('Edit', { file_path }, imp)), 'ask', file_path);
  }
});

test('hook: en plan toda edición se pregunta', () => {
  assert.equal(decisionOf(hookDecision('Edit', { file_path: '/srv/http/tienda-demo/style.css' }, plan)), 'ask');
  assert.equal(decisionOf(hookDecision('Write', { file_path: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21/informe.md' }, plan)), 'ask');
});

test('hook: en implementación, dentro del sitio o del trabajo sigue el flujo; fuera se pregunta', () => {
  assert.equal(hookDecision('Edit', { file_path: '/srv/http/tienda-demo/wp-content/themes/t/style.css' }, imp), null);
  assert.equal(hookDecision('Edit', { file_path: 'wp-content/themes/t/style.css' }, imp), null);
  assert.equal(hookDecision('Write', { file_path: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21/informe.md' }, imp), null);
  for (const file_path of ['/srv/http/tienda-demo-2/style.css', '/etc/hosts', '/srv/http/tienda-demo/../otro/a.php', '']) {
    assert.equal(decisionOf(hookDecision('Write', { file_path }, imp)), 'ask', file_path);
  }
});

test('hook: otras herramientas siguen el flujo normal', () => {
  assert.equal(hookDecision('Read', { file_path: '/srv/http/tienda-demo/a.php' }, imp), null);
  assert.equal(decisionOf(hookDecision('mcp__playwright__browser_run_code_unsafe', {}, imp)), 'deny');
});

test('settings: hook PreToolUse con la política y deny estáticos de .claude, .git, bot y git diff --no-index', () => {
  for (const phase of ['plan', 'implement']) {
    const s = buildSettings({ ...SETTINGS_ARGS, phase, botDir: '/srv/http/bot-sandbox', nodeBin: '/usr/bin/node' });
    const pre = s.hooks.PreToolUse;
    assert.equal(pre.length, 1);
    for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(pre[0].matcher.split('|').includes(tool), tool);
    const cmd = pre[0].hooks[0].command;
    assert.equal(pre[0].hooks[0].type, 'command');
    assert.match(cmd, /^'\/usr\/bin\/node' '.*\/src\/policy-hook\.js' [A-Za-z0-9+/=]+$/);
    const ctx = JSON.parse(Buffer.from(cmd.split(' ').at(-1), 'base64').toString('utf8'));
    assert.deepEqual(ctx, { phase, sitePath: '/srv/http/tienda-demo', jobDir: SETTINGS_ARGS.jobDir, botDir: '/srv/http/bot-sandbox' });
    for (const rule of [
      'Edit(//srv/http/tienda-demo/.claude/**)', 'Write(//srv/http/tienda-demo/.claude/**)', 'MultiEdit(//srv/http/tienda-demo/.claude/**)',
      'Edit(//srv/http/tienda-demo/.git/**)', 'Write(//srv/http/tienda-demo/.git/**)', 'MultiEdit(//srv/http/tienda-demo/.git/**)',
      'Edit(//srv/http/bot-sandbox/**)', 'Write(//srv/http/bot-sandbox/**)', 'MultiEdit(//srv/http/bot-sandbox/**)',
      'Bash(git diff --no-index:*)',
    ]) assert.ok(s.permissions.deny.includes(rule), `${phase}: ${rule}`);
  }
});

test('settings: la lista Bash del bot sale de BASH_ALLOW', () => {
  const s = buildSettings({ ...SETTINGS_ARGS, phase: 'implement' });
  for (const rule of BASH_ALLOW('implement')) assert.ok(s.permissions.allow.includes(rule), rule);
  assert.ok(!BASH_ALLOW('plan').includes('Bash(npm run build)'));
});

test('siteDisablesHooks detecta disableAllHooks en los settings del sitio', async () => {
  const { siteDisablesHooks } = await import('../src/policy.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const site = mkdtempSync(join(tmpdir(), 'site-'));
  assert.equal(siteDisablesHooks(site, site), false);
  mkdirSync(join(site, '.claude'));
  writeFileSync(join(site, '.claude', 'settings.json'), '{"permissions":{}}');
  assert.equal(siteDisablesHooks(site, site), false);
  writeFileSync(join(site, '.claude', 'settings.local.json'), '{"disableAllHooks": true}');
  assert.equal(siteDisablesHooks(site, site), true);
  writeFileSync(join(site, '.claude', 'settings.local.json'), '{roto');
  assert.equal(siteDisablesHooks(site, site), false);
});

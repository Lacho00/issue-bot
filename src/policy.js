import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const abs = (p) => `/${p}`;

const PLAYWRIGHT_TOOLS = [
  'navigate', 'snapshot', 'take_screenshot', 'evaluate', 'resize', 'click',
  'wait_for', 'console_messages', 'network_requests', 'close', 'tabs', 'hover', 'press_key',
].map((t) => `mcp__playwright__browser_${t}`);

const CODEBASE_MEMORY_TOOLS = [
  'search_graph', 'trace_path', 'get_code_snippet', 'get_architecture', 'query_graph',
  'search_code', 'list_projects', 'index_status', 'detect_changes', 'get_graph_schema',
].map((t) => `mcp__codebase-memory-mcp__${t}`);

// Lista Bash del bot por fase. La usa buildSettings (allow) y el hook (lo que no está aquí se pregunta).
export function BASH_ALLOW(phase) {
  return [
    // Solo el comando exacto: sufijos (build:x) o banderas (--node-options) se preguntan.
    ...(phase === 'plan' ? [] : ['Bash(npm run build)']),
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(wp option get:*)',
    'Bash(wp option list:*)',
    'Bash(wp post list:*)',
    'Bash(wp post get:*)',
    'Bash(wp post meta get:*)',
    'Bash(wp post meta list:*)',
    'Bash(wp theme list:*)',
    'Bash(wp plugin list:*)',
    'Bash(chromium --headless:*)',
  ];
}

const HOOK_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const HOOK_SCRIPT = fileURLToPath(new URL('./policy-hook.js', import.meta.url));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function buildSettings({ phase, sitePath, jobDir, botEnvPath, botDir = path.dirname(botEnvPath), nodeBin = process.execPath }) {
  const dirs = [sitePath, jobDir];
  const editAllows = phase === 'plan'
    ? []
    : dirs.flatMap((d) => [`Edit(${abs(d)}/**)`, `Write(${abs(d)}/**)`, `MultiEdit(${abs(d)}/**)`]);
  const editDenies = [`${sitePath}/.claude`, `${sitePath}/.git`, botDir]
    .flatMap((d) => [`Edit(${abs(d)}/**)`, `Write(${abs(d)}/**)`, `MultiEdit(${abs(d)}/**)`]);
  // .mcp.json arranca servidores MCP en el siguiente --resume sin pasar por el hook.
  const mcpDenies = ['Edit', 'Write', 'MultiEdit'].map((t) => `${t}(${abs(sitePath)}/.mcp.json)`);
  // El hook corre antes que cualquier allow de los settings del sitio: ahí manda la política del bot.
  const ctx = Buffer.from(JSON.stringify({ phase, sitePath, jobDir, botDir })).toString('base64');
  return {
    hooks: {
      PreToolUse: [{
        matcher: HOOK_TOOLS.join('|'),
        hooks: [{ type: 'command', command: `${shq(nodeBin)} ${shq(HOOK_SCRIPT)} ${ctx}`, timeout: 30 }],
      }],
    },
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        ...editAllows,
        ...BASH_ALLOW(phase),
        ...PLAYWRIGHT_TOOLS,
        ...CODEBASE_MEMORY_TOOLS,
      ],
      deny: [
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(git add:*)',
        'Bash(git reset --hard:*)',
        'Bash(git checkout -- :*)',
        'Bash(git clean:*)',
        'Bash(git diff --no-index:*)',
        'Bash(wp db drop:*)',
        'Bash(wp db reset:*)',
        'Bash(wp db import:*)',
        'Bash(npx playwright install:*)',
        'Bash(npm i playwright:*)',
        'Bash(npm install playwright:*)',
        'mcp__playwright__browser_install',
        'mcp__playwright__browser_run_code_unsafe',
        `Read(${abs(botEnvPath)})`,
        ...editDenies,
        ...mcpDenies,
      ],
    },
  };
}

// Admite opciones globales delante del subcomando: git -C <ruta> add, git -c k=v reset, wp --path=<ruta> db drop.
const GIT = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+|--\S+\s+)*`;
const WP = String.raw`\bwp\s+(?:--\S+\s+)*`;

const FORBIDDEN = [
  new RegExp(String.raw`${GIT}(commit|push|add|clean|restore)\b`, 'i'),
  new RegExp(String.raw`${GIT}reset\b[^&|;]*\s--hard\b`, 'i'),
  // checkout restaura ficheros en casi todas sus formas (., <ref> -- f, <ref> f, --theirs f):
  // solo se deja crear rama. Para cambiar de rama, git switch (se pregunta).
  new RegExp(String.raw`${GIT}checkout\b(?!\s+(?:-b|-B|--orphan)\s+(?!\.(?:\s|$))[^\s&|;]+\s*(?:$|[&|;]))`, 'i'),
  new RegExp(String.raw`${GIT}switch\b[^&|;]*\s(?:-f|--force|--discard-changes)\b`, 'i'),
  new RegExp(String.raw`${GIT}diff\b[^&|;]*\s--no-index\b`, 'i'),
  new RegExp(String.raw`${GIT}\w+\b[^&|;]*\s--output\b`, 'i'),
  new RegExp(String.raw`${WP}db\s+(drop|reset|import)\b`, 'i'),
  /\bplaywright\s+install\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^&|;]*playwright/i,
  /\bfile:\/\//i,
];

const DENIED_TOOLS = new Set(['mcp__playwright__browser_install', 'mcp__playwright__browser_run_code_unsafe']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function touchesBot(command, botDir) {
  if (!botDir) return false;
  if (command.includes(botDir)) return true;
  return new RegExp(String.raw`(?:^|[\s'"=/])${escapeRe(path.basename(botDir))}/`).test(command);
}

const FORBIDDEN_MESSAGE = 'Comando prohibido en este bot: sin git commit, push, add, restore, checkout (salvo -b), reset --hard, clean, diff --no-index ni --output; sin file://; sin tocar el directorio del bot; sin wp db drop, reset ni import; sin instalar Playwright.';

export function decidePermission(toolName, input = {}, { botDir } = {}) {
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') {
    return { action: 'deny', message: 'El dueño responde por Telegram. Termina tu respuesta con el plan o la pregunta en texto.' };
  }
  if (DENIED_TOOLS.has(toolName)) {
    return { action: 'deny', message: 'Prohibido: sin instalar navegadores ni ejecutar código sin sandbox.' };
  }
  if (toolName === 'Bash') {
    const command = input.command ?? '';
    if (FORBIDDEN.some((re) => re.test(command)) || touchesBot(command, botDir)) return { action: 'deny', message: FORBIDDEN_MESSAGE };
  }
  return { action: 'ask' };
}

// --- Hook PreToolUse ------------------------------------------------------------------------
// Devuelve { decision: 'deny' | 'ask', reason } o null (sigue el flujo normal de permisos).

const COMPOSITION = /[;&|`<>\n\r$]/;
const WP_RISKY = /\s--(?:exec|require|ssh|http)\b/i;
const CHROMIUM_FLAGS = new Set([
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--screenshot', '--print-to-pdf', '--dump-dom', '--window-size', '--virtual-time-budget', '--timeout',
  '--force-device-scale-factor', '--run-all-compositor-stages-before-draw', '--default-background-color',
  '--no-pdf-header-footer', '--user-agent', '--lang',
]);
const CHROMIUM_OUTPUTS = new Set(['--screenshot', '--print-to-pdf']);

const inside = (p, dir) => !!dir && (p === dir || p.startsWith(`${dir.replace(/\/+$/, '')}/`));

function tokenize(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function inBotList(command, phase) {
  return BASH_ALLOW(phase).some((rule) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(rule);
    if (!m) return false;
    if (!m[2]) return command === m[1];
    return command === m[1] || (command.startsWith(m[1]) && /[\s:]/.test(command[m[1].length]));
  });
}

function chromiumOk(command, ctx) {
  const [, ...args] = tokenize(command);
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flag = eq < 0 ? a : a.slice(0, eq);
      if (!CHROMIUM_FLAGS.has(flag)) return false;
      if (CHROMIUM_OUTPUTS.has(flag) && eq >= 0) {
        const out = path.resolve(ctx.cwd ?? ctx.sitePath, a.slice(eq + 1));
        if (!inside(out, ctx.sitePath) && !inside(out, ctx.jobDir)) return false;
      }
    } else if (!/^https?:\/\//i.test(a)) {
      return false;
    }
  }
  return true;
}

function bashDecision(command, ctx) {
  const denied = decidePermission('Bash', { command }, ctx);
  if (denied.action === 'deny') return { decision: 'deny', reason: denied.message };
  const cmd = command.trim();
  const ask = (why) => ({ decision: 'ask', reason: `Pide permiso al dueño: ${why}.` });
  if (COMPOSITION.test(cmd)) return ask('el comando compone varias órdenes, redirige o expande variables');
  if (!inBotList(cmd, ctx.phase)) return ask('el comando no está en la lista del bot');
  if (/^wp\s/.test(cmd) && WP_RISKY.test(cmd)) return ask('wp con --exec, --require, --ssh o --http');
  if (/^chromium\s/.test(cmd) && !chromiumOk(cmd, ctx)) return ask('chromium con banderas o destinos fuera de lo permitido');
  return null;
}

function editDecision(filePath, ctx) {
  if (!filePath) return { decision: 'ask', reason: 'Pide permiso al dueño: edición sin ruta.' };
  const p = path.resolve(ctx.cwd ?? ctx.sitePath, filePath);
  const segments = p.split('/');
  const base = path.basename(p);
  if (segments.includes('.claude') || segments.includes('.git') || base === '.mcp.json' || inside(p, ctx.botDir)) {
    return { decision: 'deny', reason: 'Prohibido editar .claude, .git, .mcp.json o el directorio del bot.' };
  }
  if (['package.json', 'composer.json'].includes(base)) {
    return { decision: 'ask', reason: 'Pide permiso al dueño: cambia los scripts o dependencias del proyecto.' };
  }
  // Ficheros que ejecutan código en npm run build o en los comandos wp permitidos.
  if (base === '.npmrc' || /\.config\.(?:js|cjs|mjs|ts)$/.test(base) || /^wp-cli.*\.yml$/.test(base)) {
    return { decision: 'ask', reason: 'Pide permiso al dueño: configuración que ejecutan los comandos permitidos.' };
  }
  if (ctx.phase === 'plan') return { decision: 'ask', reason: 'Pide permiso al dueño: en la fase de plan no se edita.' };
  if (inside(p, ctx.sitePath) || inside(p, ctx.jobDir)) return null;
  return { decision: 'ask', reason: 'Pide permiso al dueño: edición fuera del sitio y de la carpeta del trabajo.' };
}

export function hookDecision(toolName, input = {}, ctx = {}) {
  if (toolName === 'Bash') return bashDecision(input.command ?? '', ctx);
  if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) return editDecision(input.file_path, ctx);
  if (toolName === 'NotebookEdit') return editDecision(input.notebook_path, ctx);
  const d = decidePermission(toolName, input, ctx);
  return d.action === 'deny' ? { decision: 'deny', reason: d.message } : null;
}

// Un settings del sitio o del usuario con disableAllHooks apagaría el hook: el turno no arranca.
export function siteDisablesHooks(sitePath, homeDir = os.homedir()) {
  const files = [
    path.join(sitePath, '.claude', 'settings.json'),
    path.join(sitePath, '.claude', 'settings.local.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ];
  return files.some((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'))?.disableAllHooks === true;
    } catch {
      return false;
    }
  });
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') return `Bash: ${input.command ?? ''}`.slice(0, 700);
  if (input.file_path) return `${toolName}: ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input)}`.slice(0, 700);
}

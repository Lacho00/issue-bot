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
    ...BROWSERS.map((b) => `Bash(${b} --headless:*)`),
  ];
}

// Nombres del binario de Chromium según la distribución (CHROMIUM_BIN elige cuál usa Claude). Todos
// pasan por las mismas reglas: solo --headless, banderas de la lista y URLs http(s).
export const BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const BROWSER_SEGMENT = new RegExp(`^(?:${BROWSERS.join('|')})\\s`);

// Bash corre en el sandbox de Claude Code (bwrap): escribe solo en el sitio y la carpeta del trabajo,
// sin red, y se aprueba solo. wp necesita el socket de MySQL y chromium el loopback del sitio local:
// van fuera del sandbox y los gobiernan la lista del bot y el hook.
export const UNSANDBOXED = ['wp', ...BROWSERS];

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
  const ctx = Buffer.from(JSON.stringify({ phase, sitePath, jobDir, botDir, sandbox: true })).toString('base64');
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
    sandbox: {
      enabled: true,
      // Sin bwrap el turno falla en vez de ejecutar Bash sin aislar y aprobado solo.
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: UNSANDBOXED.map((c) => `${c}:*`),
      filesystem: {
        allowWrite: phase === 'plan' ? [] : dirs,
        denyWrite: [
          ...(phase === 'plan' ? [sitePath] : []),
          `${sitePath}/.git`, `${sitePath}/.claude`, `${sitePath}/.mcp.json`, botDir,
        ],
        denyRead: [botEnvPath],
      },
      network: { allowedDomains: [] },
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

// Parte un comando en órdenes por ; && || | y saltos de línea. Devuelve null si sustituye, expande
// variables, abre subshell o redirige (salvo a /dev/null y 2>&1): eso no se puede leer por partes.
export function splitCommand(command) {
  const text = command.replace(/(^|\s)(?:[12]?>\s*\/dev\/null|2>&1)(?=\s|$|[;&|])/g, '$1');
  const segments = [];
  let cur = '';
  let quote = null;
  const push = () => { if (cur.trim()) segments.push(cur.trim()); cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      cur += ch;
    } else if (quote === '"') {
      // \" \\ \$ \` escapan dentro de comillas dobles: el corte por comillas dejaría de ser fiable.
      if (ch === '$' || ch === '`' || (ch === '\\' && '"\\$`'.includes(text[i + 1]))) return null;
      if (ch === '"') quote = null;
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if ('$`\\()<>{}#'.includes(ch)) {
      return null;
    } else if (ch === '&') {
      if (text[i + 1] !== '&') return null;
      i++;
      push();
    } else if (ch === '|') {
      if (text[i + 1] === '|') i++;
      push();
    } else if (ch === ';' || ch === '\n' || ch === '\r') {
      push();
    } else {
      cur += ch;
    }
  }
  if (quote) return null;
  push();
  return segments;
}

// Filtros que solo leen la entrada estándar: se aprueban encadenados tras wp o chromium, que corren
// fuera del sandbox. Sin rutas ni banderas que lean ficheros o ejecuten programas: leer ficheros
// fuera del sandbox se salta su denyRead, y cd cambiaría la carpeta en la que se comprueban las rutas.
function stdinFilterOk(segment) {
  const [cmd, ...args] = tokenize(segment);
  const operands = args.filter((a) => !a.startsWith('-'));
  if (cmd === 'head' || cmd === 'tail') return args.every((a) => /^-(?:n|c)?\d*$/.test(a) || /^\d+$/.test(a)) && operands.every((a) => /^\d+$/.test(a));
  if (cmd === 'wc') return args.every((a) => /^-[lwcm]+$/.test(a));
  if (cmd === 'grep') return args.filter((a) => a.startsWith('-')).every((a) => /^-[EFinvcowx]+$/.test(a)) && operands.length === 1;
  return false;
}

const UNSANDBOXED_RE = new RegExp(String.raw`(?:^|[\s;&|(\`])(?:${UNSANDBOXED.join('|')})(?=\s|$)`, 'm');

function bashDecision(command, ctx) {
  const denied = decidePermission('Bash', { command }, ctx);
  if (denied.action === 'deny') return { decision: 'deny', reason: denied.message };
  const cmd = command.trim();
  const ask = (why) => ({ decision: 'ask', reason: `Pide permiso al dueño: ${why}.` });
  // Lo que corre en el sandbox no puede salir del sitio ni de la carpeta del trabajo: lo aprueba el sandbox.
  if (ctx.sandbox && !UNSANDBOXED_RE.test(cmd)) return null;
  const segments = splitCommand(cmd);
  if (!segments?.length) return ask('el comando sustituye, expande variables, abre subshell o redirige');
  if (segments.length > 1 && !inBotList(segments[0], ctx.phase)) return ask('compuesto que no empieza por una orden de la lista del bot');
  let viaReadOnly = false;
  for (const seg of segments) {
    if (inBotList(seg, ctx.phase)) {
      if (/^wp\s/.test(seg) && WP_RISKY.test(seg)) return ask('wp con --exec, --require, --ssh o --http');
      if (BROWSER_SEGMENT.test(seg) && !chromiumOk(seg, ctx)) return ask('chromium con banderas o destinos fuera de lo permitido');
    } else if (stdinFilterOk(seg)) {
      viaReadOnly = true;
    } else {
      return ask(`«${tokenize(seg)[0]}» no está en la lista del bot`);
    }
  }
  // Un comando suelto de la lista ya lo aprueban los allow de los settings; lo compuesto o de solo
  // lectura no tiene regla que lo cubra, así que lo aprueba el hook.
  if (segments.length === 1 && !viaReadOnly) return null;
  return { decision: 'allow', reason: 'Órdenes de solo lectura o de la lista del bot.' };
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

// El sandbox lo define solo el bot: cualquier clave sandbox en los settings del sitio, del usuario o
// gestionados (sockets, red, rutas, exclusiones…) podría abrir lo que el hook da por aislado.
export function siteWeakensSandbox(sitePath, homeDir = os.homedir(), managedPath = '/etc/claude-code/managed-settings.json') {
  const files = [
    path.join(sitePath, '.claude', 'settings.json'),
    path.join(sitePath, '.claude', 'settings.local.json'),
    path.join(homeDir, '.claude', 'settings.json'),
    managedPath,
  ];
  return files.some((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'))?.sandbox !== undefined;
    } catch {
      return false;
    }
  });
}

// Clave del botón «Permitir en este trabajo». Bash: el comando base, con su subcomando en git y npm y
// con los dos siguientes en wp (wp post list). Ediciones: la carpeta. null, sin botón, para órdenes
// compuestas o ilegibles, para chromium y para wp que ejecuta PHP o SQL: esas se aprueban una a una.
const WP_NO_GRANT = new Set(['eval', 'eval-file', 'shell', 'db', 'package', 'cli', 'config']);

export function grantKeys(toolName, input = {}) {
  if (toolName === 'Bash') {
    const segments = splitCommand((input.command ?? '').trim());
    if (segments?.length !== 1) return null;
    const words = tokenize(segments[0]);
    const base = words[0];
    if (!base || base.includes('=') || base.includes('/') || BROWSERS.includes(base)) return null;
    const sub = words.slice(1).filter((w) => !w.startsWith('-'));
    if (base === 'wp') {
      if (WP_RISKY.test(segments[0]) || !sub[0] || WP_NO_GRANT.has(sub[0])) return null;
      return [`Bash:wp ${sub.slice(0, 2).join(' ')}`];
    }
    if (['git', 'npm'].includes(base)) return sub[0] ? [`Bash:${base} ${sub[0]}`] : null;
    return [`Bash:${base}`];
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const p = input.file_path ?? input.notebook_path;
    return p ? [`edit:${path.dirname(path.resolve(p))}`] : null;
  }
  return [toolName];
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') return `Bash: ${input.command ?? ''}`.slice(0, 700);
  if (input.file_path) return `${toolName}: ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input)}`.slice(0, 700);
}

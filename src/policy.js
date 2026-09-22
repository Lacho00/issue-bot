const abs = (p) => `/${p}`;

const PLAYWRIGHT_TOOLS = [
  'navigate', 'snapshot', 'take_screenshot', 'evaluate', 'resize', 'click',
  'wait_for', 'console_messages', 'network_requests', 'close', 'tabs', 'hover', 'press_key',
].map((t) => `mcp__playwright__browser_${t}`);

const CODEBASE_MEMORY_TOOLS = [
  'search_graph', 'trace_path', 'get_code_snippet', 'get_architecture', 'query_graph',
  'search_code', 'list_projects', 'index_status', 'detect_changes', 'get_graph_schema',
].map((t) => `mcp__codebase-memory-mcp__${t}`);

export function buildSettings({ phase, sitePath, jobDir, botEnvPath }) {
  const dirs = [sitePath, jobDir];
  const editAllows = phase === 'plan'
    ? []
    : dirs.flatMap((d) => [`Edit(${abs(d)}/**)`, `Write(${abs(d)}/**)`, `MultiEdit(${abs(d)}/**)`]);
  const buildAllows = phase === 'plan' ? [] : ['Bash(npm run build)', 'Bash(npm run build:*)'];
  return {
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        ...editAllows,
        ...buildAllows,
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
        'Bash(wp db drop:*)',
        'Bash(wp db reset:*)',
        'Bash(wp db import:*)',
        'Bash(npx playwright install:*)',
        'Bash(npm i playwright:*)',
        'Bash(npm install playwright:*)',
        'mcp__playwright__browser_install',
        'mcp__playwright__browser_run_code_unsafe',
        `Read(${abs(botEnvPath)})`,
      ],
    },
  };
}

// Admite opciones globales delante del subcomando: git -C <ruta> add, wp --path=<ruta> db drop.
const GIT = String.raw`\bgit\s+(?:-C\s+\S+\s+)*`;
const WP = String.raw`\bwp\s+(?:--\S+\s+)*`;

const FORBIDDEN = [
  new RegExp(String.raw`${GIT}(commit|push|add|clean)\b`, 'i'),
  new RegExp(String.raw`${GIT}reset\b[^&|;]*\s--hard\b`, 'i'),
  new RegExp(String.raw`${GIT}checkout\b[^&|;]*\s--(\s|$)`, 'i'),
  new RegExp(String.raw`${WP}db\s+(drop|reset|import)\b`, 'i'),
  /\bplaywright\s+install\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^&|;]*playwright/i,
];

const DENIED_TOOLS = new Set(['mcp__playwright__browser_install', 'mcp__playwright__browser_run_code_unsafe']);

export function decidePermission(toolName, input = {}) {
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') {
    return { action: 'deny', message: 'El dueño responde por Telegram. Termina tu respuesta con el plan o la pregunta en texto.' };
  }
  if (DENIED_TOOLS.has(toolName)) {
    return { action: 'deny', message: 'Prohibido: sin instalar navegadores ni ejecutar código sin sandbox.' };
  }
  if (toolName === 'Bash' && FORBIDDEN.some((re) => re.test(input.command ?? ''))) {
    return { action: 'deny', message: 'Comando prohibido en este bot: sin git commit, push, add, reset --hard, checkout -- ni clean; sin wp db drop, reset ni import; sin instalar Playwright.' };
  }
  return { action: 'ask' };
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') return `Bash: ${input.command ?? ''}`.slice(0, 700);
  if (input.file_path) return `${toolName}: ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input)}`.slice(0, 700);
}

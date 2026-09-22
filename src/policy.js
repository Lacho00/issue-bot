const abs = (p) => `/${p}`;

export function buildSettings({ sitePath, jobDir }) {
  const dirs = [sitePath, jobDir];
  return {
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        ...dirs.flatMap((d) => [`Edit(${abs(d)}/**)`, `Write(${abs(d)}/**)`, `MultiEdit(${abs(d)}/**)`]),
        'Bash(npm run build)',
        'Bash(npm run build:*)',
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
        'mcp__playwright',
        'mcp__codebase-memory-mcp',
      ],
      deny: [
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(npx playwright install:*)',
        'Bash(npm i playwright:*)',
        'Bash(npm install playwright:*)',
        'mcp__playwright__browser_install',
      ],
    },
  };
}

const FORBIDDEN = [
  /\bgit\s+(commit|push)\b/i,
  /\bplaywright\s+install\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^&|;]*playwright/i,
];

export function decidePermission(toolName, input = {}) {
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') {
    return { action: 'deny', message: 'El dueño responde por Telegram. Termina tu respuesta con el plan o la pregunta en texto.' };
  }
  if (toolName === 'mcp__playwright__browser_install') {
    return { action: 'deny', message: 'Prohibido instalar navegadores. Usa el chromium existente.' };
  }
  if (toolName === 'Bash' && FORBIDDEN.some((re) => re.test(input.command ?? ''))) {
    return { action: 'deny', message: 'Comando prohibido en este bot: sin commit, sin push, sin instalar Playwright.' };
  }
  return { action: 'ask' };
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') return `Bash: ${input.command ?? ''}`.slice(0, 700);
  if (input.file_path) return `${toolName}: ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input)}`.slice(0, 700);
}

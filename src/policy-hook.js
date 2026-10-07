#!/usr/bin/env node
// Hook PreToolUse de los turnos del bot. Claude Code lo ejecuta antes de cada Bash/Edit/Write/
// MultiEdit/NotebookEdit, también cuando un settings del sitio ya lo permite. Entrada: JSON del
// hook por stdin; contexto del trabajo (fase, sitio, carpeta, bot) en base64 como argumento.
// Salida: hookSpecificOutput.permissionDecision deny | ask | allow, o nada para seguir el flujo normal.
// Ante cualquier fallo deniega (exit 2): un hook roto no puede abrir la puerta.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hookDecision } from './policy.js';

const RANK = { deny: 3, ask: 2, allow: 1 };

// Resuelve enlaces simbólicos en el ancestro existente más largo de la ruta.
function realPath(p) {
  let cur = p;
  const rest = [];
  while (cur !== path.dirname(cur)) {
    try {
      return path.join(realpathSync(cur), ...rest);
    } catch {
      rest.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  return p;
}

function decide(event, ctx) {
  const tool = event.tool_name;
  const input = event.tool_input ?? {};
  const full = { ...ctx, cwd: event.cwd || ctx.sitePath };
  const decisions = [hookDecision(tool, input, full)];
  const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  if (typeof input[key] === 'string' && input[key]) {
    const real = realPath(path.resolve(full.cwd, input[key]));
    decisions.push(hookDecision(tool, { ...input, [key]: real }, full));
  }
  return decisions.reduce((a, b) => ((RANK[b?.decision] ?? 0) > (RANK[a?.decision] ?? 0) ? b : a), null);
}

const out = (decision, reason) => process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
})}\n`);

try {
  const ctx = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
  if (!ctx.sitePath || !ctx.phase) throw new Error('contexto incompleto');
  const event = JSON.parse(readFileSync(0, 'utf8'));
  const d = decide(event, ctx);
  if (d) out(d.decision, d.reason);
  process.exit(0);
} catch (e) {
  const reason = `Hook del bot sin decisión (${e.message}): denegado.`;
  out('deny', reason);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

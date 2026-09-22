import { spawn } from 'node:child_process';
import path from 'node:path';

export function buildArgs({ sessionId, resume, mode, systemPrompt, settings, mcpConfig }) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    resume ? '--resume' : '--session-id', sessionId,
    '--setting-sources', 'user',
    '--permission-mode', mode,
    '--append-system-prompt', systemPrompt,
    '--settings', JSON.stringify(settings),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--permission-prompt-tool', 'mcp__bot__aprobar',
  ];
}

export function statusFromEvent(event) {
  if (event?.type !== 'assistant') return null;
  const tool = event.message?.content?.find((c) => c.type === 'tool_use');
  if (!tool) return null;
  const i = tool.input ?? {};
  const detail = i.file_path ? path.basename(i.file_path) : (i.command ?? i.pattern ?? '').slice(0, 60);
  return `${tool.name} ${detail}`.trim();
}

export function startTurn({ bin, cwd, args, prompt, timeoutMs, env = {}, onEvent = () => {} }) {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let killed = false;
  let timedOut = false;
  let result = null;
  let sessionSeen = false;
  let lastAssistantUsage = null;
  let stderr = '';
  let buf = '';
  let settled = false;

  let timer = null;
  let killTimer = null;

  const setKillTimer = () => {
    killTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, 5000);
  };

  const startTimeout = () => {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setKillTimer();
    }, timeoutMs);
  };

  startTimeout();

  const settle = (exitCode) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    const u = lastAssistantUsage ?? result?.usage ?? {};
    return {
      ok: !!result && !result.is_error && !timedOut && !killed,
      text: result?.result ?? '',
      isError: !!result?.is_error,
      timedOut,
      killed,
      sessionSeen,
      contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      exitCode,
      stderr: stderr.slice(-2000),
    };
  };

  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'system' && event.subtype === 'init') sessionSeen = true;
      if (event.type === 'assistant' && event.message?.usage) lastAssistantUsage = event.message.usage;
      if (event.type === 'result') result = event;
      onEvent(event);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    }
  });

  child.stdin.end(prompt);

  const promise = new Promise((resolve) => {
    child.on('close', (exitCode) => {
      resolve(settle(exitCode));
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      }
      resolve({
        ok: false,
        isError: true,
        text: '',
        timedOut,
        killed,
        sessionSeen,
        contextTokens: 0,
        exitCode: null,
        stderr: String(err.message),
      });
    });
  });

  return {
    promise,
    kill: () => {
      killed = true;
      child.kill('SIGTERM');
      setKillTimer();
    },
  };
}

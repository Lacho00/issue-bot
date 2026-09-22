#!/usr/bin/env node
const mode = process.env.FAKE_MODE || 'ok';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (mode === 'crash') { process.stderr.write('boom\n'); process.exit(2); }
  emit({ type: 'system', subtype: 'init', session_id: 'abc' });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/functions.php' } }] } });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'error') {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', usage: {} });
    return;
  }
  emit({
    type: 'result', subtype: 'success', is_error: false, result: `eco: ${input}`,
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 50 },
  });
});

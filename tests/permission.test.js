import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startBridge, requestPermission } from '../src/permission-bridge.js';

const sock = () => path.join(mkdtempSync(path.join(tmpdir(), 'sock-')), 'b.sock');
const MCP = fileURLToPath(new URL('../src/mcp-permission.js', import.meta.url));

test('puente: la respuesta del handler vuelve al cliente', async () => {
  const s = sock();
  const server = await startBridge(s, async (req) => (req.tool_name === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' }));
  assert.deepEqual(await requestPermission(s, { tool_name: 'Bash', input: {} }), { behavior: 'allow' });
  assert.deepEqual(await requestPermission(s, { tool_name: 'Edit', input: {} }), { behavior: 'deny', message: 'no' });
  server.close();
});

test('puente: un handler que lanza error deniega', async () => {
  const s = sock();
  const server = await startBridge(s, async () => { throw new Error('fallo'); });
  const r = await requestPermission(s, { tool_name: 'Bash', input: {} });
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /fallo/);
  server.close();
});

async function callMcp(socketPath, args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, BOT_SOCKET: socketPath } }));
  const tools = await client.listTools();
  const res = await client.callTool({ name: 'aprobar', arguments: args });
  await client.close();
  return { tools: tools.tools.map((t) => t.name), payload: JSON.parse(res.content[0].text) };
}

test('MCP: allow devuelve updatedInput', async () => {
  const s = sock();
  const server = await startBridge(s, async () => ({ behavior: 'allow' }));
  const { tools, payload } = await callMcp(s, { tool_name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(tools, ['aprobar']);
  assert.deepEqual(payload, { behavior: 'allow', updatedInput: { command: 'ls' } });
  server.close();
});

test('MCP: sin bot escuchando deniega', async () => {
  const { payload } = await callMcp(sock(), { tool_name: 'Bash', input: { command: 'ls' } });
  assert.equal(payload.behavior, 'deny');
});

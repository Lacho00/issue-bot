#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { requestPermission } from './permission-bridge.js';

const server = new McpServer({ name: 'bot', version: '0.1.0' });

server.registerTool(
  'aprobar',
  {
    description: 'Pide permiso al dueño por Telegram para usar una herramienta.',
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      tool_use_id: z.string().optional(),
    },
  },
  async ({ tool_name, input }) => {
    let res;
    try {
      res = await requestPermission(process.env.BOT_SOCKET, { tool_name, input });
    } catch (e) {
      res = { behavior: 'deny', message: `Sin respuesta del bot: ${e.message}` };
    }
    const payload = res.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: res.message || 'Denegado por el dueño.' };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  },
);

await server.connect(new StdioServerTransport());

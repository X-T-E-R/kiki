import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'caller-elicitation-fixture', version: '1.0.0' });
server.registerTool('elicit', { inputSchema: { message: z.string() } }, async ({ message }, extra) => {
  const result = await server.server.elicitInput({ message, requestedSchema: { type: 'object', properties: {} } }, { relatedRequestId: extra.requestId });
  const data = { caller: extra._meta, result, capabilities: server.server.getClientCapabilities() };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());

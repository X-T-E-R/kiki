import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// A valid MCP server that only exposes prompts — no tools capability at all.
const server = new McpServer({ name: 'mock-no-tools', version: '0.0.1' });

server.registerPrompt(
  'greet',
  {
    description: 'Greets by name',
    argsSchema: { name: z.string() },
  },
  ({ name }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name}` } }],
  }),
);

await server.connect(new StdioServerTransport());

import { createInterface } from 'node:readline';

const TOOLS = ['ControlStatus', 'DisplayInventory', 'Screenshot', 'Snapshot', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'Wait', 'WaitFor', 'App'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const input = createInterface({ input: process.stdin });

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'windows-mcp', version: '0.8.8' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    reply(request.id, {
      tools: TOOLS.map((name) => ({
        name,
        description: `${name} from Windows-MCP 0.8.8`,
        inputSchema: { type: 'object', properties: name === 'Screenshot' ? { use_annotation: { type: 'boolean' } } : {} },
      })),
    });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'Screenshot') {
    reply(request.id, {
      content: [
        { type: 'text', text: 'display=0 scale=1' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    });
    return;
  }
  if (request.method === 'tools/call') {
    reply(request.id, { content: [{ type: 'text', text: 'once' }] });
    return;
  }
  if (request.method === 'ping') reply(request.id, {});
});
input.on('close', () => process.exit(0));

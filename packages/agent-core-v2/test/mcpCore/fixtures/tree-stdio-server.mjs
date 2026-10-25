import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const leaf = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setTimeout(()=>{},15000);'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
await new Promise((resolve) => leaf.stdout.once('data', resolve));
const lines = createInterface({ input: process.stdin });
const keepAlive = setTimeout(() => process.exit(0), 15000);
lines.on('line', (line) => {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'owned-tree-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'lifecycle', inputSchema: { type: 'object' } }] };
  else if (request.method === 'tools/call') {
    result = { content: [], structuredContent: { root: process.pid, leaf: leaf.pid } };
    const action = request.params.arguments.action;
    if (action === 'exit') setTimeout(() => process.exit(0), 30);
  } else if (request.method === 'ping') result = {};
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
lines.on('close', () => { clearTimeout(keepAlive); process.exit(0); });

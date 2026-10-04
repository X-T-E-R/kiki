import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const pending = new Set();
let eof = false;
const keepAlive = process.env.KIKI_TEST_IGNORE_EOF === '1' ? setInterval(() => {}, 1000) : undefined;
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function exitIfDrained() {
  if (eof && pending.size === 0 && keepAlive === undefined) {
    process.stderr.write('drained\n');
    process.exit(0);
  }
}
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'computer-fixture', version: '1' } });
  } else if (request.method === 'tools/list') {
    if (process.env.KIKI_TEST_TOOL_PAGES === '1') {
      const start = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
      const end = Math.min(start + 64, 151);
      reply(request.id, { tools: Array.from({ length: end - start }, (_, index) => ({
        name: `tool_${start + index}`, description: `Tool ${start + index}`, inputSchema: { type: 'object', properties: {} },
      })), ...(end < 151 ? { nextCursor: String(end) } : {}) });
    } else {
      reply(request.id, { tools: [{ name: 'type_text', description: 'Fixture input', inputSchema: { type: 'object', properties: { delay: { type: 'number' } } } }] });
    }
  } else if (request.method === 'tools/call') {
    process.stderr.write('dispatched\n');
    const timer = setTimeout(() => {
      reply(request.id, { content: [{ type: 'text', text: 'sent' }], structuredContent: { effect: 'unknown', delivery: 'foreground', route: 'fixture', summary: 'sent' } });
      pending.delete(timer);
      exitIfDrained();
    }, request.params.arguments.delay ?? 100);
    pending.add(timer);
  } else if (request.method === 'ping') {
    reply(request.id, {});
  }
});
input.on('close', () => { eof = true; process.stderr.write('eof\n'); exitIfDrained(); });

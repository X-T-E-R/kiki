/**
 * Local OpenAI-compatible chat-completions stub for real-backend GUI checks.
 * Every request whose last message is not a tool result streams one
 * `SendMessage` call whose text names the persona it was sent as; after the
 * tool result it streams a short closing line. Nothing leaves the machine.
 *
 *   node scripts/stub-model-server.mjs --port 59412
 *   KIKI_MODEL_NAME=stub KIKI_MODEL_PROVIDER_TYPE=openai
 *   KIKI_MODEL_BASE_URL=http://127.0.0.1:59412/v1 KIKI_MODEL_API_KEY=stub
 */

import { createServer } from 'node:http';

const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice('--port='.length) ?? 59412);

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function speakerOf(messages) {
  const system = messages.find((message) => message.role === 'system');
  const text = typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '');
  return /你是([^，,。\s]{1,6})/u.exec(text)?.[1] ?? 'Bot';
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stub', object: 'model' }] }));
    return;
  }
  const chunks = [];
  for await (const part of req) chunks.push(part);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const hasSendMessage = (body.tools ?? []).some((tool) => tool.function?.name === 'SendMessage');
  console.log(`[stub] ${req.url} messages=${messages.length} last=${last?.role} tools=${(body.tools ?? []).length} send=${hasSendMessage}`);
  if (process.env.STUB_DUMP_TOOLS === '1') console.log(`[stub] tools: ${(body.tools ?? []).map((tool) => tool.function?.name).join(',')}`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = async (text, wait = 60) => { res.write(text); await new Promise((resolve) => setTimeout(resolve, wait)); };
  if (last?.role === 'tool' || !hasSendMessage) {
    await write(chunk({ role: 'assistant', content: '' }));
    await write(chunk({ content: '已发出。' }));
    await write(chunk({}, 'stop'));
  } else {
    const speaker = speakerOf(messages);
    const args = JSON.stringify({ text: `收到（${speaker}，来自本地 stub 模型）。` });
    await write(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: 'SendMessage', arguments: '' } }] }));
    for (let index = 0; index < args.length; index += 6) {
      await write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(index, index + 6) } }] }), 120);
    }
    await write(chunk({}, 'tool_calls'));
  }
  res.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});

server.listen(port, '127.0.0.1', () => { console.log(`[stub] listening on http://127.0.0.1:${port}/v1`); });

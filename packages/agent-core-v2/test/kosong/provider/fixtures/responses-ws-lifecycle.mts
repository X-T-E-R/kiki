import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { WebSocketServer, type WebSocket } from 'ws';
import { ResponsesWebSocketTransport } from '#/kosong/provider/bases/openai/responses-websocket';

const mode = process.argv[2];
const server = createServer();
const webSockets = new WebSocketServer({ server });
const capabilities = readFileSync(new URL('./responses-ws-capabilities.json', import.meta.url), 'utf8').trim();
webSockets.on('headers', headers => headers.push(`X-Responses-WebSocket-Capabilities: ${capabilities}`));
let peer: WebSocket | undefined;
let frames = 0;
let connections = 0;
const failure = { type: 'error', status: 502, error: { type: 'server_error', code: 'incomplete_stream',
  message: 'The response stream ended without a valid terminal event.', param: '' } };
webSockets.on('connection', socket => {
  connections++;
  peer = socket;
  socket.on('message', () => {
    frames++;
    if (frames === 1 && mode === 'active') {
      socket.send(JSON.stringify(failure));
      return;
    }
    if (frames === 1 && (mode === 'cancel' || mode === 'unconsumed')) {
      socket.send(JSON.stringify({ type: 'response.created', sequence_number: 0,
        response: { id: 'pending', status: 'in_progress', output: [] } }));
      return;
    }
    socket.send(JSON.stringify({ type: 'response.completed', sequence_number: 0,
      response: { id: `response_${frames}`, status: 'completed', output: [] } }));
    if (frames === 1 && mode === 'terminal') socket.send(JSON.stringify(failure));
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address !== null && typeof address !== 'string');
const client = new OpenAI({ apiKey: 'YOUR_API_KEY', baseURL: `http://127.0.0.1:${address.port}/v1` });
const transport = new ResponsesWebSocketTransport();
const controller = new AbortController();
const consume = async (signal?: AbortSignal): Promise<void> => {
  const stream = await transport.create(client, { model: 'fixture', input: [] }, { signal });
  for await (const _ of stream) {}
};
try {
  if (mode === 'active') {
    await assert.rejects(consume(), { code: 'incomplete_stream', status: 502,
      message: 'incomplete_stream: The response stream ended without a valid terminal event.' });
  } else if (mode === 'unconsumed') {
    const stream = await transport.create(client, { model: 'fixture', input: [] });
    peer!.send(JSON.stringify(failure));
    await delay(30);
    await assert.rejects(async () => { for await (const _ of stream) {} }, { code: 'incomplete_stream', status: 502 });
  } else if (mode === 'cancel') {
    const stream = await transport.create(client, { model: 'fixture', input: [] }, { signal: controller.signal });
    peer!.send(JSON.stringify(failure));
    controller.abort();
    await assert.rejects(async () => { for await (const _ of stream) {} }, { name: 'AbortError' });
  } else {
    await consume();
    if (mode !== 'terminal') peer!.send(JSON.stringify(mode === 'invalid' ? { type: 'raw' } : failure));
    if (mode === 'retire') await transport.retire();
    if (mode === 'dispose') transport.dispose();
  }
  await delay(30);
  if (mode !== 'retire' && mode !== 'dispose') {
    await consume();
    assert.equal(frames, 2);
    assert.equal(connections, 2);
  }
  console.log(JSON.stringify({ survived: true, mode, frames, connections,
    originalFailure: mode === 'active' ? failure.error.code : mode === 'cancel' ? 'AbortError' : undefined }));
} finally {
  transport.dispose();
  for (const socket of webSockets.clients) socket.terminate();
  await new Promise<void>(resolve => webSockets.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
}

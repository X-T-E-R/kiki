import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';

import OpenAI from 'openai';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIResponsesChatProvider, OpenAIResponsesStreamedMessage } from '#/kosong/provider/bases/openai/openai-responses';
import { generate } from '#/kosong/contract/generate';
import { toErrorPayload } from '#/_base/errors/serialize';
import { ConfigRegistry } from '#/app/config/configService';
import {
  ProvidersSectionSchema,
  RESPONSES_WEB_SOCKET_SECTION,
  providersFromToml,
  providersToToml,
  requestIdentityFromToml,
  requestIdentityToToml,
} from '#/app/kosongConfig/configSection';
import {
  ResponsesWebSocketSystemSchema,
  responsesWebSocketFromWire,
  responsesWebSocketToWire,
  resolveResponsesWebSocket,
} from '#/kosong/provider/requestCompression';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import {
  ResponsesWebSocketError,
  ResponsesWebSocketTransport,
  type ResponsesWebSocketCanonical,
} from '#/kosong/provider/bases/openai/responses-websocket';

const capabilities = readFileSync(
  new URL('./fixtures/responses-ws-capabilities.json', import.meta.url),
  'utf8',
).trim();
const capabilitiesV2File = readFileSync(
  new URL('./fixtures/capabilities-v2.default.json', import.meta.url),
  'utf8',
);
const capabilitiesV2Object = JSON.parse(capabilitiesV2File) as RawObject;
const capabilitiesV2 = JSON.stringify(capabilitiesV2Object);
const connectionRetiringFile = readFileSync(
  new URL('./fixtures/connection-retiring.json', import.meta.url),
  'utf8',
);
const connectionRetiringObject = JSON.parse(connectionRetiringFile) as RawObject;

type RawObject = Record<string, unknown>;
type Frame = { connection: number; body: RawObject; wire: string };
type Connection = { index: number; headers: Record<string, string | string[] | undefined> };
type MessageHandler = (body: RawObject, socket: WebSocket, connection: number) => void;

type Gateway = {
  readonly baseUrl: string;
  readonly frames: Frame[];
  readonly connections: Connection[];
  readonly closedConnections: number[];
  readonly httpRequests: RawObject[];
  close(): Promise<void>;
};

const gateways: Gateway[] = [];

async function createGateway(
  onMessage: MessageHandler,
  capabilityHeader: string | null | (() => string) = capabilities,
): Promise<Gateway> {
  const httpRequests: RawObject[] = [];
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => {
      httpRequests.push(JSON.parse(Buffer.concat(chunks).toString()) as RawObject);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_http', status: 'completed', output: responseOutput('HTTP fallback') } })}\n\n`);
    });
  });
  const server = new WebSocketServer({ server: http });
  http.listen(0, '127.0.0.1');
  const frames: Frame[] = [];
  const connections: Connection[] = [];
  const closedConnections: number[] = [];
  const sockets = new Set<WebSocket>();

  server.on('headers', (headers) => {
    if (capabilityHeader !== null) {
      headers.push(`X-Responses-WebSocket-Capabilities: ${typeof capabilityHeader === 'function' ? capabilityHeader() : capabilityHeader}`);
    }
  });

  server.on('connection', (socket, request) => {
    const connection = connections.length;
    connections.push({ index: connection, headers: request.headers });
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      closedConnections.push(connection);
    });
    socket.on('message', (data) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      const wire = bytes.toString('utf8');
      const body = JSON.parse(wire) as RawObject;
      frames.push({ connection, body, wire });
      onMessage(body, socket, connection);
    });
  });

  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const gateway: Gateway = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    frames,
    connections,
    closedConnections,
    httpRequests,
    async close(): Promise<void> {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      http.closeAllConnections();
      await new Promise<void>((resolve) => { http.close(() => resolve()); });
    },
  };
  gateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  while (gateways.length > 0) {
    await gateways.pop()!.close();
  }
});

function client(baseUrl: string, apiKey = 'YOUR_API_KEY'): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 });
}

function responseOutput(text: string, extra: readonly RawObject[] = []): RawObject[] {
  return [
    {
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      type: 'message',
      content: [{ annotations: [], text, type: 'output_text' }],
    },
    ...extra,
  ];
}

function sendCreated(socket: WebSocket, id: string): void {
  socket.send(JSON.stringify({
    response: { id, output: [], status: 'in_progress' },
    sequence_number: 0,
    type: 'response.created',
  }));
}

function sendCompleted(socket: WebSocket, id: string, text: string, extra: readonly RawObject[] = []): void {
  const output = responseOutput(text, extra);
  sendCreated(socket, id);
  socket.send(JSON.stringify({
    content_index: 0,
    delta: text,
    item_id: 'msg_1',
    logprobs: [],
    output_index: 0,
    sequence_number: 1,
    type: 'response.output_text.delta',
  }));
  socket.send(JSON.stringify({
    response: {
      id,
      output,
      status: 'completed',
      usage: {
        input_tokens: 4,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        total_tokens: 6,
      },
    },
    sequence_number: 2,
    type: 'response.completed',
  }));
}

function sendStateMiss(socket: WebSocket): void {
  socket.send(JSON.stringify({
    error: {
      code: 'previous_response_not_found',
      message: 'The connection no longer has the requested response state.',
      param: 'previous_response_id',
      type: 'invalid_request_error',
    },
    execution: 'not_executed',
    status: 409,
    type: 'error',
  }));
}

function sendUnsupportedUpstream(socket: WebSocket): void {
  socket.send(JSON.stringify({
    error: {
      code: 'unsupported_upstream_format',
      message: 'The upstream response format is not native Responses.',
      param: null,
      type: 'server_error',
    },
    execution: 'not_executed',
    status: 502,
    type: 'error',
  }));
}

const TERMINAL_WRITE_MARGIN_SECONDS = 15;

function v2Capabilities(overrides: RawObject = {}): string {
  return JSON.stringify({ ...capabilitiesV2Object, ...overrides });
}

function retiringFrame(mutate?: (frame: RawObject) => void): string {
  const frame = JSON.parse(connectionRetiringFile) as RawObject;
  mutate?.(frame);
  return JSON.stringify(frame);
}

function defaultLaneRetiring(): string {
  return retiringFrame((frame) => {
    delete frame['stream_id'];
  });
}

async function* asAsyncIterable(values: readonly unknown[]): AsyncGenerator<unknown> {
  yield* values;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function object(value: unknown): RawObject {
  expect(value).toBeTypeOf('object');
  return value as RawObject;
}

function canonical(input: readonly unknown[], key = 'lineage'): ResponsesWebSocketCanonical {
  return { input, key };
}

describe('ResponsesWebSocketTransport', () => {
  it('waits for capabilities, sends only response.create, and preserves native unknown output items', async () => {
    const signedInput = {
      content: [{ signature: 'opaque-input-signature', text: 'hello', type: 'input_text' }],
      role: 'user',
      type: 'message',
    };
    const signedTool = {
      description: 'A signed tool',
      name: 'signed_tool',
      parameters: { additionalProperties: false, type: 'object' },
      strict: true,
      type: 'function',
      x_signature: 'opaque-tool-signature',
    };
    const unknownOutput = {
      signature: 'opaque-output-signature',
      type: 'future_output_item',
      value: { preserved: true },
    };
    const gateway = await createGateway((body, socket) => {
      if (body['type'] === 'response.create') sendCompleted(socket, 'resp_1', 'done', [unknownOutput]);
    });
    const transport = new ResponsesWebSocketTransport();
    const requestInput = [signedInput];
    const stream = await transport.create(
      client(gateway.baseUrl),
      {
        input: requestInput,
        model: 'gpt-test',
        parallel_tool_calls: true,
        stream: true,
        tools: [signedTool],
      },
      { canonical: canonical(requestInput), headers: { 'x-test-auth': 'frozen-a' } },
    );
    const events = await collect(stream);

    expect(transport.capabilities?.max_frame_bytes).toBe(8388608);
    expect(gateway.connections).toHaveLength(1);
    expect(gateway.frames).toHaveLength(1);
    expect(gateway.frames[0]?.body).toEqual({
      input: requestInput,
      model: 'gpt-test',
      parallel_tool_calls: true,
      tools: [signedTool],
      type: 'response.create',
    });
    expect(events.map((value) => object(value)['type'])).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.completed',
    ]);
    const completed = object(events[2]);
    const completedOutput = object(completed['response'])['output'] as unknown[];
    expect(object(completedOutput[1])['signature']).toBe('opaque-output-signature');

    const streamed = new OpenAIResponsesStreamedMessage(asAsyncIterable(events), true);
    const parts: unknown[] = [];
    for await (const part of streamed) parts.push(part);
    expect(parts).toEqual([{ type: 'text', text: 'done' }]);
    expect(streamed.id).toBe('resp_1');
    transport.close();
  });

  it('uses an exact input plus output prefix and performs one proven full rebase on a not-executed state miss', async () => {
    const firstInput = [{ content: [{ text: 'first', type: 'input_text' }], role: 'user', type: 'message' }];
    const firstOutput = responseOutput('first');
    const secondUser = { content: [{ text: 'second', type: 'input_text' }], role: 'user', type: 'message' };
    const secondInput = [...firstInput, ...firstOutput, secondUser];
    const secondOutput = responseOutput('second');
    const noAssistantInput = [...secondInput, { content: [{ text: 'third', type: 'input_text' }], role: 'user', type: 'message' }];
    const malformedAssistantInput = [
      ...secondInput,
      { ...secondOutput[0], content: [{ annotations: [], text: 'mutated', type: 'output_text' }] },
      ...secondOutput.slice(1),
      { content: [{ text: 'fourth', type: 'input_text' }], role: 'user', type: 'message' },
    ];
    const gateway = await createGateway((body, socket) => {
      if (gateway.frames.length === 1) sendCompleted(socket, 'resp_1', 'first');
      else if (gateway.frames.length === 2) sendStateMiss(socket);
      else if (gateway.frames.length === 3) sendCompleted(socket, 'resp_2', 'second');
      else if (gateway.frames.length === 4) sendCompleted(socket, 'resp_3', 'third');
      else sendCompleted(socket, 'resp_4', 'fourth');
    });
    const transport = new ResponsesWebSocketTransport();
    const openai = client(gateway.baseUrl);

    const firstStream = await transport.create(
      openai,
      { input: firstInput, instructions: 'system', model: 'gpt-test', stream: true },
      { canonical: canonical(firstInput) },
    );
    await collect(firstStream);

    const secondStream = await transport.create(
      openai,
      { input: secondInput, instructions: 'system', model: 'gpt-test', stream: true },
      { canonical: canonical(secondInput) },
    );
    const secondEvents = await collect(secondStream);

    const thirdStream = await transport.create(
      openai,
      { input: noAssistantInput, instructions: 'system', model: 'gpt-test', stream: true },
      { canonical: canonical(noAssistantInput) },
    );
    await collect(thirdStream);

    const fourthStream = await transport.create(
      openai,
      { input: malformedAssistantInput, instructions: 'system', model: 'gpt-test', stream: true },
      { canonical: canonical(malformedAssistantInput) },
    );
    await collect(fourthStream);

    expect(gateway.frames).toHaveLength(5);
    expect(gateway.frames[1]?.body).toMatchObject({
      input: [secondUser],
      previous_response_id: 'resp_1',
      type: 'response.create',
    });
    expect(gateway.frames[2]?.body).toMatchObject({ input: secondInput, type: 'response.create' });
    expect(gateway.frames[2]?.body).not.toHaveProperty('previous_response_id');
    expect(gateway.frames[3]?.body).toMatchObject({ input: noAssistantInput, type: 'response.create' });
    expect(gateway.frames[3]?.body).not.toHaveProperty('previous_response_id');
    expect(gateway.frames[4]?.body).toMatchObject({ input: malformedAssistantInput, type: 'response.create' });
    expect(gateway.frames[4]?.body).not.toHaveProperty('previous_response_id');
    expect(secondEvents.map((value) => object(value)['type'])).toContain('response.completed');
    transport.close();
  });

  it('rebuilds the socket and full-rebases when frozen headers or lineage change', async () => {
    const input = [{ content: [{ text: 'same', type: 'input_text' }], role: 'user', type: 'message' }];
    const gateway = await createGateway((_body, socket, connection) => {
      sendCompleted(socket, `resp_${connection + 1}`, 'ok');
    });
    const transport = new ResponsesWebSocketTransport();
    const openai = client(gateway.baseUrl);

    const firstStream = await transport.create(
      openai,
      { input, model: 'gpt-test', stream: true, tools: [{ name: 'a', type: 'function' }] },
      { canonical: canonical(input, 'model-a'), headers: { 'x-auth-version': 'a' } },
    );
    await collect(firstStream);

    const secondStream = await transport.create(
      openai,
      { input, model: 'gpt-other', stream: true, tools: [{ name: 'b', type: 'function' }] },
      { canonical: canonical(input, 'model-a'), headers: { 'x-auth-version': 'b' } },
    );
    await collect(secondStream);

    expect(gateway.connections).toHaveLength(2);
    expect(gateway.frames).toHaveLength(2);
    expect(gateway.frames[1]?.body).not.toHaveProperty('previous_response_id');
    expect(gateway.connections[0]?.headers['x-auth-version']).toBe('a');
    expect(gateway.connections[1]?.headers['x-auth-version']).toBe('b');
    transport.close();
  });

  it('closes on cancellation without sending response.cancel and never replays an ambiguous close', async () => {
    const controller = new AbortController();
    const gateway = await createGateway((body, socket) => {
      expect(body['type']).toBe('response.create');
      sendCreated(socket, 'resp_pending');
    });
    const transport = new ResponsesWebSocketTransport();
    const stream = await transport.create(
      client(gateway.baseUrl),
      { input: [{ role: 'user', type: 'message' }], model: 'gpt-test', stream: true },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(collect(stream)).rejects.toMatchObject({ name: 'AbortError' });
    expect(gateway.frames).toHaveLength(1);
    expect(gateway.frames.some(({ body }) => body['type'] === 'response.cancel')).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(gateway.closedConnections.length).toBeGreaterThan(0);
    transport.close();

    const ambiguousGateway = await createGateway((_body, socket) => {
      socket.close(1011, 'partial execution');
    });
    const ambiguousTransport = new ResponsesWebSocketTransport();
    await expect(
      ambiguousTransport.create(
        client(ambiguousGateway.baseUrl),
        { input: [{ role: 'user', type: 'message' }], model: 'gpt-test', stream: true },
      ),
    ).rejects.toMatchObject({ code: 'responses_websocket_closed_before_terminal' });
    expect(ambiguousGateway.frames).toHaveLength(1);
    ambiguousTransport.close();
  });

  it('invalidates baseline on close and ignores a late terminal event', async () => {
    const firstInput = [{ content: [{ text: 'first', type: 'input_text' }], role: 'user', type: 'message' }];
    const output = responseOutput('first');
    const secondInput = [...firstInput, ...output, { content: [{ text: 'second', type: 'input_text' }], role: 'user', type: 'message' }];
    let pendingSocket: WebSocket | undefined;
    const gateway = await createGateway((_body, socket) => {
      if (gateway.frames.length === 1) sendCompleted(socket, 'resp_1', 'first');
      else if (gateway.frames.length === 2) {
        pendingSocket = socket;
        sendCreated(socket, 'resp_pending');
      } else sendCompleted(socket, 'resp_3', 'third');
    });
    const transport = new ResponsesWebSocketTransport();
    const openai = client(gateway.baseUrl);

    const firstStream = await transport.create(openai, { input: firstInput, model: 'gpt-test', stream: true }, { canonical: canonical(firstInput) });
    await collect(firstStream);
    const pendingStream = await transport.create(openai, { input: secondInput, model: 'gpt-test', stream: true }, { canonical: canonical(secondInput) });
    transport.close();
    try {
      pendingSocket?.send(JSON.stringify({
        response: { id: 'late', output: responseOutput('late'), status: 'completed' },
        sequence_number: 1,
        type: 'response.completed',
      }));
    } catch {
      pendingSocket = undefined;
    }
    await expect(collect(pendingStream)).rejects.toMatchObject({ code: 'responses_websocket_closed_before_terminal' });

    const thirdStream = await transport.create(openai, { input: secondInput, model: 'gpt-test', stream: true }, { canonical: canonical(secondInput) });
    await collect(thirdStream);
    expect(gateway.frames[2]?.body).not.toHaveProperty('previous_response_id');
    transport.close();
  });

  it('signals safe HTTP fallback for missing capabilities and unsupported upstream format before replay', async () => {
    const missingGateway = await createGateway(() => undefined, null);
    const missingTransport = new ResponsesWebSocketTransport();
    await expect(
      missingTransport.create(client(missingGateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      }),
    ).rejects.toMatchObject({ code: 'responses_ws_capabilities_unsupported', safeHttpFallback: true });
    expect(missingGateway.frames).toHaveLength(0);
    expect(missingTransport.diagnostics()).toEqual({
      transport: 'ws', webSocketCapabilities: false, webSocketCapabilityVersion: null, webSocketConnectionAgeMs: expect.any(Number),
    });
    missingTransport.close();

    const unsupportedGateway = await createGateway((_body, socket) => sendUnsupportedUpstream(socket));
    const unsupportedTransport = new ResponsesWebSocketTransport();
    await expect(
      unsupportedTransport.create(client(unsupportedGateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_upstream_format',
      safeHttpFallback: true,
    });
    expect(unsupportedGateway.frames).toHaveLength(1);
    unsupportedTransport.close();
  });

  it('supports the request helper and makes dispose permanent', async () => {
    const gateway = await createGateway((_body, socket) => sendCompleted(socket, 'resp_request', 'request'));
    const transport = new ResponsesWebSocketTransport();
    const stream = await transport.request(
      { input: [{ role: 'user', type: 'message' }], model: 'gpt-test', stream: true },
      {
        apiKey: 'YOUR_API_KEY',
        baseUrl: gateway.baseUrl,
        headers: { 'x-request-header': 'request' },
      },
    );
    const events = await collect(stream);
    expect(events.map((value) => object(value)['type'])).toContain('response.completed');
    expect(gateway.connections[0]?.headers['x-request-header']).toBe('request');

    transport.dispose();
    await expect(
      transport.request(
        { input: [{ role: 'user', type: 'message' }], model: 'gpt-test', stream: true },
        { apiKey: 'YOUR_API_KEY', baseUrl: gateway.baseUrl, headers: {} },
      ),
    ).rejects.toMatchObject({ code: 'responses_websocket_disposed' });
  });

  it('rejects a concurrent create rather than sharing a lane or lineage', async () => {
    const gateway = await createGateway((_body, socket) => sendCreated(socket, 'resp_pending'));
    const transport = new ResponsesWebSocketTransport();
    const openai = client(gateway.baseUrl);
    const first = await transport.create(openai, {
      input: [{ role: 'user', type: 'message' }],
      model: 'gpt-test',
      stream: true,
    });
    await expect(
      transport.create(openai, {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      }),
    ).rejects.toMatchObject({ code: 'responses_websocket_inflight' });
    transport.close();
    await expect(collect(first)).rejects.toMatchObject({ code: 'responses_websocket_closed_before_terminal' });
  });

  it('does not replay an ambiguous gateway error', async () => {
    const gateway = await createGateway((_body, socket) => {
      socket.send(JSON.stringify({
        error: {
          code: 'upstream_timeout',
          message: 'The upstream execution status is unknown.',
          param: null,
          type: 'server_error',
        },
        status: 504,
        type: 'error',
      }));
    });
    const transport = new ResponsesWebSocketTransport();
    await expect(
      transport.create(client(gateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      }),
    ).rejects.toMatchObject({ code: 'upstream_timeout', safeHttpFallback: false });
    expect(gateway.frames).toHaveLength(1);
    transport.close();
  });
});

function sendNativeOutput(socket: WebSocket, id: string, output: readonly RawObject[]): void {
  sendCreated(socket, id);
  for (const [index, item] of output.entries()) {
    if (item['type'] === 'reasoning') {
      for (const summary of item['summary'] as RawObject[]) {
        socket.send(JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: summary['text'], item_id: item['id'], output_index: index }));
      }
    }
    socket.send(JSON.stringify({ type: 'response.output_item.added', item, output_index: index }));
    socket.send(JSON.stringify({ type: 'response.output_item.done', item, output_index: index }));
  }
  socket.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output } }));
}

function productionProvider(baseUrl: string): OpenAIResponsesChatProvider {
  return new OpenAIResponsesChatProvider({
    model: 'synthetic', apiKey: 'YOUR_API_KEY', baseUrl,
    responsesWebSocket: { targets: [baseUrl] },
  });
}

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('production Responses adapter → generate → canonical history → official SDK', () => {
  it('sends text and parallel tool-result deltas while retaining native ids/status and opaque reasoning', async () => {
    const outputs = [
      responseOutput('first answer'),
      [
        { type: 'reasoning', id: 'rs_signed', status: 'completed', summary: [{ type: 'summary_text', text: 'consider' }], encrypted_content: 'opaque-signature-==' },
        { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'synthetic_echo', arguments: '{"integer":9007199254740993}' },
        { type: 'function_call', id: 'fc_2', status: 'completed', call_id: 'call_2', name: 'synthetic_echo', arguments: '{"parallel":true}' },
      ],
      responseOutput('final answer'),
    ];
    const expanded: unknown[][] = [];
    const gateway = await createGateway((body, socket) => {
      const input = body['input'] as unknown[];
      const index = expanded.length;
      const previous = index === 0 ? [] : [...expanded[index - 1]!, ...outputs[index - 1]!];
      expanded.push(body['previous_response_id'] === undefined ? input : [...previous, ...input]);
      sendNativeOutput(socket, `resp_${index}`, outputs[index]!);
    });
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history: Message[] = [user('first question')];
      const tools: Tool[] = [{ name: 'synthetic_echo', description: 'Synthetic echo', parameters: { type: 'object' } }];
      const first = await generate(provider, 'synthetic instructions', tools, history, undefined, { responsesTransport: transport });
      history.push(first.message, user('use both tools'));
      const second = await generate(provider, 'synthetic instructions', tools, history, undefined, { responsesTransport: transport });
      expect(second.message.toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
      expect(second.message.content).toContainEqual({ type: 'think', think: 'consider', encrypted: 'opaque-signature-==' });
      history.push(second.message,
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'opaque result 9007199254740993' }], toolCalls: [] },
        { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'parallel result' }], toolCalls: [] });
      await generate(provider, 'synthetic instructions', tools, history, undefined, { responsesTransport: transport });
      expect(gateway.frames[1]?.body['previous_response_id']).toBe('resp_0');
      expect(gateway.frames[1]?.body['input']).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use both tools' }] }]);
      expect(gateway.frames[2]?.body['previous_response_id']).toBe('resp_1');
      expect(gateway.frames[2]?.body['input']).toEqual([
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'opaque result 9007199254740993' }] },
        { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'parallel result' }] },
      ]);
      expect(expanded[2]).toEqual([...expanded[0]!, ...outputs[0]!, ...(gateway.frames[1]!.body['input'] as unknown[]), ...outputs[1]!, ...(gateway.frames[2]!.body['input'] as unknown[])]);
      expect(gateway.frames[2]!.body['instructions']).toBe('synthetic instructions');
    } finally { transport.dispose(); }
  });

  it.each([
    { type: 'future_output_item', signature: 'opaque-unknown', value: '9007199254740993' },
    { type: 'message', id: 'annotated', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'annotated', annotations: [{ type: 'future_annotation' }] }] },
  ])('uses full canonical history when native output is not representable: $type', async (unknownOutput) => {
    const gateway = await createGateway((_body, socket) => sendNativeOutput(socket, 'resp_unknown', [...responseOutput('answer'), unknownOutput]));
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect((gateway.frames[1]?.body['input'] as unknown[]).length).toBeGreaterThan(1);
    } finally { transport.dispose(); }
  });

  it.each(['ip_blocked', 'authentication_error', 'permission_denied'])('never bypasses a pre-inference access denial: %s', async (code) => {
    const gateway = await createGateway((_body, socket) => socket.send(JSON.stringify({
      type: 'error', status: code === 'authentication_error' ? 401 : 403,
      error: { type: 'permission_error', code, message: 'Synthetic access denied', param: '' }, execution: 'not_executed',
    })));
    const transport = new ResponsesWebSocketTransport();
    try {
      await expect(generate(productionProvider(gateway.baseUrl), '', [], [user('question')], undefined, { responsesTransport: transport })).rejects.toMatchObject({ statusCode: code === 'authentication_error' ? 401 : 403, message: expect.stringContaining('Synthetic access denied') });
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it('does not replay after partial output even if a later error claims not_executed', async () => {
    const gateway = await createGateway((_body, socket) => {
      sendCreated(socket, 'resp_partial');
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial', item_id: 'm', content_index: 0, output_index: 0 }));
      sendUnsupportedUpstream(socket);
    });
    const transport = new ResponsesWebSocketTransport();
    let observed = '';
    try {
      await expect(generate(productionProvider(gateway.baseUrl), '', [], [user('question')], {
        onMessagePart: (part) => { if (part.type === 'text') observed += part.text; },
      }, { responsesTransport: transport })).rejects.toThrow();
      expect(observed).toBe('partial');
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });
});

describe('production Responses safe HTTP recovery', () => {
  it.each(['unsupported_upstream_format', 'unsupported_prompt_policy'])('falls back once with full input only on a trusted pre-inference %s', async (code) => {
    const gateway = await createGateway((_body, socket) => socket.send(JSON.stringify({ type: 'error', status: 400,
      error: { type: 'invalid_request_error', code, message: 'Synthetic unsupported', param: '' }, execution: 'not_executed' })));
    const transport = new ResponsesWebSocketTransport();
    try {
      const result = await generate(productionProvider(gateway.baseUrl), 'fresh instructions', [], [user('full question')], undefined, { responsesTransport: transport });
      expect(result.message.content).toEqual([{ type: 'text', text: 'HTTP fallback' }]);
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(1);
      expect(gateway.httpRequests[0]?.['input']).toEqual(gateway.frames[0]?.body['input']);
      expect(gateway.httpRequests[0]?.['previous_response_id']).toBeUndefined();
    } finally { transport.dispose(); }
  });

  it('ignores a provider nested execution claim and never falls back', async () => {
    const gateway = await createGateway((_body, socket) => socket.send(JSON.stringify({ type: 'error', status: 400,
      error: { type: 'invalid_request_error', code: 'unsupported_upstream_format', message: 'Provider claim', execution: 'not_executed' } })));
    const transport = new ResponsesWebSocketTransport();
    try {
      await expect(generate(productionProvider(gateway.baseUrl), '', [], [user('question')], undefined, { responsesTransport: transport })).rejects.toThrow();
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });
});

describe('production Responses lineage commitment', () => {
  it('rebases a marked state miss with native ids/status and known signatures intact', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', status: 'completed', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'opaque-ciphertext-==' },
      { type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'synthetic_echo', arguments: '{"n":9007199254740993}' },
    ];
    let requestCount = 0;
    const gateway = await createGateway((body, socket) => {
      requestCount += 1;
      if (requestCount === 1) sendNativeOutput(socket, 'resp_tool', output);
      else if (body['previous_response_id'] !== undefined) sendStateMiss(socket);
      else sendNativeOutput(socket, 'resp_rebased', responseOutput('recovered'));
    });
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('tool question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'tool result' }], toolCalls: [] });
      const second = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(second.message.content).toEqual([{ type: 'text', text: 'recovered' }]);
      expect(gateway.frames).toHaveLength(3);
      expect(gateway.frames[1]?.body['previous_response_id']).toBe('resp_tool');
      expect(gateway.frames[2]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[2]?.body['input']).toEqual([...(gateway.frames[0]!.body['input'] as unknown[]), ...output, ...(gateway.frames[1]!.body['input'] as unknown[])]);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it('does not commit when the consumer rejects the assembled response', async () => {
    const output = [{ type: 'function_call', id: 'fc_1', status: 'completed', call_id: 'call_1', name: 'synthetic_echo', arguments: '{}' }];
    const gateway = await createGateway((_body, socket) => sendNativeOutput(socket, 'resp_tool', output));
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      await expect(generate(provider, '', [], [user('question')], {
        onToolCall: () => { throw new Error('Synthetic consumer rejection'); },
      }, { responsesTransport: transport })).rejects.toThrow('Synthetic consumer rejection');
      await generate(provider, '', [], [user('question'), { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'call_1', name: 'synthetic_echo', arguments: '{}' }] }, user('next')], undefined, { responsesTransport: transport });
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
    } finally { transport.dispose(); }
  });
});

describe('opaque native Responses rebase', () => {
  it('sends full native items without rounding opaque integers or dropping unknown signatures', async () => {
    const opaque = '{"type":"function_call","id":"fc_opaque","status":"completed","call_id":"call_1","name":"synthetic_echo","arguments":"{}","future":{"integer":9007199254740993,"signature":"opaque-future-signature"}}';
    const gateway = await createGateway((_body, socket) => {
      sendCreated(socket, 'resp_opaque');
      socket.send(`{"type":"response.output_item.added","output_index":0,"item":${opaque}}`);
      socket.send(`{"type":"response.output_item.done","output_index":0,"item":${opaque}}`);
      socket.send(`{"type":"response.completed","response":{"id":"resp_opaque","status":"completed","output":[${opaque}]}}`);
    });
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'result' }], toolCalls: [] });
      await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[1]?.wire).toContain('9007199254740993');
      expect(gateway.frames[1]?.wire).toContain('opaque-future-signature');
      expect((gateway.frames[1]?.body['input'] as RawObject[])[1]?.['id']).toBe('fc_opaque');
    } finally { transport.dispose(); }
  });
});

describe('Responses WebSocket opt-in configuration', () => {
  it('roundtrips the exact public TOML key without requiring WebSocket for HTTP providers', () => {
    const toml = { gateway: { responses_web_socket: { targets: ['https://example.test/v1'] } } };
    const parsed = ProvidersSectionSchema.parse(providersFromToml(toml));
    expect(parsed['gateway']?.responsesWebSocket).toEqual({ targets: ['https://example.test/v1'] });
    expect(providersToToml(parsed, {})).toEqual(toml);
    expect(ProvidersSectionSchema.parse({ ordinary: { type: 'openai' } })['ordinary']?.responsesWebSocket).toBeUndefined();
    expect(() => ProvidersSectionSchema.parse({ gateway: { responsesWebSocket: { targets: ['https://other.test/v1?key=hidden'] } } })).toThrow();
    expect(ProvidersSectionSchema.parse({ gateway: { responsesWebSocket: { off: true } } })['gateway']?.responsesWebSocket).toEqual({ off: true });
  });

  it('inherits a system target list and lets explicit off replace it', () => {
    expect(new ConfigRegistry().getSection(RESPONSES_WEB_SOCKET_SECTION)).toMatchObject({
      domain: RESPONSES_WEB_SOCKET_SECTION,
      defaultValue: undefined,
    });
    const wire = { targets: ['https://example.test/v1'] };
    expect(requestIdentityFromToml(wire)).toEqual(wire);
    expect(requestIdentityToToml({ off: true })).toEqual({ off: true });
    const targets = ['https://b.example.test/v1', 'https://a.example.test/v1'];
    expect(responsesWebSocketToWire({ targets })).toEqual({ targets });
    expect(responsesWebSocketToWire({ targets })?.targets).not.toBe(targets);
    expect(responsesWebSocketFromWire({ off: true })).toEqual({ off: true });
    expect(responsesWebSocketToWire(undefined)).toBeUndefined();
    expect(() => ResponsesWebSocketSystemSchema.parse({})).toThrowError(
      expect.objectContaining({ code: 'config.invalid', message: 'responses_web_socket needs targets or off' }),
    );
    expect(() => ResponsesWebSocketSystemSchema.parse({ off: true, targets })).toThrowError(
      expect.objectContaining({ code: 'config.invalid' }),
    );
    expect(ResponsesWebSocketSystemSchema.parse({ off: true })).toEqual({ off: true });
    expect(ResponsesWebSocketSystemSchema.parse({ targets })).toEqual({ targets });
    const system = { targets: ['https://example.test/v1', 'https://backup.example.test/v1'] };
    expect(resolveResponsesWebSocket(undefined, undefined)).toBeUndefined();
    expect(resolveResponsesWebSocket(undefined, { targets: ['https://example.test/v1'] })).toEqual({
      targets: ['https://example.test/v1'],
    });
    const inherited = resolveResponsesWebSocket(system, undefined);
    expect(inherited).toEqual(system);
    expect(inherited?.targets).not.toBe(system.targets);
    expect(resolveResponsesWebSocket(system, { off: true })).toBeUndefined();
    expect(resolveResponsesWebSocket({ off: true }, undefined)).toBeUndefined();
    expect(resolveResponsesWebSocket({ off: true }, { targets: ['https://other.example.test/v1'] })).toEqual({
      targets: ['https://other.example.test/v1'],
    });
    expect(resolveResponsesWebSocket(system, { targets: ['https://other.example.test/v1'] })).toEqual({
      targets: ['https://other.example.test/v1'],
    });
  });
});

describe('Responses fallback native history preservation', () => {
  it('passes the native full rebase to HTTP instead of stripping opaque fields from canonical history', async () => {
    const native = [
      { type: 'reasoning', id: 'rs_opaque', status: 'completed', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'opaque-reasoning-signature' },
      { type: 'function_call', id: 'fc_opaque', status: 'completed', call_id: 'call_1', name: 'synthetic_echo', arguments: '{}', future: { signature: 'opaque-tool-signature' } },
    ];
    let requests = 0;
    const gateway = await createGateway((_body, socket) => {
      requests += 1;
      if (requests === 1) sendNativeOutput(socket, 'resp_opaque', native);
      else sendUnsupportedUpstream(socket);
    });
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'result' }], toolCalls: [] });
      await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(gateway.httpRequests).toHaveLength(1);
      expect(gateway.httpRequests[0]?.['input']).toEqual(gateway.frames[1]?.body['input']);
      expect((gateway.httpRequests[0]?.['input'] as unknown[]).slice(1, 3)).toEqual(native);
    } finally { transport.dispose(); }
  });
});

describe('advertised Responses state expiry', () => {
  it('retires a socket that expires during generation and retains its actual connection age', async () => {
    let held!: WebSocket;
    let notifySent!: () => void;
    const sent = new Promise<void>(resolve => { notifySent = resolve; });
    const gateway = await createGateway((_body, socket) => {
      if (gateway.frames.length === 2) {
        held = socket;
        sendCreated(socket, 'resp_pending');
        notifySent();
      } else sendCompleted(socket, 'resp_kept', 'answer');
    });
    const transport = new ResponsesWebSocketTransport();
    let clock = 0n;
    const hrtime = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => clock);
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      clock = 54n * 60n * 1_000_000_000n;
      const pending = generate(provider, '', [], history, undefined, { responsesTransport: transport }).catch((error: unknown) => error);
      await sent;
      clock = 60n * 60n * 1_000_000_000n;
      held.send(JSON.stringify({ type: 'response.failed', response: { id: 'resp_pending', status: 'failed', output: [],
        error: { code: 'websocket_connection_limit_reached', message: 'Create a new websocket connection to continue.' } } }));
      expect(toErrorPayload(await pending)).toMatchObject({ code: 'provider.connection_error', details: { responsesTransport: {
        transport: 'ws', webSocketCapabilities: true, webSocketCapabilityVersion: 1, webSocketConnectionAgeMs: 3_600_000,
      } } });
      expect(transport.capabilities).toBeUndefined();
      const recovered = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(recovered.message.content).toEqual([{ type: 'text', text: 'answer' }]);
      expect(gateway.frames.map(frame => frame.connection)).toEqual([0, 0, 1]);
      expect(gateway.frames[2]?.body).not.toHaveProperty('previous_response_id');
      expect(gateway.frames[2]?.body['input']).toHaveLength(3);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); hrtime.mockRestore(); }
  });

  it.each([
    { version: 1, idleMinutes: 55 }, { version: 1, idleMinutes: 60 },
    { version: 2, idleMinutes: 55 }, { version: 2, idleMinutes: 60 },
  ])('rotates the production provider socket after $idleMinutes minutes with v$version capabilities', async ({ version, idleMinutes }) => {
    const header = version === 1
      ? JSON.stringify({ ...JSON.parse(capabilities) as RawObject, connection_lifetime_seconds: 3600 })
      : v2Capabilities({ admission_lifetime_seconds: 3600, active_turn_timeout_seconds: 600, connection_lifetime_seconds: 4215 });
    const gateway = await createGateway((_body, socket) => { sendCompleted(socket, 'resp_rotating', 'answer'); }, header);
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'Date'] });
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      await vi.advanceTimersByTimeAsync(idleMinutes * 60_000);
      const second = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(second.message.content).toEqual([{ type: 'text', text: 'answer' }]);
      expect(gateway.frames.map(frame => frame.connection)).toEqual([0, 1]);
      expect(gateway.frames[1]?.body).not.toHaveProperty('previous_response_id');
      const fullInput = gateway.frames[1]?.body['input'] as RawObject[];
      expect(fullInput).toHaveLength(3);
      expect(fullInput[0]).toEqual((gateway.frames[0]?.body['input'] as unknown[])[0]);
      expect(fullInput[1]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] });
      expect(fullInput[2]).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] });
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('replaces a socket at 55 minutes before sending the next request', async () => {
    const longCapabilities = JSON.stringify({ ...JSON.parse(capabilities), connection_lifetime_seconds: 3600 });
    const gateway = await createGateway((_body, socket) => { sendCompleted(socket, 'resp_rotating', 'answer'); }, longCapabilities);
    const transport = new ResponsesWebSocketTransport();
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'Date'] });
    try {
      const openai = client(gateway.baseUrl);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      await vi.advanceTimersByTimeAsync(55 * 60_000 - 1);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      expect(gateway.frames.map(frame => frame.connection)).toEqual([0, 0]);
      await vi.advanceTimersByTimeAsync(1);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      expect(gateway.frames.map(frame => frame.connection)).toEqual([0, 0, 1]);
      expect(gateway.frames[2]?.body).toMatchObject({ input });
      expect(gateway.frames[2]?.body).not.toHaveProperty('previous_response_id');
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('full-rebases after the advertised TTL and reconnects after the advertised lifetime', async () => {
    const shortCapabilities = JSON.stringify({ ...JSON.parse(capabilities), state_ttl_seconds: 1, connection_lifetime_seconds: 3 });
    const gateway = await createGateway((_body, socket) => sendCompleted(socket, 'resp_timed', 'answer'), shortCapabilities);
    const transport = new ResponsesWebSocketTransport();
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const openai = client(gateway.baseUrl);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      await vi.advanceTimersByTimeAsync(1_000);
      const next = [...input, ...responseOutput('answer'), { type: 'message', role: 'user', content: [] }];
      await collect(await transport.create(openai, { model: 'synthetic', input: next }));
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[1]?.connection).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      expect(gateway.frames[2]?.connection).toBe(1);
      expect(gateway.frames[2]?.body['previous_response_id']).toBeUndefined();
    } finally { transport.dispose(); vi.useRealTimers(); }
  });
});

it('does not rewrite or commit a request whose supplied canonical input disagrees with the actual body', async () => {
  const gateway = await createGateway((_body, socket) => sendCompleted(socket, 'resp_canonical', 'answer'));
  const transport = new ResponsesWebSocketTransport();
  try {
    const openai = client(gateway.baseUrl);
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'original' }] }];
    await collect(await transport.create(openai, { model: 'synthetic', input }));
    const alleged = [...input, ...responseOutput('answer'), { type: 'message', role: 'user', content: [] }];
    const edited = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edited' }] }];
    await collect(await transport.create(openai, { model: 'synthetic', input: edited }, { canonical: alleged }));
    expect(gateway.frames[1]?.body['input']).toEqual(edited);
    expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
    await collect(await transport.create(openai, { model: 'synthetic', input: [...alleged, ...responseOutput('answer')] }));
    expect(gateway.frames[2]?.body['previous_response_id']).toBeUndefined();
  } finally { transport.dispose(); }
});

describe('Responses WebSocket v2 retirement', () => {
  it('falls back to one full HTTP request when the capability version is unknown and sends no response.create', async () => {
    const unknown = JSON.stringify({ ...JSON.parse(capabilities) as RawObject, version: 3 });
    const gateway = await createGateway(() => undefined, unknown);
    const transport = new ResponsesWebSocketTransport();
    try {
      const result = await generate(productionProvider(gateway.baseUrl), 'fresh instructions', [], [user('full question')], undefined, { responsesTransport: transport });
      expect(result.message.content).toEqual([{ type: 'text', text: 'HTTP fallback' }]);
      expect(gateway.frames).toHaveLength(0);
      expect(gateway.httpRequests).toHaveLength(1);
      expect(gateway.httpRequests[0]?.['previous_response_id']).toBeUndefined();
      expect(gateway.httpRequests[0]?.['instructions']).toBe('fresh instructions');
    } finally { transport.dispose(); }
  });

  it('retains the verified v2 native prefix for full HTTP when the new socket advertises an unknown version before create', async () => {
    let handshakes = 0;
    const gateway = await createGateway((_body, socket) => {
      sendCompleted(socket, 'resp_kept', 'kept');
      socket.close(1000, 'retired');
    }, () => ++handshakes === 1 ? capabilitiesV2 : v2Capabilities({ version: 3 }));
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      const second = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(second.message.content).toEqual([{ type: 'text', text: 'HTTP fallback' }]);
      expect(gateway.connections).toHaveLength(2);
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(1);
      expect(gateway.httpRequests[0]?.['previous_response_id']).toBeUndefined();
      expect(gateway.httpRequests[0]?.['input']).toEqual([
        ...(gateway.frames[0]!.body['input'] as unknown[]), ...responseOutput('kept'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ]);
    } finally { transport.dispose(); }
  });

  it('rejects a v2 socket I/O connection_lifetime_seconds that is not admission plus active plus 15 before response.create', async () => {
    const gateway = await createGateway(() => undefined, v2Capabilities({
      connection_lifetime_seconds: (capabilitiesV2Object['connection_lifetime_seconds'] as number) + 1,
    }));
    const transport = new ResponsesWebSocketTransport();
    try {
      await expect(transport.create(client(gateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      })).rejects.toThrow(/connection_lifetime_seconds must equal admission_lifetime_seconds \+ active_turn_timeout_seconds \+ 15/);
      expect(gateway.frames).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it('accepts version 2 drain_active, sends a delta, and full-rebases native items after its terminal and peer close', async () => {
    const gateway = await createGateway((_body, socket, connection) => {
      sendCompleted(socket, `resp_${connection}_${gateway.frames.length}`, 'answer');
      if (gateway.frames.length === 2) socket.close(1000, 'retired');
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(first.message.content).toEqual([{ type: 'text', text: 'answer' }]);
      expect(transport.capabilities).toMatchObject(capabilitiesV2Object);
      history.push(first.message, user('next'));
      const second = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(gateway.connections).toHaveLength(1);
      expect(gateway.frames[1]?.body['previous_response_id']).toBe('resp_0_1');
      expect(gateway.frames[1]?.body['input']).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }]);
      history.push(second.message, user('after close'));
      const third = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(third.message.content).toEqual([{ type: 'text', text: 'answer' }]);
      expect(gateway.connections).toHaveLength(2);
      expect(gateway.frames[2]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[2]?.body['input']).toEqual([
        ...(gateway.frames[0]!.body['input'] as unknown[]), ...responseOutput('answer'),
        ...(gateway.frames[1]!.body['input'] as unknown[]), ...responseOutput('answer'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after close' }] },
      ]);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it.each([
    { lane: 'queued', frame: connectionRetiringFile },
    { lane: 'default', frame: defaultLaneRetiring() },
  ])('sends one full HTTP request after a trusted not-executed connection_retiring frame on the $lane lane without a second response.create', async ({ frame }) => {
    expect(connectionRetiringObject).toMatchObject({
      type: 'error',
      status: 400,
      execution: 'not_executed',
      stream_id: 'synthetic-queued-lane',
      error: {
        type: 'invalid_request_error',
        code: 'connection_retiring',
        param: '',
      },
    });
    expect(JSON.parse(defaultLaneRetiring())).not.toHaveProperty('stream_id');
    let requests = 0;
    const gateway = await createGateway((_body, socket) => {
      requests += 1;
      if (requests === 1) sendCompleted(socket, 'resp_kept', 'first');
      else socket.send(frame);
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      const second = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(second.message.content).toEqual([{ type: 'text', text: 'HTTP fallback' }]);
      expect(gateway.frames).toHaveLength(2);
      expect(gateway.frames[1]?.connection).toBe(0);
      expect(gateway.frames[1]?.body['previous_response_id']).toBe('resp_kept');
      expect(gateway.connections).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(1);
      expect(gateway.httpRequests[0]?.['previous_response_id']).toBeUndefined();
      const httpInput = gateway.httpRequests[0]?.['input'] as RawObject[];
      expect(httpInput.length).toBeGreaterThan((gateway.frames[1]?.body['input'] as unknown[]).length);
      expect(httpInput.some((item) => item['type'] === 'message' && item['role'] === 'assistant')).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(gateway.closedConnections).toContain(0);
    } finally { transport.dispose(); }
  });

  it('does not replay connection_retiring after partial output, a nested mark, or a missing execution', async () => {
    const partial = await createGateway((_body, socket) => {
      sendCreated(socket, 'resp_partial');
      socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial', item_id: 'm', content_index: 0, output_index: 0 }));
      socket.send(connectionRetiringFile);
    }, capabilitiesV2);
    const partialTransport = new ResponsesWebSocketTransport();
    let observed = '';
    try {
      await expect(generate(productionProvider(partial.baseUrl), '', [], [user('question')], {
        onMessagePart: (part) => { if (part.type === 'text') observed += part.text; },
      }, { responsesTransport: partialTransport })).rejects.toThrow();
      expect(observed).toBe('partial');
      expect(partial.frames).toHaveLength(1);
      expect(partial.httpRequests).toHaveLength(0);
    } finally { partialTransport.dispose(); }

    const untrusted = [
      retiringFrame((frame) => {
        (frame['error'] as RawObject)['execution'] = frame['execution'];
        delete frame['execution'];
      }),
      retiringFrame((frame) => {
        delete frame['execution'];
      }),
      retiringFrame((frame) => {
        delete (frame['error'] as RawObject)['code'];
        frame['code'] = 'connection_retiring';
      }),
    ];
    for (const frame of untrusted) {
      const gateway = await createGateway((_body, socket) => socket.send(frame), capabilitiesV2);
      const transport = new ResponsesWebSocketTransport();
      try {
        await expect(generate(productionProvider(gateway.baseUrl), '', [], [user('question')], undefined, { responsesTransport: transport })).rejects.toThrow();
        expect(gateway.frames).toHaveLength(1);
        expect(gateway.httpRequests).toHaveLength(0);
      } finally { transport.dispose(); }
    }
  });

  it('keeps a turn only because its terminal was consumed when the peer socket closes immediately afterwards', async () => {
    const gateway = await createGateway((_body, socket) => {
      if (gateway.frames.length === 1) {
        sendCompleted(socket, 'resp_kept', 'kept');
        socket.close();
      } else sendCompleted(socket, 'resp_next', 'next');
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(first.message.content).toEqual([{ type: 'text', text: 'kept' }]);
      expect(first.message.role).toBe('assistant');
      history.push(first.message, user('next'));
      const second = await generate(provider, 'synthetic instructions', [], history, undefined, { responsesTransport: transport });
      expect(second.message.content).toEqual([{ type: 'text', text: 'next' }]);
      expect(gateway.frames).toHaveLength(2);
      expect(gateway.frames[1]?.connection).toBe(1);
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[1]?.body['input']).toEqual([
        ...(gateway.frames[0]!.body['input'] as unknown[]), ...responseOutput('kept'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ]);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it.each(['trusted retirement', 'top-level code only', 'unknown execution'] as const)('keeps native full input across a new socket and permits HTTP only for %s', async (mode) => {
    const gateway = await createGateway((_body, socket) => {
      if (gateway.frames.length === 1) {
        sendCompleted(socket, 'resp_kept', 'kept');
        socket.close(1000, 'retired');
      } else socket.send(retiringFrame((frame) => {
        if (mode === 'top-level code only') {
          delete (frame['error'] as RawObject)['code'];
          frame['code'] = 'connection_retiring';
        } else if (mode === 'unknown execution') frame['execution'] = 'unknown';
      }));
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('next'));
      const pending = generate(provider, '', [], history, undefined, { responsesTransport: transport });
      if (mode === 'trusted retirement') {
        const result = await pending;
        expect(result.message.content).toEqual([{ type: 'text', text: 'HTTP fallback' }]);
      } else await expect(pending).rejects.toThrow();
      const fullInput = [
        ...(gateway.frames[0]!.body['input'] as unknown[]), ...responseOutput('kept'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ];
      expect(gateway.frames).toHaveLength(2);
      expect(gateway.frames[1]?.connection).toBe(1);
      expect(gateway.frames[1]?.body['input']).toEqual(fullInput);
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.httpRequests).toHaveLength(mode === 'trusted retirement' ? 1 : 0);
      if (mode === 'trusted retirement') {
        expect(gateway.httpRequests[0]?.['input']).toEqual(fullInput);
        expect(gateway.httpRequests[0]?.['previous_response_id']).toBeUndefined();
      }
    } finally { transport.dispose(); }
  });

  it('R1: commits an adapter terminal consumed asynchronously across the default hard deadline and full-rebases next', async () => {
    let notifySent!: () => void;
    const sent = new Promise<void>((resolve) => { notifySent = resolve; });
    let held: WebSocket | undefined;
    const gateway = await createGateway((_body, socket) => {
      if (gateway.frames.length === 2) {
        held = socket;
        sendCreated(socket, 'resp_second');
        notifySent();
      } else sendCompleted(socket, `resp_${gateway.frames.length}`, 'kept');
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const provider = productionProvider(gateway.baseUrl);
      const history = [user('question')];
      const first = await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      history.push(first.message, user('second'));
      await vi.advanceTimersByTimeAsync(1_799_999);
      const second = generate(provider, '', [], history, {
        onMessagePart: async () => {
          held!.close(1000, 'retired');
          await vi.advanceTimersByTimeAsync(15_002);
          expect(transport.capabilities).toBeUndefined();
        },
      }, { responsesTransport: transport });
      await sent;
      await vi.advanceTimersByTimeAsync(599_999);
      held!.send(JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_second', status: 'completed', output: responseOutput('kept'),
      } }));
      const result = await second;
      expect(result.message.content).toEqual([{ type: 'text', text: 'kept' }]);
      history.push(result.message, user('third'));
      await generate(provider, '', [], history, undefined, { responsesTransport: transport });
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[1]?.body['input']).toHaveLength(3);
      expect(gateway.frames[2]?.connection).toBe(1);
      expect(gateway.frames[2]?.body['previous_response_id']).toBeUndefined();
      expect(gateway.frames[2]?.body['input']).toEqual([
        ...(gateway.frames[0]!.body['input'] as unknown[]), ...responseOutput('kept'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] },
        ...responseOutput('kept'),
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'third' }] },
      ]);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it.each(['cancel', 'dispose', 'close'] as const)('R1: explicit %s still fails after the socket hard deadline during terminal consumption', async (action) => {
    const gateway = await createGateway((_body, socket) => {
      socket.send(JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_done', status: 'completed', output: responseOutput('kept'),
      } }));
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await expect(generate(productionProvider(gateway.baseUrl), '', [], [user('question')], {
        onMessagePart: async () => {
          await vi.advanceTimersByTimeAsync(2_415_000);
          if (action === 'cancel') controller.abort();
          else transport[action]();
        },
      }, { responsesTransport: transport, signal: controller.signal })).rejects.toThrow();
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('R3: segments a valid long v2 lifetime without early close or native timer overflow', async () => {
    const hardMs = 2_147_500_000;
    const gateway = await createGateway((_body, socket) => sendCreated(socket, 'resp_hold'), v2Capabilities({
      admission_lifetime_seconds: 2_147_484,
      active_turn_timeout_seconds: 1,
      connection_lifetime_seconds: hardMs / 1000,
    }));
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'Date'] });
    try {
      const stream = await transport.create(client(gateway.baseUrl), { model: 'synthetic', input: [] });
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(transport.capabilities?.connection_lifetime_seconds).toBe(hardMs / 1000);
      await vi.advanceTimersByTimeAsync(hardMs - 2_147_483_647 - 1);
      expect(transport.capabilities).toBeDefined();
      await vi.advanceTimersByTimeAsync(1);
      await expect(collect(stream)).rejects.toMatchObject({ code: 'responses_websocket_closed_before_terminal' });
      expect(transport.capabilities).toBeUndefined();
      expect(gateway.frames).toHaveLength(1);
      expect(gateway.httpRequests).toHaveLength(0);
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('does not close an in-flight v1 socket at connection_lifetime_seconds', async () => {
    const short = JSON.stringify({ ...JSON.parse(capabilities) as RawObject, connection_lifetime_seconds: 3 });
    let held: WebSocket | undefined;
    const gateway = await createGateway((_body, socket) => {
      held = socket;
      if (gateway.frames.length === 1) sendCreated(socket, 'resp_hold');
    }, short);
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const stream = await transport.create(client(gateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(gateway.closedConnections).toEqual([]);
      sendCompleted(held!, 'resp_hold', 'kept');
      const events = await collect(stream);
      expect(events.map((value) => object(value)['type'])).toContain('response.completed');
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('keeps an in-flight v2 socket open at admission and does not reuse it after the socket I/O lifetime once the terminal was consumed', async () => {
    const admission = capabilitiesV2Object['admission_lifetime_seconds'] as number;
    const active = capabilitiesV2Object['active_turn_timeout_seconds'] as number;
    let held: WebSocket | undefined;
    const gateway = await createGateway((_body, socket) => {
      held = socket;
      if (gateway.frames.length === 1) sendCreated(socket, 'resp_hold');
      else sendCompleted(socket, 'resp_next', 'next');
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const openai = client(gateway.baseUrl);
      const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }];
      const stream = await transport.create(openai, { model: 'synthetic', input });
      await vi.advanceTimersByTimeAsync(admission * 1000);
      expect(gateway.closedConnections).toEqual([]);
      held!.send(JSON.stringify({
        content_index: 0,
        delta: 'kept',
        item_id: 'msg_1',
        output_index: 0,
        type: 'response.output_text.delta',
      }));
      held!.send(JSON.stringify({
        response: { id: 'resp_hold', output: responseOutput('kept'), status: 'completed' },
        type: 'response.completed',
      }));
      const events = await collect(stream);
      expect(events.map((value) => object(value)['type'])).toContain('response.completed');
      await vi.advanceTimersByTimeAsync(active * 1000 + TERMINAL_WRITE_MARGIN_SECONDS * 1000);
      await collect(await transport.create(openai, { model: 'synthetic', input }));
      expect(gateway.frames[1]?.connection).toBe(1);
      expect(gateway.frames[1]?.body['previous_response_id']).toBeUndefined();
    } finally { transport.dispose(); vi.useRealTimers(); }
  });

  it('closes the client socket at connection_lifetime_seconds when no terminal arrived', async () => {
    const hard = capabilitiesV2Object['connection_lifetime_seconds'] as number;
    const gateway = await createGateway((_body, socket) => {
      sendCreated(socket, 'resp_hold');
    }, capabilitiesV2);
    const transport = new ResponsesWebSocketTransport();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const stream = await transport.create(client(gateway.baseUrl), {
        input: [{ role: 'user', type: 'message' }],
        model: 'gpt-test',
        stream: true,
      });
      await vi.advanceTimersByTimeAsync(hard * 1000);
      await expect(collect(stream)).rejects.toMatchObject({ code: 'responses_websocket_closed_before_terminal' });
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(gateway.closedConnections).toContain(0);
    } finally { transport.dispose(); vi.useRealTimers(); }
  });
});

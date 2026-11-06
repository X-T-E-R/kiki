import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { PluginManager } from '#/app/plugin/manager';
import { writeInstalled } from '#/app/plugin/store';
import type { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { ChatProvider } from '#/kosong/contract/provider';

import { appService, createTestAgent, externalHookServices, permissionModeServices, type TestAgentContext } from '../../harness';
import { makeHookRunner } from './runner-stub';

const wirePath = 'E:/kiki-wt/sub2-stream-preheader-20261106/.agent/summary/argon-502-20261107/messages-clean-empty-c-false.sse';
const httpPath = 'E:/kiki-wt/sub2-stream-preheader-20261106/.agent/summary/argon-502-20261107/messages-clean-empty-c-false.http';
const pluginRoot = 'C:/Users/xxoy1/.kiki/plugins/managed/argon-error-recovery';
const scratchRoot = fileURLToPath(new URL('../../../../../.tmp/upstream-retry-continuation/', import.meta.url));

const originalWire = await readFile(wirePath);
const capturedHttp = await readFile(httpPath);
const headerEnd = capturedHttp.indexOf(Buffer.from('\r\n\r\n'));
if (headerEnd < 0 || !capturedHttp.subarray(headerEnd + 4).equals(originalWire)) {
  throw new Error('The captured HTTP body is not the original SSE wire.');
}
if (!originalWire.includes(Buffer.from('"retryable":false'))) {
  throw new Error('The original wire no longer contains an explicit retryable false.');
}

function sse(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function messageStart(id: string): readonly [string, unknown] {
  return ['message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: 'example-model', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 },
    },
  }];
}

function terminalSse(text: string): string {
  return sse([
    messageStart('msg_terminal'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolSse(): string {
  return sse([
    messageStart('msg_tool'),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name: 'SaveWork', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function errorSse(error: Record<string, unknown>): string {
  return sse([
    messageStart('msg_error'),
    ['error', { type: 'error', error }],
  ]);
}

function jsonResponse(status: number, reason: string, body: unknown): Buffer {
  const payload = JSON.stringify(body);
  return Buffer.from(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
}

interface Replay {
  readonly requests: { readonly url: string | undefined; readonly body: unknown }[];
  readonly responseBodies: Buffer[];
  readonly retryEvents: unknown[];
  readonly local: TestAgentContext;
  readonly trigger: MockInstance<ExternalHooksRunnerService['trigger']>;
  readonly tools: number;
  close(): Promise<void>;
}

async function replay(choose: (requestNumber: number, continued: boolean) => Buffer | string, options: { readonly maxAttempts?: number; readonly tool?: boolean } = {}): Promise<Replay> {
  await mkdir(scratchRoot, { recursive: true });
  const home = await mkdtemp(join(scratchRoot, 'case-'));
  const requests: Replay['requests'] = [];
  const responseBodies: Buffer[] = [];
  const retryEvents: unknown[] = [];
  let continued = false;
  let tools = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw.length === 0 ? undefined : JSON.parse(raw) as unknown;
    requests.push({ url: req.url, body });
    continued ||= JSON.stringify(body).includes('继续');
    const selected = choose(requests.length, continued);
    if (typeof selected === 'string') {
      writeSse(res, selected);
      return;
    }
    req.socket.end(selected);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback port');
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' || url.port !== String(address.port)) throw new Error(`Blocked ${url.origin}`);
    const response = await originalFetch(input, init);
    responseBodies.push(Buffer.from(await response.clone().arrayBuffer()));
    return response;
  });
  await writeInstalled(home, { version: 1, plugins: [{ id: 'argon-error-recovery', root: pluginRoot, source: 'local-path', enabled: true, installedAt: '2026-11-07T00:00:00.000Z' }] });
  const manager = new PluginManager({ kimiHomeDir: home });
  await manager.load();
  expect(manager.get('argon-error-recovery')?.diagnostics).toEqual([]);
  expect(manager.get('argon-error-recovery')?.state).toBe('ok');
  const runner = makeHookRunner([], { cwd: home, pluginHooks: manager.enabledHooks() });
  const trigger = vi.spyOn(runner, 'trigger');
  const provider = new AnthropicChatProvider({ model: 'example-model', apiKey: 'YOUR_API_KEY', baseUrl: origin });
  class FixtureRegistry extends ProtocolAdapterRegistry {
    override createChatProvider(): ChatProvider { return provider; }
  }
  const local = createTestAgent(
    externalHookServices(runner), permissionModeServices('yolo'),
    appService(IProtocolAdapterRegistry, new FixtureRegistry()),
    { initialConfig: { retry: { maxAttempts: options.maxAttempts ?? 5, policies: [{ match: '.+', backoff: 0 }] } } },
  );
  if (options.tool === true) {
    local.get(IAgentToolRegistryService).register({
      name: 'SaveWork', description: 'Save work', parameters: { type: 'object' },
      resolveExecution: () => ({ approvalRule: 'SaveWork', execute: async () => { tools += 1; return { output: 'saved' }; } }),
    });
    local.get(IAgentProfileService).update({ activeToolNames: ['SaveWork'] });
  }
  local.get(IEventBus).subscribe((event) => {
    if (event.type === 'turn.step.retrying') retryEvents.push(event);
  });
  return {
    requests, responseBodies, retryEvents, local, trigger, get tools() { return tools; },
    async close() {
      vi.stubGlobal('fetch', originalFetch);
      await local.dispose();
      await runner.dispose();
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(home, { recursive: true, force: true });
    },
  };
}

function writeSse(res: ServerResponse<IncomingMessage>, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.end(body);
}

function continuations(local: TestAgentContext) {
  return local.contextData().history.filter((message) => message.origin?.kind === 'system_trigger' && message.origin.name === 'failure_recovery_hook');
}

function stops(replayed: Replay) {
  return replayed.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
}

describe('upstream retryable false through the real Messages SDK', () => {
  const open: Replay[] = [];
  afterEach(async () => {
    const pending = open.splice(0);
    await Promise.all(pending.map(async (replayed) => replayed.close()));
  });

  it('replays the original wire once, appends one continuation, and converges on the new message', async () => {
    const replayed = await replay((requestNumber, continued) => continued ? terminalSse('Synthetic terminal after continuation.') : requestNumber === 1 ? capturedHttp : capturedHttp);
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies[0]).toEqual(originalWire);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(JSON.stringify(replayed.requests[1]?.body).split('继续')).toHaveLength(2);
    const call = stops(replayed)[0]?.[1]?.inputData;
    expect(call).toMatchObject({
      recoverable: true,
      recoveryAttempts: 0,
      upstreamErrorCode: 'antigravity_missing_terminal',
      error: { details: { upstream_retryable: false, upstreamErrorCode: 'antigravity_missing_terminal' } },
    });
    expect((call?.['error'] as { details?: Record<string, unknown> }).details).not.toHaveProperty('retry');
  }, 60_000);

  it('does not send a third request when the new message fails with the same wire', async () => {
    const replayed = await replay(() => capturedHttp);
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies.every((body) => body.equals(originalWire))).toBe(true);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true]);
  }, 60_000);

  it('does not replay a tool that already succeeded before the original wire', async () => {
    const replayed = await replay((requestNumber, continued) => {
      if (requestNumber === 1) return toolSse();
      return continued ? terminalSse('Continued after the saved tool.') : capturedHttp;
    }, { tool: true });
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.tools).toBe(1);
    expect(replayed.requests).toHaveLength(3);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies.filter((body) => body.equals(originalWire))).toHaveLength(1);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(JSON.stringify(replayed.requests[2]?.body)).toContain('saved');
    expect(JSON.stringify(replayed.requests[2]?.body).split('继续')).toHaveLength(2);
  }, 60_000);

  it('retries a real read disconnect and does not append a message for it', async () => {
    const partial = sse([messageStart('msg_disconnect')]);
    const replayed = await replay(() => partial, { maxAttempts: 2 });
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(1);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)).toHaveLength(1);
    const input = stops(replayed)[0]?.[1]?.inputData;
    expect(input).toMatchObject({
      recoverable: true,
      recoveryAttempts: 0,
      errorCode: 'provider.connection_error',
      error: { details: { retry: false, retry_exhausted: true, retry_attempts: 2, retry_max_attempts: 2 } },
    });
    const serialized = JSON.stringify(input?.['error']);
    expect(serialized).toContain('before message_stop');
    expect(serialized).not.toContain('request_delivery');
    expect(serialized).not.toContain('upstream_retryable');
  }, 60_000);

  it.each([true, false])('keeps a gateway terminal error terminal when upstream retryable is %s', async (retryable) => {
    const replayed = await replay(() => errorSse({
      type: 'api_error', code: 'gateway_stream_terminal_error', message: 'terminal', retryable,
    }));
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(1);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)[0]?.[1]?.inputData).toMatchObject({
      recoverable: false,
      upstreamErrorCode: 'gateway_stream_terminal_error',
      error: { details: { retry: false, upstreamErrorCode: 'gateway_stream_terminal_error' } },
    });
  }, 60_000);

  it('retries an ordinary 429 and does not continue it', async () => {
    const limited = jsonResponse(429, 'Too Many Requests', { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    const replayed = await replay((requestNumber) => requestNumber === 1 ? limited : terminalSse('After the rate limit'), { maxAttempts: 2 });
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(1);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)).toEqual([]);
  }, 60_000);

  it('does not retry an HTTP 429 explicitly marked non-retryable', async () => {
    const limited = jsonResponse(429, 'Too Many Requests', {
      type: 'error', error: { type: 'rate_limit_error', message: 'slow down', retryable: false },
    });
    const replayed = await replay(() => limited);
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(1);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)[0]?.[1]?.inputData?.['recoverable']).toBe(false);
  }, 60_000);

  it('still retries an ordinary server failure that does not forbid retry', async () => {
    const failure = errorSse({ type: 'api_error', code: 'stream_failed', message: 'temporary' });
    const replayed = await replay((requestNumber) => requestNumber === 1 ? failure : terminalSse('Recovered ordinary failure'), { maxAttempts: 2 });
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(1);
    expect(continuations(replayed.local)).toEqual([]);
  }, 60_000);
});

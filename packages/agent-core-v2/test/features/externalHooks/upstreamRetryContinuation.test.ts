import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginManager } from '#/app/plugin/manager';
import { PLUGIN_SETTINGS_SECTION } from '#/app/plugin/settingsConfigSection';
import { writeInstalled } from '#/app/plugin/store';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';
import type { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { AnthropicChatProvider } from '#/kosong/provider/bases/anthropic/anthropic';
import { ProtocolAdapterRegistry } from '#/kosong/provider/protocolAdapterRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { ChatProvider } from '#/kosong/contract/provider';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { agentService, appService, createTestAgent, externalHookServices, homeDirServices, permissionModeServices, type TestAgentContext } from '../../harness';
import { makeHookRunner } from './runner-stub';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter } from '../../../../transcript/src/index';

const pluginRoot = process.env['KIKI_RECOVERY_PLUGIN_ROOT'] ?? fileURLToPath(new URL('../../fixtures/plugins/argon-error-recovery/', import.meta.url));
const appendixPluginRoot = process.env['KIKI_APPENDIX_PLUGIN_ROOT'] ?? fileURLToPath(new URL('../../fixtures/plugins/argon-tool-result-appendix/', import.meta.url));
const argonModel = 'axon-message/gemini-4-argon';
const gatewayTerminalError = {
  code: 'gateway_stream_terminal_error', message: 'Upstream stream ended before a terminal event', status: 502, type: 'upstream_error',
};
const gatewayTerminalEvent = ['error', { type: 'error', error: gatewayTerminalError }] as const;
const gatewayTerminalWire = sse([gatewayTerminalEvent]);
const usage = { input_tokens: 2049, output_tokens: 0, cache_read_input_tokens: 202879 };
const missingTerminalWire = Buffer.from(sse([
  ...Array.from({ length: 7 }, () => ['ping', { type: 'ping' }] as const),
  ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_missing_terminal', type: 'message', role: 'assistant', model: 'example-model', content: [],
      stop_reason: null, stop_sequence: null, usage,
    },
  }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage }],
  ['error', { type: 'error', error: {
    type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream completed without a usable answer.', retryable: false,
  } }],
]));
const missingTerminalHttp = Buffer.concat([
  Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'),
  missingTerminalWire,
]);

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
    ...toolBlock('toolu_probe', '{}'),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function toolBlock(id: string, argumentsPart: string): ReadonlyArray<readonly [string, unknown]> {
  return [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'SaveWork', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argumentsPart } }],
  ];
}

function textBlock(text: string): ReadonlyArray<readonly [string, unknown]> {
  return [
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ];
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

async function replay(choose: (requestNumber: number, continued: boolean) => Buffer | string, options: {
  readonly maxAttempts?: number;
  readonly tool?: boolean;
  readonly modelAlias?: string;
  readonly pluginEnabled?: boolean;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly profileName?: string;
} = {}): Promise<Replay> {
  const home = await mkdtemp(join(tmpdir(), 'upstream-retry-continuation-'));
  const requests: Replay['requests'] = [];
  const responseBodies: Buffer[] = [];
  const retryEvents: unknown[] = [];
  let continued = false;
  let tools = 0;
  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
  };
  const server = createServer((req, res) => {
    void respond(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
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
  await writeInstalled(home, { version: 1, plugins: [{ id: 'argon-error-recovery', root: pluginRoot, source: 'local-path', enabled: options.pluginEnabled ?? true, installedAt: '2026-11-07T00:00:00.000Z' }] });
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
    appService(IFileSystemStorageService, new FileStorageService(join(home, 'persistence'))),
    appService(IAppendLogStore, new SyncDescriptor(AppendLogStore)),
    ...(options.agentId === undefined ? [] : [
      agentService(IAgentScopeContext, makeAgentScopeContext({
        agentId: options.agentId,
        agentScope: `agents/${options.agentId}`,
        parentAgentId: options.parentAgentId,
      })),
    ]),
    { initialConfig: { retry: { maxAttempts: options.maxAttempts ?? 5, policies: [{ match: '.+', backoff: 0 }] } } },
  );
  if (options.modelAlias !== undefined) local.configure({ provider: { type: 'anthropic', model: options.modelAlias, apiKey: 'YOUR_API_KEY', baseUrl: origin } });
  if (options.profileName !== undefined) local.get(IAgentProfileService).update({ profileName: options.profileName });
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
      await server[Symbol.asyncDispose]();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function writeSse(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.end(body);
}

function continuations(local: TestAgentContext) {
  return local.contextData().history.filter((message) => message.origin?.kind === 'system_trigger' && message.origin.name === 'failure_recovery_hook');
}

function stops(replayed: Replay) {
  return replayed.trigger.mock.calls.filter(([event]) => event === 'StopFailure');
}

function stopResults(replayed: Replay) {
  return Promise.all(replayed.trigger.mock.calls.flatMap(([event], index) => event === 'StopFailure'
    ? [replayed.trigger.mock.results[index]?.value] : []));
}

function prompt(replayed: Replay) {
  return replayed.local.get(IAgentPromptService).enqueue({
    message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
  });
}

describe('provider failures through the real Messages SDK', () => {
  const open: Replay[] = [];
  afterEach(async () => {
    const pending = open.splice(0);
    await Promise.all(pending.map(async (replayed) => replayed.close()));
  });

  it('receives one missing-terminal wire, appends one continuation, and converges on the new message', async () => {
    const replayed = await replay((_requestNumber, continued) => continued ? terminalSse('Synthetic terminal after continuation.') : missingTerminalHttp);
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies[0]).toEqual(missingTerminalWire);
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
    const replayed = await replay(() => missingTerminalHttp);
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    expect(completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies.every((body) => body.equals(missingTerminalWire))).toBe(true);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, false]);
  }, 60_000);

  it('continues a new missing-terminal failure streak after a completed tool-call response and stops on a consecutive repeat failure', async () => {
    const encryptedEmptyMissingTerminal = Buffer.concat([
      Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'),
      Buffer.from(sse([
        ...Array.from({ length: 7 }, () => ['ping', { type: 'ping' }] as const),
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg_encrypted_empty', type: 'message', role: 'assistant', model: 'example-model', content: [],
            stop_reason: null, stop_sequence: null, usage: { input_tokens: 2049, output_tokens: 0, cache_read_input_tokens: 277448 },
          },
        }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EosDCkYICxgCKkA=' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { input_tokens: 2049, output_tokens: 0, cache_read_input_tokens: 277448 } }],
        ['error', { type: 'error', error: {
          type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream completed without a usable answer.', retryable: false,
        } }],
      ])),
    ]);
    const replayed = await replay((requestNumber) => {
      if (requestNumber === 1) return encryptedEmptyMissingTerminal;
      if (requestNumber === 2) return toolSse();
      if (requestNumber === 3) return encryptedEmptyMissingTerminal;
      if (requestNumber === 4) return terminalSse('Completed after recovering two separate failure streaks.');
      return encryptedEmptyMissingTerminal;
    }, { tool: true, modelAlias: argonModel, agentId: 'agent-314', parentAgentId: 'main', profileName: 'implementer-argon' });
    try {
      expect(replayed.local.get(IAgentScopeContext)).toMatchObject({ agentId: 'agent-314', parentAgentId: 'main' });
      expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'completed' });
      expect(replayed.requests).toHaveLength(4);
      expect(replayed.retryEvents).toHaveLength(0);
      expect(replayed.tools).toBe(1);
      expect(continuations(replayed.local)).toHaveLength(2);
      expect(stops(replayed).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 0]);
      expect(stops(replayed).map(([, args]) => args?.inputData?.['maxRecoveryAttempts'])).toEqual([1, 1]);
      expect(stops(replayed).map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true]);
      expect(JSON.stringify(replayed.requests[3]?.body).split('继续')).toHaveLength(3);
    } finally {
      await replayed.close();
    }

    const repeatedAfterReset = await replay((requestNumber) => {
      if (requestNumber === 1) return encryptedEmptyMissingTerminal;
      if (requestNumber === 2) return toolSse();
      return encryptedEmptyMissingTerminal;
    }, { tool: true, modelAlias: argonModel, agentId: 'agent-314', parentAgentId: 'main', profileName: 'implementer-argon' });
    open.push(repeatedAfterReset);
    expect(await (await prompt(repeatedAfterReset)).completion).toMatchObject({ state: 'failed' });
    expect(repeatedAfterReset.requests).toHaveLength(4);
    expect(repeatedAfterReset.tools).toBe(1);
    expect(continuations(repeatedAfterReset.local)).toHaveLength(2);
    expect(stops(repeatedAfterReset).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 0, 1]);
    expect(stops(repeatedAfterReset).map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, true, false]);
  }, 60_000);

  it('does not reset the streak budget on HTTP 200 heartbeats, partial text, or prior tool results when the continuation fails', async () => {
    const partialAfterHeartbeat = sse([
      ...Array.from({ length: 4 }, () => ['ping', { type: 'ping' }] as const),
      messageStart('msg_partial_after_ping'),
      ...textBlock('Partial continuation before drop'),
      ['error', { type: 'error', error: {
        type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream completed without a usable answer.', retryable: false,
      } }],
    ]);
    const replayed = await replay((requestNumber) => {
      if (requestNumber === 1) return toolSse();
      if (requestNumber === 2) return missingTerminalHttp;
      return partialAfterHeartbeat;
    }, { tool: true, modelAlias: argonModel });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'failed' });
    expect(replayed.tools).toBe(1);
    expect(replayed.requests).toHaveLength(3);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoverable'])).toEqual([true, false]);
  }, 60_000);

  it.each([false, true])('keeps the completed tool result without executing a call from the failed stream (block closed: %s)', async (blockClosed) => {
    const failed = sse([
      messageStart('msg_interrupted_tool'),
      ...toolBlock('toolu_interrupted', blockClosed ? '{}' : '{'),
      ...(blockClosed ? [['content_block_stop', { type: 'content_block_stop', index: 0 }] as const] : []),
      gatewayTerminalEvent,
    ]);
    const replayed = await replay((requestNumber, continued) => {
      if (requestNumber === 1) return toolSse();
      return continued ? terminalSse('Continued after the saved tool.') : failed;
    }, { tool: true, modelAlias: argonModel });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'completed' });
    expect(replayed.tools).toBe(1);
    expect(replayed.requests).toHaveLength(3);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(replayed.responseBodies[1]?.toString()).toBe(failed);
    expect(continuations(replayed.local)).toHaveLength(1);
    const nextRequest = JSON.stringify(replayed.requests[2]?.body);
    expect(nextRequest).toContain('saved');
    expect(nextRequest).toContain('toolu_probe');
    expect(nextRequest).not.toContain('toolu_interrupted');
    expect(nextRequest.split('继续')).toHaveLength(2);
    const toolResults = (await replayed.local.persistedWireRecords()).filter((record) => record.type === 'context.append_loop_event')
      .map((record) => record['event'] as { type: string; toolCallId?: string; result?: { output?: string } })
      .filter((event) => event.type === 'tool.result');
    expect(toolResults).toEqual([expect.objectContaining({ toolCallId: 'toolu_probe', result: { output: 'saved' } })]);
  }, 60_000);

  it.each(['upstream-denied', 'retry-exhausted'] as const)('retains the final failed partial answer on a new message: %s', async (mode) => {
    const replayed = await replay((requestNumber, continued) => {
      if (continued) return terminalSse('Completed after the retained partial.');
      const events: Array<readonly [string, unknown]> = [
        messageStart(`msg_partial_${requestNumber}`),
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `Partial attempt ${requestNumber}` } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ];
      if (mode === 'upstream-denied') events.push(['error', { type: 'error', error: {
        type: 'api_error', code: 'antigravity_missing_terminal', message: 'Upstream completed without a usable answer.', retryable: false,
      } }]);
      return sse(events);
    }, { maxAttempts: 2, modelAlias: argonModel });
    open.push(replayed);
    const completion = await (await replayed.local.get(IAgentPromptService).enqueue({
      message: { role: 'user', content: [{ type: 'text', text: 'Complete the task.' }], toolCalls: [] },
    })).completion;
    const finalAttempt = mode === 'upstream-denied' ? 1 : 2;
    const finalPartial = `Partial attempt ${finalAttempt}`;
    expect(completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(finalAttempt + 1);
    expect(replayed.retryEvents).toHaveLength(finalAttempt - 1);
    expect(continuations(replayed.local)).toHaveLength(1);
    const history = replayed.local.contextData().history;
    const continuationIndex = history.indexOf(continuations(replayed.local)[0]!);
    expect(history[continuationIndex - 1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: finalPartial }] });
    const wire = await replayed.local.persistedWireRecords();
    const contentParts = wire.filter((record) => record.type === 'context.append_loop_event')
      .map((record) => record['event'] as { type: string; part?: { text?: string } })
      .filter((event) => event.type === 'content.part');
    expect(contentParts.filter((event) => event.part?.text === finalPartial)).toHaveLength(1);
    if (finalAttempt === 2) expect(JSON.stringify(contentParts)).not.toContain('Partial attempt 1');
    expect(JSON.stringify(replayed.requests.at(-1)?.body)).toContain(finalPartial);
    if (finalAttempt === 2) {
      expect(JSON.stringify(replayed.requests[1]?.body)).not.toContain('Partial attempt 1');
      expect(JSON.stringify(replayed.requests[2]?.body)).not.toContain('Partial attempt 1');
      expect(JSON.stringify(history)).not.toContain('Partial attempt 1');
    }
    await replayed.local.expectResumeMatches();
  }, 60_000);

  it.each([argonModel, 'example-model'])('keeps native read retries first and limits exhausted continuation to Argon: %s', async (modelAlias) => {
    const partial = sse([messageStart('msg_disconnect')]);
    const replayed = await replay((_number, continued) => continued ? terminalSse('Continued after exhausted native retries.') : partial, { maxAttempts: 2, modelAlias });
    open.push(replayed);
    const argon = modelAlias === argonModel;
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: argon ? 'completed' : 'failed' });
    expect(replayed.requests).toHaveLength(argon ? 3 : 2);
    expect(replayed.retryEvents).toHaveLength(1);
    expect(continuations(replayed.local)).toHaveLength(argon ? 1 : 0);
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

  it('appends a new user message for the Argon gateway terminal event without retrying the original request', async () => {
    const replayed = await replay((_requestNumber, continued) => continued ? terminalSse('Completed after continuation.') : gatewayTerminalWire, { modelAlias: argonModel });
    open.push(replayed);
    const spawn = HostProcessService.prototype.spawn;
    const inputs: Array<MockInstance<Awaited<ReturnType<typeof spawn>>['stdin']['end']>> = [];
    const spy = vi.spyOn(HostProcessService.prototype, 'spawn').mockImplementation(async function (this: HostProcessService, command, args, options) {
      const child = await spawn.call(this, command, args, options);
      if (command === 'node ./scripts/recover.mjs') inputs.push(vi.spyOn(child.stdin, 'end'));
      return child;
    });
    try {
      expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'completed' });
    } finally {
      spy.mockRestore();
    }
    expect(replayed.responseBodies[0]?.toString()).toBe(gatewayTerminalWire);
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(JSON.stringify(replayed.requests[1]?.body).split('继续')).toHaveLength(2);
    const details = { errorSource: 'provider_event', upstreamErrorCode: gatewayTerminalError.code, upstreamErrorType: 'upstream_error', upstreamStatus: 502, retry: false, requestId: null, traceId: null };
    const input = stops(replayed)[0]?.[1]?.inputData;
    expect(input).toMatchObject({ modelAlias: argonModel, recoverable: true, recoveryAttempts: 0, errorDetails: details });
    expect(input?.['errorDetails']).not.toHaveProperty('upstream_retryable');
    expect(inputs).toHaveLength(1);
    const stdin = inputs[0]?.mock.calls[0]?.[0];
    expect(JSON.parse(String(stdin))).toMatchObject({ hook_event_name: 'StopFailure', model_alias: argonModel, recoverable: true, recovery_attempts: 0, upstream_error_code: gatewayTerminalError.code, error_details: details });
    expect(await stopResults(replayed)).toMatchObject([[{ exitCode: 0, recovery: { action: 'continue', userMessage: '继续' } }]]);
  }, 60_000);

  it('continues an Argon HTTP 502 that names the gateway terminal code without resending that request', async () => {
    const body = { type: 'error', error: gatewayTerminalError };
    const replayed = await replay((_requestNumber, continued) => continued
      ? terminalSse('Completed after the HTTP gateway terminal.')
      : jsonResponse(502, 'Bad Gateway', body), { modelAlias: argonModel });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(JSON.stringify(replayed.requests[1]?.body).split('继续')).toHaveLength(2);
    expect(stops(replayed)[0]?.[1]?.inputData).toMatchObject({
      modelAlias: argonModel,
      recoverable: true,
      recoveryAttempts: 0,
      upstreamErrorCode: gatewayTerminalError.code,
      errorDetails: { errorSource: 'provider_http', statusCode: 502, retry: false },
    });
  }, 60_000);

  it('still retries an ordinary HTTP 502 that does not name a terminal code', async () => {
    const failure = jsonResponse(502, 'Bad Gateway', { type: 'error', error: { type: 'api_error', message: 'temporary' } });
    const replayed = await replay((requestNumber) => requestNumber === 1 ? failure : terminalSse('Recovered ordinary HTTP failure'), { maxAttempts: 2, modelAlias: argonModel });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'completed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(1);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)).toEqual([]);
  }, 60_000);

  it('stops after one new message on a repeated gateway failure and retains the final partial', async () => {
    const replayed = await replay((number) => sse([
      messageStart(`msg_gateway_${number}`), ...textBlock(`Partial answer ${number}`), gatewayTerminalEvent,
    ]), { modelAlias: argonModel });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(2);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toHaveLength(1);
    expect(JSON.stringify(replayed.requests[1]?.body)).toContain('Partial answer 1');
    expect(stops(replayed).map(([, args]) => args?.inputData?.['recoveryAttempts'])).toEqual([0, 1]);
    expect(await stopResults(replayed)).toMatchObject([[{ exitCode: 0, recovery: { action: 'continue', userMessage: '继续' } }], [{ exitCode: 0, stdout: '' }]]);
    const wire = await replayed.local.persistedWireRecords();
    expect(wire.filter((record) => record.type === 'context.append_message' && JSON.stringify(record).includes('failure_recovery_hook'))).toHaveLength(1);
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter('main');
    for (const record of wire) reducer.apply(adapter.add(record));
    reducer.apply(adapter.finish());
    const frames = transcript.snapshot().items.flatMap((item) => item.kind === 'turn' ? item.steps.flatMap((step) => step.frames) : []);
    expect(frames.filter((frame) => frame.kind === 'text' && frame.role === 'user' && frame.text === '继续')).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === 'text' && frame.role === 'assistant' && frame.text === 'Partial answer 2')).toHaveLength(1);
    await replayed.local.expectResumeMatches();
  }, 60_000);

  it.each([
    { name: 'another model', modelAlias: 'example-model', retryable: true, pluginEnabled: true, status: 502, recoverable: true },
    { name: 'disabled plugin', modelAlias: argonModel, retryable: false, pluginEnabled: false, status: 502, recoverable: true },
    { name: 'billing rejection', modelAlias: argonModel, retryable: undefined, pluginEnabled: true, status: 402, recoverable: false },
  ])('stops without continuing the same gateway code for $name', async ({ modelAlias, retryable, pluginEnabled, status, recoverable }) => {
    const replayed = await replay(() => errorSse({ ...gatewayTerminalError, status, retryable }), { modelAlias, pluginEnabled });
    open.push(replayed);
    expect(await (await prompt(replayed)).completion).toMatchObject({ state: 'failed' });
    expect(replayed.requests).toHaveLength(1);
    expect(replayed.retryEvents).toHaveLength(0);
    expect(continuations(replayed.local)).toEqual([]);
    expect(stops(replayed)[0]?.[1]?.inputData).toMatchObject({
      modelAlias, recoverable, upstreamErrorCode: gatewayTerminalError.code,
      errorDetails: { retry: false, upstreamStatus: status },
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

describe('argon-tool-result-appendix projection through real AnthropicChatProvider serialization', () => {
  interface AppendixHarness {
    readonly home: string;
    readonly local: TestAgentContext;
    readonly requests: Array<{ readonly url: string | undefined; readonly body: Record<string, unknown> }>;
    sendWithHistory(history: readonly ContextMessage[], modelAlias?: string): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }

  const openHarnesses: AppendixHarness[] = [];
  afterEach(async () => {
    const pending = openHarnesses.splice(0);
    await Promise.all(pending.map(async (item) => item.close()));
  });

  async function createAppendixHarness(options: {
    readonly installPlugin?: boolean;
    readonly pluginEnabled?: boolean;
    readonly defaultEnabled?: boolean;
    readonly pluginSettings?: Record<string, unknown>;
  } = {}): Promise<AppendixHarness> {
    const home = await mkdtemp(join(tmpdir(), 'argon-appendix-serialization-'));
    const requests: AppendixHarness['requests'] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = (raw.length === 0 ? {} : JSON.parse(raw)) as Record<string, unknown>;
        requests.push({ url: req.url, body });
        writeSse(res, terminalSse('ok'));
      })().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No loopback port');
    const origin = `http://127.0.0.1:${address.port}`;

    if (options.installPlugin !== false) {
      await writeInstalled(home, {
        version: 1,
        plugins: [
          {
            id: 'argon-tool-result-appendix',
            root: appendixPluginRoot,
            source: 'local-path',
            enabled: options.pluginEnabled ?? true,
            defaultEnabled: options.defaultEnabled ?? true,
            installedAt: '2026-11-08T00:00:00.000Z',
          },
        ],
      });
    }

    class DynamicAnthropicRegistry extends ProtocolAdapterRegistry {
      override createChatProvider(): ChatProvider {
        return new AnthropicChatProvider({
          model: 'example-model',
          apiKey: 'YOUR_API_KEY',
          baseUrl: origin,
        });
      }
    }

    const local = createTestAgent(
      homeDirServices(home),
      permissionModeServices('yolo'),
      appService(IProtocolAdapterRegistry, new DynamicAnthropicRegistry()),
      {
        initialConfig: {
          [PLUGIN_SETTINGS_SECTION]: options.pluginSettings === undefined
            ? {}
            : { 'argon-tool-result-appendix': options.pluginSettings },
        },
      },
    );
    await local.get(IPluginService).reloadPlugins();

    return {
      home,
      local,
      requests,
      async sendWithHistory(history: readonly ContextMessage[], modelAlias = argonModel): Promise<Record<string, unknown>> {
        local.configure({
          provider: {
            type: 'anthropic',
            model: modelAlias,
            apiKey: 'YOUR_API_KEY',
            baseUrl: origin,
          },
          modelCapabilities: {
            image_in: true,
            video_in: true,
            audio_in: false,
            thinking: true,
            tool_use: true,
            max_context_tokens: 200_000,
          },
        });
        const before = requests.length;
        await local.get(IAgentLLMRequesterService).request({
          messages: [...history],
          systemPrompt: 'System prompt for serialization test.',
        });
        expect(requests.length).toBe(before + 1);
        return requests[before]!.body;
      },
      async close() {
        await local.dispose();
        await server[Symbol.asyncDispose]();
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      },
    };
  }

  function buildAssistantToolUse(toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments?: string }>): ContextMessage {
    return {
      role: 'assistant',
      content: [
        { type: 'think', think: 'checking workspace state', encrypted: 'sig_argon_123' },
        { type: 'text', text: 'Running tools.' },
      ],
      toolCalls: toolCalls.map((call) => ({
        type: 'function',
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? '{}',
      })),
    };
  }

  it('keeps non-target models, disabled plugin, passthrough setting, and workspace/session disabled scopes byte-for-byte identical to baseline while packing appendix for Argon', async () => {
    const history: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Inspect files.' }], toolCalls: [], origin: { kind: 'user' } },
      buildAssistantToolUse([{ id: 'toolu_1', name: 'ReadFile' }]),
      { role: 'tool', content: [{ type: 'text', text: 'file contents A' }], toolCalls: [], toolCallId: 'toolu_1' },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nAGENTS.md loaded\n</system-reminder>' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'agents_md' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nTools updated\n</system-reminder>' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'capability_delta' },
      },
    ];

    const baselineHarness = await createAppendixHarness({ installPlugin: false });
    openHarnesses.push(baselineHarness);
    const baselineArgonBody = await baselineHarness.sendWithHistory(history, argonModel);
    const baselineOtherGeminiBody = await baselineHarness.sendWithHistory(history, 'axon-message/gemini-3.8-flash');

    const baselineMessages = baselineArgonBody['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(baselineMessages).toHaveLength(3);
    expect(baselineMessages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: 'file contents A' }],
      },
      {
        type: 'text',
        text: '<system-reminder>\nAGENTS.md loaded\n</system-reminder>',
      },
      {
        type: 'text',
        text: '<system-reminder>\nTools updated\n</system-reminder>',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const activeHarness = await createAppendixHarness({ installPlugin: true });
    openHarnesses.push(activeHarness);
    const historySnapshot = structuredClone(history);
    const projectedArgonBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(history).toEqual(historySnapshot);

    expect(projectedArgonBody['system']).toEqual(baselineArgonBody['system']);
    const projectedMessages = projectedArgonBody['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(projectedMessages).toHaveLength(3);
    expect(projectedMessages[0]).toEqual(baselineMessages[0]);
    expect(projectedMessages[1]).toEqual(baselineMessages[1]);
    expect(projectedMessages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'file contents A' },
          {
            type: 'text',
            text: '<tool-result-appendix>\n<system-reminder>\nAGENTS.md loaded\n</system-reminder>\n\n<system-reminder>\nTools updated\n</system-reminder>\n</tool-result-appendix>',
          },
        ],
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const repeatedArgonBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(repeatedArgonBody).toEqual(projectedArgonBody);

    const otherGeminiBody = await activeHarness.sendWithHistory(history, 'axon-message/gemini-3.8-flash');
    expect(otherGeminiBody).toEqual(baselineOtherGeminiBody);

    const pluginService = activeHarness.local.get(IPluginService);
    const metrics = pluginService.requestProjectionMetrics('argon-tool-result-appendix');
    expect(metrics).toEqual({
      evaluatedRequests: 3,
      matchedRequests: 2,
      passthroughRequests: 1,
      projectedRequests: 2,
      projectedBatches: 2,
      projectedMessages: 4,
    });
    expect(Object.keys(metrics).toSorted()).toEqual([
      'evaluatedRequests',
      'matchedRequests',
      'passthroughRequests',
      'projectedBatches',
      'projectedMessages',
      'projectedRequests',
    ]);
    expect(JSON.stringify(metrics)).not.toContain('file contents A');
    expect(JSON.stringify(metrics)).not.toContain('YOUR_API_KEY');
    expect(JSON.stringify(metrics)).not.toContain(activeHarness.home);

    await activeHarness.local.get(ISessionPluginUsageService).set('argon-tool-result-appendix', 'off');
    const sessionDisabledBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(sessionDisabledBody).toEqual(baselineArgonBody);

    await activeHarness.local.get(ISessionPluginUsageService).set('argon-tool-result-appendix', 'inherit');
    const workspaceId = activeHarness.local.get(ISessionContext).workspaceId;
    await activeHarness.local.get(IPluginUsageService).set({
      workspaceId,
      pluginId: 'argon-tool-result-appendix',
      override: 'off',
    });
    const workspaceDisabledBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(workspaceDisabledBody).toEqual(baselineArgonBody);

    await activeHarness.local.get(IPluginUsageService).set({
      workspaceId,
      pluginId: 'argon-tool-result-appendix',
      override: 'on',
    });
    const workspaceReenabledBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(workspaceReenabledBody).toEqual(projectedArgonBody);

    await pluginService.setPluginEnabled({ id: 'argon-tool-result-appendix', enabled: false });
    const globalDisabledBody = await activeHarness.sendWithHistory(history, argonModel);
    expect(globalDisabledBody).toEqual(baselineArgonBody);

    const passthroughHarness = await createAppendixHarness({
      installPlugin: true,
      pluginSettings: { strategy: 'passthrough', targetModels: argonModel },
    });
    openHarnesses.push(passthroughHarness);
    const passthroughBody = await passthroughHarness.sendWithHistory(history, argonModel);
    expect(passthroughBody).toEqual(baselineArgonBody);
  }, 60_000);

  it('covers tool_result only, multi-tool with media, real human user follow-up, failure recovery continuation, compaction summary, and undo idempotence', async () => {
    const harness = await createAppendixHarness({ installPlugin: true });
    openHarnesses.push(harness);

    const toolOnlyHistory: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Just run one tool.' }], toolCalls: [], origin: { kind: 'user' } },
      buildAssistantToolUse([{ id: 'toolu_only', name: 'ReadFile' }]),
      { role: 'tool', content: [{ type: 'text', text: 'raw tool output' }], toolCalls: [], toolCallId: 'toolu_only' },
    ];
    const toolOnlyBody = await harness.sendWithHistory(toolOnlyHistory, argonModel);
    const toolOnlyMessages = toolOnlyBody['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(toolOnlyMessages[1]?.content).toEqual([
      {
        type: 'thinking',
        thinking: 'checking workspace state',
        signature: 'sig_argon_123',
      },
      {
        type: 'text',
        text: 'Running tools.',
      },
      {
        type: 'tool_use',
        id: 'toolu_only',
        name: 'ReadFile',
        input: {},
      },
    ]);
    expect(toolOnlyMessages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_only',
        content: [{ type: 'text', text: 'raw tool output' }],
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const multiMediaAndHumanHistory: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Run two tools.' }], toolCalls: [], origin: { kind: 'user' } },
      buildAssistantToolUse([
        { id: 'toolu_img', name: 'ReadMediaFile' },
        { id: 'toolu_txt', name: 'ReadFile' },
      ]),
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'image header' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } },
        ],
        toolCalls: [],
        toolCallId: 'toolu_img',
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'second tool verbatim' }],
        toolCalls: [],
        toolCallId: 'toolu_txt',
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nRuntime snapshot\n</system-reminder>' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'runtime_snapshot' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Real human instruction after tool.' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    ];
    const multiMediaBody = await harness.sendWithHistory(multiMediaAndHumanHistory, argonModel);
    const multiMediaMessages = multiMediaBody['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(multiMediaMessages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_img',
        content: [
          { type: 'text', text: 'image header' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          },
        ],
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_txt',
        content: [
          { type: 'text', text: 'second tool verbatim' },
          {
            type: 'text',
            text: '<tool-result-appendix>\n<system-reminder>\nRuntime snapshot\n</system-reminder>\n</tool-result-appendix>',
          },
        ],
      },
      {
        type: 'text',
        text: 'Real human instruction after tool.',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const continuationHistory: readonly ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Start.' }], toolCalls: [], origin: { kind: 'user' } },
      buildAssistantToolUse([{ id: 'toolu_cont', name: 'ReadFile' }]),
      { role: 'tool', content: [{ type: 'text', text: 'tool before failure' }], toolCalls: [], toolCallId: 'toolu_cont' },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nMemory authority\n</system-reminder>' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'memory_authority' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '继续' }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'failure_recovery_hook' },
      },
    ];
    const continuationBody = await harness.sendWithHistory(continuationHistory, argonModel);
    const continuationMessages = continuationBody['messages'] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(continuationMessages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_cont',
        content: [
          { type: 'text', text: 'tool before failure' },
          {
            type: 'text',
            text: '<tool-result-appendix>\n<system-reminder>\nMemory authority\n</system-reminder>\n</tool-result-appendix>',
          },
        ],
      },
      {
        type: 'text',
        text: '继续',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    const memory = harness.local.get(IAgentContextMemoryService);
    memory.append({
      role: 'user',
      content: [{ type: 'text', text: 'Summary of earlier work' }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    });
    memory.append(buildAssistantToolUse([{ id: 'toolu_after_compact', name: 'ReadFile' }]));
    memory.append({
      role: 'tool',
      content: [{ type: 'text', text: 'post-compaction tool output' }],
      toolCalls: [],
      toolCallId: 'toolu_after_compact',
    });
    memory.append({
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder>\nPlan mode active\n</system-reminder>' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'plan_mode' },
    });
    const canonicalBefore = structuredClone(memory.get());
    const afterCompactBody1 = await harness.sendWithHistory(memory.get(), argonModel);
    const afterCompactBody2 = await harness.sendWithHistory(memory.get(), argonModel);
    expect(afterCompactBody1).toEqual(afterCompactBody2);
    expect(memory.get()).toEqual(canonicalBefore);

    memory.append({
      role: 'user',
      content: [{ type: 'text', text: 'Turn to be undone' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    memory.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'Reply to be undone' }],
      toolCalls: [],
    });
    await harness.local.get(IAgentConversationUndoService).undo(1);
    expect(memory.get()).toEqual(canonicalBefore);
    const afterUndoBody = await harness.sendWithHistory(memory.get(), argonModel);
    expect(afterUndoBody).toEqual(afterCompactBody1);
  }, 60_000);
});

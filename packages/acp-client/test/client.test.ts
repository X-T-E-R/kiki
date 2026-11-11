import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { RequestError, type InitializeResponse, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import {
  antigravityClientName, antigravityClientFileReads, antigravityCliSessionMode,
  antigravitySessionMeta, antigravitySupportsSystemPromptAppend, legacyAntigravityModelFamily,
  extractAntigravityUserInputQuestion, resolveAntigravityUserInputOptionId,
  sanitizeAntigravityToolPayload, normalizeAntigravitySessionUpdate, makeAntigravityReadRepair,
  isCopilotLostSessionError,
} from '../src/antigravity';
import { extractDroidElicitationForm, normalizeDevinSessionUpdate, extractClaudeSubagentUpdate, extractClaudeSubagentSessionEvent } from '../src/flavors';
import { GrokAcpInputMerger } from '../src/events';
import { AsyncQueue } from '../src/async-queue';
import { AcpProcessClient } from '../src/client';
import type { HostProcessLike, HostProcessServiceLike } from '../src/types';

function malformedEofProcess(dispose: ReturnType<typeof vi.fn<() => void>>): HostProcessLike {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  setImmediate(() => {
    stdout.write('{not-valid-json');
    stdout.end();
    exitCode = 0;
    resolveExit(0);
  });
  return {
    pid: 1,
    get exitCode() {
      return exitCode;
    },
    stdin,
    stdout,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose,
  };
}

function burstProcess(
  dispose: ReturnType<typeof vi.fn<() => void>>,
  count: number,
  endAfterResponse = false,
  beforeOpen?: (stdout: PassThrough) => void,
): HostProcessLike {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const writeResponse = (id: number, result: unknown): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const raw = input.slice(0, newline);
        input = input.slice(newline + 1);
        const request = JSON.parse(raw) as { id?: number; method?: string; params?: { sessionId?: string } };
        if (request.id !== undefined && request.method === 'initialize') {
          writeResponse(request.id, { protocolVersion: 1, agentCapabilities: {} });
        } else if (request.id !== undefined && request.method === 'session/new') {
          beforeOpen?.(stdout);
          writeResponse(request.id, { sessionId: 'session-burst', configOptions: [] });
        } else if (request.id !== undefined && request.method === 'session/prompt') {
          for (let index = 0; index < count; index += 1) {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: request.params?.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(index) } },
              },
            })}\n`);
          }
          writeResponse(request.id, { stopReason: 'end_turn' });
          if (endAfterResponse) {
            stdout.end();
            exitCode = 0;
            resolveExit(0);
          }
        }
        newline = input.indexOf('\n');
      }
      callback();
    },
  });
  return {
    pid: 1,
    get exitCode() {
      return exitCode;
    },
    stdin,
    stdout,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose,
  };
}

function validOversizedProcess(dispose: ReturnType<typeof vi.fn<() => void>>): HostProcessLike {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const writeResponse = (id: number, result: unknown, segmented: boolean): void => {
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8');
    if (!segmented) {
      stdout.write(frame);
      return;
    }
    const utf8Marker = Buffer.from('😀', 'utf8');
    const marker = frame.indexOf(utf8Marker);
    if (marker < 0) throw new Error('segmented frame marker missing');
    stdout.write(frame.subarray(0, marker + 1));
    stdout.write(frame.subarray(marker + 1, frame.length - 1));
    stdout.write(frame.subarray(frame.length - 1));
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const raw = input.slice(0, newline);
        input = input.slice(newline + 1);
        const request = JSON.parse(raw) as { id?: number; method?: string };
        if (request.id === undefined) {
          newline = input.indexOf('\n');
          continue;
        }
        const result = request.method === 'initialize'
          ? { protocolVersion: 1, agentCapabilities: {}, _meta: { padding: `${'x'.repeat(1024 * 1024)}😀` } }
          : { sessionId: 'session-1', configOptions: [] };
        writeResponse(request.id, result, request.method === 'initialize');
        newline = input.indexOf('\n');
      }
      callback();
    },
  });
  return {
    pid: 1,
    get exitCode() {
      return exitCode;
    },
    stdin,
    stdout,
    stderr,
    wait: () => wait,
    kill: async () => {
      if (exitCode === null) {
        exitCode = 0;
        resolveExit(0);
      }
    },
    dispose,
  };
}

describe('AcpProcessClient limits and observers', () => {
  it.each(['reject', 'cancel', 'disconnect'] as const)('sends no prompt when actual-session preparation ends in %s', async outcome => {
    const child = burstProcess(vi.fn(), 0);
    const writes = vi.spyOn(child.stdin, 'write');
    const client = new AcpProcessClient({ spawn: async () => child }, { id: 'fixture', command: 'fixture' }, { platform: 'linux' });
    const controller = new AbortController();
    const prepareSession = vi.fn(async (session: { sessionId: string }) => {
      expect(session.sessionId).toBe('session-burst');
      if (outcome === 'reject') throw new Error('fixture controls unverifiable');
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'disconnect') await child.kill();
    });
    const onDeliveryAttempt = vi.fn();
    try {
      await expect(client.startTurn({ prompt: 'work', signal: controller.signal, session: { cwd: '/example' }, prepareSession, onDeliveryAttempt })).rejects.toThrow();
      expect(prepareSession).toHaveBeenCalledOnce();
      expect(onDeliveryAttempt).not.toHaveBeenCalled();
      const methods = writes.mock.calls.map(([chunk]) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).join('').trim().split('\n')
        .map(line => (JSON.parse(line) as { method?: string }).method);
      expect(methods).not.toContain('session/prompt');
      expect(methods.filter(method => method === 'session/new')).toHaveLength(1);
    } finally { await client.shutdown(); }
  });

  it('neg-v2-diff-not-delivered: rejects protocol 2 at initialize before opening a session', async () => {
    const methods: string[] = [];
    const client = new AcpProcessClient({ spawn: async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let resolveExit!: (value: number) => void;
      const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
      let buffer = '';
      stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end === -1) break;
          const request = JSON.parse(buffer.slice(0, end)) as { id?: number; method: string };
          buffer = buffer.slice(end + 1);
          methods.push(request.method);
          if (request.method === 'initialize') stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 2, agentCapabilities: {} } }) + '\n');
        }
      });
      return { stdin, stdout, stderr, pid: 1, exitCode: null, wait: () => exit,
        kill: async () => { resolveExit(0); }, dispose: () => {} };
    } }, { id: 'fixture', command: 'fixture' }, { platform: 'linux', logger: { error: () => {} } });
    try {
      await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow(/unsupported protocol version 2/);
      expect(methods.length).toBeGreaterThan(0);
      expect(methods.every((method) => method === 'initialize')).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  it('bounds and clears event queue backlog on failure', async () => {
    const queue = new AsyncQueue<number>(1);
    queue.push(1);
    expect(() => queue.push(2)).toThrow(/backlog limit/);
    queue.fail(new Error('protocol failure'));
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow('protocol failure');
  });

  it('isolates state observer failures during startup and shutdown', async () => {
    const logger = { error: vi.fn() };
    const spawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const client = new AcpProcessClient(
      { spawn } as HostProcessServiceLike,
      { id: 'fixture', command: 'fixture' },
      {
        onStateChange: () => {
          throw new Error('observer failed');
        },
        logger,
      },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(client.status().state).toBe('broken');
    await client.shutdown();
    expect(client.status().state).toBe('closed');
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([5_000, undefined] as const)('closes stdin before platform termination only when an EOF grace is configured (%s)', async (stdinCloseGraceMs) => {
    const { child, toAgent, fromAgent } = (() => {
      const toAgent = new PassThrough();
      const fromAgent = new PassThrough();
      let exitCode: number | null = null;
      let resolveExit!: (code: number) => void;
      const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
      const finish = () => { if (exitCode === null) { exitCode = 0; resolveExit(0); } };
      toAgent.on('finish', () => setTimeout(finish, 10));
      const child = { pid: 7, get exitCode() { return exitCode; }, stdin: toAgent, stdout: fromAgent, stderr: new PassThrough(),
        wait: () => exit, kill: vi.fn(async () => finish()), dispose: () => {} } satisfies HostProcessLike;
      return { child, toAgent, fromAgent };
    })();
    let buffer = '';
    toAgent.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end === -1) break;
        const request = JSON.parse(buffer.slice(0, end)) as { id?: number; method: string };
        buffer = buffer.slice(end + 1);
        if (request.method === 'initialize') fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\n');
        if (request.method === 'session/new') fromAgent.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-1' } }) + '\n');
      }
    });
    const client = new AcpProcessClient({ spawn: async () => child }, { id: 'fixture', command: 'fixture', shutdownGraceMs: 20, stdinCloseGraceMs },
      { platform: 'linux' });
    await client.openSession({ cwd: 'C:/workspace' });
    await client.shutdown();
    expect(toAgent.writableEnded).toBe(stdinCloseGraceMs !== undefined);
    expect(child.kill).toHaveBeenCalledTimes(stdinCloseGraceMs === undefined ? 1 : 0);
  });

  it('fails startup when EOF ends an unterminated malformed frame', async () => {
    const dispose = vi.fn<() => void>();
    const client = new AcpProcessClient(
      { spawn: async () => malformedEofProcess(dispose) },
      { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
      { platform: 'linux' },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow(/malformed|ended|protocol/i);
    expect(client.status().state).toBe('broken');
  });

  it('accepts a valid frame slightly over the retired 1 MiB frame guard', async () => {
    const client = new AcpProcessClient(
      {
        spawn: async () => validOversizedProcess(vi.fn<() => void>()),
      },
      { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
      { platform: 'linux' },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).resolves.toMatchObject({
      sessionId: 'session-1',
      mode: 'new',
    });
    await client.shutdown();
  });

  it('streams a delayed 1025-update ACP burst in order without terminating the process', async () => {
    const dispose = vi.fn<() => void>();
    const processService: HostProcessServiceLike = {
      spawn: async () => burstProcess(dispose, 1025),
    };
    const client = new AcpProcessClient(
      processService,
      { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
      { platform: 'linux' },
    );
    const onDeliveryAttempt = vi.fn();
    const handle = await client.startTurn({
      prompt: 'go',
      signal: new AbortController().signal,
      session: { cwd: 'C:/workspace' },
      onDeliveryAttempt,
    });
    expect(onDeliveryAttempt).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const events: string[] = [];
    for await (const event of handle.events) {
      if (event.type === 'message.delta' && event.content.type === 'text') events.push(event.content.text);
    }
    await expect(handle.completion).resolves.toMatchObject({ response: { stopReason: 'end_turn' } });
    expect(events).toEqual(Array.from({ length: 1025 }, (_, index) => String(index)));
    expect(client.status().state).toBe('ready');
    expect(dispose).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('drains a terminal burst before a clean child EOF', async () => {
    const dispose = vi.fn<() => void>();
    const client = new AcpProcessClient(
      { spawn: async () => burstProcess(dispose, 1025, true) },
      { id: 'fixture', command: 'fixture', startupTimeoutMs: 5_000 },
      { platform: 'linux' },
    );
    const handle = await client.startTurn({
      prompt: 'go',
      signal: new AbortController().signal,
      session: { cwd: 'C:/workspace' },
    });
    const events: string[] = [];
    for await (const event of handle.events) {
      if (event.type === 'message.delta' && event.content.type === 'text') events.push(event.content.text);
    }
    await expect(handle.completion).resolves.toMatchObject({ response: { stopReason: 'end_turn' } });
    expect(events).toEqual(Array.from({ length: 1025 }, (_, index) => String(index)));
    await client.shutdown();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('cancels a paused burst without waiting for its delayed consumer', async () => {
    const dispose = vi.fn<() => void>();
    const client = new AcpProcessClient(
      { spawn: async () => burstProcess(dispose, 1025) },
      {
        id: 'fixture',
        command: 'fixture',
        startupTimeoutMs: 5_000,
        cancelGraceMs: 20,
        shutdownGraceMs: 20,
      },
      { platform: 'linux' },
    );
    const handle = await client.startTurn({
      prompt: 'go',
      signal: new AbortController().signal,
      session: { cwd: 'C:/workspace' },
    });
    await expect(client.cancel(new Error('test cancel'))).resolves.toBe(true);
    await expect(handle.completion).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([[undefined], [['HTTP_PROXY', 'HTTPS_PROXY']]] as const)('spawns with the caller environment and unset list %j', async (envUnset) => {
    const calls: Array<{ command: string; options: Record<string, unknown> | undefined }> = [];
    const client = new AcpProcessClient(
      {
        spawn: async (command: string, _args?: readonly string[], options?: Record<string, unknown>) => {
          calls.push({ command, options });
          throw new Error('spawn refused');
        },
      } as unknown as HostProcessServiceLike,
      { id: 'claude-acp', command: 'node', args: ['agent.js'], envUnset },
      { logger: { error: () => {} } },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow();

    expect(calls[0]?.command).toBe('node');
    expect(calls[0]?.options).toMatchObject({ shell: false, windowsHide: true });
    expect(calls[0]?.options?.['envUnset']).toBe(envUnset);
    expect(calls[0]?.options?.['env']).toBeUndefined();
    expect(calls[0]?.options?.['cwd']).toBeUndefined();
  });
});


describe('Grok session MCP readiness', () => {
  const mcpServers = [{ name: 'fixture', command: 'node', args: [], env: [] }];
  const notify = (stdout: PassThrough, method: string, params: unknown): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };
  const setup = (stdout: PassThrough): void => notify(stdout, '_x.ai/session/setup', { method: 'session/new', phase: 'mcp_merge', sessionId: null });

  it.each(['grok-acp', 'instance-work'])('holds %s until its source engine reports MCP initialized', async (id) => {
    const beforeOpen = vi.fn(setup);
    const child = burstProcess(vi.fn(), 0, false, beforeOpen);
    const client = new AcpProcessClient({ spawn: async () => child }, { id, sourceId: 'grok-acp', command: 'fixture', shutdownGraceMs: 20 }, { platform: 'linux' });
    let opened = false;
    const options = { cwd: '/workspace', mcpServers };
    const opening = client.openSession(options).then((result) => { opened = true; return result; });
    try {
      await vi.waitFor(() => expect(beforeOpen).toHaveBeenCalledOnce());
      expect(opened).toBe(false);
      notify(child.stdout as PassThrough, '_x.ai/mcp_initialized', { sessionId: 'another-session', mcpToolCount: 1 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(opened).toBe(false);
      notify(child.stdout as PassThrough, '_x.ai/mcp_initialized', { sessionId: 'session-burst', mcpToolCount: 1 });
      expect((await opening).sessionRef.executorId).toBe(id);
      const turn = await client.startTurn({ session: options, signal: new AbortController().signal, prompt: 'Use the connected fixture' });
      expect((await turn.completion).response.stopReason).toBe('end_turn');
    } finally { await client.shutdown(); }
  });

  it('retains readiness that arrived before the session response', async () => {
    const child = burstProcess(vi.fn(), 0, false, (stdout) => {
      setup(stdout);
      notify(stdout, '_x.ai/mcp_initialized', { sessionId: 'session-burst', mcpToolCount: 1 });
    });
    const client = new AcpProcessClient({ spawn: async () => child }, { id: 'grok-acp', command: 'fixture', shutdownGraceMs: 20 }, { platform: 'linux' });
    try { expect((await client.openSession({ cwd: '/workspace', mcpServers })).sessionId).toBe('session-burst'); }
    finally { await client.shutdown(); }
  });

  it.each(['no-vendor-event', 'no-requested-servers', 'other-engine'])('preserves %s startup without an MCP-ready event', async (condition) => {
    const child = burstProcess(vi.fn(), 0, false, condition === 'no-vendor-event' ? undefined : setup);
    const client = new AcpProcessClient({ spawn: async () => child }, { id: condition === 'other-engine' ? 'fixture' : 'grok-acp', command: 'fixture', shutdownGraceMs: 20 }, { platform: 'linux' });
    try {
      expect((await client.openSession({ cwd: '/workspace', mcpServers: condition === 'no-requested-servers' ? [] : mcpServers })).sessionId).toBe('session-burst');
    } finally { await client.shutdown(); }
  });

  it.each(['cancel', 'timeout'])('bounds the MCP-ready wait by startup %s', async (condition) => {
    const beforeOpen = vi.fn(setup);
    const child = burstProcess(vi.fn(), 0, false, beforeOpen);
    const client = new AcpProcessClient({ spawn: async () => child }, { id: 'grok-acp', command: 'fixture', startupTimeoutMs: condition === 'timeout' ? 100 : 5000, shutdownGraceMs: 20 }, { platform: 'linux' });
    const controller = new AbortController();
    const opening = client.openSession({ cwd: '/workspace', mcpServers, signal: controller.signal });
    const rejected = expect(opening).rejects.toMatchObject({ code: condition === 'cancel' ? 'executor.cancelled' : 'executor.startup_timeout' });
    try {
      if (condition === 'cancel') { await vi.waitFor(() => expect(beforeOpen).toHaveBeenCalledOnce()); controller.abort(); }
      await rejected;
    } finally { await client.shutdown(); }
  });
});


describe('Antigravity compatibility', () => {
  const initialize = (version: string, append = false): InitializeResponse => ({
    protocolVersion: 1, agentInfo: { name: 'Antigravity', version }, agentCapabilities: {},
    _meta: { antigravity: { systemPrompt: { append } } },
  });

  it.each([
    ['1.4.2', 'zed', true], ['1.4.5', 'zed', false], ['1.5.0', 'zed', true], ['1.5.5', 'kiki', false],
  ] as const)('uses the %s model-visibility and native-read contract', (version, name, reads) => {
    expect(antigravityClientName(version, 'kiki')).toBe(name);
    expect(antigravityClientFileReads(version)).toBe(reads);
  });

  it.each(['1.4.2', '1.4.3', '1.4.4', '1.4.5'])('disables run_workflow only in affected %s runtimes', (version) => {
    const meta = antigravitySessionMeta(initialize(version), { trace: 'keep', antigravity: { disabledTools: ['custom', 'run_workflow'] } });
    expect(meta).toEqual({ trace: 'keep', antigravity: { disabledTools: ['custom', 'run_workflow'] } });
  });

  it.each(['1.4.1', '1.4.6', '1.5.5'])('does not disable tools in %s', (version) => {
    const meta = { trace: 'keep' };
    expect(antigravitySessionMeta(initialize(version), meta)).toBe(meta);
  });

  it('appends the native system prompt without replacing caller metadata', () => {
    const meta = antigravitySessionMeta(initialize('1.4.5'), { trace: 'keep', antigravity: { systemPrompt: { other: true } } }, 'Profile');
    expect(meta).toEqual({ trace: 'keep', antigravity: { disabledTools: ['run_workflow'], systemPrompt: { other: true, append: 'Profile' } } });
    expect(antigravitySupportsSystemPromptAppend(initialize('1.5.5', true))).toBe(true);
    expect(antigravitySessionMeta(initialize('1.5.0'), undefined, 'Profile')).toBeUndefined();
  });

  it.each([['yolo', 'auto'], ['auto_edit', 'accept-edits'], ['default', 'default'], ['plan', 'plan']])('maps CLI %s to %s', (mode, expected) => {
    expect(antigravityCliSessionMode(mode)).toBe(expected);
  });

  it('resolves the longest legacy model family, not an unrelated prefix', () => {
    const options = [{ id: 'model', name: 'Model', type: 'select' as const, currentValue: 'claude', options: [
      { value: 'claude', name: 'Claude' }, { value: 'claude-opus', name: 'Opus' },
    ] }];
    expect(legacyAntigravityModelFamily(options, 'claude-opus-high')).toBe('claude-opus');
    expect(legacyAntigravityModelFamily(options, 'gemini-high')).toBeUndefined();
  });

  it('strips image blobs, duplicated output and leaked background system messages', () => {
    const output = 'visible<system_message>hidden</system_message>tail';
    const sanitized = sanitizeAntigravityToolPayload({ combinedOutput: output, formattedOutput: output,
      image: { type: 'image', data: 'x'.repeat(1_000_000), mimeType: 'image/png' },
      embedded: 'data:image/png;base64,AAA', text: 'z'.repeat(20_000) }) as Record<string, unknown>;
    expect(sanitized).toMatchObject({ combinedOutput: 'visibletail', image: { type: 'image', mimeType: 'image/png' } });
    expect(sanitized).not.toHaveProperty('formattedOutput');
    expect(sanitized).not.toHaveProperty('embedded');
    expect(String(sanitized['text'])).toHaveLength(8_000 + '[Earlier output truncated]\n\n'.length);
    const update = normalizeAntigravitySessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call', title: output, rawOutput: { image: { type: 'image', data: 'AAA' } } } });
    expect(update.update.title).toBe('visibletail');
    expect(update.update.rawOutput.image).not.toHaveProperty('data');
  });

  it.each([true, false])('repairs served reads regardless of request/notification order (early=%s)', (early) => {
    const repair = makeAntigravityReadRepair();
    const notification = { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Running client_view_file', rawInput: { absolute_path: '/example.txt' }, status: 'in_progress' } };
    if (early) repair.attempted('/example.txt', true);
    repair.repair(notification);
    if (!early) repair.attempted('/example.txt', true);
    expect(repair.repair(notification).update.status).toBe('completed');
    const failed = repair.repair({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'failed', rawOutput: 'stale native error' } });
    expect(failed.update.status).toBe('completed');
    expect(failed.update).not.toHaveProperty('rawOutput');
    repair.reset();
    expect(repair.repair(notification).update.status).toBe('in_progress');
    repair.attempted('/example.txt', false);
    expect(repair.repair(notification).update.status).toBe('in_progress');
  });

  it('routes interaction_* choices by option id or unique label and rejects ambiguous questions', () => {
    const request: RequestPermissionRequest = { sessionId: 's', toolCall: { toolCallId: 'interaction_1', title: 'Where next?' }, options: [
      { optionId: 'a', name: 'Alpha', kind: 'allow_once' }, { optionId: 'b', name: 'Beta', kind: 'allow_once' },
    ] };
    const question = extractAntigravityUserInputQuestion(request)!;
    expect(question).toMatchObject({ question: 'Where next?', options: [{ optionId: 'a', label: 'Alpha' }, { optionId: 'b', label: 'Beta' }] });
    expect(resolveAntigravityUserInputOptionId(question, 'Alpha')).toBe('a');
    expect(resolveAntigravityUserInputOptionId(question, 'b')).toBe('b');
    expect(resolveAntigravityUserInputOptionId(question, 'unknown')).toBeUndefined();
    expect(extractAntigravityUserInputQuestion({ ...request, toolCall: { toolCallId: 'tool-1' } })).toBeUndefined();
    expect(extractAntigravityUserInputQuestion({ ...request, options: [request.options[0]!, request.options[0]!] })).toBeUndefined();
  });
});

describe('ACP flavor normalization', () => {
  it('merges interleaved Grok argument fragments and waits for complete JSON', () => {
    const merger = new GrokAcpInputMerger();
    const vendor = '_x.ai/session_notification';
    const fragment = (index: number, id: string, delta: string) => ({ sessionId: 's', update: { sessionUpdate: 'tool_call_delta_chunk', tool_index: index, tool_call_id: id, arguments_delta: delta } });
    merger.normalize(fragment(0, 'a', '{"path":'), vendor);
    merger.normalize(fragment(1, 'b', '{"query":"b"}'), vendor);
    const done = { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' } };
    expect(merger.normalize(done, vendor)).toMatchObject({ update: { status: 'in_progress' } });
    expect(merger.normalize({ ...done, update: { ...done.update, toolCallId: 'b' } }, vendor)).toMatchObject({ update: { status: 'completed', rawInput: { query: 'b' } } });
    merger.normalize(fragment(0, 'a', '"file.txt"}'), vendor);
    expect(merger.normalize(done, vendor)).toMatchObject({ update: { status: 'completed', rawInput: { path: 'file.txt' } } });
    expect(merger.normalize(done, vendor)).toBe(done);
  });

  it('recognizes only Copilot internal lost-session errors', () => {
    expect(isCopilotLostSessionError(new RequestError(-32603, 'session event delivery failed: session not found: s'))).toBe(true);
    expect(isCopilotLostSessionError(new RequestError(-32603, 'Internal error', { details: 'session lock unavailable during is_session_generation_current: acquisition timed out' }))).toBe(true);
    expect(isCopilotLostSessionError(new RequestError(-32602, 'session event delivery failed: session not found: s'))).toBe(false);
  });

  it('restores Droid form option values and free-text *_other fields', () => {
    const request = { mode: 'form', requestedSchema: { type: 'object', required: ['question_1'], properties: {
      question_1: { type: 'string', title: 'Target', description: 'Choose target', oneOf: [{ const: 'option_1', title: 'Web' }, { const: 'other', title: 'Other' }] },
      question_1_other: { type: 'string' },
    } } };
    const form = extractDroidElicitationForm(request)!;
    expect(form.respond({ question_1: 'Web' })).toEqual({ action: 'accept', content: { question_1: 'option_1' } });
    expect(form.respond({ 'Choose target': 'Desktop' })).toEqual({ action: 'accept', content: { question_1: 'other', question_1_other: 'Desktop' } });
    expect(form.respond({})).toEqual({ action: 'cancel' });
    expect(extractDroidElicitationForm({ ...request, mode: 'url' })).toBeUndefined();
  });

  it('normalizes Devin subagent routing, message ids and tool titles', () => {
    expect(normalizeDevinSessionUpdate({ sessionId: 'root', update: { sessionUpdate: 'agent_message_chunk', _meta: {
      'cognition.ai/subagent_context': { parentAgentId: 'child' }, 'cognition.ai/streamingMessageId': 'm',
    } } })).toMatchObject({ sessionId: 'child', update: { messageId: 'm' } });
    expect(normalizeDevinSessionUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Tool', _meta: { 'cognition.ai/inferenceToolName': 'read_file' } } })).toMatchObject({ update: { title: 'read_file' } });
  });

  it('projects Claude background agent lifecycle and delegation messages', () => {
    expect(extractClaudeSubagentUpdate({ toolCallId: 'task', name: 'Agent', status: 'completed', rawInput: { prompt: 'Inspect', run_in_background: true, description: 'Audit' } })).toMatchObject({ status: 'running', prompt: 'Inspect', title: 'Audit' });
    expect(extractClaudeSubagentSessionEvent({ sessionId: 'parent', update: { sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle', stopReason: 'error', error: { message: 'failed' } } } })).toMatchObject({ type: 'state', childSessionId: 'child', status: 'failed', result: 'failed' });
    expect(extractClaudeSubagentSessionEvent({ sessionId: 'child', update: { sessionUpdate: 'session_message', messageId: 'm', senderSessionId: 'parent', content: [{ type: 'text', text: 'Inspect' }] } })).toMatchObject({ type: 'delegation', childSessionId: 'child', parentSessionId: 'parent', prompt: 'Inspect' });
  });
});

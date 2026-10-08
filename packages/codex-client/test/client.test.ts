import { PassThrough, Writable } from 'node:stream';

import type { NormalizedExecutorEvent } from '@kiki/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '../src/client';
import { CodexRemoteError } from '../src/errors';
import type { CodexProcessDescriptor, HostProcessLike, HostProcessServiceLike } from '../src/types';

type ScriptedFrame = { id?: string; method?: string; params?: unknown };

type ScriptedProcessOptions = {
  readonly modelPage?: (frame: ScriptedFrame, index: number) => unknown;
};

function scriptedProcess(
  userAgent?: string,
  turnResult?: (index: number) => unknown,
  holdExit = false,
  options: ScriptedProcessOptions = {},
): {
  readonly process: HostProcessLike;
  readonly stdout: PassThrough;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly methods: string[];
  readonly frames: ScriptedFrame[];
  readonly kill: ReturnType<typeof vi.fn>;
  exit(): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const wait = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let input = '';
  let turnStarts = 0;
  let modelPages = 0;
  const methods: string[] = [];
  const frames: ScriptedFrame[] = [];
  const exit = (): void => {
    if (exitCode !== null) return;
    exitCode = 0;
    stdout.end();
    resolveExit(0);
  };
  const kill = vi.fn(async () => { if (!holdExit) exit(); });
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      let newline = input.indexOf('\n');
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const frame = JSON.parse(line) as ScriptedFrame;
        frames.push(frame);
        if (frame.method !== undefined) methods.push(frame.method);
        if (frame.method === 'turn/start' && frame.id !== undefined && turnResult !== undefined) {
          const result = turnResult(++turnStarts);
          if (result !== undefined) stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        }
        if (frame.method === 'turn/interrupt' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        }
        if (frame.method === 'initialize' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent } })}\n`);
        }
        if (frame.method === 'model/list' && frame.id !== undefined) {
          const result = options.modelPage === undefined
            ? { data: [{ id: 'model-a' }], nextCursor: 'repeat' }
            : options.modelPage(frame, ++modelPages);
          if (result !== undefined) stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        }
        newline = input.indexOf('\n');
      }
      callback();
    },
  });
  const dispose = vi.fn();
  return {
    stdout,
    dispose,
    methods,
    frames,
    kill,
    exit,
    process: {
      pid: 1,
      get exitCode() {
        return exitCode;
      },
      stdin,
      stdout,
      stderr,
      wait: () => wait,
      kill,
      dispose,
    },
  };
}

describe('CodexAppServerClient limits and observers', () => {
  it('isolates state observer failures during startup and shutdown', async () => {
    const logger = { error: vi.fn() };
    const spawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const client = new CodexAppServerClient(
      { spawn } as HostProcessServiceLike,
      { id: 'fixture', command: 'fixture' },
      {
        onStateChange: () => {
          throw new Error('observer failed');
        },
        logger,
      },
    );

    await expect(client.connect()).rejects.toThrow('spawn failed');
    expect(spawn).toHaveBeenCalledOnce();
    expect(client.status().state).toBe('broken');
    await client.shutdown();
    expect(client.status().state).toBe('closed');
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([['codex_cli_rs/1.2.3 (Windows)', '1.2.3'], ['unknown', undefined], [undefined, undefined]])('captures the initialize agent version %s', async (userAgent, expected) => {
    const fixture = scriptedProcess(userAgent);
    const client = new CodexAppServerClient({ spawn: async () => fixture.process }, { id: 'fixture', command: 'fixture' });
    await client.connect();
    expect(client.status().agentVersion).toBe(expected);
    await client.shutdown();
  });

  it('fails the connection on repeated model cursors', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    await expect(client.listModels()).rejects.toMatchObject({ code: 'protocol', message: 'model/list repeated a cursor' });
    expect(fixture.methods.filter((method) => method === 'model/list')).toHaveLength(2);
    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('accepts a valid JSONL frame just over 1 MiB across 64 KiB UTF-8 chunks without killing the process', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const events: unknown[] = [];
    const handle = await client.startTurn(
      { threadId: 'thread-1', input: [] },
      new AbortController().signal,
      (event) => { events.push(event); },
    );
    const template = JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'large-message', delta: '',
    } });
    const deltaStart = template.indexOf('""') + 1;
    const chunkSize = 64 * 1024;
    const leading = 'x'.repeat(chunkSize - 1 - Buffer.byteLength(template.slice(0, deltaStart), 'utf8'));
    const delta = `${leading}界${'x'.repeat(1024 * 1024)}`;
    const payload = `${template.slice(0, deltaStart)}${delta}${template.slice(deltaStart)}\n`;
    const encoded = Buffer.from(payload, 'utf8');
    expect(encoded.byteLength).toBeGreaterThan(1024 * 1024);
    expect(encoded[chunkSize - 1]).toBeGreaterThanOrEqual(0xc2);
    expect(encoded[chunkSize - 1]).toBeLessThanOrEqual(0xf4);
    for (let offset = 0; offset < encoded.length; offset += chunkSize) {
      fixture.stdout.write(encoded.subarray(offset, Math.min(offset + chunkSize, encoded.length)));
    }
    await vi.waitFor(() => expect(events).toHaveLength(1));
    completeTurn(fixture.stdout);
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect((events[0] as { content: { text: string } }).content.text).toBe(delta);
    expect(fixture.kill).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('fails closed on malformed JSONL rather than treating it as a valid frame', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    fixture.stdout.write('{"method":\n');
    await vi.waitFor(() => expect(client.status().state).toBe('broken'));
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('pulls 1025 early notifications through a slow sink, preserves order and ACK, and applies producer backpressure', async () => {
    const fixture = scriptedProcess();
    const client = turnClient(fixture);
    await client.connect();
    const eventIds: string[] = [];
    let releaseFirst!: () => void;
    let markFirst!: () => void;
    const firstEvent = new Promise<void>((resolve) => { markFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    const starting = client.startTurn(
      { threadId: 'thread-1', input: [] },
      new AbortController().signal,
      async (event) => {
        if (event.type === 'message.delta') eventIds.push(event.messageId ?? '');
        if (first) {
          first = false;
          markFirst();
          await firstGate;
        }
      },
    );
    let startSettled = false;
    void starting.then(() => { startSettled = true; });
    const startFrame = await waitForFrame(fixture, 'turn/start');
    let backpressured = false;
    let producerDone = false;
    const producer = (async (): Promise<void> => {
      for (let index = 0; index < 1025; index += 1) {
        const accepted = fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-1', turnId: 'turn-1', itemId: `message-${index}`, delta: `${index}`,
        } })}\n`);
        if (!accepted) {
          backpressured = true;
          await new Promise<void>((resolve) => fixture.stdout.once('drain', resolve));
        }
      }
      producerDone = true;
    })();
    await firstEvent;
    expect(startSettled).toBe(false);
    expect(backpressured).toBe(true);
    expect(producerDone).toBe(false);
    expect(fixture.kill).not.toHaveBeenCalled();
    releaseFirst();
    await producer;
    respondToFrame(fixture, startFrame, { turn: { id: 'turn-1' } });
    const handle = await starting;
    expect(startSettled).toBe(true);
    expect(eventIds).toEqual(Array.from({ length: 1025 }, (_, index) => `message-${index}`));
    completeTurn(fixture.stdout);
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.kill).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('B-01 settles natural disconnection while the event sink remains blocked', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture, { shutdownGraceMs: 5 });
    let releaseSink!: () => void;
    let sinkEntered!: () => void;
    let sinkReleased = false;
    const gate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const entered = new Promise<void>((resolve) => { sinkEntered = resolve; });
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal, async () => {
      sinkEntered();
      await gate;
      sinkReleased = true;
    });
    const completed = handle.completion.catch((error: unknown) => error);
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'blocked-message', delta: 'blocked',
    } })}\n`);
    await entered;
    fixture.exit();
    await expect(completed).resolves.toMatchObject({ code: 'closed' });
    expect(sinkReleased).toBe(false);
    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.kill).not.toHaveBeenCalled();
    releaseSink();
    await client.shutdown();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('B-01 drains buffered legal events and terminal before natural-exit cleanup', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture, { shutdownGraceMs: 100 });
    const texts: string[] = [];
    let releaseSink!: () => void;
    let sinkEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const entered = new Promise<void>((resolve) => { sinkEntered = resolve; });
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal, async (event) => {
      if (event.type !== 'message.delta' || event.content.type !== 'text') return;
      texts.push(event.content.text);
      if (texts.length === 1) { sinkEntered(); await gate; }
    });
    const delta = (text: string): string => `${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message', delta: text,
    } })}\n`;
    fixture.stdout.write(delta('first'));
    await entered;
    fixture.stdout.write(delta('tail'));
    completeTurn(fixture.stdout);
    fixture.exit();
    releaseSink();
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed', turnId: 'turn-1' });
    expect(texts).toEqual(['first', 'tail']);
    await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce(), { interval: 1 });
    expect(fixture.kill).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('B-02 lets an asynchronous notification observer await same-connection RPC', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    let client!: CodexAppServerClient;
    let observerEntered!: () => void;
    let observerFinished!: (value: unknown) => void;
    const entered = new Promise<void>((resolve) => { observerEntered = resolve; });
    const observed = new Promise<unknown>((resolve) => { observerFinished = resolve; });
    client = new CodexAppServerClient({ spawn: async () => fixture.process }, { id: 'fixture', command: 'fixture' }, {
      onNotification: async (notification) => {
        if (notification.method !== 'thread/status/changed') return;
        observerEntered();
        observerFinished(await client.request('observer/rpc', {}));
      },
    });
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal, () => {});
    fixture.stdout.write(`${JSON.stringify({ method: 'thread/status/changed', params: {
      threadId: 'other-thread', status: 'active',
    } })}\n`);
    await entered;
    const rpc = await waitForFrame(fixture, 'observer/rpc');
    respondToFrame(fixture, rpc, { ok: true });
    completeTurn(fixture.stdout);
    await expect(observed).resolves.toEqual({ ok: true });
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.methods.filter((method) => method === 'observer/rpc')).toHaveLength(1);
    expect(fixture.kill).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('cancels and cleans up when the event sink is backpressured', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }), true);
    const client = turnClient(fixture);
    await client.connect();
    const controller = new AbortController();
    let releaseSink!: () => void;
    let sinkEntered!: () => void;
    const sinkGate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const sinkStarted = new Promise<void>((resolve) => { sinkEntered = resolve; });
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      controller.signal,
      async () => {
        sinkEntered();
        await sinkGate;
      },
    );
    const completion = handle.completion.catch((error: unknown) => error);
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'blocked-message', delta: 'blocked',
    } })}\n`);
    await sinkStarted;
    controller.abort(new Error('cancel while sink is blocked'));
    await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalled(), { interval: 1 });
    expect(fixture.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1);
    fixture.exit();
    releaseSink();
    await expect(completion).resolves.toMatchObject({ code: 'timeout' });
    await client.shutdown();
  });

  it('aborts a pre-ACK sink without a fake interrupt turnId and owns grace cleanup', async () => {
    const fixture = scriptedProcess(undefined, undefined, true);
    const client = turnClient(fixture, { shutdownGraceMs: 50 });
    const controller = new AbortController();
    let releaseSink!: () => void;
    let sinkEntered!: () => void;
    const sinkGate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const sinkStarted = new Promise<void>((resolve) => { sinkEntered = resolve; });
    await client.connect();
    const starting = client.startTurn(
      { threadId: 'thread-1' },
      controller.signal,
      async () => {
        sinkEntered();
        await sinkGate;
      },
    );
    void starting.catch(() => undefined);
    await waitForFrame(fixture, 'turn/start');
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'pre-ack-turn', itemId: 'pre-ack-message', delta: 'early',
    } })}\n`);
    await sinkStarted;
    controller.abort(new Error('abort before turn ACK'));
    await expect(starting).rejects.toMatchObject({ code: 'aborted' });
    await expect(client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    )).rejects.toMatchObject({ code: 'protocol' });
    expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
    expect(fixture.frames.filter((frame) => frame.method === 'turn/interrupt')).toEqual([]);
    await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalled(), { interval: 1 });
    fixture.exit();
    releaseSink();
    await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce(), { interval: 1 });
    expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
    await client.shutdown();
  });
});

describe('Codex request and admission deadlines', () => {
  it('leaves a default-deadline RPC pending past 30 seconds without killing or duplicating an active turn', async () => {
    vi.useFakeTimers();
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    try {
      await client.connect();
      const handle = await client.startTurn(
        { threadId: 'thread-1' },
        new AbortController().signal,
        async () => {},
      );
      const pending = client.request('vendor/slow', { request: 'one' });
      const frame = await waitForFrame(fixture, 'vendor/slow');
      await vi.advanceTimersByTimeAsync(30_001);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(client.status()).toMatchObject({ state: 'turning', turnId: 'turn-1' });
      await expect(client.startTurn(
        { threadId: 'thread-1' },
        new AbortController().signal,
        async () => {},
      )).rejects.toMatchObject({ code: 'closed' });
      respondToFrame(fixture, frame, { ok: true });
      await expect(pending).resolves.toEqual({ ok: true });
      completeTurn(fixture.stdout);
      await handle.completion;
    } finally {
      vi.useRealTimers();
      await client.shutdown();
    }
  });

  it('keeps a timed-out RPC identity for its late response and admits the next RPC', async () => {
    vi.useFakeTimers();
    const fixture = scriptedProcess();
    const client = turnClient(fixture, { requestTimeoutMs: 10 });
    try {
      await client.connect();
      const timedOut = client.request('vendor/slow', { request: 'late' });
      void timedOut.catch(() => undefined);
      const lateFrame = await waitForFrame(fixture, 'vendor/slow');
      await vi.advanceTimersByTimeAsync(11);
      await expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
      expect(client.status().state).toBe('ready');
      respondToFrame(fixture, lateFrame, { late: true });
      const next = client.request('vendor/next', { request: 'normal' });
      const nextFrame = await waitForFrame(fixture, 'vendor/next');
      respondToFrame(fixture, nextFrame, { next: true });
      await expect(next).resolves.toEqual({ next: true });
      expect(fixture.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await client.shutdown();
    }
  });

  it('does not duplicate a timed-out turn/start and associates its late ACK with the original turn', async () => {
    vi.useFakeTimers();
    const fixture = scriptedProcess();
    const client = turnClient(fixture, { requestTimeoutMs: 10 });
    const events: NormalizedExecutorEvent[] = [];
    try {
      await client.connect();
      const starting = client.startTurn(
        { threadId: 'thread-1' },
        new AbortController().signal,
        (event) => { events.push(event); },
      );
      void starting.catch(() => undefined);
      const firstFrame = await waitForFrame(fixture, 'turn/start');
      await vi.advanceTimersByTimeAsync(11);
      await expect(starting).rejects.toMatchObject({ code: 'timeout' });
      await expect(client.startTurn(
        { threadId: 'thread-1' },
        new AbortController().signal,
        async () => {},
      )).rejects.toMatchObject({ code: 'protocol' });
      expect(fixture.frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
      respondToFrame(fixture, firstFrame, { turn: { id: 'late-turn' } });
      await vi.waitFor(() => expect(client.status().turnId).toBe('late-turn'));
      fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
        threadId: 'thread-1', turnId: 'late-turn', itemId: 'late-message', delta: 'late',
      } })}\n`);
      completeTurn(fixture.stdout, 'late-turn');
      await vi.waitFor(() => expect(client.status().state).toBe('ready'));
      expect(events).toEqual([{
        type: 'message.delta', role: 'assistant', messageId: 'late-message',
        content: { type: 'text', text: 'late' },
      }]);
      expect(fixture.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await client.shutdown();
    }
  });

  it('preserves vendor error code and data while keeping the transport usable', async () => {
    const fixture = scriptedProcess();
    const client = turnClient(fixture);
    await client.connect();
    const failed = client.request('vendor/error', { input: true });
    const failedFrame = await waitForFrame(fixture, 'vendor/error');
    fixture.stdout.write(`${JSON.stringify({
      id: failedFrame.id,
      error: { code: -32017, message: 'vendor rejected input', data: { vendor: 'fixture', retryable: false } },
    })}\n`);
    await expect(failed).rejects.toBeInstanceOf(CodexRemoteError);
    await expect(failed).rejects.toMatchObject({
      code: 'remote', remoteCode: -32017, data: { vendor: 'fixture', retryable: false },
    });
    const next = client.request('vendor/next', {});
    const nextFrame = await waitForFrame(fixture, 'vendor/next');
    respondToFrame(fixture, nextFrame, { ok: true });
    await expect(next).resolves.toEqual({ ok: true });
    expect(fixture.kill).not.toHaveBeenCalled();
    await client.shutdown();
  });

  it('continues through 101 pages and 10,100 models without page/model caps or process kill', async () => {
    const fixture = scriptedProcess(undefined, undefined, false, {
      modelPage: (_frame, page) => ({
        data: Array.from({ length: 100 }, (_, index) => ({ id: `model-${page}-${index}` })),
        nextCursor: page < 101 ? `cursor-${page}` : null,
      }),
    });
    const client = turnClient(fixture);
    await client.connect();
    const result = await client.listModels();
    expect(result.data).toHaveLength(10_100);
    expect(fixture.methods.filter((method) => method === 'model/list')).toHaveLength(101);
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(client.status().state).toBe('ready');
    await client.shutdown();
  });

  it('allows model pagination cancellation without killing the process', async () => {
    const fixture = scriptedProcess(undefined, undefined, false, { modelPage: () => undefined });
    const client = turnClient(fixture);
    await client.connect();
    const controller = new AbortController();
    const listing = client.listModels(controller.signal);
    await waitForFrame(fixture, 'model/list');
    controller.abort(new Error('stop listing'));
    await expect(listing).rejects.toMatchObject({ code: 'aborted' });
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(client.status().state).toBe('ready');
    await client.shutdown();
  });
});

function turnClient(
  fixture: ReturnType<typeof scriptedProcess>,
  descriptor: Partial<CodexProcessDescriptor> = {},
): CodexAppServerClient {
  return new CodexAppServerClient({ spawn: async () => fixture.process }, {
    id: 'fixture', command: 'fixture', shutdownGraceMs: 5, ...descriptor,
  });
}

function completeTurn(stdout: PassThrough, turnId = 'turn-1', status = 'completed'): void {
  stdout.write(`${JSON.stringify({ method: 'turn/completed', params: {
    threadId: 'thread-1', turn: { id: turnId, status },
  } })}\n`);
}

async function waitForFrame(
  fixture: ReturnType<typeof scriptedProcess>,
  method: string,
  occurrence = 1,
): Promise<ScriptedFrame> {
  await vi.waitFor(() => {
    expect(fixture.frames.filter((frame) => frame.method === method).length).toBeGreaterThanOrEqual(occurrence);
  });
  const frame = fixture.frames.filter((candidate) => candidate.method === method)[occurrence - 1];
  if (frame === undefined || frame.id === undefined) throw new Error(`missing ${method} frame`);
  return frame;
}

function respondToFrame(fixture: ReturnType<typeof scriptedProcess>, frame: ScriptedFrame, result: unknown): void {
  if (frame.id === undefined) throw new Error('cannot respond to a frame without an id');
  fixture.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
}

describe('Codex turn settlement', () => {
  it('settles a normal completion once and admits the next turn', async () => {
    const fixture = scriptedProcess(undefined, (index) => ({ turn: { id: `turn-${index}` } }));
    const client = turnClient(fixture);
    await client.connect();
    const first = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    completeTurn(fixture.stdout);
    completeTurn(fixture.stdout);
    await expect(first.completion).resolves.toMatchObject({ status: 'completed' });
    expect(client.status()).toMatchObject({ state: 'ready', turnId: undefined, threadId: undefined });
    expect(await first.cancel()).toBe(false);
    const second = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    completeTurn(fixture.stdout, 'turn-2');
    await second.completion;
    await client.shutdown();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('ignores notifications from a different Codex thread', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const events: NormalizedExecutorEvent[] = [];
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      (event) => { events.push(event); },
    );
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'other-thread', turnId: 'other-turn', itemId: 'other-message', delta: 'wrong',
    } })}\n`);
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'right',
    } })}\n`);
    completeTurn(fixture.stdout);
    await handle.completion;
    expect(events).toEqual([{
      type: 'message.delta', role: 'assistant', messageId: 'message-1',
      content: { type: 'text', text: 'right' },
    }]);
    await client.shutdown();
  });

  it('accumulates usage within a turn without charging prior turns', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, cachedInputTokens: 0, outputTokens, totalTokens: inputTokens + outputTokens });
    for (const [last, total] of [[usage(10, 2), usage(110, 22)], [usage(20, 3), usage(130, 25)]]) {
      fixture.stdout.write(`${JSON.stringify({ method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-1', tokenUsage: { last, total, modelContextWindow: 200000 },
      } })}\n`);
    }
    completeTurn(fixture.stdout);
    await expect(handle.completion).resolves.toMatchObject({ usage: {
      inputTokens: 30, cachedInputTokens: 0, outputTokens: 5, contextWindow: 200000,
    } });
    await client.shutdown();
  });

  it.each([false, true])('requires failed completion after a non-retry error, willRetry=%s', async (willRetry) => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    fixture.stdout.write(`${JSON.stringify({ method: 'error', params: {
      threadId: 'thread-1', turnId: 'turn-1', error: { message: 'provider failed' }, willRetry,
    } })}\n`);
    completeTurn(fixture.stdout);
    await expect(handle.completion).resolves.toMatchObject({ status: willRetry ? 'completed' : 'failed' });
    await client.shutdown();
  });

  it('sends one interrupt during repeated active shutdown and settles after process exit', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }), true);
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    const completion = handle.completion.catch((error: unknown) => error);
    let settled = false;
    void completion.then(() => { settled = true; });
    const shutdown = client.shutdown();
    const repeated = client.shutdown();
    expect(repeated).toBe(shutdown);
    await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalled(), { interval: 1 });
    expect(settled).toBe(false);
    expect(fixture.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1);
    fixture.exit();
    await shutdown;
    expect(await completion).toMatchObject({ code: 'closed' });
    expect(client.status()).toMatchObject({ state: 'closed', turnId: undefined, threadId: undefined, pid: undefined });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('bounds abort ACK without terminal and deduplicates direct cancel', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }), true);
    const client = turnClient(fixture);
    await client.connect();
    const signal = new AbortController();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      signal.signal,
      async () => {},
    );
    const completion = handle.completion.catch((error: unknown) => error);
    let settled = false;
    void completion.then(() => { settled = true; });
    signal.abort(new Error('cancelled'));
    expect(await handle.cancel()).toBe(true);
    expect(await handle.cancel()).toBe(true);
    await vi.waitFor(() => expect(fixture.kill).toHaveBeenCalled(), { interval: 1 });
    expect(settled).toBe(false);
    expect(fixture.methods.filter((method) => method === 'turn/interrupt')).toHaveLength(1);
    fixture.exit();
    expect(await completion).toMatchObject({ code: 'timeout' });
    expect(client.status()).toMatchObject({ state: 'broken', turnId: undefined });
    await client.shutdown();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('accepts interrupted terminal before grace and keeps the connection reusable', async () => {
    const fixture = scriptedProcess(undefined, (index) => ({ turn: { id: `turn-${index}` } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    await handle.cancel();
    completeTurn(fixture.stdout, 'turn-1', 'interrupted');
    await expect(handle.completion).resolves.toMatchObject({ status: 'interrupted' });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(client.status().state).toBe('ready');
    const second = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    completeTurn(fixture.stdout, 'turn-2');
    await second.completion;
    await client.shutdown();
  });

  it.each(['eof', 'exit'] as const)('settles an active turn on unexpected %s', async (kind) => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    const completion = handle.completion.catch((error: unknown) => error);
    if (kind === 'eof') fixture.stdout.end();
    else fixture.exit();
    expect(await completion).toMatchObject({ code: 'closed' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
    await client.shutdown();
  });

  it('attaches the sink before a malformed start ACK and clears turn admission', async () => {
    const fixture = scriptedProcess(undefined, (index) => {
      if (index === 1) {
        fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
          itemId: 'early-message', delta: 'EARLY',
        } })}\n`);
        return { turn: {} };
      }
      return { turn: { id: 'turn-2' } };
    });
    const client = turnClient(fixture);
    await client.connect();
    const events: NormalizedExecutorEvent[] = [];
    await expect(client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      (event) => { events.push(event); },
    )).rejects.toMatchObject({ code: 'protocol' });
    expect(events).toEqual([{
      type: 'message.delta', role: 'assistant', messageId: 'early-message',
      content: { type: 'text', text: 'EARLY' },
    }]);
    expect(client.status().state).toBe('ready');
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    expect(fixture.methods.filter((method) => method === 'turn/start')).toHaveLength(2);
    completeTurn(fixture.stdout, 'turn-2');
    await handle.completion;
    await client.shutdown();
  });

  it.each([null, {}, { turn: {} }, { turn: { id: 1 } }])('clears malformed turn/start admission for %j', async (malformed) => {
    const fixture = scriptedProcess(undefined, (index) => index === 1 ? malformed : { turn: { id: 'turn-2' } });
    const client = turnClient(fixture);
    await client.connect();
    await expect(client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    )).rejects.toMatchObject({ code: 'protocol' });
    expect(client.status().state).toBe('ready');
    const handle = await client.startTurn(
      { threadId: 'thread-1' },
      new AbortController().signal,
      async () => {},
    );
    expect(fixture.methods.filter((method) => method === 'turn/start')).toHaveLength(2);
    completeTurn(fixture.stdout, 'turn-2');
    await handle.completion;
    await client.shutdown();
  });
});

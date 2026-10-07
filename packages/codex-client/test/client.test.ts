import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AsyncQueue } from '../src/asyncQueue';
import { CodexAppServerClient } from '../src/client';
import type { HostProcessLike, HostProcessServiceLike } from '../src/types';

function scriptedProcess(userAgent?: string, turnResult?: (index: number) => unknown, holdExit = false): {
  readonly process: HostProcessLike;
  readonly stdout: PassThrough;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly methods: string[];
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
  const methods: string[] = [];
  const exit = (): void => {
    if (exitCode !== null) return;
    exitCode = 0;
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
        const frame = JSON.parse(line) as { id?: string; method?: string; params?: unknown };
        if (frame.method !== undefined) methods.push(frame.method);
        if (frame.method === 'turn/start' && frame.id !== undefined && turnResult !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: turnResult(++turnStarts) })}\n`);
        }
        if (frame.method === 'turn/interrupt' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
        }
        if (frame.method === 'initialize' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({ id: frame.id, result: { userAgent } })}\n`);
        }
        if (frame.method === 'model/list' && frame.id !== undefined) {
          stdout.write(`${JSON.stringify({
            id: frame.id,
            result: {
              data: [{ id: 'model-a' }],
              nextCursor: 'repeat',
            },
          })}\n`);
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

  it('fails the connection when early notifications exceed the limit', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    const turn = client.startTurn(
      { threadId: 'thread-1', input: [] },
      new AbortController().signal,
    );
    const notification = `${JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'item-1', type: 'agentMessage' },
      },
    })}\n`;
    fixture.stdout.write(notification.repeat(1025));

    await expect(turn).rejects.toMatchObject({ code: 'protocol' });
    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('fails the connection on an oversized pending stdout frame', async () => {
    const fixture = scriptedProcess();
    const client = new CodexAppServerClient(
      { spawn: async () => fixture.process },
      { id: 'fixture', command: 'fixture' },
    );
    await client.connect();

    fixture.stdout.write('x'.repeat(1024 * 1024 + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(client.status().state).toBe('broken');
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
});

function turnClient(fixture: ReturnType<typeof scriptedProcess>): CodexAppServerClient {
  return new CodexAppServerClient({ spawn: async () => fixture.process }, {
    id: 'fixture', command: 'fixture', shutdownGraceMs: 5,
  });
}

function completeTurn(stdout: PassThrough, turnId = 'turn-1', status = 'completed'): void {
  stdout.write(`${JSON.stringify({ method: 'turn/completed', params: {
    threadId: 'thread-1', turn: { id: turnId, status },
  } })}\n`);
}

describe('Codex turn settlement', () => {
  it('settles a normal completion once and admits the next turn', async () => {
    const fixture = scriptedProcess(undefined, (index) => ({ turn: { id: `turn-${index}` } }));
    const client = turnClient(fixture);
    await client.connect();
    const first = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    completeTurn(fixture.stdout);
    completeTurn(fixture.stdout);
    await expect(first.completion).resolves.toMatchObject({ status: 'completed' });
    await expect(first.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(client.status()).toMatchObject({ state: 'ready', turnId: undefined, threadId: undefined });
    expect(await first.cancel()).toBe(false);
    const second = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    completeTurn(fixture.stdout, 'turn-2');
    await second.completion;
    await client.shutdown();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('ignores notifications from a different Codex thread', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'other-thread', turnId: 'other-turn', itemId: 'other-message', delta: 'wrong',
    } })}\n`);
    fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'right',
    } })}\n`);
    completeTurn(fixture.stdout);
    const events: unknown[] = [];
    for await (const event of handle.events) events.push(event);
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
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
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
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
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
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
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
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'closed' });
    expect(client.status()).toMatchObject({ state: 'closed', turnId: undefined, threadId: undefined, pid: undefined });
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('bounds abort ACK without terminal and deduplicates direct cancel', async () => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }), true);
    const client = turnClient(fixture);
    await client.connect();
    const signal = new AbortController();
    const handle = await client.startTurn({ threadId: 'thread-1' }, signal.signal);
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
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'timeout' });
    expect(client.status()).toMatchObject({ state: 'broken', turnId: undefined });
    await client.shutdown();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('accepts interrupted terminal before grace and keeps the connection reusable', async () => {
    const fixture = scriptedProcess(undefined, (index) => ({ turn: { id: `turn-${index}` } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    await handle.cancel();
    completeTurn(fixture.stdout, 'turn-1', 'interrupted');
    await expect(handle.completion).resolves.toMatchObject({ status: 'interrupted' });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(client.status().state).toBe('ready');
    const second = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    completeTurn(fixture.stdout, 'turn-2');
    await second.completion;
    await client.shutdown();
  });

  it.each(['eof', 'exit'] as const)('settles an active turn on unexpected %s', async (kind) => {
    const fixture = scriptedProcess(undefined, () => ({ turn: { id: 'turn-1' } }));
    const client = turnClient(fixture);
    await client.connect();
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    const completion = handle.completion.catch((error: unknown) => error);
    if (kind === 'eof') fixture.stdout.end();
    else fixture.exit();
    expect(await completion).toMatchObject({ code: 'closed' });
    await expect(handle.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'closed' });
    expect(fixture.dispose).toHaveBeenCalledOnce();
    await client.shutdown();
  });

  it.each([false, true])('discards early events and the starting signal after malformed response, aborted=%s', async (abort) => {
    const fixture = scriptedProcess(undefined, (index) => {
      if (index === 1) {
        fixture.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
          itemId: 'stale-message', delta: 'STALE',
        } })}\n`);
        return { turn: {} };
      }
      return { turn: { id: 'turn-2' } };
    });
    let requestSignal: AbortSignal | undefined;
    const client = new CodexAppServerClient({ spawn: async () => fixture.process }, {
      id: 'fixture', command: 'fixture', shutdownGraceMs: 5,
    }, { onServerRequest: async (_request, responder, signal) => {
      requestSignal = signal;
      await responder.respond({});
    } });
    await client.connect();
    const controller = new AbortController();
    const starting = client.startTurn({ threadId: 'thread-1' }, controller.signal);
    if (abort) controller.abort(new Error('cancel during response'));
    await expect(starting).rejects.toMatchObject({ code: 'protocol' });
    fixture.stdout.write(`${JSON.stringify({ id: 'server-request', method: 'fixture/request', params: {} })}\n`);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal).not.toBe(controller.signal);
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    completeTurn(fixture.stdout, 'turn-2');
    await handle.completion;
    await expect(handle.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    await client.shutdown();
  });

  it.each([null, {}, { turn: {} }, { turn: { id: 1 } }])('clears malformed turn/start admission for %j', async (malformed) => {
    const fixture = scriptedProcess(undefined, (index) => index === 1 ? malformed : { turn: { id: 'turn-2' } });
    const client = turnClient(fixture);
    await client.connect();
    await expect(client.startTurn({ threadId: 'thread-1' }, new AbortController().signal)).rejects.toMatchObject({ code: 'protocol' });
    expect(client.status().state).toBe('ready');
    const handle = await client.startTurn({ threadId: 'thread-1' }, new AbortController().signal);
    expect(fixture.methods.filter((method) => method === 'turn/start')).toHaveLength(2);
    completeTurn(fixture.stdout, 'turn-2');
    await handle.completion;
    await client.shutdown();
  });
});

import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

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
  it('backpressures a delayed consumer without dropping a 1025-item burst', async () => {
    const count = 1025;
    const queue = new AsyncQueue<number>(1024);
    const reservations = await Promise.all(Array.from({ length: 1024 }, () => queue.reserve()));
    reservations.forEach((reservation, index) => reservation.commit(index));
    const delayed = queue.reserve();
    const iterator = queue[Symbol.asyncIterator]();
    const values: number[] = [];
    for (let index = 0; index < 1024; index += 1) {
      const result = await iterator.next();
      expect(result.done).toBe(false);
      values.push(result.value);
    }
    (await delayed).commit(1024);
    const last = await iterator.next();
    expect(last.done).toBe(false);
    values.push(last.value);
    queue.close();
    expect(values).toEqual(Array.from({ length: count }, (_, index) => index));
    await expect(iterator.next()).resolves.toMatchObject({ value: undefined, done: true });

    const failed = new AsyncQueue<number>(1);
    failed.push(1);
    failed.fail(new Error('protocol failure'));
    await expect(failed[Symbol.asyncIterator]().next()).rejects.toThrow('protocol failure');
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
    const handle = await client.startTurn({
      prompt: 'go',
      signal: new AbortController().signal,
      session: { cwd: 'C:/workspace' },
    });
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

  it('spawns the agent with the caller environment and no unset list', async () => {
    const calls: Array<{ command: string; options: Record<string, unknown> | undefined }> = [];
    const client = new AcpProcessClient(
      {
        spawn: async (command: string, _args?: readonly string[], options?: Record<string, unknown>) => {
          calls.push({ command, options });
          throw new Error('spawn refused');
        },
      } as unknown as HostProcessServiceLike,
      { id: 'claude-acp', command: 'node', args: ['agent.js'] },
      { logger: { error: () => {} } },
    );

    await expect(client.openSession({ cwd: 'C:/workspace' })).rejects.toThrow();

    expect(calls[0]?.command).toBe('node');
    expect(calls[0]?.options).toMatchObject({ shell: false, windowsHide: true });
    expect(calls[0]?.options).not.toHaveProperty('envUnset');
    expect(calls[0]?.options?.['env']).toBeUndefined();
    expect(calls[0]?.options?.['cwd']).toBeUndefined();
  });
});

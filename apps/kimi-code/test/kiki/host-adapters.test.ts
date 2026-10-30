import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { createSeatKlient } from '@kiki/klient/procedures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchDispatchEvents } from '../../src/kiki/host-attach';
import { readClaudeNotifications } from '../../src/kiki/host-claude';
import { codexBindingPath, deliverCodexEvents, registerHostCodexCommands } from '../../src/kiki/host-codex';

const dispatchId = 'dispatch_MOCK001';
const event = (seq: number, type: string, message?: string) => ({ seq, dispatchId, type, at: seq, message });

describe('external host wake adapters (mock seat and queue)', () => {
  let workspace: string;
  beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), 'kiki-host-adapters-')); });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  it('Grok attachment returns immediately on background dispatch and wakes on terminal event', async () => {
    let calls = 0;
    const klient = {
      events: vi.fn(async ({ cursor }: { cursor: number }) => {
        calls++;
        if (cursor === 0) return { items: [event(1, 'queued')], nextCursor: undefined };
        return { items: [event(2, 'agent_notify', 'checkpoint'), event(3, 'completed')], nextCursor: undefined };
      }),
      result: vi.fn(async () => ({ text: 'completed summary', nextCursor: undefined })),
    };
    const lines: string[] = [];
    const outcome = await watchDispatchEvents(klient as never, dispatchId, 0, (line) => lines.push(line), async () => {});
    expect(outcome).toBe(0);
    expect(calls).toBe(2);
    expect(lines).toEqual([
      `NOTIFY ${dispatchId} 2 checkpoint`,
      `DONE ${dispatchId} 3 completed completed summary`,
    ]);
  });

  it.each(['events', 'result'] as const)('cancels an attachment stalled in %s without polling again or cancelling the child', async phase => {
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async input => {
      if (phase === 'result' && String(input).endsWith('/events')) return Response.json({ code: 0, msg: 'ok',
        data: { items: [event(1, 'completed')] } });
      return new Response(new ReadableStream({ cancel }));
    });
    const klient = createSeatKlient({ endpoint: 'http://example.test', token: 'SEAT_TOKEN', fetch: fetchMock });
    const source = new AbortController();
    const emit = vi.fn();
    const watching = watchDispatchEvents(klient, dispatchId, 0, emit, undefined, source.signal);
    const rejected = expect(watching).rejects.toThrow('attachment stopped');
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(phase === 'result' ? 2 : 1); });
    source.abort(new Error('attachment stopped'));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(phase === 'result'
      ? ['http://example.test/api/klient/delegation/events', 'http://example.test/api/klient/delegation/result']
      : ['http://example.test/api/klient/delegation/events']);
    await klient.close();
  });

  it('cancels the idle attachment pause without issuing another events query', async () => {
    const source = new AbortController();
    const klient = { events: vi.fn(async () => ({ items: [] })), result: vi.fn() };
    const watching = watchDispatchEvents(klient, dispatchId, 0, vi.fn(), undefined, source.signal);
    const rejected = expect(watching).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    source.abort();
    await rejected;
    expect(klient.events).toHaveBeenCalledExactlyOnceWith({ dispatchId, cursor: 0, limit: 100 }, { signal: source.signal });
    expect(klient.result).not.toHaveBeenCalled();
  });

  it('Claude consumes one notification at a time and exits cleanly without repeat wake', async () => {
    const directory = join(workspace, '.kiki', 'host-claude');
    await mkdir(directory, { recursive: true });
    const cursorFile = join(directory, `${dispatchId}.cursor`);
    await writeFile(cursorFile, '0');
    const klient = { events: vi.fn(async ({ cursor }: { cursor: number }) => ({
      items: [event(1, 'queued'), event(2, 'agent_notify', 'new fact'), event(3, 'completed')]
        .filter((entry) => entry.seq > cursor),
      nextCursor: undefined,
    })) };
    expect(await readClaudeNotifications(klient as never, directory)).toContain('new fact');
    expect(await readFile(cursorFile, 'utf8')).toBe('2');
    expect(await readClaudeNotifications(klient as never, directory)).toBeUndefined();
    await expect(readFile(cursorFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('Codex queues notify and terminal to an idle thread, then cursor prevents replay', async () => {
    const home = join(workspace, 'kiki-home');
    const path = codexBindingPath(home, workspace, dispatchId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ thread: 'thread_12345678', codex: 'codex' }));
    const klient = {
      events: vi.fn(async ({ cursor }: { cursor: number }) => ({
        items: [event(1, 'queued'), event(2, 'agent_notify', 'check'), event(3, 'completed')]
          .filter((entry) => entry.seq > cursor),
        nextCursor: undefined,
      })),
      close: vi.fn(async () => {}),
    };
    const queue = vi.fn(async (_command: string, _thread: string, _message: string) => {});
    const input = { workspace, home, dispatch: dispatchId, klient: klient as never, queue };
    expect(await deliverCodexEvents(input)).toBe(2);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls[0]?.[2]).toContain('agent_notify');
    expect(queue.mock.calls[1]?.[2]).toContain('completed');
    expect(await deliverCodexEvents(input)).toBe(0);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(await readFile(`${path}.cursor`, 'utf8')).toBe('3');
  });

  it('keeps Codex event pending when the queue fails and retries after recovery', async () => {
    const home = join(workspace, 'kiki-home');
    const path = codexBindingPath(home, workspace, dispatchId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ thread: 'thread_12345678', codex: 'codex' }));
    const klient = {
      events: async ({ cursor }: { cursor: number }) => ({ items: [event(1, 'queued'), event(2, 'completed')].filter((item) => item.seq > cursor), nextCursor: undefined }),
      close: async () => {},
    };
    const failure = async (): Promise<void> => { throw new Error('daemon stopped'); };
    await expect(deliverCodexEvents({ workspace, home, dispatch: dispatchId, klient: klient as never, queue: failure })).rejects.toThrow('daemon stopped');
    expect(await readFile(`${path}.cursor`, 'utf8')).toBe('1');
    const queue = vi.fn(async (_command: string, _thread: string, _message: string) => {});
    expect(await deliverCodexEvents({ workspace, home, dispatch: dispatchId, klient: klient as never, queue })).toBe(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('recovers a Codex dispatch from explicit CLI arguments without waiting on stdin', async () => {
    const program = new Command();
    registerHostCodexCommands(program);
    const stdin = vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => {
      throw new Error('CLI attempted to read stdin');
    });
    try {
      await expect(program.parseAsync([
        'host-codex-queue', '--workspace', workspace, '--dispatch', dispatchId,
        '--home', join(workspace, 'kiki-home'),
      ], { from: 'user' })).resolves.toBe(program);
      expect(stdin).not.toHaveBeenCalled();
    } finally {
      stdin.mockRestore();
    }
  });

  it('mock Codex host keeps dispatch asynchronous and starts a turn on completion without user input', async () => {
    const home = join(workspace, 'kiki-home');
    const path = codexBindingPath(home, workspace, dispatchId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ thread: 'thread_12345678', codex: 'codex' }));
    let settle!: () => void;
    const completed = new Promise<void>((done) => { settle = done; });
    const seen = [event(1, 'queued')];
    const seat = {
      dispatch: async () => ({ dispatchId, status: 'queued' }),
      events: async ({ cursor }: { cursor: number }) => ({ items: seen.filter((item) => item.seq > cursor), nextCursor: undefined }),
      close: async () => {},
    };
    const issued = await seat.dispatch();
    expect(issued).toEqual({ dispatchId, status: 'queued' });
    let hostIdle = true;
    let turnStarted = 0;
    const queue = async (_command: string, _thread: string, _message: string): Promise<void> => {
      if (hostIdle) { hostIdle = false; turnStarted++; }
    };
    expect(turnStarted).toBe(0);
    void completed.then(() => { seen.push(event(2, 'completed')); });
    settle();
    await completed;
    await deliverCodexEvents({ workspace, home, dispatch: issued.dispatchId, klient: seat as never, queue });
    expect(turnStarted).toBe(1);
  });
});

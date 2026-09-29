import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { HTTP_TRANSPORT_TIMEOUT_REASON, HttpChannel, type HttpSocketDiagnostic } from '../src/transports/http/channel.js';
import { createKlient } from '../src/transports/http/index.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (event: unknown) => void;

class FakeWebSocketServer {
  readonly frames: Record<string, unknown>[] = [];
  readonly sockets: FakeSocket[] = [];
  lastUrl = '';
  lastProtocols: string[] | undefined;
  subscribeError: string | undefined;
  autoOpen = true;

  attach(socket: FakeSocket, url: string, protocols?: string | string[]): void {
    this.sockets.push(socket);
    this.lastUrl = url;
    this.lastProtocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : undefined;
    queueMicrotask(() => {
      if (this.autoOpen) socket.open();
    });
  }

  receive(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    if (frame['type'] === 'subscribe') {
      socket.deliver(this.subscribeError === undefined
        ? { type: 'subscribed', id: frame['id'] }
        : { type: 'error', id: frame['id'], code: 40001, msg: this.subscribeError });
    }
  }

  pushEvent(data: unknown, socket = this.sockets.at(-1)): void {
    const subscribe = this.frames.toReversed().find((frame) => frame['type'] === 'subscribe');
    socket?.deliver({ type: 'event', id: subscribe?.['id'], data });
  }

  push(frame: Record<string, unknown>, socket = this.sockets.at(-1)): void {
    socket?.deliver(frame);
  }

  disconnect(): void {
    this.sockets.at(-1)?.serverClose();
  }
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  private readonly handlers = new Map<string, Set<Listener>>();

  constructor(
    private readonly server: FakeWebSocketServer,
    url: string,
    protocols?: string | string[],
  ) {
    server.attach(this, url, protocols);
  }

  addEventListener(type: string, listener: Listener): void {
    const handlers = this.handlers.get(type) ?? new Set<Listener>();
    handlers.add(listener);
    this.handlers.set(type, handlers);
  }

  send(data: string): void {
    this.server.receive(this, data);
  }

  close(): void {
    this.serverClose();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.fire('open', {});
  }

  serverClose(event: { code?: number; reason?: string; wasClean?: boolean } = {}): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', event);
  }

  deliver(frame: Record<string, unknown>): void {
    queueMicrotask(() => {
      this.fire('message', { data: JSON.stringify(frame) });
    });
  }

  private fire(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

function fakeWebSocket(server: FakeWebSocketServer): typeof WebSocket {
  class BoundFakeSocket extends FakeSocket {
    static override readonly OPEN = FakeSocket.OPEN;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(server, String(url), protocols);
    }
  }
  return BoundFakeSocket as unknown as typeof WebSocket;
}

function jsonResponse(envelope: Record<string, unknown>): Response {
  return { json: () => Promise.resolve(envelope) } as Response;
}

function okEnvelope(data: unknown): Record<string, unknown> {
  return { code: 0, msg: 'success', data, request_id: 'r1' };
}

const frozenOldCoverageDecoder = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full'), hasMoreOlder: z.literal(false) }),
  z.object({ kind: z.literal('tail'), hasMoreOlder: z.boolean() }),
]);

function hangingJsonResponse(signal: AbortSignal, message: string, contentType = 'application/json'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        const error = new Error(message);
        error.name = 'AbortError';
        controller.error(error);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('http transport', () => {
  it('bounds fatal retries, revives on nudge and stays closed after disposal', async () => {
    vi.useFakeTimers();
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    try {
      klient.terminal.onStatus(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        server.push({ type: 'error', data: { fatal: true }, msg: 'incompatible protocol' });
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(server.sockets).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.sockets).toHaveLength(5);
      klient.terminal.nudge();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.sockets).toHaveLength(6);
      await klient.close();
      klient.terminal.nudge();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.sockets).toHaveLength(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await klient.close(); vi.useRealTimers(); }
  });

  it('replaces stalled establishment and ignores late events from the detached socket', async () => {
    vi.useFakeTimers();
    const server = new FakeWebSocketServer();
    server.autoOpen = false;
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    const statuses: string[] = [];
    try {
      klient.terminal.onStatus((status) => statuses.push(status));
      await vi.advanceTimersByTimeAsync(12_000);
      expect(statuses).toContain('closed');
      server.autoOpen = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(server.sockets).toHaveLength(2);
      expect(statuses.at(-1)).toBe('open');
      server.sockets[0]!.open();
      server.sockets[0]!.serverClose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(server.sockets).toHaveLength(2);
      expect(statuses.at(-1)).toBe('open');
    } finally { await klient.close(); vi.useRealTimers(); }
  });

  it('only treats silence as stale after an advertised heartbeat and times out unanswered attaches', async () => {
    vi.useFakeTimers();
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    try {
      klient.terminal.onStatus(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      klient.terminal.nudge();
      expect(server.sockets).toHaveLength(1);
      server.push({ type: 'ping', data: { heartbeatMs: 10_000, nonce: 'hello' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(server.frames.at(-1)).toMatchObject({ type: 'pong', data: { nonce: 'hello' } });
      await vi.advanceTimersByTimeAsync(45_001);
      klient.terminal.nudge();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.sockets).toHaveLength(2);
      const attached = klient.terminal.terminalAttach('s1', 't1');
      const rejection = expect(attached).rejects.toThrow('terminal attach timed out');
      await vi.advanceTimersByTimeAsync(8_000);
      await rejection;
      klient.terminal.terminalDetach('s1', 't1');
    } finally { await klient.close(); vi.useRealTimers(); }
  });
  it('reports why the event socket closed, with its close code and heartbeat timing', async () => {
    vi.useFakeTimers();
    const server = new FakeWebSocketServer();
    const events: HttpSocketDiagnostic[] = [];
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server), onSocketDiagnostic: (event) => { events.push(event); } });
    try {
      klient.terminal.onStatus(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      server.push({ type: 'ping', data: { heartbeatMs: 10_000, nonce: 'n' } });
      await vi.advanceTimersByTimeAsync(3_000);
      server.sockets.at(-1)!.serverClose({ code: 1006, reason: '', wasClean: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.slice(0, 3)).toEqual([
        { kind: 'open', attempt: 0 },
        { kind: 'close', cause: 'server', code: 1006, reason: undefined, wasClean: false, openForMs: 3_000, sinceInboundMs: 3_000, heartbeatMs: 10_000 },
        { kind: 'retry', attempt: 1, delayMs: 500 },
      ]);
      await vi.advanceTimersByTimeAsync(500);
      server.push({ type: 'ping', data: { heartbeatMs: 10_000, nonce: 'm' } });
      await vi.advanceTimersByTimeAsync(45_001);
      klient.terminal.nudge();
      expect(events.at(-1)).toMatchObject({ kind: 'close', cause: 'stale_heartbeat', heartbeatMs: 10_000, sinceInboundMs: 45_001 });
    } finally { await klient.close(); vi.useRealTimers(); }
  });
  it('shares one socket for PTY, ordered views and typed global events, replaying only unseen output', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    const signals: import('../src/index.js').TerminalSignal[] = [];
    const off = klient.terminal.onTerminalSignal((signal) => signals.push(signal));
    const statuses: string[] = [];
    const offStatus = klient.terminal.onStatus((status) => statuses.push(status));
    const catalog = vi.fn();
    const events = klient.events.on('kosong.changed', catalog);
    const view = klient.session('s1').view.subscribe({ sessionCursor: { seq: 0 }, transcriptGrades: {} }, () => undefined);
    await tick(10);
    const attached = klient.terminal.terminalAttach('s1', 't1');
    const ack = () => {
      const frame = server.frames.filter((value) => value['type'] === 'terminal_attach').at(-1)!;
      server.push({ type: 'terminal_ack', id: frame['id'], code: 0, data: { replayed: 1, earliest_seq: 1, truncated: false } });
    };
    const output = (seq: number) => server.push({ type: 'terminal_output', data: { session_id: 's1', terminal_id: 't1', seq, payload: { data: `chunk-${seq}` } } });
    output(1);
    ack();
    await expect(attached).resolves.toEqual({ replayed: 1, earliestSeq: 1, truncated: false });
    expect(server.sockets).toHaveLength(1);
    expect(server.lastUrl).toBe('ws://example.test/api/klient/events');
    server.pushEvent({ type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    await tick(10);
    expect(catalog).toHaveBeenCalledTimes(1);
    server.disconnect();
    await tick(550);
    expect(server.sockets).toHaveLength(2);
    expect(server.frames.filter((frame) => frame['type'] === 'terminal_attach').at(-1)).toMatchObject({ data: { session_id: 's1', terminal_id: 't1', since_seq: 1 } });
    output(1);
    output(2);
    ack();
    await tick(10);
    expect(signals.filter((signal) => signal.kind === 'output').map((signal) => signal.seq)).toEqual([1, 2]);
    expect(signals.filter((signal) => signal.kind === 'attached')).toHaveLength(2);
    expect(statuses).toContain('closed');
    server.push({ type: 'terminal_exit', data: { session_id: 's1', terminal_id: 't1', payload: { exit_code: 0 } } });
    await tick(10);
    expect(signals.at(-1)).toMatchObject({ kind: 'exit', exitCode: 0 });
    const count = server.frames.filter((frame) => frame['type'] === 'terminal_attach').length;
    view.restart();
    await tick(10);
    expect(server.frames.filter((frame) => frame['type'] === 'terminal_attach')).toHaveLength(count);
    off(); offStatus(); events.dispose(); view.close();
    await klient.close();
  });

  it('rejects pending PTY attaches on detach and close and reports automatic attach rejection', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    const signals: unknown[] = [];
    klient.terminal.onTerminalSignal((signal) => signals.push(signal));
    await expect(klient.terminal.terminalAttach('s1', 't1')).rejects.toThrow('not connected');
    await tick(10);
    const frame = server.frames.find((value) => value['type'] === 'terminal_attach')!;
    server.push({ type: 'terminal_ack', id: frame['id'], code: 404, msg: 'terminal unavailable' });
    await tick(10);
    expect(signals).toContainEqual({ kind: 'unavailable', sessionId: 's1', terminalId: 't1' });
    const detached = klient.terminal.terminalAttach('s1', 't1');
    klient.terminal.terminalDetach('s1', 't1');
    await expect(detached).rejects.toThrow('detached');
    const closed = klient.terminal.terminalAttach('s1', 't2');
    await klient.close();
    await expect(closed).rejects.toThrow('closed');
  });
  it('reattaches ordered views on the shared socket and ignores old generations', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://127.0.0.1:58627', fetch: vi.fn() as unknown as typeof fetch, WebSocket: fakeWebSocket(server) });
    const signals: unknown[] = [];
    const subscription = klient.session('s1').view.subscribe({
      sessionCursor: { seq: 7, epoch: 'session-epoch' },
      transcriptGrades: { main: 'delta' },
      transcriptSince: { main: { seq: 31, epoch: 'transcript-epoch' } },
    }, (signal) => signals.push(signal));
    const errors: Error[] = [];
    klient.events.onError((error) => errors.push(error));
    const events = klient.events.on('config.changed', () => undefined);
    await tick(10);
    expect(server.sockets).toHaveLength(1);
    const attach = server.frames.find((frame) => frame['type'] === 'view_attach')!;
    expect(attach).toMatchObject({ sessionId: 's1', data: { generation: 1, reconnected: false } });
    subscription.updateSessionCursor({ seq: 8, epoch: 'session-epoch' });
    subscription.updateTranscriptCursor('main', { seq: 32, epoch: 'transcript-epoch' });
    subscription.restart();
    await tick(10);
    expect(errors).toHaveLength(1);
    expect(server.frames.filter((frame) => frame['type'] === 'view_attach').at(-1)).toMatchObject({ data: {
      generation: 2, reconnected: true,
      input: { sessionCursor: { seq: 8, epoch: 'session-epoch' }, transcriptSince: { main: { seq: 32, epoch: 'transcript-epoch' } } },
    } });
    const before = signals.length;
    server.push({ type: 'view_signal', id: attach['id'], data: { type: 'sessionCursorAdvanced', cursor: { seq: 99 }, generation: 1 } });
    await tick(10);
    expect(signals).toHaveLength(before);
    server.disconnect();
    await tick(550);
    expect(server.sockets).toHaveLength(3);
    subscription.close();
    events.dispose();
    await klient.close();
  });

  it('reports malformed reset signals without leaking payloads or retrying indefinitely', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://127.0.0.1:58627', WebSocket: fakeWebSocket(server) });
    const view = klient.session('s1').view;
    const signals: unknown[] = [];
    const input = { sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' as const } };
    let subscription = view.subscribe(input, (signal) => signals.push(signal));
    await tick(10);
    const sendMalformed = () => {
      const attach = server.frames.filter((frame) => frame['type'] === 'view_attach').at(-1)!;
      server.push({ type: 'view_signal', id: attach['id'], data: {
        type: 'transcript', generation: 1, transcript_coverage_version: 2,
        event: { type: 'transcript.reset', privateContent: 'DO_NOT_ECHO_PAYLOAD' },
      } });
    };
    sendMalformed();
    await tick(10);
    expect(signals.at(-1)).toMatchObject({ type: 'protocolError', recoverable: true });
    subscription.close();
    subscription = view.subscribe(input, (signal) => signals.push(signal));
    await tick(10);
    sendMalformed();
    await tick(10);
    expect(signals.at(-1)).toMatchObject({ type: 'protocolError', recoverable: false });
    expect(JSON.stringify(signals)).not.toContain('DO_NOT_ECHO_PAYLOAD');
    subscription.close();
    await klient.close();
  });

  it('degrades a missing coverage echo from an old REST server without keeping an untrusted complete tool-call count', async () => {
    const pageWithoutCoverage = {
      session_id: 's1', agent_id: 'main', items: [], has_more: true, tasks: [], meta: {},
      agents: [], pending_interactions: [], tool_call_count: 7,
    };
    const pageWithCoverage = { ...pageWithoutCoverage, has_more: false, coverage: { kind: 'full', hasMoreOlder: false }, tool_call_count: 9 };
    const catchUp = {
      session_id: 's1', agent_id: 'main', epoch: 'e', through_seq: 2, complete: true,
      batches: [{ seq: 1, ops: [
        { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], meta: {}, toolCallCount: 12, toolCallCountKnown: true }, coverage: { kind: 'full', hasMoreOlder: false } },
        { op: 'tool.count.set', count: 12 },
        { op: 'meta.merge', meta: { activity: 'idle' } },
      ] }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope(pageWithoutCoverage)))
      .mockResolvedValueOnce(jsonResponse(okEnvelope(pageWithCoverage)))
      .mockResolvedValueOnce(jsonResponse(okEnvelope(catchUp)));
    const channel = new HttpChannel({ endpoint: 'http://example.test', fetch: fetchMock as typeof fetch });
    try {
      await expect(channel.sessionView.transcriptPage('s1', { agentId: 'main' })).resolves.toMatchObject({
        coverage: { kind: 'unknown', hasMoreOlder: true }, tool_call_count: undefined,
      });
      await expect(channel.sessionView.transcriptPage('s1', { agentId: 'main' })).resolves.toMatchObject({
        coverage: { kind: 'unknown', hasMoreOlder: true }, tool_call_count: undefined,
      });
      const resolved = await channel.sessionView.transcriptCatchUp('s1', { agentId: 'main', since: { seq: 0 } }) as {
        batches: Array<{ ops: Array<{ op: string; coverage?: unknown; count?: number; snapshot?: { toolCallCount?: number; toolCallCountKnown?: boolean } }> }>;
      };
      const [resetOp, countOp, mergeOp] = resolved.batches[0]!.ops;
      expect(resetOp!.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(resetOp!.snapshot?.toolCallCount).toBeUndefined();
      expect(resetOp!.snapshot?.toolCallCountKnown).toBe(false);
      expect(countOp!.op).toBe('tool.count.set');
      expect(countOp!.count).toBeUndefined();
      expect(mergeOp).toEqual({ op: 'meta.merge', meta: { activity: 'idle' } });
      for (const [url] of fetchMock.mock.calls) {
        expect(String(url)).toContain('transcript_coverage_version=2');
      }
      expect(frozenOldCoverageDecoder.safeParse({ kind: 'full', hasMoreOlder: false }).success).toBe(true);
      expect(frozenOldCoverageDecoder.safeParse({ kind: 'unknown', hasMoreOlder: true }).success).toBe(false);
    } finally { await channel.close(); }
  });

  it('degrades unconfirmed transcript resets to unknown coverage and keeps the view across reconnects', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    const signals: unknown[] = [];
    const subscription = klient.session('s1').view.subscribe({
      sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' },
    }, (signal) => signals.push(signal));
    try {
      await tick(10);
      const first = server.frames.find((frame) => frame['type'] === 'view_attach')!;
      expect(first).toMatchObject({ data: { transcript_coverage_version: 2 } });
      const reset = { type: 'transcript.reset', session_id: 's1', agent_id: 'main',
        snapshot: { items: [], tasks: [], meta: {}, toolCallCount: 42, toolCallCountKnown: true }, grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false }, cursor: { seq: 0 } };
      server.push({ type: 'view_signal', id: first['id'], data: {
        type: 'transcript', generation: 1, event: reset,
      } });
      await tick(10);
      const firstDegraded = signals.at(-1) as { type: string; event: { coverage: unknown; snapshot: { toolCallCount?: number; toolCallCountKnown?: boolean } } };
      expect(firstDegraded.event.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(firstDegraded.event.snapshot.toolCallCount).toBeUndefined();
      expect(firstDegraded.event.snapshot.toolCallCountKnown).toBe(false);
      server.disconnect();
      await tick(550);
      const second = server.frames.findLast((frame) => frame['type'] === 'view_attach')!;
      expect(second).toMatchObject({ data: { reconnected: true, generation: 2, transcript_coverage_version: 2 } });
      const transcriptCount = () => signals.filter((signal) => (signal as { type?: string }).type === 'transcript').length;
      const count = transcriptCount();
      server.push({ type: 'view_signal', id: second['id'], data: {
        type: 'transcript', generation: 2, event: { ...reset, coverage: { kind: 'tail', hasMoreOlder: true } },
      } });
      await tick(10);
      expect(transcriptCount()).toBe(count + 1);
      const secondDegraded = signals.at(-1) as { type: string; event: { coverage: unknown; snapshot: { toolCallCount?: number; toolCallCountKnown?: boolean } } };
      expect(secondDegraded.event.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(secondDegraded.event.snapshot.toolCallCount).toBeUndefined();
      expect(secondDegraded.event.snapshot.toolCallCountKnown).toBe(false);
      expect(signals.some((signal) => (signal as { type?: string }).type === 'protocolError')).toBe(false);
      expect(server.frames.some((frame) => frame['type'] === 'view_detach')).toBe(false);
    } finally { subscription.close(); await klient.close(); }
  });

  it('delivers marker-less non-transcript signals and confirmed coverage unchanged, degrading only unconfirmed resets', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({ endpoint: 'http://example.test', WebSocket: fakeWebSocket(server) });
    const signals: unknown[] = [];
    const subscription = klient.session('s1').view.subscribe({
      sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' },
    }, (signal) => signals.push(signal));
    try {
      await tick(10);
      const attach = server.frames.find((frame) => frame['type'] === 'view_attach')!;
      server.push({ type: 'view_signal', id: attach['id'], data: {
        type: 'sessionCursorAdvanced', cursor: { seq: 3 }, generation: 1,
      } });
      await tick(10);
      expect(signals.at(-1)).toMatchObject({ type: 'sessionCursorAdvanced', cursor: { seq: 3 } });
      server.push({ type: 'view_signal', id: attach['id'], data: {
        type: 'transcript', generation: 1, transcript_coverage_version: 2,
        event: { type: 'transcript.reset', session_id: 's1', agent_id: 'main',
          snapshot: { items: [], tasks: [], meta: {}, toolCallCount: 5, toolCallCountKnown: true }, grade: 'delta',
          coverage: { kind: 'tail', hasMoreOlder: true }, cursor: { seq: 1 } },
      } });
      await tick(10);
      const confirmed = signals.at(-1) as { type: string; event: { coverage: unknown; snapshot: { toolCallCount?: number; toolCallCountKnown?: boolean } } };
      expect(confirmed.event.coverage).toEqual({ kind: 'tail', hasMoreOlder: true });
      expect(confirmed.event.snapshot.toolCallCount).toBe(5);
      expect(confirmed.event.snapshot.toolCallCountKnown).toBe(true);
      server.push({ type: 'view_signal', id: attach['id'], data: {
        type: 'transcript', generation: 1,
        event: { type: 'transcript.ops', session_id: 's1', agent_id: 'main', cursor: { seq: 2 }, through_seq: 2,
          ops: [
            { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], meta: {}, toolCallCount: 3, toolCallCountKnown: true }, coverage: { kind: 'full', hasMoreOlder: false } },
            { op: 'tool.count.set', count: 3 },
            { op: 'meta.merge', meta: { activity: 'idle' } },
          ] },
      } });
      await tick(10);
      const opsSignal = signals.at(-1) as { type: string; event: { ops: Array<{ op: string; coverage?: unknown; count?: number; snapshot?: { toolCallCount?: number; toolCallCountKnown?: boolean } }> } };
      expect(opsSignal).toMatchObject({ type: 'transcript' });
      const [resetOp, countOp, mergeOp] = opsSignal.event.ops;
      expect(resetOp!.coverage).toEqual({ kind: 'unknown', hasMoreOlder: true });
      expect(resetOp!.snapshot?.toolCallCount).toBeUndefined();
      expect(resetOp!.snapshot?.toolCallCountKnown).toBe(false);
      expect(countOp!.op).toBe('tool.count.set');
      expect(countOp!.count).toBeUndefined();
      expect(mergeOp).toEqual({ op: 'meta.merge', meta: { activity: 'idle' } });
      expect(signals.some((signal) => (signal as { type?: string }).type === 'protocolError')).toBe(false);
    } finally { subscription.close(); await klient.close(); }
  });

  it('projects named session approvals and idempotent cancellation without losing errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ resolved: true, resolved_at: '2026-01-01T00:00:00.000Z' })))
      .mockResolvedValueOnce(jsonResponse({ code: 40904, msg: 'already finished', data: { cancelled: false }, request_id: 'r-cancel' }))
      .mockResolvedValueOnce(jsonResponse({ code: 40902, msg: 'already resolved', data: { resolved: false }, request_id: 'r-approval' }));
    const klient = createKlient({ endpoint: 'http://127.0.0.1:58627', fetch: fetchMock as typeof fetch });
    const commands = klient.session('s1').commands;
    const choice = { decision: 'approved' as const, selected_option_id: 'allow-once' };
    await expect(commands.approve('approval/1', choice)).resolves.toMatchObject({ resolved: true });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:58627/api/sessions/s1/approvals/approval%2F1');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual(choice);
    await expect(commands.cancelTask('task1', { agent_id: 'agent-a' })).resolves.toEqual({
      cancelled: false,
    });
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      '/api/sessions/s1/tasks/task1:cancel?agent_id=agent-a',
    );
    await expect(commands.approve('approval/1', choice)).rejects.toMatchObject({
      code: 40902, requestId: 'r-approval', data: { resolved: false },
    });
    await klient.close();
  });

  it('POSTs one procedure with positional params and bearer auth', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          okEnvelope({
            id: 's1',
            workspaceId: 'w1',
            createdAt: 1,
            updatedAt: 2,
            archived: false,
          }),
        ),
      ),
    );
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627/',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const summary = await klient.global.sessions.get('s1');
    expect(summary?.id).toBe('s1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:58627/api/klient/call');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      procedure: {
        scope: 'core',
        service: 'sessionIndex',
        method: 'get',
      },
      params: ['s1'],
    });
    await klient.close();
  });

  it('sends an empty params array for zero-argument procedures', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({}))));
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await klient.global.config.getAll();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ params: [] });
    await klient.close();
  });

  it('unwraps non-zero envelopes and validates successful outputs', async () => {
    const errorFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          code: 40001,
          msg: 'workspace not found',
          data: null,
          request_id: 'r',
          reason: 'request.invalid',
        }),
      ),
    );
    const errorKlient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: errorFetch as unknown as typeof fetch,
    });
    await expect(errorKlient.global.workspaces.get('nope')).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
      reason: 'request.invalid',
    });
    await errorKlient.close();

    const driftFetch = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({ id: 42 }))));
    const driftKlient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: driftFetch as unknown as typeof fetch,
    });
    await expect(driftKlient.global.sessions.get('s1')).rejects.toBeInstanceOf(
      KlientValidationError,
    );
    await driftKlient.close();
  });

  it('maps deadlines and caller AbortSignal to fetch abort', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(channel.call({}, 'service', 'slow', [], { timeoutMs: 10 })).rejects.toThrow(
      'call timed out after 10ms',
    );
    expect(signals[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const call = channel.call({}, 'service', 'cancelled', [], {
      timeoutMs: 0,
      signal: controller.signal,
    });
    controller.abort(new Error('caller cancelled'));
    await expect(call).rejects.toThrow('aborted');
    expect(signals[1]?.aborted).toBe(true);
    await channel.close();
  });

  it('keeps the deadline active while the response JSON body is pending', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return Promise.resolve(hangingJsonResponse(signal, 'body timeout'));
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      timeoutMs: 10,
      fetch: fetchMock as unknown as typeof fetch,
    });
    try {
      const call = channel.call({}, 'service', 'bodySlow', []).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      const failure = await call;
      expect(failure).toMatchObject({
        name: 'RPCError',
        code: 50001,
        reason: HTTP_TRANSPORT_TIMEOUT_REASON,
      });
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      await channel.close();
      vi.useRealTimers();
    }
  });

  it('keeps the deadline active while a raw media body is pending', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return Promise.resolve(hangingJsonResponse(signal, 'raw body timeout', 'image/png'));
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      timeoutMs: 10,
      fetch: fetchMock as unknown as typeof fetch,
    });
    try {
      const media = channel.rest.sessions.media('s1', 'f1').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      const failure = await media;
      expect(failure).toMatchObject({
        name: 'RPCError',
        code: 50001,
        reason: HTTP_TRANSPORT_TIMEOUT_REASON,
      });
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      await channel.close();
      vi.useRealTimers();
    }
  });

  it('keeps caller abort and channel close active while the response body is pending', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return Promise.resolve(hangingJsonResponse(signal, 'body cancelled'));
    });
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const caller = new AbortController();
    try {
      const cancelled = channel.call({}, 'service', 'bodyCancelled', [], {
        timeoutMs: 0,
        signal: caller.signal,
      }).catch((error: unknown) => error);
      await Promise.resolve();
      caller.abort(new Error('caller cancelled'));
      const cancelledFailure = await cancelled;
      expect(cancelledFailure).toMatchObject({ name: 'AbortError', message: 'body cancelled' });
      expect(signals[0]?.aborted).toBe(true);

      const closing = channel.call({}, 'service', 'bodyClosed', [], { timeoutMs: 0 })
        .catch((error: unknown) => error);
      await Promise.resolve();
      await channel.close();
      const closingFailure = await closing;
      expect(closingFailure).toMatchObject({ message: 'http closed' });
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      await channel.close();
    }
  });

  it('shares one lazy event socket and restores active subscriptions after reconnect', async () => {
    const server = new FakeWebSocketServer();
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      token: 'tok',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const events: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => errors.push(error));
    const subscription = klient.events.on('kosong.providers.changed', (event) => events.push(event));
    await tick(10);

    expect(server.lastUrl).toBe('ws://127.0.0.1:58627/api/klient/events');
    expect(server.lastProtocols).toEqual(['kimi-code.bearer.tok']);
    expect(server.frames.filter((frame) => frame['type'] === 'subscribe')).toHaveLength(1);
    expect(server.frames.find((frame) => frame['type'] === 'subscribe')).toMatchObject({
      scope: 'core',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    server.pushEvent({ added: ['p1'], removed: [], changed: [] });
    await tick(10);
    expect(events).toEqual([{ added: ['p1'], removed: [], changed: [] }]);

    server.disconnect();
    await tick(550);
    await tick(10);
    expect(server.sockets).toHaveLength(2);
    expect(server.frames.filter((frame) => frame['type'] === 'subscribe')).toHaveLength(2);
    expect(errors).toHaveLength(1);

    server.pushEvent({ added: ['p2'], removed: [], changed: [] });
    await tick(10);
    expect(events).toHaveLength(2);

    subscription.dispose();
    expect(server.frames.at(-1)).toMatchObject({ type: 'unsubscribe' });
    await klient.close();
  });

  it('recovers a missed state change after reconnect without replaying ordinary events', async () => {
    const server = new FakeWebSocketServer();
    let state = { revision: 1 };
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope(state))));
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const seen: unknown[] = [];
    const ordinary = vi.fn();
    klient.events.on('config.changed', ordinary);
    klient.events.observe({ events: ['config.changed'], read: () => klient.global.config.getAll() },
      (snapshot) => seen.push(snapshot));
    await tick(10);
    expect(seen).toEqual([{ revision: 1 }]);
    server.disconnect();
    state = { revision: 2 };
    await tick(550);
    await tick(10);
    expect(seen).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(ordinary).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await klient.close();
  });

  it('does not read or publish on unsuccessful subscribe, or acknowledge a disposed listen', async () => {
    const server = new FakeWebSocketServer();
    server.subscribeError = 'unknown event source';
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:58627',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const read = vi.fn(() => Promise.resolve('idle'));
    const publish = vi.fn();
    const errors: Error[] = [];
    klient.events.onError((error) => errors.push(error));
    klient.events.observe({ events: ['config.changed'], read }, publish);
    await tick(10);
    expect(errors[0]?.message).toBe('unknown event source');
    expect(read).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await klient.close();
    server.subscribeError = undefined;
    const channel = new HttpChannel({ endpoint: 'http://127.0.0.1:58627', WebSocket: fakeWebSocket(server) });
    const ready = vi.fn();
    const sub = channel.listen({}, { kind: 'stream', name: 'events' }, vi.fn(), vi.fn(), ready);
    sub.dispose();
    await tick(10);
    expect(ready).not.toHaveBeenCalled();
    await channel.close();
  });

  it('carries streaming procedures over the event socket', async () => {
    const server = new FakeWebSocketServer();
    const channel = new HttpChannel({
      endpoint: 'http://127.0.0.1:58627',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: fakeWebSocket(server),
    });
    const iterator = channel.stream({}, 'modelResolver', 'generate', ['m', {}, {}])[
      Symbol.asyncIterator
    ]();
    const first = iterator.next();
    await tick(10);
    const frame = server.frames.find((item) => item['type'] === 'stream');
    expect(frame).toMatchObject({
      scope: 'core',
      service: 'modelResolver',
      method: 'generate',
    });
    server.push({ type: 'stream_data', id: frame?.['id'], data: { type: 'text', text: 'ok' } });
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: 'text', text: 'ok' },
    });
    const end = iterator.next();
    server.push({ type: 'stream_end', id: frame?.['id'] });
    await expect(end).resolves.toEqual({ done: true, value: undefined });
    await channel.close();
  });
});

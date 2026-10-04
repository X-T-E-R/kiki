import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ContextMessage,
  type Event2,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IEventBus,
  IWireService,
  getLiveSessionById,
  closeSessionById,
  resumeSessionById,
} from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  applyContentSegment,
  jsonBytes,
  type ContentSegment,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptDetailListResponse,
  type TranscriptOperation,
  type TranscriptTask,
} from '@kiki/transcript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Frame {
  type: string;
  id?: string;
  seq?: number;
  epoch?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
  volatile?: boolean;
  offset?: number;
}

interface Conn {
  ws: WebSocket;
  frames: Frame[];
  waiters: Array<(f: Frame) => void>;
  closed: Promise<void>;
  send: (f: unknown) => void;
  next: (pred: (f: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
}

interface AckPayload {
  accepted_subscriptions?: string[];
  accepted?: string[];
  resync_required?: string[];
  cursors?: Record<string, { seq: number; epoch?: string }>;
}

interface TranscriptResetPayload {
  agent_id: string;
  snapshot: AgentTranscriptSnapshot;
  grade: 'turn' | 'block' | 'delta';
  coverage: TranscriptCoverage;
  cursor: TranscriptCursor;
}

interface TranscriptOpsPayload {
  agent_id: string;
  ops: TranscriptOperation[];
  cursor: TranscriptCursor;
  through_seq: number;
}

interface TranscriptResponse {
  items: Array<{ kind: string; turnId?: string; state?: string }>;
}

function openConn(url: string, token: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const frames: Frame[] = [];
    const waiters: Array<(f: Frame) => void> = [];
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    ws.on('message', (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse((data as Buffer).toString()) as Frame;
      } catch {
        return;
      }
      const w = waiters.shift();
      if (w) w(frame);
      else frames.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        waiters,
        closed,
        send: (f) => ws.send(JSON.stringify(f)),
        next: (pred, timeoutMs = 2000) =>
          new Promise((res, rej) => {
            const idx = frames.findIndex(pred);
            if (idx >= 0) {
              res(frames.splice(idx, 1)[0]!);
              return;
            }
            const deadline = Date.now() + timeoutMs;
            let t: ReturnType<typeof setTimeout>;
            const waiter = (f: Frame): void => {
              clearTimeout(t);
              if (pred(f)) res(f);
              else {
                frames.push(f);
                waiters.push(waiter);
                arm();
              }
            };
            const arm = (): void => {
              const left = deadline - Date.now();
              if (left <= 0) {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                rej(
                  new Error(
                    `timeout waiting for frame; buffered=${frames.map((frame) => frame.type).join(',')}`,
                  ),
                );
                return;
              }
              t = setTimeout(() => {
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                rej(
                  new Error(
                    `timeout waiting for frame; buffered=${frames.map((frame) => frame.type).join(',')}`,
                  ),
                );
              }, left);
            };
            arm();
            waiters.push(waiter);
          }),
      }),
    );
    ws.once('error', reject);
  });
}

function ackPayload(frame: Frame): AckPayload {
  return frame.payload as AckPayload;
}

function transcriptResetPayload(frame: Frame): TranscriptResetPayload {
  return frame.payload as unknown as TranscriptResetPayload;
}

function transcriptOpsPayload(frame: Frame): TranscriptOpsPayload {
  return frame.payload as unknown as TranscriptOpsPayload;
}

function applyTranscriptFrame(transcript: AgentTranscript, frame: Frame): void {
  if (frame.type === 'transcript.reset') {
    const payload = transcriptResetPayload(frame);
    transcript.receive([
      {
        op: 'reset',
        agentId: payload.agent_id,
        snapshot: payload.snapshot,
        grade: payload.grade,
        coverage: payload.coverage,
      },
    ]);
    return;
  }
  transcript.apply(transcriptOpsPayload(frame).ops);
}

function turnOutcomes(transcript: AgentTranscript): Array<{ turnId: string; state: string }> {
  return transcript
    .getItems()
    .filter((item) => item.kind === 'turn')
    .map((item) => ({ turnId: item.turnId, state: item.state }));
}

function responseTurnOutcomes(response: TranscriptResponse): Array<{ turnId: string; state: string }> {
  return response.items
    .filter((item) => item.kind === 'turn')
    .map((item) => ({ turnId: item.turnId!, state: item.state! }));
}

function integerRange(from: number, through: number): number[] {
  return Array.from({ length: Math.max(through - from + 1, 0) }, (_, index) => from + index);
}

describe('server-v2 /api/ws resync', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  async function boot(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/ws`;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-wsv1-test-'));
    await boot();
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function getTranscript(sessionId: string): Promise<TranscriptResponse> {
    const res = await fetch(`${base}/api/sessions/${sessionId}/transcript?agent_id=main&transcript_coverage_version=2`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: TranscriptResponse };
    expect(body.code).toBe(0);
    return body.data;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) {
      await agents.create({ agentId: 'main' });
    }
  }

  async function seedMainAgentMessages(
    sessionId: string,
    messages: readonly ContextMessage[],
  ): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(main).toBeDefined();
    main!.accessor.get(IAgentContextMemoryService).append(...messages);
    await main!.accessor.get(IWireService).flush();
  }

  function withToken<T extends Record<string, unknown>>(payload: T): T & { token: string } {
    return { ...payload, token: server!.localOwnerToken };
  }

  function emitAgentEvent(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const main = agents.get('main');
    expect(main).toBeDefined();
    main!.accessor.get(IEventBus).publish(event);
  }

  it('restores oversized cold history through HTTP and atomic WS resets without losing tasks or reconnecting', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const main = getLiveSessionById(server!.core.accessor, sid)!.accessor.get(IAgentLifecycleService).get('main')!;
    const wire = main.accessor.get(IWireService);
    for (let turnId = 1; turnId <= 249; turnId += 1) {
      wire.appendRecord({ type: 'turn.prompt', turnId, input: [{ type: 'text', text: `Example turn ${turnId}` }], origin: { kind: 'user' } });
      wire.appendRecord({ type: 'turn.ended', turnId, reason: 'completed' });
    }
    const summary = 'Example complete task result 😀 '.repeat(400);
    for (let index = 0; index < 438; index += 1) {
      wire.appendRecord({ type: 'subagent.started', subagentId: `example-task-${index}` });
      wire.appendRecord({ type: 'subagent.completed', subagentId: `example-task-${index}`, resultSummary: `${index}:${summary}` });
    }
    await wire.flush();
    await closeSessionById(server!.core.accessor, sid);
    const snapshotResponse = await fetch(`${base}/api/sessions/${sid}/snapshot?mode=transcript`, {
      headers: authHeaders(server as RunningServer),
    });
    expect(snapshotResponse.status).toBe(200);
    expect((await snapshotResponse.json() as { code: number }).code).toBe(0);
    const history = new Set<string>();
    let before: string | undefined;
    async function completeTask(preview: TranscriptTask): Promise<TranscriptTask> {
      let task = preview;
      while (task.contentRefs?.length) {
        const response = await fetch(`${base}/api/klient/session-view/${sid}/transcript/content`, {
          method: 'POST', headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
          body: JSON.stringify({ agentId: 'main', ref: task.contentRefs[0] }),
        });
        const body = await response.json() as { code: number; data: ContentSegment };
        expect(body.code).toBe(0);
        expect(jsonBytes(body)).toBeLessThan(64 * 1024);
        task = applyContentSegment(task, body.data);
      }
      return task;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const c = await openConn(wsUrl, server!.localOwnerToken);
      try {
        await c.next((frame) => frame.type === 'server_hello');
        c.send({ type: 'client_hello', id: 'hello', payload: withToken({ client_id: 'example-client' }) });
        await c.next((frame) => frame.type === 'ack' && frame.id === 'hello');
        c.send({ type: 'subscribe_v2', id: 'seed', payload: { session_id: sid, transcript: { '*': 'off', main: 'delta' }, transcript_coverage_version: 2 } });
        const reset = await c.next((frame) => frame.type === 'transcript.reset', 20_000);
        expect(jsonBytes(reset)).toBeLessThan(88 * 1024);
        const payload = transcriptResetPayload(reset);
        expect(jsonBytes(payload.snapshot)).toBeLessThan(64 * 1024);
        const transcript = new AgentTranscript('main');
        applyTranscriptFrame(transcript, reset);
        expect(transcript.snapshot().tasks).toEqual(payload.snapshot.tasks);
        expect(payload.snapshot.tasks.length).toBeGreaterThan(0);
        expect(payload.snapshot.globalCoverage?.tasks).toMatchObject({ returned: payload.snapshot.tasks.length, hasMore: true });
        expect(payload.snapshot.globalCoverage!.tasks.total).toBeGreaterThan(payload.snapshot.tasks.length);
        expect(payload.snapshot.globalCoverage!.tasks.total).toBeLessThanOrEqual(438);
        expect(payload.snapshot.taskRefs).toBeUndefined();
        for (const preview of transcript.snapshot().tasks) {
          expect(preview.contentRefs?.length).toBeGreaterThan(0);
          const task = await completeTask(preview);
          const index = Number(task.taskId.slice('example-task-'.length));
          expect(task.resultSummary).toBe(`${index}:${summary}`);
        }
        expect(payload.snapshot.items.length).toBeGreaterThan(0);
        expect(payload.coverage.hasMoreOlder).toBe(true);
        expect(payload.snapshot.olderCursor).toBeTypeOf('string');
        if (attempt === 0) {
          for (const item of payload.snapshot.items) if (item.kind === 'turn') history.add(item.turnId);
          before = payload.snapshot.olderCursor;
        }
        await c.next((frame) => frame.type === 'ack' && frame.id === 'seed');
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        c.ws.close();
        await c.closed;
      }
    }
    const tasks = new Map<string, TranscriptTask>();
    const taskCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ agent_id: 'main', kind: 'task', limit: '100' });
      if (cursor !== undefined) params.set('cursor', cursor);
      const details = await fetch(`${base}/api/sessions/${sid}/transcript/details?${params}`, {
        headers: authHeaders(server as RunningServer),
      });
      const body = await details.json() as { code: number; data: Extract<TranscriptDetailListResponse, { kind: 'task' }> };
      expect(body.code).toBe(0);
      expect(jsonBytes(body)).toBeLessThan(64 * 1024);
      expect(body.data.total).toBe(438);
      expect(body.data.items.length).toBeGreaterThan(0);
      for (const preview of body.data.items) {
        expect(tasks.has(preview.taskId)).toBe(false);
        tasks.set(preview.taskId, await completeTask(preview));
      }
      cursor = body.data.next_cursor;
      expect(body.data.has_more).toBe(cursor !== undefined);
      if (cursor !== undefined) {
        expect(taskCursors.has(cursor)).toBe(false);
        taskCursors.add(cursor);
      }
    } while (cursor !== undefined);
    expect(tasks.size).toBe(438);
    for (let index = 0; index < 438; index += 1) {
      expect(tasks.get(`example-task-${index}`)?.resultSummary).toBe(`${index}:${summary}`);
    }
    const historyCursors = new Set<string>();
    while (before !== undefined) {
      expect(historyCursors.has(before)).toBe(false);
      historyCursors.add(before);
      const params = new URLSearchParams({ agent_id: 'main', before_item: before, page_size: '20', transcript_coverage_version: '2' });
      const older = await fetch(`${base}/api/sessions/${sid}/transcript?${params}`, {
        headers: authHeaders(server as RunningServer),
      });
      const body = await older.json() as { code: number; data: TranscriptResponse & { has_more: boolean; next_cursor?: string } };
      expect(body.code).toBe(0);
      expect(jsonBytes(body)).toBeLessThan(88 * 1024);
      expect(body.data.items.length).toBeGreaterThan(0);
      for (const turn of body.data.items.filter((item) => item.kind === 'turn')) {
        expect(history.has(turn.turnId!)).toBe(false);
        history.add(turn.turnId!);
      }
      before = body.data.next_cursor;
      expect(body.data.has_more).toBe(before !== undefined);
    }
    expect([...history].toSorted()).toEqual(integerRange(1, 249).map((id) => `t${id}`).toSorted());
  }, 120_000);

  it('server_hello then client_hello ack with accepted subscription', async () => {
    const sid = await createSession();
    const c = await openConn(wsUrl, server!.localOwnerToken);

    const hello = await c.next((f) => f.type === 'server_hello');
    expect(hello.payload).toMatchObject({ protocol_version: 2 });

    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({ client_id: 'cli', subscriptions: [sid] }),
    });
    const ack = await c.next((f) => f.type === 'ack' && f.id === 'h1');
    expect(ack.payload).toMatchObject({ accepted_subscriptions: [sid], resync_required: [] });

    c.ws.close();
    await c.closed;
  });

  it('delivers a sequenced durable event to a subscribed connection', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    const c = await openConn(wsUrl, server!.localOwnerToken);
    await c.next((f) => f.type === 'server_hello');
    c.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    emitAgentEvent(sid, { type: 'turn.started', turnId: 1, origin: { kind: 'user' } } as unknown as Event2<any>);

    const ev = await c.next((f) => f.type === 'turn.started');
    expect(ev.seq).toBeGreaterThanOrEqual(1);
    expect(ev.session_id).toBe(sid);
    expect(ev.volatile).toBeUndefined();

    c.ws.close();
    await c.closed;
  });

  it('replays durable events since a cursor on reconnect', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);

    const c1 = await openConn(wsUrl, server!.localOwnerToken);
    await c1.next((f) => f.type === 'server_hello');
    c1.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c1.next((f) => f.type === 'ack' && f.id === 'h1');
    emitAgentEvent(sid, { type: 'turn.started', turnId: 1, origin: { kind: 'user' } } as unknown as Event2<any>);
    emitAgentEvent(sid, { type: 'turn.ended', turnId: 1 } as unknown as Event2<any>);
    await c1.next((f) => f.type === 'turn.ended');
    c1.ws.close();
    await c1.closed;

    const c2 = await openConn(wsUrl, server!.localOwnerToken);
    await c2.next((f) => f.type === 'server_hello');
    c2.send({
      type: 'client_hello',
      id: 'h2',
      payload: withToken({ client_id: 'cli', subscriptions: [sid], cursors: { [sid]: { seq: 1 } } }),
    });
    const replayed = await c2.next((f) => f.type === 'turn.ended');
    expect(replayed.seq).toBeGreaterThanOrEqual(2);
    const ack2 = await c2.next((f) => f.type === 'ack' && f.id === 'h2');
    expect(ack2.payload).toMatchObject({ accepted_subscriptions: [sid] });

    c2.ws.close();
    await c2.closed;
  });

  it('sends resync_required on epoch mismatch', async () => {
    const sid = await createSession();
    const c = await openConn(wsUrl, server!.localOwnerToken);
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        cursors: { [sid]: { seq: 0, epoch: 'ep_wrong' } },
      }),
    });
    const rs = await c.next((f) => f.type === 'resync_required');
    expect(rs.payload).toMatchObject({ session_id: sid, reason: 'epoch_changed' });

    c.ws.close();
    await c.closed;
  });

  it(
    'replays disconnected cursors and restores terminal transcript after an epoch change',
    { timeout: 20_000 },
    async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await seedMainAgentMessages(sid, [
      { role: 'user', content: [{ type: 'text', text: 'first prompt' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], toolCalls: [] },
    ]);

    const liveTranscript = new AgentTranscript('main');
    const c1 = await openConn(wsUrl, server!.localOwnerToken);
    await c1.next((f) => f.type === 'server_hello');
    c1.send({
      type: 'client_hello',
      id: 'h-live',
      payload: withToken({ client_id: 'cli', subscriptions: [sid] }),
    });
    const helloAck = await c1.next((f) => f.type === 'ack' && f.id === 'h-live');
    const helloAckPayload = ackPayload(helloAck);
    expect(helloAckPayload).toMatchObject({
      accepted_subscriptions: [sid],
      resync_required: [],
    });
    const durableCursor = helloAckPayload.cursors![sid]!;

    c1.send({
      type: 'subscribe_v2',
      id: 't-live',
      payload: { session_id: sid, transcript: { main: 'delta' }, transcript_coverage_version: 2 },
    });
    const transcriptAck = await c1.next((f) => f.type === 'ack' && f.id === 't-live');
    expect(ackPayload(transcriptAck)).toMatchObject({ accepted: [sid], resync_required: [], transcript_coverage_version: 2 });
    const reset = await c1.next(
      (f) => f.type === 'transcript.reset' && transcriptResetPayload(f).agent_id === 'main',
    );
    applyTranscriptFrame(liveTranscript, reset);
    expect(turnOutcomes(liveTranscript)).toEqual([{ turnId: 't0', state: 'completed' }]);

    emitAgentEvent(
      sid,
      { type: 'turn.started', turnId: 1, origin: { kind: 'user' } } as unknown as Event2<any>,
    );
    const runningOps = await c1.next(
      (f) =>
        f.type === 'transcript.ops' &&
        transcriptOpsPayload(f).agent_id === 'main' &&
        transcriptOpsPayload(f).ops.some(
          (operation) =>
            operation.op === 'turn.upsert' &&
            operation.turn.turnId === 't1' &&
            operation.turn.state === 'running',
        ),
    );
    applyTranscriptFrame(liveTranscript, runningOps);
    expect(turnOutcomes(liveTranscript)).toEqual([
      { turnId: 't0', state: 'completed' },
      { turnId: 't1', state: 'running' },
    ]);
    const transcriptCursor = transcriptOpsPayload(runningOps).cursor;

    c1.ws.close();
    await c1.closed;

    emitAgentEvent(
      sid,
      { type: 'turn.ended', turnId: 1, reason: 'completed' } as unknown as Event2<any>,
    );
    await seedMainAgentMessages(sid, [
      { role: 'user', content: [{ type: 'text', text: 'second prompt' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], toolCalls: [] },
    ]);

    const c2 = await openConn(wsUrl, server!.localOwnerToken);
    await c2.next((f) => f.type === 'server_hello');
    c2.send({
      type: 'client_hello',
      id: 'h-replay',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        cursors: { [sid]: durableCursor },
      }),
    });
    const replayAck = await c2.next((f) => f.type === 'ack' && f.id === 'h-replay');
    const replayAckPayload = ackPayload(replayAck);
    expect(replayAckPayload).toMatchObject({
      accepted_subscriptions: [sid],
      resync_required: [],
    });
    const replayWatermark = replayAckPayload.cursors![sid]!;
    const replayedDurable = c2.frames.filter(
      (frame) =>
        frame.session_id === sid &&
        frame.volatile !== true &&
        typeof frame.seq === 'number' &&
        frame.seq > durableCursor.seq,
    );
    const durableSeqs = replayedDurable.map((frame) => frame.seq!);
    expect(durableSeqs).toEqual(integerRange(durableCursor.seq + 1, replayWatermark.seq));
    expect(
      replayedDurable.filter(
        (frame) => frame.type === 'turn.ended' && frame.payload?.['turnId'] === 1,
      ),
    ).toHaveLength(1);

    c2.send({
      type: 'subscribe_v2',
      id: 't-replay',
      payload: {
        session_id: sid,
        transcript: { main: 'delta' },
        transcript_coverage_version: 2,
        transcript_since: { main: transcriptCursor },
      },
    });
    const replayTranscriptAck = await c2.next(
      (f) => f.type === 'ack' && f.id === 't-replay',
    );
    expect(ackPayload(replayTranscriptAck)).toMatchObject({ accepted: [sid], resync_required: [] });
    const detailBaseline = await c2.next(
      (frame) => frame.type === 'transcript.reset' && transcriptResetPayload(frame).agent_id === 'main',
    );
    expect(transcriptResetPayload(detailBaseline).grade).toBe('delta');
    expect(transcriptResetPayload(detailBaseline).cursor.seq).toBeGreaterThan(transcriptCursor.seq);
    expect(c2.frames.filter((frame) => frame.type === 'transcript.reset')).toHaveLength(0);
    applyTranscriptFrame(liveTranscript, detailBaseline);
    c2.ws.close();
    await c2.closed;

    const liveOutcomes = turnOutcomes(liveTranscript);
    expect(liveOutcomes).toEqual([
      { turnId: 't0', state: 'completed' },
      { turnId: 't1', state: 'completed' },
    ]);
    expect(new Set(liveOutcomes.map((turn) => turn.turnId)).size).toBe(liveOutcomes.length);
    expect(liveOutcomes.some((turn) => turn.state === 'running')).toBe(false);

    await server!.close();
    server = undefined;
    await writeFile(join(home!, 'server', 'events', `${sid}.jsonl`), 'corrupt\n', 'utf8');
    await boot();
    expect(await resumeSessionById(server!.core.accessor, sid)).toBeDefined();

    const c3 = await openConn(wsUrl, server!.localOwnerToken);
    await c3.next((f) => f.type === 'server_hello');
    c3.send({
      type: 'client_hello',
      id: 'h-epoch',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        cursors: { [sid]: replayWatermark },
      }),
    });
    const epochAck = await c3.next((f) => f.type === 'ack' && f.id === 'h-epoch');
    const epochAckPayload = ackPayload(epochAck);
    expect(epochAckPayload).toMatchObject({
      accepted_subscriptions: [sid],
      resync_required: [sid],
    });
    expect(epochAckPayload.cursors![sid]!.epoch).not.toBe(replayWatermark.epoch);
    const resync = await c3.next((f) => f.type === 'resync_required');
    expect(resync.payload).toMatchObject({ session_id: sid, reason: 'epoch_changed' });

    c3.send({
      type: 'subscribe_v2',
      id: 't-epoch',
      payload: {
        session_id: sid,
        transcript: { main: 'delta' },
        transcript_coverage_version: 2,
        transcript_since: { main: transcriptCursor },
      },
    });
    const resumedTranscriptAck = await c3.next(
      (f) => f.type === 'ack' && f.id === 't-epoch',
    );
    expect(ackPayload(resumedTranscriptAck)).toMatchObject({ accepted: [sid] });
    const resumedReset = await c3.next(
      (f) => f.type === 'transcript.reset' && transcriptResetPayload(f).agent_id === 'main',
    );
    expect(transcriptResetPayload(resumedReset).cursor.epoch).not.toBe(transcriptCursor.epoch);
    const resumedTranscript = new AgentTranscript('main');
    applyTranscriptFrame(resumedTranscript, resumedReset);
    const resumedOutcomes = turnOutcomes(resumedTranscript);
    const restOutcomes = responseTurnOutcomes(await getTranscript(sid));

    expect(resumedOutcomes).toEqual(liveOutcomes);
    expect(restOutcomes).toEqual(liveOutcomes);
    expect(resumedOutcomes.some((turn) => turn.state === 'running')).toBe(false);
    expect(new Set(resumedOutcomes.map((turn) => turn.turnId)).size).toBe(
      resumedOutcomes.length,
    );

    c3.ws.close();
    await c3.closed;
  });

  it('delivers only the allowlisted agent events via agent_filter', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);

    const session = getLiveSessionById(server!.core.accessor, sid);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const sub = await agents.create({ agentId: 'agent-0' });

    const c = await openConn(wsUrl, server!.localOwnerToken);
    await c.next((f) => f.type === 'server_hello');
    c.send({
      type: 'client_hello',
      id: 'h1',
      payload: withToken({
        client_id: 'cli',
        subscriptions: [sid],
        agent_filter: { [sid]: ['main'] },
      }),
    });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    agents
      .get('main')!
      .accessor.get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 1 } as unknown as Event2<any>);
    sub.accessor
      .get(IEventBus)
      .publish({ type: 'turn.ended', turnId: 2 } as unknown as Event2<any>);

    const ev = await c.next((f) => f.type === 'turn.ended');
    expect(ev.payload).toMatchObject({ agentId: 'main' });

    await expect(c.next((f) => f.type === 'turn.ended', 300)).rejects.toThrow();

    c.ws.close();
    await c.closed;
  });
});

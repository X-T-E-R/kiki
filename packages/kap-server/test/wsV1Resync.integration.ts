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
  resumeSessionById,
} from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptOperation,
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

describe('server-v2 /api/v1/ws resync', () => {
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
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
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
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function getTranscript(sessionId: string): Promise<TranscriptResponse> {
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/transcript?agent_id=main`, {
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
    return { ...payload, token: server!.authTokenService.getToken() };
  }

  function emitAgentEvent(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    expect(session).toBeDefined();
    const agents = session!.accessor.get(IAgentLifecycleService);
    const main = agents.get('main');
    expect(main).toBeDefined();
    main!.accessor.get(IEventBus).publish(event);
  }

  it('server_hello then client_hello ack with accepted subscription', async () => {
    const sid = await createSession();
    const c = await openConn(wsUrl, server!.authTokenService.getToken());

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
    const c = await openConn(wsUrl, server!.authTokenService.getToken());
    await c.next((f) => f.type === 'server_hello');
    c.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c.next((f) => f.type === 'ack' && f.id === 'h1');

    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);

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

    const c1 = await openConn(wsUrl, server!.authTokenService.getToken());
    await c1.next((f) => f.type === 'server_hello');
    c1.send({ type: 'client_hello', id: 'h1', payload: withToken({ client_id: 'cli', subscriptions: [sid] }) });
    await c1.next((f) => f.type === 'ack' && f.id === 'h1');
    emitAgentEvent(sid, { type: 'turn.started', turnId: 1 } as unknown as Event2<any>);
    emitAgentEvent(sid, { type: 'turn.ended', turnId: 1 } as unknown as Event2<any>);
    await c1.next((f) => f.type === 'turn.ended');
    c1.ws.close();
    await c1.closed;

    const c2 = await openConn(wsUrl, server!.authTokenService.getToken());
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
    const c = await openConn(wsUrl, server!.authTokenService.getToken());
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
    const c1 = await openConn(wsUrl, server!.authTokenService.getToken());
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
      payload: { session_id: sid, transcript: { main: 'delta' } },
    });
    const transcriptAck = await c1.next((f) => f.type === 'ack' && f.id === 't-live');
    expect(ackPayload(transcriptAck)).toMatchObject({ accepted: [sid], resync_required: [] });
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

    const c2 = await openConn(wsUrl, server!.authTokenService.getToken());
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
        transcript_since: { main: transcriptCursor },
      },
    });
    const replayTranscriptAck = await c2.next(
      (f) => f.type === 'ack' && f.id === 't-replay',
    );
    expect(ackPayload(replayTranscriptAck)).toMatchObject({ accepted: [sid], resync_required: [] });
    const replayedTranscript = c2.frames.filter(
      (frame) =>
        frame.type === 'transcript.ops' &&
        transcriptOpsPayload(frame).agent_id === 'main' &&
        transcriptOpsPayload(frame).cursor.seq > transcriptCursor.seq,
    );
    expect(c2.frames.some((frame) => frame.type === 'transcript.reset')).toBe(false);
    const transcriptSeqs = replayedTranscript.map(
      (frame) => transcriptOpsPayload(frame).cursor.seq,
    );
    expect(transcriptSeqs).toEqual(
      integerRange(transcriptCursor.seq + 1, Math.max(...transcriptSeqs)),
    );
    for (const frame of replayedTranscript) applyTranscriptFrame(liveTranscript, frame);
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

    const c3 = await openConn(wsUrl, server!.authTokenService.getToken());
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

    const c = await openConn(wsUrl, server!.authTokenService.getToken());
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

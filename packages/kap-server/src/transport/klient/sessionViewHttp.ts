import type { Scope } from '@kiki/agent-core-v2';
import {
  sessionViewSubscribeInputSchema,
  sessionViewTranscriptCatchUpInputSchema,
  sessionViewTranscriptPageInputSchema,
} from '@kiki/klient';
import { RPCError, type KlientFrame } from '@kiki/klient/host';
import type { FastifyInstance } from 'fastify';
import { okEnvelope } from '../../protocol/envelope';
import { assembleSnapshot, SnapshotNotFoundError } from '../../routes/snapshot';
import type { TranscriptService } from '../../services/transcript/transcriptService';
import type { SessionEventBroadcaster } from '../ws/v1/sessionEventBroadcaster';
import { readSessionViewTranscriptCatchUp, readSessionViewTranscriptPage } from './sessionViewReads';
import { SessionViewTarget } from './sessionViewTarget';

export const KLIENT_SESSION_VIEW_PATH = '/api/klient/session-view';

export interface SessionViewHttpOptions {
  readonly sessionViewBroadcaster?: SessionEventBroadcaster;
  readonly sessionViewTranscriptService?: TranscriptService;
}

export function registerSessionViewHttp(app: FastifyInstance, scope: Scope, opts: SessionViewHttpOptions): void {
  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/snapshot`, async (req, reply) => {
    const broadcaster = opts.sessionViewBroadcaster;
    if (broadcaster === undefined) throw new RPCError(50001, 'session view unavailable');
    try {
      const { sessionId } = req.params as { sessionId: string };
      return await reply.send(okEnvelope(await assembleSnapshot(scope, broadcaster, sessionId, 'transcript'), req.id));
    } catch (error) {
      if (error instanceof SnapshotNotFoundError) return reply.send({ code: 40401, msg: error.message, data: null, request_id: req.id });
      throw error;
    }
  });

  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/transcript`, async (req, reply) => {
    const service = opts.sessionViewTranscriptService;
    if (service === undefined) throw new RPCError(50001, 'session view unavailable');
    const query = req.query as Record<string, unknown>;
    const parsed = sessionViewTranscriptPageInputSchema.safeParse({
      agentId: query['agent_id'], beforeTurn: query['before_turn'], afterTurn: query['after_turn'],
      pageSize: query['page_size'] === undefined ? undefined : Number(query['page_size']),
    });
    if (!parsed.success) return reply.send({ code: 40001, msg: 'invalid transcript page input', data: null, request_id: req.id });
    const { sessionId } = req.params as { sessionId: string };
    const data = await readSessionViewTranscriptPage(service, sessionId, parsed.data);
    return reply.send(data === undefined
      ? { code: 40401, msg: `session not found: ${sessionId}`, data: null, request_id: req.id }
      : okEnvelope(data, req.id));
  });

  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/transcript/catch-up`, async (req, reply) => {
    const service = opts.sessionViewTranscriptService;
    if (service === undefined) throw new RPCError(50001, 'session view unavailable');
    const query = req.query as Record<string, unknown>;
    const parsed = sessionViewTranscriptCatchUpInputSchema.safeParse({
      agentId: query['agent_id'], since: { seq: Number(query['since_seq']), epoch: query['epoch'] }, grade: query['grade'],
    });
    if (!parsed.success) return reply.send({ code: 40001, msg: 'invalid transcript catch-up input', data: null, request_id: req.id });
    const { sessionId } = req.params as { sessionId: string };
    const data = await readSessionViewTranscriptCatchUp(service, sessionId, parsed.data);
    return reply.send(data === undefined
      ? { code: 40401, msg: `session not found: ${sessionId}`, data: null, request_id: req.id }
      : okEnvelope(data, req.id));
  });
}

export class SessionViewHttpConnection {
  private readonly views = new Map<string, { sessionId: string; target: SessionViewTarget }>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly detached = new Set<string>();
  private closed = false;

  constructor(
    private readonly broadcaster: SessionEventBroadcaster | undefined,
    private readonly send: (frame: KlientFrame) => void,
    private readonly sendError: (id: string, error: unknown) => void,
  ) {}

  receive(frame: KlientFrame): boolean {
    if (frame.type !== 'view_attach' && frame.type !== 'view_detach') return false;
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (id.length === 0 || this.closed) return true;
    if (frame.type === 'view_detach') {
      this.detached.add(id);
      this.detach(id);
      return true;
    }
    this.detached.delete(id);
    const previous = this.tasks.get(id) ?? Promise.resolve();
    const next = previous.then(() => this.attach(id, frame)).catch((error: unknown) => {
      this.detach(id);
      if (!this.closed && !this.detached.has(id)) this.sendError(id, error);
    }).finally(() => { if (this.tasks.get(id) === next) this.tasks.delete(id); });
    this.tasks.set(id, next);
    return true;
  }

  private async attach(id: string, frame: KlientFrame): Promise<void> {
    if (this.closed || this.detached.has(id)) return;
    const broadcaster = this.broadcaster;
    if (broadcaster === undefined) throw new RPCError(50001, 'session view unavailable');
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) throw new RPCError(40001, 'session view requires sessionId');
    if (frame.data === null || typeof frame.data !== 'object') throw new RPCError(40001, 'invalid session view attach');
    const data = frame.data as { input?: unknown; generation?: unknown; reconnected?: unknown };
    const parsed = sessionViewSubscribeInputSchema.safeParse(data.input);
    if (!parsed.success || typeof data.generation !== 'number' || !Number.isInteger(data.generation) || data.generation < 0) throw new RPCError(40001, 'invalid session view attach');
    const previous = this.views.get(id);
    if (previous !== undefined && previous.sessionId !== frame.sessionId) this.detach(id);
    const target = this.views.get(id)?.target ?? new SessionViewTarget(frame.sessionId, (signal) => {
      if (!this.closed && !this.detached.has(id)) this.send({ type: 'view_signal', id, data: signal });
    });
    target.begin(data.generation);
    this.views.set(id, { sessionId: frame.sessionId, target });
    const input = parsed.data;
    const attached = await broadcaster.subscribe(frame.sessionId, target, undefined, input.transcriptGrades, {
      deferTranscriptReset: true, transcriptSince: input.transcriptSince,
    });
    if (this.closed || this.detached.has(id)) {
      broadcaster.unsubscribe(frame.sessionId, target);
      this.views.delete(id);
      return;
    }
    if (!attached) {
      target.sendControl({ type: 'resync_required', payload: { reason: 'session_recreated', current_seq: 0 } });
      target.finish({ seq: 0 }, data.reconnected === true);
      this.detach(id);
      return;
    }
    const replay = await broadcaster.getBufferedSince(frame.sessionId, input.sessionCursor, undefined, input.transcriptGrades);
    if (replay.resyncRequired === false) {
      for (const { envelope } of replay.events) target.replay(envelope);
    } else {
      target.sendControl({ type: 'resync_required', payload: { reason: replay.resyncRequired, current_seq: replay.currentSeq, epoch: replay.epoch } });
    }
    await broadcaster.flushTranscriptSeed(frame.sessionId, target);
    if (this.closed || this.detached.has(id)) {
      broadcaster.unsubscribe(frame.sessionId, target);
      this.views.delete(id);
      return;
    }
    target.finish({ seq: replay.currentSeq, epoch: replay.epoch }, data.reconnected === true);
  }

  private detach(id: string): void {
    const view = this.views.get(id);
    if (view === undefined) return;
    this.views.delete(id);
    this.broadcaster?.unsubscribe(view.sessionId, view.target);
  }

  dispose(): void {
    this.closed = true;
    for (const id of this.views.keys()) this.detach(id);
    this.tasks.clear();
  }
}

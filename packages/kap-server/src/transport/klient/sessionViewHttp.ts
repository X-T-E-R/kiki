import { ISessionManager, type IDisposable, type Scope } from '@kiki/agent-core-v2';
import {
  sessionViewSubscribeInputSchema,
  sessionViewTranscriptCatchUpInputSchema,
  sessionViewTranscriptContentInputSchema,
  sessionViewTranscriptPageInputSchema,
} from '@kiki/klient';
import { RPCError, type KlientFrame } from '@kiki/klient/host';
import type { FastifyInstance } from 'fastify';
import {
  acceptsTranscriptCoverage,
  gradeFor,
  requestsTranscript,
  TRANSCRIPT_CLIENT_UPGRADE_MESSAGE,
  TRANSCRIPT_COVERAGE_VERSION,
} from '@kiki/transcript';
import { okEnvelope } from '../../protocol/envelope';
import { withReplyCloseSignal } from '../../procedures/requestSignal';
import { assembleBrowseSnapshot, assembleBrowseSnapshotSource, SnapshotNotFoundError } from '../../routes/snapshot';
import type { TranscriptService } from '../../services/transcript/transcriptService';
import type { SessionEventBroadcaster } from '../ws/v1/sessionEventBroadcaster';
import {
  readColdSessionViewBaseline,
  readSessionViewTranscriptCatchUp,
  readSessionViewTranscriptContent,
  readSessionViewTranscriptPage,
  TranscriptDetailCursorError,
} from './sessionViewReads';
import { ContentChangedError, readContentSegment } from './boundedContent';
import { CanonicalEntityPreparingError } from '../../services/history/historyCanonicalReader';
import { SessionViewTarget } from './sessionViewTarget';
import { recordSessionViewTiming } from './sessionViewTiming';

export const KLIENT_SESSION_VIEW_PATH = '/api/klient/session-view';

export interface SessionViewHttpOptions {
  readonly sessionViewBroadcaster?: SessionEventBroadcaster;
  readonly sessionViewTranscriptService?: TranscriptService;
}

export function registerSessionViewHttp(app: FastifyInstance, scope: Scope, opts: SessionViewHttpOptions): void {
  app.post(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/transcript/content`, { bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
    const service = opts.sessionViewTranscriptService;
    if (service === undefined) throw new RPCError(50001, 'session view unavailable');
    const parsed = sessionViewTranscriptContentInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.send({ code: 40001, msg: 'invalid content reference', data: null, request_id: req.id });
    const { sessionId } = req.params as { sessionId: string };
    try {
      const data = await withReplyCloseSignal(reply, async (signal) => {
        if (parsed.data.ref.source.kind !== 'snapshot') return readSessionViewTranscriptContent(service, sessionId, { ...parsed.data, signal });
        const broadcaster = opts.sessionViewBroadcaster;
        if (broadcaster === undefined) throw new RPCError(50001, 'session view unavailable');
        const snapshot = await assembleBrowseSnapshotSource(scope, broadcaster, sessionId, parsed.data.ref.source.id === 'legacy' ? 'legacy' : undefined);
        signal.throwIfAborted();
        return readContentSegment(snapshot, parsed.data.ref);
      });
      return await reply.send(data === undefined ? { code: 40401, msg: 'content unavailable', data: null, request_id: req.id } : okEnvelope(data, req.id));
    } catch (error) {
      if (error instanceof CanonicalEntityPreparingError) return reply.send({ code: 40923, msg: error.message, data: null, request_id: req.id });
      if (error instanceof ContentChangedError) return reply.send({ code: 40922, msg: error.message, data: null, request_id: req.id });
      throw error;
    }
  });
  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/snapshot`, async (req, reply) => {
    const broadcaster = opts.sessionViewBroadcaster;
    if (broadcaster === undefined) throw new RPCError(50001, 'session view unavailable');
    try {
      const { sessionId } = req.params as { sessionId: string };
      const startedAt = performance.now();
      const snapshot = await assembleBrowseSnapshot(scope, broadcaster, sessionId);
      recordSessionViewTiming('snapshot', startedAt, { sessionId });
      return await reply.send(okEnvelope(snapshot, req.id));
    } catch (error) {
      if (error instanceof SnapshotNotFoundError) return reply.send({ code: 40401, msg: error.message, data: null, request_id: req.id });
      throw error;
    }
  });

  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/transcript`, async (req, reply) => {
    const service = opts.sessionViewTranscriptService;
    if (service === undefined) throw new RPCError(50001, 'session view unavailable');
    const query = req.query as Record<string, unknown>;
    if (query['transcript_coverage_version'] !== String(TRANSCRIPT_COVERAGE_VERSION)) {
      return reply.send({ code: 40001, msg: TRANSCRIPT_CLIENT_UPGRADE_MESSAGE, data: null, request_id: req.id });
    }
    const parsed = sessionViewTranscriptPageInputSchema.safeParse({
      agentId: query['agent_id'], beforeTurn: query['before_turn'], beforeItem: query['before_item'], afterTurn: query['after_turn'], afterItem: query['after_item'],
      pageSize: query['page_size'] === undefined ? undefined : Number(query['page_size']),
    });
    if (!parsed.success) return reply.send({ code: 40001, msg: 'invalid transcript page input', data: null, request_id: req.id });
    const { sessionId } = req.params as { sessionId: string };
    try {
      const data = await withReplyCloseSignal(reply, (signal) =>
        readSessionViewTranscriptPage(service, sessionId, { ...parsed.data, signal }),
      );
      return await reply.send(data === undefined
        ? { code: 40401, msg: `session not found: ${sessionId}`, data: null, request_id: req.id }
        : okEnvelope({ ...data, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }, req.id));
    } catch (error) {
      if (error instanceof TranscriptDetailCursorError) return reply.send({ code: 40001, msg: error.message, data: null, request_id: req.id });
      throw error;
    }
  });

  app.get(`${KLIENT_SESSION_VIEW_PATH}/:sessionId/transcript/catch-up`, async (req, reply) => {
    const service = opts.sessionViewTranscriptService;
    if (service === undefined) throw new RPCError(50001, 'session view unavailable');
    const query = req.query as Record<string, unknown>;
    if (query['transcript_coverage_version'] !== String(TRANSCRIPT_COVERAGE_VERSION)) {
      return reply.send({ code: 40001, msg: TRANSCRIPT_CLIENT_UPGRADE_MESSAGE, data: null, request_id: req.id });
    }
    const parsed = sessionViewTranscriptCatchUpInputSchema.safeParse({
      agentId: query['agent_id'], since: { seq: Number(query['since_seq']), epoch: query['epoch'] }, grade: query['grade'],
    });
    if (!parsed.success) return reply.send({ code: 40001, msg: 'invalid transcript catch-up input', data: null, request_id: req.id });
    const { sessionId } = req.params as { sessionId: string };
    const data = await readSessionViewTranscriptCatchUp(service, sessionId, parsed.data);
    return reply.send(data === undefined
      ? { code: 40401, msg: `session not found: ${sessionId}`, data: null, request_id: req.id }
      : okEnvelope({ ...data, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }, req.id));
  });
}

interface AttachedView {
  readonly sessionId: string;
  readonly target: SessionViewTarget;
  readonly coverage: boolean;
  readonly cold?: AbortController;
}

export class SessionViewHttpConnection {
  private readonly views = new Map<string, AttachedView>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly frames = new Map<string, KlientFrame>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly detached = new Set<string>();
  private readonly activationListener: IDisposable | undefined;
  private closed = false;

  constructor(
    private readonly broadcaster: SessionEventBroadcaster | undefined,
    private readonly send: (frame: KlientFrame) => void,
    private readonly sendError: (id: string, error: unknown) => void,
    private readonly browse?: { readonly core: Scope; readonly service?: TranscriptService },
  ) {
    const manager = browse?.core.accessor.get(ISessionManager);
    this.activationListener = manager?.onDidCreateSession?.(({ sessionId }) => {
      void manager.whenResumeSettled(sessionId).then(() => {
        if (this.closed) return;
        for (const [id, view] of this.views) {
          if (view.sessionId !== sessionId || view.cold === undefined) continue;
          const frame = this.frames.get(id);
          if (frame !== undefined) this.receive({ ...frame });
        }
      }).catch((error: unknown) => {
        for (const [id, view] of this.views) {
          if (!this.closed && view.sessionId === sessionId) this.sendError(id, error);
        }
      });
    });
  }

  receive(frame: KlientFrame): boolean {
    if (frame.type !== 'view_attach' && frame.type !== 'view_detach') return false;
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (id.length === 0 || this.closed) return true;
    if (frame.type === 'view_detach') {
      this.detached.add(id);
      this.frames.delete(id);
      this.detach(id);
      return true;
    }
    this.detached.delete(id);
    this.frames.set(id, frame);
    this.views.get(id)?.cold?.abort();
    const previous = this.tasks.get(id) ?? Promise.resolve();
    const queuedAt = performance.now();
    const next = previous.then(() => this.attach(id, frame, queuedAt)).catch((error: unknown) => {
      if (this.frames.get(id) !== frame || this.closed || this.detached.has(id)) return;
      this.detach(id);
      this.sendError(id, error);
    }).finally(() => { if (this.tasks.get(id) === next) this.tasks.delete(id); });
    this.tasks.set(id, next);
    return true;
  }

  private async attach(id: string, frame: KlientFrame, queuedAt: number): Promise<void> {
    if (this.closed || this.detached.has(id) || this.frames.get(id) !== frame) return;
    const broadcaster = this.broadcaster;
    if (broadcaster === undefined) throw new RPCError(50001, 'session view unavailable');
    if (typeof frame.sessionId !== 'string' || frame.sessionId.length === 0) throw new RPCError(40001, 'session view requires sessionId');
    if (frame.data === null || typeof frame.data !== 'object') throw new RPCError(40001, 'invalid session view attach');
    const data = frame.data as { input?: unknown; generation?: unknown; reconnected?: unknown; transcript_coverage_version?: unknown };
    const parsed = sessionViewSubscribeInputSchema.safeParse(data.input);
    if (!parsed.success || typeof data.generation !== 'number' || !Number.isInteger(data.generation) || data.generation < 0) throw new RPCError(40001, 'invalid session view attach');
    const input = parsed.data;
    const fields = { sessionId: frame.sessionId, generation: data.generation };
    recordSessionViewTiming('attach_queue', queuedAt, fields);
    const attachedAt = performance.now();
    const coverage = requestsTranscript(input.transcriptGrades);
    if (coverage && !acceptsTranscriptCoverage(data.transcript_coverage_version)) {
      throw new RPCError(40001, TRANSCRIPT_CLIENT_UPGRADE_MESSAGE);
    }
    const previous = this.views.get(id);
    if (previous !== undefined && previous.sessionId !== frame.sessionId) this.detach(id);
    const target = this.views.get(id)?.target ?? new SessionViewTarget(frame.sessionId, (signal) => {
      if (this.closed || this.detached.has(id)) return;
      const active = this.views.get(id);
      if (active?.target !== target) return;
      this.send({ type: 'view_signal', id, data: active.coverage
        ? { ...signal, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION }
        : signal });
    });
    target.begin(data.generation);
    const cold = this.browse !== undefined && this.browse.core.accessor.get(ISessionManager).get(frame.sessionId) === undefined
      ? new AbortController() : undefined;
    const upgrading = previous?.cold !== undefined && cold === undefined;
    const view: AttachedView = { sessionId: frame.sessionId, target, coverage, cold };
    this.views.set(id, view);
    if (cold !== undefined) {
      const service = this.browse?.service;
      if (service === undefined) throw new RPCError(50001, 'session view unavailable');
      const roster = await service.readColdRoster(frame.sessionId);
      cold.signal.throwIfAborted();
      if (roster === undefined) throw new RPCError(40401, `session not found: ${frame.sessionId}`);
      const agents = new Set(Object.keys(input.transcriptGrades).filter((agentId) => agentId !== '*'));
      if (gradeFor(input.transcriptGrades, '*') === 'delta' || gradeFor(input.transcriptGrades, '*') === 'block') {
        for (const descriptor of roster) agents.add(descriptor.agentId);
      }
      const priority = (agentId: string): boolean => Object.hasOwn(input.transcriptGrades, agentId) &&
        (gradeFor(input.transcriptGrades, agentId) === 'block' || gradeFor(input.transcriptGrades, agentId) === 'delta');
      const ordered = [...agents].toSorted((left, right) => Number(priority(right)) - Number(priority(left)));
      let firstDetail = false;
      for (const agentId of ordered) {
        const grade = gradeFor(input.transcriptGrades, agentId);
        if (grade === 'off') continue;
        const readAt = performance.now();
        const event = await readColdSessionViewBaseline(service, frame.sessionId, agentId, grade, cold.signal);
        recordSessionViewTiming('cold_agent_read', readAt, { ...fields, agentId });
        if (event === undefined) throw new RPCError(40401, `session not found: ${frame.sessionId}`);
        cold.signal.throwIfAborted();
        if (this.views.get(id) !== view || this.frames.get(id) !== frame) return;
        this.send({ type: 'view_signal', id, data: { type: 'transcript', event,
          generation: data.generation, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION } });
        if (!firstDetail && priority(agentId)) {
          firstDetail = true;
          recordSessionViewTiming('first_detail_reset', attachedAt, { ...fields, agentId });
        }
      }
      const cursor = await broadcaster.getCursor(frame.sessionId);
      cold.signal.throwIfAborted();
      if (this.views.get(id) !== view || this.frames.get(id) !== frame) return;
      target.finish({ seq: cursor.seq, epoch: cursor.epoch || `cold:${frame.sessionId}` }, data.reconnected === true);
      recordSessionViewTiming('attach_ready', attachedAt, fields);
      return;
    }
    const attached = await broadcaster.subscribe(frame.sessionId, target, undefined, input.transcriptGrades, {
      deferTranscriptReset: true, transcriptSince: upgrading ? undefined : input.transcriptSince,
    });
    if (this.closed || this.detached.has(id) || this.frames.get(id) !== frame) {
      broadcaster.unsubscribe(frame.sessionId, target);
      if (this.views.get(id) === view) this.views.delete(id);
      return;
    }
    if (!attached) {
      target.sendControl({ type: 'resync_required', payload: { reason: 'session_recreated', current_seq: 0 } });
      target.finish({ seq: 0 }, data.reconnected === true);
      this.detach(id);
      return;
    }
    const replay = await broadcaster.getBufferedSince(frame.sessionId, input.sessionCursor, undefined, input.transcriptGrades);
    if (upgrading || replay.resyncRequired !== false) {
      target.sendControl({ type: 'resync_required', payload: { reason: upgrading ? 'epoch_changed' : replay.resyncRequired, current_seq: replay.currentSeq, epoch: replay.epoch } });
    } else {
      for (const { envelope } of replay.events) target.replay(envelope);
    }
    await broadcaster.flushTranscriptSeed(frame.sessionId, target);
    if (this.closed || this.detached.has(id) || this.frames.get(id) !== frame) {
      broadcaster.unsubscribe(frame.sessionId, target);
      if (this.views.get(id) === view) this.views.delete(id);
      return;
    }
    target.finish({ seq: replay.currentSeq, epoch: replay.epoch }, data.reconnected === true);
    recordSessionViewTiming('attach_ready', attachedAt, fields);
  }

  private detach(id: string): void {
    const view = this.views.get(id);
    if (view === undefined) return;
    this.views.delete(id);
    view.cold?.abort();
    this.broadcaster?.unsubscribe(view.sessionId, view.target);
  }

  dispose(): void {
    this.closed = true;
    const activation = this.activationListener?.dispose();
    if (activation instanceof Promise) {
      this.pendingDisposals.add(activation);
      activation.finally(() => this.pendingDisposals.delete(activation)).catch(() => {});
    }
    for (const id of this.views.keys()) this.detach(id);
    this.frames.clear();
    this.tasks.clear();
  }
}

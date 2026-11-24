import type { FastifyReply } from 'fastify';
import {
  getLiveSessionById,
  ISessionIndex,
  type Scope,
} from '@kiki/agent-core-v2';
import {
  ErrorCode,
  rawGlobalEventsQuerySchema,
  rawSessionEventsQuerySchema,
  type RawEventStreamGrade,
} from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { NotificationService } from '../services/notifications/notificationService';
import { sessionAccessToken } from '../services/sessionAccess/access';
import type {
  GlobalRawTarget,
  RawSessionTarget,
  SessionEventBroadcaster,
} from '../transport/ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../transport/ws/v1/sessionEventJournal';
import { encodeJsonValueBounded } from '../transport/ws/v1/boundedJsonEncoder';

type RouteHandler = (
  req: { id: string; params: unknown; query: unknown; headers?: Record<string, unknown> },
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

interface RawEventsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: RouteHandler,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const MAX_BACKPRESSURE_BYTES = 1024 * 1024;

const TURN_GRADE_SUPPRESSED_TYPES: ReadonlySet<string> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool_call.delta',
  'tool.progress',
  'shell.output',
]);

type ParsedCursor =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly cursor: { readonly epoch?: string; readonly seq: number } }
  | { readonly kind: 'invalid' };

function parseAfterCursor(raw: string | undefined): ParsedCursor {
  if (raw === undefined) return { kind: 'none' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'invalid' };
  const separator = trimmed.lastIndexOf(':');
  if (separator >= 0) {
    const epoch = trimmed.slice(0, separator);
    const seqStr = trimmed.slice(separator + 1);
    if (epoch.length === 0 || !/^\d+$/u.test(seqStr)) return { kind: 'invalid' };
    const seqNum = Number(seqStr);
    if (!Number.isSafeInteger(seqNum) || seqNum < 0) return { kind: 'invalid' };
    return { kind: 'valid', cursor: { epoch, seq: seqNum } };
  }
  if (!/^\d+$/u.test(trimmed)) return { kind: 'invalid' };
  const seqNum = Number(trimmed);
  if (!Number.isSafeInteger(seqNum) || seqNum < 0) return { kind: 'invalid' };
  return { kind: 'valid', cursor: { seq: seqNum } };
}

function resolveCursorRaw(
  queryAfter: string | undefined,
  headers?: Record<string, unknown>,
): string | undefined {
  const headerRaw = headers?.['last-event-id'];
  if (typeof headerRaw === 'string' && headerRaw.trim().length > 0) return headerRaw;
  return queryAfter;
}

function wantsNdjson(headers?: Record<string, unknown>): boolean {
  const accept = headers?.['accept'];
  return typeof accept === 'string' && accept.includes('application/x-ndjson');
}

function projectRawFrame(envelope: EventEnvelope): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: envelope.type,
    epoch: envelope.epoch,
    seq: envelope.seq,
    session_id: envelope.session_id,
    timestamp: envelope.timestamp,
  };
  if (envelope.volatile === true) base['volatile'] = true;
  if (envelope.type === 'tool.requires_action' || envelope.type === 'tool.action_resolved' || envelope.type === 'context.undo') {
    const payload = typeof envelope.payload === 'object' && envelope.payload !== null
      ? (envelope.payload as Record<string, unknown>)
      : undefined;
    if (payload !== undefined) {
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'type' || key === 'sessionId') continue;
        base[key] = value;
      }
      return base;
    }
  }
  base['payload'] = envelope.payload;
  return base;
}

function formatFrameBounded(
  frame: Record<string, unknown>,
  ndjson: boolean,
  maxBytes: number,
): string | undefined {
  const encoded = encodeJsonValueBounded(frame, maxBytes);
  if (!encoded.ok) return undefined;
  const json = encoded.buffer.toString('utf8');
  if (ndjson) return `${json}\n`;
  const lines: string[] = [];
  const epoch = typeof frame['epoch'] === 'string' ? frame['epoch'] : undefined;
  const seq = typeof frame['seq'] === 'number' ? frame['seq'] : undefined;
  if (epoch !== undefined && seq !== undefined) lines.push(`id: ${epoch}:${seq}`);
  else if (seq !== undefined) lines.push(`id: ${seq}`);
  if (typeof frame['type'] === 'string') lines.push(`event: ${frame['type']}`);
  lines.push(`data: ${json}`);
  return `${lines.join('\n')}\n\n`;
}

function allowedForGrade(envelope: EventEnvelope, grade: RawEventStreamGrade): boolean {
  if (grade === 'delta') return true;
  return !TURN_GRADE_SUPPRESSED_TYPES.has(envelope.type);
}

/** Register stateless R2 cursor event streams (`GET /sessions/{session_id}/events` and `GET /events`). */
export function registerRawEventsRoutes(
  app: RawEventsRouteHost,
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  notifications?: NotificationService,
  shutdownSignal?: AbortSignal,
): void {
  if (notifications !== undefined) {
    notifications.onDidCompleteEpisode((episode) => {
      broadcaster.publishGlobalEpisodeCompleted(episode);
    });
  }
  const activeClosers = new Set<() => void>();
  const registerCloser = (close: () => void): (() => void) => {
    activeClosers.add(close);
    return () => {
      activeClosers.delete(close);
    };
  };
  shutdownSignal?.addEventListener('abort', () => {
    for (const close of Array.from(activeClosers)) {
      try { close(); } catch {}
    }
    activeClosers.clear();
  }, { once: true });

  const sessionEventsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/events',
      params: sessionIdParamSchema,
      querystring: rawSessionEventsQuerySchema,
      success: { data: z.unknown() },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Stateless cursor event stream (SSE or NDJSON) for a session',
      tags: ['events'],
      operationId: 'streamSessionEvents',
    },
    async (req, response) => {
      const reply = response as FastifyReply;
      const { session_id } = req.params;
      const headers = (req as unknown as { headers?: Record<string, unknown> }).headers;
      const parsedCursor = parseAfterCursor(resolveCursorRaw(req.query.after, headers));
      if (parsedCursor.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Invalid cursor in after / Last-Event-ID', req.id));
        return;
      }
      const live = getLiveSessionById(core.accessor, session_id);
      if (live === undefined && (await core.accessor.get(ISessionIndex).get(session_id)) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id));
        return;
      }

      const ndjson = wantsNdjson(headers);
      const afterCursor = parsedCursor.kind === 'valid' ? parsedCursor.cursor : undefined;
      const grade: RawEventStreamGrade = req.query.grade;

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': ndjson ? 'application/x-ndjson; charset=utf-8' : 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      let detach: (() => void) | undefined;
      let unregisterCloser: (() => void) | undefined;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unregisterCloser?.();
        unregisterCloser = undefined;
        detach?.();
        detach = undefined;
      };
      unregisterCloser = registerCloser(() => {
        cleanup();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      });
      reply.raw.once('close', cleanup);
      if (shutdownSignal?.aborted === true) {
        cleanup();
        reply.raw.end();
        return;
      }

      let lastEmittedSeq = -1;
      const bufferedQueue: EventEnvelope[] = [];
      let replayDone = false;

      const writeFrame = (frame: Record<string, unknown>): boolean => {
        if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
        if (reply.raw.writableLength > MAX_BACKPRESSURE_BYTES) {
          cleanup();
          reply.raw.destroy();
          return false;
        }
        const formatted = formatFrameBounded(frame, ndjson, MAX_BACKPRESSURE_BYTES);
        if (formatted === undefined) {
          const resetFrame = formatFrameBounded(
            {
              type: 'reset',
              session_id,
              epoch: typeof frame['epoch'] === 'string' ? frame['epoch'] : '',
              latest_seq: typeof frame['seq'] === 'number' ? frame['seq'] : Math.max(0, lastEmittedSeq),
              reason: 'journal_gap',
            },
            ndjson,
            MAX_BACKPRESSURE_BYTES,
          );
          if (resetFrame !== undefined) reply.raw.write(resetFrame);
          cleanup();
          reply.raw.end();
          return false;
        }
        reply.raw.write(formatted);
        return true;
      };

      const target: RawSessionTarget = {
        wantsDeltas: grade === 'delta',
        send(envelope) {
          if (closed) return;
          if (envelope.session_id !== session_id) return;
          if (!allowedForGrade(envelope, grade)) return;
          if (!replayDone) {
            bufferedQueue.push(envelope);
            return;
          }
          if (envelope.volatile !== true && envelope.seq <= lastEmittedSeq) return;
          if (envelope.volatile !== true) lastEmittedSeq = envelope.seq;
          writeFrame(projectRawFrame(envelope));
        },
        onEvicted({ epoch, seq }) {
          if (closed) return;
          writeFrame({
            type: 'reset',
            session_id,
            epoch,
            latest_seq: seq,
            reason: 'session_evicted',
          });
          cleanup();
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
        },
      };

      if (live === undefined) {
        const cursor = await broadcaster.getCursor(session_id, undefined, true);
        writeFrame({
          type: 'reset',
          session_id,
          epoch: cursor.epoch || `cold:${session_id}`,
          latest_seq: cursor.seq,
          reason: 'session_cold',
        });
        cleanup();
        reply.raw.end();
        return;
      }

      detach = await broadcaster.attachRawSessionTarget(session_id, target);
      if (closed) {
        detach();
        detach = undefined;
        return;
      }

      if (afterCursor !== undefined) {
        const buffered = await broadcaster.getBufferedSince(session_id, afterCursor);
        if (closed) return;
        if (buffered.resyncRequired !== false) {
          writeFrame({
            type: 'reset',
            session_id,
            epoch: buffered.epoch,
            latest_seq: buffered.currentSeq,
            reason: buffered.resyncRequired,
          });
          cleanup();
          reply.raw.end();
          return;
        }
        lastEmittedSeq = afterCursor.seq;
        for (const item of buffered.events) {
          if (closed) return;
          if (item.envelope.session_id !== session_id) continue;
          if (!allowedForGrade(item.envelope, grade)) continue;
          if (item.seq <= lastEmittedSeq) continue;
          lastEmittedSeq = item.seq;
          if (!writeFrame(projectRawFrame(item.envelope))) return;
        }
      }

      replayDone = true;
      for (const pending of bufferedQueue.splice(0)) {
        if (closed) return;
        if (pending.volatile !== true && pending.seq <= lastEmittedSeq) continue;
        if (pending.volatile !== true) lastEmittedSeq = pending.seq;
        if (!writeFrame(projectRawFrame(pending))) return;
      }
      if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.flushHeaders();
      }
    },
  );
  app.get(sessionEventsRoute.path, sessionEventsRoute.options, sessionEventsRoute.handler as RouteHandler);

  const globalEventsRoute = defineRoute(
    {
      method: 'GET',
      path: '/events',
      querystring: rawGlobalEventsQuerySchema,
      success: { data: z.unknown() },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
      },
      description: 'Stateless server-wide public event stream (SSE or NDJSON)',
      tags: ['events'],
      operationId: 'streamGlobalEvents',
    },
    async (req, response) => {
      const reply = response as FastifyReply;
      const headers = (req as unknown as { headers?: Record<string, unknown> }).headers;
      const parsedCursor = parseAfterCursor(resolveCursorRaw(req.query.after, headers));
      if (parsedCursor.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Invalid cursor in after / Last-Event-ID', req.id));
        return;
      }
      const ndjson = wantsNdjson(headers);
      const afterCursor = parsedCursor.kind === 'valid' ? parsedCursor.cursor : undefined;
      const scopedSessionId = sessionAccessToken(req)?.session_id;

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': ndjson ? 'application/x-ndjson; charset=utf-8' : 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      let unregisterCloser: (() => void) | undefined;
      let lastEmittedSeq = -1;
      const queued: Array<{ readonly envelope: EventEnvelope; readonly hidden: boolean }> = [];
      let replayDone = false;

      const writeFrame = (frame: Record<string, unknown>): boolean => {
        if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
        if (reply.raw.writableLength > MAX_BACKPRESSURE_BYTES) {
          cleanup();
          reply.raw.destroy();
          return false;
        }
        const formatted = formatFrameBounded(frame, ndjson, MAX_BACKPRESSURE_BYTES);
        if (formatted === undefined) {
          const resetFrame = formatFrameBounded(
            {
              type: 'reset',
              epoch: typeof frame['epoch'] === 'string' ? frame['epoch'] : '',
              latest_seq: typeof frame['seq'] === 'number' ? frame['seq'] : Math.max(0, lastEmittedSeq),
              reason: 'journal_gap',
            },
            ndjson,
            MAX_BACKPRESSURE_BYTES,
          );
          if (resetFrame !== undefined) reply.raw.write(resetFrame);
          cleanup();
          reply.raw.end();
          return false;
        }
        reply.raw.write(formatted);
        return true;
      };

      const emitEnvelope = (envelope: EventEnvelope, hidden: boolean): void => {
        if (closed) return;
        if (envelope.seq <= lastEmittedSeq) return;
        if (scopedSessionId !== undefined) {
          if (envelope.session_id !== scopedSessionId) return;
        } else if (hidden) {
          return;
        }
        lastEmittedSeq = envelope.seq;
        writeFrame(projectRawFrame(envelope));
      };

      const target: GlobalRawTarget = {
        send(envelope, hidden) {
          if (closed) return;
          if (!replayDone) {
            queued.push({ envelope, hidden });
            return;
          }
          emitEnvelope(envelope, hidden);
        },
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unregisterCloser?.();
        unregisterCloser = undefined;
        broadcaster.removeGlobalRawTarget(target);
      };
      unregisterCloser = registerCloser(() => {
        cleanup();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      });
      reply.raw.once('close', cleanup);
      if (shutdownSignal?.aborted === true) {
        cleanup();
        reply.raw.end();
        return;
      }

      broadcaster.addGlobalRawTarget(target);
      if (afterCursor !== undefined) {
        const buffered = broadcaster.getGlobalBufferedSince(afterCursor, scopedSessionId);
        if (buffered.resyncRequired !== false) {
          writeFrame({
            type: 'reset',
            epoch: buffered.epoch,
            latest_seq: buffered.currentSeq,
            reason: buffered.resyncRequired,
          });
          cleanup();
          reply.raw.end();
          return;
        }
        lastEmittedSeq = afterCursor.seq;
        for (const item of buffered.events) {
          emitEnvelope(item.envelope, false);
        }
      }
      replayDone = true;
      for (const pending of queued.splice(0)) {
        emitEnvelope(pending.envelope, pending.hidden);
      }
      if (!closed && !reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.flushHeaders();
      }
    },
  );
  app.get(globalEventsRoute.path, globalEventsRoute.options, globalEventsRoute.handler as RouteHandler);
}

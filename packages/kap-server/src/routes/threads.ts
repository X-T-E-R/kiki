/**
 * `/threads` routes — host-qualified peer-thread coordination over REST.
 *
 * List/read/send calls are ordinary request/response operations. Wait is a
 * bounded long poll and stops writing a response when the client disconnects;
 * durable mailbox state remains owned by the App-scoped core service.
 */

import {
  IThreadCommunicationService,
  type Scope,
  type ThreadActivity,
  type ThreadRef,
  type ThreadSummary,
  type ThreadTurn,
  type WaitThreadResult,
  type WaitThreadsInput,
  type WaitThreadsResult,
} from '@kiki/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listThreadsQuerySchema,
  listThreadsResponseSchema,
  readThreadRequestSchema,
  readThreadResponseSchema,
  sendThreadMessageRequestSchema,
  sendThreadMessageResponseSchema,
  setThreadWorkspaceOverrideRequestSchema,
  threadWorkspaceOverrideResponseSchema,
  threadWorkspaceParamSchema,
  waitThreadsRequestSchema,
  waitThreadsResponseSchema,
} from '../protocol/rest-thread';
import type { ThreadRef as ThreadRefWire } from '../protocol/thread';
import { mapError } from '../transport/errors';

interface AbortEvents {
  once(event: 'aborted' | 'close', listener: () => void): unknown;
  off(event: 'aborted' | 'close', listener: () => void): unknown;
  readonly aborted?: boolean;
  readonly destroyed?: boolean;
}

interface ThreadsRequest {
  readonly id: string;
  readonly body: unknown;
  readonly query: unknown;
  readonly params: unknown;
  readonly raw?: AbortEvents;
}

interface ThreadsReply {
  readonly raw?: AbortEvents;
  send(payload: unknown): unknown;
}

interface ThreadsRouteHost {
  get(
    path: string,
    options: unknown,
    handler: (req: ThreadsRequest, reply: ThreadsReply) => unknown,
  ): unknown;
  post(
    path: string,
    options: unknown,
    handler: (req: ThreadsRequest, reply: ThreadsReply) => unknown,
  ): unknown;
  put(
    path: string,
    options: unknown,
    handler: (req: ThreadsRequest, reply: ThreadsReply) => unknown,
  ): unknown;
  delete(
    path: string,
    options: unknown,
    handler: (req: ThreadsRequest, reply: ThreadsReply) => unknown,
  ): unknown;
}

const threadErrors = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.THREAD_NOT_FOUND]: {},
  [ErrorCode.THREAD_ARCHIVED]: {},
  [ErrorCode.THREAD_DISABLED]: {},
  [ErrorCode.THREAD_CROSS_HOST]: {},
  [ErrorCode.THREAD_SELF_SEND]: {},
  [ErrorCode.THREAD_CURSOR_INVALID]: {},
  [ErrorCode.THREAD_IDEMPOTENCY_CONFLICT]: {},
  [ErrorCode.THREAD_LIMIT_EXCEEDED]: {},
  [ErrorCode.THREAD_DELIVERY_FAILED]: {},
} as const;

export function registerThreadsRoutes(
  app: ThreadsRouteHost,
  core: Scope,
  shutdownSignal?: AbortSignal,
): void {
  const service = core.accessor.get(IThreadCommunicationService);

  const list = defineRoute(
    {
      method: 'GET',
      path: '/threads',
      querystring: listThreadsQuerySchema,
      success: { data: listThreadsResponseSchema },
      errors: threadErrors,
      description: 'List peer-addressable threads, optionally within one workspace',
      tags: ['threads'],
    },
    async (req, reply) => {
      try {
        const query = req.query;
        const result = await service.listThreads({
          workspaceId: query.workspace_id,
          cursor: query.cursor,
          limit: query.limit,
        });
        reply.send(
          okEnvelope(
            { threads: result.threads.map(toSummaryWire), next_cursor: result.nextCursor },
            req.id,
          ),
        );
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );

  const read = defineRoute(
    {
      method: 'POST',
      path: '/threads::read',
      body: readThreadRequestSchema,
      success: { data: readThreadResponseSchema },
      errors: threadErrors,
      description: 'Read completed user and peer turns from a thread',
      tags: ['threads'],
    },
    async (req, reply) => {
      try {
        const body = req.body;
        const result = await service.readThread({
          thread: fromRefWire(body.thread),
          cursor: body.cursor,
          limit: body.limit,
        });
        reply.send(
          okEnvelope(
            {
              thread: toRefWire(result.thread),
              turns: result.turns.map(toTurnWire),
              next_cursor: result.nextCursor,
            },
            req.id,
          ),
        );
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );

  const send = defineRoute(
    {
      method: 'POST',
      path: '/threads::send',
      body: sendThreadMessageRequestSchema,
      success: { data: sendThreadMessageResponseSchema },
      errors: threadErrors,
      description: 'Durably accept a message for delivery to another local thread',
      tags: ['threads'],
    },
    async (req, reply) => {
      try {
        const body = req.body;
        const result = await service.sendMessage({
          target: fromRefWire(body.target),
          content: body.content,
          idempotencyKey: body.idempotency_key,
        });
        reply.send(
          okEnvelope(
            {
              message_id: result.messageId,
              target_seq: result.targetSeq,
              accepted_at: result.acceptedAt,
              deduplicated: result.deduplicated,
              delivery: result.delivery,
            },
            req.id,
          ),
        );
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );

  const wait = defineRoute(
    {
      method: 'POST',
      path: '/threads::wait',
      body: waitThreadsRequestSchema,
      success: { data: waitThreadsResponseSchema },
      errors: threadErrors,
      description: 'Wait up to sixty seconds for activity on as many as eight threads',
      tags: ['threads'],
    },
    async (req, reply) => {
      const abortableReq = req as typeof req & { readonly raw?: AbortEvents };
      const abortableReply = reply as typeof reply & { readonly raw?: AbortEvents };
      const requestAbort = createRequestAbort(
        abortableReq.raw,
        abortableReply.raw,
        shutdownSignal,
      );
      try {
        const body = req.body;
        const result = await waitThreadsUntilActivity(
          service,
          {
            threads: body.threads.map((item) => ({
              thread: fromRefWire(item.thread),
              cursor: item.cursor,
            })),
            timeoutMs: body.timeout_ms,
          },
          requestAbort.signal,
        );
        if (result === undefined) return;
        reply.send(
          okEnvelope(
            {
              threads: result.threads.map(toWaitResultWire),
              timed_out: result.timedOut,
            },
            req.id,
          ),
        );
      } catch (error) {
        if (requestAbort.signal.aborted) return;
        reply.send(mapError(error, req.id));
      } finally {
        requestAbort.dispose();
      }
    },
  );

  const getOverride = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/thread-communication',
      params: threadWorkspaceParamSchema,
      success: { data: threadWorkspaceOverrideResponseSchema },
      errors: threadErrors,
      description: 'Read the persisted override and effective thread-communication state',
      tags: ['threads', 'workspaces'],
    },
    async (req, reply) => {
      await sendOverrideSnapshot(service, req.params.workspace_id, req, reply);
    },
  );

  const setOverride = defineRoute(
    {
      method: 'PUT',
      path: '/workspaces/{workspace_id}/thread-communication',
      params: threadWorkspaceParamSchema,
      body: setThreadWorkspaceOverrideRequestSchema,
      success: { data: threadWorkspaceOverrideResponseSchema },
      errors: threadErrors,
      description: 'Persist a workspace thread-communication override',
      tags: ['threads', 'workspaces'],
    },
    async (req, reply) => {
      try {
        await service.setWorkspaceOverride(req.params.workspace_id, req.body.enabled);
        await sendOverrideSnapshot(service, req.params.workspace_id, req, reply);
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );

  const clearOverride = defineRoute(
    {
      method: 'DELETE',
      path: '/workspaces/{workspace_id}/thread-communication',
      params: threadWorkspaceParamSchema,
      success: { data: threadWorkspaceOverrideResponseSchema },
      errors: threadErrors,
      description: 'Clear a workspace thread-communication override',
      tags: ['threads', 'workspaces'],
    },
    async (req, reply) => {
      try {
        await service.clearWorkspaceOverride(req.params.workspace_id);
        await sendOverrideSnapshot(service, req.params.workspace_id, req, reply);
      } catch (error) {
        reply.send(mapError(error, req.id));
      }
    },
  );

  app.get(list.path, list.options, list.handler as never);
  app.post(read.path, read.options, read.handler as never);
  app.post(send.path, send.options, send.handler as never);
  app.post(wait.path, wait.options, wait.handler as never);
  app.get(getOverride.path, getOverride.options, getOverride.handler as never);
  app.put(setOverride.path, setOverride.options, setOverride.handler as never);
  app.delete(clearOverride.path, clearOverride.options, clearOverride.handler as never);
}

async function sendOverrideSnapshot(
  service: IThreadCommunicationService,
  workspaceId: string,
  req: { readonly id: string },
  reply: ThreadsReply,
): Promise<void> {
  try {
    const [override, effectiveEnabled] = await Promise.all([
      service.getWorkspaceOverride(workspaceId),
      service.isWorkspaceEnabled(workspaceId),
    ]);
    reply.send(
      okEnvelope(
        { override: override ?? null, effective_enabled: effectiveEnabled },
        req.id,
      ),
    );
  } catch (error) {
    reply.send(mapError(error, req.id));
  }
}

function fromRefWire(ref: ThreadRefWire): ThreadRef {
  return { hostId: ref.host_id, workspaceId: ref.workspace_id, sessionId: ref.session_id };
}

function toRefWire(ref: ThreadRef): ThreadRefWire {
  return { host_id: ref.hostId, workspace_id: ref.workspaceId, session_id: ref.sessionId };
}

function toSummaryWire(summary: ThreadSummary) {
  return {
    ref: toRefWire(summary.ref),
    title: summary.title,
    updated_at: summary.updatedAt,
    created_at: summary.createdAt,
    state: summary.state,
  };
}

function toTurnWire(turn: ThreadTurn) {
  return {
    turn_id: turn.turnId,
    started_at: turn.startedAt,
    ended_at: turn.endedAt,
    reason: turn.reason,
    origin: turn.origin,
    peer:
      turn.peer === undefined
        ? undefined
        : { source: toRefWire(turn.peer.source), message_id: turn.peer.messageId },
    input: turn.input,
    output: turn.output,
  };
}

function toActivityWire(activity: ThreadActivity) {
  return {
    ref: toRefWire(activity.ref),
    seq: activity.seq,
    kind: activity.kind,
    at: activity.at,
    reason: activity.reason,
    turn_id: activity.turnId,
    message_id: activity.messageId,
  };
}

function toWaitResultWire(result: WaitThreadResult) {
  return {
    thread: toRefWire(result.thread),
    cursor: result.cursor,
    activities: result.activities.map(toActivityWire),
  };
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const WAIT_POLL_MS = 200;

function createRequestAbort(
  requestRaw?: AbortEvents,
  replyRaw?: AbortEvents,
  shutdownSignal?: AbortSignal,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (
    requestRaw?.aborted === true ||
    replyRaw?.destroyed === true ||
    shutdownSignal?.aborted === true
  ) {
    abort();
  }
  requestRaw?.once('aborted', abort);
  replyRaw?.once('close', abort);
  shutdownSignal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      requestRaw?.off('aborted', abort);
      replyRaw?.off('close', abort);
      shutdownSignal?.removeEventListener('abort', abort);
    },
  };
}

async function waitThreadsUntilActivity(
  service: IThreadCommunicationService,
  input: WaitThreadsInput,
  signal: AbortSignal,
): Promise<WaitThreadsResult | undefined> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  let threads = input.threads;
  for (;;) {
    const result = await raceAbortSignal(
      service.waitThreads({ threads, timeoutMs: 0 }),
      signal,
    );
    if (result === undefined) return undefined;
    if (!result.timedOut || Date.now() >= deadline) return result;
    threads = result.threads.map((item) => ({ thread: item.thread, cursor: item.cursor }));
    const remainingMs = deadline - Date.now();
    if (!(await waitForPoll(Math.min(WAIT_POLL_MS, remainingMs), signal))) return undefined;
  }
}

async function raceAbortSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let resolveAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  signal.addEventListener('abort', resolveAbort, { once: true });
  try {
    const result = await Promise.race([
      pending.then((value) => ({ kind: 'result' as const, value })),
      aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    return result.kind === 'result' ? result.value : undefined;
  } finally {
    signal.removeEventListener('abort', resolveAbort);
  }
}

function waitForPoll(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

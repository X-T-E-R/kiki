import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from '@kiki/transcript-live';
import {
  ensureMainAgent,
  IAgentProfileService,
  IAgentLifecycleService,
  IAgentActivityView,
  IAtomicDocumentStore,
  IBootstrapService,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  type SessionMeta,
  IWorkspaceService,
  type AgentMeta,
  type IAgentScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';

import { errEnvelope, okEnvelope } from '../envelope';
import { acquireSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { toRestContextBreakdown } from '../protocol/context-usage';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
  type SnapshotSubagent,
} from '../protocol/rest-snapshot';
import {
  alignFrozenContextHistory,
  loadCapturedMessageHistoryTail,
  projectHydratedMessageHistoryTail,
  rehydrateCold,
} from '../services/messages/messageHistory';
import { readColdMainWireProjection } from '../services/snapshot/coldSnapshotSource';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { readAgentRuntimeControls } from './sessionAgentConfig';
import { resolveSessionBindingFacts, resolveSessionFacts, toWireSession } from './sessions';
import { boundedEntity } from '../transport/klient/boundedContent';
import { timeSessionViewPhase, type SessionViewTimingContext } from '../transport/klient/sessionViewTiming';
import { sessionAgentCounts } from './sessionAgentCounts';
import { sessionAgentRoster } from './sessionAgentRoster';

const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

export class SnapshotNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SnapshotNotFoundError';
  }
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const snapshotQuerySchema = z.object({
  mode: z.literal('transcript').optional(),
});

interface SnapshotRouteHost {
  readonly log?: SessionViewTimingContext['logger'];
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: {
        id: string;
        params: { session_id: string };
        query: { mode?: 'transcript' };
      },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SnapshotRouteDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
}

export function registerSnapshotRoutes(app: SnapshotRouteHost, deps: SnapshotRouteDeps): void {
  const { core, broadcaster } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/snapshot',
      params: sessionIdParamSchema,
      querystring: snapshotQuerySchema,
      success: { data: sessionSnapshotResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description:
        'Atomic session snapshot for client rebuild: state + as_of_seq watermark + epoch',
      tags: ['sessions'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      const { session_id } = req.params;
      try {
        const data = await assembleSnapshot(core, broadcaster, session_id, req.query.mode, signal, { logger: app.log, requestId: req.id });
        if (signal.aborted) return;
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof SnapshotNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id, err.stack));
          return;
        }
        throw err;
      }
    }, req),
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

export async function assembleBrowseSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  timing: SessionViewTimingContext = {},
): Promise<SessionSnapshotResponse> {
  return timeSessionViewPhase('snapshot', { sessionId, requestId: timing.requestId }, async () =>
    boundedSessionSnapshot(await assembleBrowseSnapshotSource(core, broadcaster, sessionId, undefined, timing), ''), timing);
}

export async function assembleBrowseSnapshotSource(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode?: 'legacy',
  timing: SessionViewTimingContext = {},
): Promise<SessionSnapshotResponse> {
  if (mode === 'legacy') return assembleSnapshotSource(core, broadcaster, sessionId, undefined, undefined, timing);
  if (core.accessor.get(ISessionManager).get(sessionId) !== undefined) {
    return assembleSnapshotSource(core, broadcaster, sessionId, 'transcript', undefined, timing);
  }
  const fields = { sessionId, requestId: timing.requestId };
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId), timing);
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => core.accessor.get(IAtomicDocumentStore).get<SessionMeta>(
    `sessions/${summary.workspaceId}/${sessionId}`, 'state.json',
  ), timing);
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId), timing);
  const workspace = await timeSessionViewPhase('snapshot_workspace', fields,
    () => core.accessor.get(IWorkspaceService).get(summary.workspaceId), timing);
  const subagents = sessionAgentRoster(sessionId, meta);
  return {
    as_of_seq: cursor.seq, epoch: cursor.epoch || `cold:${sessionId}`,
    session: toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
      await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main']), cursor.seq),
    messages: { items: [], has_more: false }, in_flight_turn: null,
    subagents, agent_counts: sessionAgentCounts(meta.agents, subagents),
    pending_approvals: [], pending_questions: [],
  };
}

export async function assembleSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode?: 'transcript',
  signal?: AbortSignal,
  timing: SessionViewTimingContext = {},
): Promise<SessionSnapshotResponse> {
  const context = { ...timing, signal: timing.signal ?? signal };
  return timeSessionViewPhase('snapshot', { sessionId, requestId: context.requestId }, async () => boundedSessionSnapshot(
    await assembleSnapshotSource(core, broadcaster, sessionId, mode, signal, context),
    mode === 'transcript' ? '' : 'legacy',
  ), context);
}

export function boundedSessionSnapshot(snapshot: SessionSnapshotResponse, id: string): SessionSnapshotResponse {
  return { ...boundedEntity(snapshot, { kind: 'snapshot', id }, 128 * 1024), agent_counts: snapshot.agent_counts };
}

async function assembleSnapshotSource(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
  signal?: AbortSignal,
  timing: SessionViewTimingContext = {},
): Promise<SessionSnapshotResponse> {
  signal?.throwIfAborted();
  if (core.accessor.get(ISessionManager).get(sessionId) === undefined) {
    return assembleColdSnapshot(core, broadcaster, sessionId, mode, signal);
  }
  const fields = { sessionId, requestId: timing.requestId };
  const lease = await timeSessionViewPhase('snapshot_acquire', fields,
    () => acquireSessionOperation(core, sessionId, 'operation'), timing);
  try {
    return await assembleSnapshotFromLease(core, broadcaster, sessionId, mode, lease, timing);
  } finally {
    await timeSessionViewPhase('snapshot_release', fields, async () => lease.dispose(), timing);
  }
}

async function assembleColdSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
  signal?: AbortSignal,
): Promise<SessionSnapshotResponse> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await core.accessor.get(IAtomicDocumentStore).get<SessionMeta>(
    `sessions/${summary.workspaceId}/${sessionId}`, 'state.json',
  );
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  signal?.throwIfAborted();
  const cursor = await broadcaster.getCursor(sessionId);
  const projection = await readColdMainWireProjection(core, summary.workspaceId, sessionId, signal);
  const aligned = alignFrozenContextHistory(projection.transcript, projection.transcript.logicalEntries);
  const compact = mode === 'transcript';
  const startIndex = Math.max(0, aligned.messages.length - SNAPSHOT_MESSAGE_PAGE_SIZE);
  const sessionScope = sessionScopeOf(
    workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId),
    sessionId,
  );
  const messageTail = compact
    ? undefined
    : projectHydratedMessageHistoryTail(
      sessionId,
      meta.createdAt,
      await rehydrateCold(core, sessionScope, aligned.messages.slice(startIndex)),
      aligned.times,
      startIndex,
    );
  const workspace = await core.accessor.get(IWorkspaceService).get(summary.workspaceId);
  const session = toWireSession(
    { ...meta, workspaceId: summary.workspaceId },
    workspace?.root ?? meta.cwd ?? '',
    await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main']),
    cursor.seq,
  );
  const subagentCandidates = sessionAgentRoster(sessionId, meta);
  const subagents = enrichSnapshotSubagents(
    subagentCandidates,
    meta.agents,
    broadcaster.getMaterializedTranscriptToolCallCounts(
      sessionId,
      subagentCandidates.map((subagent) => subagent.id),
    ),
  );
  return {
    as_of_seq: cursor.seq,
    epoch: cursor.epoch,
    session: {
      ...session,
      message_count: aligned.messages.length,
      agent_config: {
        ...session.agent_config,
        permission_mode: projection.permissionMode,
        plan_mode: projection.planActive,
      },
    },
    messages: { items: messageTail?.items ?? [], has_more: messageTail?.has_more ?? false },
    in_flight_turn: null,
    subagents,
    agent_counts: sessionAgentCounts(meta.agents, subagents),
    pending_approvals: [],
    pending_questions: [],
  };
}

async function assembleSnapshotFromLease(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
  lease: SessionOperationLease,
  timing: SessionViewTimingContext,
): Promise<SessionSnapshotResponse> {
  const compact = mode === 'transcript';
  const handle = lease.handle;
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }
  const fields = { sessionId, requestId: timing.requestId };
  const main = await timeSessionViewPhase('snapshot_ensure_main', { ...fields, agentId: 'main' }, () => ensureMainAgent(handle), timing);
  const snapState = await broadcaster.getSnapshotState(sessionId, {
    captureMessages: !compact,
    timing,
    capture: async () => {
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await timeSessionViewPhase('snapshot_workspace', fields,
        () => core.accessor.get(IWorkspaceService).get(workspaceId), timing);
      const meta = await timeSessionViewPhase('snapshot_metadata', fields,
        () => handle.accessor.get(ISessionMetadata).read(), timing);
      const projected = toWireSession({ ...meta, workspaceId }, workspace?.root ?? '', resolveSessionFacts(core, sessionId));
      const model = readBoundModel(main);
      return {
        meta,
        runtime: new Map(handle.accessor.get(IAgentLifecycleService).list().map((agent) =>
          [agent.id, agent.accessor.get(IAgentActivityView).state()] as const)),
        session: {
          ...projected,
          agent_config: {
            ...projected.agent_config,
            model: model ?? projected.agent_config?.model,
            ...(await timeSessionViewPhase('snapshot_controls', { ...fields, agentId: 'main' }, () => readAgentRuntimeControls(main), timing)),
          },
        },
      };
    },
  });
  if (snapState.captured === undefined) throw new SnapshotNotFoundError(sessionId);
  const { meta, session, runtime } = snapState.captured;
  const subagentCandidates = sessionAgentRoster(sessionId, meta, snapState.subagents, runtime);
  const subagentIds = subagentCandidates.map((subagent) => subagent.id);
  const toolCallCounts = broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, subagentIds);
  const subagents = enrichSnapshotSubagents(
    subagentCandidates,
    meta.agents,
    toolCallCounts,
  );
  const status = snapState.status;

  const messageTail = compact
    ? undefined
    : await loadCapturedMessageHistoryTail(
        main,
        sessionId,
        meta.createdAt,
        snapState.contextMessages,
        snapState.contextMessageTimes,
        SNAPSHOT_MESSAGE_PAGE_SIZE,
      );

  const inFlightTurn = attachCurrentPromptIdToInFlight(
    snapState.inFlightTurn,
    snapState.currentPromptId,
  );

  return {
    as_of_seq: snapState.seq,
    epoch: snapState.epoch,
    session: { ...session, message_count: compact ? snapState.contextMessageCount : snapState.contextMessages.length },
    messages: { items: messageTail?.items ?? [], has_more: messageTail?.has_more ?? false },
    in_flight_turn: inFlightTurn,
    subagents,
    agent_counts: sessionAgentCounts(meta.agents, subagents),
    context_tokens: status?.contextTokens,
    max_context_tokens: status?.maxContextTokens,
    context_breakdown:
      status?.contextBreakdown === undefined
        ? undefined
        : toRestContextBreakdown(status.contextBreakdown),
    pending_approvals: snapState.pendingApprovals,
    pending_questions: snapState.pendingQuestions,
  };
}

function readBoundModel(main: IAgentScopeHandle): string | undefined {
  try {
    return main.accessor.get(IAgentProfileService).getModel();
  } catch {
    return undefined;
  }
}

function enrichSnapshotSubagents(
  subagents: readonly SnapshotSubagent[],
  agents: Readonly<Record<string, AgentMeta>> | undefined,
  toolCallCounts: ReadonlyMap<string, number>,
): SnapshotSubagent[] {
  return subagents.map((subagent) => {
    const meta = agents?.[subagent.id];
    const userLabel = firstNonEmpty(subagentUserLabel(meta), subagent.label);
    const spawnedName = firstNonEmpty(subagent.profile, meta?.displayName);
    const terminalAt = meta?.completedAt;
    const currentOutcome = meta?.status !== undefined && terminalAt !== undefined &&
      Number.isFinite(terminalAt) &&
      Date.parse(subagent.started_at ?? '') <= terminalAt &&
      (subagent.completed_at === undefined || Date.parse(subagent.completed_at) <= terminalAt);
    const status = currentOutcome ? meta.status : subagent.status;
    return {
      ...subagent,
      description: resolveSubagentDisplayName(userLabel, spawnedName, subagent.id),
      profile: spawnedName,
      model: firstNonEmpty(meta?.model, subagent.model),
      thinking_effort: firstNonEmpty(meta?.thinkingEffort, subagent.thinking_effort),
      thinking_effort_explicit: meta?.thinkingEffort !== undefined ? meta.thinkingEffortExplicit : subagent.thinking_effort_explicit,
      executor_id: firstNonEmpty(meta?.executor, subagent.executor_id),
      executor_protocol: meta?.executor !== undefined ? meta.executorProtocol : subagent.executor_protocol,
      parent_agent_id: firstNonEmpty(subagent.parent_agent_id, subagentParentAgentId(meta)),
      label: userLabel,
      status,
      subagent_phase: currentOutcome
        ? status === 'completed' || status === 'failed' ? status : undefined
        : subagent.subagent_phase,
      completed_at: currentOutcome ? new Date(terminalAt).toISOString() : subagent.completed_at,
      output_preview: firstNonEmpty(subagent.output_preview, currentOutcome ? meta?.resultSummary : undefined),
      stop_reason: firstNonEmpty(subagent.stop_reason, currentOutcome ? meta?.error : undefined),
      tool_call_count: toolCallCounts.get(subagent.id) ?? (currentOutcome ? meta?.toolCallCount : undefined),
    };
  });
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function attachCurrentPromptIdToInFlight(
  inFlightTurn: InFlightTurn | null,
  currentPromptId: string | undefined,
): InFlightTurn | null {
  if (inFlightTurn === null || currentPromptId === undefined) return inFlightTurn;
  return { ...inFlightTurn, current_prompt_id: currentPromptId };
}

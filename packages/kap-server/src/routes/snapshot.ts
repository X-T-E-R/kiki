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
  IAgentContextMemoryService,
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
import { readAgentOutcome } from '@kiki/agent-core-v2/session/sessionMetadata/agentOutcomeStore';

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
import { boundedEntity, ContentChangedError, readContentSegment } from '../transport/klient/boundedContent';
import type { ContentRef, ContentSegment } from '@kiki/transcript';
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
  timing.signal?.throwIfAborted();
  if (mode === 'legacy') return assembleSnapshotSource(core, broadcaster, sessionId, undefined, timing.signal, timing);
  if (core.accessor.get(ISessionManager).get(sessionId) !== undefined) {
    return assembleSnapshotSource(core, broadcaster, sessionId, 'transcript', timing.signal, timing);
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
  timing.signal?.throwIfAborted();
  const subagents = sessionAgentRoster(sessionId, meta);
  return {
    as_of_seq: cursor.seq, epoch: cursor.epoch || `cold:${sessionId}`,
    session: toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
      await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], timing.signal, { includeAccounting: false }), cursor.seq),
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
    return assembleColdSnapshot(core, broadcaster, sessionId, mode, { ...timing, signal: timing.signal ?? signal });
  }
  const fields = { sessionId, requestId: timing.requestId };
  const lease = await timeSessionViewPhase('snapshot_acquire', fields,
    () => acquireSessionOperation(core, sessionId, 'operation', timing.signal), timing);
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
  timing: SessionViewTimingContext,
): Promise<SessionSnapshotResponse> {
  const { signal } = timing;
  const fields = { sessionId, requestId: timing.requestId };
  signal?.throwIfAborted();
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId), timing);
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => core.accessor.get(IAtomicDocumentStore).get<SessionMeta>(
    `sessions/${summary.workspaceId}/${sessionId}`, 'state.json',
  ), timing);
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  signal?.throwIfAborted();
  const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId), timing);
  const projection = await timeSessionViewPhase('snapshot_history', fields,
    () => readColdMainWireProjection(core, summary.workspaceId, sessionId, signal), timing);
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
  const workspace = await timeSessionViewPhase('snapshot_workspace', fields,
    () => core.accessor.get(IWorkspaceService).get(summary.workspaceId), timing);
  signal?.throwIfAborted();
  const session = toWireSession(
    { ...meta, workspaceId: summary.workspaceId },
    workspace?.root ?? meta.cwd ?? '',
    await timeSessionViewPhase('snapshot_binding', fields,
      () => resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], signal), timing),
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
  const metadata = handle.accessor.get(ISessionMetadata);
  await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
  timing.signal?.throwIfAborted();
  const snapState = await broadcaster.getSnapshotState(sessionId, {
    captureMessages: !compact,
    timing,
    capture: async () => {
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const meta = metadata.snapshot();
      const facts = resolveSessionFacts(core, sessionId);
      const model = readBoundModel(main);
      const runtime = new Map(handle.accessor.get(IAgentLifecycleService).list().map((agent) =>
        [agent.id, structuredClone(agent.accessor.get(IAgentActivityView).state())] as const));
      const [workspace, controls] = await Promise.all([
        timeSessionViewPhase('snapshot_workspace', fields,
          () => core.accessor.get(IWorkspaceService).get(workspaceId), timing),
        timeSessionViewPhase('snapshot_controls', { ...fields, agentId: 'main' }, () => readAgentRuntimeControls(main), timing),
      ]);
      timing.signal?.throwIfAborted();
      const projected = toWireSession({ ...meta, workspaceId }, workspace?.root ?? '', facts);
      return {
        meta,
        runtime,
        session: {
          ...projected,
          agent_config: {
            ...projected.agent_config,
            model: model ?? projected.agent_config?.model,
            ...controls,
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

export async function readBrowseSnapshotContent(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  agentId: string,
  ref: ContentRef,
  timing: SessionViewTimingContext = {},
): Promise<ContentSegment | undefined> {
  const fields = { sessionId, agentId, requestId: timing.requestId };
  return timeSessionViewPhase('snapshot_content', fields, async () => {
    timing.signal?.throwIfAborted();
    if (agentId !== 'main' || ref.source.kind !== 'snapshot' || !['', 'legacy'].includes(ref.source.id)) throw new ContentChangedError();
    const field = ref.path[0];
    if (typeof field !== 'string' || !['session', 'messages', 'subagents', 'in_flight_turn', 'pending_approvals', 'pending_questions', 'context_tokens', 'max_context_tokens', 'context_breakdown'].includes(field)) throw new ContentChangedError();
    if (field === 'messages') {
      const messages = ref.source.id === 'legacy'
        ? await timeSessionViewPhase('snapshot_content_messages', fields,
          () => readSnapshotMessageSource(core, broadcaster, sessionId, timing), timing)
        : { items: [], has_more: false };
      if (messages === undefined) return undefined;
      timing.signal?.throwIfAborted();
      return readContentSegment({ messages }, ref);
    }
    if (core.accessor.get(ISessionManager).get(sessionId) === undefined) {
      const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId), timing);
      if (summary === undefined) return undefined;
      timing.signal?.throwIfAborted();
      if (field !== 'subagents' && field !== 'session') return readContentSegment({ in_flight_turn: null, pending_approvals: [], pending_questions: [] }, ref);
      const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => core.accessor.get(IAtomicDocumentStore).get<SessionMeta>(
        `sessions/${summary.workspaceId}/${sessionId}`, 'state.json'), timing);
      if (meta === undefined) return undefined;
      timing.signal?.throwIfAborted();
      if (field === 'subagents') {
        const candidates = sessionAgentRoster(sessionId, meta);
        const index = ref.path[1];
        const receiptField = ref.path[2];
        if (typeof index === 'number' && (receiptField === 'output_preview' || receiptField === 'stop_reason')) {
          try {
            return readContentSegment({ subagents: candidates }, ref);
          } catch (error) {
            if (!(error instanceof ContentChangedError)) throw error;
          }
          const candidate = candidates[index];
          const saved = candidate === undefined ? undefined : meta.agents?.[candidate.id];
          if (candidate !== undefined && saved !== undefined) {
            const outcome = await readAgentOutcome(core.accessor.get(IAtomicDocumentStore),
              `sessions/${summary.workspaceId}/${sessionId}`, saved);
            timing.signal?.throwIfAborted();
            candidates[index] = { ...candidate, output_preview: outcome.resultSummary ?? candidate.output_preview,
              stop_reason: outcome.error ?? candidate.stop_reason };
          }
        }
        return readContentSegment({ subagents: ref.source.id === 'legacy'
          ? enrichSnapshotSubagents(candidates, meta.agents, broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, candidates.map((agent) => agent.id)))
          : candidates }, ref);
      }
      const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId), timing);
      timing.signal?.throwIfAborted();
      const workspace = await timeSessionViewPhase('snapshot_workspace', fields, () => core.accessor.get(IWorkspaceService).get(summary.workspaceId), timing);
      timing.signal?.throwIfAborted();
      const session = toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
        await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], timing.signal, { includeAccounting: false }), cursor.seq);
      if (ref.source.id !== 'legacy') return readContentSegment({ session }, ref);
      const projection = await timeSessionViewPhase('snapshot_content_controls', fields,
        () => readColdMainWireProjection(core, summary.workspaceId, sessionId, timing.signal), timing);
      timing.signal?.throwIfAborted();
      return readContentSegment({ session: { ...session, message_count: projection.transcript.logicalEntries.length,
        agent_config: { ...session.agent_config, permission_mode: projection.permissionMode, plan_mode: projection.planActive } } }, ref);
    }
    const lease = await timeSessionViewPhase('snapshot_content_acquire', fields,
      () => acquireSessionOperation(core, sessionId, 'operation', timing.signal), timing);
    try {
      const handle = lease.handle;
      if (handle === undefined) return undefined;
      const metadata = handle.accessor.get(ISessionMetadata);
      await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
      timing.signal?.throwIfAborted();
      const main = handle.accessor.get(IAgentLifecycleService).get('main');
      const state = await broadcaster.getSnapshotState(sessionId, {
        captureMessages: false,
        timing,
        capture: field !== 'session' && field !== 'subagents' ? undefined : async () => {
          const meta = metadata.snapshot();
          const runtime = new Map(handle.accessor.get(IAgentLifecycleService).list().map((agent) =>
            [agent.id, structuredClone(agent.accessor.get(IAgentActivityView).state())] as const));
          if (field === 'subagents') return { meta, runtime, session: undefined };
          const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
          const facts = resolveSessionFacts(core, sessionId);
          const model = main === undefined ? undefined : readBoundModel(main);
          const count = ref.source.id === 'legacy' && main !== undefined
            ? main.accessor.get(IAgentContextMemoryService).get().length : undefined;
          const [workspace, controls] = await Promise.all([
            timeSessionViewPhase('snapshot_workspace', fields, () => core.accessor.get(IWorkspaceService).get(workspaceId), timing),
            main === undefined ? {} : timeSessionViewPhase('snapshot_controls', fields, () => readAgentRuntimeControls(main), timing),
          ]);
          timing.signal?.throwIfAborted();
          const projected = toWireSession({ ...meta, workspaceId }, workspace?.root ?? '', facts);
          return { meta, runtime, session: { ...projected, message_count: count,
            agent_config: { ...projected.agent_config, model: model ?? projected.agent_config?.model, ...controls } } };
        },
      });
      timing.signal?.throwIfAborted();
      let source: object;
      if (field === 'session') {
        if (state.captured?.session === undefined) return undefined;
        source = { session: { ...state.captured.session, message_count: state.captured.session.message_count ?? state.contextMessageCount } };
      } else if (field === 'subagents') {
        if (state.captured === undefined) return undefined;
        const candidates = sessionAgentRoster(sessionId, state.captured.meta, state.subagents, state.captured.runtime);
        source = { subagents: enrichSnapshotSubagents(candidates, state.captured.meta.agents,
          broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, candidates.map((agent) => agent.id))) };
      } else {
        source = {
          in_flight_turn: attachCurrentPromptIdToInFlight(state.inFlightTurn, state.currentPromptId),
          pending_approvals: state.pendingApprovals,
          pending_questions: state.pendingQuestions,
          context_tokens: state.status?.contextTokens,
          max_context_tokens: state.status?.maxContextTokens,
          context_breakdown: state.status?.contextBreakdown === undefined ? undefined : toRestContextBreakdown(state.status.contextBreakdown),
        };
      }
      return readContentSegment(source, ref);
    } finally {
      await timeSessionViewPhase('snapshot_content_release', fields, async () => lease.dispose(), timing);
    }
  }, timing);
}

async function readSnapshotMessageSource(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  timing: SessionViewTimingContext,
): Promise<SessionSnapshotResponse['messages'] | undefined> {
  const fields = { sessionId, requestId: timing.requestId };
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId), timing);
  if (summary === undefined) return undefined;
  timing.signal?.throwIfAborted();
  const live = core.accessor.get(ISessionManager).get(sessionId);
  if (live === undefined) {
    const projection = await timeSessionViewPhase('snapshot_content_history', fields,
      () => readColdMainWireProjection(core, summary.workspaceId, sessionId, timing.signal), timing);
    const aligned = alignFrozenContextHistory(projection.transcript, projection.transcript.logicalEntries);
    const start = Math.max(0, aligned.messages.length - SNAPSHOT_MESSAGE_PAGE_SIZE);
    const scope = sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId), sessionId);
    timing.signal?.throwIfAborted();
    const hydrated = await rehydrateCold(core, scope, aligned.messages.slice(start));
    timing.signal?.throwIfAborted();
    return projectHydratedMessageHistoryTail(sessionId, summary.createdAt, hydrated, aligned.times, start);
  }
  const lease = await timeSessionViewPhase('snapshot_content_acquire', fields,
    () => acquireSessionOperation(core, sessionId, 'operation', timing.signal), timing);
  try {
    const handle = lease.handle;
    if (handle === undefined) return undefined;
    const metadata = handle.accessor.get(ISessionMetadata);
    await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
    timing.signal?.throwIfAborted();
    const main = handle.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) return { items: [], has_more: false };
    const captured = await broadcaster.getSnapshotState(sessionId, { timing, captureMessages: true,
      capture: async () => metadata.snapshot().createdAt });
    timing.signal?.throwIfAborted();
    return await loadCapturedMessageHistoryTail(main, sessionId, captured.captured ?? summary.createdAt,
      captured.contextMessages, captured.contextMessageTimes, SNAPSHOT_MESSAGE_PAGE_SIZE);
  } finally {
    await timeSessionViewPhase('snapshot_content_release', fields, async () => lease.dispose(), timing);
  }
}

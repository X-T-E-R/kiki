import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from '@kiki/transcript-live';
import {
  IAgentProfileService,
  IAgentLifecycleService,
  IAgentActivityView,
  IAgentContextMemoryService,
  IAtomicDocumentStore,
  IBootstrapService,
  IConfigService,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  type SessionMeta,
  IWorkspaceService,
  type AgentMeta,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { readAgentOutcome } from '@kiki/agent-core-v2/session/sessionMetadata/agentOutcomeStore';
import { resolveSnapshotRosterLimits, resolveSubagentSearchLimit } from '@kiki/agent-core-v2/session/subagent/configSection';

import { errEnvelope, okEnvelope } from '../envelope';
import { acquireSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import {
  toRestContextBreakdown,
  ErrorCode,
  sessionSnapshotResponseSchema,
  sessionSubagentsQuerySchema,
  sessionSubagentsResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
  type SessionSubagentsQuery,
  type SessionSubagentsResponse,
  type SnapshotSubagent,
} from '@kiki/protocol';
import {
  alignFrozenContextHistory,
  type CapturedContextMessageHistory,
  hydrateMessageTail,
  projectHydratedMessageHistoryTail,
  rehydrateCold,
} from '../services/messages/messageHistory';
import { readColdSessionMeta, readColdSessionMetaBySessionId } from '../services/snapshot/coldSessionMeta';
import { readColdMainWireProjection } from '../services/snapshot/coldSnapshotSource';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toAttentionCursor } from '../transport/ws/v1/sessionEventJournal';
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
        query: Record<string, unknown>;
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

  const subagentsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/subagents',
      params: sessionIdParamSchema,
      querystring: sessionSubagentsQuerySchema,
      success: { data: sessionSubagentsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description: 'On-demand subagent search and lookup over ordered session roster without resuming cold sessions',
      tags: ['sessions'],
    },
    async (req, reply) => withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      const { session_id } = req.params;
      try {
        const data = await searchSessionSubagents(core, broadcaster, session_id, req.query, { logger: app.log, requestId: req.id, signal });
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
  app.get(subagentsRoute.path, subagentsRoute.options, subagentsRoute.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

function optionalConfig(core: Scope): IConfigService | undefined {
  try {
    return core.accessor.get(IConfigService);
  } catch {
    return undefined;
  }
}

function snapshotRosterWindowFor(
  subagents: readonly SnapshotSubagent[] | undefined,
  config: IConfigService | undefined,
): number {
  const { activeLimit, settledLimit } = resolveSnapshotRosterLimits(config);
  if (subagents === undefined || subagents.length === 0) return settledLimit;
  let activeCount = 0;
  for (const row of subagents) {
    if (isSnapshotSubagentActive(row) || (row.is_branch === true && row.branch_sealed !== true)) {
      activeCount += 1;
      if (activeCount >= activeLimit) break;
    } else {
      break;
    }
  }
  return activeCount + settledLimit;
}

export async function assembleBrowseSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  timing: SessionViewTimingContext = {},
): Promise<SessionSnapshotResponse> {
  const config = optionalConfig(core);
  return timeSessionViewPhase('snapshot', { sessionId, requestId: timing.requestId }, async () => {
    const source = await assembleBrowseSnapshotSource(core, broadcaster, sessionId, undefined, timing);
    return boundedSessionSnapshot(source, '', snapshotRosterWindowFor(source.subagents, config));
  }, timing);
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
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId, undefined, timing.signal), timing);
  timing.signal?.throwIfAborted();
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => readColdSessionMeta(core, summary.workspaceId, sessionId), timing);
  timing.signal?.throwIfAborted();
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId, timing.signal, true), timing);
  timing.signal?.throwIfAborted();
  const workspace = await timeSessionViewPhase('snapshot_workspace', fields,
    () => core.accessor.get(IWorkspaceService).get(summary.workspaceId), timing);
  timing.signal?.throwIfAborted();
  const { subagents, counts } = coldBrowseRoster(sessionId, meta);
  const facts = await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], timing.signal, { includeAccounting: false, sessionMetadata: meta });
  return {
    as_of_seq: cursor.seq, epoch: cursor.epoch || `cold:${sessionId}`,
    session: toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
      facts, cursor.seq, false, toAttentionCursor(cursor)),
    context_tokens: facts.usage === undefined || (facts.usage.context_tokens === 0 && facts.usage.turn_count > 0)
      ? undefined
      : facts.usage.context_tokens,
    max_context_tokens: (facts.usage?.context_limit ?? 0) > 0 ? facts.usage?.context_limit : undefined,
    messages: { items: [], has_more: false }, in_flight_turn: null,
    subagents, agent_counts: counts,
    pending_approvals: [], pending_questions: [],
  };
}

type ColdBrowseRoster = {
  readonly sessionId: string;
  readonly subagents: SnapshotSubagent[];
  readonly counts: ReturnType<typeof sessionAgentCounts>;
  byId?: Map<string, SnapshotSubagent>;
  searchIndex?: string[];
};

const coldBrowseRosters = new WeakMap<SessionMeta, ColdBrowseRoster>();

function coldBrowseRoster(sessionId: string, meta: SessionMeta): ColdBrowseRoster {
  const cached = coldBrowseRosters.get(meta);
  if (cached?.sessionId === sessionId) return cached;
  const subagents = orderSnapshotSubagents(sessionAgentRoster(sessionId, meta));
  const entry: ColdBrowseRoster = { sessionId, subagents, counts: sessionAgentCounts(meta.agents, subagents) };
  coldBrowseRosters.set(meta, entry);
  return entry;
}

function subagentSearchBlob(row: SnapshotSubagent): string {
  const parts: string[] = [row.id];
  if (row.agent_id !== undefined && row.agent_id !== row.id) parts.push(row.agent_id);
  if (row.label !== undefined && row.label !== '') parts.push(row.label);
  if (row.description !== undefined && row.description !== '' && row.description !== row.label && row.description !== row.id) parts.push(row.description);
  if (row.profile !== undefined && row.profile !== '') parts.push(row.profile);
  if (row.model !== undefined && row.model !== '') parts.push(row.model);
  if (row.output_preview !== undefined && row.output_preview !== '') parts.push(row.output_preview);
  return parts.join('\n').toLowerCase();
}

function matchesSubagentStatus(row: SnapshotSubagent, status: string): boolean {
  if (status === '') return true;
  if (status === 'active') return isSnapshotSubagentActive(row);
  if (status === 'branch') return row.is_branch === true;
  const effective = (row.activity_status ?? row.status ?? '').toLowerCase();
  return effective === status || (row.status ?? '').toLowerCase() === status;
}

function matchesSubagentQuery(row: SnapshotSubagent, query: string): boolean {
  if (query === '') return true;
  if (row.id.toLowerCase().includes(query)) return true;
  if (row.agent_id !== undefined && row.agent_id !== row.id && row.agent_id.toLowerCase().includes(query)) return true;
  if (row.label !== undefined && row.label.toLowerCase().includes(query)) return true;
  if (row.description !== undefined && row.description.toLowerCase().includes(query)) return true;
  if (row.profile !== undefined && row.profile.toLowerCase().includes(query)) return true;
  if (row.model !== undefined && row.model.toLowerCase().includes(query)) return true;
  if (row.output_preview !== undefined && row.output_preview.toLowerCase().includes(query)) return true;
  return false;
}

export async function searchSessionSubagents(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  query: SessionSubagentsQuery = {},
  timing: SessionViewTimingContext = {},
): Promise<SessionSubagentsResponse> {
  timing.signal?.throwIfAborted();
  const config = optionalConfig(core);
  const limit = Math.min(500, Math.max(1, query.limit ?? resolveSubagentSearchLimit(config)));
  const exactAgentId = query.agent_id?.trim() ?? '';
  const q = query.q?.trim().toLowerCase() ?? '';
  const status = query.status?.trim().toLowerCase() ?? '';
  const fields = { sessionId, requestId: timing.requestId };
  let subagents: readonly SnapshotSubagent[];
  let coldRoster: ColdBrowseRoster | undefined;
  const liveHandle = core.accessor.get(ISessionManager).get(sessionId);
  if (liveHandle === undefined) {
    const meta = await timeSessionViewPhase(
      'snapshot_metadata',
      fields,
      () => readColdSessionMetaBySessionId(core, sessionId, async () =>
        (await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId, undefined, timing.signal), timing))?.workspaceId),
      timing,
    );
    timing.signal?.throwIfAborted();
    if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
    coldRoster = coldBrowseRoster(sessionId, meta);
    subagents = coldRoster.subagents;
  } else if ('accessor' in liveHandle && liveHandle.accessor !== undefined) {
    const metadata = liveHandle.accessor.get(ISessionMetadata);
    await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
    timing.signal?.throwIfAborted();
    const state = await broadcaster.getSnapshotState(sessionId, {
      captureMessages: false,
      timing,
      capture: async () => ({
        meta: metadata.snapshot(),
        runtime: new Map(liveHandle.accessor.get(IAgentLifecycleService).list().map((agent) =>
          [agent.id, { ...agent.accessor.get(IAgentActivityView).state(), model: readBoundModel(agent) }] as const)),
      }),
    });
    timing.signal?.throwIfAborted();
    if (state.captured === undefined) throw new SnapshotNotFoundError(sessionId);
    const candidates = sessionAgentRoster(sessionId, state.captured.meta, state.subagents, state.captured.runtime);
    subagents = orderSnapshotSubagents(enrichSnapshotSubagents(candidates, state.captured.meta.agents,
      broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, candidates.map((agent) => agent.id))));
  } else {
    const snapshot = await assembleSnapshotSource(core, broadcaster, sessionId, 'transcript', timing.signal, timing);
    subagents = snapshot.subagents ?? [];
  }
  const total = subagents.length;
  if (exactAgentId !== '') {
    let hit: SnapshotSubagent | undefined;
    if (coldRoster !== undefined) {
      if (coldRoster.byId === undefined) {
        const map = new Map<string, SnapshotSubagent>();
        for (const row of coldRoster.subagents) map.set(row.agent_id ?? row.id, row);
        coldRoster.byId = map;
      }
      hit = coldRoster.byId.get(exactAgentId);
    } else {
      hit = subagents.find((row) => row.agent_id === exactAgentId || row.id === exactAgentId);
    }
    if (hit !== undefined && matchesSubagentStatus(hit, status) && matchesSubagentQuery(hit, q)) {
      return { items: [hit], total, matched: 1 };
    }
    return { items: [], total, matched: 0 };
  }
  if (q === '' && status === '') {
    return { items: subagents.slice(0, limit), total, matched: total };
  }
  let searchIndex: string[] | undefined;
  if (q !== '' && coldRoster !== undefined) {
    if (coldRoster.searchIndex === undefined) {
      const index = Array.from<string>({ length: coldRoster.subagents.length });
      for (let i = 0; i < coldRoster.subagents.length; i += 1) {
        index[i] = subagentSearchBlob(coldRoster.subagents[i]!);
      }
      coldRoster.searchIndex = index;
    }
    searchIndex = coldRoster.searchIndex;
  }
  const items: SnapshotSubagent[] = [];
  let matched = 0;
  for (let i = 0; i < total; i += 1) {
    const row = subagents[i]!;
    if (status !== '' && !matchesSubagentStatus(row, status)) continue;
    if (q !== '' && !(searchIndex !== undefined ? searchIndex[i]!.includes(q) : matchesSubagentQuery(row, q))) continue;
    matched += 1;
    if (items.length < limit) items.push(row);
  }
  return { items, total, matched };
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
  const config = optionalConfig(core);
  return timeSessionViewPhase('snapshot', { sessionId, requestId: context.requestId }, async () => {
    const source = await assembleSnapshotSource(core, broadcaster, sessionId, mode, signal, context);
    return boundedSessionSnapshot(
      source,
      mode === 'transcript' ? '' : 'legacy',
      snapshotRosterWindowFor(source.subagents, config),
    );
  }, context);
}

export function boundedSessionSnapshot(snapshot: SessionSnapshotResponse, id: string, rosterWindow?: number): SessionSnapshotResponse {
  return { ...boundedEntity(snapshot, { kind: 'snapshot', id }, 128 * 1024, undefined, 'head', rosterWindow), agent_counts: snapshot.agent_counts };
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
    () => acquireSessionOperation(core, sessionId, 'operation', timing.signal, { priority: 'background' }), timing);
  let prepared: PreparedLiveSnapshot;
  try {
    prepared = await prepareSnapshotFromLease(core, broadcaster, sessionId, mode, lease, timing);
  } finally {
    await timeSessionViewPhase('snapshot_release', fields, async () => lease.dispose(), timing);
  }
  if (prepared.deferredHistory === undefined) return prepared.response;
  const { createdAt, hydratedTail, startIndex, historyPromise } = prepared.deferredHistory;
  const history = await historyPromise;
  const messageTail = projectHydratedMessageHistoryTail(sessionId, createdAt, hydratedTail, history.times, startIndex);
  return {
    ...prepared.response,
    messages: { items: messageTail.items, has_more: messageTail.has_more },
  };
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
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId, undefined, signal), timing);
  signal?.throwIfAborted();
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => readColdSessionMeta(core, summary.workspaceId, sessionId), timing);
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  signal?.throwIfAborted();
  const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId, signal, true), timing);
  signal?.throwIfAborted();
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
  const facts = await timeSessionViewPhase('snapshot_binding', fields,
    () => resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], signal, { sessionMetadata: meta }), timing);
  const session = toWireSession(
    { ...meta, workspaceId: summary.workspaceId },
    workspace?.root ?? meta.cwd ?? '',
    facts,
    cursor.seq,
    false,
    toAttentionCursor(cursor),
  );
  const coldRoster = coldBrowseRoster(sessionId, meta);
  const subagentIds = coldRoster.subagents.map((subagent) => subagent.id);
  const toolCallCounts = broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, subagentIds);
  const subagents = toolCallCounts.size === 0
    ? coldRoster.subagents
    : orderSnapshotSubagents(enrichSnapshotSubagents(coldRoster.subagents, meta.agents, toolCallCounts));
  return {
    as_of_seq: cursor.seq,
    epoch: cursor.epoch,
    context_tokens: facts.usage === undefined || (facts.usage.context_tokens === 0 && facts.usage.turn_count > 0)
      ? undefined
      : facts.usage.context_tokens,
    max_context_tokens: (facts.usage?.context_limit ?? 0) > 0 ? facts.usage?.context_limit : undefined,
    session: {
      ...session,
      message_count: aligned.messages.length,
      agent_config: {
        ...session.agent_config,
        permission_mode: session.agent_config.permission_mode ?? (projection.permissionConfigured ? projection.permissionMode : undefined),
        plan_mode: session.agent_config.plan_mode ?? projection.planActive,
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

interface DeferredSnapshotHistory {
  readonly createdAt: number;
  readonly hydratedTail: readonly ContextMessage[];
  readonly startIndex: number;
  readonly historyPromise: Promise<CapturedContextMessageHistory>;
}

interface PreparedLiveSnapshot {
  readonly response: SessionSnapshotResponse;
  readonly deferredHistory?: DeferredSnapshotHistory;
}

async function prepareSnapshotFromLease(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
  lease: SessionOperationLease,
  timing: SessionViewTimingContext,
): Promise<PreparedLiveSnapshot> {
  const compact = mode === 'transcript';
  const handle = lease.handle;
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }
  const fields = { sessionId, requestId: timing.requestId };
  const main = handle.accessor.get(IAgentLifecycleService).get('main');
  const metadata = handle.accessor.get(ISessionMetadata);
  await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
  timing.signal?.throwIfAborted();
  const snapState = await broadcaster.getSnapshotState(sessionId, {
    captureMessages: !compact,
    deferHistory: !compact,
    timing,
    capture: async () => {
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const meta = metadata.snapshot();
      const facts = resolveSessionFacts(core, sessionId);
      const model = main === undefined ? undefined : readBoundModel(main);
      const runtime = new Map(handle.accessor.get(IAgentLifecycleService).list().map((agent) =>
        [agent.id, { ...agent.accessor.get(IAgentActivityView).state(), model: readBoundModel(agent) }] as const));
      const [workspace, controls] = await Promise.all([
        timeSessionViewPhase('snapshot_workspace', fields,
          () => core.accessor.get(IWorkspaceService).get(workspaceId), timing),
        main === undefined ? {} : timeSessionViewPhase('snapshot_controls', { ...fields, agentId: 'main' }, () => readAgentRuntimeControls(main), timing),
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
  const subagents = orderSnapshotSubagents(enrichSnapshotSubagents(
    subagentCandidates,
    meta.agents,
    toolCallCounts,
  ));
  const status = snapState.status;

  let deferredHistory: DeferredSnapshotHistory | undefined;
  let immediateMessages: SessionSnapshotResponse['messages'] = { items: [], has_more: false };
  if (!compact && main !== undefined) {
    const { hydratedTail, startIndex } = await hydrateMessageTail(
      main,
      snapState.contextMessages,
      SNAPSHOT_MESSAGE_PAGE_SIZE,
    );
    if (snapState.historyPromise !== undefined) {
      deferredHistory = {
        createdAt: meta.createdAt,
        hydratedTail,
        startIndex,
        historyPromise: snapState.historyPromise,
      };
    } else {
      const messageTail = projectHydratedMessageHistoryTail(
        sessionId,
        meta.createdAt,
        hydratedTail,
        snapState.contextMessageTimes,
        startIndex,
      );
      immediateMessages = { items: messageTail.items, has_more: messageTail.has_more };
    }
  }

  const inFlightTurn = attachCurrentPromptIdToInFlight(
    snapState.inFlightTurn,
    snapState.currentPromptId,
  );

  return {
    response: {
      as_of_seq: snapState.seq,
      epoch: snapState.epoch,
      session: {
        ...session,
        last_seq: snapState.seq,
        attention_cursor: toAttentionCursor(snapState),
        message_count: compact ? snapState.contextMessageCount : snapState.contextMessages.length,
      },
      messages: immediateMessages,
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
    },
    deferredHistory,
  };
}

function isSnapshotSubagentActive(subagent: SnapshotSubagent): boolean {
  return subagent.activity_status === 'running' ||
    subagent.activity_status === 'suspended' ||
    (subagent.live === true && subagent.status === 'running');
}

function snapshotSubagentRecency(subagent: SnapshotSubagent): number | undefined {
  let latest: number | undefined;
  const started = subagent.started_at;
  if (started !== undefined) {
    const parsed = Date.parse(started);
    if (Number.isFinite(parsed)) latest = parsed;
  }
  const completed = subagent.completed_at;
  if (completed !== undefined) {
    const parsed = Date.parse(completed);
    if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) latest = parsed;
  }
  const created = subagent.created_at;
  if (created !== undefined) {
    const parsed = Date.parse(created);
    if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) latest = parsed;
  }
  return latest;
}

function snapshotSubagentOrdinal(subagent: SnapshotSubagent): number | undefined {
  const id = subagent.agent_id ?? subagent.id;
  if (!id.startsWith('agent-') || id.length <= 6) return undefined;
  let value = 0;
  for (let index = 6; index < id.length; index += 1) {
    const code = id.charCodeAt(index) - 48;
    if (code < 0 || code > 9) return undefined;
    value = value * 10 + code;
  }
  return Number.isSafeInteger(value) ? value : undefined;
}

function orderSnapshotSubagents(subagents: readonly SnapshotSubagent[]): SnapshotSubagent[] {
  const length = subagents.length;
  if (length <= 1) return [...subagents];
  const entries = Array.from<{
    readonly subagent: SnapshotSubagent;
    readonly index: number;
    readonly active: boolean;
    readonly openBranch: boolean;
    readonly recency: number | undefined;
    readonly ordinal: number | undefined;
  }>({ length });
  for (let index = 0; index < length; index += 1) {
    const subagent = subagents[index]!;
    entries[index] = {
      subagent,
      index,
      active: isSnapshotSubagentActive(subagent),
      openBranch: subagent.is_branch === true && subagent.branch_sealed !== true,
      recency: snapshotSubagentRecency(subagent),
      ordinal: snapshotSubagentOrdinal(subagent),
    };
  }
  entries.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.openBranch !== right.openBranch) return left.openBranch ? -1 : 1;
    if (left.recency !== right.recency) {
      if (left.recency === undefined) return 1;
      if (right.recency === undefined) return -1;
      return right.recency - left.recency;
    }
    if (left.ordinal !== undefined && right.ordinal !== undefined && left.ordinal !== right.ordinal) {
      return right.ordinal - left.ordinal;
    }
    return left.index - right.index;
  });
  const ordered = Array.from<SnapshotSubagent>({ length });
  for (let index = 0; index < length; index += 1) ordered[index] = entries[index]!.subagent;
  return ordered;
}

function readBoundModel(main: IAgentScopeHandle): string | undefined {
  try {
    const model = main.accessor.get(IAgentProfileService).getModel();
    return model !== '' ? model : undefined;
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
      subagent.started_at !== undefined &&
      Date.parse(subagent.started_at) <= terminalAt &&
      (subagent.completed_at === undefined || Date.parse(subagent.completed_at) <= terminalAt);
    const status = currentOutcome ? meta.status : subagent.status;
    return {
      ...subagent,
      description: resolveSubagentDisplayName(userLabel, spawnedName, subagent.id),
      profile: spawnedName,
      model: firstNonEmpty(subagent.model, meta?.model),
      thinking_effort: firstNonEmpty(meta?.thinkingEffort, subagent.thinking_effort),
      thinking_effort_explicit: meta?.thinkingEffort !== undefined ? meta.thinkingEffortExplicit : subagent.thinking_effort_explicit,
      executor_id: firstNonEmpty(meta?.executor, subagent.executor_id),
      executor_protocol: meta?.executor !== undefined ? meta.executorProtocol : subagent.executor_protocol,
      parent_agent_id: firstNonEmpty(subagent.parent_agent_id, subagentParentAgentId(meta)),
      label: userLabel,
      is_branch: meta?.labels?.['branch'] === 'true' ? true : subagent.is_branch,
      branch_seed: (meta?.labels?.['branchSeed'] as SnapshotSubagent['branch_seed']) ?? subagent.branch_seed,
      branch_initiator: (meta?.labels?.['branchInitiator'] as SnapshotSubagent['branch_initiator']) ?? subagent.branch_initiator,
      tools_locked: meta?.labels?.['branch'] === 'true'
        ? meta.labels['toolsLocked'] === 'true'
        : subagent.tools_locked,
      branch_sealed: meta?.labels?.['branch'] === 'true'
        ? meta.labels['branchSealed'] === 'true'
        : subagent.branch_sealed,
      branch_base_turn_id:
        meta?.labels?.['branchBaseTurnId'] !== undefined && /^\d+$/.test(meta.labels['branchBaseTurnId'])
          ? Number(meta.labels['branchBaseTurnId'])
          : subagent.branch_base_turn_id,
      branch_base_message_id:
        meta?.labels?.['branchBaseMessageId'] !== undefined && meta.labels['branchBaseMessageId'].length > 0
          ? meta.labels['branchBaseMessageId']
          : subagent.branch_base_message_id,
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

function firstNonEmpty(primary: string | undefined, secondary: string | undefined): string | undefined {
  if (primary !== undefined && primary.length > 0) return primary;
  if (secondary !== undefined && secondary.length > 0) return secondary;
  return undefined;
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
      const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId, undefined, timing.signal), timing);
      timing.signal?.throwIfAborted();
      if (summary === undefined) return undefined;
      if (field !== 'subagents' && field !== 'session') return readContentSegment({ in_flight_turn: null, pending_approvals: [], pending_questions: [] }, ref);
      const meta = await timeSessionViewPhase('snapshot_metadata', fields, () => readColdSessionMeta(core, summary.workspaceId, sessionId), timing);
      if (meta === undefined) return undefined;
      timing.signal?.throwIfAborted();
      if (field === 'subagents') {
        const candidates = ref.source.id === 'legacy'
          ? (() => {
            const rawCandidates = sessionAgentRoster(sessionId, meta);
            return orderSnapshotSubagents(enrichSnapshotSubagents(rawCandidates, meta.agents,
              broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, rawCandidates.map((agent) => agent.id))));
          })()
          : coldBrowseRoster(sessionId, meta).subagents;
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
            const patched = [...candidates];
            patched[index] = { ...candidate, output_preview: outcome.resultSummary ?? candidate.output_preview,
              stop_reason: outcome.error ?? candidate.stop_reason };
            return readContentSegment({ subagents: patched }, ref);
          }
        }
        return readContentSegment({ subagents: candidates }, ref);
      }
      const cursor = await timeSessionViewPhase('snapshot_cursor', fields, () => broadcaster.getCursor(sessionId, timing.signal, true), timing);
      timing.signal?.throwIfAborted();
      const workspace = await timeSessionViewPhase('snapshot_workspace', fields, () => core.accessor.get(IWorkspaceService).get(summary.workspaceId), timing);
      timing.signal?.throwIfAborted();
      const session = toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
        await resolveSessionBindingFacts(core, sessionId, summary.workspaceId, summary.usage, meta.agents?.['main'], timing.signal, { includeAccounting: false, sessionMetadata: meta }), cursor.seq, false, toAttentionCursor(cursor));
      if (ref.source.id !== 'legacy') return readContentSegment({ session }, ref);
      const projection = await timeSessionViewPhase('snapshot_content_controls', fields,
        () => readColdMainWireProjection(core, summary.workspaceId, sessionId, timing.signal), timing);
      timing.signal?.throwIfAborted();
      return readContentSegment({ session: { ...session, message_count: projection.transcript.logicalEntries.length,
        agent_config: { ...session.agent_config, permission_mode: projection.permissionMode, plan_mode: projection.planActive } } }, ref);
    }
    const liveHandle = core.accessor.get(ISessionManager).get(sessionId);
    if (field === 'subagents' && liveHandle !== undefined && 'accessor' in liveHandle && liveHandle.accessor !== undefined) {
      const metadata = liveHandle.accessor.get(ISessionMetadata);
      await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
      timing.signal?.throwIfAborted();
      const state = await broadcaster.getSnapshotState(sessionId, {
        captureMessages: false,
        timing,
        capture: async () => ({
          meta: metadata.snapshot(),
          runtime: new Map(liveHandle.accessor.get(IAgentLifecycleService).list().map((agent) =>
            [agent.id, { ...agent.accessor.get(IAgentActivityView).state(), model: readBoundModel(agent) }] as const)),
        }),
      });
      timing.signal?.throwIfAborted();
      if (state.captured === undefined) return undefined;
      const candidates = sessionAgentRoster(sessionId, state.captured.meta, state.subagents, state.captured.runtime);
      const subagents = orderSnapshotSubagents(enrichSnapshotSubagents(candidates, state.captured.meta.agents,
        broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, candidates.map((agent) => agent.id))));
      const index = ref.path[1];
      const receiptField = ref.path[2];
      if (typeof index === 'number' && (receiptField === 'output_preview' || receiptField === 'stop_reason') && metadata.readAgentWithOutcome !== undefined) {
        try {
          return readContentSegment({ subagents }, ref);
        } catch (error) {
          if (!(error instanceof ContentChangedError)) throw error;
        }
        const candidate = subagents[index];
        if (candidate !== undefined) {
          const outcome = await metadata.readAgentWithOutcome(candidate.id);
          timing.signal?.throwIfAborted();
          if (outcome !== undefined) {
            subagents[index] = {
              ...candidate,
              output_preview: outcome.resultSummary ?? candidate.output_preview,
              stop_reason: outcome.error ?? candidate.stop_reason,
            };
          }
        }
      }
      return readContentSegment({ subagents }, ref);
    }
    const lease = await timeSessionViewPhase('snapshot_content_acquire', fields,
      () => acquireSessionOperation(core, sessionId, 'operation', timing.signal, { priority: 'background' }), timing);
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
            [agent.id, { ...agent.accessor.get(IAgentActivityView).state(), model: readBoundModel(agent) }] as const));
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
        source = {
          session: {
            ...state.captured.session,
            last_seq: state.seq,
            attention_cursor: toAttentionCursor(state),
            message_count: state.captured.session.message_count ?? state.contextMessageCount,
          },
        };
      } else if (field === 'subagents') {
        if (state.captured === undefined) return undefined;
        const candidates = sessionAgentRoster(sessionId, state.captured.meta, state.subagents, state.captured.runtime);
        source = { subagents: orderSnapshotSubagents(enrichSnapshotSubagents(candidates, state.captured.meta.agents,
          broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, candidates.map((agent) => agent.id)))) };
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
  const summary = await timeSessionViewPhase('snapshot_index', fields, () => core.accessor.get(ISessionIndex).get(sessionId, undefined, timing.signal), timing);
  timing.signal?.throwIfAborted();
  if (summary === undefined) return undefined;
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
    () => acquireSessionOperation(core, sessionId, 'operation', timing.signal, { priority: 'background' }), timing);
  let deferredHistory: DeferredSnapshotHistory | undefined;
  try {
    const handle = lease.handle;
    if (handle === undefined) return undefined;
    const metadata = handle.accessor.get(ISessionMetadata);
    await timeSessionViewPhase('snapshot_metadata_ready', fields, () => metadata.ready, timing);
    timing.signal?.throwIfAborted();
    const main = handle.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) return { items: [], has_more: false };
    const captured = await broadcaster.getSnapshotState(sessionId, {
      timing,
      captureMessages: true,
      deferHistory: true,
      capture: async () => metadata.snapshot().createdAt,
    });
    timing.signal?.throwIfAborted();
    const { hydratedTail, startIndex } = await hydrateMessageTail(
      main,
      captured.contextMessages,
      SNAPSHOT_MESSAGE_PAGE_SIZE,
    );
    if (captured.historyPromise === undefined) {
      return projectHydratedMessageHistoryTail(
        sessionId,
        captured.captured ?? summary.createdAt,
        hydratedTail,
        captured.contextMessageTimes,
        startIndex,
      );
    }
    deferredHistory = {
      createdAt: captured.captured ?? summary.createdAt,
      hydratedTail,
      startIndex,
      historyPromise: captured.historyPromise,
    };
  } finally {
    await timeSessionViewPhase('snapshot_content_release', fields, async () => lease.dispose(), timing);
  }
  const history = await deferredHistory.historyPromise;
  return projectHydratedMessageHistoryTail(
    sessionId,
    deferredHistory.createdAt,
    deferredHistory.hydratedTail,
    history.times,
    deferredHistory.startIndex,
  );
}

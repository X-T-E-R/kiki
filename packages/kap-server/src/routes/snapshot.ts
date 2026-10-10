import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from '@kiki/transcript-live';
import {
  ensureMainAgent,
  IAgentProfileService,
  IAtomicDocumentStore,
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

import { errEnvelope, okEnvelope } from '../envelope';
import { acquireSessionOperation, type SessionOperationLease } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { toRestContextBreakdown } from '../protocol/context-usage';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
  type SnapshotSubagent,
} from '../protocol/rest-snapshot';
import { loadCapturedMessageHistoryTail } from '../services/messages/messageHistory';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { readAgentRuntimeControls } from './sessionAgentConfig';
import { resolveSessionFacts, toWireSession } from './sessions';
import { boundedEntity } from '../transport/klient/boundedContent';

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
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        const data = await assembleSnapshot(core, broadcaster, session_id, req.query.mode);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (err instanceof SnapshotNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id, err.stack));
          return;
        }
        throw err;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

export async function assembleBrowseSnapshot(core: Scope, broadcaster: SessionEventBroadcaster, sessionId: string): Promise<SessionSnapshotResponse> {
  return boundedEntity(await assembleBrowseSnapshotSource(core, broadcaster, sessionId), { kind: 'snapshot', id: '' }, 24 * 1024);
}

export async function assembleBrowseSnapshotSource(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode?: 'legacy',
): Promise<SessionSnapshotResponse> {
  if (mode === 'legacy') return assembleSnapshotSource(core, broadcaster, sessionId, undefined);
  if (core.accessor.get(ISessionManager).get(sessionId) !== undefined) {
    return assembleSnapshotSource(core, broadcaster, sessionId, 'transcript');
  }
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) throw new SnapshotNotFoundError(sessionId);
  const meta = await core.accessor.get(IAtomicDocumentStore).get<SessionMeta>(
    `sessions/${summary.workspaceId}/${sessionId}`, 'state.json',
  );
  if (meta === undefined) throw new SnapshotNotFoundError(sessionId);
  const cursor = await broadcaster.getCursor(sessionId);
  const workspace = await core.accessor.get(IWorkspaceService).get(summary.workspaceId);
  const subagents: SnapshotSubagent[] = Object.entries(meta.agents ?? {})
    .filter(([id]) => id !== 'main')
    .map(([id, agent]) => ({
      id, agent_id: id, session_id: sessionId, kind: 'subagent',
      description: resolveSubagentDisplayName(subagentUserLabel(agent), agent.displayName, id),
      status: agent.status ?? 'running', live: false,
      created_at: new Date(meta.createdAt).toISOString(),
      completed_at: agent.completedAt === undefined ? undefined : new Date(agent.completedAt).toISOString(),
      profile: agent.displayName, label: subagentUserLabel(agent),
      parent_agent_id: subagentParentAgentId(agent),
      model: agent.model, thinking_effort: agent.thinkingEffort,
      output_preview: agent.resultSummary?.slice(0, 2048), stop_reason: agent.error?.slice(0, 2048),
      tool_call_count: agent.toolCallCount,
    }));
  return {
    as_of_seq: cursor.seq, epoch: cursor.epoch || `cold:${sessionId}`,
    session: toWireSession({ ...meta, workspaceId: summary.workspaceId }, workspace?.root ?? meta.cwd ?? '',
      { ...resolveSessionFacts(core, sessionId, summary.usage),
        agentConfig: { model: meta.agents?.['main']?.model ?? '' } }, cursor.seq),
    messages: { items: [], has_more: false }, in_flight_turn: null,
    subagents, pending_approvals: [], pending_questions: [],
  };
}

export async function assembleSnapshot(...args: Parameters<typeof assembleSnapshotSource>): Promise<SessionSnapshotResponse> {
  return boundedEntity(await assembleSnapshotSource(...args), { kind: 'snapshot', id: args[3] === 'transcript' ? '' : 'legacy' }, 24 * 1024);
}

async function assembleSnapshotSource(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
): Promise<SessionSnapshotResponse> {
  const lease = await acquireSessionOperation(core, sessionId, 'operation');
  try {
    return await assembleSnapshotFromLease(core, broadcaster, sessionId, mode, lease);
  } finally {
    lease.dispose();
  }
}

async function assembleSnapshotFromLease(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
  lease: SessionOperationLease,
): Promise<SessionSnapshotResponse> {
  const compact = mode === 'transcript';
  const handle = lease.handle;
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }

  const main = await ensureMainAgent(handle);
  const snapState = await broadcaster.getSnapshotState(sessionId, {
    captureMessages: !compact,
    capture: async () => {
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await core.accessor.get(IWorkspaceService).get(workspaceId);
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const projected = toWireSession({ ...meta, workspaceId }, workspace?.root ?? '', resolveSessionFacts(core, sessionId));
      const model = readBoundModel(main);
      return {
        meta,
        session: {
          ...projected,
          agent_config: {
            ...projected.agent_config,
            model: model ?? projected.agent_config?.model,
            ...(await readAgentRuntimeControls(main)),
          },
        },
      };
    },
  });
  if (snapState.captured === undefined) throw new SnapshotNotFoundError(sessionId);
  const { meta, session } = snapState.captured;
  const subagentCandidates = [...snapState.subagents];
  const subagentIds = subagentCandidates.map((subagent) => subagent.id);
  const toolCallCounts = broadcaster.getMaterializedTranscriptToolCallCounts(sessionId, subagentIds);
  void broadcaster.getTranscriptToolCallCounts(sessionId, subagentIds).catch(() => undefined);
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
      Date.parse(subagent.started_at ?? subagent.created_at) <= terminalAt &&
      (subagent.completed_at === undefined || Date.parse(subagent.completed_at) <= terminalAt);
    const status = currentOutcome ? meta.status : subagent.status;
    return {
      ...subagent,
      description: resolveSubagentDisplayName(userLabel, spawnedName, subagent.id),
      profile: spawnedName,
      model: firstNonEmpty(subagent.model, meta?.model),
      thinking_effort: firstNonEmpty(subagent.thinking_effort, meta?.thinkingEffort),
      thinking_effort_explicit: subagent.thinking_effort_explicit ?? meta?.thinkingEffortExplicit,
      executor_id: firstNonEmpty(subagent.executor_id, meta?.executor),
      executor_protocol: firstNonEmpty(subagent.executor_protocol, meta?.executorProtocol),
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

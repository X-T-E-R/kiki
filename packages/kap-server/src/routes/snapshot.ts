import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from '@kiki/transcript-live';
import {
  ensureMainAgent,
  IAgentProfileService,
  ISessionContext,
  ISessionMetadata,
  IWorkspaceService,
  resumeSessionById,
  type AgentMeta,
  type IAgentScopeHandle,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
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

export async function assembleSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
  mode: 'transcript' | undefined,
): Promise<SessionSnapshotResponse> {
  const compact = mode === 'transcript';
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }

  const main = await ensureMainAgent(handle);
  const snapState = await broadcaster.getSnapshotState(sessionId, {
    captureMessages: true,
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
  const subagents = enrichSnapshotSubagents(
    subagentCandidates,
    meta.agents,
    await broadcaster.getTranscriptToolCallCounts(sessionId, subagentIds),
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
    session: { ...session, message_count: snapState.contextMessages.length },
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

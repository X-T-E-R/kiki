import {
  ensureMainAgent,
  IAgentProfileService,
  ISessionContext,
  ISessionInteractionService,
  ISessionMetadata,
  IWorkspaceService,
  resumeSessionById,
  type AgentMeta,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
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
import { loadCapturedMessageHistory } from '../services/messages/messageHistory';
import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from '../services/subagentProjection';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from './questions';
import { readAgentRuntimeControls } from './sessionAgentConfig';
import { resolveSessionFacts, toWireSession } from './sessions';

const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

class SnapshotNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SnapshotNotFoundError';
  }
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface SnapshotRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { session_id: string } },
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
        const data = await assembleSnapshot(core, broadcaster, session_id);
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

async function assembleSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
): Promise<SessionSnapshotResponse> {
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }

  const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
  const workspace = await core.accessor.get(IWorkspaceService).get(workspaceId);
  const cwd = workspace?.root ?? '';
  const meta = await handle.accessor.get(ISessionMetadata).read();

  const main = await ensureMainAgent(handle);
  const snapState = await broadcaster.getSnapshotState(sessionId);
  const projected = toWireSession(
    { ...meta, workspaceId },
    cwd,
    resolveSessionFacts(core, sessionId),
  );
  const model = readBoundModel(main);
  const session = {
    ...projected,
    agent_config: {
      ...projected.agent_config,
      ...(model === undefined ? {} : { model }),
      ...(await readAgentRuntimeControls(main)),
    },
  };
  const subagentCandidates = [...snapState.subagents];
  const toolCallCounts = await broadcaster.getTranscriptToolCallCounts(
    sessionId,
    subagentCandidates.map((subagent) => subagent.id),
  );
  const subagents = enrichSnapshotSubagents(subagentCandidates, meta.agents, toolCallCounts);
  const status = snapState.status;

  const all = await loadCapturedMessageHistory(
    main,
    sessionId,
    meta.createdAt,
    snapState.contextMessages,
    snapState.contextMessageTimes,
  );
  const hasMore = all.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
  const items = all.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);

  const inFlightTurn = attachCurrentPromptIdToInFlight(
    snapState.inFlightTurn,
    snapState.currentPromptId,
  );

  const interaction = handle.accessor.get(ISessionInteractionService);
  const pendingApprovals = interaction
    .listPending('approval')
    .map((i) => toWireApproval(i, sessionId));
  const pendingQuestions = interaction
    .listPending('question')
    .map((i) => toWireQuestion(i, sessionId));

  return {
    as_of_seq: snapState.seq,
    epoch: snapState.epoch,
    session,
    messages: { items, has_more: hasMore },
    in_flight_turn: inFlightTurn,
    subagents,
    context_tokens: status?.contextTokens,
    max_context_tokens: status?.maxContextTokens,
    context_breakdown:
      status?.contextBreakdown === undefined
        ? undefined
        : toRestContextBreakdown(status.contextBreakdown),
    pending_approvals: pendingApprovals,
    pending_questions: pendingQuestions,
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
    return {
      ...subagent,
      description: resolveSubagentDisplayName(userLabel, spawnedName, subagent.id),
      profile: spawnedName,
      parent_agent_id: firstNonEmpty(subagent.parent_agent_id, subagentParentAgentId(meta)),
      label: userLabel,
      tool_call_count: Math.max(
        subagent.tool_call_count ?? 0,
        toolCallCounts.get(subagent.id) ?? 0,
      ),
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

import { ref, type LiveRef } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import type { AgentExecutionStatus } from '#/app/agentExecutor/agentExecutor';
import { IConfigService } from '#/app/config/config';
import { IAgentActivityView, type AgentActivityTelemetry } from '#/agent/activityView/activityView';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentTaskService,
  type AgentTaskInfo,
  type AgentTaskStatus,
} from '#/agent/task/task';
import type { SubagentTaskInfo } from '#/agent/task/types';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';
import type { DirectChildAgent } from '#/session/agentCollaboration/directChildren';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isUnknownCapability } from '#/kosong/contract/capability';
import {
  AGENT_LIST_TELEMETRY_FIELDS,
  resolveAgentListLimit,
  resolveAgentListTelemetryFields,
  type AgentListTelemetryField,
} from '#/session/subagent/configSection';

import {
  IAgentListTool,
  AgentListInputSchema,
  type AgentListEntry,
  type AgentListInput,
  type AgentListOutput,
  type AgentListStatus,
} from './agent-list';
import AGENT_LIST_DESCRIPTION from './agent-list.md?raw';

const FINISHED_STATUSES = new Set<AgentListStatus>(['completed', 'interrupted', 'errored']);

export class AgentListTool implements IAgentListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentList' as const;
  readonly description = AGENT_LIST_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentListInputSchema);

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ref(IConfigService) private readonly config?: LiveRef<IConfigService>,
  ) {}

  resolveExecution(args: AgentListInput): ToolExecution {
    return {
      description: 'Listing child agents',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        const includeFinished = args.include_finished ?? false;
        const limit = args.limit ?? resolveAgentListLimit(this.config?.current);
        const query = args.query?.trim().toLowerCase() ?? '';
        const allowedFields = new Set<AgentListTelemetryField>(
          args.raw === true
            ? AGENT_LIST_TELEMETRY_FIELDS
            : resolveAgentListTelemetryFields(this.config?.current),
        );
        const now = Date.now();
        const session = await this.metadata.read();
        const latestRuns = latestAgentRuns(this.tasks.list(false));
        const agents = session.agents;
        const callerAgentId = this.scope.agentId;
        const top: RankedCandidate[] = [];
        let totalMatched = 0;
        if (agents !== undefined) {
          for (const agentId in agents) {
            if (!Object.hasOwn(agents, agentId)) continue;
            const meta = agents[agentId]!;
            if (subagentParentAgentId(meta) !== callerAgentId) continue;
            const name = meta.labels?.[COLLABORATION_TASK_NAME_LABEL];
            const profileName = meta.labels?.[COLLABORATION_AGENT_TYPE_LABEL] ?? meta.displayName;
            if (query !== '') {
              const matched =
                agentId.toLowerCase().includes(query) ||
                (name !== undefined && name.toLowerCase().includes(query)) ||
                (profileName !== undefined && profileName.toLowerCase().includes(query));
              if (!matched) continue;
            }
            const live = this.lifecycle.get(agentId);
            const loop = live?.accessor.get(IAgentLoopService)?.status();
            const execution = live?.accessor.get(IAgentExecutionService)?.status();
            const task = latestRuns.get(agentId);
            let status: AgentListStatus;
            let fromOutcome = false;
            let persistenceFailure: AgentListEntry['persistence_failure'];
            if (loop?.persistenceFailure !== undefined) {
              status = 'persistence_failed';
              persistenceFailure = {
                turn_id: loop.activeTurnId,
                execution_outcome: loop.persistenceFailure.executionOutcome,
                message: loop.persistenceFailure.message,
              };
            } else {
              const outcome = task === undefined || (task.status === 'running' && task.taskId === meta.taskId)
                ? meta.status
                : undefined;
              const active = execution?.state === 'starting' || execution?.state === 'running' || execution?.state === 'cancelling';
              fromOutcome = !active && (outcome === 'completed' || outcome === 'cancelled' || outcome === 'failed');
              status = active ? 'running'
                : outcome === 'completed' ? 'completed'
                : outcome === 'cancelled' ? 'interrupted'
                : outcome === 'failed' ? 'errored'
                : execution?.state === 'broken' ? 'errored'
                : execution?.state === 'closed' ? 'interrupted'
                : statusOf(task?.status);
            }
            if (!includeFinished && FINISHED_STATUSES.has(status)) continue;
            totalMatched += 1;
            const rank = status === 'running' || status === 'persistence_failed' ? 0 : FINISHED_STATUSES.has(status) ? 2 : 1;
            const recency = rank === 0
              ? (task?.startedAt ?? execution?.startedAt ?? meta.createdAt ?? -1)
              : (meta.completedAt ?? task?.endedAt ?? task?.startedAt ?? meta.createdAt ?? -1);
            const candidate: RankedCandidate = {
              agentId,
              name,
              profileName,
              meta,
              status,
              rank,
              recency,
              live,
              execution,
              task,
              fromOutcome,
              persistenceFailure,
            };
            insertTopCandidate(top, candidate, limit);
          }
        }
        const entries = top.map((candidate) => buildEntry({
          child: {
            agentId: candidate.agentId,
            name: candidate.name,
            profileName: candidate.profileName,
            meta: candidate.meta,
          },
          status: candidate.status,
          live: candidate.live,
          execution: candidate.execution,
          task: candidate.task,
          fromOutcome: candidate.fromOutcome,
          allowedFields,
          now,
          persistenceFailure: candidate.persistenceFailure,
        }));
        const omitted = Math.max(0, totalMatched - limit);
        const output: AgentListOutput =
          omitted > 0
            ? {
                agents: entries,
                omitted,
                note: `${omitted} further children omitted; address known children by name or agent_id`,
              }
            : { agents: entries };
        return { output: JSON.stringify(output), isError: false };
      },
    };
  }
}

registerAgentToolService(IAgentListTool, AgentListTool, { name: 'AgentList', domain: 'subagent' });

function latestAgentRuns(tasks: readonly AgentTaskInfo[]): ReadonlyMap<string, SubagentTaskInfo> {
  const latest = new Map<string, SubagentTaskInfo>();
  for (const task of tasks) {
    if (task.kind !== 'agent' || task.agentId === undefined) continue;
    const prior = latest.get(task.agentId);
    if (prior === undefined || task.startedAt > prior.startedAt) latest.set(task.agentId, task);
  }
  return latest;
}

interface BuildEntryInput {
  readonly child: DirectChildAgent;
  readonly status: AgentListStatus;
  readonly live: IAgentScopeHandle | undefined;
  readonly execution: AgentExecutionStatus | undefined;
  readonly task: SubagentTaskInfo | undefined;
  readonly fromOutcome: boolean;
  readonly allowedFields: ReadonlySet<AgentListTelemetryField>;
  readonly now: number;
  readonly persistenceFailure?: AgentListEntry['persistence_failure'];
}

function buildEntry(input: BuildEntryInput): AgentListEntry {
  const { child, status, live, execution, task, fromOutcome, allowedFields, now, persistenceFailure } = input;
  const activityView = live?.accessor.get(IAgentActivityView);
  const activityTelemetry = activityView?.telemetry?.();
  return {
    agent_id: child.agentId,
    name: child.name,
    profile: child.profileName,
    status,
    model: allowedFields.has('model') ? resolveModel(child, live, task) : undefined,
    thinking_effort: allowedFields.has('thinking_effort') ? resolveThinkingEffort(child, live, task) : undefined,
    elapsed_ms: allowedFields.has('elapsed_ms')
      ? resolveElapsedMs(child, status, execution, activityTelemetry, task, fromOutcome, now)
      : undefined,
    idle_ms: allowedFields.has('idle_ms') ? resolveIdleMs(status, activityTelemetry, now) : undefined,
    tool_call_count: allowedFields.has('tool_call_count')
      ? resolveToolCallCount(child, status, activityView, activityTelemetry)
      : undefined,
    context_tokens: allowedFields.has('context_tokens') ? resolveContextTokens(child, live) : undefined,
    persistence_failure: persistenceFailure,
  };
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function isTaskNewerThanMeta(task: SubagentTaskInfo | undefined, child: DirectChildAgent): boolean {
  if (task === undefined) return false;
  if (child.meta.taskId !== undefined && task.taskId === child.meta.taskId) return false;
  if (child.meta.completedAt !== undefined) return task.startedAt > child.meta.completedAt;
  if (child.meta.createdAt !== undefined) return task.startedAt > child.meta.createdAt;
  return true;
}

function resolveModel(
  child: DirectChildAgent,
  live: IAgentScopeHandle | undefined,
  task: SubagentTaskInfo | undefined,
): string | undefined {
  const liveModel = nonEmptyString(live?.accessor.get(IAgentProfileService)?.data().modelAlias);
  if (liveModel !== undefined) return liveModel;
  const metaModel = nonEmptyString(child.meta.model);
  const taskModel = nonEmptyString(task?.model);
  return isTaskNewerThanMeta(task, child) ? taskModel ?? metaModel : metaModel ?? taskModel;
}

function normalizeThinkingEffort(
  effort: string | undefined,
  explicit: boolean | undefined,
  supportsThinking?: boolean,
): string | undefined {
  const value = nonEmptyString(effort);
  if (value === undefined) return undefined;
  if (value === 'off') {
    if (supportsThinking === false) return undefined;
    if (explicit !== true) return undefined;
  }
  return value;
}

function resolveThinkingEffort(
  child: DirectChildAgent,
  live: IAgentScopeHandle | undefined,
  task: SubagentTaskInfo | undefined,
): string | undefined {
  const profileService = live?.accessor.get(IAgentProfileService);
  if (profileService !== undefined) {
    const data = profileService.data();
    const supportsThinking = data.driver === 'external' || data.modelCapabilities === undefined || isUnknownCapability(data.modelCapabilities)
      ? undefined
      : data.modelCapabilities.thinking;
    const liveEffort = normalizeThinkingEffort(
      data.effectiveThinkingLevel ?? data.thinkingLevel,
      data.thinkingEffortExplicit,
      supportsThinking,
    );
    if (liveEffort !== undefined) return liveEffort;
    if (nonEmptyString(data.modelAlias) !== undefined) return undefined;
  }
  const metaEffort = normalizeThinkingEffort(child.meta.thinkingEffort, child.meta.thinkingEffortExplicit);
  const taskEffort = normalizeThinkingEffort(task?.thinkingEffort, task?.thinkingEffortExplicit);
  return isTaskNewerThanMeta(task, child) ? taskEffort ?? metaEffort : metaEffort ?? taskEffort;
}

function resolveElapsedMs(
  child: DirectChildAgent,
  status: AgentListStatus,
  execution: AgentExecutionStatus | undefined,
  activityTelemetry: AgentActivityTelemetry | undefined,
  task: SubagentTaskInfo | undefined,
  fromOutcome: boolean,
  now: number,
): number | undefined {
  if (status === 'running' || status === 'persistence_failed') {
    const runningTaskStart = task?.status === 'running' ? task.startedAt : undefined;
    const liveRunStart = execution?.startedAt ?? activityTelemetry?.activeTurnStartedAt;
    const fallbackCreatedStart = child.meta.completedAt === undefined ? child.meta.createdAt : undefined;
    const start = runningTaskStart ?? liveRunStart ?? fallbackCreatedStart;
    return start === undefined ? undefined : Math.max(0, now - start);
  }
  if (FINISHED_STATUSES.has(status)) {
    if (fromOutcome) {
      if (task !== undefined && child.meta.taskId !== undefined && task.taskId === child.meta.taskId) {
        const end = task.endedAt ?? child.meta.completedAt;
        return end !== undefined && end >= task.startedAt ? end - task.startedAt : undefined;
      }
      if (task === undefined && child.meta.createdAt !== undefined && child.meta.completedAt !== undefined) {
        return child.meta.completedAt >= child.meta.createdAt
          ? child.meta.completedAt - child.meta.createdAt
          : undefined;
      }
      return undefined;
    }
    if (task !== undefined && task.endedAt !== null && task.endedAt >= task.startedAt) {
      return task.endedAt - task.startedAt;
    }
  }
  return undefined;
}

function resolveIdleMs(
  status: AgentListStatus,
  activityTelemetry: AgentActivityTelemetry | undefined,
  now: number,
): number | undefined {
  if (status !== 'running' && status !== 'persistence_failed') return undefined;
  if (activityTelemetry?.lastActivityAt === undefined) return undefined;
  return Math.max(0, now - activityTelemetry.lastActivityAt);
}

function resolveToolCallCount(
  child: DirectChildAgent,
  status: AgentListStatus,
  activityView: IAgentActivityView | undefined,
  activityTelemetry: AgentActivityTelemetry | undefined,
): number | undefined {
  if (activityView !== undefined && activityTelemetry !== undefined) {
    const hasObservedRun =
      status === 'running' ||
      status === 'persistence_failed' ||
      activityTelemetry.toolCallCount > 0 ||
      activityTelemetry.lastActivityAt !== undefined ||
      activityView.state().lastTurn !== undefined ||
      child.meta.toolCallCount !== undefined;
    return hasObservedRun ? activityTelemetry.toolCallCount : undefined;
  }
  const persisted = child.meta.toolCallCount;
  return typeof persisted === 'number' && Number.isSafeInteger(persisted) && persisted >= 0
    ? persisted
    : undefined;
}

function resolveContextTokens(
  child: DirectChildAgent,
  live: IAgentScopeHandle | undefined,
): number | undefined {
  const liveTokens = live?.accessor.get(IAgentTokenCountingService)?.statusSize();
  if (typeof liveTokens === 'number' && Number.isFinite(liveTokens) && liveTokens > 0) {
    return liveTokens;
  }
  const persisted = child.meta.contextTokens;
  return typeof persisted === 'number' && Number.isFinite(persisted) && persisted > 0
    ? persisted
    : undefined;
}

function statusOf(status: AgentTaskStatus | undefined): AgentListStatus {
  if (status === undefined) return 'untracked';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'killed' || status === 'timed_out' || status === 'lost') return 'interrupted';
  if (status === 'failed') return 'errored';
  return 'unknown';
}

interface RankedCandidate {
  readonly agentId: string;
  readonly name: string | undefined;
  readonly profileName: string | undefined;
  readonly meta: DirectChildAgent['meta'];
  readonly status: AgentListStatus;
  readonly rank: number;
  readonly recency: number;
  readonly live: IAgentScopeHandle | undefined;
  readonly execution: AgentExecutionStatus | undefined;
  readonly task: SubagentTaskInfo | undefined;
  readonly fromOutcome: boolean;
  readonly persistenceFailure: AgentListEntry['persistence_failure'];
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.recency !== right.recency) return right.recency - left.recency;
  if (left.name !== undefined && right.name !== undefined) {
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  } else if (left.name !== undefined) {
    return -1;
  } else if (right.name !== undefined) {
    return 1;
  }
  return left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0;
}

function insertTopCandidate(top: RankedCandidate[], candidate: RankedCandidate, cap: number): void {
  const length = top.length;
  if (length >= cap && compareRankedCandidates(candidate, top[length - 1]!) >= 0) return;
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareRankedCandidates(candidate, top[mid]!) < 0) high = mid;
    else low = mid + 1;
  }
  top.splice(low, 0, candidate);
  if (top.length > cap) top.pop();
}

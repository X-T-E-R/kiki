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
  directChildAgents,
  type DirectChildAgent,
} from '#/session/agentCollaboration/directChildren';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isUnknownCapability } from '#/kosong/contract/capability';
import {
  AGENT_LIST_TELEMETRY_FIELDS,
  resolveAgentListTelemetryFields,
  type AgentListTelemetryField,
} from '#/session/subagent/configSection';

import {
  IAgentListTool,
  MAX_AGENT_LIST_ENTRIES,
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
        const allowedFields = new Set<AgentListTelemetryField>(
          args.raw === true
            ? AGENT_LIST_TELEMETRY_FIELDS
            : resolveAgentListTelemetryFields(this.config?.current),
        );
        const now = Date.now();
        const session = await this.metadata.read();
        const latestRuns = latestAgentRuns(this.tasks.list(false));
        const entries = directChildAgents(session.agents, this.scope.agentId)
          .map((child) => {
            const live = this.lifecycle.get(child.agentId);
            const loop = live?.accessor.get(IAgentLoopService)?.status();
            const execution = live?.accessor.get(IAgentExecutionService)?.status();
            const task = latestRuns.get(child.agentId);
            if (loop?.persistenceFailure !== undefined) {
              return buildEntry({
                child,
                status: 'persistence_failed',
                live,
                execution,
                task,
                fromOutcome: false,
                allowedFields,
                now,
                persistenceFailure: {
                  turn_id: loop.activeTurnId,
                  execution_outcome: loop.persistenceFailure.executionOutcome,
                  message: loop.persistenceFailure.message,
                },
              });
            }
            const outcome = task === undefined || task.status === 'running' && task.taskId === child.meta.taskId
              ? child.meta.status
              : undefined;
            const active = execution?.state === 'starting' || execution?.state === 'running' || execution?.state === 'cancelling';
            const fromOutcome = !active && (outcome === 'completed' || outcome === 'cancelled' || outcome === 'failed');
            const status = active ? 'running'
              : outcome === 'completed' ? 'completed'
              : outcome === 'cancelled' ? 'interrupted'
              : outcome === 'failed' ? 'errored'
              : execution?.state === 'broken' ? 'errored'
              : execution?.state === 'closed' ? 'interrupted'
              : statusOf(task?.status);
            return buildEntry({
              child,
              status,
              live,
              execution,
              task,
              fromOutcome,
              allowedFields,
              now,
            });
          })
          .filter((entry) => includeFinished || !FINISHED_STATUSES.has(entry.status))
          .sort(byRunningFirst);
        const omitted = Math.max(0, entries.length - MAX_AGENT_LIST_ENTRIES);
        const output: AgentListOutput =
          omitted > 0
            ? { agents: entries.slice(0, MAX_AGENT_LIST_ENTRIES), omitted }
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

function byRunningFirst(left: AgentListEntry, right: AgentListEntry): number {
  const leftRunning = left.status === 'running' ? 0 : 1;
  const rightRunning = right.status === 'running' ? 0 : 1;
  return leftRunning - rightRunning;
}

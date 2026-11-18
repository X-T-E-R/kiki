import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { Turn } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { latestAssistantText } from '#/session/subagent/runAgentTurn';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
} from '#/session/agentCollaboration/registry';

export async function resumeAgentTask(child: IAgentScopeHandle, turn: Turn): Promise<void> {
  const parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  if (parentId === undefined) return;
  const parent = child.accessor.get(IAgentLifecycleService).get(parentId);
  if (parent === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'The saved execution task owner is unavailable');
  const tasks = parent.accessor.get(IAgentTaskService);
  const metadata = child.accessor.get(ISessionMetadata);
  const meta = metadata.peekAgent !== undefined ? metadata.peekAgent(child.id) : metadata.snapshot().agents?.[child.id];
  const info = await tasks.findPausedAgentTask(child.id, meta?.labels?.[COLLABORATION_LATEST_TASK_LABEL]);
  if (info?.kind !== 'agent') return;
  const controller = new AbortController();
  const durable = turn.durableResult ?? turn.result;
  const cancelTurn = (): void => { turn.cancel(controller.signal.reason); };
  if (controller.signal.aborted) cancelTurn();
  else controller.signal.addEventListener('abort', cancelTurn, { once: true });
  void durable.then(
    () => { controller.signal.removeEventListener('abort', cancelTurn); },
    () => { controller.signal.removeEventListener('abort', cancelTurn); },
  );
  const completion = durable.then(result => {
    if (result.type === 'failed') throw result.error;
    if (result.type === 'cancelled') throw result.reason;
    return { summary: latestAssistantText(child.accessor.get(IAgentContextMemoryService).get()
      .filter(message => message.source?.turnId === turn.id)) };
  });
  const profileName = info.profile ?? 'worker';
  const taskName = info.collaborationTaskName ?? meta?.labels?.[COLLABORATION_TASK_NAME_LABEL];
  const agentType = info.collaborationAgentType ?? meta?.labels?.[COLLABORATION_AGENT_TYPE_LABEL] ?? profileName;
  const resolveParentSteering = (): string | undefined => {
    try {
      return child.accessor.get(IAgentProfileService).getParentSteering?.();
    } catch {
      return undefined;
    }
  };
  const mirrored = mirrorAgentRun(parent, {
    agentId: child.id,
    turn,
    completion,
  }, {
    profileName, signal: controller.signal,
    cancel: (reason) => { controller.abort(reason); },
    deferStarted: true, resolveTaskId: () => info.taskId,
  });
  tasks.registerTask(new SubagentTask({
    agentId: child.id, name: taskName, sourceRef: info.sourceRef, profileName,
    parentToolCallId: info.parentToolCallId, model: info.model,
    thinkingEffort: info.thinkingEffort, thinkingEffortExplicit: info.thinkingEffortExplicit,
    executorId: info.executorId, executorProtocol: info.executorProtocol,
    parentSteering: resolveParentSteering() ?? info.parentSteering,
    completion: mirrored.then(result => ({ result: result.summary, usage: result.usage })),
  }, info.description, controller, taskName === undefined ? undefined : { taskName, agentType }, resolveParentSteering), {
    taskId: info.taskId,
    detached: info.detached,
    lifetime: info.lifetime,
    timeoutMs: info.timeoutMs,
  });
}

export async function settleUnresumedAgentTask(child: IAgentScopeHandle): Promise<void> {
  let parentId: string | undefined;
  try {
    parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  } catch {
    return;
  }
  if (parentId === undefined) return;
  let parent: IAgentScopeHandle | undefined;
  try {
    parent = child.accessor.get(IAgentLifecycleService).get(parentId);
  } catch {
    return;
  }
  if (parent === undefined) return;
  let tasks: IAgentTaskService;
  try {
    tasks = parent.accessor.get(IAgentTaskService);
  } catch {
    return;
  }
  if (tasks.findPausedAgentTask === undefined || tasks.settlePausedAgentTask === undefined) return;
  let latestTaskId: string | undefined;
  try {
    const metadata = child.accessor.get(ISessionMetadata);
    const agent = metadata.peekAgent !== undefined ? metadata.peekAgent(child.id) : metadata.snapshot().agents?.[child.id];
    latestTaskId = agent?.labels?.[COLLABORATION_LATEST_TASK_LABEL];
  } catch {
    latestTaskId = undefined;
  }
  const info = await tasks.findPausedAgentTask(child.id, latestTaskId);
  if (info?.kind !== 'agent') return;
  await tasks.settlePausedAgentTask(info.taskId, 'Execution ended before the pause point and was not resumed.');
}

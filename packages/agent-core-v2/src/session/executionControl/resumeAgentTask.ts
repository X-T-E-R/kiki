import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { Turn } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { latestAssistantText } from '#/session/subagent/runAgentTurn';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';

export async function resumeAgentTask(child: IAgentScopeHandle, turn: Turn): Promise<void> {
  const parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  if (parentId === undefined) return;
  const parent = child.accessor.get(IAgentLifecycleService).get(parentId);
  if (parent === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'The saved execution task owner is unavailable');
  const tasks = parent.accessor.get(IAgentTaskService);
  await tasks.resumeRestoration?.();
  const info = tasks.list(false).find(info => info.kind === 'agent' && info.agentId === child.id && info.status === 'running');
  if (info?.kind !== 'agent') return;
  const controller = new AbortController();
  const completion = (turn.durableResult ?? turn.result).then(result => {
    if (result.type === 'failed') throw result.error;
    if (result.type === 'cancelled') throw result.reason;
    return { summary: latestAssistantText(child.accessor.get(IAgentContextMemoryService).get()
      .filter(message => message.source?.turnId === turn.id)) };
  });
  const mirrored = mirrorAgentRun(parent, { agentId: child.id, turn, completion }, {
    profileName: info.profile ?? 'worker', signal: controller.signal,
    deferStarted: true, resolveTaskId: () => info.taskId,
  });
  tasks.registerTask(new SubagentTask({
    agentId: child.id, sourceRef: info.sourceRef, profileName: info.profile ?? 'worker',
    parentToolCallId: info.parentToolCallId, model: info.model,
    thinkingEffort: info.thinkingEffort, thinkingEffortExplicit: info.thinkingEffortExplicit,
    executorId: info.executorId, executorProtocol: info.executorProtocol,
    completion: mirrored.then(result => ({ result: result.summary, usage: result.usage })),
  }, info.description, controller), { taskId: info.taskId, detached: info.detached, lifetime: info.lifetime, timeoutMs: info.timeoutMs });
}

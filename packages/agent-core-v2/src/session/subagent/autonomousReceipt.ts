import { randomBytes } from 'node:crypto';
import { join } from 'pathe';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentUsageService } from '#/agent/usage/usage';
import { AgentTaskPersistence } from '#/agent/task/persist';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { COLLABORATION_LATEST_TASK_LABEL } from '#/session/agentCollaboration/registry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { mirrorAgentRun, SubagentStarted } from './mirrorAgentRun';
import { latestAssistantText } from './runAgentTurn';

export function observeAutonomousReceipts(
  child: IAgentScopeHandle,
  track: (delivery: Promise<void>) => void,
): IDisposable {
  const subscriptions = new DisposableStore();
  const parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  if (parentId === undefined) return subscriptions;
  const turns = new Map<number, number>();
  const events = child.accessor.get(IEventBus);
  subscriptions.add(events.subscribe(TurnStarted, (event) => {
    if (event.parentReceiptManaged !== true) turns.set(event.turnId, event.time);
  }));
  subscriptions.add(events.subscribe(TurnEnded, (event) => {
    const startedAt = turns.get(event.turnId);
    turns.delete(event.turnId);
    if (startedAt === undefined || event.reason !== 'completed') return;
    const summary = latestAssistantText(child.accessor.get(IAgentContextMemoryService).get()
      .filter((message) => message.source?.turnId === event.turnId));
    if (summary.trim().length === 0) return;
    const usage = child.accessor.get(IAgentUsageService).status().total;
    track(returnReceipt(child, parentId, startedAt, summary, usage));
  }));
  return subscriptions;
}

async function returnReceipt(
  child: IAgentScopeHandle,
  parentId: string,
  startedAt: number,
  summary: string,
  usage: ReturnType<IAgentUsageService['status']>['total'],
): Promise<void> {
  const metadata = child.accessor.get(ISessionMetadata);
  const meta = await metadata.read();
  const previous = meta.agents?.[child.id];
  const profile = child.accessor.get(IAgentProfileService).data();
  const profileName = profile.profileName ?? previous?.labels?.['profileName'] ?? 'subagent';
  const description = previous?.taskId === undefined
    ? `Continue ${profileName} agent`
    : `Continue ${profileName} agent after ${previous.taskId} (${previous.status ?? 'ended'})`;
  const parent = meta.archived ? undefined : child.accessor.get(IAgentLifecycleService).get(parentId);
  const tasks = parent?.accessor.get(IAgentTaskService);
  const taskId = tasks?.allocateTaskId?.('agent') ?? `agent-${randomBytes(4).toString('hex')}`;
  const requester = parent ?? child;
  await metadata.updateAgent(child.id, (current) => ({
    ...current,
    labels: { ...current.labels, [COLLABORATION_LATEST_TASK_LABEL]: taskId },
  }));
  await requester.accessor.get(IEventDispatcher).dispatch(new SubagentStarted({ subagentId: child.id, taskId }));
  await mirrorAgentRun(requester, {
    agentId: child.id,
    completion: Promise.resolve({ summary, usage }),
  }, {
    profileName,
    signal: new AbortController().signal,
    deferStarted: true,
    resolveTaskId: () => taskId,
  });
  const info = {
    kind: 'agent' as const, status: 'completed' as const,
    taskId, description, detached: true, startedAt, endedAt: Date.now(), ownerAgentId: parentId,
    goalId: previous?.taskId === undefined ? undefined : tasks?.getTask(previous.taskId)?.goalId,
    agentId: child.id, profile: profileName,
    model: profile.modelAlias,
    thinkingEffort: profile.effectiveThinkingLevel,
    executorId: profile.executorId,
    executorProtocol: profile.executorProtocol,
  };
  if (tasks !== undefined) {
    await tasks.recordCompletedTask(info, summary);
    return;
  }
  const session = child.accessor.get(ISessionContext);
  const persistence = new AgentTaskPersistence(
    join(session.sessionDir, 'agents', parentId), session.scope(`agents/${parentId}`),
    child.accessor.get(IAtomicDocumentStore), child.accessor.get(IFileSystemStorageService),
  );
  await persistence.commitTerminalTask(info, summary);
}

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { AgentTaskPersistence } from '#/agent/task/persist';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { COLLABORATION_LATEST_TASK_LABEL } from '#/session/agentCollaboration/registry';
import { acknowledgeResumeOutcome } from '#/session/dispatch/resume';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { SubagentCompleted, SubagentStarted } from './mirrorAgentRun';
import { ISessionSubagentService } from './subagent';
import { autonomousReceiptsKey, AutonomousReceiptDelivered, type AutonomousReceipt } from './autonomousReceiptOps';

export const AUTONOMOUS_RECEIPT_POLICY_LABEL = 'autonomousReceiptPolicy';

export interface ReceiptDelivery {
  readonly settled: Promise<void>;
  drain(): Promise<void>;
}

interface ReceiptDrain {
  requested: boolean;
}

export function observeAutonomousReceipts(child: IAgentScopeHandle, track: (delivery: ReceiptDelivery) => void, signal: AbortSignal): IDisposable {
  const subscriptions = new DisposableStore();
  const parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  if (parentId === undefined) return subscriptions;
  const states = child.accessor.get(IAgentStateService);
  const pending = new Set<number>();
  let tail = Promise.resolve();
  const recover = () => {
    for (const receipt of Object.values(states.get(autonomousReceiptsKey).pending)) {
      if (pending.has(receipt.turnId)) continue;
      pending.add(receipt.turnId);
      const drain = { requested: false };
      const settled = tail.then(() => returnReceipt(child, parentId, receipt, signal, drain));
      tail = settled.catch(() => {});
      track({ settled, drain: () => { drain.requested = true; return settled; } });
    }
  };
  subscriptions.add(child.accessor.get(IEventBus).subscribe(TurnEnded, recover));
  recover();
  return subscriptions;
}

async function returnReceipt(child: IAgentScopeHandle, parentId: string, receipt: AutonomousReceipt, signal: AbortSignal, drain: ReceiptDrain): Promise<void> {
  const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    for (;;) {
      signal.throwIfAborted();
      try { return await operation(); }
      catch (error) {
        child.accessor.get(ILogService).error('autonomous subagent receipt persistence failed; original receipt retained for recovery', { agentId: child.id, turnId: receipt.turnId, taskId, error });
        if (drain.requested) throw error;
        await delay([100, 500, 2000, 10000][attempt++] ?? 30_000, undefined, { signal, ref: false });
      }
    }
  };
  const receiptId = createHash('sha256').update(`${child.id}:${String(receipt.turnId)}`).digest('hex');
  const taskId = `agent-receipt-${receiptId.slice(0, 56)}-${receiptId.slice(56)}`;
  const metadata = child.accessor.get(ISessionMetadata);
  if (metadata.snapshot().agents?.[child.id]?.labels?.[AUTONOMOUS_RECEIPT_POLICY_LABEL] === 'local') {
    const delivered = new AutonomousReceiptDelivered({ turnId: receipt.turnId });
    await retry(() => child.accessor.get(IEventDispatcher).dispatchDurably(delivered));
    return;
  }
  const meta = await retry(() => metadata.read());
  const previous = meta.agents?.[child.id];
  const profileService = child.accessor.get(IAgentProfileService);
  const profile = profileService.data();
  const parentSteering = profileService.getParentSteering?.() ?? (typeof previous?.parentSteering === 'string' && previous.parentSteering.trim().length > 0 ? previous.parentSteering.trim() : undefined);
  const profileName = profile.profileName ?? previous?.labels?.['profileName'] ?? 'subagent';
  const description = previous?.taskId === undefined || previous.taskId === taskId
    ? `Continue ${profileName} agent`
    : `Continue ${profileName} agent after ${previous.taskId} (${previous.status ?? 'ended'})`;
  const parent = meta.archived ? undefined : child.accessor.get(IAgentLifecycleService).get(parentId);
  const tasks = parent?.accessor.get(IAgentTaskService);
  const requester = parent ?? child;
  const usage = child.accessor.get(IAgentUsageService).status().total;
  const contextTokens = child.accessor.get(IAgentTokenCountingService)?.statusSize();
  const toolCallCount = child.accessor.get(IAgentActivityView)?.telemetry?.().toolCallCount;
  await retry(() => metadata.updateAgent(child.id, (current) => acknowledgeResumeOutcome({
    ...current, status: 'completed', taskId, completedAt: receipt.endedAt, resultSummary: receipt.summary, usage,
    contextTokens: contextTokens ?? current.contextTokens,
    toolCallCount: toolCallCount ?? current.toolCallCount,
    error: undefined,
    parentSteering: parentSteering ?? null,
    labels: { ...current.labels, [COLLABORATION_LATEST_TASK_LABEL]: taskId },
  }, taskId, receipt.endedAt)));
  const dispatcher = requester.accessor.get(IEventDispatcher);
  const started = new SubagentStarted({ subagentId: child.id, taskId });
  await retry(() => dispatcher.dispatchDurably(started));
  const completed = new SubagentCompleted({ subagentId: child.id, taskId, resultSummary: receipt.summary, usage, contextTokens });
  await retry(() => dispatcher.dispatchDurably(completed));
  const info = {
    kind: 'agent' as const, status: 'completed' as const,
    taskId, description, detached: true, startedAt: receipt.startedAt, endedAt: receipt.endedAt, ownerAgentId: parentId,
    goalId: previous?.taskId === undefined ? undefined : tasks?.getTask(previous.taskId)?.goalId,
    agentId: child.id, profile: profileName,
    model: profile.modelAlias,
    thinkingEffort: profile.effectiveThinkingLevel,
    thinkingEffortExplicit: profile.thinkingEffortExplicit,
    parentSteering,
    executorId: profile.executorId,
    executorProtocol: profile.executorProtocol,
  };
  if (tasks !== undefined) {
    await retry(() => tasks.recordCompletedTask(info, receipt.summary));
  } else {
    const session = child.accessor.get(ISessionContext);
    const persistence = new AgentTaskPersistence(join(session.sessionDir, 'agents', parentId), session.scope(`agents/${parentId}`), child.accessor.get(IAtomicDocumentStore), child.accessor.get(IFileSystemStorageService));
    await retry(() => persistence.commitTerminalTask(info, receipt.summary));
  }
  const delivered = new AutonomousReceiptDelivered({ turnId: receipt.turnId });
  await retry(() => child.accessor.get(IEventDispatcher).dispatchDurably(delivered));
  requester.accessor.get(ISessionSubagentService)?.notifyAgentTaskStopped({ agentName: profileName, response: receipt.summary });
}

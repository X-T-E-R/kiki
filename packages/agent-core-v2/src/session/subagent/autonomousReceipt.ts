import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
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
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { COLLABORATION_LATEST_TASK_LABEL, COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import { acknowledgeResumeOutcome } from '#/session/dispatch/resume';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentBranchGuardService } from '#/features/btw/agentBranchGuardService';
import { BranchTurnMerged } from '#/features/btw/branchOps';
import { ISessionBranchService } from '#/features/btw/btw';
import { SubagentCompleted, SubagentFailed, SubagentStarted } from './mirrorAgentRun';
import { ISessionSubagentService } from './subagent';
import { autonomousReceiptsKey, AutonomousReceiptDelivered, type AutonomousReceipt } from './autonomousReceiptOps';

export const AUTONOMOUS_RECEIPT_POLICY_LABEL = 'autonomousReceiptPolicy';

export function isBranchReceiptOwner(meta: AgentMeta | undefined): boolean {
  return meta?.labels?.['branch'] === 'true' && meta.labels['branchInitiator'] === 'agent';
}

function optionalFromHandle<T>(handle: IAgentScopeHandle, id: ServiceIdentifier<T>): T | undefined {
  try {
    return handle.accessor.get(id);
  } catch {
    return undefined;
  }
}

export function hasReceiptWork(child: IAgentScopeHandle): boolean {
  const loop = optionalFromHandle(child, IAgentLoopService)?.status();
  const execution = optionalFromHandle(child, IAgentExecutionService)?.status().state;
  const prompts = optionalFromHandle(child, IAgentPromptService)?.list();
  return execution === 'starting' || execution === 'running' || execution === 'cancelling' ||
    loop?.state === 'running' || loop?.finalizing === true || loop?.hasPendingRequests === true ||
    (loop?.pendingTurnIds.length ?? 0) !== 0 || prompts?.active !== undefined || prompts?.launching !== undefined ||
    (prompts?.pending.length ?? 0) !== 0 || optionalFromHandle(child, IAgentTaskService)?.hasUnfinishedWork(false) === true;
}

export interface ReceiptObserver extends IDisposable {
  recheck(): void;
}

export interface ReceiptDelivery {
  readonly settled: Promise<void>;
  drain(): Promise<void>;
}

interface ReceiptDrain {
  requested: boolean;
}

export function observeAutonomousReceipts(
  child: IAgentScopeHandle,
  track: (delivery: ReceiptDelivery) => void,
  hasDescendantWork: () => boolean,
  invalidateAncestors: () => void,
  signal: AbortSignal,
): ReceiptObserver {
  const subscriptions = new DisposableStore();
  const parentId = child.accessor.get(IAgentScopeContext).parentAgentId;
  if (parentId === undefined) return { dispose: () => subscriptions.dispose(), recheck: () => {} };
  const states = child.accessor.get(IAgentStateService);
  const metadata = child.accessor.get(ISessionMetadata);
  const bus = child.accessor.get(IEventBus);
  const contains = (agentId: string): boolean => {
    const agents = metadata.snapshot().agents;
    let id: string | null | undefined = agentId;
    while (id !== null && id !== undefined) {
      if (id === child.id) return true;
      id = agents?.[id]?.parentAgentId;
    }
    return false;
  };
  const pending = new Set<number>();
  let tail = Promise.resolve();
  let scheduled = false;
  let disposed = false;
  let workVersion = 0;
  let mailbox: IAgentCollaborationMessageStore | undefined;
  let branches: ISessionBranchService | undefined;
  const recover = () => {
    workVersion++;
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      drainReady();
    });
  };
  const drainReady = () => {
    const state = states.get(autonomousReceiptsKey);
    const receipts = Object.values(state.pending);
    if (receipts.length === 0) return;
    const branch = isBranchReceiptOwner(metadata.snapshot().agents?.[child.id]);
    const last = receipts.at(-1)?.turnId;
    const busy = (branch || receipts.some((receipt) => receipt.userPrompt === true)) && (hasReceiptWork(child) || hasDescendantWork());
    for (const receipt of receipts) {
      if (pending.has(receipt.turnId)) continue;
      const superseded = branch && (receipt.turnId !== last || state.active !== undefined || receipt.turnId <= (state.mergedThrough ?? -1));
      if (busy && (branch || receipt.userPrompt === true) && !superseded) continue;
      pending.add(receipt.turnId);
      const drain = { requested: false };
      const version = workVersion;
      const checkBranchQuiet = branch && !superseded ? async () => {
        const session = child.accessor.get(ISessionContext);
        if (mailbox === undefined) {
          mailbox = child.accessor.get(IAgentCollaborationMessageStore);
          if (mailbox.onDidChangePending !== undefined) subscriptions.add(mailbox.onDidChangePending((event) => {
            if (event.sessionId === session.sessionId && contains(event.agentId)) workChanged();
          }));
        }
        if (branches === undefined) {
          branches = optionalFromHandle(child, ISessionBranchService);
          if (branches !== undefined) subscriptions.add(branches.onDidSettleFold((agentId) => { if (agentId === child.id) workChanged(); }));
        }
        if (branches?.isFolding(child.id) === true) return false;
        const queued = await mailbox.listPendingAgents(session.sessionId);
        return !queued.some(contains) && !hasReceiptWork(child) && !hasDescendantWork();
      } : undefined;
      const settled = tail.then(() => returnReceipt(child, parentId, receipt, signal, drain, branch, superseded, checkBranchQuiet));
      tail = settled.then(() => {
        pending.delete(receipt.turnId);
        if (!disposed && version !== workVersion && states.get(autonomousReceiptsKey).pending[String(receipt.turnId)] !== undefined) recover();
      }, () => {});
      track({ settled, drain: () => { drain.requested = true; return settled; } });
    }
  };
  const loop = optionalFromHandle(child, IAgentLoopService);
  const execution = optionalFromHandle(child, IAgentExecutionService);
  const tasks = optionalFromHandle(child, IAgentTaskService);
  const workChanged = () => { recover(); invalidateAncestors(); };
  subscriptions.add(bus.subscribe(TurnEnded, () => {
    drainReady();
    invalidateAncestors();
    void Promise.all([loop?.settled(), execution?.settled()]).then(workChanged, workChanged);
  }));
  subscriptions.add(bus.subscribe((event) => { if (event.type.startsWith('prompt.')) workChanged(); }));
  subscriptions.add(bus.subscribe(BranchTurnMerged, workChanged));
  const lifetime = optionalFromHandle(child, IInstantiationService);
  if (lifetime?.onWillDispose !== undefined) subscriptions.add(lifetime.onWillDispose(() => { disposed = true; }));
  if (loop?.onDidChangeWork !== undefined) subscriptions.add(loop.onDidChangeWork(workChanged));
  if (execution?.onDidChangeStatus !== undefined) subscriptions.add(execution.onDidChangeStatus(workChanged));
  if (tasks?.onDidChangeWork !== undefined) subscriptions.add(tasks.onDidChangeWork(workChanged));
  subscriptions.add({ dispose: () => { disposed = true; } });
  drainReady();
  return { dispose: () => subscriptions.dispose(), recheck: recover };
}

async function returnReceipt(child: IAgentScopeHandle, parentId: string, receipt: AutonomousReceipt, signal: AbortSignal, drain: ReceiptDrain, branch: boolean, superseded: boolean, checkBranchQuiet: (() => Promise<boolean>) | undefined): Promise<void> {
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
  if (checkBranchQuiet !== undefined && !await retry(checkBranchQuiet)) return;
  await optionalFromHandle(child, IAgentBranchGuardService)?.revived();
  signal.throwIfAborted();
  const currentAgent = metadata.peekAgent !== undefined ? metadata.peekAgent(child.id) : metadata.snapshot().agents?.[child.id];
  const merged = branch && receipt.turnId <= (child.accessor.get(IAgentStateService).get(autonomousReceiptsKey).mergedThrough ?? -1);
  const sealed = currentAgent?.labels?.['branchSealed'] === 'true';
  if (currentAgent?.labels?.['branch'] === 'true') await retry(() => metadata.updateAgent(child.id, (current) => ({
    ...current,
    branchTurn: { startedAt: receipt.startedAt, endedAt: receipt.endedAt, outcome: receipt.outcome ?? 'completed' },
  })));
  if (superseded || merged || sealed || (!branch && (currentAgent?.labels?.[AUTONOMOUS_RECEIPT_POLICY_LABEL] === 'local' ||
    (receipt.userPrompt !== true && (receipt.outcome !== undefined || receipt.summary.trim() === ''))))) {
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
  const lostChildTaskCount = branch ? countLostSubtreeTasks(child, meta.agents) : 0;
  const description = branch
    ? lostChildTaskCount > 0
      ? `Branch ${child.id} interrupted before Merge (${lostChildTaskCount} child ${lostChildTaskCount === 1 ? 'task' : 'tasks'} lost)`
      : `Branch ${child.id} ${receipt.outcome === undefined ? 'went idle without Merge' : `${receipt.outcome} before Merge`}`
    : previous?.taskId === undefined || previous.taskId === taskId
    ? `Continue ${profileName} agent`
    : `Continue ${profileName} agent after ${previous.taskId} (${previous.status ?? 'ended'})`;
  const lifecycle = child.accessor.get(IAgentLifecycleService);
  let parent = meta.archived ? undefined : lifecycle.get(parentId);
  const parentMeta = meta.agents?.[parentId];
  if (parent === undefined && !meta.archived && receipt.userPrompt === true && parentMeta !== undefined && parentMeta.labels?.['branchSealed'] !== 'true') {
    const delegator = parentMeta.delegator ?? (parentMeta.parentAgentId === null || parentMeta.parentAgentId === undefined ? undefined : { kind: 'agent' as const, agentId: parentMeta.parentAgentId });
    parent = await retry(() => lifecycle.create({ agentId: parentId, delegator }));
  }
  const tasks = parent?.accessor.get(IAgentTaskService);
  const requester = parent ?? child;
  const usage = child.accessor.get(IAgentUsageService).status().total;
  const contextTokens = optionalFromHandle(child, IAgentTokenCountingService)?.statusSize();
  const toolCallCount = optionalFromHandle(child, IAgentActivityView)?.telemetry?.().toolCallCount;
  const result = receipt.error ?? (receipt.summary.trim() === '' ? 'No final reply was recorded.' : receipt.summary);
  const failure = receipt.outcome === 'cancelled' ? receipt.error ?? 'terminated' : receipt.outcome === 'failed' ? result : undefined;
  if (!branch) await retry(() => metadata.updateAgent(child.id, (current) => acknowledgeResumeOutcome({
    ...current, status: receipt.outcome ?? 'completed', taskId, completedAt: receipt.endedAt,
    resultSummary: failure === undefined ? result : undefined, usage,
    contextTokens: contextTokens ?? current.contextTokens,
    toolCallCount: toolCallCount ?? current.toolCallCount,
    error: failure,
    parentSteering: parentSteering ?? null,
    labels: { ...current.labels, [COLLABORATION_LATEST_TASK_LABEL]: taskId },
  }, taskId, receipt.endedAt)));
  const dispatcher = requester.accessor.get(IEventDispatcher);
  const started = new SubagentStarted({ subagentId: child.id, taskId });
  if (!branch) await retry(() => dispatcher.dispatchDurably(started));
  const finished = failure === undefined
    ? new SubagentCompleted({ subagentId: child.id, taskId, resultSummary: result, usage, contextTokens })
    : new SubagentFailed({ subagentId: child.id, taskId, error: failure });
  if (!branch) await retry(() => dispatcher.dispatchDurably(finished));
  const output = branch
    ? `${description}.\n${result}\nUse HistoryRead({ agent_id: "${child.id}", turn: ${receipt.turnId} }) to inspect this turn, or AgentSend({ target: "${child.id}", message }) to continue.`
    : result;
  const info = {
    kind: 'agent' as const,
    status: receipt.outcome === 'failed'
      ? 'failed' as const
      : (receipt.outcome === 'cancelled' || (branch && lostChildTaskCount > 0))
        ? 'killed' as const
        : 'completed' as const,
    stopReason: receipt.error ?? (branch && lostChildTaskCount > 0 ? `${lostChildTaskCount} child ${lostChildTaskCount === 1 ? 'task' : 'tasks'} lost` : undefined),
    taskId, description, detached: true, startedAt: receipt.startedAt, endedAt: receipt.endedAt, ownerAgentId: parentId,
    goalId: previous?.taskId === undefined ? undefined : tasks?.getTask(previous.taskId)?.goalId,
    agentId: child.id, profile: profileName,
    collaborationTaskName: previous?.labels?.[COLLABORATION_TASK_NAME_LABEL],
    model: profile.modelAlias,
    thinkingEffort: profile.effectiveThinkingLevel,
    thinkingEffortExplicit: profile.thinkingEffortExplicit,
    parentSteering,
    executorId: profile.executorId,
    executorProtocol: profile.executorProtocol,
  };
  if (checkBranchQuiet !== undefined && !await retry(checkBranchQuiet)) return;
  if (branch && receipt.turnId <= (child.accessor.get(IAgentStateService).get(autonomousReceiptsKey).mergedThrough ?? -1)) {
    await retry(() => child.accessor.get(IEventDispatcher).dispatchDurably(new AutonomousReceiptDelivered({ turnId: receipt.turnId })));
    return;
  }
  if (tasks !== undefined) {
    await retry(() => tasks.recordCompletedTask(info, output));
  } else {
    const session = child.accessor.get(ISessionContext);
    const persistence = new AgentTaskPersistence(join(session.sessionDir, 'agents', parentId), session.scope(`agents/${parentId}`), child.accessor.get(IAtomicDocumentStore), child.accessor.get(IFileSystemStorageService));
    await retry(() => persistence.commitTerminalTask(info, output));
  }
  const delivered = new AutonomousReceiptDelivered({ turnId: receipt.turnId });
  await retry(() => child.accessor.get(IEventDispatcher).dispatchDurably(delivered));
  optionalFromHandle(requester, ISessionSubagentService)?.notifyAgentTaskStopped({
    agentId: child.id,
    autonomousTurnId: receipt.turnId,
    agentName: profileName,
    response: result,
  });
}

function countLostSubtreeTasks(
  root: IAgentScopeHandle,
  agents: Readonly<Record<string, AgentMeta>> | undefined,
): number {
  const lifecycle = root.accessor.get(IAgentLifecycleService);
  const subtreeIds = new Set<string>([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, meta] of Object.entries(agents ?? {})) {
      if (subtreeIds.has(id)) continue;
      if (meta.parentAgentId !== null && meta.parentAgentId !== undefined && subtreeIds.has(meta.parentAgentId)) {
        subtreeIds.add(id);
        grew = true;
      }
    }
    for (const handle of lifecycle.list()) {
      if (subtreeIds.has(handle.id)) continue;
      const parentId = optionalFromHandle(handle, IAgentScopeContext)?.parentAgentId;
      if (parentId !== undefined && subtreeIds.has(parentId)) {
        subtreeIds.add(handle.id);
        grew = true;
      }
    }
  }
  const seenTaskIds = new Set<string>();
  let lost = 0;
  for (const agentId of subtreeIds) {
    const handle = lifecycle.get(agentId);
    if (handle === undefined) continue;
    const taskService = optionalFromHandle(handle, IAgentTaskService);
    if (taskService === undefined) continue;
    for (const task of taskService.list(false)) {
      if (task.status !== 'lost') continue;
      if (seenTaskIds.has(task.taskId)) continue;
      seenTaskIds.add(task.taskId);
      lost += 1;
    }
  }
  return lost;
}

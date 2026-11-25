import { randomUUID } from 'node:crypto';

import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, hasUnfinishedTurn, turnKey } from '#/agent/loop/turnOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskRestorationSettled } from '#/agent/task/taskOps';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionMetadata,
  type SessionInterruptedTarget,
  type SessionInterruptedWork,
} from '#/session/sessionMetadata/sessionMetadata';

import { ISessionActivityView, type SessionTurnOutcome } from './sessionActivity';
import { ISessionOutcomeMirror } from './sessionOutcomeMirror';

let runtimeBootId: string = randomUUID();

/** Returns the current host-process boot identifier used to detect cold restart interruptions without scanning wires. */
export function currentRuntimeBootId(): string {
  return runtimeBootId;
}

/** Replaces the process boot identifier in tests that simulate a host restart within one process. */
export function setRuntimeBootIdForTesting(nextId: string): string {
  const previous = runtimeBootId;
  runtimeBootId = nextId;
  return previous;
}

export class SessionOutcomeMirror extends Disposable implements ISessionOutcomeMirror {
  declare readonly _serviceBrand: undefined;

  private lastPersisted: SessionTurnOutcome | undefined;
  private lastPersistedTurnId: number | undefined;
  private lastBootId: string | undefined;
  private lastRunAgentIdsKey: string | undefined;
  private adopted = false;
  private turnStartedHere = false;
  private mainSubscription: DisposableStore | undefined;
  private readonly childSubscriptions = new Map<string, DisposableStore>();
  private readonly activeRunAgents = new Set<string>();
  private activitySubscription: DisposableStore | undefined;
  private readonly metadataReady: Promise<void>;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ref(ISessionActivityView) private readonly activityRef?: LiveRef<ISessionActivityView>,
  ) {
    super();
    this.metadataReady = this.metadata
      .read()
      .then((meta) => {
        if (!this.adopted) {
          this.lastPersisted = meta.lastTurnReason;
          this.lastBootId = meta.activeRunBootId;
          this.lastRunAgentIdsKey = meta.activeRunAgentIds?.join('\u0000');
        }
      })
      .catch(onUnexpectedError);
    if (this.activityRef !== undefined) {
      this.attachActivity(this.activityRef.current);
      this._register(this.activityRef.onDidChange(() => {
        this.attachActivity(this.activityRef?.current);
      }));
    }
    for (const handle of this.agents.list()) {
      if (handle.id === MAIN_AGENT_ID) this.attachMain();
      else this.attachChild(handle);
    }
    this._register(this.agents.onDidCreate((handle) => {
      if (handle.id === MAIN_AGENT_ID) this.attachMain();
      else {
        this.attachChild(handle);
        void this.reconcileChildInterruption();
      }
    }));
    this._register(this.agents.onDidDispose((agentId) => {
      this.activeRunAgents.delete(agentId);
      if (agentId === MAIN_AGENT_ID) {
        const result = this.mainSubscription?.dispose();
        if (isPromiseLike(result)) result.catch(onUnexpectedError);
        this.mainSubscription = undefined;
        return;
      }
      const childSub = this.childSubscriptions.get(agentId);
      if (childSub !== undefined) {
        this.childSubscriptions.delete(agentId);
        const result = childSub.dispose();
        if (isPromiseLike(result)) result.catch(onUnexpectedError);
      }
    }));
    this._register({
      dispose: async () => {
        await this.activitySubscription?.dispose();
        this.activitySubscription = undefined;
        await this.mainSubscription?.dispose();
        this.mainSubscription = undefined;
        for (const sub of this.childSubscriptions.values()) {
          await sub.dispose();
        }
        this.childSubscriptions.clear();
        this.activeRunAgents.clear();
      },
    });
  }

  private attachActivity(activity: ISessionActivityView | undefined): void {
    const previous = this.activitySubscription;
    this.activitySubscription = undefined;
    if (previous !== undefined) {
      const result = previous.dispose();
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
    }
    if (activity === undefined) return;
    const sub = new DisposableStore();
    this.activitySubscription = sub;
    sub.add(activity.onDidChange((event) => {
      this.syncActivityBootState(event.state.busy);
    }));
  }

  private attachMain(): void {
    if (this.mainSubscription !== undefined) return;
    const handle = this.agents.get(MAIN_AGENT_ID);
    const bus = handle?.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    const subscription = new DisposableStore();
    this.mainSubscription = subscription;
    const dispatcher = handle?.accessor.get(IEventDispatcher) as IEventDispatcher | undefined;
    const agentStates = handle?.accessor.get(IAgentStateService) as IAgentStateService | undefined;
    if (dispatcher !== undefined && agentStates !== undefined) {
      subscription.add(
        dispatcher.hooks.onDidRestore.register('session-outcome-mirror', async (_ctx, next) => {
          await next();
          await this.reconcileAfterRestore(agentStates);
        }),
      );
    }
    subscription.add(
      bus.subscribe(TurnEnded, (event) => {
        this.activeRunAgents.delete(MAIN_AGENT_ID);
        if (this.activityRef?.current !== undefined && this.lastBootId === currentRuntimeBootId()) {
          this.syncActiveRunAgents();
        }
        if (event.reason === 'completed') {
          this.write('completed', { turnId: event.turnId });
          return;
        }
        if (event.reason === 'failed' || event.reason === 'blocked') {
          this.write('failed', { turnId: event.turnId });
          return;
        }
        if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
          this.write('cancelled', { turnId: event.turnId });
        }
      }),
    );
    subscription.add(
      bus.subscribe(TaskRestorationSettled, () => {
        if (this.turnStartedHere) return;
        void this.reconcileInterruptedSnapshot(false);
      }),
    );
    subscription.add(
      bus.subscribe(TurnStarted, () => {
        this.turnStartedHere = true;
        this.activeRunAgents.add(MAIN_AGENT_ID);
        this.write(undefined);
        if (this.activityRef?.current !== undefined) this.markRunningWork(MAIN_AGENT_ID);
      }),
    );
    subscription.add(
      bus.subscribe(ContextUndone, (event) => {
        if (
          event.fromTurnId !== undefined &&
          this.lastPersistedTurnId !== undefined &&
          this.lastPersistedTurnId < event.fromTurnId
        ) {
          return;
        }
        this.write(undefined);
      }),
    );
    subscription.add(
      bus.subscribe(AgentActivityUpdated, (event) => {
        if (this.turnStartedHere) return;
        if (this.lastPersisted !== undefined) return;
        const reason = event.lastTurn?.reason;
        if (reason === 'completed' || reason === 'cancelled') {
          this.write(reason, { touchUpdatedAt: false, turnId: event.lastTurn?.turnId });
        } else if (reason === 'failed' || reason === 'blocked') {
          this.write('failed', { touchUpdatedAt: false, turnId: event.lastTurn?.turnId });
        }
      }),
    );
  }

  private attachChild(handle: IAgentScopeHandle): void {
    if (this.childSubscriptions.has(handle.id)) return;
    let bus: IEventBus | undefined;
    let dispatcher: IEventDispatcher | undefined;
    try {
      bus = handle.accessor.get(IEventBus);
    } catch {
      bus = undefined;
    }
    try {
      dispatcher = handle.accessor.get(IEventDispatcher);
    } catch {
      dispatcher = undefined;
    }
    if (bus === undefined && dispatcher === undefined) return;
    const subscription = new DisposableStore();
    this.childSubscriptions.set(handle.id, subscription);
    if (dispatcher !== undefined) {
      subscription.add(
        dispatcher.hooks.onDidRestore.register('session-outcome-mirror-child', async (_ctx, next) => {
          await next();
          await this.reconcileChildInterruption();
        }),
      );
    }
    if (bus !== undefined) {
      subscription.add(
        bus.subscribe(TurnStarted, () => {
          this.activeRunAgents.add(handle.id);
          if (this.activityRef?.current !== undefined) this.markRunningWork(handle.id);
        }),
      );
      subscription.add(
        bus.subscribe(TurnEnded, () => {
          this.activeRunAgents.delete(handle.id);
          if (this.activityRef?.current !== undefined && this.lastBootId === currentRuntimeBootId()) {
            this.syncActiveRunAgents();
          }
        }),
      );
      subscription.add(
        bus.subscribe(TaskRestorationSettled, () => {
          if (this.turnStartedHere) return;
          void this.reconcileChildInterruption();
        }),
      );
    }
  }

  private syncActivityBootState(busy: boolean): void {
    if (busy) {
      this.markRunningWork();
      return;
    }
    if (this.lastBootId === currentRuntimeBootId()) {
      this.setActiveBootId(undefined);
    }
  }

  private currentActiveRunAgentIds(): readonly string[] | undefined {
    if (this.activeRunAgents.size === 0) return undefined;
    return [...this.activeRunAgents].sort();
  }

  private syncActiveRunAgents(): void {
    const activeIds = this.currentActiveRunAgentIds();
    const nextKey = activeIds?.join('\u0000');
    if (this.lastRunAgentIdsKey === nextKey) return;
    this.lastRunAgentIdsKey = nextKey;
    void this.metadata.update({ activeRunAgentIds: activeIds }, { touchUpdatedAt: false }).catch(() => {});
  }

  private collectCurrentLostTaskIds(existing: readonly string[] | undefined): readonly string[] | undefined {
    const merged = new Set<string>(existing ?? []);
    for (const handle of this.agents.list()) {
      let taskService: IAgentTaskService | undefined;
      try {
        taskService = handle.accessor.get(IAgentTaskService);
      } catch {
        taskService = undefined;
      }
      if (taskService === undefined) continue;
      for (const task of taskService.list(false)) {
        if (task.status === 'lost') merged.add(task.taskId);
      }
    }
    if (merged.size === 0) return existing;
    const list = [...merged];
    return list.length > 256 ? list.slice(-256) : list;
  }

  private markRunningWork(startedAgentId?: string): void {
    const boot = currentRuntimeBootId();
    const activeIds = this.currentActiveRunAgentIds();
    const nextKey = activeIds?.join('\u0000');
    const snapshot = typeof this.metadata.snapshot === 'function' ? this.metadata.snapshot() : undefined;
    const currentInterrupted = snapshot?.interruptedWork;
    const isChildStart = startedAgentId !== undefined && startedAgentId !== MAIN_AGENT_ID;
    let nextInterrupted = currentInterrupted;
    let clearedInterrupted = false;
    if (currentInterrupted !== undefined) {
      if (isChildStart) {
        const hadTarget = currentInterrupted.targets?.some((entry) => entry.agentId === startedAgentId) === true;
        if (hadTarget) {
          const remaining = currentInterrupted.targets?.filter((entry) => entry.agentId !== startedAgentId) ?? [];
          const removedBranch = currentInterrupted.targets?.some((entry) => entry.agentId === startedAgentId && entry.kind === 'branch') === true;
          const nextBranches = removedBranch
            ? Math.max(0, (currentInterrupted.interruptedBranches ?? 0) - 1)
            : (currentInterrupted.interruptedBranches ?? 0);
          if (
            currentInterrupted.mainInterrupted !== true &&
            (currentInterrupted.lostTasks ?? 0) === 0 &&
            nextBranches === 0 &&
            remaining.length === 0
          ) {
            nextInterrupted = undefined;
            clearedInterrupted = true;
          } else {
            nextInterrupted = {
              ...currentInterrupted,
              interruptedBranches: nextBranches > 0 ? nextBranches : undefined,
              targets: remaining.length > 0 ? remaining : undefined,
            };
          }
        }
      } else {
        nextInterrupted = undefined;
        clearedInterrupted = true;
      }
    }
    const interruptedChanged = nextInterrupted !== currentInterrupted;
    if (this.lastBootId === boot && this.lastRunAgentIdsKey === nextKey && !interruptedChanged) return;
    this.lastBootId = boot;
    this.lastRunAgentIdsKey = nextKey;
    const patch = interruptedChanged
      ? {
          activeRunBootId: boot,
          activeRunAgentIds: activeIds,
          interruptedWork: nextInterrupted,
          ...(clearedInterrupted
            ? {
                lastRecoveredAt: Date.now(),
                recoveredLostTaskIds: this.collectCurrentLostTaskIds(snapshot?.recoveredLostTaskIds),
              }
            : {}),
        }
      : { activeRunBootId: boot, activeRunAgentIds: activeIds };
    void this.metadata.update(patch, { touchUpdatedAt: false }).catch(() => {});
  }

  private setActiveBootId(bootId: string | undefined): void {
    const activeIds = bootId === undefined ? undefined : this.currentActiveRunAgentIds();
    const nextKey = activeIds?.join('\u0000');
    if (this.lastBootId === bootId && this.lastRunAgentIdsKey === nextKey) return;
    this.lastBootId = bootId;
    this.lastRunAgentIdsKey = nextKey;
    void this.metadata
      .update({ activeRunBootId: bootId, activeRunAgentIds: activeIds }, { touchUpdatedAt: false })
      .catch(() => {});
  }

  private async reconcileAfterRestore(agentStates: IAgentStateService): Promise<void> {
    await this.metadataReady;
    const turnState = agentStates.has(turnKey) ? agentStates.get(turnKey) : undefined;
    const lastEnded = turnState?.lastEnded;
    if (!this.turnStartedHere && this.lastPersisted !== undefined) {
      if (lastEnded === undefined) {
        this.write(undefined, { touchUpdatedAt: false });
      } else if (this.lastPersistedTurnId === undefined) {
        this.lastPersistedTurnId = lastEnded.turnId;
      }
    }
    if (this.turnStartedHere) return;
    await this.reconcileInterruptedSnapshot(hasUnfinishedTurn(turnState));
  }

  private async reconcileChildInterruption(): Promise<void> {
    await this.metadataReady;
    if (this.turnStartedHere) return;
    await this.reconcileInterruptedSnapshot(false);
  }

  private async reconcileInterruptedSnapshot(mainRecovered: boolean): Promise<void> {
    const meta = await this.metadata.read().catch(() => undefined);
    if (meta === undefined) return;
    const staleBoot = meta.activeRunBootId !== undefined && meta.activeRunBootId !== currentRuntimeBootId();
    const recoveryWatermark = meta.lastRecoveredAt ?? 0;
    const acknowledgedLostTaskIds = new Set(meta.recoveredLostTaskIds ?? []);
    const mainHandle = this.agents.get(MAIN_AGENT_ID);
    const mainStates = mainHandle?.accessor.get(IAgentStateService) as IAgentStateService | undefined;
    const mainTurnState = mainStates?.has(turnKey) ? mainStates.get(turnKey) : undefined;
    const mainInterrupted =
      mainRecovered ||
      hasUnfinishedTurn(mainTurnState) ||
      meta.interruptedWork?.mainInterrupted === true;

    const targets: SessionInterruptedTarget[] = [];
    const seenTargets = new Set<string>();
    const addTarget = (target: SessionInterruptedTarget): void => {
      if (seenTargets.has(target.agentId)) return;
      seenTargets.add(target.agentId);
      targets.push(target);
    };
    if (mainInterrupted) {
      addTarget({ agentId: MAIN_AGENT_ID, kind: 'main', reason: 'recovery' });
    }

    let lostTasks = 0;
    const seenLostTasks = new Set<string>();
    const lostByOwner = new Map<string, number>();
    for (const handle of this.agents.list()) {
      let taskService: IAgentTaskService | undefined;
      try {
        taskService = handle.accessor.get(IAgentTaskService);
      } catch {
        taskService = undefined;
      }
      if (taskService === undefined) continue;
      for (const task of taskService.list(false)) {
        if (task.status !== 'lost' || seenLostTasks.has(task.taskId)) continue;
        if (acknowledgedLostTaskIds.has(task.taskId)) continue;
        if ((task.endedAt ?? task.startedAt) < recoveryWatermark) continue;
        seenLostTasks.add(task.taskId);
        lostTasks += 1;
        lostByOwner.set(handle.id, (lostByOwner.get(handle.id) ?? 0) + 1);
        if (task.kind === 'agent' && task.agentId !== undefined && task.agentId !== MAIN_AGENT_ID) {
          const childMeta = meta.agents?.[task.agentId];
          const isBranch = childMeta?.labels?.['branch'] === 'true';
          addTarget({
            agentId: task.agentId,
            label: childMeta?.userLabel ?? childMeta?.displayName ?? task.description,
            kind: isBranch ? 'branch' : 'subagent',
            reason: isBranch ? 'branch_interrupted' : 'lost_task',
          });
        }
      }
    }

    const staleRunAgents = new Set(staleBoot ? (meta.activeRunAgentIds ?? []) : []);
    let interruptedBranches = 0;
    for (const [agentId, agentMeta] of Object.entries(meta.agents ?? {})) {
      if (agentId === MAIN_AGENT_ID) continue;
      if (agentMeta.labels?.['branch'] !== 'true' || agentMeta.labels?.['branchSealed'] === 'true') continue;
      const branchLost = lostByOwner.get(agentId) ?? 0;
      const branchCancelled =
        agentMeta.branchTurn?.outcome === 'cancelled' && agentMeta.branchTurn.endedAt >= recoveryWatermark;
      const branchHandle = this.agents.get(agentId);
      let branchUnfinished = false;
      if (branchHandle !== undefined) {
        try {
          const branchStates = branchHandle.accessor.get(IAgentStateService);
          branchUnfinished = hasUnfinishedTurn(branchStates.has(turnKey) ? branchStates.get(turnKey) : undefined);
        } catch {
          branchUnfinished = false;
        }
      }
      const branchWasRunningAtCrash = staleRunAgents.has(agentId);
      if (branchLost > 0 || branchCancelled || branchUnfinished || branchWasRunningAtCrash) {
        interruptedBranches += 1;
        addTarget({
          agentId,
          label: agentMeta.userLabel ?? agentMeta.displayName,
          kind: 'branch',
          reason: 'branch_interrupted',
          lostTasks: branchLost > 0 ? branchLost : undefined,
        });
      }
    }

    const scannedLiveAgents = this.agents.list().length > 0;
    const effectiveLostTasks = scannedLiveAgents ? lostTasks : (meta.interruptedWork?.lostTasks ?? 0);
    const effectiveBranches = scannedLiveAgents ? interruptedBranches : (meta.interruptedWork?.interruptedBranches ?? 0);
    const hasInterrupted =
      mainInterrupted || effectiveLostTasks > 0 || effectiveBranches > 0 || targets.length > 0;
    if (!hasInterrupted) {
      if (staleBoot || meta.interruptedWork !== undefined) {
        this.lastBootId = undefined;
        this.lastRunAgentIdsKey = undefined;
        await this.metadata
          .update(
            { interruptedWork: undefined, activeRunBootId: undefined, activeRunAgentIds: undefined },
            { touchUpdatedAt: false },
          )
          .catch(() => {});
      }
      return;
    }

    const nextWork: SessionInterruptedWork = {
      interruptedAt: meta.interruptedWork?.interruptedAt ?? Date.now(),
      mainInterrupted: mainInterrupted ? true : undefined,
      lostTasks: effectiveLostTasks > 0 ? effectiveLostTasks : undefined,
      interruptedBranches: effectiveBranches > 0 ? effectiveBranches : undefined,
      targets: targets.length > 0 ? targets : meta.interruptedWork?.targets,
    };
    const unchanged =
      !staleBoot &&
      JSON.stringify(meta.interruptedWork) === JSON.stringify(nextWork);
    if (unchanged) return;
    if (staleBoot) {
      this.lastBootId = undefined;
      this.lastRunAgentIdsKey = undefined;
    }
    await this.metadata
      .update(
        staleBoot
          ? { interruptedWork: nextWork, activeRunBootId: undefined, activeRunAgentIds: undefined }
          : { interruptedWork: nextWork },
        { touchUpdatedAt: false },
      )
      .catch(() => {});
  }

  private write(
    outcome: SessionTurnOutcome | undefined,
    opts?: { readonly touchUpdatedAt?: boolean; readonly turnId?: number },
  ): void {
    if (outcome === this.lastPersisted) {
      if (opts?.turnId !== undefined) this.lastPersistedTurnId = opts.turnId;
      return;
    }
    this.adopted = true;
    const previous = this.lastPersisted;
    const previousTurnId = this.lastPersistedTurnId;
    this.lastPersisted = outcome;
    this.lastPersistedTurnId =
      outcome === undefined ? undefined : (opts?.turnId ?? this.lastPersistedTurnId);
    void this.metadata
      .update({ lastTurnReason: outcome }, { touchUpdatedAt: opts?.touchUpdatedAt })
      .catch(() => {
        if (this.lastPersisted === outcome) {
          this.lastPersisted = previous;
          this.lastPersistedTurnId = previousTurnId;
        }
      });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeMirror,
  SessionOutcomeMirror,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);

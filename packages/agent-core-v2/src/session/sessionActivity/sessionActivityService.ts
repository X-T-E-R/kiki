import { Disposable, DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { IInstantiationService } from '#/_base/di/instantiation';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  registerScopedService,
  type IAgentScopeHandle,
} from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { promptLaunchingKey } from '#/agent/prompt/promptService';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentStateService } from '#/agent/state/agentState';
import { goalKey } from '#/agent/goal/goalOps';
import {
  AgentActivityUpdated,
  IAgentActivityView,
  type AgentActivityState,
} from '#/agent/activityView/activityView';
import type { TurnEndReason } from '#/agent/loop/turnEvents';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService, type Interaction } from '#/session/interaction/interaction';
import { ISessionStateService } from '#/session/state/sessionState';

import {
  ISessionActivityView,
  type SessionActivityCause,
  type SessionActivityChangedEvent,
  type SessionActivityState,
  type SessionPendingInteraction,
  type SessionTurnOutcome,
} from './sessionActivity';

interface AgentWorkFold {
  turnActive: boolean;
  background: number;
  compacting: boolean;
  lastTurnReason?: SessionTurnOutcome;
}

interface AgentWorkFacts {
  busy: boolean;
  executing: boolean;
}

export const sessionActivityFoldsKey = defineState<Map<string, AgentWorkFold>>(
  'sessionActivity.folds',
  () => new Map(),
);
export const sessionActivityCurrentKey = defineState<SessionActivityState>('sessionActivity.current', () => ({
  busy: false,
  executing: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
  lastTurnReason: undefined,
}));

export class SessionActivityView extends Disposable implements ISessionActivityView {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<SessionActivityChangedEvent>());
  readonly onDidChange: Event<SessionActivityChangedEvent> = this._onDidChange.event;

  private readonly agentSubscriptions = new Map<string, IDisposable>();
  private readonly workFacts = new Map<string, AgentWorkFacts>();
  private readonly dirtyAgents = new Map<string, IAgentScopeHandle>();
  private busyAgents = 0;
  private executingAgents = 0;
  private recomputeQueued = false;
  private disposed = false;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionInteractionService private readonly interactions: ISessionInteractionService,
  ) {
    super();
    this.states.contributeState(sessionActivityFoldsKey);
    this.states.contributeState(sessionActivityCurrentKey);
    for (const handle of this.agents.list()) this.attachAgent(handle);
    this.refreshDirtyAgents();
    this.current = this.aggregate();
    this._register(
      this.agents.onDidCreate((handle) => {
        this.attachAgent(handle);
        this.recompute('agent_lifecycle');
      }),
    );
    this._register(this.agents.onDidDispose((agentId) => this.detachAgent(agentId)));
    this._register(this.interactions.onDidChangePending(() => this.recompute('interaction')));
    this._register(
      toDisposable(async () => {
        this.disposed = true;
        this.dirtyAgents.clear();
        for (const subscription of this.agentSubscriptions.values()) await subscription.dispose();
        this.agentSubscriptions.clear();
        this.workFacts.clear();
      }),
    );
  }

  private get folds(): Map<string, AgentWorkFold> {
    return this.states.get(sessionActivityFoldsKey);
  }

  private get current(): SessionActivityState {
    return this.states.get(sessionActivityCurrentKey);
  }

  private set current(value: SessionActivityState) {
    this.states.set(sessionActivityCurrentKey, value);
  }

  state(): SessionActivityState {
    if (this.dirtyAgents.size > 0) this.recompute('background');
    return this.current;
  }

  private detachAgent(agentId: string): void {
    const result = this.agentSubscriptions.get(agentId)?.dispose();
    if (isPromiseLike(result)) result.catch(onUnexpectedError);
    this.agentSubscriptions.delete(agentId);
    this.dirtyAgents.delete(agentId);
    this.replaceWorkFacts(agentId, undefined);
    if (this.folds.delete(agentId)) this.recompute('agent_lifecycle');
  }

  private attachAgent(handle: IAgentScopeHandle): void {
    if (this.agentSubscriptions.has(handle.id)) return;
    const view = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
    this.folds.set(handle.id, foldOf(handle.id, view?.state()));
    const subscriptions = new DisposableStore();
    this.agentSubscriptions.set(handle.id, subscriptions);
    this.dirtyAgents.set(handle.id, handle);
    const invalidate = (): void => {
      if (this.agentSubscriptions.get(handle.id) !== subscriptions || this.disposed) return;
      this.dirtyAgents.set(handle.id, handle);
      this.queueRecompute();
    };
    const lifetime = handle.accessor.get(IInstantiationService);
    if (lifetime?.onWillDispose !== undefined) subscriptions.add(lifetime.onWillDispose(() => this.detachAgent(handle.id)));
    const execution = handle.accessor.get(IAgentExecutionService);
    if (execution?.onDidChangeStatus !== undefined) subscriptions.add(execution.onDidChangeStatus(invalidate));
    const loop = handle.accessor.get(IAgentLoopService);
    if (loop?.onDidChangePersistence !== undefined) subscriptions.add(loop.onDidChangePersistence(invalidate));
    if (loop?.onDidChangeWork !== undefined) subscriptions.add(loop.onDidChangeWork(invalidate));
    const tasks = handle.accessor.get(IAgentTaskService);
    if (tasks?.onDidChangeWork !== undefined) subscriptions.add(tasks.onDidChangeWork(invalidate));
    const state = handle.accessor.get(IAgentStateService);
    if (state?.onDidChange !== undefined) {
      subscriptions.add(state.onDidChange(goalKey)(invalidate));
      subscriptions.add(state.onDidChange(promptLaunchingKey)(invalidate));
    }
    const bus = handle.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    subscriptions.add(
      bus.subscribe((event) => {
        if (this.agentSubscriptions.get(handle.id) !== subscriptions || this.disposed) return;
        if (event.type === AgentActivityUpdated.type) this.onActivity(handle, event as AgentActivityUpdated);
        if (!/^(turn\.|task\.|prompt\.|goal\.|compaction\.)/u.test(event.type)) return;
        invalidate();
        if (event.type === 'turn.ended') {
          void Promise.all([loop?.settled(), execution?.settled()]).then(invalidate, (error) => {
            invalidate();
            onUnexpectedError(error);
          });
        }
      }),
    );
  }

  private onActivity(handle: IAgentScopeHandle, snapshot: AgentActivityState): void {
    const agentId = handle.id;
    const previous = this.folds.get(agentId);
    const next = foldOf(agentId, snapshot, previous);
    this.folds.set(agentId, next);
    let cause: SessionActivityCause | undefined;
    if (previous === undefined) cause = 'agent_lifecycle';
    else if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background !== next.background || previous.compacting !== next.compacting) cause = 'background';
    else if (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason) cause = 'turn_ended';
    if (cause !== undefined) {
      this.dirtyAgents.set(agentId, handle);
      if (cause === 'background') this.queueRecompute();
      else this.recompute(cause);
    }
  }

  private queueRecompute(): void {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    queueMicrotask(() => {
      this.recomputeQueued = false;
      if (!this.disposed && this.dirtyAgents.size > 0) this.recompute('background');
    });
  }

  private replaceWorkFacts(agentId: string, next: AgentWorkFacts | undefined): void {
    const previous = this.workFacts.get(agentId);
    this.busyAgents += Number(next?.busy ?? false) - Number(previous?.busy ?? false);
    this.executingAgents += Number(next?.executing ?? false) - Number(previous?.executing ?? false);
    if (next === undefined) this.workFacts.delete(agentId);
    else this.workFacts.set(agentId, next);
  }

  private refreshDirtyAgents(): void {
    for (const [agentId, handle] of this.dirtyAgents) {
      this.dirtyAgents.delete(agentId);
      this.replaceWorkFacts(agentId, this.readWorkFacts(handle));
    }
  }

  private readWorkFacts(handle: IAgentScopeHandle): AgentWorkFacts {
    const fold = this.folds.get(handle.id);
    const tasks = handle.accessor.get(IAgentTaskService);
    const activity = handle.accessor.get(IAgentActivityView)?.state();
    const background = tasks === undefined ? (fold?.background ?? 0) > 0 : fold?.compacting === true;
    const loop = handle.accessor.get(IAgentLoopService)?.status();
    const prompts = handle.accessor.get(IAgentPromptService);
    const prompt = prompts?.list();
    const execution = handle.accessor.get(IAgentExecutionService)?.status();
    const state = handle.accessor.get(IAgentStateService);
    const goalActive = state?.has(goalKey) === true && state.get(goalKey)?.status === 'active';
    const executorActive = execution?.state === 'starting' || execution?.state === 'running' || execution?.state === 'cancelling';
    const turnExecuting = loop?.persistenceFailure === undefined && (execution === undefined ? fold?.turnActive === true : executorActive);
    const taskExecuting = tasks?.list(true).some((task) => task.status === 'running' &&
      task.lifetime !== 'service' && task.kind !== 'agent' && task.kind !== 'question') === true;
    const executing = turnExecuting || background || taskExecuting ||
      (loop?.persistenceFailure === undefined && (loop?.state === 'running' || loop?.finalizing === true));
    const busy = fold?.turnActive === true || activity?.turn !== undefined || background || tasks?.hasUnfinishedWork() === true || goalActive ||
      loop?.state === 'running' || loop?.finalizing === true || loop?.persistenceFailure !== undefined || loop?.hasPendingRequests === true ||
      (loop?.pendingTurnIds?.length ?? 0) > 0 || prompt?.active !== undefined || prompt?.launching !== undefined ||
      (prompt?.pending.length ?? 0) > 0 || prompts?.hasReadyPending?.() === true || executorActive;
    return { busy, executing };
  }

  private recompute(cause: SessionActivityCause): void {
    this.refreshDirtyAgents();
    const next = this.aggregate();
    if (activityEquals(this.current, next)) return;
    this.current = next;
    this._onDidChange.fire({ state: next, cause });
  }

  private aggregate(): SessionActivityState {
    return {
      busy: this.busyAgents > 0,
      executing: this.executingAgents > 0,
      mainTurnActive: this.folds.get(MAIN_AGENT_ID)?.turnActive ?? false,
      pendingInteraction: resolvePendingInteraction(this.interactions.listPending()),
      lastTurnReason: this.folds.get(MAIN_AGENT_ID)?.lastTurnReason,
    };
  }
}

function foldOf(
  agentId: string,
  activity: AgentActivityState | undefined,
  previous?: AgentWorkFold,
): AgentWorkFold {
  return {
    turnActive: activity?.turn !== undefined,
    background: activity?.background?.length ?? 0,
    compacting: activity?.background.some((item) => item.kind === 'compaction') === true,
    lastTurnReason:
      agentId === MAIN_AGENT_ID ? mapTurnReason(activity?.lastTurn?.reason) : previous?.lastTurnReason,
  };
}

function mapTurnReason(reason: TurnEndReason | undefined): SessionTurnOutcome | undefined {
  if (reason === undefined) return undefined;
  return reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
}

function resolvePendingInteraction(pending: readonly Interaction[]): SessionPendingInteraction {
  if (pending.some((interaction) => interaction.kind === 'approval')) return 'approval';
  if (pending.some((interaction) => interaction.kind === 'question')) return 'question';
  return 'none';
}

function activityEquals(a: SessionActivityState, b: SessionActivityState): boolean {
  return (
    a.busy === b.busy &&
    a.executing === b.executing &&
    a.mainTurnActive === b.mainTurnActive &&
    a.pendingInteraction === b.pendingInteraction &&
    a.lastTurnReason === b.lastTurnReason
  );
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityView,
  SessionActivityView,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);

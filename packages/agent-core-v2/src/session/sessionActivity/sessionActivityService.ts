import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
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
  lastTurnReason?: SessionTurnOutcome;
}

export const sessionActivityFoldsKey = defineState<Map<string, AgentWorkFold>>(
  'sessionActivity.folds',
  () => new Map(),
);
export const sessionActivityCurrentKey = defineState<SessionActivityState>('sessionActivity.current', () => ({
  busy: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
  lastTurnReason: undefined,
}));

export class SessionActivityView extends Disposable implements ISessionActivityView {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<SessionActivityChangedEvent>());
  readonly onDidChange: Event<SessionActivityChangedEvent> = this._onDidChange.event;

  private readonly agentSubscriptions = new Map<string, IDisposable>();

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionInteractionService private readonly interactions: ISessionInteractionService,
  ) {
    super();
    this.states.contributeState(sessionActivityFoldsKey);
    this.states.contributeState(sessionActivityCurrentKey);
    for (const handle of this.agents.list()) this.attachAgent(handle);
    this.current = this.aggregate();
    this._register(
      this.agents.onDidCreate((handle) => {
        this.attachAgent(handle);
        this.recompute('agent_lifecycle');
      }),
    );
    this._register(
      this.agents.onDidDispose((agentId) => {
        const result = this.agentSubscriptions.get(agentId)?.dispose();
        if (isPromiseLike(result)) result.catch(onUnexpectedError);
        this.agentSubscriptions.delete(agentId);
        if (this.folds.delete(agentId)) this.recompute('agent_lifecycle');
      }),
    );
    this._register(this.interactions.onDidChangePending(() => this.recompute('interaction')));
    this._register(
      toDisposable(async () => {
        for (const subscription of this.agentSubscriptions.values()) await subscription.dispose();
        this.agentSubscriptions.clear();
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
    return this.current;
  }

  private attachAgent(handle: IAgentScopeHandle): void {
    if (this.folds.has(handle.id)) return;
    const view = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
    this.folds.set(handle.id, foldOf(handle.id, view?.state()));
    const bus = handle.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    this.agentSubscriptions.set(
      handle.id,
      bus.subscribe((event) => {
        if (event.type === AgentActivityUpdated.type) this.onActivity(handle.id, event as AgentActivityUpdated);
        if (!/^(turn\.|task\.|prompt\.|goal\.|compaction\.)/u.test(event.type)) return;
        queueMicrotask(() => {
          if (this.agentSubscriptions.has(handle.id)) this.recompute('background');
        });
        if (event.type === 'turn.ended') {
          const loop = handle.accessor.get(IAgentLoopService);
          const execution = handle.accessor.get(IAgentExecutionService);
          void Promise.all([loop?.settled(), execution?.settled()]).then(() => {
            if (this.agentSubscriptions.has(handle.id)) this.recompute('background');
          }, onUnexpectedError);
        }
      }),
    );
  }

  private onActivity(agentId: string, snapshot: AgentActivityState): void {
    const previous = this.folds.get(agentId);
    const next = foldOf(agentId, snapshot, previous);
    this.folds.set(agentId, next);
    if (previous === undefined) {
      this.recompute('agent_lifecycle');
      return;
    }
    let cause: SessionActivityCause | undefined;
    if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background !== next.background) cause = 'background';
    else if (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason) {
      cause = 'turn_ended';
    }
    if (cause !== undefined) this.recompute(cause);
  }

  private recompute(cause: SessionActivityCause): void {
    const next = this.aggregate();
    if (activityEquals(this.current, next)) return;
    this.current = next;
    this._onDidChange.fire({ state: next, cause });
  }

  private aggregate(): SessionActivityState {
    let busy = false;
    for (const handle of this.agents.list()) {
      const fold = this.folds.get(handle.id);
      const tasks = handle.accessor.get(IAgentTaskService);
      const activity = handle.accessor.get(IAgentActivityView)?.state();
      const background = tasks === undefined ? (fold?.background ?? 0) > 0 :
        activity?.background.some((item) => item.kind === 'compaction') === true;
      const loop = handle.accessor.get(IAgentLoopService)?.status();
      const prompt = handle.accessor.get(IAgentPromptService)?.list();
      const execution = handle.accessor.get(IAgentExecutionService)?.status();
      const state = handle.accessor.get(IAgentStateService);
      const goalActive = state?.has(goalKey) === true && state.get(goalKey)?.status === 'active';
      if (fold?.turnActive || background || tasks?.hasUnfinishedWork() || goalActive ||
        loop?.state === 'running' || loop?.finalizing || loop?.persistenceFailure || loop?.hasPendingRequests ||
        (loop?.pendingTurnIds.length ?? 0) > 0 || prompt?.active !== undefined || prompt?.launching !== undefined ||
        (prompt?.pending.length ?? 0) > 0 || execution?.state === 'starting' ||
        execution?.state === 'running' || execution?.state === 'cancelling') {
        busy = true;
        break;
      }
    }
    return {
      busy,
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

import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';

import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import type { UsageRecordedContext, UsageRecordContext, UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import { AgentStatusUpdated } from './usageEvents';
import { panelAccountingKey } from './panelAccounting';
import {
  copyUsage,
  usageKey,
  UsageRecord,
  usageStatusFromState,
  type UsageRecordScope,
} from './usageOps';

export const usageCurrentTurnIdKey = defineState<number | undefined>(
  'usage.currentTurnId',
  () => undefined as number | undefined,
);
export const usageCurrentTurnKey = defineState<TokenUsage | undefined>(
  'usage.currentTurn',
  () => undefined as TokenUsage | undefined,
);

export class AgentUsageService extends Service implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidRecord = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this._onDidRecord.event;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this.states.contributeState(usageKey);
    this.states.contributeState(panelAccountingKey);
    this.states.contributeState(usageCurrentTurnIdKey);
    this.states.contributeState(usageCurrentTurnKey);
  }

  private get currentTurnId(): number | undefined {
    return this.states.get(usageCurrentTurnIdKey);
  }

  private set currentTurnId(value: number | undefined) {
    this.states.set(usageCurrentTurnIdKey, value);
  }

  private get currentTurn(): TokenUsage | undefined {
    return this.states.get(usageCurrentTurnKey);
  }

  private set currentTurn(value: TokenUsage | undefined) {
    this.states.set(usageCurrentTurnKey, value);
  }

  record(
    model: string,
    usage: TokenUsage,
    source?: AgentLLMRequestSource,
    context?: UsageRecordContext,
  ): void {
    const usageScope: UsageRecordScope = source?.type === 'turn' ? 'turn' : 'session';
    const turnId = source?.turnId;
    const profile = this.profile.data();
    void this.dispatcher.dispatch(new UsageRecord({
      model,
      usage,
      usageScope,
      turnId,
      agentId: this.scope.agentId,
      parentAgentId: this.scope.parentAgentId,
      provider: context?.provider,
      modelAlias: context?.modelAlias ?? profile.modelAlias,
      profileName: profile.profileName,
      executorId: context?.executorId ?? profile.executorId ?? 'native',
      usageKnown: context?.usageKnown ?? true,
    }));

    const currentTurnId = source?.type === 'turn' ? source.turnId : undefined;
    if (currentTurnId !== undefined) {
      if (this.currentTurnId !== currentTurnId) {
        this.currentTurnId = currentTurnId;
        this.currentTurn = copyUsage(usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
    }

    void this.dispatcher.dispatch(new AgentStatusUpdated({ usage: this.status() }));
    this._onDidRecord.fire({ model, usage: copyUsage(usage), source });
  }

  status(): UsageStatus {
    return usageStatusFromState(this.states.get(usageKey), this.currentTurn);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  ScopeActivation.OnScopeCreated,
  'usage',
);

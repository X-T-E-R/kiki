import { resolveAskUserQuestionGuard } from '@kiki/protocol';
import { createDecorator, ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IModelService } from '#/kosong/model/model';
import { applyRecipeModelSettings } from '#/app/recipes/recipeModelSettings';
import { IAgentProfileService } from '#/agent/profile/profile';
import { TurnStarted } from '#/agent/loop/turnEvents';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { ExecutableToolContext } from '#/tool/toolContract';
import { INTERACTION_SECTION, type InteractionConfig } from './configSection';

export const QUESTION_FREQUENCY_REMINDER = '你的问题真的有必要吗？先核对当前上下文、用户已定目标和授权；可在既有授权内做合理判断就继续；仅答案会实质改变方向/成本/不可逆结果/验收时提问。不要改用普通文本绕过这次提醒；确需用户决定可再次调用。';

type Attempt = Pick<ExecutableToolContext, 'turnId' | 'step'> & { readonly sequence: number };
export interface QuestionAdmission {
  accepted(): void;
  release(): void;
}
export interface IQuestionFrequencyGuard {
  readonly _serviceBrand: undefined;
  attempt(context: Pick<ExecutableToolContext, 'turnId' | 'step'>): Attempt;
  admit(attempt: Attempt): QuestionAdmission | undefined;
}
export const IQuestionFrequencyGuard = createDecorator<IQuestionFrequencyGuard>('questionFrequencyGuard');

export class QuestionFrequencyGuard extends Disposable implements IQuestionFrequencyGuard {
  declare readonly _serviceBrand: undefined;
  private round = 0;
  private roundCount = 0;
  private sequence = 0;
  private readonly admittedAt: number[] = [];
  private readonly reservations = new Set<{ round: number; override: boolean }>();
  private reminder: Attempt | undefined;

  constructor(
    @IEventBus events: IEventBus,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly models: IModelService,
    @ref(IAgentProfileService) private readonly profile?: LiveRef<IAgentProfileService>,
  ) {
    super();
    this._register(events.subscribe(TurnStarted, (event) => {
      if (!startsUserRound(event.origin)) return;
      this.round++;
      this.roundCount = 0;
      this.reminder = undefined;
    }));
  }

  attempt(context: Pick<ExecutableToolContext, 'turnId' | 'step'>): Attempt {
    return { ...context, sequence: ++this.sequence };
  }

  admit(attempt: Attempt): QuestionAdmission | undefined {
    const modelId = this.profile?.current?.getModel();
    const resolvedId = modelId === undefined ? undefined : this.models.resolveId(modelId);
    const saved = resolvedId === undefined ? undefined : this.models.get(resolvedId);
    const model = saved === undefined ? undefined : applyRecipeModelSettings(saved, this.profile?.current?.getRecipeModelSettings(modelId));
    const settings = resolveAskUserQuestionGuard(
      this.config.get<InteractionConfig | undefined>(INTERACTION_SECTION)?.askUserQuestionGuard,
      model?.behavior,
    );
    const now = Date.now();
    while (this.admittedAt.length > 0 && this.admittedAt[0]! <= now - 86_400_000) this.admittedAt.shift();
    const pending = [...this.reservations];
    const exceeded = settings.enabled && (
      this.roundCount + pending.filter((entry) => entry.round === this.round).length >= settings.maxPerUserRound ||
      this.admittedAt.filter((time) => time > now - settings.windowMs).length + pending.length >= settings.maxPerWindow
    );
    const prior = this.reminder;
    const laterCall = prior !== undefined && attempt.sequence > prior.sequence && (
      attempt.turnId !== prior.turnId || attempt.step === undefined || prior.step === undefined || attempt.step > prior.step
    );
    const overrideInFlight = pending.some((entry) => entry.override);
    if (exceeded && (!laterCall || overrideInFlight)) {
      if (prior === undefined && !overrideInFlight) this.reminder = { ...attempt, sequence: this.sequence };
      return undefined;
    }
    const reservation = { round: this.round, override: exceeded };
    this.reminder = undefined;
    this.reservations.add(reservation);
    let accepted = false;
    return {
      accepted: () => {
        if (accepted || !this.reservations.delete(reservation)) return;
        accepted = true;
        if (reservation.round === this.round) this.roundCount++;
        this.admittedAt.push(Date.now());
        if (this.admittedAt.length > 1000) this.admittedAt.shift();
      },
      release: () => {
        if (!this.reservations.delete(reservation)) return;
        if (reservation.override && reservation.round === this.round && this.reminder === undefined) this.reminder = prior;
      },
    };
  }
}

function startsUserRound(origin: PromptOrigin): boolean {
  return origin.kind === 'user' ||
    ((origin.kind === 'skill_activation' || origin.kind === 'plugin_command') && origin.trigger === 'user-slash') ||
    (origin.kind === 'room_message' && origin.targeted) ||
    origin.kind === 'peer_thread' || origin.kind === 'bridged_peer';
}

registerScopedService(LifecycleScope.Agent, IQuestionFrequencyGuard, QuestionFrequencyGuard, ScopeActivation.OnScopeCreated, 'questionTools');

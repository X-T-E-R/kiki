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

/** The limit that refused a question: per user message, or per rolling time window. */
export type QuestionFrequencyLimit =
  | { readonly kind: 'round'; readonly max: number }
  | { readonly kind: 'window'; readonly max: number; readonly windowMs: number };

/** Model-facing refusal text, in Chinese when `sample` (the refused questions) contains Han characters and in English otherwise. */
export function questionFrequencyReminder(limit: QuestionFrequencyLimit, sample: string): string {
  const minutes = limit.kind === 'window' ? Math.max(1, Math.round(limit.windowMs / 60_000)) : 0;
  if (/\p{Script=Han}/u.test(sample)) {
    const reached = limit.kind === 'round'
      ? `自用户上一条消息以来的提问次数已达上限 ${String(limit.max)} 次`
      : `最近 ${String(minutes)} 分钟内的提问次数已达上限 ${String(limit.max)} 次`;
    return `问题未发送：${reached}。先核对当前上下文、用户已定的目标和授权；能在既有授权内合理判断就继续，只有答案会实质改变方向、成本、不可逆结果或验收标准时才提问。如果确实需要用户决定，请在下一步再次调用 AskUserQuestion，那一次会发送。不要改用普通文本提问来绕过这个限制。`;
  }
  const reached = limit.kind === 'round'
    ? `this agent has reached its limit of ${String(limit.max)} question call(s) since the user's last message`
    : `this agent has reached its limit of ${String(limit.max)} question call(s) in ${String(minutes)} minute(s)`;
  return `Question not sent: ${reached}. Check the current context, the user's stated goal and the authorization you already have; if they let you decide reasonably, continue without asking. Ask only when the answer would materially change the direction, cost, an irreversible result or the acceptance criteria. If the user must still decide, call AskUserQuestion again in your next step; that call is sent. Do not ask the question in ordinary text to get around this limit.`;
}

type Attempt = Pick<ExecutableToolContext, 'turnId' | 'step'> & { readonly sequence: number };
export interface QuestionAdmission {
  accepted(): void;
  release(): void;
}
export interface IQuestionFrequencyGuard {
  readonly _serviceBrand: undefined;
  attempt(context: Pick<ExecutableToolContext, 'turnId' | 'step'>): Attempt;
  admit(attempt: Attempt): QuestionAdmission | QuestionFrequencyLimit;
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

  admit(attempt: Attempt): QuestionAdmission | QuestionFrequencyLimit {
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
    const roundReached = settings.enabled &&
      this.roundCount + pending.filter((entry) => entry.round === this.round).length >= settings.maxPerUserRound;
    const windowReached = settings.enabled &&
      this.admittedAt.filter((time) => time > now - settings.windowMs).length + pending.length >= settings.maxPerWindow;
    const exceeded = roundReached || windowReached;
    const prior = this.reminder;
    const laterCall = prior !== undefined && attempt.sequence > prior.sequence && (
      attempt.turnId !== prior.turnId || attempt.step === undefined || prior.step === undefined || attempt.step > prior.step
    );
    const overrideInFlight = pending.some((entry) => entry.override);
    if (exceeded && (!laterCall || overrideInFlight)) {
      if (prior === undefined && !overrideInFlight) this.reminder = { ...attempt, sequence: this.sequence };
      return roundReached
        ? { kind: 'round', max: settings.maxPerUserRound }
        : { kind: 'window', max: settings.maxPerWindow, windowMs: settings.windowMs };
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

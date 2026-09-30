import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentPlanService, type PlanFilePath } from '#/features/plan/plan';
import { IAgentStateService } from '#/agent/state/agentState';
import PLAN_MODE_EXIT_REMINDER from './plan-mode-exit-reminder.md?raw';
import PLAN_MODE_FULL_REMINDER from './plan-mode-full-reminder.md?raw';
import PLAN_MODE_INLINE_FULL_REMINDER from './plan-mode-inline-full-reminder.md?raw';
import PLAN_MODE_INLINE_REENTRY_REMINDER from './plan-mode-inline-reentry-reminder.md?raw';
import PLAN_MODE_REENTRY_REMINDER from './plan-mode-reentry-reminder.md?raw';

export const planWasActiveKey = defineState<boolean>('plan.wasActive', () => false);

export class PlanModeInjection extends Service {
  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(planWasActiveKey);
    this._register(injector.register('plan_mode', async ({ lastDisclosure, lastInjectedAt }) => {
      const data = await this.plan.status();
      const active = this.states.get(planWasActiveKey);
      const signature = data === null ? 'inactive' : JSON.stringify([data.path]);
      if ((lastDisclosure as { signature?: string } | undefined)?.signature === signature) return undefined;
      if (data === null) {
        if (!active) return undefined;
        this.states.set(planWasActiveKey, false);
        return { content: PLAN_MODE_EXIT_REMINDER, disclosure: { signature } };
      }
      this.states.set(planWasActiveKey, true);
      if (active && lastInjectedAt !== null && lastDisclosure === undefined) return undefined;
      return { content: withPlanFileFooter(data.content.trim() ? reentryReminder(data.path) : fullReminder(data.path), data.path), disclosure: { signature } };
    }));
  }
}
function withPlanFileFooter(body: string, planFilePath: PlanFilePath): string {
  return planFilePath ? `${body}\n\nPlan file: ${planFilePath}` : body;
}
function fullReminder(path: PlanFilePath): string { return path ? PLAN_MODE_FULL_REMINDER : PLAN_MODE_INLINE_FULL_REMINDER; }
function reentryReminder(path: PlanFilePath): string { return path ? PLAN_MODE_REENTRY_REMINDER : PLAN_MODE_INLINE_REENTRY_REMINDER; }

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import type { IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { StepContextReminderContribution } from '#/app/plugin/extensionSlots';
import { IPluginExtensionPortRegistryReader } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export interface IAgentExtensionPortService {
  readonly _serviceBrand: undefined;
}

export const IAgentExtensionPortService = createDecorator<IAgentExtensionPortService>('agentExtensionPortService');

export class AgentExtensionPortService extends Service implements IAgentExtensionPortService {
  declare readonly _serviceBrand: undefined;
  private readonly reminders = new Map<string, { readonly contribution: StepContextReminderContribution; readonly registration: IDisposable }>();

  constructor(
    @IPluginExtensionPortRegistryReader private readonly extensions: IPluginExtensionPortRegistryReader,
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    this.synchronizeReminders();
    this._register(this.extensions.onDidChange(() => this.synchronizeReminders()));
    this._register({ dispose: async () => {
      for (const entry of this.reminders.values()) await entry.registration.dispose();
      this.reminders.clear();
    } });
  }

  private synchronizeReminders(): void {
    const active = new Map<string, StepContextReminderContribution>(this.extensions.activeStepContextReminders().map(contribution =>
      [`${contribution.pluginId}/${contribution.reminderKey}`, contribution] as const));
    for (const [key, entry] of this.reminders) {
      if (active.get(key) === entry.contribution) continue;
      this.reminders.delete(key);
      void entry.registration.dispose();
    }
    for (const [key, contribution] of active) {
      if (this.reminders.has(key)) continue;
      const registration = this.injector.register(`plugin_extension/${key}`, ({ isNewTurn, step }) => {
        if (step === undefined) return undefined;
        return this.extensions.collectStepContextReminder(contribution, {
          sessionId: this.session.sessionId, agentId: this.agent.agentId,
          turnId: step.turnId, step: step.step, isNewTurn, signal: step.signal,
        });
      });
      this.reminders.set(key, { contribution, registration });
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentExtensionPortService,
  AgentExtensionPortService,
  ScopeActivation.OnScopeCreated,
  'pluginExtensionPorts',
);

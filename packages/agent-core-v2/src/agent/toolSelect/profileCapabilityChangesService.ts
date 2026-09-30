import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IAgentProfileCapabilityChangesService } from './profileCapabilityChanges';
import { IAgentStateService } from '#/agent/state/agentState';
import { dynamicPromptKey } from '#/agent/profile/dynamicPrompt';

export class AgentProfileCapabilityChangesService extends Service implements IAgentProfileCapabilityChangesService {
  declare readonly _serviceBrand: undefined;
  private baseline: string | undefined;
  private dirty = true;
  constructor(
    @ISessionSkillCatalog private readonly skills: ISessionSkillCatalog,
    @IAgentToolPolicyService private readonly policy: IAgentToolPolicyService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentStateService states: IAgentStateService,
  ) {
    super();
    this._register(this.skills.onDidChange(() => { this.dirty = true; }));
    this._register(injector.register('profile_capabilities_changed', async () => {
      if (!this.dirty) return undefined;
      await this.skills.ready;
      const next = this.policy.isToolActive('Skill') ? this.skills.catalog.listInvocableSkills()
        .map((skill) => [skill.name, skill.description, skill.path]).toSorted((a, b) => a[0]!.localeCompare(b[0]!)) : [];
      const signature = JSON.stringify(next);
      const changed = this.baseline !== undefined && signature !== this.baseline;
      this.baseline = signature;
      this.dirty = false;
      if (!changed) return undefined;
      await this.profile.refreshSystemPrompt();
      if (states.get(dynamicPromptKey)?.enabled === true) return undefined;
      return { content: `The available skills catalog changed; this supersedes the earlier skill listing.\n${next.map(([name, description, path]) => `${name} — ${description} (${path})`).join('\n') || '(none)'}`,
        disclosure: { signature } };
    }));
  }
}
registerScopedService(LifecycleScope.Agent, IAgentProfileCapabilityChangesService, AgentProfileCapabilityChangesService, ScopeActivation.OnScopeCreated, 'toolSelect');

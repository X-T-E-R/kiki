import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISubagentTool } from './agent';

type VisibleProfiles = ReturnType<ISubagentTool['visibleProfileDescriptions']>;

export function describeProfileDelta(before: VisibleProfiles, after: VisibleProfiles): string | undefined {
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [name, profile] of after) {
    const old = before.get(name);
    if (old === undefined) added.push(profile.line);
    else if (old.signature !== profile.signature) updated.push(profile.line);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) removed.push(name);
  }
  if (added.length === 0 && updated.length === 0 && removed.length === 0) return undefined;
  const sections = [
    added.length > 0 ? `<agent_profiles_added>\n${added.sort().join('\n')}\n</agent_profiles_added>` : undefined,
    updated.length > 0 ? `<agent_profiles_updated>\n${updated.sort().join('\n')}\n</agent_profiles_updated>` : undefined,
    removed.length > 0 ? `<agent_profiles_removed>\n${removed.sort().join('\n')}\n</agent_profiles_removed>` : undefined,
  ];
  return sections.filter((section): section is string => section !== undefined).join('\n');
}

export interface IAgentProfileAnnouncementsService { readonly _serviceBrand: undefined }
export const IAgentProfileAnnouncementsService = createDecorator<IAgentProfileAnnouncementsService>('agentProfileAnnouncementsService');

export class AgentProfileAnnouncementsService extends Service implements IAgentProfileAnnouncementsService {
  declare readonly _serviceBrand: undefined;
  private previous: VisibleProfiles | undefined;
  private dirty = false;

  constructor(
    @ISessionAgentProfileCatalog catalog: ISessionAgentProfileCatalog,
    @ISubagentTool agentRun: ISubagentTool,
    @IAgentToolPolicyService policy: IAgentToolPolicyService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    if (!policy.isToolActive('AgentRun')) return;
    this._register(catalog.onDidChange(() => {
      this.dirty = true;
    }));
    void catalog.ready.then(() => {
      this.previous ??= agentRun.visibleProfileDescriptions();
    });
    this._register(injector.register('agent_profile_changes', async ({ isNewTurn }) => {
      if (!isNewTurn || !this.dirty) return undefined;
      await catalog.ready;
      const current = agentRun.visibleProfileDescriptions();
      const delta = this.previous === undefined ? undefined : describeProfileDelta(this.previous, current);
      this.previous = current;
      this.dirty = false;
      return delta;
    }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileAnnouncementsService,
  AgentProfileAnnouncementsService,
  ScopeActivation.OnScopeCreated,
  'agent',
);

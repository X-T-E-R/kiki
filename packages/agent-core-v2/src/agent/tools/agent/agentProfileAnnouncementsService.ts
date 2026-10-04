import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentStateService } from '#/agent/state/agentState';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISubagentTool } from './agent';

type VisibleProfiles = ReturnType<ISubagentTool['visibleProfileDescriptions']>;
export interface ProfileDirectoryDisclosure { readonly entries: readonly (readonly [string, { readonly line: string; readonly signature: string }])[] }

export function describeProfileDelta(before: VisibleProfiles, after: VisibleProfiles): string | undefined {
  const added: string[] = [];
  const updated: string[] = [];
  const unavailable: string[] = [];
  for (const [name, profile] of after) {
    const old = before.get(name);
    if (old === undefined) added.push(profile.line);
    else if (old.signature !== profile.signature) updated.push(profile.line);
  }
  for (const name of before.keys()) if (!after.has(name)) unavailable.push(name);
  if (!added.length && !updated.length && !unavailable.length) return undefined;
  return ['The dispatchable profile directory for this caller changed. These entries replace the corresponding earlier entries; unavailability does not mean a file was deleted.',
    added.length ? `Available now:\n${added.sort().join('\n')}` : '',
    updated.length ? `Updated:\n${updated.sort().join('\n')}` : '',
    unavailable.length ? `Now unavailable to this caller:\n${unavailable.sort().join('\n')}` : ''].filter(Boolean).join('\n\n');
}

export interface IAgentProfileAnnouncementsService {
  readonly _serviceBrand: undefined;

}
export const IAgentProfileAnnouncementsService = createDecorator<IAgentProfileAnnouncementsService>('agentProfileAnnouncementsService');

export class AgentProfileAnnouncementsService extends Service implements IAgentProfileAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionAgentProfileCatalog catalog: ISessionAgentProfileCatalog,
    @ISubagentTool agentRun: ISubagentTool,
    @IAgentToolPolicyService policy: IAgentToolPolicyService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @ILogService log: ILogService,
    @IAgentStateService states: IAgentStateService,
  ) {
    super();
    this._register(injector.register<ProfileDirectoryDisclosure>('agent_profile_changes', async ({ lastDisclosure }) => {
      if (!policy.isToolActive('AgentRun')) return undefined;
      try { await catalog.ready; } catch (error) {
        log.warn('failed to read the visible agent profiles for change announcements', { error });
        return undefined;
      }
      const schema = states.get(llmRequestTraceKey).advertisedProfiles;
      if (lastDisclosure === undefined && schema === undefined) return undefined;
      const before = lastDisclosure === undefined ? new Map(schema?.map((entry) => [entry.name, { line: entry.line, signature: entry.signature }]))
        : new Map(lastDisclosure.entries);
      const current = agentRun.visibleProfileDescriptions();
      const delta = describeProfileDelta(before, current);
      if (delta === undefined) return undefined;
      return { content: delta, disclosure: { entries: [...current] } };
    }));
  }
}

registerScopedService(LifecycleScope.Agent, IAgentProfileAnnouncementsService, AgentProfileAnnouncementsService, ScopeActivation.OnScopeCreated, 'agent');

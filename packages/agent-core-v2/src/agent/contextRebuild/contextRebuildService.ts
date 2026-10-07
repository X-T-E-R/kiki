import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContextSourceReloader } from '#/session/contextRebuild/contextSourceReloader';
import { ISessionPluginUsageService } from '#/session/pluginUsage/sessionPluginUsageService';

import {
  CONTEXT_REBUILD_SURFACES,
  IAgentContextRebuildService,
  type ContextRebuildResult,
} from './contextRebuild';

export class AgentContextRebuildService implements IAgentContextRebuildService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentContextInjectorService private readonly injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentLLMRequesterService private readonly requester: IAgentLLMRequesterService,
    @IAgentPluginService private readonly plugin: IAgentPluginService,
    @IAgentMcpService private readonly mcp: IAgentMcpService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skills: ISessionSkillCatalog,
    @ISessionContextSourceReloader private readonly sources: ISessionContextSourceReloader,
    @ISessionPluginUsageService private readonly pluginUsage?: ISessionPluginUsageService,
  ) {}

  async rebuild(): Promise<ContextRebuildResult> {
    if (this.scope.agentId !== MAIN_AGENT_ID) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Context rebuild is only available for the main agent.');
    }
    const quiescence = this.loop.tryAcquireQuiescence();
    if (quiescence === undefined) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'The session is busy. Wait for the current turn to finish, then rebuild context again.',
      );
    }
    try {
      const beforeProfile = this.profile.data();
      const beforeContext = JSON.stringify(this.context.get());
      const beforeFields = this.profile.getPromptFieldSnapshot();
      await this.skills.ready;
      const beforeSkills = JSON.stringify(this.skills.catalog.listSkills());
      const toolSnapshot = () => this.mcp.list().map(({ name }) => ({
        name,
        tools: this.mcp.resolved(name)?.rawTools,
        enabledNames: [...(this.mcp.resolved(name)?.enabledNames ?? [])].sort(),
      }));
      const beforeMcp = JSON.stringify({ capabilities: await this.mcp.listMcpSessionCapabilities(), tools: toolSnapshot() });
      const sourceChanges = await this.sources.reload();
      await this.profiles.reload();
      await this.skills.reload();
      await this.profile.rebuildPromptContext();
      await this.plugin.refreshSessionStartAtSafeBoundary();
      await this.mcp.refreshCapabilities();
      await this.injector.reconcileAllAtSafeBoundary();
      this.requester.invalidatePromptSnapshots();
      const afterProfile = this.profile.data();
      const afterFields = this.profile.getPromptFieldSnapshot();
      const afterSkills = JSON.stringify(this.skills.catalog.listSkills());
      const capabilities = await this.mcp.listMcpSessionCapabilities();
      const afterMcp = JSON.stringify({ capabilities, tools: toolSnapshot() });
      const pluginUsage = await this.pluginUsage?.read();
      const changes = {
        profile: JSON.stringify(beforeProfile.boundProfile) !== JSON.stringify(afterProfile.boundProfile)
          || beforeProfile.systemPrompt !== afterProfile.systemPrompt,
        promptFields: JSON.stringify(beforeFields) !== JSON.stringify(afterFields),
        skills: beforeSkills !== afterSkills,
        instructions: sourceChanges.instructionsChanged,
        plugins: sourceChanges.pluginsChanged,
        mcp: beforeMcp !== afterMcp,
        injections: beforeContext !== JSON.stringify(this.context.get()),
      };
      return {
        rebuilt: CONTEXT_REBUILD_SURFACES,
        changed: Object.values(changes).some(Boolean),
        changes,
        readiness: {
          mcp: capabilities.map(({ runtimeName, connection, error }) => ({ runtimeName, connection, error })),
          plugins: {
            state: pluginUsage?.applyState === 'applied' ? 'ready' : pluginUsage?.applyState ?? 'unavailable',
            errors: pluginUsage?.errors ?? [],
          },
        },
      };
    } finally {
      await quiescence.dispose();
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextRebuildService,
  AgentContextRebuildService,
  ScopeActivation.OnDemand,
  'contextRebuild',
);

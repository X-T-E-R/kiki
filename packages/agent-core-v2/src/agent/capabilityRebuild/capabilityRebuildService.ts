import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentCapabilityRebuildService } from './capabilityRebuild';

export class AgentCapabilityRebuildService extends Service implements IAgentCapabilityRebuildService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @ICapabilitySnapshotService capabilities: ICapabilitySnapshotService,
    @ISessionContext session: ISessionContext,
    @IAgentProfileService profile: IAgentProfileService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
  ) {
    super();
    capabilities.memoryAvailable(session.workspaceId, session.sessionId);
    this._register(injector.register('capabilities_rebuilt', async () => {
      await capabilities.ready;
      const changed = capabilities.refresh(session.workspaceId, session.sessionId);
      if (!changed.memory && !changed.thread) return undefined;
      if (changed.memory) await profile.refreshMemorySnapshot();
      else await profile.refreshSystemPrompt();
      const features = [changed.memory ? 'memory' : undefined, changed.thread ? 'thread communication' : undefined].filter(Boolean);
      return `Capability settings changed (${features.join(', ')}). Use the currently available tools; runtime permissions remain enforced.`;
    }));
  }
}
registerScopedService(LifecycleScope.Agent, IAgentCapabilityRebuildService, AgentCapabilityRebuildService, ScopeActivation.OnScopeCreated, 'capabilityRebuild');

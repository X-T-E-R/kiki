import { Service } from '#/_base/di/service';
import { IInstantiationService } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { admitSendMessageCapability } from '#/app/optionalCapability/admit';
import { IOptionalCapabilityPolicy } from '#/app/optionalCapability/policy';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAgentCapabilityRebuildService } from './capabilityRebuild';

export class AgentCapabilityRebuildService extends Service implements IAgentCapabilityRebuildService {
  declare readonly _serviceBrand: undefined;
  private optionalSeen = false;
  private optionalMemory = false;
  private optionalThread = false;
  private optionalSendMessage = false;
  constructor(
    @ICapabilitySnapshotService capabilities: ICapabilitySnapshotService,
    @ISessionContext session: ISessionContext,
    @IAgentProfileService profile: IAgentProfileService,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentToolActivationService toolActivation: IAgentToolActivationService,
    @IInstantiationService instantiation?: IInstantiationService,
  ) {
    super();
    capabilities.memoryAvailable(session.workspaceId, session.sessionId);
    this._register(injector.register('capabilities_rebuilt', async () => {
      await capabilities.ready;
      const changed = capabilities.refresh(session.workspaceId, session.sessionId);
      const optional = await this.readOptional(instantiation, session);
      let memoryChanged = changed.memory;
      let threadChanged = changed.thread;
      let sendMessageChanged = false;
      if (optional !== undefined) {
        if (this.optionalSeen) {
          memoryChanged = memoryChanged || optional.memory !== this.optionalMemory;
          threadChanged = threadChanged || optional.thread !== this.optionalThread;
          sendMessageChanged = optional.sendMessage !== this.optionalSendMessage;
        }
        this.optionalSeen = true;
        this.optionalMemory = optional.memory;
        this.optionalThread = optional.thread;
        this.optionalSendMessage = optional.sendMessage;
      }
      if (!memoryChanged && !threadChanged && !sendMessageChanged) return undefined;
      await toolActivation.activate();
      if (memoryChanged) await profile.refreshMemorySnapshot();
      else await profile.refreshSystemPrompt();
      const features = [memoryChanged ? 'memory' : undefined, threadChanged ? 'thread communication' : undefined, sendMessageChanged ? 'send message' : undefined].filter(Boolean);
      return `Capability settings changed (${features.join(', ')}). Use the currently available tools; runtime permissions remain enforced.`;
    }));
  }

  private async readOptional(
    instantiation: IInstantiationService | undefined,
    session: ISessionContext,
  ): Promise<{ readonly memory: boolean; readonly thread: boolean; readonly sendMessage: boolean } | undefined> {
    if (instantiation === undefined) return undefined;
    let policy: IOptionalCapabilityPolicy | undefined;
    let agentId: string | undefined;
    let deliveryMode: 'reply' | 'message' = 'reply';
    try {
      instantiation.invokeFunction((accessor) => {
        const found = accessor.get(IOptionalCapabilityPolicy);
        if (found !== undefined && typeof found.admit === 'function' && typeof found.load === 'function') policy = found;
        agentId = accessor.get(IAgentScopeContext)?.agentId;
        deliveryMode = accessor.get(ISessionDeliveryService)?.effectiveMode() ?? 'reply';
      });
    } catch {
      return undefined;
    }
    if (policy === undefined) return undefined;
    await policy.load(session.sessionId).catch(() => undefined);
    const request = { sessionId: session.sessionId, workspaceId: session.workspaceId, agentId };
    return {
      memory: policy.admit('memory', request).admitted,
      thread: policy.admit('thread', request).admitted,
      sendMessage: admitSendMessageCapability(policy, request, deliveryMode).admitted,
    };
  }
}
registerScopedService(LifecycleScope.Agent, IAgentCapabilityRebuildService, AgentCapabilityRebuildService, ScopeActivation.OnScopeCreated, 'capabilityRebuild');

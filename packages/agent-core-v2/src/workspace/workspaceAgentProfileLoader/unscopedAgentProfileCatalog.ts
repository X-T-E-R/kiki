import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { IInstantiationService } from '#/_base/di/instantiation';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { AgentProfileRegistryService } from '#/app/agentProfileCatalog/agentProfileRegistryService';
import { ISessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { SessionAgentProfileCatalogService } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalogService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { UserAgentProfileLoaderService } from './userAgentProfileLoaderService';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';
import { InheritedAgentProfileLoaderService } from './inheritedAgentProfileLoaderService';
import { PluginAgentProfileLoaderService } from './pluginAgentProfileLoaderService';
import { ExtraAgentProfileLoaderService } from './extraAgentProfileLoaderService';

class GlobalExtraAgentProfileLoaderService extends ExtraAgentProfileLoaderService {
  protected override readonly globalOnly = true;
}

export function createUnscopedAgentProfileCatalog(instantiation: IInstantiationService) {
  const resources = new DisposableStore();
  try {
    const bootstrap = instantiation.invokeFunction((accessor) => accessor.get(IBootstrapService));
    const registry = resources.add(instantiation.createInstance<AgentProfileRegistryService>(new SyncDescriptor(AgentProfileRegistryService)));
    const workspaceKey = '__unscoped_profile_preview__';
    const services = new ServiceCollection(
      [IAgentProfileRegistry, registry],
      [ISessionAgentProfileCatalogSeed, { _serviceBrand: undefined, workspaceKey }],
      [IWorkspaceContext, {
        _serviceBrand: undefined, workspaceId: workspaceKey, cwd: bootstrap.homeDir,
        source: 'local', persistenceScope: workspaceKey,
        meta: { id: workspaceKey, root: bootstrap.homeDir, name: '', createdAt: 0, lastOpenedAt: 0 },
      }],
    );
    const container = resources.add(instantiation.createChild(services));
    const user = resources.add(container.createInstance(UserAgentProfileLoaderService));
    services.set(IUserAgentProfileLoader, user);
    resources.add(container.createInstance(InheritedAgentProfileLoaderService));
    resources.add(container.createInstance(PluginAgentProfileLoaderService));
    resources.add(container.createInstance(GlobalExtraAgentProfileLoaderService));
    const catalog = resources.add(container.createInstance(SessionAgentProfileCatalogService));
    return { registry, catalog, dispose: () => { resources.dispose(); } };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

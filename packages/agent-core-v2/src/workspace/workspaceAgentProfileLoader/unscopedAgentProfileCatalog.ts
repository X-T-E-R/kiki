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
import { ExplicitAgentProfileLoaderService } from './explicitAgentProfileLoaderService';
import { WorkspaceAgentProfileLoaderService } from './workspaceAgentProfileLoaderService';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ILogService } from '#/_base/log/log';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { WorkspaceTrustService } from '#/workspace/workspaceTrust/workspaceTrustService';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IUserFileSkillSource, UserFileSkillSource } from '#/app/skillCatalog/userFileSkillSource';
import { RuntimeSkillDiscovery } from '#/workspace/workspaceSkillCatalog/runtimeSkillDiscovery';
import { IExplicitFileSkillSource, ExplicitFileSkillSource } from '#/workspace/workspaceSkillCatalog/explicitFileSkillSource';
import { IExtraFileSkillSource, ExtraFileSkillSource } from '#/workspace/workspaceSkillCatalog/extraFileSkillSource';
import { IWorkspaceRootSkillSource, WorkspaceRootSkillSource } from '#/workspace/workspaceSkillCatalog/rootFileSkillSource';
import { IPluginSkillSource, PluginSkillSource } from '#/workspace/workspaceSkillCatalog/pluginSkillSource';
import { WorkspaceSkillCatalogService } from '#/workspace/workspaceSkillCatalog/workspaceSkillCatalogService';

class GlobalExtraAgentProfileLoaderService extends ExtraAgentProfileLoaderService {
  protected override readonly globalOnly = true;
}

class ReadOnlyWorkspaceTrustService extends WorkspaceTrustService {
  protected override migrateLegacyTrust(): Promise<void> {
    return Promise.resolve();
  }
}

/** With cwd, returns a disposable directory snapshot without registration, watchers, or a Program. */
export function createUnscopedAgentProfileCatalog(
  instantiation: IInstantiationService,
  cwd?: string,
  workspaceId?: string,
  includeSkills = true,
) {
  const resources = new DisposableStore();
  try {
    const bootstrap = instantiation.invokeFunction((accessor) => accessor.get(IBootstrapService));
    const registry = resources.add(instantiation.createInstance<AgentProfileRegistryService>(new SyncDescriptor(AgentProfileRegistryService)));
    const workspaceKey = workspaceId ?? (cwd === undefined ? '__unscoped_profile_preview__' : encodeWorkDirKey(cwd));
    const root = cwd ?? bootstrap.homeDir;
    const services = new ServiceCollection(
      [IAgentProfileRegistry, registry],
      [ISessionAgentProfileCatalogSeed, { _serviceBrand: undefined, workspaceKey }],
      [IWorkspaceContext, {
        _serviceBrand: undefined, workspaceId: workspaceKey, cwd: root,
        source: 'local', persistenceScope: workspaceKey,
        meta: { id: workspaceKey, root, name: '', createdAt: 0, lastOpenedAt: 0 },
      }],
    );
    if (cwd !== undefined) {
      services.set(IHostFsWatchService, {
        _serviceBrand: undefined,
        watch: () => ({ ready: Promise.resolve(), onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
      });
      services.set(IWorkspaceStateService, new SyncDescriptor(WorkspaceStateService));
      services.set(IWorkspaceTrust, new SyncDescriptor(ReadOnlyWorkspaceTrustService));
      if (includeSkills) {
        services.set(ISkillDiscovery, instantiation.invokeFunction((accessor) =>
          new RuntimeSkillDiscovery(accessor.get(ILogService), accessor.get(IHostFileSystem))));
        services.set(IUserFileSkillSource, new SyncDescriptor(UserFileSkillSource));
        services.set(IExplicitFileSkillSource, new SyncDescriptor(ExplicitFileSkillSource));
        services.set(IExtraFileSkillSource, new SyncDescriptor(ExtraFileSkillSource));
        services.set(IWorkspaceRootSkillSource, new SyncDescriptor(WorkspaceRootSkillSource));
        services.set(IPluginSkillSource, new SyncDescriptor(PluginSkillSource));
      }
    }
    const container = resources.add(instantiation.createChild(services));
    const user = resources.add(container.createInstance(UserAgentProfileLoaderService));
    services.set(IUserAgentProfileLoader, user);
    const loaders: { readonly ready: Promise<void> }[] = [
      user,
      resources.add(container.createInstance(InheritedAgentProfileLoaderService)),
      resources.add(container.createInstance(PluginAgentProfileLoaderService)),
      resources.add(container.createInstance(cwd === undefined ? GlobalExtraAgentProfileLoaderService : ExtraAgentProfileLoaderService)),
    ];
    if (cwd !== undefined) {
      loaders.push(resources.add(container.createInstance<ExplicitAgentProfileLoaderService>(new SyncDescriptor(ExplicitAgentProfileLoaderService))));
      loaders.push(resources.add(container.createInstance<WorkspaceAgentProfileLoaderService>(new SyncDescriptor(WorkspaceAgentProfileLoaderService))));
    }
    resources.add(registry.registerSourceReadiness('preview', workspaceKey, Promise.all(loaders.map((loader) => loader.ready)).then(() => {})));
    const skills = cwd === undefined || !includeSkills ? undefined : resources.add(container.createInstance(WorkspaceSkillCatalogService));
    const catalog = resources.add(container.createInstance(SessionAgentProfileCatalogService));
    return { registry, catalog, skills, workspaceId: workspaceKey, dispose: () => { resources.dispose(); } };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}

import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { IGitService } from '#/app/git/git';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import { IPluginService } from '#/app/plugin/plugin';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IBuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { IAppStateService } from '#/app/state/appState';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { LifecycleScope } from '#/app/scopes';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProviderService } from '#/kosong/provider/provider';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { Error2, ErrorCodes } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { LocalRuntimeProviderFactory } from '#/runtime/localRuntime';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, RuntimeRegistry } from '#/runtime/runtimeRegistry';
import type { RuntimeProviderFactory } from '#/runtime/runtimeProvider';
import { SharedRuntimeUnitHostFactory, type RuntimeUnitHandle, type RuntimeUnitHostFactory } from '#/runtime/runtimeUnitHost';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';

import {
  DEFAULT_WORKSPACE_IDLE_TTL_MS,
  WORKSPACE_INSTANCE_SECTION,
  type WorkspaceInstanceConfig,
} from './configSection';
import { WorkspaceInstance } from './workspaceInstance';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
  type WorkspaceInstanceLease,
  type WorkspaceInstanceRef,
} from './workspaceInstanceManager';

export class WorkspaceInstanceManager implements IWorkspaceInstanceManager {
  declare readonly _serviceBrand: undefined;
  private readonly instances = new Map<string, WorkspaceInstance>();
  private readonly requests = new Map<string, Promise<WorkspaceInstance>>();
  private readonly inflight = new Map<string, Promise<WorkspaceInstance>>();
  private readonly providers = new Map<string, RuntimeProviderFactory>();
  private readonly attachments = new Map<string, Map<string, RuntimeUnitHandle>>();
  private readonly references = new Map<string, number>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closing = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly changeEmitter = new Emitter<{ workspaceId: string; instance?: WorkspaceInstance }>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IAppStateService private readonly appState: IAppStateService,
    @IConfigService private readonly config: IConfigService,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
    @IEventService private readonly event: IEventService,
    @IFlagService private readonly flags: IFlagService,
    @ref(IGitService) private readonly git: LiveRef<IGitService>,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
    @IMcpConfigStore private readonly configStore: IMcpConfigStore,
    @IPluginService private readonly plugins: IPluginService,
    @IProviderService private readonly modelProviders: IProviderService,
    @ref(ISessionManager) private readonly sessionManager: LiveRef<ISessionManager>,
    @IAgentProfileRegistry private readonly agentProfiles: IAgentProfileRegistry,
    @IAgentExecutorRegistry private readonly agentExecutors: IAgentExecutorRegistry,
    @IBuiltinAgentProfileLoader private readonly builtinAgentProfiles: IBuiltinAgentProfileLoader,
    @IBuiltinSkillSource private readonly builtinSkills: IBuiltinSkillSource,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    private readonly unitHostFactory: RuntimeUnitHostFactory = new SharedRuntimeUnitHostFactory(),
    private readonly idleTtlMsOverride: number | undefined = undefined,
  ) {
    this.providers.set('local', new LocalRuntimeProviderFactory());
  }

  get(workspaceId: string): WorkspaceInstance | undefined {
    return this.instances.get(workspaceId);
  }

  findByRoot(root: string): WorkspaceInstance | undefined {
    const normalized = root.replace(/[\\/]$/, '');
    return [...this.instances.values()].find((instance) => instance.root.replace(/[\\/]$/, '') === normalized);
  }

  findContaining(cwd: string): WorkspaceInstance | undefined {
    const probe = canonicalWorkspaceRoot(cwd);
    let best: { readonly instance: WorkspaceInstance; readonly rootLength: number } | undefined;
    for (const instance of this.instances.values()) {
      const root = canonicalWorkspaceRoot(instance.root);
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (probe !== root && !probe.startsWith(prefix)) continue;
      if (best === undefined || root.length > best.rootLength) {
        best = { instance, rootLength: root.length };
      }
    }
    return best?.instance;
  }

  list(): readonly WorkspaceInstance[] {
    return [...this.instances.values()];
  }

  referenceCount(workspaceId: string): number {
    return this.references.get(workspaceId) ?? 0;
  }

  snapshot(): { readonly workspaces: readonly ReturnType<WorkspaceInstance['snapshot']>[] } {
    return { workspaces: this.list().map((instance) => instance.snapshot()) };
  }

  async getOrCreate(ref: WorkspaceInstanceRef): Promise<WorkspaceInstance> {
    if (this.disposed) throw new Error('workspace instance manager is disposed');
    if ('workspaceId' in ref) {
      const closing = this.closing.get(ref.workspaceId);
      if (closing !== undefined) await closing;
      if (this.disposed) throw new Error('workspace instance manager is disposed');
    }
    const key = 'workspaceId' in ref
      ? `id:${ref.workspaceId}`
      : `root:${ref.root.replace(/[\\/]$/, '')}`;
    const request = this.requests.get(key);
    if (request !== undefined) return request;
    const promise = (async () => {
      let workspace: Workspace | undefined;
      if ('workspaceId' in ref) {
        workspace = await this.workspaces.get(ref.workspaceId);
        if (workspace === undefined && ref.root !== undefined) workspace = await this.workspaces.createOrTouch(ref.root);
      } else {
        workspace = await this.workspaces.createOrTouch(ref.root);
      }
      if (workspace === undefined) throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${'workspaceId' in ref ? ref.workspaceId : ref.root} does not exist`);
      const existing = this.instances.get(workspace.id);
      if (existing !== undefined) {
        this.scheduleEviction(workspace.id);
        return existing;
      }
      const pending = this.inflight.get(workspace.id);
      if (pending !== undefined) return pending;
      const materialization = this.materialize(workspace).finally(() => this.inflight.delete(workspace.id));
      this.inflight.set(workspace.id, materialization);
      return materialization;
    })().finally(() => this.requests.delete(key));
    this.requests.set(key, promise);
    return promise;
  }

  async acquire(ref: WorkspaceInstanceRef): Promise<WorkspaceInstanceLease> {
    while (true) {
      const instance = await this.getOrCreate(ref);
      const lease = this.retain(instance);
      if (lease !== undefined) return lease;
      const closing = this.closing.get(instance.id);
      if (closing !== undefined) await closing;
    }
  }

  close(workspaceId: string): Promise<void> {
    const existing = this.closing.get(workspaceId);
    if (existing !== undefined) return existing;
    const promise = this.doClose(workspaceId).finally(() => this.closing.delete(workspaceId));
    this.closing.set(workspaceId, promise);
    return promise;
  }

  async addProvider(factory: RuntimeProviderFactory): Promise<{ dispose(): Promise<void> }> {
    if (this.providers.has(factory.id)) throw new Error(`runtime provider ${factory.id} already exists`);
    this.providers.set(factory.id, factory);
    const attached: WorkspaceInstance[] = [];
    try {
      for (const instance of this.instances.values()) {
        await this.attach(instance, factory);
        attached.push(instance);
      }
    } catch (error) {
      this.providers.delete(factory.id);
      for (const instance of attached.reverse()) await this.detach(instance.id, factory.id);
      throw error;
    }
    return { dispose: async () => {
      if (this.providers.get(factory.id) !== factory) return;
      this.providers.delete(factory.id);
      for (const workspaceId of [...this.attachments.keys()].reverse()) await this.detach(workspaceId, factory.id);
    } };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    for (const workspaceId of [...this.instances.keys()].reverse()) await this.close(workspaceId);
    this.changeEmitter.dispose();
  }

  private retain(instance: WorkspaceInstance): WorkspaceInstanceLease | undefined {
    if (
      this.disposed ||
      this.closing.has(instance.id) ||
      this.instances.get(instance.id) !== instance
    ) {
      return undefined;
    }
    this.cancelEviction(instance.id);
    this.references.set(instance.id, this.referenceCount(instance.id) + 1);
    let active = true;
    return {
      instance,
      dispose: () => {
        if (!active) return;
        active = false;
        const count = this.referenceCount(instance.id);
        if (count <= 1) {
          this.references.delete(instance.id);
          this.scheduleEviction(instance.id);
        } else {
          this.references.set(instance.id, count - 1);
        }
      },
    };
  }

  private scheduleEviction(workspaceId: string): void {
    if (
      this.disposed ||
      this.referenceCount(workspaceId) !== 0 ||
      !this.instances.has(workspaceId) ||
      this.closing.has(workspaceId)
    ) {
      return;
    }
    this.cancelEviction(workspaceId);
    const timer = setTimeout(() => {
      this.evictionTimers.delete(workspaceId);
      if (this.referenceCount(workspaceId) !== 0) return;
      void this.close(workspaceId).catch((error: unknown) => {
        this.log.warn(`workspace ${workspaceId} idle eviction failed: ${String(error)}`);
      });
    }, this.idleTtlMs());
    (timer as { unref?(): void }).unref?.();
    this.evictionTimers.set(workspaceId, timer);
  }

  private cancelEviction(workspaceId: string): void {
    const timer = this.evictionTimers.get(workspaceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.evictionTimers.delete(workspaceId);
  }

  private idleTtlMs(): number {
    if (this.idleTtlMsOverride !== undefined) return this.idleTtlMsOverride;
    return this.config.get<WorkspaceInstanceConfig>(WORKSPACE_INSTANCE_SECTION).idleTtlMs ??
      DEFAULT_WORKSPACE_IDLE_TTL_MS;
  }

  private async doClose(workspaceId: string): Promise<void> {
    this.cancelEviction(workspaceId);
    const pending = this.requests.get(`id:${workspaceId}`) ?? this.inflight.get(workspaceId);
    if (pending !== undefined) await pending.catch(() => undefined);
    const instance = this.instances.get(workspaceId);
    if (instance === undefined) return;
    await this.sessionManager.current?.closeWorkspace?.(workspaceId);
    this.references.delete(workspaceId);
    this.instances.delete(workspaceId);
    const attachments = this.attachments.get(workspaceId);
    this.attachments.delete(workspaceId);
    if (attachments !== undefined) {
      for (const attachment of [...attachments.values()].reverse()) await attachment.dispose();
    }
    await instance.dispose();
    this.changeEmitter.fire({ workspaceId });
  }

  private async materialize(workspace: Workspace): Promise<WorkspaceInstance> {
    await this.environment.ready;
    const runtimes = new RuntimeRegistry(workspace.id);
    const unitHost = this.unitHostFactory.create(this.instantiation, runtimes);
    const instance = new WorkspaceInstance(
      workspace,
      runtimes,
      unitHost,
      {
        _serviceBrand: undefined,
        workspaceId: workspace.id,
        cwd: workspace.root,
        source: 'local',
        meta: workspace,
        persistenceScope: `${this.bootstrap.scope('sessions')}/${workspace.id}`,
      },
      {
        appState: this.appState,
        bootstrap: this.bootstrap,
        config: this.config,
        git: this.git,
        identity: this.identity,
        log: this.log,
        oauth: this.oauth,
        configStore: this.configStore,
        plugins: this.plugins,
        sessionManager: this.sessionManager,
        agentProfiles: this.agentProfiles,
        agentExecutors: this.agentExecutors,
        builtinAgentProfiles: this.builtinAgentProfiles,
        builtinSkills: this.builtinSkills,
        telemetry: this.telemetry,
        docs: this.docs,
        flags: this.flags,
        acquireWorkspaceReference: () => {
          const live = this.instances.get(workspace.id);
          const lease = live === undefined ? undefined : this.retain(live);
          if (lease === undefined) throw new Error(`workspace ${workspace.id} is closing`);
          return lease;
        },
        createSessionController: (input) => new SessionLifecycleService(
          this.instantiation,
          input.context,
          this.bootstrap,
          this.config,
          this.index,
          this.indexMirror,
          this.appendLogStore,
          this.docs,
          this.storage,
          this.log,
          input.fs,
          this.cronStore,
          this.event,
          this.telemetry,
          input.workspaceAgentProfiles,
          input.extraAgentProfiles,
          input.explicitAgentProfiles,
          input.userAgentProfiles,
          input.pluginAgentProfiles,
          input.dirs,
          input.skills,
          input.instructions,
          input.mcp,
          this.modelCatalog,
          this.models,
          this.modelProviders,
          this.flags,
          input.acquireWorkspaceReference,
          input.onDispose,
        ),
      },
    );
    try {
      for (const provider of this.providers.values()) await this.attach(instance, provider);
      if (instance.runtimes.current('local') === undefined) throw new Error(`workspace ${workspace.id} has no local runtime`);
      instance.activate();
      this.instances.set(workspace.id, instance);
      this.scheduleEviction(workspace.id);
      this.changeEmitter.fire({ workspaceId: workspace.id, instance });
      return instance;
    } catch (error) {
      const attachments = this.attachments.get(instance.id);
      this.attachments.delete(instance.id);
      if (attachments !== undefined) {
        for (const attachment of [...attachments.values()].reverse()) await attachment.dispose();
      }
      await instance.dispose();
      throw error;
    }
  }

  private async attach(instance: WorkspaceInstance, provider: RuntimeProviderFactory): Promise<void> {
    const existing = this.attachments.get(instance.id);
    if (existing?.has(provider.id) === true) throw new Error(`runtime provider ${provider.id} is already attached to workspace ${instance.id}`);
    const attachment = await instance.unitHost.provide(provider.imports, (host) => provider.attach({
      id: instance.id,
      root: instance.root,
      metadata: instance.metadata,
    }, host));
    let attachments = this.attachments.get(instance.id);
    if (attachments === undefined) {
      attachments = new Map();
      this.attachments.set(instance.id, attachments);
    }
    attachments.set(provider.id, attachment);
  }

  private async detach(workspaceId: string, providerId: string): Promise<void> {
    const attachments = this.attachments.get(workspaceId);
    const attachment = attachments?.get(providerId);
    if (attachments === undefined || attachment === undefined) return;
    attachments.delete(providerId);
    if (attachments.size === 0) this.attachments.delete(workspaceId);
    await attachment.dispose();
  }
}

export class RuntimeResolver implements IRuntimeResolver {
  declare readonly _serviceBrand: undefined;
  constructor(@IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager) {}
  inspect(binding: RuntimeBinding): Runtime {
    const workspace = this.workspaces.get(binding.workspaceId);
    if (workspace === undefined) {
      throw new RuntimeError('runtime.not_found', `workspace ${binding.workspaceId} is not materialized`);
    }
    return workspace.runtimes.inspect(binding);
  }
  acquire(binding: RuntimeBinding, required: readonly RuntimeCapability[] = []): RuntimeLease {
    const workspace = this.workspaces.get(binding.workspaceId);
    if (workspace === undefined) {
      throw new RuntimeError('runtime.not_found', `workspace ${binding.workspaceId} is not materialized`);
    }
    return workspace.runtimes.acquire(binding, required);
  }
}

registerScopedService(LifecycleScope.App, IWorkspaceInstanceManager, WorkspaceInstanceManager, ScopeActivation.OnScopeCreated, 'workspaceInstanceManager');
registerScopedService(LifecycleScope.App, IRuntimeResolver, RuntimeResolver, ScopeActivation.OnScopeCreated, 'runtimeResolver');

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { Error2, ErrorCodes } from '#/errors';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { permissionModeConfiguredKey } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { profileKey } from '#/agent/profile/profileOps';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import '#/agent/runtimeBinding/runtimeBindingService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { interactionKey } from '#/session/interaction/interactionOps';
import { IWireService } from '#/wire/wire';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import {
  normalizeRequestedThinkingEffort,
  requiresStrictThinkingValidation,
  resolveThinkingEffortForModel,
  type ThinkingConfig,
} from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import {
  type AgentListFilter,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';
import { resolveDelegationPosition } from '#/agent/profile/delegationContext';
import { resolveMainModelCandidate } from '#/agent/profile/mainModelCandidate';

let nextAgentId = 0;

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onWillCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly usageDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();
  private readonly removing = new Map<string, Promise<void>>();
  private readonly deferredCreateEvents = new Set<string>();

  get onWillCreate() {
    return this.onWillCreateEmitter.event;
  }
  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionAgentProfileCatalog private readonly profileCatalog: ISessionAgentProfileCatalog,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProtocolAdapterRegistry private readonly protocolAdapters: IProtocolAdapterRegistry,
  ) {
    super();
    this._register(
      this.onDidDispose((agentId) => {
        for (const disposables of [this.interactionBusDisposables, this.usageDisposables]) {
          disposables.get(agentId)?.dispose();
          disposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const disposables of [this.interactionBusDisposables, this.usageDisposables]) {
          for (const d of disposables.values()) d.dispose();
          disposables.clear();
        }
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IEventBus)
      .subscribe(TurnEnded, (e) => this.interaction.cancelPendingForTurn(e.turnId));
    this.interactionBusDisposables.set(handle.id, d);
  }

  private subscribeUsage(handle: IAgentScopeHandle): void {
    if (this.usageDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IAgentUsageService)
      .onDidRecord(({ model, usage }) => {
        this.sessionMetadata.recordUsage(model, usage);
      });
    this.usageDisposables.set(handle.id, d);
  }

  private resolveModelId(alias: string): string {
    return this.models.resolveId(alias) ?? alias;
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const removal = this.removing.get(opts.agentId);
      if (removal !== undefined) {
        await removal.catch(() => undefined);
        return this.create(opts);
      }
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) {
        const persisted = existing.accessor.get(IAgentProfileService).data();
        if (opts.binding !== undefined && opts.binding.route !== persisted.routeId) {
          throw new Error2(
            ErrorCodes.ROUTE_SWITCH_FORBIDDEN,
            `Agent "${opts.agentId}" is bound to route "${persisted.routeId ?? 'base'}" and cannot switch to "${opts.binding.route}"`,
          );
        }
        if (
          persisted.lockedModelAlias !== undefined &&
          opts.binding?.model !== undefined &&
          this.resolveModelId(opts.binding.model) !== persisted.lockedModelAlias
        ) {
          throw new Error2(
            ErrorCodes.ROUTE_BINDING_CONFLICT,
            `Agent profile route "${persisted.routeId}" locks model_alias to "${persisted.lockedModelAlias}"`,
          );
        }
        if (
          persisted.lockedThinkingEffort !== undefined &&
          opts.binding?.thinking !== undefined &&
          opts.binding.thinking !== persisted.lockedThinkingEffort
        ) {
          throw new Error2(
            ErrorCodes.ROUTE_BINDING_CONFLICT,
            `Agent profile route "${persisted.routeId}" locks thinking_effort to "${persisted.lockedThinkingEffort}"`,
          );
        }
        return existing;
      }
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise =
      opts.binding?.route === undefined
        ? this.doCreate(agentId, opts)
        : this.doCreateAfterRoutePreflight(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async preflightRouteBinding(binding: CreateAgentOptions['binding']): Promise<void> {
    if (binding?.route === undefined) return;
    await this.profileCatalog.ready;
    const selection =
      binding.resolvedProfile === undefined
        ? this.profileCatalog.resolveSelection({
            profile: binding.profile,
            route: binding.route,
          })
        : {
            profile: binding.resolvedRoute?.effectiveProfile ?? binding.resolvedProfile,
            baseProfile: binding.resolvedProfile,
            route: binding.resolvedRoute,
          };
    const route = selection.route!;
    const canonicalRouteModelAlias =
      route.lockedModelAlias === undefined ? undefined : this.resolveModelId(route.lockedModelAlias);
    if (
      route.lockedModelAlias !== undefined &&
      binding.model !== undefined &&
      this.resolveModelId(binding.model) !== canonicalRouteModelAlias
    ) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${route.id}" locks model_alias to "${route.lockedModelAlias}"`,
      );
    }
    if (
      route.lockedThinkingEffort !== undefined &&
      binding.thinking !== undefined &&
      binding.thinking !== route.lockedThinkingEffort
    ) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${route.id}" locks thinking_effort to "${route.lockedThinkingEffort}"`,
      );
    }
    const requestedAlias = resolveMainModelCandidate({
      inputModel: binding.model,
      routeLockedAlias: route.lockedModelAlias,
      profileModelAlias: selection.profile.modelAlias,
      defaultModel: this.config.get<string>('defaultModel'),
    }).alias;
    if (requestedAlias === undefined || requestedAlias === '') return;
    const alias = this.resolveModelId(requestedAlias);
    let model: Model;
    try {
      model = this.modelCatalog.get(alias);
    } catch (error) {
      if (route.lockedModelAlias === undefined) throw error;
      throw new Error2(
        ErrorCodes.ROUTE_MODEL_ALIAS_MISSING,
        `Agent profile route "${route.id}" requires unavailable model alias "${route.lockedModelAlias}"`,
        {
          details: { route: route.id, modelAlias: route.lockedModelAlias },
          cause: error,
        },
      );
    }
    const lockedEffort = normalizeRequestedThinkingEffort(route.lockedThinkingEffort);
    if (lockedEffort === undefined) return;
    const strict = requiresStrictThinkingValidation(
      this.protocolAdapters,
      model.protocol,
      model.providerType,
    );
    const resolved = resolveThinkingEffortForModel(
      lockedEffort,
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
      strict,
    );
    if (resolved !== lockedEffort) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${route.id}" requires thinking_effort "${route.lockedThinkingEffort}", which model "${alias}" cannot honor`,
        {
          details: {
            route: route.id,
            modelAlias: alias,
            lockedThinkingEffort: route.lockedThinkingEffort,
            resolvedThinkingEffort: resolved,
          },
        },
      );
    }
  }

  private async doCreateAfterRoutePreflight(
    agentId: string,
    opts: CreateAgentOptions,
  ): Promise<IAgentScopeHandle> {
    await this.preflightRouteBinding(opts.binding);
    return this.doCreate(agentId, opts);
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.handles.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    let priorAgentMeta: AgentMeta | undefined;
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        seeds: [
          [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
          [ITelemetryService, this.telemetry.withContext({ agent_id: agentId })],
          [IAgentRuntimeBindingSeed, {
            _serviceBrand: undefined,
            binding: { workspaceId: this.ctx.workspaceId, runtimeId: opts.runtimeId ?? 'local' },
          }],
        ],
      },
    ) as IAgentScopeHandle;
    this.handles.set(agentId, handle);
    try {
      priorAgentMeta = (await this.sessionMetadata.read()).agents?.[agentId];
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      handle.accessor.get(IAgentStateService).contributeState(interactionKey);
      this.subscribeInteractionBus(handle);
      this.subscribeUsage(handle);
      this.onWillCreateEmitter.fire(handle);
      await handle.accessor.get(IEventDispatcher).restore();
      await this.bindBootstrap(handle, opts);
      const profile = handle.accessor.get(IAgentProfileService).data();
      if ((profile.executorId ?? 'native') === 'native') {
        await handle.accessor.get(IAgentToolActivationService).activate();
      }
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: resolveDelegationPosition(agentId, opts.delegator),
        parentAgentId:
          agentId === 'main'
            ? undefined
            : opts.delegator?.kind === 'external'
              ? undefined
              : opts.delegator?.kind === 'agent'
                ? opts.delegator.agentId
                : 'main',
        delegator: opts.delegator,
        forkedFrom: opts.forkedFrom,
        labels: opts.labels,
        displayName: priorAgentMeta?.displayName ?? profile.routeId ?? profile.profileName,
        userLabel: opts.userLabel ?? priorAgentMeta?.userLabel,
        model: profile.modelAlias,
        thinkingEffort: profile.thinkingLevel,
        executor: profile.executorId,
        executorProtocol: profile.executorProtocol,
      });
      if (opts.deferCreateEvent === true) this.deferredCreateEvents.add(agentId);
      else this.onDidCreateEmitter.fire(handle);
      return handle;
    } catch (error) {
      this.deferredCreateEvents.delete(agentId);
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      if (priorAgentMeta === undefined) {
        await this.sessionMetadata.unregisterAgent?.(agentId).catch(() => {});
      } else {
        await this.sessionMetadata.registerAgent(agentId, priorAgentMeta).catch(() => {});
      }
      try {
        handle.dispose();
      } catch { }
      this.onDidDisposeEmitter.fire(agentId);
      throw error;
    }
  }

  commitCreate(agentId: string): void {
    if (!this.deferredCreateEvents.delete(agentId)) return;
    const handle = this.handles.get(agentId);
    if (handle !== undefined) this.onDidCreateEmitter.fire(handle);
  }

  async discard(agentId: string): Promise<void> {
    this.deferredCreateEvents.delete(agentId);
    await this.remove(agentId);
    await this.sessionMetadata.unregisterAgent?.(agentId);
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind({
        ...opts.binding,
        delegationPosition: resolveDelegationPosition(handle.id, opts.delegator),
      });
    }
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = handle.accessor
      .get(IAgentStateService)
      .get(permissionModeConfiguredKey);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Source agent "${sourceAgentId}" does not exist`, {
        details: { agentId: sourceAgentId },
      });
    }
    if (opts?.agentId !== undefined && this.handles.has(opts.agentId)) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const sourceData = source.accessor.get(IAgentProfileService).data();
    const override = opts?.binding;
    const overrideBinding =
      override?.profile !== undefined || override?.route !== undefined
        ? {
            profile: override.profile,
            route: override.route,
            model: override.model ?? sourceData.modelAlias,
            thinking: override.thinking ?? sourceData.thinkingLevel,
          }
        : undefined;
    const child = await this.create({
      agentId: opts?.agentId,
      runtimeId: source.accessor.get(IAgentRuntimeBindingService).current.runtimeId,
      forkedFrom: source.id,
      binding: overrideBinding,
    });
    const childProfile = child.accessor.get(IAgentProfileService);
    if (overrideBinding === undefined) {
      childProfile.applyBindingSnapshot(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return child;
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.handles.values()) {
      if (
        handle.accessor.get(IAgentStateService).get(profileKey).profileName ===
        TOWER_WORKER_PROFILE
      ) {
        continue;
      }
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return this.removing.get(agentId);
    this.handles.delete(agentId);
    this.deferredCreateEvents.delete(agentId);
    const removal = this.doRemove(agentId, handle).finally(() => {
      if (this.removing.get(agentId) === removal) this.removing.delete(agentId);
    });
    this.removing.set(agentId, removal);
    return removal;
  }

  private async doRemove(agentId: string, handle: IAgentScopeHandle): Promise<void> {
    await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
    const execution = handle.accessor.get(IAgentExecutionService);
    const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
    const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
    const reason = abortError('Agent removed');
    execution.cancel(reason);
    if (compaction !== null && !compaction.abortController.signal.aborted) {
      compaction.abortController.abort(reason);
    }
    await Promise.all([execution.shutdown(reason), compactionSettled]);
    handle.dispose();
    this.onDidDisposeEmitter.fire(agentId);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);

/**
 * `agentLifecycle` domain — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry,
 * serializing same-id bootstrap and dropping incomplete handles after startup
 * failure. Seeds each agent's identity through `agent` scopeContext, wires
 * per-agent wire records and the wire state machine, the blob store, and MCP,
 * and registers the agent in the session registry. Binds the agent id into the
 * Agent-scoped telemetry view. New logs receive a metadata
 * envelope while non-empty unversioned logs are rejected. Removal awaits the
 * agent task manager's graceful exit policy before draining turns and full
 * compaction, then disposing the child scope. Fans session-level
 * permission-mode switches out to every live agent — except
 * `tower-worker`-profile agents, which TowerSpawn pins to `auto` (they run
 * detached and unattended); the broadcast leaves them on `auto`. Bound at
 * Session scope.
 *
 * No agent id is special here: the main agent is simply the agent created
 * with the conventional `MAIN_AGENT_ID`, and `fork` requires its source to
 * exist. MCP readiness is not awaited here: the workspace's shared manager
 * connects in the background and the agent's LLM steps wait on it instead
 * (see `AgentMcpService`).
 */

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
import { PermissionModeConfiguredModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { ProfileModel } from '#/agent/profile/profileOps';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import '#/agent/runtimeBinding/runtimeBindingService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IWireService } from '#/wire/wire';
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

let nextAgentId = 0;

export const SUBAGENT_BINDING_MODE_LABEL = 'subagentBindingMode';
export type PersistedSubagentBindingMode = 'inherit' | 'fixed';

export function withSubagentBindingMode(
  labels: Readonly<Record<string, string>>,
  mode: PersistedSubagentBindingMode,
): Readonly<Record<string, string>> {
  return { ...labels, [SUBAGENT_BINDING_MODE_LABEL]: mode };
}

export function persistedSubagentBindingMode(
  meta: AgentMeta | undefined,
): PersistedSubagentBindingMode {
  return meta?.labels?.[SUBAGENT_BINDING_MODE_LABEL] === 'inherit' ? 'inherit' : 'fixed';
}

export async function refreshInheritedSubagentBinding(
  caller: IAgentScopeHandle,
  target: IAgentScopeHandle,
  meta: AgentMeta | undefined,
): Promise<void> {
  if (persistedSubagentBindingMode(meta) !== 'inherit') return;
  const callerData = caller.accessor.get(IAgentProfileService).data();
  if (callerData.modelAlias === undefined) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
      details: { agentId: caller.id },
    });
  }
  const targetProfile = target.accessor.get(IAgentProfileService);
  if (targetProfile.data().modelAlias !== callerData.modelAlias) {
    await targetProfile.setModel(callerData.modelAlias);
  }
  if (targetProfile.data().thinkingLevel !== callerData.thinkingLevel) {
    targetProfile.setThinking(callerData.thinkingLevel);
  }
}

// NOTE: stays Disposable — its own 'get' and 'config' collide with the Fiber
export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();
  private readonly deferredCreateEvents = new Set<string>();

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
    this._register(this.onDidCreate((handle) => this.subscribeInteractionBus(handle)));
    this._register(
      this.onDidDispose((agentId) => {
        const d = this.interactionBusDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          this.interactionBusDisposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const d of this.interactionBusDisposables.values()) d.dispose();
        this.interactionBusDisposables.clear();
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IEventBus)
      .subscribe('turn.ended', (e) => this.interaction.cancelPendingForTurn(e.turnId));
    this.interactionBusDisposables.set(handle.id, d);
  }

  private resolveModelId(alias: string): string {
    return this.models.resolveId(alias) ?? alias;
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
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
    const selection = this.profileCatalog.resolveSelection({
      profile: binding.profile,
      route: binding.route,
    });
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
    const requestedAlias =
      route.lockedModelAlias ?? binding.model ?? this.config.get<string>('defaultModel');
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
      await wire.restore();
      await this.bindBootstrap(handle, opts);
      await handle.accessor.get(IAgentToolActivationService).activate();
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: agentId === 'main' ? 'main' : opts.delegator?.kind === 'external' ? 'independent' : 'sub',
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
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    }
    const wire = handle.accessor.get(IWireService);
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = wire.getModel(PermissionModeConfiguredModel);
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
      // Tower workers/reviewers stay pinned to auto (see the file header) —
      // the profile name is read off the wire model, not the profile service,
      // so the broadcast never has to materialize one.
      if (
        handle.accessor.get(IWireService).getModel(ProfileModel).profileName ===
        TOWER_WORKER_PROFILE
      ) {
        continue;
      }
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    this.deferredCreateEvents.delete(agentId);
    await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
    const loop = handle.accessor.get(IAgentLoopService);
    const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
    const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
    const reason = abortError('Agent removed');
    for (const turnId of loop.status().pendingTurnIds) {
      loop.cancel(turnId, reason);
    }
    loop.cancel(undefined, reason);
    if (compaction !== null && !compaction.abortController.signal.aborted) {
      compaction.abortController.abort(reason);
    }
    await Promise.all([loop.settled(), compactionSettled]);
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

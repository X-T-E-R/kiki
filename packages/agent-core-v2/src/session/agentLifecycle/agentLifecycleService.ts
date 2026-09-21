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
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentUsageService } from '#/agent/usage/usage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
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
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type AgentListFilter,
  type AgentRestoreBinding,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';
import { delegatorRef, labelsFromAgentMeta, withSubagentProfile } from './subagentMetadata';
import { resolveDelegationPosition } from '#/agent/profile/delegationContext';

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private nextAgentId = 0;
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
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
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

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    return this.createInternal(opts);
  }

  private async createInternal(input: CreateAgentOptions): Promise<IAgentScopeHandle> {
    let opts = input;
    if (opts.agentId !== undefined && opts.restoreBinding !== undefined) {
      const meta = (await this.sessionMetadata.read()).agents?.[opts.agentId];
      if (meta === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${opts.agentId}" does not exist`, {
          details: { agentId: opts.agentId },
        });
      }
      this.validateRestoreBindingInput(opts.agentId, opts.restoreBinding);
      opts = {
        ...opts,
        forkedFrom: opts.forkedFrom ?? meta.forkedFrom,
        labels: opts.labels ?? labelsFromAgentMeta(meta),
        delegator: opts.delegator ?? delegatorRef(meta),
        userLabel: opts.userLabel ?? meta.userLabel,
      };
    }
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) {
        const handle = await inflight;
        if (opts.restoreBinding !== undefined) {
          await this.validateRestoredBinding(handle, opts.restoreBinding);
        }
        return handle;
      }
      const removal = this.removing.get(opts.agentId);
      if (removal !== undefined) {
        await removal.catch(() => undefined);
        return this.createInternal(opts);
      }
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) {
        const profile = existing.accessor.get(IAgentProfileService);
        const persisted = profile.data();
        const validation =
          opts.binding === undefined
            ? undefined
            : profile.validateBinding({
                modelAlias: opts.binding.model,
                thinkingEffort: opts.binding.thinking,
              });
        if (validation !== undefined && !validation.ok) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, validation.diagnostic);
        }
        if (opts.binding !== undefined && opts.binding.route !== persisted.routeId) {
          throw new Error2(
            ErrorCodes.ROUTE_SWITCH_FORBIDDEN,
            `Agent "${opts.agentId}" is bound to route "${persisted.routeId ?? 'base'}" and cannot switch to "${opts.binding.route}"`,
          );
        }
        if (opts.restoreBinding !== undefined) {
          await this.validateRestoredBinding(existing, opts.restoreBinding);
        }
        return existing;
      }
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
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
    for (;;) {
      const candidate = Math.max(maxSuffix + 1, this.nextAgentId);
      this.nextAgentId = candidate + 1;
      const agentId = `agent-${String(candidate)}`;
      const wireSize = await this.storage.size(this.ctx.scope(`agents/${agentId}`), AGENT_WIRE_RECORD_KEY);
      if (wireSize === undefined) return agentId;
    }
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    let priorAgentMeta: AgentMeta | undefined;
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const parentAgentId =
      agentId === 'main'
        ? undefined
        : opts.delegator?.kind === 'external'
          ? undefined
          : opts.delegator?.kind === 'agent'
            ? opts.delegator.agentId
            : 'main';
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Agent,
      agentId,
      {
        seeds: [
          [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope, parentAgentId })],
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
      if (opts.restoreBinding !== undefined) {
        await this.validateRestoredBinding(handle, opts.restoreBinding);
      }
      const profile = handle.accessor.get(IAgentProfileService).data();
      if ((profile.executorId ?? 'native') === 'native') {
        await handle.accessor.get(IAgentToolActivationService).activate();
      }
      const delegationPosition = resolveDelegationPosition(agentId, opts.delegator);
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: delegationPosition,
        parentAgentId,
        delegator: opts.delegator,
        forkedFrom: opts.forkedFrom,
        labels: withSubagentProfile(
          opts.labels,
          delegationPosition === 'main' ? undefined : profile.profileName,
        ),
        displayName: priorAgentMeta?.displayName ?? profile.routeId ?? profile.profileName,
        userLabel: opts.userLabel ?? priorAgentMeta?.userLabel,
        model: profile.modelAlias,
        thinkingEffort: profile.effectiveThinkingLevel ?? profile.thinkingLevel,
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
    const profile = handle.accessor.get(IAgentProfileService);
    if (opts.binding !== undefined) {
      await profile.bind({
        ...opts.binding,
        delegationPosition: resolveDelegationPosition(handle.id, opts.delegator),
      });
    } else if (
      opts.restoreBinding !== undefined &&
      profile.data().profileName === undefined &&
      profile.data().routeId === undefined
    ) {
      await profile.bind({
        profile: opts.restoreBinding.profileName,
        route: opts.restoreBinding.routeId,
        model: opts.restoreBinding.modelAlias,
        thinking: opts.restoreBinding.thinkingEffort,
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

  private validateRestoreBindingInput(agentId: string, binding: AgentRestoreBinding): void {
    const required: readonly [keyof AgentRestoreBinding, string | undefined][] = [
      ['modelAlias', binding.modelAlias],
      ['thinkingEffort', binding.thinkingEffort],
      ['executorId', binding.executorId],
      ['executorProtocol', binding.executorProtocol],
    ];
    const missingFields: string[] = required
      .filter(([, value]) => value === undefined || value.length === 0)
      .map(([field]) => field);
    if (
      (binding.profileName === undefined || binding.profileName.length === 0) &&
      (binding.routeId === undefined || binding.routeId.length === 0)
    ) {
      missingFields.unshift('profileNameOrRouteId');
    }
    if (missingFields.length === 0) return;
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Persisted binding metadata for agent "${agentId}" is incomplete: ${missingFields.join(', ')}`,
      { details: { agentId, missingFields } },
    );
  }

  private async validateRestoredBinding(
    handle: IAgentScopeHandle,
    binding: AgentRestoreBinding,
  ): Promise<void> {
    const profile = handle.accessor.get(IAgentProfileService);
    const data = profile.data();
    const actual: AgentRestoreBinding = {
      profileName: data.profileName,
      routeId: data.routeId,
      modelAlias: data.modelAlias,
      thinkingEffort: data.thinkingLevel,
      executorId: data.executorId,
      executorProtocol: data.executorProtocol,
    };
    const mismatches = (Object.keys(binding) as (keyof AgentRestoreBinding)[])
      .filter((field) => binding[field] !== undefined && binding[field] !== actual[field])
      .map((field) => ({ field, expected: binding[field], actual: actual[field] }));
    if (mismatches.length > 0) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Restored binding for agent "${handle.id}" does not match its persisted snapshot`,
        { details: { agentId: handle.id, mismatches } },
      );
    }
    const executor = await handle.accessor
      .get(IAgentExecutorRegistry)
      .resolveExecutable(data.executorId, data.executorOptions);
    if (executor.descriptor.protocol !== data.executorProtocol) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Restored executor protocol for agent "${handle.id}" is unavailable`,
        {
          details: {
            agentId: handle.id,
            executorId: data.executorId,
            expectedProtocol: data.executorProtocol,
            actualProtocol: executor.descriptor.protocol,
          },
        },
      );
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
      labels:
        overrideBinding === undefined
          ? withSubagentProfile(undefined, sourceData.profileName)
          : undefined,
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
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  countPendingBackgroundTasks(): number {
    let count = 0;
    for (const handle of this.handles.values()) {
      count += handle.accessor.get(IAgentTaskService).list(true).length;
    }
    return count;
  }

  async drainBackgroundTasks(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Background drain timeout must be positive and finite');
    }
    const deadline = Date.now() + timeoutMs;
    const seen = new Set<string>();
    while (Date.now() < deadline) {
      const batch: Promise<unknown>[] = [];
      const suppressions: Promise<void>[] = [];
      let activeCount = 0;
      for (const handle of this.handles.values()) {
        const tasks = handle.accessor.get(IAgentTaskService);
        for (const task of tasks.list(true)) {
          activeCount++;
          const key = `${handle.id}/${task.taskId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          suppressions.push(tasks.suppressTerminalNotification(task.taskId));
          batch.push(tasks.wait(task.taskId, Math.max(1, deadline - Date.now())));
        }
      }
      await Promise.all([...suppressions, ...batch]);
      if (activeCount === 0 || batch.length === 0) break;
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

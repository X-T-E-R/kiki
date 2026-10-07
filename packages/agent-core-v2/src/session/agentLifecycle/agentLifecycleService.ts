import { randomUUID } from 'node:crypto';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { Emitter } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { Error2, ErrorCodes, isError2 } from '#/errors';
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
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from '#/app/memory/configSection';
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
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentRuntimeBindingSeed, IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import '#/agent/runtimeBinding/runtimeBindingService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentMediaToolsRegistrar } from '#/agent/media/mediaTools';
import { IAgentPluginToolService } from '#/agent/userTool/pluginToolService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { interactionKey } from '#/session/interaction/interactionOps';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type AgentCallerOutcome,
  type AgentCleanupOutcome,
  type AgentCleanupReceipt,
  type AgentFailureDomain,
  type AgentListFilter,
  type AgentRemovalMode,
  type AgentRestoreBinding,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
} from './agentLifecycle';
import { delegatorRef, labelsFromAgentMeta, withSubagentProfile } from './subagentMetadata';
import { resolveDelegationPosition } from '#/agent/profile/delegationContext';

interface AgentCreation {
  generation: number;
  pending: Promise<IAgentScopeHandle>;
}

interface AgentSlot {
  generation: number;
  handle: IAgentScopeHandle | undefined;
  creating: AgentCreation | undefined;
  removing: Promise<void> | undefined;
  deferredCreateEvent: boolean;
}

export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private nextAgentId = 0;
  private readonly slots = new Map<string, AgentSlot>();
  private readonly onWillCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly onDidCleanupEmitter = this._register(new Emitter<AgentCleanupReceipt>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly usageDisposables = new Map<string, IDisposable>();

  get onWillCreate() {
    return this.onWillCreateEmitter.event;
  }
  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }
  get onDidCleanup() {
    return this.onDidCleanupEmitter.event;
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
        for (const interaction of this.interaction.listPending(undefined, { agentId })) {
          this.interaction.respond(interaction.id, { cancelled: true, reason: 'agent_closed' });
        }
        for (const disposables of [this.interactionBusDisposables, this.usageDisposables]) {
          const result = disposables.get(agentId)?.dispose();
          if (isPromiseLike(result)) result.catch(onUnexpectedError);
          disposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const disposables of [this.interactionBusDisposables, this.usageDisposables]) {
          for (const d of disposables.values()) {
            const result = d.dispose();
            if (isPromiseLike(result)) result.catch(onUnexpectedError);
          }
          disposables.clear();
        }
      },
    });
  }

  private slotOf(agentId: string): AgentSlot {
    const existing = this.slots.get(agentId);
    if (existing !== undefined) return existing;
    const slot: AgentSlot = {
      generation: 0,
      handle: undefined,
      creating: undefined,
      removing: undefined,
      deferredCreateEvent: false,
    };
    this.slots.set(agentId, slot);
    return slot;
  }

  private releaseSlot(agentId: string, slot: AgentSlot): void {
    if (
      slot.handle !== undefined ||
      slot.creating !== undefined ||
      slot.removing !== undefined
    ) {
      return;
    }
    if (this.slots.get(agentId) === slot) this.slots.delete(agentId);
  }

  private liveHandles(): IAgentScopeHandle[] {
    const handles: IAgentScopeHandle[] = [];
    for (const slot of this.slots.values()) {
      if (slot.handle !== undefined) handles.push(slot.handle);
    }
    return handles;
  }

  private isOccupied(agentId: string): boolean {
    const slot = this.slots.get(agentId);
    return (
      slot !== undefined &&
      (slot.handle !== undefined || slot.creating !== undefined || slot.removing !== undefined)
    );
  }

  private pendingCreate(agentId: string): AgentCreation | undefined {
    const slot = this.slots.get(agentId);
    if (slot === undefined || slot.removing !== undefined) return undefined;
    const creating = slot.creating;
    if (creating === undefined || creating.generation !== slot.generation) return undefined;
    return creating;
  }

  private assertCreateStillCurrent(agentId: string, slot: AgentSlot, generation: number): void {
    if (this.slots.get(agentId) === slot && slot.generation === generation) return;
    throw new Error2(
      ErrorCodes.AGENT_REMOVED,
      `Agent "${agentId}" was removed before its creation completed`,
      { details: { agentId } },
    );
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const d = handle.accessor
      .get(IEventBus)
      .subscribe(TurnEnded, (e) => this.interaction.cancelPendingForTurn(e.turnId, handle.id));
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
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    for (;;) {
      const slot = this.slots.get(agentId);
      if (slot === undefined) return this.startCreate(agentId, opts);
      if (slot.removing !== undefined) {
        await slot.removing.catch(() => undefined);
        continue;
      }
      const creating = this.pendingCreate(agentId);
      if (creating !== undefined) {
        const handle = await creating.pending;
        if (opts.restoreBinding !== undefined) {
          await this.validateRestoredBinding(handle, opts.restoreBinding);
        }
        return handle;
      }
      if (slot.creating !== undefined) {
        await slot.creating.pending.then(() => undefined, () => undefined);
        continue;
      }
      if (slot.handle !== undefined) return this.reuseExisting(agentId, slot.handle, opts);
      return this.startCreate(agentId, opts);
    }
  }

  private async reuseExisting(
    agentId: string,
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<IAgentScopeHandle> {
    const profile = handle.accessor.get(IAgentProfileService);
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
        `Agent "${agentId}" is bound to route "${persisted.routeId ?? 'base'}" and cannot switch to "${opts.binding.route}"`,
      );
    }
    if (opts.restoreBinding !== undefined) {
      await this.validateRestoredBinding(handle, opts.restoreBinding);
    }
    return handle;
  }

  private startCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const slot = this.slotOf(agentId);
    const generation = slot.generation + 1;
    slot.generation = generation;
    const pending = this.doCreate(agentId, opts, slot, generation);
    slot.creating = { generation, pending };
    const settled = (): void => {
      if (slot.creating?.pending === pending) slot.creating = undefined;
      this.releaseSlot(agentId, slot);
    };
    void pending.then(settled, settled);
    return pending;
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const [agentId, slot] of this.slots) {
      if (slot.handle !== undefined || slot.creating !== undefined) consider(agentId);
    }
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

  private async doCreate(
    agentId: string,
    opts: CreateAgentOptions,
    slot: AgentSlot,
    generation: number,
  ): Promise<IAgentScopeHandle> {
    const creationTime = Date.now();
    let createdAt: number | undefined;
    let priorAgentMeta: AgentMeta | undefined;
    let appliedAgentMeta: AgentMeta | undefined;
    let bootstrapBinding: AgentMeta | undefined;
    const appliedLabels: Record<string, string> = {};
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const parentAgentId =
      agentId === 'main'
        ? undefined
        : opts.delegator?.kind === 'external'
          ? this.get('main')?.accessor.get(IAgentProfileService).data().allowKikiSubagents === true ? 'main' : undefined
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
    try {
      priorAgentMeta = (await this.sessionMetadata.read()).agents?.[agentId];
      if (priorAgentMeta === undefined && opts.restoreBinding === undefined &&
        (opts.copiedIdentity === true || await this.storage.size(agentScope, AGENT_WIRE_RECORD_KEY) === undefined)) {
        createdAt = creationTime;
      }
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      await wire.beginTranscriptEpoch?.();
      handle.accessor.get(IAgentStateService).contributeState(interactionKey);
      this.subscribeInteractionBus(handle);
      this.subscribeUsage(handle);
      this.onWillCreateEmitter.fire(handle);
      await handle.accessor.get(IEventDispatcher).restore();
      const beforeBinding = handle.accessor.get(IAgentProfileService).data();
      const writesBinding = opts.binding !== undefined || (opts.restoreBinding !== undefined &&
        beforeBinding.execution === undefined && beforeBinding.profileName === undefined && beforeBinding.routeId === undefined);
      const restoreFellBack = await this.bindBootstrap(handle, opts);
      const binding = handle.accessor.get(IAgentProfileService).data();
      if (writesBinding) bootstrapBinding = { execution: binding.execution, model: binding.modelAlias, thinkingEffort: binding.thinkingLevel,
        executor: binding.executorId ?? 'native', executorProtocol: binding.executorProtocol,
        negotiated: priorAgentMeta?.executor === binding.executorId ? priorAgentMeta?.negotiated : undefined,
        allowKikiSubagents: binding.allowKikiSubagents };
      if (opts.restoreBinding !== undefined) {
        await this.validateRestoredBinding(handle, opts.restoreBinding, restoreFellBack);
      }
      const profile = handle.accessor.get(IAgentProfileService).data();
      if ((profile.executorId ?? 'native') === 'native') {
        handle.accessor.get(IAgentMediaToolsRegistrar).refresh();
        await handle.accessor.get(IAgentToolActivationService).activate();
        await handle.accessor.get(IAgentPluginToolService).ready();
      }
      const delegationPosition = resolveDelegationPosition(agentId, opts.delegator);
      this.assertCreateStillCurrent(agentId, slot, generation);
      const requestedLabels = withSubagentProfile(opts.labels, delegationPosition === 'main' ? undefined : profile.profileName);
      const applyIdentity = (current: AgentMeta): AgentMeta => {
        const labels = { ...current.labels };
        for (const [key, value] of Object.entries(requestedLabels ?? {})) {
          if (key === 'profileName' || value !== priorAgentMeta?.labels?.[key] || current.labels?.[key] === priorAgentMeta?.labels?.[key]) {
            labels[key] = value;
            if (current.labels?.[key] !== value) appliedLabels[key] = value;
          }
        }
        appliedAgentMeta = {
          ...current, homedir: agentHomedir, type: delegationPosition, parentAgentId, delegator: opts.delegator,
          forkedFrom: opts.forkedFrom, labels: current.labels === undefined && requestedLabels === undefined ? undefined : labels,
          displayName: current.displayName ?? profile.routeId ?? profile.profileName,
          userLabel: opts.userLabel ?? current.userLabel,
          execution: profile.execution, model: profile.modelAlias, thinkingEffort: profile.effectiveThinkingLevel ?? profile.thinkingLevel,
          executor: profile.executorId ?? 'native', executorProtocol: profile.executorProtocol,
          negotiated: current.executor === profile.executorId ? current.negotiated : undefined,
          allowKikiSubagents: profile.allowKikiSubagents,
        };
        return appliedAgentMeta;
      };
      if (priorAgentMeta === undefined) {
        await this.sessionMetadata.registerAgent(agentId, applyIdentity({ createdAt }));
      } else {
        await this.sessionMetadata.updateAgent(agentId, applyIdentity);
        if (appliedAgentMeta === undefined) throw new Error2(ErrorCodes.AGENT_REMOVED,
          `Agent "${agentId}" was unregistered before its creation completed`, { details: { agentId } });
      }
      this.assertCreateStillCurrent(agentId, slot, generation);
      slot.handle = handle;
      if (opts.deferCreateEvent === true) slot.deferredCreateEvent = true;
      else this.onDidCreateEmitter.fire(handle);
      return handle;
    } catch (error) {
      slot.deferredCreateEvent = false;
      if (slot.handle === handle) slot.handle = undefined;
      if (priorAgentMeta === undefined) {
        await this.sessionMetadata.unregisterAgent?.(agentId).catch(() => {});
      } else if (appliedAgentMeta !== undefined || bootstrapBinding !== undefined) {
        const prior = priorAgentMeta;
        const written = appliedAgentMeta ?? bootstrapBinding!;
        await this.sessionMetadata.updateAgent(agentId, (current) => {
          const next = { ...current };
          const bindingKeys = ['execution', 'model', 'thinkingEffort', 'executor', 'executorProtocol', 'negotiated', 'allowKikiSubagents'] as const;
          const keys = appliedAgentMeta === undefined ? bindingKeys
            : [...bindingKeys, 'homedir', 'type', 'parentAgentId', 'delegator', 'forkedFrom', 'displayName', 'userLabel'] as const;
          for (const key of keys) {
            if (JSON.stringify(current[key]) === JSON.stringify(written[key])) Object.assign(next, { [key]: prior[key] });
          }
          if (Object.keys(appliedLabels).length > 0) {
            const labels = { ...current.labels };
            for (const [key, value] of Object.entries(appliedLabels)) {
              if (labels[key] !== value) continue;
              if (prior.labels?.[key] === undefined) delete labels[key];
              else labels[key] = prior.labels[key]!;
            }
            next.labels = labels;
          }
          return next;
        }).catch(() => {});
      }
      try {
        await handle.dispose();
      } catch { }
      this.onDidDisposeEmitter.fire(agentId);
      throw error;
    }
  }

  commitCreate(agentId: string): void {
    const slot = this.slots.get(agentId);
    if (slot === undefined || !slot.deferredCreateEvent) return;
    slot.deferredCreateEvent = false;
    if (slot.handle !== undefined) this.onDidCreateEmitter.fire(slot.handle);
    this.releaseSlot(agentId, slot);
  }

  async discard(agentId: string): Promise<void> {
    const slot = this.slots.get(agentId);
    if (slot !== undefined) slot.deferredCreateEvent = false;
    await this.remove(agentId);
    await this.sessionMetadata.unregisterAgent?.(agentId);
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<boolean> {
    const profile = handle.accessor.get(IAgentProfileService);
    let restoreFellBack = false;
    if (opts.binding !== undefined) {
      await profile.bind({
        ...opts.binding,
        delegationPosition: resolveDelegationPosition(handle.id, opts.delegator),
      });
    } else if (
      opts.restoreBinding !== undefined &&
      profile.data().execution === undefined &&
      profile.data().profileName === undefined &&
      profile.data().routeId === undefined
    ) {
      try {
        await profile.bind({
          profile: opts.restoreBinding.profileName,
          route: opts.restoreBinding.routeId,
          model: opts.restoreBinding.modelAlias,
          thinking: opts.restoreBinding.thinkingEffort,
          delegationPosition: resolveDelegationPosition(handle.id, opts.delegator),
        });
      } catch (error) {
        if (
          !isError2(error) ||
          (error.code !== ErrorCodes.PROFILE_UNKNOWN &&
            error.code !== ErrorCodes.ROUTE_UNKNOWN &&
            error.code !== ErrorCodes.ROUTE_BASE_MISSING)
        ) {
          throw error;
        }
        restoreFellBack = true;
        await profile.bind({
          profile: DEFAULT_AGENT_PROFILE_NAME,
          model: opts.restoreBinding.modelAlias,
          thinking: opts.restoreBinding.thinkingEffort,
          delegationPosition: resolveDelegationPosition(handle.id, opts.delegator),
        });
        await handle.accessor.get(IEventDispatcher).dispatch(new WarningIssued({
          code: 'restore-profile-missing',
          message: `Persisted profile "${opts.restoreBinding.profileName ?? opts.restoreBinding.routeId ?? ''}" is unavailable; restored with the default profile instead.`,
        }));
      }
    } else if (
      opts.restoreBinding !== undefined &&
      handle.id === 'main' &&
      memoryEnabled(this.config.get<MemoryConfig>(MEMORY_SECTION), this.ctx.workspaceId)
    ) {
      await profile.refreshMemorySnapshot();
    }
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = handle.accessor
      .get(IAgentStateService)
      .get(permissionModeConfiguredKey);
    const permissionModeService = handle.accessor.get(IAgentPermissionModeService);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      permissionModeService.setMode(permissionMode);
    }
    const profilePermissionMode = profile.data().permissionMode;
    if (profilePermissionMode !== undefined && !hasRestoredPermissionMode) {
      permissionModeService.setMode(profilePermissionMode);
    }
    return restoreFellBack;
  }

  private validateRestoreBindingInput(agentId: string, binding: AgentRestoreBinding): void {
    const required: readonly (readonly [keyof AgentRestoreBinding, string | undefined])[] = [
      ...(binding.executorId === undefined || binding.executorId === 'native'
        ? [['modelAlias', binding.modelAlias] as const] : []),
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
    restoreFellBack = false,
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
      .filter((field) => !(restoreFellBack && (field === 'profileName' || field === 'routeId')))
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
    const source = this.slots.get(sourceAgentId)?.handle;
    if (source === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Source agent "${sourceAgentId}" does not exist`, {
        details: { agentId: sourceAgentId },
      });
    }
    if (opts?.agentId !== undefined && this.isOccupied(opts.agentId)) {
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
    return this.slots.get(agentId)?.handle;
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = this.liveHandles();
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.liveHandles()) {
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  countPendingBackgroundTasks(): number {
    let count = 0;
    for (const handle of this.liveHandles()) {
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
      for (const handle of this.liveHandles()) {
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

  async remove(agentId: string, mode: AgentRemovalMode = 'cancel'): Promise<void> {
    const slot = this.slots.get(agentId);
    if (slot === undefined) return;
    if (slot.removing !== undefined) return slot.removing;
    slot.generation += 1;
    slot.deferredCreateEvent = false;
    const handle = slot.handle;
    const creating = slot.creating?.pending;
    slot.handle = undefined;
    const removal = this.finishRemoval(agentId, handle, creating, mode).finally(() => {
      if (slot.removing === removal) slot.removing = undefined;
      this.releaseSlot(agentId, slot);
    });
    slot.removing = removal;
    return removal;
  }

  private async finishRemoval(
    agentId: string,
    handle: IAgentScopeHandle | undefined,
    creating: Promise<IAgentScopeHandle> | undefined,
    mode: AgentRemovalMode,
  ): Promise<void> {
    if (creating !== undefined) await creating.then(() => undefined, () => undefined);
    if (handle === undefined) return;
    await this.doRemove(agentId, handle, mode);
  }

  private async doRemove(agentId: string, handle: IAgentScopeHandle, mode: AgentRemovalMode): Promise<void> {
    const operationId = randomUUID();
    let callerOutcome: AgentCallerOutcome = 'rejected';
    let cleanupOutcome: AgentCleanupOutcome = 'cleanup_failed';
    let failureDomain: AgentFailureDomain | undefined;
    let disposed = false;
    const failures: Array<{ readonly error: unknown; readonly domain: AgentFailureDomain }> = [];
    const collect = async (
      operation: () => unknown | Promise<unknown>,
      domain: AgentFailureDomain,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push({ error, domain });
      }
    };
    try {
      await collect(() => handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed'), 'cleanup');
      const reason = abortError('Agent removed');
      let execution: IAgentExecutionService | undefined;
      let loop: IAgentLoopService | undefined;
      let compaction: IAgentFullCompactionService['compacting'] | null | undefined;
      let promptDrain: Promise<void> | undefined;
      try {
        execution = handle.accessor.get(IAgentExecutionService);
      } catch (error) {
        failures.push({ error, domain: 'cleanup' });
      }
      try {
        compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
      } catch (error) {
        failures.push({ error, domain: 'cleanup' });
      }
      try {
        loop = handle.accessor.get(IAgentLoopService);
      } catch (error) {
        failures.push({ error, domain: 'cleanup' });
      }
      if (execution !== undefined) await collect(() => execution!.cancel(reason), 'cleanup');
      if (loop !== undefined) {
        let pendingTurnIds: readonly number[] = [];
        try {
          pendingTurnIds = loop.status().pendingTurnIds;
        } catch (error) {
          failures.push({ error, domain: 'cleanup' });
        }
        for (const turnId of pendingTurnIds) await collect(() => loop!.cancel(turnId, reason), 'cleanup');
        await collect(() => loop!.cancel(undefined, reason), 'cleanup');
      }
      try {
        promptDrain = handle.accessor.get(IAgentPromptService).drain(reason, mode);
      } catch (error) {
        failures.push({ error, domain: 'cleanup' });
      }
      if (compaction !== null && compaction !== undefined && !compaction.abortController.signal.aborted) {
        await collect(() => compaction!.abortController.abort(reason), 'cleanup');
      }
      if (execution !== undefined) await collect(() => execution!.shutdown(reason), 'cleanup');
      if (compaction?.promise !== undefined) await collect(() => compaction!.promise.catch(() => undefined), 'cleanup');
      if (promptDrain !== undefined) await collect(() => promptDrain!, 'cleanup');
      if (loop !== undefined) await collect(() => loop!.settled(), 'cleanup');
      await collect(async () => {
        try {
          await handle.accessor.get(IEventDispatcher).flush();
        } catch (error) {
          onUnexpectedError(error);
          throw error;
        }
      }, 'persistence');
      await collect(async () => {
        try {
          await handle.accessor.get(IWireService).sealTranscriptEpoch?.();
        } catch (error) {
          onUnexpectedError(error);
          throw error;
        }
      }, 'persistence');
      await collect(async () => {
        await handle.dispose();
        disposed = true;
      }, 'cleanup');
      if (disposed) this.onDidDisposeEmitter.fire(agentId);
      if (failures.length > 0) {
        const primary = failures.find((failure) => failure.domain === 'persistence') ?? failures[0]!;
        failureDomain = primary.domain;
        throw primary.error;
      }
      cleanupOutcome = 'closed';
      callerOutcome = 'resolved';
    } catch (error) {
      failureDomain ??= 'cleanup';
      throw error;
    } finally {
      const primary = failures.find((failure) => failure.domain === 'persistence') ?? failures[0];
      const error = primary?.error instanceof Error ? primary.error : undefined;
      const errorCode = error === undefined ? undefined : (error as { readonly code?: unknown }).code;
      this.onDidCleanupEmitter.fire({
        operationId,
        agentId,
        mode,
        callerOutcome,
        terminalOwner: 'agent',
        cleanupOutcome,
        resourcesBefore: 1,
        resourcesAfter: disposed ? 0 : 1,
        ...(failureDomain === undefined ? {} : { failureDomain }),
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
        ...(error === undefined ? {} : { errorName: error.name, errorMessage: error.message }),
        settledAt: Date.now(),
      });
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);

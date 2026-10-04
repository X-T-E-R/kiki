import { IInstantiationService, type ServicesAccessor } from '#/_base/di/instantiation';
import { markAsDisposed, trackDisposable } from '#/_base/di/lifecycle';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService, type ProfileBindingSnapshot } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { assertResearchExecutor } from '#/agent/profile/executionRestriction';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  type AgentExecutionStatus,
  type AgentExecutorAgentContext,
  agentExecutorBindingFingerprint,
  IAgentExecutorRegistry,
  type AgentExecutorSession,
} from '#/app/agentExecutor/agentExecutor';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';

import { IAgentExecutionService, type AgentExecutionRunContext } from './execution';
import { ExecutorHintDelivery, ExecutorSessionUpdated, externalExecutorKey } from './externalExecutorOps';
import { ILocalSessionCatalog } from '#/app/agentExecutor/localSessionCatalog';
import { localSourceFromRef, type LocalExecutorSessionSource } from '#/app/agentExecutor/localSessionRef';
import { IFlagService } from '#/app/flag/flag';
import { LOCAL_SESSION_RESUME_FLAG } from '#/app/agentExecutor/flag';
import { externalPromptHints, externalStateHints, type ExternalPromptHint } from './externalPromptHints';
import { NativeAgentExecutorSession } from './nativeAgentExecutorSession';

interface ActiveRun {
  readonly controller: AbortController;
  readonly unlink: () => void;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  turnId?: number;
}

export class AgentExecutionService implements IAgentExecutionService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<{ onWillRun: AgentExecutionRunContext }, 'onWillRun'>([
    'onWillRun',
  ]);

  private readonly agent: AgentExecutorAgentContext;
  private readonly runs = new Set<ActiveRun>();
  private readonly deliveredHints = new Set<string>();
  private session: AgentExecutorSession | undefined;
  private sessionBindingKey: string | undefined;
  private broken: unknown;
  private cancelling = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    @IAgentStateService states: IAgentStateService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
  ) {
    trackDisposable(this);
    states.contributeState(externalExecutorKey);
    const accessor: ServicesAccessor = {
      get: (id) => instantiation.invokeFunction((services) => services.get(id)),
    };
    this.agent = { id: scope.agentId, accessor };
  }

  async run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle> {
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.INTERNAL, `Agent executor "${this.agent.id}" is shutting down`);
    }
    if (this.broken !== undefined) {
      throw this.broken instanceof Error
        ? this.broken
        : new Error2(ErrorCodes.INTERNAL, `Agent executor "${this.agent.id}" is broken`, { cause: this.broken });
    }
    options.signal.throwIfAborted();
    const release = this.dispatch.reserveExecution(this.agent.id, this.scope.parentAgentId, options.capacityReservation);
    const controller = new AbortController();
    let resolveSettled = (): void => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveRun = {
      controller,
      unlink: linkAbortSignal(options.signal, controller),
      settled,
      resolveSettled: () => { release(); resolveSettled(); },
    };
    this.runs.add(active);
    this.cancelling = false;
    const afterStartCallbacks: Array<() => Promise<void>> = [];
    const runContext: AgentExecutionRunContext = {
      signal: controller.signal,
      request,
      replaceRequest: (replacement) => {
        runContext.request = replacement;
      },
      afterStart: (callback) => {
        afterStartCallbacks.push(callback);
      },
    };
    let hints: ExternalPromptHint[] = [];
    try {
      await this.hooks.onWillRun.run(runContext);
      controller.signal.throwIfAborted();
      const session = await this.resolveSession();
      controller.signal.throwIfAborted();
      let outbound = runContext.request ?? request;
      const binding = this.profile.data();
      const usesContextHooks = binding.kikiContext?.includes('hooks') === true && binding.executorId !== 'grok-acp';
      if ((binding.executorId ?? 'native') !== 'native' && outbound.kind !== 'retry' && !usesContextHooks) {
        await this.agent.accessor.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
        const todos = this.agent.accessor.get(ISessionTodoService);
        hints = [
          ...externalPromptHints(this.agent.accessor.get(IAgentContextMemoryService).get(), this.deliveredHints),
          ...externalStateHints({
            todos: todos.getTodos(this.agent.id),
            notes: todos.getNotes(this.agent.id).notes,
            goal: this.scope.agentId === 'main'
              ? this.agent.accessor.get(IAgentGoalService).getGoal().goal : null,
          }),
        ];
        const deliverable = hints.filter((hint) => hint.text.length > 0);
        if (deliverable.length > 0) outbound = { ...outbound, prompt: [
          ...deliverable.map((hint) => `[Kiki ${hint.origin}]\n${hint.text}`), outbound.prompt,
        ].join('\n\n') };
      }
      const handle = await session.run(outbound, { ...options, signal: controller.signal });
      active.turnId = handle.turn.id;
      void handle.completion.then(() => this.finishRun(active), () => this.finishRun(active));
      for (const hint of hints) {
        const delivered = hint.text.length > 0;
        if (delivered && hint.id !== undefined) this.deliveredHints.add(hint.id);
        void this.agent.accessor.get(IEventDispatcher).dispatch(new ExecutorHintDelivery({
          executorId: this.profile.data().executorId, turnId: handle.turn.id, origin: hint.origin,
          method: delivered ? 'next_turn_preamble' : 'undelivered',
          status: delivered ? 'delivered' : 'undelivered',
        })).catch(() => undefined);
      }
      await Promise.allSettled(afterStartCallbacks.map(async (callback) => { await callback(); }));
      return handle;
    } catch (error) {
      for (const hint of hints) void this.agent.accessor.get(IEventDispatcher).dispatch(new ExecutorHintDelivery({
        executorId: this.profile.data().executorId, origin: hint.origin,
        method: 'undelivered', status: 'undelivered',
      })).catch(() => undefined);
      this.finishRun(active);
      throw error;
    }
  }

  trackPromptRun(completion: Promise<unknown>, signal: AbortSignal): AbortSignal {
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.INTERNAL, `Agent executor "${this.agent.id}" is shutting down`);
    }
    if (this.broken !== undefined) {
      throw this.broken instanceof Error
        ? this.broken
        : new Error2(ErrorCodes.INTERNAL, `Agent executor "${this.agent.id}" is broken`, { cause: this.broken });
    }
    signal.throwIfAborted();
    const release = this.dispatch.reserveTurnExecution(this.agent.id, this.scope.parentAgentId);
    const controller = new AbortController();
    let resolveSettled = (): void => {};
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const loop = this.loop;
    const active: ActiveRun = {
      controller,
      unlink: linkAbortSignal(signal, controller),
      settled,
      resolveSettled: () => { release(); resolveSettled(); },
      get turnId() { return loop.status().activeTurnId; },
    };
    this.runs.add(active);
    this.cancelling = false;
    void completion.then(() => this.finishRun(active), () => this.finishRun(active));
    return controller.signal;
  }

  status(): AgentExecutionStatus {
    if (this.broken !== undefined) return { state: 'broken' };
    if (this.runs.size > 0) {
      const runs = [...this.runs];
      const turnId = runs.find((run) => run.turnId !== undefined)?.turnId;
      if (this.cancelling || runs.every((run) => run.controller.signal.aborted)) {
        return { state: 'cancelling', turnId };
      }
      return turnId === undefined ? { state: 'starting' } : { state: 'running', turnId };
    }
    return this.session?.status() ?? { state: 'idle' };
  }

  steer(message: ContextMessage): Promise<boolean> {
    if (this.status().state !== 'running') return Promise.resolve(false);
    return this.session?.steer?.(message) ?? Promise.resolve(false);
  }

  cancel(reason?: unknown): boolean {
    let cancelled = false;
    if (this.runs.size > 0) this.cancelling = true;
    for (const run of this.runs) {
      if (!run.controller.signal.aborted) {
        run.controller.abort(reason);
        cancelled = true;
      }
    }
    return this.session?.cancel(reason) === true || cancelled;
  }

  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.runs].map((run) => run.settled);
      if (pending.length === 0) break;
      await Promise.all(pending);
    }
    await this.session?.settled();
  }

  shutdown(reason?: unknown): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownSession(reason);
    return this.shutdownPromise;
  }

  async dispose(): Promise<void> {
    try {
      await this.shutdown(new Error('Agent execution service disposed'));
    } finally {
      markAsDisposed(this);
    }
  }

  private async shutdownSession(reason?: unknown): Promise<void> {
    this.cancel(reason);
    const session = this.session;
    await Promise.all([this.settled(), session?.shutdown(reason)]);
    if (this.session !== session) await this.session?.shutdown(reason);
    this.session = undefined;
    this.sessionBindingKey = undefined;
  }

  async attachLocalSession(source: LocalExecutorSessionSource): Promise<void> {
    if (!this.agent.accessor.get(IFlagService).enabled(LOCAL_SESSION_RESUME_FLAG)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Local session continuation is disabled');
    }
    if (this.session !== undefined || this.runs.size > 0 || this.shuttingDown) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Local session attachment requires a new idle agent');
    }
    await this.profile.preparePromptConfiguration();
    const binding = this.profile.data();
    const state = this.agent.accessor.get(IAgentStateService).get(externalExecutorKey);
    if (state.sessionRef !== undefined || binding.executorId !== source.executorId) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Local session does not match the bound executor');
    }
    const catalog = this.agent.accessor.get(ILocalSessionCatalog);
    const detail = await catalog.get(source.executorId, source.localId);
    if (detail === undefined || !detail.summary.resume.supported || detail.summary.externalId !== source.externalId ||
        detail.summary.engine !== source.engine || detail.summary.sourceHome !== source.home) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Local session source is unavailable or cannot be resumed');
    }
    await this.agent.accessor.get(IEventDispatcher).dispatch(new ExecutorSessionUpdated({
      executorId: source.executorId,
      descriptorRevision: binding.executorDescriptorRevision!,
      bindingFingerprint: agentExecutorBindingFingerprint(binding),
      sessionEpoch: 1,
      sessionRef: { executorId: source.executorId, version: 1, ref: {
        [binding.executorProtocol === 'codex-app-server' ? 'threadId' : 'sessionId']: source.externalId,
        localSource: source,
      } },
    }));
  }

  private async resolveSession(): Promise<AgentExecutorSession> {
    await this.profile.preparePromptConfiguration();
    const data = this.profile.data();
    const executorId = data.executorId ?? 'native';
    const prior = this.agent.accessor.get(IAgentStateService).get(externalExecutorKey);
    const source = localSourceFromRef(prior.sessionRef?.ref);
    if (source !== undefined && (source.executorId !== executorId ||
        prior.bindingFingerprint !== agentExecutorBindingFingerprint(data) ||
        source.home !== await this.agent.accessor.get(ILocalSessionCatalog).sourceHome(executorId))) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Imported local session executor binding fingerprint or source home changed');
    }
    const binding = { ...data, systemPrompt: executorId === 'native'
      ? this.profile.getSystemPrompt() : data.systemPrompt };
    assertResearchExecutor(binding.executionRestriction, executorId);
    const modeKey = this.executors.get?.(executorId)?.permission?.via === 'argv'
      ? `:${this.agent.accessor.get(IAgentPermissionModeService).mode}` : '';
    const bindingKey = executorId === 'native' ? 'native'
      : `${agentExecutorBindingFingerprint(binding)}${modeKey}`;
    if (this.session !== undefined && this.sessionBindingKey !== bindingKey) {
      const status = this.session.status();
      if (status.state !== 'idle') {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Agent executor binding cannot change while the executor session is ${status.state}`,
        );
      }
      await this.session.settled();
      await this.session.shutdown(new Error('Agent executor binding changed'));
      this.session = undefined;
      this.sessionBindingKey = undefined;
    }
    if (this.session !== undefined) {
      if (this.session.status().state !== 'idle' && executorId !== 'native') {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'External executor binding cannot change during a turn');
      }
      this.session.updateBinding?.(binding);
      return this.session;
    }
    try {
      if (executorId === 'native') {
        this.session = new NativeAgentExecutorSession(this.agent, this.loop, this.prompt);
      } else {
        this.session = await this.createExternalSession(binding, executorId);
      }
      this.sessionBindingKey = bindingKey;
      return this.session;
    } catch (error) {
      this.broken = error;
      throw error;
    }
  }

  private async createExternalSession(
    binding: ProfileBindingSnapshot,
    executorId: string,
  ): Promise<AgentExecutorSession> {
    const resolved = await this.executors.resolveExecutable(executorId, binding.executorOptions);
    if (this.shuttingDown) {
      throw new Error2(ErrorCodes.INTERNAL, `Agent executor "${this.agent.id}" is shutting down`);
    }
    if (binding.executorProtocol !== resolved.descriptor.protocol) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        binding.executorProtocol === undefined
          ? `Executor protocol for "${executorId}" is missing from the bound agent profile`
          : `Executor protocol for "${executorId}" changed after the agent profile was bound`,
      );
    }
    if (binding.executorDescriptorRevision !== resolved.descriptor.revision) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        binding.executorDescriptorRevision === undefined
          ? `Executor descriptor revision for "${executorId}" is missing from the bound agent profile`
          : `Executor descriptor for "${executorId}" changed after the agent profile was bound`,
      );
    }
    if (resolved.provider === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `External executor "${executorId}" is unsupported because protocol "${resolved.descriptor.protocol}" has no registered provider`,
      );
    }
    return resolved.provider.create({
      agent: this.agent,
      descriptor: resolved.descriptor,
      binding,
    });
  }

  private finishRun(active: ActiveRun): void {
    if (!this.runs.delete(active)) return;
    active.unlink();
    active.resolveSettled();
    if (this.runs.size === 0) this.cancelling = false;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentExecutionService,
  AgentExecutionService,
  ScopeActivation.OnScopeCreated,
  'agentExecution',
);

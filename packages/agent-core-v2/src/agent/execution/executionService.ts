import { IInstantiationService, type ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService, type ProfileBindingSnapshot } from '#/agent/profile/profile';
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
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';

import { IAgentExecutionService, type AgentExecutionRunContext } from './execution';
import { externalExecutorKey } from './externalExecutorOps';
import { NativeAgentExecutorSession } from './nativeAgentExecutorSession';

interface ActiveRun {
  readonly controller: AbortController;
  readonly unlink: () => void;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  turnId?: number;
}

export class AgentExecutionService extends Disposable implements IAgentExecutionService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<{ onWillRun: AgentExecutionRunContext }, 'onWillRun'>([
    'onWillRun',
  ]);

  private readonly agent: AgentExecutorAgentContext;
  private readonly runs = new Set<ActiveRun>();
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
    super();
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
    if (this.broken !== undefined) throw this.broken;
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
    try {
      await this.hooks.onWillRun.run(runContext);
      controller.signal.throwIfAborted();
      const session = await this.resolveSession();
      controller.signal.throwIfAborted();
      const handle = await session.run(runContext.request ?? request, {
        ...options,
        signal: controller.signal,
      });
      active.turnId = handle.turn.id;
      void handle.completion.then(
        () => this.finishRun(active),
        () => this.finishRun(active),
      );
      await Promise.allSettled(
        afterStartCallbacks.map(async (callback) => {
          await callback();
        }),
      );
      return handle;
    } catch (error) {
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
    return this.session instanceof NativeAgentExecutorSession
      ? this.session.steer(message)
      : Promise.resolve(false);
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

  override async dispose(): Promise<void> {
    try {
      await this.shutdown(new Error('Agent execution service disposed'));
    } finally {
      super.dispose();
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

  private async resolveSession(): Promise<AgentExecutorSession> {
    await this.profile.preparePromptConfiguration();
    const binding = { ...this.profile.data(), systemPrompt: this.profile.getSystemPrompt() };
    const executorId = binding.executorId ?? 'native';
    assertResearchExecutor(binding.executionRestriction, executorId);
    const bindingKey =
      executorId === 'native' ? 'native' : agentExecutorBindingFingerprint(binding);
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
    if (this.session !== undefined) return this.session;
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

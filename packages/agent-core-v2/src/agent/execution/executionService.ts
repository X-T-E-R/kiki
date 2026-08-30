import { IInstantiationService, type ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import {
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { linkAbortSignal } from '#/_base/utils/abort';
import { IAgentProfileService, type ProfileBindingSnapshot } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import {
  type AgentExecutionStatus,
  type AgentExecutorAgentContext,
  IAgentExecutorRegistry,
  type AgentExecutorSession,
} from '#/app/agentExecutor/agentExecutor';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { createHooks } from '#/hooks';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';

import { IAgentExecutionService } from './execution';
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

  readonly hooks = createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>([
    'onWillRun',
  ]);

  private readonly agent: AgentExecutorAgentContext;
  private readonly runs = new Set<ActiveRun>();
  private session: AgentExecutorSession | undefined;
  private sessionExecutorId: string | undefined;
  private broken: unknown;
  private cancelling = false;
  private shuttingDown = false;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentScopeContext scope: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    @IAgentStateService states: IAgentStateService,
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
    const controller = new AbortController();
    let resolveSettled = (): void => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveRun = {
      controller,
      unlink: linkAbortSignal(options.signal, controller),
      settled,
      resolveSettled,
    };
    this.runs.add(active);
    this.cancelling = false;
    try {
      await this.hooks.onWillRun.run({ signal: controller.signal });
      controller.signal.throwIfAborted();
      const session = this.resolveSession();
      const handle = await session.run(request, {
        ...options,
        signal: controller.signal,
      });
      active.turnId = handle.turn.id;
      void handle.completion.then(
        () => this.finishRun(active),
        () => this.finishRun(active),
      );
      return handle;
    } catch (error) {
      this.finishRun(active);
      throw error;
    }
  }

  status(): AgentExecutionStatus {
    if (this.broken !== undefined) return { state: 'broken' };
    if (this.runs.size > 0) {
      const turnId = [...this.runs].find((run) => run.turnId !== undefined)?.turnId;
      if (this.cancelling) return { state: 'cancelling', turnId };
      return turnId === undefined ? { state: 'starting' } : { state: 'running', turnId };
    }
    return this.session?.status() ?? { state: 'idle' };
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

  async shutdown(reason?: unknown): Promise<void> {
    if (this.shuttingDown) {
      await this.settled();
      return;
    }
    this.shuttingDown = true;
    this.cancel(reason);
    await Promise.all([
      this.settled(),
      this.session?.shutdown(reason),
    ]);
  }

  override dispose(): void {
    this.cancel(new Error('Agent execution service disposed'));
    super.dispose();
  }

  private resolveSession(): AgentExecutorSession {
    const binding = this.profile.data();
    const executorId = binding.executorId ?? 'native';
    if (this.session !== undefined) {
      if (this.sessionExecutorId !== executorId) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Agent executor binding changed from "${this.sessionExecutorId}" to "${executorId}" after execution started`,
        );
      }
      return this.session;
    }
    try {
      if (executorId === 'native') {
        this.session = new NativeAgentExecutorSession(this.agent);
      } else {
        this.session = this.createExternalSession(binding, executorId);
      }
      this.sessionExecutorId = executorId;
      return this.session;
    } catch (error) {
      this.broken = error;
      throw error;
    }
  }

  private createExternalSession(
    binding: ProfileBindingSnapshot,
    executorId: string,
  ): AgentExecutorSession {
    const resolved = this.executors.resolve(executorId, binding.executorOptions);
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

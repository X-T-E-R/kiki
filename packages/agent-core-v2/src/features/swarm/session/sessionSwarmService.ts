/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { TokenUsage } from '#/kosong/contract/usage';
import { Error2, ErrorCodes } from '#/errors';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event2 } from '#/app/event/event2';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  ISessionDispatchService,
  type DispatchRun,
} from '#/session/dispatch/dispatch';

import { ISwarmConcurrencyRegistry } from '../swarmConcurrencyRegistry';
import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  AgentRunBatch,
  type AgentRunAttemptOptions,
  type AgentSpawnAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunAttemptHandle,
} from './agentRunBatch';

export interface SubagentSuspendedPayload {
  readonly subagentId: string;
  readonly reason: string;
}

export class SubagentSuspended extends Event2<SubagentSuspendedPayload> {
  static override readonly type = 'subagent.suspended';
  static override readonly observable = true;
}
export interface SubagentSuspended extends SubagentSuspendedPayload {}

const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @ISwarmConcurrencyRegistry
    private readonly concurrencyRegistry: ISwarmConcurrencyRegistry,
  ) {}

  async getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined> {
    const meta = await this.agentMeta(args.agentId);
    if (!isSubagentMeta(meta)) return undefined;
    if (subagentParentAgentId(meta) !== args.callerAgentId) return undefined;
    return subagentSwarmItem(meta);
  }

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    const { callerAgentId, tasks } = args;
    const controller = new AbortController();
    this.inFlight.set(callerAgentId, controller);
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.get(callerAgentId);
        void caller?.accessor.get(IEventDispatcher)?.dispatch(
          new SubagentSuspended({
            subagentId: event.agentId,
            reason: event.reason,
          }),
        );
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, {
      maxConcurrency,
      concurrencyRegistry: this.concurrencyRegistry,
    }).run();
    void promise.finally(() => {
      for (const unlink of unlinks) unlink();
      if (this.inFlight.get(callerAgentId) === controller) this.inFlight.delete(callerAgentId);
    });
    return promise;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    this.inFlight.get(callerAgentId)?.abort();
  }

  private async spawnAttempt(
    callerAgentId: string,
    options: AgentSpawnAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const callerRuntime = caller.accessor.get(IAgentRuntimeBindingService).current;
    const lease = this.runtimeResolver.acquire(callerRuntime, ['process']);
    let run: DispatchRun;
    try {
      const view = new RuntimeWorkspaceView(lease.runtime, { workDir: this.sessionContext.cwd });
      run = await this.dispatch.launch({
        delegator: { kind: 'agent', agentId: callerAgentId },
        requesterAgentId: callerAgentId,
        profileName: options.profileName,
        routeId: options.routeId,
        snapshot: options.catalogSnapshot,
        message: options.prompt,
        resolvedBinding: options.binding,
        runtime: lease.runtime,
        runtimeId: callerRuntime.runtimeId,
        workDir: view.workDir,
        signal: options.signal,
        onReady: options.onReady,
        userLabel: options.swarmItem ?? options.description,
        swarmItem: options.swarmItem,
        parentTurnId: options.parentTurnId,
      });
    } finally {
      lease.dispose();
    }
    emitAgentRunSpawned(caller, run.child.agentId, {
      profileName: run.child.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      userLabel: options.swarmItem ?? options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      model: run.child.modelAlias,
    });
    return this.observe(caller, run, options);
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = await this.dispatch.resolveOwnedChild(
      { kind: 'agent', agentId: callerAgentId },
      agentId,
    );
    const run = await this.dispatch.runOnExisting(
      child,
      retryTurn ? { kind: 'retry' } : options.prompt,
      { signal: options.signal, onReady: options.onReady },
    );
    if (!retryTurn) {
      emitAgentRunSpawned(caller, child.agentId, {
        profileName: child.profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
        model: child.modelAlias,
      });
    }
    return this.observe(caller, run, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    dispatchRun: DispatchRun,
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    const run = await dispatchRun.started;
    const mirrored = mirrorAgentRun(caller, run, {
      profileName: dispatchRun.child.profileName,
      prompt:
        dispatchRun.request.kind === 'prompt'
          ? dispatchRun.request.prompt
          : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    return {
      agentId: dispatchRun.child.agentId,
      profileName: dispatchRun.child.profileName,
      completion: mirrored.then((result) => ({ result: result.summary, usage: result.usage })),
    };
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `${label} "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }

  private async agentMeta(agentId: string) {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;

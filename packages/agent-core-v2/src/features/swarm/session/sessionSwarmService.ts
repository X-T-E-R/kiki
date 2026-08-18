/**
 * `sessionSwarm` domain — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks one `AbortController` per caller so `cancel` can abort
 * every in-flight run. The caller ↔ child association is this domain's own
 * business data: requester-side display facts (`subagent.spawned` wire signals
 * carrying the swarm's tool-call context, `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted from this layer; the
 * lifecycle registry itself stays flat. Spawn tasks may carry a concrete
 * `binding` resolved by the caller; without
 * one, spawns inherit the caller agent's model and thinking level. Spawn
 * bindings are resolved before lifecycle allocation and persist an
 * inherit-or-fixed mode. Normal resume refreshes inherited bindings from the
 * caller; internal rate-limit retries preserve the suspended attempt binding.
 * Bound at Session scope through `SwarmFeature`.
 */

import type { TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import {
  assertProfileRouteBinding,
  assertProfileRouteModelAvailable,
} from '#/session/subagent/profileRouteBinding';
import { Error2, ErrorCodes } from '#/errors';
import { linkAbortSignal } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  refreshInheritedSubagentBinding,
  withSubagentBindingMode,
  type PersistedSubagentBindingMode,
} from '#/session/agentLifecycle/agentLifecycleService';
import {
  delegatorRef,
  isSubagentMeta,
  labelsFromAgentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { wrapSubagentModelError } from '#/session/subagent/configSection';
import { resolveNestedSubagentDefaultContext } from '#/session/subagent/bindingContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { ILogService } from '#/_base/log/log';

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

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': SubagentSuspendedEvent;
  }
}

const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
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
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    const maxConcurrency = resolveSwarmMaxConcurrency();
    const promise = new AgentRunBatch(launcher, linkedTasks, { maxConcurrency }).run();
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
    await this.catalog.ready;
    const selection =
      options.routeId === undefined
        ? (() => {
            const base = this.catalog.get(options.profileName);
            if (base === undefined) {
              throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${options.profileName}"`, {
                details: { profileName: options.profileName },
              });
            }
            return { profile: base, baseProfile: base, route: undefined };
          })()
        : this.catalog.resolveSelection({ profile: options.profileName, route: options.routeId });
    const profile = selection.profile;
    const callerData = caller.accessor.get(IAgentProfileService).data();
    const callerRuntime = caller.accessor.get(IAgentRuntimeBindingService).current;
    if (callerData.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: callerAgentId },
      });
    }
    const suppliedBinding = options.binding as
      | (NonNullable<AgentSpawnAttemptOptions['binding']> & {
          readonly bindingMode?: PersistedSubagentBindingMode;
        })
      | undefined;
    const profilePinned =
      selection.route?.lockedModelAlias !== undefined ||
      selection.route?.lockedThinkingEffort !== undefined ||
      profile.modelAlias !== undefined ||
      profile.thinkingEffort !== undefined ||
      profile.modelPreference !== undefined;
    let binding = suppliedBinding ?? {
      model: selection.route?.lockedModelAlias ?? profile.modelAlias ?? callerData.modelAlias,
      thinking:
        selection.route?.lockedThinkingEffort ??
        profile.thinkingEffort ??
        callerData.thinkingLevel,
      modelSource:
        selection.route?.lockedModelAlias !== undefined || profile.modelAlias !== undefined
          ? ('profile' as const)
          : ('caller' as const),
      bindingMode: profilePinned ? ('fixed' as const) : ('inherit' as const),
    };
    if (binding.modelSource === 'caller') {
      const nestedDefault = resolveNestedSubagentDefaultContext(
        this.lifecycle,
        await this.agentMeta(callerAgentId),
      );
      if (nestedDefault !== undefined) {
        binding = {
          model: nestedDefault.modelAlias,
          thinking:
            binding.bindingMode === 'inherit' ? nestedDefault.thinkingLevel : binding.thinking,
          modelSource: 'caller',
          bindingMode: 'fixed',
        };
      }
    }
    binding = {
      ...binding,
      model: this.models.resolveId(binding.model) ?? binding.model,
    };
    assertProfileRouteBinding(
      selection.route,
      {
        modelAlias: binding.model,
        thinkingEffort: binding.thinking,
      },
      this.models,
    );
    assertProfileRouteModelAvailable(selection.route, this.modelCatalog, this.models);
    const modelSource = binding.modelSource ?? 'secondary';
    try {
      this.modelCatalog.get(binding.model);
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, callerData.modelAlias, modelSource);
    }
    let child: IAgentScopeHandle;
    try {
      child = await this.lifecycle.create({
        binding: {
          profile: selection.baseProfile.name,
          route: selection.route?.id,
          model: binding.model,
          thinking: binding.thinking,
        },
        labels: withSubagentBindingMode(
          subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
          binding.bindingMode ?? 'fixed',
        ),
        delegator: { kind: 'agent', agentId: callerAgentId },
        userLabel: options.swarmItem ?? options.description,
        runtimeId: callerRuntime.runtimeId,
      });
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, callerData.modelAlias, modelSource);
    }
    child.accessor
      .get(IAgentPermissionModeService)
      .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
    child.accessor
      .get(IAgentUserToolService)
      .inheritUserTools(caller.accessor.get(IAgentUserToolService));
    emitAgentRunSpawned(caller, child.id, {
      profileName: selection.route?.id ?? options.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      userLabel: options.swarmItem ?? options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      model: binding.model,
    });
    const lease = this.runtimeResolver.acquire(callerRuntime, ['process']);
    let promptText: string;
    try {
      const view = new RuntimeWorkspaceView(lease.runtime, { workDir: this.sessionContext.cwd });
      promptText = await applyProfilePromptPrefix(profile, options.prompt, {
        cwd: view.workDir,
        process: lease.runtime.process!,
        log: this.log,
      });
    } finally {
      lease.dispose();
    }
    return this.observe(caller, child.id, selection.route?.id ?? options.profileName, {
      kind: 'prompt',
      prompt: promptText,
    }, options);
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const meta = await this.requireOwnedSubagent(callerAgentId, agentId);
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child =
      this.lifecycle.get(agentId) ??
      (await this.lifecycle.create({
        agentId,
        forkedFrom: meta.forkedFrom,
        labels: labelsFromAgentMeta(meta),
        delegator: delegatorRef(meta),
      }));
    this.requireIdleSubagent(agentId, child);
    if (!retryTurn) {
      await refreshInheritedSubagentBinding(caller, child, meta);
    }
    const childProfile = child.accessor.get(IAgentProfileService).data();
    const profileName = childProfile.routeId ?? childProfile.profileName ?? RESUMED_PROFILE_FALLBACK;
    if (!retryTurn) {
      const resumedModel = childProfile.modelAlias;
      emitAgentRunSpawned(caller, agentId, {
        profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
        model: resumedModel,
      });
    }
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child.id, profileName, request, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    const run = await this.subagents.run(agentId, request, {
      signal: options.signal,
      onReady: options.onReady,
    });
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
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

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<AgentMeta> {
    const meta = await this.agentMeta(agentId);
    if (meta === undefined || !isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId } },
      );
    }
    return meta;
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;

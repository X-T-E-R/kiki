/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
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
import { Event2 } from '#/app/event/event2';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { resolveSubagentDispatch } from '#/app/agentProfileCatalog/subagentDispatch';
import {
  aliasIdentity,
  appliedDispatchProfile,
  assertAutomaticDispatchPermitted,
  leaseHasBindingPin,
} from '#/app/agentProfileCatalog/applySubagentLease';
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
  requestIdentitySpawnLabels,
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
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ILogService } from '#/_base/log/log';

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
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
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
    await this.catalog.ready;
    const callerData = caller.accessor.get(IAgentProfileService).data();
    const selection = resolveSubagentDispatch(this.catalog, callerData, {
      profileName: options.profileName,
      routeId: options.routeId,
      snapshot: options.catalogSnapshot,
    }).selection;
    const profile = selection.profile;
    const callerRuntime = caller.accessor.get(IAgentRuntimeBindingService).current;
    if (callerData.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: callerAgentId },
      });
    }
    const dispatched = appliedDispatchProfile(
      profile,
      selection.baseProfile.name,
      callerData,
      options.catalogSnapshot?.defaultProfile ?? this.catalog.getDefault(),
      aliasIdentity(this.models),
    );
    assertAutomaticDispatchPermitted(dispatched.profile, selection.route, this.models);
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
      model:
        selection.route?.lockedModelAlias ??
        dispatched.lease?.modelAlias ??
        profile.modelAlias ??
        callerData.modelAlias,
      thinking:
        selection.route?.lockedThinkingEffort ??
        dispatched.lease?.thinkingEffort ??
        profile.thinkingEffort ??
        callerData.thinkingLevel,
      modelSource:
        selection.route?.lockedModelAlias !== undefined ||
        dispatched.lease?.modelAlias !== undefined ||
        profile.modelAlias !== undefined
          ? ('profile' as const)
          : ('caller' as const),
      bindingMode: profilePinned || leaseHasBindingPin(dispatched.lease) ? ('fixed' as const) : ('inherit' as const),
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
      const callerMeta = (await this.metadata.read()).agents?.[callerAgentId];
      const identityLabels =
        options.parentTurnId === undefined
          ? {}
          : requestIdentitySpawnLabels(callerAgentId, options.parentTurnId, callerMeta);
      child = await this.lifecycle.create({
        binding: {
          profile: selection.baseProfile.name,
          route: selection.route?.id,
          resolvedProfile: selection.baseProfile,
          resolvedRoute: selection.route,
          model: binding.model,
          thinking: binding.thinking,
          lease: dispatched.lease,
          spawnPolicy: dispatched.spawnPolicy,
        },
        labels: withSubagentBindingMode(
          {
            ...subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
            ...identityLabels,
          },
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
      promptText = await applyProfilePromptPrefix(dispatched.profile, options.prompt, {
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

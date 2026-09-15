import { modelAliasResolverForExecutor } from '@kiki/agent-profiles/ports';

import { Emitter } from '#/_base/event';
import { DispatchCapacity } from './capacity';
import { inheritProfileFileSources } from './profileFile';
import { evaluateDispatchAdmission, tightenDispatchLaunchPolicy, type DispatchLaunchPolicy } from './launchPolicy';
import { abortable } from '#/_base/utils/abort';
import { setClampedTimeout } from '#/_base/utils/timer';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IConfigService } from '#/app/config/config';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { fillLeasePins, spawnConstraintOrigin } from '#/app/agentProfileCatalog/applySubagentLease';
import { resolveSubagentTarget } from '#/app/agentProfileCatalog/subagentDispatch';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ILogService } from '#/_base/log/log';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  delegatorRef,
  isSubagentMeta,
  labelsFromAgentMeta,
  requestIdentitySpawnLabels,
  subagentLabels,
} from '#/session/agentLifecycle/subagentMetadata';
import {
  COLLABORATION_AGENT_TYPE_LABEL,
  COLLABORATION_LATEST_TASK_LABEL,
  COLLABORATION_TASK_NAME_LABEL,
  IAgentCollaborationRegistry,
} from '#/session/agentCollaboration/registry';
import type { DelegatorRef, AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  canonicalizeSubagentBinding,
  resolveDispatchCapacityLimits,
  resolveSubagentBinding,
} from '#/session/subagent/configSection';
import { roleConstraintsFromProfile } from '#/session/subagent/modelConstraints';
import {
  assertProfileRouteBinding,
  assertProfileRouteModelAvailable,
} from '#/session/subagent/profileRouteBinding';
import { ISessionSubagentService, type AgentRunRequest } from '#/session/subagent/subagent';

import {
  ISessionDispatchService,
  type DispatchChild,
  type DispatchIdlePolicy,
  type DispatchLaunchInput,
  type DispatchResolvedBinding,
  type DispatchRun,
  type DispatchRunOptions,
  type DispatchWaitResult,
  type DispatchWaitSource,
} from './dispatch';

export class SessionDispatchService implements ISessionDispatchService {
  declare readonly _serviceBrand: undefined;
  private readonly delegatedRun = new Emitter<{ requesterAgentId: string; agentId: string }>();
  readonly onDidDelegateRun = this.delegatedRun.event;
  private readonly planStateReaders = new Map<string, () => boolean>();

  registerPlanStateReader(requesterAgentId: string, read: () => boolean): { dispose(): void } {
    this.planStateReaders.set(requesterAgentId, read);
    return { dispose: () => {
      if (this.planStateReaders.get(requesterAgentId) === read) this.planStateReaders.delete(requesterAgentId);
    } };
  }

  readLaunchPolicy(requesterAgentId: string): DispatchLaunchPolicy {
    const requester = this.requireHandle(requesterAgentId, 'Requester agent');
    return Object.freeze({
      planActive: this.planStateReaders.get(requesterAgentId)?.() === true,
      callerRestriction: requester.accessor.get(IAgentProfileService).data().executionRestriction,
    });
  }

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly runs: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentCollaborationRegistry private readonly names: IAgentCollaborationRegistry,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @ILogService private readonly log: ILogService,
  ) {}

  private readonly capacity = new DispatchCapacity();

  reserveExecution(agentId: string, parentAgentId?: string, reservation?: import('./capacity').DispatchReservation): () => void {
    if (agentId === 'main') return () => {};
    const slot = reservation ?? this.capacity.reserve(parentAgentId ?? 'main', resolveDispatchCapacityLimits(this.config), agentId);
    slot.claim(agentId);
    return slot;
  }

  reserveTurnExecution(agentId: string, parentAgentId?: string): () => void {
    if (agentId === 'main') return () => {};
    return this.capacity.retain(agentId) ?? this.reserveExecution(agentId, parentAgentId);
  }

  async launch(input: DispatchLaunchInput): Promise<DispatchRun> {
    input.signal.throwIfAborted();
    const release = this.capacity.reserve(input.requesterAgentId, resolveDispatchCapacityLimits(this.config));
    try {
      return this.trackCapacity(await this.launchReserved(input, release), release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private trackCapacity(run: DispatchRun, release: () => void): DispatchRun {
    void run.started.then((started) => {
      void started.completion.then(release, release);
    }, release);
    return run;
  }

  private async launchReserved(input: DispatchLaunchInput, reservation: import('./capacity').DispatchReservation): Promise<DispatchRun> {
    const requester = this.requireHandle(input.requesterAgentId, 'Requester agent');
    let policy = tightenDispatchLaunchPolicy(this.readLaunchPolicy(input.requesterAgentId), input.capturedLaunchPolicy);
    let researchReadonly = policy.planActive;
    const checkLaunchPolicy = (executorId?: string): void => {
      input.signal.throwIfAborted();
      policy = tightenDispatchLaunchPolicy(this.readLaunchPolicy(input.requesterAgentId), policy);
      const admission = evaluateDispatchAdmission(policy, 'spawn', executorId);
      if (!admission.allowed) throw new Error2(ErrorCodes.REQUEST_INVALID, admission.reason!);
      researchReadonly = admission.executionRestriction === 'research-readonly';
    };
    checkLaunchPolicy();
    await this.profiles.ready;
    checkLaunchPolicy();
    const requesterData =
      input.requesterProfileData ?? requester.accessor.get(IAgentProfileService).data();
    const target = resolveSubagentTarget(
      this.profiles,
      requesterData,
      {
        profileName: input.profileName,
        routeId: input.routeId,
        snapshot: inheritProfileFileSources(requesterData, this.profiles, input.snapshot),
      },
      this.models,
    );
    const selection = target.selection;
    const profile = target.effectiveProfile;
    checkLaunchPolicy(profile.executor);
    if (input.executorPolicy === 'native' && (profile.executor ?? 'native') !== 'native') {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Harness executors are unsupported for this dispatch seat.',
      );
    }
    const binding = this.resolveBinding(input, target);
    const name = input.name?.trim();
    if (name !== undefined && !(await this.names.reserve(name, input.delegator))) {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_EXISTS,
        `Agent name "${name}" is already used in this session. Pick another name or continue that agent.`,
        { details: { name } },
      );
    }
    let child: IAgentScopeHandle | undefined;
    let retained = false;
    try {
      const requesterUserTools = requester.accessor.get(IAgentUserToolService);
      const requesterMeta = (await this.metadata.read()).agents?.[input.requesterAgentId];
      const relationshipLabels =
        input.delegator.kind === 'agent'
          ? subagentLabels(input.delegator.agentId, { swarmItem: input.swarmItem })
          : {};
      const identityLabels =
        input.parentTurnId === undefined
          ? {}
          : requestIdentitySpawnLabels(
              input.requesterAgentId,
              input.parentTurnId,
              requesterMeta,
            );
      checkLaunchPolicy(profile.executor);
      child = await this.lifecycle.create({
        deferCreateEvent: true,
        binding: {
          executionRestriction: researchReadonly ? 'research-readonly' : undefined,
          profile: selection.baseProfile.name,
          route: selection.route?.id,
          resolvedProfile: selection.baseProfile,
          resolvedRoute: selection.route,
          model: binding.model,
          thinking: binding.thinking,
          strictThinking:
            input.strictThinking ??
            (input.strictThinkingFromProfile === true
              ? input.thinkingEffort !== undefined || profile.thinkingEffort !== undefined
              : undefined),
          inheritedUserToolNames: researchReadonly ? undefined : requesterUserTools.list().map((tool) => tool.name),
          lease: target.lease,
          spawnPolicy: target.spawnPolicy,
        },
        labels: {
          ...relationshipLabels,
          ...identityLabels,
          ...input.labels,
          ...(name === undefined
            ? {}
            : {
                [COLLABORATION_TASK_NAME_LABEL]: name,
                [COLLABORATION_AGENT_TYPE_LABEL]: selection.baseProfile.name,
              }),
        },
        delegator: input.delegator,
        userLabel: input.userLabel,
        runtimeId: input.runtimeId ?? input.runtime.identity.runtimeId,
      });
      reservation.bind(child.id);
      const permissionMode = child.accessor.get(IAgentPermissionModeService);
      if (input.permissionModeCeiling !== undefined) {
        permissionMode.setModeCeiling(input.permissionModeCeiling);
      }
      permissionMode.setMode(
        input.permissionMode ?? requester.accessor.get(IAgentPermissionModeService).mode,
      );
      if (!researchReadonly) {
        child.accessor.get(IAgentUserToolService).inheritUserTools(requesterUserTools);
      }
      const dispatchChild = this.childView(
        child,
        name,
        selection.route?.id ?? profile.name,
        profile,
      );
      const prompt = researchReadonly
        ? input.message
        : await applyProfilePromptPrefix(profile, input.message, {
            cwd: input.workDir,
            process: input.runtime.process!,
            log: this.log,
          });
      input.signal.throwIfAborted();
      await input.onCreated?.(dispatchChild, () => { retained = true; });
      if (name !== undefined) this.names.commit(name, input.delegator);
      retained = true;
      this.lifecycle.commitCreate(child.id);
      if (input.delegator.kind === 'agent') {
        this.recordDelegatedRun(input.requesterAgentId, dispatchChild.agentId);
      }
      const request = { kind: 'prompt', prompt } as const;
      return {
        child: dispatchChild,
        request,
        started: this.runs.run(child.id, request, {
          signal: input.signal,
          onReady: input.onReady,
          capacityReservation: reservation,
        }),
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (child !== undefined) {
        try {
          if (retained) this.lifecycle.commitCreate(child.id);
          else await this.lifecycle.discard(child.id);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        if (name !== undefined) this.names.release(name, input.delegator);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Dispatch launch and cleanup failed', { cause: error });
      }
      throw error;
    }
  }

  async resolveOwnedChild(delegator: DelegatorRef, rawRef: string): Promise<DispatchChild> {
    const ref = rawRef.trim();
    const agents = (await this.metadata.read()).agents ?? {};
    const matches = Object.entries(agents).filter(([agentId, meta]) => {
      if (!sameDelegator(delegatorRef(meta), delegator)) return false;
      return (
        agentId === ref ||
        meta.labels?.[COLLABORATION_TASK_NAME_LABEL] === ref ||
        meta.labels?.['externalDelegationTaskName'] === ref
      );
    });
    const resolvedAgentId = matches.length === 1 ? matches[0]![0] : ref;
    const meta = agents[resolvedAgentId];
    if (meta === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Agent instance "${resolvedAgentId}" does not exist`,
        { details: { agentId: resolvedAgentId } },
      );
    }
    if (delegator.kind === 'agent' && !isSubagentMeta(meta)) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_A_SUBAGENT,
        `Agent instance "${resolvedAgentId}" is not a subagent`,
        { details: { agentId: resolvedAgentId } },
      );
    }
    if (!sameDelegator(delegatorRef(meta), delegator)) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${resolvedAgentId}" does not belong to this delegator`,
        { details: { agentId: resolvedAgentId, delegator } },
      );
    }
    const childDelegator = delegatorRef(meta)!;
    const live = this.lifecycle.get(resolvedAgentId);
    const child =
      live ??
      (await this.lifecycle.create({
        agentId: resolvedAgentId,
        forkedFrom: meta.forkedFrom,
        labels: labelsFromAgentMeta(meta),
        delegator: childDelegator,
      }));
    const data = child.accessor.get(IAgentProfileService).data();
    if (live === undefined && childDelegator.kind === 'agent') {
      const delegator = this.requireHandle(childDelegator.agentId, 'Delegator agent');
      child
        .accessor.get(IAgentPermissionModeService)
        .setMode(delegator.accessor.get(IAgentPermissionModeService).mode);
    }
    return this.childView(
      child,
      meta.labels?.[COLLABORATION_TASK_NAME_LABEL] ??
        meta.labels?.['externalDelegationTaskName'],
      data.routeId ?? data.profileName ?? meta.displayName ?? 'subagent',
      undefined,
      meta,
    );
  }

  async runOnExisting(
    child: DispatchChild,
    requestInput: string | Extract<AgentRunRequest, { kind: 'retry' }>,
    options: DispatchRunOptions,
  ): Promise<DispatchRun> {
    options.signal.throwIfAborted();
    this.requireIdle(child.agent, options.idlePolicy ?? 'execution');
    const meta = child.meta ?? (await this.metadata.read()).agents?.[child.agentId];
    const delegator = meta === undefined ? undefined : delegatorRef(meta);
    const owner = delegator?.kind === 'agent' ? delegator.agentId : options.requesterAgentId ?? 'main';
    const reservation = child.agentId === 'main'
      ? undefined
      : this.capacity.reserve(owner, resolveDispatchCapacityLimits(this.config), child.agentId);
    const release = reservation ?? (() => {});
    try {
      return this.trackCapacity(await this.runExistingReserved(child, requestInput, options, reservation), release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async runExistingReserved(
    child: DispatchChild,
    requestInput: string | Extract<AgentRunRequest, { kind: 'retry' }>,
    options: DispatchRunOptions,
    reservation?: import('./capacity').DispatchReservation,
  ): Promise<DispatchRun> {
    let policy = options.capturedLaunchPolicy;
    const checkResume = (): void => {
      if (options.requesterAgentId === undefined) return;
      policy = tightenDispatchLaunchPolicy(this.readLaunchPolicy(options.requesterAgentId), policy);
      const admission = evaluateDispatchAdmission(policy, 'resume');
      if (!admission.allowed) throw new Error2(ErrorCodes.REQUEST_INVALID, admission.reason!);
    };
    checkResume();
    this.requireIdle(child.agent, options.idlePolicy ?? 'execution');
    const childProfile = child.agent.accessor.get(IAgentProfileService);
    const readCallerConstraints = () => {
      const caller = options.requesterAgentId === undefined ? undefined
        : this.requireHandle(options.requesterAgentId, 'Requester agent').accessor.get(IAgentProfileService).data();
      const lease = caller?.subagentLeases?.[childProfile.data().profileName ?? child.profileName];
      return [caller?.spawnPolicy, lease].filter((value) => value !== undefined);
    };
    await options.onBeforeRun?.(child);
    checkResume();
    this.requireIdle(child.agent, options.idlePolicy ?? 'execution');
    const callerConstraints = readCallerConstraints();
    const callerConstraintKey = JSON.stringify(callerConstraints);
    const applyBinding = options.bindingOverride === undefined ? undefined : await childProfile.prepareResumeBinding({
      ...options.bindingOverride, callerConstraints,
    });
    checkResume();
    this.requireIdle(child.agent, options.idlePolicy ?? 'execution');
    options.signal.throwIfAborted();
    if (applyBinding !== undefined && callerConstraintKey !== JSON.stringify(readCallerConstraints())) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Caller constraints changed during resume admission. Retry against the current caller policy.');
    }
    applyBinding?.();
    const request: AgentRunRequest =
      typeof requestInput === 'string'
        ? { kind: 'prompt', prompt: requestInput }
        : requestInput;
    if (options.requesterAgentId !== undefined) {
      this.recordDelegatedRun(options.requesterAgentId, child.agentId);
    }
    return {
      child: applyBinding === undefined ? child : this.childView(child.agent, child.name, child.profileName, child.effectiveProfile, child.meta),
      request,
      lineage: options.lineage,
      started: this.runs.run(child.agentId, request, {
        signal: options.signal,
        onReady: options.onReady,
        capacityReservation: reservation,
      }),
    };
  }

  async recordRun(agentId: string, runId: string): Promise<void> {
    const meta = (await this.metadata.read()).agents?.[agentId];
    if (meta === undefined) return;
    await this.metadata.registerAgent(agentId, {
      ...meta,
      labels: {
        ...meta.labels,
        [COLLABORATION_LATEST_TASK_LABEL]: runId,
      },
    });
  }

  recordDelegatedRun(requesterAgentId: string, agentId: string): void {
    this.delegatedRun.fire({ requesterAgentId, agentId });
  }

  async wait<T>(
    source: DispatchWaitSource<T>,
    options: { readonly key?: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<DispatchWaitResult<T>> {
    const startedAt = Date.now();
    const initial = source.read();
    const trackedKeys =
      options.key === undefined
        ? initial.filter((item) => !source.terminal(item)).map(source.key)
        : [options.key];
    if (trackedKeys.length === 0) {
      return {
        waitStatus: 'no_items',
        waitedMs: 0,
        completedDuringWait: [],
      };
    }
    const deadline = startedAt + Math.max(0, options.timeoutMs);
    while (true) {
      const wake = nextWake(source.onDidChange, Math.max(0, deadline - Date.now()), options.signal);
      const current = source.read();
      const completed = trackedKeys.flatMap((key) => {
        const item = current.find((candidate) => source.key(candidate) === key);
        return item !== undefined && source.terminal(item) ? [item] : [];
      });
      if (completed.length > 0) {
        wake.dispose();
        return {
          waitStatus: 'completed',
          waitedMs: Date.now() - startedAt,
          item: completed[0],
          completedDuringWait: completed.slice(1),
        };
      }
      const blockedKey = source.blockedKey?.();
      if (blockedKey !== undefined && trackedKeys.includes(blockedKey)) {
        wake.dispose();
        return {
          waitStatus: 'blocked',
          waitedMs: Date.now() - startedAt,
          item: current.find((candidate) => source.key(candidate) === blockedKey),
          completedDuringWait: [],
        };
      }
      if (Date.now() >= deadline) {
        wake.dispose();
        return {
          waitStatus: 'timed_out',
          waitedMs: Date.now() - startedAt,
          item:
            options.key === undefined
              ? undefined
              : current.find((candidate) => source.key(candidate) === options.key),
          completedDuringWait: [],
        };
      }
      try {
        await wake.promise;
      } finally {
        wake.dispose();
      }
    }
  }

  private resolveBinding(
    input: DispatchLaunchInput,
    target: ReturnType<typeof resolveSubagentTarget>,
  ): DispatchResolvedBinding {
    const selection = target.selection;
    const profile = target.effectiveProfile;
    const native = (profile.executor ?? 'native') === 'native';
    const resolver = modelAliasResolverForExecutor(profile.executor, this.models);
    if (input.resolvedBinding !== undefined) {
      const model = resolver.resolveId(input.resolvedBinding.model) ?? input.resolvedBinding.model;
      if (native) {
        assertProfileRouteBinding(
          selection.route,
          { modelAlias: model, thinkingEffort: input.resolvedBinding.thinking },
          resolver,
        );
        assertProfileRouteModelAvailable(selection.route, this.modelCatalog, resolver);
        this.modelCatalog.get(model);
      }
      return { model, thinking: input.resolvedBinding.thinking };
    }
    const filled = fillLeasePins(
      { modelAlias: input.modelAlias, thinkingEffort: input.thinkingEffort },
      target.lease,
      selection.route,
    );
    if (native) {
      assertProfileRouteBinding(
        selection.route,
        { modelAlias: filled.modelAlias, thinkingEffort: filled.thinkingEffort },
        resolver,
      );
      assertProfileRouteModelAvailable(selection.route, this.modelCatalog, resolver);
    }
    const roleConstraints = roleConstraintsFromProfile(
      profile,
      spawnConstraintOrigin(target.lease, target.spawnPolicy),
    );
    const resolved = resolveSubagentBinding(
      this.config,
      { ...filled, thinkingEffort: filled.thinkingEffort ?? selection.route?.lockedThinkingEffort },
      {
        modelAlias: selection.route?.lockedModelAlias ?? profile.modelAlias,
        thinkingEffort:
          selection.route?.lockedThinkingEffort ?? profile.thinkingEffort,
      },
      native ? this.models : undefined,
      roleConstraints,
      { profileName: profile.name, routeId: selection.route?.id },
    );
    const binding = native ? canonicalizeSubagentBinding(resolved, this.models) : resolved;
    if (native) this.modelCatalog.get(binding.model);
    return binding;
  }

  private childView(
    agent: IAgentScopeHandle,
    name: string | undefined,
    profileName: string,
    effectiveProfile?: DispatchChild['effectiveProfile'],
    meta?: AgentMeta,
  ): DispatchChild {
    const data = agent.accessor.get(IAgentProfileService).data();
    return {
      agent,
      agentId: agent.id,
      name,
      profileName,
      modelAlias: data.modelAlias,
      thinkingEffort: data.thinkingLevel,
      effectiveProfile,
      meta,
    };
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `${label} "${agentId}" does not exist`,
        { details: { agentId } },
      );
    }
    return handle;
  }

  private requireIdle(child: IAgentScopeHandle, policy: DispatchIdlePolicy): void {
    const idle =
      policy === 'execution'
        ? child.accessor.get(IAgentExecutionService).status().state === 'idle'
        : quiescent(child.accessor.get(IAgentLoopService).status());
    if (idle) return;
    throw new Error2(
      ErrorCodes.AGENT_ALREADY_RUNNING,
      `Agent instance "${child.id}" is already running and cannot run concurrently`,
      { details: { agentId: child.id } },
    );
  }
}

interface Wake {
  readonly promise: Promise<void>;
  dispose(): void;
}

function nextWake(
  onDidChange: DispatchWaitSource<unknown>['onDidChange'],
  timeoutMs: number,
  signal?: AbortSignal,
): Wake {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let subscription: { dispose(): void } | undefined;
  const promise = new Promise<void>((resolve) => {
    subscription = onDidChange(() => resolve());
    timeout = setClampedTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
  return {
    promise: signal === undefined ? promise : abortable(promise, signal),
    dispose: () => {
      subscription?.dispose();
      if (timeout !== undefined) clearTimeout(timeout);
    },
  };
}

function quiescent(status: ReturnType<IAgentLoopService['status']>): boolean {
  return (
    status.state === 'idle' &&
    status.pendingTurnIds.length === 0 &&
    !status.hasPendingRequests
  );
}

function sameDelegator(left: DelegatorRef | undefined, right: DelegatorRef): boolean {
  if (left?.kind !== right.kind) return false;
  return left.kind === 'agent' && right.kind === 'agent'
    ? left.agentId === right.agentId
    : left.kind === 'external' && right.kind === 'external' &&
        left.delegationId === right.delegationId;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionDispatchService,
  SessionDispatchService,
  ScopeActivation.OnDemand,
  'dispatch',
);

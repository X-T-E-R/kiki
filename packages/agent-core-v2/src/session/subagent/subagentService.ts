import { Service } from '#/_base/di/service';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { toDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveSnapshotProfileDefinition } from '#/app/agentProfileCatalog/subagentDispatch';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { SUBAGENT_RELEASE_IDLE_FLAG } from './flag';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from './subagent';

export const SUBAGENT_RELEASE_GRACE_MS = 30_000;
export const SUBAGENT_RELEASE_GRACE_ENV = 'KIMI_CODE_SUBAGENT_RELEASE_GRACE_MS';

export function resolveReleaseGraceMs(getEnv: (name: string) => string | undefined): number {
  const raw = getEnv(SUBAGENT_RELEASE_GRACE_ENV);
  if (raw === undefined || raw === '') return SUBAGENT_RELEASE_GRACE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : SUBAGENT_RELEASE_GRACE_MS;
}

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private readonly pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  get onDidStopAgentTask() {
    return this.onDidStopAgentTaskEmitter.event;
  }

  private readonly releaseGraceMs: number;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.releaseGraceMs = resolveReleaseGraceMs((name) => bootstrap.getEnv(name));
    this._register(
      toDisposable(() => {
        this.stopped = true;
        for (const timer of this.pendingReleases.values()) clearTimeout(timer);
        this.pendingReleases.clear();
      }),
    );
  }

  run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    this.cancelRelease(agentId);
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle.accessor
      .get(IAgentExecutionService)
      .run(request, {
        summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
        signal: opts.signal,
        onReady: opts.onReady,
        capacityReservation: opts.capacityReservation,
      })
      .then((run) => {
        const settle = (): void => this.scheduleRelease(agentId);
        void run.completion.then(settle, settle);
        return run;
      });
  }

  notifyAgentTaskStopped(context: AgentTaskStopHookContext): void {
    this.onDidStopAgentTaskEmitter.fire(context);
  }

  private cancelRelease(agentId: string): void {
    const timer = this.pendingReleases.get(agentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingReleases.delete(agentId);
  }

  private scheduleRelease(agentId: string, idleObserved = true): void {
    if (agentId === MAIN_AGENT_ID || this.stopped) return;
    if (!this.flags.enabled(SUBAGENT_RELEASE_IDLE_FLAG)) return;
    this.cancelRelease(agentId);
    const timer = setTimeout(() => {
      this.pendingReleases.delete(agentId);
      void this.releaseIfIdle(agentId, idleObserved);
    }, this.releaseGraceMs);
    timer.unref?.();
    this.pendingReleases.set(agentId, timer);
  }

  private async releaseIfIdle(agentId: string, idleObserved: boolean): Promise<void> {
    if (this.stopped || !this.flags.enabled(SUBAGENT_RELEASE_IDLE_FLAG)) return;
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) return;
    if (!isReleasable(handle)) {
      this.scheduleRelease(agentId, false);
      return;
    }
    if (!idleObserved) {
      this.scheduleRelease(agentId, true);
      return;
    }
    this.log.info('releasing idle subagent scope', { agentId });
    try {
      await this.agentLifecycle.remove(agentId);
    } catch (error) {
      this.log.warn('idle subagent release failed', { agentId, error: String(error) });
    }
  }

  private summaryPolicyFor(handle: IAgentScopeHandle): AgentProfileSummaryPolicy | undefined {
    const data = handle.accessor.get(IAgentProfileService).data();
    const profileName = data.profileName;
    if (profileName === undefined) return undefined;
    if (data.profileDefinitionId === undefined) return this.catalog.get(profileName)?.summaryPolicy;
    const snapshot = this.catalog.snapshot?.();
    if (snapshot === undefined) return undefined;
    return resolveSnapshotProfileDefinition(
      snapshot,
      data.profileDefinitionId,
      profileName,
    )?.summaryPolicy;
  }
}

/** A subagent scope can be released when nothing in it is running, queued, or waiting for work. */
export function isReleasable(handle: IAgentScopeHandle): boolean {
  try {
    if (handle.accessor.get(IAgentExecutionService).status().state !== 'idle') return false;
    const loop = handle.accessor.get(IAgentLoopService).status();
    if (loop.state !== 'idle' || loop.pendingTurnIds.length > 0 || loop.hasPendingRequests) return false;
    const prompts = handle.accessor.get(IAgentPromptService).list();
    if (prompts.active !== undefined || prompts.pending.length > 0) return false;
    if (handle.accessor.get(IAgentTaskService).list(true).length > 0) return false;
    return !isSwarmActive(handle);
  } catch {
    return false;
  }
}

function isSwarmActive(handle: IAgentScopeHandle): boolean {
  try {
    return handle.accessor.get(IAgentSwarmService).isActive;
  } catch {
    return false;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);

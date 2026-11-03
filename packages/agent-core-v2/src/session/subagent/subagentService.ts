import { Service } from '#/_base/di/service';
import { AUTONOMOUS_RECEIPT_POLICY_LABEL, observeAutonomousReceipts, type ReceiptDelivery } from './autonomousReceipt';
import { readPendingAutonomousReceipts } from './autonomousReceiptRecovery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { autonomousReceiptsKey } from './autonomousReceiptOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { DisposableMap, toDisposable } from '#/_base/di/lifecycle';
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
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionStateService } from '#/session/state/sessionState';

import { SUBAGENT_RELEASE_IDLE_FLAG } from './flag';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  pendingSubagentReceiptsKey,
  type RunAgentOptions,
} from './subagent';

export const SUBAGENT_RELEASE_GRACE_MS = 30_000;
export const SUBAGENT_RELEASE_GRACE_ENV = 'KIKI_SUBAGENT_RELEASE_GRACE_MS';

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
  private readonly receiptObservers = this._register(new DisposableMap<string>());
  private readonly pendingReceipts = new Set<ReceiptDelivery & {
    readonly child: IAgentScopeHandle;
    readonly parentId?: string;
  }>();
  private recovery: Promise<void> | undefined;
  private discoveringReceipts = false;
  private readonly pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retained = new WeakMap<IAgentScopeHandle, number>();
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
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionContext private readonly session: ISessionContext,
    @IAppendLogStore private readonly logs: IAppendLogStore,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    this._register(states.contributeState(pendingSubagentReceiptsKey));
    this.releaseGraceMs = resolveReleaseGraceMs((name) => bootstrap.getEnv(name));
    const receipts = new AbortController();
    this._register(toDisposable(() => { receipts.abort(); }));
    this._register(agentLifecycle.onWillCreate((handle) => {
      if (handle.id !== MAIN_AGENT_ID) handle.accessor.get(IAgentStateService).contributeState(autonomousReceiptsKey);
    }));
    this._register(agentLifecycle.onDidCreate((handle) => {
      if (handle.id !== MAIN_AGENT_ID) {
        for (const prior of this.pendingReceipts) {
          if (prior.child.id === handle.id && prior.child !== handle) this.pendingReceipts.delete(prior);
        }
        void this.receiptObservers.set(handle.id, observeAutonomousReceipts(handle, (delivery) => {
          const receipt = {
            ...delivery,
            child: handle,
            parentId: handle.accessor.get(IAgentScopeContext).parentAgentId,
          };
          this.pendingReceipts.add(receipt);
          this.publishPendingReceipts();
          void receipt.settled.then(() => {
            this.pendingReceipts.delete(receipt);
            if (!this.stopped) this.publishPendingReceipts();
            if (this.agentLifecycle.get(handle.id) === handle) this.scheduleRelease(handle.id);
          }, (error: unknown) => {
            if (!this.stopped) this.log.error('autonomous subagent receipt delivery stopped before completion', { agentId: handle.id, error });
          });
        }, receipts.signal));
      }
      if (!this.pendingReleases.has(handle.id)) this.scheduleRelease(handle.id, false);
    }));
    if (agentLifecycle.onWillSealTranscript !== undefined) {
      this._register(agentLifecycle.onWillSealTranscript((event) => {
        void this.receiptObservers.deleteAndDispose(event.handle.id);
        const pending = [...this.pendingReceipts].filter((receipt) => receipt.child === event.handle || receipt.parentId === event.handle.id);
        event.waitUntil(Promise.all(pending.map((receipt) => receipt.drain().catch((error: unknown) => { event.fail(error); }))));
      }));
    }
    if (agentLifecycle.onDidDispose !== undefined) {
      this._register(agentLifecycle.onDidDispose((agentId) => {
        void this.receiptObservers.deleteAndDispose(agentId);
        this.cancelRelease(agentId);
      }));
    }
    this._register(
      toDisposable(() => {
        this.stopped = true;
        for (const timer of this.pendingReleases.values()) clearTimeout(timer);
        this.pendingReleases.clear();
      }),
    );
  }

  recoverReceipts(): Promise<void> {
    this.recovery ??= this.restoreReceipts().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private publishPendingReceipts(): void {
    this.states.set(pendingSubagentReceiptsKey, this.pendingReceipts.size + Number(this.discoveringReceipts));
  }

  private async restoreReceipts(): Promise<void> {
    this.discoveringReceipts = true;
    this.publishPendingReceipts();
    try {
      const meta = await this.metadata.read();
      for (const [agentId, agent] of Object.entries(meta.agents ?? {})) {
        if (agentId === MAIN_AGENT_ID || agent.parentAgentId === null ||
          agent.labels?.[AUTONOMOUS_RECEIPT_POLICY_LABEL] === 'local' || this.agentLifecycle.get(agentId) !== undefined) continue;
        const pending = await readPendingAutonomousReceipts(this.session.scope(`agents/${agentId}`), this.logs, this.documents);
        if (Object.keys(pending).length === 0) continue;
        const parentId = agent.parentAgentId ?? MAIN_AGENT_ID;
        if (this.agentLifecycle.get(parentId) === undefined) {
          const parent = meta.agents?.[parentId];
          await this.agentLifecycle.create({ agentId: parentId, delegator: parent?.delegator ?? (parent?.parentAgentId === undefined || parent.parentAgentId === null ? undefined : { kind: 'agent', agentId: parent.parentAgentId }) });
        }
        await this.agentLifecycle.create({ agentId, delegator: agent.delegator ?? { kind: 'agent', agentId: parentId } });
      }
    } finally {
      this.discoveringReceipts = false;
      if (!this.stopped) this.publishPendingReceipts();
    }
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
        parentReceiptManaged: true,
        summaryPolicy: opts.summaryPolicy ?? this.summaryPolicyFor(handle),
        signal: opts.signal,
        onReady: opts.onReady,
        onQueued: opts.onQueued,
        onBeforeExternalRun: opts.onBeforeExternalRun,
        onExternalRunNotSent: opts.onExternalRunNotSent,
        capacityReservation: opts.capacityReservation,
      })
      .then((run) => {
        const settle = (): void => {
          if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
        };
        void run.completion.then(settle, settle);
        return run;
      }, (error: unknown) => {
        if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
        return Promise.reject(error);
      });
  }

  retain(agentId: string): import('#/_base/di/lifecycle').ISyncDisposable {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, { details: { agentId } });
    this.retained.set(handle, (this.retained.get(handle) ?? 0) + 1);
    this.cancelRelease(agentId);
    return toDisposable(() => {
      const remaining = (this.retained.get(handle) ?? 1) - 1;
      if (remaining > 0) this.retained.set(handle, remaining);
      else {
        this.retained.delete(handle);
        if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
      }
    });
  }

  trackPromptRun(agentId: string, completion: Promise<unknown>, signal: AbortSignal): AbortSignal {
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    const trackedSignal = handle.accessor.get(IAgentExecutionService).trackPromptRun(completion, signal);
    this.cancelRelease(agentId);
    const settle = (): void => {
      if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
    };
    void completion.then(settle, settle);
    return trackedSignal;
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
    if (this.retained.has(handle) || [...this.pendingReceipts].some((receipt) => receipt.child === handle) || !isReleasable(handle)) {
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
    const executionState = handle.accessor.get(IAgentExecutionService).status().state;
    if (executionState !== 'idle' && executionState !== 'closed') return false;
    const loop = handle.accessor.get(IAgentLoopService).status();
    if (loop.state !== 'idle' || loop.pendingTurnIds.length > 0 || loop.hasPendingRequests) return false;
    const prompts = handle.accessor.get(IAgentPromptService).list();
    if (prompts.active !== undefined || prompts.launching !== undefined || prompts.pending.length > 0) return false;
    if (handle.accessor.get(IAgentTaskService).list(true).length > 0) return false;
    return true;
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

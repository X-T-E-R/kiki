import { Service } from '#/_base/di/service';
import { ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import { IPluginExtensionPortRegistryReader } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { withoutRestoreAttempt } from '#/session/agentLifecycle/restoreTiming';
import { ISessionBranchService } from '#/features/btw/btw';
import { AUTONOMOUS_RECEIPT_POLICY_LABEL, hasReceiptWork, isBranchReceiptOwner, observeAutonomousReceipts, type ReceiptDelivery, type ReceiptObserver } from './autonomousReceipt';
import { readPendingAutonomousReceipts } from './autonomousReceiptRecovery';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { autonomousReceiptsKey } from './autonomousReceiptOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { StorageErrors } from '#/persistence/interface/storage';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { DisposableMap, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveSnapshotProfileDefinition } from '#/app/agentProfileCatalog/subagentDispatch';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService, wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createHooks } from '#/hooks';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionStateService } from '#/session/state/sessionState';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import type { ISessionExecutionControl } from '#/session/executionControl/executionControl';

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

async function retryReceiptDiscovery<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const delays = [100, 500, 2_000];
  for (let attempt = 0;; attempt++) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      const code = isError2(error) ? error.code : error instanceof Error && 'code' in error ? error.code : undefined;
      const wait = delays[attempt];
      if (wait === undefined || (code !== StorageErrors.codes.STORAGE_IO_FAILED && code !== StorageErrors.codes.STORAGE_LOCKED && code !== 'EBUSY')) throw error;
      await delay(wait, undefined, { signal, ref: false });
    }
  }
}

export class SessionSubagentService extends Service implements ISessionSubagentService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);
  private readonly onDidStopAgentTaskEmitter = this._register(
    new Emitter<AgentTaskStopHookContext>(),
  );
  private readonly receiptObservers = this._register(new DisposableMap<string, ReceiptObserver>());
  private readonly parentIds = new Map<string, string>();
  private readonly pendingReceipts = new Set<ReceiptDelivery & {
    readonly child: IAgentScopeHandle;
    readonly parentId?: string;
  }>();
  private recovery: Promise<void> | undefined;
  private receiptDiscovery: AbortController | undefined;
  private receiptRecoverySubscription: IDisposable | undefined;
  private receiptDiscoveryComplete = false;
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
    @ref(IPluginExtensionPortRegistryReader) private readonly extensions?: LiveRef<IPluginExtensionPortRegistryReader>,
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
        const parentId = handle.accessor.get(IAgentScopeContext).parentAgentId;
        if (parentId !== undefined) this.parentIds.set(handle.id, parentId);
        for (const prior of this.pendingReceipts) {
          if (prior.child.id === handle.id && prior.child !== handle) this.pendingReceipts.delete(prior);
        }
        void this.receiptObservers.set(handle.id, observeAutonomousReceipts(handle, (delivery) => {
          const receipt = {
            ...delivery,
            child: handle,
            parentId,
          };
          this.pendingReceipts.add(receipt);
          this.recheckAncestors(handle.id);
          this.publishPendingReceipts();
          void receipt.settled.then(() => {
            this.pendingReceipts.delete(receipt);
            this.recheckAncestors(handle.id);
            if (!this.stopped) this.publishPendingReceipts();
            if (this.agentLifecycle.get(handle.id) === handle) this.scheduleRelease(handle.id);
          }, (error: unknown) => {
            this.pendingReceipts.delete(receipt);
            this.recheckAncestors(handle.id);
            if (!this.stopped) {
              this.publishPendingReceipts();
              this.log.error('autonomous subagent receipt delivery stopped before completion', { agentId: handle.id, error });
            }
          });
        }, () => this.hasDescendantReceiptWork(handle.id), () => this.recheckAncestors(handle.id), receipts.signal));
        this.recheckAncestors(handle.id);
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
        this.recheckAncestors(agentId);
        this.parentIds.delete(agentId);
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

  override async dispose(): Promise<void> {
    this.stopped = true;
    await this.stopReceiptDiscovery();
    await super.dispose();
  }

  async stopReceiptDiscovery(): Promise<void> {
    const subscription = this.receiptRecoverySubscription;
    this.receiptRecoverySubscription = undefined;
    this.receiptDiscovery?.abort();
    await subscription?.dispose();
    await this.recovery;
  }

  startReceiptDiscovery(control: ISessionExecutionControl): void {
    if (this.stopped || this.receiptDiscoveryComplete || this.receiptRecoverySubscription !== undefined) return;
    const start = () => {
      if (this.recovery !== undefined || this.receiptDiscoveryComplete || control.isHeld()) return;
      const discovery = new AbortController();
      this.receiptDiscovery = discovery;
      const pauseSignal = control.pauseSignal();
      const signal = AbortSignal.any([discovery.signal, pauseSignal]);
      this.discoveringReceipts = true;
      this.publishPendingReceipts();
      this.recovery = withoutRestoreAttempt(async () => {
        try {
          await setImmediate(undefined, { signal });
          this.receiptDiscoveryComplete = await this.restoreReceipts(signal);
        } catch (error) {
          if (!signal.aborted) this.log.error('autonomous subagent receipt discovery failed', { error });
        } finally {
          this.receiptDiscovery = undefined;
          this.recovery = undefined;
          this.discoveringReceipts = false;
          if (!this.stopped) this.publishPendingReceipts();
          if (pauseSignal.aborted && this.receiptRecoverySubscription !== undefined) start();
        }
      });
    };
    this.receiptRecoverySubscription = control.onDidChange(start);
    start();
  }

  private recheckAncestors(agentId: string): void {
    if (this.stopped) return;
    for (let parent = this.parentIds.get(agentId); parent !== undefined; parent = this.parentIds.get(parent)) {
      this.receiptObservers.get(parent)?.recheck();
    }
  }

  private hasDescendantReceiptWork(agentId: string): boolean {
    const isDescendant = (candidateId: string): boolean => {
      let parent = this.parentIds.get(candidateId);
      while (parent !== undefined && parent !== agentId) parent = this.parentIds.get(parent);
      return parent === agentId;
    };
    for (const receipt of this.pendingReceipts) {
      if (isDescendant(receipt.child.id)) return true;
    }
    for (const [childId] of this.parentIds) {
      if (!isDescendant(childId)) continue;
      const handle = this.agentLifecycle.get(childId);
      if (handle === undefined) continue;
      if (hasReceiptWork(handle) ||
        Object.keys(handle.accessor.get(IAgentStateService).get(autonomousReceiptsKey).pending).length > 0 ||
        optionalFromHandle(handle, ISessionBranchService)?.isFolding(childId) === true) {
        return true;
      }
    }
    return false;
  }

  private publishPendingReceipts(): void {
    this.states.set(pendingSubagentReceiptsKey, this.pendingReceipts.size + Number(this.discoveringReceipts));
  }

  private async restoreReceipts(signal: AbortSignal): Promise<boolean> {
    const meta = await retryReceiptDiscovery(() => this.metadata.read(), signal);
    const candidates = Object.entries(meta.agents ?? {}).filter(([agentId, agent]) =>
      agentId !== MAIN_AGENT_ID &&
      agent.parentAgentId !== null &&
      (agent.labels?.[AUTONOMOUS_RECEIPT_POLICY_LABEL] !== 'local' || isBranchReceiptOwner(agent)) &&
      this.agentLifecycle.get(agentId) === undefined,
    );
    if (candidates.length === 0) return true;
    let complete = true;
    let cursor = 0;
    let materializeChain: Promise<void> = Promise.resolve();
    const enqueueMaterialize = (task: () => Promise<void>): Promise<void> => {
      const next = materializeChain.then(task);
      materializeChain = next.catch(() => {});
      return next;
    };
    const workerCount = Math.min(2, candidates.length);
    const paceMs = candidates.length > 16 ? 10 : 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        signal.throwIfAborted();
        const index = cursor++;
        if (index >= candidates.length) return;
        const [agentId, agent] = candidates[index]!;
        if (this.agentLifecycle.get(agentId) !== undefined) continue;
        if (paceMs > 0 && index >= workerCount) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, paceMs);
            timer.unref?.();
            signal.addEventListener('abort', onAbort, { once: true });
          });
          signal.throwIfAborted();
        }
        try {
          await retryReceiptDiscovery(async () => {
            const pending = await readPendingAutonomousReceipts(this.session.scope(`agents/${agentId}`), this.logs, this.documents, signal);
            signal.throwIfAborted();
            if (Object.keys(pending).length === 0) return;
            await enqueueMaterialize(async () => {
              signal.throwIfAborted();
              if (this.agentLifecycle.get(agentId) !== undefined) return;
              const parentId = agent.parentAgentId ?? MAIN_AGENT_ID;
              if (this.agentLifecycle.get(parentId) === undefined) {
                const parent = meta.agents?.[parentId];
                await this.agentLifecycle.create({ agentId: parentId, delegator: parent?.delegator ?? (parent?.parentAgentId === undefined || parent.parentAgentId === null ? undefined : { kind: 'agent', agentId: parent.parentAgentId }) });
              }
              signal.throwIfAborted();
              if (this.agentLifecycle.get(agentId) === undefined) {
                await this.agentLifecycle.create({ agentId, delegator: agent.delegator ?? { kind: 'agent', agentId: parentId } });
              }
            });
          }, signal);
        } catch (error) {
          signal.throwIfAborted();
          complete = false;
          this.log.error('autonomous subagent receipt discovery failed', { agentId, error });
        }
      }
    });
    await Promise.all(workers);
    return complete;
  }

  async run(agentId: string, request: AgentRunRequest, opts: RunAgentOptions): Promise<AgentRunHandle> {
    this.cancelRelease(agentId);
    const handle = this.agentLifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    try {
      if (agentId !== MAIN_AGENT_ID && request.kind === 'prompt') {
        const scope = optionalFromHandle(handle, IAgentScopeContext);
        const profileData = optionalFromHandle(handle, IAgentProfileService)?.data();
        const targetName = profileData?.routeId ?? profileData?.profileName ?? agentId;
        const profileName = profileData?.profileName ?? targetName;
        await this.hooks.onWillStartAgentTask.run({
          agentName: targetName,
          prompt: request.prompt,
          signal: opts.signal,
          agentId: scope?.agentId ?? agentId,
          parentAgentId: scope?.parentAgentId,
          agentRole: scope === undefined ? 'subagent' : scope.parentAgentId === undefined ? 'root' : 'subagent',
          profileName,
          routeId: profileData?.routeId,
          appendReminder: (content, origin) => {
            const reminder = optionalFromHandle(handle, IAgentSystemReminderService);
            if (reminder !== undefined) {
              reminder.appendSystemReminder(content, origin);
              return;
            }
            optionalFromHandle(handle, IAgentContextMemoryService)?.appendObservable({
              role: 'user',
              content: [{ type: 'text', text: wrapSystemReminder(content) }],
              toolCalls: [],
              origin,
            });
          },
        });
        opts.signal.throwIfAborted();
      }
      const branchMailbox = request.kind === 'mailbox' && this.metadata.snapshot().agents?.[agentId]?.labels?.['branch'] === 'true';
      const run = await handle.accessor
        .get(IAgentExecutionService)
        .run(request, {
          parentReceiptManaged: !branchMailbox,
          summaryPolicy: branchMailbox ? undefined : opts.summaryPolicy ?? this.summaryPolicyFor(handle),
          signal: opts.signal,
          onReady: opts.onReady,
          onQueued: opts.onQueued,
          onBeforeExternalRun: opts.onBeforeExternalRun,
          onExternalRunNotSent: opts.onExternalRunNotSent,
          capacityReservation: opts.capacityReservation,
        });
      const settle = (): void => {
        if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
      };
      void run.completion.then(settle, settle);
      return run;
    } catch (error) {
      if (this.agentLifecycle.get(agentId) === handle) this.scheduleRelease(agentId);
      throw error;
    }
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

  async adviseReturn(context: Parameters<NonNullable<ISessionSubagentService['adviseReturn']>>[0]): Promise<string> {
    const extensions = this.extensions?.current;
    if (extensions?.hasSubagentReturnAdvisors !== true) return context.summary;
    try {
      const proposal = await extensions.proposeSubagentReturn({ ...context, sessionId: this.session.sessionId });
      if (proposal.advisoryNote === undefined || !proposal.advisoryNote.trim()) return context.summary;
      return `${context.summary}\n\n<subagent-advisory>\n${proposal.advisoryNote.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}\n</subagent-advisory>`;
    } catch (error) {
      this.log.warn('Extension subagent return advice failed', { error, childAgentId: context.childAgentId });
      return context.summary;
    }
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
    if (this.retained.has(handle) || Object.keys(handle.accessor.get(IAgentStateService).get(autonomousReceiptsKey).pending).length > 0 ||
      [...this.pendingReceipts].some((receipt) => receipt.child === handle) || !isReleasable(handle)) {
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

function optionalFromHandle<T>(handle: IAgentScopeHandle, id: ServiceIdentifier<T>): T | undefined {
  try {
    return handle.accessor.get(id);
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionSubagentService,
  SessionSubagentService,
  ScopeActivation.OnScopeCreated,
  'subagent',
);

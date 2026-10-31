import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { BugIndicatingError } from '#/_base/errors/errors';
import { defineState } from '#/state/state';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { buildSessionSummary } from '#/app/sessionIndex/sessionIndexSource';
import { addSessionUsage } from '#/app/sessionIndex/sessionUsageSummary';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import { AgentOutcomeDocuments } from './agentOutcomeStore';
import {
  ISessionMetadata,
  SESSION_META_VERSION,
  type AgentMeta,
  type SessionMeta,
  type SessionMetadataChangedEvent,
  type SessionMetaPatch,
  type SessionTitleKind,
} from './sessionMetadata';

const META_KEY = 'state.json';
const USAGE_FLUSH_DELAY_MS = 1_000;
const AGENT_UPDATE_WINDOW_MS = 50;

interface AgentUpdateBatch {
  readonly mutations: Array<{
    readonly apply: (agents: Record<string, AgentMeta>) => boolean;
    readonly touchUpdatedAt: boolean;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }>;
  readonly release: () => void;
  readonly ready: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

const metadataInstances = new Set<SessionMetadata>();
const pendingActivityPropagation = new Set<Promise<void>>();

/** Drains every session at process shutdown; session lifecycle operations use their own metadata.drain(). */
export async function drainSessionMetadataWrites(includeActivityPropagation = true): Promise<void> {
  const results = await Promise.allSettled([...metadataInstances].map((metadata) => metadata.drain()));
  if (includeActivityPropagation) {
    await Promise.allSettled(pendingActivityPropagation);
    results.push(...await Promise.allSettled([...metadataInstances].map((metadata) => metadata.drain())));
  }
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Session metadata writes failed');
}

export function trackSessionMetadataWork(work: Promise<void>): void {
  const tracked = work.catch(() => {});
  pendingActivityPropagation.add(tracked);
  void tracked.finally(() => pendingActivityPropagation.delete(tracked));
}

export const sessionMetadataDataKey = defineState<SessionMeta | undefined>(
  'sessionMetadata.data',
  () => undefined,
);

export class SessionMetadata extends Service implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;

  private disposed = false;
  private disposing = false;
  private initialized = false;
  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;

  private readonly _onDidChangeMetadata = this._register(
    new Emitter<SessionMetadataChangedEvent>(),
  );
  private readonly scope: string;
  private updateQueue: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Set<Promise<void>>();
  private agentBatch: AgentUpdateBatch | undefined;
  private createdDocument = false;
  private usageDirty = false;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private usageFlushInFlight: Promise<void> | undefined;
  private readonly flushUsage = (): Promise<void> => {
    if (this.usageTimer !== undefined) {
      clearTimeout(this.usageTimer);
      this.usageTimer = undefined;
    }
    const ongoing = this.usageFlushInFlight;
    if (ongoing !== undefined) return ongoing;
    if (!this.usageDirty || this.disposed) return Promise.resolve();
    const flush = this.flushUsageNow();
    this.usageFlushInFlight = flush;
    void flush.then(
      () => {
        if (this.usageFlushInFlight === flush) this.usageFlushInFlight = undefined;
      },
      () => {
        if (this.usageFlushInFlight === flush) this.usageFlushInFlight = undefined;
      },
    );
    return flush;
  };
  private readonly onUsageTimer = (): void => {
    void this.flushUsage().catch(() => {});
  };

  private readonly deferredChanges = new Set<keyof SessionMeta>();
  private detached: { readonly source: SessionMeta; readonly value: SessionMeta } | undefined;
  private readonly outcomes: AgentOutcomeDocuments;

  private async persist(): Promise<void> {
    await this.store.set(this.scope, META_KEY, encodeSessionMeta(await this.outcomes.project(this.data)));
  }

  private deferChanges(changed: readonly (keyof SessionMeta)[]): void {
    for (const key of changed) this.deferredChanges.add(key);
    this.usageDirty = true;
    if (this.usageTimer !== undefined) return;
    this.usageTimer = setTimeout(this.onUsageTimer, USAGE_FLUSH_DELAY_MS);
    this.usageTimer.unref?.();
  }

  private async flushUsageNow(): Promise<void> {
    if (!this.disposed && this.usageDirty) {
      this.usageDirty = false;
      const changed = [...this.deferredChanges];
      this.deferredChanges.clear();
      try {
        await this.enqueueUpdate(async () => {
          if (this.disposed) return;
          await this.persist();
          if (this.disposed) return;
          this.mirrorToReadModel();
          this._onDidChangeMetadata.fire({ changed });
        });
      } catch (error) {
        this.usageDirty = true;
        for (const key of changed) this.deferredChanges.add(key);
        this.log.warn('session deferred metadata write failed', {
          sessionId: this.ctx.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
    @ISessionIndexMirror private readonly mirror: ISessionIndexMirror,
  ) {
    super();
    this._register({
      dispose: () => {
        this.disposed = true;
        metadataInstances.delete(this);
        if (this.usageTimer !== undefined) clearTimeout(this.usageTimer);
        this.usageTimer = undefined;
      },
    });
    metadataInstances.add(this);
    this.states.contributeState(sessionMetadataDataKey);
    this.scope = ctx.metaScope;
    this.outcomes = new AgentOutcomeDocuments(store, this.scope, (agentId, error) => {
      this.log.warn('agent outcome sidecar write failed; retaining the complete inline receipt', {
        sessionId: this.ctx.sessionId, agentId, error: error instanceof Error ? error.message : String(error),
      });
    });
    this.onDidChangeMetadata = this._onDidChangeMetadata.event;
    this.ready = this.load().then(() => { this.initialized = true; });
  }

  override async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposing = true;
    let flushError: unknown;
    let flushFailed = false;
    try {
      await this.drain();
    } catch (error) {
      flushFailed = true;
      flushError = error;
    }
    this.disposed = true;
    metadataInstances.delete(this);
    if (this.usageTimer !== undefined) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
    let disposeError: unknown;
    let disposeFailed = false;
    try {
      await super.dispose();
    } catch (error) {
      disposeFailed = true;
      disposeError = error;
    }
    if (flushFailed && disposeFailed) {
      throw new AggregateError([flushError, disposeError], 'Session metadata disposal failed');
    }
    if (flushFailed) throw flushError;
    if (disposeFailed) throw disposeError;
  }

  private get data(): SessionMeta {
    return this.states.get(sessionMetadataDataKey) as SessionMeta;
  }

  private set data(value: SessionMeta) {
    this.states.set(sessionMetadataDataKey, value);
  }

  async read(): Promise<SessionMeta> {
    await this.ready;
    return this.data;
  }

  snapshot(): SessionMeta {
    if (!this.initialized) throw new BugIndicatingError('Session metadata snapshot requires ready');
    const data = this.data;
    if (this.detached?.source !== data) this.detached = { source: data, value: structuredClone(data) };
    return this.detached.value;
  }

  async getAgentExecutor(agentId: string): Promise<string | undefined> {
    await this.ready;
    return this.data.agents?.[agentId]?.executor;
  }

  usage(): SessionMeta['usage'] {
    return this.data.usage;
  }

  createdByLoad(): boolean {
    return this.createdDocument;
  }

  recordUsage(model: string, usage: TokenUsage, usageKnown?: boolean): void {
    if (this.disposed || this.disposing) return;
    this.data = { ...this.data, usage: addSessionUsage(this.data.usage, model, usage, usageKnown) };
    this.deferChanges(['usage']);
  }

  async update(
    patch: SessionMetaPatch,
    opts?: { readonly touchUpdatedAt?: boolean; readonly deferPersistence?: boolean },
  ): Promise<void> {
    if (opts?.deferPersistence === true) {
      const work = this.ready.then(() => {
        if (this.disposed || this.disposing) return;
        if (patch.agents !== undefined) throw new BugIndicatingError('Agent metadata requires an immediate durable update');
        this.mergePatch(patch, opts);
        this.deferChanges(Object.keys(patch) as (keyof SessionMeta)[]);
      });
      return this.trackWrite(work);
    }
    return this.enqueueUpdate(async () => {
      await this.applyUpdate(patch, opts);
    });
  }

  private mergePatch(patch: SessionMetaPatch, opts?: { readonly touchUpdatedAt?: boolean }): void {
    const updatedAt =
      patch.updatedAt ?? (opts?.touchUpdatedAt === false ? this.data.updatedAt : Date.now());
    const activityUpdatedAt = patch.activityUpdatedAt === undefined ? this.data.activityUpdatedAt
      : Math.max(this.data.activityUpdatedAt ?? 0, patch.activityUpdatedAt);
    const agents = patch.agents === undefined ? this.data.agents : Object.fromEntries(
      Object.entries(patch.agents).map(([agentId, meta]) => {
        const existing = this.data.agents?.[agentId];
        return [agentId, existing === undefined || existing.createdAt === meta.createdAt ? meta : { ...meta, createdAt: existing.createdAt }];
      }),
    );
    this.data = { ...this.data, ...patch, agents, updatedAt, activityUpdatedAt };
  }

  private async applyUpdate(patch: SessionMetaPatch, opts?: { readonly touchUpdatedAt?: boolean }): Promise<boolean> {
    await this.ready;
    if (this.disposed) return false;
    this.mergePatch(patch, opts);
    await this.persist();
    if (this.disposed) return false;
    this.mirrorToReadModel();
    this._onDidChangeMetadata.fire({
      changed: Object.keys(patch) as (keyof SessionMeta)[],
    });
    return true;
  }

  async setTitle(title: string): Promise<void> {
    await this.update({ title, titleKind: 'custom' }, { touchUpdatedAt: false });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    return this.enqueueUpdate(async () => {
      await this.ready;
      if (opts?.force !== true && this.data.titleKind === 'custom') return false;
      return this.applyUpdate({ title, titleKind: 'generated' }, { touchUpdatedAt: false });
    });
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.update(
      archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: undefined },
      { touchUpdatedAt: false },
    );
  }

  registerAgent(agentId: string, meta: AgentMeta): Promise<void> {
    return this.enqueueAgentUpdate((agents) => {
      const existing = agents[agentId];
      const next = existing === undefined ? structuredClone(meta) : { ...structuredClone(meta), createdAt: existing.createdAt };
      if (existing !== undefined && agentMetaEquals(existing, next)) return false;
      agents[agentId] = next;
      return true;
    });
  }

  updateAgent(agentId: string, updater: (current: AgentMeta) => AgentMeta): Promise<void> {
    return this.enqueueAgentUpdate((agents) => {
      const current = agents[agentId];
      if (current === undefined) return false;
      const updated = updater(structuredClone(current));
      const next = { ...updated, createdAt: current.createdAt };
      if (agentMetaEquals(current, next)) return false;
      agents[agentId] = next;
      return true;
    });
  }

  unregisterAgent(agentId: string): Promise<void> {
    return this.enqueueAgentUpdate((agents) => {
      if (agents[agentId] === undefined) return false;
      delete agents[agentId];
      return true;
    }, true);
  }

  private enqueueAgentUpdate(apply: (agents: Record<string, AgentMeta>) => boolean, touchUpdatedAt = false): Promise<void> {
    if (this.disposed || this.disposing) return Promise.resolve();
    if (this.agentBatch === undefined) {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const batch: AgentUpdateBatch = { mutations: [], ready, release: () => {
        if (batch.timer !== undefined) clearTimeout(batch.timer);
        batch.timer = undefined;
        if (this.agentBatch === batch) this.agentBatch = undefined;
        release();
      } };
      this.agentBatch = batch;
      batch.timer = setTimeout(batch.release, AGENT_UPDATE_WINDOW_MS);
      const run = this.enqueueUpdate(async () => {
        await batch.ready;
        await this.ready;
        const previous = this.data.agents;
        const previousUpdatedAt = this.data.updatedAt;
        const agents = { ...previous };
        let changed = false;
        let touched = false;
        for (const mutation of batch.mutations) {
          try {
            const applied = mutation.apply(agents);
            changed ||= applied;
            touched ||= applied && mutation.touchUpdatedAt;
          } catch (error) { mutation.reject(error); }
        }
        if (!changed || this.disposed) return;
        this.data = { ...this.data, agents, updatedAt: touched ? Date.now() : previousUpdatedAt };
        try {
          await this.persist();
        } catch (error) {
          this.data = { ...this.data, agents: previous, updatedAt: previousUpdatedAt };
          throw error;
        }
        this.mirrorToReadModel();
        this._onDidChangeMetadata.fire({ changed: ['agents'] });
      }, false);
      void run.then(
        () => { for (const mutation of batch.mutations) mutation.resolve(); },
        (error: unknown) => { for (const mutation of batch.mutations) mutation.reject(error); },
      );
    }
    const batch = this.agentBatch;
    return new Promise<void>((resolve, reject) => { batch.mutations.push({ apply, touchUpdatedAt, resolve, reject }); });
  }

  async drain(): Promise<void> {
    if (this.disposed) return;
    this.agentBatch?.release();
    await this.ready.catch(() => undefined);
    if (!this.initialized) {
      await Promise.allSettled(this.pendingWrites);
      return;
    }
    const results = await Promise.allSettled([...this.pendingWrites, this.flushUsage()]);
    const remaining = await Promise.allSettled(this.pendingWrites);
    const failures = [...new Set([...results, ...remaining].flatMap((result) => result.status === 'rejected' ? [result.reason] : []))];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Session metadata drain failed');
    if (this.usageDirty) await this.flushUsage();
  }

  private trackWrite<T>(run: Promise<T>): Promise<T> {
    const tracked = run.then(() => undefined);
    this.pendingWrites.add(tracked);
    void tracked.then(() => this.pendingWrites.delete(tracked), () => this.pendingWrites.delete(tracked));
    return run;
  }

  private enqueueUpdate<T>(work: () => Promise<T>, releaseBatch = true): Promise<T> {
    if (releaseBatch) this.agentBatch?.release();
    const run = this.updateQueue.then(work, work);
    this.updateQueue = run.then(() => undefined, () => undefined);
    return this.trackWrite(run);
  }

  private mirrorToReadModel(): void {
    if (this.ctx.ephemeral === true) return;
    try {
      this.mirror.record(
        buildSessionSummary({
          id: this.data.id,
          workspaceId: this.ctx.workspaceId,
          cwd: this.ctx.cwd,
          worktree: this.data.worktree,
          title: this.data.title,
          lastPrompt: this.data.lastPrompt,
          delivery: this.data.delivery,
          createdAt: this.data.createdAt,
          updatedAt: this.data.updatedAt,
          activityUpdatedAt: this.data.activityUpdatedAt,
          archived: this.data.archived === true,
          archivedAt: this.data.archivedAt,
          custom: this.data.custom,
          lastTurnReason: this.data.lastTurnReason,
          usage: this.data.usage,
          agents: this.data.agents,
        }),
      );
    } catch (error) {
      this.log.warn('session index mirror record failed; the read model heals by reconciliation', {
        sessionId: this.ctx.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async load(): Promise<void> {
    const existing = await this.store.get<SessionMeta>(this.scope, META_KEY);
    if (existing !== undefined) {
      this.data = await this.outcomes.hydrate(normalizeSessionMeta(existing, this.ctx.sessionId));
      if (
        this.data.agents === undefined ||
        this.data.custom === undefined ||
        sessionMetaTitleNeedsMigration(existing, this.data)
      ) {
        if (this.data.agents === undefined) {
          this.createdDocument = true;
        }
        this.data = {
          ...this.data,
          agents: this.data.agents ?? {},
          custom: this.data.custom ?? {},
        };
        await this.persist();
      }
      return;
    }
    const now = Date.now();
    this.data = {
      id: this.ctx.sessionId,
      version: SESSION_META_VERSION,
      cwd: this.ctx.cwd,
      delivery: 'reply',
      createdAt: now,
      updatedAt: now,
      archived: false,
      agents: {},
      custom: {},
    };
    await this.persist();
    this.createdDocument = true;
    this.mirrorToReadModel();
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

function agentMetaEquals(a: AgentMeta, b: AgentMeta): boolean {
  return (
    a.createdAt === b.createdAt &&
    a.homedir === b.homedir &&
    a.type === b.type &&
    (a.parentAgentId ?? null) === (b.parentAgentId ?? null) &&
    delegatorEquals(a.delegator, b.delegator) &&
    a.forkedFrom === b.forkedFrom &&
    a.displayName === b.displayName &&
    a.userLabel === b.userLabel &&
    a.personaId === b.personaId &&
    a.model === b.model &&
    a.thinkingEffort === b.thinkingEffort &&
    a.thinkingEffortExplicit === b.thinkingEffortExplicit &&
    a.executor === b.executor &&
    a.executorProtocol === b.executorProtocol &&
    JSON.stringify(a.execution) === JSON.stringify(b.execution) &&
    JSON.stringify(a.executorAuth) === JSON.stringify(b.executorAuth) &&
    JSON.stringify(a.negotiated) === JSON.stringify(b.negotiated) &&
    a.allowKikiSubagents === b.allowKikiSubagents &&
    a.status === b.status &&
    a.completedAt === b.completedAt &&
    a.resultSummary === b.resultSummary &&
    a.error === b.error &&
    a.taskId === b.taskId &&
    JSON.stringify(a.usage) === JSON.stringify(b.usage) &&
    a.contextTokens === b.contextTokens &&
    a.toolCallCount === b.toolCallCount &&
    recordEquals(a.labels, b.labels)
  );
}

function delegatorEquals(a: AgentMeta['delegator'], b: AgentMeta['delegator']): boolean {
  if (a?.kind !== b?.kind) return false;
  if (a === undefined || b === undefined) return true;
  return a.kind === 'agent' && b.kind === 'agent'
    ? a.agentId === b.agentId
    : a.kind === 'external' && b.kind === 'external' && a.delegationId === b.delegationId;
}

function recordEquals(a: AgentMeta['labels'], b: AgentMeta['labels']): boolean {
  const entriesA = Object.entries(a ?? {});
  const entriesB = Object.entries(b ?? {});
  return (
    entriesA.length === entriesB.length && entriesA.every(([key, value]) => b?.[key] === value)
  );
}

export function normalizeSessionMeta(raw: SessionMeta, sessionId: string): SessionMeta {
  const legacy = raw as unknown as LegacySessionMeta;
  const normalizedTitle = normalizeSessionTitle(legacy);
  const {
    createdAt: legacyCreatedAt,
    updatedAt: legacyUpdatedAt,
    workDir: legacyWorkDir,
    titleSource: _legacyTitleSource,
    isCustomTitle: _legacyIsCustomTitle,
    customTitle: _legacyCustomTitle,
    ...clean
  } = legacy;
  const cwd =
    clean.cwd ?? (typeof legacyWorkDir === 'string' && legacyWorkDir.length > 0
      ? legacyWorkDir
      : undefined);
  const { title, titleKind } = normalizedTitle;
  return {
    ...clean,
    id: clean.version === SESSION_META_VERSION ? clean.id : sessionId,
    version: SESSION_META_VERSION,
    cwd,
    title,
    titleKind,
    createdAt: toEpochMs(legacyCreatedAt),
    updatedAt: toEpochMs(legacyUpdatedAt),
    archived: clean.archived === true,
  };
}

type LegacySessionMeta = Omit<SessionMeta, 'createdAt' | 'updatedAt'> & {
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly workDir?: unknown;
  readonly titleSource?: unknown;
  readonly isCustomTitle?: unknown;
  readonly customTitle?: unknown;
};

function normalizeSessionTitle(
  raw: LegacySessionMeta,
): Pick<SessionMeta, 'title' | 'titleKind'> {
  const title = typeof raw.title === 'string' ? raw.title : undefined;
  if (title !== undefined && raw.isCustomTitle === true) {
    return { title, titleKind: 'custom' };
  }
  if (title !== undefined && isSessionTitleKind(raw.titleKind)) {
    return { title, titleKind: raw.titleKind };
  }
  if (title !== undefined && raw.isCustomTitle === false) {
    return { title, titleKind: 'replaceable' };
  }
  if (typeof raw.customTitle === 'string') {
    return { title: raw.customTitle, titleKind: 'custom' };
  }
  return title === undefined ? {} : { title, titleKind: 'replaceable' };
}

function isSessionTitleKind(value: unknown): value is SessionTitleKind {
  return value === 'replaceable' || value === 'generated' || value === 'custom';
}

type PersistedSessionMeta = SessionMeta & { readonly isCustomTitle: boolean };

export function encodeSessionMeta(meta: SessionMeta): PersistedSessionMeta {
  return { ...meta, isCustomTitle: meta.titleKind === 'custom' };
}

function sessionMetaTitleNeedsMigration(raw: SessionMeta, normalized: SessionMeta): boolean {
  const record = raw as unknown as Record<string, unknown>;
  return (
    raw.title !== normalized.title ||
    raw.titleKind !== normalized.titleKind ||
    record['isCustomTitle'] !== (normalized.titleKind === 'custom') ||
    Object.hasOwn(record, 'titleSource') ||
    Object.hasOwn(record, 'customTitle')
  );
}

export function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetadata,
  SessionMetadata,
  ScopeActivation.OnScopeCreated,
  'sessionMetadata',
);

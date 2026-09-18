
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import {
  type CreateChildSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionDeletedEvent,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  type SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  DEFAULT_SESSION_RESIDENCY_CONFIG,
  SESSION_RESIDENCY_SECTION,
  type SessionResidencyConfig,
} from './configSection';
import { SESSION_IDLE_EVICTION_FLAG_ID } from './flag';
import {
  ISessionManager,
  type CreateManagedSessionOptions,
  type SessionLease,
  type SessionResidencyReport,
  type UnguardedSessionLifecycle,
} from './sessionManager';

interface SessionResidencyEntry {
  pins: number;
  idleSince: number | undefined;
  lastAccess: number;
  generation: number;
  activitySubscription?: IDisposable;
}

interface SessionControllerEntry {
  readonly workspaceId: string;
  readonly generation: string;
  readonly controller: SessionLifecycleService;
  readonly subscriptions: DisposableStore;
  sessionCount: number;
}

export class SessionManager implements ISessionManager {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly owners = new Map<string, SessionLifecycleService>();
  private readonly pendingResumes = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly resumeFailures = new Map<string, Error>();
  private readonly lifecycleChains = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, SessionControllerEntry>();
  private readonly controllerEntries = new Set<SessionControllerEntry>();
  private readonly controllerWorkspaces = new Map<SessionLifecycleService, string>();
  private readonly workspaceOperations = new Map<string, Set<Promise<unknown>>>();
  private readonly closingWorkspaces = new Set<string>();
  private readonly residency = new Map<string, SessionResidencyEntry>();
  private evictionTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private activeRestores = 0;
  private readonly restoreQueue: Array<() => void> = [];
  private evictionAttempts = 0;
  private evictionSuccesses = 0;
  private evictionFailures = 0;
  private readonly willCreateEmitter = new Emitter<SessionWillCreateEvent>();
  readonly onWillCreateSession: Event<SessionWillCreateEvent> = this.willCreateEmitter.event;
  private readonly didCreateEmitter = new Emitter<SessionCreatedEvent & IWaitUntil>();
  readonly onDidCreateSession = this.didCreateEmitter.event;
  private readonly willCloseEmitter = new Emitter<SessionWillCloseEvent & IWaitUntil>();
  readonly onWillCloseSession = this.willCloseEmitter.event;
  private readonly didCloseEmitter = new Emitter<SessionClosedEvent>();
  readonly onDidCloseSession = this.didCloseEmitter.event;
  private readonly didArchiveEmitter = new Emitter<SessionArchivedEvent>();
  readonly onDidArchiveSession = this.didArchiveEmitter.event;
  private readonly didDeleteEmitter = new Emitter<SessionDeletedEvent>();
  readonly onDidDeleteSession = this.didDeleteEmitter.event;
  private readonly didForkEmitter = new Emitter<SessionForkedEvent>();
  readonly onDidForkSession = this.didForkEmitter.event;

  constructor(
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ISessionIndex private readonly index: ISessionIndex,
    @IConfigService private readonly config?: IConfigService,
    @IFlagService private readonly flags?: IFlagService,
  ) {
    void this.startEvictionScheduler();
  }

  async create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle> {
    const lease = await this.workspaces.acquire(
      options.workspaceId === undefined
        ? { root: options.workDir }
        : { workspaceId: options.workspaceId, root: options.workDir },
    );
    const workspaceId = lease.instance.id;
    const create = () =>
      this.runWorkspaceOperation(
        workspaceId,
        () => this.controllerForWorkspace(workspaceId).create(options),
        () => lease.dispose(),
      );
    if (options.sessionId === undefined) return create();
    return this.serializeLifecycle(options.sessionId, create);
  }

  resume(
    sessionId: string,
    options?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    this.touchResidency(sessionId);
    const inflight = this.pendingResumes.get(sessionId);
    if (inflight !== undefined) return inflight;
    this.resumeFailures.delete(sessionId);
    const promise = this.serializeLifecycle(sessionId, async () => {
      const releaseRestore = await this.reserveRestoreSlot(sessionId);
      try {
        const target = await this.controllerForSession(sessionId);
        if (target === undefined) return undefined;
        return this.runWorkspaceOperation(
          target.workspaceId,
          () => target.controller.resume(sessionId, options),
          target.release,
        );
      } finally {
        releaseRestore();
      }
    }).finally(() => this.pendingResumes.delete(sessionId));
    this.pendingResumes.set(sessionId, promise);
    void promise.then(
      (handle) => {
        if (handle === undefined && !this.sessions.has(sessionId)) this.dropResidency(sessionId);
      },
      (error: unknown) => {
        this.resumeFailures.set(
          sessionId,
          error instanceof Error ? error : new Error('session resume failed'),
        );
        if (!this.sessions.has(sessionId)) this.dropResidency(sessionId);
      },
    );
    return promise;
  }

  async acquire(
    sessionId: string,
    _reason: string,
    options?: ResumeSessionOptions,
  ): Promise<SessionLease | undefined> {
    const entry = this.ensureResidency(sessionId);
    entry.pins += 1;
    entry.generation += 1;
    entry.idleSince = undefined;
    let released = false;
    try {
      const handle = await this.resume(sessionId, options);
      if (handle === undefined) {
        this.releasePin(sessionId, entry);
        return undefined;
      }
      return {
        handle,
        dispose: () => {
          if (released) return;
          released = true;
          this.releasePin(sessionId, entry);
        },
      };
    } catch (error) {
      this.releasePin(sessionId, entry);
      throw error;
    }
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    const handle = this.sessions.get(sessionId);
    if (handle !== undefined) this.touchResidency(sessionId);
    return handle;
  }

  residencyReport(): SessionResidencyReport {
    let pinnedSessions = 0;
    let idleSessions = 0;
    for (const entry of this.residency.values()) {
      if (entry.pins > 0) pinnedSessions += 1;
      else if (entry.idleSince !== undefined) idleSessions += 1;
    }
    return {
      liveSessions: this.sessions.size,
      pinnedSessions,
      idleSessions,
      pendingRestores: this.pendingResumes.size,
      lifecycleOperations: this.lifecycleChains.size,
      evictionAttempts: this.evictionAttempts,
      evictionSuccesses: this.evictionSuccesses,
      evictionFailures: this.evictionFailures,
    };
  }

  async evictIfIdle(sessionId: string): Promise<boolean> {
    if (!this.evictionEnabled()) return false;
    return this.serializeLifecycle(sessionId, async () => {
      const entry = this.residency.get(sessionId);
      const controller = this.owners.get(sessionId);
      if (entry === undefined || controller === undefined || entry.pins > 0) return false;
      const idleSince = entry.idleSince;
      if (idleSince === undefined) return false;
      const config = this.residencyConfig();
      const capacityPressure = this.sessions.size > config.maxLiveSessions;
      const minimum = capacityPressure ? config.minIdleMs : config.idleTtlMs;
      if (Date.now() - idleSince < minimum) return false;
      const generation = entry.generation;
      this.evictionAttempts += 1;
      try {
        if (entry.generation !== generation || entry.pins > 0) return false;
        const workspaceId = this.controllerWorkspaces.get(controller);
        if (workspaceId === undefined) return false;
        if (controller.unload === undefined) return false;
        const unloaded = await this.runWorkspaceOperation(
          workspaceId,
          () => controller.unload!(
            sessionId,
            () => entry.generation === generation && entry.pins === 0,
          ),
        );
        if (unloaded) this.evictionSuccesses += 1;
        return unloaded;
      } catch (error) {
        this.evictionFailures += 1;
        if (this.residency.get(sessionId) === entry) entry.idleSince = Date.now();
        throw error;
      }
    });
  }

  async whenResumeSettled(sessionId: string): Promise<void> {
    await this.pendingResumes.get(sessionId);
    const failure = this.resumeFailures.get(sessionId);
    if (failure !== undefined) throw failure;
    await this.owners.get(sessionId)?.whenResumeSettled(sessionId);
  }

  private serializeLifecycle<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleChains.set(sessionId, next);
    void next.finally(() => {
      if (this.lifecycleChains.get(sessionId) === next) this.lifecycleChains.delete(sessionId);
    });
    return run;
  }

  private serializeLifecycleForKeys<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = keys;
    if (first === undefined) return work();
    return this.serializeLifecycle(first, () => this.serializeLifecycleForKeys(rest, work));
  }

  private lifecycleKeys(...ids: (string | undefined)[]): string[] {
    return [...new Set(ids.filter((id): id is string => id !== undefined))].sort();
  }

  withLifecycleSerialization<T>(
    sessionId: string,
    work: (unguarded: UnguardedSessionLifecycle) => Promise<T>,
  ): Promise<T> {
    return this.serializeLifecycle(sessionId, () =>
      work({
        archive: () => this.archiveInner(sessionId),
        restore: () => this.restoreInner(sessionId),
      }),
    );
  }

  list(): readonly ISessionScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, async () => {
      const controller = this.owners.get(sessionId);
      if (controller === undefined) return;
      const workspaceId = this.controllerWorkspaces.get(controller);
      if (workspaceId === undefined) return;
      await this.runWorkspaceOperation(workspaceId, () => controller.close(sessionId));
    });
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    this.closingWorkspaces.add(workspaceId);
    try {
      await this.waitForWorkspaceOperations(workspaceId);
      const entries = [...this.controllerEntries].filter(
        (entry) => entry.workspaceId === workspaceId,
      );
      for (const entry of entries) {
        for (const handle of entry.controller.list()) await entry.controller.close(handle.id);
      }
      for (const entry of entries) this.retireEntryIfIdle(workspaceId, entry);
    } finally {
      this.closingWorkspaces.delete(workspaceId);
    }
  }

  private async archiveInner(sessionId: string): Promise<void> {
    const target = await this.controllerForSession(sessionId);
    if (target === undefined) return;
    await this.runWorkspaceOperation(
      target.workspaceId,
      () => target.controller.archive(sessionId),
      target.release,
    );
  }

  async archive(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, () => this.archiveInner(sessionId));
  }

  private async restoreInner(
    sessionId: string,
    options?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const target = await this.controllerForSession(sessionId);
    if (target === undefined) return undefined;
    return this.runWorkspaceOperation(
      target.workspaceId,
      () => target.controller.restore(sessionId, options),
      target.release,
    );
  }

  async restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    return this.serializeLifecycle(sessionId, () => this.restoreInner(sessionId, options));
  }

  async delete(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, async () => {
      const target = await this.controllerForSession(sessionId);
      if (target === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      await this.runWorkspaceOperation(
        target.workspaceId,
        () => target.controller.delete(sessionId, () => this.didDeleteEmitter.fire({ sessionId })),
        target.release,
      );
    });
  }

  async fork(options: ForkSessionOptions): Promise<ISessionScopeHandle> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const target = await this.controllerForSession(options.sourceSessionId);
        if (target === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return this.runWorkspaceOperation(
          target.workspaceId,
          () => target.controller.fork(options),
          target.release,
        );
      },
    );
  }

  async createChild(options: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const target = await this.controllerForSession(options.sourceSessionId);
        if (target === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return this.runWorkspaceOperation(
          target.workspaceId,
          () => target.controller.createChild(options),
          target.release,
        );
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.evictionTimer !== undefined) clearInterval(this.evictionTimer);
    for (const state of this.residency.values()) state.activitySubscription?.dispose();
    this.residency.clear();
    for (const { controller, subscriptions } of [...this.controllerEntries].reverse()) {
      subscriptions.dispose();
      controller.dispose();
    }
    this.controllerEntries.clear();
    this.controllers.clear();
    this.controllerWorkspaces.clear();
    this.workspaceOperations.clear();
    this.closingWorkspaces.clear();
    this.sessions.clear();
    this.owners.clear();
    this.pendingResumes.clear();
    this.resumeFailures.clear();
    this.lifecycleChains.clear();
    this.willCreateEmitter.dispose();
    this.didCreateEmitter.dispose();
    this.willCloseEmitter.dispose();
    this.didCloseEmitter.dispose();
    this.didArchiveEmitter.dispose();
    this.didDeleteEmitter.dispose();
    this.didForkEmitter.dispose();
  }

  private async reserveRestoreSlot(sessionId: string): Promise<() => void> {
    if (this.sessions.has(sessionId)) return () => {};
    const config = this.residencyConfig();
    if (this.activeRestores >= config.maxConcurrentRestores) {
      if (this.restoreQueue.length >= config.maxQueuedRestores) {
        throw new Error('session restore queue is full');
      }
      await new Promise<void>((resolve) => this.restoreQueue.push(resolve));
    }
    this.activeRestores += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRestores = Math.max(0, this.activeRestores - 1);
      this.restoreQueue.shift()?.();
    };
  }

  private ensureResidency(sessionId: string): SessionResidencyEntry {
    let entry = this.residency.get(sessionId);
    if (entry === undefined) {
      entry = {
        pins: 0,
        idleSince: Date.now(),
        lastAccess: Date.now(),
        generation: 0,
      };
      this.residency.set(sessionId, entry);
    }
    return entry;
  }

  private touchResidency(sessionId: string): void {
    const entry = this.ensureResidency(sessionId);
    entry.lastAccess = Date.now();
    entry.generation += 1;
    if (entry.pins === 0) entry.idleSince = Date.now();
  }

  private registerResidency(sessionId: string, handle: ISessionScopeHandle): void {
    const entry = this.ensureResidency(sessionId);
    entry.activitySubscription?.dispose();
    const update = (): void => {
      try {
        const state = handle.accessor.get(ISessionActivityView).state();
        entry.idleSince = entry.pins === 0 && !state.busy && state.pendingInteraction === 'none'
          ? (entry.idleSince ?? Date.now())
          : undefined;
      } catch {
        entry.idleSince = entry.pins === 0 ? (entry.idleSince ?? Date.now()) : undefined;
      }
      entry.generation += 1;
    };
    try {
      entry.activitySubscription = handle.accessor.get(ISessionActivityView).onDidChange(update);
    } catch {
      entry.activitySubscription = undefined;
    }
    update();
  }

  private releasePin(sessionId: string, expected: SessionResidencyEntry): void {
    const entry = this.residency.get(sessionId);
    if (entry !== expected) return;
    entry.pins = Math.max(0, entry.pins - 1);
    entry.generation += 1;
    if (entry.pins === 0) {
      const handle = this.sessions.get(sessionId);
      if (handle === undefined) {
        this.dropResidency(sessionId);
      } else {
        this.registerResidency(sessionId, handle);
      }
    }
  }

  private dropResidency(sessionId: string): void {
    const entry = this.residency.get(sessionId);
    entry?.activitySubscription?.dispose();
    this.residency.delete(sessionId);
  }

  private residencyConfig(): Required<SessionResidencyConfig> {
    const configured = this.config?.get<SessionResidencyConfig>(SESSION_RESIDENCY_SECTION) ?? {};
    return { ...DEFAULT_SESSION_RESIDENCY_CONFIG, ...configured };
  }

  private evictionEnabled(): boolean {
    return this.flags?.enabled(SESSION_IDLE_EVICTION_FLAG_ID) === true;
  }

  private async startEvictionScheduler(): Promise<void> {
    await this.config?.ready;
    if (this.disposed || !this.evictionEnabled() || this.evictionTimer !== undefined) return;
    const interval = this.residencyConfig().sweepIntervalMs;
    this.evictionTimer = setInterval(() => void this.evictOne().catch(() => undefined), interval);
    this.evictionTimer.unref?.();
  }

  private async evictOne(): Promise<void> {
    if (!this.evictionEnabled()) return;
    const candidates = [...this.residency.entries()]
      .filter(([, entry]) => entry.pins === 0 && entry.idleSince !== undefined)
      .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
    for (const [sessionId] of candidates) {
      if (await this.evictIfIdle(sessionId)) return;
    }
  }

  private controllerForWorkspace(workspaceId: string): SessionLifecycleService {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error(`workspace ${workspaceId} is not materialized`);
    const generation = workspace.program.sessionControllerGeneration;
    const existing = this.controllers.get(workspaceId);
    if (existing?.generation === generation) return existing.controller;
    const controller = workspace.program.createSessionController();
    const subscriptions = new DisposableStore();
    const entry: SessionControllerEntry = {
      workspaceId,
      generation,
      controller,
      subscriptions,
      sessionCount: 0,
    };
    subscriptions.add(controller.onWillCreateSession((event) => this.willCreateEmitter.fire(event)));
    subscriptions.add(controller.onDidCreateSession((event) => {
      entry.sessionCount += 1;
      this.sessions.set(event.sessionId, event.handle);
      this.owners.set(event.sessionId, controller);
      this.registerResidency(event.sessionId, event.handle);
      this.didCreateEmitter.fire(event);
    }));
    subscriptions.add(controller.onWillCloseSession((event) => this.willCloseEmitter.fire(event)));
    subscriptions.add(controller.onDidCloseSession((event) => {
      entry.sessionCount -= 1;
      this.sessions.delete(event.sessionId);
      this.owners.delete(event.sessionId);
      this.dropResidency(event.sessionId);
      this.didCloseEmitter.fire(event);
      this.retireEntryIfIdle(workspaceId, entry);
    }));
    subscriptions.add(controller.onDidArchiveSession((event) => {
      entry.sessionCount -= 1;
      this.sessions.delete(event.sessionId);
      this.owners.delete(event.sessionId);
      this.dropResidency(event.sessionId);
      this.didArchiveEmitter.fire(event);
      this.retireEntryIfIdle(workspaceId, entry);
    }));
    subscriptions.add(controller.onDidForkSession((event) => this.didForkEmitter.fire(event)));
    this.controllerEntries.add(entry);
    this.controllerWorkspaces.set(controller, workspaceId);
    this.controllers.set(workspaceId, entry);
    if (existing !== undefined) this.retireEntryIfIdle(workspaceId, existing);
    return controller;
  }

  private retireEntryIfIdle(workspaceId: string, entry: SessionControllerEntry): void {
    if (entry.sessionCount !== 0 || !this.controllerEntries.has(entry)) return;
    this.controllerEntries.delete(entry);
    this.controllerWorkspaces.delete(entry.controller);
    if (this.controllers.get(workspaceId) === entry) this.controllers.delete(workspaceId);
    entry.subscriptions.dispose();
    entry.controller.dispose();
  }

  private async controllerForSession(sessionId: string): Promise<{
    readonly workspaceId: string;
    readonly controller: SessionLifecycleService;
    readonly release?: () => void;
  } | undefined> {
    const live = this.owners.get(sessionId);
    if (live !== undefined) {
      const workspaceId = this.controllerWorkspaces.get(live);
      if (workspaceId === undefined) return undefined;
      return { workspaceId, controller: live };
    }
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const lease = await this.workspaces.acquire({
      workspaceId: summary.workspaceId,
      root: summary.cwd,
    });
    try {
      return {
        workspaceId: lease.instance.id,
        controller: this.controllerForWorkspace(lease.instance.id),
        release: () => lease.dispose(),
      };
    } catch (error) {
      lease.dispose();
      throw error;
    }
  }

  private runWorkspaceOperation<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    release?: () => void,
  ): Promise<T> {
    if (this.closingWorkspaces.has(workspaceId)) {
      release?.();
      return Promise.reject(new Error(`workspace ${workspaceId} is closing`));
    }
    const promise = Promise.resolve().then(operation);
    let operations = this.workspaceOperations.get(workspaceId);
    if (operations === undefined) {
      operations = new Set();
      this.workspaceOperations.set(workspaceId, operations);
    }
    operations.add(promise);
    return promise.finally(() => {
      operations.delete(promise);
      if (operations.size === 0) this.workspaceOperations.delete(workspaceId);
      release?.();
    });
  }

  private async waitForWorkspaceOperations(workspaceId: string): Promise<void> {
    while (true) {
      const operations = this.workspaceOperations.get(workspaceId);
      if (operations === undefined || operations.size === 0) return;
      await Promise.allSettled([...operations]);
    }
  }
}

registerScopedService(LifecycleScope.App, ISessionManager, SessionManager, ScopeActivation.OnScopeCreated, 'sessionManager');

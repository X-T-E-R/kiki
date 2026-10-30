import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event, IWaitUntil } from '#/_base/event';
import type {
  CreateChildSessionOptions,
  CreateSessionOptions,
  ForkSessionOptions,
  ResumeSessionOptions,
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionForkedEvent,
  SessionWillCloseEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

export interface CreateManagedSessionOptions extends CreateSessionOptions {
  readonly workspaceId?: string;
}

export interface UnguardedSessionLifecycle {
  archive(): Promise<void>;
  restore(): Promise<ISessionScopeHandle | undefined>;
  delete(): Promise<void>;
}

export interface SessionLease extends IDisposable {
  readonly handle: ISessionScopeHandle;
}

export interface SessionResidencyReport {
  readonly liveSessions: number;
  readonly pinnedSessions: number;
  readonly idleSessions: number;
  readonly pendingRestores: number;
  readonly lifecycleOperations: number;
  readonly evictionAttempts: number;
  readonly evictionSuccesses: number;
  readonly evictionFailures: number;
  /** Eviction candidates skipped before `unload`, by reason. */
  readonly evictionSkips?: Readonly<Record<string, number>>;
  /** `unload` refusals that kept a session resident, by reason. */
  readonly unloadRefusals?: Readonly<Record<string, number>>;
  /** Currently held session leases, by acquisition reason. */
  readonly pinsByReason?: Readonly<Record<string, number>>;
}

export interface ISessionManager {
  readonly _serviceBrand: undefined;
  readonly onWillCreateSession?: Event<SessionWillCreateEvent>;
  readonly onDidCreateSession?: Event<SessionCreatedEvent & IWaitUntil>;
  readonly onWillCloseSession?: Event<SessionWillCloseEvent & IWaitUntil>;
  readonly onDidCloseSession?: Event<SessionClosedEvent>;
  readonly onDidArchiveSession?: Event<SessionArchivedEvent>;
  readonly onDidDeleteSession?: Event<SessionDeletedEvent>;
  readonly onDidForkSession?: Event<SessionForkedEvent>;
  create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle>;
  resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  acquire?(sessionId: string, reason: string, options?: ResumeSessionOptions, signal?: AbortSignal): Promise<SessionLease | undefined>;
  acquireLive?(sessionId: string, reason: string): Promise<SessionLease | undefined>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  residencyReport?(): SessionResidencyReport;
  evictIfIdle?(sessionId: string, options?: { readonly ignoreIdleTtl?: boolean }): Promise<boolean>;
  whenResumeSettled(sessionId: string): Promise<void>;
  withLifecycleSerialization<T>(
    sessionId: string,
    work: (unguarded: UnguardedSessionLifecycle) => Promise<T>,
  ): Promise<T>;
  list(): readonly ISessionScopeHandle[];
  listEphemeral(): readonly ISessionScopeHandle[];
  isEphemeral(sessionId: string): boolean;
  saveEphemeral(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  closeWorkspace?(workspaceId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  delete(sessionId: string): Promise<void>;
  fork(options: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(options: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionManager: ServiceIdentifier<ISessionManager> = createDecorator<ISessionManager>('sessionManager');

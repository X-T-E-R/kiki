import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { DelegatorRef } from '#/session/sessionMetadata/sessionMetadata';

export const MAIN_AGENT_ID = 'main';

export interface CreateAgentOptions {
  readonly agentId?: string;
  readonly binding?: BindAgentInput;
  readonly runtimeId?: string;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly delegator?: DelegatorRef;
  readonly userLabel?: string;
  readonly restoreBinding?: AgentRestoreBinding;
  /** Internal session-fork hook: copied journals belong to a new entity, not a restored identity. */
  readonly copiedIdentity?: boolean;
  /** Internal transaction hook: publish onDidCreate only after the caller commits. */
  readonly deferCreateEvent?: boolean;
}

export interface ForkAgentOptions {
  readonly agentId?: string;
  readonly binding?: Partial<BindAgentInput>;
}

export interface AgentRestoreBinding {
  readonly profileName?: string;
  readonly routeId?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly executorId?: string;
  readonly executorProtocol?: string;
}

export interface AgentListFilter {
  readonly prefix?: string;
}

export type AgentRemovalMode = 'cancel' | 'preserve-pending';
export type AgentCallerOutcome = 'resolved' | 'rejected';
export type AgentCleanupOutcome = 'closed' | 'cleanup_failed';
export type AgentFailureDomain = 'persistence' | 'cleanup';

export interface AgentCleanupReceipt {
  readonly operationId: string;
  readonly agentId: string;
  readonly mode: AgentRemovalMode;
  readonly callerOutcome: AgentCallerOutcome;
  readonly terminalOwner: 'agent';
  readonly cleanupOutcome: AgentCleanupOutcome;
  readonly resourcesBefore: number;
  readonly resourcesAfter: number;
  readonly failureDomain?: AgentFailureDomain;
  readonly errorCode?: string;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly settledAt: number;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;

  /** Fires synchronously after the Agent scope is sealed and before replayable state restore. */
  readonly onWillCreate: Event<IAgentScopeHandle>;
  /** Fires after restore, binding, activation, and durable identity registration complete. */
  readonly onDidCreate: Event<IAgentScopeHandle>;
  readonly onDidDispose: Event<string>;
  readonly onDidCleanup?: Event<AgentCleanupReceipt>;

  /** Generated identities never reuse an existing wire journal; explicit agentId enables restoration. */
  create(opts?: CreateAgentOptions): Promise<IAgentScopeHandle>;
  commitCreate(agentId: string): void;
  /** Remove an incomplete allocation from live state and metadata, retaining its journal as a reserved identity. */
  discard(agentId: string): Promise<void>;

  fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle>;

  /** Return only a fully restored, bound, and activated live agent scope. */
  get(agentId: string): IAgentScopeHandle | undefined;
  /** List only fully restored, bound, and activated live agent scopes. */
  list(filter?: AgentListFilter): readonly IAgentScopeHandle[];
  broadcastPermissionMode(mode: PermissionMode): void;
  /** Pending tasks across live agents, including descendants. */
  countPendingBackgroundTasks(): number;
  /** Suppress terminal notifications and drain live tasks within the supplied deadline. */
  drainBackgroundTasks(timeoutMs: number): Promise<void>;
  remove(agentId: string, mode?: AgentRemovalMode): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');

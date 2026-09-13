import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { ProfileData } from '#/agent/profile/profile';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileCatalogSnapshot } from '#/app/agentProfileCatalog/scopedAgentProfile';
import type { Runtime } from '#/runtime/runtime';
import type { DelegatorRef, AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { AgentRunHandle, AgentRunRequest } from '#/session/subagent/subagent';

export interface DispatchResolvedBinding {
  readonly model: string;
  readonly thinking?: string;
}

export interface DispatchLaunchInput {
  readonly capturedLaunchPolicy?: import('./launchPolicy').DispatchLaunchPolicy;
  readonly delegator: DelegatorRef;
  readonly requesterAgentId: string;
  readonly requesterProfileData?: ProfileData;
  readonly profileName?: string;
  readonly routeId?: string;
  readonly snapshot?: AgentProfileCatalogSnapshot;
  readonly message: string;
  readonly name?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly permissionMode?: PermissionMode;
  readonly permissionModeCeiling?: PermissionMode;
  readonly resolvedBinding?: DispatchResolvedBinding;
  readonly strictThinking?: boolean;
  readonly strictThinkingFromProfile?: boolean;
  readonly runtime: Runtime;
  readonly runtimeId?: string;
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly labels?: Readonly<Record<string, string>>;
  readonly userLabel?: string;
  readonly swarmItem?: string;
  readonly parentTurnId?: number;
  readonly executorPolicy?: 'any' | 'native';
  readonly onReady?: () => void;
  /**
   * Runs before creation is announced or execution starts. A rejection discards the new child
   * unless retain was called after durable ownership was written, before fallible publication.
   * Retained children survive launch failures for recovery; execution failures never discard them.
   */
  readonly onCreated?: (child: DispatchChild, retain: () => void) => Promise<void>;
}

export type DispatchIdlePolicy = 'execution' | 'quiescent';

export interface DispatchRunOptions {
  readonly capturedLaunchPolicy?: import('./launchPolicy').DispatchLaunchPolicy;
  readonly signal: AbortSignal;
  readonly requesterAgentId?: string;
  readonly onReady?: () => void;
  readonly lineage?: string;
  readonly idlePolicy?: DispatchIdlePolicy;
  readonly bindingOverride?: {
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly allowModelChange?: boolean;
  };
  readonly onBeforeRun?: (child: DispatchChild) => Promise<void>;
}

export interface DispatchChild {
  readonly agent: IAgentScopeHandle;
  readonly agentId: string;
  readonly name?: string;
  readonly profileName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort: string;
  readonly effectiveProfile?: AgentProfile;
  readonly meta?: AgentMeta;
}

export interface DispatchRun {
  readonly child: DispatchChild;
  readonly request: AgentRunRequest;
  readonly started: Promise<AgentRunHandle>;
  readonly lineage?: string;
}

export interface DispatchDelegatedRunEvent {
  readonly requesterAgentId: string;
  readonly agentId: string;
}

export interface DispatchWaitSource<T> {
  readonly onDidChange: Event<void>;
  read(): readonly T[];
  key(item: T): string;
  terminal(item: T): boolean;
  blockedKey?(): string | undefined;
}

export interface DispatchWaitResult<T> {
  readonly waitStatus: 'completed' | 'timed_out' | 'no_items' | 'blocked';
  readonly waitedMs: number;
  readonly item?: T;
  readonly completedDuringWait: readonly T[];
}

export interface ISessionDispatchService {
  readonly _serviceBrand: undefined;
  registerPlanStateReader(requesterAgentId: string, read: () => boolean): import('#/_base/di/lifecycle').IDisposable;
  readLaunchPolicy(requesterAgentId: string): import('./launchPolicy').DispatchLaunchPolicy;
  readonly onDidDelegateRun: Event<DispatchDelegatedRunEvent>;
  reserveExecution(agentId: string, parentAgentId?: string, reservation?: import('./capacity').DispatchReservation): () => void;
  reserveTurnExecution(agentId: string, parentAgentId?: string): () => void;
  launch(input: DispatchLaunchInput): Promise<DispatchRun>;
  resolveOwnedChild(delegator: DelegatorRef, ref: string): Promise<DispatchChild>;
  runOnExisting(
    child: DispatchChild,
    request: string | Extract<AgentRunRequest, { kind: 'retry' }>,
    options: DispatchRunOptions,
  ): Promise<DispatchRun>;
  recordRun(agentId: string, runId: string): Promise<void>;
  recordDelegatedRun(requesterAgentId: string, agentId: string): void;
  wait<T>(
    source: DispatchWaitSource<T>,
    options: { readonly key?: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<DispatchWaitResult<T>>;
}

export const ISessionDispatchService: ServiceIdentifier<ISessionDispatchService> =
  createDecorator<ISessionDispatchService>('sessionDispatchService');

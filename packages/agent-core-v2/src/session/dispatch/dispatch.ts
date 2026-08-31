import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
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
  readonly resolvedBinding?: DispatchResolvedBinding;
  readonly strictThinking?: boolean;
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
  readonly onCreated?: (child: DispatchChild) => Promise<void>;
}

export interface DispatchRunOptions {
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly lineage?: string;
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

export interface DispatchWaitSource<T> {
  readonly onDidChange: Event<void>;
  read(): readonly T[];
  key(item: T): string;
  terminal(item: T): boolean;
}

export interface DispatchWaitResult<T> {
  readonly waitStatus: 'completed' | 'timed_out' | 'no_items';
  readonly waitedMs: number;
  readonly item?: T;
  readonly completedDuringWait: readonly T[];
}

export interface ISessionDispatchService {
  readonly _serviceBrand: undefined;
  launch(input: DispatchLaunchInput): Promise<DispatchRun>;
  resolveOwnedChild(delegator: DelegatorRef, ref: string): Promise<DispatchChild>;
  runOnExisting(
    child: DispatchChild,
    request: string | Extract<AgentRunRequest, { kind: 'retry' }>,
    options: DispatchRunOptions,
  ): Promise<DispatchRun>;
  recordRun(agentId: string, runId: string): Promise<void>;
  wait<T>(
    source: DispatchWaitSource<T>,
    options: { readonly key?: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<DispatchWaitResult<T>>;
}

export const ISessionDispatchService: ServiceIdentifier<ISessionDispatchService> =
  createDecorator<ISessionDispatchService>('sessionDispatchService');

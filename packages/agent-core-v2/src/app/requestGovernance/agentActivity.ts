import type { RequestPermit } from '#/kosong/model/requestAdmission';
import type { RequestConcurrencyRule } from './configSection';

export type AgentActivityRole = 'main' | 'subagent' | 'independent';
export type AgentActivityPhase = 'starting' | 'running' | 'tool_waiting' | 'suspended' | 'cancelling' | 'finalizing';
export type AgentActivityDimension = 'executor' | 'profile' | 'model' | 'role' | 'session';

export interface AgentExecutionAttempt {
  readonly sessionId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly ancestorAgentIds: readonly string[];
  readonly executorId?: string;
  readonly profileId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly role: AgentActivityRole;
  readonly readPhase: () => AgentActivityPhase;
}

export interface AgentActivityCounts {
  readonly active: number;
  readonly queued: number;
  readonly main: number;
  readonly subagent: number;
  readonly independent: number;
  readonly queuedMain: number;
  readonly queuedSubagent: number;
  readonly queuedIndependent: number;
}

export interface AgentActivitySnapshot extends AgentActivityCounts {
  readonly domainId: string;
  readonly runtimeEpoch: string;
  readonly seq: number;
  readonly asOf: string;
  readonly coverage: 'this_process';
  readonly unit: 'agent_execution';
  readonly dimensions: readonly (AgentActivityCounts & { readonly dimension: AgentActivityDimension; readonly id: string | null })[];
  readonly agents: readonly {
    readonly sessionId: string;
    readonly agentId: string;
    readonly parentAgentId?: string;
    readonly executorId?: string;
    readonly profileId?: string;
    readonly modelId?: string;
    readonly providerId?: string;
    readonly role: AgentActivityRole;
    readonly phase: AgentActivityPhase;
    readonly startedAt: string;
  }[];
  readonly waiting: readonly {
    readonly sessionId: string;
    readonly agentId: string;
    readonly executorId?: string;
    readonly profileId?: string;
    readonly modelId?: string;
    readonly role: AgentActivityRole;
    readonly waitedMs: number;
    readonly blockingRules: readonly string[];
  }[];
  readonly rules: readonly RequestConcurrencyRule[];
}

export interface AgentActivityAdmission {
  acquireAgent(attempt: AgentExecutionAttempt, signal?: AbortSignal): Promise<RequestPermit>;
  agentSnapshot(): AgentActivitySnapshot;
}

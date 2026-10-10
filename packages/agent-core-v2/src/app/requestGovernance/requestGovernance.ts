import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { IRequestAdmission, type RequestAdmissionPort } from '#/kosong/model/requestAdmission';
import type { RequestConcurrencyRule } from './configSection';
import type { AgentActivityAdmission } from './agentActivity';
export * from './agentActivity';

export interface RequestGovernanceSnapshot {
  readonly domainId: string;
  readonly runtimeEpoch: string;
  readonly seq: number;
  readonly asOf: string;
  readonly coverage: { readonly native: 'managed'; readonly external: 'unmanaged' };
  readonly active: number;
  readonly queued: number;
  readonly dimensions: readonly { readonly dimension: 'model' | 'provider' | 'session' | 'role'; readonly id: string; readonly active: number; readonly queued: number }[];
  readonly rules: readonly RequestConcurrencyRule[];
  readonly waiting: readonly { readonly attemptId: string; readonly sessionId?: string; readonly agentId?: string; readonly modelId: string; readonly providerId: string; readonly purpose: string; readonly waitedMs: number; readonly blockingRules: readonly string[] }[];
}

export interface IRequestGovernance extends RequestAdmissionPort, AgentActivityAdmission {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<void>;
  snapshot(): RequestGovernanceSnapshot;
}

export const IRequestGovernance = IRequestAdmission as ServiceIdentifier<IRequestGovernance>;

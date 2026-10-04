import { createDecorator } from '#/_base/di/instantiation';

export interface IRequestAdmission extends RequestAdmissionPort {
  readonly _serviceBrand: undefined;
}

export const IRequestAdmission = createDecorator<IRequestAdmission>('requestAdmission');

interface RequestIdentity {
  readonly logicalRequestId: string;
  readonly waitBudget: { waitedMs: number };
}

export type RequestAttribution = RequestIdentity & (
  | { readonly sessionId: string; readonly agentId: string; readonly parentAgentId?: string; readonly purpose: string }
  | { readonly sessionId?: never; readonly agentId?: never; readonly parentAgentId?: never; readonly purpose: 'connectivity_probe' }
);

export type RequestAttempt = RequestAttribution & {
  readonly attemptId: string;
  readonly modelId: string;
  readonly providerId: string;
};

export interface RequestPermit {
  release(): void;
}

export interface RequestAdmissionPort {
  acquire(attempt: RequestAttempt, signal?: AbortSignal): Promise<RequestPermit>;
}

import { createDecorator } from '#/_base/di/instantiation';

export interface IRequestAdmission extends RequestAdmissionPort {
  readonly _serviceBrand: undefined;
}

export const IRequestAdmission = createDecorator<IRequestAdmission>('requestAdmission');

export interface RequestAttribution {
  readonly logicalRequestId: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly purpose: string;
  readonly waitBudget: { waitedMs: number };
}

export interface RequestAttempt extends RequestAttribution {
  readonly attemptId: string;
  readonly modelId: string;
  readonly providerId: string;
}

export interface RequestPermit {
  release(): void;
}

export interface RequestAdmissionPort {
  acquire(attempt: RequestAttempt, signal?: AbortSignal): Promise<RequestPermit>;
}

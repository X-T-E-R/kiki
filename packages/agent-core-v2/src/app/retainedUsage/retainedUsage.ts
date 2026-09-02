import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { UsageRecordScope } from '#/agent/usage/usageOps';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import type { TokenUsage } from '#/kosong/contract/usage';

export const RETAINED_USAGE_VERSION = 1 as const;

export interface RetainedUsageRecord {
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageScope?: UsageRecordScope;
  readonly turnId?: number;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly provider?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly executorId?: string;
}

export interface RetainedDeletedSessionUsage extends SessionSummary {
  readonly version: typeof RETAINED_USAGE_VERSION;
  readonly deleted: true;
  readonly deletedAt: number;
  readonly records: readonly RetainedUsageRecord[];
  readonly complete: boolean;
}

export interface RetainedUsageListQuery {
  readonly workspaceIds?: readonly string[];
}

export interface IRetainedUsageService {
  readonly _serviceBrand: undefined;
  retainDeletedSession(summary: SessionSummary): Promise<RetainedDeletedSessionUsage>;
  listDeletedSessions(
    query?: RetainedUsageListQuery,
  ): Promise<readonly RetainedDeletedSessionUsage[]>;
}

export const IRetainedUsageService: ServiceIdentifier<IRetainedUsageService> =
  createDecorator<IRetainedUsageService>('retainedUsageService');

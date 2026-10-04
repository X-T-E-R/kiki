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
  readonly usageKnown?: boolean;
}

export interface RetainedDeletedSessionUsage extends SessionSummary {
  readonly version: typeof RETAINED_USAGE_VERSION;
  readonly deleted: true;
  readonly deletedAt: number;
  readonly records: readonly RetainedUsageRecord[];
  readonly complete: boolean;
}

export type RetainedUsageIncompleteReason = 'deadline' | 'record_budget';

export interface RetainedUsageListQuery {
  readonly workspaceIds?: readonly string[];
  readonly deadlineAt: number;
  readonly recordLimit: number;
  readonly signal?: AbortSignal;
}

export interface RetainedUsageListResult {
  readonly items: readonly RetainedDeletedSessionUsage[];
  readonly complete: boolean;
  readonly incompleteReason?: RetainedUsageIncompleteReason;
  readonly scannedRecords: number;
}

export interface EphemeralUsageTotal {
  readonly workspaceId: string;
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageKnown?: boolean;
}

export type RetainedUsageExportEvent =
  | { readonly kind: 'progress' }
  | { readonly kind: 'session'; readonly snapshot: RetainedDeletedSessionUsage }
  | { readonly kind: 'ephemeral'; readonly record: EphemeralUsageTotal }
  | { readonly kind: 'incomplete' };

export interface IRetainedUsageService {
  readonly _serviceBrand: undefined;
  retainDeletedSession(summary: SessionSummary): Promise<RetainedDeletedSessionUsage>;
  listDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult>;
  readExportUsage?(includeEphemeral: boolean, signal?: AbortSignal): AsyncGenerator<RetainedUsageExportEvent>;
  retainEphemeralUsage?(sessionScope: string, workspaceId: string): Promise<void>;
  listEphemeralUsage?(query: RetainedUsageListQuery): Promise<{
    readonly items: readonly EphemeralUsageTotal[];
    readonly complete: boolean;
    readonly scannedRecords: number;
    readonly incompleteReason?: RetainedUsageIncompleteReason;
  }>;
}

export const IRetainedUsageService: ServiceIdentifier<IRetainedUsageService> =
  createDecorator<IRetainedUsageService>('retainedUsageService');

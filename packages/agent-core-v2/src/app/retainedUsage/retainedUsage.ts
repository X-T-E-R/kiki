import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { UsageRecordScope } from '#/agent/usage/usageOps';
import type { UsageFactTotals } from '#/agent/usage/usageFact';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import type { TokenUsage } from '#/kosong/contract/usage';

export const RETAINED_USAGE_VERSION = 1 as const;
export const RETAINED_USAGE_SCOPE = 'store' as const;
export const DELETED_PRIVACY_DIR = 'deleted-private-sessions' as const;
export const RETAINED_USAGE_KEY = 'deleted-sessions-v2.jsonl';
export const EPHEMERAL_USAGE_KEY = 'ephemeral-totals-v1.jsonl';
export const OPERATION_USAGE_KEY = 'session-operations-v1.jsonl';

export function deletedPrivacyKey(workspaceId: string, sessionId: string): string {
  return `${Buffer.from(JSON.stringify([workspaceId, sessionId])).toString('base64url')}.json`;
}

export type OperationUsageSession = Pick<SessionSummary, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'archived' | 'private'>;

export interface OperationUsageRecord extends Omit<RetainedUsageRecord, 'turnId' | 'usageScope' | 'agentId' | 'usageKnown'> {
  readonly agentId: string;
  readonly usageKnown: boolean;
  readonly requestKind: string;
}

export function operationUsageSource(workspaceId: string, sessionId: string): string {
  return `operation:${workspaceId}\0${sessionId}`;
}

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
  | { readonly kind: 'operation'; readonly session: OperationUsageSession; readonly record: RetainedUsageRecord; readonly position: number }
  | { readonly kind: 'incomplete' };

export interface IRetainedUsageService {
  readonly _serviceBrand: undefined;
  readonly operationWritesPending?: boolean;
  privateSessions(signal?: AbortSignal): Promise<readonly Pick<SessionSummary, 'id' | 'workspaceId'>[]>;
  recordOperation(session: OperationUsageSession, record: OperationUsageRecord): Promise<void>;
  readOperationSummary(workspaceId: string, sessionId: string, query: RetainedUsageListQuery): Promise<{ readonly totals?: UsageFactTotals; readonly revision?: number; readonly complete: boolean }>;
  retainDeletedSession(summary: SessionSummary): Promise<RetainedDeletedSessionUsage>;
  readModelImportProgress?(signal?: AbortSignal): Promise<readonly { readonly source: string; readonly size: number; readonly readBytes: number; readonly complete: boolean }[]>;
  listDeletedSessions(query: RetainedUsageListQuery): Promise<RetainedUsageListResult>;
  prepareReadModel?(query: RetainedUsageListQuery, includeEphemeral?: boolean): Promise<{ readonly complete: boolean; readonly scannedRecords: number; readonly incompleteReason?: RetainedUsageIncompleteReason }>;
  readExportUsage?(includeEphemeral: boolean, signal?: AbortSignal): AsyncGenerator<RetainedUsageExportEvent, { readonly operationsComplete: boolean } | void>;
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

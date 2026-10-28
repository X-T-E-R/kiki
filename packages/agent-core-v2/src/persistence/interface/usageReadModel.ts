import { createDecorator } from '#/_base/di/instantiation';
import type { UsageFact, UsageFactTotals } from '#/agent/usage/usageFact';
import type { UsageFactCheckpoint, UsageFactRange } from '#/app/usageFacts/usageFactStore';

export interface UsageSourceHead {
  readonly dataGeneration: string;
  readonly checkpoint?: UsageFactCheckpoint;
  readonly pendingCheckpoint?: UsageFactCheckpoint;
  readonly journalOffset: number;
  readonly journalSize: number;
  readonly ordinal: number;
  readonly revision: number;
}

export interface UsageImportProgress {
  readonly batchStart: number;
  readonly offset: number;
  readonly ordinal: number;
  readonly parser?: object;
}

export interface UsageSourcePage {
  readonly source: string;
  readonly expected?: UsageImportProgress;
  readonly progress: UsageImportProgress;
  readonly records: readonly UsageFact[];
  readonly reset?: boolean;
  readonly publish?: { readonly start: number; readonly checkpoint: UsageFactCheckpoint; readonly journalSize: number; readonly source?: string; readonly session?: UsageReadModelSession };
  readonly continuation?: UsageImportProgress;
}

export interface UsageReadModelSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly ephemeral?: boolean;
  readonly deletedAt?: number;
  readonly complete?: boolean;
}

export interface UsageReadModelQuote {
  readonly model: string;
  readonly inputOther?: number;
  readonly output?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
}

export interface UsageReadModelQuery {
  readonly startAt?: number;
  readonly endAt?: number;
  readonly granularity: 'day' | 'week' | 'month' | 'session' | 'five_hour';
  readonly dimension: 'agent' | 'model' | 'project' | 'session' | 'provider' | 'profile';
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly profiles: readonly string[];
  readonly agentIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly includeArchived: boolean;
  readonly timezoneOffsetMinutes: number;
  readonly pageSize: number;
  readonly position?: readonly [number, string];
  readonly quotes: readonly UsageReadModelQuote[];
  readonly expectedRevision?: string;
  readonly drilldownSessionLimit: number;
  readonly drilldownTurnLimit: number;
}

export interface UsageReadModelAggregate {
  readonly usage: { readonly inputOther: number; readonly output: number; readonly inputCacheRead: number; readonly inputCacheCreation: number };
  readonly cost: number;
  readonly costUnknown: boolean;
  readonly knownRecords: number;
  readonly missingRecords: number;
  readonly legacyZeroRecords: number;
}

export interface UsageReadModelResult {
  readonly revision: string;
  readonly total: UsageReadModelAggregate;
  readonly earliestAt?: number;
  readonly latestAt?: number;
  readonly sessionCount: number;
  readonly incompleteSessions: number;
  readonly scannedSessions: number;
  readonly includesDeletedSessions: boolean;
  readonly unknownPriceModels: readonly string[];
  readonly trend: readonly {
    readonly key: string;
    readonly startAt: number;
    readonly endAt: number;
    readonly requests: number;
    readonly turns: number;
    readonly groups: readonly (UsageReadModelAggregate & { readonly key: string; readonly provider: string | null; readonly modelAlias: string | null; readonly agentId: string | null; readonly parentAgentId: string | null; readonly profileName: string | null })[];
    readonly sessions: readonly { readonly id: string; readonly turnIds: readonly number[]; readonly turns: number; readonly unknownTurnRecords: number }[];
    readonly sessionsTruncated: boolean;
  }[];
  readonly sessions: readonly (UsageReadModelAggregate & { readonly session: UsageReadModelSession; readonly primaryModel?: string; readonly profileNames: readonly string[]; readonly unknownPriceModels: readonly string[] })[];
  readonly hasMore: boolean;
}

/** Source-level derived accounting. Pages, source totals and contiguous coverage publish atomically; staged rows are never visible before their envelope commits. SQL is confined to the persistence backend. */
export interface IUsageReadModel {
  readonly _serviceBrand: undefined;
  source(source: string, signal?: AbortSignal): Promise<UsageSourceHead | undefined>;
  sources(signal?: AbortSignal): Promise<readonly { readonly source: string; readonly head: UsageSourceHead }[]>;
  progress(source: string, signal?: AbortSignal): Promise<UsageImportProgress | undefined>;
  apply(page: UsageSourcePage): Promise<boolean>;
  abandon(source: string): Promise<void>;
  invalidate(source: string): Promise<void>;
  read(source: string, range?: UsageFactRange, offset?: number, limit?: number, signal?: AbortSignal, until?: number): Promise<{ readonly head?: UsageSourceHead; readonly records: readonly UsageFact[]; readonly nextOffset?: number }>;
  summary(source: string, signal?: AbortSignal): Promise<{ readonly head?: UsageSourceHead; readonly totals?: UsageFactTotals }>;
  catalog(sessions: readonly UsageReadModelSession[], sources: readonly { readonly source: string; readonly workspaceId: string; readonly sessionId: string }[], inventory?: boolean): Promise<void>;
  settleRetained(ledger: string, generation: string): Promise<void>;
  retained(workspaceIds?: readonly string[], signal?: AbortSignal): Promise<readonly { readonly source: string; readonly session: UsageReadModelSession }[]>;
  models(signal?: AbortSignal): Promise<readonly string[]>;
  query(query: UsageReadModelQuery, signal?: AbortSignal): Promise<UsageReadModelResult>;
  close(): Promise<void>;
}

export const IUsageReadModel = createDecorator<IUsageReadModel>('usageReadModel');

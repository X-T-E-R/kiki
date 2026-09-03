import { createHash } from 'node:crypto';

import {
  AGENT_WIRE_RECORD_KEY,
  IAppendLogStore,
  IFileSystemStorageService,
  IRetainedUsageService,
  ISessionIndex,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type RetainedUsageRecord,
  type Scope,
  type SessionSummary,
  type TokenUsage,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import type { UsageAggregateWire, UsageQuery, UsageResponse } from '@moonshot-ai/protocol';

import { IModelPricingService } from '../pricing/modelPricingService';

const DEFAULT_PAGE_SIZE = 50;
const INDEX_PAGE_SIZE = 100;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS: UsageAggregationLimits = {
  sessionScanLimit: 500,
  wireRecordBudget: 200_000,
  deadlineMs: 1_500,
  cacheTtlMs: 30_000,
  cacheMaxEntries: 256,
  cacheMaxRecords: 50_000,
  cacheMaxEntryRecords: 10_000,
  drilldownSessionLimit: 100,
  drilldownTurnLimit: 100,
};

export interface UsageAggregationLimits {
  readonly sessionScanLimit: number;
  readonly wireRecordBudget: number;
  readonly deadlineMs: number;
  readonly cacheTtlMs: number;
  readonly cacheMaxEntries: number;
  readonly cacheMaxRecords: number;
  readonly cacheMaxEntryRecords: number;
  readonly drilldownSessionLimit: number;
  readonly drilldownTurnLimit: number;
}

interface NormalizedUsageRecord {
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly turnId?: number;
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly provider?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
}

interface SessionRecords {
  readonly summary: SessionSummary;
  readonly records: readonly NormalizedUsageRecord[];
  readonly complete: boolean;
  readonly deleted: boolean;
}

interface SessionCacheEntry {
  readonly expiresAt: number;
  readonly records: readonly NormalizedUsageRecord[];
  readonly scannedRecordCount: number;
}

interface ScanBudget {
  remainingRecords: number;
  readonly deadlineAt: number;
  sourcesComplete: boolean;
  incompleteReason: UsageResponse['reliability']['incomplete_reason'];
}

interface RangeBounds {
  readonly preset: UsageResponse['query']['range']['preset'];
  readonly startAt?: number;
  readonly endAt?: number;
  readonly defaultedToAllHistory: boolean;
}

interface NormalizedQuery {
  readonly granularity: UsageResponse['query']['granularity'];
  readonly range: RangeBounds;
  readonly dimension: UsageResponse['query']['dimension'];
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly agentIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly includeArchived: boolean;
  readonly timezoneOffsetMinutes: number;
  readonly pageSize: number;
}

interface ListedSessions {
  readonly items: readonly SessionSummary[];
  readonly activeKeys: ReadonlySet<string>;
}

interface AggregateAccumulator {
  usage: TokenUsage;
  cost: number;
  costUnknown: boolean;
}

interface GroupAccumulator extends AggregateAccumulator {
  readonly key: string;
  readonly providers: Set<string | null>;
  readonly modelAliases: Set<string | null>;
  readonly agentIds: Set<string | null>;
  readonly parentAgentIds: Set<string | null>;
  readonly profileNames: Set<string | null>;
}

interface DrilldownSessionAccumulator {
  readonly sessionId: string;
  readonly turnIds: Set<number>;
  unknownTurnRecords: number;
}

interface BucketAccumulator {
  readonly key: string;
  startAt: number;
  endAt: number;
  readonly groups: Map<string, GroupAccumulator>;
  readonly drilldownSessions: Map<string, DrilldownSessionAccumulator>;
  drilldownSessionsTruncated: boolean;
}

interface SessionAccumulator extends AggregateAccumulator {
  readonly summary: SessionSummary;
  readonly deleted: boolean;
  readonly unknownPriceModels: Set<string>;
}

export class UsagePageTokenMismatchError extends Error {}

export class UsageAggregationService {
  private readonly cache = new Map<string, SessionCacheEntry>();
  private readonly limits: UsageAggregationLimits;
  private cachedRecordCount = 0;

  constructor(
    private readonly core: Scope,
    private readonly now: () => number = Date.now,
    limits: Partial<UsageAggregationLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  cacheStatus(): { readonly entries: number; readonly records: number } {
    return { entries: this.cache.size, records: this.cachedRecordCount };
  }

  async query(raw: UsageQuery): Promise<UsageResponse> {
    const now = this.now();
    this.pruneExpired(now);
    const query = normalizeQuery(raw, now);
    const fingerprint = queryFingerprint(query);
    const cursor = raw.page_token === undefined ? undefined : decodePageToken(raw.page_token, fingerprint);
    const budget: ScanBudget = {
      remainingRecords: this.limits.wireRecordBudget,
      deadlineAt: now + this.limits.deadlineMs,
      sourcesComplete: true,
      incompleteReason: null,
    };
    const listed = await this.listSessions(query, budget);
    const sessions: SessionRecords[] = [];
    for (const summary of listed.items) {
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
      const session = await this.readSession(summary, budget);
      if (session !== undefined) sessions.push(session);
      if (budget.incompleteReason === 'record_budget' || budget.incompleteReason === 'deadline') break;
    }
    if (budget.incompleteReason === null) {
      sessions.push(...await this.readRetainedSessions(query, budget, listed.activeKeys, sessions.length));
    }
    return this.aggregate(query, sessions, fingerprint, cursor, budget);
  }

  private async listSessions(
    query: NormalizedQuery,
    budget: ScanBudget,
  ): Promise<ListedSessions> {
    const index = this.core.accessor.get(ISessionIndex);
    const items: SessionSummary[] = [];
    const activeKeys = new Set<string>();
    let before: string | undefined;
    while (items.length <= this.limits.sessionScanLimit) {
      const page = await index.listRecent({
        workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
        includeArchived: true,
        limit: INDEX_PAGE_SIZE,
        before,
      });
      for (const item of page.items) {
        activeKeys.add(sessionKey(item));
        if (query.includeArchived || !item.archived) items.push(item);
        if (items.length > this.limits.sessionScanLimit) break;
      }
      if (items.length > this.limits.sessionScanLimit || page.nextCursor === undefined) break;
      before = page.nextCursor;
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
    }
    if (items.length > this.limits.sessionScanLimit) {
      budget.incompleteReason = 'session_cap';
      return { items: items.slice(0, this.limits.sessionScanLimit), activeKeys };
    }
    return { items, activeKeys };
  }

  private async readSession(
    summary: SessionSummary,
    budget: ScanBudget,
  ): Promise<SessionRecords | undefined> {
    const cacheKey = sessionKey(summary);
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached !== undefined) {
      if (cached.scannedRecordCount > budget.remainingRecords) {
        budget.incompleteReason = 'record_budget';
        return undefined;
      }
      budget.remainingRecords -= cached.scannedRecordCount;
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return { summary, records: cached.records, complete: true, deleted: false };
    }
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const appendLog = this.core.accessor.get(IAppendLogStore);
    const workspaceScope = workspacePersistenceScope('sessions', summary.workspaceId);
    const sessionScope = sessionScopeOf(workspaceScope, summary.id);
    const agentIds = await storage.list(`${sessionScope}/agents`);
    const records: NormalizedUsageRecord[] = [];
    let scannedRecordCount = 0;
    let complete = agentIds.length > 0;
    for (const agentId of agentIds) {
      let truncated = false;
      try {
        for await (const raw of appendLog.read<WireRecord>(
          agentScopeOf(sessionScope, agentId),
          AGENT_WIRE_RECORD_KEY,
          { onTruncate: () => { truncated = true; } },
        )) {
          if (this.now() >= budget.deadlineAt) {
            budget.incompleteReason = 'deadline';
            complete = false;
            break;
          }
          if (budget.remainingRecords === 0) {
            budget.incompleteReason = 'record_budget';
            complete = false;
            break;
          }
          budget.remainingRecords -= 1;
          scannedRecordCount += 1;
          if (raw.type !== 'usage.record') continue;
          const record = normalizeRecord(raw);
          if (record === undefined) {
            complete = false;
          } else {
            records.push(record);
          }
        }
      } catch {
        complete = false;
      }
      if (truncated) complete = false;
      if (budget.incompleteReason === 'deadline' || budget.incompleteReason === 'record_budget') break;
    }
    if (complete) this.cacheSession(cacheKey, now, records, scannedRecordCount);
    return { summary, records, complete, deleted: false };
  }

  private async readRetainedSessions(
    query: NormalizedQuery,
    budget: ScanBudget,
    activeKeys: ReadonlySet<string>,
    activeSessionCount: number,
  ): Promise<readonly SessionRecords[]> {
    const retained = await this.core.accessor.get(IRetainedUsageService).listDeletedSessions({
      workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
      deadlineAt: budget.deadlineAt,
      recordLimit: budget.remainingRecords,
    });
    budget.remainingRecords -= retained.scannedRecords;
    if (!retained.complete) budget.sourcesComplete = false;
    if (retained.incompleteReason !== undefined) {
      budget.incompleteReason = retained.incompleteReason;
    }
    const sessions: SessionRecords[] = [];
    for (const snapshot of retained.items) {
      if (activeKeys.has(sessionKey(snapshot))) continue;
      if (!query.includeArchived && snapshot.archived) continue;
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
      if (activeSessionCount + sessions.length >= this.limits.sessionScanLimit) {
        budget.incompleteReason = 'session_cap';
        break;
      }
      sessions.push({
        summary: snapshot,
        records: snapshot.records.map(normalizeRetainedRecord),
        complete: snapshot.complete,
        deleted: true,
      });
    }
    return sessions;
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.deleteCacheEntry(key, entry);
    }
  }

  private cacheSession(
    key: string,
    now: number,
    records: readonly NormalizedUsageRecord[],
    scannedRecordCount: number,
  ): void {
    if (records.length > this.limits.cacheMaxEntryRecords) return;
    const existing = this.cache.get(key);
    if (existing !== undefined) this.deleteCacheEntry(key, existing);
    while (
      this.cache.size >= this.limits.cacheMaxEntries ||
      this.cachedRecordCount + records.length > this.limits.cacheMaxRecords
    ) {
      const oldest = this.cache.entries().next().value as [string, SessionCacheEntry] | undefined;
      if (oldest === undefined) return;
      this.deleteCacheEntry(oldest[0], oldest[1]);
    }
    this.cache.set(key, {
      expiresAt: now + this.limits.cacheTtlMs,
      records,
      scannedRecordCount,
    });
    this.cachedRecordCount += records.length;
  }

  private deleteCacheEntry(key: string, entry: SessionCacheEntry): void {
    this.cache.delete(key);
    this.cachedRecordCount -= entry.records.length;
  }

  private aggregate(
    query: NormalizedQuery,
    sessions: readonly SessionRecords[],
    fingerprint: string,
    cursor: readonly [number, string] | undefined,
    budget: ScanBudget,
  ): UsageResponse {
    const total = emptyAggregate();
    const buckets = new Map<string, BucketAccumulator>();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const unknownPriceModels = new Set<string>();
    const incompleteSessionIds = new Set(
      sessions.filter((session) => !session.complete).map((session) => session.summary.id),
    );
    let earliestAt: number | undefined;
    let latestAt: number | undefined;
    const includesDeletedSessions = sessions.some((session) => session.deleted);
    const pricing = this.core.accessor.get(IModelPricingService);

    sessionLoop: for (let sessionIndex = 0; sessionIndex < sessions.length; sessionIndex += 1) {
      const session = sessions[sessionIndex] as SessionRecords;
      for (const record of session.records) {
        if (this.now() >= budget.deadlineAt) {
          budget.incompleteReason = 'deadline';
          for (let index = sessionIndex; index < sessions.length; index += 1) {
            incompleteSessionIds.add((sessions[index] as SessionRecords).summary.id);
          }
          break sessionLoop;
        }
        if (!inRange(record.time, query.range) || !matchesFilters(record, query)) continue;
        const cost = pricing.calculate(record.model, record.usage);
        addAggregate(total, record.usage, cost);
        if (cost === undefined) unknownPriceModels.add(record.model);
        earliestAt = earliestAt === undefined ? record.time : Math.min(earliestAt, record.time);
        latestAt = latestAt === undefined ? record.time : Math.max(latestAt, record.time);

        const bucket = resolveBucket(record.time, session.summary, query);
        let bucketAcc = buckets.get(bucket.key);
        if (bucketAcc === undefined) {
          bucketAcc = {
            key: bucket.key,
            startAt: bucket.startAt,
            endAt: bucket.endAt,
            groups: new Map(),
            drilldownSessions: new Map(),
            drilldownSessionsTruncated: false,
          };
          buckets.set(bucket.key, bucketAcc);
        } else if (query.granularity === 'session') {
          bucketAcc.startAt = Math.min(bucketAcc.startAt, record.time);
          bucketAcc.endAt = Math.max(bucketAcc.endAt, record.time + 1);
        }
        const groupKey = dimensionKey(query.dimension, record, session.summary);
        let group = bucketAcc.groups.get(groupKey);
        if (group === undefined) {
          group = {
            key: groupKey,
            ...emptyAggregate(),
            providers: new Set(),
            modelAliases: new Set(),
            agentIds: new Set(),
            parentAgentIds: new Set(),
            profileNames: new Set(),
          };
          bucketAcc.groups.set(groupKey, group);
        }
        addAggregate(group, record.usage, cost);
        group.providers.add(record.provider ?? null);
        group.modelAliases.add(record.modelAlias ?? null);
        group.agentIds.add(record.agentId ?? null);
        group.parentAgentIds.add(record.parentAgentId ?? null);
        group.profileNames.add(record.profileName ?? null);
        let drilldown = bucketAcc.drilldownSessions.get(session.summary.id);
        if (
          drilldown === undefined &&
          bucketAcc.drilldownSessions.size < this.limits.drilldownSessionLimit
        ) {
          drilldown = {
            sessionId: session.summary.id,
            turnIds: new Set(),
            unknownTurnRecords: 0,
          };
          bucketAcc.drilldownSessions.set(session.summary.id, drilldown);
        }
        if (drilldown === undefined) {
          bucketAcc.drilldownSessionsTruncated = true;
        } else if (record.turnId === undefined) {
          drilldown.unknownTurnRecords += 1;
        } else {
          drilldown.turnIds.add(record.turnId);
        }

        let sessionAcc = sessionAccumulators.get(session.summary.id);
        if (sessionAcc === undefined) {
          sessionAcc = {
            summary: session.summary,
            deleted: session.deleted,
            ...emptyAggregate(),
            unknownPriceModels: new Set(),
          };
          sessionAccumulators.set(session.summary.id, sessionAcc);
        }
        addAggregate(sessionAcc, record.usage, cost);
        if (cost === undefined) sessionAcc.unknownPriceModels.add(record.model);
      }
    }

    const sessionItems = [...sessionAccumulators.values()].toSorted(compareSessions);
    const pageStart = cursor === undefined ? 0 : findPageStart(sessionItems, cursor);
    const pageItems = sessionItems.slice(pageStart, pageStart + query.pageSize);
    const hasMore = pageStart + pageItems.length < sessionItems.length;
    const last = pageItems.at(-1);

    return {
      query: {
        granularity: query.granularity,
        range: {
          preset: query.range.preset,
          start_at: query.range.startAt ?? null,
          end_at: query.range.endAt ?? null,
          defaulted_to_all_history: query.range.defaultedToAllHistory,
        },
        dimension: query.dimension,
        models: [...query.models],
        providers: [...query.providers],
        agent_ids: [...query.agentIds],
        workspace_ids: [...query.workspaceIds],
        include_archived: query.includeArchived,
        timezone_offset_minutes: query.timezoneOffsetMinutes,
      },
      summary: { ...aggregateWire(total), session_count: sessionAccumulators.size },
      trend: [...buckets.values()]
        .toSorted((a, b) => a.startAt - b.startAt || a.key.localeCompare(b.key))
        .map((bucket) => ({
          key: bucket.key,
          start_at: bucket.startAt,
          end_at: bucket.endAt,
          groups: [...bucket.groups.values()]
            .toSorted((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
            .map((group) => ({
              key: group.key,
              ...aggregateWire(group),
              provider: singleValue(group.providers),
              model_alias: singleValue(group.modelAliases),
              agent_id: singleValue(group.agentIds),
              parent_agent_id: singleValue(group.parentAgentIds),
              profile_name: singleValue(group.profileNames),
            })),
          drilldown: {
            sessions: [...bucket.drilldownSessions.values()]
              .toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))
              .map((session) => {
                const turnIds = [...session.turnIds].toSorted((a, b) => a - b);
                return {
                  session_id: session.sessionId,
                  turn_ids: turnIds.slice(0, this.limits.drilldownTurnLimit),
                  turn_count: turnIds.length,
                  unknown_turn_records: session.unknownTurnRecords,
                  turn_ids_truncated: turnIds.length > this.limits.drilldownTurnLimit,
                };
              }),
            sessions_truncated: bucket.drilldownSessionsTruncated,
          },
        })),
      sessions: {
        items: pageItems.map((item) => ({
          id: item.summary.id,
          workspace_id: item.summary.workspaceId,
          title: item.summary.title ?? null,
          created_at: item.summary.createdAt,
          updated_at: item.summary.updatedAt,
          archived: item.summary.archived,
          deleted: item.deleted,
          usage: aggregateWire(item),
          unknown_price_models: [...item.unknownPriceModels].toSorted(),
        })),
        total: sessionItems.length,
        has_more: hasMore,
        next_page_token:
          hasMore && last !== undefined ? encodePageToken(fingerprint, last.cost, last.summary.id) : null,
      },
      reliability: {
        complete:
          budget.sourcesComplete &&
          budget.incompleteReason === null &&
          incompleteSessionIds.size === 0,
        coverage: { earliest_at: earliestAt ?? null, latest_at: latestAt ?? null },
        scanned_sessions: sessions.length,
        incomplete_sessions: incompleteSessionIds.size,
        unknown_price_models: [...unknownPriceModels].toSorted(),
        includes_deleted_sessions: includesDeletedSessions,
        incomplete_reason: budget.incompleteReason,
      },
    };
  }
}

function normalizeQuery(raw: UsageQuery, now: number): NormalizedQuery {
  const timezoneOffsetMinutes = raw.timezone_offset_minutes ?? 0;
  const preset = raw.range ?? 'all';
  return {
    granularity: raw.granularity ?? 'day',
    range: resolveRange(preset, raw.start_at, raw.end_at, timezoneOffsetMinutes, now, raw.range === undefined),
    dimension: raw.dimension ?? 'model',
    models: normalizeRepeated(raw.model),
    providers: normalizeRepeated(raw.provider),
    agentIds: normalizeRepeated(raw['agent.id']),
    workspaceIds: normalizeRepeated(raw['workspace.id']),
    includeArchived: raw.include_archived === 'true',
    timezoneOffsetMinutes,
    pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
  };
}

function normalizeRepeated(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return [...new Set(Array.isArray(value) ? value : [value])].toSorted();
}

function resolveRange(
  preset: RangeBounds['preset'],
  startAt: number | undefined,
  endAt: number | undefined,
  offsetMinutes: number,
  now: number,
  defaultedToAllHistory: boolean,
): RangeBounds {
  if (preset === 'all') return { preset, defaultedToAllHistory };
  if (preset === 'custom') return { preset, startAt, endAt, defaultedToAllHistory };
  if (preset === 'today') {
    const start = startOfDay(now, offsetMinutes);
    return { preset, startAt: start, endAt: start + DAY_MS, defaultedToAllHistory };
  }
  if (preset === 'last_7_days') {
    const end = startOfDay(now, offsetMinutes) + DAY_MS;
    return { preset, startAt: end - 7 * DAY_MS, endAt: end, defaultedToAllHistory };
  }
  if (preset === 'this_week') {
    const start = startOfWeek(now, offsetMinutes);
    return { preset, startAt: start, endAt: start + 7 * DAY_MS, defaultedToAllHistory };
  }
  const shifted = new Date(now + offsetMinutes * 60_000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMinutes * 60_000;
  const end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - offsetMinutes * 60_000;
  return { preset, startAt: start, endAt: end, defaultedToAllHistory };
}

function startOfDay(time: number, offsetMinutes: number): number {
  const shifted = new Date(time + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
}

function startOfWeek(time: number, offsetMinutes: number): number {
  const day = startOfDay(time, offsetMinutes);
  const shifted = new Date(day + offsetMinutes * 60_000);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return day - daysSinceMonday * DAY_MS;
}

function normalizeRecord(raw: WireRecord): NormalizedUsageRecord | undefined {
  const usage = raw['usage'];
  const model = raw['model'];
  if (typeof raw.time !== 'number' || !Number.isFinite(raw.time) || raw.time < 0) return undefined;
  if (typeof model !== 'string' || model.length === 0) return undefined;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const value = usage as Record<string, unknown>;
  const inputOther = nonnegativeFinite(value['inputOther']);
  const output = nonnegativeFinite(value['output']);
  const inputCacheRead = nonnegativeFinite(value['inputCacheRead']);
  const inputCacheCreation = nonnegativeFinite(value['inputCacheCreation']);
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) return undefined;
  return {
    time: raw.time,
    model,
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    turnId: nonnegativeInteger(raw['turnId']),
    agentId: optionalString(raw['agentId']),
    parentAgentId: optionalString(raw['parentAgentId']),
    provider: optionalString(raw['provider']),
    modelAlias: optionalString(raw['modelAlias']),
    profileName: optionalString(raw['profileName']),
  };
}

function normalizeRetainedRecord(record: RetainedUsageRecord): NormalizedUsageRecord {
  return {
    time: record.time,
    model: record.model,
    usage: record.usage,
    turnId: record.turnId,
    agentId: record.agentId,
    parentAgentId: record.parentAgentId,
    provider: record.provider,
    modelAlias: record.modelAlias,
    profileName: record.profileName,
  };
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function inRange(time: number, range: RangeBounds): boolean {
  return (range.startAt === undefined || time >= range.startAt) &&
    (range.endAt === undefined || time < range.endAt);
}

function matchesFilters(record: NormalizedUsageRecord, query: NormalizedQuery): boolean {
  if (
    query.models.length > 0 &&
    !query.models.includes(record.model) &&
    (record.modelAlias === undefined || !query.models.includes(record.modelAlias))
  ) return false;
  if (
    query.providers.length > 0 &&
    (record.provider === undefined || !query.providers.includes(record.provider))
  ) return false;
  if (
    query.agentIds.length > 0 &&
    (record.agentId === undefined || !query.agentIds.includes(record.agentId))
  ) return false;
  return true;
}

function sessionKey(summary: Pick<SessionSummary, 'id' | 'workspaceId'>): string {
  return `${summary.workspaceId}\0${summary.id}`;
}

function dimensionKey(
  dimension: NormalizedQuery['dimension'],
  record: NormalizedUsageRecord,
  session: SessionSummary,
): string {
  if (dimension === 'agent') return record.agentId ?? 'unknown';
  if (dimension === 'model') return record.modelAlias ?? 'unknown';
  if (dimension === 'project') return session.workspaceId;
  return session.id;
}

function resolveBucket(
  time: number,
  session: SessionSummary,
  query: NormalizedQuery,
): { key: string; startAt: number; endAt: number } {
  if (query.granularity === 'session') {
    return { key: session.id, startAt: time, endAt: time + 1 };
  }
  if (query.granularity === 'day') {
    const startAt = startOfDay(time, query.timezoneOffsetMinutes);
    return { key: String(startAt), startAt, endAt: startAt + DAY_MS };
  }
  if (query.granularity === 'week') {
    const startAt = startOfWeek(time, query.timezoneOffsetMinutes);
    return { key: String(startAt), startAt, endAt: startAt + 7 * DAY_MS };
  }
  if (query.granularity === 'five_hour') {
    const shifted = time + query.timezoneOffsetMinutes * 60_000;
    const shiftedStart = Math.floor(shifted / FIVE_HOURS_MS) * FIVE_HOURS_MS;
    const startAt = shiftedStart - query.timezoneOffsetMinutes * 60_000;
    return { key: String(startAt), startAt, endAt: startAt + FIVE_HOURS_MS };
  }
  const shifted = new Date(time + query.timezoneOffsetMinutes * 60_000);
  const startAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - query.timezoneOffsetMinutes * 60_000;
  const endAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - query.timezoneOffsetMinutes * 60_000;
  return { key: String(startAt), startAt, endAt };
}

function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

function emptyAggregate(): AggregateAccumulator {
  return { usage: emptyUsage(), cost: 0, costUnknown: false };
}

function addAggregate(target: AggregateAccumulator, usage: TokenUsage, cost: number | undefined): void {
  target.usage.inputOther += usage.inputOther;
  target.usage.output += usage.output;
  target.usage.inputCacheRead += usage.inputCacheRead;
  target.usage.inputCacheCreation += usage.inputCacheCreation;
  if (cost === undefined) {
    target.costUnknown = true;
  } else {
    target.cost += cost;
  }
}

function aggregateWire(value: AggregateAccumulator): UsageAggregateWire {
  return {
    tokens: {
      input_other: value.usage.inputOther,
      output: value.usage.output,
      input_cache_read: value.usage.inputCacheRead,
      input_cache_creation: value.usage.inputCacheCreation,
    },
    cost_usd_estimated: value.cost,
    cost_unknown: value.costUnknown,
  };
}

function singleValue(values: ReadonlySet<string | null>): string | null {
  return values.size === 1 ? [...values][0] ?? null : null;
}

function compareSessions(a: SessionAccumulator, b: SessionAccumulator): number {
  if (a.cost !== b.cost) return b.cost - a.cost;
  return b.summary.id.localeCompare(a.summary.id);
}

function findPageStart(
  items: readonly SessionAccumulator[],
  cursor: readonly [number, string],
): number {
  const index = items.findIndex((item) => item.cost === cursor[0] && item.summary.id === cursor[1]);
  if (index < 0) {
    throw new UsagePageTokenMismatchError(
      'page_token position is no longer available; discard it and restart from the first page',
    );
  }
  return index + 1;
}

const PAGE_TOKEN_VERSION = 1;

function queryFingerprint(query: NormalizedQuery): string {
  return createHash('sha256')
    .update(JSON.stringify([
      query.granularity,
      query.range.preset,
      query.range.startAt ?? null,
      query.range.endAt ?? null,
      query.dimension,
      query.models,
      query.providers,
      query.agentIds,
      query.workspaceIds,
      query.includeArchived,
      query.timezoneOffsetMinutes,
      query.pageSize,
    ]))
    .digest('base64url')
    .slice(0, 16);
}

function encodePageToken(fingerprint: string, cost: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: PAGE_TOKEN_VERSION, f: fingerprint, k: [cost, id] })).toString('base64url');
}

function decodePageToken(raw: string, fingerprint: string): readonly [number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new UsagePageTokenMismatchError(
      'page_token is corrupted; discard it and restart from the first page',
    );
  }
  const token = parsed as { v?: unknown; f?: unknown; k?: unknown };
  const key = Array.isArray(token.k) ? token.k : undefined;
  if (
    token.v !== PAGE_TOKEN_VERSION ||
    token.f !== fingerprint ||
    key === undefined ||
    key.length !== 2 ||
    typeof key[0] !== 'number' ||
    typeof key[1] !== 'string'
  ) {
    throw new UsagePageTokenMismatchError(
      'page_token does not match the query conditions; discard it and restart from the first page',
    );
  }
  return [key[0], key[1]];
}

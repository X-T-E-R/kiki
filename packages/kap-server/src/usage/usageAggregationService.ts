import { createHash } from 'node:crypto';

import {
  AGENT_WIRE_RECORD_KEY,
  IAppendLogStore,
  IFileSystemStorageService,
  ISessionIndex,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type Scope,
  type SessionSummary,
  type TokenUsage,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import type {
  UsageAggregateWire,
  UsageQuery,
  UsageResponse,
} from '../protocol/rest-usage';
import { IModelPricingService } from '../pricing/modelPricingService';

const DEFAULT_PAGE_SIZE = 50;
const SESSION_SCAN_LIMIT = 500;
const WIRE_RECORD_BUDGET = 200_000;
const SCAN_DEADLINE_MS = 1_500;
const SESSION_CACHE_TTL_MS = 30_000;
const INDEX_PAGE_SIZE = 100;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface NormalizedUsageRecord {
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
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
}

interface SessionCacheEntry {
  readonly expiresAt: number;
  readonly records: readonly NormalizedUsageRecord[];
  readonly complete: boolean;
}

interface ScanBudget {
  remainingRecords: number;
  readonly deadlineAt: number;
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
  readonly workspaceIds: readonly string[];
  readonly includeArchived: boolean;
  readonly timezoneOffsetMinutes: number;
  readonly pageSize: number;
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

interface BucketAccumulator {
  readonly key: string;
  startAt: number;
  endAt: number;
  readonly groups: Map<string, GroupAccumulator>;
}

interface SessionAccumulator extends AggregateAccumulator {
  readonly summary: SessionSummary;
  readonly unknownPriceModels: Set<string>;
}

export class UsagePageTokenMismatchError extends Error {}

export class UsageAggregationService {
  private readonly cache = new Map<string, SessionCacheEntry>();

  constructor(
    private readonly core: Scope,
    private readonly now: () => number = Date.now,
  ) {}

  async query(raw: UsageQuery): Promise<UsageResponse> {
    const now = this.now();
    const query = normalizeQuery(raw, now);
    const fingerprint = queryFingerprint(query);
    const cursor = raw.page_token === undefined ? undefined : decodePageToken(raw.page_token, fingerprint);
    const budget: ScanBudget = {
      remainingRecords: WIRE_RECORD_BUDGET,
      deadlineAt: now + SCAN_DEADLINE_MS,
      incompleteReason: null,
    };
    const listed = await this.listSessions(query, budget);
    const sessions: SessionRecords[] = [];
    for (const summary of listed) {
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
      sessions.push(await this.readSession(summary, budget));
      if (budget.incompleteReason === 'record_budget') break;
    }
    return this.aggregate(query, sessions, fingerprint, cursor, budget.incompleteReason);
  }

  private async listSessions(
    query: NormalizedQuery,
    budget: ScanBudget,
  ): Promise<readonly SessionSummary[]> {
    const index = this.core.accessor.get(ISessionIndex);
    const items: SessionSummary[] = [];
    let before: string | undefined;
    while (items.length <= SESSION_SCAN_LIMIT) {
      const page = await index.listRecent({
        workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
        includeArchived: true,
        limit: INDEX_PAGE_SIZE,
        before,
      });
      for (const item of page.items) {
        if (query.includeArchived || !item.archived) items.push(item);
        if (items.length > SESSION_SCAN_LIMIT) break;
      }
      if (items.length > SESSION_SCAN_LIMIT || page.nextCursor === undefined) break;
      before = page.nextCursor;
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
    }
    if (items.length > SESSION_SCAN_LIMIT) {
      budget.incompleteReason = 'session_cap';
      return items.slice(0, SESSION_SCAN_LIMIT);
    }
    return items;
  }

  private async readSession(summary: SessionSummary, budget: ScanBudget): Promise<SessionRecords> {
    const cacheKey = `${summary.workspaceId}\0${summary.id}`;
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached !== undefined && cached.expiresAt > now) {
      return { summary, records: cached.records, complete: cached.complete };
    }
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const appendLog = this.core.accessor.get(IAppendLogStore);
    const workspaceScope = workspacePersistenceScope('sessions', summary.workspaceId);
    const sessionScope = sessionScopeOf(workspaceScope, summary.id);
    const agentIds = await storage.list(`${sessionScope}/agents`);
    const records: NormalizedUsageRecord[] = [];
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
    this.cache.set(cacheKey, {
      expiresAt: now + SESSION_CACHE_TTL_MS,
      records,
      complete,
    });
    return { summary, records, complete };
  }

  private aggregate(
    query: NormalizedQuery,
    sessions: readonly SessionRecords[],
    fingerprint: string,
    cursor: readonly [number, string] | undefined,
    incompleteReason: UsageResponse['reliability']['incomplete_reason'],
  ): UsageResponse {
    const total = emptyAggregate();
    const buckets = new Map<string, BucketAccumulator>();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const unknownPriceModels = new Set<string>();
    let earliestAt: number | undefined;
    let latestAt: number | undefined;
    let incompleteSessions = 0;
    const pricing = this.core.accessor.get(IModelPricingService);

    for (const session of sessions) {
      if (!session.complete) incompleteSessions += 1;
      for (const record of session.records) {
        if (!inRange(record.time, query.range)) continue;
        const cost = pricing.calculate(record.model, record.usage);
        addAggregate(total, record.usage, cost);
        if (cost === undefined) unknownPriceModels.add(record.model);
        earliestAt = earliestAt === undefined ? record.time : Math.min(earliestAt, record.time);
        latestAt = latestAt === undefined ? record.time : Math.max(latestAt, record.time);

        const bucket = resolveBucket(record.time, session.summary, query);
        let bucketAcc = buckets.get(bucket.key);
        if (bucketAcc === undefined) {
          bucketAcc = { key: bucket.key, startAt: bucket.startAt, endAt: bucket.endAt, groups: new Map() };
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

        let sessionAcc = sessionAccumulators.get(session.summary.id);
        if (sessionAcc === undefined) {
          sessionAcc = {
            summary: session.summary,
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
        })),
      sessions: {
        items: pageItems.map((item) => ({
          id: item.summary.id,
          workspace_id: item.summary.workspaceId,
          title: item.summary.title ?? null,
          created_at: item.summary.createdAt,
          updated_at: item.summary.updatedAt,
          archived: item.summary.archived,
          deleted: false,
          usage: aggregateWire(item),
          unknown_price_models: [...item.unknownPriceModels].toSorted(),
        })),
        total: sessionItems.length,
        has_more: hasMore,
        next_page_token:
          hasMore && last !== undefined ? encodePageToken(fingerprint, last.cost, last.summary.id) : null,
      },
      reliability: {
        coverage: { earliest_at: earliestAt ?? null, latest_at: latestAt ?? null },
        scanned_sessions: sessions.length,
        incomplete_sessions: incompleteSessions,
        unknown_price_models: [...unknownPriceModels].toSorted(),
        includes_deleted_sessions: false,
        incomplete_reason: incompleteReason,
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
    agentId: optionalString(raw['agentId']),
    parentAgentId: optionalString(raw['parentAgentId']),
    provider: optionalString(raw['provider']),
    modelAlias: optionalString(raw['modelAlias']),
    profileName: optionalString(raw['profileName']),
  };
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function inRange(time: number, range: RangeBounds): boolean {
  return (range.startAt === undefined || time >= range.startAt) &&
    (range.endAt === undefined || time < range.endAt);
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

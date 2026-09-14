import { createHash } from 'node:crypto';

import {
  AGENT_WIRE_RECORD_KEY,
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
} from '@kiki/agent-core-v2';
import type { UsageAggregateWire, UsageQuery, UsageResponse } from '@kiki/protocol';

import { IModelPricingService } from '../pricing/modelPricingService';

const DEFAULT_PAGE_SIZE = 50;
const INDEX_PAGE_SIZE = 100;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSISTENCE_SCOPE = 'cache/usage-aggregation-v1';
const PERSISTENCE_VERSION = 1;
const BOUNDARY_BYTES = 4 * 1024;
const DEFAULT_LIMITS: UsageAggregationLimits = {
  sessionScanLimit: 500,
  wireRecordBudget: 200_000,
  deadlineMs: 1_500,
  cacheTtlMs: 90_000,
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
  readonly sourceAgentId?: string;
  readonly time: number;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly usageKnown?: boolean;
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
}

interface WireCheckpoint {
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly boundaryHash: string;
  readonly valid: boolean;
}

interface PersistentSessionRecords {
  readonly version: number;
  readonly sessionKey: string;
  readonly records: readonly NormalizedUsageRecord[];
  readonly agents: Readonly<Record<string, WireCheckpoint>>;
}

interface SessionLoadResult {
  readonly session: SessionRecords;
  readonly scannedRecordCount: number;
  readonly incompleteReason: UsageResponse['reliability']['incomplete_reason'];
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
  knownRecords: number;
  missingRecords: number;
  legacyZeroRecords: number;
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

/** Incremental usage projection for wire files produced through the managed append/rewrite stores. External in-place rewrites that preserve the checkpoint boundary are outside this cache's consistency contract. */
export class UsageAggregationService {
  private readonly cache = new Map<string, SessionCacheEntry>();
  private readonly sessionFlights = new Map<string, Promise<SessionLoadResult>>();
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
    if (cached !== undefined) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return { summary, records: cached.records, complete: true, deleted: false };
    }
    let flight = this.sessionFlights.get(cacheKey);
    if (flight === undefined) {
      flight = this.loadSessionIncremental(summary, budget.remainingRecords, budget.deadlineAt);
      this.sessionFlights.set(cacheKey, flight);
      const clearFlight = (): void => {
        if (this.sessionFlights.get(cacheKey) === flight) this.sessionFlights.delete(cacheKey);
      };
      void flight.then(clearFlight, clearFlight);
    }
    const result = await flight;
    if (result.scannedRecordCount > budget.remainingRecords) {
      budget.incompleteReason = 'record_budget';
      return undefined;
    }
    budget.remainingRecords -= result.scannedRecordCount;
    if (result.incompleteReason !== null) budget.incompleteReason = result.incompleteReason;
    if (result.session.complete) this.cacheSession(cacheKey, result.session.records);
    return result.session;
  }

  private async loadSessionIncremental(
    summary: SessionSummary,
    recordLimit: number,
    deadlineAt: number,
  ): Promise<SessionLoadResult> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const cacheKey = sessionKey(summary);
    const persisted = await this.readPersistentSession(storage, cacheKey);
    const workspaceScope = workspacePersistenceScope('sessions', summary.workspaceId);
    const sessionScope = sessionScopeOf(workspaceScope, summary.id);
    const agentIds = await storage.list(`${sessionScope}/agents`);
    const agentSet = new Set(agentIds);
    let records = [...persisted.records].filter(
      (record) => record.sourceAgentId === undefined || agentSet.has(record.sourceAgentId),
    );
    const agents: Record<string, WireCheckpoint> = {};
    let scannedRecordCount = 0;
    let incompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;
    let complete = agentIds.length > 0;

    for (const agentId of agentIds) {
      if (this.now() >= deadlineAt) {
        incompleteReason = 'deadline';
        complete = false;
        break;
      }
      if (scannedRecordCount >= recordLimit) {
        incompleteReason = 'record_budget';
        complete = false;
        break;
      }
      const wireScope = agentScopeOf(sessionScope, agentId);
      const [sizeValue, mtimeValue] = await Promise.all([
        storage.size(wireScope, AGENT_WIRE_RECORD_KEY),
        storage.mtime(wireScope, AGENT_WIRE_RECORD_KEY),
      ]);
      const size = sizeValue ?? 0;
      const mtimeMs = mtimeValue ?? 0;
      let checkpoint = persisted.agents[agentId];
      let reset = checkpoint !== undefined && size < checkpoint.offset;
      if (
        checkpoint !== undefined &&
        !reset &&
        (size !== checkpoint.size || mtimeMs !== checkpoint.mtimeMs)
      ) {
        const boundaryHash = await this.boundaryHash(storage, wireScope, checkpoint.offset);
        reset = boundaryHash !== checkpoint.boundaryHash ||
          (size === checkpoint.offset && mtimeMs !== checkpoint.mtimeMs);
      }
      if (reset) {
        records = records.filter((record) => record.sourceAgentId !== agentId);
        checkpoint = undefined;
      }
      const offset = checkpoint?.offset ?? 0;
      const tail = await readWireTail(
        storage,
        wireScope,
        offset,
        size,
        recordLimit - scannedRecordCount,
        deadlineAt,
        this.now,
      );
      scannedRecordCount += tail.scannedRecordCount;
      records.push(...tail.records.map((record) => ({ ...record, sourceAgentId: agentId })));
      const nextOffset = tail.offset;
      agents[agentId] = {
        offset: nextOffset,
        size,
        mtimeMs,
        boundaryHash: await this.boundaryHash(storage, wireScope, nextOffset),
        valid: (checkpoint?.valid ?? true) && tail.valid,
      };
      if (!tail.complete) complete = false;
      if (!agents[agentId].valid) complete = false;
      if (tail.incompleteReason !== null) {
        incompleteReason = tail.incompleteReason;
        break;
      }
    }

    for (const agentId of agentIds) {
      if (agents[agentId] === undefined && persisted.agents[agentId] !== undefined) {
        agents[agentId] = persisted.agents[agentId];
      }
    }
    const next: PersistentSessionRecords = {
      version: PERSISTENCE_VERSION,
      sessionKey: cacheKey,
      records,
      agents,
    };
    try {
      await storage.write(
        PERSISTENCE_SCOPE,
        persistenceKey(cacheKey),
        Buffer.from(JSON.stringify(next)),
        { atomic: true },
      );
    } catch {
      complete = false;
    }
    return {
      session: { summary, records, complete, deleted: false },
      scannedRecordCount,
      incompleteReason,
    };
  }

  private async readPersistentSession(
    storage: IFileSystemStorageService,
    cacheKey: string,
  ): Promise<PersistentSessionRecords> {
    try {
      const bytes = await storage.read(PERSISTENCE_SCOPE, persistenceKey(cacheKey));
      if (bytes === undefined) return emptyPersistentSession(cacheKey);
      const parsed = parsePersistentSession(
        JSON.parse(Buffer.from(bytes).toString('utf8')),
        cacheKey,
      );
      return parsed ?? emptyPersistentSession(cacheKey);
    } catch {
      return emptyPersistentSession(cacheKey);
    }
  }

  private async boundaryHash(
    storage: IFileSystemStorageService,
    scope: string,
    offset: number,
  ): Promise<string> {
    if (offset === 0) return '';
    const start = Math.max(0, offset - BOUNDARY_BYTES);
    const bytes = await readRange(storage, scope, start, offset - 1);
    return createHash('sha256').update(bytes).digest('base64url');
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
    records: readonly NormalizedUsageRecord[],
  ): void {
    if (records.length > this.limits.cacheMaxEntryRecords) return;
    const existing = this.cache.get(key);
    if (existing !== undefined) this.deleteCacheEntry(key, existing);
    while (
      this.cache.size >= this.limits.cacheMaxEntries ||
      this.cachedRecordCount + records.length > this.limits.cacheMaxRecords
    ) {
      const oldest = this.cache.entries().next().value;
      if (oldest === undefined) return;
      this.deleteCacheEntry(oldest[0], oldest[1]);
    }
    this.cache.set(key, {
      expiresAt: this.now() + this.limits.cacheTtlMs,
      records,
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
        addAggregate(total, record, cost);
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
        addAggregate(group, record, cost);
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
        addAggregate(sessionAcc, record, cost);
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
        usage_coverage: {
          known_records: total.knownRecords,
          missing_records: total.missingRecords,
          legacy_zero_records: total.legacyZeroRecords,
        },
        scanned_sessions: sessions.length,
        incomplete_sessions: incompleteSessionIds.size,
        unknown_price_models: [...unknownPriceModels].toSorted(),
        includes_deleted_sessions: includesDeletedSessions,
        incomplete_reason: budget.incompleteReason,
      },
    };
  }
}

interface WireTailResult {
  readonly records: readonly NormalizedUsageRecord[];
  readonly offset: number;
  readonly scannedRecordCount: number;
  readonly valid: boolean;
  readonly complete: boolean;
  readonly incompleteReason: UsageResponse['reliability']['incomplete_reason'];
}

async function readWireTail(
  storage: IFileSystemStorageService,
  scope: string,
  startOffset: number,
  size: number,
  recordLimit: number,
  deadlineAt: number,
  now: () => number,
): Promise<WireTailResult> {
  if (startOffset >= size) {
    return {
      records: [],
      offset: startOffset,
      scannedRecordCount: 0,
      valid: true,
      complete: true,
      incompleteReason: null,
    };
  }
  let pending = Buffer.alloc(0);
  let offset = startOffset;
  let scannedRecordCount = 0;
  let valid = true;
  let incompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;
  const records: NormalizedUsageRecord[] = [];
  try {
    for await (const chunkValue of storage.readStream(
      scope,
      AGENT_WIRE_RECORD_KEY,
      { start: startOffset, end: size - 1 },
    )) {
      const chunk = Buffer.from(chunkValue);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        if (now() >= deadlineAt) {
          incompleteReason = 'deadline';
          break;
        }
        if (scannedRecordCount >= recordLimit) {
          incompleteReason = 'record_budget';
          break;
        }
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        offset += newline + 1;
        scannedRecordCount += 1;
        if (line.length === 0) continue;
        let raw: WireRecord;
        try {
          raw = JSON.parse(line.toString('utf8')) as WireRecord;
        } catch {
          valid = false;
          continue;
        }
        if (raw.type !== 'usage.record') continue;
        const record = normalizeRecord(raw);
        if (record === undefined) valid = false;
        else records.push(record);
      }
      if (incompleteReason !== null) break;
    }
  } catch {
    valid = false;
  }
  return {
    records,
    offset,
    scannedRecordCount,
    valid,
    complete: incompleteReason === null && offset === size,
    incompleteReason,
  };
}

async function readRange(
  storage: IFileSystemStorageService,
  scope: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of storage.readStream(
    scope,
    AGENT_WIRE_RECORD_KEY,
    { start, end },
  )) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function emptyPersistentSession(cacheKey: string): PersistentSessionRecords {
  return { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records: [], agents: {} };
}

function parsePersistentSession(
  value: unknown,
  cacheKey: string,
): PersistentSessionRecords | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw['version'] !== PERSISTENCE_VERSION ||
    raw['sessionKey'] !== cacheKey ||
    !Array.isArray(raw['records']) ||
    !raw['records'].every(isNormalizedUsageRecord) ||
    raw['agents'] === null ||
    typeof raw['agents'] !== 'object' ||
    Array.isArray(raw['agents'])
  ) {
    return undefined;
  }
  const agents = raw['agents'] as Record<string, unknown>;
  if (!Object.values(agents).every(isWireCheckpoint)) return undefined;
  return value as PersistentSessionRecords;
}

function isNormalizedUsageRecord(value: unknown): value is NormalizedUsageRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const usage = record['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const tokens = usage as Record<string, unknown>;
  return typeof record['time'] === 'number' &&
    Number.isFinite(record['time']) &&
    typeof record['model'] === 'string' &&
    nonnegativeFinite(tokens['inputOther']) !== undefined &&
    nonnegativeFinite(tokens['output']) !== undefined &&
    nonnegativeFinite(tokens['inputCacheRead']) !== undefined &&
    nonnegativeFinite(tokens['inputCacheCreation']) !== undefined &&
    (record['sourceAgentId'] === undefined || typeof record['sourceAgentId'] === 'string');
}

function isWireCheckpoint(value: unknown): value is WireCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return nonnegativeInteger(checkpoint['offset']) !== undefined &&
    nonnegativeInteger(checkpoint['size']) !== undefined &&
    typeof checkpoint['mtimeMs'] === 'number' &&
    Number.isFinite(checkpoint['mtimeMs']) &&
    typeof checkpoint['boundaryHash'] === 'string' &&
    typeof checkpoint['valid'] === 'boolean';
}

function persistenceKey(cacheKey: string): string {
  return `${createHash('sha256').update(cacheKey).digest('hex')}.json`;
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
  const usageKnown = raw['usageKnown'];
  if (usageKnown !== undefined && typeof usageKnown !== 'boolean') return undefined;
  return {
    time: raw.time,
    model,
    usage: { inputOther, output, inputCacheRead, inputCacheCreation },
    usageKnown,
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
    usageKnown: record.usageKnown,
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
  return { usage: emptyUsage(), cost: 0, costUnknown: false, knownRecords: 0, missingRecords: 0, legacyZeroRecords: 0 };
}

function addAggregate(target: AggregateAccumulator, record: NormalizedUsageRecord, cost: number | undefined): void {
  const { usage, usageKnown } = record;
  const legacyZero = usageKnown === undefined &&
    usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation === 0;
  const tokensUnknown = usageKnown === false || legacyZero;
  if (usageKnown === false) target.missingRecords += 1;
  else if (legacyZero) target.legacyZeroRecords += 1;
  else target.knownRecords += 1;
  target.usage.inputOther += usage.inputOther;
  target.usage.output += usage.output;
  target.usage.inputCacheRead += usage.inputCacheRead;
  target.usage.inputCacheCreation += usage.inputCacheCreation;
  if (cost === undefined || tokensUnknown) {
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
    tokens_unknown: value.missingRecords > 0 || value.legacyZeroRecords > 0,
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

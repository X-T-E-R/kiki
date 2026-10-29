import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { MiniDbQueryStore, drainQueryStoreDisposals } from '@kiki/agent-core-v2/persistence/backends/minidb/miniDbQueryStore';
import { SqliteQueryStore } from '@kiki/agent-core-v2/persistence/backends/sqlite/sqliteQueryStore';
import { SqliteUsageReadModel } from '@kiki/agent-core-v2/persistence/backends/sqlite/sqliteUsageReadModel';
import { InMemoryStorageService } from '@kiki/agent-core-v2/persistence/backends/memory/inMemoryStorageService';
import { UsageFactStore } from '@kiki/agent-core-v2/app/usageFacts/usageFactStore';
import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';
import type { UsageReadModelSession } from '@kiki/agent-core-v2/persistence/interface/usageReadModel';
import { stubBootstrap } from '../../agent-core-v2/test/app/bootstrap/stubs';
import { stubLog } from '../../agent-core-v2/test/_base/log/stubs';

import {
  AppendLogStore,
  IAppendLogStore,
  IUsageFactStore,
  IUsageReadModel,
  IQueryStore,
  IBootstrapService,
  ILogService,
  IFileSystemStorageService,
  IRetainedUsageService,
  ISessionIndex,
  RETAINED_USAGE_VERSION,
  type EphemeralUsageTotal,
  type RetainedDeletedSessionUsage,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type RetainedUsageRecord,
  type Scope,
  type SessionSummary,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { Emitter, Event } from '@kiki/agent-core-v2/_base/event';
import { UsageWireFramer } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import type { UsageQuery, UsageResponse } from '@kiki/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { UsageAggregationService } from '../src/usage/usageAggregationService';
import { UsageSourceTracker, type UsageSourceChanges } from '../src/usage/usageSourceTracker';

const queryFixtures: { home: string; ix: TestInstantiationService; store: IQueryStore; model?: IUsageReadModel }[] = [];
afterEach(async () => {
  for (const { home, ix, store, model } of queryFixtures.splice(0)) {
    await model?.close();
    await store.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

interface Fixture {
  readonly core: Scope;
  readonly service: UsageAggregationService;
  readonly model: IUsageReadModel;
  readonly facts: IUsageFactStore;
  readonly reads: Map<string, number>;
  readonly agentLists: Map<string, number>;
  readonly sourceProbes: Map<string, number>;
  readonly readBytes: Map<string, number>;
  readonly readOffsets: number[];
  readonly readRanges: { readonly start: number; readonly end: number }[];
  readonly checkpointReads: Map<string, number>;
  readonly retainedQueries: readonly RetainedUsageListQuery[];
  setWire(scope: string, records: readonly WireRecord[]): void;
  setMtime(scope: string, mtimeMs: number): void;
  restart(): UsageAggregationService;
  setAgentIds(ids: string[]): void;
  setPrice(price: number | undefined): void;
  onPrice(observer: () => void): void;
}

function summary(id: string, workspaceId: string): SessionSummary {
  return {
    id,
    workspaceId,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  };
}

function usageRecord(time: number, turnId?: number): WireRecord {
  return {
    type: 'usage.record',
    time,
    model: 'priced-model',
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 1,
      inputCacheCreation: 1,
    },
    turnId,
  };
}

function retainedRecord(
  time: number,
  overrides: Partial<RetainedUsageRecord> = {},
): RetainedUsageRecord {
  return {
    time,
    model: 'priced-model',
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 1,
      inputCacheCreation: 1,
    },
    ...overrides,
  };
}

function retainedSession(
  id: string,
  workspaceId: string,
  records: readonly RetainedUsageRecord[],
  overrides: Partial<RetainedDeletedSessionUsage> = {},
): RetainedDeletedSessionUsage {
  return {
    version: RETAINED_USAGE_VERSION,
    ...summary(id, workspaceId),
    deleted: true,
    deletedAt: 2,
    records,
    complete: true,
    ...overrides,
  };
}

function fixture(
  sessions: readonly SessionSummary[],
  records: Readonly<Record<string, readonly WireRecord[]>>,
  now: () => number,
  limits: ConstructorParameters<typeof UsageAggregationService>[2] = {},
  retainedResult: RetainedUsageListResult = {
    items: [],
    complete: true,
    scannedRecords: 0,
  },
  onCheckpointRead: (bytes: number) => void = () => {},
  ephemeral: readonly EphemeralUsageTotal[] = [],
  beforeWireRead: () => Promise<void> = async () => {},
  beforeMetadataRead: () => Promise<void> = async () => {},
  sourceChanges?: UsageSourceChanges,
): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'usage-range-query-'));
  const ix = new TestInstantiationService();
  ix.stub(IBootstrapService, stubBootstrap(home));
  ix.stub(ILogService, stubLog());
  ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
  const queryStore = ix.get(IQueryStore);
  const reads = new Map<string, number>();
  const agentLists = new Map<string, number>();
  const sourceProbes = new Map<string, number>();
  const readBytes = new Map<string, number>();
  const readOffsets: number[] = [];
  const readRanges: { start: number; end: number }[] = [];
  const checkpointReads = new Map<string, number>();
  const retainedQueries: RetainedUsageListQuery[] = [];
  const wires = new Map<string, Buffer>();
  const wireMtimes = new Map<string, number>();
  const setWire = (wireScope: string, wireRecords: readonly WireRecord[]): void => {
    wires.set(
      wireScope,
      Buffer.from(wireRecords.map((record) => JSON.stringify(record)).join('\n') + (wireRecords.length > 0 ? '\n' : '')),
    );
    wireMtimes.set(wireScope, (wireMtimes.get(wireScope) ?? 0) + 1);
  };
  for (const [wireScope, wireRecords] of Object.entries(records)) setWire(wireScope, wireRecords);
  const index: ISessionIndex = {
    _serviceBrand: undefined,
    prepare: async () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
    onDidChangeStatus: Event.None as ISessionIndex['onDidChangeStatus'],
    status: () => ({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 }),
    listRecent: async (query) => {
      const allowed = query.workspaceIds === undefined ? undefined : new Set(query.workspaceIds);
      const items = sessions.filter((session) => allowed === undefined || allowed.has(session.workspaceId));
      const start = query.before === undefined ? 0 : items.findIndex((item) => item.id === query.before) + 1;
      const page = items.slice(start, start + (query.limit ?? items.length));
      return {
        items: page,
        nextCursor: start + page.length < items.length ? page.at(-1)?.id : undefined,
      };
    },
    get: async (id) => sessions.find((session) => session.id === id),
    archiveFamily: async () => [],
    count: async () => sessions.length,
    remove: async () => {},
  };
  let agentIds = ['main'];
  const memory = new InMemoryStorageService();
  const storage = new Proxy(memory, {
    get(target, property, receiver) {
      if (property === 'list') return async (storageScope: string, prefix?: string) => {
        if (!storageScope.endsWith('/agents')) return target.list(storageScope, prefix);
        agentLists.set(storageScope, (agentLists.get(storageScope) ?? 0) + 1);
        await beforeMetadataRead();
        return prefix === undefined ? agentIds : agentIds.filter((id) => id.startsWith(prefix));
      };
      if (property === 'size') return async (storageScope: string, key: string) => {
        if (key !== 'wire.jsonl') return target.size(storageScope, key);
        await beforeMetadataRead();
        return wires.get(storageScope)?.length;
      };
      if (property === 'mtime') return async (storageScope: string, key: string) => {
        if (key !== 'wire.jsonl') return target.mtime(storageScope, key);
        sourceProbes.set(storageScope, (sourceProbes.get(storageScope) ?? 0) + 1);
        await beforeMetadataRead();
        return wireMtimes.get(storageScope);
      };
      if (property === 'read') return async (storageScope: string, key: string) => {
        const value = await target.read(storageScope, key);
        if (value !== undefined && storageScope === 'cache/usage-aggregation-v1') {
          checkpointReads.set(key, (checkpointReads.get(key) ?? 0) + value.byteLength);
          onCheckpointRead(value.byteLength);
        }
        return value;
      };
      if (property === 'write') return async (storageScope: string, key: string, data: Uint8Array, options?: { readonly atomic?: boolean; readonly signal?: AbortSignal }) => {
        await target.write(storageScope, key, data, options);
      };
      if (property === 'readStream') return (storageScope: string, key: string, range?: { readonly start: number; readonly end: number }, options?: { readonly signal?: AbortSignal }) => {
        if (key !== 'wire.jsonl') return target.readStream(storageScope, key, range);
        reads.set(storageScope, (reads.get(storageScope) ?? 0) + 1);
        readOffsets.push(range?.start ?? 0);
        if (range !== undefined) readRanges.push({ start: range.start, end: range.end });
        return (async function* () {
          options?.signal?.throwIfAborted();
          await beforeWireRead();
          options?.signal?.throwIfAborted();
          const bytes = wires.get(storageScope) ?? Buffer.alloc(0);
          const start = range?.start ?? 0;
          const end = Math.min(range?.end ?? bytes.length - 1, bytes.length - 1);
          const slice = end < start ? Buffer.alloc(0) : bytes.subarray(start, end + 1);
          readBytes.set(storageScope, (readBytes.get(storageScope) ?? 0) + slice.length);
          if (slice.length > 0) yield slice;
        })();
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as IFileSystemStorageService;
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
  const model = ix.get(IUsageReadModel);
  const logs = ix.get(IAppendLogStore);
  const facts = ix.get(IUsageFactStore);
  queryFixtures.push({ home, ix, store: queryStore, model });
  const retainedRows = retainedResult.items.map((item) => ({
    source: `retained:deleted:${item.workspaceId}\0${item.id}`,
    session: {
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      archived: item.archived,
      deleted: true,
      ephemeral: false,
      deletedAt: item.deletedAt,
      complete: item.complete,
    } satisfies UsageReadModelSession,
    records: item.records.map((record): UsageFact => ({
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
    })),
  }));
  const ephemeralRows = [...new Set(ephemeral.map((record) => record.workspaceId))].map((workspaceId) => {
    const rows = ephemeral.filter((record) => record.workspaceId === workspaceId);
    const source = `retained:ephemeral:${workspaceId}`;
    return {
      source,
      session: {
        id: source,
        workspaceId,
        createdAt: Math.min(...rows.map((record) => record.time)),
        updatedAt: Math.max(...rows.map((record) => record.time)),
        archived: false,
        deleted: true,
        ephemeral: true,
        complete: true,
      } satisfies UsageReadModelSession,
      records: rows.map((record): UsageFact => ({ time: record.time, model: record.model, usage: record.usage, usageKnown: record.usageKnown })),
    };
  });
  const publishRows = async (includeEphemeral: boolean): Promise<void> => {
    for (const row of includeEphemeral ? [...retainedRows, ...ephemeralRows] : retainedRows) {
      const checkpoint = { generation: `fixture:${row.source}`, offset: row.records.length, size: row.records.length, mtimeMs: 1, boundaryHash: '', valid: row.session.complete !== false };
      await model.apply({
        source: row.source,
        progress: { batchStart: 0, offset: row.records.length, ordinal: row.records.length },
        records: row.records,
        publish: { start: 0, checkpoint, journalSize: row.records.length, session: row.session },
      });
    }
  };
  const retainedUsage: IRetainedUsageService = {
    _serviceBrand: undefined,
    retainDeletedSession: async () => { throw new Error('retain is not used'); },
    prepareReadModel: async (_query, includeEphemeral = true) => {
      await publishRows(includeEphemeral);
      return { complete: retainedResult.complete, scannedRecords: retainedResult.scannedRecords, incompleteReason: retainedResult.incompleteReason };
    },
    listDeletedSessions: async (query) => {
      retainedQueries.push(query);
      return retainedResult;
    },
    listEphemeralUsage: async (input) => ({
      items: ephemeral.filter((item) => input.workspaceIds === undefined || input.workspaceIds.includes(item.workspaceId)),
      complete: true,
      scannedRecords: ephemeral.length,
    }),
  };
  let price: number | undefined = 1;
  let priceObserver = () => {};
  const pricing: IModelPricingService = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    getPricing: async () => ({ items: [], overrides: {} }),
    setPricing: async () => ({ items: [], overrides: {} }),
    resolve: (model) => { priceObserver(); return price === undefined ? undefined : ({ requestedModel: model, catalogModel: model, strategy: 'exact', prices: { inputCostPerToken: price / 4, outputCostPerToken: price / 4, cacheReadInputTokenCost: price / 4, cacheCreationInputTokenCost: price / 4 }, currency: 'USD' }); },
    calculate: (_model, usage) => { priceObserver(); return price === undefined ? undefined : price * ((usage.inputOther ?? 0) + (usage.output ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0)) / 4; },
    refreshNow: async () => false,
    status: () => ({ source: 'empty', keys: 0 }),
  };
  const core = {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === ISessionIndex) return index;
        if (identifier === IFileSystemStorageService) return storage;
        if (identifier === IRetainedUsageService) return retainedUsage;
        if (identifier === IModelPricingService) return pricing;
        if (identifier === IUsageReadModel) return model;
        if (identifier === IUsageFactStore) return facts;
        if (identifier === IQueryStore) return queryStore;
        if (identifier === IAppendLogStore) return logs;
        throw new Error('unexpected service');
      },
    },
  } as unknown as Scope;
  return {
    core,
    service: new UsageAggregationService(core, now, limits, sourceChanges),
    model,
    facts,
    reads,
    agentLists,
    sourceProbes,
    readBytes,
    readOffsets,
    readRanges,
    checkpointReads,
    retainedQueries,
    setWire,
    setMtime: (wireScope: string, mtimeMs: number) => { wireMtimes.set(wireScope, mtimeMs); },
    restart: () => new UsageAggregationService(core, now, limits, sourceChanges),
    setAgentIds: (ids) => { agentIds = ids; },
    setPrice: (value) => { price = value; },
    onPrice: (observer) => { priceObserver = observer; },
  };
}

function scope(workspaceId: string, sessionId: string): string {
  return `sessions/${workspaceId}/${sessionId}/agents/main`;
}

async function openRange(sessions: readonly SessionSummary[], wires: Readonly<Record<string, readonly WireRecord[]>>, sqlite = false) {
  const home = mkdtempSync(join(tmpdir(), 'usage-range-buckets-'));
  const ix = new TestInstantiationService();
  const storage = new InMemoryStorageService();
  ix.stub(IBootstrapService, stubBootstrap(home));
  ix.stub(ILogService, stubLog());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IQueryStore, new SyncDescriptor<IQueryStore>(sqlite ? SqliteQueryStore : MiniDbQueryStore));
  ix.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
  const store = ix.get(IQueryStore);
  const model = ix.get(IUsageReadModel);
  const logs = ix.get(IAppendLogStore);
  const facts = ix.get(IUsageFactStore);
  queryFixtures.push({ home, ix, store, model });
  for (const [wireScope, wireRecords] of Object.entries(wires)) {
    await storage.write(wireScope.slice(0, wireScope.lastIndexOf('/')), wireScope.slice(wireScope.lastIndexOf('/') + 1), new Uint8Array());
    for (const record of wireRecords) logs.append(wireScope, 'wire.jsonl', record);
    if (wireRecords.length > 0) await logs.flush(wireScope, 'wire.jsonl');
  }
  const pricing = {
    ready: Promise.resolve(),
    resolve: (model: string) => ({ requestedModel: model, catalogModel: model, strategy: 'exact' as const, prices: { inputCostPerToken: 0.25, outputCostPerToken: 0.25, cacheReadInputTokenCost: 0.25, cacheCreationInputTokenCost: 0.25 }, currency: 'USD' }),
    calculate: (_model: string, usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }) => (usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation) / 4,
  };
  const core = { accessor: { get: (id: unknown) => {
    if (id === ISessionIndex) return { listRecent: async () => ({ items: [...sessions] }) };
    if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
    if (id === IModelPricingService) return pricing;
    if (id === IUsageReadModel) return model;
    if (id === IUsageFactStore) return facts;
    if (id === IAppendLogStore) return logs;
    return ix.get(id as typeof IQueryStore);
  } } } as unknown as Scope;
  return { logs, store, core, storage };
}

function withRecords(base: Readonly<Record<string, readonly WireRecord[]>>, extra: Readonly<Record<string, readonly WireRecord[]>>): Record<string, readonly WireRecord[]> {
  const merged: Record<string, readonly WireRecord[]> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(extra)])) merged[key] = [...(base[key] ?? []), ...(extra[key] ?? [])];
  return merged;
}

async function query(service: UsageAggregationService, input: UsageQuery = {}) {
  return service.query(input);
}

describe('UsageAggregationService record-level sources', () => {
  it('separates providers sharing an alias and profiles sharing an agent in each bucket', async () => {
    const day = Date.UTC(2026, 9, 4);
    const records = [
      { ...usageRecord(day, 1), modelAlias: 'shared', provider: 'provider-a', agentId: 'same-agent', profileName: 'explore' },
      { ...usageRecord(day + 1, 2), modelAlias: 'shared', provider: 'provider-b', agentId: 'same-agent', profileName: 'general' },
      { ...usageRecord(day + 2, 3), modelAlias: 'shared', provider: 'provider-b', agentId: 'same-agent', profileName: 'general' },
      { ...usageRecord(day + 3, 4), modelAlias: 'shared', agentId: 'same-agent' },
      { ...usageRecord(day + 4, 5), modelAlias: 'shared', provider: 'unknown', agentId: 'same-agent', profileName: 'unknown' },
      { ...usageRecord(day + 86_400_000, 6), modelAlias: 'shared', provider: 'provider-a', agentId: 'same-agent', profileName: 'general' },
    ];
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: records }, () => day + 2 * 86_400_000);
    const provider = await query(f.service, { dimension: 'provider' });
    expect(provider.summary).toMatchObject({ cost_usd_estimated: 6, session_count: 1, cost_unknown: false });
    expect(provider.trend[0]?.groups.map((group) => [group.key, group.provider, group.cost_usd_estimated])).toEqual([
      ['provider:"provider-b"', 'provider-b', 2], ['provider:"provider-a"', 'provider-a', 1],
      ['provider:"unknown"', 'unknown', 1], ['provider:null', null, 1],
    ]);
    expect(provider.trend[1]?.groups).toEqual([expect.objectContaining({ key: 'provider:"provider-a"', cost_usd_estimated: 1 })]);
    const profile = await query(f.service, { dimension: 'profile' });
    expect(profile.summary).toEqual(provider.summary);
    expect(profile.trend[0]?.groups.map((group) => [group.key, group.profile_name, group.cost_usd_estimated])).toEqual([
      ['profile:"general"', 'general', 2], ['profile:"explore"', 'explore', 1],
      ['profile:"unknown"', 'unknown', 1], ['profile:null', null, 1],
    ]);
    expect(profile.trend[1]?.groups).toEqual([expect.objectContaining({ key: 'profile:"general"', cost_usd_estimated: 1 })]);
    for (const dimension of ['agent', 'model', 'project', 'session'] as const) {
      const old = await query(f.service, { dimension });
      expect(old.summary).toEqual(provider.summary);
      expect(old.sessions).toEqual(provider.sessions);
      expect(old.trend[0]?.groups).toEqual([expect.objectContaining({
        key: { agent: 'same-agent', model: 'shared', project: 'w', session: 's' }[dimension],
        cost_usd_estimated: 5, provider: null, profile_name: null,
      })]);
    }
  });

  it('filters records, bucket drilldown and session money by exact profiles and intersects other filters', async () => {
    const matching = { modelAlias: 'shared', provider: 'provider-a', agentId: 'same-agent', profileName: 'explore' };
    const f = fixture([summary('s-a', 'w'), summary('s-b', 'w'), summary('s-other', 'other-w')], {
      [scope('w', 's-a')]: [
        { ...usageRecord(99, 0), ...matching }, { ...usageRecord(100, 1), ...matching },
        { ...usageRecord(101, 2), ...matching, profileName: 'general' },
        { ...usageRecord(102, 3), ...matching, provider: 'provider-b' },
        { ...usageRecord(103, 4), ...matching, modelAlias: 'other' },
        { ...usageRecord(104, 5), ...matching, agentId: 'other-agent' },
        { ...usageRecord(105, 6), ...matching, profileName: undefined },
        { ...usageRecord(106, 7), ...matching, profileName: 'Explore' },
        { ...usageRecord(200, 8), ...matching },
      ],
      [scope('w', 's-b')]: [{ ...usageRecord(100, 9), ...matching }],
      [scope('other-w', 's-other')]: [{ ...usageRecord(100, 10), ...matching }],
    }, () => 1000);
    const input: UsageQuery = {
      range: 'custom', start_at: 100, end_at: 200, dimension: 'profile',
      profile: ['explore', 'explore'], model: 'shared', provider: 'provider-a',
      'agent.id': 'same-agent', 'workspace.id': 'w', timezone_offset_minutes: 480,
    };
    const result = await query(f.service, input);
    expect(result.query).toMatchObject({ profiles: ['explore'], timezone_offset_minutes: 480 });
    expect(result.summary).toMatchObject({ cost_usd_estimated: 2, session_count: 2 });
    expect(result.sessions.items.map((session) => [session.id, session.usage.cost_usd_estimated, session.profile_names])).toEqual([
      ['s-b', 1, ['explore']], ['s-a', 1, ['explore']],
    ]);
    expect(result.trend[0]?.groups).toEqual([expect.objectContaining({ key: 'profile:"explore"', cost_usd_estimated: 2 })]);
    expect(result.trend[0]?.drilldown.sessions).toEqual([
      expect.objectContaining({ session_id: 's-a', turn_ids: [1] }),
      expect.objectContaining({ session_id: 's-b', turn_ids: [9] }),
    ]);
    const repeated = await query(f.service, { ...input, profile: ['general', 'explore', 'general'] });
    expect(repeated.query.profiles).toEqual(['explore', 'general']);
    expect(repeated.summary.cost_usd_estimated).toBe(3);
    expect(repeated.sessions.items.find((item) => item.id === 's-a')?.usage.cost_usd_estimated).toBe(2);
    const byProvider = await query(f.service, { ...input, dimension: 'provider' });
    expect(byProvider.summary).toEqual(result.summary);
    expect(byProvider.sessions).toEqual(result.sessions);
    expect(byProvider.trend[0]?.groups).toEqual([expect.objectContaining({ key: 'provider:"provider-a"', cost_usd_estimated: 2 })]);
  });

  it('binds pagination to normalized filters, data and pricing revisions and rejects the old token version', async () => {
    const f = fixture([summary('a', 'w'), summary('b', 'w')], {
      [scope('w', 'a')]: [{ ...usageRecord(1), profileName: 'explore' }, { ...usageRecord(2), profileName: 'general' }],
      [scope('w', 'b')]: [{ ...usageRecord(1), profileName: 'explore' }, { ...usageRecord(2), profileName: 'general' }],
    }, () => 100);
    const input: UsageQuery = { dimension: 'profile', profile: ['general', 'explore', 'general'], page_size: 1 };
    const first = await query(f.service, input);
    expect(first.sessions.items.map((item) => item.id)).toEqual(['b']);
    const pageToken = first.sessions.next_page_token ?? '';
    const second = await query(f.service, { ...input, profile: ['explore', 'general'], page_token: pageToken });
    expect(second.sessions.items.map((item) => item.id)).toEqual(['a']);
    expect(second.summary).toEqual(first.summary);
    await expect(query(f.service, { ...input, profile: 'explore', page_token: pageToken })).rejects.toThrow('restart from the first page');
    await expect(query(f.service, { page_size: 1, page_token: pageToken })).rejects.toThrow('restart from the first page');
    const unfiltered = await query(f.service, { page_size: 1 });
    expect(JSON.parse(Buffer.from(unfiltered.sessions.next_page_token ?? '', 'base64url').toString('utf8'))).toEqual({
      v: 2, f: 'jx3eMhelCpunxj2P', r: expect.any(String), p: expect.any(String), k: [2, 'b'],
    });
    const old = Buffer.from(JSON.stringify({ v: 1, f: 'jx3eMhelCpunxj2P', k: [2, 'b'] })).toString('base64url');
    await expect(query(f.service, { page_size: 1, page_token: old })).rejects.toThrow('restart from the first page');
    f.setPrice(2);
    await expect(query(f.service, { ...input, page_token: pageToken })).rejects.toThrow('restart from the first page');
  });

  it('keeps unknown sources and usage knowledge across wire, deleted history, ephemeral totals and checkpoint restart', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [
      usageRecord(10),
      { ...usageRecord(11), provider: 'provider-a', profileName: 'explore' },
      { ...usageRecord(12), provider: 'provider-b', profileName: 'general', usageKnown: false },
    ] }, () => 100, {}, {
      items: [retainedSession('deleted', 'w', [retainedRecord(13), retainedRecord(14, { provider: 'provider-a', profileName: 'explore' })])],
      complete: true, scannedRecords: 3,
    }, undefined, [{ workspaceId: 'w', model: 'priced-model', time: 15, usage: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 } }]);
    for (const dimension of ['provider', 'profile'] as const) {
      const response = await query(f.service, { dimension });
      expect(response.summary).toMatchObject({ cost_usd_estimated: 5, cost_unknown: true, tokens_unknown: true, session_count: 2 });
      expect(response.reliability).toMatchObject({ includes_deleted_sessions: true, usage_coverage: { known_records: 5, missing_records: 1, legacy_zero_records: 0 } });
      expect(response.trend[0]?.groups.find((group) => group.key === `${dimension}:null`)).toMatchObject({
        cost_usd_estimated: 3, provider: null, profile_name: null, tokens: { output: 3 },
      });
      const missing = response.trend[0]?.groups.find((group) => group.key === (dimension === 'provider' ? 'provider:"provider-b"' : 'profile:"general"'));
      expect(missing).toMatchObject({ cost_usd_estimated: 0, cost_unknown: true, tokens_unknown: true });
      expect(await query(f.restart(), { dimension })).toEqual(response);
    }
    const filtered = await query(f.service, { dimension: 'profile', profile: 'explore' });
    expect(filtered.summary).toMatchObject({ cost_usd_estimated: 2, tokens_unknown: false, cost_unknown: false });
    expect(filtered.sessions.items.map((item) => item.id)).toEqual(['s', 'deleted']);
    expect(filtered.trend[0]?.groups).toEqual([expect.objectContaining({ key: 'profile:"explore"', cost_usd_estimated: 2 })]);
  });

  it('does not attribute anonymous totals to a known auxiliary source in an unknown group', async () => {
    const ephemeral = [{ workspaceId: 'w', model: 'priced-model', time: 11, usage: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 } }];
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [
      { ...usageRecord(10), profileName: 'explore', agentId: 'same-agent' },
    ] }, () => 100, {}, undefined, undefined, ephemeral);
    const provider = await query(f.service, { dimension: 'provider' });
    expect(provider.trend[0]?.groups).toEqual([expect.objectContaining({
      key: 'provider:null', provider: null, profile_name: null, agent_id: null, cost_usd_estimated: 2,
    })]);
    const g = fixture([summary('s', 'w')], { [scope('w', 's')]: [
      { ...usageRecord(10), provider: 'provider-a', agentId: 'same-agent' },
    ] }, () => 100, {}, undefined, undefined, ephemeral);
    const profile = await query(g.service, { dimension: 'profile' });
    expect(profile.trend[0]?.groups).toEqual([expect.objectContaining({
      key: 'profile:null', provider: null, profile_name: null, agent_id: null, cost_usd_estimated: 2,
    })]);
  });

  it('uses exact clipped bucket and previous-period windows rather than whole five-hour buckets', async () => {
    const day = Date.UTC(2026, 9, 4);
    const offset = 480;
    const fiveHours = 5 * 60 * 60 * 1000;
    const bucketStart = Math.floor((day + offset * 60_000) / fiveHours) * fiveHours - offset * 60_000;
    const start = bucketStart + 100;
    const end = start + 200;
    const previousStart = start - 86_400_000;
    const matching = { modelAlias: 'shared', provider: 'provider-a', profileName: 'explore', agentId: 'same-agent' };
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [
      { ...usageRecord(start - 1, 0), ...matching },
      { ...usageRecord(start, 1), ...matching }, { ...usageRecord(end - 1, 2), ...matching },
      { ...usageRecord(end, 3), ...matching }, { ...usageRecord(start + 1, 4), ...matching, profileName: 'general' },
      { ...usageRecord(previousStart - 1, 5), ...matching },
      { ...usageRecord(previousStart, 6), ...matching },
      { ...usageRecord(previousStart + 200, 7), ...matching },
    ] }, () => day + 86_400_000);
    const input: UsageQuery = {
      range: 'custom', start_at: start, end_at: end, granularity: 'five_hour', dimension: 'profile',
      profile: 'explore', provider: 'provider-a', timezone_offset_minutes: offset,
    };
    const current = await query(f.service, input);
    expect(current.summary.cost_usd_estimated).toBe(2);
    expect(current.trend[0]).toMatchObject({ start_at: bucketStart, end_at: bucketStart + fiveHours });
    expect(current.trend[0]?.groups[0]?.cost_usd_estimated).toBe(2);
    expect(current.sessions.items[0]?.usage.cost_usd_estimated).toBe(2);
    expect(current.trend[0]?.drilldown.sessions[0]?.turn_ids).toEqual([1, 2]);
    const previous = await query(f.service, { ...input, start_at: previousStart, end_at: previousStart + 200 });
    expect(previous.summary.cost_usd_estimated).toBe(1);
    expect(previous.sessions.items[0]?.usage.cost_usd_estimated).toBe(1);
    expect(previous.trend[0]?.drilldown.sessions[0]?.turn_ids).toEqual([6]);
  });
});

describe('UsageAggregationService bounded range sources', () => {
  it('does not read a wire whose epoch mtime is already before the range', async () => {
    const day = Date.UTC(2026, 9, 24);
    const stale = scope('w', 's');
    const recent = scope('w', 'recent');
    const f = fixture([summary('s', 'w'), summary('recent', 'w')], {
      [stale]: [usageRecord(day - 3 * 86_400_000, 1)],
      [recent]: [usageRecord(day + 1_000, 2)],
    }, () => day + 3_600_000);
    f.setMtime(stale, day - 86_400_000);
    f.setMtime(recent, day + 2_000);
    const result = await query(f.service, { range: 'today', timezone_offset_minutes: 0 });
    expect(result.reliability).toMatchObject({ complete: true, incomplete_reason: null });
    expect(result.summary.tokens.output).toBe(1);
    expect(f.reads.get(stale) ?? 0).toBe(0);
    expect(f.readBytes.get(stale) ?? 0).toBe(0);
    expect(f.reads.get(recent) ?? 0).toBeGreaterThan(0);
  });

  it('replays a complete bounded projection after restart and rereads when the watermark moves', async () => {
    const day = Date.UTC(2026, 9, 24);
    const wire = scope('w', 's');
    const records = [usageRecord(day + 1_000, 1), usageRecord(day + 2_000, 2)];
    const f = fixture([summary('s', 'w')], { [wire]: records }, () => day + 3_600_000);
    f.setMtime(wire, day + 3_000);
    const input: UsageQuery = { range: 'today', timezone_offset_minutes: 0, granularity: 'five_hour', dimension: 'model', include_archived: 'true' };
    const cold = await query(f.service, input);
    expect(cold.reliability).toMatchObject({ complete: true, incomplete_reason: null });
    expect(cold.summary.tokens.output).toBe(2);
    const bytes = f.readBytes.get(wire) ?? 0;
    const restarted = f.restart();
    const replayed = await query(restarted, input);
    expect(replayed).toEqual(cold);
    expect(f.readBytes.get(wire) ?? 0).toBe(bytes);
    expect(await query(restarted, input)).toEqual(cold);
    expect(f.readBytes.get(wire) ?? 0).toBe(bytes);
    f.setWire(wire, [...records, usageRecord(day + 3_000, 3)]);
    const appended = await query(restarted, input);
    expect(appended.reliability.complete).toBe(true);
    expect(appended.summary.tokens.output).toBe(3);
    expect(f.readBytes.get(wire) ?? 0).toBeGreaterThan(bytes);
  });

  it('does not store a projection for an incomplete bounded read', async () => {
    const day = Date.UTC(2026, 9, 24);
    const wire = scope('w', 's');
    const invalid = { ...usageRecord(day + 1_000), usage: { inputOther: -1, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    const f = fixture([summary('s', 'w')], { [wire]: [invalid] }, () => day + 3_600_000);
    f.setMtime(wire, day + 3_000);
    const input: UsageQuery = { range: 'today', timezone_offset_minutes: 0 };
    const cold = await query(f.service, input);
    expect(cold.reliability.complete).toBe(false);
    const restarted = f.restart();
    expect((await query(restarted, input)).reliability.complete).toBe(false);
    expect([...f.checkpointReads.keys()].some((key) => key.startsWith('range-projection-'))).toBe(false);
  });
});

describe('UsageAggregationService first load', () => {
  it('measures cold and warm source probes before and after tracked invalidation on the same complete fleet', async () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const sessions = Array.from({ length: 285 }, (_, i) => summary(`example-${i}`, 'example-workspace'));
    const records = Object.fromEntries(sessions.map((session) => [scope(session.workspaceId, session.id), [
      usageRecord(now - 9 * 86_400_000), usageRecord(now, 1),
    ]]));
    const measurements: Array<{ tracked: boolean; coldMs: number; warmMs: number; coldProbes: number; warmProbes: number }> = [];
    const responses = [];
    for (const tracked of [false, true]) {
      let probes = 0;
      const changes = { ready: tracked, onDidChange: () => ({ dispose: () => {} }) };
      const f = fixture(sessions, records, () => now, {}, undefined, undefined, undefined, undefined,
        async () => { probes++; await new Promise<void>((resolve) => setImmediate(resolve)); }, changes);
      const started = performance.now();
      const cold = await query(f.service, { range: 'today' });
      const coldMs = performance.now() - started;
      const coldProbes = probes;
      const warmed = performance.now();
      const warm = await query(f.service, { range: 'today' });
      measurements.push({ tracked, coldMs, warmMs: performance.now() - warmed, coldProbes, warmProbes: probes - coldProbes });
      expect(warm).toEqual(cold);
      expect(warm.reliability.complete).toBe(true);
      expect(warm.summary.tokens.output).toBe(285);
      responses.push(warm);
    }
    const withoutPageToken = (response: UsageResponse): UsageResponse => ({ ...response, sessions: { ...response.sessions, next_page_token: null } });
    expect(withoutPageToken(responses[1]!)).toEqual(withoutPageToken(responses[0]!));
    expect(measurements[0]?.warmProbes).toBe(855);
    expect(measurements[1]?.warmProbes).toBe(0);
    console.log(JSON.stringify({ syntheticFleetSourceProbeBenchmark: { metadataYield: 'setImmediate', sessions: 285, measurements } }));
  });
  it('measures checkpoint validation without dropping old long sessions or filtered details', async () => {
    const now = Date.UTC(2026, 8, 2, 12);
    const today = Date.UTC(2026, 8, 1, 16);
    const sessions = Array.from({ length: 285 }, (_, i) => summary(`session-${i}`, 'workspace-example'));
    const records = Object.fromEntries(sessions.map((session, i) => [scope(session.workspaceId, session.id), [
      usageRecord(today - 1, 0),
      { ...usageRecord(today, 1), modelAlias: i % 2 === 0 ? 'target' : 'other', provider: 'provider-example' },
    ]]));
    let delay = false;
    let metadataReads = 0;
    const source = fixture(sessions, records, () => now, {}, undefined, undefined, [], undefined, async () => {
      metadataReads++;
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    });
    await query(source.service);
    delay = true;
    metadataReads = 0;
    const input = { range: 'today', timezone_offset_minutes: 480, page_size: 25 } as const;
    const start = performance.now();
    const result = await query(source.restart(), input);
    console.log(JSON.stringify({ usageFirstLoad: { elapsedMs: performance.now() - start, metadataReads, sessions: sessions.length, records: 570, checkpointBytes: [...source.checkpointReads.values()].reduce((a, b) => a + b, 0) } }));
    expect(result.reliability.complete).toBe(true);
    expect(result.summary.tokens).toEqual({ input_other: 285, output: 285, input_cache_read: 285, input_cache_creation: 285 });
    expect(result.trend[0]?.request_count).toBe(285);
    expect(result.sessions.items).toHaveLength(25);
    const next = await query(source.service, { ...input, page_token: result.sessions.next_page_token! });
    expect(next.sessions.items).toHaveLength(25);
    expect(next.sessions.items.some((item) => result.sessions.items.some((first) => first.id === item.id))).toBe(false);
    const filtered = await query(source.service, { ...input, model: 'target', provider: 'provider-example' });
    expect(filtered.summary.tokens.output).toBe(143);
    expect(filtered.trend[0]?.drilldown.sessions[0]?.turn_ids).toEqual([1]);
    expect(filtered.summary.cost_unknown).toBe(false);
  });
});

describe('UsageAggregationService recovery', () => {
  it('retries a transient source read without poisoning its durable checkpoint', async () => {
    let unavailable = true;
    const source = fixture([summary('session-example', 'workspace-example')], {
      [scope('workspace-example', 'session-example')]: [usageRecord(10, 1)],
    }, () => 0, {}, undefined, undefined, [], async () => {
      if (unavailable) throw new Error('temporary fixture IO failure');
    });
    const failed = await query(source.service);
    expect(failed.reliability.complete).toBe(false);
    expect(failed.summary.tokens.output).toBe(0);
    unavailable = false;
    const recovered = await query(source.restart());
    expect(recovered.reliability.complete).toBe(true);
    expect(recovered.summary.tokens.output).toBe(1);
  });

  it('yields during ordinary wire reads and warmed aggregation without losing tokens', async () => {
    const records = Array.from({ length: 20_000 }, () => usageRecord(10, 1));
    const source = fixture([summary('session-example', 'workspace-example')], {
      [scope('workspace-example', 'session-example')]: records,
    }, () => 0);
    let loopProgress = 0;
    let running = true;
    const tick = () => { if (running) { loopProgress++; setImmediate(tick); } };
    setImmediate(tick);
    try {
      const cold = await query(source.service);
      expect(cold.summary.tokens.output).toBe(20_000);
      expect(cold.reliability.complete).toBe(true);
      expect(loopProgress).toBeGreaterThan(0);
      loopProgress = 0;
      const warm = await query(source.service);
      expect(warm.summary).toEqual(cold.summary);
      expect(loopProgress).toBeGreaterThan(0);
    } finally {
      running = false;
    }
  });
});

describe('UsageAggregationService accounting evidence', () => {
  it('adds temporary usage to daily totals without exposing a session or drilldown', async () => {
    const { service } = fixture([], {}, () => 86_400_100, {}, undefined, undefined, [{
      workspaceId: 'w', time: 86_400_000, model: 'priced-model',
      usage: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 },
    }]);
    const response = await query(service, { granularity: 'day' });
    expect(response.summary.tokens).toEqual({ input_other: 1, output: 1, input_cache_read: 1, input_cache_creation: 1 });
    expect(response.summary.session_count).toBe(0);
    expect(response.sessions.items).toEqual([]);
    expect(response.trend[0]?.groups[0]?.tokens.input_other).toBe(1);
    expect(response.trend[0]?.drilldown.sessions).toEqual([]);
    const monthly = await query(service, { granularity: 'month' });
    expect(monthly.trend[0]?.groups[0]?.tokens.input_other).toBe(1);
    expect(monthly.sessions.items).toEqual([]);
  });

  it('preserves explicit missing usage and legacy-zero provenance without dropping known tokens', async () => {
    const zero = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const records = [
      { ...usageRecord(100), usageKnown: true },
      { ...usageRecord(101), usage: zero, usageKnown: true },
      { ...usageRecord(102), usage: zero, usageKnown: false },
      { ...usageRecord(103), usage: zero },
    ];
    const { service } = fixture([summary('s', 'w')], { [scope('w', 's')]: records }, () => 200);
    const response = await query(service);
    expect(response.summary.tokens).toEqual({ input_other: 1, output: 1, input_cache_read: 1, input_cache_creation: 1 });
    expect(response.summary).toMatchObject({ tokens_unknown: true, cost_unknown: true });
    expect(response.reliability).toMatchObject({ usage_coverage: { known_records: 2, missing_records: 1, legacy_zero_records: 1 } });
    expect(response.sessions.items[0]?.usage).toMatchObject({ tokens_unknown: true });
    expect(response.trend[0]?.groups[0]).toMatchObject({ tokens_unknown: true });
    const knownZero = fixture([summary('s', 'w')], { [scope('w', 's')]: [records[1]!] }, () => 200);
    expect((await query(knownZero.service)).summary).toMatchObject({ tokens_unknown: false });
    const retained = fixture([], {}, () => 200, {}, {
      items: [retainedSession('deleted', 'w', [retainedRecord(100, { usage: zero, usageKnown: false })])],
      complete: true,
      scannedRecords: 1,
    });
    expect((await query(retained.service)).reliability).toMatchObject({
      includes_deleted_sessions: true,
      usage_coverage: { known_records: 0, missing_records: 1, legacy_zero_records: 0 },
    });
  });
  it('distinguishes no records, genuine zero, rejected records and nonzero usage', async () => {
    const session = summary('session-a', 'workspace-a');
    const at = 1_000;
    const zero = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const scenarios = [
      { records: [], sessions: 0, complete: true, input: 0, covered: false },
      { records: [{ ...usageRecord(at), usage: zero }], sessions: 1, complete: true, input: 0, covered: true },
      { records: [{ ...usageRecord(at), usage: { ...zero, inputOther: -1 } }], sessions: 0, complete: false, input: 0, covered: false },
      { records: [usageRecord(at)], sessions: 1, complete: true, input: 1, covered: true },
    ];
    for (const scenario of scenarios) {
      const { service } = fixture([session], { [scope('workspace-a', 'session-a')]: scenario.records }, () => 2_000);
      const response = await query(service);
      expect(response.summary.session_count).toBe(scenario.sessions);
      expect(response.summary.tokens.input_other).toBe(scenario.input);
      expect(response.reliability.complete).toBe(scenario.complete);
      expect(response.reliability.scanned_sessions).toBe(1);
      expect(response.reliability.coverage.earliest_at).toBe(scenario.covered ? at : null);
    }
  });

  it('counts distinct agent turns and requests per bucket, and attributes the primary billing model', async () => {
    const records = [
      { ...usageRecord(10, 1), agentId: 'main', model: 'model-b', profileName: 'worker' },
      { ...usageRecord(11, 1), agentId: 'main', model: 'model-b', profileName: 'worker' },
      { ...usageRecord(12, 1), agentId: 'child', model: 'model-a', profileName: 'reviewer' },
      { ...usageRecord(13), agentId: 'main', model: 'model-a' },
    ];
    const { service } = fixture([summary('session-a', 'workspace-a')], {
      [scope('workspace-a', 'session-a')]: records,
    }, () => 100);
    const response = await query(service);
    expect(response.trend[0]).toMatchObject({ turn_count: 2, request_count: 4 });
    expect(response.sessions.items[0]).toMatchObject({
      primary_model: 'model-a',
      profile_names: ['reviewer', 'worker'],
    });
  });
});

describe('UsageAggregationService cache budgets', () => {
  it('resumes a source-budgeted inventory without listing or probing the verified prefix again', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `agent-${i}`);
    const f = fixture([summary('s', 'w')], {}, () => 0, { sourceScanLimit: 2 });
    f.setAgentIds(ids);
    let result = await query(f.service);
    expect(result.reliability).toMatchObject({ complete: false, incomplete_reason: 'record_budget' });
    expect([...f.sourceProbes.values()].reduce((a, b) => a + b, 0)).toBe(2);
    for (let page = 0; page < 3; page++) result = await query(f.service);
    expect(result.reliability.complete).toBe(true);
    expect([...f.agentLists]).toEqual([['sessions/w/s/agents', 1]]);
    expect([...f.sourceProbes.values()]).toEqual(ids.map(() => 1));
  });

  it('applies the session cap to inventory and continues at the next session without a watcher', async () => {
    const sessions = Array.from({ length: 3 }, (_, i) => summary(`s${i}`, 'w'));
    const f = fixture(sessions, {}, () => 0, { sessionScanLimit: 1 });
    expect((await query(f.service)).reliability).toMatchObject({ complete: false, incomplete_reason: 'session_cap' });
    expect([...f.agentLists.keys()]).toEqual(['sessions/w/s0/agents']);
    expect((await query(f.service)).reliability.complete).toBe(false);
    expect((await query(f.service)).reliability.complete).toBe(true);
    expect([...f.agentLists.values()]).toEqual([1, 1, 1]);
    expect([...f.sourceProbes.values()]).toEqual([1, 1, 1]);
  });

  it('invalidates published accounting when fallback inventory removes an agent and on a later watch event', async () => {
    let listener: (key?: string) => void = () => {};
    const changes = { ready: true, onDidChange: (callback: typeof listener) => { listener = callback; return { dispose: () => {} }; } };
    const f = fixture([summary('s', 'w')], {
      [scope('w', 's')]: [usageRecord(1)], 'sessions/w/s/agents/child': [usageRecord(1)],
    }, () => 100, {}, undefined, undefined, undefined, undefined, undefined, changes);
    f.setAgentIds(['main', 'child']);
    expect(await f.service.readSessionAccounting('w', 's')).toMatchObject({ complete: true, freshness: 'current', tokens: { output: 2 } });
    await query(f.service);
    changes.ready = false;
    f.setAgentIds(['main']);
    await query(f.service);
    expect(f.service.readSessionAccountingSnapshot('w', 's')).toMatchObject({ complete: true, freshness: 'stale', tokens: { output: 2 } });
    expect(await f.service.readSessionAccounting('w', 's')).toMatchObject({ complete: true, freshness: 'current', tokens: { output: 1 } });
    listener('w\0s');
    expect(f.service.readSessionAccountingSnapshot('w', 's').freshness).toBe('stale');
  });

  it('skips warmed fleet probes and refreshes only signalled sources, with a periodic missed-event repair', async () => {
    const day = Date.UTC(2026, 9, 6);
    let now = day;
    let metadataReads = 0;
    let listener: (key?: string) => void = () => {};
    const changes: UsageSourceChanges = {
      ready: true,
      onDidChange: (callback) => { listener = callback; return { dispose: () => {} }; },
    };
    const f = fixture([summary('s', 'w'), summary('other', 'w')], {
      [scope('w', 's')]: [usageRecord(day - 9 * 86_400_000), usageRecord(day)],
      [scope('w', 'other')]: [usageRecord(day)],
    }, () => now, {}, undefined, undefined, undefined, undefined, async () => { metadataReads++; }, changes);
    const input: UsageQuery = { range: 'today' };
    const cold = await query(f.service, input);
    const baseline = metadataReads;
    expect(await query(f.service, input)).toEqual(cold);
    expect(metadataReads).toBe(baseline);
    f.setWire(scope('w', 's'), [usageRecord(day - 9 * 86_400_000), usageRecord(day), usageRecord(day + 1)]);
    listener('w\0s');
    const beforeSignalledReads = [...f.readBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    f.agentLists.clear();
    f.sourceProbes.clear();
    expect((await query(f.service, input)).summary.tokens.output).toBe(3);
    expect([...f.agentLists]).toEqual([['sessions/w/s/agents', 1]]);
    expect([...f.sourceProbes]).toEqual([[scope('w', 's'), 1]]);
    expect([...f.readBytes.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(beforeSignalledReads);
    const afterAppend = metadataReads;
    expect(afterAppend - baseline).toBe(6);
    await query(f.service, input);
    expect(metadataReads).toBe(afterAppend);
    f.setWire(scope('w', 's'), [usageRecord(day + 2)]);
    listener('w\0s');
    expect((await query(f.service, input)).summary.tokens.output).toBe(2);
    f.setAgentIds(['main', 'child']);
    f.setWire('sessions/w/s/agents/child', [usageRecord(day + 3)]);
    listener();
    expect((await query(f.service, input)).summary.tokens.output).toBe(3);
    f.setWire(scope('w', 's'), [usageRecord(day + 2), usageRecord(day + 4)]);
    now += 9 * 60_000;
    const beforeRepair = metadataReads;
    await query(f.service, input);
    expect(metadataReads).toBe(beforeRepair);
    now += 60_000;
    expect((await query(f.service, input)).summary.tokens.output).toBe(4);
    expect(metadataReads).toBeGreaterThan(beforeRepair);
    expect((await query(f.service)).summary.tokens.output).toBe(4);
  });

  it('does not trust tracked cache when the watcher is unavailable or an export requires validation', async () => {
    let listener: (key?: string) => void = () => {};
    const changes = { ready: true, onDidChange: (callback: typeof listener) => { listener = callback; return { dispose: () => {} }; } };
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(1)] }, () => 100,
      {}, undefined, undefined, undefined, undefined, undefined, changes);
    await query(f.service);
    f.setWire(scope('w', 's'), [usageRecord(1), usageRecord(2)]);
    const exported: number[] = [];
    await f.service.readExportSources(async (source) => { exported.push(source.records.length); });
    expect(exported).toEqual([2]);
    changes.ready = false;
    f.setWire(scope('w', 's'), [usageRecord(3)]);
    expect((await query(f.service)).summary.tokens.output).toBe(1);
  });
  it('does not extend all-history source verification on hot reads or lose invalidation during a load', async () => {
    let now = 100;
    let probes = 0;
    let listener: (key?: string) => void = () => {};
    let signalDuringRead = true;
    const changes = { ready: true, onDidChange: (callback: typeof listener) => { listener = callback; return { dispose: () => {} }; } };
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(1)] }, () => now,
      {}, undefined, undefined, undefined, async () => { if (signalDuringRead) listener('w\0s'); }, async () => { probes++; }, changes);
    expect((await query(f.service)).reliability.complete).toBe(false);
    signalDuringRead = false;
    const first = probes;
    expect((await query(f.service)).reliability.complete).toBe(true);
    expect(probes - first).toBe(3);
    const checked = probes;
    now += 5 * 60_000;
    await query(f.service);
    await query(f.service, { range: 'today' });
    expect(probes).toBe(checked);
    f.setWire(scope('w', 's'), [usageRecord(1), usageRecord(2)]);
    now += 5 * 60_000;
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(2);
    expect(probes).toBeGreaterThan(checked);
  });

  it('retains bounded fleet views above the per-entry cap while validating every source', async () => {
    const day = Date.UTC(2026, 9, 6);
    let metadataReads = 0;
    const records = [usageRecord(day - 8 * 86_400_000), ...Array.from({ length: 5 }, (_, index) => ({
      ...usageRecord(day - index * 86_400_000, index), provider: index % 2 ? 'b' : 'a', profileName: index % 2 ? 'explore' : 'general',
    }))];
    const f = fixture([summary('s', 'w'), summary('empty-a', 'w'), summary('empty-b', 'w')], {
      [scope('w', 's')]: records,
    }, () => day, { cacheMaxEntryRecords: 2, cacheMaxRecords: 5, cacheMaxEntries: 6 }, undefined, undefined, undefined, undefined, async () => { metadataReads++; });
    const input: UsageQuery = { range: 'last_7_days' };
    const cold = await query(f.service, input);
    const checkpoints = [...f.checkpointReads.values()].reduce((sum, value) => sum + value, 0);
    const wireReads = [...f.reads.values()].reduce((sum, value) => sum + value, 0);
    const metadata = metadataReads;
    const warm = await query(f.service, input);
    expect(warm).toEqual(cold);
    expect(warm.reliability.complete).toBe(true);
    expect(warm.summary.tokens.output).toBe(5);
    expect([...f.checkpointReads.values()].reduce((sum, value) => sum + value, 0)).toBe(checkpoints);
    expect([...f.reads.values()].reduce((sum, value) => sum + value, 0)).toBe(wireReads);
    expect(metadataReads - metadata).toBe(9);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(1);
    expect((await query(f.service, { ...input, provider: 'a', profile: 'general' })).summary.tokens.output).toBe(3);
    f.setPrice(2);
    expect((await query(f.service, input)).summary.cost_usd_estimated).toBe(10);
    f.setPrice(undefined);
    expect((await query(f.service, input)).reliability.unknown_price_models).toEqual(['priced-model']);
  });

  it('does not persist a range view when appending, rewriting or changing the agent inventory', async () => {
    const day = Date.UTC(2026, 9, 6);
    const old = usageRecord(day - 10 * 86_400_000);
    const current = usageRecord(day);
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [old, current] }, () => day);
    await query(f.service, { range: 'today' });
    f.setWire(scope('w', 's'), [old, current, usageRecord(day + 1)]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(2);
    expect((await query(f.restart())).summary.tokens.output).toBe(3);
    const rewritten = { ...usageRecord(day + 2), usage: { inputOther: 2, output: 2, inputCacheRead: 2, inputCacheCreation: 2 } };
    f.setWire(scope('w', 's'), [old, current, rewritten]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(3);
    f.setAgentIds(['main', 'child']);
    f.setWire('sessions/w/s/agents/child', [usageRecord(day + 3)]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(4);
    const exported: number[] = [];
    expect((await f.service.readExportSources(async (source) => { exported.push(source.records.length); })).complete).toBe(true);
    expect(exported).toEqual([4]);
    f.service.startFullRescan();
    expect((await finishRescan(f.service)).state).toBe('completed');
    expect((await query(f.restart())).summary.tokens.output).toBe(5);
  });

  it('reloads complete facts on uncovered ranges and after range parts are evicted without reading wire', async () => {
    const day = Date.UTC(2026, 9, 6);
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(day), usageRecord(day - 86_400_000), usageRecord(day - 9 * 86_400_000)] }, () => day, { cacheMaxEntryRecords: 1, cacheMaxEntries: 2 });
    await query(f.service, { range: 'today' });
    expect((await query(f.service, { range: 'last_7_days' })).summary.tokens.output).toBe(2);
    const before = [...f.readBytes.values()].reduce((sum, value) => sum + value, 0);
    const warm = await query(f.service, { range: 'last_7_days' });
    expect(warm.reliability.complete).toBe(true);
    expect(warm.summary.tokens.output).toBe(2);
    expect([...f.readBytes.values()].reduce((sum, value) => sum + value, 0)).toBe(before);
    expect((await query(f.service)).summary.tokens.output).toBe(3);
  });

  it('preserves invalid historical records in otherwise empty warm range views', async () => {
    const day = Date.UTC(2026, 9, 6);
    const invalid = { ...usageRecord(day - 9 * 86_400_000), usage: { inputOther: -1, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [invalid] }, () => day);
    const cold = await query(f.service, { range: 'today' });
    expect(cold.reliability).toMatchObject({ complete: false, incomplete_sessions: 1 });
    expect(await query(f.service, { range: 'today' })).toEqual(cold);
  });

  it('serves warmed cache entries without spending the wire-read budget', async () => {
    const sessionA = summary('session-a', 'workspace-a');
    const sessionB = summary('session-b', 'workspace-b');
    const { service, reads } = fixture(
      [sessionA, sessionB],
      {
        [scope('workspace-a', 'session-a')]: [usageRecord(10, 1), usageRecord(11, 2)],
        [scope('workspace-b', 'session-b')]: [usageRecord(12, 3), usageRecord(13, 4)],
      },
      () => 0,
      { wireRecordBudget: 3, deadlineMs: 10_000 },
    );

    await query(service, { 'workspace.id': 'workspace-a' });
    await query(service, { 'workspace.id': 'workspace-b' });
    const warmedReads = [...reads.values()].reduce((total, count) => total + count, 0);

    const all = await query(service);
    expect(all.summary.session_count).toBe(2);
    expect(all.reliability).toMatchObject({
      complete: true,
      scanned_sessions: 2,
      incomplete_reason: null,
    });
    expect([...reads.values()].reduce((total, count) => total + count, 0)).toBe(warmedReads);
  });

  it('continues a budget-limited scan from its persisted offset', async () => {
    const session = summary('session-a', 'workspace-a');
    const wireScope = scope('workspace-a', 'session-a');
    const { service, reads, readRanges } = fixture(
      [session],
      { [wireScope]: [usageRecord(10, 1), usageRecord(11, 2)] },
      () => 0,
      { wireRecordBudget: 1, deadlineMs: 10_000 },
    );

    const first = await query(service);
    readRanges.length = 0;
    const second = await query(service);
    const checkpoint = Buffer.byteLength(`${JSON.stringify(usageRecord(10, 1))}\n`);
    expect(readRanges.some((range) => range.start === checkpoint)).toBe(true);

    expect(first.reliability).toMatchObject({
      complete: false,
      incomplete_sessions: 1,
      incomplete_reason: 'record_budget',
    });
    expect(second.reliability).toMatchObject({
      complete: true,
      incomplete_sessions: 0,
      incomplete_reason: null,
    });
    expect(second.summary.tokens.output).toBe(2);
    expect(reads.get(wireScope)).toBeGreaterThanOrEqual(2);
  });

  it('budgets usage facts independently of non-usage raw rows, including explicit unknown and invalid facts', async () => {
    const wireScope = scope('w', 's');
    const raw = Array.from({ length: 200_001 }, (_, time) => ({ type: 'message', time } as WireRecord));
    const first = { ...usageRecord(1), usageKnown: false };
    const invalid = { ...usageRecord(2), usage: { inputOther: -1, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    const f = fixture([summary('s', 'w')], { [wireScope]: [...raw, first, invalid, usageRecord(3)] }, () => 0, { usageFactBudget: 1 });
    const one = await query(f.service);
    expect(one.reliability).toMatchObject({ complete: false, incomplete_reason: 'record_budget', usage_coverage: { known_records: 0, missing_records: 1 } });
    const two = await query(f.service);
    expect(two.reliability.complete).toBe(false);
    expect(two.summary.tokens.output).toBe(0);
    const restarted = f.restart();
    let three = await query(restarted);
    for (let attempt = 0; attempt < 8 && three.reliability.incomplete_reason === 'record_budget'; attempt++) three = await query(restarted);
    expect(three.reliability).toMatchObject({ complete: false, incomplete_reason: null });
    expect(three.reliability.usage_coverage).toMatchObject({ known_records: 1, missing_records: 1 });
    expect(three.summary.tokens.output).toBe(1);
    expect(three.summary.tokens_unknown).toBe(true);
  });

  it('keeps a committed bounded prefix after the final waiter cancels', async () => {
    const controller = new AbortController();
    const wireScope = scope('w', 's');
    const large = Array.from({ length: 80 }, (_, time) => ({ type: 'message', time, text: 'x'.repeat(256 * 1024) } as WireRecord));
    const f = fixture([summary('s', 'w')], { [wireScope]: [...large, usageRecord(1)] }, () => 0);
    const commit = f.facts.commit.bind(f.facts);
    let committedOffset = 0;
    const committed = vi.spyOn(f.facts, 'commit').mockImplementationOnce(async (...args) => {
      committedOffset = args[2].offset;
      await commit(...args);
      controller.abort(new DOMException('left page', 'AbortError'));
    });
    try { await expect(f.service.query({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { committed.mockRestore(); }
    await (Reflect.get(f.service, 'modelPreparing') as Promise<void> | undefined)?.catch(() => undefined);
    f.readOffsets.length = 0;
    f.readRanges.length = 0;
    const final = await query(f.restart());
    expect(final.reliability.complete).toBe(true);
    expect(final.summary.tokens.output).toBe(1);
    expect(f.readRanges.some((range) => range.start === committedOffset)).toBe(true);
  });

  it.each(['message', 'usage.record'])('streams a 27 MiB %s row without a permanent length gate or full-body parsing', async (type) => {
    const wireScope = scope('w', 's');
    const large = { ...usageRecord(1), usage: { inputOther: 0, output: 7, inputCacheRead: 0, inputCacheCreation: 0 }, extra: 'x'.repeat(27 << 20), type } as WireRecord;
    const after = { ...usageRecord(2), usage: { inputOther: 0, output: 3, inputCacheRead: 0, inputCacheCreation: 0 } };
    const f = fixture([summary('s', 'w')], { [wireScope]: [large, after] }, () => 0);
    const nativeParse = JSON.parse;
    let largestParsed = 0;
    const parser = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
      largestParsed = Math.max(largestParsed, text.length);
      return nativeParse(text) as unknown;
    });
    let row: Awaited<ReturnType<UsageAggregationService['readAgentUsage']>>['main'] | undefined;
    try {
      for (let attempt = 0; attempt < 16; attempt++) {
        row = (await f.service.readAgentUsage('w', 's', ['main'], { maxBytes: 2 << 20 }))['main'];
        if (row?.complete) break;
      }
    } finally { parser.mockRestore(); }
    expect(row!.complete).toBe(true);
    expect(row!.records.reduce((sum, value) => sum + value.usage.output, 0)).toBe(type === 'usage.record' ? 10 : 3);
    expect(f.readOffsets.some((offset) => offset >= (26 << 20))).toBe(true);
    expect(largestParsed).toBeLessThan(1 << 20);
    const final = await query(f.restart());
    expect(final.reliability.complete).toBe(true);
    expect(final.summary.tokens.output).toBe(type === 'usage.record' ? 10 : 3);
  });

  it('yields and cancels inside a giant JSON row without publishing its unfinished usage', async () => {
    const wireScope = scope('w', 's');
    const f = fixture([summary('s', 'w')], { [wireScope]: [{ ...usageRecord(1), extra: 'x'.repeat(27 << 20) }, usageRecord(2)] }, () => 0);
    const controller = new AbortController();
    let ticks = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      if (ticks === 1) queueMicrotask(() => { controller.abort(new DOMException('left page', 'AbortError')); });
      return ticks++ * 10;
    });
    try { await expect(f.service.query({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { clock.mockRestore(); }
    const final = await query(f.restart());
    expect(final.reliability.complete).toBe(true);
    expect(final.summary.tokens.output).toBe(2);
  });

  it.each([128, 1024])('does not skip usage when the deadline aborts the %i-record yield', async (boundary) => {
    const session = summary('session-a', 'workspace-a');
    const wireScope = scope('workspace-a', 'session-a');
    const records = Array.from({ length: boundary + 3 }, (_, index) => usageRecord(10 + index, index + 1));
    const f = fixture([session], { [wireScope]: records }, () => 0, { deadlineMs: 50 });
    await f.model.source(wireScope);
    const baseline = await query(fixture([session], { [wireScope]: records }, () => 0).service);
    let consumed = 0;
    let abortedAtYield = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const consume = UsageWireFramer.prototype.consume;
    const framing = vi.spyOn(UsageWireFramer.prototype, 'consume').mockImplementation(function (this: UsageWireFramer, ...args) {
      let checks = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => boundary === 128 && checks++ > 0 ? 9 : 0);
      try {
        const slice = consume.apply(this, args);
        consumed += slice.rawCount;
        if (consumed === boundary) queueMicrotask(() => { abortedAtYield = true; vi.advanceTimersByTime(50); });
        return slice;
      } finally { clock.mockRestore(); }
    });
    let first: Awaited<ReturnType<typeof query>>;
    try {
      first = await query(f.service);
    } finally {
      framing.mockRestore();
      vi.useRealTimers();
    }
    expect(abortedAtYield).toBe(true);
    expect(first.reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
    const consumedOffset = Buffer.byteLength(records.slice(0, boundary).map((record) => `${JSON.stringify(record)}\n`).join(''));
    await (Reflect.get(f.service, 'modelPreparing') as Promise<void> | undefined)?.catch(() => undefined);
    const source = await f.facts.summary(wireScope);
    expect(source.totals?.knownUsageRecords).toBe(boundary);
    expect(source.checkpoint?.offset).toBe(consumedOffset);
    f.readOffsets.length = 0;
    f.readRanges.length = 0;
    const resumed = await query(f.restart());
    expect(f.readRanges.some((range) => range.start === consumedOffset)).toBe(true);
    expect(resumed.reliability.complete).toBe(true);
    expect(resumed.summary).toEqual(baseline.summary);
    expect(resumed.reliability.usage_coverage).toEqual(baseline.reliability.usage_coverage);
  });

  it('throws an external cancellation at the wire yield instead of publishing a deadline checkpoint', async () => {
    const session = summary('session-a', 'workspace-a');
    const wireScope = scope('workspace-a', 'session-a');
    const records = Array.from({ length: 131 }, (_, index) => usageRecord(10 + index, index + 1));
    const f = fixture([session], { [wireScope]: records }, () => 0);
    const controller = new AbortController();
    const reason = new DOMException('cancelled at yield', 'AbortError');
    let clockChecks = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      clockChecks++;
      if (clockChecks === 2) queueMicrotask(() => { controller.abort(reason); });
      return clockChecks > 1 ? 9 : 0;
    });
    try {
      await expect(f.service.query({}, controller.signal)).rejects.toBe(reason);
    } finally {
      clock.mockRestore();
    }
  });

  it('checks the deadline again while aggregating cached or replayed records', async () => {
    let time = 0;
    const session = summary('session-a', 'workspace-a');
    const f = fixture(
      [session],
      { [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)] },
      () => time,
      { deadlineMs: 50 },
    );
    await f.service.readAgentUsage('workspace-a', 'session-a', ['main'], { deadlineAt: Infinity, maxFacts: Infinity });
    f.onPrice(() => { time = 100; });
    const result = await query(f.service);
    expect(result.summary.session_count).toBe(1);
    expect(result.summary.tokens.output).toBe(1);
    expect(result.reliability).toMatchObject({
      complete: false,
      incomplete_reason: 'deadline',
    });
  });

  it('enforces a byte cap and skips caching oversized entries', async () => {
    const { service } = fixture(
      [summary('session-a', 'workspace-a')],
      { [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)] },
      () => 0,
      { cacheMaxBytes: 200, deadlineMs: 10_000 },
    );
    expect((await query(service)).summary.tokens.output).toBe(1);
    expect((await query(service)).summary.tokens.output).toBe(1);
  });

  it('detects a new wire tail without a TTL-based reread of its checkpoint', async () => {
    const wireScope = scope('workspace-a', 'session-a');
    const first = usageRecord(10, 1);
    const appended = usageRecord(11, 2);
    const instance = fixture([summary('session-a', 'workspace-a')], { [wireScope]: [first] }, () => 0);
    await query(instance.service);
    const checkpointBytes = [...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0);
    instance.setWire(wireScope, [first, appended]);
    expect((await query(instance.service)).summary.tokens.output).toBe(2);
    expect([...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(checkpointBytes);
  });

  it('reads only an appended wire tail after the cache expires', async () => {
    let time = 0;
    const wireScope = scope('workspace-a', 'session-a');
    const firstRecord = { ...usageRecord(10, 1), padding: 'x'.repeat(16_384) };
    const appendedRecord = usageRecord(11, 2);
    const fullWireBytes = Buffer.byteLength(
      `${JSON.stringify(firstRecord)}\n${JSON.stringify(appendedRecord)}\n`,
    );
    const { service, readBytes, setWire } = fixture(
      [summary('session-a', 'workspace-a')],
      { [wireScope]: [firstRecord] },
      () => time,
      { cacheTtlMs: 10, deadlineMs: 10_000 },
    );
    await query(service);
    const firstBytes = readBytes.get(wireScope) ?? 0;

    setWire(wireScope, [firstRecord, appendedRecord]);
    time = 11;
    const second = await query(service);

    expect(second.summary.tokens.output).toBe(2);
    const incrementalBytes = (readBytes.get(wireScope) ?? 0) - firstBytes;
    expect(incrementalBytes).toBeGreaterThan(0);
    expect(incrementalBytes).toBeLessThan(fullWireBytes);
  });

  it('restores a persisted summary after the service restarts', async () => {
    const wireScope = scope('workspace-a', 'session-a');
    const instance = fixture(
      [summary('session-a', 'workspace-a')],
      { [wireScope]: [usageRecord(10, 1), usageRecord(11, 2)] },
      () => 0,
      { deadlineMs: 10_000 },
    );
    await query(instance.service);
    const bytesAfterInitialScan = instance.readBytes.get(wireScope) ?? 0;

    const restored = await query(instance.restart());

    expect(restored.summary.tokens.output).toBe(2);
    expect((instance.readBytes.get(wireScope) ?? 0) - bytesAfterInitialScan).toBe(0);
    expect(restored.reliability).toMatchObject({ complete: true, incomplete_reason: null });
  });

  it('counts an empty agent inventory as complete zero usage without a session row', async () => {
    const instance = fixture([summary('session-a', 'workspace-a')], {}, () => 0);
    instance.setAgentIds([]);
    for (const service of [instance.service, instance.restart()]) {
      const result = await query(service);
      expect(result.summary.tokens.output).toBe(0);
      expect(result.sessions.items).toEqual([]);
      expect(result.reliability).toMatchObject({ complete: true, incomplete_sessions: 0 });
    }
  });

  it('resets a checkpoint when a wire is rewritten at the same size', async () => {
    let time = 0;
    const wireScope = scope('workspace-a', 'session-a');
    const { service, setWire } = fixture(
      [summary('session-a', 'workspace-a')],
      { [wireScope]: [usageRecord(10, 1)] },
      () => time,
      { cacheTtlMs: 10, deadlineMs: 10_000 },
    );
    expect((await query(service)).reliability.coverage.earliest_at).toBe(10);

    setWire(wireScope, [usageRecord(20, 1)]);
    time = 11;
    const rewritten = await query(service);

    expect(rewritten.summary.tokens.output).toBe(1);
    expect(rewritten.reliability.coverage).toEqual({ earliest_at: 20, latest_at: 20 });
  });

  it('single-flights concurrent cold reads of one session', async () => {
    const wireScope = scope('workspace-a', 'session-a');
    const { service, reads } = fixture(
      [summary('session-a', 'workspace-a')],
      { [wireScope]: [usageRecord(10, 1)] },
      () => 0,
      { deadlineMs: 10_000 },
    );

    const [first, second] = await Promise.all([query(service), query(service)]);

    expect(first.summary.tokens.output).toBe(1);
    expect(second.summary.tokens.output).toBe(1);
    expect(reads.get(wireScope)).toBe(2);
  });

  it('reuses a warmed fleet projection without rereading large checkpoints on repeated requests', async () => {
    const sessions = Array.from({ length: 337 }, (_, index) => summary(`session-${index}`, 'workspace-a'));
    const large = (count: number, time: number) => Array.from({ length: count }, () => ({ ...usageRecord(time, 1), modelAlias: 'x'.repeat(170) }));
    let time = 0;
    let chargeReads = false;
    const instance = fixture(
      sessions,
      { [scope('workspace-a', 'session-0')]: large(65_000, 10), [scope('workspace-a', 'session-1')]: large(56_000, 11) },
      () => time,
      { deadlineMs: 1_500 },
      { items: [], complete: true, scannedRecords: 0 },
      (bytes) => { if (chargeReads) time += Math.ceil(bytes / 20_000); },
    );
    await instance.service.readAgentUsage('workspace-a', 'session-0', ['main'], { deadlineAt: Infinity, maxFacts: Infinity });
    await instance.service.readAgentUsage('workspace-a', 'session-1', ['main'], { deadlineAt: Infinity, maxFacts: Infinity });
    const initial = await query(instance.service);
    expect(initial.summary.tokens.output).toBe(121_000);
    chargeReads = true;
    const readBefore = [...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0);
    const started = performance.now();
    const second = await query(instance.service);
    const elapsedMs = performance.now() - started;
    const readAfter = [...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0);
    console.info('usage 337-session warm query', { elapsedMs, checkpointBytes: readAfter - readBefore, simulatedClockMs: time });
    expect(second.reliability).toMatchObject({ complete: true, scanned_sessions: 337 });
    expect(second.summary.tokens.output).toBe(121_000);
    expect(readAfter - readBefore).toBe(0);

    const cold = instance.restart();
    time = 0;
    const coldStarted = performance.now();
    const coldFirst = await query(cold);
    const coldFirstMs = performance.now() - coldStarted;
    const coldReadBytes = [...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0) - readAfter;
    const warmStarted = performance.now();
    const coldSecond = await query(cold);
    const coldSecondMs = performance.now() - warmStarted;
    console.info('usage checkpoint restart', { coldFirstMs, coldSecondMs, coldReadBytes, simulatedClockMs: time });
    expect(coldFirst.reliability).toMatchObject({ complete: true, incomplete_reason: null });
    expect(coldFirst.reliability.usage_coverage?.known_records).toBe(121_000);
    expect(coldReadBytes).toBe(0);
    expect(coldSecond.reliability).toMatchObject({ complete: true, scanned_sessions: 337 });
    expect(coldSecond.summary.tokens.output).toBe(121_000);
    expect([...instance.checkpointReads.values()].reduce((sum, bytes) => sum + bytes, 0) - readAfter - coldReadBytes).toBeLessThan(100_000);
  }, 60_000);
});

describe('UsageAggregationService timezone ranges', () => {
  it('applies UTC+8 and UTC-5 offsets to today boundaries', async () => {
    const now = Date.UTC(2026, 8, 1, 12);
    const session = summary('session-a', 'workspace-a');
    const { service: east } = fixture(
      [session],
      {
        [scope('workspace-a', 'session-a')]: [
          usageRecord(Date.UTC(2026, 7, 31, 15, 59), 1),
          usageRecord(Date.UTC(2026, 7, 31, 16), 2),
        ],
      },
      () => now,
      { deadlineMs: 10_000 },
    );
    const eastResult = await query(east, { range: 'today', timezone_offset_minutes: 480 });
    expect(eastResult.query.range).toMatchObject({
      start_at: Date.UTC(2026, 7, 31, 16),
      end_at: Date.UTC(2026, 8, 1, 16),
    });
    expect(eastResult.summary.tokens.output).toBe(1);

    const { service: west } = fixture(
      [session],
      {
        [scope('workspace-a', 'session-a')]: [
          usageRecord(Date.UTC(2026, 8, 1, 4, 59), 1),
          usageRecord(Date.UTC(2026, 8, 1, 5), 2),
        ],
      },
      () => now,
      { deadlineMs: 10_000 },
    );
    const westResult = await query(west, { range: 'today', timezone_offset_minutes: -300 });
    expect(westResult.query.range).toMatchObject({
      start_at: Date.UTC(2026, 8, 1, 5),
      end_at: Date.UTC(2026, 8, 2, 5),
    });
    expect(westResult.summary.tokens.output).toBe(1);
  });
});

describe('UsageAggregationService retained sessions', () => {
  it('keeps active wire usage authoritative over a retained snapshot', async () => {
    const active = summary('session-a', 'workspace-a');
    const { service, retainedQueries } = fixture(
      [active],
      { [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)] },
      () => 0,
      { deadlineMs: 10_000 },
      {
        items: [retainedSession('session-a', 'workspace-a', [retainedRecord(20)])],
        complete: true,
        scannedRecords: 2,
      },
    );

    const result = await query(service);

    expect(result.summary.tokens.output).toBe(1);
    expect(result.sessions.items).toEqual([
      expect.objectContaining({ id: 'session-a', deleted: false }),
    ]);
    expect(result.reliability).toMatchObject({
      complete: true,
      includes_deleted_sessions: false,
    });
    expect(retainedQueries).toEqual([]);
  });

  it('includes deleted sessions from retained usage', async () => {
    const { service } = fixture(
      [],
      {},
      () => 0,
      { deadlineMs: 10_000 },
      {
        items: [retainedSession('session-deleted', 'workspace-a', [retainedRecord(10)])],
        complete: true,
        scannedRecords: 2,
      },
    );

    const result = await query(service);

    expect(result.summary).toMatchObject({ session_count: 1 });
    expect(result.summary.tokens.output).toBe(1);
    expect(result.sessions.items).toEqual([
      expect.objectContaining({ id: 'session-deleted', deleted: true }),
    ]);
    expect(result.reliability).toMatchObject({
      complete: true,
      includes_deleted_sessions: true,
      incomplete_reason: null,
    });
  });

  it.each(['deadline', 'record_budget'] as const)(
    'maps retained %s incompleteness into response reliability',
    async (incompleteReason) => {
      const { service } = fixture(
        [],
        {},
        () => 0,
        { deadlineMs: 10_000 },
        { items: [], complete: false, incompleteReason, scannedRecords: 0 },
      );

      const result = await query(service);

      expect(result.reliability).toMatchObject({
        complete: false,
        includes_deleted_sessions: false,
        incomplete_reason: incompleteReason,
      });
    },
  );

  it('applies range and attribution filters to retained records', async () => {
    const records = [
      retainedRecord(12, {
        modelAlias: 'model-target',
        provider: 'provider-target',
        agentId: 'agent-target',
      }),
      retainedRecord(9, {
        modelAlias: 'model-target',
        provider: 'provider-target',
        agentId: 'agent-target',
      }),
      retainedRecord(13, {
        modelAlias: 'model-other',
        provider: 'provider-target',
        agentId: 'agent-target',
      }),
      retainedRecord(14, {
        modelAlias: 'model-target',
        provider: 'provider-other',
        agentId: 'agent-target',
      }),
      retainedRecord(15, {
        modelAlias: 'model-target',
        provider: 'provider-target',
        agentId: 'agent-other',
      }),
    ];
    const { service, retainedQueries } = fixture(
      [],
      {},
      () => 0,
      { deadlineMs: 10_000 },
      {
        items: [retainedSession('session-deleted', 'workspace-a', records)],
        complete: true,
        scannedRecords: records.length + 1,
      },
    );

    const result = await query(service, {
      range: 'custom',
      start_at: 10,
      end_at: 20,
      model: 'model-target',
      provider: 'provider-target',
      'agent.id': 'agent-target',
      'workspace.id': 'workspace-a',
    });

    expect(result.summary.tokens.output).toBe(1);
    expect(result.query).toMatchObject({
      models: ['model-target'],
      providers: ['provider-target'],
      agent_ids: ['agent-target'],
      workspace_ids: ['workspace-a'],
    });
    expect(result.reliability.includes_deleted_sessions).toBe(true);
    expect(retainedQueries).toEqual([]);
  });
});

async function finishRescan(service: UsageAggregationService) {
  await vi.waitFor(() => expect(service.rescanStatus().state).not.toBe('running'), { timeout: 60_000, interval: 0 });
  return service.rescanStatus();
}

describe('UsageAggregationService full rescan', () => {
  it('bypasses session, record and deadline budgets and persists the completed inventory across restart', async () => {
    const sessions = Array.from({ length: 505 }, (_, index) => summary(`s_${index}`, 'ws'));
    const records = Object.fromEntries(sessions.map((item) => [scope('ws', item.id), [usageRecord(1), usageRecord(2)]]));
    let clock = 0;
    const f = fixture(sessions, records, () => clock, { sessionScanLimit: 1, wireRecordBudget: 1, deadlineMs: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try { expect((await query(f.service)).reliability.incomplete_reason).toBe('record_budget'); }
    finally { vi.useRealTimers(); }
    const started = f.service.startFullRescan();
    expect(started).toMatchObject({ state: 'running', scanned_sessions: 0, scanned_records: 0, finished_at: null });
    clock = 1_000_000;
    const completed = await finishRescan(f.service);
    expect(completed).toMatchObject({ state: 'completed', scanned_sessions: 505, total_sessions: 505, scanned_records: 1009, error: null });
    const restarted = f.restart();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let response: Awaited<ReturnType<typeof query>>;
    try { response = await query(restarted); }
    finally { vi.useRealTimers(); }
    expect(response.summary.session_count).toBe(505);
    expect(response.reliability).toMatchObject({ complete: false, incomplete_reason: 'session_cap' });
    expect(response.summary.tokens.input_other).toBe(1010);
    const reads = [...f.reads.values()].reduce((sum, count) => sum + count, 0);
    const verified = new UsageAggregationService(f.core, () => clock, { sessionScanLimit: 1000, wireRecordBudget: 1 });
    expect((await query(verified)).reliability).toMatchObject({ complete: true, incomplete_reason: null });
    verified.dispose();
    expect([...f.reads.values()].reduce((sum, count) => sum + count, 0)).toBe(reads);
    restarted.startFullRescan();
    expect((await finishRescan(restarted)).scanned_records).toBe(0);
    expect([...f.reads.values()].reduce((sum, count) => sum + count, 0)).toBe(reads);
  });

  it('reuses a running task and serves checkpoint reads without waiting for the scanner', async () => {
    let block = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture([summary('s', 'ws')], { [scope('ws', 's')]: [usageRecord(1)] }, () => 1,
      {}, undefined, undefined, [], async () => { if (block) await gate; });
    await query(f.service);
    f.setWire(scope('ws', 's'), [usageRecord(1), usageRecord(2)]);
    block = true;
    const started = f.service.startFullRescan();
    await vi.waitFor(() => expect(f.service.rescanStatus()).toMatchObject({ state: 'running', total_sessions: 1, scanned_sessions: 0 }), { timeout: 5_000 });
    expect(f.service.startFullRescan().started_at).toBe(started.started_at);
    const response = await query(f.service);
    expect(response.summary.tokens.input_other).toBe(1);
    expect(response.reliability.complete).toBe(false);
    release();
    expect(await finishRescan(f.service)).toMatchObject({ state: 'completed', scanned_records: 1, scanned_sessions: 1 });
    expect((await query(f.service)).summary.tokens.input_other).toBe(2);
  });

  it('reports incremental progress and completes a single session beyond the default 200k record budget', async () => {
    const f = fixture([summary('s', 'ws')], {
      [scope('ws', 's')]: Array.from({ length: 200_005 }, () => usageRecord(1)),
    }, () => 1);
    f.service.startFullRescan();
    await vi.waitFor(() => {
      const status = f.service.rescanStatus();
      expect(status.state).toBe('running');
      expect(status.scanned_sessions).toBe(0);
      expect(status.scanned_records).toBeGreaterThan(0);
      expect(status.total_sessions).toBe(1);
    }, { timeout: 5_000 });
    expect(await finishRescan(f.service)).toMatchObject({ state: 'completed', scanned_records: 200_005 });
    expect((await query(f.service)).summary.tokens.input_other).toBe(200_005);
  }, 30_000);

  it('reports failed checkpoints and permits a retry', async () => {
    const f = fixture([summary('s', 'ws')], { [scope('ws', 's')]: [{ ...usageRecord(1), model: '' }] }, () => 1);
    f.service.startFullRescan();
    expect(await finishRescan(f.service)).toMatchObject({ state: 'failed', scanned_sessions: 1, total_sessions: 1 });
    expect(f.service.rescanStatus().error).toContain('incomplete');
    f.setWire(scope('ws', 's'), [usageRecord(1), usageRecord(2)]);
    f.service.startFullRescan();
    expect((await finishRescan(f.service)).state).toBe('completed');
  });

  it('uses a ten-second default deadline while preserving explicitly shorter budgets', async () => {
    let clock = 0;
    const f = fixture([summary('s', 'ws')], { [scope('ws', 's')]: [usageRecord(1)] }, () => clock,
      {}, undefined, undefined, [], async () => { clock = 9000; });
    expect((await query(f.service)).reliability.complete).toBe(true);
  });
});


describe('UsageSourceTracker', () => {
  it('uses committed append/rewrite events and lazy targeted filesystem invalidation, pruning unrelated trees', async () => {
    const root = join(process.cwd(), '.tmp', 'usage-tracker', 'sessions');
    const memory = new InMemoryStorageService();
    const storage = new Proxy(memory, { get: (target, key, receiver) => {
      if (key === 'pathFor') return () => root;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const logs = new AppendLogStore(storage);
    let signal: (filename: string | null, event?: 'rename' | 'change') => void = () => {};
    let failed: (error: unknown) => void = () => {};
    let watches = 0;
    let disposed = false;
    const core = { accessor: { get: (id: unknown) => {
      if (id === IFileSystemStorageService) return storage;
      if (id === IAppendLogStore) return logs;
      if (id === ILogService) return { warn: () => {} };
      throw new Error('unexpected service');
    } } } as unknown as Scope;
    const tracker = new UsageSourceTracker(core, (_root, listener) => {
      watches++; signal = listener;
      return { close: () => { disposed = true; }, on: (_event, listener) => { failed = listener; } };
    });
    const changes: Array<string | undefined> = [];
    tracker.onDidChange((key) => { changes.push(key); });
    expect(watches).toBe(0);
    logs.append('sessions/w/s/agents/main', 'wire.jsonl', usageRecord(1));
    await logs.flush();
    expect(changes).toEqual(['w\0s']);
    await logs.rewrite('sessions/w/s/agents/main', 'wire.jsonl', [usageRecord(2)]);
    expect(changes).toEqual(['w\0s', 'w\0s']);
    expect(tracker.ready).toBe(true);
    expect(watches).toBe(1);
    expect(changes.at(-1)).toBeUndefined();
    const count = changes.length;
    signal('w/s/media');
    signal('w/s/agents/main/blobs');
    signal('w/s/agents', 'change');
    signal('w/s/agents/child', 'change');
    signal('w/s/agents/child/wire.jsonl.cold.lock', 'rename');
    expect(changes).toHaveLength(count);
    signal('w/s/agents/main/wire.jsonl', 'change');
    expect(changes).toHaveLength(count + 1);
    expect(changes.at(-1)).toBe('w\0s');
    signal('w\\s\\agents\\child', 'rename');
    expect(changes).toHaveLength(count + 2);
    expect(changes.at(-1)).toBe('w\0s');
    signal(null);
    expect(changes.at(-1)).toBeUndefined();
    failed(new Error('watch lost'));
    expect(tracker.ready).toBe(false);
    expect(disposed).toBe(true);
    tracker.dispose();
    expect(tracker.ready).toBe(false);
    await logs.close();
    await logs.dispose();
  });

  it('leaves source validation enabled after unsupported watches and in-memory storage', async () => {
    const writes = new Emitter<{ scope: string; key: string }>();
    for (const root of [undefined, join(process.cwd(), '.tmp', 'unsupported-watch')]) {
      let warnings = 0;
      const core = { accessor: { get: (id: unknown) => {
        if (id === IFileSystemStorageService) return { pathFor: () => root };
        if (id === IAppendLogStore) return { onDidWrite: writes.event };
        if (id === ILogService) return { warn: () => { warnings++; } };
        throw new Error('unexpected service');
      } } } as unknown as Scope;
      const tracker = new UsageSourceTracker(core, () => { throw new Error('unsupported'); });
      expect(tracker.ready).toBe(false);
      expect(warnings).toBe(root === undefined ? 0 : 1);
      expect(tracker.ready).toBe(false);
      tracker.dispose();
    }
    writes.dispose();
  });
});




























describe('shared agent and History typed usage', () => {
  it('keeps one query snapshot stable when a backdated append commits before its response returns', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [usageRecord(10, 1)] }, true);
    const model = saved.core.accessor.get(IUsageReadModel);
    const query = model.query.bind(model);
    const snapshot = vi.spyOn(model, 'query').mockImplementationOnce(async (...args) => {
      const result = await query(...args);
      saved.logs.append(main, 'wire.jsonl', usageRecord(1, 2));
      await saved.logs.flush(main, 'wire.jsonl');
      return result;
    });
    const service = new UsageAggregationService(saved.core, () => 100);
    const input = { range: 'custom', start_at: 0, end_at: 100 } as const;
    const first = await service.query(input);
    expect(first.reliability.complete).toBe(true);
    expect(first.summary.tokens.output).toBe(1);
    const next = await service.query(input);
    const restarted = await new UsageAggregationService(saved.core, () => 100).query(input);
    for (const response of [next, restarted]) {
      expect(response.reliability.complete).toBe(true);
      expect(response.summary.tokens).toEqual({ input_other: 2, output: 2, input_cache_read: 2, input_cache_creation: 2 });
      expect(response.summary.cost_usd_estimated).toBe(2);
      expect(response.reliability.usage_coverage).toEqual({ known_records: 2, missing_records: 0, legacy_zero_records: 0 });
      expect(response.trend[0]?.turn_count).toBe(2);
    }
    snapshot.mockRestore(); service.dispose();
  });

  it('preserves the fully priced record subtotal when another same-model record is unpriced', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [
      { ...usageRecord(10, 1), usageKnown: true, usage: { inputOther: 10, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
      { ...usageRecord(11, 2), usageKnown: true, usage: { inputOther: 0, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } },
    ] }, true);
    let outputCostPerToken: number | undefined;
    const pricing = vi.spyOn(saved.core.accessor.get(IModelPricingService), 'resolve').mockImplementation((model) => ({ requestedModel: model, catalogModel: model, strategy: 'exact', prices: { inputCostPerToken: 0.1, outputCostPerToken }, currency: 'USD' }));
    const reads = vi.spyOn(saved.storage, 'readStream');
    const service = new UsageAggregationService(saved.core, () => 100);
    const first = await service.query({});
    expect(first.reliability.complete).toBe(true);
    expect(first.summary).toMatchObject({ tokens: { input_other: 10, output: 1 }, cost_usd_estimated: 1, cost_unknown: true });
    expect(first.sessions.items[0]?.usage).toMatchObject({ cost_usd_estimated: 1, cost_unknown: true });
    expect(first.trend[0]?.groups[0]).toMatchObject({ cost_usd_estimated: 1, cost_unknown: true });
    outputCostPerToken = 2;
    const priced = await service.query({});
    expect(priced.summary).toMatchObject({ cost_usd_estimated: 3, cost_unknown: false });
    expect(priced.summary.tokens).toEqual(first.summary.tokens);
    expect(reads.mock.calls.filter(([, key]) => key === 'wire.jsonl')).toHaveLength(0);
    pricing.mockRestore(); service.dispose();
  });

  it('queries already indexed facts beyond the migration allowance without reading journals or generic query-store rows', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: Array.from({ length: 600 }, (_, index) => usageRecord(index + 1, index)) }, true);
    const facts = saved.core.accessor.get(IUsageFactStore);
    const read = vi.spyOn(facts, 'read'), summarize = vi.spyOn(facts, 'summary');
    const streams = vi.spyOn(saved.storage, 'readStream');
    const writes = vi.spyOn(saved.store, 'batch');
    const service = new UsageAggregationService(saved.core, () => 1000, { usageFactBudget: 1 });
    const input = { range: 'custom', start_at: 0, end_at: 1000 } as const;
    const result = await service.query(input);
    expect(result.reliability.complete).toBe(true);
    expect(result.summary.tokens.output).toBe(600);
    expect(result.reliability.usage_coverage?.known_records).toBe(600);
    expect(result.trend[0]?.turn_count).toBe(600);
    expect(read).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
    expect(streams).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    const reopened = await new UsageAggregationService(saved.core, () => 1000).query(input);
    expect(reopened.summary).toEqual(result.summary);
    expect(reopened.trend).toEqual(result.trend);
    service.dispose();
  });

  it('reuses one durable source across agent reads, History, appends, rewrites and restart', async () => {
    const main = scope('w', 's'), child = main.replace('/main', '/child');
    const f = fixture([summary('s', 'w')], { [main]: [usageRecord(1), usageRecord(100)], [child]: [usageRecord(100)] }, () => 200);
    f.setAgentIds(['main', 'child']);
    const childOnly = await f.service.readAgentUsage('w', 's', ['child']);
    expect(childOnly['child']).toMatchObject({ complete: true, records: [expect.objectContaining({ sourceAgentId: 'child' })] });
    expect(f.reads.has(main)).toBe(false);
    const history = await f.service.query({});
    expect(history.reliability.complete).toBe(true);
    expect(history.summary.tokens.input_other).toBe(3);
    const before = new Map(f.readBytes);
    await f.service.query({ range: 'custom', start_at: 50, end_at: 150 });
    const agent = await f.service.readAgentUsage('w', 's', ['main', 'child']);
    expect(agent['main']?.records).toHaveLength(2);
    expect(agent['child']?.records).toHaveLength(1);
    expect(f.readBytes).toEqual(before);
    const restarted = f.restart();
    expect((await restarted.readAgentUsage('w', 's', ['main']))['main']?.records).toHaveLength(2);
    expect(f.readBytes).toEqual(before);
    f.setWire(main, [usageRecord(1), usageRecord(100), usageRecord(150)]);
    expect((await restarted.readAgentUsage('w', 's', ['main']))['main']?.records).toHaveLength(3);
    expect((await restarted.query({})).summary.tokens.input_other).toBe(4);
    f.setWire(main, [usageRecord(175)]);
    expect((await restarted.readAgentUsage('w', 's', ['main']))['main']?.records).toHaveLength(1);
    expect((await restarted.query({})).summary.tokens.input_other).toBe(2);
  });

  it('does not add explicitly unknown nonzero tokens to the known subtotal', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10), { ...usageRecord(11), usageKnown: false }] }, () => 100);
    const result = await f.service.query({});
    expect(result.summary.tokens).toEqual({ input_other: 1, output: 1, input_cache_read: 1, input_cache_creation: 1 });
    expect(result.summary.tokens_unknown).toBe(true);
    expect(result.reliability.usage_coverage).toMatchObject({ known_records: 1, missing_records: 1 });
    expect((await f.service.readAgentUsage('w', 's', ['main']))['main']?.records).toHaveLength(2);
  });

  it('bounds a stalled source preparation by the panel caller deadline without reading wire', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100);
    let aborted = false;
    vi.spyOn(f.facts, 'summary').mockImplementationOnce(async (_scope, signal, options) => {
      expect(options?.budget?.remainingRecords).toBe(200_000);
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true }));
    });
    const rows = await f.service.readAgentUsage('w', 's', ['main'], { summaryOnly: true, maxRecords: 1, deadlineAt: 130 });
    expect(aborted).toBe(true);
    expect(rows['main']).toEqual({ records: [], complete: false });
    expect(f.reads.size).toBe(0);
  });

  it('keeps partial source coverage visible and lets the next panel request finish', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10), usageRecord(11)] }, () => 100);
    const first = await f.service.readAgentUsage('w', 's', ['main'], { summaryOnly: true, maxFacts: 1 });
    expect(first['main']?.complete).toBe(false);
    const second = await f.service.readAgentUsage('w', 's', ['main'], { summaryOnly: true });
    expect(second['main']?.complete).toBe(true);
    expect(second['main']?.totals?.usage.output).toBe(2);
  });

  it('applies the History deadline while SQL is stalled without falling back to wire', async () => {
    const main = scope('w', 's');
    const f = fixture([summary('s', 'w')], { [main]: [usageRecord(10)] }, () => 100, { deadlineMs: 30 });
    await f.service.readAgentUsage('w', 's', ['main']);
    const bytes = new Map(f.readBytes);
    let aborted = false;
    const sql = vi.spyOn(f.model, 'query').mockImplementationOnce(async (_query, signal) => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true })));
    const response = await f.service.query({});
    expect(aborted).toBe(true);
    expect(response.reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
    expect(f.readBytes).toEqual(bytes);
    expect((await f.service.query({})).reliability.complete).toBe(true);
    sql.mockRestore();
  });

  it('keeps shared source preparation alive when only one query waiter cancels', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100);
    let entered!: () => void, release!: () => void;
    let sharedSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const summarize = f.facts.summary.bind(f.facts);
    vi.spyOn(f.facts, 'summary').mockImplementationOnce(async (source, signal, options) => { sharedSignal = signal; entered(); await gate; signal?.throwIfAborted(); return summarize(source, signal, options); });
    const controller = new AbortController();
    const first = f.service.query({}, controller.signal), second = f.service.query({});
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal?.aborted).toBe(false);
    release();
    expect((await second).reliability.complete).toBe(true);
  });

  it('continues importing canonical facts under a bounded allowance across restart without duplicate occurrences', async () => {
    const main = scope('w', 's');
    const records = Array.from({ length: 8 }, (_, index) => ({ ...usageRecord(10 + index, Math.floor(index / 2)), usageKnown: index !== 2 }));
    const f = fixture([summary('s', 'w')], { [main]: records }, () => 100, { usageFactBudget: 3 });
    let result = await f.service.query({});
    expect(result.reliability).toMatchObject({ complete: false, incomplete_reason: 'record_budget' });
    const resumed = f.restart();
    for (let attempt = 0; !result.reliability.complete && attempt < 5; attempt++) result = await resumed.query({});
    expect(result.reliability.complete).toBe(true);
    expect(result.summary.tokens.output).toBe(7);
    expect(result.reliability.usage_coverage).toEqual({ known_records: 7, missing_records: 1, legacy_zero_records: 0 });
    expect(result.trend[0]?.turn_count).toBe(4);
    f.setWire(main, [...records, { ...usageRecord(1, 99), usageKnown: true }]);
    let appended = await resumed.query({});
    for (let attempt = 0; !appended.reliability.complete && attempt < 5; attempt++) appended = await resumed.query({});
    expect(appended.reliability.complete).toBe(true);
    expect(appended.summary.tokens.output).toBe(8);
    f.setWire(main, [{ ...usageRecord(5, 3), usageKnown: true }]);
    const rewritten = await resumed.query({});
    expect(rewritten.reliability.complete).toBe(true);
    expect(rewritten.summary.tokens.output).toBe(1);
    expect(rewritten.trend[0]?.turn_count).toBe(1);
  });

  it('keeps bucket agent turns distinct from session drilldown turns across append and restart', async () => {
    const day = Date.UTC(2026, 9, 1), now = day + 2 * 86_400_000;
    const main = scope('w', 's1'), child = main.replace(/main$/, 'child'), other = scope('w', 's2');
    const saved = await openRange([summary('s1', 'w'), summary('s2', 'w')], {
      [main]: [{ ...usageRecord(day, 1), agentId: 'main' }, { ...usageRecord(day, 1), agentId: 'main' }, { ...usageRecord(day), agentId: 'main' }],
      [child]: [{ ...usageRecord(day, 1), agentId: 'child' }, { ...usageRecord(day, 2), agentId: 'child' }],
      [other]: [usageRecord(day, 4), usageRecord(day + 86_400_000, 5)],
    }, true);
    const input = { range: 'custom', start_at: 0, end_at: now } as const;
    const service = new UsageAggregationService(saved.core, () => now);
    const first = await service.query(input);
    expect(first.summary.tokens.output).toBe(7);
    expect(first.trend[0]?.turn_count).toBe(4);
    expect(first.trend[0]?.drilldown.sessions.find((item) => item.session_id === 's1')).toMatchObject({ turn_ids: [1, 2], turn_count: 2, unknown_turn_records: 1 });
    saved.logs.append(main, 'wire.jsonl', { ...usageRecord(day, 1), agentId: 'main' });
    saved.logs.append(main, 'wire.jsonl', { ...usageRecord(day, 2), agentId: 'main' });
    saved.logs.append(child, 'wire.jsonl', { ...usageRecord(day + 86_400_000, 3), agentId: 'child' });
    await saved.logs.flush();
    const appended = await service.query(input);
    expect(appended.summary.tokens.output).toBe(10);
    expect(appended.trend[0]?.turn_count).toBe(5);
    expect(appended.trend[0]?.drilldown.sessions.find((item) => item.session_id === 's1')).toMatchObject({ turn_ids: [1, 2], turn_count: 2, unknown_turn_records: 1 });
    expect(appended.trend[1]?.turn_count).toBe(2);
    const reopened = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(reopened.summary).toEqual(appended.summary);
    expect(reopened.trend).toEqual(appended.trend);
    service.dispose();
  });

  it('leaves legacy projections and generic collections unchanged while typed SQL serves History', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [usageRecord(1, 7)] }, true);
    await saved.store.put('usage-range-routing-v1', 'legacy', { keep: true });
    await saved.storage.write('cache/usage-aggregation-v1', 'range-projection-legacy.json', Buffer.from('{"keep":true}'));
    const writes = vi.spyOn(saved.storage, 'write'), put = vi.spyOn(saved.store, 'put'), batch = vi.spyOn(saved.store, 'batch');
    const result = await new UsageAggregationService(saved.core, () => 1000).query({});
    expect(result.reliability.complete).toBe(true);
    expect(result.summary.tokens.output).toBe(1);
    expect(writes.mock.calls.some(([target]) => target === 'cache/usage-aggregation-v1')).toBe(false);
    expect(put).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(await saved.store.get('usage-range-routing-v1', 'legacy')).toEqual({ keep: true });
    expect(Buffer.from((await saved.storage.read('cache/usage-aggregation-v1', 'range-projection-legacy.json'))!).toString()).toBe('{"keep":true}');
  });
});
describe('SQLite Usage history source lifecycle', () => {
  it('reopens a dead typed SQLite worker on a real History request', async () => {
    const wireScope = scope('workspace', 'session');
    const saved = await openRange([summary('session', 'workspace')], { [wireScope]: [usageRecord(1, 1), usageRecord(2, 2)] }, true);
    const model = saved.core.accessor.get(IUsageReadModel);
    await model.sources();
    const writer = Reflect.get(model, 'writer');
    await Reflect.get(writer, 'worker').terminate();
    const service = new UsageAggregationService(saved.core, () => 1000);
    const response = await service.query({ range: 'custom', start_at: 0, end_at: 1000 });
    expect(response.reliability.complete).toBe(true);
    expect(response.reliability.usage_coverage).toMatchObject({ known_records: 2, missing_records: 0 });
    expect(response.summary.tokens.output).toBe(2);
    expect(Reflect.get(model, 'writer')).not.toBe(writer);
    service.dispose();
  });

  it.each(['deadline', 'cancel', 'error'])('does not recover wire after unfinished startup metadata %s', async (mode) => {
    const first = scope('workspace', 'first'), later = scope('workspace', 'later');
    const saved = await openRange([summary('first', 'workspace'), summary('later', 'workspace')], { [first]: [usageRecord(10, 1)], [later]: [usageRecord(20, 2)] }, true);
    const service = new UsageAggregationService(saved.core, () => 1000, { deadlineMs: 30 });
    const controller = new AbortController();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const size = saved.storage.size.bind(saved.storage);
    const stalled = vi.spyOn(saved.storage, 'size').mockImplementation(async (target, key) => {
      if (target !== later || key !== 'wire.jsonl') return size(target, key);
      enter();
      if (mode === 'error') throw new Error('Metadata unavailable');
      await gate;
      return size(target, key);
    });
    const read = vi.spyOn(saved.storage, 'readStream');
    const input = { range: 'custom', start_at: 0, end_at: 1000 } as const;
    try {
      const pending = service.query(input, controller.signal);
      const rejected = mode === 'deadline' ? undefined : expect(pending).rejects.toThrow(mode === 'cancel' ? 'Cancel metadata' : 'Metadata unavailable');
      await entered;
      if (mode === 'cancel') controller.abort(new Error('Cancel metadata'));
      if (mode === 'deadline') expect((await pending).reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
      else await rejected;
      expect(read.mock.calls.some(([, key]) => key === 'wire.jsonl')).toBe(false);
    } finally {
      release(); stalled.mockRestore();
      await Reflect.get(service, 'modelPreparing')?.catch(() => undefined);
      service.dispose();
    }
    const continued = new UsageAggregationService(saved.core, () => 1000);
    const complete = await continued.query(input);
    expect(complete.reliability.complete).toBe(true);
    expect(complete.summary.tokens.output).toBe(2);
    continued.dispose();
  });

  it.each([false, true])('verifies all startup inventories and recovers only an unaligned source (stale: %s)', async (stale) => {
    const sessions = Array.from({ length: 40 }, (_, index) => summary(`session-${index}`, 'workspace'));
    const saved = await openRange(sessions, Object.fromEntries(sessions.flatMap((session) => ['main', 'child'].map((agentId) => [`sessions/workspace/${session.id}/agents/${agentId}`, [usageRecord(1, 7)]]))), true);
    await saved.storage.write(`sessions/workspace/${sessions[0]!.id}/agents`, 'empty', new Uint8Array());
    await saved.storage.write(`sessions/workspace/${sessions[0]!.id}/agents/empty`, 'wire.jsonl', new Uint8Array());
    const source = scope('workspace', sessions[0]!.id);
    if (stale) await saved.storage.append(source, 'wire.jsonl', Buffer.from(JSON.stringify(usageRecord(2, 8)) + '\n'));
    const service = new UsageAggregationService(saved.core, () => 1000);
    const lists = vi.spyOn(saved.storage, 'list');
    const reads = vi.spyOn(saved.storage, 'readStream');
    const input = { range: 'custom', start_at: 0, end_at: 1000 } as const;
    const response = await service.query(input);
    expect(response.reliability.complete).toBe(true);
    expect(response.reliability.usage_coverage).toMatchObject({ known_records: stale ? 81 : 80, missing_records: 0 });
    expect(response.summary.tokens.output).toBe(stale ? 81 : 80);
    const wireReads = reads.mock.calls.filter(([, key]) => key === 'wire.jsonl');
    expect(wireReads.every(([target]) => target === source)).toBe(true);
    expect(wireReads.length > 0).toBe(stale);
    expect(lists.mock.calls.filter(([target]) => sessions.some((session) => target === `sessions/workspace/${session.id}/agents`))).toHaveLength(40);
    const reopened = await new UsageAggregationService(saved.core, () => 1000).query(input);
    expect(reopened.summary).toEqual(response.summary);
    expect(reopened.trend).toEqual(response.trend);
    service.dispose();
  });

  it('keeps committed sources when a later source is cancelled and resumes exact cross-source totals', async () => {
    const sessions = [summary('first', 'workspace'), summary('later', 'workspace')];
    const first = scope('workspace', 'first'), later = scope('workspace', 'later');
    const f = fixture(sessions, { [first]: [usageRecord(1, 1)], [later]: [usageRecord(2, 2)] }, () => 1000);
    const facts = f.facts.commit.bind(f.facts);
    const controller = new AbortController();
    const commit = vi.spyOn(f.facts, 'commit').mockImplementation(async (...args) => {
      await facts(...args);
      if (args[0] === first) controller.abort(new Error('Stop after committed source'));
    });
    await expect(f.service.query({}, controller.signal)).rejects.toThrow('Stop after committed source');
    await Reflect.get(f.service, 'modelPreparing')?.catch(() => undefined);
    commit.mockRestore();
    expect((await f.model.summary(first)).totals?.knownUsageRecords).toBe(1);
    const bytes = f.readBytes.get(first);
    const resumed = f.restart();
    const result = await resumed.query({});
    expect(result.reliability.complete).toBe(true);
    expect(result.summary.tokens.output).toBe(2);
    expect(result.reliability.usage_coverage?.known_records).toBe(2);
    expect(f.readBytes.get(first)).toBe(bytes);
    resumed.dispose();
  });
});

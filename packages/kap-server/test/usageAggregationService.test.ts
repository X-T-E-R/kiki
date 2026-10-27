import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { MiniDbQueryStore, drainQueryStoreDisposals } from '@kiki/agent-core-v2/persistence/backends/minidb/miniDbQueryStore';
import { SqliteQueryStore } from '@kiki/agent-core-v2/persistence/backends/sqlite/sqliteQueryStore';
import { InMemoryStorageService } from '@kiki/agent-core-v2/persistence/backends/memory/inMemoryStorageService';
import { UsageFactStore } from '@kiki/agent-core-v2/app/usageFacts/usageFactStore';
import { stubBootstrap } from '../../agent-core-v2/test/app/bootstrap/stubs';
import { stubLog } from '../../agent-core-v2/test/_base/log/stubs';

import {
  AppendLogStore,
  IAppendLogStore,
  IUsageFactStore,
  IQueryStore,
  IBootstrapService,
  summarizeUsageFacts,
  type UsageFactSnapshot,
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
import { parseUsageRangeProjection } from '../src/usage/usageRangeProjection';
import { UsageRangeFold, type RangeFoldHead } from '../src/usage/usageRangeFold';
import { UsageSourceTracker, type UsageSourceChanges } from '../src/usage/usageSourceTracker';

const queryFixtures: { home: string; ix: TestInstantiationService; store: IQueryStore }[] = [];
afterEach(async () => {
  for (const { home, ix, store } of queryFixtures.splice(0)) {
    await store.close();
    await ix.dispose();
    await drainQueryStoreDisposals();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

interface Fixture {
  readonly service: UsageAggregationService;
  readonly facts: IUsageFactStore;
  readonly reads: Map<string, number>;
  readonly readBytes: Map<string, number>;
  readonly readOffsets: number[];
  readonly checkpointReads: Map<string, number>;
  readonly retainedQueries: readonly RetainedUsageListQuery[];
  setWire(scope: string, records: readonly WireRecord[]): void;
  setMtime(scope: string, mtimeMs: number): void;
  restart(): UsageAggregationService;
  setAgentIds(ids: string[]): void;
  setPrice(price: number | undefined): void;
  onPrice(observer: () => void): void;
  persistedRecordCounts(): number[];
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
  queryFixtures.push({ home, ix, store: queryStore });
  const reads = new Map<string, number>();
  const readBytes = new Map<string, number>();
  const readOffsets: number[] = [];
  const checkpointReads = new Map<string, number>();
  const retainedQueries: RetainedUsageListQuery[] = [];
  const wires = new Map<string, Buffer>();
  const wireMtimes = new Map<string, number>();
  const persisted = new Map<string, Uint8Array>();
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
  const storage = {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    list: async () => { await beforeMetadataRead(); return agentIds; },
    size: async (wireScope: string) => { await beforeMetadataRead(); return wires.get(wireScope)?.length; },
    mtime: async (wireScope: string) => { await beforeMetadataRead(); return wireMtimes.get(wireScope); },
    read: async (storageScope: string, key: string) => {
      const value = persisted.get(`${storageScope}/${key}`);
      if (value !== undefined) {
        if (storageScope === 'cache/usage-aggregation-v1') checkpointReads.set(key, (checkpointReads.get(key) ?? 0) + value.byteLength);
        onCheckpointRead(value.byteLength);
      }
      return value;
    },
    write: async (storageScope: string, key: string, data: Uint8Array) => {
      persisted.set(`${storageScope}/${key}`, Uint8Array.from(data));
    },
    readStream: (wireScope: string, _key: string, range?: { start: number; end: number }) => {
      reads.set(wireScope, (reads.get(wireScope) ?? 0) + 1);
      readOffsets.push(range?.start ?? 0);
      return (async function* () {
        await beforeWireRead();
        const bytes = wires.get(wireScope) ?? Buffer.alloc(0);
        const start = range?.start ?? 0;
        const end = Math.min(range?.end ?? bytes.length - 1, bytes.length - 1);
        const slice = end < start ? Buffer.alloc(0) : bytes.subarray(start, end + 1);
        readBytes.set(wireScope, (readBytes.get(wireScope) ?? 0) + slice.length);
        if (slice.length > 0) yield slice;
      })();
    },
  } as unknown as IFileSystemStorageService;
  const retainedUsage: IRetainedUsageService = {
    _serviceBrand: undefined,
    retainDeletedSession: async () => { throw new Error('retain is not used'); },
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
    resolve: () => undefined,
    calculate: (_model, usage) => { priceObserver(); return price === undefined ? undefined : price * ((usage.inputOther ?? 0) + (usage.output ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0)) / 4; },
    refreshNow: async () => false,
    status: () => ({ source: 'empty', keys: 0 }),
  };
  const facts: IUsageFactStore = {
    _serviceBrand: undefined,
    async read(scope, range, signal, options) {
      signal?.throwIfAborted();
      const bytes = await storage.read('facts', scope);
      if (bytes === undefined) return { records: [] };
      const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as UsageFactSnapshot;
      const cursor = options?.cursor === undefined ? { offset: 0, count: snapshot.records.length, checkpoint: snapshot.checkpoint } : JSON.parse(options.cursor) as { offset: number; count: number; checkpoint: UsageFactSnapshot['checkpoint'] };
      const selected = snapshot.records.slice(0, cursor.count).filter((record) => record.invalid || ((range?.startAt === undefined || record.time >= range.startAt) && (range?.endAt === undefined || record.time < range.endAt)));
      const records = selected.slice(cursor.offset, cursor.offset + (options?.pageSize ?? Infinity));
      cursor.offset += records.length;
      const complete = cursor.offset >= selected.length;
      return { checkpoint: cursor.checkpoint, records, readComplete: complete, nextCursor: complete ? undefined : JSON.stringify(cursor) };
    },
    async summary(scope, signal) {
      const snapshot = await facts.read(scope, undefined, signal);
      return { checkpoint: snapshot.checkpoint, totals: summarizeUsageFacts(snapshot.records) };
    },
    async commit(scope, start, checkpoint, records) {
      const bytes = persisted.get(`facts/${scope}`);
      const previous = bytes === undefined ? undefined : JSON.parse(Buffer.from(bytes).toString('utf8')) as UsageFactSnapshot;
      const priorRecords = start === 0 ? [] : previous?.records ?? [];
      await storage.write('facts', scope, Buffer.from(JSON.stringify({ checkpoint, records: [...priorRecords, ...records] })));
    },
  };
  const core = {
    accessor: {
      get: (identifier: unknown) => {
        if (identifier === ISessionIndex) return index;
        if (identifier === IFileSystemStorageService) return storage;
        if (identifier === IRetainedUsageService) return retainedUsage;
        if (identifier === IModelPricingService) return pricing;
        if (identifier === IUsageFactStore) return facts;
        if (identifier === IQueryStore) return queryStore;
        if (identifier === IAppendLogStore) return { generation: async () => 'legacy' };
        throw new Error('unexpected service');
      },
    },
  } as unknown as Scope;
  return {
    service: new UsageAggregationService(core, now, limits, sourceChanges),
    facts,
    reads,
    readBytes,
    readOffsets,
    checkpointReads,
    retainedQueries,
    setWire,
    setMtime: (wireScope: string, mtimeMs: number) => { wireMtimes.set(wireScope, mtimeMs); },
    restart: () => new UsageAggregationService(core, now, limits, sourceChanges),
    setAgentIds: (ids) => { agentIds = ids; },
    setPrice: (value) => { price = value; },
    onPrice: (observer) => { priceObserver = observer; },
    persistedRecordCounts: () => [...persisted.values()].flatMap((bytes) => {
      const document = JSON.parse(Buffer.from(bytes).toString('utf8')) as { records?: unknown[] };
      return document.records === undefined ? [] : [document.records.length];
    }),
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
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
  const store = ix.get(IQueryStore);
  queryFixtures.push({ home, ix, store });
  const logs = ix.get(IAppendLogStore);
  for (const [wireScope, wireRecords] of Object.entries(wires)) {
    await storage.write(wireScope.slice(0, wireScope.lastIndexOf('/')), wireScope.slice(wireScope.lastIndexOf('/') + 1), new Uint8Array());
    for (const record of wireRecords) logs.append(wireScope, 'wire.jsonl', record);
    if (wireRecords.length > 0) await logs.flush(wireScope, 'wire.jsonl');
  }
  const pricing = {
    ready: Promise.resolve(),
    calculate: (_model: string, usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }) => (usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation) / 4,
  };
  const core = { accessor: { get: (id: unknown) => {
    if (id === ISessionIndex) return { listRecent: async () => ({ items: [...sessions] }) };
    if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
    if (id === IModelPricingService) return pricing;
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

  it('binds pagination to normalized profile filters without changing old unfiltered cursor fingerprints', async () => {
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
    await expect(query(f.service, { ...input, profile: 'explore', page_token: pageToken })).rejects.toThrow('does not match the query conditions');
    await expect(query(f.service, { page_size: 1, page_token: pageToken })).rejects.toThrow('does not match the query conditions');
    const legacy = await query(f.service, { page_size: 1 });
    expect(JSON.parse(Buffer.from(legacy.sessions.next_page_token ?? '', 'base64url').toString('utf8'))).toEqual({
      v: 1, f: 'jx3eMhelCpunxj2P', k: [2, 'b'],
    });
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
    const counts = f.persistedRecordCounts();
    const bytes = f.readBytes.get(wire) ?? 0;
    const restarted = f.restart();
    const replayed = await query(restarted, input);
    expect(replayed).toEqual(cold);
    expect(f.readBytes.get(wire) ?? 0).toBe(bytes);
    expect(f.persistedRecordCounts()).toEqual(counts);
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
    expect(responses[1]).toEqual(responses[0]);
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
    expect((await query(f.service, input)).summary.tokens.output).toBe(3);
    expect(metadataReads - baseline).toBe(10);
    const afterAppend = metadataReads;
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
    await query(f.service);
    signalDuringRead = false;
    const first = probes;
    await query(f.service);
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
    expect(f.service.cacheStatus()).toEqual({ entries: 6, records: 5 });
    expect([...f.checkpointReads.values()].reduce((sum, value) => sum + value, 0)).toBe(checkpoints);
    expect([...f.reads.values()].reduce((sum, value) => sum + value, 0)).toBe(wireReads);
    expect(metadataReads - metadata).toBe(9);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(1);
    expect((await query(f.service, { ...input, provider: 'a', profile: 'general' })).summary.tokens.output).toBe(3);
    f.setPrice(2);
    expect((await query(f.service, input)).summary.cost_usd_estimated).toBe(10);
    f.setPrice(undefined);
    expect((await query(f.service, input)).reliability.unknown_price_models).toEqual(['priced-model']);
    expect(f.persistedRecordCounts()).toEqual([6, 0, 0]);
  });

  it('does not persist a range view when appending, rewriting or changing the agent inventory', async () => {
    const day = Date.UTC(2026, 9, 6);
    const old = usageRecord(day - 10 * 86_400_000);
    const current = usageRecord(day);
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [old, current] }, () => day);
    await query(f.service, { range: 'today' });
    f.setWire(scope('w', 's'), [old, current, usageRecord(day + 1)]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(2);
    expect(f.persistedRecordCounts()).toEqual([3]);
    expect((await query(f.restart())).summary.tokens.output).toBe(3);
    const rewritten = { ...usageRecord(day + 2), usage: { inputOther: 2, output: 2, inputCacheRead: 2, inputCacheCreation: 2 } };
    f.setWire(scope('w', 's'), [old, current, rewritten]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(3);
    f.setAgentIds(['main', 'child']);
    f.setWire('sessions/w/s/agents/child', [usageRecord(day + 3)]);
    expect((await query(f.service, { range: 'today' })).summary.tokens.output).toBe(4);
    expect(f.persistedRecordCounts()).toEqual([3, 1]);
    const exported: number[] = [];
    expect((await f.service.readExportSources(async (source) => { exported.push(source.records.length); })).complete).toBe(true);
    expect(exported).toEqual([4]);
    f.service.startFullRescan();
    expect((await finishRescan(f.service)).state).toBe('completed');
    expect(f.persistedRecordCounts()).toEqual([3, 1]);
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
    expect(f.persistedRecordCounts()).toEqual([3]);
    expect(f.service.cacheStatus().entries).toBeLessThanOrEqual(2);
  });

  it('preserves invalid historical records in otherwise empty warm range views', async () => {
    const day = Date.UTC(2026, 9, 6);
    const invalid = { ...usageRecord(day - 9 * 86_400_000), usage: { inputOther: -1, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [invalid] }, () => day);
    const cold = await query(f.service, { range: 'today' });
    expect(cold.reliability).toMatchObject({ complete: false, incomplete_sessions: 1 });
    expect(await query(f.service, { range: 'today' })).toEqual(cold);
    expect(f.persistedRecordCounts()).toEqual([1]);
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
    expect(service.cacheStatus()).toEqual({ entries: 2, records: 4 });

    const all = await query(service);
    expect(all.summary.session_count).toBe(2);
    expect(all.reliability).toMatchObject({
      complete: true,
      scanned_sessions: 2,
      incomplete_reason: null,
    });
    expect([...reads.values()].reduce((total, count) => total + count, 0)).toBe(4);
  });

  it('continues a budget-limited scan from its persisted offset', async () => {
    const session = summary('session-a', 'workspace-a');
    const wireScope = scope('workspace-a', 'session-a');
    const { service, reads, readOffsets } = fixture(
      [session],
      { [wireScope]: [usageRecord(10, 1), usageRecord(11, 2)] },
      () => 0,
      { wireRecordBudget: 1, deadlineMs: 10_000 },
    );

    const first = await query(service);
    readOffsets.length = 0;
    const second = await query(service);
    expect(readOffsets[0]).toBe(Buffer.byteLength(`${JSON.stringify(usageRecord(10, 1))}\n`));

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
    expect(service.cacheStatus()).toEqual({ entries: 1, records: 2 });
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
    const committed = vi.spyOn(f.facts, 'commit').mockImplementationOnce(async (...args) => {
      await commit(...args);
      controller.abort(new DOMException('left page', 'AbortError'));
    });
    try { await expect(f.service.query({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' }); }
    finally { committed.mockRestore(); }
    f.readOffsets.length = 0;
    const final = await query(f.restart());
    expect(final.reliability.complete).toBe(true);
    expect(final.summary.tokens.output).toBe(1);
    expect(f.readOffsets[0]).toBeGreaterThanOrEqual(16 * 1024 * 1024);
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
    expect(f.persistedRecordCounts()).toEqual([type === 'usage.record' ? 2 : 1]);
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
    expect(f.persistedRecordCounts()).toEqual([]);
    const final = await query(f.restart());
    expect(final.reliability.complete).toBe(true);
    expect(final.summary.tokens.output).toBe(2);
  });

  it.each([128, 1024])('does not skip usage when the deadline aborts the %i-record yield', async (boundary) => {
    const session = summary('session-a', 'workspace-a');
    const wireScope = scope('workspace-a', 'session-a');
    const records = Array.from({ length: boundary + 3 }, (_, index) => usageRecord(10 + index, index + 1));
    const f = fixture([session], { [wireScope]: records }, () => 0, { deadlineMs: 50 });
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
    f.readOffsets.length = 0;
    const resumed = await query(f.restart());
    expect(f.readOffsets[0]).toBe(consumedOffset);
    expect(resumed.reliability.complete).toBe(true);
    expect(resumed.summary).toEqual(baseline.summary);
    expect(resumed.reliability.usage_coverage).toEqual(baseline.reliability.usage_coverage);
    expect(f.persistedRecordCounts()).toEqual([records.length]);
    expect(first.reliability.usage_coverage?.known_records).toBe(boundary);
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
      expect(f.persistedRecordCounts()).toEqual([]);
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
    f.onPrice(() => { time = 100; });
    const result = await query(f.service);
    expect(result.summary.session_count).toBe(1);
    expect(result.summary.tokens.output).toBe(1);
    expect(result.reliability).toMatchObject({
      complete: false,
      incomplete_reason: 'deadline',
    });
  });

  it('actively releases expired cache entries at the start of a request', async () => {
    let time = 0;
    const sessionA = summary('session-a', 'workspace-a');
    const sessionB = summary('session-b', 'workspace-b');
    const { service } = fixture(
      [sessionA, sessionB],
      {
        [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)],
        [scope('workspace-b', 'session-b')]: [usageRecord(11, 2)],
      },
      () => time,
      { cacheTtlMs: 100, cacheMaxEntries: 2, deadlineMs: 10_000 },
    );

    await query(service, { 'workspace.id': 'workspace-a' });
    await query(service, { 'workspace.id': 'workspace-b' });
    expect(service.cacheStatus()).toEqual({ entries: 2, records: 2 });

    time = 101;
    await query(service, { 'workspace.id': 'workspace-a' });
    expect(service.cacheStatus()).toEqual({ entries: 1, records: 1 });
  });

  it('enforces cache entry and record capacities', async () => {
    const sessionA = summary('session-a', 'workspace-a');
    const sessionB = summary('session-b', 'workspace-b');
    const { service } = fixture(
      [sessionA, sessionB],
      {
        [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)],
        [scope('workspace-b', 'session-b')]: [usageRecord(11, 2)],
      },
      () => 0,
      { cacheMaxEntries: 1, cacheMaxRecords: 1, deadlineMs: 10_000 },
    );

    await query(service, { 'workspace.id': 'workspace-a' });
    await query(service, { 'workspace.id': 'workspace-b' });
    expect(service.cacheStatus()).toEqual({ entries: 1, records: 1 });
  });

  it('enforces a byte cap and skips caching oversized entries', async () => {
    const { service } = fixture(
      [summary('session-a', 'workspace-a')],
      { [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)] },
      () => 0,
      { cacheMaxBytes: 200, deadlineMs: 10_000 },
    );
    expect((await query(service)).summary.tokens.output).toBe(1);
    expect(service.cacheStatus()).toEqual({ entries: 0, records: 0 });
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
    expect(coldFirst.reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
    expect(coldFirst.reliability.usage_coverage?.known_records).toBeGreaterThan(0);
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
    expect(retainedQueries).toHaveLength(1);
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
    expect(retainedQueries).toEqual([
      expect.objectContaining({ workspaceIds: ['workspace-a'] }),
    ]);
  });
});

async function finishRescan(service: UsageAggregationService) {
  for (let attempt = 0; attempt < 2000 && service.rescanStatus().state === 'running'; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(service.rescanStatus().state).not.toBe('running');
  return service.rescanStatus();
}

describe('UsageAggregationService full rescan', () => {
  it('bypasses session, record and deadline budgets and persists the completed inventory across restart', async () => {
    const sessions = Array.from({ length: 505 }, (_, index) => summary(`s_${index}`, 'ws'));
    const records = Object.fromEntries(sessions.map((item) => [scope('ws', item.id), [usageRecord(1), usageRecord(2)]]));
    let clock = 0;
    const f = fixture(sessions, records, () => clock, { sessionScanLimit: 1, wireRecordBudget: 1, deadlineMs: 1 });
    expect((await query(f.service)).reliability.incomplete_reason).toBe('record_budget');
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
    expect(response.reliability).toMatchObject({ complete: true, incomplete_reason: null });
    expect(response.summary.tokens.input_other).toBe(1010);
    const reads = [...f.reads.values()].reduce((sum, count) => sum + count, 0);
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.service.rescanStatus()).toMatchObject({ state: 'running', total_sessions: 1, scanned_sessions: 0 });
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.service.rescanStatus()).toMatchObject({ state: 'running', scanned_sessions: 0, scanned_records: 256, total_sessions: 1 });
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
    let signal: (filename: string | null) => void = () => {};
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
    expect(changes).toHaveLength(count);
    signal('w/s/agents/main/wire.jsonl');
    expect(changes.at(-1)).toBe('w\0s');
    signal('w\\s\\agents\\child');
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


describe('shared agent and history usage projection', () => {
  it('freezes journal replay at the source checkpoint when an append commits before replay', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [] }, true);
    saved.core.accessor.get(IUsageFactStore);
    saved.logs.append(main, 'wire.jsonl', usageRecord(10, 1));
    await saved.logs.flush(main, 'wire.jsonl');
    const service = new UsageAggregationService(saved.core, () => 100);
    const replay = Reflect.get(service, 'replayFactJournal');
    let injected = false;
    Reflect.set(service, 'replayFactJournal', async (...args: unknown[]) => {
      if (!injected) {
        injected = true;
        saved.logs.append(main, 'wire.jsonl', usageRecord(1, 2));
        await saved.logs.flush(main, 'wire.jsonl');
      }
      return replay.apply(service, args);
    });
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
    service.dispose();
  });

  it.each([false, true])('keeps the frozen prefix across 256-fact pages and a backdated append (reject page: %s)', async (reject) => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [] }, true);
    saved.core.accessor.get(IUsageFactStore);
    for (let index = 0; index < 600; index++) saved.logs.append(main, 'wire.jsonl', {
      ...usageRecord(10 + index, index), usageKnown: index === 2 ? false : index === 3 ? undefined : true,
      usage: index === 3 || index === 4 ? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } : { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 },
    });
    await saved.logs.flush(main, 'wire.jsonl');
    const service = new UsageAggregationService(saved.core, () => 1000);
    const add = UsageRangeFold.prototype.addPage;
    let pages = 0;
    const gate = vi.spyOn(UsageRangeFold.prototype, 'addPage').mockImplementation(async function (this: UsageRangeFold, ...args) {
      pages++;
      if (pages === (reject ? 2 : 1)) {
        if (!reject) await add.apply(this, args);
        saved.logs.append(main, 'wire.jsonl', usageRecord(1, 9999));
        await saved.logs.flush(main, 'wire.jsonl');
        vi.advanceTimersByTime(10_001);
        if (reject) throw new DOMException('Pause journal page', 'TimeoutError');
        return;
      }
      return add.apply(this, args);
    });
    const input = { range: 'custom', start_at: 0, end_at: 1000 } as const;
    let first: UsageResponse;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try { first = await service.query(input); }
    finally { vi.useRealTimers(); gate.mockRestore(); service.dispose(); }
    expect(first!.reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
    expect(first!.reliability.usage_coverage).toEqual({ known_records: 254, missing_records: 1, legacy_zero_records: 1 });
    const continued = new UsageAggregationService(saved.core, () => 1000);
    const frozen = await continued.query(input);
    expect(frozen.reliability.complete).toBe(true);
    expect(frozen.summary.tokens.output).toBe(597);
    expect(frozen.reliability.usage_coverage).toEqual({ known_records: 598, missing_records: 1, legacy_zero_records: 1 });
    const refreshed = await continued.query(input);
    const restarted = await new UsageAggregationService(saved.core, () => 1000).query(input);
    for (const response of [refreshed, restarted]) {
      expect(response.reliability.complete).toBe(true);
      expect(response.summary.tokens.output).toBe(598);
      expect(response.summary.cost_usd_estimated).toBe(598);
      expect(response.reliability.usage_coverage).toEqual({ known_records: 599, missing_records: 1, legacy_zero_records: 1 });
      expect(response.trend[0]?.turn_count).toBe(601);
    }
    continued.dispose();
  });

  it('rebuilds saved pre-watermark-fix folds and projections from unchanged facts', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [] }, true);
    saved.core.accessor.get(IUsageFactStore);
    saved.logs.append(main, 'wire.jsonl', usageRecord(10, 1));
    saved.logs.append(main, 'wire.jsonl', usageRecord(11, 2));
    await saved.logs.flush(main, 'wire.jsonl');
    const input = { range: 'custom', start_at: 0, end_at: 100 } as const;
    const built = await new UsageAggregationService(saved.core, () => 100).query(input);
    expect(built.summary.tokens.output).toBe(2);
    const key = (await saved.storage.list('cache/usage-aggregation-v1')).find((name) => name.startsWith('range-projection-'))!;
    const projection = JSON.parse(Buffer.from((await saved.storage.read('cache/usage-aggregation-v1', key))!).toString('utf8'));
    const collection = `usage-range-v1:${projection.fingerprint}`;
    const fold = new UsageRangeFold(saved.store, collection, 100, 100), head = (await fold.head<RangeFoldHead>())!;
    const duplicate = { time: 10, model: 'priced-model', sourceAgentId: 'main', turnId: 1, usage: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 } };
    await fold.addPage(summary('s', 'w'), [duplicate], () => '0', () => true, head);
    await fold.saveHead({ ...head, journalReplayVersion: 2 });
    await saved.store.put(collection, 'old-corrupt-fold', true);
    projection.journalReplayVersion = 2;
    const row = projection.agents[0].rows[0];
    for (const field of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation']) row.usage[field]++;
    row.folded.records++; row.folded.known++;
    await saved.storage.write('cache/usage-aggregation-v1', key, Buffer.from(JSON.stringify(projection)));
    const recovered = await new UsageAggregationService(saved.core, () => 100).query(input);
    expect(recovered.reliability.complete).toBe(true);
    expect(recovered.summary).toEqual(built.summary);
    expect(recovered.trend).toEqual(built.trend);
    expect(recovered.reliability.usage_coverage).toEqual(built.reliability.usage_coverage);
    expect(await saved.store.get(collection, 'old-corrupt-fold')).toBeUndefined();
    expect((await fold.head<RangeFoldHead>())?.journalReplayVersion).toBe(3);
    const restarted = await new UsageAggregationService(saved.core, () => 100).query(input);
    expect(restarted.summary).toEqual(built.summary);
    expect(restarted.reliability.complete).toBe(true);
  });

  it('excludes old source journals before checkpoint preparation in a bounded SQLite query', async () => {
    const main = scope('w', 's'), old = main.replace(/main$/, 'old'), start = Date.UTC(2026, 9, 1);
    const saved = await openRange([summary('s', 'w')], { [main]: [], [old]: [] }, true);
    saved.core.accessor.get(IUsageFactStore);
    saved.logs.append(main, 'wire.jsonl', usageRecord(start, 1));
    saved.logs.append(old, 'wire.jsonl', usageRecord(start - 1, 2));
    await saved.logs.flush();
    const mtime = saved.storage.mtime.bind(saved.storage);
    vi.spyOn(saved.storage, 'mtime').mockImplementation((source, key) => source === old && key === 'wire.jsonl' ? Promise.resolve(start - 1) : mtime(source, key));
    const read = vi.spyOn(saved.storage, 'readStream');
    const response = await new UsageAggregationService(saved.core, () => start + 1000).query({ range: 'custom', start_at: start, end_at: start + 1000 });
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(1);
    const directory = `cache/usage-facts-v1/${createHash('sha256').update(old).digest('hex')}`;
    expect(read.mock.calls.filter(([source, key]) => source === directory && key === 'facts.jsonl')).toHaveLength(0);
  });

  it('publishes excluded-only session metadata with the final head instead of one transaction per session', async () => {
    const start = Date.UTC(2026, 9, 1);
    const sessions = Array.from({ length: 12 }, (_, index) => summary(`session-${index}`, 'w'));
    const scopes = sessions.map((item) => scope('w', item.id));
    const saved = await openRange(sessions, Object.fromEntries(scopes.map((source) => [source, []])), true);
    saved.core.accessor.get(IUsageFactStore);
    for (const [index, source] of scopes.entries()) saved.logs.append(source, 'wire.jsonl', usageRecord(index === 0 ? start : start - 1, index + 1));
    await saved.logs.flush();
    const mtime = saved.storage.mtime.bind(saved.storage);
    const excluded = new Set(scopes.slice(1));
    vi.spyOn(saved.storage, 'mtime').mockImplementation((source, key) => excluded.has(source) && key === 'wire.jsonl' ? Promise.resolve(start - 1) : mtime(source, key));
    const publish = vi.spyOn(UsageRangeFold.prototype, 'saveHead');
    try {
      const input = { range: 'custom', start_at: start, end_at: start + 1000 } as const;
      const service = new UsageAggregationService(saved.core, () => start + 1000);
      const response = await service.query(input);
      expect(response.reliability.complete).toBe(true);
      expect(response.summary.tokens.output).toBe(1);
      expect(publish.mock.calls.filter((call) => call[1] !== undefined)).toHaveLength(1);
      const complete = publish.mock.calls.at(-1)![0] as RangeFoldHead;
      const persisted = await new UsageRangeFold(saved.store, `usage-range-v1:${complete.fingerprint}`, 100, 100).head<RangeFoldHead>();
      expect(persisted?.complete).toBe(true);
      expect(persisted?.sessions).toHaveLength(12);
      expect(persisted?.sessions.every((session) => session.prepared && session.sources?.every((source) => source.done))).toBe(true);
      const reopened = await new UsageAggregationService(saved.core, () => start + 1000).query(input);
      expect(reopened.reliability.complete).toBe(true);
      expect(reopened.summary).toEqual(response.summary);
      expect(reopened.trend).toEqual(response.trend);
    } finally { publish.mockRestore(); }
  });

  it('reads only the complete journal checkpoint tail and grows nonoverlapping windows for a large final batch', async () => {
    const main = scope('w', 's');
    const saved = await openRange([], { [main]: [] });
    const directory = `cache/usage-facts-v1/${createHash('sha256').update(main).digest('hex')}`;
    const checkpoint = { generation: 'example', offset: 600, size: 600, mtimeMs: 100, boundaryHash: '', valid: true };
    const line = (padding: number) => JSON.stringify({ version: 1, start: 0, checkpoint, records: [], padding: 'x'.repeat(padding) }) + '\n';
    const service = new UsageAggregationService(saved.core);
    const read = vi.spyOn(saved.storage, 'readStream');
    try {
      await saved.storage.write(directory, 'facts.jsonl', Buffer.from(line(50000) + line(0)));
      expect(await Reflect.apply(Reflect.get(service, 'factJournalCheckpoint'), service, [main])).toEqual(checkpoint);
      expect(read.mock.calls.map((call) => call[2]!.end - call[2]!.start + 1)).toEqual([4096]);
      read.mockClear();
      await saved.storage.write(directory, 'facts.jsonl', Buffer.from(line(50000) + line(9000)));
      expect(await Reflect.apply(Reflect.get(service, 'factJournalCheckpoint'), service, [main])).toEqual(checkpoint);
      expect(read.mock.calls.map((call) => call[2]!.end - call[2]!.start + 1)).toEqual([4096, 4096, 8192]);
    } finally { service.dispose(); read.mockRestore(); }
  });

  it('folds small committed journal batches in bounded pages across batch boundaries', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [] }, true);
    saved.core.accessor.get(IUsageFactStore);
    for (let index = 0; index < 300; index++) {
      saved.logs.append(main, 'wire.jsonl', usageRecord(index + 1, index + 1));
      await saved.logs.flush(main, 'wire.jsonl');
    }
    const pages = vi.spyOn(UsageRangeFold.prototype, 'addPage');
    try {
      const response = await new UsageAggregationService(saved.core).query({ range: 'custom', start_at: 0, end_at: 1000 });
      expect(response.reliability.complete).toBe(true);
      expect(response.summary.tokens.output).toBe(300);
      expect(response.reliability.usage_coverage?.known_records).toBe(300);
      expect(pages.mock.calls.map((call) => call[1].length)).toEqual([256, 44]);
    } finally { pages.mockRestore(); }
  });

  it('starts a bounded SQLite history from committed journals without preparing full source indexes', async () => {
    const main = scope('w', 's');
    const saved = await openRange([summary('s', 'w')], { [main]: [] }, true);
    const facts = saved.core.accessor.get(IUsageFactStore);
    saved.logs.append(main, 'wire.jsonl', usageRecord(10, 1));
    await saved.logs.flush(main, 'wire.jsonl');
    const read = vi.spyOn(facts, 'read');
    const summarize = vi.spyOn(facts, 'summary');
    const service = new UsageAggregationService(saved.core, () => 100);
    const response = await service.query({ range: 'custom', start_at: 0, end_at: 100 });
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(1);
    expect(response.reliability.usage_coverage?.known_records).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('replays and maintains a SQLite range projection after panel reads warm the shared session cache', async () => {
    const day = Date.UTC(2026, 9, 27);
    const sessions = [summary('s1', 'w'), summary('s2', 'w')];
    const main = scope('w', 's1');
    const saved = await openRange(sessions, {
      [main]: [usageRecord(day, 1)],
      [scope('w', 's2')]: [usageRecord(day, 2)],
    }, true);
    const input = { range: 'custom', start_at: day, end_at: day + 86_400_000 } as const;
    const built = await new UsageAggregationService(saved.core).query(input);
    expect(built.reliability.complete).toBe(true);
    const service = new UsageAggregationService(saved.core);
    await service.readAgentUsage('w', 's1', ['main']);
    expect(service.cacheStatus().entries).toBeGreaterThan(0);
    const facts = vi.spyOn(saved.core.accessor.get(IUsageFactStore), 'read');
    const reads = vi.spyOn(saved.storage, 'read');
    const replayed = await service.query(input);
    expect(replayed.reliability.complete).toBe(true);
    expect(replayed.summary).toEqual(built.summary);
    expect(reads.mock.calls.some(([target, key]) => target === 'cache/usage-aggregation-v1' && key.startsWith('range-projection-'))).toBe(true);
    expect(facts).not.toHaveBeenCalled();
    saved.logs.append(main, 'wire.jsonl', usageRecord(day + 1, 3));
    await saved.logs.flush(main, 'wire.jsonl');
    const appended = await service.query(input);
    expect(appended.reliability.complete).toBe(true);
    expect(appended.summary.tokens.output).toBe(3);
    expect(appended.reliability.usage_coverage?.known_records).toBe(3);
    expect(facts).not.toHaveBeenCalled();
    const restarted = await new UsageAggregationService(saved.core).query(input);
    expect(restarted.summary).toEqual(appended.summary);
    expect(restarted.trend).toEqual(appended.trend);
  });

  it('reuses one durable projection across agent reads, range views, appends, rewrites and restart', async () => {
    const main = scope('w', 's');
    const child = main.replace('/main', '/child');
    const f = fixture([summary('s', 'w')], {
      [main]: [usageRecord(1), usageRecord(100)],
      [child]: [usageRecord(100)],
    }, () => 200);
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
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [
      usageRecord(10), { ...usageRecord(11), usageKnown: false },
    ] }, () => 100);
    const result = await f.service.query({});
    expect(result.summary.tokens).toEqual({ input_other: 1, output: 1, input_cache_read: 1, input_cache_creation: 1 });
    expect(result.summary.tokens_unknown).toBe(true);
    expect(result.reliability.usage_coverage).toMatchObject({ known_records: 1, missing_records: 1 });
    expect((await f.service.readAgentUsage('w', 's', ['main']))['main']?.records).toHaveLength(2);
  });

  it('bounds a stalled panel summary preparation by the caller deadline without falling back to wire', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100);
    let aborted = false;
    vi.spyOn(f.facts, 'summary').mockImplementationOnce(async (_scope, signal, options) => {
      expect(options?.budget?.remainingRecords).toBe(200_000);
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true });
      });
    });
    const started = performance.now();
    const rows = await f.service.readAgentUsage('w', 's', ['main'], { summaryOnly: true, maxRecords: 1, deadlineAt: 130 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(rows['main']).toEqual({ records: [], complete: false });
    expect(f.reads.size).toBe(0);
    expect(f.service.cacheStatus().records).toBe(0);
  });

  it('keeps a partial panel summary uncached and leaves full settle without a new fact limit', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10), usageRecord(11)] }, () => 100);
    await f.service.readAgentUsage('w', 's', ['main']);
    const service = f.restart();
    const summarize = f.facts.summary.bind(f.facts);
    const spy = vi.spyOn(f.facts, 'summary').mockImplementationOnce(async (_scope, _signal, options) => {
      expect(options?.budget?.remainingRecords).toBe(3);
      options!.budget!.remainingRecords = 0;
      return { readComplete: false };
    });
    const partial = await service.readAgentUsage('w', 's', ['main'], { summaryOnly: true, maxRecords: 1, maxFacts: 3, deadlineAt: 1000 });
    expect(partial['main']).toEqual({ records: [], complete: false });
    expect(service.cacheStatus().records).toBe(0);
    spy.mockImplementationOnce(async (scope, signal, options) => {
      expect(options?.budget).toBeUndefined();
      return summarize(scope, signal);
    });
    const complete = await service.readAgentUsage('w', 's', ['main'], { summaryOnly: true });
    expect(complete['main']?.complete).toBe(true);
    expect(complete['main']?.totals?.usage.output).toBe(2);
  });

  it('applies the ordinary deadline while persistent facts are stalled before wire recovery', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100, { deadlineMs: 30 });
    let aborted = false;
    vi.spyOn(f.facts, 'read').mockImplementationOnce(async (_scope, _range, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true });
    }));
    const started = performance.now();
    const response = await f.service.query({});
    expect(performance.now() - started).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(response.reliability).toMatchObject({ complete: false, incomplete_reason: 'deadline' });
    expect(f.reads.size).toBe(0);
    expect((await f.service.query({})).reliability.complete).toBe(true);
  });

  it.each([false, true])('does not treat a complete source checkpoint as a complete fact range or cache it (late facts: %s)', async (late) => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10), usageRecord(11)] }, () => 100, { usageFactBudget: 3 });
    await f.service.readAgentUsage('w', 's', ['main']);
    const service = f.restart();
    const read = f.facts.read.bind(f.facts);
    const spy = vi.spyOn(f.facts, 'read');
    if (late) spy.mockResolvedValueOnce({ records: [] });
    spy.mockImplementationOnce(async (scope, range, signal, options) => {
      const snapshot = await read(scope, range, signal);
      expect(options?.budget?.remainingRecords).toBe(3);
      options!.budget!.remainingRecords = 0;
      return { ...snapshot, records: snapshot.records.slice(0, 1), readComplete: false, nextCursor: 'remaining' };
    });
    const partial = await service.query({});
    expect(partial.reliability).toMatchObject({ complete: false, incomplete_reason: 'record_budget' });
    expect(partial.summary.tokens.output).toBe(1);
    const continued = await service.query({});
    expect(continued.reliability.complete).toBe(true);
    expect(continued.summary.tokens.output).toBe(2);
  });

  it('keeps a shared fact preparation alive when only one query waiter cancels', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100);
    let entered!: () => void;
    let release!: () => void;
    let sharedSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.facts, 'read').mockImplementationOnce(async (_scope, _range, signal) => { sharedSignal = signal; entered(); await gate; signal?.throwIfAborted(); return { records: [] }; });
    const controller = new AbortController();
    const first = f.service.query({}, controller.signal);
    const second = f.service.query({});
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal?.aborted).toBe(false);
    release();
    expect((await second).reliability.complete).toBe(true);
  });

  it('retries a borrowed source flight when its owner times out without expiring the other query', async () => {
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(f.facts, 'read').mockResolvedValueOnce({ records: [] }).mockImplementationOnce(async (_scope, _range, signal) => {
      entered();
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const controller = new AbortController();
    const first = f.service.query({}, controller.signal);
    await started;
    const second = f.service.query({ dimension: 'agent' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new DOMException('Source deadline', 'TimeoutError'));
    await expect(first).rejects.toMatchObject({ name: 'TimeoutError' });
    expect((await second).reliability.complete).toBe(true);
  });

  it('coalesces the same host query and isolates a cancelled waiter', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture([summary('s', 'w')], { [scope('w', 's')]: [usageRecord(10)] }, () => 100,
      {}, undefined, undefined, undefined, async () => { entered(); await gate; });
    const abort = new AbortController();
    const left = f.service.query({}, abort.signal);
    const right = f.service.query({});
    await started;
    abort.abort();
    await expect(left).rejects.toMatchObject({ name: 'AbortError' });
    release();
    const response = await right;
    expect(response.summary.tokens.input_other).toBe(1);
    expect(response.reliability.complete).toBe(true);
    expect(f.reads.get(scope('w', 's'))).toBe(2);
  });

  it('continues a fact-limited ordinary query to exact totals across appends, restart and rewrite', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-range-real-'));
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    const facts = ix.get(IUsageFactStore);
    const logs = ix.get(IAppendLogStore);
    queryFixtures.push({ home, ix, store: ix.get(IQueryStore) });
    const wireScope = scope('example', 'session');
    await storage.write('sessions/example/session/agents', 'main', new Uint8Array());
    for (let index = 0; index < 8; index++) logs.append(wireScope, 'wire.jsonl', { ...usageRecord(10 + index, Math.floor(index / 2)), usageKnown: index !== 2, modelAlias: 'example', agentId: 'main' });
    await logs.flush(wireScope, 'wire.jsonl');
    await facts.summary(wireScope);
    const auxiliaryScope = wireScope.replace(/main$/, 'auxiliary');
    await storage.write('sessions/example/session/agents', 'auxiliary', new Uint8Array());
    for (let index = 0; index < 2; index++) logs.append(auxiliaryScope, 'wire.jsonl', { ...usageRecord(30 + index, 0), usageKnown: true, modelAlias: 'example', agentId: 'auxiliary' });
    await logs.flush(auxiliaryScope, 'wire.jsonl');
    await facts.summary(auxiliaryScope);
    const item = summary('session', 'example');
    const pricing = { ready: Promise.resolve(), calculate: (_model: string, usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }) => Object.values(usage).reduce((sum, value) => sum + value, 0) / 4 };
    const core = { accessor: { get: (id: unknown) => {
      if (id === ISessionIndex) return { listRecent: async () => ({ items: [item] }) };
      if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [retainedSession('deleted-session', 'example', [retainedRecord(15, { turnId: 1, usageKnown: true })])], scannedRecords: 1, complete: true }) };
      if (id === IModelPricingService) return pricing;
      return ix.get(id as typeof IQueryStore);
    } } } as unknown as Scope;
    const input = { range: 'custom', start_at: 0, end_at: 100, dimension: 'model' } as const;
    const oracle = await new UsageAggregationService(core, () => 100).query(input);
    expect(oracle.summary.tokens.input_other).toBe(10);
    expect(oracle.trend[0]?.turn_count).toBe(6);
    let service = new UsageAggregationService(core, () => 100, { usageFactBudget: 3 });
    const first = await service.query(input);
    expect(first.reliability.complete).toBe(false);
    expect(first.reliability.incomplete_reason).toBe('record_budget');
    const second = await service.query(input);
    expect(second.reliability.complete).toBe(false);
    logs.append(wireScope, 'wire.jsonl', { ...usageRecord(1, 99), usageKnown: true, modelAlias: 'example', agentId: 'main' });
    await logs.flush(wireScope, 'wire.jsonl');
    logs.append(auxiliaryScope, 'wire.jsonl', { ...usageRecord(2, 99), usageKnown: true, modelAlias: 'example', agentId: 'auxiliary' });
    await logs.flush(auxiliaryScope, 'wire.jsonl');
    service = new UsageAggregationService(core, () => 101, { usageFactBudget: 3 });
    let completed = second;
    for (let attempt = 0; attempt < 10 && !completed.reliability.complete; attempt++) completed = await service.query(input);
    expect(completed.reliability.complete).toBe(true);
    expect(completed.summary).toEqual(oracle.summary);
    expect(completed.trend).toEqual(oracle.trend);
    let refreshed = await service.query(input);
    for (let attempt = 0; attempt < 12 && !refreshed.reliability.complete; attempt++) refreshed = await service.query(input);
    expect(refreshed.reliability.complete).toBe(true);
    expect(refreshed.summary.tokens.input_other).toBe(oracle.summary.tokens.input_other + 2);
    await logs.rewrite(wireScope, 'wire.jsonl', [{ ...usageRecord(5, 3), usageKnown: true, modelAlias: 'example', agentId: 'main' }]);
    let rewritten = await service.query(input);
    for (let attempt = 0; attempt < 10 && !rewritten.reliability.complete; attempt++) rewritten = await service.query(input);
    expect(rewritten.reliability.complete).toBe(true);
    expect(rewritten.summary.tokens.input_other).toBe(5);
    expect(rewritten.trend[0]?.turn_count).toBe(4);
    const readPage = UsageRangeFold.prototype.recordPage;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(UsageRangeFold.prototype, 'recordPage').mockImplementation(async function (this: UsageRangeFold, cursor) {
      enter(); await gate; return readPage.call(this, cursor);
    });
    try {
      const abort = new AbortController();
      const cancelled = service.query(input, abort.signal);
      const survivor = service.query(input);
      await entered;
      abort.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      release();
      expect((await survivor).summary).toEqual(rewritten.summary);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockImplementation(() => new Promise(() => undefined));
      const bounded = new UsageAggregationService(core, () => 102, { usageFactBudget: 3, deadlineMs: 30 });
      const partial = await bounded.query(input);
      expect(partial.reliability.complete).toBe(false);
      expect(partial.reliability.incomplete_reason).toBe('deadline');
      spy.mockRestore();
      expect((await bounded.query(input)).summary).toEqual(rewritten.summary);
    } finally { release(); spy.mockRestore(); }
  });

  it('resumes a fact-limited fold at the unfinished agent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-range-fold-agent-'));
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    queryFixtures.push({ home, ix, store: ix.get(IQueryStore) });
    const logs = ix.get(IAppendLogStore);
    const facts = ix.get(IUsageFactStore);
    const child = scope('w', 's').replace(/main$/, 'child');
    const main = scope('w', 's');
    await storage.write('sessions/w/s/agents', 'child', new Uint8Array());
    await storage.write('sessions/w/s/agents', 'main', new Uint8Array());
    logs.append(child, 'wire.jsonl', { ...usageRecord(10, 1), model: 'child-model-with-extra-padding', agentId: 'child' });
    logs.append(main, 'wire.jsonl', { ...usageRecord(11, 2), agentId: 'main' });
    await logs.flush(child, 'wire.jsonl');
    await logs.flush(main, 'wire.jsonl');
    const item = summary('s', 'w');
    const pricing = { ready: Promise.resolve(), calculate: () => 1 };
    const core = { accessor: { get: (id: unknown) => {
      if (id === ISessionIndex) return { listRecent: async () => ({ items: [item] }) };
      if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
      if (id === IModelPricingService) return pricing;
      return ix.get(id as typeof IQueryStore);
    } } } as unknown as Scope;
    const input = { range: 'custom', start_at: 0, end_at: 100, dimension: 'model' } as const;
    const service = new UsageAggregationService(core, () => 100, { usageFactBudget: 1 });
    const first = await service.query(input);
    expect(first.reliability.complete).toBe(false);
    expect(first.reliability.incomplete_reason).toBe('record_budget');
    const original = facts.summary.bind(facts);
    let childSummaries = 0;
    let tail = Promise.resolve();
    const spy = vi.spyOn(facts, 'summary').mockImplementation((agentScope, signal, options) => {
      const run = tail.then(async () => {
        const snapshot = await original(agentScope, signal, options);
        if (agentScope.endsWith('/child')) {
          childSummaries += 1;
          if (options?.budget !== undefined) options.budget.remainingRecords = 0;
        }
        return snapshot;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    });
    try {
      let response = first;
      for (let attempt = 0; attempt < 8 && !response.reliability.complete; attempt += 1) response = await service.query(input);
      expect(response.reliability.complete).toBe(true);
      expect(response.summary.tokens.output).toBe(2);
      expect(childSummaries).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('replays a default-budget fold from the fact journal without rebuilding the index', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-range-journal-'));
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    queryFixtures.push({ home, ix, store: ix.get(IQueryStore) });
    const logs = ix.get(IAppendLogStore);
    const facts = ix.get(IUsageFactStore);
    const child = scope('w', 's').replace(/main$/, 'child');
    const main = scope('w', 's');
    await storage.write('sessions/w/s/agents', 'child', new Uint8Array());
    await storage.write('sessions/w/s/agents', 'main', new Uint8Array());
    logs.append(child, 'wire.jsonl', { ...usageRecord(10, 1), agentId: 'child' });
    logs.append(main, 'wire.jsonl', { ...usageRecord(11, 2), agentId: 'main' });
    await logs.flush(child, 'wire.jsonl');
    await logs.flush(main, 'wire.jsonl');
    const item = summary('s', 'w');
    const pricing = { ready: Promise.resolve(), calculate: () => 1 };
    const core = { accessor: { get: (id: unknown) => {
      if (id === ISessionIndex) return { listRecent: async () => ({ items: [item] }) };
      if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
      if (id === IModelPricingService) return pricing;
      return ix.get(id as typeof IQueryStore);
    } } } as unknown as Scope;
    const input = { range: 'custom', start_at: 0, end_at: 100, dimension: 'model' } as const;
    const seeded = new UsageAggregationService(core, () => 100, { usageFactBudget: 1 });
    const first = await seeded.query(input);
    expect(first.reliability.complete).toBe(false);
    const read = vi.spyOn(facts, 'read');
    const summarized = vi.spyOn(facts, 'summary');
    const folded = new UsageAggregationService(core, () => 100);
    let response = await folded.query(input);
    for (let attempt = 0; attempt < 4 && !response.reliability.complete; attempt += 1) response = await folded.query(input);
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(2);
    expect(response.reliability.usage_coverage).toMatchObject({ known_records: 2, missing_records: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(summarized).not.toHaveBeenCalled();
  });

  it('folds a long model name that does not fit in a query-store key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-range-long-key-'));
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    queryFixtures.push({ home, ix, store: ix.get(IQueryStore) });
    const logs = ix.get(IAppendLogStore);
    const wire = scope('w', 's');
    await storage.write('sessions/w/s/agents', 'main', new Uint8Array());
    const model = `priced-model-${'m'.repeat(180)}`;
    logs.append(wire, 'wire.jsonl', { ...usageRecord(10, 1), model, modelAlias: model, agentId: 'main', provider: 'provider-with-a-long-name', profileName: 'profile-with-a-long-name' });
    logs.append(wire, 'wire.jsonl', { ...usageRecord(11, 2), model, modelAlias: model, agentId: 'main', provider: 'provider-with-a-long-name', profileName: 'profile-with-a-long-name' });
    await logs.flush(wire, 'wire.jsonl');
    const item = summary('s', 'w');
    const pricing = { ready: Promise.resolve(), calculate: () => 1 };
    const core = { accessor: { get: (id: unknown) => {
      if (id === ISessionIndex) return { listRecent: async () => ({ items: [item] }) };
      if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
      if (id === IModelPricingService) return pricing;
      return ix.get(id as typeof IQueryStore);
    } } } as unknown as Scope;
    const input = { range: 'custom', start_at: 0, end_at: 100, dimension: 'model' } as const;
    const seeded = new UsageAggregationService(core, () => 100, { usageFactBudget: 1 });
    expect((await seeded.query(input)).reliability.complete).toBe(false);
    const folded = new UsageAggregationService(core, () => 100);
    let response = await folded.query(input);
    for (let attempt = 0; attempt < 4 && !response.reliability.complete; attempt += 1) response = await folded.query(input);
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(2);
    expect(response.trend[0]?.groups[0]?.key).toContain(model);
  });

  it('keeps a folded row with no wire agent id in the durable projection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-range-anonymous-agent-'));
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    const store = ix.get(IQueryStore);
    queryFixtures.push({ home, ix, store });
    const logs = ix.get(IAppendLogStore);
    const main = scope('w', 's');
    const child = main.replace(/main$/, 'child');
    await storage.write('sessions/w/s/agents', 'main', new Uint8Array());
    await storage.write('sessions/w/s/agents', 'child', new Uint8Array());
    logs.append(main, 'wire.jsonl', usageRecord(10, 1));
    logs.append(child, 'wire.jsonl', { ...usageRecord(11, 2), agentId: 'child' });
    await logs.flush(main, 'wire.jsonl');
    await logs.flush(child, 'wire.jsonl');
    const item = summary('s', 'w');
    const pricing = { ready: Promise.resolve(), calculate: () => 1 };
    const core = { accessor: { get: (id: unknown) => {
      if (id === ISessionIndex) return { listRecent: async () => ({ items: [item] }) };
      if (id === IRetainedUsageService) return { listDeletedSessions: async () => ({ items: [], scannedRecords: 0, complete: true }) };
      if (id === IModelPricingService) return pricing;
      return ix.get(id as typeof IQueryStore);
    } } } as unknown as Scope;
    const input = { range: 'custom', start_at: 0, end_at: 100, dimension: 'model' } as const;
    expect((await new UsageAggregationService(core, () => 100, { usageFactBudget: 1 }).query(input)).reliability.complete).toBe(false);
    const folded = new UsageAggregationService(core, () => 100);
    const response = await folded.query(input);
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(2);
    const get = vi.spyOn(store, 'get');
    const restarted = new UsageAggregationService(core, () => 100);
    const replayed = await restarted.query(input);
    expect(replayed.reliability.complete).toBe(true);
    expect(replayed.summary.tokens.output).toBe(2);
    expect(replayed.reliability.usage_coverage).toEqual(response.reliability.usage_coverage);
    expect(get).not.toHaveBeenCalled();
    logs.append(main, 'wire.jsonl', usageRecord(12, 3));
    await logs.flush(main, 'wire.jsonl');
    const appended = await restarted.query(input);
    expect(appended.reliability.complete).toBe(true);
    expect(appended.summary.tokens.output).toBe(3);
    expect(appended.reliability.usage_coverage?.known_records).toBe(3);
    expect(get).not.toHaveBeenCalled();
  });

  it('verifies excluded fold sources by mtime and rechecks boundary changes and rewrites', async () => {
    const start = Date.UTC(2026, 9, 1);
    const now = start + 86_400_000;
    const old = scope('w', 'old');
    const current = scope('w', 'current');
    const saved = await openRange([summary('old', 'w'), summary('current', 'w')], { [old]: [], [current]: [] });
    let oldMtime = start - 1;
    const mtime = saved.storage.mtime.bind(saved.storage);
    vi.spyOn(saved.storage, 'mtime').mockImplementation((source, key) => source === old && key === 'wire.jsonl' ? Promise.resolve(oldMtime) : mtime(source, key));
    saved.logs.append(old, 'wire.jsonl', usageRecord(start - 1, 1));
    saved.logs.append(current, 'wire.jsonl', usageRecord(start, 2));
    saved.logs.append(current, 'wire.jsonl', usageRecord(start + 1, 2));
    await saved.logs.flush();
    const input = { range: 'custom', start_at: start, end_at: now, dimension: 'model' } as const;
    expect((await new UsageAggregationService(saved.core, () => now, { usageFactBudget: 1 }).query(input)).reliability.complete).toBe(false);
    let built = await new UsageAggregationService(saved.core, () => now).query(input);
    for (let attempt = 0; attempt < 4 && !built.reliability.complete; attempt++) built = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(built.reliability.complete).toBe(true);
    expect(built.summary.tokens.output).toBe(2);
    const removeProjection = async () => {
      for (const key of await saved.storage.list('cache/usage-aggregation-v1')) if (key.startsWith('range-projection-')) await saved.storage.delete('cache/usage-aggregation-v1', key);
    };
    const generation = vi.spyOn(saved.logs, 'generation');
    const size = vi.spyOn(saved.storage, 'size');
    const [fingerprint] = await saved.store.listKeys('usage-range-routing-v1');
    const collection = `usage-range-v1:${fingerprint!}`;
    const originalHead = await saved.store.get(collection, 'head');
    await removeProjection();
    const put = vi.spyOn(saved.store, 'put');
    const stringify = vi.spyOn(JSON, 'stringify');
    const pages = vi.spyOn(UsageRangeFold.prototype, 'recordPage');
    const buckets = vi.spyOn(UsageRangeFold.prototype, 'buckets');
    let replayed: UsageResponse;
    try {
      replayed = await new UsageAggregationService(saved.core, () => now).query(input);
      const writes = put.mock.calls.filter(([target, key]) => target === collection && key === 'head').length;
      const encodes = stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object' && 'inventoryComplete' in value && 'invalidated' in value && 'sessions' in value).length;
      expect({ writes, encodes }).toEqual({ writes: 0, encodes: 0 });
      expect({ pages: pages.mock.calls.length, buckets: buckets.mock.calls.length }).toEqual({ pages: 1, buckets: 1 });
    } finally { put.mockRestore(); stringify.mockRestore(); pages.mockRestore(); buckets.mockRestore(); }
    expect(replayed!.summary).toEqual(built.summary);
    expect(replayed!.reliability.complete).toBe(true);
    expect(await saved.store.get(collection, 'head')).toEqual(originalHead);
    await removeProjection();
    await saved.store.recover?.();
    const restarted = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(restarted.summary).toEqual(built.summary);
    expect(restarted.reliability.complete).toBe(true);
    expect(generation.mock.calls.some(([source]) => source === old)).toBe(false);
    expect(size.mock.calls.some(([source]) => source === old)).toBe(false);
    expect(generation.mock.calls.some(([source]) => source === current)).toBe(true);
    generation.mockClear();
    oldMtime = start;
    await removeProjection();
    const boundary = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(boundary.reliability.complete).toBe(true);
    expect(boundary.summary).toEqual(built.summary);
    expect(await saved.store.get(collection, 'head')).not.toEqual(originalHead);
    expect(generation.mock.calls.some(([source]) => source === old)).toBe(true);
    oldMtime = start + 1;
    await saved.logs.rewrite(old, 'wire.jsonl', [usageRecord(start, 3)]);
    await removeProjection();
    const rewritten = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(rewritten.reliability.complete).toBe(true);
    expect(rewritten.summary.tokens.output).toBe(3);
    expect(rewritten.reliability.usage_coverage?.known_records).toBe(3);
    await removeProjection();
    await saved.store.recover?.();
    const rewrittenRestart = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(rewrittenRestart.summary).toEqual(rewritten.summary);
    expect(rewrittenRestart.reliability.complete).toBe(true);
  });

  it('keeps every bucket and drilldown when a stored projection appends across sessions, agents and turns', async () => {
    const day0 = Date.UTC(2026, 9, 1);
    const day1 = day0 + 86_400_000;
    const now = day1 + 86_400_000;
    const s1Main = scope('w', 's1');
    const s1Child = s1Main.replace(/main$/, 'child');
    const s2Main = scope('w', 's2');
    const sessions = [summary('s1', 'w'), summary('s2', 'w')];
    const initial: Record<string, readonly WireRecord[]> = {
      [s1Main]: [
        { ...usageRecord(day0, 1), agentId: 'main' },
        { ...usageRecord(day0, 1), agentId: 'main' },
        { ...usageRecord(day0), agentId: 'main' },
        { ...usageRecord(day1, 3), agentId: 'main' },
      ],
      [s1Child]: [
        { ...usageRecord(day0, 1), agentId: 'child' },
        { ...usageRecord(day0, 2), agentId: 'child' },
      ],
      [s2Main]: [
        usageRecord(day0, 4),
        { ...usageRecord(day1, 5), agentId: 'main' },
      ],
    };
    const extra: Record<string, readonly WireRecord[]> = {
      [s1Main]: [
        { ...usageRecord(day0, 1), agentId: 'main' },
        { ...usageRecord(day0, 2), agentId: 'main' },
        { ...usageRecord(day0), agentId: 'main' },
        { ...usageRecord(day1, 9), agentId: 'main' },
      ],
      [s1Child]: [
        { ...usageRecord(day0, 2), agentId: 'child' },
        { ...usageRecord(day1, 3), agentId: 'child' },
      ],
      [s2Main]: [{ ...usageRecord(day1, 8), agentId: 'main' }],
    };
    const input = { range: 'custom', start_at: 0, end_at: now, dimension: 'model' } as const;
    const sessionAt = (response: UsageResponse, startAt: number, sessionId: string) => response.trend.find((bucket) => bucket.start_at === startAt)?.drilldown.sessions.find((session) => session.session_id === sessionId);
    const beforeHome = await openRange(sessions, initial);
    const before = await new UsageAggregationService(beforeHome.core, () => now).query(input);
    expect(before.reliability.complete).toBe(true);
    expect(before.summary.tokens.output).toBe(8);
    expect(before.trend.find((bucket) => bucket.start_at === day0)?.turn_count).toBe(4);
    expect(sessionAt(before, day0, 's1')).toMatchObject({ turn_ids: [1, 2], turn_count: 2, unknown_turn_records: 1, turn_ids_truncated: false });
    expect(sessionAt(before, day0, 's2')).toMatchObject({ turn_ids: [4], turn_count: 1, unknown_turn_records: 0 });
    expect(before.trend.find((bucket) => bucket.start_at === day1)?.turn_count).toBe(2);
    expect(before.trend.every((bucket) => bucket.drilldown.sessions_truncated === false)).toBe(true);
    const afterHome = await openRange(sessions, withRecords(initial, extra));
    const after = await new UsageAggregationService(afterHome.core, () => now).query(input);
    expect(after.reliability.complete).toBe(true);
    expect(after.summary.tokens.output).toBe(15);
    expect(after.trend.find((bucket) => bucket.start_at === day0)?.turn_count).toBe(5);
    expect(sessionAt(after, day0, 's1')).toMatchObject({ turn_ids: [1, 2], turn_count: 2, unknown_turn_records: 2 });
    expect(after.trend.find((bucket) => bucket.start_at === day1)?.turn_count).toBe(5);
    expect(sessionAt(after, day1, 's1')).toMatchObject({ turn_ids: [3, 9], turn_count: 2, unknown_turn_records: 0 });
    expect(sessionAt(after, day1, 's2')).toMatchObject({ turn_ids: [5, 8], turn_count: 2, unknown_turn_records: 0 });
    const saved = await openRange(sessions, initial);
    expect((await new UsageAggregationService(saved.core, () => now, { usageFactBudget: 1 }).query(input)).reliability.complete).toBe(false);
    const folded = new UsageAggregationService(saved.core, () => now);
    let built = await folded.query(input);
    for (let attempt = 0; attempt < 4 && !built.reliability.complete; attempt += 1) built = await folded.query(input);
    expect(built.reliability.complete).toBe(true);
    const get = vi.spyOn(saved.store, 'get');
    const cold = new UsageAggregationService(saved.core, () => now);
    const replayed = await cold.query(input);
    expect(replayed.reliability.complete).toBe(true);
    expect(replayed.summary).toEqual(before.summary);
    expect(replayed.trend).toEqual(before.trend);
    expect(replayed.reliability.usage_coverage).toEqual(before.reliability.usage_coverage);
    expect(get).not.toHaveBeenCalled();
    for (const [wireScope, wireRecords] of Object.entries(extra)) {
      for (const record of wireRecords) saved.logs.append(wireScope, 'wire.jsonl', record);
      await saved.logs.flush(wireScope, 'wire.jsonl');
    }
    const appended = await cold.query(input);
    expect(appended.reliability.complete).toBe(true);
    expect(appended.summary).toEqual(after.summary);
    expect(appended.trend).toEqual(after.trend);
    expect(appended.reliability.usage_coverage).toEqual(after.reliability.usage_coverage);
    expect(get).not.toHaveBeenCalled();
  });

  it('recovers an old projection without per-agent turns instead of counting a repeated turn again', async () => {
    const day0 = Date.UTC(2026, 9, 1);
    const now = day0 + 86_400_000;
    const main = scope('w', 's');
    const child = main.replace(/main$/, 'child');
    const sessions = [summary('s', 'w')];
    const initial: Record<string, readonly WireRecord[]> = {
      [main]: [{ ...usageRecord(day0, 1), agentId: 'main' }, { ...usageRecord(day0, 1), agentId: 'main' }],
      [child]: [{ ...usageRecord(day0, 1), agentId: 'child' }],
    };
    const repeat = { ...usageRecord(day0, 1), agentId: 'main' };
    const input = { range: 'custom', start_at: 0, end_at: now, dimension: 'model' } as const;
    const reference = await new UsageAggregationService((await openRange(sessions, { ...initial, [main]: [...initial[main]!, repeat] })).core, () => now).query(input);
    expect(reference.reliability.complete).toBe(true);
    expect(reference.summary.tokens.output).toBe(4);
    expect(reference.trend[0]?.turn_count).toBe(2);
    expect(reference.trend[0]?.drilldown.sessions.find((session) => session.session_id === 's')).toMatchObject({ turn_ids: [1], turn_count: 1, unknown_turn_records: 0 });
    const saved = await openRange(sessions, initial);
    expect((await new UsageAggregationService(saved.core, () => now, { usageFactBudget: 1 }).query(input)).reliability.complete).toBe(false);
    let built = await new UsageAggregationService(saved.core, () => now).query(input);
    for (let attempt = 0; attempt < 4 && !built.reliability.complete; attempt += 1) built = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(built.reliability.complete).toBe(true);
    const projectionKey = (await saved.storage.list('cache/usage-aggregation-v1')).find((key) => key.startsWith('range-projection-'));
    expect(projectionKey).toBeTypeOf('string');
    const projectionBytes = await saved.storage.read('cache/usage-aggregation-v1', projectionKey!);
    const oldProjection = JSON.parse(Buffer.from(projectionBytes ?? new Uint8Array()).toString('utf8')) as { version: number; fingerprint: string; agents: { turns: unknown[] }[] };
    expect(oldProjection.version).toBe(2);
    oldProjection.version = 1;
    for (const agent of oldProjection.agents) agent.turns = [];
    await saved.storage.write('cache/usage-aggregation-v1', projectionKey!, Buffer.from(JSON.stringify(oldProjection)));
    expect(parseUsageRangeProjection(Buffer.from(JSON.stringify(oldProjection)))).toBeUndefined();
    const collection = `usage-range-v1:${oldProjection.fingerprint}`;
    for (const key of await saved.store.listKeys(collection)) {
      const value = await saved.store.get<{ kind?: string; turnAgents?: boolean; sessions?: { agents?: unknown }[] }>(collection, key);
      if (value?.kind !== 'bucket') continue;
      const sessionsWithoutAgents = (value.sessions ?? []).map((session) => {
        const rest = { ...session };
        delete rest.agents;
        return rest;
      });
      const bucket = { ...value };
      delete bucket.turnAgents;
      await saved.store.put(collection, key, { ...bucket, sessions: sessionsWithoutAgents }, { columns: { view: 2 } });
    }
    saved.logs.append(main, 'wire.jsonl', repeat);
    await saved.logs.flush(main, 'wire.jsonl');
    const recovered = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(recovered.reliability.complete).toBe(true);
    expect(recovered.summary).toEqual(reference.summary);
    expect(recovered.trend).toEqual(reference.trend);
    expect(recovered.reliability.usage_coverage).toEqual(reference.reliability.usage_coverage);
    const kept = JSON.parse(Buffer.from(await saved.storage.read('cache/usage-aggregation-v1', projectionKey!) ?? new Uint8Array()).toString('utf8')) as { version?: number; agents?: { turns?: { turnIds?: number[] }[] }[] };
    if (kept.version === 2) expect(kept.agents?.some((agent) => agent.turns?.some((turn) => turn.turnIds?.includes(1)))).toBe(true);
    else expect(parseUsageRangeProjection(Buffer.from(JSON.stringify(kept)))).toBeUndefined();
    saved.logs.append(main, 'wire.jsonl', repeat);
    await saved.logs.flush(main, 'wire.jsonl');
    const second = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(second.reliability.complete).toBe(true);
    expect(second.summary.tokens.output).toBe(5);
    expect(second.reliability.usage_coverage).toMatchObject({ known_records: 5, missing_records: 0 });
    expect(second.trend[0]?.turn_count).toBe(2);
    expect(second.trend[0]?.drilldown.sessions.find((session) => session.session_id === 's')).toMatchObject({ turn_ids: [1], turn_count: 1 });
    const budgetHome = await openRange(sessions, initial);
    let budgetBuilt = await new UsageAggregationService(budgetHome.core, () => now).query(input);
    for (let attempt = 0; attempt < 4 && !budgetBuilt.reliability.complete; attempt += 1) budgetBuilt = await new UsageAggregationService(budgetHome.core, () => now).query(input);
    const budgetKey = (await budgetHome.storage.list('cache/usage-aggregation-v1')).find((key) => key.startsWith('range-projection-'));
    const budgetBody = JSON.parse(Buffer.from(await budgetHome.storage.read('cache/usage-aggregation-v1', budgetKey!) ?? new Uint8Array()).toString('utf8')) as { version: number; fingerprint: string; agents: { turns: unknown[] }[] };
    budgetBody.version = 1;
    for (const agent of budgetBody.agents) agent.turns = [];
    await budgetHome.storage.write('cache/usage-aggregation-v1', budgetKey!, Buffer.from(JSON.stringify(budgetBody)));
    await budgetHome.store.dropCollection(`usage-range-v1:${budgetBody.fingerprint}`);
    await budgetHome.store.delete('usage-range-routing-v1', budgetBody.fingerprint);
    const limited = await new UsageAggregationService(budgetHome.core, () => now, { usageFactBudget: 1 }).query(input);
    expect(limited.reliability.complete).toBe(false);
    expect(limited.reliability.incomplete_reason).toBe('record_budget');
  });

  it('yields and cancels while preparing a recovered fold projection before publishing it', async () => {
    const source = fixture([], {}, () => 100);
    const controller = new AbortController();
    const reason = new DOMException('cancelled during projection recovery', 'AbortError');
    const rows = Array.from({ length: 1024 }, () => ({ sessionId: 'session-example', record: usageRecord(10) }));
    const tick = setImmediate(() => { controller.abort(reason); });
    try {
      const pending = Reflect.apply(Reflect.get(source.service, 'saveFoldProjection'), source.service, [{ range: {}, granularity: 'session' }, 'example', [], { sessions: [] }, {}, { rows, buckets: new Map() }, controller.signal]);
      await expect(pending).rejects.toBe(reason);
      expect(source.persistedRecordCounts()).toEqual([]);
    } finally { clearImmediate(tick); source.service.dispose(); }
  });

  it('drops a repeated stored turn on save and does not count that turn again on append', async () => {
    const day0 = Date.UTC(2026, 9, 1);
    const now = day0 + 86_400_000;
    const main = scope('w', 's');
    const sessions = [summary('s', 'w')];
    const first = { ...usageRecord(day0, 7), agentId: 'main' };
    const second = { ...usageRecord(day0, 8), agentId: 'main' };
    const input = { range: 'custom', start_at: 0, end_at: now, dimension: 'model' } as const;
    const saved = await openRange(sessions, { [main]: [first, second] });
    expect((await new UsageAggregationService(saved.core, () => now, { usageFactBudget: 1 }).query(input)).reliability.complete).toBe(false);
    let built = await new UsageAggregationService(saved.core, () => now).query(input);
    for (let attempt = 0; attempt < 4 && !built.reliability.complete; attempt += 1) built = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(built.reliability.complete).toBe(true);
    expect(built.summary.tokens.output).toBe(2);
    expect(built.reliability.usage_coverage).toMatchObject({ known_records: 2, missing_records: 0 });
    expect(built.trend[0]?.turn_count).toBe(2);
    const projectionKey = (await saved.storage.list('cache/usage-aggregation-v1')).find((key) => key.startsWith('range-projection-'));
    expect(projectionKey).toBeTypeOf('string');
    const parsed = JSON.parse(Buffer.from(await saved.storage.read('cache/usage-aggregation-v1', projectionKey!) ?? new Uint8Array()).toString('utf8')) as { fingerprint: string; storedBuckets?: boolean };
    expect(parsed.storedBuckets).toBe(true);
    const collection = `usage-range-v1:${parsed.fingerprint}`;
    let turnKey: string | undefined;
    for (const key of await saved.store.listKeys(collection)) {
      const value = await saved.store.get<{ kind?: string; key?: string; sessions?: { sessionId: string; agents?: { agentId: string; turnIds: number[] }[] }[] }>(collection, key);
      if (value?.kind !== 'bucket' || value.key === undefined) continue;
      const agent = value.sessions?.find((session) => session.sessionId === 's')?.agents?.find((entry) => entry.turnIds.includes(7));
      if (agent === undefined) continue;
      turnKey = `turn:${JSON.stringify([value.key, 's', agent.agentId, 7])}`;
    }
    expect(turnKey).toBeTypeOf('string');
    expect(await saved.store.get(collection, turnKey!)).toBe(true);
    await saved.store.delete(collection, turnKey!);
    await saved.store.put(collection, 'fold-sentinel', { keep: true });
    await saved.storage.delete('cache/usage-aggregation-v1', projectionKey!);
    saved.logs.append(main, 'wire.jsonl', first);
    await saved.logs.flush(main, 'wire.jsonl');
    const compensated = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(await saved.store.get(collection, 'fold-sentinel')).toEqual({ keep: true });
    expect(compensated.reliability.complete).toBe(true);
    expect(compensated.summary.tokens.output).toBe(3);
    expect(compensated.reliability.usage_coverage).toMatchObject({ known_records: 3, missing_records: 0 });
    expect(compensated.trend[0]?.turn_count).toBe(2);
    expect(compensated.trend[0]?.drilldown.sessions.find((session) => session.session_id === 's')).toMatchObject({ turn_ids: [7, 8], turn_count: 2, unknown_turn_records: 0 });
    let duplicated = false;
    for (const key of await saved.store.listKeys(collection)) {
      const value = await saved.store.get<{ kind?: string; turnCount: number; sessions: { sessionId: string; agents?: { agentId: string; turnIds: number[] }[] }[] }>(collection, key);
      if (value?.kind !== 'bucket') continue;
      const agent = value.sessions.find((session) => session.sessionId === 's')?.agents?.find((entry) => entry.agentId === 'main');
      expect(agent?.turnIds).toEqual([7, 8]);
      agent?.turnIds.push(7);
      await saved.store.put(collection, key, { ...value, turnCount: value.turnCount + 1 }, { columns: { view: 2 } });
      duplicated = true;
    }
    expect(duplicated).toBe(true);
    const rewrittenKey = (await saved.storage.list('cache/usage-aggregation-v1')).find((key) => key.startsWith('range-projection-'));
    expect(rewrittenKey).toBeTypeOf('string');
    await saved.storage.delete('cache/usage-aggregation-v1', rewrittenKey!);
    const migrating = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(migrating.reliability.complete).toBe(true);
    expect(migrating.summary.tokens).toEqual(compensated.summary.tokens);
    expect(migrating.reliability.usage_coverage).toEqual(compensated.reliability.usage_coverage);
    expect(migrating.trend[0]?.turn_count).toBe(2);
    expect(migrating.trend[0]?.drilldown.sessions.find((session) => session.session_id === 's')).toMatchObject({ turn_ids: [7, 8], turn_count: 2, unknown_turn_records: 0 });
    const reread = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(reread.reliability.complete).toBe(true);
    expect(reread.summary.tokens).toEqual(migrating.summary.tokens);
    expect(reread.reliability.usage_coverage).toEqual(migrating.reliability.usage_coverage);
    expect(reread.trend).toEqual(migrating.trend);
    expect(reread.trend[0]?.turn_count).toBe(2);
    const stored = parseUsageRangeProjection(await saved.storage.read('cache/usage-aggregation-v1', rewrittenKey!) ?? new Uint8Array());
    expect(stored?.version).toBe(2);
    expect(stored?.buckets.map((bucket) => bucket.turnCount)).toEqual([2]);
    expect(stored?.agents.flatMap((agent) => agent.turns.flatMap((turn) => turn.turnIds.filter((id) => id === 7)))).toEqual([7]);
    saved.logs.append(main, 'wire.jsonl', first);
    await saved.logs.flush(main, 'wire.jsonl');
    const repeated = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(repeated.reliability.complete).toBe(true);
    expect(repeated.summary.tokens.output).toBe(4);
    expect(repeated.reliability.usage_coverage).toMatchObject({ known_records: 4, missing_records: 0 });
    expect(repeated.trend[0]?.turn_count).toBe(2);
    saved.logs.append(main, 'wire.jsonl', { ...usageRecord(day0, 9), agentId: 'main' });
    await saved.logs.flush(main, 'wire.jsonl');
    const added = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(added.reliability.complete).toBe(true);
    expect(added.summary.tokens.output).toBe(5);
    expect(added.reliability.usage_coverage).toMatchObject({ known_records: 5, missing_records: 0 });
    expect(added.trend[0]?.turn_count).toBe(3);
    expect(added.trend[0]?.drilldown.sessions.find((session) => session.session_id === 's')).toMatchObject({ turn_ids: [7, 8, 9], turn_count: 3, unknown_turn_records: 0 });
  });
});


describe('SQLite UsageRangeFold publication', () => {
  it('publishes one prepared session without encoding other sources and preserves the full-head cache', async () => {
    const saved = await openRange([], {}, true);
    const checkpoint = { generation: 'example', offset: 1, size: 1, mtimeMs: 1, boundaryHash: '', valid: true };
    const sessions = [1000, 1].map((count, index) => ({ summary: summary(`session-${index}`, 'workspace'), prepared: false, invalid: false, sources: Array.from({ length: count }, (_, i) => ({ agentId: `agent-${i}`, scope: `sessions/workspace/session-${index}/agents/agent-${i}`, checkpoint, done: true })) }));
    const head: RangeFoldHead = { version: 1, journalReplayVersion: 3, fingerprint: 'scoped-session', sessions, complete: false, inventoryComplete: true, invalidated: false };
    const fold = new UsageRangeFold(saved.store, 'scoped-session', 100, 100);
    await fold.saveHead(head);
    const revision = await saved.store.get('scoped-session', 'head:revision');
    sessions[1]!.prepared = true;
    const stringify = vi.spyOn(JSON, 'stringify'), commits = vi.spyOn(saved.store, 'batchIf');
    try {
      await fold.saveHead(head, sessions[1]);
      expect(stringify.mock.calls.filter(([value]) => value === sessions[0]!.sources[0])).toHaveLength(0);
      expect(commits.mock.calls[0]?.[0]).toEqual([{ collection: 'scoped-session', key: 'head:revision', value: revision }]);
      expect(commits.mock.calls[0]?.[1]).toHaveLength(2);
      expect(await new UsageRangeFold(saved.store, 'scoped-session', 100, 100).head()).toEqual(head);
      stringify.mockClear();
      head.complete = true;
      await fold.saveHead(head);
      expect(stringify.mock.calls.filter(([value]) => value === sessions[0]!.sources[0])).toHaveLength(1);
      expect(await new UsageRangeFold(saved.store, 'scoped-session', 100, 100).head()).toEqual(head);
    } finally { stringify.mockRestore(); commits.mockRestore(); }
  });

  it('reopens a dead SQLite worker on a real Usage history request without a manual recovery call', async () => {
    const wireScope = scope('workspace', 'session');
    const saved = await openRange([summary('session', 'workspace')], { [wireScope]: [usageRecord(1, 1), usageRecord(2, 2)] }, true);
    await saved.store.get('routing', 'missing');
    const host = Reflect.get(saved.store, 'worker') as object;
    const thread = Reflect.get(host, 'worker') as import('node:worker_threads').Worker;
    await thread.terminate();
    const recover = vi.spyOn(saved.store, 'recover');
    const service = new UsageAggregationService(saved.core, () => 1000);
    const response = await service.query({ range: 'custom', start_at: 0, end_at: 1000 });
    expect(response.reliability.complete).toBe(true);
    expect(response.reliability.usage_coverage).toMatchObject({ known_records: 2, missing_records: 0 });
    expect(response.summary.tokens.output).toBe(2);
    expect(recover).toHaveBeenCalledOnce();
    expect(Reflect.get(saved.store, 'worker')).not.toBe(host);
    service.dispose();
  });

  it('rebuilds an interrupted complete-fold append from its invalidated publication without counting the tail twice', async () => {
    const wireScope = scope('workspace', 'session'), now = 1000;
    const saved = await openRange([summary('session', 'workspace')], { [wireScope]: [usageRecord(1, 1), usageRecord(2, 2)] }, true);
    const input = { range: 'custom', start_at: 0, end_at: now, dimension: 'model' } as const;
    await new UsageAggregationService(saved.core, () => now, { usageFactBudget: 1 }).query(input);
    let response = await new UsageAggregationService(saved.core, () => now).query(input);
    for (let pass = 0; pass < 4 && !response.reliability.complete; pass++) response = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(response.reliability.complete).toBe(true);
    expect(response.summary.tokens.output).toBe(2);
    const projectionKey = (await saved.storage.list('cache/usage-aggregation-v1')).find((key) => key.startsWith('range-projection-'))!;
    const projection = parseUsageRangeProjection((await saved.storage.read('cache/usage-aggregation-v1', projectionKey))!)!;
    const collection = `usage-range-v1:${projection.fingerprint}`;
    await saved.storage.delete('cache/usage-aggregation-v1', projectionKey);
    const fold = new UsageRangeFold(saved.store, collection, 100, 100);
    const head = (await fold.head<RangeFoldHead>())!;
    const previous = head.sessions[0]!.sources![0]!.checkpoint;
    saved.logs.append(wireScope, 'wire.jsonl', usageRecord(3, 3));
    await saved.logs.flush(wireScope, 'wire.jsonl');
    const facts = saved.core.accessor.get(IUsageFactStore);
    const stopped = vi.spyOn(facts, 'commit').mockRejectedValueOnce(new Error('process stopped before source acknowledgement'));
    const service = new UsageAggregationService(saved.core, () => now);
    const query = { range: { preset: 'custom', startAt: 0, endAt: now, defaultedToAllHistory: false }, granularity: 'five_hour', dimension: 'model', models: [], providers: [], profiles: [], agentIds: [], workspaceIds: [], includeArchived: true, timezoneOffsetMinutes: 0, pageSize: 25 };
    const signal = new AbortController().signal;
    const advanced = await Reflect.apply(Reflect.get(service, 'advanceCompleteFold'), service, [head, fold, query, { signal, factSignal: signal, remainingRecords: 200_000, remainingFacts: 200_000, deadlineAt: now + 10_000, sourcesComplete: true, incompleteReason: null }]);
    expect(advanced).toBe(false);
    const interrupted = (await new UsageRangeFold(saved.store, collection, 100, 100).head<RangeFoldHead>())!;
    expect(interrupted).toMatchObject({ invalidated: true, complete: false });
    expect(interrupted.sessions[0]!.sources![0]!.checkpoint).toEqual(previous);
    expect((await fold.recordPage()).items.reduce((sum, row) => sum + row.record.usage.output, 0)).toBe(3);
    stopped.mockRestore();
    const recovered = await new UsageAggregationService(saved.core, () => now).query(input);
    expect(recovered.reliability.complete).toBe(true);
    expect(recovered.summary.tokens.output).toBe(3);
    expect(recovered.reliability.usage_coverage).toMatchObject({ known_records: 3, missing_records: 0 });
    expect(recovered.trend[0]?.turn_count).toBe(3);
    service.dispose();
  });

  it('replays exact fact-journal ordinals after a rejected page without skipping duplicate, zero or unknown facts', async () => {
    const wireScope = 'sessions/workspace/session/agents/main';
    const directory = `cache/usage-facts-v1/${createHash('sha256').update(wireScope).digest('hex')}`;
    const storage = new InMemoryStorageService();
    const records = Array.from({ length: 600 }, (_, ordinal) => ({ time: 1, model: 'example', turnId: ordinal, usageKnown: ordinal % 3 === 0 ? false : true, usage: { inputOther: 0, output: ordinal % 3 === 1 ? 0 : 1, inputCacheRead: 0, inputCacheCreation: 0 } }));
    records[599] = { ...records[598]! };
    const checkpoint = { generation: 'example', offset: 600, size: 600, mtimeMs: 1, boundaryHash: '', valid: true };
    const initial = { version: 1, start: 0, checkpoint, records };
    const tail = { version: 1, start: 600, checkpoint: { ...checkpoint, offset: 601, size: 601 }, records: [records[599]!] };
    const stale = { version: 1, start: 0, checkpoint: { ...checkpoint, generation: 'previous' }, records: [records[0]!] };
    const journal = [stale, initial, tail, tail].map((batch) => JSON.stringify(batch) + '\n').join('');
    const initialOffset = Buffer.byteLength(JSON.stringify(stale) + '\n');
    await storage.write(directory, 'facts.jsonl', Buffer.from(journal));
    const service = new UsageAggregationService({ accessor: { get: (id: unknown) => { if (id === IFileSystemStorageService) return storage; throw new Error('Unexpected dependency'); } } } as unknown as Scope, () => 0);
    const replay = Reflect.get(service, 'replayFactJournal') as (...args: unknown[]) => Promise<{ done: boolean; cursor: string }>;
    const hold = { cursor: 'journal:0:0' }, accepted: unknown[] = [];
    const deadline = new AbortController();
    const budget = { signal: new AbortController().signal, factSignal: deadline.signal, remainingFacts: 200_000, deadlineAt: 10_000, incompleteReason: null };
    const firstPageDeadline = new AbortController();
    const uncommitted = await replay.call(service, wireScope, hold.cursor, { startAt: 0, endAt: 10 }, { ...budget, factSignal: firstPageDeadline.signal }, hold, async () => { firstPageDeadline.abort(); throw new Error('first page was not committed'); }, 'example');
    expect(uncommitted).toEqual({ done: false, cursor: `journal:${initialOffset}:0` });
    expect(accepted).toEqual([]);
    let pages = 0;
    const first = await replay.call(service, wireScope, hold.cursor, { startAt: 0, endAt: 10 }, budget, hold, async (page: unknown[]) => { if (++pages === 2) { deadline.abort(); throw new Error('cancelled before commit'); } accepted.push(...page); }, 'example');
    expect(first).toEqual({ done: false, cursor: `journal:${initialOffset}:256` });
    expect(accepted).toHaveLength(256);
    const next = await replay.call(service, wireScope, first.cursor, { startAt: 0, endAt: 10 }, { ...budget, remainingFacts: 345, factSignal: new AbortController().signal }, hold, async (page: unknown[]) => { accepted.push(...page); }, 'example');
    expect(next.done).toBe(false);
    expect(accepted).toEqual([...records, records[599]]);
    expect(JSON.parse(Buffer.from(next.cursor.split(':')[3]!, 'base64url').toString('utf8'))).toEqual({ generation: 'example', offset: 601, count: 601 });
    const restarted = new UsageAggregationService({ accessor: { get: (id: unknown) => { if (id === IFileSystemStorageService) return storage; throw new Error('Unexpected dependency'); } } } as unknown as Scope, () => 0);
    const last = await replay.call(restarted, wireScope, next.cursor, { startAt: 0, endAt: 10 }, { ...budget, factSignal: new AbortController().signal }, hold, async (page: unknown[]) => { accepted.push(...page); }, 'example');
    expect(last.done).toBe(true);
    expect(accepted).toEqual([...records, records[599]]);
    expect(accepted).toHaveLength(601);
    restarted.dispose();
    service.dispose();
  });

  it('rejects interleaved same-fingerprint pages and preserves groups, turns and coverage after reopen', async () => {
    const home = mkdtempSync(join(tmpdir(), 'usage-fold-sqlite-'));
    const instances: TestInstantiationService[] = [];
    const open = (): IQueryStore => {
      const ix = new TestInstantiationService(); instances.push(ix);
      ix.stub(IBootstrapService, stubBootstrap(home)); ix.stub(ILogService, stubLog());
      ix.set(IQueryStore, new SyncDescriptor(SqliteQueryStore)); return ix.get(IQueryStore);
    };
    try {
      const stores = [open(), open()];
      const folds = stores.map((store) => new UsageRangeFold(store, 'same-fingerprint', 100, 100));
      await folds[0]!.saveHead({ offset: 0, complete: false });
      let entered = 0;
      let release!: () => void;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const gates = stores.map((store) => {
        const original = store.getMany.bind(store);
        return vi.spyOn(store, 'getMany').mockImplementation(async (collection, keys, signal) => {
          const rows = await original(collection, keys, signal);
          if (++entered === 2) release();
          await paused;
          return rows;
        });
      });
      const records = [1, 2].map((turnId) => ({ time: 1, model: 'example', agentId: 'main', turnId, usageKnown: true, usage: { inputOther: 0, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }));
      const accepted = await Promise.allSettled(folds.map((fold, index) => fold.addPage(summary('session', 'workspace'), [records[index]!], () => 'bucket', () => true, { offset: index + 1, complete: false })));
      expect(accepted.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const conflict = accepted.find((result) => result.status === 'rejected');
      expect(conflict).toMatchObject({ status: 'rejected', reason: { message: 'Usage fact cursor changed' } });
      for (const gate of gates) gate.mockRestore();
      const winner = (await folds[0]!.head<{ offset: number }>())!.offset - 1;
      const loser = 1 - winner;
      expect((await folds[0]!.recordPage()).items[0]?.record.usage.output).toBe(1);
      expect((await folds[0]!.buckets(['bucket'])).get('bucket:bucket')?.turnCount).toBe(1);
      await folds[loser]!.addPage(summary('session', 'workspace'), [records[loser]!], () => 'bucket', () => true, { offset: 3, complete: true });
      for (const store of stores) await store.close();
      const reopened = new UsageRangeFold(open(), 'same-fingerprint', 100, 100);
      expect(await reopened.head()).toEqual({ offset: 3, complete: true });
      expect((await reopened.recordPage()).items[0]?.record).toMatchObject({ usage: { output: 2 }, folded: { records: 2, known: 2 } });
      expect((await reopened.buckets(['bucket'])).get('bucket:bucket')).toMatchObject({ turnCount: 2, sessions: [{ turnIds: [1, 2], turnCount: 2 }] });
      const splitStore = open(), split = new UsageRangeFold(splitStore, 'split-head', 100, 100);
      const checkpoint = { generation: 'example', offset: 1, size: 1, mtimeMs: 1, boundaryHash: '', valid: true };
      const session = { summary: summary('session', 'workspace'), invalid: false, prepared: true, sources: Array.from({ length: 1000 }, (_, index) => ({ agentId: `agent-${index}`, scope: `sessions/workspace/session/agents/agent-${index}`, checkpoint, done: false, cursor: 'journal:0:0' })) };
      const head = { version: 1 as const, fingerprint: 'split-head', sessions: [session], complete: false, inventoryComplete: true, invalidated: false };
      await splitStore.put('split-head', 'head', head);
      expect(await split.head()).toBeUndefined();
      await split.reset();
      await split.saveHead(head);
      const revision = await splitStore.get<{ epoch: string; revision: number }>('split-head', 'head:revision');
      expect(JSON.stringify(head).length).toBeGreaterThan(200_000);
      const commits = vi.spyOn(splitStore, 'batchIf');
      session.sources[0]!.cursor = 'journal:0:1';
      await split.addPage(session.summary, [records[0]!], () => 'bucket', () => true, head, undefined, { session, source: session.sources[0]! });
      expect(JSON.stringify(commits.mock.calls[0]).length).toBeLessThan(10_000);
      expect(commits.mock.calls[0]?.[0]).toEqual([{ collection: 'split-head', key: 'head:revision', value: revision }]);
      expect(await new UsageRangeFold(open(), 'split-head', 100, 100).head()).toEqual(head);
      commits.mockRestore();
      let enteredPage!: () => void, releasePage!: () => void;
      const enteredFlight = new Promise<void>((resolve) => { enteredPage = resolve; });
      const pausedPage = new Promise<void>((resolve) => { releasePage = resolve; });
      const getMany = splitStore.getMany.bind(splitStore);
      const gate = vi.spyOn(splitStore, 'getMany').mockImplementation(async (collection, keys, signal) => { const result = await getMany(collection, keys, signal); enteredPage(); await pausedPage; return result; });
      const stale = split.addPage(session.summary, [records[1]!], () => 'bucket', () => true, head, undefined, { session, source: session.sources[0]! });
      const rejected = expect(stale).rejects.toThrow('Usage fact cursor changed');
      await enteredFlight;
      const resetStore = open(), reset = new UsageRangeFold(resetStore, 'split-head', 100, 100);
      await reset.reset();
      releasePage();
      await rejected;
      gate.mockRestore();
      expect((await resetStore.get<{ epoch: string }>('split-head', 'head:revision'))?.epoch).not.toBe(revision?.epoch);
      expect(await reset.head()).toBeUndefined();
      expect((await reset.recordPage()).items).toEqual([]);
      expect(await resetStore.listKeys('split-head')).toEqual(['head:revision']);
      const sameStore = open(), same = new UsageRangeFold(sameStore, 'same-instance', 100, 100);
      let enteredSame!: () => void, releaseSame!: () => void;
      const sameEntered = new Promise<void>((resolve) => { enteredSame = resolve; });
      const samePaused = new Promise<void>((resolve) => { releaseSame = resolve; });
      const sameGetMany = sameStore.getMany.bind(sameStore);
      const sameGate = vi.spyOn(sameStore, 'getMany').mockImplementation(async (collection, keys, signal) => { const result = await sameGetMany(collection, keys, signal); if (!keys.includes('head:revision')) { enteredSame(); await samePaused; } return result; });
      const beforeInitialization = same.addPage(summary('session', 'workspace'), [records[0]!], () => 'bucket', () => true, { offset: 1 });
      const missingExpected = expect(beforeInitialization).rejects.toThrow('Usage fact cursor changed');
      await sameEntered;
      await same.reset();
      releaseSame();
      await missingExpected;
      sameGate.mockRestore();
      expect(await sameStore.listKeys('same-instance')).toEqual(['head:revision']);
      expect((await same.recordPage()).items).toEqual([]);
    } finally {
      for (const ix of instances) await ix.dispose();
      await drainQueryStoreDisposals();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

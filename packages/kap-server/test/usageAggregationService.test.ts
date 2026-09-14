import {
  IFileSystemStorageService,
  IRetainedUsageService,
  ISessionIndex,
  RETAINED_USAGE_VERSION,
  type RetainedDeletedSessionUsage,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type RetainedUsageRecord,
  type Scope,
  type SessionSummary,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { Event } from '@kiki/agent-core-v2/_base/event';
import type { UsageQuery } from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { UsageAggregationService } from '../src/usage/usageAggregationService';

interface Fixture {
  readonly service: UsageAggregationService;
  readonly reads: Map<string, number>;
  readonly readBytes: Map<string, number>;
  readonly retainedQueries: readonly RetainedUsageListQuery[];
  setWire(scope: string, records: readonly WireRecord[]): void;
  restart(): UsageAggregationService;
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
): Fixture {
  const reads = new Map<string, number>();
  const readBytes = new Map<string, number>();
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
      return {
        items: sessions.filter((session) => allowed === undefined || allowed.has(session.workspaceId)),
        nextCursor: undefined,
      };
    },
    get: async (id) => sessions.find((session) => session.id === id),
    count: async () => sessions.length,
    remove: async () => {},
  };
  const storage = {
    _serviceBrand: undefined,
    list: async () => ['main'],
    size: async (wireScope: string) => wires.get(wireScope)?.length,
    mtime: async (wireScope: string) => wireMtimes.get(wireScope),
    read: async (storageScope: string, key: string) => persisted.get(`${storageScope}/${key}`),
    write: async (storageScope: string, key: string, data: Uint8Array) => {
      persisted.set(`${storageScope}/${key}`, Uint8Array.from(data));
    },
    readStream: (wireScope: string, _key: string, range?: { start: number; end: number }) => {
      reads.set(wireScope, (reads.get(wireScope) ?? 0) + 1);
      return (async function* () {
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
  };
  const pricing: IModelPricingService = {
    _serviceBrand: undefined,
    resolve: () => undefined,
    calculate: () => 1,
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
        throw new Error('unexpected service');
      },
    },
  } as unknown as Scope;
  return {
    service: new UsageAggregationService(core, now, limits),
    reads,
    readBytes,
    retainedQueries,
    setWire,
    restart: () => new UsageAggregationService(core, now, limits),
  };
}

function scope(workspaceId: string, sessionId: string): string {
  return `sessions/${workspaceId}/${sessionId}/agents/main`;
}

async function query(service: UsageAggregationService, input: UsageQuery = {}) {
  return service.query(input);
}

describe('UsageAggregationService accounting evidence', () => {
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
});

describe('UsageAggregationService cache budgets', () => {
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
    const { service, reads } = fixture(
      [session],
      { [wireScope]: [usageRecord(10, 1), usageRecord(11, 2)] },
      () => 0,
      { wireRecordBudget: 1, deadlineMs: 10_000 },
    );

    const first = await query(service);
    const second = await query(service);

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

  it('checks the deadline again while aggregating cached or replayed records', async () => {
    let calls = 0;
    const session = summary('session-a', 'workspace-a');
    const { service } = fixture(
      [session],
      { [scope('workspace-a', 'session-a')]: [usageRecord(10, 1)] },
      () => calls++ < 4 ? 0 : 100,
      { deadlineMs: 50 },
    );

    const result = await query(service);
    expect(result.summary.session_count).toBe(0);
    expect(result.reliability).toMatchObject({
      incomplete_sessions: 1,
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
    expect((instance.readBytes.get(wireScope) ?? 0) - bytesAfterInitialScan).toBeLessThanOrEqual(4_096);
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

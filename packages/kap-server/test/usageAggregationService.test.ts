import {
  IAppendLogStore,
  IFileSystemStorageService,
  IRetainedUsageService,
  ISessionIndex,
  type RetainedUsageListQuery,
  type RetainedUsageListResult,
  type Scope,
  type SessionSummary,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import { Event } from '@moonshot-ai/agent-core-v2/_base/event';
import type { UsageQuery } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import { IModelPricingService } from '../src/pricing/modelPricingService';
import { UsageAggregationService } from '../src/usage/usageAggregationService';

interface Fixture {
  readonly service: UsageAggregationService;
  readonly reads: Map<string, number>;
  readonly retainedQueries: readonly RetainedUsageListQuery[];
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
  const retainedQueries: RetainedUsageListQuery[] = [];
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
  } as unknown as IFileSystemStorageService;
  const appendLog = {
    _serviceBrand: undefined,
    read: <R>(scope: string): AsyncIterable<R> => {
      reads.set(scope, (reads.get(scope) ?? 0) + 1);
      return (async function* () {
        for (const record of records[scope] ?? []) yield record as R;
      })();
    },
  } as unknown as IAppendLogStore;
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
        if (identifier === IAppendLogStore) return appendLog;
        if (identifier === IRetainedUsageService) return retainedUsage;
        if (identifier === IModelPricingService) return pricing;
        throw new Error('unexpected service');
      },
    },
  } as unknown as Scope;
  return {
    service: new UsageAggregationService(core, now, limits),
    reads,
    retainedQueries,
  };
}

function scope(workspaceId: string, sessionId: string): string {
  return `sessions/${workspaceId}/${sessionId}/agents/main`;
}

async function query(service: UsageAggregationService, input: UsageQuery = {}) {
  return service.query(input);
}

describe('UsageAggregationService cache budgets', () => {
  it('charges warmed cache entries against each request record budget', async () => {
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
    expect(all.summary.session_count).toBe(1);
    expect(all.reliability).toMatchObject({
      scanned_sessions: 1,
      incomplete_reason: 'record_budget',
    });
    expect([...reads.values()].reduce((total, count) => total + count, 0)).toBe(2);
  });

  it('does not cache partial reads and preserves their reliability on repeated queries', async () => {
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
      incomplete_sessions: 1,
      incomplete_reason: 'record_budget',
    });
    expect(second.reliability).toMatchObject({
      incomplete_sessions: 1,
      incomplete_reason: 'record_budget',
    });
    expect(service.cacheStatus()).toEqual({ entries: 0, records: 0 });
    expect(reads.get(wireScope)).toBe(2);
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

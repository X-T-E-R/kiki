import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IUsageFactStore, UsageFactStore } from '#/app/usageFacts/usageFactStore';
import { IRetainedUsageService } from '#/app/retainedUsage/retainedUsage';
import { RetainedUsageService } from '#/app/retainedUsage/retainedUsageService';
import { IEventService } from '#/app/event/event';
import { IUsageReadModel, type UsageReadModelQuery } from '#/persistence/interface/usageReadModel';
import { SqliteUsageReadModel } from '#/persistence/backends/sqlite/sqliteUsageReadModel';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const SCOPE = 'sessions/example/session/agents/main';
const usage = (inputOther: number, output = 0) => ({ inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 });
const record = (time: number, inputOther = 10, output = 0) => ({ type: 'usage.record', time, model: 'example', modelAlias: 'alias', agentId: 'main', turnId: 1, usageKnown: true, usage: usage(inputOther, output) });
const query: UsageReadModelQuery = { granularity: 'five_hour', dimension: 'model', models: [], providers: [], profiles: [], agentIds: [], workspaceIds: [], includeArchived: true, timezoneOffsetMinutes: 0, pageSize: 25, quotes: [{ model: 'example', inputOther: 0.1 }], drilldownSessionLimit: 100, drilldownTurnLimit: 100 };

describe('Usage source read model', () => {
  let home: string;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let model: IUsageReadModel;
  let facts: IUsageFactStore;
  let logs: IAppendLogStore;
  function open(): void {
    ix = new TestInstantiationService();
    ix.stub(IBootstrapService, stubBootstrap(home));
    ix.stub(ILogService, stubLog());
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
    ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
    ix.set(IRetainedUsageService, new SyncDescriptor(RetainedUsageService));
    ix.stub(IEventService, { publish: () => {} });
    model = ix.get(IUsageReadModel);
    facts = ix.get(IUsageFactStore);
    logs = ix.get(IAppendLogStore);
  }
  async function catalog(): Promise<void> {
    await model.catalog([{ id: 'session', workspaceId: 'example', createdAt: 0, updatedAt: 1, archived: false, deleted: false }], [{ source: SCOPE, workspaceId: 'example', sessionId: 'session' }], true);
  }
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'usage-read-model-')); storage = new InMemoryStorageService(); open(); });
  afterEach(async () => { await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); });

  it('projects canonical commits, preserves duplicate ordinals and backdated appends, and reprices without wire reads', async () => {
    logs.append(SCOPE, 'wire.jsonl', record(2));
    logs.append(SCOPE, 'wire.jsonl', record(2));
    logs.append(SCOPE, 'wire.jsonl', record(3, 0, 1));
    await logs.flush();
    await catalog();
    const result = await model.query(query);
    expect(result.total).toMatchObject({ usage: usage(20, 1), cost: 2, costUnknown: true, knownRecords: 3 });
    expect(result.trend[0]).toMatchObject({ key: '0', requests: 3, turns: 1, groups: [{ key: 'alias' }] });
    expect((await facts.summary(SCOPE)).totals?.byModelMask).toEqual({ example: { 1: usage(20), 2: usage(0, 1) } });
    logs.append(SCOPE, 'wire.jsonl', record(1, 5));
    await logs.flush();
    expect((await model.query(query)).total).toMatchObject({ usage: usage(25, 1), cost: 2.5, knownRecords: 4 });
    const priced = await model.query({ ...query, quotes: [{ model: 'example', inputOther: 0.1, output: 2 }] });
    expect(priced.total).toMatchObject({ cost: 4.5, costUnknown: false });
  });

  it('reads exact boundary facts when an hourly group crosses a range or timezone bucket', async () => {
    const edge = 18_000_000 - 17 * 60_000;
    for (const value of [record(edge - 1, 3), record(edge + 1, 7), { ...record(edge + 2, 5), modelAlias: 'other', provider: 'provider', profileName: 'profile', parentAgentId: 'parent' }]) logs.append(SCOPE, 'wire.jsonl', value);
    await logs.flush(); await catalog();
    const split = await model.query({ ...query, timezoneOffsetMinutes: 17 });
    expect(split.trend.map((item) => ({ start: item.startAt, requests: item.requests, input: item.groups.reduce((total, group) => total + group.usage.inputOther, 0) }))).toEqual([{ start: -1_020_000, requests: 1, input: 3 }, { start: edge, requests: 2, input: 12 }]);
    expect((await model.query({ ...query, startAt: edge, endAt: edge + 2 })).total).toMatchObject({ usage: usage(7), knownRecords: 1 });
    const filtered = await model.query({ ...query, dimension: 'provider', providers: ['provider'], profiles: ['profile'], agentIds: ['main'], models: ['other'] });
    expect(filtered.total).toMatchObject({ usage: usage(5), knownRecords: 1 });
    expect(filtered.trend[0]?.groups[0]).toMatchObject({ key: 'provider:"provider"', parentAgentId: 'parent', profileName: 'profile', modelAlias: 'other' });
    expect((await model.read(SCOPE)).records).toHaveLength(3);
  });

  it('backfills an older typed database in bounded restartable pages and invalidates old query revisions', async () => {
    const count = 32770;
    const checkpoint = { generation: 'legacy', offset: count, size: count, mtimeMs: 1, boundaryHash: '', valid: true };
    await model.apply({ source: SCOPE, progress: { batchStart: 0, offset: count, ordinal: count }, records: Array.from({ length: count }, (_, time) => record(time)), publish: { start: 0, checkpoint, journalSize: count } });
    await catalog();
    const original = await model.query(query);
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals();
    const { DatabaseSync } = await import('node:sqlite');
    let database = new DatabaseSync(join(home, 'cache/usage-read-model-v2/index.sqlite'));
    database.exec('DROP TABLE source_hour_total_v1; DROP TABLE source_hour_head_v1'); database.close();
    open();
    await catalog();
    database = new DatabaseSync(join(home, 'cache/usage-read-model-v2/index.sqlite'), { readOnly: true });
    expect(database.prepare('SELECT ordinal FROM source_hour_head_v1 WHERE source=?').get(SCOPE)?.['ordinal']).toBe(32768); database.close();
    const follower = new TestInstantiationService();
    follower.stub(IBootstrapService, stubBootstrap(home)); follower.stub(ILogService, stubLog());
    follower.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
    const readOnly = follower.get(IUsageReadModel);
    try { expect(await readOnly.query(query)).toEqual(original); }
    finally { await readOnly.close(); await follower.dispose(); }
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals();
    const { UsageDatabase } = await import('#/persistence/backends/sqlite/usageDatabase');
    let checks = 0;
    const interrupted = new UsageDatabase(join(home, 'cache/usage-read-model-v2/index.sqlite'), true, () => { if (++checks === 3) throw new Error('cancel migration'); });
    try { expect(() => interrupted.execute({ type: 'maintain' })).toThrow('cancel migration'); }
    finally { interrupted.execute({ type: 'close' }); }
    database = new DatabaseSync(join(home, 'cache/usage-read-model-v2/index.sqlite'), { readOnly: true });
    expect(database.prepare('SELECT ordinal FROM source_hour_head_v1 WHERE source=?').get(SCOPE)?.['ordinal']).toBe(32768); database.close();
    open();
    const rebuilt = await model.query(query);
    expect(rebuilt.revision).not.toBe(original.revision);
    expect({ ...rebuilt, revision: original.revision }).toEqual(original);
    await expect(model.query({ ...query, expectedRevision: original.revision })).rejects.toMatchObject({ code: 'usage.revision_changed' });
    database = new DatabaseSync(join(home, 'cache/usage-read-model-v2/index.sqlite'), { readOnly: true });
    expect(database.prepare('SELECT sum(record_count) AS records FROM source_hour_total_v1 WHERE source=?').get(SCOPE)?.['records']).toBe(count);
    expect(database.prepare('PRAGMA user_version').get()?.['user_version']).toBe(2); database.close();
  }, 15000);

  it('keeps fractional tokens on the fact path instead of rounding an hourly aggregate', async () => {
    for (const value of [record(1, 0.1), record(2, 0.2), record(3, 0.3)]) logs.append(SCOPE, 'wire.jsonl', value);
    await logs.flush(); await catalog();
    const result = await model.query(query);
    expect(result.total).toMatchObject({ usage: usage(0.6), knownRecords: 3 });
    expect(result.total.cost).toBeCloseTo(0.06, 12);
  });

  it('retains finite known costs in total, bucket and session results when record costs overflow', async () => {
    logs.append(SCOPE, 'wire.jsonl', record(1, 1));
    logs.append(SCOPE, 'wire.jsonl', record(2, 1));
    await logs.flush(); await catalog();
    const result = await model.query({ ...query, quotes: [{ model: 'example', inputOther: 1e308 }] });
    expect(result.total).toMatchObject({ cost: 1e308, costUnknown: true, knownRecords: 2, usage: usage(2) });
    expect(result.trend[0]?.groups[0]).toMatchObject({ cost: 1e308, costUnknown: true });
    expect(result.sessions[0]).toMatchObject({ cost: 1e308, costUnknown: true });
    expect(await model.models()).toEqual(['example']);
  });

  it('keeps staged facts invisible and resumes a large batch across budgets and process restart', async () => {
    const checkpoint = { generation: 'legacy', offset: 100, size: 100, mtimeMs: 1, boundaryHash: '', valid: true };
    const records = Array.from({ length: 1200 }, (_, time) => ({ ...record(time), sourceAgentId: 'main' }));
    const { createHash } = await import('node:crypto');
    const directory = `cache/usage-facts-v1/${createHash('sha256').update(SCOPE).digest('hex')}`;
    await storage.write(directory, 'facts.jsonl', Buffer.from(`${JSON.stringify({ version: 1, start: 0, checkpoint, records })}\n`));
    const first = await facts.summary(SCOPE, undefined, { budget: { remainingRecords: 100 } });
    expect(first.readComplete).toBe(false);
    expect((await model.summary(SCOPE)).totals).toBeUndefined();
    const progress = await model.progress(SCOPE);
    expect(progress?.ordinal).toBeGreaterThan(0);
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); open();
    let result = await facts.summary(SCOPE, undefined, { budget: { remainingRecords: 100 } });
    expect((await model.progress(SCOPE))!.offset).toBeGreaterThan(progress!.offset);
    for (let count = 0; result.readComplete === false && count < 20; count++) result = await facts.summary(SCOPE, undefined, { budget: { remainingRecords: 100 } });
    expect(result.readComplete).not.toBe(false);
    expect(result.totals?.knownUsageRecords).toBe(1200);
    expect((await facts.read(SCOPE)).records).toHaveLength(1200);
  });

  it('publishes managed rewrite as one generation and invalidates version-bound query pages', async () => {
    logs.append(SCOPE, 'wire.jsonl', record(1)); await logs.flush(); await catalog();
    const old = await model.query(query);
    await logs.rewrite(SCOPE, 'wire.jsonl', [record(2, 7)]);
    const changed = await model.query(query);
    expect(changed.total.usage.inputOther).toBe(7);
    expect(changed.revision).not.toBe(old.revision);
    await expect(model.query({ ...query, expectedRevision: old.revision })).rejects.toMatchObject({ code: 'usage.revision_changed' });
  });

  it('continues retained transactions across a smaller budget and restart without publishing uncommitted payload', async () => {
    const key = 'deleted-sessions-v2.jsonl';
    logs.append('store', key, { kind: 'session', version: 1, id: 'deleted', workspaceId: 'example', recordCount: 3 });
    logs.append('store', key, { kind: 'meta', createdAt: 0, updatedAt: 1, archived: false, deleted: true, deletedAt: 2, complete: true });
    for (let time = 1; time <= 3; time++) logs.append('store', key, { kind: 'record', record: record(time) });
    logs.append('store', key, { kind: 'commit' });
    await logs.flush();
    const budget = { deadlineAt: Date.now() + 10000, recordLimit: 3 };
    const first = await ix.get(IRetainedUsageService).listDeletedSessions(budget);
    expect(first).toMatchObject({ complete: false, items: [], scannedRecords: 3 });
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); open();
    let result = await ix.get(IRetainedUsageService).listDeletedSessions(budget);
    for (let attempt = 0; !result.complete && attempt < 3; attempt++) result = await ix.get(IRetainedUsageService).listDeletedSessions(budget);
    expect(result.complete).toBe(true);
    expect(result.items[0]?.records).toHaveLength(3);
    expect((await model.query(query)).total).toMatchObject({ cost: 3, knownRecords: 3 });
  });

  it('retires a replaced retained ledger and rejects mismatched ephemeral commits', async () => {
    const key = 'ephemeral-totals-v1.jsonl';
    const service = ix.get(IRetainedUsageService);
    const budget = { deadlineAt: Date.now() + 10000, recordLimit: 100 };
    const payload = { kind: 'record', record: { ...record(1), workspaceId: 'example' } };
    for (const value of [{ kind: 'source', sourceId: 'first', recordCount: 1 }, payload, { kind: 'commit', sourceId: 'first' }]) logs.append('store', key, value);
    await logs.flush();
    expect((await service.listEphemeralUsage!(budget)).items).toHaveLength(1);
    expect((await model.query(query)).total.knownRecords).toBe(1);
    await logs.rewrite('store', key, [{ kind: 'source', sourceId: 'second', recordCount: 1 }, payload, { kind: 'commit', sourceId: 'wrong' }]);
    const failed = await service.listEphemeralUsage!(budget);
    expect(failed.complete).toBe(false);
    expect((await model.query(query)).total.knownRecords).toBe(1);
    await logs.rewrite('store', key, []);
    expect(await service.listEphemeralUsage!(budget)).toMatchObject({ items: [], complete: true });
    expect((await model.query(query)).total.knownRecords).toBe(0);
  });

  it('publishes an initial committed prefix with incomplete coverage and resumes it after restart', async () => {
    const checkpoint = { generation: 'first', offset: 5, size: 10, mtimeMs: 1, boundaryHash: '', valid: true };
    await model.apply({ source: SCOPE, progress: { batchStart: 0, offset: 50, ordinal: 1 }, records: [record(1, 10)], publish: { start: 0, checkpoint, journalSize: 100 } });
    await catalog();
    expect((await model.source(SCOPE))?.pendingCheckpoint).toBeUndefined();
    expect((await model.query(query))).toMatchObject({ total: { usage: usage(10), knownRecords: 1 }, incompleteSessions: 1 });
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); open();
    await model.apply({ source: SCOPE, progress: { batchStart: 50, offset: 100, ordinal: 1 }, records: [record(2, 7)], publish: { start: 5, checkpoint: { ...checkpoint, offset: 10 }, journalSize: 100 } });
    expect((await model.query(query))).toMatchObject({ total: { usage: usage(17), knownRecords: 2 }, incompleteSessions: 0 });
  });

  it('keeps the previous generation visible until a multi-envelope rewrite completes after restart', async () => {
    const publish = (generation: string, offset: number) => ({ generation, offset, size: 10, mtimeMs: 1, boundaryHash: '', valid: true });
    await model.apply({ source: SCOPE, progress: { batchStart: 0, offset: 50, ordinal: 1 }, records: [record(1, 10)], publish: { start: 0, checkpoint: publish('old', 10), journalSize: 50 } });
    await catalog();
    await model.apply({ source: SCOPE, progress: { batchStart: 50, offset: 100, ordinal: 1 }, records: [record(2, 7)], publish: { start: 0, checkpoint: publish('new', 5), journalSize: 150 } });
    expect((await model.source(SCOPE))?.pendingCheckpoint?.offset).toBe(5);
    expect((await model.query(query)).total.usage.inputOther).toBe(10);
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); open();
    await model.apply({ source: SCOPE, progress: { batchStart: 100, offset: 150, ordinal: 1 }, records: [record(3, 8)], publish: { start: 5, checkpoint: publish('new', 10), journalSize: 150 } });
    expect((await model.source(SCOPE))?.pendingCheckpoint).toBeUndefined();
    expect((await model.query(query)).total).toMatchObject({ usage: usage(15), knownRecords: 2 });
  });

  it('separates known subtotals, explicit unknown nonzero, legacy zero and genuine known zero', async () => {
    for (const value of [record(1, 10), { ...record(2, 7), usageKnown: false }, { ...record(3, 0), usageKnown: undefined }, record(4, 0)]) logs.append(SCOPE, 'wire.jsonl', value);
    await logs.flush(); await catalog();
    const result = await model.query(query);
    expect(result.total).toEqual({ usage: usage(10), cost: 1, costUnknown: true, knownRecords: 2, missingRecords: 1, legacyZeroRecords: 1 });
    expect(result.unknownPriceModels).toEqual([]);
    expect(result.sessions[0]?.unknownPriceModels).toEqual([]);
    expect((await facts.summary(SCOPE)).totals).toMatchObject({ version: 2, records: 4, knownUsageRecords: 2, partial: true, usage: usage(10) });
  });

  it('admits a read-only follower without allowing it to mutate the elected writer', async () => {
    logs.append(SCOPE, 'wire.jsonl', record(1)); await logs.flush(); await catalog();
    const follower = new TestInstantiationService();
    follower.stub(IBootstrapService, stubBootstrap(home)); follower.stub(ILogService, stubLog());
    follower.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel));
    const other = follower.get(IUsageReadModel);
    try {
      expect((await other.query(query)).total.knownRecords).toBe(1);
      await expect(other.catalog([], [], true)).rejects.toMatchObject({ code: 'usage.read_only', committed: false });
      const controller = new AbortController(); controller.abort(new Error('cancel read'));
      await expect(other.query(query, controller.signal)).rejects.toThrow('cancel read');
      logs.append(SCOPE, 'wire.jsonl', record(2)); await logs.flush();
      expect((await other.query(query)).total.knownRecords).toBe(2);
    } finally { await other.close(); await follower.dispose(); }
  });

  it('reopens a dead writer and refuses a database from a newer schema without changing canonical data', async () => {
    logs.append(SCOPE, 'wire.jsonl', record(1)); await logs.flush(); await catalog();
    const writer = Reflect.get(model, 'writer');
    await Reflect.get(writer, 'worker').terminate();
    logs.append(SCOPE, 'wire.jsonl', record(2)); await logs.flush();
    expect((await model.query(query)).total.knownRecords).toBe(2);
    const wire = await storage.read(SCOPE, 'wire.jsonl');
    await model.close(); await ix.dispose(); await drainQueryStoreDisposals();
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(home, 'cache/usage-read-model-v2/index.sqlite'));
    database.exec('PRAGMA user_version=99'); database.close(); open();
    await expect(model.sources()).rejects.toThrow('Unsupported Usage read-model schema');
    expect(await storage.read(SCOPE, 'wire.jsonl')).toEqual(wire);
  });

  it('reconciles repeated staged publications instead of counting them twice', async () => {
    const checkpoint = { generation: 'one', offset: 10, size: 10, mtimeMs: 1, boundaryHash: '', valid: true };
    const page = { source: SCOPE, progress: { batchStart: 0, offset: 50, ordinal: 1 }, records: [record(1)], publish: { start: 0, checkpoint, journalSize: 50 } };
    expect(await model.apply(page)).toBe(true);
    expect(await model.apply({ ...page, progress: { ...page.progress, batchStart: 50, offset: 100 }, publish: { start: 0, checkpoint, journalSize: 100 } })).toBe(true);
    expect((await model.summary(SCOPE)).totals?.records).toBe(1);
    const expected = { batchStart: 100, offset: 110, ordinal: 1 };
    expect(await model.apply({ source: SCOPE, progress: expected, records: [record(2)] })).toBe(true);
    expect(await model.apply({ source: SCOPE, progress: expected, records: [record(2)] })).toBe(false);
  });
});

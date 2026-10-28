import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import type { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { SqliteQueryStore, SQLITE_QUERY_STORE_SUBDIR, configureQueryStoreWorkerRuntime } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
import { stubBootstrap } from '../../../app/bootstrap/stubs';
import { stubLog } from '../../../_base/log/stubs';

describe('SqliteQueryStore', () => {
  let home: string;
  const containers: TestInstantiationService[] = [];
  function open(): IQueryStore {
    const ix = new TestInstantiationService();
    containers.push(ix);
    ix.stub(IBootstrapService, stubBootstrap(home)); ix.stub(ILogService, stubLog());
    ix.set(IQueryStore, new SyncDescriptor(SqliteQueryStore));
    return ix.get(IQueryStore);
  }
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'sqlite-qs-')); });
  afterEach(async () => { for (const ix of containers.splice(0)) await ix.dispose(); await drainQueryStoreDisposals(); await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

  it('persists CRUD, checkpoints and atomic rollback across reopen', async () => {
    const store = open();
    await store.put('a', 'x', { value: 1 }, { columns: { time: 10 } });
    await store.setCheckpoint('source', { seq: 3 });
    await expect(store.batch([
      { kind: 'put', collection: 'a', key: 'x', value: { value: 2 } },
      { kind: 'put', collection: 'a', key: 'bad', value: {}, columns: { time: Infinity } },
    ])).rejects.toThrow('finite');
    expect(await store.get('a', 'x')).toEqual({ value: 1 });
    expect(await store.get('a', 'bad')).toBeUndefined();
    await store.close();
    const peer = open();
    expect(await peer.get('a', 'x')).toEqual({ value: 1 });
    expect(await peer.getCheckpoint('source')).toEqual({ seq: 3 });
    expect(await readFile(join(home, 'cache', SQLITE_QUERY_STORE_SUBDIR, 'index.sqlite')).then((bytes) => bytes.subarray(0, 16).toString())).toBe('SQLite format 3\0');
    await peer.delete('a', 'x'); expect(await peer.getMany('a', ['x', 'bad'])).toEqual(new Map());
  });

  it('applies collection before column bounds, filter, ordering and limit', async () => {
    const store = open();
    const ops: WriteOp[] = [];
    for (const collection of ['other', 'target']) for (let id = 0; id < 20; id++) ops.push({ kind: 'put', collection, key: String(id), value: { collection, id, eligible: id % 2 === 0 }, columns: { turnId: id } });
    await store.batch(ops);
    const result = await store.pageByColumn<{ collection: string; id: number }>('target', { column: 'turnId', dir: 'desc', bounds: { lt: 18 }, filter: { eligible: true }, limit: 3 });
    expect(result.items.map((row) => [row.collection, row.id])).toEqual([['target', 16], ['target', 14], ['target', 12]]);
    await store.dropCollection('other'); expect(await store.listKeys('other')).toEqual([]);
    expect(await store.listKeys('target')).toHaveLength(20);
  });

  it('keeps JSON missing/null, nested arrays, logical filters and stable sorting', async () => {
    const store = open();
    await store.batch([
      { kind: 'put', collection: 'a', key: '1', value: { id: 1, n: 3, value: null, nested: [{ name: 'alpha' }] } },
      { kind: 'put', collection: 'a', key: '2', value: { id: 2, n: 1, nested: [{ name: 'beta' }] } },
      { kind: 'put', collection: 'a', key: '3', value: { id: 3, n: 2, value: 0 } },
    ]);
    expect((await store.query('a').where({ value: null }).execute()).items).toHaveLength(1);
    expect((await store.query('a').where({ value: { $exists: false } }).execute()).items).toEqual([expect.objectContaining({ id: 2 })]);
    expect((await store.query('a').where({ value: { $eq: undefined } }).execute()).items).toEqual([expect.objectContaining({ id: 2 })]);
    expect((await store.query('a').where({ $or: [{ 'nested[0].name': 'alpha' }, { n: { $gte: 2 } }] }).orderBy('n').execute()).items).toEqual([expect.objectContaining({ id: 3 }), expect.objectContaining({ id: 1 })]);
    const first = await store.query<{ id: number }>('a').orderBy('n').limit(2).execute();
    expect(first.items.map((row) => row.id)).toEqual([2, 3]); expect(first.nextCursor).toBeDefined();
    expect((await store.query<{ id: number }>('a').orderBy('n').limit(2).cursor(first.nextCursor).execute()).items.map((row) => row.id)).toEqual([1]);
    await expect(store.query('a').limit(2).cursor('2').execute()).rejects.toThrow();
  });

  it('enforces value/compound definitions and rolls unique violations back', async () => {
    const store = open();
    await store.ensureIndex('a', { kind: 'value', name: 'unique', field: 'id', unique: true });
    await store.ensureIndex('a', { kind: 'compound', name: 'group', groupBy: 'group', orderBy: 'time' });
    await store.put('a', '1', { id: 'id', group: 'x', time: 1 });
    await expect(store.put('a', '2', { id: 'id', group: 'x', time: 2 })).rejects.toThrow('UNIQUE');
    expect(await store.get('a', '2')).toBeUndefined();
    await store.put('b', '2', { id: 'id' });
    await expect(store.ensureIndex('a', { kind: 'text', name: 'text' })).rejects.toThrow('structural');
    await store.recover!();
    expect((await store.query('a').where({ group: 'x' }).execute()).items).toHaveLength(1);
  });

  it('retires definitions and physical indexes across 84 session generations and reopen', async () => {
    const store = open();
    await store.put('other', 'preserved', { custom: { parent_session_id: 'parent' } });
    const database = new DatabaseSync(join(home, 'cache', SQLITE_QUERY_STORE_SUBDIR, 'index.sqlite'), { readOnly: true });
    const counts = () => [database.prepare('SELECT count(*) AS n FROM definitions').get()!['n'],
      database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name GLOB 'query_value_*'").get()!['n']];
    try {
      for (let generation = 1; generation <= 84; generation++) {
        const collection = `session:v4:g${generation}`;
        await store.ensureIndex(collection, { kind: 'value', name: 'byParent', field: 'custom.parent_session_id' });
        await store.put(collection, 'child', { custom: { parent_session_id: 'parent' } });
        if (generation > 1) await store.dropCollection(`session:v4:g${generation - 1}`);
        expect(counts()).toEqual([1, 1]);
        expect(await store.query(collection).where({ 'custom.parent_session_id': 'parent' }).execute()).toMatchObject({ items: [{ custom: { parent_session_id: 'parent' } }] });
      }
      await store.dropCollection('session:v4:g84');
      expect(counts()).toEqual([0, 0]);
      await store.close();
      const reopened = open();
      expect(await reopened.get('other', 'preserved')).toEqual({ custom: { parent_session_id: 'parent' } });
      expect(counts()).toEqual([0, 0]);
    } finally { database.close(); }
  }, 20_000);

  it('reuses fixed statements through CAS, rollback, columns, staging and a new connection', async () => {
    const entry = new URL('../../../../src/persistence/backends/sqlite/entry.ts', import.meta.url);
    const wrapper = join(home, 'prepared-statements.mjs');
    const fixed = [
      'SELECT json FROM rows WHERE collection=? AND key=?',
      'INSERT INTO rows VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET json=excluded.json',
      'DELETE FROM rows WHERE collection=? AND key=?',
      'DELETE FROM columns WHERE collection=? AND key=?',
      'INSERT INTO columns VALUES(?,?,?,?)',
    ];
    await writeFile(wrapper, `
      import {DatabaseSync} from 'node:sqlite'; import {parentPort as port} from 'node:worker_threads';
      const fixed=new Set(${JSON.stringify(fixed)}), counts={};
      const prepare=DatabaseSync.prototype.prepare, post=port.postMessage.bind(port);
      DatabaseSync.prototype.prepare=function(sql) { if(fixed.has(sql)) counts[sql]=(counts[sql]??0)+1; return prepare.call(this,sql); };
      port.postMessage=response=>post({...response,prepared:counts});
      await import(${JSON.stringify(entry.href)});
    `);
    configureQueryStoreWorkerRuntime(wrapper);
    try {
      const store = open();
      await store.put('prepared', 'head', { revision: 0 });
      const host = Reflect.get(store, 'worker') as object;
      const thread = Reflect.get(host, 'worker') as Worker;
      let prepared: Record<string, number> = {};
      thread.on('message', (message: { prepared?: Record<string, number> }) => { if (message.prepared !== undefined) prepared = message.prepared; });
      await store.ensureIndex('prepared', { kind: 'value', name: 'byId', field: 'id', unique: true });
      for (let revision = 1; revision <= 3; revision++) {
        const ops: WriteOp[] = [
          { kind: 'put', collection: 'prepared', key: 'head', value: { revision } },
          { kind: 'put', collection: 'prepared', key: 'row', value: { id: 'row', time: revision }, columns: { time: revision } },
        ];
        expect(await store.batchIf!([{ collection: 'prepared', key: 'head', value: { revision: revision - 1 } }], ops)).toBe(true);
        expect(await store.batchIf!([{ collection: 'prepared', key: 'head', value: { revision: revision - 1 } }], ops)).toBe(false);
        expect((await store.pageByColumn('prepared', { column: 'time', bounds: { gte: revision }, limit: 10 })).items).toEqual([{ id: 'row', time: revision }]);
      }
      await expect(store.batch([
        { kind: 'delete', collection: 'prepared', key: 'row' },
        { kind: 'put', collection: 'prepared', key: 'bad', value: { id: 'bad' }, columns: { time: Infinity } },
      ])).rejects.toThrow('finite');
      expect(await store.get('prepared', 'row')).toEqual({ id: 'row', time: 3 });
      await store.put('prepared', 'row', { id: 'row', time: 4 });
      expect((await store.pageByColumn('prepared', { column: 'time', limit: 10 })).items).toEqual([]);
      await store.delete('prepared', 'row');
      expect(await store.get('prepared', 'row')).toBeUndefined();
      for (const replace of [false, true]) {
        await store.put('stage:prepared', 'staged', { id: 'staged', time: 5 }, { columns: { time: 5 } });
        expect(await store.batchIf!([{ collection: 'prepared', key: 'head', value: replace ? undefined : { revision: 3 } }], [], { source: 'stage:prepared', collection: 'prepared', replace })).toBe(!replace);
        if (replace) expect(await store.batchIf!([{ collection: 'prepared', key: 'head', value: { revision: 3 } }], [], { source: 'stage:prepared', collection: 'prepared', replace })).toBe(true);
        expect(await store.listKeys('stage:prepared')).toEqual([]);
        expect((await store.pageByColumn('prepared', { column: 'time', limit: 10 })).items).toEqual([{ id: 'staged', time: 5 }]);
      }
      expect(fixed.map((sql) => prepared[sql])).toEqual([1, 1, 1, 1, 1]);
      await store.close();
      expect(thread.threadId).toBe(-1);
      const reopened = open();
      await reopened.put('prepared', 'head', { revision: 4 });
      const reopenedThread = Reflect.get(Reflect.get(reopened, 'worker') as object, 'worker') as Worker;
      expect(reopenedThread).not.toBe(thread);
      reopenedThread.on('message', (message: { prepared?: Record<string, number> }) => { if (message.prepared !== undefined) prepared = message.prepared; });
      expect(await reopened.get('prepared', 'head')).toEqual({ revision: 4 });
      expect(fixed.map((sql) => prepared[sql])).toEqual([1, 1, 1, 1, 1]);
    } finally { configureQueryStoreWorkerRuntime(fileURLToPath(entry)); }
  });

  it('publishes stage and head atomically with two connections and rejects stale CAS', async () => {
    const first = open(), peer = open();
    await first.put('facts', 'head', { offset: 1 });
    await first.put('facts', 'old', { time: 1 }, { columns: { time: 1 } });
    await first.put('stage:owned', 'new', { time: 2 }, { columns: { time: 2 } });
    expect(await peer.listKeys('facts')).toEqual(['head', 'old']);
    expect(await peer.batchIf!([{ collection: 'facts', key: 'head', value: { offset: 0 } }], [{ kind: 'put', collection: 'facts', key: 'head', value: { offset: 3 } }], { source: 'stage:owned', collection: 'facts', replace: true })).toBe(false);
    expect(await first.listKeys('stage:owned')).toEqual(['new']);
    expect(await first.batchIf!([{ collection: 'facts', key: 'head', value: { offset: 1 } }], [{ kind: 'put', collection: 'facts', key: 'head', value: { offset: 2 } }], { source: 'stage:owned', collection: 'facts', replace: true })).toBe(true);
    expect(await peer.listKeys('facts')).toEqual(['head', 'new']);
    expect((await peer.pageByColumn('facts', { column: 'time', limit: 3 })).items).toEqual([{ time: 2 }]);
    expect(await peer.get('facts', 'head')).toEqual({ offset: 2 });
    const won = await Promise.all([first, peer].map((store, index) => store.batchIf!([{ collection: 'facts', key: 'head', value: { offset: 2 } }], [{ kind: 'put', collection: 'facts', key: 'head', value: { offset: 3 + index } }])));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('cancels queued reads without cancelling writes and drains close before reopening', async () => {
    const store = open();
    const write = store.batch(Array.from({ length: 2000 }, (_, id) => ({ kind: 'put', collection: 'a', key: String(id), value: { id } })));
    const abort = new AbortController();
    const read = store.query('a').limit(10).execute(abort.signal);
    abort.abort();
    await expect(read).rejects.toThrow();
    await write;
    await store.close();
    const peer = open(); expect(await peer.listKeys('a')).toHaveLength(2000);
    await expect(store.get('a', '1')).rejects.toThrow('closed');
  });

  it('interrupts an active worker read and keeps the connection usable', async () => {
    const store = open();
    await store.batch(Array.from({ length: 20_000 }, (_, id) => ({ kind: 'put', collection: 'a', key: String(id), value: { id, text: 'x'.repeat(256) } })));
    const abort = new AbortController();
    const read = store.query('a').where({ id: { $gte: 0 } }).execute(abort.signal);
    const rejected = expect(read).rejects.toMatchObject({ message: 'Query store read cancelled' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const host = Reflect.get(store, 'worker') as object;
    expect(Reflect.get(host, 'active')).toBeDefined();
    abort.abort();
    await rejected;
    expect(await store.get('a', '19999')).toEqual({ id: 19999, text: 'x'.repeat(256) });
  });

  it('rejects a crashed worker write and reconciles its atomic outcome after recovery', async () => {
    const store = open();
    await store.put('a', 'head', { offset: 0 });
    const write = store.batch([
      ...Array.from({ length: 20_000 }, (_, id): WriteOp => ({ kind: 'put', collection: 'a', key: String(id), value: { id } })),
      { kind: 'put', collection: 'a', key: 'head', value: { offset: 20_000 } },
    ]);
    const rejected = expect(write).rejects.toMatchObject({ message: expect.stringMatching(/worker exited.*write outcome must be reconciled/), committed: undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const host = Reflect.get(store, 'worker') as object;
    expect(Reflect.get(host, 'active')).toBeDefined();
    await (Reflect.get(host, 'worker') as Worker).terminate();
    await rejected;
    const head = await store.get<{ offset: number }>('a', 'head');
    expect([0, 20_000]).toContain(head?.offset);
    const keys = await store.listKeys('a');
    expect(keys).toHaveLength(head!.offset + 1);
    expect(await store.get('a', '19999')).toEqual(head?.offset === 0 ? undefined : { id: 19999 });
  });

  it('serializes conditional commits across real OS processes without head rollback', async () => {
    const store = open();
    await store.put('source', 'head', { offset: 0 });
    const entry = fileURLToPath(new URL('../../../../src/persistence/backends/sqlite/entry.ts', import.meta.url));
    const script = `import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL(process.argv[2]), { workerData: { database: process.argv[1] }, execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'] });
      let id = 0;
      const call = (operation) => new Promise((resolve, reject) => { const serial = ++id; const receive = (message) => { if(message.id !== serial) return; worker.off('message', receive); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }; worker.on('message', receive); worker.postMessage({id:serial,operation}); });
      try { const result = await call({type:'batch',conditions:[{collection:'source',key:'head',value:{offset:0}}],ops:[{kind:'put',collection:'source',key:'head',value:{offset:Number(process.argv[3])}},{kind:'put',collection:'source',key:'row',value:{offset:Number(process.argv[3])}}]}); console.log(JSON.stringify(result)); await call({type:'close'}); } catch(error) { await worker.terminate(); throw error; }`;
    const database = join(home, 'cache', SQLITE_QUERY_STORE_SUBDIR, 'index.sqlite');
    const url = new URL(`file:///${entry.replaceAll('\\', '/')}`).href;
    const run = promisify(execFile);
    const results = await Promise.all([1, 2].map((offset) => run(process.execPath, ['--input-type=module', '--eval', script, database, url, String(offset)], { timeout: 10_000 })));
    expect(results.map((result) => JSON.parse(result.stdout.trim())).filter(Boolean)).toHaveLength(1);
    const head = await store.get('source', 'head'); expect(await store.get('source', 'row')).toEqual(head);
    expect(await store.batchIf!([{ collection: 'source', key: 'head', value: { offset: 0 } }], [{ kind: 'put', collection: 'source', key: 'head', value: { offset: -1 } }])).toBe(false);
  });

  it.each(['where', 'sort'] as const)('interrupts SQL %s work before it produces result rows', async (phase) => {
    const entry = new URL('../../../../src/persistence/backends/sqlite/entry.ts', import.meta.url);
    const wrapper = join(home, 'sql-phase.mjs');
    const target = phase === 'where' ? 'kiki_value' : 'kiki_order';
    await writeFile(wrapper, `
      import {DatabaseSync} from 'node:sqlite'; import {parentPort as port} from 'node:worker_threads';
      let cancellation, visits=0; const post=port.postMessage.bind(port);
      port.on('message', request => { cancellation=request.cancellation && new Int32Array(request.cancellation); visits=0; });
      port.postMessage = response => { post({visits}); return post(response); };
      const register=DatabaseSync.prototype.function;
      DatabaseSync.prototype.function = function(name,...args) {
        const callback=args.pop();
        const call=values => {
          if(name===${JSON.stringify(target)} && ++visits===1) {
            post({phase:name});
            while(Atomics.load(cancellation,0)===0) Atomics.wait(cancellation,0,0,1000);
          }
          return callback(...values);
        };
        const wrapped=callback.length===1 ? value=>call([value]) : (value,path)=>call([value,path]);
        return Reflect.apply(register,this,[name,...args,wrapped]);
      };
      await import(${JSON.stringify(entry.href)});
    `);
    configureQueryStoreWorkerRuntime(wrapper);
    try {
      const store = open();
      await store.batch(Array.from({ length: 1000 }, (_, id) => ({ kind: 'put', collection: 'sql-cancel', key: String(id), value: { id: 1000 - id, eligible: false } })));
      const controller = new AbortController();
      const host = Reflect.get(store, 'worker') as object;
      const thread = Reflect.get(host, 'worker') as Worker;
      let visits = 0;
      const reached = new Promise<void>((resolve) => { thread.on('message', (message: { phase?: string; visits?: number }) => {
        if (message.phase === target) resolve();
        if (message.visits !== undefined) visits = message.visits;
      }); });
      const selection = phase === 'where' ? store.query('sql-cancel').where({ eligible: true }) : store.query('sql-cancel').orderBy('id').limit(1);
      const reading = selection.execute(controller.signal);
      const rejected = expect(reading).rejects.toMatchObject({ code: 'ABORT_ERR' });
      await reached;
      controller.abort();
      Atomics.notify((Reflect.get(host, 'active') as { cancellation: Int32Array }).cancellation, 0);
      await rejected;
      expect(visits).toBe(1);
      expect(await store.get('sql-cancel', '0')).toMatchObject({ eligible: false });
    } finally { configureQueryStoreWorkerRuntime(fileURLToPath(entry)); }
  });

  it.each(['close', 'recover'] as const)('drains an exactly full waiting queue during %s and awaits worker exit', async (action) => {
    const store = open();
    await store.put('queue', 'head', { ready: true });
    const write = store.batch(Array.from({ length: 20_000 }, (_, id) => ({ kind: 'put', collection: 'queue', key: String(id), value: { id } })));
    const queued = Array.from({ length: 128 }, (_, id) => store.get('queue', String(id)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const host = Reflect.get(store, 'worker') as object;
    const thread = Reflect.get(host, 'worker') as Worker;
    expect(Reflect.get(host, 'waiting')).toHaveLength(128);
    await expect(store.get('queue', 'overflow')).rejects.toThrow('queue full');
    const retiring = action === 'close' ? store.close() : store.recover!();
    expect(Reflect.get(store, 'worker')).toBe(host);
    await Promise.all([write, ...queued, retiring]);
    expect(thread.threadId).toBe(-1);
    expect(Reflect.get(store, 'worker')).toBeUndefined();
    const next = action === 'close' ? open() : store;
    expect(await next.get('queue', '19999')).toEqual({ id: 19999 });
  });

  it('reclaims a killed process staging pair on reopen while a real peer resumes its paused fact build', async () => {
    const script = join(home, 'staging-owner.mts');
    const loader = new URL('../../../../../../build/register-raw-text-loader.mjs', import.meta.url).href;
    const module = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
    await writeFile(script, `
      import { SyncDescriptor } from ${module('../../../../src/_base/di/descriptors.ts')};
      import { TestInstantiationService } from ${module('../../../../src/_base/di/test.ts')};
      import { IBootstrapService } from ${module('../../../../src/app/bootstrap/bootstrap.ts')};
      import { ILogService } from ${module('../../../../src/_base/log/log.ts')};
      import { IQueryStore } from ${module('../../../../src/persistence/interface/queryStore.ts')};
      import { IFileSystemStorageService } from ${module('../../../../src/persistence/interface/storage.ts')};
      import { IAppendLogStore } from ${module('../../../../src/persistence/interface/appendLogStore.ts')};
      import { FileStorageService } from ${module('../../../../src/persistence/backends/node-fs/fileStorageService.ts')};
      import { AppendLogStore } from ${module('../../../../src/persistence/backends/node-fs/appendLogStore.ts')};
      import { SqliteQueryStore } from ${module('../../../../src/persistence/backends/sqlite/sqliteQueryStore.ts')};
      import { IUsageFactStore, UsageFactStore } from ${module('../../../../src/app/usageFacts/usageFactStore.ts')};
      import { stubBootstrap } from ${module('../../../app/bootstrap/stubs.ts')};
      import { stubLog } from ${module('../../../_base/log/stubs.ts')};
      const scope = 'sessions/example/session/agents/main';
      const ix = new TestInstantiationService();
      const storage = new FileStorageService(process.argv[2]);
      ix.stub(IBootstrapService, stubBootstrap(process.argv[2])); ix.stub(ILogService, stubLog()); ix.stub(IFileSystemStorageService, storage);
      ix.set(IQueryStore, new SyncDescriptor(SqliteQueryStore)); ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore)); ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
      const facts = ix.get(IUsageFactStore), query = ix.get(IQueryStore);
      if (process.argv[3] === 'seed') await facts.commit(scope, 0, { generation:'legacy', offset:800, size:800, mtimeMs:1, boundaryHash:'', valid:true }, Array.from({length:800}, (_,time) => ({time,model:'example',usageKnown:true,usage:{inputOther:1,output:2,inputCacheRead:0,inputCacheCreation:0}})));
      for (let pass = 0; pass < 10; pass++) {
        await facts.read(scope, undefined, undefined, {budget:{remainingRecords:256}});
        const progress = Reflect.get(facts, 'indexing').get(scope);
        if (progress?.copied > 0) { process.send({type:'ready',stage:progress.stage,publication:progress.publication}); break; }
        if (pass === 9) throw new Error('staging pause not reached');
      }
      process.on('message', async () => {
        try {
          const snapshot = await facts.read(scope);
          process.send({type:'complete',count:snapshot.records.length,output:snapshot.records.reduce((sum,row) => sum+row.usage.output,0)});
          await ix.get(IAppendLogStore).close(); await query.close(); await ix.dispose(); await storage.close(); process.disconnect();
        } catch (error) { process.send({type:'failure',message:String(error.stack)}); process.exit(1); }
      });
    `);
    const children: ChildProcess[] = [];
    function receive(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        const message = (value: Record<string, unknown>) => {
          if (value['type'] === type) { child.off('message', message); child.off('exit', exit); resolve(value); }
          else if (value['type'] === 'failure') reject(new Error(String(value['message'])));
        };
        const exit = (code: number | null) => reject(new Error(`stage child exited ${code}: ${stderr}`));
        child.on('message', message); child.once('exit', exit); child.once('error', reject);
      });
    }
    function start(seed: boolean): ChildProcess {
      const child = fork(script, [home, seed ? 'seed' : 'peer'], {
        execPath: process.execPath, execArgv: ['--import', loader, '--import', 'tsx'],
        env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child); return child;
    }
    try {
      const dead = start(true), abandoned = await receive(dead, 'ready');
      const peer = start(false), paused = await receive(peer, 'ready');
      const exited = once(dead, 'exit'); dead.kill('SIGKILL'); await exited;
      const store = open();
      expect(await store.listKeys(String(abandoned['stage']))).toEqual([]);
      expect(await store.listKeys(String(abandoned['publication']))).toEqual([]);
      expect((await store.listKeys(String(paused['stage']))).length).toBe(800);
      expect((await store.listKeys(String(paused['publication']))).length).toBeGreaterThan(0);
      const completed = receive(peer, 'complete'); peer.send('continue');
      expect(await completed).toMatchObject({ count: 800, output: 1600 });
      await once(peer, 'exit');
      expect(await store.listKeys(String(paused['stage']))).toEqual([]);
      expect(await store.listKeys(String(paused['publication']))).toEqual([]);
      expect((await store.query('__query_staging_v1__').execute()).items).toEqual([]);
    } finally {
      await Promise.all(children.map(async (child) => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }));
    }
  }, 20_000);

  it('surfaces database corruption and leaves canonical and legacy data intact', async () => {
    const directory = join(home, 'cache', SQLITE_QUERY_STORE_SUBDIR);
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.from('invalid derived SQLite database');
    await writeFile(join(directory, 'index.sqlite'), bytes);
    await mkdir(join(home, 'store'), { recursive: true });
    await writeFile(join(home, 'store', 'mailbox-preserved'), 'canonical');
    const store = open();
    await expect(store.get('a', 'missing')).rejects.toThrow(/database|encrypted/i);
    await store.recover!();
    await expect(store.get('a', 'missing')).rejects.toThrow();
    expect(await readFile(join(directory, 'index.sqlite'))).toEqual(bytes);
    expect(await readFile(join(home, 'store', 'mailbox-preserved'), 'utf8')).toBe('canonical');
  });
});

import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getHeapStatistics } from 'node:v8';
import { SqliteSearchIndex, type SqliteSessionInput } from './index';
import { MEMORY_BUDGET_EXIT, type IndexerEvent, type IndexerRequest } from './processProtocol';

const MiB = 1048576;
const report = (event: IndexerEvent): void => { if (process.connected) process.send?.(event); };

export async function runSqliteIndexerCommand(path: string): Promise<void> {
  if (!path || !process.send) throw new Error('indexer requires a database path and IPC channel');
  const hardMb = Number(process.env['KIKI_SEARCH_INDEXER_HARD_MB'] ?? 768);
  const softMb = Number(process.env['KIKI_SEARCH_INDEXER_SOFT_MB'] ?? 384);
  if (!(hardMb > 0 && softMb > 0)) throw new Error('invalid indexer memory budget');
  await mkdir(dirname(path), { recursive: true });
  const lease = new DatabaseSync(`${path}.writer.sqlite`);
  lease.exec('PRAGMA busy_timeout=100');
  let writer = true;
  try { lease.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    if (!/SQLITE_BUSY|database is locked/i.test(String(error))) { lease.close(); throw error; }
    writer = false;
  }
  if (!writer) {
    report({ type: 'ready', pid: process.pid, writer: false });
    const elected = await new Promise<boolean>((resolve) => {
      const heartbeat = setInterval(() => report({ type: 'heartbeat' }), 1000);
      const election = setInterval(() => {
        try { lease.exec('BEGIN IMMEDIATE'); finish(true); }
        catch (error) {
          if (!/SQLITE_BUSY|database is locked/i.test(String(error))) {
            report({ type: 'error', message: String(error) });
            finish(false);
          }
        }
      }, 2000);
      const onMessage = (message: IndexerRequest): void => { if (message.type === 'close') finish(false); };
      const onDisconnect = (): void => finish(false);
      const finish = (won: boolean): void => {
        clearInterval(heartbeat);
        clearInterval(election);
        process.off('message', onMessage);
        process.off('disconnect', onDisconnect);
        resolve(won);
      };
      process.on('message', onMessage);
      process.on('disconnect', onDisconnect);
    });
    if (!elected) { lease.close(); return; }
  }
  let index: SqliteSearchIndex | undefined;
  let pending = new Map<string, SqliteSessionInput>();
  let syncing = false;
  let rebuilding = false;
  let lastDrainError: string | undefined;
  let lastHeartbeat = Date.now();
  let soft = false;
  let nearSoft = false;
  let stopped = false;
  let opened = false;
  let lastBatchMs = 0;
  let lastLogAt = 0;
  let releaseReader: (() => void) | undefined;
  const status = (): void => {
    const memory = process.memoryUsage();
    if (index) {
      const snapshot = index.syncStatus;
      report({ type: 'status', rss: memory.rss, heapUsed: memory.heapUsed,
        external: memory.external, heapLimit: getHeapStatistics().heap_size_limit,
        status: snapshot, pending: pending.size, lastBatchMs,
        dbBytes: statSync(path).size,
        inflight: (index.db.prepare("SELECT v FROM meta WHERE k='inflight'").get() as { v: string } | undefined)?.v });
      if (Date.now() - lastLogAt >= 60_000) {
        lastLogAt = Date.now();
        process.stderr.write(`search indexer status rss=${memory.rss} heap=${memory.heapUsed} wal=${snapshot.walBytes} docs=${snapshot.documents} pending=${pending.size}\n`);
      }
    }
    if (memory.rss > hardMb * MiB) {
      if (index) index.clearInflightOnBudgetExit();
      process.stderr.write(`search indexer memory_budget rss=${memory.rss} limit=${hardMb * MiB}\n`);
      process.exit(MEMORY_BUDGET_EXIT);
    }
    soft = memory.rss > softMb * MiB;
    nearSoft = memory.rss > (softMb - 32) * MiB;
  };
  const drain = async (): Promise<void> => {
    if (syncing || stopped || !index) return;
    syncing = true;
    lastDrainError = undefined;
    try {
      while (pending.size && !stopped) {
        const entry = pending.entries().next().value;
        if (!entry) break;
        const [id, session] = entry;
        pending.delete(id);
        const free = await statfs(path).then((value) => value.bavail * value.bsize).catch(() => Infinity);
        if (free < 2 * 1024 * MiB) {
          report({ type: 'error', message: 'disk_low' });
          pending.set(id, session);
          break;
        }
        const started = Date.now();
        await index.syncSession(session);
        lastBatchMs = Date.now() - started;
        report({ type: 'synced', sessionId: id });
        status();
        const elapsed = lastBatchMs;
        if (pending.size && elapsed > 0) await new Promise((resolve) => setTimeout(resolve, elapsed));
      }
    } catch (error) {
      lastDrainError = error instanceof Error ? error.message : String(error);
      report({ type: 'error', message: lastDrainError });
    } finally { syncing = false; }
  };
  const openOptions = {
    batchMaxDocs: () => nearSoft ? 250 : 500,
    batchMaxChars: () => nearSoft ? 2 * MiB : 4 * MiB,
    afterBatch: async () => {
      status();
      if (nearSoft) index!.db.exec('PRAGMA shrink_memory');
      if (soft) await new Promise((resolve) => setTimeout(resolve, 5000));
    },
  };
  const recover = async (error: unknown): Promise<void> => {
    if (!/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(String(error))) throw error;
    if (opened) {
      const released = new Promise<void>((resolve) => { releaseReader = resolve; });
      report({ type: 'release_reader' });
      await released;
      releaseReader = undefined;
    }
    const suffix = `.corrupt-${Date.now()}`;
    for (const extension of ['', '-wal', '-shm']) {
      try { await rename(`${path}${extension}`, `${path}${suffix}${extension}`); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
    }
    report({ type: 'error', message: 'corrupt_rebuilding' });
    index = await SqliteSearchIndex.open(path, { ...openOptions,
      indexSubagents: process.env['KIKI_SEARCH_INDEX_SUBAGENTS'] === '1' });
    if (opened) report({ type: 'ready', pid: process.pid, writer: true });
  };
  const free = await statfs(dirname(path)).then((value) => value.bavail * value.bsize);
  if (free < 2 * 1024 * MiB) {
    report({ type: 'error', message: 'disk_low' });
    lease.exec('ROLLBACK');
    lease.close();
    throw new Error('disk_low');
  }
  const probeDir = await mkdtemp(join(dirname(path), '.search-selfcheck-'));
  try {
    const probe = new DatabaseSync(join(probeDir, 'probe.sqlite'));
    try {
      probe.exec("CREATE VIRTUAL TABLE probe USING fts5(text, tokenize='trigram')");
      probe.prepare('INSERT INTO probe(text) VALUES(?)').run('search selfcheck');
      if (!probe.prepare("SELECT rowid FROM probe WHERE probe MATCH 'selfcheck'").get())
        throw new Error('sqlite_unavailable: FTS5 selfcheck failed');
    } finally { probe.close(); }
  } catch (error) {
    report({ type: 'error', message: 'sqlite_unavailable' });
    throw error;
  } finally { await rm(probeDir, { recursive: true, force: true }); }
  try { index = await SqliteSearchIndex.open(path, { ...openOptions,
    indexSubagents: process.env['KIKI_SEARCH_INDEX_SUBAGENTS'] === '1' }); }
  catch (error) { await recover(error); }
  index!.db.prepare("INSERT INTO meta(k,v) VALUES('selfcheck','passed') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
  report({ type: 'ready', pid: process.pid, writer: true });
  opened = true;
  status();
  setImmediate(() => {
    if (stopped || !index) return;
    try {
      const check = index.db.prepare('PRAGMA quick_check').get() as { quick_check: string };
      if (check.quick_check !== 'ok') throw new Error(`SQLITE_CORRUPT: ${check.quick_check}`);
    } catch (error) {
      index.close();
      index = undefined;
      void recover(error).then(() => drain()).catch((failure: unknown) => {
        report({ type: 'error', message: String(failure) });
      });
    }
  });
  const timer = setInterval(() => {
    if (Date.now() - lastHeartbeat > 120_000) {
      process.stderr.write('search indexer heartbeat timed out\n');
      process.exit(87);
    }
    status();
    if (pending.size && !syncing && !rebuilding) void drain();
  }, 1000);
  process.on('disconnect', () => process.exit(0));
  await new Promise<void>((resolve) => {
    process.on('message', (message: IndexerRequest) => {
      if (message.type === 'heartbeat') {
        lastHeartbeat = Date.now();
        report({ type: 'heartbeat' });
      } else if (message.type === 'reader_released') {
        releaseReader?.();
      } else if (message.type === 'sync') {
        for (const session of message.sessions.slice(0, 1000)) pending.set(session.id, session);
        if (!rebuilding) void drain();
      } else if (message.type === 'reindex') {
        if (rebuilding) {
          report({ type: 'reindexed', id: message.id, sessions: 0, documents: 0, error: 'reindex already running' });
        } else {
          rebuilding = true;
          void (async () => {
            while (syncing) await new Promise((done) => setTimeout(done, 25));
            if (!index || stopped) throw new Error('indexer stopped during reindex');
            await index.reindex();
            pending = new Map([...message.sessions.map((session) => [session.id, session] as const), ...pending]);
            while (pending.size && !stopped) {
              await drain();
              if (lastDrainError || index.syncStatus.state === 'wal_stuck')
                throw new Error(lastDrainError ?? 'reindex paused at WAL checkpoint');
              if (pending.size) await new Promise((done) => setTimeout(done, 100));
            }
            if (stopped) throw new Error('indexer stopped during reindex');
            const result = index.syncStatus;
            report({ type: 'reindexed', id: message.id, sessions: result.indexedSessions ?? 0,
              documents: result.documents ?? 0 });
          })().catch((error: unknown) => report({ type: 'reindexed', id: message.id, sessions: 0,
            documents: 0, error: error instanceof Error ? error.message : String(error) }))
            .finally(() => { rebuilding = false; if (pending.size && !syncing) void drain(); });
        }
      } else if (message.type === 'close') {
        stopped = true;
        clearInterval(timer);
        if (!syncing && !rebuilding) resolve();
        else {
          const closing = setInterval(() => {
            if (!syncing && !rebuilding) { clearInterval(closing); resolve(); }
          }, 100);
        }
      }
    });
  });
  index?.close();
  lease.exec('ROLLBACK');
  lease.close();
}

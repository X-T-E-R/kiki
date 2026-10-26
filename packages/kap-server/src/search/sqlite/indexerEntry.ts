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
  let stopped = false;
  const noteClose = (message: IndexerRequest): void => { if (message.type === 'close') stopped = true; };
  process.on('message', noteClose);
  await mkdir(dirname(path), { recursive: true });
  if (stopped) return;
  const lease = new DatabaseSync(`${path}.writer.sqlite`, { timeout: 1000 });
  const releaseLease = (): void => {
    try { if (lease.isTransaction) lease.exec('ROLLBACK'); } catch {}
    try { lease.close(); } catch {}
  };
  lease.exec('PRAGMA busy_timeout=100');
  let writer = true;
  try { lease.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    if (!/SQLITE_BUSY|database is locked/i.test(String(error))) { releaseLease(); throw error; }
    writer = false;
  }
  if (stopped) { releaseLease(); return; }
  if (!writer) {
    report({ type: 'ready', pid: process.pid, writer: false });
    const elected = await new Promise<boolean>((resolve) => {
      const heartbeat = setInterval(() => report({ type: 'heartbeat' }), 1000);
      let election: NodeJS.Timeout | undefined;
      let electionDelay = 2000;
      const onMessage = (message: IndexerRequest): void => { if (message.type === 'close') finish(false); };
      const onDisconnect = (): void => finish(false);
      const finish = (won: boolean): void => {
        clearInterval(heartbeat);
        if (election) clearTimeout(election);
        process.off('message', onMessage);
        process.off('disconnect', onDisconnect);
        resolve(won);
      };
      const attemptElection = (): void => {
        try { lease.exec('BEGIN IMMEDIATE'); finish(true); }
        catch (error) {
          if (!/SQLITE_BUSY|database is locked/i.test(String(error))) {
            report({ type: 'error', message: String(error) });
            finish(false);
            return;
          }
          electionDelay = Math.min(electionDelay * 2, 30_000);
          election = setTimeout(attemptElection, electionDelay);
          election.unref();
        }
      };
      process.on('message', onMessage);
      process.on('disconnect', onDisconnect);
      if (stopped) { finish(false); return; }
      election = setTimeout(attemptElection, electionDelay);
      election.unref();
    });
    if (!elected) { releaseLease(); return; }
  }
  let index: SqliteSearchIndex | undefined;
  let pending = new Map<string, { session: SqliteSessionInput; revision: number }>();
  let staging: { revision: number; sessions: Map<string, SqliteSessionInput> } | undefined;
  let inventory: { revision: number; ids: ReadonlySet<string> } | undefined;
  let activeRevision = 0;
  let completedRevision = 0;
  let syncing = false;
  let rebuilding = false;
  let lastDrainError: string | undefined;
  let lastHeartbeat = Date.now();
  let nearSoft = false;
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
      try { index?.clearInflightOnBudgetExit(); } catch {}
      try { index?.close(); } catch {}
      index = undefined;
      releaseLease();
      process.stderr.write(`search indexer memory_budget rss=${memory.rss} limit=${hardMb * MiB}\n`);
      process.exit(MEMORY_BUDGET_EXIT);
    }
    nearSoft = memory.rss > (softMb - 32) * MiB;
  };
  const drain = async (): Promise<void> => {
    if (syncing || stopped || !index) return;
    syncing = true;
    lastDrainError = undefined;
    try {
      while ((pending.size || inventory) && !stopped) {
        if (inventory) {
          const current = inventory;
          if (!await index.reconcileSessions(current.ids)) break;
          if (inventory === current) inventory = undefined;
          status();
          continue;
        }
        const entry = pending.entries().next().value;
        if (!entry) break;
        const [id, work] = entry;
        const free = await statfs(path).then((value) => value.bavail * value.bsize).catch(() => Infinity);
        if (free < 2 * 1024 * MiB) {
          report({ type: 'error', message: 'disk_low' });
          break;
        }
        const started = Date.now();
        await index.syncSession(work.session);
        if (pending.get(id) === work) pending.delete(id);
        lastBatchMs = Date.now() - started;
        const missing = !index.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id);
        report({ type: 'synced', sessionId: id, revision: work.revision, missing });
        status();
        if (pending.size) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!pending.size && !inventory && activeRevision > completedRevision) {
        completedRevision = activeRevision;
        report({ type: 'inventory_synced', revision: completedRevision });
      }
    } catch (error) {
      lastDrainError = error instanceof Error ? error.message : String(error);
      report({ type: 'error', message: lastDrainError });
    } finally { syncing = false; }
  };
  const openOptions = {
    isStopped: () => stopped,
    batchMaxDocs: () => nearSoft ? 250 : 500,
    batchMaxChars: () => nearSoft ? 2 * MiB : 4 * MiB,
    afterBatch: async () => {
      status();
      if (nearSoft) index!.db.exec('PRAGMA shrink_memory');
      await new Promise<void>((resolve) => setImmediate(resolve));
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
  if (stopped) { releaseLease(); return; }
  const free = await statfs(dirname(path)).then((value) => value.bavail * value.bsize);
  if (stopped) { releaseLease(); return; }
  if (free < 2 * 1024 * MiB) {
    report({ type: 'error', message: 'disk_low' });
    releaseLease();
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
    releaseLease();
    throw error;
  } finally { await rm(probeDir, { recursive: true, force: true }); }
  if (stopped) { releaseLease(); return; }
  const opening = SqliteSearchIndex.open(path, { ...openOptions,
    indexSubagents: process.env['KIKI_SEARCH_INDEX_SUBAGENTS'] === '1' });
  let openWatch: ((message: IndexerRequest) => void) | undefined;
  const stopOpening = new Promise<void>((resolve) => {
    if (stopped) { resolve(); return; }
    openWatch = (message: IndexerRequest): void => { if (message.type === 'close') resolve(); };
    process.on('message', openWatch);
  });
  try {
    const opened = await Promise.race([opening, stopOpening.then(() => undefined)]);
    if (opened === undefined || stopped) {
      void opening.then((value) => { try { value.close(); } catch {} }).catch(() => {});
      releaseLease();
      return;
    }
    index = opened;
  } catch (error) {
    try { await recover(error); }
    catch (failure) {
      if (stopped) { releaseLease(); return; }
      if (process.memoryUsage().rss > hardMb * MiB) {
        releaseLease();
        process.stderr.write(`search indexer memory_budget rss=${process.memoryUsage().rss} limit=${hardMb * MiB}\n`);
        process.exit(MEMORY_BUDGET_EXIT);
      }
      releaseLease();
      throw failure;
    }
  } finally { if (openWatch) process.off('message', openWatch); }
  if (stopped || index === undefined) {
    try { index?.close(); } catch {}
    releaseLease();
    return;
  }
  index.db.prepare("INSERT INTO meta(k,v) VALUES('selfcheck','passed') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
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
    if ((pending.size || inventory) && !syncing && !rebuilding) void drain();
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
        if (message.first) staging = { revision: message.revision, sessions: new Map() };
        if (staging?.revision !== message.revision || message.sessions.length > 1000) return;
        for (const session of message.sessions) staging.sessions.set(session.id, session);
        if (!message.last) return;
        activeRevision = message.revision;
        inventory = { revision: activeRevision, ids: new Set(staging.sessions.keys()) };
        pending = new Map([...staging.sessions].map(([id, session]) => [id, { session, revision: activeRevision }]));
        staging = undefined;
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
            if (activeRevision <= message.revision) {
              activeRevision = message.revision;
              inventory = undefined;
              pending = new Map(message.sessions.map((session) => [session.id, { session, revision: message.revision }]));
            }
            while ((pending.size || inventory) && !stopped) {
              await drain();
              if (lastDrainError || index.syncStatus.state === 'wal_stuck')
                throw new Error(lastDrainError ?? 'reindex paused at WAL checkpoint');
              if (pending.size) await new Promise((done) => setTimeout(done, 100));
            }
            if (stopped) throw new Error('indexer stopped during reindex');
            completedRevision = activeRevision;
            report({ type: 'inventory_synced', revision: completedRevision });
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
  try { index?.close(); } catch {}
  releaseLease();
}

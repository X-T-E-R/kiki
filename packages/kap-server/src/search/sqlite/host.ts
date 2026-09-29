import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setPriority } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { GlobalSearchError, type GlobalSearchUnavailableReason } from '../contract';
import type { NormalizedQuery, SearchBudgets } from '../match';
import type { SqliteSearchResult, SqliteSessionInput, SqliteSyncStatus } from './index';
import { INDEXER_COMMAND, MEMORY_BUDGET_EXIT, type IndexerEvent, type IndexerRequest, type QueryEvent, type QueryRequest } from './processProtocol';

export interface SqliteHostOptions {
  readonly database: string;
  readonly indexerHardMb?: number;
  readonly indexerSoftMb?: number;
  readonly indexerEntry?: string;
  readonly queryEntry?: string;
  readonly heartbeatMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly backoffMs?: readonly number[];
  readonly memoryBackoffMs?: readonly number[];
  readonly queryTimeoutMs?: number;
  readonly indexSubagents?: boolean;
}

export interface SqliteHostSnapshot {
  readonly state: 'building' | 'ready' | 'readonly' | 'unavailable';
  readonly reason?: GlobalSearchUnavailableReason;
  readonly stale: boolean;
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
  readonly retryAfterMs?: number;
  readonly indexerTerminal: boolean;
  readonly indexerPid?: number;
  readonly indexerRss?: number;
  readonly indexerHeapLimit?: number;
  readonly dbBytes?: number;
  readonly filesPending?: number;
  readonly lastBatchMs?: number;
  readonly indexerStatus?: SqliteSyncStatus;
  readonly inflight?: string;
  readonly pendingSessions: number;
  readonly queryWorkers: number;
  readonly watchdogTimeouts: number;
}

const INDEXER_BACKOFF = [1000, 10_000, 60_000, 600_000];
const MEMORY_BACKOFF = [60_000, 600_000, 3_600_000];
const QUERY_ACTIVE_SLOTS = 8;

export function seaIndexerArgs(database: string, execArgv: readonly string[]): string[] {
  return [
    ...(execArgv.includes('--max-old-space-size=8192') ? ['--node-options=--max-old-space-size=384'] : []),
    INDEXER_COMMAND, database,
  ];
}

export class SqliteSearchHost {
  private child?: ChildProcess;
  private readonly readers: Worker[] = [];
  private readonly readerLoads = [0, 0, 0];
  private readonly bootSalt = randomUUID();
  private readonly pending = new Map<string, SqliteSessionInput>();
  private readonly sent = new Set<string>();
  private readonly resend = new Set<string>();
  private readonly known = new Map<string, SqliteSessionInput>();
  private reindexRequest?: { id: number; resolve: (value: { sessions: number; documents: number }) => void;
    reject: (error: Error) => void; timer: NodeJS.Timeout };
  private rebuilding = false;
  private readonly queries = new Map<number, { resolve: (result: SqliteSearchResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; release: () => void }>();
  private readonly queryWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  private reservedQuerySlots = 0;
  private id = 0;
  private timer?: NodeJS.Timeout;
  private restart?: NodeJS.Timeout;
  private lastPong = 0;
  private retryAt = 0;
  private failures = 0;
  private memoryFailures = 0;
  private terminal = false;
  private stopped = false;
  private ready = false;
  private readonlyWriter = false;
  private reason?: GlobalSearchUnavailableReason;
  private rss?: number;
  private heapLimit?: number;
  private dbBytes?: number;
  private filesPending?: number;
  private lastBatchMs?: number;
  private status?: SqliteSyncStatus;
  private inflight?: string;
  private timeouts = 0;
  private readerOpening?: Promise<void>;

  constructor(private readonly options: SqliteHostOptions) {}

  snapshot(): SqliteHostSnapshot {
    const indexedSessions = this.status?.indexedSessions ?? 0;
    const totalSessions = Math.max(indexedSessions, this.known.size);
    return { state: this.reason ? 'unavailable' : this.readonlyWriter ? 'readonly' :
      this.ready && !this.rebuilding && this.pending.size === 0 && indexedSessions >= totalSessions ? 'ready' : 'building',
      reason: this.reason, stale: !!this.reason || this.rebuilding || this.pending.size > 0,
      indexedSessions, totalSessions, documents: this.status?.documents ?? 0,
      retryAfterMs: this.retryAt > Date.now() ? this.retryAt - Date.now() : undefined,
      indexerTerminal: this.terminal, indexerPid: this.child?.pid, indexerRss: this.rss, indexerHeapLimit: this.heapLimit, indexerStatus: this.status,
      dbBytes: this.dbBytes, filesPending: this.filesPending, lastBatchMs: this.lastBatchMs,
      inflight: this.inflight, pendingSessions: this.pending.size,
      queryWorkers: this.readers.length, watchdogTimeouts: this.timeouts };
  }

  async open(): Promise<void> {
    if (this.stopped) throw new GlobalSearchError('index_unavailable', 'search host is closed');
    this.startIndexer();
    await this.openReader();
  }

  retryIndexer(): void {
    if (this.stopped) return;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    this.retryAt = 0;
    this.failures = 0;
    this.memoryFailures = 0;
    this.terminal = false;
    this.startIndexer();
  }

  sync(sessions: readonly SqliteSessionInput[]): void {
    if (this.stopped) return;
    for (const session of sessions) {
      if (this.sent.has(session.id)) this.resend.add(session.id);
      if (!this.readonlyWriter) this.pending.set(session.id, session);
      this.known.set(session.id, session);
    }
    this.startIndexer();
    this.flushPending();
  }

  async reindex(sessions: readonly SqliteSessionInput[]): Promise<{ sessions: number; documents: number }> {
    if (this.stopped || !this.child || !this.ready) throw new GlobalSearchError('index_unavailable', 'search indexer is unavailable');
    if (this.readonlyWriter) throw new GlobalSearchError('readonly_index', 'another process owns the search index');
    if (this.reindexRequest) throw new GlobalSearchError('index_unavailable', 'search reindex is already running');
    const child = this.child;
    const id = ++this.id;
    this.rebuilding = true;
    for (const session of sessions) {
      this.known.set(session.id, session);
      this.pending.set(session.id, session);
      this.sent.add(session.id);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finishReindex(new Error('search reindex timed out'));
      }, 30 * 60_000);
      this.reindexRequest = { id, resolve, reject, timer };
      child.send({ type: 'reindex', id, sessions: [...sessions] } satisfies IndexerRequest, (error) => {
        if (error) this.finishReindex(error);
      });
    });
  }

  private finishReindex(error?: Error, result?: { sessions: number; documents: number }): void {
    const request = this.reindexRequest;
    if (!request) return;
    this.reindexRequest = undefined;
    this.rebuilding = false;
    clearTimeout(request.timer);
    if (error) request.reject(error);
    else request.resolve(result!);
    if (!error) this.flushPending();
  }

  private releaseQuerySlot(): void {
    const waiter = this.queryWaiters.shift();
    if (waiter) { clearTimeout(waiter.timer); this.reservedQuerySlots++; waiter.resolve(); }
  }

  async search(query: NormalizedQuery, pageToken?: string, budgets?: SearchBudgets): Promise<SqliteSearchResult & { stale: boolean }> {
    await this.openReader();
    if (this.queries.size + this.reservedQuerySlots >= QUERY_ACTIVE_SLOTS || this.queryWaiters.length) {
      if (this.queryWaiters.length >= 32) throw new GlobalSearchError('index_unavailable', 'search queue full');
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => {
          this.queryWaiters.splice(this.queryWaiters.indexOf(waiter), 1);
          reject(new GlobalSearchError('index_unavailable', 'search queue timed out'));
        }, this.options.queryTimeoutMs ?? 10_000) };
        this.queryWaiters.push(waiter);
      });
      this.reservedQuerySlots--;
    }
    const id = ++this.id;
    const slot = this.readerLoads.indexOf(Math.min(...this.readerLoads));
    const reader = this.readers[slot];
    if (!reader || this.stopped) throw new GlobalSearchError('index_unavailable', 'search database is unavailable');
    this.readerLoads[slot]!++;
    return new Promise((resolve, reject) => {
      const release = (): void => { this.readerLoads[slot]!--; this.releaseQuerySlot(); };
      const timer = setTimeout(() => {
        this.timeouts++;
        this.failReader(new Error('query worker watchdog timed out'));
      }, this.options.queryTimeoutMs ?? 10_000);
      this.queries.set(id, { resolve: (value) => resolve({ ...value, stale: this.snapshot().stale }), reject, timer, release });
      const request: QueryRequest = { id, type: 'search', query, pageToken, budgets };
      try { reader.postMessage(request); }
      catch (error) { clearTimeout(timer); this.queries.delete(id); release(); reject(error); }
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.finishReindex(new Error('search host closed'));
    if (this.timer) clearInterval(this.timer);
    if (this.restart) clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    const readers = this.readers.splice(0);
    for (const request of this.queries.values()) {
      clearTimeout(request.timer);
      request.release();
      request.reject(new Error('search host closed'));
    }
    this.queries.clear();
    for (const waiter of this.queryWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('search host closed'));
    }
    const readerExit = Promise.all(readers.map((reader) => reader.terminate()));
    const childExit = child && child.exitCode === null ? new Promise<void>((resolve) => {
      const deadline = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      child.send({ type: 'close' } satisfies IndexerRequest, () => {});
    }) : undefined;
    await Promise.all([readerExit, childExit]);
  }

  private startIndexer(): void {
    if (this.stopped || this.terminal || this.child || this.restart || this.retryAt > Date.now()) return;
    const sea = process.env['KIKI_SQLITE_INDEXER_SEA'] === '1';
    const entry = this.options.indexerEntry ?? process.env['KIKI_SQLITE_INDEXER_PATH'] ??
      fileURLToPath(new URL('./indexerDev.ts', import.meta.url));
    const source = entry.endsWith('.ts');
    const args = sea ? seaIndexerArgs(this.options.database, process.execArgv) :
      ['--max-old-space-size=256', ...(source ? ['--experimental-transform-types', '--import', 'tsx',
        '--import', new URL('./register-dev-hooks.mjs', import.meta.url).href] : []),
      entry, this.options.database];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${sea ? 384 : 256}`,
        KIKI_SEARCH_INDEXER_HARD_MB: String(this.options.indexerHardMb ?? 768),
        KIKI_SEARCH_INDEXER_SOFT_MB: String(this.options.indexerSoftMb ?? (sea ? 512 : 384)),
        KIKI_SEARCH_INDEX_SUBAGENTS: this.options.indexSubagents ? '1' : '0' },
    });
    this.child = child;
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    try { if (child.pid) setPriority(child.pid, 10); } catch {}
    this.lastPong = Date.now();
    child.on('message', (message: IndexerEvent) => {
      if (this.child !== child) return;
      if (message.type === 'ready') {
        const promoted = this.readonlyWriter && message.writer !== false;
        this.ready = true;
        this.readonlyWriter = message.writer === false;
        if (this.readonlyWriter) this.pending.clear();
        else if (promoted) for (const [id, session] of this.known) this.pending.set(id, session);
        if (this.failures === 0) this.reason = undefined;
        this.retryAt = 0;
        this.flushPending();
      } else if (message.type === 'heartbeat') this.lastPong = Date.now();
      else if (message.type === 'release_reader') {
        this.reason = 'corrupt_rebuilding';
        this.sent.clear();
        this.resend.clear();
        for (const [id, session] of this.known) this.pending.set(id, session);
        const released = this.failReader(new Error('search database is rebuilding'));
        void (released ?? Promise.resolve()).then(() => {
          if (this.child === child) child.send({ type: 'reader_released' } satisfies IndexerRequest);
        });
      } else if (message.type === 'status') {
        this.rss = message.rss;
        this.heapLimit = message.heapLimit;
        this.status = message.status;
        this.dbBytes = message.dbBytes;
        this.filesPending = message.pending;
        this.lastBatchMs = message.lastBatchMs;
        this.inflight = message.inflight;
        if (message.status.state === 'wal_stuck') this.reason = 'wal_stuck';
        else if (this.reason === 'wal_stuck' ||
          (this.pending.size === 0 && !message.inflight && message.rss <=
            (this.options.indexerHardMb ?? 768) * 1048576 &&
            (this.reason === 'indexer_backoff' || this.reason === 'memory_budget'))) {
          this.reason = undefined;
          this.failures = 0;
          this.memoryFailures = 0;
        }
      } else if (message.type === 'synced') {
        if (this.reason === 'disk_low' || this.reason === 'indexer_backoff' ||
          this.reason === 'memory_budget') this.reason = undefined;
        this.sent.delete(message.sessionId);
        if (this.resend.delete(message.sessionId)) this.flushPending();
        else this.pending.delete(message.sessionId);
        if (!this.pending.size) { this.failures = 0; this.memoryFailures = 0; }
      } else if (message.type === 'reindexed') {
        if (this.reindexRequest?.id === message.id) this.finishReindex(
          message.error ? new Error(message.error) : undefined,
          { sessions: message.sessions, documents: message.documents });
      } else if (message.type === 'error') {
        if (message.message === 'disk_low' || message.message === 'sqlite_unavailable') this.reason = message.message;
        else process.stderr.write(`search indexer: ${message.message}\n`);
      }
    });
    const onExit = (code: number | null, signal: string | null): void => {
      if (this.child !== child) return;
      this.child = undefined;
      this.finishReindex(new Error('search indexer exited during reindex'));
      if (this.stopped) return;
      this.sent.clear();
      this.resend.clear();
      if (this.inflight) {
        const path = resolve(this.inflight);
        for (const session of this.known.values()) {
          if (path.startsWith(`${resolve(session.dir)}${sep}`)) this.pending.set(session.id, session);
        }
      }
      this.inflight = undefined;
      this.ready = false;
      if (this.reason === 'sqlite_unavailable' || this.reason === 'disk_low') {
        this.terminal = true;
        return;
      }
      this.failures++;
      if (code === MEMORY_BUDGET_EXIT) this.memoryFailures++;
      else this.memoryFailures = 0;
      const memory = this.memoryFailures >= 3;
      this.reason = memory ? 'memory_budget' : 'indexer_backoff';
      const schedule = memory ? this.options.memoryBackoffMs ?? MEMORY_BACKOFF : this.options.backoffMs ?? INDEXER_BACKOFF;
      const delay = schedule[Math.min(memory ? this.memoryFailures - 3 : this.failures - 1, schedule.length - 1)]!;
      const terminal = memory && this.memoryFailures >= 3 + schedule.length;
      this.terminal = terminal;
      this.retryAt = terminal ? 0 : Date.now() + delay;
      process.stderr.write(`search indexer exited code=${code} signal=${signal} reason=${this.reason} backoffMs=${terminal ? 0 : delay}\n`);
      if (terminal) return;
      this.restart = setTimeout(() => { this.restart = undefined; this.startIndexer(); }, delay);
      this.restart.unref();
    };
    child.on('error', (error) => {
      process.stderr.write(`search indexer spawn: ${error.message}\n`);
      onExit(null, 'spawn-error');
    });
    child.on('exit', onExit);
    this.timer ??= setInterval(() => {
      if (!this.child) return;
      if (Date.now() - this.lastPong > (this.options.heartbeatTimeoutMs ?? 120_000)) {
        this.child.kill();
        return;
      }
      this.child.send({ type: 'heartbeat' } satisfies IndexerRequest);
    }, this.options.heartbeatMs ?? 1000);
    this.timer.unref();
  }

  private flushPending(): void {
    if (!this.ready || this.readonlyWriter || !this.child || this.rebuilding) return;
    const sessions = [...this.pending.values()].filter((session) => !this.sent.has(session.id));
    for (let i = 0; i < sessions.length; i += 1000) {
      const batch = sessions.slice(i, i + 1000);
      for (const session of batch) this.sent.add(session.id);
      this.child.send({ type: 'sync', sessions: batch } satisfies IndexerRequest);
    }
  }

  private async openReader(): Promise<void> {
    if (this.readers.length === 3 || this.readerOpening) return this.readerOpening;
    this.readerOpening = (async () => {
      while (this.readers.length < 3) await this.spawnReader();
    })().finally(() => { this.readerOpening = undefined; });
    return this.readerOpening;
  }

  private spawnReader(): Promise<void> {
    const entry = this.options.queryEntry ?? process.env['KIKI_SQLITE_QUERY_WORKER_PATH'] ??
      fileURLToPath(new URL('./queryEntry.ts', import.meta.url));
    const source = entry.endsWith('.ts');
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(pathToFileURL(entry), { workerData: { database: this.options.database, bootSalt: this.bootSalt },
        execArgv: source ? ['--experimental-transform-types', '--import', 'tsx', '--import',
          new URL('./register-dev-hooks.mjs', import.meta.url).href] : [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
      const opening = setTimeout(() => { void worker.terminate(); reject(new Error('query worker ready timed out')); }, 5000);
      worker.on('message', (event: QueryEvent) => {
        if (event.type === 'ready') {
          clearTimeout(opening);
          if (this.stopped) { void worker.terminate(); reject(new Error('search host closed')); return; }
          this.readers.push(worker);
          resolve();
        } else if (event.type === 'result' || event.type === 'error') {
          if (event.id === 0 && event.type === 'error') {
            clearTimeout(opening);
            void worker.terminate();
            reject(new Error(event.message));
            return;
          }
          const request = this.queries.get(event.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.queries.delete(event.id);
          request.release();
          if (event.type === 'result') request.resolve(event.value);
          else request.reject(new Error(event.message));
        }
      });
      worker.on('error', (error) => {
        clearTimeout(opening);
        reject(error);
        this.failReader(error);
      });
      worker.on('exit', () => {
        clearTimeout(opening);
        if (this.readers.includes(worker)) this.failReader(new Error('query worker exited'));
      });
    });
  }

  private failReader(error: Error): Promise<void> {
    const readers = this.readers.splice(0);
    const exit = Promise.all(readers.map((reader) => reader.terminate())).then(() => {});
    for (const [id, request] of this.queries) {
      clearTimeout(request.timer);
      request.release();
      request.reject(error);
      this.queries.delete(id);
    }
    for (const waiter of this.queryWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    return exit;
  }
}

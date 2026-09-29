import { spawn, type ChildProcess } from 'node:child_process';
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
}

export interface SqliteHostSnapshot {
  readonly state: 'building' | 'ready' | 'unavailable';
  readonly reason?: GlobalSearchUnavailableReason;
  readonly stale: boolean;
  readonly retryAfterMs?: number;
  readonly indexerTerminal: boolean;
  readonly indexerPid?: number;
  readonly indexerRss?: number;
  readonly indexerStatus?: SqliteSyncStatus;
  readonly inflight?: string;
  readonly pendingSessions: number;
  readonly watchdogTimeouts: number;
}

const INDEXER_BACKOFF = [1000, 10_000, 60_000, 600_000];
const MEMORY_BACKOFF = [60_000, 600_000, 3_600_000];

export class SqliteSearchHost {
  private child?: ChildProcess;
  private reader?: Worker;
  private readonly pending = new Map<string, SqliteSessionInput>();
  private readonly sent = new Set<string>();
  private readonly resend = new Set<string>();
  private readonly known = new Map<string, SqliteSessionInput>();
  private readonly queries = new Map<number, { resolve: (result: SqliteSearchResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
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
  private reason?: GlobalSearchUnavailableReason;
  private rss?: number;
  private status?: SqliteSyncStatus;
  private inflight?: string;
  private timeouts = 0;
  private readerOpening?: Promise<void>;

  constructor(private readonly options: SqliteHostOptions) {}

  snapshot(): SqliteHostSnapshot {
    return { state: this.reason ? 'unavailable' : this.ready ? 'ready' : 'building',
      reason: this.reason, stale: !!this.reason || this.pending.size > 0,
      retryAfterMs: this.retryAt > Date.now() ? this.retryAt - Date.now() : undefined,
      indexerTerminal: this.terminal, indexerPid: this.child?.pid, indexerRss: this.rss, indexerStatus: this.status,
      inflight: this.inflight, pendingSessions: this.pending.size, watchdogTimeouts: this.timeouts };
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
      this.pending.set(session.id, session);
      this.known.set(session.id, session);
    }
    this.flushPending();
  }

  async search(query: NormalizedQuery, pageToken?: string, budgets?: SearchBudgets): Promise<SqliteSearchResult & { stale: boolean }> {
    if (this.queries.size >= 8) throw new GlobalSearchError('index_unavailable', 'search busy');
    await this.openReader();
    if (this.queries.size >= 8) throw new GlobalSearchError('index_unavailable', 'search busy');
    const reader = this.reader;
    if (!reader) throw new GlobalSearchError('index_unavailable', 'search database is unavailable');
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timeouts++;
        this.failReader(new Error('query worker watchdog timed out'));
      }, this.options.queryTimeoutMs ?? 10_000);
      this.queries.set(id, { resolve: (value) => resolve({ ...value, stale: this.snapshot().stale }), reject, timer });
      const request: QueryRequest = { id, type: 'search', query, pageToken, budgets };
      try { reader.postMessage(request); }
      catch (error) { clearTimeout(timer); this.queries.delete(id); reject(error); }
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.restart) clearTimeout(this.restart);
    const child = this.child;
    this.child = undefined;
    const reader = this.reader;
    this.reader = undefined;
    for (const request of this.queries.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('search host closed'));
    }
    this.queries.clear();
    const readerExit = reader?.terminate();
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
    const entry = this.options.indexerEntry ?? fileURLToPath(new URL('./indexerDev.ts', import.meta.url));
    const args = sea ? [INDEXER_COMMAND, this.options.database] : ['--experimental-transform-types', '--import', 'tsx', '--import',
      new URL('./register-dev-hooks.mjs', import.meta.url).href, entry, this.options.database];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${sea ? 512 : 256}`,
        KIKI_SEARCH_INDEXER_HARD_MB: String(this.options.indexerHardMb ?? 768),
        KIKI_SEARCH_INDEXER_SOFT_MB: String(this.options.indexerSoftMb ?? 384) },
    });
    this.child = child;
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    try { if (child.pid) setPriority(child.pid, 10); } catch {}
    this.lastPong = Date.now();
    child.on('message', (message: IndexerEvent) => {
      if (this.child !== child) return;
      if (message.type === 'ready') {
        this.ready = true;
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
        this.status = message.status;
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
      } else if (message.type === 'error') {
        if (message.message === 'disk_low') this.reason = 'disk_low';
        else process.stderr.write(`search indexer: ${message.message}\n`);
      }
    });
    const onExit = (code: number | null, signal: string | null): void => {
      if (this.child !== child) return;
      this.child = undefined;
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
    if (!this.ready || !this.child) return;
    const sessions = [...this.pending.values()].filter((session) => !this.sent.has(session.id));
    for (let i = 0; i < sessions.length; i += 1000) {
      const batch = sessions.slice(i, i + 1000);
      for (const session of batch) this.sent.add(session.id);
      this.child.send({ type: 'sync', sessions: batch } satisfies IndexerRequest);
    }
  }

  private async openReader(): Promise<void> {
    if (this.reader || this.readerOpening) return this.readerOpening;
    const entry = this.options.queryEntry ?? process.env['KIKI_SQLITE_QUERY_WORKER_PATH'] ??
      fileURLToPath(new URL('./queryEntry.ts', import.meta.url));
    const source = entry.endsWith('.ts');
    this.readerOpening = new Promise<void>((resolve, reject) => {
      const worker = new Worker(pathToFileURL(entry), { workerData: this.options.database,
        execArgv: source ? ['--experimental-transform-types', '--import', 'tsx', '--import',
          new URL('./register-dev-hooks.mjs', import.meta.url).href] : [],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
      const opening = setTimeout(() => { worker.terminate(); reject(new Error('query worker ready timed out')); }, 5000);
      worker.on('message', (event: QueryEvent) => {
        if (event.type === 'ready') {
          clearTimeout(opening);
          this.reader = worker;
          resolve();
        } else if (event.type === 'result' || event.type === 'error') {
          if (event.id === 0 && event.type === 'error') { clearTimeout(opening); reject(new Error(event.message)); return; }
          const request = this.queries.get(event.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.queries.delete(event.id);
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
        if (this.reader === worker) this.failReader(new Error('query worker exited'));
      });
    }).finally(() => { this.readerOpening = undefined; });
    return this.readerOpening;
  }

  private failReader(error: Error): Promise<number> | undefined {
    const reader = this.reader;
    this.reader = undefined;
    const exit = reader?.terminate();
    for (const [id, request] of this.queries) {
      clearTimeout(request.timer);
      request.reject(error);
      this.queries.delete(id);
    }
    return exit;
  }
}

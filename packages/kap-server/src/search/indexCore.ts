import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  MiniDb,
  OpTracker,
  TextIndexBuildingError,
  classifyStorageError,
  wipeStoreDir,
  type BatchInputOp,
} from '@kiki/minidb';

import { GlobalSearchError, type GlobalSearchIncomplete } from './contract.ts';
import {
  MAX_DOC_TEXT_CHARS,
  type FileMetaDoc,
  type MessageDoc,
  type SearchDoc,
  type SessionMetaDoc,
  type StatsDoc,
  type StepTrackerState,
  type TitleDoc,
  type TurnCounterState,
} from './docs.ts';
import {
  decodePageToken,
  matchDocs,
  paginateRows,
  type MatchBudget,
  type MatchedRow,
  type NormalizedQuery,
  type SearchBudgets,
} from './match.ts';
import { analyzeWireLine, type StepEffect, type TurnEffect } from './wireExtract.ts';

const TEXT_INDEX_NAME = 'body';
const TRI_INDEX_NAME = 'tri';
const WIRE_FILENAME = 'wire.jsonl';

const FILE_META_PREFIX = '\0meta\\file\\';
const SESSION_META_PREFIX = '\0meta\\session\\';
const STATS_KEY = '\0meta\\stats';

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 32);
}

function fileMetaKey(sessionId: string, filePath: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\${hashPath(filePath)}`;
}

function fileMetaPrefixFor(sessionId: string): string {
  return `${FILE_META_PREFIX}${sessionId}\\`;
}

function legacyFileMetaKey(filePath: string): string {
  return FILE_META_PREFIX + hashPath(filePath);
}

const WIRE_READ_CHUNK_BYTES = 1 << 20;
const WIRE_BATCH_OPS = 1_000;
const EMPTY_BUFFER = Buffer.alloc(0);
const SYNC_ROUND_BYTE_BUDGET = 64 << 20;
const SYNC_ROUND_TIME_BUDGET_MS = 30_000;
const SYNC_FAILURE_ESCALATION_LIMIT = 5;
const SESSION_SYNC_FAILURE_SKIP_LIMIT = 5;
const SESSION_SYNC_SKIP_COOLDOWN_MS = 300_000;

interface SyncRoundBudget {
  bytesLeft: number;
  deadline: number;
}

function syncBudgetExhausted(budget: SyncRoundBudget): boolean {
  return budget.bytesLeft <= 0 || Date.now() >= budget.deadline;
}

function emptySyncOutcome(): CoreSyncPassOutcome {
  return { noop: true, sessions: 0, documents: 0, truncated: false, failures: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INITIAL_TURN_STATE: TurnCounterState = { next: 0, hasTurn: false, openers: [] };

function initialTurnState(): TurnCounterState {
  return INITIAL_TURN_STATE;
}

function applyUndoToTurnState(state: TurnCounterState, count: number): TurnCounterState {
  let found = 0;
  for (let i = state.openers.length - 1; i >= 0; i--) {
    if (state.openers[i]!.anchor) {
      found++;
      if (found === count) {
        return {
          next: state.openers[i]!.turn,
          hasTurn: i > 0,
          openers: state.openers.slice(0, i),
        };
      }
    }
  }
  return state;
}

function advanceTurnCounter(
  state: TurnCounterState,
  effect: TurnEffect,
): { docTurn: number | undefined; state: TurnCounterState } {
  switch (effect.kind) {
    case 'open':
      return {
        docTurn: state.next,
        state: {
          next: state.next + 1,
          hasTurn: true,
          openers: [...state.openers, { turn: state.next, anchor: effect.anchor }],
        },
      };
    case 'ensure': {
      const next = state.hasTurn ? state : { ...state, next: state.next + 1, hasTurn: true };
      return { docTurn: next.next - 1, state: next };
    }
    case 'undo':
      return { docTurn: undefined, state: applyUndoToTurnState(state, effect.count) };
    case 'none':
      return { docTurn: undefined, state };
  }
}

const INITIAL_STEP_STATE: StepTrackerState = { byUuid: {}, begins: 0 };

function initialStepState(): StepTrackerState {
  return INITIAL_STEP_STATE;
}

function advanceStepTracker(state: StepTrackerState, effect: StepEffect): StepTrackerState {
  if (effect.kind !== 'begin') return state;
  const begins = state.begins + 1;
  const ordinal = effect.ordinal ?? begins;
  if (state.byUuid[effect.uuid] === ordinal) return state;
  return { byUuid: { ...state.byUuid, [effect.uuid]: ordinal }, begins };
}

/** Minimal logger surface the core needs (the worker forwards these over RPC). */
export interface SearchCoreLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

async function sessionDirectoryIdentity(sessionDir: string): Promise<string | undefined> {
  try {
    const info = await stat(sessionDir, { bigint: true });
    if (!info.isDirectory() || info.ino <= 0n || info.birthtimeNs <= 0n) return undefined;
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function sessionDirectoryTitle(
  sessionDir: string,
  log: SearchCoreLog,
): Promise<string> {
  for (const scope of ['', 'session-meta']) {
    try {
      const meta: unknown = JSON.parse(
        await readFile(join(sessionDir, scope, 'state.json'), 'utf8'),
      );
      if (
        typeof meta === 'object' &&
        meta !== null &&
        'title' in meta &&
        typeof meta.title === 'string'
      ) {
        return meta.title;
      }
      return '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('global search: cannot read session title', {
          dir: sessionDir,
          error: errorMessage(error),
        });
      }
    }
  }
  return '';
}

export interface SearchCoreOptions {
  /** Absolute path of the search-index database directory. */
  readonly indexDir: string;
  readonly log: SearchCoreLog;
  /**
   * Unique-per-host-boot salt mixed into the token-pinning generation: a
   * worker/process restart resets the local generation counter, and the
   * salt makes tokens issued before the restart fail validation instead of
   * colliding with the fresh counter (see `tokenGeneration`).
   */
  readonly bootSalt: string;
  /**
   * Fired synchronously when an open acquires the write lock — BEFORE the
   * heavy recovery work runs. The worker entry forwards it to the host so a
   * mid-open crash leaves a reapable lock.
   */
  readonly onLockToken?: (token: string) => void;
}

/**
 * One session to index, with its persistence directory PRE-RESOLVED by the
 * caller (the main process owns `sessionDirOf`/`workspacePersistenceScope`;
 * the worker closure deliberately does not import agent-core-v2).
 */
export interface SyncSessionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly updatedAt: number;
  readonly sourceMtimeMs?: number;
  readonly forceSync?: boolean;
  /** Absolute session directory (the parent of wire.jsonl / agents/). */
  readonly dir: string;
}

type SourcedSessionInput = SyncSessionInput & {
  readonly title: string;
  readonly sessionIdentity: string;
};

interface SessionSyncResult {
  readonly truncated: boolean;
  readonly failed: boolean;
  readonly error?: string;
  readonly unavailable: boolean;
}

/** The core's view of the served index, embedded in every search response. */
export interface CoreIndexView {
  readonly state: 'building' | 'ready' | 'readonly';
  readonly indexedSessions: number;
  readonly documents: number;
  readonly readOnly: boolean;
  /**
   * Read-only-branch staleness: the on-disk fingerprint changed (a refresh
   * is pending) or a refresh is in flight. Writer-side staleness is the
   * caller's coordinator state and is OR'ed in by the service.
   */
  readonly freshnessStale: boolean;
  /** Last background refresh failure, when serving a stale view. */
  readonly degraded?: string;
  /**
   * Token of the db.lock line this core published (writer only) — the main
   * process uses it to reap the lock file after a worker crash without ever
   * deleting another owner's lock.
   */
  readonly lockToken?: string;
}

export type CoreSearchResult =
  | {
      readonly kind: 'page';
      readonly rows: MatchedRow[];
      readonly hasMore: boolean;
      readonly incomplete?: GlobalSearchIncomplete;
      /** Token-pinning generation (`bootSalt:counter`) — see tokenGeneration. */
      readonly generation: string;
      readonly index: CoreIndexView;
    }
  | { readonly kind: 'building'; readonly index: CoreIndexView };

export interface CoreSearchParams {
  readonly q: NormalizedQuery;
  /** Raw opaque token from the request; decoded (and generation-checked) here. */
  readonly pageToken?: string;
  readonly budgets: SearchBudgets;
}

export interface CoreSyncOutcome {
  /** True when the pass did not run (no db yet, or a read-only instance). */
  readonly noop: boolean;
  readonly sessions: number;
  readonly documents: number;
  /**
   * True when the pass stopped early — either the round budget ran out or the
   * index was rebuilt after an unrecoverable failure. The caller must ask for
   * another pass instead of treating the index as complete.
   */
  readonly truncated: boolean;
  /** Sessions that failed to index in this pass (a cooled-down session is skipped, not failed). */
  readonly failures: number;
  readonly lockToken?: string;
  /** Post-pass lifecycle snapshot (stage 5) — keeps the host's cached
   *  aggregate state exact on the sync-first path, where no search/status
   *  response ever carries it. */
  readonly lifecycle: CoreLifecycleReport;
}

type CoreSyncPassOutcome = Omit<CoreSyncOutcome, 'lockToken' | 'lifecycle'>;

/**
 * The aggregate lifecycle of the served index (stage 5): the diagnostic state
 * machine behind the service's status surface —
 * `stopped → opening → ready → building/degraded → closing`. Distinct from
 * the per-page `CoreIndexView.state` (which answers "can this page serve hits
 * now"): the lifecycle also covers the no-db phases and carries the failure
 * detail, so logs/diagnostics can tell building, stale-serving, degraded,
 * corrupt-rebuild and worker-unavailable apart.
 */
export type CoreLifecycleState =
  | 'stopped'
  | 'opening'
  | 'building'
  | 'ready'
  | 'degraded'
  | 'closing';

export interface CoreLifecycleReport {
  readonly state: CoreLifecycleState;
  readonly detail?: string;
}

export interface CoreStatus {
  readonly sessions: number;
  readonly documents: number;
  readonly lastIndexedAt: number | null;
  readonly generation: number;
  readonly readOnly: boolean;
  readonly lockToken?: string;
  readonly degraded?: string;
  /** Post-open/post-refresh lifecycle snapshot (stage 5). */
  readonly lifecycle: CoreLifecycleReport;
}

export class SearchIndexCore {
  /** WAL watermark (bytes applied) for read-only catch-up. */
  private walOffset = 0;
  private fingerprint = '';
  private disposed = false;
  /**
   * Close-gate + drain for lifecycle-managed background ops (sync passes and
   * read-only refreshes): close() closes the gate (new ops skip) and drains
   * the in-flight ones BEFORE closing the db, so no background task ever
   * touches a closed handle.
   */
  private readonly ops = new OpTracker();
  /**
   * Identity of the published index base: bumped on every open/reopen
   * (initial open, read-only swap, reindex) and on a sync pass that REPLACED
   * already-indexed documents (shrink rescan, title overwrite). Page tokens
   * pin it; additive/deletion-only passes deliberately keep it stable so
   * keyset pagination over a live index is not constantly restarted (see
   * contract.ts for the weak-consistency semantics).
   */
  private generation = 0;
  /** Set by a sync pass when it replaced indexed documents → generation bump. */
  private syncReplaced = false;
  /** Last background refresh failure — surfaced as degraded. */
  private lastRefreshError: { at: number; message: string } | null = null;
  /** Last open failure — a search with no published generation fails fast. */
  private openError: string | null = null;
  /** One-time per-process migration flag for pre-v2 file-meta keys. */
  private fileMetaMigrated = false;
  /** Token of the published db.lock line (writer only) — see CoreIndexView. */
  private lockToken: string | undefined;
  private lastMaintenanceDetail: string | undefined;
  private consecutiveSyncFailures = 0;
  private readonly sessionSyncFailures = new Map<string, number>();
  private readonly sessionSyncSkips = new Map<string, { at: number; updatedAt: number }>();
  private readonly wireFileSnapshots = new Map<string, WireFileSnapshot>();

  db: MiniDb<SearchDoc> | null = null;
  openPromise: Promise<void> | null = null;
  refreshPromise: Promise<void> | null = null;
  fullSyncDone = false;
  syncRoundBytes = SYNC_ROUND_BYTE_BUDGET;
  syncRoundMs = SYNC_ROUND_TIME_BUDGET_MS;
  syncSkipCooldownMs = SESSION_SYNC_SKIP_COOLDOWN_MS;

  constructor(private readonly options: SearchCoreOptions) {}

  /** The published db.lock token (writer only) — see CoreIndexView.lockToken. */
  get lockTokenView(): string | undefined {
    return this.lockToken;
  }

  private get indexDir(): string {
    return this.options.indexDir;
  }

  private get log(): SearchCoreLog {
    return this.options.log;
  }

  ensureOpen(): Promise<void> {
    this.openPromise ??= this.openDb().then(
      () => {
        this.openError = null;
      },
      (error: unknown) => {
        this.openPromise = null;
        this.openError = errorMessage(error);
        throw error;
      },
    );
    return this.openPromise;
  }

  private async openDb(): Promise<void> {
    const db = await this.openSearchDb();
    if (this.disposed) {
      await db.close().catch(() => {});
      throw new GlobalSearchError('index_unavailable', 'search service is disposed');
    }
    await this.publishDb(db, null);
  }

  /**
   * The generation page tokens pin: `<bootSalt>:<local counter>`. The local
   * counter alone restarts from 0 when the worker (or, pre-workerization,
   * the process) respawns — a token issued before the restart (say g=1)
   * would otherwise validate against the fresh host's g=1 and silently
   * paginate a different base. The boot salt makes every pre-restart token
   * fail with `invalid_page_token` so the client restarts the search.
   */
  private tokenGeneration(): string {
    return `${this.options.bootSalt}:${this.generation}`;
  }

  /**
   * Swap a freshly opened db in as the new published generation: writer-side
   * text-index definitions and the (handle-independent) fingerprint are
   * computed BEFORE the swap, so a failure closes `next` and leaves `prev`
   * (or the no-db state) untouched; the swap itself is one synchronous
   * segment with no failure point between publishing `next` and closing
   * `prev`.
   */
  private async publishDb(next: MiniDb<SearchDoc>, prev: MiniDb<SearchDoc> | null): Promise<void> {
    let fingerprint: string;
    try {
      if (!next.readOnly) {
        for (const [name, options] of [
          [TEXT_INDEX_NAME, { fields: ['text'] }],
          [TRI_INDEX_NAME, { fields: ['text'], tokenizer: 'ngram' }],
        ] as const) {
          try {
            await next.createTextIndex(name, options);
          } catch (error) {
            if (!(error instanceof Error && error.message.includes('already exists'))) throw error;
          }
        }
      }
      fingerprint = await this.computeFingerprint();
    } catch (error) {
      await next.close().catch(() => {});
      throw error;
    }
    this.db = next;
    this.walOffset = next.recoveryInfo?.walScanEnd ?? 0;
    this.generation++;
    this.fingerprint = fingerprint;
    this.lockToken = next.readOnly ? undefined : await this.readLockToken();
    if (prev !== null) await prev.close().catch(() => {});
    const lifecycle = next.lifecycleStatus();
    this.log.info('global search: index opened', {
      dir: this.indexDir,
      readOnly: next.readOnly,
      state: lifecycle.state,
      generation: next.getIndexGeneration()?.id ?? null,
      openMs: Math.round(lifecycle.phases.openMs),
      fullRecoveryMs: Math.round(lifecycle.phases.fullRecoveryMs),
    });
  }

  /**
   * The db.lock token this core published, so the main process can reap the
   * lock after a worker crash. Read from the lock file (the LockFile
   * instance's token is instance-private by design); anything unreadable or
   * foreign-owned yields undefined and the reaper stays conservative.
   */
  private async readLockToken(): Promise<string | undefined> {
    try {
      const raw = await readFile(join(this.indexDir, 'db.lock'), 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
      if (parsed.pid !== process.pid || typeof parsed.token !== 'string') return undefined;
      return parsed.token;
    } catch {
      return undefined;
    }
  }

  /**
   * Open the index db, rebuilding from scratch on an UNRECOVERABLE storage
   * failure (the index is derived data — never repaired, only rebuilt). A
   * transient failure (a lock held elsewhere, a full disk, a permission
   * error) propagates instead: destroying the index for one of those turns a
   * hiccup into data loss.
   *
   * Rebuild is WRITER-ONLY: the wipe takes the store's own lock, so a process
   * that cannot get it leaves the live indexer's directory alone and reports
   * `locked` — see `wipeStoreDir`.
   */
  private async openSearchDb(): Promise<MiniDb<SearchDoc>> {
    const opts = {
      dir: this.indexDir,
      valueCodec: 'json',
      fsyncPolicy: 'everysec',
      onLockFail: 'readonly',
      onLockAcquired: (info: { readonly token: string }) => {
        this.lockToken = info.token;
        this.options.onLockToken?.(info.token);
      },
    } as const;
    try {
      return await MiniDb.open<SearchDoc>(opts);
    } catch (error) {
      if (classifyStorageError(error) !== 'rebuild') throw error;
      const outcome = await wipeStoreDir({ dir: this.indexDir });
      if (outcome === 'locked') throw error;
      this.log.warn('global search: search-index corruption detected; rebuilding from scratch', {
        dir: this.indexDir,
        error: errorMessage(error),
      });
      return MiniDb.open<SearchDoc>(opts);
    }
  }

  /**
   * Synchronously mark the core closed: in-flight sync/refresh passes skip
   * their remaining work at the next `disposed` check, and no new background
   * work starts. The async close() then drains and releases the handle. The
   * split exists so a host's synchronous dispose() can gate mid-pass writes
   * BEFORE awaiting anything (the pre-worker service did this with its
   * synchronous `disposed = true`).
   */
  beginClose(): void {
    this.disposed = true;
  }

  /**
   * Close the core: close the op gate (new syncs / refreshes skip at
   * enter()), wait for every in-flight op and the in-flight open to settle,
   * then release and close the handle — no background task can touch a
   * closed db.
   */
  async close(): Promise<void> {
    this.disposed = true;
    await this.ops.close();
    await this.openPromise?.catch(() => {});
    const db = this.db;
    this.db = null;
    if (db) await db.close().catch(() => {});
  }

  /**
   * Run one lifecycle-managed background op under the close drain gate:
   * skipped once close has started, and close waits for every op that
   * already entered before it closes the db.
   */
  private async tracked(op: () => Promise<void>): Promise<void> {
    if (!this.ops.enter()) return;
    try {
      await op();
    } finally {
      this.ops.leave();
    }
  }

  private async computeFingerprint(): Promise<string> {
    const parts: string[] = [];
    for (const name of ['db.wal', 'db.snapshot', 'db.textindexes.json']) {
      try {
        const s = await stat(join(this.indexDir, name));
        parts.push(`${name}:${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${name}:-`);
      }
    }
    return parts.join('|');
  }

  /**
   * Bring a read-only instance up to date with the indexer's committed
   * writes. Unchanged fingerprint → zero IO; WAL pure-append → incremental
   * `catchUpFromWal`; anything else → open the replacement db and swap (which
   * may also promote this process to indexer when the old writer's lock is
   * gone). Single-flight; a failure is recorded in `lastRefreshError` and
   * the stale generation keeps serving (surfaced as `indexState.degraded`).
   */
  refresh(): Promise<void> {
    this.refreshPromise ??= this.tracked(() => this.doRefreshReadonly())
      .then(
        () => {
          this.lastRefreshError = null;
        },
        (error: unknown) => {
          this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
          this.log.warn('global search: read-only refresh failed; serving the stale view', {
            error: errorMessage(error),
          });
        },
      )
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async doRefreshReadonly(): Promise<void> {
    const db = this.db;
    if (!db || !db.readOnly || this.disposed) return;
    const fp = await this.computeFingerprint();
    if (fp === this.fingerprint) return;
    const [, snapPrev, defsPrev] = this.fingerprint.split('|');
    const [, snapNow, defsNow] = fp.split('|');
    if (snapPrev === snapNow && defsPrev === defsNow) {
      const res = await db.catchUpFromWal(this.walOffset);
      if (res !== null) {
        this.walOffset = res.offset;
        this.fingerprint = fp;
        return;
      }
    }
    const next = await this.openSearchDb();
    if (this.disposed) {
      await next.close().catch(() => {});
      return;
    }
    if (this.db !== db) {
      await next.close().catch(() => {});
      return;
    }
    await this.publishDb(next, db);
  }

  async sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome> {
    let outcome: CoreSyncPassOutcome = emptySyncOutcome();
    await this.tracked(async () => {
      try {
        outcome = await this.runSync(sessions);
        this.consecutiveSyncFailures = 0;
      } catch (error) {
        if (classifyStorageError(error) !== 'rebuild') {
          this.consecutiveSyncFailures += 1;
          if (this.consecutiveSyncFailures < SYNC_FAILURE_ESCALATION_LIMIT) throw error;
        }
        this.consecutiveSyncFailures = 0;
        await this.recoverByRebuild(error);
        outcome = { noop: false, sessions: 0, documents: 0, truncated: true, failures: 0 };
      }
    });
    return { ...outcome, lockToken: this.lockToken, lifecycle: this.lifecycleState() };
  }

  private async recoverByRebuild(cause: unknown): Promise<void> {
    this.log.warn(
      'global search: search-index state is unrecoverable; wiping and rebuilding from the transcripts',
      { dir: this.indexDir, error: errorMessage(cause) },
    );
    await this.reindex();
  }

  private async runSync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncPassOutcome> {
    if (this.disposed) return emptySyncOutcome();
    this.syncReplaced = false;
    await this.ensureOpen();
    const db = this.db;
    if (!db || db.readOnly || this.disposed) return emptySyncOutcome();

    await this.migrateFileMetaKeys(db);

    const currentIds = new Set(sessions.map((s) => s.id));
    let changed = false;
    let skipped = 0;

    for (const row of db.query({ key: { prefix: SESSION_META_PREFIX }, project: [] })) {
      if (this.disposed) return emptySyncOutcome();
      const sessionId = row.key.slice(SESSION_META_PREFIX.length);
      if (!currentIds.has(sessionId)) {
        await this.deleteSessionDocs(db, sessionId);
        this.wireFileSnapshots.delete(sessionId);
        changed = true;
      }
    }

    const budget: SyncRoundBudget = {
      bytesLeft: this.syncRoundBytes,
      deadline: Date.now() + this.syncRoundMs,
    };
    let truncated = false;
    let failures = 0;

    for (const summary of sessions) {
      if (this.disposed) return emptySyncOutcome();
      const skip = this.sessionSyncSkips.get(summary.id);
      if (
        skip !== undefined &&
        summary.updatedAt === skip.updatedAt &&
        Date.now() - skip.at < this.syncSkipCooldownMs
      ) {
        continue;
      }
      this.sessionSyncSkips.delete(summary.id);
      if (syncBudgetExhausted(budget)) {
        truncated = true;
        break;
      }
      const sessionMeta = db.get(SESSION_META_PREFIX + summary.id);
      const sourceMtimeMs = summary.sourceMtimeMs ?? await sessionSourceMtime(summary.dir);
      if (summary.forceSync) this.wireFileSnapshots.delete(summary.id);
      const wireSnapshot = this.wireFileSnapshots.get(summary.id);
      if (
        !summary.forceSync &&
        sourceMtimeMs !== undefined &&
        wireSnapshot !== undefined &&
        Date.now() - wireSnapshot.capturedAt < WIRE_FILE_SNAPSHOT_TTL_MS &&
        sessionMeta?.kind === 'sessionMeta' &&
        sessionMeta.updatedAt === summary.updatedAt &&
        sessionMeta.sourceMtimeMs === sourceMtimeMs
      ) {
        continue;
      }
      const result = await this.syncSession(db, summary, sourceMtimeMs, budget);
      changed = true;
      if (result.unavailable) skipped += 1;
      if (result.truncated) truncated = true;
      if (!result.failed) {
        this.sessionSyncFailures.delete(summary.id);
        continue;
      }
      const count = (this.sessionSyncFailures.get(summary.id) ?? 0) + 1;
      this.sessionSyncFailures.set(summary.id, count);
      if (count >= SESSION_SYNC_FAILURE_SKIP_LIMIT) {
        this.sessionSyncFailures.delete(summary.id);
        this.sessionSyncSkips.set(summary.id, { at: Date.now(), updatedAt: summary.updatedAt });
        this.log.warn(
          'global search: giving up on a session whose wire transcript stays unreadable',
          { sessionId: summary.id, error: result.error },
        );
      } else {
        failures += 1;
        this.log.warn('global search: failed to index session', {
          sessionId: summary.id,
          error: result.error,
        });
      }
    }

    if (this.disposed) return emptySyncOutcome();
    if (!truncated && failures === 0) this.fullSyncDone = true;
    if (!changed) {
      const existing = db.get(STATS_KEY);
      return {
        ...emptySyncOutcome(),
        noop: true,
        sessions: sessions.length,
        documents: existing?.kind === 'stats' ? existing.documents : 0,
      };
    }
    const metaCount = db.query({ key: { prefix: '\0meta\\' }, project: [] }).length;
    const stats: StatsDoc = {
      kind: 'stats',
      degraded:
        skipped > 0 ? `Skipped ${String(skipped)} session(s) during indexing` : undefined,
      sessions: sessions.length,
      documents: db.size - metaCount,
      lastIndexedAt: Date.now(),
    };
    await db.set(STATS_KEY, stats);
    if (this.syncReplaced) {
      this.generation++;
    }
    return { noop: false, sessions: sessions.length, documents: stats.documents, truncated, failures };
  }

  /**
   * One-time per-process migration of pre-v2 hash-only file-meta keys to the
   * session-scoped format (`fileMetaKey`). A single full prefix scan of the
   * meta namespace; per-session work afterwards only scans that session's
   * keys. Idempotent — a crash mid-migration just rescans on the next pass.
   */
  private async migrateFileMetaKeys(db: MiniDb<SearchDoc>): Promise<void> {
    if (this.fileMetaMigrated) return;
    const ops: BatchInputOp<SearchDoc>[] = [];
    for (const row of db.query({ key: { prefix: FILE_META_PREFIX }, project: [] })) {
      const rest = row.key.slice(FILE_META_PREFIX.length);
      if (rest.includes('\\')) continue;
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      ops.push({ op: 'set', key: fileMetaKey(meta.sessionId, meta.path), value: meta });
      ops.push({ op: 'del', key: row.key });
    }
    if (ops.length > 0) await db.batch(ops);
    this.fileMetaMigrated = true;
  }

  private async deleteSessionDocs(db: MiniDb<SearchDoc>, sessionId: string): Promise<void> {
    for (const row of db.query({ key: { prefix: `${sessionId}/` }, project: [] })) {
      await db.del(row.key);
    }
    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(sessionId) }, project: [] })) {
      await db.del(row.key);
    }
    await db.del(SESSION_META_PREFIX + sessionId);
  }

  /**
   * Index one session. `unavailable` reports a session directory that is gone
   * (or is no longer a directory): its rows are dropped instead of being
   * re-indexed from a stale inventory snapshot.
   */
  private async syncSession(
    db: MiniDb<SearchDoc>,
    summary: SyncSessionInput,
    sourceMtimeMs: number | undefined,
    budget: SyncRoundBudget,
  ): Promise<SessionSyncResult> {
    let identity: string | undefined;
    try {
      identity = await sessionDirectoryIdentity(summary.dir);
    } catch (error) {
      return { truncated: false, failed: true, error: errorMessage(error), unavailable: false };
    }
    if (identity === undefined) {
      await this.deleteSessionDocs(db, summary.id);
      return { truncated: false, failed: false, unavailable: true };
    }
    const title = await sessionDirectoryTitle(summary.dir, this.log);
    const metaKey = SESSION_META_PREFIX + summary.id;
    const previous = db.get(metaKey);
    if (
      previous?.kind !== 'sessionMeta' ||
      previous.identity !== identity ||
      previous.dir !== summary.dir
    ) {
      await this.deleteSessionDocs(db, summary.id);
      if (previous !== undefined) this.syncReplaced = true;
    }

    const wireFiles = await collectWireFiles(summary.id, summary.dir, this.wireFileSnapshots);
    const seenPaths = new Set(wireFiles.map((file) => file.path));

    for (const row of db.query({ key: { prefix: fileMetaPrefixFor(summary.id) } })) {
      const meta = row.value;
      if (meta.kind !== 'fileMeta') continue;
      if (seenPaths.has(meta.path)) continue;
      await this.deleteFileDocs(db, meta);
      await db.del(row.key);
    }

    const sourced = { ...summary, title, sessionIdentity: identity };
    let truncated = false;
    let failed = false;
    let error: string | undefined;
    for (const file of wireFiles) {
      const result = await this.syncWireFile(db, sourced, file, budget);
      if (result.truncated) truncated = true;
      if (result.failed) {
        failed = true;
        error ??= result.error;
      }
    }

    const titleKey = `${summary.id}/$title`;
    for (const row of db.query({ key: { prefix: `${summary.id}/$` }, project: [] })) {
      if (row.key !== titleKey) {
        await db.del(row.key);
        this.syncReplaced = true;
      }
    }
    const existing = db.get(titleKey);
    if (title.length > 0) {
      if (existing?.kind !== 'title' || existing.text !== title) {
        const doc: TitleDoc = {
          kind: 'title',
          sessionIdentity: identity,
          sessionId: summary.id,
          workspaceId: summary.workspaceId,
          sessionTitle: title,
          agentId: '',
          role: 'title',
          text: title,
          time: summary.updatedAt,
        };
        await db.set(titleKey, doc);
        if (existing !== undefined) this.syncReplaced = true;
      }
    } else if (existing !== undefined) {
      await db.del(titleKey);
    }
    const sessionMeta: SessionMetaDoc = {
      kind: 'sessionMeta',
      dir: summary.dir,
      identity,
      title,
      updatedAt: summary.updatedAt,
      sourceMtimeMs,
    };
    await db.set(SESSION_META_PREFIX + summary.id, sessionMeta);
    return { truncated, failed, error, unavailable: false };
  }

  private async deleteFileDocs(db: MiniDb<SearchDoc>, meta: FileMetaDoc): Promise<void> {
    const prefix = `${meta.sessionId}/${meta.agentId}/${meta.source}:`;
    for (const row of db.query({ key: { prefix }, project: [] })) {
      await db.del(row.key);
    }
  }

  private async syncWireFile(
    db: MiniDb<SearchDoc>,
    summary: SourcedSessionInput,
    file: WireFileRef,
    budget: SyncRoundBudget,
  ): Promise<SessionSyncResult> {
    let st: { size: number; mtimeMs: number; ino: number };
    try {
      st = await stat(file.path);
    } catch {
      return { truncated: false, failed: false, unavailable: false };
    }
    const size = st.size;
    const metaKey = fileMetaKey(summary.id, file.path);
    let meta = db.get(metaKey);
    let legacyKey: string | null = null;
    if (meta?.kind !== 'fileMeta') {
      const oldKey = legacyFileMetaKey(file.path);
      const legacy = db.get(oldKey);
      if (legacy?.kind === 'fileMeta') {
        meta = legacy;
        legacyKey = oldKey;
      }
    }
    const known = meta?.kind === 'fileMeta' ? meta : undefined;
    let offset = known?.offset ?? 0;
    let turnState: TurnCounterState = known?.turnState ?? initialTurnState();
    let stepState: StepTrackerState = known?.stepState ?? initialStepState();
    const fileMeta = (
      nextOffset: number,
      turns: TurnCounterState,
      steps: StepTrackerState,
    ): FileMetaDoc => ({
      kind: 'fileMeta',
      sessionId: summary.id,
      agentId: file.agentId,
      source: file.source,
      path: file.path,
      offset: nextOffset,
      size,
      mtimeMs: st.mtimeMs,
      ino: st.ino,
      turnState: turns,
      stepState: steps,
    });
    const legacyMeta = known !== undefined && known.stepState === undefined;
    const replacedFile = known?.ino !== undefined && known.ino !== st.ino;
    const rewrittenInPlace =
      known?.mtimeMs !== undefined && size === known.offset && st.mtimeMs > known.mtimeMs;
    if (size < offset || legacyMeta || replacedFile || rewrittenInPlace) {
      this.syncReplaced = true;
      await this.deleteFileDocs(db, fileMeta(0, initialTurnState(), initialStepState()));
      offset = 0;
      turnState = initialTurnState();
      stepState = initialStepState();
    }
    if (size === offset) {
      if (
        legacyKey !== null ||
        known === undefined ||
        known.size !== size ||
        known.mtimeMs !== st.mtimeMs ||
        known.ino !== st.ino ||
        known.offset !== offset
      ) {
        const ops: BatchInputOp<SearchDoc>[] = [
          { op: 'set', key: metaKey, value: fileMeta(offset, turnState, stepState) },
        ];
        if (legacyKey !== null) ops.push({ op: 'del', key: legacyKey });
        await db.batch(ops);
      }
      return { truncated: false, failed: false, unavailable: false };
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file.path, 'r');
    } catch (error) {
      return { truncated: false, failed: true, error: errorMessage(error), unavailable: false };
    }
    const ops: BatchInputOp<SearchDoc>[] = [];
    let byteCursor = offset;
    let position = offset;
    let wireError: unknown;
    try {
      let pending: Buffer = EMPTY_BUFFER;
      let finishing = false;
      const chunk = Buffer.allocUnsafe(WIRE_READ_CHUNK_BYTES);
      while (position < size) {
        if (this.disposed) {
          return { truncated: false, failed: false, unavailable: false };
        }
        if (syncBudgetExhausted(budget)) {
          if (pending.length === 0) break;
          finishing = true;
        }
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(
            chunk,
            0,
            Math.min(chunk.length, size - position),
            position,
          ));
        } catch (error) {
          wireError = error;
          break;
        }
        if (bytesRead === 0) break;
        budget.bytesLeft -= bytesRead;
        const slice = chunk.subarray(0, bytesRead);
        position += bytesRead;
        let start = 0;
        let completedRecord = false;
        for (;;) {
          const nl = slice.indexOf(0x0a, start);
          if (nl === -1) break;
          const lineBuf =
            pending.length > 0
              ? Buffer.concat([pending, slice.subarray(start, nl)])
              : slice.subarray(start, nl);
          pending = EMPTY_BUFFER;
          const lineOffset = byteCursor;
          byteCursor += lineBuf.length + 1;
          ({ turnState, stepState } = this.collectWireLine(
            ops,
            summary,
            file,
            lineBuf.toString('utf8'),
            lineOffset,
            { turnState, stepState },
          ));
          completedRecord = true;
          start = nl + 1;
        }
        pending =
          pending.length > 0
            ? Buffer.concat([pending, slice.subarray(start)])
            : Buffer.from(slice.subarray(start));
        if (finishing && completedRecord) break;
        if (ops.length >= WIRE_BATCH_OPS) {
          ops.push({ op: 'set', key: metaKey, value: fileMeta(byteCursor, turnState, stepState) });
          if (legacyKey !== null) {
            ops.push({ op: 'del', key: legacyKey });
            legacyKey = null;
          }
          await db.batch(ops);
          ops.length = 0;
        }
      }
    } finally {
      await handle.close();
    }

    const truncated = position < size && syncBudgetExhausted(budget);
    if (byteCursor !== offset || legacyKey !== null) {
      ops.push({ op: 'set', key: metaKey, value: fileMeta(byteCursor, turnState, stepState) });
      if (legacyKey !== null) ops.push({ op: 'del', key: legacyKey });
      await db.batch(ops);
    }
    return {
      truncated,
      failed: wireError !== undefined,
      error: wireError !== undefined ? errorMessage(wireError) : undefined,
      unavailable: false,
    };
  }

  /**
   * Turn/step counting and doc extraction for one complete wire line.
   * Returns the counter states advanced by the line (they are immutable and
   * replaced per line, so the caller threads them through the chunk loop).
   */
  private collectWireLine(
    ops: BatchInputOp<SearchDoc>[],
    summary: SourcedSessionInput,
    file: WireFileRef,
    line: string,
    lineOffset: number,
    counters: { turnState: TurnCounterState; stepState: StepTrackerState },
  ): { turnState: TurnCounterState; stepState: StepTrackerState } {
    let { turnState, stepState } = counters;
    const analysis = analyzeWireLine(line);
    const advanced = advanceTurnCounter(turnState, analysis.turn);
    if (
      analysis.turn.kind === 'open' ||
      analysis.turn.kind === 'undo' ||
      (analysis.turn.kind === 'ensure' && !turnState.hasTurn)
    ) {
      stepState = initialStepState();
    }
    turnState = advanced.state;
    stepState = advanceStepTracker(stepState, analysis.step);
    const extracted = analysis.messages;
    for (let i = 0; i < extracted.length; i++) {
      const e = extracted[i]!;
      const stepOrdinal = e.stepUuid !== undefined ? stepState.byUuid[e.stepUuid] : undefined;
      const doc: MessageDoc = {
        kind: 'message',
        sessionIdentity: summary.sessionIdentity,
        sessionId: summary.id,
        workspaceId: summary.workspaceId,
        sessionTitle: summary.title,
        agentId: file.agentId,
        role: e.role,
        text: e.text.length > MAX_DOC_TEXT_CHARS ? e.text.slice(0, MAX_DOC_TEXT_CHARS) : e.text,
        time: e.time ?? summary.updatedAt,
        turn: advanced.docTurn,
        stepId:
          advanced.docTurn !== undefined && stepOrdinal !== undefined
            ? `t${advanced.docTurn}.${stepOrdinal}`
            : undefined,
      };
      ops.push({
        op: 'set',
        key: `${docKeyPrefix(summary.id, file)}${lineOffset}:${i}`,
        value: doc,
      });
    }
    return { turnState, stepState };
  }

  /**
   * Serve one page from the currently published generation. Never waits for
   * an open, sync, reopen or reindex: with no published base it answers with
   * `building` semantics (or fails fast when the last open failed), and the
   * page-token generation check runs against the base pinned at request
   * time.
   */
  async search(params: CoreSearchParams): Promise<CoreSearchResult> {
    const { q, budgets } = params;
    const db = this.db;
    if (db === null) {
      if (this.disposed) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      if (this.openError !== null) {
        throw new GlobalSearchError(
          'index_unavailable',
          `search index failed to open: ${this.openError}`,
        );
      }
      if (params.pageToken !== undefined) {
        throw new GlobalSearchError(
          'invalid_page_token',
          'the search index is not ready yet; restart the search',
        );
      }
      return { kind: 'building', index: this.buildingView() };
    }

    let freshnessStale = false;
    let serveDb = db;
    if (serveDb.readOnly) {
      let fp: string | null = null;
      try {
        fp = await this.computeFingerprint();
      } catch (error) {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      }
      if (this.db === null) {
        throw new GlobalSearchError('index_unavailable', 'search service is disposed');
      }
      serveDb = this.db;
      if (serveDb.readOnly) {
        freshnessStale = fp === null || fp !== this.fingerprint || this.refreshPromise !== null;
        if (fp !== null && fp !== this.fingerprint) void this.refresh();
      }
    }
    const generation = this.tokenGeneration();
    const page = decodePageToken(q, 'index', params.pageToken, generation);

    if (serveDb.textIndexBuilding(q.mode === 'literal' ? TRI_INDEX_NAME : TEXT_INDEX_NAME)) {
      return { kind: 'building', index: this.buildingView(serveDb) };
    }

    let candidates: { key: string; value: SearchDoc | undefined; score: number }[];
    let incomplete: GlobalSearchIncomplete | undefined;
    const runBounded = (
      db2: MiniDb<SearchDoc>,
    ): Promise<{
      hits: { key: string; value: SearchDoc; score: number }[];
      visits: number;
      truncated: boolean;
    }> => {
      if (q.mode === 'literal') {
        return db2.searchBoundedAsync(TRI_INDEX_NAME, q.query, {
          op: 'AND',
          limit: budgets.literalCandidateCap + 1,
          maxVisits: budgets.postingsVisitBudget,
        });
      }
      return db2.searchBoundedAsync(TEXT_INDEX_NAME, q.query, {
        op: q.op,
        limit: budgets.maxTextHits + 1,
        maxVisits: budgets.postingsVisitBudget,
      });
    };
    try {
      let res: {
        hits: { key: string; value: SearchDoc; score: number }[];
        visits: number;
        truncated: boolean;
      };
      try {
        res = await runBounded(serveDb);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const closedRace =
          msg.includes('postings file is closed') ||
          msg.includes('MiniDb is closed') ||
          msg.includes('ValueReader is not open');
        if (!closedRace || this.db === null || this.db === serveDb) throw error;
        serveDb = this.db;
        res = await runBounded(serveDb);
      }
      if (q.mode === 'literal') {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > budgets.literalCandidateCap) {
          candidates.length = budgets.literalCandidateCap;
          incomplete ??= 'candidate_cap';
        }
      } else {
        candidates = res.hits;
        if (res.truncated) incomplete = 'postings_budget';
        if (candidates.length > budgets.maxTextHits) {
          candidates.length = budgets.maxTextHits;
          incomplete ??= 'candidate_cap';
        }
      }
    } catch (error) {
      if (error instanceof TextIndexBuildingError) {
        return { kind: 'building', index: this.buildingView(serveDb) };
      }
      if (error instanceof Error && error.message.includes('no such text index')) {
        return {
          kind: 'page',
          rows: [],
          hasMore: false,
          incomplete: undefined,
          generation,
          index: this.readIndexView(serveDb, freshnessStale),
        };
      }
      throw error;
    }

    const budget: MatchBudget = {
      deadlineAt: Date.now() + budgets.queryDeadlineMs,
      textCharsLeft: budgets.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    const matched = matchDocs(q, candidates, boundary, budget);
    incomplete ??= matched.incomplete;
    const visible = await this.verifyAgainstSources(serveDb, matched.rows, budget, {
      markStale: () => {
        freshnessStale = true;
      },
      markIncomplete: () => {
        incomplete ??= 'deadline';
      },
    });
    const { pageRows, hasMore } = paginateRows(q, page, visible);
    return {
      kind: 'page',
      rows: pageRows,
      hasMore,
      incomplete,
      generation,
      index: this.readIndexView(serveDb, freshnessStale || this.db !== serveDb),
    };
  }

  /**
   * Drop every hit whose session source no longer matches the facts recorded
   * at index time: the session's meta row must exist and agree with the doc's
   * `sessionIdentity`, and the session directory must still resolve to that
   * identity. Surviving rows carry the source-side title (never the live
   * summary map, which outlives a deleted session).
   */
  private async verifyAgainstSources(
    serveDb: MiniDb<SearchDoc>,
    rows: readonly MatchedRow[],
    budget: MatchBudget,
    marks: { markStale: () => void; markIncomplete: () => void },
  ): Promise<MatchedRow[]> {
    const sources = new Map<string, SessionMetaDoc | undefined>();
    for (const row of rows) {
      const id = row.value.sessionId;
      if (sources.has(id)) continue;
      if (Date.now() > budget.deadlineAt) {
        marks.markIncomplete();
        break;
      }
      const meta = serveDb.get(SESSION_META_PREFIX + id);
      sources.set(id, meta?.kind === 'sessionMeta' ? meta : undefined);
    }

    const identities = new Map<string, string | undefined>();
    const visible: MatchedRow[] = [];
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      deadlineTimer = setTimeout(() => {
        resolve(null);
      }, Math.max(0, budget.deadlineAt - Date.now()));
      deadlineTimer.unref?.();
    });
    try {
      for (const row of rows) {
        if (Date.now() > budget.deadlineAt) {
          marks.markIncomplete();
          break;
        }
        const meta = sources.get(row.value.sessionId);
        if (
          meta?.dir === undefined ||
          row.value.sessionIdentity === undefined ||
          meta.identity !== row.value.sessionIdentity
        ) {
          marks.markStale();
          continue;
        }
        if (!identities.has(meta.dir)) {
          let identity: string | undefined | null;
          const pending = sessionDirectoryIdentity(meta.dir);
          pending.catch(() => undefined);
          try {
            identity = await Promise.race([pending, deadline]);
          } catch (error) {
            throw new GlobalSearchError(
              'index_unavailable',
              `cannot verify search source: ${errorMessage(error)}`,
            );
          }
          if (identity === null || Date.now() > budget.deadlineAt) {
            marks.markIncomplete();
            break;
          }
          identities.set(meta.dir, identity);
        }
        if (identities.get(meta.dir) === row.value.sessionIdentity) {
          visible.push({ ...row, value: { ...row.value, sessionTitle: meta.title ?? '' } });
        } else {
          marks.markStale();
        }
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    return visible;
  }

  /**
   * Full rebuild: close the handle, wipe the directory and reopen. The
   * caller (the service) blocks new sync passes beforehand and runs the
   * authoritative sync afterwards.
   */
  async reindex(): Promise<void> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      throw new GlobalSearchError(
        'readonly_index',
        'another process holds the search-index write lock; reindex from that process',
      );
    }
    await this.refreshPromise?.catch(() => {});
    const db = this.db;
    if (db) {
      await db.close().catch(() => {});
      this.db = null;
    }
    this.openPromise = null;
    this.fullSyncDone = false;
    this.sessionSyncFailures.clear();
    this.sessionSyncSkips.clear();
    this.lockToken = undefined;
    this.wireFileSnapshots.clear();
    const outcome = await wipeStoreDir({ dir: this.indexDir });
    if (outcome === 'locked') {
      throw new GlobalSearchError(
        'readonly_index',
        'another process holds the search-index write lock; reindex from that process',
      );
    }
    await this.ensureOpen();
  }

  /**
   * Synchronous lifecycle snapshot (stage 5) — never kicks an open, never
   * awaits: the diagnostic view of `stopped → opening → ready →
   * building/degraded → closing`. 'degraded' means NO base is serving (the
   * last open failed); a published base that keeps serving after a failed
   * background refresh stays 'ready' — the failure rides the `degraded`
   * message field of the page/status surfaces, same as the per-page
   * `indexState` discipline.
   */
  lifecycleState(): CoreLifecycleReport {
    if (this.disposed) return { state: this.db === null ? 'stopped' : 'closing' };
    const db = this.db;
    if (db !== null) this.noteMaintenanceDetail(db);
    if (db === null) {
      if (this.openPromise !== null) return { state: 'opening' };
      if (this.openError !== null) return { state: 'degraded', detail: this.openError };
      return { state: 'stopped' };
    }
    if (db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME)) {
      return { state: 'building' };
    }
    return { state: 'ready' };
  }

  /**
   * The store's own maintenance failures (compaction, generation build). They
   * do not stop searches, but nothing recovers them on its own: the WAL grows
   * until one succeeds, so they must be visible.
   */
  private maintenanceDetail(db: MiniDb<SearchDoc>): string | undefined {
    const failure = db.lastCompactError ?? db.lastGenBuildError;
    return failure === null || failure === undefined ? undefined : errorMessage(failure);
  }

  private noteMaintenanceDetail(db: MiniDb<SearchDoc>): void {
    const detail = this.maintenanceDetail(db);
    if (detail === this.lastMaintenanceDetail) return;
    const previous = this.lastMaintenanceDetail;
    this.lastMaintenanceDetail = detail;
    if (detail !== undefined) {
      this.log.warn(
        'global search: index maintenance is failing; the WAL keeps growing until it recovers',
        { error: detail },
      );
    } else if (previous !== undefined) {
      this.log.info('global search: index maintenance recovered');
    }
  }

  async status(): Promise<CoreStatus> {
    await this.ensureOpen();
    if (this.db?.readOnly === true) {
      await this.refresh();
    }
    const stats = this.db?.get(STATS_KEY);
    const maintenance =
      this.db !== null && this.db !== undefined ? this.maintenanceDetail(this.db) : undefined;
    return {
      sessions: stats?.kind === 'stats' ? stats.sessions : 0,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      lastIndexedAt: stats?.kind === 'stats' ? stats.lastIndexedAt : null,
      generation: this.generation,
      readOnly: this.db?.readOnly === true,
      lockToken: this.lockToken,
      degraded: this.lastRefreshError?.message ?? statsDegraded(stats) ?? maintenance,
      lifecycle: this.lifecycleState(),
    };
  }

  /** The view served while no queryable base is available. */
  private buildingView(db?: MiniDb<SearchDoc>): CoreIndexView {
    const handle = db ?? this.db;
    const stats = handle?.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    return {
      state: 'building',
      indexedSessions: indexed,
      documents: stats?.kind === 'stats' ? stats.documents : 0,
      readOnly: handle?.readOnly === true,
      freshnessStale: true,
      degraded: this.lastRefreshError?.message ?? statsDegraded(stats),
      lockToken: this.lockToken,
    };
  }

  private readIndexView(db: MiniDb<SearchDoc>, freshnessStale: boolean): CoreIndexView {
    const stats = db.get(STATS_KEY);
    const indexed = stats?.kind === 'stats' ? stats.sessions : 0;
    const documents = stats?.kind === 'stats' ? stats.documents : 0;
    const building = db.textIndexBuilding(TEXT_INDEX_NAME) || db.textIndexBuilding(TRI_INDEX_NAME);
    return {
      state: building ? 'building' : db.readOnly ? 'readonly' : this.fullSyncDone ? 'ready' : 'building',
      indexedSessions: indexed,
      documents,
      readOnly: db.readOnly,
      freshnessStale,
      degraded: this.lastRefreshError?.message ?? statsDegraded(stats),
      lockToken: this.lockToken,
    };
  }
}

function statsDegraded(stats: SearchDoc | undefined): string | undefined {
  return stats?.kind === 'stats' ? stats.degraded : undefined;
}

async function sessionSourceMtime(sessionDir: string): Promise<number | undefined> {
  for (const path of [join(sessionDir, 'state.json'), join(sessionDir, 'session-meta', 'state.json')]) {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
    }
  }
  return undefined;
}

interface WireFileRef {
  readonly path: string;
  readonly agentId: string;
  readonly source: 'root' | 'agents';
}

interface DirectoryFingerprint {
  readonly path: string;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

interface WireFileSnapshot {
  readonly agentsDir: string;
  readonly capturedAt: number;
  readonly directories: readonly DirectoryFingerprint[];
  readonly files: readonly WireFileRef[];
}

const WIRE_FILE_SNAPSHOT_CAPACITY = 512;
const WIRE_FILE_SNAPSHOT_TTL_MS = 60_000;
const WIRE_FILE_STAT_CONCURRENCY = 16;

async function collectWireFiles(
  sessionId: string,
  sessionDir: string,
  snapshots: Map<string, WireFileSnapshot>,
): Promise<WireFileRef[]> {
  const files: WireFileRef[] = [];
  const root = join(sessionDir, WIRE_FILENAME);
  try {
    if ((await stat(root)).isFile()) files.push({ path: root, agentId: 'main', source: 'root' });
  } catch {
  }
  const agentsDir = join(sessionDir, 'agents');
  try {
    const cached = snapshots.get(sessionId);
    if (
      cached?.agentsDir === agentsDir &&
      Date.now() - cached.capturedAt < WIRE_FILE_SNAPSHOT_TTL_MS &&
      await directoryFingerprintIntact(cached.directories) &&
      await wireFilesIntact(cached.files)
    ) {
      files.push(...cached.files);
      return files;
    }
    const entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
    const agentFiles: WireFileRef[] = [];
    const directoryPaths = [agentsDir];
    for (const entry of entries) {
      const entryPath = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) directoryPaths.push(entryPath);
      if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
      agentFiles.push({ path: entryPath, agentId: relative(agentsDir, entry.parentPath), source: 'agents' });
    }
    const directories = await readDirectoryFingerprints(directoryPaths);
    if (directories === undefined) throw new Error(`unable to fingerprint ${agentsDir}`);
    snapshots.delete(sessionId);
    snapshots.set(sessionId, {
      agentsDir,
      capturedAt: Date.now(),
      directories,
      files: agentFiles,
    });
    while (snapshots.size > WIRE_FILE_SNAPSHOT_CAPACITY) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    files.push(...agentFiles);
  } catch {
    snapshots.delete(sessionId);
  }
  return files;
}

async function readDirectoryFingerprints(
  paths: readonly string[],
): Promise<DirectoryFingerprint[] | undefined> {
  const fingerprints = await mapConcurrent(paths, WIRE_FILE_STAT_CONCURRENCY, async (path) => {
    try {
      const info = await stat(path);
      return info.isDirectory()
        ? { path, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino }
        : undefined;
    } catch {
      return undefined;
    }
  });
  return fingerprints.some((fingerprint) => fingerprint === undefined)
    ? undefined
    : fingerprints as DirectoryFingerprint[];
}

async function directoryFingerprintIntact(
  fingerprints: readonly DirectoryFingerprint[],
): Promise<boolean> {
  const current = await readDirectoryFingerprints(fingerprints.map((fingerprint) => fingerprint.path));
  return current !== undefined && current.every((fingerprint, index) => {
    const previous = fingerprints[index]!;
    return fingerprint.mtimeMs === previous.mtimeMs &&
      fingerprint.ctimeMs === previous.ctimeMs &&
      fingerprint.ino === previous.ino;
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

async function wireFilesIntact(files: readonly WireFileRef[]): Promise<boolean> {
  let next = 0;
  let intact = true;
  await Promise.all(
    Array.from({ length: Math.min(WIRE_FILE_STAT_CONCURRENCY, files.length) }, async () => {
      while (intact) {
        const index = next;
        next += 1;
        if (index >= files.length) return;
        try {
          if (!(await stat(files[index]!.path)).isFile()) intact = false;
        } catch {
          intact = false;
        }
      }
    }),
  );
  return intact;
}

function docKeyPrefix(sessionId: string, file: WireFileRef): string {
  return `${sessionId}/${file.agentId}/${file.source}:`;
}

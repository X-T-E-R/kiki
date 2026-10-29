import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';

import {
  createDecorator,
  IBootstrapService,
  IConfigService,
  IEventService,
  IFlagService,
  ILogService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  registerFlagDefinition,
  registerScopedService,
  sessionDirOf,
  workspacePersistenceScope,
  type IDisposable,
  type SessionSummary,
} from '@kiki/agent-core-v2';
import { normalizeLiteral, tokenize } from '@kiki/lexical';
import type { SearchMessagesResponse } from '../protocol/rest-search';
import type { TranscriptStore } from '@kiki/transcript';
import { LiveSearch } from './liveSearch';
import type { HistoryLocatorStore } from '../services/history/historyLocatorStore';

import {
  GlobalSearchError,
  type GlobalSearchHit,
  type GlobalSearchPage,
  type GlobalSearchUnavailableReason,
  type GlobalSearchQuery,
} from './contract';
import type { SqliteSessionInput } from './sqlite/index';
import { decodePageToken, type MatchedRow, type NormalizedQuery, type SearchBudgets } from './match';
import { makeSnippet } from './snippet';
import { SearchIndexStateChanged } from './events';
import { planHistoryQuery } from '../services/history/historyQuery';
import { SEARCH_BACKEND_SECTION, type SearchConfig } from './searchConfig';
import { SqliteSearchHost } from './sqlite/host';

export { GlobalSearchError } from './contract';
export type { GlobalSearchErrorReason } from './contract';

const SESSION_PAGE_SIZE = 500;
const CHANGED_SESSION_PAGE_SIZE = 100;
const SESSION_MTIME_CONCURRENCY = 16;
const FULL_SESSION_SCAN_INTERVAL_MS = 30 * 60_000;
const SESSION_SOURCE_SCAN_INTERVAL_MS = 10 * 60_000;

const MAX_QUERY_TERMS = 32;
const MAX_LITERAL_QUERY_CHARS = 1_024;
const MAX_POSTINGS_VISITS = 250_000;
const QUERY_DEADLINE_MS = 500;
const QUERY_TEXT_BUDGET_CHARS = 16_000_000;
const MAX_TEXT_HITS = 100_000;
const LITERAL_CANDIDATE_CAP = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerFlagDefinition({
  id: 'desktop_search',
  title: 'desktop content search',
  description: 'Enable the SQLite content search index in the desktop runtime after its selfcheck.',
  env: 'KIKI_EXPERIMENTAL_DESKTOP_SEARCH',
  default: true,
  surface: 'core',
});

const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
}

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  /** Full rebuild: wipe the index and rescan every wire file. */
  reindex(): Promise<{ sessions: number; documents: number }>;
  /** Reset the SQLite indexer's retry backoff after a user-requested retry. */
  retryIndexer(): void;
  /**
   * Diagnostic status (the `/api/debug` surface reflects it). Never
   * throws: a backend that cannot answer (failed open, worker down) reports
   * a degraded lifecycle instead of rejecting. `lifecycle` is the aggregate
   * state machine (stage 5): stopped → opening → ready → building/degraded →
   * closing. NOTE the historical contract: the call may kick/await the
   * backend's open and read-only refresh — use `lifecycleReport()` for a
   * non-intrusive local read.
   */
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    /** Identity of the published base; bumps invalidate v2 page tokens. */
    generation: number;
    /** Last background refresh/sync/reindex failure, if serving stale. */
    degraded?: string;
    lifecycle: SearchLifecycleReport;
    indexer?: ReturnType<SqliteSearchHost['snapshot']>;
  }>;
  /**
   * Synchronous local lifecycle report (stage 5): never kicks an open, never
   * spawns the worker, never awaits. Answers the transitional states
   * (stopped/opening/degraded-backoff/closing) that status() would block on.
   */
  lifecycleReport(): SearchLifecycleReport;
  /**
   * Wire the live-transcript source for the in-memory search route. Called
   * once from the composition root (start.ts) after `TranscriptService` is
   * constructed; until then every search takes the index route.
   */
  setLiveTranscriptSource(source: LiveTranscriptSource, navigation?: Pick<HistoryLocatorStore, 'scan'>): void;
}

export const IGlobalSearchService = createDecorator<IGlobalSearchService>('globalSearch');

/**
 * Structural contract implemented by `TranscriptService` without importing
 * its dependency stack. Search uses the live store and readiness, never the
 * source's history materialization method.
 */
export interface LiveTranscriptSource {
  /** Transcript store of a session live in this process; undefined when not in memory. */
  forSessionLive(sessionId: string): TranscriptStore | undefined;
  /** Resolves when the session's initial history backfill has landed. */
  whenReady(sessionId: string): Promise<void>;
  /** Return the request's live or dormant history projection. */
  ensureAgentHistory(sessionId: string, agentId: string, options?: { readonly fullHistory?: boolean }): Promise<import('@kiki/transcript').AgentTranscript | undefined>;
}

function normalizeQuery(input: GlobalSearchQuery, maxQueryTerms: number): NormalizedQuery {
  const mode = input.mode ?? 'terms';
  const query = mode === 'literal' ? input.query : input.query.trim();
  if (query.length === 0) {
    throw new GlobalSearchError('invalid_query', 'query must be a non-empty string');
  }
  if (input.historyMode !== undefined && (mode !== 'terms' || input.indexOnly !== true ||
      input.workspaceId === undefined || input.role === 'title')) {
    throw new GlobalSearchError('invalid_query', 'history phrase matching requires scoped indexed terms');
  }
  const historyPlan = input.historyMode === undefined ? undefined : planHistoryQuery(query, input.historyMode);
  const literalQuery = mode === 'literal' ? normalizeLiteral(query) : undefined;
  const termsQuery = mode === 'terms' ? [...new Set(historyPlan === undefined ? tokenize(query) :
    historyPlan.clauses.flatMap((clause) => tokenize(clause.text)))] : undefined;
  if (termsQuery !== undefined && termsQuery.length > maxQueryTerms) {
    throw new GlobalSearchError(
      'invalid_query',
      `query has too many terms (${termsQuery.length} > ${maxQueryTerms}); narrow it down`,
    );
  }
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new GlobalSearchError('invalid_query', 'pageSize must be an integer between 1 and 50');
  }
  return {
    query,
    mode,
    literalQuery,
    termsQuery,
    historyPlan,
    op: historyPlan === undefined ? input.op ?? 'AND' : 'OR',
    container: input.container,
    workspaceId: input.workspaceId,
    role: input.role,
    includeToolOutput: input.includeToolOutput === true || input.role === 'tool',
    startTime: input.startTime,
    endTime: input.endTime,
    sort: input.sort ?? 'score',
    pageSize,
  };
}

export interface SearchLifecycleReport {
  readonly state: 'stopped' | 'opening' | 'building' | 'ready' | 'degraded' | 'closing';
  readonly detail?: string;
}

export class GlobalSearchService implements IGlobalSearchService {
  declare readonly _serviceBrand: undefined;

  /** Minimum interval between search-triggered sync passes (test knob). */
  syncDebounceMs = 2_000;
  fullSessionScanIntervalMs = FULL_SESSION_SCAN_INTERVAL_MS;
  sourceStatIntervalMs = SESSION_SOURCE_SCAN_INTERVAL_MS;

  /** Literal-mode candidate cap (test knob, see LITERAL_CANDIDATE_CAP). */
  literalCandidateCap = LITERAL_CANDIDATE_CAP;

  /** Terms-mode candidate cap (test knob, see MAX_TEXT_HITS). */
  maxTextHits = MAX_TEXT_HITS;

  /** Postings-visit budget per query (test knob, see MAX_POSTINGS_VISITS). */
  postingsVisitBudget = MAX_POSTINGS_VISITS;

  /** Query wall-clock budget, including live preparation (test knob). */
  queryDeadlineMs = QUERY_DEADLINE_MS;

  /** Literal-confirmation text-volume budget per query (test knob). */
  queryTextBudgetChars = QUERY_TEXT_BUDGET_CHARS;

  /** Max distinct query terms in terms mode (test knob). */
  maxQueryTerms = MAX_QUERY_TERMS;

  private lastEmittedIndexState = '';
  private readonly sqliteHost: SqliteSearchHost;
  private readonly sqliteDisabled: boolean;
  private syncPromise: Promise<void> | null = null;
  private lastSyncStartedAt = 0;
  private lastFullSessionScanAt = 0;
  private lastSourceScanAt = 0;
  private summaries = new Map<string, SessionSummary>();
  private sessionSourceMtimes = new Map<string, number>();
  private readonly dirtySessions = new Map<string, number>();
  private readonly forceSessionSyncs = new Set<string>();
  private watchRevision = 0;
  private sourceWatcher: FSWatcher | null = null;
  private nextWatchRetryAt = 0;
  private disposed = false;
  private resolveSyncStop!: () => void;
  private readonly syncStop = new Promise<void>((resolve) => {
    this.resolveSyncStop = resolve;
  });
  /** Set while `reindex()` swaps the db — syncs started meanwhile are no-ops. */
  private reindexing = false;
  /** Live-transcript source for the in-memory route; null until start.ts wires it. */
  private liveSource: LiveTranscriptSource | null = null;
  /** One queued follow-up pass behind the in-flight one (backpressure). */
  private syncQueued = false;
  private syncSkippedForReadiness = false;
  private sessionIndexStatusWaiter: IDisposable | null = null;
  /** Trailing-pass timer behind the debounce window. */
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last background sync/reindex/worker failure — surfaced as degraded. */
  private lastRefreshError: { at: number; message: string } | null = null;
  /** Set when dispose()'s async drain finished — lifecycle 'stopped'. */
  private drainSettled = false;

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config?: IConfigService,
    @IEventService private readonly events?: IEventService,
  ) {
    const search = this.config?.get<SearchConfig>('search');
    const backend = process.env['KIKI_SEARCH_BACKEND'] ?? this.config?.get<string>(SEARCH_BACKEND_SECTION) ?? 'sqlite';
    this.sqliteDisabled = search?.enabled === false || process.env['KIKI_SEARCH_DISABLED'] === '1' ||
      (process.env['KIKI_DESKTOP_BUNDLED'] === '1' && !this.flags.enabled('desktop_search'));
    if (backend === 'minidb') {
      this.log.warn('global search: minidb is a deprecated alias for sqlite; remove search_backend or set it to sqlite, and unset KIKI_SEARCH_BACKEND=minidb before 0.6. The old search-index directory is preserved; SQLite uses search-index-v2 or rebuilds from canonical sessions. Explicit search disable settings remain in effect.');
    }
    this.sqliteHost = new SqliteSearchHost({
      database: join(this.bootstrap.homeDir, 'search-index-v2', 'index.sqlite'),
      indexSubagents: search?.index_subagents === true,
      onStateChange: (snapshot) => {
        if (this.disposed) return;
        const state: SearchMessagesResponse['index_state'] = {
          state: snapshot.state, reason: snapshot.reason,
          indexed_sessions: snapshot.indexedSessions, total_sessions: snapshot.totalSessions,
          documents: snapshot.documents, stale: snapshot.stale,
        };
        const key = JSON.stringify(state);
        if (key === this.lastEmittedIndexState) return;
        this.lastEmittedIndexState = key;
        this.events?.publish(new SearchIndexStateChanged({ payload: state }));
      },
    });
  }

  private readonly liveSearch = new LiveSearch();
  private liveNavigation?: Pick<HistoryLocatorStore, 'scan'>;

  setLiveTranscriptSource(source: LiveTranscriptSource, navigation?: Pick<HistoryLocatorStore, 'scan'>): void {
    this.liveSource = source;
    this.liveNavigation = navigation;
    this.liveSearch.clear();
    this.requestSync();
  }

  private ensureSourceWatcher(): void {
    if (this.sourceWatcher !== null || this.disposed || Date.now() < this.nextWatchRetryAt) return;
    try {
      const watcher = watch(join(this.bootstrap.homeDir, this.bootstrap.scope('sessions')), {
        recursive: true,
        persistent: false,
      }, (_event, filename) => {
        const parts = filename?.toString().split(/[\\/]/);
        if (parts === undefined || parts.length < 2) {
          this.lastSourceScanAt = 0;
        } else {
          this.dirtySessions.set(parts[1]!, ++this.watchRevision);
          if (parts.includes('agents') || parts.at(-1) === 'wire.jsonl') {
            this.forceSessionSyncs.add(parts[1]!);
          }
        }
        this.requestSync();
      });
      watcher.on('error', (error: unknown) => {
        this.log.warn('global search: session source watch failed; using periodic stat scan', {
          error: errorMessage(error),
        });
        watcher.close();
        if (this.sourceWatcher === watcher) this.sourceWatcher = null;
        this.nextWatchRetryAt = Date.now() + this.sourceStatIntervalMs;
        this.lastSourceScanAt = 0;
      });
      this.sourceWatcher = watcher;
    } catch {
      this.nextWatchRetryAt = Date.now() + this.sourceStatIntervalMs;
    }
  }

  private toSyncInput(summary: SessionSummary): SqliteSessionInput {
    return {
      id: summary.id,
      workspaceId: summary.workspaceId,
      title: summary.title,
      updatedAt: summary.updatedAt,
      dir: sessionDirOf(
        this.bootstrap.homeDir,
        workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
        summary.id,
      ),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.liveSearch.clear();
    this.resolveSyncStop();
    this.clearSessionIndexStatusWaiter();
    this.sourceWatcher?.close();
    this.sourceWatcher = null;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const closing = this.sqliteHost.close();
    const pending = (async () => {
      await this.syncPromise?.catch(() => {});
      await closing;
      this.drainSettled = true;
    })();
    pendingDisposals.add(pending);
    pending.finally(() => pendingDisposals.delete(pending)).catch(() => {});
  }

  private requestSync(): void {
    if (this.disposed || this.reindexing || this.sqliteDisabled) return;
    if (this.syncPromise !== null) {
      this.syncQueued = true;
      return;
    }
    const wait = this.syncDebounceMs - (Date.now() - this.lastSyncStartedAt);
    if (wait > 0) {
      this.scheduleSync(wait);
      return;
    }
    this.startSyncPass();
  }

  private scheduleSync(wait: number): void {
    if (this.syncTimer !== null || this.disposed || this.reindexing) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.requestSync();
    }, wait);
    this.syncTimer.unref?.();
  }

  private clearSessionIndexStatusWaiter(): void {
    const waiter = this.sessionIndexStatusWaiter;
    this.sessionIndexStatusWaiter = null;
    const disposed = waiter?.dispose();
    if (!(disposed instanceof Promise)) return;
    pendingDisposals.add(disposed);
    disposed.finally(() => pendingDisposals.delete(disposed)).catch(() => {});
  }

  private sessionIndexUsable(status: ReturnType<ISessionIndex['status']>): boolean {
    return status.source === 'authoritative' || status.state === 'ready';
  }

  private waitForSessionIndexReady(): void {
    if (this.sessionIndexStatusWaiter !== null || this.disposed) return;
    const handleStatus = (status: ReturnType<ISessionIndex['status']>): void => {
      if (!this.sessionIndexUsable(status) || this.disposed) return;
      this.clearSessionIndexStatusWaiter();
      this.requestSync();
    };
    this.sessionIndexStatusWaiter = this.sessionIndex.onDidChangeStatus(handleStatus);
    handleStatus(this.sessionIndex.status());
  }

  private startSyncPass(): void {
    this.syncQueued = false;
    this.syncSkippedForReadiness = false;
    void this.ensureSyncStarted().then(
      () => {
        if (!this.syncSkippedForReadiness) this.lastRefreshError = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          this.requestSync();
        }
      },
      (error: unknown) => {
        if (this.sqliteDisabled || this.disposed) return;
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
        this.log.warn('global search: background sync failed', { error: errorMessage(error) });
      },
    );
  }

  /** Single-flight: concurrent callers share the in-flight sync. */
  private ensureSyncStarted(): Promise<void> {
    if (this.syncPromise === null) {
      const p = this.runSync().finally(() => {
        if (this.syncPromise === p) this.syncPromise = null;
      });
      this.syncPromise = p;
    }
    return this.syncPromise;
  }

  private async runSync(): Promise<void> {
    if (this.disposed || this.reindexing || this.sqliteDisabled) return;
    const indexStatus = await Promise.race([this.sessionIndex.prepare(), this.syncStop]);
    if (indexStatus === undefined || this.disposed || this.reindexing) return;
    if (!this.sessionIndexUsable(indexStatus)) {
      this.syncSkippedForReadiness = true;
      this.waitForSessionIndexReady();
      return;
    }
    this.clearSessionIndexStatusWaiter();
    const dirtyAtStart = new Map(this.dirtySessions);
    const sessions = await this.listSessionsForSync();
    if (this.disposed) return;
    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    this.lastSyncStartedAt = Date.now();
    this.sqliteHost.sync(sessions.map((s) => this.toSyncInput(s)));
    this.ensureSourceWatcher();
    for (const [id, revision] of dirtyAtStart) {
      if (this.dirtySessions.get(id) === revision) {
        this.dirtySessions.delete(id);
        this.forceSessionSyncs.delete(id);
      }
    }
  }

  private async listSessionsForSync(): Promise<SessionSummary[]> {
    if (
      this.summaries.size === 0 ||
      Date.now() - this.lastFullSessionScanAt >= this.fullSessionScanIntervalMs
    ) {
      return this.refreshFullSessionInventory();
    }
    const count = await this.sessionIndex.count({});
    if (count !== this.summaries.size) return this.refreshFullSessionInventory();
    const fullStat = Date.now() - this.lastSourceScanAt >= this.sourceStatIntervalMs;
    const candidates = [...this.summaries.values()].filter(
      (summary) => fullStat || this.dirtySessions.has(summary.id),
    );
    const sampled = await this.readSessionSourceMtimes(candidates);
    if (sampled === undefined) return this.refreshFullSessionInventory();
    const merged = new Map(this.summaries);
    for (const [id, mtimeMs] of sampled) {
      if (this.sessionSourceMtimes.get(id) === mtimeMs && !this.dirtySessions.has(id)) continue;
      const summary = await this.sessionIndex.get(id);
      if (summary === undefined) return this.refreshFullSessionInventory();
      merged.set(id, summary);
    }
    const newest = [...this.summaries.values()].reduce((current, summary) =>
      compareSessionRecency(summary, current) > 0 ? summary : current,
    );
    let cursor: string | undefined;
    let reachedWatermark = false;
    do {
      const page = await this.sessionIndex.listRecent({
        before: cursor,
        limit: CHANGED_SESSION_PAGE_SIZE,
      });
      for (const summary of page.items) {
        if (compareSessionRecency(summary, newest) <= 0) {
          reachedWatermark = true;
          break;
        }
        merged.set(summary.id, summary);
      }
      cursor = page.nextCursor;
    } while (!reachedWatermark && cursor !== undefined);
    if (!reachedWatermark) return this.refreshFullSessionInventory();
    for (const [id, mtimeMs] of sampled) this.sessionSourceMtimes.set(id, mtimeMs);
    if (fullStat) this.lastSourceScanAt = Date.now();
    return [...merged.values()];
  }

  private async refreshFullSessionInventory(): Promise<SessionSummary[]> {
    const sessions = await this.listAllSessions();
    const mtimes = await this.readSessionSourceMtimes(sessions);
    this.sessionSourceMtimes = mtimes ?? new Map();
    this.lastSourceScanAt = mtimes === undefined ? 0 : Date.now();
    this.lastFullSessionScanAt = Date.now();
    return sessions;
  }

  private async readSessionSourceMtimes(
    sessions: readonly SessionSummary[],
  ): Promise<Map<string, number> | undefined> {
    const rows = await mapConcurrent(sessions, SESSION_MTIME_CONCURRENCY, async (summary) => {
      const mtimeMs = await sessionSourceMtime(this.toSyncInput(summary).dir);
      return mtimeMs === undefined ? undefined : [summary.id, mtimeMs] as const;
    });
    if (rows.some((row) => row === undefined)) return undefined;
    return new Map(rows as Array<readonly [string, number]>);
  }

  private async listAllSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sessionIndex.listRecent({ before: cursor, limit: SESSION_PAGE_SIZE });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  /**
   * Route: a container-scoped query on a session that is live in this process
   * scans bounded resident text and canonical history unless indexOnly is set,
   * in both terms and literal mode. Anything else takes the index route. The live route
   * never falls back on error — the store being in hand means the session is
   * alive, so a scan failure is a real error, not a degradation signal.
   */
  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const deadlineAt = Date.now() + this.queryDeadlineMs;
    input.signal?.throwIfAborted();
    const q = normalizeQuery(input, this.maxQueryTerms);
    if (this.disposed) throw new GlobalSearchError('index_unavailable', 'search service is disposed');
    if (this.sqliteDisabled) return this.unavailablePage('disabled');
    const sessionId = q.container?.sessionId;
    const liveStore = sessionId !== undefined && input.indexOnly !== true
      ? this.liveSource?.forSessionLive(sessionId) : undefined;
    if (liveStore !== undefined && sessionId !== undefined) {
      return this.searchLive(q, sessionId, liveStore, input.pageToken, deadlineAt, input.signal);
    }
    return this.searchIndex(q, input.pageToken);
  }

  private async searchLive(
    q: NormalizedQuery,
    sessionId: string,
    store: TranscriptStore,
    pageToken: string | undefined,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<GlobalSearchPage> {
    const source = this.liveSource;
    if (source === null) throw new GlobalSearchError('index_unavailable', 'live transcript source is not wired');
    return this.liveSearch.search({ query: q, sessionId, store, pageToken, signal, deadlineAt,
      textBudget: this.queryTextBudgetChars, maxHits: this.maxTextHits,
      ready: () => source.whenReady(sessionId), summary: () => this.sessionIndex.get(sessionId),
      navigation: this.liveNavigation });
  }

  private budgets(): SearchBudgets {
    return {
      literalCandidateCap: this.literalCandidateCap,
      maxTextHits: this.maxTextHits,
      postingsVisitBudget: this.postingsVisitBudget,
      queryDeadlineMs: this.queryDeadlineMs,
      queryTextBudgetChars: this.queryTextBudgetChars,
    };
  }

  private async searchIndex(
    q: NormalizedQuery,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    if (q.mode === 'literal') {
      const literalLength = Array.from(q.literalQuery ?? '').length;
      if (literalLength < 2) {
        throw new GlobalSearchError(
          'invalid_query',
          'literal queries need at least 2 characters (after Unicode normalization)',
        );
      }
      if (literalLength > MAX_LITERAL_QUERY_CHARS) {
        throw new GlobalSearchError(
          'invalid_query',
          `literal queries are limited to ${MAX_LITERAL_QUERY_CHARS} characters`,
        );
      }
    }

    return this.searchSqlite(q, pageToken);
  }

  private async searchSqlite(q: NormalizedQuery, pageToken?: string): Promise<GlobalSearchPage> {
    if (pageToken !== undefined) decodePageToken(q, 'index', pageToken, undefined);
    if (this.sqliteDisabled) return this.unavailablePage('disabled');
    const host = this.sqliteHost!;
    this.requestSync();
    const before = host.snapshot();
    if (before.reason === 'corrupt_rebuilding') return this.sqliteBuildingPage(before);
    if (process.env['KIKI_DESKTOP_BUNDLED'] === '1' && before.indexerStatus === undefined) {
      return before.reason ? this.unavailablePage(before.reason) : this.sqliteBuildingPage(before);
    }
    try {
      const result = await host.search(q, pageToken, this.budgets());
      const snapshot = host.snapshot();
      return {
        items: result.rows.map((row) => this.projectHit(q, row)),
        hasMore: result.hasMore,
        pageToken: result.pageToken,
        incomplete: result.incomplete,
        indexState: { state: snapshot.state, reason: snapshot.reason,
          indexedSessions: snapshot.indexedSessions, totalSessions: snapshot.totalSessions,
          documents: snapshot.documents, stale: result.stale || undefined },
        unavailable: snapshot.state === 'unavailable' || undefined,
        source: 'index',
      };
    } catch (error) {
      if (error instanceof GlobalSearchError && error.reason === 'invalid_page_token') throw error;
      const snapshot = host.snapshot();
      if (snapshot.reason === 'corrupt_rebuilding' || snapshot.state === 'building') return this.sqliteBuildingPage(snapshot);
      return this.unavailablePage(snapshot.reason ?? 'sqlite_unavailable', errorMessage(error));
    }
  }

  private sqliteBuildingPage(snapshot: ReturnType<SqliteSearchHost['snapshot']>): GlobalSearchPage {
    return { items: [], hasMore: false, source: 'index', indexState: {
      state: 'building', indexedSessions: snapshot.indexedSessions,
      totalSessions: snapshot.totalSessions, documents: snapshot.documents, stale: true,
    } };
  }

  private projectHit(q: NormalizedQuery, row: MatchedRow): GlobalSearchHit {
    const doc = row.value;
    return {
      sessionId: doc.sessionId,
      workspaceId: doc.workspaceId,
      sessionTitle: doc.sessionTitle,
      agentId: doc.agentId,
      role: doc.role,
      snippet:
        doc.kind === 'title'
          ? doc.text
          : row.anchor !== undefined && q.literalQuery !== undefined
            ? makeSnippet(doc.text, q.query, 80, { at: row.anchor, len: q.literalQuery.length })
            : makeSnippet(doc.text, q.query),
      time: doc.time,
      turn: doc.kind === 'message' ? doc.turn : undefined,
      stepId: doc.kind === 'message' ? doc.stepId : undefined,
      score: row.score,
    };
  }

  private unavailablePage(
    reason: GlobalSearchUnavailableReason,
    detail?: string,
  ): GlobalSearchPage {
    return {
      items: [],
      hasMore: false,
      pageToken: undefined,
      incomplete: undefined,
      indexState: {
        state: 'unavailable',
        indexedSessions: 0,
        totalSessions: this.summaries.size,
        documents: 0,
        stale: true,
        reason,
        degraded: detail ?? this.lastRefreshError?.message,
      },
      unavailable: true,
      source: 'index',
    };
  }

  retryIndexer(): void {
    if (this.sqliteDisabled || this.disposed) return;
    this.sqliteHost.retryIndexer();
    this.requestSync();
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    if (this.sqliteDisabled || this.disposed) throw new GlobalSearchError('index_unavailable', 'SQLite search is disabled or closed');
    this.reindexing = true;
    try {
      await this.syncPromise?.catch(() => {});
      const sessions = await this.listAllSessions();
      const stats = await this.sqliteHost.reindex(sessions.map((summary) => this.toSyncInput(summary)));
      this.lastRefreshError = null;
      return stats;
    } catch (error) {
      this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      throw error;
    } finally {
      this.reindexing = false;
      this.requestSync();
    }
  }

  async status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
    lifecycle: SearchLifecycleReport;
    indexer?: ReturnType<SqliteSearchHost['snapshot']>;
  }> {
    if (this.disposed) return { sessions: 0, documents: 0, lastIndexedAt: null, generation: 0,
      lifecycle: this.lifecycleReport() };
    this.requestSync();
    const indexer = this.sqliteHost.snapshot();
    return { sessions: indexer.indexedSessions, documents: indexer.documents,
      lastIndexedAt: null, generation: 0, indexer, degraded: this.lastRefreshError?.message,
      lifecycle: this.lifecycleReport() };
  }

  lifecycleReport(): SearchLifecycleReport {
    if (this.disposed) return { state: this.drainSettled ? 'stopped' : 'closing' };
    const snapshot = this.sqliteHost.snapshot();
    return this.sqliteDisabled ? { state: 'degraded', detail: 'disabled' } :
      { state: snapshot.state === 'ready' || snapshot.state === 'readonly' ? 'ready' :
        snapshot.state === 'unavailable' ? 'degraded' : 'building', detail: snapshot.reason };
  }
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

function compareSessionRecency(left: SessionSummary, right: SessionSummary): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  return left.id.localeCompare(right.id);
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  ScopeActivation.OnDemand,
  'globalSearch',
);

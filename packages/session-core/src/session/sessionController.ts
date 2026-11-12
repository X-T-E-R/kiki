/**
 * SessionController — one session's REST snapshot, ordered transcript intake,
 * publication scheduling, resync, and user actions. Canonical transcript ops
 * are applied immediately and projected to React at most once per flush.
 */

import type {
  ApprovalDecision,
  ApprovalScope,
  DeferredAppendTiming,
  ExecutionSelection,
  MessageContent,
  PermissionMode,
  PromptItem,
  PromptPlanGate,
  PromptSubmission,
  PromptSubmitResult,
  QuestionResponse,
  Session,
  SessionSnapshotResponse,
} from '@kiki/protocol';
import {
  AgentTranscript,
  GRADE_RANK,
  gradeFor,
  placeTranscriptItems,
  rebindTurnContentRefs,
  turnOrdinal,
  type AgentTranscriptSnapshot,
  type TranscriptCoverage,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptItem,
  type TranscriptOperation,
  type TranscriptRead,
  type TranscriptTodo,
  type TranscriptTurn,
} from '@kiki/transcript';
import type { SessionViewTranscriptDetail } from '@kiki/klient/session-view';
import { OlderLoadCoordinator, type OlderLoadResult } from './olderLoadCoordinator';
import { readInHistoryLane } from './historyReadLane';

import {
  API_CODES,
  ApiError,
  DEFAULT_TRANSCRIPT_GRADES,
  isUnconfirmedTransportError,
  transcriptGradesForLeases,
  type AgentTranscriptResponse,
  type SessionCursor,
  type SessionTransport,
} from '../transport';
import { RPCError, type SessionViewFacade, type SessionViewSignal, type SessionViewSubscription } from '@kiki/klient/session-view';
import {
  MAIN_AGENT_ID,
  applyTranscriptShell,
  appendLocalUserMessage,
  createViewState,
  markApprovalResolved,
  markQuestionOutcome,
  projectAgentTranscriptView,
  projectMessageContent,
  SessionAgentForestQuery,
  setLoadError,
  setLoadingOlder,
  setOlderError,
  setResyncFailed,
  setResyncing,
  setSessionRecord,
  snapshotSubagentAgentId,
  transcriptDetailKey,
  type SessionViewState,
  type QuestionOutcome,
  type TranscriptDetailKind,
} from './transcript';
import { adoptSessionShell, createSessionShell, withSessionShell, type SessionShell } from './sessionShell';
import { collectTranscriptContentRefs, patchAgentTranscriptContent, replaceAgentContentEntity, snapshotContentEntity, transcriptContentEntity } from './transcript/content';
import { adoptContentPreviewField, applyContentSegment, carryContentHydration, contentPathValue, mergeContentPreview, restoreContentPreview, sameContentRef, transcriptValueEquals, type ContentRef, type ContentSegment, type ContentSource, type ContentWindow } from '@kiki/transcript';
import { isModelSwitchQueueId } from './modelSwitchQueue';
import { questionAnswerTexts } from './transcript/questionAnswers';
import { completeTranscriptTurnStructure, interactionToBlock } from './transcript/project';
import { readMarkWins, refreshTurn, resolveItemCopies, resolveTurnCopies, turnGapOf, windowItemKey, type ReadMark } from './transcript/window';
import { isSteerSettled, newSteerPromptId, withPendingSteers, type PendingSteer } from './transcript/steer';
import type { QueuedPromptMeta } from './transcript/types';
import type { AgentForest } from './agentTree';
import { messageContentSchema } from '@kiki/protocol';
import { forgetUnconfirmedSubmission, preserveSubmission } from '../composer/submissionRecovery';

export type Listener = () => void;

export const CONTENT_INLINE_TEXT_CHARS = 512 * 1024;
export const CONTENT_RANGE_CHARS = 4096;
const CONTENT_RANGE_CACHE_BYTES = 2 * 1024 * 1024;
const CONTENT_BODY_CACHE_BYTES = 8 * 1024 * 1024;

export const RESYNC_PAUSED_ERROR = 'Session is resyncing; sending is paused';

export function assertSessionWritable(state: Pick<SessionViewState, 'resyncing' | 'resyncFailed'>): void {
  if (state.resyncing || state.resyncFailed) {
    throw new Error(RESYNC_PAUSED_ERROR);
  }
}

const RESYNC_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
const TOOL_DETAIL_PREPARING_RETRY_MS = 80;
const OLDER_PAGE_TURNS = 40;
/**
 * Window bound while the reader follows the tail: trimmed once more turns than
 * this are held — 20 above the kept size, so a turn-by-turn stream trims once
 * per 20 turns rather than on every new one.
 */
const WINDOW_TRIM_ABOVE_TURNS = 60;
/** Turns a trim keeps: two of the server's 20-turn reset windows, enough to scroll back a little without a read. */
const WINDOW_KEEP_TURNS = 40;
const REWRITE_RESET_TIMEOUT_MS = 10_000;
const HIDDEN_FRAME_FLUSH_INTERVAL_MS = 1000;
/**
 * Roster reads one agent id may cost before its row is given up on: one
 * speculative read when the agent appears, plus up to two more when later
 * spawn evidence says the row must exist by now. A row the session never emits
 * (an external delegation, say) then stops costing whole-session snapshots.
 */
const MAX_ROSTER_ROW_READS = 3;
const MAX_ROSTER_REVISION_REFRESHES = 3;

export interface PublicationScheduler {
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

interface VisibilityDocument {
  readonly visibilityState?: string;
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * The browser globals this module probes, read through `globalThis` so the file
 * typechecks in compilation units without the DOM lib while runtime access and
 * the `typeof` guards stay identical to a bare global reference.
 */
interface BrowserGlobal {
  readonly requestAnimationFrame?: (callback: () => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly document?: VisibilityDocument;
}

const browserGlobal = globalThis as unknown as BrowserGlobal;

interface PendingTranscriptBatch {
  readonly ops: TranscriptOperation[];
  cursor: TranscriptCursor;
  /**
   * Server-side coverage watermark of the merged events: seqs beyond
   * `cursor.seq` up to here were seen but filtered out of `ops`. The resume
   * cursor must advance past them or a reconnect re-pulls the filtered tail.
   */
  throughSeq: number;
}

interface ToolCountObservation {
  readonly count: number;
  readonly cursor: TranscriptCursor;
}

interface ToolCountSpan {
  readonly from: TranscriptCursor;
  readonly through: TranscriptCursor;
  readonly delta: number | undefined;
}

const TOOL_COUNT_SPAN_LIMIT = 128;

interface RewriteHold {
  readonly token: number;
  readonly mainEpoch: string | undefined;
  generation: number | undefined;
  subscribeToken: number | undefined;
  readonly deferredBatches: PendingTranscriptBatch[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Everything the controller holds for one agent's timeline. Main is an
 * ordinary entry: what differs for main is the session it belongs to, which
 * lives in the controller's `SessionShell`, not in this record.
 */
interface AgentTimeline {
  readonly agentId: string;
  /**
   * The agent's window: one store holding every item the client has, whatever
   * read brought it (a reset, live ops, an older page, a one-turn structure
   * read, a content read), placed by the server's ordering. Created on the
   * agent's first data or read and never dropped; old turns leave it only by
   * `trimWindow`, after which they count as older history not loaded.
   */
  store: AgentTranscript | undefined;
  /**
   * The read mark of every held item (by `windowItemKey`): the transcript
   * cursor of the reset, op batch or page that last decided its content. Two
   * copies of an item are resolved by these marks (`readMarkWins`).
   */
  marks: Map<string, ReadMark>;
  /**
   * Turns held complete that have since been updated only below the grade the
   * window was built at (`windowGrade`), or held across a reset that showed
   * they must have changed: published as incomplete until a read at the full
   * grade replaces them.
   */
  stale: Set<string>;
  /** Turns this client assembled from a head and a tail it read separately (see `ResolvedTurn.join`). */
  joins: Map<string, string | null>;
  /** The grade the held content was built at: what a complete, non-stale turn of this window carries. */
  windowGrade: TranscriptGrade | undefined;
  /** Epoch of the held content. A reset in another epoch cannot be compared with it, so it replaces the window. */
  windowEpoch: string | undefined;
  /** A raised grade was sent and its baseline has not landed: the window shows what it holds meanwhile. */
  refreshing: boolean;
  /** Mounted timeline rows per turn (`retainHistoryPreview`): where readers are. */
  viewLeases: Map<string, number>;
  /** Older-history reads (pages, locates) in flight. */
  paging: number;
  /**
   * Set when an older read places history in the window the reader has not
   * yet been seen reading: the ordinal of the window's oldest turn before that
   * read. Until a row of an older turn is mounted (`readerVisitedOld`) the
   * window is not trimmed, so a locate, a reading-position restore or a find
   * look-back that pages in several steps never loses what its previous step
   * loaded.
   */
  pagedPin: number | undefined;
  /** Since `pagedPin` was set, a row of a turn it pinned was mounted. */
  readerVisitedOld: boolean;
  /**
   * What the agent tree needs from trimmed turns: each one's spawning tool
   * frames (agent references) and start times, nothing else, so a child
   * spawned in a trimmed turn keeps its parent and spawn time.
   */
  relations: readonly TranscriptTurn[];
  /** The window snapshot with `relations` laid under it, kept while neither changed (see `publishForest`). */
  forestInput: { readonly relations: readonly TranscriptTurn[]; readonly window: AgentTranscriptSnapshot; readonly snapshot: AgentTranscriptSnapshot } | undefined;
  /** Resume watermark of the applied transcript. */
  cursor: TranscriptCursor | undefined;
  /** The cursor as of the latest publication (`getAgentTranscriptCursor`). */
  publishedCursor: TranscriptCursor | undefined;
  /** Where the next older page continues: the server's continuation, else the oldest loaded turn. */
  olderCursor: string | undefined;
  olderTurn: string | undefined;
  /**
   * Grade of the applied baseline. The requested grade is not kept here: it
   * is `gradeFor(transcriptGrades, agentId)`, whose wildcard also covers
   * agents without a record.
   */
  appliedGrade: TranscriptGrade | undefined;
  /** Bumps on every applied reset so a resync can tell a baseline that landed during its snapshot from the one it is about to drop. */
  baselineSerial: number | undefined;
  /** Bumps whenever the agent's in-flight reads become obsolete: reset, resync, grade change, suspend. */
  generation: number;
  /** Provenance of the latest history read and of the latest todo entity read. */
  historyRead: TranscriptRead | undefined;
  todoRead: TranscriptRead | undefined;
  globalCoverage: AgentTranscriptSnapshot['globalCoverage'];
  /** The view the agent's next publication shows, before "send now" echoes. Main's leaves the session fields to the shell. */
  view: SessionViewState | undefined;
  /** What `getAgentState` returns: the view with echoes laid over it; main's also carries the shell. */
  published: SessionViewState | undefined;
  /** `subscribeAgent` listeners; every publication of this agent notifies them. */
  listeners: Set<Listener>;
  /** "Send now" echoes between the keypress and their delivered frame, laid over each publication (transcript/steer.ts). */
  steers: readonly PendingSteer[];
}

type StoredTimeline = AgentTimeline & { store: AgentTranscript };

/** What a reset leaves of the held window (see `resetWindow`). */
interface ResetWindow {
  readonly held: { readonly items: readonly TranscriptItem[]; readonly hasMoreOlder: boolean };
  /** The held window can be compared with the reset: same epoch, and it holds something. */
  readonly continuity: boolean;
  /** The reset carries the agent's whole history. */
  readonly full: boolean;
  /** A turn-grade reset over a window built above `turn`. */
  readonly lowered: boolean;
  /** The reset's items, each the copy the window keeps for it. */
  readonly incoming: readonly TranscriptItem[];
  readonly resetKeys: ReadonlySet<string>;
  /** Items of the reset whose held copy was read later and is kept. */
  readonly heldWins: ReadonlySet<string>;
  /** Held items the window keeps beside the reset's: the older history before its range. */
  readonly kept: readonly TranscriptItem[];
  /** Turns the reset leaves stale. */
  readonly staleTurns: ReadonlySet<string>;
}

/**
 * What the agent tree needs from turns leaving the window: each turn's tool
 * frames that spawned agents, with the step and turn start times, nothing else.
 */
function relationStubs(items: readonly TranscriptItem[]): TranscriptTurn[] {
  const stubs: TranscriptTurn[] = [];
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    const steps = item.steps.flatMap((step) => {
      const frames = step.frames.filter((frame) => frame.kind === 'tool' && (frame.agentRefs?.length ?? 0) > 0);
      return frames.length === 0 ? [] : [{ ...step, frames }];
    });
    if (steps.length > 0) stubs.push({ kind: 'turn', turnId: item.turnId, ordinal: item.ordinal, state: item.state, origin: item.origin, startedAt: item.startedAt, steps });
  }
  return stubs;
}

/** The window item an op decides the content of, if any (see `windowItemKey`). */
function opItemKey(op: TranscriptOperation): string | undefined {
  switch (op.op) {
    case 'turn.upsert': return `turn:${op.turn.turnId}`;
    case 'step.upsert':
    case 'frame.upsert':
    case 'frame.remove': return `turn:${op.turnId}`;
    case 'append': return op.target.type === 'frame' ? `turn:${op.target.turnId}` : undefined;
    case 'marker.upsert': return `marker:${op.item.markerId}`;
    case 'taskref.upsert': return `taskref:${op.item.refId}`;
    default: return undefined;
  }
}

const browserScheduler: PublicationScheduler = {
  schedule(callback) {
    const { requestAnimationFrame } = browserGlobal;
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return setTimeout(callback, 24);
  },
  cancel(handle) {
    const { cancelAnimationFrame } = browserGlobal;
    if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
      cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

function browserVisibilityDocument(): VisibilityDocument | undefined {
  return browserGlobal.document;
}

/** UTF-16 size of a JSON-serializable value; an unserializable value counts as zero. */
function estimateJsonBytes(value: unknown): number {
  try {
    return (JSON.stringify(value)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const PREPARING_RETRY_MAX_MS = 1000;

/**
 * Resolves after `ms`, or as soon as `signal` aborts, so a cancelled read does
 * not sit out a retry wait. Callers check the signal (or their own
 * obsolescence) right after, exactly as they did after a plain timeout.
 */
function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) { resolve(); return; }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Cadence for re-sending a read the server is still preparing: an empty
 * `preparing`/`partial` history page, or 40923 on a one-turn read. The demand
 * is kept — no cap and no silent give-up; only the reader cancelling ends it —
 * but repeats back off: 80 ms, doubling up to 1 s, and back to 80 ms once a
 * response makes progress (a non-empty page or an advanced continuation; for
 * a one-turn read, an answer that differs from the one before it).
 */
class PreparingBackoff {
  private attempt = 0;

  progressed(): void {
    this.attempt = 0;
  }

  wait(signal?: AbortSignal): Promise<void> {
    const ms = Math.min(PREPARING_RETRY_MAX_MS, TOOL_DETAIL_PREPARING_RETRY_MS * 2 ** this.attempt);
    if (ms < PREPARING_RETRY_MAX_MS) this.attempt += 1;
    return waitUnlessAborted(ms, signal);
  }
}

/**
 * The previous refs array when the next one lists the same refs in the same
 * order. `contentRefs` is recollected on every transcript publish and the GUI
 * hands it to a React context, so a fresh but equal array re-rendered every
 * row that reads bounded content on every streamed frame. Refs compare by
 * their serialized form — the text a `content:<ref JSON>` load key is built
 * from — so a reused array never changes a key a reader derives from it
 * (`sameContentRef` treats an omitted `direction` as `'forward'`, which
 * serializes differently).
 */
function stableContentRefs(previous: readonly ContentRef[] | undefined, next: readonly ContentRef[]): readonly ContentRef[] {
  if (previous === undefined || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    const ref = next[index]!;
    const prior = previous[index]!;
    if (ref !== prior && JSON.stringify(ref) !== JSON.stringify(prior)) return next;
  }
  return previous;
}

/**
 * A `Map` that counts its writes. The controller's synchronous content reads
 * (`contentRefsFor`, `isContentRange`, `getToolCallDetail`) consult some maps
 * directly instead of published state, so a write to one of them is a content
 * change that `publishContentRevision` must report even when no published
 * state changed.
 */
class CountingMap<K, V> extends Map<K, V> {
  writes = 0;

  override set(key: K, value: V): this {
    this.writes += 1;
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    if (deleted) this.writes += 1;
    return deleted;
  }

  override clear(): void {
    if (this.size > 0) this.writes += 1;
    super.clear();
  }
}

/**
 * Why a "send now" did not reach the running turn. `submit` and `refused`
 * leave nothing behind on the server, so the text belongs back in the
 * composer; `unknown` may still arrive and must not be re-sent blindly.
 */
function nonEmpty<T>(items: readonly T[]): readonly T[] | undefined {
  return items.length === 0 ? undefined : items;
}

export class SendNowError extends Error {
  constructor(
    readonly reason: 'submit' | 'refused' | 'unknown',
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SendNowError';
  }
}

export class SessionController {
  private readonly client: SessionTransport;
  private viewHandle: SessionViewSubscription | undefined;
  private connectionGeneration: number | undefined;
  private viewAttachment = 0;
  private openGeneration = 0;
  private bootstrapOpening: { readonly attachment: number; readonly resolve: () => void } | undefined;
  readonly sessionId: string;
  /** What belongs to the session rather than to one agent (see `SessionShell`). */
  private shell: SessionShell = createSessionShell();
  /**
   * Every agent's timeline, main included. Main's is created with the
   * controller and never removed; another agent's on its first data, view
   * write or subscription.
   */
  private readonly timelines = new Map<string, AgentTimeline>();
  private readonly main: AgentTimeline;
  /** The shell laid over main's view, kept while both are the same objects (see `sessionView`). */
  private composedSession: { readonly shell: SessionShell; readonly view: SessionViewState; readonly state: SessionViewState } | undefined;
  /** `subscribe` listeners: the session view, which every publication of main or of the shell changes. */
  private readonly listeners = new Set<Listener>();
  private readonly interruptedPromptListeners = new Set<(content: readonly MessageContent[]) => void>();
  private readonly scheduler: PublicationScheduler;
  private readonly usesBrowserScheduler: boolean;
  private readonly visibilityDocument: VisibilityDocument | undefined;
  private readonly rewriteResetTimeoutMs: number;
  private frameHandle: unknown = null;
  private hiddenFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncInFlight = false;
  private resyncGeneration = 0;
  private readonly resyncIdleWaiters = new Set<() => void>();
  private rosterRefreshInFlight = false;
  private rosterReadQueued = false;
  private rosterReadInFlight = false;
  private rosterRevisionRefreshes = 0;
  /** Turn-structure paths with a preview already in flight. The replacement read must not preview again. */
  private readonly turnStructureRefreshKeys = new Set<string>();
  private rosterRefreshQueuedCursor: SessionCursor | undefined;
  private readonly rosterTranscriptBindings = new Map<string, NonNullable<AgentTranscriptSnapshot['meta']['agent']>>();
  /** Agent id → roster reads spent chasing its row (see `requestRosterRows`). */
  private readonly requestedRosterAgents = new Map<string, number>();
  private rosterAgentIds = new Set<string>();
  private rosterLeaseTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private rewriteHold: RewriteHold | undefined;
  private rewriteHoldToken = 0;
  private closed = false;
  private abortActiveInFlight: Promise<void> | undefined;
  private lastRestoredPromptId: string | undefined;

  private readonly snapshotControllers = new Set<AbortController>();
  /** Agents whose working view awaits publication together (see `publish`). */
  private readonly dirtyAgents = new Set<string>();
  /**
   * The timelines that hold a store, in the order their stores were created.
   * Stores are never dropped, and every per-store loop (forest building,
   * reconnect catch-up, grade changes) keeps this order.
   */
  private readonly storeTimelines = new Set<StoredTimeline>();
  /** Source of `AgentTimeline.baselineSerial`. */
  private transcriptBaselineClock = 0;
  private readonly toolCountObservations = new Map<string, ToolCountObservation>();
  private readonly toolCountSpans = new Map<string, ToolCountSpan[]>();
  private readonly pendingTranscriptBatches = new Map<string, PendingTranscriptBatch>();
  private readonly pendingTranscriptAgents = new Set<string>();
  private readonly forestDirtyAgents = new Set<string>();
  private readonly olderLoads = new OlderLoadCoordinator((agentId) => {
    const current = this.viewOf(agentId);
    if (current.loadingOlder) this.publishView(agentId, setLoadingOlder(current, false));
  });
  private readonly emptyAgentState: SessionViewState;
  private readonly unprojectedQueueReceipts = new Map<string, PromptSubmitResult>();
  private publishedForest: AgentForest | undefined;
  private readonly forestQuery = new SessionAgentForestQuery();
  private transcriptGrades: TranscriptGradeSpec = DEFAULT_TRANSCRIPT_GRADES;
  /**
   * The agent the focus lease (`setFocusedAgent`) holds at `delta`, if any.
   * A controller starts focused on main, so a consumer that never moves focus
   * keeps receiving main's timeline frame by frame.
   */
  private focusedAgentId: string | undefined = MAIN_AGENT_ID;
  /** View leases by view id (`retainAgentView`): with the focus lease, the only demand there is. */
  private readonly agentViews = new Map<string, { readonly agentId: string; readonly grade: TranscriptGrade }>();
  private readonly catchupByAgent = new Map<string, Promise<void>>();
  private readonly catchupControllers = new Map<string, AbortController>();
  private readonly detailReads = new Map<string, Promise<boolean>>();
  /**
   * Serialized size of each transcript value the body budget counts, measured
   * once per object. Store entities are copy-on-write, so an unchanged object
   * never needs measuring again; releasing a reader does not serialize the
   * whole window to learn its size.
   */
  private readonly measuredBytes = new WeakMap<object, number>();
  private queuedTimingWriteSequence = 0;
  private readonly queuedTimingWrites = new Map<string, number>();
  private readonly contentControllers = new Map<string, AbortController>();
  private readonly contentReaders = new Map<string, { agentId: string; source: ContentSource; roots: readonly string[]; paths?: readonly (readonly (string | number)[])[]; includeOlder: boolean; readers: number; blocked: boolean; retryVersion: number; retryAttempt?: number; retryTimer?: ReturnType<typeof setTimeout>; ref?: ContentRef; controller?: AbortController }>();
  private contentPumpRunning = false;
  private readonly contentPumpReads = new Map<string, object>();
  private readonly contentRanges = new Map<string, string>();
  private contentRangeBytes = 0;
  private readonly rangeControllers = new Map<AbortController, string>();
  private readonly contentBodies = new CountingMap<string, { agentId: string; source: ContentSource; base: ContentWindow; bytes: number }>();
  private readonly toolDetails = new CountingMap<string, Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']>();
  private contentRevision = 0;
  private contentInputs: readonly unknown[] = [];
  private readonly contentListeners = new Set<Listener>();
  private readonly toolDetailEpochs = new Map<string, number>();
  private readonly toolDetailReads = new Map<string, { promise: Promise<Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']>; controller: AbortController; readers: number }>();
  private readonly entityPageCursors = new Map<string, string | null>();
  private latestSnapshot: SessionSnapshotResponse | undefined;
  private durableIngressReadInFlight: Promise<void> | undefined;
  private readonly durableSteerReads = new Map<string, { agentId: string; promptId: string }>();
  private durableSteerReadTimer: ReturnType<typeof setTimeout> | undefined;
  private durableSteerReadInFlight = false;
  private durableSteerReadGeneration = 0;
  private readonly catchupReplay = new Map<
    string,
    { readonly ops: readonly TranscriptOperation[]; readonly cursor: TranscriptCursor }
  >();
  private ephemeralHint: boolean | undefined;
  private persistenceHint: 'temporary' | 'saved' | 'unknown' | undefined;

  constructor(
    client: SessionTransport,
    private readonly view: SessionViewFacade,
    sessionId: string,
    options: { scheduler?: PublicationScheduler; rewriteResetTimeoutMs?: number; ephemeral?: boolean; persistenceHint?: 'temporary' | 'saved' | 'unknown' } = {},
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.ephemeralHint = options.ephemeral;
    this.persistenceHint = options.persistenceHint ?? (options.ephemeral === undefined ? 'unknown' : options.ephemeral ? 'temporary' : 'saved');
    this.scheduler = options.scheduler ?? browserScheduler;
    this.usesBrowserScheduler = options.scheduler === undefined;
    this.visibilityDocument = this.usesBrowserScheduler ? browserVisibilityDocument() : undefined;
    this.rewriteResetTimeoutMs = options.rewriteResetTimeoutMs ?? REWRITE_RESET_TIMEOUT_MS;
    this.main = this.timeline(MAIN_AGENT_ID);
    this.main.view = createViewState(sessionId);
    this.main.published = this.sessionView();
    this.emptyAgentState = createViewState(sessionId);
    this.visibilityDocument?.addEventListener?.('visibilitychange', this.onVisibilityChange);
  }

  getForest = (): AgentForest | undefined => this.publishedForest;

  private readonly onVisibilityChange = (): void => {
    if (this.closed) return;
    if (this.isDocumentHidden()) {
      this.cancelVisibleFrameFlush();
    } else {
      this.clearHiddenFrameTimer();
    }
    if (this.pendingTranscriptAgents.size > 0 || this.pendingTranscriptBatches.size > 0) {
      this.scheduleFrameFlush();
    }
  };

  /** The session view: the session shell laid over main's published view. */
  getState = (): SessionViewState => this.main.published!;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Revision of everything the synchronous content reads consult, for every
   * agent: `contentRefsFor`, `isContentRange`, `getToolCallDetail`, each
   * agent's published `detailLoads`, and the main view's
   * `transcriptResetVersion`. It changes only when one of those inputs did —
   * never for a publish that only streamed text — so a reader that runs those
   * reads during render can refresh on it instead of on every publish.
   */
  getContentRevision = (): number => this.contentRevision;

  /**
   * Observe `getContentRevision`. Like `subscribeAgent` this adds no demand:
   * rendering a row that reads another agent's content does not make the
   * client fetch that agent.
   */
  subscribeContent = (listener: Listener): (() => void) => {
    this.contentListeners.add(listener);
    return () => this.contentListeners.delete(listener);
  };

  subscribeInterruptedPrompt = (listener: (content: readonly MessageContent[]) => void): (() => void) => {
    this.interruptedPromptListeners.add(listener);
    return () => this.interruptedPromptListeners.delete(listener);
  };

  /** Any agent's published view; for main this is `getState()`. */
  getAgentState = (agentId: string): SessionViewState => {
    const timeline = this.timelines.get(agentId);
    return timeline?.published ?? timeline?.view ?? this.emptyAgentState;
  };

  /** Per-agent cursor at the latest transcript publication, not the session event cursor. */
  getAgentTranscriptCursor = (agentId: string): TranscriptCursor | undefined =>
    this.timelines.get(agentId)?.publishedCursor;

  /**
   * Listen to one agent's publications; for main, the same ones `subscribe`
   * hears. Listening adds no demand: the agent is published at whatever grade
   * the leases on it produce (`retainAgentView`, `setFocusedAgent`), and with
   * none it is not received at all. A panel that needs an agent's data takes
   * a lease for the grade it needs.
   */
  subscribeAgent = (agentId: string, listener: Listener): (() => void) => {
    const timeline = this.timeline(agentId);
    const listeners = timeline.listeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      // A later subscription starts a fresh set, so a repeated release of
      // this one can never remove a listener added after it.
      if (listeners.size === 0 && timeline.listeners === listeners) timeline.listeners = new Set();
    };
  };

  /** The agent's timeline record, created on first use. */
  private timeline(agentId: string): AgentTimeline {
    let timeline = this.timelines.get(agentId);
    if (timeline === undefined) {
      timeline = {
        agentId, store: undefined, marks: new Map(), stale: new Set(), joins: new Map(), windowGrade: undefined,
        windowEpoch: undefined, refreshing: false, viewLeases: new Map(), paging: 0, pagedPin: undefined,
        readerVisitedOld: false, relations: [], forestInput: undefined,
        cursor: undefined, publishedCursor: undefined, olderCursor: undefined, olderTurn: undefined,
        appliedGrade: undefined, baselineSerial: undefined, generation: 0, historyRead: undefined,
        todoRead: undefined, globalCoverage: undefined,
        view: undefined, published: undefined, listeners: new Set(), steers: [],
      };
      this.timelines.set(agentId, timeline);
    }
    return timeline;
  }

  /**
   * The working view an agent's next publication starts from. Main's leaves
   * the session fields to the shell; an agent without a view reads as empty.
   */
  private viewOf(agentId: string): SessionViewState {
    return this.timelines.get(agentId)?.view ?? this.emptyAgentState;
  }

  /** Read generation of an agent's history reads; a read started under an older one is obsolete. */
  private generationOf(agentId: string): number {
    return this.timelines.get(agentId)?.generation ?? 0;
  }

  /** The shell laid over main's working view: the session view before "send now" echoes. */
  private sessionView(): SessionViewState {
    const view = this.viewOf(MAIN_AGENT_ID);
    const composed = this.composedSession;
    if (composed?.shell === this.shell && composed.view === view) return composed.state;
    const state = withSessionShell(view, this.shell);
    this.composedSession = { shell: this.shell, view, state };
    return state;
  }

  /**
   * Replace an agent's working view without publishing it. Main's view also
   * holds the load state of the session snapshot's content, so writing it
   * may unblock the automatic roster read.
   */
  private writeView(agentId: string, view: SessionViewState): void {
    this.timeline(agentId).view = view;
    if (agentId === MAIN_AGENT_ID) this.queueAutomaticRosterRead();
  }

  /** Write and publish an agent's view; an unchanged view is not published again. */
  private publishView(agentId: string, view: SessionViewState): void {
    if (view === this.viewOf(agentId)) return;
    this.writeView(agentId, view);
    this.publish(agentId);
  }

  /**
   * Publish an agent's working view. Main's goes out at once; another
   * agent's joins the batch `resync` fills and flushes it, as before.
   */
  private publish(agentId: string): void {
    if (agentId === MAIN_AGENT_ID) {
      this.publishTimeline(MAIN_AGENT_ID);
      this.publishContentRevision();
      return;
    }
    this.dirtyAgents.add(agentId);
    this.publishDirtyAgents();
  }

  private publishDirtyAgents(): void {
    for (const agentId of this.dirtyAgents) this.publishTimeline(agentId);
    this.dirtyAgents.clear();
    this.publishContentRevision();
  }

  /**
   * The one publication routine, the same for every agent: retire settled
   * "send now" echoes, lay the rest over the view and notify the agent's
   * subscribers. Main's publication is also the session's: its view gets the
   * shell laid over it first, and `subscribe` listeners hear it too.
   */
  private publishTimeline(agentId: string): void {
    const timeline = this.timelines.get(agentId);
    const view = timeline?.view;
    if (timeline === undefined || view === undefined) return;
    this.retireSettledSteers(agentId, view);
    timeline.published = withPendingSteers(agentId === MAIN_AGENT_ID ? this.sessionView() : view, timeline.steers);
    if (agentId === MAIN_AGENT_ID) for (const listener of this.listeners) listener();
    for (const listener of timeline.listeners) listener();
  }

  /**
   * Replace the shell. A roster change re-arms the roster lease, and any
   * shell change may unblock the automatic roster read. Publishing the shell
   * is publishing main, whose published view carries it.
   */
  private setShell(next: SessionShell, publish = true): void {
    if (next === this.shell) return;
    const rosterChanged = next.snapshotSubagents !== this.shell.snapshotSubagents;
    this.shell = next;
    if (rosterChanged) {
      this.rosterAgentIds = new Set(next.snapshotSubagents.map(snapshotSubagentAgentId));
      this.scheduleRosterLease();
    }
    this.queueAutomaticRosterRead();
    if (publish) this.publish(MAIN_AGENT_ID);
  }

  /** Publish the shell one version on, so `getState()` changes for a session-level change no field records (the forest). */
  private publishShell(): void {
    this.setShell({ ...this.shell, version: this.shell.version + 1 });
  }

  /**
   * Write back a whole session view that a helper spanning both records
   * computed from `sessionView()` — applying a session snapshot or a session
   * record: its session fields go to the shell, everything else to main's view.
   */
  private setSessionView(next: SessionViewState, publish = true): void {
    if (next === this.sessionView()) return;
    const shell = adoptSessionShell(this.shell, next);
    const rosterChanged = shell.snapshotSubagents !== this.shell.snapshotSubagents;
    this.shell = shell;
    this.main.view = { ...next, version: this.viewOf(MAIN_AGENT_ID).version + 1 };
    if (rosterChanged) {
      this.rosterAgentIds = new Set(shell.snapshotSubagents.map(snapshotSubagentAgentId));
      this.scheduleRosterLease();
    }
    this.queueAutomaticRosterRead();
    if (publish) this.publish(MAIN_AGENT_ID);
  }

  /**
   * Runs at every publication. Compares, by identity, every input of the
   * reads `getContentRevision` covers and bumps the revision when any of
   * them changed since the last publication. Store edits reach this through
   * each agent's stabilized `contentRefs`; the maps the reads consult directly
   * count their own writes.
   */
  private publishContentRevision(): void {
    const main = this.main.published!;
    const inputs: unknown[] = [
      this.latestSnapshot, this.toolDetails.writes, this.contentBodies.writes,
      main.contentRefs, main.detailLoads, main.transcriptResetVersion,
    ];
    for (const { agentId, published } of this.timelines.values()) {
      if (agentId === MAIN_AGENT_ID || published === undefined) continue;
      inputs.push(agentId, published.contentRefs, published.detailLoads);
    }
    const previous = this.contentInputs;
    this.contentInputs = inputs;
    if (inputs.length === previous.length && inputs.every((input, index) => input === previous[index])) return;
    this.contentRevision += 1;
    for (const listener of this.contentListeners) listener();
  }

  private clearRosterLeaseTimer(): void {
    if (this.rosterLeaseTimer === null) return;
    clearTimeout(this.rosterLeaseTimer);
    this.rosterLeaseTimer = null;
  }

  private scheduleRosterLease(): void {
    this.clearRosterLeaseTimer();
    if (this.closed) return;
    let nearest = Infinity;
    for (const row of this.shell.snapshotSubagents) {
      if (row.refreshing !== true) continue;
      const until = Date.parse(row.refreshing_until ?? '');
      nearest = Math.min(nearest, Number.isFinite(until) ? until : 0);
    }
    if (nearest === Infinity) return;
    this.rosterLeaseTimer = setTimeout(() => {
      this.rosterLeaseTimer = null;
      if (this.closed) return;
      const now = Date.now();
      let changed = false;
      const next = this.shell.snapshotSubagents.map((row) => {
        if (row.refreshing !== true || Date.parse(row.refreshing_until ?? '') > now) return row;
        changed = true;
        const terminal = row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled';
        return { ...row, refreshing: undefined, refreshing_until: undefined,
          live: terminal ? false : row.live };
      });
      if (!changed) {
        this.scheduleRosterLease();
        return;
      }
      this.setShell({ ...this.shell, version: this.shell.version + 1, snapshotSubagents: next }, false);
      this.publishForest();
      this.publish(MAIN_AGENT_ID);
    }, Math.min(2_147_483_647, Math.max(0, nearest - Date.now())));
  }

  private isDocumentHidden(): boolean {
    return this.usesBrowserScheduler && this.visibilityDocument?.visibilityState === 'hidden';
  }

  private cancelVisibleFrameFlush(): void {
    if (this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }

  private clearHiddenFrameTimer(): void {
    if (this.hiddenFrameTimer === null) return;
    clearTimeout(this.hiddenFrameTimer);
    this.hiddenFrameTimer = null;
  }

  private scheduleFrameFlush(): void {
    if (this.frameHandle !== null || this.hiddenFrameTimer !== null || this.closed) return;
    if (this.isDocumentHidden()) {
      this.hiddenFrameTimer = setTimeout(() => {
        this.hiddenFrameTimer = null;
        this.flushFrames();
      }, HIDDEN_FRAME_FLUSH_INTERVAL_MS);
      return;
    }
    this.frameHandle = this.scheduler.schedule(() => {
      this.frameHandle = null;
      this.flushFrames();
    });
  }

  /** Public test seam and fallback for environments without an actual rAF. */
  flushFrames = (): void => {
    if (this.closed) return;
    this.flushPendingTranscriptBatches();
    if (this.pendingTranscriptAgents.size > 0) {
      const agents = [...this.pendingTranscriptAgents];
      this.pendingTranscriptAgents.clear();
      for (const agentId of agents) {
        const store = this.timelines.get(agentId)?.store;
        if (store !== undefined) this.publishProjectedAgent(agentId, store);
      }
    }
  };

  private async readSnapshot(rosterOnly = false): Promise<SessionSnapshotResponse> {
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const attachment = this.viewAttachment;
    try {
      let snapshot = await this.view.snapshot({ signal: controller.signal });
      if (!rosterOnly && !this.closed && !controller.signal.aborted && attachment === this.viewAttachment &&
        (!this.shell.loaded || this.resyncInFlight || (snapshot.epoch === this.shell.cursor.epoch && snapshot.as_of_seq >= this.shell.cursor.seq))) {
        if (this.latestSnapshot?.epoch === snapshot.epoch) snapshot = mergeContentPreview(this.latestSnapshot, snapshot);
        this.latestSnapshot = snapshot;
        // The session snapshot's content refs ride on main's view (see
        // `publishProjectedAgent`); the next publication carries them.
        const main = this.viewOf(MAIN_AGENT_ID);
        this.main.view = { ...main, contentRefs: stableContentRefs(main.contentRefs, [...collectTranscriptContentRefs(this.windowSnapshot(MAIN_AGENT_ID)), ...(snapshot.contentRefs ?? [])]) };
      }
      return snapshot;
    } finally {
      this.snapshotControllers.delete(controller);
    }
  }

  /** Initial sync seeds visible transcripts independently of the session shell when the transport supports it. */
  async open(): Promise<void> {
    if (this.closed || this.isSuspended) return;
    if (this.view.bootstrap !== undefined) {
      this.finishBootstrapOpening();
      this.transcriptGrades = this.requestedTranscriptGrades();
      await new Promise<void>((resolve) => {
        this.bootstrapOpening = { attachment: this.viewAttachment + 1, resolve };
        try {
          this.attachView({ seq: 0 }, true);
        } catch (error) {
          this.finishBootstrapOpening();
          this.setShell({ ...setLoadError(this.shell, errorMessage(error, 'Could not load session')), loaded: this.shell.loaded });
        }
      });
      return;
    }
    const generation = ++this.openGeneration;
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || this.isSuspended || generation !== this.openGeneration || attachment !== this.viewAttachment) return;
      this.setSessionView(this.applyTranscriptShellSnapshot(snapshot));
      this.transcriptGrades = this.requestedTranscriptGrades();
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      void this.refreshDurableIngress();
    } catch (error) {
      if (this.closed || this.isSuspended || generation !== this.openGeneration || attachment !== this.viewAttachment) return;
      if (isAbortError(error)) return;
      this.setShell({ ...setLoadError(this.shell, errorMessage(error, 'Could not load session')), loaded: this.shell.loaded });
    }
  }

  private finishBootstrapOpening(): void {
    const opening = this.bootstrapOpening;
    this.bootstrapOpening = undefined;
    opening?.resolve();
  }

  private attachView(sessionCursor: SessionCursor, bootstrap = false): void {
    const attachment = ++this.viewAttachment;
    this.droppedWithLiveWork = false;
    const previous = this.viewHandle;
    this.viewHandle = undefined;
    previous?.close();
    const qualifiedCursors = [...this.timelines.values()].flatMap(({ agentId, cursor }) =>
      cursor !== undefined && this.hasTranscriptBaseline(agentId) ? [[agentId, cursor] as const] : []);
    this.lowerBaselinesTo(this.transcriptGrades);
    const input = {
      sessionCursor,
      transcriptGrades: this.transcriptGrades,
      transcriptSince: qualifiedCursors.length === 0 ? undefined : Object.fromEntries(qualifiedCursors),
    };
    const onSignal = (signal: SessionViewSignal) => {
      if (attachment === this.viewAttachment) this.handleSignal(signal);
    };
    this.viewHandle = bootstrap && this.view.bootstrap !== undefined
      ? this.view.bootstrap(input, onSignal) : this.view.subscribe(input, onSignal);
    if (bootstrap && this.bootstrapOpening === undefined) this.viewHandle.updateSessionCursor(this.shell.cursor);
  }

  nudge(): void {
    this.viewHandle?.nudge();
    if (this.closed || this.isSuspended) return;
    if (this.shell.loadError !== undefined) {
      void this.retryOpen();
      return;
    }
    if (this.shell.resyncFailed && this.shell.resyncError?.retryable !== false) {
      void this.resync();
    }
  }

  /** True while the controller holds no live view subscription but keeps its store. */
  get suspended(): boolean {
    return this.isSuspended;
  }

  private isSuspended = false;

  /**
   * Park a loaded view: detach the live subscription and cancel in-flight
   * reads, but keep the canonical per-agent stores and cursors so `resume()`
   * can repaint instantly and catch up from where it stopped.
   */
  suspend(): void {
    if (this.closed || this.isSuspended) return;
    this.isSuspended = true;
    this.finishBootstrapOpening();
    this.pauseDurableSteerReads();
    this.resolveResyncIdleWaiters();
    for (const controller of this.snapshotControllers) controller.abort();
    this.snapshotControllers.clear();
    this.clearResyncTimer();
    this.clearRosterLeaseTimer();
    this.clearRewriteHold();
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    // Batches that have not been applied yet are dropped together with their
    // cursors: resume re-requests everything after the last applied cursor.
    this.pendingTranscriptBatches.clear();
    this.catchupReplay.clear();
    this.flushFrames();
    for (const { agentId } of this.storeTimelines) this.bumpHistoryGeneration(agentId);
    for (const timeline of this.timelines.values()) timeline.refreshing = false;
    this.olderLoads.cancelAll();
    const main = this.viewOf(MAIN_AGENT_ID);
    if (main.loadingOlder || main.olderError !== undefined) {
      this.writeView(MAIN_AGENT_ID, { ...main, loadingOlder: false, olderError: undefined });
    }
    this.viewAttachment += 1;
    this.viewHandle?.close();
    this.viewHandle = undefined;
  }

  /**
   * Re-attach a suspended view. The retained window renders immediately; the
   * subscription resumes from the last applied session and transcript
   * cursors, and the returned promise settles after the fresh snapshot shell
   * refreshes session-level fields.
   */
  resume(): Promise<void> {
    if (this.closed || !this.isSuspended) return Promise.resolve();
    this.isSuspended = false;
    this.scheduleDurableSteerRead();
    if (!this.shell.loaded) return this.open();
    if (this.shell.resyncFailed) return this.resync();
    this.transcriptGrades = this.requestedTranscriptGrades();
    this.attachView(this.shell.cursor);
    void this.pumpContentReads();
    return this.refreshShell();
  }

  private async refreshShell(): Promise<void> {
    const attachment = this.viewAttachment;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || this.isSuspended || attachment !== this.viewAttachment) return;
      if (this.shell.cursor.epoch !== undefined && snapshot.epoch !== this.shell.cursor.epoch) {
        void this.resync();
        return;
      }
      this.setSessionView(this.applyTranscriptShellSnapshot(snapshot), false);
      this.publishForest();
      this.publish(MAIN_AGENT_ID);
    } catch (error) {
      if (this.closed || this.isSuspended || attachment !== this.viewAttachment) return;
      if (isAbortError(error)) return;
      const message = errorMessage(error, 'Could not load session');
      this.setShell({ ...setLoadError(this.shell, message), loaded: this.shell.loaded });
    }
  }

  /**
   * Rough resident size of the retained view (every agent's window), used by
   * the view cache to bound what it keeps.
   */
  residentBytes(): number {
    let bytes = 0;
    for (const { store } of this.storeTimelines) bytes += store.residentReport().estimatedBytes;
    return bytes;
  }

  private bytesOf(value: unknown): number {
    if (value === null || typeof value !== 'object') return estimateJsonBytes(value);
    let bytes = this.measuredBytes.get(value);
    if (bytes === undefined) {
      bytes = estimateJsonBytes(value);
      this.measuredBytes.set(value, bytes);
    }
    return bytes;
  }

  async retryOpen(): Promise<void> {
    if (this.closed) return;
    this.setShell(setLoadError(this.shell, undefined));
    if (this.shell.loaded && this.viewHandle !== undefined) await this.refreshShell();
    else await this.open();
  }

  close(): void {
    this.closed = true;
    this.finishBootstrapOpening();
    this.pauseDurableSteerReads();
    this.durableSteerReads.clear();
    this.resolveResyncIdleWaiters();
    for (const controller of this.snapshotControllers) controller.abort();
    this.snapshotControllers.clear();
    this.agentViews.clear();
    this.visibilityDocument?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.clearResyncTimer();
    this.clearRosterLeaseTimer();
    this.clearRewriteHold();
    this.cancelVisibleFrameFlush();
    this.clearHiddenFrameTimer();
    this.pendingTranscriptBatches.clear();
    this.pendingTranscriptAgents.clear();
    for (const { agentId } of this.storeTimelines) this.bumpHistoryGeneration(agentId);
    for (const timeline of this.timelines.values()) {
      timeline.generation = 0;
      timeline.viewLeases.clear();
      timeline.refreshing = false;
    }
    this.contentReaders.clear();
    this.contentBodies.clear();
    this.toolDetails.clear();
    this.contentRanges.clear(); this.contentRangeBytes = 0;
    this.olderLoads.cancelAll();
    this.queuedTimingWrites.clear();
    const main = this.viewOf(MAIN_AGENT_ID);
    if (main.loadingOlder || main.olderError !== undefined) {
      this.main.view = { ...main, loadingOlder: false, olderError: undefined };
    }
    this.viewAttachment += 1;
    this.viewHandle?.close();
    this.viewHandle = undefined;
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private beginRewriteHold(): void {
    if (this.rewriteHold !== undefined) return;
    const token = (this.rewriteHoldToken += 1);
    const generation = this.connectionGeneration;
    const pendingMain = this.pendingTranscriptBatches.get(MAIN_AGENT_ID);
    const hold: RewriteHold = {
      token,
      mainEpoch: (pendingMain?.cursor ?? this.timelines.get(MAIN_AGENT_ID)?.cursor)?.epoch,
      generation: Number.isInteger(generation) ? generation : undefined,
      subscribeToken: undefined,
      deferredBatches: [],
      timer: null,
    };
    if (pendingMain?.ops.some((op) => op.op === 'items.remove') === true) {
      this.pendingTranscriptBatches.delete(MAIN_AGENT_ID);
      hold.deferredBatches.push(pendingMain);
    }
    hold.timer = setTimeout(() => this.recoverRewriteHold(token), this.rewriteResetTimeoutMs);
    this.rewriteHold = hold;
  }

  private armRewriteSubscription(token: number): void {
    const hold = this.rewriteHold;
    if (hold === undefined || hold.token !== token) return;
    hold.subscribeToken = token;
    if (hold.mainEpoch !== undefined) return;
    const generation = this.connectionGeneration;
    hold.generation = generation === undefined ? undefined : generation + 1;
    this.viewHandle?.restart();
  }

  private clearRewriteHold(token?: number): void {
    const hold = this.rewriteHold;
    if (hold === undefined || (token !== undefined && hold.token !== token)) return;
    if (hold.timer !== null) clearTimeout(hold.timer);
    this.rewriteHold = undefined;
  }

  private recoverRewriteHold(token: number): void {
    if (this.closed || this.rewriteHold?.token !== token) return;
    this.clearRewriteHold(token);
    this.viewHandle?.restart();
    if (this.resyncInFlight) {
      this.hardResyncQueued = true;
      return;
    }
    void this.resync();
  }

  private matchesRewriteGeneration(generation: number | undefined): boolean {
    const heldGeneration = this.rewriteHold?.generation;
    return heldGeneration === undefined || generation === heldGeneration;
  }

  private completesRewriteHold(hold: RewriteHold, cursor: TranscriptCursor): boolean {
    if (hold.mainEpoch !== undefined) {
      return cursor.epoch !== undefined && cursor.epoch !== hold.mainEpoch;
    }
    return hold.subscribeToken === hold.token;
  }

  handleTranscript(event: TranscriptEvent, generation?: number): void {
    if (this.closed || event.session_id !== this.sessionId) return;
    const hold = this.rewriteHold;
    if (event.type === 'transcript.reset') {
      if (hold !== undefined && event.agent_id === MAIN_AGENT_ID) {
        if (!this.matchesRewriteGeneration(generation)) return;
        if (!this.completesRewriteHold(hold, event.cursor)) return;
        this.clearRewriteHold(hold.token);
      }
      const appliedCursor = this.timelines.get(event.agent_id)?.cursor;
      const appliedGrade = this.timelines.get(event.agent_id)?.appliedGrade;
      const pending = this.pendingTranscriptBatches.get(event.agent_id);
      const seenThrough = Math.max(appliedCursor?.seq ?? -1, pending?.throughSeq ?? -1);
      if (hold === undefined && !this.catchupByAgent.has(event.agent_id) &&
          appliedCursor?.epoch !== undefined && event.cursor.epoch === appliedCursor.epoch &&
          (event.cursor.seq < seenThrough ||
            (event.cursor.seq === seenThrough && appliedGrade !== undefined &&
              GRADE_RANK[event.grade] <= GRADE_RANK[appliedGrade]))) {
        this.settleRefresh(event.agent_id);
        return;
      }
      this.applyTranscriptReset(event.agent_id, event.snapshot, event.coverage, event.cursor, event.grade, event.read);
      return;
    }
    if (hold !== undefined && event.agent_id === MAIN_AGENT_ID) {
      if (!this.matchesRewriteGeneration(generation)) return;
      if (hold.deferredBatches.length > 0 || event.ops.some((op) => op.op === 'items.remove')) {
        hold.deferredBatches.push({
          ops: [...event.ops],
          cursor: event.cursor,
          throughSeq: event.through_seq,
        });
        return;
      }
    }
    this.applyTranscriptOps(event.agent_id, event.ops, event.cursor, event.through_seq);
  }

  /**
   * Durable `session_event` seq is the message-closure watermark (`expected_cursor`).
   * Transcript ops use a per-agent seq and must not overwrite this.
   */
  private advanceSessionCursor(cursor: SessionCursor): void {
    const current = this.shell.cursor;
    if (cursor.seq < current.seq) return;
    if (cursor.seq === current.seq && cursor.epoch === current.epoch) return;
    const session = this.shell.session !== undefined && cursor.seq > this.shell.session.last_seq
      ? { ...this.shell.session, last_seq: cursor.seq }
      : this.shell.session;
    this.setShell({
      ...this.shell,
      version: this.shell.version + 1,
      session,
      cursor: { seq: cursor.seq, epoch: cursor.epoch },
    });
    this.viewHandle?.updateSessionCursor(cursor);
  }

  /**
   * Move the focus lease: a `delta` lease on the agent whose timeline is in
   * front, released from the agent that had it. It is one lease like any
   * other, so it lowers no other agent: main keeps the session's `turn` lease
   * while another agent has focus. A controller starts focused on main;
   * `undefined` releases the focus lease without taking another.
   */
  setFocusedAgent(agentId: string | undefined): void {
    if (this.closed || agentId === this.focusedAgentId) return;
    this.focusedAgentId = agentId;
    this.refreshTranscriptGrades();
  }

  /**
   * Retain a view-instance demand; reusing its ID replaces that demand, not
   * another view's. An agent's requested grade is the highest of the leases on
   * it (see `transcriptGradesForLeases`); an `off` lease adds no demand.
   */
  retainAgentView(viewId: string, agentId: string, grade: TranscriptGrade): void {
    if (this.closed) return;
    if (viewId.trim() === '' || agentId.trim() === '' || agentId === '*') {
      throw new Error('Agent views require a view ID and a concrete agent ID');
    }
    this.agentViews.set(viewId, { agentId, grade });
    this.refreshTranscriptGrades();
  }

  /** Change a retained view's demand; an unknown or released ID is a no-op. */
  updateAgentView(viewId: string, grade: TranscriptGrade): void {
    if (this.closed) return;
    const view = this.agentViews.get(viewId);
    if (view === undefined || view.grade === grade) return;
    this.agentViews.set(viewId, { agentId: view.agentId, grade });
    this.refreshTranscriptGrades();
  }

  /** Idempotently release one view without lowering any other consumer's demand. */
  releaseAgentView(viewId: string): void {
    if (!this.agentViews.delete(viewId)) return;
    this.refreshTranscriptGrades();
  }

  /** The grades the leases ask for: the focus lease and every view lease, nothing else. */
  private requestedTranscriptGrades(): TranscriptGradeSpec {
    const focus = this.focusedAgentId;
    return transcriptGradesForLeases(focus === undefined
      ? this.agentViews.values()
      : [{ agentId: focus, grade: 'delta' }, ...this.agentViews.values()]);
  }

  /**
   * Once the server is sent a grade below an agent's baseline, it filters that
   * agent's ops at the lower grade, so from then on the baseline — and the
   * cursor those ops advance — is only as good as the lower grade. Record it,
   * or a later raise would treat the old baseline as current: the raised
   * reset at the same cursor would be dropped as a duplicate, a reconnect
   * would resume the higher grade from a cursor earned below it, and turn
   * heads that arrived without their steps would be kept as loaded history.
   * `off` lowers nothing: nothing arrives at `off`, so the baseline and its
   * cursor stay what they were.
   */
  private lowerBaselinesTo(grades: TranscriptGradeSpec): void {
    for (const timeline of this.timelines.values()) {
      const applied = timeline.appliedGrade;
      const grade = gradeFor(grades, timeline.agentId);
      if (applied !== undefined && grade !== 'off' && GRADE_RANK[grade] < GRADE_RANK[applied]) timeline.appliedGrade = grade;
    }
  }

  private scheduledTranscriptGrades: { handle: SessionViewSubscription; previous: TranscriptGradeSpec } | undefined;

  /**
   * Recompute the requested grades after a lease changed. The server hears at
   * most one grade change per microtask, and none when the leases taken and
   * released within it leave the grades where they were (each change
   * re-attaches the whole view).
   */
  private refreshTranscriptGrades(): void {
    if (this.closed) return;
    const nextGrades = this.requestedTranscriptGrades();
    const previous = this.transcriptGrades;
    if (Object.keys(previous).length === Object.keys(nextGrades).length &&
        Object.entries(nextGrades).every(([id, grade]) => previous[id] === grade)) return;
    for (const { agentId: id } of this.storeTimelines) {
      if (gradeFor(this.transcriptGrades, id) !== gradeFor(nextGrades, id)) {
        this.bumpHistoryGeneration(id);
        this.catchupReplay.delete(id);
      }
    }
    this.transcriptGrades = nextGrades;
    for (const timeline of this.storeTimelines) {
      const before = GRADE_RANK[gradeFor(previous, timeline.agentId)];
      const after = GRADE_RANK[gradeFor(nextGrades, timeline.agentId)];
      if (before === after) continue;
      // A raise re-seeds the agent: until its baseline (or the attachment's
      // `ready`) lands, the window shows what it holds.
      timeline.refreshing = after > before && after > GRADE_RANK.off && timeline.appliedGrade !== undefined;
      this.publishProjectedAgent(timeline.agentId, timeline.store);
    }
    const handle = this.viewHandle;
    if (handle === undefined || this.scheduledTranscriptGrades?.handle === handle) return;
    const scheduled = { handle, previous };
    this.scheduledTranscriptGrades = scheduled;
    queueMicrotask(() => {
      if (this.scheduledTranscriptGrades !== scheduled) return;
      this.scheduledTranscriptGrades = undefined;
      if (this.closed || this.isSuspended || this.viewHandle !== handle) return;
      if (Object.keys(scheduled.previous).length === Object.keys(this.transcriptGrades).length &&
        Object.entries(this.transcriptGrades).every(([id, grade]) => scheduled.previous[id] === grade)) return;
      this.lowerBaselinesTo(this.transcriptGrades);
      handle.setTranscriptGrades(this.transcriptGrades);
    });
  }

  /** The raised baseline an agent was waiting for has landed (or will not come): stop showing it as refreshing. */
  private settleRefresh(agentId: string): void {
    const timeline = this.timelines.get(agentId);
    if (timeline === undefined || !timeline.refreshing) return;
    timeline.refreshing = false;
    const view = timeline.view;
    if (view !== undefined && view.refreshing === true) this.publishView(agentId, { ...view, version: view.version + 1, refreshing: false });
    if (this.contentReaders.size > 0) void this.pumpContentReads();
  }

  private hasTranscriptBaseline(agentId: string): boolean {
    const applied = this.timelines.get(agentId)?.appliedGrade;
    return applied !== undefined && GRADE_RANK[applied] >= GRADE_RANK[gradeFor(this.transcriptGrades, agentId)];
  }

  /**
   * Whether the agent's timeline can be shown (`transcriptReady`): it has a
   * baseline at the requested grade, or it is waiting for a raised one over a
   * window built at that grade before the grade was lowered. The window then
   * shows what it holds, the turns updated while lowered marked stale, and
   * `refreshing` says the baseline is on its way. A window that was never
   * built at the requested grade (turn headers only) is not shown as loaded.
   */
  private transcriptPresentable(agentId: string): boolean {
    if (this.hasTranscriptBaseline(agentId)) return true;
    const timeline = this.timelines.get(agentId);
    return timeline?.appliedGrade !== undefined && timeline.windowGrade !== undefined &&
      GRADE_RANK[timeline.windowGrade] >= GRADE_RANK[gradeFor(this.transcriptGrades, agentId)];
  }

  handleSignal(signal: SessionViewSignal): void {
    if (this.closed || (this.connectionGeneration !== undefined && signal.generation < this.connectionGeneration)) return;
    this.connectionGeneration = signal.generation;
    switch (signal.type) {
      case 'status':
        if (signal.status !== 'open') this.handleWsDrop();
        return;
      case 'snapshot': {
        if (this.bootstrapOpening?.attachment !== this.viewAttachment) return;
        const snapshot = signal.snapshot;
        if (snapshot.session.id !== this.sessionId) {
          this.handleSignal({ type: 'protocolError', detail: 'Session snapshot identity changed', recoverable: false, generation: signal.generation });
          return;
        }
        this.latestSnapshot = snapshot;
        this.setSessionView(this.applyTranscriptShellSnapshot(snapshot), false);
        this.viewHandle?.updateSessionCursor(this.shell.cursor);
        this.finishBootstrapOpening();
        const main = this.timelines.get(MAIN_AGENT_ID)?.store;
        if (main !== undefined && this.hasTranscriptBaseline(MAIN_AGENT_ID)) this.publishProjectedAgent(MAIN_AGENT_ID, main);
        this.retireRequestedRosterAgents();
        this.publishForest();
        this.publish(MAIN_AGENT_ID);
        const queued = this.rosterRefreshQueuedCursor;
        this.rosterRefreshQueuedCursor = undefined;
        if (queued !== undefined && this.requestedRosterAgents.size > 0) void this.refreshRoster(queued);
        void this.refreshDurableIngress();
        return;
      }
      case 'ready':
        // The attachment is seeded: whatever a raise was waiting for has come.
        for (const { agentId } of this.timelines.values()) this.settleRefresh(agentId);
        if (this.resyncInFlight) return;
        if (this.shell.cursor.epoch !== undefined && signal.currentSessionCursor.epoch !== this.shell.cursor.epoch) {
          this.handleSubscribeRejected(signal.generation);
          return;
        }
        this.advanceSessionCursor(signal.currentSessionCursor);
        if (signal.reconnected) {
          this.handleReconnectAck();
          if (this.shell.snapshotSubagents.length > 0) void this.refreshRoster(signal.currentSessionCursor);
        }
        return;
      case 'sessionCursorAdvanced':
        this.advanceSessionCursor(signal.cursor);
        if (signal.title !== undefined && this.shell.session !== undefined) {
          this.setSessionView(setSessionRecord(this.sessionView(), { ...this.shell.session, title: signal.title }));
        }
        // A roster row this view already holds is re-read for the waking /
        // disposal flags the server stamps on it. An agent it has no row for
        // is one this event just created: the row (role profile and model)
        // only exists in the session snapshot, so ask for it — the spawn's
        // transcript op asks again if this read raced the row's creation.
        if (signal.rosterAgentId !== undefined) {
          if (this.hasRosterRow(signal.rosterAgentId)) void this.refreshRoster(signal.cursor);
          else this.requestRosterRows([signal.rosterAgentId], signal.cursor);
        }
        return;
      case 'historyRewritten':
        this.advanceSessionCursor(signal.cursor);
        if (this.shell.resyncError?.retryable !== false) void this.resync({ rewrite: true });
        return;
      case 'transcript':
        this.handleTranscript(signal.event, signal.generation);
        return;
      case 'protocolError': {
        if (this.shell.resyncError?.retryable === false) return;
        if (this.bootstrapOpening !== undefined) {
          this.finishBootstrapOpening();
          this.setShell(setLoadError(this.shell, signal.detail), false);
        }
        this.setShell({
          ...setResyncFailed(setResyncing(this.shell, false), true, this.shell.resyncAttempt + 1),
          resyncError: { message: signal.detail, code: API_CODES.INVALID_RESPONSE, retryable: signal.recoverable },
        });
        if (signal.recoverable) void this.resync();
        else {
          this.clearResyncTimer();
          this.clearRewriteHold();
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
          this.viewAttachment += 1;
          this.viewHandle?.close();
          this.viewHandle = undefined;
        }
        return;
      }
      case 'resyncRequired':
        if (this.shell.resyncError?.retryable === false) return;
        if (this.rewriteHold !== undefined) this.handleSubscribeRejected(signal.generation);
        else void this.resync({ rewrite: signal.reason === 'history_rewritten' });
        return;
    }
  }

  private queueAutomaticRosterRead(): void {
    if (this.closed || this.isSuspended || !this.shell.loaded || this.shell.resyncing || this.rosterReadQueued || this.rosterReadInFlight || this.olderLoads.hasActive()) return;
    const ref = this.latestSnapshot?.contentRefs?.find((entry) => entry.source.kind === 'snapshot' && entry.kind === 'array' && entry.path.length === 1 && entry.path[0] === 'subagents');
    if (ref === undefined || this.view.transcript.content === undefined || this.viewOf(MAIN_AGENT_ID).detailLoads[`content:${JSON.stringify(ref)}`]?.status === 'error') return;
    this.rosterReadQueued = true;
    queueMicrotask(() => {
      this.rosterReadQueued = false;
      if (this.closed || this.isSuspended || this.shell.resyncing || this.olderLoads.hasActive()) return;
      this.rosterReadInFlight = true;
      void this.loadContentSegment(MAIN_AGENT_ID, ref).then((advanced) => {
        this.rosterReadInFlight = false;
        if (advanced || !this.latestSnapshot?.contentRefs?.some((current) => sameContentRef(current, ref))) this.queueAutomaticRosterRead();
      });
    });
  }

  private mergeRosterRows(snapshot: SessionSnapshotResponse): readonly NonNullable<SessionSnapshotResponse['subagents']>[number][] {
    const incoming = snapshot.subagents ?? [];
    const rows = new Map(incoming.map((row) => [snapshotSubagentAgentId(row), row]));
    const partial = snapshot.contentRefs?.some((ref) => ref.path[0] === 'subagents' && ref.kind === 'array') === true;
    const stable = this.shell.snapshotSubagents.flatMap((old) => {
      const id = snapshotSubagentAgentId(old);
      const next = rows.get(id);
      rows.delete(id);
      return next === undefined ? partial ? [old] : [] : [next];
    });
    const merged = [...stable, ...rows.values()];
    if (merged.length > this.shell.snapshotSubagents.length) this.rosterRevisionRefreshes = 0;
    return merged;
  }

  /**
   * The session view with a session snapshot applied, for `setSessionView`:
   * the snapshot describes the session (record, cursor, roster) and main's
   * runtime state (in-flight turn, binding), so it spans both records.
   */
  private applyTranscriptShellSnapshot(snapshot: SessionSnapshotResponse): SessionViewState {
    return { ...applyTranscriptShell(this.sessionId, snapshot, this.sessionView()), snapshotSubagents: this.mergeRosterRows(snapshot) };
  }

  private async refreshRoster(cursor: SessionCursor): Promise<void> {
    if (this.closed || this.isSuspended || this.resyncInFlight) return;
    if (this.rosterRefreshInFlight || this.bootstrapOpening !== undefined) {
      const queued = this.rosterRefreshQueuedCursor;
      if (queued === undefined || cursor.epoch !== queued.epoch || cursor.seq > queued.seq) {
        this.rosterRefreshQueuedCursor = cursor;
      }
      return;
    }
    this.rosterRefreshInFlight = true;
    const attachment = this.viewAttachment;
    const generation = this.connectionGeneration;
    const bindings = new Map([...this.storeTimelines].map(({ agentId, store }) => [agentId, store.getMeta().agent]));
    try {
      const snapshot = await this.readSnapshot(true);
      const queued = this.rosterRefreshQueuedCursor;
      if (
        this.closed || this.isSuspended || this.resyncInFlight || attachment !== this.viewAttachment ||
        generation !== this.connectionGeneration || snapshot.epoch !== cursor.epoch || snapshot.epoch !== this.shell.cursor.epoch ||
        snapshot.as_of_seq < cursor.seq || (queued !== undefined && queued.epoch === cursor.epoch && snapshot.as_of_seq < queued.seq) ||
        snapshot.subagents === undefined
      ) return;
      const previous = this.latestSnapshot;
      const roster = previous?.epoch === snapshot.epoch ? mergeContentPreview(previous, snapshot) : snapshot;
      this.latestSnapshot = previous?.epoch === roster.epoch
        ? carryContentHydration(roster, {
          ...previous,
          subagents: roster.subagents,
          contentRefs: [...(previous.contentRefs ?? []).filter((ref) => ref.path[0] !== 'subagents'),
            ...(roster.contentRefs ?? []).filter((ref) => ref.path[0] === 'subagents')],
        }) : roster;
      this.setSessionView({
        ...this.sessionView(),
        snapshotSubagents: this.mergeRosterRows(roster),
        agentCounts: snapshot.agent_counts,
        contentRefs: stableContentRefs(this.viewOf(MAIN_AGENT_ID).contentRefs, [...collectTranscriptContentRefs(this.windowSnapshot(MAIN_AGENT_ID)), ...(this.latestSnapshot.contentRefs ?? [])]),
      }, false);
      for (const row of roster.subagents ?? []) {
        const id = snapshotSubagentAgentId(row);
        const binding = this.timelines.get(id)?.store?.getMeta().agent;
        if (gradeFor(this.transcriptGrades, id) === 'off' && binding !== undefined && binding === bindings.get(id)) {
          this.rosterTranscriptBindings.set(id, binding);
        }
      }
      this.retireRequestedRosterAgents();
      this.publishForest();
      this.publish(MAIN_AGENT_ID);
    } catch {
      // Best-effort: task ops and reconnect snapshots still recover the row.
    } finally {
      this.rosterRefreshInFlight = false;
      const queued = this.rosterRefreshQueuedCursor;
      this.rosterRefreshQueuedCursor = undefined;
      if (queued !== undefined && !this.closed && !this.resyncInFlight) void this.refreshRoster(queued);
    }
  }

  /** True when the roster already carries a row for this agent. */
  private hasRosterRow(agentId: string): boolean {
    return this.rosterAgentIds.has(agentId);
  }

  /** Forget ids the read answered, so they stop counting against the read budget. */
  private retireRequestedRosterAgents(): void {
    for (const agentId of this.requestedRosterAgents.keys()) {
      if (this.hasRosterRow(agentId)) this.requestedRosterAgents.delete(agentId);
    }
  }

  /**
   * Ask for the session's roster rows behind these agent ids. The roster is
   * the one place the client reads an agent's role profile and model, and a
   * view only picks up rows the session's own snapshot carried — an agent
   * spawned mid-session has to be asked for by id. `fresh` marks evidence the
   * server has already materialised the row (a spawn op the viewer's own
   * transcript stream carried): worth a read even when an earlier request for
   * the same id raced ahead of the row's creation. `MAX_ROSTER_ROW_READS` caps
   * what a row-less agent (an external delegation, say) can cost in reads.
   */
  private requestRosterRows(
    agentIds: Iterable<string>,
    cursor?: SessionCursor,
    fresh = false,
  ): void {
    if (this.closed || this.isSuspended) return;
    let wanted = false;
    for (const agentId of agentIds) {
      if (agentId === '' || agentId === MAIN_AGENT_ID) continue;
      if (this.hasRosterRow(agentId)) continue;
      const attempts = this.requestedRosterAgents.get(agentId) ?? 0;
      if (attempts >= MAX_ROSTER_ROW_READS) continue;
      if (!fresh && attempts > 0) continue;
      this.requestedRosterAgents.set(agentId, attempts + 1);
      wanted = true;
    }
    if (wanted) void this.refreshRoster(cursor ?? this.shell.cursor);
  }

  handleSubscribeRejected(generation?: number): void {
    if (this.closed || this.shell.resyncError?.retryable === false) return;
    const hold = this.rewriteHold;
    if (hold === undefined) {
      void this.resync();
      return;
    }
    if (!this.matchesRewriteGeneration(generation)) return;
    this.recoverRewriteHold(hold.token);
  }

  /** Volatile deltas are never journaled or replayed, so a turn that was
   * live when the socket dropped has holes the durable replay cannot fill.
   * Remember the drop; the next post-reconnect subscribe ack resyncs. */
  private droppedWithLiveWork = false;

  /**
   * Any agent this view receives counts, not only main: a drop while only a
   * subagent streams leaves the same holes. An agent at `off` receives
   * nothing, and its view may still say "running" from before it was
   * lowered, so it does not count.
   */
  handleWsDrop(): void {
    if (this.closed) return;
    for (const { agentId, view } of this.timelines.values()) {
      if (view === undefined || gradeFor(this.transcriptGrades, agentId) === 'off') continue;
      const streaming = view.blocks.some(
        (block) => (block.kind === 'assistant' || block.kind === 'thinking') && block.streaming,
      );
      if (view.busy || streaming) {
        this.droppedWithLiveWork = true;
        return;
      }
    }
  }

  handleReconnectAck(): void {
    if (this.closed || !this.droppedWithLiveWork || this.shell.resyncError?.retryable === false) return;
    this.droppedWithLiveWork = false;
    void this.refreshDurableIngress();
    const agents = [...this.storeTimelines].map(({ agentId }) => agentId);
    if (agents.length === 0) {
      void this.resync();
      return;
    }
    for (const agentId of agents) void this.catchUpAgent(agentId);
  }

  /** Rewrite resyncs requested while another resync was in flight — the
   * in-flight snapshot may predate the rewrite, so it re-runs afterwards. */
  private rewriteResyncQueued = false;
  private hardResyncQueued = false;

  private resolveResyncIdleWaiters(): void {
    const waiters = [...this.resyncIdleWaiters];
    this.resyncIdleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForResyncIdle(signal?: AbortSignal): Promise<'ready' | 'failed' | 'cancelled'> {
    const status = (): 'ready' | 'failed' | 'cancelled' => this.closed || this.isSuspended || signal?.aborted
      ? 'cancelled'
      : this.shell.resyncFailed ? 'failed' : 'ready';
    if (signal?.aborted || this.closed || this.isSuspended || !this.resyncInFlight) return Promise.resolve(status());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.resyncIdleWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(status());
      };
      this.resyncIdleWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (!this.resyncInFlight) finish();
    });
  }

  /** Refresh the session shell and subscription. Transcript baselines received
   * during the read retain their readiness, grade and resume cursor together;
   * a rewrite retains only baselines from a new transcript epoch. */
  async resync(options: { rewrite?: boolean } = {}): Promise<void> {
    if (this.closed || this.isSuspended) return;
    this.finishBootstrapOpening();
    const rewrite = options.rewrite === true;
    if (rewrite) this.beginRewriteHold();
    const rewriteHoldToken = rewrite ? this.rewriteHold?.token : undefined;
    if (this.resyncInFlight) {
      if (rewrite) this.rewriteResyncQueued = true;
      return;
    }
    this.resyncInFlight = true;
    this.resyncGeneration += 1;
    for (const { agentId } of this.storeTimelines) this.bumpHistoryGeneration(agentId);
    if (rewrite) this.rewriteResyncQueued = false;
    this.clearResyncTimer();
    this.setShell(setResyncing(this.shell, true));
    const attachment = this.viewAttachment;
    const baselineAtStart = new Map([...this.timelines.values()].map(({ agentId, baselineSerial }) => [agentId, baselineSerial]));
    const cursorsAtStart = rewrite ? new Map([...this.timelines.values()].map(({ agentId, cursor }) => [agentId, cursor])) : undefined;
    try {
      const snapshot = await this.readSnapshot();
      if (this.closed || attachment !== this.viewAttachment) return;
      for (const { agentId } of this.storeTimelines) this.bumpHistoryGeneration(agentId);
      this.catchupReplay.clear();
      const retainedReady = new Set([...this.storeTimelines].map(({ agentId }) => agentId).filter((agentId) => {
        const epoch = this.timelines.get(agentId)?.cursor?.epoch;
        return this.timelines.get(agentId)?.baselineSerial !== baselineAtStart.get(agentId) && this.hasTranscriptBaseline(agentId) &&
          (!rewrite || epoch !== undefined && epoch !== cursorsAtStart?.get(agentId)?.epoch);
      }));
      for (const agentId of this.pendingTranscriptBatches.keys()) if (!retainedReady.has(agentId)) this.pendingTranscriptBatches.delete(agentId);
      for (const agentId of this.pendingTranscriptAgents) if (!retainedReady.has(agentId)) this.pendingTranscriptAgents.delete(agentId);
      // Other agents' readiness is published as one batch after main's, which
      // goes out with the shell below. Each agent's older-history load state
      // is cleared as main's is: the resync cancelled those reads.
      for (const timeline of this.timelines.values()) {
        const { agentId, view } = timeline;
        if (agentId === MAIN_AGENT_ID || view === undefined) continue;
        const transcriptReady = retainedReady.has(agentId);
        if (view.transcriptReady === transcriptReady && !view.loadingOlder && view.olderError === undefined) continue;
        timeline.view = { ...view, version: view.version + 1, transcriptReady, loadingOlder: false, olderError: undefined };
        this.dirtyAgents.add(agentId);
      }
      const transcriptReady = retainedReady.has(MAIN_AGENT_ID);
      for (const timeline of this.timelines.values()) {
        if (retainedReady.has(timeline.agentId)) continue;
        timeline.cursor = undefined;
        timeline.appliedGrade = undefined;
      }
      this.setSessionView(
        setResyncing(
          {
            ...this.applyTranscriptShellSnapshot(snapshot),
            transcriptReady,
            loadingOlder: false,
            olderError: undefined,
          },
          false,
        ),
      );
      this.publishDirtyAgents();
      this.attachView({ seq: snapshot.as_of_seq, epoch: snapshot.epoch });
      if (rewriteHoldToken !== undefined) this.armRewriteSubscription(rewriteHoldToken);
    } catch (error) {
      if (rewriteHoldToken !== undefined) this.clearRewriteHold(rewriteHoldToken);
      if (!this.closed && !this.isSuspended && (attachment === this.viewAttachment || this.shell.resyncError?.retryable !== false)) {
        const attempt = this.shell.resyncAttempt + 1;
        const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
        const retryable = code === undefined || code === -1 || code === API_CODES.TIMEOUT ||
          code === API_CODES.SESSION_INDEX_BUILDING || code === 408 || code === 429 ||
          (code >= 500 && code < 600) || code >= 50000;
        this.setShell({
          ...setResyncFailed(setResyncing(this.shell, false), true, attempt),
          resyncError: {
            message: errorMessage(error, 'Could not restore session'),
            code,
            requestId: error instanceof ApiError ? error.requestId : undefined,
            retryable,
          },
        });
        if (retryable) this.scheduleResyncRetry();
        else {
          this.clearRewriteHold();
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
        }
      }
    } finally {
      this.resyncInFlight = false;
      let rerunQueued = false;
      if (!this.closed) {
        if (this.hardResyncQueued) {
          rerunQueued = true;
          this.hardResyncQueued = false;
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync());
        } else if (this.rewriteResyncQueued) {
          rerunQueued = true;
          this.rewriteResyncQueued = false;
          queueMicrotask(() => void this.resync({ rewrite: true }));
        }
      }
      if (!rerunQueued) this.resolveResyncIdleWaiters();
    }
  }

  private scheduleResyncRetry(): void {
    if (this.closed || this.isSuspended || this.resyncTimer !== null) return;
    const step = Math.min(this.shell.resyncAttempt, RESYNC_BACKOFF_MS.length) - 1;
    const delay = RESYNC_BACKOFF_MS[Math.max(0, step)] ?? 4000;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (!this.closed) void this.resync();
    }, delay);
  }

  setPersistenceHint(value: 'temporary' | 'saved' | 'unknown' | undefined): void {
    if (value === undefined) return;
    if (value === 'unknown' && this.persistenceHint !== undefined && this.persistenceHint !== 'unknown') return;
    if (value === 'temporary' && this.persistenceHint === 'saved') return;
    this.persistenceHint = value;
  }

  setEphemeralHint(value: boolean | undefined): void {
    if (value === undefined) return;
    if (value && this.persistenceHint === 'saved') return;
    this.ephemeralHint = value;
    this.setPersistenceHint(value ? 'temporary' : 'saved');
  }

  private usesDurableSubmission(): boolean {
    if (this.persistenceHint === 'temporary' || this.persistenceHint === 'unknown') return false;
    if (this.persistenceHint === 'saved') return true;
    return this.ephemeralHint !== true && this.shell.session?.ephemeral !== true;
  }

  private hasKnownSavedSession(): boolean {
    if (this.persistenceHint !== undefined) return this.persistenceHint === 'saved';
    return this.ephemeralHint === false || this.shell.session?.ephemeral === false;
  }

  handleSessionRecord = (record: Session): void => {
    if (record.id !== this.sessionId || this.closed) return;
    const current = this.shell.session;
    if (current === undefined || record.updated_at >= current.updated_at) {
      if (record.ephemeral !== undefined) this.setEphemeralHint(record.ephemeral);
      this.setSessionView(setSessionRecord(this.sessionView(), record));
    }
  };

  private setDurableIngress(records: readonly PromptItem[], agentId = MAIN_AGENT_ID): void {
    for (const record of records) {
      if (record.admission === 'failed' || record.admission === 'cancelled' || record.delivery_state === 'failed' || record.delivery_state === 'cancelled' ||
          (record.admission === 'admitted' && record.delivery_state === 'queued')) {
        this.reconcileSteerOutcome(agentId, record.prompt_id, this.settledSteerOutcome(agentId, record.prompt_id));
        continue;
      }
      const pending = this.findPendingSteer(agentId, record.prompt_id);
      if (pending === undefined) continue;
      const phase = record.admission === 'held' ? 'held'
        : record.admission === 'admitted' ? 'waiting'
        : (record.admission === 'restoring' || record.admission === 'waiting_switch') && pending.phase !== 'waiting' ? 'preparing' : pending.phase;
      if (phase !== pending.phase) this.setPendingSteer(agentId, { ...pending, phase });
      if (record.admission !== undefined) forgetUnconfirmedSubmission(this.sessionId, record.prompt_id);
    }
    const previous = this.shell.durableIngress ?? [];
    if (previous.length === records.length && previous.every((item, index) => {
      const next = records[index];
      return next !== undefined && item.prompt_id === next.prompt_id && item.status === next.status &&
        item.admission === next.admission && item.delivery_state === next.delivery_state && item.delivery_reason === next.delivery_reason && item.revision === next.revision &&
        item.admission_content_truncated === next.admission_content_truncated &&
        item.admission_error?.code === next.admission_error?.code &&
        item.admission_error?.message === next.admission_error?.message &&
        item.admission_duplicate_of === next.admission_duplicate_of &&
        item.restore_progress?.phase === next.restore_progress?.phase &&
        item.restore_progress?.elapsed_ms === next.restore_progress?.elapsed_ms &&
        item.restore_progress?.queue_position === next.restore_progress?.queue_position;
    })) return;
    this.setShell({ ...this.shell, version: this.shell.version + 1, durableIngress: [...records] });
  }

  private observeDurableSteer(agentId: string, promptId: string): void {
    if (this.client.getDurableIngress === undefined || this.closed) return;
    const key = JSON.stringify([agentId, promptId]);
    if (this.durableSteerReads.has(key)) return;
    this.durableSteerReads.set(key, { agentId, promptId });
    this.scheduleDurableSteerRead();
  }

  private scheduleDurableSteerRead(): void {
    if (this.durableSteerReads.size === 0 || this.durableSteerReadTimer !== undefined || this.durableSteerReadInFlight || this.closed || this.isSuspended) return;
    this.durableSteerReadTimer = setTimeout(() => {
      this.durableSteerReadTimer = undefined;
      void this.readDurableSteer();
    }, 500);
  }

  private async readDurableSteer(): Promise<void> {
    const first = this.durableSteerReads.entries().next().value;
    if (first === undefined || this.closed || this.isSuspended) return;
    const [key, target] = first;
    if (this.findPendingSteer(target.agentId, target.promptId) === undefined) {
      this.durableSteerReads.delete(key);
      this.scheduleDurableSteerRead();
      return;
    }
    const generation = this.durableSteerReadGeneration;
    this.durableSteerReadInFlight = true;
    try {
      const result = await this.client.getDurableIngress!(this.sessionId, target.promptId, target.agentId);
      if (this.closed || this.isSuspended || generation !== this.durableSteerReadGeneration) return;
      this.setDurableIngress([...this.getDurableIngress().filter(item => item.prompt_id !== result.prompt_id), result], target.agentId);
      if (result.admission !== 'restoring' && result.admission !== 'waiting_switch') this.durableSteerReads.delete(key);
    } catch {
      // Retry only the receipt read; a missing response never replays the submission.
    } finally {
      this.durableSteerReadInFlight = false;
      if (this.durableSteerReads.delete(key) && !this.closed) this.durableSteerReads.set(key, target);
      this.scheduleDurableSteerRead();
    }
  }

  private pauseDurableSteerReads(): void {
    this.durableSteerReadGeneration += 1;
    if (this.durableSteerReadTimer !== undefined) clearTimeout(this.durableSteerReadTimer);
    this.durableSteerReadTimer = undefined;
  }

  async refreshDurableIngress(): Promise<void> {
    const read = this.client.listDurableIngress?.bind(this.client);
    if (read === undefined || !this.hasKnownSavedSession() || this.closed || this.isSuspended) return;
    if (this.durableIngressReadInFlight !== undefined) return this.durableIngressReadInFlight;
    let request!: Promise<void>;
    request = (async () => {
      try {
        const records: PromptItem[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const result = await read(this.sessionId, { cursor });
          if (this.closed || this.isSuspended) return;
          records.push(...(result.ingress ?? []));
          const next = result.ingress_next_cursor;
          if (next === undefined || cursors.has(next)) break;
          cursors.add(next);
          cursor = next;
        }
        if (!this.closed && !this.isSuspended) this.setDurableIngress(records);
      } catch {
        // Durable ingress is an auxiliary recovery read; prompt submission and
        // the ordered transcript remain usable when this best-effort probe fails.
      } finally {
        if (this.durableIngressReadInFlight === request) this.durableIngressReadInFlight = undefined;
      }
    })();
    this.durableIngressReadInFlight = request;
    return request;
  }

  async refreshDurablePrompt(promptId: string): Promise<void> {
    const read = this.client.getDurableIngress?.bind(this.client);
    if (read === undefined || this.closed || this.isSuspended) return;
    const result = await read(this.sessionId, promptId);
    if (this.closed || this.isSuspended) return;
    this.setDurableIngress([...this.getDurableIngress().filter(item => item.prompt_id !== promptId), result]);
  }

  getDurableIngress(): readonly PromptItem[] {
    return this.shell.durableIngress ?? [];
  }

  async resumeDurableIngress(promptId: string, body: PromptSubmission, agentId = MAIN_AGENT_ID): Promise<PromptItem> {
    const resume = this.client.resumeDurableIngress?.bind(this.client);
    if (resume === undefined) throw new Error('Durable prompt recovery is unavailable on this transport');
    const result = await resume(this.sessionId, promptId, {
      ...body,
      admission: 'durable',
      prompt_id: promptId,
      agent_id: body.agent_id ?? (agentId === MAIN_AGENT_ID ? undefined : agentId),
    }, agentId);
    const admissionRejected = result.admission === 'failed' || result.admission === 'cancelled';
    if (!admissionRejected) forgetUnconfirmedSubmission(this.sessionId, promptId);
    if (result.admission !== undefined) {
      this.setDurableIngress([
        ...this.getDurableIngress().filter((item) => item.prompt_id !== promptId),
        result,
      ]);
    }
    if (admissionRejected || result.admission === 'restoring' || result.admission === 'waiting_switch' || result.admission === 'held') return result;
    const main = this.viewOf(MAIN_AGENT_ID);
    if (!main.blocks.some((block) => block.kind === 'user' && block.promptId === result.prompt_id)) {
      const projection = projectMessageContent(result.content);
      this.publishView(MAIN_AGENT_ID, appendLocalUserMessage(main, {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
        appendTiming: result.append_timing,
      }));
    }
    return result;
  }

  async refreshPrompts(): Promise<void> {
    await this.refreshDurableIngress();
  }

  async refreshTasks(): Promise<void> {
    // Task rail truth is projected from the canonical transcript.
  }

  async refreshGoal(): Promise<void> {
    // Goal truth is projected from the canonical transcript.
  }

  /** Re-read the session record (post-rebind the echoed `agent_config` is the
   * only profile truth — no WS frame carries it). */
  async refreshSession(): Promise<void> {
    try {
      const record = await this.client.getSession(this.sessionId);
      if (!this.closed) this.handleSessionRecord(record);
    } catch {
      // Best-effort: the next snapshot/poll repaints the binding regardless.
    }
  }

  /** Hydrate forward structure for a mounted turn; older suffix predecessors wait for loadOlderMessages or an explicit content read. */
  retainHistoryStructure(agentId: string, turnId: string): () => void {
    const lease = this.beginContentRead(agentId, { kind: 'turn', id: turnId }, ['steps'], false);
    return () => { lease.release(); };
  }

  /**
   * A mounted timeline row of this turn. The window keeps every turn from the
   * oldest one a row is mounted for, and while rows are mounted the reader
   * follows the tail only if one of them belongs to the newest turn (see
   * `trimWindow`). Release when the row unmounts or the timeline hides.
   */
  retainHistoryPreview(agentId: string, turnId: string): () => void {
    const timeline = this.timeline(agentId);
    const leases = timeline.viewLeases;
    leases.set(turnId, (leases.get(turnId) ?? 0) + 1);
    if (timeline.pagedPin !== undefined && !timeline.readerVisitedOld) {
      const ordinal = timeline.store?.getTurn(turnId)?.ordinal;
      if (ordinal !== undefined && ordinal < timeline.pagedPin) timeline.readerVisitedOld = true;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (leases.get(turnId) ?? 1) - 1;
      if (remaining > 0) leases.set(turnId, remaining);
      else leases.delete(turnId);
    };
  }

  private cancelHistoryRead(agentId: string): void {
    this.olderLoads.cancel(agentId);
    const current = this.viewOf(agentId);
    if (current.loadingOlder) this.publishView(agentId, setLoadingOlder(current, false));
  }

  async loadOlderMessages(agentId: string = MAIN_AGENT_ID, signal?: AbortSignal): Promise<boolean> {
    return (await this.loadOlderHistory(agentId, signal)).changed;
  }

  /**
   * Older history waited for a resync that then failed. The session banner
   * reports the resync; the place the reader asked for history must show the
   * failure too, with its retry, instead of ending silently.
   */
  private olderLoadFailedByResync(agentId: string): OlderLoadResult {
    const current = this.viewOf(agentId);
    this.publishView(agentId, setOlderError(current, this.shell.resyncError?.message ?? 'Could not restore session'));
    return { kind: 'failed', changed: false };
  }

  loadOlderHistory(agentId: string = MAIN_AGENT_ID, signal?: AbortSignal): Promise<OlderLoadResult> {
    if (this.closed || this.isSuspended) return Promise.resolve({ kind: 'cancelled', changed: false });
    const backoff = new PreparingBackoff();
    const start = (): Promise<OlderLoadResult> => {
      const resyncGeneration = this.resyncGeneration;
      return this.olderLoads.request(agentId, (sharedSignal) => this.loadOlderTranscript(agentId, sharedSignal), signal).then((result) => {
        if ((result.kind !== 'cancelled' && result.kind !== 'preparing') || signal?.aborted || this.closed || this.isSuspended ||
          resyncGeneration === this.resyncGeneration) return result;
        return this.resumeOlderLoadAfterResync(agentId, backoff, start, signal);
      }).finally(() => {
        this.queueAutomaticRosterRead();
      });
    };
    if (!this.resyncInFlight) return start();
    return this.waitForResyncIdle(signal).then((resyncStatus) => {
      if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
      if (resyncStatus === 'failed') return this.olderLoadFailedByResync(agentId);
      return start();
    });
  }

  /**
   * An older read ended because of a resync: one interrupted it, or a stale
   * answer asked for one (a stale page returns `preparing`; a stale opening
   * recovery is cancelled by the resync it started). The reader's demand
   * stands, so wait for the resync and read again. Repeats back off like any
   * preparing read, so a source that keeps answering stale cannot drive
   * resyncs back to back; one unrelated resync costs a single 80 ms wait.
   */
  private async resumeOlderLoadAfterResync(agentId: string, backoff: PreparingBackoff,
    start: () => Promise<OlderLoadResult>, signal?: AbortSignal): Promise<OlderLoadResult> {
    const resyncStatus = await this.waitForResyncIdle(signal);
    if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
    if (resyncStatus === 'failed') return this.olderLoadFailedByResync(agentId);
    await backoff.wait(signal);
    if (signal?.aborted === true || this.closed || this.isSuspended) return { kind: 'cancelled', changed: false };
    return start();
  }

  locateTurn(agentId: string = MAIN_AGENT_ID, turnId: string, signal?: AbortSignal): Promise<OlderLoadResult> {
    if (this.closed || this.isSuspended) return Promise.resolve({ kind: 'cancelled', changed: false });
    const backoff = new PreparingBackoff();
    const start = (): Promise<OlderLoadResult> => {
      const resyncGeneration = this.resyncGeneration;
      return this.olderLoads.request(agentId, (sharedSignal) => this.loadOlderTranscript(agentId, sharedSignal, turnId), signal).then((result) => {
        if ((result.kind !== 'cancelled' && result.kind !== 'preparing') || signal?.aborted || this.closed || this.isSuspended ||
          resyncGeneration === this.resyncGeneration) return result;
        return this.resumeOlderLoadAfterResync(agentId, backoff, start, signal);
      }).finally(() => {
        this.queueAutomaticRosterRead();
      });
    };
    if (!this.resyncInFlight) return start();
    return this.waitForResyncIdle(signal).then((resyncStatus) => {
      if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
      if (resyncStatus === 'failed') return this.olderLoadFailedByResync(agentId);
      return start();
    });
  }

  /** An older read (a page run or a locate); the window is not trimmed while one runs (`trimWindow`). */
  private async loadOlderTranscript(agentId: string, signal: AbortSignal, targetTurnId?: string): Promise<OlderLoadResult> {
    const timeline = this.timeline(agentId);
    timeline.paging += 1;
    try {
      return await this.readOlderTranscript(agentId, signal, targetTurnId);
    } finally {
      timeline.paging -= 1;
    }
  }

  private async readOlderTranscript(agentId: string, signal: AbortSignal, targetTurnId?: string): Promise<OlderLoadResult> {
    if (this.resyncInFlight) {
      const resyncStatus = await this.waitForResyncIdle(signal);
      if (resyncStatus === 'cancelled') return { kind: 'cancelled', changed: false };
      if (resyncStatus === 'failed') return this.olderLoadFailedByResync(agentId);
    }
    if (!this.flushPendingTranscriptBatch(agentId)) return { kind: 'cancelled', changed: false };
    const store = this.ensureAgentTranscript(agentId);
    const generation = this.generationOf(agentId);
    const obsolete = () => this.closed || signal.aborted || this.timelines.get(agentId)?.store !== store ||
      this.generationOf(agentId) !== generation;
    if (this.pendingTranscriptAgents.delete(agentId)) this.publishProjectedAgent(agentId, store);
    let currentSnapshot = this.windowSnapshot(agentId);
    const hasCompleteTargetTurn = (snapshot: AgentTranscriptSnapshot): boolean => {
      if (targetTurnId === undefined) return false;
      const found = snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === targetTurnId);
      if (found === undefined) return false;
      const missingOpening = found.origin.kind === 'other' && found.message === undefined && found.promptId === undefined && found.startedAt === undefined;
      return !missingOpening || !snapshot.hasMoreOlder;
    };
    if (hasCompleteTargetTurn(currentSnapshot)) {
      this.publishProjectedAgent(agentId, store);
      return { kind: 'advanced', changed: true };
    }
    const firstTurn = currentSnapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn');
    const olderStructure = (() => {
      if (targetTurnId !== undefined || firstTurn === undefined || this.turnHasGap(agentId, firstTurn.turnId)) return undefined;
      const refs = (firstTurn.contentRefs ?? []).filter((ref) => ref.direction === 'backward');
      const firstStep = firstTurn.steps[0]?.ordinal;
      const firstFrames = refs.find((ref) => ref.path.length === 3 && ref.path[1] === firstStep);
      return firstFrames ?? refs.find((ref) => ref.path.length === 1) ?? refs.toSorted((a, b) => Number(a.path[1]) - Number(b.path[1]))[0];
    })();
    if (olderStructure !== undefined) {
      const retention = this.beginContentRead(agentId, olderStructure.source, [String(olderStructure.path[0])], false);
      const loadingView = this.viewOf(agentId);
      this.publishView(agentId, setLoadingOlder(loadingView, true));
      const cancel = () => { this.cancelContentSegment(agentId, olderStructure); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const changed = !signal.aborted && await this.loadContentSegment(agentId, olderStructure);
        if (obsolete()) return { kind: 'cancelled', changed: false };
        const current = this.viewOf(agentId);
        if (changed) {
          this.publishView(agentId, { ...setLoadingOlder(current, false), olderError: undefined });
          return { kind: 'advanced', changed: true };
        }
        const detail = current.detailLoads[`content:${JSON.stringify(olderStructure)}`];
        this.publishView(agentId, setOlderError(current, detail?.status === 'error' ? detail.message : 'Could not load earlier content'));
        return { kind: 'failed', changed: false };
      } finally {
        signal.removeEventListener('abort', cancel);
        retention.release();
        if (!obsolete()) {
          const current = this.viewOf(agentId);
          if (current.loadingOlder) this.publishView(agentId, setLoadingOlder(current, false));
        }
      }
    }
    let beforeItem = this.timelines.get(agentId)?.olderCursor;
    let beforeTurn = beforeItem === undefined
      ? this.timelines.get(agentId)?.olderTurn ?? currentSnapshot.items.find((item) => item.kind === 'turn')?.turnId : undefined;
    if (!currentSnapshot.hasMoreOlder) {
      // Nothing older exists, but an incomplete oldest turn still has steps to
      // load (the published `hasMoreHistory` says so): read its structure
      // rather than report the beginning of history without asking anything.
      // A locate takes this step too, so "more history" always means a load
      // makes progress and a missing target ends as not found, not as a stall.
      if (firstTurn !== undefined && this.turnHasGap(agentId, firstTurn.turnId)) {
        return this.loadOldestTurnStructure(agentId, firstTurn.turnId, signal, obsolete);
      }
      return { kind: 'exhausted', changed: false };
    }
    if (beforeItem === undefined && beforeTurn === undefined) {
      const current = this.viewOf(agentId);
      this.publishView(agentId, setOlderError(current, 'History window has no continuation cursor'));
      return { kind: 'failed', changed: false };
    }
    const loadingView = this.viewOf(agentId);
    this.publishView(agentId, setLoadingOlder(loadingView, true));
    try {
      const rememberContinuationCursor = (nextCursor: string | undefined): void => {
        if (nextCursor === undefined) return;
        beforeItem = nextCursor;
        beforeTurn = undefined;
        this.timeline(agentId).olderCursor = nextCursor;
        this.timeline(agentId).olderTurn = undefined;
      };
      let batchChanged = false;
      const backoff = new PreparingBackoff();
      const nextCursorOrphan = (cursor: string | undefined): string | undefined => {
        if (cursor === undefined || cursor.startsWith('~') || cursor.includes(':')) return undefined;
        try {
          const bytes = typeof atob === 'function'
            ? Uint8Array.from(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')), char => char.codePointAt(0) ?? 0)
            : undefined;
          const json = bytes === undefined ? undefined : new TextDecoder().decode(bytes);
          const parsed = json === undefined ? undefined : JSON.parse(json) as { v?: unknown; orphanTurn?: unknown };
          return parsed?.v === 2 && typeof parsed.orphanTurn === 'string' && /^t\d+$/.test(parsed.orphanTurn) ? parsed.orphanTurn : undefined;
        } catch {
          return undefined;
        }
      };
      for (;;) {
        const read = () => this.view.transcript.page({ agentId, beforeTurn, beforeItem, pageSize: OLDER_PAGE_TURNS }, { signal });
        // A page without a watermark reflects at least the state the window
        // was at when it was asked for.
        const requestMark = this.timelines.get(agentId)?.cursor;
        let page = await this.readPreparedContent(read, signal);
        if (obsolete()) return { kind: 'cancelled', changed: false };
        if (page.agent_id !== agentId) throw new Error('History page returned a different agent');
        if (page.read?.stale !== undefined) {
          this.timeline(agentId).historyRead = page.read;
          this.publishProjectedAgent(agentId, store, { historyCoverageKind: 'unknown' });
          beforeItem = undefined;
          const oldest = currentSnapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn');
          beforeTurn = oldest?.turnId;
          if (page.read.stale.retry === 'resync' || beforeTurn === undefined) {
            this.publishProjectedAgent(agentId, store, { loadingOlder: false, historyCoverageKind: 'unknown' });
            void this.resync();
            return { kind: 'preparing', changed: false };
          }
          let recovered: TranscriptTurn | undefined;
          if (oldest?.origin.kind === 'other' && oldest.message === undefined && oldest.promptId === undefined && oldest.startedAt === undefined) {
            const preview = await this.readTurnContentPreview(agentId, oldest.turnId, signal, true);
            if (obsolete()) return { kind: 'cancelled', changed: false };
            if (preview?.startedAt === undefined) throw new Error('Could not recover the earlier message opening');
            const { steps: _steps, contentRefs, ...header } = preview;
            recovered = {
              ...oldest, ...header, state: oldest.state, endedAt: oldest.endedAt,
              contentRefs: [
                ...(oldest.contentRefs ?? []).filter(ref => ref.path[0] === 'steps'),
                ...(contentRefs ?? []).filter(ref => ref.path[0] !== 'steps'),
              ],
            };
          }
          page = await this.readAuthoritativeTranscriptContinuation(read, 'History continuation is still stale', signal);
          if (obsolete()) return { kind: 'cancelled', changed: false };
          if (page.agent_id !== agentId) throw new Error('History page returned a different agent');
          if (recovered !== undefined) page = { ...page, items: [...page.items.filter(item => item.kind !== 'turn' || item.turnId !== recovered.turnId), recovered] };
        }
        const nextTurn = page.items.find((item) => item.kind === 'turn')?.turnId;
        const pageReadiness = page.read?.readiness;
        const emptyContinuation = page.has_more && page.items.length === 0;
        const readIsPreparing = emptyContinuation && pageReadiness === 'preparing';
        const readIsPartial = emptyContinuation && pageReadiness === 'partial';
        let recoveredOpening = false;
        const knownItems = new Set(currentSnapshot.items.map(item => item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`));
        const addedItems = page.items.some(item => !knownItems.has(item.kind === 'turn' ? `turn:${item.turnId}` : item.kind === 'marker' ? `marker:${item.markerId}` : `taskref:${item.refId}`));
        for (const item of page.items) {
          if (item.kind !== 'turn' || item.startedAt === undefined) continue;
          const live = store.getTurn(item.turnId);
          const current = live ?? currentSnapshot.items.find((existing): existing is TranscriptTurn => existing.kind === 'turn' && existing.turnId === item.turnId);
          const wasOrphan = current?.origin.kind === 'other' && current.message === undefined && current.promptId === undefined && current.startedAt === undefined;
          if (!wasOrphan && (addedItems || (page.next_cursor === undefined ? page.has_more : page.next_cursor === beforeItem))) continue;
          recoveredOpening = true;
        }
        if (page.has_more && !readIsPreparing && !readIsPartial && !addedItems && !recoveredOpening &&
            (page.next_cursor !== undefined ? page.next_cursor === beforeItem : nextTurn === undefined || nextTurn === beforeTurn)) {
          throw new Error('History page did not advance its cursor');
        }
        if (page.read !== undefined) this.timeline(agentId).historyRead = page.read;
        if (this.flushPendingTranscriptBatch(agentId)) this.observeToolCount(agentId, page);
        if (readIsPreparing || readIsPartial) {
          // The server hands back the continuation it is still preparing; only
          // a different one means this slice moved the read forward.
          if (page.next_cursor !== undefined && page.next_cursor !== beforeItem) backoff.progressed();
          rememberContinuationCursor(page.next_cursor);
          this.publishProjectedAgent(agentId, store, {
            loadingOlder: true,
            fetchedOlder: true,
            olderError: undefined,
            historyCoverageKind: 'unknown',
          });
          await backoff.wait(signal);
          if (obsolete()) return { kind: 'cancelled', changed: false };
          continue;
        }
        backoff.progressed();
        this.placeOlderPage(agentId, store, page, page.read?.watermark?.transcript ?? page.cursor ?? requestMark);
        if (page.next_cursor !== undefined) this.timeline(agentId).olderCursor = page.next_cursor;
        else this.timeline(agentId).olderCursor = undefined;
        if (nextTurn !== undefined) this.timeline(agentId).olderTurn = nextTurn;
        else this.timeline(agentId).olderTurn = undefined;
        this.forestDirtyAgents.add(agentId);
        if (page.items.length > 0 || page.next_cursor !== beforeItem) batchChanged = true;
        currentSnapshot = this.windowSnapshot(agentId);
        const pendingOrphan = targetTurnId === undefined ? nextCursorOrphan(page.next_cursor) : undefined;
        const shouldContinueBatch = page.has_more && page.next_cursor !== undefined && page.next_cursor !== beforeItem && (
          (recoveredOpening && !addedItems) ||
          (targetTurnId !== undefined && !hasCompleteTargetTurn(currentSnapshot)) ||
          (pendingOrphan !== undefined && page.items.length === 1 && page.items[0]?.kind === 'turn' && page.items[0].turnId === pendingOrphan)
        );
        if (shouldContinueBatch) {
          beforeItem = page.next_cursor;
          beforeTurn = undefined;
          if (targetTurnId === undefined) {
            this.publishProjectedAgent(agentId, store, {
              loadingOlder: true,
              fetchedOlder: true,
              olderError: undefined,
              historyCoverageKind: page.coverage?.kind === 'unknown' ? 'unknown' : undefined,
            });
          }
          await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
          if (obsolete()) return { kind: 'cancelled', changed: false };
          continue;
        }
        this.publishProjectedAgent(agentId, store, {
          loadingOlder: false,
          fetchedOlder: true,
          olderError: undefined,
          historyCoverageKind: page.coverage?.kind === 'unknown' ? 'unknown'
            : !page.has_more && page.coverage !== undefined ? 'full' : undefined,
        });
        const changed = batchChanged || page.items.length > 0 || page.next_cursor !== beforeItem;
        if (!page.has_more) return { kind: 'exhausted', changed };
        return { kind: 'advanced', changed: true };
      }
    } catch (error) {
      if (obsolete()) return { kind: 'cancelled', changed: false };
      const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
      const current = this.viewOf(agentId);
      if (code === 40923) {
        this.publishView(agentId, { ...setLoadingOlder(current, false), olderError: undefined });
        return { kind: 'preparing', changed: false };
      }
      this.publishView(agentId, setOlderError(current, errorMessage(error, 'Could not load earlier messages')));
      return { kind: 'failed', changed: false };
    }
  }

  /**
   * Older-history demand on an incomplete oldest turn with nothing older
   * behind it. Holds the same structure reader a visible or expanded row of
   * that turn would (one lease key, so the turn is not read twice) and settles
   * when the structure is complete, its read fails, or the demand goes away.
   */
  private async loadOldestTurnStructure(agentId: string, turnId: string, signal: AbortSignal, obsolete: () => boolean): Promise<OlderLoadResult> {
    const source = { kind: 'turn' as const, id: turnId };
    const view = () => this.viewOf(agentId);
    const priorFailure = view().detailLoads[`structure:${turnId}`];
    const lease = this.beginContentRead(agentId, source, ['steps']);
    this.publishView(agentId, setLoadingOlder(view(), true));
    try {
      for (;;) {
        await waitUnlessAborted(10, signal);
        if (obsolete()) return { kind: 'cancelled', changed: false };
        if (!this.turnHasGap(agentId, turnId)) {
          this.publishView(agentId, { ...setLoadingOlder(view(), false), olderError: undefined });
          return { kind: 'advanced', changed: true };
        }
        const load = view().detailLoads[`structure:${turnId}`];
        if (load?.status === 'error' && load !== priorFailure) {
          this.publishView(agentId, setOlderError(view(), load.message));
          return { kind: 'failed', changed: false };
        }
      }
    } finally {
      lease.release();
      if (!obsolete() && view().loadingOlder) this.publishView(agentId, setLoadingOlder(view(), false));
    }
  }

  private applyTranscriptReset(
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    coverage: TranscriptCoverage,
    cursor: TranscriptCursor,
    grade: TranscriptGrade,
    read?: TranscriptRead,
  ): void {
    this.pendingTranscriptBatches.delete(agentId);
    this.pendingTranscriptAgents.delete(agentId);
    this.catchupReplay.delete(agentId);
    const store = this.ensureAgentTranscript(agentId);
    const retainedBodies = [...this.contentBodies.entries()].filter(([, entry]) => entry.agentId === agentId);
    this.bumpHistoryGeneration(agentId);
    for (const key of this.entityPageCursors.keys()) if (key.startsWith(`${agentId}/`)) this.entityPageCursors.delete(key);
    this.timeline(agentId).todoRead = undefined;
    for (const kind of ['task', 'attachment', 'prompt', 'interaction', 'todo'] as const) {
      const key = `entities:${kind}`;
      const requestKey = `${agentId}/${key}`;
      this.detailReads.delete(requestKey);
      this.setDetailLoad(agentId, key, undefined);
    }
    const timeline = this.timeline(agentId);
    const previousKind = this.viewOf(agentId).historyCoverageKind;
    const window = this.resetWindow(timeline, store, snapshot, coverage, cursor, grade);
    store.apply([{ op: 'reset', agentId, snapshot: { ...snapshot, items: window.incoming }, coverage, grade: grade === 'off' ? undefined : grade, read }]);
    const current = store.getItems();
    // A covered reset decided its range in the store; an unknown-coverage one
    // left held copies in place, so its own resolved copies are taken.
    const stored = new Map(current.map((item) => [windowItemKey(item), item] as const));
    const resetItems = coverage.kind !== 'unknown' ? current.filter((item) => window.resetKeys.has(windowItemKey(item)))
      : window.incoming.map((item) => {
        const held = stored.get(windowItemKey(item));
        return held !== undefined && (held === item || transcriptValueEquals(held, item)) ? held : item;
      });
    const final = window.kept.length === 0 ? resetItems : placeTranscriptItems(resetItems, window.kept, (resident) => resident);
    const keptEdge = window.kept.length > 0;
    const unsure = coverage.kind === 'unknown' && (coverage.hasMoreOlder || snapshot.hasMoreOlder === true);
    const hasMoreOlder = keptEdge ? window.held.hasMoreOlder || unsure
      : coverage.kind === 'unknown' && snapshot.items.length === 0
        ? window.held.hasMoreOlder || coverage.hasMoreOlder || snapshot.hasMoreOlder === true
        : snapshot.hasMoreOlder ?? coverage.hasMoreOlder;
    if (final.length !== current.length || final.some((item, index) => item !== current[index])) store.replaceItems(final, hasMoreOlder);
    else store.setHasMoreOlder(hasMoreOlder);
    if (!keptEdge) {
      timeline.olderCursor = snapshot.olderCursor;
      timeline.olderTurn = snapshot.items.find((item) => item.kind === 'turn')?.turnId;
    }
    this.settleWindowAfterReset(timeline, store, window, cursor, grade);
    for (const target of this.contentReaders.values()) if (target.agentId === agentId) target.blocked = false;
    for (const [key, entry] of retainedBodies) {
      const entity = this.contentEntity(agentId, entry.source);
      if (entity === undefined) this.contentBodies.delete(key);
      else this.contentBodies.set(key, { ...entry, base: snapshotContentEntity(snapshot, entry.source) ?? entry.base, bytes: this.bytesOf(entity) });
    }
    this.timeline(agentId).cursor = cursor;
    if (read !== undefined) this.timeline(agentId).historyRead = read;
    else this.timeline(agentId).historyRead = undefined;
    this.timeline(agentId).appliedGrade = grade;
    this.timeline(agentId).baselineSerial = ++this.transcriptBaselineClock;
    if (this.hasTranscriptBaseline(agentId)) this.viewHandle?.updateTranscriptCursor(agentId, cursor);
    this.forestDirtyAgents.add(agentId);
    this.timeline(agentId).globalCoverage = snapshot.globalCoverage;
    this.publishProjectedAgent(agentId, store, {
      loadingOlder: false,
      olderError: undefined,
      retainPendingPrompts: true,
      transcriptReset: coverage.kind === 'full',
      historyCoverageKind: coverage.kind === 'full' || keptEdge && !hasMoreOlder && previousKind === 'full' && coverage.kind !== 'unknown' ? 'full'
        : coverage.kind === 'unknown' || previousKind === 'unknown' ? 'unknown' : 'tail',
    });
    // Queued / running prompts are actionable (edit, reorder, steer); a
    // windowed reset that dropped their content must not hide them.
    for (const prompt of snapshot.prompts) {
      if (prompt.detailRef === undefined || prompt.content !== undefined) continue;
      if (prompt.status !== 'queued' && prompt.status !== 'running') continue;
      void this.loadTranscriptDetail(agentId, 'prompt', prompt.promptId);
    }
  }

  /**
   * Read the canonical body of one windowed entity (a truncated task output,
   * an attachment whose source was omitted, a long prompt) and fold it into
   * the agent's store. Loading and failure states publish through
   * `detailLoads`; a retry is just another call.
   */
  async loadTranscriptDetail(agentId: string, kind: TranscriptDetailKind, id: string): Promise<boolean> {
    const read = this.view.transcript.detail?.bind(this.view.transcript);
    const key = transcriptDetailKey(kind, id);
    if (this.closed || read === undefined) return false;
    const inFlight = this.detailReads.get(`${agentId}/${key}`);
    if (inFlight !== undefined) return inFlight;
    const generation = this.generationOf(agentId);
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        const detail = await this.readPreparedContent(() => read({ agentId, kind, id }, { signal: controller.signal }), controller.signal);
        if (this.closed || this.generationOf(agentId) !== generation) return false;
        const applied = this.applyTranscriptDetail(agentId, detail);
        this.setDetailLoad(agentId, key, undefined);
        return applied;
      } catch (error) {
        if (this.closed) return false;
        this.setDetailLoad(agentId, key, {
          status: 'error',
          message: errorMessage(error, 'Could not load the full content'),
        });
        return false;
      }
    })().finally(() => {
      this.snapshotControllers.delete(controller);
      this.detailReads.delete(`${agentId}/${key}`);
    });
    this.detailReads.set(`${agentId}/${key}`, run);
    return run;
  }

  async copyToolCallField(agentId: string, toolCallId: string, root: 'input' | 'output', signal?: AbortSignal): Promise<string> {
    const lookup = await this.lookupToolCallForCopy(agentId, toolCallId, signal);
    const source = { kind: 'frame' as const, id: lookup.frame.frameId, turnId: lookup.turnId, stepId: lookup.stepId };
    const field = root === 'input' && lookup.frame.input === undefined ? 'inputText' : root === 'output' && lookup.frame.output === undefined ? 'error' : root;
    return this.copyResolvedContentField(agentId, source, [field], signal);
  }

  private async lookupToolCallForCopy(agentId: string, toolCallId: string, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      const lookup = await this.lookupToolCall(agentId, toolCallId, signal);
      if (lookup.status === 'preparing') {
        await this.waitForToolDetailPreparation(signal);
        continue;
      }
      if (lookup.status !== 'found') throw new Error('Invocation is not ready');
      return lookup;
    }
  }

  private waitForToolDetailPreparation(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(new DOMException('Read cancelled', 'AbortError'));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, TOOL_DETAIL_PREPARING_RETRY_MS);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  getToolCallDetail(agentId: string, toolCallId: string): Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup'] | undefined {
    return this.toolDetails.get(`${agentId}/${toolCallId}`);
  }

  async lookupToolCall(agentId: string, toolCallId: string, signal?: AbortSignal): Promise<Extract<SessionViewTranscriptDetail, { kind: 'tool' }>['lookup']> {
    signal?.throwIfAborted();
    const key = `${agentId}/${toolCallId}`;
    const local = this.timelines.get(agentId)?.store?.getToolCall(toolCallId);
    if (local !== undefined) {
      const lookup = { status: 'found' as const, ...local };
      this.toolDetails.set(key, lookup);
      return lookup;
    }
    if (this.toolDetails.get(key)?.status === 'found') this.invalidateToolDetail(key);
    let flight = this.toolDetailReads.get(key);
    if (flight === undefined) {
      const generation = this.generationOf(agentId);
      const epoch = this.toolDetailEpochs.get(key) ?? 0;
      const read = this.view.transcript.detail?.bind(this.view.transcript);
      if (this.closed || read === undefined) throw new Error('Tool details are unavailable on this connection');
      const controller = new AbortController();
      this.snapshotControllers.add(controller);
      const promise = (async () => {
        const detail = await this.readPreparedContent(() => read.call(this.view.transcript, { agentId, kind: 'tool', id: toolCallId }, { signal: controller.signal }), controller.signal);
        controller.signal.throwIfAborted();
        if (this.closed || this.generationOf(agentId) !== generation) throw new Error('Tool detail scope changed');
        if (detail.kind !== 'tool' || detail.agent_id !== agentId || detail.session_id !== this.sessionId) throw new Error('Tool detail target mismatch');
        const resident = this.timelines.get(agentId)?.store?.getToolCall(toolCallId);
        if (resident !== undefined) {
          const lookup = { status: 'found' as const, ...resident };
          this.toolDetails.set(key, lookup);
          return lookup;
        }
        if ((this.toolDetailEpochs.get(key) ?? 0) !== epoch) throw new Error('Tool detail scope changed');
        this.toolDetails.set(key, detail.lookup);
        return detail.lookup;
      })().finally(() => { this.snapshotControllers.delete(controller); if (this.toolDetailReads.get(key)?.controller === controller) this.toolDetailReads.delete(key); });
      flight = { promise, controller, readers: 0 };
      this.toolDetailReads.set(key, flight);
    }
    const owned = flight;
    owned.readers += 1;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException('Read cancelled', 'AbortError')); });
    signal?.addEventListener('abort', abort, { once: true });
    try { return await (signal === undefined ? owned.promise : Promise.race([owned.promise, cancelled])); }
    finally {
      signal?.removeEventListener('abort', abort);
      owned.readers -= 1;
      if (owned.readers === 0 && this.toolDetailReads.get(key) === owned) { this.toolDetailReads.delete(key); owned.controller.abort(); }
    }
  }

  isContentRange(agentId: string, ref: ContentRef): boolean {
    return ref.kind === 'text' && (ref.total > CONTENT_INLINE_TEXT_CHARS || (this.contentBodies.get(JSON.stringify([agentId, ref.source]))?.bytes ?? 0) >= CONTENT_BODY_CACHE_BYTES / 2 || this.contentMemoryReport().bodyBytes >= CONTENT_BODY_CACHE_BYTES);
  }

  contentRefsFor(agentId: string, source: ContentSource): readonly ContentRef[] {
    return this.contentEntity(agentId, source)?.contentRefs ?? [];
  }

  /**
   * Non-reactive read of whether one held turn is incomplete. The published
   * `incompleteTurnIds` / `turnGaps` carry the same fact and notify when it
   * changes; prefer them. Kept while existing callers move over.
   */
  turnStructurePending(agentId: string, turnId: string): boolean {
    return this.turnHasGap(agentId, turnId);
  }

  private contentEntity(agentId: string, source: ContentSource): ContentWindow | undefined {
    if (source.kind === 'snapshot') return this.latestSnapshot;
    if (source.kind === 'frame') {
      for (const [key, lookup] of this.toolDetails) if (key.startsWith(`${agentId}/`) && lookup.status === 'found' && lookup.frame.frameId === source.id && lookup.turnId === source.turnId && lookup.stepId === source.stepId) return lookup.frame;
    }
    const store = this.timelines.get(agentId)?.store;
    return store === undefined ? undefined : transcriptContentEntity(store, source);
  }

  stepCanonicalIndex(agentId: string, turnId: string, stepId: string): number | undefined {
    const turn = this.windowSnapshot(agentId).items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
    const index = turn?.steps.findIndex((step) => step.stepId === stepId) ?? -1;
    if (index < 0) return undefined;
    return index;
  }

  async readContentRange(agentId: string, ref: ContentRef, offset: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const key = JSON.stringify([agentId, ref.source, ref.path, ref.revision, offset]);
    const cached = this.contentRanges.get(key);
    if (cached !== undefined) { this.contentRanges.delete(key); this.contentRanges.set(key, cached); return cached; }
    const read = this.view.transcript.content?.bind(this.view.transcript);
    if (this.closed || read === undefined) throw new Error('Content reader unavailable');
    const generation = this.generationOf(agentId);
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.snapshotControllers.add(controller);
    this.rangeControllers.set(controller, agentId);
    try {
      const segment = await this.readPreparedContent(() => read.call(this.view.transcript, { agentId, ref: { ...ref, offset }, range: true }, { signal: controller.signal }), controller.signal);
      controller.signal.throwIfAborted();
      if (this.closed || this.generationOf(agentId) !== generation || segment.ref.revision !== ref.revision || typeof segment.value !== 'string') throw new Error('Content range changed');
      let start = offset - segment.ref.offset;
      let end = Math.min(segment.value.length, offset + CONTENT_RANGE_CHARS - segment.ref.offset);
      if (start > 0 && /[\uD800-\uDBFF]/u.test(segment.value[start - 1]!)) start += 1;
      if (end < segment.value.length && /[\uD800-\uDBFF]/u.test(segment.value[end - 1]!)) end += 1;
      const text = segment.value.slice(start, end);
      const previous = this.contentRanges.get(key);
      if (previous !== undefined) this.contentRangeBytes -= previous.length * 2;
      this.contentRanges.set(key, text);
      this.contentRangeBytes += text.length * 2;
      while (this.contentRangeBytes > CONTENT_RANGE_CACHE_BYTES) {
        const oldest = this.contentRanges.entries().next().value;
        if (oldest === undefined) break;
        this.contentRanges.delete(oldest[0]); this.contentRangeBytes -= oldest[1].length * 2;
      }
      return text;
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.snapshotControllers.delete(controller);
      this.rangeControllers.delete(controller);
    }
  }

  async copyContentField(agentId: string, source: ContentSource, path: readonly (string | number)[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (source.kind === 'frame') {
      for (const [key, cached] of this.toolDetails) {
        if (!key.startsWith(`${agentId}/`) || cached.status !== 'found' || cached.frame.frameId !== source.id || cached.turnId !== source.turnId || cached.stepId !== source.stepId) continue;
        const lookup = await this.lookupToolCallForCopy(agentId, cached.frame.toolCallId, signal);
        if (lookup.frame.frameId !== source.id || lookup.turnId !== source.turnId || lookup.stepId !== source.stepId) throw new Error('Copy target changed');
        break;
      }
    }
    return this.copyResolvedContentField(agentId, source, path, signal);
  }

  private async copyResolvedContentField(agentId: string, source: ContentSource, path: readonly (string | number)[], signal?: AbortSignal): Promise<string> {
    const select = (entity: unknown): unknown => {
      for (const key of path) {
        if (entity === null || typeof entity !== 'object') return undefined;
        entity = (entity as Record<string | number, unknown>)[key];
      }
      return entity;
    };
    signal?.throwIfAborted();
    const preview = this.contentEntity(agentId, source);
    if (preview === undefined) throw new Error('Copy target unavailable');
    let entity: ContentWindow = preview;
    const read = this.view.transcript.content?.bind(this.view.transcript);
    const controller = new AbortController();
    const cancel = () => { controller.abort(); };
    signal?.addEventListener('abort', cancel, { once: true });
    this.snapshotControllers.add(controller);
    this.rangeControllers.set(controller, agentId);
    const generation = this.generationOf(agentId);
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.closed || this.generationOf(agentId) !== generation) throw new Error('Copy scope changed');
    };
    try {
      for (;;) {
        check();
        const ref: ContentRef | undefined = entity.contentRefs?.find((candidate) => path.every((part, index) => candidate.path[index] === part) || candidate.path.every((part, index) => path[index] === part));
        if (ref === undefined) break;
        if (read === undefined) throw new Error('Content reader unavailable');
        if (ref.kind === 'text') {
          const chunks: string[] = [];
          let offset = ref.offset;
          while (offset < ref.total) {
            const segment = await this.readPreparedContent(() => read({ agentId, ref: { ...ref, offset } }, { signal: controller.signal }), controller.signal);
            check();
            if (segment.ref.revision !== ref.revision || segment.ref.offset !== offset || typeof segment.value !== 'string' || segment.value.length === 0) throw new Error('Copy content changed');
            chunks.push(segment.value);
            offset += segment.value.length;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (offset !== ref.total) throw new Error('Copy content length mismatch');
          entity = applyContentSegment(entity, { ref, value: chunks.join(''), contentRefs: [] });
        } else {
          const segment = await this.readPreparedContent(() => read({ agentId, ref }, { signal: controller.signal }), controller.signal);
          check();
          const next = applyContentSegment(entity, segment);
          if (next === entity || segment.next !== undefined && segment.next.offset <= ref.offset) throw new Error('Copy content made no progress');
          entity = next;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      check();
      const value = select(entity);
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.snapshotControllers.delete(controller);
      this.rangeControllers.delete(controller);
    }
  }

  contentMemoryReport(): { bodies: number; bodyBytes: number; rangeBytes: number; bodyBudget: number; rangeBudget: number } {
    return { bodies: this.contentBodies.size, bodyBytes: [...this.contentBodies.values()].reduce((sum, entry) => sum + entry.bytes, 0), rangeBytes: this.contentRangeBytes, bodyBudget: CONTENT_BODY_CACHE_BYTES, rangeBudget: CONTENT_RANGE_CACHE_BYTES };
  }

  incompleteTurnOrdinals(agentId: string): ReadonlySet<number> {
    const turns = new Set<number>();
    for (const item of this.windowSnapshot(agentId).items) if (item.kind === 'turn' && (this.turnHasGap(agentId, item.turnId) || item.contentRefs?.length || item.steps.some((step) => step.frames.some((frame) => frame.contentRefs?.length)))) turns.add(item.ordinal);
    return turns;
  }

  async completeTurnContent(agentId: string, ordinal: number, signal?: AbortSignal, includeToolOutput = false): Promise<void> {
    let turn = this.windowSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') throw new Error('Search target is not loaded');
    await this.completeContentRead(agentId, { kind: 'turn', id: turn.turnId }, ['steps', 'prompt'], signal);
    turn = this.windowSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') return;
    for (const step of turn.steps) for (const frame of step.frames) {
      if (frame.kind !== 'text' && !(frame.kind === 'tool' && includeToolOutput)) continue;
      const root = frame.kind === 'tool' ? 'output' : 'text';
      if ((frame.contentRefs ?? []).some((ref) => ref.path[0] === root)) await this.completeContentRead(agentId, { kind: 'frame', id: frame.frameId, turnId: turn.turnId, stepId: step.stepId }, [root], signal);
    }
  }

  async findTurnContentRange(agentId: string, ordinal: number, pattern: RegExp, signal?: AbortSignal, includeToolOutput = false): Promise<{ ref: ContentRef; offset: number; toolCallId?: string } | undefined> {
    await this.completeTurnContent(agentId, ordinal, signal, includeToolOutput);
    const turn = this.windowSnapshot(agentId).items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
    if (turn?.kind !== 'turn') throw new Error('Search target changed');
    const fields = [
      ...(turn.contentRefs ?? []).map((ref) => ({ ref, toolCallId: undefined as string | undefined })),
      ...turn.steps.flatMap((step) => step.frames.flatMap((frame) => {
        if (frame.kind === 'thinking' || frame.kind === 'notice') return [];
        if (frame.kind === 'tool' && !includeToolOutput) return [];
        if (frame.kind === 'text' && frame.role !== 'assistant' && frame.role !== 'user') return [];
        return (frame.contentRefs ?? []).map((ref) => ({ ref, toolCallId: frame.kind === 'tool' ? frame.toolCallId : undefined }));
      })),
    ];
    for (const { ref, toolCallId } of fields) {
      if (ref.kind !== 'text') continue;
      const root = String(ref.path[0]);
      if (toolCallId === undefined ? root !== 'prompt' && root !== 'text' : root !== 'output') continue;
      let tail = '';
      for (let offset = 0; offset < ref.total;) {
        signal?.throwIfAborted();
        const text = await this.readContentRange(agentId, ref, offset, signal);
        if (text.length === 0) throw new Error('Search content made no progress');
        const window = tail + text;
        const expression = new RegExp(pattern.source, pattern.flags);
        for (const match of window.matchAll(expression)) {
          if (offset > 0 && match.index === 0 || offset + text.length < ref.total && match.index + match[0].length === window.length) continue;
          return { ref, offset: offset - tail.length + match.index, toolCallId };
        }
        tail = window.slice(-512);
        offset += text.length;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return undefined;
  }

  async completeContentRead(agentId: string, source: ContentSource, roots: readonly string[], signal?: AbortSignal): Promise<void> {
    const lease = this.beginContentRead(agentId, source, roots);
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.closed) throw new Error('Content reader unavailable');
        if (source.kind === 'turn' && roots.includes('steps') && this.turnHasGap(agentId, source.id)) {
          await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
          const view = this.viewOf(agentId);
          const load = view.detailLoads[`structure:${source.id}`];
          if (load?.status === 'error') throw new Error(load.message);
          continue;
        }
        const ref = this.contentRefsFor(agentId, source).find((candidate) => roots.includes(String(candidate.path[0])) && !this.isContentRange(agentId, candidate));
        if (ref === undefined) return;
        if (!await this.loadContentSegment(agentId, ref)) throw new Error('Could not read the complete content');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally { lease.release(); }
  }

  private observeContentPreview(agentId: string, op: TranscriptOperation): void {
    const selected = (): readonly [ContentSource, ContentWindow] | undefined => {
      switch (op.op) {
        case 'frame.upsert': return [{ kind: 'frame', id: op.frame.frameId, turnId: op.turnId, stepId: op.stepId }, op.frame];
        case 'turn.upsert': return [{ kind: 'turn', id: op.turn.turnId }, op.turn];
        case 'task.upsert': return [{ kind: 'task', id: op.task.taskId }, op.task];
        case 'attachment.upsert': return [{ kind: 'attachment', id: op.attachment.attachmentId }, op.attachment];
        case 'prompt.upsert': return [{ kind: 'prompt', id: op.prompt.promptId }, op.prompt];
        case 'interaction.upsert': return [{ kind: 'interaction', id: op.interaction.interactionId }, op.interaction];
        case 'todo.upsert': return [{ kind: 'todo', id: op.todo.todoId }, op.todo];
        case 'marker.upsert': return [{ kind: 'marker', id: op.item.markerId }, op.item];
        case 'meta.merge': return [{ kind: 'meta', id: '' }, op.meta];
        default: return undefined;
      }
    };
    const target = selected();
    if (target === undefined) return;
    const [source, preview] = target;
    const key = JSON.stringify([agentId, source]);
    const entry = this.contentBodies.get(key);
    if (entry === undefined) return;
    const changed = JSON.stringify(entry.base.contentRefs ?? []) !== JSON.stringify(preview.contentRefs ?? []);
    this.contentBodies.set(key, { ...entry, base: source.kind === 'turn' || source.kind === 'meta' ? { ...entry.base, ...preview } : preview, bytes: changed ? this.bytesOf(this.contentEntity(agentId, source)) : entry.bytes });
  }

  private accountContentBody(agentId: string, source: ContentSource, base?: ContentWindow): void {
    if (source.kind === 'snapshot') return;
    const key = JSON.stringify([agentId, source]);
    const previous = this.contentBodies.get(key);
    const entity = this.contentEntity(agentId, source);
    if (entity === undefined) return;
    this.contentBodies.delete(key);
    this.contentBodies.set(key, { agentId, source, base: previous?.base ?? base ?? entity, bytes: this.bytesOf(entity) });
    let total = [...this.contentBodies.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [candidateKey, candidate] of this.contentBodies) {
      if (total <= CONTENT_BODY_CACHE_BYTES) break;
      if ([...this.contentReaders.values()].some((target) => target.agentId === candidate.agentId && JSON.stringify(target.source) === JSON.stringify(candidate.source))) continue;
      const current = this.contentEntity(candidate.agentId, candidate.source);
      const partial = candidate.source.kind === 'turn' && (candidate.base as TranscriptTurn).stepsPartial === true;
      if (partial && (current as TranscriptTurn | undefined)?.state === 'running') continue;
      let restored = current === undefined ? undefined : restoreContentPreview(current, candidate.base);
      if (restored !== undefined && partial) {
        const preview = adoptContentPreviewField(restored, candidate.base, ['steps']);
        restored = carryContentHydration(preview, { ...preview, stepsPartial: true });
      }
      const store = this.timelines.get(candidate.agentId)?.store;
      if (restored !== undefined && store !== undefined && transcriptContentEntity(store, candidate.source) !== undefined) replaceAgentContentEntity(store, candidate.source, restored);
      for (const [toolKey, lookup] of this.toolDetails) if (toolKey.startsWith(`${candidate.agentId}/`) && lookup.status === 'found' && lookup.frame.frameId === candidate.source.id) this.toolDetails.delete(toolKey);
      this.contentBodies.delete(candidateKey);
      total -= candidate.bytes;
      this.pendingTranscriptAgents.add(candidate.agentId);
    }
    this.flushFrames();
  }

  beginContentRead(agentId: string, source: ContentSource, roots: readonly string[], includeOlder = true, paths?: readonly (readonly (string | number)[])[]): { release(): void; retry(): void } {
    const key = JSON.stringify([agentId, source, roots, includeOlder, paths]);
    const target = this.contentReaders.get(key) ?? { agentId, source, roots, paths, includeOlder, readers: 0, blocked: false, retryVersion: 0, ref: undefined, controller: undefined };
    target.readers += 1;
    target.retryVersion += 1;
    target.retryAttempt = 0;
    if (target.retryTimer !== undefined) { clearTimeout(target.retryTimer); target.retryTimer = undefined; }
    target.blocked = false;
    this.contentReaders.set(key, target);
    void this.pumpContentReads();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        target.readers -= 1;
        if (target.readers > 0) return;
        this.retireContentRead(key);
        this.contentReaders.delete(key);
        this.accountContentBody(agentId, source);
        if (target.ref !== undefined && ![...this.contentReaders.values()].some((other) => other.agentId === agentId && JSON.stringify(other.source) === JSON.stringify(source) && other.roots.includes(String(target.ref!.path[0])))) this.cancelContentSegment(agentId, target.ref);
      },
      retry: () => {
        if (released) return;
        target.retryVersion += 1;
        target.retryAttempt = 0;
        if (target.retryTimer !== undefined) { clearTimeout(target.retryTimer); target.retryTimer = undefined; }
        target.blocked = false;
        void this.pumpContentReads();
      },
    };
  }

  retryTurnStructureRead(agentId: string, turnId: string): void {
    for (const target of this.contentReaders.values()) if (target.agentId === agentId && target.source.kind === 'turn' &&
      target.source.id === turnId && target.roots.includes('steps')) {
      target.retryVersion += 1;
      target.retryAttempt = 0;
      if (target.retryTimer !== undefined) { clearTimeout(target.retryTimer); target.retryTimer = undefined; }
      target.blocked = false;
    }
    void this.pumpContentReads();
  }

  private retireContentRead(key: string): void {
    const target = this.contentReaders.get(key);
    if (target === undefined) return;
    if (target.retryTimer !== undefined) {
      clearTimeout(target.retryTimer);
      target.retryTimer = undefined;
    }
    target.retryAttempt = 0;
    if (target.controller !== undefined) {
      target.controller.abort();
      this.snapshotControllers.delete(target.controller);
      target.controller = undefined;
      if (!this.closed) this.setDetailLoad(target.agentId, `structure:${target.source.id}`, undefined);
    }
    this.contentPumpReads.delete(key);
    target.blocked = false;
  }

  private async pumpContentReads(): Promise<void> {
    if (this.contentPumpRunning || this.closed || this.isSuspended) return;
    this.contentPumpRunning = true;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.closed || this.isSuspended) return;
      for (const [key, target] of this.contentReaders) {
        if (this.contentPumpReads.size >= 4) break;
        if (target.readers === 0 || target.blocked || target.retryTimer !== undefined || this.contentPumpReads.has(key)) continue;
        const entity = this.contentEntity(target.agentId, target.source);
        // A stale turn waits while a raised baseline is on its way: the
        // baseline replaces the newest turns anyway, and whatever it leaves
        // stale is read once it lands.
        const timeline = this.timelines.get(target.agentId);
        const partial = target.source.kind === 'turn' && target.includeOlder && target.roots.includes('steps') &&
          ((entity as TranscriptTurn | undefined)?.stepsPartial === true ||
            entity !== undefined && timeline?.stale.has(target.source.id) === true && !timeline.refreshing);
        if (target.source.kind === 'turn' && target.includeOlder && target.roots.includes('steps') && !partial &&
          entity !== undefined && timeline?.stale.has(target.source.id) === true) continue;
        const ref = partial ? undefined : entity?.contentRefs?.find((candidate) => {
          if (!target.roots.includes(String(candidate.path[0])) || this.isContentRange(target.agentId, candidate) ||
            target.paths !== undefined && !target.paths.some(path => path.every((part, index) => candidate.path[index] === part)) ||
            !target.includeOlder && candidate.direction === 'backward') return false;
          return candidate.path[0] !== 'steps' || candidate.path.length === 1 || candidate.path.length === 3 && candidate.path[2] === 'frames';
        });
        if (!partial && ref === undefined) continue;
        const controller = partial ? new AbortController() : undefined;
        target.controller = controller;
        target.ref = ref;
        const flight = {};
        const retryVersion = target.retryVersion;
        this.contentPumpReads.set(key, flight);
        const read = controller === undefined
          ? this.loadContentSegment(target.agentId, ref!).then((applied) => (applied ? 'applied' as const : 'blocked' as const))
          : this.loadPartialTurnStructure(target.agentId, target.source.id, controller);
        void read.then((outcome) => {
          if (this.contentPumpReads.get(key) !== flight) return;
          const applied = outcome === 'applied';
          target.ref = applied ? undefined : ref;
          if (applied) {
            target.retryAttempt = 0;
            return;
          }
          if (target.readers > 0 && target.retryVersion === retryVersion) {
            if (outcome === 'retry') {
              const attempt = target.retryAttempt ?? 0;
              target.retryAttempt = attempt + 1;
              const delay = Math.min(2000, TOOL_DETAIL_PREPARING_RETRY_MS * (2 ** Math.min(attempt, 5)));
              target.retryTimer = setTimeout(() => {
                target.retryTimer = undefined;
                if (!this.closed && !this.isSuspended && target.readers > 0 && target.retryVersion === retryVersion) void this.pumpContentReads();
              }, delay);
              return;
            }
            target.blocked = partial || this.contentRefsFor(target.agentId, target.source).some((current) => sameContentRef(current, ref!));
            if (target.blocked && ref !== undefined) {
              const detailKey = `content:${JSON.stringify(ref)}`;
              const view = this.viewOf(target.agentId);
              if (view.detailLoads[detailKey]?.status !== 'error') this.setDetailLoad(target.agentId, detailKey, { status: 'error', message: 'Content did not advance. Retry to continue.' });
            }
          }
        }).finally(() => {
          if (this.contentPumpReads.get(key) !== flight) return;
          target.controller = undefined;
          this.contentPumpReads.delete(key);
          if (this.contentReaders.get(key) === target) {
            this.contentReaders.delete(key);
            this.contentReaders.set(key, target);
          }
          void this.pumpContentReads();
        });
      }
    } finally { this.contentPumpRunning = false; }
  }

  private async readAuthoritativeTranscriptContinuation<T extends { read?: TranscriptRead }>(read: () => Promise<T>, staleMessage: string, signal?: AbortSignal): Promise<T> {
    const result = await this.readPreparedContent(read, signal);
    if (result.read?.stale !== undefined) throw new Error(staleMessage);
    return result;
  }

  private async readPreparedContent<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let failures = 0;
    const backoff = new PreparingBackoff();
    for (;;) {
      signal?.throwIfAborted();
      try { return await readInHistoryLane(this.client, read, signal); }
      catch (error) {
        signal?.throwIfAborted();
        const code = error instanceof RPCError || error instanceof ApiError ? error.code : undefined;
        const preparing = code === 40923;
        const transient = code === -1 || error instanceof TypeError;
        if (!preparing && (!transient || failures >= RESYNC_BACKOFF_MS.length)) throw error;
        if (preparing) await backoff.wait(signal);
        else await waitUnlessAborted(RESYNC_BACKOFF_MS[failures++]!, signal);
      }
    }
  }

  private async loadPartialTurnStructure(agentId: string, turnId: string, controller: AbortController): Promise<'applied' | 'retry' | 'blocked'> {
    const source = { kind: 'turn' as const, id: turnId };
    const generation = this.generationOf(agentId);
    const key = `structure:${turnId}`;
    this.snapshotControllers.add(controller);
    this.setDetailLoad(agentId, key, { status: 'loading' });
    try {
      let preview = await this.readTurnContentPreview(agentId, turnId, controller.signal);
      if (this.closed || controller.signal.aborted || this.generationOf(agentId) !== generation) return 'blocked';
      if (preview?.stepsPartial === true) return 'retry';
      if (preview === undefined) {
        if (this.resyncInFlight) return 'retry';
        throw new Error('Could not load turn step structure. Retry to continue.');
      }
      const content = this.view.transcript.content?.bind(this.view.transcript);
      for (;;) {
        controller.signal.throwIfAborted();
        const ref: ContentRef | undefined = preview.contentRefs?.find(candidate => this.isTurnStructureRef(candidate));
        if (ref === undefined) break;
        if (content === undefined) throw new Error('Step structure content is unavailable. Retry to continue.');
        const segment: ContentSegment = await this.readPreparedContent<ContentSegment>(() => content({ agentId, ref }, { signal: controller.signal }), controller.signal);
        controller.signal.throwIfAborted();
        preview = applyContentSegment(preview, segment);
      }
      // An aborted or superseded read leaves the key alone: retiring it already
      // cleared it, and a replacement flight may own it now.
      if (this.closed || controller.signal.aborted || this.generationOf(agentId) !== generation) return 'blocked';
      const current = this.contentEntity(agentId, source) as TranscriptTurn | undefined;
      // This flight still owns the key here; a turn removed meanwhile, or one
      // nothing could be installed on, must not stay "loading" forever.
      if (current === undefined) {
        this.setDetailLoad(agentId, key, undefined);
        return 'blocked';
      }
      const canonical = rebindTurnContentRefs(preview);
      const timeline = this.timeline(agentId);
      // A stale turn's held header is out of date too: the canonical one
      // replaces it, the held structure only lends its read bodies.
      const base = !timeline.stale.has(turnId) ? current : (() => {
        const { steps: _steps, contentRefs, stepsPartial: _partial, ...header } = canonical;
        return carryContentHydration(current, { ...current, ...header, contentRefs: [
          ...(current.contentRefs ?? []).filter((ref) => ref.path[0] === 'steps'),
          ...(contentRefs ?? []).filter((ref) => ref.path[0] !== 'steps'),
        ] });
      })();
      const adopted = completeTranscriptTurnStructure(base, canonical);
      // The canonical structure replaces whatever the window held of the turn.
      const wasStale = timeline.stale.delete(turnId);
      const join = timeline.joins.get(turnId);
      timeline.joins.delete(turnId);
      if (!this.replaceTimelineContentEntity(agentId, source, adopted)) {
        if (wasStale) timeline.stale.add(turnId);
        if (join !== undefined) timeline.joins.set(turnId, join);
        this.setDetailLoad(agentId, key, undefined);
        return 'blocked';
      }
      this.accountContentBody(agentId, source, current);
      this.setDetailLoad(agentId, key, undefined);
      return 'applied';
    } catch (error) {
      if (this.closed || controller.signal.aborted || this.generationOf(agentId) !== generation) return 'blocked';
      const code = error instanceof RPCError || error instanceof ApiError ? error.code : undefined;
      if (code === 40922 || code === 40923 || code === API_CODES.SESSION_BUSY || code === API_CODES.SESSION_INDEX_BUILDING) {
        return 'retry';
      }
      this.setDetailLoad(agentId, key, { status: 'error', message: error instanceof Error ? error.message : String(error) });
      return 'blocked';
    } finally {
      this.snapshotControllers.delete(controller);
    }
  }

  private turnStructureRefreshKey(agentId: string, ref: ContentRef): string {
    return `${agentId}/${ref.source.kind}/${ref.source.id}/${JSON.stringify(ref.path)}`;
  }

  private isTurnStructureRef(ref: ContentRef): boolean {
    return ref.source.kind === 'turn' && ref.kind === 'array' && ref.path[0] === 'steps' &&
      (ref.path.length === 1 || ref.path.length === 3 && ref.path[2] === 'frames');
  }

  /** Rebind one canonical structure revision, retaining loaded children while their positions remain compatible. */
  private async refreshTurnStructurePreview(agentId: string, ref: ContentRef, signal: AbortSignal): Promise<ContentRef | 'complete' | undefined> {
    if (ref.source.kind !== 'turn' || signal.aborted || this.closed) return undefined;
    const preview = await this.readTurnContentPreview(agentId, ref.source.id, signal);
    if (preview === undefined) return undefined;
    const candidate = preview.contentRefs?.find((current) => current.kind === 'array' &&
      current.path.length === ref.path.length && current.path.every((part, partIndex) => part === ref.path[partIndex]) &&
      current.source.kind === ref.source.kind && current.source.id === ref.source.id);
    if (candidate === undefined) {
      const moved = ref.path.length === 3 && contentPathValue(preview, ref.path) === undefined;
      const path = moved ? ['steps'] : ref.path;
      if (signal.aborted || !this.adoptTimelinePreviewField(agentId, ref, preview, path)) return undefined;
      return moved ? this.contentEntity(agentId, ref.source)?.contentRefs?.find(current => current.kind === 'array' &&
        current.path.length === 1 && current.path[0] === 'steps') ?? 'complete' : 'complete';
    }
    if (candidate.revision === ref.revision && candidate.offset === ref.offset && candidate.total === ref.total) return undefined;
    const fresh = ref.direction === 'backward' ? candidate : { ...candidate, direction: 'forward' as const, offset: 0 };
    if (!this.installTurnStructureRef(agentId, ref, fresh) || signal.aborted) return undefined;
    return this.contentEntity(agentId, ref.source)?.contentRefs?.find((current) => sameContentRef(current, fresh));
  }

  private async readTurnContentPreview(agentId: string, turnId: string, signal: AbortSignal, openingOnly = false): Promise<TranscriptTurn | undefined> {
    const anchor = () => {
      const items = this.windowSnapshot(agentId).items;
      const index = items.findIndex((item) => item.kind === 'turn' && item.turnId === turnId);
      if (index < 0) return undefined;
      return {
        turn: items[index] as TranscriptTurn,
        nextTurn: items.slice(index + 1).find((item): item is TranscriptTurn => item.kind === 'turn'),
      };
    };
    let current = anchor();
    if (current === undefined) return undefined;
    let beforeItem: string | undefined;
    let staleRetries = 0;
    const cursors = new Set<string>();
    const backoff = new PreparingBackoff();
    // The last answer this read waited on. Progress is an answer that differs
    // from it: a moved continuation, or a partial turn that changed. The same
    // partial turn at the same continuation is the server still preparing,
    // not progress, and must keep backing off instead of polling at the
    // fastest cadence.
    let waitedOn: { readonly continuation: string | undefined; readonly turn: TranscriptTurn | undefined } | undefined;
    for (;;) {
      const page = await this.readPreparedContent(() => this.view.transcript.page(
        { agentId, beforeTurn: beforeItem === undefined ? current?.nextTurn?.turnId : undefined, beforeItem, pageSize: 1 },
        { signal },
      ), signal);
      if (this.closed || signal.aborted || page.agent_id !== agentId) return undefined;
      if (page.read?.stale !== undefined) {
        this.timeline(agentId).historyRead = page.read;
        this.publishProjectedAgent(agentId, this.ensureAgentTranscript(agentId), { historyCoverageKind: 'unknown' });
        if (page.read.stale.retry === 'resync') {
          void this.resync();
          return undefined;
        }
        if (staleRetries >= 3) return undefined;
        staleRetries += 1;
        beforeItem = undefined;
        cursors.clear();
        current = anchor();
        if (current === undefined) return undefined;
        continue;
      }
      const preview = page.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
      if (preview !== undefined && (openingOnly ? preview.startedAt !== undefined : preview.stepsPartial !== true)) return preview;
      const budgeted = page.items.length === 0 && page.has_more && (page.read?.readiness === 'preparing' || page.read?.readiness === 'partial');
      if (budgeted || (preview !== undefined && !openingOnly)) {
        const next = budgeted ? page.next_cursor ?? beforeItem : beforeItem;
        const answer = { continuation: budgeted ? next : page.next_cursor, turn: preview };
        if (waitedOn === undefined || !transcriptValueEquals(waitedOn, answer)) backoff.progressed();
        waitedOn = answer;
        beforeItem = next;
        await backoff.wait(signal);
        signal.throwIfAborted();
        continue;
      }
      if (page.items.some((item) => item.kind === 'turn' && item.ordinal < current!.turn.ordinal) ||
        !page.has_more || page.next_cursor === undefined || cursors.has(page.next_cursor)) return undefined;
      cursors.add(page.next_cursor);
      beforeItem = page.next_cursor;
    }
  }

  /** Replace one changed timeline field from a fresh canonical preview and return its first continuation reference. */
  private async refreshTimelineFieldPreview(agentId: string, ref: ContentRef, signal: AbortSignal): Promise<ContentRef | 'complete' | undefined> {
    const source = ref.source;
    if ((source.kind !== 'turn' && source.kind !== 'frame') || signal.aborted || this.closed) return undefined;
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    if (turnId === undefined) return undefined;
    const turn = await this.readTurnContentPreview(agentId, turnId, signal);
    const preview: ContentWindow | undefined = turn === undefined ? undefined : source.kind === 'turn' ? turn
      : turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
    const samePath = (candidate: ContentRef) => candidate.path.length === ref.path.length && candidate.path.every((part, partIndex) => part === ref.path[partIndex]);
    const candidate = preview?.contentRefs?.find((current) => samePath(current) && current.kind === ref.kind);
    if (preview === undefined || candidate?.revision === ref.revision ||
      (candidate === undefined && contentPathValue(preview, ref.path) === undefined)) return undefined;
    if (signal.aborted || !this.adoptTimelinePreviewField(agentId, ref, preview)) return undefined;
    if (candidate === undefined) return 'complete';
    return this.contentEntity(agentId, source)?.contentRefs?.find((entry) => sameContentRef(entry, candidate));
  }

  private adoptTimelinePreviewField(agentId: string, ref: ContentRef, preview: ContentWindow, path = ref.path): boolean {
    const source = ref.source;
    const current = this.contentEntity(agentId, source);
    if (current === undefined || !(current.contentRefs ?? []).some((entry) => sameContentRef(entry, ref))) return false;
    let adopted: ContentWindow;
    try { adopted = adoptContentPreviewField(current, preview, path); } catch { return false; }
    return this.replaceTimelineContentEntity(agentId, source, adopted);
  }

  private replaceTimelineContentEntity(agentId: string, source: ContentSource, adopted: ContentWindow): boolean {
    const store = this.timelines.get(agentId)?.store;
    const installed = store !== undefined && transcriptContentEntity(store, source) !== undefined && replaceAgentContentEntity(store, source, adopted);
    if (!installed) return false;
    this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.flushFrames();
    return true;
  }

  private installTurnStructureRef(agentId: string, ref: ContentRef, fresh: ContentRef): boolean {
    if (ref.source.kind !== 'turn') return false;
    const turnId = ref.source.id;
    const contentRefsOf = (turn: TranscriptTurn): TranscriptTurn['contentRefs'] => (turn.contentRefs ?? []).flatMap((current) => {
      const under = ref.path.every((part, partIndex) => current.path[partIndex] === part);
      if (sameContentRef(current, ref)) return [fresh];
      return ref.direction !== 'backward' && under ? [] : [current];
    });
    const store = this.ensureAgentTranscript(agentId);
    const live = store.getTurn(turnId);
    if (live === undefined) return false;
    const { steps: _steps, ...rest } = live;
    const header = carryContentHydration(live, { ...rest, contentRefs: contentRefsOf(live) });
    return store.apply([{ op: 'turn.upsert', turn: header }]).accepted.length > 0;
  }

  async loadContentSegment(agentId: string, ref: ContentRef): Promise<boolean> {
    const read = this.view.transcript.content?.bind(this.view.transcript);
    if (this.closed || read === undefined) return false;
    const key = `content:${JSON.stringify(ref)}`;
    const requestKey = `${agentId}/${key}`;
    const inFlight = this.detailReads.get(requestKey);
    if (inFlight !== undefined) return inFlight;
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const rosterRead = ref.source.kind === 'snapshot' && ref.path[0] === 'subagents';
    const rootRosterRead = rosterRead && ref.kind === 'array' && ref.path.length === 1;
    const rosterBaseline = rootRosterRead ? this.latestSnapshot : undefined;
    if (rootRosterRead && !this.rosterReadInFlight) this.rosterRevisionRefreshes = 0;
    if (!rosterRead) this.contentControllers.set(requestKey, controller);
    const generation = this.generationOf(agentId);
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        const baseline = this.contentEntity(agentId, ref.source);
        const refs = baseline?.contentRefs ?? [];
        if (!refs.some((current) => sameContentRef(current, ref))) return false;
        const segment = await this.readPreparedContent(() => read({ agentId, ref }, { signal: controller.signal }), controller.signal);
        if (this.closed || controller.signal.aborted || (!rosterRead && this.generationOf(agentId) !== generation)) return false;
        if (segment.next !== undefined && (ref.direction === 'backward' ? segment.next.offset >= ref.offset : segment.next.offset <= ref.offset) ||
          segment.contentRefs.some((candidate) => sameContentRef(candidate, ref)))
          throw new Error('Content segment did not advance its reference');
        if (ref.source.kind === 'snapshot') {
          const current = this.latestSnapshot;
          if (current === undefined) return false;
          const patched = applyContentSegment(current, segment);
          if (patched === current) return false;
          this.latestSnapshot = patched;
          const contentRefs = stableContentRefs(this.viewOf(MAIN_AGENT_ID).contentRefs, [...collectTranscriptContentRefs(this.windowSnapshot(MAIN_AGENT_ID)), ...(patched.contentRefs ?? [])]);
          this.setSessionView(rosterRead
            ? { ...this.sessionView(), snapshotSubagents: this.mergeRosterRows(patched), contentRefs }
            : { ...this.applyTranscriptShellSnapshot(patched), contentRefs });
          this.publishForest();
        } else {
          const store = this.ensureAgentTranscript(agentId);
          let applied = false;
          if (ref.source.kind === 'frame') {
            for (const [lookupKey, lookup] of this.toolDetails) {
              if (!lookupKey.startsWith(`${agentId}/`) || lookup.status !== 'found' || lookup.frame.frameId !== ref.source.id || lookup.turnId !== ref.source.turnId || lookup.stepId !== ref.source.stepId) continue;
              const frame = applyContentSegment(lookup.frame, segment);
              if (frame !== lookup.frame) {
                this.toolDetails.set(lookupKey, { ...lookup, frame });
                // The owning agent's publication below reports the change
                // through the content revision (`toolDetails` counts writes).
                applied = true;
              }
            }
          }
          applied = patchAgentTranscriptContent(store, segment) || applied;
          if (!applied) return false;
          this.forestDirtyAgents.add(agentId);
          this.pendingTranscriptAgents.add(agentId);
          this.flushFrames();
          if (ref.source.kind !== 'turn' || ref.path[0] !== 'steps') this.accountContentBody(agentId, ref.source, baseline);
        }
        return true;
      } catch (error) {
        if (!this.closed && !controller.signal.aborted && !rosterRead &&
            !this.contentRefsFor(agentId, ref.source).some(candidate => sameContentRef(candidate, ref))) return true;
        if (rootRosterRead && error instanceof RPCError && error.code === 40922 &&
          !this.closed && !controller.signal.aborted && this.latestSnapshot === rosterBaseline &&
          this.rosterRevisionRefreshes < MAX_ROSTER_REVISION_REFRESHES) {
          this.rosterRevisionRefreshes += 1;
          await this.refreshRoster(this.shell.cursor);
          if (!this.closed && !controller.signal.aborted && this.latestSnapshot !== rosterBaseline) {
            this.setDetailLoad(agentId, key, undefined);
            return true;
          }
        }
        const refreshKey = this.turnStructureRefreshKey(agentId, ref);
        const structure = this.isTurnStructureRef(ref);
        if ((structure || ref.source.kind === 'turn' || ref.source.kind === 'frame') && error instanceof RPCError && error.code === 40922 &&
          !this.closed && !controller.signal.aborted && !this.turnStructureRefreshKeys.has(refreshKey)) {
          this.turnStructureRefreshKeys.add(refreshKey);
          try {
            const fresh = structure ? await this.refreshTurnStructurePreview(agentId, ref, controller.signal)
              : await this.refreshTimelineFieldPreview(agentId, ref, controller.signal);
            if (fresh === 'complete' && !this.closed && !controller.signal.aborted) {
              this.setDetailLoad(agentId, key, undefined);
              return true;
            }
            if (fresh !== undefined && fresh !== 'complete' && !this.closed && !controller.signal.aborted) {
              // The replacement read registers its own controller. The older gesture only knows the stale ref, so cancel that read when this preview is aborted.
              const continuedPromise = this.loadContentSegment(agentId, fresh);
              const abortContinued = () => { this.cancelContentSegment(agentId, fresh); };
              controller.signal.addEventListener('abort', abortContinued, { once: true });
              try {
                const continued = await continuedPromise;
                if (this.closed || controller.signal.aborted) return false;
                if (continued) return true;
                const view = this.viewOf(agentId);
                const freshDetail = view.detailLoads[`content:${JSON.stringify(fresh)}`];
                if (!this.closed && !controller.signal.aborted) this.setDetailLoad(agentId, key, {
                  status: 'error',
                  message: freshDetail?.status === 'error' ? freshDetail.message : errorMessage(error, 'Could not load the next content segment'),
                });
                return false;
              } finally {
                controller.signal.removeEventListener('abort', abortContinued);
              }
            }
          } catch (refreshError) {
            if (this.closed || controller.signal.aborted) return false;
            this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(refreshError, 'Could not load the next content segment') });
            return false;
          } finally {
            this.turnStructureRefreshKeys.delete(refreshKey);
          }
        }
        if (!this.closed && !controller.signal.aborted) this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(error, 'Could not load the next content segment') });
        return false;
      } finally {
        this.snapshotControllers.delete(controller);
        if (this.contentControllers.get(requestKey) === controller) this.contentControllers.delete(requestKey);
        const current = this.viewOf(agentId);
        if (!this.closed && !controller.signal.aborted && (rosterRead || this.generationOf(agentId) === generation) &&
          current.detailLoads[key]?.status === 'loading') this.setDetailLoad(agentId, key, undefined);
      }
    })().finally(() => { if (this.detailReads.get(requestKey) === run) this.detailReads.delete(requestKey); });
    this.detailReads.set(requestKey, run);
    return run;
  }

  cancelContentSegment(agentId: string, ref: ContentRef): void {
    const key = `content:${JSON.stringify(ref)}`;
    const requestKey = `${agentId}/${key}`;
    const controller = this.contentControllers.get(requestKey);
    if (controller === undefined) return;
    this.contentControllers.delete(requestKey);
    this.detailReads.delete(requestKey);
    controller.abort();
    this.setDetailLoad(agentId, key, undefined);
  }

  private todoPageWins(agentId: string, current: TranscriptTodo | undefined, todo: TranscriptTodo, read: TranscriptRead | undefined): boolean {
    if (current === undefined) return true;
    if (todo.todoId !== 'todo' || read?.readiness !== 'ready' || read.stale !== undefined ||
        todo.notesStatus !== undefined || todo.contentRefs?.some((ref) => ref.path[0] !== 'items') === true ||
        todo.notesMeta === undefined || todo.notesMeta.rev <= (current.notesMeta?.rev ?? -1)) return false;
    const watermark = read.watermark?.transcript;
    const cursor = this.timelines.get(agentId)?.cursor;
    const observed = this.timelines.get(agentId)?.todoRead?.watermark?.transcript;
    return watermark !== undefined && cursor !== undefined && watermark.epoch !== undefined && watermark.epoch === cursor.epoch &&
      watermark.seq >= cursor.seq && (observed === undefined || observed.epoch === watermark.epoch && watermark.seq >= observed.seq);
  }

  private observeCanonicalTodoRead(agentId: string, previous: TranscriptTodo | undefined, ops: readonly TranscriptOperation[], cursor: TranscriptCursor): void {
    const appliedCursor = this.timelines.get(agentId)?.cursor;
    for (const op of ops) {
      if (op.op !== 'todo.upsert' || op.todo.todoId !== 'todo') continue;
      const next = op.todo;
      const advancesNotes = next.notesMeta !== undefined && next.notesMeta.rev > (previous?.notesMeta?.rev ?? -1);
      previous = next;
      const watermark = this.timelines.get(agentId)?.todoRead?.watermark?.transcript ?? appliedCursor;
      const advancesRead = watermark !== undefined && watermark.epoch !== undefined && watermark.epoch === cursor.epoch &&
        cursor.seq > watermark.seq && (appliedCursor === undefined || appliedCursor.epoch === cursor.epoch && cursor.seq > appliedCursor.seq);
      if (!advancesNotes || !advancesRead) continue;
      const complete = next.notes !== undefined && next.notesStatus === undefined &&
        next.contentRefs?.some((ref) => ref.path[0] !== 'items') !== true;
      this.timeline(agentId).todoRead = { source: cursor.epoch?.startsWith('cold:') === true ? 'cold' : 'live',
        readiness: complete ? 'ready' : 'partial', reason: complete ? undefined : 'source_unverified',
        watermark: { transcript: cursor } };
    }
  }

  async loadTranscriptEntities(agentId: string, kind: import('@kiki/transcript').TranscriptDetailListResponse['kind']): Promise<boolean> {
    const read = this.view.transcript.entities?.bind(this.view.transcript);
    const key = `entities:${kind}`;
    const requestKey = `${agentId}/${key}`;
    if (this.closed || read === undefined || this.entityPageCursors.get(requestKey) === null) return false;
    const pending = this.detailReads.get(requestKey);
    if (pending !== undefined) return pending;
    const generation = this.generationOf(agentId);
    let cursor = this.entityPageCursors.get(requestKey) ?? undefined;
    const controller = new AbortController();
    this.snapshotControllers.add(controller);
    const run = (async (): Promise<boolean> => {
      this.setDetailLoad(agentId, key, { status: 'loading' });
      try {
        let page = await read({ agentId, kind, cursor, limit: 20 }, { signal: controller.signal });
        if (this.closed || controller.signal.aborted || page.agent_id !== agentId || page.kind !== kind || this.generationOf(agentId) !== generation) return false;
        if (page.read?.stale !== undefined) {
          this.entityPageCursors.delete(requestKey);
          cursor = undefined;
          if (page.read.stale.retry === 'resync') { void this.resync(); return false; }
          page = await this.readAuthoritativeTranscriptContinuation(() => read({ agentId, kind, cursor, limit: 20 }, { signal: controller.signal }),
            'Transcript entity continuation is still stale', controller.signal);
          if (this.closed || controller.signal.aborted || page.agent_id !== agentId || page.kind !== kind || this.generationOf(agentId) !== generation) return false;
        }
        const partial = page.read !== undefined && page.read.readiness !== 'ready';
        if (page.has_more && !(partial && page.items.length === 0) && (page.next_cursor === undefined || page.next_cursor === '' || page.next_cursor === cursor)) {
          throw new Error('Transcript entity page did not advance its cursor');
        }
        if (!this.flushPendingTranscriptBatch(agentId)) return false;
        const store = this.ensureAgentTranscript(agentId);
        const ops: TranscriptOperation[] = [];
        switch (page.kind) {
          case 'task': for (const task of page.items) if (store.getTask(task.taskId) === undefined) ops.push({ op: 'task.upsert', task }); break;
          case 'attachment': for (const attachment of page.items) if (store.getAttachment(attachment.attachmentId) === undefined) ops.push({ op: 'attachment.upsert', attachment }); break;
          case 'prompt': for (const prompt of page.items) if (store.getPrompt(prompt.promptId) === undefined) ops.push({ op: 'prompt.upsert', prompt }); break;
          case 'interaction': for (const interaction of page.items) if (!store.getInteractions().has(interaction.interactionId)) ops.push({ op: 'interaction.upsert', interaction }); break;
          case 'todo': for (const todo of page.items) if (this.todoPageWins(agentId, store.getTodo(todo.todoId), todo, page.read)) ops.push({ op: 'todo.upsert', todo }); break;
        }
        const applied = store.apply(ops);
        if (applied.accepted.some((op) => op.op === 'todo.upsert' && op.todo.todoId === 'todo')) {
          if (page.read === undefined) this.timeline(agentId).todoRead = undefined;
          else this.timeline(agentId).todoRead = page.read;
        }
        this.entityPageCursors.set(requestKey, page.has_more ? page.next_cursor ?? null : null);
        const snapshot = store.snapshot();
        const field = { task: 'tasks', attachment: 'attachments', prompt: 'prompts', interaction: 'interactions', todo: 'todos' }[kind] as 'tasks' | 'attachments' | 'prompts' | 'interactions' | 'todos';
        const count = snapshot[field].length;
        const full = (returned: number) => ({ returned, total: returned, hasMore: false });
        const previous: NonNullable<AgentTranscriptSnapshot['globalCoverage']> = this.timelines.get(agentId)?.globalCoverage ?? { version: 1, tasks: full(snapshot.tasks.length), attachments: full(snapshot.attachments.length), prompts: full(snapshot.prompts.length) };
        this.timeline(agentId).globalCoverage = { ...previous, [field]: { returned: count, total: Math.max(count, page.total ?? previous[field]?.total ?? count), hasMore: page.has_more } };
        this.forestDirtyAgents.add(agentId);
        this.publishProjectedAgent(agentId, store);
        return page.items.length > 0;
      } catch (error) {
        if (!this.closed && !controller.signal.aborted && this.generationOf(agentId) === generation) this.setDetailLoad(agentId, key, { status: 'error', message: errorMessage(error, 'Could not load the next transcript entities') });
        return false;
      } finally {
        this.snapshotControllers.delete(controller);
        const current = this.viewOf(agentId);
        if (!this.closed && this.generationOf(agentId) === generation && current.detailLoads[key]?.status === 'loading') this.setDetailLoad(agentId, key, undefined);
      }
    })();
    this.detailReads.set(requestKey, run);
    void run.finally(() => {
      if (this.detailReads.get(requestKey) === run) this.detailReads.delete(requestKey);
    });
    return run;
  }

  /** Fold a detail read into a still-truncated entity or a missing referenced attachment. */
  private applyTranscriptDetail(agentId: string, detail: SessionViewTranscriptDetail): boolean {
    const store = this.timelines.get(agentId)?.store;
    if (store === undefined || detail.agent_id !== agentId || detail.kind === 'tool') return false;
    let op: TranscriptOperation | undefined;
    if (detail.kind === 'task') {
      const current = store.getTask(detail.task.taskId);
      if (current?.detailRef !== undefined) op = { op: 'task.upsert', task: detail.task as typeof current };
    } else if (detail.kind === 'attachment') {
      const current = store.getAttachment(detail.attachment.attachmentId);
      const referenced = this.windowSnapshot(agentId).items.some((item) => item.kind === 'turn' &&
        (item.attachmentIds?.includes(detail.attachment.attachmentId) || item.steps.some((step) => step.frames.some((frame) =>
          'attachmentIds' in frame && frame.attachmentIds?.includes(detail.attachment.attachmentId)))));
      if (current?.detailRef !== undefined || (current === undefined && referenced)) op = { op: 'attachment.upsert', attachment: detail.attachment };
    } else {
      const current = store.getPrompt(detail.prompt.promptId);
      if (current?.detailRef !== undefined) op = { op: 'prompt.upsert', prompt: detail.prompt as typeof current };
    }
    // A live upsert that already replaced the summary wins over the read.
    if (op === undefined) return false;
    store.apply([op]);
    this.forestDirtyAgents.add(agentId);
    this.pendingTranscriptAgents.add(agentId);
    this.flushFrames();
    return true;
  }

  private setDetailLoad(
    agentId: string,
    key: string,
    status: SessionViewState['detailLoads'][string] | undefined,
  ): void {
    const current = this.viewOf(agentId);
    const previous = current.detailLoads[key];
    if (previous === status) return;
    const detailLoads = { ...current.detailLoads };
    if (status === undefined) delete detailLoads[key];
    else detailLoads[key] = status;
    this.publishView(agentId, { ...current, version: current.version + 1, detailLoads });
  }

  private applyTranscriptOps(
    agentId: string,
    ops: readonly TranscriptOperation[],
    cursor: TranscriptCursor,
    throughSeq: number,
  ): void {
    const pending = this.pendingTranscriptBatches.get(agentId);
    const last = pending?.cursor ?? this.timelines.get(agentId)?.cursor;
    if (last?.epoch !== undefined && cursor.epoch !== undefined && cursor.epoch !== last.epoch) {
      if (this.shell.resyncError?.retryable !== false) void this.resync();
      return;
    }
    const seenThrough = pending === undefined ? last?.seq : Math.max(pending.cursor.seq, pending.throughSeq);
    if (seenThrough !== undefined && throughSeq <= seenThrough) return;
    const freshOps = seenThrough !== undefined && cursor.seq <= seenThrough ? [] : ops;
    if (pending === undefined) {
      this.pendingTranscriptBatches.set(agentId, { ops: [...freshOps], cursor, throughSeq });
    } else {
      pending.ops.push(...freshOps);
      if (cursor.seq >= pending.cursor.seq) pending.cursor = cursor;
      if (throughSeq > pending.throughSeq) pending.throughSeq = throughSeq;
    }
    this.scheduleFrameFlush();
  }

  private flushPendingTranscriptBatches(): void {
    if (this.pendingTranscriptBatches.size === 0) return;
    const agentIds = [...this.pendingTranscriptBatches.keys()];
    for (const agentId of agentIds) this.flushPendingTranscriptBatch(agentId);
  }

  private flushPendingTranscriptBatch(agentId: string, startCatchUp = true): boolean {
    const batch = this.pendingTranscriptBatches.get(agentId);
    if (batch === undefined) return true;
    this.pendingTranscriptBatches.delete(agentId);
    // Ops apply keyed on `cursor`; the resume watermark folds in `throughSeq`
    // (same epoch by construction — an epoch change reroutes to resync above)
    // so a reconnect does not re-pull the filtered tail after the last
    // visible batch.
    const resumeCursor: TranscriptCursor =
      batch.throughSeq > batch.cursor.seq
        ? { seq: batch.throughSeq, epoch: batch.cursor.epoch }
        : batch.cursor;
    const store = this.ensureAgentTranscript(agentId);
    const priorCursor = this.timelines.get(agentId)?.cursor;
    const changedTasks = new Set(batch.ops.flatMap((op) => op.op === 'task.upsert' &&
      op.task.kind === 'subagent' && store.getTask(op.task.taskId)?.state !== op.task.state ? [op.task.taskId] : []));
    const previousTodo = store.getTodo('todo');
    const result = this.applyAgentTranscriptOps(agentId, store, batch.ops);
    if (result.gap !== undefined) {
      this.toolCountSpans.delete(agentId);
      this.toolCountObservations.delete(agentId);
      const replay = this.catchupReplay.get(agentId);
      this.catchupReplay.set(agentId, {
        ops: replay === undefined ? batch.ops : [...replay.ops, ...batch.ops],
        cursor:
          replay === undefined || resumeCursor.seq >= replay.cursor.seq
            ? resumeCursor
            : replay.cursor,
      });
      if (startCatchUp) void this.catchUpAgent(agentId);
      return false;
    }
    this.observeCanonicalTodoRead(agentId, previousTodo, result.accepted, batch.cursor);
    this.recordToolCountSpan(agentId, priorCursor, resumeCursor, result.toolCallCountDelta);
    this.noteAppliedOps(this.timeline(agentId), result.accepted, resumeCursor, this.timelines.get(agentId)?.appliedGrade ?? gradeFor(this.transcriptGrades, agentId));
    this.timeline(agentId).cursor = resumeCursor;
    if (this.hasTranscriptBaseline(agentId)) this.viewHandle?.updateTranscriptCursor(agentId, resumeCursor);
    const adoptedCount = this.adoptToolCountObservation(agentId);
    if (result.accepted.length > 0 || adoptedCount) {
      for (const op of result.accepted) {
        if (op.op === 'frame.upsert' && op.frame.kind === 'tool') {
          const key = `${agentId}/${op.frame.toolCallId}`;
          const current = store.getToolCall(op.frame.toolCallId);
          if (this.toolDetails.has(key) && current !== undefined) this.toolDetails.set(key, { status: 'found', ...current });
        }
        this.observeContentPreview(agentId, op);
      }
      for (const target of this.contentReaders.values()) {
        if (target.agentId !== agentId) continue;
        target.retryAttempt = 0;
        if (target.retryTimer !== undefined) { clearTimeout(target.retryTimer); target.retryTimer = undefined; }
        if (!target.blocked) continue;
        const refs = this.contentRefsFor(agentId, target.source);
        if (target.ref === undefined || !refs.some((ref) => sameContentRef(ref, target.ref!))) target.blocked = false;
      }
      void this.pumpContentReads();
      if (opsAffectForest(result.accepted)) this.forestDirtyAgents.add(agentId);
      // A spawn names an agent the viewer has no roster row for; the row (role
      // profile and model) rides the session snapshot, not this op stream.
      this.requestRosterRows(subagentAgentsInOps(result.accepted), undefined, true);
      if (this.shell.agentCounts !== undefined && result.accepted.some((op) =>
        op.op === 'task.upsert' && changedTasks.has(op.task.taskId) && op.task.agentId !== undefined,
      )) void this.refreshRoster(this.shell.cursor);
      this.pendingTranscriptAgents.add(agentId);
    }
    return true;
  }

  private catchUpAgent(agentId: string): Promise<void> {
    const inFlight = this.catchupByAgent.get(agentId);
    if (inFlight !== undefined) {
      this.flushPendingTranscriptBatch(agentId, false);
      return inFlight;
    }
    this.flushPendingTranscriptBatch(agentId, false);
    const run = this.runCatchUpAgent(agentId).finally(() => {
      if (this.catchupByAgent.get(agentId) === run) this.catchupByAgent.delete(agentId);
    });
    this.catchupByAgent.set(agentId, run);
    return run;
  }

  private async runCatchUpAgent(agentId: string): Promise<void> {
    if (this.closed || this.resyncInFlight || this.rewriteHold !== undefined || this.shell.resyncError?.retryable === false) return;
    const generation = this.generationOf(agentId);
    const controller = new AbortController();
    this.catchupControllers.set(agentId, controller);
    const isCurrent = (): boolean => !this.closed && !this.isSuspended && !controller.signal.aborted &&
      this.generationOf(agentId) === generation;
    try {
      if (!this.hasTranscriptBaseline(agentId)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const last = this.timelines.get(agentId)?.cursor ?? { seq: 0 };
      const grade = gradeFor(this.transcriptGrades, agentId);
      let result = await this.view.transcript.catchUp({ agentId, since: last, grade: grade === 'off' ? 'turn' : grade }, { signal: controller.signal });
      const pages = [result];
      let since = last;
      while (result.has_more === true) {
        if (!isCurrent()) return;
        if (!result.complete || (since.epoch !== undefined && result.epoch !== since.epoch) || result.through_seq <= since.seq) {
          this.catchupReplay.delete(agentId);
          await this.resync();
          return;
        }
        since = { seq: result.through_seq, epoch: result.epoch };
        result = await this.view.transcript.catchUp({ agentId, since, grade: grade === 'off' ? 'turn' : grade }, { signal: controller.signal });
        pages.push(result);
      }
      if (!isCurrent()) return;
      if (!result.complete || (since.epoch !== undefined && result.epoch !== since.epoch)) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const store = this.ensureAgentTranscript(agentId);
      const recoveredOps: TranscriptOperation[] = [];
      for (const page of pages) for (const batch of page.batches) {
        recoveredOps.push(...(batch.ops as readonly TranscriptOperation[]));
      }
      let previousTodo = store.getTodo('todo');
      const recovered = this.applyAgentTranscriptOps(agentId, store, recoveredOps);
      if (recovered.gap !== undefined) {
        this.catchupReplay.delete(agentId);
        await this.resync();
        return;
      }
      const accepted = new Set(recovered.accepted);
      for (const page of pages) for (const batch of page.batches) {
        const ops = batch.ops.filter((op) => accepted.has(op as TranscriptOperation)) as readonly TranscriptOperation[];
        this.observeCanonicalTodoRead(agentId, previousTodo, ops, { seq: batch.seq, epoch: page.epoch });
        for (const op of ops) if (op.op === 'todo.upsert' && op.todo.todoId === 'todo') previousTodo = op.todo;
      }
      let changed = recovered.accepted.length > 0;
      if (opsAffectForest(recovered.accepted)) this.forestDirtyAgents.add(agentId);
      let cursor: TranscriptCursor = { seq: result.through_seq, epoch: result.epoch };
      const live = this.timelines.get(agentId)?.cursor;
      if (live !== undefined && live.epoch === result.epoch && live.seq > cursor.seq) {
        cursor = live;
      }
      const pending = this.catchupReplay.get(agentId);
      this.catchupReplay.delete(agentId);
      let retried: readonly TranscriptOperation[] = [];
      if (pending !== undefined) {
        const previousTodo = store.getTodo('todo');
        const retry = this.applyAgentTranscriptOps(agentId, store, pending.ops);
        retried = retry.accepted;
        if (retry.gap !== undefined) {
          await this.resync();
          return;
        }
        this.observeCanonicalTodoRead(agentId, previousTodo, retry.accepted, pending.cursor);
        if (pending.cursor.seq > cursor.seq) cursor = pending.cursor;
        if (retry.accepted.length > 0) changed = true;
        if (opsAffectForest(retry.accepted)) this.forestDirtyAgents.add(agentId);
      }
      this.toolCountSpans.delete(agentId);
      this.noteAppliedOps(this.timeline(agentId), [...recovered.accepted, ...retried], cursor, grade === 'off' ? 'turn' : grade);
      this.timeline(agentId).cursor = cursor;
      this.viewHandle?.updateTranscriptCursor(agentId, cursor);
      const adoptedCount = this.adoptToolCountObservation(agentId);
      if (changed || adoptedCount) {
        this.pendingTranscriptAgents.add(agentId);
        this.scheduleFrameFlush();
      }
    } catch {
      if (!isCurrent()) return;
      this.catchupReplay.delete(agentId);
      await this.resync();
    } finally {
      if (this.catchupControllers.get(agentId) === controller) this.catchupControllers.delete(agentId);
    }
  }

  private applyAgentTranscriptOps(agentId: string, store: AgentTranscript, ops: readonly TranscriptOperation[]) {
    const removed = new Set<string>();
    for (const op of ops) if (op.op === 'items.remove') for (const id of op.ids) removed.add(id);
    const planned: { key: string; turnId: string }[] = [];
    if (removed.size > 0) {
      planned.push(...this.residentToolDetailsOnTurns(agentId, store, removed));
      for (const op of ops) {
        if (op.op === 'frame.upsert' && op.frame.kind === 'tool' && removed.has(op.turnId)) planned.push({ key: `${agentId}/${op.frame.toolCallId}`, turnId: op.turnId });
      }
      const prefix = `${agentId}/`;
      for (const [key, lookup] of this.toolDetails) {
        if (key.startsWith(prefix) && lookup.status === 'found' && removed.has(lookup.turnId)) planned.push({ key, turnId: lookup.turnId });
      }
    }
    const result = store.apply(ops);
    if (removed.size > 0) {
      const accepted = new Set<string>();
      for (const op of result.accepted) if (op.op === 'items.remove') for (const id of op.ids) accepted.add(id);
      const keys = new Set<string>();
      for (const entry of planned) if (accepted.has(entry.turnId)) keys.add(entry.key);
      for (const key of keys) this.invalidateToolDetail(key);
      if (accepted.size > 0) {
        this.forgetWindowItems(agentId, accepted);
        for (const [key, entry] of this.contentBodies) if (entry.agentId === agentId &&
          (entry.source.kind === 'turn' && accepted.has(entry.source.id) || entry.source.kind === 'frame' && entry.source.turnId !== undefined && accepted.has(entry.source.turnId))) this.contentBodies.delete(key);
        this.timeline(agentId).olderCursor = undefined;
        if (accepted.has(this.timelines.get(agentId)?.olderTurn ?? '')) this.timeline(agentId).olderTurn = undefined;
        this.cancelHistoryRead(agentId);
      }
    }
    return result;
  }

  private residentToolDetailsOnTurns(agentId: string, store: AgentTranscript, turnIds: ReadonlySet<string>): { key: string; turnId: string }[] {
    const entries: { key: string; turnId: string }[] = [];
    for (const turnId of turnIds) {
      const turn = store.getTurn(turnId);
      if (turn === undefined) continue;
      for (const step of turn.steps) for (const frame of step.frames) {
        if (frame.kind === 'tool') entries.push({ key: `${agentId}/${frame.toolCallId}`, turnId });
      }
    }
    return entries;
  }

  private invalidateToolDetail(key: string): void {
    this.toolDetails.delete(key);
    this.toolDetailEpochs.set(key, (this.toolDetailEpochs.get(key) ?? 0) + 1);
    const flight = this.toolDetailReads.get(key);
    if (flight === undefined) return;
    this.toolDetailReads.delete(key);
    flight.controller.abort();
  }

  private bumpHistoryGeneration(agentId: string): void {
    this.timeline(agentId).generation += 1;
    for (const [key, target] of this.contentReaders) if (target.agentId === agentId) {
      this.retireContentRead(key);
      target.ref = undefined;
    }
    for (const [requestKey, controller] of this.contentControllers) if (requestKey.startsWith(`${agentId}/`)) {
      this.contentControllers.delete(requestKey);
      this.detailReads.delete(requestKey);
      controller.abort();
      this.setDetailLoad(agentId, requestKey.slice(agentId.length + 1), undefined);
    }
    void this.pumpContentReads();
    for (const [key, flight] of this.toolDetailReads) if (key.startsWith(`${agentId}/`)) { this.toolDetailReads.delete(key); flight.controller.abort(); }
    for (const key of this.toolDetails.keys()) if (key.startsWith(`${agentId}/`)) this.toolDetails.delete(key);
    for (const [controller, owner] of this.rangeControllers) if (owner === agentId) controller.abort();
    this.contentRanges.clear(); this.contentRangeBytes = 0;
    this.cancelHistoryRead(agentId);
    this.catchupControllers.get(agentId)?.abort();
    this.catchupControllers.delete(agentId);
    this.catchupByAgent.delete(agentId);
    this.toolCountSpans.delete(agentId);
    this.toolCountObservations.delete(agentId);
  }

  private observeToolCount(agentId: string, page: AgentTranscriptResponse): void {
    const count = page.tool_call_count;
    const cursor = page.cursor;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0 || typeof cursor?.epoch !== 'string' || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0) return;
    this.toolCountObservations.set(agentId, { count, cursor });
    this.adoptToolCountObservation(agentId);
  }

  private adoptToolCountObservation(agentId: string): boolean {
    const observation = this.toolCountObservations.get(agentId);
    if (observation === undefined) return false;
    const store = this.timelines.get(agentId)?.store;
    const current = this.timelines.get(agentId)?.cursor;
    if (store === undefined || current === undefined || current.epoch === undefined || current.epoch !== observation.cursor.epoch) {
      this.toolCountObservations.delete(agentId);
      return false;
    }
    if (store.snapshot().toolCallCount !== undefined) {
      this.toolCountObservations.delete(agentId);
      return false;
    }
    if (current.seq < observation.cursor.seq) return false;
    let count = observation.count;
    let through = observation.cursor.seq;
    for (const span of this.toolCountSpans.get(agentId) ?? []) {
      if (through === current.seq) break;
      if (span.through.seq <= through) continue;
      if (span.from.epoch !== current.epoch || span.from.seq !== through || span.through.seq > current.seq || span.delta === undefined) break;
      count += span.delta;
      through = span.through.seq;
    }
    this.toolCountObservations.delete(agentId);
    if (through !== current.seq || !Number.isSafeInteger(count) || count < 0) return false;
    const result = store.apply([{ op: 'tool.count.set', count }]);
    if (result.accepted.length === 0) return false;
    this.toolCountSpans.delete(agentId);
    this.forestDirtyAgents.add(agentId);
    return true;
  }

  private recordToolCountSpan(agentId: string, from: TranscriptCursor | undefined, through: TranscriptCursor, delta: number | undefined): void {
    if (this.timelines.get(agentId)?.store?.snapshot().toolCallCount !== undefined) {
      this.toolCountSpans.delete(agentId);
      return;
    }
    if (from === undefined || from.epoch !== through.epoch || from.seq >= through.seq) return;
    const spans = this.toolCountSpans.get(agentId) ?? [];
    const grade = gradeFor(this.transcriptGrades, agentId);
    spans.push({ from, through, delta: grade === 'block' || grade === 'delta' ? delta : undefined });
    if (spans.length > TOOL_COUNT_SPAN_LIMIT) spans.splice(0, spans.length - TOOL_COUNT_SPAN_LIMIT);
    this.toolCountSpans.set(agentId, spans);
  }

  private ensureAgentTranscript(agentId: string): AgentTranscript {
    const timeline = this.timeline(agentId);
    if (timeline.store !== undefined) return timeline.store;
    const store = new AgentTranscript(agentId);
    timeline.store = store;
    this.storeTimelines.add(timeline as StoredTimeline);
    return store;
  }

  /** The agent's window as one snapshot (the store's, unchanged objects reused). */
  private windowSnapshot(agentId: string): AgentTranscriptSnapshot {
    return this.ensureAgentTranscript(agentId).snapshot();
  }

  /**
   * Decide what a reset leaves of the held window. The reset defines the
   * items of its own range; the window keeps what it holds before that range
   * when the two are contiguous (a held turn reaches the reset's oldest one,
   * or the turn just before it) and comparable (same epoch, not built at a
   * lower grade than the reset's). A disjoint window — more happened while
   * the client was not receiving than the reset carries — could only be kept
   * as a window with a hole, so it is dropped and counts as older history not
   * loaded. Inside the range a held copy read later than the reset (a page
   * that raced ahead of the stream) is kept, and a turn-grade reset, which
   * carries no steps, keeps the held steps under its new header.
   */
  private resetWindow(timeline: AgentTimeline, store: AgentTranscript, snapshot: AgentTranscriptSnapshot,
    coverage: TranscriptCoverage, cursor: TranscriptCursor, grade: TranscriptGrade): ResetWindow {
    const heldItems = store.getItems();
    const held = { items: heldItems, hasMoreOlder: store.hasMoreOlder };
    const continuity = heldItems.length > 0 && (timeline.windowEpoch === undefined || timeline.windowEpoch === cursor.epoch);
    const windowGrade = timeline.windowGrade;
    const lowered = continuity && grade === 'turn' && windowGrade !== undefined && GRADE_RANK[windowGrade] > GRADE_RANK.turn;
    const raisedAbove = continuity && windowGrade !== undefined && GRADE_RANK[grade] > GRADE_RANK[windowGrade] &&
      GRADE_RANK[windowGrade] <= GRADE_RANK.turn;
    const heldByKey = new Map(continuity ? heldItems.map((item) => [windowItemKey(item), item] as const) : []);
    const heldWins = new Set<string>();
    const staleTurns = new Set<string>();
    const incoming = snapshot.items.map((item): TranscriptItem => {
      const key = windowItemKey(item);
      const heldItem = heldByKey.get(key);
      if (heldItem === undefined) {
        if (lowered && item.kind === 'turn') staleTurns.add(item.turnId);
        return item;
      }
      if (!readMarkWins(cursor, timeline.marks.get(key))) {
        heldWins.add(key);
        return heldItem;
      }
      // An unknown-coverage reset merges into the store without replacing
      // what it holds, so the copy kept here must already carry the bodies
      // read for unchanged content (a covered reset's own merge does that).
      if (item.kind !== 'turn' || heldItem.kind !== 'turn') {
        return coverage.kind === 'unknown' && item.kind === 'marker' && heldItem.kind === 'marker' ? mergeContentPreview(heldItem, item) : item;
      }
      let next: TranscriptTurn = coverage.kind === 'unknown' ? refreshTurn(heldItem, item) : item;
      if (grade === 'turn' && heldItem.steps.length > 0) {
        const { steps: _steps, ...header } = item;
        next = carryContentHydration(heldItem, { ...header, steps: heldItem.steps, stepsPartial: heldItem.stepsPartial,
          contentRefs: [
            ...(heldItem.contentRefs ?? []).filter((ref) => ref.path[0] === 'steps'),
            ...(item.contentRefs ?? []).filter((ref) => ref.path[0] !== 'steps'),
          ] });
      }
      if (lowered && !transcriptValueEquals(heldItem, next)) staleTurns.add(item.turnId);
      return next;
    });
    const resetKeys = new Set(incoming.map(windowItemKey));
    const firstTurn = snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn');
    const fromTurnId = coverage.kind === 'tail' ? coverage.fromTurnId : undefined;
    const fromOrdinal = fromTurnId === undefined ? firstTurn?.ordinal
      : snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === fromTurnId)?.ordinal ?? turnOrdinal(fromTurnId);
    const from = fromOrdinal !== undefined && Number.isFinite(fromOrdinal) ? fromOrdinal : firstTurn?.ordinal;
    let kept: TranscriptItem[] = [];
    if (continuity && coverage.kind !== 'full' && !raisedAbove &&
        (from === undefined || heldItems.some((item) => item.kind === 'turn' && item.ordinal >= from - 1))) {
      const boundary = from === undefined ? -1 : heldItems.findIndex((item) => item.kind === 'turn' && item.ordinal >= from);
      const end = boundary < 0 ? heldItems.length : boundary;
      kept = heldItems.filter((item, index) => !resetKeys.has(windowItemKey(item)) && (index < end || coverage.kind === 'unknown'));
      // A held turn older than the reset's oldest can no longer be running:
      // another turn started after it.
      for (const item of kept) if (item.kind === 'turn' && item.state === 'running' && from !== undefined && item.ordinal < from) staleTurns.add(item.turnId);
    }
    return { held, continuity, full: coverage.kind === 'full', lowered, incoming, resetKeys, heldWins, kept, staleTurns };
  }

  /** Bring the window's read marks and gap bookkeeping in line with what a reset left. */
  private settleWindowAfterReset(timeline: AgentTimeline, store: AgentTranscript, window: ResetWindow, cursor: TranscriptCursor, grade: TranscriptGrade): void {
    const items = store.getItems();
    const marks = new Map<string, ReadMark>();
    const present = new Set<string>();
    for (const item of items) {
      const key = windowItemKey(item);
      present.add(key);
      const previous = timeline.marks.get(key);
      if (window.resetKeys.has(key) && !window.heldWins.has(key)) marks.set(key, cursor);
      else if (previous !== undefined) marks.set(key, previous);
    }
    timeline.marks = marks;
    const replaced = (turnId: string): boolean => window.resetKeys.has(`turn:${turnId}`) && !window.heldWins.has(`turn:${turnId}`);
    const stale = new Set<string>();
    if (window.continuity) for (const turnId of timeline.stale) if (present.has(`turn:${turnId}`) && !replaced(turnId)) stale.add(turnId);
    for (const turnId of window.staleTurns) if (present.has(`turn:${turnId}`)) stale.add(turnId);
    timeline.stale = stale;
    const joins = new Map<string, string | null>();
    if (window.continuity) for (const [turnId, join] of timeline.joins) if (present.has(`turn:${turnId}`) && !replaced(turnId)) joins.set(turnId, join);
    timeline.joins = joins;
    if (!window.lowered) timeline.windowGrade = grade === 'off' ? timeline.windowGrade : grade;
    timeline.windowEpoch = cursor.epoch;
    if (window.kept.length === 0) {
      timeline.pagedPin = undefined;
      timeline.readerVisitedOld = false;
    }
    // Held turns the reset leaves out still exist (same epoch, a window that
    // does not reach back to them): they keep telling the agent tree which
    // children they spawned. A whole-history reset or a new epoch says it all.
    if (!window.continuity || window.full) timeline.relations = [];
    else timeline.relations = [...timeline.relations, ...relationStubs(window.held.items.filter((item) => !present.has(windowItemKey(item))))];
    timeline.relations = timeline.relations.filter((turn) => !present.has(`turn:${turn.turnId}`));
    timeline.refreshing = false;
  }

  /**
   * Place an older page in the agent's window, by the server's ordering.
   * Where the window holds the same item, the copy read later wins
   * (`readMarkWins`; a page without a watermark counts as read at the cursor
   * the window had when it was asked for). Pages are read at the full grade,
   * so a turn a page decides is no longer stale. The window's older edge
   * becomes the page's, and the window is pinned until the reader has been
   * seen reading the paged history (`pagedPin`).
   */
  private placeOlderPage(agentId: string, store: AgentTranscript, page: AgentTranscriptResponse, mark: ReadMark | undefined): void {
    const timeline = this.timeline(agentId);
    const held = new Set(store.getItems().map(windowItemKey));
    const oldestHeld = store.getItems().find((item): item is TranscriptTurn => item.kind === 'turn')?.ordinal;
    const decided = new Set<string>();
    const items = placeTranscriptItems(store.getItems(), page.items as readonly TranscriptItem[], (resident, incoming) => {
      const key = windowItemKey(incoming);
      const fresher = readMarkWins(mark, timeline.marks.get(key));
      if (resident.kind !== 'turn' || incoming.kind !== 'turn') {
        if (fresher) decided.add(key);
        return resolveItemCopies(resident, incoming, fresher);
      }
      const resolved = resolveTurnCopies(resident, incoming, fresher);
      if (resolved.join !== undefined) timeline.joins.set(incoming.turnId, resolved.join);
      if (resolved.fromIncoming) decided.add(key);
      return resolved.turn;
    });
    for (const item of page.items as readonly TranscriptItem[]) {
      const key = windowItemKey(item);
      if (held.has(key) && !decided.has(key)) continue;
      if (mark === undefined) timeline.marks.delete(key);
      else timeline.marks.set(key, mark);
      if (item.kind === 'turn' && held.has(key)) {
        timeline.stale.delete(item.turnId);
        timeline.joins.delete(item.turnId);
      }
    }
    store.replaceItems(items, page.has_more);
    const attachments = (page.attachments ?? []).filter((attachment) => store.getAttachment(attachment.attachmentId) === undefined);
    if (attachments.length > 0) store.apply(attachments.map((attachment) => ({ op: 'attachment.upsert', attachment }) as const));
    timeline.relations = timeline.relations.filter((turn) => store.getTurn(turn.turnId) === undefined);
    if (timeline.windowEpoch === undefined && mark?.epoch !== undefined) timeline.windowEpoch = mark.epoch;
    if (timeline.pagedPin === undefined) {
      timeline.pagedPin = oldestHeld ?? Number.POSITIVE_INFINITY;
      timeline.readerVisitedOld = false;
    }
  }

  /** Forget the bookkeeping of items that left the window (removed by the server). */
  private forgetWindowItems(agentId: string, ids: Iterable<string>): void {
    const timeline = this.timelines.get(agentId);
    if (timeline === undefined) return;
    const removed = new Set(ids);
    for (const id of removed) {
      for (const kind of ['turn', 'marker', 'taskref']) timeline.marks.delete(`${kind}:${id}`);
      timeline.stale.delete(id);
      timeline.joins.delete(id);
    }
    if (timeline.relations.some((turn) => removed.has(turn.turnId))) timeline.relations = timeline.relations.filter((turn) => !removed.has(turn.turnId));
  }

  /**
   * Record which held items a batch of applied ops decided, at the cursor it
   * brought the window to. Ops received below the grade the window was built
   * at (`turn` carries headers, no steps) leave every turn they touch stale.
   */
  private noteAppliedOps(timeline: AgentTimeline, ops: readonly TranscriptOperation[], cursor: TranscriptCursor, grade: TranscriptGrade | undefined): void {
    const lowered = grade === 'turn' && timeline.windowGrade !== undefined && GRADE_RANK[timeline.windowGrade] > GRADE_RANK.turn;
    for (const op of ops) {
      const key = opItemKey(op);
      if (key === undefined) continue;
      timeline.marks.set(key, cursor);
      if (lowered && key.startsWith('turn:')) timeline.stale.add(key.slice(5));
    }
    if (timeline.windowEpoch === undefined) timeline.windowEpoch = cursor.epoch;
  }

  /** Whether the agent's window holds this turn only in part (a published gap). */
  private turnHasGap(agentId: string, turnId: string): boolean {
    const timeline = this.timelines.get(agentId);
    const turn = timeline?.store?.getTurn(turnId);
    return turn !== undefined && turnGapOf(turn, timeline!.stale.has(turnId), timeline!.joins.get(turnId)) !== undefined;
  }

  /**
   * Keep the window bounded while its reader follows the tail. Once more than
   * `WINDOW_TRIM_ABOVE_TURNS` turns are held, the oldest are released down to
   * the newest `WINDOW_KEEP_TURNS`, and become older history not loaded: the
   * next older read pages them in again from the new oldest turn. The reader
   * follows the tail when a timeline row of one of the two newest turns is
   * mounted and none of a turn older than the kept ones; nothing is released
   * while no row is mounted at all (a view that never reports rows — the
   * terminal UI — keeps everything, as before), while older history is being
   * read or was paged in and not yet visited (`pagedPin`), or while a content
   * or structure read holds an older turn. A running turn is never released.
   */
  private trimWindow(agentId: string, timeline: AgentTimeline, store: AgentTranscript): boolean {
    const items = store.getItems();
    const turns: TranscriptTurn[] = [];
    for (const item of items) if (item.kind === 'turn') turns.push(item);
    if (turns.length <= WINDOW_TRIM_ABOVE_TURNS || timeline.paging > 0 || timeline.viewLeases.size === 0) return false;
    let cut = turns.length - WINDOW_KEEP_TURNS;
    const position = new Map(turns.map((turn, index) => [turn.turnId, index]));
    let atTail = false;
    for (const turnId of timeline.viewLeases.keys()) {
      const index = position.get(turnId);
      if (index === undefined) continue;
      if (index < cut) return false;
      if (index >= turns.length - 2) atTail = true;
    }
    if (!atTail) return false;
    if (timeline.pagedPin !== undefined) {
      if (!timeline.readerVisitedOld) return false;
      timeline.pagedPin = undefined;
      timeline.readerVisitedOld = false;
    }
    const older = (turnId: string | undefined): boolean => turnId !== undefined && (position.get(turnId) ?? Number.POSITIVE_INFINITY) < cut;
    for (const target of this.contentReaders.values()) {
      if (target.agentId !== agentId || target.readers === 0) continue;
      if (older(target.source.kind === 'turn' ? target.source.id : target.source.kind === 'frame' ? target.source.turnId : undefined)) return false;
    }
    const prefix = `${agentId}/content:`;
    for (const key of this.contentControllers.keys()) {
      if (!key.startsWith(prefix)) continue;
      const source = (JSON.parse(key.slice(prefix.length)) as ContentRef).source;
      if (older(source.kind === 'turn' ? source.id : source.kind === 'frame' ? source.turnId : undefined)) return false;
    }
    const running = turns.findIndex((turn, index) => index < cut && turn.state === 'running');
    if (running >= 0) cut = running;
    if (cut <= 0) return false;
    const released = store.releaseBefore(turns[cut]!.turnId);
    if (released.length === 0) return false;
    const ids = released.map((item) => item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId);
    this.forgetWindowItems(agentId, ids);
    const relations = relationStubs(released);
    if (relations.length > 0) timeline.relations = [...timeline.relations, ...relations];
    const gone = new Set(ids);
    const view = timeline.view;
    if (view !== undefined && Object.keys(view.detailLoads).some((key) => key.startsWith('structure:') && gone.has(key.slice('structure:'.length)))) {
      timeline.view = { ...view, detailLoads: Object.fromEntries(Object.entries(view.detailLoads)
        .filter(([key]) => !key.startsWith('structure:') || !gone.has(key.slice('structure:'.length)))) };
    }
    for (const [key, entry] of this.contentBodies) if (entry.agentId === agentId &&
      (entry.source.kind === 'turn' && gone.has(entry.source.id) || entry.source.kind === 'frame' && entry.source.turnId !== undefined && gone.has(entry.source.turnId))) this.contentBodies.delete(key);
    timeline.olderCursor = undefined;
    timeline.olderTurn = turns[cut]!.turnId;
    this.forestDirtyAgents.add(agentId);
    return true;
  }

  private publishProjectedAgent(
    agentId: string,
    _store: AgentTranscript,
    options?: Partial<Pick<SessionViewState, 'loadingOlder' | 'fetchedOlder' | 'olderError' | 'historyCoverageKind'>> & {
      readonly retainPendingPrompts?: boolean;
      readonly transcriptReset?: boolean;
    },
  ): void {
    const timeline = this.timeline(agentId);
    const trimmed = this.trimWindow(agentId, timeline, this.ensureAgentTranscript(agentId));
    const snapshot = this.windowSnapshot(agentId);
    // Every agent's projection reads the session roster, for subagent cards.
    const previousBase = this.viewOf(agentId);
    const previous =
      previousBase.snapshotSubagents === this.shell.snapshotSubagents
        ? previousBase
        : { ...previousBase, snapshotSubagents: this.shell.snapshotSubagents };
    let next = projectAgentTranscriptView(previous, agentId, snapshot, {
      retainPendingPrompts: options?.retainPendingPrompts,
      cold: timeline.cursor?.epoch?.startsWith('cold:') === true,
      gapOf: (turn) => turnGapOf(turn, timeline.stale.has(turn.turnId), timeline.joins.get(turn.turnId)),
    });
    // A trim makes history older than the window not loaded again.
    if (trimmed && next.historyCoverageKind === 'full') next = { ...next, historyCoverageKind: 'tail' };
    if (agentId === MAIN_AGENT_ID) {
      for (const prompt of snapshot.prompts) this.unprojectedQueueReceipts.delete(prompt.promptId);
      for (const receipt of this.unprojectedQueueReceipts.values()) {
        const projection = projectMessageContent(receipt.content);
        next = appendLocalUserMessage(next, { userMessageId: receipt.user_message_id, promptId: receipt.prompt_id,
          text: projection.text, media: projection.media, content: receipt.content, createdAt: receipt.created_at,
          status: receipt.status, origin: receipt.origin, appendTiming: receipt.append_timing });
        next = { ...next, queuedPromptMeta: { ...next.queuedPromptMeta,
          [receipt.prompt_id]: { appendTiming: receipt.append_timing ?? 'agent_idle', revision: receipt.revision, queuePosition: previous.queuedPromptMeta[receipt.prompt_id]?.queuePosition } } };
      }
    }
    for (const block of next.blocks) {
      if (block.kind !== 'question' || block.outcome !== undefined) continue;
      const outcome = this.questionOutcomes.get(block.request.question_id);
      if (outcome !== undefined) next = markQuestionOutcome(next, block.request.question_id, outcome);
    }
    const projected =
      options === undefined
        ? next
        : {
            ...next,
            transcriptResetVersion: options.transcriptReset === true
              ? next.transcriptResetVersion + 1
              : next.transcriptResetVersion,
            loadingOlder: options.loadingOlder ?? next.loadingOlder,
            fetchedOlder: options.fetchedOlder ?? next.fetchedOlder,
            olderError: Object.hasOwn(options, 'olderError') ? options.olderError : next.olderError,
            historyCoverageKind: options.historyCoverageKind ?? next.historyCoverageKind,
          };
    // Main's view also carries the session snapshot's content refs (the
    // roster's), whose reads are keyed on main.
    const contentRefs = stableContentRefs(previous.contentRefs, [...collectTranscriptContentRefs(snapshot), ...(agentId === MAIN_AGENT_ID ? this.latestSnapshot?.contentRefs ?? [] : [])]);
    const transcriptReady = this.transcriptPresentable(agentId);
    const withCoverage = { ...projected, globalCoverage: timeline.globalCoverage, contentRefs, historyRead: timeline.historyRead, todoRead: timeline.todoRead,
      transcriptReady, refreshing: transcriptReady && timeline.refreshing };
    const forestChanged = this.forestDirtyAgents.delete(agentId) || this.publishedForest === undefined
      ? this.publishForest()
      : false;
    if (timeline.cursor !== undefined) timeline.publishedCursor = timeline.cursor;
    this.adoptAcceptedSteers(agentId, withCoverage);
    // A projection of main's timeline also means the session has loaded: the
    // first reset may arrive before the session snapshot does.
    if (agentId === MAIN_AGENT_ID && (!this.shell.loaded || this.shell.loadError !== undefined)) {
      this.setShell({ ...this.shell, version: this.shell.version + 1, loaded: true, loadError: undefined }, false);
    }
    this.publishView(agentId, withCoverage);
    if (this.contentReaders.size > 0) void this.pumpContentReads();
    // The forest is session-level: a change another agent's projection made
    // is published with the shell, which `subscribe` listeners hear (main's
    // own publication just carried it).
    if (forestChanged && agentId !== MAIN_AGENT_ID) this.publishShell();
  }

  forestPublishCount = 0;

  private publishForest(): boolean {
    const snapshots = new Map<string, AgentTranscriptSnapshot>();
    for (const timeline of this.storeTimelines) {
      const window = timeline.store.snapshot();
      if (timeline.relations.length === 0) {
        snapshots.set(timeline.agentId, window);
        continue;
      }
      // Trimmed turns still say which children this agent spawned, and when.
      const cached = timeline.forestInput;
      if (cached?.relations !== timeline.relations || cached.window !== window) {
        timeline.forestInput = { relations: timeline.relations, window, snapshot: { ...window, items: [...timeline.relations, ...window.items] } };
      }
      snapshots.set(timeline.agentId, timeline.forestInput!.snapshot);
    }
    const previous = this.publishedForest;
    const coldAgents = new Set([...this.timelines.values()].filter(({ cursor }) => cursor?.epoch?.startsWith('cold:') === true).map(({ agentId }) => agentId));
    const rosterCurrentAgents = new Set<string>();
    for (const [agentId, binding] of this.rosterTranscriptBindings) {
      if (binding === this.timelines.get(agentId)?.store?.getMeta().agent) rosterCurrentAgents.add(agentId);
      else this.rosterTranscriptBindings.delete(agentId);
    }
    this.publishedForest = this.forestQuery.read(snapshots, this.shell.snapshotSubagents, coldAgents, rosterCurrentAgents);
    this.forestPublishCount += 1;
    return previous !== this.publishedForest;
  }

  async sendPrompt(input: {
    text: string;
    /**
     * Full wire content override (mentions folded into the text part, images
     * as base64 parts). When omitted, a single text part carries `text`.
     */
    content?: MessageContent[];
    /**
     * Main-agent profile to bind before this prompt runs. Carry the new name
     * WITHOUT model/thinking so the rebind lands on the profile's own pins.
     */
    profile?: string;
    execution?: ExecutionSelection;
    model?: string;
    thinking?: string | null;
    permissionMode?: PermissionMode;
    planMode?: boolean;
    /**
     * Session plan-gate pick (`plan_gate`): when set, every prompt of this
     * session pins the agent's gate; omit to keep the agent's current gate.
     */
    planGate?: PromptPlanGate;
    goalObjective?: string;
    goalControl?: 'pause' | 'resume' | 'cancel';
    /**
     * Deferred-append timing for this message when it lands in the queue
     * (consumed only when the prompt actually parks; running prompts ignore
     * it). Defaults to the server-side `agent_idle` when omitted.
     */
    appendTiming?: DeferredAppendTiming;
    /**
     * Park this prompt behind an accepted model-switch operation: it launches
     * only after that operation completes, on the binding the operation
     * committed. Send-now/steer paths never carry it (they run on the live
     * binding by definition).
     */
    afterModelSwitch?: string;
    modelSwitchMode?: 'direct' | 'compact' | 'fresh';
    promptId?: string;
    skills?: readonly import('@kiki/protocol').PromptSkillActivation[];
    personaGreetingReply?: boolean;
    onPreservation?: (persisted: boolean) => void;
    onAcknowledged?: () => void;
  }): Promise<PromptSubmitResult> {
    // Prompt submission is the durable enqueue boundary. History resync and
    // ordered-view readiness must not block a user message from reaching the
    // server; rewrite/edit/steer operations keep their stricter cursor gate.
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const promptId = input.promptId ?? newSteerPromptId();
    const durable = this.usesDurableSubmission();
    const preservation = preserveSubmission({ sessionId: this.sessionId, agentId: MAIN_AGENT_ID, promptId, content, createdAt: new Date().toISOString() }, { persist: durable });
    input.onPreservation?.(preservation.persisted);
    const result = await this.client.submitPrompt(this.sessionId, {
      admission: durable ? 'durable' : undefined,
      content,
      profile: input.profile,
      execution: input.execution,
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode,
      goal_objective:
        input.goalObjective !== undefined && input.goalObjective.trim() !== ''
          ? input.goalObjective.trim()
          : undefined,
      goal_control: input.goalControl,
      append_timing: input.appendTiming,
      after_model_switch: input.afterModelSwitch,
      model_switch_mode: input.modelSwitchMode,
      prompt_id: promptId,
      skills: input.skills === undefined ? undefined : [...input.skills],
      persona_greeting_reply: input.personaGreetingReply,
    });
    const admissionRejected = result.admission === 'failed' || result.admission === 'cancelled';
    if (!admissionRejected) {
      preservation.acknowledge();
      input.onAcknowledged?.();
    }
    if (result.admission !== undefined) {
      this.setDurableIngress([
        ...(this.shell.durableIngress ?? []).filter((item) => item.prompt_id !== result.prompt_id),
        result,
      ]);
    }
    const coreAdmitted = result.admission === undefined || result.admission === 'admitted';
    const canonical = this.timelines.get(MAIN_AGENT_ID)?.store?.getPrompt(result.prompt_id);
    if (coreAdmitted && result.status === 'queued' && canonical === undefined) {
      this.unprojectedQueueReceipts.set(result.prompt_id, result);
    }
    if (!coreAdmitted || admissionRejected || canonical !== undefined) return result;
    const projection = projectMessageContent(result.content);
    this.publishView(MAIN_AGENT_ID,
      appendLocalUserMessage(this.viewOf(MAIN_AGENT_ID), {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text === '' ? input.text : projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
        appendTiming: result.append_timing ?? input.appendTiming,
      }),
    );
    return result;
  }

  /**
   * Optimistic-concurrency cursor for the message-closure routes: the view's
   * current durable watermark. The server answers 40937 when the journal moved
   * past it (another client edited/forked first).
   */
  private expectedCursor(): SessionCursor {
    return { seq: this.shell.cursor.seq, epoch: this.shell.cursor.epoch };
  }

  /**
   * Edit-resend a user message (`POST …/messages/{mid}:edit`, full-replacement
   * semantics — attachments are NOT inherited; the body is the whole new
   * content). The server truncates the history from the target onward and
   * reruns the turn; we resync locally so the truncated tail (and any orphaned
   * subagent captures) repaint from server truth.
   */
  async editMessage(
    messageId: string,
    input: {
      text: string;
      content?: MessageContent[];
      model?: string;
      thinking?: string | null;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
    },
  ): Promise<void> {
    await this.runMessageRewrite('edit', messageId, {
      content: input.content ?? [{ type: 'text', text: input.text }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
    });
    // The server also emits event.session.history_rewritten; resyncing here
    // makes the local repaint independent of WS delivery.
    void this.resync({ rewrite: true });
  }

  /**
   * Regenerate the turn behind an assistant message
   * (`POST …/messages/{mid}:regenerate`). Same rewrite + resync shape as
   * editMessage, without new content.
   */
  async regenerateMessage(
    messageId: string,
    input: {
      model?: string;
      thinking?: string | null;
      permissionMode?: PermissionMode;
      planMode?: boolean;
      planGate?: PromptPlanGate;
    } = {},
  ): Promise<void> {
    await this.runMessageRewrite('regenerate', messageId, {
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_gate: input.planGate,
      plan_mode: input.planMode === true ? true : undefined,
    });
    void this.resync({ rewrite: true });
  }

  private readonly messageRewrites = new Map<string, {
    fingerprint: string;
    body: import('../transport').EditMessageRequest | import('../transport').RegenerateMessageRequest;
    flight?: Promise<PromptSubmitResult>;
    result?: PromptSubmitResult;
  }>();

  private async runMessageRewrite(
    action: 'edit' | 'regenerate',
    messageId: string,
    input: Omit<import('../transport').EditMessageRequest, 'expected_cursor'> | Omit<import('../transport').RegenerateMessageRequest, 'expected_cursor'>,
  ): Promise<PromptSubmitResult> {
    const key = `${action}:${messageId}`;
    const fingerprint = JSON.stringify(input);
    let operation = this.messageRewrites.get(key);
    if (operation?.fingerprint !== fingerprint) operation = undefined;
    if (operation?.result !== undefined) {
      if (JSON.stringify(operation.body.expected_cursor) === JSON.stringify(this.expectedCursor())) return operation.result;
      operation = undefined;
    }
    if (operation?.flight !== undefined) return operation.flight;
    assertSessionWritable(this.shell);
    if (operation === undefined) {
      operation = { fingerprint, body: { ...input, operation_id: newSteerPromptId(), expected_cursor: this.expectedCursor() } };
      this.messageRewrites.set(key, operation);
    }
    const retained = operation;
    const request = action === 'edit'
      ? this.client.editMessage(this.sessionId, messageId, retained.body as import('../transport').EditMessageRequest)
      : this.client.regenerateMessage(this.sessionId, messageId, retained.body);
    retained.flight = request;
    try {
      retained.result = await request;
      return retained.result;
    } catch (error) {
      const code = error instanceof ApiError || error instanceof RPCError ? error.code : undefined;
      if (code !== undefined && code > 0 && code !== 50001 && this.messageRewrites.get(key) === retained) {
        this.messageRewrites.delete(key);
      }
      throw error;
    } finally {
      retained.flight = undefined;
    }
  }

  /**
   * Fork the session at a message (`POST …:fork` with the truncation pair).
   * Returns the new session record; the caller navigates. Open-tail semantics:
   * no prompt runs in the fork until the user sends one.
   */
  async forkFromMessage(messageId: string): Promise<Session> {
    const fork = await this.client.forkSession(this.sessionId, {
      through_message_id: messageId,
      expected_cursor: this.expectedCursor(),
    });
    return fork;
  }

  async abortActive(): Promise<void> {
    if (this.abortActiveInFlight !== undefined) return this.abortActiveInFlight;
    const pending = this.abortActiveAndRestore();
    this.abortActiveInFlight = pending;
    try {
      await pending;
    } finally {
      this.abortActiveInFlight = undefined;
    }
  }

  private unansweredPromptContent(promptId: string, afterAbort = false): readonly MessageContent[] | undefined {
    const store = this.timelines.get(MAIN_AGENT_ID)?.store;
    if (store === undefined || this.timelines.get(MAIN_AGENT_ID)?.appliedGrade !== 'delta') return undefined;
    const snapshot = store.snapshot();
    const prompt = snapshot.prompts.find((item) => item.promptId === promptId);
    if (prompt === undefined || prompt.steeredAt !== undefined ||
        (prompt.status !== 'running' && !(afterAbort && prompt.status === 'aborted'))) return undefined;
    const turn = snapshot.items.find((item) => item.kind === 'turn' && (
      item.promptId === promptId || item.origin.kind === 'user' &&
      typeof item.origin.payload === 'object' && item.origin.payload !== null &&
      'promptId' in item.origin.payload && item.origin.payload.promptId === promptId
    ));
    if (turn?.kind === 'turn') {
      if (turn.origin.kind !== 'user') return undefined;
      if (turn.steps.some((step) => step.frames.some((frame) => frame.kind === 'tool' ||
          frame.kind === 'text' && frame.role === 'assistant' && (frame.text !== '' || (frame.attachmentIds?.length ?? 0) > 0)))) return undefined;
    }
    const parsed = messageContentSchema.array().safeParse(prompt.content);
    if (!parsed.success || parsed.data.length === 0 || parsed.data.some((part) =>
      part.type !== 'text' && part.type !== 'image' && part.type !== 'video' && part.type !== 'file')) return undefined;
    return parsed.data;
  }

  private async abortActiveAndRestore(): Promise<void> {
    const main = this.viewOf(MAIN_AGENT_ID);
    if (!main.busy) return;
    const promptId = main.abortablePromptId;
    if (promptId !== undefined) {
      const content = this.unansweredPromptContent(promptId);
      const result = await this.client.abortPrompt(this.sessionId, promptId);
      await this.refreshPrompts();
      if (result.aborted && content !== undefined && this.lastRestoredPromptId !== promptId &&
          this.unansweredPromptContent(promptId, true) !== undefined) {
        this.lastRestoredPromptId = promptId;
        for (const listener of this.interruptedPromptListeners) listener(content);
      }
      return;
    }
    const turnId = main.abortableTurnId;
    if (turnId !== undefined) await this.client.abortTurn(this.sessionId, turnId);
  }

  async abortPrompt(promptId: string, agentId = MAIN_AGENT_ID): Promise<boolean> {
    const result = await this.client.abortPrompt(this.sessionId, promptId, agentId === MAIN_AGENT_ID ? undefined : agentId, true).catch(error => {
      if (error instanceof ApiError && error.code === API_CODES.PROMPT_NOT_FOUND) return { aborted: false };
      throw error;
    });
    this.clearPendingSteer(agentId, promptId);
    if (!result.aborted) {
      await this.resync();
      return false;
    }
    if (agentId !== MAIN_AGENT_ID) return true;
    this.unprojectedQueueReceipts.delete(promptId);
    const main = this.viewOf(MAIN_AGENT_ID);
    const queuedPromptMeta = { ...main.queuedPromptMeta };
    delete queuedPromptMeta[promptId];
    this.publishView(MAIN_AGENT_ID, { ...main, version: main.version + 1,
      queuedPromptIds: main.queuedPromptIds.filter((id) => id !== promptId), queuedPromptMeta,
      blocks: main.blocks.filter((block) => !(block.kind === 'user' && block.promptId === promptId && block.promptStatus === 'queued' && block.turnId === undefined)),
    });
    await this.refreshPrompts();
    return true;
  }

  async readQueuedPromptContent(promptId: string, signal?: AbortSignal): Promise<readonly MessageContent[] | undefined> {
    const source = { kind: 'prompt' as const, id: promptId };
    const lease = this.beginContentRead(MAIN_AGENT_ID, source, ['content']);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const ref = this.contentRefsFor(MAIN_AGENT_ID, source).find((candidate) => candidate.path[0] === 'content');
        if (ref === undefined) break;
        if (!await this.loadContentSegment(MAIN_AGENT_ID, ref)) throw new Error('Could not read the complete queued prompt');
      }
      const prompt = this.timelines.get(MAIN_AGENT_ID)?.store?.getPrompt(promptId);
      if (prompt?.status !== 'queued' && prompt?.status !== 'blocked') return undefined;
      const parsed = messageContentSchema.array().safeParse(prompt.content);
      if (!parsed.success) throw new Error('Could not read the original queued prompt attachments');
      return parsed.data;
    } finally { lease.release(); }
  }

  async replaceQueued(promptId: string, text: string, retainedAttachments?: readonly MessageContent[], presentation?: import('@kiki/transcript').TextPresentation): Promise<void> {
    assertSessionWritable(this.shell);
    const result = await this.client.replacePrompt(this.sessionId, promptId, {
      content: [...(text.trim() === '' ? [] : [{ type: 'text' as const, text, presentation }]), ...(retainedAttachments ?? [])],
      replace_attachments: retainedAttachments === undefined ? undefined : true,
    });
    if (this.unprojectedQueueReceipts.has(promptId)) this.unprojectedQueueReceipts.set(promptId, result);
    const projection = projectMessageContent(result.content);
    this.publishView(MAIN_AGENT_ID,
      appendLocalUserMessage(this.viewOf(MAIN_AGENT_ID), {
        userMessageId: result.user_message_id,
        promptId: result.prompt_id,
        text: projection.text,
        createdAt: result.created_at,
        status: result.status,
        origin: result.origin,
        media: projection.media,
        content: result.content,
      }),
    );
  }

  async moveQueued(promptId: string, targetIndex: number): Promise<void> {
    assertSessionWritable(this.shell);
    const result = await this.client.movePrompt(this.sessionId, promptId, {
      target_index: targetIndex,
    });
    // The receipt lists the engine's SHARED drain order, which interleaves
    // model-switch control items (reserved ids) with messages. Control items
    // never become message rows here — they render through the model-switch
    // event pair — but their slots anchor each message's queuePosition so the
    // strip can interleave both kinds faithfully.
    const main = this.viewOf(MAIN_AGENT_ID);
    const queuedPromptMeta: Record<string, QueuedPromptMeta> = { ...main.queuedPromptMeta };
    result.queued_prompt_ids.forEach((id, index) => {
      if (isModelSwitchQueueId(id)) return;
      const receipt = this.unprojectedQueueReceipts.get(id);
      if (receipt !== undefined) {
        this.unprojectedQueueReceipts.delete(id);
        this.unprojectedQueueReceipts.set(id, receipt);
      }
      const existing = queuedPromptMeta[id];
      queuedPromptMeta[id] = {
        ...existing,
        appendTiming: existing?.appendTiming ?? 'agent_idle',
        queuePosition: index,
      };
    });
    this.publishView(MAIN_AGENT_ID, {
      ...main,
      version: main.version + 1,
      queuedPromptIds: result.queued_prompt_ids.filter((id) => !isModelSwitchQueueId(id)),
      queuedPromptMeta,
    });
  }

  /**
   * Re-time a parked prompt (`POST …:timing`). Sends the last known scheduling
   * revision as `expected_revision` so a concurrent retime (another client,
   * the engine itself) fails with 40001 instead of silently winning; stale
   * local replies likewise cannot replace a newer timing or queue-order write.
   */
  async setQueuedTiming(promptId: string, appendTiming: DeferredAppendTiming): Promise<void> {
    assertSessionWritable(this.shell);
    const existing = this.viewOf(MAIN_AGENT_ID).queuedPromptMeta[promptId];
    const existingAppendTiming = existing?.appendTiming ?? 'agent_idle';
    const existingRevision = existing?.revision;
    const write = ++this.queuedTimingWriteSequence;
    this.queuedTimingWrites.set(promptId, write);
    const expected = existingRevision;
    let result: Awaited<ReturnType<SessionTransport['timingPrompt']>>;
    try {
      result = await this.client.timingPrompt(this.sessionId, promptId, {
        append_timing: appendTiming,
        expected_revision: expected,
      });
    } catch (error) {
      if (this.queuedTimingWrites.get(promptId) === write) this.queuedTimingWrites.delete(promptId);
      throw error;
    }
    const main = this.viewOf(MAIN_AGENT_ID);
    const current = main.queuedPromptMeta[promptId];
    if (this.queuedTimingWrites.get(promptId) !== write) return;
    if (
      !main.queuedPromptIds.includes(promptId) ||
      (current?.appendTiming ?? 'agent_idle') !== existingAppendTiming ||
      current?.revision !== existingRevision
    ) {
      this.queuedTimingWrites.delete(promptId);
      return;
    }
    this.queuedTimingWrites.delete(promptId);
    this.publishView(MAIN_AGENT_ID, {
      ...main,
      version: main.version + 1,
      queuedPromptMeta: {
        ...main.queuedPromptMeta,
        [promptId]: {
          ...current,
          appendTiming: result.append_timing ?? appendTiming,
          revision: result.revision,
        },
      },
    });
  }

  /**
   * Edit hold (`POST …:hold`): while a queued prompt is being edited the
   * engine keeps it — and everything queued behind it — from launching;
   * prompts ahead of it still run. The hold lapses server-side unless renewed,
   * so callers re-send `held: true` while the edit stays open. A transport
   * without the command (older server) resolves `false`: the edit still works,
   * the prompt just is not protected from launching.
   */
  async holdQueued(promptId: string, held: boolean): Promise<boolean> {
    if (this.client.holdPrompt === undefined) return false;
    assertSessionWritable(this.shell);
    await this.client.holdPrompt(this.sessionId, promptId, { held });
    return true;
  }

  /** Send a parked prompt at the next safe boundary; report its actual disposition. */
  async steerQueued(promptId: string): Promise<{ readonly outcome: 'accepted' | 'steered' | 'started' | 'queued' | 'not_pending' | 'unconfirmed' | 'failed' | 'cancelled'; readonly reason?: PromptItem['delivery_reason'] }> {
    assertSessionWritable(this.shell);
    if (this.findPendingSteer(MAIN_AGENT_ID, promptId)?.phase === 'waiting') return { outcome: 'accepted' };
    const queued = this.viewOf(MAIN_AGENT_ID).blocks.find((block) =>
      block.kind === 'user' && block.promptId === promptId && block.promptStatus === 'queued');
    if (queued?.kind === 'user') {
      this.setPendingSteer(MAIN_AGENT_ID, {
        promptId,
        userMessageId: queued.userMessageId,
        text: queued.text,
        presentation: queued.presentation,
        media: queued.media,
        createdAt: new Date().toISOString(),
        phase: 'sending',
      });
    }
    let delivery: Awaited<ReturnType<SessionTransport['steerPrompt']>>;
    try {
      delivery = await this.client.steerPrompt(this.sessionId, promptId);
    } catch (error) {
      if (isUnconfirmedTransportError(error)) {
        const outcome = this.settledSteerOutcome(MAIN_AGENT_ID, promptId);
        if (outcome !== undefined) return { outcome };
        const retained = this.findPendingSteer(MAIN_AGENT_ID, promptId);
        if (retained?.phase === 'waiting') return { outcome: 'accepted' };
        if (retained !== undefined) this.setPendingSteer(MAIN_AGENT_ID, { ...retained, phase: 'unconfirmed' });
        return { outcome: 'unconfirmed' };
      }
      this.clearPendingSteer(MAIN_AGENT_ID, promptId);
      if (error instanceof ApiError && error.code === API_CODES.PROMPT_NOT_FOUND) {
        await this.resync();
        return { outcome: 'not_pending', reason: 'prompt_no_longer_pending' };
      }
      await this.refreshPrompts();
      throw error;
    }
    this.unprojectedQueueReceipts.delete(promptId);
    const settled = this.settledSteerOutcome(MAIN_AGENT_ID, promptId);
    if (settled === 'failed' || settled === 'cancelled') {
      this.clearPendingSteer(MAIN_AGENT_ID, promptId);
      return { outcome: settled };
    }
    if (delivery.steered || delivery.delivery_state === 'accepted') {
      const accepted = this.findPendingSteer(MAIN_AGENT_ID, promptId);
      if (accepted !== undefined) this.setPendingSteer(MAIN_AGENT_ID, { ...accepted, phase: 'waiting' });
    } else this.clearPendingSteer(MAIN_AGENT_ID, promptId);
    if (delivery.delivery_state === 'accepted') return { outcome: 'accepted' };
    await this.refreshPrompts();
    if (!delivery.steered && delivery.delivery_state !== 'queued') await this.resync();
    return { outcome: delivery.steered ? 'steered' : delivery.delivery_state ?? 'not_pending', reason: delivery.delivery_reason };
  }

  /** "Send now" echoes still between the keypress and their delivered frame, per agent. */
  getPendingSteers(agentId: string = MAIN_AGENT_ID): readonly PendingSteer[] {
    return this.timelines.get(agentId)?.steers ?? [];
  }

  /**
   * "Send now" into the running turn of `agentId` (main or a native child) —
   * one path for every conversation, so the insertion point is the same
   * everywhere: the turn's next step boundary (after the current tool round).
   *
   * The message is on the timeline from the first frame: it enters the
   * steer ledger before any request goes out and leaves it only when the
   * projection owns its delivered frame. The prompt id is chosen here, so the
   * submit, the steer and the delivered context message share one identity
   * and the echo hands over to the real row without a remount.
   *
   * Idle agent: the submit starts its own turn and the echo retires as soon
   * as that prompt is running. A steer refused for a mode change is only
   * classified as refused after the parked prompt is confirmed withdrawn; if
   * withdrawal fails, the outcome is unknown and the queued prompt stays the
   * server-owned source of truth.
   */
  async sendPromptNow(input: {
    readonly agentId?: string;
    readonly text: string;
    readonly content?: MessageContent[];
    readonly media?: PendingSteer['media'];
    readonly promptId?: string;
    readonly afterModelSwitch?: string;
    readonly profile?: string;
    readonly execution?: ExecutionSelection;
    readonly model?: string;
    readonly modelSwitchMode?: 'direct' | 'compact' | 'fresh';
    readonly thinking?: string | null;
    readonly permissionMode?: PermissionMode;
    readonly planMode?: boolean;
    readonly planGate?: PromptPlanGate;
    readonly skills?: readonly import('@kiki/protocol').PromptSkillActivation[];
    readonly onPreservation?: (persisted: boolean) => void;
    readonly onAcknowledged?: () => void;
  }): Promise<{ readonly promptId: string; readonly outcome: 'accepted' | 'steered' | 'started' | 'queued' | 'not_pending' | 'restoring' | 'held' | 'failed' | 'cancelled'; readonly reason?: PromptItem['delivery_reason'] }> {
    assertSessionWritable(this.shell);
    const agentId = input.agentId ?? MAIN_AGENT_ID;
    const promptId = input.promptId ?? newSteerPromptId();
    const content = input.content ?? [{ type: 'text' as const, text: input.text }];
    const projection = projectMessageContent(content);
    const durable = this.usesDurableSubmission();
    const preservation = preserveSubmission({ sessionId: this.sessionId, agentId, promptId, content, createdAt: new Date().toISOString() }, { persist: durable });
    input.onPreservation?.(preservation.persisted);
    this.setPendingSteer(agentId, {
      promptId,
      text: input.text,
      presentation: projection.presentation,
      media: input.media ?? nonEmpty(projection.media),
      createdAt: new Date().toISOString(),
      phase: 'sending',
    });
    let result: PromptSubmitResult;
    try {
      result = await this.client.submitPrompt(this.sessionId, {
        admission: durable ? 'durable' : undefined,
        delivery_mode: 'steer',
        after_model_switch: input.afterModelSwitch,
        content,
        prompt_id: promptId,
        ...(agentId === MAIN_AGENT_ID ? {} : { agent_id: agentId }),
        profile: input.profile,
        execution: input.execution,
        model: input.model,
        model_switch_mode: input.modelSwitchMode,
        thinking: input.thinking,
        permission_mode: input.permissionMode,
        plan_mode: input.planMode,
        plan_gate: input.planGate,
        skills: input.skills === undefined ? undefined : [...input.skills],
      });
    } catch (error) {
      if (isUnconfirmedTransportError(error)) {
        const retained = this.findPendingSteer(agentId, promptId);
        const outcome = this.settledSteerOutcome(agentId, promptId) ?? (retained?.phase === 'waiting' ? 'accepted' : undefined);
        if (outcome !== undefined) {
          preservation.acknowledge();
          input.onAcknowledged?.();
          return { promptId, outcome };
        }
        if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'unconfirmed' });
        if (durable) this.observeDurableSteer(agentId, promptId);
        throw new SendNowError('unknown', error);
      }
      this.clearPendingSteer(agentId, promptId);
      throw new SendNowError('submit', error);
    }
    const admission = result.admission;
    const admissionRejected = admission === 'failed' || admission === 'cancelled';
    if (!admissionRejected) {
      preservation.acknowledge();
      input.onAcknowledged?.();
    }
    if (admission !== undefined) {
      this.setDurableIngress([
        ...(this.shell.durableIngress ?? []).filter((item) => item.prompt_id !== result.prompt_id),
        result,
      ], agentId);
    }
    const settled = this.settledSteerOutcome(agentId, result.prompt_id);
    if (settled !== undefined) {
      this.reconcileSteerOutcome(agentId, promptId, settled);
      return { promptId: result.prompt_id, outcome: settled };
    }
    if (admissionRejected) {
      this.clearPendingSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: admission };
    }
    if (admission === 'restoring' || admission === 'waiting_switch' || admission === 'held') {
      if (admission !== 'held') this.observeDurableSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: admission === 'waiting_switch' ? 'restoring' : admission };
    }
    if (durable || result.delivery_state !== undefined) {
      const outcome = result.delivery_state ?? (result.status === 'queued' ? 'queued' : 'started');
      const retained = this.findPendingSteer(agentId, promptId);
      if (outcome === 'accepted' || outcome === 'steered') {
        if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
      } else if (outcome !== 'started') this.clearPendingSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome, reason: result.delivery_reason };
    }
    if (result.status !== 'queued') {
      // Idle by the time it landed: the prompt opened its own turn, which is
      // an ordinary send — the projection owns the row from here.
      this.clearPendingSteer(agentId, promptId);
      return { promptId: result.prompt_id, outcome: 'started' };
    }
    try {
      const delivery = await this.client.steerPrompt(this.sessionId, result.prompt_id, agentId);
      const outcome = this.settledSteerOutcome(agentId, result.prompt_id);
      if (outcome !== undefined || delivery.delivery_state === 'queued') {
        this.reconcileSteerOutcome(agentId, promptId, outcome);
        return { promptId: result.prompt_id, outcome: outcome ?? 'queued', reason: outcome === undefined ? delivery.delivery_reason : undefined };
      }
      if (!delivery.steered) {
        this.clearPendingSteer(agentId, promptId);
        await this.resync();
        const disposition = this.settledSteerOutcome(agentId, result.prompt_id);
        return { promptId: result.prompt_id, outcome: disposition ?? 'not_pending', reason: disposition === undefined ? delivery.delivery_reason ?? 'prompt_no_longer_pending' : undefined };
      }
    } catch (error) {
      const outcome = this.settledSteerOutcome(agentId, result.prompt_id);
      this.reconcileSteerOutcome(agentId, promptId, outcome);
      if (outcome !== undefined) return { promptId: result.prompt_id, outcome };
      if (error instanceof ApiError && error.code === API_CODES.PROMPT_NOT_FOUND) {
        await this.resync();
        const disposition = this.settledSteerOutcome(agentId, result.prompt_id);
        if (disposition !== undefined) return { promptId: result.prompt_id, outcome: disposition };
        return { promptId: result.prompt_id, outcome: 'not_pending', reason: 'prompt_no_longer_pending' };
      }
      if (error instanceof ApiError && error.code === API_CODES.REQUEST_INVALID) {
        // Refused before it left the queue (it changes a mode, which needs a
        // turn of its own): only a confirmed withdrawal makes it safe for the
        // caller to hand the text back. A failed withdrawal leaves the prompt
        // queued, so its outcome is unknown and it must not be re-sent.
        let withdrawn: Awaited<ReturnType<SessionTransport['abortPrompt']>>;
        try {
          withdrawn = await this.client.abortPrompt(this.sessionId, result.prompt_id, agentId, true);
        } catch (abortError) {
          throw new SendNowError('unknown', abortError);
        }
        if (withdrawn.aborted === true) throw new SendNowError('refused', error);
        let canonical: NonNullable<AgentTranscriptResponse['prompts']>[number] | undefined;
        try {
          canonical = (await this.view.transcript.page({ agentId })).prompts?.find((item) => item.promptId === result.prompt_id);
        } catch (readError) {
          throw new SendNowError('unknown', readError);
        }
        if (canonical?.status === 'running' || canonical?.status === 'completed') {
          return { promptId: result.prompt_id, outcome: canonical.steeredAt === undefined ? 'started' : 'steered' };
        }
        throw new SendNowError('unknown', error);
      }
      // Outcome unknown: it may already be in the turn. Never withdraw it.
      throw new SendNowError('unknown', error);
    }
    const accepted = this.findPendingSteer(agentId, promptId);
    if (accepted !== undefined) this.setPendingSteer(agentId, { ...accepted, phase: 'waiting' });
    return { promptId: result.prompt_id, outcome: 'steered' };
  }

  private settledSteerOutcome(agentId: string, promptId: string): 'steered' | 'started' | 'failed' | 'cancelled' | undefined {
    const canonical = this.timelines.get(agentId)?.store?.getPrompt(promptId);
    if (canonical === undefined || canonical.status === 'queued') return undefined;
    if (canonical.status === 'aborted') return 'cancelled';
    if (canonical.status === 'failed' || canonical.status === 'blocked') return 'failed';
    if (canonical.steeredAt !== undefined) return 'steered';
    return 'started';
  }

  private reconcileSteerOutcome(agentId: string, promptId: string, outcome: ReturnType<SessionController['settledSteerOutcome']>): void {
    if (outcome !== 'steered') {
      this.clearPendingSteer(agentId, promptId);
      return;
    }
    const retained = this.findPendingSteer(agentId, promptId);
    if (retained !== undefined) this.setPendingSteer(agentId, { ...retained, phase: 'waiting' });
  }

  private findPendingSteer(agentId: string, promptId: string): PendingSteer | undefined {
    return this.timelines.get(agentId)?.steers.find((steer) => steer.promptId === promptId);
  }

  private setPendingSteer(agentId: string, steer: PendingSteer): void {
    const timeline = this.timeline(agentId);
    const current = timeline.steers;
    const index = current.findIndex((entry) => entry.promptId === steer.promptId);
    timeline.steers = index < 0
      ? [...current, steer]
      : current.map((entry, at) => (at === index ? steer : entry));
    this.republishSteers(agentId);
  }

  private clearPendingSteer(agentId: string, promptId: string): void {
    const timeline = this.timelines.get(agentId);
    if (timeline === undefined || !timeline.steers.some((steer) => steer.promptId === promptId)) return;
    timeline.steers = timeline.steers.filter((steer) => steer.promptId !== promptId);
    this.republishSteers(agentId);
  }

  private adoptAcceptedSteers(agentId: string, next: SessionViewState): void {
    const store = this.timelines.get(agentId)?.store;
    if (store === undefined) return;
    let steers = this.timelines.get(agentId)?.steers ?? [];
    for (const id of next.queuedPromptIds) {
      const prompt = store.getPrompt(id);
      if (!prompt?.steerAccepted || prompt.status !== 'queued') continue;
      const existing = steers.find(item => item.promptId === prompt.promptId);
      if (existing !== undefined) {
        if (existing.phase !== 'waiting') steers = steers.map(item => item === existing ? { ...item, phase: 'waiting' } : item);
        continue;
      }
      const row = next.blocks.find(block => block.kind === 'user' && block.promptId === prompt.promptId && block.promptStatus === 'queued');
      if (row?.kind !== 'user') continue;
      steers = [...steers, { promptId: prompt.promptId, userMessageId: row.userMessageId, text: row.text,
        presentation: row.presentation, media: row.media, createdAt: row.createdAt, phase: 'waiting' }];
    }
    if (steers.length > 0) this.timeline(agentId).steers = steers;
  }

  /** Drop echoes once the projection owns delivery or refusal. */
  private retireSettledSteers(agentId: string, next: SessionViewState): void {
    const timeline = this.timelines.get(agentId);
    const current = timeline?.steers ?? [];
    if (timeline === undefined || current.length === 0) return;
    const store = this.timelines.get(agentId)?.store;
    const live = current.filter(steer => {
      const prompt = store?.getPrompt(steer.promptId);
      return prompt?.status !== 'blocked' && !(prompt?.status === 'aborted' && prompt.abortedBeforeStart) && !isSteerSettled(next.blocks, steer);
    });
    if (live.length === current.length) return;
    timeline.steers = live;
  }

  /** Re-publish an agent's view with its current echoes (no transcript change). */
  private republishSteers(agentId: string): void {
    if (this.closed) return;
    const view = this.viewOf(agentId);
    this.publishView(agentId, { ...view, version: view.version + 1 });
  }

  /** Clear the whole queue: the wire has no bulk-remove route, so abort each
   * parked prompt; one reconcile at the end repaints the strip. Failed ids stay
   * queued so the user can retry. */
  async clearQueue(): Promise<{ total: number; failed: number }> {
    const ids = this.viewOf(MAIN_AGENT_ID).queuedPromptIds;
    if (ids.length === 0) return { total: 0, failed: 0 };
    const results = await Promise.allSettled(
      ids.map((promptId) => this.abortPrompt(promptId)),
    );
    await this.refreshPrompts();
    return {
      total: ids.length,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    selectedOptionId?: string,
    /** Plan review: the reviewer's note and the chosen review option (`Revise`, `Reject and Exit`). */
    review?: { readonly feedback?: string; readonly selectedLabel?: string },
  ): Promise<void> {
    const resolvedAt = new Date().toISOString();
    try {
      await this.client.resolveApproval(this.sessionId, approvalId, {
        decision,
        scope,
        selected_option_id: selectedOptionId,
        ...(review?.feedback === undefined ? {} : { feedback: review.feedback }),
        ...(review?.selectedLabel === undefined ? {} : { selected_label: review.selectedLabel }),
      });
      this.markApprovalInViews(approvalId, { decision, resolvedAt });
    } catch (error) {
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
        this.markApprovalInViews(approvalId, { decision: 'resolved_elsewhere', resolvedAt });
        return;
      }
      if (error instanceof ApiError && error.code === API_CODES.APPROVAL_EXPIRED) {
        this.markApprovalInViews(approvalId, { decision: 'expired', resolvedAt });
        return;
      }
      throw error;
    }
  }

  /** Mark an approval resolved in every view that shows it: the owning agent's, whichever that is. */
  private markApprovalInViews(approvalId: string, resolution: Parameters<typeof markApprovalResolved>[2]): void {
    for (const { agentId, view } of this.timelines.values()) {
      if (view !== undefined) this.publishView(agentId, markApprovalResolved(view, approvalId, resolution));
    }
  }

  private readonly questionOutcomes = new Map<string, QuestionOutcome>();

  private questionBlock(questionId: string) {
    const block = [...this.timelines.values()].flatMap((timeline) => timeline.view?.blocks ?? [])
      .find((entry) => entry.kind === 'question' && entry.request.question_id === questionId);
    if (block?.kind !== 'question') return undefined;
    if (block.request.session_id !== '' && block.request.session_id !== this.sessionId) {
      throw new Error('The question belongs to a different session.');
    }
    return block;
  }

  private setQuestionOutcome(questionId: string, outcome: QuestionOutcome): void {
    this.questionOutcomes.set(questionId, outcome);
    for (const { agentId, view } of this.timelines.values()) {
      if (view === undefined) continue;
      const updated = markQuestionOutcome(view, questionId, outcome);
      if (updated !== view) this.publishView(agentId, updated);
    }
  }

  private async reconcileQuestionOutcome(questionId: string, fallback: QuestionOutcome): Promise<void> {
    const block = this.questionBlock(questionId);
    this.setQuestionOutcome(questionId, fallback);
    try {
      const page = await this.view.transcript.page({ agentId: block?.originAgentId ?? MAIN_AGENT_ID, pageSize: 1 });
      if (this.closed) return;
      const interaction = page.interactions?.find((entry) => entry.interactionId === questionId);
      const outcome = interaction === undefined ? undefined : interactionToBlock(interaction, page.agent_id);
      if (outcome?.kind === 'question' && outcome.outcome !== undefined) {
        this.setQuestionOutcome(questionId, outcome.outcome);
      }
    } catch {
      // Keep the terminal REST outcome when a refresh is unavailable.
    }
  }

  private async handleQuestionError(questionId: string, error: unknown): Promise<boolean> {
    if (!(error instanceof ApiError)) return false;
    const at = new Date().toISOString();
    if (error.code === API_CODES.APPROVAL_ALREADY_RESOLVED) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'resolvedElsewhere', at });
      return true;
    }
    if (error.code === API_CODES.QUESTION_NOT_FOUND || error.code === API_CODES.SESSION_NOT_FOUND) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'unavailable', at });
      return true;
    }
    if (error.code === API_CODES.QUESTION_EXPIRED) {
      await this.reconcileQuestionOutcome(questionId, { kind: 'expired' });
      return true;
    }
    return false;
  }

  async answerQuestion(questionId: string, answers: QuestionResponse['answers']): Promise<void> {
    const block = this.questionBlock(questionId);
    if (block?.outcome !== undefined) return;
    const at = new Date().toISOString();
    try {
      await this.client.resolveQuestion(this.sessionId, questionId, { answers, method: 'click' });
      const texts = block === undefined ? undefined : questionAnswerTexts(block.request.questions, answers);
      this.setQuestionOutcome(questionId, { kind: 'answered', at, answers: texts });
    } catch (error) {
      if (!await this.handleQuestionError(questionId, error)) throw error;
    }
  }

  async dismissQuestion(questionId: string): Promise<void> {
    const block = this.questionBlock(questionId);
    if (block?.outcome !== undefined) return;
    const at = new Date().toISOString();
    try {
      await this.client.dismissQuestion(this.sessionId, questionId);
      this.setQuestionOutcome(questionId, { kind: 'dismissed', at });
    } catch (error) {
      if (!await this.handleQuestionError(questionId, error)) throw error;
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.client.cancelTask(this.sessionId, taskId);
    } finally {
      await this.refreshTasks();
    }
  }
}

function opsAffectForest(ops: readonly TranscriptOperation[]): boolean {
  return ops.some((op) => {
    switch (op.op) {
      case 'reset':
      case 'tool.count.set':
      case 'task.upsert':
      case 'meta.merge':
      case 'turn.upsert':
      case 'step.upsert':
      case 'frame.upsert':
      case 'frame.remove':
      case 'items.remove':
        return true;
      default:
        return false;
    }
  });
}

/**
 * Agent ids a batch of transcript ops introduces as subagents: the spawned
 * agent's task row and the dispatch tool frame's `agentRef`s. Ids may repeat
 * across batches, so callers dedupe.
 */
function subagentAgentsInOps(ops: readonly TranscriptOperation[]): readonly string[] {
  const agentIds: string[] = [];
  for (const op of ops) {
    if (op.op === 'task.upsert') {
      if (op.task.kind === 'subagent' && op.task.agentId !== undefined && op.task.agentId !== '') {
        agentIds.push(op.task.agentId);
      }
      continue;
    }
    if (op.op === 'frame.upsert') {
      if (op.frame.kind !== 'tool') continue;
      for (const ref of op.frame.agentRefs ?? []) {
        if (ref.agentId !== '') agentIds.push(ref.agentId);
      }
    }
  }
  return agentIds;
}

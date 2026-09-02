import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  ISessionIndex,
  ISessionMetadata,
  followSessionLifecycles,
  getLiveSessionById,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';
import {
  AgentTranscript,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  isPlainAgentId,
  type AgentDescriptor,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptCursor,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import {
  bindSessionTranscript,
  descriptorFromMeta,
  readWireRecords,
  type TranscriptBinding,
  type TranscriptBindingLogger,
} from '@kiki/transcript-live';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const MAIN_AGENT_ID = 'main';
const WIRE_FILE = 'wire.jsonl';
const STATE_FILE = 'state.json';

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  readonly ready: Promise<void>;
  readonly agentBackfills: Map<string, Promise<void>>;
  readonly opsJournals: Map<string, AgentOpsJournal>;
  readonly agentToolCallStates: Map<string, MaterializedAgentToolCallState>;
  readonly agentDisposal: IDisposable;
}

interface MaterializedAgentToolCallState {
  readonly toolFrameIdsByTurn: Map<string, Set<string>>;
  toolCallCount: number;
}

interface AgentOpsJournal {
  epoch: string;
  nextSeq: number;
  batches: { seq: number; ops: TranscriptOperation[] }[];
}

type TranscriptOpsListener = (event: TranscriptChangeEvent, cursor: TranscriptCursor) => void;

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

export interface TranscriptOpsCatchup {
  readonly epoch: string;
  readonly batches: readonly {
    readonly seq: number;
    readonly ops: readonly TranscriptOperation[];
  }[];
  readonly throughSeq: number;
  readonly complete: boolean;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<string, Set<TranscriptOpsListener>>();

  constructor(private readonly deps: TranscriptServiceDeps) {
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.dropSession(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.dropSession(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(sessionId: string): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.store;
      }
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId);
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(
        store,
        session,
        this.deps.logger,
        (event) => this.handleLiveOps(sessionId, event),
        true,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    this.live.set(sessionId, {
      store,
      binding,
      ready: (async () => {
        await this.backfillMain(sessionId, store);
        if (this.live.get(sessionId)?.store === store) {
          binding.seedRunningTasks(MAIN_AGENT_ID);
          binding.seedPendingInteractions(MAIN_AGENT_ID);
          binding.seedPrompts(MAIN_AGENT_ID);
        }
      })(),
      agentBackfills: new Map(),
      opsJournals: new Map(),
      agentToolCallStates: new Map(),
      agentDisposal: session.accessor
        .get(IAgentLifecycleService)
        .onDidDispose((agentId) => this.evictAgent(sessionId, store, agentId)),
    });
    return store;
  }

  /**
   * A released subagent keeps its roster entry, but its in-memory transcript,
   * ops journal, and backfill marker go away with the engine scope; the next
   * read rebuilds them from the persisted wire.
   */
  private evictAgent(sessionId: string, store: TranscriptStore, agentId: string): void {
    if (agentId === MAIN_AGENT_ID) return;
    const entry = this.live.get(sessionId);
    if (entry === undefined || entry.store !== store) return;
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session?.accessor.get(IAgentLifecycleService).get(agentId) !== undefined) return;
    entry.agentBackfills.delete(agentId);
    entry.opsJournals.delete(agentId);
    entry.agentToolCallStates.delete(agentId);
    store.evictAgentTranscript(agentId);
  }

  /**
   * Resolves when the session's initial history backfill has landed (or
   * immediately when the session has no live store). Full-read consumers
   * (REST route, WS subscribe) await this so the first answer carries the
   * established main-agent transcript.
   */
  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  /**
   * Ensure one agent's persisted history is replayed into the live store
   * (idempotent per agent; the main agent is already covered by the initial
   * backfill). Awaited by full-read consumers for the `agent_id` they serve,
   * so any agent's transcript — including subagents that are not
   * materialized in this process — comes back established.
   */
  async ensureAgentHistory(sessionId: string, agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return this.whenReady(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    await entry.ready;
    let backfill = entry.agentBackfills.get(agentId);
    if (backfill === undefined) {
      backfill = this.backfillAgent(sessionId, entry.store, agentId);
      entry.agentBackfills.set(agentId, backfill);
    }
    await backfill;
    if (this.live.get(sessionId)?.store === entry.store) {
      entry.binding.seedRunningTasks(agentId);
      entry.binding.seedPendingInteractions(agentId);
      entry.binding.seedPrompts(agentId);
    }
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(sessionId: string, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID);
    if (this.live.get(sessionId)?.store !== store) return;
    try {
      const session = getLiveSessionById(this.deps.core.accessor, sessionId);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {
    }
  }

  private liveActiveTurnId(sessionId: string, agentId: string): string | undefined {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const view: IAgentActivityView | undefined = agent?.accessor.get(IAgentActivityView);
    const turnId = view?.state().turn?.turnId;
    return turnId === undefined ? undefined : `t${turnId}`;
  }

  private liveActiveTurnIds(
    sessionId: string,
    agentId: string,
    initialTurnId: string | undefined,
  ): string[] {
    const currentTurnId = this.liveActiveTurnId(sessionId, agentId);
    if (initialTurnId === undefined) return currentTurnId === undefined ? [] : [currentTurnId];
    if (currentTurnId === undefined || currentTurnId === initialTurnId) return [initialTurnId];
    return [initialTurnId, currentTurnId];
  }

  /**
   * Replay one agent's persisted wire records into its transcript. Everything
   * is an idempotent upsert (never `reset`), so live ops arriving while the
   * records are read from disk survive the merge; turn ordinals assigned by
   * the rebuild are 0-based like the engine's, so future live turns continue
   * without colliding.
   */
  private async backfillAgent(sessionId: string, store: TranscriptStore, agentId: string): Promise<void> {
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(
        sessionId,
        agentId,
        () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
      );
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    const entry = this.live.get(sessionId);
    if (entry?.store !== store) return;
    const transcript = store.ensureAgent(agentId);
    if (snapshot !== undefined) {
      const result = transcript.apply(snapshotToOps(snapshot));
      if (result.gap !== undefined) {
        this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
      }
      if (result.accepted.length > 0) {
        this.dispatchOps(sessionId, { agentId, ops: result.accepted });
      }
    }
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
    if (!entry.agentToolCallStates.has(agentId)) {
      entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot(transcript.snapshot()));
    }
    entry.binding.finishReplay(agentId);
  }

  onSessionOps(sessionId: string, listener: TranscriptOpsListener): IDisposable | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    let listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(sessionId);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(sessionId);
      },
    };
  }

  private dispatchOps(sessionId: string, event: TranscriptChangeEvent): void {
    const cursor = this.journalOps(sessionId, event);
    if (cursor === undefined) return;
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, cursor);
      } catch {
      }
    }
  }

  private journalFor(sessionId: string, agentId: string): AgentOpsJournal | undefined {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return undefined;
    let journal = entry.opsJournals.get(agentId);
    if (journal === undefined) {
      journal = { epoch: randomUUID(), nextSeq: 1, batches: [] };
      entry.opsJournals.set(agentId, journal);
    }
    return journal;
  }

  private journalOps(sessionId: string, event: TranscriptChangeEvent): TranscriptCursor | undefined {
    if (event.ops.length === 0) return undefined;
    const journal = this.journalFor(sessionId, event.agentId);
    if (journal === undefined) return undefined;
    const seq = journal.nextSeq++;
    journal.batches.push({ seq, ops: [...event.ops] });
    if (journal.batches.length > TRANSCRIPT_OPS_JOURNAL_CAPACITY) journal.batches.shift();
    return { epoch: journal.epoch, seq };
  }

  getTranscriptCursor(sessionId: string, agentId: string): TranscriptCursor {
    const journal = this.journalFor(sessionId, agentId);
    return journal === undefined
      ? { epoch: undefined, seq: 0 }
      : { epoch: journal.epoch, seq: journal.nextSeq - 1 };
  }

  getSeqWatermark(sessionId: string, agentId: string): number {
    return this.getTranscriptCursor(sessionId, agentId).seq;
  }

  getOpsSince(
    sessionId: string,
    agentId: string,
    sinceInput: TranscriptCursor | number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    const journal = this.journalFor(sessionId, agentId);
    if (journal === undefined) return undefined;
    const since = typeof sinceInput === 'number' ? { epoch: undefined, seq: sinceInput } : sinceInput;
    const throughSeq = journal.nextSeq - 1;
    if ((since.epoch !== undefined && since.epoch !== journal.epoch) || since.seq > throughSeq) {
      return { epoch: journal.epoch, batches: [], throughSeq, complete: false };
    }
    const retained = journal.batches.filter((batch) => batch.seq > since.seq);
    const oldest = journal.batches[0]?.seq;
    const complete =
      since.seq === throughSeq ||
      (retained.length > 0 && oldest !== undefined && oldest <= since.seq + 1);
    const batches = retained.map((batch) => ({ seq: batch.seq, ops: batch.ops }));
    return { epoch: journal.epoch, batches, throughSeq, complete };
  }

  private handleLiveOps(sessionId: string, event: TranscriptChangeEvent): void {
    const entry = this.live.get(sessionId);
    if (entry !== undefined) {
      let state = entry.agentToolCallStates.get(event.agentId);
      if (state === undefined) {
        const transcript = entry.store.getAgent(event.agentId);
        if (transcript !== undefined) {
          state = toolCallStateFromSnapshot(transcript.snapshot());
          entry.agentToolCallStates.set(event.agentId, state);
        }
      } else {
        applyToolCallOps(state, event.ops);
      }
    }
    this.dispatchOps(sessionId, event);
  }

  getMaterializedAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    const entry = this.live.get(sessionId);
    if (entry === undefined) return result;
    for (const agentId of new Set(agentIds)) {
      const state = entry.agentToolCallStates.get(agentId);
      if (state === undefined) continue;
      result.set(agentId, state.toolCallCount);
    }
    return result;
  }

  async getAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const uniqueAgentIds = [...new Set(agentIds)];
    const counts = new Map<string, number>();
    const store = this.forSessionLive(sessionId);
    if (store !== undefined) {
      await this.whenReady(sessionId);
      await Promise.all(uniqueAgentIds.map((agentId) => this.ensureAgentHistory(sessionId, agentId)));
      for (const agentId of uniqueAgentIds) {
        counts.set(agentId, countToolCallFrames(store.getAgent(agentId)?.getItems() ?? []));
      }
      return counts;
    }
    await Promise.all(
      uniqueAgentIds.map(async (agentId) => {
        const snapshot = await this.readColdSnapshot(sessionId, agentId);
        counts.set(agentId, countToolCallFrames(snapshot?.items ?? []));
      }),
    );
    return counts;
  }

  /**
   * Roster for a cold session, read from the persisted session metadata
   * (`<sessionDir>/state.json`) and mapped like the live seeding
   * (`descriptorFromMeta`). Returns `undefined` when the session is unknown
   * to the index; an unreadable or missing metadata file yields an empty
   * roster (best-effort — transcripts work without descriptors).
   */
  async readColdRoster(sessionId: string): Promise<AgentDescriptor[] | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    let meta: SessionMeta;
    try {
      const raw = await readFile(
        join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE),
        'utf-8',
      );
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      return [];
    }
    return Object.entries(meta.agents ?? {}).map(([agentId, agentMeta]) =>
      descriptorFromMeta(agentId, agentMeta),
    );
  }

  /**
   * Rebuild one agent's transcript snapshot for a cold session from its
   * persisted wire records. Returns `undefined` when the session is unknown to
   * the index; a known session without wire records for the agent yields an
   * empty snapshot.
   */
  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
    preserveOpenTurnIds?: () => readonly string[],
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) return emptySnapshot();
    const wirePath = join(
      this.deps.homeDir,
      SESSIONS_ROOT,
      summary.workspaceId,
      sessionId,
      AGENTS_DIR,
      agentId,
      WIRE_FILE,
    );
    let records: Awaited<ReturnType<typeof readWireRecords>>;
    try {
      records = await readWireRecords(wirePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      throw error;
    }
    const transcript = new AgentTranscript(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId, {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => {
        for (const item of transcript.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            const frame = step.frames.find(
              (candidate) => candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
            );
            if (frame?.kind === 'tool') return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
        return undefined;
      },
    });
    for (const record of records) reducer.apply(adapter.add(record));
    const preservedTurns: TranscriptTurn[] = [];
    for (const turnId of preserveOpenTurnIds?.() ?? []) {
      const candidate = transcript.getTurn(turnId);
      if (candidate?.state === 'running') preservedTurns.push(structuredClone(candidate));
    }
    reducer.apply(adapter.finish());
    for (const turn of preservedTurns) transcript.apply(snapshotTurnOps(turn));
    return transcript.snapshot();
  }

  async reconcileAfterRewrite(sessionId: string, agentId: string = MAIN_AGENT_ID): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    const snapshot = await this.readColdSnapshot(
      sessionId,
      agentId,
      () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
    );
    if (snapshot === undefined || this.live.get(sessionId) !== entry) return;
    entry.store.ensureAgent(agentId).apply([
      {
        op: 'reset',
        agentId,
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot,
      },
    ]);
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot(snapshot));
    entry.opsJournals.set(agentId, { epoch: randomUUID(), nextSeq: 1, batches: [] });
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(sessionId: string): void {
    this.opsListeners.delete(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    entry.agentDisposal.dispose();
    entry.binding.dispose();
  }
}

export function countToolCallFrames(items: AgentTranscriptSnapshot['items']): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      count += step.frames.filter((frame) => frame.kind === 'tool').length;
    }
  }
  return count;
}

function toolCallStateFromSnapshot(
  snapshot: AgentTranscriptSnapshot,
): MaterializedAgentToolCallState {
  const toolCallState: MaterializedAgentToolCallState = {
    toolFrameIdsByTurn: new Map(),
    toolCallCount: 0,
  };
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') {
          addToolFrame(toolCallState, item.turnId, step.stepId, frame.frameId);
        }
      }
    }
  }
  return toolCallState;
}

function applyToolCallOps(
  toolCallState: MaterializedAgentToolCallState,
  ops: readonly TranscriptOperation[],
): void {
  for (const op of ops) {
    if (op.op === 'reset') {
      const replacement = toolCallStateFromSnapshot(op.snapshot);
      toolCallState.toolFrameIdsByTurn.clear();
      for (const [turnId, frameIds] of replacement.toolFrameIdsByTurn) {
        toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
      }
      toolCallState.toolCallCount = replacement.toolCallCount;
    } else if (op.op === 'frame.upsert') {
      if (op.frame.kind === 'tool') {
        addToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      } else {
        removeToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      }
    } else if (op.op === 'items.remove') {
      for (const itemId of op.ids) removeToolTurn(toolCallState, itemId);
    }
  }
}

function addToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  let frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) {
    frameIds = new Set();
    toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
  }
  const key = `${stepId}\0${frameId}`;
  if (frameIds.has(key)) return;
  frameIds.add(key);
  toolCallState.toolCallCount += 1;
}

function removeToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  if (!frameIds.delete(`${stepId}\0${frameId}`)) return;
  toolCallState.toolCallCount -= 1;
  if (frameIds.size === 0) toolCallState.toolFrameIdsByTurn.delete(turnId);
}

function removeToolTurn(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  toolCallState.toolCallCount -= frameIds.size;
  toolCallState.toolFrameIdsByTurn.delete(turnId);
}

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read. Global attachment entities flatten
 * too — without them a backfilled turn's `attachmentIds` would dangle.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  for (const interaction of snapshot.interactions) {
    ops.push({ op: 'interaction.upsert', interaction });
  }
  for (const todo of snapshot.todos) {
    ops.push({ op: 'todo.upsert', todo });
  }
  for (const prompt of snapshot.prompts) {
    ops.push({ op: 'prompt.upsert', prompt });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

function emptySnapshot(): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
  };
}

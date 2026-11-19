/**
 * Resume replay fold — rebuilds an agent's `replay` / `toolStore` pair from its
 * `wire.jsonl`.
 *
 * The engine persists each agent's journal at
 * `<sessionDir>/agents/<agentId>/wire.jsonl`. This module folds that journal
 * directly: it streams the records in order, mirrors just enough context state to
 * decide what the UI transcript looks like, and emits the replay records hosts
 * render. There is no engine instance behind it — the wire is the contract.
 *
 * Message assembly reuses the engine's own `createLoopEventFold`, so the
 * subtleties stay in one place: `step.begin` opens an assistant message,
 * `content.part` / `tool.call` mutate it, `tool.result` closes the exchange, a
 * step boundary closes tool calls left unresolved mid-history with synthesized
 * interrupted results, messages arriving behind an open tool exchange are
 * deferred and flushed in order, and a step that produced nothing but vacuous
 * content is dropped.
 */

import { openPersistedJournal } from '#/retained-session';

import {
  applyContextCompactionRecord,
  computeUndoCut,
  createLoopEventFold,
  isFullyUndoable,
  isNewerWireVersion,
  migrateWireRecord,
  readContextCompactedCount,
  resolveWireMigrations,
  type ContentPart,
  type ContextMessage,
  type GoalBudgetLimits,
  type GoalBudgetReport,
  type GoalChange,
  type GoalSnapshot,
  type GoalStatus,
  type LoopEventFoldSink,
  type ToolCall,
  type WireMigration,
  type WireMigrationRecord,
  type WireRecord,
} from '@kiki/agent-core-v2';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '#/protocol';
import type { AgentRecord } from '#/wire/records';

/** A complete `wire.jsonl` line the fold could not use, located by its byte offset. */
export interface SkippedWireRecord {
  readonly offset: number;
  readonly reason: string;
}

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
  /** Corrupt complete lines that were skipped (or that stopped the fold); absent when none. */
  readonly skippedRecords?: readonly SkippedWireRecord[];
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };
const STREAM_CHUNK_BYTES = 256 * 1024;

class MalformedWireRecordError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'MalformedWireRecordError';
  }
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head);
  joined.set(tail, head.byteLength);
  return joined;
}

function withSkipped(
  folded: FoldedAgentReplay,
  skipped: readonly SkippedWireRecord[],
): FoldedAgentReplay {
  return skipped.length === 0 ? folded : { ...folded, skippedRecords: skipped };
}

/**
 * Fold one agent's `wire.jsonl` into replay records and a tool-store snapshot
 * by streaming bounded chunks without materializing a single whole-file
 * string. Lines are split on raw bytes so reported offsets match the file even
 * around invalid UTF-8. Missing or empty journals yield an empty fold and a
 * truncated trailing line is tolerated silently. A corrupt complete line (invalid JSON or
 * a non-object record) is skipped and reported in `skippedRecords` with its
 * byte offset while the rest of the journal still folds; a journal whose first
 * record is not `metadata` cannot be migrated and yields an empty fold that
 * reports the offending line. Storage/segment corruption and I/O errors
 * propagate.
 */
export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  let journal: Awaited<ReturnType<typeof openPersistedJournal>>;
  const skipped: SkippedWireRecord[] = [];
  try {
    journal = await openPersistedJournal(wirePath);
    if (journal === undefined || journal.size === 0) return EMPTY_FOLD;
    const decoder = new TextDecoder('utf-8');
    const fold = new ReplayFold();
    let carry: Uint8Array = new Uint8Array(0);
    let carryOffset = 0;
    let offset = 0;
    while (offset < journal.size) {
      const length = Math.min(STREAM_CHUNK_BYTES, journal.size - offset);
      const chunk = await journal.readAt(offset, length);
      if (chunk.byteLength === 0) break;
      offset += chunk.byteLength;
      const bytes = carry.byteLength === 0 ? chunk : concatBytes(carry, chunk);
      let lineStart = 0;
      for (;;) {
        const nl = bytes.indexOf(0x0a, lineStart);
        if (nl === -1) break;
        const lineOffset = carryOffset + lineStart;
        const rawLine = decoder.decode(bytes.subarray(lineStart, nl));
        lineStart = nl + 1;
        const reason = consumeCompleteWireLine(fold, rawLine, lineOffset);
        if (reason !== undefined) skipped.push({ offset: lineOffset, reason });
      }
      carry = new Uint8Array(bytes.subarray(lineStart));
      carryOffset += lineStart;
    }
    if (carry.byteLength > 0) {
      consumeTrailingWireLine(fold, decoder.decode(carry), carryOffset);
    }
    return withSkipped(fold.finish(), skipped);
  } catch (error) {
    if (error instanceof MalformedWireRecordError) {
      return withSkipped(EMPTY_FOLD, [
        ...skipped,
        { offset: error.offset, reason: error.message },
      ]);
    }
    throw error;
  } finally {
    await journal?.close().catch(() => undefined);
  }
}

/** Folds one complete line, returning the reason it was skipped when it is corrupt. */
function consumeCompleteWireLine(
  fold: ReplayFold,
  rawLine: string,
  offset: number,
): string | undefined {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'invalid JSON wire record';
  }
  if (!isRecordObject(parsed)) return 'wire record is not an object';
  fold.add(parsed, offset);
  return undefined;
}

function consumeTrailingWireLine(fold: ReplayFold, rawLine: string, offset: number): void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (isRecordObject(parsed)) fold.add(parsed, offset);
}

function isRecordObject(value: unknown): value is AgentRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The mirrored goal state a `goal_updated` snapshot is derived from. */
interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
}

type MutableReplayRecord = { time: number } & AgentReplayRecordPayload;

type MutableContextMessage = ContextMessage & {
  content: ContentPart[];
  toolCalls: ToolCall[];
  partial?: boolean;
};

class ReplayFold {
  private readonly replay: MutableReplayRecord[] = [];
  private readonly toolStore: Record<string, unknown> = {};
  private history: MutableContextMessage[] = [];
  private openAssistant: MutableContextMessage | undefined;
  private goal: GoalState | undefined;
  private migrations: readonly WireMigration[] | undefined;
  private sawFirstRecord = false;
  private now = Date.now();

  private readonly sink: LoopEventFoldSink = {
    openAssistant: () => {
      const message: MutableContextMessage = {
        role: 'assistant',
        content: [],
        toolCalls: [],
        partial: true,
      };
      this.openAssistant = message;
      this.pushHistory(message);
    },
    appendOpenContent: (part) => {
      this.openAssistant?.content.push(part);
    },
    appendOpenToolCall: (call) => {
      this.openAssistant?.toolCalls.push(call);
    },
    dropOpenAssistant: () => {
      const message = this.openAssistant;
      this.openAssistant = undefined;
      if (message === undefined) return;
      this.removeMessages(new Set([message]));
      const index = this.history.indexOf(message);
      if (index !== -1) this.history.splice(index, 1);
    },
    sealOpenAssistant: () => {
      if (this.openAssistant !== undefined) delete this.openAssistant.partial;
      this.openAssistant = undefined;
    },
    pushToolMessage: (message) => {
      this.pushHistory(message as MutableContextMessage);
    },
    pushMessage: (message) => {
      this.pushHistory(message as MutableContextMessage);
    },
  };

  private fold = createLoopEventFold(this.sink);

  add(record: AgentRecord, offset: number): void {
    if (!this.sawFirstRecord) {
      this.sawFirstRecord = true;
      if (record.type !== 'metadata') {
        throw new MalformedWireRecordError(
          'wire replay expected metadata as the first record',
          offset,
        );
      }
      this.migrations = isNewerWireVersion(record.protocol_version)
        ? []
        : resolveWireMigrations(record.protocol_version);
    }
    const migrated = migrateWireRecord(
      record as unknown as WireMigrationRecord,
      this.migrations ?? [],
    ) as unknown as AgentRecord;
    this.now = migrated.time ?? Date.now();
    this.apply(migrated);
  }

  finish(): FoldedAgentReplay {
    if (!this.sawFirstRecord) return EMPTY_FOLD;
    this.fold.settle(this.now);
    return { replay: this.replay, toolStore: this.toolStore };
  }

  private apply(record: AgentRecord): void {
    switch (record.type) {
      case 'context.append_message':
        this.fold.appendMessage(record.message as MutableContextMessage, this.now);
        return;
      case 'context.append_loop_event':
        this.fold.loopEvent(record.event, this.now);
        return;
      case 'context.clear':
        this.history = [];
        this.openAssistant = undefined;
        this.fold.reset();
        return;
      case 'context.undo':
        this.undo(record.count);
        return;
      case 'context.apply_compaction':
        this.applyCompaction(record);
        return;
      case 'full_compaction.begin':
        this.push({ type: 'compaction', instruction: record.instruction });
        return;
      case 'full_compaction.cancel':
        this.patchLastCompaction({ result: 'cancelled' });
        return;
      case 'plan_mode.enter':
        this.push({ type: 'plan_updated', enabled: true });
        return;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        this.push({ type: 'plan_updated', enabled: false });
        return;
      case 'config.update':
        this.push({ type: 'config_updated', config: record });
        return;
      case 'permission.set_mode':
        this.push({ type: 'permission_updated', mode: record.mode });
        return;
      case 'permission.record_approval_result':
        this.push({ type: 'approval_result', record });
        return;
      case 'tools.update_store':
        this.toolStore[record.key] = record.value;
        return;
      case 'goal.create':
        this.goalCreate(record.goalId, record.objective, record.completionCriterion);
        return;
      case 'goal.update':
        this.goalUpdate(record);
        return;
      case 'goal.clear':
        this.goal = undefined;
        return;
      default:
        return;
    }
  }

  private push(payload: AgentReplayRecordPayload): void {
    this.replay.push({ ...payload, time: this.now } as MutableReplayRecord);
  }

  private pushHistory(message: MutableContextMessage): void {
    this.history.push(message);
    this.push({ type: 'message', message });
  }

  private patchLastCompaction(patch: { result: NonNullable<unknown> }): void {
    const last = this.replay.at(-1);
    if (last?.type === 'compaction') Object.assign(last, patch);
  }

  private undo(count: number): void {
    const cut = computeUndoCut(this.history, count);
    if (!isFullyUndoable(cut, count)) return;
    const removed = new Set(this.history.slice(cut.cutIndex));
    this.history = this.history.slice(0, cut.cutIndex);
    this.removeMessages(removed);
    this.restoreFold();
  }

  private removeMessages(removed: ReadonlySet<ContextMessage>): void {
    if (removed.size === 0) return;
    for (let i = this.replay.length - 1; i >= 0; i--) {
      const record = this.replay[i]!;
      if (record.type === 'message' && removed.has(record.message)) {
        this.replay.splice(i, 1);
      }
    }
  }

  private applyCompaction(record: Extract<AgentRecord, { type: 'context.apply_compaction' }>): void {
    const { type: _type, time: _time, ...result } = record;
    this.patchLastCompaction({ result });
    const previous = this.history;
    const wireRecord = record as unknown as WireRecord;
    const compactedCount = readContextCompactedCount(wireRecord);
    const removedTailInjections = new Set(
      previous
        .slice(compactedCount)
        .filter((message) => message.origin?.kind === 'injection'),
    );
    this.history = applyContextCompactionRecord(
      previous,
      wireRecord,
    ) as MutableContextMessage[];
    this.removeMessages(removedTailInjections);
    this.restoreFold();
  }

  private restoreFold(): void {
    this.openAssistant = undefined;
    this.fold = createLoopEventFold(this.sink);
  }

  private goalCreate(goalId: string, objective: string, completionCriterion?: string): void {
    const state: GoalState = {
      goalId,
      objective,
      completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
    };
    this.goal = state;
    this.push({
      type: 'goal_updated',
      snapshot: goalSnapshot(state),
      change: { kind: 'created' },
    });
  }

  private goalUpdate(record: Extract<AgentRecord, { type: 'goal.update' }>): void {
    const state = this.goal;
    if (state === undefined) return;
    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.terminalReason = status === 'active' ? undefined : record.reason;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.wallClockMs !== undefined) state.wallClockMs = record.wallClockMs;
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
    if (status === undefined) return;
    const change: GoalChange =
      status === 'complete'
        ? {
            kind: 'completion',
            status,
            reason: record.reason,
            stats: {
              turnsUsed: state.turnsUsed,
              tokensUsed: state.tokensUsed,
              wallClockMs: state.wallClockMs,
            },
            actor: record.actor,
          }
        : { kind: 'lifecycle', status, reason: record.reason, actor: record.actor };
    this.push({ type: 'goal_updated', snapshot: goalSnapshot(state), change });
  }
}

function goalSnapshot(state: GoalState): GoalSnapshot {
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: state.wallClockMs,
    budget: goalBudgetReport(state),
    terminalReason: state.terminalReason,
  };
}

function goalBudgetReport(state: GoalState): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && state.wallClockMs >= wallClockBudgetMs;
  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - state.wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

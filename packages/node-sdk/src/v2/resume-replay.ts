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

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };
const STREAM_CHUNK_BYTES = 256 * 1024;

class MalformedWireRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedWireRecordError';
  }
}

/**
 * Fold one agent's `wire.jsonl` into replay records and a tool-store snapshot
 * by streaming bounded UTF-8 chunks without materializing a single whole-file
 * string. Missing, empty, or record-malformed journals yield an empty fold
 * (with a truncated trailing line tolerated), while storage/segment corruption
 * and I/O errors propagate.
 */
export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  let journal: Awaited<ReturnType<typeof openPersistedJournal>>;
  try {
    journal = await openPersistedJournal(wirePath);
    if (journal === undefined || journal.size === 0) return EMPTY_FOLD;
    const decoder = new TextDecoder('utf-8');
    const fold = new ReplayFold();
    let carry = '';
    let offset = 0;
    while (offset < journal.size) {
      const length = Math.min(STREAM_CHUNK_BYTES, journal.size - offset);
      const chunk = await journal.readAt(offset, length);
      if (chunk.byteLength === 0) break;
      offset += chunk.byteLength;
      carry += decoder.decode(chunk, { stream: true });
      let lineStart = 0;
      for (;;) {
        const nl = carry.indexOf('\n', lineStart);
        if (nl === -1) break;
        const rawLine = carry.slice(lineStart, nl);
        lineStart = nl + 1;
        consumeCompleteWireLine(fold, rawLine);
      }
      if (lineStart > 0) {
        carry = carry.slice(lineStart);
      }
    }
    carry += decoder.decode();
    if (carry.length > 0) {
      consumeTrailingWireLine(fold, carry);
    }
    return fold.finish();
  } catch (error) {
    if (error instanceof MalformedWireRecordError) return EMPTY_FOLD;
    throw error;
  } finally {
    await journal?.close().catch(() => undefined);
  }
}

function consumeCompleteWireLine(fold: ReplayFold, rawLine: string): void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return;
  let parsed: AgentRecord;
  try {
    parsed = JSON.parse(line) as AgentRecord;
  } catch {
    throw new MalformedWireRecordError('invalid JSON wire record');
  }
  fold.add(parsed);
}

function consumeTrailingWireLine(fold: ReplayFold, rawLine: string): void {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return;
  let parsed: AgentRecord;
  try {
    parsed = JSON.parse(line) as AgentRecord;
  } catch {
    return;
  }
  fold.add(parsed);
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
  inheritedSeed?: boolean;
};

const COMPACTION_ELISION_VARIANT = 'compaction_elision';
const EXTERNAL_TEXT_KINDS = ['note', 'user_excerpt', 'assistant_excerpt', 'handoff'] as const;

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function cloneMutableMessage(message: ContextMessage): MutableContextMessage {
  return {
    ...message,
    content: [...message.content],
    toolCalls: [...(message.toolCalls ?? [])],
  };
}

function isExternalSource(
  value: unknown,
): value is { connectionId: string; clientName: string; sessionRef: string; driver: 'external' } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as { connectionId?: unknown; clientName?: unknown; sessionRef?: unknown; driver?: unknown };
  return (
    typeof source.connectionId === 'string' &&
    source.connectionId.length > 0 &&
    typeof source.clientName === 'string' &&
    source.clientName.length > 0 &&
    typeof source.sessionRef === 'string' &&
    source.sessionRef.length > 0 &&
    source.driver === 'external'
  );
}

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

  add(record: AgentRecord): void {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new MalformedWireRecordError('wire record is not an object');
    }
    if (!this.sawFirstRecord) {
      this.sawFirstRecord = true;
      if (record.type !== 'metadata') {
        throw new MalformedWireRecordError('wire replay expected metadata as the first record');
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
      case 'context.undo': {
        this.undo(record.count);
        const replacement = record.replacementPrompt?.message;
        if (isContextMessageLike(replacement)) {
          this.fold.appendMessage(cloneMutableMessage(replacement), this.now);
        }
        return;
      }
      case 'branch.base':
        for (const message of this.history) {
          message.inheritedSeed = true;
        }
        this.restoreFold();
        return;
      case 'external.text': {
        const recordKind = EXTERNAL_TEXT_KINDS.find((kind) => kind === record.kind);
        if (
          typeof record.recordId !== 'string' ||
          typeof record.text !== 'string' ||
          recordKind === undefined ||
          !isExternalSource(record.source)
        ) {
          return;
        }
        this.fold.appendMessage(
          {
            role: 'user',
            content: [{ type: 'text', text: record.text }],
            toolCalls: [],
            origin: {
              kind: 'external_record',
              recordId: record.recordId,
              recordKind,
              ...(typeof record.title === 'string' ? { title: record.title } : {}),
              ...record.source,
            },
            source: { ref: `external.text:${record.recordId}` },
          },
          this.now,
        );
        return;
      }
      case 'agent.model_switch': {
        const context = record.context;
        if (!Array.isArray(context) || !context.every(isContextMessageLike)) return;
        this.removeMessages(new Set(this.history));
        this.history = [];
        this.restoreFold();
        for (const message of context) {
          this.pushHistory(cloneMutableMessage(message));
        }
        return;
      }
      case 'context.apply_compaction':
        this.applyCompaction(record);
        return;
      case 'full_compaction.begin': {
        const open = this.findOpenCompaction();
        if (open !== undefined) {
          if (record.instruction !== undefined) open.instruction = record.instruction;
          return;
        }
        this.push({ type: 'compaction', instruction: record.instruction });
        return;
      }
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

  private findOpenCompaction(): (MutableReplayRecord & { type: 'compaction'; instruction?: string; result?: unknown }) | undefined {
    for (let i = this.replay.length - 1; i >= 0; i -= 1) {
      const candidate = this.replay[i];
      if (candidate?.type === 'compaction' && candidate.result === undefined) {
        return candidate as MutableReplayRecord & { type: 'compaction'; instruction?: string; result?: unknown };
      }
    }
    return undefined;
  }

  private patchLastCompaction(patch: { result: NonNullable<unknown> }): void {
    const open = this.findOpenCompaction();
    if (open !== undefined) Object.assign(open, patch);
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
    const previousSet = new Set<ContextMessage>(previous);
    const wireRecord = record as unknown as WireRecord;
    const compactedCount = readContextCompactedCount(wireRecord);
    const removedTailInjections = new Set(
      previous
        .slice(compactedCount)
        .filter((message) => message.origin?.kind === 'injection'),
    );
    const next = applyContextCompactionRecord(
      previous,
      wireRecord,
    ) as MutableContextMessage[];
    this.history = next;
    this.removeMessages(removedTailInjections);
    for (const message of next) {
      if (
        !previousSet.has(message) &&
        message.origin?.kind === 'injection' &&
        message.origin.variant === COMPACTION_ELISION_VARIANT
      ) {
        this.push({ type: 'message', message });
      }
    }
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

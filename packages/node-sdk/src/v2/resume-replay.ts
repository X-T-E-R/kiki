/**
 * Resume replay fold — rebuilds an agent's `replay` / `toolStore` pair from its
 * `wire.jsonl`.
 *
 * The engine persists each agent's journal at
 * `<sessionDir>/agents/<agentId>/wire.jsonl`. This module folds that journal
 * directly: it walks the records in order, mirrors just enough context state to
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
 *
 * Record-type → replay-record mapping:
 * - `context.append_message`      → `{type:'message'}` (same for the
 *   assistant/tool messages assembled out of `context.append_loop_event`)
 * - `full_compaction.begin`       → `{type:'compaction', instruction}`;
 *   `context.apply_compaction` patches the last one with `result`;
 *   `full_compaction.cancel` marks it `'cancelled'`
 * - `goal.create` / `goal.update` → `{type:'goal_updated'}` (`created` /
 *   `lifecycle` / `completion` change)
 * - `plan_mode.enter`             → `{type:'plan_updated', enabled:true}`;
 *   `plan_mode.cancel` / `plan_mode.exit` → `enabled:false`
 * - `config.update`               → `{type:'config_updated', config}` (the raw
 *   record fields, including `type`/`time`)
 * - `permission.set_mode`         → `{type:'permission_updated', mode}`
 * - `permission.record_approval_result` → `{type:'approval_result', record}`
 * - `context.undo`                → removes the replay records of the messages
 *   it drops from the live context
 * - `context.clear`               → resets the mirrored context; the replay
 *   records already emitted stay (they are transcript, not context)
 * - `tools.update_store`          → no replay record; last-wins into the tool
 *   store returned alongside
 * - everything else (`metadata`, `turn.*`, `usage.record`, `profile.bind`,
 *   `tools.set_active_tools`, `context.update_token_count`, `task.*`,
 *   `skill.activate`, `interaction.*`, `llm.*`, `mcp.*`) rebuilds no
 *   transcript state. Background tasks in particular do NOT come from this
 *   fold — the caller reads them from the live agent scope.
 *
 * Any failure — missing/corrupt file, newer protocol, unexpected record —
 * degrades to an empty result instead of failing the session resume.
 */

import { readFile } from 'node:fs/promises';

import {
  createLoopEventFold,
  isNewerWireVersion,
  migrateWireRecord,
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
} from '@moonshot-ai/agent-core-v2';
import { isRealUserInput } from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';

import type { AgentReplayRecord, AgentReplayRecordPayload } from '#/protocol';
import type { AgentRecord } from '#/wire/records';

export interface FoldedAgentReplay {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

const EMPTY_FOLD: FoldedAgentReplay = { replay: [], toolStore: {} };

/**
 * Fold one agent's `wire.jsonl` into replay records and a tool-store snapshot.
 * Best-effort: unreadable or malformed journals yield an empty fold, never a
 * rejected resume.
 */
export async function foldAgentWireReplay(wirePath: string): Promise<FoldedAgentReplay> {
  try {
    const records = parseWireRecords(await readFile(wirePath, 'utf-8'));
    if (records.length === 0) return EMPTY_FOLD;
    return new ReplayFold().run(records);
  } catch {
    return EMPTY_FOLD;
  }
}

/**
 * The line reader's rules: blank lines skipped, a truncated TAIL line tolerated
 * (the last write may have crashed mid-flush), corruption anywhere else is an
 * error.
 */
function parseWireRecords(content: string): AgentRecord[] {
  const lines = content.split('\n');
  const records: AgentRecord[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as AgentRecord);
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
  }
  return records;
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

/**
 * A replay record under construction. The records are mutated in place after
 * being appended (a compaction's `result` patch, an assistant message growing
 * content), so the fold keeps them mutable internally and only widens to the
 * readonly public type on the way out.
 */
type MutableReplayRecord = { time: number } & AgentReplayRecordPayload;

/** Assistant/tool messages are mutated in place while their step is open. */
type MutableContextMessage = ContextMessage & {
  content: ContentPart[];
  toolCalls: ToolCall[];
  partial?: boolean | undefined;
};

class ReplayFold {
  private readonly replay: MutableReplayRecord[] = [];
  private readonly toolStore: Record<string, unknown> = {};
  /**
   * The live context mirror. Only used to decide what `context.undo` removes
   * and what survives a compaction — the transcript itself is `replay`.
   */
  private history: MutableContextMessage[] = [];
  private openAssistant: MutableContextMessage | undefined;
  private goal: GoalState | undefined;
  /** The time of the record currently being folded; stamps replay records. */
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
      if (this.openAssistant !== undefined) this.openAssistant.partial = undefined;
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

  run(records: readonly AgentRecord[]): FoldedAgentReplay {
    const first = records[0];
    if (first?.type !== 'metadata') {
      throw new Error('wire replay expected metadata as the first record');
    }
    const migrations: readonly WireMigration[] = isNewerWireVersion(first.protocol_version)
      ? []
      : resolveWireMigrations(first.protocol_version);
    for (const record of records) {
      const migrated = migrateWireRecord(
        record as unknown as WireMigrationRecord,
        migrations,
      ) as unknown as AgentRecord;
      this.now = migrated.time ?? Date.now();
      this.apply(migrated);
    }
    // Close a genuinely interrupted trailing exchange, exactly as a live
    // restore does at the end of resume.
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
        // Every other record rebuilds engine state the transcript does not show.
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

  /**
   * Mirror of the live undo: walk back over the context skipping injections,
   * stop at a compaction summary, and drop messages until `count` real user
   * inputs are gone. The dropped messages' replay records go with them.
   */
  private undo(count: number): void {
    if (count <= 0 || this.history.length === 0) return;
    let removedUserCount = 0;
    const removed = new Set<ContextMessage>();
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      removed.add(message);
      this.history.splice(i, 1);
      if (isRealUserInput(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }
    this.removeMessages(removed);
    this.openAssistant = undefined;
    this.fold.reset();
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

  /**
   * A compaction's outcome patches the `compaction` record it opened, and the
   * mirrored context collapses to the summary message. The kept-verbatim user
   * messages are not re-emitted: their replay records are already in place.
   */
  private applyCompaction(record: Extract<AgentRecord, { type: 'context.apply_compaction' }>): void {
    const { type: _type, time: _time, ...result } = record;
    this.patchLastCompaction({ result });
    const summaryMessage: MutableContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: result.contextSummary ?? result.summary }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    this.history = [...this.history.filter((message) => isRealUserInput(message)), summaryMessage];
    this.openAssistant = undefined;
    this.fold.reset();
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

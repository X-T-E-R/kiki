import type { AgentId, AttachmentId, InteractionId, PromptId, TaskId, TodoId, TurnId } from '../model/ids';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem } from '../model/item';
import type { TranscriptMeta } from '../model/meta';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TranscriptTodo } from '../model/todo';
import type { TranscriptTurn } from '../model/turn';
import {
  EMPTY_AGENT_STATE,
  applyOperation,
  type AgentState,
} from '../ops/apply';
import type {
  AgentTranscriptSnapshot,
  AppendOp,
  AppendTarget,
  AppliedOps,
  TranscriptChangeEvent,
  TranscriptOperation,
} from '../ops/operation';

export type TranscriptListener = (event: TranscriptChangeEvent) => void;

export interface Disposable {
  dispose(): void;
}

const mapValuesCache = new WeakMap<object, readonly unknown[]>();

function stableMapValues<K, V>(map: ReadonlyMap<K, V>): readonly V[] {
  const cached = mapValuesCache.get(map as object);
  if (cached !== undefined) return cached as readonly V[];
  const values = Object.freeze([...map.values()]);
  mapValuesCache.set(map as object, values);
  return values;
}

export class AgentTranscript {
  #state: AgentState = EMPTY_AGENT_STATE;
  readonly #listeners = new Set<TranscriptListener>();
  readonly #appendDirty = new Set<string>();

  constructor(readonly agentId: AgentId) {}

  /** Full load == applying a reset: there is no second seeding path. */
  receive(ops: readonly TranscriptOperation[]): AppliedOps {
    return this.apply(ops);
  }

  /**
   * The single convergence path. Returns the accepted ops plus a gap signal
   * when an `append` could not land (the caller's policy decides to ignore or
   * re-snapshot). Emits exactly one `onChange` batch when anything changed.
   */
  apply(ops: readonly TranscriptOperation[]): AppliedOps {
    const accepted: TranscriptOperation[] = [];
    let gap: AppliedOps['gap'];
    let state = this.#state;
    for (let index = 0; index < ops.length;) {
      const first = ops[index];
      if (first === undefined) break;
      const run = coalesceAppendRun(state, ops, index);
      const op = run.op;
      const result = applyOperation(state, op);
      if (result.gap) {
        gap = { target: (op as { target: AppendTarget }).target, ...result.gap };
        index = run.nextIndex;
        continue;
      }
      const key = appendTargetKey(op);
      if (!result.changed) {
        if (
          key !== undefined &&
          (op.op === 'frame.upsert' || op.op === 'task.upsert') &&
          this.#appendDirty.delete(key)
        ) {
          accepted.push(...run.originals);
        }
        index = run.nextIndex;
        continue;
      }
      state = result.state;
      accepted.push(...run.originals);
      if (op.op === 'append' && key !== undefined) this.#appendDirty.add(key);
      else if (key !== undefined) this.#appendDirty.delete(key);
      else if (op.op === 'reset' || op.op === 'items.remove') this.#appendDirty.clear();
      index = run.nextIndex;
    }
    this.#state = state;
    if (accepted.length > 0) {
      const event: TranscriptChangeEvent = { agentId: this.agentId, ops: accepted };
      for (const listener of this.#listeners) listener(event);
    }
    return { accepted, gap };
  }

  onChange(listener: TranscriptListener): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  }

  getItems(): readonly TranscriptItem[] {
    return this.#state.items;
  }

  getTurn(turnId: TurnId): TranscriptTurn | undefined {
    for (let i = this.#state.items.length - 1; i >= 0; i -= 1) {
      const item = this.#state.items[i];
      if (item?.kind === 'turn' && item.turnId === turnId) return item;
    }
    return undefined;
  }

  getTasks(): ReadonlyMap<TaskId, TranscriptTask> {
    return this.#state.tasks;
  }

  getTask(taskId: TaskId): TranscriptTask | undefined {
    return this.#state.tasks.get(taskId);
  }

  getInteractions(): ReadonlyMap<InteractionId, TranscriptInteraction> {
    return this.#state.interactions;
  }

  getInteraction(interactionId: InteractionId): TranscriptInteraction | undefined {
    return this.#state.interactions.get(interactionId);
  }

  getAttachments(): ReadonlyMap<AttachmentId, TranscriptAttachment> {
    return this.#state.attachments;
  }

  getAttachment(attachmentId: AttachmentId): TranscriptAttachment | undefined {
    return this.#state.attachments.get(attachmentId);
  }

  getTodos(): ReadonlyMap<TodoId, TranscriptTodo> {
    return this.#state.todos;
  }

  getTodo(todoId: TodoId): TranscriptTodo | undefined {
    return this.#state.todos.get(todoId);
  }

  getPrompts(): ReadonlyMap<PromptId, TranscriptPrompt> {
    return this.#state.prompts;
  }

  getPrompt(promptId: PromptId): TranscriptPrompt | undefined {
    return this.#state.prompts.get(promptId);
  }

  getMeta(): TranscriptMeta {
    return this.#state.meta;
  }

  listPendingInteractions(): readonly InteractionId[] {
    return [...this.#state.pendingInteractions];
  }

  get hasMoreOlder(): boolean {
    return this.#state.hasMoreOlder;
  }

  /** Materialize current state (optionally windowed to the newest turns). */
  snapshot(window?: { tailTurns: number }): AgentTranscriptSnapshot {
    let items = this.#state.items;
    let hasMoreOlder = this.#state.hasMoreOlder;
    if (window !== undefined) {
      const tailTurns = Math.max(0, window.tailTurns);
      let seen = 0;
      let start = items.length;
      let trimmed = false;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const entry = items[i];
        if (entry?.kind !== 'turn') continue;
        seen += 1;
        if (seen <= tailTurns) start = i;
        else {
          trimmed = true;
          break;
        }
      }
      if (trimmed) {
        items = tailTurns === 0 ? [] : items.slice(start);
        hasMoreOlder = true;
      }
    }
    return {
      items,
      tasks: stableMapValues(this.#state.tasks),
      interactions: stableMapValues(this.#state.interactions),
      attachments: stableMapValues(this.#state.attachments),
      todos: stableMapValues(this.#state.todos),
      prompts: stableMapValues(this.#state.prompts),
      meta: this.#state.meta,
      hasMoreOlder,
    };
  }
}

interface CoalescedRun {
  readonly op: TranscriptOperation;
  readonly originals: readonly TranscriptOperation[];
  readonly nextIndex: number;
}

function coalesceAppendRun(
  state: AgentState,
  ops: readonly TranscriptOperation[],
  start: number,
): CoalescedRun {
  const first = ops[start];
  if (first === undefined) throw new RangeError('operation index out of bounds');
  if (
    first.op !== 'append' ||
    first.text.length === 0 ||
    appendTargetLength(state, first.target) !== first.offset
  ) {
    return { op: first, originals: [first], nextIndex: start + 1 };
  }
  const originals: AppendOp[] = [first];
  const chunks = [first.text];
  let expectedOffset = first.offset + first.text.length;
  let index = start + 1;
  while (index < ops.length) {
    const candidate = ops[index];
    if (
      candidate === undefined ||
      candidate.op !== 'append' ||
      candidate.text.length === 0 ||
      !appendTargetsEqual(first.target, candidate.target) ||
      candidate.offset !== expectedOffset
    ) {
      break;
    }
    originals.push(candidate);
    chunks.push(candidate.text);
    expectedOffset += candidate.text.length;
    index += 1;
  }
  if (originals.length === 1) {
    return { op: first, originals, nextIndex: index };
  }
  return {
    op: { ...first, text: chunks.join('') },
    originals,
    nextIndex: index,
  };
}

function appendTargetLength(state: AgentState, target: AppendTarget): number | undefined {
  if (target.type === 'task') return state.tasks.get(target.taskId)?.outputTail?.length ?? 0;
  let turn: TranscriptTurn | undefined;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item?.kind === 'turn' && item.turnId === target.turnId) {
      turn = item;
      break;
    }
  }
  if (turn === undefined) return undefined;
  const step = turn.steps.find((item) => item.stepId === target.stepId);
  const frame = step?.frames.find((item) => item.frameId === target.frameId);
  return frame?.kind === 'text' || frame?.kind === 'thinking' ? frame.text.length : undefined;
}

function appendTargetsEqual(left: AppendTarget, right: AppendTarget): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'task') return right.type === 'task' && left.taskId === right.taskId;
  return (
    right.type === 'frame' &&
    left.turnId === right.turnId &&
    left.stepId === right.stepId &&
    left.frameId === right.frameId
  );
}

function appendTargetKey(op: TranscriptOperation): string | undefined {
  if (op.op === 'append') {
    return op.target.type === 'frame'
      ? `frame:${op.target.turnId}:${op.target.stepId}:${op.target.frameId}`
      : `task:${op.target.taskId}`;
  }
  if (op.op === 'frame.upsert') {
    return `frame:${op.turnId}:${op.stepId}:${op.frame.frameId}`;
  }
  if (op.op === 'task.upsert') return `task:${op.task.taskId}`;
  return undefined;
}

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
  AppendTarget,
  AppliedOps,
  TranscriptChangeEvent,
  TranscriptOperation,
} from '../ops/operation';

export type TranscriptListener = (event: TranscriptChangeEvent) => void;

export interface Disposable {
  dispose(): void;
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
    for (const op of ops) {
      const result = applyOperation(state, op);
      if (result.gap) {
        gap = { target: (op as { target: AppendTarget }).target, ...result.gap };
        continue;
      }
      const key = appendTargetKey(op);
      if (!result.changed) {
        if (
          key !== undefined &&
          (op.op === 'frame.upsert' || op.op === 'task.upsert') &&
          this.#appendDirty.delete(key)
        ) {
          accepted.push(op);
        }
        continue;
      }
      state = result.state;
      accepted.push(op);
      if (op.op === 'append' && key !== undefined) this.#appendDirty.add(key);
      else if (key !== undefined) this.#appendDirty.delete(key);
      else if (op.op === 'reset' || op.op === 'items.remove') this.#appendDirty.clear();
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
    const item = this.#state.items.find(
      (entry) => entry.kind === 'turn' && entry.turnId === turnId,
    );
    return item?.kind === 'turn' ? item : undefined;
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
      const turnCount = items.reduce((n, entry) => (entry.kind === 'turn' ? n + 1 : n), 0);
      if (turnCount > window.tailTurns) {
        const skip = turnCount - window.tailTurns;
        const kept: TranscriptItem[] = [];
        let seen = 0;
        for (const entry of items) {
          if (entry.kind === 'turn') {
            seen += 1;
            if (seen <= skip) continue;
            kept.push(entry);
          } else if (seen > skip) {
            kept.push(entry);
          }
        }
        items = kept;
        hasMoreOlder = true;
      }
    }
    return {
      items,
      tasks: [...this.#state.tasks.values()],
      interactions: [...this.#state.interactions.values()],
      attachments: [...this.#state.attachments.values()],
      todos: [...this.#state.todos.values()],
      prompts: [...this.#state.prompts.values()],
      meta: this.#state.meta,
      hasMoreOlder,
    };
  }
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

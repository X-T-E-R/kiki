import type { AttachmentId, InteractionId, PromptId, TaskId, TodoId, TurnId } from '../model/ids';
import { turnOrdinal } from '../model/ids';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem } from '../model/item';
import type { TranscriptMeta, TranscriptMetaMerge } from '../model/meta';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TranscriptTodo } from '../model/todo';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';
import type {
  AppendOp,
  TranscriptCoverage,
  TranscriptOperation,
  TurnHeader,
  StepHeader,
} from './operation';
import { transcriptValueEquals } from './equality';

const EMPTY_REMOVED_ITEM_IDS: ReadonlySet<string> = new Set();
const REMOVED_ITEM_ID_LIMIT = 2048;
const removedItemIdsByState = new WeakMap<AgentState, ReadonlySet<string>>();

/** Mutable-free aggregate state behind one AgentTranscript. */
export interface AgentState {
  readonly items: readonly TranscriptItem[];
  readonly tasks: ReadonlyMap<TaskId, TranscriptTask>;
  /** Global interaction entities (approvals / questions), keyed by id. */
  readonly interactions: ReadonlyMap<InteractionId, TranscriptInteraction>;
  /** Global attachment entities (media metadata), keyed by id. */
  readonly attachments: ReadonlyMap<AttachmentId, TranscriptAttachment>;
  /** Global todo documents (latest state), keyed by id. */
  readonly todos: ReadonlyMap<TodoId, TranscriptTodo>;
  /** Global prompt queue entities, keyed by id. */
  readonly prompts: ReadonlyMap<PromptId, TranscriptPrompt>;
  /** Global tool-frame count when known. */
  readonly toolCallCount?: number;
  readonly meta: TranscriptMeta;
  /** Interaction ids currently in 'pending' state (derived index). */
  readonly pendingInteractions: ReadonlySet<InteractionId>;
  /** Set by windowed resets: older turns exist beyond the loaded window. */
  readonly hasMoreOlder: boolean;
}

export const EMPTY_AGENT_STATE: AgentState = {
  items: [],
  tasks: new Map(),
  interactions: new Map(),
  attachments: new Map(),
  todos: new Map(),
  prompts: new Map(),
  toolCallCount: 0,
  meta: {},
  pendingInteractions: new Set(),
  hasMoreOlder: false,
};

export interface ApplyResult {
  readonly state: AgentState;
  /** True when the op changed observable state. */
  readonly changed: boolean;
  /** Exact tool-frame arithmetic delta when it can be proven. */
  readonly toolCallCountDelta?: number;
  /** Present when an append failed to land (offset beyond local length). */
  readonly gap?: { readonly expected: number; readonly got: number };
}

export function applyOperation(state: AgentState, op: TranscriptOperation): ApplyResult {
  let result: ApplyResult;
  switch (op.op) {
    case 'reset':
      result = applyReset(state, op);
      break;
    case 'turn.upsert':
      result = applyTurnUpsert(state, op.turn);
      break;
    case 'step.upsert':
      result = applyStepUpsert(state, op.turnId, op.step);
      break;
    case 'frame.upsert':
      result = applyFrameUpsert(state, op);
      break;
    case 'tool.count.set':
      result = applyToolCountSet(state, op.count);
      break;
    case 'append':
      result = applyAppend(state, op);
      break;
    case 'marker.upsert':
      result = applyItemUpsert(state, op.item, op.item.markerId, op.beforeTurn);
      break;
    case 'taskref.upsert':
      result = applyItemUpsert(state, op.item, op.item.refId, op.beforeTurn);
      break;
    case 'task.upsert':
      result = applyTaskUpsert(state, op.task);
      break;
    case 'interaction.upsert':
      result = applyInteractionUpsert(state, op.interaction);
      break;
    case 'attachment.upsert':
      result = applyAttachmentUpsert(state, op.attachment);
      break;
    case 'todo.upsert':
      result = applyTodoUpsert(state, op.todo);
      break;
    case 'prompt.upsert':
      result = applyPromptUpsert(state, op.prompt);
      break;
    case 'meta.merge':
      result = applyMetaMerge(state, op.meta);
      break;
    case 'items.remove':
      result = applyItemsRemove(state, op.ids);
      break;
  }
  result = normalizeToolCallDelta(op, result);
  carryRemovedItemIds(state, result.state, op);
  return result;
}

function normalizeToolCallDelta(op: TranscriptOperation, result: ApplyResult): ApplyResult {
  if (result.toolCallCountDelta !== undefined) return result;
  if (op.op === 'reset' || op.op === 'tool.count.set' || op.op === 'items.remove') return result;
  return { ...result, toolCallCountDelta: 0 };
}

function carryRemovedItemIds(
  state: AgentState,
  next: AgentState,
  op: TranscriptOperation,
): void {
  if (op.op === 'reset') {
    const coverage = op.coverage ?? fullCoverage(op.snapshot.hasMoreOlder ?? false);
    if (coverage.kind === 'full') {
      removedItemIdsByState.set(next, EMPTY_REMOVED_ITEM_IDS);
      return;
    }
  }
  if (next === state) return;
  const prior = removedItemIdsByState.get(state);
  if (op.op === 'items.remove') {
    const removed = new Set(prior ?? EMPTY_REMOVED_ITEM_IDS);
    for (const id of op.ids) {
      removed.add(id);
      if (removed.size > REMOVED_ITEM_ID_LIMIT) {
        const oldest = removed.values().next().value;
        if (oldest !== undefined) removed.delete(oldest);
      }
    }
    removedItemIdsByState.set(next, removed);
    return;
  }
  if (prior !== undefined) removedItemIdsByState.set(next, prior);
}

function applyReset(state: AgentState, op: Extract<TranscriptOperation, { op: 'reset' }>): ApplyResult {
  const coverage = op.coverage ?? fullCoverage(op.snapshot.hasMoreOlder ?? false);
  const items = reconcileItems(state.items, op.snapshot.items, coverage);
  const tasks = stabilizeMap(state.tasks, op.snapshot.tasks, (value) => value.taskId);
  const interactions = stabilizeMap(
    state.interactions,
    op.snapshot.interactions,
    (value) => value.interactionId,
  );
  const attachments = stabilizeMap(
    state.attachments,
    op.snapshot.attachments,
    (value) => value.attachmentId,
  );
  const todos = stabilizeMap(state.todos, op.snapshot.todos, (value) => value.todoId);
  const prompts = stabilizeMap(state.prompts, op.snapshot.prompts, (value) => value.promptId);
  const meta = transcriptValueEquals(state.meta, op.snapshot.meta) ? state.meta : op.snapshot.meta;
  const toolCallCount = toolCallCountAfterReset(
    state,
    op.snapshot.toolCallCount,
    op.snapshot.toolCallCountKnown,
    op.grade,
    items,
    coverage,
  );
  const pending = new Set<InteractionId>();
  for (const interaction of interactions.values()) {
    if (interaction.state === 'pending') pending.add(interaction.interactionId);
  }
  const hasMoreOlder = coverage.hasMoreOlder;
  const next: AgentState = {
    items,
    tasks,
    interactions,
    attachments,
    todos,
    prompts,
    toolCallCount,
    meta,
    pendingInteractions: pending,
    hasMoreOlder,
  };
  const changed =
    items !== state.items ||
    tasks !== state.tasks ||
    interactions !== state.interactions ||
    attachments !== state.attachments ||
    todos !== state.todos ||
    prompts !== state.prompts ||
    toolCallCount !== state.toolCallCount ||
    meta !== state.meta ||
    hasMoreOlder !== state.hasMoreOlder;
  return changed
    ? { state: next, changed: true, toolCallCountDelta: undefined }
    : { state, changed: false, toolCallCountDelta: 0 };
}

function applyToolCountSet(state: AgentState, count: number | undefined): ApplyResult {
  if (state.toolCallCount === count) return { state, changed: false, toolCallCountDelta: undefined };
  return {
    state: { ...state, toolCallCount: count },
    changed: true,
    toolCallCountDelta: undefined,
  };
}

function fullCoverage(hasMoreOlder: boolean): TranscriptCoverage {
  return hasMoreOlder
    ? { kind: 'tail', hasMoreOlder: true }
    : { kind: 'full', hasMoreOlder: false };
}

function countToolCallFrames(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') count += 1;
      }
    }
  }
  return count;
}

function canPreservePartialToolCallCount(state: AgentState): boolean {
  return state.hasMoreOlder || state.items.some((item) => item.kind === 'turn');
}

function toolCallCountAfterReset(
  state: AgentState,
  supplied: number | undefined,
  suppliedKnown: boolean | undefined,
  grade: 'turn' | 'block' | 'delta' | undefined,
  items: readonly TranscriptItem[],
  coverage: TranscriptCoverage,
): number | undefined {
  if (suppliedKnown === false) return undefined;
  if (grade === 'turn' && suppliedKnown !== true && supplied === undefined) return undefined;
  const visible = countToolCallFrames(items);
  if (coverage.kind === 'full') return supplied ?? visible;
  if (supplied !== undefined) return Math.max(supplied, visible);
  if (state.toolCallCount === undefined || !canPreservePartialToolCallCount(state)) return undefined;
  return Math.max(state.toolCallCount, visible);
}

function adjustToolCallCount(count: number | undefined, delta: number): number | undefined {
  return count === undefined ? undefined : Math.max(0, count + delta);
}

function reconcileItems(
  current: readonly TranscriptItem[],
  incoming: readonly TranscriptItem[],
  coverage: TranscriptCoverage,
): readonly TranscriptItem[] {
  const currentById = new Map(current.map((item) => [itemIdOf(item), item]));
  const stableIncoming = incoming.map((item) => {
    const existing = currentById.get(itemIdOf(item));
    return existing !== undefined && transcriptValueEquals(existing, item) ? existing : item;
  });
  if (coverage.kind === 'full') {
    return transcriptValueEquals(current, stableIncoming) ? current : stableIncoming;
  }
  if (coverage.fromTurnId === undefined) {
    return stableIncoming.length === 0 ? current : stableIncoming;
  }
  const fromOrdinal = turnOrdinal(coverage.fromTurnId);
  const prefix: TranscriptItem[] = [];
  for (const item of current) {
    if (item.kind === 'turn' && item.ordinal >= fromOrdinal) break;
    prefix.push(item);
  }
  const next = [...prefix, ...stableIncoming];
  return transcriptValueEquals(current, next) ? current : next;
}

function stabilizeMap<K, V>(
  current: ReadonlyMap<K, V>,
  incoming: readonly V[],
  keyOf: (value: V) => K,
): ReadonlyMap<K, V> {
  const next = new Map<K, V>();
  for (const value of incoming) {
    const key = keyOf(value);
    const existing = current.get(key);
    next.set(key, existing !== undefined && transcriptValueEquals(existing, value) ? existing : value);
  }
  if (current.size !== next.size) return next;
  for (const [key, value] of next) {
    if (current.get(key) !== value) return next;
  }
  return current;
}

function turnHeaderToTurn(header: TurnHeader, steps: readonly TranscriptStep[]): TranscriptTurn {
  return { ...header, kind: 'turn', steps: [...steps] };
}

function skeletonTurn(turnId: TurnId): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    ordinal: turnOrdinal(turnId),
    state: 'running',
    origin: { kind: 'other' },
    steps: [],
  };
}

function skeletonStep(stepId: string, turnId: TurnId): TranscriptStep {
  const ordinal = Number(stepId.slice(turnId.length + 1)) || 0;
  return { kind: 'step', stepId, turnId, ordinal, state: 'running', frames: [] };
}

function findTurn(
  items: readonly TranscriptItem[],
  turnId: TurnId,
): { readonly index: number; readonly turn: TranscriptTurn } | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === 'turn' && item.turnId === turnId) return { index: i, turn: item };
  }
  return undefined;
}

function insertTurn(items: readonly TranscriptItem[], turn: TranscriptTurn): readonly TranscriptItem[] {
  const next = [...items];
  let at = next.length;
  for (let i = 0; i < next.length; i += 1) {
    const entry = next[i];
    if (entry?.kind === 'turn' && entry.ordinal > turn.ordinal) {
      at = i;
      break;
    }
  }
  next.splice(at, 0, turn);
  return next;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const next = [...items];
  next[index] = value;
  return next;
}

function applyTurnUpsert(state: AgentState, header: TurnHeader): ApplyResult {
  const located = findTurn(state.items, header.turnId);
  if (located !== undefined) {
    if (turnEquals(located.turn, header)) return { state, changed: false };
    return {
      state: {
        ...state,
        items: replaceAt(
          state.items,
          located.index,
          turnHeaderToTurn(header, located.turn.steps),
        ),
      },
      changed: true,
    };
  }
  return {
    state: { ...state, items: insertTurn(state.items, turnHeaderToTurn(header, [])) },
    changed: true,
  };
}

function turnEquals(turn: TranscriptTurn, header: TurnHeader): boolean {
  const { steps: _steps, ...current } = turn;
  void _steps;
  return transcriptValueEquals(current, header);
}

function applyStepUpsert(state: AgentState, turnId: TurnId, header: StepHeader): ApplyResult {
  const located = findTurn(state.items, turnId);
  const turn = located?.turn ?? skeletonTurn(turnId);
  const stepIndex = turn.steps.findIndex((step) => step.stepId === header.stepId);
  let steps: readonly TranscriptStep[];
  let changed = true;
  if (stepIndex >= 0) {
    const current = turn.steps[stepIndex];
    if (current && stepEquals(current, header)) {
      changed = false;
      steps = turn.steps;
    } else {
      steps = replaceAt(
        turn.steps,
        stepIndex,
        { ...header, kind: 'step' as const, frames: current?.frames ?? [] },
      );
    }
  } else {
    steps = [...turn.steps, { ...header, kind: 'step' as const, frames: [] }].toSorted(
      (a, b) => a.ordinal - b.ordinal,
    );
  }
  if (!changed) return { state, changed: false };
  const nextTurn: TranscriptTurn = { ...turn, steps: [...steps] };
  const items =
    located !== undefined
      ? replaceAt(state.items, located.index, nextTurn)
      : insertTurn(state.items, nextTurn);
  return { state: { ...state, items }, changed: true };
}

function stepEquals(step: TranscriptStep, header: StepHeader): boolean {
  const { frames: _frames, ...current } = step;
  void _frames;
  return transcriptValueEquals(current, header);
}

function applyFrameUpsert(
  state: AgentState,
  op: Extract<TranscriptOperation, { op: 'frame.upsert' }>,
): ApplyResult {
  const located = findTurn(state.items, op.turnId);
  const turn = located?.turn ?? skeletonTurn(op.turnId);
  const stepIndex = turn.steps.findIndex((entry) => entry.stepId === op.stepId);
  const step = turn.steps[stepIndex] ?? skeletonStep(op.stepId, op.turnId);
  const frameIndex = step.frames.findIndex((frame) => frame.frameId === op.frame.frameId);
  let frames: readonly TranscriptFrame[];
  let toolCallCount = state.toolCallCount;
  let toolCallCountDelta = 0;
  if (frameIndex >= 0) {
    const current = step.frames[frameIndex];
    if (current !== undefined && frameEquals(current, op.frame)) {
      return { state, changed: false, toolCallCountDelta: 0 };
    }
    if (current !== undefined && (current.kind === 'tool') !== (op.frame.kind === 'tool')) {
      toolCallCountDelta = op.frame.kind === 'tool' ? 1 : -1;
      toolCallCount = adjustToolCallCount(toolCallCount, toolCallCountDelta);
    }
    frames = replaceAt(step.frames, frameIndex, op.frame);
  } else {
    if (op.frame.kind === 'tool') {
      toolCallCountDelta = 1;
      toolCallCount = adjustToolCallCount(toolCallCount, 1);
    }
    frames = [...step.frames, op.frame];
  }
  const nextStep: TranscriptStep = { ...step, frames: [...frames] };
  const steps =
    stepIndex >= 0
      ? replaceAt(turn.steps, stepIndex, nextStep)
      : [...turn.steps, nextStep].toSorted((a, b) => a.ordinal - b.ordinal);
  const nextTurn: TranscriptTurn = { ...turn, steps };
  const items =
    located !== undefined
      ? replaceAt(state.items, located.index, nextTurn)
      : insertTurn(state.items, nextTurn);
  return {
    state: { ...state, items, toolCallCount },
    changed: true,
    toolCallCountDelta,
  };
}

function frameEquals(a: TranscriptFrame, b: TranscriptFrame): boolean {
  return transcriptValueEquals(a, b);
}

function applyAppend(state: AgentState, op: AppendOp): ApplyResult {
  if (op.target.type === 'task') return applyTaskAppend(state, op);
  const { turnId, stepId, frameId } = op.target;
  const located = findTurn(state.items, turnId);
  if (located === undefined) {
    return { state, changed: false, gap: { expected: 0, got: op.offset } };
  }
  const turn = located.turn;
  const stepIndex = turn.steps.findIndex((entry) => entry.stepId === stepId);
  const step = turn.steps[stepIndex];
  const frameIndex = step?.frames.findIndex((entry) => entry.frameId === frameId) ?? -1;
  const frame = step?.frames[frameIndex];
  if (!step || !frame || (frame.kind !== 'text' && frame.kind !== 'thinking')) {
    return { state, changed: false, gap: { expected: 0, got: op.offset } };
  }
  const merged = appendAtOffset(frame.text, op.offset, op.text);
  if (merged.gap) return { state, changed: false, gap: merged.gap };
  if (!merged.changed) return { state, changed: false };
  const nextFrame = { ...frame, text: merged.text };
  const nextStep: TranscriptStep = {
    ...step,
    frames: replaceAt(step.frames, frameIndex, nextFrame),
  };
  const nextTurn: TranscriptTurn = {
    ...turn,
    steps: replaceAt(turn.steps, stepIndex, nextStep),
  };
  return {
    state: { ...state, items: replaceAt(state.items, located.index, nextTurn) },
    changed: true,
  };
}

function applyTaskAppend(state: AgentState, op: AppendOp): ApplyResult {
  if (op.target.type !== 'task') throw new Error('unreachable');
  const taskId = op.target.taskId;
  const task = state.tasks.get(taskId);
  const current = task?.outputTail ?? '';
  const merged = appendAtOffset(current, op.offset, op.text);
  if (merged.gap) return { state, changed: false, gap: merged.gap };
  if (!merged.changed) return { state, changed: false };
  const nextTask: TranscriptTask = task
    ? { ...task, outputTail: merged.text }
    : { taskId, kind: 'other', state: 'running', detached: false, outputTail: merged.text };
  const tasks = new Map(state.tasks);
  tasks.set(taskId, nextTask);
  return { state: { ...state, tasks }, changed: true };
}

/**
 * Offset placement, mirroring the web client's alignDelta semantics:
 * `offset > local length` is a gap (caller should re-snapshot); a chunk that
 * is already fully present is a duplicate (no change); a partially present
 * chunk is trimmed to its novel suffix — but only when the overlap region
 * agrees. A chunk behind local state whose overlap does NOT match is a gap
 * too (diverged stream), never a silent rewrite that drops local content.
 */
export function appendAtOffset(
  local: string,
  offset: number,
  chunk: string,
): { text: string; changed: boolean; gap?: { expected: number; got: number } } {
  if (offset > local.length) return { text: local, changed: false, gap: { expected: local.length, got: offset } };
  if (local.slice(offset, offset + chunk.length) === chunk) {
    return { text: local, changed: false };
  }
  const overlap = local.length - offset;
  if (local.slice(offset) !== chunk.slice(0, overlap)) {
    return { text: local, changed: false, gap: { expected: local.length, got: offset } };
  }
  const novel = overlap > 0 ? chunk.slice(overlap) : chunk;
  if (novel.length === 0) return { text: local, changed: false };
  return { text: local.slice(0, offset) + chunk, changed: true };
}

function applyItemUpsert(
  state: AgentState,
  item: TranscriptItem,
  id: string,
  beforeTurn?: number,
): ApplyResult {
  const existingIndex = state.items.findIndex((entry) => itemIdOf(entry) === id);
  if (existingIndex >= 0) {
    const existing = state.items[existingIndex];
    if (existing === item || (existing !== undefined && transcriptValueEquals(existing, item))) {
      return { state, changed: false };
    }
    return { state: { ...state, items: replaceAt(state.items, existingIndex, item) }, changed: true };
  }
  if (beforeTurn !== undefined) {
    const items = [...state.items];
    let at = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      if (entry?.kind === 'turn' && entry.ordinal >= beforeTurn) {
        at = i;
        break;
      }
    }
    items.splice(at, 0, item);
    return { state: { ...state, items }, changed: true };
  }
  return { state: { ...state, items: [...state.items, item] }, changed: true };
}

function itemIdOf(item: TranscriptItem): string {
  switch (item.kind) {
    case 'turn':
      return item.turnId;
    case 'marker':
      return item.markerId;
    case 'taskref':
      return item.refId;
  }
}

function applyItemsRemove(state: AgentState, ids: readonly string[]): ApplyResult {
  const drop = new Set(ids);
  const removedTurns = state.items.filter(
    (entry): entry is TranscriptTurn => entry.kind === 'turn' && drop.has(entry.turnId),
  );
  const items = state.items.filter((entry) => !drop.has(itemIdOf(entry)));
  const removedToolCallCount = countToolCallFrames(removedTurns);
  const priorRemovedItemIds = removedItemIdsByState.get(state) ?? EMPTY_REMOVED_ITEM_IDS;
  const unseenTurnRemoved =
    state.hasMoreOlder &&
    ids.some(
      (id) => !state.items.some((entry) => itemIdOf(entry) === id) && !priorRemovedItemIds.has(id),
    );
  const toolCallCountDelta =
    unseenTurnRemoved || removedToolCallCount === 0 ? (unseenTurnRemoved ? undefined : 0) : -removedToolCallCount;
  const toolCallCount = unseenTurnRemoved
    ? undefined
    : adjustToolCallCount(state.toolCallCount, -removedToolCallCount);
  const itemsChanged = items.length !== state.items.length;
  const toolCallCountChanged = toolCallCount !== state.toolCallCount;
  if (!itemsChanged && !toolCallCountChanged) {
    return unseenTurnRemoved
      ? { state: { ...state }, changed: true, toolCallCountDelta }
      : { state, changed: false, toolCallCountDelta };
  }
  let pending = state.pendingInteractions;
  let interactions = state.interactions;
  if (removedTurns.length > 0) {
    const anchoredToolCallIds = new Set<string>();
    const nextPending = new Set(pending);
    const deadEntityIds = new Set<InteractionId>();
    for (const turn of removedTurns) {
      for (const step of turn.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'tool') anchoredToolCallIds.add(frame.toolCallId);
        }
      }
    }
    for (const interaction of interactions.values()) {
      if (interaction.toolCallId !== undefined && anchoredToolCallIds.has(interaction.toolCallId)) {
        deadEntityIds.add(interaction.interactionId);
        nextPending.delete(interaction.interactionId);
      }
    }
    if (deadEntityIds.size > 0) {
      const nextInteractions = new Map(interactions);
      for (const id of deadEntityIds) nextInteractions.delete(id);
      interactions = nextInteractions;
    }
    pending = nextPending;
  }
  return {
    state: { ...state, items, interactions, pendingInteractions: pending, toolCallCount },
    changed: true,
    toolCallCountDelta,
  };
}

function applyTaskUpsert(state: AgentState, task: TranscriptTask): ApplyResult {
  const current = state.tasks.get(task.taskId);
  if (current && taskEquals(current, task)) return { state, changed: false };
  const tasks = new Map(state.tasks);
  tasks.set(task.taskId, task);
  return { state: { ...state, tasks }, changed: true };
}

function applyInteractionUpsert(
  state: AgentState,
  interaction: TranscriptInteraction,
): ApplyResult {
  const current = state.interactions.get(interaction.interactionId);
  if (current && interactionEquals(current, interaction)) return { state, changed: false };
  const interactions = new Map(state.interactions);
  interactions.set(interaction.interactionId, interaction);
  let pending = state.pendingInteractions;
  if (interaction.state === 'pending') {
    if (!pending.has(interaction.interactionId)) {
      const next = new Set(pending);
      next.add(interaction.interactionId);
      pending = next;
    }
  } else if (pending.has(interaction.interactionId)) {
    const next = new Set(pending);
    next.delete(interaction.interactionId);
    pending = next;
  }
  return { state: { ...state, interactions, pendingInteractions: pending }, changed: true };
}

function interactionEquals(a: TranscriptInteraction, b: TranscriptInteraction): boolean {
  return transcriptValueEquals(a, b);
}

function applyAttachmentUpsert(
  state: AgentState,
  attachment: TranscriptAttachment,
): ApplyResult {
  const current = state.attachments.get(attachment.attachmentId);
  if (current && attachmentEquals(current, attachment)) return { state, changed: false };
  const attachments = new Map(state.attachments);
  attachments.set(attachment.attachmentId, attachment);
  return { state: { ...state, attachments }, changed: true };
}

function attachmentEquals(a: TranscriptAttachment, b: TranscriptAttachment): boolean {
  return transcriptValueEquals(a, b);
}

function applyTodoUpsert(state: AgentState, todo: TranscriptTodo): ApplyResult {
  const current = state.todos.get(todo.todoId);
  if (current && todoEquals(current, todo)) return { state, changed: false };
  const todos = new Map(state.todos);
  todos.set(todo.todoId, todo);
  return { state: { ...state, todos }, changed: true };
}

function todoEquals(a: TranscriptTodo, b: TranscriptTodo): boolean {
  return transcriptValueEquals(a, b);
}

function applyPromptUpsert(state: AgentState, prompt: TranscriptPrompt): ApplyResult {
  const current = state.prompts.get(prompt.promptId);
  if (current && promptEquals(current, prompt)) return { state, changed: false };
  const prompts = new Map(state.prompts);
  prompts.set(prompt.promptId, prompt);
  return { state: { ...state, prompts }, changed: true };
}

function promptEquals(a: TranscriptPrompt, b: TranscriptPrompt): boolean {
  return transcriptValueEquals(a, b);
}

function taskEquals(a: TranscriptTask, b: TranscriptTask): boolean {
  return transcriptValueEquals(a, b);
}

function applyMetaMerge(state: AgentState, meta: TranscriptMetaMerge): ApplyResult {
  const modes =
    meta.modes !== undefined
      ? {
          plan: meta.modes.plan === null ? undefined : (meta.modes.plan ?? state.meta.modes?.plan),
          swarm: meta.modes.swarm === null ? undefined : (meta.modes.swarm ?? state.meta.modes?.swarm),
        }
      : state.meta.modes;
  const agent =
    meta.agent !== undefined ? { ...state.meta.agent, ...meta.agent } : state.meta.agent;
  const next: TranscriptMeta = {
    goal: meta.goal === null ? undefined : (meta.goal ?? state.meta.goal),
    activity: meta.activity ?? state.meta.activity,
    modes: modes !== undefined && modes.plan === undefined && modes.swarm === undefined ? undefined : modes,
    agent,
  };
  if (transcriptValueEquals(next, state.meta)) return { state, changed: false };
  return { state: { ...state, meta: next }, changed: true };
}

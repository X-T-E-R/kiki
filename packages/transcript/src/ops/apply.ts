import type { AttachmentId, InteractionId, PromptId, TaskId, TodoId, TurnId } from '../model/ids';
import { turnOrdinal } from '../model/ids';
import type { TranscriptAttachment } from '../model/attachment';
import type { ToolCallFrame, TranscriptFrame } from '../model/frame';
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
import { safetyBoundaryIndex } from './framePlace';
import { carryContentHydration, mergeContentPreview, noteHiddenStructuralInsert, type ContentWindow } from '../contract/content';

const EMPTY_REMOVED_ITEM_IDS: ReadonlySet<string> = new Set();
const REMOVED_ITEM_ID_LIMIT = 2048;
const removedItemIdsByState = new WeakMap<AgentState, ReadonlySet<string>>();
const itemIndexByItems = new WeakMap<readonly TranscriptItem[], Map<string, number>>();
const stepIndexBySteps = new WeakMap<readonly TranscriptStep[], Map<string, number>>();

export interface ApplyBatchScratch {
  ownedItems?: TranscriptItem[];
  readonly ownedSteps: WeakSet<readonly TranscriptStep[]>;
}

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
  return applyOperationInternal(state, op, undefined);
}

/** Apply one operation inside a single-owner batch where freshly cloned item/step arrays may be reused before publishing. */
export function applyBatchOperation(
  state: AgentState,
  op: TranscriptOperation,
  scratch: ApplyBatchScratch,
): ApplyResult {
  return applyOperationInternal(state, op, scratch);
}

function applyOperationInternal(
  state: AgentState,
  op: TranscriptOperation,
  scratch: ApplyBatchScratch | undefined,
): ApplyResult {
  let result: ApplyResult;
  switch (op.op) {
    case 'reset':
      if (scratch !== undefined) scratch.ownedItems = undefined;
      result = applyReset(state, op);
      break;
    case 'turn.upsert':
      result = applyTurnUpsert(state, op.turn, scratch);
      break;
    case 'step.upsert':
      result = applyStepUpsert(state, op.turnId, op.step, scratch);
      break;
    case 'frame.upsert':
      result = applyFrameUpsert(state, op, scratch);
      break;
    case 'frame.remove':
      result = applyFrameRemove(state, op, scratch);
      break;
    case 'tool.count.set':
      result = applyToolCountSet(state, op.count);
      break;
    case 'append':
      result = applyAppend(state, op, scratch);
      break;
    case 'marker.upsert':
      result = applyItemUpsert(state, op.item, op.item.markerId, op.beforeTurn, scratch);
      break;
    case 'taskref.upsert':
      result = applyItemUpsert(state, op.item, op.item.refId, op.beforeTurn, scratch);
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
      if (scratch !== undefined) scratch.ownedItems = undefined;
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
  const liveWatermark = op.read?.source === 'live' && op.read.stale === undefined &&
    op.read.watermark?.transcript?.epoch !== undefined;
  const items = reconcileItems(state.items, op.snapshot.items, coverage, liveWatermark, op.grade);
  const preserveExisting = coverage.kind === 'unknown';
  const tasks = stabilizeMap(state.tasks, op.snapshot.tasks, (value) => value.taskId, preserveExisting, liveWatermark);
  const interactions = stabilizeMap(
    state.interactions,
    op.snapshot.interactions,
    (value) => value.interactionId,
    preserveExisting,
    liveWatermark,
  );
  const attachments = stabilizeMap(
    state.attachments,
    op.snapshot.attachments,
    (value) => value.attachmentId,
    preserveExisting,
    liveWatermark,
  );
  const todos = stabilizeMap(state.todos, op.snapshot.todos, (value) => value.todoId, preserveExisting, liveWatermark);
  const prompts = stabilizeMap(state.prompts, op.snapshot.prompts, (value) => value.promptId, preserveExisting, liveWatermark);
  const metaCandidate = preserveExisting ? liveWatermark ? { ...state.meta, ...op.snapshot.meta } : { ...op.snapshot.meta, ...state.meta } : op.snapshot.meta;
  const meta = transcriptValueEquals(state.meta, metaCandidate) ? state.meta : metaCandidate;
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
  liveWatermark: boolean,
  grade?: 'turn' | 'block' | 'delta',
): readonly TranscriptItem[] {
  const currentById = new Map(current.map((item) => [itemIdOf(item), item]));
  const stableIncoming = incoming.map((item) => {
    const existing = currentById.get(itemIdOf(item));
    let candidate = item;
    if (item.kind === 'turn' && existing?.kind === 'turn') {
      const retained = mergeContentPreview(existing, liveWatermark && coverage.kind === 'unknown' && grade === 'turn'
        ? { ...item, steps: existing.steps, stepsPartial: existing.stepsPartial } : item);
      const existingStepIndex = existing.steps.length > 4 ? getStepIndexMap(existing.steps) : undefined;
      candidate = carryContentHydration(retained, { ...retained, steps: retained.steps.map((step) => {
        const previous = existingStepIndex !== undefined
          ? existing.steps[existingStepIndex.get(step.stepId) ?? -1]
          : existing.steps.find((entry) => entry.stepId === step.stepId);
        if (previous === undefined) return step;
        const previousFrames = previous.frames.length > 8
          ? new Map(previous.frames.map((entry) => [entry.frameId, entry]))
          : undefined;
        return { ...step, frames: step.frames.map((frame) => {
          const prevFrame = previousFrames !== undefined
            ? previousFrames.get(frame.frameId)
            : previous.frames.find((entry) => entry.frameId === frame.frameId);
          return prevFrame === undefined ? frame : mergeContentPreview(prevFrame, frame);
        }) };
      }) });
    }
    return existing !== undefined && transcriptValueEquals(existing, candidate) ? existing : candidate;
  });
  if (coverage.kind === 'full') {
    return transcriptValueEquals(current, stableIncoming) ? current : stableIncoming;
  }
  if (coverage.kind === 'unknown') {
    const next = reconcileUnknownCoverageItems(current, stableIncoming, liveWatermark);
    return transcriptValueEquals(current, next) ? current : next;
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

function reconcileUnknownCoverageItems(
  current: readonly TranscriptItem[],
  stableIncoming: readonly TranscriptItem[],
  liveWatermark: boolean,
): TranscriptItem[] {
  const updated = [...current];
  const existingIndexById = new Map<string, number>();
  let maxExistingTurnOrdinal = -Infinity;
  for (let i = 0; i < updated.length; i += 1) {
    const entry = updated[i]!;
    const id = itemIdOf(entry);
    if (!existingIndexById.has(id)) existingIndexById.set(id, i);
    if (entry.kind === 'turn' && entry.ordinal > maxExistingTurnOrdinal) {
      maxExistingTurnOrdinal = entry.ordinal;
    }
  }
  const newBoxById = new Map<string, { item: TranscriptItem }>();
  const midTurns: Array<{ item: TranscriptTurn }> = [];
  const tail: Array<{ item: TranscriptItem }> = [];
  const outOfOrderTailTurns: Array<{ item: TranscriptTurn }> = [];
  let maxTailTurnOrdinal = -Infinity;
  for (const item of stableIncoming) {
    const id = itemIdOf(item);
    const existingIndex = existingIndexById.get(id);
    if (existingIndex !== undefined) {
      if (liveWatermark) updated[existingIndex] = item;
      continue;
    }
    const existingNew = newBoxById.get(id);
    if (existingNew !== undefined) {
      if (liveWatermark) existingNew.item = item;
      continue;
    }
    const box = { item };
    newBoxById.set(id, box);
    if (item.kind === 'turn' && item.ordinal < maxExistingTurnOrdinal) {
      midTurns.push(box as { item: TranscriptTurn });
    } else if (item.kind === 'turn') {
      if (item.ordinal < maxTailTurnOrdinal) {
        outOfOrderTailTurns.push(box as { item: TranscriptTurn });
      } else {
        maxTailTurnOrdinal = item.ordinal;
        tail.push(box);
      }
    } else {
      tail.push(box);
    }
  }
  const mergedBase = mergeSortedTurnsIntoItems(updated, midTurns);
  if (tail.length === 0 && outOfOrderTailTurns.length === 0) return mergedBase;
  const tailItems = tail.map((box) => box.item);
  const mergedTail = mergeSortedTurnsIntoItems(tailItems, outOfOrderTailTurns);
  for (const item of mergedTail) mergedBase.push(item);
  return mergedBase;
}

function mergeSortedTurnsIntoItems(
  base: TranscriptItem[],
  turnsToInsert: Array<{ item: TranscriptTurn }>,
): TranscriptItem[] {
  if (turnsToInsert.length === 0) return base;
  const sorted = turnsToInsert.map((box) => box.item);
  sorted.sort((left, right) => left.ordinal - right.ordinal);
  const merged: TranscriptItem[] = [];
  let cursor = 0;
  for (const entry of base) {
    if (entry.kind === 'turn') {
      while (cursor < sorted.length && sorted[cursor]!.ordinal < entry.ordinal) {
        merged.push(sorted[cursor]!);
        cursor += 1;
      }
    }
    merged.push(entry);
  }
  while (cursor < sorted.length) {
    merged.push(sorted[cursor]!);
    cursor += 1;
  }
  return merged;
}

function stabilizeMap<K, V>(
  current: ReadonlyMap<K, V>,
  incoming: readonly V[],
  keyOf: (value: V) => K,
  preserveExisting = false,
  liveWatermark = false,
): ReadonlyMap<K, V> {
  const next = preserveExisting ? new Map(current) : new Map<K, V>();
  for (const value of incoming) {
    const key = keyOf(value);
    const existing = current.get(key);
    next.set(key, preserveExisting && !liveWatermark && existing !== undefined ? existing
      : existing !== undefined && transcriptValueEquals(existing, value) ? existing : value);
  }
  if (current.size !== next.size) return next;
  for (const [key, value] of next) {
    if (current.get(key) !== value) return next;
  }
  return current;
}

function turnHeaderToTurn(header: TurnHeader, steps: readonly TranscriptStep[]): TranscriptTurn {
  return carryContentHydration(header, { ...header, kind: 'turn', steps: [...steps] });
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

function getItemIndexMap(items: readonly TranscriptItem[]): Map<string, number> {
  let map = itemIndexByItems.get(items);
  if (map !== undefined) return map;
  map = new Map<string, number>();
  for (let i = 0; i < items.length; i += 1) {
    const id = itemIdOf(items[i]!);
    if (!map.has(id)) map.set(id, i);
  }
  itemIndexByItems.set(items, map);
  return map;
}

function getStepIndexMap(steps: readonly TranscriptStep[]): Map<string, number> {
  let map = stepIndexBySteps.get(steps);
  if (map !== undefined) return map;
  map = new Map<string, number>();
  for (let i = 0; i < steps.length; i += 1) {
    const id = steps[i]!.stepId;
    if (!map.has(id)) map.set(id, i);
  }
  stepIndexBySteps.set(steps, map);
  return map;
}

/** Look up an item's index by id using a cached per-array index map. */
export function findItemIndex(items: readonly TranscriptItem[], id: string): number {
  const tail = items.length - 1;
  if (tail >= 0 && itemIdOf(items[tail]!) === id) return tail;
  return getItemIndexMap(items).get(id) ?? -1;
}

function findStepIndex(steps: readonly TranscriptStep[], stepId: string): number {
  const tail = steps.length - 1;
  if (tail >= 0 && steps[tail]!.stepId === stepId) return tail;
  if (steps.length <= 4) {
    for (let i = tail - 1; i >= 0; i -= 1) {
      if (steps[i]!.stepId === stepId) return i;
    }
    return -1;
  }
  return getStepIndexMap(steps).get(stepId) ?? -1;
}

function findTurn(
  items: readonly TranscriptItem[],
  turnId: TurnId,
): { readonly index: number; readonly turn: TranscriptTurn } | undefined {
  const index = findItemIndex(items, turnId);
  if (index < 0) return undefined;
  const item = items[index];
  return item?.kind === 'turn' ? { index, turn: item } : undefined;
}

function insertTurn(
  items: readonly TranscriptItem[],
  turn: TranscriptTurn,
  scratch?: ApplyBatchScratch,
): readonly TranscriptItem[] {
  const reusable = scratch !== undefined && scratch.ownedItems === items;
  const next = reusable ? (items as TranscriptItem[]) : [...items];
  const last = next[next.length - 1];
  let at = next.length;
  if (last === undefined || (last.kind === 'turn' && last.ordinal <= turn.ordinal)) {
    next.push(turn);
  } else {
    for (let i = 0; i < next.length; i += 1) {
      const entry = next[i];
      if (entry?.kind === 'turn' && entry.ordinal > turn.ordinal) {
        at = i;
        break;
      }
    }
    next.splice(at, 0, turn);
  }
  if (reusable) {
    const map = itemIndexByItems.get(next);
    if (map !== undefined) {
      if (at === next.length - 1) map.set(turn.turnId, at);
      else itemIndexByItems.delete(next);
    }
  } else if (scratch !== undefined) {
    scratch.ownedItems = next;
  }
  return next;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
  const next = [...items];
  next[index] = value;
  return next;
}

function replaceItemAt(
  items: readonly TranscriptItem[],
  index: number,
  value: TranscriptItem,
  scratch?: ApplyBatchScratch,
): readonly TranscriptItem[] {
  const sameId = itemIdOf(items[index]!) === itemIdOf(value);
  if (scratch !== undefined && scratch.ownedItems === items) {
    (items as TranscriptItem[])[index] = value;
    if (!sameId) itemIndexByItems.delete(items);
    return items;
  }
  const next = [...items];
  next[index] = value;
  if (sameId) {
    const existingMap = itemIndexByItems.get(items);
    if (existingMap !== undefined) itemIndexByItems.set(next, existingMap);
  }
  if (scratch !== undefined) scratch.ownedItems = next;
  return next;
}

function replaceStepAt(
  steps: readonly TranscriptStep[],
  index: number,
  value: TranscriptStep,
  scratch?: ApplyBatchScratch,
): TranscriptStep[] {
  const sameId = steps[index]!.stepId === value.stepId;
  if (scratch !== undefined && scratch.ownedSteps.has(steps)) {
    const owned = steps as TranscriptStep[];
    owned[index] = value;
    if (!sameId) stepIndexBySteps.delete(owned);
    return owned;
  }
  const next = [...steps];
  next[index] = value;
  if (sameId) {
    const existingMap = stepIndexBySteps.get(steps);
    if (existingMap !== undefined) stepIndexBySteps.set(next, existingMap);
  }
  if (scratch !== undefined) scratch.ownedSteps.add(next);
  return next;
}

function insertStepOrdered(
  steps: readonly TranscriptStep[],
  step: TranscriptStep,
  scratch?: ApplyBatchScratch,
): TranscriptStep[] {
  const reusable = scratch !== undefined && scratch.ownedSteps.has(steps);
  const next = reusable ? (steps as TranscriptStep[]) : [...steps];
  const last = next[next.length - 1];
  let at = next.length;
  if (last === undefined || last.ordinal <= step.ordinal) {
    next.push(step);
  } else {
    let low = 0;
    let high = next.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (next[mid]!.ordinal <= step.ordinal) low = mid + 1;
      else high = mid;
    }
    at = low;
    next.splice(at, 0, step);
  }
  if (reusable) {
    const map = stepIndexBySteps.get(next);
    if (map !== undefined) {
      if (at === next.length - 1) map.set(step.stepId, at);
      else stepIndexBySteps.delete(next);
    }
  } else if (scratch !== undefined) {
    scratch.ownedSteps.add(next);
  }
  return next;
}

function applyTurnUpsert(state: AgentState, header: TurnHeader, scratch?: ApplyBatchScratch): ApplyResult {
  const located = findTurn(state.items, header.turnId);
  if (located !== undefined) {
    const next = header.stepsPartial === undefined && located.turn.stepsPartial !== undefined
      ? { ...header, stepsPartial: located.turn.stepsPartial } : header;
    const incoming = mergeContentPreview(located.turn, turnHeaderToTurn(next, located.turn.steps));
    if (transcriptValueEquals(located.turn, incoming)) return { state, changed: false };
    return { state: { ...state, items: replaceItemAt(state.items, located.index, incoming, scratch) }, changed: true };
  }
  return {
    state: { ...state, items: insertTurn(state.items, turnHeaderToTurn(header, []), scratch) },
    changed: true,
  };
}

function applyStepUpsert(
  state: AgentState,
  turnId: TurnId,
  header: StepHeader,
  scratch?: ApplyBatchScratch,
): ApplyResult {
  const located = findTurn(state.items, turnId);
  const turn = located?.turn ?? skeletonTurn(turnId);
  const stepIndex = findStepIndex(turn.steps, header.stepId);
  const omitted = turn.contentRefs?.find((ref) => ref.direction === 'backward' && ref.path.length === 1 && ref.path[0] === 'steps');
  if (stepIndex < 0 && omitted !== undefined && header.ordinal < omitted.offset) return { state, changed: false, toolCallCountDelta: 0 };
  let steps: TranscriptStep[];
  let changed = true;
  if (stepIndex >= 0) {
    const current = turn.steps[stepIndex];
    if (current && stepEquals(current, header)) {
      changed = false;
      steps = turn.steps;
    } else {
      steps = replaceStepAt(
        turn.steps,
        stepIndex,
        { ...header, kind: 'step' as const, frames: current?.frames ?? [] },
        scratch,
      );
    }
  } else {
    steps = insertStepOrdered(turn.steps, { ...header, kind: 'step' as const, frames: [] }, scratch);
  }
  if (!changed) return { state, changed: false };
  const nextTurn: TranscriptTurn = carryContentHydration(turn, { ...turn, steps });
  const items =
    located !== undefined
      ? replaceItemAt(state.items, located.index, nextTurn, scratch)
      : insertTurn(state.items, nextTurn, scratch);
  return { state: { ...state, items }, changed: true };
}

function stepEquals(step: TranscriptStep, header: StepHeader): boolean {
  const { frames: _frames, ...current } = step;
  void _frames;
  return transcriptValueEquals(current, header);
}

/** Merge an incoming tool frame with an existing frame for the same toolCallId without regressing a settled state back to running. */
export function mergeToolCallFrame(existing: ToolCallFrame, incoming: ToolCallFrame): ToolCallFrame {
  const regressingToRunning = existing.state !== 'running' && incoming.state === 'running';
  const merged: Record<string, unknown> = regressingToRunning ? { ...existing, ...incoming, state: existing.state } : { ...incoming };
  const preserveKeys = regressingToRunning
    ? (['output', 'error', 'errorCode', 'endedAt', 'attachmentIds', 'startedAt', 'input', 'inputText', 'display', 'progress', 'todoId', 'taskId', 'agentRefs'] as const)
    : (['startedAt', 'input', 'inputText', 'display', 'progress', 'todoId', 'taskId', 'agentRefs'] as const);
  for (const key of preserveKeys) {
    if (merged[key] === undefined && existing[key] !== undefined) {
      merged[key] = existing[key];
    }
  }
  const result = merged as unknown as ToolCallFrame;
  carryContentHydration(incoming as ContentWindow, result as ContentWindow);
  if (regressingToRunning) carryContentHydration(existing as ContentWindow, result as ContentWindow);
  return result;
}

function applyFrameUpsert(
  state: AgentState,
  op: Extract<TranscriptOperation, { op: 'frame.upsert' }>,
  scratch?: ApplyBatchScratch,
): ApplyResult {
  const located = findTurn(state.items, op.turnId);
  const turn = located?.turn ?? skeletonTurn(op.turnId);
  const stepIndex = findStepIndex(turn.steps, op.stepId);
  const step = turn.steps[stepIndex] ?? skeletonStep(op.stepId, op.turnId);
  const frameIndex = step.frames.findIndex((frame) => frame.frameId === op.frame.frameId);
  const omittedSteps = turn.contentRefs?.find((ref) => ref.direction === 'backward' && ref.path.length === 1 && ref.path[0] === 'steps');
  const omittedFrames = turn.contentRefs?.find((ref) => ref.direction === 'backward' && ref.path.length === 3 &&
    ref.path[0] === 'steps' && ref.path[1] === (op.stepIndex ?? step.ordinal) && ref.path[2] === 'frames');
  const hiddenStep = frameIndex < 0 && stepIndex < 0 && omittedSteps !== undefined
    && (op.stepIndex ?? step.ordinal) < omittedSteps.offset;
  const hiddenFrame = frameIndex < 0 && op.frameIndex !== undefined && omittedFrames !== undefined
    && op.frameIndex < omittedFrames.offset;
  if (hiddenStep) return { state, changed: false, toolCallCountDelta: 0 };
  if (hiddenFrame && op.place !== 'safety_boundary') return { state, changed: false, toolCallCountDelta: 0 };
  if (hiddenFrame && omittedFrames !== undefined) {
    const contentRefs = turn.contentRefs?.map((ref) => ref === omittedFrames
      ? { ...ref, offset: ref.offset + 1, total: ref.total + 1 }
      : ref);
    const bumped = carryContentHydration(turn, { ...turn, contentRefs });
    if (!noteHiddenStructuralInsert(turn, bumped, op.frame.frameId)) {
      return { state, changed: false, toolCallCountDelta: 0 };
    }
    const items = located !== undefined
      ? replaceItemAt(state.items, located.index, bumped, scratch)
      : insertTurn(state.items, bumped, scratch);
    return { state: { ...state, items }, changed: true, toolCallCountDelta: 0 };
  }
  let dupStepIndex = -1;
  let dupFrame: ToolCallFrame | undefined;
  if (op.frame.kind === 'tool') {
    const targetToolCallId = op.frame.toolCallId;
    const targetFrameId = op.frame.frameId;
    for (let s = 0; s < turn.steps.length; s += 1) {
      const candidateStep = turn.steps[s]!;
      const hit = candidateStep.frames.find(
        (entry): entry is ToolCallFrame =>
          entry.kind === 'tool' &&
          entry.toolCallId === targetToolCallId &&
          (candidateStep.stepId !== op.stepId || entry.frameId !== targetFrameId),
      );
      if (hit !== undefined) {
        dupStepIndex = s;
        dupFrame = hit;
        break;
      }
    }
  }
  let frames: TranscriptFrame[];
  let toolCallCount = state.toolCallCount;
  let toolCallCountDelta = 0;
  if (frameIndex >= 0) {
    const current = step.frames[frameIndex];
    const baseIncoming = current === undefined ? op.frame : mergeContentPreview(current, op.frame);
    const incoming =
      baseIncoming.kind === 'tool'
        ? current?.kind === 'tool'
          ? mergeToolCallFrame(current, baseIncoming)
          : dupFrame !== undefined
            ? mergeToolCallFrame(dupFrame, baseIncoming)
            : baseIncoming
        : baseIncoming;
    if (dupFrame === undefined && current !== undefined && frameEquals(current, incoming)) {
      return { state, changed: false, toolCallCountDelta: 0 };
    }
    if (current !== undefined && (current.kind === 'tool') !== (incoming.kind === 'tool')) {
      toolCallCountDelta = incoming.kind === 'tool' ? 1 : -1;
      toolCallCount = adjustToolCallCount(toolCallCount, toolCallCountDelta);
    }
    if (dupFrame !== undefined) {
      toolCallCountDelta -= 1;
      toolCallCount = adjustToolCallCount(toolCallCount, -1);
    }
    frames = replaceAt(step.frames, frameIndex, incoming);
    if (dupStepIndex === stepIndex && dupFrame !== undefined) {
      frames = frames.filter((entry) => entry.frameId !== dupFrame.frameId);
    }
  } else {
    const incoming =
      op.frame.kind === 'tool' && dupFrame !== undefined
        ? mergeToolCallFrame(dupFrame, op.frame)
        : op.frame;
    if (incoming.kind === 'tool' && dupFrame === undefined) {
      toolCallCountDelta = 1;
      toolCallCount = adjustToolCallCount(toolCallCount, 1);
    }
    const baseFrames = dupStepIndex === stepIndex && dupFrame !== undefined
      ? step.frames.filter((entry) => entry.frameId !== dupFrame.frameId)
      : step.frames;
    const omittedOffset = omittedFrames?.offset;
    let index = baseFrames.length;
    if (op.place === 'safety_boundary') {
      if (omittedOffset === undefined || omittedOffset === 0) index = safetyBoundaryIndex(baseFrames);
      else if (op.frameIndex !== undefined) index = Math.min(baseFrames.length, Math.max(0, op.frameIndex - omittedOffset));
    }
    frames = index >= baseFrames.length
      ? [...baseFrames, incoming]
      : [...baseFrames.slice(0, index), incoming, ...baseFrames.slice(index)];
  }
  const nextStep: TranscriptStep = { ...step, frames };
  let baseSteps = turn.steps;
  if (dupStepIndex >= 0 && dupStepIndex !== stepIndex && dupFrame !== undefined) {
    const dupStep = turn.steps[dupStepIndex]!;
    baseSteps = replaceStepAt(turn.steps, dupStepIndex, {
      ...dupStep,
      frames: dupStep.frames.filter((entry) => entry.frameId !== dupFrame.frameId),
    }, scratch);
  }
  const steps =
    stepIndex >= 0
      ? replaceStepAt(baseSteps, stepIndex, nextStep, scratch)
      : insertStepOrdered(baseSteps, nextStep, scratch);
  const nextTurn: TranscriptTurn = carryContentHydration(turn, { ...turn, steps });
  const items =
    located !== undefined
      ? replaceItemAt(state.items, located.index, nextTurn, scratch)
      : insertTurn(state.items, nextTurn, scratch);
  return {
    state: { ...state, items, toolCallCount },
    changed: true,
    toolCallCountDelta,
  };
}

function applyFrameRemove(
  state: AgentState,
  op: Extract<TranscriptOperation, { op: 'frame.remove' }>,
  scratch?: ApplyBatchScratch,
): ApplyResult {
  const located = findTurn(state.items, op.turnId);
  const stepIndex = located === undefined ? -1 : findStepIndex(located.turn.steps, op.stepId);
  const step = located?.turn.steps[stepIndex];
  const frame = step?.frames.find((entry) => entry.frameId === op.frameId);
  if (located === undefined || step === undefined || frame === undefined) {
    return { state, changed: false, toolCallCountDelta: 0 };
  }
  const toolCallCountDelta = frame.kind === 'tool' ? -1 : 0;
  const nextStep = { ...step, frames: step.frames.filter((entry) => entry.frameId !== op.frameId) };
  const nextTurn = carryContentHydration(located.turn, {
    ...located.turn,
    steps: replaceStepAt(located.turn.steps, stepIndex, nextStep, scratch),
  });
  return {
    state: {
      ...state,
      items: replaceItemAt(state.items, located.index, nextTurn, scratch),
      toolCallCount: adjustToolCallCount(state.toolCallCount, toolCallCountDelta),
    },
    changed: true,
    toolCallCountDelta,
  };
}

function frameEquals(a: TranscriptFrame, b: TranscriptFrame): boolean {
  return transcriptValueEquals(a, b);
}

function applyAppend(state: AgentState, op: AppendOp, scratch?: ApplyBatchScratch): ApplyResult {
  if (op.target.type === 'task') return applyTaskAppend(state, op);
  const { turnId, stepId, frameId } = op.target;
  const located = findTurn(state.items, turnId);
  if (located === undefined) {
    return { state, changed: false, gap: { expected: 0, got: op.offset } };
  }
  const turn = located.turn;
  const stepIndex = findStepIndex(turn.steps, stepId);
  const step = turn.steps[stepIndex];
  const frameIndex = step?.frames.findIndex((entry) => entry.frameId === frameId) ?? -1;
  const frame = step?.frames[frameIndex];
  if (frame === undefined && (op.stepIndex !== undefined && turn.contentRefs?.some((ref) => ref.direction === 'backward' &&
    ref.path.length === 1 && ref.path[0] === 'steps' && op.stepIndex! < ref.offset) ||
    op.frameIndex !== undefined && turn.contentRefs?.some((ref) => ref.direction === 'backward' && ref.path.length === 3 &&
      ref.path[0] === 'steps' && ref.path[1] === (op.stepIndex ?? step?.ordinal) && ref.path[2] === 'frames' && op.frameIndex! < ref.offset))) {
    return { state, changed: false, toolCallCountDelta: 0 };
  }
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
  const nextTurn: TranscriptTurn = carryContentHydration(turn, {
    ...turn,
    steps: replaceStepAt(turn.steps, stepIndex, nextStep, scratch),
  });
  return {
    state: { ...state, items: replaceItemAt(state.items, located.index, nextTurn, scratch) },
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
  scratch?: ApplyBatchScratch,
): ApplyResult {
  const existingIndex = findItemIndex(state.items, id);
  if (existingIndex >= 0) {
    const existing = state.items[existingIndex];
    const resolved = item.kind === 'taskref' && existing?.kind === 'taskref'
      ? { ...item, at: earlierIsoAt(existing.at, item.at) }
      : item;
    if (existing === resolved || (existing !== undefined && transcriptValueEquals(existing, resolved))) {
      return { state, changed: false };
    }
    return { state: { ...state, items: replaceItemAt(state.items, existingIndex, resolved, scratch) }, changed: true };
  }
  const reusable = scratch !== undefined && scratch.ownedItems === state.items;
  if (beforeTurn !== undefined) {
    const items = reusable ? (state.items as TranscriptItem[]) : [...state.items];
    let at = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const entry = items[i];
      if (entry?.kind === 'turn' && entry.ordinal >= beforeTurn) {
        at = i;
        break;
      }
    }
    items.splice(at, 0, item);
    if (reusable) itemIndexByItems.delete(items);
    else if (scratch !== undefined) scratch.ownedItems = items;
    return { state: { ...state, items }, changed: true };
  }
  const items = reusable ? (state.items as TranscriptItem[]) : [...state.items];
  items.push(item);
  if (reusable) {
    const map = itemIndexByItems.get(items);
    if (map !== undefined) map.set(id, items.length - 1);
  } else if (scratch !== undefined) {
    scratch.ownedItems = items;
  }
  return { state: { ...state, items }, changed: true };
}

function earlierIsoAt(left?: string, right?: string): string | undefined {
  if (left === undefined || left === '') return right;
  if (right === undefined || right === '') return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs)) return right;
  if (Number.isNaN(rightMs)) return left;
  return leftMs <= rightMs ? left : right;
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
  const existingIds = state.hasMoreOlder ? getItemIndexMap(state.items) : undefined;
  const unseenTurnRemoved =
    state.hasMoreOlder &&
    ids.some(
      (id) => !existingIds!.has(id) && !priorRemovedItemIds.has(id),
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
        }
      : state.meta.modes;
  const agent =
    meta.agent !== undefined ? { ...state.meta.agent, ...meta.agent } : state.meta.agent;
  const next: TranscriptMeta = {
    goal: meta.goal === null ? undefined : (meta.goal ?? state.meta.goal),
    activity: meta.activity ?? state.meta.activity,
    modes: modes !== undefined && modes.plan === undefined ? undefined : modes,
    agent,
    promptQueueHold:
      meta.promptQueueHold === null
        ? undefined
        : (meta.promptQueueHold ?? state.meta.promptQueueHold),
    modelSwitchQueuePositions:
      meta.modelSwitchQueuePositions === null
        ? undefined
        : (meta.modelSwitchQueuePositions ?? state.meta.modelSwitchQueuePositions),
  };
  if (transcriptValueEquals(next, state.meta)) return { state, changed: false };
  return { state: { ...state, meta: next }, changed: true };
}

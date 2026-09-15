import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { AgentId, InteractionId } from '../model/ids';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem } from '../model/item';
import type { TranscriptMeta } from '../model/meta';
import type { TranscriptPrompt } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TranscriptTodo } from '../model/todo';
import type { TranscriptStep, TranscriptTurn } from '../model/turn';
import { appendAtOffset, applyOperation, type AgentState } from '../ops/apply';
import { transcriptValueEquals } from '../ops/equality';
import type {
  AgentTranscriptSnapshot,
  AppendOp,
  AppendTarget,
  AppliedOps,
  StepHeader,
  TranscriptCoverage,
  TranscriptOperation,
  TurnHeader,
} from '../ops/operation';
import type { TranscriptToolCallLookup } from './agentTranscript';

interface DraftOperationResult {
  readonly changed: boolean;
  readonly toolCallCountDelta?: number;
  readonly gap?: { readonly expected: number; readonly got: number };
}

interface CoalescedRun {
  readonly op: TranscriptOperation;
  readonly originals: readonly TranscriptOperation[];
  readonly nextIndex: number;
}

interface TimelineNode {
  item: TranscriptItem;
  previous?: TimelineNode;
  next?: TimelineNode;
}

interface TurnOrderNode {
  readonly turnId: string;
  readonly ordinal: number;
  readonly sequence: number;
  readonly priority: number;
  readonly timeline: TimelineNode;
  left?: TurnOrderNode;
  right?: TurnOrderNode;
}

class TurnOrderIndex {
  #root: TurnOrderNode | undefined;
  readonly #byId = new Map<string, TurnOrderNode>();
  #sequence = 0;
  #randomState = 0x9e3779b9;

  insert(turnId: string, ordinal: number, timeline: TimelineNode): void {
    const node: TurnOrderNode = {
      turnId,
      ordinal,
      sequence: this.#sequence++,
      priority: this.nextPriority(),
      timeline,
    };
    this.#root = insertTurnOrderNode(this.#root, node);
    this.#byId.set(turnId, node);
  }

  remove(turnId: string): void {
    const node = this.#byId.get(turnId);
    if (node === undefined) return;
    this.#root = removeTurnOrderNode(this.#root, node);
    this.#byId.delete(turnId);
  }

  lowerBound(ordinal: number): TurnOrderNode | undefined {
    let current = this.#root;
    let candidate: TurnOrderNode | undefined;
    while (current !== undefined) {
      if (current.ordinal >= ordinal) {
        candidate = current;
        current = current.left;
      } else {
        current = current.right;
      }
    }
    return candidate;
  }

  upperBound(ordinal: number): TurnOrderNode | undefined {
    let current = this.#root;
    let candidate: TurnOrderNode | undefined;
    while (current !== undefined) {
      if (current.ordinal > ordinal) {
        candidate = current;
        current = current.left;
      } else {
        current = current.right;
      }
    }
    return candidate;
  }

  clear(): void {
    this.#root = undefined;
    this.#byId.clear();
    this.#sequence = 0;
    this.#randomState = 0x9e3779b9;
  }

  private nextPriority(): number {
    let value = this.#randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#randomState = value < 0 ? value + 0x1_0000_0000 : value;
    return this.#randomState;
  }
}

export class AgentTranscriptDraft {
  #head: TimelineNode | undefined;
  #tail: TimelineNode | undefined;
  readonly #itemNodes = new Map<string, TimelineNode>();
  readonly #turns = new Map<string, TranscriptTurn>();
  readonly #turnOrder = new TurnOrderIndex();
  readonly #steps = new Map<string, TranscriptStep>();
  readonly #frames = new Map<string, TranscriptFrame>();
  readonly #tools = new Map<string, TranscriptToolCallLookup>();
  #tasks = new Map<string, TranscriptTask>();
  #interactions = new Map<string, TranscriptInteraction>();
  #attachments = new Map<string, TranscriptAttachment>();
  #todos = new Map<string, TranscriptTodo>();
  #prompts = new Map<string, TranscriptPrompt>();
  #pendingInteractions = new Set<InteractionId>();
  #toolCallCount: number | undefined = 0;
  #meta: TranscriptMeta = {};
  #hasMoreOlder = false;
  readonly #appendDirty = new Set<string>();
  readonly #removedItemIds = new Set<string>();
  #snapshot: AgentTranscriptSnapshot | undefined;

  constructor(readonly agentId: AgentId) {}

  apply(ops: readonly TranscriptOperation[]): AppliedOps {
    if (this.#snapshot !== undefined) throw new Error('transcript draft is already materialized');
    const accepted: TranscriptOperation[] = [];
    let gap: AppliedOps['gap'];
    let toolCallCountDelta = 0;
    let toolCallCountDeltaKnown = true;
    for (let index = 0; index < ops.length;) {
      const first = ops[index];
      if (first === undefined) break;
      const run = this.coalesceAppendRun(ops, index);
      const result = this.applyOperation(run.op);
      if (result.gap !== undefined) {
        gap = { target: (run.op as { target: AppendTarget }).target, ...result.gap };
        index = run.nextIndex;
        continue;
      }
      if (result.toolCallCountDelta === undefined) {
        toolCallCountDeltaKnown = false;
      } else if (result.changed && toolCallCountDeltaKnown) {
        toolCallCountDelta += result.toolCallCountDelta;
      }
      const key = appendTargetKey(run.op);
      if (!result.changed) {
        if (
          key !== undefined &&
          (run.op.op === 'frame.upsert' || run.op.op === 'task.upsert') &&
          this.#appendDirty.delete(key)
        ) {
          accepted.push(...run.originals);
        }
        index = run.nextIndex;
        continue;
      }
      accepted.push(...run.originals);
      if (run.op.op === 'append' && key !== undefined) this.#appendDirty.add(key);
      else if (key !== undefined) this.#appendDirty.delete(key);
      else if (run.op.op === 'reset' || run.op.op === 'items.remove') this.#appendDirty.clear();
      index = run.nextIndex;
    }
    return {
      accepted,
      toolCallCountDelta: toolCallCountDeltaKnown ? toolCallCountDelta : undefined,
      gap,
    };
  }

  getTurn(turnId: string): TranscriptTurn | undefined {
    return this.#turns.get(turnId);
  }

  getTask(taskId: string): TranscriptTask | undefined {
    return this.#tasks.get(taskId);
  }

  getToolCall(toolCallId: string): TranscriptToolCallLookup | undefined {
    return this.#tools.get(toolCallId);
  }

  snapshot(): AgentTranscriptSnapshot {
    if (this.#snapshot !== undefined) return this.#snapshot;
    const items = this.materializeItems(true);
    this.#snapshot = {
      items,
      tasks: [...this.#tasks.values()],
      interactions: [...this.#interactions.values()],
      attachments: [...this.#attachments.values()],
      todos: [...this.#todos.values()],
      prompts: [...this.#prompts.values()],
      toolCallCount: this.#toolCallCount,
      toolCallCountKnown: this.#toolCallCount !== undefined,
      meta: this.#meta,
      hasMoreOlder: this.#hasMoreOlder,
    };
    return this.#snapshot;
  }

  private applyOperation(op: TranscriptOperation): DraftOperationResult {
    switch (op.op) {
      case 'reset':
        return this.applyReset(op);
      case 'turn.upsert':
        return this.applyTurnUpsert(op.turn);
      case 'step.upsert':
        return this.applyStepUpsert(op.turnId, op.step);
      case 'frame.upsert':
        return this.applyFrameUpsert(op.turnId, op.stepId, op.frame);
      case 'tool.count.set':
        return this.applyToolCountSet(op.count);
      case 'append':
        return this.applyAppend(op);
      case 'marker.upsert':
        return this.applyItemUpsert(op.item, op.item.markerId, op.beforeTurn);
      case 'taskref.upsert':
        return this.applyItemUpsert(op.item, op.item.refId, op.beforeTurn);
      case 'task.upsert':
        return this.applyEntityUpsert(this.#tasks, op.task.taskId, op.task);
      case 'interaction.upsert':
        return this.applyInteractionUpsert(op.interaction);
      case 'attachment.upsert':
        return this.applyEntityUpsert(this.#attachments, op.attachment.attachmentId, op.attachment);
      case 'todo.upsert':
        return this.applyEntityUpsert(this.#todos, op.todo.todoId, op.todo);
      case 'prompt.upsert':
        return this.applyEntityUpsert(this.#prompts, op.prompt.promptId, op.prompt);
      case 'meta.merge':
        return this.applyMetaMerge(op.meta);
      case 'items.remove':
        return this.applyItemsRemove(op.ids);
    }
  }

  private applyReset(op: Extract<TranscriptOperation, { op: 'reset' }>): DraftOperationResult {
    const result = applyOperation(this.agentState(), op);
    if (!result.changed) return { changed: false, toolCallCountDelta: result.toolCallCountDelta };
    this.loadState(result.state);
    const coverage = op.coverage ?? fullCoverage(op.snapshot.hasMoreOlder ?? false);
    if (coverage.kind === 'full') this.#removedItemIds.clear();
    return { changed: true, toolCallCountDelta: result.toolCallCountDelta };
  }

  private applyTurnUpsert(header: TurnHeader): DraftOperationResult {
    const current = this.#turns.get(header.turnId);
    if (current !== undefined) {
      const { steps, ...currentHeader } = current;
      if (transcriptValueEquals(currentHeader, header)) return { changed: false, toolCallCountDelta: 0 };
      this.replaceTurn({ ...header, steps });
      return { changed: true, toolCallCountDelta: 0 };
    }
    this.insertTurn({ ...header, steps: [] });
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyStepUpsert(turnId: string, header: StepHeader): DraftOperationResult {
    const turn = this.#turns.get(turnId) ?? skeletonTurn(turnId);
    const key = stepKey(turnId, header.stepId);
    const current = this.#steps.get(key);
    if (current !== undefined) {
      const { frames, ...currentHeader } = current;
      if (transcriptValueEquals(currentHeader, header)) return { changed: false, toolCallCountDelta: 0 };
      const nextStep: TranscriptStep = { ...header, frames };
      const stepIndex = turn.steps.findIndex((step) => step.stepId === header.stepId);
      const steps = [...turn.steps];
      steps[stepIndex] = nextStep;
      this.replaceOrInsertTurn({ ...turn, steps });
      this.#steps.set(key, nextStep);
      return { changed: true, toolCallCountDelta: 0 };
    }
    const nextStep: TranscriptStep = { ...header, frames: [] };
    const steps = [...turn.steps, nextStep].toSorted((a, b) => a.ordinal - b.ordinal);
    this.replaceOrInsertTurn({ ...turn, steps });
    this.#steps.set(key, nextStep);
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyFrameUpsert(
    turnId: string,
    stepId: string,
    frame: TranscriptFrame,
  ): DraftOperationResult {
    const turn = this.#turns.get(turnId) ?? skeletonTurn(turnId);
    const stepMapKey = stepKey(turnId, stepId);
    const step = this.#steps.get(stepMapKey) ?? skeletonStep(stepId, turnId);
    const frameMapKey = frameKey(turnId, stepId, frame.frameId);
    const current = this.#frames.get(frameMapKey);
    if (current !== undefined && transcriptValueEquals(current, frame)) {
      return { changed: false, toolCallCountDelta: 0 };
    }
    let toolCallCountDelta = 0;
    if (current !== undefined && (current.kind === 'tool') !== (frame.kind === 'tool')) {
      toolCallCountDelta = frame.kind === 'tool' ? 1 : -1;
      this.#toolCallCount = adjustToolCallCount(this.#toolCallCount, toolCallCountDelta);
    } else if (current === undefined && frame.kind === 'tool') {
      toolCallCountDelta = 1;
      this.#toolCallCount = adjustToolCallCount(this.#toolCallCount, 1);
    }
    if (current?.kind === 'tool' && (frame.kind !== 'tool' || frame.toolCallId !== current.toolCallId)) {
      this.#tools.delete(current.toolCallId);
    }
    const frameIndex = step.frames.findIndex((entry) => entry.frameId === frame.frameId);
    const frames = [...step.frames];
    if (frameIndex >= 0) frames[frameIndex] = frame;
    else frames.push(frame);
    const nextStep: TranscriptStep = { ...step, frames };
    const stepIndex = turn.steps.findIndex((entry) => entry.stepId === stepId);
    const steps = [...turn.steps];
    if (stepIndex >= 0) steps[stepIndex] = nextStep;
    else {
      steps.push(nextStep);
      steps.sort((a, b) => a.ordinal - b.ordinal);
    }
    this.replaceOrInsertTurn({ ...turn, steps });
    this.#steps.set(stepMapKey, nextStep);
    this.#frames.set(frameMapKey, frame);
    if (frame.kind === 'tool') this.#tools.set(frame.toolCallId, { turnId, stepId, frame });
    return { changed: true, toolCallCountDelta };
  }

  private applyToolCountSet(count: number | undefined): DraftOperationResult {
    if (this.#toolCallCount === count) return { changed: false, toolCallCountDelta: undefined };
    this.#toolCallCount = count;
    return { changed: true, toolCallCountDelta: undefined };
  }

  private applyAppend(op: AppendOp): DraftOperationResult {
    if (op.target.type === 'task') {
      const task = this.#tasks.get(op.target.taskId);
      const current = task?.outputTail ?? '';
      const merged = appendAtOffset(current, op.offset, op.text);
      if (merged.gap !== undefined) return { changed: false, gap: merged.gap, toolCallCountDelta: 0 };
      if (!merged.changed) return { changed: false, toolCallCountDelta: 0 };
      const nextTask = task === undefined
        ? { taskId: op.target.taskId, kind: 'other' as const, state: 'running' as const, detached: false, outputTail: merged.text }
        : { ...task, outputTail: merged.text };
      this.#tasks.set(op.target.taskId, nextTask);
      return { changed: true, toolCallCountDelta: 0 };
    }
    const frameMapKey = frameKey(op.target.turnId, op.target.stepId, op.target.frameId);
    const frame = this.#frames.get(frameMapKey);
    if (frame === undefined || (frame.kind !== 'text' && frame.kind !== 'thinking')) {
      return { changed: false, gap: { expected: 0, got: op.offset }, toolCallCountDelta: 0 };
    }
    const merged = appendAtOffset(frame.text, op.offset, op.text);
    if (merged.gap !== undefined) return { changed: false, gap: merged.gap, toolCallCountDelta: 0 };
    if (!merged.changed) return { changed: false, toolCallCountDelta: 0 };
    return this.applyFrameUpsert(op.target.turnId, op.target.stepId, { ...frame, text: merged.text });
  }

  private applyItemUpsert(
    item: TranscriptItem,
    id: string,
    beforeTurn: number | undefined,
  ): DraftOperationResult {
    const existing = this.#itemNodes.get(id);
    if (existing !== undefined) {
      if (existing.item === item || transcriptValueEquals(existing.item, item)) {
        return { changed: false, toolCallCountDelta: 0 };
      }
      existing.item = item;
      return { changed: true, toolCallCountDelta: 0 };
    }
    const before = beforeTurn === undefined ? undefined : this.#turnOrder.lowerBound(beforeTurn)?.timeline;
    this.insertTimelineItem(item, before);
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyEntityUpsert<V>(map: Map<string, V>, id: string, value: V): DraftOperationResult {
    const current = map.get(id);
    if (current !== undefined && transcriptValueEquals(current, value)) {
      return { changed: false, toolCallCountDelta: 0 };
    }
    map.set(id, value);
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyInteractionUpsert(interaction: TranscriptInteraction): DraftOperationResult {
    const current = this.#interactions.get(interaction.interactionId);
    if (current !== undefined && transcriptValueEquals(current, interaction)) {
      return { changed: false, toolCallCountDelta: 0 };
    }
    this.#interactions.set(interaction.interactionId, interaction);
    if (interaction.state === 'pending') this.#pendingInteractions.add(interaction.interactionId);
    else this.#pendingInteractions.delete(interaction.interactionId);
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyMetaMerge(meta: Extract<TranscriptOperation, { op: 'meta.merge' }>['meta']): DraftOperationResult {
    const modes = meta.modes !== undefined
      ? {
          plan: meta.modes.plan === null ? undefined : (meta.modes.plan ?? this.#meta.modes?.plan),
          swarm: meta.modes.swarm === null ? undefined : (meta.modes.swarm ?? this.#meta.modes?.swarm),
        }
      : this.#meta.modes;
    const agent = meta.agent !== undefined ? { ...this.#meta.agent, ...meta.agent } : this.#meta.agent;
    const next: TranscriptMeta = {
      goal: meta.goal === null ? undefined : (meta.goal ?? this.#meta.goal),
      activity: meta.activity ?? this.#meta.activity,
      modes: modes !== undefined && modes.plan === undefined && modes.swarm === undefined ? undefined : modes,
      agent,
    };
    if (transcriptValueEquals(next, this.#meta)) return { changed: false, toolCallCountDelta: 0 };
    this.#meta = next;
    return { changed: true, toolCallCountDelta: 0 };
  }

  private applyItemsRemove(ids: readonly string[]): DraftOperationResult {
    const drop = new Set(ids);
    const removedTurns: TranscriptTurn[] = [];
    for (const id of drop) {
      const item = this.#itemNodes.get(id)?.item;
      if (item?.kind === 'turn') removedTurns.push(item);
    }
    const removedToolCallCount = countToolCallFrames(removedTurns);
    const unseenTurnRemoved = this.#hasMoreOlder && ids.some(
      (id) => !this.#itemNodes.has(id) && !this.#removedItemIds.has(id),
    );
    const toolCallCountDelta = unseenTurnRemoved
      ? undefined
      : removedToolCallCount === 0
        ? 0
        : -removedToolCallCount;
    const nextToolCallCount = unseenTurnRemoved
      ? undefined
      : adjustToolCallCount(this.#toolCallCount, -removedToolCallCount);
    const itemsChanged = ids.some((id) => this.#itemNodes.has(id));
    const toolCallCountChanged = nextToolCallCount !== this.#toolCallCount;
    for (const id of ids) this.rememberRemovedItemId(id);
    if (!itemsChanged && !toolCallCountChanged) {
      return unseenTurnRemoved
        ? { changed: true, toolCallCountDelta }
        : { changed: false, toolCallCountDelta };
    }
    if (removedTurns.length > 0) {
      const anchoredToolCallIds = new Set<string>();
      for (const turn of removedTurns) {
        for (const step of turn.steps) {
          for (const frame of step.frames) {
            if (frame.kind === 'tool') anchoredToolCallIds.add(frame.toolCallId);
          }
        }
      }
      for (const [interactionId, interaction] of this.#interactions) {
        if (interaction.toolCallId !== undefined && anchoredToolCallIds.has(interaction.toolCallId)) {
          this.#interactions.delete(interactionId);
          this.#pendingInteractions.delete(interactionId);
        }
      }
    }
    if (itemsChanged) {
      for (const id of drop) this.removeTimelineItem(id);
    }
    this.#toolCallCount = nextToolCallCount;
    return { changed: true, toolCallCountDelta };
  }

  private coalesceAppendRun(ops: readonly TranscriptOperation[], start: number): CoalescedRun {
    const first = ops[start];
    if (first === undefined) throw new RangeError('operation index out of bounds');
    if (
      first.op !== 'append' ||
      first.text.length === 0 ||
      this.appendTargetLength(first.target) !== first.offset
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
    return originals.length === 1
      ? { op: first, originals, nextIndex: index }
      : { op: { ...first, text: chunks.join('') }, originals, nextIndex: index };
  }

  private appendTargetLength(target: AppendTarget): number | undefined {
    if (target.type === 'task') return this.#tasks.get(target.taskId)?.outputTail?.length ?? 0;
    const frame = this.#frames.get(frameKey(target.turnId, target.stepId, target.frameId));
    return frame?.kind === 'text' || frame?.kind === 'thinking' ? frame.text.length : undefined;
  }

  private insertTurn(turn: TranscriptTurn): void {
    const before = this.#turnOrder.upperBound(turn.ordinal)?.timeline;
    const timeline = this.insertTimelineItem(turn, before);
    this.#turns.set(turn.turnId, turn);
    this.#turnOrder.insert(turn.turnId, turn.ordinal, timeline);
  }

  private replaceTurn(turn: TranscriptTurn): void {
    const timeline = this.#itemNodes.get(turn.turnId);
    if (timeline === undefined) {
      this.insertTurn(turn);
      return;
    }
    timeline.item = turn;
    this.#turns.set(turn.turnId, turn);
  }

  private replaceOrInsertTurn(turn: TranscriptTurn): void {
    if (this.#turns.has(turn.turnId)) this.replaceTurn(turn);
    else this.insertTurn(turn);
  }

  private insertTimelineItem(item: TranscriptItem, before?: TimelineNode): TimelineNode {
    const node: TimelineNode = { item };
    if (before === undefined) {
      node.previous = this.#tail;
      if (this.#tail === undefined) this.#head = node;
      else this.#tail.next = node;
      this.#tail = node;
    } else {
      node.previous = before.previous;
      node.next = before;
      if (before.previous === undefined) this.#head = node;
      else before.previous.next = node;
      before.previous = node;
    }
    this.#itemNodes.set(itemIdOf(item), node);
    return node;
  }

  private removeTimelineItem(id: string): void {
    const node = this.#itemNodes.get(id);
    if (node === undefined) return;
    if (node.previous === undefined) this.#head = node.next;
    else node.previous.next = node.next;
    if (node.next === undefined) this.#tail = node.previous;
    else node.next.previous = node.previous;
    this.#itemNodes.delete(id);
    if (node.item.kind !== 'turn') return;
    const turn = node.item;
    this.#turns.delete(turn.turnId);
    this.#turnOrder.remove(turn.turnId);
    for (const step of turn.steps) {
      this.#steps.delete(stepKey(turn.turnId, step.stepId));
      for (const frame of step.frames) {
        this.#frames.delete(frameKey(turn.turnId, step.stepId, frame.frameId));
        if (frame.kind === 'tool') this.#tools.delete(frame.toolCallId);
      }
    }
  }

  private materializeItems(cloneTurns: boolean): TranscriptItem[] {
    const items: TranscriptItem[] = [];
    let current = this.#head;
    while (current !== undefined) {
      const item = current.item;
      items.push(
        cloneTurns && item.kind === 'turn'
          ? { ...item, steps: item.steps.map((step) => ({ ...step, frames: [...step.frames] })) }
          : item,
      );
      current = current.next;
    }
    return items;
  }

  private clearTimeline(): void {
    this.#head = undefined;
    this.#tail = undefined;
    this.#itemNodes.clear();
    this.#turns.clear();
    this.#turnOrder.clear();
    this.#steps.clear();
    this.#frames.clear();
    this.#tools.clear();
  }

  private agentState(): AgentState {
    return {
      items: this.materializeItems(false),
      tasks: this.#tasks,
      interactions: this.#interactions,
      attachments: this.#attachments,
      todos: this.#todos,
      prompts: this.#prompts,
      toolCallCount: this.#toolCallCount,
      meta: this.#meta,
      pendingInteractions: this.#pendingInteractions,
      hasMoreOlder: this.#hasMoreOlder,
    };
  }

  private loadState(state: AgentState): void {
    this.clearTimeline();
    for (const source of state.items) {
      const item: TranscriptItem = source.kind === 'turn'
        ? { ...source, steps: source.steps.map((step) => ({ ...step, frames: [...step.frames] })) }
        : source;
      const timeline = this.insertTimelineItem(item);
      if (item.kind !== 'turn') continue;
      this.#turns.set(item.turnId, item);
      this.#turnOrder.insert(item.turnId, item.ordinal, timeline);
      for (const step of item.steps) {
        this.#steps.set(stepKey(item.turnId, step.stepId), step);
        for (const frame of step.frames) {
          this.#frames.set(frameKey(item.turnId, step.stepId, frame.frameId), frame);
          if (frame.kind === 'tool') {
            this.#tools.set(frame.toolCallId, { turnId: item.turnId, stepId: step.stepId, frame });
          }
        }
      }
    }
    this.#tasks = new Map(state.tasks);
    this.#interactions = new Map(state.interactions);
    this.#attachments = new Map(state.attachments);
    this.#todos = new Map(state.todos);
    this.#prompts = new Map(state.prompts);
    this.#pendingInteractions = new Set(state.pendingInteractions);
    this.#toolCallCount = state.toolCallCount;
    this.#meta = state.meta;
    this.#hasMoreOlder = state.hasMoreOlder;
  }

  private rememberRemovedItemId(id: string): void {
    this.#removedItemIds.add(id);
    if (this.#removedItemIds.size <= 2_048) return;
    const oldest = this.#removedItemIds.values().next().value;
    if (oldest !== undefined) this.#removedItemIds.delete(oldest);
  }
}

function compareTurnOrder(left: TurnOrderNode, right: TurnOrderNode): number {
  if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
  return left.sequence - right.sequence;
}

function splitTurnOrder(
  root: TurnOrderNode | undefined,
  pivot: TurnOrderNode,
): [TurnOrderNode | undefined, TurnOrderNode | undefined] {
  if (root === undefined) return [undefined, undefined];
  if (compareTurnOrder(root, pivot) < 0) {
    const [left, right] = splitTurnOrder(root.right, pivot);
    root.right = left;
    return [root, right];
  }
  const [left, right] = splitTurnOrder(root.left, pivot);
  root.left = right;
  return [left, root];
}

function insertTurnOrderNode(
  root: TurnOrderNode | undefined,
  node: TurnOrderNode,
): TurnOrderNode {
  if (root === undefined) return node;
  if (node.priority < root.priority) {
    const [left, right] = splitTurnOrder(root, node);
    node.left = left;
    node.right = right;
    return node;
  }
  if (compareTurnOrder(node, root) < 0) root.left = insertTurnOrderNode(root.left, node);
  else root.right = insertTurnOrderNode(root.right, node);
  return root;
}

function mergeTurnOrder(
  left: TurnOrderNode | undefined,
  right: TurnOrderNode | undefined,
): TurnOrderNode | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  if (left.priority < right.priority) {
    left.right = mergeTurnOrder(left.right, right);
    return left;
  }
  right.left = mergeTurnOrder(left, right.left);
  return right;
}

function removeTurnOrderNode(
  root: TurnOrderNode | undefined,
  target: TurnOrderNode,
): TurnOrderNode | undefined {
  if (root === undefined) return undefined;
  const comparison = compareTurnOrder(target, root);
  if (comparison < 0) root.left = removeTurnOrderNode(root.left, target);
  else if (comparison > 0) root.right = removeTurnOrderNode(root.right, target);
  else return mergeTurnOrder(root.left, root.right);
  return root;
}

function skeletonTurn(turnId: string): TranscriptTurn {
  const ordinal = Number(turnId.slice(1));
  return {
    kind: 'turn',
    turnId,
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
    state: 'running',
    origin: { kind: 'other' },
    steps: [],
  };
}

function skeletonStep(stepId: string, turnId: string): TranscriptStep {
  const ordinal = Number(stepId.slice(turnId.length + 1)) || 0;
  return { kind: 'step', stepId, turnId, ordinal, state: 'running', frames: [] };
}

function itemIdOf(item: TranscriptItem): string {
  if (item.kind === 'turn') return item.turnId;
  if (item.kind === 'marker') return item.markerId;
  return item.refId;
}

function stepKey(turnId: string, stepId: string): string {
  return `${turnId}\u0000${stepId}`;
}

function frameKey(turnId: string, stepId: string, frameId: string): string {
  return `${turnId}\u0000${stepId}\u0000${frameId}`;
}

function countToolCallFrames(turns: readonly TranscriptTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    for (const step of turn.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') count += 1;
      }
    }
  }
  return count;
}

function adjustToolCallCount(count: number | undefined, delta: number): number | undefined {
  return count === undefined ? undefined : Math.max(0, count + delta);
}

function fullCoverage(hasMoreOlder: boolean): TranscriptCoverage {
  return hasMoreOlder
    ? { kind: 'tail', hasMoreOlder: true }
    : { kind: 'full', hasMoreOlder: false };
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

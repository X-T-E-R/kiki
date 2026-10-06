import {
  itemId,
  jsonBytes,
  rebindTurnContentRefs,
  type AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
  type TranscriptResponse,
} from '@kiki/transcript';
import { boundedEntity, ENTITY_BYTES } from './boundedContent';
import { inlineMediaId } from '../../services/inlineMedia';
import type { TranscriptAttachment } from '@kiki/transcript';

export function boundedAttachment(attachment: TranscriptAttachment, agentId: string, maxBytes?: number): TranscriptAttachment {
  const fileId = inlineMediaId(attachment, agentId);
  const entity = fileId === undefined ? attachment : { ...attachment, source: { kind: 'session_media' as const, fileId } };
  return boundedEntity(entity, { kind: 'attachment', id: attachment.attachmentId }, maxBytes);
}

export const TRANSCRIPT_WINDOW_BYTES = 1024 * 1024;
const GLOBAL_COLLECTION_BYTES = 4 * 1024;

export function boundedTranscriptSnapshot(snapshot: AgentTranscriptSnapshot, agentId: string, direction: 'head' | 'tail' = 'tail', windowBytes = TRANSCRIPT_WINDOW_BYTES): AgentTranscriptSnapshot {
  const tasks = boundedCollection(snapshot.tasks, 'task', (task) => task.taskId);
  const prompts = boundedCollection(snapshot.prompts, 'prompt', (prompt) => prompt.promptId,
    (prompt) => boundedEntity(prompt, { kind: 'prompt', id: prompt.promptId }, 2048, agentId));
  const interactions = boundedCollection(snapshot.interactions, 'interaction', (interaction) => interaction.interactionId);
  const todos = boundedCollection(snapshot.todos, 'todo', (todo) => todo.todoId);
  const meta = snapshot.meta.contentRefs === undefined ? boundedEntity(snapshot.meta, { kind: 'meta', id: '' }, 4096) : snapshot.meta;
  const budget = windowBytes - 4096 - GLOBAL_COLLECTION_BYTES - jsonBytes({ tasks, prompts, interactions, todos, meta });
  const items = boundedItems(snapshot.items, budget, direction, agentId);
  const required = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const id of item.attachmentIds ?? []) required.add(id);
    for (const step of item.steps) for (const frame of step.frames) {
      if ('attachmentIds' in frame) for (const id of frame.attachmentIds ?? []) required.add(id);
    }
  }
  const attachments = boundedCollection(snapshot.attachments, 'attachment', (attachment) => attachment.attachmentId,
    (attachment) => boundedAttachment(attachment, agentId, 2048), required);
  const globals = { tasks, attachments, prompts, interactions, todos, meta };
  return {
    ...globals,
    items,
    toolCallCount: snapshot.toolCallCount,
    toolCallCountKnown: snapshot.toolCallCountKnown,
    hasMoreOlder: snapshot.hasMoreOlder === true || items.length < snapshot.items.length,
    olderCursor: (snapshot.hasMoreOlder === true || items.length < snapshot.items.length) && items.length > 0 ? itemKey(items[0]!) : undefined,
    globalCoverage: {
      version: 1,
      tasks: collectionCoverage(tasks.length, snapshot.tasks.length),
      attachments: collectionCoverage(attachments.length, snapshot.attachments.length),
      prompts: collectionCoverage(prompts.length, snapshot.prompts.length),
      interactions: collectionCoverage(interactions.length, snapshot.interactions.length),
      todos: collectionCoverage(todos.length, snapshot.todos.length),
    },
  };
}

export function boundedTranscriptResponse(response: TranscriptResponse, direction: 'head' | 'tail' = 'tail', windowBytes = TRANSCRIPT_WINDOW_BYTES): TranscriptResponse {
  const snapshot = boundedTranscriptSnapshot({
    items: response.items,
    tasks: response.tasks,
    interactions: response.interactions,
    attachments: response.attachments,
    todos: response.todos,
    prompts: response.prompts,
    meta: response.meta,
    hasMoreOlder: direction === 'tail' ? response.has_more : true,
    toolCallCount: response.tool_call_count,
  }, response.agent_id, direction, windowBytes);
  const agents = response.agents.slice(0, 20).map((agent) => boundedEntity(agent, { kind: 'roster', id: agent.agentId }, 1024));
  const result = {
    ...response,
    ...snapshot,
    has_more: response.has_more || snapshot.items.length < response.items.length,
    next_cursor: (response.has_more || snapshot.items.length < response.items.length) && snapshot.items.length > 0
      ? itemKey(direction === 'head' ? snapshot.items.at(-1)! : snapshot.items[0]!) : undefined,
    agents,
    pending_interactions: snapshot.interactions.filter((entry) => entry.state === 'pending').map((entry) => entry.interactionId),
    coverage: (direction === 'head' || snapshot.items.length < response.items.length) && response.coverage.kind !== 'unknown'
      ? { kind: 'tail' as const, fromTurnId: snapshot.items.find((item) => item.kind === 'turn')?.turnId, throughTurnId: snapshot.items.findLast((item) => item.kind === 'turn')?.turnId, hasMoreOlder: true }
      : response.coverage,
  };

  return result as TranscriptResponse;
}

export function itemKey(item: AgentTranscriptSnapshot['items'][number]): string { return `${item.kind}:${itemId(item)}`; }

function boundedItem(item: AgentTranscriptSnapshot['items'][number], agentId: string): AgentTranscriptSnapshot['items'][number] {
  if (item.kind === 'taskref' || (item.contentRefs?.length ?? 0) > 0) return item;
  const preview = boundedEntity(item, { kind: item.kind, id: itemId(item) }, undefined, agentId);
  return preview.kind === 'turn' ? rebindTurnContentRefs(preview) : preview;
}

export function boundedTranscriptPageSource(snapshot: AgentTranscriptSnapshot, agentId: string): AgentTranscriptSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => boundedItem(item, agentId)),
    tasks: snapshot.tasks.map((value) => boundedEntity(value, { kind: 'task', id: value.taskId })),
    attachments: snapshot.attachments.map((value) => boundedAttachment(value, agentId)),
    prompts: snapshot.prompts.map((value) => boundedEntity(value, { kind: 'prompt', id: value.promptId }, undefined, agentId)),
    interactions: snapshot.interactions.map((value) => boundedEntity(value, { kind: 'interaction', id: value.interactionId })),
    todos: snapshot.todos.map((value) => boundedEntity(value, { kind: 'todo', id: value.todoId })),
    meta: boundedEntity(snapshot.meta, { kind: 'meta', id: '' }),
  };
}

function boundedItems(items: AgentTranscriptSnapshot['items'], budget: number, direction: 'head' | 'tail', agentId: string): AgentTranscriptSnapshot['items'] {
  const selected: AgentTranscriptSnapshot['items'][number][] = [];
  let bytes = 2;
  for (let offset = 0; offset < items.length; offset += 1) {
    const item = items[direction === 'head' ? offset : items.length - 1 - offset]!;
    const projected = boundedItem(item, agentId);
    const size = jsonBytes(projected) + 1;
    if (selected.length > 0 && bytes + size > budget) break;
    selected.push(projected);
    bytes += size;
  }
  return direction === 'head' ? selected : selected.reverse();
}

function boundedCollection<T extends object>(values: readonly T[], kind: 'task' | 'attachment' | 'prompt' | 'interaction' | 'todo', id: (value: T) => string, project?: (value: T) => T, required: ReadonlySet<string> = new Set()): T[] {
  const selected = new Map<string, T>();
  const entityBytes = kind === 'todo' ? ENTITY_BYTES : 2048;
  const collectionBytes = kind === 'todo' ? ENTITY_BYTES + 3 : GLOBAL_COLLECTION_BYTES;
  let bytes = 2;
  const candidates = [...values.filter((value) => required.has(id(value))), ...values.filter((value) => !required.has(id(value))).toReversed()];
  for (const value of candidates) {
    if (!required.has(id(value)) && selected.size >= 8) break;
    const projected = (value as import('@kiki/transcript').ContentWindow).contentRefs !== undefined ? value
      : project?.(value) ?? boundedEntity(value, { kind, id: id(value) }, entityBytes);
    const size = jsonBytes(projected) + 1;
    if (bytes + size > collectionBytes) continue;
    selected.set(id(value), projected);
    bytes += size;
  }
  return values.flatMap((value) => { const projected = selected.get(id(value)); return projected === undefined ? [] : [projected]; });
}

function collectionCoverage(returned: number, total: number) { return { returned, total, hasMore: returned < total }; }

export function boundedTranscriptOps(ops: readonly TranscriptOperation[], transcript: AgentTranscript, entityBytes?: number): TranscriptOperation[] {
  return ops.map((op): TranscriptOperation => {
    switch (op.op) {
      case 'reset': return { ...op, snapshot: boundedTranscriptSnapshot(op.snapshot, transcript.agentId) };
      case 'turn.upsert': return { ...op, turn: boundedEntity(op.turn, { kind: 'turn', id: op.turn.turnId }, undefined, transcript.agentId) };
      case 'frame.upsert': return { ...op, frame: boundedEntity(op.frame, { kind: 'frame', id: op.frame.frameId, turnId: op.turnId, stepId: op.stepId }, undefined, transcript.agentId) };
      case 'task.upsert': return { ...op, task: boundedEntity(op.task, { kind: 'task', id: op.task.taskId }, entityBytes) };
      case 'attachment.upsert': return { ...op, attachment: boundedAttachment(op.attachment, transcript.agentId) };
      case 'prompt.upsert': return { ...op, prompt: boundedEntity(op.prompt, { kind: 'prompt', id: op.prompt.promptId }, undefined, transcript.agentId) };
      case 'interaction.upsert': return { ...op, interaction: boundedEntity(op.interaction, { kind: 'interaction', id: op.interaction.interactionId }) };
      case 'todo.upsert': return { ...op, todo: boundedEntity(op.todo, { kind: 'todo', id: op.todo.todoId }) };
      case 'marker.upsert': return { ...op, item: boundedEntity(op.item, { kind: 'marker', id: op.item.markerId }) };
      case 'meta.merge': return { ...op, meta: boundedEntity(op.meta, { kind: 'meta', id: '' }) };
      case 'append': {
        if (op.target.type === 'task') {
          const task = transcript.getTask(op.target.taskId);
          if (task !== undefined && (op.offset > 1024 || op.text.length > 8192 || jsonBytes(op.text) > 8192)) return { op: 'task.upsert', task: boundedEntity(task, { kind: 'task', id: task.taskId }) };
        } else {
          const target = op.target;
          const frame = transcript.getTurn(target.turnId)?.steps.find((step) => step.stepId === target.stepId)?.frames.find((entry) => entry.frameId === target.frameId);
          if (frame !== undefined && (op.offset > 1024 || op.text.length > 8192 || jsonBytes(op.text) > 8192)) return { op: 'frame.upsert', turnId: target.turnId, stepId: target.stepId, frame: boundedEntity(frame, { kind: 'frame', id: frame.frameId, turnId: target.turnId, stepId: target.stepId }, undefined, transcript.agentId) };
        }
        return op;
      }
      default: return op;
    }
  });
}

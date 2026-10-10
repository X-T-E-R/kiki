import { applyContentSegment, carryContentHydration, rebindTurnContentRefs, sameContentRef, type AgentTranscript, type AgentTranscriptSnapshot, type ContentRef, type ContentSegment, type ContentSource, type ContentWindow, type TranscriptItem, type TranscriptOperation, type TranscriptTurn } from '@kiki/transcript';

export function collectTranscriptContentRefs(snapshot: AgentTranscriptSnapshot): readonly ContentRef[] {
  const refs: ContentRef[] = [];
  const add = (value: ContentWindow): void => { refs.push(...(value.contentRefs ?? [])); };
  for (const item of snapshot.items) {
    if (item.kind === 'taskref') continue;
    add(item);
    if (item.kind === 'turn') for (const step of item.steps) for (const frame of step.frames) add(frame);
  }
  for (const values of [snapshot.tasks, snapshot.attachments, snapshot.prompts, snapshot.interactions, snapshot.todos]) for (const entity of values) add(entity);
  add(snapshot.meta);
  return refs;
}

export function patchTranscriptContent(snapshot: AgentTranscriptSnapshot, segment: ContentSegment): AgentTranscriptSnapshot {
  if (!collectTranscriptContentRefs(snapshot).some((ref) => sameContentRef(ref, segment.ref))) return snapshot;
  const source = segment.ref.source;
  const patch = <T extends ContentWindow>(value: T): T => applyContentSegment(value, segment);
  const mapItems = (update: (item: TranscriptItem) => TranscriptItem): AgentTranscriptSnapshot => ({ ...snapshot, items: snapshot.items.map(update) });
  switch (source.kind) {
    case 'turn': return mapItems((item) => item.kind === 'turn' && item.turnId === source.id ? rebindTurnContentRefs(patch(item)) : item);
    case 'marker': return mapItems((item) => item.kind === 'marker' && item.markerId === source.id ? patch(item) : item);
    case 'frame': return mapItems((item) => item.kind === 'turn' && item.turnId === source.turnId ? {
      ...item, steps: item.steps.map((step) => step.stepId === source.stepId ? {
        ...step, frames: step.frames.map((frame) => frame.frameId === source.id ? patch(frame) : frame),
      } : step),
    } : item);
    case 'task': return { ...snapshot, tasks: snapshot.tasks.map((entity) => entity.taskId === source.id ? patch(entity) : entity) };
    case 'attachment': return { ...snapshot, attachments: snapshot.attachments.map((entity) => entity.attachmentId === source.id ? patch(entity) : entity) };
    case 'prompt': return { ...snapshot, prompts: snapshot.prompts.map((entity) => entity.promptId === source.id ? patch(entity) : entity) };
    case 'interaction': return { ...snapshot, interactions: snapshot.interactions.map((entity) => entity.interactionId === source.id ? patch(entity) : entity) };
    case 'todo': return { ...snapshot, todos: snapshot.todos.map((entity) => entity.todoId === source.id ? patch(entity) : entity) };
    case 'meta': return { ...snapshot, meta: patch(snapshot.meta) };
    case 'roster':
    case 'snapshot': return snapshot;
  }
}

export function transcriptContentEntity(store: AgentTranscript, source: ContentSource): ContentWindow | undefined {
  switch (source.kind) {
    case 'turn': return store.getTurn(source.id);
    case 'frame': return store.getTurn(source.turnId ?? '')?.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
    case 'task': return store.getTask(source.id);
    case 'attachment': return store.getAttachment(source.id);
    case 'prompt': return store.getPrompt(source.id);
    case 'interaction': return store.getInteraction(source.id);
    case 'todo': return store.getTodo(source.id);
    case 'meta': return store.getMeta();
    case 'marker': return store.getItems().find((item) => item.kind === 'marker' && item.markerId === source.id) as ContentWindow | undefined;
    default: return undefined;
  }
}

export function snapshotContentEntity(snapshot: AgentTranscriptSnapshot, source: ContentSource): ContentWindow | undefined {
  const turn = () => snapshot.items.find((item) => item.kind === 'turn' && item.turnId === (source.kind === 'turn' ? source.id : source.turnId));
  switch (source.kind) {
    case 'turn': return turn() as ContentWindow | undefined;
    case 'frame': {
      const item = turn();
      return item?.kind === 'turn' ? item.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id) : undefined;
    }
    case 'task': return snapshot.tasks.find((item) => item.taskId === source.id);
    case 'attachment': return snapshot.attachments.find((item) => item.attachmentId === source.id);
    case 'prompt': return snapshot.prompts.find((item) => item.promptId === source.id);
    case 'interaction': return snapshot.interactions.find((item) => item.interactionId === source.id);
    case 'todo': return snapshot.todos.find((item) => item.todoId === source.id);
    case 'marker': return snapshot.items.find((item) => item.kind === 'marker' && item.markerId === source.id) as ContentWindow | undefined;
    case 'meta': return snapshot.meta;
    default: return undefined;
  }
}

export function turnContentOps(turn: TranscriptTurn): TranscriptOperation[] {
  const { steps, ...header } = turn;
  const ops: TranscriptOperation[] = [{ op: 'turn.upsert', turn: carryContentHydration(turn, header) }];
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
  }
  return ops;
}

export function patchAgentTranscriptContent(store: AgentTranscript, segment: ContentSegment): boolean {
  const source = segment.ref.source;
  const current = transcriptContentEntity(store, source);
  if (current === undefined) return false;
  const patched = applyContentSegment(current, segment);
  if (patched === current) return false;
  return replaceAgentContentEntity(store, source, patched);
}

export function replaceAgentContentEntity(store: AgentTranscript, source: ContentSource, patched: ContentWindow): boolean {
  let ops: TranscriptOperation[];
  switch (source.kind) {
    case 'turn': ops = turnContentOps(carryContentHydration(patched, rebindTurnContentRefs(patched as TranscriptTurn))); break;
    case 'frame': ops = [{ op: 'frame.upsert', turnId: source.turnId!, stepId: source.stepId!, frame: patched as import('@kiki/transcript').TranscriptFrame }]; break;
    case 'task': ops = [{ op: 'task.upsert', task: patched as import('@kiki/transcript').TranscriptTask }]; break;
    case 'attachment': ops = [{ op: 'attachment.upsert', attachment: patched as import('@kiki/transcript').TranscriptAttachment }]; break;
    case 'prompt': ops = [{ op: 'prompt.upsert', prompt: patched as import('@kiki/transcript').TranscriptPrompt }]; break;
    case 'interaction': ops = [{ op: 'interaction.upsert', interaction: patched as import('@kiki/transcript').TranscriptInteraction }]; break;
    case 'todo': ops = [{ op: 'todo.upsert', todo: patched as import('@kiki/transcript').TranscriptTodo }]; break;
    case 'meta': ops = [{ op: 'meta.merge', meta: patched }]; break;
    case 'marker': ops = [{ op: 'marker.upsert', item: patched as import('@kiki/transcript').TranscriptMarker }]; break;
    default: return false;
  }
  return store.apply(ops).accepted.length > 0;
}

export function replaceSnapshotContentEntity(snapshot: AgentTranscriptSnapshot, source: ContentSource, value: ContentWindow): AgentTranscriptSnapshot {
  switch (source.kind) {
    case 'turn': return { ...snapshot, items: snapshot.items.map((item) => item.kind === 'turn' && item.turnId === source.id ? value as TranscriptTurn : item) };
    case 'frame': return { ...snapshot, items: snapshot.items.map((item) => item.kind === 'turn' && item.turnId === source.turnId ? { ...item, steps: item.steps.map((step) => step.stepId === source.stepId ? { ...step, frames: step.frames.map((frame) => frame.frameId === source.id ? value as import('@kiki/transcript').TranscriptFrame : frame) } : step) } : item) };
    case 'task': return { ...snapshot, tasks: snapshot.tasks.map((item) => item.taskId === source.id ? value as import('@kiki/transcript').TranscriptTask : item) };
    case 'attachment': return { ...snapshot, attachments: snapshot.attachments.map((item) => item.attachmentId === source.id ? value as import('@kiki/transcript').TranscriptAttachment : item) };
    case 'prompt': return { ...snapshot, prompts: snapshot.prompts.map((item) => item.promptId === source.id ? value as import('@kiki/transcript').TranscriptPrompt : item) };
    case 'interaction': return { ...snapshot, interactions: snapshot.interactions.map((item) => item.interactionId === source.id ? value as import('@kiki/transcript').TranscriptInteraction : item) };
    case 'todo': return { ...snapshot, todos: snapshot.todos.map((item) => item.todoId === source.id ? value as import('@kiki/transcript').TranscriptTodo : item) };
    case 'meta': return { ...snapshot, meta: value };
    case 'marker': return { ...snapshot, items: snapshot.items.map((item) => item.kind === 'marker' && item.markerId === source.id ? value as import('@kiki/transcript').TranscriptMarker : item) };
    default: return snapshot;
  }
}

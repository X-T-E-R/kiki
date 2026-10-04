import { applyContentSegment, rebindTurnContentRefs, sameContentRef, type AgentTranscriptSnapshot, type ContentRef, type ContentSegment, type ContentWindow, type TranscriptItem } from '@kiki/transcript';

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

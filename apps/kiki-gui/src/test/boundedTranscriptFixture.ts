import {
  CONTENT_PAGE_BYTES,
  CONTENT_PREVIEW_BYTES,
  jsonBytes,
  jsonTextPrefix,
  type AgentTranscriptSnapshot,
  type ContentRef,
  type ContentSegment,
  type ContentSource,
  type TranscriptOperation,
} from '@kiki/transcript';

const TEST_ENTITY_BYTES = 64 * 1024;
const PREVIEW_CHARS = 1022;

function revisionFor(value: unknown): string {
  const raw = JSON.stringify(value) ?? '';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `rev_${(hash >>> 0).toString(16)}`;
}

function selectPath(entity: object, path: ContentRef['path']): unknown {
  let cursor: unknown = entity;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) {
      throw new Error(`Missing content path: ${path.join('.')}`);
    }
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

function previewString(value: string, maxChars: number): string {
  const byBytes = jsonTextPrefix(value, 0, CONTENT_PREVIEW_BYTES);
  return byBytes.length > maxChars ? value.slice(0, maxChars) : byBytes;
}

function truncateValue(
  value: unknown,
  path: ContentRef['path'],
  refs: ContentRef[],
  source: ContentSource,
  maxPreviewChars: number,
): unknown {
  if (typeof value === 'string') {
    if (value.length > maxPreviewChars || jsonBytes(value) > CONTENT_PREVIEW_BYTES) {
      const preview = previewString(value, maxPreviewChars);
      if (preview.length < value.length) {
        refs.push({
          source,
          path,
          kind: 'text',
          offset: preview.length,
          total: value.length,
          revision: revisionFor(value),
        });
        return preview;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => truncateValue(item, [...path, index], refs, source, maxPreviewChars));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'contentRefs') continue;
      out[key] = truncateValue(entry, [...path, key], refs, source, maxPreviewChars);
    }
    return out;
  }
  return value;
}

export function boundedEntity<T extends object>(
  entity: T,
  source: ContentSource,
  budgetBytes = TEST_ENTITY_BYTES,
  _agentId?: string,
): T & { contentRefs?: ContentRef[] } {
  const needsTrim = jsonBytes(entity) > budgetBytes || source.kind === 'prompt' || source.kind === 'marker';
  if (!needsTrim) return structuredClone(entity);
  const maxPreviewChars = budgetBytes < TEST_ENTITY_BYTES ? Math.min(PREVIEW_CHARS, Math.max(120, Math.floor(budgetBytes / 4))) : PREVIEW_CHARS;
  const refs: ContentRef[] = [];
  const trimmed = truncateValue(entity, [], refs, source, maxPreviewChars) as T & { contentRefs?: ContentRef[] };
  if (refs.length > 0) trimmed.contentRefs = refs;
  return trimmed;
}

export function readContentSegment(
  entity: object,
  ref: ContentRef,
  range: boolean | { readonly offset?: number; readonly limit?: number } = false,
  _agentId?: string,
): ContentSegment {
  const full = selectPath(entity, ref.path);
  if (typeof full !== 'string') {
    throw new Error(`Unsupported content segment kind at ${ref.path.join('.')}`);
  }
  const offset = typeof range === 'object' && range.offset !== undefined ? range.offset : ref.offset;
  const maxBytes = typeof range === 'object' && range.limit !== undefined
    ? range.limit
    : range === true
      ? Math.min(CONTENT_PAGE_BYTES, 48 * 1024)
      : CONTENT_PAGE_BYTES;
  const chunk = jsonTextPrefix(full, offset, maxBytes);
  const nextOffset = offset + chunk.length;
  const next: ContentRef | undefined = nextOffset < full.length
    ? { ...ref, offset: nextOffset, total: full.length, revision: revisionFor(full) }
    : undefined;
  return {
    ref: { ...ref, offset, total: full.length, revision: revisionFor(full) },
    value: chunk,
    contentRefs: [],
    ...(next !== undefined ? { next } : {}),
  };
}

export function boundedTranscriptSnapshot(
  snapshot: AgentTranscriptSnapshot,
  agentId = 'main',
): AgentTranscriptSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => {
      if (item.kind === 'marker') {
        return boundedEntity(item, { kind: 'marker', id: item.markerId }, TEST_ENTITY_BYTES, agentId);
      }
      return item;
    }),
    prompts: snapshot.prompts.map((prompt) =>
      boundedEntity(prompt, { kind: 'prompt', id: prompt.promptId }, TEST_ENTITY_BYTES, agentId),
    ),
    todos: snapshot.todos.map((todo) =>
      boundedEntity(todo, { kind: 'todo', id: todo.todoId }, TEST_ENTITY_BYTES, agentId),
    ),
  };
}

export function boundedTranscriptOps(
  ops: readonly TranscriptOperation[],
  _store?: unknown,
): TranscriptOperation[] {
  return ops.map((op) => {
    if (op.op === 'todo.upsert') {
      return { ...op, todo: boundedEntity(op.todo, { kind: 'todo', id: op.todo.todoId }, TEST_ENTITY_BYTES) };
    }
    return op;
  });
}

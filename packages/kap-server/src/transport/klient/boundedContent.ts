import {
  CONTENT_PAGE_BYTES,
  CONTENT_PREVIEW_BYTES,
  jsonBytes,
  jsonTextPrefix,
  type ContentRef,
  type ContentSegment,
  type ContentSource,
  type ContentWindow,
} from '@kiki/transcript';
import { projectInlineToolMedia } from '../../services/inlineMedia';
import { contentRevision } from './contentRevision';
const fieldRevisions = new WeakMap<object, Map<string, string>>();
export const ENTITY_BYTES = 64 * 1024;
export const TIMELINE_ENTITY_BYTES = 128 * 1024;
const ARRAY_WINDOW = 4;
const OBJECT_WINDOW = 64;
const ID_KEYS = /^(?:kind|state|status|role|op|.*Id|.*_id|mediaType|marker|interactionKind|type)$/u;
const OPAQUE_FIELDS = new Set(['input', 'output', 'display', 'request', 'response', 'payload', 'content', 'customData', 'detail']);

type Path = ContentRef['path'];
interface Cut { path: Path; kind: ContentRef['kind']; offset: number; total: number }
interface Budget { nodes: number }

export class ContentChangedError extends Error {
  constructor() { super('Content changed; reload its preview before continuing.'); }
}

export { contentRevision } from './contentRevision';

function selectContent(entity: object, path: Path): unknown {
  let selected: unknown = entity;
  for (const key of path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new ContentChangedError();
    selected = (selected as Record<string | number, unknown>)[key];
  }
  return selected;
}

function fieldRevision(entity: object, path: Path, through?: number): string {
  let fields = fieldRevisions.get(entity);
  if (fields === undefined) { fields = new Map(); fieldRevisions.set(entity, fields); }
  const selected = selectContent(entity, path);
  const structure = isStructurePath(path) && Array.isArray(selected);
  const count = structure ? through ?? selected.length : undefined;
  if (structure && count! > selected.length) throw new ContentChangedError();
  const key = JSON.stringify([path, count]);
  const existing = fields.get(key);
  if (existing !== undefined) return existing;
  const revision = structure
    ? contentRevision(selected.slice(0, count).map((child) => {
      const header = child as Record<string, unknown>;
      return [header['kind'], header['stepId'] ?? header['frameId'], header['ordinal']];
    }))
    : contentRevision(selected);
  fields.set(key, revision);
  return revision;
}

function bindCuts(entity: object, source: ContentSource, cuts: readonly Cut[]): ContentRef[] {
  return cuts.map((cut) => ({ ...cut, source, revision: fieldRevision(entity, cut.path) }));
}

export function boundedEntity<T extends object>(entity: T, source: ContentSource, maxBytes = source.kind === 'turn' || source.kind === 'frame' ? TIMELINE_ENTITY_BYTES : ENTITY_BYTES, agentId?: string): T & ContentWindow {
  if (source.kind === 'todo') {
    if ((entity as ContentWindow).contentRefs !== undefined) return entity;
    if (maxBytes >= ENTITY_BYTES) return boundedTodo(entity, source, maxBytes);
  }
  const result = projectAt(entity, [], source, entity, maxBytes, agentId);
  return { ...(result.value as T), contentRefs: result.refs.length === 0 ? undefined : result.refs };
}

const NOTE_FIELDS = new Set(['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open']);

function boundedTodo<T extends object>(entity: T, source: ContentSource, maxBytes: number): T & ContentWindow {
  const body = { ...entity } as Record<string, unknown>;
  const inline: Record<string, unknown> = {};
  let available = maxBytes - 4096;
  const notes = body['notes'];
  if (notes !== null && typeof notes === 'object' && !Array.isArray(notes)) {
    const entries = Object.entries(notes);
    let characters = 0;
    const legal = entries.length <= NOTE_FIELDS.size && entries.every(([key, value]) => {
      if (!NOTE_FIELDS.has(key) || typeof value !== 'string' || value.length > 1500) return false;
      characters += value.length;
      return characters <= 7500;
    });
    if (legal) {
      const bytes = jsonBytes({ notes });
      if (bytes <= available) {
        inline['notes'] = notes;
        delete body['notes'];
        available -= bytes;
      }
    }
  }
  const items = body['items'];
  if (Array.isArray(items) && completeTodoItemsFit(items, available)) {
    inline['items'] = items;
    delete body['items'];
    available -= jsonBytes({ items });
  }
  const result = projectAt(body, [], source, entity, available + 4096);
  return { ...(result.value as T), ...inline, contentRefs: result.refs.length === 0 ? undefined : result.refs };
}

function completeTodoItemsFit(items: readonly unknown[], maxBytes: number): boolean {
  let bytes = 12;
  for (const value of items) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    if (typeof item['title'] !== 'string' || item['title'].length > maxBytes - bytes ||
      !['pending', 'in_progress', 'done'].includes(item['status'] as string) ||
      Object.keys(item).some((key) => key !== 'title' && key !== 'status')) return false;
    bytes += jsonBytes(item) + 1;
    if (bytes > maxBytes) return false;
  }
  return true;
}

export function boundedListPreview<T extends object>(entity: T, maxBytes = 2048): T {
  let textBytes = CONTENT_PREVIEW_BYTES;
  let arrayWindow = ARRAY_WINDOW;
  for (;;) {
    const projected = projectValue(entity, [], [], textBytes, arrayWindow, 0, { nodes: 128 }) as T;
    if (jsonBytes(projected) <= maxBytes) return projected;
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    return projected;
  }
}

function projectAt(value: unknown, path: Path, source: ContentSource, entity: object, maxBytes: number, agentId?: string): { value: unknown; refs: ContentRef[] } {
  const media = agentId === undefined ? undefined : { source, entity, agentId };
  let textBytes = source.kind === 'turn' || source.kind === 'frame' ? 16 * 1024 : CONTENT_PREVIEW_BYTES;
  let arrayWindow = ARRAY_WINDOW;
  let structureWindow = 8;
  for (;;) {
    const cuts: Cut[] = [];
    const projected = projectValue(value, path, cuts, textBytes, arrayWindow, 0, { nodes: 128 }, structureWindow, media);
    const refs = bindCuts(entity, source, cuts);
    if (jsonBytes({ value: projected, refs }) <= maxBytes) return { value: projected, refs };
    if (textBytes > CONTENT_PREVIEW_BYTES) { textBytes = Math.floor(textBytes / 2); continue; }
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    if (structureWindow > 1) { structureWindow = Math.floor(structureWindow / 2); continue; }
    return { value: projected, refs };
  }
}

function isStructurePath(path: Path): boolean {
  return path.length === 1 && path[0] === 'steps' ||
    path.length === 3 && path[0] === 'steps' && typeof path[1] === 'number' && path[2] === 'frames';
}

const EXTERNAL_TEXT_FIELDS = new Set<string>(['recordId', 'turnId', 'text', 'kind', 'title', 'relatedOperationIds', 'sourceUrl', 'clientTime', 'source'] satisfies readonly (keyof import('@kiki/transcript').ExternalTextRecord)[]);

function isExternalTextMarker(value: object, path: Path): boolean {
  if (path.length > 0) return false;
  const marker = value as Record<string, unknown>;
  if (marker['kind'] !== 'marker' || marker['marker'] !== 'external.text') return false;
  const payload = marker['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (!Object.keys(record).every((key) => EXTERNAL_TEXT_FIELDS.has(key)) ||
    typeof record['recordId'] !== 'string' || typeof record['turnId'] !== 'number' ||
    typeof record['text'] !== 'string' || typeof record['kind'] !== 'string' ||
    !['note', 'user_excerpt', 'assistant_excerpt', 'handoff'].includes(record['kind'])) return false;
  const source = record['source'];
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const identity = source as Record<string, unknown>;
  return identity['driver'] === 'external' && typeof identity['connectionId'] === 'string' &&
    typeof identity['clientName'] === 'string' && typeof identity['sessionRef'] === 'string';
}

function projectValue(value: unknown, path: Path, cuts: Cut[], textBytes: number, arrayWindow: number, depth: number, budget: Budget, structureWindow = 16, media?: { source: ContentSource; entity: object; agentId: string }): unknown {
  budget.nodes -= 1;
  if (media !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const projected = projectInlineToolMedia(value, path, media.source, media.entity, media.agentId);
    if (projected !== undefined) return projected;
  }
  if (typeof value === 'string') {
    const key = path.at(-1);
    const prose = (path.length === 1 && (key === 'prompt' || key === 'text')) ||
      (path.length === 5 && path[0] === 'steps' && path[2] === 'frames' && key === 'text');
    if (typeof key === 'string' && ID_KEYS.test(key) || key === 'url' && path.at(-2) === 'source') return value;
    const limit = prose ? textBytes : Math.min(textBytes, CONTENT_PREVIEW_BYTES);
    const prefix = jsonTextPrefix(value, 0, limit);
    if (prefix.length < value.length) cuts.push({ path, kind: 'text', offset: prefix.length, total: value.length });
    return prefix;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const structure = isStructurePath(path);
    const count = structure ? Math.min(value.length, structureWindow)
      : depth > 12 || budget.nodes < 0 ? 0 : Math.min(value.length, arrayWindow);
    const projected = value.slice(0, count).map((child, index) => projectValue(child, [...path, index], cuts, textBytes, arrayWindow, depth + 1, structure ? { nodes: 128 } : budget, structureWindow, media));
    if (count < value.length) cuts.push({ path, kind: 'array', offset: count, total: value.length });
    return projected;
  }
  const entries = Object.entries(value);
  const opaque = path.some((key) => typeof key === 'string' && OPAQUE_FIELDS.has(key));
  if (entries.length > OBJECT_WINDOW || depth > 12 || (opaque && entries.length > Math.max(0, budget.nodes)) || entries.some(([key]) => key.length > CONTENT_PREVIEW_BYTES || jsonBytes(key) > CONTENT_PREVIEW_BYTES)) {
    cuts.push({ path, kind: 'object', offset: 0, total: entries.length });
    return {};
  }
  const externalText = isExternalTextMarker(value, path);
  return Object.fromEntries(entries.map(([key, child]) => {
    const childPath = [...path, key];
    if (OPAQUE_FIELDS.has(key) && !(externalText && key === 'payload') && textBytes <= CONTENT_PREVIEW_BYTES && child !== null && typeof child === 'object') {
      const total = Array.isArray(child) ? child.length : Object.keys(child).length;
      if (total > 8) {
        cuts.push({ path: childPath, kind: Array.isArray(child) ? 'array' : 'object', offset: 0, total });
        return [key, Array.isArray(child) ? [] : {}];
      }
    }
    return [key, projectValue(child, childPath, cuts, textBytes, arrayWindow, depth + 1, OPAQUE_FIELDS.has(key) ? { nodes: 64 } : budget, structureWindow, media)];
  }));
}

export function readContentSegment(entity: object, ref: ContentRef, range = false, agentId?: string, pageBytes = CONTENT_PAGE_BYTES): ContentSegment {
  const selected = selectContent(entity, ref.path);
  if (range && ref.kind === 'text' && typeof selected === 'string' && ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!)) ref = { ...ref, offset: ref.offset - 1 };
  const structure = ref.kind === 'array' && isStructurePath(ref.path);
  if (fieldRevision(entity, ref.path, structure ? ref.total : undefined) !== ref.revision) throw new ContentChangedError();
  const refs: ContentRef[] = [];
  let value: unknown;
  let offset: number;
  if (ref.kind === 'text') {
    if (typeof selected !== 'string' || selected.length !== ref.total || ref.offset >= selected.length || (ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!))) throw new ContentChangedError();
    let end = Math.min(selected.length, ref.offset + 4097);
    if (end < selected.length && /[\uD800-\uDBFF]/u.test(selected[end - 1]!)) end -= 1;
    value = range ? jsonTextPrefix(selected.slice(ref.offset, end), 0, pageBytes / 2) : jsonTextPrefix(selected, ref.offset, pageBytes / 2);
    offset = ref.offset + (value as string).length;
  } else if (ref.kind === 'array') {
    if (!Array.isArray(selected) || (structure ? selected.length < ref.total : selected.length !== ref.total) || ref.offset >= ref.total) throw new ContentChangedError();
    const values: unknown[] = [];
    offset = ref.offset;
    while (offset < ref.total && values.length < 20) {
      const child = projectAt(selected[offset], [...ref.path, offset], ref.source, entity, ENTITY_BYTES, agentId);
      if (values.length > 0 && jsonBytes({ values: [...values, child.value], refs: [...refs, ...child.refs] }) > pageBytes / 2) break;
      values.push(child.value);
      refs.push(...child.refs);
      offset += 1;
    }
    value = values;
  } else {
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) throw new ContentChangedError();
    const entries = Object.entries(selected);
    if (entries.length !== ref.total || ref.offset >= entries.length) throw new ContentChangedError();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    offset = ref.offset;
    while (offset < entries.length && offset - ref.offset < OBJECT_WINDOW) {
      const [key, child] = entries[offset]!;
      const projected = projectAt(child, [...ref.path, key], ref.source, entity, ENTITY_BYTES, agentId);
      if (offset > ref.offset && jsonBytes({ values: { ...values, [key]: projected.value }, refs: [...refs, ...projected.refs] }) > pageBytes / 2) break;
      values[key] = projected.value;
      refs.push(...projected.refs);
      offset += 1;
    }
    value = values;
  }
  const next = offset < ref.total ? { ...ref, offset } : undefined;
  return { ref, value, next, contentRefs: refs };
}

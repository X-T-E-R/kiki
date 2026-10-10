import { createHash } from 'node:crypto';
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

const revisions = new WeakMap<object, string>();
const fieldRevisions = new WeakMap<object, Map<string, string>>();
const ENTITY_BYTES = 12 * 1024;
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

export function contentRevision(value: unknown): string {
  const existing = value !== null && typeof value === 'object' ? revisions.get(value) : undefined;
  if (existing !== undefined) return existing;
  const hash = createHash('sha256');
  if (typeof value === 'string') {
    hash.update(`string:${value.length}:`);
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 4096);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
      hash.update(value.slice(offset, end));
      offset = end;
    }
  } else if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      hash.update(`array:${value.length}:`);
      for (const child of value) hash.update(contentRevision(child));
    } else {
      const entries = Object.entries(value);
      hash.update(`object:${entries.length}:`);
      for (const [key, child] of entries) { hash.update(contentRevision(key)); hash.update(contentRevision(child)); }
    }
  } else hash.update(`${typeof value}:${String(value)};`);
  const revision = hash.digest('hex');
  if (value !== null && typeof value === 'object') revisions.set(value, revision);
  return revision;
}

function selectContent(entity: object, path: Path): unknown {
  let selected: unknown = entity;
  for (const key of path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new ContentChangedError();
    selected = (selected as Record<string | number, unknown>)[key];
  }
  return selected;
}

function fieldRevision(entity: object, path: Path): string {
  let fields = fieldRevisions.get(entity);
  if (fields === undefined) { fields = new Map(); fieldRevisions.set(entity, fields); }
  const key = JSON.stringify(path);
  const existing = fields.get(key);
  if (existing !== undefined) return existing;
  const revision = contentRevision(selectContent(entity, path));
  fields.set(key, revision);
  return revision;
}

function bindCuts(entity: object, source: ContentSource, cuts: readonly Cut[]): ContentRef[] {
  return cuts.map((cut) => ({ ...cut, source, revision: fieldRevision(entity, cut.path) }));
}

export function boundedEntity<T extends object>(entity: T, source: ContentSource, maxBytes = source.kind === 'turn' || source.kind === 'frame' ? 24 * 1024 : ENTITY_BYTES): T & ContentWindow {
  const result = projectAt(entity, [], source, entity, maxBytes);
  return { ...(result.value as T), contentRefs: result.refs.length === 0 ? undefined : result.refs };
}

export function boundedListPreview<T extends object>(entity: T, maxBytes = 2048): T {
  let textBytes = CONTENT_PREVIEW_BYTES;
  let arrayWindow = ARRAY_WINDOW;
  for (;;) {
    const projected = projectValue(entity, [], [], textBytes, arrayWindow, 0, { nodes: 128 }) as T;
    if (jsonBytes(projected) <= maxBytes) return projected;
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    throw new Error('Canonical list identity exceeds the page budget');
  }
}

function projectAt(value: unknown, path: Path, source: ContentSource, entity: object, maxBytes: number): { value: unknown; refs: ContentRef[] } {
  let textBytes = source.kind === 'turn' || source.kind === 'frame' ? 16 * 1024 : CONTENT_PREVIEW_BYTES;
  let arrayWindow = ARRAY_WINDOW;
  for (;;) {
    const cuts: Cut[] = [];
    const projected = projectValue(value, path, cuts, textBytes, arrayWindow, 0, { nodes: 128 });
    const refs = bindCuts(entity, source, cuts);
    if (jsonBytes({ value: projected, refs }) <= maxBytes) return { value: projected, refs };
    if (textBytes > CONTENT_PREVIEW_BYTES) { textBytes = Math.floor(textBytes / 2); continue; }
    if (arrayWindow > 0) { arrayWindow = 0; continue; }
    if (textBytes > 32) { textBytes = Math.floor(textBytes / 2); continue; }
    throw new Error('Canonical entity header exceeds the content page budget');
  }
}

function projectValue(value: unknown, path: Path, cuts: Cut[], textBytes: number, arrayWindow: number, depth: number, budget: Budget): unknown {
  budget.nodes -= 1;
  if (typeof value === 'string') {
    const key = path.at(-1);
    const prose = (path.length === 1 && (key === 'prompt' || key === 'text')) ||
      (path.length === 5 && path[0] === 'steps' && path[2] === 'frames' && key === 'text');
    const limit = typeof key === 'string' && ID_KEYS.test(key) ? 512 : prose ? textBytes : Math.min(textBytes, CONTENT_PREVIEW_BYTES);
    const prefix = jsonTextPrefix(value, 0, limit);
    if (prefix.length < value.length) cuts.push({ path, kind: 'text', offset: prefix.length, total: value.length });
    return prefix;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const count = depth > 12 || budget.nodes < 0 ? 0 : Math.min(value.length, arrayWindow);
    const projected = value.slice(0, count).map((child, index) => projectValue(child, [...path, index], cuts, textBytes, arrayWindow, depth + 1, budget));
    if (count < value.length) cuts.push({ path, kind: 'array', offset: count, total: value.length });
    return projected;
  }
  const entries = Object.entries(value);
  const opaque = path.some((key) => typeof key === 'string' && OPAQUE_FIELDS.has(key));
  if (entries.length > OBJECT_WINDOW || depth > 12 || (opaque && budget.nodes < 0) || entries.some(([key]) => key.length > CONTENT_PREVIEW_BYTES || jsonBytes(key) > CONTENT_PREVIEW_BYTES)) {
    cuts.push({ path, kind: 'object', offset: 0, total: entries.length });
    return {};
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, projectValue(child, [...path, key], cuts, textBytes, arrayWindow, depth + 1, budget)]));
}

export function readContentSegment(entity: object, ref: ContentRef, range = false): ContentSegment {
  const selected = selectContent(entity, ref.path);
  if (range && ref.kind === 'text' && typeof selected === 'string' && ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!)) ref = { ...ref, offset: ref.offset - 1 };
  if (fieldRevision(entity, ref.path) !== ref.revision) throw new ContentChangedError();
  const refs: ContentRef[] = [];
  let value: unknown;
  let offset: number;
  if (ref.kind === 'text') {
    if (typeof selected !== 'string' || selected.length !== ref.total || ref.offset >= selected.length || (ref.offset > 0 && /[\uD800-\uDBFF]/u.test(selected[ref.offset - 1]!))) throw new ContentChangedError();
    let end = Math.min(selected.length, ref.offset + 4097);
    if (end < selected.length && /[\uD800-\uDBFF]/u.test(selected[end - 1]!)) end -= 1;
    value = range ? jsonTextPrefix(selected.slice(ref.offset, end), 0, CONTENT_PAGE_BYTES / 2) : jsonTextPrefix(selected, ref.offset, CONTENT_PAGE_BYTES / 2);
    offset = ref.offset + (value as string).length;
  } else if (ref.kind === 'array') {
    if (!Array.isArray(selected) || selected.length !== ref.total || ref.offset >= selected.length) throw new ContentChangedError();
    const values: unknown[] = [];
    offset = ref.offset;
    while (offset < selected.length && values.length < 20) {
      const child = projectAt(selected[offset], [...ref.path, offset], ref.source, entity, ENTITY_BYTES);
      if (jsonBytes({ values: [...values, child.value], refs: [...refs, ...child.refs] }) > CONTENT_PAGE_BYTES / 2) break;
      values.push(child.value);
      refs.push(...child.refs);
      offset += 1;
    }
    if (offset === ref.offset) throw new Error('Content element exceeds the page budget');
    value = values;
  } else {
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected)) throw new ContentChangedError();
    const entries = Object.entries(selected);
    if (entries.length !== ref.total || ref.offset >= entries.length) throw new ContentChangedError();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    offset = ref.offset;
    while (offset < entries.length && offset - ref.offset < OBJECT_WINDOW) {
      const [key, child] = entries[offset]!;
      if (key.length > CONTENT_PAGE_BYTES / 2 || jsonBytes(key) > CONTENT_PAGE_BYTES / 2) throw new Error('Content object key exceeds the page budget');
      const projected = projectAt(child, [...ref.path, key], ref.source, entity, ENTITY_BYTES);
      if (jsonBytes({ values: { ...values, [key]: projected.value }, refs: [...refs, ...projected.refs] }) > CONTENT_PAGE_BYTES / 2) break;
      values[key] = projected.value;
      refs.push(...projected.refs);
      offset += 1;
    }
    if (offset === ref.offset) throw new Error('Content object entry exceeds the page budget');
    value = values;
  }
  const next = offset < ref.total ? { ...ref, offset } : undefined;
  const result = { ref, value, next, contentRefs: refs };
  if (jsonBytes(result) > CONTENT_PAGE_BYTES - 1024) throw new Error('Content segment exceeds the page budget');
  return result;
}

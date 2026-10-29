import { z } from 'zod';

/** Target bytes per content response; indivisible keys and reference headers may exceed it. */
export const CONTENT_PAGE_BYTES = 256 * 1024;
export const CONTENT_PREVIEW_BYTES = 1024;

export const contentSourceSchema = z.object({
  kind: z.enum(['turn', 'frame', 'task', 'attachment', 'prompt', 'interaction', 'todo', 'marker', 'meta', 'roster', 'snapshot']),
  id: z.string(),
  turnId: z.string().optional(),
  stepId: z.string().optional(),
});

/** Backward structural refs use offset as the inline suffix's canonical start and total as its fixed source watermark. Omitted direction retains forward continuation semantics. */
export const contentRefSchema = z.object({
  source: contentSourceSchema,
  revision: z.string().min(1).max(128),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  kind: z.enum(['text', 'array', 'object']),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  direction: z.enum(['forward', 'backward']).optional(),
});

export const contentWindowSchema = z.object({
  contentRefs: z.array(contentRefSchema).readonly().optional(),
});

/** Backward pages carry their canonical start; next.offset equals start and disappears at zero. Values remain in source order. */
export const contentSegmentSchema = z.object({
  ref: contentRefSchema,
  value: z.unknown(),
  next: contentRefSchema.optional(),
  start: z.number().int().nonnegative().optional(),
  contentRefs: z.array(contentRefSchema),
});

export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ContentRef = z.infer<typeof contentRefSchema>;
export type ContentSegment = z.infer<typeof contentSegmentSchema>;
export interface ContentWindow {
  readonly contentRefs?: readonly ContentRef[];
}

/** UTF-8 and JSON escaping are counted before a value enters a response. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? 0 : utf8ByteLength(text);
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Select a prefix without splitting a Unicode code point, under a decoded JSON budget. */
export function jsonTextPrefix(text: string, offset: number, maxBytes: number): string {
  const limit = Math.min(text.length, offset + maxBytes);
  let bytes = 2;
  let end = offset;
  while (end < limit) {
    const unit = text.charCodeAt(end);
    const pair = unit >= 0xd800 && unit <= 0xdbff && end + 1 < limit &&
      text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff;
    const cost = pair ? 4 : jsonUnitBytes(unit);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    end += pair ? 2 : 1;
  }
  if (end < text.length && end > offset && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
  return text.slice(offset, end);
}

function jsonUnitBytes(unit: number): number {
  if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x0c || unit === 0x0a || unit === 0x0d || unit === 0x09) return 2;
  if (unit < 0x20) return 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  if (unit >= 0xd800 && unit <= 0xdfff) return 6;
  return 3;
}

/** Apply one explicit segment immutably; offsets prevent duplicate or out-of-order concatenation. */
export function applyContentSegment<T extends ContentWindow>(entity: T, segment: ContentSegment): T {
  const active = entity.contentRefs?.find((ref) => sameContentRef(ref, segment.ref));
  if (active === undefined) return entity;
  if (segment.ref.direction === 'backward' && (!isCanonicalStructure(segment.ref) || !Array.isArray(segment.value) ||
    segment.start === undefined || segment.start + segment.value.length !== segment.ref.offset ||
    segment.start >= segment.ref.offset || (segment.start === 0 ? segment.next !== undefined :
      segment.next?.direction !== 'backward' || segment.next.offset !== segment.start))) throw new Error('content segment offset mismatch');
  const root = clonePath(entity, segment.ref.path, (current) => {
    if (segment.ref.kind === 'text') {
      if (typeof current !== 'string' || current.length !== segment.ref.offset || typeof segment.value !== 'string') throw new Error('content segment offset mismatch');
      return current + segment.value;
    }
    if (segment.ref.kind === 'array') {
      if (!Array.isArray(current) || !Array.isArray(segment.value)) throw new Error('content segment offset mismatch');
      const path = segment.ref.path;
      const structure = isCanonicalStructure(segment.ref);
      if (structure) {
        const backward = segment.ref.direction === 'backward';
        if (!backward && current.length < segment.ref.offset) throw new Error('content segment offset mismatch');
        return mergeCanonicalArray(current, segment.value, path.length === 1 ? 'stepId' : 'frameId', backward ? 0 : segment.ref.offset);
      }
      if (current.length !== segment.ref.offset) throw new Error('content segment offset mismatch');
      return [...current, ...segment.value];
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current) || segment.value === null || typeof segment.value !== 'object' || Array.isArray(segment.value)) throw new Error('invalid object content segment');
    return { ...current, ...segment.value };
  }) as T;
  const retainedRefs = (entity.contentRefs ?? []).filter((ref) => !sameContentRef(ref, segment.ref));
  const nextRefs = segment.next === undefined ? [] : [segment.next];
  const candidate = { ...root, contentRefs: [...retainedRefs, ...segment.contentRefs, ...nextRefs] };
  const result = {
    ...root,
    contentRefs: [
      ...retainedRefs,
      ...segment.contentRefs.filter(ref => segment.ref.kind !== 'array' || !isCanonicalStructure(segment.ref) || matchesSegmentPreview(candidate, segment, ref)),
      ...nextRefs,
    ],
  };
  const versions = new Map(hydratedVersions.get(entity as object));
  versions.set(JSON.stringify(segment.ref.path), segment.ref.revision);
  hydratedVersions.set(result, versions);
  return result;
}

function isCanonicalStructure(ref: ContentRef): boolean {
  const path = ref.path;
  return ref.source.kind === 'turn' && path[0] === 'steps' &&
    (path.length === 1 || path.length === 3 && typeof path[1] === 'number' && path[2] === 'frames');
}

function matchesSegmentPreview(root: ContentWindow, segment: ContentSegment, ref: ContentRef): boolean {
  const base = segment.ref.path;
  if (!base.every((part, index) => ref.path[index] === part)) return false;
  let saved: unknown = segment.value;
  const savedRefs = [...segment.contentRefs, { ...segment.ref, direction: 'backward' as const, offset: segment.start ?? segment.ref.offset }];
  for (let position = base.length; position < ref.path.length; position += 1) {
    const part = ref.path[position]!;
    if (saved === null || typeof saved !== 'object') return false;
    const key = typeof part === 'number' && Array.isArray(saved)
      ? part - contentArrayStart(savedRefs, ref.path.slice(0, position)) : part;
    saved = (saved as Record<string | number, unknown>)[key];
  }
  const merged = contentPathValue(root, ref.path);
  return saved !== undefined && JSON.stringify(saved) === JSON.stringify(merged);
}

function mergeCanonicalArray(current: readonly unknown[], incoming: readonly unknown[], identity: 'stepId' | 'frameId', prefixCount = 0): unknown[] {
  const entries = new Map<string, Record<string, unknown>>();
  const record = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>)[identity] !== 'string') throw new Error('invalid canonical structure segment');
    return value as Record<string, unknown>;
  };
  for (const value of current.slice(0, prefixCount)) {
    const child = record(value);
    entries.set(child[identity] as string, child);
  }
  for (const value of incoming) {
    const child = record(value);
    entries.set(child[identity] as string, child);
  }
  for (const value of current) {
    const child = record(value);
    const previous = entries.get(child[identity] as string);
    const merged = previous === undefined ? child : { ...previous, ...child };
    if (identity === 'stepId' && previous !== undefined && Array.isArray(child['frames']) && Array.isArray(previous['frames'])) {
      merged['frames'] = mergeCanonicalArray(child['frames'], previous['frames'], 'frameId');
    }
    entries.set(child[identity] as string, merged);
  }
  const values = [...entries.values()];
  return identity === 'stepId' ? values.toSorted((a, b) => Number(a['ordinal']) - Number(b['ordinal'])) : values;
}

const hydratedVersions = new WeakMap<object, ReadonlyMap<string, string>>();
const hiddenStructuralInserts = new WeakMap<object, ReadonlySet<string>>();

export function noteHiddenStructuralInsert(source: object, target: object, frameId: string): boolean {
  const seen = hiddenStructuralInserts.get(source);
  if (seen?.has(frameId)) return false;
  const next = new Set(seen);
  next.add(frameId);
  hiddenStructuralInserts.set(target, next);
  return true;
}

/** Preserve accepted field revisions when canonical operations clone an entity. */
export function carryContentHydration<T extends ContentWindow>(source: ContentWindow, target: T): T {
  const versions = hydratedVersions.get(source as object);
  if (versions !== undefined && !hydratedVersions.has(target as object)) hydratedVersions.set(target as object, versions);
  const hidden = hiddenStructuralInserts.get(source as object);
  if (hidden !== undefined && !hiddenStructuralInserts.has(target as object)) hiddenStructuralInserts.set(target as object, hidden);
  return target;
}

export function restoreContentPreview<T extends ContentWindow>(current: T, preview: T): T {
  const versions = hydratedVersions.get(current as object);
  const retained = new Map(versions);
  let result = current;
  for (const ref of preview.contentRefs ?? []) {
    if (versions?.get(JSON.stringify(ref.path)) !== ref.revision) continue;
    const value = contentPathValue(preview, ref.path);
    if (value === undefined) continue;
    result = clonePath(result, ref.path, () => value) as T;
    result = { ...result, contentRefs: [...(result.contentRefs ?? []).filter((candidate) => !ref.path.every((part, index) => candidate.path[index] === part)), ref] };
    for (const path of retained.keys()) if (ref.path.every((part, index) => (JSON.parse(path) as ContentRef['path'])[index] === part)) retained.delete(path);
  }
  if (result !== current) { hydratedVersions.set(result as object, retained); hydratedVersions.set(current as object, retained); }
  return result;
}

export function mergeContentPreview<T extends ContentWindow>(current: T, preview: T): T {
  if (hydratedVersions.has(preview as object)) return preview;
  let result = preview;
  const versions = hydratedVersions.get(current as object);
  const retained = new Map(hydratedVersions.get(preview as object));
  for (const ref of preview.contentRefs ?? []) {
    const key = JSON.stringify(ref.path);
    const previous = current.contentRefs?.find((candidate) => JSON.stringify(candidate.path) === key && candidate.revision === ref.revision);
    const behind = previous !== undefined && (ref.direction === 'backward' ? previous.offset > ref.offset : previous.offset < ref.offset);
    if (versions?.get(key) !== ref.revision || behind) continue;
    const value = contentPathValue(current, ref.path);
    if (value === undefined) continue;
    result = clonePath(result, ref.path, () => value) as T;
    const under = (candidate: ContentRef) => ref.path.every((part, index) => candidate.path[index] === part);
    result = { ...result, contentRefs: [...(result.contentRefs ?? []).filter((candidate) => !under(candidate)), ...(current.contentRefs ?? []).filter(under)] };
    for (const [path, revision] of versions ?? []) if (ref.path.every((part, index) => (JSON.parse(path) as ContentRef['path'])[index] === part)) retained.set(path, revision);
  }
  if (result !== preview) hydratedVersions.set(result as object, retained);
  return result;
}

/** Replace one stale field and its continuation references with a fresh preview's field, forgetting hydration under that path. */
export function adoptContentPreviewField<T extends ContentWindow>(current: T, preview: ContentWindow, path: readonly (string | number)[]): T {
  const value = contentPathValue(preview, path);
  if (value === undefined) throw new Error('content path unavailable');
  const under = (candidate: ContentRef) => path.every((part, index) => candidate.path[index] === part);
  const root = clonePath(current, path, () => value) as T;
  const result = { ...root, contentRefs: [...(current.contentRefs ?? []).filter((candidate) => !under(candidate)), ...(preview.contentRefs ?? []).filter(under)] };
  const versions = new Map(hydratedVersions.get(current as object));
  for (const key of versions.keys()) if (under({ path: JSON.parse(key) } as ContentRef)) versions.delete(key);
  hydratedVersions.set(result, versions);
  return result;
}

export function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.revision === right.revision && left.kind === right.kind && left.offset === right.offset && left.total === right.total &&
    (left.direction ?? 'forward') === (right.direction ?? 'forward') &&
    JSON.stringify(left.source) === JSON.stringify(right.source) && JSON.stringify(left.path) === JSON.stringify(right.path);
}

function contentArrayStart(refs: readonly ContentRef[], path: readonly (string | number)[]): number {
  return refs.find((ref) => ref.direction === 'backward' && JSON.stringify(ref.path) === JSON.stringify(path))?.offset ?? 0;
}

/** Resolve canonical array indices through compact structural suffixes rather than treating their first child as index zero. */
export function contentPathValue(value: ContentWindow, path: readonly (string | number)[]): unknown {
  let selected: unknown = value;
  for (let position = 0; position < path.length; position += 1) {
    if (selected === null || typeof selected !== 'object') return undefined;
    const part = path[position]!;
    const key = typeof part === 'number' && Array.isArray(selected)
      ? part - contentArrayStart(value.contentRefs ?? [], path.slice(0, position)) : part;
    selected = (selected as Record<string | number, unknown>)[key];
  }
  return selected;
}

function clonePath(value: ContentWindow, path: readonly (string | number)[], update: (value: unknown) => unknown): unknown {
  const parents: { value: object; key: string | number }[] = [];
  let selected: unknown = value;
  for (let position = 0; position < path.length; position += 1) {
    const part = path[position]!;
    const key = typeof part === 'number' && Array.isArray(selected)
      ? part - contentArrayStart(value.contentRefs ?? [], path.slice(0, position)) : part;
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new Error('content path unavailable');
    parents.push({ value: selected, key });
    selected = (selected as Record<string | number, unknown>)[key];
  }
  let result = update(selected);
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index]!;
    const clone = Array.isArray(parent.value) ? [...parent.value] : { ...parent.value };
    Object.defineProperty(clone, parent.key, { value: result, enumerable: true, configurable: true, writable: true });
    result = clone;
  }
  return result;
}

import { z } from 'zod';

/** Target bytes per content response; indivisible keys and reference headers may exceed it. */
export const CONTENT_PAGE_BYTES = 256 * 1024;
export const CONTENT_PREVIEW_BYTES = 1024;

export const contentSourceSchema = z.object({
  kind: z.enum(['turn', 'frame', 'task', 'attachment', 'prompt', 'interaction', 'todo', 'marker', 'meta', 'roster', 'snapshot']),
  id: z.string().max(256),
  turnId: z.string().max(256).optional(),
  stepId: z.string().max(256).optional(),
});

export const contentRefSchema = z.object({
  source: contentSourceSchema,
  revision: z.string().min(1).max(128),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  kind: z.enum(['text', 'array', 'object']),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const contentWindowSchema = z.object({
  contentRefs: z.array(contentRefSchema).optional(),
});

export const contentSegmentSchema = z.object({
  ref: contentRefSchema,
  value: z.unknown(),
  next: contentRefSchema.optional(),
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
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Select a prefix without splitting a Unicode code point, under a decoded JSON budget. */
export function jsonTextPrefix(text: string, offset: number, maxBytes: number): string {
  let low = offset;
  let high = Math.min(text.length, offset + maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(offset, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low < text.length && low > offset && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low -= 1;
  return text.slice(offset, low);
}

/** Apply one explicit segment immutably; offsets prevent duplicate or out-of-order concatenation. */
export function applyContentSegment<T extends ContentWindow>(entity: T, segment: ContentSegment): T {
  const active = entity.contentRefs?.find((ref) => sameContentRef(ref, segment.ref));
  if (active === undefined) return entity;
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
        if (current.length < segment.ref.offset) throw new Error('content segment offset mismatch');
        return mergeCanonicalArray(current, segment.value, path.length === 1 ? 'stepId' : 'frameId', segment.ref.offset);
      }
      if (current.length !== segment.ref.offset) throw new Error('content segment offset mismatch');
      return [...current, ...segment.value];
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current) || segment.value === null || typeof segment.value !== 'object' || Array.isArray(segment.value)) throw new Error('invalid object content segment');
    return { ...current, ...segment.value };
  }) as T;
  const result = {
    ...root,
    contentRefs: [
      ...(entity.contentRefs ?? []).filter((ref) => !sameContentRef(ref, segment.ref)),
      ...segment.contentRefs.filter(ref => segment.ref.kind !== 'array' || !isCanonicalStructure(segment.ref) || matchesSegmentPreview(root, segment, ref)),
      ...(segment.next === undefined ? [] : [segment.next]),
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

function matchesSegmentPreview(root: unknown, segment: ContentSegment, ref: ContentRef): boolean {
  const base = segment.ref.path;
  if (!base.every((part, index) => ref.path[index] === part)) return false;
  const index = ref.path[base.length];
  if (typeof index !== 'number') return false;
  let saved: unknown = segment.value;
  let merged: unknown = root;
  for (const part of base) {
    if (merged === null || typeof merged !== 'object') return false;
    merged = (merged as Record<string | number, unknown>)[part];
  }
  const path = ref.path.slice(base.length);
  for (let position = 0; position < path.length; position += 1) {
    const part = path[position]!;
    if (saved === null || typeof saved !== 'object' || merged === null || typeof merged !== 'object') return false;
    saved = (saved as Record<string | number, unknown>)[position === 0 ? index - segment.ref.offset : part];
    merged = (merged as Record<string | number, unknown>)[part];
    if (saved !== null && typeof saved === 'object' && merged !== null && typeof merged === 'object') {
      for (const key of ['stepId', 'frameId']) {
        if ((saved as Record<string, unknown>)[key] !== (merged as Record<string, unknown>)[key]) return false;
      }
    }
  }
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

/** Preserve accepted field revisions when canonical operations clone an entity. */
export function carryContentHydration<T extends ContentWindow>(source: ContentWindow, target: T): T {
  const versions = hydratedVersions.get(source as object);
  if (versions !== undefined && !hydratedVersions.has(target as object)) hydratedVersions.set(target as object, versions);
  return target;
}

export function restoreContentPreview<T extends ContentWindow>(current: T, preview: T): T {
  const versions = hydratedVersions.get(current as object);
  const retained = new Map(versions);
  let result = current;
  for (const ref of preview.contentRefs ?? []) {
    if (versions?.get(JSON.stringify(ref.path)) !== ref.revision) continue;
    let value: unknown = preview;
    for (const part of ref.path) {
      if (value === null || typeof value !== 'object') { value = undefined; break; }
      value = (value as Record<string | number, unknown>)[part];
    }
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
    if (versions?.get(key) !== ref.revision || previous !== undefined && previous.offset < ref.offset) continue;
    let value: unknown = current;
    for (const part of ref.path) {
      if (value === null || typeof value !== 'object') { value = undefined; break; }
      value = (value as Record<string | number, unknown>)[part];
    }
    if (value === undefined) continue;
    result = clonePath(result, ref.path, () => value) as T;
    const under = (candidate: ContentRef) => ref.path.every((part, index) => candidate.path[index] === part);
    result = { ...result, contentRefs: [...(result.contentRefs ?? []).filter((candidate) => !under(candidate)), ...(current.contentRefs ?? []).filter(under)] };
    for (const [path, revision] of versions ?? []) if (ref.path.every((part, index) => (JSON.parse(path) as ContentRef['path'])[index] === part)) retained.set(path, revision);
  }
  if (result !== preview) hydratedVersions.set(result as object, retained);
  return result;
}

export function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.revision === right.revision && left.kind === right.kind && left.offset === right.offset &&
    JSON.stringify(left.source) === JSON.stringify(right.source) && JSON.stringify(left.path) === JSON.stringify(right.path);
}

function clonePath(value: unknown, path: readonly (string | number)[], update: (value: unknown) => unknown): unknown {
  const parents: object[] = [];
  let selected = value;
  for (const key of path) {
    if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) throw new Error('content path unavailable');
    parents.push(selected);
    selected = (selected as Record<string | number, unknown>)[key];
  }
  let result = update(selected);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const parent = parents[index]!;
    const clone = Array.isArray(parent) ? [...parent] : { ...parent };
    Object.defineProperty(clone, path[index]!, { value: result, enumerable: true, configurable: true, writable: true });
    result = clone;
  }
  return result;
}

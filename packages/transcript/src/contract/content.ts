import { z } from 'zod';

export const CONTENT_PAGE_BYTES = 64 * 1024;
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
  let end = Math.min(text.length, offset + maxBytes);
  if (end < text.length && end > offset && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
  let prefix = text.slice(offset, end);
  while (jsonBytes(prefix) > maxBytes && end > offset) {
    end = offset + Math.floor((end - offset) / 2);
    if (end > offset && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    prefix = text.slice(offset, end);
  }
  return prefix;
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
      if (!Array.isArray(current) || current.length !== segment.ref.offset || !Array.isArray(segment.value)) throw new Error('content segment offset mismatch');
      return [...current, ...segment.value];
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current) || segment.value === null || typeof segment.value !== 'object' || Array.isArray(segment.value)) throw new Error('invalid object content segment');
    return { ...current, ...segment.value };
  }) as T;
  return {
    ...root,
    contentRefs: [
      ...(entity.contentRefs ?? []).filter((ref) => !sameContentRef(ref, segment.ref)),
      ...segment.contentRefs,
      ...(segment.next === undefined ? [] : [segment.next]),
    ],
  };
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

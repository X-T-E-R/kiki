import { createHash } from 'node:crypto';

const revisions = new WeakMap<object, string>();
const shortStringRevisions = new Map<string, string>();
const primitiveRevisions = new Map<string, string>();
const MAX_SHORT_STRING_CACHE = 32768;
const MAX_SHORT_STRING_LEN = 128;

function hashShortString(value: string): string {
  const cached = shortStringRevisions.get(value);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256').update(`string:${value.length}:${value}`).digest('hex');
  if (shortStringRevisions.size >= MAX_SHORT_STRING_CACHE) {
    const oldest = shortStringRevisions.keys().next().value;
    if (oldest !== undefined) shortStringRevisions.delete(oldest);
  }
  shortStringRevisions.set(value, digest);
  return digest;
}

function hashPrimitive(tag: string): string {
  const cached = primitiveRevisions.get(tag);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256').update(tag).digest('hex');
  if (primitiveRevisions.size < 2048) primitiveRevisions.set(tag, digest);
  return digest;
}

export function contentRevision(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length <= MAX_SHORT_STRING_LEN) return hashShortString(value);
    const hash = createHash('sha256');
    hash.update(`string:${value.length}:`);
    if (value.length <= 4096) {
      hash.update(value);
      return hash.digest('hex');
    }
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 4096);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
      hash.update(value.slice(offset, end));
      offset = end;
    }
    return hash.digest('hex');
  }
  if (value === null || typeof value !== 'object') {
    return hashPrimitive(`${typeof value}:${String(value)};`);
  }
  const existing = revisions.get(value);
  if (existing !== undefined) return existing;
  const hash = createHash('sha256');
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}:`);
    for (const child of value) hash.update(contentRevision(child));
  } else {
    const entries = Object.entries(value);
    hash.update(`object:${entries.length}:`);
    for (const [key, child] of entries) {
      hash.update(hashShortStringKey(key));
      hash.update(contentRevision(child));
    }
  }
  const revision = hash.digest('hex');
  revisions.set(value, revision);
  return revision;
}

export function contentRevisionOfArray(length: number, itemAt: (index: number) => unknown): string {
  const hash = createHash('sha256');
  hash.update(`array:${length}:`);
  for (let index = 0; index < length; index += 1) hash.update(contentRevision(itemAt(index)));
  return hash.digest('hex');
}

function hashShortStringKey(key: string): string {
  return key.length <= MAX_SHORT_STRING_LEN ? hashShortString(key) : contentRevision(key);
}

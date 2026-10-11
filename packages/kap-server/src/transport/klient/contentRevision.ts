import { createHash } from 'node:crypto';

const revisions = new WeakMap<object, string>();

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

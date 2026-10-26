export function transcriptValueEquals(a: unknown, b: unknown): boolean {
  return equals(a, b, false);
}

export function transcriptResidentValueEquals(a: unknown, b: unknown): boolean {
  return equals(a, b, true);
}

function equals(a: unknown, b: unknown, persisted: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!equals(a[index], b[index], persisted)) return false;
    }
    return true;
  }
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const leftKeys = persisted ? Object.keys(left).filter(key => left[key] !== undefined) : Object.keys(left);
  const rightKeys = persisted ? Object.keys(right).filter(key => right[key] !== undefined) : Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !equals(left[key], right[key], persisted)) return false;
  }
  return true;
}

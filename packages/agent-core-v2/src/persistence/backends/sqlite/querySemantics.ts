export function getPath(doc: unknown, path: string): unknown {
  let current = doc;
  for (const segment of path.split('.')) {
    let rest = segment;
    while (rest.length > 0) {
      const match = rest.match(/^([^[]*)\[(\d+)\](.*)$/);
      const tokens = match === null ? [rest] : [...(match[1] ? [match[1]] : []), String(Number(match[2]))];
      for (const key of tokens) {
        if (current === null || current === undefined) return undefined;
        current = (Object(current) as Record<string, unknown>)[key];
      }
      rest = match === null ? '' : match[3]!;
    }
  }
  return current;
}

function condition(value: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) { expected.lastIndex = 0; return typeof value === 'string' && expected.test(value); }
  if (expected === null || typeof expected !== 'object') return value === expected;
  for (const [op, argument] of Object.entries(expected)) {
    switch (op) {
      case '$eq': if (value !== argument) return false; break;
      case '$ne': if (value === argument) return false; break;
      case '$gt': if (!((value as number) > (argument as number))) return false; break;
      case '$gte': if (!((value as number) >= (argument as number))) return false; break;
      case '$lt': if (!((value as number) < (argument as number))) return false; break;
      case '$lte': if (!((value as number) <= (argument as number))) return false; break;
      case '$exists': if ((value !== undefined) !== !!argument) return false; break;
      case '$in': if (!Array.isArray(argument) || !argument.includes(value)) return false; break;
      case '$nin': if (!Array.isArray(argument) || argument.includes(value)) return false; break;
      case '$contains': if (!Array.isArray(value) || !value.includes(argument)) return false; break;
      case '$type': if (typeof value !== argument) return false; break;
      case '$regex': {
        const expression = argument instanceof RegExp ? argument : Array.isArray(argument) ? new RegExp(argument[0], argument[1]) : new RegExp(String(argument));
        expression.lastIndex = 0;
        if (typeof value !== 'string' || !expression.test(value)) return false;
        break;
      }
      default: return false;
    }
  }
  return true;
}

export function matches(doc: unknown, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$and') { if (!Array.isArray(expected) || !expected.every((item) => matches(doc, item))) return false; }
    else if (field === '$or') { if (!Array.isArray(expected) || !expected.some((item) => matches(doc, item))) return false; }
    else if (field === '$nor') { if (!Array.isArray(expected) || expected.some((item) => matches(doc, item))) return false; }
    else if (field === '$not') { if (matches(doc, expected as Record<string, unknown>)) return false; }
    else if (!condition(getPath(doc, field), expected)) return false;
  }
  return true;
}

export function scalarKey(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify([typeof value, value]);
}

export function sortValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf16le').swap16().toString('hex');
  // oxlint-disable-next-line typescript/no-base-to-string
  return Buffer.from(String(value), 'utf16le').swap16().toString('hex');
}

function sortableNumberHex(value: number): string {
  if (Number.isNaN(value)) return 'ffffffffffffffff';
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value === 0 ? 0 : value, false);
  const hi = view.getUint32(0, false);
  const lo = view.getUint32(4, false);
  if ((hi & 0x80000000) !== 0) {
    view.setUint32(0, ~hi >>> 0, false);
    view.setUint32(4, ~lo >>> 0, false);
  } else {
    view.setUint32(0, (hi ^ 0x80000000) >>> 0, false);
  }
  return Buffer.from(buffer).toString('hex');
}

export function totalSortKey(value: unknown): string {
  if (value === undefined || value === null) return '0:';
  if (typeof value === 'boolean') return value ? '1:1' : '1:0';
  if (typeof value === 'number') return `2:${sortableNumberHex(value)}`;
  if (typeof value === 'string') return `3:${Buffer.from(value, 'utf16le').swap16().toString('hex')}`;
  // oxlint-disable-next-line typescript/no-base-to-string
  return `4:${Buffer.from(String(value), 'utf16le').swap16().toString('hex')}`;
}

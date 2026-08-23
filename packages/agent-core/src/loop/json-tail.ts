/* oxlint-disable eslint-plugin-unicorn/prefer-code-point -- JSON \uXXXX encodes a UTF-16 code unit. */
export type JsonTailKind = 'complete' | 'container-unclosed' | 'value-truncated' | 'malformed';

export type JsonTailClassification =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'container-unclosed';
      readonly offset: number;
      readonly field?: string;
      readonly closers: string;
    }
  | {
      readonly kind: 'value-truncated';
      readonly offset: number;
      readonly field?: string;
    }
  | {
      readonly kind: 'malformed';
      readonly offset: number;
    };

/**
 * Classify possibly truncated JSON without repairing values.
 * Distinguishes unclosed containers (safe to close) from cut values (unsafe).
 */
export function classifyToolArgsJson(raw: string): JsonTailClassification {
  try {
    JSON.parse(raw);
    return { kind: 'complete' };
  } catch {
    return scanJsonTail(raw);
  }
}

type Expect =
  | 'value'
  | 'object-key-or-end'
  | 'object-key'
  | 'object-colon'
  | 'object-comma-or-end'
  | 'array-value-or-end'
  | 'array-value'
  | 'array-comma-or-end'
  | 'end';

interface Frame {
  readonly kind: 'object' | 'array';
  key?: string;
}

function scanJsonTail(raw: string): JsonTailClassification {
  const n = raw.length;
  let i = 0;
  const stack: Frame[] = [];
  let expect: Expect = 'value';
  let scanningKey = false;

  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = (): void => {
    while (i < n && isWs(raw[i]!)) i += 1;
  };
  const nearestField = (): string | undefined => {
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const key = stack[k]!.key;
      if (key !== undefined) return key;
    }
    return undefined;
  };
  const truncated = (omitField: boolean): JsonTailClassification => {
    const field = omitField ? undefined : nearestField();
    if (field === undefined) return { kind: 'value-truncated', offset: n };
    return { kind: 'value-truncated', offset: n, field };
  };
  const unclosed = (): JsonTailClassification => {
    let closers = '';
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      closers += stack[k]!.kind === 'object' ? '}' : ']';
    }
    const field = nearestField();
    if (field === undefined) return { kind: 'container-unclosed', offset: n, closers };
    return { kind: 'container-unclosed', offset: n, field, closers };
  };
  const malformed = (offset: number): JsonTailClassification => ({ kind: 'malformed', offset });
  const afterValue = (): Expect => {
    if (stack.length === 0) return 'end';
    return stack.at(-1)!.kind === 'object' ? 'object-comma-or-end' : 'array-comma-or-end';
  };

  while (true) {
    skipWs();
    if (i >= n) {
      if (expect === 'end') return { kind: 'complete' };
      if (
        expect === 'object-key-or-end' ||
        expect === 'object-comma-or-end' ||
        expect === 'array-value-or-end' ||
        expect === 'array-comma-or-end'
      ) {
        return unclosed();
      }
      if (expect === 'value' && stack.length === 0) return malformed(n);
      return truncated(scanningKey || expect === 'object-key');
    }

    const c = raw[i]!;

    if (expect === 'end') return malformed(i);

    if (expect === 'object-colon') {
      if (c !== ':') return malformed(i);
      i += 1;
      expect = 'value';
      scanningKey = false;
      continue;
    }

    if (expect === 'object-comma-or-end') {
      if (c === '}') {
        stack.pop();
        i += 1;
        expect = afterValue();
        continue;
      }
      if (c === ',') {
        i += 1;
        const frame = stack.at(-1);
        if (frame !== undefined) frame.key = undefined;
        expect = 'object-key';
        continue;
      }
      return malformed(i);
    }

    if (expect === 'array-comma-or-end') {
      if (c === ']') {
        stack.pop();
        i += 1;
        expect = afterValue();
        continue;
      }
      if (c === ',') {
        i += 1;
        expect = 'array-value';
        continue;
      }
      return malformed(i);
    }

    if (expect === 'object-key-or-end' || expect === 'object-key') {
      if (expect === 'object-key-or-end' && c === '}') {
        stack.pop();
        i += 1;
        expect = afterValue();
        continue;
      }
      if (c !== '"') return malformed(i);
      scanningKey = true;
      const key = scanString(raw, i);
      if (key.kind !== 'complete') {
        return key.kind === 'truncated' ? truncated(true) : malformed(key.offset);
      }
      i = key.end;
      const frame = stack.at(-1);
      if (frame !== undefined) frame.key = key.value;
      scanningKey = false;
      expect = 'object-colon';
      continue;
    }

    if (c === '{') {
      stack.push({ kind: 'object' });
      i += 1;
      expect = 'object-key-or-end';
      continue;
    }
    if (c === '[') {
      stack.push({ kind: 'array' });
      i += 1;
      expect = 'array-value-or-end';
      continue;
    }
    if (expect === 'array-value-or-end' && c === ']') {
      stack.pop();
      i += 1;
      expect = afterValue();
      continue;
    }
    if (c === '"') {
      const str = scanString(raw, i);
      if (str.kind !== 'complete') {
        return str.kind === 'truncated' ? truncated(false) : malformed(str.offset);
      }
      i = str.end;
      expect = afterValue();
      continue;
    }
    if (c === '-' || isDigit(c)) {
      const num = scanNumber(raw, i);
      if (num.kind === 'malformed') return malformed(num.offset);
      if (num.kind === 'truncated') return truncated(false);
      i = num.end;
      expect = afterValue();
      continue;
    }
    if (c === 't' || c === 'f' || c === 'n') {
      const lit = scanLiteral(raw, i);
      if (lit.kind === 'malformed') return malformed(lit.offset);
      if (lit.kind === 'truncated') return truncated(false);
      i = lit.end;
      expect = afterValue();
      continue;
    }
    return malformed(i);
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isHex(c: string): boolean {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function scanString(
  raw: string,
  start: number,
):
  | { readonly kind: 'complete'; readonly end: number; readonly value: string }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'malformed'; readonly offset: number } {
  const n = raw.length;
  let i = start + 1;
  let value = '';
  while (i < n) {
    const c = raw[i]!;
    const code = c.codePointAt(0) ?? 0;
    if (c === '"') {
      return { kind: 'complete', end: i + 1, value };
    }
    if (c === '\\') {
      if (i + 1 >= n) return { kind: 'truncated' };
      const e = raw[i + 1]!;
      if (e === '"' || e === '\\' || e === '/' || e === 'b' || e === 'f' || e === 'n' || e === 'r' || e === 't') {
        value += unescapeJson(e);
        i += 2;
        continue;
      }
      if (e === 'u') {
        if (i + 6 > n) return { kind: 'truncated' };
        const h1 = raw[i + 2]!;
        const h2 = raw[i + 3]!;
        const h3 = raw[i + 4]!;
        const h4 = raw[i + 5]!;
        if (!isHex(h1) || !isHex(h2) || !isHex(h3) || !isHex(h4)) {
          return { kind: 'malformed', offset: i + 2 };
        }
        // JSON \uXXXX is a UTF-16 code unit, not a Unicode code point.
        value += String.fromCharCode(Number.parseInt(`${h1}${h2}${h3}${h4}`, 16));
        i += 6;
        continue;
      }
      return { kind: 'malformed', offset: i + 1 };
    }
    if (code < 0x20) return { kind: 'malformed', offset: i };
    value += c;
    i += 1;
  }
  return { kind: 'truncated' };
}

function unescapeJson(e: string): string {
  switch (e) {
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return e;
  }
}

function scanNumber(
  raw: string,
  start: number,
):
  | { readonly kind: 'complete'; readonly end: number }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'malformed'; readonly offset: number } {
  const n = raw.length;
  let i = start;
  let valid = false;
  if (raw[i] === '-') {
    i += 1;
    if (i >= n) return { kind: 'truncated' };
    if (!isDigit(raw[i]!)) return { kind: 'malformed', offset: i };
  }
  if (raw[i] === '0') {
    i += 1;
    valid = true;
    if (i < n && isDigit(raw[i]!)) return { kind: 'malformed', offset: i };
  } else if (i < n && raw[i]! >= '1' && raw[i]! <= '9') {
    i += 1;
    valid = true;
    while (i < n && isDigit(raw[i]!)) i += 1;
  } else {
    return { kind: 'malformed', offset: i };
  }
  if (i < n && raw[i] === '.') {
    i += 1;
    valid = false;
    if (i >= n) return { kind: 'truncated' };
    if (!isDigit(raw[i]!)) return { kind: 'malformed', offset: i };
    valid = true;
    i += 1;
    while (i < n && isDigit(raw[i]!)) i += 1;
  }
  if (i < n && (raw[i] === 'e' || raw[i] === 'E')) {
    i += 1;
    valid = false;
    if (i >= n) return { kind: 'truncated' };
    if (raw[i] === '+' || raw[i] === '-') {
      i += 1;
      if (i >= n) return { kind: 'truncated' };
    }
    if (!isDigit(raw[i]!)) return { kind: 'malformed', offset: i };
    valid = true;
    i += 1;
    while (i < n && isDigit(raw[i]!)) i += 1;
  }
  if (!valid) return { kind: 'truncated' };
  return { kind: 'complete', end: i };
}

function scanLiteral(
  raw: string,
  start: number,
):
  | { readonly kind: 'complete'; readonly end: number }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'malformed'; readonly offset: number } {
  const target = raw[start] === 't' ? 'true' : raw[start] === 'f' ? 'false' : 'null';
  const available = raw.length - start;
  if (available >= target.length) {
    if (raw.slice(start, start + target.length) === target) {
      return { kind: 'complete', end: start + target.length };
    }
    return { kind: 'malformed', offset: start };
  }
  const prefix = raw.slice(start);
  if (target.startsWith(prefix)) return { kind: 'truncated' };
  return { kind: 'malformed', offset: start };
}

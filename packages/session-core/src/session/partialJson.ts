/**
 * Partial JSON string-field scanner for streaming tool arguments.
 *
 * Mechanically ported from Letta Code `src/channels/channel-rich-draft-streamer.ts`
 * (`extractStringField`, `readJsonStringAt`, `decodeJsonStringFragment`,
 * `skipWhitespace`) at letta-ai/letta-code c0956ed3263da7f781a958ce35ff3042ef97adfa.
 * Copyright Letta, Inc. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Kiki adds indexed array fields
 * and shares the scanner between transcript projection and GUI drafts.
 */

export interface JsonStringRead {
  readonly value: string;
  readonly end: number;
  readonly complete: boolean;
}

/** The first top-level-or-nested `"field": "…"` value; partial values only when allowed. */
export function extractStringField(
  input: string,
  field: string,
  allowPartialValue: boolean,
): { value: string; complete: boolean } | null {
  let index = 0;
  while (index < input.length) {
    const quoteIndex = input.indexOf('"', index);
    if (quoteIndex === -1) return null;
    const key = readJsonStringAt(input, quoteIndex, false);
    if (!key) return null;
    index = key.end;
    let cursor = skipWhitespace(input, key.end);
    if (input[cursor] !== ':') continue;
    cursor = skipWhitespace(input, cursor + 1);
    if (key.value !== field) {
      index = cursor;
      continue;
    }
    if (input[cursor] !== '"') return null;
    const read = readJsonStringAt(input, cursor, allowPartialValue);
    return read === null ? null : { value: read.value, complete: read.complete };
  }
  return null;
}

export function readJsonStringAt(input: string, quoteIndex: number, allowPartial: boolean): JsonStringRead | null {
  if (input[quoteIndex] !== '"') return null;
  let raw = '';
  let cursor = quoteIndex + 1;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === '\\') {
      if (cursor + 1 >= input.length) {
        return allowPartial
          ? { value: decodeJsonStringFragment(raw, false), end: input.length, complete: false }
          : null;
      }
      raw += input.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (char === '"') {
      return { value: decodeJsonStringFragment(raw, true), end: cursor + 1, complete: true };
    }
    raw += char;
    cursor += 1;
  }
  return allowPartial
    ? { value: decodeJsonStringFragment(raw, false), end: input.length, complete: false }
    : null;
}

export function decodeJsonStringFragment(raw: string, complete: boolean): string {
  let candidate = raw;
  if (!complete) {
    candidate = candidate.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    if (candidate.endsWith('\\')) candidate = candidate.slice(0, -1);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return JSON.parse(`"${candidate}"`) as string;
    } catch {
      if (candidate.length === 0) break;
      candidate = candidate.slice(0, -1);
    }
  }
  return candidate
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"')
    .replaceAll('\\\\', '\\');
}

function skipWhitespace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && /\s/.test(input[cursor] ?? '')) cursor += 1;
  return cursor;
}

function objectFieldStart(input: string, field: string): number | undefined {
  if (input[skipWhitespace(input, 0)] !== '{') return undefined;
  let depth = 0;
  for (let pos = 0; pos < input.length; pos += 1) {
    const char = input[pos];
    if (char === '"') {
      const key = readJsonStringAt(input, pos, false);
      if (key === null) return undefined;
      const colon = skipWhitespace(input, key.end);
      if (depth === 1 && key.value === field && input[colon] === ':') {
        return skipWhitespace(input, colon + 1);
      }
      pos = key.end - 1;
    } else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;
    if (depth === 0 && char === '}') break;
  }
  return undefined;
}

/** Raw array slots, including the last incomplete slot; null until the top-level array starts. */
export function partialArrayItems(input: string, arrayField: string): readonly string[] | null {
  const start = objectFieldStart(input, arrayField);
  if (start === undefined || input[start] !== '[') return null;
  const items: string[] = [];
  let pos = skipWhitespace(input, start + 1);
  while (pos < input.length && input[pos] !== ']') {
    const itemStart = pos;
    let depth = 0;
    while (pos < input.length) {
      const char = input[pos];
      if (depth === 0 && (char === ',' || char === ']')) break;
      if (char === '"') {
        const read = readJsonStringAt(input, pos, false);
        pos = read?.end ?? input.length;
        if (depth === 0) break;
        continue;
      }
      pos += 1;
      if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const item = input.slice(itemStart, pos).trim();
    if (item !== '') items.push(item);
    pos = skipWhitespace(input, pos);
    if (input[pos] !== ',') break;
    pos = skipWhitespace(input, pos + 1);
  }
  return items;
}

export function extractArrayItemStringField(
  input: string,
  arrayField: string,
  targetIndex: number,
  field: string,
  allowPartial: boolean,
): { value: string; complete: boolean } | null {
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0) return null;
  const item = partialArrayItems(input, arrayField)?.[targetIndex];
  if (item === undefined) return null;
  const start = objectFieldStart(item, field);
  if (start === undefined || item[start] !== '"') return null;
  const value = readJsonStringAt(item, start, allowPartial);
  return value === null ? null : { value: value.value, complete: value.complete };
}

/** The visible draft of a streaming SendMessage call ('' until its `text` starts). */
export function streamingMessageText(argsText: string, itemIndex?: number): string {
  return itemIndex === undefined
    ? extractStringField(argsText, 'text', true)?.value ?? ''
    : extractArrayItemStringField(argsText, 'messages', itemIndex, 'text', true)?.value ?? '';
}

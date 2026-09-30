/**
 * Partial JSON string-field scanner for streaming tool arguments.
 *
 * Mechanically ported from Letta Code `src/channels/channel-rich-draft-streamer.ts`
 * (`extractStringField`, `readJsonStringAt`, `decodeJsonStringFragment`,
 * `skipWhitespace`) at letta-ai/letta-code c0956ed3263da7f781a958ce35ff3042ef97adfa.
 * Copyright Letta, Inc. Licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Kiki changes: exported the
 * field reader, dropped the channel-routing callers, typed the index access.
 *
 * The SendMessage draft bubble reads the completed prefix of the `text`
 * field out of argument text that is still arriving, so a half-received
 * escape (`\`, `\u00`) never flashes as raw characters.
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
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function skipWhitespace(input: string, index: number): number {
  let cursor = index;
  while (cursor < input.length && /\s/.test(input[cursor] ?? '')) cursor += 1;
  return cursor;
}

/** The visible draft of a streaming SendMessage call ('' until `text` starts). */
export function streamingMessageText(argsText: string): string {
  return extractStringField(argsText, 'text', true)?.value ?? '';
}

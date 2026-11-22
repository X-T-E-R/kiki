/**
 * A failure as one plain sentence. Agent and task errors often arrive as a
 * serialized payload (`{"error":{"message":"…"}}`, a JSON array of issues, a
 * stack). The rail shows the human part only; the full text stays one click
 * away in the agent's own timeline.
 */

const MESSAGE_KEYS = ['message', 'error_message', 'detail', 'reason', 'error', 'title'] as const;

function messageOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = messageOf(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of MESSAGE_KEYS) {
      const found = messageOf(record[key], depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The first balanced `{…}` / `[…]` span starting at `start`, honouring JSON strings. */
function balancedSpan(text: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if ((char === '}' || char === ']') && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

/** Try the whole text, then the first `{…}` / `[…]` span inside it, even with trailing prose. */
function parsePayload(text: string): unknown {
  const start = text.search(/[{[]/);
  const attempts = [text, start > 0 ? text.slice(start) : undefined, start >= 0 ? balancedSpan(text, start) : undefined];
  for (const attempt of attempts) {
    if (attempt === undefined) continue;
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // not JSON; try the next shape
    }
  }
  return undefined;
}

const MAX_LENGTH = 160;

/**
 * The readable line of an error, or undefined when nothing readable is left.
 * Never returns braces, quotes-and-colons JSON or a multi-line stack.
 */
export function plainFailure(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.trim();
  if (text === '') return undefined;
  if (/[{[]/.test(text)) {
    const payload = parsePayload(text);
    if (payload !== undefined) {
      const prefix = text.slice(0, Math.max(0, text.search(/[{[]/))).replace(/[\s:：-]+$/, '').trim();
      const message = messageOf(payload);
      if (message === undefined) return prefix === '' ? undefined : prefix;
      text = message.trim();
    }
  }
  // First meaningful line; a stack frame or an indented detail is not it.
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '' && !/^at\s/.test(part));
  if (line === undefined) return undefined;
  // A payload that did not parse still must not leak as JSON.
  if (/^[{[]/.test(line) && /[}\]]$/.test(line)) return undefined;
  const clean = line.replace(/^(?:Error|error):\s*/, '').replaceAll(/\s+/g, ' ');
  return clean.length > MAX_LENGTH ? `${clean.slice(0, MAX_LENGTH - 1)}…` : clean;
}

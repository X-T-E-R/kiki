/**
 * Turn any caught error / failed tool output into readable text for the UI.
 * Never yields "[object Object]": Error → message (+ code, + nested cause),
 * `{ message | error | stderr | stdout | text }` records → that text,
 * anything else → a truncated JSON summary.
 */

const MAX_SUMMARY = 300;
const MAX_DEPTH = 3;
const TEXT_KEYS = ['message', 'error', 'stderr', 'stdout', 'text', 'detail', 'reason'] as const;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function codeOf(record: Record<string, unknown>): string | undefined {
  const code = record['code'];
  if (typeof code === 'string' && code !== '') return code;
  if (typeof code === 'number') return String(code);
  return undefined;
}

function jsonSummary(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json === '{}' || json === '[]') return undefined;
    return json.length > MAX_SUMMARY ? `${json.slice(0, MAX_SUMMARY)}…` : json;
  } catch {
    return undefined;
  }
}

function format(value: unknown, depth: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    // Upstream code that already stringified an object: nothing readable left.
    return value.trim() === '' || value === '[object Object]' ? undefined : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested = record['error'];
  let message =
    stringField(record, 'message') ??
    (depth < MAX_DEPTH && nested !== undefined && nested !== null ? format(nested, depth + 1) : undefined) ??
    // Command output: stderr carries the failure; stdout is the fallback.
    stringField(record, 'stderr') ??
    stringField(record, 'stdout') ??
    stringField(record, 'text') ??
    stringField(record, 'detail') ??
    stringField(record, 'reason');
  if (message === undefined) {
    if (value instanceof Error) return value.name !== '' ? value.name : undefined;
    // A known text field that is blank means "no message", not "dump the object".
    if (TEXT_KEYS.some((key) => key in record)) return undefined;
    return jsonSummary(value);
  }
  const code = codeOf(record);
  if (code !== undefined && !message.includes(code)) message = `${message} (${code})`;
  if (depth < MAX_DEPTH && record['cause'] !== undefined) {
    const cause = format(record['cause'], depth + 1);
    if (cause !== undefined && !message.includes(cause)) message = `${message} — ${cause}`;
  }
  return message;
}

/** Readable text for an error-like value, or undefined when nothing is usable. */
export function describeError(value: unknown): string | undefined {
  return format(value, 0);
}

/** Readable text for an error-like value, with a fallback when nothing is usable. */
export function errorToText(value: unknown, fallback = 'Unknown error'): string {
  return format(value, 0) ?? fallback;
}

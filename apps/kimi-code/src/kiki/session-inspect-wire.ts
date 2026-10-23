import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { TranscriptWireRecord } from '@kiki/transcript';

export const SESSION_WIRE_WINDOW_BYTES = 8 << 20;
const MAX_LINE_BYTES = 64 << 20;
const CHUNK_BYTES = 64 << 10;

export interface SessionWireRecordSource {
  readonly byteOffset: number;
  readonly continuation: boolean;
}

export interface SessionWireCoverage {
  readonly startBoundary: 'turn' | 'record';
  readonly endBoundary: 'turn' | 'record' | 'watermark';
  readonly watermark: number;
  readonly startByteOffset: number;
  readonly endByteOffset: number;
  readonly bytesRead: number;
  readonly recordCount: number;
  readonly partialTail: boolean;
  readonly nextCursor: string | null;
}

interface WireCursor {
  readonly version: 1;
  readonly identity: string;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
  readonly mtimeMs: number;
  readonly watermark: number;
  readonly end: number;
  readonly endBoundary?: 'turn' | 'record';
}

export class SessionWireLimitError extends Error {}
export class SessionWireCursorError extends Error {}

export async function readSessionWireWindow(
  handle: FileHandle,
  info: Stats,
  identity: string,
  options: { readonly before?: string; readonly maxBytes?: number },
  onRecord: (record: TranscriptWireRecord, lineNumber: number, source: SessionWireRecordSource) => void,
): Promise<SessionWireCoverage> {
  const maxBytes = options.maxBytes ?? SESSION_WIRE_WINDOW_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > SESSION_WIRE_WINDOW_BYTES) {
    throw new SessionWireCursorError(`--max-bytes must be an integer from 1 to ${SESSION_WIRE_WINDOW_BYTES}.`);
  }
  const cursor = options.before === undefined ? undefined : decodeCursor(options.before, identity, info);
  const watermark = cursor?.watermark ?? info.size;
  const end = cursor?.end ?? watermark;
  const endBoundary = cursor === undefined ? 'watermark' : cursor.endBoundary ?? 'turn';
  const counter = { bytes: 0 };
  const boundary = end <= maxBytes ? { offset: 0, kind: 'turn' as const } : await precedingBoundary(handle, end - maxBytes, counter);
  const start = boundary.offset;
  const continuation = boundary.kind === 'record' || endBoundary === 'record';
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineOffset = start;
  let lineNumber = 0;
  let recordCount = 0;
  let partialTail = false;
  const consume = (terminated: boolean): void => {
    lineNumber++;
    const source = { byteOffset: lineOffset, continuation };
    lineOffset += lineBytes + (terminated ? 1 : 0);
    const line = lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineBytes);
    lineChunks = [];
    lineBytes = 0;
    const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    if (normalized.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalized.toString('utf8'));
    } catch (error) {
      if (!terminated) { partialTail = true; return; }
      throw new Error(`corrupted JSON at window line ${lineNumber}: ${String(error)}`, { cause: error });
    }
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      throw new Error(`window line ${lineNumber} is not a wire record with a string type`);
    }
    onRecord(parsed as TranscriptWireRecord, lineNumber, source);
    recordCount++;
  };
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = start;
  while (position < end) {
    const length = Math.min(chunk.length, end - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead === 0) throw new SessionWireCursorError('Wire shrank during inspection. Open the latest window again.');
    counter.bytes += bytesRead;
    position += bytesRead;
    let rest = chunk.subarray(0, bytesRead);
    for (;;) {
      const newline = rest.indexOf(10);
      const part = newline < 0 ? rest : rest.subarray(0, newline);
      if (lineBytes + part.length > MAX_LINE_BYTES) {
        throw new SessionWireLimitError(`A wire record exceeds the ${MAX_LINE_BYTES}-byte inspection limit; the session was not modified.`);
      }
      if (part.length > 0) { lineChunks.push(Buffer.from(part)); lineBytes += part.length; }
      if (newline < 0) break;
      consume(true);
      rest = rest.subarray(newline + 1);
    }
  }
  if (lineBytes > 0) consume(false);
  const after = await handle.stat();
  if (after.size < watermark || (after.size === info.size && after.mtimeMs !== info.mtimeMs)) {
    throw new SessionWireCursorError('Wire changed during inspection. Open the latest window again.');
  }
  return {
    startBoundary: boundary.kind, endBoundary,
    watermark, startByteOffset: start, endByteOffset: end, bytesRead: counter.bytes,
    recordCount, partialTail,
    nextCursor: start === 0 ? null : Buffer.from(JSON.stringify({
      version: 1, identity, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs,
      mtimeMs: cursor?.mtimeMs ?? info.mtimeMs, watermark, end: start, endBoundary: boundary.kind,
    } satisfies WireCursor)).toString('base64url'),
  };
}

function decodeCursor(value: string, identity: string, info: Stats): WireCursor {
  let parsed: WireCursor;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as WireCursor; }
  catch { throw new SessionWireCursorError('Invalid --before cursor.'); }
  if (parsed === null || parsed.version !== 1 || parsed.identity !== identity || parsed.dev !== info.dev ||
    parsed.ino !== info.ino || parsed.birthtimeMs !== info.birthtimeMs ||
    !Number.isSafeInteger(parsed.watermark) || parsed.watermark < 0 ||
    !Number.isSafeInteger(parsed.end) || parsed.end <= 0 || parsed.end > parsed.watermark ||
    (parsed.endBoundary !== undefined && parsed.endBoundary !== 'turn' && parsed.endBoundary !== 'record') ||
    !Number.isFinite(parsed.mtimeMs) || info.size < parsed.watermark ||
    (info.size === parsed.watermark && info.mtimeMs !== parsed.mtimeMs)) {
    throw new SessionWireCursorError('The --before cursor belongs to another or changed wire. Open the latest window again.');
  }
  return parsed;
}

async function precedingBoundary(
  handle: FileHandle,
  target: number,
  counter: { bytes: number },
): Promise<{ offset: number; kind: 'turn' | 'record' }> {
  let cursor = target;
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let skipPartial = true;
  let scanned = 0;
  let recordStart: number | undefined;
  let legacyStart: number | undefined;
  const turnStartKind = (): 'prompt' | 'legacy' | undefined => {
    const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts, lineBytes);
    const prefix = line.subarray(0, 512).toString('utf8');
    if (!/"type"\s*:\s*"(?:turn\.prompt|context\.append_message)"/.test(prefix)) return undefined;
    try {
      const record = JSON.parse(line.toString('utf8')) as { type?: string; delivery?: unknown; message?: { role?: string; origin?: { kind?: string } } };
      if (record.type === 'turn.prompt') return 'prompt';
      const origin = record.message?.origin?.kind;
      if (record.type === 'context.append_message' && record.delivery === undefined && record.message?.role === 'user' &&
        origin !== 'injection' && origin !== 'retry' && origin !== 'compaction_summary' && origin !== 'agent_message' && origin !== 'external_record') return 'legacy';
    } catch { return undefined; }
    return undefined;
  };
  while (cursor > 0 && scanned < MAX_LINE_BYTES) {
    const length = Math.min(CHUNK_BYTES, cursor, MAX_LINE_BYTES - scanned);
    const position = cursor - length;
    const block = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(block, 0, length, position);
    if (bytesRead !== length) throw new SessionWireCursorError('Wire changed while locating the window. Open the latest window again.');
    counter.bytes += bytesRead;
    scanned += bytesRead;
    let rest = length;
    for (let newline = block.lastIndexOf(10, rest - 1); newline >= 0; newline = rest === 0 ? -1 : block.lastIndexOf(10, rest - 1)) {
      const part = block.subarray(newline + 1, rest);
      parts.unshift(part); lineBytes += part.length;
      if (skipPartial) skipPartial = false;
      else {
        const offset = position + newline + 1;
        if (lineBytes > 0) recordStart ??= offset;
        const kind = turnStartKind();
        if (kind === 'prompt') return { offset, kind: 'turn' };
        if (kind === 'legacy') legacyStart ??= offset;
      }
      parts = []; lineBytes = 0; rest = newline;
    }
    if (rest > 0) { parts.unshift(block.subarray(0, rest)); lineBytes += rest; }
    cursor = position;
  }
  if (cursor === 0 && turnStartKind() === 'prompt') return { offset: 0, kind: 'turn' };
  if (legacyStart !== undefined) return { offset: legacyStart, kind: 'turn' };
  if (cursor === 0) return { offset: 0, kind: 'turn' };
  if (recordStart !== undefined) return { offset: recordStart, kind: 'record' };
  throw new SessionWireLimitError(`A wire record spans more than the ${MAX_LINE_BYTES}-byte boundary search limit; use a streaming reader for this record. The session is not damaged or modified.`);
}

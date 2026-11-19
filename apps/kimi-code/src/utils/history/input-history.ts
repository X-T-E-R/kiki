/**
 * User input history persistence — JSONL file with `{"content": "..."}` per line.
 *
 * Semantics:
 * - One JSON object per line (`InputHistoryEntry { content }`)
 * - `content` is the raw input. Shell commands are stored with a leading `!`
 *   (e.g. `!ls -la`) so ↑ recall can distinguish them from prompts and restore
 *   bash mode; the `!` is stripped again when the entry is recalled. Plain
 *   prompts (and legacy entries without a leading `!`) are normal prompts.
 * - Append-only writes with bounded tail retention and periodic atomic compaction
 * - Skip empty entries
 * - Skip when same as last entry (consecutive deduplication)
 * - Tolerate corrupt lines: skip, do not abort load
 */

import { open, stat } from 'node:fs/promises';

import { z } from 'zod';

import { appendJsonlLine, writeTextFileAtomic } from '#/utils/persistence';

export const MAX_INPUT_HISTORY_ENTRIES = 100;
const COMPACT_THRESHOLD_ENTRIES = MAX_INPUT_HISTORY_ENTRIES * 2;
const MAX_TAIL_READ_BYTES = 512 * 1024;
const COMPACT_CHECK_EVERY_APPENDS = 50;

const appendCounts = new Map<string, number>();

export interface InputHistoryEntry {
  content: string;
}

const InputHistoryEntrySchema: z.ZodType<InputHistoryEntry> = z.object({
  content: z.string(),
});

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

async function readTailText(file: string): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.size === 0) return { text: '', truncated: false };
    const truncated = info.size > MAX_TAIL_READ_BYTES;
    const length = truncated ? MAX_TAIL_READ_BYTES : info.size;
    const offset = truncated ? info.size - length : 0;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf-8');
    if (truncated) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

function parseEntries(raw: string): { entries: InputHistoryEntry[]; nonEmptyLineCount: number } {
  const entries: InputHistoryEntry[] = [];
  let nonEmptyLineCount = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    nonEmptyLineCount += 1;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const result = InputHistoryEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch {
      // JSONL is append-only user data; tolerate bad rows and keep the rest.
    }
  }
  return { entries, nonEmptyLineCount };
}

async function compactHistoryFile(file: string, entries: readonly InputHistoryEntry[]): Promise<void> {
  const serialized =
    entries.length === 0 ? '' : `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  await writeTextFileAtomic(file, serialized);
}

export async function loadInputHistory(file: string): Promise<InputHistoryEntry[]> {
  const tail = await readTailText(file);
  if (tail === null) return [];

  const { entries, nonEmptyLineCount } = parseEntries(tail.text);
  const bounded =
    entries.length > MAX_INPUT_HISTORY_ENTRIES
      ? entries.slice(-MAX_INPUT_HISTORY_ENTRIES)
      : entries;

  if (tail.truncated || nonEmptyLineCount > COMPACT_THRESHOLD_ENTRIES) {
    await compactHistoryFile(file, bounded).catch(() => {});
  }
  return bounded;
}

/**
 * Append an entry to the history file. Returns true if written, false if
 * skipped (empty or equal to `lastContent`).
 */
export async function appendInputHistory(
  file: string,
  text: string,
  lastContent?: string,
): Promise<boolean> {
  const content = text.trim();
  if (content.length === 0) return false;
  if (content === lastContent) return false;
  await appendJsonlLine(file, InputHistoryEntrySchema, { content });

  const nextCount = (appendCounts.get(file) ?? 0) + 1;
  if (nextCount >= COMPACT_CHECK_EVERY_APPENDS) {
    appendCounts.set(file, 0);
    await maybeCompactAfterAppend(file).catch(() => {});
  } else {
    appendCounts.set(file, nextCount);
  }
  return true;
}

async function maybeCompactAfterAppend(file: string): Promise<void> {
  const info = await stat(file);
  if (info.size > MAX_TAIL_READ_BYTES) {
    await loadInputHistory(file);
    return;
  }
  const tail = await readTailText(file);
  if (tail === null) return;
  const { entries, nonEmptyLineCount } = parseEntries(tail.text);
  if (nonEmptyLineCount > COMPACT_THRESHOLD_ENTRIES) {
    await compactHistoryFile(file, entries.slice(-MAX_INPUT_HISTORY_ENTRIES));
  }
}

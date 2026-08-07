/**
 * Unified-diff hunk builder for edit-style tool calls (Edit / MultiEdit /
 * Write), computed client-side from the tool input's before/after strings.
 *
 * Recipe ported from grok-build (https://github.com/…/grok-build —
 * `crates/codegen/xai-grok-pager/src/diff.rs` + `scrollback/blocks/tool/
 * edit.rs`, Apache-2.0), with the `diff` package's line diff in place of
 * Rust's `similar`:
 *   - unified hunks with at most 3 context lines around each change
 *   - changes whose context windows touch (gap ≤ 2×context) share one hunk
 *   - blank equal lines trimmed from hunk edges
 *   - `… N unchanged lines` separators between hunks (line-number gap math)
 *   - single new-file line-number column (deletes show their old-file number)
 *   - `+N/-M` diffstat counted over hunk rows
 */

import { diffLines } from 'diff';

export type DiffTag = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  readonly text: string;
  /** 1-based old-file line number (0 for inserted lines). */
  readonly lo: number;
  /** 1-based new-file line number (0 for deleted lines). */
  readonly ln: number;
  readonly tag: DiffTag;
}

export type DiffHunk = readonly DiffLine[];

/** Context lines kept around each change (grok-build's MAX_CONTEXT). */
export const MAX_CONTEXT_LINES = 3;

/**
 * Build unified hunks from full before/after text. `startLine` is the 1-based
 * line number the texts begin at in their files (1 for whole-file inputs).
 */
export function buildHunks(oldText: string, newText: string, startLine = 1): DiffHunk[] {
  const parts = diffLines(oldText, newText);
  const rows: DiffLine[] = [];
  let lo = startLine;
  let ln = startLine;
  for (const part of parts) {
    const tag: DiffTag = part.added === true ? 'insert' : part.removed === true ? 'delete' : 'equal';
    const lines = part.value.split('\n');
    // diffLines values keep their trailing '\n', which splits into a phantom
    // empty final element — drop it (a real blank line ends the value without
    // a terminator and survives as a legitimately empty entry mid-list).
    if (lines.at(-1) === '') lines.pop();
    for (const text of lines) {
      rows.push({ text, lo, ln, tag });
      if (tag !== 'insert') lo += 1;
      if (tag !== 'delete') ln += 1;
    }
  }

  const hunks: DiffLine[][] = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index]!.tag === 'equal') {
      index += 1;
      continue;
    }
    // Leading context of the first change in this hunk.
    const start = Math.max(0, index - MAX_CONTEXT_LINES);
    // Extend while equal runs are small enough for context windows to touch.
    let scan = index;
    let lastChange = index;
    while (scan < rows.length) {
      if (rows[scan]!.tag !== 'equal') {
        lastChange = scan;
      } else if (scan - lastChange > 2 * MAX_CONTEXT_LINES) {
        break;
      }
      scan += 1;
    }
    const end = Math.min(rows.length, lastChange + 1 + MAX_CONTEXT_LINES);
    let hunkStart = start;
    let hunkEnd = end;
    // Trim blank equal rows at the hunk edges (grok-build's blank-edge pass).
    while (
      hunkStart < hunkEnd &&
      rows[hunkStart]!.tag === 'equal' &&
      rows[hunkStart]!.text.trim() === ''
    ) {
      hunkStart += 1;
    }
    while (
      hunkEnd > hunkStart &&
      rows[hunkEnd - 1]!.tag === 'equal' &&
      rows[hunkEnd - 1]!.text.trim() === ''
    ) {
      hunkEnd -= 1;
    }
    hunks.push(rows.slice(hunkStart, hunkEnd));
    index = scan;
  }
  return hunks;
}

/** Insertions/deletions across all hunks (context excluded). */
export function diffStat(hunks: readonly DiffHunk[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk) {
      if (line.tag === 'insert') insertions += 1;
      else if (line.tag === 'delete') deletions += 1;
    }
  }
  return { insertions, deletions };
}

/**
 * Unchanged new-file lines hidden between two hunks — grok-build's
 * `hunk_gap_lines`: uses the `ln` of the new-file rows (equal/insert)
 * bordering the gap; undefined when either hunk has no new-file row (pure
 * deletions) or the gap is non-positive, in which case the separator shows no
 * count rather than a wrong one.
 */
export function hunkGapLines(prev: DiffHunk, next: DiffHunk): number | undefined {
  const prevLast = prev.toReversed().find((line) => line.tag !== 'delete');
  const nextFirst = next.find((line) => line.tag !== 'delete');
  if (prevLast === undefined || nextFirst === undefined) return undefined;
  const gap = nextFirst.ln - prevLast.ln - 1;
  return gap > 0 ? gap : undefined;
}

// ---------------------------------------------------------------------------
// Tool-input extraction: where before/after strings live for each edit tool.
// ---------------------------------------------------------------------------

export interface EditSource {
  readonly path: string | undefined;
  readonly hunks: readonly DiffHunk[];
}

function hunksFor(before: string, after: string): readonly DiffHunk[] {
  return buildHunks(before, after);
}

interface FileIoDisplay {
  kind: 'file_io';
  operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
  path: string;
  content?: string;
  before?: string;
  after?: string;
}

interface DiffDisplay {
  kind: 'diff';
  path: string;
  before: string;
  after: string;
}

/**
 * Extract diff hunks from a tool block's display payload (preferred — it is
 * the server's display-normalized projection) or, failing that, its raw args.
 * Returns undefined when the call is not an edit-style call or carries no
 * usable before/after text.
 */
export function extractEditSource(display: unknown, args: unknown): EditSource | undefined {
  const fromDisplay = fromDisplayPayload(display);
  if (fromDisplay !== undefined) return fromDisplay;
  return fromArgs(args);
}

function fromDisplayPayload(display: unknown): EditSource | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const kind = (display as { kind?: unknown }).kind;
  if (kind === 'diff') {
    const d = display as DiffDisplay;
    if (typeof d.before === 'string' && typeof d.after === 'string') {
      return { path: d.path, hunks: hunksFor(d.before, d.after) };
    }
    return undefined;
  }
  if (kind === 'file_io') {
    const d = display as FileIoDisplay;
    if (d.operation === 'edit' && typeof d.before === 'string' && typeof d.after === 'string') {
      return { path: d.path, hunks: hunksFor(d.before, d.after) };
    }
    if (d.operation === 'write' && typeof d.content === 'string') {
      // Write with a `before` is a full-file rewrite; without one it's a create.
      return {
        path: d.path,
        hunks: hunksFor(typeof d.before === 'string' ? d.before : '', d.content),
      };
    }
  }
  return undefined;
}

interface EditArgs {
  file_path?: string;
  path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: readonly { old_string?: string; new_string?: string }[];
}

function fromArgs(args: unknown): EditSource | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as EditArgs;
  const path = record.file_path ?? record.path;

  // MultiEdit: independent per-edit hunks (no stitching — edits are applied
  // server-side; we only display).
  if (Array.isArray(record.edits)) {
    const hunks: DiffHunk[] = [];
    for (const edit of record.edits) {
      if (typeof edit.old_string === 'string' && typeof edit.new_string === 'string') {
        hunks.push(...hunksFor(edit.old_string, edit.new_string));
      }
    }
    return hunks.length > 0 ? { path, hunks } : undefined;
  }
  // Edit: single search/replace.
  if (typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return { path, hunks: hunksFor(record.old_string, record.new_string) };
  }
  // Write: whole-file create (empty before).
  if (typeof record.content === 'string' && path !== undefined) {
    return { path, hunks: hunksFor('', record.content) };
  }
  return undefined;
}

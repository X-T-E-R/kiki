/**
 * Header chip providers — produce a short "stat" suffix appended to the
 * tool call header once a result has arrived. Chips own the *numeric*
 * summary (line counts, exit codes, byte sizes), so summary renderers
 * below don't repeat them.
 *
 * A chip returning `''` is suppressed; tools without an entry in the
 * registry get no chip at all.
 */

import { computeDiffLines } from '#/tui/components/media/diff-preview';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { goalStatusChip } from './goal';
import { readMediaChip } from './media';
import { strArg } from './types';
import { taskWaitChip } from './task-wait';

export type ChipProvider = (toolCall: ToolCallBlockData, result: ToolResultBlockData) => string;

export function countNonEmptyLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const line of text.split('\n')) if (line.length > 0) n++;
  return n;
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface EditStats {
  readonly added: number;
  readonly removed: number;
}

export interface WriteStats {
  readonly lines: number;
}

export interface EditHunk {
  readonly oldText: string;
  readonly newText: string;
}

function editHunk(args: Record<string, unknown>): EditHunk | undefined {
  const oldText = strArg(args, 'old_string');
  const newText = strArg(args, 'new_string');
  return oldText.length === 0 && newText.length === 0 ? undefined : { oldText, newText };
}

/**
 * The replacements an Edit call carries: one for the `old_string` /
 * `new_string` form, one per entry for the `edits` form, in order.
 */
export function editHunks(args: Record<string, unknown>): EditHunk[] {
  const edits = args['edits'];
  if (!Array.isArray(edits)) {
    const single = editHunk(args);
    return single === undefined ? [] : [single];
  }
  const hunks: EditHunk[] = [];
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) continue;
    const hunk = editHunk(edit as Record<string, unknown>);
    if (hunk !== undefined) hunks.push(hunk);
  }
  return hunks;
}

export function computeEditStats(args: Record<string, unknown>): EditStats {
  let added = 0;
  let removed = 0;
  for (const hunk of editHunks(args)) {
    for (const line of computeDiffLines(hunk.oldText, hunk.newText)) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'delete') removed++;
    }
  }
  return { added, removed };
}

export function computeWriteStats(args: Record<string, unknown>): WriteStats {
  const content = strArg(args, 'content');
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = normalized.length > 0 ? normalized.split('\n').length : 0;
  return { lines };
}

export function formatEditChip(stats: EditStats): string {
  const parts: string[] = [];
  if (stats.added > 0) parts.push(`+${String(stats.added)}`);
  if (stats.removed > 0) parts.push(`-${String(stats.removed)}`);
  return parts.join(' ');
}

export function formatWriteChip(stats: WriteStats): string {
  return pluralize(stats.lines, 'line');
}

const editChip: ChipProvider = (toolCall) => {
  const stats = computeEditStats(toolCall.args);
  if (stats.added === 0 && stats.removed === 0) return '';
  return formatEditChip(stats);
};

const writeChip: ChipProvider = (toolCall) => formatWriteChip(computeWriteStats(toolCall.args));

const readChip: ChipProvider = (_toolCall, result) =>
  pluralize(countNonEmptyLines(result.output), 'line');

const grepChip: ChipProvider = (_toolCall, result) => {
  const matches = countNonEmptyLines(result.output);
  if (matches === 0) return 'no matches';
  return pluralize(matches, 'match', 'matches');
};

const globChip: ChipProvider = (_toolCall, result) => {
  const files = countNonEmptyLines(result.output);
  if (files === 0) return 'no files';
  return pluralize(files, 'file');
};

const fetchChip: ChipProvider = (_toolCall, result) =>
  formatBytes(Buffer.byteLength(result.output, 'utf8'));

const webSearchChip: ChipProvider = (_toolCall, result) => {
  const lines = result.output.split('\n').filter((l) => l.trim().length > 0);
  let count = 0;
  for (const line of lines) {
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) count++;
  }
  if (count === 0) return lines.length === 0 ? 'no results' : 'web result';
  return pluralize(count, 'result');
};

const goalStatusOutputChip: ChipProvider = (_toolCall, result) =>
  result.is_error ? '' : goalStatusChip(result.output);

const REGISTRY: Record<string, ChipProvider> = {
  Edit: editChip,
  Write: writeChip,
  Read: readChip,
  ReadMediaFile: readMediaChip,
  Grep: grepChip,
  Glob: globChip,
  FetchURL: fetchChip,
  WebSearch: webSearchChip,
  CreateGoal: goalStatusOutputChip,
  GetGoal: goalStatusOutputChip,
  TaskWait: taskWaitChip,
};

export function pickChip(toolName: string): ChipProvider | undefined {
  return REGISTRY[toolName];
}

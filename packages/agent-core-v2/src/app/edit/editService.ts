import { makeCarriageReturnsVisible } from '#/_base/text/line-endings';
import { sliceUtf16 } from '#/_base/text/utf16';

import type { TextModel } from './textModel';

export interface EditOperation {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all: boolean;
}

export interface EditApplyInput {
  readonly path: string;
  readonly edits: readonly EditOperation[];
}

/** Inclusive 1-based first and last line of a changed region in the edited text. */
export type EditLineRange = readonly [number, number];

export type EditApplyResult =
  | {
      readonly ok: true;
      readonly rawContent: string;
      readonly replacements: number;
      readonly changedLines: readonly EditLineRange[];
    }
  | { readonly ok: false; readonly error: string; readonly editIndex: number };

interface Region {
  readonly start: number;
  readonly end: number;
}

interface LooseMatch {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

const MAX_LISTED_LINES = 10;
const MAX_LOOSE_MATCHES = 5;
const MAX_SHOWN_TEXT = 4000;
const MAX_QUOTED_LINE = 120;
const READ_PREFIX_RE = /^\s*(\d+)\t/;

function occurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  if (needle.length === 0) return positions;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(needle, from);
    if (index === -1) break;
    positions.push(index);
    from = index + needle.length;
  }
  return positions;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function rangeLabel(range: EditLineRange): string {
  return range[0] === range[1] ? String(range[0]) : `${String(range[0])}–${String(range[1])}`;
}

/** Formats line ranges as `line 4` or `lines 4–6, 9`, listing at most ten. */
export function linesLabel(ranges: readonly EditLineRange[]): string {
  const shown = ranges.slice(0, MAX_LISTED_LINES).map(rangeLabel).join(', ');
  const more = ranges.length > MAX_LISTED_LINES ? ` and ${String(ranges.length - MAX_LISTED_LINES)} more` : '';
  const single = ranges.length === 1 && ranges[0]![0] === ranges[0]![1];
  return `${single ? 'line' : 'lines'} ${shown}${more}`;
}

function distinctLines(lines: readonly number[]): EditLineRange[] {
  return [...new Set(lines)].map((line) => [line, line] as const);
}

function mergeRegion(regions: readonly Region[], start: number, oldEnd: number, newLength: number): Region[] {
  const delta = newLength - (oldEnd - start);
  let mergedStart = start;
  let mergedEnd = start + newLength;
  const next: Region[] = [];
  for (const region of regions) {
    if (region.end < start) {
      next.push(region);
    } else if (region.start > oldEnd) {
      next.push({ start: region.start + delta, end: region.end + delta });
    } else {
      mergedStart = Math.min(mergedStart, region.start);
      if (region.end > oldEnd) mergedEnd = Math.max(mergedEnd, region.end + delta);
    }
  }
  next.push({ start: mergedStart, end: mergedEnd });
  return next;
}

function changedLineRanges(text: string, regions: readonly Region[]): EditLineRange[] {
  const starts = lineStarts(text);
  const ranges = regions
    .map((region): [number, number] => [
      lineAt(starts, region.start),
      lineAt(starts, Math.max(region.start, region.end - 1)),
    ])
    .toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function withoutReadPrefixes(needle: string): string | undefined {
  const lines = needle.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  let expected: number | undefined;
  const stripped: string[] = [];
  for (const line of lines) {
    const match = READ_PREFIX_RE.exec(line);
    if (match === null) return undefined;
    const number = Number(match[1]);
    if (expected !== undefined && number !== expected) return undefined;
    expected = number + 1;
    stripped.push(line.slice(match[0].length));
  }
  return stripped.join('\n') + (needle.endsWith('\n') ? '\n' : '');
}

function collapseWhitespace(line: string): string {
  return line.replaceAll(/\s+/g, ' ').trim();
}

function looseMatches(text: string, needle: string): LooseMatch[] {
  const wanted = needle.split('\n').map(collapseWhitespace);
  while (wanted.length > 0 && wanted[0] === '') wanted.shift();
  while (wanted.length > 0 && wanted.at(-1) === '') wanted.pop();
  if (wanted.length === 0) return [];
  const fileLines = text.split('\n');
  const collapsed = fileLines.map(collapseWhitespace);
  const last = wanted.length - 1;
  const matches: LooseMatch[] = [];
  for (let start = 0; start + last < collapsed.length && matches.length < MAX_LOOSE_MATCHES; start += 1) {
    const fits = last === 0
      ? collapsed[start]!.includes(wanted[0]!)
      : collapsed[start]!.endsWith(wanted[0]!) &&
        collapsed[start + last]!.startsWith(wanted[last]!) &&
        wanted.slice(1, last).every((line, offset) => collapsed[start + 1 + offset] === line);
    if (!fits) continue;
    matches.push({
      startLine: start + 1,
      endLine: start + last + 1,
      text: fileLines.slice(start, start + last + 1).join('\n'),
    });
    start += last;
  }
  return matches;
}

function notFoundMessage(model: TextModel, text: string, path: string, needle: string): string {
  const head = `old_string not found in ${path}.`;
  const stripped = withoutReadPrefixes(needle);
  if (stripped !== undefined) {
    const positions = occurrences(text, stripped);
    const where = positions.length === 1
      ? ` Without them it matches the file once, starting at line ${String(lineAt(lineStarts(text), positions[0]!))}.`
      : '';
    return `${head} Each line of old_string starts with a line number and a tab copied from Read output; those prefixes are not part of the file. Remove them and retry.${where}`;
  }
  const loose = looseMatches(text, needle);
  if (loose.length > 0) {
    const first = loose[0]!;
    const others = loose.length > 1
      ? ` ${linesLabel(loose.slice(1).map((match) => [match.startLine, match.endLine] as const))} also match that way.`
      : '';
    const visible = model.lineEndingStyle === 'mixed' ? makeCarriageReturnsVisible(first.text) : first.text;
    const shown = visible.length > MAX_SHOWN_TEXT ? `${sliceUtf16(visible, 0, MAX_SHOWN_TEXT)}…` : visible;
    return `${head} ${linesLabel([[first.startLine, first.endLine]])} match it when whitespace is ignored, so indentation, spacing or line endings differ.${others} The file has:\n${shown}\nUse that text exactly as old_string.`;
  }
  const firstLine = needle.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine === undefined) return `${head} old_string contains only whitespace.`;
  const quoted = JSON.stringify(firstLine.length > MAX_QUOTED_LINE ? `${sliceUtf16(firstLine, 0, MAX_QUOTED_LINE)}…` : firstLine);
  const lines = text.split('\n').flatMap((line, index) => line.includes(firstLine) ? [index + 1] : []);
  if (lines.length === 0) {
    return `${head} Its first line, ${quoted}, does not appear in the file either. Read the part you meant to change, or find it with Grep.`;
  }
  return `${head} Its first line, ${quoted}, appears at ${linesLabel(distinctLines(lines))}, so a later line of old_string differs from the file there. Read from that line to compare.`;
}

function notUniqueMessage(text: string, path: string, positions: readonly number[]): string {
  const starts = lineStarts(text);
  const lines = distinctLines(positions.map((position) => lineAt(starts, position)));
  return (
    `old_string matches ${String(positions.length)} places in ${path} (${linesLabel(lines)}). ` +
    'Add neighbouring lines to old_string so it matches only one place, or set replace_all=true to change every match.'
  );
}

export class EditService {
  apply(model: TextModel, input: EditApplyInput): EditApplyResult {
    let text = model.text;
    let regions: Region[] = [];
    let replacements = 0;
    for (const [editIndex, edit] of input.edits.entries()) {
      const positions = occurrences(text, edit.old_string);
      if (positions.length === 0) {
        return { ok: false, editIndex, error: notFoundMessage(model, text, input.path, edit.old_string) };
      }
      if (positions.length > 1 && !edit.replace_all) {
        return { ok: false, editIndex, error: notUniqueMessage(text, input.path, positions) };
      }
      const parts: string[] = [];
      let cursor = 0;
      let shift = 0;
      for (const position of positions) {
        parts.push(text.slice(cursor, position), edit.new_string);
        cursor = position + edit.old_string.length;
        const start = position + shift;
        regions = mergeRegion(regions, start, start + edit.old_string.length, edit.new_string.length);
        shift += edit.new_string.length - edit.old_string.length;
      }
      parts.push(text.slice(cursor));
      text = parts.join('');
      replacements += positions.length;
    }
    return {
      ok: true,
      rawContent: model.materialize(text),
      replacements,
      changedLines: changedLineRanges(text, regions),
    };
  }
}

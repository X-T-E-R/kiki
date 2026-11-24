/**
 * Diff preview rendering as plain ANSI strings.
 *
 * Reuses the diff algorithm from approval/DiffPreview.tsx, but outputs
 * formatted text lines instead of React elements.
 */

import chalk from 'chalk';
import { diffArrays, diffWords } from 'diff';

import { truncateToWidth, visibleWidth } from '@kiki/pi-tui';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { currentTheme } from '#/tui/theme';

export type DiffLineKind = 'context' | 'add' | 'delete';

interface DiffStyles {
  add: (s: string) => string;
  del: (s: string) => string;
  addBold: (s: string) => string;
  delBold: (s: string) => string;
  addBg: (s: string) => string;
  delBg: (s: string) => string;
  addWord: (s: string) => string;
  delWord: (s: string) => string;
  gutter: (s: string) => string;
  meta: (s: string) => string;
  useBackground: boolean;
}

function makeDiffStyles(): DiffStyles {
  const palette = currentTheme.palette;
  const useBackground = chalk.level >= 2;
  return {
    add: (s) => chalk.hex(palette.diffAdded)(s),
    del: (s) => chalk.hex(palette.diffRemoved)(s),
    addBold: (s) => chalk.bold.hex(palette.diffAddedStrong)(s),
    delBold: (s) => chalk.bold.hex(palette.diffRemovedStrong)(s),
    addBg: (s) => (useBackground ? chalk.bgHex(palette.diffAddedBg)(s) : chalk.hex(palette.diffAdded)(s)),
    delBg: (s) => (useBackground ? chalk.bgHex(palette.diffRemovedBg)(s) : chalk.hex(palette.diffRemoved)(s)),
    addWord: (s) =>
      useBackground
        ? chalk.bold.bgHex(palette.diffAddedWordBg).hex(palette.diffAddedStrong)(s)
        : chalk.bold.hex(palette.diffAddedStrong)(s),
    delWord: (s) =>
      useBackground
        ? chalk.bold.bgHex(palette.diffRemovedWordBg).hex(palette.diffRemovedStrong)(s)
        : chalk.bold.hex(palette.diffRemovedStrong)(s),
    gutter: (s) => chalk.hex(palette.diffGutter)(s),
    meta: (s) => chalk.hex(palette.diffMeta)(s),
    useBackground,
  };
}

/**
 * Ported from pi-mono MIT intra-line word diff (`renderIntraLineDiff`):
 * preserves shared leading whitespace so indentation doesn't flash as changed.
 */
function renderIntraLineWordPair(
  oldCode: string,
  newCode: string,
  s: DiffStyles,
): { readonly removed: string; readonly added: string } {
  const oldLead = oldCode.match(/^\s*/u)?.[0] ?? '';
  const newLead = newCode.match(/^\s*/u)?.[0] ?? '';
  let commonLen = 0;
  const maxCommon = Math.min(oldLead.length, newLead.length);
  while (commonLen < maxCommon && oldLead[commonLen] === newLead[commonLen]) commonLen++;
  const sharedIndent = oldLead.slice(0, commonLen);
  const parts = diffWords(oldCode.slice(commonLen), newCode.slice(commonLen));
  let removed = s.del(sharedIndent);
  let added = s.add(sharedIndent);
  for (const part of parts) {
    if (part.removed) {
      removed += s.delWord(part.value);
    } else if (part.added) {
      added += s.addWord(part.value);
    } else {
      removed += s.del(part.value);
      added += s.add(part.value);
    }
  }
  return {
    removed: s.useBackground ? s.delBg(removed) : removed,
    added: s.useBackground ? s.addBg(added) : added,
  };
}

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  code: string;
}

export function computeDiffLines(
  oldText: string,
  newText: string,
  oldStart: number = 1,
  newStart: number = 1,
  isIncomplete: boolean = false,
): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const changes = diffArrays(oldLines, newLines);

  const result: DiffLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  for (const hunk of changes) {
    if (hunk.removed) {
      for (const code of hunk.value) {
        result.push({ kind: 'delete', lineNum: oldLine++, code });
      }
    } else if (hunk.added) {
      for (const code of hunk.value) {
        result.push({ kind: 'add', lineNum: newLine++, code });
      }
    } else {
      for (const code of hunk.value) {
        result.push({ kind: 'context', lineNum: newLine, code });
        oldLine++;
        newLine++;
      }
    }
  }

  // While the text is still streaming, suppress trailing delete lines.
  // They are likely artefacts of newText not having arrived yet rather
  // than genuine deletions.
  if (isIncomplete && result.length > 0) {
    let lastNonDelete = result.length - 1;
    while (lastNonDelete >= 0 && result[lastNonDelete]!.kind === 'delete') {
      lastNonDelete--;
    }
    if (lastNonDelete >= 0) {
      result.length = lastNonDelete + 1;
    } else {
      // Every line would be shown as deleted; suppress them all so the
      // UI doesn't flash a wall of red before newText starts arriving.
      result.length = 0;
    }
  }

  return result;
}

export function renderDiffLines(
  oldText: string,
  newText: string,
  path: string,
  isIncomplete: boolean = false,
  oldStart?: number,
  newStart?: number,
  maxLines?: number,
): string[] {
  const s = makeDiffStyles();
  const diffLines = computeDiffLines(oldText, newText, oldStart ?? 1, newStart ?? 1, isIncomplete);
  const changedLines = diffLines.filter((l) => l.kind !== 'context');
  const added = changedLines.filter((l) => l.kind === 'add').length;
  const removed = changedLines.filter((l) => l.kind === 'delete').length;

  const output: string[] = [];

  let header = '';
  if (added > 0) header += s.addBold(`+${String(added)} `);
  if (removed > 0) header += s.delBold(`-${String(removed)} `);
  header += path;
  output.push(header);

  const shown =
    maxLines !== undefined && maxLines >= 0 && changedLines.length > maxLines
      ? changedLines.slice(0, maxLines)
      : changedLines;

  for (const line of shown) {
    const marker = line.kind === 'add' ? '+' : '-';
    const color = line.kind === 'add' ? s.add : s.del;
    output.push(s.gutter(String(line.lineNum).padStart(4) + ' ') + color(marker + ' ' + line.code));
  }

  const hidden = changedLines.length - shown.length;
  if (hidden > 0) {
    output.push(
      s.meta(
        `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (Ctrl+O to expand)`,
      ),
    );
  }

  return output;
}

export interface ClusteredDiffOptions {
  readonly contextLines?: number;
  readonly maxLines?: number;
  readonly isIncomplete?: boolean;
  readonly expandKeyHint?: string;
  readonly oldStart?: number;
  readonly newStart?: number;
}

interface Cluster {
  readonly start: number;
  readonly end: number;
}

function buildClusters(
  diffLines: DiffLine[],
  contextLines: number,
): { clusters: Cluster[]; changedCount: number; addedCount: number; removedCount: number } {
  const changeIndices: number[] = [];
  let added = 0;
  let removed = 0;
  for (const [i, line] of diffLines.entries()) {
    if (line.kind === 'add') {
      added++;
      changeIndices.push(i);
    } else if (line.kind === 'delete') {
      removed++;
      changeIndices.push(i);
    }
  }

  const clusters: Cluster[] = [];
  if (changeIndices.length === 0) {
    return { clusters, changedCount: 0, addedCount: added, removedCount: removed };
  }

  const mergeGap = 2 * contextLines;
  let groupStart = changeIndices[0]!;
  let groupEnd = changeIndices[0]!;
  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx;
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  });

  return {
    clusters,
    changedCount: changeIndices.length,
    addedCount: added,
    removedCount: removed,
  };
}

function formatDiffRow(
  line: DiffLine,
  s: DiffStyles,
  renderedCode?: string,
): string {
  const gutter = s.gutter(String(line.lineNum).padStart(4) + ' ');
  if (line.kind === 'add') {
    const body = renderedCode ?? (s.useBackground ? s.addBg(s.add(line.code)) : s.add(line.code));
    return gutter + s.add('+ ') + body;
  }
  if (line.kind === 'delete') {
    const body = renderedCode ?? (s.useBackground ? s.delBg(s.del(line.code)) : s.del(line.code));
    return gutter + s.del('- ') + body;
  }
  return gutter + '  ' + (renderedCode ?? line.code);
}

function buildRenderedClusterRows(
  diffLines: readonly DiffLine[],
  start: number,
  end: number,
  path: string,
  s: DiffStyles,
): Map<number, string> {
  const rendered = new Map<number, string>();
  const lang = langFromPath(path);
  let i = start;
  while (i <= end) {
    const line = diffLines[i]!;
    if (line.kind === 'delete') {
      const delStart = i;
      while (i <= end && diffLines[i]!.kind === 'delete') i++;
      const addStart = i;
      while (i <= end && diffLines[i]!.kind === 'add') i++;
      const delCount = addStart - delStart;
      const addCount = i - addStart;
      if (delCount > 0 && delCount === addCount) {
        for (let k = 0; k < delCount; k++) {
          const pair = renderIntraLineWordPair(
            diffLines[delStart + k]!.code,
            diffLines[addStart + k]!.code,
            s,
          );
          rendered.set(delStart + k, pair.removed);
          rendered.set(addStart + k, pair.added);
        }
      }
      continue;
    }
    if (line.kind === 'context' && lang !== undefined) {
      rendered.set(i, highlightLines(line.code, lang)[0] ?? line.code);
    }
    i++;
  }
  return rendered;
}

/**
 * Render a side-by-side split diff for wide terminals (`width >= 130`).
 * Automatically collapses back to unified clustered diff when narrower.
 */
export function renderSplitDiffLines(
  oldText: string,
  newText: string,
  path: string,
  width: number,
  opts: ClusteredDiffOptions = {},
): string[] {
  if (width < 130) {
    return renderDiffLinesClustered(oldText, newText, path, opts);
  }
  const s = makeDiffStyles();
  const diffLines = computeDiffLines(
    oldText,
    newText,
    opts.oldStart ?? 1,
    opts.newStart ?? 1,
    opts.isIncomplete ?? false,
  );
  const { clusters, addedCount, removedCount } = buildClusters(diffLines, opts.contextLines ?? 3);
  const output: string[] = [];
  let header = '';
  if (addedCount > 0) header += s.addBold(`+${String(addedCount)} `);
  if (removedCount > 0) header += s.delBold(`-${String(removedCount)} `);
  header += path;
  output.push(header);
  if (clusters.length === 0) return output;

  const sep = s.gutter(' │ ');
  const colWidth = Math.max(20, Math.floor((width - 3) / 2));
  const fitCol = (text: string): string => {
    const truncated = truncateToWidth(text, colWidth, '…');
    const pad = Math.max(0, colWidth - visibleWidth(truncated));
    return truncated + ' '.repeat(pad);
  };

  let prevEnd = -1;
  for (const cluster of clusters) {
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1;
      if (gap > 0) {
        output.push(s.meta(`     … ${String(gap)} unchanged line${gap > 1 ? 's' : ''} …`));
      }
    }
    const styledMap = buildRenderedClusterRows(diffLines, cluster.start, cluster.end, path, s);
    let i = cluster.start;
    while (i <= cluster.end) {
      const line = diffLines[i]!;
      if (line.kind === 'context') {
        const row = formatDiffRow(line, s, styledMap.get(i));
        output.push(fitCol(row) + sep + fitCol(row));
        i++;
        continue;
      }
      const dels: number[] = [];
      const adds: number[] = [];
      while (i <= cluster.end && diffLines[i]!.kind === 'delete') dels.push(i++);
      while (i <= cluster.end && diffLines[i]!.kind === 'add') adds.push(i++);
      const rows = Math.max(dels.length, adds.length);
      for (let r = 0; r < rows; r++) {
        const dIdx = dels[r];
        const aIdx = adds[r];
        const left = dIdx === undefined ? '' : formatDiffRow(diffLines[dIdx]!, s, styledMap.get(dIdx));
        const right = aIdx === undefined ? '' : formatDiffRow(diffLines[aIdx]!, s, styledMap.get(aIdx));
        output.push(fitCol(left) + sep + fitCol(right));
      }
    }
    prevEnd = cluster.end;
  }
  return output;
}

/**
 * Render a diff with surrounding context, eliding unchanged middle
 * regions between change clusters with a `… N unchanged lines …`
 * separator. When `maxLines` is set, the body is capped at a cluster
 * boundary and a `Ctrl+O to expand` footer is appended.
 *
 * Used by Edit's call preview where we want to show *what changed*
 * with enough context to read the change, but not the whole file.
 */
export function renderDiffLinesClustered(
  oldText: string,
  newText: string,
  path: string,
  opts: ClusteredDiffOptions = {},
): string[] {
  const s = makeDiffStyles();
  const contextLines = opts.contextLines ?? 3;
  const maxLines = opts.maxLines;
  const diffLines = computeDiffLines(
    oldText,
    newText,
    opts.oldStart ?? 1,
    opts.newStart ?? 1,
    opts.isIncomplete ?? false,
  );
  const { clusters, changedCount, addedCount, removedCount } = buildClusters(
    diffLines,
    contextLines,
  );

  const output: string[] = [];
  let header = '';
  if (addedCount > 0) header += s.addBold(`+${String(addedCount)} `);
  if (removedCount > 0) header += s.delBold(`-${String(removedCount)} `);
  header += path;
  output.push(header);

  if (clusters.length === 0) return output;

  const cap = maxLines !== undefined && maxLines >= 0 ? maxLines : Number.POSITIVE_INFINITY;
  let body = 0;
  let prevEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (body >= cap) {
      truncated = true;
      break;
    }
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1;
      if (gap > 0) {
        if (body + 1 > cap) {
          truncated = true;
          break;
        }
        output.push(s.meta(`     … ${String(gap)} unchanged line${gap > 1 ? 's' : ''} …`));
        body++;
      }
    }
    // Emit cluster rows one at a time; allow mid-cluster truncation so
    // a single huge cluster (e.g. the whole file replaced inline) still
    // shows the leading lines instead of degenerating to "N changes
    // hidden" with no body at all.
    const styledMap = buildRenderedClusterRows(diffLines, cluster.start, cluster.end, path, s);
    for (let i = cluster.start; i <= cluster.end; i++) {
      if (body >= cap) {
        truncated = true;
        break outer;
      }
      const line = diffLines[i]!;
      output.push(formatDiffRow(line, s, styledMap.get(i)));
      body++;
      if (line.kind !== 'context') shownChanges++;
      prevEnd = i;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = opts.expandKeyHint ?? 'Ctrl+O to expand';
      output.push(
        s.meta(
          `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (${hint})`,
        ),
      );
    }
  }

  return output;
}

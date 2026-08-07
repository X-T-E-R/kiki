/**
 * DiffCard — renders edit-tool hunks as a unified diff: single new-file
 * line-number gutter, muted `… N unchanged lines` separators between hunks,
 * insert/delete row tints confined to the content area (gutter stays clean).
 * Rendering recipe follows grok-build's edit.rs (Apache-2.0, see lib/diff.ts);
 * tints use kiki's success/danger palette at low alpha on paper.
 */

import type { DiffHunk, DiffLine } from '../lib/diff';
import { hunkGapLines } from '../lib/diff';

function DiffRow({ line, gutterWidth }: { line: DiffLine; gutterWidth: number }) {
  const gutter =
    line.tag === 'delete' ? String(line.lo) : line.ln > 0 ? String(line.ln) : '';
  const tint =
    line.tag === 'insert'
      ? 'bg-success/10'
      : line.tag === 'delete'
        ? 'bg-danger/10'
        : undefined;
  const marker =
    line.tag === 'insert' ? '+' : line.tag === 'delete' ? '−' : ' ';
  const markerTone =
    line.tag === 'insert'
      ? 'text-success'
      : line.tag === 'delete'
        ? 'text-danger'
        : 'text-ink-faint';
  return (
    <div className="flex">
      <span
        className="shrink-0 pr-2 text-right text-ink-faint select-none"
        style={{ width: `${gutterWidth + 2}ch` }}
      >
        {gutter}
      </span>
      <span className={`w-3 shrink-0 text-center select-none ${markerTone}`}>{marker}</span>
      <span className={`min-w-0 flex-1 px-1.5 whitespace-pre-wrap break-all ${tint ?? ''}`}>
        {line.text === '' ? ' ' : line.text}
      </span>
    </div>
  );
}

export function DiffCard({ hunks }: { hunks: readonly DiffHunk[] }) {
  // Gutter width from the largest line number shown (grok-build's layout).
  let maxLine = 1;
  for (const hunk of hunks) {
    for (const line of hunk) {
      maxLine = Math.max(maxLine, line.lo, line.ln);
    }
  }
  const gutterWidth = String(maxLine).length;

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-panel font-mono text-[12px] leading-[1.55]">
      {hunks.map((hunk, hunkIndex) => {
        const previous = hunkIndex > 0 ? hunks[hunkIndex - 1] : undefined;
        const gap = previous !== undefined ? hunkGapLines(previous, hunk) : undefined;
        return (
          <div key={hunkIndex}>
            {hunkIndex > 0 ? (
              <div className="border-y border-hairline bg-paper px-3 py-0.5 text-[10.5px] text-ink-faint select-none">
                … {gap !== undefined ? `${gap} unchanged line${gap === 1 ? '' : 's'}` : 'unchanged lines'}
              </div>
            ) : null}
            <div className="py-1">
              {hunk.map((line, lineIndex) => (
                <DiffRow key={lineIndex} line={line} gutterWidth={gutterWidth} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

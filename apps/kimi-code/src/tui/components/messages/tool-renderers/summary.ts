/**
 * Summary-style renderers — produce optional inline-glance content for
 * tools whose raw output is high-volume but low-information (Grep,
 * Glob). The numeric summary (line counts, exit codes, sizes) lives in
 * the header chip (see chip.ts), so most tools intentionally render an
 * empty body and only expose details when the global expand toggle is
 * on.
 *
 * Errors always fall through to the truncated renderer so the user
 * sees the actual error message, not a synthetic summary.
 */

import type { Component } from '@kiki/pi-tui';
import { Text, visibleWidth, wrapTextWithAnsi } from '@kiki/pi-tui';
import chalk from 'chalk';

import { ellipsizePathMiddle } from '../path-ellipsis';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;
const GLANCE_INDENT = '  ';

interface Glance {
  readonly samples: readonly string[];
  readonly remaining: number;
}

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => Glance | undefined;

/**
 * The comma-separated path samples under a Grep/Glob header. Each sample is
 * shortened in the middle to fit one row, so a path is never cut inside a
 * segment, and wrapped rows hang at the body column like the first one.
 */
class GlanceLine implements Component {
  private cache: { width: number; lines: string[] } | undefined;

  constructor(private readonly glance: Glance) { }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const contentWidth = Math.max(1, width - GLANCE_INDENT.length);
    const samples = this.glance.samples.map((sample) =>
      ellipsizePathMiddle(sample, Math.max(1, contentWidth - 1)),
    );
    const tail = this.glance.remaining > 0 ? `, +${String(this.glance.remaining)} more` : '';
    const lines = wrapTextWithAnsi(`${samples.join(', ')}${tail}`, contentWidth).map((line) => {
      const row = `${GLANCE_INDENT}${chalk.dim(line)}`;
      return row + ' '.repeat(Math.max(0, width - visibleWidth(row)));
    });
    this.cache = { width, lines };
    return lines;
  }
}

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);

    const out: Component[] = [];
    if (glance !== null) {
      const samples = glance(toolCall, result);
      if (samples !== undefined) out.push(new GlanceLine(samples));
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(chalk.dim(result.output), 4, 0));
    }
    return out;
  };
}

function nonEmptyLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

// Strip a trailing `:line:col:text` so the glance shows the file path
// only, even when grep is in `content` mode (`src/foo.ts:42:    foo()`).
function pathFromGrepLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx <= 0) return line;
  const second = line.indexOf(':', idx + 1);
  if (second <= 0) return line;
  return line.slice(0, second);
}

const grepGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return undefined;
  const samples = lines.slice(0, GLANCE_SAMPLES).map(pathFromGrepLine);
  return { samples, remaining: lines.length - samples.length };
};

const globGlance: GlanceFn = (_toolCall, result) => {
  const lines = nonEmptyLines(result.output);
  if (lines.length === 0) return undefined;
  const samples = lines.slice(0, GLANCE_SAMPLES);
  return { samples, remaining: lines.length - samples.length };
};

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const readSummary: ResultRenderer = withGlance(null);
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// Tools that benefit from inline path samples below the chip.
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);

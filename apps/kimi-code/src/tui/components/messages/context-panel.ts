/**
 * ContextPanelComponent — bordered `/context` inspection box displaying
 * current context window occupancy and an explicit estimated breakdown across
 * System, Tools, Messages, and Free space (when a positive limit is known).
 */

import type { Component } from '@kiki/pi-tui';
import { truncateToWidth, visibleWidth } from '@kiki/pi-tui';

import { currentTheme, type ColorToken } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { formatTokenCount, ratioSeverity, usagePercent } from '#/utils/usage/usage-format';

export interface ContextBreakdownEstimate {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  readonly estimated: true;
}

export interface ContextPanelData {
  readonly targetLabel: string;
  readonly contextTokens: number;
  readonly maxContextTokens?: number;
  readonly breakdown?: ContextBreakdownEstimate;
  readonly unavailableReason?: string;
}

interface BarBucket {
  readonly glyph: string;
  readonly token: ColorToken;
  readonly value: number;
}

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const BOX_OVERHEAD = LEFT_MARGIN + 2 + 2 * SIDE_PADDING;
const MIN_BAR_WIDTH = 4;
const MAX_BAR_WIDTH = 36;
const LABEL_WIDTH = 9;

function sanitizeInline(text: string): string {
  return sanitizeShellOutput(text)
    .replace(/[\r\n\t\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nonNegativeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function severityToken(ratio: number): ColorToken {
  const sev = ratioSeverity(ratio);
  return sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';
}

/**
 * Allocate `barWidth` ASCII cells proportionally across buckets using
 * largest-remainder rounding, guaranteeing at least 1 cell for every non-zero
 * bucket when `barWidth` can accommodate them all.
 */
function allocateBarCells(buckets: readonly BarBucket[], barWidth: number): number[] {
  const counts = buckets.map(() => 0);
  if (barWidth <= 0 || buckets.length === 0) return counts;

  const total = buckets.reduce((sum, b) => sum + b.value, 0);
  if (total <= 0) {
    counts[counts.length - 1] = barWidth;
    return counts;
  }

  const exact = buckets.map((b) => (b.value / total) * barWidth);
  const remainders: Array<{ index: number; frac: number }> = [];
  let assigned = 0;

  for (let i = 0; i < buckets.length; i++) {
    const floor = Math.floor(exact[i]!);
    counts[i] = floor;
    assigned += floor;
    remainders.push({ index: i, frac: exact[i]! - floor });
  }

  // Ensure every non-zero bucket gets at least 1 cell when barWidth allows.
  const nonZeroIndices = buckets
    .map((b, i) => (b.value > 0 ? i : -1))
    .filter((i) => i >= 0);
  if (nonZeroIndices.length <= barWidth) {
    for (const idx of nonZeroIndices) {
      if (counts[idx] === 0) {
        counts[idx] = 1;
        assigned += 1;
      }
    }
  }

  // Trim excess cells from the largest buckets (never dropping a non-zero bucket to 0).
  while (assigned > barWidth) {
    let best = -1;
    let maxCount = 1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i]! > maxCount) {
        maxCount = counts[i]!;
        best = i;
      }
    }
    if (best < 0) break;
    counts[best]! -= 1;
    assigned -= 1;
  }

  // Distribute remaining cells by largest fractional remainder.
  remainders.sort((a, b) => b.frac - a.frac || a.index - b.index);
  let r = 0;
  while (assigned < barWidth && r < remainders.length) {
    const idx = remainders[r]!.index;
    if (buckets[idx]!.value > 0) {
      counts[idx]! += 1;
      assigned += 1;
    }
    r += 1;
  }

  return counts;
}

function renderStackedAsciiBar(buckets: readonly BarBucket[], barWidth: number): string {
  const counts = allocateBarCells(buckets, barWidth);
  const segments: string[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const count = counts[i]!;
    if (count <= 0) continue;
    const bucket = buckets[i]!;
    segments.push(currentTheme.fg(bucket.token, bucket.glyph.repeat(count)));
  }
  return (
    currentTheme.fg('textMuted', '[') +
    segments.join('') +
    currentTheme.fg('textMuted', ']')
  );
}

export class ContextPanelComponent implements Component {
  constructor(private data: ContextPanelData) {}

  setData(data: ContextPanelData): void {
    this.data = data;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [];

    const availableInterior = safeWidth - BOX_OVERHEAD;
    const barWidth = Math.max(
      MIN_BAR_WIDTH,
      Math.min(MAX_BAR_WIDTH, availableInterior - 2),
    );
    const bodyLines = this.buildBodyLines(barWidth);

    if (availableInterior < 1) {
      return bodyLines.map((line) => truncateToWidth(line, safeWidth, '…'));
    }

    const paint = (text: string): string => currentTheme.fg('primary', text);
    const indent = ' '.repeat(LEFT_MARGIN);
    const longestLine = bodyLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(1, Math.min(availableInterior, longestLine));
    const horzLen = contentWidth + 2 * SIDE_PADDING;

    const top = indent + paint('╭' + '─'.repeat(horzLen) + '╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of bodyLines) {
      const clipped =
        visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, '…') : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);

    return out.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private buildBodyLines(barWidth: number): string[] {
    const target = sanitizeInline(this.data.targetLabel) || 'main';
    const used = nonNegativeTokens(this.data.contextTokens);
    const rawLimit = this.data.maxContextTokens;
    const hasLimit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0;
    const limit = hasLimit ? rawLimit : 0;
    const free = hasLimit ? Math.max(0, limit - used) : 0;

    const lines: string[] = [
      currentTheme.boldFg('primary', `Context window · ${target}`),
    ];

    if (hasLimit) {
      const pct = usagePercent(used, limit);
      const usedText = formatTokenCount(used);
      const limitText = formatTokenCount(limit);
      lines.push(
        `${currentTheme.fg('text', `${usedText} / ${limitText}`)} ` +
          currentTheme.fg('textDim', `(${String(pct)}%)`),
      );
    } else {
      lines.push(
        `${currentTheme.fg('textDim', 'Total')}  ${currentTheme.fg('text', formatTokenCount(used))}`,
      );
    }

    const breakdown = this.data.breakdown;
    if (breakdown !== undefined) {
      const systemTokens = nonNegativeTokens(breakdown.systemTokens);
      const toolsTokens = nonNegativeTokens(breakdown.toolsTokens);
      const messagesTokens = nonNegativeTokens(breakdown.messagesTokens);

      if (hasLimit) {
        const buckets: BarBucket[] = [
          { glyph: '#', token: 'accent', value: systemTokens },
          { glyph: '=', token: 'warning', value: toolsTokens },
          { glyph: '+', token: 'primary', value: messagesTokens },
          { glyph: '.', token: 'textMuted', value: free },
        ];
        lines.push(renderStackedAsciiBar(buckets, barWidth));
      }

      lines.push('');

      const rows: Array<{
        readonly glyph: string;
        readonly token: ColorToken;
        readonly label: string;
        readonly amount: string;
        readonly estimated: boolean;
      }> = [
        {
          glyph: '#',
          token: 'accent',
          label: 'System',
          amount: formatTokenCount(systemTokens),
          estimated: true,
        },
        {
          glyph: '=',
          token: 'warning',
          label: 'Tools',
          amount: formatTokenCount(toolsTokens),
          estimated: true,
        },
        {
          glyph: '+',
          token: 'primary',
          label: 'Messages',
          amount: formatTokenCount(messagesTokens),
          estimated: true,
        },
      ];

      if (hasLimit) {
        rows.push({
          glyph: '.',
          token: 'textMuted',
          label: 'Free',
          amount: formatTokenCount(free),
          estimated: false,
        });
      }

      const amountWidth = Math.max(...rows.map((r) => visibleWidth(r.amount)));
      for (const row of rows) {
        const marker = currentTheme.fg(row.token, row.glyph);
        const label = currentTheme.fg('textDim', row.label.padEnd(LABEL_WIDTH, ' '));
        const value = currentTheme.fg('text', row.amount.padStart(amountWidth, ' '));
        const suffix = row.estimated ? `  ${currentTheme.fg('textMuted', '(estimated)')}` : '';
        lines.push(`${marker} ${label} ${value}${suffix}`);
      }
    } else {
      if (hasLimit) {
        const usedRatio = used / limit;
        const buckets: BarBucket[] = [
          { glyph: '#', token: severityToken(usedRatio), value: used },
          { glyph: '.', token: 'textMuted', value: free },
        ];
        lines.push(renderStackedAsciiBar(buckets, barWidth));
      }

      lines.push('');
      lines.push(currentTheme.fg('textMuted', 'Breakdown unavailable'));
      const reason =
        this.data.unavailableReason !== undefined
          ? sanitizeInline(this.data.unavailableReason)
          : '';
      if (reason.length > 0) {
        lines.push(currentTheme.fg('textDim', reason));
      }
    }

    return lines;
  }
}

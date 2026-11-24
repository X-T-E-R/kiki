/**
 * QueueBannerComponent — compact status banner displayed above the composer
 * when user messages are steering the active turn or queued behind it.
 *
 * Pure view: accepts data via `setItems`, renders zero rows when empty, and
 * enforces a hard 4-row cap with sanitized single-line previews.
 */

import type { Component } from '@kiki/pi-tui';
import { truncateToWidth } from '@kiki/pi-tui';

import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

export interface QueueBannerItem {
  readonly id: string;
  readonly phase: 'steering' | 'queued';
  readonly preview: string;
}

const MAX_ROWS = 4;
const QUEUED_HINT = '↑ / Alt+↑ edit · Ctrl+Enter send now';
const INDENT = '  ';

function sanitizePreview(preview: string): string {
  const cleaned = sanitizeShellOutput(preview)
    .replace(/[\r\n\t\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : '(empty)';
}

export class QueueBannerComponent implements Component {
  private items: readonly QueueBannerItem[];

  constructor(items: readonly QueueBannerItem[] = []) {
    this.items = [...items];
  }

  setItems(items: readonly QueueBannerItem[]): void {
    this.items = [...items];
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.items.length === 0 || width <= 0) return [];

    const steering: QueueBannerItem[] = [];
    const queued: QueueBannerItem[] = [];
    for (const item of this.items) {
      if (item.phase === 'steering') steering.push(item);
      else queued.push(item);
    }

    const hasQueued = queued.length > 0;
    const totalCount = steering.length + queued.length;
    const needsFooter = hasQueued || totalCount > MAX_ROWS;
    const maxItemRows = needsFooter ? MAX_ROWS - 1 : MAX_ROWS;

    // Reserve at least one row for queued items when both phases are present so
    // the Steering vs Queued separation remains visible under overflow.
    const steeringCap =
      hasQueued && steering.length > 0 ? Math.max(1, maxItemRows - 1) : maxItemRows;
    const shownSteering = steering.slice(0, steeringCap);
    const shownQueued = queued.slice(0, Math.max(0, maxItemRows - shownSteering.length));
    const hiddenCount = totalCount - shownSteering.length - shownQueued.length;

    const labelWidth = shownSteering.length > 0 ? 'Steering'.length : 'Queued'.length;
    const blankLabel = ' '.repeat(labelWidth);

    const lines: string[] = [];

    for (let i = 0; i < shownSteering.length; i++) {
      const item = shownSteering[i]!;
      const label =
        i === 0 ? currentTheme.boldFg('primary', 'Steering'.padEnd(labelWidth, ' ')) : blankLabel;
      const arrow = currentTheme.fg('primary', '↳');
      const preview = currentTheme.fg('text', sanitizePreview(item.preview));
      lines.push(`${INDENT}${label}  ${arrow} ${preview}`);
    }

    for (let i = 0; i < shownQueued.length; i++) {
      const item = shownQueued[i]!;
      const label =
        i === 0 ? currentTheme.fg('textMuted', 'Queued'.padEnd(labelWidth, ' ')) : blankLabel;
      const arrow = currentTheme.fg('textMuted', '↳');
      const preview = currentTheme.fg('textDim', sanitizePreview(item.preview));
      lines.push(`${INDENT}${label}  ${arrow} ${preview}`);
    }

    if (needsFooter) {
      const footerParts: string[] = [];
      if (hiddenCount > 0) footerParts.push(`+${String(hiddenCount)} more`);
      if (hasQueued) footerParts.push(QUEUED_HINT);
      lines.push(currentTheme.fg('textMuted', `${INDENT}${footerParts.join(' · ')}`));
    }

    return lines.slice(0, MAX_ROWS).map((line) => truncateToWidth(line, width, '…'));
  }
}

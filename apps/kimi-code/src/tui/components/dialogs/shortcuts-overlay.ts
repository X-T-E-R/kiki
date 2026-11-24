/**
 * ShortcutsOverlay — compact modal reference sheet for keyboard shortcuts.
 *
 * Adapts cleanly between a 2-column layout (width >= 76) and a 1-column stack
 * on narrower terminals, framed with primary horizontal borders.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type MouseRoutable,
  type SgrMouseEvent,
} from '@kiki/pi-tui';
import { layoutHintLines } from '#/tui/components/dialogs/hint-lines';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';
const TWO_COLUMN_MIN_WIDTH = 76;
const COLUMN_GAP = 3;
const DEFAULT_MAX_VISIBLE = 24;

export interface ShortcutItem {
  readonly key: string;
  readonly description: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly ShortcutItem[];
}

export interface ShortcutsOverlayOptions {
  readonly groups: readonly ShortcutGroup[];
  readonly onInsertLiteralQuestion: () => void;
  readonly onOpenPalette?: () => void;
  readonly onOpenHelp?: () => void;
  readonly onCancel: () => void;
}

function renderShortcutGroup(group: ShortcutGroup, colWidth: number): string[] {
  const safeColWidth = Math.max(1, colWidth);
  const lines: string[] = [
    truncateToWidth(currentTheme.boldFg('textStrong', ` ${group.title}`), safeColWidth, ELLIPSIS),
  ];
  if (group.items.length === 0) return lines;

  const maxKeyWidth = Math.max(...group.items.map((item) => visibleWidth(item.key)));
  const keyCol = Math.min(Math.max(4, maxKeyWidth), Math.max(4, Math.floor(safeColWidth * 0.42)));

  for (const item of group.items) {
    const keyPlain = truncateToWidth(item.key, keyCol, ELLIPSIS);
    const pad = ' '.repeat(Math.max(1, keyCol - visibleWidth(keyPlain) + 2));
    const line =
      '  ' +
      currentTheme.fg('primary', keyPlain) +
      pad +
      currentTheme.fg('textMuted', item.description);
    lines.push(truncateToWidth(line, safeColWidth, ELLIPSIS));
  }
  return lines;
}

function buildTwoColumnLines(groups: readonly ShortcutGroup[], width: number): string[] {
  const leftWidth = Math.floor((width - COLUMN_GAP) / 2);
  const rightWidth = width - COLUMN_GAP - leftWidth;

  const leftBlocks: string[][] = [];
  const rightBlocks: string[][] = [];
  let leftHeight = 0;
  let rightHeight = 0;

  if (groups.length === 1 && groups[0]!.items.length >= 2) {
    const single = groups[0]!;
    const midpoint = Math.ceil(single.items.length / 2);
    const leftGroup: ShortcutGroup = { title: single.title, items: single.items.slice(0, midpoint) };
    const rightGroup: ShortcutGroup = { title: '', items: single.items.slice(midpoint) };
    const leftLines = renderShortcutGroup(leftGroup, leftWidth);
    const rightRaw = renderShortcutGroup(rightGroup, rightWidth);
    const rightLines = ['', ...rightRaw.slice(1)];
    return zipColumns(leftLines, rightLines, leftWidth, rightWidth, width);
  }

  for (const group of groups) {
    const useLeft = leftHeight <= rightHeight;
    const colWidth = useLeft ? leftWidth : rightWidth;
    const block = renderShortcutGroup(group, colWidth);
    if (useLeft) {
      if (leftBlocks.length > 0) leftHeight += 1;
      leftBlocks.push(block);
      leftHeight += block.length;
    } else {
      if (rightBlocks.length > 0) rightHeight += 1;
      rightBlocks.push(block);
      rightHeight += block.length;
    }
  }

  const leftLines = joinBlocks(leftBlocks);
  const rightLines = joinBlocks(rightBlocks);
  return zipColumns(leftLines, rightLines, leftWidth, rightWidth, width);
}

function joinBlocks(blocks: readonly string[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) out.push('');
    out.push(...blocks[i]!);
  }
  return out;
}

function zipColumns(
  leftLines: readonly string[],
  rightLines: readonly string[],
  leftWidth: number,
  rightWidth: number,
  totalWidth: number,
): string[] {
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const gap = ' '.repeat(COLUMN_GAP);
  const out: string[] = [];

  for (let i = 0; i < rowCount; i++) {
    const leftCell = truncateToWidth(leftLines[i] ?? '', leftWidth, ELLIPSIS);
    const rightCell = truncateToWidth(rightLines[i] ?? '', rightWidth, ELLIPSIS);
    if (rightCell.length === 0) {
      out.push(truncateToWidth(leftCell, totalWidth, ELLIPSIS));
    } else {
      const pad = ' '.repeat(Math.max(0, leftWidth - visibleWidth(leftCell)));
      out.push(truncateToWidth(`${leftCell}${pad}${gap}${rightCell}`, totalWidth, ELLIPSIS));
    }
  }
  return out;
}

export class ShortcutsOverlayComponent extends Container implements Focusable, MouseRoutable {
  focused = false;

  private readonly opts: ShortcutsOverlayOptions;
  private scrollTop = 0;

  constructor(opts: ShortcutsOverlayOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const ch = printableChar(data);
    if (ch === '?') {
      this.opts.onInsertLiteralQuestion();
      return;
    }
    if (matchesKey(data, Key.ctrl('p'))) {
      this.opts.onOpenPalette?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.opts.onOpenHelp?.();
      return;
    }
    if (matchesKey(data, Key.escape) || ch.toLowerCase() === 'q') {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 8);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 8;
    }
  }

  routeMouse(event: SgrMouseEvent, _line: number, _col: number): boolean {
    if (event.wheel !== null) {
      this.scrollTop = Math.max(0, this.scrollTop + event.wheel * 2);
      return true;
    }
    return false;
  }

  onOutsideMouseDown(_event: SgrMouseEvent): boolean {
    this.opts.onCancel();
    return true;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const hintParts: string[] = ['? insert ?'];
    if (this.opts.onOpenPalette !== undefined) hintParts.push('Ctrl+P palette');
    if (this.opts.onOpenHelp !== undefined) hintParts.push('Tab help');
    hintParts.push('Q cancel', 'Esc cancel');

    const hintWidth = Math.max(1, safeWidth - 1);
    const hintLines = layoutHintLines(hintParts, hintWidth);

    const bodyLines = this.buildBodyLines(safeWidth);
    const maxScroll = Math.max(0, bodyLines.length - DEFAULT_MAX_VISIBLE);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
    const visibleBody =
      bodyLines.length > DEFAULT_MAX_VISIBLE
        ? bodyLines.slice(this.scrollTop, this.scrollTop + DEFAULT_MAX_VISIBLE)
        : bodyLines;

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      truncateToWidth(currentTheme.boldFg('primary', ' Keyboard shortcuts'), safeWidth, ELLIPSIS),
    ];
    for (const hintLine of hintLines) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', ` ${hintLine}`), safeWidth, ELLIPSIS));
    }
    lines.push('');
    lines.push(...visibleBody);
    lines.push('');

    if (bodyLines.length > DEFAULT_MAX_VISIBLE) {
      const remaining = bodyLines.length - (this.scrollTop + visibleBody.length);
      const status =
        remaining > 0
          ? ` ▼ ${String(remaining)} more`
          : ` ${String(this.scrollTop + 1)}-${String(this.scrollTop + visibleBody.length)} / ${String(bodyLines.length)}`;
      lines.push(truncateToWidth(currentTheme.fg('textMuted', status), safeWidth, ELLIPSIS));
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    return lines;
  }

  private buildBodyLines(width: number): string[] {
    if (this.opts.groups.length === 0) {
      return [truncateToWidth(currentTheme.fg('textMuted', '  No shortcuts available'), width, ELLIPSIS)];
    }

    if (width >= TWO_COLUMN_MIN_WIDTH) {
      return buildTwoColumnLines(this.opts.groups, width);
    }

    const blocks = this.opts.groups.map((group) => renderShortcutGroup(group, width));
    return joinBlocks(blocks);
  }
}

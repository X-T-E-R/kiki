/**
 * CommandPalette — searchable modal palette grouping suggested actions,
 * slash commands, settings, skills, and agents.
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
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';
const DEFAULT_PAGE_SIZE = 10;

export type CommandPaletteCategory = 'Suggested' | 'Commands' | 'Settings' | 'Skills' | 'Agents';

export interface CommandPaletteEntry {
  readonly id: string;
  readonly category: CommandPaletteCategory;
  readonly label: string;
  readonly description?: string;
  readonly shortcut?: string;
  readonly disabledReason?: string;
  readonly searchText?: string;
}

export interface CommandPaletteOptions {
  readonly entries: readonly CommandPaletteEntry[];
  readonly onSelect: (entry: CommandPaletteEntry) => void;
  readonly onCancel: () => void;
}

function entrySearchText(entry: CommandPaletteEntry): string {
  return [
    entry.label,
    entry.category,
    entry.description ?? '',
    entry.shortcut ?? '',
    entry.searchText ?? '',
  ].join(' ');
}

function isDisabledEntry(entry: CommandPaletteEntry): boolean {
  return entry.disabledReason !== undefined && entry.disabledReason.length > 0;
}

export class CommandPaletteComponent extends Container implements Focusable, MouseRoutable {
  focused = false;

  private readonly opts: CommandPaletteOptions;
  private readonly list: SearchableList<CommandPaletteEntry>;
  private renderedItemByRow: Array<number | undefined> = [];

  constructor(opts: CommandPaletteOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.entries,
      toSearchText: entrySearchText,
      pageSize: DEFAULT_PAGE_SIZE,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.list.pageUp();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.list.pageDown();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen);
      return;
    }
    this.list.handleKey(data);
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (event.wheel !== null) {
      if (event.wheel < 0) this.list.moveUp();
      else this.list.moveDown();
      return true;
    }
    if (event.leftClick && !event.motion && !event.release) {
      const targetIndex = this.renderedItemByRow[line];
      if (targetIndex === undefined) return false;
      this.list.setSelectedIndex(targetIndex);
      const chosen = this.list.selected();
      if (chosen !== undefined) this.opts.onSelect(chosen);
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
    const view = this.list.view();
    const entries = view.items;
    const hasQuery = view.query.length > 0;

    const navParts: string[] = ['↑↓ navigate'];
    if (view.page.pageCount > 1) navParts.push('←→ page');
    navParts.push('Enter select', hasQuery ? 'Esc clear' : 'Esc cancel');

    const titleSuffix = hasQuery ? '' : currentTheme.fg('textMuted', '  (type to search)');
    const hintWidth = Math.max(1, safeWidth - 1);
    const hintLines = layoutHintLines(navParts, hintWidth);

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      truncateToWidth(currentTheme.boldFg('primary', ' Command palette') + titleSuffix, safeWidth, ELLIPSIS),
    ];
    for (const hintLine of hintLines) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', ` ${hintLine}`), safeWidth, ELLIPSIS));
    }
    lines.push('');

    if (hasQuery) {
      lines.push(
        truncateToWidth(
          currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query),
          safeWidth,
          ELLIPSIS,
        ),
      );
    }

    const rowMap: Array<number | undefined> = Array.from({ length: lines.length }, () => undefined);

    if (entries.length === 0) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', '   No matches'), safeWidth, ELLIPSIS));
      rowMap.push(undefined);
    } else {
      let lastCategory: CommandPaletteCategory | undefined;
      for (let i = view.page.start; i < view.page.end; i++) {
        const entry = entries[i]!;
        if (!hasQuery && entry.category !== lastCategory) {
          lines.push(
            truncateToWidth(currentTheme.boldFg('textDim', ` ${entry.category}`), safeWidth, ELLIPSIS),
          );
          rowMap.push(undefined);
          lastCategory = entry.category;
        }

        const isSelected = i === view.selectedIndex;
        const disabled = isDisabledEntry(entry);
        lines.push(this.renderRow(entry, isSelected, disabled, hasQuery, safeWidth));
        rowMap.push(i);

        if (isSelected && disabled && entry.disabledReason !== undefined) {
          lines.push(
            truncateToWidth(
              `    ${currentTheme.fg('warning', entry.disabledReason)}`,
              safeWidth,
              ELLIPSIS,
            ),
          );
          rowMap.push(i);
        }
      }
    }

    lines.push('');
    rowMap.push(undefined);

    if (hasQuery) {
      const current = entries.length === 0 ? 0 : view.selectedIndex + 1;
      lines.push(
        truncateToWidth(
          currentTheme.fg('textMuted', ` ${String(current)} / ${String(entries.length)}`),
          safeWidth,
          ELLIPSIS,
        ),
      );
      rowMap.push(undefined);
    } else if (entries.length > view.page.end) {
      lines.push(
        truncateToWidth(
          currentTheme.fg('textMuted', ` ▼ ${String(entries.length - view.page.end)} more`),
          safeWidth,
          ELLIPSIS,
        ),
      );
      rowMap.push(undefined);
    } else if (view.page.pageCount > 1) {
      lines.push(
        truncateToWidth(
          currentTheme.fg(
            'textMuted',
            ` Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`,
          ),
          safeWidth,
          ELLIPSIS,
        ),
      );
      rowMap.push(undefined);
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    rowMap.push(undefined);

    this.renderedItemByRow = rowMap;
    return lines;
  }

  private renderRow(
    entry: CommandPaletteEntry,
    isSelected: boolean,
    disabled: boolean,
    showCategoryTag: boolean,
    width: number,
  ): string {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const pointerToken = isSelected && !disabled ? 'primary' : 'textDim';
    const prefix = currentTheme.fg(pointerToken, `  ${pointer} `);

    const label = disabled
      ? isSelected
        ? currentTheme.boldFg('textDim', entry.label)
        : currentTheme.fg('textDim', entry.label)
      : isSelected
        ? currentTheme.boldFg('primary', entry.label)
        : currentTheme.fg('text', entry.label);

    const categoryTag = showCategoryTag ? ' ' + currentTheme.fg('textMuted', `[${entry.category}]`) : '';
    const desc =
      entry.description !== undefined && entry.description.length > 0
        ? '  ' + currentTheme.fg(disabled ? 'textDim' : 'textMuted', entry.description)
        : '';

    const leftRaw = `${prefix}${label}${categoryTag}${desc}`;

    if (entry.shortcut === undefined || entry.shortcut.length === 0) {
      return truncateToWidth(leftRaw, width, ELLIPSIS);
    }

    const badgeText = entry.shortcut;
    const badgeWidth = visibleWidth(badgeText);
    const badgeStyled = currentTheme.fg('textMuted', badgeText);

    // Reserve at least 1 gap column and 1 trailing margin column when wide enough.
    const minLeftBudget = 8;
    const rightReserve = badgeWidth + 2;
    if (width < minLeftBudget + rightReserve) {
      return truncateToWidth(`${leftRaw}  ${badgeStyled}`, width, ELLIPSIS);
    }

    const leftBudget = width - rightReserve;
    const leftClamped = truncateToWidth(leftRaw, leftBudget, ELLIPSIS);
    const padCount = Math.max(1, width - visibleWidth(leftClamped) - badgeWidth - 1);
    return truncateToWidth(`${leftClamped}${' '.repeat(padCount)}${badgeStyled}`, width, ELLIPSIS);
  }
}

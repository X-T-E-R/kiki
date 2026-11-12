/**
 * SettingsDialogComponent — interactive searchable settings surface for `/settings`.
 *
 * Aligns strictly with `.agents/skills/write-tui/DESIGN.md`:
 * - Single top and bottom `─` rules in `primary`
 * - `Settings  (type to search)` title + `textMuted` hint row
 * - `SearchableList` with two-stage `Esc` (`Esc clear` -> `Esc cancel`)
 * - `SELECT_POINTER` (`❯ `) + semantic palette tokens (`success`, `textDim`, `primary`)
 * - Full SGR mouse wheel + click + outside-click dismissal
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

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { pageView } from '#/tui/utils/paging';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface SettingsDialogItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Current value text displayed next to the label (e.g. `enabled`, `Send now`, `auto`). */
  readonly getValue: () => string;
  /** Semantic tone for the value badge (`enabled` -> `success`, `disabled` -> `textDim`, custom -> `primary`/`textMuted`). */
  readonly getValueTone?: () => 'success' | 'textDim' | 'primary' | 'textMuted';
  /** In-place cycle/toggle when `Space` or `Enter` is pressed on a value setting, or an action opener (e.g. `/model`). */
  readonly onActivate: (trigger: 'enter' | 'space' | 'click') => void;
}

const ELLIPSIS = '…';
const DEFAULT_PAGE_SIZE = 10;

export class SettingsDialogComponent extends Container implements Focusable, MouseRoutable {
  focused = false;

  private readonly list: SearchableList<SettingsDialogItem>;
  private readonly pageSize: number;
  private readonly onCancel: () => void;
  private readonly onCtrlC?: () => void;
  private readonly onCtrlD?: () => void;
  private renderedItemByRow: Array<number | undefined> = [];

  constructor(opts: {
    items: readonly SettingsDialogItem[];
    pageSize?: number;
    onCancel: () => void;
    onCtrlC?: () => void;
    onCtrlD?: () => void;
  }) {
    super();
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.onCancel = opts.onCancel;
    this.onCtrlC = opts.onCtrlC;
    this.onCtrlD = opts.onCtrlD;
    this.list = new SearchableList({
      items: opts.items,
      toSearchText: (item) =>
        `${item.label} ${item.getValue()} ${item.description ?? ''}`.trim(),
      pageSize: this.pageSize,
      searchable: true,
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.onCtrlC !== undefined) this.onCtrlC();
      else this.onCancel();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.onCtrlD !== undefined) this.onCtrlD();
      else this.onCancel();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) return;
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        selected.onActivate('enter');
      }
      return;
    }
    // Space toggles/cycles the focused row when no search query is being typed,
    // matching DESIGN.md section 7 (`Space toggle`).
    if (matchesKey(data, Key.space) && this.list.view().query.length === 0) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        selected.onActivate('space');
      }
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
    if (event.leftClick) {
      const targetIndex = this.renderedItemByRow[line];
      if (targetIndex === undefined) return false;
      this.list.setSelectedIndex(targetIndex);
      const selected = this.list.selected();
      if (selected !== undefined) {
        selected.onActivate('click');
      }
      return true;
    }
    return false;
  }

  onOutsideMouseDown(_event: SgrMouseEvent): boolean {
    this.onCancel();
    return true;
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.renderedItemByRow = [];
    const view = this.list.view();
    const rule = currentTheme.fg('primary', '─'.repeat(safeWidth));

    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = [
      '↑↓ navigate',
      ...(view.query.length === 0 ? ['Space toggle'] : []),
      'Enter select',
      view.query.length > 0 ? 'Esc clear' : 'Esc cancel',
    ];

    const lines: string[] = [
      rule,
      ` ${currentTheme.boldFg('primary', 'Settings')}${titleSuffix}`,
      ` ${currentTheme.fg('textMuted', hintParts.join(' · '))}`,
      '',
    ];

    if (view.query.length > 0) {
      lines.push(` ${currentTheme.fg('primary', 'Search: ')}${currentTheme.fg('text', view.query)}`);
    }

    if (view.items.length === 0) {
      lines.push(` ${currentTheme.fg('textMuted', 'No matches')}`);
      lines.push(rule);
      return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
    }

    const page = pageView(view.items.length, view.selectedIndex, this.pageSize);
    const visibleItems = view.items.slice(page.start, page.end);
    const above = page.start;
    const below = Math.max(0, view.items.length - page.end);
    const labelColumnWidth = Math.min(
      30,
      Math.max(
        18,
        ...visibleItems.map((item) => visibleWidth(item.label)),
      ),
    );

    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      if (item === undefined) continue;
      const index = page.start + i;
      const isSelected = index === view.selectedIndex;
      const pointer = isSelected
        ? `${currentTheme.fg('primary', SELECT_POINTER)} `
        : '  ';
      const paddedLabel =
        item.label + ' '.repeat(Math.max(2, labelColumnWidth - visibleWidth(item.label) + 2));
      const styledLabel = isSelected
        ? currentTheme.boldFg('primary', paddedLabel)
        : currentTheme.fg('text', paddedLabel);

      const rawValue = item.getValue();
      const tone =
        item.getValueTone?.() ??
        (rawValue === 'enabled'
          ? 'success'
          : rawValue === 'disabled'
            ? 'textDim'
            : 'primary');
      const styledValue = currentTheme.fg(tone, rawValue);

      const usedCols = 2 + visibleWidth(paddedLabel) + visibleWidth(rawValue);
      let descSuffix = '';
      if (item.description !== undefined && item.description.length > 0) {
        const remaining = safeWidth - usedCols - 4;
        if (remaining >= 12) {
          descSuffix = `   ${currentTheme.fg('textMuted', truncateToWidth(item.description, remaining, ELLIPSIS))}`;
        }
      }

      const row = lines.length;
      lines.push(` ${pointer}${styledLabel}${styledValue}${descSuffix}`);
      this.renderedItemByRow[row] = index;
    }

    if (view.query.length > 0) {
      lines.push('');
      lines.push(
        ` ${currentTheme.fg('textMuted', `${String(view.selectedIndex + 1)} / ${String(view.items.length)}`)}`,
      );
    } else if (below > 0 || above > 0) {
      lines.push('');
      const parts: string[] = [];
      if (above > 0) parts.push(`▲ ${String(above)} above`);
      if (below > 0) parts.push(`▼ ${String(below)} more`);
      lines.push(` ${currentTheme.fg('textMuted', parts.join(' · '))}`);
    }

    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
  }
}

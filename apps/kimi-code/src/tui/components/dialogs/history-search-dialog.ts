/**
 * HistorySearchDialog — Ctrl+R reverse history search modal embedding
 * `@kiki/pi-tui`'s `Input` component for IME-safe multi-character queries.
 */

import {
  Container,
  Input,
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
import { pageView } from '#/tui/utils/paging';

const ELLIPSIS = '…';
const MAX_VISIBLE_MATCHES = 6;
const MAX_PREVIEW_LINES = 3;

export interface HistorySearchEntry {
  readonly text: string;
  readonly source: 'history' | 'cleared-draft';
  readonly mode?: 'prompt' | 'bash';
}

export interface HistorySearchDialogOptions {
  readonly entries: readonly HistorySearchEntry[];
  readonly onAccept: (entry: HistorySearchEntry) => void;
  readonly onCancel: () => void;
}

function matchesHistoryQuery(text: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const hay = text.toLowerCase();
  if (hay.includes(trimmed)) return true;
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => hay.includes(token));
}

function formatEntryTags(entry: HistorySearchEntry): string {
  const tags: string[] = [];
  if (entry.source === 'cleared-draft') {
    tags.push(currentTheme.fg('warning', '[cleared]'));
  }
  if (entry.mode === 'bash') {
    tags.push(currentTheme.fg('shellMode', '[!]'));
  }
  return tags.length > 0 ? `${tags.join(' ')} ` : '';
}

function renderInputBox(input: Input, focused: boolean, width: number): string[] {
  input.focused = focused;
  if (width < 10) {
    const raw = input.render(Math.max(1, width))[0] ?? '> ';
    return [truncateToWidth(raw, width, ELLIPSIS)];
  }
  const boxWidth = width - 2;
  const innerWidth = Math.max(1, boxWidth - 4);
  const inputLine = truncateToWidth(input.render(innerWidth)[0] ?? '> ', innerWidth, ELLIPSIS);
  const rightPad = Math.max(0, innerWidth - visibleWidth(inputLine));
  const border = (text: string): string => currentTheme.fg('primary', text);
  return [
    ' ' + border('╭' + '─'.repeat(boxWidth - 2) + '╮'),
    ' ' + border('│') + '  ' + inputLine + ' '.repeat(rightPad) + border('│'),
    ' ' + border('╰' + '─'.repeat(boxWidth - 2) + '╯'),
  ];
}

export class HistorySearchDialogComponent extends Container implements Focusable, MouseRoutable {
  focused = false;

  private readonly opts: HistorySearchDialogOptions;
  private readonly input = new Input();
  private selectedIndex = 0;
  private renderedItemByRow: Array<number | undefined> = [];

  constructor(opts: HistorySearchDialogOptions) {
    super();
    this.opts = opts;
    this.input.onSubmit = () => {
      this.acceptSelected();
    };
    this.input.onEscape = () => {
      this.opts.onCancel();
    };
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.acceptSelected();
      return;
    }
    if (matchesKey(data, Key.ctrl('r')) || matchesKey(data, Key.up)) {
      this.moveOlder();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveNewer();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      const matches = this.filteredEntries();
      this.selectedIndex = Math.min(
        Math.max(0, matches.length - 1),
        this.selectedIndex + MAX_VISIBLE_MATCHES,
      );
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE_MATCHES);
      return;
    }

    const prevQuery = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== prevQuery) {
      this.selectedIndex = 0;
    }
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (event.wheel !== null) {
      if (event.wheel < 0) this.moveNewer();
      else this.moveOlder();
      return true;
    }
    if (event.leftClick && !event.motion && !event.release) {
      const targetIndex = this.renderedItemByRow[line];
      if (targetIndex === undefined) return false;
      const matches = this.filteredEntries();
      if (targetIndex < 0 || targetIndex >= matches.length) return false;
      this.selectedIndex = targetIndex;
      this.opts.onAccept(matches[targetIndex]!);
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
    const matches = this.filteredEntries();
    const clampedIndex =
      matches.length === 0 ? 0 : Math.min(Math.max(0, this.selectedIndex), matches.length - 1);
    this.selectedIndex = clampedIndex;
    const page = pageView(matches.length, clampedIndex, MAX_VISIBLE_MATCHES);

    const hintParts = ['Ctrl+R / ↑ older', '↓ newer', 'Enter accept', 'Esc cancel'];
    const hintLines = layoutHintLines(hintParts, Math.max(1, safeWidth - 1));

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      truncateToWidth(currentTheme.boldFg('primary', ' Reverse history search'), safeWidth, ELLIPSIS),
    ];
    for (const hintLine of hintLines) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', ` ${hintLine}`), safeWidth, ELLIPSIS));
    }
    lines.push('');
    lines.push(...renderInputBox(this.input, this.focused, safeWidth));
    lines.push('');

    const rowMap: Array<number | undefined> = Array.from({ length: lines.length }, () => undefined);

    if (matches.length === 0) {
      lines.push(
        truncateToWidth(
          currentTheme.fg('textMuted', '   No matches'),
          safeWidth,
          ELLIPSIS,
        ),
      );
      rowMap.push(undefined);
    } else {
      for (let i = page.start; i < page.end; i++) {
        const entry = matches[i]!;
        const isSelected = i === clampedIndex;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const prefix = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        const tags = formatEntryTags(entry);
        const snippet = entry.text.replaceAll(/\r?\n/g, ' ↵ ').trim();
        const styledText = isSelected
          ? currentTheme.boldFg('primary', snippet)
          : currentTheme.fg('text', snippet);
        lines.push(truncateToWidth(`${prefix}${tags}${styledText}`, safeWidth, ELLIPSIS));
        rowMap.push(i);
      }

      const selected = matches[clampedIndex]!;
      lines.push('');
      rowMap.push(undefined);
      lines.push(
        truncateToWidth(
          `${currentTheme.boldFg('textDim', ' Preview')}${selected.source === 'cleared-draft' || selected.mode === 'bash' ? `  ${formatEntryTags(selected).trimEnd()}` : ''}`,
          safeWidth,
          ELLIPSIS,
        ),
      );
      rowMap.push(undefined);

      const previewLines = selected.text.split(/\r?\n/);
      const shown = previewLines.slice(0, MAX_PREVIEW_LINES);
      for (const previewLine of shown) {
        lines.push(truncateToWidth(`   ${currentTheme.fg('text', previewLine)}`, safeWidth, ELLIPSIS));
        rowMap.push(undefined);
      }
      if (previewLines.length > MAX_PREVIEW_LINES) {
        const extra = previewLines.length - MAX_PREVIEW_LINES;
        lines.push(
          truncateToWidth(
            currentTheme.fg('textMuted', `   … +${String(extra)} more line${extra === 1 ? '' : 's'}`),
            safeWidth,
            ELLIPSIS,
          ),
        );
        rowMap.push(undefined);
      }
    }

    lines.push('');
    rowMap.push(undefined);

    const remaining = matches.length - page.end;
    const matchCount =
      matches.length === 0
        ? ' 0 / 0'
        : remaining > 0
          ? ` ${String(clampedIndex + 1)} / ${String(matches.length)} · ▼ ${String(remaining)} more`
          : ` ${String(clampedIndex + 1)} / ${String(matches.length)}`;
    lines.push(truncateToWidth(currentTheme.fg('textMuted', matchCount), safeWidth, ELLIPSIS));
    rowMap.push(undefined);

    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    rowMap.push(undefined);

    this.renderedItemByRow = rowMap;
    return lines;
  }

  private filteredEntries(): readonly HistorySearchEntry[] {
    const query = this.input.getValue();
    if (query.trim().length === 0) return this.opts.entries;
    return this.opts.entries.filter((entry) => matchesHistoryQuery(entry.text, query));
  }

  private moveOlder(): void {
    const matches = this.filteredEntries();
    if (matches.length === 0) return;
    this.selectedIndex = Math.min(matches.length - 1, this.selectedIndex + 1);
  }

  private moveNewer(): void {
    this.selectedIndex = Math.max(0, this.selectedIndex - 1);
  }

  private acceptSelected(): void {
    const matches = this.filteredEntries();
    if (matches.length === 0) return;
    const index = Math.min(Math.max(0, this.selectedIndex), matches.length - 1);
    this.opts.onAccept(matches[index]!);
  }
}

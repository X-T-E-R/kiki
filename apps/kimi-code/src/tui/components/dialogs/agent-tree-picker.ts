import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
  type MouseRoutable,
  type SgrMouseEvent,
} from '@kiki/pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface AgentTreeEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly depth: number;
  readonly label: string;
  readonly kind: 'main' | 'branch' | 'child';
  readonly status?: string;
  readonly model?: string;
  readonly isBranch: boolean;
  readonly branchSealed?: boolean;
  readonly toolsLocked?: boolean;
  readonly isRunning: boolean;
}

export interface AgentTreePickerOptions {
  readonly entries: readonly AgentTreeEntry[];
  readonly currentAgentId: string;
  readonly onSelect: (agentId: string) => void;
  readonly onMergeBranch?: (branchId: string) => void;
  readonly onStopAgent?: (agentId: string) => void;
  readonly onCancel: () => void;
}

export class AgentTreePickerComponent extends Container implements Focusable, MouseRoutable {
  focused = false;
  private readonly opts: AgentTreePickerOptions;
  private readonly list: SearchableList<AgentTreeEntry>;
  private pendingConfirm:
    | { readonly kind: 'merge' | 'stop'; readonly entry: AgentTreeEntry }
    | undefined;
  private renderedRowToIndex: Array<number | undefined> = [];

  constructor(opts: AgentTreePickerOptions) {
    super();
    this.opts = opts;
    const currentIdx = opts.entries.findIndex((entry) => entry.id === opts.currentAgentId);
    this.list = new SearchableList({
      items: opts.entries,
      toSearchText: (entry) => `${entry.label} ${entry.id} ${entry.status ?? ''} ${entry.model ?? ''}`,
      initialIndex: Math.max(0, currentIdx),
      searchable: false,
      pageSize: 10,
    });
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingConfirm !== undefined) {
      if (k === 'y' || k === 'Y' || matchesKey(data, Key.enter)) {
        const pending = this.pendingConfirm;
        this.pendingConfirm = undefined;
        if (pending.kind === 'merge') this.opts.onMergeBranch?.(pending.entry.id);
        else this.opts.onStopAgent?.(pending.entry.id);
        return;
      }
      if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
        this.pendingConfirm = undefined;
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (this.list.handleKey(data)) return;

    const selected = this.list.selected();
    if (selected === undefined) return;

    if ((k === 'm' || k === 'M') && selected.isBranch && !selected.branchSealed && this.opts.onMergeBranch !== undefined) {
      this.pendingConfirm = { kind: 'merge', entry: selected };
      return;
    }
    if ((k === 'x' || k === 'X') && selected.id !== 'main' && selected.isRunning && this.opts.onStopAgent !== undefined) {
      this.pendingConfirm = { kind: 'stop', entry: selected };
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSelect(selected.id);
    }
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (this.pendingConfirm !== undefined) return false;
    if (event.wheel !== null) {
      if (event.wheel < 0) this.list.moveUp();
      else this.list.moveDown();
      return true;
    }
    if (event.leftClick) {
      const idx = this.renderedRowToIndex[line];
      if (idx === undefined) return false;
      this.list.setSelectedIndex(idx);
      const selected = this.list.selected();
      if (selected !== undefined) this.opts.onSelect(selected.id);
      return true;
    }
    return false;
  }

  onOutsideMouseDown(_event: SgrMouseEvent): boolean {
    this.opts.onCancel();
    return true;
  }

  override render(width: number): string[] {
    const view = this.list.view();
    const selected = this.list.selected();
    const hints = ['↑↓ navigate', 'Enter inspect'];
    if (selected?.isBranch && !selected.branchSealed && this.opts.onMergeBranch !== undefined) {
      hints.push('m merge branch');
    }
    if (selected !== undefined && selected.id !== 'main' && selected.isRunning && this.opts.onStopAgent !== undefined) {
      hints.push('x stop');
    }
    hints.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Agent & branch tree'),
      currentTheme.fg('textMuted', ` ${hints.join(' · ')}`),
      '',
    ];
    this.renderedRowToIndex = Array.from({ length: lines.length }, () => undefined);

    if (this.pendingConfirm !== undefined) {
      const verb =
        this.pendingConfirm.kind === 'merge'
          ? `Merge branch "${this.pendingConfirm.entry.label}" (${this.pendingConfirm.entry.id}) into parent?`
          : `Stop running agent "${this.pendingConfirm.entry.label}" (${this.pendingConfirm.entry.id})?`;
      lines.push(currentTheme.boldFg('warning', `  ${verb}`));
      lines.push(currentTheme.fg('textMuted', '  Press y / Enter to confirm, or n / Esc to cancel.'));
      lines.push('');
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines.map((line) => truncateToWidth(line, width, '…'));
    }

    for (let i = view.page.start; i < view.page.end; i++) {
      const entry = view.items[i]!;
      const isSelected = i === view.selectedIndex;
      const isCurrent = entry.id === this.opts.currentAgentId;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const indent = entry.depth > 0 ? `${'  '.repeat(entry.depth - 1)}└─ ` : '';
      const glyph = entry.isBranch
        ? '⎇'
        : entry.id === 'main'
          ? '●'
          : entry.isRunning
            ? '●'
            : entry.status === 'failed' || entry.status === 'error'
              ? '✗'
              : '✓';
      const glyphTone = entry.isRunning
        ? 'primary'
        : entry.status === 'failed' || entry.status === 'error'
          ? 'error'
          : entry.isBranch
            ? 'accent'
            : 'success';
      const kindTag = entry.isBranch
        ? entry.branchSealed
          ? 'branch · merged'
          : entry.toolsLocked
            ? 'branch · read-only'
            : 'branch'
        : undefined;
      const meta = [kindTag, entry.status, entry.model, entry.id !== entry.label ? entry.id : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' · ');

      let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} ${indent}`);
      line += currentTheme.fg(glyphTone, `${glyph} `);
      line += isSelected ? currentTheme.boldFg('primary', entry.label) : currentTheme.fg('text', entry.label);
      if (isCurrent) line += ` ${currentTheme.fg('success', CURRENT_MARK)}`;
      lines.push(line);
      this.renderedRowToIndex.push(i);
      if (meta.length > 0) {
        lines.push(currentTheme.fg('textMuted', `      ${'  '.repeat(entry.depth)}${meta}`));
        this.renderedRowToIndex.push(i);
      }
    }

    if (view.page.end < view.items.length) {
      lines.push(currentTheme.fg('textMuted', ` ▼ ${String(view.items.length - view.page.end)} more`));
    }
    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, '…'));
  }
}

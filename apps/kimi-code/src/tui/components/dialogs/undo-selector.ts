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
import { SearchableList } from '#/tui/utils/searchable-list';

const MAX_VISIBLE_CHOICES = 5;
const PREFERRED_SELECTED_OFFSET = 2;

export type RewindAction = 'jump' | 'fork' | 'undo';

export interface UndoChoice {
  readonly id: string;
  readonly count: number;
  readonly input: string;
  readonly label: string;
  /** Canonical backend messageId when available (required for targeted fork). */
  readonly messageId?: string;
}

export interface UndoSelectorOptions {
  readonly choices: readonly UndoChoice[];
  readonly onSelect: (choice: UndoChoice) => void;
  /** Optional multi-action mode (/rewind): Jump, Fork from message, or Undo last N turns. */
  readonly onAction?: (choice: UndoChoice, action: RewindAction) => void | Promise<unknown>;
  /** Fired whenever the highlighted checkpoint changes (for alt-screen live scroll preview). */
  readonly onHighlightChange?: (choice: UndoChoice) => void;
  readonly onCancel: () => void;
}

export class UndoSelectorComponent extends Container implements Focusable, MouseRoutable {
  focused = false;
  private readonly opts: UndoSelectorOptions;
  private readonly list: SearchableList<UndoChoice>;
  private submitted = false;
  private actionChoice: UndoChoice | undefined;
  private actionIndex = 0;
  private lastHighlightedId: string | undefined;
  private renderedRowTargets: Array<{ readonly kind: 'choice'; readonly index: number } | { readonly kind: 'action'; readonly index: number } | undefined> = [];

  constructor(opts: UndoSelectorOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.choices,
      toSearchText: (choice) => choice.label,
      initialIndex: Math.max(0, opts.choices.length - 1),
    });
    this.lastHighlightedId = this.list.selected()?.id;
  }

  /** Re-enable input after a recoverable action failure. */
  releaseSubmitLock(): void {
    this.submitted = false;
  }

  private notifyHighlight(): void {
    const selected = this.list.selected();
    if (selected !== undefined && selected.id !== this.lastHighlightedId) {
      this.lastHighlightedId = selected.id;
      this.opts.onHighlightChange?.(selected);
    }
  }

  private actionsFor(choice: UndoChoice): readonly { readonly id: RewindAction; readonly label: string; readonly description: string }[] {
    const turnNoun = choice.count === 1 ? 'turn' : 'turns';
    const items: Array<{ readonly id: RewindAction; readonly label: string; readonly description: string }> = [
      { id: 'jump', label: 'Jump to message', description: 'Scroll to this point without modifying history' },
    ];
    if (choice.messageId !== undefined && choice.messageId.length > 0) {
      items.push({
        id: 'fork',
        label: 'Fork session from here',
        description: 'Start a branched session up to this message',
      });
    }
    items.push({
      id: 'undo',
      label: `Undo last ${String(choice.count)} ${turnNoun}`,
      description: 'Withdraws conversation turns only (does not revert files on disk)',
    });
    return items;
  }

  private invokeAction(choice: UndoChoice, action: RewindAction): void {
    this.submitted = true;
    const res = this.opts.onAction?.(choice, action);
    if (res instanceof Promise) {
      void res.catch(() => {
        this.submitted = false;
      });
    }
  }

  handleInput(data: string): void {
    if (this.submitted) return;

    if (this.actionChoice !== undefined) {
      const actions = this.actionsFor(this.actionChoice);
      if (matchesKey(data, Key.escape)) {
        this.actionChoice = undefined;
        this.actionIndex = 0;
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.actionIndex = (this.actionIndex - 1 + actions.length) % actions.length;
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.actionIndex = (this.actionIndex + 1) % actions.length;
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const picked = actions[this.actionIndex];
        if (picked !== undefined) this.invokeAction(this.actionChoice, picked.id);
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (this.list.handleKey(data)) {
      this.notifyHighlight();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) {
        if (this.opts.onAction !== undefined) {
          this.actionChoice = selected;
          this.actionIndex = 0;
          return;
        }
        this.submitted = true;
        this.opts.onSelect(selected);
      }
    }
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (this.submitted) return false;
    if (event.wheel !== null) {
      if (this.actionChoice !== undefined) {
        const len = this.actionsFor(this.actionChoice).length;
        this.actionIndex = event.wheel < 0 ? (this.actionIndex - 1 + len) % len : (this.actionIndex + 1) % len;
      } else {
        if (event.wheel < 0) this.list.moveUp();
        else this.list.moveDown();
        this.notifyHighlight();
      }
      return true;
    }
    if (event.leftClick) {
      const target = this.renderedRowTargets[line];
      if (target === undefined) return false;
      if (target.kind === 'choice') {
        this.list.setSelectedIndex(target.index);
        this.notifyHighlight();
        const selected = this.list.selected();
        if (selected !== undefined) {
          if (this.opts.onAction !== undefined) {
            this.actionChoice = selected;
            this.actionIndex = 0;
          } else {
            this.submitted = true;
            this.opts.onSelect(selected);
          }
        }
        return true;
      }
      if (target.kind === 'action' && this.actionChoice !== undefined) {
        const picked = this.actionsFor(this.actionChoice)[target.index];
        if (picked !== undefined) {
          this.actionIndex = target.index;
          this.invokeAction(this.actionChoice, picked.id);
          return true;
        }
      }
    }
    return false;
  }

  override render(width: number): string[] {
    this.renderedRowTargets = [];
    if (this.actionChoice !== undefined) {
      const actions = this.actionsFor(this.actionChoice);
      const lines: string[] = [
        currentTheme.fg('primary', '─'.repeat(width)),
        currentTheme.boldFg('primary', ' Rewind action'),
        currentTheme.fg('textMuted', ' ↑↓ navigate · Enter confirm · Esc back'),
        '',
        currentTheme.fg('textDim', `   ${truncateToWidth(this.actionChoice.label, Math.max(8, width - 4), '…')}`),
        '',
      ];
      this.renderedRowTargets = Array.from({ length: lines.length }, () => undefined);
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i]!;
        const isSelected = i === this.actionIndex;
        const pointer = isSelected ? SELECT_POINTER : ' ';
        const prefix = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `);
        const title = isSelected
          ? currentTheme.boldFg(act.id === 'undo' ? 'warning' : 'primary', act.label)
          : currentTheme.fg('text', act.label);
        lines.push(`${prefix}${title}`);
        this.renderedRowTargets.push({ kind: 'action', index: i });
        lines.push(currentTheme.fg('textMuted', `      ${act.description}`));
        this.renderedRowTargets.push({ kind: 'action', index: i });
      }
      lines.push('');
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines.map((line) => truncateToWidth(line, width));
    }

    const view = this.list.view();
    const hintParts = ['↑↓ navigate', 'Enter select', 'Esc cancel'];

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', this.opts.onAction !== undefined ? ' Rewind conversation' : ' Select messages to undo'),
      currentTheme.fg('textMuted', ' ' + hintParts.join(' · ')),
      '',
    ];
    this.renderedRowTargets = Array.from({ length: lines.length }, () => undefined);

    if (view.items.length === 0) {
      lines.push(currentTheme.fg('textMuted', '   No messages'));
      this.renderedRowTargets.push(undefined);
    } else {
      const visibleCount = Math.min(MAX_VISIBLE_CHOICES, view.items.length);
      const maxStart = view.items.length - visibleCount;
      const start = Math.min(
        Math.max(0, view.selectedIndex - PREFERRED_SELECTED_OFFSET),
        maxStart,
      );
      const end = start + visibleCount;

      for (let i = start; i < end; i++) {
        const choice = view.items[i];
        if (choice === undefined) continue;
        lines.push(
          this.renderChoiceLine(choice, i === view.selectedIndex, i > view.selectedIndex, width),
        );
        this.renderedRowTargets.push({ kind: 'choice', index: i });
      }
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderChoiceLine(
    choice: UndoChoice,
    isSelected: boolean,
    inUndoRange: boolean,
    width: number,
  ): string {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const prefix = `  ${pointer} `;
    const labelBudget = Math.max(8, width - visibleWidth(prefix));
    const label = truncateToWidth(choice.label, labelBudget, '…');
    const token = isSelected ? 'primary' : inUndoRange ? 'textDim' : 'text';
    let line = currentTheme.fg(isSelected ? 'primary' : 'textDim', prefix);
    line += isSelected
      ? currentTheme.boldFg(token, label)
      : currentTheme.fg(token, label);
    return line;
  }
}

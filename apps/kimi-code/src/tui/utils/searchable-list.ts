/**
 * Cursor + fuzzy-search + paging state machine shared by list pickers
 * (ChoicePicker, ModelSelector). Pure logic, no rendering.
 *
 * The component owns presentation and the keys that carry component-specific
 * meaning — Enter (submit), Esc (cancel), and ←/→ (paging in one picker, a
 * thinking toggle in another). This unit owns the keys that behave identically
 * everywhere: ↑/↓, PgUp/PgDn, and search editing.
 */

import { Key, matchesKey } from '@kiki/pi-tui';
import { Fzf, byLengthAsc } from 'fzf';

import { pageView, type PageView } from './paging';
import { isPrintableChar, printableChar } from './printable-key';

const DEFAULT_PAGE_SIZE = 8;

export interface SearchableListOptions<T> {
  readonly items: readonly T[];
  /** Text a list item is fuzzy-matched against. */
  readonly toSearchText: (item: T) => string;
  /** Items per page; defaults to 8. */
  readonly pageSize?: number;
  /** Initial cursor position (clamped to >= 0). */
  readonly initialIndex?: number;
  /** When false, typed characters are ignored. Defaults to false. */
  readonly searchable?: boolean;
}

export interface SearchableListView<T> {
  /** Items after the active query filter. */
  readonly items: readonly T[];
  /** Page math for the current cursor over {@link items}. */
  readonly page: PageView;
  /** Cursor clamped into the current {@link items} range. */
  readonly selectedIndex: number;
  readonly query: string;
}

interface SearchableEntry<T> {
  readonly item: T;
  readonly text: string;
}

export class SearchableList<T> {
  private items: readonly T[];
  private fzf: Fzf<readonly SearchableEntry<T>[]> | undefined;
  private readonly toSearchText: (item: T) => string;
  private readonly pageSize: number;
  private readonly searchable: boolean;
  private query = '';
  private cursor: number;

  constructor(opts: SearchableListOptions<T>) {
    this.items = opts.items;
    this.toSearchText = opts.toSearchText;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.searchable = opts.searchable ?? false;
    this.cursor = Math.max(opts.initialIndex ?? 0, 0);
  }

  /**
   * Replaces the item set (e.g. after another page was appended), keeping the
   * active query; the cursor is clamped into the new range.
   */
  setItems(items: readonly T[]): void {
    this.items = items;
    this.fzf = undefined;
    this.cursor = Math.min(this.cursor, Math.max(0, items.length - 1));
  }

  filtered(): readonly T[] {
    const trimmed = this.query.trim();
    if (trimmed.length === 0) return this.items;
    if (this.fzf === undefined) {
      const entries: readonly SearchableEntry<T>[] = this.items.map((item) => ({
        item,
        text: this.toSearchText(item),
      }));
      this.fzf = new Fzf(entries, {
        selector: (entry) => entry.text,
        tiebreakers: [byLengthAsc],
      });
    }
    const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length <= 1) {
      return this.fzf.find(tokens[0] ?? trimmed).map((hit) => hit.item.item);
    }
    let scores = new Map<T, number>();
    for (const [index, token] of tokens.entries()) {
      const hits = this.fzf.find(token);
      if (index === 0) {
        for (const hit of hits) scores.set(hit.item.item, hit.score);
      } else {
        const next = new Map<T, number>();
        for (const hit of hits) {
          const prev = scores.get(hit.item.item);
          if (prev !== undefined) next.set(hit.item.item, prev + hit.score);
        }
        scores = next;
      }
      if (scores.size === 0) return [];
    }
    return [...scores.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .map(([item]) => item);
  }

  /** The item under the cursor, clamped into the filtered range. */
  selected(): T | undefined {
    const items = this.filtered();
    if (items.length === 0) return undefined;
    return items[Math.min(this.cursor, items.length - 1)];
  }

  view(): SearchableListView<T> {
    const items = this.filtered();
    return {
      items,
      page: pageView(items.length, this.cursor, this.pageSize),
      selectedIndex: Math.min(this.cursor, Math.max(0, items.length - 1)),
      query: this.query,
    };
  }

  moveUp(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + 1);
  }

  setSelectedIndex(index: number): void {
    this.cursor = Math.max(0, Math.min(Math.max(0, this.filtered().length - 1), index));
  }

  pageUp(): void {
    this.cursor = Math.max(0, this.cursor - this.pageSize);
  }

  pageDown(): void {
    this.cursor = Math.min(Math.max(0, this.filtered().length - 1), this.cursor + this.pageSize);
  }

  /** Clears the active query and resets the cursor. Returns whether a query was cleared. */
  clearQuery(): boolean {
    if (this.query.length === 0) return false;
    this.query = '';
    this.cursor = 0;
    return true;
  }

  /**
   * Handles the keys every picker shares: ↑/↓, PgUp/PgDn, and — when searchable —
   * Backspace and printable characters. Returns true when the key was consumed.
   * Enter, Esc, and ←/→ are intentionally left to the component.
   */
  handleKey(data: string): boolean {
    if (matchesKey(data, Key.up)) {
      this.moveUp();
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.moveDown();
      return true;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageUp();
      return true;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageDown();
      return true;
    }
    if (!this.searchable) return false;
    if (matchesKey(data, Key.backspace)) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      }
      return true;
    }
    const ch = printableChar(data);
    if (isPrintableChar(ch)) {
      this.query += ch;
      this.cursor = 0;
      return true;
    }
    return false;
  }
}

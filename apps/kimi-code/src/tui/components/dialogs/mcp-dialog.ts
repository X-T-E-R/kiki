/**
 * McpDialog — modal list dialog for inspecting and controlling MCP servers.
 *
 * Pure presentation + local interaction view: receives server snapshots and
 * callbacks from the host, supports per-item override cycling, reconnect/auth
 * triggers, inline detail/error drawers, and mouse navigation.
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
import {
  FOLD_COLLAPSED_MARK,
  FOLD_EXPANDED_MARK,
  SELECT_POINTER,
} from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const ELLIPSIS = '…';
const DEFAULT_PAGE_SIZE = 8;

export type McpOverride = 'on' | 'off' | 'inherit';

export interface McpDialogItem {
  readonly locator: string;
  readonly runtimeName?: string;
  readonly displayName: string;
  readonly origin: string;
  readonly override: McpOverride;
  readonly connection: string;
  readonly authStatus?: string;
  readonly toolCount?: number;
  readonly error?: string;
  readonly canAuth?: boolean;
  readonly canReconnect?: boolean;
}

export interface McpDialogOptions {
  readonly items: readonly McpDialogItem[];
  readonly onSetOverride: (locator: string, override: McpOverride) => void;
  readonly onReconnect?: (runtimeName: string) => void;
  readonly onAuth?: (locator: string) => void;
  readonly onCancel: () => void;
}

function nextOverrideState(current: McpOverride): McpOverride {
  if (current === 'inherit') return 'on';
  if (current === 'on') return 'off';
  return 'inherit';
}

function overrideTone(override: McpOverride): ColorToken {
  if (override === 'on') return 'success';
  if (override === 'off') return 'textDim';
  return 'textMuted';
}

function connectionTone(connection: string): ColorToken {
  const normalized = connection.trim().toLowerCase();
  if (normalized === 'connected' || normalized === 'ready' || normalized === 'online') {
    return 'success';
  }
  if (
    normalized === 'connecting' ||
    normalized === 'reconnecting' ||
    normalized.includes('auth') ||
    normalized === 'pending'
  ) {
    return 'warning';
  }
  if (
    normalized === 'error' ||
    normalized === 'failed' ||
    normalized === 'disconnected'
  ) {
    return 'error';
  }
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'stopped') {
    return 'textDim';
  }
  return 'textMuted';
}

function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= maxWidth ? word : truncateToWidth(word, maxWidth, ELLIPSIS);
  }

  if (current.length > 0) lines.push(current);
  return lines;
}

export class McpDialogComponent extends Container implements Focusable, MouseRoutable {
  focused = false;

  private readonly opts: McpDialogOptions;
  private readonly list: SearchableList<McpDialogItem>;
  private readonly expandedLocators = new Set<string>();
  private renderedItemByRow: Array<number | undefined> = [];

  constructor(opts: McpDialogOptions) {
    super();
    this.opts = opts;
    this.list = new SearchableList({
      items: opts.items,
      toSearchText: (item) => `${item.displayName} ${item.origin} ${item.locator}`,
      pageSize: DEFAULT_PAGE_SIZE,
      searchable: false,
    });
  }

  /** Replaces displayed MCP server items while keeping selection anchored by locator. */
  setItems(items: readonly McpDialogItem[]): void {
    const currentLocator = this.list.selected()?.locator;
    this.list.setItems(items);

    const validLocators = new Set(items.map((item) => item.locator));
    for (const locator of this.expandedLocators) {
      if (!validLocators.has(locator)) {
        this.expandedLocators.delete(locator);
      }
    }

    if (currentLocator !== undefined) {
      const preservedIndex = items.findIndex((item) => item.locator === currentLocator);
      if (preservedIndex >= 0) {
        this.list.setSelectedIndex(preservedIndex);
      }
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
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

    const ch = printableChar(data);
    const selected = this.list.selected();

    if (matchesKey(data, Key.space) || ch === ' ') {
      if (selected !== undefined) {
        this.opts.onSetOverride(selected.locator, nextOverrideState(selected.override));
      }
      return;
    }

    if (ch === 'r' || ch === 'R') {
      if (
        selected !== undefined &&
        selected.canReconnect === true &&
        selected.runtimeName !== undefined &&
        selected.runtimeName.length > 0
      ) {
        this.opts.onReconnect?.(selected.runtimeName);
      }
      return;
    }

    if (ch === 'a' || ch === 'A') {
      if (selected !== undefined && selected.canAuth === true) {
        this.opts.onAuth?.(selected.locator);
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (selected !== undefined) {
        this.toggleExpanded(selected.locator);
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
    if (event.leftClick && !event.motion && !event.release) {
      const targetIndex = this.renderedItemByRow[line];
      if (targetIndex === undefined) return false;
      this.list.setSelectedIndex(targetIndex);
      const selected = this.list.selected();
      if (selected !== undefined) {
        this.toggleExpanded(selected.locator);
      }
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
    const items = view.items;
    const selected = this.list.selected();

    const hintParts: string[] = ['↑↓ navigate'];
    if (view.page.pageCount > 1) hintParts.push('←→ page');
    hintParts.push('Space toggle', 'Enter details');
    if (
      this.opts.onReconnect !== undefined &&
      selected?.canReconnect === true &&
      selected.runtimeName !== undefined &&
      selected.runtimeName.length > 0
    ) {
      hintParts.push('R reconnect');
    }
    if (this.opts.onAuth !== undefined && selected?.canAuth === true) {
      hintParts.push('A auth');
    }
    hintParts.push('Esc cancel');

    const hintWidth = Math.max(1, safeWidth - 1);
    const hintLines = layoutHintLines(hintParts, hintWidth);

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(safeWidth)),
      truncateToWidth(
        currentTheme.boldFg('primary', ' MCP servers') +
          currentTheme.fg('textMuted', ` (${String(items.length)})`),
        safeWidth,
        ELLIPSIS,
      ),
    ];
    for (const hintLine of hintLines) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', ` ${hintLine}`), safeWidth, ELLIPSIS));
    }
    lines.push('');

    const rowMap: Array<number | undefined> = Array.from({ length: lines.length }, () => undefined);

    if (items.length === 0) {
      lines.push(truncateToWidth(currentTheme.fg('textMuted', '  No MCP servers configured'), safeWidth, ELLIPSIS));
      rowMap.push(undefined);
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const item = items[i]!;
        const isSelected = i === view.selectedIndex;
        const isExpanded = this.expandedLocators.has(item.locator);
        const itemLines = this.renderItem(item, isSelected, isExpanded, safeWidth);
        for (const itemLine of itemLines) {
          lines.push(truncateToWidth(itemLine, safeWidth, ELLIPSIS));
          rowMap.push(i);
        }
      }
    }

    lines.push('');
    rowMap.push(undefined);

    const remaining = items.length - view.page.end;
    if (remaining > 0 || view.page.pageCount > 1) {
      const footerParts: string[] = [];
      if (remaining > 0) footerParts.push(`▼ ${String(remaining)} more`);
      if (view.page.pageCount > 1) {
        footerParts.push(`Page ${String(view.page.page + 1)}/${String(view.page.pageCount)}`);
      }
      lines.push(
        truncateToWidth(currentTheme.fg('textMuted', ` ${footerParts.join(' · ')}`), safeWidth, ELLIPSIS),
      );
      rowMap.push(undefined);
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(safeWidth)));
    rowMap.push(undefined);

    this.renderedItemByRow = rowMap;
    return lines;
  }

  private toggleExpanded(locator: string): void {
    if (this.expandedLocators.has(locator)) {
      this.expandedLocators.delete(locator);
    } else {
      this.expandedLocators.add(locator);
    }
  }

  private renderItem(
    item: McpDialogItem,
    isSelected: boolean,
    isExpanded: boolean,
    width: number,
  ): string[] {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const fold = isExpanded
      ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
      : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
    const prefix = currentTheme.fg(isSelected ? 'primary' : 'textDim', `  ${pointer} `) + `${fold} `;
    const name = isSelected
      ? currentTheme.boldFg('primary', item.displayName)
      : currentTheme.fg('text', item.displayName);
    const origin = currentTheme.fg('textMuted', `[${item.origin}]`);
    const override = currentTheme.fg(overrideTone(item.override), item.override);
    const connection = currentTheme.fg(connectionTone(item.connection), item.connection);

    const metaParts: string[] = [connection];
    if (item.toolCount !== undefined) {
      metaParts.push(
        currentTheme.fg('textMuted', `${String(item.toolCount)} tool${item.toolCount === 1 ? '' : 's'}`),
      );
    }
    if (item.authStatus !== undefined && item.authStatus.length > 0) {
      metaParts.push(currentTheme.fg('textMuted', `auth ${item.authStatus}`));
    }

    const head = `${prefix}${name} ${origin}  ${override}  ${metaParts.join(currentTheme.fg('textMuted', ' · '))}`;
    const out: string[] = [head];

    if (!isExpanded) {
      if (item.error !== undefined && item.error.trim().length > 0) {
        const firstLine = item.error.trim().split(/\r?\n/)[0] ?? '';
        out.push(`      ${currentTheme.fg('error', firstLine)}`);
      }
      return out;
    }

    const detailWidth = Math.max(1, width - 6);
    out.push(`      ${currentTheme.fg('textMuted', `locator: ${item.locator}`)}`);
    if (item.runtimeName !== undefined && item.runtimeName.length > 0) {
      out.push(`      ${currentTheme.fg('textMuted', `runtime: ${item.runtimeName}`)}`);
    }
    if (item.authStatus !== undefined && item.authStatus.length > 0) {
      out.push(`      ${currentTheme.fg('textMuted', `auth: ${item.authStatus}`)}`);
    }

    const actions: string[] = ['Space cycle override'];
    if (item.canReconnect === true && item.runtimeName !== undefined && item.runtimeName.length > 0) {
      actions.push('R reconnect');
    }
    if (item.canAuth === true) {
      actions.push('A auth');
    }
    out.push(`      ${currentTheme.fg('textDim', `actions: ${actions.join(' · ')}`)}`);

    if (item.error !== undefined && item.error.trim().length > 0) {
      for (const rawLine of item.error.trim().split(/\r?\n/)) {
        for (const wrapped of wrapText(rawLine, detailWidth)) {
          out.push(`      ${currentTheme.fg('error', wrapped)}`);
        }
      }
    }

    return out;
  }
}

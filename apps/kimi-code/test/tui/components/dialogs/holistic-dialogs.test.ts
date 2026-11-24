import { CURSOR_MARKER, visibleWidth, type SgrMouseEvent } from '@kiki/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, vi } from 'vitest';

import {
  CommandPaletteComponent,
  type CommandPaletteEntry,
} from '#/tui/components/dialogs/command-palette';
import {
  HistorySearchDialogComponent,
  type HistorySearchEntry,
} from '#/tui/components/dialogs/history-search-dialog';
import {
  McpDialogComponent,
  type McpDialogItem,
} from '#/tui/components/dialogs/mcp-dialog';
import {
  ShortcutsOverlayComponent,
  type ShortcutGroup,
} from '#/tui/components/dialogs/shortcuts-overlay';
import {
  FOLD_COLLAPSED_MARK,
  FOLD_EXPANDED_MARK,
  SELECT_POINTER,
} from '#/tui/constant/symbols';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

const ANSI_ESC = /\u001B(?:\[[0-9;]*m|_pi:c\u0007)/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_ESC, '');
}

function mouseEvent(overrides: Partial<SgrMouseEvent> = {}): SgrMouseEvent {
  return {
    button: 0,
    col: 4,
    row: 0,
    release: false,
    wheel: null,
    motion: false,
    leftClick: false,
    rightClick: false,
    ...overrides,
  };
}

describe('McpDialogComponent', () => {
  const sampleItems: readonly McpDialogItem[] = [
    {
      locator: 'workspace:github',
      runtimeName: 'github-ws',
      displayName: 'github',
      origin: 'workspace',
      override: 'inherit',
      connection: 'connected',
      toolCount: 12,
      canReconnect: true,
      canAuth: false,
    },
    {
      locator: 'plugin:devtools:github',
      runtimeName: 'github-plugin',
      displayName: 'github',
      origin: 'plugin:devtools',
      override: 'on',
      connection: 'needs_auth',
      authStatus: 'expired',
      toolCount: 3,
      error: 'OAuth token expired — re-authenticate to resume tool calls.',
      canReconnect: true,
      canAuth: true,
    },
    {
      locator: 'user:sqlite',
      displayName: 'sqlite',
      origin: 'user',
      override: 'off',
      connection: 'disabled',
      canReconnect: false,
      canAuth: false,
    },
  ];

  it('distinguishes colliding names by origin, shows override/connection/tool count/error, and cycles override on Space', () => {
    const onSetOverride = vi.fn();
    const dialog = new McpDialogComponent({
      items: sampleItems,
      onSetOverride,
      onReconnect: vi.fn(),
      onAuth: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = dialog.render(100).map(strip);
    expect(rendered.some((line) => line.includes(`${SELECT_POINTER} ${FOLD_COLLAPSED_MARK} github [workspace]`) && line.includes('inherit') && line.includes('connected') && line.includes('12 tools'))).toBe(true);
    expect(rendered.some((line) => line.includes('github [plugin:devtools]') && line.includes('on') && line.includes('needs_auth') && line.includes('3 tools'))).toBe(true);
    expect(rendered.some((line) => line.includes('OAuth token expired'))).toBe(true);

    // Space (plain) on item 0: inherit -> on
    dialog.handleInput(' ');
    expect(onSetOverride).toHaveBeenLastCalledWith('workspace:github', 'on');

    // Move down to item 1 (override: 'on') and send Kitty CSI-u Space: on -> off
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\u001B[32u');
    expect(onSetOverride).toHaveBeenLastCalledWith('plugin:devtools:github', 'off');

    // Move down to item 2 (override: 'off'): off -> inherit
    dialog.handleInput('\u001B[B');
    dialog.handleInput(' ');
    expect(onSetOverride).toHaveBeenLastCalledWith('user:sqlite', 'inherit');
  });

  it('triggers R reconnect and A auth via printableChar only when permitted, toggles details on Enter, and preserves selection in setItems', () => {
    const onReconnect = vi.fn();
    const onAuth = vi.fn();
    const onCancel = vi.fn();
    const dialog = new McpDialogComponent({
      items: sampleItems,
      onSetOverride: vi.fn(),
      onReconnect,
      onAuth,
      onCancel,
    });

    // Item 0: canReconnect=true, canAuth=false
    dialog.handleInput('\u001B[114u'); // Kitty 'r'
    expect(onReconnect).toHaveBeenCalledWith('github-ws');
    dialog.handleInput('a');
    expect(onAuth).not.toHaveBeenCalled();

    // Move to item 1: canAuth=true, toggle drawer with Enter
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\u001B[97u'); // Kitty 'a'
    expect(onAuth).toHaveBeenCalledWith('plugin:devtools:github');

    dialog.handleInput('\r');
    const expanded = dialog.render(100).map(strip);
    expect(expanded.some((line) => line.includes(FOLD_EXPANDED_MARK) && line.includes('github [plugin:devtools]'))).toBe(true);
    expect(expanded.some((line) => line.includes('locator: plugin:devtools:github'))).toBe(true);
    expect(expanded.some((line) => line.includes('runtime: github-plugin'))).toBe(true);

    // Reorder items in setItems; selection stays on plugin:devtools:github
    dialog.setItems([sampleItems[2]!, sampleItems[0]!, sampleItems[1]!]);
    const afterReorder = dialog.render(100).map(strip);
    expect(afterReorder.some((line) => line.includes(`${SELECT_POINTER} ${FOLD_EXPANDED_MARK} github [plugin:devtools]`))).toBe(true);

    // Item 2 has no runtimeName and canReconnect=false: R must be ignored
    dialog.handleInput('\u001B[A');
    dialog.handleInput('\u001B[A');
    onReconnect.mockClear();
    dialog.handleInput('R');
    expect(onReconnect).not.toHaveBeenCalled();

    // Esc cancels
    dialog.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports mouse wheel navigation, stationary leftClick selection/toggle, and narrow-width clamping', () => {
    const onCancel = vi.fn();
    const dialog = new McpDialogComponent({
      items: sampleItems,
      onSetOverride: vi.fn(),
      onReconnect: vi.fn(),
      onAuth: vi.fn(),
      onCancel,
    });

    const lines = dialog.render(90).map(strip);
    const secondRow = lines.findIndex((line) => line.includes('github [plugin:devtools]'));
    expect(secondRow).toBeGreaterThan(0);

    // Drag/motion leftClick is ignored
    expect(dialog.routeMouse(mouseEvent({ leftClick: true, motion: true }), secondRow, 5)).toBe(false);

    // Stationary leftClick selects item 1 and expands details
    expect(dialog.routeMouse(mouseEvent({ leftClick: true }), secondRow, 5)).toBe(true);
    const expanded = dialog.render(90).map(strip);
    expect(expanded.some((line) => line.includes(`${SELECT_POINTER} ${FOLD_EXPANDED_MARK} github [plugin:devtools]`))).toBe(true);

    // Wheel up moves back to item 0
    expect(dialog.routeMouse(mouseEvent({ wheel: -1 }), secondRow, 5)).toBe(true);
    const afterWheel = dialog.render(90).map(strip);
    expect(afterWheel.some((line) => line.includes(`${SELECT_POINTER} ${FOLD_COLLAPSED_MARK} github [workspace]`))).toBe(true);

    // Outside click cancels
    expect(dialog.onOutsideMouseDown(mouseEvent({ leftClick: true }))).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Narrow width safety & Esc cancel visibility
    for (const width of [20, 40, 80, 120]) {
      const out = dialog.render(width);
      for (const line of out) {
        expect(visibleWidth(line), `width=${String(width)}`).toBeLessThanOrEqual(width);
      }
      expect(out.map(strip).some((line) => line.includes('Esc cancel'))).toBe(true);
    }
  });
});

describe('CommandPaletteComponent', () => {
  const entries: readonly CommandPaletteEntry[] = [
    {
      id: 'model',
      category: 'Suggested',
      label: 'Switch model',
      description: 'Choose active LLM and thinking mode',
      shortcut: 'Ctrl+M',
    },
    {
      id: 'mcp',
      category: 'Commands',
      label: '/mcp',
      description: 'Manage MCP servers',
      shortcut: '/mcp',
    },
    {
      id: 'compact-disabled',
      category: 'Commands',
      label: '/compact',
      description: 'Compact conversation context',
      disabledReason: 'Not available while a turn is streaming.',
    },
    {
      id: 'theme',
      category: 'Settings',
      label: 'Theme',
      description: 'Switch between dark and light palettes',
      searchText: 'appearance colors',
    },
    {
      id: 'skill-tui',
      category: 'Skills',
      label: 'write-tui',
      description: 'Author pi-tui components',
    },
    {
      id: 'agent-review',
      category: 'Agents',
      label: 'reviewer',
      description: 'Independent read-only code review',
    },
  ];

  it('renders right-aligned shortcuts, dims disabled entries with inline reason, and supports two-stage Esc', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const palette = new CommandPaletteComponent({
      entries,
      onSelect,
      onCancel,
    });

    const initial = palette.render(90).map(strip);
    expect(initial[1]).toContain('Command palette');
    expect(initial[1]).toContain('(type to search)');
    const modelLine = initial.find((line) => line.includes('Switch model'))!;
    expect(modelLine).toContain('Ctrl+M');
    expect(modelLine.trimEnd().endsWith('Ctrl+M')).toBe(true);

    // Move down to disabled /compact entry
    palette.handleInput('\u001B[B');
    palette.handleInput('\u001B[B');
    const withDisabledRaw = palette.render(90);
    const withDisabled = withDisabledRaw.map(strip);
    expect(withDisabled.some((line) => line.includes('Not available while a turn is streaming.'))).toBe(true);

    // Selecting disabled entry calls onSelect cleanly without throwing
    palette.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith(entries[2]);

    // Filter via searchText token ("appearance")
    for (const ch of 'appearance') palette.handleInput(ch);
    const filtered = palette.render(90).map(strip);
    expect(filtered.some((line) => line.includes('Search: appearance'))).toBe(true);
    expect(filtered.some((line) => line.includes('Theme'))).toBe(true);
    expect(filtered.some((line) => line.includes('Esc clear'))).toBe(true);
    expect(filtered.some((line) => line.includes('1 / 1'))).toBe(true);

    // First Esc clears query instead of canceling
    palette.handleInput('\u001B');
    expect(onCancel).not.toHaveBeenCalled();
    expect(palette.render(90).map(strip).some((line) => line.includes('Esc cancel'))).toBe(true);

    // Second Esc cancels
    palette.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('paginates lists longer than 10 entries and routes mouse wheel and stationary clicks', () => {
    const manyEntries: CommandPaletteEntry[] = Array.from({ length: 14 }, (_, idx) => ({
      id: `cmd-${String(idx)}`,
      category: 'Commands',
      label: `Command ${String(idx + 1)}`,
      shortcut: `Alt+${String(idx)}`,
    }));
    const onSelect = vi.fn();
    const palette = new CommandPaletteComponent({
      entries: manyEntries,
      onSelect,
      onCancel: vi.fn(),
    });

    const page1 = palette.render(80).map(strip);
    expect(page1.some((line) => line.includes('▼ 4 more'))).toBe(true);

    // Wheel down moves cursor to Command 2
    expect(palette.routeMouse(mouseEvent({ wheel: 1 }), 5, 5)).toBe(true);
    const afterWheel = palette.render(80).map(strip);
    expect(afterWheel.some((line) => line.includes(`${SELECT_POINTER} Command 2`))).toBe(true);

    // Stationary click on Command 3 selects it
    const row3 = afterWheel.findIndex((line) => line.includes('Command 3'));
    expect(row3).toBeGreaterThan(0);
    expect(palette.routeMouse(mouseEvent({ leftClick: true }), row3, 4)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(manyEntries[2]);

    // Width clamp verification
    for (const width of [20, 40, 80, 120]) {
      for (const line of palette.render(width)) {
        expect(visibleWidth(line), `width=${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('ShortcutsOverlayComponent', () => {
  const groups: readonly ShortcutGroup[] = [
    {
      title: 'Navigation',
      items: [
        { key: 'Ctrl+P', description: 'Open command palette' },
        { key: 'Ctrl+R', description: 'Reverse history search' },
        { key: 'Ctrl+O', description: 'Toggle expanded transcript' },
      ],
    },
    {
      title: 'Composer',
      items: [
        { key: 'Enter', description: 'Send prompt' },
        { key: 'Shift+Enter', description: 'Insert newline' },
        { key: 'Esc', description: 'Interrupt or cancel' },
      ],
    },
  ];

  it('switches cleanly between 2-column layout (width >= 76) and 1-column layout (width < 76)', () => {
    const overlay = new ShortcutsOverlayComponent({
      groups,
      onInsertLiteralQuestion: vi.fn(),
      onOpenPalette: vi.fn(),
      onOpenHelp: vi.fn(),
      onCancel: vi.fn(),
    });

    const wide = overlay.render(92).map(strip);
    const narrow = overlay.render(68).map(strip);
    const edge75 = overlay.render(75).map(strip);
    const edge76 = overlay.render(76).map(strip);

    // At width >= 76 both group headers share one horizontal line
    expect(wide.some((line) => line.includes('Navigation') && line.includes('Composer'))).toBe(true);
    expect(edge76.some((line) => line.includes('Navigation') && line.includes('Composer'))).toBe(true);

    // Below 76 groups stack into a single column
    expect(narrow.some((line) => line.includes('Navigation') && line.includes('Composer'))).toBe(false);
    expect(edge75.some((line) => line.includes('Navigation') && line.includes('Composer'))).toBe(false);
    expect(narrow.length).toBeGreaterThan(wide.length);

    // Framed with top and bottom horizontal borders only
    expect(wide[0]).toBe('─'.repeat(92));
    expect(wide.at(-1)).toBe('─'.repeat(92));
    expect(wide.slice(1, -1).some((line) => line === '─'.repeat(92))).toBe(false);

    for (const width of [24, 60, 75, 76, 100]) {
      for (const line of overlay.render(width)) {
        expect(visibleWidth(line), `width=${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('dispatches ?, Ctrl+P, Tab, Esc, and Q (including Kitty CSI-u sequences)', () => {
    const onInsertLiteralQuestion = vi.fn();
    const onOpenPalette = vi.fn();
    const onOpenHelp = vi.fn();
    const onCancel = vi.fn();

    const overlay = new ShortcutsOverlayComponent({
      groups,
      onInsertLiteralQuestion,
      onOpenPalette,
      onOpenHelp,
      onCancel,
    });

    overlay.handleInput('?');
    overlay.handleInput('\u001B[63u'); // Kitty '?'
    expect(onInsertLiteralQuestion).toHaveBeenCalledTimes(2);

    overlay.handleInput('\u0010'); // Ctrl+P
    expect(onOpenPalette).toHaveBeenCalledTimes(1);

    overlay.handleInput('\t'); // Tab
    expect(onOpenHelp).toHaveBeenCalledTimes(1);

    overlay.handleInput('\u001B[113u'); // Kitty 'q'
    overlay.handleInput('Q');
    overlay.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});

describe('HistorySearchDialogComponent', () => {
  const entries: readonly HistorySearchEntry[] = [
    { text: 'fix login race condition\nadd regression test', source: 'cleared-draft', mode: 'prompt' },
    { text: 'git status --short', source: 'history', mode: 'bash' },
    { text: 'vitest run test/tui/source-policy-guard.test.ts', source: 'history', mode: 'bash' },
    { text: '代码提交记录检查', source: 'history', mode: 'prompt' },
    { text: 'refactor mcp dialog override cycle', source: 'history', mode: 'prompt' },
    { text: 'check light theme contrast ratios', source: 'history', mode: 'prompt' },
    { text: 'git diff --stat', source: 'history', mode: 'bash' },
    { text: 'oldest git commit -m "init"', source: 'history', mode: 'bash' },
  ];

  it('embeds Input for IME-safe queries, filters newest-first, caps visible list at 6, and shows tags + preview', () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    const dialog = new HistorySearchDialogComponent({
      entries,
      onAccept,
      onCancel,
    });
    dialog.focused = true;

    const initialRaw = dialog.render(90);
    // Hardware cursor marker emitted by embedded Input when focused
    expect(initialRaw.some((line) => line.includes(CURSOR_MARKER))).toBe(true);

    const initial = initialRaw.map(strip);
    expect(initial.some((line) => line.includes('[cleared]') && line.includes('fix login race condition'))).toBe(true);
    expect(initial.some((line) => line.includes('[!]') && line.includes('git status --short'))).toBe(true);
    expect(initial.some((line) => line.includes('Preview'))).toBe(true);
    expect(initial.some((line) => line.includes('add regression test'))).toBe(true);
    // 8 entries -> 6 visible + "▼ 2 more"
    expect(initial.some((line) => line.includes('1 / 8') && line.includes('▼ 2 more'))).toBe(true);

    // Navigate older with Ctrl+R and Up, newer with Down
    dialog.handleInput('\u0012'); // Ctrl+R -> index 1 (git status --short)
    dialog.handleInput('\u001B[A'); // Up -> index 2 (vitest run ...)
    dialog.handleInput('\u001B[B'); // Down -> index 1 (git status --short)
    dialog.handleInput('\r');
    expect(onAccept).toHaveBeenCalledWith(entries[1]);

    // Multi-token + case-insensitive filtering ("GIT INIT")
    for (const ch of 'GIT INIT') dialog.handleInput(ch);
    const tokenFiltered = dialog.render(90).map(strip);
    expect(tokenFiltered.some((line) => line.includes('oldest git commit -m "init"'))).toBe(true);
    expect(tokenFiltered.some((line) => line.includes('1 / 1'))).toBe(true);

    // Clear with Ctrl+U and type multi-byte CJK IME string
    dialog.handleInput('\u0015');
    dialog.handleInput('提交 检查');
    const cjkFiltered = dialog.render(90).map(strip);
    expect(cjkFiltered.some((line) => line.includes('代码提交记录检查'))).toBe(true);
    onAccept.mockClear();
    dialog.handleInput('\r');
    expect(onAccept).toHaveBeenCalledWith(entries[3]);

    // No matches: Enter does not invoke onAccept
    dialog.handleInput('zzz-no-match');
    onAccept.mockClear();
    dialog.handleInput('\r');
    expect(onAccept).not.toHaveBeenCalled();
    expect(dialog.render(90).map(strip).some((line) => line.includes('No matches'))).toBe(true);

    // Esc cancels
    dialog.handleInput('\u001B');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('routes mouse wheel and stationary clicks, adapts to theme changes, and clamps narrow widths', () => {
    const onAccept = vi.fn();
    const dialog = new HistorySearchDialogComponent({
      entries,
      onAccept,
      onCancel: vi.fn(),
    });

    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      currentTheme.setPalette(lightColors);
      const lightOut = dialog.render(80);
      currentTheme.setPalette(darkColors);
      const darkOut = dialog.render(80);
      expect(lightOut).not.toEqual(darkOut);
    } finally {
      chalk.level = previousLevel;
      currentTheme.setPalette(darkColors);
    }

    const lines = dialog.render(80).map(strip);
    const bashRow = lines.findIndex((line) => line.includes('git status --short'));
    expect(bashRow).toBeGreaterThan(0);
    expect(dialog.routeMouse(mouseEvent({ leftClick: true }), bashRow, 4)).toBe(true);
    expect(onAccept).toHaveBeenCalledWith(entries[1]);

    for (const width of [20, 40, 80, 120]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line), `width=${String(width)}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

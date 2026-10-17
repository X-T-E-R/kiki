/**
 * HelpPanel — modal `/help` display. Slash commands render grouped by task
 * with compact one-line rows (usage + aliases + description, wrapped with a
 * hanging indent when long), followed by the input-box keyboard shortcuts.
 *
 * Mirrors the container-replacement pattern used by SessionPicker /
 * ApprovalPanel: host mounts the panel into `editorContainer`, picks
 * it as the focused component, and tears it down on the `onClose`
 * callback (fired on Esc / Enter / q).
 */

import {
  Container,
  matchesKey,
  Key,
  type Focusable,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@kiki/pi-tui';
import { DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcut } from '#/tui/constant/help';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export { DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcut } from '#/tui/constant/help';

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly disabled?: boolean;
}

export interface HelpPanelOptions {
  readonly commands?: readonly HelpPanelCommand[];
  /** Extra note lines rendered between the command list and the shortcuts. */
  readonly note?: string;
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly onClose: () => void;
  readonly maxVisible?: number | (() => number);
}

/**
 * Task-oriented grouping for the builtin daemon commands. Display layer only:
 * the command registry carries no category field, and any command not named
 * here falls into 'Other' (skill commands into 'Skills', disabled commands
 * last), so adding a registry entry never breaks the panel.
 */
const COMMAND_GROUPS: readonly { readonly title: string; readonly names: readonly string[] }[] = [
  {
    title: 'Sessions & history',
    names: ['sessions', 'new', 'fork', 'title', 'undo', 'compact', 'export-view'],
  },
  {
    title: 'Model & modes',
    names: ['model', 'effort', 'permission', 'yolo', 'auto', 'plan', 'agent', 'persona'],
  },
  { title: 'Agents & tasks', names: ['agents', 'agent-transcript', 'tasks', 'goal', 'btw'] },
  {
    title: 'Settings & integrations',
    names: [
      'settings',
      'theme',
      'editor',
      'experiments',
      'plugins',
      'provider',
      'mcp',
      'login',
      'logout',
      'reload',
      'init',
    ],
  },
  { title: 'App', names: ['status', 'usage', 'attach', 'copy', 'web', 'help', 'version', 'exit'] },
];
const OTHER_GROUP = 'Other';
const SKILLS_GROUP = 'Skills';
const DISABLED_GROUP = 'Disabled in daemon TUI';

/** Widest left column (usage + aliases) before a row falls back to stacked. */
const MAX_LEFT_COLUMN = 30;
/** Minimum description width that keeps the inline two-column row readable. */
const MIN_INLINE_DESCRIPTION = 20;

export class HelpPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: HelpPanelOptions;
  private scrollTop = 0;

  constructor(opts: HelpPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = printableChar(data);
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1; // render clamps
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const accent = (text: string) => currentTheme.fg('primary', text);

    const content = this.buildContentLines(Math.max(1, width));
    const limit = typeof this.opts.maxVisible === 'function' ? this.opts.maxVisible() : this.opts.maxVisible;
    const maxVisible = Math.max(1, limit ?? 24);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, content.length - maxVisible)));
    const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
    // Wrap the fixed hint so narrow terminals keep the scroll/page keys
    // instead of losing them to the trailing clamp.
    const hintLines = wrapTextWithAnsi(
      'Esc / Enter / q cancel · ↑↓ scroll · PgUp/PgDn page',
      Math.max(1, width),
    ).map((line) => muted(line));
    const lines = [
      accent('─'.repeat(Math.max(1, width))),
      currentTheme.boldFg('primary', ' help '),
      ...hintLines,
      '',
      ...slice,
      muted(` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`),
      accent('─'.repeat(Math.max(1, width))),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** Full scrollable body; every line is pre-wrapped to `width`. */
  private buildContentLines(width: number): string[] {
    const bold = (text: string) => currentTheme.bold(text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);

    const lines: string[] = [bold('Slash commands')];
    for (const group of groupCommands(this.opts.commands ?? [])) {
      lines.push('', bold(group.title));
      const column = Math.min(
        MAX_LEFT_COLUMN,
        Math.max(...group.commands.map((command) => commandLeft(command).width)),
      );
      for (const command of group.commands) {
        pushCommandRow(lines, command, column, width);
      }
    }

    if (this.opts.note !== undefined && this.opts.note.length > 0) {
      lines.push('');
      for (const noteLine of this.opts.note.split('\n')) {
        for (const wrapped of wrapTextWithAnsi(noteLine, Math.max(1, width))) {
          lines.push(muted(wrapped));
        }
      }
    }

    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    if (shortcuts.length > 0) {
      const keyColumn = Math.min(
        MAX_LEFT_COLUMN,
        Math.max(...shortcuts.map((shortcut) => visibleWidth(shortcut.keys))),
      );
      lines.push('', bold('Keyboard shortcuts (input box)'));
      for (const shortcut of shortcuts) {
        const keyCell = currentTheme.fg('warning', shortcut.keys);
        pushLabelRow(lines, keyCell, visibleWidth(shortcut.keys), keyColumn, shortcut.description, width);
      }
    }
    return lines;
  }

}

interface CommandGroup {
  readonly title: string;
  readonly commands: HelpPanelCommand[];
}

function groupCommands(commands: readonly HelpPanelCommand[]): CommandGroup[] {
  const order: string[] = [
    ...COMMAND_GROUPS.map((group) => group.title),
    OTHER_GROUP,
    SKILLS_GROUP,
    DISABLED_GROUP,
  ];
  const byGroup = new Map<string, HelpPanelCommand[]>();
  for (const command of commands) {
    const title = groupTitleFor(command);
    const bucket = byGroup.get(title) ?? [];
    bucket.push(command);
    byGroup.set(title, bucket);
  }
  const groups: CommandGroup[] = [];
  for (const title of order) {
    const bucket = byGroup.get(title);
    if (bucket === undefined || bucket.length === 0) continue;
    groups.push({
      title,
      commands: bucket.toSorted((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return groups;
}

function groupTitleFor(command: HelpPanelCommand): string {
  if (command.disabled === true) return DISABLED_GROUP;
  if (command.name.startsWith('skill:')) return SKILLS_GROUP;
  for (const group of COMMAND_GROUPS) {
    if (group.names.includes(command.name)) return group.title;
  }
  return OTHER_GROUP;
}

/** Usage + alias cell, plain and styled, e.g. `/help (/h, /?)`. */
function commandLeft(command: HelpPanelCommand): { readonly plain: string; readonly styled: string; readonly width: number } {
  const usage = `/${command.name}${command.argumentHint === undefined ? '' : ` ${command.argumentHint}`}`;
  const aliasSuffix =
    command.aliases.length === 0 ? '' : ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})`;
  const nameStyle = command.disabled === true ? 'textMuted' : 'primary';
  return {
    plain: usage + aliasSuffix,
    styled: currentTheme.fg(nameStyle, usage) + currentTheme.fg('textMuted', aliasSuffix),
    width: visibleWidth(usage + aliasSuffix),
  };
}

/**
 * One command row: inline two-column when the left cell and a readable
 * description budget fit, otherwise stacked with the description indented on
 * the following line(s). The description is always wrapped, never truncated.
 */
function pushCommandRow(
  lines: string[],
  command: HelpPanelCommand,
  column: number,
  width: number,
): void {
  const left = commandLeft(command);
  const descriptionStyle = command.disabled === true ? 'textMuted' : 'textDim';
  pushLabelRow(
    lines,
    left.styled,
    left.width,
    column,
    command.description,
    width,
    descriptionStyle,
  );
}

function pushLabelRow(
  lines: string[],
  styledLeft: string,
  leftWidth: number,
  column: number,
  description: string,
  width: number,
  descriptionStyle: 'textDim' | 'textMuted' = 'textDim',
): void {
  const dim = (text: string) => currentTheme.fg(descriptionStyle, text);
  const inline = leftWidth <= column && width - column - 3 >= MIN_INLINE_DESCRIPTION;
  if (inline) {
    const descriptionColumn = column + 3;
    const pad = ' '.repeat(Math.max(1, descriptionColumn - 1 - leftWidth));
    const budget = Math.max(8, width - descriptionColumn);
    const wrapped = wrapTextWithAnsi(description, budget);
    lines.push(` ${styledLeft}${pad}${dim(wrapped[0] ?? '')}`);
    const continuation = ' '.repeat(descriptionColumn);
    for (let i = 1; i < wrapped.length; i++) {
      lines.push(continuation + dim(wrapped[i] ?? ''));
    }
    return;
  }
  // Stacked: the left cell itself wraps on very narrow terminals instead of
  // being clipped by the render clamp (usage/aliases stay fully readable).
  const leftBudget = Math.max(1, width - 1);
  const leftLines = leftWidth <= leftBudget ? [styledLeft] : wrapTextWithAnsi(styledLeft, leftBudget);
  for (const leftLine of leftLines) {
    lines.push(` ${leftLine}`);
  }
  const budget = Math.max(8, width - 3);
  for (const wrappedLine of wrapTextWithAnsi(description, budget)) {
    lines.push(`   ${dim(wrappedLine)}`);
  }
}

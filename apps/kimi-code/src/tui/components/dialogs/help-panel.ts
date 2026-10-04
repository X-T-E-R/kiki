/**
 * HelpPanel — modal `/help` display. Lists keyboard shortcuts, slash
 * commands (with aliases + descriptions) in colour-coded sections.
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
  Text,
  type Focusable,
  truncateToWidth,
} from '@kiki/pi-tui';
import { DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcut } from '#/tui/constant/help';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export { DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcut } from '#/tui/constant/help';

export interface HelpPanelCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

export interface HelpPanelOptions {
  readonly commands?: readonly HelpPanelCommand[];
  readonly content?: string;
  readonly shortcuts?: readonly KeyboardShortcut[];
  readonly onClose: () => void;
  readonly maxVisible?: number | (() => number);
}

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
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const kbdColor = (text: string) => currentTheme.fg('warning', text);
    const slashColor = (text: string) => currentTheme.fg('primary', text);

    const shortcuts = this.opts.shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS;
    const sortedCmds = [...(this.opts.commands ?? [])].toSorted(compareSlashCommandsForDisplay);
    const commands = this.opts.content ?? sortedCmds.map((cmd) => {
      const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => '/' + a).join(', ')})` : '';
      return `${slashColor(`/${cmd.name}${aliases}`)}\n  ${dim(cmd.description)}`;
    }).join('\n\n');
    const body = [
      currentTheme.bold('Slash commands'),
      commands,
      '',
      currentTheme.bold('Keyboard shortcuts (input box)'),
      ...shortcuts.map((s) => `${kbdColor(s.keys)}\n  ${dim(s.description)}`),
    ].join('\n');
    const content = new Text(body, 0, 0).render(Math.max(1, width));
    const limit = typeof this.opts.maxVisible === 'function' ? this.opts.maxVisible() : this.opts.maxVisible;
    const maxVisible = Math.max(1, limit ?? 24);
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, content.length - maxVisible)));
    const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
    const lines = [
      accent('─'.repeat(Math.max(1, width))),
      currentTheme.boldFg('primary', ' help '),
      ...new Text(muted('Esc / Enter / q cancel · ↑↓ scroll · PgUp/PgDn page'), 0, 0).render(Math.max(1, width)),
      '',
      ...slice,
      muted(` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`),
      accent('─'.repeat(Math.max(1, width))),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function compareSlashCommandsForDisplay(a: HelpPanelCommand, b: HelpPanelCommand): number {
  return (
    getSlashCommandDisplayGroup(a.name) - getSlashCommandDisplayGroup(b.name) ||
    a.name.localeCompare(b.name)
  );
}

function getSlashCommandDisplayGroup(name: string): number {
  return name.startsWith('skill:') ? 1 : 0;
}

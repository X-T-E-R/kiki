export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

/** Defaults in the active DaemonTUI editor; dialog keys are shown by each dialog. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Enter', description: 'Submit input' },
  { keys: 'Shift-Enter / Ctrl-J', description: 'Insert newline' },
  { keys: '↑ / ↓', description: 'Browse input history' },
  { keys: 'Ctrl--', description: 'Undo input edits; /undo withdraws the last conversation turn' },
  { keys: 'Ctrl-C', description: 'Clear a nonempty draft first; with empty input, interrupt active work or press twice to exit when idle' },
  { keys: 'Ctrl-D', description: 'Press twice to exit, only with empty input' },
  { keys: 'Esc', description: 'Cancel completion or shell mode; otherwise interrupt active work' },
  { keys: 'Shift-Tab', description: 'Toggle plan mode' },
  { keys: 'Ctrl-G', description: 'Edit in external editor (/editor, $VISUAL, or $EDITOR)' },
  { keys: 'Ctrl-O', description: 'Expand / collapse tool output' },
  { keys: 'Ctrl-T', description: 'Expand / collapse the todo list when truncated' },
  { keys: 'Alt-V (Windows) / Ctrl-V (Unix)', description: 'Paste clipboard media' },
  { keys: 'Ctrl-S', description: 'Prompt steering shortcut is disabled in daemon TUI' },
  { keys: 'Ctrl-B (while busy)', description: 'Backgrounding the active turn is disabled in daemon TUI' },
];

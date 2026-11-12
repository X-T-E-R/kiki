export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

/** Defaults in the active DaemonTUI editor; dialog keys are shown by each dialog. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Enter', description: 'Submit input' },
  { keys: 'Shift+Enter / Ctrl+J', description: 'Insert newline (or end the line with \\ and press Enter)' },
  { keys: '↑ / ↓', description: 'Browse input history' },
  { keys: 'Ctrl+-', description: 'Undo input edits; /undo withdraws the last conversation turn' },
  { keys: 'Ctrl+C', description: 'Clear a draft; with empty input, interrupt the running turn, or press twice to exit when idle' },
  { keys: 'Ctrl+D', description: 'Press twice to exit, only with empty input' },
  { keys: 'Esc', description: 'Close completion, shell mode or history browsing; while a turn runs, interrupt it (press twice over a draft; /stop)' },
  { keys: 'Shift+Tab', description: 'Toggle plan mode' },
  { keys: 'Ctrl+G', description: 'Edit in external editor (/editor, $VISUAL, or $EDITOR)' },
  { keys: 'Ctrl+O', description: 'Expand / collapse tool output (/expand)' },
  { keys: 'Ctrl+T', description: 'Expand / collapse the todo list when truncated (/todos)' },
  { keys: 'Alt+V (Windows) / Ctrl+V (Unix)', description: 'Paste clipboard media' },
  { keys: 'Ctrl+S', description: 'Send the draft into the running turn; with empty input, steer the next queued prompt' },
  { keys: 'Ctrl+B (while busy)', description: 'Move foreground tasks to background' },
];

export interface KeyboardShortcut {
  readonly keys: string;
  readonly description: string;
}

  /** Defaults in the active DaemonTUI editor; dialog keys are shown by each dialog. */
export const DEFAULT_KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  { keys: 'Enter', description: 'Submit input (sends into active turn by default; configurable in /settings)' },
  { keys: 'Ctrl+Enter / Ctrl+S', description: 'Send draft immediately into the running turn; with empty input, steer next queued prompt' },
  { keys: 'Alt+Enter', description: 'Queue input for the next turn while busy (/queue)' },
  { keys: 'Alt+S', description: 'Steer the next queued prompt immediately when input is empty' },
  { keys: 'Shift+Enter / Ctrl+J', description: 'Insert newline (or end the line with \\ and press Enter)' },
  { keys: '↑ / ↓', description: 'Browse input history (with empty input & queued prompts, Alt+↑ edits the last queued prompt)' },
  { keys: 'Ctrl+R', description: 'Search input history and recently cleared drafts' },
  { keys: 'Ctrl+P', description: 'Open command palette (/palette)' },
  { keys: '?', description: 'Show active keyboard shortcuts when input is empty' },
  { keys: 'Ctrl+F', description: 'Search transcript when input is empty (/find); moves cursor right when typing' },
  { keys: 'PageUp / PageDown', description: 'Scroll transcript (opens transient fullscreen reader from main screen)' },
  { keys: 'Alt+← / Alt+→', description: 'Switch active agent / branch transcript when input is empty' },
  { keys: 'Alt+T', description: 'Cycle thinking effort for the current model' },
  { keys: 'Ctrl+-', description: 'Undo input edits; /rewind or Esc Esc (idle, empty) rewinds turns' },
  { keys: 'Ctrl+C', description: 'Clear a draft (saved to cleared-draft ring); empty: interrupt turn, or twice to exit when idle' },
  { keys: 'Ctrl+D', description: 'Press twice to exit, only with empty input' },
  { keys: 'Esc', description: 'Close completion, shell mode or history; while a turn runs, interrupt it (press twice over a draft; /stop); idle empty twice opens /rewind' },
  { keys: 'Shift+Tab', description: 'Toggle plan mode' },
  { keys: 'Alt+M', description: 'Toggle mouse reporting (/mouse) — turn off to drag-select text natively' },
  { keys: 'Ctrl+G', description: 'Edit in external editor (/editor, $VISUAL, or $EDITOR)' },
  { keys: 'Ctrl+O', description: 'Expand / collapse all tool & thinking blocks (/expand; or click any block)' },
  { keys: 'Ctrl+T', description: 'Expand / collapse the todo list when truncated (/todos)' },
  { keys: 'Alt+V (Windows) / Ctrl+V (Unix)', description: 'Paste clipboard media' },
  { keys: 'Ctrl+B (while busy)', description: 'Move foreground tasks to background' },
];

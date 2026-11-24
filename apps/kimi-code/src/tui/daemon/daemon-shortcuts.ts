import type { BusySubmitMode, ScreenMode } from '#/tui/config';

export interface ActiveShortcutItem {
  readonly key: string;
  readonly description: string;
}

export interface ActiveShortcutGroup {
  readonly title: string;
  readonly items: readonly ActiveShortcutItem[];
}

export interface ShortcutContext {
  readonly screenMode: ScreenMode;
  readonly mouseEnabled: boolean;
  readonly busySubmit: BusySubmitMode;
  readonly ctrlPBoundToHistory: boolean;
}

/**
 * Dynamic active-keybinding inventory rendered by the `?` shortcut overlay.
 */
export function buildActiveShortcutGroups(ctx: ShortcutContext): readonly ActiveShortcutGroup[] {
  const enterDesc =
    ctx.busySubmit === 'send_now'
      ? 'Submit (steers running turn while busy)'
      : 'Submit (queues for next turn while busy)';
  const screenDesc =
    ctx.screenMode === 'alt'
      ? 'Fullscreen alt active — /screen main for native scrollback'
      : 'Main scrollback active — PageUp opens transient reader, /screen alt stays fullscreen';

  return [
    {
      title: 'Input & Editing',
      items: [
        { key: 'Enter', description: enterDesc },
        { key: 'Shift+Enter / Ctrl+J', description: 'Insert newline' },
        { key: 'Ctrl+Enter / Ctrl+S', description: 'Send immediately / steer next queued prompt' },
        { key: 'Alt+Enter', description: 'Queue prompt for next turn' },
        { key: 'Ctrl+R', description: 'Search input history & cleared drafts' },
        { key: 'Alt+↑ (empty)', description: 'Pull last queued prompt back into editor' },
        { key: 'Ctrl+G', description: 'Open draft in external editor' },
        { key: 'Ctrl+-', description: 'Undo input edit' },
        { key: 'Ctrl+C', description: 'Clear draft (saved to ring) / interrupt / exit twice' },
      ],
    },
    {
      title: 'Transcript & Navigation',
      items: [
        { key: 'PageUp / PageDown', description: screenDesc },
        { key: 'Ctrl+F (empty) / /find', description: 'Search transcript' },
        { key: 'Ctrl+O', description: 'Expand / collapse all tools & thinking (or click block)' },
        { key: 'Ctrl+T', description: 'Expand / collapse todo list' },
        { key: 'Alt+← / Alt+→ (empty)', description: 'Switch focused agent / branch transcript' },
        { key: 'Esc Esc (idle, empty)', description: 'Open /rewind conversation checkpoint picker' },
      ],
    },
    {
      title: 'Modes & Commands',
      items: [
        {
          key: ctx.ctrlPBoundToHistory ? '/palette' : 'Ctrl+P / /palette',
          description: 'Open command palette',
        },
        { key: 'Shift+Tab', description: 'Toggle plan mode' },
        { key: 'Alt+T', description: 'Cycle thinking effort for current model' },
        {
          key: 'Alt+M',
          description: ctx.mouseEnabled
            ? 'Mouse ON — press to pause for native selection'
            : 'Mouse OFF — press to enable click & wheel in alt screen',
        },
        { key: 'Ctrl+B (busy)', description: 'Move foreground task to background' },
        { key: '? (empty)', description: 'Show this shortcuts panel (press ? again for literal ?)' },
      ],
    },
  ];
}

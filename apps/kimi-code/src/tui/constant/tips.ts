export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: '/sessions: resume earlier work', priority: 2 },
  { text: '@file: attach context', priority: 2 },
  { text: '!cmd: shell mode', priority: 2 },
  { text: 'Alt+Enter: queue next', priority: 2 },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: 'Shift+Enter: newline' },
  { text: 'Shift+Tab: plan mode', priority: 2 },
  { text: 'Ctrl+O: toggle output', priority: 2 },
  { text: 'Alt+M: mouse on/off' },
  { text: '/settings: preferences', priority: 2 },
  { text: '/model: switch model', priority: 2 },
  { text: '/help: shortcuts' },
];

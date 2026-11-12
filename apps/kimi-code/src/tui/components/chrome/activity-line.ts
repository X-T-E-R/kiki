/**
 * The status line above the input box while a turn runs ("Working 42s ·
 * 2 tasks running · Esc to interrupt") or waits on the user ("Waiting for
 * your approval").
 *
 * The line never wraps. When it does not fit, optional details are dropped
 * from the end first, then the key hint, and only then is the lead truncated,
 * so the state and how to stop it stay visible on narrow terminals.
 */

import { truncateToWidth, visibleWidth, type Component } from '@kiki/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface ActivityLineParts {
  /** The state, e.g. `Working 42s`; always shown. */
  readonly lead: string;
  readonly tone: 'text' | 'warning';
  /** Secondary facts in display order; the last one is dropped first. */
  readonly details: readonly string[];
  /** How to act on the state, e.g. `Esc to interrupt`. */
  readonly hint?: string;
}

const SEPARATOR = ' · ';

export class ActivityLineComponent implements Component {
  constructor(private readonly parts: ActivityLineParts) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { lead, tone } = this.parts;
    const details = [...this.parts.details];
    let hint = this.parts.hint;
    const plain = (): string =>
      [lead, ...details, ...(hint === undefined ? [] : [hint])].join(SEPARATOR);
    while (details.length > 0 && visibleWidth(plain()) > width) details.pop();
    if (visibleWidth(plain()) > width) hint = undefined;
    const rest = [...details, ...(hint === undefined ? [] : [hint])];
    const line =
      currentTheme.fg(tone, lead) +
      (rest.length === 0 ? '' : currentTheme.fg('textDim', `${SEPARATOR}${rest.join(SEPARATOR)}`));
    return [truncateToWidth(line, width, '…')];
  }
}

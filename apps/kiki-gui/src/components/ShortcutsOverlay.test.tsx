import { describe, expect, it } from 'vitest';

import { shortcutsGroups } from './ShortcutsOverlay';

function row(labelKey: string) {
  for (const group of shortcutsGroups('enter')) {
    for (const row of group.rows) {
      if (row.labelKey === labelKey) return row;
    }
  }
  return undefined;
}

describe('shortcutsGroups runtime honesty', () => {
  it('marks the browser-reserved combos as desktop-only', () => {
    // Browsers own Ctrl+N (new window) and Ctrl+Tab (tab switching);
    // preventDefault cannot intercept them, so App.tsx never registers them
    // outside the desktop shell and the overlay badges them.
    expect(row('shortcuts.newSession')?.desktopOnly).toBe(true);
    expect(row('shortcuts.nextSession')?.desktopOnly).toBe(true);
    // Interceptor-friendly combos stay unbadged.
    expect(row('shortcuts.switcher')?.desktopOnly).toBeUndefined();
    expect(row('shortcuts.settings')?.desktopOnly).toBeUndefined();
    expect(row('shortcuts.thisPanel')?.desktopOnly).toBeUndefined();
  });

  it('layers the Esc semantics instead of one ambiguous row', () => {
    const session = shortcutsGroups('enter').find(
      (group) => group.titleKey === 'shortcuts.group.session',
    )!;
    const escRows = session.rows.filter((r) => r.keys.length === 1 && r.keys[0] === 'Esc');
    expect(escRows.map((r) => r.labelKey)).toEqual([
      'shortcuts.escOverlay',
      'shortcuts.escTerminal',
      'shortcuts.escAbort',
    ]);
  });
});

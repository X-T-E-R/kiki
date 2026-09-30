import { describe, expect, it } from 'vitest';

import { shortcutsGroups } from './ShortcutsOverlay';

function row(labelKey: string) {
  for (const group of shortcutsGroups('enter', false)) {
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
    const session = shortcutsGroups('enter', false).find(
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

describe('shortcutsGroups follows the saved bindings', () => {
  it('prints a remapped chord and drops a disabled action', async () => {
    const { shortcutPreferencesSchema } = await import('@kiki/session-core/settings/shortcuts');
    const { applyShortcutPreferences, resetShortcutRuntime, shortcutState } = await import('../lib/shortcuts');
    resetShortcutRuntime('windows');
    applyShortcutPreferences(shortcutPreferencesSchema.parse({
      version: 1,
      overrides: { windows: { switcher: [{ key: 'p', modifier: 'mod', shift: true }], approve: [] } },
    }));
    const groups = shortcutsGroups('enter', false, shortcutState());
    const all = groups.flatMap((group) => group.rows);
    expect(all.find((entry) => entry.labelKey === 'shortcuts.switcher')?.keys).toEqual(['Ctrl', 'Shift', 'P']);
    expect(all.some((entry) => entry.labelKey === 'shortcuts.approve')).toBe(false);
    expect(all.some((entry) => entry.labelKey === 'shortcuts.reject')).toBe(true);
    resetShortcutRuntime('windows');
  });
});

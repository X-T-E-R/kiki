import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUT_PREFERENCES, SHORTCUT_DEFINITIONS, SHORTCUT_CATALOG, detectShortcutConflicts, matchesShortcut,
  resetShortcutPreferences, resolveShortcutBindings, shortcutPreferencesSchema, shortcutModifierLabel,
} from './shortcuts';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';

const key = (value: string, ctrlKey = false, metaKey = false, shiftKey = false) => ({ key: value, ctrlKey, metaKey, shiftKey, altKey: false });
describe('shortcut logic', () => {
  it('preserves shipped chords on Windows and macOS and exposes platform labels', () => {
    for (const entry of SHORTCUT_CATALOG) {
      expect(en).toHaveProperty(entry.labelKey);
      expect(zh).toHaveProperty(entry.labelKey);
    }
    for (const platform of ['windows', 'macos', 'linux'] as const) {
      expect(detectShortcutConflicts(DEFAULT_SHORTCUT_PREFERENCES, platform)).toEqual([]);
      const bindings = resolveShortcutBindings(DEFAULT_SHORTCUT_PREFERENCES, platform);
      expect(Object.keys(bindings)).toHaveLength(SHORTCUT_DEFINITIONS.length);
      expect(matchesShortcut(key('K', true), bindings.switcher[0]!)).toBe(true);
      expect(matchesShortcut(key('k', false, true), bindings.switcher[0]!)).toBe(true);
      expect(matchesShortcut(key('k', true, false, true), bindings.switcher[0]!)).toBe(false);
      expect(matchesShortcut({ ...key('k', true), isComposing: true }, bindings.switcher[0]!)).toBe(false);
      expect(matchesShortcut(key('`', false, true), bindings['terminal-toggle'][0]!)).toBe(false);
    }
    expect(shortcutModifierLabel(resolveShortcutBindings(DEFAULT_SHORTCUT_PREFERENCES, 'macos').switcher[0]!, 'macos')).toBe('⌘/Ctrl');
  });
  it('detects overlapping mod aliases and reserved keys but allows disjoint contexts', () => {
    const prefs = shortcutPreferencesSchema.parse({ version: 1, overrides: { windows: { switcher: [{ key: 'f', modifier: 'ctrl' }] } } });
    expect(detectShortcutConflicts(prefs, 'windows')).toContainEqual({ platform: 'windows', actions: ['switcher', 'find'], kind: 'duplicate', key: 'f' });
    expect(detectShortcutConflicts(prefs, 'macos')).toEqual([]);
    const reserved = shortcutPreferencesSchema.parse({ version: 1, overrides: { macos: { switcher: [{ key: 'q', modifier: 'meta' }] } } });
    expect(detectShortcutConflicts(reserved, 'macos')[0]?.kind).toBe('reserved');
    const contexts = shortcutPreferencesSchema.parse({ version: 1, overrides: { windows: { 'composer-mode': [{ key: 'y' }] } } });
    expect(detectShortcutConflicts(contexts, 'windows')).toEqual([]);
  });
  it('validates unknown actions/keys/versions and supports disable and scoped reset without mutation', () => {
    for (const value of [{ version: 2, overrides: {} }, { version: 1, overrides: { windows: { unknown: [] } } }, { version: 1, overrides: { macos: { switcher: [{ key: 'invalid' }] } } }]) {
      expect(shortcutPreferencesSchema.safeParse(value).success).toBe(false);
    }
    const prefs = shortcutPreferencesSchema.parse({ version: 1, overrides: { windows: { switcher: [] }, macos: { switcher: [] } } });
    expect(resolveShortcutBindings(prefs, 'windows').switcher).toEqual([]);
    const reset = resetShortcutPreferences(prefs, 'windows', 'switcher');
    expect(resolveShortcutBindings(reset, 'windows').switcher[0]?.key).toBe('k');
    expect(reset.overrides.macos?.switcher).toEqual([]);
    expect(prefs.overrides.windows?.switcher).toEqual([]);
    expect(resetShortcutPreferences(prefs)).toEqual(DEFAULT_SHORTCUT_PREFERENCES);
  });
});

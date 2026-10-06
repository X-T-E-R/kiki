// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { shortcutPreferencesSchema } from '@kiki/session-core/settings/shortcuts';
import {
  applyShortcutPreferences,
  beginShortcutRecording,
  browserOwnsChord,
  browserOwnsShortcut,
  chordFromEvent,
  chordKeys,
  matchesShortcutAction,
  resetShortcutRuntime,
} from './shortcuts';

const key = (value: string, init: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init,
});

afterEach(() => { resetShortcutRuntime('windows'); });

describe('runtime shortcut bindings', () => {
  it('keeps the shipped chords until the server answers', () => {
    resetShortcutRuntime('windows');
    expect(matchesShortcutAction(key('k', { ctrlKey: true }), 'switcher')).toBe(true);
    expect(matchesShortcutAction(key('k', { metaKey: true }), 'switcher')).toBe(true);
    expect(matchesShortcutAction(key('`', { ctrlKey: true }), 'terminal-toggle')).toBe(true);
    expect(matchesShortcutAction(key('F3', { shiftKey: true }), 'find-previous')).toBe(true);
    expect(matchesShortcutAction(key('F3'), 'find-previous')).toBe(false);
  });

  it('distinguishes browser-owned Tab chords and keeps navigation usable in the composer without eating plain Tab or IME', () => {
    const target = document.createElement('textarea');
    expect(matchesShortcutAction({ ...key('Tab', { ctrlKey: true }), target }, 'next-session')).toBe(true);
    expect(matchesShortcutAction({ ...key('Tab', { ctrlKey: true, shiftKey: true }), target }, 'previous-session')).toBe(true);
    expect(matchesShortcutAction({ ...key('Tab'), target }, 'next-session')).toBe(false);
    expect(matchesShortcutAction({ ...key('Tab', { shiftKey: true }), target }, 'previous-session')).toBe(false);
    expect(matchesShortcutAction({ ...key('Tab', { ctrlKey: true }), target, isComposing: true }, 'next-session')).toBe(false);
    expect(browserOwnsShortcut(key('Tab', { ctrlKey: true }))).toBe(true);
    expect(browserOwnsShortcut(key('Tab', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(browserOwnsShortcut(key('F6', { ctrlKey: true }))).toBe(false);
    expect(browserOwnsChord({ key: 'F6', modifier: 'ctrl', shift: false, alt: false })).toBe(false);
  });
  it('applies a saved remap and a disabled action at once', () => {
    resetShortcutRuntime('windows');
    applyShortcutPreferences(shortcutPreferencesSchema.parse({
      version: 1,
      overrides: { windows: { switcher: [{ key: 'p', modifier: 'mod', shift: true }], approve: [] }, macos: { settings: [] } },
    }));
    expect(matchesShortcutAction(key('k', { ctrlKey: true }), 'switcher')).toBe(false);
    expect(matchesShortcutAction(key('P', { ctrlKey: true, shiftKey: true }), 'switcher')).toBe(true);
    expect(matchesShortcutAction(key('y'), 'approve')).toBe(false);
    // Another platform's override never leaks into this one.
    expect(matchesShortcutAction(key(',', { ctrlKey: true }), 'settings')).toBe(true);
  });

  it('keeps bare character chords out of text fields and silences everything while recording', () => {
    resetShortcutRuntime('windows');
    const input = document.createElement('input');
    expect(matchesShortcutAction({ ...key('y'), target: input }, 'approve')).toBe(false);
    expect(matchesShortcutAction({ ...key('k', { ctrlKey: true }), target: input }, 'switcher')).toBe(true);
    const release = beginShortcutRecording();
    expect(matchesShortcutAction(key('k', { ctrlKey: true }), 'switcher')).toBe(false);
    release();
    release();
    expect(matchesShortcutAction(key('k', { ctrlKey: true }), 'switcher')).toBe(true);
  });
});

describe('chord recording', () => {
  it('records the platform primary modifier as mod and waits for a non-modifier key', () => {
    expect(chordFromEvent(key('Control', { ctrlKey: true }), 'windows')).toEqual({ kind: 'pending' });
    expect(chordFromEvent(key('K', { ctrlKey: true, shiftKey: true }), 'windows'))
      .toEqual({ kind: 'chord', chord: { key: 'k', modifier: 'mod', shift: true, alt: false } });
    expect(chordFromEvent(key('k', { metaKey: true }), 'macos'))
      .toEqual({ kind: 'chord', chord: { key: 'k', modifier: 'mod', shift: false, alt: false } });
    expect(chordFromEvent(key('k', { ctrlKey: true }), 'macos'))
      .toEqual({ kind: 'chord', chord: { key: 'k', modifier: 'ctrl', shift: false, alt: false } });
    expect(chordFromEvent(key('MediaPlayPause'), 'windows')).toEqual({ kind: 'unsupported', key: 'MediaPlayPause' });
  });

  it('prints keys the way each platform names them', () => {
    expect(chordKeys({ key: 'k', modifier: 'mod', shift: true, alt: false }, 'windows')).toEqual(['Ctrl', 'Shift', 'K']);
    expect(chordKeys({ key: 'k', modifier: 'mod', shift: false, alt: false }, 'macos')).toEqual(['⌘', 'K']);
    expect(chordKeys({ key: '?', modifier: 'none', shift: true, alt: false }, 'windows')).toEqual(['?']);
    expect(chordKeys({ key: 'F3', modifier: 'none', shift: true, alt: false }, 'linux')).toEqual(['Shift', 'F3']);
  });
});

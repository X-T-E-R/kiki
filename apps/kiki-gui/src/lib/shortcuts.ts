/**
 * Runtime shortcut bindings for the GUI. Every remappable key listener asks
 * this module instead of comparing `event.key` itself, so a binding saved in
 * Settings (server `gui.toml`, `shortcuts.v1`) takes effect on the next
 * keystroke without a reload. Until the server answers, and on servers that
 * predate the route, the shipped defaults apply.
 *
 * Fixed keys (send/newline, layered Escape, `/` and `@` triggers, history
 * arrows, the native show/hide hotkey) are not remappable and never pass
 * through here.
 */

import { useSyncExternalStore } from 'react';

import {
  DEFAULT_SHORTCUT_PREFERENCES,
  SHORTCUT_DEFINITIONS,
  matchesShortcut,
  resolveShortcutBindings,
  type ShortcutAction,
  type ShortcutChord,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
  type ShortcutPreferences,
} from '@kiki/session-core/settings/shortcuts';

export interface ShortcutState {
  readonly platform: ShortcutPlatform;
  readonly preferences: ShortcutPreferences;
  readonly bindings: Readonly<Record<ShortcutAction, readonly ShortcutChord[]>>;
}

/** The client's own platform; the server's OS is never assumed. */
export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'windows';
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const platform = `${hinted ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/mac|iphone|ipad/i.test(platform)) return 'macos';
  if (/win/i.test(platform)) return 'windows';
  return 'linux';
}

function stateFor(platform: ShortcutPlatform, preferences: ShortcutPreferences): ShortcutState {
  return { platform, preferences, bindings: resolveShortcutBindings(preferences, platform) };
}

let state: ShortcutState = stateFor(detectShortcutPlatform(), DEFAULT_SHORTCUT_PREFERENCES);
const listeners = new Set<() => void>();
let recording = 0;

export function shortcutState(): ShortcutState {
  return state;
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Replace the saved preferences (a server read or write answer). */
export function applyShortcutPreferences(preferences: ShortcutPreferences): void {
  state = stateFor(state.platform, preferences);
  for (const listener of listeners) listener();
}

/** Tests and a lost connection fall back to the shipped defaults. */
export function resetShortcutRuntime(platform: ShortcutPlatform = detectShortcutPlatform()): void {
  state = stateFor(platform, DEFAULT_SHORTCUT_PREFERENCES);
  recording = 0;
  for (const listener of listeners) listener();
}

export function useShortcutState(): ShortcutState {
  return useSyncExternalStore(subscribeShortcuts, shortcutState, shortcutState);
}

/**
 * While the settings recorder listens for a new chord, no app shortcut may
 * fire: the keystroke belongs to the recorder. Returns the release function.
 */
export function beginShortcutRecording(): () => void {
  recording += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    recording = Math.max(0, recording - 1);
  };
}

export function shortcutRecordingActive(): boolean {
  return recording > 0;
}

/**
 * True while focus sits in a text input surface. Global navigation shortcuts
 * that would yank focus away must yield to it; deliberate chorded app
 * shortcuts (Ctrl+K, Ctrl+, …) stay active by design.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLInputElement === 'undefined') return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** A single printable key with no Ctrl/⌘/Alt: typing, when focus is in a field. */
export function isBareCharacterChord(chord: ShortcutChord): boolean {
  return chord.modifier === 'none' && !chord.alt && [...chord.key].length === 1;
}

/**
 * Whether `event` presses one of `action`'s current chords. A bare character
 * chord never fires from inside an editable target, so a remapped letter can
 * not eat what the user is typing. An empty binding list disables the action.
 */
export function matchesShortcutAction(
  event: ShortcutKeyEvent & { readonly target?: EventTarget | null },
  action: ShortcutAction,
): boolean {
  if (recording > 0) return false;
  const editable = event.target !== undefined && isEditableTarget(event.target);
  return state.bindings[action].some((chord) =>
    matchesShortcut(event, chord) && !(editable && isBareCharacterChord(chord)));
}

export function shortcutDefinition(action: ShortcutAction) {
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id === action);
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Delete: 'Del', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn', ' ': 'Space',
};

/** Display keys for one chord, in press order (`['Ctrl', 'Shift', 'K']`). */
export function chordKeys(chord: ShortcutChord, platform: ShortcutPlatform): string[] {
  const mac = platform === 'macos';
  const keys: string[] = [];
  if (chord.modifier === 'mod') keys.push(mac ? '⌘' : 'Ctrl');
  else if (chord.modifier === 'ctrl') keys.push('Ctrl');
  else if (chord.modifier === 'meta') keys.push(mac ? '⌘' : platform === 'windows' ? 'Win' : 'Super');
  else if (chord.modifier === 'ctrl-meta') keys.push('Ctrl', mac ? '⌘' : platform === 'windows' ? 'Win' : 'Super');
  if (chord.alt) keys.push(mac ? '⌥' : 'Alt');
  // `?` already implies Shift; spelling it out would read as Shift+Shift+/.
  const impliedShift = chord.shift && [...chord.key].length === 1 && chord.key.toLowerCase() === chord.key.toUpperCase() && !/[0-9]/.test(chord.key);
  if (chord.shift && !impliedShift) keys.push(mac ? '⇧' : 'Shift');
  keys.push(KEY_LABELS[chord.key] ?? ([...chord.key].length === 1 ? chord.key.toUpperCase() : chord.key));
  return keys;
}

/** `Ctrl+Shift+K` — for menu hints and sentences. */
export function chordText(chord: ShortcutChord, platform: ShortcutPlatform): string {
  return chordKeys(chord, platform).join(platform === 'macos' ? '' : '+');
}

/** The first chord of an action, as text; undefined when the action is disabled. */
export function actionChordText(action: ShortcutAction, current: ShortcutState = state): string | undefined {
  const chord = current.bindings[action][0];
  return chord === undefined ? undefined : chordText(chord, current.platform);
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn', 'Hyper', 'Super']);

export type RecordedChord =
  | { readonly kind: 'pending' }
  | { readonly kind: 'chord'; readonly chord: ShortcutChord }
  | { readonly kind: 'unsupported'; readonly key: string };

/**
 * One keydown during recording → a chord for `platform`. The platform's
 * primary modifier (⌘ on macOS, Ctrl elsewhere) records as `mod`, matching
 * how the shipped defaults are written; the other one records literally.
 */
export function chordFromEvent(
  event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean },
  platform: ShortcutPlatform,
): RecordedChord {
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'pending' };
  const supported = [...event.key].length === 1 && !/[\u0000-\u001F\u007F]/u.test(event.key)
    || /^(?:Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(event.key);
  if (!supported) return { kind: 'unsupported', key: event.key };
  const primary = platform === 'macos' ? event.metaKey : event.ctrlKey;
  const secondary = platform === 'macos' ? event.ctrlKey : event.metaKey;
  const modifier: ShortcutChord['modifier'] = event.ctrlKey && event.metaKey ? 'ctrl-meta'
    : primary ? 'mod'
      : secondary ? (platform === 'macos' ? 'ctrl' : 'meta')
        : 'none';
  // Shift+K arrives as "K": store the base letter with the Shift flag.
  const key = [...event.key].length === 1 && event.shiftKey ? event.key.toLowerCase() : event.key;
  return { kind: 'chord', chord: { key, modifier, shift: event.shiftKey, alt: event.altKey } };
}

export function sameChord(a: ShortcutChord, b: ShortcutChord): boolean {
  return a.key.toLowerCase() === b.key.toLowerCase() && a.modifier === b.modifier && a.shift === b.shift && a.alt === b.alt;
}

/**
 * Appearance preferences that are not palette tokens: the motion level and
 * the face assistant prose is set in. Both are mirrored onto `<html>` as data
 * attributes so plain CSS can key on them — `data-kiki-motion` is read by
 * `styles/motion.css`, `data-kiki-prose` by `styles/skin.css`.
 *
 * They live in the desktop settings store (not the skin prefs) because they
 * are per-device reading choices, not part of a shareable skin file.
 */

import {
  readSettings,
  writeSettings,
  type MotionPreference,
  type ProseFontPreference,
} from '@kiki/session-core/settings';

import { DEFAULT_SKIN_PREFS, skinPrefsSnapshot, writeSkinPrefs, type SkinPrefs } from './store';

export function applyAppearanceAttributes(prefs: {
  readonly motion: MotionPreference;
  readonly proseFont: ProseFontPreference;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['kikiMotion'] = prefs.motion;
  root.dataset['kikiProse'] = prefs.proseFont;
}

/** Every appearance choice the Appearance page owns, as one snapshot. */
export interface AppearanceSnapshot {
  readonly theme: ReturnType<typeof readSettings>['theme'];
  readonly motion: MotionPreference;
  readonly proseFont: ProseFontPreference;
  readonly skin: SkinPrefs;
}

export const DEFAULT_APPEARANCE: AppearanceSnapshot = {
  theme: 'system',
  motion: 'system',
  proseFont: 'serif',
  skin: DEFAULT_SKIN_PREFS,
};

export function readAppearance(): AppearanceSnapshot {
  const settings = readSettings();
  return {
    theme: settings.theme,
    motion: settings.motion,
    proseFont: settings.proseFont,
    skin: skinPrefsSnapshot(),
  };
}

/**
 * True when nothing on the Appearance page has been customized. Light / dark
 * is a basic preference (onboarding asks for it) and has its own one-click
 * control, so it does not count as a customization here.
 */
export function isDefaultAppearance(snapshot: AppearanceSnapshot): boolean {
  return snapshot.motion === DEFAULT_APPEARANCE.motion
    && snapshot.proseFont === DEFAULT_APPEARANCE.proseFont
    && JSON.stringify(snapshot.skin) === JSON.stringify(DEFAULT_APPEARANCE.skin);
}

/**
 * "Restore defaults": every customization back to the default, the theme
 * choice kept as it is.
 */
export function defaultAppearanceFor(current: AppearanceSnapshot): AppearanceSnapshot {
  return { ...DEFAULT_APPEARANCE, theme: current.theme };
}

/** Write a whole snapshot back — used by "Restore defaults" and its undo. */
export function writeAppearance(snapshot: AppearanceSnapshot): void {
  writeSettings({ theme: snapshot.theme, motion: snapshot.motion, proseFont: snapshot.proseFont });
  writeSkinPrefs(snapshot.skin);
}

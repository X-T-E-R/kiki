/**
 * Appearance preferences that are not palette tokens: the motion level,
 * the face assistant prose is set in, and device-local reading / code sizes
 * and column width. Mirrored onto `<html>` as data attributes and CSS custom
 * properties so plain CSS can key on them — `data-kiki-motion` is read by
 * `styles/motion.css`, `data-kiki-prose` by `styles/skin.css`, and
 * `data-kiki-chat-width` / `--kiki-prose-font-size` / `--kiki-code-font-size`
 * by `index.css`.
 *
 * They live in the desktop settings store (not the skin prefs) because they
 * are per-device reading choices, not part of a shareable skin file.
 */

import {
  DEFAULT_CHAT_WIDTH,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_PROSE_FONT_SIZE,
  DEFAULT_UI_ZOOM,
  normalizeChatWidth,
  normalizeCodeFontSize,
  normalizeProseFontSize,
  readSettings,
  writeSettings,
  type ChatWidthPreference,
  type CodeFontSizePx,
  type MotionPreference,
  type ProseFontPreference,
  type ProseFontSizePx,
  type UiZoomPercent,
} from '@kiki/session-core/settings';

import {
  DEFAULT_BACKGROUND_PREFS,
  backgroundPrefsSnapshot,
  writeBackgroundPrefs,
  type BackgroundPrefs,
} from './background';
import { DEFAULT_SKIN_PREFS, skinPrefsSnapshot, writeSkinPrefs, type SkinPrefs } from './store';

export function applyAppearanceAttributes(prefs: {
  readonly motion: MotionPreference;
  readonly proseFont: ProseFontPreference;
  readonly proseFontSize?: ProseFontSizePx;
  readonly codeFontSize?: CodeFontSizePx;
  readonly chatWidth?: ChatWidthPreference;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const proseSize = normalizeProseFontSize(prefs.proseFontSize);
  const codeSize = normalizeCodeFontSize(prefs.codeFontSize);
  const chatWidth = normalizeChatWidth(prefs.chatWidth);
  root.dataset['kikiMotion'] = prefs.motion;
  root.dataset['kikiProse'] = prefs.proseFont;
  root.dataset['kikiChatWidth'] = chatWidth;
  if (proseSize === DEFAULT_PROSE_FONT_SIZE) {
    root.style.removeProperty('--kiki-prose-font-size');
  } else {
    root.style.setProperty('--kiki-prose-font-size', `${proseSize}px`);
  }
  if (codeSize === DEFAULT_CODE_FONT_SIZE) {
    root.style.removeProperty('--kiki-code-font-size');
  } else {
    root.style.setProperty('--kiki-code-font-size', `${codeSize}px`);
  }
}

/** Every appearance choice the Appearance page owns, as one snapshot. */
export interface AppearanceSnapshot {
  readonly theme: ReturnType<typeof readSettings>['theme'];
  readonly motion: MotionPreference;
  readonly proseFont: ProseFontPreference;
  readonly uiZoom: UiZoomPercent;
  readonly proseFontSize: ProseFontSizePx;
  readonly codeFontSize: CodeFontSizePx;
  readonly chatWidth: ChatWidthPreference;
  readonly skin: SkinPrefs;
  readonly background: BackgroundPrefs;
}

export const DEFAULT_APPEARANCE: AppearanceSnapshot = {
  theme: 'system',
  motion: 'system',
  proseFont: 'serif',
  uiZoom: DEFAULT_UI_ZOOM,
  proseFontSize: DEFAULT_PROSE_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  chatWidth: DEFAULT_CHAT_WIDTH,
  skin: DEFAULT_SKIN_PREFS,
  background: DEFAULT_BACKGROUND_PREFS,
};

export function readAppearance(): AppearanceSnapshot {
  const settings = readSettings();
  return {
    theme: settings.theme,
    motion: settings.motion,
    proseFont: settings.proseFont,
    uiZoom: settings.uiZoom,
    proseFontSize: settings.proseFontSize,
    codeFontSize: settings.codeFontSize,
    chatWidth: settings.chatWidth,
    skin: skinPrefsSnapshot(),
    background: backgroundPrefsSnapshot(),
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
    && snapshot.uiZoom === DEFAULT_APPEARANCE.uiZoom
    && snapshot.proseFontSize === DEFAULT_APPEARANCE.proseFontSize
    && snapshot.codeFontSize === DEFAULT_APPEARANCE.codeFontSize
    && snapshot.chatWidth === DEFAULT_APPEARANCE.chatWidth
    && JSON.stringify(snapshot.skin) === JSON.stringify(DEFAULT_APPEARANCE.skin)
    && snapshot.background.light === null && snapshot.background.dark === null;
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
  writeSettings({
    theme: snapshot.theme,
    motion: snapshot.motion,
    proseFont: snapshot.proseFont,
    uiZoom: snapshot.uiZoom,
    proseFontSize: snapshot.proseFontSize,
    codeFontSize: snapshot.codeFontSize,
    chatWidth: snapshot.chatWidth,
  });
  writeSkinPrefs(snapshot.skin);
  // Media bytes are kept until the next background pick prunes them, so
  // "Undo" after "Restore defaults" brings the same picture back.
  writeBackgroundPrefs(snapshot.background);
}

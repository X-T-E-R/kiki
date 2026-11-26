/**
 * Keeps `<html>` in sync with the active skin, for the life of the document.
 *
 * Runs alongside `startThemeSync` (which owns `data-theme`) rather than inside
 * it: the theme is light/dark, the skin is the palette, and the two are
 * independent axes. A skin change, a theme flip, an OS flip, and a live
 * settings preview all funnel into the same single apply.
 */

import {
  DEFAULT_CHAT_WIDTH,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_PROSE_FONT_SIZE,
  normalizeChatWidth,
  normalizeCodeFontSize,
  normalizeProseFontSize,
  readSettings,
  subscribeSettings,
  type DesktopSettings,
} from '@kiki/session-core/settings';

import { applyAppearanceAttributes } from './appearance';
import { effectiveBackgroundPrefs, slotForTheme, subscribeBackgroundPrefs } from './background';
import { applyBackdrop, refreshBackdropPlayback, watchBackdropPlayback } from './backdrop';
import { DEFAULT_SKIN_ID } from './builtin';
import { onThemeChange, prefersDark, resolveTheme, type ResolvedTheme } from '../theme';
import { spaceStorage } from '../spaceStorage';
import {
  applySkinVariables,
  declaredVariants,
  variantFor,
  variantToCssVariables,
  type SkinTweaks,
} from './apply';
import {
  effectiveSkinPrefs,
  isSkinSelectionSettled,
  resolveSkin,
  skinPreview,
  subscribeSkinPrefs,
  type SkinPrefs,
} from './store';

/**
 * Compact resolved skin payload consumed synchronously by `public/theme-boot.js`
 * before first paint. Written whenever the persisted (non-preview) skin or
 * appearance settings apply, and removed when reverted to untweaked defaults.
 */
export const SKIN_BOOT_STORAGE_KEY = 'kiki.skin.boot';

export interface SkinBootPayload {
  readonly v: 1;
  readonly theme: DesktopSettings['theme'];
  readonly light: Record<string, string>;
  readonly dark: Record<string, string>;
  readonly skinId?: string;
  readonly proseFace?: DesktopSettings['proseFont'];
  readonly motion?: DesktopSettings['motion'];
  readonly chatWidth?: DesktopSettings['chatWidth'];
  readonly proseFontSize?: number;
  readonly codeFontSize?: number;
}

/**
 * The theme a skin can actually honour. A dark-only skin asked for light has
 * no light variant; rather than inventing one, we keep `data-theme` where the
 * user put it and apply nothing, so the base palette shows through and the
 * settings UI can say the skin is dark-only.
 */
export function skinVariablesFor(prefs: SkinPrefs, theme: ResolvedTheme): Record<string, string> {
  const skin = resolveSkin(prefs.selection);
  if (skin === null) return variantToCssVariables(null, prefs.tweaks);
  const variants = declaredVariants(skin);
  // A single-variant skin applies its one variant in both themes only when the
  // user has no other option; a skin that declares both follows the theme.
  const variant =
    variantFor(skin, theme) ?? (variants.length === 1 ? skin.variants[variants[0]!] ?? null : null);
  return variantToCssVariables(variant, prefs.tweaks);
}

function hasCustomTweaks(tweaks: SkinTweaks): boolean {
  return Object.values(tweaks).some((value) => value !== undefined);
}

function persistSkinBootPayload(prefs: SkinPrefs, settings: DesktopSettings): void {
  // Never persist an unsaved live preview from Settings → Appearance.
  if (skinPreview() !== null) return;
  const skin = resolveSkin(prefs.selection);
  const unresolvedRemote = skin === null && !isSkinSelectionSettled(prefs.selection);
  // If a user or pack skin is selected and its target entry has not settled yet,
  // keep any existing pre-paint boot payload intact instead of erasing it.
  if (unresolvedRemote) return;

  const isDefaultUntweakedSkin =
    prefs.selection.source === 'builtin'
    && prefs.selection.id === DEFAULT_SKIN_ID
    && !hasCustomTweaks(prefs.tweaks);
  const proseSize = normalizeProseFontSize(settings.proseFontSize);
  const codeSize = normalizeCodeFontSize(settings.codeFontSize);
  const chatWidth = normalizeChatWidth(settings.chatWidth);
  const isDefaultAppearanceAttrs =
    settings.motion === 'system'
    && settings.proseFont === 'sans'
    && chatWidth === DEFAULT_CHAT_WIDTH
    && proseSize === DEFAULT_PROSE_FONT_SIZE
    && codeSize === DEFAULT_CODE_FONT_SIZE;

  const clearedSelection = skin === null && !hasCustomTweaks(prefs.tweaks);

  try {
    if ((isDefaultUntweakedSkin || clearedSelection) && isDefaultAppearanceAttrs) {
      spaceStorage.removeItem(SKIN_BOOT_STORAGE_KEY);
      return;
    }
    const payload: SkinBootPayload = {
      v: 1,
      theme: settings.theme,
      light: isDefaultUntweakedSkin ? {} : skinVariablesFor(prefs, 'light'),
      dark: isDefaultUntweakedSkin ? {} : skinVariablesFor(prefs, 'dark'),
      ...(skin !== null && !isDefaultUntweakedSkin ? { skinId: skin.id } : {}),
      proseFace: settings.proseFont,
      motion: settings.motion,
      chatWidth,
      ...(proseSize !== DEFAULT_PROSE_FONT_SIZE ? { proseFontSize: proseSize } : {}),
      ...(codeSize !== DEFAULT_CODE_FONT_SIZE ? { codeFontSize: codeSize } : {}),
    };
    spaceStorage.setItem(SKIN_BOOT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Boot cache is a pre-paint optimization; live DOM application still ran.
  }
}

function syncThemeColorMeta(paper: string | undefined): void {
  if (typeof document === 'undefined' || paper === undefined || paper === '') return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== paper) meta.content = paper;
  }
}

/** Apply the current skin once, against the current resolved theme. */
export function applyCurrentSkin(): void {
  if (typeof document === 'undefined') return;
  const settings = readSettings();
  // Motion and prose face ride the same loop: they are settings-store writes
  // with an attribute on <html>, and this is the one settings subscriber.
  applyAppearanceAttributes(settings);
  const theme = resolveTheme(settings.theme, prefersDark());
  const prefs = effectiveSkinPrefs();
  const skin = resolveSkin(prefs.selection);
  const unresolvedRemote =
    skin === null
    && skinPreview() === null
    && !isSkinSelectionSettled(prefs.selection);

  const preservePrePaint =
    unresolvedRemote
    && (document.documentElement.dataset['skin'] === prefs.selection.id
      || document.documentElement.style.getPropertyValue('--color-paper') !== '');

  if (!preservePrePaint) {
    const vars = skinVariablesFor(prefs, theme);
    applySkinVariables(document.documentElement, vars);
    // Surfaced for tests, the visual proof, and any CSS that wants to key on a
    // specific skin (nothing in-app does today — tokens are the contract).
    if (skin === null) delete document.documentElement.dataset['skin'];
    else document.documentElement.dataset['skin'] = skin.id;
    syncThemeColorMeta(vars['--color-paper']);
  }
  persistSkinBootPayload(prefs, settings);
  // The backdrop last: its readability floor reads the palette just written.
  const background = effectiveBackgroundPrefs();
  applyBackdrop(slotForTheme(background, theme), background.assist);
  refreshBackdropPlayback();
}

/** Start the sync. Returns a teardown for tests. */
export function startSkinSync(): () => void {
  applyCurrentSkin();
  const stopPrefs = subscribeSkinPrefs(applyCurrentSkin);
  const stopBackground = subscribeBackgroundPrefs(applyCurrentSkin);
  const stopSettings = subscribeSettings(applyCurrentSkin);
  const stopTheme = onThemeChange(applyCurrentSkin);
  const stopPlayback = watchBackdropPlayback();
  return () => {
    stopPrefs();
    stopBackground();
    stopSettings();
    stopTheme();
    stopPlayback();
  };
}

export type { SkinTweaks };

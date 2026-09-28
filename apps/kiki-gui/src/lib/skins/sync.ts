/**
 * Keeps `<html>` in sync with the active skin, for the life of the document.
 *
 * Runs alongside `startThemeSync` (which owns `data-theme`) rather than inside
 * it: the theme is light/dark, the skin is the palette, and the two are
 * independent axes. A skin change, a theme flip, an OS flip, and a live
 * settings preview all funnel into the same single apply.
 */

import { readSettings, subscribeSettings } from '@kiki/session-core/settings';

import { applyAppearanceAttributes } from './appearance';
import { onThemeChange, prefersDark, resolveTheme, type ResolvedTheme } from '../theme';
import {
  applySkinVariables,
  declaredVariants,
  variantFor,
  variantToCssVariables,
  type SkinTweaks,
} from './apply';
import {
  effectiveSkinPrefs,
  resolveSkin,
  subscribeSkinPrefs,
  type SkinPrefs,
} from './store';

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

/** Apply the current skin once, against the current resolved theme. */
export function applyCurrentSkin(): void {
  if (typeof document === 'undefined') return;
  const settings = readSettings();
  // Motion and prose face ride the same loop: they are settings-store writes
  // with an attribute on <html>, and this is the one settings subscriber.
  applyAppearanceAttributes(settings);
  const theme = resolveTheme(settings.theme, prefersDark());
  const prefs = effectiveSkinPrefs();
  applySkinVariables(document.documentElement, skinVariablesFor(prefs, theme));
  const skin = resolveSkin(prefs.selection);
  // Surfaced for tests, the visual proof, and any CSS that wants to key on a
  // specific skin (nothing in-app does today — tokens are the contract).
  if (skin === null) delete document.documentElement.dataset['skin'];
  else document.documentElement.dataset['skin'] = skin.id;
}

/** Start the sync. Returns a teardown for tests. */
export function startSkinSync(): () => void {
  applyCurrentSkin();
  const stopPrefs = subscribeSkinPrefs(applyCurrentSkin);
  const stopSettings = subscribeSettings(applyCurrentSkin);
  const stopTheme = onThemeChange(applyCurrentSkin);
  return () => {
    stopPrefs();
    stopSettings();
    stopTheme();
  };
}

export type { SkinTweaks };

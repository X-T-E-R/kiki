/**
 * Export the current skin + tweaks as a `kiki-skin` file the user can drop
 * into `~/.kiki/themes/`.
 *
 * The export is a real resolved skin, not a diff: a file that only recorded
 * "slate plus a different accent" would break the moment the built-in Slate
 * moved. Every token the active variant carries is written out, with the
 * tweaks folded in, so the file keeps looking the way it looked when exported.
 */

import type { SkinColorToken, SkinFile, SkinVariant } from '@kiki/protocol';

import { declaredVariants } from './apply';
import { findBuiltinSkin } from './builtin';
import type { SkinPrefs } from './store';
import { resolveSkin } from './store';

/** Mix a tweaked accent's companions the way the runtime does, but statically. */
function foldTweaks(variant: SkinVariant, prefs: SkinPrefs): SkinVariant {
  const colors: Partial<Record<SkinColorToken, string>> = { ...variant.colors };
  if (prefs.tweaks.accent !== undefined) colors.accent = prefs.tweaks.accent;
  const fonts = { ...variant.fonts };
  if (prefs.tweaks.fontSans !== undefined) fonts.sans = prefs.tweaks.fontSans;
  if (prefs.tweaks.fontMono !== undefined) fonts.mono = prefs.tweaks.fontMono;
  const shape = { ...variant.shape };
  if (prefs.tweaks.radius !== undefined) shape.radius = prefs.tweaks.radius;
  if (prefs.tweaks.spacing !== undefined) shape.spacing = prefs.tweaks.spacing;
  return {
    ...(variant.base !== undefined ? { base: variant.base } : {}),
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(Object.keys(fonts).length > 0 ? { fonts } : {}),
    ...(Object.keys(shape).length > 0 ? { shape } : {}),
  };
}

export interface SkinExport {
  readonly filename: string;
  readonly json: string;
}

/**
 * Build the file. `id`/`name` come from the user's chosen name so the export
 * does not collide with the built-in it started from.
 */
export function buildSkinExport(prefs: SkinPrefs, name: string): SkinExport {
  const base = resolveSkin(prefs.selection) ?? findBuiltinSkin('paper') ?? null;
  const id = slugify(name) || 'my-skin';
  const variants: { light?: SkinVariant; dark?: SkinVariant } = {};
  for (const theme of base === null ? [] : declaredVariants(base)) {
    variants[theme] = foldTweaks(base?.variants[theme] ?? {}, prefs);
  }
  // A skin exported from Paper has no color tokens of its own (Paper is the
  // base palette), so the export at least carries the tweaks in both variants.
  if (Object.keys(variants).length === 0) {
    variants.light = foldTweaks({}, prefs);
    variants.dark = foldTweaks({}, prefs);
  }

  const file: SkinFile = {
    $schema: 'https://kiki.dev/schema/skin-v1.json',
    kind: 'kiki-skin',
    version: 1,
    id,
    name: name.trim() === '' ? 'My skin' : name.trim(),
    ...(base?.description !== undefined ? { description: base.description } : {}),
    variants,
  };
  return { filename: `${id}.json`, json: `${JSON.stringify(file, null, 2)}\n` };
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/^[^a-z0-9]+/, '');
}

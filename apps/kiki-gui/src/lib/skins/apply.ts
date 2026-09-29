/**
 * The skin contract: which CSS variable each semantic token drives, and how a
 * resolved skin gets onto the document.
 *
 * Layering. `index.css` owns the base palette (`@theme` for light,
 * `[data-theme='dark']` for dark) — that is the shell owner's territory and a
 * skin never edits it. A skin is applied one level above, as inline custom
 * properties on `<html>`, which win over both stylesheet layers by
 * specificity and disappear the moment the skin is cleared. The consequence
 * worth knowing: applying a skin is a pure DOM write with no stylesheet
 * rebuild, so a preview is instant and revert is exact.
 *
 * Every token maps to variables that already exist in `index.css`. Adding a
 * token here without a consumer is dead weight; a consumer reading a color
 * that is not in this table cannot be reskinned.
 */

import type { SkinColorToken, SkinFile, SkinFontToken, SkinVariant } from '@kiki/protocol';

import type { ResolvedTheme } from '../theme';

/**
 * Token → CSS variables. Several tokens drive more than one variable because
 * Streamdown's shadcn properties mirror the kiki palette (`--color-background`
 * and friends) and must move with it or its code blocks desync.
 */
export const COLOR_TOKEN_VARIABLES: Readonly<Record<SkinColorToken, readonly string[]>> = {
  canvas: ['--color-canvas'],
  paper: ['--color-paper', '--color-muted', '--color-sidebar'],
  panel: ['--color-panel', '--color-background'],
  hairline: ['--color-hairline', '--color-border', '--color-input'],
  hairlineStrong: ['--color-hairline-strong'],
  ink: ['--color-ink', '--color-foreground'],
  inkSoft: ['--color-ink-soft', '--color-muted-foreground'],
  inkFaint: ['--color-ink-faint'],
  accent: ['--color-accent', '--color-primary'],
  accentDeep: ['--color-accent-deep'],
  accentSoft: ['--color-accent-soft'],
  accentInk: ['--color-accent-ink'],
  onAccent: ['--color-on-accent', '--color-primary-foreground'],
  amberInk: ['--color-amber-ink'],
  amberCard: ['--color-amber-card'],
  amberRule: ['--color-amber-rule'],
  success: ['--color-success'],
  danger: ['--color-danger'],
  onDanger: ['--color-on-danger'],
  bubbleUser: ['--color-bubble-user'],
  scrollbar: ['--color-scrollbar'],
  scrollbarHover: ['--color-scrollbar-hover'],
  termScrollbar: ['--color-term-scrollbar'],
  shell: ['--color-shell'],
  shellInk: ['--color-shell-ink'],
  shellInkStrong: ['--color-shell-ink-strong'],
  shellInkSoft: ['--color-shell-ink-soft'],
  shellDanger: ['--color-shell-danger'],
  shellHairline: ['--color-shell-hairline'],
  shellHover: ['--color-shell-hover'],
  shadowInk: [], // handled separately: consumers want an `r g b` triplet
};

export const FONT_TOKEN_VARIABLES: Readonly<Record<SkinFontToken, readonly string[]>> = {
  display: ['--font-display'],
  sans: ['--font-sans'],
  mono: ['--font-mono'],
};

/** `#rgb` / `#rrggbb` → `"r g b"`, the form `rgb(var(--x) / a)` consumers need. */
export function hexToRgbTriplet(hex: string): string | null {
  const body = hex.replace('#', '');
  const full = body.length === 3 ? body.split('').map((c) => `${c}${c}`).join('') : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const parts = [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16));
  return parts.join(' ');
}

/**
 * A skin's effective variant for a resolved theme. A dark-only skin returns
 * null for light: the caller keeps the base palette rather than inventing an
 * inverted variant the author never approved.
 */
export function variantFor(skin: SkinFile, theme: ResolvedTheme): SkinVariant | null {
  return skin.variants[theme] ?? null;
}

/** Themes a skin actually declares, in display order. */
export function declaredVariants(skin: SkinFile): readonly ResolvedTheme[] {
  const list: ResolvedTheme[] = [];
  if (skin.variants.light !== undefined) list.push('light');
  if (skin.variants.dark !== undefined) list.push('dark');
  return list;
}

/** Accent-as-text for a skin or tweak that moved the accent; see below. */
export const ACCENT_INK_MIX = 'color-mix(in oklab, var(--color-accent) 72%, var(--color-ink))';

/** Local per-token overrides from the settings editor, applied over the skin. */
export interface SkinTweaks {
  readonly accent?: string;
  readonly fontSans?: string;
  readonly fontMono?: string;
  readonly radius?: number;
  readonly spacing?: number;
}

/**
 * Flatten a variant plus the user's tweaks into the CSS custom properties to
 * write. Returned as a plain record so tests can assert the contract without a
 * DOM, and so the settings export can reuse the same resolution.
 */
export function variantToCssVariables(
  variant: SkinVariant | null,
  tweaks: SkinTweaks = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [token, value] of Object.entries(variant?.colors ?? {})) {
    if (typeof value !== 'string') continue;
    if (token === 'shadowInk') {
      const triplet = hexToRgbTriplet(value);
      if (triplet !== null) out['--kiki-shadow-ink'] = triplet;
      continue;
    }
    for (const variable of COLOR_TOKEN_VARIABLES[token as SkinColorToken] ?? []) {
      out[variable] = value;
    }
  }

  for (const [token, value] of Object.entries(variant?.fonts ?? {})) {
    if (typeof value !== 'string') continue;
    for (const variable of FONT_TOKEN_VARIABLES[token as SkinFontToken] ?? []) {
      out[variable] = value;
    }
  }

  // `--color-accent-ink` (the accent used as text) is an optional slot. A skin
  // that moves the accent without setting it derives it: the skin's accent
  // pulled a quarter of the way toward its own ink. That darkens it on a light
  // ground and lifts it on a dark one, so the words keep the skin's hue and
  // gain the contrast the bare accent lacks on canvas.
  if (variant?.colors?.accent !== undefined && variant.colors.accentInk === undefined) {
    out['--color-accent-ink'] = ACCENT_INK_MIX;
  }

  const shape = variant?.shape;
  if (shape?.radius !== undefined) out['--kiki-sheet-radius'] = `${shape.radius}px`;
  if (shape?.stageGap !== undefined) out['--kiki-stage-gap'] = `${shape.stageGap}px`;
  if (shape?.spacing !== undefined) out['--spacing'] = `${shape.spacing}rem`;

  // Tweaks win over the skin: they are the user's own last word.
  if (tweaks.accent !== undefined) {
    for (const variable of COLOR_TOKEN_VARIABLES.accent) out[variable] = tweaks.accent;
    // A hand-picked accent needs its companions derived, or hover states and
    // tinted washes keep pointing at the skin's original hue.
    out['--color-accent-deep'] = `color-mix(in oklab, ${tweaks.accent} 78%, black)`;
    out['--color-accent-soft'] = `color-mix(in oklab, ${tweaks.accent} 14%, var(--color-panel))`;
    out['--color-accent-ink'] = ACCENT_INK_MIX;
  }
  if (tweaks.fontSans !== undefined) out['--font-sans'] = tweaks.fontSans;
  if (tweaks.fontMono !== undefined) out['--font-mono'] = tweaks.fontMono;
  if (tweaks.radius !== undefined) out['--kiki-sheet-radius'] = `${tweaks.radius}px`;
  if (tweaks.spacing !== undefined) out['--spacing'] = `${tweaks.spacing}rem`;

  return out;
}

/** Every variable this module can write — the exact set to clear on revert. */
export function allSkinVariables(): readonly string[] {
  return [
    ...Object.values(COLOR_TOKEN_VARIABLES).flat(),
    ...Object.values(FONT_TOKEN_VARIABLES).flat(),
    '--kiki-shadow-ink',
    '--kiki-sheet-radius',
    '--kiki-stage-gap',
    '--spacing',
    '--color-accent-deep',
    '--color-accent-soft',
    '--color-accent-ink',
  ];
}

/**
 * Write a resolved skin onto an element (`<html>` in the app). Clearing every
 * variable this module owns first means switching skins never leaves a token
 * behind from the previous one, which is the whole failure mode of
 * "just set the new values".
 */
export function applySkinVariables(
  element: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } },
  variables: Record<string, string>,
): void {
  for (const variable of allSkinVariables()) element.style.removeProperty(variable);
  for (const [variable, value] of Object.entries(variables)) {
    element.style.setProperty(variable, value);
  }
}

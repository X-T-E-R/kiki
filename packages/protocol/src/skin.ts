/**
 * GUI skin file format (`kind: "kiki-skin"`).
 *
 * A skin is a purely declarative token override: colors, font-family stacks
 * and a few shape values. It can never carry CSS rules, selectors, URLs or
 * scripts, which is why the whole format is a closed key set with per-kind
 * value validation rather than a free-form map.
 *
 * Skin files live next to the TUI theme files in `<KIKI_HOME>/themes/`. The
 * two formats are told apart by the `kind` discriminator: a file with
 * `"kind": "kiki-skin"` is a GUI skin, a file without it is a TUI color theme
 * (`{ name, base, colors }`) and is ignored by the GUI.
 *
 * The shape is deliberately close to a plugin contribution entry, so the same
 * object can later be embedded in a plugin manifest without a migration.
 */

import { z } from 'zod';

/** Semantic color tokens a skin may set. Each maps to one GUI CSS variable. */
export const SKIN_COLOR_TOKENS = [
  // Surface ladder and text.
  'canvas',
  'paper',
  'panel',
  'hairline',
  'hairlineStrong',
  'ink',
  'inkSoft',
  'inkFaint',
  // Accent and semantic roles.
  'accent',
  'accentDeep',
  'accentSoft',
  /**
   * The accent used as text — links, inline code emphasis. Optional: a skin
   * that only moves `accent` keeps the derived fallback, so an existing skin
   * file needs no change.
   */
  'accentInk',
  'onAccent',
  'amberInk',
  'amberCard',
  'amberRule',
  'success',
  'danger',
  'onDanger',
  // Incidental surfaces.
  'bubbleUser',
  'scrollbar',
  'scrollbarHover',
  'termScrollbar',
  // The always-inset "shell" well: terminal, tool output, code islands.
  'shell',
  'shellInk',
  'shellInkStrong',
  'shellInkSoft',
  'shellDanger',
  'shellHairline',
  'shellHover',
  /** Shadow/scrim ink; applied as an `r g b` triplet. */
  'shadowInk',
] as const;

export type SkinColorToken = (typeof SKIN_COLOR_TOKENS)[number];

/** Font-family slots. Values are family stacks, never `@font-face` sources. */
export const SKIN_FONT_TOKENS = ['display', 'sans', 'mono'] as const;
export type SkinFontToken = (typeof SKIN_FONT_TOKENS)[number];

/** `#rgb` and `#rrggbb`, the two forms every skin authoring tool emits. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * A font stack is a comma-separated list of family names. Parentheses,
 * semicolons, braces, slashes, backslashes and `@` are rejected, which makes
 * `url(...)`, a second declaration, and an at-rule unrepresentable.
 */
const FONT_STACK = /^[\p{L}\p{N}\u4e00-\u9fff '",\-_. ]{1,200}$/u;

const hexColorSchema = z.string().regex(HEX_COLOR);
const fontStackSchema = z.string().regex(FONT_STACK);

export const skinColorsSchema = z
  .object(
    Object.fromEntries(
      SKIN_COLOR_TOKENS.map((token) => [token, hexColorSchema.optional()]),
    ) as Record<SkinColorToken, z.ZodOptional<typeof hexColorSchema>>,
  )
  .strict();

export const skinFontsSchema = z
  .object(
    Object.fromEntries(
      SKIN_FONT_TOKENS.map((token) => [token, fontStackSchema.optional()]),
    ) as Record<SkinFontToken, z.ZodOptional<typeof fontStackSchema>>,
  )
  .strict();

/**
 * Numeric shape tokens. Ranges are clamped rather than free: a skin that sets
 * a 400px radius or a 3rem spacing unit would not be a skin, it would be a
 * broken layout.
 */
export const skinShapeSchema = z
  .object({
    /** Sheet corner radius, in CSS px. */
    radius: z.number().min(0).max(28).optional(),
    /** Gap between the canvas edge and the raised sheets, in CSS px. */
    stageGap: z.number().min(0).max(24).optional(),
    /** Tailwind spacing unit, in rem — the app's density dial. */
    spacing: z.number().min(0.19).max(0.33).optional(),
  })
  .strict();

export const skinVariantSchema = z
  .object({
    /** Built-in variant unset tokens inherit from. Defaults to `paper`. */
    base: z.string().min(1).max(64).optional(),
    colors: skinColorsSchema.optional(),
    fonts: skinFontsSchema.optional(),
    shape: skinShapeSchema.optional(),
  })
  .strict();

export const skinFileSchema = z
  .object({
    /** Optional authoring aid; ignored at runtime. */
    $schema: z.string().optional(),
    kind: z.literal('kiki-skin'),
    version: z.literal(1),
    /** Stable identifier. The filename is used when this is omitted. */
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(),
    name: z.string().min(1).max(64),
    description: z.string().max(280).optional(),
    author: z.string().max(120).optional(),
    /** At least one of `light` / `dark`. A single-variant skin is legitimate. */
    variants: z
      .object({
        light: skinVariantSchema.optional(),
        dark: skinVariantSchema.optional(),
      })
      .strict()
      .refine((value) => value.light !== undefined || value.dark !== undefined, {
        message: 'variants must declare light, dark, or both',
      }),
  })
  .strict();

export type SkinColors = z.infer<typeof skinColorsSchema>;
export type SkinFonts = z.infer<typeof skinFontsSchema>;
export type SkinShape = z.infer<typeof skinShapeSchema>;
export type SkinVariant = z.infer<typeof skinVariantSchema>;
export type SkinFile = z.infer<typeof skinFileSchema>;

/** True when a parsed JSON object claims to be a GUI skin rather than a TUI theme. */
export function isSkinFileShape(value: unknown): boolean {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'kiki-skin'
  );
}

export interface SkinParseResult {
  readonly skin: SkinFile | null;
  /** Human-readable reasons individual entries or the whole file were dropped. */
  readonly warnings: readonly string[];
}

function pruneInvalid(
  source: Record<string, unknown>,
  accept: (value: unknown) => boolean,
  label: string,
  warnings: string[],
  known: readonly string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.includes(key)) {
      warnings.push(`${label}.${key}: unknown token`);
      continue;
    }
    if (!accept(value)) {
      warnings.push(`${label}.${key}: invalid value`);
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

function pruneVariant(raw: unknown, label: string, warnings: string[]): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const variant: Record<string, unknown> = {};
  if (typeof source['base'] === 'string') variant['base'] = source['base'];
  if (typeof source['colors'] === 'object' && source['colors'] !== null) {
    variant['colors'] = pruneInvalid(
      source['colors'] as Record<string, unknown>,
      (value) => typeof value === 'string' && HEX_COLOR.test(value),
      `${label}.colors`,
      warnings,
      SKIN_COLOR_TOKENS,
    );
  }
  if (typeof source['fonts'] === 'object' && source['fonts'] !== null) {
    variant['fonts'] = pruneInvalid(
      source['fonts'] as Record<string, unknown>,
      (value) => typeof value === 'string' && FONT_STACK.test(value),
      `${label}.fonts`,
      warnings,
      SKIN_FONT_TOKENS,
    );
  }
  if (typeof source['shape'] === 'object' && source['shape'] !== null) {
    const shape = skinShapeSchema.safeParse(source['shape']);
    if (shape.success) variant['shape'] = shape.data;
    else warnings.push(`${label}.shape: invalid value`);
  }
  return variant;
}

/**
 * Parse a skin file the way a theme loader should: one bad token never costs
 * the user the rest of the file. Unknown keys and out-of-contract values are
 * dropped with a warning; only a structurally impossible file returns null.
 */
export function parseSkinFile(raw: unknown, fallbackId?: string): SkinParseResult {
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { skin: null, warnings: ['not a JSON object'] };
  }
  const source = { ...(raw as Record<string, unknown>) };
  if (source['kind'] !== 'kiki-skin') {
    return { skin: null, warnings: ['not a kiki-skin file (missing kind)'] };
  }
  if (source['id'] === undefined && fallbackId !== undefined) source['id'] = fallbackId;
  if (source['name'] === undefined && typeof source['id'] === 'string') {
    source['name'] = source['id'];
  }
  const rawVariants =
    typeof source['variants'] === 'object' && source['variants'] !== null
      ? (source['variants'] as Record<string, unknown>)
      : {};
  const variants: Record<string, unknown> = {};
  const light = pruneVariant(rawVariants['light'], 'variants.light', warnings);
  const dark = pruneVariant(rawVariants['dark'], 'variants.dark', warnings);
  if (light !== undefined) variants['light'] = light;
  if (dark !== undefined) variants['dark'] = dark;
  source['variants'] = variants;

  const parsed = skinFileSchema.safeParse(source);
  if (!parsed.success) {
    return {
      skin: null,
      warnings: [...warnings, ...parsed.error.issues.map((issue) => issue.message)],
    };
  }
  return { skin: parsed.data, warnings };
}

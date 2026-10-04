/**
 * Backgrounds and appearance packs (`kind: "kiki-appearance-pack"`).
 *
 * Two layers share one vocabulary:
 *
 *   - A *background look* is the set of dials a user moves in Settings →
 *     Appearance: how the media fits and aligns, how visible it is, and how
 *     the reading surfaces above it let it through. Field names follow
 *     Windows Terminal (`backgroundImageStretchMode` → `fit`,
 *     `backgroundImageAlignment` → `alignment`, `backgroundImageOpacity` →
 *     `opacity`) and vscode-background (`scope`, carousel `interval`).
 *   - An *appearance pack* is a directory (or a zip of one) holding a manifest,
 *     an optional skin, background media and a preview. It is data only: no
 *     scripts, no stylesheets, no font files, no SVG — every asset is a raster
 *     image or a video whose bytes must match its extension.
 *
 * Custom CSS is deliberately not part of v1. Tokens already reach every
 * color, face and shape the app exposes; a stylesheet could additionally hide
 * or restyle approval prompts, overlay fake controls, or load `url(...)`
 * beacons, and a "safe subset" parser would be a permanent security surface
 * for little visual gain. A later version can add a declarative slot without
 * breaking v1 files.
 */

import { z } from 'zod';

import { skinVariantSchema } from './skin';

/** How the media fills its area (Windows Terminal stretch modes, renamed for CSS readers). */
export const BACKGROUND_FITS = ['cover', 'contain', 'tile', 'center'] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

/** The nine anchor points, spelled the way Windows Terminal spells them. */
export const BACKGROUND_ALIGNMENTS = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
] as const;
export type BackgroundAlignment = (typeof BACKGROUND_ALIGNMENTS)[number];

/** Which part of the window the background sits behind. */
export const BACKGROUND_SCOPES = ['window', 'main', 'sidebar'] as const;
export type BackgroundScope = (typeof BACKGROUND_SCOPES)[number];

export type BackgroundMediaKind = 'image' | 'video';

/** Extension → media type. The whole allow-list; anything else is refused. */
export const BACKGROUND_MEDIA_TYPES: Readonly<Record<string, { kind: BackgroundMediaKind; mime: string }>> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  avif: { kind: 'image', mime: 'image/avif' },
  gif: { kind: 'image', mime: 'image/gif' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
};

/** Size ceilings, shared by the server (enforced) and the GUI (explained). */
export const APPEARANCE_LIMITS = {
  /** One image. A 4K WebP/JPEG is 1–8 MB; 25 MB leaves room for a PNG. */
  imageBytes: 25 * 1024 * 1024,
  /** One video. About a minute of 1080p at a sane bitrate; held in memory while it plays. */
  videoBytes: 100 * 1024 * 1024,
  /** A whole pack zip, and the sum of its extracted files. */
  packBytes: 100 * 1024 * 1024,
  /** Files in one pack, manifest included. */
  packFiles: 64,
  /** Carousel slides per variant. */
  slides: 12,
  /** The manifest itself. */
  manifestBytes: 64 * 1024,
  /** Above this a video still plays, but the settings page warns about memory. */
  videoWarnBytes: 40 * 1024 * 1024,
} as const;

/** The media kind and type of a file name, or null when it is not allowed. */
export function backgroundMediaTypeOf(fileName: string): { kind: BackgroundMediaKind; mime: string } | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  return BACKGROUND_MEDIA_TYPES[fileName.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The media type the leading bytes actually carry. Used to refuse a file whose
 * extension lies (an HTML page renamed `.png`), so the served type is always
 * the true one.
 */
export function sniffBackgroundMediaType(head: Uint8Array): string | null {
  const at = (offset: number, bytes: readonly number[]): boolean =>
    bytes.every((byte, index) => head[offset + index] === byte);
  const ascii = (offset: number, text: string): boolean =>
    at(offset, Array.from(text, (char) => char.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...head.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return 'video/mp4';
  }
  return null;
}

/**
 * True when the sniffed type is the declared one. ISO-BMFF brands vary
 * (`isom`, `mp42`, `qt  `…); the sniffer maps every non-AVIF brand to mp4, so
 * a `.mp4` that is really AVIF is still refused.
 */
export function mediaTypeMatches(declared: string, sniffed: string | null): boolean {
  return sniffed !== null && declared === sniffed;
}

/**
 * The dials of one background. Ranges are clamped rather than free so every
 * value a file or a slider can produce still renders a usable window.
 */
export const backgroundLookSchema = z
  .object({
    fit: z.enum(BACKGROUND_FITS).optional(),
    alignment: z.enum(BACKGROUND_ALIGNMENTS).optional(),
    /** Media opacity, 0–1 (Windows Terminal `backgroundImageOpacity`). */
    opacity: z.number().min(0).max(1).optional(),
    /** Gaussian blur on the media itself, CSS px. */
    blur: z.number().min(0).max(40).optional(),
    /** Media brightness multiplier (CSS `brightness()`). */
    brightness: z.number().min(0.4).max(1.4).optional(),
    /** A wash of the theme's ground color over the media, 0–0.9. */
    scrim: z.number().min(0).max(0.9).optional(),
    scope: z.enum(BACKGROUND_SCOPES).optional(),
    /**
     * Opacity of the reading surfaces (sidebar, conversation sheet, panels)
     * above the media. The GUI raises it when needed to keep text at WCAG AA,
     * so this is a request, not a guarantee of see-through.
     */
    surfaceOpacity: z.number().min(0.3).max(1).optional(),
    /** Backdrop blur behind those surfaces, CSS px. */
    surfaceBlur: z.number().min(0).max(32).optional(),
  })
  .strict();
export type BackgroundLook = z.infer<typeof backgroundLookSchema>;

/**
 * The look every background starts from: the picture at full strength and a
 * see-through canvas, so it is plainly visible. Readability is carried by the
 * GUI's text layer (surfaces under text), not by darkening the whole window.
 */
export const DEFAULT_BACKGROUND_LOOK: Required<BackgroundLook> = {
  fit: 'cover',
  alignment: 'center',
  opacity: 1,
  blur: 0,
  brightness: 1,
  scrim: 0,
  scope: 'window',
  surfaceOpacity: 0.6,
  surfaceBlur: 14,
};

/** A pack-relative file name: one level, no traversal, an allowed extension. */
export const PACK_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isPackMediaFile(value: string): boolean {
  return PACK_FILE_PATTERN.test(value) && !value.includes('..') && backgroundMediaTypeOf(value) !== null;
}

const packFileSchema = z.string().refine(isPackMediaFile, { message: 'not an allowed pack file name' });

export const packBackgroundSchema = backgroundLookSchema
  .extend({
    /** One file, or several for a carousel. */
    media: z.array(packFileSchema).min(1).max(APPEARANCE_LIMITS.slides),
    /** Still frame shown for a video while paused or under reduced motion. */
    poster: packFileSchema.optional(),
    /** Seconds per slide; 0 or absent disables the carousel. */
    interval: z.number().int().min(0).max(3600).optional(),
    shuffle: z.boolean().optional(),
  })
  .strict();
export type PackBackground = z.infer<typeof packBackgroundSchema>;

export const packVariantSchema = skinVariantSchema.extend({ background: packBackgroundSchema.optional() }).strict();
export type PackVariant = z.infer<typeof packVariantSchema>;

export const APPEARANCE_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const APPEARANCE_PACK_MANIFEST = 'kiki-pack.json';

export const appearancePackSchema = z
  .object({
    $schema: z.string().optional(),
    kind: z.literal('kiki-appearance-pack'),
    version: z.literal(1),
    id: z.string().regex(APPEARANCE_PACK_ID_PATTERN),
    name: z.string().min(1).max(64),
    description: z.string().max(280).optional(),
    author: z.string().max(120).optional(),
    /** SPDX id or a short statement of where the art comes from. */
    license: z.string().max(200).optional(),
    /** A still image shown in the pack list. */
    preview: packFileSchema.optional(),
    variants: z
      .object({ light: packVariantSchema.optional(), dark: packVariantSchema.optional() })
      .strict()
      .refine((value) => value.light !== undefined || value.dark !== undefined, {
        message: 'variants must declare light, dark, or both',
      }),
  })
  .strict();
export type AppearancePack = z.infer<typeof appearancePackSchema>;

export interface AppearancePackParseResult {
  readonly pack: AppearancePack | null;
  readonly warnings: readonly string[];
}

/**
 * Validate a pack manifest. Unlike a skin, a pack is refused whole on any
 * error: it is installed as a unit, and a half-accepted pack would show media
 * the author never paired with those colors.
 */
export function parseAppearancePack(raw: unknown): AppearancePackParseResult {
  const parsed = appearancePackSchema.safeParse(raw);
  if (parsed.success) return { pack: parsed.data, warnings: [] };
  return {
    pack: null,
    warnings: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`),
  };
}

/** Every file a manifest references, deduplicated, in a stable order. */
export function appearancePackFiles(pack: AppearancePack): string[] {
  const files = new Set<string>();
  if (pack.preview !== undefined) files.add(pack.preview);
  for (const variant of [pack.variants.light, pack.variants.dark]) {
    for (const file of variant?.background?.media ?? []) files.add(file);
    if (variant?.background?.poster !== undefined) files.add(variant.background.poster);
  }
  return [...files];
}

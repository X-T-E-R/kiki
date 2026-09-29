/**
 * Window backgrounds: what the user picked, per theme, and how the reading
 * surfaces above it stay readable.
 *
 * The stack, bottom to top: the theme's canvas color, the media (opacity,
 * blur, brightness), a scrim of the canvas color, then the reading surfaces
 * (sidebar, conversation sheet) as a translucent wash of their own color with
 * a backdrop blur. Text only ever sits on a surface, so the one number that
 * decides readability is how opaque the surfaces are. `readableSurfaceAlpha`
 * raises the user's "surface opacity" just enough that the faintest text
 * token keeps WCAG AA (4.5:1) against the worst pixel the media can put
 * behind it — measured from the media when a sample exists, assumed pure
 * black and pure white when it does not.
 *
 * Prefs are per device (localStorage), like the rest of the appearance page.
 * Media bytes live in `mediaStore` (IndexedDB), never in these prefs.
 */

import {
  BACKGROUND_ALIGNMENTS,
  BACKGROUND_FITS,
  BACKGROUND_SCOPES,
  DEFAULT_BACKGROUND_LOOK,
  type BackgroundAlignment,
  type BackgroundLook,
  type BackgroundMediaKind,
} from '@kiki/protocol';

import type { ResolvedTheme } from '../theme';
import { spaceStorage } from '../spaceStorage';

/** A media file held in the local media store. */
export interface BackgroundMediaRef {
  /** Key in the media store. */
  readonly id: string;
  readonly kind: BackgroundMediaKind;
  readonly mime: string;
  /** Display name: the picked file's name, the URL's last segment, or a pack file. */
  readonly name: string;
  readonly bytes: number;
}

/** One theme's background: media plus the dials, fully resolved. */
export interface BackgroundSlot {
  /** One file, or several for a carousel (packs only). */
  readonly media: readonly BackgroundMediaRef[];
  /** Still shown for a video while paused or under reduced motion. */
  readonly poster?: BackgroundMediaRef;
  /** Carousel seconds per slide; 0 means no rotation. */
  readonly interval: number;
  readonly look: Required<BackgroundLook>;
  /** Set when the slot came from an appearance pack. */
  readonly packId?: string;
  /** Mean / dark / light luminance of the media, measured once after load. */
  readonly sample?: MediaSample;
}

export interface MediaSample {
  /** 5th percentile relative luminance, 0–1. */
  readonly dark: number;
  /** 95th percentile relative luminance, 0–1. */
  readonly light: number;
}

export interface BackgroundPrefs {
  readonly light: BackgroundSlot | null;
  readonly dark: BackgroundSlot | null;
  /** When true the light slot is used in both themes (the simple default). */
  readonly linked: boolean;
  /**
   * Readability assist: the surfaces text sits on get their own fill, solved
   * for contrast, while the rest keeps the requested panel opacity. A device
   * reading preference, so it lives here and never in a shared pack.
   */
  readonly assist: boolean;
}

export const DEFAULT_BACKGROUND_PREFS: BackgroundPrefs = { light: null, dark: null, linked: true, assist: true };

const STORAGE_KEY = 'kiki.background';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Fill every dial, clamping stored values into the protocol ranges. */
export function normalizeLook(raw: unknown): Required<BackgroundLook> {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BACKGROUND_LOOK;
  return {
    fit: oneOf(source['fit'], BACKGROUND_FITS, d.fit),
    alignment: oneOf(source['alignment'], BACKGROUND_ALIGNMENTS, d.alignment),
    opacity: clampNumber(source['opacity'], 0, 1, d.opacity),
    blur: clampNumber(source['blur'], 0, 40, d.blur),
    brightness: clampNumber(source['brightness'], 0.4, 1.4, d.brightness),
    scrim: clampNumber(source['scrim'], 0, 0.9, d.scrim),
    scope: oneOf(source['scope'], BACKGROUND_SCOPES, d.scope),
    surfaceOpacity: clampNumber(source['surfaceOpacity'], 0.3, 1, d.surfaceOpacity),
    surfaceBlur: clampNumber(source['surfaceBlur'], 0, 32, d.surfaceBlur),
  };
}

function normalizeMediaRef(raw: unknown): BackgroundMediaRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  // `local-<stamp>` for media on this device, `pack:<id>/<file>` for pack media.
  if (typeof source['id'] !== 'string' || !/^(?:local-[\w-]{1,80}|pack:[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(source['id'])) return null;
  if (source['kind'] !== 'image' && source['kind'] !== 'video') return null;
  if (typeof source['mime'] !== 'string' || !/^(image|video)\/[\w.+-]+$/.test(source['mime'])) return null;
  return {
    id: source['id'],
    kind: source['kind'],
    mime: source['mime'],
    name: typeof source['name'] === 'string' ? source['name'].slice(0, 200) : source['id'],
    bytes: clampNumber(source['bytes'], 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function normalizeSample(raw: unknown): MediaSample | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  if (typeof source['dark'] !== 'number' || typeof source['light'] !== 'number') return undefined;
  return { dark: clampNumber(source['dark'], 0, 1, 0), light: clampNumber(source['light'], 0, 1, 1) };
}

export function normalizeSlot(raw: unknown): BackgroundSlot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const media = (Array.isArray(source['media']) ? source['media'] : [])
    .map(normalizeMediaRef)
    .filter((ref): ref is BackgroundMediaRef => ref !== null)
    .slice(0, 12);
  if (media.length === 0) return null;
  const poster = normalizeMediaRef(source['poster']) ?? undefined;
  return {
    media,
    poster,
    interval: clampNumber(source['interval'], 0, 3600, 0),
    look: normalizeLook(source['look']),
    packId: typeof source['packId'] === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source['packId']) ? source['packId'] : undefined,
    sample: normalizeSample(source['sample']),
  };
}

export function normalizeBackgroundPrefs(raw: unknown): BackgroundPrefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BACKGROUND_PREFS;
  const source = raw as Record<string, unknown>;
  return {
    light: normalizeSlot(source['light']),
    dark: normalizeSlot(source['dark']),
    linked: source['linked'] !== false,
    assist: source['assist'] !== false,
  };
}
// ---------------------------------------------------------------------------
// Store: stored prefs plus an unsaved preview, the same shape as skin prefs.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let stored: BackgroundPrefs | undefined;

function readStored(): BackgroundPrefs {
  try {
    const raw = spaceStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_BACKGROUND_PREFS : normalizeBackgroundPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_BACKGROUND_PREFS;
  }
}

export function subscribeBackgroundPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function backgroundPrefsSnapshot(): BackgroundPrefs {
  stored ??= readStored();
  return stored;
}

export function backgroundPrefsServerSnapshot(): BackgroundPrefs {
  return DEFAULT_BACKGROUND_PREFS;
}

/**
 * Write the prefs. `assist` is a reading preference, not part of a picture:
 * a write that leaves it out (a pack, a link toggle) keeps the current value.
 */
export function writeBackgroundPrefs(next: Omit<BackgroundPrefs, 'assist'> & { readonly assist?: boolean }): void {
  const normalized = normalizeBackgroundPrefs({ ...next, assist: next.assist ?? backgroundPrefsSnapshot().assist });
  try {
    if (normalized.light === null && normalized.dark === null && normalized.linked && normalized.assist) spaceStorage.removeItem(STORAGE_KEY);
    else spaceStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage is a convenience; the in-memory prefs still apply.
  }
  if (JSON.stringify(normalized) !== JSON.stringify(stored)) stored = normalized;
  for (const listener of listeners) listener();
}

/** What the document shows. Every control applies on change, so this is storage. */
export function effectiveBackgroundPrefs(): BackgroundPrefs {
  return backgroundPrefsSnapshot();
}

/** Drop the in-memory snapshot so the next read reloads storage (tests). */
export function resetBackgroundPrefsCache(): void {
  stored = undefined;
}

/** The slot a theme shows: linked prefs reuse the light slot in both themes. */
export function slotForTheme(prefs: BackgroundPrefs, theme: ResolvedTheme): BackgroundSlot | null {
  if (prefs.linked) return prefs.light ?? prefs.dark;
  return prefs[theme];
}

/** Which slot key an edit made in `theme` should land in. */
export function editKeyForTheme(prefs: BackgroundPrefs, theme: ResolvedTheme): 'light' | 'dark' {
  return prefs.linked ? 'light' : theme;
}

// ---------------------------------------------------------------------------
// Readability: the lowest surface opacity that keeps text at WCAG AA.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const body = hex.trim().replace('#', '');
  const full = body.length === 3 ? body.split('').map((c) => `${c}${c}`).join('') : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16) / 255) as unknown as Rgb;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function relativeLuminance(color: Rgb): number {
  return 0.2126 * toLinear(color[0]) + 0.7152 * toLinear(color[1]) + 0.0722 * toLinear(color[2]);
}

export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Browsers composite in gamma-encoded sRGB; so does this. */
function mix(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => top[i]! * alpha + bottom[i]! * (1 - alpha)) as unknown as Rgb;
}

function gray(luminance: number): Rgb {
  const v = toSrgb(Math.min(1, Math.max(0, luminance)));
  return [v, v, v];
}

export interface SurfaceColors {
  readonly surface: string;
  readonly ground: string;
  /** Text tokens that sit on the surface; every one must hold the target. */
  readonly texts: readonly string[];
}

/** WCAG AA for body text. */
export const TEXT_CONTRAST_TARGET = 4.5;

/**
 * The media sample is the 5th/95th luminance percentile of a downscaled frame
 * and compositing rounds per channel, so rendered pixels can sit a hair past
 * the model. Solving a little above the target keeps the rendered result on it.
 */
const SOLVE_HEADROOM = 0.15;

/**
 * The smallest surface alpha ≥ `requested` for which every text color keeps
 * `TEXT_CONTRAST_TARGET` against the surface composited over the darkest and
 * the lightest pixel the media can show there.
 */
export function readableSurfaceAlpha(colors: SurfaceColors, look: Required<BackgroundLook>, sample: MediaSample | undefined, requested: number): number {
  const surface = parseHex(colors.surface);
  const ground = parseHex(colors.ground);
  const texts = colors.texts.map(parseHex).filter((text): text is Rgb => text !== null);
  if (surface === null || ground === null || texts.length === 0) return 1;
  const weight = look.opacity * (1 - look.scrim);
  const extremes = [sample?.dark ?? 0, sample?.light ?? 1].map((lum) => {
    const media = gray(Math.min(1, lum * look.brightness));
    return mix(media, ground, weight);
  });
  const holds = (alpha: number) => extremes.every((backdrop) => {
    const lum = relativeLuminance(mix(surface, backdrop, alpha));
    return texts.every((text) => contrastRatio(relativeLuminance(text), lum) >= TEXT_CONTRAST_TARGET + SOLVE_HEADROOM);
  });
  if (holds(requested)) return requested;
  let lo = requested;
  let hi = 1;
  for (let step = 0; step < 16; step += 1) {
    const mid = (lo + hi) / 2;
    if (holds(mid)) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.ceil(hi * 100) / 100);
}

/** Luminance percentiles of an RGBA pixel buffer (a downscaled frame). */
export function sampleLuminance(pixels: ArrayLike<number>): MediaSample {
  const values: number[] = [];
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 16) continue;
    values.push(relativeLuminance([pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255]));
  }
  if (values.length === 0) return { dark: 0, light: 1 };
  values.sort((a, b) => a - b);
  const at = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))]!;
  return { dark: at(0.05), light: at(0.95) };
}

const ALIGN_POSITION: Record<BackgroundAlignment, string> = {
  center: 'center',
  top: 'center top',
  bottom: 'center bottom',
  left: 'left center',
  right: 'right center',
  topLeft: 'left top',
  topRight: 'right top',
  bottomLeft: 'left bottom',
  bottomRight: 'right bottom',
};

export function objectPositionOf(alignment: BackgroundAlignment): string {
  return ALIGN_POSITION[alignment];
}

/**
 * Turning an installed appearance pack into the app's state.
 *
 * Applying a pack is two writes the user could also make by hand: the pack's
 * colors become the selected skin (`source: 'pack'`), and its backgrounds
 * become the background prefs, one slot per theme. After that the pack is
 * just prefs: dialing the opacity afterwards is an ordinary edit, and
 * "Remove background" or picking another skin undoes exactly its half.
 *
 * Pack media stays on the server. Its refs carry `pack:<id>/<file>` ids, and
 * the backdrop fetches them through the pack file route.
 */

import {
  backgroundMediaTypeOf,
  type AppearancePack,
  type PackBackground,
  type SkinFile,
} from '@kiki/protocol';

import { normalizeLook, type BackgroundMediaRef, type BackgroundPrefs, type BackgroundSlot } from './background';

export const PACK_MEDIA_PREFIX = 'pack:';

export function packMediaId(packId: string, file: string): string {
  return `${PACK_MEDIA_PREFIX}${packId}/${file}`;
}

/** `pack:<id>/<file>` → its parts, or null for a local media id. */
export function parsePackMediaId(id: string): { packId: string; file: string } | null {
  if (!id.startsWith(PACK_MEDIA_PREFIX)) return null;
  const rest = id.slice(PACK_MEDIA_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash <= 0 ? null : { packId: rest.slice(0, slash), file: rest.slice(slash + 1) };
}

function refOf(packId: string, file: string): BackgroundMediaRef | null {
  const type = backgroundMediaTypeOf(file);
  return type === null ? null : { id: packMediaId(packId, file), kind: type.kind, mime: type.mime, name: file, bytes: 0 };
}

function slotOf(packId: string, background: PackBackground | undefined): BackgroundSlot | null {
  if (background === undefined) return null;
  const { media, poster, interval, shuffle: _shuffle, ...look } = background;
  const refs = media.map((file) => refOf(packId, file)).filter((ref): ref is BackgroundMediaRef => ref !== null);
  if (refs.length === 0) return null;
  return {
    media: refs,
    poster: poster === undefined ? undefined : refOf(packId, poster) ?? undefined,
    interval: interval ?? 0,
    look: normalizeLook(look),
    packId,
  };
}

/** The background half of a pack. */
export function packBackgroundPrefs(pack: AppearancePack): Omit<BackgroundPrefs, 'assist'> {
  const light = slotOf(pack.id, pack.variants.light?.background);
  const dark = slotOf(pack.id, pack.variants.dark?.background);
  // A pack with one background uses it in both themes, like a linked slot.
  if (light === null || dark === null) return { light: light ?? dark, dark: null, linked: true };
  return { light, dark, linked: false };
}

/** The color half of a pack, as a skin; null when the pack sets no tokens. */
export function packSkinOf(pack: AppearancePack): SkinFile | null {
  const variant = (key: 'light' | 'dark') => {
    const source = pack.variants[key];
    if (source === undefined) return undefined;
    const { background: _background, ...tokens } = source;
    return tokens.colors === undefined && tokens.fonts === undefined && tokens.shape === undefined ? undefined : tokens;
  };
  const light = variant('light');
  const dark = variant('dark');
  if (light === undefined && dark === undefined) return null;
  return {
    kind: 'kiki-skin',
    version: 1,
    id: pack.id,
    name: pack.name,
    description: pack.description,
    author: pack.author,
    variants: { light, dark },
  };
}

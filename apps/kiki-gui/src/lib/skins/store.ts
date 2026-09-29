/**
 * Skin selection state: which skin is active, the user's per-token tweaks, and
 * any user skin files fetched from the connected server.
 *
 * Where a skin comes from depends on the host, and the two cases are genuinely
 * different:
 *
 *   - Built-in skins ship in the bundle and work on every host, offline, with
 *     no server. They are the only skins a browser tab has before it connects.
 *   - User skin files live in `<KIKI_HOME>/themes/` on the machine that runs
 *     kap-server, and arrive over the read-only REST surface. For a desktop
 *     install that directory is the user's own; for a browser pointed at a
 *     remote server it is the *server operator's* directory. That is the
 *     honest model — the browser has no filesystem — and the settings UI says
 *     which server the list came from.
 *
 * A selection is stored as `{ source, id }` so a user skin that disappears
 * (server offline, file deleted) degrades to the base palette instead of
 * silently resolving to a different skin with the same name.
 */

import { parseSkinFile, type SkinFile } from '@kiki/protocol';

import type { SkinTweaks } from './apply';
import { DEFAULT_SKIN_ID, RETIRED_BUILTIN_SKIN_IDS, findBuiltinSkin } from './builtin';
import { spaceStorage } from '../spaceStorage';

/**
 * `user` covers everything the server's `/skins` route lists: skin files in
 * the themes folder and themes contributed by enabled plugins (id
 * `<plugin>:<theme>`). `pack` is the colors of an installed appearance pack.
 */
export type SkinSource = 'builtin' | 'user' | 'pack';

/** Ids a selection may carry: a file stem, or a plugin skin's `<plugin>:<theme>`. */
const SELECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$|^[a-z0-9][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkinSelection {
  readonly source: SkinSource;
  readonly id: string;
}

export interface SkinPrefs {
  readonly selection: SkinSelection;
  readonly tweaks: SkinTweaks;
}

export const DEFAULT_SKIN_PREFS: SkinPrefs = {
  selection: { source: 'builtin', id: DEFAULT_SKIN_ID },
  tweaks: {},
};

const STORAGE_KEY = 'kiki.skin';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONT_STACK = /^[\p{L}\p{N}\u4e00-\u9fff '",\-_. ]{1,200}$/u;

/** Re-validate stored prefs: localStorage is user-writable and survives downgrades. */
export function normalizeSkinPrefs(raw: unknown): SkinPrefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SKIN_PREFS;
  const source = raw as { selection?: unknown; tweaks?: unknown };
  const rawSelection = source.selection as { source?: unknown; id?: unknown } | undefined;
  const selection: SkinSelection =
    typeof rawSelection?.id === 'string'
    && SELECTION_ID.test(rawSelection.id)
    && (rawSelection.source === 'builtin' || rawSelection.source === 'user' || rawSelection.source === 'pack')
      ? { source: rawSelection.source, id: rawSelection.id }
      : DEFAULT_SKIN_PREFS.selection;

  const rawTweaks = (source.tweaks ?? {}) as Record<string, unknown>;
  const tweaks: SkinTweaks = {
    ...(typeof rawTweaks['accent'] === 'string' && HEX.test(rawTweaks['accent'])
      ? { accent: rawTweaks['accent'] }
      : {}),
    ...(typeof rawTweaks['fontSans'] === 'string' && FONT_STACK.test(rawTweaks['fontSans'])
      ? { fontSans: rawTweaks['fontSans'] }
      : {}),
    ...(typeof rawTweaks['fontMono'] === 'string' && FONT_STACK.test(rawTweaks['fontMono'])
      ? { fontMono: rawTweaks['fontMono'] }
      : {}),
    ...(typeof rawTweaks['radius'] === 'number'
    && rawTweaks['radius'] >= 0
    && rawTweaks['radius'] <= 28
      ? { radius: rawTweaks['radius'] }
      : {}),
    ...(typeof rawTweaks['spacing'] === 'number'
    && rawTweaks['spacing'] >= 0.19
    && rawTweaks['spacing'] <= 0.33
      ? { spacing: rawTweaks['spacing'] }
      : {}),
  };

  return { selection: migrateSelection(selection), tweaks };
}

/**
 * A built-in that was retired (Sand, Slate) becomes the default. The user's
 * tweaks are kept: they chose an accent or a radius, not the retired palette.
 */
function migrateSelection(selection: SkinSelection): SkinSelection {
  return selection.source === 'builtin' && RETIRED_BUILTIN_SKIN_IDS.has(selection.id)
    ? DEFAULT_SKIN_PREFS.selection
    : selection;
}

export function readSkinPrefs(): SkinPrefs {
  try {
    const raw = spaceStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SKIN_PREFS : normalizeSkinPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_SKIN_PREFS;
  }
}

// Pub/sub so the settings editor's live preview, the document sync loop, and
// any other reader move together without prop drilling through the app.
const listeners = new Set<() => void>();
let snapshotCache: SkinPrefs | undefined;

export function subscribeSkinPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The *stored* prefs. Identity is stable across reads and only changes when
 * the stored value actually changes — `useSyncExternalStore` compares by
 * identity, so handing back a fresh object per read is an infinite render
 * loop. The transient preview deliberately does NOT move this snapshot.
 */
export function skinPrefsSnapshot(): SkinPrefs {
  snapshotCache ??= readSkinPrefs();
  return snapshotCache;
}

/** Stable snapshot for SSR/first render — never a fresh object per read. */
export function skinPrefsServerSnapshot(): SkinPrefs {
  return DEFAULT_SKIN_PREFS;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Replace the stored snapshot only when it differs, then notify. */
function publishStored(next: SkinPrefs): void {
  if (JSON.stringify(next) === JSON.stringify(snapshotCache)) {
    notify();
    return;
  }
  snapshotCache = next;
  notify();
}

export function writeSkinPrefs(patch: Partial<SkinPrefs>): void {
  const next = normalizeSkinPrefs({ ...skinPrefsSnapshot(), ...patch });
  try {
    spaceStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience; the in-memory selection still applies.
  }
  publishStored(next);
}

/**
 * Unsaved preview state. The settings editor writes here on every keystroke so
 * the whole app repaints live, and either commits it to storage or drops it.
 * Kept out of localStorage on purpose: a half-finished tweak must not survive
 * a reload, or a user who dislikes their own experiment cannot escape it.
 */
let preview: SkinPrefs | null = null;

export function setSkinPreview(next: SkinPrefs | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(preview);
  preview = next;
  // Only the document-level sync cares; the stored snapshot stays put so a
  // preview does not re-render (and re-trigger) the editor that set it.
  if (changed) notify();
}

export function skinPreview(): SkinPrefs | null {
  return preview;
}

/** What the document should currently show: the preview if any, else storage. */
export function effectiveSkinPrefs(): SkinPrefs {
  return preview ?? skinPrefsSnapshot();
}

// ---------------------------------------------------------------------------
// User skin catalog, populated from the server's read-only themes REST.
// ---------------------------------------------------------------------------

/**
 * Last-known copy of the *selected* user skin, kept in localStorage.
 *
 * Without it, a user skin cannot paint until the catalog request comes back,
 * so every reload flashes the default palette first — exactly the flash the
 * pre-paint theme script in index.html exists to prevent. The cache is a
 * render aid only: the file on disk stays authoritative, and a fetch that
 * returns something different immediately replaces it.
 */
const SELECTED_CACHE_KEY = 'kiki.skin.cache';

function readSelectedCache(): SkinFile | null {
  try {
    const raw = spaceStorage.getItem(SELECTED_CACHE_KEY);
    if (raw === null) return null;
    const parsed = parseSkinFile(JSON.parse(raw));
    return parsed.skin;
  } catch {
    return null;
  }
}

function writeSelectedCache(skin: SkinFile | null): void {
  try {
    if (skin === null) spaceStorage.removeItem(SELECTED_CACHE_KEY);
    else spaceStorage.setItem(SELECTED_CACHE_KEY, JSON.stringify(skin));
  } catch {
    // Cache is optional; the catalog fetch still applies the skin.
  }
}

let userSkins: readonly SkinFile[] = [];
let userSkinsDirectory: string | null = null;
let selectedCache: SkinFile | null = null;
let selectedCacheLoaded = false;

export function setUserSkins(skins: readonly SkinFile[], directory: string | null): void {
  // Notify only on a real change: the catalog query re-runs on focus and
  // refetch, and re-publishing an identical list would churn every subscriber.
  const changed =
    directory !== userSkinsDirectory
    || JSON.stringify(skins) !== JSON.stringify(userSkins);
  userSkins = skins;
  userSkinsDirectory = directory;

  // Refresh the paint cache from what the server actually serves. A selected
  // skin that is gone clears the cache, so the next reload shows it missing
  // instead of resurrecting a deleted file forever.
  const selection = effectiveSkinPrefs().selection;
  if (selection.source === 'user') {
    const live = skins.find((skin) => skin.id === selection.id) ?? null;
    selectedCache = live;
    selectedCacheLoaded = true;
    writeSelectedCache(live);
  }
  if (changed) notify();
}

export function getUserSkins(): readonly SkinFile[] {
  return userSkins;
}

export function getUserSkinsDirectory(): string | null {
  return userSkinsDirectory;
}

/**
 * Colors of installed appearance packs, as skins. A pack selection is applied
 * by the pack controller, which also sets the pack's background; this list
 * only lets the palette resolve on the first frame and after a theme flip.
 */
let packSkins: readonly SkinFile[] = readPackSkinCache();
const PACK_SKIN_CACHE_KEY = 'kiki.skin.packCache';

function readPackSkinCache(): readonly SkinFile[] {
  try {
    const raw = spaceStorage.getItem(PACK_SKIN_CACHE_KEY);
    if (raw === null) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list)
      ? list.map((entry) => parseSkinFile(entry).skin).filter((skin): skin is SkinFile => skin !== null)
      : [];
  } catch {
    return [];
  }
}

export function setPackSkins(skins: readonly SkinFile[]): void {
  if (JSON.stringify(skins) === JSON.stringify(packSkins)) return;
  packSkins = skins;
  try {
    spaceStorage.setItem(PACK_SKIN_CACHE_KEY, JSON.stringify(skins));
  } catch {
    // Cache is optional.
  }
  notify();
}

/** Drop the cached copy of the selected user skin (test teardown). */
export function clearSelectedSkinCache(): void {
  selectedCache = null;
  selectedCacheLoaded = false;
  writeSelectedCache(null);
}

/**
 * Resolve a selection to a skin.
 *
 * For a user skin the catalog is preferred, and the localStorage cache is the
 * fallback that makes the first frame after a reload correct. A selection with
 * neither returns null — a missing file must look missing, never get silently
 * substituted by a same-named built-in.
 */
export function resolveSkin(selection: SkinSelection): SkinFile | null {
  if (selection.source === 'builtin') return findBuiltinSkin(selection.id) ?? null;
  if (selection.source === 'pack') return packSkins.find((skin) => skin.id === selection.id) ?? null;
  const live = userSkins.find((skin) => skin.id === selection.id);
  if (live !== undefined) return live;
  if (!selectedCacheLoaded) {
    selectedCache = readSelectedCache();
    selectedCacheLoaded = true;
  }
  return selectedCache?.id === selection.id ? selectedCache : null;
}

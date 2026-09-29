/**
 * Per-space `localStorage` namespacing for the desktop app (multi-home
 * isolation design §6.4).
 *
 * Desktop "switch" mode shows every space in one window, so all spaces share a
 * WebView data directory — and therefore one `localStorage`. Keys that point at
 * a space's own data (drafts, last session, skin, usage filters, …) are
 * rewritten to `kiki.space.<homeId>.<key>`; the main space keeps the original
 * key names, so an existing user's storage does not move, and CLI / browser
 * hosts never configure a space at all.
 *
 * This module is the mechanism only: it stays framework-free so session-core
 * modules can use it, and it is inert until someone configures a space. The
 * desktop boot contract that supplies the active space and the inventory of
 * namespaced keys live in `apps/kiki-gui/src/lib/spaceStorage.ts`.
 */

/** The space the wrapper resolves keys against. */
export interface ActiveSpace {
  readonly homeId: string;
  /** Display name, carried so callers can label the space without a second lookup. */
  readonly name?: string;
  readonly color?: string;
  /** The main space keeps the original key names. */
  readonly isPrimary?: boolean;
}

/** Prefix of a namespaced key: `kiki.space.<homeId>.` + the original key. */
export const SPACE_STORAGE_PREFIX = 'kiki.space.';

let active: ActiveSpace | null = null;

/**
 * Point the wrapper at `space`. `null`, an empty `homeId`, and the main space
 * (`isPrimary`) all restore the original key names; anything else namespaces
 * every key this module hands out.
 */
export function configureSpaceStorage(space: ActiveSpace | null): void {
  active = space !== null && space.homeId !== '' && space.isPrimary !== true ? space : null;
}

/** The configured space, or `null` while the main space (or a non-desktop host) is active. */
export function activeSpace(): ActiveSpace | null {
  return active;
}

/** The storage key `key` maps to for the active space. */
export function spaceStorageKey(key: string): string {
  return active === null ? key : `${SPACE_STORAGE_PREFIX}${active.homeId}.${key}`;
}

/** The storage operations a namespaced key needs. */
export interface SpaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` as the active space sees it — the drop-in for namespaced keys. */
export const spaceStorage: SpaceStorage = {
  getItem: (key) => localStorage.getItem(spaceStorageKey(key)),
  setItem: (key, value) => {
    localStorage.setItem(spaceStorageKey(key), value);
  },
  removeItem: (key) => {
    localStorage.removeItem(spaceStorageKey(key));
  },
};

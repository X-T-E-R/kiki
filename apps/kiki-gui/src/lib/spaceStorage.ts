/**
 * Desktop space-namespaced storage (multi-home isolation design §6.4).
 *
 * Desktop "switch" mode keeps one desktop process and one window for every
 * space, so all spaces share a WebView data directory — and therefore one
 * `localStorage`. Keys that point at a space's own data are rewritten by
 * `spaceStorage` to `kiki.space.<homeId>.<key>`; the main space keeps the
 * original key names, so an existing user's storage does not move, and CLI /
 * browser hosts never configure a space at all.
 *
 * The mechanism lives in `@kiki/session-core/storage` (session-core modules
 * use it and must not depend on the GUI). This module owns the desktop boot
 * contract that supplies the active space, plus the inventory of keys that are
 * namespaced, application-level, or neither.
 *
 * Boot contract — the desktop entry must resolve the space before any app
 * module reads a namespaced key, in one of two ways:
 *
 *   1. Expose the `desktop_active_space` command returning
 *      `{ homeId, name, color, isPrimary, path, ... }`; `initializeSpaceStorage`
 *      awaits it during boot, before the app graph loads.
 *   2. Or inject the same payload before the app bundle runs, e.g. a Tauri
 *      `initialization_script`:
 *      `window.__KIKI_ACTIVE_SPACE__ = { homeId, name, color, isPrimary }`.
 *
 * `initializeSpaceStorage(host)` reads (2) first and falls back to (1). An
 * absent payload, an unreadable one, and the main space all resolve to `null`,
 * which means "keep the original key names" — i.e. exactly the pre-space
 * behavior (CLI, `kiki web`, and desktop builds without space support). The
 * desktop entry names the main space `homeId: 'main'` (also accepted as an
 * explicit `isPrimary: true`); every other homeId is namespaced.
 */

import {
  configureSpaceStorage,
  activeSpace,
  type ActiveSpace,
} from '@kiki/session-core/storage';

export * from '@kiki/session-core/storage';

/** Global the desktop entry may write before the app bundle runs. */
export const ACTIVE_SPACE_BOOT_GLOBAL = '__KIKI_ACTIVE_SPACE__';

/** The desktop entry's homeId for the main space, which keeps the original
 *  key names. A subspace never carries this id. */
export const MAIN_SPACE_HOME_ID = 'main';

/** The part of the host adapter the space boot needs. */
export interface SpaceBootHost {
  readonly kind: 'browser' | 'tauri' | 'vscode';
  /** Raw active-space payload from the desktop entry; validated here. */
  readonly activeSpace?: () => Promise<unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Validate the active-space descriptor the desktop entry supplies (as an
 * object or its JSON text). Anything unrecognized — an older build, a
 * truncated payload — reads as `null`, the main space, so a broken hand-off
 * degrades to the pre-space key names instead of inventing a namespace.
 */
export function parseActiveSpacePayload(raw: unknown): ActiveSpace | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const homeId = stringField(record, 'homeId');
  if (homeId === undefined) return null;
  return {
    homeId,
    name: stringField(record, 'name'),
    color: stringField(record, 'color'),
    preset: stringField(record, 'preset'),
    isPrimary: record['isPrimary'] === true || homeId === MAIN_SPACE_HOME_ID ? true : undefined,
  };
}

/** The payload injected into this document before the app bundle ran, if any. */
export function injectedActiveSpace(): ActiveSpace | null {
  if (typeof window === 'undefined') return null;
  return parseActiveSpacePayload(
    (window as unknown as Record<string, unknown>)[ACTIVE_SPACE_BOOT_GLOBAL],
  );
}

/**
 * Resolve the active space and point `spaceStorage` at it. The app graph must
 * load only after this resolves: a module that reads a namespaced key at
 * module scope (e.g. the skin pack cache) would otherwise read it from the
 * main space's namespace.
 *
 * Returns the namespaced space, or `null` for the main space / a non-desktop
 * host. Never throws: a desktop build without the space command yet simply
 * keeps the original key names.
 */
export async function initializeSpaceStorage(
  host: SpaceBootHost | null,
): Promise<ActiveSpace | null> {
  const injected = injectedActiveSpace();
  if (injected !== null) {
    configureSpaceStorage(injected);
    return activeSpace();
  }
  if (host !== null && host.kind === 'tauri' && host.activeSpace !== undefined) {
    try {
      const fromHost = parseActiveSpacePayload(await host.activeSpace());
      if (fromHost !== null) {
        configureSpaceStorage(fromHost);
        return activeSpace();
      }
    } catch {
      // The desktop build has no `desktop_active_space` command yet.
    }
  }
  configureSpaceStorage(null);
  return null;
}

/**
 * The §6.4 inventory. `spaceStorage.test.ts` scans the sources
 * (`apps/kiki-gui/src` + `packages/session-core/src`) against these lists, so a
 * key that joins a shared namespace without being classified here, or a new
 * `localStorage` call outside the namespacing wrapper, fails a test instead of
 * silently leaking state across spaces.
 */

/** Keys that point at the active space's own data. */
export const SPACE_SCOPED_STORAGE_KEYS = [
  'kiki.lastSessionId',
  'kiki.drafts',
  'kiki.composerStates',
  'kiki.newSessionDraft',
  'kiki.sessionSeen.v1',
  'kiki.annotationOverrides',
  'kiki.restartRequired',
  'kiki.onboarding',
  'kiki.skin',
  'kiki.skin.cache',
  'kiki.skin.packCache',
  'kiki.background',
  'kiki.usage.filters.v2',
  'kiki.nb_search.pinned_lanes',
  'kiki.sidebar.workspaceGroups',
  'kiki.timelineView',
] as const;

/** Key families whose suffix varies per workspace (`kiki.draft.new.<scopeId>`). */
export const SPACE_SCOPED_KEY_PREFIXES = ['kiki.draft.new.'] as const;

/** Application-level preferences that stay shared across spaces. */
export const GLOBAL_STORAGE_KEYS = [
  'kiki.locale',
  'kiki.settings',
  'kiki.layout',
  'kiki.desktopPrefs',
  'kiki.previewPanelWidth',
  'kiki.terminalPanel.v1',
  // Device-level rail mode (standard / cockpit); not in §6.4 because it selects UI, not
  // a space's data. Classified here so the scan stays exhaustive.
  'kiki.railMode',
  // Device-level settings-list layout (sort / density / folded groups). It
  // selects UI over generic buckets, never a space's own ids, so it stays
  // shared across spaces (`components/settings/list/listState.ts`).
  'kiki.settingsLists',
] as const;

/** `kiki.*` names that are deliberately neither of the above. */
export const EXCLUDED_STORAGE_KEYS = [
  // Desktop connections never persist (`persist: false`), so this key only ever
  // holds a browser direct-connect choice; the desktop token stays in memory.
  'kiki.connection',
] as const;

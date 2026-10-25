/**
 * Per-window work mode, and the view route that belongs to it.
 *
 * A mode ("work preset") is the working surface of THIS window: which task
 * starters it offers and what a new session here suggests. It is not a data
 * boundary — spaces own data — and it is not a session binding: a session
 * keeps the profile it was created with whichever window shows it.
 *
 * Two windows on one home can be in different modes at the same time, so
 * nothing here is keyed by home alone. Drafts, sessions and settings keep
 * their existing storage contracts; only the window's own view and its mode
 * preference are new. The mode is written through `spaceStorage` so it is
 * per home, but it lives under its own key — a space switch must not drag the
 * mode with it, and a second window must not inherit this one's mode.
 */

import { spaceStorage } from './spaceStorage';

const WINDOW_MODE_KEY = 'kiki.windowMode';
const WINDOW_ID_KEY = 'kiki.windowId';

export type WorkModeId = string;

/** The baseline mode, always available and never removable. */
export const BASE_MODE_ID = 'kiki';
export const WORK_MODE_ID = 'work';

const MODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const listeners = new Set<() => void>();

let homeId = 'main';
let windowId: string | undefined;

function mintWindowId(): string {
  const minted = `w-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  try {
    sessionStorage.setItem(WINDOW_ID_KEY, minted);
  } catch {
    // Without session storage the id lives as long as the document does.
  }
  return minted;
}

/**
 * This window's id, minted once per window. Native shells supply their own
 * (see `adoptWindowId`); a browser tab uses its session storage, so a reload
 * of the same tab keeps the same mode while a second tab gets its own.
 */
export function windowIdOf(): string {
  windowId ??= (() => {
    try {
      const stored = sessionStorage.getItem(WINDOW_ID_KEY);
      if (stored !== null && stored !== '' && MODE_ID_PATTERN.test(stored)) return stored;
    } catch {
      // Private mode: fall through to a minted id.
    }
    return mintWindowId();
  })();
  return windowId;
}

/** Adopts the id the native shell assigned, so both agree on this window. */
export function adoptWindowId(native: string | undefined): void {
  if (native === undefined || native === '' || !MODE_ID_PATTERN.test(native)) return;
  windowId = native;
  try {
    sessionStorage.setItem(WINDOW_ID_KEY, native);
  } catch {
    // The in-memory id already separates this window from its siblings.
  }
}

/** Point mode reads and writes at a home. Called when the space resolves. */
export function configureWorkModes(next: { readonly homeId: string }): void {
  if (homeId === next.homeId) return;
  homeId = next.homeId;
  for (const listener of listeners) listener();
}

export function workModeHomeId(): string {
  return homeId;
}

/** This window's slot for a home's modes: home and window together. */
function modeSlot(): string {
  return `${homeId}::${windowIdOf()}`;
}

function readModeTable(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(spaceStorage.getItem(WINDOW_MODE_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Storage may be disabled, full, or written by an older build.
  }
  return {};
}

/**
 * The mode this window opens in. Only this window's own slot is read: another
 * window on this home being in Work says nothing about this one, and a mode the
 * server no longer offers is resolved by the caller, not here.
 *
 * `spaceStorage` already namespaces the key by home, so the stored table is
 * this home's alone; the window dimension lives inside it. A value written
 * before windows were separated sat at the bare home id in that table, and is
 * read only by a window that has never written its own — so an upgrade does
 * not strand an existing choice while a window that HAS chosen never falls
 * back to another window's value.
 */
export function readWindowModeId(): WorkModeId {
  const table = readModeTable();
  const slot = modeSlot();
  if (Object.hasOwn(table, slot)) {
    const own = table[slot];
    if (typeof own === 'string' && MODE_ID_PATTERN.test(own)) return own;
  }
  // The legacy entry is this home's bare id, inside this home's own table.
  const legacy = Object.hasOwn(table, homeId) ? table[homeId] : undefined;
  return typeof legacy === 'string' && MODE_ID_PATTERN.test(legacy) ? legacy : BASE_MODE_ID;
}

/** Switch this window's mode. No server call, and no effect on any session. */
export function writeWindowModeId(next: WorkModeId): void {
  if (!MODE_ID_PATTERN.test(next)) return;
  const table = readModeTable();
  table[modeSlot()] = next;
  try {
    spaceStorage.setItem(WINDOW_MODE_KEY, JSON.stringify(table));
  } catch {
    // A window that cannot persist still switches for this run.
  }
  for (const listener of listeners) listener();
}

/** Same-window changes plus other windows in this profile writing the key. */
export function subscribeWorkMode(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === WINDOW_ID_KEY) return;
    if (event.key === WINDOW_MODE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The view-route slot for this window: its scope plus the window itself. */
export function windowRouteSlot(scopeId: string): string {
  return `${scopeId}::${windowIdOf()}`;
}

/**
 * Settings-IA experiment switch (task-0033 settings-experiment line).
 *
 * Two candidate navigations live next to the shipped one and are compared in
 * the isolated worktree; nothing here changes the default experience. The
 * mode arrives once as `?ia=taskflow|objects|off` on any settings URL and is
 * then held in localStorage, because in-settings navigation deliberately
 * carries no query. `off` (or never opting in) renders the shipped tree and
 * hides the picker, so an untouched install shows no experiment chrome.
 *
 * Modes: `taskflow` regroups the 27 leaves into task-semantic groups;
 * `objects` additionally folds Request identity into the AI page as a fourth
 * tab (the one scheme-B merge with independent value).
 */

export const SETTINGS_IA_MODES = ['taskflow', 'objects'] as const;
export type SettingsIaMode = (typeof SETTINGS_IA_MODES)[number];

const MODE_STORAGE_KEY = 'kiki.settingsIaPrototype';

export function isSettingsIaMode(value: unknown): value is SettingsIaMode {
  return value === 'taskflow' || value === 'objects';
}

export function readIaPrototypeMode(storage: Pick<Storage, 'getItem'> = localStorage): SettingsIaMode | null {
  try {
    const raw = storage.getItem(MODE_STORAGE_KEY);
    return isSettingsIaMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Same-window pub/sub, mirroring the settings store: `storage` events do not fire on the writing document. */
const listeners = new Set<() => void>();
let snapshotCache: SettingsIaMode | null | undefined;

function publish(next: SettingsIaMode | null): void {
  snapshotCache = next;
  for (const listener of listeners) listener();
}

export function writeIaPrototypeMode(mode: SettingsIaMode | null): void {
  try {
    if (mode === null) localStorage.removeItem(MODE_STORAGE_KEY);
    else localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // The in-memory snapshot still carries the mode for this visit.
  }
  publish(mode);
}

export function subscribeIaPrototypeMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function iaPrototypeModeSnapshot(): SettingsIaMode | null {
  if (snapshotCache === undefined) snapshotCache = readIaPrototypeMode();
  return snapshotCache;
}

/**
 * Apply the `?ia=` switch from a settings URL, if it carries one. Returns the
 * mode the URL asked for, `'off'` for an explicit opt-out, or null when the
 * parameter is absent (the stored mode then stands).
 */
export function captureIaPrototypeFromSearch(search: string): SettingsIaMode | 'off' | null {
  const raw = new URLSearchParams(search).get('ia');
  if (raw === null) return null;
  if (isSettingsIaMode(raw)) {
    writeIaPrototypeMode(raw);
    return raw;
  }
  writeIaPrototypeMode(null);
  return 'off';
}

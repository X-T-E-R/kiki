/**
 * Client-local settings stored in localStorage (`kiki.settings`).
 *
 * These values apply when a session has no server binding, and for desktop-only
 * behaviours (notifications, close-to-tray). Server-writable config lives on
 * the kap-server and is read via `/config`; the GUI mirrors those values but
 * falls back to this store when the endpoint is unavailable or read-only.
 */

export type SendShortcut = 'enter' | 'cmd-enter';

export interface DesktopSettings {
  /** Default permission mode for new sessions / the /new draft. */
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  /** Default plan mode for new sessions / the /new draft. */
  defaultPlanMode: boolean;
  /** Send shortcut for the composer textarea. */
  sendShortcut: SendShortcut;
  /** Whether drafts are persisted to localStorage. */
  draftPersistence: boolean;
  /** Default model alias for new sessions (overrides server default if set). */
  defaultModel: string | undefined;
  /** Default thinking effort for the default model. */
  defaultEffort: string | undefined;
  /** Desktop-only: show OS notifications for approval requests. */
  desktopNotifications: boolean;
  /** Desktop-only: close hides to tray instead of quitting. */
  closeToTray: boolean;
}

const STORAGE_KEY = 'kiki.settings';
const LAST_SESSION_KEY = 'kiki.lastSessionId';

export interface DesktopNativePrefs {
  notifications: boolean;
  closeToTray: boolean;
}

const DEFAULTS: DesktopSettings = {
  defaultPermissionMode: 'manual',
  defaultPlanMode: false,
  sendShortcut: 'enter',
  draftPersistence: true,
  defaultModel: undefined,
  defaultEffort: undefined,
  desktopNotifications: true,
  closeToTray: true,
};

const DESKTOP_PREFS_KEY = 'kiki.desktopPrefs';
const DESKTOP_PREFS_DEFAULTS: DesktopNativePrefs = {
  notifications: true,
  closeToTray: true,
};

function readAll(): Partial<DesktopSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<DesktopSettings>) : {};
  } catch {
    return {};
  }
}

export function readSettings(): DesktopSettings {
  const stored = readAll();
  return {
    ...DEFAULTS,
    ...stored,
    closeToTray:
      typeof stored.closeToTray === 'boolean' ? stored.closeToTray : DEFAULTS.closeToTray,
  };
}

export function writeSettings(patch: Partial<DesktopSettings>): void {
  const next = { ...readAll(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full — settings are a convenience, not a guarantee
  }
}

export function readLastSessionId(): string | undefined {
  try {
    const value = localStorage.getItem(LAST_SESSION_KEY);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLastSessionId(sessionId: string | undefined): void {
  try {
    if (sessionId === undefined) {
      localStorage.removeItem(LAST_SESSION_KEY);
    } else {
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
    }
  } catch {
    // ignore
  }
}

export function readDesktopPrefs(): DesktopNativePrefs {
  try {
    const raw = localStorage.getItem(DESKTOP_PREFS_KEY);
    if (raw === null) return DESKTOP_PREFS_DEFAULTS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const stored = parsed as Partial<DesktopNativePrefs>;
      return {
        notifications:
          typeof stored.notifications === 'boolean'
            ? stored.notifications
            : DESKTOP_PREFS_DEFAULTS.notifications,
        closeToTray:
          typeof stored.closeToTray === 'boolean'
            ? stored.closeToTray
            : DESKTOP_PREFS_DEFAULTS.closeToTray,
      };
    }
  } catch {
    // ignore
  }
  return DESKTOP_PREFS_DEFAULTS;
}

export function writeDesktopPrefs(prefs: Partial<DesktopNativePrefs>): void {
  const next = { ...readDesktopPrefs(), ...prefs };
  try {
    localStorage.setItem(DESKTOP_PREFS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

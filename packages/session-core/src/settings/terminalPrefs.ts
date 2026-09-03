/**
 * Per-session terminal-panel prefs in localStorage (`kiki.terminalPanel.v1`):
 * whether the bottom panel is open and its pixel height. Values are clamped
 * to sane bounds on read so a stale or hand-edited store can never wedge the
 * layout; entries for long-gone sessions are pruned on write.
 */

const KEY = 'kiki.terminalPanel.v1';
const MAX_ENTRIES = 50;

export const TERMINAL_PANEL_MIN_HEIGHT = 140;
export const TERMINAL_PANEL_MAX_HEIGHT = 720;
export const TERMINAL_PANEL_DEFAULT_HEIGHT = 260;

export interface TerminalPanelPrefs {
  readonly open: boolean;
  readonly height: number;
}

export const DEFAULT_TERMINAL_PANEL_PREFS: TerminalPanelPrefs = {
  open: false,
  height: TERMINAL_PANEL_DEFAULT_HEIGHT,
};

export function clampTerminalPanelHeight(height: number): number {
  if (!Number.isFinite(height)) return TERMINAL_PANEL_DEFAULT_HEIGHT;
  return Math.min(
    TERMINAL_PANEL_MAX_HEIGHT,
    Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.round(height)),
  );
}

function readAll(): Record<string, TerminalPanelPrefs> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, TerminalPanelPrefs> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as { open?: unknown; height?: unknown };
      out[sessionId] = {
        open: entry.open === true,
        height: clampTerminalPanelHeight(
          typeof entry.height === 'number' ? entry.height : Number.NaN,
        ),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function readTerminalPanelPrefs(sessionId: string): TerminalPanelPrefs {
  return readAll()[sessionId] ?? DEFAULT_TERMINAL_PANEL_PREFS;
}

export function writeTerminalPanelPrefs(
  sessionId: string,
  prefs: Partial<TerminalPanelPrefs>,
): void {
  const all = readAll();
  const current = all[sessionId] ?? DEFAULT_TERMINAL_PANEL_PREFS;
  all[sessionId] = {
    open: prefs.open ?? current.open,
    height: clampTerminalPanelHeight(prefs.height ?? current.height),
  };
  // Prune the oldest entries (Map order = insertion order) so the store
  // cannot grow without bound across many sessions.
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete all[stale];
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — panel prefs are a convenience
  }
}

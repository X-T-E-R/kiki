/**
 * Adopting the work mode this window was launched in.
 *
 * A native window opened with `--preset work` must be in Work from its first
 * frame, and a second window on the same home must not inherit the first
 * window's mode. Both are decided here, before the boot reads or writes any
 * route, because the mode is part of which window slot the route belongs to.
 *
 * Native owns the window's identity: `desktop_window_mode` returns both the
 * requested preset and the id native minted for this window, and this adopts
 * them. A host without the command, a browser tab, and a window the user
 * simply relaunched all fall through to the window's own stored mode, which is
 * the ordinary case.
 *
 * `?preset=work` is the browser equivalent and takes the same path.
 */

import type { HostAdapter } from '../host';
import { adoptWindowId, configureWorkModes, writeWindowModeId, WORK_MODE_ID } from './workModes';

const PRESET_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Applies the launch mode for this window. Never throws: a window that cannot
 * learn its mode opens in its stored one rather than refusing to start.
 */
export async function adoptWindowModeFromHost(host: HostAdapter, homeId: string): Promise<void> {
  configureWorkModes({ homeId });

  if (host.kind !== 'tauri' || host.windowMode === undefined) {
    applyBrowserPreset();
    return;
  }

  let mode: { presetId: string; windowId: string } | null = null;
  try {
    mode = await host.windowMode();
  } catch {
    mode = null;
  }
  if (mode === null) {
    applyBrowserPreset();
    return;
  }

  adoptWindowId(mode.windowId);
  if (PRESET_PATTERN.test(mode.presetId)) writeWindowModeId(mode.presetId);
}

/** `?preset=work` for a browser or a web view with no native descriptor. */
function applyBrowserPreset(): void {
  if (typeof window === 'undefined') return;
  const preset = new URLSearchParams(window.location.search).get('preset');
  if (preset !== null && PRESET_PATTERN.test(preset)) writeWindowModeId(preset);
}

/** The route a freshly launched mode window opens on. */
export function landingRouteFor(modeId: string): string {
  return modeId === WORK_MODE_ID ? '/work' : '/new';
}

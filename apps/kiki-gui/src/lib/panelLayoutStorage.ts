/**
 * Bridges `react-resizable-panels` persistence to Kiki's existing
 * `kiki.layout` preferences (`@kiki/session-core/settings`) so saved widths
 * remain compatible with SettingsTransfer and pre-existing user profiles.
 */

import type { LayoutStorage } from 'react-resizable-panels';
import {
  readLayoutPreferences,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeLayoutPreferences,
} from '@kiki/session-core/settings';

const PANEL_STORAGE_PREFIX = 'kiki.panels.';

export function createKikiPanelLayoutStorage(): LayoutStorage {
  return {
    getItem(key: string): string | null {
      try {
        return localStorage.getItem(`${PANEL_STORAGE_PREFIX}${key}`);
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        localStorage.setItem(`${PANEL_STORAGE_PREFIX}${key}`, value);
      } catch {
        // storage unavailable
      }
    },
  };
}

export function clampSidebarPanelWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return readLayoutPreferences().sidebarWidth;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(widthPx)));
}

export function persistSidebarPanelWidth(widthPx: number): void {
  const clamped = clampSidebarPanelWidth(widthPx);
  const current = readLayoutPreferences().sidebarWidth;
  if (clamped !== current) {
    writeLayoutPreferences({ sidebarWidth: clamped });
  }
}

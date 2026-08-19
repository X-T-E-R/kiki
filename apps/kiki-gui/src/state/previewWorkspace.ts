/**
 * Preview workspace tab state — the pure reducer behind the resident preview
 * panel. Tab identity IS the absolute host path (one tab per file); ordering
 * is user-controlled via drag reorder. Kept framework-free so tab semantics
 * (activate-on-reopen, neighbor activation on close, bounded reorder) are
 * unit-testable without a DOM.
 */

export interface PreviewTabsState {
  /** Open tab paths, in strip order. */
  readonly tabs: readonly string[];
  /** The focused tab; null only when no tabs are open. */
  readonly active: string | null;
}

export const EMPTY_PREVIEW_TABS: PreviewTabsState = { tabs: [], active: null };

/** Open a file: an existing tab just activates; a new path appends + activates. */
export function openPreviewTab(state: PreviewTabsState, path: string): PreviewTabsState {
  if (state.tabs.includes(path)) {
    return state.active === path ? state : { ...state, active: path };
  }
  return { tabs: [...state.tabs, path], active: path };
}

/** Activate an existing tab (unknown paths are ignored). */
export function activatePreviewTab(state: PreviewTabsState, path: string): PreviewTabsState {
  return state.tabs.includes(path) ? { ...state, active: path } : state;
}

/**
 * Close one tab. Closing the active tab hands focus to the right neighbor,
 * falling back to the left one (editor-tab convention).
 */
export function closePreviewTab(state: PreviewTabsState, path: string): PreviewTabsState {
  const index = state.tabs.indexOf(path);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab !== path);
  if (state.active !== path) return { tabs, active: state.active };
  const active = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, active };
}

/** Close every tab except `path` (which must exist; no-op otherwise). */
export function closeOtherPreviewTabs(state: PreviewTabsState, path: string): PreviewTabsState {
  if (!state.tabs.includes(path)) return state;
  return { tabs: [path], active: path };
}

export function closeAllPreviewTabs(): PreviewTabsState {
  return EMPTY_PREVIEW_TABS;
}

/**
 * Drag reorder: move `path` to `targetIndex` (clamped). Dropping onto the tab's
 * own position or an unknown path is a no-op (returns the same object).
 */
export function movePreviewTab(
  state: PreviewTabsState,
  path: string,
  targetIndex: number,
): PreviewTabsState {
  const from = state.tabs.indexOf(path);
  if (from === -1) return state;
  const to = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
  if (to === from) return state;
  const tabs = [...state.tabs];
  tabs.splice(from, 1);
  tabs.splice(to, 0, path);
  return { ...state, tabs };
}

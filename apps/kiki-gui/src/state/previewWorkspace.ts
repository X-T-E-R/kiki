/**
 * Preview workspace tab state — the pure reducer behind the resident preview
 * panel. Tab identity is either a host file path or a panel descriptor; ordering
 * is user-controlled via drag reorder. Kept framework-free so tab semantics
 * (activate-on-reopen, neighbor activation on close, bounded reorder) are
 * unit-testable without a DOM.
 */

export interface FileTab {
  readonly kind: 'file';
  readonly path: string;
}

export interface PanelTab {
  readonly kind: 'panel';
  readonly agentId: string;
  readonly title?: string;
}

export type PreviewTab = FileTab | PanelTab;

export interface PreviewTabsState {
  /** Open tabs, in strip order. */
  readonly tabs: readonly PreviewTab[];
  /** The focused tab key; null only when no tabs are open. */
  readonly active: string | null;
}

export const EMPTY_PREVIEW_TABS: PreviewTabsState = { tabs: [], active: null };

export function previewTabKey(tab: PreviewTab | string): string {
  if (typeof tab === 'string') return tab;
  return tab.kind === 'file' ? tab.path : `panel:${tab.agentId}`;
}

export function normalizeTabInput(input: string | PreviewTab): PreviewTab {
  return typeof input === 'string' ? { kind: 'file', path: input } : input;
}

/** Open a file or panel: an existing tab just activates; a new one appends + activates. */
export function openPreviewTab(
  state: PreviewTabsState,
  input: string | PreviewTab,
): PreviewTabsState {
  const tab = normalizeTabInput(input);
  const key = previewTabKey(tab);
  const existingIndex = state.tabs.findIndex((t) => previewTabKey(t) === key);
  if (existingIndex !== -1) {
    if (tab.kind === 'panel' && tab.title && state.tabs[existingIndex]?.kind === 'panel') {
      const updated = [...state.tabs];
      updated[existingIndex] = tab;
      return { tabs: updated, active: key };
    }
    return state.active === key ? state : { ...state, active: key };
  }
  return { tabs: [...state.tabs, tab], active: key };
}

/** Activate an existing tab by key (unknown keys are ignored). */
export function activatePreviewTab(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab);
  return state.tabs.some((t) => previewTabKey(t) === key) ? { ...state, active: key } : state;
}

/**
 * Close one tab. Closing the active tab hands focus to the right neighbor,
 * falling back to the left one (editor-tab convention).
 */
export function closePreviewTab(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab);
  const index = state.tabs.findIndex((t) => previewTabKey(t) === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  if (state.active !== key) return { tabs, active: state.active };
  const nextTab = tabs[index] ?? tabs[index - 1] ?? null;
  const active = nextTab ? previewTabKey(nextTab) : null;
  return { tabs, active };
}

/** Close every tab except `key` (which must exist; no-op otherwise). */
export function closeOtherPreviewTabs(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab);
  const match = state.tabs.find((t) => previewTabKey(t) === key);
  if (!match) return state;
  return { tabs: [match], active: key };
}

export function closeAllPreviewTabs(): PreviewTabsState {
  return EMPTY_PREVIEW_TABS;
}

/**
 * Drag reorder: move tab matching `key` to `targetIndex` (clamped). Dropping onto the tab's
 * own position or an unknown key is a no-op (returns the same object).
 */
export function movePreviewTab(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
  targetIndex: number,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab);
  const from = state.tabs.findIndex((t) => previewTabKey(t) === key);
  if (from === -1) return state;
  const to = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
  if (to === from) return state;
  const tabs = [...state.tabs];
  const [removed] = tabs.splice(from, 1);
  if (removed === undefined) return state;
  tabs.splice(to, 0, removed);
  return { ...state, tabs };
}

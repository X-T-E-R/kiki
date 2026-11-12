/**
 * Preview workspace tab state — the pure reducer behind the resident preview
 * panel. Tab kinds are `resource` (host files and session copies), `web`
 * (external URLs), `panel` (agent workspaces), and `skill` (built-in skills);
 * ordering is user-controlled via drag reorder. Kept framework-free so tab
 * semantics (activate-on-reopen, neighbor activation on close, bounded reorder)
 * are unit-testable without a DOM.
 */

import { basenameOf, resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';

import {
  classifyResource,
  normalizeHostFilePath,
  previewResourceKey,
  type PreviewResource,
} from './previewResource';

export interface ResourceTab {
  readonly kind: 'resource';
  readonly resource: PreviewResource;
  /** Optional size hint for session copies before bytes are read. */
  readonly size?: number;
}

export interface WebTab {
  readonly kind: 'web';
  readonly url: string;
  readonly title?: string;
}

export interface PanelTab {
  readonly kind: 'panel';
  readonly agentId: string;
  readonly title?: string;
}

export interface SkillTab {
  readonly kind: 'skill';
  readonly name: string;
}

export type PreviewTab = ResourceTab | WebTab | PanelTab | SkillTab;

export interface PreviewTabsState {
  /** Open tabs, in strip order. */
  readonly tabs: readonly PreviewTab[];
  /** The focused tab key; null only when no tabs are open. */
  readonly active: string | null;
}

export const EMPTY_PREVIEW_TABS: PreviewTabsState = { tabs: [], active: null };

export function hostFileResource(rawPath: string, cwd?: string): PreviewResource {
  const trimmed = rawPath.trim();
  const path = /^file:\/\//iu.test(trimmed)
    ? normalizeHostFilePath(trimmed, cwd)
    : resolveHostPath(trimmed, cwd);
  const name = basenameOf(path);
  return {
    source: { kind: 'host-file', path },
    origin: { path, trusted: true },
    type: classifyResource({ name }),
    name,
  };
}

export function mediaRefResource(
  item: MediaRef,
  options: {
    readonly sessionId?: string;
    readonly origin?: { readonly path: string; readonly trusted: true };
    readonly cwd?: string;
    readonly name: string;
  },
): PreviewResource {
  const { sessionId, cwd, name } = options;
  const origin = options.origin ?? item.origin;
  const resolvedOrigin =
    origin !== undefined && origin.trusted
      ? { path: normalizeHostFilePath(origin.path, cwd), trusted: true as const }
      : undefined;
  const fallbackType: PreviewResource['type'] =
    item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : item.kind === 'image' ? 'image' : 'unsupported';
  const rawType = classifyResource({ name, mime: item.mime });
  const type = rawType === 'unsupported' && fallbackType !== 'unsupported' ? fallbackType : rawType;
  if (item.fileId !== undefined) {
    return {
      source: {
        kind: 'session-copy',
        sessionId: sessionId ?? '',
        fileId: item.fileId,
        sourceId: item.sourceId,
      },
      origin: resolvedOrigin,
      type,
      name,
      mime: item.mime,
    };
  }
  if (item.path !== undefined) {
    const resolved = normalizeHostFilePath(item.path, cwd);
    return {
      source: { kind: 'host-file', path: resolved },
      origin: resolvedOrigin ?? { path: resolved, trusted: true },
      type,
      name,
      mime: item.mime,
    };
  }
  return {
    source: { kind: 'url', url: item.url ?? '' },
    origin: resolvedOrigin,
    type,
    name,
    mime: item.mime,
  };
}

export function previewTabKey(tab: PreviewTab | string, cwd?: string): string {
  if (typeof tab === 'string') {
    if (
      (tab.startsWith('file:') && !/^file:\/\//iu.test(tab)) ||
      tab.startsWith('attachment:') ||
      tab.startsWith('url:') ||
      tab.startsWith('web:') ||
      tab.startsWith('panel:') ||
      tab.startsWith('skill:')
    ) {
      return tab;
    }
    return previewResourceKey({ source: { kind: 'host-file', path: tab } }, cwd);
  }
  if (tab.kind === 'resource') return previewResourceKey(tab.resource, cwd);
  if (tab.kind === 'web') return `web:${tab.url}`;
  return tab.kind === 'panel' ? `panel:${tab.agentId}` : `skill:builtin:${tab.name}`;
}

export function normalizeTabInput(input: string | PreviewTab, cwd?: string): PreviewTab {
  if (typeof input === 'string') {
    return { kind: 'resource', resource: hostFileResource(input, cwd) };
  }
  if (input.kind === 'resource' && input.resource.source.kind === 'host-file' && cwd !== undefined) {
    const resolvedPath = resolveHostPath(input.resource.source.path, cwd);
    if (resolvedPath !== input.resource.source.path) {
      const name = input.resource.name ?? basenameOf(resolvedPath);
      return {
        ...input,
        resource: {
          ...input.resource,
          source: { kind: 'host-file', path: resolvedPath },
          origin:
            input.resource.origin !== undefined
              ? { ...input.resource.origin, path: resolveHostPath(input.resource.origin.path, cwd) }
              : { path: resolvedPath, trusted: true },
          name,
        },
      };
    }
  }
  return input;
}

/** Open a resource, web URL, skill, or panel: an existing tab activates; a new one appends + activates. */
export function openPreviewTab(
  state: PreviewTabsState,
  input: string | PreviewTab,
  cwd?: string,
): PreviewTabsState {
  const tab = normalizeTabInput(input, cwd);
  const key = previewTabKey(tab, cwd);
  const existingIndex = state.tabs.findIndex((t) => previewTabKey(t, cwd) === key);
  if (existingIndex !== -1) {
    const existing = state.tabs[existingIndex];
    if (
      (tab.kind === 'panel' && tab.title && existing?.kind === 'panel') ||
      (tab.kind === 'web' && tab.title && existing?.kind === 'web') ||
      (tab.kind === 'resource' &&
        existing?.kind === 'resource' &&
        tab.resource.source.kind === 'session-copy' &&
        existing.resource.source.kind === 'session-copy')
    ) {
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
  cwd?: string,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab, cwd);
  return state.tabs.some((t) => previewTabKey(t, cwd) === key) ? { ...state, active: key } : state;
}

/**
 * Close one tab. Closing the active tab hands focus to the right neighbor,
 * falling back to the left one (editor-tab convention).
 */
export function closePreviewTab(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
  cwd?: string,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab, cwd);
  const index = state.tabs.findIndex((t) => previewTabKey(t, cwd) === key);
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  if (state.active !== key) return { tabs, active: state.active };
  const nextTab = tabs[index] ?? tabs[index - 1] ?? null;
  const active = nextTab ? previewTabKey(nextTab, cwd) : null;
  return { tabs, active };
}

/** Close every tab except `key` (which must exist; no-op otherwise). */
export function closeOtherPreviewTabs(
  state: PreviewTabsState,
  keyOrTab: string | PreviewTab,
  cwd?: string,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab, cwd);
  const match = state.tabs.find((t) => previewTabKey(t, cwd) === key);
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
  cwd?: string,
): PreviewTabsState {
  const key = previewTabKey(keyOrTab, cwd);
  const from = state.tabs.findIndex((t) => previewTabKey(t, cwd) === key);
  if (from === -1) return state;
  const to = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
  if (to === from) return state;
  const tabs = [...state.tabs];
  const [removed] = tabs.splice(from, 1);
  if (removed === undefined) return state;
  tabs.splice(to, 0, removed);
  return { ...state, tabs };
}

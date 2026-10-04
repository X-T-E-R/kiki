import { peekUiSnapshot, saveUiSnapshot } from './navHistory';
import { previewTabKey, type PreviewTab, type PreviewTabsState } from '../state/previewWorkspace';

export interface TimelineReadingSnapshot {
  readonly anchor: { readonly atEnd: boolean; readonly key?: string; readonly offset: number };
  readonly openFolds: readonly string[];
  readonly cardForms?: Readonly<Record<string, 'full' | 'compact'>>;
}

export interface PreviewReadingSnapshot {
  readonly tabsState: PreviewTabsState;
  readonly panelOpen: boolean;
  readonly positions: Readonly<Record<string, { readonly top: number; readonly left?: number }>>;
}

export function timelineSnapshotKey(sessionId: string, agentId = 'main'): string {
  return `timeline:${JSON.stringify([sessionId, agentId])}`;
}

export function previewSnapshotKey(sessionId: string, agentId = 'main'): string {
  return `preview:${JSON.stringify([sessionId, agentId])}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only reading identity and geometry cross reload; never transcript text or buffers. */
export function readTimelineSnapshot(value: unknown): TimelineReadingSnapshot | undefined {
  if (!record(value) || !record(value['anchor']) || !Array.isArray(value['openFolds'])) return undefined;
  const anchor = value['anchor'];
  if (typeof anchor['atEnd'] !== 'boolean' || typeof anchor['offset'] !== 'number' || !Number.isFinite(anchor['offset']) ||
    (anchor['key'] !== undefined && typeof anchor['key'] !== 'string') || !value['openFolds'].every((id) => typeof id === 'string')) return undefined;
  const forms = record(value['cardForms']) ? value['cardForms'] : {};
  return {
    anchor: { atEnd: anchor['atEnd'], key: anchor['key'] as string | undefined, offset: anchor['offset'] },
    openFolds: [...new Set(value['openFolds'] as string[])],
    cardForms: Object.fromEntries(Object.entries(forms).filter(([, form]) => form === 'full' || form === 'compact')) as Record<string, 'full' | 'compact'>,
  };
}

export function readPreviewSnapshot(value: unknown): PreviewReadingSnapshot | undefined {
  if (!record(value) || !record(value['tabsState']) || typeof value['panelOpen'] !== 'boolean') return undefined;
  const state = value['tabsState'];
  if (!Array.isArray(state['tabs'])) return undefined;
  const tabs: PreviewTab[] = [];
  const keys = new Set<string>();
  for (const raw of state['tabs']) {
    if (!record(raw)) return undefined;
    let tab: PreviewTab;
    if (raw['kind'] === 'file' && typeof raw['path'] === 'string') tab = { kind: 'file', path: raw['path'] };
    else if (raw['kind'] === 'panel' && typeof raw['agentId'] === 'string') tab = { kind: 'panel', agentId: raw['agentId'], title: typeof raw['title'] === 'string' ? raw['title'] : undefined };
    else if (raw['kind'] === 'skill' && typeof raw['name'] === 'string') tab = { kind: 'skill', name: raw['name'] };
    else return undefined;
    const key = previewTabKey(tab);
    if (!keys.has(key)) { tabs.push(tab); keys.add(key); }
  }
  const positions = record(value['positions']) ? value['positions'] : {};
  const safePositions: Record<string, { top: number; left?: number }> = {};
  for (const [key, position] of Object.entries(positions)) {
    if (!keys.has(key) || !record(position) || typeof position['top'] !== 'number' || !Number.isFinite(position['top'])) continue;
    safePositions[key] = { top: position['top'], left: typeof position['left'] === 'number' && Number.isFinite(position['left']) ? position['left'] : undefined };
  }
  return {
    tabsState: { tabs, active: typeof state['active'] === 'string' && keys.has(state['active']) ? state['active'] : tabs[0] === undefined ? null : previewTabKey(tabs[0]) },
    panelOpen: value['panelOpen'] && tabs.length > 0,
    positions: safePositions,
  };
}

export function saveReadingSnapshot(visitId: string, key: string, value: unknown): void {
  const safe = key.startsWith('timeline:') ? readTimelineSnapshot(value) : key.startsWith('preview:') ? readPreviewSnapshot(value) : undefined;
  if (safe !== undefined) saveUiSnapshot(visitId, { [key]: safe });
}

export function getReadingSnapshot<T>(visitId: string, key: string): T | undefined {
  const value = peekUiSnapshot(visitId)?.[key];
  return (key.startsWith('timeline:') ? readTimelineSnapshot(value) : key.startsWith('preview:') ? readPreviewSnapshot(value) : undefined) as T | undefined;
}

const adapters = new Map<symbol, { visitId: string; capture: () => void }>();

export function registerNavSnapshotCapture(visitId: string, capture: () => void): () => void {
  const token = Symbol();
  adapters.set(token, { visitId, capture });
  return () => { adapters.delete(token); };
}

/** Capturing is read-only: a rejected guard leaves the page and cursor untouched. */
export function captureVisitSnapshots(visitId: string): void {
  for (const adapter of adapters.values()) if (adapter.visitId === visitId) adapter.capture();
}

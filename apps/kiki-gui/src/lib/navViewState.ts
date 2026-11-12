import { peekUiSnapshot, saveUiSnapshot } from './navHistory';
import {
  classifyResource,
  type PreviewResource,
  type PreviewResourceOrigin,
  type PreviewResourceSource,
  type PreviewResourceType,
} from '../state/previewResource';
import {
  hostFileResource,
  previewTabKey,
  type PreviewTab,
  type PreviewTabsState,
} from '../state/previewWorkspace';

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

const VALID_RESOURCE_TYPES = new Set<PreviewResourceType>([
  'text',
  'markdown',
  'html',
  'image',
  'video',
  'audio',
  'pdf',
  'office',
  'table',
  'unsupported',
]);

function readPreviewResource(raw: unknown): PreviewResource | undefined {
  if (!record(raw) || !record(raw['source'])) return undefined;
  const rawSource = raw['source'];
  let source: PreviewResourceSource;
  if (rawSource['kind'] === 'host-file' && typeof rawSource['path'] === 'string') {
    source = { kind: 'host-file', path: rawSource['path'] };
  } else if (
    rawSource['kind'] === 'session-copy' &&
    typeof rawSource['sessionId'] === 'string' &&
    typeof rawSource['fileId'] === 'string'
  ) {
    source = {
      kind: 'session-copy',
      sessionId: rawSource['sessionId'],
      fileId: rawSource['fileId'],
      sourceId: typeof rawSource['sourceId'] === 'string' ? rawSource['sourceId'] : undefined,
    };
  } else if (rawSource['kind'] === 'url' && typeof rawSource['url'] === 'string') {
    source = { kind: 'url', url: rawSource['url'] };
  } else {
    return undefined;
  }

  let origin: PreviewResourceOrigin | undefined;
  if (record(raw['origin']) && typeof raw['origin']['path'] === 'string' && typeof raw['origin']['trusted'] === 'boolean') {
    origin = { path: raw['origin']['path'], trusted: raw['origin']['trusted'] };
  }
  const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
  const mime = typeof raw['mime'] === 'string' ? raw['mime'] : undefined;
  const rawType = raw['type'];
  const type =
    typeof rawType === 'string' && VALID_RESOURCE_TYPES.has(rawType as PreviewResourceType)
      ? (rawType as PreviewResourceType)
      : classifyResource({
          name: name ?? (source.kind === 'host-file' ? source.path : undefined),
          mime,
        });
  return { source, origin, type, name, mime };
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
  const keyAliases = new Map<string, string>();
  for (const raw of state['tabs']) {
    if (!record(raw)) continue;
    let tab: PreviewTab | undefined;
    let legacyKey: string | undefined;
    if (raw['kind'] === 'resource') {
      const resource = readPreviewResource(raw['resource']);
      if (resource !== undefined) {
        tab = {
          kind: 'resource',
          resource,
          size: typeof raw['size'] === 'number' && Number.isFinite(raw['size']) ? raw['size'] : undefined,
        };
      }
    } else if (raw['kind'] === 'file' && typeof raw['path'] === 'string') {
      legacyKey = raw['path'];
      tab = { kind: 'resource', resource: hostFileResource(raw['path']) };
    } else if (raw['kind'] === 'web' && typeof raw['url'] === 'string') {
      tab = { kind: 'web', url: raw['url'], title: typeof raw['title'] === 'string' ? raw['title'] : undefined };
    } else if (raw['kind'] === 'panel' && typeof raw['agentId'] === 'string') {
      tab = { kind: 'panel', agentId: raw['agentId'], title: typeof raw['title'] === 'string' ? raw['title'] : undefined };
    } else if (raw['kind'] === 'skill' && typeof raw['name'] === 'string') {
      tab = { kind: 'skill', name: raw['name'] };
    }
    if (tab === undefined) continue;
    const key = previewTabKey(tab);
    if (legacyKey !== undefined) keyAliases.set(legacyKey, key);
    if (!keys.has(key)) { tabs.push(tab); keys.add(key); }
  }
  const resolveSavedKey = (candidate: string): string | undefined => {
    if (keys.has(candidate)) return candidate;
    const aliased = keyAliases.get(candidate);
    if (aliased !== undefined && keys.has(aliased)) return aliased;
    const normalized = previewTabKey(candidate);
    return keys.has(normalized) ? normalized : undefined;
  };
  const positions = record(value['positions']) ? value['positions'] : {};
  const safePositions: Record<string, { top: number; left?: number }> = {};
  for (const [rawKey, position] of Object.entries(positions)) {
    const resolvedKey = resolveSavedKey(rawKey);
    if (resolvedKey === undefined || !record(position) || typeof position['top'] !== 'number' || !Number.isFinite(position['top'])) continue;
    safePositions[resolvedKey] = { top: position['top'], left: typeof position['left'] === 'number' && Number.isFinite(position['left']) ? position['left'] : undefined };
  }
  const rawActive = typeof state['active'] === 'string' ? resolveSavedKey(state['active']) : undefined;
  return {
    tabsState: { tabs, active: rawActive ?? (tabs[0] === undefined ? null : previewTabKey(tabs[0])) },
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

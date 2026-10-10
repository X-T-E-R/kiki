import {
  DISCOVERY_CONTENT_VERSION,
  DISCOVERY_STATIONS,
  discoveryRoute,
  isDiscoveryRouteId,
  isDiscoveryStationId,
  type DiscoveryRouteId,
  type DiscoveryStationId,
} from './catalog';
import { activeSpace } from '../storage/spaceStorage';
import { readSettings, writeSettings } from '../settings/settings';

export interface DiscoveryProgress {
  readonly seen: boolean;
  readonly tried: boolean;
  readonly skipped: boolean;
}

export interface DiscoveryState {
  readonly version: 1;
  readonly contentVersion: number;
  readonly lifecycle: 'new' | 'active' | 'left' | 'finished';
  readonly route?: DiscoveryRouteId;
  readonly station?: DiscoveryStationId;
  readonly collapsed: boolean;
  readonly progress: Partial<Record<DiscoveryStationId, DiscoveryProgress>>;
}

export interface DiscoveryScope {
  /** Opaque, credential-free identity from the existing connection/nav scope. */
  readonly connectionId: string;
  readonly homeId: string;
}

export type DiscoveryEvent =
  | { readonly type: 'start'; readonly route: DiscoveryRouteId }
  | { readonly type: 'select'; readonly station: DiscoveryStationId }
  | { readonly type: 'next' | 'previous' | 'skip' | 'leave' | 'resume' | 'acknowledge-content' }
  | { readonly type: 'collapse'; readonly collapsed: boolean }
  | { readonly type: 'viewed'; readonly station: DiscoveryStationId }
  | { readonly type: 'tried'; readonly station: DiscoveryStationId };

const EMPTY_PROGRESS: DiscoveryProgress = { seen: false, tried: false, skipped: false };
export const EMPTY_DISCOVERY_STATE: DiscoveryState = {
  version: 1, contentVersion: DISCOVERY_CONTENT_VERSION, lifecycle: 'new', collapsed: false, progress: {},
};

export function discoveryProgress(state: DiscoveryState, station: DiscoveryStationId): DiscoveryProgress {
  return state.progress[station] ?? EMPTY_PROGRESS;
}

export function discoveryRouteProgress(state: DiscoveryState, route: DiscoveryRouteId) {
  const stations = discoveryRoute(route).stations;
  const seen = stations.filter((id) => discoveryProgress(state, id).seen).length;
  const tried = stations.filter((id) => discoveryProgress(state, id).tried).length;
  const skipped = stations.filter((id) => discoveryProgress(state, id).skipped).length;
  return { seen, tried, skipped, total: stations.length, viewed: seen === stations.length };
}

function mark(state: DiscoveryState, station: DiscoveryStationId, patch: Partial<DiscoveryProgress>): DiscoveryState {
  if (state.lifecycle !== 'active' || state.station !== station) return state;
  const current = discoveryProgress(state, station);
  return { ...state, progress: { ...state.progress, [station]: { ...current, ...patch } } };
}

/** Pure UI transitions: no navigation, execution, model calls or configuration changes. */
export function reduceDiscoveryState(state: DiscoveryState, event: DiscoveryEvent): DiscoveryState {
  if (event.type === 'start') {
    return { ...state, lifecycle: 'active', route: event.route, station: discoveryRoute(event.route).stations[0], collapsed: false };
  }
  if (event.type === 'acknowledge-content') return { ...state, contentVersion: DISCOVERY_CONTENT_VERSION };
  if (event.type === 'leave') return state.lifecycle === 'active' ? { ...state, lifecycle: 'left' } : state;
  if (event.type === 'collapse') return { ...state, collapsed: event.collapsed };
  if (event.type === 'resume') {
    return state.route !== undefined && state.station !== undefined
      ? { ...state, lifecycle: 'active', collapsed: false } : state;
  }
  if (event.type === 'viewed') return mark(state, event.station, { seen: true });
  if (event.type === 'tried') return mark(state, event.station, { seen: true, tried: true });
  if (state.route === undefined || state.station === undefined || state.lifecycle !== 'active') return state;
  const stations: readonly DiscoveryStationId[] = discoveryRoute(state.route).stations;
  if (event.type === 'select') {
    return stations.includes(event.station) ? { ...state, station: event.station, collapsed: false } : state;
  }
  const index = stations.indexOf(state.station);
  if (event.type === 'previous') {
    const station = stations[index - 1];
    return station === undefined ? state : { ...state, station };
  }
  const current = event.type === 'skip' ? mark(state, state.station, { skipped: true }) : state;
  const next = stations[index + 1];
  return next === undefined ? { ...current, lifecycle: 'finished' } : { ...current, station: next };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whitelist persisted UI progress. References, text, secrets and unknown future schemas are not restored. */
export function parseDiscoveryState(value: unknown): DiscoveryState {
  const raw = record(value);
  if (raw['version'] !== 1) return EMPTY_DISCOVERY_STATE;
  const route = isDiscoveryRouteId(raw['route']) ? raw['route'] : undefined;
  const station = isDiscoveryStationId(raw['station']) && route !== undefined
    && (discoveryRoute(route).stations as readonly string[]).includes(raw['station']) ? raw['station'] : undefined;
  const lifecycle = route === undefined || station === undefined ? 'new'
    : raw['lifecycle'] === 'finished' ? 'finished' : 'left';
  const progress: Partial<Record<DiscoveryStationId, DiscoveryProgress>> = {};
  const statuses = record(raw['progress']);
  for (const { id } of DISCOVERY_STATIONS) {
    const entry = record(statuses[id]);
    const tried = entry['tried'] === true;
    if (entry['seen'] === true || tried || entry['skipped'] === true) {
      progress[id] = { seen: entry['seen'] === true || tried, tried, skipped: entry['skipped'] === true };
    }
  }
  return {
    version: 1,
    contentVersion: typeof raw['contentVersion'] === 'number' && Number.isSafeInteger(raw['contentVersion']) && raw['contentVersion'] >= 0
      ? raw['contentVersion'] : 0,
    lifecycle, route, station, collapsed: raw['collapsed'] === true, progress,
  };
}

export interface DiscoverySettingsPort {
  read(): unknown;
  write(value: Readonly<Record<string, DiscoveryState>>): void;
}

const SETTINGS_PORT: DiscoverySettingsPort = {
  read: () => readSettings().featureDiscovery,
  write: (featureDiscovery) => { writeSettings({ featureDiscovery }); },
};

export function currentDiscoveryScope(connectionId: string): DiscoveryScope {
  return { homeId: activeSpace()?.homeId ?? 'main', connectionId };
}

function scopeKey(scope: DiscoveryScope): string {
  return JSON.stringify([scope.homeId, scope.connectionId]);
}

export function readDiscoveryState(scope: DiscoveryScope, port: DiscoverySettingsPort = SETTINGS_PORT): DiscoveryState {
  try {
    return parseDiscoveryState(record(port.read())[scopeKey(scope)]);
  } catch {
    return EMPTY_DISCOVERY_STATE;
  }
}

/** Stores only whitelisted UI progress in the existing device settings, partitioned by home and connection. */
export function writeDiscoveryState(scope: DiscoveryScope, state: DiscoveryState, port: DiscoverySettingsPort = SETTINGS_PORT): void {
  const parsed = parseDiscoveryState(state);
  try {
    const all: Record<string, DiscoveryState> = {};
    for (const [key, value] of Object.entries(record(port.read()))) all[key] = parseDiscoveryState(value);
    all[scopeKey(scope)] = parsed;
    port.write(all);
  } catch {
    return;
  }
}

import type { I18nKey } from '../i18n/locale';

/** GUI-owned route to the route map; no server endpoint or session is created. */
export const DISCOVERY_ENTRY_PATH = '/discover';
export const DISCOVERY_CONTENT_VERSION = 1;

export const DISCOVERY_ROUTES = [
  { id: 'overview', titleKey: 'discovery.route.overview.title', summaryKey: 'discovery.route.overview.summary', stations: ['workspace', 'agents', 'memory', 'capabilities', 'cron'] },
  { id: 'do-first', titleKey: 'discovery.route.doFirst.title', summaryKey: 'discovery.route.doFirst.summary', stations: ['workspace', 'approach', 'result'] },
  { id: 'understand', titleKey: 'discovery.route.understand.title', summaryKey: 'discovery.route.understand.summary', stations: ['agents', 'direction', 'usage'] },
  { id: 'sustain', titleKey: 'discovery.route.sustain.title', summaryKey: 'discovery.route.sustain.summary', stations: ['memory', 'board', 'cron'] },
  { id: 'extend', titleKey: 'discovery.route.extend.title', summaryKey: 'discovery.route.extend.summary', stations: ['capabilities', 'extensions'] },
] as const satisfies readonly { id: string; titleKey: I18nKey; summaryKey: I18nKey; stations: readonly string[] }[];

export type DiscoveryRouteId = typeof DISCOVERY_ROUTES[number]['id'];
export type DiscoveryStationId = typeof DISCOVERY_ROUTES[number]['stations'][number];
export type DiscoveryRoute = typeof DISCOVERY_ROUTES[number];
export type DiscoveryAnchor = 'workspace-picker' | 'materials' | 'work-mode' | 'agent-panel' | 'send-controls' | 'memory-scope' | 'capability-detail' | 'board-detail' | 'cron-detail' | 'result-detail' | 'usage-filter';
export type DiscoveryExampleId = 'agents' | 'direction' | 'result' | 'cron';

export interface DiscoveryStation {
  readonly id: DiscoveryStationId;
  readonly titleKey: I18nKey;
  readonly bodyKey: I18nKey;
  readonly page: 'new' | 'session' | 'memory' | 'capabilities' | 'cron' | 'usage' | 'board' | 'personas';
  readonly anchor?: DiscoveryAnchor;
  readonly example?: DiscoveryExampleId;
}

export const DISCOVERY_STATIONS: readonly DiscoveryStation[] = [
  { id: 'workspace', titleKey: 'discovery.station.workspace.title', bodyKey: 'discovery.station.workspace.body', page: 'new', anchor: 'workspace-picker' },
  { id: 'agents', titleKey: 'discovery.station.agents.title', bodyKey: 'discovery.station.agents.body', page: 'session', anchor: 'agent-panel', example: 'agents' },
  { id: 'memory', titleKey: 'discovery.station.memory.title', bodyKey: 'discovery.station.memory.body', page: 'memory', anchor: 'memory-scope' },
  { id: 'capabilities', titleKey: 'discovery.station.capabilities.title', bodyKey: 'discovery.station.capabilities.body', page: 'capabilities', anchor: 'capability-detail' },
  { id: 'cron', titleKey: 'discovery.station.cron.title', bodyKey: 'discovery.station.cron.body', page: 'cron', anchor: 'cron-detail', example: 'cron' },
  { id: 'approach', titleKey: 'discovery.station.approach.title', bodyKey: 'discovery.station.approach.body', page: 'new', anchor: 'work-mode' },
  { id: 'result', titleKey: 'discovery.station.result.title', bodyKey: 'discovery.station.result.body', page: 'session', anchor: 'result-detail', example: 'result' },
  { id: 'direction', titleKey: 'discovery.station.direction.title', bodyKey: 'discovery.station.direction.body', page: 'session', anchor: 'send-controls', example: 'direction' },
  { id: 'usage', titleKey: 'discovery.station.usage.title', bodyKey: 'discovery.station.usage.body', page: 'usage', anchor: 'usage-filter' },
  { id: 'board', titleKey: 'discovery.station.board.title', bodyKey: 'discovery.station.board.body', page: 'board', anchor: 'board-detail' },
  { id: 'extensions', titleKey: 'discovery.station.extensions.title', bodyKey: 'discovery.station.extensions.body', page: 'personas' },
];

export interface DiscoveryExample {
  readonly id: DiscoveryExampleId;
  readonly labelKey: I18nKey;
  readonly bodyKey: I18nKey;
  readonly items: readonly { readonly titleKey: I18nKey; readonly bodyKey: I18nKey }[];
  readonly runs: false;
}

export const DISCOVERY_EXAMPLES: readonly DiscoveryExample[] = [
  { id: 'agents', labelKey: 'discovery.example.label', bodyKey: 'discovery.example.agents.body', runs: false, items: [
    { titleKey: 'discovery.example.main.title', bodyKey: 'discovery.example.main.body' },
    { titleKey: 'discovery.example.child.title', bodyKey: 'discovery.example.child.body' },
  ] },
  { id: 'direction', labelKey: 'discovery.example.label', bodyKey: 'discovery.example.direction.body', runs: false, items: [] },
  { id: 'result', labelKey: 'discovery.example.label', bodyKey: 'discovery.example.result.body', runs: false, items: [] },
  { id: 'cron', labelKey: 'discovery.example.label', bodyKey: 'discovery.example.cron.body', runs: false, items: [] },
];

export function discoveryRoute(id: DiscoveryRouteId): DiscoveryRoute {
  return DISCOVERY_ROUTES.find((route) => route.id === id)!;
}

export function discoveryStation(id: DiscoveryStationId): DiscoveryStation {
  return DISCOVERY_STATIONS.find((station) => station.id === id)!;
}

export function isDiscoveryRouteId(value: unknown): value is DiscoveryRouteId {
  return DISCOVERY_ROUTES.some((route) => route.id === value);
}

export function isDiscoveryStationId(value: unknown): value is DiscoveryStationId {
  return DISCOVERY_STATIONS.some((station) => station.id === value);
}

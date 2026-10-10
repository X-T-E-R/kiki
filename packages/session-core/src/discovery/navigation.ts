import type { I18nKey } from '../i18n/locale';
import { DISCOVERY_CONTENT_VERSION, discoveryRoute, discoveryStation, type DiscoveryAnchor, type DiscoveryExampleId, type DiscoveryStationId } from './catalog';
import { discoveryProgress, reduceDiscoveryState, type DiscoveryEvent, type DiscoveryScope, type DiscoveryState } from './state';

export interface DiscoveryContext {
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly personaId?: string;
  /** Caller has verified this session in the current scope, excluding archived/deleted sessions. */
  readonly sessionReachable?: boolean;
  readonly online: boolean;
  readonly currentHref: string;
  readonly sessionBusy?: boolean;
  readonly draftEmpty?: boolean;
  readonly anchors: readonly DiscoveryAnchor[];
  readonly data?: { readonly memory?: boolean; readonly capabilities?: boolean; readonly cron?: boolean; readonly board?: boolean };
}

export interface DiscoveryDestination {
  readonly href: string;
  readonly anchor?: DiscoveryAnchor;
  readonly example?: DiscoveryExampleId;
}

function scopedPath(path: string, context: DiscoveryContext, workspace = true): string {
  const query = new URLSearchParams();
  if (workspace && context.workspaceId !== undefined) query.set('workspace', context.workspaceId);
  if (path === '/memory' && context.personaId !== undefined) query.set('persona', context.personaId);
  return query.size === 0 ? path : `${path}?${query.toString()}`;
}

export function discoveryDestination(id: DiscoveryStationId, context: DiscoveryContext): DiscoveryDestination {
  const station = discoveryStation(id);
  if (station.page === 'session') {
    if (context.sessionReachable === true && context.sessionId !== undefined && context.sessionId !== '') {
      return { href: `/s/${encodeURIComponent(context.sessionId)}`, anchor: station.anchor };
    }
    return { href: '/new', example: station.example };
  }
  return { href: scopedPath(`/${station.page}`, context, ['memory', 'board', 'cron', 'capabilities'].includes(station.page)), anchor: station.anchor };
}

export type DiscoveryTryAction =
  | { readonly kind: 'anchor'; readonly id: DiscoveryAnchor; readonly labelKey: I18nKey }
  | { readonly kind: 'example'; readonly id: DiscoveryExampleId; readonly labelKey: I18nKey }
  | { readonly kind: 'draft'; readonly id: 'search-draft'; readonly labelKey: I18nKey; readonly promptKey: I18nKey; readonly send: false; readonly overwrite: false }
  | { readonly kind: 'navigate'; readonly id: 'personas' | 'skills' | 'mcp' | 'engines' | 'ssh'; readonly href: string; readonly labelKey: I18nKey };

const ANCHOR_LABELS: Record<DiscoveryAnchor, I18nKey> = {
  'workspace-picker': 'discovery.action.workspace',
  materials: 'discovery.action.materials',
  'work-mode': 'discovery.action.mode',
  'agent-panel': 'discovery.action.agents',
  'send-controls': 'discovery.action.direction',
  'memory-scope': 'discovery.action.memory',
  'capability-detail': 'discovery.action.capabilities',
  'board-detail': 'discovery.action.board',
  'cron-detail': 'discovery.action.cron',
  'result-detail': 'discovery.action.result',
  'usage-filter': 'discovery.action.usage',
};

export function discoveryTryActions(id: DiscoveryStationId, context: DiscoveryContext): readonly DiscoveryTryAction[] {
  const station = discoveryStation(id);
  const destination = discoveryDestination(id, context);
  if (destination.example !== undefined) return [{ kind: 'example', id: destination.example, labelKey: 'discovery.action.example' }];
  const actions: DiscoveryTryAction[] = [];
  const hasData = id === 'capabilities' ? context.data?.capabilities === true
    : id === 'cron' ? context.data?.cron === true
    : id === 'board' ? context.data?.board === true : true;
  if (station.anchor !== undefined && context.anchors.includes(station.anchor)
      && (id !== 'direction' || context.sessionBusy === true) && hasData) {
    actions.push({ kind: 'anchor', id: station.anchor, labelKey: ANCHOR_LABELS[station.anchor] });
  }
  if (id === 'cron' && context.data?.cron === false) actions.push({ kind: 'example', id: 'cron', labelKey: 'discovery.action.example' });
  if (id === 'direction' && context.sessionBusy !== true) actions.push({ kind: 'example', id: 'direction', labelKey: 'discovery.action.example' });
  if (id === 'workspace' && context.draftEmpty === true) actions.push({ kind: 'draft', id: 'search-draft', labelKey: 'discovery.action.draft', promptKey: 'discovery.draft.search', send: false, overwrite: false });
  if (id === 'extensions') actions.push(
    { kind: 'navigate', id: 'personas', href: '/personas', labelKey: 'discovery.action.personas' },
    { kind: 'navigate', id: 'skills', href: `${scopedPath('/capabilities', context)}${context.workspaceId === undefined ? '?' : '&'}tab=skills`, labelKey: 'discovery.action.skills' },
    { kind: 'navigate', id: 'mcp', href: `${scopedPath('/capabilities', context)}${context.workspaceId === undefined ? '?' : '&'}tab=mcp`, labelKey: 'discovery.action.mcp' },
    { kind: 'navigate', id: 'engines', href: '/settings/ai?tab=providers#st-card-engines', labelKey: 'discovery.action.engines' },
    { kind: 'navigate', id: 'ssh', href: '/settings/ssh#st-card-ssh-hosts', labelKey: 'discovery.action.ssh' },
  );
  return context.online ? actions : actions.filter((action) => action.kind === 'example' || action.kind === 'draft');
}

function samePage(currentHref: string, target: string): boolean {
  const current = currentHref.split(/[?#]/)[0];
  const path = target.split(/[?#]/)[0];
  return current === path || (path?.startsWith('/s/') === true && current?.startsWith(`${path}/`) === true);
}

export function discoveryView(state: DiscoveryState, context: DiscoveryContext) {
  const station = state.station === undefined ? undefined : discoveryStation(state.station);
  const destination = state.station === undefined ? undefined : discoveryDestination(state.station, context);
  const route = state.route === undefined ? undefined : discoveryRoute(state.route);
  const index = route === undefined ? -1 : (route.stations as readonly string[]).indexOf(state.station ?? '');
  const visible = state.lifecycle === 'active' && destination !== undefined && samePage(context.currentHref, destination.href);
  return {
    route, station, destination, visible, collapsed: state.collapsed,
    position: index + 1, total: route?.stations.length ?? 0,
    progress: state.station === undefined ? undefined : discoveryProgress(state, state.station),
    actions: visible && state.station !== undefined ? discoveryTryActions(state.station, context) : [],
    canPrevious: index > 0,
    canNext: state.lifecycle === 'active' && station !== undefined,
    resume: state.route !== undefined && state.station !== undefined && state.lifecycle !== 'finished',
    hasNewContent: state.contentVersion < DISCOVERY_CONTENT_VERSION,
  };
}

export interface DiscoveryNavigationPort {
  /** Adapter must use the existing dirtyGuard + nav history and report a cancelled transition. */
  navigate(destination: DiscoveryDestination, signal?: AbortSignal): Promise<'committed' | 'cancelled' | 'unavailable'>;
}

/** Navigation is explicit and state commits only after the guarded transition succeeds. */
export async function navigateDiscovery(
  state: DiscoveryState,
  event: DiscoveryEvent,
  context: DiscoveryContext,
  port: DiscoveryNavigationPort,
  signal?: AbortSignal,
): Promise<{ readonly state: DiscoveryState; readonly outcome: 'committed' | 'cancelled' | 'unavailable' }> {
  if (signal?.aborted === true) return { state, outcome: 'cancelled' };
  const next = reduceDiscoveryState(state, event);
  const navigates = ['start', 'select', 'next', 'previous', 'skip', 'resume'].includes(event.type);
  if (!navigates || next.lifecycle !== 'active' || next.station === undefined || next === state) return { state: next, outcome: 'committed' };
  const destination = discoveryDestination(next.station, context);
  if (!context.online && destination.example === undefined) return { state, outcome: 'unavailable' };
  const outcome = await port.navigate(destination, signal);
  if (signal?.aborted) return { state, outcome: 'cancelled' };
  return { state: outcome === 'committed' ? next : state, outcome };
}

export interface DiscoveryActionPort {
  /** Observed success from the owning control; do not send prompts or replace a nonempty draft. */
  perform(action: DiscoveryTryAction, signal?: AbortSignal): Promise<'done' | 'cancelled' | 'unavailable'>;
}

export async function tryDiscoveryAction(state: DiscoveryState, actionId: DiscoveryTryAction['id'], context: DiscoveryContext, port: DiscoveryActionPort, signal?: AbortSignal): Promise<DiscoveryState> {
  if (signal?.aborted === true || state.station === undefined || !discoveryView(state, context).visible) return state;
  const action = discoveryTryActions(state.station, context).find((entry) => entry.id === actionId);
  if (action === undefined || await port.perform(action, signal) !== 'done' || signal?.aborted) return state;
  return reduceDiscoveryState(state, { type: action.kind === 'example' || action.kind === 'navigate' ? 'viewed' : 'tried', station: state.station });
}

export interface DiscoveryReturnPoint {
  readonly scope: DiscoveryScope;
  /** In-memory visit reference; layout and drafts stay owned by existing navigation history. */
  readonly visitId: string;
}

export function discoveryCanReturn(point: DiscoveryReturnPoint, scope: DiscoveryScope): boolean {
  return point.scope.homeId === scope.homeId && point.scope.connectionId === scope.connectionId;
}

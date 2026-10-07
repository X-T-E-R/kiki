import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../i18n/locale';
import { configureSpaceStorage } from '../storage/spaceStorage';
import { readSettings, writeSettings, subscribeSettings } from '../settings/settings';
import {
  DISCOVERY_ENTRY_PATH, DISCOVERY_ROUTES, DISCOVERY_STATIONS, DISCOVERY_EXAMPLES,
  EMPTY_DISCOVERY_STATE, reduceDiscoveryState, discoveryRouteProgress, discoveryProgress,
  readDiscoveryState, writeDiscoveryState, parseDiscoveryState, currentDiscoveryScope,
  discoveryDestination, discoveryView, navigateDiscovery, discoveryTryActions, tryDiscoveryAction,
  discoveryCanReturn, type DiscoveryContext, type DiscoverySettingsPort,
} from './index';

const context: DiscoveryContext = { online: true, currentHref: '/new', anchors: ['workspace-picker', 'work-mode'], draftEmpty: true };
const scope = { homeId: 'main', connectionId: 'local' };
function memoryPort(): DiscoverySettingsPort {
  let value: unknown;
  return { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); } };
}

afterEach(() => { configureSpaceStorage(null); vi.unstubAllGlobals(); });

describe('discovery catalog and progress', () => {
  it('provides five stops and four short routes, all with bilingual copy and labelled non-running examples', () => {
    expect(DISCOVERY_ENTRY_PATH).toBe('/discover');
    expect(DISCOVERY_ROUTES.map((route) => route.stations.length)).toEqual([5, 3, 3, 3, 2]);
    for (const route of DISCOVERY_ROUTES) {
      for (const locale of ['en', 'zh'] as const) {
        expect(translate(locale, route.titleKey)).not.toBe(route.titleKey);
        expect(translate(locale, route.summaryKey)).not.toBe(route.summaryKey);
      }
    }
    for (const station of DISCOVERY_STATIONS) {
      for (const locale of ['en', 'zh'] as const) {
        expect(translate(locale, station.titleKey)).not.toBe(station.titleKey);
        expect(translate(locale, station.bodyKey)).not.toBe(station.bodyKey);
      }
    }
    expect(DISCOVERY_EXAMPLES.every((entry) => entry.runs === false)).toBe(true);
    expect(translate('zh', DISCOVERY_EXAMPLES[0]!.labelKey)).toContain('不会运行');
  });

  it('shares station progress across routes, keeps skip distinct and never requires trying to advance', () => {
    let state = reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'overview' });
    state = reduceDiscoveryState(state, { type: 'viewed', station: 'workspace' });
    state = reduceDiscoveryState(state, { type: 'skip' });
    expect(state.station).toBe('agents');
    expect(discoveryProgress(state, 'workspace')).toEqual({ seen: true, tried: false, skipped: true });
    state = reduceDiscoveryState(state, { type: 'start', route: 'do-first' });
    expect(discoveryProgress(state, 'workspace').seen).toBe(true);
    state = reduceDiscoveryState(state, { type: 'next' });
    state = reduceDiscoveryState(state, { type: 'skip' });
    state = reduceDiscoveryState(state, { type: 'next' });
    expect(state.lifecycle).toBe('finished');
    expect(discoveryRouteProgress(state, 'do-first')).toEqual({ seen: 1, tried: 0, skipped: 2, total: 3, viewed: false });
    expect(reduceDiscoveryState(state, { type: 'tried', station: 'result' })).toBe(state);
  });

  it('leaves, collapses and resumes without changing progress or resetting the current station', () => {
    let state = reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'sustain' });
    state = reduceDiscoveryState(state, { type: 'next' });
    state = reduceDiscoveryState(state, { type: 'collapse', collapsed: true });
    state = reduceDiscoveryState(state, { type: 'leave' });
    expect(state.station).toBe('board');
    expect(state.lifecycle).toBe('left');
    state = reduceDiscoveryState(state, { type: 'resume' });
    expect(state.collapsed).toBe(false);
    expect(state.progress).toEqual({});
  });
});

describe('discovery persistence and recovery', () => {
  it('partitions by the exact home/connection tuple, restores inactive and keeps old content progress', () => {
    const port = memoryPort();
    const state = reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'sustain' });
    const older = { ...reduceDiscoveryState(state, { type: 'viewed', station: 'memory' }), contentVersion: 0 };
    writeDiscoveryState(scope, older, port);
    writeDiscoveryState({ homeId: 'other', connectionId: 'local' }, EMPTY_DISCOVERY_STATE, port);
    expect(readDiscoveryState(scope, port)).toMatchObject({ lifecycle: 'left', station: 'memory', contentVersion: 0 });
    expect(discoveryView(readDiscoveryState(scope, port), { ...context, currentHref: '/memory' }).hasNewContent).toBe(true);
    expect(readDiscoveryState({ ...scope, connectionId: 'remote' }, port)).toBe(EMPTY_DISCOVERY_STATE);
    expect(readDiscoveryState({ homeId: 'other', connectionId: 'local' }, port).station).toBeUndefined();
    expect(readDiscoveryState(scope, port).progress.memory?.seen).toBe(true);
    configureSpaceStorage({ homeId: 'second' });
    expect(currentDiscoveryScope('local').homeId).toBe('second');
  });

  it('rejects mismatched references and future schemas and persists no text, sessions or unknown data', () => {
    const state = parseDiscoveryState({ version: 1, route: 'overview', station: 'extensions', lifecycle: 'active',
      sessionId: 'deleted', token: 'secret', draft: 'unsent', progress: { memory: { tried: true, text: 'user content' } } });
    expect(state.lifecycle).toBe('new');
    expect(state.station).toBeUndefined();
    expect(state.progress.memory).toEqual({ seen: true, tried: true, skipped: false });
    expect(JSON.stringify(state)).not.toMatch(/deleted|secret|unsent|user content/);
    expect(parseDiscoveryState({ version: 2 })).toBe(EMPTY_DISCOVERY_STATE);
    expect(parseDiscoveryState('{bad-json')).toBe(EMPTY_DISCOVERY_STATE);
  });

  it('uses existing device settings notification and preserves draft/settings data without portable writes', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } });
    data.set('kiki.settings', JSON.stringify({ theme: 'dark', draftPersistence: false }));
    data.set('kiki.drafts', 'unsent');
    const listener = vi.fn();
    const unsubscribe = subscribeSettings(listener);
    writeDiscoveryState(scope, reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'overview' }));
    unsubscribe();
    expect(listener).toHaveBeenCalledOnce();
    expect(readSettings().theme).toBe('dark');
    expect(data.get('kiki.drafts')).toBe('unsent');
    expect([...data.keys()]).toEqual(['kiki.settings', 'kiki.drafts']);
    writeSettings({ theme: 'light' });
    expect(readDiscoveryState(scope).station).toBe('workspace');
  });
});

describe('real page navigation and actions', () => {
  it('keeps scope filters and settings hashes, rejects unavailable sessions and never creates demo routes', () => {
    const real = { ...context, sessionId: 'real/a', sessionReachable: true, workspaceId: 'project one', personaId: 'role' };
    expect(discoveryDestination('agents', real)).toMatchObject({ href: '/s/real%2Fa', anchor: 'agent-panel' });
    expect(discoveryDestination('agents', { ...real, sessionReachable: false })).toEqual({ href: '/new', example: 'agents' });
    expect(discoveryDestination('memory', real).href).toBe('/memory?workspace=project+one&persona=role');
    expect(discoveryDestination('board', real).href).toBe('/board?workspace=project+one');
    expect(discoveryDestination('cron', real).href).toBe('/cron?workspace=project+one');
    expect(discoveryTryActions('extensions', real).find((action) => action.id === 'engines')).toMatchObject({ href: '/settings/ai?tab=providers#st-card-engines' });
    expect(discoveryTryActions('extensions', real).find((action) => action.id === 'mcp')).toMatchObject({ href: '/capabilities?workspace=project+one&tab=mcp' });
  });

  it('does not pull the user back after manual navigation, and commits only guarded navigation successes', async () => {
    const state = reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'overview' });
    expect(discoveryView(state, { ...context, currentHref: '/usage' }).visible).toBe(false);
    const navigate = vi.fn(async () => 'cancelled' as const);
    const cancelled = await navigateDiscovery(state, { type: 'next' }, context, { navigate });
    expect(cancelled.state).toBe(state);
    expect(cancelled.outcome).toBe('cancelled');
    const committed = await navigateDiscovery(state, { type: 'next' }, context, { navigate: async () => 'committed' });
    expect(committed.state.station).toBe('agents');
    expect(navigate).toHaveBeenCalledWith({ href: '/new', example: 'agents' }, undefined);
    const offline = await navigateDiscovery(state, { type: 'select', station: 'memory' }, { ...context, online: false }, { navigate });
    expect(offline.outcome).toBe('unavailable');
    expect(offline.state).toBe(state);
    navigate.mockClear();
    const collapsed = await navigateDiscovery(state, { type: 'collapse', collapsed: true }, context, { navigate });
    expect(collapsed.state.collapsed).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    const controller = new AbortController();
    const stale = await navigateDiscovery(state, { type: 'next' }, context, {
      navigate: async () => { controller.abort(); return 'committed'; },
    }, controller.signal);
    expect(stale).toEqual({ state, outcome: 'cancelled' });
  });

  it('makes examples seen-only, failed controls untried, and never overwrites or sends drafts', async () => {
    const state = reduceDiscoveryState(EMPTY_DISCOVERY_STATE, { type: 'start', route: 'understand' });
    const perform = vi.fn(async () => 'done' as const);
    const example = await tryDiscoveryAction(state, 'agents', context, { perform });
    expect(discoveryProgress(example, 'agents')).toEqual({ seen: true, tried: false, skipped: false });
    const real = { ...context, currentHref: '/s/real', sessionId: 'real', sessionReachable: true, anchors: ['agent-panel'] as const };
    const failed = await tryDiscoveryAction(state, 'agent-panel', real, { perform: async () => 'unavailable' });
    expect(failed).toBe(state);
    const tried = await tryDiscoveryAction(state, 'agent-panel', real, { perform });
    expect(discoveryProgress(tried, 'agents').tried).toBe(true);
    const controller = new AbortController();
    const stale = await tryDiscoveryAction(state, 'agent-panel', real, {
      perform: async () => { controller.abort(); return 'done'; },
    }, controller.signal);
    expect(stale).toBe(state);
    expect(discoveryTryActions('capabilities', { ...context, anchors: ['capability-detail'] })).toEqual([]);
    expect(discoveryTryActions('workspace', { ...context, draftEmpty: false }).some((action) => action.kind === 'draft')).toBe(false);
    expect(discoveryTryActions('workspace', context).find((action) => action.kind === 'draft')).toMatchObject({ send: false, overwrite: false });
    expect(discoveryTryActions('cron', { ...context, currentHref: '/cron', data: { cron: false }, anchors: ['cron-detail'] })).toEqual([{ kind: 'example', id: 'cron', labelKey: 'discovery.action.example' }]);
    expect(discoveryCanReturn({ scope, visitId: 'before-tour' }, { ...scope, homeId: 'other' })).toBe(false);
  });
});

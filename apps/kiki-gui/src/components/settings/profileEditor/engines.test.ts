// @vitest-environment jsdom

/**
 * Which engines the profile / execution pickers may list, and the display
 * choice that decides it.
 *
 * Two rules are load-bearing and easy to break independently:
 * - a new choice requires an explicit on; a missing flag leaves the engine out,
 *   and an explicit off stays off across refresh and import;
 * - the choice is *display only* — it never removes an engine from the catalog
 *   the server launches, and never stops a session already bound to one.
 */

import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';

import {
  DEFAULT_ENGINE_VISIBILITY,
  applyExecutorCheck,
  configuredEngineDescriptors,
  engineChoices,
  engineDisplayOf,
  engineOverridesOf,
  engineVisibilityOf,
  engineVisibilityPatch,
  executorCatalogQueryKey,
  isConfiguredEngine,
  shouldAutoEnableEngine,
  visibleEngines,
} from './engines';

function engine(id: string): ExecutorCatalogItem {
  return {
    id,
    label: id,
    protocol: 'acp-v1',
    status: id === 'native' ? 'ready' : 'unavailable',
    model_binding: 'mapped',
    thinking_binding: 'mapped',
  };
}

function profile(name: string, executor?: string): NamedAgentProfile {
  return { name, main: true, ...(executor === undefined ? {} : { executor }) } as NamedAgentProfile;
}

const CATALOG = [engine('native'), engine('claude-acp'), engine('codex-app-server'), engine('grok-acp')];

describe('executorCatalogQueryKey', () => {
  it('isolates a late catalog response from another scope or server incarnation', async () => {
    const cache = new QueryClient();
    const oldKey = executorCatalogQueryKey('example-scope', 'old-server');
    const newKey = executorCatalogQueryKey('example-scope', 'new-server');
    const otherKey = executorCatalogQueryKey('other-scope', 'new-server');
    let release!: (value: { items: ExecutorCatalogItem[] }) => void;
    const old = cache.fetchQuery({ queryKey: oldKey, queryFn: () => new Promise<{ items: ExecutorCatalogItem[] }>((resolve) => { release = resolve; }) });
    cache.setQueryData(newKey, { items: [engine('native')] });
    cache.setQueryData(otherKey, { items: [engine('grok-acp')] });
    release({ items: [engine('claude-acp')] });
    await old;
    expect(cache.getQueryData(newKey)).toEqual({ items: [engine('native')] });
    expect(cache.getQueryData(otherKey)).toEqual({ items: [engine('grok-acp')] });
    await cache.invalidateQueries({ queryKey: ['executors'] });
    expect(cache.getQueryState(newKey)?.isInvalidated).toBe(true);
    cache.clear();
  });
});

describe('isConfiguredEngine', () => {
  it('treats native as always configured', () => {
    expect(isConfiguredEngine('native', [], undefined)).toBe(true);
    expect(isConfiguredEngine('', [], undefined)).toBe(true);
  });

  it('is false for an external engine nobody has set up', () => {
    expect(isConfiguredEngine('claude-acp', [], undefined)).toBe(false);
    // The shipped descriptor declaring a default profile is not setup: every
    // engine has it, so it would make the test true for all of them.
    expect(isConfiguredEngine('claude-acp', [], undefined)).toBe(false);
  });

  it('is true once a profile binds the engine', () => {
    const profiles = [profile('lead-claude', 'claude-acp')];
    expect(isConfiguredEngine('claude-acp', profiles, undefined)).toBe(true);
    expect(isConfiguredEngine('codex-app-server', profiles, undefined)).toBe(false);
  });

  it('is true once the user pointed Kiki at the engine with an override', () => {
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { bin_path: '/opt/codex' } })).toBe(true);
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { home_dir: '/srv/codex' } })).toBe(true);
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { args: ['--yolo'] } })).toBe(true);
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { env: { KEY: 'v' } } })).toBe(true);
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { defaults: { model_alias: 'x' } } })).toBe(true);
    // An empty record is not an override; it is the shape a hidden engine's
    // cleared field leaves behind.
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': {} })).toBe(false);
  });

  it('does not count the display preference as configuration', () => {
    // A user who hid an engine has looked at its visibility; that says nothing
    // about whether the machine can run it. Counting this would make hiding the
    // thing that "configures" an engine.
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { show_in_profile_list: false } })).toBe(false);
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { show_in_profile_list: true } })).toBe(false);
    // A real field beside the display flag still counts.
    expect(isConfiguredEngine('codex-app-server', [],
      { 'codex-app-server': { show_in_profile_list: false, bin_path: '/opt/codex' } })).toBe(true);
  });

  it('is true once the user authored a descriptor for the engine', () => {
    const descriptors = { 'grok-acp': { protocol: 'acp', command: 'grok' } };
    expect(isConfiguredEngine('grok-acp', [], undefined, descriptors)).toBe(true);
    expect(isConfiguredEngine('claude-acp', [], undefined, descriptors)).toBe(false);
    expect(isConfiguredEngine('grok-acp', [], undefined, undefined)).toBe(false);
  });
});

describe('engineVisibilityOf', () => {
  it('offers no external engine when nothing has been chosen', () => {
    expect(engineVisibilityOf(undefined)).toEqual(DEFAULT_ENGINE_VISIBILITY);
    expect(engineVisibilityOf({})).toEqual(DEFAULT_ENGINE_VISIBILITY);
    expect(DEFAULT_ENGINE_VISIBILITY.enabled.size).toBe(0);
    expect(DEFAULT_ENGINE_VISIBILITY.disabled.size).toBe(0);
    expect(DEFAULT_ENGINE_VISIBILITY.externalsVisible).toBe(true);
  });

  it('reads an explicit on and an explicit off, and ignores an absent flag', () => {
    const prefs = engineVisibilityOf({
      'claude-acp': { show_in_profile_list: false },
      'codex-app-server': { show_in_profile_list: true },
      'grok-acp': { bin_path: '/opt/grok' },
    });
    expect(prefs.disabled.has('claude-acp')).toBe(true);
    expect(prefs.enabled.has('codex-app-server')).toBe(true);
    expect(prefs.enabled.has('grok-acp')).toBe(false);
    expect(prefs.disabled.has('grok-acp')).toBe(false);
    expect(prefs.externalsVisible).toBe(true);
  });

  it('reads the global switch from its own section without turning engines on', () => {
    expect(engineVisibilityOf({}, { externals_visible: false }).externalsVisible).toBe(false);
    expect(engineVisibilityOf({}, { externals_visible: true }).externalsVisible).toBe(true);
    expect(engineVisibilityOf({}, {}).externalsVisible).toBe(true);
    expect(engineVisibilityOf({}, { externals_visible: true }).enabled.size).toBe(0);
  });

  it('reads a shape it does not know as neither on nor off', () => {
    expect(engineVisibilityOf({ 'claude-acp': 'nonsense' }).enabled.size).toBe(0);
    expect(engineVisibilityOf({ 'claude-acp': 'nonsense' }).disabled.size).toBe(0);
    expect(engineVisibilityOf({ 'claude-acp': { show_in_profile_list: 'no' } }).disabled.size).toBe(0);
    expect(engineVisibilityOf({}, { externals_visible: 'no' }).externalsVisible).toBe(true);
  });
});

describe('engineVisibilityPatch', () => {
  it('writes an explicit off and an explicit on, including the first on', () => {
    const prefs = engineVisibilityOf({});
    expect(engineVisibilityPatch(prefs, { engine: { id: 'claude-acp', visible: false } }))
      .toEqual({ agent_executor_overrides: { 'claude-acp': { show_in_profile_list: false } } });
    expect(engineVisibilityPatch(prefs, { engine: { id: 'claude-acp', visible: true } }))
      .toEqual({ agent_executor_overrides: { 'claude-acp': { show_in_profile_list: true } } });
    expect(engineVisibilityPatch(engineVisibilityOf({ 'claude-acp': { show_in_profile_list: false } }), { engine: { id: 'claude-acp', visible: true } }))
      .toEqual({ agent_executor_overrides: { 'claude-acp': { show_in_profile_list: true } } });
  });

  it('writes nothing when the value already says that', () => {
    const prefs = engineVisibilityOf({ 'claude-acp': { show_in_profile_list: false } });
    expect(engineVisibilityPatch(prefs, { engine: { id: 'claude-acp', visible: false } })).toBeUndefined();
    expect(engineVisibilityPatch(engineVisibilityOf({}), { externals: true })).toBeUndefined();
  });

  it('writes the global switch to its own section', () => {
    expect(engineVisibilityPatch(engineVisibilityOf({}), { externals: false })).toEqual({
      agent_executor_display: { externals_visible: false },
    });
  });

  it('round-trips the global switch through the reader', () => {
    const prefs = engineVisibilityOf({}, { externals_visible: false });
    const patch = engineVisibilityPatch(prefs, { externals: true })!;
    const stored = patch['agent_executor_display'] as Record<string, unknown>;
    expect(engineVisibilityOf({}, stored).externalsVisible).toBe(true);
  });

  it('round-trips through the reader', () => {
    const patch = engineVisibilityPatch(engineVisibilityOf({}), { engine: { id: 'grok-acp', visible: false } });
    const stored = { 'grok-acp': (patch!['agent_executor_overrides'] as Record<string, unknown>)['grok-acp'] };
    expect(engineVisibilityOf(stored).disabled.has('grok-acp')).toBe(true);
    const enabled = engineVisibilityPatch(engineVisibilityOf({}), { engine: { id: 'grok-acp', visible: true } });
    const enabledStored = { 'grok-acp': (enabled!['agent_executor_overrides'] as Record<string, unknown>)['grok-acp'] };
    expect(engineVisibilityOf(enabledStored).enabled.has('grok-acp')).toBe(true);
    expect(engineVisibilityPatch(engineVisibilityOf(enabledStored), { engine: { id: 'grok-acp', visible: true } })).toBeUndefined();
  });
});

describe('visibleEngines', () => {
  const ready = (id: string): ExecutorCatalogItem => ({ ...engine(id), status: 'ready', connection: { login_status: 'logged_in', default_args: [] } });
  const on = (id: string) => ({ [id]: { show_in_profile_list: true } });
  it('does not offer a ready authenticated engine until it is explicitly on', () => {
    const catalog = [engine('native'), ready('claude-acp')];
    expect(visibleEngines(catalog, [], undefined).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines(catalog, [], on('claude-acp')).map(item => item.id)).toEqual(['native', 'claude-acp']);
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: false } }).map(item => item.id)).toEqual(['native']);
  });
  it('keeps an enabled engine whose login is still unknown, without calling that unknown ready', () => {
    const claude = { ...engine('claude-acp'), status: 'unknown' as const, connection: { login_status: 'unknown' as const, default_args: [] } };
    expect(visibleEngines([engine('native'), claude], [], undefined).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines([engine('native'), claude], [], on('claude-acp')).map(item => item.id)).toEqual(['native', 'claude-acp']);
    expect(claude.status).toBe('unknown');
    expect(claude.connection.login_status).toBe('unknown');
  });
  it('drops logged-out, unavailable and globally blocked engines even when the flag is on', () => {
    const pending: ExecutorCatalogItem = { ...engine('claude-acp'), status: 'unknown', connection: { login_status: 'unknown', default_args: [] } };
    const loggedOut = { ...pending, status: 'ready' as const, connection: { login_status: 'logged_out' as const, default_args: [] } };
    expect(visibleEngines([loggedOut], [], on('claude-acp'))).toEqual([]);
    expect(visibleEngines([{ ...pending, status: 'unavailable' }], [], on('claude-acp'))).toEqual([]);
    expect(visibleEngines([engine('native'), ready('claude-acp')], [], on('claude-acp'), { externals_visible: false }).map(item => item.id)).toEqual(['native']);
  });
  it('does not mistake a profile or launch override for an on switch or a vendor login', () => {
    const catalog = [engine('native'), { ...engine('claude-acp'), status: 'ready' as const, connection: { login_status: 'logged_out' as const, default_args: [] } }];
    expect(visibleEngines(catalog, [profile('lead', 'claude-acp')], { 'claude-acp': { bin_path: '/opt/claude', defaults: { model_alias: 'native-default' }, show_in_profile_list: true } }).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines([engine('native'), ready('claude-acp')], [profile('lead', 'claude-acp')], { 'claude-acp': { bin_path: '/opt/claude' } }).map(item => item.id)).toEqual(['native']);
  });
  it('never revives a missing binary through a configured descriptor or profile', () => {
    expect(visibleEngines(CATALOG, [profile('lead', 'claude-acp')], on('claude-acp'), undefined, { 'claude-acp': { protocol: 'acp-v1', command: 'claude' } }).map(item => item.id)).toEqual(['native']);
  });
  it('still requires the on switch when server discovery says the binary is ready', () => {
    const catalog = [engine('native'), { ...engine('local-acp'), status: 'ready' as const }];
    for (const descriptor of [undefined, {}, { protocol: 'acp-v1', command: 'local-server' }]) {
      expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': descriptor }).map(item => item.id)).toEqual(['native']);
      expect(visibleEngines(catalog, [], on('local-acp'), undefined, { 'local-acp': descriptor }).map(item => item.id)).toEqual(['native', 'local-acp']);
    }
  });
  it('accepts only the declared vendor API-key environment when the login is checked logged out', () => {
    const catalog = [engine('native'), { ...engine('claude-acp'), status: 'ready' as const, connection: { login_status: 'logged_out' as const, default_args: [], api_key_env: 'VENDOR_API_KEY' } }];
    const enabled = { 'claude-acp': { show_in_profile_list: true, env: { OTHER_SETTING: 'fixture' } } };
    expect(visibleEngines(catalog, [], enabled).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: true, env: { VENDOR_API_KEY: 'fixture' } } }).map(item => item.id)).toEqual(['native', 'claude-acp']);
  });
  it('keeps an explicit off when another enabled engine remains', () => {
    const catalog = [engine('native'), ready('claude-acp'), ready('codex-app-server')];
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: false }, 'codex-app-server': { show_in_profile_list: true } }).map(item => item.id)).toEqual(['native', 'codex-app-server']);
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: true }, 'codex-app-server': { show_in_profile_list: true } }, { externals_visible: false }).map(item => item.id)).toEqual(['native']);
  });
});

describe('engineChoices', () => {
  it('offers native and explicitly enabled engines, and keeps only the retained identity', () => {
    const overrides = { 'claude-acp': { show_in_profile_list: true }, 'codex-app-server': { show_in_profile_list: false } };
    expect(engineChoices([profile('lead', 'grok-acp'), profile('other', 'codex-app-server')], CATALOG, { overrides }))
      .toEqual(['', 'claude-acp']);
    expect(engineChoices([], CATALOG, { overrides, retain: ['codex-app-server', 'missing-acp', 'native', ''] }))
      .toEqual(['', 'claude-acp', 'codex-app-server', 'missing-acp']);
  });

  it('does not put disabled engines back when the global switch is closed, except the retained one', () => {
    const overrides = { 'claude-acp': { show_in_profile_list: true } };
    expect(engineChoices([], CATALOG, { overrides, display: { externals_visible: false }, retain: ['grok-acp'] }))
      .toEqual(['', 'grok-acp']);
  });
});

describe('shouldAutoEnableEngine', () => {
  it('turns a successful first setup on and leaves a failure or an explicit off alone', () => {
    expect(shouldAutoEnableEngine(undefined, 'claude-acp', 'ready')).toBe(true);
    expect(shouldAutoEnableEngine(undefined, 'claude-acp', 'warning')).toBe(true);
    expect(shouldAutoEnableEngine(undefined, 'claude-acp', 'unavailable')).toBe(false);
    expect(shouldAutoEnableEngine({ 'claude-acp': { show_in_profile_list: false } }, 'claude-acp', 'ready')).toBe(false);
    expect(shouldAutoEnableEngine({ 'claude-acp': { show_in_profile_list: true } }, 'claude-acp', 'ready')).toBe(false);
  });
});

describe('applyExecutorCheck', () => {
  it('updates only the checked engine in that scope and server cache', () => {
    const cache = new QueryClient();
    const key = executorCatalogQueryKey('scope-a', 'server-1');
    const other = executorCatalogQueryKey('scope-b', 'server-1');
    const claude = engine('claude-acp');
    const codex = engine('codex-app-server');
    cache.setQueryData(key, { items: [claude, codex] });
    cache.setQueryData(other, { items: [claude, codex] });
    applyExecutorCheck(cache, key, 'claude-acp', {
      id: 'claude-acp', status: 'warning', version: '2.1.0', command: 'claude', resolved_args: [],
      login_status: 'logged_out', diagnostics: [],
    }, '2026-10-12T00:00:00.000Z');
    const updated = cache.getQueryData<{ items: ExecutorCatalogItem[] }>(key)!;
    expect(updated.items.find((item) => item.id === 'claude-acp')).toMatchObject({
      status: 'ready', check_status: 'warning', checked_at: '2026-10-12T00:00:00.000Z', check_stale: false,
      connection: { login_status: 'logged_out', command: 'claude' },
    });
    expect(updated.items.find((item) => item.id === 'codex-app-server')?.check_status).toBeUndefined();
    expect(cache.getQueryData(other)).toEqual({ items: [claude, codex] });
    cache.clear();
  });
});

describe('engineOverridesOf', () => {
  it('reads the section out of a config echo, in its snake shape', () => {
    expect(engineOverridesOf({ raw: { agent_executor_overrides: { 'claude-acp': { bin_path: 'x' } } } }))
      .toEqual({ 'claude-acp': { bin_path: 'x' } });
  });

  it('is undefined for a config without one, or with a shape it cannot trust', () => {
    expect(engineOverridesOf(undefined)).toBeUndefined();
    expect(engineOverridesOf({})).toBeUndefined();
    expect(engineOverridesOf({ raw: {} })).toBeUndefined();
    expect(engineOverridesOf({ raw: { agent_executor_overrides: 'nope' } })).toBeUndefined();
    expect(engineOverridesOf({ raw: { agent_executor_overrides: [] } })).toBeUndefined();
  });
});

describe('engineDisplayOf and configuredEngineDescriptors', () => {
  it('reads the global display section and the authored descriptors', () => {
    const config = {
      raw: {
        agent_executor_display: { externals_visible: false },
        agent_executors: { 'grok-acp': { protocol: 'acp' } },
      },
    };
    expect(engineDisplayOf(config)).toEqual({ externals_visible: false });
    expect(configuredEngineDescriptors(config)).toEqual({ 'grok-acp': { protocol: 'acp' } });
  });

  it('is undefined when absent or untrustworthy, never a partial guess', () => {
    expect(engineDisplayOf(undefined)).toBeUndefined();
    expect(engineDisplayOf({ raw: {} })).toBeUndefined();
    expect(engineDisplayOf({ raw: { agent_executor_display: 'no' } })).toBeUndefined();
    expect(configuredEngineDescriptors({ raw: { agent_executors: [] } })).toBeUndefined();
  });
});

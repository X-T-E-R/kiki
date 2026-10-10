// @vitest-environment jsdom

/**
 * Which engines the profile / execution pickers may list, and the display
 * choice that decides it.
 *
 * Two rules are load-bearing and easy to break independently:
 * - an external engine the machine was never set up for is not a choice, so it
 *   stays out of the list;
 * - the choice is *display only* — it never removes an engine from the catalog
 *   the server launches, and never stops a session already bound to one.
 */

import { describe, expect, it } from 'vitest';

import type { ExecutorCatalogItem, NamedAgentProfile } from '@kiki/protocol';

import {
  DEFAULT_ENGINE_VISIBILITY,
  configuredEngineDescriptors,
  engineDisplayOf,
  engineOverridesOf,
  engineVisibilityOf,
  engineVisibilityPatch,
  isConfiguredEngine,
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
  it('shows everything when nothing has been chosen', () => {
    expect(engineVisibilityOf(undefined)).toEqual(DEFAULT_ENGINE_VISIBILITY);
    expect(engineVisibilityOf({})).toEqual(DEFAULT_ENGINE_VISIBILITY);
  });

  it('reads a per-engine opt-out', () => {
    const prefs = engineVisibilityOf({ 'claude-acp': { show_in_profile_list: false } });
    expect(prefs.hidden.has('claude-acp')).toBe(true);
    expect(prefs.externalsVisible).toBe(true);
  });

  it('reads the global switch from its own section', () => {
    expect(engineVisibilityOf({}, { externals_visible: false }).externalsVisible).toBe(false);
    expect(engineVisibilityOf({}, { externals_visible: true }).externalsVisible).toBe(true);
    // The server echoes an unset section as `{}`, which is also "show".
    expect(engineVisibilityOf({}, {}).externalsVisible).toBe(true);
  });

  it('reads a shape it does not know as "show", never as hidden', () => {
    // The failure mode of a preference is hiding an engine someone still uses.
    expect(engineVisibilityOf({ 'claude-acp': 'nonsense' }).hidden.size).toBe(0);
    expect(engineVisibilityOf({ 'claude-acp': { show_in_profile_list: 'no' } }).hidden.size).toBe(0);
    expect(engineVisibilityOf({}, { externals_visible: 'no' }).externalsVisible).toBe(true);
  });
});

describe('engineVisibilityPatch', () => {
  it('writes an explicit hide and an explicit show', () => {
    const prefs = engineVisibilityOf({});
    expect(engineVisibilityPatch(prefs, { engine: { id: 'claude-acp', visible: false } }))
      .toEqual({ agent_executor_overrides: { 'claude-acp': { show_in_profile_list: false } } });
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
    expect(engineVisibilityOf(stored).hidden.has('grok-acp')).toBe(true);
  });
});

describe('visibleEngines', () => {
  const ready = (id: string): ExecutorCatalogItem => ({ ...engine(id), status: 'ready', connection: { login_status: 'logged_in', default_args: [] } });
  it('offers a ready authenticated bare harness without a Kiki profile or model', () => {
    const catalog = [engine('native'), ready('claude-acp')];
    expect(visibleEngines(catalog, [], undefined).map(item => item.id)).toEqual(['native', 'claude-acp']);
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: false } }).map(item => item.id)).toEqual(['native']);
  });
  it('hides an installed harness without its own configuration despite a profile or launch override', () => {
    const catalog = [engine('native'), { ...engine('claude-acp'), status: 'ready' as const }];
    expect(visibleEngines(catalog, [profile('lead', 'claude-acp')], { 'claude-acp': { bin_path: '/opt/claude', defaults: { model_alias: 'native-default' } } }).map(item => item.id)).toEqual(['native']);
  });
  it('never revives a missing binary through a configured descriptor or profile', () => {
    expect(visibleEngines(CATALOG, [profile('lead', 'claude-acp')], undefined, undefined, { 'claude-acp': { protocol: 'acp-v1', command: 'claude' } }).map(item => item.id)).toEqual(['native']);
  });
  it('accepts a ready user-authored anonymous local descriptor but not an empty object', () => {
    const catalog = [engine('native'), { ...engine('local-acp'), status: 'ready' as const }];
    expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': {} }).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': { protocol: 'acp-v1', command: 'local-server' } }).map(item => item.id)).toEqual(['native', 'local-acp']);
    expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': { protocol: 'acp-v1', sources: [{ id: 'local', kind: 'path-lookup', command: 'local-server' }] } }).map(item => item.id)).toEqual(['native', 'local-acp']);
    expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': { protocol: 'acp-v1', sources: [{}] } }).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines(catalog, [], undefined, undefined, { 'local-acp': { protocol: 'acp-v1', source: 'missing', sources: [{ id: 'local', kind: 'path-lookup', command: 'local-server' }] } }).map(item => item.id)).toEqual(['native']);
  });
  it('accepts only the declared vendor API-key environment rather than arbitrary launch settings', () => {
    const catalog = [engine('native'), { ...engine('claude-acp'), status: 'ready' as const, connection: { login_status: 'unknown' as const, default_args: [], api_key_env: 'VENDOR_API_KEY' } }];
    expect(visibleEngines(catalog, [], { 'claude-acp': { env: { OTHER_SETTING: 'fixture' } } }).map(item => item.id)).toEqual(['native']);
    expect(visibleEngines(catalog, [], { 'claude-acp': { env: { VENDOR_API_KEY: 'fixture' } } }).map(item => item.id)).toEqual(['native', 'claude-acp']);
  });
  it('keeps visibility preferences separate from readiness', () => {
    const catalog = [engine('native'), ready('claude-acp'), ready('codex-app-server')];
    expect(visibleEngines(catalog, [], { 'claude-acp': { show_in_profile_list: false } }).map(item => item.id)).toEqual(['native', 'codex-app-server']);
    expect(visibleEngines(catalog, [], undefined, { externals_visible: false }).map(item => item.id)).toEqual(['native']);
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
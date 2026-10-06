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
  EXTERNAL_VISIBILITY_KEY,
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
    status: 'ready',
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
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': { binPath: 'codex' } })).toBe(true);
    // An empty record is not an override; it is the shape a hidden engine's
    // cleared field leaves behind.
    expect(isConfiguredEngine('codex-app-server', [], { 'codex-app-server': {} })).toBe(false);
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

  it('reads the global switch', () => {
    const prefs = engineVisibilityOf({ [EXTERNAL_VISIBILITY_KEY]: { externals_visible: false } });
    expect(prefs.externalsVisible).toBe(false);
  });

  it('reads a shape it does not know as "show", never as hidden', () => {
    // The failure mode of a preference is hiding an engine someone still uses.
    expect(engineVisibilityOf({ 'claude-acp': 'nonsense' }).hidden.size).toBe(0);
    expect(engineVisibilityOf({ 'claude-acp': { show_in_profile_list: 'no' } }).hidden.size).toBe(0);
    expect(engineVisibilityOf({ [EXTERNAL_VISIBILITY_KEY]: { externals_visible: 'no' } }).externalsVisible).toBe(true);
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

  it('writes the global switch as its own record', () => {
    expect(engineVisibilityPatch(engineVisibilityOf({}), { externals: false })).toEqual({
      agent_executor_overrides: { [EXTERNAL_VISIBILITY_KEY]: { externals_visible: false } },
    });
  });

  it('round-trips through the reader', () => {
    const patch = engineVisibilityPatch(engineVisibilityOf({}), { engine: { id: 'grok-acp', visible: false } });
    const stored = { 'grok-acp': (patch!['agent_executor_overrides'] as Record<string, unknown>)['grok-acp'] };
    expect(engineVisibilityOf(stored).hidden.has('grok-acp')).toBe(true);
  });
});

describe('visibleEngines', () => {
  it('keeps native and lists an engine the machine is set up for', () => {
    const profiles = [profile('lead-claude', 'claude-acp')];
    expect(visibleEngines(CATALOG, profiles, undefined).map((item) => item.id))
      .toEqual(['native', 'claude-acp']);
  });

  it('lists nothing external on a machine that set nothing up', () => {
    expect(visibleEngines(CATALOG, [], undefined).map((item) => item.id)).toEqual(['native']);
  });

  it('drops an engine the user hid, and every engine when the global switch is off', () => {
    const profiles = [profile('lead-claude', 'claude-acp'), profile('lead-codex', 'codex-app-server')];
    const hidden = { 'claude-acp': { show_in_profile_list: false } };
    expect(visibleEngines(CATALOG, profiles, hidden).map((item) => item.id))
      .toEqual(['native', 'codex-app-server']);
    const all = { [EXTERNAL_VISIBILITY_KEY]: { externals_visible: false } };
    expect(visibleEngines(CATALOG, profiles, all).map((item) => item.id)).toEqual(['native']);
  });

  it('still lists a hidden engine that has a profile, because that profile needs it', () => {
    // Hiding is a display preference over *unconfigured* engines; a profile
    // bound to it is the reason the engine is here at all.
    const profiles = [profile('lead-claude', 'claude-acp')];
    const hidden = { 'claude-acp': { show_in_profile_list: false } };
    expect(visibleEngines(CATALOG, profiles, hidden).map((item) => item.id)).toEqual(['native']);
  });
});

describe('engineOverridesOf', () => {
  it('reads the section out of a config echo', () => {
    expect(engineOverridesOf({ raw: { agent_executor_overrides: { 'claude-acp': { binPath: 'x' } } } }))
      .toEqual({ 'claude-acp': { binPath: 'x' } });
  });

  it('is undefined for a config without one, or with a shape it cannot trust', () => {
    expect(engineOverridesOf(undefined)).toBeUndefined();
    expect(engineOverridesOf({})).toBeUndefined();
    expect(engineOverridesOf({ raw: {} })).toBeUndefined();
    expect(engineOverridesOf({ raw: { agent_executor_overrides: 'nope' } })).toBeUndefined();
    expect(engineOverridesOf({ raw: { agent_executor_overrides: [] } })).toBeUndefined();
  });
});
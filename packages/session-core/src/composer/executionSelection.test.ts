import { describe, expect, it } from 'vitest';

import {
  boundExecutionChoice,
  executionChoice,
  executionSelectionOf,
  isNativeExecutor,
  NATIVE_EXECUTOR,
  overrideFor,
  isBareExternalChoice,
  sendsLegacyControl,
  profileExecutor,
  profilesForExecutor,
  profileMatchesExecutor,
  sameExecutionChoice,
  type ExecutionChoice,
} from './executionSelection';

const native = (profile?: string): ExecutionChoice => ({
  executor: NATIVE_EXECUTOR,
  profile,
  overrides: undefined,
});

const bare = (executor: string): ExecutionChoice => ({
  executor,
  profile: undefined,
  overrides: undefined,
});

describe('profileExecutor', () => {
  it('reads an absent or native executor as the native engine', () => {
    expect(profileExecutor({ executor: undefined })).toBe('native');
    expect(profileExecutor({ executor: '' })).toBe('native');
    expect(profileExecutor({ executor: 'native' })).toBe('native');
    expect(profileExecutor({ executor: 'claude-acp' })).toBe('claude-acp');
  });
});

describe('isNativeExecutor', () => {
  it('accepts only the empty and native spellings', () => {
    expect(isNativeExecutor(undefined)).toBe(true);
    expect(isNativeExecutor('')).toBe(true);
    expect(isNativeExecutor('native')).toBe(true);
    expect(isNativeExecutor('claude-acp')).toBe(false);
  });
});

describe('executionSelectionOf', () => {
  it('leaves an untouched pick without a profile or overrides field', () => {
    expect(executionSelectionOf(bare('claude-acp'))).toEqual({ executor: 'claude-acp' });
    expect(executionSelectionOf(native())).toEqual({ executor: 'native' });
  });

  it('writes only the overrides the user actually set', () => {
    expect(executionSelectionOf({
      executor: 'codex-app-server',
      profile: 'reviewer',
      overrides: { kiki_context: [] },
    })).toEqual({ executor: 'codex-app-server', profile: 'reviewer', overrides: { kiki_context: [] } });
  });

  it('round-trips through executionChoice without inventing values', () => {
    const selection = { executor: 'claude-acp', overrides: { allow_kiki_subagents: false } };
    expect(executionSelectionOf(executionChoice(selection))).toEqual(selection);
  });
});

describe('boundExecutionChoice', () => {
  it('reads the committed binding when the server reports one', () => {
    expect(boundExecutionChoice({
      version: 1,
      selection: { executor: 'claude-acp' },
      effective: { kiki_context: [], allow_kiki_subagents: false },
      sources: {},
      generation: 1,
    })).toEqual({ executor: 'claude-acp', profile: undefined, overrides: undefined });
  });

  it('reads a server without the projection as a native main profile', () => {
    expect(boundExecutionChoice(undefined, 'reviewer')).toEqual({
      executor: 'native', profile: 'reviewer', overrides: undefined,
    });
  });

  it('falls back to the bare native engine with no profile named', () => {
    expect(boundExecutionChoice(undefined, undefined)).toEqual(native());
  });
});

describe('sameExecutionChoice', () => {
  it('separates an absent override from an explicit one', () => {
    const left: ExecutionChoice = { executor: 'claude-acp', profile: undefined, overrides: undefined };
    const right: ExecutionChoice = { executor: 'claude-acp', profile: undefined, overrides: {} };
    expect(sameExecutionChoice(left, right)).toBe(true);
  });

  it('treats an explicit empty context list as different from an absent one', () => {
    const left: ExecutionChoice = { executor: 'claude-acp', profile: undefined, overrides: { kiki_context: [] } };
    const right: ExecutionChoice = { executor: 'claude-acp', profile: undefined, overrides: { kiki_context: ['memory'] } };
    expect(sameExecutionChoice(left, right)).toBe(false);
  });

  it('is false when one side is undefined', () => {
    expect(sameExecutionChoice(undefined, bare('claude-acp'))).toBe(false);
    expect(sameExecutionChoice(undefined, undefined)).toBe(true);
  });
});

describe('profilesForExecutor', () => {
  const catalog = [
    { name: 'agent', main: true, executor: undefined },
    { name: 'reviewer', main: true, executor: 'claude-acp' },
    { name: 'explore', main: false, executor: 'claude-acp' },
  ] as never;

  it('returns only the pickable profiles of that engine', () => {
    expect(profilesForExecutor(catalog, 'native', (profile) => profile.main === true).map((p) => p.name)).toEqual(['agent']);
    expect(profilesForExecutor(catalog, 'claude-acp', (profile) => profile.main === true).map((p) => p.name)).toEqual(['reviewer']);
  });

  it('is empty for an engine with no profile of its own', () => {
    expect(profilesForExecutor(catalog, 'codex-app-server', () => true)).toEqual([]);
  });
});

describe('profileMatchesExecutor', () => {
  it('accepts no profile at all, and rejects another engine’s profile', () => {
    expect(profileMatchesExecutor(undefined, 'claude-acp')).toBe(true);
    expect(profileMatchesExecutor({ executor: 'claude-acp' } as never, 'claude-acp')).toBe(true);
    expect(profileMatchesExecutor({ executor: 'codex-app-server' } as never, 'claude-acp')).toBe(false);
  });
});

describe('sendsLegacyControl', () => {
  const bare = (overrides?: ExecutionChoice['overrides']): ExecutionChoice =>
    ({ executor: 'claude-acp', profile: undefined, overrides });

  it('withholds every control of a bare engine the user never touched', () => {
    for (const control of ['model', 'thinking', 'permission_mode'] as const) {
      expect(sendsLegacyControl(bare(), control, false)).toBe(false);
    }
  });

  it('sends the controls the user did move', () => {
    expect(sendsLegacyControl(bare(), 'permission_mode', true)).toBe(true);
    expect(sendsLegacyControl(bare(), 'model', false)).toBe(false);
  });

  it('is decided per control, not per selection', () => {
    // Naming a model says nothing about approvals: the engine keeps its own.
    const choice = bare({ model: 'vendor-model', thinking: 'high' });
    // A control the execution names is never duplicated by the legacy field.
    expect(sendsLegacyControl(choice, 'model', true)).toBe(false);
    expect(sendsLegacyControl(choice, 'thinking', true)).toBe(false);
    // One the user moved and the execution leaves alone is still sent.
    expect(sendsLegacyControl(choice, 'permission_mode', true)).toBe(true);
    expect(sendsLegacyControl(choice, 'permission_mode', false)).toBe(false);
    // Untouched controls are withheld regardless of what is named.
    const noModel = bare({ thinking: 'high' });
    expect(sendsLegacyControl(noModel, 'model', false)).toBe(false);
  });

  it('treats a null override as naming the control, not as absent', () => {
    // `null` is "fall through to the next layer"; sending the displayed default
    // would invert that into a decision the user never made.
    const choice = bare({ model: null, permission_mode: null });
    expect(sendsLegacyControl(choice, 'model', true)).toBe(false);
    expect(sendsLegacyControl(choice, 'permission_mode', true)).toBe(false);
  });

  it('never withholds on native execution or when a profile is selected', () => {
    const native: ExecutionChoice = { executor: 'native', profile: 'agent', overrides: undefined };
    const profiled: ExecutionChoice = { executor: 'claude-acp', profile: 'reviewer', overrides: undefined };
    for (const control of ['model', 'thinking', 'permission_mode'] as const) {
      expect(sendsLegacyControl(native, control, false)).toBe(true);
      expect(sendsLegacyControl(profiled, control, false)).toBe(true);
      expect(sendsLegacyControl(undefined, control, false)).toBe(true);
    }
  });
});

describe('isBareExternalChoice', () => {
  it('is true only for an external engine with neither a profile nor overrides', () => {
    expect(isBareExternalChoice({ executor: 'claude-acp', profile: undefined, overrides: undefined })).toBe(true);
    expect(isBareExternalChoice({ executor: 'native', profile: 'agent', overrides: undefined })).toBe(false);
    expect(isBareExternalChoice({ executor: 'claude-acp', profile: 'reviewer', overrides: undefined })).toBe(false);
    expect(isBareExternalChoice({ executor: 'claude-acp', profile: undefined, overrides: { model: 'm' } })).toBe(false);
  });
});

describe('overrideFor', () => {
  it('writes nothing for an untouched value so it keeps inheriting', () => {
    expect(overrideFor('model', undefined)).toEqual({});
  });

  it('writes the value the user chose, including an explicit off', () => {
    expect(overrideFor('kiki_context', [])).toEqual({ kiki_context: [] });
    expect(overrideFor('allow_kiki_subagents', false)).toEqual({ allow_kiki_subagents: false });
  });
});

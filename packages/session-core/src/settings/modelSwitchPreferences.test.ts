import { describe, expect, it } from 'vitest';

import {
  matchesModelSwitchPattern,
  modelSwitchPreferencesToWire,
  previewModelSwitchRule,
  readModelSwitchPreferences,
  rememberModelSwitchChoice,
  resolveModelSwitchPreferences,
  type ModelSwitchPreferenceRule,
  type ModelSwitchPreferences,
} from './modelSwitchPreferences';

const rule = (id: string, patch: Partial<ModelSwitchPreferenceRule> = {}): ModelSwitchPreferenceRule => ({
  id, enabled: true, mode: 'fresh', ...patch,
});
const preferences = (rules: readonly ModelSwitchPreferenceRule[] = []): ModelSwitchPreferences => ({
  defaultMode: 'direct', confirm: true, rules,
});

const from = 'example/Source-v2';
const to = 'example/target-v3';

describe('model switch preferences', () => {
  it('starts with direct, confirmation and no hidden rules; wire conversion preserves nested order and optional fields', () => {
    expect(readModelSwitchPreferences()).toEqual(preferences());
    const wire = {
      default_mode: 'compact' as const, confirm: false,
      rules: [
        { id: 'first', enabled: false, from_models: [from, 'example/*'], mode: 'fresh' as const },
        { id: 'second', enabled: true, to_models: [to], mode: 'direct' as const, confirm: true },
      ],
    };
    const read = readModelSwitchPreferences(wire);
    expect(read.rules[0]?.fromModels).toEqual([from, 'example/*']);
    expect(read.rules[1]?.toModels).toEqual([to]);
    expect(modelSwitchPreferencesToWire(read)).toEqual(wire);
    expect(read.rules[0]?.fromModels).not.toBe(wire.rules[0]?.from_models);
  });

  it.each([
    ['example/*', from, true], ['*', from, true], ['*Source*', from, true],
    ['example/Source-v?', from, true], ['example/Source-v??', from, false],
    ['example/source-*', from, false], ['Source-*', from, false],
    ['example/[ab]', 'example/a', false], ['example/[ab]', 'example/[ab]', true],
    ['example/{a,b}', 'example/a', false], ['example/(a|b)', 'example/a', false],
    ['example/a.b+$^', 'example/a.b+$^', true], ['example/a.b+$^', 'example/axb', false],
    ['example/\\*', 'example/\\target', true], ['example/\\*', 'example/*', false],
    ['example/?', 'example/文', true], ['example/?', 'example/😀', true],
    ['example/?', 'example/', false], ['example/*', 'example/', true],
  ])('matches only case-sensitive * and ? (%s)', (pattern, canonicalId, expected) => {
    expect(matchesModelSwitchPattern(pattern, canonicalId)).toBe(expected);
  });

  it('uses side AND, list OR, omitted-side any, and the same preview for resolution', () => {
    const candidate = rule('both', { fromModels: ['other/*', 'example/Source-*'], toModels: ['other/*', 'example/target-?3'] });
    expect(previewModelSwitchRule(candidate, from, to)).toEqual({ fromMatches: true, toMatches: true, matches: true });
    expect(previewModelSwitchRule(candidate, 'example/wrong', to)).toEqual({ fromMatches: false, toMatches: true, matches: false });
    expect(previewModelSwitchRule(candidate, from, 'example/target-v4')).toEqual({ fromMatches: true, toMatches: false, matches: false });
    expect(previewModelSwitchRule(rule('any'), from, to).matches).toBe(true);
    expect(previewModelSwitchRule(rule('disabled', { enabled: false }), from, to)).toEqual({ fromMatches: true, toMatches: true, matches: false });
    expect(resolveModelSwitchPreferences(preferences([candidate]), from, to).matchedRuleId).toBe('both');
  });

  it('uses first enabled match, inherits confirmation, and honors reorder and explicit choice', () => {
    const rules = [rule('disabled', { enabled: false }), rule('no-match', { toModels: ['different'] }), rule('first'), rule('second', { mode: 'compact', confirm: false })];
    const prefs = preferences(rules);
    expect(resolveModelSwitchPreferences(prefs, from, to)).toEqual({ mode: 'fresh', confirm: true, matchedRuleId: 'first', matchedRuleIndex: 2 });
    expect(resolveModelSwitchPreferences({ ...prefs, confirm: false }, from, to).confirm).toBe(false);
    expect(resolveModelSwitchPreferences(preferences([rules[3]!, rules[2]!]), from, to)).toEqual({ mode: 'compact', confirm: false, matchedRuleId: 'second', matchedRuleIndex: 0 });
    expect(resolveModelSwitchPreferences(prefs, from, to, 'direct').mode).toBe('direct');
    expect(resolveModelSwitchPreferences(preferences([rules[1]!]), from, to)).toMatchObject({ mode: 'direct', confirm: true, matchedRuleId: undefined });
  });

  it('remember updates only the first matching rule mode and confirmation without changing defaults or other rules', () => {
    const prefs = preferences([rule('disabled', { enabled: false }), rule('first', { fromModels: [from] }), rule('second', { mode: 'compact' })]);
    const before = structuredClone(prefs);
    const remembered = rememberModelSwitchChoice(prefs, from, to, 'direct');
    expect(remembered).toEqual({ ...prefs, rules: [prefs.rules[0], { ...prefs.rules[1], mode: 'direct', confirm: false }, prefs.rules[2]] });
    expect(prefs).toEqual(before);
    expect(resolveModelSwitchPreferences(remembered, from, to)).toMatchObject({ mode: 'direct', confirm: false, matchedRuleId: 'first' });
  });

  it('remember falls back to defaults while leaving exceptions and the accepted value snapshot unchanged', () => {
    const prefs = preferences([rule('exception', { fromModels: ['other/model'] })]);
    const accepted = resolveModelSwitchPreferences(prefs, from, to, 'compact');
    const remembered = rememberModelSwitchChoice(prefs, from, to, 'fresh');
    expect(remembered).toEqual({ ...prefs, defaultMode: 'fresh', confirm: false });
    expect(remembered.rules).toEqual(prefs.rules);
    expect(resolveModelSwitchPreferences(remembered, from, to)).toMatchObject({ mode: 'fresh', confirm: false });
    expect(resolveModelSwitchPreferences(remembered, 'other/model', to)).toMatchObject({ mode: 'fresh', confirm: false, matchedRuleId: 'exception' });
    expect(accepted).toMatchObject({ mode: 'compact', confirm: true, matchedRuleId: undefined });
    expect(prefs.defaultMode).toBe('direct');
  });

  it('rejects invalid drafts on serialization rather than writing invalid side lists or duplicate IDs', () => {
    expect(() => modelSwitchPreferencesToWire(preferences([rule('empty', { fromModels: [] })]))).toThrow();
    expect(() => modelSwitchPreferencesToWire(preferences([rule('same'), rule('same')]))).toThrow();
  });
});

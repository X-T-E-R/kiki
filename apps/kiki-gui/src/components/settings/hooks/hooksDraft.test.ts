import { describe, expect, it } from 'vitest';
import { hookRuleConfigSchema, hooksV2ConfigSchema, type HookRuleConfig, type HooksV2Config, type LegacyHookConfig } from '@kiki/protocol';
import { LocalizedError } from '@kiki/session-core/i18n/locale';
import { parseHooksConfigJson } from '@kiki/session-core/settings';

import {
  addDeclarativeRule, addLegacyRule, canFlattenToLegacy, convertToV2, draftFromHooks, draftToHooks,
  flattenToLegacy, formatSelectorLines, hooksDraftJson, hooksDraftPatch, newDeclarativeRule, newLegacyRule,
  parseHooksDraftJson, parseSelectorLines, removeDeclarativeRule, removeLegacyRule, setV2Disabled,
  setV2Enabled, setV2Files, updateDeclarativeRule, updateLegacyRule, validateHooksDraft, type HooksDraft,
} from './hooksDraft';

const legacy: LegacyHookConfig[] = [
  { event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 },
  { event: 'Stop', command: 'echo stopped' },
];

const mixed: HooksV2Config = hooksV2ConfigSchema.parse({
  schemaVersion: 2, enabled: false, disabled: ['reminder', 'external.rule'], files: ['hooks/example.toml'], legacy,
  rules: [
    { id: 'reminder', event: 'step.before', priority: -10, enabled: false,
      match: { models: ['example/model'], profiles: ['helper'], routes: ['native'], executors: ['native'],
        agentRoles: ['root', 'subagent'], tools: ['Read', 'Write'], statuses: ['success', 'error', 'cancelled', 'denied'],
        sources: ['user', 'task', 'mailbox', 'steering'], outcomes: ['completed', 'cancelled', 'failed', 'blocked'] },
      cadence: { everyCompletedSteps: 3, counterScope: 'turn', partitionBy: 'model' }, action: { type: 'inject', text: 'Example guidance' } },
    { id: 'from-file', event: 'prompt.submit', priority: 200, enabled: true, match: {}, action: { type: 'inject', textFile: 'guidance/example.txt' } },
    { id: 'audit', event: 'step.after', priority: 150, enabled: true, match: {},
      cadence: { everyCompletedSteps: 2, counterScope: 'agent', partitionBy: 'model' }, action: { type: 'observe' } },
  ],
});

function ruleDraft(patch: Partial<HookRuleConfig> = {}): HooksDraft {
  const rule = hookRuleConfigSchema.parse({ id: 'example', event: 'prompt.submit', action: { type: 'inject', text: 'Example' } });
  return { shape: 'v2', config: { ...mixed, rules: [{ ...rule, ...patch }] } };
}

function configFrom(draft: HooksDraft): HooksV2Config {
  expect(draft.shape).toBe('v2');
  if (draft.shape !== 'v2') throw new Error('expected v2');
  return draft.config;
}

function caught(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected an error');
}

describe('hooks draft round-trip', () => {
  it.each([legacy, mixed])('preserves all fields and the original config shape', (hooks) => {
    const original = JSON.stringify(hooks);
    const draft = draftFromHooks(hooks);
    expect(draftToHooks(parseHooksDraftJson(hooksDraftJson(draft)))).toEqual(hooks);
    expect(hooksDraftPatch(draft)).toEqual({ hooks });
    expect(validateHooksDraft(draft)).toEqual([]);
    expect(JSON.stringify(hooks)).toBe(original);
  });

  it('round-trips sparse input after applying schema defaults', () => {
    const normalized = parseHooksConfigJson(JSON.stringify({ schemaVersion: 2, rules: [
      { id: 'defaults', event: 'step.before', cadence: { everyCompletedSteps: 1 }, action: { type: 'observe' } },
    ] }));
    const draft = draftFromHooks(normalized);
    expect(draftToHooks(parseHooksDraftJson(hooksDraftJson(draft)))).toEqual(normalized);
    expect(configFrom(draft).rules[0]).toMatchObject({ priority: 100, enabled: true, match: {}, cadence: { counterScope: 'agent', partitionBy: 'model' } });
  });

  it('projects an invalid form without validating or losing fields', () => {
    const draft = ruleDraft({ action: { type: 'inject', text: '' } });
    expect(draftToHooks(draft)).toEqual(configFrom(draft));
    expect(JSON.parse(hooksDraftJson(draft))).toEqual(configFrom(draft));
  });

  it('preserves localized syntax and shape errors from the JSON parser', () => {
    const syntax = caught(() => parseHooksDraftJson('{not json'));
    const shape = caught(() => parseHooksDraftJson('{"schemaVersion":1}'));
    expect(syntax).toBeInstanceOf(LocalizedError);
    expect(syntax).toMatchObject({ issue: { key: 'val.advancedJson' } });
    expect(shape).toBeInstanceOf(LocalizedError);
    expect(shape).toMatchObject({ issue: { key: 'st.hooks.configInvalid' } });
  });
});

describe('hooks draft immutable editing', () => {
  it('changes one rule without losing any other rule or v2 field', () => {
    const original = JSON.stringify(mixed);
    const changed = configFrom(updateDeclarativeRule(draftFromHooks(mixed), 'reminder', { action: { type: 'inject', text: 'Changed' } }));
    expect(changed).toEqual({ ...mixed, rules: [{ ...mixed.rules[0], action: { type: 'inject', text: 'Changed' } }, ...mixed.rules.slice(1)] });
    expect(changed.rules[1]).toBe(mixed.rules[1]);
    expect(JSON.stringify(mixed)).toBe(original);
    const renamed = configFrom(updateDeclarativeRule(draftFromHooks(mixed), 'reminder', { id: 'renamed' }));
    expect(renamed.rules[0]).toMatchObject({ id: 'renamed' });
  });

  it('removes the declarative rule and only its disabled references', () => {
    const changed = configFrom(removeDeclarativeRule(draftFromHooks({ ...mixed, disabled: ['reminder', 'external.rule', 'reminder'] }), 'reminder'));
    expect(changed).toEqual({ ...mixed, rules: mixed.rules.slice(1), disabled: ['external.rule'] });
    expect(removeDeclarativeRule(draftFromHooks(mixed), 'unknown')).toEqual(draftFromHooks(mixed));
  });

  it('creates the first available id with schema defaults and incomplete inject text', () => {
    expect(newDeclarativeRule(['rule-1', 'rule-3'])).toEqual({ id: 'rule-2', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: '' } });
    const added = addDeclarativeRule(draftFromHooks(mixed));
    expect(added.ref).toEqual({ kind: 'declarative', id: 'rule-1' });
    expect(configFrom(added.draft).rules).toEqual([...mixed.rules, newDeclarativeRule([])]);
    expect(validateHooksDraft(added.draft)).not.toEqual([]);
  });

  it.each([draftFromHooks(legacy), draftFromHooks(mixed)])('edits legacy rules in either shape without touching other fields', (draft) => {
    expect(newLegacyRule()).toEqual({ event: 'PreToolUse', command: '' });
    const added = addLegacyRule(draft);
    expect(added.ref).toEqual({ kind: 'legacy', index: 2 });
    const changed = updateLegacyRule(added.draft, 0, { command: 'echo changed' });
    const removed = removeLegacyRule(changed, 2);
    const expected = [{ ...legacy[0], command: 'echo changed' }, legacy[1]];
    expect(draftToHooks(removed)).toEqual(draft.shape === 'legacy' ? expected : { ...mixed, legacy: expected });
    expect(draftToHooks(draft)).toEqual(draft.shape === 'legacy' ? legacy : mixed);
  });

  it('updates each v2 top-level collection independently and copies input arrays', () => {
    const files = ['hooks/other.toml'];
    const ids = ['from-file'];
    const changed = setV2Disabled(setV2Files(setV2Enabled(draftFromHooks(mixed), true), files), ids);
    files.push('later');
    ids.push('later');
    expect(configFrom(changed)).toEqual({ ...mixed, enabled: true, files: ['hooks/other.toml'], disabled: ['from-file'] });
    expect(mixed.enabled).toBe(false);
  });

  it('rejects declarative and v2 setters on a legacy draft', () => {
    const draft = draftFromHooks(legacy);
    for (const run of [() => addDeclarativeRule(draft), () => updateDeclarativeRule(draft, 'rule-1', {}),
      () => removeDeclarativeRule(draft, 'rule-1'), () => setV2Enabled(draft, true), () => setV2Files(draft, []), () => setV2Disabled(draft, [])]) {
      expect(run).toThrowError('not a v2 draft');
    }
  });
});

describe('explicit hooks shape conversion', () => {
  it('preserves legacy rules in a default v2 config and can flatten back', () => {
    const draft = draftFromHooks(legacy);
    expect(canFlattenToLegacy(draft)).toBe(false);
    const converted = convertToV2(draft);
    expect(converted).toEqual({ shape: 'v2', config: { schemaVersion: 2, enabled: true, disabled: [], files: [], rules: [], legacy } });
    expect(convertToV2(converted)).toBe(converted);
    expect(canFlattenToLegacy(converted)).toBe(true);
    expect(flattenToLegacy(converted)).toEqual(draft);
    expect(canFlattenToLegacy(setV2Enabled(converted, false))).toBe(true);
    expect(flattenToLegacy(setV2Enabled(converted, false))).toEqual(draft);
    expect(() => flattenToLegacy(draft)).toThrowError('cannot flatten');
  });

  it.each([
    { rules: mixed.rules, files: [], disabled: [] },
    { rules: [], files: ['hooks/example.toml'], disabled: [] },
    { rules: [], files: [], disabled: ['external.rule'] },
  ])('rejects flattening if v2-only collections would be lost', (collections) => {
    const draft: HooksDraft = { shape: 'v2', config: { ...mixed, ...collections } };
    expect(canFlattenToLegacy(draft)).toBe(false);
    expect(() => flattenToLegacy(draft)).toThrowError('cannot flatten');
  });
});

describe('hooks draft validation paths', () => {
  it('locates invalid commands in both legacy shapes', () => {
    const rules = [...legacy, newLegacyRule()];
    expect(validateHooksDraft(draftFromHooks(rules))).toEqual([
      expect.objectContaining({ path: '2.command', ref: { kind: 'legacy', index: 2 }, field: 'command' }),
    ]);
    expect(validateHooksDraft(draftFromHooks({ ...mixed, legacy: rules }))).toEqual([
      expect.objectContaining({ path: 'legacy.2.command', ref: { kind: 'legacy', index: 2 }, field: 'command' }),
    ]);
  });

  it('locates whitespace-only inject text inside the action', () => {
    expect(validateHooksDraft(ruleDraft({ action: { type: 'inject', text: ' \n\t ' } }))).toContainEqual({
      path: 'rules.0.action.text', message: 'hook text must not be empty', ref: { kind: 'declarative', id: 'example' }, field: 'text',
    });
  });

  it('locates illegal cadence event, invalid ids and invalid nested values', () => {
    expect(validateHooksDraft(ruleDraft({ cadence: { everyCompletedSteps: 2, counterScope: 'turn', partitionBy: 'model' } }))).toContainEqual(
      expect.objectContaining({ path: 'rules.0.cadence', field: 'cadence', ref: { kind: 'declarative', id: 'example' } }),
    );
    expect(validateHooksDraft(ruleDraft({ id: 'bad id' }))).toContainEqual(
      expect.objectContaining({ path: 'rules.0.id', field: 'id', ref: { kind: 'declarative', id: 'bad id' } }),
    );
    const draft = ruleDraft({ event: 'step.before', cadence: { everyCompletedSteps: 0, counterScope: 'agent', partitionBy: 'model' }, match: { models: [''] } });
    expect(validateHooksDraft(draft)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'rules.0.cadence.everyCompletedSteps', field: 'everyCompletedSteps' }),
      expect.objectContaining({ path: 'rules.0.match.models.0', field: 'models' }),
    ]));
  });

  it('rejects inject with both text and textFile or neither', () => {
    for (const action of [{ type: 'inject' as const, text: 'Example', textFile: 'example.txt' }, { type: 'inject' as const }]) {
      expect(validateHooksDraft(ruleDraft({ action }))).toContainEqual(expect.objectContaining({
        path: 'rules.0.action', message: 'inject requires exactly one of text or text_file', ref: { kind: 'declarative', id: 'example' },
      }));
    }
  });

  it('locates malformed fields within supported actions instead of blaming their type', () => {
    const malformed = { type: 'inject', text: 123 } as unknown as HookRuleConfig['action'];
    expect(validateHooksDraft(ruleDraft({ action: malformed }))).toContainEqual(
      expect.objectContaining({ path: 'rules.0.action.text', field: 'text' }),
    );
    const extra = { type: 'observe', command: 'echo example' } as unknown as HookRuleConfig['action'];
    expect(validateHooksDraft(ruleDraft({ action: extra }))).toContainEqual(
      expect.objectContaining({ path: 'rules.0.action.command', field: 'command' }),
    );
  });

  it('keeps the schema unsupported-action explanation', () => {
    const action = { type: 'command', command: 'echo example' } as unknown as HookRuleConfig['action'];
    expect(validateHooksDraft(ruleDraft({ action }))).toContainEqual(expect.objectContaining({
      path: 'rules.0.action', message: expect.stringContaining('command, gate, block and continue are not supported'),
    }));
  });

  it('locates top-level errors without attributing them to a rule', () => {
    expect(validateHooksDraft(draftFromHooks({ ...mixed, files: [''] }))).toContainEqual(
      expect.objectContaining({ path: 'files.0', field: 'files', ref: null }),
    );
    const config = { ...mixed, extra: true } as HooksV2Config;
    expect(validateHooksDraft(draftFromHooks(config))).toContainEqual(
      expect.objectContaining({ path: 'extra', field: 'extra', ref: null }),
    );
  });

  it('reports all invalid legacy fields and rejects the patch with the stable localized error', () => {
    const draft = draftFromHooks([{ ...newLegacyRule(), matcher: '[', timeout: 601 }]);
    expect(validateHooksDraft(draft).map((issue) => issue.field)).toEqual(expect.arrayContaining(['command', 'matcher', 'timeout']));
    const error = caught(() => hooksDraftPatch(draft));
    expect(error).toBeInstanceOf(LocalizedError);
    expect(error).toMatchObject({ issue: { key: 'st.hooks.configInvalid' } });
    const ruleError = caught(() => hooksDraftPatch(ruleDraft({ action: { type: 'inject', text: '' } })));
    expect(ruleError).toBeInstanceOf(LocalizedError);
    expect(ruleError).toMatchObject({ issue: { key: 'st.hooks.configInvalid' } });
  });
});

describe('hook selector lines', () => {
  it('trims lines, removes blanks and duplicates, and preserves first-occurrence order', () => {
    expect(parseSelectorLines(' model-b \r\n\nmodel-a\nmodel-b\n \t\nmodel-c ')).toEqual(['model-b', 'model-a', 'model-c']);
    expect(parseSelectorLines(' \n\t\r\n')).toEqual([]);
    const selectors = ['model-b', 'model-a', 'model-c'];
    expect(formatSelectorLines(selectors)).toBe('model-b\nmodel-a\nmodel-c');
    expect(parseSelectorLines(formatSelectorLines(selectors))).toEqual(selectors);
    expect(formatSelectorLines([])).toBe('');
  });
});

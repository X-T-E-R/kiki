import { describe, expect, it } from 'vitest';

import {
  EMPTY_ENGINE_DEFAULTS,
  engineDefaultsDraftFrom,
  engineDefaultsPatch,
} from './EngineDefaults';

describe('engineDefaultsDraftFrom', () => {
  it('reads nothing as every field inheriting', () => {
    expect(engineDefaultsDraftFrom(undefined)).toEqual(EMPTY_ENGINE_DEFAULTS);
    expect(engineDefaultsDraftFrom(null)).toEqual(EMPTY_ENGINE_DEFAULTS);
    expect(engineDefaultsDraftFrom({})).toEqual(EMPTY_ENGINE_DEFAULTS);
  });

  it('separates an absent context list from an explicit empty one', () => {
    expect(engineDefaultsDraftFrom({ kiki_context: [] }).kikiContext).toEqual([]);
    expect(engineDefaultsDraftFrom({}).kikiContext).toBeUndefined();
  });

  it('separates an absent delegation flag from an explicit off', () => {
    expect(engineDefaultsDraftFrom({ allow_kiki_subagents: false }).allowKikiSubagents).toBe(false);
    expect(engineDefaultsDraftFrom({}).allowKikiSubagents).toBeUndefined();
  });

  it('leaves a delivery unwritten when the saved prompt names only include', () => {
    const draft = engineDefaultsDraftFrom({ executor_prompt: { include: ['memory_snapshot'] } });
    expect(draft.promptDelivery).toBe('');
    expect(draft.promptInclude).toEqual(['memory_snapshot']);
  });
});

describe('engineDefaultsPatch', () => {
  it('sends null for every untouched field, so the block narrows to the choices shown', () => {
    expect(engineDefaultsPatch(EMPTY_ENGINE_DEFAULTS)).toBeNull();
    expect(engineDefaultsPatch({ ...EMPTY_ENGINE_DEFAULTS, modelAlias: ' claude-opus ' })).toEqual({
      model_alias: 'claude-opus',
      thinking_effort: null,
      permission_mode: null,
      kiki_context: null,
      allow_kiki_subagents: null,
      executor_prompt: null,
    });
  });

  it('writes an explicit off rather than dropping it as empty', () => {
    const patch = engineDefaultsPatch({
      ...EMPTY_ENGINE_DEFAULTS,
      kikiContext: [],
      allowKikiSubagents: false,
    });
    expect(patch?.['kiki_context']).toEqual([]);
    expect(patch?.['allow_kiki_subagents']).toBe(false);
  });

  it('never invents a delivery or an include list from an untouched field', () => {
    const patch = engineDefaultsPatch({ ...EMPTY_ENGINE_DEFAULTS, promptBody: 'extra rules' });
    expect(patch?.['executor_prompt']).toEqual({
      delivery: null, include: null, body: 'extra rules', append: null,
    });
  });

  it('round-trips a saved block through draft and patch unchanged', () => {
    const saved = {
      model_alias: 'gpt-5-codex',
      thinking_effort: 'high',
      permission_mode: 'auto',
      kiki_context: ['memory', 'hooks'],
      allow_kiki_subagents: true,
      executor_prompt: { delivery: 'preamble', include: ['agents_md'], body: 'b', append: 'a' },
    };
    const draft = engineDefaultsDraftFrom(saved);
    expect(engineDefaultsPatch(draft)).toEqual({
      model_alias: 'gpt-5-codex',
      thinking_effort: 'high',
      permission_mode: 'auto',
      kiki_context: ['memory', 'hooks'],
      allow_kiki_subagents: true,
      executor_prompt: { delivery: 'preamble', include: ['agents_md'], body: 'b', append: 'a' },
    });
  });

  it('treats an include list the user emptied as explicitly off, not as inherited', () => {
    const patch = engineDefaultsPatch({ ...EMPTY_ENGINE_DEFAULTS, promptInclude: [] });
    expect(patch?.['executor_prompt']).toEqual({
      delivery: null, include: [], body: null, append: null,
    });
  });
});

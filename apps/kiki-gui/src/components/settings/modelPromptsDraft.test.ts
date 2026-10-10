import { describe, expect, it } from 'vitest';

import { modelEntitySchema, modelCognitionSchema } from '@kiki/protocol';

import {
  modelPromptsDraft, modelPromptsEqual, modelPromptsPatch,
} from './modelPromptsDraft';

const entity = (over: Record<string, unknown> = {}) => modelEntitySchema.parse({
  id: 'example/model',
  provider_id: 'example',
  provider_source: 'flat',
  remote_id: 'model',
  effective_parameters: {},
  parameter_sources: {},
  issues: [],
  revision: 'r1',
  ...over,
});

describe('modelPromptsDraft', () => {
  it('reads an absent branch as absent, not as same or off', () => {
    const draft = modelPromptsDraft(entity({ cognition: { overlay: 'main.md' } }));
    expect(draft.cognition.main).toEqual({ kind: 'absent' });
    expect(draft.cognition.independent).toEqual({ kind: 'absent' });
  });

  it('keeps an explicit same apart from an absent branch', () => {
    const draft = modelPromptsDraft(entity({
      cognition: { overlay: 'main.md', main: 'same', independent: 'off' },
    }));
    expect(draft.cognition.main).toEqual({ kind: 'same' });
    expect(draft.cognition.independent).toEqual({ kind: 'off' });
  });

  it('reads a branch object as custom', () => {
    const draft = modelPromptsDraft(entity({
      cognition: { overlay: 'main.md', main: { steering: 'own.md' } },
    }));
    expect(draft.cognition.main.kind).toBe('custom');
  });
});

describe('modelPromptsEqual', () => {
  it('treats a re-read of the same entity as equal', () => {
    const source = entity({ cognition: { overlay: 'main.md', main: 'same' } });
    expect(modelPromptsEqual(modelPromptsDraft(source), modelPromptsDraft(source))).toBe(true);
  });
});

describe('modelPromptsPatch', () => {
  it('sends nothing when nothing changed', () => {
    const source = entity({ cognition: { overlay: 'main.md' } });
    const draft = modelPromptsDraft(source);
    expect(modelPromptsPatch(source, draft, draft)).toEqual({});
  });

  it('preserves an untouched explicit same when the other branch changes', () => {
    const source = entity({ cognition: { overlay: 'main.md', main: 'same', independent: 'off' } });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      cognition: { ...draft.cognition, common: { ...draft.cognition.common, overlay: 'edited.md' } },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(patch.cognition?.['main']).toBe('same');
    expect(patch.cognition?.['independent']).toBe('off');
  });

  it('writes a prompt field body rather than dropping it', () => {
    // A model's own  takes strings only:  is a
    // Recipe-side declaration that hides an inherited field, not a model-side
    // one. The two must not be given the same control.
    const source = entity({ prompt_overrides: { fields: { 'system.language': 'en' } } });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      fields: {
        ...draft.fields,
        common: { files: '', fields: [{ id: 'x', name: 'system.language', value: 'zh' }] },
      },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(patch.prompt_overrides?.['fields']).toEqual({ 'system.language': 'zh' });
  });

  it('keeps an empty array of source files rather than deleting the key', () => {
    const source = entity({ prompt_overrides: { files: [] } });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      fields: { ...draft.fields, independent: { kind: 'off' as const } },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(patch.prompt_overrides?.['files']).toEqual([]);
    expect(patch.prompt_overrides?.['independent']).toBe('off');
  });

  it('never invents a main or independent branch that was absent', () => {
    const source = entity({ cognition: { overlay: 'main.md' } });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      cognition: { ...draft.cognition, common: { ...draft.cognition.common, overlay: 'changed.md' } },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(patch.cognition?.['main']).toBeUndefined();
    expect(patch.cognition?.['independent']).toBeUndefined();
  });

  it('leaves the other prompt object alone when only one changed', () => {
    const source = entity({
      cognition: { overlay: 'main.md' },
      prompt_overrides: { files: ['o.toml'] },
    });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      cognition: { ...draft.cognition, independent: { kind: 'off' as const } },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(patch.prompt_overrides).toBeUndefined();
    expect(patch.cognition).toBeDefined();
  });

  it('produces a patch the model schema accepts', () => {
    const source = entity({ cognition: { overlay: 'main.md', main: 'same' } });
    const draft = modelPromptsDraft(source);
    const edited = {
      ...draft,
      cognition: { ...draft.cognition, common: { ...draft.cognition.common, overlay: 'edited.md', overlayMode: 'append' as const } },
    };
    const patch = modelPromptsPatch(source, edited, draft);
    expect(() => modelCognitionSchema.parse(patch.cognition)).not.toThrow();
  });

  it('layers only touched slots and branches over a raw whole-object target', () => {
    const source = entity({ cognition: {
      overlay: { text: 'Inline stays native.' }, steering: 'old.md', main: { overlay: 'old-main.md', anchor: { text: 'Old anchor.' } }, independent: 'off',
    } });
    const baseline = modelPromptsDraft(source);
    const main = baseline.cognition.main;
    if (main.kind !== 'custom') throw new Error('Expected custom fixture');
    const edited = { ...baseline, cognition: {
      ...baseline.cognition,
      common: { ...baseline.cognition.common, steering: 'edited.md' },
      main: { kind: 'custom' as const, content: { ...main.content, overlayMode: 'append' as const } },
    } };
    const raw = entity({ cognition: {
      overlay: { text: 'Raw inline.' }, anchor: { text: 'New raw anchor.' },
      main: { overlay: 'raw-main.md', anchor: { text: 'Raw main anchor.' } },
    } });
    expect(modelPromptsPatch(raw, edited, baseline).cognition).toEqual({
      overlay: { text: 'Raw inline.' }, steering: 'edited.md', anchor: { text: 'New raw anchor.' },
      main: { overlay: 'raw-main.md', anchor: { text: 'Raw main anchor.' }, overlay_mode: 'append' },
    });
  });

  it('keeps untouched inline slots when a mode changes within a custom identity', () => {
    const source = entity({ cognition: { main: { overlay: { text: 'Native body.' }, steering: { text: 'Native reminder.' } }, independent: 'off' } });
    const baseline = modelPromptsDraft(source);
    const main = baseline.cognition.main;
    if (main.kind !== 'custom') throw new Error('Expected custom fixture');
    const edited = { ...baseline, cognition: { ...baseline.cognition, main: { kind: 'custom' as const, content: { ...main.content, overlayMode: 'append' as const } } } };
    expect(modelPromptsPatch(source, edited, baseline).cognition).toEqual({
      main: { overlay: { text: 'Native body.' }, steering: { text: 'Native reminder.' }, overlay_mode: 'append' }, independent: 'off',
    });
  });

  it('preserves raw named fields while applying only a changed or removed prompt field', () => {
    const source = entity({ prompt_overrides: {
      files: ['old.toml'], fields: { 'system.language': 'en', 'system.style': 'Old style.' }, main: 'off',
    } });
    const baseline = modelPromptsDraft(source);
    const edited = { ...baseline, fields: { ...baseline.fields, common: {
      ...baseline.fields.common, fields: [{ id: 'edited', name: 'system.language', value: 'zh' }],
    } } };
    const raw = entity({ prompt_overrides: {
      files: ['raw.toml'], fields: { 'system.language': 'fr', 'system.style': 'Raw style.', 'system.tools': 'Raw tools.' }, independent: 'off',
    } });
    expect(modelPromptsPatch(raw, edited, baseline).prompt_overrides).toEqual({
      files: ['raw.toml'], fields: { 'system.language': 'zh', 'system.tools': 'Raw tools.' }, independent: 'off',
    });
  });

  it('honors explicit field and identity removal without reconstructing siblings after a clear', () => {
    const source = entity({ cognition: { overlay: 'old.md', main: 'off', independent: 'same' } });
    const baseline = modelPromptsDraft(source);
    const edited = { ...baseline, cognition: {
      ...baseline.cognition, common: { ...baseline.cognition.common, overlay: '', anchor: 'new.md' }, main: { kind: 'absent' as const },
    } };
    expect(modelPromptsPatch(entity({}), edited, baseline).cognition).toEqual({ anchor: 'new.md' });
  });
});
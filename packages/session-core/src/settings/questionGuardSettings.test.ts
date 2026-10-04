import { describe, expect, it } from 'vitest';
import { createProviderRequestSchema, createModelRequestSchema, patchModelRequestSchema, patchConfigRequestSchema, resolveAskUserQuestionGuard } from '@kiki/protocol';
import { questionGuardDraftFromBehavior, questionGuardDraftFromConfig, questionGuardConfigFromDraft, questionGuardGlobalPatch, questionGuardModelPatch } from './questionGuardSettings';
import { providerCreateBody, providerDraftFromCatalog, providerModelDraftFromCatalog, modelCreateBody, modelPatchBody } from './settings';

describe('typed question guard settings', () => {
  it('keeps inheritance distinct from false and creates only sparse behavior patches', () => {
    const baseline = questionGuardDraftFromBehavior(undefined);
    const next = { ...baseline, enabled: 'off' as const, maxPerWindow: '4' };
    expect(questionGuardConfigFromDraft(next)).toEqual({ enabled: false, maxPerWindow: 4 });
    expect(questionGuardModelPatch(baseline, baseline)).toBeUndefined();
    const behavior = questionGuardModelPatch(next, baseline);
    expect(behavior).toEqual({ ask_user_question_guard: { enabled: false, max_per_window: 4 } });
    expect(patchModelRequestSchema.parse({ behavior })).toEqual({ behavior });
    expect(questionGuardModelPatch(baseline, next)).toEqual({ ask_user_question_guard: { enabled: null, max_per_window: null } });
    expect(resolveAskUserQuestionGuard({ enabled: true, maxPerWindow: 7 }, { askUserQuestionGuard: { enabled: false } })).toMatchObject({ enabled: false, maxPerWindow: 7 });
  });
  it('validates reasonable positive numeric limits and global changes preserve blocking semantics', () => {
    const baseline = questionGuardDraftFromConfig(undefined);
    for (const maxPerWindow of ['0', '-1', '1.5', '1001', 'no']) expect(() => questionGuardConfigFromDraft({ ...baseline, maxPerWindow })).toThrow();
    expect(() => questionGuardConfigFromDraft({ ...baseline, windowMs: '86400001' })).toThrow();
    const patch = questionGuardGlobalPatch({ ...baseline, enabled: 'on' }, baseline);
    expect(patchConfigRequestSchema.parse({ interaction: patch }).interaction).toEqual({ ask_user_question_guard: { enabled: true } });
  });
  it('reads catalog behavior into the existing model draft and saves it separately from generation', () => {
    const model = { id: 'model', provider_id: 'edge', remote_id: 'remote', max_context_size: 8192, behavior: { ask_user_question_guard: { enabled: false, max_per_window: 5 } } };
    const baseline = providerModelDraftFromCatalog(model);
    const next = { ...baseline, behavior: { ask_user_question_guard: { enabled: true, max_per_window: 5 } } };
    expect(modelPatchBody(next, baseline)).toEqual({ behavior: { ask_user_question_guard: { enabled: true } } });
    const created = createModelRequestSchema.parse(modelCreateBody('edge', next));
    expect(created.behavior).toEqual(next.behavior); expect(created.parameters).toBeUndefined();
    const provider = providerDraftFromCatalog({ id: 'edge', type: 'openai', has_api_key: false, status: 'unconfigured' }, [model]);
    if (provider === null) throw new Error('Expected a supported provider draft');
    expect(createProviderRequestSchema.parse(providerCreateBody(provider)).models?.[0]?.behavior).toEqual(model.behavior);
  });
});

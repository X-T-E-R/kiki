import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutation';
import { ModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutationService';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';

import { StubConfigService, stubModelOAuthTokens } from '../../kosong/stubs';

describe('generation parameter entity mutations', () => {
  it('patches only the selected provider/model fields and rejects stale revisions', async () => {
    const config = new StubConfigService({
      [PROVIDERS_SECTION]: { edge: { type: 'openai', defaults: { temperature: 0.3, maxCompletionTokens: 8192 } } },
      [MODELS_SECTION]: {
        fast: { provider: 'edge', model: 'remote-fast', maxContextSize: 200000, parameters: { topP: 0.8 } },
        sibling: { provider: 'edge', model: 'remote-sibling', maxContextSize: 200000 },
      },
    });
    const ix = new TestInstantiationService();
    ix.stub(IConfigService, config);
    ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
    ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
    try {
      const catalog = ix.get(IModelCatalogMutationService);
      const original = await catalog.readModel('fast');
      expect(original.effective_parameters).toMatchObject({ temperature: 0.3, top_p: 0.8, max_completion_tokens: 8192 });
      const model = await catalog.updateModel('fast', { base_revision: original.revision, parameters: { top_p: null, temperature: 0 } });
      expect(model.parameters).toEqual({ temperature: 0 });
      expect(model.effective_parameters).toMatchObject({ temperature: 0, max_completion_tokens: 8192 });
      expect(model.parameter_sources['temperature']).toBe('[models.*.parameters]');
      expect(model.parameter_sources['max_completion_tokens']).toBe('[providers.*.defaults]');
      expect((await catalog.readModel('sibling')).parameters).toBeUndefined();
      await expect(catalog.updateModel('fast', { base_revision: original.revision, parameters: { temperature: 0.9 } })).rejects.toThrow();
      const provider = await catalog.readProvider('edge');
      const updated = await catalog.updateProvider('edge', { base_revision: provider.revision, defaults: { max_completion_tokens: 16384 } });
      expect(updated.defaults).toMatchObject({ temperature: 0.3, max_completion_tokens: 16384 });
      expect((await catalog.readModel('fast')).effective_parameters?.max_completion_tokens).toBe(16384);
      expect((await catalog.readModel('sibling')).effective_parameters?.max_completion_tokens).toBe(16384);
    } finally { ix.dispose(); }
  });
});

import { describe, expect, it } from 'vitest';

import type { IModelCatalog } from '#/kosong/model/catalog';
import { pluginModelCatalog } from '#/app/plugin/pluginModelCatalog';

const catalog = {
  listModels: async () => [
    { id: 'alias', provider_id: 'chat', remote_id: 'remote-model', display_name: 'Alias' },
    { id: 'other', provider_id: 'chat', remote_id: 'other-remote', display_name: 'Other' },
  ],
  listProviders: async () => [],
} as unknown as IModelCatalog;

describe('pluginModelCatalog candidates', () => {
  it('returns every model, a remote id match, or nothing for an empty candidate list', async () => {
    expect((await pluginModelCatalog(catalog)).models.map((model) => model.id)).toEqual(['alias', 'other']);
    expect((await pluginModelCatalog(catalog, ['remote-model'])).models.map((model) => model.id)).toEqual(['alias']);
    expect((await pluginModelCatalog(catalog, [])).models).toEqual([]);
  });
});

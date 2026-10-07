import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutation';
import { ModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutationService';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';

import { StubConfigService, stubModelOAuthTokens } from '../../kosong/stubs';

describe('generation parameter entity mutations', () => {
  it('CAS-merges source modes and saved custom leaves without erasing user bodies or model/profile fields', async () => {
    const storage = new InMemoryStorageService(); const store = new TomlAtomicDocumentStore(storage);
    await store.setText('', 'config.toml', '[providers.edge]\ntype="openai"\n[models.fast]\nprovider="edge"\nmodel="remote-fast"\nmax_context_size=8192\n[models.fast.cognition]\nsteering={text="USER BODY"}\nmain="same"\n[models.fast.parameters]\ntemperature=0.2\n[models.fast.prompt_overrides.fields]\n"system.shared"="MODEL FIELD"\n[models.sibling]\nprovider="edge"\nmodel="other"\n');
    const host = () => {
      const ix = new TestInstantiationService();
      ix.stub(ILogService, stubLog()); ix.stub(IBootstrapService, stubBootstrap('/scratch/home'));
      ix.stub(IFileSystemStorageService, storage); ix.stub(IAtomicTomlDocumentStore, store); ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry)); ix.set(IConfigService, new SyncDescriptor(ConfigService)); ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
      return ix;
    };
    const first = host();
    try {
      const catalog = first.get(IModelCatalogMutationService);
      const initial = await catalog.readModel('fast');
      await expect(catalog.updateModel('fast', { steering_sources_patch: { common: { thread: { mode: 'inherit' } } } })).rejects.toMatchObject({ code: 'config.invalid' });
      const custom = await catalog.updateModel('fast', { base_revision: initial.revision, steering_sources_patch: { common: { thread: { mode: 'custom', custom: { steering: { text: 'THREAD BODY' }, steering_interval_steps: 3 } } } } });
      const off = await catalog.updateModel('fast', { base_revision: custom.revision, steering_sources_patch: { common: { thread: { mode: 'off' } } } });
      expect(off.cognition?.steering_sources?.thread).toEqual({ mode: 'off', custom: { steering: { text: 'THREAD BODY' }, steering_interval_steps: 3 } });
      expect(off.cognition_bodies?.branches.common.steering_sources?.thread?.text).toBe('THREAD BODY');
      const inherited = await catalog.updateModel('fast', { base_revision: off.revision, steering_sources_patch: { main: { agent: { mode: 'inherit' } } } });
      expect(inherited.cognition?.main).toMatchObject({ steering: { text: 'USER BODY' }, steering_sources: { thread: { mode: 'off' }, agent: { mode: 'inherit' } } });
      expect(inherited.cognition?.steering).toEqual({ text: 'USER BODY' });
      expect(inherited.parameters?.temperature).toBe(0.2); expect(inherited.prompt_overrides?.fields?.['system.shared']).toBe('MODEL FIELD');
      expect((await catalog.readModel('sibling')).remote_id).toBe('other');
      await expect(catalog.updateModel('fast', { base_revision: initial.revision, steering_sources_patch: { common: { thread: { mode: 'inherit' } } } })).rejects.toMatchObject({ code: 'model_catalog.revision_conflict' });
    } finally { await first.dispose(); }
    const cold = host();
    try {
      const saved = await cold.get(IModelCatalogMutationService).readModel('fast');
      expect(saved.cognition?.steering_sources?.thread?.custom?.steering_interval_steps).toBe(3);
      expect(saved.cognition_bodies?.branches.main.steering_sources?.thread?.text).toBe('THREAD BODY');
      const cleared = await cold.get(IModelCatalogMutationService).updateModel('fast', { base_revision: saved.revision, steering_sources_patch: { common: null } });
      expect(cleared.cognition?.steering_sources).toBeUndefined(); expect(cleared.cognition?.steering).toEqual({ text: 'USER BODY' });
      expect(typeof cleared.cognition?.main).toBe('object');
    } finally { await cold.dispose(); }
  });
  it('saves complete native prompt bodies with one model CAS, cold reads, clears slots and preserves unrelated state', async () => {
    const storage = new InMemoryStorageService();
    const store = new TomlAtomicDocumentStore(storage);
    await store.setText('', 'config.toml', '[providers.edge]\ntype="openai"\n[models.fast]\nprovider="edge"\nmodel="remote-fast"\nmax_context_size=8192\n[models.fast.cognition]\noverlay="author.md"\nsteering_on_turn=false\nsteering_interval_steps=0\nmain="same"\nindependent="off"\n[models.fast.parameters]\ntemperature=0.2\n[models.sibling]\nprovider="edge"\nmodel="other"\n');
    const host = () => {
      const ix = new TestInstantiationService();
      ix.stub(ILogService, stubLog()); ix.stub(IBootstrapService, stubBootstrap('/scratch/home'));
      ix.stub(IFileSystemStorageService, storage); ix.stub(IAtomicTomlDocumentStore, store); ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry)); ix.set(IConfigService, new SyncDescriptor(ConfigService)); ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
      return ix;
    };
    const body = '  FIRST LINE\n第二行\n\nlast line\n';
    let first = host();
    try {
      const catalog = first.get(IModelCatalogMutationService);
      const original = await catalog.readModel('fast');
      await expect(catalog.updateModel('fast', { cognition: { overlay: { text: body } } })).rejects.toMatchObject({ code: 'config.invalid' });
      await expect(catalog.updateModel('fast', { prompt_overrides: { fields: { 'system.shared': 'missing revision' } } })).rejects.toMatchObject({ code: 'config.invalid' });
      await expect(catalog.updateModel('fast', { prompt_overrides: null })).rejects.toMatchObject({ code: 'config.invalid' });
      await expect(catalog.updateModel('fast', { cognition: null })).rejects.toMatchObject({ code: 'config.invalid' });
      const edited = await catalog.updateModel('fast', { base_revision: original.revision, cognition: { ...original.cognition, overlay: { text: body }, steering: { text: 'cue\nnext' }, anchor: { text: 'anchor\n正文' } }, prompt_overrides: { fields: { 'system.shared': 'shared\n正文' } } });
      expect(edited.cognition?.overlay).toEqual({ text: body });
      expect(edited.cognition_bodies?.revision).toBe(edited.revision);
      expect(edited.cognition_bodies?.branches.main).toMatchObject({ selection: 'common', source_scope: 'common', slots: { overlay: { source: 'inline', text: body, writable: true, source_read_only: false } } });
      expect(edited.cognition_bodies?.branches.independent).toMatchObject({ selection: 'off', slots: { overlay: { source: 'unset' } } });
      expect(edited.cognition).toMatchObject({ steering_on_turn: false, steering_interval_steps: 0, main: 'same', independent: 'off' });
      expect(edited.parameters).toEqual({ temperature: 0.2 });
      await expect(catalog.updateModel('fast', { base_revision: original.revision, cognition: { overlay: { text: 'lost update' } } })).rejects.toMatchObject({ code: 'model_catalog.revision_conflict' });
      await expect(catalog.updateModel('fast', { base_revision: original.revision, cognition: edited.cognition })).rejects.toMatchObject({ code: 'model_catalog.revision_conflict' });
      await expect(catalog.updateModel('fast', { base_revision: original.revision, prompt_overrides: null })).rejects.toMatchObject({ code: 'model_catalog.revision_conflict' });
      expect((await catalog.readModel('fast')).cognition?.overlay).toEqual({ text: body });
      const before = await store.getText('', 'config.toml');
      await expect(catalog.updateModel('fast', { base_revision: edited.revision, cognition: { overlay: '../outside.md' } })).rejects.toMatchObject({ code: 'config.invalid' });
      expect(await store.getText('', 'config.toml')).toBe(before);
      expect((await catalog.readModel('sibling')).remote_id).toBe('other');
    } finally { await first.dispose(); }
    first = host();
    try {
      const catalog = first.get(IModelCatalogMutationService);
      const saved = await catalog.readModel('fast');
      expect(saved.cognition?.overlay).toEqual({ text: body });
      expect(saved.prompt_overrides?.fields?.['system.shared']).toBe('shared\n正文');
      const empty = await catalog.updateModel('fast', { base_revision: saved.revision, cognition: { ...saved.cognition, overlay: { text: '' }, main: { steering: { text: 'main only' } } } });
      expect(empty.cognition_bodies?.branches.common.slots.overlay.text).toBe('');
      expect(empty.cognition_bodies?.branches.main).toMatchObject({ selection: 'custom', source_scope: 'main', slots: { overlay: { source: 'unset' }, steering: { text: 'main only' } } });
      const { overlay: _removed, ...rest } = empty.cognition!;
      const cleared = await catalog.updateModel('fast', { base_revision: empty.revision, cognition: rest });
      expect(cleared.cognition?.overlay).toBeUndefined();
      await first.get(IConfigService).reload();
      expect((await catalog.readModel('fast')).cognition?.overlay).toBeUndefined();
      const reset = await catalog.updateModel('fast', { base_revision: cleared.revision, cognition: null });
      expect(reset.cognition).toBeUndefined();
      expect(reset.prompt_overrides?.fields?.['system.shared']).toBe('shared\n正文');
      expect(reset.parameters).toEqual({ temperature: 0.2 });
    } finally { await first.dispose(); }
  });
  it('persists typed Kiki question behavior independently of generation and usage, then cold-reads and clears sparsely', async () => {
    const storage = new InMemoryStorageService(); const store = new TomlAtomicDocumentStore(storage);
    await store.setText('', 'config.toml', '[providers.edge]\ntype="openai"\n[models.fast]\nprovider="edge"\nmodel="remote-fast"\nmax_context_size=8192\n[models.fast.parameters]\nthinking_effort="medium"\n[models.fast.usage.main]\nthinking_effort="high"\n');
    const host = () => {
      const ix = new TestInstantiationService();
      ix.stub(ILogService, stubLog()); ix.stub(IBootstrapService, stubBootstrap('/scratch/home'));
      ix.stub(IFileSystemStorageService, storage); ix.stub(IAtomicTomlDocumentStore, store); ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
      ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry)); ix.set(IConfigService, new SyncDescriptor(ConfigService)); ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
      return ix;
    };
    const first = host();
    try {
      const catalog = first.get(IModelCatalogMutationService);
      const edited = await catalog.updateModel('fast', { behavior: { ask_user_question_guard: { enabled: false, max_per_window: 5 } } });
      expect(edited.behavior).toEqual({ ask_user_question_guard: { enabled: false, max_per_window: 5 } });
      expect(edited.parameters).toEqual({ thinking_effort: 'medium' }); expect(edited.usage_effective?.main.thinking_effort).toBe('high');
      const text = await store.getText('', 'config.toml'); expect(text).toContain('[models.fast.behavior.ask_user_question_guard]'); expect(text).toContain('enabled = false');
    } finally { await first.dispose(); }
    const cold = host();
    try {
      const catalog = cold.get(IModelCatalogMutationService);
      expect((await catalog.readModel('fast')).behavior?.ask_user_question_guard).toMatchObject({ enabled: false, max_per_window: 5 });
      const cleared = await catalog.updateModel('fast', { behavior: { ask_user_question_guard: { enabled: null } } });
      expect(cleared.behavior?.ask_user_question_guard).toEqual({ max_per_window: 5 });
      expect(cleared.parameters).toEqual({ thinking_effort: 'medium' }); expect(cleared.usage_effective?.main.thinking_effort).toBe('high');
      expect((await catalog.updateModel('fast', { behavior: null })).behavior).toBeUndefined();
      const created = await catalog.createModel({ id: 'other', provider_id: 'edge', remote_id: 'remote-other', behavior: { ask_user_question_guard: { enabled: true } } });
      expect(created.behavior?.ask_user_question_guard?.enabled).toBe(true);
      await catalog.createProvider({ id: 'new-edge', type: 'openai', models: [{ remote_id: 'nested', behavior: { ask_user_question_guard: { enabled: false } } }] });
      expect((await catalog.readModel('new-edge/nested')).behavior?.ask_user_question_guard?.enabled).toBe(false);
    } finally { await cold.dispose(); }
  });
  it('persists identity parameter differences sparsely and previews the same inherited defaults', async () => {
    const ix = new TestInstantiationService();
    const homeStorage = new InMemoryStorageService();
    const homeStore = new TomlAtomicDocumentStore(homeStorage);
    const baseStore = new TomlAtomicDocumentStore(new InMemoryStorageService());
    const baseText = '[providers.edge]\ntype="openai"\n[models.fast]\nprovider="edge"\nmodel="remote-fast"\nmax_context_size=300000\ncontext_budget=250000\nauto_compact=200000\n[models.fast.parameters]\nthinking_effort="medium"\nservice_tier="flex"\nmax_completion_tokens=16000\n[models.fast.usage.main]\nthinking_effort="high"\nauto_compact=160000\n';
    await baseStore.setText('', 'config.toml', baseText);
    await homeStore.setText('', 'config.toml', '');
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, { ...stubBootstrap('/scratch/home'), baseHomeDir: '/scratch/base', baseConfigDocumentStore: baseStore });
    ix.stub(IFileSystemStorageService, homeStorage);
    ix.stub(IAtomicTomlDocumentStore, homeStore);
    ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
    try {
      const catalog = ix.get(IModelCatalogMutationService);
      const config = ix.get(IConfigService);
      const original = await catalog.readModel('fast');
      expect(original.usage_effective?.main).toMatchObject({ thinking_effort: 'high', auto_compact: 160000, context_budget: 250000, service_tier: 'flex' });
      expect(original.usage_effective?.sub).toMatchObject({ thinking_effort: 'medium', auto_compact: 200000 });
      const edited = await catalog.updateModel('fast', { base_revision: original.revision, usage: { main: { thinking_effort: 'low', service_tier: { kind: 'api_default' } } } });
      expect(edited.usage_effective?.main).toMatchObject({ thinking_effort: 'low', auto_compact: 160000, service_tier: { kind: 'api_default' } });
      expect(edited.usage_sources?.main['thinking_effort']).toBe('[models.*.usage.main.thinkingEffort]');
      expect(config.inspect('models').userValue).toEqual({ fast: { usage: { main: { thinkingEffort: 'low', serviceTier: { kind: 'api_default' } } } } });
      const text = await homeStore.getText('', 'config.toml');
      expect(text).toContain('thinking_effort = "low"');
      expect(text).not.toContain('auto_compact');
      expect(text).not.toContain('remote-fast');
      await config.reload();
      expect((await catalog.readModel('fast')).usage_effective?.main).toEqual(edited.usage_effective?.main);
      await catalog.createProvider({ id: 'new-edge', type: 'openai', models: [
        { remote_id: 'first', auto_compact: 120000 },
        { remote_id: 'second', auto_compact: 90000 },
        { remote_id: 'inherited' },
      ] });
      await config.reload();
      expect((await catalog.readModel('new-edge/first')).auto_compact).toBe(120000);
      expect((await catalog.readModel('new-edge/second')).auto_compact).toBe(90000);
      expect((await catalog.readModel('new-edge/inherited')).auto_compact).toBeUndefined();
      expect((await catalog.readModel('fast')).usage_effective?.main).toEqual(edited.usage_effective?.main);
      expect((await catalog.readModel('fast')).usage_effective?.sub.auto_compact).toBe(200000);
      expect(config.inspect<Record<string, unknown>>('models').userValue?.['fast']).toEqual({ usage: { main: { thinkingEffort: 'low', serviceTier: { kind: 'api_default' } } } });
      expect(await baseStore.getText('', 'config.toml')).toBe(baseText);
      const cleared = await catalog.updateModel('fast', { usage: { main: { thinking_effort: null } } });
      expect(cleared.usage_effective?.main?.thinking_effort).toBe('high');
      expect(cleared.usage_effective?.main?.service_tier).toEqual({ kind: 'api_default' });
      await catalog.updateModel('fast', { usage: { main: null } });
      expect((await catalog.readModel('fast')).usage_effective?.main?.service_tier).toBe('flex');
      await catalog.updateModel('fast', { usage: null });
      await config.reload();
      expect(config.inspect<Record<string, Record<string, unknown>>>('models').userValue?.['fast']?.['usage']).toBeUndefined();
      expect(await baseStore.getText('', 'config.toml')).toBe(baseText);
    } finally { await ix.dispose(); }
  });
  it('reads inherited models and edits sparse home overrides without copying the base', async () => {
    const ix = new TestInstantiationService();
    const homeStorage = new InMemoryStorageService();
    const baseStorage = new InMemoryStorageService();
    const homeStore = new TomlAtomicDocumentStore(homeStorage);
    const baseStore = new TomlAtomicDocumentStore(baseStorage);
    const baseText = '[providers.edge]\ntype="openai"\nbase_url="https://example.test/v1"\n[models.fast]\nprovider="edge"\nmodel="remote-fast"\nmax_context_size=8192\n[models.sibling]\nprovider="edge"\nmodel="remote-sibling"\nmax_context_size=8192\n';
    await baseStore.setText('', 'config.toml', baseText);
    await homeStore.setText('', 'config.toml', '[models.fast]\nauto_compact=4000\n[models.sibling]\nenabled=false\n');
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, { ...stubBootstrap('/scratch/home'), baseHomeDir: '/scratch/base', baseConfigDocumentStore: baseStore });
    ix.stub(IFileSystemStorageService, homeStorage);
    ix.stub(IAtomicTomlDocumentStore, homeStore);
    ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
    try {
      const config = ix.get(IConfigService);
      const catalog = ix.get(IModelCatalogMutationService);
      const original = await catalog.readModel('fast');
      expect(original).toMatchObject({ provider_id: 'edge', remote_id: 'remote-fast', max_context_size: 8192, auto_compact: 4000 });
      expect(original.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error' })]));
      await expect(catalog.readModel('sibling')).rejects.toMatchObject({ code: 'model.not_found' });
      const edited = await catalog.updateModel('fast', { base_revision: original.revision, auto_compact: 3000 });
      expect(edited).toMatchObject({ remote_id: 'remote-fast', auto_compact: 3000 });
      expect(config.inspect<Record<string, unknown>>('models').userValue).toEqual({ fast: { autoCompact: 3000 }, sibling: { enabled: false } });
      await expect(catalog.updateModel('fast', { base_revision: original.revision, auto_compact: 2000 })).rejects.toMatchObject({ code: 'model_catalog.revision_conflict' });
      await catalog.updateModel('fast', { base_revision: edited.revision, auto_compact: null });
      expect((await catalog.readModel('fast')).remote_id).toBe('remote-fast');
      await catalog.createModel({ id: 'second', provider_id: 'edge', remote_id: 'remote-second', max_context_size: 8192 });
      expect(config.inspect('providers').userValue).toBeUndefined();
      expect(Object.keys(config.inspect<Record<string, unknown>>('models').userValue ?? {})).toEqual(['fast', 'sibling', 'second']);
      await expect(catalog.createModel({ id: 'fast', provider_id: 'edge', remote_id: 'duplicate' })).rejects.toMatchObject({ code: 'model.already_exists' });
      expect(await baseStore.getText('', 'config.toml')).toBe(baseText);
      await config.reload();
      expect((await catalog.readModel('second')).remote_id).toBe('remote-second');
      expect(config.inspect<Record<string, Record<string, unknown>>>('models').userValue?.['fast']).toEqual({});
    } finally { await ix.dispose(); }
  });
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
    } finally { await ix.dispose(); }
  });
});

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nbSearchCapabilitiesSchema, nbSearchConfigPatchSchema } from '@kiki/protocol';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { NB_SEARCH_SECTION, type NbSearchConfig } from '#/app/nbSearch/configSection';
import { INbSearchService } from '#/app/nbSearch/nbSearch';
import { NbSearchService } from '#/app/nbSearch/nbSearchService';
import { INbSearchSourceStore } from '#/app/nbSearch/sourceStore';
import { pinnedNbSearchConfig, resolveNbSearchConfig, nbSearchConfigRevision } from '#/app/nbSearch/donorConfig';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';
import { createNbSearchProviderInstance, nbSearchDraftFromConfig, nbSearchConfigPatch, setNbSearchLane, setNbSearchPreset, setNbSearchFetchChain, validateNbSearchReferences, resolveEffectiveDefaultLane } from '../../../../session-core/src/settings/nbSearch';

let home: string;
let disposables: DisposableStore;
let config: IConfigService;
let service: INbSearchService;
let blockedNetwork: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nb-advanced-settings-'));
  const path = join(home, 'config.json');
  await writeFile(path, '{}');
  const env = { NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: path, TEAM_A_KEY: 'fixture-a', TEAM_B_KEY: 'fixture-b' };
  blockedNetwork = vi.fn(() => { throw new Error('External network is prohibited in this fixture.'); });
  vi.stubGlobal('fetch', blockedNetwork);
  disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap(home));
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  ix.set(INbSearchService, new SyncDescriptor(NbSearchService));
  ix.stub(INbSearchSourceStore, {
    _serviceBrand: undefined,
    withSource: async (reuse, patch, use) => {
      const effective = resolveNbSearchConfig(env, undefined, patch);
      return use({ env, config: pinnedNbSearchConfig(effective), expectedRevision: nbSearchConfigRevision(effective), status: {
        reuse_local_config: reuse, layers: ['defaults', 'environment', 'kiki'], local_config: 'ignored', availability: 'ready', issues: [],
      } });
    },
    readManaged: async () => { throw new Error('No credential reads in this fixture.'); },
    writeManaged: async () => { throw new Error('No credential writes in this fixture.'); },
  });
  config = ix.get(IConfigService);
  await config.ready;
  service = ix.get(INbSearchService);
});

afterEach(async () => {
  try {
    if (blockedNetwork.mock.calls.length > 0) throw new Error('An external network request escaped the fixture boundary.');
  } finally {
    await disposables.dispose();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  }
});

describe('advanced settings through real schema, persistence and fixed donor capabilities', () => {
  it('persists two same-provider accounts, custom lane/preset, all eight chains, scopes and quality, then reads effective selection', async () => {
    const caps = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    let draft = createNbSearchProviderInstance(nbSearchDraftFromConfig(undefined, caps), caps, 'exa', 'account-a', 'TEAM_A_KEY');
    draft = createNbSearchProviderInstance(draft, caps, 'exa', 'account-b', 'TEAM_B_KEY');
    draft = setNbSearchLane(draft, 'account-query', { provider_instance_id: 'account-b', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['web', 'second-account'] });
    draft = setNbSearchPreset(draft, 'account-evidence', { lanes: ['account-query', 'duckduckgo.search'] });
    draft = { ...draft, defaultSearchLane: 'account-query', execution: { ...draft.execution, maxConcurrency: '3', fetchMaxRedirects: '2' }, advanced: { ...draft.advanced!,
      fileScopes: [{ id: 'documents', root: home, media_types: ['text/plain'] }], qualityMinContentChars: '80', qualityBlockedMarkers: ['fixture-blocked'],
    } };
    for (const kind of ['url', 'inline_text', 'inline_bytes', 'file'] as const) {
      for (const representation of ['markdown', 'text'] as const) draft = setNbSearchFetchChain(draft, kind, representation, [kind === 'url' ? 'direct.fetch' : 'direct.local']);
    }
    const patch = nbSearchConfigPatch(undefined, draft, caps);
    nbSearchConfigPatchSchema.parse(patch.nb_search);
    await config.replace(NB_SEARCH_SECTION, patch.nb_search);
    await config.reload();
    const saved = config.get<NbSearchConfig>(NB_SEARCH_SECTION);
    expect(saved?.provider_instances?.['account-a']?.credential_slot_id).toBe('account-a');
    expect(saved?.provider_instances?.['account-b']?.credential_slot_id).toBe('account-b');
    expect(saved?.lanes?.['account-query']?.evidence_groups).toEqual(['web', 'second-account']);
    expect(saved?.execution?.fetch?.quality).toEqual({ min_content_chars: 80, blocked_markers: ['fixture-blocked'] });
    const effective = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    expect(effective.search.default_lane).toBe('account-query');
    expect(effective.search.lanes.find((lane) => lane.id === 'account-query')?.availability).toBe('ready');
    expect(effective.search.presets.find((preset) => preset.name === 'account-evidence')?.lanes).toEqual(['account-query', 'duckduckgo.search']);
    expect(effective.fetch.chains).toHaveLength(8);
    expect(effective.fetch.inputs.find((input) => input.kind === 'file')?.enabled).toBe(true);
    expect(effective.configuration?.lanes['account-query']?.provider_instance_id).toBe('account-b');
    expect(JSON.stringify(saved)).not.toContain('fixture-a');
    const loaded = nbSearchDraftFromConfig(saved as import('@kiki/protocol').NbSearchConfigPatch, effective);
    expect(loaded.advanced?.fileScopes).toEqual([{ id: 'documents', root: home, media_types: ['text/plain'] }]);
    expect(loaded.advanced?.qualityBlockedMarkers).toEqual(['fixture-blocked']);
    const removed = { ...loaded, providers: { ...loaded.providers, 'account-a': { ...loaded.providers['account-a']!, isDeleted: true } } };
    const savedPatch = saved as import('@kiki/protocol').NbSearchConfigPatch;
    await config.replace(NB_SEARCH_SECTION, nbSearchConfigPatch(savedPatch, removed, effective).nb_search);
    await config.reload();
    const afterRemoval = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    expect(afterRemoval.providers.instances.some((instance) => instance.id === 'account-a')).toBe(false);
    expect(afterRemoval.providers.instances.find((instance) => instance.id === 'account-b')?.credential.configured).toBe(true);
    expect(afterRemoval.search.default_lane).toBe('account-query');
    const referencedRemoval = { ...loaded, providers: { ...loaded.providers, 'account-b': { ...loaded.providers['account-b']!, isDeleted: true } } };
    expect(validateNbSearchReferences(savedPatch, referencedRemoval, effective)).toContainEqual({ code: 'instance', path: 'lanes.account-query', target: 'account-b' });
  });

  it('restores a donor lane override while retaining valid default/preset references; custom deletions require reference repair', async () => {
    const caps = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    const original = caps.configuration!.lanes['duckduckgo.search']!;
    let draft = nbSearchDraftFromConfig(undefined, caps);
    draft = setNbSearchLane(draft, 'duckduckgo.search', { ...original, latency: 'slow' });
    draft = setNbSearchLane(draft, 'custom-query', original);
    draft = setNbSearchPreset(draft, 'custom-set', { lanes: ['duckduckgo.search', 'custom-query'] });
    draft = { ...draft, defaultSearchLane: 'duckduckgo.search' };
    let value = nbSearchConfigPatch(undefined, draft, caps).nb_search;
    await config.replace(NB_SEARCH_SECTION, value);
    const effective = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    expect(effective.search.lanes.find((lane) => lane.id === 'duckduckgo.search')?.latency).toBe('slow');
    draft = setNbSearchLane(nbSearchDraftFromConfig(value, effective), 'duckduckgo.search', undefined);
    expect(validateNbSearchReferences(value, draft, effective)).toEqual([]);
    value = nbSearchConfigPatch(value, draft, effective).nb_search;
    await config.replace(NB_SEARCH_SECTION, value);
    expect((await service.capabilities()).search.lanes.find((lane) => lane.id === 'duckduckgo.search')?.latency).toBe(original.latency);
    draft = setNbSearchLane(nbSearchDraftFromConfig(value, effective), 'custom-query', undefined);
    expect(validateNbSearchReferences(value, draft, effective)).toContainEqual({ code: 'lane', path: 'presets.custom-set', target: 'custom-query' });
    draft = setNbSearchPreset(draft, 'custom-set', undefined);
    const deleted = nbSearchConfigPatch(value, draft, effective).nb_search;
    await config.replace(NB_SEARCH_SECTION, deleted);
    expect((await service.capabilities()).search.lanes.some((lane) => lane.id === 'custom-query')).toBe(false);
  });

  it('restores an individual fetch chain and the actual lower-source default without calling anything paid', async () => {
    const caps = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    let draft = setNbSearchFetchChain(nbSearchDraftFromConfig(undefined, caps), 'url', 'markdown', ['jina.reader', 'direct.fetch']);
    draft = setNbSearchFetchChain(draft, 'inline_text', 'text', ['direct.local']);
    draft = { ...draft, defaultSearchLane: 'duckduckgo.search' };
    const value = nbSearchConfigPatch(undefined, draft, caps).nb_search;
    await config.replace(NB_SEARCH_SECTION, value);
    const effective = nbSearchCapabilitiesSchema.parse(await service.capabilities());
    draft = setNbSearchFetchChain(nbSearchDraftFromConfig(value, effective), 'url', 'markdown', [], true);
    draft = { ...draft, defaultSearchLane: '' };
    expect(resolveEffectiveDefaultLane(effective, '')).toEqual({ inherited: true, laneId: caps.search.default_lane });
    const restored = nbSearchConfigPatch(value, draft, effective).nb_search;
    expect(restored.defaults?.fetch_chain?.find((chain) => chain.input_kind === 'url' && chain.representation === 'markdown')?.pipelines).toEqual(caps.fetch.chains.find((chain) => chain.input_kind === 'url' && chain.representation === 'markdown')?.pipelines);
    expect(restored.defaults?.fetch_chain?.find((chain) => chain.input_kind === 'file' && chain.representation === 'markdown')?.pipelines).toEqual(['direct.local']);
    expect(restored.defaults?.fetch_chain?.some((chain) => chain.input_kind === 'file' && chain.representation === 'text')).toBe(false);
    await config.replace(NB_SEARCH_SECTION, restored);
    expect((await service.capabilities()).search.default_lane).toBe(caps.search.default_lane);
  });
});

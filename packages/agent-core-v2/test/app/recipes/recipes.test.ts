import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetch } from 'undici';
import { RecipeSourceReader } from '#/os/backends/node-fs/recipeSourceReader';

vi.mock('undici', async (original) => ({ ...await original<typeof import('undici')>(), fetch: vi.fn() }));
import { stringify } from 'smol-toml';
import { createServices } from '#/_base/di/test';
import { DisposableStore } from '#/_base/di/lifecycle';
import { applyRecipeModelSettings } from '#/app/recipes/recipeModelSettings';
import { IRecipeService, IRecipeSourceReader } from '#/app/recipes/recipes';
import { RecipeService } from '#/app/recipes/recipeService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelService } from '#/kosong/model/model';
import { IPromptFieldRegistry, type PromptFieldDefinition } from '#/app/promptField/promptFieldRegistry';

const parent = 'https://example.test/parent/recipe.toml';
const child = 'https://example.test/child/recipe.toml';
const grandchild = 'https://example.test/grandchild/recipe.toml';
const manifest = (id: string, prompts: unknown, extendsSource?: string) => stringify({ schema_version: 1, id, name: id, version: '1.0.0', prompts, ...(extendsSource === undefined ? {} : { extends: { source: extendsSource } }) });

describe('Recipe accepted revisions', () => {
  let disposables: DisposableStore;
  let service: IRecipeService;
  let documents: IAtomicDocumentStore;
  let sources: Map<string, Record<string, string>>;
  let reads: string[];
  beforeEach(() => {
    disposables = new DisposableStore(); sources = new Map(); reads = [];
    const ix = createServices(disposables, { additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore); reg.define(IBlobStore, BlobStoreService);
      reg.definePartialInstance(IBootstrapService, { scope: () => 'store' });
      reg.definePartialInstance(IConfigService, { ready: new Promise<void>(() => {}), get: <T>() => ({ markets: [] }) as T });
      reg.definePartialInstance(IFlagService, { enabled: () => true });
      reg.definePartialInstance(IModelService, { list: () => ({}) });
      reg.definePartialInstance(IPromptFieldRegistry, { get: () => ({ readonly: false }) as PromptFieldDefinition, validate: () => ({ values: {}, fields: [] }) });
      reg.definePartialInstance(IRecipeSourceReader, {
        open: async (source) => {
          const files = sources.get(source.locator); if (files === undefined) throw new Error('source unavailable');
          return { source, read: async (file) => { reads.push(`${source.locator}:${file}`); const value = files[file]; if (value === undefined) throw new Error('missing file'); return value; } };
        }, catalog: async () => ({ version: 1, recipes: [] }),
      });
      reg.define(IRecipeService, RecipeService);
    } });
    service = ix.get(IRecipeService); documents = ix.get(IAtomicDocumentStore);
    sources.set(parent, { 'recipe.toml': manifest('parent', { system: [{ file: 'same.md' }, { text: 'SECOND' }], steering: { text: 'PARENT STEERING' }, main: { system: { file: 'same.md' }, steering: { text: 'PARENT MAIN STEERING' }, fields: { 'system.language': 'PARENT LANGUAGE' } }, independent: 'off' }), 'same.md': 'PARENT FILE' });
    sources.set(child, { 'recipe.toml': manifest('child', { system: [{ text: 'ARRAY REPLACED' }], main: { steering: { text: 'CHILD MAIN STEERING' }, fields: { 'system.language': false } } }, parent), 'same.md': 'CHILD FILE MUST NOT HIJACK' });
    sources.set(grandchild, { 'recipe.toml': manifest('grandchild', { independent: 'same' }, child) });
  });
  afterEach(() => disposables.dispose());
  async function install(locator = grandchild) {
    const preview = await service.preview({ source: { locator } }); reads.length = 0;
    const result = await service.install({ preview_id: preview.preview_id }); expect(reads).toEqual([]); return result;
  }
  it('resolves three levels deterministically, replaces arrays and atomic sources, preserves parent file origins and field deletion', async () => {
    const installed = await install(); const recipe = await service.resolve(installed.installation_id);
    expect(recipe.branches.main.system).toBe('PARENT FILE'); expect(recipe.branches.main.steering).toBe('CHILD MAIN STEERING');
    expect(recipe.branches.main.fields).toEqual({}); expect(recipe.branches.sub.system).toBe('ARRAY REPLACED'); expect(recipe.branches.independent.system).toBe('ARRAY REPLACED');
    expect(recipe.dependencies).toHaveLength(2);
    expect(recipe.origins.find((origin) => origin.position === 'main' && origin.slot === 'system')).toMatchObject({ source: parent, file: 'same.md' });
    expect((await service.get(installed.installation_id))?.summary.health).toBe('ready');
  });
  it('keeps the entire old revision on bad upstream, cycles and pointer-commit failure, and serves locked content offline', async () => {
    const installed = await install(); const before = await service.resolve(installed.installation_id);
    sources.set(parent, { 'recipe.toml': manifest('parent', { system: { file: 'missing.md' } }) });
    await expect(service.update({ installation_id: installed.installation_id })).rejects.toThrow('missing file');
    expect(await service.resolve(installed.installation_id)).toEqual(before);
    expect((await service.get(installed.installation_id))?.summary).toMatchObject({ health: 'ready', last_error: { code: 'recipe-update-failed' } });
    sources.set(parent, { 'recipe.toml': manifest('parent', { system: { text: 'NEW PARENT' } }, grandchild) });
    await expect(service.update({ installation_id: installed.installation_id })).rejects.toThrow('cycle');
    sources.set(parent, { 'recipe.toml': manifest('parent', { system: { text: 'NEW PARENT' } }) });
    vi.spyOn(documents, 'update').mockRejectedValueOnce(new Error('pointer commit failed'));
    await expect(service.update({ installation_id: installed.installation_id })).rejects.toThrow('pointer commit failed');
    expect(await service.resolve(installed.installation_id)).toEqual(before);
    sources.clear(); expect(await service.resolve(installed.installation_id)).toEqual(before);
  });
  it('copy stops following, inheritance preserves local slots, pinned mode freezes the complete dependency result, and off never falls back', async () => {
    const installed = await install(child);
    const copy = await service.fork({ installation_id: installed.installation_id, mode: 'copy', id: 'copy', name: 'Copy' });
    const extended = await service.fork({ installation_id: installed.installation_id, mode: 'extend', id: 'extended', name: 'Extended' });
    const edited = await service.saveLocal({ installation_id: extended.summary.installation_id, expected_revision: extended.summary.revision,
      files: { 'recipe.toml': manifest('extended', { main: { steering: { text: 'LOCAL' } }, independent: 'off' }, child) } });
    const pinned = await service.update({ installation_id: edited.summary.installation_id, update_mode: 'pinned' });
    sources.set(parent, { 'recipe.toml': manifest('parent', { main: { system: { text: 'UPDATED PARENT' }, steering: { text: 'UPSTREAM STEERING' } } }) });
    expect((await service.checkUpdates()).find((item) => item.installation_id === pinned.installation_id)?.revision).toBe(pinned.revision);
    expect((await service.resolve(copy.summary.installation_id)).branches.main.system).toBe('PARENT FILE');
    await service.update({ installation_id: pinned.installation_id, update_mode: 'follow' });
    const updated = await service.update({ installation_id: pinned.installation_id });
    const recipe = await service.resolve(updated.installation_id);
    expect(recipe.branches.main.system).toBe('UPDATED PARENT'); expect(recipe.branches.main.steering).toBe('LOCAL'); expect(recipe.branches.independent).toEqual({ fields: {} });
    await expect(service.saveLocal({ installation_id: pinned.installation_id, expected_revision: pinned.revision, files: edited.files })).rejects.toThrow('changed');
  });
  it('reuses model schemas, merges declared parameter leaves, copies settings and cadence, and resets parent model settings without importing credentials', async () => {
    sources.set(parent, { 'recipe.toml': stringify({ schema_version: 1, id: 'parent', name: 'Parent', version: '1.0.0', model: { auto_compact: 4096, adaptive_thinking: false, parameters: { temperature: 0.2, service_tier: 'priority' }, usage: { main: { context_budget: 8192 }, independent: { context_budget: 4096 } } }, prompts: { steering: { text: 'CUE' }, steering_on_turn: false, steering_on_input: true, steering_interval_steps: 3, fields: { 'tool.read.description': 'RECIPE READ' } } }) });
    sources.set(child, { 'recipe.toml': stringify({ schema_version: 1, id: 'child', name: 'Child', version: '1.0.0', extends: { source: parent }, model: { parameters: { temperature: 0.7 } } }) });
    const installed = await install(child);
    const resolved = await service.resolve(installed.installation_id);
    expect(resolved.model).toMatchObject({ autoCompact: 4096, adaptiveThinking: false, parameters: { temperature: 0.7, serviceTier: 'priority' }, usage: { main: { contextBudget: 8192 }, independent: { contextBudget: 4096 } } });
    expect(resolved.model_origins['parameters.temperature']?.source).toBe(child);
    expect(resolved.model_origins['parameters.serviceTier']?.source).toBe(parent);
    expect(resolved.branches.main).toMatchObject({ steering_on_turn: false, steering_on_input: true, steering_interval_steps: 3, fields: { 'tool.read.description': 'RECIPE READ' } });
    const copy = await service.fork({ installation_id: installed.installation_id, mode: 'copy', id: 'copy', name: 'Copy' });
    expect(copy.resolved.model).toEqual(resolved.model);
    expect(copy.resolved.branches.main).toEqual(resolved.branches.main);
    sources.set(child, { 'recipe.toml': stringify({ schema_version: 1, id: 'child', name: 'Child', version: '1.0.0', extends: { source: parent }, model: 'off' }) });
    const reset = await service.preview({ source: { locator: child } });
    expect(reset.resolved.model).toEqual({}); expect(reset.resolved.model_origins).toEqual({});
    for (const model of [{ api_key: 'EXAMPLE_TEST_KEY' }, { parameters: { main: { service_tier: 'priority' } } }, { auto_compact: 0 }]) {
      sources.set(child, { 'recipe.toml': stringify({ schema_version: 1, id: 'child', name: 'Child', version: '1.0.0', model }) });
      await expect(service.preview({ source: { locator: child } })).rejects.toThrow('Invalid Recipe model settings');
    }
  });
  it('preserves undeclared manual override leaves while Recipe replaces a declared leaf', () => {
    const saved = { requestParams: { temperature: 0.1 }, overrides: { requestParams: { temperature: 0.2, custom: true }, autoCompact: 2048 } };
    const applied = applyRecipeModelSettings(saved, { requestParams: { temperature: 0.6 } });
    expect(applied.requestParams).toEqual({ temperature: 0.6 });
    expect(applied.overrides).toEqual({ requestParams: { custom: true }, autoCompact: 2048 });
    expect(saved.overrides.requestParams.temperature).toBe(0.2);
  });
  it('rejects a corrupt immutable revision rather than binding altered content', async () => {
    const installed = await install();
    const key = `recipes/revisions/${installed.revision.slice(7)}`;
    await documents.update<{ files: Record<string, string> }>('store', key, (snapshot) => ({ ...snapshot!, files: { ...snapshot!.files, 'recipe.toml': 'corrupt' } }));
    await expect(service.resolve(installed.installation_id)).rejects.toThrow('corrupt');
  });
});


describe('Recipe package boundaries', () => {
  let root: string;
  const reader = new RecipeSourceReader();
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'recipe-boundary-')); vi.mocked(fetch).mockReset(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('reads package files but rejects traversal and oversized text', async () => {
    await writeFile(path.join(root, 'recipe.toml'), 'schema_version = 1');
    await writeFile(path.join(root, 'prompt.md'), 'PACKAGE TEXT');
    await writeFile(path.join(root, 'oversized.md'), 'x'.repeat(256 * 1024 + 1));
    const packageReader = await reader.open({ locator: root });
    expect(await packageReader.read('recipe.toml')).toBe('schema_version = 1');
    expect(await packageReader.read('prompt.md')).toBe('PACKAGE TEXT');
    await expect(packageReader.read('../outside.md')).rejects.toThrow('relative path');
    await expect(packageReader.read('oversized.md')).rejects.toThrow('text budget');
  });
  it('rejects a directory junction escaping the package root', async (context) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'recipe-outside-'));
    try {
      await writeFile(path.join(root, 'recipe.toml'), 'schema_version = 1');
      await writeFile(path.join(outside, 'prompt.md'), 'OUTSIDE TEXT');
      try { await symlink(outside, path.join(root, 'linked'), 'junction'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
      const packageReader = await reader.open({ locator: root });
      await expect(packageReader.read('linked/prompt.md')).rejects.toThrow('escapes package root');
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('rejects credentials and private URLs before any request, including GitHub shortcuts', async () => {
    for (const locator of ['http://example.test/recipe.toml', 'https://user:password@example.test/recipe.toml', 'https://user:password@github.com/example/recipes', 'https://localhost/recipe.toml', 'https://127.0.0.1/recipe.toml', 'https://[::1]/recipe.toml']) {
      await expect(reader.open({ locator })).rejects.toThrow(/HTTPS|public address/u);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a ZIP checksum and rejects mismatched content before unpacking', async () => {
    const locator = 'https://example.test/recipe.zip';
    await expect(reader.open({ locator })).rejects.toThrow('requires SHA-256');
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not a ZIP') as Awaited<ReturnType<typeof fetch>>);
    await expect(reader.open({ locator, sha256: '0'.repeat(64) })).rejects.toThrow('checksum mismatch');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

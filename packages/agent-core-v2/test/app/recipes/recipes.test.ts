import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ZipFile } from 'yazl';
import { RecipeSourceReader } from '#/os/backends/node-fs/recipeSourceReader';
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
import { IFlagRegistry } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';
import { FlagService } from '#/app/flag/flagService';
import { Event } from '#/_base/event';
import { IModelService } from '#/kosong/model/model';
import { IPromptFieldRegistry, type PromptFieldDefinition } from '#/app/promptField/promptFieldRegistry';
import { makeHookRunner, nodeCommand } from '../../features/externalHooks/runner-stub';

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
  const modelWrites = vi.fn();
  function newStore(flagInputs?: { env?: Record<string, string>; recipes?: boolean }) {
    return createServices(disposables, { additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore); reg.define(IBlobStore, BlobStoreService);
      reg.definePartialInstance(IBootstrapService, { scope: () => 'store', getEnv: (key) => flagInputs?.env?.[key] });
      reg.definePartialInstance(IConfigService, {
        ready: new Promise<void>(() => {}),
        get: <T>(domain: string) => (domain === 'experimental' ? (flagInputs?.recipes === undefined ? {} : { recipes: flagInputs.recipes }) : { markets: [] }) as T,
        onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'], replaceSections: modelWrites,
      });
      if (flagInputs === undefined) reg.definePartialInstance(IFlagService, { enabled: () => true });
      else { reg.define(IFlagRegistry, FlagRegistryService); reg.define(IFlagService, FlagService); }
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
  }
  beforeEach(() => {
    disposables = new DisposableStore(); sources = new Map(); reads = []; modelWrites.mockClear();
    const ix = newStore(); service = ix.get(IRecipeService); documents = ix.get(IAtomicDocumentStore);
    sources.set(parent, { 'recipe.toml': manifest('parent', { system: [{ file: 'same.md' }, { text: 'SECOND' }], steering: { text: 'PARENT STEERING' }, main: { system: { file: 'same.md' }, steering: { text: 'PARENT MAIN STEERING' }, fields: { 'system.language': 'PARENT LANGUAGE' } }, independent: 'off' }), 'same.md': 'PARENT FILE' });
    sources.set(child, { 'recipe.toml': manifest('child', { system: [{ text: 'ARRAY REPLACED' }], main: { steering: { text: 'CHILD MAIN STEERING' }, fields: { 'system.language': false } } }, parent), 'same.md': 'CHILD FILE MUST NOT HIJACK' });
    sources.set(grandchild, { 'recipe.toml': manifest('grandchild', { independent: 'same' }, child) });
  });
  afterEach(() => disposables.dispose());
  async function install(locator = grandchild) {
    const preview = await service.preview({ source: { locator } }); reads.length = 0;
    const result = await service.install({ preview_id: preview.preview_id }); expect(reads).toEqual([]); return result;
  }
  it('reads installed Recipes with the released default and no experimental overrides', async () => {
    const ix = newStore({});
    const flags = ix.get(IFlagService);
    expect(flags.explain('recipes')).toMatchObject({ enabled: true, source: 'default' });
    const recipes = ix.get(IRecipeService);
    expect(await recipes.list()).toEqual([]);
    const preview = await recipes.preview({ source: { locator: parent } });
    const installed = await recipes.install({ preview_id: preview.preview_id });
    expect(await recipes.list()).toHaveLength(1);
    expect((await recipes.get(installed.installation_id))?.summary.revision).toBe(installed.revision);
    expect((await recipes.resolve(installed.installation_id)).branches.main.system).toBe('PARENT FILE');
  });
  it.each<{ env: Record<string, string>; recipes: boolean; source: string }>([
    { env: { KIKI_EXPERIMENTAL_FLAG: 'true' }, recipes: false, source: 'config' },
    { env: { KIKI_EXPERIMENTAL_RECIPES: 'false', KIKI_EXPERIMENTAL_FLAG: 'true' }, recipes: true, source: 'env' },
  ])('keeps explicit $source false above the released Recipe default', async ({ env, recipes, source }) => {
    const ix = newStore({ env: env ?? {}, recipes });
    expect(ix.get(IFlagService).explain('recipes')).toMatchObject({ enabled: false, source });
    const disabled = ix.get(IRecipeService);
    await expect(disabled.list()).rejects.toThrow('Enable experimental recipes');
    await expect(disabled.get('unused')).rejects.toThrow('Enable experimental recipes');
    await expect(disabled.resolve('unused')).rejects.toThrow('Enable experimental recipes');
  });
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
  it('exports a locally inherited accepted package without mutation and installs it in an empty home', async () => {
    sources.set(parent, { 'recipe.toml': stringify({ schema_version: 1, id: 'parent', name: 'Parent', version: '2.1.0', model: { parameters: { temperature: 0.2, service_tier: 'priority' }, usage: { independent: { context_budget: 4096 } } }, prompts: { system: { file: 'body.md' }, steering: { text: 'INHERITED CUE' }, steering_interval_steps: 3, independent: 'off' } }), 'body.md': 'INHERITED BODY' });
    const installed = await install(parent);
    const local = await service.fork({ installation_id: installed.installation_id, mode: 'copy', id: 'local-parent', name: 'Local parent' });
    const child = await service.fork({ installation_id: local.summary.installation_id, mode: 'extend', id: 'portable', name: 'Portable' });
    const edited = await service.saveLocal({ installation_id: child.summary.installation_id, expected_revision: child.summary.revision, files: { 'recipe.toml': stringify({ schema_version: 1, id: 'portable', name: 'Portable', description: 'Portable snapshot', version: '1.2.3', extends: { source: local.summary.source.locator }, model: { parameters: { temperature: 0.65 } }, prompts: { steering_on_input: false } }) } });
    const before = await service.list(); reads.length = 0;
    const changed = vi.fn(); disposables.add(service.onDidChange(changed));
    const set = vi.spyOn(documents, 'set'); const update = vi.spyOn(documents, 'update');
    const exported = await service.export(edited.summary.installation_id);
    expect(exported).toMatchObject({ name: 'portable-1.2.3.zip', revision: edited.summary.revision });
    expect(exported.files['recipe.toml']).not.toContain('installation:');
    expect(exported.files['recipe.toml']).not.toContain('extends');
    expect(await service.list()).toEqual(before); expect(await service.get(edited.summary.installation_id)).toEqual(edited);
    expect(reads).toEqual([]); expect(changed).not.toHaveBeenCalled(); expect(modelWrites).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    set.mockRestore(); update.mockRestore();
    const portable = 'https://example.test/portable/recipe.toml'; sources.clear(); sources.set(portable, exported.files);
    const fresh = newStore().get(IRecipeService); expect(await fresh.list()).toEqual([]);
    const preview = await fresh.preview({ source: { locator: portable } });
    const imported = await fresh.install({ preview_id: preview.preview_id }); const resolved = await fresh.resolve(imported.installation_id);
    expect(resolved.branches).toEqual(edited.resolved.branches); expect(resolved.model).toEqual(edited.resolved.model); expect(resolved.dependencies).toEqual([]);
    expect((await fresh.get(imported.installation_id))?.summary).toMatchObject({ manifest_id: 'portable', version: '1.2.3', description: 'Portable snapshot' });
    expect(await fresh.list()).toHaveLength(1); expect(await service.list()).toEqual(before); expect(modelWrites).not.toHaveBeenCalled();
  });
  it('rejects a corrupt immutable revision rather than binding altered content', async () => {
    const installed = await install();
    const key = `recipes/revisions/${installed.revision.slice(7)}`;
    await documents.update<{ files: Record<string, string> }>('store', key, (snapshot) => ({ ...snapshot!, files: { ...snapshot!.files, 'recipe.toml': 'corrupt' } }));
    await expect(service.resolve(installed.installation_id)).rejects.toThrow('corrupt');
  });
});


describe('Recipe script hooks', () => {
  let disposables: DisposableStore;
  let readerDisposables: DisposableStore;
  let service: IRecipeService;
  let sources: Map<string, Record<string, string>>;
  let hookHome: string;
  let resourceReader: IRecipeSourceReader;
  let materializations: number;
  const pending = new Promise<void>(() => {});
  const hookCommand = nodeCommand("const fs = require('node:fs'); process.stdout.write(process.env.KIKI_RECIPE_ROOT + '|' + fs.readFileSync(process.env.KIKI_RECIPE_ROOT + '/hook.js', 'utf8'));");
  const hook = (command: string, root = 'resources') => [{ event: 'Stop', command, root, files: ['hook.js'], timeout: 5 }];
  const packageManifest = (id: string, options: { hooks?: unknown; prompts?: unknown; extendsSource?: string; version?: string } = {}) => stringify({
    schema_version: 1, id, name: id, version: options.version ?? '1.0.0',
    ...(options.extendsSource === undefined ? {} : { extends: { source: options.extendsSource } }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }), prompts: options.prompts ?? {},
  });
  function putPackage(locator: string, id: string, options: { hooks?: unknown; prompts?: unknown; extendsSource?: string; version?: string; files?: Record<string, string> } = {}): void {
    const files: Record<string, string> = { 'recipe.toml': packageManifest(id, options) };
    Object.assign(files, options.files);
    sources.set(locator, files);
  }
  function newStore(ready: Promise<void> = pending) {
    return createServices(disposables, { additionalServices: (reg) => {
      reg.defineInstance(IFileSystemStorageService, new InMemoryStorageService());
      reg.define(IAtomicDocumentStore, JsonAtomicDocumentStore); reg.define(IBlobStore, BlobStoreService);
      reg.definePartialInstance(IBootstrapService, { scope: () => 'store', getEnv: () => undefined });
      reg.definePartialInstance(IConfigService, {
        ready,
        get: <T>(domain: string) => (domain === 'experimental' ? {} : { markets: [] }) as T,
        onDidChangeConfiguration: Event.None as IConfigService['onDidChangeConfiguration'],
        replaceSections: async () => undefined,
      });
      reg.definePartialInstance(IFlagService, { enabled: () => true });
      reg.definePartialInstance(IModelService, { list: () => ({}) });
      reg.definePartialInstance(IPromptFieldRegistry, { get: () => ({ readonly: false }) as PromptFieldDefinition, validate: () => ({ values: {}, fields: [] }) });
      reg.definePartialInstance(IRecipeSourceReader, {
        open: async (source) => {
          const files = sources.get(source.locator); if (files === undefined) throw new Error('source unavailable');
          return { source, read: async (file) => files[file] ?? (() => { throw new Error(`missing file: ${file}`); })() };
        },
        catalog: async () => ({ version: 1, recipes: [] }),
        materializeHooks: async (hooks) => { materializations++; return resourceReader.materializeHooks(hooks); },
      });
      reg.define(IRecipeService, RecipeService);
    } });
  }
  async function install(source: string, consent = true): Promise<{ preview: Awaited<ReturnType<IRecipeService['preview']>>; summary: Awaited<ReturnType<IRecipeService['install']>> }> {
    const preview = await service.preview({ source: { locator: source } });
    const summary = await service.install({ preview_id: preview.preview_id, consent });
    return { preview, summary };
  }
  beforeEach(async () => {
    disposables = new DisposableStore(); readerDisposables = new DisposableStore(); sources = new Map(); materializations = 0;
    hookHome = await mkdtemp(path.join(tmpdir(), 'recipe-hook-home-'));
    const readerServices = createServices(readerDisposables, { additionalServices: (reg) => {
      reg.definePartialInstance(IBootstrapService, { homeDir: hookHome });
      reg.define(IRecipeSourceReader, RecipeSourceReader);
    } });
    resourceReader = readerServices.get(IRecipeSourceReader);
    service = newStore().get(IRecipeService);
  });
  afterEach(async () => { await disposables.dispose(); await readerDisposables.dispose(); await rm(hookHome, { recursive: true, force: true }); });
  it.each(['SessionStart', 'SessionEnd', 'SessionHeartbeat', 'SubagentStart', 'SubagentStop'])('rejects unbound Recipe event %s with an actionable diagnostic', async (event) => {
    putPackage(child, 'child', { hooks: [{ ...hook(hookCommand)[0], event }], files: { 'resources/hook.js': 'SCRIPT' } });
    await expect(service.preview({ source: { locator: child } })).rejects.toMatchObject({
      message: expect.stringContaining('Recipe hooks require an Agent-bound event'), details: { path: 'hooks.0.event' },
    });
    expect(await service.list()).toEqual([]); expect(materializations).toBe(0);
  });
  it('previews command and resources and isolates same-named parent and child scripts', async () => {
    putPackage(parent, 'parent', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'PARENT' } });
    putPackage(child, 'child', { extendsSource: parent, hooks: hook(hookCommand), files: { 'resources/hook.js': 'CHILD' } });
    const preview = await service.preview({ source: { locator: child } });
    expect(preview.hooks).toMatchObject({ consent_required: true, scripts: [
      { event: 'Stop', command: hookCommand, source: parent, files: [{ path: 'hook.js', bytes: 6, sha256: `sha256:${createHash('sha256').update('PARENT').digest('hex')}` }] },
      { event: 'Stop', command: hookCommand, source: child, files: [{ path: 'hook.js', bytes: 5 }] },
    ] });
    expect(preview.resolved.hooks?.map((item) => ({ source: item.source, files: item.files }))).toEqual([
      { source: parent, files: { 'hook.js': 'PARENT' } }, { source: child, files: { 'hook.js': 'CHILD' } },
    ]);
    const installed = await service.install({ preview_id: preview.preview_id, consent: true });
    const resolved = await service.resolve(installed.installation_id);
    const hooks = await service.scriptHooks(resolved);
    expect(hooks).toHaveLength(2);
    expect(new Set(hooks.map((item) => item.cwd)).size).toBe(2);
    expect(hooks.every((item) => item.env?.['KIKI_RECIPE_ROOT'] === item.cwd)).toBe(true);
    for (const item of hooks) expect(await readFile(path.join(item.cwd!, 'hook.js'), 'utf8')).toBe(item.cwd === hooks[0]?.cwd ? 'PARENT' : 'CHILD');
    const runner = makeHookRunner([]);
    const results = await runner.trigger('Stop', { additionalHooks: async () => hooks });
    expect(results).toMatchObject([{ action: 'allow' }, { action: 'allow' }]);
    expect(results.map((result) => result.stdout?.split('|')[1]?.trim()).sort()).toEqual(['CHILD', 'PARENT']);
    await writeFile(path.join(hooks[0]!.cwd!, 'hook.js'), 'CORRUPT');
    await expect(service.scriptHooks(resolved)).rejects.toThrow('corrupt');
    await runner.dispose();
  });
  it('requires one explicit consent, leaves a declined install inert, and allows old hook-free packages without consent', async () => {
    const marker = path.join(hookHome, 'executed');
    const command = nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`);
    putPackage(parent, 'hooked', { hooks: hook(command), files: { 'resources/hook.js': 'resource' } });
    const preview = await service.preview({ source: { locator: parent } });
    expect(preview.hooks?.consent_required).toBe(true);
    await expect(service.install({ preview_id: preview.preview_id, consent: false })).rejects.toMatchObject({ details: { code: 'recipe-hook-consent-required' } });
    expect(await service.list()).toEqual([]);
    expect(materializations).toBe(0);
    await expect(access(marker)).rejects.toThrow();
    const accepted = await service.install({ preview_id: preview.preview_id, consent: true });
    expect(accepted.hooks_fingerprint).toBeDefined();
    const plain = 'https://example.test/plain/recipe.toml';
    putPackage(plain, 'plain', { prompts: { system: { text: 'NO HOOK' } } });
    const plainPreview = await service.preview({ source: { locator: plain } });
    expect(plainPreview.hooks).toEqual({ fingerprint: undefined, consent_required: false, scripts: [] });
    const plainInstall = await service.install({ preview_id: plainPreview.preview_id });
    expect(plainInstall.hooks_fingerprint).toBeUndefined();
  });
  it('does not repeat consent when only prompt content changes', async () => {
    putPackage(parent, 'same-hook', { hooks: hook(hookCommand), prompts: { system: { text: 'V1' } }, files: { 'resources/hook.js': 'same' } });
    const first = await install(parent);
    putPackage(parent, 'same-hook', { hooks: hook(hookCommand), prompts: { system: { text: 'V2' } }, files: { 'resources/hook.js': 'same' } });
    const preview = await service.preview({ source: { locator: parent }, installation_id: first.summary.installation_id, expected_revision: first.summary.revision });
    expect(preview.hooks?.consent_required).toBe(false);
    const updated = await service.install({ preview_id: preview.preview_id });
    expect(updated.revision).not.toBe(first.summary.revision);
    expect((await service.resolve(updated.installation_id)).branches.main.system).toBe('V2');
  });
  it('preserves the old pointer when a command or resource changes without consent', async () => {
    putPackage(parent, 'changed-hook', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'OLD' } });
    const first = await install(parent);
    const newCommand = nodeCommand('process.stdout.write("new");');
    putPackage(parent, 'changed-hook', { hooks: hook(newCommand, 'new-resources'), files: { 'new-resources/hook.js': 'NEW' } });
    const preview = await service.preview({ source: { locator: parent }, installation_id: first.summary.installation_id, expected_revision: first.summary.revision });
    expect(preview.hooks?.consent_required).toBe(true);
    await expect(service.install({ preview_id: preview.preview_id })).rejects.toMatchObject({ details: { code: 'recipe-hook-consent-required' } });
    expect((await service.get(first.summary.installation_id))?.summary.revision).toBe(first.summary.revision);
    expect((await service.resolve(first.summary.installation_id)).hooks?.[0]).toMatchObject({ command: hookCommand, files: { 'hook.js': 'OLD' }, source: parent });
  });
  it('treats a new hook source as consent-requiring while preserving the installed source pointer', async () => {
    const parentTwo = 'https://example.test/parent-two/recipe.toml';
    putPackage(parent, 'parent', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'OLD' } });
    putPackage(child, 'child', { extendsSource: parent });
    const first = await install(child);
    putPackage(parentTwo, 'parent-two', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'OLD' } });
    putPackage(child, 'child', { extendsSource: parentTwo });
    const preview = await service.preview({ source: { locator: child }, installation_id: first.summary.installation_id, expected_revision: first.summary.revision });
    expect(preview.resolved.hooks?.[0]?.source).toBe(parentTwo);
    expect(preview.hooks?.consent_required).toBe(true);
    await expect(service.install({ preview_id: preview.preview_id })).rejects.toMatchObject({ details: { code: 'recipe-hook-consent-required' } });
    expect((await service.get(first.summary.installation_id))?.summary.source.locator).toBe(child);
    expect((await service.resolve(first.summary.installation_id)).hooks?.[0]?.source).toBe(parent);
  });
  it('does not silently publish a new hook during automatic follow checks', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    service = newStore(ready).get(IRecipeService);
    putPackage(parent, 'followed', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'OLD' } });
    const first = await install(parent);
    putPackage(parent, 'followed', { hooks: hook(nodeCommand('process.stdout.write("new");')), files: { 'resources/hook.js': 'NEW' } });
    release();
    await vi.waitFor(async () => expect((await service.get(first.summary.installation_id))?.summary).toMatchObject({ revision: first.summary.revision, update_available: true, hook_consent_required: true }));
    expect((await service.get(first.summary.installation_id))?.summary.revision).toBe(first.summary.revision);
    expect((await service.resolve(first.summary.installation_id)).hooks?.[0]?.files).toEqual({ 'hook.js': 'OLD' });
  });
  it('forks trusted hook content in copy and extend modes without another confirmation', async () => {
    putPackage(parent, 'forked', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'FORK' } });
    const first = await install(parent);
    const copy = await service.fork({ installation_id: first.summary.installation_id, mode: 'copy', id: 'copy-hooks', name: 'Copy hooks' });
    const extended = await service.fork({ installation_id: first.summary.installation_id, mode: 'extend', id: 'extend-hooks', name: 'Extend hooks' });
    expect(copy.resolved.hooks?.map((item) => ({ command: item.command, files: item.files }))).toEqual([{ command: hookCommand, files: { 'hook.js': 'FORK' } }]);
    expect(extended.resolved.hooks?.map((item) => ({ command: item.command, files: item.files }))).toEqual([{ command: hookCommand, files: { 'hook.js': 'FORK' } }]);
    await expect(service.resolve(copy.summary.installation_id)).resolves.toMatchObject({ hooks: [{ files: { 'hook.js': 'FORK' } }] });
    await expect(service.resolve(extended.summary.installation_id)).resolves.toMatchObject({ hooks: [{ files: { 'hook.js': 'FORK' } }] });
  });
  it('binds preview target, expected revision, and files to an install CAS', async () => {
    const base = 'https://example.test/base/recipe.toml';
    putPackage(base, 'base', { prompts: { system: { text: 'BASE' } } });
    const installed = await install(base, false);
    const editable = await service.fork({ installation_id: installed.summary.installation_id, mode: 'copy', id: 'editable-hooks', name: 'Editable hooks' });
    const editedManifest = packageManifest('editable-hooks', { hooks: hook(hookCommand, 'resources'), prompts: { system: { text: 'EDITED' } } });
    const preview = await service.preview({ source: editable.summary.source, installation_id: editable.summary.installation_id, expected_revision: editable.summary.revision,
      files: { 'recipe.toml': editedManifest, 'resources/hook.js': 'EDITED RESOURCE' } });
    expect(preview.summary.installation_id).toBe(editable.summary.installation_id);
    expect(preview.resolved.hooks?.[0]?.files).toEqual({ 'hook.js': 'EDITED RESOURCE' });
    const changed = await service.saveLocal({ installation_id: editable.summary.installation_id, expected_revision: editable.summary.revision,
      files: { 'recipe.toml': packageManifest('editable-hooks', { prompts: { system: { text: 'CONCURRENT' } } }) } });
    await expect(service.install({ preview_id: preview.preview_id, consent: true })).rejects.toThrow('changed');
    expect((await service.get(editable.summary.installation_id))?.summary.revision).toBe(changed.summary.revision);
    expect((await service.get(editable.summary.installation_id))?.resolved.branches.main.system).toBe('CONCURRENT');
  });
  it('exports hook resources and requires first consent when reinstalling the package', async () => {
    putPackage(parent, 'exported-hooks', { hooks: hook(hookCommand), files: { 'resources/hook.js': 'EXPORTED' } });
    const first = await install(parent);
    const exported = await service.export(first.summary.installation_id);
    expect(exported.files['hooks/0/hook.js']).toBe('EXPORTED');
    expect(exported.files['recipe.toml']).toContain('hooks/0');
    const portable = 'https://example.test/portable-hooks/recipe.toml';
    sources.set(portable, exported.files);
    const fresh = newStore().get(IRecipeService);
    const preview = await fresh.preview({ source: { locator: portable } });
    expect(preview.hooks?.consent_required).toBe(true);
    await expect(fresh.install({ preview_id: preview.preview_id })).rejects.toMatchObject({ details: { code: 'recipe-hook-consent-required' } });
    const imported = await fresh.install({ preview_id: preview.preview_id, consent: true });
    const resolved = await fresh.resolve(imported.installation_id);
    expect(resolved.hooks?.[0]?.files).toEqual({ 'hook.js': 'EXPORTED' });
    const hooks = await fresh.scriptHooks(resolved);
    expect(await readFile(path.join(hooks[0]!.cwd!, 'hook.js'), 'utf8')).toBe('EXPORTED');
    const runner = makeHookRunner([]);
    const result = await runner.trigger('Stop', { additionalHooks: async () => hooks });
    expect(result).toMatchObject([{ action: 'allow' }]);
    expect(result[0]?.stdout).toContain('EXPORTED');
    await runner.dispose();
  });
});

describe('Recipe package boundaries', () => {
  let root: string;
  let reader: IRecipeSourceReader;
  let disposables: DisposableStore;
  let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'recipe-boundary-'));
    disposables = new DisposableStore();
    const ix = createServices(disposables, { additionalServices: (reg) => {
      reg.definePartialInstance(IBootstrapService, { homeDir: root });
      reg.define(IRecipeSourceReader, RecipeSourceReader);
    } });
    reader = ix.get(IRecipeSourceReader);
    fetchMock = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => { vi.unstubAllGlobals(); await disposables.dispose(); await rm(root, { recursive: true, force: true }); });
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
  it('retains arbitrary script resources in a guarded ZIP package', async () => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const archive = new Promise<Buffer>((resolve) => {
      zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    zip.addBuffer(Buffer.from('schema_version = 1'), 'package/recipe.toml');
    zip.addBuffer(Buffer.from('process.stdout.write("ZIP SCRIPT")'), 'package/hooks/hook.js');
    zip.end();
    const bytes = await archive;
    const locator = 'https://93.184.216.34/package.zip';
    fetchMock.mockResolvedValueOnce(new Response(bytes));
    const packageReader = await reader.open({ locator, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(await packageReader.read('hooks/hook.js')).toBe('process.stdout.write("ZIP SCRIPT")');
  });
  it('rejects credentials and private URLs before any request, including GitHub shortcuts', async () => {
    for (const locator of ['http://example.test/recipe.toml', 'https://user:password@example.test/recipe.toml', 'https://user:password@github.com/example/recipes', 'https://localhost/recipe.toml', 'https://127.0.0.1/recipe.toml', 'https://[::1]/recipe.toml']) {
      await expect(reader.open({ locator })).rejects.toThrow(/HTTPS|public address/u);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires a ZIP checksum and rejects mismatched content before unpacking', async () => {
    const locator = 'https://93.184.216.34/recipe.zip';
    await expect(reader.open({ locator })).rejects.toThrow('requires SHA-256');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response('not a ZIP'));
    await expect(reader.open({ locator, sha256: '0'.repeat(64) })).rejects.toThrow('checksum mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('delegates redirects to guarded-fetch while retaining the Recipe subtree and credential boundaries', async () => {
    const source = 'https://93.184.216.34/package/recipe.toml';
    const packageReader = await reader.open({ locator: source });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/package/actual.md' } })).mockResolvedValueOnce(new Response('IN PACKAGE'));
    expect(await packageReader.read('body.md')).toBe('IN PACKAGE'); expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const location of ['/outside/body.md', 'https://8.8.8.8/package/body.md', 'https://user:password@93.184.216.34/package/body.md', 'https://127.0.0.1/package/body.md']) {
      fetchMock.mockReset(); fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
      await expect(packageReader.read('body.md')).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
  it('retains HTTP, strict UTF-8 and byte-budget failure behavior', async () => {
    const packageReader = await reader.open({ locator: 'https://93.184.216.34/package/recipe.toml' });
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(packageReader.read('body.md')).rejects.toThrow('HTTP 503');
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
    await expect(packageReader.read('body.md')).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)));
    await expect(packageReader.read('body.md')).rejects.toThrow('text budget');
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(reader.catalog('https://93.184.216.34/catalog.json')).rejects.toThrow('download exceeds budget');
  });
});

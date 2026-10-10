import { randomUUID } from 'node:crypto';
import { stringify } from 'smol-toml';
import type { RecipeExport, RecipeDetail, RecipeForkInput, RecipeInstallInput, RecipeMarket, RecipeMarketInput, RecipePreview, RecipePreviewInput, RecipeRemoveInput, RecipeSaveLocalInput, RecipeSource, RecipeSummary, RecipeUpdateInput, ResolvedRecipe } from '@kiki/protocol';
import { recipeCatalogSchema, resolvedRecipeSchema } from '@kiki/protocol';
import { IRecipeService, IRecipeSourceReader, type RecipePackageReader } from './recipes';
import { mergeRecipe, parseRecipe, recipeDigest, recipeFailure, resolveRecipe, validateRecipePath, type RecipeSnapshot } from './recipeParser';
import { RECIPES_SECTION, type RecipesConfig } from './configSection';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { modelsToToml } from '#/app/kosongConfig/configSection';
import { IFlagService } from '#/app/flag/flag';
import { IPromptFieldRegistry } from '#/app/promptField/promptFieldRegistry';
import { IModelService, type ModelsSection } from '#/kosong/model/model';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';

interface Installation { summary: RecipeSummary; history: string[]; editable: boolean; checked_at?: number }
interface Candidate { preview: RecipePreview; snapshot: RecipeSnapshot; expires: number }
export class RecipeService extends Disposable implements IRecipeService {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private readonly candidates = new Map<string, Candidate>();
  private readonly marketCache = new Map<string, { value: RecipeMarket; expires: number }>();
  private checking: Promise<RecipeSummary[]> | undefined;
  private readonly scope: string;
  constructor(
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IBlobStore private readonly blobs: IBlobStore,
    @IBootstrapService bootstrap: IBootstrapService,
    @IRecipeSourceReader private readonly sources: IRecipeSourceReader,
    @IPromptFieldRegistry private readonly fields: IPromptFieldRegistry,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly models: IModelService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super(); this.scope = bootstrap.scope('store');
    const tick = () => { if (this.flags.enabled('recipes')) void this.checkDue().catch(() => undefined); };
    void this.config.ready.then(tick);
    const timer = setInterval(tick, 24 * 60 * 60 * 1000); timer.unref();
    this._register(toDisposable(() => clearInterval(timer)));
  }
  private enabled(): void { if (!this.flags.enabled('recipes')) throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Enable experimental recipes to use Recipe packages'); }
  private key(revision: string): string { return `recipes/revisions/${revision.slice(7)}`; }
  private async snapshot(revision: string): Promise<RecipeSnapshot> {
    const value = await this.documents.get<RecipeSnapshot>(this.scope, this.key(revision));
    if (value === undefined || !resolvedRecipeSchema.safeParse(value.resolved).success || value.resolved.revision !== revision || this.snapshotDigest(value) !== revision) recipeFailure('Recipe revision is unavailable or corrupt', revision);
    return value;
  }
  private async records(): Promise<Record<string, Installation>> { return await this.documents.get<Record<string, Installation>>(this.scope, 'recipes/installations') ?? {}; }
  private async record(id: string): Promise<Installation> { const value = (await this.records())[id]; if (value === undefined) recipeFailure('Recipe installation not found', id); return value; }
  private usedBy(id: string): string[] { return Object.entries(this.models.list()).filter(([, model]) => model.recipe === id).map(([alias]) => alias); }
  async list(): Promise<RecipeSummary[]> { this.enabled(); return Object.values(await this.records()).map((value) => value.summary); }
  async get(id: string): Promise<RecipeDetail | undefined> {
    this.enabled(); const record = (await this.records())[id]; if (record === undefined) return undefined;
    const snapshot = await this.snapshot(record.summary.revision);
    return { summary: record.summary, resolved: snapshot.resolved, files: snapshot.files, history: record.history, editable: record.editable, used_by: this.usedBy(id) };
  }
  async resolve(id: string): Promise<ResolvedRecipe> { this.enabled(); return structuredClone((await this.snapshot((await this.record(id)).summary.revision)).resolved); }
  private async prepare(source: RecipeSource, chain: string[] = [], files?: Record<string, string>): Promise<RecipeSnapshot> {
    let reader: RecipePackageReader;
    if (files !== undefined) reader = this.fileReader(source, files);
    else if (source.locator.startsWith('installation:')) {
      const parent = await this.record(source.locator.slice('installation:'.length));
      const snapshot = await this.snapshot(parent.summary.revision);
      if (!parent.editable) return snapshot;
      reader = this.fileReader(source, snapshot.files);
    } else reader = await this.sources.open(source);
    const locator = reader.source.locator;
    if (chain.includes(locator) || chain.length >= 16) recipeFailure(`Recipe inheritance cycle or depth limit: ${[...chain, locator].join(' → ')}`, locator);
    const parsed = await parseRecipe(reader, this.fields);
    let declaration = parsed.declaration; const dependencies: ResolvedRecipe['dependencies'] = [];
    if (parsed.manifest.extends !== undefined) {
      const parentSource = { locator: parsed.manifest.extends.source, sha256: parsed.manifest.extends.sha256 };
      if (/^https:/u.test(locator) && !/^https:|^installation:/u.test(parentSource.locator)) recipeFailure('Remote Recipe cannot inherit a local path', locator, 'extends.source');
      const parent = parsed.manifest.extends.revision === undefined
        ? await this.prepare(parentSource, [...chain, locator]) : await this.snapshot(parsed.manifest.extends.revision);
      if (parsed.manifest.extends.revision !== undefined && parent.source.locator !== parentSource.locator && parent.requestedSource.locator !== parentSource.locator) recipeFailure('Pinned parent source does not match revision', locator, 'extends');
      declaration = mergeRecipe(parent.declaration, declaration);
      dependencies.push(...parent.resolved.dependencies, { source: parent.source, manifest_id: parent.manifest.id, version: parent.manifest.version, revision: parent.resolved.revision });
    }
    const resolved = resolveRecipe(declaration, dependencies);
    const snapshot = { ...parsed, source: reader.source, requestedSource: source, declaration, resolved };
    resolved.revision = this.snapshotDigest(snapshot);
    await this.persistSnapshot(snapshot);
    return snapshot;
  }
  private snapshotDigest(snapshot: RecipeSnapshot): string {
    return recipeDigest({ ...snapshot, resolved: { ...snapshot.resolved, revision: undefined } });
  }
  private fileReader(source: RecipeSource, files: Record<string, string>): RecipePackageReader {
    let total = 0;
    for (const [file, text] of Object.entries(files)) {
      validateRecipePath(file); total += Buffer.byteLength(text);
      if (Buffer.byteLength(text) > 256 * 1024 || total > 4 * 1024 * 1024) recipeFailure('Recipe exceeds text budget', source.locator, file);
    }
    return { source, read: async (file) => { const text = files[validateRecipePath(file)]; if (text === undefined) recipeFailure('Recipe referenced file is missing', source.locator, file); return text; } };
  }
  private async persistSnapshot(snapshot: RecipeSnapshot): Promise<void> {
    for (const [file, text] of Object.entries(snapshot.files)) await this.blobs.put(this.scope, `recipes/content/${recipeDigest(text).slice(7)}`, new TextEncoder().encode(text));
    await this.documents.set(this.scope, this.key(snapshot.resolved.revision), snapshot);
  }
  private summary(snapshot: RecipeSnapshot, id: string, mode: RecipeSummary['update_mode']): RecipeSummary {
    return { installation_id: id, manifest_id: snapshot.manifest.id, name: snapshot.manifest.name, version: snapshot.manifest.version, description: snapshot.manifest.description, revision: snapshot.resolved.revision, source: snapshot.source, update_mode: mode, health: 'ready' };
  }
  async preview(input: RecipePreviewInput): Promise<RecipePreview> {
    this.enabled(); for (const [id, candidate] of this.candidates) if (candidate.expires < Date.now()) this.candidates.delete(id);
    if (this.candidates.size >= 32) recipeFailure('Too many pending Recipe previews; install or wait for expiry');
    const snapshot = await this.prepare(input.source);
    const preview_id = randomUUID(); const id = randomUUID();
    const pinned = input.source.sha256 !== undefined || /\/commit\/|\/tree\/[a-f0-9]{40}$/u.test(input.source.locator);
    const preview: RecipePreview = { preview_id, digest: snapshot.resolved.revision, summary: this.summary(snapshot, id, pinned ? 'pinned' : 'follow'), resolved: snapshot.resolved, diagnostics: [] };
    this.candidates.set(preview_id, { preview, snapshot, expires: Date.now() + 15 * 60_000 });
    return structuredClone(preview);
  }
  async install(input: RecipeInstallInput): Promise<RecipeSummary> {
    this.enabled(); const candidate = this.candidates.get(input.preview_id);
    if (candidate === undefined || candidate.expires < Date.now()) recipeFailure('Recipe preview expired; preview the source again');
    const summary = { ...candidate.preview.summary, update_mode: input.update_mode ?? candidate.preview.summary.update_mode };
    await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => ({ ...records, [summary.installation_id]: { summary, history: [summary.revision], editable: false } }));
    this.candidates.delete(input.preview_id); this.changed.fire(); return summary;
  }
  private async publish(id: string, snapshot: RecipeSnapshot, expected?: string, mode?: RecipeSummary['update_mode']): Promise<RecipeSummary> {
    let result: RecipeSummary | undefined;
    await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => {
      const old = records?.[id]; if (old === undefined) recipeFailure('Recipe installation not found', id);
      if (expected !== undefined && old.summary.revision !== expected) recipeFailure('Recipe changed; reload before saving', id, 'expected_revision');
      result = { ...this.summary(snapshot, id, mode ?? old.summary.update_mode), copied_from: old.summary.copied_from };
      return { ...records, [id]: { ...old, summary: result, checked_at: Date.now(), history: [...new Set([...old.history, snapshot.resolved.revision])] } };
    });
    this.changed.fire(); return result!;
  }
  async update(input: RecipeUpdateInput): Promise<RecipeSummary> {
    this.enabled(); const old = await this.record(input.installation_id);
    if (input.revision !== undefined && !old.history.includes(input.revision)) recipeFailure('Recipe revision is not in installation history', input.installation_id);
    try {
      const snapshot = input.revision !== undefined ? await this.snapshot(input.revision)
        : input.update_mode !== undefined ? await this.snapshot(old.summary.revision) : await this.prepare(old.summary.source);
      return await this.publish(input.installation_id, snapshot, input.expected_revision ?? old.summary.revision, input.update_mode);
    } catch (error) {
      await this.reportError(input.installation_id, error); throw error;
    }
  }
  private async reportError(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => {
      const old = records?.[id]; if (old === undefined) return records;
      return { ...records, [id]: { ...old, checked_at: Date.now(), summary: { ...old.summary, last_error: { code: 'recipe-update-failed', message, source: old.summary.source.locator } } } };
    }); this.changed.fire();
  }
  async checkUpdates(): Promise<RecipeSummary[]> {
    this.enabled(); if (this.checking !== undefined) return this.checking;
    this.checking = this.check(false).finally(() => { this.checking = undefined; }); return this.checking;
  }
  private async checkDue(): Promise<void> {
    if (this.checking !== undefined) return;
    this.checking = this.check(true).finally(() => { this.checking = undefined; }); await this.checking;
  }
  private async check(accept: boolean): Promise<RecipeSummary[]> {
    for (const [id, record] of Object.entries(await this.records())) {
      if (record.summary.update_mode === 'pinned' || accept && Date.now() - (record.checked_at ?? 0) < 24 * 60 * 60_000) continue;
      try {
        const next = await this.prepare(record.summary.source);
        if (accept) await this.publish(id, next, record.summary.revision);
        else await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => {
          const current = records?.[id]; if (current === undefined || current.summary.revision !== record.summary.revision) return records;
          return { ...records, [id]: { ...current, summary: { ...current.summary, update_available: next.resolved.revision !== current.summary.revision, last_error: undefined } } };
        });
      } catch (error) { await this.reportError(id, error); }
    }
    this.changed.fire(); return this.list();
  }
  async export(id: string): Promise<RecipeExport> {
    this.enabled(); const record = await this.record(id); const snapshot = await this.snapshot(record.summary.revision);
    return { name: `${snapshot.manifest.id}-${snapshot.manifest.version}.zip`, revision: record.summary.revision, files: this.copyFiles(snapshot, snapshot.manifest) };
  }
  private copyFiles(snapshot: RecipeSnapshot, identity: { id: string; name: string; version: string; description?: string }): Record<string, string> {
    const prompts = Object.fromEntries(Object.entries(snapshot.resolved.branches).filter(([position]) => position !== 'sub').map(([position, branch]) => [position, this.branchManifest(branch)]));
    const common = this.branchManifest(snapshot.resolved.branches.sub);
    return { 'recipe.toml': stringify({ schema_version: 1, id: identity.id, name: identity.name, version: identity.version, description: identity.description,
      prompts: { ...common, ...prompts }, model: (modelsToToml({ recipe: snapshot.resolved.model }, {}) as Record<string, unknown>)['recipe'] }) };
  }
  async fork(input: RecipeForkInput): Promise<RecipeDetail> {
    this.enabled(); const old = await this.record(input.installation_id); const snapshot = await this.snapshot(old.summary.revision);
    const id = randomUUID(); const source = { locator: `installation:${id}` };
    const files = input.mode === 'copy' ? this.copyFiles(snapshot, { id: input.id, name: input.name, version: '1.0.0' })
      : { 'recipe.toml': stringify({ schema_version: 1, id: input.id, name: input.name, version: '1.0.0',
        extends: { source: old.summary.source.locator, sha256: old.summary.source.sha256, revision: old.summary.update_mode === 'pinned' ? old.summary.revision : undefined } }) };
    const next = await this.prepare(source, [], files); const summary = { ...this.summary(next, id, input.mode === 'extend' ? 'follow' : 'pinned'), copied_from: old.summary.source.locator };
    await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => ({ ...records, [id]: { summary, history: [summary.revision], editable: true } }));
    this.changed.fire(); return (await this.get(id))!;
  }
  private branchManifest(branch: ResolvedRecipe['branches']['main']): Record<string, unknown> {
    return { system: branch.system === undefined ? 'off' : { text: branch.system }, steering: branch.steering === undefined ? 'off' : { text: branch.steering },
      anchor: branch.anchor === undefined ? 'off' : { content: { text: branch.anchor.content }, steps: branch.anchor.steps, scope: branch.anchor.scope }, fields: branch.fields,
      steering_on_turn: branch.steering_on_turn, steering_on_input: branch.steering_on_input, steering_interval_steps: branch.steering_interval_steps };
  }
  async saveLocal(input: RecipeSaveLocalInput): Promise<RecipeDetail> {
    this.enabled(); const old = await this.record(input.installation_id); if (!old.editable) recipeFailure('Copy or inherit this Recipe before editing', input.installation_id);
    const next = await this.prepare(old.summary.source, [], input.files);
    await this.publish(input.installation_id, next, input.expected_revision); return (await this.get(input.installation_id))!;
  }
  async remove(input: RecipeRemoveInput): Promise<void> {
    this.enabled(); const old = await this.record(input.installation_id);
    if (input.expected_revision !== undefined && input.expected_revision !== old.summary.revision) recipeFailure('Recipe changed; reload before removing', input.installation_id);
    const used = this.usedBy(input.installation_id);
    if (used.length > 0 && input.disable_models !== true) throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Disable affected models before removing Recipe', { details: { used_by: used } });
    if (used.length > 0) {
      const before = this.config.get<ModelsSection>('models'); const after = structuredClone(before);
      for (const id of used) { if (after[id]?.recipe === input.installation_id) delete after[id]!.recipe; }
      await this.config.replaceSections({ models: after }, undefined, { models: before });
    }
    await this.documents.update<Record<string, Installation>>(this.scope, 'recipes/installations', (records) => { const next = { ...records }; delete next[input.installation_id]; return next; }); this.changed.fire();
  }
  async listMarkets(): Promise<RecipeMarket[]> {
    this.enabled(); await this.config.ready;
    const values: RecipeMarket[] = [];
    for (const input of this.config.get<RecipesConfig>(RECIPES_SECTION).markets) {
      const saved = await this.documents.get<RecipeMarket>(this.scope, `recipes/markets/${input.id}`);
      const cached = saved?.url === input.url ? saved : undefined;
      if (!input.enabled) { values.push({ ...input, catalog: cached?.catalog, offline: false }); continue; }
      const key = `${input.id}\0${input.url}`;
      const memory = this.marketCache.get(key);
      if (memory !== undefined && memory.expires > Date.now()) { values.push({ ...memory.value, ...input }); continue; }
      let value: RecipeMarket;
      try {
        const catalog = recipeCatalogSchema.parse(await this.sources.catalog(input.url));
        value = { ...input, catalog, offline: false }; await this.documents.set(this.scope, `recipes/markets/${input.id}`, value);
      } catch (error) { value = { ...input, catalog: cached?.catalog, offline: true, last_error: { code: 'recipe-market-offline', message: error instanceof Error ? error.message : String(error), source: input.url } }; }
      this.marketCache.set(key, { value, expires: Date.now() + (value.offline ? 60_000 : 15 * 60_000) });
      values.push(value);
    }
    return values;
  }
  async addMarket(input: RecipeMarketInput): Promise<RecipeMarket> { return this.writeMarket(input, false); }
  async updateMarket(input: RecipeMarketInput): Promise<RecipeMarket> { return this.writeMarket(input, true); }
  private async writeMarket(input: RecipeMarketInput, exists: boolean): Promise<RecipeMarket> {
    this.enabled(); const before = this.config.get<RecipesConfig>(RECIPES_SECTION);
    if (before.markets.some((market) => market.id === input.id) !== exists) recipeFailure(exists ? 'Recipe market not found' : 'Recipe market already exists', input.id);
    if (!/^https:\/\//u.test(input.url)) recipeFailure('Recipe market requires HTTPS', input.url);
    await this.config.replaceSections({ [RECIPES_SECTION]: { markets: [...before.markets.filter((market) => market.id !== input.id), input] } }, undefined, { [RECIPES_SECTION]: before });
    this.changed.fire(); return { ...input, offline: false };
  }
  async removeMarket(id: string): Promise<void> {
    this.enabled(); const before = this.config.get<RecipesConfig>(RECIPES_SECTION);
    await this.config.replaceSections({ [RECIPES_SECTION]: { markets: before.markets.filter((market) => market.id !== id) } }, undefined, { [RECIPES_SECTION]: before }); this.changed.fire();
  }
}
registerScopedService(LifecycleScope.App, IRecipeService, RecipeService, ScopeActivation.OnDemand, 'recipes');

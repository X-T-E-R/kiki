import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { mediaGenerateInputSchema, mediaOutcomeSchema, mediaCapabilitiesSchema, mediaVoicePageSchema, mediaCancelOutcomeSchema, mediaSourcesInputSchema, mediaCatalogSchema, type MediaJob, type MediaGenerateInput, type MediaOutcome, type MediaCapabilityQuery, type MediaVoiceQuery, type MediaSource } from '@kiki/protocol';
import { Service } from '#/_base/di/service';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IInstantiationService, ref, type LiveRef, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IContentAddressedStore } from '#/persistence/interface/contentAddressedStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IConfigService, ConfigTarget } from '#/app/config/config';
import { PLUGINS_SECTION, type PluginsSection } from '#/app/plugin/configSection';
import { parsePluginMarketplace, readPluginMarketplace } from '#/app/plugin/marketplace';
import { ScopedMediaStore } from '#/agent/media/sessionMediaStoreService';
import { IPluginMediaService, type MediaJobOwner, type MediaScopeContext, type StoredMediaJob } from './pluginMedia';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { IPluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { sourceSchema, sourceValues, sourceDefaults, scriptSources, scriptDefinition, scriptEnvironmentKey, scriptSettingsSchema } from '#/app/plugin/mediaSourceSettings';
import { mediaSourceUpdateSchema, mediaScriptSourceInputSchema, mediaSourceSettingsInputSchema, type MediaManagedSource, type MediaSourceUpdate, type MediaScriptSourceInput } from '@kiki/protocol';

const prefix = '';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeStates = new Set(['running', 'pending']);
const PLUGIN_MEDIA_INPUTS_MAX_BYTES = 256 * 1024 * 1024;
const PLUGIN_MEDIA_INPUTS_MAX_ENTRIES = 512;
const PLUGIN_MEDIA_INPUTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STAGED_INPUT_PIN_TTL_MS = 5 * 60 * 1000;

export class PluginMediaService extends Service implements IPluginMediaService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private readonly active = new Map<string, { controller: AbortController; result: Promise<MediaJob> }>();
  private readonly progress = new Map<string, NonNullable<import('#/app/plugin/pluginHostService').PluginMediaCallContext['onProgress']>>();
  private readonly pinnedInputHashes = new Map<string, number>();
  private activeDiscoveries = 0;
  private readonly scope: string;
  private readonly cache: string;
  private shuttingDown = false;
  private readonly usage?: IPluginUsageService;
  private readonly sessions?: ISessionIndex;
  private readonly sessionManager?: ISessionManager;
  private readonly blobs?: IBlobStore;

  async stageInput(key: string, name: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
    const inputHash = hash(key);
    const scope = `${this.cache}/inputs/${inputHash}`;
    const filename = path.basename(name);
    this.pinnedInputHashes.set(inputHash, Date.now() + STAGED_INPUT_PIN_TTL_MS);
    let succeeded = false;
    try {
      const pinned = await this.collectPinnedInputHashes();
      const budgetBefore = await this.sweepInputsCache(pinned, 0);
      const maxIncoming = PLUGIN_MEDIA_INPUTS_MAX_BYTES - budgetBefore.pinnedBytes;
      if (maxIncoming <= 0) {
        throw new Error('Plugin media input cache budget (256 MiB) exceeded by active pinned inputs');
      }
      let written = 0;
      const metered = (async function* (): AsyncIterable<Uint8Array> {
        for await (const chunk of source) {
          signal.throwIfAborted();
          written += chunk.byteLength;
          if (written > maxIncoming) {
            throw new Error('Plugin media input exceeds 256 MiB input cache budget');
          }
          yield chunk;
        }
      })();
      try {
        await this.storage.writeStream(scope, filename, metered, { atomic: true, signal });
      } catch (error) {
        await this.storage.delete(scope, filename).catch(() => undefined);
        throw error;
      }
      const location = this.storage.pathFor(scope, filename);
      if (location === undefined) throw new Error('Media input snapshots require the host file storage backend');
      await this.sweepInputsCache(pinned, 0);
      succeeded = true;
      return location;
    } finally {
      if (!succeeded) {
        this.pinnedInputHashes.delete(inputHash);
      } else {
        this.pinnedInputHashes.set(inputHash, Date.now() + STAGED_INPUT_PIN_TTL_MS);
      }
    }
  }

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IConfigService private readonly configService: IConfigService,
    @IInstantiationService instantiation: IInstantiationService,
    @IPluginService private readonly plugins: IPluginService,
    @IPluginSettingsService private readonly settings: IPluginSettingsService,
    @ref(IContentAddressedStore) private readonly casRef?: LiveRef<IContentAddressedStore>,
  ) {
    super();
    this.usage = optionalService(instantiation, IPluginUsageService);
    this.sessions = optionalService(instantiation, ISessionIndex);
    this.sessionManager = optionalService(instantiation, ISessionManager);
    this.blobs = optionalService(instantiation, IBlobStore);
    this.scope = `${bootstrap.scope('store')}/plugin-media-v1`;
    this.cache = `${bootstrap.scope('cache')}/plugin-media-v1`;
    this._register(instantiation.onWillDispose(() => {
      this.shuttingDown = true;
      for (const execution of this.active.values()) execution.controller.abort(new Error('Host shutdown'));
    }));
    this.ready = this.recover();
  }

  async providers() {
    return (await this.hosts.listMediaProviders()).map(({ provider, definition }) => ({ provider, definition }));
  }

  async managedSources(): Promise<MediaManagedSource[]> {
    const installed = await this.plugins.listPlugins();
    const infos = await Promise.all(installed.map((plugin) => this.plugins.getPluginInfo({ id: plugin.id })));
    const replaced = new Set(infos.filter((info) => info.enabled).flatMap((info) => (info.manifest?.kiki?.mediaSources ?? []).flatMap((group) => group.legacyPluginId === undefined ? [] : [group.legacyPluginId])));
    const result: MediaManagedSource[] = [];
    for (const info of infos.filter((item) => !replaced.has(item.id))) {
      const extension = info.manifest?.kiki;
      if (!extension?.mediaProviders?.length) continue;
      const stored = await this.settings.forExecution(info.id);
      const groups = extension.mediaSources ?? [];
      for (const group of groups) {
        const legacyInfo = infos.find((item) => item.id === group.legacyPluginId);
        const legacy = legacyInfo?.manifest === undefined ? {} : await this.settings.forExecution(legacyInfo.id);
        const schema = sourceSchema(extension, group);
        const values = sourceValues(stored, group, legacy);
        const effective = sourceDefaults(schema, values);
        const secretsConfigured = Object.keys(values).filter((key) => schema.schema.properties[key]?.secret && values[key] !== '');
        result.push({ provider: `${info.id}/${group.providerIds[0]!}`, sourceId: group.id, pluginId: info.id, label: group.label, custom: false,
          enabled: info.enabled && (stored[group.settingsPrefix + 'enabled'] as boolean | undefined ?? legacyInfo?.enabled ?? true), removed: stored[group.settingsPrefix + 'removed'] === true,
          definitions: extension.mediaProviders.filter((definition) => group.providerIds.includes(definition.id)).map((definition) => ({ ...definition, connectionSetting: definition.connectionSetting?.slice(group.settingsPrefix.length) })),
          schema, values: Object.fromEntries(Object.entries(values).filter(([key]) => !schema.schema.properties[key]?.secret)), secretsConfigured,
          missing: group.required.filter((key) => !effective[key] && !(effective['connectionId'] && ['apiKey', 'baseUrl'].includes(key))),
        });
      }
      const scriptProvider = extension.mediaProviders.find((definition) => definition.id === extension.mediaScriptProvider);
      if (scriptProvider !== undefined) for (const source of scriptSources(stored)) {
        result.push({ provider: `${info.id}/script-${source.id}`, sourceId: source.id, pluginId: info.id, label: source.label, custom: true, enabled: info.enabled && source.enabled, removed: source.removed,
          definitions: [scriptDefinition(source, scriptProvider.resumeVersion)], schema: scriptSettingsSchema,
          values: { command: source.command, args: JSON.stringify(source.args ?? []), cwd: source.cwd ?? '', protocol: source.protocol, format: source.format ?? '', mime: source.mime ?? '' },
          secretsConfigured: stored[scriptEnvironmentKey(source.id)] === undefined ? [] : ['environment'], missing: [],
        });
      }
      for (const definition of extension.mediaProviders.filter((item) => !groups.some((group) => group.providerIds.includes(item.id)) && item.id !== extension.mediaScriptProvider)) {
        const view = await this.settings.inspect(info.id);
        result.push({ provider: `${info.id}/${definition.id}`, sourceId: definition.id, pluginId: info.id, label: definition.label, custom: false, enabled: info.enabled, removed: false,
          definitions: [definition], schema: view.schema ?? { schemaVersion: 1, schema: { type: 'object', properties: {} } }, values: { ...view.values }, secretsConfigured: [...view.secretsConfigured], missing: [] });
      }
    }
    return result;
  }

  async sourceSettings(raw: { provider: string }): Promise<MediaManagedSource> {
    const input = mediaSourceSettingsInputSchema.parse(raw);
    const sources = await this.managedSources();
    const source = sources.find((item) => item.provider === input.provider || item.definitions.some((definition) => `${item.pluginId}/${definition.id}` === input.provider));
    if (source === undefined) throw new Error('Media source not found');
    return source;
  }

  async updateSource(raw: MediaSourceUpdate): Promise<MediaManagedSource> {
    const input = mediaSourceUpdateSchema.parse(raw);
    const source = await this.sourceSettings({ provider: input.provider });
    const info = await this.plugins.getPluginInfo({ id: source.pluginId });
    const extension = info.manifest!.kiki!;
    const stored = await this.settings.forExecution(info.id);
    const group = extension.mediaSources?.find((item) => item.id === source.sourceId);
    const values: Record<string, string | number | boolean | null> = {};
    if (group !== undefined) {
      const cleared = new Set<string>(JSON.parse(String(stored[group.settingsPrefix + 'cleared'] ?? '[]')));
      for (const [key, value] of Object.entries(input.values ?? {})) {
        if (source.schema.schema.properties[key] === undefined) throw new Error(`Unknown media source setting ${key}`);
        values[group.settingsPrefix + key] = value;
        if (value === null) cleared.add(key); else cleared.delete(key);
      }
      values[group.settingsPrefix + 'cleared'] = JSON.stringify([...cleared]);
      if (input.enabled !== undefined) values[group.settingsPrefix + 'enabled'] = input.enabled;
      if (input.removed !== undefined) values[group.settingsPrefix + 'removed'] = input.removed;
    } else if (source.custom) {
      const scripts = scriptSources(stored);
      for (const key of Object.keys(input.values ?? {})) if (key !== 'environment') throw new Error(`Unknown script setting ${key}`);
      const environment = input.values?.['environment'];
      if (environment !== undefined) {
        if (environment !== null && typeof environment !== 'string') throw new Error('Script environment must be a JSON object');
        if (environment !== null) mediaScriptSourceInputSchema.shape.environment.parse(JSON.parse(environment));
        values[scriptEnvironmentKey(source.sourceId)] = environment;
      }
      values['scriptSources'] = JSON.stringify(scripts.map((item) => item.id !== source.sourceId ? item : { ...item, enabled: input.enabled ?? item.enabled, removed: input.removed ?? item.removed }));
    } else {
      if (input.removed !== undefined) throw new Error('Remove third-party packages from their plugin detail');
      if (input.enabled !== undefined) await this.plugins.setPluginEnabled({ id: info.id, enabled: input.enabled });
      Object.assign(values, input.values);
    }
    if (Object.keys(values).length) await this.settings.update({ pluginId: info.id, values });
    return this.sourceSettings({ provider: source.provider });
  }

  async addScriptSource(raw: MediaScriptSourceInput): Promise<MediaManagedSource> {
    const { environment, ...source } = mediaScriptSourceInputSchema.parse(raw);
    const info = await this.plugins.getPluginInfo({ id: 'kiki-media' });
    if (info.manifest?.kiki?.mediaScriptProvider === undefined) throw new Error('Install the unified media plugin to add a script source');
    const settings = await this.settings.forExecution(info.id);
    const scripts = scriptSources(settings);
    if (scripts.some((item) => item.id === source.id)) throw new Error('Script source id already exists; restore a removed source rather than replacing its saved handles');
    await this.settings.update({ pluginId: info.id, values: { scriptSources: JSON.stringify([...scripts, { ...source, enabled: true, removed: false }]) } });
    if (environment !== undefined) await this.settings.update({ pluginId: info.id, values: { [scriptEnvironmentKey(source.id)]: JSON.stringify(environment) } });
    return this.sourceSettings({ provider: `${info.id}/script-${source.id}` });
  }

  async sources(): Promise<MediaSource[]> {
    await this.configService.ready;
    return this.configService.get<PluginsSection>(PLUGINS_SECTION).marketplaceSources ?? [];
  }

  async setSources(input: { sources: MediaSource[] }): Promise<MediaSource[]> {
    const parsed = mediaSourcesInputSchema.parse(input);
    await this.configService.set(PLUGINS_SECTION, { marketplaceSources: parsed.sources }, ConfigTarget.User);
    return this.sources();
  }

  async catalog(input: { id: string }) {
    const source = (await this.sources()).find((item) => item.id === input.id);
    if (source === undefined || !source.enabled) throw new Error('Marketplace source is missing or disabled');
    const { raw, location } = await readPluginMarketplace({ source: source.url, workDir: this.bootstrap.cwd });
    return mediaCatalogSchema.parse(parsePluginMarketplace(raw, location));
  }

  async capabilities(query: MediaCapabilityQuery, scope?: MediaScopeContext) {
    if (query.provider === undefined) {
      const candidates = (await this.providers()).filter((item) => query.kind === undefined || item.definition.kinds.includes(query.kind));
      const providers = await this.filterScopedProviders(candidates, scope);
      return { providers: [...providers] };
    }
    return mediaCapabilitiesSchema.parse(await this.discover(query.provider, 'describe', query, scope));
  }

  async voices(query: MediaVoiceQuery, scope?: MediaScopeContext) {
    return mediaVoicePageSchema.parse(await this.discover(query.provider, 'voices', query, scope));
  }

  private async discover(provider: string, action: 'describe' | 'voices', query: unknown, scope?: MediaScopeContext) {
    await this.assertProviderAllowed(provider, scope);
    this.activeDiscoveries += 1;
    try {
      const stagingDir = await this.staging('discovery');
      return await this.hosts.requestMediaProvider(provider, action, query, AbortSignal.timeout(60_000), { jobId: 'discovery', stagingDir });
    } finally {
      this.activeDiscoveries = Math.max(0, this.activeDiscoveries - 1);
      if (this.activeDiscoveries === 0) {
        await this.removeStagingDirectory('discovery');
      }
    }
  }

  private async filterScopedProviders<T extends { readonly provider: string }>(
    providers: readonly T[],
    scope?: MediaScopeContext,
  ): Promise<readonly T[]> {
    if (scope === undefined || this.usage?.enabled() !== true) return providers;
    const allowed: T[] = [];
    for (const provider of providers) {
      if (await this.providerAllowed(provider.provider, scope)) allowed.push(provider);
    }
    return allowed;
  }

  private async assertProviderAllowed(provider: string, scope?: MediaScopeContext): Promise<void> {
    if (scope !== undefined && !(await this.providerAllowed(provider, scope))) {
      throw new Error(`Media provider ${provider} is disabled in this session.`);
    }
  }

  private async providerAllowed(provider: string, scope: MediaScopeContext): Promise<boolean> {
    if (this.usage?.enabled() !== true) return true;
    const pluginId = provider.split('/', 1)[0];
    if (pluginId === undefined || pluginId.length === 0) return false;
    return this.usage.allows(scope.workspaceId, pluginId, scope.sessionId);
  }

  private async scopeForOwner(owner: MediaJobOwner): Promise<MediaScopeContext | undefined> {
    if (this.usage?.enabled() !== true) return undefined;
    const session = await this.sessions?.get(owner.sessionId);
    if (session === undefined) throw new Error(`Session ${owner.sessionId} is not available for media admission.`);
    return { workspaceId: session.workspaceId, sessionId: owner.sessionId };
  }

  async jobs(input: { session_id?: string; limit?: number; offset?: number } = {}): Promise<MediaJob[]> {
    await this.ready;
    const records = await this.readAll();
    return records.filter((item) => input.session_id === undefined || item.owner.sessionId === input.session_id)
      .map((item) => item.view).sort((a, b) => b.created_at - a.created_at)
      .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 50));
  }

  async job(id: string): Promise<MediaJob> { return (await this.stored(id)).view; }

  async stored(id: string): Promise<StoredMediaJob> {
    await this.ready;
    if (!/^media-[a-f0-9]{32}$/.test(id)) throw new Error('Invalid media job id');
    const record = await this.documents.get<StoredMediaJob>(this.scope, `${prefix}${id}.json`);
    if (record === undefined) throw new Error('Media job not found');
    return record;
  }

  async start(raw: MediaGenerateInput, owner: MediaJobOwner): Promise<MediaJob> {
    await this.ready;
    const input = mediaGenerateInputSchema.parse(raw);
    if (input.request_id === undefined) throw new Error('Media generation requires a stable request id');
    const id = `media-${hash([owner.sessionId, owner.agentId, input.request_id]).slice(0, 32)}`;
    const fingerprint = hash(input);
    const existing = await this.documents.get<StoredMediaJob>(this.scope, `${prefix}${id}.json`);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('request_id already belongs to a different media request');
      return existing.view;
    }
    const providers = await this.hosts.listMediaProviders();
    const scope = await this.scopeForOwner(owner);
    const candidates = providers.filter((item) => item.definition.kinds.includes(input.request.kind) &&
      (input.provider === undefined || input.provider === item.provider || item.aliases?.includes(input.provider)));
    const matching = await this.filterScopedProviders(candidates, scope);
    if (matching.length !== 1) throw new Error(`Choose one configured media provider for ${input.request.kind}: ${matching.map((item) => item.provider).join(', ') || 'install/enable a media provider in Plugins'}`);
    const provider = matching[0]!;
    const now = Date.now();
    const created: StoredMediaJob = { owner, input, fingerprint, provider, view: {
      schemaVersion: 1, job_id: id, request_id: input.request_id, owner_session_id: owner.sessionId, owner_agent_id: owner.agentId,
      provider: provider.provider, model: input.model, state: 'running', phase: 'submit', can_resume: false,
      artifacts: [], created_at: now, updated_at: now,
    } };
    const result = await this.documents.update<StoredMediaJob>(this.scope, `${prefix}${id}.json`, (current) => {
      if (current !== undefined && current.fingerprint !== fingerprint) throw new Error('request_id already belongs to a different media request');
      return current ?? created;
    });
    return result!.view;
  }

  async bindTask(id: string, taskId: string) {
    await this.stored(id);
    const record = await this.documents.update<StoredMediaJob>(this.scope, `${prefix}${id}.json`, (current) => {
      if (current === undefined) throw new Error('Media job not found');
      return { ...current, view: { ...current.view, task_id: taskId, updated_at: Date.now() } };
    });
    return record!.view;
  }

  async resume(id: string): Promise<MediaJob> {
    const record = await this.stored(id);
    if (!record.view.can_resume) throw new Error('This job has no resumable handle or staged output. Resume never submits or buys a new generation.');
    const active = this.active.get(id);
    if (active !== undefined && !active.controller.signal.aborted) return record.view;
    if (active !== undefined) await active.result;
    const latest = await this.stored(id);
    await this.save({ ...latest, outcome: latest.handle !== undefined && latest.view.error?.code === 'delivery_failed' ? undefined : latest.outcome,
      view: { ...latest.view, state: 'pending', blocked_reason: undefined, error: undefined, cancellation: undefined } }, true);
    void this.run(id).catch(() => {});
    return this.job(id);
  }

  run(id: string, onProgress?: NonNullable<import('#/app/plugin/pluginHostService').PluginMediaCallContext['onProgress']>): Promise<MediaJob> {
    if (onProgress !== undefined) this.progress.set(id, onProgress);
    const current = this.active.get(id);
    if (current !== undefined) return current.result;
    const controller = new AbortController();
    const result = this.execute(id, controller.signal).finally(async () => {
      if (this.active.get(id)?.controller === controller) { this.active.delete(id); this.progress.delete(id); }
      await this.maybeCleanupJobStaging(id).catch(() => undefined);
    });
    this.active.set(id, { controller, result });
    void result.catch(() => {});
    return result;
  }

  async stopLocal(id: string): Promise<MediaJob> {
    this.active.get(id)?.controller.abort(new Error('Media reception stopped locally'));
    const record = await this.stored(id);
    if (!activeStates.has(record.view.state)) return record.view;
    return (await this.save({ ...record, view: { ...record.view, state: 'stopped', can_resume: record.handle !== undefined || record.outcome !== undefined,
      cancellation: { remote: 'unsupported', billing: 'unknown', message: 'Local waiting/reception stopped; remote generation may continue and incur charges.' } } })).view;
  }

  async cancel(id: string): Promise<MediaJob> {
    const before = await this.stored(id);
    if (!activeStates.has(before.view.state) && !before.view.can_resume) return before.view;
    await this.stopLocal(id);
    let cancellation: MediaJob['cancellation'] = { remote: 'unsupported', billing: 'unknown', message: 'Local waiting/reception stopped; remote generation may continue and incur charges.' };
    if (before.handle !== undefined) {
      try {
        cancellation = mediaCancelOutcomeSchema.parse(await this.hosts.requestMediaProvider(before.view.provider, 'cancel', before.handle, AbortSignal.timeout(30_000), { jobId: id, stagingDir: await this.staging(id) }, before.provider));
      } catch (error) {
        onUnexpectedError(error);
        cancellation = {
          remote: 'unsupported',
          billing: 'unknown',
          message: `Local waiting/reception stopped; remote cancellation failed (${toErrorMessage(error)}); remote generation may continue and incur charges.`,
        };
      }
    }
    const record = await this.stored(id);
    const saved = (await this.save({ ...record, view: { ...record.view, cancellation, can_resume: cancellation.remote !== 'cancelled' && record.view.can_resume } })).view;
    await this.maybeCleanupJobStaging(id).catch(() => undefined);
    return saved;
  }

  private async execute(id: string, signal: AbortSignal): Promise<MediaJob> {
    let record = await this.stored(id);
    if (!activeStates.has(record.view.state)) return record.view;
    try {
      const stagingDir = await this.staging(id);
      let outcome = record.outcome;
      for (;;) {
        signal.throwIfAborted();
        if (outcome === undefined) {
          const action = record.handle === undefined ? 'submit' : 'poll';
          const input = record.handle ?? { request: record.input.request, model: record.input.model };
          try {
            outcome = mediaOutcomeSchema.parse(await this.hosts.requestMediaProvider(record.view.provider, action, input, signal, { jobId: id, stagingDir, owner: record.owner, model: record.input.model, onProgress: (update) => this.progress.get(id)?.(update) }, record.provider));
          } catch (error) {
            signal.throwIfAborted();
            if (record.handle === undefined) throw error;
            const available = (await this.hosts.listMediaProviders()).find((item) => item.provider === record.view.provider);
            if (available === undefined || available.source !== record.provider.source || available.configuration !== record.provider.configuration || available.definition.resumeVersion !== record.provider.definition.resumeVersion) {
              record = await this.save({ ...record, view: { ...record.view, state: 'pending', blocked_reason: 'needs_provider', can_resume: true,
                error: { code: 'needs_provider', message: 'Enable the original compatible provider, endpoint and credential to resume.', submission: 'accepted' } } });
              return record.view;
            }
            record = await this.save({ ...record, view: { ...record.view, state: 'pending', can_resume: true,
              error: { code: 'poll_error', message: String(error), submission: 'accepted' } } });
            await delay(3000, undefined, { signal });
            continue;
          }
          if (outcome.state === 'pending' && outcome.handle.version !== record.provider.definition.resumeVersion) throw new Error('Provider returned an incompatible resume handle');
          record = await this.save({ ...record, outcome, handle: outcome.state === 'pending' ? outcome.handle : record.handle,
            view: { ...record.view, state: outcome.state === 'pending' ? 'pending' : 'running', phase: outcome.state === 'pending' ? outcome.phase : 'download',
              can_resume: outcome.state === 'pending' || (outcome.artifacts?.length ?? 0) > 0, effective: outcome.effective, usage: outcome.usage, warnings: outcome.warnings } });
        }
        record = await this.materialize(record, outcome, signal);
        signal.throwIfAborted();
        if (outcome.state === 'pending' || (outcome.state === 'failed' && outcome.error.retryAfterMs !== undefined && record.handle !== undefined)) {
          await delay(Math.max(100, Math.min(60_000, outcome.state === 'pending' ? outcome.retryAfterMs ?? 3000 : outcome.error.retryAfterMs ?? 3000)), undefined, { signal });
          record = await this.save({ ...record, outcome: undefined });
          outcome = undefined;
          continue;
        }
        const providerError = outcome.state === 'failed' ? outcome.error : undefined;
        const incomplete = record.view.artifacts.some((item) => !item.complete);
        const any = record.view.artifacts.length > 0;
        const state: MediaJob['state'] = providerError?.submission === 'unknown' ? 'unknown' : providerError !== undefined || incomplete || !any ? any ? 'partial' : 'failed' : 'succeeded';
        record = await this.save({ ...record, outcome: undefined, view: { ...record.view, state, can_resume: false,
          error: providerError ?? (!any ? { code: 'empty_output', message: 'Provider returned no artifacts', submission: 'accepted' } : undefined) } });
        return record.view;
      }
    } catch (error) {
      const latest = await this.stored(id);
      if (signal.aborted) {
        if (latest.view.state === 'stopped') return latest.view;
        if (this.shuttingDown) {
          const resumable = latest.handle !== undefined || latest.outcome !== undefined;
          return (await this.save({ ...latest, view: { ...latest.view, state: resumable ? 'pending' : 'unknown', can_resume: resumable } })).view;
        }
        return (await this.save({ ...latest, view: { ...latest.view, state: 'stopped', can_resume: latest.handle !== undefined || latest.outcome !== undefined,
          cancellation: { remote: 'unsupported', billing: 'unknown', message: 'Local reception stopped; remote generation may continue and incur charges.' } } })).view;
      }
      const resumable = latest.handle !== undefined || latest.outcome !== undefined;
      return (await this.save({ ...latest, view: { ...latest.view, state: resumable ? latest.view.artifacts.length ? 'partial' : 'pending' : 'unknown', phase: resumable ? 'download' : 'submit', can_resume: resumable,
        error: { code: resumable ? 'delivery_failed' : 'submission_unknown', message: String(error), submission: resumable ? 'accepted' : 'unknown' } } })).view;
    }
  }

  private async isOwnerConfirmedPublic(owner: MediaJobOwner): Promise<boolean> {
    const live = this.sessionManager?.get(owner.sessionId);
    if (live !== undefined) {
      try {
        const ctx = live.accessor.get(ISessionContext);
        return ctx.ephemeral === false && typeof ctx.isPrivate === 'function' && ctx.isPrivate() === false;
      } catch {
        return false;
      }
    }
    const mediaSuffix = '/media';
    if (!owner.mediaScope.endsWith(mediaSuffix)) return false;
    const sessionScope = owner.mediaScope.slice(0, -mediaSuffix.length);
    const state = await this.documents.get<{ readonly id?: unknown; readonly private?: unknown }>(sessionScope, 'state.json').catch(() => undefined);
    return state !== undefined && state.id === owner.sessionId && state.private === false;
  }

  private async materialize(record: StoredMediaJob, outcome: MediaOutcome, signal: AbortSignal): Promise<StoredMediaJob> {
    const allowSharedCas = await this.isOwnerConfirmedPublic(record.owner);
    const media = new ScopedMediaStore(
      record.owner.mediaScope,
      this.storage,
      this.documents,
      this.blobs,
      undefined,
      this.casRef?.current,
      allowSharedCas,
    );
    const stagingScope = `${this.cache}/${record.view.job_id}`;
    const base = await this.staging(record.view.job_id);
    for (const draft of outcome.artifacts ?? []) {
      const artifactId = hash([draft.name, draft.role, draft.kind]).slice(0, 16);
      if (record.view.artifacts.some((item) => item.id === artifactId && item.complete)) continue;
      const key = path.relative(base, path.resolve(draft.path));
      if (!key || key.startsWith('..') || path.isAbsolute(key)) throw new Error('Artifact must be a file in the job staging directory');
      const size = await this.storage.size(stagingScope, key);
      if (size === undefined || size === 0) throw new Error('Staged artifact is missing or empty');
      const fileId = `f_${record.view.job_id}_${artifactId}`;
      await media.materialize({ fileId, name: draft.name, mimeType: draft.mime, size, signal,
        stream: () => Readable.from(this.storage.readStream(stagingScope, key)) });
      const { path: _path, ...details } = draft;
      const artifact = { ...details, id: artifactId, file_id: fileId, bytes: size };
      const artifacts = record.view.artifacts.filter((item) => item.id !== artifactId);
      artifacts.push(artifact);
      record = await this.save({ ...record, view: { ...record.view, artifacts } });
    }
    return record;
  }

  private async save(record: StoredMediaJob, resume = false): Promise<StoredMediaJob> {
    const next = await this.documents.update<StoredMediaJob>(this.scope, `${prefix}${record.view.job_id}.json`, (current) => {
      const stopped = !resume && current?.view.state === 'stopped' && record.view.state !== 'stopped';
      return { ...record, view: { ...record.view,
        ...(stopped ? { state: current.view.state, cancellation: current.view.cancellation,
          can_resume: current.view.cancellation?.remote !== 'cancelled' && (record.handle !== undefined || record.outcome !== undefined) } : {}),
        task_id: current?.view.task_id ?? record.view.task_id, updated_at: Date.now(),
      } };
    });
    return next!;
  }

  private async staging(id: string): Promise<string> {
    const scope = `${this.cache}/${id}`;
    await this.storage.write(scope, '.ready', new Uint8Array(), { atomic: true });
    const location = this.storage.pathFor(scope, '.ready');
    if (location === undefined) throw new Error('Media provider staging requires the host file storage backend');
    return path.dirname(location);
  }

  private async maybeCleanupJobStaging(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const record = await this.documents.get<StoredMediaJob>(this.scope, `${prefix}${id}.json`).catch(() => undefined);
    if (record === undefined) return;
    if (record.view.can_resume || activeStates.has(record.view.state)) return;
    if (record.view.state === 'partial' || record.view.state === 'unknown') return;
    if (record.view.state === 'succeeded') {
      const allMaterialized =
        record.view.artifacts.length > 0 &&
        record.view.artifacts.every((artifact) => artifact.complete && typeof artifact.file_id === 'string' && artifact.file_id.length > 0);
      if (!allMaterialized) return;
    } else if (record.view.artifacts.some((artifact) => !artifact.complete || typeof artifact.file_id !== 'string' || artifact.file_id.length === 0)) {
      return;
    }
    await this.removeStagingDirectory(id);
  }

  private async removeStagingDirectory(id: string): Promise<void> {
    const scope = `${this.cache}/${id}`;
    const readyPath = this.storage.pathFor(scope, '.ready');
    if (readyPath !== undefined) {
      await rm(path.dirname(readyPath), { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    const entries = await this.storage.list(scope).catch(() => []);
    for (const entry of entries) {
      await this.storage.delete(scope, entry).catch(() => undefined);
    }
  }

  private async collectPinnedInputHashes(): Promise<Set<string>> {
    const now = Date.now();
    const pinned = new Set<string>();
    for (const [inputHash, expiresAt] of this.pinnedInputHashes.entries()) {
      if (expiresAt > now) pinned.add(inputHash);
      else this.pinnedInputHashes.delete(inputHash);
    }
    const records = await this.readAll().catch(() => []);
    const inputsBase = this.storage.pathFor(`${this.cache}/inputs`, '');
    for (const record of records) {
      if (!activeStates.has(record.view.state) && !record.view.can_resume && !this.active.has(record.view.job_id)) {
        continue;
      }
      const serialized = JSON.stringify(record.input);
      if (inputsBase !== undefined) {
        const matches = serialized.matchAll(/[a-f0-9]{64}/g);
        for (const match of matches) pinned.add(match[0]);
      }
    }
    return pinned;
  }

  private async sweepInputsCache(
    pinned: ReadonlySet<string>,
    reserveBytes: number,
  ): Promise<{ readonly totalBytes: number; readonly pinnedBytes: number }> {
    const inputsDir = this.storage.pathFor(`${this.cache}/inputs`, '');
    if (inputsDir === undefined) return { totalBytes: 0, pinnedBytes: 0 };
    let entries;
    try {
      entries = await readdir(inputsDir, { withFileTypes: true });
    } catch {
      return { totalBytes: 0, pinnedBytes: 0 };
    }
    const now = Date.now();
    const candidates: Array<{
      readonly name: string;
      readonly fullPath: string;
      readonly bytes: number;
      readonly mtimeMs: number;
      readonly pinned: boolean;
      readonly expired: boolean;
    }> = [];
    let totalBytes = 0;
    let pinnedBytes = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(inputsDir, entry.name);
      const measured = await measureEntryTree(fullPath);
      const isPinned = pinned.has(entry.name);
      const expired = !isPinned && now - measured.mtimeMs > PLUGIN_MEDIA_INPUTS_MAX_AGE_MS;
      totalBytes += measured.bytes;
      if (isPinned) pinnedBytes += measured.bytes;
      candidates.push({
        name: entry.name,
        fullPath,
        bytes: measured.bytes,
        mtimeMs: measured.mtimeMs,
        pinned: isPinned,
        expired,
      });
    }
    let remainingCount = candidates.length;
    for (const item of candidates) {
      if (!item.expired) continue;
      await rm(item.fullPath, { recursive: true, force: true }).catch(() => undefined);
      totalBytes = Math.max(0, totalBytes - item.bytes);
      remainingCount = Math.max(0, remainingCount - 1);
    }
    const targetBytes = Math.max(0, PLUGIN_MEDIA_INPUTS_MAX_BYTES - reserveBytes);
    if (totalBytes <= targetBytes && remainingCount <= PLUGIN_MEDIA_INPUTS_MAX_ENTRIES) {
      return { totalBytes, pinnedBytes };
    }
    const evictable = candidates
      .filter((item) => !item.pinned && !item.expired)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of evictable) {
      if (totalBytes <= targetBytes && remainingCount <= PLUGIN_MEDIA_INPUTS_MAX_ENTRIES) break;
      await rm(item.fullPath, { recursive: true, force: true }).catch(() => undefined);
      totalBytes = Math.max(0, totalBytes - item.bytes);
      remainingCount = Math.max(0, remainingCount - 1);
    }
    return { totalBytes, pinnedBytes };
  }

  private async readAll(): Promise<StoredMediaJob[]> {
    const records: StoredMediaJob[] = [];
    for (const key of await this.documents.list(this.scope, prefix)) {
      const record = await this.documents.get<StoredMediaJob>(this.scope, key);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  private async recover(): Promise<void> {
    for (const record of await this.readAll()) {
      if (!activeStates.has(record.view.state)) continue;
      if (record.handle === undefined && record.outcome === undefined) {
        await this.save({ ...record, view: { ...record.view, state: 'unknown', can_resume: false,
          error: { code: 'submission_unknown', message: 'Host restarted during submission without a remote handle. Do not automatically resubmit.', submission: 'unknown' } } });
      } else { void this.run(record.view.job_id).catch(() => {}); }
    }
  }

  override dispose(): void | Promise<void> {
    this.shuttingDown = true;
    for (const execution of this.active.values()) execution.controller.abort(new Error('Host shutdown'));
    return super.dispose();
  }
}

async function measureEntryTree(targetPath: string): Promise<{ readonly bytes: number; readonly mtimeMs: number }> {
  let info;
  try {
    info = await stat(targetPath);
  } catch {
    return { bytes: 0, mtimeMs: 0 };
  }
  if (!info.isDirectory()) return { bytes: info.size, mtimeMs: info.mtimeMs };
  let bytes = 0;
  let mtimeMs = info.mtimeMs;
  const children = await readdir(targetPath, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (child.isSymbolicLink()) continue;
    const measured = await measureEntryTree(path.join(targetPath, child.name));
    bytes += measured.bytes;
    if (measured.mtimeMs > mtimeMs) mtimeMs = measured.mtimeMs;
  }
  return { bytes, mtimeMs };
}

function optionalService<T>(instantiation: IInstantiationService, id: ServiceIdentifier<T>): T | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(id));
  } catch {
    return undefined;
  }
}

registerScopedService(LifecycleScope.App, IPluginMediaService, PluginMediaService, ScopeActivation.OnDemand, 'pluginMedia');

import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { mediaGenerateInputSchema, mediaOutcomeSchema, mediaCapabilitiesSchema, mediaVoicePageSchema, mediaCancelOutcomeSchema, mediaSourcesInputSchema, mediaCatalogSchema, type MediaJob, type MediaGenerateInput, type MediaOutcome, type MediaCapabilityQuery, type MediaVoiceQuery, type MediaSource } from '@kiki/protocol';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IConfigService, ConfigTarget } from '#/app/config/config';
import { PLUGINS_SECTION, type PluginsSection } from '#/app/plugin/configSection';
import { parsePluginMarketplace, readPluginMarketplace } from '#/app/plugin/marketplace';
import { ScopedMediaStore } from '#/agent/media/sessionMediaStoreService';
import { IPluginMediaService, type MediaJobOwner, type StoredMediaJob } from './pluginMedia';

const prefix = '';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeStates = new Set(['running', 'pending']);

export class PluginMediaService extends Service implements IPluginMediaService {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  private readonly active = new Map<string, { controller: AbortController; result: Promise<MediaJob> }>();
  private readonly progress = new Map<string, NonNullable<import('#/app/plugin/pluginHostService').PluginMediaCallContext['onProgress']>>();
  private readonly scope: string;
  private readonly cache: string;
  private shuttingDown = false;

  async stageInput(key: string, name: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
    const scope = `${this.cache}/inputs/${hash(key)}`;
    const filename = path.basename(name);
    await this.storage.writeStream(scope, filename, source, { atomic: true, signal });
    const location = this.storage.pathFor(scope, filename);
    if (location === undefined) throw new Error('Media input snapshots require the host file storage backend');
    return location;
  }

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IConfigService private readonly configService: IConfigService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
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

  async capabilities(query: MediaCapabilityQuery) {
    if (query.provider === undefined) {
      const providers = (await this.providers()).filter((item) => query.kind === undefined || item.definition.kinds.includes(query.kind));
      return { providers };
    }
    return mediaCapabilitiesSchema.parse(await this.discover(query.provider, 'describe', query));
  }

  async voices(query: MediaVoiceQuery) {
    return mediaVoicePageSchema.parse(await this.discover(query.provider, 'voices', query));
  }

  private async discover(provider: string, action: 'describe' | 'voices', query: unknown) {
    const stagingDir = await this.staging('discovery');
    return this.hosts.requestMediaProvider(provider, action, query, AbortSignal.timeout(60_000), { jobId: 'discovery', stagingDir });
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
    const matching = providers.filter((item) => item.definition.kinds.includes(input.request.kind) && (input.provider === undefined || input.provider === item.provider));
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
    const result = this.execute(id, controller.signal).finally(() => {
      if (this.active.get(id)?.controller === controller) { this.active.delete(id); this.progress.delete(id); }
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
      } catch { }
    }
    const record = await this.stored(id);
    return (await this.save({ ...record, view: { ...record.view, cancellation, can_resume: cancellation.remote !== 'cancelled' && record.view.can_resume } })).view;
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

  private async materialize(record: StoredMediaJob, outcome: MediaOutcome, signal: AbortSignal): Promise<StoredMediaJob> {
    const media = new ScopedMediaStore(record.owner.mediaScope, this.storage, this.documents);
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

  override dispose(): void {
    this.shuttingDown = true;
    for (const execution of this.active.values()) execution.controller.abort(new Error('Host shutdown'));
    super.dispose();
  }
}

registerScopedService(LifecycleScope.App, IPluginMediaService, PluginMediaService, ScopeActivation.OnDemand, 'pluginMedia');

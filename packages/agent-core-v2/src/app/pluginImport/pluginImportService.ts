import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { IInstantiationService } from '#/_base/di/instantiation';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { nativeMessage, nativeImportLosses, nativeRecordLosses } from './nativeSession';
import {
  importSelectionSchema, importPreviewInputSchema, importDiscoveryInputSchema, importDiscoveryPageSchema, importProbeSchema,
  importParsePageSchema, importPreviewSchema, importStartInputSchema, importJobSchema,
  importArchiveSchema, importStoredPageSchema, importArchiveQuerySchema, importReadInputSchema, importListInputSchema,
  type ImportSource, type ImportSelection, type ImportPreviewInput, type ImportDestination, type ImportPreview, type ImportJob, type ImportArchive,
  type ImportDiscoveryInput, type ImportDiscoveryPage, type ImportListInput, type ImportArchiveQuery,
  type ImportReadInput, type ImportReadPage, type ImportStartInput, type ImportLoss,
} from '@kiki/protocol';
import { Service } from '#/_base/di/service';
import { toDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { LifecycleScope } from '#/app/scopes';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { Error2, PluginErrors } from '#/errors';
import { IPluginImportService } from './pluginImport';
import { builtinHistory } from './builtinHistory';

const NAMESPACE = 'plugin-import-v1';
const PAGE_BYTES = 512 * 1024;
const MAX_ACTIVE = 2;
const digest = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
function fail(message: string): never { throw new Error2(PluginErrors.codes.PLUGIN_LOAD_FAILED, message); }
const validId = (id: string) => /^[a-f0-9]{64}$|^[a-f0-9-]{36}$/.test(id) ? id : fail('Invalid import identity');
function mergeLosses(first: ImportLoss[], second: ImportLoss[]): ImportLoss[] {
  const map = new Map(first.map((item) => [item.code + '\0' + item.detail, { ...item }]));
  for (const item of second) {
    const key = item.code + '\0' + item.detail;
    const old = map.get(key);
    if (old) old.count += item.count; else map.set(key, { ...item });
  }
  const values = [...map.values()];
  if (values.length <= 100) return values;
  return [...values.slice(0, 99), { code: 'additional_losses', count: values.slice(99).reduce((sum, item) => sum + item.count, 0), detail: 'Additional loss categories were summarized' }];
}
const READ_BYTES = 60 * 1024;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function textEnd(text: string, start: number, bytes: number): number {
  let low = start; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(start, middle)) <= bytes) low = middle; else high = middle - 1;
  }
  if (low > start && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low -= 1;
  return low;
}

export class PluginImportService extends Service implements IPluginImportService {
  declare readonly _serviceBrand: undefined;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private initialization?: Promise<void>;
  private commits: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private closing = false;
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.then(() => {}, () => {});
    return next;
  }
  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IPluginHostService private readonly hosts: IPluginHostService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this._register(this.plugins.onWillChange((event) => {
      const affected = event.affected;
      const work = [...this.active.entries()].filter(([id]) => affected === undefined || affected.includes(this.owners.get(id) ?? '')).map(([, item]) => item);
      for (const item of work) item.controller.abort(new Error('Plugin unloaded; import interrupted'));
      event.waitUntil(Promise.all(work.map((item) => item.promise)));
    }));
    this._register(toDisposable(() => {
      this.closing = true;
      for (const item of this.active.values()) item.controller.abort(new Error('Host stopped; import interrupted'));
    }));
  }
  private readonly owners = new Map<string, string>();
  private key(kind: string, id: string) { return `${kind}.${validId(id)}`; }
  private check() {
    if (this.closing) fail('Import host is closing');
  }
  private ready(): Promise<void> {
    this.check();
    this.initialization ??= (async () => {
      for (const key of await this.docs.list(NAMESPACE, 'jobs.')) {
        const raw = await this.docs.get(NAMESPACE, key);
        const job = importJobSchema.parse(raw);
        if (job.status === 'queued' || job.status === 'running') {
          const completed = await this.committedJob(job, true);
          await this.saveJob(completed ?? { ...job, status: 'interrupted', error: 'Host restarted; resume explicitly' });
        }
      }
    })();
    return this.initialization;
  }
  private async source(input: { pluginId: string; sourceId: string }) {
    if (input.pluginId === builtinHistory.id) {
      const definition = builtinHistory.sessionSources.find((item) => item.id === input.sourceId);
      if (!definition) fail('Unknown built-in history source');
      return definition;
    }
    const info = await this.plugins.getPluginInfo({ id: input.pluginId });
    const definition = info.manifest?.kiki?.sessionSources?.find((item) => item.id === input.sourceId);
    if (!info.enabled || info.state !== 'ok' || !definition) fail('Session source is not enabled');
    return definition;
  }
  async sources(): Promise<ImportSource[]> {
    this.check();
    const plugins = (await this.plugins.listPlugins()).filter((item) => item.id !== builtinHistory.id && item.enabled && item.state === 'ok');
    const info = await Promise.all(plugins.map((item) => this.plugins.getPluginInfo({ id: item.id })));
    return [...builtinHistory.sessionSources.map((definition) => ({ ...definition, pluginId: builtinHistory.id })),
      ...info.flatMap((item) => (item.manifest?.kiki?.sessionSources ?? []).map((definition) => ({ ...definition, pluginId: item.id })))];
  }
  async discover(input: ImportDiscoveryInput): Promise<ImportDiscoveryPage> {
    this.check();
    const selection = importDiscoveryInputSchema.parse(input);
    await this.source(selection);
    return importDiscoveryPageSchema.parse(await this.hosts.requestSource(selection.pluginId, selection.sourceId, 'discover', selection, AbortSignal.timeout(30_000)));
  }
  private async probe(selection: ImportSelection, signal: AbortSignal, destination?: ImportDestination) {
    const definition = await this.source(selection);
    const probe = importProbeSchema.parse(await this.hosts.requestSource(selection.pluginId, selection.sourceId, 'probe', { ...selection, mode: this.mode(destination) }, signal));
    if (definition.formatVersion !== probe.formatVersion) fail('Source format version mismatch');
    return probe;
  }
  private mode(destination?: ImportDestination) { return destination?.kind === 'native-session' ? 'native-session' : undefined; }
  private identity(selection: ImportSelection, sourceHome: string) { return digest([selection.pluginId, selection.sourceId, sourceHome, selection.externalId]); }
  private nativeIdentity(job: Pick<ImportJob, 'selection' | 'sourceHome' | 'revision' | 'destination'>) {
    return digest([this.identity(job.selection, job.sourceHome), job.revision, job.destination]);
  }
  async preview(input: ImportPreviewInput): Promise<ImportPreview> {
    await this.ready();
    const { destination: requested, ...chosen } = importPreviewInputSchema.parse(input);
    const selection = importSelectionSchema.parse(chosen);
    let destination = requested;
    if (destination?.kind === 'native-session') {
      if (!path.isAbsolute(destination.workDir)) fail('Choose an absolute local working directory');
      const fs = this.instantiation.invokeFunction((accessor) => accessor.get(IHostFileSystem));
      if (!(await fs.stat(destination.workDir)).isDirectory) fail('Target working directory must exist');
      let workDir = await fs.realpath(destination.workDir);
      if (this.bootstrap.platform === 'win32') workDir = workDir.toLowerCase();
      destination = { kind: 'native-session', workDir };
    }
    const signal = AbortSignal.timeout(30_000);
    const probe = await this.probe(selection, signal, destination);
    const page = probe.status === 'unsupported' ? { records: [], cursor: null, losses: [], bytesRead: 0 } : importParsePageSchema.parse(await this.hosts.requestSource(selection.pluginId, selection.sourceId, 'parse', { ...selection, revision: probe.revision, mode: this.mode(destination) }, signal));
    if (jsonBytes(page) > PAGE_BYTES) fail('Source page exceeds 512 KiB');
    const existing = await this.docs.get<ImportArchive>(NAMESPACE, this.key('archives', this.identity(selection, probe.sourceHome)));
    const native = destination?.kind === 'native-session' ? await this.nativeReceipt({ selection, sourceHome: probe.sourceHome, revision: probe.revision, destination }) : undefined;
    const preview = importPreviewSchema.parse({
      schemaVersion: 1, id: randomUUID(), selection, targetHome: this.bootstrap.homeDir, probe, destination,
      records: [], losses: mergeLosses(mergeLosses(probe.losses, page.losses), destination?.kind === 'native-session' ? [...nativeImportLosses, ...nativeRecordLosses(page.records)] : []), coverage: page.cursor === null ? 'complete' : 'sample',
      existingArchiveId: existing?.id ?? null, existingRevision: existing?.revision ?? null, existingSessionId: native?.sessionId ?? null, createdAt: Date.now(),
    });
    for (const record of page.records) {
      const available = READ_BYTES - jsonBytes(preview) - 1024;
      const end = textEnd(record.text, 0, available);
      if (end === 0 && record.text.length > 0) { preview.coverage = 'sample'; break; }
      preview.records.push({ ...record, text: record.text.slice(0, end), textOffset: 0, textTotal: record.text.length });
      if (end < record.text.length) { preview.coverage = 'sample'; break; }
    }
    if (preview.records.length < page.records.length) preview.coverage = 'sample';
    await this.docs.set(NAMESPACE, this.key('previews', preview.id), preview);
    return preview;
  }
  private async saveJob(job: ImportJob): Promise<ImportJob> {
    const next = importJobSchema.parse({ ...job, updatedAt: Date.now() });
    await this.docs.set(NAMESPACE, this.key('jobs', next.id), next);
    return next;
  }
  async job(id: string): Promise<ImportJob> {
    await this.ready();
    const raw = await this.docs.get(NAMESPACE, this.key('jobs', id));
    if (!raw) fail('Import job not found');
    return importJobSchema.parse(raw);
  }
  private async assertSnapshot(job: ImportJob, signal: AbortSignal) {
    const probe = await this.probe(job.selection, signal, job.destination);
    if (probe.revision !== job.revision || probe.sourceHome !== job.sourceHome || probe.status === 'unsupported') fail('Source changed; preview again before importing');
  }
  start(input: ImportStartInput): Promise<ImportJob> {
    return this.serialized(() => this.startJob(input));
  }
  private async startJob(input: ImportStartInput): Promise<ImportJob> {
    await this.ready();
    const args = importStartInputSchema.parse(input);
    const raw = await this.docs.get(NAMESPACE, this.key('previews', args.previewId));
    if (!raw) fail('Import preview not found in this target home');
    const preview = importPreviewSchema.parse(raw);
    if (preview.targetHome !== this.bootstrap.homeDir) fail('Import preview belongs to another target home');
    if (preview.probe.status === 'unsupported') fail('Source format is unsupported');
    const id = digest([preview.id]);
    const prior = await this.docs.get<ImportJob>(NAMESPACE, this.key('jobs', id));
    if (prior) return importJobSchema.parse(prior);
    if (this.active.size >= MAX_ACTIVE) fail('Two import jobs are already active');
    const job = await this.saveJob({ schemaVersion: 1, id, previewId: preview.id, selection: preview.selection,
      sourceHome: preview.probe.sourceHome, targetHome: preview.targetHome, revision: preview.probe.revision, title: preview.probe.title,
      formatVersion: preview.probe.formatVersion, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
      records: 0, pages: 0, bytesRead: 0, totalBytes: preview.probe.totalBytes, cursor: null, parsed: false,
      losses: mergeLosses(preview.probe.losses, preview.destination?.kind === 'native-session' ? nativeImportLosses : []), archiveId: null, error: null,
      destination: preview.destination, sessionId: preview.destination?.kind === 'native-session' ? randomUUID() : undefined, sessionPath: null });
    this.launch(job);
    return job;
  }
  private launch(job: ImportJob) {
    const controller = new AbortController();
    this.owners.set(job.id, job.selection.pluginId);
    const promise = this.run(job, controller.signal).finally(() => { this.active.delete(job.id); this.owners.delete(job.id); });
    this.active.set(job.id, { controller, promise });
  }
  private async run(initial: ImportJob, signal: AbortSignal): Promise<void> {
    let job = initial;
    try {
      await this.assertSnapshot(job, signal);
      signal.throwIfAborted();
      const completed = await this.committedJob(job);
      if (completed) { await this.saveJob(completed); return; }
      job = await this.saveJob({ ...job, status: 'running', error: null });
      while (!job.parsed) {
        signal.throwIfAborted();
        const page = importParsePageSchema.parse(await this.hosts.requestSource(job.selection.pluginId, job.selection.sourceId, 'parse', {
          ...job.selection, revision: job.revision, cursor: job.cursor ?? undefined, mode: this.mode(job.destination),
        }, signal));
        if (jsonBytes(page) > PAGE_BYTES) fail('Source page exceeds 512 KiB');
        if (page.cursor !== null && page.cursor === job.cursor) fail('Source parser did not advance');
        signal.throwIfAborted();
        await this.docs.set(`${NAMESPACE}/pages/${job.id}`, String(job.pages), importStoredPageSchema.parse({ schemaVersion: 1, page, recordsBefore: job.records }));
        signal.throwIfAborted();
        job = await this.saveJob({ ...job, pages: job.pages + 1, records: job.records + page.records.length,
          bytesRead: page.bytesRead, cursor: page.cursor, parsed: page.cursor === null, losses: mergeLosses(job.losses, job.destination?.kind === 'native-session' ? [...page.losses, ...nativeRecordLosses(page.records)] : page.losses) });
      }
      await this.assertSnapshot(job, signal);
      signal.throwIfAborted();
      const commit = this.commits.then(async () => {
        signal.throwIfAborted();
        if (job.destination?.kind === 'native-session') {
          job = await this.commitNative(job, signal);
          await this.saveJob(job);
          return;
        }
        const id = this.identity(job.selection, job.sourceHome);
        const old = await this.docs.get<ImportArchive>(NAMESPACE, this.key('archives', id));
        const preview = importPreviewSchema.parse(await this.docs.get(NAMESPACE, this.key('previews', job.previewId)));
        signal.throwIfAborted();
        if (old?.revision !== job.revision) {
          if ((old?.revision ?? null) !== preview.existingRevision) fail('Archive changed since preview; preview again');
          const archive = importArchiveSchema.parse({ schemaVersion: 1, id, pluginId: job.selection.pluginId, sourceId: job.selection.sourceId,
            sourceHome: job.sourceHome, externalId: job.selection.externalId, targetHome: job.targetHome, title: job.title,
            revision: job.revision, formatVersion: job.formatVersion, createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now(),
            status: job.losses.length > 0 ? 'partial' : 'preserved', losses: job.losses, records: job.records, pages: job.pages, jobId: job.id,
            previousJobIds: old ? [...old.previousJobIds, old.jobId] : [] });
          await this.docs.set(NAMESPACE, this.key('archives', id), archive);
        }
        job = await this.saveJob({ ...job, status: 'completed', archiveId: id, error: null });
      });
      this.commits = commit.catch(() => {});
      await commit;
    } catch (error) {
      const current = await this.docs.get<ImportJob>(NAMESPACE, this.key('jobs', job.id));
      job = current ?? job;
      const completed = await this.committedJob(job, true);
      await this.saveJob(completed ?? { ...job, status: signal.aborted ? 'interrupted' : 'failed', error: String(error).slice(0, 2000) });
    }
  }
  private async nativeReceipt(input: Pick<ImportJob, 'selection' | 'sourceHome' | 'revision' | 'destination'>): Promise<ImportJob | undefined> {
    const receipt = await this.docs.get<{ scope: string; job: ImportJob }>(NAMESPACE, this.key('native', this.nativeIdentity(input)));
    if (!receipt) return undefined;
    const job = importJobSchema.parse(receipt.job);
    const meta = await this.docs.get<SessionMeta>(receipt.scope, 'state.json');
    return meta?.custom?.['plugin_import_job'] === job.id ? job : undefined;
  }
  private async committedJob(job: ImportJob, requireOwner = false): Promise<ImportJob | undefined> {
    if (job.destination?.kind === 'native-session') {
      const receipt = await this.nativeReceipt(job);
      return receipt && (!requireOwner || receipt.id === job.id) ? { ...job, status: 'completed', archiveId: null, sessionId: receipt.sessionId, sessionPath: receipt.sessionPath,
        losses: receipt.losses, records: receipt.records, pages: receipt.pages, bytesRead: receipt.bytesRead, parsed: true, cursor: null, error: null } : undefined;
    }
    const archive = await this.docs.get<ImportArchive>(NAMESPACE, this.key('archives', this.identity(job.selection, job.sourceHome)));
    return archive?.revision === job.revision && (!requireOwner || archive.jobId === job.id) ? { ...job, status: 'completed', archiveId: archive.id, error: null } : undefined;
  }
  private async commitNative(job: ImportJob, signal: AbortSignal): Promise<ImportJob> {
    const existing = await this.committedJob(job);
    if (existing) return existing;
    if (job.destination?.kind !== 'native-session' || !job.sessionId) fail('Native import destination is missing');
    const manager = this.instantiation.invokeFunction((accessor) => accessor.get(ISessionManager));
    const session = await manager.create({ sessionId: job.sessionId, workDir: job.destination.workDir, ephemeral: true });
    let published = false;
    try {
      const context = session.accessor.get(ISessionContext);
      const scope = `${this.bootstrap.scope('sessions')}/${context.workspaceId}/${job.sessionId}`;
      const agent = await ensureMainAgent(session);
      const memory = agent.accessor.get(IAgentContextMemoryService);
      const dispatcher = agent.accessor.get(IEventDispatcher);
      let messages = 0; let lastPrompt: string | undefined;
      let pending: Parameters<typeof nativeMessage>[0] | undefined;
      let nextPart = 0;
      const appendPending = () => {
        if (!pending) return;
        const message = nativeMessage(pending);
        if (message) {
          memory.append(message); messages++;
          if (message.role === 'user') lastPrompt = pending.text.slice(-500);
        }
      };
      for (let page = 0; page < job.pages; page++) {
        signal.throwIfAborted();
        const stored = importStoredPageSchema.parse(await this.docs.get(`${NAMESPACE}/pages/${job.id}`, String(page)));
        for (const record of stored.page.records) {
          if (pending?.id === record.id && record.part === nextPart && pending.role === record.role) {
            pending = { ...pending, text: pending.text + record.text }; nextPart++;
          } else {
            appendPending(); pending = record; nextPart = record.part + 1;
          }
        }
        await dispatcher.flush();
      }
      appendPending();
      await dispatcher.flush();
      if (messages === 0) fail('Source contains no portable conversation text');
      signal.throwIfAborted();
      const metadata = session.accessor.get(ISessionMetadata);
      await metadata.update({ title: job.title, titleKind: 'custom', lastPrompt,
        custom: { plugin_import_job: job.id, plugin_import_source: job.selection, plugin_import_revision: job.revision, plugin_import_losses: job.losses } });
      const completed: ImportJob = { ...job, status: 'completed', archiveId: null, sessionPath: path.join(this.bootstrap.homeDir, scope), error: null };
      await this.docs.set(NAMESPACE, this.key('native', this.nativeIdentity(job)), { scope, job: completed });
      signal.throwIfAborted();
      await manager.saveEphemeral(job.sessionId);
      published = true;
      return completed;
    } finally {
      if (!published && manager.isEphemeral(job.sessionId)) {
        const receipt = await this.nativeReceipt(job);
        if (!receipt) await manager.delete(job.sessionId);
      }
    }
  }
  cancel(id: string): Promise<ImportJob> {
    return this.serialized(async () => {
      const job = await this.job(id);
      if (job.status === 'completed') return job;
      const active = this.active.get(id);
      active?.controller.abort(new Error('Import cancelled'));
      await active?.promise;
      const current = await this.job(id);
      return current.status === 'completed' ? current : this.saveJob({ ...current, status: 'cancelled', error: null });
    });
  }
  resume(id: string): Promise<ImportJob> {
    return this.serialized(() => this.resumeJob(id));
  }
  private async resumeJob(id: string): Promise<ImportJob> {
    const job = await this.job(id);
    if (job.status === 'completed' || this.active.has(id)) return job;
    if (this.active.size >= MAX_ACTIVE) fail('Two import jobs are already active');
    const next = await this.saveJob({ ...job, status: 'queued', error: null });
    this.launch(next);
    return next;
  }
  private async list<T>(kind: string, input: ImportListInput, parse: (raw: unknown) => T, predicate: (value: T) => boolean = () => true): Promise<{ items: T[]; cursor: string | null }> {
    const keys = (await this.docs.list(NAMESPACE, `${kind}.`)).toSorted();
    const cursor = input.cursor ?? '';
    const limit = input.limit ?? 50;
    const items: T[] = [];
    let last = cursor;
    let scanned = 0;
    for (const key of keys) {
      if (key <= cursor) continue;
      const raw = await this.docs.get(NAMESPACE, key);
      if (raw) {
        const value = parse(raw);
        if (predicate(value)) {
          if (jsonBytes({ items: [...items, value], cursor: key }) > READ_BYTES) {
            if (items.length === 0) fail('Import summary exceeds the read window');
            break;
          }
          items.push(value);
        }
      }
      last = key;
      if (items.length >= limit || ++scanned >= 500) break;
    }
    return { items, cursor: keys.some((key) => key > last) ? last : null };
  }
  async jobs(input: ImportListInput = {}): Promise<{ items: ImportJob[]; cursor: string | null }> {
    await this.ready();
    return this.list('jobs', importListInputSchema.parse(input), (raw) => importJobSchema.parse(raw));
  }
  async archives(input: ImportArchiveQuery = {}): Promise<{ items: ImportArchive[]; cursor: string | null }> {
    await this.ready();
    const args = importArchiveQuerySchema.parse(input);
    const query = args.query?.toLocaleLowerCase();
    return this.list('archives', args, (raw) => importArchiveSchema.parse(raw), (item) => !query || `${item.title}\n${item.externalId}\n${item.sourceId}`.toLocaleLowerCase().includes(query));
  }
  async read(input: ImportReadInput): Promise<ImportReadPage> {
    await this.ready();
    const args = importReadInputSchema.parse(input);
    const raw = await this.docs.get(NAMESPACE, this.key('archives', args.archiveId));
    if (!raw) fail('Import archive not found');
    const archive = importArchiveSchema.parse(raw);
    let position: { jobId: string; page: number; index: number; offset: number };
    try { position = args.cursor ? JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) : { jobId: archive.jobId, page: 0, index: 0, offset: 0 }; }
    catch { return fail('Invalid archive page cursor'); }
    if (position.jobId !== archive.jobId) fail('Archive revision changed; read from the beginning');
    if (![position.page, position.index, position.offset].every((value) => Number.isSafeInteger(value) && value >= 0) || position.page > archive.pages) fail('Invalid archive page cursor');
    const result: ImportReadPage = { archive, records: [], cursor: null };
    while (position.page < archive.pages && result.records.length < Math.min(args.limit ?? 64, 64)) {
      const stored = importStoredPageSchema.parse(await this.docs.get(`${NAMESPACE}/pages/${archive.jobId}`, String(position.page)));
      if (position.index > stored.page.records.length) fail('Invalid archive record cursor');
      if (position.index === stored.page.records.length) { position.page++; position.index = 0; position.offset = 0; continue; }
      const record = stored.page.records[position.index]!;
      if (position.offset > record.text.length) fail('Invalid archive text cursor');
      const available = READ_BYTES - jsonBytes(result) - 2048;
      const end = textEnd(record.text, position.offset, available);
      if (end === position.offset && record.text.length > position.offset) {
        if (result.records.length === 0) fail('Import summary exceeds the read window');
        break;
      }
      result.records.push({ ...record, text: record.text.slice(position.offset, end), textOffset: position.offset, textTotal: record.text.length });
      if (end < record.text.length) { position.offset = end; break; }
      position.index++; position.offset = 0;
    }
    if (position.page < archive.pages) result.cursor = Buffer.from(JSON.stringify(position)).toString('base64url');
    return result;
  }
}
registerScopedService(LifecycleScope.App, IPluginImportService, PluginImportService, ScopeActivation.OnDemand, 'pluginImport');

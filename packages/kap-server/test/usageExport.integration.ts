import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { AGENT_WIRE_RECORD_KEY, IAppendLogStore, IBootstrapService, IEventService, IFileSystemStorageService, ILogService, IQueryStore, IRetainedUsageService, ISessionIndex, IUsageFactStore, IUsageReadModel, type IBootstrapService as Bootstrap, type IConfigService, type ModelRecord, type Scope, type SessionSummary, type WireRecord } from '@kiki/agent-core-v2';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore, TomlAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { OPERATION_USAGE_KEY } from '@kiki/agent-core-v2/app/retainedUsage/retainedUsage';
import { UsageSourceTracker } from '../src/usage/usageSourceTracker';
import { AppendLogStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/appendLogStore';
import { MiniDbQueryStore, drainQueryStoreDisposals } from '@kiki/agent-core-v2/persistence/backends/minidb/miniDbQueryStore';
import { SqliteUsageReadModel } from '@kiki/agent-core-v2/persistence/backends/sqlite/sqliteUsageReadModel';
import { UsageFactStore } from '@kiki/agent-core-v2/app/usageFacts/usageFactStore';
import { RetainedUsageService } from '@kiki/agent-core-v2/app/retainedUsage/retainedUsageService';
import { stubLog } from '../../agent-core-v2/test/_base/log/stubs';
import { EventService } from '@kiki/agent-core-v2/app/event/eventService';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { VIBE_CAFE_INGEST_ENDPOINT, usageExportBatchSchema, usageExportItemSchema, type UsageExportBatch } from '@kiki/protocol';
import type { VibeAuthRequest } from '../src/usage/export/vibeAuth';
import { VIBE_MAPPING_VERSION, createVibeUsageAdapter } from '../src/usage/export/vibe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import type { UsageExportAdapter } from '../src/usage/export/adapter';
import { canonicalExportHome } from '../src/usage/export/handoffFile';
import { IModelPricingService, ModelPricingService, drainModelPricingDisposals, type IModelPricingService as Pricing } from '../src/pricing/modelPricingService';
import { UsageAggregationService, UsagePageTokenMismatchError } from '../src/usage/usageAggregationService';
import { UsageExportStore } from '../src/usage/export/store';
import { UsageExportSecretStore, type ExportKeyring } from '../src/usage/export/secrets';
import { UsageExportService } from '../src/usage/export/service';
import { UsageExportReceiver, createUsageExportReceiverServer } from '../src/usage/export/receiver';
import { createWebhookUsageAdapter } from '../src/usage/export/webhook';
import { addTokens, digest, emptyTokens, normalizePublicModel, projectSource } from '../src/usage/export/projection';
import { registerUsageExportRoutes } from '../src/routes/usageExport';
import Fastify from 'fastify';
import { createKlient } from '@kiki/klient/http';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const SENTINEL = 'SECRET_PROMPT_REASONING_TITLE_CWD_HOST_PROFILE_ATTACHMENT';
const T = Date.UTC(2026, 0, 1);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const priced: Pricing = {
  _serviceBrand: undefined, ready: Promise.resolve(), resolve: (model) => model === 'gpt-5' ? { requestedModel: model, catalogModel: 'gpt-5', strategy: 'exact', prices: { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheReadInputTokenCost: 1e-7, cacheCreationInputTokenCost: 1e-6 } } : undefined,
  calculate: (model, tokens) => model === 'gpt-5' ? (tokens.inputOther ?? 0) * 1e-6 + (tokens.output ?? 0) * 2e-6 + (tokens.inputCacheRead ?? 0) * 1e-7 + (tokens.inputCacheCreation ?? 0) * 1e-6 : undefined,
  getPricing: async () => { throw new Error('unused'); }, setPricing: async () => { throw new Error('unused'); }, refreshNow: async () => false, status: () => ({ source: 'empty', keys: 1 }),
};
function record(time: number, inputOther: number, other = { output: 3, inputCacheRead: 4, inputCacheCreation: 5 }, model = 'gpt-5'): WireRecord {
  return { type: 'usage.record', time, model, usageKnown: true, usage: { inputOther, ...other }, prompt: SENTINEL, reply: SENTINEL, reasoning: SENTINEL, profileName: SENTINEL, tool: { args: SENTINEL }, attachments: [SENTINEL], custom: { sentinel: SENTINEL } };
}
async function fixture(limits: ConstructorParameters<typeof UsageAggregationService>[2] = {}, now?: () => number, keyring?: ExportKeyring, vibeAuthRequest?: VibeAuthRequest, aggregationNow = Date.now, pricing: Pricing = priced) {
  const home = await mkdtemp(join(tmpdir(), 'kiki-usage-export-')); cleanup.push(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const storage = new FileStorageService(home, 0o700, 0o600); const append = new AppendLogStore(storage); cleanup.push(async () => { await append.flush(); await append.dispose(); });
  const bootstrap = { homeDir: home, scope: (name: string) => name, credentialsHomeDir: home, cacheDir: join(home, 'cache') } as Bootstrap;
  const ix = new TestInstantiationService();
  const log = stubLog();
  ix.stub(IBootstrapService, bootstrap); ix.stub(IFileSystemStorageService, storage); ix.stub(IAppendLogStore, append); ix.stub(ILogService, log);
  ix.set(IEventService, new SyncDescriptor(EventService)); ix.set(IUsageReadModel, new SyncDescriptor(SqliteUsageReadModel)); ix.set(IRetainedUsageService, new SyncDescriptor(RetainedUsageService));
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  ix.set(IQueryStore, new SyncDescriptor(MiniDbQueryStore)); ix.set(IUsageFactStore, new SyncDescriptor(UsageFactStore));
  const model = ix.get(IUsageReadModel); cleanup.push(async () => { await model.close(); await ix.dispose(); await drainQueryStoreDisposals(); });
  const retained = ix.get(IRetainedUsageService); const facts = ix.get(IUsageFactStore); const query = ix.get(IQueryStore); const sessions: SessionSummary[] = [];
  const index = { listRecent: async (query: { before?: string; limit?: number }) => { const start = query.before === undefined ? 0 : sessions.findIndex((s) => s.id === query.before) + 1; const items = sessions.slice(start, start + (query.limit ?? 100)); return { items, nextCursor: start + items.length < sessions.length ? items.at(-1)?.id : undefined }; } };
  const services = new Map<unknown, unknown>([[IFileSystemStorageService, storage], [IRetainedUsageService, retained], [ISessionIndex, index], [IModelPricingService, pricing], [IBootstrapService, bootstrap], [IAppendLogStore, append], [IUsageFactStore, facts], [IUsageReadModel, model], [IQueryStore, query], [ILogService, log]]);
  const core = { accessor: { get: (key: unknown) => services.get(key) } } as Scope;
  const reader = new UsageAggregationService(core, aggregationNow, limits); const path = join(home, 'export.sqlite'); let store = new UsageExportStore(path);
  const secretStore = () => new UsageExportSecretStore(home, store.installationKey(), keyring ?? (async () => { throw new Error('keyring-unavailable-fixture'); }));
  const secrets = secretStore();
  let service = new UsageExportService(store, reader, pricing, secrets, [createWebhookUsageAdapter()], { random: () => 0.5, now, sourceHome: home, vibeAuthRequest }); cleanup.push(() => service.close());
  const write = async (session: string, agent: string, records: readonly WireRecord[]) => append.rewrite(`sessions/work/${session}/agents/${agent}`, AGENT_WIRE_RECORD_KEY, records);
  const add = (id: string) => { const summary: SessionSummary = { id, workspaceId: 'work', createdAt: T, updatedAt: T, archived: false, title: SENTINEL, cwd: SENTINEL, lastPrompt: SENTINEL }; sessions.push(summary); return summary; };
  const restart = async (legacyDisabled?: boolean) => { await service.close(); store = new UsageExportStore(path, legacyDisabled); service = new UsageExportService(store, new UsageAggregationService(core, aggregationNow, limits), pricing, secretStore(), [createWebhookUsageAdapter()], { random: () => 0.5, now, sourceHome: home, vibeAuthRequest }); return service; };
  return { home, storage, retained, sessions, reader, core, write, add, get service() { return service; }, get store() { return store; }, restart };
}
async function receiverFixture() {
  const home = await mkdtemp(join(tmpdir(), 'kiki-usage-receiver-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const receiver = new UsageExportReceiver(join(home, 'receiver.sqlite')); cleanup.push(async () => receiver.close());
  const server = createUsageExportReceiverServer(receiver); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing-loopback');
  let requests = 0; const observed: string[] = []; server.on('request', (req) => { requests++; observed.push(req.url ?? '', JSON.stringify(req.headers)); req.on('data', (chunk: Buffer) => { try { observed.push((req.headers['content-encoding'] === 'gzip' ? gunzipSync(chunk) : chunk).toString('utf8')); } catch {} }); });
  return { receiver, endpoint: `http://127.0.0.1:${address.port}/usage`, port: address.port, get requests() { return requests; }, observed };
}
async function destination(service: UsageExportService, endpoint = 'https://example.test/usage', port?: number) {
  return service.saveDraft({ draft: { label: 'Example receiver', target: { kind: 'webhook', endpoint, gzip: true, authentication: 'none', private_grant: port === undefined ? undefined : { host: '127.0.0.1', ip: '127.0.0.1', protocol: 'http:', port } }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
}
async function enable(service: UsageExportService, id: string) { const preview = await service.preview(id); await service.enable(id, { preview_fingerprint: preview.preview_fingerprint, acknowledge: true }); return preview; }

describe('usage export explicit save consent and automatic upload', () => {
  it('records consent on save, schedules every 120 minutes and reuses it across edits and restart', async () => {
    let now = T; const f = await fixture({}, () => now); const r = await receiverFixture();
    f.add('automatic'); await f.write('automatic', 'main', [record(T + 1, 10)]);
    const d = await destination(f.service, r.endpoint, r.port);
    const draft = { id: d.id, label: d.label, target: d.target, scope: d.scope, schedule_minutes: 120 as const };
    const app = Fastify(); registerUsageExportRoutes(app, f.service); await app.listen({ port: 0, host: '127.0.0.1' }); cleanup.push(() => app.close());
    const address = app.server.address(); if (address === null || typeof address === 'string') throw new Error('missing-rest');
    const client = createKlient({ endpoint: `http://127.0.0.1:${address.port}` }); cleanup.push(() => client.close());
    const saved = await client.rest!.usageExport.saveDraft({ draft, auto_upload: true });
    expect(saved).toMatchObject({ enabled: true, state: 'ready', schedule_minutes: 120, next_at: T });
    expect(saved.consent_fingerprint).toBe((await f.service.preview(d.id)).preview_fingerprint);
    await f.service.tick(); expect(r.requests).toBe(1); expect(f.store.get(d.id).next_at).toBe(T + 7_200_000);
    now += 60_000;
    const edited = await f.service.saveDraft({ draft: { ...draft, label: 'Renamed', schedule_minutes: 60 } });
    expect(edited).toMatchObject({ enabled: true, consent_fingerprint: saved.consent_fingerprint, next_at: now + 3_600_000 });
    await f.restart(); expect(f.store.get(d.id)).toEqual(edited);
    await f.service.syncNow(d.id); expect(r.requests).toBe(1);
    const backfill = await f.service.backfill(d.id, { ...d.scope, start_at: T - 1_800_000 });
    expect(backfill.destination).toMatchObject({ enabled: false, consent_fingerprint: null, schedule_minutes: 60 });
    const agreed = await f.service.saveDraft({ draft: { ...draft, scope: backfill.destination.scope }, auto_upload: true });
    expect(agreed.enabled).toBe(true); expect(agreed.consent_fingerprint).not.toBe(saved.consent_fingerprint);
  });

  it('keeps an unchecked or explicitly disabled destination off across ordinary edits and retries', async () => {
    const f = await fixture(); const r = await receiverFixture(); const d = await destination(f.service, r.endpoint, r.port);
    const draft = { id: d.id, label: d.label, target: d.target, scope: d.scope, schedule_minutes: 120 as const };
    expect(await f.service.saveDraft({ draft, auto_upload: false })).toMatchObject({ enabled: false, next_at: null });
    await f.service.syncNow(d.id); expect(r.requests).toBe(0);
    await f.service.saveDraft({ draft, auto_upload: true });
    const paused = await f.service.saveDraft({ draft, auto_upload: false });
    expect(paused).toMatchObject({ enabled: false, state: 'disabled', next_at: null });
    expect(paused.consent_fingerprint).not.toBeNull();
    await f.service.saveDraft({ draft: { ...draft, schedule_minutes: 30 } });
    f.service.retry(d.id); await f.restart(); await f.service.tick(); await f.service.syncNow(d.id);
    expect(f.store.get(d.id).enabled).toBe(false); expect(r.requests).toBe(0);
  });

  it('never transfers consent to another receiver implicitly, and preserves an authentication stop when only the interval changes', async () => {
    const f = await fixture(); const d = await destination(f.service);
    const draft = { id: d.id, label: d.label, target: d.target, scope: d.scope, schedule_minutes: 120 as const };
    const a = await f.service.saveDraft({ draft, auto_upload: true });
    f.store.update(d.id, { state: 'needs-auth', error_category: 'http_auth', next_at: null });
    expect(await f.service.saveDraft({ draft: { ...draft, schedule_minutes: 60 }, auto_upload: true })).toMatchObject({ enabled: true, state: 'needs-auth', error_category: 'http_auth', next_at: null, consent_fingerprint: a.consent_fingerprint });
    const other = { ...draft, target: { ...d.target, kind: 'webhook' as const, endpoint: 'https://other.example.test/usage', gzip: false, authentication: 'none' as const } };
    expect(await f.service.saveDraft({ draft: other })).toMatchObject({ enabled: false, consent_fingerprint: null });
    const agreed = await f.service.saveDraft({ draft: other, auto_upload: true });
    expect(agreed.enabled).toBe(true); expect(agreed.consent_fingerprint).not.toBe(a.consent_fingerprint);
  });

  it.each(['save', 'device'] as const)('keeps an explicit disable effective during %s credential storage', async (mode) => {
    let now = T; let release!: () => void; let started!: () => void; let key: string | undefined;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const factory: ExportKeyring = async () => ({ setPassword: async (value) => { started(); await new Promise<void>((resolve) => { release = resolve; }); key = value; }, getPassword: async () => key, deleteCredential: async () => false });
    const send: VibeAuthRequest = async (path) => path.endsWith('/code') ? { deviceCode: 'SYNTHETIC', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device?user_code=ABCD-EFGH', interval: 1 } : { apiKey: 'vbu_SYNTHETIC_KEY' };
    const f = await fixture({}, () => now, factory, send); f.service.registerAdapter({ ...createWebhookUsageAdapter(), kind: 'vibe' });
    const draft = { label: 'VibeCafe', target: { kind: 'vibe' as const, endpoint: VIBE_CAFE_INGEST_ENDPOINT }, schedule_minutes: 120 as const, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } };
    const d = await f.service.saveDraft({ draft });
    const flow = mode === 'device' ? await f.service.vibeAuth.begin(d.id, { auto_upload: true }) : undefined;
    now += 1000;
    const pending = flow === undefined ? f.service.saveDraft({ draft: { ...draft, id: d.id }, secret: { value: 'vbu_SYNTHETIC_KEY', storage: 'auto' }, auto_upload: true }) : f.service.vibeAuth.poll(flow.flow_id);
    await waiting; f.service.disable(d.id); release(); await pending;
    expect(f.store.get(d.id)).toMatchObject({ enabled: false, state: 'disabled', next_at: null, consent_fingerprint: null });
    if (flow !== undefined) expect((await f.service.vibeAuth.poll(flow.flow_id)).state).toBe('cancelled');
  });

  it.each([true, false])('binds Vibe sign-in completion to this flow auto_upload=%s choice', async (autoUpload) => {
    let now = T; let denied = false;
    const send: VibeAuthRequest = async (path) => path.endsWith('/code') ? { deviceCode: 'SYNTHETIC', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device?user_code=ABCD-EFGH', interval: 1 } : denied ? { error: 'access_denied' } : { apiKey: 'vbu_SYNTHETIC_KEY' };
    const f = await fixture({}, () => now, undefined, send);
    f.service.registerAdapter({ ...createWebhookUsageAdapter(), kind: 'vibe' });
    const draft = { label: 'VibeCafe', target: { kind: 'vibe' as const, endpoint: VIBE_CAFE_INGEST_ENDPOINT }, schedule_minutes: 120 as const, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } };
    const d = await f.service.saveDraft({ draft });
    denied = true; const rejected = await f.service.vibeAuth.begin(d.id, { auto_upload: autoUpload }); now += 1000;
    expect((await f.service.vibeAuth.poll(rejected.flow_id)).state).toBe('denied'); expect(f.store.get(d.id).enabled).toBe(false);
    denied = false; const stale = await f.service.vibeAuth.begin(d.id, { auto_upload: autoUpload });
    await f.service.saveDraft({ draft: { ...draft, id: d.id, scope: { ...draft.scope, include_ephemeral: true } } }); now += 1000;
    expect(await f.service.vibeAuth.poll(stale.flow_id)).toMatchObject({ state: 'error', error_category: 'vibe-auth-destination-changed' }); expect(f.store.get(d.id).enabled).toBe(false);
    const flow = await f.service.vibeAuth.begin(d.id, { auto_upload: autoUpload }); now += 1000;
    expect((await f.service.vibeAuth.poll(flow.flow_id)).state).toBe('connected');
    expect(f.store.get(d.id)).toMatchObject({ enabled: autoUpload, schedule_minutes: 120, credential_storage: 'private-file', state: autoUpload ? 'ready' : 'disabled' });
    expect(f.store.get(d.id).consent_fingerprint !== null).toBe(autoUpload);
  });
});

describe('usage export real source → SQLite outbox → loopback receiver → durable ACK', () => {
  it('sends nothing without destinations or from draft and disabled destinations after retirement', async () => {
    const f = await fixture(); const r = await receiverFixture();
    await f.restart(false); f.service.start(); await f.service.tick();
    expect(f.service.status().destinations).toEqual([]); expect(r.requests).toBe(0);
    f.add('synthetic'); await f.write('synthetic', 'main', [record(T + 1, 10)]);
    const draft = await destination(f.service, r.endpoint, r.port);
    await f.service.syncNow(draft.id); expect(r.requests).toBe(0);
    await enable(f.service, draft.id); f.service.disable(draft.id);
    const disabled = f.store.get(draft.id);
    await f.restart(false); f.service.start(); await f.service.tick(); await f.service.syncNow(draft.id);
    expect(f.store.get(draft.id)).toEqual(disabled); expect(r.requests).toBe(0);
  });

  it('converts the old explicit off choice once to paused destinations, preserving consent and queued data', async () => {
    const f = await fixture(); const r = await receiverFixture();
    f.add('synthetic'); await f.write('synthetic', 'main', [record(T + 1, 10)]);
    const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id);
    const consent = f.store.get(d.id).consent_fingerprint; const queue = f.store.queue(d.id);
    f.store.setMeta(`handoff-arm:${d.id}`, 'pending-old-arm');
    await f.restart(true); f.service.start(); await f.service.tick(); await f.service.syncNow(d.id);
    expect(f.store.get(d.id)).toMatchObject({ enabled: false, state: 'disabled', next_at: null, consent_fingerprint: consent });
    expect(f.store.queue(d.id)).toEqual(queue); expect(f.store.meta(`handoff-arm:${d.id}`)).toBe(''); expect(r.requests).toBe(0);
    await f.service.enable(d.id, { preview_fingerprint: consent!, acknowledge: true });
    await f.restart(true);
    expect(f.store.get(d.id).enabled).toBe(true);
    await f.service.syncNow(d.id); expect(r.requests).toBe(1);
  });

  it('retiring an enabled legacy gate does not pause an explicitly enabled destination', async () => {
    const f = await fixture(); const d = await destination(f.service); await enable(f.service, d.id);
    const before = f.store.get(d.id); await f.restart(false);
    expect(f.store.get(d.id)).toEqual(before);
  });

  it('preserves timestamp and safe token boundaries without per-record temporary arrays', () => {
    const usage = { inputOther: 1, inputCacheRead: 2, inputCacheCreation: 3, output: 4 };
    const projected = projectSource({ key: 'boundary', workspaceId: 'work', kind: 'session', records: [
      { time: 8_640_000_000_000_000, model: 'gpt-5', usage },
      { time: 8_640_000_000_000_001, model: 'gpt-5', usage },
      { time: T, model: 'gpt-5', usage: { ...usage, inputOther: Number.MAX_SAFE_INTEGER } },
    ] }, priced);
    expect(projected.invalidRecords).toBe(2);
    expect(projected.buckets.reduce((n, bucket) => n + bucket.tokens.input_other, 0)).toBe(1);
    const tokens = emptyTokens();
    addTokens(tokens, { input_other: Number.MAX_SAFE_INTEGER, input_cache_read: 0, input_cache_creation: 0, output: 0 });
    expect(tokens.input_other).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => { addTokens(tokens, { input_other: 1, input_cache_read: 0, input_cache_creation: 0, output: 0 }); }).toThrow('unsafe-token-sum');
    expect(() => { addTokens(tokens, { input_other: 0, input_cache_read: 1, input_cache_creation: 0, output: 0 }); }).toThrow('unsafe-token-total');
  });

  it('preserves NUL-qualified source ids across projection pages when SQLite text results truncate', async () => {
    const f = await fixture();
    const ids = Array.from({ length: 33 }, (_, n) => `source-${String(n).padStart(2, '0')}-附件`);
    for (const [n, id] of ids.entries()) {
      f.add(id);
      await f.write(id, 'main', [record(T + 1, n + 1)]);
    }
    const all = StatementSync.prototype.all;
    let truncatedPages = 0;
    const read = vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...args) {
      const rows = all.apply(this, args);
      if (rows.some((row) => typeof row['id'] === 'string' && row['id'].includes('\0'))) {
        if (++truncatedPages > 8) throw new Error('projection keyset repeated a truncated source id');
        return rows.map((row) => ({ ...row, id: String(row['id']).split('\0')[0]! }));
      }
      return rows;
    });
    try {
      const d = await destination(f.service);
      const preview = await f.service.preview(d.id);
      expect(preview.source_complete).toBe(true);
      expect(preview.total_buckets).toBe(1);
      expect(preview.items[0]!.bucket!.tokens.input_other).toBe(561);
      await enable(f.service, d.id);
      await f.service.scan(true);
      expect(f.store.preview(d.id).items).toEqual(preview.items);
      const db = new DatabaseSync(join(f.home, 'export.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT origins FROM versions WHERE dest=?').get(d.id) as { origins: string };
        expect(JSON.parse(row.origins)).toEqual(ids.map((id) => `work\0${id}`));
      } finally { db.close(); }
    } finally { read.mockRestore(); }
  });

  it('replaces changed operation contributions in History, accounting and durable export while retaining ordinary deleted history', async () => {
    const f = await fixture();
    const source = f.add('operation-only');
    await f.storage.write('sessions/work/operation-only', 'state.json', Buffer.from(JSON.stringify({ ...source, agents: {} })));
    const tracker = new UsageSourceTracker(f.core);
    const accounting = new UsageAggregationService(f.core, Date.now, {}, tracker);
    cleanup.push(async () => { accounting.dispose(); tracker.dispose(); });
    const operation = { time: T + 1, model: 'gpt-5', modelAlias: 'gpt-5', provider: 'fixture', agentId: 'main', usageKnown: true, requestKind: 'output_layer', usage: { inputOther: 7, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
    await f.retained.recordOperation(source, operation);
    const d = await destination(f.service);
    const expectAll = async (tokens: number, records: number) => {
      await vi.waitFor(async () => {
        const history = await accounting.query({ range: 'all', provider: 'fixture' });
        expect(history).toMatchObject({ reliability: { complete: true, usage_coverage: { known_records: records } }, summary: { tokens: { input_other: tokens } } });
        expect(await accounting.readSessionAccounting('work', source.id)).toMatchObject({ complete: true, tokens: { input_other: tokens } });
      });
      await f.service.scan(true);
      const preview = await f.service.preview(d.id);
      expect(preview.source_complete).toBe(true);
      expect(preview.items.reduce((sum, item) => sum + item.bucket!.tokens.input_other, 0)).toBe(tokens);
      expect(preview.items.reduce((sum, item) => sum + item.bucket!.quality.known_records, 0)).toBe(records);
      if (f.store.get(d.id).enabled) {
        const persisted = new Map<string, ReturnType<UsageExportStore['exportQueue']>[number]>();
        for (const item of f.store.exportQueue(d.id)) if ((persisted.get(item.bucket_id)?.revision ?? 0) < item.revision) persisted.set(item.bucket_id, item);
        expect([...persisted.values()].reduce((sum, item) => sum + (item.bucket?.tokens.input_other ?? 0), 0)).toBe(tokens);
      }
    };
    const stamped = new Date(T);
    const operationPath = f.storage.pathFor('store', OPERATION_USAGE_KEY);
    await utimes(operationPath, stamped, stamped);
    await expectAll(7, 1);
    await enable(f.service, d.id);
    const original = (await f.storage.read('store', OPERATION_USAGE_KEY))!;
    const edited = Buffer.from(Buffer.from(original).toString('utf8').replace('"inputOther":7', '"inputOther":9'));
    expect(edited.byteLength).toBe(original.byteLength);
    const before = await f.storage.stat('store', OPERATION_USAGE_KEY);
    const beforeMtime = await f.storage.mtime('store', OPERATION_USAGE_KEY);
    const observed = vi.fn();
    const subscription = tracker.onDidChange(observed);
    try {
      await f.storage.write('store', OPERATION_USAGE_KEY, edited, { atomic: true });
      await utimes(operationPath, stamped, stamped);
      await vi.waitFor(() => { expect(observed).toHaveBeenCalledWith({ kind: 'operation' }); });
    } finally { subscription.dispose(); }
    const after = await f.storage.stat('store', OPERATION_USAGE_KEY);
    expect(after?.size).toBe(before?.size);
    expect(before?.identity).toBeDefined();
    expect(after?.identity).toBeDefined();
    expect(after?.identity).not.toBe(before?.identity);
    expect(await f.storage.mtime('store', OPERATION_USAGE_KEY)).toBe(beforeMtime);
    expect(await f.retained.readModelImportProgress!()).toContainEqual(expect.objectContaining({ source: `retained-ledger:${OPERATION_USAGE_KEY}`, complete: false, readBytes: 0 }));
    await expectAll(9, 1);
    const rewrite = async (bytes: Uint8Array, revision: number) => {
      await f.storage.write('store', OPERATION_USAGE_KEY, bytes);
      await utimes(operationPath, new Date(T + revision), new Date(T + revision));
    };
    await f.retained.recordOperation(source, { ...operation, time: T + 2, usage: { ...operation.usage, inputOther: 5 } });
    await expectAll(14, 2);
    const rows = (await f.storage.read('store', OPERATION_USAGE_KEY))!;
    const moved = Buffer.from(Buffer.from(rows).toString('utf8').replace('"modelAlias":"gpt-5"', '"modelAlias":"gpt-5-longer-alias"'));
    await rewrite(moved, 150);
    await expectAll(14, 2);
    await rewrite(edited, 200);
    await expectAll(9, 1);
    expect(await f.retained.retainDeletedSession(source)).toMatchObject({ complete: true, records: [] });
    f.sessions.splice(f.sessions.indexOf(source), 1);
    await f.service.scan(true);
    expect((await f.service.preview(d.id)).source_complete).toBe(true);
    expect(f.store.preview(d.id).items[0]?.bucket?.tokens.input_other).toBe(9);
    const retained = f.add('ordinary-deleted');
    await f.write(retained.id, 'main', [record(T + 3, 4, { output: 0, inputCacheRead: 0, inputCacheCreation: 0 })]);
    await f.retained.retainDeletedSession(retained);
    f.sessions.splice(f.sessions.indexOf(retained), 1);
    await f.service.scan(true);
    await rewrite(new Uint8Array(0), 300);
    await f.service.scan(true);
    const final = await f.service.preview(d.id);
    expect(final.source_complete).toBe(true);
    expect(final.items.reduce((sum, item) => sum + item.bucket!.tokens.input_other, 0)).toBe(4);
    await f.restart();
    await f.service.scan(true);
    expect(f.store.preview(d.id).items.reduce((sum, item) => sum + item.bucket!.tokens.input_other, 0)).toBe(4);
  });

  it('conserves all four tokens with subagents, active/retained replacement and explicit ephemeral opt-in; no content escapes', async () => {
    const f = await fixture(); const r = await receiverFixture(); const s = f.add('main-session');
    await f.write(s.id, 'main', [record(T + 1, 10), record(T + 1, 10), record(T + 1_800_001, 20), { ...record(T + 2, 0, { output: 0, inputCacheRead: 0, inputCacheCreation: 0 }), usageKnown: false }, { ...record(T + 3, 0, { output: 0, inputCacheRead: 0, inputCacheCreation: 0 }), usageKnown: undefined }, record(T + 4, -1), record(T + 5, Number.MAX_SAFE_INTEGER + 1), record(T + 6, 7, undefined, SENTINEL)]);
    await f.write(s.id, 'subagent', [record(T + 7, 30)]);
    const deleted = f.add('deleted'); await f.write(deleted.id, 'main', [record(T + 8, 40)]); await f.retained.retainDeletedSession(deleted); f.sessions.splice(f.sessions.indexOf(deleted), 1);
    await f.write('private', 'main', [record(T + 9, 50)]); await f.retained.retainEphemeralUsage!('sessions/work/private', 'work');
    const d = await destination(f.service, r.endpoint, r.port); const preview = await f.service.preview(d.id);
    expect(r.requests).toBe(0); expect(preview.source_complete).toBe(true); expect(preview.invalid_records).toBe(2);
    const totals = preview.items.reduce((sum, item) => { const t = item.bucket!.tokens; return [sum[0]! + t.input_other, sum[1]! + t.input_cache_read, sum[2]! + t.input_cache_creation, sum[3]! + t.output]; }, [0, 0, 0, 0]);
    expect(totals).toEqual([117, 24, 30, 18]);
    const first = preview.items.find((item) => item.bucket?.model === 'gpt-5' && item.bucket.start_at === new Date(T).toISOString())!;
    expect(first.bucket?.quality).toMatchObject({ known_records: 4, missing_records: 1, legacy_zero_records: 1, invalid_records: 2, price_unknown: true });
    expect(first.bucket?.cost.usd_estimated).toBeNull(); expect(preview.items.some((item) => item.bucket?.model.startsWith('custom-'))).toBe(true);
    expect(JSON.stringify(preview.items)).not.toContain(SENTINEL);
    expect(await f.service.testProtocol(d.id)).toMatchObject({ outcome: 'delivered' }); await enable(f.service, d.id); await f.service.syncNow(d.id);
    for (const item of preview.items) { expect(r.receiver.read(item.stream_id, item.bucket_id)?.bucket?.tokens).toEqual(item.bucket?.tokens); expect(f.store.ack(d.id, item.bucket_id)?.hash).toBe(item.payload_hash); }
    const requestCount = r.requests; await f.service.syncNow(d.id); expect(r.requests).toBe(requestCount);
    await f.retained.retainDeletedSession(s); f.sessions.splice(f.sessions.indexOf(s), 1); await f.service.syncNow(d.id); expect(r.requests).toBe(requestCount);
    const updated = await f.service.backfill(d.id, { ...d.scope, include_ephemeral: true }); expect(updated.destination.enabled).toBe(false); await enable(f.service, d.id); await f.service.syncNow(d.id);
    expect(f.store.preview(d.id).items.reduce((n, item) => n + item.bucket!.tokens.input_other, 0)).toBe(167);
    expect(r.observed.join('\n')).not.toContain(SENTINEL); expect(JSON.stringify(f.service.exportLocal(d.id))).not.toContain(SENTINEL);
  });

  it('publishes a complete source transaction before yielding through bounded staging cleanup', async () => {
    const f = await fixture(); const d = await destination(f.service);
    for (let i = 0; i < 33; i++) f.store.stage('bounded-cleanup', projectSource({ key: `cleanup-${i}`, workspaceId: 'work', kind: 'session', records: [{ time: T + 1, model: 'gpt-5', usageKnown: true, usage: { inputOther: 1, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }] }, priced));
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    const staged = () => Number(db.prepare('SELECT COUNT(*) AS n FROM temp.staging').get()!['n']);
    expect(db.prepare("SELECT name FROM main.sqlite_master WHERE name='staging'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA main.synchronous').get()!['synchronous']).toBe(2);
    expect(db.prepare('PRAGMA temp_store').get()!['temp_store']).toBe(1);
    const publish = f.store.publishStage.bind(f.store);
    const observed: number[] = [];
    const spy = vi.spyOn(f.store, 'publishStage').mockImplementation((...args) => {
      publish(...args);
      expect(staged()).toBe(33);
      expect(f.store.meta('scan-complete')).toBe('true');
      expect(f.store.preview(d.id).items[0]!.bucket!.tokens.input_other).toBe(33);
    });
    let tick: NodeJS.Immediate;
    const inspect = () => { observed.push(staged()); expect(f.store.preview(d.id).items[0]!.bucket!.tokens.input_other).toBe(33); tick = setImmediate(inspect); };
    tick = setImmediate(inspect);
    try {
      await f.store.publishStageAsync('bounded-cleanup');
      expect(staged()).toBe(0);
      expect(observed).toEqual([17, 1, 0]);
    } finally { clearImmediate(tick); spy.mockRestore(); }
  });

  it('replays cold fact journals through the typed read model without constructing a generic query index, preserving duplicate ordinals, zero quality and rewrite resets', async () => {
    const f = await fixture({ cacheMaxRecords: 0 }); const s = f.add('journal');
    const zero = { output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const known = record(T + 1, 2, zero);
    await f.write(s.id, 'main', [known, known, record(T + 2, 0, zero), { ...record(T + 2, 0, zero), usageKnown: false }, { ...record(T + 2, 0, zero), usageKnown: undefined }]);
    const read = vi.spyOn(f.core.accessor.get(IUsageFactStore), 'read');
    const batch = vi.spyOn(f.core.accessor.get(IQueryStore), 'batch');
    try {
      const d = await destination(f.service); await f.service.scan();
      const original = f.store.preview(d.id).items;
      expect(original[0]!.bucket).toMatchObject({ tokens: { input_other: 4 }, quality: { known_records: 3, missing_records: 1, legacy_zero_records: 1 } });
      let visits = 0;
      await f.reader.readExportSources(async (source) => {
        if (source.kind !== 'session') return;
        visits += source.records.length;
        expect(source.records).toHaveLength(5);
        expect(source.records[0]).toEqual(source.records[1]);
        expect(source.records[0]).not.toBe(source.records[1]);
        expect(new Set(source.records).size).toBe(5);
        expect(source.records.map((value) => value.usageKnown)).toEqual([true, true, true, false, undefined]);
      });
      expect(visits).toBe(5);
      await f.restart(); await f.service.scan();
      expect(f.store.preview(d.id).items).toEqual(original);
      await f.storage.append('sessions/work/journal/agents/main', AGENT_WIRE_RECORD_KEY, Buffer.from(JSON.stringify(known) + '\n'));
      await f.service.scan();
      expect(f.store.preview(d.id).items[0]!.bucket).toMatchObject({ tokens: { input_other: 6 }, quality: { known_records: 4, missing_records: 1, legacy_zero_records: 1 } });
      await f.core.accessor.get(IAppendLogStore).rewrite('sessions/work/journal/agents/main', AGENT_WIRE_RECORD_KEY, [record(T + 1, 7, zero)]);
      await f.service.scan();
      expect(f.store.preview(d.id).items[0]!.bucket).toMatchObject({ tokens: { input_other: 7 }, quality: { known_records: 1, missing_records: 0, legacy_zero_records: 0 } });
      expect(f.service.status()).toMatchObject({ scan_complete: true, scan_error: null });
      expect(read).toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    } finally { read.mockRestore(); batch.mockRestore(); }
  });

  it.each(['separate sessions', 'one session'] as const)('finishes first publication across deadlines with the same wires in %s', async (layout) => {
    let clock = 0;
    const f = await fixture({}, () => T, undefined, undefined, () => clock);
    const facts = f.core.accessor.get(IUsageFactStore);
    const zero = { output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
    const wires = [[record(T + 1, 10, zero)], [record(T + 2, 20, zero)], [record(T + 3, 30, zero), { ...record(T + 4, 0, zero), usageKnown: false }, { ...record(T + 5, 0, zero), usageKnown: undefined }]];
    const scopes: string[] = [];
    if (layout === 'one session') f.add('combined');
    for (let i = 0; i < wires.length; i++) {
      const session = layout === 'one session' ? 'combined' : `session-${i}`;
      if (layout === 'separate sessions') f.add(session);
      const agent = `agent-${i}`; const scope = `sessions/work/${session}/agents/${agent}`; scopes.push(scope);
      if (i < 2) { await f.write(session, agent, wires[i]!); await facts.summary(scope); }
      else await f.storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(wires[i]!.map((row) => JSON.stringify(row)).join('\n') + '\n'));
    }
    const d = await destination(f.service);
    await f.service.saveDraft({ draft: { id: d.id, label: d.label, target: d.target, scope: d.scope, schedule_minutes: 120 }, auto_upload: true });
    const reads = new Map<string, number>(); const read = facts.read.bind(facts);
    const observed = vi.spyOn(facts, 'read').mockImplementation(async (...args) => {
      const snapshot = await read(...args); reads.set(args[0], (reads.get(args[0]) ?? 0) + 1); clock += 6_000; return snapshot;
    });
    const states: { scan_complete: boolean; scan_error: string | null }[] = [];
    try {
      for (let i = 0; i < 6; i++) {
        await f.service.scan(); const { scan_complete, scan_error } = f.service.status(); states.push({ scan_complete, scan_error });
        if (scan_complete) break;
        expect(f.store.preview(d.id).total).toBe(0); expect(f.store.queue(d.id).pending).toBe(0);
      }
      const tail = await f.core.accessor.get(IUsageReadModel).source(scopes[2]!);
      expect(states, JSON.stringify({ layout, reads: [...reads], tail_offset: tail?.checkpoint?.offset ?? 0 })).toEqual([{ scan_complete: false, scan_error: 'deadline' }, { scan_complete: true, scan_error: null }]);
      expect([...reads.values()]).toEqual([1, 1, 1]);
      expect(f.store.preview(d.id).items[0]!.bucket).toMatchObject({ tokens: { input_other: 60 }, quality: { known_records: 3, missing_records: 1, legacy_zero_records: 1 }, cost: { usd_estimated: null } });
      expect(f.store.get(d.id)).toMatchObject({ enabled: true, schedule_minutes: 120 });
      expect(f.store.queue(d.id).pending).toBe(1);
    } finally { observed.mockRestore(); }
  });

  it('discards an unfinished session prefix on a forced scan and reads the replacement once', async () => {
    let clock = 0;
    const f = await fixture({ deadlineMs: 3_000 }, undefined, undefined, undefined, () => clock);
    f.add('forced');
    for (let i = 0; i < 3; i++) await f.write('forced', `agent-${i}`, [record(T + i, i + 1)]);
    const d = await destination(f.service);
    const facts = f.core.accessor.get(IUsageFactStore); const read = facts.read.bind(facts);
    const observed = vi.spyOn(facts, 'read').mockImplementation(async (...args) => { const row = await read(...args); clock += 2_000; return row; });
    try {
      await f.service.scan(); expect(f.service.status()).toMatchObject({ scan_complete: false, scan_error: 'deadline' });
      expect(f.store.preview(d.id).total).toBe(0);
      await f.write('forced', 'agent-0', [record(T, 100)]);
      await f.service.scan(true); expect(f.service.status()).toMatchObject({ scan_complete: false, scan_error: 'deadline' });
      await f.service.scan(); expect(f.service.status()).toMatchObject({ scan_complete: true, scan_error: null });
      expect(observed.mock.calls.map(([source]) => source.split('/').at(-1))).toEqual(['agent-0', 'agent-1', 'agent-0', 'agent-1', 'agent-2']);
      expect(f.store.preview(d.id).items[0]!.bucket!.tokens.input_other).toBe(105);
    } finally { observed.mockRestore(); }
  });

  it('automatically continues three-second and raw-record slices before queuing first upload with the existing consent and interval', async () => {
    let clock = 0;
    const f = await fixture({ deadlineMs: 3_000, wireRecordBudget: 1 }, () => T, undefined, undefined, () => clock);
    f.add('automatic-slices');
    for (let i = 0; i < 3; i++) {
      const rows = Array.from({ length: i === 2 ? 3 : 1 }, () => record(T + i, i + 1));
      await f.storage.write(`sessions/work/automatic-slices/agents/agent-${i}`, AGENT_WIRE_RECORD_KEY, Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n'));
    }
    const sent: UsageExportBatch[] = [];
    f.service.registerAdapter({ ...createWebhookUsageAdapter(), send: async (batch) => {
      sent.push(batch);
      return { outcome: 'delivered', receipt: { schema_version: 'kiki.usage.receipt.v1', batch_id: batch.batch_id, items: batch.items.map((item) => ({ stream_id: item.stream_id, bucket_id: item.bucket_id, revision: item.revision, payload_hash: item.payload_hash, status: 'applied' })) } };
    } });
    const d = await destination(f.service);
    const agreed = await f.service.saveDraft({ draft: { id: d.id, label: d.label, target: d.target, scope: d.scope, schedule_minutes: 120 }, auto_upload: true });
    const facts = f.core.accessor.get(IUsageFactStore); const read = facts.read.bind(facts);
    const observed = vi.spyOn(facts, 'read').mockImplementation(async (...args) => { const row = await read(...args); clock += 2_000; return row; });
    try {
      f.service.start(); await f.service.syncNow(d.id);
      expect(f.service.status()).toMatchObject({ scan_complete: false, scan_error: 'record_budget' });
      expect(f.store.queue(d.id).pending).toBe(0); expect(sent).toHaveLength(0);
      await vi.waitFor(() => { expect(f.service.status()).toMatchObject({ scan_complete: true, scan_error: null }); });
      expect(observed.mock.calls.map(([source]) => source.split('/').at(-1))).toEqual(['agent-0', 'agent-1', 'agent-2']);
      expect(f.store.queue(d.id).pending).toBe(1);
      expect(f.store.get(d.id)).toMatchObject({ enabled: true, schedule_minutes: 120, next_at: T + 7_200_000, consent_fingerprint: agreed.consent_fingerprint });
      await f.service.deliver(d.id, true);
      expect(sent).toHaveLength(1); expect(sent[0]!.items[0]!.bucket!.tokens.input_other).toBe(12);
      expect(f.store.queue(d.id).pending).toBe(0);
      expect(f.store.ack(d.id, sent[0]!.items[0]!.bucket_id)?.revision).toBe(1);
    } finally { observed.mockRestore(); }
  });

  it('retains the previous complete source while budget-limited, then publishes a complete correction; force detects same size/mtime rewrite without resetting ACK', async () => {
    const f = await fixture({ wireRecordBudget: 2 }); const r = await receiverFixture(); const s = f.add('rewrite');
    await f.write(s.id, 'main', [record(T + 1, 10)]); const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id); await f.service.syncNow(d.id);
    const original = f.store.preview(d.id).items[0]!; const wirePath = join(f.home, 'sessions/work/rewrite/agents/main', AGENT_WIRE_RECORD_KEY); const before = await stat(wirePath);
    const text = (await readFile(wirePath, 'utf8')).replace('"inputOther":10', '"inputOther":20'); await f.storage.write('sessions/work/rewrite/agents/main', AGENT_WIRE_RECORD_KEY, Buffer.from(text)); await utimes(wirePath, before.atime, before.mtime);
    await f.service.scan(true); const correction = f.store.preview(d.id).items[0]!; expect(correction.bucket!.tokens.input_other).toBe(20); expect(correction.revision).toBe(original.revision + 1); expect(f.store.ack(d.id, original.bucket_id)?.revision).toBe(original.revision);
    await f.service.syncNow(d.id);
    await f.storage.append('sessions/work/rewrite/agents/main', AGENT_WIRE_RECORD_KEY, Buffer.from([record(T + 2, 10), record(T + 3, 10), record(T + 4, 10)].map((value) => JSON.stringify(value)).join('\n') + '\n'));
    await f.service.scan(); expect(f.service.status().scan_error).toBe('record_budget'); expect(f.store.preview(d.id).items[0]!.bucket!.tokens.input_other).toBe(20);
    await f.service.scan(); expect(f.store.preview(d.id).items[0]!.bucket!.tokens.input_other).toBe(50);
  });

  it('keeps in-flight payload immutable through correction/restart and ACK loss; rejects stale resurrection after tombstone', async () => {
    const f = await fixture(); const r = await receiverFixture(); const s = f.add('recover'); await f.write(s.id, 'main', [record(T + 1, 10)]);
    const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id); const batch = f.store.take(d.id, 200, 1_048_576)!;
    const receipt = r.receiver.apply(batch); for (let i = 0; i < 100; i++) expect(r.receiver.apply(batch).items[0]!.status).toBe('duplicate');
    await f.write(s.id, 'main', [record(T + 1, 5)]); await f.service.scan(true); expect(f.store.take(d.id, 200, 1_048_576)).toEqual(batch);
    await f.restart(); expect(f.store.take(d.id, 200, 1_048_576)).toEqual(batch); f.store.acknowledge(d.id, receipt, Date.now());
    const lower = f.store.take(d.id, 200, 1_048_576)!; expect(lower.items[0]!.revision).toBe(2); expect(lower.items[0]!.bucket!.tokens.input_other).toBe(5); f.store.acknowledge(d.id, r.receiver.apply(lower), Date.now());
    f.service.withdraw(d.id, true); const deletion = f.store.take(d.id, 200, 1_048_576)!; expect(deletion.items[0]!.operation).toBe('delete'); f.store.acknowledge(d.id, r.receiver.apply(deletion), Date.now());
    expect(r.receiver.apply(lower).items[0]!.status).toBe('stale'); expect(r.receiver.read(deletion.items[0]!.stream_id, deletion.items[0]!.bucket_id)!.operation).toBe('delete');
    const conflict = structuredClone(deletion); conflict.items[0]!.payload_hash = 'a'.repeat(64); expect(() => r.receiver.apply(conflict)).toThrow('payload-hash-mismatch');
  });

  it('rolls back a capacity-failed withdrawal and continues projection, but successful withdrawal freezes normal revisions', async () => {
    const f = await fixture();
    const s = f.add('withdraw-capacity');
    await f.write(s.id, 'main', [record(T + 1, 10), record(T + 1_800_001, 10)]);
    const d = await destination(f.service);
    await enable(f.service, d.id);
    const batch = f.store.take(d.id, 200, 1_048_576)!;
    f.service.setQueueCapacity(Math.max(1024, f.store.queue(d.id).bytes));
    const queueBefore = f.store.exportQueue(d.id);
    const versionsBefore = f.store.preview(d.id).items;
    const destinationBefore = f.store.get(d.id);
    expect(() => f.service.withdraw(d.id, true)).toThrow('export-queue-full');
    expect(f.store.meta(`withdrawn:${d.id}`)).toBeNull();
    expect(f.store.exportQueue(d.id)).toEqual(queueBefore);
    expect(f.store.preview(d.id).items).toEqual(versionsBefore);
    expect(f.store.get(d.id)).toEqual(destinationBefore);
    expect(f.store.take(d.id, 200, 1_048_576)).toEqual(batch);
    f.store.acknowledge(d.id, {
      schema_version: 'kiki.usage.receipt.v1', batch_id: batch.batch_id,
      items: batch.items.map((item) => ({ stream_id: item.stream_id, bucket_id: item.bucket_id,
        revision: item.revision, payload_hash: item.payload_hash, status: 'applied' as const })),
    }, T);
    f.service.setQueueCapacity(52_428_800);
    await f.write(s.id, 'main', [record(T + 1, 20), record(T + 1_800_001, 20)]);
    await f.service.scan(true);
    const corrected = f.store.exportQueue(d.id);
    expect(corrected).toHaveLength(2);
    expect(corrected.every((item) => item.revision === 2 && item.bucket?.tokens.input_other === 20)).toBe(true);
    f.service.withdraw(d.id, true);
    expect(f.store.meta(`withdrawn:${d.id}`)).toBe('true');
    const tombstones = f.store.exportQueue(d.id);
    expect(tombstones).toHaveLength(2);
    expect(tombstones.every((item) => item.operation === 'delete' && item.revision === 3)).toBe(true);
    await f.write(s.id, 'main', [record(T + 1, 30), record(T + 1_800_001, 30)]);
    await f.service.scan(true);
    expect(f.store.exportQueue(d.id)).toEqual(tombstones);
  });

  it('enforces persistent writer election, transaction rollback on capacity, explicit removal and consent scope changes', async () => {
    const keys = new Map<string, string>(); const keyring: ExportKeyring = async (account) => ({ setPassword: async (value) => { keys.set(account, value); }, getPassword: async () => keys.get(account), deleteCredential: async () => keys.delete(account) });
    const f = await fixture({}, undefined, keyring); const other = new UsageExportStore(join(f.home, 'export.sqlite')); cleanup.push(async () => other.close()); expect(other.writer).toBe(false); expect(() => other.setCapacity(2048)).toThrow('export-writer-unavailable');
    const keyed = await f.service.saveDraft({ draft: { label: 'Credential lifecycle', target: { kind: 'webhook', endpoint: 'https://example.test/usage', authentication: 'bearer', gzip: false }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } }, secret: { value: 'synthetic-key', storage: 'keyring' } }); expect(keys.size).toBe(1);
    await f.service.saveDraft({ draft: { id: keyed.id, label: keyed.label, target: keyed.target, schedule_minutes: 0, scope: keyed.scope }, secret: { value: 'synthetic-key', storage: 'private-file', acknowledge_file_storage: true } }); expect(keys.size).toBe(0); const credentialFile = join(f.home, 'credentials/usage-export', `${keyed.id}.secret`); expect(await readFile(credentialFile, 'utf8')).toBe('synthetic-key');
    await f.service.remove(keyed.id, false); await expect(readFile(credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const s = f.add('capacity'); await f.write(s.id, 'main', [record(T + 1, 10)]); const d = await destination(f.service); await enable(f.service, d.id); const old = f.store.preview(d.id).items[0]!;
    f.service.setQueueCapacity(1024); await f.write(s.id, 'main', [record(T + 1, 20), record(T + 1_800_001, 20), record(T + 3_600_001, 20)]); await f.service.scan(true);
    expect(f.service.status().scan_error).toBe('queue-full'); expect(f.store.preview(d.id).items[0]!.payload_hash).toBe(old.payload_hash);
    expect(() => f.service.clearQueue(d.id, false)).toThrow('clear-queue-requires-consent'); await expect(f.service.remove(d.id, false)).rejects.toThrow('remove-requires-queue-consent');
    const saved = await f.service.saveDraft({ draft: { id: d.id, label: d.label, target: d.target, scope: { ...d.scope, start_at: T - 1_800_000 }, schedule_minutes: 30 } }); expect(saved.enabled).toBe(false);
    await expect(f.service.enable(d.id, { preview_fingerprint: 'a'.repeat(64), acknowledge: true })).rejects.toThrow('consent-preview-changed');
    await f.service.remove(d.id, true); expect(f.service.status().destinations).toEqual([]);
  });

  it('isolates 401/429/413/malformed replies and revocation from another healthy destination, with safe diagnostics and bounded exit', async () => {
    const f = await fixture(); const r = await receiverFixture(); const s = f.add('faults'); await f.write(s.id, 'main', [record(T + 1, 10), record(T + 1_800_001, 20)]);
    let status = 401; let calls = 0;
    const failing = createServer((req, res) => { calls++; req.resume(); res.writeHead(status, { 'retry-after': '120' }).end(SENTINEL); }); await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => failing.close(() => resolve())));
    const address = failing.address(); if (address === null || typeof address === 'string') throw new Error('missing-loopback');
    const bad = await destination(f.service, `http://127.0.0.1:${address.port}/usage`, address.port); const good = await destination(f.service, r.endpoint, r.port); await enable(f.service, bad.id); await enable(f.service, good.id);
    await Promise.all([f.service.deliver(bad.id), f.service.deliver(good.id)]); expect(f.store.get(bad.id).state).toBe('needs-auth'); expect(f.store.queue(good.id).pending).toBe(0); await f.service.deliver(bad.id); expect(calls).toBe(1);
    status = 429; await f.service.syncNow(bad.id); expect(f.store.get(bad.id).next_at! - Date.now()).toBeGreaterThan(119000);
    status = 413; await f.service.syncNow(bad.id); expect(f.store.get(bad.id).state).toBe('retrying'); await f.service.syncNow(bad.id); expect(f.store.get(bad.id).state).toBe('quarantined');
    f.service.disable(bad.id); const count = calls; await f.service.syncNow(bad.id); expect(calls).toBe(count); expect(JSON.stringify(f.service.diagnostics())).not.toContain(SENTINEL);
    const started = Date.now(); await f.service.close(); expect(Date.now() - started).toBeLessThan(3000);
  });

  it('serves the same typed management facade through real local REST and rejects unknown outbound fields', async () => {
    const f = await fixture(); f.add('rest'); await f.write('rest', 'main', [record(T + 1, 10)]);
    const app = Fastify(); registerUsageExportRoutes(app, f.service); await app.listen({ port: 0, host: '127.0.0.1' }); cleanup.push(() => app.close());
    const address = app.server.address(); if (address === null || typeof address === 'string') throw new Error('missing-rest');
    const client = createKlient({ endpoint: `http://127.0.0.1:${address.port}` }); cleanup.push(() => client.close());
    const d = await client.rest!.usageExport.saveDraft({ draft: { label: 'REST', target: { kind: 'webhook', endpoint: 'https://example.test/usage', gzip: false, authentication: 'none' }, schedule_minutes: 30, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    const preview = await client.rest!.usageExport.preview(d.id); expect(preview.total_buckets).toBe(1); expect((await client.rest!.usageExport.status()).destinations[0]?.destination.id).toBe(d.id); await client.rest!.usageExport.remove(d.id, false);
    expect(usageExportItemSchema.safeParse({ ...preview.items[0], prompt: SENTINEL }).success).toBe(false); expect(usageExportBatchSchema.safeParse({ schema_version: 'kiki.usage.batch.v1', batch_id: 'a'.repeat(48), items: preview.items, metadata: { path: SENTINEL } }).success).toBe(false);
    expect(normalizePublicModel('axon/hub/Qwen/Qwen3.8-Flash')).toBe('Qwen/Qwen3.8-Flash'); expect(normalizePublicModel('private/project-name')).toBeUndefined();
  });

  it('automatically recovers after more than twelve transient failures with the same durable batch, and does not read unrelated ACK history', async () => {
    let now = T; const f = await fixture({}, () => now); const r = await receiverFixture(); f.add('outage'); await f.write('outage', 'main', [record(T + 1, 10)]);
    const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id);
    const history = vi.spyOn(f.store, 'acknowledgedRelated').mockImplementation(() => { throw new Error('non-vibe-history-read'); });
    const payloads: UsageExportBatch[] = []; let available = false;
    f.service.registerAdapter({ ...createWebhookUsageAdapter(), send: async (batch) => { payloads.push(structuredClone(batch)); return available ? { outcome: 'delivered', receipt: r.receiver.apply(batch) } : { outcome: 'retry', errorCategory: 'network', retryAfterMs: 120000 }; } });
    for (let i = 0; i < 15; i++) { await f.service.tick(); expect(f.store.get(d.id).state).toBe('retrying'); expect(f.store.get(d.id).next_at).not.toBeNull(); expect(f.store.queue(d.id).inflight).toBe(1); now = f.store.get(d.id).next_at!; }
    expect(payloads.every((batch) => JSON.stringify(batch) === JSON.stringify(payloads[0]))).toBe(true); available = true; await f.service.tick();
    expect(f.store.queue(d.id).inflight).toBe(0); expect(f.store.get(d.id).last_success_at).toBe(now); expect(history).not.toHaveBeenCalled();
    const script = await f.service.saveDraft({ draft: { label: 'Script contract', target: { kind: 'script', command: 'unused-injected-adapter', timeout_ms: 1000, output_limit_bytes: 65536 }, schedule_minutes: 0, scope: d.scope } });
    f.service.registerAdapter({ ...createWebhookUsageAdapter(), kind: 'script', send: async (batch, context) => { expect(context.previousAcknowledged).toEqual([]); return { outcome: 'delivered', receipt: r.receiver.apply(batch) }; } });
    await enable(f.service, script.id); await f.service.deliver(script.id); expect(history).not.toHaveBeenCalled(); history.mockRestore();
  });

  it('preserves an entire partial-receipt payload through restart, coalesces quarantined retries, and detects valid same-revision conflicts', async () => {
    const f = await fixture(); const r = await receiverFixture(); f.add('partial'); await f.write('partial', 'main', [record(T + 1, 10), record(T + 1800001, 20)]);
    const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id); const batch = f.store.take(d.id, 200, 1048576)!; const receipt = r.receiver.apply(batch);
    f.store.acknowledge(d.id, { ...receipt, items: receipt.items.slice(0, 1) }, Date.now()); await f.restart(); expect(f.store.take(d.id, 200, 1048576)).toEqual(batch);
    f.store.acknowledge(d.id, r.receiver.apply(batch), Date.now()); expect(f.store.queue(d.id).inflight).toBe(0);
    const conflict = structuredClone(batch); conflict.items[0]!.bucket!.tokens.input_other += 1; conflict.items[0]!.payload_hash = digest({ operation: 'replace', bucket: conflict.items[0]!.bucket }); expect(r.receiver.apply(conflict).items[0]!.status).toBe('conflict');
    await f.write('partial', 'main', [record(T + 1, 30)]); await f.service.scan(true); const older = f.store.take(d.id, 200, 1048576)!; f.store.releaseBatch(d.id, older.batch_id, true);
    await f.write('partial', 'main', [record(T + 1, 40)]); await f.service.scan(true); f.service.retry(d.id); const retried = f.store.take(d.id, 200, 1048576)!;
    expect(new Set(retried.items.map((item) => item.bucket_id)).size).toBe(retried.items.length); expect(retried.items.find((item) => item.bucket !== null)!.bucket!.tokens.input_other).toBe(40);
  });

  it('aborts a real hanging HTTP request and closes within three seconds without deleting its in-flight batch', async () => {
    const f = await fixture(); f.add('hang'); await f.write('hang', 'main', [record(T + 1, 10)]);
    let observed!: () => void; let requests = 0; const received = new Promise<void>((resolve) => { observed = resolve; });
    const server = createServer((req) => { req.resume(); requests++; observed(); }); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing-loopback');
    const d = await destination(f.service, `http://127.0.0.1:${address.port}/usage`, address.port); await enable(f.service, d.id); const flight = f.service.deliver(d.id); await received;
    const before = f.store.take(d.id, 200, 1048576)!; const started = Date.now(); await f.service.close(); await flight; expect(Date.now() - started).toBeLessThan(3000);
    await f.restart(); expect(f.store.take(d.id, 200, 1048576)).toEqual(before);
    observed = () => {}; const probe = f.service.testProtocol(d.id); await vi.waitFor(() => { expect(requests).toBe(2); }); const probeStarted = Date.now(); await f.service.close(); expect((await probe).outcome).toBe('retry'); expect(Date.now() - probeStarted).toBeLessThan(3000);
  });

  it('recovers a real cross-process writer crash with a new fence and the same durable in-flight payload', async () => {
    const f = await fixture(); f.add('process'); await f.write('process', 'main', [record(T + 1, 10)]); const d = await destination(f.service); await enable(f.service, d.id); const batch = f.store.take(d.id, 200, 1048576)!; await f.service.close();
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', "const {UsageExportStore}=await import(process.argv[1]); const s=new UsageExportStore(process.argv[2]); console.log(JSON.stringify({writer:s.writer,fence:s.meta('fence')})); setInterval(()=>s.meta('fence'),1000);", new URL('../src/usage/export/store.ts', import.meta.url).href, join(f.home, 'export.sqlite')], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
    const ready = await new Promise<{ writer: boolean; fence: string }>((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (data: Buffer) => { text += data.toString(); if (text.includes('\n')) { try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); } } });
      child.once('error', reject);
      void closed.then(({ code, signal }) => reject(new Error(`writer-child-exited:${code}:${signal}:${stderr}`)));
    });
    expect(ready.writer).toBe(true); const standby = new UsageExportStore(join(f.home, 'export.sqlite')); cleanup.push(async () => standby.close()); expect(standby.writer).toBe(false); expect(standby.tryPromote()).toBe(false);
    expect(child.kill('SIGKILL')).toBe(true); await closed;
    expect(standby.tryPromote()).toBe(true); expect(standby.meta('fence')).not.toBe(ready.fence); expect(standby.take(d.id, 200, 1048576)).toEqual(batch);
  }, 20000);

  it('arms a real collector marker from saved native credentials, preserves fixed T across offline restart, and rolls back to [T,R)', async () => {
    let now = T; const f = await fixture({}, () => now); f.add('handoff'); await f.write('handoff', 'main', [record(T + 1, 10), record(T + 3600001, 20)]);
    const secret = 'synthetic-native-key'; const endpoint = 'https://example.test/api/usage/ingest';
    const d = await f.service.saveDraft({ draft: { label: 'Native', target: { kind: 'vibe', endpoint }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } }, secret: { value: secret, storage: 'private-file', acknowledge_file_storage: true } });
    let available = true;
    const adapter: UsageExportAdapter = { ...createWebhookUsageAdapter(), kind: 'vibe', capabilities: { absoluteReplace: false, delete: false, perItemAck: false }, maxBatchItems: 1, test: async () => ({ outcome: 'delivered' }), send: async (batch) => available ? { outcome: 'delivered', receipt: { schema_version: 'kiki.usage.receipt.v1', batch_id: batch.batch_id, items: batch.items.map((item) => ({ stream_id: item.stream_id, bucket_id: item.bucket_id, revision: item.revision, payload_hash: item.payload_hash, status: 'applied' })) } } : { outcome: 'retry', errorCategory: 'network' } };
    f.service.registerAdapter(adapter); const plan = await f.service.planHandoff(d.id, T + 3600000); let preview = await f.service.preview(d.id); await expect(f.service.enable(d.id, { preview_fingerprint: preview.preview_fingerprint, acknowledge: true })).rejects.toThrow('handoff-use-arm');
    const home = await canonicalExportHome(f.home); const identity = { apiUrl: 'https://example.test', keyFingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 16), ingest_endpoint: endpoint };
    const entry = { home, cutoff_at: plan.cutoff_at, namespace: plan.namespace, active: false, resume_ranges: [], collector_identity: identity, last_receipt: null as unknown };
    const file = join(f.home, 'kiki-handoff.json'); const document = { schema_version: 'vibe.kiki.handoff.v1', homes: [entry] }; const writeProof = () => f.storage.write('', 'kiki-handoff.json', Buffer.from(JSON.stringify(document)));
    await writeProof(); await expect(f.service.armHandoff(d.id, { collector_file: file, preview_fingerprint: preview.preview_fingerprint, acknowledge: true })).rejects.toThrow('handoff_readiness_unproven'); await f.service.testProtocol(d.id);
    identity.keyFingerprint = '0'.repeat(16); await writeProof(); await expect(f.service.armHandoff(d.id, { collector_file: file, preview_fingerprint: preview.preview_fingerprint, acknowledge: true })).rejects.toThrow('collector-identity-cutoff-unproven'); identity.keyFingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 16); await writeProof();
    expect((await f.service.armHandoff(d.id, { collector_file: file, preview_fingerprint: preview.preview_fingerprint, acknowledge: true })).phase).toBe('armed'); expect(JSON.parse(await readFile(file, 'utf8')).homes[0].active).toBe(true); expect(f.store.queue(d.id).pending).toBe(1);
    const batch = f.store.take(d.id, 1, 1048576)!; f.store.updateWithMetadata(d.id, { enabled: false, next_at: null }, { [`handoff-arm:${d.id}`]: JSON.stringify({ file, fingerprint: preview.preview_fingerprint }) });
    available = false; now = plan.cutoff_at + 1800000; await f.restart(); f.service.registerAdapter(adapter); f.service.start(); await vi.waitFor(() => expect(f.store.get(d.id).enabled).toBe(true)); expect(f.store.get(d.id).scope.start_at).toBe(plan.cutoff_at); expect(f.store.take(d.id, 1, 1048576)).toEqual(batch);
    entry.active = true; entry.last_receipt = { completed_at: now, cutoff_at: plan.cutoff_at, ingested: 1, coverage_complete: true, cutoff_persisted: true, collector_version: 'synthetic-fixture', collector_identity: identity }; await writeProof(); await f.service.refreshHandoff(d.id); available = true; await f.service.deliver(d.id, true); expect(f.service.handoff(d.id)?.phase).toBe('completed');
    const R = now + 3600000;
    await f.write('handoff', 'main', [record(T + 1, 10), record(T + 3600001, 20), record(T + 7200001, 30), record(R, 40)]);
    let markStaged!: () => void; let releasePublication!: () => void;
    const staged = new Promise<void>((resolve) => { markStaged = resolve; });
    const release = new Promise<void>((resolve) => { releasePublication = resolve; });
    const publish = f.store.publishStageAsync.bind(f.store);
    const publication = vi.spyOn(f.store, 'publishStageAsync').mockImplementationOnce(async (...args) => { markStaged(); await release; return publish(...args); });
    const scan = f.service.scan(true); await staged;
    const update = f.store.updateWithMetadataAsync.bind(f.store);
    const rollbackUpdate = vi.spyOn(f.store, 'updateWithMetadataAsync').mockImplementationOnce(async (...args) => { releasePublication(); await Promise.resolve(); return update(...args); });
    try {
      const rollback = await f.service.rollbackHandoff(d.id, R, true); expect(rollback.phase).toBe('rollback-prepared'); expect(f.store.get(d.id).scope).toMatchObject({ start_at: plan.cutoff_at, end_at: R }); expect(JSON.parse(await readFile(file, 'utf8')).homes[0].resume_ranges).toEqual([{ start_at: R, end_at: null }]);
    } finally { releasePublication(); await scan; publication.mockRestore(); rollbackUpdate.mockRestore(); }
    expect(f.service.status().scan_error).toBeNull();
    expect(f.store.ack(d.id, batch.items[0]!.bucket_id)).toEqual({ revision: batch.items[0]!.revision, hash: batch.items[0]!.payload_hash });
    preview = await f.service.preview(d.id); expect(preview.items.map((item) => Date.parse(item.bucket!.start_at))).toEqual([plan.cutoff_at, T + 7200000]);
  });

  it.each([
    { config: false, env: undefined, enabled: false },
    { config: true, env: 'off', enabled: false },
    { config: false, env: 'on', enabled: true },
  ])('migrates Runtime legacy overrides with the old env precedence (%j)', async (choice) => {
    const f = await fixture(); const r = await receiverFixture();
    const d = await destination(f.service, r.endpoint, r.port); await enable(f.service, d.id);
    const before = { ...f.store.get(d.id), next_at: null };
    const home = await mkdtemp(join(tmpdir(), 'kiki-export-upgrade-')); cleanup.push(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
    const saved = new UsageExportStore(join(home, 'usage-export', 'export.sqlite')); saved.save(before); saved.close();
    await writeFile(join(home, 'config.toml'), `[experimental]\nusage_export = ${choice.config}\n`);
    const server = await startServer({ homeDir: home, modelAccountHomeDir: home, userAgentProfileHomeDir: join(home, 'profiles'), userSkillDir: join(home, 'skills'), hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, logLevel: 'silent', env: { KIKI_EXPERIMENTAL_USAGE_EXPORT: choice.env }, seeds: [[IModelPricingService, priced]] });
    cleanup.push(() => server.close());
    const response = await fetch(`http://127.0.0.1:${server.port}/api/usage-export`, { headers: { authorization: `Bearer ${server.localOwnerToken}` } });
    expect(response.status).toBe(200);
    const current = (await response.json()).data.destinations[0].destination;
    expect(current).toEqual(choice.enabled ? before : { ...before, enabled: false, state: 'disabled' });
    expect(r.requests).toBe(0);
  });

  it('registers the Runtime without an experimental flag and keeps the owner gate, including dangerous auth-bypass mode', async () => {
    for (const mode of ['default', 'legacy-off', 'dangerous'] as const) {
      const home = await mkdtemp(join(tmpdir(), 'kiki-export-owner-')); cleanup.push(() => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
      const server = await startServer({ homeDir: home, modelAccountHomeDir: home, userAgentProfileHomeDir: join(home, 'profiles'), userSkillDir: join(home, 'skills'), hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, logLevel: 'silent', disableAuth: mode === 'dangerous', env: mode === 'legacy-off' ? { KIKI_EXPERIMENTAL_USAGE_EXPORT: 'false' } : {}, seeds: [[IModelPricingService, priced]] });
      cleanup.push(() => server.close()); const base = `http://127.0.0.1:${server.port}/api`;
      const headers = { authorization: `Bearer ${server.localOwnerToken}` };
      const owner = await fetch(`${base}/usage-export`, { headers }); expect(owner.status).toBe(200);
      expect((await owner.json()).data).toMatchObject({ writer: true, destinations: [] });
      expect((await (await fetch(`${base}/meta`, { headers })).json()).data.experimental_flags).not.toHaveProperty('usage_export');
      expect((await fetch(`${base}/usage-export`, { headers: { authorization: `Bearer ${server.authTokenService.getToken()}` } })).status).toBe(403);
      expect([401, 403]).toContain((await fetch(`${base}/usage-export`)).status);
      await server.close();
    }
  }, 30000);
});

it.runIf(process.env['KIKI_USAGE_EXPORT_SCALE'] === '1')('measures 500k records in 2000 real wire files with an independent token oracle', async () => {
  const { monitorEventLoopDelay, PerformanceObserver } = await import('node:perf_hooks');
  const { getHeapSpaceStatistics } = await import('node:v8');
  const phases: { phase: string; heap_mib: number; rss_mib: number; spaces: Record<string, number> }[] = [];
  const mark = (phase: string): void => { const usage = process.memoryUsage(); phases.push({ phase, heap_mib: usage.heapUsed / 1048576, rss_mib: usage.rss / 1048576, spaces: Object.fromEntries(getHeapSpaceStatistics().map((space) => [space.space_name, space.space_used_size / 1048576])) }); };
  let gcCount = 0; let gcMs = 0; let gcMaxMs = 0;
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) { gcCount++; gcMs += entry.duration; gcMaxMs = Math.max(gcMaxMs, entry.duration); } });
  const f = await fixture({ cacheMaxBytes: 4 * 1024 * 1024, cacheMaxRecords: 5_000, cacheMaxEntries: 20 });
  let ordinal = 0;
  for (let i = 0; i < 1000; i++) {
    const s = f.add(`scale-${i}`);
    for (const agent of ['main', 'subagent']) {
      const records = Array.from({ length: 250 }, () => record(T + (ordinal++ % 8) * 1_800_000 + 1, 1, { inputCacheRead: 2, inputCacheCreation: 3, output: 4 }));
      await f.write(s.id, agent, records);
    }
  }
  const d = await destination(f.service); const baseline = process.memoryUsage(); let maxHeap = baseline.heapUsed; let maxRss = baseline.rss;
  let publicationMs = 0; const publish = f.store.publishStage.bind(f.store); vi.spyOn(f.store, 'publishStage').mockImplementation((...args) => { const before = performance.now(); publish(...args); publicationMs = Math.max(publicationMs, performance.now() - before); });
  let stageMs = 0; const stage = f.store.stage.bind(f.store); f.store.stage = (...args) => { const before = performance.now(); stage(...args); stageMs = Math.max(stageMs, performance.now() - before); };
  let factReadCalls = 0; const facts = f.core.accessor.get(IUsageFactStore); const readFacts = facts.read.bind(facts);
  facts.read = (...args) => { factReadCalls++; return readFacts(...args); };
  const sample = setInterval(() => { const usage = process.memoryUsage(); maxHeap = Math.max(maxHeap, usage.heapUsed); maxRss = Math.max(maxRss, usage.rss); }, 10);
  mark('baseline'); observer.observe({ entryTypes: ['gc'] });
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable(); const started = performance.now(); let slices = 0;
  do { await f.service.scan(); slices++; mark(`cold-slice-${slices}`); } while (f.service.status().scan_error === 'record_budget' || f.service.status().scan_error === 'deadline');
  const coldMs = performance.now() - started;
  const projectionStarted = performance.now(); const projected = await f.store.previewAsync(d.id, 200); const projectionMs = performance.now() - projectionStarted; expect(projected.total).toBe(8);
  const sums = projected.items.reduce((sum, item) => { const tokens = item.bucket!.tokens; return [sum[0]! + tokens.input_other, sum[1]! + tokens.input_cache_read, sum[2]! + tokens.input_cache_creation, sum[3]! + tokens.output]; }, [0, 0, 0, 0]);
  expect(sums).toEqual([500000, 1000000, 1500000, 2000000]);
  mark('projection');
  const incrementalStarted = performance.now(); await f.service.scan(); const incrementalMs = performance.now() - incrementalStarted;
  mark('unchanged');
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); clearInterval(sample); delay.disable(); observer.disconnect();
  process.stdout.write(JSON.stringify({ benchmark: 'usage-export-500k', records: ordinal, wire_files: 2000, sessions: 1000, slices, cold_ms: coldMs, unchanged_ms: incrementalMs, projection_ms: projectionMs, publication_max_ms: publicationMs, cache_records: f.reader.cacheStatus().records, additional_sampled_heap_mib: (maxHeap - baseline.heapUsed) / 1048576, additional_sampled_rss_mib: (maxRss - baseline.rss) / 1048576, event_loop_delay_max_ms: delay.max / 1e6, platform: process.platform, node: process.version, phases, gc_count: gcCount, gc_ms: gcMs, gc_max_ms: gcMaxMs, unchanged_scan_error: f.service.status().scan_error, stage_max_ms: stageMs, fact_read_calls: factReadCalls }) + '\n');
  expect(f.service.status()).toMatchObject({ scan_complete: true, scan_error: null });
}, 120000);

describe('VibeCafe sign-in → consent → export using a synthetic destination service', () => {
  it('exchanges a device code over HTTP, keeps keys off the client and exports only after consent', async () => {
    let now = T;
    let approved = false;
    const key = 'vbu_SYNTHETIC_FIXTURE_KEY';
    const requests: { path: string; body: unknown; authorization?: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const body = JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')) as { buckets?: unknown[] };
        const path = req.url ?? ''; requests.push({ path, body, authorization: req.headers.authorization });
        res.setHeader('content-type', 'application/json');
        if (path.endsWith('/code')) res.end(JSON.stringify({ deviceCode: 'SYNTHETIC_DEVICE_SECRET', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device?user_code=ABCD-EFGH', expiresIn: 900, interval: 1 }));
        else if (path.endsWith('/poll')) res.end(JSON.stringify(approved ? { apiKey: key, apiUrl: 'https://vibecafe.ai' } : { error: 'authorization_pending' }));
        else if (path.endsWith('/ingest') && req.headers.authorization === `Bearer ${key}`) res.end(JSON.stringify({ ingested: body.buckets?.length ?? 0, sessions: 0 }));
        else { res.statusCode = 401; res.end('{}'); }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('no-fixture-address');
    const origin = `http://127.0.0.1:${address.port}`;
    let stored: string | undefined;
    const keyring: ExportKeyring = async () => ({ setPassword: async (value) => { stored = value; }, getPassword: async () => stored, deleteCredential: async () => { stored = undefined; return true; } });
    const send: VibeAuthRequest = async (path, body, signal) => (await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })).json();
    const f = await fixture({}, () => now, keyring, send); f.add('synthetic-session'); await f.write('synthetic-session', 'main', [record(T + 1, 10)]);
    const adapter = createVibeUsageAdapter();
    const post: Parameters<typeof adapter.send>[1]['post'] = async (request) => {
      const response = await fetch(origin + '/api/usage/ingest', { method: 'POST', headers: { 'content-type': request.contentType, 'content-encoding': request.contentEncoding ?? '', authorization: `Bearer ${stored}` }, body: new Uint8Array(request.body) });
      return { status: response.status, body: await response.text() };
    };
    f.service.registerAdapter({ ...adapter, test: (context) => adapter.test({ ...context, post }), send: (batch, context) => adapter.send(batch, { ...context, post }) });
    const app = Fastify(); registerUsageExportRoutes(app, f.service); await app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => app.close());
    const client = createKlient({ endpoint: app.listeningOrigin }); cleanup.push(() => client.close());
    const api = client.rest!.usageExport;
    const d = await api.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: VIBE_CAFE_INGEST_ENDPOINT }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    const flow = await api.beginVibeAuth(d.id, {});
    expect(JSON.stringify(flow)).not.toContain('SYNTHETIC_DEVICE_SECRET');
    now += 1000; expect((await api.pollVibeAuth(flow.flow_id)).state).toBe('pending');
    approved = true; now += 1000; const connected = await api.pollVibeAuth(flow.flow_id);
    expect(connected.state).toBe('connected'); expect(JSON.stringify(connected)).not.toContain(key); expect(stored).toBe(key);
    expect((await api.status()).destinations[0]!.destination).toMatchObject({ enabled: false, consent_fingerprint: null, credential_storage: 'keyring', state: 'draft' });
    await api.syncNow(d.id); expect(requests.filter((request) => request.path.endsWith('/ingest'))).toHaveLength(0);
    const preview = await api.preview(d.id); expect(preview.total_buckets).toBe(1);
    expect(JSON.stringify(preview)).not.toContain(key); expect(JSON.stringify(preview.items)).not.toContain(SENTINEL);
    expect(requests.filter((request) => request.path.endsWith('/ingest'))).toHaveLength(0);
    await api.enable(d.id, { preview_fingerprint: preview.preview_fingerprint, acknowledge: true }); await api.syncNow(d.id);
    const ingest = requests.filter((request) => request.path.endsWith('/ingest')); expect(ingest).toHaveLength(1);
    expect(ingest[0]!.body).toMatchObject({ buckets: [{ source: 'kiki', inputTokens: 15, cachedInputTokens: 4, outputTokens: 3 }] });
    expect(JSON.stringify(ingest[0]!.body)).not.toContain(SENTINEL);
    expect(f.store.queue(d.id).pending).toBe(0);
    const custom = await api.saveDraft({ draft: { label: 'Custom', target: { kind: 'vibe', endpoint: 'https://custom.example.test/api/usage/ingest' }, scope: d.scope, schedule_minutes: 0 } });
    await expect(api.beginVibeAuth(custom.id, { storage: 'keyring' })).rejects.toThrow('vibe-auth-official-only');
  });

  it('stores the Kiki mapping on a new ACK and does not repost a pre-migration kimi-code ACK or a later window as kimi-code', async () => {
    const posts: unknown[] = [];
    const f = await fixture();
    f.add('synthetic-kiki-identity');
    await f.write('synthetic-kiki-identity', 'main', [record(T + 1, 10)]);
    const d = await f.service.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: 'https://example.test/api/usage/ingest' }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    const adapter = createVibeUsageAdapter();
    const post: Parameters<typeof adapter.send>[1]['post'] = async (request) => {
      posts.push(JSON.parse(gunzipSync(request.body).toString('utf8')));
      return { status: 200, body: JSON.stringify({ ingested: 1, sessions: 0 }) };
    };
    f.service.registerAdapter({ ...adapter, send: (batch, context) => adapter.send(batch, { ...context, post }) });
    await enable(f.service, d.id);
    await f.service.syncNow(d.id);
    expect(posts).toEqual([{ buckets: [expect.objectContaining({ source: 'kiki', inputTokens: 15, cachedInputTokens: 4, outputTokens: 3 })] }]);
    const db = new DatabaseSync(join(f.home, 'export.sqlite'));
    try {
      expect(db.prepare('SELECT mapping_version FROM acknowledgements').get()).toEqual({ mapping_version: VIBE_MAPPING_VERSION });
      db.prepare('UPDATE acknowledgements SET mapping_version=NULL').run();
    } finally { db.close(); }
    await f.write('synthetic-kiki-identity', 'main', [record(T + 1, 10), record(T + 2, 10), record(T + 1_800_000 + 1, 8)]);
    await f.service.syncNow(d.id);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ buckets: [expect.objectContaining({ source: 'kiki', inputTokens: 13, cachedInputTokens: 4, outputTokens: 3 })] });
    expect(JSON.stringify(posts)).not.toContain('kimi-code');
    expect(JSON.stringify(posts)).not.toContain(SENTINEL);
    expect(f.store.get(d.id).state).toBe('remote-diverged');
    expect(f.store.queue(d.id).quarantined).toBe(1);
    expect(f.store.queue(d.id).pending).toBe(0);
  });

  it.each([
    { usageKnown: true, cached: 0, category: 'vibe_zero_bucket_unsupported' },
    { usageKnown: false, cached: 0, category: 'vibe_usage_unknown' },
    { usageKnown: undefined, cached: 0, category: 'vibe_usage_unknown' },
    { usageKnown: true, cached: 9, category: 'cached_only_unsupported' },
  ])('retains $category locally across retry/restart, delivers healthy buckets once and recovers a corrected revision', async ({ usageKnown, cached, category }) => {
    const f = await fixture(); f.add('zero-recovery');
    const zero = { ...record(T + 1, 0, { output: 0, inputCacheRead: cached, inputCacheCreation: 0 }), usageKnown };
    const healthy = record(T + 1_800_001, 7);
    await f.write('zero-recovery', 'main', [zero, healthy]);
    let ingested = 1; const posted: UsageExportBatch[] = []; const adapter = createVibeUsageAdapter();
    const register = () => { f.service.registerAdapter({ ...adapter, send: async (batch, context) => adapter.send(batch, { ...context, post: async () => { posted.push(structuredClone(batch)); return { status: 200, body: JSON.stringify({ ingested, sessions: 0 }) }; } }) }); };
    register();
    const d = await f.service.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: 'https://example.test/api/usage/ingest' }, schedule_minutes: 120, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    const preview = await enable(f.service, d.id);
    const retained = preview.items.find((item) => Date.parse(item.bucket!.start_at) === T)!;
    await f.service.syncNow(d.id);
    expect(f.store.get(d.id)).toMatchObject({ state: 'quarantined', error_category: category, enabled: true, schedule_minutes: 120 });
    expect(f.store.exportQueue(d.id)).toEqual([retained]); expect(f.store.ack(d.id, retained.bucket_id)).toBeUndefined();
    expect(posted).toHaveLength(1); const healthyAck = posted[0]!.items[0]!;
    expect(f.store.ack(d.id, healthyAck.bucket_id)?.revision).toBe(1);
    await f.restart(); register(); f.service.retry(d.id); await f.service.syncNow(d.id);
    expect(posted).toHaveLength(1); expect(f.store.exportQueue(d.id)).toEqual([retained]);
    expect(f.store.get(d.id)).toMatchObject({ state: 'quarantined', error_category: category });
    await f.write('zero-recovery', 'main', [record(T + 1, 5), healthy]);
    ingested = 0; await f.service.syncNow(d.id);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.items).toEqual([expect.objectContaining({ bucket_id: retained.bucket_id, revision: 2 })]);
    expect(f.store.exportQueue(d.id)).toContainEqual(retained); expect(f.store.ack(d.id, retained.bucket_id)).toBeUndefined();
    ingested = 1; await f.service.deliver(d.id, true);
    expect(posted[2]).toEqual(posted[1]); expect(f.store.ack(d.id, retained.bucket_id)?.revision).toBe(2);
    expect(f.store.ack(d.id, healthyAck.bucket_id)?.revision).toBe(1);
    expect(f.store.exportQueue(d.id)).toEqual([]); expect(f.store.get(d.id)).toMatchObject({ state: 'ready', error_category: null });
    f.service.retry(d.id); await f.service.syncNow(d.id); expect(posted).toHaveLength(3);
  });

  it('keeps a malformed Vibe receipt retryable and reuses its original batch until a real compatible receipt arrives', async () => {
    const f = await fixture(); f.add('vibe-response'); await f.write('vibe-response', 'main', [record(T + 1, 10)]);
    let body = '{"success":true}'; const posted: UsageExportBatch[] = []; const adapter = createVibeUsageAdapter();
    f.service.registerAdapter({ ...adapter, send: (batch, context) => { posted.push(structuredClone(batch)); return adapter.send(batch, { ...context, post: async () => ({ status: 200, body }) }); } });
    const d = await f.service.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: 'https://example.test/api/usage/ingest' }, schedule_minutes: 120, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    await enable(f.service, d.id); await f.service.syncNow(d.id);
    expect(f.store.get(d.id)).toMatchObject({ state: 'retrying', error_category: 'invalid_protocol', last_success_at: null });
    const original = posted[0]!;
    expect(f.store.ack(d.id, original.items[0]!.bucket_id)).toBeUndefined(); expect(f.store.queue(d.id).inflight).toBe(1);
    body = '{"ingested":1,"sessions":0}'; await f.service.syncNow(d.id);
    expect(posted).toEqual([original, original]); expect(f.store.ack(d.id, original.items[0]!.bucket_id)?.revision).toBe(1);
    await f.service.syncNow(d.id); expect(posted).toHaveLength(2); expect(f.store.exportQueue(d.id)).toEqual([]);
  });

  it.each(['keyring', 'private-file'] as const)('automatically persists to %s, cold-restores and sends the recovered bearer only after consent', async (expectedStorage) => {
    let now = T;
    const key = 'vbu_SYNTHETIC_COLD_KEY';
    const keys = new Map<string, string>();
    const factory: ExportKeyring = async (account) => ({
      setPassword: async (value) => { if (expectedStorage === 'private-file') throw new Error('fixture-keyring-write-failed'); keys.set(account, value); },
      getPassword: async () => keys.get(account), deleteCredential: async () => keys.delete(account),
    });
    const send: VibeAuthRequest = async (path) => path.endsWith('/code') ? { deviceCode: 'FIXTURE_DEVICE', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device?user_code=ABCD-EFGH', interval: 1 } : { apiKey: key };
    const f = await fixture({}, () => now, factory, send);
    f.add('synthetic-cold'); await f.write('synthetic-cold', 'main', [record(T + 1, 10)]);
    const d = await f.service.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: VIBE_CAFE_INGEST_ENDPOINT }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } } });
    if (expectedStorage === 'private-file') {
      const failed = await f.service.vibeAuth.begin(d.id, { storage: 'keyring' }); now += 1000;
      expect(await f.service.vibeAuth.poll(failed.flow_id)).toMatchObject({ state: 'error', error_category: 'vibe-auth-storage-failed' });
      expect(f.store.get(d.id).credential_storage).toBe('none');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const flow = await f.service.vibeAuth.begin(d.id, {}); now += 1000;
      expect(await f.service.vibeAuth.poll(flow.flow_id)).toMatchObject({ state: 'connected', error_category: null });
    }
    expect(f.store.get(d.id)).toMatchObject({ credential_storage: expectedStorage, enabled: false, consent_fingerprint: null, state: 'draft' });
    await f.restart();
    const restored = f.store.get(d.id);
    const cold = new UsageExportSecretStore(f.home, f.store.installationKey(), factory);
    expect(await cold.read(d.id, restored.credential_storage)).toBe(key);
    const privatePath = join(f.home, 'credentials/usage-export', `${d.id}.secret`);
    if (expectedStorage === 'private-file') {
      expect(await readFile(privatePath, 'utf8')).toBe(key);
      if (process.platform !== 'win32') expect((await stat(privatePath)).mode & 0o077).toBe(0);
      else {
        const { stdout } = await promisify(execFile)('icacls', [privatePath], { windowsHide: true });
        expect(stdout).toContain('(F)'); expect(stdout).not.toContain('(I)');
      }
    } else await expect(stat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const observed: string[] = [];
    const sink = createServer((req, res) => {
      observed.push(req.headers.authorization ?? '');
      req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ingested: 1, sessions: 0 })); });
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>((resolve) => sink.close(() => resolve())));
    const address = sink.address(); if (address === null || typeof address === 'string') throw new Error('fixture-loopback-missing');
    const adapter = createVibeUsageAdapter();
    const post: Parameters<typeof adapter.send>[1]['post'] = async (request) => {
      const destination = f.store.get(d.id);
      const secret = await cold.read(d.id, destination.credential_storage);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/usage/ingest`, { method: 'POST', headers: { 'content-type': request.contentType, 'content-encoding': request.contentEncoding ?? '', authorization: `Bearer ${secret}` }, body: new Uint8Array(request.body) });
      return { status: response.status, body: await response.text() };
    };
    f.service.registerAdapter({ ...adapter, send: (batch, context) => adapter.send(batch, { ...context, post }) });
    await f.service.syncNow(d.id); expect(observed).toEqual([]);
    const preview = await enable(f.service, d.id);
    expect(JSON.stringify(preview)).not.toContain(key);
    await f.service.syncNow(d.id); expect(observed).toEqual([`Bearer ${key}`]);
    f.service.disable(d.id); await f.restart(true);
    expect(f.store.get(d.id).enabled).toBe(false);
    await f.service.remove(d.id, true);
    await expect(stat(privatePath)).rejects.toMatchObject({ code: 'ENOENT' }); expect(keys.size).toBe(0);
  });

  it('does not claim connected when both stores fail, preserves the old credential and retries after repair', async () => {
    let now = T;
    let unavailable = false;
    let stored: string | undefined;
    const factory: ExportKeyring = async () => ({ setPassword: async (value) => { if (unavailable) throw new Error('fixture-keyring-unavailable'); stored = value; }, getPassword: async () => stored, deleteCredential: async () => { if (unavailable) throw new Error('fixture-keyring-unavailable'); stored = undefined; return true; } });
    let key = 'vbu_SYNTHETIC_OLD_KEY';
    const send: VibeAuthRequest = async (path) => path.endsWith('/code') ? { deviceCode: 'FIXTURE_DEVICE', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device', interval: 1 } : { apiKey: key };
    const f = await fixture({}, () => now, factory, send);
    const d = await f.service.saveDraft({ draft: { label: 'VibeCafe', target: { kind: 'vibe', endpoint: VIBE_CAFE_INGEST_ENDPOINT }, schedule_minutes: 0, scope: { start_at: T, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] } }, secret: { value: key, storage: 'keyring' } });
    unavailable = true; key = 'vbu_SYNTHETIC_NEW_KEY';
    const blocked = join(f.home, 'credentials'); await writeFile(blocked, 'fixture-file-blocks-directory');
    const failed = await f.service.vibeAuth.begin(d.id, {}); now += 1000;
    expect(await f.service.vibeAuth.poll(failed.flow_id)).toMatchObject({ state: 'error', error_category: 'vibe-auth-storage-failed' });
    expect(f.store.get(d.id)).toEqual(d); expect(stored).toBe('vbu_SYNTHETIC_OLD_KEY');
    await rm(blocked);
    const retry = await f.service.vibeAuth.begin(d.id, {}); now += 1000;
    expect((await f.service.vibeAuth.poll(retry.flow_id)).state).toBe('connected');
    expect(f.store.get(d.id).credential_storage).toBe('private-file');
    expect(f.store.meta(`credential-cleanup:${d.id}`)).toBe('keyring');
    await f.restart();
    const cold = new UsageExportSecretStore(f.home, f.store.installationKey(), factory);
    expect(await cold.read(d.id, f.store.get(d.id).credential_storage)).toBe(key);
    unavailable = false; f.service.start(); await f.service.close();
    expect(stored).toBeUndefined();
    await f.restart(); expect(f.store.meta(`credential-cleanup:${d.id}`)).toBe('');
    const recovered = await f.service.vibeAuth.begin(d.id, {}); now += 1000;
    expect((await f.service.vibeAuth.poll(recovered.flow_id)).state).toBe('connected');
    expect(f.store.get(d.id).credential_storage).toBe('keyring'); expect(stored).toBe(key);
    await expect(stat(join(f.home, 'credentials/usage-export', `${d.id}.secret`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('explicit billing name', () => {
  const rates = {
    gpt: { input: 1e-6, output: 2e-6, read: 1e-7, write: 1.25e-6 },
    spec: { input: 3e-6, output: 4e-6, read: 3e-7, write: 3.75e-6 },
    upstream: { input: 9e-6, output: 8e-6, read: 9e-7, write: 1.125e-5 },
  };
  const tokens = { inputOther: 10, output: 3, inputCacheRead: 4, inputCacheCreation: 5 };
  const costOf = (rate: { input: number; output: number; read: number; write: number }) =>
    tokens.inputOther * rate.input + tokens.output * rate.output + tokens.inputCacheRead * rate.read + tokens.inputCacheCreation * rate.write;
  const price = (rate: { input: number; output: number; read: number; write: number }) => ({
    input_cost_per_token: rate.input, output_cost_per_token: rate.output,
    cache_read_input_token_cost: rate.read, cache_creation_input_token_cost: rate.write,
  });

  it('prices and names history from the configured billing name, then restores inference', async () => {
    const pricingHome = await mkdtemp(join(tmpdir(), 'kiki-billing-name-'));
    cleanup.push(() => rm(pricingHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
    await writeFile(join(pricingHome, 'prices.json'), JSON.stringify({
      'gpt-5': price(rates.gpt), 'claude-sonnet-4-5': price(rates.gpt),
      'billing-spec-argon': price(rates.spec), 'private-upstream': price(rates.upstream),
    }));
    const models: Record<string, ModelRecord> = { 'my-argon': { provider: 'proxy', model: 'wire-remote-argon' } };
    const pricing = new ModelPricingService(
      { homeDir: pricingHome } as unknown as Bootstrap,
      stubLog(),
      new TomlAtomicDocumentStore(new FileStorageService(pricingHome)),
      { ready: Promise.resolve(), get: () => models } as unknown as IConfigService,
      { scheduleRefresh: false, minimumKeys: 1, vendoredPath: join(pricingHome, 'prices.json') },
    );
    cleanup.push(async () => { pricing.dispose(); await drainModelPricingDisposals(); });
    await pricing.ready;
    const f = await fixture({}, undefined, undefined, undefined, undefined, pricing);
    const usage = { output: tokens.output, inputCacheRead: tokens.inputCacheRead, inputCacheCreation: tokens.inputCacheCreation };
    f.add('argon'); f.add('stable');
    await f.write('argon', 'main', [{ ...record(T + 1, tokens.inputOther, usage, 'my-argon'), modelAlias: 'my-argon', upstreamModelId: 'private-upstream' }]);
    await f.write('stable', 'main', [{ ...record(T + 2, tokens.inputOther, usage, 'gpt-5'), modelAlias: 'gpt-5' }]);
    const wireSize = async (session: string) => (await stat(join(f.home, 'sessions/work', session, 'agents/main', AGENT_WIRE_RECORD_KEY))).size;
    const wires = [await wireSize('argon'), await wireSize('stable')];
    const d = await destination(f.service);
    await enable(f.service, d.id);
    const projected = () => f.store.preview(d.id);
    const named = (model: string) => projected().items.find((item) => item.bucket?.model === model);
    const summed = () => {
      const total = emptyTokens();
      for (const item of projected().items) if (item.bucket !== null) addTokens(total, item.bucket.tokens);
      return total;
    };
    const expectedTokens = { input_other: 20, output: 6, input_cache_read: 8, input_cache_creation: 10 };
    const stableIdentity = () => {
      const item = named('gpt-5');
      return { revision: item?.revision, hash: item?.payload_hash, tokens: item?.bucket?.tokens, cost: item?.bucket?.cost.usd_estimated };
    };
    expect(normalizePublicModel('billing-spec-argon')).toBeUndefined();
    expect(normalizePublicModel('gpt-5')).toBe('gpt-5');
    expect(pricing.billingName('private-upstream')).toBeUndefined();
    const inferred = projected().items.find((item) => item.bucket?.model.startsWith('custom-'));
    expect(inferred?.bucket).toMatchObject({ mapping_version: 'kiki-public-model-v1', quality: { mapping_unknown: true, price_unknown: false } });
    expect(inferred?.bucket?.cost.usd_estimated).toBeCloseTo(costOf(rates.upstream), 12);
    const inferredId = inferred?.bucket?.model;
    const stable = stableIdentity();
    expect(summed()).toEqual(expectedTokens);
    expect(projected().total).toBe(2);
    expect(f.store.meta('pricing-revision')).toBe(pricing.pricingRevision());
    const before = await f.reader.query({ dimension: 'model', page_size: 1 });
    expect(before.summary.tokens).toEqual(expectedTokens);
    expect(before.summary.cost_unknown).toBe(true);
    expect(before.summary.cost_usd_estimated).toBeCloseTo(costOf(rates.gpt), 12);
    expect(before.reliability.unknown_price_models).toContain('my-argon');
    const groups = before.trend.flatMap((bucket) => bucket.groups.map((group) => group.key));
    expect(groups).toEqual(expect.arrayContaining(['my-argon', 'gpt-5']));
    expect(groups).not.toContain('billing-spec-argon');
    const firstToken = before.sessions.next_page_token;
    expect(firstToken).toEqual(expect.any(String));
    const firstPage = JSON.parse(Buffer.from(firstToken ?? '', 'base64url').toString('utf8')) as { p?: string };

    models['my-argon'] = { provider: 'proxy', model: 'wire-remote-argon', pricingModel: 'billing-spec-argon' };
    await f.service.scan();
    expect([await wireSize('argon'), await wireSize('stable')]).toEqual(wires);
    const spec = named('billing-spec-argon');
    expect(spec?.bucket).toMatchObject({ model: 'billing-spec-argon', quality: { mapping_unknown: false, price_unknown: false } });
    expect(spec?.bucket?.cost.usd_estimated).toBeCloseTo(costOf(rates.spec), 12);
    expect(spec?.bucket?.cost.usd_estimated).not.toBeCloseTo(costOf(rates.upstream), 12);
    expect(stableIdentity()).toEqual(stable);
    expect(summed()).toEqual(expectedTokens);
    expect(projected().total).toBe(2);
    expect(f.store.meta('pricing-revision')).toBe(pricing.pricingRevision());
    expect(pricing.billingName('my-argon')).toBe('billing-spec-argon');
    expect(pricing.billingName('private-upstream')).toBeUndefined();
    const pricedUsage = await f.reader.query({ dimension: 'model', page_size: 1 });
    expect(pricedUsage.summary.tokens).toEqual(expectedTokens);
    expect(pricedUsage.summary.cost_unknown).toBe(false);
    expect(pricedUsage.summary.cost_usd_estimated).toBeCloseTo(costOf(rates.spec) + costOf(rates.gpt), 12);
    expect(pricedUsage.reliability.unknown_price_models).not.toContain('my-argon');
    expect(pricedUsage.reliability.unknown_price_models).not.toContain('billing-spec-argon');
    const pricedGroups = pricedUsage.trend.flatMap((bucket) => bucket.groups.map((group) => group.key));
    expect(pricedGroups).toEqual(expect.arrayContaining(['my-argon', 'gpt-5']));
    expect(pricedGroups).not.toContain('billing-spec-argon');
    const nextToken = pricedUsage.sessions.next_page_token;
    const nextPage = JSON.parse(Buffer.from(nextToken ?? '', 'base64url').toString('utf8')) as { p?: string };
    expect(nextPage.p).not.toBe(firstPage.p);
    await expect(f.reader.query({ dimension: 'model', page_size: 1, page_token: firstToken ?? '' })).rejects.toBeInstanceOf(UsagePageTokenMismatchError);

    delete models['my-argon']!.pricingModel;
    await f.service.scan();
    expect(named('billing-spec-argon')).toBeUndefined();
    expect(named(inferredId ?? '')?.bucket?.cost.usd_estimated).toBeCloseTo(costOf(rates.upstream), 12);
    expect(stableIdentity()).toEqual(stable);
    expect(summed()).toEqual(expectedTokens);

    models['my-argon'] = { provider: 'proxy', model: 'wire-remote-argon', pricingModel: 'billing-spec-argon' };
    await f.service.scan();
    await f.restart();
    expect(f.store.preview(d.id).items.some((item) => item.bucket?.model === 'billing-spec-argon')).toBe(true);
    expect(summed()).toEqual(expectedTokens);

    models['my-argon'] = { provider: 'proxy', model: 'wire-remote-argon', pricingModel: 'bad name' };
    await f.service.scan();
    expect(projected().items.map((item) => item.bucket?.model)).not.toContain('bad name');
    expect(named(inferredId ?? '')?.bucket?.quality.price_unknown).toBe(true);
    const longName = `billing-spec-${'a'.repeat(108)}`;
    models['my-argon'] = { provider: 'proxy', model: 'wire-remote-argon', pricingModel: longName };
    await f.service.scan();
    expect(longName.length).toBeGreaterThan(100);
    expect(longName.length).toBeLessThanOrEqual(160);
    expect(normalizePublicModel(longName)).toBeUndefined();
    expect(named(longName)?.bucket?.model).toBe(longName);
    const tooLong = 'b'.repeat(161);
    models['my-argon'] = { provider: 'proxy', model: 'wire-remote-argon', pricingModel: tooLong };
    await f.service.scan();
    expect(projected().items.map((item) => item.bucket?.model)).not.toContain(tooLong);
    expect(named(inferredId ?? '')).toBeDefined();

    delete models['my-argon'];
    await f.service.scan();
    expect(Object.keys(models)).toEqual([]);
    expect(named('billing-spec-argon')).toBeUndefined();
    expect(named(inferredId ?? '')?.bucket?.cost.usd_estimated).toBeCloseTo(costOf(rates.upstream), 12);
    expect(summed()).toEqual(expectedTokens);
    expect(stableIdentity()).toEqual(stable);
    const removed = await f.reader.query({ dimension: 'model', page_size: 1 });
    expect(removed.summary.tokens).toEqual(expectedTokens);
    expect(removed.reliability.unknown_price_models).toContain('my-argon');
    expect(removed.trend.flatMap((bucket) => bucket.groups.map((group) => group.key))).not.toContain('billing-spec-argon');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IModelPricingService } from '../src/pricing/modelPricingService';
import { projectSource } from '../src/usage/export/projection';
import { UsageExportStore } from '../src/usage/export/store';
import { gunzipSync } from 'node:zlib';

import { VIBE_CAFE_INGEST_ENDPOINT, type UsageExportBatch, type UsageExportScope, type UsageExportDestination } from '@kiki/protocol';
import { VibeCafeDeviceAuth, type VibeAuthRequest } from '../src/usage/export/vibeAuth';
import { describe, expect, it, vi } from 'vitest';

import type { UsageExportAdapterContext } from '../src/usage/export/adapter';
import { armUsageExportHandoff, confirmNativeHandoff, nativeHandoffScope, planUsageExportHandoff, planUsageExportRollback, recordLegacyHandoffReceipt, usageExportHandoffSchema } from '../src/usage/export/migration';
import { createScriptUsageAdapter } from '../src/usage/export/script';
import { createVibeUsageAdapter, mapVibeUsageBatch, parseVibeUsageReceipt, vibeUsagePayloadSchema } from '../src/usage/export/vibe';

const stream = 'a'.repeat(32);
const hash = 'a'.repeat(64);
const cutoff = Date.parse('2026-10-03T12:00:00Z');
function batch(): UsageExportBatch {
  return { schema_version: 'kiki.usage.batch.v1', batch_id: 'batch-00000000001', items: [{
    schema_version: 'kiki.usage.bucket.v1', stream_id: stream, bucket_id: 'bucket-000000001', revision: 1, payload_hash: hash, operation: 'replace',
    bucket: { start_at: new Date(cutoff).toISOString(), end_at: new Date(cutoff + 1_800_000).toISOString(), source: 'kiki', model: 'Qwen/Qwen3.8-Flash', mapping_version: 'kiki-public-model-v1',
      tokens: { input_other: 100, input_cache_read: 900, input_cache_creation: 20, output: 50 },
      quality: { known_records: 1, missing_records: 0, legacy_zero_records: 0, invalid_records: 0, estimated_records: 0, mapping_unknown: false, price_unknown: true, complete: true },
      cost: { currency: 'USD', source: 'kiki-local-estimate', pricing_version: hash, usd_estimated: null },
    },
  }] };
}
function vibeContext(body: unknown, status = 200): UsageExportAdapterContext {
  return { target: { kind: 'vibe', endpoint: 'https://example.test/api/usage/ingest' }, signal: new AbortController().signal,
    post: vi.fn(async () => ({ status, body: JSON.stringify(body) })),
  };
}
const scriptPath = fileURLToPath(new URL('./fixtures/usage-export-script.mjs', import.meta.url));
function scriptContext(mode = 'success', timeout_ms = 5000, signal = new AbortController().signal): UsageExportAdapterContext {
  return { target: { kind: 'script', command: `"${process.execPath}" "${scriptPath}" ${mode}`, timeout_ms, output_limit_bytes: 4096 }, signal, post: vi.fn(async () => { throw new Error('No HTTP from script adapter'); }) };
}

describe('vibe bucket adapter', () => {
  it('preserves four-counter mapped total, opaque namespace and known slash model without TTL/cost/content', async () => {
    const payload = mapVibeUsageBatch(batch());
    expect(payload.buckets[0]).toEqual({ source: 'kimi-code', model: 'Qwen/Qwen3.8-Flash', project: 'unknown', hostname: `kiki-${stream}`, bucketStart: new Date(cutoff).toISOString(), inputTokens: 120, cachedInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, totalTokens: 170 });
    expect(payload.buckets[0]!.totalTokens + payload.buckets[0]!.cachedInputTokens).toBe(1070);
    const context = vibeContext({ ingested: 1, sessions: 0 });
    const result = await createVibeUsageAdapter().send(batch(), context);
    expect(result.outcome).toBe('delivered');
    expect(result.receipt?.items[0]?.payload_hash).toBe(hash);
    const request = vi.mocked(context.post).mock.calls[0]![0];
    expect(request.contentEncoding).toBe('gzip');
    const decoded = JSON.parse(gunzipSync(request.body).toString('utf8'));
    expect(vibeUsagePayloadSchema.parse(decoded)).toEqual(payload);
    expect(Object.keys(decoded)).toEqual(['buckets']);
    expect(JSON.stringify(decoded)).not.toMatch(/sessions|cost|prompt|PRIVATE|real-host|cwd|duration/);
  });
  it('rejects content sentinels, cached-only, deletion, incomplete and oversized model without posting', async () => {
    const cases = [
      (b: UsageExportBatch) => Object.assign(b.items[0]!.bucket!, { prompt: 'PRIVATE_PROMPT_SENTINEL', cwd: 'PRIVATE_PATH_SENTINEL', title: 'PRIVATE_TITLE_SENTINEL', hostname: 'PRIVATE_HOST_SENTINEL' }),
      (b: UsageExportBatch) => Object.assign(b.items[0]!.bucket!.tokens, { input_other: 0, input_cache_creation: 0, output: 0 }),
      (b: UsageExportBatch) => Object.assign(b.items[0]!, { operation: 'delete', bucket: null }),
      (b: UsageExportBatch) => { b.items[0]!.bucket!.quality.complete = false; },
      (b: UsageExportBatch) => { b.items[0]!.bucket!.model = 'a'.repeat(101); },
    ];
    for (const change of cases) {
      const b = batch(); change(b);
      const context = vibeContext({ ingested: 1 });
      const result = await createVibeUsageAdapter().send(b, context);
      expect(result.outcome).toBe('invalid');
      expect(context.post).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    }
    const cached = batch(); cached.items[0]!.bucket!.tokens = { input_other: 0, input_cache_read: 9, input_cache_creation: 0, output: 0 };
    expect(await createVibeUsageAdapter().send(cached, vibeContext({ ingested: 1 }))).toEqual({ outcome: 'invalid', errorCategory: 'cached_only_unsupported' });
  });
  it('preflights persisted ACK mapped reductions/key changes with zero POST, not local quality/price-only changes', async () => {
    const previousAcknowledged = batch().items;
    for (const change of [
      (b: UsageExportBatch) => { b.items[0]!.bucket!.tokens.input_other--; },
      (b: UsageExportBatch) => { b.items[0]!.bucket!.tokens.input_cache_read--; },
      (b: UsageExportBatch) => { b.items[0]!.bucket!.tokens.output--; },
      (b: UsageExportBatch) => { b.items[0]!.bucket!.model = 'gpt-6.1-sol'; },
      (b: UsageExportBatch) => { b.items[0]!.bucket!.tokens = { input_other: 0, input_cache_read: 900, input_cache_creation: 0, output: 0 }; },
    ]) {
      const next = batch(); change(next);
      const context = Object.assign(vibeContext({ ingested: 1 }), { previousAcknowledged });
      expect(await createVibeUsageAdapter().send(next, context)).toEqual({ outcome: 'remote-diverged', errorCategory: 'remote_diverged' });
      expect(context.post).not.toHaveBeenCalled();
    }
    const next = batch();
    next.items[0]!.revision++;
    next.items[0]!.payload_hash = 'b'.repeat(64);
    next.items[0]!.bucket!.quality.known_records++;
    next.items[0]!.bucket!.cost.pricing_version = 'b'.repeat(64);
    next.items[0]!.bucket!.tokens.input_other += 10;
    next.items[0]!.bucket!.tokens.input_cache_creation -= 10;
    const context = Object.assign(vibeContext({ ingested: 1 }), { previousAcknowledged });
    expect((await createVibeUsageAdapter().send(next, context)).outcome).toBe('delivered');
    expect(context.post).toHaveBeenCalledTimes(1);
    const body = gunzipSync(vi.mocked(context.post).mock.calls[0]![0].body).toString();
    expect(body).not.toContain('previousAcknowledged');
    expect(JSON.parse(body).buckets[0].inputTokens).toBe(120);
  });
  it.each([
    [{ ingested: 0 }, 'retry', 'vibe_partial_receipt'],
    [{ ingested: 1, protected: { buckets: 1 } }, 'remote-diverged', 'vibe_protected'],
    [{ ingested: 0, dropped: { buckets: 1, unknownSources: ['unknown'] } }, 'invalid', 'vibe_unknown_source'],
    [{ ingested: 0, dropped: { buckets: 1, unknownModels: 1 } }, 'invalid', 'vibe_unknown_model'],
    [{ ingested: 0, dropped: { buckets: 1, implausible: 1 } }, 'invalid', 'vibe_implausible'],
    [{ ingested: 1, arbitrary: 'PRIVATE_REMOTE_SENTINEL' }, 'retry', 'invalid_protocol'],
    [{ success: true }, 'retry', 'invalid_protocol'],
  ])('HTTP200 with %j is not a complete ACK', async (body, outcome, errorCategory) => {
    const result = await createVibeUsageAdapter().send(batch(), vibeContext(body));
    expect(result).toEqual({ outcome, errorCategory });
    expect(result.receipt).toBeUndefined();
  });
  it('uses an empty gzip test, advertises limitations, and handles HTTP categories', async () => {
    const adapter = createVibeUsageAdapter();
    expect(adapter.capabilities).toEqual({ absoluteReplace: false, delete: false, perItemAck: false });
    expect(adapter.maxBatchItems).toBe(1);
    const context = vibeContext({ ingested: 0, sessions: 0 });
    expect(await adapter.test(context)).toEqual({ outcome: 'delivered' });
    expect(JSON.parse(gunzipSync(vi.mocked(context.post).mock.calls[0]![0].body).toString())).toEqual({ buckets: [] });
    expect((await adapter.send(batch(), vibeContext({}, 401))).outcome).toBe('needs-auth');
    expect((await adapter.send(batch(), vibeContext({}, 413))).outcome).toBe('too-large');
    expect(parseVibeUsageReceipt('not json', 1)).toEqual({ outcome: 'retry', errorCategory: 'invalid_protocol' });
  });
});

describe('explicit full-permission script adapter', () => {
  it('runs the approved shell command with strict batch stdin and receipt stdout, plus separate test protocol', async () => {
    const adapter = createScriptUsageAdapter();
    const context = scriptContext();
    expect(await adapter.test(context)).toEqual({ outcome: 'delivered' });
    const result = await adapter.send(batch(), context);
    expect(result.outcome).toBe('delivered');
    expect(result.receipt?.items[0]).toEqual({ stream_id: stream, bucket_id: 'bucket-000000001', revision: 1, payload_hash: hash, status: 'applied' });
    const deletion = batch(); deletion.items[0]!.operation = 'delete'; deletion.items[0]!.bucket = null;
    expect((await adapter.send(deletion, context)).outcome).toBe('delivered');
    expect(context.post).not.toHaveBeenCalled();
  });
  it.each([
    ['partial', 'retry', 'partial_receipt'], ['duplicate', 'retry', 'script_protocol_error'],
    ['identity', 'retry', 'script_protocol_error'], ['conflict', 'remote-diverged', 'remote_diverged'],
    ['stale', 'remote-diverged', 'remote_diverged'], ['invalid', 'retry', 'script_invalid_receipt'],
    ['nonzero', 'retry', 'script_nonzero_exit'], ['large', 'retry', 'script_output_limit'], ['large-stderr', 'retry', 'script_output_limit'],
  ])('recovers %s without invented ACK or arbitrary output logs', async (mode, outcome, errorCategory) => {
    const result = await createScriptUsageAdapter().send(batch(), scriptContext(mode));
    expect(result.outcome).toBe(outcome);
    expect(result.errorCategory).toBe(errorCategory);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    if (outcome === 'retry') expect(result.receipt).toBeUndefined();
  });
  it('times out, cancels live and pre-aborted commands, rejects content before spawning', async () => {
    const adapter = createScriptUsageAdapter();
    expect(await adapter.send(batch(), scriptContext('wait', 100))).toEqual({ outcome: 'retry', errorCategory: 'script_timeout' });
    const controller = new AbortController();
    const pending = adapter.send(batch(), scriptContext('wait', 5000, controller.signal));
    setTimeout(() => { controller.abort(); }, 150);
    expect(await pending).toEqual({ outcome: 'retry', errorCategory: 'generic' });
    expect(await adapter.send(batch(), scriptContext('wait', 5000, controller.signal))).toEqual({ outcome: 'retry', errorCategory: 'generic' });
    const spawn = vi.fn(async () => { throw new Error('PRIVATE_SPAWN_SENTINEL'); });
    const stub = createScriptUsageAdapter({ spawn });
    const malformed = Object.assign(batch(), { prompt: 'PRIVATE_CONTENT_SENTINEL' });
    expect((await stub.send(malformed, scriptContext())).outcome).toBe('invalid');
    expect(spawn).not.toHaveBeenCalled();
    expect(await stub.send(batch(), scriptContext())).toEqual({ outcome: 'retry', errorCategory: 'script_spawn_failed' });
  });
});

describe('native handoff state contract', () => {
  const scope: UsageExportScope = { start_at: cutoff - 7_200_000, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] };
  function plan() { return planUsageExportHandoff({ data_home_fingerprint: hash, account_fingerprint: hash, stream_id: stream, now: cutoff - 60000, cutoff_at: cutoff }); }
  function arm() { return armUsageExportHandoff(plan(), { now: cutoff - 30000, cutoff_at: cutoff, data_home_fingerprint: hash, account_fingerprint: hash, donor_cutoff_persisted: true, native_projection_complete: true, native_test_delivered: true }); }
  it('native projection/outbox persist exactly the >=T side of the donor continuity fixture through reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-native-handoff-'));
    const path = join(root, 'export.sqlite');
    const id = '00000000-0000-4000-8000-000000000001';
    const records = [-3_600_000, -1_800_001, -1_800_000, -1, 0, 1, 1_800_000, 3_599_999].map((offset, index) => ({ time: cutoff + offset, model: 'gpt-6.1-sol', usageKnown: true, usage: { inputOther: 2 ** index, inputCacheRead: 2 ** index, inputCacheCreation: 0, output: 1 } }));
    const pricing: IModelPricingService = {
      _serviceBrand: undefined, ready: Promise.resolve(), resolve: () => undefined, calculate: () => undefined,
      getPricing: () => { throw new Error('unexpected_fixture_get_pricing'); },
      setPricing: () => { throw new Error('unexpected_fixture_set_pricing'); },
      refreshNow: () => { throw new Error('unexpected_fixture_refresh'); },
      status: () => { throw new Error('unexpected_fixture_status'); },
    };
    let store = new UsageExportStore(path);
    try {
      store.setMeta('fixture-handoff', JSON.stringify(arm()));
      store.save({ id, label: 'Fixture', target: { kind: 'vibe', endpoint: 'https://example.test/api/usage/ingest' }, account_fingerprint: hash,
        scope: nativeHandoffScope(arm(), scope)!, schedule_minutes: 0, stream_id: stream, enabled: true,
        consent_fingerprint: hash, credential_storage: 'none', state: 'ready', next_at: null, last_success_at: null, error_category: null });
      store.stage('fixture', projectSource({ key: 'fixture-source', workspaceId: 'fixture-workspace', kind: 'session', records }, pricing));
      store.publishStage('fixture');
      for (let restart = 0; restart < 2; restart++) {
        const items = store.exportQueue(id);
        expect(items).toHaveLength(2);
        expect(items.every(item => Date.parse(item.bucket!.start_at) >= cutoff)).toBe(true);
        expect(items.reduce((sum, item) => sum + item.bucket!.tokens.input_other, 0)).toBe(240);
        expect(items.reduce((sum, item) => sum + item.bucket!.tokens.input_cache_read, 0)).toBe(240);
        expect(items.reduce((sum, item) => sum + item.bucket!.quality.known_records, 0)).toBe(4);
        const state = usageExportHandoffSchema.parse(JSON.parse(store.meta('fixture-handoff')!));
        expect(nativeHandoffScope(state, scope)).toEqual(store.get(id).scope);
        store.close();
        store = new UsageExportStore(path);
      }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('prepared leaves native inactive; durable readiness fixes >=T across restart without a second identity', () => {
    expect(plan().namespace).toBe(`kiki-${stream}`);
    expect(nativeHandoffScope(plan(), scope)).toBeNull();
    const restarted = usageExportHandoffSchema.parse(JSON.parse(JSON.stringify(arm())));
    expect(nativeHandoffScope(restarted, scope)?.start_at).toBe(cutoff);
    expect(() => armUsageExportHandoff(plan(), { now: cutoff, cutoff_at: cutoff, data_home_fingerprint: hash, account_fingerprint: hash, donor_cutoff_persisted: true, native_projection_complete: true, native_test_delivered: true })).toThrow('readiness');
  });
  it('last old safe marker and first native confirmed receipt complete in either order; mismatched cutoff and partial native do not', () => {
    const legacy = { completed_at: cutoff + 60000, cutoff_at: cutoff, ingested: 1, coverage_complete: true as const, cutoff_persisted: true as const, collector_version: 'fixture-v1', collector_identity: { apiUrl: 'https://example.test', keyFingerprint: 'a'.repeat(16), ingest_endpoint: 'https://example.test/api/usage/ingest' } };
    expect(() => recordLegacyHandoffReceipt(arm(), { ...legacy, cutoff_at: cutoff - 1_800_000 })).toThrow('unproven');
    const receipt = { schema_version: 'kiki.usage.receipt.v1', batch_id: batch().batch_id, items: batch().items.map(({ stream_id, bucket_id, revision, payload_hash }) => ({ stream_id, bucket_id, revision, payload_hash, status: 'applied' })) };
    const confirm = (state: ReturnType<typeof arm>) => confirmNativeHandoff(state, { receipt, completed_at: cutoff + 120000, namespace: `kiki-${stream}`, earliest_bucket_at: cutoff });
    const oldFirst = recordLegacyHandoffReceipt(arm(), legacy);
    expect(oldFirst.phase).toBe('awaiting-native');
    expect(confirm(oldFirst).phase).toBe('completed');
    expect(recordLegacyHandoffReceipt(confirm(arm()), legacy).phase).toBe('completed');
    expect(() => confirmNativeHandoff(arm(), { receipt: { ...receipt, items: [] }, completed_at: cutoff + 1, namespace: `kiki-${stream}`, earliest_bucket_at: cutoff })).toThrow('unconfirmed');
    expect(() => planUsageExportRollback(arm(), cutoff + 1, cutoff)).toThrow('new_boundary');
    const rollback = planUsageExportRollback(arm(), cutoff + 1, cutoff + 1_800_000);
    expect(rollback.phase).toBe('rollback-prepared');
    expect(nativeHandoffScope(rollback, scope)).toEqual({ ...scope, start_at: cutoff, end_at: cutoff + 1_800_000 });
  });
});

function authFixture() {
  let time = cutoff;
  const destination: UsageExportDestination = { id: '11111111-1111-4111-8111-111111111111', label: 'VibeCafe', target: { kind: 'vibe', endpoint: VIBE_CAFE_INGEST_ENDPOINT }, account_fingerprint: hash, scope: { start_at: cutoff, end_at: null, include_ephemeral: false, excluded_workspace_ids: [] }, schedule_minutes: 30, stream_id: stream, enabled: false, consent_fingerprint: null, credential_storage: 'none', state: 'draft', next_at: null, last_success_at: null, error_category: null };
  const code = { deviceCode: 'DEVICE_SECRET', userCode: 'ABCD-EFGH', verificationUriComplete: 'https://vibecafe.ai/usage/device?user_code=ABCD-EFGH', expiresIn: 900, interval: 5 };
  const send = vi.fn<VibeAuthRequest>().mockResolvedValueOnce(code).mockResolvedValue({ error: 'authorization_pending' });
  const save = vi.fn(async () => destination);
  const auth = new VibeCafeDeviceAuth(() => destination, save, send, () => time);
  return { auth, destination, code, send, save, tick: (ms = 5000) => { time += ms; } };
}

describe('official VibeCafe device connection', () => {
  it('keeps the device secret server-side, respects polling interval and stores only an approved key', async () => {
    const f = authFixture();
    try {
      const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' });
      expect(flow).toMatchObject({ state: 'pending', user_code: 'ABCD-EFGH', poll_after_ms: 5000 });
      expect(JSON.stringify(flow)).not.toContain('DEVICE_SECRET');
      expect(f.send.mock.calls[0]!.slice(0, 2)).toEqual(['/api/usage/device/code', { clientName: 'Kiki', hostname: `kiki-${stream}` }]);
      await f.auth.poll(flow.flow_id); expect(f.send).toHaveBeenCalledTimes(1);
      f.tick(); expect((await f.auth.poll(flow.flow_id)).state).toBe('pending'); expect(f.save).not.toHaveBeenCalled();
      f.tick(); f.send.mockResolvedValue({ apiKey: 'vbu_SYNTHETIC_APPROVED_KEY', apiUrl: 'https://vibecafe.ai' });
      const approved = await f.auth.poll(flow.flow_id);
      expect(approved.state).toBe('connected');
      expect(f.save).toHaveBeenCalledWith({ draft: { id: f.destination.id, label: 'VibeCafe', target: f.destination.target, scope: f.destination.scope, schedule_minutes: 30 }, secret: { value: 'vbu_SYNTHETIC_APPROVED_KEY', storage: 'keyring', acknowledge_file_storage: undefined } }, false);
      expect(JSON.stringify(approved)).not.toMatch(/DEVICE_SECRET|vbu_/);
      await f.auth.poll(flow.flow_id); expect(f.save).toHaveBeenCalledTimes(1);
    } finally { await f.auth.close(); }
  });

  it('cancels a pending exchange and discards an approval arriving afterwards', async () => {
    const f = authFixture();
    try {
      const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' });
      let resolve!: (value: unknown) => void;
      f.send.mockImplementationOnce(async () => new Promise((done) => { resolve = done; }));
      f.tick(); const pending = f.auth.poll(flow.flow_id);
      expect((await f.auth.cancel(flow.flow_id)).state).toBe('cancelled');
      resolve({ apiKey: 'vbu_LATE_KEY' });
      expect((await pending).state).toBe('cancelled');
      expect(f.save).not.toHaveBeenCalled();
    } finally { await f.auth.close(); }
  });

  it('reports denial, expiry, malformed responses and credential storage failure without a connection', async () => {
    for (const [response, state] of [[{ error: 'access_denied' }, 'denied'], [{ error: 'expired_token' }, 'expired'], [{ apiKey: 'bad-key' }, 'error'], [{ apiKey: 'vbu_KEY', apiUrl: 'https://other.example.test' }, 'error']] as const) {
      const f = authFixture();
      try {
        const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' }); f.tick(); f.send.mockResolvedValue(response);
        expect((await f.auth.poll(flow.flow_id)).state).toBe(state); expect(f.save).not.toHaveBeenCalled();
      } finally { await f.auth.close(); }
    }
    const f = authFixture();
    try {
      const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' }); f.tick();
      f.send.mockResolvedValue({ apiKey: 'vbu_KEY' }); f.save.mockRejectedValue(new Error('keyring-unavailable'));
      expect(await f.auth.poll(flow.flow_id)).toMatchObject({ state: 'error', error_category: 'keyring-unavailable' });
    } finally { await f.auth.close(); }
  });

  it('refuses custom destinations, unsafe verification URLs, private-file storage without consent and changed drafts', async () => {
    const f = authFixture();
    try {
      await expect(f.auth.begin(f.destination.id, { storage: 'private-file' })).rejects.toThrow('private-file-storage-requires-consent');
      f.destination.target = { kind: 'vibe', endpoint: 'https://custom.example.test/api/usage/ingest' };
      await expect(f.auth.begin(f.destination.id, { storage: 'keyring' })).rejects.toThrow('vibe-auth-official-only');
      expect(f.send).not.toHaveBeenCalled();
      f.destination.target = { kind: 'vibe', endpoint: VIBE_CAFE_INGEST_ENDPOINT };
      f.send.mockReset().mockResolvedValue({ ...f.code, verificationUriComplete: 'https://other.example.test/usage/device' });
      expect((await f.auth.begin(f.destination.id, { storage: 'keyring' })).state).toBe('error');
      f.send.mockResolvedValue(f.code); const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' });
      f.destination.label = 'changed'; f.tick(); f.send.mockResolvedValue({ apiKey: 'vbu_KEY' });
      expect(await f.auth.poll(flow.flow_id)).toMatchObject({ state: 'error', error_category: 'vibe-auth-destination-changed' }); expect(f.save).not.toHaveBeenCalled();
    } finally { await f.auth.close(); }
  });

  it('retries network failures, slows polling when requested, and expires without further requests', async () => {
    const f = authFixture();
    try {
      const flow = await f.auth.begin(f.destination.id, { storage: 'keyring' }); f.tick();
      f.send.mockRejectedValueOnce(new Error('network'));
      expect(await f.auth.poll(flow.flow_id)).toMatchObject({ state: 'pending', error_category: 'vibe-auth-network' });
      f.tick(); f.send.mockResolvedValue({ error: 'slow_down' });
      expect((await f.auth.poll(flow.flow_id)).poll_after_ms).toBe(10000);
      const requests = f.send.mock.calls.length; f.tick(900_000);
      expect((await f.auth.poll(flow.flow_id)).state).toBe('expired'); expect(f.send).toHaveBeenCalledTimes(requests); expect(f.save).not.toHaveBeenCalled();
    } finally { await f.auth.close(); }
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { _clearScopedRegistryForTests, registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { PluginService } from '#/app/plugin/pluginService';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { IPluginHostService, PluginHostService } from '#/app/plugin/pluginHostService';
import { IPluginMediaService } from '#/app/pluginMedia/pluginMedia';
import { PluginMediaService } from '#/app/pluginMedia/pluginMediaService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { IRequestIdentityCatalog, RequestIdentityCatalog } from '#/app/requestIdentity/requestIdentityCatalog';
import { IOAuthService } from '#/app/auth/auth';
import { ScopedMediaStore } from '#/agent/media/sessionMediaStoreService';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubProviderService } from '../provider/stubs';
import type { MediaJob } from '@kiki/protocol';
import { officialPluginFixture } from '../../fixtures/officialPlugins';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../../fixtures/plugin-media');
let root: string;
let home: string;
let remote: string;
const targets: ScopedTestHost[] = [];
const stores: FileStorageService[] = [];
const config: Record<string, unknown> = {};
const owner = { sessionId: 'session-media', agentId: 'main', mediaScope: 'sessions/session-media/media' };

function host(providers: Record<string, ProviderConfig> = {}) {
  const storage = new FileStorageService(home); stores.push(storage);
  const target = createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(home)),
    stubPair(IConfigService, { _serviceBrand: undefined, ready: Promise.resolve(), get: (key: string) => config[key] ?? {}, set: async (key: string, value: unknown) => { config[key] = { ...config[key] as object, ...value as object }; }, replace: async (key: string, value: unknown) => { config[key] = value; } } as unknown as IConfigService),
    stubPair(IFlagService, { enabled: () => true } as unknown as IFlagService),
    stubPair(IProviderService, stubProviderService(providers)),
    stubPair(IOAuthService, { resolveTokenProvider: () => ({ getAccessToken: async () => 'fixture-oauth-token' }) } as unknown as IOAuthService),
    stubPair(ISkillDiscovery, { _serviceBrand: undefined, discover: async () => ({ skills: [], skipped: [], scannedRoots: [], scannedDirectories: [] }) } satisfies ISkillDiscovery),
    stubPair(IFileSystemStorageService, storage),
  ]);
  targets.push(target);
  return target;
}
async function install(target: ScopedTestHost, source: string) {
  const plugins = target.app.accessor.get(IPluginService);
  const plan = await plugins.previewPlugin({ source });
  await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true });
  await plugins.setPluginEnabled({ id: plan.id, enabled: true });
}
async function start(service: IPluginMediaService, requestId: string, prompt: string, kind: 'image' | 'video' | 'tts' = 'image') {
  return service.start({ request_id: requestId, provider: 'fixture-media/synthetic', request: kind === 'tts' ? { kind, text: prompt, voice: 'test-voice' } : { kind, prompt } }, owner);
}
async function terminal(service: IPluginMediaService, id: string) {
  await vi.waitFor(async () => expect(['succeeded', 'partial', 'failed', 'unknown', 'stopped']).toContain((await service.job(id)).state), { timeout: 10_000, interval: 20 });
  return service.job(id);
}
async function submitted() { return (await readFile(path.join(remote, 'submitted.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean); }
async function stopHost(target: ScopedTestHost, service: IPluginMediaService, job: MediaJob) {
  const promise = service.run(job.job_id);
  await target.dispose();
  await Promise.race([promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Media execution did not settle after scope disposal')), 1000))]);
  await stores[targets.indexOf(target)]!.flush();
}

beforeEach(async () => {
  _clearScopedRegistryForTests();
  registerScopedService(LifecycleScope.App, IPluginService, PluginService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginSettingsService, PluginSettingsService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginHostService, PluginHostService, ScopeActivation.OnDemand, 'plugin');
  registerScopedService(LifecycleScope.App, IPluginMediaService, PluginMediaService, ScopeActivation.OnDemand, 'pluginMedia');
  registerScopedService(LifecycleScope.App, IAtomicDocumentStore, JsonAtomicDocumentStore, ScopeActivation.OnDemand, 'storage');
  registerScopedService(LifecycleScope.App, IRequestIdentityCatalog, RequestIdentityCatalog, ScopeActivation.OnDemand, 'requestIdentity');
  const scratch = path.resolve(here, '../../../../../.tmp'); await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'media-fixture-')); home = path.join(root, 'isolated-home'); remote = path.join(root, 'fake-remote');
  await mkdir(home); await mkdir(remote);
  for (const key of Object.keys(config)) delete config[key];
});
afterEach(async () => {
  for (const target of targets.splice(0)) await target.dispose();
  for (const store of stores.splice(0)) await store.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
async function configured() {
  const target = host(); await install(target, fixture);
  await target.app.accessor.get(IPluginSettingsService).update({ pluginId: 'fixture-media', values: { remoteDir: remote, apiKey: 'fixture-only-key' } });
  return { target, service: target.app.accessor.get(IPluginMediaService), storage: stores.at(-1)! };
}

describe('media provider persisted vertical slice', () => {
  it.each([
    ['custom-key', { type: 'openai', baseUrl: 'https://media.example.test/prefix/v1', apiKey: 'selected-key' }, { authorization: 'Bearer selected-key' }],
    ['google-key', { type: 'google_genai', baseUrl: 'https://google.example.test/v1beta', apiKey: 'google-selected-key' }, { 'x-goog-api-key': 'google-selected-key' }],
    ['managed:grok-build', { type: 'openai', baseUrl: 'https://grok.example.test/enterprise/v1', oauth: { storage: 'file', key: 'grok-build', source: { kind: 'local_original', provider: 'grok-build', homeDir: 'not-read-by-fixture', storageBackend: 'file', accountId: 'original-account' } }, requestIdentity: { profile: 'none' }, customHeaders: { 'user-agent': 'must-suppress', 'x-api-key': 'must-remove', 'x-grok-session-id': 'must-suppress' } }, { authorization: 'Bearer fixture-oauth-token', 'x-xai-token-auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response', 'x-userid': 'original-account', 'x-grok-client-version': '1.0.45' }],
  ] as const)('resolves only the selected %s connection through the real child bridge and clears identity sentinels', async (id, connection, expected) => {
    vi.stubEnv('KIKI_MEDIA_FIXTURE_ENV', 'trusted-script-env');
    const target = host({ [id]: connection as ProviderConfig, sibling: { type: 'openai', apiKey: 'unrelated-secret' } });
    await install(target, fixture);
    await target.app.accessor.get(IPluginSettingsService).update({ pluginId: 'fixture-media', values: { remoteDir: remote, connectionId: id } });
    const stagingDir = path.join(root, 'connection-output'); await mkdir(stagingDir);
    await target.app.accessor.get(IPluginHostService).requestMediaProvider('fixture-media/synthetic', 'submit', { request: { kind: 'image', prompt: 'connection' } }, new AbortController().signal, { jobId: 'connection-fixture', stagingDir, owner: { ...owner, identity: { logicalId: 'fixture-logical-id', sharedSessionId: 'fixture-shared-session', agentSessionId: 'fixture-agent-session' } } });
    const payload = JSON.parse(await readFile(path.join(stagingDir, 'connection.json'), 'utf8'));
    expect(payload.connection).toMatchObject({ id, baseUrl: connection.baseUrl, headers: expected });
    expect(payload.settings).not.toHaveProperty('apiKey');
    expect(JSON.stringify(payload)).not.toContain('unrelated-secret');
    expect(payload.env).toBe('trusted-script-env');
    expect(Object.keys(payload.connection.headers).some((name) => name.startsWith('x-kiki-internal-'))).toBe(false);
    if (id === 'managed:grok-build') {
      for (const name of ['user-agent', 'x-api-key', 'x-grok-session-id']) expect(payload.connection.headers).not.toHaveProperty(name);
    } else {
      for (const name of ['x-xai-token-auth', 'chatgpt-account-id', 'x-userid']) expect(payload.connection.headers).not.toHaveProperty(name);
    }
  });

  it('fails a selected missing connection without falling back to the script API key', async () => {
    const { target } = await configured();
    await target.app.accessor.get(IPluginSettingsService).update({ pluginId: 'fixture-media', values: { connectionId: 'missing-selected' } });
    const stagingDir = path.join(root, 'failed-connection'); await mkdir(stagingDir);
    await expect(target.app.accessor.get(IPluginHostService).requestMediaProvider('fixture-media/synthetic', 'submit', { request: { kind: 'image', prompt: 'connection' } }, new AbortController().signal, { jobId: 'missing-connection', stagingDir })).rejects.toThrow('Selected Kiki connection does not exist');
  });
  it('installs a real script provider, discovers on demand, publishes original file_id and avoids duplicate submissions', async () => {
    const { target, service, storage } = await configured();
    expect(await service.providers()).toMatchObject([{ provider: 'fixture-media/synthetic' }]);
    expect(await service.capabilities({ provider: 'fixture-media/synthetic' })).toMatchObject({ models: [{ id: 'synthetic-image' }, { id: 'synthetic-video' }, { id: 'synthetic-tts' }] });
    expect(await service.voices({ provider: 'fixture-media/synthetic' })).toMatchObject({ voices: [{ id: 'test-voice' }] });
    const job = await start(service, 'image-1', 'sync');
    const progress = vi.fn();
    const result = await service.run(job.job_id, progress);
    expect(progress).toHaveBeenCalledWith({ kind: 'status', text: 'Synthetic provider accepted' });
    expect(result).toMatchObject({ state: 'succeeded', artifacts: [{ role: 'original', complete: true, file_id: expect.stringMatching(/^f_media-/) }] });
    expect(await service.cancel(job.job_id)).toEqual(result);
    const media = new ScopedMediaStore(owner.mediaScope, storage, target.app.accessor.get(IAtomicDocumentStore));
    const file = await media.open(result.artifacts[0]!.file_id);
    expect(file?.mediaType).toBe('image/png');
    const chunks = []; for await (const chunk of file!.stream({ start: 0, end: 4 })) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('media');
    expect(await start(service, 'image-1', 'sync')).toMatchObject({ job_id: job.job_id, state: 'succeeded' });
    await service.run(job.job_id);
    await expect(start(service, 'image-1', 'changed')).rejects.toThrow('different');
    expect(await submitted()).toHaveLength(1);
    const tts = await start(service, 'speech-1', 'sync', 'tts');
    const speech = await service.run(tts.job_id);
    expect(speech.artifacts[0]).toMatchObject({ kind: 'audio', mime: 'audio/mpeg', name: 'speech.mp3' });
  });

  it('keeps identical request ids independent across owning agents without duplicate submission inside either agent', async () => {
    const { service } = await configured();
    const input = { request_id: 'same-request', provider: 'fixture-media/synthetic', request: { kind: 'image' as const, prompt: 'sync' } };
    const first = await service.start(input, owner);
    const second = await service.start(input, { ...owner, agentId: 'second-agent' });
    expect(second.job_id).not.toBe(first.job_id);
    expect(first.owner_agent_id).toBe('main'); expect(second.owner_agent_id).toBe('second-agent');
    await service.run(first.job_id); await service.run(second.job_id);
    expect((await service.start(input, owner)).job_id).toBe(first.job_id);
    expect(await submitted()).toHaveLength(2);
  });

  it('returns unknown for lost submit response and never rebuys it on resume or restart', async () => {
    const { target, service } = await configured();
    const job = await start(service, 'unknown-1', 'unknown');
    expect(await service.run(job.job_id)).toMatchObject({ state: 'unknown', can_resume: false, error: { submission: 'unknown' } });
    await expect(service.resume(job.job_id)).rejects.toThrow('never submits');
    await target.dispose();
    const next = host().app.accessor.get(IPluginMediaService);
    expect(await next.job(job.job_id)).toMatchObject({ state: 'unknown' });
    expect(await submitted()).toHaveLength(1);
  });

  it('restarts accepted async video and resumes polling/downloading without submit', async () => {
    const { target, service } = await configured();
    const job = await start(service, 'video-1', 'async', 'video');
    void service.run(job.job_id);
    await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending', can_resume: true }));
    await stopHost(target, service, job);
    await writeFile(path.join(remote, 'ready'), 'yes');
    const next = host().app.accessor.get(IPluginMediaService);
    const result = await terminal(next, job.job_id);
    expect(result).toMatchObject({ state: 'succeeded', artifacts: [{ kind: 'video', complete: true }] });
    expect(await submitted()).toHaveLength(1);
  });

  it('retains accepted handles in download phase, stops locally, resumes only download and separates requested cancellation', async () => {
    const { service } = await configured();
    await writeFile(path.join(remote, 'ready'), 'fail');
    const job = await start(service, 'video-download', 'download', 'video');
    void service.run(job.job_id);
    await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending', phase: 'download' }));
    const stopped = await service.cancel(job.job_id);
    expect(stopped).toMatchObject({ state: 'stopped', can_resume: true, cancellation: { remote: 'requested', billing: 'unknown' } });
    await writeFile(path.join(remote, 'ready'), 'yes');
    await service.resume(job.job_id);
    expect(await terminal(service, job.job_id)).toMatchObject({ state: 'succeeded' });
    expect(await submitted()).toHaveLength(1);
  });

  it('keeps delivered originals on partial/stream-incomplete and refuses confirmed-remote-cancel resume', async () => {
    const { service } = await configured();
    const partial = await service.run((await start(service, 'partial-1', 'partial')).job_id);
    expect(partial).toMatchObject({ state: 'partial', artifacts: [{ complete: true }], error: { items: [{ item: 'subtitle' }] } });
    const incomplete = await service.run((await start(service, 'incomplete-1', 'incomplete', 'tts')).job_id);
    expect(incomplete).toMatchObject({ state: 'partial', artifacts: [{ complete: false }] });
    const job = await start(service, 'cancel-1', 'cancelled', 'video');
    void service.run(job.job_id);
    await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending' }));
    expect(await service.cancel(job.job_id)).toMatchObject({ state: 'stopped', can_resume: false, cancellation: { remote: 'cancelled', billing: 'unknown' } });
    await expect(service.resume(job.job_id)).rejects.toThrow('never submits');
  });

  it('persists source collections and reads catalogs without installing or deleting provider/key/jobs', async () => {
    const { target, service } = await configured();
    const job = await service.run((await start(service, 'history-1', 'sync')).job_id);
    const catalog = path.join(root, 'catalog.json');
    await writeFile(catalog, JSON.stringify({ plugins: [{ id: 'fixture-media', displayName: 'Synthetic', source: fixture }] }));
    await service.setSources({ sources: [{ id: 'test-source', url: catalog, enabled: true }] });
    expect(await service.catalog({ id: 'test-source' })).toMatchObject({ plugins: [{ id: 'fixture-media' }] });
    await service.setSources({ sources: [] });
    expect(await service.job(job.job_id)).toMatchObject({ state: 'succeeded' });
    expect(await target.app.accessor.get(IPluginSettingsService).inspect('fixture-media')).toMatchObject({ secretsConfigured: ['apiKey'] });
    expect(await service.providers()).toHaveLength(1);
  });

  it('executes the official two tools through the actual bidirectional plugin bridge', async () => {
    const { target, service } = await configured();
    const official = await officialPluginFixture('kiki-media', path.join(root, 'official-media'));
    await install(target, official);
    const hosts = target.app.accessor.get(IPluginHostService);
    const api = { generate: async () => service.run((await start(service, 'bridge-1', 'sync')).job_id), media: async () => service.capabilities({}) };
    const output = await hosts.execute('kiki-media', 'generate', { request: { kind: 'image', prompt: 'sync' } }, new AbortController().signal, undefined, { media: api });
    expect(typeof output.output).toBe('string');
    expect(JSON.parse(output.output as string)).toMatchObject({ type: 'media_generation', job: { state: 'succeeded' } });
    expect(await hosts.list()).toMatchObject([{ pluginId: 'kiki-media', definition: { name: 'generate', disclosure: 'inline' } }, { pluginId: 'kiki-media', definition: { name: 'media', disclosure: 'deferred' } }]);
  });
});

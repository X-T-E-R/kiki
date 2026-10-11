import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mediaTask } from '#/agent/pluginMedia/mediaTask';
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
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { Event } from '#/_base/event';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../../fixtures/plugin-media');
let root: string;
let home: string;
let remote: string;
const targets: ScopedTestHost[] = [];
const stores: FileStorageService[] = [];
const config: Record<string, unknown> = {};
const owner = { sessionId: 'session-media', agentId: 'main', mediaScope: 'sessions/session-media/media' };

function host(
  providers: Record<string, ProviderConfig> = {},
  usage: IPluginUsageService = { enabled: () => false, allows: async () => true } as unknown as IPluginUsageService,
  sessions: ISessionIndex = { get: async () => undefined } as unknown as ISessionIndex,
) {
  const storage = new FileStorageService(home); stores.push(storage);
  const target = createScopedTestHost([
    stubPair(IBootstrapService, stubBootstrap(home)),
    stubPair(IConfigService, { _serviceBrand: undefined, ready: Promise.resolve(), onDidSectionChange: Event.None, get: (key: string) => config[key] ?? {}, set: async (key: string, value: unknown) => { config[key] = { ...config[key] as object, ...value as object }; }, replace: async (key: string, value: unknown) => { config[key] = value; } } as unknown as IConfigService),
    stubPair(IFlagService, { enabled: (id: string) => id !== 'plugin_app_lifecycle' } as unknown as IFlagService),
    stubPair(IPluginUsageService, usage),
    stubPair(ISessionIndex, sessions),
    stubPair(ISessionManager, {} as ISessionManager),
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
async function fixtureServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture listener missing');
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
async function installUnified(target: ScopedTestHost) {
  const source = process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT']!;
  const archive = process.env['KIKI_MEDIA_SINGLE_PLUGIN_ZIP'];
  if (archive === undefined) return install(target, source);
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const unexpected: string[] = [];
  const server = await fixtureServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/kiki-media.zip') { unexpected.push(`${request.method} ${request.url}`); response.writeHead(500).end(); return; }
    response.writeHead(200, { 'content-type': 'application/zip' }).end(bytes);
  });
  try {
    const plugins = target.app.accessor.get(IPluginService);
    const url = `${server.base}/kiki-media.zip`;
    await expect(plugins.previewPlugin({ source: url, sha256: '0'.repeat(64) })).rejects.toThrow();
    const plan = await plugins.previewPlugin({ source: url, sha256 });
    await plugins.installPlugin({ source: url, sha256, fingerprint: plan.fingerprint, consent: true });
    await plugins.setPluginEnabled({ id: plan.id, enabled: true });
    expect(unexpected).toEqual([]);
  } finally { await server.close(); }
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

  it('gates new media admission and discovery by the owning session without blocking accepted execution', async () => {
    let allowed = false;
    const usage = {
      enabled: () => true,
      registerPluginStateReader: () => ({ dispose: () => {} }),
      readSession: async (workspaceId: string, sessionId: string) => ({ workspaceId, sessionId, revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      applySession: async (snapshot: never) => snapshot,
      onDidChange: Event.None,
      allows: async (workspaceId: string | undefined, pluginId: string, sessionId?: string) => {
        expect(workspaceId).toBe('workspace-media');
        expect(pluginId).toBe('fixture-media');
        expect(sessionId).toBe(owner.sessionId);
        return allowed;
      },
    } as unknown as IPluginUsageService;
    const sessions = {
      get: async (sessionId: string) => ({ id: sessionId, workspaceId: 'workspace-media' }),
    } as unknown as ISessionIndex;
    const target = host({}, usage, sessions);
    await install(target, fixture);
    await target.app.accessor.get(IPluginSettingsService).update({ pluginId: 'fixture-media', values: { remoteDir: remote } });
    const service = target.app.accessor.get(IPluginMediaService);
    const scope = { workspaceId: 'workspace-media', sessionId: owner.sessionId };

    await expect(service.capabilities({ provider: 'fixture-media/synthetic' }, scope)).rejects.toThrow('disabled in this session');
    await expect(service.voices({ provider: 'fixture-media/synthetic' }, scope)).rejects.toThrow('disabled in this session');
    await expect(start(service, 'session-gated', 'sync')).rejects.toThrow();

    allowed = true;
    const job = await start(service, 'accepted-before-off', 'sync');
    allowed = false;
    expect(await service.run(job.job_id)).toMatchObject({ state: 'succeeded' });
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

  it.skipIf(!process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT'])('installs one unified package, independently manages all built-in sources and runs an arbitrary command', async () => {
    const target = host();
    await installUnified(target);
    const service = target.app.accessor.get(IPluginMediaService);
    const plugins = target.app.accessor.get(IPluginService);
    expect((await plugins.listPlugins()).map((item) => item.id)).toEqual(['kiki-media']);
    expect(await service.providers()).toHaveLength(16);
    expect((await service.managedSources()).map((item) => item.sourceId)).toEqual(['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui']);
    const openai = await service.updateSource({ provider: 'kiki-media/openai-image', values: { apiKey: 'fixture-key', baseUrl: 'https://api.example.test/v1' } });
    expect(openai.secretsConfigured).toEqual(['apiKey']);
    expect(openai.values).not.toHaveProperty('apiKey');
    expect(openai.missing).toEqual([]);
    await service.updateSource({ provider: 'kiki-media/google-image', enabled: false });
    expect(await service.providers()).toHaveLength(14);
    await service.updateSource({ provider: 'kiki-media/ark-image', removed: true });
    expect(await service.providers()).toHaveLength(12);
    expect(await service.sourceSettings({ provider: 'kiki-media/openai-image' })).toEqual(openai);
    expect(await service.capabilities({ provider: 'kiki-media/openai-image' })).toMatchObject({ models: expect.arrayContaining([{ id: 'gpt-image-1', kind: 'image' }]) });
    const script = path.join(root, 'independent-script.mjs');
    await writeFile(script, `import {writeFile, readFile} from 'node:fs/promises';const [output, external] = process.argv.slice(2);await writeFile(output, process.env.FIXTURE_SCRIPT_ENV + ':' + await readFile(external, 'utf8'));`);
    const external = path.join(root, 'external.txt'); await writeFile(external, 'external-file');
    const custom = await service.addScriptSource({ id: 'my-speech', label: 'My speech', kinds: ['tts'], command: process.execPath, args: [script, '{output}', external], environment: { FIXTURE_SCRIPT_ENV: 'custom-env' } });
    expect(custom).toMatchObject({ custom: true, provider: 'kiki-media/script-my-speech', secretsConfigured: ['environment'] });
    expect(JSON.stringify(custom)).not.toContain('custom-env');
    const job = await service.start({ request_id: 'script-1', provider: custom.provider, request: { kind: 'tts', text: 'hello', voice: 'local' } }, owner);
    const output = await service.run(job.job_id);
    expect(output).toMatchObject({ state: 'succeeded', artifacts: [{ kind: 'audio', mime: 'audio/mpeg', complete: true }] });
    const media = new ScopedMediaStore(owner.mediaScope, stores.at(-1)!, target.app.accessor.get(IAtomicDocumentStore));
    const file = await media.open(output.artifacts[0]!.file_id);
    const chunks = []; for await (const chunk of file!.stream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('custom-env:external-file');
    await service.updateSource({ provider: custom.provider, removed: true });
    expect(await service.job(job.job_id)).toEqual(output);
    expect((await service.providers()).some((item) => item.provider === custom.provider)).toBe(false);
    await expect(service.start({ request_id: 'removed-1', provider: custom.provider, request: { kind: 'tts', text: 'hello', voice: 'local' } }, owner)).rejects.toThrow('Choose');
    expect(await service.sourceSettings({ provider: 'kiki-media/openai-image' })).toEqual(openai);
    await service.updateSource({ provider: custom.provider, removed: false, enabled: false });
    await service.updateSource({ provider: custom.provider, enabled: true });
    expect((await service.providers()).some((item) => item.provider === custom.provider)).toBe(true);
  });

  it.skipIf(!process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT'])('keeps one hundred script sources isolated and restores a JSON handle only with its original environment', async () => {
    let target = host(); await installUnified(target);
    let service = target.app.accessor.get(IPluginMediaService);
    const script = path.join(root, 'async-script.mjs');
    const ready = path.join(remote, 'ready');
    const actions = path.join(remote, 'actions.log');
    await writeFile(script, `import {readFile,writeFile,appendFile,access} from 'node:fs/promises';const [ready,actions] = process.argv.slice(2);const envelope = JSON.parse(await readFile(process.env.KIKI_MEDIA_INPUT,'utf8'));await appendFile(actions,envelope.action+'\\n');let complete=false;try{await access(ready);complete=true;}catch{}if(envelope.action==='poll' && envelope.input.data.id!=='accepted-script-handle')throw new Error('wrong handle');if(complete){await writeFile(envelope.output,process.env.FIXTURE_TOKEN);await writeFile(envelope.resultFile,JSON.stringify({state:'complete',artifacts:[{path:envelope.output,name:'speech.mp3',mime:'audio/mpeg',kind:'audio',role:'original',complete:true}]}));}else await writeFile(envelope.resultFile,JSON.stringify({state:'pending',phase:'generation',handle:{version:1,data:{id:'accepted-script-handle'}},retryAfterMs:3000}));`);
    const primary = await service.addScriptSource({ id: 'async-speech', label: 'Async speech', kinds: ['tts'], command: process.execPath, args: [script, ready, actions], protocol: 'json', environment: { FIXTURE_TOKEN: 'original-token' } });
    const settings = target.app.accessor.get(IPluginSettingsService);
    const configured = await settings.forExecution('kiki-media');
    const scripts = JSON.parse(String(configured['scriptSources']));
    scripts.push(...Array.from({ length: 99 }, (_, index) => ({ id: `extra-${index}`, label: `Extra ${index}`, kinds: ['image'], command: process.execPath, protocol: 'file', enabled: true, removed: false })));
    await settings.update({ pluginId: 'kiki-media', values: { scriptSources: JSON.stringify(scripts) } });
    expect(await service.managedSources()).toHaveLength(110);
    expect(await service.providers()).toHaveLength(116);
    const job = await service.start({ request_id: 'async-script', provider: primary.provider, request: { kind: 'tts', text: 'hello', voice: 'local' } }, owner);
    void service.run(job.job_id);
    await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending', can_resume: true }));
    await service.updateSource({ provider: 'kiki-media/script-extra-0', enabled: false });
    await service.updateSource({ provider: 'kiki-media/script-extra-1', removed: true });
    expect(await service.providers()).toHaveLength(114);
    expect(await service.sourceSettings({ provider: primary.provider })).toEqual(primary);
    await service.updateSource({ provider: primary.provider, values: { environment: JSON.stringify({ FIXTURE_TOKEN: 'changed-token' }) } });
    await stopHost(target, service, job);
    target = host(); service = target.app.accessor.get(IPluginMediaService);
    await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending', blocked_reason: 'needs_provider', can_resume: true }), { timeout: 10_000, interval: 20 });
    expect((await service.stored(job.job_id)).handle?.data['id']).toBe('accepted-script-handle');
    expect((await readFile(actions, 'utf8')).trim().split('\n')).toEqual(['submit']);
    await service.updateSource({ provider: primary.provider, values: { environment: JSON.stringify({ FIXTURE_TOKEN: 'original-token' }) } });
    await writeFile(ready, 'ready');
    await service.resume(job.job_id);
    const result = await terminal(service, job.job_id);
    expect(result).toMatchObject({ state: 'succeeded', artifacts: [{ kind: 'audio', complete: true }] });
    expect((await readFile(actions, 'utf8')).trim().split('\n')).toEqual(['submit', 'poll']);
    const media = new ScopedMediaStore(owner.mediaScope, stores.at(-1)!, target.app.accessor.get(IAtomicDocumentStore));
    const file = await media.open(result.artifacts[0]!.file_id);
    const chunks = []; for await (const chunk of file!.stream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('original-token');
  });

  it.skipIf(!process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT'])('preserves legacy settings, deduplicates new providers and recovers the original accepted handle after upgrading', async () => {
    let ready = false;
    const requests: string[] = [];
    const unexpected: string[] = [];
    let base = '';
    const server = await fixtureServer((request, response) => {
      const route = `${request.method} ${request.url}`; requests.push(route);
      if (request.headers.authorization !== 'Bearer legacy-fixture-key') { unexpected.push('wrong credential'); response.writeHead(500).end(); return; }
      if (route === 'POST /v1/videos/generations') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ request_id: 'accepted-handle' })); return; }
      if (route === 'GET /v1/videos/accepted-handle') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ready ? { status: 'done', video: { url: `${base}/output.mp4` } } : { status: 'pending' })); return; }
      if (route === 'GET /output.mp4') { response.writeHead(200, { 'content-type': 'video/mp4' }).end('fixture-video'); return; }
      unexpected.push(route); response.writeHead(500).end();
    });
    base = server.base;
    try {
      let target = host();
      const legacy = path.join(path.dirname(process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT']!), 'kiki-media-xai');
      await install(target, legacy);
      await target.app.accessor.get(IPluginSettingsService).update({ pluginId: 'kiki-media-xai', values: { apiKey: 'legacy-fixture-key', baseUrl: `${base}/v1` } });
      let service = target.app.accessor.get(IPluginMediaService);
      const job = await service.start({ request_id: 'legacy-job', provider: 'kiki-media-xai/video', request: { kind: 'video', prompt: 'fixture' } }, owner);
      void service.run(job.job_id);
      await vi.waitFor(async () => expect(await service.job(job.job_id)).toMatchObject({ state: 'pending', can_resume: true }));
      await service.stopLocal(job.job_id);
      await service.run(job.job_id);
      await installUnified(target);
      expect((await service.providers()).map((item) => item.provider)).not.toContain('kiki-media-xai/video');
      expect((await service.providers()).map((item) => item.provider)).toContain('kiki-media/xai-video');
      expect(await service.sourceSettings({ provider: 'kiki-media/xai-video' })).toMatchObject({ values: { baseUrl: `${base}/v1` }, secretsConfigured: ['apiKey'], missing: [] });
      const stored = await service.stored(job.job_id);
      expect(stored.view.provider).toBe('kiki-media-xai/video');
      expect(stored.handle?.data['id']).toBe('accepted-handle');
      const newer = await service.start({ request_id: 'old-default-alias', provider: 'kiki-media-xai/video', request: { kind: 'video', prompt: 'fixture-alias' } }, owner);
      expect(newer.provider).toBe('kiki-media/xai-video');
      await service.updateSource({ provider: 'kiki-media/google-image', values: { apiKey: 'sibling-key' } });
      await stopHost(target, service, job);
      target = host(); service = target.app.accessor.get(IPluginMediaService);
      expect((await service.stored(job.job_id)).handle?.data['id']).toBe('accepted-handle');
      ready = true;
      await service.resume(job.job_id);
      const result = await terminal(service, job.job_id);
      expect(result).toMatchObject({ state: 'succeeded', artifacts: [{ kind: 'video', complete: true }] });
      expect(requests.filter((route) => route.startsWith('POST'))).toHaveLength(1);
      expect(unexpected).toEqual([]);
      expect(await target.app.accessor.get(IPluginSettingsService).inspect('kiki-media-xai')).toMatchObject({ secretsConfigured: ['apiKey'], values: { baseUrl: `${base}/v1` } });
      await service.updateSource({ provider: 'kiki-media/xai-video', values: { apiKey: null } });
      expect(await service.sourceSettings({ provider: 'kiki-media/xai-video' })).toMatchObject({ secretsConfigured: [], missing: ['apiKey'] });
      expect(await target.app.accessor.get(IPluginSettingsService).inspect('kiki-media-xai')).toMatchObject({ secretsConfigured: ['apiKey'] });
      await target.app.accessor.get(IPluginService).setPluginEnabled({ id: 'kiki-media-xai', enabled: false });
      await service.updateSource({ provider: 'kiki-media/xai-video', enabled: true });
      expect(await service.providers()).toHaveLength(16);
    } finally { await server.close(); }
  });

  it.skipIf(!process.env['KIKI_MEDIA_SINGLE_PLUGIN_ROOT'])('runs the unified image tool through the real child bridge, Task sink and original artifact delivery', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVZkAAAAASUVORK5CYII=', 'base64');
    const requests: string[] = [];
    const unexpected: string[] = [];
    const server = await fixtureServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== 'POST' || request.url !== '/v1/images/generations' || request.headers.authorization !== 'Bearer fixture-key') { unexpected.push(`${request.method} ${request.url}`); response.writeHead(500).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    try {
      const target = host({ 'fixture-connection': { type: 'openai', apiKey: 'fixture-key', baseUrl: `${server.base}/v1` } }); await installUnified(target);
      const service = target.app.accessor.get(IPluginMediaService);
      expect(await service.updateSource({ provider: 'kiki-media/openai-image', values: { connectionId: 'fixture-connection' } })).toMatchObject({ values: { connectionId: 'fixture-connection' }, secretsConfigured: [], missing: [] });
      const finalOutputs: string[] = [];
      const settles: unknown[] = [];
      const api = { generate: async (input: import('@kiki/protocol').MediaGenerateInput) => {
        const job = await service.start({ ...input, request_id: 'task-image' }, owner);
        await service.bindTask(job.job_id, 'media-task-fixture');
        const task = mediaTask(service, job.job_id);
        await task.start({ appendOutput() {}, setFinalOutput: (output: string) => finalOutputs.push(output), settle: async (result: unknown) => { settles.push(result); } } as unknown as Parameters<typeof task.start>[0]);
        return service.job(job.job_id);
      }, media: async () => service.capabilities({}) };
      const output = await target.app.accessor.get(IPluginHostService).execute('kiki-media', 'generate', { provider: 'kiki-media/openai-image', request: { kind: 'image', prompt: 'one square' } }, new AbortController().signal, undefined, { media: api });
      const result = JSON.parse(output.output as string);
      expect(result).toMatchObject({ type: 'media_generation', job: { state: 'succeeded', task_id: 'media-task-fixture' } });
      expect(JSON.parse(finalOutputs[0]!)).toEqual(result);
      expect(settles).toEqual([{ status: 'completed', stopReason: undefined }]);
      const media = new ScopedMediaStore(owner.mediaScope, stores.at(-1)!, target.app.accessor.get(IAtomicDocumentStore));
      const file = await media.open(result.job.artifacts[0].file_id);
      const chunks = []; for await (const chunk of file!.stream()) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(png);
      expect(requests).toEqual(['POST /v1/images/generations']); expect(unexpected).toEqual([]);
      await service.updateSource({ provider: 'kiki-media/minimax-video', values: { apiKey: 'unrelated-key' } });
      const repeat = await service.start({ request_id: 'task-image', provider: 'kiki-media/openai-image', request: { kind: 'image', prompt: 'one square' } }, owner);
      expect(repeat.job_id).toBe(result.job.job_id);
      expect(requests).toHaveLength(1);
    } finally { await server.close(); }
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

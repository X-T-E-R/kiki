import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { INbSearchService } from '@kiki/agent-core-v2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  data: T;
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('server-v2 /api/nb-search', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-nb-search-'));
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('NB_SEARCH_HOME', join(home, 'local-nb-search'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function boot(config = ''): Promise<void> {
    if (config.length > 0) await writeFile(join(home, 'config.toml'), config, 'utf8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function get<T>(path: string): Promise<Envelope<T>> {
    const response = await authedFetch(server as RunningServer, base, `/api${path}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Envelope<T>;
  }

  async function saveSource(reuse: boolean): Promise<Envelope<unknown>> {
    const response = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search_source: { reuse_local_config: reuse } }),
    });
    return await response.json() as Envelope<unknown>;
  }

  async function localCliHome(): Promise<string> {
    const localHome = join(home, 'local-nb-search');
    await mkdir(localHome, { recursive: true, mode: 0o700 });
    return localHome;
  }

  it('loads local CLI secrets without daemon credential env and never returns their values', async () => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), JSON.stringify({ defaults: { search_lane: 'exa.search' } }));
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-cli-private-key' } }), { mode: 0o600 });
    await boot();
    const response = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(response.data.providers.instances.find((instance) => instance.id === 'exa.default')?.credential.configured).toBe(true);
    expect(JSON.stringify(response)).not.toContain('fixture-cli-private-key');
    expect(response.data.config_source).toMatchObject({ local_credentials: 'present', credential_source: 'environment+local' });
    expect(process.env['NB_SEARCH_EXA_API_KEY']).toBeUndefined();
    expect((await saveSource(false)).code).toBe(0);
    const disabled = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(disabled.data.providers.instances.find((instance) => instance.id === 'exa.default')?.credential.configured).toBe(false);
    expect(disabled.data.config_source).toMatchObject({ local_credentials: 'ignored', credential_source: 'environment' });
    expect((await saveSource(true)).code).toBe(0);
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.revision).toBe(response.data.revision);
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', 'fixture-daemon-key');
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.credential_source).toBe('environment');
  });

  it.each(['fixture-tavily-single', 'fixture-tavily-one,fixture-tavily-two'])('reuses local Tavily credentials with value=%s without leaking them', async (value) => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), JSON.stringify({ defaults: { search_lane: 'tavily.search' } }));
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({
      schema_version: '1',
      values: { NB_SEARCH_TAVILY_API_KEY: value },
      bindings: { NB_SEARCH_TAVILY_API_KEY: [{ instance: 'tavily.default', provider: 'tavily', slot: 'tavily.default', env: 'NB_SEARCH_TAVILY_API_KEY', base_url: null }] },
    }), { mode: 0o600 });
    await boot();
    const capabilities = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(capabilities.data.config_source).toMatchObject({ availability: 'ready', local_credentials: 'present', credential_source: 'environment+local' });
    expect(capabilities.data.providers.instances.find((instance) => instance.id === 'tavily.default')?.credential.configured).toBe(true);
    expect(capabilities.data.search.default_lane).toBe('tavily.search');
    for (const key of value.split(',')) expect(JSON.stringify(capabilities)).not.toContain(key);
    expect(process.env['NB_SEARCH_TAVILY_API_KEY']).toBeUndefined();
  });

  it('rejects duplicate local keys without exposing their values or using stale search capabilities', async () => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), '{}');
    const secretPath = join(localHome, 'secrets.json');
    await writeFile(secretPath, JSON.stringify({ schema_version: '1', values: { NB_SEARCH_TAVILY_API_KEY: 'fixture-original' } }), { mode: 0o600 });
    await boot();
    const ready = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(ready.data.providers.instances.find((instance) => instance.id === 'tavily.default')?.credential.configured).toBe(true);
    await writeFile(secretPath, JSON.stringify({ schema_version: '1', values: { NB_SEARCH_TAVILY_API_KEY: 'fixture-duplicate,fixture-duplicate' } }));
    const capabilities = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(capabilities.data.config_source).toMatchObject({ availability: 'unavailable', issues: ['EFFECTIVE_CONFIG_INVALID', 'CONFIGURATION_ERROR'] });
    expect(capabilities.data.providers.instances).toEqual([]);
    expect(JSON.stringify(capabilities)).not.toContain('fixture-duplicate');
  });

  it.runIf(process.platform === 'win32').each([false, true])('NB-06 rejects alias-based credential redirects before saving with metadata=%s', async (withBindings) => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), '{}');
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({
      schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-nb06-private-key' },
      bindings: withBindings ? { NB_SEARCH_EXA_API_KEY: [{ instance: 'exa.default', provider: 'exa', slot: 'exa.default', env: 'NB_SEARCH_EXA_API_KEY', base_url: null }] } : undefined,
    }), { mode: 0o600 });
    await boot('[nb_search.execution]\nsearch_timeout_ms = 15000\n');
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    const response = await authedFetch(server!, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: {
        credential_slots: { 'tavily.default': { provider_id: 'tavily', env: 'nb_search_exa_api_key' } },
        provider_instances: { 'tavily.default': { base_url: 'https://example.test/redirect' } },
        defaults: { search_lane: 'tavily.search' },
      } }),
    });
    const rejected = await response.json() as Envelope<unknown>;
    expect(rejected.code).toBe(40001);
    expect(JSON.stringify(rejected)).toContain('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    expect(JSON.stringify(rejected)).not.toContain('fixture-nb06-private-key');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
  });

  it('rejects Kiki endpoint overrides against imported CLI bindings before saving', async () => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), JSON.stringify({ defaults: { search_lane: 'exa.search' } }));
    const secretFile = JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-bound-private-key' }, bindings: {
      NB_SEARCH_EXA_API_KEY: [{ instance: 'exa.default', provider: 'exa', slot: 'exa.default', env: 'NB_SEARCH_EXA_API_KEY', base_url: null }],
    } });
    await writeFile(join(localHome, 'secrets.json'), secretFile, { mode: 0o600 });
    await boot('[nb_search.execution]\nsearch_timeout_ms = 15000\n');
    const original = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(original.data.config_source?.availability).toBe('ready');
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    const response = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: { provider_instances: { 'exa.default': { base_url: 'https://example.test/redirect' } } } }),
    });
    const rejected = await response.json() as Envelope<unknown>;
    expect(rejected.code).toBe(40001);
    expect(JSON.stringify(rejected)).not.toContain('fixture-bound-private-key');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
    expect(await readFile(join(localHome, 'secrets.json'), 'utf8')).toBe(secretFile);
    await writeFile(join(localHome, 'config.json'), JSON.stringify({ provider_instances: { 'exa.default': { base_url: 'https://example.test/redirect' } } }));
    const failed = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(failed.data.config_source).toMatchObject({ availability: 'unavailable', local_credentials: 'rejected', issues: ['LOCAL_CREDENTIAL_BINDING_MISMATCH'] });
    expect(failed.data.providers.instances).toEqual([]);
  });

  it('reports invalid CLI secret files and busy transactions without falling back to env-only success', async () => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), '{}');
    await writeFile(join(localHome, 'secrets.json'), '{fixture-private-invalid', { mode: 0o600 });
    await boot();
    const invalid = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(invalid.data.config_source).toMatchObject({ availability: 'unavailable', local_credentials: 'invalid', issues: ['LOCAL_CREDENTIALS_INVALID'] });
    expect(JSON.stringify(invalid)).not.toContain('fixture-private-invalid');
    expect((await saveSource(false)).code).toBe(0);
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source).toMatchObject({ availability: 'ready', local_credentials: 'ignored' });
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({ schema_version: '1', values: {} }));
    await writeFile(join(localHome, '.config-access.lock'), '{}');
    expect((await saveSource(true)).code).toBe(0);
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.issues).toEqual(['LOCAL_CONFIG_BUSY']);
    await rm(join(localHome, '.config-access.lock'));
    await rm(join(localHome, 'secrets.json'));
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source).toMatchObject({ availability: 'ready', local_credentials: 'missing' });
  });

  it('preserves local-base compatibility and isolates the local file when reuse is disabled', async () => {
    const localPath = join(home, 'local-config.json');
    const localConfig = JSON.stringify({
      defaults: { search_lane: 'exa.search' },
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'LOCAL_EXA_KEY' } },
    });
    await writeFile(localPath, localConfig);
    vi.stubEnv('NB_SEARCH_CONFIG', localPath);
    vi.stubEnv('LOCAL_EXA_KEY', 'fixture-local-key');
    await boot('[nb_search.execution]\nsearch_timeout_ms = 15000\n');

    const original = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(original.data.search.default_lane).toBe('exa.search');
    expect(original.data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(true);
    expect((await saveSource(false)).code).toBe(0);
    const isolated = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(isolated.data.search.default_lane).toBe('github.repositories');
    expect(isolated.data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(false);
    expect((await get<Record<string, unknown>>('/config')).data['nb_search_source']).toEqual({ reuse_local_config: false });
    expect((await saveSource(true)).code).toBe(0);
    const restored = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(restored.data.revision).toBe(original.data.revision);
    expect(await readFile(localPath, 'utf8')).toBe(localConfig);
    const isolatedDir = join(home, 'cache', 'nb-search');
    const isolatedEntry = (await readdir(isolatedDir)).find((entry) => entry.startsWith('isolated-config.') && entry.endsWith('.json'));
    expect(isolatedEntry).toBeDefined();
    expect(await readFile(join(isolatedDir, isolatedEntry!), 'utf8')).toBe('{}');
    expect(process.env['NB_SEARCH_CONFIG']).toBe(localPath);
    expect(process.env['NB_SEARCH_HOME']).toBe(join(home, 'local-nb-search'));
    expect(JSON.stringify([original, isolated, restored])).not.toContain('fixture-local-key');
  });

  it('keeps Kiki overrides and their credential environment in both source modes', async () => {
    const localPath = join(home, 'local-config.json');
    await writeFile(localPath, JSON.stringify({ defaults: { search_lane: 'context7.docs' } }));
    vi.stubEnv('NB_SEARCH_CONFIG', localPath);
    vi.stubEnv('KIKI_EXA_KEY', 'fixture-kiki-key');
    await boot(`
[nb_search.defaults]
search_lane = "exa.search"
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "KIKI_EXA_KEY"
`);
    for (const reuse of [true, false, true]) {
      expect((await saveSource(reuse)).code).toBe(0);
      const capabilities = await get<NbSearchCapabilities>('/nb-search/capabilities');
      expect(capabilities.data.search.default_lane).toBe('exa.search');
      expect(capabilities.data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(true);
      expect(capabilities.data.config_source).toEqual({
        reuse_local_config: reuse,
        layers: reuse ? ['defaults', 'local', 'environment', 'kiki'] : ['defaults', 'environment', 'kiki'],
        local_config: reuse ? 'present' : 'ignored',
        local_credentials: reuse ? 'missing' : 'ignored',
        credential_source: 'environment',
        availability: 'ready',
        issues: [],
      });
      expect(JSON.stringify(capabilities)).not.toContain('fixture-kiki-key');
    }
    const saved = await readFile(join(home, 'config.toml'), 'utf8');
    expect(saved).toContain('KIKI_EXA_KEY');
    expect(saved).not.toContain('fixture-kiki-key');
  });

  it('exposes invalid local configuration without stale success and can recover by disabling reuse', async () => {
    const localPath = join(home, 'local-config.json');
    await writeFile(localPath, '{}');
    vi.stubEnv('NB_SEARCH_CONFIG', localPath);
    await boot('[nb_search.defaults]\nsearch_lane = "context7.docs"\n');
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.search.default_lane).toBe('context7.docs');
    await writeFile(localPath, '{fixture-private-value invalid json');
    const failed = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(failed.data.config_source).toMatchObject({ availability: 'ready', local_config: 'invalid', local_credentials: 'ignored' });
    expect(failed.data.config_source?.issues).toContain('LOCAL_CONFIG_INVALID_IGNORED');
    expect(failed.data.search.lanes.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain('fixture-private-value');
    expect((await get<{ search: { available: boolean } }>('/nb-search/test')).data.search.available).toBe(true);
    expect((await saveSource(false)).code).toBe(0);
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.search.default_lane).toBe('context7.docs');
    const response = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: { execution: { search_timeout_ms: 17000 } } }),
    });
    expect((await response.json() as Envelope<unknown>).code).toBe(0);
    expect(await readFile(localPath, 'utf8')).toBe('{fixture-private-value invalid json');
    expect((await saveSource(true)).code).toBe(0);
    const degradedAgain = (await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source;
    expect(degradedAgain?.availability).toBe('ready');
    expect(degradedAgain?.issues).toContain('LOCAL_CONFIG_INVALID_IGNORED');
    await writeFile(localPath, '{}');
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.availability).toBe('ready');
  });

  it('distinguishes an optional missing local base from an explicitly missing configuration', async () => {
    await boot();
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source).toMatchObject({ local_config: 'missing', availability: 'ready' });
    vi.stubEnv('NB_SEARCH_CONFIG', join(home, 'missing-config.json'));
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source).toMatchObject({ local_config: 'missing', availability: 'unavailable', issues: ['LOCAL_CONFIG_NOT_FOUND'] });
  });

  it('NB-02 refuses to overwrite external same-domain changes made during validation', async () => {
    await boot('[nb_search.execution]\nsearch_timeout_ms = 15000\n');
    const service = server!.core.accessor.get(INbSearchService);
    const validate = service.validateConfiguration.bind(service);
    const entered = deferredVoid();
    const resume = deferredVoid();
    const spy = vi.spyOn(service, 'validateConfiguration').mockImplementation(async (config, reuse) => {
      entered.resolve();
      await resume.promise;
      return validate(config, reuse);
    });
    const pending = authedFetch(server!, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: { execution: { retry_count: 2 } }, nb_search_source: { reuse_local_config: false } }),
    });
    try {
      await entered.promise;
      const external = '[nb_search.execution]\nsearch_timeout_ms = 22000\n';
      await writeFile(join(home, 'config.toml'), external);
      resume.resolve();
      const response = await (await pending).json() as Envelope<unknown>;
      expect(response.code).toBe(40001);
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(external);
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
  });

  it('serializes canonical edits and atomically rejects an invalid combined source and config save', async () => {
    await boot();
    const post = async (body: unknown): Promise<Envelope<unknown>> => {
      const response = await authedFetch(server as RunningServer, base, '/api/config', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return await response.json() as Envelope<unknown>;
    };
    const responses = await Promise.all([
      post({ nb_search: { execution: { max_concurrency: 3 } } }),
      post({ nb_search: { execution: { retry_count: 2 } } }),
    ]);
    expect(responses.map((response) => response.code)).toEqual([0, 0]);
    const saved = await get<{ nb_search: { execution: unknown } }>('/config');
    expect(saved.data.nb_search.execution).toEqual({ max_concurrency: 3, retry_count: 2 });
    const before = await readFile(join(home, 'config.toml'), 'utf8');
    expect((await post({
      nb_search_source: { reuse_local_config: false },
      nb_search: { defaults: { search_lane: 'unregistered.search' } },
      replace_domains: ['nb_search'],
    })).code).toBe(40001);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.reuse_local_config).toBe(true);
  });

  it('reports keyless repository search and fetch ready without configuration', async () => {
    vi.stubEnv('NB_SEARCH_GITHUB_TOKEN', undefined);
    await boot();

    const response = await get<{
      search: { configured: boolean; available: boolean; selection?: string; issues: string[] };
      fetch: { configured: boolean; available: boolean; selection?: string };
    }>('/nb-search/test');

    expect(response.code).toBe(0);
    expect(response.data.search).toEqual({
      configured: true,
      available: true,
      selection: 'github.repositories',
      issues: ['RATE_LIMIT_UNAUTHENTICATED'],
    });
    expect(response.data.fetch.configured).toBe(true);
    expect(response.data.fetch.available).toBe(true);
    expect(response.data.fetch.selection).toBe('direct.fetch -> jina.reader');
  });

  it('reports a configured lane and never exposes credential values', async () => {
    vi.stubEnv('TEAM_EXA_API_KEY', 'secret-value');
    await boot(`
[nb_search.credential_slots."exa.default"]
provider_id = "exa"
env = "TEAM_EXA_API_KEY"

[nb_search.defaults]
search_lane = "exa.search"
`);

    const capabilities = await get<{
      search: { default_lane?: string };
    }>('/nb-search/capabilities');
    const status = await get<{
      search: { configured: boolean; available: boolean; selection?: string; issues: string[] };
    }>('/nb-search/test');

    expect(capabilities.data.search.default_lane).toBe('exa.search');
    expect(status.data.search).toEqual({
      configured: true,
      available: true,
      selection: 'exa.search',
      issues: [],
    });
    expect(JSON.stringify(capabilities)).not.toContain('secret-value');
    expect(JSON.stringify(status)).not.toContain('secret-value');
  });

  it('reports a typed default lane as ready through capabilities and test status', async () => {
    await boot(`
[nb_search.defaults]
search_lane = "context7.docs"
`);

    const capabilities = await get<{
      search: {
        default_lane?: string;
        lanes: Array<{ id: string; output: { channel: string; schema_id: string } }>;
      };
    }>('/nb-search/capabilities');
    const status = await get<{
      search: { configured: boolean; available: boolean; selection?: string; issues: string[] };
    }>('/nb-search/test');

    expect(capabilities.data.search.lanes.find((lane) => lane.id === 'context7.docs')).toMatchObject({
      output: { channel: 'typed', schema_id: 'nb-search.docs-context@1' },
    });
    expect(status.data.search).toEqual({
      configured: true,
      available: true,
      selection: 'context7.docs',
      issues: [],
    });
  });
});

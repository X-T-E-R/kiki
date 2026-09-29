import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { IFileSystemStorageService, INbSearchService } from '@kiki/agent-core-v2';
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

  it('manages only Kiki-owned values with reveal, precedence, overwrite, clear, CAS and server-home isolation', async () => {
    await boot('[nb_search.execution]\nsearch_timeout_ms = 15000\n');
    const exchange = async (path: string, body: object) => {
      const response = await authedFetch(server!, base, `/api/nb-search/credentials/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return await response.json() as Envelope<{ version: string; binding_version: string; stored: boolean; active: boolean; source: string; value?: string }>;
    };
    const read = (reveal = false) => exchange('read', { instance_id: 'exa.default', reveal });
    let expectedBinding = '';
    const write = (value: string | null, expected_version: string) => exchange('write', { instance_id: 'exa.default', value, expected_version, expected_binding: expectedBinding });
    for (const path of ['read', 'write']) {
      const unauthenticated = await fetch(`${base}/api/nb-search/credentials/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instance_id: 'exa.default', reveal: true, value: 'fixture-unauthed', expected_version: 'none' }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(JSON.stringify(await unauthenticated.json())).not.toContain('fixture-unauthed');
    }
    const first = await read();
    expectedBinding = first.data.binding_version;
    expect(first.data).toMatchObject({ stored: false, source: 'none', version: 'none' });
    const saved = await write('fixture-managed-1', first.data.version);
    expect(saved.code).toBe(0);
    expect(saved.data).toMatchObject({ stored: true, source: 'managed', active: true });
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.credential_source).toBe('environment+managed');
    expect(JSON.stringify(saved)).not.toContain('fixture-managed-1');
    expect((await read()).data.value).toBeUndefined();
    expect((await read(true)).data.value).toBe('fixture-managed-1');
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(true);
    expect(JSON.stringify(await get<NbSearchCapabilities>('/nb-search/capabilities'))).not.toContain('fixture-managed-1');
    expect(JSON.stringify(await get<Record<string, unknown>>('/config'))).not.toContain('fixture-managed-1');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('fixture-managed-1');
    const managedPath = join(home, 'secrets/nb-search/gui-credentials.json');
    expect(await readFile(managedPath, 'utf8')).toContain('fixture-managed-1');
    if (process.platform !== 'win32') expect((await stat(managedPath)).mode & 0o077).toBe(0);
    const invalid = await exchange('write', { instance_id: 'exa.default', value: 'fixture-invalid-secret', expected_version: 'invalid', expected_binding: expectedBinding });
    expect(invalid.code).toBe(40001);
    expect(JSON.stringify(invalid)).not.toContain('fixture-invalid-secret');
    const results = await Promise.all([write('fixture-managed-2', saved.data.version), write('fixture-managed-3', saved.data.version)]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 40941]);
    expect(JSON.stringify(results)).not.toContain('fixture-managed-2');
    expect(JSON.stringify(results)).not.toContain('fixture-managed-3');
    expect((await write('fixture-managed-late', saved.data.version)).code).toBe(40941);
    const current = await read(true);
    expect(['fixture-managed-2', 'fixture-managed-3']).toContain(current.data.value);
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', 'fixture-env-priority');
    expect((await read()).data).toMatchObject({ source: 'managed', active: true });
    expect((await read(true)).data.value).toBe(current.data.value);
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', undefined);
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-local-priority' } }));
    expect((await read()).data).toMatchObject({ source: 'managed', active: true });
    expect((await read(true)).data.value).toBe(current.data.value);
    expect(JSON.stringify(await get<NbSearchCapabilities>('/nb-search/capabilities'))).not.toContain('fixture-local-priority');
    const fallback = await write(null, current.data.version);
    expect(fallback.data).toMatchObject({ stored: false, source: 'local', version: 'none', env_name: 'NB_SEARCH_EXA_API_KEY' });
    expect(JSON.stringify(fallback)).not.toContain('fixture-local-priority');
    expect((await read(true)).data.value).toBe('fixture-local-priority');
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', 'fixture-env-priority');
    expect((await read()).data).toMatchObject({ source: 'environment', env_name: 'NB_SEARCH_EXA_API_KEY' });
    expect((await read()).data.value).toBeUndefined();
    expect((await read(true)).data.value).toBe('fixture-env-priority');
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', undefined);
    expect((await saveSource(false)).code).toBe(0);
    expect((await read(true)).data).toMatchObject({ source: 'none' });
    expect((await read(true)).data.value).toBeUndefined();
    const otherHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-nb-search-other-'));
    const previousHome = home;
    try {
      await server!.close();
      server = undefined;
      home = otherHome;
      vi.stubEnv('NB_SEARCH_HOME', join(home, 'local-nb-search'));
      await boot();
      expect((await read(true)).data).toMatchObject({ stored: false, source: 'none' });
    } finally {
      if (server !== undefined) await server.close();
      server = undefined;
      home = previousHome;
      await rm(otherHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('uses the Kiki-overridden slot when local reuse is disabled and refuses silent rebinding', async () => {
    await boot('[nb_search_source]\nreuse_local_config = false\n[nb_search.credential_slots."exa.default"]\nprovider_id = "exa"\nenv = "KIKI_CUSTOM_EXA_KEY"\n');
    const exchange = async (path: string, body: object) => (await (await authedFetch(server!, base, `/api/nb-search/credentials/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<{ stored: boolean; active: boolean; source: string; version: string; binding_version: string; value?: string }>;
    const initial = await exchange('read', { instance_id: 'exa.default', reveal: false });
    const saved = await exchange('write', { instance_id: 'exa.default', value: 'fixture-custom-managed', expected_version: initial.data.version, expected_binding: initial.data.binding_version });
    expect(saved.code).toBe(0);
    expect(saved.data).toMatchObject({ source: 'managed', active: true });
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.config_source?.credential_source).toBe('environment+managed');
    expect((await exchange('read', { instance_id: 'exa.default', reveal: true })).data.value).toBe('fixture-custom-managed');
    const change = await authedFetch(server!, base, '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nb_search: { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'KIKI_DIFFERENT_EXA_KEY' } } } }) });
    expect((await change.json() as Envelope<unknown>).code).toBe(0);
    const stale = await exchange('read', { instance_id: 'exa.default', reveal: true });
    expect(stale.data).toMatchObject({ stored: true, source: 'none', active: false });
    expect(stale.data.value).toBeUndefined();
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(false);
    const updated = await exchange('write', { instance_id: 'exa.default', value: 'fixture-custom-rebound', expected_version: stale.data.version, expected_binding: stale.data.binding_version });
    expect(updated.data).toMatchObject({ source: 'managed', active: true });
    expect((await exchange('read', { instance_id: 'exa.default', reveal: true })).data.value).toBe('fixture-custom-rebound');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('fixture-custom-rebound');
  });

  it('does not send a Kiki-managed key to another provider through an aliased env slot', async () => {
    await boot('[nb_search_source]\nreuse_local_config = false\n');
    const exchange = async (path: string, body: object) => (await (await authedFetch(server!, base, `/api/nb-search/credentials/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<{ stored: boolean; active: boolean; source: string; version: string; binding_version: string; value?: string }>;
    const read = (instance_id: string, reveal = false) => exchange('read', { instance_id, reveal });
    const write = (instance_id: string, value: string | null, expected_version: string, expected_binding: string) => exchange('write', { instance_id, value, expected_version, expected_binding });
    const original = await read('exa.default');
    const created = await write('exa.default', 'fixture-private-exa', original.data.version, original.data.binding_version);
    expect(created.data).toMatchObject({ stored: true, active: true });
    const safe = (await get<NbSearchCapabilities>('/nb-search/capabilities')).data;
    expect(safe.providers.instances.find((item) => item.id === 'exa.default')?.credential.configured).toBe(true);
    expect(safe.providers.instances.find((item) => item.id === 'tavily.default')?.credential.configured).toBe(false);
    const alias = await authedFetch(server!, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: {
        credential_slots: { 'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_EXA_API_KEY' } },
        provider_instances: { 'tavily.default': { base_url: 'https://example.test/other-provider' } },
      } }),
    });
    expect((await alias.json() as Envelope<unknown>).code).toBe(0);
    const blocked = (await get<NbSearchCapabilities>('/nb-search/capabilities')).data;
    expect(blocked.providers.instances.find((item) => item.id === 'tavily.default')?.credential.configured).toBe(false);
    expect(blocked.providers.instances.find((item) => item.id === 'exa.default')?.credential.configured).toBe(false);
    expect(JSON.stringify(blocked)).not.toContain('fixture-private-exa');
    const saved = await read('exa.default', true);
    expect(saved.data).toMatchObject({ stored: true, active: false });
    expect(saved.data.value).toBeUndefined();
    expect(saved.data.binding_version).not.toBe(created.data.binding_version);
    expect((await write('exa.default', 'fixture-stale-alias-key', created.data.version, created.data.binding_version)).code).toBe(40941);
    expect((await write('exa.default', 'fixture-unsafe-alias-key', saved.data.version, saved.data.binding_version)).code).toBe(40001);
    const tavily = await read('tavily.default');
    expect((await write('tavily.default', 'fixture-other-private', tavily.data.version, tavily.data.binding_version)).code).toBe(40001);
    const reset = await authedFetch(server!, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: { credential_slots: { 'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' } } } }),
    });
    expect((await reset.json() as Envelope<unknown>).code).toBe(0);
    expect((await read('exa.default', true)).data.value).toBe('fixture-private-exa');
  });

  it('rejects stale editor writes after another client changes the credential binding', async () => {
    await boot('[nb_search_source]\nreuse_local_config = false\n');
    const exchange = async (path: string, body: object) => (await (await authedFetch(server!, base, `/api/nb-search/credentials/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<{ stored: boolean; active: boolean; source: string; version: string; binding_version: string; value?: string }>;
    const read = () => exchange('read', { instance_id: 'exa.default', reveal: false });
    const before = await read();
    expect(before.data).toMatchObject({ stored: false, version: 'none' });
    const missingBinding = await exchange('write', {
      instance_id: 'exa.default', value: 'fixture-unbound-key', expected_version: before.data.version,
    });
    expect(missingBinding.code).toBe(40001);
    expect(JSON.stringify(missingBinding)).not.toContain('fixture-unbound-key');
    const change = await authedFetch(server!, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nb_search: {
        credential_slots: { 'exa.default': { provider_id: 'exa', env: 'KIKI_REBOUND_EXA_KEY' } },
        provider_instances: { 'exa.default': { base_url: 'https://example.test/new-target' } },
      } }),
    });
    expect((await change.json() as Envelope<unknown>).code).toBe(0);
    const stale = await exchange('write', {
      instance_id: 'exa.default', value: 'fixture-outdated-key',
      expected_version: before.data.version, expected_binding: before.data.binding_version,
    });
    expect(stale.code).toBe(40941);
    expect(JSON.stringify(stale)).not.toContain('fixture-outdated-key');
    expect((await read()).data).toMatchObject({ stored: false, version: 'none' });
    const current = await read();
    expect(current.data.binding_version).not.toBe(before.data.binding_version);
    const accepted = await exchange('write', {
      instance_id: 'exa.default', value: 'fixture-confirmed-key',
      expected_version: current.data.version, expected_binding: current.data.binding_version,
    });
    expect(accepted.code).toBe(0);
    expect(accepted.data).toMatchObject({ stored: true, active: true });
    expect(JSON.stringify(accepted)).not.toContain('fixture-confirmed-key');
    expect((await get<NbSearchCapabilities>('/nb-search/capabilities')).data.providers.instances.find((item) => item.id === 'exa.default')?.credential.configured).toBe(true);
  });

  it('rejects a credential save when another client changes its binding before the credential lands', async () => {
    await boot('[nb_search_source]\nreuse_local_config = false\n');
    const exchange = async (path: string, body: object) => (await (await authedFetch(server!, base, `/api/nb-search/credentials/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<{ stored: boolean; active: boolean; source: string; version: string; binding_version: string; value?: string }>;
    const read = (reveal = false) => exchange('read', { instance_id: 'exa.default', reveal });
    const before = await read();
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const write = storage.write.bind(storage);
    const entered = deferredVoid();
    const resume = deferredVoid();
    let paused = false;
    const spy = vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (!paused && scope === 'secrets/nb-search' && key === 'gui-credentials.json') {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
      return write(scope, key, data, options);
    });
    const pending = exchange('write', {
      instance_id: 'exa.default', value: 'fixture-old-target-key',
      expected_version: before.data.version, expected_binding: before.data.binding_version,
    });
    try {
      await entered.promise;
      const change = await authedFetch(server!, base, '/api/config', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nb_search: {
          credential_slots: { 'exa.default': { provider_id: 'exa', env: 'KIKI_NEW_TARGET_KEY' } },
          provider_instances: { 'exa.default': { base_url: 'https://example.test/new-target' } },
        } }),
      });
      expect((await change.json() as Envelope<unknown>).code).toBe(0);
      const current = await read();
      expect(current.data).toMatchObject({ stored: false, version: 'none' });
      expect(current.data.binding_version).not.toBe(before.data.binding_version);
      const newTargetSave = exchange('write', {
        instance_id: 'exa.default', value: 'fixture-new-target-key',
        expected_version: current.data.version, expected_binding: current.data.binding_version,
      });
      resume.resolve();
      const stale = await pending;
      expect(stale.code).toBe(40941);
      expect(JSON.stringify(stale)).not.toContain('fixture-old-target-key');
      expect((await newTargetSave).code).toBe(0);
      expect((await read(true)).data.value).toBe('fixture-new-target-key');
      expect(await readFile(join(home, 'secrets/nb-search/gui-credentials.json'), 'utf8')).not.toContain('fixture-old-target-key');
    } finally {
      resume.resolve();
      spy.mockRestore();
    }
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

  it('reports an invalid CLI secret file without killing keyless lanes or substituting an account', async () => {
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), '{}');
    await writeFile(join(localHome, 'secrets.json'), '{fixture-private-invalid', { mode: 0o600 });
    await boot();
    const invalid = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(invalid.data.config_source).toMatchObject({ availability: 'ready', local_credentials: 'invalid', issues: ['LOCAL_CREDENTIALS_INVALID'] });
    expect(JSON.stringify(invalid)).not.toContain('fixture-private-invalid');
    const lane = (id: string) => invalid.data.search.lanes.find((entry) => entry.id === id);
    expect(lane('github.repositories')?.availability).toBe('ready');
    expect(lane('duckduckgo.search')?.availability).toBe('ready');
    expect(lane('exa.search')?.availability).toBe('unavailable');
    expect(lane('exa.search')?.issues.map((issue) => issue.code)).toContain('LANE_NOT_CONFIGURED');
    expect(invalid.data.providers.instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(false);
    const readiness = await get<{ search: { available: boolean; selection?: string; issues: string[] } }>('/nb-search/test');
    expect(readiness.data.search).toMatchObject({ available: true, selection: 'github.repositories' });
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

  it('keeps an explicit env lane running on an unreadable CLI secret file without substituting the CLI slot', async () => {
    vi.stubEnv('NB_SEARCH_TAVILY_API_KEY', 'fixture-env-tavily');
    const localHome = await localCliHome();
    await writeFile(join(localHome, 'config.json'), '{}');
    await writeFile(join(localHome, 'secrets.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    await boot();
    const capabilities = await get<NbSearchCapabilities>('/nb-search/capabilities');
    expect(capabilities.data.config_source).toMatchObject({ availability: 'ready', local_credentials: 'unreadable', issues: ['LOCAL_CREDENTIALS_UNREADABLE'] });
    const instances = capabilities.data.providers.instances;
    expect(instances.find((entry) => entry.id === 'tavily.default')?.credential.configured).toBe(true);
    expect(instances.find((entry) => entry.id === 'exa.default')?.credential.configured).toBe(false);
    const lane = (id: string) => capabilities.data.search.lanes.find((entry) => entry.id === id);
    expect(lane('tavily.search')?.availability).toBe('ready');
    expect(lane('github.repositories')?.availability).toBe('ready');
    expect(lane('exa.search')?.availability).toBe('unavailable');
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

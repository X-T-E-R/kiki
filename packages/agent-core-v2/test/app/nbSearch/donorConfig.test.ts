import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNbSearchRuntime } from '@nb-corp/nb-search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nbSearchConfigIssues, nbSearchConfigRevision, nbSearchPaths, pinnedNbSearchConfig, resolveNbSearchConfig } from '#/app/nbSearch/donorConfig';
import { applyLocalCredentials } from '#/app/nbSearch/localCredentials';
import { copyNbSearchEnvironment } from '#/app/nbSearch/environment';

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nb-donor-parity-'));
  const path = join(home, 'config.json');
  await writeFile(path, '{}');
  env = { NB_SEARCH_HOME: home, NB_SEARCH_CONFIG: path };
});

afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('NB-06 credential environment aliases', () => {
  const binding = { instance: 'exa.default', provider: 'exa', slot: 'exa.default', env: 'NB_SEARCH_EXA_API_KEY', base_url: null };
  const redirect = {
    credential_slots: { 'tavily.default': { provider_id: 'tavily', env: 'nb_search_exa_api_key' } },
    provider_instances: { 'tavily.default': { base_url: 'https://example.test/redirect' } },
    defaults: { search_lane: 'tavily.search' },
  };

  it.each([false, true])('rejects a Windows alias consumer redirect with imported metadata=%s', (withBindings) => {
    const windows = copyNbSearchEnvironment(env, 'win32');
    expect(() => applyLocalCredentials(windows, {
      schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-nb06-private-key' },
      bindings: withBindings ? { NB_SEARCH_EXA_API_KEY: [binding] } : undefined,
    }, {}, redirect)).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('uses the same Windows equivalence for the allowset and imported metadata env names', () => {
    const applied = applyLocalCredentials(copyNbSearchEnvironment(env, 'win32'), {
      schema_version: '1', values: { Nb_Search_Exa_Api_Key: 'fixture-alias-key' },
      bindings: { nb_search_exa_api_key: [{ ...binding, env: 'NB_SEARCH_EXA_API_KEY' }] },
    }, { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'nb_search_exa_api_key' } } }, undefined);
    expect(applied.usedLocalCredentials).toBe(true);
    expect(applied.env['nb_search_exa_api_key']).toBe('fixture-alias-key');
  });

  it.each([false, true])('rejects conflicting Windows value aliases regardless of record order=%s', (reverse) => {
    const entries = [['NB_SEARCH_EXA_API_KEY', 'fixture-first'], ['nb_search_exa_api_key', 'fixture-second']];
    const values = Object.fromEntries(reverse ? entries.toReversed() : entries);
    expect(() => applyLocalCredentials(copyNbSearchEnvironment(env, 'win32'), { schema_version: '1', values }, {}, undefined)).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('does not merge or overwrite case-equivalent imported binding records', () => {
    expect(() => applyLocalCredentials(copyNbSearchEnvironment(env, 'win32'), {
      schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-alias-key' },
      bindings: { NB_SEARCH_EXA_API_KEY: [binding], nb_search_exa_api_key: [{ ...binding, env: 'nb_search_exa_api_key' }] },
    }, {}, undefined)).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it('requires the complete consumer set when canonical slots share a Windows env alias', () => {
    const canonical = { credential_slots: redirect.credential_slots };
    const values = { NB_SEARCH_EXA_API_KEY: 'fixture-alias-key' };
    const windows = copyNbSearchEnvironment(env, 'win32');
    expect(() => applyLocalCredentials(windows, { schema_version: '1', values, bindings: { NB_SEARCH_EXA_API_KEY: [binding] } }, canonical, undefined)).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
    const tavily = { instance: 'tavily.default', provider: 'tavily', slot: 'tavily.default', env: 'nb_search_exa_api_key', base_url: null };
    const applied = applyLocalCredentials(windows, { schema_version: '1', values, bindings: { NB_SEARCH_EXA_API_KEY: [binding, tavily] } }, canonical, undefined);
    expect(applied.env['nb_search_exa_api_key']).toBe('fixture-alias-key');
  });

  it.each([
    { instance: 'EXA.default' }, { provider: 'EXA' }, { slot: 'EXA.default' }, { base_url: 'https://example.test/redirect' },
  ])('keeps every non-env imported binding field strict (%j)', (change) => {
    expect(() => applyLocalCredentials(copyNbSearchEnvironment(env, 'win32'), {
      schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-alias-key' },
      bindings: { nb_search_exa_api_key: [{ ...binding, ...change, env: 'nb_search_exa_api_key' }] },
    }, {}, undefined)).toThrow('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });

  it.each([false, true])('keeps differently cased POSIX consumers distinct with imported metadata=%s', async (withBindings) => {
    const posix = copyNbSearchEnvironment(env, 'linux');
    const applied = applyLocalCredentials(posix, {
      schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-nb06-private-key' },
      bindings: withBindings ? { NB_SEARCH_EXA_API_KEY: [binding] } : undefined,
    }, {}, redirect);
    expect(applied.env['nb_search_exa_api_key']).toBeUndefined();
    const capabilities = await createNbSearchRuntime({ env: applied.env, config: redirect }).capabilities({});
    expect(capabilities.providers.instances.find((instance) => instance.id === 'tavily.default')?.credential.configured).toBe(false);
    expect(JSON.stringify(capabilities)).not.toContain('fixture-nb06-private-key');
  });
});

describe('nb-search independent donor parity', () => {
  it.each(['win32', 'linux'] as const)('NB-01 preserves %s lookup and hasOwn semantics across copies', (platform) => {
    const input = { nb_search_home: home, mixed_key: '' };
    const copied = copyNbSearchEnvironment(input, platform);
    const again = copyNbSearchEnvironment(copied);
    expect(Object.hasOwn(again, 'MIXED_KEY')).toBe(platform === 'win32');
    expect(again['MIXED_KEY']).toBe(platform === 'win32' ? '' : undefined);
    expect(again['mixed_key']).toBe('');
    Object.defineProperty(again, 'MiXeD_KeY', { value: 'fixture-update', configurable: true, enumerable: true });
    expect(again['mixed_key']).toBe(platform === 'win32' ? 'fixture-update' : '');
    expect(input).toEqual({ nb_search_home: home, mixed_key: '' });
  });

  it('NB-05 matches the unmodified installed donor defaults, including tavily.extract', async () => {
    const expected = await createNbSearchRuntime({ env }).capabilities({});
    const resolved = resolveNbSearchConfig(env, {}, undefined);
    expect(resolved.lanes['tavily.extract']?.latency).toBe('fast');
    expect(resolved.defaults.search_lane).toBe('github.repositories');
    expect(resolved.lanes['duckduckgo.search']).toMatchObject({ provider_instance_id: 'duckduckgo.default', operation_id: 'search', cost: 'free' });
    expect(expected.search.default_lane).toBe('github.repositories');
    expect(expected.search.lanes.find((lane) => lane.id === 'github.repositories')?.availability).toBe('ready');
    expect(expected.search.lanes.find((lane) => lane.id === 'duckduckgo.search')?.availability).toBe('ready');
    expect(nbSearchConfigRevision(resolved)).toBe(expected.revision);
    expect(resolved.lanes['tavily.crawl']).toMatchObject({ provider_instance_id: 'tavily.default', operation_id: 'crawl', latency: 'slow', cost: 'cheap' });
    expect(resolved.lanes['tavily.research']).toMatchObject({ provider_instance_id: 'tavily.default', operation_id: 'research', latency: 'slow', cost: 'expensive' });
    const configured = await createNbSearchRuntime({ env: { ...env, NB_SEARCH_TAVILY_API_KEY: 'fixture-donor-key' } }).capabilities({});
    expect(configured.search.lanes.find((lane) => lane.id === 'tavily.crawl')).toMatchObject({ output: { channel: 'typed', schema_id: 'nb-search.crawl@1' }, execution_modes: ['sync', 'async'], availability: 'ready' });
    expect(configured.search.lanes.find((lane) => lane.id === 'tavily.research')).toMatchObject({ output: { channel: 'typed', schema_id: 'nb-search.research@1' }, execution_modes: ['sync', 'async'], availability: 'ready' });
  });

  it('keeps parseResolvedConfig diagnostics to a field path and code', () => {
    let error: unknown;
    try {
      resolveNbSearchConfig(env, { defaults: { search_lane: 42 } } as never, undefined);
    } catch (caught) {
      error = caught;
    }
    expect(nbSearchConfigIssues(error)).toEqual(['EFFECTIVE_CONFIG_INVALID', 'CONFIGURATION_ERROR:defaults.search_lane']);
    expect(JSON.stringify(nbSearchConfigIssues(error))).not.toContain('42');
  });

  it.each([
    'Credential is invalid: fixture-private: rejected',
    'resolved configuration is invalid: fixture-private: rejected',
    'resolved configuration is invalid: defaults.search_lane.fixture-private: rejected',
  ])('does not treat arbitrary error text as a configuration path: %s', (message) => {
    expect(nbSearchConfigIssues(new Error(message))).toEqual([
      'EFFECTIVE_CONFIG_INVALID', 'CONFIGURATION_ERROR',
    ]);
  });

  it('identifies unsupported provider options without exposing their values', () => {
    const config = { provider_instances: { 'grok-multi-agent.default': { options: { unsupported_mode: 'fixture-private' } } } };
    const error = new Error('Provider instance grok-multi-agent.default has invalid options.');
    expect(nbSearchConfigIssues(error, config)).toEqual([
      'EFFECTIVE_CONFIG_INVALID',
      'CONFIGURATION_ERROR:provider_instances.grok-multi-agent.default.options.unsupported_mode',
    ]);
    expect(JSON.stringify(nbSearchConfigIssues(error, config))).not.toContain('fixture-private');
  });

  it.each([false, true])('NB-03 preserves absent home/jobs_root with local credentials=%s', async (hasKey) => {
    const canonical = { home: null, jobs_root: null };
    await writeFile(join(home, 'config.json'), JSON.stringify(canonical));
    const values: Record<string, string> = hasKey ? { NB_SEARCH_EXA_API_KEY: 'fixture-cli-key' } : {};
    const expected = await createNbSearchRuntime({ env: { ...env, ...values } }).capabilities({});
    const applied = applyLocalCredentials(env, { schema_version: '1', values }, canonical, undefined);
    const pinned = pinnedNbSearchConfig(applied.config);
    expect(pinned.home).toBeNull();
    expect(pinned.jobs_root).toBeNull();
    const neutralPath = join(home, 'neutral.json');
    await writeFile(neutralPath, '{}');
    const actual = await createNbSearchRuntime({ env: { ...applied.env, NB_SEARCH_CONFIG: neutralPath }, config: pinned }).capabilities({});
    expect(actual.revision).toBe(expected.revision);
  });

  it.runIf(process.platform === 'win32').each(['fixture-explicit-key', ''])('NB-01 preserves mixed-case Windows env and explicit value %s', (value) => {
    const input = { nb_search_home: home, nB_sEaRcH_cOnFiG: join(home, 'config.json'), nb_search_exa_api_key: value };
    const result = applyLocalCredentials(input, { schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'fixture-cli-key' } }, {}, undefined);
    expect(result.env['NB_SEARCH_EXA_API_KEY']).toBe(value);
    expect(result.usedLocalCredentials).toBe(false);
    expect(nbSearchPaths(result.env).home === home).toBe(true);
    expect(nbSearchPaths(result.env).canonical === join(home, 'config.json')).toBe(true);
    expect(Object.keys(input)).toEqual(['nb_search_home', 'nB_sEaRcH_cOnFiG', 'nb_search_exa_api_key']);
  });
});

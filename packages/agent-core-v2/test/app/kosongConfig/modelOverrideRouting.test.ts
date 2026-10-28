import { afterEach, describe, expect, it } from 'vitest';
import { getModelResponseSchema } from '@kiki/protocol';
import { KIMI_DEFAULT_BASE_URL } from '#/kosong/provider/providers/kimi/kimi.contrib';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import { IModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutation';
import { ModelCatalogMutationService } from '#/app/kosongConfig/modelCatalogMutationService';
import type { ModelsSection } from '#/kosong/model/model';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { stubModelOAuthTokens } from '../../kosong/stubs';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createHost(storage: InMemoryStorageService): TestInstantiationService {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/model-override-routing'));
  ix.stub(IFileSystemStorageService, storage);
  ix.stub(IModelOAuthTokens, stubModelOAuthTokens());
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  ix.set(IModelCatalogMutationService, new SyncDescriptor(ModelCatalogMutationService));
  return ix;
}

describe('model override routing fields', () => {
  it('reports identity fields written under overrides and leaves the model binding in place', async () => {
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode([
      '[providers.edge]',
      'type = "openai"',
      'api_key = "fixture-gateway-key"',
      'base_url = "https://provider.example.test/v1"',
      '',
      '[models.gateway]',
      'provider = "edge"',
      'model = "gemini-example"',
      'protocol = "google-genai"',
      'base_url = "https://model.example.test/gemini"',
      'max_context_size = 8192',
      '',
      '[models.gateway.overrides]',
      'protocol = "openai"',
      'base_url = "https://ignored.example.test"',
      'max_context_size = 4096',
      '',
      '[models.located]',
      'provider = "edge"',
      'model = "chat-example"',
      'base_url = "https://model.example.test/v1"',
      'max_context_size = 8192',
      '',
    ].join('\n')));
    const host = createHost(storage);
    const config = host.get(IConfigService);
    await config.ready;

    expect(config.diagnostics()).toContainEqual({
      domain: MODELS_SECTION,
      severity: 'warning',
      message: "[models] entry 'gateway' overrides rejected base_url, protocol; set those fields on the model itself. They were not applied.",
    });
    expect(config.get<ModelsSection>(MODELS_SECTION)['gateway']).toMatchObject({
      provider: 'edge',
      model: 'gemini-example',
      protocol: 'google-genai',
      baseUrl: 'https://model.example.test/gemini',
      maxContextSize: 8192,
      overrides: { maxContextSize: 4096 },
    });
    expect(config.get<ModelsSection>(MODELS_SECTION)['gateway']?.overrides).not.toHaveProperty('protocol');
    expect(config.get<ModelsSection>(MODELS_SECTION)['gateway']?.overrides).not.toHaveProperty('baseUrl');

    const catalog = host.get(IModelCatalogMutationService);
    const gateway = await catalog.readModel('gateway');
    expect(gateway).toMatchObject({
      protocol: 'google-genai',
      effective_protocol: 'google-genai',
      protocol_source: 'model',
      endpoint_source: 'model',
      auth_source: 'provider',
      base_url: 'https://model.example.test/gemini',
    });
    expect(gateway).not.toHaveProperty('endpoint_env');
    expect(gateway).not.toHaveProperty('auth_env');
    expect(gateway.issues).toContainEqual({
      code: 'model.override_routing_rejected',
      severity: 'warning',
      path: 'overrides',
      message: 'base_url, protocol',
    });
    const located = await catalog.readModel('located');
    expect(located.protocol).toBeUndefined();
    expect(located).toMatchObject({
      effective_protocol: 'openai',
      protocol_source: 'provider',
      endpoint_source: 'model',
      auth_source: 'provider',
      base_url: 'https://model.example.test/v1',
    });
    expect(located.base_url).not.toBe('https://provider.example.test/v1');
    expect(located.issues.some((issue) => issue.code === 'model.override_routing_rejected')).toBe(false);
    const wire = JSON.stringify({ gateway, located });
    expect(wire).not.toContain('fixture-gateway-key');
    expect(wire).not.toContain('https://ignored.example.test');
  });
});

describe('read-only effective model endpoints', () => {
  interface EndpointCase {
    source: string;
    modelBase?: string;
    providerBase?: string;
    envBase?: string;
    providerType?: string;
    expected?: string;
  }
  function endpointConfig(options: EndpointCase): string {
    return [
      '[providers.edge]',
      `type = ${JSON.stringify(options.providerType ?? 'kimi')}`,
      options.providerBase === undefined ? '' : `base_url = ${JSON.stringify(options.providerBase)}`,
      '[providers.edge.env]',
      options.envBase === undefined ? '' : `KIMI_BASE_URL = ${JSON.stringify(options.envBase)}`,
      '[models.chosen]',
      'provider = "edge"',
      'model = "example-model"',
      'max_context_size = 8192',
      options.modelBase === undefined ? '' : `base_url = ${JSON.stringify(options.modelBase)}`,
    ].join('\n');
  }
  const cases: EndpointCase[] = [
    { source: 'model', modelBase: ' https://model.example.test/v1 ', providerBase: 'https://provider.example.test/v1', envBase: 'https://env.example.test/v1', expected: 'https://model.example.test/v1' },
    { source: 'provider', providerBase: 'https://provider.example.test/v1', envBase: 'https://env.example.test/v1', expected: 'https://provider.example.test/v1' },
    { source: 'env', envBase: 'https://env.example.test/v1', expected: 'https://env.example.test/v1' },
    { source: 'vendor', expected: KIMI_DEFAULT_BASE_URL },
    { source: 'none', providerType: 'openai' },
  ];
  it.each(cases)('projects the $source endpoint without filling the stored base_url or changing configuration', async (options) => {
    const storage = new InMemoryStorageService();
    const host = createHost(storage);
    const document = host.get(IAtomicTomlDocumentStore);
    const original = endpointConfig(options);
    await document.setText('', 'config.toml', original);
    const catalog = host.get(IModelCatalogMutationService);
    const entity = await catalog.readModel('chosen');
    expect(entity.base_url).toBe(options.modelBase);
    expect(entity.effective_base_url).toBe(options.expected);
    expect(entity.endpoint_source).toBe(options.source);
    expect(entity.endpoint_env).toBe(options.source === 'env' ? 'KIMI_BASE_URL' : undefined);
    const wire = getModelResponseSchema.parse(JSON.parse(JSON.stringify(entity)));
    expect(wire.effective_base_url).toBe(options.expected);
    if (options.expected === undefined) expect(wire).not.toHaveProperty('effective_base_url');
    expect((await catalog.readModel('chosen')).revision).toBe(entity.revision);
    expect(await document.getText('', 'config.toml')).toBe(original);
  });
  it('rejects writes to the effective endpoint and keeps it out of ordinary model updates and creates', async () => {
    const storage = new InMemoryStorageService();
    const host = createHost(storage);
    const document = host.get(IAtomicTomlDocumentStore);
    const endpoint = 'https://env.example.test/v1';
    const original = endpointConfig({ source: 'env', envBase: endpoint });
    await document.setText('', 'config.toml', original);
    const catalog = host.get(IModelCatalogMutationService);
    const entity = await catalog.readModel('chosen');
    await expect(catalog.updateModel('chosen', JSON.parse(JSON.stringify({
      base_revision: entity.revision,
      display_name: 'Must not be written',
      effective_base_url: 'https://other.example.test/v1',
    })))).rejects.toMatchObject({ code: 'config.invalid' });
    await expect(catalog.createModel(JSON.parse(JSON.stringify({
      id: 'rejected', provider_id: 'edge', remote_id: 'rejected-remote', effective_base_url: endpoint,
    })))).rejects.toMatchObject({ code: 'config.invalid' });
    expect(await document.getText('', 'config.toml')).toBe(original);
    const updated = await catalog.updateModel('chosen', { base_revision: entity.revision, display_name: 'Renamed' });
    expect(updated.base_url).toBeUndefined();
    expect(updated.effective_base_url).toBe(endpoint);
    const created = await catalog.createModel({ id: 'another', provider_id: 'edge', remote_id: 'another-remote' });
    expect(created.base_url).toBeUndefined();
    expect(created.effective_base_url).toBe(endpoint);
    const models = host.get(IConfigService).inspect<ModelsSection>(MODELS_SECTION).userValue!;
    expect(models['chosen']).toMatchObject({ provider: 'edge', model: 'example-model', displayName: 'Renamed' });
    expect(models['another']).toEqual({ provider: 'edge', model: 'another-remote' });
    expect(await document.getText('', 'config.toml')).not.toMatch(/effective_base_url|effectiveBaseUrl/);
    await host.get(IConfigService).reload();
    expect((await catalog.readModel('chosen')).effective_base_url).toBe(endpoint);
  });
});

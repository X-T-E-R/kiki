import { afterEach, describe, expect, it } from 'vitest';

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

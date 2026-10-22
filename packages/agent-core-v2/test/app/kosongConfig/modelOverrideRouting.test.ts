import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import type { ModelsSection } from '#/kosong/model/model';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createConfig(storage: InMemoryStorageService): IConfigService {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap('/tmp/model-override-routing'));
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  return ix.get(IConfigService);
}

describe('model override routing fields', () => {
  it('reports identity fields written under overrides and leaves the model binding in place', async () => {
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode([
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
    ].join('\n')));
    const config = createConfig(storage);
    await config.ready;

    expect(config.diagnostics()).toContainEqual({
      domain: MODELS_SECTION,
      severity: 'error',
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
  });
});

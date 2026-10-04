import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginSettingsService, PluginSettingsService } from '#/app/plugin/pluginSettingsService';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

it('stores heterogeneous script secrets in the existing shared credential document and redacts GUI reads per plugin', async () => {
  const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../.tmp');
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(path.join(scratch, 'media-credentials-'));
  const storage = new FileStorageService(home, 0o700, 0o600);
  const ix = new TestInstantiationService();
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap(home));
  ix.stub(IFileSystemStorageService, storage);
  ix.stub(IPluginService, { getPluginInfo: async () => ({ manifest: { kiki: { permissions: { secrets: true }, settings: { schema: { type: 'object', properties: { alienCredential: { type: 'string', secret: true }, connectionId: { type: 'string' } } } } } } }) } as unknown as IPluginService);
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
  try {
    const settings = ix.get(IPluginSettingsService);
    await settings.update({ pluginId: 'my-heterogeneous-script', values: { alienCredential: 'fixture-own-secret', connectionId: 'chosen-provider' } });
    await settings.update({ pluginId: 'other-script', values: { alienCredential: 'fixture-sibling-secret' } });
    const publicText = await readFile(path.join(home, 'config.toml'), 'utf8');
    const privateText = await readFile(path.join(home, 'credentials', 'credentials.toml'), 'utf8');
    expect(publicText).toContain('chosen-provider');
    expect(publicText).not.toContain('fixture-own-secret'); expect(publicText).not.toContain('fixture-sibling-secret');
    expect(privateText).toContain('fixture-own-secret'); expect(privateText).toContain('fixture-sibling-secret');
    expect(await settings.inspect('my-heterogeneous-script')).toMatchObject({ values: { connectionId: 'chosen-provider' }, secretsConfigured: ['alienCredential'] });
    expect(JSON.stringify(await settings.inspect('my-heterogeneous-script'))).not.toContain('fixture-own-secret');
    expect(await settings.forExecution('my-heterogeneous-script')).toEqual({ alienCredential: 'fixture-own-secret', connectionId: 'chosen-provider' });
    await settings.update({ pluginId: 'my-heterogeneous-script', values: { alienCredential: null } });
    expect(await settings.forExecution('my-heterogeneous-script')).toEqual({ connectionId: 'chosen-provider' });
    expect(await readFile(path.join(home, 'credentials', 'credentials.toml'), 'utf8')).not.toContain('fixture-own-secret');
    expect(await settings.forExecution('other-script')).toEqual({ alienCredential: 'fixture-sibling-secret' });
  } finally {
    ix.dispose();
    await storage.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

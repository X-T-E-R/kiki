import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { StubConfigService } from '../../kosong/stubs';
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
    await ix.dispose();
    await storage.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

it.each([false, true])('merges renamed settings with current conflicts winning in either storage order (%s)', async (legacyFirst) => {
  const legacy = { pythonPath: 'legacy-python', retained: true, plugin_credential_secret: 'fixture-secret' };
  const current = { pythonPath: 'current-python', added: 42 };
  const config = new StubConfigService({ pluginSettings: Object.fromEntries(legacyFirst
    ? [['kiki-documents', legacy], ['kiki-extract', current]]
    : [['kiki-extract', current], ['kiki-documents', legacy]]) });
  const ix = new TestInstantiationService();
  ix.stub(IConfigService, config);
  ix.stub(IPluginService, { getPluginInfo: async ({ id }: { id: string }) => {
    expect(id).toBe('kiki-extract');
    return { manifest: { kiki: { permissions: { secrets: true }, settings: { schema: { type: 'object', properties: {
      pythonPath: { type: 'string' }, retained: { type: 'boolean' }, added: { type: 'number' }, credential: { type: 'string', secret: true },
    } } } } } };
  } } as unknown as IPluginService);
  ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
  try {
    const settings = ix.get(IPluginSettingsService);
    const expected = { pythonPath: 'current-python', retained: true, added: 42, credential: 'fixture-secret' };
    expect(await settings.forExecution('kiki-extract')).toEqual(expected);
    expect(await settings.inspect('kiki-documents')).toMatchObject({ values: { pythonPath: 'current-python', retained: true, added: 42 }, secretsConfigured: ['credential'] });
    await settings.update({ pluginId: 'kiki-documents', values: { added: 43 } });
    expect(await settings.forExecution('kiki-extract')).toEqual({ ...expected, added: 43 });
    expect(Object.keys(config.get<Record<string, unknown>>('pluginSettings'))).toEqual(['kiki-extract']);
    await settings.clear('kiki-documents');
    expect(await settings.forExecution('kiki-extract')).toEqual({});
  } finally { await ix.dispose(); }
});

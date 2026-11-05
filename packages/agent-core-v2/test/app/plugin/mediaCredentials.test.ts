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
import { pluginModelCatalog } from '#/app/plugin/pluginModelCatalog';
import type { IModelCatalog } from '#/kosong/model/catalog';
import { settingsContributionSchema } from '#/app/plugin/contributions';
import { scriptSettingsSchema } from '#/app/plugin/mediaSourceSettings';
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

it('gives the script fields the host synthesizes Chinese text beside its own English label', async () => {
  const config = new StubConfigService({ pluginSettings: { 'kiki-media': { scriptSources: JSON.stringify([{ id: 'my-speech', label: 'My speech', kinds: ['tts'], command: 'node' }]) } } });
  const ix = new TestInstantiationService();
  ix.stub(IConfigService, config);
  ix.stub(IPluginService, { getPluginInfo: async () => ({ manifest: { kiki: { permissions: { secrets: true }, mediaScriptProvider: 'custom-script', settings: { schemaVersion: 1, schema: { type: 'object', properties: { scriptSources: { type: 'string' } } } } } } }) } as unknown as IPluginService);
  ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
  try {
    const settings = ix.get(IPluginSettingsService);
    const property = (await settings.inspect('kiki-media')).schema?.schema.properties['script_my-speech__environment'];
    expect(property?.title).toBe('Script environment');
    expect(property?.localizations?.['zh']?.title).toBe('脚本环境变量');
    expect(property?.secret).toBe(true);
    const environment = scriptSettingsSchema.schema.properties['environment'];
    expect(environment?.title).toBe('Environment variables (JSON)');
    expect(environment?.localizations?.['zh']?.title).toBe('环境变量（JSON）');
  } finally { await ix.dispose(); }
});

it('enriches ungrouped media plugin settings from mediaSources and mediaProviders metadata', async () => {
  const config = new StubConfigService({ pluginSettings: {} });
  const ix = new TestInstantiationService();
  ix.stub(IConfigService, config);
  ix.stub(IPluginService, {
    getPluginInfo: async () => ({
      manifest: {
        kiki: {
          permissions: { secrets: true },
          mediaSources: [
            { id: 'openai', label: 'OpenAI', providerIds: ['openai-image', 'openai-tts'], settingsPrefix: 'openai__', required: ['apiKey', 'baseUrl'] },
            { id: 'google', label: 'Google', providerIds: ['google-image', 'google-video'], settingsPrefix: 'google__', required: [] },
          ],
          mediaProviders: [
            { schemaVersion: 1, id: 'openai-image', label: 'OpenAI Images', kinds: ['image'], resumeVersion: 1, connectionSetting: 'connectionId' },
            { schemaVersion: 1, id: 'google-image', label: 'Google Images', kinds: ['image'], resumeVersion: 1 },
            { schemaVersion: 1, id: 'google-video', label: 'Google Video', kinds: ['video'], resumeVersion: 1 },
            { schemaVersion: 1, id: 'openai-tts', label: 'OpenAI Speech', kinds: ['tts'], resumeVersion: 1 },
          ],
          settings: {
            schemaVersion: 1,
            schema: {
              type: 'object',
              properties: {
                defaultImageProvider: { type: 'string', title: 'Default image provider' },
                defaultVideoProvider: { type: 'string', title: 'Default video provider' },
                defaultTtsProvider: { type: 'string', title: 'Default TTS provider' },
                openai__enabled: { type: 'boolean', title: 'Enabled', default: true },
                openai__apiKey: { type: 'string', title: 'API key', secret: true },
                openai__baseUrl: { type: 'string', title: 'API base URL' },
                openai__connectionId: { type: 'string', title: 'Connection ID' },
                openai__removed: { type: 'boolean', title: 'Source removed' },
                openai__cleared: { type: 'string', title: 'Cleared fields' },
                scriptSources: { type: 'string', title: 'Custom script sources (JSON)' },
              },
            },
          },
        },
      },
    }),
  } as unknown as IPluginService);
  ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
  try {
    const settings = ix.get(IPluginSettingsService);
    const inspected = (await settings.inspect('kiki-media')).schema?.schema;
    const props = inspected?.properties ?? {};
    expect(inspected?.required).toEqual(['openai__apiKey', 'openai__baseUrl']);
    expect(props['defaultImageProvider']?.enum).toEqual(['openai-image', 'google-image']);
    expect(props['defaultVideoProvider']?.enum).toEqual(['google-video']);
    expect(props['defaultTtsProvider']?.enum).toEqual(['openai-tts']);
    expect(props['defaultImageProvider']?.localizations?.['zh']?.title).toBe('默认图像来源');
    expect(props['openai__apiKey']?.group).toBe('openai');
    expect(props['openai__apiKey']?.groupTitle).toBe('OpenAI');
    expect(props['openai__apiKey']?.localizations?.['zh']?.title).toBe('API 密钥');
    expect(props['openai__connectionId']?.localizations?.['zh']?.title).toBe('Kiki 连接（可选）');
    expect(props['openai__connectionId']?.format).toBe('kiki-connection');
    expect(props['openai__apiKey']?.requiredUnless).toBe('openai__connectionId');
    expect(props['openai__baseUrl']?.requiredUnless).toBe('openai__connectionId');
    expect(props['openai__removed']?.hidden).toBe(true);
    expect(props['openai__cleared']?.hidden).toBe(true);
    expect(props['scriptSources']?.multiline).toBe(true);
    expect(props['scriptSources']?.advanced).toBe(true);
  } finally {
    await ix.dispose();
  }
});

it('projects connection metadata for an independent legacy media provider without guessing ordinary settings', async () => {
  const config = new StubConfigService({ pluginSettings: {} });
  const ix = new TestInstantiationService();
  ix.stub(IConfigService, config);
  ix.stub(IPluginService, {
    getPluginInfo: async () => ({
      manifest: {
        kiki: {
          mediaProviders: [{ id: 'agnes-video', kinds: ['video'], connectionSetting: 'connectionId' }],
          settings: {
            schemaVersion: 1,
            schema: {
              type: 'object',
              required: ['apiKey', 'baseUrl'],
              properties: {
                apiKey: { type: 'string', secret: true },
                baseUrl: { type: 'string' },
                connectionId: { type: 'string' },
                connectionIdGuess: { type: 'string' },
              },
            },
          },
        },
      },
    }),
  } as unknown as IPluginService);
  ix.set(IPluginSettingsService, new SyncDescriptor(PluginSettingsService));
  try {
    const properties = (await ix.get(IPluginSettingsService).inspect('independent-media')).schema?.schema.properties ?? {};
    expect(properties['connectionId']?.format).toBe('kiki-connection');
    expect(properties['apiKey']?.requiredUnless).toBe('connectionId');
    expect(properties['baseUrl']?.requiredUnless).toBe('connectionId');
    expect(properties['connectionIdGuess']?.format).toBeUndefined();
  } finally {
    await ix.dispose();
  }
});


it('validates setting formats and requiredUnless declarations without changing secret storage', () => {
  const base = { schemaVersion: 1, schema: { type: 'object' as const, required: ['apiKey'], properties: {
    apiKey: { type: 'string' as const, secret: true },
    connectionId: { type: 'string' as const, format: 'kiki-connection' as const },
    modelId: { type: 'string' as const, format: 'kiki-model' as const },
  } } };
  expect(settingsContributionSchema.parse(base).schema.properties.connectionId.format).toBe('kiki-connection');
  expect(() => settingsContributionSchema.parse({ ...base, schema: { ...base.schema, properties: { ...base.schema.properties, apiKey: { type: 'string', secret: true, format: 'kiki-connection' } } } })).toThrow();
  expect(() => settingsContributionSchema.parse({ ...base, schema: { ...base.schema, properties: { ...base.schema.properties, modelId: { type: 'boolean', format: 'kiki-model' } } } })).toThrow();
  expect(() => settingsContributionSchema.parse({ schemaVersion: 1, schema: { type: 'object', required: ['apiKey'], properties: {
    apiKey: { type: 'string', secret: true, requiredUnless: 'secretTarget' }, secretTarget: { type: 'string', secret: true },
  } } })).toThrow();
  expect(settingsContributionSchema.parse({ schemaVersion: 1, schema: { type: 'object', required: ['apiKey'], properties: {
    apiKey: { type: 'string', secret: true, requiredUnless: 'connectionId' }, connectionId: { type: 'string' },
  } } })).toEqual(expect.objectContaining({ schema: expect.any(Object) }));
});


it('projects only safe model and connection catalog fields with decision and OAuth precedence', async () => {
  const result = await pluginModelCatalog({
    listModels: async () => [{ id: 'chat-alias', provider_id: 'chat', remote_id: 'remote-chat', display_name: 'Chat', max_context_size: 8192, effective_capabilities: ['tool_use'], effective_protocol: 'openai', api_key: 'fixture-model-secret', base_url: 'https://secret.example.test' }],
    listProviders: async () => [
      { id: 'chat', type: 'openai', status: 'connected', service: 'chat', default_model: 'chat-alias', models: ['remote-chat'], oauth: { storage: 'file', signed_in: false }, has_api_key: true, api_key: 'fixture-secret', effective_base_url: 'https://secret.example.test', custom_header_keys: ['authorization'] },
      { id: 'decision', type: 'system_one', status: 'unconfigured', service: 'chat', decision_protocol: 'system_one', models: ['judge'], has_api_key: false },
    ],
  } as unknown as IModelCatalog);
  expect(result).toEqual({
    models: [{ id: 'chat-alias', provider_id: 'chat', remote_id: 'remote-chat', display_name: 'Chat', max_context_size: 8192, effective_capabilities: ['tool_use'], effective_protocol: 'openai' }],
    connections: [
      { id: 'chat', type: 'openai', status: 'connected', service: 'chat', default_model: 'chat-alias', models: ['remote-chat'], authentication: 'oauth' },
      { id: 'decision', type: 'system_one', status: 'unconfigured', service: 'decision', models: ['judge'], authentication: 'none' },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(JSON.stringify(result)).not.toContain('secret.example.test');
});

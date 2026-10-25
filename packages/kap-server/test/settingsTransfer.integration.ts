import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { ConfigTarget, IConfigService } from '@kiki/agent-core-v2/app/config/config';
import { IMcpConfigStore } from '@kiki/agent-core-v2/app/mcpConfig/configStore';
import { IMcpRegistryService } from '@kiki/agent-core-v2/app/mcpRegistry/mcpRegistry';
import { McpRegistryService } from '@kiki/agent-core-v2/app/mcpRegistry/mcpRegistryService';
import { IBootstrapService } from '@kiki/agent-core-v2/app/bootstrap/bootstrap';
import { IPluginService } from '@kiki/agent-core-v2/app/plugin/plugin';
import { IInstantiationService } from '@kiki/agent-core-v2/_base/di/instantiation';
import { ServiceCollection } from '@kiki/agent-core-v2/_base/di/serviceCollection';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { INbSearchService } from '@kiki/agent-core-v2/app/nbSearch/nbSearch';
import { NbSearchConfigSchema } from '@kiki/agent-core-v2/app/nbSearch/configSection';
import { DEFAULT_NOTIFICATIONS_CONFIG } from '@kiki/agent-core-v2/app/notifications/configSection';
import { ISettingsProfileResources } from '@kiki/agent-core-v2/app/settingsTransfer/profileResources';
import { SETTINGS_TRANSFER_CATEGORIES, type SettingsTransferPackage } from '@kiki/protocol';
import { isPeerProcedureAllowed } from '../src/services/connections/audience';
import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const categories = [...SETTINGS_TRANSFER_CATEGORIES];
const selected = ['models', 'agents', 'permissions', 'tools', 'browser', 'notifications'] as const;
const credential = 'FAKE_TRANSFER_CREDENTIAL_DO_NOT_LOG';
const headerCredential = 'FAKE_TRANSFER_HEADER_DO_NOT_LOG';
const sourceProfile = '---\nname: transfer-helper\ndescription: An offline helper\nprompt_overrides:\n  independent:\n    files: [prompts/shared.toml]\n---\n\nKeep replies concise.\n';
const promptText = 'schema_version = 1\n[fields]\n"system.shared" = "Keep replies concise."\n';
let root: string;
let source: RunningServer;
let target: RunningServer;
let from: ReturnType<typeof createKlient>;
let to: ReturnType<typeof createKlient>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kiki-settings-transfer-'));
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
  vi.stubEnv('NB_SEARCH_HOME', join(root, 'isolated-nb-search'));
  const sourceHome = join(root, 'source');
  const targetHome = join(root, 'target');
  await mkdir(join(sourceHome, 'agents'), { recursive: true });
  await mkdir(join(sourceHome, 'prompts'), { recursive: true });
  await mkdir(targetHome, { recursive: true });
  await writeFile(join(sourceHome, 'prompts', 'shared.toml'), promptText);
  await writeFile(join(sourceHome, 'agents', 'transfer-helper.md'), sourceProfile);
  await writeFile(join(sourceHome, 'SYSTEM.md'), '---\nsystem_prompt_mode: append\n---\nPrefer short answers.\n');
  for (const home of [sourceHome, targetHome]) await writeFile(join(home, 'config.toml'), '[experimental]\ndesktop_search = false\n');
  source = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: sourceHome, logLevel: 'silent' });
  target = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: targetHome, logLevel: 'silent' });
  from = createKlient({ endpoint: `http://127.0.0.1:${source.port}`, token: source.localOwnerToken });
  to = createKlient({ endpoint: `http://127.0.0.1:${target.port}`, token: target.localOwnerToken });
  await from.global.config.replaceSections({ sections: {
    providers: { sample: { type: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: credential, customHeaders: { 'x-access': headerCredential } } },
    models: { 'sample/chat': { provider: 'sample', model: 'chat', maxContextSize: 8192, promptOverrides: { main: { files: ['prompts/shared.toml'] } } } },
    prompt: { overrides: { independent: { files: ['prompts/shared.toml'] } } },
    defaultModel: 'sample/chat',
    tools: { enabled: ['Read'], disabled: ['Write'] },
    defaultPermissionMode: 'manual',
    browserControl: { connections: { bridge: { type: 'kimi-webbridge', name: 'WebBridge', enabled: false } }, allowedBrowsers: [] },
    computerControl: { enabled: false, usagePreference: 'avoid' },
    pluginSettings: { sample: { model: 'picture', plugin_key_secret: credential } },
    experimental: { desktop_search: false, native_browser: false },
    notifications: { ...DEFAULT_NOTIFICATIONS_CONFIG, global: { ...DEFAULT_NOTIFICATIONS_CONFIG.global, enabled: false }, credential_values: { offline: { token: credential } } },
  } });
  await from.global.mcp.add({ server: { name: 'offline-example', transport: 'http', url: 'https://mcp.example.test', enabled: false, headers: { authorization: credential } } });
}, 60_000);

afterAll(async () => {
  await from?.close(); await to?.close();
  await source?.close(); await target?.close();
  vi.unstubAllEnvs();
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}, 30_000);

describe('settings transfer through the authenticated klient HTTP host', () => {
  it('exports only selected categories and separates real stored fake credentials', async () => {
    const plain = await from.global.settingsTransfer.export({ categories, includeCredentials: false });
    expect(JSON.stringify(plain)).not.toContain(credential);
    expect(JSON.stringify(plain)).not.toContain(headerCredential);
    expect(plain.resources.some((entry) => entry.kind === 'profile' && entry.key === 'agents/transfer-helper.md')).toBe(true);
    expect(plain.resources.some((entry) => entry.kind === 'profile' && entry.key === 'prompts/shared.toml')).toBe(true);
    const modelsOnly = await from.global.settingsTransfer.export({ categories: ['models'], includeCredentials: false });
    expect(modelsOnly.resources).toEqual([{ kind: 'profile', key: 'prompts/shared.toml', text: promptText, category: 'models' }]);
    expect(modelsOnly.config).not.toHaveProperty('experimental');
    const browserOnly = await from.global.settingsTransfer.export({ categories: ['browser'], includeCredentials: false });
    expect(browserOnly.config['experimental']).toEqual({ native_browser: false });
    const bundle = await from.global.settingsTransfer.export({ categories, includeCredentials: true });
    expect(bundle.config['providers']).toMatchObject({ sample: { apiKey: credential } });
    expect(bundle.resources.find((entry) => entry.kind === 'mcp')).toMatchObject({ value: { headers: { authorization: credential } } });
    const limited = await from.global.settingsTransfer.export({ categories: ['permissions'], includeCredentials: true });
    expect(limited.config).toHaveProperty('defaultPermissionMode', 'manual');
    expect(limited.config).not.toHaveProperty('providers');
    expect(limited.resources).toEqual([]);
    expect(JSON.stringify(limited)).not.toContain(credential);
    expect((await from.global.settingsTransfer.catalog()).categories.find((entry) => entry.id === 'models')?.items).toBeGreaterThan(0);
  });

  it('round-trips a credential-free package between two isolated homes with formal readback', async () => {
    const bundle = await from.global.settingsTransfer.export({ categories, includeCredentials: false });
    const preview = await to.global.settingsTransfer.preview({ bundle, categories: [...selected], mode: 'append', includeCredentials: false });
    expect(preview.scope.home.replaceAll('\\', '/')).toContain('/target');
    const result = await to.global.settingsTransfer.apply({ previewId: preview.previewId });
    expect(result.status).toBe('complete');
    expect(await to.global.config.get('models')).toMatchObject({ 'sample/chat': { provider: 'sample', model: 'chat' } });
    expect(await to.global.config.get('providers')).toMatchObject({ sample: { baseUrl: 'https://api.example.test/v1' } });
    expect(JSON.stringify(await to.global.config.get('providers'))).not.toContain(credential);
    expect(await readFile(join(root, 'target', 'agents', 'transfer-helper.md'), 'utf8')).toBe(sourceProfile);
    expect(await to.global.config.get('browserControl')).toMatchObject({ connections: { bridge: { enabled: false } }, allowedBrowsers: [] });
    expect(await to.global.config.get('defaultPermissionMode')).toBe('manual');
    expect((await to.global.mcp.list()).find((entry) => entry.name === 'offline-example')).toMatchObject({ config: { enabled: false } });
  });

  it('append keeps existing entity IDs and values; overwrite only selected incoming keys and optional secrets', async () => {
    await to.global.config.replaceSections({ sections: {
      providers: { sample: { type: 'openai', baseUrl: 'https://keep.example.test', apiKey: 'FAKE_TARGET_KEY' }, keep: { type: 'openai', baseUrl: 'https://untouched.example.test' } },
      tools: { enabled: ['Bash'], disabled: [] }, defaultPermissionMode: 'auto',
    } });
    const bundle = await from.global.settingsTransfer.export({ categories, includeCredentials: true });
    const append = await to.global.settingsTransfer.preview({ bundle, categories: ['models'], mode: 'append', includeCredentials: true });
    expect(append.categories.find((entry) => entry.id === 'models')?.conflicts).toBeGreaterThan(0);
    expect((await to.global.settingsTransfer.apply({ previewId: append.previewId })).status).toBe('complete');
    expect(await to.global.config.get('providers')).toMatchObject({ sample: { baseUrl: 'https://keep.example.test', apiKey: 'FAKE_TARGET_KEY' } });
    const noSecrets = await to.global.settingsTransfer.preview({ bundle, categories: ['models'], mode: 'overwrite', includeCredentials: false });
    expect((await to.global.settingsTransfer.apply({ previewId: noSecrets.previewId })).status).toBe('complete');
    expect(await to.global.config.get('providers')).toMatchObject({ sample: { baseUrl: 'https://api.example.test/v1', apiKey: 'FAKE_TARGET_KEY' }, keep: { baseUrl: 'https://untouched.example.test' } });
    expect(await to.global.config.get('tools')).toEqual({ enabled: ['Bash'], disabled: [] });
    expect(await to.global.config.get('defaultPermissionMode')).toBe('auto');
    const yesSecrets = await to.global.settingsTransfer.preview({ bundle, categories: ['models', 'tools'], mode: 'overwrite', includeCredentials: true });
    expect((await to.global.settingsTransfer.apply({ previewId: yesSecrets.previewId })).status).toBe('complete');
    expect(await to.global.config.get('providers')).toMatchObject({ sample: { apiKey: credential } });
    expect(await target.core.accessor.get(IMcpConfigStore).get('offline-example')).toMatchObject({ headers: { authorization: credential } });
    const disk = await readFile(join(root, 'target', 'config.toml'), 'utf8');
    expect(disk).not.toContain(credential);
    const privateDisk = await readFile(join(root, 'target', 'credentials', 'credentials.toml'), 'utf8');
    expect(privateDisk).toContain(credential);
  });

  it('validates profile and config prompt closure before writing and rejects resource aliases', async () => {
    const bundle = await from.global.settingsTransfer.export({ categories: ['agents'], includeCredentials: false });
    const before = await readFile(join(root, 'target', 'config.toml'), 'utf8');
    const broken: SettingsTransferPackage = { ...bundle, resources: [{ kind: 'profile', key: 'agents/new-helper.md', text: sourceProfile.replace('prompts/shared.toml', 'prompts/missing.toml') }] };
    await expect(to.global.settingsTransfer.preview({ bundle: broken, categories: ['agents'], mode: 'append', includeCredentials: false })).rejects.toThrow('referencedPromptFile');
    const badInline: SettingsTransferPackage = { ...bundle, config: { prompt: { overrides: { fields: { 'unknown.invalid.field': 'not supported' } } } } };
    await expect(to.global.settingsTransfer.preview({ bundle: badInline, categories: ['agents'], mode: 'overwrite', includeCredentials: false })).rejects.toThrow('configuration:prompt');
    const aliases: SettingsTransferPackage = { ...bundle, resources: [
      { kind: 'profile', key: 'agents/new-helper.md', text: sourceProfile },
      { kind: 'profile', key: 'agents\\new-helper.md', text: sourceProfile },
    ] };
    await expect(to.global.settingsTransfer.preview({ bundle: aliases, categories: ['agents'], mode: 'overwrite', includeCredentials: false })).rejects.toThrow();
    expect(await readFile(join(root, 'target', 'config.toml'), 'utf8')).toBe(before);
    const sourceProfiles = source.core.accessor.get(ISettingsProfileResources);
    await sourceProfiles.delete('prompts/shared.toml');
    try {
      await expect(from.global.settingsTransfer.export({ categories: ['models'], includeCredentials: false })).rejects.toThrow('referencedPromptFile');
      await expect(from.global.settingsTransfer.export({ categories: ['agents'], includeCredentials: false })).rejects.toThrow('referencedPromptFile');
    } finally { await sourceProfiles.write({ key: 'prompts/shared.toml', text: promptText }); }
  });

  it('omits inline MCP credentials unless explicitly selected and rejects changed prompt dependencies', async () => {
    const mcpStore = source.core.accessor.get(IMcpConfigStore);
    await mcpStore.add({ name: 'inline-example', transport: 'stdio', command: 'example-tool', args: ['--token', credential], enabled: false });
    try {
      const plain = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: false });
      expect(plain.resources.some((resource) => resource.key === 'inline-example')).toBe(false);
      expect(JSON.stringify(plain)).not.toContain(credential);
      const privateBundle = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: true });
      expect(privateBundle.resources.find((resource) => resource.key === 'inline-example')).toMatchObject({ value: { args: ['--token', credential] } });
    } finally { await mcpStore.remove('inline-example'); }
    const bundle = await from.global.settingsTransfer.export({ categories: ['agents'], includeCredentials: false });
    const next: SettingsTransferPackage = { ...bundle, resources: [{ kind: 'profile', key: 'agents/new-helper.md', text: sourceProfile }] };
    const preview = await to.global.settingsTransfer.preview({ bundle: next, categories: ['agents'], mode: 'overwrite', includeCredentials: false });
    const profiles = target.core.accessor.get(ISettingsProfileResources);
    await profiles.write({ key: 'prompts/shared.toml', text: `${promptText}\n` });
    expect(await to.global.settingsTransfer.apply({ previewId: preview.previewId })).toMatchObject({ status: 'failed', failure: 'changed', items: [] });
    await profiles.write({ key: 'prompts/shared.toml', text: promptText });
  });

  it('keeps an explicit off in another effective layer without copying it into the target home', async () => {
    const config = target.core.accessor.get(IConfigService);
    await config.replace('defaultPlanMode', false, ConfigTarget.Memory);
    try {
      const base = await from.global.settingsTransfer.export({ categories: ['permissions'], includeCredentials: false });
      const bundle: SettingsTransferPackage = { ...base, config: { defaultPlanMode: true }, resources: [] };
      const preview = await to.global.settingsTransfer.preview({ bundle, categories: ['permissions'], mode: 'append', includeCredentials: false });
      expect(preview.categories.find((entry) => entry.id === 'permissions')).toMatchObject({ conflicts: 1, skipped: 1 });
      expect(await to.global.settingsTransfer.apply({ previewId: preview.previewId })).toMatchObject({ status: 'complete', items: [] });
      expect(config.get('defaultPlanMode')).toBe(false);
      expect(config.inspect('defaultPlanMode').userValue).toBeUndefined();
    } finally { await config.replace('defaultPlanMode', undefined, ConfigTarget.Memory); }
  });

  it('cancel, invalid packages and stale preview perform zero transfer writes', async () => {
    const bundle = await from.global.settingsTransfer.export({ categories, includeCredentials: true });
    const before = await readFile(join(root, 'target', 'config.toml'), 'utf8');
    const preview = await to.global.settingsTransfer.preview({ bundle, categories: ['permissions'], mode: 'overwrite', includeCredentials: false });
    await to.global.settingsTransfer.cancel({ previewId: preview.previewId });
    expect(await to.global.settingsTransfer.apply({ previewId: preview.previewId })).toMatchObject({ status: 'failed', failure: 'expired', items: [] });
    expect(await readFile(join(root, 'target', 'config.toml'), 'utf8')).toBe(before);
    await expect(to.global.settingsTransfer.preview({ bundle: { ...bundle, version: 99 } as unknown as SettingsTransferPackage, categories: ['models'], mode: 'append', includeCredentials: false })).rejects.toThrow();
    await expect(to.global.settingsTransfer.preview({ bundle: { ...bundle, config: { providers: { broken: { apiKey: credential, type: 55 } } } } as SettingsTransferPackage, categories: ['models'], mode: 'overwrite', includeCredentials: true })).rejects.not.toThrow(credential);
    expect(await readFile(join(root, 'target', 'config.toml'), 'utf8')).toBe(before);
    const stale = await to.global.settingsTransfer.preview({ bundle, categories: ['permissions'], mode: 'overwrite', includeCredentials: false });
    await to.global.config.replace({ domain: 'defaultPermissionMode', value: 'yolo' });
    expect(await to.global.settingsTransfer.apply({ previewId: stale.previewId })).toMatchObject({ status: 'failed', failure: 'changed', items: [] });
    expect(await to.global.config.get('defaultPermissionMode')).toBe('yolo');
  });

  it('reports the actual partial resource write and never calls it complete', async () => {
    const bundle = await from.global.settingsTransfer.export({ categories: ['agents', 'permissions'], includeCredentials: false });
    await to.global.config.replace({ domain: 'defaultPermissionMode', value: 'auto' });
    const changed = structuredClone(bundle);
    changed.resources = changed.resources.map((resource) => resource.kind === 'profile' && resource.key.endsWith('.md') ? { ...resource, text: `${resource.text}\nImported suffix.\n` } : resource);
    const preview = await to.global.settingsTransfer.preview({ bundle: changed, categories: ['agents', 'permissions'], mode: 'overwrite', includeCredentials: false });
    const profiles = target.core.accessor.get(ISettingsProfileResources);
    const original = profiles.write.bind(profiles);
    let calls = 0;
    const spy = vi.spyOn(profiles, 'write').mockImplementation(async (resource) => { calls += 1; if (calls === 2) throw new Error(credential); await original(resource); });
    try {
      const result = await to.global.settingsTransfer.apply({ previewId: preview.previewId });
      expect(result).toMatchObject({ status: 'partial', failure: 'writeFailed' });
      expect(result.items.some((item) => item.status === 'applied')).toBe(true);
      expect(result.items.some((item) => item.status === 'failed')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(credential);
      expect(target.core.accessor.get(IConfigService).get('defaultPermissionMode')).toBe('auto');
    } finally { spy.mockRestore(); }
  });

  it('R1 omits credential-bearing MCP arguments and preserves unchecked target credentials', async () => {
    const compositeFlags = ['auth', 'token', 'bearer'].flatMap((word) => ['-', '_'].flatMap((separator) => {
      const flag = `${word}${separator}header`;
      return [flag, flag.toUpperCase()];
    }));
    const forms = [
      ['mcp-remote', 'https://mcp.example.test', '--header', `Authorization: Bearer ${credential}`],
      ['--header', `X-Api-Key: ${credential}`],
      ['-H', `Authorization:Bearer ${credential}`],
      [`--headers=Authorization: Bearer ${credential}`],
      ['--access-token', credential],
      [`--api-key=${credential}`],
      ...compositeFlags.flatMap((flag) => [[`--${flag}`, credential], [`--${flag}=${credential}`]]),
      ['--authHeader', credential],
      ['--httpAccessKeyHeader', credential],
      [`--HTTP_ACCESS_KEY_HEADER=${credential}`],
    ];
    const ordinaryArgs = ['serve', '--transport', 'stdio', '--host=127.0.0.1', '--port', '3000', '--log-level', 'info', '--author', 'Example', '--tokenizer', 'basic', '--headerless', '--secretary-mode', 'off'];
    const sourceMcp = source.core.accessor.get(IMcpConfigStore);
    const targetMcp = target.core.accessor.get(IMcpConfigStore);
    for (const [index, args] of forms.entries()) {
      const name = `credential-args-${index}`;
      await sourceMcp.add({ name, transport: 'stdio', command: 'example-tool', args, enabled: false });
      await targetMcp.add({ name, transport: 'stdio', command: 'target-tool', args: ['--token', 'FAKE_TARGET_ONLY'], enabled: false });
    }
    await sourceMcp.add({ name: 'ordinary-args', transport: 'stdio', command: 'example-tool', args: ordinaryArgs, enabled: false });
    try {
      const plain = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: false });
      expect(plain.resources.some((entry) => entry.key.startsWith('credential-args-'))).toBe(false);
      expect(JSON.stringify(plain)).not.toContain(credential);
      expect(plain.resources.find((entry) => entry.key === 'ordinary-args')).toMatchObject({ value: { args: ordinaryArgs } });
      const privateBundle = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: true });
      expect(privateBundle.resources.filter((entry) => entry.key.startsWith('credential-args-'))).toHaveLength(forms.length);
      for (const [index, args] of forms.entries()) expect(privateBundle.resources.find((entry) => entry.key === `credential-args-${index}`)).toMatchObject({ value: { args } });
      const unchecked = await to.global.settingsTransfer.preview({ bundle: privateBundle, categories: ['tools'], mode: 'overwrite', includeCredentials: false });
      expect((await to.global.settingsTransfer.apply({ previewId: unchecked.previewId })).status).toBe('complete');
      for (const index of forms.keys()) expect(await targetMcp.get(`credential-args-${index}`)).toMatchObject({ command: 'target-tool', args: ['--token', 'FAKE_TARGET_ONLY'] });
      expect(await targetMcp.get('ordinary-args')).toMatchObject({ command: 'example-tool', args: ordinaryArgs });
    } finally {
      for (const index of forms.keys()) { await sourceMcp.remove(`credential-args-${index}`); await targetMcp.remove(`credential-args-${index}`); }
      await sourceMcp.remove('ordinary-args'); await targetMcp.remove('ordinary-args');
    }
  });

  it('R2 append preserves inherited global MCP restrictions and guards their defining layer', async () => {
    const base = join(root, 'mcp-base');
    await mkdir(base, { recursive: true });
    const writeBase = (enabled: boolean) => writeFile(join(base, 'mcp.json'), JSON.stringify({ mcpServers: { inherited: { transport: 'http', url: 'https://keep.example.test', enabled } } }));
    await writeBase(false);
    const store = target.core.accessor.get(IMcpConfigStore);
    const registry = target.core.accessor.get(IMcpRegistryService);
    const child = target.core.accessor.get(IInstantiationService).createChild(new ServiceCollection(
      [IMcpRegistryService, new SyncDescriptor(McpRegistryService)],
      [IBootstrapService, { homeDir: join(root, 'target'), baseHomeDir: base } as IBootstrapService],
      [IPluginService, { mcpServerEntries: async () => [{ name: 'plugin-collision', pluginId: 'example', serverName: 'collision', config: { transport: 'http', url: 'https://plugin.example.test', enabled: true } }] } as unknown as IPluginService],
    ));
    const inherited = child.invokeFunction((accessor) => accessor.get(IMcpRegistryService));
    const spy = vi.spyOn(registry, 'list').mockImplementation(() => inherited.list());
    const bundle: SettingsTransferPackage = { format: 'kiki.settings', version: 1, createdAt: new Date().toISOString(), categories: ['tools'], includesCredentials: false, config: {}, resources: [{ kind: 'mcp', key: 'inherited', value: { transport: 'http', url: 'https://incoming.example.test', enabled: true } }], notices: [] };
    try {
      const preview = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'append', includeCredentials: false });
      expect(preview.categories[0]).toMatchObject({ added: 0, conflicts: 1, skipped: 1 });
      expect(await to.global.settingsTransfer.apply({ previewId: preview.previewId })).toMatchObject({ status: 'complete', items: [] });
      expect((await store.list()).some((entry) => entry.name === 'inherited')).toBe(false);
      expect(await inherited.resolveRuntimeTarget('inherited')).toMatchObject({ config: { enabled: false }, mutable: false });
      const stale = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'append', includeCredentials: false });
      await writeBase(true);
      expect(await to.global.settingsTransfer.apply({ previewId: stale.previewId })).toMatchObject({ status: 'failed', failure: 'changed', items: [] });
      const pluginBundle = { ...bundle, resources: [{ kind: 'mcp' as const, key: 'plugin-collision', value: { transport: 'http', url: 'https://incoming.example.test', enabled: false } }] };
      const pluginPreview = await to.global.settingsTransfer.preview({ bundle: pluginBundle, categories: ['tools'], mode: 'append', includeCredentials: false });
      expect(pluginPreview.categories[0]).toMatchObject({ added: 1, conflicts: 0 });
      expect((await to.global.settingsTransfer.apply({ previewId: pluginPreview.previewId })).status).toBe('complete');
      expect(await inherited.resolveRuntimeTarget('plugin-collision')).toMatchObject({ source: 'global', config: { enabled: false } });
    } finally { spy.mockRestore(); await store.remove('plugin-collision'); await child.dispose(); }
  });

  it('R3 preserves NBSearch slot environment names in a credential-free self-import', async () => {
    const config = source.core.accessor.get(IConfigService);
    const original = config.inspect('nbSearch').userValue;
    const patch = { credential_slots: { review: { provider_id: 'exa', env: 'REVIEW_EXA_API_KEY' } }, provider_instances: { review: { provider_id: 'exa', credential_slot_id: 'review', enabled: false, options: {} } } };
    try {
      await config.replace('nbSearch', patch);
      const bundle = await from.global.settingsTransfer.export({ categories: ['tools', 'permissions'], includeCredentials: false });
      expect(bundle.config['nbSearch']).toMatchObject(patch);
      expect(NbSearchConfigSchema.safeParse(bundle.config['nbSearch']).success).toBe(true);
      for (const selectedCategories of [['tools'], ['permissions']] as const) {
        const preview = await from.global.settingsTransfer.preview({ bundle, categories: [...selectedCategories], mode: 'append', includeCredentials: false });
        await from.global.settingsTransfer.cancel({ previewId: preview.previewId });
      }
    } finally { await config.replace('nbSearch', original); }
  });

  it('R4 round-trips Kiki-managed NBSearch keys only with opt-in and protects binding, version and cancellation', async () => {
    const sourceConfig = source.core.accessor.get(IConfigService);
    const targetConfig = target.core.accessor.get(IConfigService);
    const search = source.core.accessor.get(INbSearchService);
    const targetSearch = target.core.accessor.get(INbSearchService);
    const patch = { credential_slots: { transfer: { provider_id: 'exa', env: 'TRANSFER_EXA_API_KEY' } }, provider_instances: { transfer: { provider_id: 'exa', credential_slot_id: 'transfer', enabled: false, options: {}, base_url: 'https://search.example.test' } } };
    await sourceConfig.replaceSections({ nbSearch: patch, nbSearchSource: { reuse_local_config: false } });
    await targetConfig.replaceSections({ nbSearch: {}, nbSearchSource: { reuse_local_config: false } });
    vi.stubEnv('NB_SEARCH_EXA_API_KEY', 'FAKE_PROCESS_ONLY');
    const localHome = join(root, 'isolated-nb-search');
    await mkdir(localHome, { recursive: true });
    await writeFile(join(localHome, 'secrets.json'), JSON.stringify({ schema_version: '1', values: { NB_SEARCH_EXA_API_KEY: 'FAKE_CLI_ONLY' } }));
    const save = async (service: INbSearchService, value: string) => { const view = await service.readManagedCredential('transfer', false); return service.writeManagedCredential('transfer', value, view.version, view.binding_version); };
    await save(search, credential);
    const plain = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: false });
    expect(plain.resources.some((entry) => entry.kind === 'nbSearchCredential')).toBe(false);
    expect(JSON.stringify(plain)).not.toContain(credential);
    await sourceConfig.replace('nbSearchSource', { reuse_local_config: true });
    const external = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: true });
    expect(JSON.stringify(external)).not.toContain('FAKE_PROCESS_ONLY');
    expect(JSON.stringify(external)).not.toContain('FAKE_CLI_ONLY');
    await sourceConfig.replace('nbSearchSource', { reuse_local_config: false });
    const bundle = await from.global.settingsTransfer.export({ categories: ['tools'], includeCredentials: true });
    expect(bundle.resources.find((entry) => entry.kind === 'nbSearchCredential')).toMatchObject({ key: 'transfer', value: credential });
    vi.stubEnv('TRANSFER_EXA_API_KEY', 'FAKE_TARGET_ENV_ONLY');
    const environment = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'append', includeCredentials: true });
    const environmentResult = await to.global.settingsTransfer.apply({ previewId: environment.previewId });
    expect(environmentResult.status, JSON.stringify(environmentResult)).toBe('complete');
    expect(await targetSearch.readManagedCredential('transfer', true)).toMatchObject({ stored: false, source: 'environment', value: 'FAKE_TARGET_ENV_ONLY' });
    vi.stubEnv('TRANSFER_EXA_API_KEY', undefined);
    const first = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'append', includeCredentials: true });
    expect((await to.global.settingsTransfer.apply({ previewId: first.previewId })).status).toBe('complete');
    expect(await targetSearch.readManagedCredential('transfer', true)).toMatchObject({ stored: true, active: true, source: 'managed', value: credential });
    await save(targetSearch, 'FAKE_TARGET_ONLY');
    for (const mode of ['append', 'overwrite'] as const) {
      const preview = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode, includeCredentials: mode === 'append' });
      expect((await to.global.settingsTransfer.apply({ previewId: preview.previewId })).status).toBe('complete');
      expect((await targetSearch.readManagedCredential('transfer', true)).value).toBe('FAKE_TARGET_ONLY');
    }
    const cancelled = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    await to.global.settingsTransfer.cancel({ previewId: cancelled.previewId });
    expect(await to.global.settingsTransfer.apply({ previewId: cancelled.previewId })).toMatchObject({ failure: 'expired', items: [] });
    expect((await targetSearch.readManagedCredential('transfer', true)).value).toBe('FAKE_TARGET_ONLY');
    const stale = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    await save(targetSearch, 'FAKE_NEW_TARGET_ONLY');
    expect(await to.global.settingsTransfer.apply({ previewId: stale.previewId })).toMatchObject({ status: 'failed', failure: 'changed', items: [] });
    const rebound = structuredClone(bundle);
    const resource = rebound.resources.find((entry) => entry.kind === 'nbSearchCredential');
    if (resource?.kind !== 'nbSearchCredential') throw new Error('missing credential fixture');
    resource.binding.consumers[0]!.baseUrl = 'https://different.example.test';
    await expect(to.global.settingsTransfer.preview({ bundle: rebound, categories: ['tools'], mode: 'overwrite', includeCredentials: true })).rejects.toThrow('searchCredentialBinding');
    const overwrite = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    expect((await to.global.settingsTransfer.apply({ previewId: overwrite.previewId })).status).toBe('complete');
    expect((await targetSearch.readManagedCredential('transfer', true)).value).toBe(credential);
    const configStale = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    await targetConfig.replace('nbSearch', { ...patch, provider_instances: { transfer: { ...patch.provider_instances.transfer, base_url: 'https://rebound.example.test' } } });
    expect(await to.global.settingsTransfer.apply({ previewId: configStale.previewId })).toMatchObject({ status: 'failed', failure: 'changed', items: [] });
    await save(targetSearch, credential);
    const rebind = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    expect((await to.global.settingsTransfer.apply({ previewId: rebind.previewId })).status).toBe('complete');
    expect(await targetSearch.readManagedCredential('transfer', true)).toMatchObject({ active: true, value: credential });
    await save(targetSearch, 'FAKE_PRE_CAS_TARGET');
    const race = await to.global.settingsTransfer.preview({ bundle, categories: ['tools'], mode: 'overwrite', includeCredentials: true });
    const originalWrite = targetSearch.writeManagedCredential.bind(targetSearch);
    const spy = vi.spyOn(targetSearch, 'writeManagedCredential').mockImplementation(async (...args) => {
      const current = await targetSearch.readManagedCredential('transfer', false);
      await originalWrite('transfer', 'FAKE_CONCURRENT_TARGET', current.version, current.binding_version);
      return originalWrite(...args);
    });
    try {
      const result = await to.global.settingsTransfer.apply({ previewId: race.previewId });
      expect(result.status).not.toBe('complete');
      expect(result.failure).toBe('writeFailed');
      expect((await targetSearch.readManagedCredential('transfer', true)).value).toBe('FAKE_CONCURRENT_TARGET');
    } finally { spy.mockRestore(); }
    expect(await readFile(join(root, 'target', 'config.toml'), 'utf8')).not.toContain(credential);
  });

  it('keeps secret-export and settings writes local-owner-only', () => {
    for (const method of ['catalog', 'export', 'preview', 'apply', 'cancel']) expect(isPeerProcedureAllowed({ service: 'settingsTransferService', method })).toBe(false);
  });
});

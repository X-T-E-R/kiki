import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginManager } from '#/app/plugin/manager';
import { parseManifest } from '#/app/plugin/manifest';
import { PluginHost } from '#/app/plugin/host';

const homes: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kiki-plugin-contribution-'));
  homes.push(root);
  return root;
}
afterEach(async () => {
  for (const root of homes.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function manifest(description = 'Echo value', permission = 'workspace') {
  return {
    name: 'example',
    'x-kiki': {
      engines: { kiki: '^0.4.0' },
      permissions: { fs: permission },
      entry: './entry.mjs',
      tools: [{ schemaVersion: 1, name: 'echo', description, accesses: [{ kind: 'all' }] }],
      providerPresets: [{ schemaVersion: 1, id: 'demo', label: 'Demo', protocol: 'openai', baseUrl: 'https://example.com/v1', models: ['model'] }],
    },
  };
}

async function makeSource(dir: string, data: unknown = manifest()): Promise<void> {
  await writeFile(path.join(dir, 'kimi.plugin.json'), JSON.stringify(data));
  await writeFile(path.join(dir, 'entry.mjs'), 'export function register() {}');
}

describe('plugin extension compatibility and consent', () => {
  it.each([undefined, false, true])('preserves concurrencySafe=%s through manifest parsing and runner registration', async (concurrencySafe) => {
    const root = await temp();
    const data = manifest();
    const definition = { ...data['x-kiki'].tools[0]!, concurrencySafe };
    data['x-kiki'].tools = [definition];
    await makeSource(root, data);
    await writeFile(path.join(root, 'entry.mjs'), `export function register(api) { api.registerTool(${JSON.stringify(definition)}, async () => ({ output: 'registered' })); }`);
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics).toEqual([]);
    const tools = parsed.manifest!.kiki!.tools!;
    expect(tools[0]?.concurrencySafe).toBe(concurrencySafe);
    expect(tools[0]?.accesses).toEqual([{ kind: 'all' }]);
    const host = new PluginHost('example', path.join(root, 'entry.mjs'), tools);
    try {
      await expect(host.execute('echo', {}, new AbortController().signal)).resolves.toMatchObject({ output: 'registered' });
    } finally { host.stop(); }
  });

  it('rejects non-boolean concurrency declarations and registration drift', async () => {
    const root = await temp();
    const data = manifest();
    await makeSource(root, { ...data, 'x-kiki': { ...data['x-kiki'], tools: [{ ...data['x-kiki'].tools[0]!, concurrencySafe: 'true' }] } });
    expect((await parseManifest(root)).diagnostics.some((item) => item.severity === 'error')).toBe(true);
    await makeSource(root, data);
    await writeFile(path.join(root, 'entry.mjs'), `export function register(api) { api.registerTool(${JSON.stringify({ ...data['x-kiki'].tools[0]!, concurrencySafe: true })}, async () => ({ output: 'must not run' })); }`);
    const parsed = await parseManifest(root);
    const host = new PluginHost('example', path.join(root, 'entry.mjs'), parsed.manifest!.kiki!.tools!);
    try {
      await expect(host.execute('echo', {}, new AbortController().signal)).rejects.toThrow('changed tool definition');
    } finally { host.stop(); }
  });

  it('validates harness account source declarations, including required engine and entry', async () => {
    const root = await temp();
    const source = { schemaVersion: 1, id: 'accounts', label: 'Accounts', engineIds: ['agy-cli', 'codex'] };
    const extension = { engines: { kiki: '>=0.4.2' }, entry: './entry.mjs', harnessAccountSources: [source] };
    for (const [changes, expected] of [
      [{ engines: undefined }, 'x-kiki.engines.kiki is required'],
      [{ entry: undefined }, 'x-kiki.entry is required'],
      [{ harnessAccountSources: [source, source] }, 'Duplicate executable contribution id'],
      [{ harnessAccountSources: [{ ...source, engineIds: [] }] }, 'Invalid x-kiki extension'],
      [{ harnessAccountSources: [{ ...source, engineIds: ['codex', 'codex'] }] }, 'Duplicate engine id'],
    ] as const) {
      await makeSource(root, { name: 'example', 'x-kiki': { ...extension, ...changes } });
      expect((await parseManifest(root)).diagnostics.map(({ message }) => message).join(' ')).toContain(expected);
    }
    await makeSource(root, { name: 'example', 'x-kiki': extension });
    expect((await parseManifest(root)).manifest?.kiki?.harnessAccountSources).toEqual([source]);
  });

  it.each([
    ['missing', 'incomplete contributions'],
    ['changed', 'harness account source definition mismatch'],
    ['undeclared', 'harness account source definition mismatch'],
    ['duplicate', 'Invalid or duplicate harness account source'],
  ] as const)('rejects %s harness account registration at the real runner handshake', async (kind, expected) => {
    const root = await temp();
    const source = { schemaVersion: 1 as const, id: 'accounts', label: 'Accounts', engineIds: ['agy-cli'] };
    const registered = kind === 'changed' ? { ...source, engineIds: ['codex'] } : kind === 'undeclared' ? { ...source, id: 'undeclared' } : source;
    const code = `api.registerHarnessAccountSource(${JSON.stringify(registered)}, { list() {}, prepare() {}, release() {} });`;
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, `export function register(api) { ${kind === 'missing' ? '' : kind === 'duplicate' ? code.repeat(2) : code} }`);
    const host = new PluginHost('example', entry, [], [], [], undefined, root, [], [source]);
    try {
      await expect(host.listHarnessAccounts('accounts', 'agy-cli', new AbortController().signal, {})).rejects.toThrow(expected);
    } finally { await host.stopAndWait(); }
  });

  it('validates harness quota source declarations, including the five-minute minimum', async () => {
    const root = await temp();
    const source = { schemaVersion: 1, id: 'example', label: 'Example', engineIds: ['agy-cli'], minRefreshIntervalMs: 300_000 };
    const extension = { engines: { kiki: '>=0.4.2' }, entry: './entry.mjs', harnessQuotaSources: [source] };
    for (const [changes, expected] of [
      [{ entry: undefined }, 'x-kiki.entry is required'],
      [{ harnessQuotaSources: [source, source] }, 'Duplicate executable contribution id'],
      [{ harnessQuotaSources: [{ ...source, minRefreshIntervalMs: 1_000 }] }, 'Invalid x-kiki extension'],
    ] as const) {
      await makeSource(root, { name: 'example', 'x-kiki': { ...extension, ...changes } });
      expect((await parseManifest(root)).diagnostics.map(({ message }) => message).join(' ')).toContain(expected);
    }
    await makeSource(root, { name: 'example', 'x-kiki': extension });
    expect((await parseManifest(root)).manifest?.kiki?.harnessQuotaSources).toEqual([source]);
  });

  it.each([
    ['missing', 'incomplete contributions'],
    ['changed', 'harness quota source definition mismatch'],
    ['undeclared', 'harness quota source definition mismatch'],
    ['duplicate', 'Invalid or duplicate harness quota source'],
  ] as const)('rejects %s harness quota registration at the real runner handshake', async (kind, expected) => {
    const root = await temp();
    const source = { schemaVersion: 1 as const, id: 'example', label: 'Example', engineIds: ['agy-cli'] };
    const registered = kind === 'changed' ? { ...source, engineIds: ['codex'] } : kind === 'undeclared' ? { ...source, id: 'other' } : source;
    const code = `api.registerHarnessQuotaSource(${JSON.stringify(registered)}, { async read() { return { readings: [] }; } });`;
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, `export function register(api) { ${kind === 'missing' ? '' : kind === 'duplicate' ? code.repeat(2) : code} }`);
    const host = new PluginHost('example', entry, [], [], [], undefined, root, [], [], undefined, [source]);
    try {
      await expect(host.readHarnessQuota('example', new AbortController().signal, {})).rejects.toThrow(expected);
    } finally { await host.stopAndWait(); }
  });

  it('returns one quota batch from a custom plugin host', async () => {
    const root = await temp();
    const source = { schemaVersion: 1 as const, id: 'example', label: 'Example', engineIds: ['fixture-acp'] };
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, `export function register(api) { api.registerHarnessQuotaSource(${JSON.stringify(source)}, { async read() { return { readings: [{ accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 80 }] }; } }); }`);
    const host = new PluginHost('example', entry, [], [], [], undefined, root, [], [], undefined, [source]);
    try {
      await expect(host.readHarnessQuota('example', new AbortController().signal, {})).resolves.toEqual([
        { accountId: 'work', modelIds: ['fixture-model'], unit: 'percent', remaining: 80 },
      ]);
    } finally { await host.stopAndWait(); }
  });

  it('reads quota again after the plugin child retires on idle', async () => {
    const root = await temp();
    const source = { schemaVersion: 1 as const, id: 'example', label: 'Example', engineIds: ['agy-cli'] };
    const entry = path.join(root, 'entry.mjs');
    await writeFile(entry, `export function register(api) { api.registerHarnessQuotaSource(${JSON.stringify(source)}, { async read() { return { readings: [{ accountId: 'work', unit: 'percent', remaining: 80 }] }; } }); }`);
    const host = new PluginHost('example', entry, [], [], [], undefined, root, [], [], undefined, [source]);
    const signal = new AbortController().signal;
    const readings = [{ accountId: 'work', unit: 'percent', remaining: 80 }];
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await expect(host.readHarnessQuota('example', signal, {})).resolves.toEqual(readings);
      await vi.advanceTimersByTimeAsync(90_000);
      vi.useRealTimers();
      await expect(host.readHarnessQuota('example', signal, {})).resolves.toEqual(readings);
    } finally {
      vi.useRealTimers();
      await host.stopAndWait();
    }
  });

  it('accepts a plugin that requires the 0.4.1 home bridge', async () => {
    const root = await temp();
    const data = manifest();
    data['x-kiki'].engines.kiki = '>=0.4.1';
    await makeSource(root, data);
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.kiki?.engines).toEqual({ kiki: '>=0.4.1' });
  });

  it('refuses unsupported engine or extension versions, and an unknown wire protocol', async () => {
    const root = await temp();
    await makeSource(root);
    for (const [change, expected] of [
      [(value: ReturnType<typeof manifest>) => { value['x-kiki'].engines.kiki = '^9.0.0'; }, 'requires Kiki'],
      [(value: ReturnType<typeof manifest>) => { value['x-kiki'].tools[0]!.schemaVersion = 2; }, 'Invalid x-kiki'],
      [(value: ReturnType<typeof manifest>) => { value['x-kiki'].providerPresets[0]!.protocol = 'other'; }, 'Invalid x-kiki'],
    ] as const) {
      const data = manifest();
      change(data);
      await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
      const parsed = await parseManifest(root);
      expect(parsed.diagnostics.map((entry) => entry.message).join(' ')).toContain(expected);
      const manager = new PluginManager({ kimiHomeDir: await temp() });
      await expect(manager.install(root)).rejects.toThrow();
    }
  });

  it('keeps one-time source consent when declarations change and requires consent for another source', async () => {
    const home = await temp();
    const root = await temp();
    const manager = new PluginManager({ kimiHomeDir: home });
    await makeSource(root);
    const initial = await manager.preview(root);
    expect(initial.consentRequired).toBe(true);
    await manager.install(root, { fingerprint: initial.fingerprint, consent: true });
    await makeSource(root, manifest('Changed description', 'outside'));
    const update = await manager.preview(root);
    expect(update.changes).toContain('permissions changed');
    expect(update.changes).toContain('tool definitions changed');
    expect(update.consentRequired).toBe(false);
    await manager.install(root, { fingerprint: update.fingerprint });
    expect(manager.info('example')?.manifest?.kiki?.tools?.[0]?.description).toBe('Changed description');
    expect(manager.info('example')?.rollback?.source).toBe('local-path');
    await manager.rollback('example');
    expect(manager.info('example')?.manifest?.kiki?.tools?.[0]?.description).toBe('Echo value');
    expect(manager.info('example')?.rollback?.version).toBeUndefined();
    const reloaded = new PluginManager({ kimiHomeDir: home });
    await reloaded.load();
    expect(reloaded.info('example')?.manifest?.kiki?.tools?.[0]?.description).toBe('Echo value');
    const replacement = await temp();
    await makeSource(replacement);
    const replacementPlan = await reloaded.preview(replacement);
    expect(replacementPlan.consentRequired).toBe(true);
    await expect(reloaded.install(replacement, { fingerprint: replacementPlan.fingerprint })).rejects.toThrow('consent required');
    await reloaded.install(replacement, { fingerprint: replacementPlan.fingerprint, consent: true });
  });

  it('rejects files changed since preview', async () => {
    const root = await temp();
    const manager = new PluginManager({ kimiHomeDir: await temp() });
    await makeSource(root);
    const plan = await manager.preview(root);
    await writeFile(path.join(root, 'entry.mjs'), 'export function register() { throw Error("changed") }');
    await expect(manager.install(root, { fingerprint: plan.fingerprint, consent: true })).rejects.toThrow('changed since');
    expect(manager.get('example')).toBeUndefined();
  });

  it('accepts versioned sandbox panels and declarative commands, rejecting undeclared panel permission', async () => {
    const root = await temp();
    const data = { name: 'writer', 'x-kiki': {
      engines: { kiki: '^0.4.0' }, permissions: { uiPanel: true },
      panels: [{ schemaVersion: 1, id: 'editor', label: 'Editor', slot: 'workspace', path: './editor.html' }],
      commands: [{ schemaVersion: 1, name: 'draft', description: 'Draft a passage', prompt: 'Draft the next passage' }],
    } };
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    await writeFile(path.join(root, 'editor.html'), '<h1>Editor</h1>');
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.kiki?.panels?.[0]?.id).toBe('editor');
    const manager = new PluginManager({ kimiHomeDir: await temp() });
    const plan = await manager.preview(root);
    expect(plan.contributions).toEqual(['panel:editor', 'command:draft']);
    delete (data['x-kiki'] as { permissions?: unknown }).permissions;
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    expect((await parseManifest(root)).diagnostics.map((item) => item.message).join(' ')).toContain('uiPanel');
  });

  it('accepts a settings panel and grouped settings properties', async () => {
    const root = await temp();
    const data = { name: 'writer', 'x-kiki': {
      engines: { kiki: '^0.4.0' }, permissions: { uiPanel: true },
      panels: [{ schemaVersion: 1, id: 'settings', label: 'Settings', slot: 'settings', path: './settings.html' }],
      settings: { schemaVersion: 1, schema: { type: 'object', properties: {
        defaultImageProvider: { type: 'string', title: 'Default image', enum: ['openai-image'] },
        openai__removed: { type: 'boolean', hidden: true, group: 'openai', groupTitle: 'OpenAI' },
        openai__note: { type: 'string', title: 'Note', multiline: true, advanced: true, group: 'openai', groupTitle: 'OpenAI' },
      } } },
    } };
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    await writeFile(path.join(root, 'settings.html'), '<h1>Settings</h1>');
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest?.kiki?.panels?.[0]?.slot).toBe('settings');
    expect(parsed.manifest?.kiki?.settings?.schema.properties['openai__removed']?.hidden).toBe(true);
  });

  it('accepts per-language settings text beside the untranslated string, and still rejects unknown keys', async () => {
    const root = await temp();
    const settings = { schemaVersion: 1, schema: { type: 'object', properties: {
      openai__apiKey: { type: 'string', title: 'API key', secret: true, group: 'openai', groupTitle: 'OpenAI Media',
        localizations: { zh: { title: 'API 密钥', groupTitle: 'OpenAI 媒体' }, 'zh-Hans': { description: '用于替换的密钥' } } },
    } } };
    const data = { name: 'writer', 'x-kiki': { engines: { kiki: '^0.4.0' }, permissions: { secrets: true }, settings } };
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics).toEqual([]);
    const property = parsed.manifest?.kiki?.settings?.schema.properties['openai__apiKey'];
    expect(property?.title).toBe('API key');
    expect(property?.localizations?.['zh']?.title).toBe('API 密钥');
    expect(property?.localizations?.['zh-Hans']?.description).toBe('用于替换的密钥');

    settings.schema.properties.openai__apiKey.localizations.zh = { title: 'API 密钥', help: 'not a settings field' } as never;
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    expect((await parseManifest(root)).diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });

  it('parses the sibling Kiki Media package when that checkout is present', async () => {
    const root = 'C:/Programs/AI/EasyAgent/systems/kiki-plugins/plugins/official/kiki-media';
    if (!existsSync(root)) return;
    const parsed = await parseManifest(root);
    expect(parsed.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(parsed.manifest?.kiki?.panels?.some((panel) => panel.slot === 'settings' && panel.id === 'settings')).toBe(true);
  });

  it('accepts strictly declarative skin tokens but rejects CSS injection', async () => {
    const root = await temp();
    const data = {
      name: 'skin', 'x-kiki': { engines: { kiki: '^0.4.0' }, themes: [{ schemaVersion: 1, id: 'paper', label: 'Paper', base: 'light', path: './skin.json' }] },
    };
    await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify(data));
    await writeFile(path.join(root, 'skin.json'), JSON.stringify({ kind: 'kiki-skin', version: 1, name: 'Paper', variants: { light: { colors: { accent: '#123' } } } }));
    expect((await parseManifest(root)).manifest?.kiki?.themes?.[0]?.file.variants.light?.colors?.accent).toBe('#123');
    await writeFile(path.join(root, 'skin.json'), JSON.stringify({ kind: 'kiki-skin', version: 1, name: 'Paper', css: 'body{display:none}', variants: { light: {} } }));
    expect((await parseManifest(root)).diagnostics.some((item) => item.severity === 'error')).toBe(true);
  });
});

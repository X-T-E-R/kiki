import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IBrowserConnectionStore, BrowserConnectionStore } from '#/app/browser/browserConnectionStore';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const disposables = new DisposableStore();
const directories: string[] = [];
afterEach(async () => { await disposables.clear(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function open(home: string): IBrowserConnectionStore {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(ILogService, stubLog());
  ix.stub(IBootstrapService, stubBootstrap(home));
  ix.stub(IFileSystemStorageService, new FileStorageService(home, 0o700, 0o600));
  ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
  ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
  ix.set(IConfigService, new SyncDescriptor(ConfigService));
  ix.set(IBrowserConnectionStore, new SyncDescriptor(BrowserConnectionStore));
  return ix.get(IBrowserConnectionStore);
}

async function fixture(): Promise<{ home: string; store: IBrowserConnectionStore }> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-browser-'));
  directories.push(home);
  return { home, store: open(home) };
}

describe('browser connection configuration', () => {
  it('saves multiple same-type connections and reloads with an explicit default', async () => {
    const { home, store } = await fixture();
    expect(await store.list()).toEqual({ connections: [], defaultBrowser: undefined });
    await Promise.all([
      store.upsert('a', { type: 'agent-browser-profile', name: 'A', enabled: true, profilePath: join(home, 'a') }),
      store.upsert('b', { type: 'agent-browser-profile', name: 'A', enabled: true, profilePath: join(home, 'b') }),
    ]);
    await store.setDefault('b');
    const reopened = open(home);
    expect(await reopened.list()).toEqual(await store.list());
    expect(await reopened.resolve('a')).toMatchObject({ type: 'agent-browser-profile', profilePath: join(home, 'a') });
    expect(await reopened.resolve('b')).toMatchObject({ type: 'agent-browser-profile', profilePath: join(home, 'b') });
    await expect(reopened.resolve('A')).rejects.toMatchObject({ code: 'browser.not_found' });
    await reopened.upsert('b', { type: 'agent-browser-profile', name: 'Disabled default', enabled: false });
    expect((await reopened.list()).defaultBrowser).toBe('b');
    await expect(reopened.setDefault('b')).rejects.toMatchObject({ code: 'browser.disabled' });
    await reopened.remove('b');
    expect(await open(home).list()).toMatchObject({ connections: [{ id: 'a' }], defaultBrowser: undefined });
  });

  it('stores an allow set separately from the default and preserves it across reload', async () => {
    const { home, store } = await fixture();
    await store.upsert('a', { type: 'agent-browser-profile', name: 'A', enabled: true, profilePath: join(home, 'a') });
    await store.upsert('b', { type: 'agent-browser-profile', name: 'B', enabled: true, profilePath: join(home, 'b') });
    await store.setAllowed(['b', 'a', 'a']);
    expect(await store.list()).toMatchObject({ allowedBrowsers: ['b', 'a'], defaultBrowser: undefined });
    expect((await open(home).list()).allowedBrowsers).toEqual(['b', 'a']);
    await store.remove('b');
    expect((await open(home).list()).allowedBrowsers).toEqual(['a']);
    await store.setAllowed([]);
    expect((await open(home).list()).allowedBrowsers).toEqual([]);
    await store.setAllowed(undefined);
    expect(await open(home).list()).not.toHaveProperty('allowedBrowsers');
    await expect(store.setAllowed(['missing'])).rejects.toMatchObject({ code: 'browser.not_found' });
  });

  it('reopens an existing CDP choice without interpreting its id as a different provider', async () => {
    const { home, store } = await fixture();
    await store.upsert('kimi-webbridge', { type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true,
      endpoint: { action: 'set', value: 'http://127.0.0.1:9222' } });
    await store.setDefault('kimi-webbridge');
    await store.setAllowed(['kimi-webbridge']);
    const reopened = open(home);
    expect(await reopened.resolve('kimi-webbridge')).toMatchObject({ id: 'kimi-webbridge', name: 'edge-kimi', type: 'agent-browser-cdp', endpointSecret: 'http://127.0.0.1:9222' });
    await reopened.upsert('kimi-webbridge', { type: 'agent-browser-cdp', name: 'edge-kimi', enabled: true, endpoint: { action: 'keep' } });
    expect(await open(home).list()).toMatchObject({ defaultBrowser: 'kimi-webbridge', allowedBrowsers: ['kimi-webbridge'],
      connections: [{ id: 'kimi-webbridge', type: 'agent-browser-cdp', name: 'edge-kimi', endpointConfigured: true }] });
  });

  it('stores CDP URL only in existing credentials and supports explicit keep/reveal/delete', async () => {
    const { home, store } = await fixture();
    const value = 'wss://user:YOUR_API_KEY@browser.example.test/devtools/private-path?token=YOUR_API_KEY';
    const record = await store.upsert('cdp', { type: 'agent-browser-cdp', name: 'External', enabled: true, endpoint: { action: 'set', value } });
    expect(record).toEqual({ id: 'cdp', type: 'agent-browser-cdp', name: 'External', enabled: true,
      endpointDisplay: 'wss://browser.example.test', endpointConfigured: true });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('YOUR_API_KEY');
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('private-path');
    expect(await open(home).revealEndpoint('cdp')).toBe(value);
    await store.upsert('cdp', { type: 'agent-browser-cdp', name: 'Renamed', enabled: true, endpoint: { action: 'keep' } });
    expect(await open(home).revealEndpoint('cdp')).toBe(value);
    expect(JSON.stringify(await store.list())).not.toContain('YOUR_API_KEY');
    await store.remove('cdp');
    await expect(open(home).resolve('cdp')).rejects.toMatchObject({ code: 'browser.not_found' });
  });

  it('distinguishes an unregistered HTTP bridge from a disconnected extension and reloads its endpoint-free type', async () => {
    const { home, store } = await fixture();
    await expect(store.resolve('kimi-webbridge')).rejects.toMatchObject({ code: 'browser.not_found',
      message: expect.stringContaining('type = "kimi-webbridge"') });
    await expect(store.resolve('webbridge-command')).rejects.toMatchObject({ code: 'browser.not_found',
      message: expect.stringContaining('type = "webbridge-command"') });
    await expect(store.resolve('other')).rejects.toMatchObject({ code: 'browser.not_found', message: 'Unknown browser connection "other"' });
    await store.upsert('kimi-webbridge', { type: 'kimi-webbridge', name: 'Kimi Edge WebBridge', enabled: true });
    await store.upsert('webbridge-command', { type: 'webbridge-command', name: 'Command bridge', enabled: true });
    const reopened = open(home);
    expect(await reopened.resolve('kimi-webbridge')).toMatchObject({ type: 'kimi-webbridge', name: 'Kimi Edge WebBridge' });
    expect((await reopened.list()).connections.map((item) => [item.id, item.type])).toEqual([
      ['kimi-webbridge', 'kimi-webbridge'], ['webbridge-command', 'webbridge-command'],
    ]);
    const saved = await readFile(join(home, 'config.toml'), 'utf8');
    expect(saved).toContain('kimi-webbridge');
    expect(saved).not.toContain('endpoint');
  });

  it('keeps an explicit WebBridge route switch when a connection is removed', async () => {
    const { home, store } = await fixture();
    await store.upsert('a', { type: 'agent-browser-profile', name: 'A', enabled: true, profilePath: join(home, 'a') });
    await store.upsert('b', { type: 'agent-browser-profile', name: 'B', enabled: true, profilePath: join(home, 'b') });
    const path = join(home, 'config.toml');
    const before = await readFile(path, 'utf8');
    await writeFile(path, `[browser_control]\nwebbridge_preset_route = false\n\n${before}`);
    const reopened = open(home);
    expect((await reopened.list()).webbridgePresetRoute).toBe(false);
    await reopened.remove('b');
    expect((await open(home).list()).webbridgePresetRoute).toBe(false);
    expect((await open(home).list()).connections.map((connection) => connection.id)).toEqual(['a']);
  });

  it('rejects invalid ids, endpoint and relative host paths without writing a connection', async () => {
    const { store } = await fixture();
    await expect(store.resolve('constructor')).rejects.toMatchObject({ code: 'browser.not_found' });
    await expect(store.setDefault('constructor')).rejects.toMatchObject({ code: 'browser.not_found' });
    await expect(store.upsert('-option', { type: 'agent-browser-profile', name: 'A', enabled: true })).rejects.toMatchObject({ code: 'browser.invalid' });
    await expect(store.upsert('a', { type: 'agent-browser-profile', name: 'A', enabled: true, profilePath: './profile' })).rejects.toMatchObject({ code: 'browser.invalid' });
    await expect(store.upsert('a', { type: 'agent-browser-cdp', name: 'A', enabled: true, endpoint: { action: 'set', value: 'file:///private' } })).rejects.toMatchObject({ code: 'browser.invalid' });
    await expect(store.upsert('a', { type: 'agent-browser-cdp', name: 'A', enabled: true, endpoint: { action: 'keep' } })).rejects.toMatchObject({ code: 'browser.invalid' });
    expect((await store.list()).connections).toEqual([]);
  });
});

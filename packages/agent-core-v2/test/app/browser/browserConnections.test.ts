import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

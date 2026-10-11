import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { createMcpOAuthStore, IMcpOAuthStore, McpOAuthStoreAdapter } from '#/app/mcpConfig/oauthStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

describe('createMcpOAuthStore', () => {
  it('round-trips JSON data through the credentials/mcp scope', async () => {
    const calls: Array<{ op: string; scope: string; key: string; value?: unknown }> = [];
    const docs: Pick<IAtomicDocumentStore, 'get' | 'set' | 'delete'> = {
      async get<T>(scope: string, key: string): Promise<T | undefined> {
        calls.push({ op: 'get', scope, key });
        return { hello: 'world' } as T;
      },
      async set(scope, key, value) {
        calls.push({ op: 'set', scope, key, value });
      },
      async delete(scope, key) {
        calls.push({ op: 'delete', scope, key });
      },
    };
    const store = createMcpOAuthStore(docs as unknown as IAtomicDocumentStore);

    await expect(store.read('foo.json')).resolves.toEqual({ hello: 'world' });
    await store.write('foo.json', { token: 'abc' });
    await store.remove('foo.json');

    expect(calls).toEqual([
      { op: 'get', scope: 'credentials/mcp', key: 'foo.json' },
      { op: 'set', scope: 'credentials/mcp', key: 'foo.json', value: { token: 'abc' } },
      { op: 'delete', scope: 'credentials/mcp', key: 'foo.json' },
    ]);
  });

  it('returns undefined when the underlying document store read fails', async () => {
    const store = createMcpOAuthStore({
      get: async () => {
        throw new Error('corrupt json');
      },
      set: async () => {},
      delete: async () => {},
    } as unknown as IAtomicDocumentStore);

    await expect(store.read('bad.json')).resolves.toBeUndefined();
  });

  it('shares the base MCP OAuth directory while keeping isolated logins in the child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-mcp-oauth-space-'));
    const base = join(root, 'base');
    const home = join(root, 'child');
    const disposables = new DisposableStore();
    try {
      const docs = new JsonAtomicDocumentStore(new FileStorageService(home, 0o700, 0o600));
      const store = (credentialsHomeDir: string) => {
        const ix = createServices(disposables, { additionalServices: (registry) => {
          registry.defineInstance(IAtomicDocumentStore, docs);
          registry.definePartialInstance(IBootstrapService, { homeDir: home, credentialsHomeDir });
          registry.define(IMcpOAuthStore, McpOAuthStoreAdapter);
        } });
        return ix.get(IMcpOAuthStore);
      };
      await store(base).write('account.json', { token: 'shared' });
      expect(JSON.parse(await readFile(join(base, 'credentials', 'mcp', 'account.json'), 'utf8'))).toEqual({ token: 'shared' });
      await store(home).write('account.json', { token: 'isolated' });
      expect(await store(base).read('account.json')).toEqual({ token: 'shared' });
      expect(await store(home).read('account.json')).toEqual({ token: 'isolated' });
    } finally {
      await disposables.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

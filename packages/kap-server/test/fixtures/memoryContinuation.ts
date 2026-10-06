import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import fastify from 'fastify';
import { TestInstantiationService } from '@kiki/agent-core-v2/_base/di/test';
import { SyncDescriptor } from '@kiki/agent-core-v2/_base/di/descriptors';
import { IMemoryStore, MemoryStore } from '@kiki/agent-core-v2/app/memory/memoryStore';
import { IMemoryScopes } from '@kiki/agent-core-v2/app/memory/memoryScopes';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { IConfigService, type Scope } from '@kiki/agent-core-v2';
import { registerMemoryRoutes } from '../../src/routes/memory';

export async function memoryContinuationFixture() {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const home = await mkdtemp(join(process.cwd(), '.tmp', 'memory-continuation-'));
  const storage = new FileStorageService(home);
  const ix = new TestInstantiationService();
  ix.stub(IFileSystemStorageService, storage);
  ix.stub(IMemoryScopes, { resolve: async (scope) => `memory/${scope.kind}` });
  ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'review', budget: 2000, workspaces: {} }) as T });
  ix.set(IMemoryStore, new SyncDescriptor(MemoryStore));
  const store = ix.get(IMemoryStore);
  Object.defineProperty(store, 'queryBudget', { value: { records: 2, bytes: 2400 } });
  const encoder = new TextEncoder();
  for (const status of ['active', 'pending'] as const) {
    for (let index = 0; index < 5; index++) {
      const entry = { id: `m_${status}_${index}`, type: 'reference', title: `${status} continuation ${index}`, body: `${'Complete original content. '.repeat(30)}END-${status}-${index}`, status, pinned: false, created: '2026-01-01', updated: '2026-01-01', source: { writer: 'agent' }, reason: 'Bounded fixture', basis: { kind: 'observed', note: 'Fixture observation.' } };
      await storage.write('memory/global', `${status === 'pending' ? 'inbox' : 'entries'}/${entry.id}.md`, encoder.encode(`---\n${JSON.stringify(entry)}\n---\n${entry.body}\n`));
    }
  }
  await storage.write('memory/global', 'inbox/m_bad.md', encoder.encode('invalid record'));
  const app = fastify();
  registerMemoryRoutes(app as unknown as Parameters<typeof registerMemoryRoutes>[0], { accessor: { get: (token: Parameters<typeof ix.get>[0]) => ix.get(token) } } as unknown as Scope);
  await app.ready();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl);
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: `${url.pathname.replace(/^\/api/, '')}${url.search}`, headers: { 'content-type': 'application/json' }, payload: typeof init?.body === 'string' ? init.body : undefined });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  return { store, fetch, close: async () => { await app.close(); await ix.dispose(); await storage.close(); await rm(home, { recursive: true, force: true }); } };
}

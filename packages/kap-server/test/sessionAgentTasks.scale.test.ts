import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  IAtomicDocumentStore,
  IBootstrapService,
  IFileSystemStorageService,
  ISessionIndex,
  ISessionManager,
  type Scope,
} from '@kiki/agent-core-v2';
import type { SessionSummary } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { readSessionAgentTasks } from '../src/services/sessionAgentTasks';
import { registerTasksRoutes } from '../src/routes/tasks';

class MemoryDocsStore implements IAtomicDocumentStore {
  readonly _serviceBrand = undefined;
  private readonly docs = new Map<string, unknown>();
  private readonly byScope = new Map<string, string[]>();

  seed(scope: string, key: string, value: unknown): void {
    const full = `${scope}\0${key}`;
    if (!this.docs.has(full)) {
      let keys = this.byScope.get(scope);
      if (keys === undefined) {
        keys = [];
        this.byScope.set(scope, keys);
      }
      keys.push(key);
    }
    this.docs.set(full, value);
  }

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.docs.get(`${scope}\0${key}`) as T | undefined;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.seed(scope, key, value);
  }

  async update<T>(scope: string, key: string, updater: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    const next = updater(await this.get<T>(scope, key));
    if (next === undefined) this.docs.delete(`${scope}\0${key}`);
    else this.seed(scope, key, next);
    return next;
  }

  async delete(scope: string, key: string): Promise<void> {
    this.docs.delete(`${scope}\0${key}`);
  }

  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    const keys = this.byScope.get(scope) ?? [];
    return prefix === '' ? keys : keys.filter((key) => key.startsWith(prefix));
  }

  watch(): ReturnType<IAtomicDocumentStore['watch']> {
    return (() => ({ dispose: () => {} })) as ReturnType<IAtomicDocumentStore['watch']>;
  }

  acquire(): { dispose(): void } {
    return { dispose: () => {} };
  }
}

function makeScope(
  docs: IAtomicDocumentStore,
  storage: IFileSystemStorageService,
  summary: SessionSummary,
): Scope {
  const sessionManager = {
    get: () => undefined,
  };
  const sessionIndex = {
    get: async (id: string) => (id === summary.id ? summary : undefined),
  };
  const bootstrap = {
    homeDir: '/tmp/kiki-scale-home',
    scope: (name: string) => name,
  };
  const map = new Map<unknown, unknown>([
    [IAtomicDocumentStore, docs],
    [IBootstrapService, bootstrap],
    [IFileSystemStorageService, storage],
    [ISessionManager, sessionManager],
    [ISessionIndex, sessionIndex],
  ]);
  return {
    accessor: {
      get: (token: unknown) => {
        if (!map.has(token)) throw new Error(`Unexpected token: ${String(token)}`);
        return map.get(token);
      },
    },
  } as unknown as Scope;
}

describe('tasks 10,000-file scale behavior', () => {
  it('pages 10,000 cold agent tasks with compact HMAC page_token (< 768 bytes) even with hundreds of corrupt owners', async () => {
    const docs = new MemoryDocsStore();
    const workspaceId = 'ws-scale';
    const sessionId = 'sess-10k-agent-tasks';
    const base = `sessions/${workspaceId}/${sessionId}`;
    const mainTasksScope = `${base}/agents/main/tasks`;
    const now = 1_700_000_000_000;

    for (let i = 0; i < 10_000; i++) {
      const taskId = `tsk-${i.toString().padStart(8, '0')}`;
      docs.seed(mainTasksScope, `${taskId}.json`, {
        taskId,
        kind: 'process',
        ownerAgentId: 'main',
        description: `task ${i}`,
        status: 'completed',
        startedAt: now + i,
        endedAt: now + i + 1,
        command: 'echo ok',
        exitCode: 0,
      });
    }
    const corruptOwners: Record<string, { role: string }> = {};
    for (let i = 0; i < 200; i++) {
      const ownerId = `aaa-${i.toString().padStart(4, '0')}`;
      corruptOwners[ownerId] = { role: 'worker' };
      docs.seed(`${base}/agents/${ownerId}/tasks`, `bad-${i.toString().padStart(8, '0')}.json`, {
        invalid: true,
      });
    }
    docs.seed(base, 'state.json', { id: sessionId, agents: corruptOwners });

    const storage = {
      list: async () => [],
    } as unknown as IFileSystemStorageService;
    const summary: SessionSummary = {
      id: sessionId,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const core = makeScope(docs, storage, summary);

    let token: string | undefined;
    let firstItemsPage;
    let maxTokenBytes = 0;
    const start = performance.now();
    for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
      const page = await readSessionAgentTasks(core, summary, {
        page_size: 50,
        ...(token === undefined ? {} : { page_token: token }),
      });
      if (page.next_page_token !== undefined) {
        maxTokenBytes = Math.max(maxTokenBytes, page.next_page_token.length);
      }
      if (page.items.length > 0 && firstItemsPage === undefined) {
        firstItemsPage = page;
        token = page.next_page_token;
        break;
      }
      expect(page.has_more).toBe(true);
      token = page.next_page_token;
    }
    const sweepAndPage1Ms = performance.now() - start;
    expect(firstItemsPage).toBeDefined();
    expect(firstItemsPage!.items).toHaveLength(50);
    expect(firstItemsPage!.has_more).toBe(true);
    expect(firstItemsPage!.next_page_token).toEqual(expect.any(String));
    expect(maxTokenBytes).toBeLessThan(768);

    const page2Start = performance.now();
    const page2 = await readSessionAgentTasks(core, summary, {
      page_size: 50,
      page_token: token,
    });
    const page2Ms = performance.now() - page2Start;
    expect(page2.items).toHaveLength(50);
    expect(page2.items[0]!.id).not.toBe(firstItemsPage!.items[0]!.id);
    expect(page2.next_page_token!.length).toBeLessThan(768);
    console.log('session-agent-tasks-10k-scale', {
      totalTasks: 10_000,
      corruptOwners: 200,
      sweepAndPage1Ms: Number(sweepAndPage1Ms.toFixed(2)),
      page2Ms: Number(page2Ms.toFixed(2)),
      maxTokenBytes,
    });
  }, 30_000);

  it('filters 10,000 cold session tasks by status=running using metadata-only scans without reading completed output.log files', async () => {
    const docs = new MemoryDocsStore();
    const workspaceId = 'ws-scale';
    const sessionId = 'sess-10k-status-filter';
    const base = `sessions/${workspaceId}/${sessionId}`;
    const tasksScope = `${base}/agents/main/tasks`;
    const now = 1_700_000_000_000;

    for (let i = 0; i < 10_000; i++) {
      const taskId = `done-${i.toString().padStart(8, '0')}`;
      docs.seed(tasksScope, `${taskId}.json`, {
        taskId,
        kind: 'process',
        ownerAgentId: 'main',
        description: `done ${i}`,
        status: 'completed',
        startedAt: now + i,
        endedAt: now + i + 1,
        command: 'echo done',
        exitCode: 0,
      });
    }
    for (let i = 0; i < 5; i++) {
      const taskId = `run-${i.toString().padStart(8, '0')}`;
      docs.seed(tasksScope, `${taskId}.json`, {
        taskId,
        kind: 'process',
        ownerAgentId: 'main',
        description: `running ${i}`,
        status: 'running',
        startedAt: now + 20_000 + i,
        endedAt: null,
        command: 'sleep 10',
        exitCode: null,
      });
    }

    let outputLogReads = 0;
    let outputLogStats = 0;
    const storage = {
      stat: async (scope: string, key: string) => {
        if (key === 'output.log') outputLogStats += 1;
        if (key.endsWith('.json')) return { size: 128, identity: `${scope}/${key}`, revision: '1' };
        return undefined;
      },
      size: async (_scope: string, key: string) => {
        if (key === 'output.log') outputLogStats += 1;
        return undefined;
      },
      read: async (_scope: string, key: string) => {
        if (key === 'output.log') outputLogReads += 1;
        return undefined;
      },
      readRange: async () => undefined,
    } as unknown as IFileSystemStorageService;

    const summary: SessionSummary = {
      id: sessionId,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    const core = makeScope(docs, storage, summary);
    const app = Fastify();
    app.setValidatorCompiler(() => () => true);
    app.setSerializerCompiler(() => (data) => JSON.stringify(data));
    const routeHost = {
      get: (path: string, options: Record<string, unknown>, handler: unknown) =>
        (app.get as (p: string, o: unknown, h: unknown) => unknown)(path.replace(/\{([^}]+)\}/g, ':$1'), options, handler),
      post: (path: string, options: Record<string, unknown>, handler: unknown) =>
        (app.post as (p: string, o: unknown, h: unknown) => unknown)(path.replace(/\{([^}]+)\}/g, ':$1'), options, handler),
    };
    registerTasksRoutes(routeHost as unknown as Parameters<typeof registerTasksRoutes>[0], core);

    try {
      const start = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}/tasks?status=running&page_size=50`,
      });
      const elapsedMs = performance.now() - start;
      const body = res.json();
      expect(body.code).toBe(0);
      expect(body.data.items).toHaveLength(5);
      expect(body.data.has_more).toBe(false);
      expect(outputLogReads).toBe(0);
      expect(outputLogStats).toBeLessThanOrEqual(20);
      console.log('persisted-tasks-10k-status-filter', {
        totalTasks: 10_005,
        matched: body.data.items.length,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        outputLogReads,
        outputLogStats,
      });
    } finally {
      await app.close();
    }
  }, 30_000);
});

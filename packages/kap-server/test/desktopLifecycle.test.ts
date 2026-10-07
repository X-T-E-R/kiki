import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IAgentLifecycleService, IAgentTaskService, ISessionManager } from '@kiki/agent-core-v2';
import { desktopLifecycleStateSchema, metaResponseSchema } from '@kiki/protocol';
import {
  cleanupServerSessions,
  collectServerCleanupFailures,
  selectServerCleanupError,
  startServer,
  type RunningServer,
} from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

async function call(server: RunningServer, path: string, body?: object) {
  const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await response.json() as { code: number; data: unknown };
}

async function createTask(server: RunningServer, root: string, onCancel: () => void) {
  const created = await call(server, '/api/sessions', { metadata: { cwd: root } });
  expect(created.code).toBe(0);
  const session = server.core.accessor.get(ISessionManager).get((created.data as { id: string }).id)!;
  const agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
  const tasks = agent.accessor.get(IAgentTaskService);
  let release!: () => void;
  const cancelled = new Promise<void>(resolve => { release = resolve; });
  tasks.registerTask({ idPrefix: 'lifecycle', kind: 'process', description: 'Synthetic cancellable native task', start: sink => {
    sink.signal.addEventListener('abort', () => { onCancel(); release(); void sink.settle({ status: 'killed' }); }, { once: true });
  }, toInfo: base => ({ ...base, kind: 'process', command: 'synthetic-no-shell', pid: 0, exitCode: null }) });
  return { session, cancelled };
}

describe('server cleanup collection', () => {
  it('enumerates sessions at cleanup time and never removes a worktree after close fails', async () => {
    const events: string[] = [];
    const removed: string[] = [];
    const durableFailure = Object.assign(new Error('no space left on device'), { code: 'storage.disk_full' });
    let sessions: readonly { readonly id: string }[] = [];
    const failures = await collectServerCleanupFailures([
      { run: () => { events.push('http-closed'); sessions = [{ id: 'late-session' }]; } },
      {
        run: async () => {
          const nested = await cleanupServerSessions({
            listSessions: () => { events.push('inventory'); return sessions; },
            isEphemeral: () => true,
            readWorktreeId: async () => { events.push('worktree-read'); return 'late-worktree'; },
            closeSession: async () => { events.push('session-close'); throw durableFailure; },
            removeWorktree: async (id) => { events.push('worktree-remove'); removed.push(id); },
          });
          if (nested.length > 0) throw new AggregateError(nested.map((failure) => failure.error), 'session cleanup failed');
        },
      },
    ]);

    expect(events).toEqual(['http-closed', 'inventory', 'worktree-read', 'session-close']);
    expect(removed).toEqual([]);
    expect(failures[0]?.durable).toBe(true);
    expect(selectServerCleanupError(failures)).toBe(durableFailure);
  });

  it('preserves the known durable failure domain when a writer error has no registered code', async () => {
    const cleanupFailure = new Error('Example listener close failed');
    const durableFailure = new Error('Example checkpoint write failed');
    const failures = await collectServerCleanupFailures([
      { run: () => { throw cleanupFailure; } },
      { run: () => { throw durableFailure; }, durable: true },
    ]);
    expect(selectServerCleanupError(failures)).toBe(durableFailure);
  });

  it('prefers an earlier recognized persistence error over a later cleanup error', async () => {
    const persistenceFailure = Object.assign(new Error('storage unavailable'), { code: 'persistence.disk_full' });
    const cleanupFailure = new Error('later cleanup failed');
    const failures = await collectServerCleanupFailures([
      { run: async () => { throw persistenceFailure; } },
      { run: async () => { throw cleanupFailure; }, durable: true },
    ]);

    expect(selectServerCleanupError(failures)).toBe(persistenceFailure);
  });
});

describe('desktop-managed shared lifecycle', () => {
  it('exposes a typed flag map and refuses external services and stale instance consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_DESKTOP_BUNDLED: '0', KIKI_EXPERIMENTAL_WORK_PRESETS: 'true' }, logLevel: 'silent' });
      const meta = metaResponseSchema.parse((await call(server, '/api/meta')).data);
      expect(meta.experimental_flags?.['work_presets']).toBe(true); expect(meta.desktop_managed).toBe(false);
      const result = await call(server, '/api/desktop-lifecycle', { action: 'restart', server_id: meta.server_id, consent: true, interrupt_work: true });
      expect(result.code).not.toBe(0); expect((await call(server, '/api/meta')).code).toBe(0);
    } finally {
      await server?.close();
      if (server !== undefined) await expect(server.exitReceipt).resolves.toMatchObject({
        owner: 'backend', callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0,
      });
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it('retains unconfirmed work, drains confirmed cancellation, and leaves another home running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-pair-'));
    const servers: RunningServer[] = [];
    let cancelled = false;
    try {
      for (const name of ['a', 'b']) servers.push(await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: join(root, name), env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent' }));
      const a = servers[0]!, b = servers[1]!;
      const task = await createTask(a, root, () => { cancelled = true; });
      const state = desktopLifecycleStateSchema.parse((await call(a, '/api/desktop-lifecycle')).data);
      expect(state.work_pending).toContain(task.session.id); expect(state.managed).toBe(true);
      const request = { action: 'restart', server_id: state.server_id, consent: true, interrupt_work: true };
      expect((await call(a, '/api/desktop-lifecycle', { ...request, server_id: 'stale-example' })).code).not.toBe(0);
      expect((await call(a, '/api/desktop-lifecycle', { ...request, interrupt_work: false })).code).not.toBe(0);
      expect(cancelled).toBe(false);
      expect((await call(a, '/api/desktop-lifecycle', request)).code).toBe(0);
      await Promise.race([task.cancelled, new Promise((_, reject) => setTimeout(() => { reject(new Error('graceful cancellation did not drain')); }, 20_000))]);
      await a.closed;
      expect(cancelled).toBe(true); expect((await call(b, '/api/meta')).code).toBe(0);
    } finally { for (const server of servers.toReversed()) await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
});

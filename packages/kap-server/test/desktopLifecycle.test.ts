import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { ProcessTask } from '@kiki/agent-core-v2/agent/tools/os/bash/process-task';
import { IHostProcessService, type IHostProcess } from '@kiki/agent-core-v2/os/interface/hostProcess';
import { ISessionMcpHandle } from '@kiki/agent-core-v2/session/mcp/sessionMcpHandle';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IAgentExecutionService, IAgentLifecycleService, IAgentLoopService, IAgentTaskService, ISessionActivityView, ISessionManager } from '@kiki/agent-core-v2';
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
  it.skipIf(process.platform !== 'win32')('confirmed quit awaits real MCP and Bash owner-tree cleanup while another backend keeps its own tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-owned-quit-'));
    const helper = join(root, 'helper.exe');
    const source = fileURLToPath(new URL('../../agent-core-v2/src/os/backends/node-local/windowsProcessHelper.cs', import.meta.url));
    const fixture = fileURLToPath(new URL('../../agent-core-v2/test/mcpCore/fixtures/tree-stdio-server.mjs', import.meta.url));
    const servers: RunningServer[] = [];
    const processes: IHostProcess[] = [];
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      await promisify(execFile)(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:anycpu', `/out:${helper}`, source], { timeout: 30_000, windowsHide: true });
      vi.stubEnv('KIKI_WINDOWS_PROCESS_HELPER', helper);
      vi.stubEnv('KIKI_SEARCH_DISABLED', '1');
      for (const name of ['a', 'b']) servers.push(await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: join(root, name), env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent' }));
      const a = servers[0]!, b = servers[1]!;
      const created = await call(a, '/api/sessions', { metadata: { cwd: root } });
      expect(created.code).toBe(0);
      const session = a.core.accessor.get(ISessionManager).get((created.data as { id: string }).id)!;
      const mcp = session.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      await mcp.enableConfiguredServer!('owned-fixture', { transport: 'stdio', command: process.execPath, args: [fixture], runtime_id: 'local' }, 'caller');
      await mcp.connectionManager.reconnect('owned-fixture');
      const result = await mcp.connectionManager.resolved('owned-fixture')!.client.callTool('lifecycle', { action: 'keep' });
      const mcpPids = result.structuredContent as { root: number; leaf: number };
      const owner = a.core.accessor.get(IHostProcessService);
      const residentFile = join(root, 'resident.txt');
      const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore',detached:true});require('node:fs').writeFileSync(${JSON.stringify(residentFile)},String(child.pid));child.unref();`;
      const bash = await owner.spawn(process.execPath, ['-e', script], { ownedProcessTree: true, ownedProcessLifetime: 'owner' });
      processes.push(bash);
      bash.stdin.end();
      const agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const tasks = agent.accessor.get(IAgentTaskService);
      const taskId = tasks.registerTask(new ProcessTask(bash, 'resident fixture', 'completed resident fixture'), { detached: true });
      expect((await tasks.wait(taskId, 2_000))?.status).toBe('completed');
      const resident = Number(await readFile(residentFile, 'utf8'));
      const active = await owner.spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessTree: true, ownedProcessLifetime: 'owner' });
      processes.push(active);
      tasks.registerTask(new ProcessTask(active, 'active fixture', 'active fixture'), { detached: true });
      const sentinel = await b.core.accessor.get(IHostProcessService).spawn(process.execPath, ['-e', 'setTimeout(()=>{},15000)'], { ownedProcessTree: true, ownedProcessLifetime: 'owner' });
      processes.push(sentinel);
      const pids = [mcpPids.root, mcpPids.leaf, resident, active.pid];
      expect(pids.every(alive)).toBe(true);
      const state = desktopLifecycleStateSchema.parse((await call(a, '/api/desktop-lifecycle')).data);
      const request = { action: 'quit', server_id: state.server_id, consent: true, interrupt_work: true };
      expect((await call(a, '/api/desktop-lifecycle', { ...request, consent: false })).code).not.toBe(0);
      expect((await call(a, '/api/desktop-lifecycle', { ...request, interrupt_work: false })).code).not.toBe(0);
      expect(pids.every(alive)).toBe(true);
      expect((await call(a, '/api/desktop-lifecycle', request)).code).toBe(0);
      await a.closed;
      await expect(a.exitReceipt).resolves.toMatchObject({ callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0 });
      expect(pids.filter(alive)).toEqual([]);
      expect(alive(sentinel.pid)).toBe(true);
      expect((await call(b, '/api/meta')).code).toBe(0);
    } finally {
      for (const server of servers.toReversed()) await server.close();
      for (const proc of processes) { try { await proc.kill(); } catch { } await proc.dispose(); }
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 30_000);

  it('exposes a typed flag map and refuses external services and stale instance consent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-'));
    let server: RunningServer | undefined;
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_DESKTOP_BUNDLED: '0', KIKI_EXPERIMENTAL_WORK_PRESETS: 'true' }, logLevel: 'silent' });
      const meta = metaResponseSchema.parse((await call(server, '/api/meta')).data);
      expect(meta.experimental_flags?.['work_presets']).toBe(true); expect(meta.desktop_managed).toBe(false);
      for (const action of ['restart', 'quit']) {
        const result = await call(server, '/api/desktop-lifecycle', { action, server_id: meta.server_id, consent: true, interrupt_work: true });
        expect(result.code).not.toBe(0); expect((await call(server, '/api/meta')).code).toBe(0);
      }
    } finally {
      await server?.close();
      if (server !== undefined) await expect(server.exitReceipt).resolves.toMatchObject({
        owner: 'backend', callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0,
      });
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it.each(['restart', 'quit'])('%s retains unconfirmed work, drains confirmed cancellation, and leaves another home running', async (action) => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-pair-'));
    const servers: RunningServer[] = [];
    let cancelled = false;
    try {
      for (const name of ['a', 'b']) servers.push(await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: join(root, name), env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent' }));
      const a = servers[0]!, b = servers[1]!;
      const task = await createTask(a, root, () => { cancelled = true; });
      const state = desktopLifecycleStateSchema.parse((await call(a, '/api/desktop-lifecycle')).data);
      expect(state.work_pending).toContain(task.session.id); expect(state.managed).toBe(true);
      const request = { action, server_id: state.server_id, consent: true, interrupt_work: true };
      expect((await call(a, '/api/desktop-lifecycle', { ...request, consent: false })).code).not.toBe(0);
      expect((await call(a, '/api/desktop-lifecycle', { ...request, server_id: 'stale-example' })).code).not.toBe(0);
      expect((await call(a, '/api/desktop-lifecycle', { ...request, interrupt_work: false })).code).not.toBe(0);
      expect(cancelled).toBe(false);
      expect((await call(a, '/api/desktop-lifecycle', request)).code).toBe(0);
      await Promise.race([task.cancelled, new Promise((_, reject) => setTimeout(() => { reject(new Error('graceful cancellation did not drain')); }, 20_000))]);
      await a.closed;
      expect(cancelled).toBe(true); expect((await call(b, '/api/meta')).code).toBe(0);
    } finally { for (const server of servers.toReversed()) await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('restarts without interrupting an idle active goal and leaves that goal durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-goal-'));
    const servers: RunningServer[] = [];
    try {
      const open = () => startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent' });
      servers.push(await open());
      const server = servers[0]!;
      const created = await call(server, '/api/sessions', { metadata: { cwd: root } });
      expect(created.code).toBe(0);
      const sessionId = (created.data as { id: string }).id;
      expect((await call(server, `/api/sessions/${sessionId}/profile`, { agent_config: { goal_objective: 'keep the example goal' } })).code).toBe(0);
      const before = (await call(server, `/api/sessions/${sessionId}/goal`)).data as { goalId: string; status: string; objective: string };
      expect(before).toMatchObject({ status: 'active', objective: 'keep the example goal' });
      const live = server.core.accessor.get(ISessionManager).get(sessionId)!;
      const activity = live.accessor.get(ISessionActivityView).state();
      expect(activity.busy).toBe(true);
      expect(activity.pendingInteraction).toBe('none');
      expect(activity.mainTurnActive).toBe(false);
      for (const agent of live.accessor.get(IAgentLifecycleService).list()) {
        const loop = agent.accessor.get(IAgentLoopService).status();
        const execution = agent.accessor.get(IAgentExecutionService).status();
        expect(loop.state).toBe('idle');
        expect(loop.finalizing).toBeFalsy();
        expect(loop.persistenceFailure).toBeUndefined();
        expect(loop.hasPendingRequests).toBe(false);
        expect(loop.pendingTurnIds).toEqual([]);
        expect(['starting', 'running', 'cancelling']).not.toContain(execution.state);
        expect(agent.accessor.get(IAgentTaskService).list(true).some((task) => task.lifetime !== 'service')).toBe(false);
      }
      const listed = (await call(server, '/api/sessions')).data as { busy_count: number };
      expect(listed.busy_count).toBeGreaterThan(0);
      const state = desktopLifecycleStateSchema.parse((await call(server, '/api/desktop-lifecycle')).data);
      expect(state.managed).toBe(true);
      expect(state.draining).toBe(false);
      expect(state.work_pending).not.toContain(sessionId);
      expect((await call(server, '/api/desktop-lifecycle', { action: 'restart', server_id: state.server_id, consent: true, interrupt_work: false })).code).toBe(0);
      await server.closed;
      servers.push(await open());
      const restored = (await call(servers[1]!, `/api/sessions/${sessionId}/goal`)).data as { goalId: string; status: string; objective: string; terminalReason?: string } | null;
      expect(restored).toMatchObject({ goalId: before.goalId, objective: 'keep the example goal', status: 'paused', terminalReason: 'Paused after agent resume' });
    } finally { for (const server of servers.toReversed()) await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });

  it('refuses a non-interrupt restart while a finished task result is awaiting delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-lifecycle-delivery-'));
    let server: RunningServer | undefined;
    const delivery = new AbortController();
    try {
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: root, env: { ...process.env, KIKI_DESKTOP_BUNDLED: '1' }, logLevel: 'silent' });
      const created = await call(server, '/api/sessions', { metadata: { cwd: root } });
      expect(created.code).toBe(0);
      const session = server.core.accessor.get(ISessionManager).get((created.data as { id: string }).id)!;
      const agent = await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const tasks = agent.accessor.get(IAgentTaskService);
      const taskId = tasks.registerTask({
        idPrefix: 'lifecycle', kind: 'process', description: 'Finished task awaiting result delivery',
        start: sink => { void sink.settle({ status: 'completed' }); },
        toInfo: base => ({ ...base, kind: 'process', command: 'synthetic-no-shell', pid: 0, exitCode: 0 }),
      }, { detached: false });
      let completed = false;
      for (let attempt = 0; attempt < 50 && !completed; attempt += 1) {
        completed = tasks.getTask(taskId)?.status === 'completed';
        if (!completed) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(true);
      expect(tasks.list(true).some((task) => task.lifetime !== 'service')).toBe(false);
      expect(tasks.hasUnfinishedWork()).toBe(false);
      const loop = agent.accessor.get(IAgentLoopService).status();
      expect(loop.state).toBe('idle');
      expect(loop.hasPendingRequests).toBe(false);
      expect(loop.pendingTurnIds).toEqual([]);
      const idle = desktopLifecycleStateSchema.parse((await call(server, '/api/desktop-lifecycle')).data);
      expect(idle.work_pending).not.toContain(session.id);
      tasks.markTasksDeliveredViaWait([{ taskId, status: 'completed' }], 'tool-call-example', delivery.signal);
      expect(tasks.hasUnfinishedWork()).toBe(true);
      expect(tasks.getTask(taskId)?.status).toBe('completed');
      expect(agent.accessor.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', hasPendingRequests: false, pendingTurnIds: [] });
      const state = desktopLifecycleStateSchema.parse((await call(server, '/api/desktop-lifecycle')).data);
      expect(state.work_pending).toContain(session.id);
      expect((await call(server, '/api/desktop-lifecycle', { action: 'restart', server_id: state.server_id, consent: true, interrupt_work: false })).code).not.toBe(0);
      expect((await call(server, '/api/meta')).code).toBe(0);
    } finally {
      delivery.abort();
      await server?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});

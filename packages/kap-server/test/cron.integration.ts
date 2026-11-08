import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { CronScriptExecution } from '@kiki/protocol';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IModelCatalog,
  IConfigService,
  ICronScheduler,
  ICronTaskPersistence,
  ISessionCronService,
  ISessionContext,
  ISessionManager,
  getLiveSessionById,
  type CronTask,
} from '@kiki/agent-core-v2';
import { ensureMainAgent } from '@kiki/agent-core-v2/session/agentLifecycle/mainAgent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface CronTaskWire {
  id: string;
  session_id: string | null;
  workspace_id: string;
  cron: string;
  human_schedule: string;
  prompt_preview: string;
  next_fire_at: string | null;
  recurring: boolean;
  paused: boolean;
  age_days: number;
  stale: boolean;
  created_at: string;
  last_fired_at: string | null;
}

describe('cron management routes', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let modelCatalog: IModelCatalog;

  async function boot() {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', seeds: [[IModelCatalog, modelCatalog]] });
    base = `http://127.0.0.1:${server.port}`;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-cron-routes-'));
    await writeFile(join(home, 'config.toml'), '[cron]\nmanual_tick = true\nno_jitter = true\n');
    modelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
      getConnectionRequester: () => { throw new Error('not exercised'); },
      getConnectionEndpoint: () => { throw new Error('not exercised'); },
      inspect: () => {
        throw new Error('modelCatalog.inspect not exercised in this test');
      },
      ping: () => {
        throw new Error('modelCatalog.ping not exercised in this test');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('modelCatalog.getProvider not exercised in this test');
      },
      setDefaultModel: async () => {
        throw new Error('modelCatalog.setDefaultModel not exercised in this test');
      },
    };
    await boot();
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function request<T>(path: string, method = 'GET', data?: unknown): Promise<Envelope<T>> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer, data === undefined ? {} : { 'content-type': 'application/json' }),
      body: data === undefined ? undefined : JSON.stringify(data),
    } as never);
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<T>>;
  }

  async function createSession(cwd = home as string): Promise<string> {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await response.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  function cronFor(sessionId: string): ISessionCronService {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    return session.accessor.get(ISessionCronService);
  }

  async function addTask(
    sessionId: string,
    overrides: Partial<Pick<CronTask, 'cron' | 'prompt' | 'recurring'>> = {},
  ): Promise<CronTask> {
    const cron = cronFor(sessionId);
    const task = await cron.addTask({
      cron: overrides.cron ?? '*/5 * * * *',
      prompt: overrides.prompt ?? `prompt for ${sessionId}`,
      recurring: overrides.recurring ?? true,
    });
    await cron.flushPersist();
    return task;
  }

  it('creates and reads complete prompts, edits in place, and rebinds the same task without copying', async () => {
    const source = await createSession();
    const target = await createSession();
    const prompt = '完整定时任务内容\n'.repeat(100);
    const created = await request<{ task: CronTaskWire & { prompt: string } }>('/api/cron', 'POST', {
      session_id: source, cron: '0 * * * *', prompt, paused: true,
    });
    expect(created.code).toBe(0);
    const task = created.data.task;
    expect(task).toMatchObject({ session_id: source, prompt, paused: true, recurring: true, delivery_mode: 'idle' });
    expect(task.prompt_preview).not.toBe(prompt);
    const detail = await request<{ task: CronTaskWire & { prompt: string } }>(`/api/cron/${task.id}?session_id=${source}`);
    expect(detail.data.task.prompt).toBe(prompt);
    const store = server!.core.accessor.get(ICronTaskPersistence);
    const original = cronFor(source).getTask(task.id)!;
    await store.save(task.workspace_id, { ...original, lastFiredAt: original.createdAt });
    await cronFor(source).syncTaskFromStore(task.id);
    const edited = await request<{ task: CronTaskWire & { prompt: string } }>(`/api/cron/${task.id}?session_id=${source}`, 'PATCH', {
      session_id: target, cron: '15 * * * *', prompt: 'edited', recurring: false, delivery_mode: 'steer',
    });
    expect(edited.code).toBe(0);
    expect(edited.data.task).toMatchObject({ id: task.id, session_id: target, prompt: 'edited', cron: '15 * * * *', paused: true, recurring: false, created_at: task.created_at, last_fired_at: task.created_at });
    expect(edited.data.task).toHaveProperty('delivery_mode', 'steer');
    expect(cronFor(source).getTask(task.id)).toBeUndefined();
    expect(cronFor(target).getTask(task.id)).toMatchObject({ id: task.id, createdAt: original.createdAt, lastFiredAt: original.createdAt, paused: true });
    expect(await store.list({ workspaceId: task.workspace_id })).toHaveLength(1);
    expect((await request(`/api/cron/${task.id}?session_id=${source}`)).code).toBe(40406);
    await server!.core.accessor.get(ISessionManager).close(source);
    await server!.core.accessor.get(ISessionManager).close(target);
    const cold = await request<{ task: CronTaskWire & { prompt: string } }>(`/api/cron/${task.id}?session_id=${target}`, 'PATCH', { prompt: 'cold edit' });
    expect(cold.data.task).toMatchObject({ id: task.id, paused: true, prompt: 'cold edit', last_fired_at: task.created_at, delivery_mode: 'steer' });
    expect((await request(`/api/cron/${task.id}?session_id=${target}`, 'PATCH', { delivery_mode: 'invalid' })).code).toBe(40001);
    const rebound = await request<{ task: CronTaskWire }>(`/api/cron/${task.id}?session_id=${target}`, 'PATCH', { session_id: source });
    expect(rebound.data.task.session_id).toBe(source);
    expect((await request(`/api/cron/${task.id}?session_id=${source}`)).code).toBe(0);
    const coldCreate = await request<{ task: CronTaskWire }>('/api/cron', 'POST', { session_id: target, cron: '0 9 * * *', prompt: 'cold create', paused: true, delivery_mode: 'queue' });
    expect(coldCreate.code).toBe(0);
    expect(coldCreate.data.task).toMatchObject({ session_id: target, delivery_mode: 'queue' });
    expect(getLiveSessionById(server!.core.accessor, source)).toBeUndefined();
    expect(getLiveSessionById(server!.core.accessor, target)).toBeUndefined();
  });

  it('rejects invalid edits and leaves identity, pause, cursor and persistence intact on save failure', async () => {
    const sessionId = await createSession();
    const task = await addTask(sessionId);
    const path = `/api/cron/${task.id}?session_id=${sessionId}`;
    for (const data of [{ cron: '60 * * * *' }, { prompt: '  ' }, {}, { id: 'replacement' }, { paused: true }]) {
      expect((await request(path, 'PATCH', data)).code).toBe(40001);
    }
    expect((await request('/api/cron', 'POST', { session_id: 'missing', cron: '0 * * * *', prompt: 'example' })).code).toBe(40401);
    expect((await request(path, 'PATCH', { session_id: 'missing' })).code).toBe(40401);
    const store = server!.core.accessor.get(ICronTaskPersistence);
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('EIO update fixture'));
    const failed = await request(path, 'PATCH', { prompt: 'not saved' });
    expect(failed.code).not.toBe(0);
    expect(failed.msg).toContain('EIO update fixture');
    expect(cronFor(sessionId).getTask(task.id)).toEqual(task);
    save.mockRestore();
    expect((await store.listWorkspaceIds()).length).toBe(1);
    expect(await store.get((await store.listWorkspaceIds())[0]!, task.id)).toEqual(task);
    const unauthenticated = await fetch(`${base}${path}`);
    expect(unauthenticated.status).toBe(401);
  });

  it('returns errors for live pause/delete persistence failures without claiming saved state', async () => {
    const sessionId = await createSession();
    const task = await addTask(sessionId);
    const cron = cronFor(sessionId);
    const store = server!.core.accessor.get(ICronTaskPersistence);
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('EIO pause fixture'));
    const pauseResponse = await fetch(`${base}/api/cron/${task.id}:pause?session_id=${sessionId}`, { method: 'POST', headers: authHeaders(server as RunningServer) });
    const pause = await pauseResponse.json() as Envelope<unknown>;
    expect(pause.code).not.toBe(0);
    expect(pause.msg).toContain('EIO pause fixture');
    expect(cron.getTask(task.id)).toEqual(task);
    save.mockRestore();
    const remove = vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('EIO delete fixture'));
    const deleteResponse = await fetch(`${base}/api/cron/${task.id}?session_id=${sessionId}`, { method: 'DELETE', headers: authHeaders(server as RunningServer) });
    const deleted = await deleteResponse.json() as Envelope<unknown>;
    expect(deleted.code).not.toBe(0);
    expect(deleted.msg).toContain('EIO delete fixture');
    expect(cron.getTask(task.id)).toEqual(task);
    remove.mockRestore();
    const listed = await request<{ items: CronTaskWire[] }>(`/api/cron?session_id=${sessionId}`);
    expect(listed.data.items).toEqual([expect.objectContaining({ id: task.id, paused: false })]);
    expect((await request(`/api/cron/${task.id}:pause?session_id=${sessionId}`, 'POST')).code).toBe(0);
    expect((await request(`/api/cron/${task.id}?session_id=${sessionId}`, 'DELETE')).code).toBe(0);
  });

  it('rejects cross-workspace migration and disambiguates duplicate task ids before any write', async () => {
    const source = await createSession();
    const otherRoot = join(home!, 'other-workspace');
    await mkdir(otherRoot);
    const target = await createSession(otherRoot);
    const task = await addTask(source);
    const createdTarget = await addTask(target);
    const list = await request<{ items: CronTaskWire[] }>('/api/cron');
    const targetWorkspace = list.data.items.find((item) => item.id === createdTarget.id)!.workspace_id;
    expect((await request(`/api/cron/${task.id}?session_id=${source}`, 'PATCH', { session_id: target })).code).toBe(40001);
    expect(cronFor(source).getTask(task.id)).toEqual(task);
    const store = server!.core.accessor.get(ICronTaskPersistence);
    await store.save(targetWorkspace, { ...task, tags: { sessionId: target } });
    await cronFor(target).syncTaskFromStore(task.id);
    expect((await request(`/api/cron/${task.id}`)).code).toBe(40001);
    expect((await request(`/api/cron/${task.id}`, 'PATCH', { prompt: 'ambiguous edit' })).code).toBe(40001);
    const detail = await request<{ task: CronTaskWire & { prompt: string } }>(`/api/cron/${task.id}?session_id=${source}`);
    expect(detail.data.task).toMatchObject({ id: task.id, session_id: source, prompt: task.prompt });
    expect(cronFor(source).getTask(task.id)).toEqual(task);
    expect(cronFor(target).getTask(task.id)?.prompt).toBe(task.prompt);
  });

  it('caps the cross-workspace list and exposes subsequent pages', async () => {
    const sessionId = await createSession();
    await addTask(sessionId, { prompt: 'first' });
    await addTask(sessionId, { prompt: 'second' });
    await addTask(sessionId, { prompt: 'third' });
    const first = await request<{ items: CronTaskWire[]; has_more: boolean; next_offset?: number }>(
      '/api/cron?page_size=2',
    );
    expect(first.data.items).toHaveLength(2);
    expect(first.data).toMatchObject({ has_more: true, next_offset: 2 });
    const second = await request<{ items: CronTaskWire[]; has_more: boolean }>(
      '/api/cron?page_size=2&offset=2',
    );
    expect(second.data.items).toHaveLength(1);
    expect(second.data.has_more).toBe(false);
    expect(new Set([...first.data.items, ...second.data.items].map((item) => item.id)).size).toBe(3);
    const invalid = await request<null>('/api/cron?page_size=101');
    expect(invalid.code).toBe(40001);
  });

  it('aggregates scheduled tasks across sessions with management fields', async () => {
    const firstSession = await createSession();
    const secondSession = await createSession();
    const first = await addTask(firstSession, { prompt: 'first scheduled prompt' });
    const second = await addTask(secondSession, {
      cron: '0 9 * * 1',
      prompt: 'second scheduled prompt',
      recurring: false,
    });

    const body = await request<{ items: CronTaskWire[] }>('/api/cron');
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(2);
    const byId = new Map(body.data.items.map((task) => [task.id, task]));
    expect(byId.get(first.id)).toMatchObject({
      session_id: firstSession,
      cron: '*/5 * * * *',
      human_schedule: 'every 5 minutes',
      prompt_preview: 'first scheduled prompt',
      recurring: true,
      paused: false,
      stale: false,
    });
    expect(byId.get(second.id)).toMatchObject({
      session_id: secondSession,
      cron: '0 9 * * 1',
      prompt_preview: 'second scheduled prompt',
      recurring: false,
      paused: false,
    });
    expect(typeof byId.get(first.id)?.age_days).toBe('number');
    expect(byId.get(first.id)?.next_fire_at).toEqual(expect.any(String));

    const filtered = await request<{ items: CronTaskWire[] }>(
      `/api/cron?session_id=${encodeURIComponent(firstSession)}`,
    );
    expect(filtered.data.items.map((task) => task.id)).toEqual([first.id]);
  });

  it('round-trips pause and resume while treating legacy missing paused as active', async () => {
    const sessionId = await createSession();
    const task = await addTask(sessionId);

    const initial = await request<{ items: CronTaskWire[] }>('/api/cron');
    expect(initial.data.items[0]?.paused).toBe(false);

    await server!.core.accessor.get(ISessionManager).close(sessionId);
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();

    const paused = await request<{ task: CronTaskWire }>(
      `/api/cron/${task.id}:pause?session_id=${encodeURIComponent(sessionId)}`,
      'POST',
    );
    expect(paused.code).toBe(0);
    expect(paused.data.task.paused).toBe(true);
    expect(paused.data.task.next_fire_at).toBeNull();
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();

    const resumed = await request<{ task: CronTaskWire }>(
      `/api/cron/${task.id}:resume?session_id=${encodeURIComponent(sessionId)}`,
      'POST',
    );
    expect(resumed.code).toBe(0);
    expect(resumed.data.task.paused).toBe(false);
    expect(resumed.data.task.next_fire_at).toEqual(expect.any(String));
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
  });

  it('deletes a scheduled task', async () => {
    const sessionId = await createSession();
    const task = await addTask(sessionId);

    const deleted = await request<{ deleted: true }>(
      `/api/cron/${task.id}?session_id=${encodeURIComponent(sessionId)}`,
      'DELETE',
    );
    expect(deleted.code).toBe(0);
    expect(deleted.data).toEqual({ deleted: true });
    expect(cronFor(sessionId).getTask(task.id)).toBeUndefined();

    const listed = await request<{ items: CronTaskWire[] }>('/api/cron');
    expect(listed.data.items).toEqual([]);
  });

  it('immediately triggers a scheduled task through the owning session service', async () => {
    const sessionId = await createSession();
    const task = await addTask(sessionId);
    const cron = cronFor(sessionId);
    const fire = vi.spyOn(cron, 'fireTaskNow').mockResolvedValue({ triggered: true });

    const triggered = await request<{ triggered: true }>(
      `/api/cron/${task.id}:run?session_id=${encodeURIComponent(sessionId)}`,
      'POST',
    );
    expect(triggered.code).toBe(0);
    expect(triggered.data).toEqual({ triggered: true });
    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith(task.id);
  });

  it('confirms an owner script, consumes its skip, and retains its cursor across a server restart', async () => {
    const clock = join(home!, 'clock.txt');
    const start = new Date(2026, 0, 1, 12, 1).getTime();
    await writeFile(clock, String(start));
    const config = server!.core.accessor.get(IConfigService);
    const script = { id: 'check', command: process.execPath, args: ['-e', 'process.exit(3)'], workspaces: [home!], timeout: 5 };
    await config.set('cron', { clock: `file:${clock}`, scripts: [script] });
    expect(config.get('cron')).toMatchObject({ scripts: [script] });
    const sessionId = await createSession();
    const session = getLiveSessionById(server!.core.accessor, sessionId)!;
    expect(session.accessor.get(ISessionContext).cwd).toBe(home);
    await ensureMainAgent(session);
    const previewPath = `/api/cron/scripts?session_id=${sessionId}&script=check`;
    expect((await fetch(`${base}${previewPath}`)).status).toBe(401);
    const preview = await request<{ execution: CronScriptExecution }>(previewPath);
    expect(preview.data.execution).toMatchObject({ command: process.execPath, args: script.args, cwd: home, environment: 'isolated' });
    const create = { session_id: sessionId, cron: '*/30 * * * *', prompt: 'only when the check hits', trigger: { script: 'check' } };
    expect((await request('/api/cron', 'POST', create)).code).toBe(40001);
    for (const trigger of [{ probability: -0.01 }, { probability: 1.01 }, { probability: '1' }, { script: 'node.exe -e code' }, { script: 'check', command: 'ignored' }]) {
      expect((await request('/api/cron', 'POST', { ...create, trigger })).code).toBe(40001);
    }
    const created = await request<{ task: CronTaskWire }>('/api/cron', 'POST', { ...create, script_confirmation: preview.data.execution });
    expect(created.code).toBe(0);
    const task = created.data.task;
    const detailPath = `/api/cron/${task.id}?session_id=${sessionId}`;
    const run = await request(`/api/cron/${task.id}:run?session_id=${sessionId}`, 'POST');
    expect(run.data).toMatchObject({ triggered: false, check: { reason: 'exit_code', exitCode: 3 } });
    await writeFile(clock, String(start + 30 * 60_000));
    await server!.core.accessor.get(ICronScheduler).tick();
    const afterSkip = await request<{ task: CronTaskWire }>(detailPath);
    expect(afterSkip.data.task).toMatchObject({ last_fired_at: null, trigger: create.trigger, approved_script: preview.data.execution, last_trigger_check: { checkedAt: start + 30 * 60_000, reason: 'exit_code', exitCode: 3 } });
    await server!.close();
    server = undefined;
    await writeFile(clock, String(start + 32 * 60_000));
    await boot();
    await server!.core.accessor.get(ICronScheduler).tick();
    const restored = await request<{ task: CronTaskWire }>(detailPath);
    const { age_days: _beforeAge, ...beforeRestart } = afterSkip.data.task;
    const { age_days: _afterAge, ...afterRestart } = restored.data.task;
    expect(afterRestart).toEqual(beforeRestart);
    expect(getLiveSessionById(server!.core.accessor, sessionId)).toBeUndefined();
    await server!.core.accessor.get(IConfigService).set('cron', { scripts: [{ ...script, args: ['-e', 'process.exit(4)'] }] });
    expect((await request(detailPath, 'PATCH', { script_confirmation: preview.data.execution })).code).toBe(40001);
    const updatedPreview = await request<{ execution: CronScriptExecution }>(previewPath);
    expect((await request(detailPath, 'PATCH', { script_confirmation: updatedPreview.data.execution })).code).toBe(0);
    const cleared = await request<{ task: CronTaskWire }>(detailPath, 'PATCH', { trigger: null });
    expect(cleared.data.task).not.toHaveProperty('trigger');
    expect(cleared.data.task).not.toHaveProperty('approved_script');
  });

  it('returns task-not-found business errors for missing task operations', async () => {
    const sessionId = await createSession();
    const suffix = `?session_id=${encodeURIComponent(sessionId)}`;

    const paused = await request<null>(`/api/cron/deadbeef:pause${suffix}`, 'POST');
    const resumed = await request<null>(`/api/cron/deadbeef:resume${suffix}`, 'POST');
    const triggered = await request<null>(`/api/cron/deadbeef:run${suffix}`, 'POST');
    const deleted = await request<null>(`/api/cron/deadbeef${suffix}`, 'DELETE');

    expect(paused.code).toBe(40406);
    expect(resumed.code).toBe(40406);
    expect(triggered.code).toBe(40406);
    expect(deleted.code).toBe(40406);
  });
});

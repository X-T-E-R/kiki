import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IModelCatalog,
  ISessionCronService,
  ISessionManager,
  getLiveSessionById,
  type CronTask,
} from '@kiki/agent-core-v2';
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-cron-routes-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
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
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelCatalog, modelCatalog]],
    });
    base = `http://127.0.0.1:${server.port}`;
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

  async function request<T>(path: string, method = 'GET'): Promise<Envelope<T>> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<T>>;
  }

  async function createSession(): Promise<string> {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
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
    const task = cron.addTask({
      cron: overrides.cron ?? '*/5 * * * *',
      prompt: overrides.prompt ?? `prompt for ${sessionId}`,
      recurring: overrides.recurring ?? true,
    });
    await cron.flushPersist();
    return task;
  }

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
    const fire = vi.spyOn(cron, 'fireTaskNow').mockResolvedValue(true);

    const triggered = await request<{ triggered: true }>(
      `/api/cron/${task.id}:run?session_id=${encodeURIComponent(sessionId)}`,
      'POST',
    );
    expect(triggered.code).toBe(0);
    expect(triggered.data).toEqual({ triggered: true });
    expect(fire).toHaveBeenCalledOnce();
    expect(fire).toHaveBeenCalledWith(task.id);
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

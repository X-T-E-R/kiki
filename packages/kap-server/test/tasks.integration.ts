import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IAgentLifecycleService,
  IAgentTaskService,
  ISessionContext,
  getLiveSessionById,
  IModelCatalog,
  IAtomicDocumentStore,
  IFileSystemStorageService,
  ISessionMetadata,
  IAppendLogStore,
  ISessionManager,
  type AgentTask,
} from '@kiki/agent-core-v2';
import { listAgentTasksResponseSchema, type ListAgentTasksResponse } from '@kiki/protocol';
import { HttpChannel } from '@kiki/klient/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface TaskWire {
  id: string;
  session_id: string;
  kind: string;
  description: string;
  status: string;
  command?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  output_preview?: string;
  output_bytes?: number;
  total_bytes?: number;
  receipt?: { schemaVersion: number; path: string; bytes: number; contentState: string };
  receipt_verification?: string;
  agent_id?: string;
  profile?: string;
  parent_tool_call_id?: string;
  run_in_background?: boolean;
}

interface ListWire {
  items: TaskWire[];
  has_more: boolean;
  next_offset?: number;
}

describe('server-v2 /api/sessions/{sid}/tasks', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    const scratch = fileURLToPath(new URL('../../../.tmp/agent-task-tests/', import.meta.url));
    await mkdir(scratch, { recursive: true });
    home = await mkdtemp(join(scratch, 'task-metadata-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
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

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function mainAgentTasks(sessionId: string): Promise<IAgentTaskService> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agent =
      session.accessor.get(IAgentLifecycleService).get('main') ??
      (await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' }));
    return agent.accessor.get(IAgentTaskService);
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  function fakeTask(kind: 'process' | 'agent' | 'question', output?: string): AgentTask {
    return {
      idPrefix: 'test',
      kind,
      description: `fake ${kind} task`,
      start: (sink) => {
        if (output !== undefined) sink.appendOutput(output);
      },
      toInfo: (base) => {
        switch (kind) {
          case 'process':
            return { ...base, kind: 'process', command: 'echo hi', pid: 0, exitCode: null };
          case 'agent':
            return {
              ...base,
              kind: 'agent',
              agentId: 'sub-1',
              profile: 'explore',
              parentToolCallId: 'call-parent-1',
              model: 'provider/secondary',
              thinkingEffort: 'low',
            };
          case 'question':
            return { ...base, kind: 'question', questionCount: 1 };
        }
      },
    };
  }

  it('returns an empty list when the session has no main agent (gap G10)', async () => {
    const id = await createSession();
    const { body } = await getJson<ListWire>(`/api/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('returns an empty list when the main agent has no tasks yet', async () => {
    const id = await createSession();
    await mainAgentTasks(id);
    const { body } = await getJson<ListWire>(`/api/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('materializes the main agent with the AGENTS.md reminder step bridge', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    expect(tasks.list()).toEqual([]);
  });

  it('lists registered tasks with mapped kind/status and wire-shaped fields', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const processId = tasks.registerTask(fakeTask('process'));
    const agentId = tasks.registerTask(fakeTask('agent'));
    const questionId = tasks.registerTask(fakeTask('question'));
    await flush();

    const { body } = await getJson<ListWire>(`/api/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    const byId = new Map(body.data.items.map((t) => [t.id, t]));
    expect(byId.size).toBe(3);

    const process = byId.get(processId);
    expect(process).toMatchObject({
      id: processId,
      session_id: id,
      kind: 'bash',
      status: 'running',
      description: 'fake process task',
      command: 'echo hi',
    });
    expect(typeof process?.created_at).toBe('string');

    expect(byId.get(agentId)).toMatchObject({
      id: agentId,
      session_id: id,
      kind: 'subagent',
      status: 'running',
      model: 'provider/secondary',
      thinking_effort: 'low',
      agent_id: 'sub-1',
      profile: 'explore',
      parent_tool_call_id: 'call-parent-1',
    });
    expect(byId.get(agentId)?.command).toBeUndefined();

    expect(byId.get(questionId)).toMatchObject({
      id: questionId,
      session_id: id,
      kind: 'tool',
      status: 'running',
    });
    expect(byId.get(processId)?.agent_id).toBeUndefined();
    expect(byId.get(questionId)?.agent_id).toBeUndefined();
    expect(byId.get(processId)?.profile).toBeUndefined();
    expect(byId.get(questionId)?.profile).toBeUndefined();
    expect(byId.get(processId)?.parent_tool_call_id).toBeUndefined();
    expect(byId.get(questionId)?.parent_tool_call_id).toBeUndefined();
  });

  it('returns a verified receipt reference without changing output_bytes preview semantics', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask({
      ...fakeTask('agent'),
      async start(sink) {
        sink.setFinalOutput?.('complete report');
        await sink.settle({ status: 'completed' });
      },
    });
    await tasks.wait(taskId);
    const response = await getJson<TaskWire>(`/api/sessions/${id}/tasks/${taskId}?with_output=true`);
    expect(response.body.code).toBe(0);
    expect(response.body.data).toMatchObject({
      receipt_verification: 'verified',
      total_bytes: 15,
      receipt: { schemaVersion: 1, path: `tasks/${taskId}/output.log`, bytes: 15, contentState: 'final' },
    });
    expect(response.body.data.output_bytes).toBeLessThanOrEqual(response.body.data.total_bytes ?? 0);
  });

  it('refreshes same-size receipt corruption on GET and paginated list without leaking preview or byte count', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask({
      ...fakeTask('agent'),
      async start(sink) {
        sink.setFinalOutput?.('original report');
        await sink.settle({ status: 'completed' });
      },
    });
    await tasks.wait(taskId);
    const path = `/api/sessions/${id}/tasks`;
    const before = await getJson<TaskWire>(`${path}/${taskId}?with_output=true`);
    expect(before.body.data).toMatchObject({ receipt_verification: 'verified', total_bytes: 15 });
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const outputPath = join(session.accessor.get(ISessionContext).sessionDir, 'agents', 'main', 'tasks', taskId, 'output.log');
    await writeFile(outputPath, 'altered  report');
    expect(Buffer.byteLength('altered  report')).toBe(Buffer.byteLength('original report'));
    const after = await getJson<TaskWire>(`${path}/${taskId}?with_output=true`);
    expect(after.body.code).toBe(0);
    expect(after.body.data).toMatchObject({ receipt_verification: 'invalid', status: 'completed' });
    expect(after.body.data).not.toHaveProperty('receipt');
    expect(after.body.data).not.toHaveProperty('total_bytes');
    expect(after.body.data).not.toHaveProperty('output_preview');
    const list = await getJson<ListWire>(`${path}?page_size=1&offset=0`);
    expect(list.body.code).toBe(0);
    const item = list.body.data.items.find((task) => task.id === taskId);
    expect(item).toMatchObject({ receipt_verification: 'invalid', status: 'completed' });
    expect(item).not.toHaveProperty('receipt');
    expect(item).not.toHaveProperty('total_bytes');
  });

  it('reports run_in_background from the task detached flag', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const backgroundId = tasks.registerTask(fakeTask('agent'));
    const foregroundId = tasks.registerTask(fakeTask('agent'), { detached: false });
    await flush();

    const { body } = await getJson<ListWire>(`/api/sessions/${id}/tasks`);
    expect(body.code).toBe(0);
    const byId = new Map(body.data.items.map((t) => [t.id, t]));
    expect(byId.get(backgroundId)?.run_in_background).toBe(true);
    expect(byId.get(foregroundId)?.run_in_background).toBe(false);

    const single = await getJson<TaskWire>(`/api/sessions/${id}/tasks/${foregroundId}`);
    expect(single.body.data.run_in_background).toBe(false);
  });

  it('filters the list by wire status', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    tasks.registerTask(fakeTask('process'));
    await flush();

    const running = await getJson<ListWire>(`/api/sessions/${id}/tasks?status=running`);
    expect(running.body.code).toBe(0);
    expect(running.body.data.items).toHaveLength(1);
    expect(running.body.data.items[0]?.status).toBe('running');

    const completed = await getJson<ListWire>(`/api/sessions/${id}/tasks?status=completed`);
    expect(completed.body.code).toBe(0);
    expect(completed.body.data.items).toEqual([]);
  });

  it('bounds and pages task lists without repeating rows', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const ids = Array.from({ length: 4 }, () => tasks.registerTask(fakeTask('process')));
    await flush();
    const first = await getJson<ListWire>(`/api/sessions/${id}/tasks?page_size=2`);
    expect(first.body.data.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.body.data).toMatchObject({ has_more: true, next_offset: 2 });
    const second = await getJson<ListWire>(`/api/sessions/${id}/tasks?page_size=2&offset=2`);
    expect(second.body.data.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(second.body.data.has_more).toBe(false);
    const invalid = await getJson<null>(`/api/sessions/${id}/tasks?page_size=101`);
    expect(invalid.body.code).toBe(40001);
  });

  it('gets a single task by id and 40406 for an unknown task', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    const subagentId = tasks.registerTask(fakeTask('agent'));
    await flush();

    const got = await getJson<TaskWire>(`/api/sessions/${id}/tasks/${taskId}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data).toMatchObject({ id: taskId, session_id: id, kind: 'bash' });
    expect(got.body.data.agent_id).toBeUndefined();

    const gotSubagent = await getJson<TaskWire>(`/api/sessions/${id}/tasks/${subagentId}`);
    expect(gotSubagent.body.code).toBe(0);
    expect(gotSubagent.body.data).toMatchObject({
      id: subagentId,
      session_id: id,
      kind: 'subagent',
      agent_id: 'sub-1',
      profile: 'explore',
      parent_tool_call_id: 'call-parent-1',
    });

    const missing = await getJson<null>(`/api/sessions/${id}/tasks/nope`);
    expect(missing.body.code).toBe(40406);
  });

  it('includes output_preview / output_bytes when with_output is set', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process', 'hello world'));
    await flush();

    const got = await getJson<TaskWire>(
      `/api/sessions/${id}/tasks/${taskId}?with_output=true`,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data.output_preview).toBe('hello world');
    expect(got.body.data.output_bytes).toBe(Buffer.byteLength('hello world', 'utf-8'));

    const plain = await getJson<TaskWire>(`/api/sessions/${id}/tasks/${taskId}`);
    expect(plain.body.code).toBe(0);
    expect(plain.body.data.output_preview).toBeUndefined();
    expect(plain.body.data.output_bytes).toBeUndefined();
  });

  it('cancels a running task and reports 40904 on a second cancel', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    await flush();

    const cancelled = await postJson<{ cancelled: boolean }>(
      `/api/sessions/${id}/tasks/${taskId}:cancel`,
    );
    expect(cancelled.body.code).toBe(0);
    expect(cancelled.body.data).toEqual({ cancelled: true });
    expect(tasks.getTask(taskId)?.stopReason).toBe('Aborted by the user');

    const again = await postJson<{ cancelled: boolean }>(
      `/api/sessions/${id}/tasks/${taskId}:cancel`,
    );
    expect(again.body.code).toBe(40904);
    expect(again.body.data).toEqual({ cancelled: false });
    expect(again.body.details).toEqual({ current_status: 'cancelled' });
  });

  it('cancelling an unknown task returns 40406', async () => {
    const id = await createSession();
    await mainAgentTasks(id);
    const { body } = await postJson<null>(`/api/sessions/${id}/tasks/nope:cancel`);
    expect(body.code).toBe(40406);
  });

  it('rejects a bare POST without the :cancel suffix (40001)', async () => {
    const id = await createSession();
    const tasks = await mainAgentTasks(id);
    const taskId = tasks.registerTask(fakeTask('process'));
    await flush();

    const { body } = await postJson<null>(`/api/sessions/${id}/tasks/${taskId}`);
    expect(body.code).toBe(40001);
  });

  it('reads unopened child and grandchild task metadata with owner provenance and no body reads', async () => {
    const id = await createSession();
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    await mainAgentTasks(id);
    const child = await lifecycle.create({ agentId: 'child', delegator: { kind: 'agent', agentId: 'main' } });
    const grandchild = await lifecycle.create({ agentId: 'grandchild', delegator: { kind: 'agent', agentId: 'child' } });
    const childTasks = child.accessor.get(IAgentTaskService);
    const grandTasks = grandchild.accessor.get(IAgentTaskService);
    await childTasks.suppressAllTerminalNotifications();
    const running = grandTasks.registerTask(fakeTask('process'));
    const dispatch = childTasks.registerTask({ ...fakeTask('agent'), toInfo: (base) => ({ ...base, kind: 'agent', agentId: 'grandchild' }) });
    await flush();
    const roster = lifecycle.list().map((agent) => agent.id);
    const createSpy = vi.spyOn(lifecycle, 'create');
    const wireSpy = vi.spyOn(server!.core.accessor.get(IAppendLogStore), 'read');
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const bytesSpy = vi.spyOn(storage, 'read');
    const streamSpy = vi.spyOn(storage, 'readStream');
    const snapshotSpy = vi.spyOn(childTasks, 'getTaskSnapshot');
    const channel = new HttpChannel({ endpoint: base, token: server!.localOwnerToken });
    try {
      const result = await channel.rest.sessions.listAgentTasks(id);
      expect(listAgentTasksResponseSchema.safeParse(result).success).toBe(true);
      expect(result.coverage).toMatchObject({ total_owners: 3, completed_owners: 3, pending_owners: 0, failed_owners: 0, complete: true });
      expect(result.items).toHaveLength(2);
      expect(result.items.find((task) => task.id === running)).toMatchObject({ owner_agent_id: 'grandchild', source: 'live', status: 'running' });
      expect(result.items.find((task) => task.id === dispatch)).toMatchObject({ owner_agent_id: 'child', agent_id: 'grandchild', kind: 'subagent' });
      expect(result.items.filter((task) => task.kind !== 'subagent')).toHaveLength(1);
      expect(lifecycle.list().map((agent) => agent.id)).toEqual(roster);
      expect(createSpy).not.toHaveBeenCalled();
      expect(wireSpy).not.toHaveBeenCalled();
      expect(bytesSpy.mock.calls.every(([, key]) => key === 'state.json' || /^test-[0-9a-z]{8}\.json$/.test(key))).toBe(true);
      expect(streamSpy).not.toHaveBeenCalled();
      expect(snapshotSpy).not.toHaveBeenCalled();
      expect(result.items.every((task) => task.output_preview === undefined)).toBe(true);
    } finally {
      await channel.close(); createSpy.mockRestore(); wireSpy.mockRestore(); bytesSpy.mockRestore(); streamSpy.mockRestore(); snapshotSpy.mockRestore();
    }
    const completed = childTasks.registerTask({ ...fakeTask('process'), start: async (sink) => { sink.setFinalOutput?.('example result'); await sink.settle({ status: 'completed' }); } });
    await childTasks.wait(completed);
    const cancelled = childTasks.registerTask(fakeTask('process'));
    await childTasks.stopByUser(cancelled);
    const terminal = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks`);
    expect(terminal.body.data.items.find((task) => task.id === completed)?.status).toBe('completed');
    expect(terminal.body.data.items.find((task) => task.id === cancelled)?.status).toBe('cancelled');
    expect(terminal.body.data.items).toHaveLength(4);
  });

  it('drains metadata pages through cold owners and legacy main fallback without duplicates or materialization', async () => {
    const id = await createSession();
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const scope = session.accessor.get(ISessionContext).scope();
    const docs = server!.core.accessor.get(IAtomicDocumentStore);
    const persisted = (taskId: string, ownerAgentId?: string) => ({ taskId, ownerAgentId, kind: 'process', command: 'echo example', pid: 0, exitCode: 0,
      description: 'persisted example', status: 'completed', startedAt: 1000, endedAt: 2000, detached: true });
    const taskIds = ['test-00000001', 'test-00000002', 'test-00000003'];
    for (const taskId of taskIds) await docs.set(`${scope}/agents/cold/tasks`, `${taskId}.json`, persisted(taskId, 'cold'));
    await docs.set(`${scope}/agents/cold/tasks`, 'test-00000003.json', { ...persisted('test-00000003', 'cold'), status: 'running', endedAt: null });
    await docs.set(`${scope}/agents/cold/tasks`, 'test-00000001.json', { ...persisted('test-00000001', 'cold'), receiptVerification: 'verified',
      receipt: { schemaVersion: 1, path: 'tasks/test-00000001/output.log', mediaType: 'text/plain; charset=utf-8', bytes: 123,
        sha256: '0'.repeat(64), contentState: 'final', committedAt: '2026-06-04T10:00:00.000Z' } });
    await docs.set(`${scope}/session-meta`, 'state.json', { agents: { 'stale-legacy-owner': {} } });
    await docs.set(`${scope}/agents/copied/tasks`, `${taskIds[0]}.json`, persisted(taskIds[0]!, 'cold'));
    await docs.set(`${scope}/agents/main/tasks`, 'test-00000004.json', persisted('test-00000004', 'main'));
    await docs.set(`${scope}/tasks`, 'test-00000004.json', persisted('test-00000004'));
    await docs.set(`${scope}/tasks`, 'test-00000005.json', { task_id: 'test-00000005', description: 'legacy example', command: 'echo old', pid: 0,
      status: 'killed', started_at: 1000, ended_at: 2000, exit_code: null });
    await session.accessor.get(ISessionMetadata).registerAgent('empty', { type: 'sub', parentAgentId: 'main' });
    await server!.core.accessor.get(ISessionManager).close(id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
    const manager = server!.core.accessor.get(ISessionManager);
    const resumeSpy = vi.spyOn(manager, 'resume');
    const wireSpy = vi.spyOn(server!.core.accessor.get(IAppendLogStore), 'read');
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const bytesSpy = vi.spyOn(storage, 'read');
    const streamSpy = vi.spyOn(storage, 'readStream');
    const metadataSpy = vi.spyOn(docs, 'get');
    try {
      let token: string | undefined;
      const rows: ListAgentTasksResponse['items'] = [];
      let last: ListAgentTasksResponse | undefined;
      let calls = 0;
      do {
        const beforeReads = metadataSpy.mock.calls.length;
        const response = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks?page_size=1${token === undefined ? '' : `&page_token=${encodeURIComponent(token)}`}`);
        expect(response.body.code).toBe(0);
        last = response.body.data;
        expect(last.items.length).toBeLessThanOrEqual(1);
        expect(metadataSpy.mock.calls.slice(beforeReads).filter(([path]) => path.endsWith('/tasks')).length).toBeLessThanOrEqual(1);
        rows.push(...last.items);
        token = last.next_page_token;
        calls++;
        expect(calls).toBeLessThan(12);
        if (token !== undefined) expect(last.coverage.complete).toBe(false);
      } while (token !== undefined);
      expect(rows.map((row) => row.id).toSorted()).toEqual([...taskIds, 'test-00000004', 'test-00000005']);
      expect(rows.every((row) => row.source === 'persisted')).toBe(true);
      expect(rows.find((row) => row.id === 'test-00000005')?.status).toBe('cancelled');
      expect(rows.find((row) => row.id === 'test-00000003')).toMatchObject({ source: 'persisted', status: 'running' });
      expect(rows.find((row) => row.id === 'test-00000001')?.receipt?.bytes).toBe(123);
      expect(rows.find((row) => row.id === 'test-00000001')?.receipt_verification).toBeUndefined();
      expect(calls).toBe(7);
      expect(last?.owners.find((owner) => owner.owner_agent_id === 'empty')?.state).toBe('complete');
      expect(last?.coverage).toMatchObject({ total_owners: 4, completed_owners: 4, failed_owners: 0, pending_owners: 0, complete: true });
      expect(last?.has_more).toBe(false);
      expect(resumeSpy).not.toHaveBeenCalled();
      expect(wireSpy).not.toHaveBeenCalled();
      expect(bytesSpy.mock.calls.every(([, key]) => key === 'state.json' || /^test-[0-9a-z]{8}\.json$/.test(key))).toBe(true);
      expect(streamSpy).not.toHaveBeenCalled();
      expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
    } finally { resumeSpy.mockRestore(); wireSpy.mockRestore(); bytesSpy.mockRestore(); streamSpy.mockRestore(); metadataSpy.mockRestore(); }
  });

  it('distinguishes failed metadata and failed inventory from empty owners, and progresses after failure', async () => {
    const id = await createSession();
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const scope = session.accessor.get(ISessionContext).scope();
    const docs = server!.core.accessor.get(IAtomicDocumentStore);
    await docs.set(`${scope}/agents/broken/tasks`, 'test-00000001.json', { taskId: 'test-00000099' });
    await docs.set(`${scope}/agents/broken/tasks`, 'test-00000002.json', { taskId: 'test-00000098' });
    const original = docs.list.bind(docs);
    const listSpy = vi.spyOn(docs, 'list').mockImplementation((path, prefix) => path === `${scope}/agents/failing/tasks` ? Promise.reject(new Error('synthetic read failure')) : original(path, prefix));
    await session.accessor.get(ISessionMetadata).registerAgent('failing', { type: 'sub', parentAgentId: 'main' });
    try {
      const response = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks`);
      expect(response.body.code).toBe(0);
      expect(response.body.data).toMatchObject({ items: [], has_more: false, partial: true,
        coverage: { completed_owners: 1, failed_owners: 2, pending_owners: 0, complete: false, inventory_complete: true } });
      expect(response.body.data.coverage.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner_agent_id: 'broken', stage: 'task_metadata', task_id: 'test-00000001' }),
        expect.objectContaining({ owner_agent_id: 'failing', stage: 'owner' }),
      ]));
      let page = (await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks?page_size=1`)).body.data;
      expect(page).toMatchObject({ partial: true, has_more: true });
      let pages = 1;
      while (page.next_page_token !== undefined) {
        page = (await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks?page_size=1&page_token=${encodeURIComponent(page.next_page_token)}`)).body.data;
        expect(++pages).toBeLessThan(5);
      }
      expect(page.coverage).toMatchObject({ completed_owners: 1, failed_owners: 2, pending_owners: 0, complete: false });
      expect(page.coverage.failures).toHaveLength(2);
    } finally { listSpy.mockRestore(); }
    const storage = server!.core.accessor.get(IFileSystemStorageService);
    const storageList = storage.list.bind(storage);
    const inventorySpy = vi.spyOn(storage, 'list').mockImplementation((path) => path === `${scope}/agents` ? Promise.reject(new Error('synthetic inventory failure')) : storageList(path));
    try {
      const response = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks`);
      expect(response.body.data.coverage).toMatchObject({ inventory_complete: false, complete: false });
      expect(response.body.data.partial).toBe(true);
      expect(response.body.data.coverage.failures).toContainEqual(expect.objectContaining({ stage: 'inventory' }));
    } finally { inventorySpy.mockRestore(); }
  });

  it('keeps agent-tasks session/auth boundaries and rejects altered or source-invalidated continuation', async () => {
    const id = await createSession();
    const otherId = await createSession();
    const tasks = await mainAgentTasks(id);
    tasks.registerTask(fakeTask('process'));
    tasks.registerTask(fakeTask('process'));
    const first = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks?page_size=1`);
    expect(first.body.data.has_more).toBe(true);
    const token = first.body.data.next_page_token!;
    const second = await getJson<ListAgentTasksResponse>(`/api/sessions/${id}/agent-tasks?page_size=1&page_token=${encodeURIComponent(token)}`);
    expect(second.body.data.has_more).toBe(false);
    expect(second.body.data.coverage.complete).toBe(true);
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]!.id).not.toBe(first.body.data.items[0]!.id);
    if (tasks.rollbackTaskRegistration === undefined) throw new Error('Task registration rollback is unavailable');
    await tasks.rollbackTaskRegistration(first.body.data.items[0]!.id);
    expect((await getJson<null>(`/api/sessions/${id}/agent-tasks?page_token=${encodeURIComponent(token)}`)).body.code).toBe(40001);
    const foreign = await getJson<null>(`/api/sessions/${otherId}/agent-tasks?page_token=${encodeURIComponent(token)}`);
    expect(foreign.body.code).toBe(40001);
    const altered = await getJson<null>(`/api/sessions/${id}/agent-tasks?page_token=${encodeURIComponent(token + 'x')}`);
    expect(altered.body.code).toBe(40001);
    const empty = await getJson<ListAgentTasksResponse>(`/api/sessions/${otherId}/agent-tasks`);
    expect(empty.body.data.items).toEqual([]);
    expect(empty.body.data.coverage.complete).toBe(true);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'new-owner' });
    const changed = await getJson<null>(`/api/sessions/${id}/agent-tasks?page_token=${encodeURIComponent(token)}`);
    expect(changed.body.code).toBe(40001);
    const unauthenticated = await fetch(`${base}/api/sessions/${id}/agent-tasks`);
    expect(unauthenticated.status).toBe(401);
    expect((await getJson<null>('/api/sessions/missing/agent-tasks')).body.code).toBe(40401);
    expect((await getJson<null>(`/api/sessions/${id}/agent-tasks?page_size=101`)).body.code).toBe(40001);
  });

  it('returns 40401 for an unknown session on all three endpoints', async () => {
    const list = await getJson<null>('/api/sessions/nope/tasks');
    expect(list.body.code).toBe(40401);

    const got = await getJson<null>('/api/sessions/nope/tasks/tid');
    expect(got.body.code).toBe(40401);

    const cancelled = await postJson<null>('/api/sessions/nope/tasks/tid:cancel');
    expect(cancelled.body.code).toBe(40401);
  });
});

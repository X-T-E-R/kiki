import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLiveSessionById, resumeSessionById, IAgentLifecycleService,
} from '@kiki/agent-core-v2';
import { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '@kiki/agent-core-v2/agent/fullCompaction/fullCompaction';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import { IWireService } from '@kiki/agent-core-v2/wire/wire';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

const config = [
  'default_model = "test"',
  '[providers.openai]',
  'type = "openai"',
  'api_key = "sk-test"',
  '[models.test]',
  'provider = "openai"',
  'model = "test"',
  'max_context_size = 550000',
  '[loop_control]',
  'context_strategy = "auto"',
  'subagent_context_strategy = "auto"',
  '',
].join('\n');

function text(role: 'user' | 'assistant', value: string) {
  return { role, content: [{ type: 'text' as const, text: value }], toolCalls: [] };
}

describe('relay-v1 REST and cold wire contract', () => {
  let home: string;
  let server: RunningServer | undefined;
  let base: string;

  const start = async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-context-relay-'));
    await writeFile(join(home, 'config.toml'), config);
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'custom.md'), '---\nname: custom\ndescription: Custom agent\ncontext_strategy: auto\nmodel_profiles:\n  - alias: test\n    context_strategy: fresh\n---\n\nYou are helpful.\n');
    await writeFile(join(home, 'agents', 'child.md'), '---\nname: child\ndescription: Child agent\ncontext_strategy: summarize\n---\n\nYou are helpful.\n');
    await start();
  });

  afterEach(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<Envelope<T>> {
    const response = await fetch(`${base}${path}`, {
      method, headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<Envelope<T>>;
  }

  async function create() {
    const result = await request<{ id: string }>('/api/sessions', 'POST', {
      metadata: { cwd: home }, agent_config: { profile: 'custom', model: 'test' },
    });
    expect(result.code, result.msg).toBe(0);
    return result.data.id;
  }

  it('resolves model-profile choice below session override and isolates native children', async () => {
    const id = await create();
    const path = `/api/sessions/${id}/agents/main/context-strategy`;
    const profile = await request<{ strategy: string; source: string }>(path);
    expect(profile.data).toMatchObject({ strategy: 'fresh', source: 'profile' });
    const chosen = await request<{ strategy: string; source: string }>(path, 'PATCH', { strategy: 'summarize' });
    expect(chosen.data).toMatchObject({ strategy: 'summarize', source: 'session' });

    const session = getLiveSessionById(server!.core.accessor, id)!;
    const child = await session.accessor.get(IAgentLifecycleService).create({
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'child', model: 'test' },
    });
    const childStatus = await request<{ strategy: string; source: string }>(`/api/sessions/${id}/agents/${child.id}/context-strategy`);
    expect(childStatus.data).toMatchObject({ strategy: 'summarize', source: 'profile' });
    const rejected = await request<unknown>(`/api/sessions/${id}/agents/${child.id}/context-strategy`, 'PATCH', { strategy: 'fresh' });
    expect(rejected.code).not.toBe(0);
    expect((await request<{ strategy: string; source: string }>(path)).data).toMatchObject({ strategy: 'summarize', source: 'session' });
  });

  it('persists only the selected global context strategy', async () => {
    const id = await create();
    const path = `/api/sessions/${id}/agents/main/context-strategy`;
    const saved = await request<{ strategy: string; source: string }>(path, 'PATCH', { strategy: 'fresh', save: 'global' });
    expect(saved.code, saved.msg).toBe(0);
    const text = await readFile(join(home, 'config.toml'), 'utf8');
    expect(text).toContain('context_strategy = "fresh"');
    expect(text).not.toContain('compaction_soft_context_size');
  });

  it('runs explicit REST relay without a model call and restores the exact window from durable wire', async () => {
    const id = await create();
    const live = getLiveSessionById(server!.core.accessor, id)!;
    const agent = live.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = agent.accessor.get(IAgentContextMemoryService);
    memory.append(
      text('user', 'Original question'), text('assistant', 'First conclusion'),
      text('user', 'Follow up'), text('assistant', 'Second conclusion'),
      text('user', 'New request'), text('assistant', 'Last conclusion'),
      text('user', 'Continue with the result'),
    );
    live.accessor.get(ISessionTodoService).setNotes({ goal: 'Complete the task', next: 'Continue' },
      { turnId: 0, step: 1, toolCallId: 'initial-notes' });

    const compaction = agent.accessor.get(IAgentFullCompactionService);
    let dispose = () => {};
    const finished = new Promise<Awaited<NonNullable<typeof compaction.compacting>['promise']>>((resolve) => {
      const subscription = compaction.onDidFinishCompaction((task) => {
        subscription.dispose();
        void task.promise.then(resolve);
      });
      dispose = () => subscription.dispose();
    });
    try {
      const response = await request<unknown>(`/api/sessions/${id}:compact`, 'POST', { strategy: 'relay' });
      expect(response.code, response.msg).toBe(0);
      const result = await finished;
      expect(result.strategy).toBe('relay');
      const expected = structuredClone(memory.get());
      expect(expected.some((message) => message.origin?.kind === 'compaction_summary')).toBe(true);
      const wire = agent.accessor.get(IWireService);
      await wire.flush();
      const records = [];
      for await (const record of wire.readJournal()) records.push(record);
      expect(records.filter((record) => record.type === 'context.apply_compaction')).toEqual([
        expect.objectContaining({ strategy: 'relay', shapeVersion: 1, summary: expect.stringContaining('Working notes') }),
      ]);

      await server!.close();
      server = undefined;
      await start();
      const restored = await resumeSessionById(server!.core.accessor, id);
      expect(restored).toBeDefined();
      const resumedAgent = restored!.accessor.get(IAgentLifecycleService).get('main')!;
      expect(resumedAgent.accessor.get(IAgentContextMemoryService).get()).toEqual(expected);
    } finally {
      dispose();
    }
  }, 30_000);
});

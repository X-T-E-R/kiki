import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getLiveSessionById, resumeSessionById, IAgentLifecycleService, IAgentPromptService,
} from '@kiki/agent-core-v2';
import { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '@kiki/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IMergeTool } from '@kiki/agent-core-v2/features/btw/tools/mergeTool';
import { IHistoryListTool } from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import { IHistoryReadTool, IHistorySearchTool } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
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

const config = (endpoint: string) => [
  'default_model = "test"',
  '[providers.openai]',
  'type = "openai"',
  `base_url = "${endpoint}/v1"`,
  'api_key = "fixture-not-a-secret"',
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
  let provider: Server;
  let modelCalls: number;
  let scriptedReplyText: string | undefined;

  const start = async () => {
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0,
      homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-context-relay-'));
    modelCalls = 0;
    scriptedReplyText = undefined;
    provider = createServer((_request, response) => {
      modelCalls++;
      if (scriptedReplyText !== undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'fixture-branch-resp', choices: [{ index: 0, delta: { content: scriptedReplyText }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Unexpected model call in relay fixture' } }));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture provider address');
    await writeFile(join(home, 'config.toml'), config(`http://127.0.0.1:${address.port}`));
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'custom.md'), '---\nname: custom\ndescription: Custom agent\ncontext_strategy: auto\nmodel_profiles:\n  - alias: test\n    context_strategy: fresh\n---\n\nYou are helpful.\n');
    await writeFile(join(home, 'agents', 'child.md'), '---\nname: child\ndescription: Child agent\ncontext_strategy: summarize\n---\n\nYou are helpful.\n');
    await writeFile(join(home, 'agents', 'plain.md'), '---\nname: plain\ndescription: Plain agent without profile context_strategy\n---\n\nYou are helpful.\n');
    await start();
  });

  afterEach(async () => {
    await server?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      provider.close((error) => {
        if (error !== undefined) { reject(error); return; }
        resolve();
      });
    });
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<Envelope<T>> {
    const init: RequestInit = {
      method, headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await fetch(`${base}${path}`, init);
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

    const plainSession = await request<{ id: string }>('/api/sessions', 'POST', {
      metadata: { cwd: home }, agent_config: { profile: 'plain', model: 'test' },
    });
    expect(plainSession.code, plainSession.msg).toBe(0);
    const plainId = plainSession.data.id;
    const plainPath = `/api/sessions/${plainId}/agents/main/context-strategy`;
    expect((await request<{ strategy: string; source: string }>(plainPath)).data).toMatchObject({ strategy: 'auto', source: 'global' });

    const modelBefore = await request<{ revision: string; context_strategy?: string }>('/api/models/test');
    expect(modelBefore.data.context_strategy).toBeUndefined();
    const patchedModel = await request<{ revision: string; context_strategy?: string }>('/api/models/test', 'PATCH', {
      base_revision: modelBefore.data.revision,
      context_strategy: 'fresh',
    });
    expect(patchedModel.code, patchedModel.msg).toBe(0);
    expect(patchedModel.data.context_strategy).toBe('fresh');
    expect((await request<{ context_strategy?: string }>('/api/models/test')).data.context_strategy).toBe('fresh');

    expect((await request<{ strategy: string; source: string }>(plainPath)).data).toMatchObject({ strategy: 'fresh', source: 'model' });
    const plainLive = getLiveSessionById(server!.core.accessor, plainId)!;
    const plainChild = await plainLive.accessor.get(IAgentLifecycleService).create({
      delegator: { kind: 'agent', agentId: 'main' },
      binding: { profile: 'plain', model: 'test' },
    });
    expect((await request<{ strategy: string; source: string }>(`/api/sessions/${plainId}/agents/${plainChild.id}/context-strategy`)).data)
      .toMatchObject({ strategy: 'fresh', source: 'model' });

    await request<{ revision: string }>('/api/models/test', 'PATCH', {
      base_revision: patchedModel.data.revision,
      context_strategy: null,
    });
    expect((await request<{ context_strategy?: string }>('/api/models/test')).data.context_strategy).toBeUndefined();
    expect((await request<{ strategy: string; source: string }>(plainPath)).data).toMatchObject({ strategy: 'auto', source: 'global' });
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
    memory.append({ ...text('assistant', 'Reviewed the current handoff'), toolCalls: [
      { type: 'function', id: 'initial-notes', name: 'TodoList', arguments: '{}' },
    ] });
    live.accessor.get(ISessionTodoService).setNotes({ goal: 'Complete the task', next: 'Continue' },
      { turnId: 0, step: 1, toolCallId: 'initial-notes', reviewHandoff: true });
    memory.append({ role: 'tool', content: [{ type: 'text', text: 'Working notes updated' }], toolCalls: [], toolCallId: 'initial-notes' });

    const compaction = agent.accessor.get(IAgentFullCompactionService);
    let dispose = () => {};
    const finished = new Promise<Awaited<NonNullable<typeof compaction.compacting>['promise']>>((resolve, reject) => {
      const subscription = compaction.onDidFinishCompaction((task) => {
        subscription.dispose();
        void task.promise.then(resolve, reject);
      });
      dispose = () => { subscription.dispose(); };
    });
    try {
      const response = await request<unknown>(`/api/sessions/${id}:compact`, 'POST', { strategy: 'relay' });
      expect(response.code, response.msg).toBe(0);
      const result = await finished;
      expect(result.strategy).toBe('relay');
      expect(modelCalls).toBe(0);
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

  it('merges model-authored branch summary with agent_id pointer and reads live + cold branch transcripts via HistoryList, HistoryRead, and HistorySearch', async () => {
    scriptedReplyText = 'Branch investigated retry-jitter-token-771 and verified exponential cap.';
    const sessionRes = await request<{ id: string }>('/api/sessions', 'POST', {
      metadata: { cwd: home },
      agent_config: { profile: 'agent', model: 'test' },
    });
    expect(sessionRes.code, sessionRes.msg).toBe(0);
    const sessionId = sessionRes.data.id;

    const branchRes = await request<{
      agent_id: string;
      parent_agent_id: string;
      seed: string;
      tools_locked: boolean;
      title?: string;
    }>(`/api/sessions/${sessionId}:branch`, 'POST', {
      seed: 'fresh',
      title: 'Retry Jitter Audit',
    });
    expect(branchRes.code, branchRes.msg).toBe(0);
    const branchId = branchRes.data.agent_id;
    expect(branchId).toBeTruthy();

    const live = getLiveSessionById(server!.core.accessor, sessionId)!;
    const branchHandle = live.accessor.get(IAgentLifecycleService).get(branchId)!;
    const submitted = await branchHandle.accessor.get(IAgentPromptService).enqueue({
      id: 'branch-turn-0-prompt',
      message: {
        id: 'branch-turn-0-prompt',
        role: 'user',
        origin: { kind: 'user' },
        toolCalls: [],
        content: [{ type: 'text', text: 'Audit retry-jitter-token-771 behavior in detail.' }],
      },
    });
    await submitted.completion;

    const mergeTool = branchHandle.accessor.get(IMergeTool);
    const mergeExec = await mergeTool.resolveExecution({
      summary: 'Retry jitter cap is 60s; no retry storm found.',
      asks: ['Keep 5m persistence backoff separate'],
      done: true,
    });
    if (!('execute' in mergeExec)) throw new Error('Expected executable Merge tool');
    const mergeResult = await mergeExec.execute({
      signal: new AbortController().signal,
      turnId: 0,
      toolCallId: 'call-merge-1',
    });
    expect(mergeResult.isError).toBeUndefined();

    const mainHandle = live.accessor.get(IAgentLifecycleService).get('main')!;
    const mainMessages = mainHandle.accessor.get(IAgentContextMemoryService).get();
    const foldMsg = mainMessages.find((m) => m.origin?.kind === 'branch_fold');
    expect(foldMsg).toBeDefined();
    const foldText = (foldMsg!.content[0] as { type: 'text'; text: string }).text;
    expect(foldText).toContain(`Merged branch ${branchId} (Retry Jitter Audit):`);
    expect(foldText).toContain('Retry jitter cap is 60s; no retry storm found.');
    expect(foldText).toContain(`HistoryList({ agent_id: "${branchId}" })`);
    expect(foldText).toContain(`HistoryRead({ agent_id: "${branchId}", turn: 0 })`);
    expect(foldText).not.toContain('Edited files:');
    expect(foldText).not.toContain('Commands run:');

    const runTool = async (agent: typeof mainHandle, token: never, input: Record<string, unknown>) => {
      const tool = agent.accessor.get(token) as { resolveExecution(arg: unknown): Promise<{ execute(ctx: unknown): Promise<{ isError?: boolean; output: string }> }> | { execute(ctx: unknown): Promise<{ isError?: boolean; output: string }> } };
      const exec = await tool.resolveExecution(input);
      const res = await exec.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'hist-call' });
      expect(res.isError, res.output).not.toBe(true);
      return JSON.parse(res.output) as Record<string, unknown>;
    };

    const liveAgents = await runTool(mainHandle, IHistoryListTool as never, { kind: 'agents', raw: true });
    const listedAgents = liveAgents['agents'] as Array<Record<string, unknown>>;
    expect(listedAgents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: branchId, kind: 'branch', branch_title: 'Retry Jitter Audit', sealed: true }),
    ]));

    const liveTurns = await runTool(mainHandle, IHistoryListTool as never, { agent_id: branchId, kind: 'turns' });
    expect((liveTurns['turns'] as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(1);

    const liveReadById = await runTool(mainHandle, IHistoryReadTool as never, { agent_id: branchId, turn: 0 });
    expect(JSON.stringify(liveReadById)).toContain('Audit retry-jitter-token-771 behavior in detail.');
    expect(JSON.stringify(liveReadById)).toContain('Branch investigated retry-jitter-token-771 and verified exponential cap.');

    const liveReadByTitle = await runTool(mainHandle, IHistoryReadTool as never, { agent_id: 'Retry Jitter Audit', turn: 0 });
    expect(JSON.stringify(liveReadByTitle)).toContain('retry-jitter-token-771');

    const liveSearch = await runTool(mainHandle, IHistorySearchTool as never, {
      agent_id: branchId,
      query: 'retry-jitter-token-771',
      source: 'transcript',
    });
    expect(JSON.stringify(liveSearch)).toContain('retry-jitter-token-771');

    await branchHandle.accessor.get(IWireService).flush();
    await mainHandle.accessor.get(IWireService).flush();
    await server!.close();
    server = undefined;
    await start();

    const restored = await resumeSessionById(server!.core.accessor, sessionId);
    const coldMain = restored!.accessor.get(IAgentLifecycleService).get('main')!;
    const coldAgents = await runTool(coldMain, IHistoryListTool as never, { kind: 'agents', raw: true });
    expect(coldAgents['agents'] as Array<Record<string, unknown>>).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: branchId, kind: 'branch' }),
    ]));
    const coldRead = await runTool(coldMain, IHistoryReadTool as never, { agent_id: branchId, turn: 0 });
    expect(JSON.stringify(coldRead)).toContain('Audit retry-jitter-token-771 behavior in detail.');
    expect(JSON.stringify(coldRead)).toContain('Branch investigated retry-jitter-token-771 and verified exponential cap.');
  }, 40_000);
});

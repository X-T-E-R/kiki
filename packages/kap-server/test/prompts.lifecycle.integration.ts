import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import {
  IAgentLoopService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentTaskService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentToolPolicyService,
  IEventBus,
  IModelCatalogMutationService,
  ISessionMetadata,
  ISessionDispatchService,
  ISessionManager,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createMemoryKlient } from '@kiki/klient/memory';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { TaskNotificationStepRequest } from '@kiki/agent-core-v2/agent/task/taskService';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { type PromptItemWire, usePromptFixture } from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, createHeldMainAgent } = fixture;

  it('replaces a queued prompt in place while preserving identity, order, and attachments', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const first = {
      id: 'prompt-first',
      userMessageId: 'prompt-first',
      createdAt: '2026-01-01T00:00:01.000Z',
      state: 'pending' as const,
      message: {
        id: 'prompt-first',
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'old text' },
          { type: 'image_url' as const, imageUrl: { url: 'https://example.com/queued.png' } },
        ],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
      launched: Promise.resolve(undefined),
      completion: new Promise<never>(() => undefined),
    };
    const second = {
      id: 'prompt-second',
      userMessageId: 'prompt-second',
      createdAt: '2026-01-01T00:00:02.000Z',
      state: 'pending' as const,
      message: {
        id: 'prompt-second',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'second queued' }],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
    };
    vi.spyOn(prompt, 'list').mockImplementation(() => ({ active: undefined, pending: [first, second] }));
    const replace = vi.spyOn(prompt, 'replace').mockImplementation((promptId, content, replaceAttachments) => {
      expect(promptId).toBe(first.id);
      first.message.content = [
        ...content,
        ...(replaceAttachments ? [] : [{ type: 'image_url', imageUrl: { url: 'https://example.com/queued.png' } }]),
      ] as never;
      return first;
    });
    const abort = vi.spyOn(prompt, 'abort');

    const replaced = await call<PromptItemWire>(
      'POST',
      `/api/sessions/${id}/prompts/${first.id}:replace`,
      { content: [{ type: 'text', text: 'new text' }] },
    );
    expect(replaced.body.code).toBe(0);
    expect(replaced.body.data).toMatchObject({
      prompt_id: first.id,
      user_message_id: first.userMessageId,
      status: 'queued',
      created_at: first.createdAt,
    });
    expect(replaced.body.data.content).toEqual([
      { type: 'text', text: 'new text' },
      { type: 'image', source: { kind: 'url', url: 'https://example.com/queued.png' } },
    ]);
    expect(replace).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.data.queued[0]).toEqual(replaced.body.data);
    const withoutImage = await call<PromptItemWire>(
      'POST',
      `/api/sessions/${id}/prompts/${first.id}:replace`,
      { content: [{ type: 'text', text: 'new text' }], replace_attachments: true },
    );
    expect(withoutImage.body.code).toBe(0);
    expect(withoutImage.body.data.content).toEqual([{ type: 'text', text: 'new text' }]);
    expect(replace).toHaveBeenLastCalledWith(first.id, [{ type: 'text', text: 'new text' }], true);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('rejects replacement of a non-queued prompt without aborting or changing it', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const active = {
      id: 'prompt-active',
      userMessageId: 'prompt-active',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running' as const,
      message: {
        id: 'prompt-active',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'active text' }],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
    };
    vi.spyOn(prompt, 'list').mockImplementation(() => ({ active, pending: [] }));
    const abort = vi.spyOn(prompt, 'abort');

    const replaced = await call<null>(
      'POST',
      `/api/sessions/${id}/prompts/${active.id}:replace`,
      { content: [{ type: 'text', text: 'must not apply' }] },
    );

    expect(replaced.body.code).toBe(40402);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.list().active).toEqual(active);
    expect(prompt.list().active?.message.content).toEqual([
      { type: 'text', text: 'active text' },
    ]);
  });

  it('returns 40402 when aborting a prompt that already settled', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    const promptId = submitted.body.data.prompt_id;
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.abort(promptId)).toBe(true);
    await vi.waitFor(() => expect(prompt.list().active).toBeUndefined(), { timeout: 10000 });

    const aborted = await call<{ aborted: boolean }>(
      'POST',
      `/api/sessions/${id}/prompts/${promptId}:abort`,
    );
    expect(aborted.body.code).toBe(40402);
  });

  it('returns 40402 when aborting an unknown prompt', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const { body } = await call<null>(
      'POST',
      `/api/sessions/${id}/prompts/prompt_does_not_exist:abort`,
    );
    expect(body.code).toBe(40402);
  });

  it('cancels only the active main turn started by a background task notification', async () => {
    const id = await createSession(fixture.home as string);
    const otherId = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    await createMainAgent(otherId);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const loop = main.accessor.get(IAgentLoopService);
    const receipt = loop.enqueue(new TaskNotificationStepRequest({
      role: 'user',
      content: [{ type: 'text', text: 'Background task finished' }],
      toolCalls: [],
      origin: { kind: 'task', taskId: 'test-task', status: 'completed', notificationId: 'test-notice' },
    }));
    const { turn } = await receipt.assigned;
    expect(loop.status().activeTurnId).toBe(turn.id);
    expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    expect(turn.signal.aborted).toBe(false);

    const client = new KikiClient({ baseUrl: fixture.base, token: fixture.server!.localOwnerToken });
    try {
      expect(await client.abortTurn(otherId, turn.id)).toEqual({ aborted: false });
      expect(await client.abortTurn(id, turn.id + 1)).toEqual({ aborted: false });
      expect(turn.signal.aborted).toBe(false);
      expect((await call<null>('POST', `/api/sessions/${id}/turns/not-a-number:abort`)).body.code).toBe(40001);
      expect((await call<null>('POST', '/api/sessions/unknown/turns/1:abort')).body.code).toBe(40401);
      expect(await client.abortTurn(id, turn.id)).toEqual({ aborted: true });
      expect(turn.signal.aborted).toBe(true);
      expect((await turn.result).type).toBe('cancelled');
      expect(await client.abortTurn(id, turn.id)).toEqual({ aborted: false });
    } finally {
      await client.klient.close();
    }
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await call<null>('POST', '/api/sessions/nope/prompts', {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(body.code).toBe(40401);
  });

  it('lists prompts for a persisted session with no live handle (cold resume)', async () => {
    const id = await createSession(fixture.home as string);
    await closeSessionById(fixture.server!.core.accessor, id);
    expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    expect(list.body.data.active).toBeNull();
    expect(list.body.data.queued).toEqual([]);
  });

  it('stops queued and active child tasks through the GUI HTTP facade without crossing prompt ownership', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    const prompt = child.accessor.get(IAgentPromptService);
    const execution = child.accessor.get(IAgentExecutionService);
    child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-http-stop', async (context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      context.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const tasks = lifecycle.get('main')!.accessor.get(IAgentTaskService);
    const ids: string[] = [];
    for (const promptId of ['active-http', 'queued-http']) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: child.id, prompt_id: promptId, content: [{ type: 'text', text: promptId }],
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      const task = tasks.list(true).find((item) => item.kind === 'agent' && item.agentId === child.id && !ids.includes(item.taskId));
      expect(task).toBeDefined();
      ids.push(task!.taskId);
    }
    expect(prompt.list().active?.id).toBe('active-http');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['queued-http']);
    const klient = createHttpKlient({ endpoint: fixture.base, token: fixture.server!.localOwnerToken });
    try {
      await klient.session(id).agent('main').stopTask({ taskId: ids[1]! });
      expect(tasks.getTask(ids[1]!)?.status).toBe('killed');
      expect(prompt.list().pending).toEqual([]);
      expect(prompt.list().active?.id).toBe('active-http');
      expect(tasks.getTask(ids[0]!)?.status).toBe('running');
      await klient.session(id).agent('main').stopTask({ taskId: ids[0]! });
      await execution.settled();
      expect(tasks.getTask(ids[0]!)?.status).toBe('killed');
      expect(prompt.list().active).toBeUndefined();
      expect(execution.status().state).toBe('idle');
      await klient.session(id).agent('main').stopTask({ taskId: ids[0]! });
      expect(tasks.getTask(ids[0]!)?.status).toBe('killed');
    } finally {
      await klient.close();
    }
  });

  it.each([
    ['live-terminal', false],
    ['set-model', false],
    ['second-restored', true],
  ] as const)('registers every prompt run after %s (skills=%s)', async (mode, skills) => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    let child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    const childId = child.id;
    const blockInitial = (handle: typeof child): void => {
      handle.accessor.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.register('block-initial-run', (context) => {
        if (context.promptMessage.content.some((part) => part.type === 'text' && part.text === 'initial run')) context.block = true;
      });
    };
    blockInitial(child);
    const initialSubscription = lifecycle.onDidCreate((handle) => { if (handle.id === childId) blockInitial(handle); });
    if (mode !== 'live-terminal') await lifecycle.remove(childId);
    if (mode === 'set-model') {
      const klient = createMemoryKlient({ scope: fixture.server!.core });
      await klient.session(id).agent(childId).setModel('stub-alt');
      await klient.close();
    } else {
      const initial = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: childId, content: [{ type: 'text', text: 'initial run' }],
      });
      expect(initial.body.code, initial.body.msg).toBe(0);
      await lifecycle.get(childId)!.accessor.get(IAgentExecutionService).settled();
    }
    child = lifecycle.get(childId)!;
    initialSubscription.dispose();
    child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-prompt-runs', async (context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      context.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const tasks = lifecycle.get('main')!.accessor.get(IAgentTaskService);
    const seen = new Set<string>();
    for (let run = 0; run < 2; run++) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: childId, content: [{ type: 'text', text: `managed run ${run}` }],
        skills: skills ? [{ name: 'kiki-ops' }] : undefined,
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      const task = await vi.waitFor(() => {
        const found = tasks.list(true).filter((item) => item.kind === 'agent' && item.agentId === childId);
        expect(found).toHaveLength(1);
        return found[0]!;
      });
      expect(seen.has(task.taskId)).toBe(false);
      seen.add(task.taskId);
      expect(child.accessor.get(IAgentExecutionService).status().state).toBe('running');
      await tasks.stopByUser(task.taskId);
      await vi.waitFor(() => expect(tasks.getTask(task.taskId)?.status).toBe('killed'));
      await child.accessor.get(IAgentExecutionService).settled();
      expect(child.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    }
  });

  it.each([false, true])('admits the parent before submitting a child prompt (skills=%s)', async (skills) => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const parent = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    const child = await lifecycle.create({
      delegator: { kind: 'agent', agentId: parent.id },
      binding: { profile: 'agent', model: 'stub', thinking: 'high' },
    });
    await lifecycle.remove(parent.id);
    const create = lifecycle.create.bind(lifecycle);
    vi.spyOn(lifecycle, 'create').mockImplementation((options) => {
      if (options?.agentId === parent.id) throw new Error('parent restore failed');
      return create(options);
    });
    const enqueue = vi.spyOn(child.accessor.get(IAgentPromptService), 'enqueue');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, content: [{ type: 'text', text: 'must not start' }],
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code).not.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(child.accessor.get(IAgentExecutionService).status().state).toBe('idle');
    expect(child.accessor.get(IAgentPromptService).list().pending).toEqual([]);
  });

  it('does not submit a child when task admission fails', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    vi.spyOn(session.accessor.get(ISessionDispatchService), 'recordRun').mockRejectedValueOnce(new Error('run registration failed'));
    const enqueue = vi.spyOn(child.accessor.get(IAgentPromptService), 'enqueue');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, content: [{ type: 'text', text: 'must not start' }],
    });
    expect(submitted.body.code).not.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    await child.accessor.get(IAgentExecutionService).settled();
    expect(lifecycle.get('main')!.accessor.get(IAgentTaskService).list(true)).toEqual([]);
  });

  it('keeps the later cold prompt task running when the earlier task settles', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    await lifecycle.remove(child.id);
    const parent = lifecycle.get('main')!;
    const runTasks: string[] = [];
    const subscription = parent.accessor.get(IEventBus).subscribe((event) => {
      if (event.type === 'subagent.started' && 'taskId' in event && typeof event.taskId === 'string') {
        runTasks.push(event.taskId);
      }
    });
    let creates = 0;
    const onCreate = lifecycle.onDidCreate((handle) => {
      if (handle.id !== child.id) return;
      creates++;
      handle.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-cold-prompts', async (context) => {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        context.signal.throwIfAborted();
      }, { before: 'context-injector' });
    });
    await call('GET', `/api/sessions/${id}/transcript?agent_id=main&transcript_coverage_version=2`);
    const submitted = await Promise.all(['cold-a', 'cold-b'].map((promptId) =>
      call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: child.id, prompt_id: promptId, content: [{ type: 'text', text: promptId }],
      }),
    ));
    expect(submitted.map((response) => response.body.code)).toEqual([0, 0]);
    expect(creates).toBe(1);
    expect(new Set(runTasks).size).toBe(2);
    const tasks = parent.accessor.get(IAgentTaskService);
    await tasks.stopByUser(runTasks[0]!);
    await vi.waitFor(async () => {
      expect(tasks.getTask(runTasks[0]!)?.status).toBe('killed');
      expect(tasks.getTask(runTasks[1]!)?.status).toBe('running');
      const transcript = await call<{ tasks: { taskId: string; state: string }[] }>('GET', `/api/sessions/${id}/transcript?agent_id=main&transcript_coverage_version=2`);
      expect(transcript.body.data.tasks.find((task) => task.taskId === runTasks[1])).toMatchObject({ state: 'running' });
    });
    await tasks.stopByUser(runTasks[1]!);
    await lifecycle.get(child.id)!.accessor.get(IAgentExecutionService).settled();
    onCreate.dispose();
    await subscription.dispose();
  });

  it('accepts a prompt for a live agent after its previous turn settled', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.fork('main');

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'first side question' }],
      agent_id: child.id,
    });
    expect(first.body.code).toBe(0);
    await child.accessor.get(IAgentExecutionService).settled();
    expect(child.accessor.get(IAgentExecutionService).status().state).toBe('idle');

    const second = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'follow-up side question' }],
      agent_id: child.id,
    });

    expect(second.body.code).toBe(0);
    expect(lifecycle.get(child.id)).toBe(child);
    expect(
      child.accessor.get(IAgentContextMemoryService).get().some(
        (message) => message.role === 'user' && message.content.some(
          (part) => part.type === 'text' && part.text === 'follow-up side question',
        ),
      ),
    ).toBe(true);
  });

  it('restores a disposed agent and starts the submitted prompt as a new turn', async () => {
    const provider = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        id: 'chatcmpl-restored-child',
        choices: [{ index: 0, delta: { content: 'completed before release' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);

      const session = getLiveSessionById(fixture.server!.core.accessor, id);
      if (session === undefined) throw new Error(`session ${id} not found`);
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.fork('main');
      const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'before release' }],
        agent_id: child.id,
        profile: 'agent',
        model: 'stub',
        thinking: 'high',
      });
      expect(first.body.code).toBe(0);
      await child.accessor.get(IAgentExecutionService).settled();
      expect(child.accessor.get(IAgentContextMemoryService).get()).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: 'completed before release' }] }),
      ]));
      await lifecycle.remove(child.id);
      expect(lifecycle.get(child.id)).toBeUndefined();
      const parent = lifecycle.get('main')!;
      const observed: string[] = [];
      const eventSubscription = parent.accessor.get(IEventBus).subscribe((event) => {
        if (
          event.type === 'task.started' ||
          event.type === 'task.terminated' ||
          event.type === 'subagent.spawned' ||
          event.type === 'subagent.started' ||
          event.type === 'subagent.failed'
        ) observed.push(event.type);
      });
      const createSubscription = lifecycle.onDidCreate((handle) => {
        if (handle.id !== child.id) return;
        handle.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register(
          'hold-restored-child-turn',
          async (context) => {
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            context.signal.throwIfAborted();
          },
          { before: 'context-injector' },
        );
      });

      const resumed = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'after release' }],
        agent_id: child.id,
      });

      expect(resumed.body.code, resumed.body.msg).toBe(0);
      const restored = lifecycle.get(child.id);
      expect(restored).toBeDefined();
      expect(restored).not.toBe(child);
      expect(
        restored!.accessor.get(IAgentContextMemoryService).get().some(
          (message) => message.role === 'user' && message.content.some(
            (part) => part.type === 'text' && part.text === 'after release',
          ),
        ),
      ).toBe(true);
      const tasks = parent.accessor.get(IAgentTaskService);
      const task = await vi.waitFor(() => {
        const found = tasks.list(true).find((item) => item.kind === 'agent' && item.agentId === child.id);
        expect(found).toBeDefined();
        return found!;
      });
      await vi.waitFor(() => {
        expect(observed).toEqual(expect.arrayContaining([
          'task.started',
          'subagent.spawned',
          'subagent.started',
        ]));
      });
      await tasks.stopByUser(task.taskId);
      await vi.waitFor(() => {
        expect(tasks.getTask(task.taskId)?.status).toBe('killed');
        expect(observed).toEqual(expect.arrayContaining(['task.terminated', 'subagent.failed']));
      });
      createSubscription.dispose();
      await eventSubscription.dispose();
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }));
    }
  });

  it('releases a finished subagent and cold-loads the same transcript after subagent and session eviction', async () => {
    vi.stubEnv('KIKI_SUBAGENT_RELEASE_GRACE_MS', '1000');
    vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
    const provider = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        id: 'chatcmpl-evicted-child',
        choices: [{ index: 0, delta: { content: 'answer kept on disk' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}

data: [DONE]

`);
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);
      const lifecycle = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.fork('main');
      const released = new Promise<void>((resolve) => {
        const subscription = lifecycle.onDidDispose((agentId) => {
          if (agentId !== child.id) return;
          subscription.dispose();
          resolve();
        });
      });
      const prompt = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'question for the child' }],
        agent_id: child.id,
        profile: 'agent',
        model: 'stub',
        thinking: 'high',
      });
      expect(prompt.body.code).toBe(0);
      await child.accessor.get(IAgentExecutionService).settled();
      const page = async (agentId: string) => {
        const { body } = await call<{ items: unknown[]; has_more: boolean }>(
          'GET', `/api/sessions/${id}/transcript?agent_id=${agentId}&transcript_coverage_version=2`);
        expect(body.code).toBe(0);
        return { items: body.data.items, has_more: body.data.has_more };
      };
      const childBefore = await page(child.id);
      const mainBefore = await page('main');
      expect(JSON.stringify(childBefore.items)).toContain('answer kept on disk');

      await released;
      expect(lifecycle.get(child.id)).toBeUndefined();
      expect(await page(child.id)).toEqual(childBefore);

      const manager = fixture.server!.core.accessor.get(ISessionManager);
      expect(await manager.evictIfIdle!(id, { ignoreIdleTtl: true })).toBe(true);
      expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();
      const lease = await manager.acquire!(id, 'test-reopen');
      try {
        expect(await page('main')).toEqual(mainBefore);
        expect(await page(child.id)).toEqual(childBefore);
      } finally {
        await lease!.dispose();
      }
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) => provider.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }));
    }
  });

  it('reports incomplete persisted binding metadata for a known disposed agent', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    await session.accessor.get(ISessionMetadata).registerAgent('agent-incomplete', {
      type: 'sub',
      parentAgentId: 'main',
      labels: { profileName: 'explore' },
      model: 'stub',
    });

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'resume me' }],
      agent_id: 'agent-incomplete',
    });

    expect(body.code).toBe(40001);
    expect(body.msg).toContain('Persisted binding metadata');
    expect(body.msg).toContain('thinkingEffort');
  });

  it('returns 40401 when agent_id names an unknown agent', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      agent_id: 'agent_does_not_exist',
    });
    expect(body.code).toBe(40401);
  });

  it('rejects an unknown agent profile with 40001', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent_does_not_exist',
      model: 'stub',
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('agent_does_not_exist');
  });

  it('rejects a queued profile switch while the active binding is route-locked', async () => {
    await mkdir(join(fixture.home as string, 'agents'), { recursive: true });
    await writeFile(
      join(fixture.home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the route-lock rejection', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('main agent not found');
    const profile = main.accessor.get(IAgentProfileService);
    await profile.bind({ profile: 'agent', model: 'stub' });
    const binding = profile.data();
    profile.applyBindingSnapshot({
      modelAlias: binding.modelAlias,
      profileName: binding.profileName,
      routeId: 'agent.locked',
      lockedModelAlias: binding.modelAlias,
      thinkingLevel: binding.thinkingLevel,
      systemPrompt: binding.systemPrompt,
      activeToolNames: binding.activeToolNames,
      toolAllowPolicies: binding.toolAllowPolicies,
      disallowedTools: binding.disallowedTools,
      subagents: binding.subagents,
      subagentLeases: binding.subagentLeases,
      spawnPolicy: binding.spawnPolicy,
    });

    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code).toBe(0);
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.list().active?.id).toBe(active.body.data.prompt_id);

    const rejected = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'queued' }],
      profile: 'coder',
    });
    expect(rejected.body.code).toBe(40001);
    expect(rejected.body.msg).toContain('agent.locked');
    expect(profile.data()).toMatchObject({
      profileName: 'agent',
      routeId: 'agent.locked',
      modelAlias: 'stub',
    });
    expect(prompt.list().pending).toEqual([]);
    prompt.abort(active.body.data.prompt_id);
  });

  it('binds a discovered custom agent profile on the first prompt', async () => {
    await mkdir(join(fixture.home as string, 'agents'), { recursive: true });
    await writeFile(
      join(fixture.home as string, 'agents', 'route-reviewer.md'),
      [
        '---',
        'name: route-reviewer',
        'description: reviewer defined by a user-level agent file',
        '---',
        '',
        'You are a route-test reviewer.',
        '',
      ].join('\n'),
      'utf-8',
    );
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'route-reviewer',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    expect(main?.accessor.get(IAgentProfileService).data().profileName).toBe('route-reviewer');

    const again = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      profile: 'route-reviewer',
    });
    expect(again.body.code).toBe(0);
  });

  it('rebinds the main profile, applies pins and overrides, and survives resume', async () => {
    await mkdir(join(fixture.home as string, 'agents'), { recursive: true });
    await writeFile(
      join(fixture.home as string, 'agents', 'pinned-profile.md'),
      [
        '---',
        'name: pinned-profile',
        'description: Uses the pinned model and effort',
        'model_alias: stub-alt',
        'thinking_effort: low',
        '---',
        '',
        'Pinned profile.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(fixture.home as string, 'agents', 'override-profile.md'),
      [
        '---',
        'name: override-profile',
        'description: Allows explicit request overrides',
        'model_alias: stub-alt',
        'thinking_effort: low',
        '---',
        '',
        'Override profile.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await (fixture.server as RunningServer).close();
    fixture.server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: fixture.home as string,
      logLevel: 'silent',
    });
    fixture.base = `http://127.0.0.1:${fixture.server.port}`;

    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(first.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('main agent not found');
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.abort(first.body.data.prompt_id)).toBe(true);
    await vi.waitFor(() => expect(prompt.list().active).toBeUndefined(), { timeout: 10_000 });

    const rebound = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'use the pinned profile' }],
      profile: 'pinned-profile',
    });
    expect(rebound.body.code, JSON.stringify(rebound.body)).toBe(0);

    const profile = main.accessor.get(IAgentProfileService);
    expect(profile?.data()).toMatchObject({
      profileName: 'pinned-profile',
      modelAlias: 'stub-alt',
      thinkingLevel: 'low',
    });
    expect((await session.accessor.get(ISessionMetadata).read()).agents?.['main']).toMatchObject({
      displayName: 'pinned-profile',
      model: 'stub-alt',
      thinkingEffort: 'low',
    });
    const currentSession = await call<{ agent_config: { model: string; profile?: string } }>(
      'GET',
      `/api/sessions/${id}`,
    );
    expect(currentSession.body.data.agent_config).toEqual({
      model: 'stub-alt',
      profile: 'pinned-profile',
    });

    await closeSessionById(fixture.server!.core.accessor, id);
    const resumed = await resumeSessionById(fixture.server!.core.accessor, id);
    const resumedProfile = resumed?.accessor
      .get(IAgentLifecycleService)
      .get('main')
      ?.accessor.get(IAgentProfileService);
    expect(resumedProfile?.data()).toMatchObject({
      profileName: 'pinned-profile',
      modelAlias: 'stub-alt',
      thinkingLevel: 'low',
    });

    const overridden = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'override the new pin' }],
      profile: 'override-profile',
      model: 'stub',
      thinking: 'high',
    });
    expect(overridden.body.code).toBe(0);
    const overriddenProfile = getLiveSessionById(fixture.server!.core.accessor, id)?.accessor
      .get(IAgentLifecycleService)
      .get('main')
      ?.accessor.get(IAgentProfileService);
    expect(overriddenProfile?.data()).toMatchObject({
      profileName: 'override-profile',
      modelAlias: 'stub',
      thinkingLevel: 'high',
    });
  });

  it('applies a requested thinking effort together with the profile bind', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = main?.accessor.get(IAgentProfileService);
    expect(profile?.data().profileName).toBe('agent');
    expect(profile?.data().thinkingLevel).toBe('high');
  });

  it('applies disabled_tools on the first prompt and replaces them on later prompts', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);

    const replaced = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      disabled_tools: ['Write'],
    });
    expect(replaced.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Bash')).toBe(true);
    expect(toolPolicy?.isToolActive('Write')).toBe(false);

    const cleared = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'once more' }],
      disabled_tools: [],
    });
    expect(cleared.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Write')).toBe(true);
  });

  it('shares disabled_tools with agents created after the request', async () => {
    await mkdir(join(fixture.home as string, 'agents'), { recursive: true });
    await writeFile(
      join(fixture.home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the tool-policy inheritance', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).create({
      binding: {
        profile: 'coder',
        model: 'stub',
      },
    });

    const childToolPolicy = child.accessor.get(IAgentToolPolicyService);
    expect(childToolPolicy.isToolActive('Bash')).toBe(false);
    expect(childToolPolicy.isToolActive('Read')).toBe(true);
  });

  it('rejects disabled_tools before the agent profile is bound', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      disabled_tools: ['Bash'],
    });
    expect(body.code).toBe(40001);
  });

  it('persists disabled_tools across a cold resume', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    await closeSessionById(fixture.server!.core.accessor, id);
    expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();

    const again = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
    });
    expect(again.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);
  });
});

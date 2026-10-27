import { solidPng } from './helpers/png';
import {
  IAgentTitlePromptSource,
  IAgentLoopService,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IEventDispatcher,
  PromptEnqueued,
  PromptAccepted,
  promptRetryFor,
  IWireService,
  IModelCatalogMutationService,
  ISessionMetadata,
  ISessionDispatchService,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { IAgentLLMRequesterService } from '@kiki/agent-core-v2/agent/llmRequester/llmRequester';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/start';
import { projectPromptSnapshot, watchPromptSettlements } from '../src/routes/prompts';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';
import { type PromptItemWire, promiseGate, usePromptFixture } from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, createHeldMainAgent, createHeldChild, uploadFile } = fixture;

  it('submits a prompt and lists it as active', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(submitted.body.data.status).toBe('running');
    expect(submitted.body.data.user_message_id).toBe(submitted.body.data.prompt_id);

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    if (list.body.data.active !== null) {
      expect(list.body.data.active.prompt_id).toBe(submitted.body.data.prompt_id);
    }
    expect(Array.isArray(list.body.data.queued)).toBe(true);
  });

  it('projects a replay-restored recovery hold through the prompt list', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    const dispatcher = main.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'recovered-prompt',
      userMessageId: 'recovered-prompt',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'recover me' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 0,
      queueIndex: 0,
    }));
    await dispatcher.hooks.onDidRestore.run({});

    const list = await call<{
      active: PromptItemWire | null;
      queued: PromptItemWire[];
      recovery_hold?: { reason: 'recovery'; count: number };
    }>('GET', `/api/sessions/${id}/prompts`);

    expect(list.body.code).toBe(0);
    expect(list.body.data.queued.map((prompt) => prompt.prompt_id)).toEqual(['recovered-prompt']);
    expect(list.body.data.recovery_hold).toEqual({ reason: 'recovery', count: 1 });
  });

  it.each([false, true])('sends a selected held prompt after cold resume without releasing the rest (bulk=%s)', async (bulk) => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const dispatcher = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IEventDispatcher);
    for (const [queueIndex, promptId] of ['held-first', 'send-now'].entries()) {
      await dispatcher.dispatch(new PromptEnqueued({
        schemaVersion: 1,
        promptId,
        userMessageId: promptId,
        createdAt: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: promptId }], toolCalls: [], origin: { kind: 'user' } },
        alreadyMaterialized: false,
        appendTiming: 'agent_idle',
        revision: 0,
        queueIndex,
      }));
    }
    await closeSessionById(fixture.server!.core.accessor, id);
    await resumeSessionById(fixture.server!.core.accessor, id);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 2 });
    expect(main.accessor.get(IAgentLoopService).status().activeTurnId).toBeUndefined();

    const sent = bulk
      ? await call('POST', `/api/sessions/${id}/prompts:steer`, { prompt_ids: ['send-now'] })
      : await call('POST', `/api/sessions/${id}/prompts/send-now:steer`, {});
    expect(sent.body.code, sent.body.msg).toBe(0);
    await vi.waitFor(() => expect(prompt.list().active?.id).toBe('send-now'));
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['held-first']);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 1 });
    prompt.abort('send-now');
    await main.accessor.get(IAgentLoopService).settled();
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 1 });
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['held-first']);
  });

  it('applies an optional plan_gate override before prompt execution', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'plan with approval' }],
      plan_gate: 'gated',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(main!.accessor.get(IAgentPlanService).planGate).toBe('gated');
  });

  it('defers a busy session’s submitted permission and plan gate until that prompt starts', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const mode = main.accessor.get(IAgentPermissionModeService);
    const plan = main.accessor.get(IAgentPlanService);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'current turn' }], permission_mode: 'manual', plan_gate: 'free',
    });
    expect(active.body.data.status).toBe('running');
    const cancelled = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'cancelled' }], permission_mode: 'yolo', plan_gate: 'gated',
    });
    expect(cancelled.body.data.status).toBe('queued');
    expect(mode.mode).toBe('manual');
    expect(plan.planGate).toBe('free');
    prompt.abort(cancelled.body.data.prompt_id);
    expect(mode.mode).toBe('manual');
    expect(plan.planGate).toBe('free');
    const later = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'next turn' }], permission_mode: 'yolo', plan_gate: 'gated',
    });
    expect(later.body.data.status).toBe('queued');
    expect(mode.mode).toBe('manual');
    expect(plan.planGate).toBe('free');
    prompt.abort(active.body.data.prompt_id);
    await vi.waitFor(() => expect(prompt.list().active?.id).toBe(later.body.data.prompt_id));
    expect(mode.mode).toBe('yolo');
    expect(plan.planGate).toBe('gated');
    prompt.abort(later.body.data.prompt_id);
  });

  it('moves a queued prompt to an exact final index', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const queued: PromptItemWire[] = [];
    for (const text of ['one', 'two', 'three']) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      queued.push(submitted.body.data);
    }

    const moved = await call<{
      moved: true;
      prompt_id: string;
      target_index: number;
      queued_prompt_ids: string[];
    }>(
      'POST',
      `/api/sessions/${id}/prompts/${queued[2]!.prompt_id}:move`,
      { target_index: 0 },
    );

    expect(moved.body.code, moved.body.msg).toBe(0);
    expect(moved.body.data).toEqual({
      moved: true,
      prompt_id: queued[2]!.prompt_id,
      target_index: 0,
      queued_prompt_ids: [queued[2]!.prompt_id, queued[0]!.prompt_id, queued[1]!.prompt_id],
    });
    const listed = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(listed.body.data.queued.map((prompt) => prompt.prompt_id)).toEqual(
      moved.body.data.queued_prompt_ids,
    );
    await getLiveSessionById(fixture.server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain(new Error('test cleanup'));
  });

  it('accepts a queued model and thinking change without mutating the active request before its safe boundary', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);

    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
      model: 'stub',
      thinking: 'low',
    });
    expect(active.body.code).toBe(0);
    expect(active.body.data.status).toBe('running');

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const profile = main!.accessor.get(IAgentProfileService);
    const activeBinding = profile.data();
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'append later' }],
      model: 'stub-alt',
      thinking: 'high',
    });
    expect(queued.body.code).toBe(0);
    expect(queued.body.data.status).toBe('queued');
    expect(profile.data()).toEqual(activeBinding);

    const steered = await call('POST', `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:steer`);
    expect(steered.body.code).toBe(0);
    expect(profile.data()).toEqual(activeBinding);
    expect(prompt.list().pending.map((item) => item.id)).toContain(queued.body.data.prompt_id);
    prompt.abort(queued.body.data.prompt_id);
    prompt.abort(active.body.data.prompt_id);
  });

  it('submits a bundled skill prompt through the skills field', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'kiki-ops' }, { name: 'kiki-profile' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(['running', 'queued']).toContain(submitted.body.data.status);
    expect(submitted.body.data.content).toEqual([{ type: 'text', text: 'Review this change.' }]);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    const bundled = history.find((message) => message.origin?.kind === 'user');
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'kiki-ops' }, { skillName: 'kiki-profile' }],
    });
    const texts = bundled?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[texts.length - 1]).toBe('Review this change.');

    const projected = projectPromptSnapshot({
      id: 'msg_1',
      userMessageId: 'msg_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'rendered skill block' },
          { type: 'text', text: 'Review this change.' },
        ],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'a1', skillName: 'kiki-ops' }],
        },
      },
    });
    expect(projected.content).toEqual([{ type: 'text', text: 'Review this change.' }]);
    expect(projected.append_timing).toBe('agent_idle');
    expect(projected.revision).toBe(0);
    const plain = projectPromptSnapshot({
      id: 'msg_2',
      userMessageId: 'msg_2',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'plain question' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    expect(plain.content).toEqual([{ type: 'text', text: 'plain question' }]);
    expect(plain.append_timing).toBe('agent_idle');
    expect(plain.revision).toBe(0);
  });

  it('projects original mixed sources and their bundled skills without inventing user provenance', () => {
    const origin = { kind: 'merged' as const, origins: [
      { kind: 'user' as const, skillActivations: [{ activationId: 'a-source', skillName: 'review' }] },
      { kind: 'system_trigger' as const, name: 'thread_create' },
    ] };
    const projected = projectPromptSnapshot({
      id: 'p-source', userMessageId: 'm-source', createdAt: '2026-01-01T00:00:00.000Z', state: 'pending',
      message: { role: 'user', toolCalls: [], origin, content: [{ type: 'text', text: 'bundled skill block' }, { type: 'text', text: 'mixed task' }] },
    });
    expect(projected.origin).toEqual(origin);
    expect(projected.content).toEqual([{ type: 'text', text: 'mixed task' }]);
  });

  it('projects the effective scheduling revision captured on the prompt snapshot', () => {
    const scheduled = projectPromptSnapshot({
      id: 'msg_3',
      userMessageId: 'msg_3',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'wait for tasks' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      appendTiming: 'tasks_done',
      revision: 5,
    } as unknown as Parameters<typeof projectPromptSnapshot>[0]);
    expect(scheduled.append_timing).toBe('tasks_done');
    expect(scheduled.revision).toBe(5);
  });

  it('rejects an unknown append_timing on the timing action with 40001', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'queued' }],
    });
    expect(queued.body.code, queued.body.msg).toBe(0);

    const rejected = await call<unknown>(
      'POST',
      `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:timing`,
      { append_timing: 'later' },
    );
    expect(rejected.body.code).toBe(40001);
    await getLiveSessionById(fixture.server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain(new Error('test cleanup'));
  });

  it('honors a client-chosen prompt_id on submit', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      prompt_id: 'submission-1',
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toBe('submission-1');
    expect(submitted.body.data.user_message_id).toBe('submission-1');
  });

  it('updates session metadata for a bundled prompt routed to a non-main agent', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'bundled side question' }],
      agent_id: child.id,
      skills: [{ name: 'kiki-ops' }],
    });
    expect(submitted.body.code).toBe(0);

    expect((await session.accessor.get(ISessionMetadata).read()).lastPrompt).toBe(
      'bundled side question',
    );
  });

  it('rejects a reused prompt_id live and after cold resume without changing metadata', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'first prompt' }],
      prompt_id: 'submission-1',
    });
    expect(first.body.code).toBe(0);

    const duplicate = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not become metadata' }],
      prompt_id: 'submission-1',
    });
    expect(duplicate.body.code).toBe(40938);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    expect((await session!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');

    await closeSessionById(fixture.server!.core.accessor, id);
    expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();

    const afterResume = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not survive a cold resume' }],
      prompt_id: 'submission-1',
    });
    expect(afterResume.body.code).toBe(40938);
    const resumed = getLiveSessionById(fixture.server!.core.accessor, id);
    expect((await resumed!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');
  });

  it('sends complete long text through compact HTTP receipts and point-reads child executor without session echoes', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const metadata = session.accessor.get(ISessionMetadata);
    const longText = '文'.repeat(1500000);
    await metadata.update({ lastPrompt: longText });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const responses: Array<{ path: string; bytes: number; data: Record<string, unknown> }> = [];
    const nativeFetch = globalThis.fetch;
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!), transport: {
      eventsUrl: new URL('/api/ws', fixture.base).href.replace(/^http/, 'ws'),
      fetch: async (input, init) => {
        const response = await nativeFetch(input, init);
        const text = await response.clone().text();
        const envelope = JSON.parse(text);
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        responses.push({ path: new URL(url).pathname, bytes: Buffer.byteLength(text), data: envelope.data });
        return response;
      },
    } });
    try {
      expect(await client.isNativeAgent(id, child.id)).toBe(true);
      await expect(client.sendAgentMessage(id, child.id, longText, undefined, 'long-child-receipt')).resolves.toBeNull();
      await expect(client.sendAgentMessage(id, child.id, longText, undefined, 'long-child-receipt')).resolves.toBeNull();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(prompt.list().active?.message.content).toEqual([{ type: 'text', text: longText }]);
      const submissions = responses.filter((response) => response.path.endsWith('/prompts'));
      expect(submissions).toHaveLength(2);
      for (const response of submissions) {
        expect(response.bytes).toBeLessThan(2048);
        expect(response.data).not.toHaveProperty('content');
        expect(response.data).toMatchObject({ prompt_id: 'long-child-receipt' });
      }
      await expect(client.sendAgentMessage(id, child.id, 'changed', undefined, 'long-child-receipt')).rejects.toThrow();
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally { await client.klient.close(); }
  });

  it('reconstructs an accepted compact receipt by source slots after image captions and file notices expand the content', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const image = await uploadFile(solidPng(3600, 1800), 'image/png', 'big.png');
    const file = await uploadFile(Buffer.from('file contents'), 'text/plain', 'notes.txt');
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const receipts: Array<Record<string, unknown>> = [];
    const nativeFetch = globalThis.fetch;
    const client = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!), fetch: async (input, init) => {
      const response = await nativeFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname.endsWith('/prompts')) receipts.push((await response.clone().json()).data);
      return response;
    } });
    try {
      const payload: import('@kiki/protocol').PromptSubmission = {
        agent_id: child.id, prompt_id: 'mixed-media-receipt', content: [
          { type: 'text', text: 'before' },
          { type: 'image', source: { kind: 'file', file_id: image.id } },
          { type: 'file', file_id: file.id, name: 'notes.txt', media_type: 'text/plain', size: file.size },
          { type: 'text', text: 'after' },
        ],
      };
      const accepted = await client.session(id).commands.submit(payload);
      expect(accepted.prompt_id).toBe('mixed-media-receipt');
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).not.toHaveProperty('content');
      expect(receipts[0]?.['resolved_parts']).toMatchObject([{ index: 1 }, { index: 2 }]);
      expect(accepted.content).toHaveLength(5);
      expect(accepted.content[0]).toEqual({ type: 'text', text: 'before' });
      expect(accepted.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('Image compressed') });
      expect(accepted.content[2]).toMatchObject({ type: 'image', source: { kind: 'session_media' } });
      expect(accepted.content[3]).toMatchObject({ type: 'text', text: expect.stringContaining('Attached file "notes.txt"') });
      expect(accepted.content[4]).toEqual({ type: 'text', text: 'after' });
      expect(await client.session(id).commands.submit(payload)).toEqual(accepted);
      expect(enqueue).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(prompt.list().active?.id).toBe(accepted.prompt_id));
      prompt.abort(accepted.prompt_id);
      await child.accessor.get(IAgentLoopService).settled();
      await closeSessionById(fixture.server!.core.accessor, id);
      expect(await client.session(id).commands.submit(payload)).toEqual(accepted);
    } finally { await client.close(); }
  });

  it('replays one accepted native child prompt after losing the HTTP response and rejects a changed payload', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = {
      agent_id: child.id, prompt_id: 'native-child-retry', content: [{ type: 'text', text: 'one child run' }],
    };
    const first = await fetch(`${fixture.base}/api/sessions/${id}/prompts`, {
      method: 'POST', headers: authHeaders(fixture.server!, { 'content-type': 'application/json' }), body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    await first.body?.cancel();
    const retry = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code, retry.body.msg).toBe(0);
    expect(retry.body.data).toMatchObject({ prompt_id: payload.prompt_id, content: payload.content });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const changed = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      ...payload, content: [{ type: 'text', text: 'different child run' }],
    });
    expect(changed.body.code).toBe(40938);
    expect(enqueue).toHaveBeenCalledTimes(1);
    prompt.abort(payload.prompt_id);
  });

  it('sends a queued native child prompt now through the agent-scoped steer route', async () => {
    const id = await createSession(fixture.home as string);
    const boundary = promiseGate<void>();
    const child = await createHeldChild(id, boundary.promise);
    vi.spyOn(child.accessor.get(IAgentLLMRequesterService), 'start').mockReturnValue({
      trace: { traceId: 'fixture-child-boundary' },
      result: Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        providerFinishReason: 'completed',
      }),
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, content: [{ type: 'text', text: 'child is working' }],
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, prompt_id: 'child-send-now', content: [{ type: 'text', text: 'steer the child' }],
    });
    expect(queued.body.data.status).toBe('queued');
    const moved = await call('POST', `/api/sessions/${id}/prompts/child-send-now:move?agent_id=${child.id}`, { to: 0 });
    expect(moved.body.code).toBe(40001);
    const unscoped = await call('POST', `/api/sessions/${id}/prompts/child-send-now:steer`);
    expect(unscoped.body.code).not.toBe(0);
    expect(prompt.list().pending).toHaveLength(1);
    const steerRequested = vi.spyOn(prompt, 'steer');
    const steering = call('POST', `/api/sessions/${id}/prompts/child-send-now:steer?agent_id=${child.id}`);
    await vi.waitFor(() => expect(steerRequested).toHaveBeenCalled());
    boundary.resolve();
    const steered = await steering;
    expect(steered.body.code, steered.body.msg).toBe(0);
    expect(prompt.list().pending).toHaveLength(0);
    prompt.abort(active.body.data.prompt_id);
  });

  it('scopes native child prompt retry keys to their target within a session', async () => {
    const id = await createSession(fixture.home as string);
    const firstChild = await createHeldChild(id);
    const lifecycle = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService);
    const otherChild = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    otherChild.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-other-child-turn', async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const key = 'shared-native-child-key';
    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: firstChild.id, prompt_id: key, content: [{ type: 'text', text: 'first child' }],
    });
    const second = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: otherChild.id, prompt_id: key, content: [{ type: 'text', text: 'second child' }],
    });
    expect(first.body.code, first.body.msg).toBe(0);
    expect(second.body.code, second.body.msg).toBe(0);
    expect(firstChild.accessor.get(IAgentPromptService).list().active?.message.content).toEqual([{ type: 'text', text: 'first child' }]);
    expect(second.body.data.prompt_id).toBe(key);
    firstChild.accessor.get(IAgentPromptService).abort(key);
    otherChild.accessor.get(IAgentPromptService).abort(key);
  });

  it('reuses a native child key after rejection before prompt acceptance', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const payload = { agent_id: child.id, prompt_id: 'native-child-rejected', content: [{ type: 'text', text: 'try again' }] };
    const rejected = await call<null>('POST', `/api/sessions/${id}/prompts`, { ...payload, model: 'not-configured' });
    expect(rejected.body.code).not.toBe(0);
    const accepted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    child.accessor.get(IAgentPromptService).abort(payload.prompt_id);
  });

  it('fails closed when a legacy child admission has no replayable retry receipt', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const payload = { agent_id: child.id, prompt_id: 'native-child-uncommitted', content: [{ type: 'text', text: 'ambiguous' }] };
    await child.accessor.get(IEventDispatcher).dispatch(new PromptAccepted({ promptId: payload.prompt_id }));
    await child.accessor.get(IWireService).flush();
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const first = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(first.body.code).toBe(40938);
    expect(first.body.msg).toContain('accepted without a replayable receipt');
    const retry = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code).toBe(40938);
    expect(retry.body.msg).toContain('accepted without a replayable receipt');
    expect(enqueue).not.toHaveBeenCalled();
    expect(child.accessor.get(IAgentLoopService).status().activeTurnId).toBeUndefined();
  });

  it('does not replay an unflushed child receipt as if it were durably accepted', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const wire = child.accessor.get(IWireService);
    const flush = wire.flush.bind(wire);
    let failFlush = false;
    const flushSpy = vi.spyOn(wire, 'flush').mockImplementation(async () => {
      if (failFlush) throw new Error('storage flush failed');
      return flush();
    });
    const loop = child.accessor.get(IAgentLoopService);
    const enqueueTurn = loop.enqueue.bind(loop);
    const turnResults: Promise<unknown>[] = [];
    const turnSpy = vi.spyOn(loop, 'enqueue').mockImplementation((...args) => {
      const receipt = enqueueTurn(...args);
      failFlush = true;
      turnResults.push(receipt.assigned.then(({ turn }) => turn.result).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ));
      return receipt;
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = { agent_id: child.id, prompt_id: 'native-child-unflushed', content: [{ type: 'text', text: 'needs durability' }] };
    try {
      const first = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
      expect(first.body.code).not.toBe(0);
      await vi.waitFor(() => { expect(turnSpy).toHaveBeenCalledTimes(1); });
      const retry = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
      expect(retry.body.code).not.toBe(0);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(turnSpy).toHaveBeenCalledTimes(1);
      expect(await Promise.all(turnResults)).toEqual([{
        error: expect.objectContaining({
          details: expect.objectContaining({ persistenceOutcome: 'failed' }),
          cause: expect.objectContaining({ message: 'storage flush failed' }),
        }),
      }]);
    } finally {
      flushSpy.mockRestore();
      enqueue.mockRestore();
      turnSpy.mockRestore();
      const queue = prompt.list();
      if (queue.active?.id === payload.prompt_id || queue.launching?.id === payload.prompt_id || queue.pending.some(item => item.id === payload.prompt_id)) {
        prompt.abort(payload.prompt_id);
      }
      expect(await loop.recoverPersistence()).toBe(true);
      await loop.settled();
      await Promise.all(turnResults);
    }
  });

  it('never admits two simultaneous native child submissions of one key', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const dispatch = session.accessor.get(ISessionDispatchService);
    const recordRun = dispatch.recordRun.bind(dispatch);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const record = vi.spyOn(dispatch, 'recordRun').mockImplementationOnce(async (...args) => {
      await hold;
      return recordRun(...args);
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const run = vi.spyOn(promptRetryFor(prompt), 'run');
    const payload = { agent_id: child.id, prompt_id: 'native-child-flight', content: [{ type: 'text', text: 'only one' }] };
    const first = call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    let concurrent: typeof first | undefined;
    try {
      await vi.waitFor(() => { expect(record).toHaveBeenCalledOnce(); });
      concurrent = call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
      await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(2); });
      const changed = await call<null>('POST', `/api/sessions/${id}/prompts`, {
        ...payload, content: [{ type: 'text', text: 'changed while in flight' }],
      });
      expect(changed.body.code).toBe(40938);
      expect(record).toHaveBeenCalledOnce();
      release();
      const [accepted, joined] = await Promise.all([first, concurrent]);
      expect(accepted.body.code, accepted.body.msg).toBe(0);
      expect(joined.body.code, joined.body.msg).toBe(0);
      expect(joined.body.data).toEqual(accepted.body.data);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const replay = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
      expect(replay.body.code).toBe(0);
      expect(replay.body.data).toEqual(accepted.body.data);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([first, ...(concurrent === undefined ? [] : [concurrent])]);
      prompt.abort(payload.prompt_id);
    }
  });

  it('replays an accepted native child receipt after server restart without re-enqueueing', async () => {
    const id = await createSession(fixture.home as string);
    const child = await createHeldChild(id);
    const payload = { agent_id: child.id, prompt_id: 'native-child-restart', content: [{ type: 'text', text: 'restart once' }] };
    const accepted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    child.accessor.get(IAgentPromptService).abort(payload.prompt_id);
    await fixture.server!.close();
    fixture.server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: fixture.home!, logLevel: 'silent' });
    fixture.base = `http://127.0.0.1:${fixture.server.port}`;
    const resumed = await resumeSessionById(fixture.server.core.accessor, id);
    const lifecycle = resumed!.accessor.get(IAgentLifecycleService);
    const restored = await lifecycle.create({ agentId: child.id, restoreBinding: {
      profileName: 'agent', modelAlias: 'stub', thinkingEffort: 'high', executorId: 'native', executorProtocol: 'native',
    } });
    restored.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-incorrect-replay', async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const enqueue = vi.spyOn(restored.accessor.get(IAgentPromptService), 'enqueue');
    const retry = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code, retry.body.msg).toBe(0);
    expect(retry.body.data).toEqual(accepted.body.data);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a bundled submission with an unknown skill and records nothing', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill before any control override binds', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      plan_gate: 'gated',
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(agent!.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
    expect(agent!.accessor.get(IAgentPlanService).planGate).toBe('free');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill without materializing the main agent', async () => {
    const id = await createSession(fixture.home as string, false);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('accepts a bundled prompt_id and replays the matching receipt without another model request', async () => {
    await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
    const id = await createSession(fixture.home as string, false);
    await createMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
    await main.accessor.get(IAgentLoopService).settled();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-bundled-retry', async ({ signal }) => {
      await gate;
      signal.throwIfAborted();
    }, { before: 'context-injector' });
    const requester = vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'start').mockImplementation(() => ({
      trace: { traceId: 'bundled-prompt-retry' },
      result: Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text: 'bundled completion' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        providerFinishReason: 'completed',
      }),
    }));
    const payload = {
      content: [{ type: 'text', text: 'Review this change.' }],
      prompt_id: 'submission-1',
      skills: [{ name: 'kiki-ops' }],
    };

    const submittedPromise = call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    await vi.waitFor(() => {
      const list = main.accessor.get(IAgentPromptService).list();
      expect(list.pending.length + (list.active === undefined ? 0 : 1)).toBeGreaterThan(0);
    });
    release();
    const submitted = await submittedPromise;
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data).toMatchObject({ prompt_id: payload.prompt_id, content: payload.content });
    expect(submitted.body.data.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'kiki-ops' }],
    });
    await vi.waitFor(() => expect(requester).toHaveBeenCalledTimes(1));
    await main.accessor.get(IAgentLoopService).settled();

    const retry = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code, retry.body.msg).toBe(0);
    expect(retry.body.data).toEqual(submitted.body.data);
    expect(requester).toHaveBeenCalledTimes(1);

    const changed = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      ...payload,
      content: [{ type: 'text', text: 'Changed bundled content.' }],
    });
    expect(changed.body.code).toBe(40938);
    expect(requester).toHaveBeenCalledTimes(1);
    await hold.dispose();
    requester.mockRestore();
  });

  it('cleans bundled staging through the settlement tracker', async () => {
    const handlers: Array<(event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void> = [];
    const events = {
      subscribe(
        handler: (event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void,
      ) {
        handlers.push(handler);
        return { dispose: vi.fn() };
      },
    };

    const discard = vi.fn();
    const tracker = watchPromptSettlements(events as never);
    tracker.settle('msg_1', discard);
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_other' });
    handlers[0]!({ type: 'turn.started' });
    expect(discard).not.toHaveBeenCalled();
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_1' });
    await tracker.dispose();
    expect(discard).toHaveBeenCalledTimes(1);

    const blockedDiscard = vi.fn();
    const blockedTracker = watchPromptSettlements(events as never);
    handlers[1]!({ type: 'prompt.completed', promptId: 'msg_blocked' });
    blockedTracker.settle('msg_blocked', blockedDiscard);
    await blockedTracker.dispose();
    expect(blockedDiscard).toHaveBeenCalledTimes(1);

    const steered = vi.fn();
    const steeredTracker = watchPromptSettlements(events as never);
    steeredTracker.settle('msg_3', steered);
    handlers[2]!({ type: 'prompt.steered', promptIds: ['msg_3'], activePromptId: 'msg_parent' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_other' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_parent' });
    await steeredTracker.dispose();
    expect(steered).toHaveBeenCalledTimes(1);

    const aborted = vi.fn();
    const abortedTracker = watchPromptSettlements(events as never);
    abortedTracker.settle('msg_4', aborted);
    handlers[3]!({ type: 'prompt.aborted', promptId: 'msg_4' });
    await abortedTracker.dispose();
    expect(aborted).toHaveBeenCalledTimes(1);

    const rejected = vi.fn();
    const rejectedTracker = watchPromptSettlements(events as never);
    rejectedTracker.settle('msg_5', rejected);
    await rejectedTracker.dispose();
    handlers[4]!({ type: 'prompt.completed', promptId: 'msg_5' });
    expect(rejected).not.toHaveBeenCalled();
  });

  it('makes the first three REST prompts available to title generation', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);

    const prompts = ['先搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];
    for (const text of prompts) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code).toBe(0);
    }

    const session = getLiveSessionById(fixture.server!.core.accessor, id);
    const agent = session?.accessor.get(IAgentLifecycleService).get('main');
    const source = agent?.accessor.get(IAgentTitlePromptSource);
    expect(source).toBeDefined();
    await expect(source!.firstUserPrompts(3)).resolves.toEqual(prompts);
  });
});

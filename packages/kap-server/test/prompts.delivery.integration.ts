import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { solidPng } from './helpers/png';
import {
  IAgentGoalService,
  IAgentLoopService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentExecutorRegistry,
  type AgentExecutorSession,
  type ResolvedAgentExecutor,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IAgentPromptService,
  normalizeAgentProfile,
  IEventBus,
  PromptAborted,
  PromptStarted,
  promptRetryFor,
  IAtomicDocumentStore,
  IWireService,
  IFileService,
  IModelCatalogMutationService,
  ISessionContext,
  ISessionManager,
  closeSessionById,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { SessionController } from '../../session-core/src/session/sessionController';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { timeRestorePhase } from '@kiki/agent-core-v2/session/agentLifecycle/restoreTiming';
import { agentTranscriptToBlocks } from '../../session-core/src/session/transcript';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/start';
import { PromptIngress } from '../src/services/promptIngress';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';
import { promiseGate, holdExternalSession, usePromptFixture } from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, createHeldMainAgent } = fixture;

  it('a dispatched native child consumes Send now once at its next safe step while its ordinary queue stays parked', async () => {
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let firstResponseClosed = false;
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = () => response.end(`data: ${JSON.stringify({ id: 'child-response',
          choices: [{ index: 0, delta: { content: 'Received.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`);
        if (requests.length !== 1) { finish(); return; }
        response.on('close', () => { firstResponseClosed = true; });
        response.write(`data: ${JSON.stringify({ id: 'child-stream', choices: [{ index: 0, delta: { content: 'Starting.' }, finish_reason: null }] })}\n\n`);
        entered.resolve();
        void release.promise.then(finish);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let controller: SessionController | undefined;
    let child: Awaited<ReturnType<IAgentLifecycleService['create']>> | undefined;
    try {
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home!);
      await createMainAgent(id);
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      child = await session.accessor.get(IAgentLifecycleService).create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
      const prompt = child.accessor.get(IAgentPromptService);
      const loop = child.accessor.get(IAgentLoopService);
      const run = await child.accessor.get(IAgentExecutionService).run({ kind: 'prompt', prompt: 'Start the child turn.' }, { signal: new AbortController().signal });
      await entered.promise;
      const turnId = loop.status().activeTurnId;
      const steer = prompt.steer.bind(prompt);
      const steering = vi.spyOn(prompt, 'steer').mockImplementation(async ids => {
        const handles = await steer(ids);
        await run.completion;
        await loop.settled();
        expect(handles.map(handle => handle.state)).toEqual(['completed']);
        return handles;
      });
      await client.sendAgentMessage(id, child.id, 'Ordinary queued child note.', undefined, 'child-ordinary');
      expect(prompt.list().pending.map(item => item.id)).toEqual(['child-ordinary']);
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      controller.setFocusedAgent(child.id);
      controller.setEphemeralHint(false);
      await controller.open();
      const text = 'Immediate child note once.';
      const sent = await controller.sendPromptNow({ agentId: child.id, promptId: 'child-immediate', text });
      expect(sent.outcome).toBe('restoring');
      await vi.waitFor(() => expect(prompt.list().pending.map(item => item.id)).toEqual(['child-ordinary', sent.promptId]));
      expect(loop.status().activeTurnId).toBe(turnId);
      expect(firstResponseClosed).toBe(false);
      expect(child.accessor.get(IAgentContextMemoryService).get().some(message => message.id === sent.promptId)).toBe(false);
      prompt.abort('child-ordinary');
      await vi.waitFor(() => expect(steering).toHaveBeenCalledWith([sent.promptId]));
      release.resolve();
      await vi.waitFor(async () => expect(await client.sessions.getDurableIngress!(id, sent.promptId, child!.id)).toMatchObject({ admission: 'admitted', delivery_state: 'steered' }));
      const retry = await client.submitPrompt(id, { admission: 'durable', delivery_mode: 'steer', agent_id: child.id, prompt_id: sent.promptId, content: [{ type: 'text', text }] });
      expect(retry.delivery_state).toBe('steered');
      await run.completion;
      await loop.settled();
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]!.messages)).not.toContain(text);
      expect(requests[1]!.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(text))).toHaveLength(1);
      expect(child.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === sent.promptId)).toHaveLength(1);
      expect(session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentContextMemoryService).get().some(message => message.id === sent.promptId)).toBe(false);
      const transcript = await client.klient.session(id).view.transcript.page({ agentId: child.id });
      expect(agentTranscriptToBlocks(transcript).filter(block => block.kind === 'user' && block.text === text)).toHaveLength(1);
      expect(transcript.items.filter(item => item.kind === 'turn')).toHaveLength(1);
    } finally {
      release.resolve(); controller?.close(); child?.accessor.get(IAgentExecutionService).cancel();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it.each(['model-stream', 'tool-flight'] as const)('durable send-now preserves the in-flight %s and nonempty queue, then consumes once across reopen and retry', async (phase) => {
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let firstResponseClosed = false;
    let toolSignal: AbortSignal | undefined;
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = () => response.end(`data: ${JSON.stringify({ id: 'matrix-response',
          choices: [{ index: 0, delta: { content: 'Received.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`);
        if (requests.length !== 1) { finish(); return; }
        if (phase === 'tool-flight') {
          response.end(`data: ${JSON.stringify({ id: 'matrix-tool', choices: [{ index: 0,
            delta: { tool_calls: [{ index: 0, id: 'example-call', type: 'function', function: { name: 'example_tool', arguments: '{}' } }] },
            finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`);
        } else {
          response.on('close', () => { firstResponseClosed = true; });
          response.write(`data: ${JSON.stringify({ id: 'matrix-stream', choices: [{ index: 0, delta: { content: 'Starting.' }, finish_reason: null }] })}\n\n`);
          entered.resolve();
          void release.promise.then(finish);
        }
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let tool: ReturnType<typeof vi.spyOn> | undefined;
    let controller: SessionController | undefined;
    try {
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home!);
      await createMainAgent(id);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const prompt = main.accessor.get(IAgentPromptService);
      const loop = main.accessor.get(IAgentLoopService);
      if (phase === 'tool-flight') {
        tool = vi.spyOn(main.accessor.get(IAgentToolExecutorService), 'execute').mockImplementation(async function* (_calls, options) {
          toolSignal = options.signal;
          entered.resolve();
          await release.promise;
          options.signal.throwIfAborted();
          yield { toolCallId: 'example-call', toolName: 'example_tool', result: { output: 'Tool finished.', isError: false } };
        });
      }
      await client.submitPrompt(id, { prompt_id: 'matrix-active', profile: 'agent', model: 'stub', content: [{ type: 'text', text: 'Start the turn.' }] });
      await entered.promise;
      const target = loop.status().activeTurnId;
      await client.submitPrompt(id, { prompt_id: 'matrix-older', content: [{ type: 'text', text: 'Keep the older queued message.' }] });
      const body = { admission: 'durable' as const, delivery_mode: 'steer' as const, prompt_id: 'matrix-now', content: [{ type: 'text' as const, text: 'Read the new note once.' }] };
      expect(await client.submitPrompt(id, body)).toMatchObject({ admission: 'restoring', status: 'queued' });
      await vi.waitFor(() => expect(prompt.list().pending.map(item => item.id)).toEqual(['matrix-older', 'matrix-now']));
      expect(loop.status().activeTurnId).toBe(target);
      expect(firstResponseClosed).toBe(false);
      expect(toolSignal?.aborted).not.toBe(true);
      expect(main.accessor.get(IAgentContextMemoryService).get().some(message => message.id === 'matrix-now')).toBe(false);
      expect((await client.submitPrompt(id, body)).admission).toBe('restoring');
      await client.abortPrompt(id, 'matrix-older');
      release.resolve();
      await vi.waitFor(async () => {
        const receipt = await call!<{ delivery_state?: string }>('GET', `/api/sessions/${id}/prompts/matrix-now?admission=durable`);
        expect(receipt.body.data.delivery_state).toBe('steered');
      });
      await loop.settled();
      expect(prompt.list().pending).toEqual([]);
      expect((await client.submitPrompt(id, body)).delivery_state).toBe('steered');
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]!.messages)).not.toContain('Read the new note once.');
      expect(requests[1]!.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('Read the new note once.'))).toHaveLength(1);
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === 'matrix-now')).toHaveLength(1);
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      await controller.open();
      controller.setEphemeralHint(false);
      await expect(controller.sendPromptNow({ promptId: 'matrix-now', text: 'Read the new note once.' })).resolves.toMatchObject({ outcome: 'steered' });
      expect(controller.getState().queuedPromptIds).not.toContain('matrix-now');
      expect(requests).toHaveLength(2);
      controller.close();
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(cold.prompts).toContainEqual(expect.objectContaining({ promptId: 'matrix-now', status: 'completed' }));
      expect(agentTranscriptToBlocks(cold).filter(block => block.kind === 'user' && block.userMessageId === 'matrix-now')).toHaveLength(1);
    } finally {
      release.resolve(); controller?.close(); tool?.mockRestore();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => {
        provider.close(error => {
          if (error) { reject(error); return; }
          resolve();
        });
      });
    }
  }, 30_000);

  it.each([false, true])('durable send-now survives the restoring ack and client close, consuming once after a boundary, uncertain=%s', async (uncertain) => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: `chatcmpl-immediate-${requests.length}`,
          choices: [{ index: 0, delta: { content: 'Received.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    const step = promiseGate<void>();
    const restore = promiseGate<void>();
    let controller: SessionController | undefined;
    let resume: ReturnType<typeof vi.spyOn> | undefined;
    let persistence: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home!);
      await createMainAgent(id);
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      const main = session.accessor.get(IAgentLifecycleService).get('main')!;
      const prompt = main.accessor.get(IAgentPromptService);
      const loop = main.accessor.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.register('hold-durable-immediate', async ({ step: ordinal, signal }) => {
        if (ordinal === 1) await step.promise;
        signal.throwIfAborted();
      }, { before: 'context-injector' });
      await client.submitPrompt(id, { prompt_id: 'immediate-active', profile: 'agent', model: 'stub', content: [{ type: 'text', text: 'Start this turn.' }] });
      await vi.waitFor(() => expect(loop.status().activeTurnId).toBeDefined());
      const targetTurn = loop.status().activeTurnId;
      const manager = fixture.server!.core.accessor.get(ISessionManager);
      const original = manager.resume.bind(manager);
      resume = vi.spyOn(manager, 'resume').mockImplementation(async (...args) => { await restore.promise; return original(...args); });
      const docs = fixture.server!.core.accessor.get(IAtomicDocumentStore);
      const set = docs.set.bind(docs);
      let fail = uncertain;
      persistence = vi.spyOn(docs, 'set').mockImplementation(async (...args) => {
        if (args[0].endsWith('/prompt-ingress/results') && fail) { fail = false; throw new Error('Interrupted immediate receipt publication'); }
        return set(...args);
      });
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      controller.setEphemeralHint(false);
      const text = 'Read the immediate note once.';
      const sent = await controller.sendPromptNow({ promptId: 'durable-immediate', text });
      expect(sent).toEqual({ promptId: 'durable-immediate', outcome: 'restoring' });
      controller.close();
      expect(requests).toEqual([]);
      expect(prompt.list().pending).toEqual([]);
      const root = `/api/sessions/${id}/prompts`;
      const steering = vi.spyOn(prompt, 'steer');
      restore.resolve();
      await vi.waitFor(() => expect(prompt.list().pending.map(item => item.id)).toEqual([sent.promptId]));
      expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({ data: { admission: 'restoring', status: 'queued' } });
      expect(loop.status().activeTurnId).toBe(targetTurn);
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === sent.promptId)).toEqual([]);
      await vi.waitFor(() => expect(steering).toHaveBeenCalledWith([sent.promptId]));
      step.resolve();
      await loop.settled();
      if (uncertain) {
        await vi.waitFor(async () => expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({ data: { admission: 'held' } }));
        expect((await call('POST', `${root}/durable-immediate:resume?admission=durable`)).body.code).toBe(0);
      }
      await vi.waitFor(async () => expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({ data: { admission: 'admitted', status: 'queued' } }));
      expect(prompt.list().pending).toEqual([]);
      const duplicate = await client.submitPrompt(id, { admission: 'durable', delivery_mode: 'steer', prompt_id: sent.promptId, content: [{ type: 'text', text }] });
      expect(duplicate.admission).toBe('admitted');
      expect((await call('POST', root, { admission: 'durable', prompt_id: sent.promptId, content: [{ type: 'text', text }] })).body.code).toBe(40938);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[0]!.messages)).not.toContain(text);
      expect(requests[1]!.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(text))).toHaveLength(1);
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === sent.promptId)).toEqual([
        expect.objectContaining({ id: sent.promptId, role: 'user', content: [{ type: 'text', text }] }),
      ]);
      await main.accessor.get(IWireService).flush();
      const records = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(records.filter(record => record.type === 'prompt.enqueued' && record.promptId === sent.promptId)).toHaveLength(1);
      expect(records.filter(record => record.type === 'turn.steer' && record.promptId === sent.promptId)).toEqual([expect.objectContaining({ turnId: targetTurn })]);
      const transcript = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(transcript.items.filter(item => item.kind === 'turn')).toHaveLength(1);
      expect(agentTranscriptToBlocks(transcript).filter(block => block.kind === 'user' && block.text === text)).toHaveLength(1);
    } finally {
      controller?.close(); restore.resolve(); step.resolve(); resume?.mockRestore(); persistence?.mockRestore();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  }, 30_000);

  it.each(['ended-target', 'binding-change', 'profile-change', 'ordinary'] as const)('durable send-now keeps the normal queue boundary for %s', async (scenario) => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'immediate-boundary-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'queued-example', definitionId: 'fixture:queued-example', systemPrompt: () => 'QUEUED_EXAMPLE' })] } });
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const loop = main.accessor.get(IAgentLoopService);
    const root = `/api/sessions/${id}/prompts`;
    await call('POST', root, { prompt_id: 'boundary-active', content: [{ type: 'text', text: 'Keep the target busy.' }] });
    const target = loop.status().activeTurnId;
    const manager = fixture.server!.core.accessor.get(ISessionManager);
    const original = manager.resume.bind(manager);
    const gate = promiseGate<void>();
    const resume = vi.spyOn(manager, 'resume').mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    try {
      const saved = await call('POST', root, { admission: 'durable', prompt_id: 'boundary-now',
        delivery_mode: scenario === 'ordinary' ? undefined : 'steer',
        permission_mode: scenario === 'binding-change' ? 'yolo' : undefined,
        profile: scenario === 'profile-change' ? 'queued-example' : undefined,
        content: [{ type: 'text', text: 'Keep this request distinct.' }] });
      expect(saved.body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
      if (scenario === 'ended-target') {
        prompt.abort('boundary-active');
        await loop.settled();
        resume.mockRestore();
        await call('POST', root, { prompt_id: 'unrelated-turn', content: [{ type: 'text', text: 'A different turn.' }] });
        expect(loop.status().activeTurnId).not.toBe(target);
      }
      gate.resolve();
      await vi.waitFor(async () => expect((await call('GET', `${root}/boundary-now?admission=durable`)).body).toMatchObject({ data: { admission: 'admitted', status: 'queued' } }));
      const disposition = await call<{ delivery_state?: string; delivery_reason?: string }>('GET', `${root}/boundary-now?admission=durable`);
      expect(disposition.body.data.delivery_reason).toBe(scenario === 'ordinary' ? undefined : scenario === 'ended-target' ? 'target_changed' : 'steer_rejected');
      expect(disposition.body.data.delivery_state).toBe(scenario === 'ordinary' ? undefined : 'queued');
      expect(prompt.list().pending.map(item => item.id)).toContain('boundary-now');
      expect(main.accessor.get(IAgentPermissionModeService).mode).not.toBe('yolo');
      expect(main.accessor.get(IAgentProfileService).data().profileName).toBe('agent');
      expect(main.accessor.get(IAgentContextMemoryService).get().some(message => message.id === 'boundary-now')).toBe(false);
      await main.accessor.get(IWireService).flush();
      const records = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(records.filter(record => record.type === 'prompt.steered' && record.promptIds?.includes('boundary-now'))).toEqual([]);
      if (scenario === 'ended-target') {
        expect(prompt.list().active?.id).toBe('unrelated-turn');
        const unrelated = loop.status().activeTurnId;
        expect(unrelated).toEqual(expect.any(Number));
        const events = main.accessor.get(IEventBus);
        const terminal = promiseGate<'started' | 'aborted'>();
        const started = events.subscribe(PromptStarted, (event) => {
          if (event.promptId === 'boundary-now') terminal.resolve('started');
        });
        const aborted = events.subscribe(PromptAborted, (event) => {
          if (event.promptId === 'boundary-now') terminal.resolve('aborted');
        });
        const step = promiseGate<number>();
        const observe = loop.hooks.onWillBeginStep.register('boundary-now-turn', async (ctx, next) => {
          if (ctx.turnId !== target && ctx.turnId !== unrelated) step.resolve(ctx.turnId);
          await next();
        }, { before: 'hold-test-turn' });
        try {
          prompt.abort('unrelated-turn');
          type BoundaryArrival = { readonly aborted: true } | { readonly aborted: false; readonly turnId: number };
          const arrived = (turnId: number): BoundaryArrival => ({ aborted: false, turnId });
          const winner = await Promise.race<BoundaryArrival>([
            step.promise.then(arrived),
            terminal.promise.then((kind) => kind === 'aborted' ? { aborted: true } : step.promise.then(arrived)),
          ]);
          if (winner.aborted) throw new Error('queued boundary-now was aborted instead of starting its own turn');
          expect(winner.turnId).not.toBe(target);
          expect(winner.turnId).not.toBe(unrelated);
          expect(prompt.list().active?.id).toBe('boundary-now');
          expect(prompt.list().pending.some((item) => item.id === 'boundary-now')).toBe(false);
          expect(loop.status().activeTurnId).toBe(winner.turnId);
          expect(main.accessor.get(IAgentContextMemoryService).get().filter((message) => message.id === 'boundary-now')).toHaveLength(1);
          await main.accessor.get(IWireService).flush();
          const after = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
          expect(after.filter((record) => record.type === 'prompt.steered' && record.promptIds?.includes('boundary-now'))).toEqual([]);
          expect(after.filter((record) => record.type === 'turn.steer' && record.promptId === 'boundary-now')).toEqual([]);
        } finally {
          void started.dispose();
          void aborted.dispose();
          void observe.dispose();
        }
      }
    } finally { gate.resolve(); resume.mockRestore(); prompt.abort('boundary-now'); }
  });

  it.each(['same-target', 'changed-target', 'unsupported', 'unknown-result'] as const)('durable send-now anchors external delivery and never replays an unknown executor action, scenario=%s', async (scenario) => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'external-immediate-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external-immediate', definitionId: 'fixture:external-immediate',
        executor: 'grok-acp', modelAlias: 'grok-raw', systemPrompt: () => 'EXTERNAL_IMMEDIATE' })] } });
    const registry = fixture.server!.core.accessor.get(IAgentExecutorRegistry);
    const originalResolve = registry.resolveExecutable.bind(registry);
    const held = holdExternalSession();
    const run = vi.fn(held.session.run);
    const steer = vi.fn(async () => {
      if (scenario === 'unknown-result') throw new Error('Executor accepted the note but its response was lost.');
      return scenario !== 'unsupported';
    });
    const executor = vi.spyOn(registry, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp' ? {
      descriptor: { ...registry.get(executorId)!, command: process.execPath, revision: 'fixture' },
      options: registry.resolve(executorId, options ?? {}).options,
      provider: { id: 'immediate-fixture', protocol: 'acp-v1', validateOptions: value => value as Record<string, string | number | boolean>,
        validateBinding: binding => ({ ok: true, binding }), create: () => ({ ...held.session, run, steer }) as unknown as AgentExecutorSession },
    } : originalResolve(executorId, options));
    const gate = promiseGate<void>();
    let resume: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const id = await createSession(fixture.home!);
      const root = `/api/sessions/${id}/prompts`;
      const active = await call('POST', root, { prompt_id: 'external-original', profile: 'external-immediate', content: [{ type: 'text', text: 'Original external turn.' }] });
      expect(active.body.code, active.body.msg).toBe(0);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const prompt = main.accessor.get(IAgentPromptService);
      await vi.waitFor(() => expect(prompt.list().active?.id).toBe('external-original'));
      expect(main.accessor.get(IAgentLoopService).status().activeTurnId).toBeUndefined();
      const manager = fixture.server!.core.accessor.get(ISessionManager);
      const originalResume = manager.resume.bind(manager);
      resume = vi.spyOn(manager, 'resume').mockImplementation(async (...args) => { await gate.promise; return originalResume(...args); });
      expect((await call('POST', root, { admission: 'durable', delivery_mode: 'steer', prompt_id: 'external-now', content: [{ type: 'text', text: 'Immediate external note.' }] })).body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
      if (scenario === 'changed-target') {
        held.finish();
        await vi.waitFor(() => expect(prompt.list().active).toBeUndefined());
        resume.mockRestore();
        expect((await call('POST', root, { prompt_id: 'external-replacement', content: [{ type: 'text', text: 'Different external turn.' }] })).body.code).toBe(0);
        await vi.waitFor(() => expect(prompt.list().active?.id).toBe('external-replacement'));
      }
      gate.resolve();
      if (scenario === 'unknown-result') {
        await vi.waitFor(async () => expect((await call('GET', `${root}/external-now?admission=durable`)).body).toMatchObject({ data: { admission: 'held' } }));
        expect(steer).toHaveBeenCalledTimes(1);
        expect(prompt.list().hold).toMatchObject({ reason: 'recovery' });
        expect((await call('POST', `${root}/external-now:resume?admission=durable`)).body.code).toBe(0);
        await vi.waitFor(async () => expect((await call('GET', `${root}/external-now?admission=durable`)).body).toMatchObject({ data: {
          admission: 'held', admission_error: { message: expect.stringContaining('external delivery result is unknown') },
        } }));
        held.finish();
        await main.accessor.get(IAgentExecutionService).settled();
        await vi.waitFor(() => { expect(prompt.list().active).toBeUndefined(); });
        expect((await call('POST', root, { prompt_id: 'after-unknown', content: [{ type: 'text', text: 'Do not release the held queue.' }] })).body).toMatchObject({ code: 0, data: { status: 'queued' } });
        expect(run).toHaveBeenCalledTimes(1);
        expect(steer).toHaveBeenCalledTimes(1);
        expect(prompt.list().pending.map(item => item.id)).toContain('external-now');
        expect(prompt.list().hold).toMatchObject({ reason: 'recovery' });
        return;
      }
      await vi.waitFor(async () => expect((await call('GET', `${root}/external-now?admission=durable`)).body).toMatchObject({ data: {
        admission: 'admitted', delivery_state: scenario === 'same-target' ? 'steered' : 'queued',
      } }));
      const disposition = await call<{ delivery_reason?: string }>('GET', `${root}/external-now?admission=durable`);
      expect(disposition.body.data.delivery_reason).toBe(scenario === 'changed-target' ? 'target_changed' : scenario === 'unsupported' ? 'executor_deferred' : undefined);
      if (scenario === 'unsupported') {
        const retried = await call<{ delivery_reason?: string }>('POST', root, { admission: 'durable', delivery_mode: 'steer', prompt_id: 'external-now', content: [{ type: 'text', text: 'Immediate external note.' }] });
        expect(retried.body.data.delivery_reason).toBe('executor_deferred');
        const explicit = await call<{ delivery_state?: string; delivery_reason?: string }>('POST', `${root}/external-now:steer`);
        expect(explicit.body.data).toMatchObject({ delivery_state: 'queued', delivery_reason: 'executor_deferred' });
      }
      expect(steer).toHaveBeenCalledTimes(scenario === 'changed-target' ? 0 : scenario === 'unsupported' ? 2 : 1);
      expect(prompt.list().pending.some(item => item.id === 'external-now')).toBe(scenario !== 'same-target');
    } finally { gate.resolve(); resume?.mockRestore(); held.finish(); executor.mockRestore(); }
  });

  it('durable send-now respects a steering veto without injecting or leaving a runnable prompt', async () => {
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    const provider = createHttpServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'veto-turn', choices: [{ index: 0, delta: { content: 'Starting.' }, finish_reason: null }] })}\n\n`);
        entered.resolve();
        void release.promise.then(() => response.end(`data: ${JSON.stringify({ id: 'veto-turn', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
    await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
    const id = await createSession(fixture.home!);
    await createMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
    const prompt = main.accessor.get(IAgentPromptService);
    const root = `/api/sessions/${id}/prompts`;
    await call('POST', root, { content: [{ type: 'text', text: 'Hold this turn.' }] });
    await entered.promise;
    expect(main.accessor.get(IAgentLoopService).status().activeTurnId).toBeDefined();
    const hook = prompt.hooks.onBeforeSubmitPrompt.register('veto-immediate-message', async (context, next) => {
      if (context.isSteer) context.block = true;
      await next();
    });
    try {
      const body = { admission: 'durable', delivery_mode: 'steer', prompt_id: 'vetoed-now', content: [{ type: 'text', text: 'Blocked by the steering hook.' }] };
      const steering = vi.spyOn(prompt, 'steer');
      expect((await call('POST', root, body)).body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
      await vi.waitFor(() => expect(prompt.list().pending.map(item => item.id)).toEqual(['vetoed-now']));
      await vi.waitFor(() => expect(steering).toHaveBeenCalledWith(['vetoed-now']));
      release.resolve();
      await vi.waitFor(async () => expect((await call('GET', `${root}/vetoed-now?admission=durable`)).body).toMatchObject({ data: { admission: 'admitted', status: 'blocked' } }));
      expect(prompt.list().pending).toEqual([]);
      expect(main.accessor.get(IAgentContextMemoryService).get().some(message => message.id === 'vetoed-now')).toBe(false);
      expect((await call('POST', root, body)).body).toMatchObject({ code: 0, data: { status: 'blocked' } });
    } finally {
      release.resolve();
      await hook.dispose();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it('expires a prompt waiting behind a stalled submission without starting it or losing its saved body', async () => {
    const id = await createSession(fixture.home!);
    const gate = promiseGate<import('../src/services/promptIngress').PromptIngressResult>();
    const submit = vi.fn(async (_id: string, execution: import('../src/services/promptIngress').PromptIngressExecution) => { await execution.beforeSubmit(); return gate.promise; });
    const ingress = new PromptIngress(fixture.server!.core, { submit, cancel: async () => {} });
    const originalTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay: number | undefined, ...args: unknown[]) =>
      originalTimeout(handler, delay === 120_000 ? 500 : delay, ...args)) as typeof setTimeout);
    try {
      await ingress.submit(id, { prompt_id: 'submitting-first', content: [{ type: 'text', text: 'First message' }] }, 'first');
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
      await ingress.submit(id, { prompt_id: 'queued-later', content: [{ type: 'text', text: 'Second message' }] }, 'second');
      await vi.waitFor(async () => expect(await ingress.lookup(id, 'main', 'queued-later')).toMatchObject({
        admission: 'failed', restore_progress: { phase: 'prompt_queue', elapsed_ms: expect.any(Number) },
        admission_error: { code: 40901, message: expect.stringContaining('120s during prompt_queue') }, content: [{ type: 'text', text: 'Second message' }],
      }), { timeout: 2500 });
      expect(submit).toHaveBeenCalledTimes(1);
      const failed = await ingress.lookup(id, 'main', 'queued-later');
      expect(failed!.restore_progress!.elapsed_ms).toBeGreaterThanOrEqual(500);
    } finally {
      gate.resolve({ prompt_id: 'submitting-first', user_message_id: 'submitting-first', status: 'queued', content: [{ type: 'text', text: 'First message' }], created_at: new Date().toISOString() });
      await ingress.close();
      timers.mockRestore();
    }
  });

  it('bounds stalled admission, reports its leaf phase, and holds repeated content without running another request', async () => {
    const id = await createSession(fixture.home!);
    await closeSessionById(fixture.server!.core.accessor, id);
    const manager = fixture.server!.core.accessor.get(ISessionManager);
    const gate = promiseGate<undefined>();
    const resume = vi.spyOn(manager, 'resume').mockImplementation(() => timeRestorePhase(undefined, {}, 'materialize_workspace_profiles', () => gate.promise));
    const originalTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay: number | undefined, ...args: unknown[]) =>
      originalTimeout(handler, delay === 60_000 ? 1000 : delay, ...args)) as typeof setTimeout);
    const root = `/api/sessions/${id}/prompts`;
    const body = { admission: 'durable', prompt_id: 'bounded-original', content: [{ type: 'text', text: 'Retain this message once' }] };
    try {
      expect((await call('POST', root, body)).body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: {
        admission: 'restoring', restore_progress: { phase: 'materialize_workspace_profiles', elapsed_ms: expect.any(Number) } } });
      expect((await call('POST', root, { ...body, prompt_id: 'bounded-copy' })).body).toMatchObject({ code: 0, data: {
        admission: 'held', admission_duplicate_of: body.prompt_id } });
      expect((await call('POST', root, body)).body).toMatchObject({ code: 0, data: { prompt_id: body.prompt_id } });
      await vi.waitFor(async () => expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: {
        admission: 'failed', admission_error: { code: 40901, message: expect.stringContaining('materialize_workspace_profiles') },
        restore_progress: { phase: 'materialize_workspace_profiles' } } }), { timeout: 3000 });
      expect(resume).toHaveBeenCalledTimes(1);
      expect((await call('POST', `${root}/bounded-copy:abort`)).body).toMatchObject({ code: 0, data: { aborted: true } });
      gate.resolve(undefined);
      expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: { admission: 'failed' } });
      expect(manager.get(id)).toBeUndefined();
    } finally { gate.resolve(undefined); timers.mockRestore(); resume.mockRestore(); }
  });

  it('durable ingress saves and cancels while cold restore is stalled, then holds across restart', async () => {
    const id = await createSession(fixture.home!);
    await closeSessionById(fixture.server!.core.accessor, id);
    const manager = fixture.server!.core.accessor.get(ISessionManager);
    const restoreGate = promiseGate<undefined>();
    const resume = vi.spyOn(manager, 'resume').mockReturnValue(restoreGate.promise);
    const root = `/api/sessions/${id}/prompts`;
    const body = { admission: 'durable', delivery_mode: 'steer', prompt_id: 'saved-before-restore', content: [{ type: 'text', text: 'A saved draft '.repeat(200) }] };
    try {
      const saved = await call<{ admission: string; prompt_id: string }>('POST', `${root}?receipt=true`, body);
      expect(saved.body).toMatchObject({ code: 0, data: { admission: 'restoring', status: 'queued', prompt_id: body.prompt_id } });
      await vi.waitFor(() => expect(resume).toHaveBeenCalled());
      const page = await call<{ ingress: { content: { text: string }[]; admission_content_truncated?: boolean }[] }>('GET', `${root}?admission=durable`);
      expect(page.body.data.ingress[0]).toMatchObject({ admission_content_truncated: true });
      expect(page.body.data.ingress[0]!.content[0]!.text.length).toBeLessThanOrEqual(1024);
      const full = await call<{ content: unknown }>('GET', `${root}/${body.prompt_id}?admission=durable`);
      expect(full.body.data.content).toEqual(body.content);
      expect((await call('POST', `${root}?receipt=true`, body)).body).toMatchObject({ code: 0, data: { prompt_id: body.prompt_id } });
      expect((await call('POST', root, { ...body, content: [{ type: 'text', text: 'different' }] })).body.code).toBe(40938);
      expect((await call('POST', `${root}/${body.prompt_id}:abort`)).body).toMatchObject({ code: 0, data: { aborted: true } });
      await vi.waitFor(() => expect(manager.residencyReport!().pinnedSessions).toBe(0));
      expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: { admission: 'cancelled' } });
      expect((await call('POST', root, { ...body, prompt_id: 'restart-hold' })).body.code).toBe(0);
      for (let n = 0; n < 64; n += 1) expect((await call('POST', root, { ...body, prompt_id: `page-${n}` })).body.code).toBe(0);
      const first = await call<{ ingress: { prompt_id: string }[]; ingress_next_cursor?: string }>('GET', `${root}?admission=durable`);
      expect(first.body.data.ingress).toHaveLength(64);
      expect(first.body.data.ingress_next_cursor).toBeDefined();
      const second = await call<{ ingress: { prompt_id: string }[]; ingress_next_cursor?: string }>('GET', `${root}?admission=durable&cursor=${first.body.data.ingress_next_cursor}`);
      expect(second.body.data.ingress).toHaveLength(2);
      expect(second.body.data.ingress_next_cursor).toBeUndefined();
      expect(new Set([...first.body.data.ingress, ...second.body.data.ingress].map(item => item.prompt_id)).size).toBe(66);
      await fixture.server!.close();
      fixture.server = undefined;
      restoreGate.resolve(undefined);
      resume.mockRestore();
      fixture.server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: fixture.home!, logLevel: 'silent' });
      fixture.base = `http://127.0.0.1:${fixture.server.port}`;
      const restarted = fixture.server.core.accessor.get(ISessionManager);
      const cold = vi.spyOn(restarted, 'resume');
      expect((await call('GET', `${root}/restart-hold?admission=durable`)).body).toMatchObject({ code: 0, data: { admission: 'held' } });
      expect((await call('GET', `${root}?admission=durable`)).body.code).toBe(0);
      expect(cold).not.toHaveBeenCalled();
      cold.mockRestore();
    } finally { restoreGate.resolve(undefined); resume.mockRestore(); }
  }, 30_000);

  it('durable ingress migrates the original ID and media once after a held restore', async () => {
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id);
    const manager = fixture.server!.core.accessor.get(ISessionManager);
    const original = manager.resume.bind(manager);
    const gate = promiseGate<void>();
    const resume = vi.spyOn(manager, 'resume').mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    const bytes = solidPng(2, 2);
    const uploaded = await fixture.server!.core.accessor.get(IFileService).save(Readable.from(bytes), 'original.png', { mimeType: 'image/png' });
    const note = await fixture.server!.core.accessor.get(IFileService).save(Readable.from('Fixture attachment'), 'notes.txt', { mimeType: 'text/plain' });
    const body: import('@kiki/protocol').PromptSubmission = { admission: 'durable', prompt_id: 'media-ingress-once', content: [
      { type: 'text', text: 'Describe the retained image.' }, { type: 'image', source: { kind: 'file', file_id: uploaded.id } },
      { type: 'file', file_id: note.id, name: note.name, media_type: note.media_type, size: note.size },
    ] };
    const root = `/api/sessions/${id}/prompts`;
    const client = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
    try {
      const ack = await client.session(id).commands.submit(body);
      expect(ack).toMatchObject({ admission: 'restoring' });
      await fixture.server!.core.accessor.get(IFileService).delete(uploaded.id);
      gate.resolve();
      let accepted: Awaited<ReturnType<typeof call>>;
      await vi.waitFor(async () => {
        accepted = await call('GET', `${root}/${body.prompt_id}?admission=durable`);
        expect(accepted.body).toMatchObject({ code: 0, data: { admission: 'admitted', prompt_id: body.prompt_id } });
      }, { timeout: 5000 });
      const retry = await client.session(id).commands.submit(body);
      expect(retry).toEqual(accepted!.body.data);
      expect(retry.content[2]).toMatchObject({ type: 'text', text: expect.stringContaining('notes.txt') });
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      const wire = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; promptId?: string });
      expect(wire.filter(record => record.type === 'prompt.enqueued' && record.promptId === body.prompt_id)).toHaveLength(1);
      const media = await fetch(`${fixture.base}/api/sessions/${id}/media/${uploaded.id}`, { headers: authHeaders(fixture.server!) });
      expect(media.status).toBe(200);
      expect(Buffer.from(await media.arrayBuffer())).toEqual(bytes);
      expect((await call('POST', `${root}/${body.prompt_id}:abort`)).body.code).toBe(0);
    } finally { gate.resolve(); resume.mockRestore(); await client.close(); }
  }, 20_000);

  it('durable ingress reconciles an uncertain submission strictly before retrying', async () => {
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id);
    const docs = fixture.server!.core.accessor.get(IAtomicDocumentStore);
    const set = docs.set.bind(docs);
    let fail = true;
    const persistence = vi.spyOn(docs, 'set').mockImplementation(async (...args) => {
      if (args[0].endsWith('/prompt-ingress/results') && fail) { fail = false; throw new Error('Interrupted receipt publication'); }
      return set(...args);
    });
    const root = `/api/sessions/${id}/prompts`;
    const body = { admission: 'durable', delivery_mode: 'steer', prompt_id: 'uncertain-ingress', content: [{ type: 'text', text: 'Run once' }] };
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const prompt = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentPromptService);
    try {
      expect((await call('POST', root, body)).body.code).toBe(0);
      await vi.waitFor(async () => expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: { admission: 'held' } }));
      const lookup = vi.spyOn(promptRetryFor(prompt), 'lookup').mockRejectedValueOnce(new Error('Receipt lookup timed out'));
      expect((await call('POST', `${root}/${body.prompt_id}:resume?admission=durable`)).body.code).toBe(0);
      await vi.waitFor(async () => expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: { admission: 'held', admission_error: { message: expect.stringContaining('Receipt lookup timed out') } } }));
      lookup.mockRestore();
      expect((await call('POST', `${root}/${body.prompt_id}:resume?admission=durable`)).body.code).toBe(0);
      await vi.waitFor(async () => expect((await call('GET', `${root}/${body.prompt_id}?admission=durable`)).body).toMatchObject({ data: { admission: 'admitted' } }));
      const records = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; promptId?: string });
      expect(records.filter(record => record.type === 'prompt.enqueued' && record.promptId === body.prompt_id)).toHaveLength(1);
    } finally { persistence.mockRestore(); prompt.abort(body.prompt_id); }
  });

  it('durable ingress exposes failed validation and rejects missing targets without launching', async () => {
    const id = await createSession(fixture.home!);
    const root = `/api/sessions/${id}/prompts`;
    const body = { admission: 'durable', prompt_id: 'failed-ingress', model: 'missing-model', content: [{ type: 'text', text: 'Saved request' }] };
    expect((await call('POST', root, { ...body, content: [{ type: 'text', text: ' ' }] })).body.code).toBe(40001);
    expect((await call('POST', root, { ...body, agent_id: 'unknown-agent' })).body.code).toBe(40401);
    expect((await call('POST', root, body)).body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
    await vi.waitFor(async () => {
      const item = await call('GET', `${root}/${body.prompt_id}?admission=durable`);
      expect(item.body).toMatchObject({ code: 0, data: { admission: 'failed', admission_error: { message: expect.any(String) }, content: body.content } });
    });
    expect((await call('POST', `${root}/${body.prompt_id}:resume?admission=durable`)).body).toMatchObject({ code: 0, data: { admission: 'restoring' } });
    expect((await call('POST', `${root}/${body.prompt_id}:abort?admission=durable`)).body.code).toBe(0);
  });

  it.each([false, true])('durably acknowledges compact receipts before launch preparation finishes, skills=%s', async (skills) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const gate = promiseGate<void>();
    const entered = promiseGate<void>();
    const hook = prompt.hooks.onBeforeSubmitPrompt.register('hold-admission-test', async (_ctx, next) => {
      entered.resolve();
      await gate.promise;
      await next();
    });
    const payload = { prompt_id: 'held-launch-receipt', content: [{ type: 'text', text: 'Keep this request while preparing the agent.' }],
      skills: skills ? [{ name: 'kiki-ops' }] : undefined };
    const request = call<{ prompt_id: string; status: string }>('POST', `/api/sessions/${id}/prompts?receipt=true`, payload);
    let receipt: Awaited<typeof request> | undefined;
    void request.then(value => { receipt = value; });
    try {
      await entered.promise;
      await vi.waitFor(() => expect(receipt?.body.code).toBe(0), { timeout: 2000 });
      const records = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; promptId?: string });
      expect(records.filter(record => record.type === 'prompt.enqueued' && record.promptId === payload.prompt_id)).toHaveLength(1);
      expect(receipt?.body.data).toMatchObject({ prompt_id: payload.prompt_id, status: 'queued' });
      const replay = await call('POST', `/api/sessions/${id}/prompts?receipt=true`, payload);
      expect(replay.body.data).toEqual(receipt?.body.data);
      const conflict = await call('POST', `/api/sessions/${id}/prompts?receipt=true`, { ...payload, content: [{ type: 'text', text: 'Changed request.' }] });
      expect(conflict.body.code).toBe(40938);
      const cancel = await call('POST', `/api/sessions/${id}/prompts/${payload.prompt_id}:abort`);
      expect(cancel.body).toMatchObject({ code: 0, data: { aborted: true } });
    } finally {
      gate.resolve();
      await request;
      prompt.abort(payload.prompt_id);
      await hook.dispose();
    }
  });

  it.each([false, true])('does not apply runtime controls when the submit hook blocks, skills=%s', async (skills) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const hook = main.accessor.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.register('block-controls', async (ctx, next) => {
      ctx.block = true; await next();
    });
    const submitted = await call<{ status: string }>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'blocked' }], plan_mode: true, goal_objective: 'blocked goal',
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('blocked');
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
    await hook.dispose();
  });

  it.each([false, true])('reports failed launch consistently, skills=%s', async (skills) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const bind = vi.spyOn(main.accessor.get(IAgentProfileService), 'setModel').mockRejectedValueOnce(new Error('model unavailable'));
    const submitted = await call('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'failed' }], model: 'stub-alt',
      plan_mode: true, goal_objective: 'failed goal',
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(50001);
    expect(submitted.body.msg).toContain('model unavailable');
    expect(submitted.body.msg).toContain('[internal]');
    expect(submitted.body.msg).toContain('credentials, model and permission settings');
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
    bind.mockRestore();
  });
});

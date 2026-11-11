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
  IAgentTaskService,
  IConfigService,
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
  IWorkAdmissionService,
  closeSessionById,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { SessionController } from '../../session-core/src/session/sessionController';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { createHooks } from '@kiki/agent-core-v2/hooks';
import type { TurnResult } from '@kiki/agent-core-v2/agent/loop/loop';
import { timeRestorePhase } from '@kiki/agent-core-v2/session/agentLifecycle/restoreTiming';
import { IWorkspaceInstanceManager } from '@kiki/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';
import { agentTranscriptToBlocks } from '../../session-core/src/session/transcript';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '../src/start';
import { FakeImAdapter, fakeAdapterFactory } from '../src/services/imSession/fakeAdapter';
import { createImSessionHost } from '../src/services/imSession/host';
import { NotificationService } from '../src/services/notifications/notificationService';
import { PromptIngress } from '../src/services/promptIngress';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';
import { promiseGate, holdExternalSession, usePromptFixture } from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, createHeldMainAgent } = fixture;

  it.each(['activate', 'cancel'] as const)('saves fenced input with its original fingerprint and sends it once after switch %s', async action => {
    let requests = 0;
    const provider = createHttpServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'switch-response', choices: [{ index: 0, delta: { content: 'Saved message received.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    let accepted: { dispose(): void } | undefined;
    try {
      await fixture.server!.close();
      fixture.server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, port: 0, homeDir: fixture.home, runtimeManaged: true, logLevel: 'silent' });
      fixture.base = `http://127.0.0.1:${fixture.server.port}`;
      await fixture.server.core.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await fixture.server.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home!);
      await createMainAgent(id);
      accepted = fixture.server.core.accessor.get(IWorkAdmissionService).acquire('example-in-flight');
      const switchBody = { operationId: 'example-switch', serverId: fixture.server.serverId, action: 'prepare' };
      expect((await call('POST', '/api/runtime-switch', switchBody)).body.code).toBe(0);
      const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server) });
      const body = { prompt_id: 'example-switch-input', admission: 'durable' as const, content: [{ type: 'text' as const, text: 'Keep the original switch input.' }] };
      expect(await client.submitPrompt(id, body)).toMatchObject({ prompt_id: body.prompt_id, admission: 'waiting_switch' });
      expect(await client.submitPrompt(id, body)).toMatchObject({ prompt_id: body.prompt_id, admission: 'waiting_switch' });
      await expect(client.submitPrompt(id, { ...body, content: [{ type: 'text', text: 'Conflicting input.' }] })).rejects.toMatchObject({ code: 40938 });
      expect(requests).toBe(0);
      const cancelled = { ...body, prompt_id: 'example-cancelled-switch-input', content: [{ type: 'text' as const, text: 'Cancel this saved input.' }] };
      expect(await client.submitPrompt(id, cancelled)).toMatchObject({ admission: 'waiting_switch' });
      await client.abortPrompt(id, cancelled.prompt_id);
      if (action === 'cancel') {
        expect((await call('POST', '/api/runtime-switch', { ...switchBody, action: 'cancel' })).body.code).toBe(0);
        accepted.dispose();
      } else {
        accepted.dispose();
        await fixture.server.closed;
        expect(await fixture.server.exitReceipt).toMatchObject({ cleanupOutcome: 'closed', resourcesAfter: 0 });
        fixture.server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, port: 0, homeDir: fixture.home, runtimeManaged: true, logLevel: 'silent' });
        fixture.base = `http://127.0.0.1:${fixture.server.port}`;
      }
      const recovered = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server) });
      await vi.waitFor(async () => {
        const item = await recovered.sessions.getDurableIngress!(id, body.prompt_id);
        expect(item).toMatchObject({ admission: 'admitted', prompt_id: body.prompt_id });
        expect(requests).toBe(1);
      }, { timeout: 15_000 });
      expect(await recovered.submitPrompt(id, body)).toMatchObject({ prompt_id: body.prompt_id, admission: 'admitted' });
      expect(requests).toBe(1);
      expect(await recovered.sessions.getDurableIngress!(id, cancelled.prompt_id)).toMatchObject({ admission: 'cancelled' });
      await recovered.klient.close();
      await client.klient.close();
    } finally {
      accepted?.dispose();
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  }, 30_000);

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

  it.each(['existing', 'new'] as const)('acknowledges %s Send now before the running step is released', async (source) => {
    const release = promiseGate<void>();
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id, release.promise);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const loop = main.accessor.get(IAgentLoopService);
    const client = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!), timeoutMs: 900 });
    const commands = client.session(id).commands;
    const body = { prompt_id: 'send-now', content: [{ type: 'text' as const, text: 'Send exactly this message.' }] };
    try {
      await commands.submit({ prompt_id: 'active', content: [{ type: 'text', text: 'Hold the first step.' }] });
      await commands.submit({ prompt_id: 'ordinary', content: [{ type: 'text', text: 'Ordinary queue control.' }] });
      if (source === 'existing') {
        await commands.submit(body);
        expect(await commands.steer(body.prompt_id)).toMatchObject({ steered: false, delivery_state: 'accepted' });
        expect(await commands.steer(body.prompt_id)).toMatchObject({ steered: false, delivery_state: 'accepted' });
      } else {
        expect(await commands.submit({ ...body, admission: 'durable', delivery_mode: 'steer' })).toMatchObject({ admission: 'restoring' });
        await vi.waitFor(async () => {
          expect(await client.rest!.sessions.getPrompt(id, body.prompt_id, { admission: 'durable' })).toMatchObject({ admission: 'admitted', delivery_state: 'accepted' });
        }, { timeout: 900 });
      }
      const turn = loop.status().activeTurnId;
      expect(prompt.list().pending.map(item => item.id)).toEqual(['ordinary', body.prompt_id]);
      const context = main.accessor.get(IAgentContextMemoryService);
      expect(context.get().filter(message => message.id === body.prompt_id)).toHaveLength(0);
      expect(await commands.abort('ordinary')).toMatchObject({ aborted: true });
      release.resolve();
      await vi.waitFor(() => expect(context.get().filter(message => message.id === body.prompt_id)).toHaveLength(1));
      expect(prompt.lookup(body.prompt_id)?.turnId).toBe(turn);
    } finally {
      release.resolve();
      await client.close();
    }
  }, 15_000);

  it.each(['deliver', 'cancel'] as const)('reconciles a lost Send now response on reconnect and can %s the same prompt', async outcome => {
    const release = promiseGate<void>();
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id, release.promise);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const token = bearerToken(fixture.server!);
    const promptId = 'accepted-after-lost-response';
    let lost = false;
    const client = createHttpKlient({ endpoint: fixture.base, token, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).includes(`${promptId}:steer`) && !lost) {
        expect(await response.json()).toMatchObject({ code: 0, data: { delivery_state: 'accepted' } });
        lost = true;
        throw new TypeError('Connection lost after acceptance');
      }
      return response;
    } });
    const reopened = createHttpKlient({ endpoint: fixture.base, token });
    try {
      const commands = client.session(id).commands;
      await commands.submit({ prompt_id: 'active', content: [{ type: 'text', text: 'Hold the first step.' }] });
      await commands.submit({ prompt_id: promptId, content: [{ type: 'text', text: 'Keep this message identity.' }] });
      await expect(commands.steer(promptId)).rejects.toThrow();
      expect(lost).toBe(true);
      await client.close();
      const view = reopened.session(id).view;
      const recovered = await view.transcript.page({ agentId: 'main' });
      expect(recovered.prompts).toContainEqual(expect.objectContaining({ promptId, status: 'queued', steerAccepted: true }));
      expect(recovered.prompts.find(item => item.promptId === promptId)?.steeredAt).toBeUndefined();
      expect(await reopened.session(id).commands.steer(promptId)).toMatchObject({ steered: false, delivery_state: 'accepted' });
      if (outcome === 'cancel') {
        expect(await reopened.session(id).commands.abort(promptId, undefined, true)).toMatchObject({ aborted: true });
        const cancelled = await view.transcript.page({ agentId: 'main' });
        expect(cancelled.prompts).toContainEqual(expect.objectContaining({ promptId, status: 'aborted', abortedBeforeStart: true }));
        expect(agentTranscriptToBlocks(cancelled).some(block => block.kind === 'user' && block.userMessageId === promptId)).toBe(false);
      }
      const loop = main.accessor.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.delete('hold-test-turn');
      release.resolve();
      await loop.settled();
      const context = main.accessor.get(IAgentContextMemoryService);
      expect(context.get().filter(message => message.id === promptId)).toHaveLength(outcome === 'deliver' ? 1 : 0);
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await view.transcript.page({ agentId: 'main' });
      expect(agentTranscriptToBlocks(cold).filter(block => block.kind === 'user' && block.userMessageId === promptId)).toHaveLength(outcome === 'deliver' ? 1 : 0);
    } finally {
      release.resolve();
      await client.close();
      await reopened.close();
    }
  }, 15_000);

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
      await vi.waitFor(async () => expect(await client.submitPrompt(id, body)).toMatchObject({ admission: 'admitted', delivery_state: 'accepted' }));
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
      await vi.waitFor(async () => expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({
        data: uncertain ? { admission: 'held' } : { admission: 'admitted', delivery_state: 'accepted' },
      }));
      expect(loop.status().activeTurnId).toBe(targetTurn);
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === sent.promptId)).toEqual([]);
      await vi.waitFor(() => expect(steering).toHaveBeenCalledWith([sent.promptId]));
      step.resolve();
      await loop.settled();
      if (uncertain) {
        await vi.waitFor(async () => expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({ data: { admission: 'held' } }));
        expect((await call('POST', `${root}/durable-immediate:resume?admission=durable`)).body.code).toBe(0);
      }
      await vi.waitFor(async () => expect((await call('GET', `${root}/durable-immediate?admission=durable`)).body).toMatchObject({ data: { admission: 'admitted', delivery_state: 'steered' } }));
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
      expect(disposition.body.data.delivery_reason).toBeUndefined();
      expect(disposition.body.data.delivery_state).toBe(scenario === 'ordinary' ? undefined : 'accepted');
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

  it.each(['main', 'child'] as const)('acknowledges a non-durable external unknown without returning the %s message to a new draft', async target => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'external-unknown-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external-unknown', definitionId: 'fixture:external-unknown',
        executor: 'grok-acp', modelAlias: 'grok-raw', systemPrompt: () => 'EXTERNAL_UNKNOWN' })] } });
    const registry = fixture.server!.core.accessor.get(IAgentExecutorRegistry);
    const originalResolve = registry.resolveExecutable.bind(registry);
    const held = holdExternalSession();
    const run = vi.fn(held.session.run);
    const steer = vi.fn(async () => 'unknown' as const);
    const executor = vi.spyOn(registry, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp' ? {
      descriptor: { ...registry.get(executorId)!, command: process.execPath, revision: 'fixture' },
      options: registry.resolve(executorId, options ?? {}).options,
      provider: { id: 'unknown-fixture', protocol: 'acp-v1', validateOptions: value => value as Record<string, string | number | boolean>,
        validateBinding: binding => ({ ok: true, binding }), create: () => ({ ...held.session, run, steer }) as unknown as AgentExecutorSession },
    } : originalResolve(executorId, options));
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let controller: SessionController | undefined;
    try {
      const created = await call<{ id: string }>('POST', '/api/sessions', { metadata: { cwd: fixture.home! }, ephemeral: true });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;
      await createMainAgent(id);
      const lifecycle = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService);
      const agent = target === 'main' ? lifecycle.get('main')!
        : await lifecycle.create({ binding: { profile: 'external-unknown' } });
      const agentId = agent.id;
      const query = agentId === 'main' ? '' : `?agent_id=${agentId}`;
      const body = { prompt_id: 'external-unknown-once', agent_id: agentId === 'main' ? undefined : agentId,
        delivery_mode: 'steer' as const, content: [{ type: 'text' as const, text: 'Keep the original message.' }] };
      const prompt = agent.accessor.get(IAgentPromptService);
      const started = await call('POST', `/api/sessions/${id}/prompts`, { ...body, prompt_id: 'external-active',
        delivery_mode: undefined, profile: target === 'main' ? 'external-unknown' : undefined,
        content: [{ type: 'text', text: 'Active external turn.' }] });
      expect(started.body.code, JSON.stringify(started.body)).toBe(0);
      await vi.waitFor(() => expect(prompt.list().active?.id, JSON.stringify({
        receipt: prompt.lookup('external-active'),
        status: agent.accessor.get(IAgentExecutionService).status(),
        pending: prompt.list().pending.map((item) => item.id),
        runs: run.mock.calls.length,
      })).toBe('external-active'));
      if (target === 'child') {
        expect(run).toHaveBeenCalledTimes(1);
        const tasks = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
        const visible = () => tasks.list(true).filter((item) => item.kind === 'agent' && item.agentId === agentId);
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ status: 'running', model: 'grok-raw' });
        const replay = await call('POST', `/api/sessions/${id}/prompts`, { ...body, prompt_id: 'external-active',
          delivery_mode: undefined, content: [{ type: 'text', text: 'Active external turn.' }] });
        expect(replay.body.code, JSON.stringify(replay.body)).toBe(0);
        expect(replay.body.data).toMatchObject({ prompt_id: 'external-active' });
        const changed = await call('POST', `/api/sessions/${id}/prompts`, { ...body, prompt_id: 'external-active',
          delivery_mode: undefined, content: [{ type: 'text', text: 'A different external turn.' }] });
        expect(changed.body.code).toBe(40938);
        expect(run).toHaveBeenCalledTimes(1);
        expect(visible()).toHaveLength(1);
      }
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      controller.setFocusedAgent(agentId);
      await controller.open();
      const submitted = vi.spyOn(client.sessions, 'submitPrompt');
      const acknowledged = vi.fn();
      const sent = await controller.sendPromptNow({ agentId, promptId: body.prompt_id, text: body.content[0]!.text, onAcknowledged: acknowledged });
      expect(sent).toEqual({ promptId: body.prompt_id, outcome: 'queued', reason: 'external_retry' });
      expect(acknowledged).toHaveBeenCalledTimes(1);
      expect(submitted).toHaveBeenCalledWith(id, expect.objectContaining({ prompt_id: body.prompt_id, admission: undefined }));
      await vi.waitFor(() => {
        const state = agentId === 'main' ? controller!.getState() : controller!.getAgentState(agentId);
        expect(state.queuedPromptIds).toContain(body.prompt_id);
        expect(state.promptQueueHold).toEqual({ reason: 'recovery', count: 1 });
      });
      expect(controller.getPendingSteers(agentId)).toEqual([]);
      expect(await client.submitPrompt(id, body)).toMatchObject({ prompt_id: body.prompt_id, delivery_state: 'queued', delivery_reason: 'external_retry' });
      expect((await call('POST', `/api/sessions/${id}/prompts/${body.prompt_id}:steer${query}`)).body).toMatchObject({ code: 0, data: { prompt_ids: [body.prompt_id], delivery_reason: 'external_retry' } });
      expect(steer).toHaveBeenCalledTimes(1);
      expect(prompt.list().pending.map(item => item.id)).toEqual([body.prompt_id]);
      held.finish();
      await vi.waitFor(() => expect(prompt.list().active).toBeUndefined());
      expect(run).toHaveBeenCalledTimes(1);
      expect(prompt.abort(body.prompt_id)).toBe(true);
      await agent.accessor.get(IAgentExecutionService).settled();
    } finally { controller?.close(); await client.klient.close(); held.finish(); executor.mockRestore(); }
  });

  it('cancels an idle external child HTTP prompt from its one parent task', async () => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'external-cancel-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external-cancel', definitionId: 'fixture:external-cancel',
        executor: 'grok-acp', modelAlias: 'grok-raw', systemPrompt: () => 'EXTERNAL_CANCEL' })] } });
    const registry = fixture.server!.core.accessor.get(IAgentExecutorRegistry);
    const originalResolve = registry.resolveExecutable.bind(registry);
    const held = holdExternalSession();
    const run = vi.fn(held.session.run);
    const executor = vi.spyOn(registry, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp' ? {
      descriptor: { ...registry.get(executorId)!, command: process.execPath, revision: 'fixture' },
      options: registry.resolve(executorId, options ?? {}).options,
      provider: { id: 'cancel-fixture', protocol: 'acp-v1', validateOptions: value => value as Record<string, string | number | boolean>,
        validateBinding: binding => ({ ok: true, binding }), create: () => ({ ...held.session, run }) as unknown as AgentExecutorSession },
    } : originalResolve(executorId, options));
    try {
      const created = await call<{ id: string }>('POST', '/api/sessions', { metadata: { cwd: fixture.home! }, ephemeral: true });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;
      await createMainAgent(id);
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      const child = await session.accessor.get(IAgentLifecycleService).create({ binding: { profile: 'external-cancel' } });
      const started = await call('POST', `/api/sessions/${id}/prompts`, {
        agent_id: child.id, prompt_id: 'external-cancel-active', content: [{ type: 'text', text: 'Stop this external turn.' }],
      });
      expect(started.body.code, JSON.stringify(started.body)).toBe(0);
      const prompt = child.accessor.get(IAgentPromptService);
      await vi.waitFor(() => expect(prompt.list().active?.id).toBe('external-cancel-active'));
      expect(run).toHaveBeenCalledTimes(1);
      expect(child.accessor.get(IAgentExecutionService).status().state).toBe('running');
      const tasks = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentTaskService);
      const visible = tasks.list(true).filter((item) => item.kind === 'agent' && item.agentId === child.id);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({ status: 'running', model: 'grok-raw' });
      const queued = await call('POST', `/api/sessions/${id}/prompts`, {
        agent_id: child.id, prompt_id: 'external-cancel-next', content: [{ type: 'text', text: 'Do not start another executor.' }],
      });
      expect(queued.body.code, JSON.stringify(queued.body)).toBe(0);
      expect(queued.body.data).toMatchObject({ prompt_id: 'external-cancel-next', status: 'queued' });
      expect(run).toHaveBeenCalledTimes(1);
      expect(prompt.abort('external-cancel-next')).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      await tasks.stopByUser(visible[0]!.taskId);
      await vi.waitFor(() => expect(tasks.getTask(visible[0]!.taskId)?.status).toBe('killed'));
      await vi.waitFor(() => expect(prompt.lookup('external-cancel-active')?.terminal?.state).toBe('cancelled'));
      expect(run).toHaveBeenCalledTimes(1);
      await child.accessor.get(IAgentExecutionService).settled();
      await vi.waitFor(() => expect(tasks.list(true).filter((item) => item.kind === 'agent' && item.agentId === child.id && item.status === 'running')).toEqual([]));
    } finally { held.finish(); executor.mockRestore(); }
  });

  it.each(['run', 'cancel', 'close', 'cleanup-failure'] as const)('waits for the previous external child cleanup before the next HTTP prompt, outcome=%s', async outcome => {
    const core = fixture.server!.core;
    await core.accessor.get(IConfigService).set('subagent', { maxDirectChildren: 1, maxTotalSubagents: 1 });
    core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'external-queue-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external-queue', definitionId: 'fixture:external-queue',
        executor: 'grok-acp', modelAlias: 'grok-raw', systemPrompt: () => 'EXTERNAL_QUEUE' })] } });
    const result = promiseGate<TurnResult>();
    const completion = promiseGate<{ summary: string }>();
    const cleanup = promiseGate<void>();
    const cleanupError = new Error('External cleanup failed');
    let failCleanup = false;
    let childId = '';
    let turnId = 0;
    const run = vi.fn<AgentExecutorSession['run']>(async (_request, options) => {
      const first = ++turnId === 1;
      return { agentId: childId, completion: first ? completion.promise : Promise.resolve({ summary: 'next completed' }), turn: {
        id: turnId, signal: options.signal, ready: Promise.resolve(),
        result: first ? result.promise : Promise.resolve({ type: 'completed', steps: 1, truncated: false }),
        cancel: (reason) => { result.resolve({ type: 'cancelled', steps: 0, reason }); return true; },
      } };
    });
    const external: AgentExecutorSession = {
      run, status: () => ({ state: 'idle' }), cancel: () => false, shutdown: async () => {}, hooks: createHooks(['onWillRun']),
      settled: async () => {
        if (run.mock.calls.length !== 1) return;
        await completion.promise;
        await cleanup.promise;
        if (failCleanup) throw cleanupError;
      },
    };
    const registry = core.accessor.get(IAgentExecutorRegistry);
    const originalResolve = registry.resolveExecutable.bind(registry);
    const executor = vi.spyOn(registry, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp' ? {
      descriptor: { ...registry.get(executorId)!, command: process.execPath, revision: 'fixture' },
      options: registry.resolve(executorId, options ?? {}).options,
      provider: { id: 'queue-fixture', protocol: 'acp-v1', validateOptions: value => value as Record<string, string | number | boolean>,
        validateBinding: binding => ({ ok: true, binding }), create: () => external },
    } : originalResolve(executorId, options));
    const client = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
    let closing: Promise<void> | undefined;
    try {
      const id = await createSession(fixture.home!);
      await createMainAgent(id);
      const session = getLiveSessionById(core.accessor, id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({ binding: { profile: 'external-queue' } });
      childId = child.id;
      const prompt = child.accessor.get(IAgentPromptService);
      const execution = child.accessor.get(IAgentExecutionService);
      const dispatch = session.accessor.get(ISessionDispatchService);
      const commands = client.session(id).commands;
      const firstId = 'external-queue-first';
      const nextId = 'external-queue-next';
      await commands.submit({ agent_id: childId, prompt_id: firstId, content: [{ type: 'text', text: 'First external turn.' }] });
      await vi.waitFor(() => { expect(prompt.list().active?.id).toBe(firstId); });
      expect(run).toHaveBeenCalledTimes(1);
      const tasks = lifecycle.get('main')!.accessor.get(IAgentTaskService);
      const firstTaskId = tasks.list(true).find(item => item.kind === 'agent' && item.agentId === childId)!.taskId;
      const wait = vi.spyOn(execution, 'waitForPromptRun');
      expect(await commands.submit({ agent_id: childId, prompt_id: nextId, content: [{ type: 'text', text: 'Next external turn.' }] }))
        .toMatchObject({ prompt_id: nextId, status: 'queued' });
      result.resolve({ type: 'completed', steps: 1, truncated: false });
      await vi.waitFor(() => { expect(prompt.list().launching?.id).toBe(nextId); });
      await vi.waitFor(() => { expect(wait).toHaveBeenCalledTimes(1); });
      expect(prompt.lookup(nextId)?.phase).toBe('pending');
      expect(run).toHaveBeenCalledTimes(1);
      expect(() => dispatch.reserveExecution('capacity-probe', 'main')).toThrow(expect.objectContaining({ code: 'dispatch.limit_exceeded' }));
      await expect(execution.run({ kind: 'prompt', prompt: 'Unrelated direct run.' }, { signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'agent.already_running' });
      if (outcome === 'cancel') {
        const nextTask = tasks.list(true).find(item => item.kind === 'agent' && item.agentId === childId && item.taskId !== firstTaskId)!;
        await tasks.stopByUser(nextTask.taskId);
        await vi.waitFor(() => { expect(prompt.lookup(nextId)?.terminal?.state).toBe('cancelled'); });
        await vi.waitFor(() => { expect(prompt.list().launching).toBeUndefined(); });
        expect(wait.mock.calls[0]![0].aborted).toBe(true);
      } else if (outcome === 'close') {
        closing = closeSessionById(core.accessor, id);
        await vi.waitFor(() => { expect(prompt.list().launching).toBeUndefined(); });
        expect(wait.mock.calls[0]![0].aborted).toBe(true);
      }
      expect(run).toHaveBeenCalledTimes(1);
      completion.resolve({ summary: 'first completed' });
      await completion.promise;
      if (outcome === 'run' || outcome === 'cleanup-failure') {
        expect(prompt.list().launching?.id).toBe(nextId);
        expect(run).toHaveBeenCalledTimes(1);
      }
      failCleanup = outcome === 'cleanup-failure';
      cleanup.resolve();
      if (outcome === 'close') {
        await closing;
        const saved = await client.session(id).view.transcript.page({ agentId: childId });
        expect(saved.prompts).toContainEqual(expect.objectContaining({ promptId: nextId, status: 'queued' }));
      } else {
        await vi.waitFor(() => { expect(prompt.lookup(nextId)?.terminal?.state).toBe(outcome === 'run' ? 'completed' : outcome === 'cancel' ? 'cancelled' : 'failed'); });
        if (outcome === 'cleanup-failure') {
          expect(JSON.stringify(prompt.lookup(nextId)?.terminal)).toContain(cleanupError.message);
          failCleanup = false;
        }
        await execution.settled();
        const released = dispatch.reserveExecution('capacity-probe', 'main');
        released();
      }
      expect(run).toHaveBeenCalledTimes(outcome === 'run' ? 2 : 1);
    } finally {
      failCleanup = false;
      result.resolve({ type: 'completed', steps: 1, truncated: false });
      completion.resolve({ summary: 'cleanup' });
      cleanup.resolve();
      await closing;
      await client.close();
      executor.mockRestore();
    }
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
        expect((await call('POST', `${root}/external-now:steer`)).body).toMatchObject({ code: 0, data: { delivery_state: 'queued', delivery_reason: 'external_retry' } });
        expect(steer).toHaveBeenCalledTimes(1);
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
        steer.mockResolvedValueOnce(true);
        expect((await call('POST', `${root}/external-now:steer`)).body).toMatchObject({ code: 0, data: {
          steered: true, prompt_ids: ['external-now'], delivery_state: 'steered',
        } });
        expect(prompt.lookup('external-now')).toMatchObject({ promptId: 'external-now', steered: true });
      }
      expect(steer).toHaveBeenCalledTimes(scenario === 'changed-target' ? 0 : scenario === 'unsupported' ? 3 : 1);
      expect(prompt.list().pending.some(item => item.id === 'external-now')).toBe(scenario === 'changed-target');
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

  it('releases a timed-out HTTP acquire pin while the same explicitly promoted restore finishes without submitting the expired prompt', async () => {
    const id = await createSession(fixture.home!);
    await closeSessionById(fixture.server!.core.accessor, id);
    const core = fixture.server!.core;
    const manager = core.accessor.get(ISessionManager);
    const workspaces = core.accessor.get(IWorkspaceInstanceManager);
    const acquire = workspaces.acquire.bind(workspaces);
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    const blocked = vi.spyOn(workspaces, 'acquire').mockImplementation(async input => {
      entered.resolve();
      await release.promise;
      return acquire(input);
    });
    const originalTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay: number | undefined, ...args: unknown[]) =>
      originalTimeout(handler, delay === 60_000 ? 1000 : delay, ...args)) as typeof setTimeout);
    let promoted: ReturnType<ISessionManager['resume']> | undefined;
    try {
      const request = call('POST', `/api/sessions/${id}/prompts`, { prompt_id: 'expired-http-prompt', content: [{ type: 'text', text: 'Do not submit after this request expires' }] });
      await entered.promise;
      promoted = manager.resume(id, { forExecutionControl: true });
      expect((await request).body).toMatchObject({ code: 40901 });
      expect(manager.residencyReport!().pinsByReason).toEqual({});
      release.resolve();
      const session = await promoted;
      expect(session).toBeDefined();
      expect(manager.residencyReport!().pinsByReason).toEqual({});
      expect(session!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentPromptService).lookup('expired-http-prompt')).toBeUndefined();
    } finally {
      release.resolve();
      await promoted;
      blocked.mockRestore();
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

  it('admits IM immediate/steer messages during a running native step without holding the session lock, projects waiting steers in the GUI, and preserves queue mode', async () => {
    const firstEntered = promiseGate<void>();
    const firstRelease = promiseGate<void>();
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push(JSON.parse(body));
        const index = requests.length;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = (text: string) => response.end(`data: ${JSON.stringify({
          id: `im-step-${index}`,
          choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`);
        if (index === 1) {
          response.write(`data: ${JSON.stringify({ id: 'im-step-1', choices: [{ index: 0, delta: { content: 'Idle reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
          response.end();
          return;
        }
        if (index === 2) {
          response.write(`data: ${JSON.stringify({ id: 'im-step-2', choices: [{ index: 0, delta: { content: 'Long step in progress.' }, finish_reason: null }] })}\n\n`);
          firstEntered.resolve();
          void firstRelease.promise.then(() => finish(' Done step 1.'));
          return;
        }
        finish(`Steered reply ${index}.`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const server = fixture.server!;
    const baseCore = server.core;
    const home = fixture.home!;
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(server) });
    const adapter = new FakeImAdapter('wechat_bridge', 'test-account');
    const identity = { chatId: 'im-chat', senderId: 'im-sender', topicId: '0', chatKind: 'private' as const };
    let notifications: NotificationService | undefined;
    let bridge: Awaited<ReturnType<typeof createImSessionHost>> | undefined;
    let controller: SessionController | undefined;
    try {
      await baseCore.accessor.get(IModelCatalogMutationService).updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await baseCore.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(home);
      await createMainAgent(id);
      const session = getLiveSessionById(baseCore.accessor, id)!;
      const main = session.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
      const prompt = main.accessor.get(IAgentPromptService);
      const loop = main.accessor.get(IAgentLoopService);

      const core = Object.create(baseCore, {
        instantiation: {
          value: Object.create(baseCore.instantiation, {
            provide: {
              value: () => undefined,
            },
          }),
        },
      }) as typeof baseCore;
      notifications = new NotificationService(core, home, () => false, () => undefined);
      await notifications.start();
      bridge = await createImSessionHost({
        core,
        homeDir: home,
        notifications,
        logger: { info() {} },
        factories: [fakeAdapterFactory(adapter)],
      });
      const pasted = await bridge.paste({ text: 'wechat_token=example-test-token\nwechat_account=test-account' });
      const instanceId = pasted.provider_instance_id;
      await bridge.setListening(instanceId, true);
      await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'pair' });
      const discoveryId = (await bridge.snapshot()).discoveries[0]!.id;
      const confirmed = await bridge.confirm(discoveryId, { target: { kind: 'session', session_id: id }, busy: 'immediate', reply: 'final' });
      const bindingId = confirmed.bindings[0]!.id;

      await adapter.emit({ eventId: 'idle-first', identity, kind: 'text', text: 'Idle first message.' });
      const idleId = `im:${instanceId}:idle-first`;
      await vi.waitFor(() => {
        expect(adapter.sent.filter(item => item.code === 'reply').map(item => item.text), JSON.stringify({
          lookup: prompt.lookup(idleId),
          list: prompt.list(),
          loop: loop.status(),
          sent: adapter.sent,
          requests: requests.length,
        })).toContain('Idle reply.');
      }, { timeout: 6_000 });
      await loop.settled();

      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      controller.setEphemeralHint(false);
      await controller.open();

      await client.submitPrompt(id, { prompt_id: 'long-turn', content: [{ type: 'text', text: 'Start the long running step.' }] });
      await firstEntered.promise;
      const activeTurnId = loop.status().activeTurnId;
      expect(activeTurnId).toEqual(expect.any(Number));

      await bridge.updateBinding(bindingId, { busy: 'queue' });
      await adapter.emit({ eventId: 'queued-item', identity, kind: 'text', text: 'Wait until turn end.' });
      const queuedPromptId = `im:${instanceId}:queued-item`;
      expect(adapter.sent.some(item => item.code === 'queued')).toBe(true);
      await vi.waitFor(() => expect(controller!.getState().queuedPromptIds).toContain(queuedPromptId));

      await bridge.updateBinding(bindingId, { busy: 'immediate' });
      const sentBeforeImmediate = adapter.sent.filter(item => item.code === 'queued').length;
      await Promise.all([
        adapter.emit({ eventId: 'imm-1', sourceMessageId: 'src-1', identity, kind: 'text', text: 'Immediate note one.' }),
        adapter.emit({ eventId: 'imm-2', sourceMessageId: 'src-2', identity, kind: 'text', text: 'Immediate note two.' }),
      ]);
      await adapter.emit({ eventId: 'imm-1', sourceMessageId: 'src-1', identity, kind: 'text', text: 'Immediate note one.' });
      const imm1Id = `im:${instanceId}:imm-1`;
      const imm2Id = `im:${instanceId}:imm-2`;

      expect(adapter.sent.filter(item => item.code === 'queued')).toHaveLength(sentBeforeImmediate);
      expect(prompt.lookup(imm1Id)).toMatchObject({ promptId: imm1Id, steerAccepted: true });
      expect(prompt.lookup(imm2Id)).toMatchObject({ promptId: imm2Id, steerAccepted: true });
      expect(loop.status().activeTurnId).toBe(activeTurnId);
      expect(main.accessor.get(IAgentContextMemoryService).get().some(message => message.id === imm1Id || message.id === imm2Id)).toBe(false);

      await vi.waitFor(() => {
        const waitingIds = controller!.getPendingSteers('main').filter(item => item.phase === 'waiting').map(item => item.promptId);
        expect(waitingIds).toEqual(expect.arrayContaining([imm1Id, imm2Id]));
        expect(controller!.getState().queuedPromptIds).toContain(queuedPromptId);
        expect(controller!.getState().queuedPromptIds).not.toContain(imm1Id);
        expect(controller!.getState().queuedPromptIds).not.toContain(imm2Id);
      });

      expect(prompt.abort(queuedPromptId)).toBe(true);
      firstRelease.resolve();
      await loop.settled();

      expect(prompt.lookup(imm1Id)).toMatchObject({ promptId: imm1Id, steered: true, turnId: activeTurnId });
      expect(prompt.lookup(imm2Id)).toMatchObject({ promptId: imm2Id, steered: true, turnId: activeTurnId });
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === imm1Id)).toHaveLength(1);
      expect(main.accessor.get(IAgentContextMemoryService).get().filter(message => message.id === imm2Id)).toHaveLength(1);

      await vi.waitFor(() => {
        const replies = adapter.sent.filter(item => item.code === 'reply').map(item => item.text);
        expect(replies.some(text => text.includes('Steered reply') && !text.includes('Long step in progress.'))).toBe(true);
      }, { timeout: 6_000 });

      await main.accessor.get(IWireService).flush();
      const wire = (await readFile(join(session.accessor.get(ISessionContext).sessionDir, 'agents/main/wire.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; promptId?: string; turnId?: number });
      expect(wire.filter(record => record.type === 'prompt.enqueued' && record.promptId === imm1Id)).toHaveLength(1);
      expect(wire.filter(record => record.type === 'prompt.enqueued' && record.promptId === imm2Id)).toHaveLength(1);
    } finally {
      firstRelease.resolve();
      controller?.close();
      await bridge?.close();
      await notifications?.close();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => {
        provider.close(error => {
          if (error) { reject(error); return; }
          resolve();
        });
      });
    }
  }, 30_000);

  it.each(['changed-target', 'definite-refusal', 'unknown-result'] as const)('attempts external IM immediate steer at most once, sends queued copy when queued, and preserves recovery hold, scenario=%s', async (scenario) => {
    const server = fixture.server!;
    const baseCore = server.core;
    const home = fixture.home!;
    baseCore.accessor.get(IAgentProfileRegistry).register({
      sourceId: `im-external-steer-${scenario}`,
      priority: 50,
      contribution: {
        profiles: [normalizeAgentProfile({
          name: `im-external-${scenario}`,
          definitionId: `fixture:im-external-${scenario}`,
          executor: 'grok-acp',
          modelAlias: 'grok-raw',
          systemPrompt: () => 'IM_EXTERNAL',
        })],
      },
    });
    const registry = baseCore.accessor.get(IAgentExecutorRegistry);
    const originalResolve = registry.resolveExecutable.bind(registry);
    const held = holdExternalSession();
    const run = vi.fn(held.session.run);
    const steer = vi.fn(async () => {
      if (scenario === 'unknown-result') throw new Error('External executor steer outcome lost.');
      return scenario !== 'definite-refusal';
    });
    const executor = vi.spyOn(registry, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp' ? {
      descriptor: { ...registry.get(executorId)!, command: process.execPath, revision: 'fixture' },
      options: registry.resolve(executorId, options ?? {}).options,
      provider: {
        id: 'im-external-fixture',
        protocol: 'acp-v1',
        validateOptions: value => value as Record<string, string | number | boolean>,
        validateBinding: binding => ({ ok: true, binding }),
        create: () => ({ ...held.session, run, steer }) as unknown as AgentExecutorSession,
      },
    } : originalResolve(executorId, options));
    const adapter = new FakeImAdapter('wechat_bridge', 'test-account');
    const identity = { chatId: 'im-ext-chat', senderId: 'im-ext-sender', topicId: '0', chatKind: 'private' as const };
    const gate = promiseGate<void>();
    let resume: ReturnType<typeof vi.spyOn> | undefined;
    let notifications: NotificationService | undefined;
    let bridge: Awaited<ReturnType<typeof createImSessionHost>> | undefined;
    try {
      const id = await createSession(home);
      const root = `/api/sessions/${id}/prompts`;
      const active = await call('POST', root, {
        prompt_id: 'im-ext-original',
        profile: `im-external-${scenario}`,
        content: [{ type: 'text', text: 'Original external turn.' }],
      });
      expect(active.body.code, active.body.msg).toBe(0);
      const main = getLiveSessionById(baseCore.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const prompt = main.accessor.get(IAgentPromptService);
      await vi.waitFor(() => expect(prompt.list().active?.id).toBe('im-ext-original'));

      const core = Object.create(baseCore, {
        instantiation: {
          value: Object.create(baseCore.instantiation, {
            provide: {
              value: () => undefined,
            },
          }),
        },
      }) as typeof baseCore;
      notifications = new NotificationService(core, home, () => false, () => undefined);
      await notifications.start();
      bridge = await createImSessionHost({
        core,
        homeDir: home,
        notifications,
        logger: { info() {} },
        factories: [fakeAdapterFactory(adapter)],
      });
      const pasted = await bridge.paste({ text: 'wechat_token=example-test-token\nwechat_account=test-account' });
      const instanceId = pasted.provider_instance_id;
      await bridge.setListening(instanceId, true);
      await adapter.emit({ eventId: 'discover', identity, kind: 'text', text: 'pair' });
      const discoveryId = (await bridge.snapshot()).discoveries[0]!.id;
      await bridge.confirm(discoveryId, { target: { kind: 'session', session_id: id }, busy: 'immediate', reply: 'final' });

      if (scenario === 'changed-target') {
        const manager = baseCore.accessor.get(ISessionManager);
        const originalAcquire = manager.acquire!.bind(manager);
        let calls = 0;
        resume = vi.spyOn(manager, 'acquire').mockImplementation(async (...args) => {
          calls += 1;
          if (calls === 2) await gate.promise;
          return originalAcquire(...args);
        });
      }

      const emitPromise = adapter.emit({ eventId: 'ext-now', identity, kind: 'text', text: 'Immediate external IM note.' });
      if (scenario === 'changed-target') {
        await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
        held.finish();
        await vi.waitFor(() => expect(prompt.list().active).toBeUndefined());
        const replacement = await main.accessor.get(IAgentPromptService).enqueue({
          id: 'im-ext-replacement',
          message: { role: 'user', content: [{ type: 'text', text: 'Replacement external turn.' }], toolCalls: [], origin: { kind: 'user' } },
        });
        expect(replacement.id).toBe('im-ext-replacement');
        await vi.waitFor(() => expect(prompt.list().active?.id).toBe('im-ext-replacement'));
        resume?.mockRestore();
        resume = undefined;
        gate.resolve();
      }
      await emitPromise;

      const imPromptId = `im:${instanceId}:ext-now`;
      expect(steer).toHaveBeenCalledTimes(scenario === 'changed-target' ? 0 : 1);
      expect(prompt.list().pending.map(item => item.id)).toEqual([imPromptId]);
      expect(adapter.sent.filter(item => item.code === 'queued')).toHaveLength(1);
      if (scenario === 'unknown-result') {
        expect(prompt.list().hold).toMatchObject({ reason: 'recovery', count: 1 });
        expect(prompt.list().pending[0]?.deliveryReason).toBe('external_retry');
      } else if (scenario === 'definite-refusal') {
        expect(prompt.list().hold).toBeUndefined();
        expect(prompt.list().pending[0]?.deliveryReason).toBe('executor_deferred');
      } else {
        expect(prompt.list().hold).toBeUndefined();
        expect(prompt.list().pending[0]?.deliveryReason).toBeUndefined();
      }
      expect(prompt.abort(imPromptId)).toBe(true);
    } finally {
      gate.resolve();
      resume?.mockRestore();
      await bridge?.close();
      await notifications?.close();
      held.finish();
      executor.mockRestore();
    }
  }, 30_000);
});

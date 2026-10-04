import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import {
  IAgentProfileRegistry, IAgentProfileService, IAgentLoopService,
  ISessionManager, ensureMainAgent, normalizeAgentProfile,
} from '@kiki/agent-core-v2';
import { IPersonaStore } from '@kiki/agent-core-v2/app/persona/personaStore';
import { IThreadCreateTool } from '@kiki/agent-core-v2/agent/tools/thread-communication/threadCreateTool';
import { SessionController } from '../../session-core/src/session/sessionController';
import { createSessionTransport } from '../../session-core/src/session/klientTransport';
import { resolveSelectedEffort } from '../../session-core/src/settings/agentSettings';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

it('keeps real ThreadCreate bindings on GUI entry, running continuation and cold reopen without inheriting the caller', async () => {
  const home = await mkdtemp(join(tmpdir(), 'created-thread-binding-'));
  const requests: Record<string, unknown>[] = [];
  let pending: ServerResponse | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      pending = response;
    })();
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture provider address');
  await writeFile(join(home, 'config.toml'), `default_model = "fixture"\n[search]\nenabled = false\n[providers.fixture]\ntype = "openai"\nbase_url = "http://127.0.0.1:${address.port}/v1"\napi_key = "fixture"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 100000\ncapabilities = ["thinking"]\nsupport_efforts = ["low", "medium", "high"]\ndefault_effort = "medium"\n`);
  const server = await startServer({ homeDir: home, port: 0, logLevel: 'silent', hostIdentity: TEST_HOST_IDENTITY });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: server.localOwnerToken });
  const controllers: SessionController[] = [];
  const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'created-thread-fixture', priority: 40,
    contribution: { profiles: [normalizeAgentProfile({ name: 'main-fixture', main: true, definitionId: 'fixture:main', description: 'Fixture main', modelAlias: 'fixture', thinkingEffort: 'low', systemPrompt: () => 'Fixture work style.' })] },
  });
  try {
    const manager = server.core.accessor.get(ISessionManager);
    const caller = await manager.create({ workDir: home, mainAgentBinding: { profile: 'agent', model: 'fixture', thinking: 'low' } });
    const tool = (await ensureMainAgent(caller)).accessor.get(IThreadCreateTool);
    const create = async (input: Parameters<typeof tool.resolveExecution>[0]) => {
      const execution = tool.resolveExecution(input);
      if (!('execute' in execution)) throw new Error('ThreadCreate rejected');
      const result = await execution.execute({ signal: new AbortController().signal, turnId: 0, toolCallId: 'create-fixture' });
      if (typeof result.output !== 'string') throw new Error('Missing ThreadCreate output');
      return JSON.parse(result.output) as { id: string; profile: string };
    };
    const open = async (id: string, effort: string) => {
      const controller = new SessionController(createSessionTransport(client), client.session(id).view, id);
      controllers.push(controller);
      await controller.open();
      await vi.waitFor(() => expect(controller.getState().transcriptReady).toBe(true));
      expect(controller.getState()).toMatchObject({ model: 'fixture', thinkingEffort: effort });
      expect(resolveSelectedEffort(['low', 'medium', 'high'], controller.getState().thinkingEffort, 'medium')).toBe(effort);
      return controller;
    };
    const explicit = await create({ model_alias: 'fixture', effort: 'high' });
    const bound = (await ensureMainAgent(manager.get(explicit.id)!)).accessor.get(IAgentProfileService);
    expect(bound.data()).toMatchObject({ modelAlias: 'fixture', thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
    const live = await open(explicit.id, 'high');
    expect(bound.data().thinkingLevel).toBe('high');
    live.close();
    await manager.close(explicit.id);
    const cold = await open(explicit.id, 'high');
    expect(manager.get(explicit.id)).toBeUndefined();
    const sending = cold.sendPrompt({ text: 'Synthetic continuation', model: cold.getState().model, thinking: cold.getState().thinkingEffort });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ model: 'fixture', reasoning_effort: 'high' });
    await open(explicit.id, 'high');
    pending!.writeHead(200, { 'content-type': 'text/event-stream' });
    pending!.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'Fixture reply.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    await sending;
    await (await ensureMainAgent(manager.get(explicit.id)!)).accessor.get(IAgentLoopService).settled();
    const modelDefault = await create({ model_alias: 'fixture' });
    await open(modelDefault.id, 'medium');
    const profileDefault = await create({ profile: 'main-fixture' });
    await open(profileDefault.id, 'low');
    await server.core.accessor.get(IPersonaStore).put({ id: 'fixture-persona', name: 'Fixture persona', description: 'Synthetic fixture persona.', profile: 'main-fixture', thinkingEffort: 'high' });
    const persona = await create({ persona: 'fixture-persona' });
    expect(persona.profile).toBe('main-fixture');
    await open(persona.id, 'high');
    const manual = await client.rest!.sessions.create({ metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'fixture', thinking: 'high' } });
    await open(manual.id, 'high');
  } finally {
    for (const controller of controllers) controller.close();
    registration.dispose();
    if (pending !== undefined && !pending.writableEnded) {
      pending.writeHead(200, { 'content-type': 'text/event-stream' });
      pending.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: 'Fixture reply.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }
    await client.close();
    await server.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

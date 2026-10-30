import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import {
  IAgentGoalService,
  IAgentLoopService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentExecutorRegistry,
  type AgentExecutorProvider,
  type AgentExecutorSession,
  type ResolvedAgentExecutor,
  type ProfileBindingSnapshot,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IAgentPromptService,
  normalizeAgentProfile,
  IEventDispatcher,
  IWireService,
  IModelCatalogMutationService,
  IConfigService,
  ISessionIndex,
  ISessionManager,
  ensureMainAgent,
  closeSessionById,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { createHooks } from '@kiki/agent-core-v2/hooks';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { buildNewSessionCreate } from '../../../apps/kiki-gui/src/components/NewSessionDraft';
import {
  resolveProfileSwitchSubmission,
  resolveControlledSkillSubmission,
} from '../../../apps/kiki-gui/src/components/SessionView';
import { executionChoice } from '../../session-core/src/composer/executionSelection';
import { SessionController } from '../../session-core/src/session/sessionController';
import {
  applyCompactionProgress,
  type CompactionProgress,
} from '../../../apps/kiki-gui/src/components/useCompactionProgress';
import { compactSessionContext } from '../../session-core/src/commands/sessionActions';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
} from '@kiki/agent-core-v2/agent/llmRequester/llmRequester';
import { IAgentFullCompactionService } from '@kiki/agent-core-v2/agent/fullCompaction/fullCompaction';
import {
  agentTranscriptToBlocks,
  createViewState,
  isOrdinaryQueueItem,
  projectAgentTranscriptView,
  queuedPromptPreviews,
} from '../../session-core/src/session/transcript';
import { describe, expect, it, vi } from 'vitest';
import { modelSwitchActionSchema } from '../src/protocol/rest-model-switch';
import { bearerToken } from './helpers/auth';
import {
  type PromptItemWire,
  PROMPT_TOML,
  promiseGate,
  writeConfigToml,
  holdExternalSession,
  usePromptFixture,
} from './helpers/promptFixture';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

describe('server-v2 /api prompts', () => {
  const fixture = usePromptFixture();
  const { call, createSession, createMainAgent, createHeldMainAgent } = fixture;

  it.each(['configured-default', 'onboarding-provider', 'profile-default', 'onboarding-welcome-skill', 'welcome-selected-model'] as const)('runs the welcome first message from an empty workspace with the configured or selected model (%s)', async (source) => {
    const requests: string[] = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push((JSON.parse(body) as { model: string }).model);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'welcome-response', choices: [{ index: 0, delta: { content: 'Welcome.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      let expectedModel = 'stub';
      if (source === 'onboarding-provider' || source === 'onboarding-welcome-skill') {
        await writeConfigToml(fixture.home!, PROMPT_TOML.replace('default_model = "stub"', ''));
        await fixture.server!.core.accessor.get(IConfigService).reload();
        const saved = await call('POST', '/api/providers', {
          id: 'welcome', type: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'fixture',
          models: [{ remote_id: 'stub', max_context_size: 100000 }],
        });
        expect(saved.body.code, saved.body.msg).toBe(0);
        expectedModel = 'welcome/stub';
      } else {
        await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
        await mutations.updateModel('stub', { max_context_size: 100000 });
        if (source === 'profile-default') {
          await writeConfigToml(fixture.home!, (await readFile(join(fixture.home!, 'config.toml'), 'utf8')).replace('default_model = "stub"', ''));
          await mkdir(join(fixture.home!, 'agents'), { recursive: true });
          await writeFile(join(fixture.home!, 'agents', 'agent.md'), '---\nname: agent\ndescription: Fixture main profile\nmodel_alias: stub\nthinking_effort: high\n---\nHelp the user.\n');
        }
      }
      if (source === 'welcome-selected-model') {
        await writeConfigToml(fixture.home!, (await readFile(join(fixture.home!, 'config.toml'), 'utf8')).replace('default_model = "stub"', ''));
        await fixture.server!.core.accessor.get(IConfigService).reload();
      }
      const created = await call<{ id: string; agent_config: { model?: string } }>('POST', '/api/sessions', {});
      expect(created.body.code).toBe(0);
      const session = getLiveSessionById(fixture.server!.core.accessor, created.body.data.id)!;
      const main = await ensureMainAgent(session);
      expect(main.accessor.get(IAgentProfileService).getModel()).toBe('');
      const prompts = main.accessor.get(IAgentPromptService);
      if (source === 'onboarding-welcome-skill') {
        const args = 'Say in two or three sentences what you can do, then ask what I most want to get done and take me through doing it once: set up whatever that step needs and leave what already works alone. One question at a time.';
        const requestBody = { args, user_input: `/kiki-ops ${args}`, prompt_id: 'welcome-helper-retry' };
        const startedAt = Date.now();
        const activated = await call('POST', `/api/sessions/${session.id}/skills/kiki-ops:activate`, requestBody);
        expect(activated.body.code, activated.body.msg).toBe(0);
        const acceptedAt = Date.now();
        const loop = main.accessor.get(IAgentLoopService);
        await loop.settled();
        expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
        const replay = await call('POST', `/api/sessions/${session.id}/skills/kiki-ops:activate`, requestBody);
        expect(replay.body.code, JSON.stringify(replay.body)).toBe(0);
        expect(replay.body.data).toMatchObject({ activated: true, skill_name: 'kiki-ops', prompt_id: 'welcome-helper-retry' });
        console.log(JSON.stringify({ route: 'skills/kiki-ops:activate', request_id: activated.body.request_id, remote_model: requests[0], bound_model: main.accessor.get(IAgentProfileService).getModel(), turn_result: loop.status().lastTurnResult, accepted_ms: acceptedAt - startedAt, finished_ms: Date.now() - startedAt }));
      } else {
        const userInput = '/kiki-ops Help me start.';
        const controlled = source === 'welcome-selected-model' ? resolveControlledSkillSubmission({
          name: 'kiki-ops', args: 'Help me start.', userInput, attachments: [],
          pendingProfile: undefined, boundProfile: 'agent', modelTouched: true, effortTouched: true,
          model: 'stub', thinking: 'high', permissionTouched: false,
        }) : undefined;
        const requestBody = {
          ...(controlled ?? { content: [{ type: 'text', text: 'Introduce Kiki and help me choose my first task.' }] }),
          prompt_id: controlled === undefined ? 'welcome-first-use' : 'welcome-controlled-retry',
        };
        const startedAt = Date.now();
        const submitted = await call<PromptItemWire>('POST', `/api/sessions/${session.id}/prompts`, requestBody);
        const acceptedAt = Date.now();
        expect(submitted.body.code, JSON.stringify(submitted.body)).toBe(0);
        const submittedId = submitted.body.data.prompt_id;
        if (source === 'welcome-selected-model') {
          const loop = main.accessor.get(IAgentLoopService);
          await loop.settled();
          expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
          expect(controlled).toMatchObject({ model: 'stub', thinking: 'high', skills: [{ name: 'kiki-ops', args: 'Help me start.' }] });
          expect(controlled?.content[0]).toEqual({ type: 'text', text: userInput });
          console.log(JSON.stringify({ route: 'prompts', request_id: submitted.body.request_id, remote_model: requests[0], bound_model: main.accessor.get(IAgentProfileService).getModel(), turn_result: loop.status().lastTurnResult, accepted_ms: acceptedAt - startedAt, completed_ms: Date.now() - startedAt }));
        } else {
          const loop = main.accessor.get(IAgentLoopService);
          await loop.settled();
          expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
          await vi.waitFor(() => expect(prompts.lookup(submittedId)?.phase).toBe('terminal'));
          expect(prompts.lookup(submittedId)?.terminal).toMatchObject({ state: 'completed' });
        }
        const replay = await call<PromptItemWire>('POST', `/api/sessions/${session.id}/prompts`, requestBody);
        expect(replay.body.code, JSON.stringify(replay.body)).toBe(0);
        expect(replay.body.data).toMatchObject({ prompt_id: submittedId, user_message_id: submittedId });
      }
      expect(requests).toEqual(['stub']);
      expect(main.accessor.get(IAgentProfileService).getModel()).toBe(expectedModel);
    } finally {
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([false, true])('keeps the selected model over a profile default through creation and the first provider request (explicit=%s)', async (explicit) => {
    const requests: string[] = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        requests.push((JSON.parse(body) as { model: string }).model);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'selected-model-response', choices: [{ index: 0, delta: { content: 'Ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      for (const model of ['stub', 'stub-alt']) await mutations.updateModel(model, { max_context_size: 100000 });
      fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
        sourceId: 'selected-model-fixture', priority: 50,
        contribution: { profiles: [normalizeAgentProfile({
          name: 'selected-model-profile', definitionId: 'fixture:selected-model-profile', main: true,
          modelAlias: 'stub', thinkingEffort: 'high', systemPrompt: () => 'Help the user.',
        })] },
      });
      const selectedModel = explicit ? 'stub-alt' : undefined;
      const expectedModel = selectedModel ?? 'stub';
      const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
      const created = await client.createSession(buildNewSessionCreate({ cwd: fixture.home!, profile: 'selected-model-profile',
        execution: executionChoice({ executor: 'native', profile: 'selected-model-profile' }),
        model: selectedModel, modelTouched: explicit, permissionMode: 'manual', planMode: false }));
      expect(created.agent_config).toMatchObject({ model: expectedModel, profile: 'selected-model-profile' });
      const main = await ensureMainAgent(getLiveSessionById(fixture.server!.core.accessor, created.id)!);
      expect(main.accessor.get(IAgentProfileService).data().boundProfile?.promptContextPending).toBe(true);
      await client.sessions.submitPrompt(created.id, { prompt_id: 'selected-model-first', content: [{ type: 'text', text: 'Use my selected model.' }], model: selectedModel });
      await main.accessor.get(IAgentLoopService).settled();
      expect(main.accessor.get(IAgentLoopService).status().lastTurnResult).toBe('completed');
      expect(main.accessor.get(IAgentProfileService).getModel()).toBe(expectedModel);
      expect(requests).toEqual([expectedModel]);
    } finally {
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects a welcome first message without a model before enqueue and accepts the preserved prompt after model selection', async () => {
    await writeConfigToml(fixture.home!, PROMPT_TOML.replace('default_model = "stub"', ''));
    const created = await call<{ id: string }>('POST', '/api/sessions', {});
    expect(created.body.code, created.body.msg).toBe(0);
    const session = getLiveSessionById(fixture.server!.core.accessor, created.body.data.id)!;
    const main = await ensureMainAgent(session);
    const content = [{ type: 'text', text: 'Keep this welcome draft.' }];
    const rejected = await call('POST', `/api/sessions/${session.id}/prompts`, { prompt_id: 'welcome-preserved', content });
    expect(rejected.body.code).toBe(40113);
    expect(main.accessor.get(IAgentPromptService).lookup('welcome-preserved')).toBeUndefined();
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('');
    main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-selected-welcome', async ctx => {
      await new Promise<void>(resolve => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const accepted = await call<PromptItemWire>('POST', `/api/sessions/${session.id}/prompts`, { prompt_id: 'welcome-preserved', content, model: 'stub' });
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('stub');
    main.accessor.get(IAgentPromptService).abort('welcome-preserved');
  });

  it('creates a direct executor over HTTP and commits queued execution overrides only at the next user turn', async () => {
    const bindings: ProfileBindingSnapshot[] = [];
    const runs: Array<{ generation: number; prompt: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: AgentExecutorProvider = {
      id: 'example-provider', protocol: 'acp-v1', validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: (context) => {
        bindings.push(structuredClone(context.binding));
        let running = false;
        let current = Promise.resolve();
        return {
          hooks: createHooks(['onWillRun']),
          status: () => ({ state: running ? 'running' : 'idle' }),
          run: async (request, options) => {
            running = true;
            runs.push({ generation: context.binding.execution!.generation, prompt: request.kind === 'retry' ? '' : request.prompt });
            const id = runs.length;
            current = (id === 1 ? gate : Promise.resolve()).then(() => { running = false; });
            const completion = current.then(() => ({ summary: 'Done' }));
            options.onReady?.();
            return { agentId: context.agent.id, completion, turn: {
              id, signal: options.signal, ready: Promise.resolve(), cancel: () => false,
              result: current.then(() => ({ type: 'completed' as const, steps: 1, truncated: false })),
            } };
          },
          cancel: () => false, settled: () => current, shutdown: async () => {},
        };
      },
    };
    const registry = fixture.server!.core.accessor.get(IAgentExecutorRegistry);
    vi.spyOn(registry, 'resolveExecutable').mockResolvedValue({ descriptor: {
      id: 'example-acp', protocol: 'acp-v1', command: 'fixture', args: [], revision: 'fixture',
    }, options: {}, provider });
    vi.spyOn(registry, 'validateBinding').mockImplementation((_id, _options, binding) => ({ ok: true, binding }));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!), transport: {
      eventsUrl: `${fixture.base.replace(/^http/, 'ws')}/api/klient/events`,
      fetch: (input, init) => {
        if (init?.method === 'POST' && typeof init.body === 'string') {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
        }
        return fetch(input, init);
      },
    } });
    let controller: SessionController | undefined;
    try {
      const configured = await call<{ agent_executor_overrides: unknown }>('POST', '/api/config', {
        agent_executor_overrides: { 'example-acp': { defaults: { model_alias: 'settings-model', thinking_effort: 'low',
          kiki_context: [], allow_kiki_subagents: false, executor_prompt: { delivery: 'preamble', include: [] } } } },
      });
      expect(configured.body.code, configured.body.msg).toBe(0);
      expect(configured.body.data.agent_executor_overrides).toMatchObject({ 'example-acp': { defaults: {
        model_alias: 'settings-model', thinking_effort: 'low', kiki_context: [], allow_kiki_subagents: false,
      } } });
      const cleared = await call<{ agent_executor_overrides: unknown }>('POST', '/api/config', {
        agent_executor_overrides: { 'example-acp': { defaults: { model_alias: null, thinking_effort: null, executor_prompt: null } } },
      });
      expect(cleared.body.code, cleared.body.msg).toBe(0);
      expect(cleared.body.data.agent_executor_overrides).toEqual({ 'example-acp': { defaults: { kiki_context: [], allow_kiki_subagents: false } } });
      const chosen = executionChoice({ executor: 'example-acp', overrides: { model: 'vendor-model', thinking: 'high' } });
      const created = await client.createSession(buildNewSessionCreate({ cwd: fixture.home!, profile: 'agent', execution: chosen,
        model: 'stub', thinking: 'low', modelTouched: true, effortTouched: true,
        permissionMode: 'manual', permissionTouched: false, planMode: false }));
      const id = created.id;
      expect(requests.find((request) => request.path === '/api/sessions')?.body['agent_config']).toEqual({
        execution: chosen, plan_mode: false,
      });
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
      const main = await ensureMainAgent(session);
      const profile = main.accessor.get(IAgentProfileService);
      const before = structuredClone(profile.data().execution!);
      expect(before).toMatchObject({ selection: { executor: 'example-acp' }, effective: { model: 'vendor-model', thinking: 'high' },
        sources: { kiki_context: 'harness-settings', allow_kiki_subagents: 'harness-settings', permission_mode: 'harness-default' } });
      expect(before.selection.profile).toBeUndefined();
      expect(before.effective.permission_mode).toBeUndefined();
      const first = await controller.sendPrompt({ promptId: 'direct-first', text: 'FIRST_USER' });
      expect(first.status).toBe('queued');
      await vi.waitFor(() => { expect(main.accessor.get(IAgentPromptService).list().active?.id).toBe('direct-first'); });
      const nextChoice = executionChoice({ executor: 'example-acp', overrides: { model: null, thinking: null, permission_mode: null,
        kiki_context: [], allow_kiki_subagents: false } });
      const nextSelection = resolveProfileSwitchSubmission({ pendingProfile: undefined, boundProfile: 'agent',
        pendingExecution: nextChoice, boundExecution: executionChoice(before.selection),
        modelTouched: true, effortTouched: true, model: 'stub', thinking: 'low', permissionTouched: true, permissionMode: 'manual' });
      const next = await controller.sendPrompt({ ...nextSelection, promptId: 'direct-next', text: 'NEXT_USER' });
      expect(next.status).toBe('queued');
      expect(requests.find((request) => request.body['prompt_id'] === 'direct-next')?.body).toEqual({
        prompt_id: 'direct-next', content: [{ type: 'text', text: 'NEXT_USER' }], execution: nextChoice,
      });
      expect(profile.data().execution).toEqual(before);
      expect(bindings).toHaveLength(1);
      release();
      await vi.waitFor(() => { expect(runs).toHaveLength(2); }, { timeout: 5000 });
      await main.accessor.get(IAgentExecutionService).settled();
      await vi.waitFor(() => { expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined(); });
      const after = structuredClone(profile.data().execution!);
      expect(after.generation).toBe(before.generation + 1);
      expect(after.selection.overrides).toEqual({ kiki_context: [], allow_kiki_subagents: false });
      expect(after.effective.model).toBeUndefined();
      expect(after.effective.thinking).toBeUndefined();
      expect(after.sources).toMatchObject({ model: 'harness-default', thinking: 'harness-default',
        kiki_context: 'session', allow_kiki_subagents: 'session', permission_mode: 'harness-default' });
      expect(bindings).toHaveLength(2);
      expect(bindings[1]).toMatchObject({ execution: after, systemPrompt: '', kikiContext: [], allowKikiSubagents: false });
      expect(bindings[1]?.profileName).toBeUndefined();
      const inherited = resolveProfileSwitchSubmission({ pendingProfile: undefined, boundProfile: 'agent',
        pendingExecution: undefined, boundExecution: executionChoice(after.selection),
        modelTouched: false, effortTouched: false, model: undefined, thinking: profile.data().thinkingLevel,
        permissionTouched: false, permissionMode: 'manual' });
      await controller.sendPrompt({ ...inherited, promptId: 'direct-inherit', text: 'INHERIT_USER' });
      expect(requests.find((request) => request.body['prompt_id'] === 'direct-inherit')?.body).toEqual({
        prompt_id: 'direct-inherit', content: [{ type: 'text', text: 'INHERIT_USER' }],
      });
      await vi.waitFor(() => { expect(runs).toHaveLength(3); });
      await main.accessor.get(IAgentExecutionService).settled();
      expect(profile.data().execution).toEqual(after);
      expect(bindings).toHaveLength(2);
      expect(runs).toEqual([{ generation: before.generation, prompt: 'FIRST_USER' },
        { generation: after.generation, prompt: 'NEXT_USER' }, { generation: after.generation, prompt: 'INHERIT_USER' }]);
      const warm = await client.getSession(id);
      expect(warm.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await client.getSession(id);
      expect(cold.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      const coldProfile = await call<{ agent_config: { execution: unknown } }>('GET', `/api/sessions/${id}/profile`);
      expect(coldProfile.body.data.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();
    } finally { release(); controller?.close(); await client.klient.close(); }
  });

  it('queues a GUI manual compaction over HTTP and publishes manual execution and completion after a held request', async () => {
    await fixture.server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 256000 });
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
    main.accessor.get(IAgentFullCompactionService).setContextStrategyOverride('summarize');
    const context = main.accessor.get(IAgentContextMemoryService);
    for (const [role, text] of [['user', 'Old request.'], ['assistant', 'Old response.']] as const) {
      context.append({ role, content: [{ type: 'text', text }], toolCalls: [] });
    }
    let release!: () => void;
    let requestStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve) => { requestStarted = resolve; });
    const finish = (text: string): AgentLLMRequestFinish => ({
      message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      providerFinishReason: 'completed',
    });
    const requester = vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'start').mockImplementation((input) => ({
      trace: { traceId: 'fixture-manual-compaction' },
      result: input?.source?.type === 'turn'
        ? (async () => { requestStarted(); await gate; return finish('Held final answer.'); })()
        : Promise.resolve(finish('Manual summary over HTTP.')),
    }));
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let progress: CompactionProgress | undefined;
    const phases: string[] = [];
    const events = client.klient.session(id).agent('main').events;
    const update = (event: Parameters<typeof applyCompactionProgress>[1]) => {
      progress = applyCompactionProgress(progress, event);
      if (progress !== undefined) phases.push(`${progress.source}:${progress.phase}`);
    };
    const subscriptions = [events.on('compaction.started', update), events.on('compaction.completed', update), events.on('compaction.cancelled', update)];
    try {
      await Promise.all(subscriptions.map((subscription) => subscription.ready));
      await client.submitPrompt(id, { content: [{ type: 'text', text: 'Held request.' }] });
      await held;
      const record = await client.getSession(id);
      const action = { client, host: {}, refreshSessions: vi.fn(), navigate: vi.fn() };
      const receipt = await compactSessionContext(action, record);
      expect(receipt).toEqual({ accepted: true, source: 'manual', status: 'queued' });
      expect(await compactSessionContext(action, record)).toEqual({ accepted: false, source: 'manual', status: 'queued' });
      await expect.poll(() => progress?.phase).toBe('queued');
      expect(requester).toHaveBeenCalledTimes(1);
      release();
      await expect.poll(() => progress?.phase).toBe('completed');
      expect(phases).toEqual(['manual:queued', 'manual:running', 'manual:completed']);
      expect(requester).toHaveBeenCalledTimes(2);
      expect(main.accessor.get(IAgentFullCompactionService).queuedManualCompaction).toBe(false);
      expect(context.get().some((message) => message.origin?.kind === 'compaction_summary')).toBe(true);
      await main.accessor.get(IAgentLoopService).settled();
    } finally {
      release();
      for (const subscription of subscriptions) subscription.dispose();
      await client.klient.close();
      requester.mockRestore();
    }
  }, 30_000);

  it('reconciles stale steer and queued-only removal through HTTP without stopping the active turn', async () => {
    const id = await createSession(fixture.home!);
    await createHeldMainAgent(id);
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    try {
      const active = await client.submitPrompt(id, { prompt_id: 'active-removal', content: [{ type: 'text', text: 'Working' }] });
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const prompt = main.accessor.get(IAgentPromptService);
      await vi.waitFor(() => expect(prompt.list().active?.id).toBe(active.prompt_id));
      const queued = await client.submitPrompt(id, { prompt_id: 'im:test:queued', content: [{ type: 'text', text: 'Not yet started' }] });
      expect(queued.status).toBe('queued');
      const removed = await client.klient.session(id).commands.abort(queued.prompt_id, undefined, true);
      expect(removed).toMatchObject({ aborted: true });
      expect((await call('POST', `/api/sessions/${id}/prompts/${queued.prompt_id}:abort?queued_only=true`)).body).toMatchObject({ code: 0, data: { aborted: false } });
      expect((await call('POST', `/api/sessions/${id}/prompts/${queued.prompt_id}:steer`)).body).toMatchObject({ code: 0, data: { steered: false, delivery_reason: 'prompt_no_longer_pending' } });
      expect((await call('POST', `/api/sessions/${id}/prompts/${active.prompt_id}:abort?queued_only=true`)).body).toMatchObject({ code: 0, data: { aborted: false } });
      expect(prompt.list().active?.id).toBe(active.prompt_id);
      const snapshot = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(snapshot.prompts.find((item) => item.promptId === queued.prompt_id)).toMatchObject({ status: 'aborted', abortedBeforeStart: true });
      expect(agentTranscriptToBlocks(snapshot).some((item) => item.kind === 'user' && item.promptId === queued.prompt_id)).toBe(false);
      expect((await call('POST', `/api/sessions/${id}/prompts/never-admitted:steer`)).body.code).toBe(40402);
    } finally {
      getLiveSessionById(fixture.server!.core.accessor, id)?.accessor.get(IAgentLifecycleService).get('main')?.accessor.get(IAgentPromptService).abort('active-removal');
      await client.klient.close();
    }
  });

  it('round-trips scheduled delivery modes over HTTP and projects fired queue text with its origin', async () => {
    const sessionId = await createSession(fixture.home!);
    await createHeldMainAgent(sessionId);
    const main = getLiveSessionById(fixture.server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    const provider = vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'request');
    const client = createHttpKlient({ endpoint: fixture.base, token: bearerToken(fixture.server!) });
    type Task = { id: string; prompt: string; delivery_mode: 'queue' | 'steer' | 'idle'; paused: boolean };
    const tasks: Task[] = [];
    try {
      for (const deliveryMode of ['queue', 'steer', 'idle', undefined] as const) {
        const response = await call<{ task: Task }>('POST', '/api/cron', {
          session_id: sessionId, cron: '0 9 * * *', paused: true,
          prompt: `Read the release checklist\nKeep existing work running: ${deliveryMode ?? 'default'}`,
          delivery_mode: deliveryMode,
        });
        expect(response.body.code, response.body.msg).toBe(0);
        expect(response.body.data.task).toMatchObject({ delivery_mode: deliveryMode ?? 'idle', paused: true });
        tasks.push(response.body.data.task);
      }
      for (const task of tasks) {
        const response = await call<{ task: Task }>('PATCH', `/api/cron/${task.id}?session_id=${sessionId}`, {
          cron: '15 9 * * *', prompt: `${task.prompt}\nUpdated schedule without changing timing.`,
        });
        expect(response.body.code, response.body.msg).toBe(0);
        expect(response.body.data.task.delivery_mode).toBe(task.delivery_mode);
        task.prompt = response.body.data.task.prompt;
      }
      for (const deliveryMode of ['steer', 'idle', 'queue'] as const) {
        const response = await call<{ task: Task }>('PATCH', `/api/cron/${tasks[0]!.id}?session_id=${sessionId}`, { delivery_mode: deliveryMode });
        expect(response.body.code, response.body.msg).toBe(0);
        expect(response.body.data.task.delivery_mode).toBe(deliveryMode);
      }
      const listed = await call<{ items: Task[] }>('GET', `/api/cron?session_id=${sessionId}`);
      expect(listed.body.code).toBe(0);
      expect(new Map(listed.body.data.items.map((task) => [task.id, task.delivery_mode]))).toEqual(new Map(tasks.map((task) => [task.id, task.delivery_mode])));
      const busy = await call<PromptItemWire>('POST', `/api/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: 'Synthetic held turn.' }] });
      expect(busy.body.code, busy.body.msg).toBe(0);
      expect(busy.body.data.status).toBe('running');
      for (const task of [tasks[0]!, tasks[2]!]) {
        const fired = await call<{ triggered: true }>('POST', `/api/cron/${task.id}:run?session_id=${sessionId}`);
        expect(fired.body.code, fired.body.msg).toBe(0);
        expect(fired.body.data.triggered).toBe(true);
      }
      const page = await client.session(sessionId).view.transcript.page({ agentId: 'main' });
      const state = projectAgentTranscriptView(createViewState(sessionId), 'main', page);
      const previews = queuedPromptPreviews(state);
      expect(previews).toHaveLength(2);
      const ordinary = previews.find(isOrdinaryQueueItem)!;
      expect(ordinary).toMatchObject({ originKind: 'cron_job', cronDeliveryMode: 'queue', text: tasks[0]!.prompt, media: [] });
      expect(ordinary.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining(tasks[0]!.prompt) })]);
      expect(previews.find((item) => item.cronDeliveryMode === 'idle')).toMatchObject({ originKind: 'cron_job', text: tasks[2]!.prompt });
      expect(state.blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await main.accessor.get(IAgentPromptService).drain(new Error('test cleanup'));
      provider.mockRestore();
      await client.close();
    }
  });

  it('prompt-bound confirmation mode reaches the HTTP provider and live/cold prompt projection', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'attached-response', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let controller: SessionController | undefined;
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      for (const model of ['stub', 'stub-alt']) await mutations.updateModel(model, { max_context_size: 100000 });
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'low' });
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      await controller.open();
      const input = { promptId: 'http-attached-fresh', text: 'This real message owns the confirmed fresh mode.', model: 'stub-alt', thinking: 'high', modelSwitchMode: 'fresh' as const };
      const receipt = await controller.sendPrompt(input);
      await main.accessor.get(IAgentLoopService).settled();
      await main.accessor.get(IEventDispatcher).flush();
      expect(main.accessor.get(IAgentPromptService).lookup(receipt.prompt_id)).toMatchObject({ phase: 'terminal', terminal: { state: 'completed' } });
      expect(bodies.map(body => [body['model'], body['reasoning_effort']])).toEqual([['stub-alt', 'high']]);
      expect(JSON.stringify(bodies[0])).toContain(input.text);
      const live = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(live.prompts).toContainEqual(expect.objectContaining({ promptId: input.promptId, runtimeControls: expect.objectContaining({ model: 'stub-alt', thinking: 'high', modelSwitchMode: 'fresh' }) }));
      expect(main.accessor.get(IAgentPromptService).listModelSwitches()).toEqual([]);
      const journal = [];
      for await (const record of main.accessor.get(IWireService).readJournal()) journal.push(record);
      expect(journal.filter(record => record.type === 'agent.model_switch')).toMatchObject([{ mode: 'fresh' }]);
      expect(journal.filter(record => record.type === 'llm.request')).toMatchObject([{ modelAlias: 'stub-alt', thinkingEffort: 'high' }]);
      const plain = await controller.sendPrompt({ promptId: 'http-unbound-message', text: 'A message without attached execution settings.' });
      await main.accessor.get(IAgentLoopService).settled();
      const plainLive = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(plainLive.prompts).toContainEqual(expect.objectContaining({ promptId: plain.prompt_id }));
      expect(plainLive.prompts.find(prompt => prompt.promptId === plain.prompt_id)?.runtimeControls).toBeUndefined();
      expect(bodies.map(body => [body['model'], body['reasoning_effort']])).toEqual([['stub-alt', 'high'], ['stub-alt', 'high']]);
      controller.close(); controller = undefined;
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(cold.prompts).toContainEqual(expect.objectContaining({ promptId: input.promptId, runtimeControls: expect.objectContaining({ model: 'stub-alt', thinking: 'high', modelSwitchMode: 'fresh' }) }));
      expect(cold.prompts).toContainEqual(expect.objectContaining({ promptId: plain.prompt_id }));
      expect(cold.prompts.find(prompt => prompt.promptId === plain.prompt_id)?.runtimeControls).toBeUndefined();
      expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();
    } finally {
      controller?.close();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it('validates recover mode only for retry actions', () => {
    expect(modelSwitchActionSchema.parse({ action: 'retry', mode: 'fresh' })).toEqual({ action: 'retry', mode: 'fresh' });
    expect(modelSwitchActionSchema.parse({ action: 'keep_original' })).toEqual({ action: 'keep_original' });
    expect(modelSwitchActionSchema.parse({ action: 'cancel' })).toEqual({ action: 'cancel' });
    expect(modelSwitchActionSchema.safeParse({ action: 'keep_original', mode: 'fresh' }).success).toBe(false);
    expect(modelSwitchActionSchema.safeParse({ action: 'cancel', mode: 'fresh' }).success).toBe(false);
  });

  it.each(['model', 'effort', 'prompt-binding'] as const)('GUI client Send now applies a pending %s at the first safe HTTP request boundary', async change => {
    const bodies: Record<string, unknown>[] = [];
    let entered!: () => void;
    const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        const send = () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify({ id: 'safe-boundary-response', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        };
        if (bodies.length === 1) { entered(); void gate.then(send); }
        else send();
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      for (const model of ['stub', 'stub-alt']) await mutations.updateModel(model, { max_context_size: 100000 });
      await fixture.server!.core.accessor.get(ISessionIndex).prepare();
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'low' });
      await client.submitPrompt(id, { prompt_id: 'safe-http-active', content: [{ type: 'text', text: 'Work already in progress.' }] });
      await firstRequest;
      if (change !== 'prompt-binding') {
        const selected = await client.klient.session(id).agent('main').switchModel({ operationId: 'safe-http-choice', model: change === 'model' ? 'stub-alt' : 'stub', thinking: 'high', mode: 'direct' });
        expect(selected.state).toBe('pending');
      }
      const dependent = await client.submitPrompt(id, { prompt_id: 'safe-http-original',
        after_model_switch: change === 'prompt-binding' ? undefined : 'safe-http-choice',
        model: change === 'prompt-binding' ? 'stub-alt' : undefined, thinking: change === 'prompt-binding' ? 'high' : undefined,
        content: [{ type: 'text', text: 'Unique original GUI question after selection.' }] });
      expect(dependent.status).toBe('queued');
      await client.steerPrompt(id, dependent.prompt_id);
      expect(bodies).toHaveLength(1);
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({ modelAlias: 'stub', thinkingLevel: 'low' });
      release();
      await main.accessor.get(IAgentLoopService).settled();
      expect(bodies).toHaveLength(2);
      expect(bodies.map(body => body['model'])).toEqual(['stub', change === 'effort' ? 'stub' : 'stub-alt']);
      expect(bodies.map(body => body['reasoning_effort'])).toEqual(['low', 'high']);
      expect(JSON.stringify(bodies[1])).toContain('Unique original GUI question after selection.');
      const journal = [];
      for await (const record of main.accessor.get(IWireService).readJournal()) journal.push(record);
      expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === 'safe-http-original')).toHaveLength(1);
      expect(journal.filter(record => record.type === 'agent.model_switch')).toHaveLength(change === 'prompt-binding' ? 0 : 1);
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({ modelAlias: change === 'effort' ? 'stub' : 'stub-alt', thinkingLevel: 'high' });
      expect(main.accessor.get(IAgentPromptService).list().pending).toEqual([]);
    } finally {
      release();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    }
  });

  it('switches through REST and klient events at idle with dependent delivery and one live/cold timeline identity', async () => {
    const models: string[] = [];
    const provider = createHttpServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        models.push((JSON.parse(body) as { model: string }).model);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ id: 'switch-response', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const klient = createHttpKlient({ endpoint: fixture.base, token: fixture.server!.localOwnerToken });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      await mutations.updateModel('stub-alt', { max_context_size: 100000 });
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
      const loop = main.accessor.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.register('model-switch-current-turn', async () => { await gate; });
      const agent = klient.session(id).agent('main');
      const observed: unknown[] = [];
      let completed!: () => void;
      const completion = new Promise<void>((resolve) => { completed = resolve; });
      const subscription = agent.events.on('prompt.model_switch_status', (event) => {
        observed.push(event.receipt);
        if (event.operationId === 'http-switch' && event.receipt.state === 'completed') completed();
      });
      const queuedSubscription = agent.events.on('prompt.model_switch_queued', (event) => { observed.push(event.entry.receipt); });
      await Promise.all([subscription.ready, queuedSubscription.ready]);
      const active = await call('POST', `/api/sessions/${id}/prompts`, { prompt_id: 'old-active', content: [{ type: 'text', text: 'Complete the current turn.' }] });
      expect(active.body.code).toBe(0);
      const path = `/api/sessions/${id}/agents/main/model-switches`;
      const accepted = await call('POST', path, { operationId: 'http-switch', model: 'stub-alt', mode: 'direct' });
      expect(accepted.body.data).toMatchObject({ state: 'pending', operationId: 'http-switch' });
      const cancelled = await agent.switchModel({ operationId: 'cancelled-choice', model: 'stub-alt', mode: 'fresh' });
      expect(cancelled.state).toBe('pending');
      expect(await agent.cancelModelSwitch('cancelled-choice')).toMatchObject({ state: 'cancelled' });
      const dependent = await klient.session(id).commands.submit({ prompt_id: 'new-dependent', after_model_switch: 'http-switch', content: [{ type: 'text', text: 'Continue on the committed model.' }] });
      expect(dependent).toMatchObject({ prompt_id: 'new-dependent', status: 'queued' });
      expect(main.accessor.get(IAgentProfileService).getModel()).toBe('stub');
      let finishDependent!: () => void;
      const dependentCompletion = new Promise<void>((resolve) => { finishDependent = resolve; });
      const promptSubscription = agent.events.on('prompt.completed', (event) => { if (event.promptId === 'new-dependent') finishDependent(); });
      await promptSubscription.ready;
      release();
      await Promise.all([completion, dependentCompletion]);
      await loop.settled();
      promptSubscription.dispose();
      queuedSubscription.dispose();
      expect(await agent.getModelSwitch('http-switch')).toMatchObject({ state: 'completed', binding: { model: 'stub-alt' } });
      expect(models).toEqual(['stub', 'stub-alt']);
      expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: 'http-switch', state: 'preparing' }), expect.objectContaining({ operationId: 'http-switch', state: 'completed' })]));
      const read = await call('GET', `${path}/http-switch`);
      expect(read.body.data).toMatchObject({ state: 'completed' });
      const live = await klient.session(id).view.transcript.page({ agentId: 'main' });
      const liveMarkers = live.items.filter((item) => item.kind === 'marker' && item.markerId === 'model-switch:http-switch');
      expect(liveMarkers).toHaveLength(1);
      const switchMarker = liveMarkers[0] as { payload?: { operationId?: string; mode?: string; state?: string }; contentRefs?: readonly { path: readonly (string | number)[] }[] };
      const payloadRef = switchMarker.contentRefs?.find((ref) => ref.path.at(-1) === 'payload');
      const loadedPayload = payloadRef === undefined ? switchMarker.payload : (await call<{ value: { operationId?: string; mode?: string; state?: string } }>('POST', `/api/klient/session-view/${id}/transcript/content`, { agentId: 'main', ref: payloadRef })).body;
      if (payloadRef !== undefined) expect(loadedPayload).toMatchObject({ code: 0 });
      const switchPayload = payloadRef === undefined ? switchMarker.payload : (loadedPayload as { data: { value: { operationId?: string; mode?: string; state?: string } } }).data.value;
      expect(switchPayload).toMatchObject({ operationId: 'http-switch', mode: 'direct', state: 'completed' });
      subscription.dispose();
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(cold.items.filter((item) => item.kind === 'marker' && item.markerId === 'model-switch:http-switch')).toEqual(liveMarkers);
      expect(models).toHaveLength(2);
    } finally {
      release();
      await klient.close();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('projects a queued send-now message once at its step boundary live and after cold reopening', async () => {
    const provider = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        id: 'chatcmpl-send-now',
        choices: [{ index: 0, delta: { content: 'Message received.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const mutations = fixture.server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(fixture.home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const loop = main.accessor.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.register('hold-send-now-delivery', async ({ step, signal }) => {
        if (step === 1) await gate;
        signal.throwIfAborted();
      }, { before: 'context-injector' });
      const active = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Start the turn.' }], profile: 'agent', model: 'stub' });
      await vi.waitFor(() => expect(main.accessor.get(IAgentPromptService).list().active?.id).toBe(active.prompt_id));
      const queued = await client.submitPrompt(id, { prompt_id: 'queued-send-now', content: [{ type: 'text', text: 'Check the queued message.' }] });
      expect(queued.status).toBe('queued');
      const steering = client.steerPrompt(id, queued.prompt_id);
      const beforeDelivery = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(agentTranscriptToBlocks(beforeDelivery).filter((block) => block.kind === 'user' && block.text === 'Check the queued message.'))
        .toEqual([expect.objectContaining({ promptId: queued.prompt_id, promptStatus: 'queued', turnId: undefined })]);
      release();
      await steering;
      expect(main.accessor.get(IAgentPromptService).list().pending).toHaveLength(0);
      await loop.settled();
      const context = main.accessor.get(IAgentContextMemoryService).get();
      expect(context).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: queued.prompt_id, role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Check the queued message.' }] }),
      ]));
      const live = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      const rows = agentTranscriptToBlocks(live).filter((block) => block.kind === 'user' && block.text === 'Check the queued message.');
      expect(rows).toEqual([expect.objectContaining({ id: `user-${queued.prompt_id}`, userMessageId: queued.prompt_id, turnId: expect.any(String) })]);
      const turns = live.items.filter((item) => item.kind === 'turn');
      expect(turns).toHaveLength(1);
      expect(turns[0]?.promptId).toBe(active.prompt_id);
      expect(rows[0]?.kind === 'user' ? rows[0].turnId : undefined).toBe(turns[0]?.turnId);
      await closeSessionById(fixture.server!.core.accessor, id);
      const cold = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();
      expect(agentTranscriptToBlocks(cold).filter((block) => block.kind === 'user' && block.text === 'Check the queued message.')).toEqual(rows);
    } finally {
      release();
      await client.klient.close();
      await new Promise<void>((resolve, reject) => provider.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }));
    }
  });

  it.each(['submit', 'steer'])('keeps cold browsing read-only then explicitly resumes for %s through the GUI client', async (firstAction) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    await closeSessionById(fixture.server!.core.accessor, id);
    const client = new KikiClient({ baseUrl: fixture.base, token: bearerToken(fixture.server!) });
    const manager = fixture.server!.core.accessor.get(ISessionManager);
    const acquire = vi.spyOn(manager, 'acquire');
    const entered = promiseGate<void>();
    const release = promiseGate<void>();
    const requests = vi.fn<IAgentLLMRequesterService['start']>(() => ({
      trace: { traceId: 'fixture-cold-action' },
      result: Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text: 'Cold action completed.' }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        providerFinishReason: 'completed',
      }),
    }));
    const listener = manager.onDidCreateSession!((event) => {
      if (event.sessionId !== id) return;
      event.waitUntil((async () => {
        const main = await ensureMainAgent(event.handle);
        vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'start').mockImplementation(requests);
        main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-cold-action', async (ctx) => {
          entered.resolve();
          await release.promise;
          ctx.signal.throwIfAborted();
        }, { before: 'context-injector' });
      })());
    });
    try {
      const view = client.klient.session(id).view;
      const shell = await view.snapshot();
      await view.transcript.page({ agentId: 'main' });
      expect(shell.session.busy).toBe(false);
      expect(acquire).not.toHaveBeenCalled();
      expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeUndefined();
      expect(requests).not.toHaveBeenCalled();
      if (firstAction === 'steer') {
        await expect(client.steerPrompt(id, 'missing-prompt')).rejects.toMatchObject({ code: 40402 });
        expect(getLiveSessionById(fixture.server!.core.accessor, id)).toBeDefined();
        expect(requests).not.toHaveBeenCalled();
      }
      const active = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Start after cold browsing' }] });
      expect(acquire).toHaveBeenCalled();
      const main = await ensureMainAgent(getLiveSessionById(fixture.server!.core.accessor, id)!);
      const prompts = main.accessor.get(IAgentPromptService);
      expect(active.status).toBe('queued');
      await entered.promise;
      await vi.waitFor(() => { expect(prompts.list().active?.id).toBe(active.prompt_id); });
      expect(prompts.list().hold).toBeUndefined();
      expect(prompts.listModelSwitches()).toEqual([]);
      const queued = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Steer this queued prompt' }] });
      expect(queued.status).toBe('queued');
      const steerRequested = vi.spyOn(prompts, 'steer');
      const steering = client.steerPrompt(id, queued.prompt_id);
      await vi.waitFor(() => expect(steerRequested).toHaveBeenCalled());
      expect(requests).not.toHaveBeenCalled();
      release.resolve();
      await expect(steering).resolves.toMatchObject({ steered: true, prompt_ids: [queued.prompt_id] });
      expect(prompts.list().pending).toEqual([]);
      const loop = main.accessor.get(IAgentLoopService);
      await loop.settled();
      expect(loop.status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
      await vi.waitFor(() => {
        for (const promptId of [active.prompt_id, queued.prompt_id]) {
          expect(prompts.lookup(promptId)).toMatchObject({ phase: 'terminal', terminal: { state: 'completed' } });
        }
      });
      const turnId = prompts.lookup(active.prompt_id)?.turnId;
      expect(turnId).toBeDefined();
      expect(prompts.lookup(queued.prompt_id)?.turnId).toBe(turnId);
      expect(requests.mock.calls.map(([input]) => input?.source)).toEqual([
        { type: 'turn', turnId, step: 1 },
        { type: 'turn', turnId, step: 2 },
      ]);
      expect(main.accessor.get(IAgentContextMemoryService).get()).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Start after cold browsing' }] }),
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Steer this queued prompt' }] }),
      ]));
    } finally {
      release.resolve();
      acquire.mockRestore();
      listener.dispose();
      await client.klient.close();
    }
  });

  it.each([undefined, 'stub-alt'])('authenticates the session or requested model rather than an unrelated default: %s', async (model) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(fixture.home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "kimi-unavailable"') + [
      '', '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.kimi-unavailable]', 'provider = "managed:kimi-code"', 'model = "kimi-unavailable"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Use the selected model, not the global default.' }], model,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe(model ?? 'stub');
    main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id);
  });

  it('rejects a credentialless requested model even when the current model is authenticated', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(fixture.home as string, PROMPT_TOML + [
      '', '[providers.credentialless]', 'type = "openai"', 'base_url = "http://127.0.0.1:9"',
      '[models.credentialless]', 'provider = "credentialless"', 'model = "credentialless"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'This model needs its own credential.' }], model: 'credentialless',
    });
    expect(submitted.body.code, submitted.body.msg).toBe(40111);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('stub');
  });

  it('rejects a cross-executor native selection when the projected model has no credential and keeps the binding', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const externalPath = join(fixture.home as string, 'external.md');
    await writeFile(externalPath, '---\nname: external-file\ndescription: External file\nexecutor: grok-acp\nmodel_alias: grok-raw\n---\nEXTERNAL_FILE\n');
    await writeConfigToml(fixture.home as string, PROMPT_TOML + [
      '', '[providers.bare]', 'type = "openai"', 'base_url = "http://127.0.0.1:9"',
      '[models.bare-model]', 'provider = "bare"', 'model = "bare-model"', 'max_context_size = 1000',
      '', '[agent_executor_overrides.native.defaults]', 'model_alias = "bare-model"', '',
    ].join('\n'));
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = main.accessor.get(IAgentProfileService);
    const before = { model: profile.getModel(), executorId: profile.data().executorId, execution: profile.data().execution };
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Use the native engine default, not the external alias.' }],
      execution: { executor: 'native', profile_file: externalPath },
    });
    expect(submitted.body.code, submitted.body.msg).toBe(40111);
    expect(submitted.body.msg).not.toContain('Profile file does not use executor');
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.list().active).toBeUndefined();
    expect(prompt.list().pending).toEqual([]);
    expect(profile.getModel()).toBe(before.model);
    expect(profile.data().executorId).toBe(before.executorId);
    expect(profile.data().execution).toEqual(before.execution);
  });

  it('authorizes a legacy unpinned profile switch with the current model when the native default has no credential', async () => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'legacy-unpinned-switch-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({
        name: 'open-legacy', definitionId: 'fixture:open-legacy', systemPrompt: () => 'OPEN_LEGACY',
      })] },
    });
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = main.accessor.get(IAgentProfileService);
    expect(profile.data().execution).toBeUndefined();
    expect(profile.getModel()).toBe('stub');
    expect(profile.data().executorId ?? 'native').toBe('native');
    await writeConfigToml(fixture.home as string, PROMPT_TOML + [
      '', '[providers.bare]', 'type = "openai"', 'base_url = "http://127.0.0.1:9"',
      '[models.bare-model]', 'provider = "bare"', 'model = "bare-model"', 'max_context_size = 1000',
      '', '[agent_executor_overrides.native.defaults]', 'model_alias = "bare-model"', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Keep the current model.' }],
      execution: { executor: 'native', profile: 'open-legacy' },
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(profile.getModel()).toBe('stub');
    expect(profile.data()).toMatchObject({
      profileName: 'open-legacy', modelAlias: 'stub',
      execution: {
        selection: { executor: 'native', profile: 'open-legacy', overrides: { model: 'stub' } },
        effective: { model: 'stub' }, sources: { model: 'session' },
      },
    });
    expect(main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id)).toBe(true);
  }, 60_000);

  it('keeps the current model across an unpinned profile switch and applies a pin or an explicit clear', async () => {
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'unpinned-switch-fixture', priority: 50,
      contribution: { profiles: [
        normalizeAgentProfile({ name: 'open-role', definitionId: 'fixture:open-role', systemPrompt: () => 'OPEN' }),
        normalizeAgentProfile({ name: 'open-other', definitionId: 'fixture:open-other', systemPrompt: () => 'OTHER' }),
        normalizeAgentProfile({ name: 'pinned-role', definitionId: 'fixture:pinned-role', modelAlias: 'stub-alt', systemPrompt: () => 'PINNED' }),
      ] },
    });
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = () => getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = () => main().accessor.get(IAgentProfileService);
    const submit = async (body: Record<string, unknown>) => {
      const response = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'Switch profile.' }], ...body,
      });
      if (response.body.code === 0) {
        const prompts = main().accessor.get(IAgentPromptService);
        expect(prompts.abort(response.body.data.prompt_id)).toBe(true);
        await vi.waitFor(() => expect(prompts.list().active).toBeUndefined());
      }
      return response;
    };
    const selected = await submit({ execution: { executor: 'native', profile: 'open-role', overrides: { model: 'stub' } } });
    expect(selected.body.code, selected.body.msg).toBe(0);
    expect(profile().data()).toMatchObject({
      profileName: 'open-role', modelAlias: 'stub',
      execution: { effective: { model: 'stub' }, sources: { model: 'session' } },
    });

    await writeConfigToml(fixture.home as string, PROMPT_TOML + [
      '', '[providers.bare]', 'type = "openai"', 'base_url = "http://127.0.0.1:9"',
      '[models.bare-model]', 'provider = "bare"', 'model = "bare-model"', 'max_context_size = 1000',
      '', '[agent_executor_overrides.native.defaults]', 'model_alias = "bare-model"', '',
    ].join('\n'));
    const kept = await submit({ execution: { executor: 'native', profile: 'open-other' } });
    expect(kept.body.code, kept.body.msg).toBe(0);
    expect(profile().getModel()).toBe('stub');
    expect(profile().data().execution).toMatchObject({
      selection: { executor: 'native', profile: 'open-other', overrides: { model: 'stub' } },
      effective: { model: 'stub' }, sources: { model: 'session' },
    });

    const pinned = await submit({ execution: { executor: 'native', profile: 'pinned-role' } });
    expect(pinned.body.code, pinned.body.msg).toBe(0);
    expect(profile().data()).toMatchObject({
      profileName: 'pinned-role', modelAlias: 'stub-alt',
      execution: {
        selection: { executor: 'native', profile: 'pinned-role' },
        effective: { model: 'stub-alt' }, sources: { model: 'profile' },
      },
    });
    expect(profile().data().execution?.selection.overrides?.model).toBeUndefined();

    await writeConfigToml(fixture.home as string, PROMPT_TOML + [
      '', '[agent_executor_overrides.native.defaults]', 'model_alias = "stub"', '',
    ].join('\n'));
    const cleared = await submit({ execution: { executor: 'native', profile: 'open-other', overrides: { model: null } } });
    expect(cleared.body.code, cleared.body.msg).toBe(0);
    expect(profile().data()).toMatchObject({
      profileName: 'open-other', modelAlias: 'stub',
      execution: { effective: { model: 'stub' }, sources: { model: 'harness-settings' } },
    });
    expect(profile().data().execution?.selection.overrides?.model).toBeUndefined();
    expect(profile().getModel()).not.toBe('stub-alt');
  }, 60_000);

  it('binds named and file profiles across native and external through the projected model', async () => {
    const externalPath = join(fixture.home as string, 'external.md');
    const nativePath = join(fixture.home as string, 'native.md');
    await writeFile(externalPath, '---\nname: external-file\ndescription: External file\nexecutor: grok-acp\nmodel_alias: grok-raw\n---\nEXTERNAL_FILE\n');
    await writeFile(nativePath, '---\nname: native-file\ndescription: Native file\nmodel_alias: stub\n---\nNATIVE_FILE\n');
    fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'external-named-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({
        name: 'external-named', definitionId: 'fixture:external-named', executor: 'grok-acp',
        modelAlias: 'grok-raw', systemPrompt: () => 'EXTERNAL_NAMED',
      })] },
    });
    const executors = fixture.server!.core.accessor.get(IAgentExecutorRegistry);
    const resolve = executors.resolveExecutable.bind(executors);
    const held = holdExternalSession();
    const mocked = vi.spyOn(executors, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp'
      ? {
        descriptor: { ...executors.get(executorId)!, command: process.execPath, revision: 'fixture' },
        options: executors.resolve(executorId, options ?? {}).options,
        provider: {
          id: 'fixture-acp', protocol: 'acp-v1',
          validateOptions: (value) => value as Record<string, string | number | boolean>,
          validateBinding: (binding) => ({ ok: true, binding }),
          create: () => held.session as unknown as AgentExecutorSession,
        },
      }
      : resolve(executorId, options));
    const open = async () => {
      const id = await createSession(fixture.home as string);
      await createHeldMainAgent(id);
      return id;
    };
    const profile = (id: string) => getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
    const submit = (id: string, body: Record<string, unknown>) => call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Switch executor.' }], ...body,
    });
    try {
      const namedNativeId = await open();
      const namedNative = await submit(namedNativeId, { execution: { executor: 'native', profile: 'external-named' } });
      expect(namedNative.body.code, namedNative.body.msg).toBe(0);
      expect(profile(namedNativeId).data()).toMatchObject({
        executorId: 'native', modelAlias: 'stub', profileName: 'external-named',
        execution: { selection: { executor: 'native', profile: 'external-named' }, effective: { model: 'stub' }, sources: { model: 'harness-default' } },
      });
      expect(profile(namedNativeId).getModel()).not.toBe('grok-raw');

      const explicitId = await open();
      const explicit = await submit(explicitId, { execution: { executor: 'native', profile_file: externalPath }, model: 'stub-alt' });
      expect(explicit.body.code, explicit.body.msg).toBe(0);
      expect(profile(explicitId).data()).toMatchObject({
        executorId: 'native', modelAlias: 'stub-alt',
        execution: { effective: { model: 'stub-alt' }, sources: { model: 'session' } },
      });

      await writeConfigToml(fixture.home as string, PROMPT_TOML + [
        '', '[agent_executor_overrides.native.defaults]', 'model_alias = "stub-alt"', '',
      ].join('\n'));
      const fileNativeId = await open();
      const fileNative = await submit(fileNativeId, { execution: { executor: 'native', profile_file: externalPath } });
      expect(fileNative.body.code, fileNative.body.msg).toBe(0);
      expect(fileNative.body.msg).not.toContain('Profile file does not use executor');
      expect(profile(fileNativeId).data()).toMatchObject({
        executorId: 'native', modelAlias: 'stub-alt',
        execution: { selection: { executor: 'native' }, effective: { model: 'stub-alt' }, sources: { model: 'harness-settings' } },
      });
      expect(profile(fileNativeId).getModel()).not.toBe('grok-raw');

      const sameGroupId = await open();
      const sameGroup = await submit(sameGroupId, { execution: { executor: 'native', profile_file: nativePath } });
      expect(sameGroup.body.code, sameGroup.body.msg).toBe(0);
      expect(profile(sameGroupId).data()).toMatchObject({
        executorId: 'native', modelAlias: 'stub', profileName: 'native-file',
        execution: { effective: { model: 'stub' }, sources: { model: 'profile' } },
      });

      const fileExternalId = await open();
      const fileExternal = await submit(fileExternalId, { execution: { executor: 'grok-acp', profile_file: nativePath } });
      expect(fileExternal.body.code, fileExternal.body.msg).toBe(0);
      expect(profile(fileExternalId).data()).toMatchObject({
        executorId: 'grok-acp', profileName: 'native-file',
        execution: { selection: { executor: 'grok-acp' }, sources: { model: 'harness-default' } },
      });
      expect(profile(fileExternalId).data().modelAlias).toBeUndefined();

      const namedExternalId = await open();
      const namedExternal = await submit(namedExternalId, { execution: { executor: 'grok-acp', profile: 'agent' } });
      expect(namedExternal.body.code, namedExternal.body.msg).toBe(0);
      expect(profile(namedExternalId).data()).toMatchObject({
        executorId: 'grok-acp', profileName: 'agent',
        execution: { selection: { executor: 'grok-acp', profile: 'agent' }, sources: { model: 'harness-default' } },
      });
      expect(profile(namedExternalId).data().modelAlias).toBeUndefined();

      const sameExternalId = await open();
      const sameExternal = await submit(sameExternalId, { execution: { executor: 'grok-acp', profile_file: externalPath } });
      expect(sameExternal.body.code, sameExternal.body.msg).toBe(0);
      expect(profile(sameExternalId).data()).toMatchObject({
        executorId: 'grok-acp', modelAlias: 'grok-raw', profileName: 'external-file',
        execution: { effective: { model: 'grok-raw' }, sources: { model: 'profile' } },
      });
    } finally {
      held.finish();
      mocked.mockRestore();
    }
  }, 60_000);

  it.each([false, true])('applies prompt-bound plan controls with skills=%s', async (skills) => {
    const id = await createSession(fixture.home as string);
    const boundary = promiseGate<void>();
    await createHeldMainAgent(id, boundary.promise);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const plan = main.accessor.get(IAgentPlanService);
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'plan this work' }],
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
      plan_mode: true, 
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('running');
    expect(await plan.status()).not.toBeNull();
    const prompt = main.accessor.get(IAgentPromptService);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'execute later' }], plan_mode: false, 
    });
    expect(queued.body.data.status).toBe('queued');
    expect(await plan.status()).not.toBeNull();
    const steerRequested = vi.spyOn(prompt, 'steer');
    const steering = call('POST', `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:steer`);
    await vi.waitFor(() => expect(steerRequested).toHaveBeenCalled());
    boundary.resolve();
    const steer = await steering;
    expect(steer.body.code).toBe(40001);
    prompt.abort(submitted.body.data.prompt_id);
    await vi.waitFor(async () => {
      expect(await plan.status()).toBeNull();
    });
  });

  it.each([true, false])('allows Send now for the actual GUI mode and same-objective echo: %s', async (enabled) => {
    const id = await createSession(fixture.home as string);
    const boundary = promiseGate<void>();
    await createHeldMainAgent(id, boundary.promise);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    await goal.createGoal({ objective: 'same objective' });
    await goal.pauseGoal({});
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active mode' }], plan_mode: enabled, 
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const followUp = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'ordinary follow-up' }], permission_mode: 'manual',
      plan_mode: enabled, goal_objective: 'same objective',
    });
    expect(followUp.body.code, followUp.body.msg).toBe(0);
    expect(followUp.body.data.status).toBe('queued');
    const steerRequested = vi.spyOn(main.accessor.get(IAgentPromptService), 'steer');
    const steering = call('POST', `/api/sessions/${id}/prompts/${followUp.body.data.prompt_id}:steer`);
    await vi.waitFor(() => expect(steerRequested).toHaveBeenCalled());
    boundary.resolve();
    const sentNow = await steering;
    expect(sentNow.body.code, sentNow.body.msg).toBe(0);
    expect(main.accessor.get(IAgentPromptService).list().pending).toHaveLength(0);
    expect((await main.accessor.get(IAgentPlanService).status()) !== null).toBe(enabled);
    expect(goal.getGoal().goal?.status).toBe('paused');
  });

  it.each(['pause', 'resume', 'cancel'] as const)('applies prompt-bound goal %s without autonomous resume', async (control) => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    const initial = await goal.createGoal({ objective: 'finish the example' });
    if (control === 'resume') await goal.pauseGoal({});
    const resume = vi.spyOn(goal, 'resumeGoal');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'user directed step' }],
      goal_objective: 'finish the example', goal_control: control,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('running');
    if (control === 'cancel') expect(goal.getGoal().goal).toBeNull();
    else {
      expect(goal.getGoal().goal).toMatchObject({ goalId: initial.goalId, status: control === 'pause' ? 'paused' : 'active' });
      if (control === 'resume') {
        expect(resume).toHaveBeenCalledWith({});
        await goal.pauseGoal({});
      }
    }
    main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id);
    resume.mockRestore();
  });

  it('creates a goal from the prompt and does not recreate it on repeated submissions', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    const prompt = main.accessor.get(IAgentPromptService);
    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'begin' }], goal_objective: 'finish the example', goal_control: 'pause',
    });
    expect(first.body.code, first.body.msg).toBe(0);
    const goalId = goal.getGoal().goal!.goalId;
    const later = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'next' }], goal_objective: 'finish the example',
    });
    expect(later.body.code).toBe(0);
    prompt.abort(first.body.data.prompt_id);
    await vi.waitFor(() => expect(prompt.list().active?.id).toBe(later.body.data.prompt_id));
    expect(goal.getGoal().goal).toMatchObject({ goalId, status: 'paused' });
  });

  it('keeps cancelled queued controls and duplicate submissions free of runtime side effects', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const goal = main.accessor.get(IAgentGoalService);
    await goal.createGoal({ objective: 'existing goal' });
    await goal.pauseGoal({});
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      prompt_id: 'stable-active', content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code).toBe(0);
    const duplicate = await call('POST', `/api/sessions/${id}/prompts`, {
      prompt_id: 'stable-active', content: [{ type: 'text', text: 'duplicate' }],
      plan_mode: true, goal_control: 'cancel',
    });
    expect(duplicate.body.code).toBe(40938);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'cancel me' }],
      plan_mode: true, goal_control: 'cancel',
    });
    expect(queued.body.code).toBe(0);
    expect(queued.body.data.status).toBe('queued');
    prompt.abort(queued.body.data.prompt_id);
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(goal.getGoal().goal).toMatchObject({ objective: 'existing goal', status: 'paused' });
  });

  it('rejects invalid goal controls before permission and plan side effects', async () => {
    const id = await createSession(fixture.home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(fixture.server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const mode = main.accessor.get(IAgentPermissionModeService).mode;
    for (const invalid of [{ goal_objective: '   ' }, { goal_objective: 'a'.repeat(4001) }, { goal_control: 'resume' }]) {
      const result = await call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'invalid' }], ...invalid,
        permission_mode: 'yolo', plan_mode: true, 
      });
      expect(result.body.code, result.body.msg).toBe(40001);
    }
    expect(main.accessor.get(IAgentPermissionModeService).mode).toBe(mode);
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
  });

  it('rejects child-agent runtime controls rather than ignoring them', async () => {
    const id = await createSession(fixture.home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(fixture.server!.core.accessor, id)!;
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');
    for (const control of [{ plan_mode: true }, { goal_objective: 'child goal' }, { goal_control: 'pause' }]) {
      const result = await call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'not supported' }], agent_id: child.id, ...control,
      });
      expect(result.body.code, result.body.msg).toBe(40001);
    }
  });
});

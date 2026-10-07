import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { paddedPng, pngDimensions, solidPng } from './helpers/png';

import {
  IAgentTitlePromptSource,
  IAgentGoalService,
  IAgentLoopService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentExecutorRegistry,
  type AgentExecutorProvider,
  type ProfileBindingSnapshot,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentTaskService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentToolPolicyService,
  IEventBus,
  IEventDispatcher,
  IBootstrapService,
  PromptEnqueued,
  PromptRetryCommitted,
  IWireService,
  IFileService,
  IModelCatalogMutationService,
  IConfigService,
  ISessionIndex,
  ISessionContext,
  ISessionMetadata,
  ISessionDispatchService,
  ISessionManager,
  ensureMainAgent,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createMemoryKlient } from '@kiki/klient/memory';
import { createKlient as createHttpKlient } from '@kiki/klient/http';
import { TaskNotificationStepRequest } from '@kiki/agent-core-v2/agent/task/taskService';
import { createHooks } from '@kiki/agent-core-v2/hooks';
import { KikiClient } from '../../../apps/kiki-gui/src/lib/client';
import { buildNewSessionCreate } from '../../../apps/kiki-gui/src/components/NewSessionDraft';
import { resolveProfileSwitchSubmission, resolveControlledSkillSubmission } from '../../../apps/kiki-gui/src/components/SessionView';
import { executionChoice } from '../../session-core/src/composer/executionSelection';
import { SessionController } from '../../session-core/src/session/sessionController';
import { applyCompactionProgress, type CompactionProgress } from '../../../apps/kiki-gui/src/components/useCompactionProgress';
import { compactSessionContext } from '../../session-core/src/commands/sessionActions';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '@kiki/agent-core-v2/agent/llmRequester/llmRequester';
import { IAgentFullCompactionService } from '@kiki/agent-core-v2/agent/fullCompaction/fullCompaction';
import { agentTranscriptToBlocks, createViewState, isOrdinaryQueueItem, projectAgentTranscriptView, queuedPromptPreviews } from '../../session-core/src/session/transcript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import {
  PROMPT_BODY_LIMIT_BYTES,
  projectPromptSnapshot,
  watchPromptSettlements,
} from '../src/routes/prompts';
import { modelSwitchActionSchema } from '../src/protocol/rest-model-switch';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders, bearerToken } from './helpers/auth';

vi.mock('../../../apps/kiki-gui/src/components/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../apps/kiki-gui/src/components/preview/DocumentTabView', () => ({ DocumentTabView: () => null }));

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface PromptItemWire {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
  origin?: unknown;
  content: unknown;
  created_at: string;
}

type PromptContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { kind: 'base64'; media_type: string; data: string };
    };

const PROMPT_TOML = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  'capabilities = ["thinking"]',
  'support_efforts = ["low", "high"]',
  'default_effort = "high"',
  '',
  '[models.stub-alt]',
  'provider = "stub"',
  'model = "stub-alt"',
  'max_context_size = 1000',
  'capabilities = ["thinking"]',
  'support_efforts = ["low", "high"]',
  'default_effort = "high"',
  '',
  '[search]',
  'enabled = false',
  '',
  '[cron]',
  'manualTick = true',
  '',
].join('\n');

async function readFileEventually(path: string): Promise<Buffer> {
  return vi.waitFor(() => readFile(path));
}

function sessionMediaDir(server: RunningServer, sessionId: string): string {
  const session = getLiveSessionById(server.core.accessor, sessionId);
  return join(session!.accessor.get(ISessionContext).sessionDir, 'media');
}

async function expectSessionMedia(
  server: RunningServer,
  sessionId: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const path = join(sessionMediaDir(server, sessionId), name);
  expect(await readFileEventually(path)).toEqual(bytes);
  return path;
}

let configTomlSeq = 0;

async function writeConfigToml(dir: string, content: string): Promise<void> {
  configTomlSeq += 1;
  const tmpPath = join(dir, `config.toml.${process.pid}.${configTomlSeq}.tmp`);
  const configPath = join(dir, 'config.toml');
  await writeFile(tmpPath, content, 'utf-8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, configPath);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 40) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe('server-v2 /api prompts', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-prompts-'));
    await mkdir(join(home, '.git'));
    await writeConfigToml(home, PROMPT_TOML);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    arg?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers = authHeaders(
      server as RunningServer,
      arg === undefined ? {} : { 'content-type': 'application/json' },
    );
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (arg !== undefined) {
      init.body = JSON.stringify(arg);
    }
    const res = await fetch(`${base}${path}`, init as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string, pinPermissionMode = true): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        metadata: { cwd },
        ...(pinPermissionMode ? { agent_config: { permission_mode: 'manual' } } : {}),
      }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
  }

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
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      let expectedModel = 'stub';
      if (source === 'onboarding-provider' || source === 'onboarding-welcome-skill') {
        await writeConfigToml(home!, PROMPT_TOML.replace('default_model = "stub"', ''));
        await server!.core.accessor.get(IConfigService).reload();
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
          await writeConfigToml(home!, (await readFile(join(home!, 'config.toml'), 'utf8')).replace('default_model = "stub"', ''));
          await mkdir(join(home!, 'agents'), { recursive: true });
          await writeFile(join(home!, 'agents', 'agent.md'), '---\nname: agent\ndescription: Fixture main profile\nmodel_alias: stub\nthinking_effort: high\n---\nHelp the user.\n');
        }
      }
      if (source === 'welcome-selected-model') {
        await writeConfigToml(home!, (await readFile(join(home!, 'config.toml'), 'utf8')).replace('default_model = "stub"', ''));
        await server!.core.accessor.get(IConfigService).reload();
      }
      const created = await call<{ id: string; agent_config: { model?: string } }>('POST', '/api/sessions', {});
      expect(created.body.code).toBe(0);
      const session = getLiveSessionById(server!.core.accessor, created.body.data.id)!;
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

  it('rejects a welcome first message without a model before enqueue and accepts the preserved prompt after model selection', async () => {
    await writeConfigToml(home!, PROMPT_TOML.replace('default_model = "stub"', ''));
    const created = await call<{ id: string }>('POST', '/api/sessions', {});
    expect(created.body.code, created.body.msg).toBe(0);
    const session = getLiveSessionById(server!.core.accessor, created.body.data.id)!;
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
    const registry = server!.core.accessor.get(IAgentExecutorRegistry);
    vi.spyOn(registry, 'resolveExecutable').mockResolvedValue({ descriptor: {
      id: 'example-acp', protocol: 'acp-v1', command: 'fixture', args: [], revision: 'fixture',
    }, options: {}, provider });
    vi.spyOn(registry, 'validateBinding').mockImplementation((_id, _options, binding) => ({ ok: true, binding }));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new KikiClient({ baseUrl: base, token: bearerToken(server!), transport: {
      eventsUrl: `${base.replace(/^http/, 'ws')}/api/klient/events`,
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
      const created = await client.createSession(buildNewSessionCreate({ cwd: home!, profile: 'agent', execution: chosen,
        model: 'stub', thinking: 'low', modelTouched: true, effortTouched: true,
        permissionMode: 'manual', permissionTouched: false, planMode: false }));
      const id = created.id;
      expect(requests.find((request) => request.path === '/api/sessions')?.body['agent_config']).toEqual({
        execution: chosen, plan_mode: false,
      });
      controller = new SessionController(client.sessions, client.klient.session(id).view, id);
      const session = getLiveSessionById(server!.core.accessor, id)!;
      const main = await ensureMainAgent(session);
      const profile = main.accessor.get(IAgentProfileService);
      const before = structuredClone(profile.data().execution!);
      expect(before).toMatchObject({ selection: { executor: 'example-acp' }, effective: { model: 'vendor-model', thinking: 'high' },
        sources: { kiki_context: 'harness-settings', allow_kiki_subagents: 'harness-settings', permission_mode: 'harness-default' } });
      expect(before.selection.profile).toBeUndefined();
      expect(before.effective.permission_mode).toBeUndefined();
      const first = await controller.sendPrompt({ promptId: 'direct-first', text: 'FIRST_USER' });
      expect(first.status).toBe('running');
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
      await main.accessor.get(IAgentExecutionService).settled();
      expect(profile.data().execution).toEqual(after);
      expect(bindings).toHaveLength(2);
      expect(runs).toEqual([{ generation: before.generation, prompt: 'FIRST_USER' },
        { generation: after.generation, prompt: 'NEXT_USER' }, { generation: after.generation, prompt: 'INHERIT_USER' }]);
      const warm = await client.getSession(id);
      expect(warm.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      await closeSessionById(server!.core.accessor, id);
      const cold = await client.getSession(id);
      expect(cold.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      const coldProfile = await call<{ agent_config: { execution: unknown } }>('GET', `/api/sessions/${id}/profile`);
      expect(coldProfile.body.data.agent_config.execution).toEqual(JSON.parse(JSON.stringify(after)));
      expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
    } finally { release(); controller?.close(); await client.klient.close(); }
  });

  it('queues a GUI manual compaction over HTTP and publishes manual execution and completion after a held request', async () => {
    await server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 256000 });
    const id = await createSession(home as string);
    await createMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'high' });
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
    const client = new KikiClient({ baseUrl: base, token: bearerToken(server!) });
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

  async function createHeldMainAgent(sessionId: string): Promise<void> {
    await createMainAgent(sessionId);
    const main = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
    main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-test-turn', async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
  }

  it('round-trips scheduled delivery modes over HTTP and projects fired queue text with its origin', async () => {
    const sessionId = await createSession(home!);
    await createHeldMainAgent(sessionId);
    const main = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    const provider = vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'request');
    const client = createHttpKlient({ endpoint: base, token: bearerToken(server!) });
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

  async function createHeldChild(sessionId: string) {
    await createMainAgent(sessionId);
    const lifecycle = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-retry-child-turn', async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    return child;
  }

  it('validates recover mode only for retry actions', () => {
    expect(modelSwitchActionSchema.parse({ action: 'retry', mode: 'fresh' })).toEqual({ action: 'retry', mode: 'fresh' });
    expect(modelSwitchActionSchema.parse({ action: 'keep_original' })).toEqual({ action: 'keep_original' });
    expect(modelSwitchActionSchema.parse({ action: 'cancel' })).toEqual({ action: 'cancel' });
    expect(modelSwitchActionSchema.safeParse({ action: 'keep_original', mode: 'fresh' }).success).toBe(false);
    expect(modelSwitchActionSchema.safeParse({ action: 'cancel', mode: 'fresh' }).success).toBe(false);
  });

  it.each(['model', 'effort'] as const)('GUI client Send now applies a pending %s at the first safe HTTP request boundary', async change => {
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
    const client = new KikiClient({ baseUrl: base, token: bearerToken(server!) });
    try {
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      for (const model of ['stub', 'stub-alt']) await mutations.updateModel(model, { max_context_size: 100000 });
      await server!.core.accessor.get(ISessionIndex).prepare();
      const id = await createSession(home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub', thinking: 'low' });
      await client.submitPrompt(id, { prompt_id: 'safe-http-active', content: [{ type: 'text', text: 'Work already in progress.' }] });
      await firstRequest;
      const selected = await client.klient.session(id).agent('main').switchModel({ operationId: 'safe-http-choice', model: change === 'model' ? 'stub-alt' : 'stub', thinking: 'high', mode: 'direct' });
      expect(selected.state).toBe('pending');
      const dependent = await client.submitPrompt(id, { prompt_id: 'safe-http-original', after_model_switch: 'safe-http-choice', content: [{ type: 'text', text: 'Unique original GUI question after selection.' }] });
      expect(dependent.status).toBe('queued');
      await client.steerPrompt(id, dependent.prompt_id);
      expect(bodies).toHaveLength(1);
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({ modelAlias: 'stub', thinkingLevel: 'low' });
      release();
      await main.accessor.get(IAgentLoopService).settled();
      expect(bodies).toHaveLength(2);
      expect(bodies.map(body => body['model'])).toEqual(['stub', change === 'model' ? 'stub-alt' : 'stub']);
      expect(bodies.map(body => body['reasoning_effort'])).toEqual(['low', 'high']);
      expect(JSON.stringify(bodies[1])).toContain('Unique original GUI question after selection.');
      const journal = [];
      for await (const record of main.accessor.get(IWireService).readJournal()) journal.push(record);
      expect(journal.filter(record => record.type === 'turn.steer' && record['promptId'] === 'safe-http-original')).toHaveLength(1);
      expect(journal.filter(record => record.type === 'agent.model_switch')).toHaveLength(1);
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
    const klient = createHttpKlient({ endpoint: base, token: server!.localOwnerToken });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${address.port}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      await mutations.updateModel('stub-alt', { max_context_size: 100000 });
      const id = await createSession(home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
      expect(liveMarkers[0]).toMatchObject({ payload: { operationId: 'http-switch', mode: 'direct', state: 'completed' } });
      subscription.dispose();
      await closeSessionById(server!.core.accessor, id);
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
    const client = new KikiClient({ baseUrl: base, token: bearerToken(server!) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(home as string);
      await createMainAgent(id);
      const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const loop = main.accessor.get(IAgentLoopService);
      loop.hooks.onWillBeginStep.register('hold-send-now-delivery', async ({ step, signal }) => {
        if (step === 1) await gate;
        signal.throwIfAborted();
      }, { before: 'context-injector' });
      const active = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Start the turn.' }], profile: 'agent', model: 'stub' });
      const queued = await client.submitPrompt(id, { prompt_id: 'queued-send-now', content: [{ type: 'text', text: 'Check the queued message.' }] });
      expect(queued.status).toBe('queued');
      await client.steerPrompt(id, queued.prompt_id);
      expect(main.accessor.get(IAgentPromptService).list().pending).toHaveLength(0);
      const beforeDelivery = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(agentTranscriptToBlocks(beforeDelivery).filter((block) => block.kind === 'user' && block.text === 'Check the queued message.')).toHaveLength(0);
      release();
      await loop.settled();
      const context = main.accessor.get(IAgentContextMemoryService).get();
      expect(context).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: queued.prompt_id, role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Check the queued message.' }] }),
      ]));
      const live = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      const rows = agentTranscriptToBlocks(live).filter((block) => block.kind === 'user' && block.text === 'Check the queued message.');
      expect(rows).toEqual([expect.objectContaining({ id: `user-${queued.prompt_id}`, userMessageId: queued.prompt_id, turnId: expect.any(String) })]);
      expect(active.status).toBe('running');
      const turns = live.items.filter((item) => item.kind === 'turn');
      expect(turns).toHaveLength(1);
      expect(rows[0]?.kind === 'user' ? rows[0].turnId : undefined).toBe(turns[0]?.turnId);
      await closeSessionById(server!.core.accessor, id);
      const cold = await client.klient.session(id).view.transcript.page({ agentId: 'main' });
      expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    await closeSessionById(server!.core.accessor, id);
    const client = new KikiClient({ baseUrl: base, token: bearerToken(server!) });
    const listener = server!.core.accessor.get(ISessionManager).onDidCreateSession!((event) => {
      if (event.sessionId !== id) return;
      event.waitUntil((async () => {
        const main = await ensureMainAgent(event.handle);
        main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-cold-action', async (ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          ctx.signal.throwIfAborted();
        }, { before: 'context-injector' });
      })());
    });
    try {
      const view = client.klient.session(id).view;
      const shell = await view.snapshot();
      await view.transcript.page({ agentId: 'main' });
      expect(shell.session.busy).toBe(false);
      expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
      if (firstAction === 'steer') {
        await expect(client.steerPrompt(id, 'missing-prompt')).rejects.toMatchObject({ code: 40402 });
        expect(getLiveSessionById(server!.core.accessor, id)).toBeDefined();
      }
      const active = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Start after cold browsing' }] });
      expect(getLiveSessionById(server!.core.accessor, id)).toBeDefined();
      expect(active.status).toBe('running');
      const queued = await client.submitPrompt(id, { content: [{ type: 'text', text: 'Steer this queued prompt' }] });
      expect(queued.status).toBe('queued');
      await expect(client.steerPrompt(id, queued.prompt_id)).resolves.toMatchObject({ steered: true, prompt_ids: [queued.prompt_id] });
      await client.abortPrompt(id, active.prompt_id);
    } finally {
      listener.dispose();
      await client.klient.close();
    }
  });

  it.each([undefined, 'stub-alt'])('authenticates the session or requested model rather than an unrelated default: %s', async (model) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "kimi-unavailable"') + [
      '', '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.kimi-unavailable]', 'provider = "managed:kimi-code"', 'model = "kimi-unavailable"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Use the selected model, not the global default.' }], model,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe(model ?? 'stub');
    main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id);
  });

  it('rejects a credentialless requested model even when the current model is authenticated', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(home as string, PROMPT_TOML + [
      '', '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.kimi-unavailable]', 'provider = "managed:kimi-code"', 'model = "kimi-unavailable"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'This model needs its own credential.' }], model: 'kimi-unavailable',
    });
    expect(submitted.body.code, submitted.body.msg).toBe(40111);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('stub');
  });

  it.each([false, true])('applies prompt-bound plan controls with skills=%s', async (skills) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const steer = await call('POST', `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:steer`);
    expect(steer.body.code).toBe(40001);
    prompt.abort(submitted.body.data.prompt_id);
    await vi.waitFor(async () => {
      expect(await plan.status()).toBeNull();
    });
  });

  it.each([true, false])('allows Send now for the actual GUI mode and same-objective echo: %s', async (enabled) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const sentNow = await call('POST', `/api/sessions/${id}/prompts/${followUp.body.data.prompt_id}:steer`);
    expect(sentNow.body.code, sentNow.body.msg).toBe(0);
    expect(main.accessor.get(IAgentPromptService).list().pending).toHaveLength(0);
    expect((await main.accessor.get(IAgentPlanService).status()) !== null).toBe(enabled);
    expect(goal.getGoal().goal?.status).toBe('paused');
  });

  it.each(['pause', 'resume', 'cancel'] as const)('applies prompt-bound goal %s without autonomous resume', async (control) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');
    for (const control of [{ plan_mode: true }, { goal_objective: 'child goal' }, { goal_control: 'pause' }]) {
      const result = await call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'not supported' }], agent_id: child.id, ...control,
      });
      expect(result.body.code, result.body.msg).toBe(40001);
    }
  });

  it.each([false, true])('does not apply runtime controls when the submit hook blocks, skills=%s', async (skills) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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

  it('submits a prompt and lists it as active', async () => {
    const id = await createSession(home as string);
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    await closeSessionById(server!.core.accessor, id);
    await resumeSessionById(server!.core.accessor, id);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'plan with approval' }],
      plan_gate: 'gated',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(main!.accessor.get(IAgentPlanService).planGate).toBe('gated');
  });

  it('defers a busy session’s submitted permission and plan gate until that prompt starts', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
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
    await getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain(new Error('test cleanup'));
  });

  it('rejects Send now when a queued model or thinking selection differs from the active turn', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);

    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
      model: 'stub',
      thinking: 'low',
    });
    expect(active.body.code).toBe(0);
    expect(active.body.data.status).toBe('running');

    const session = getLiveSessionById(server!.core.accessor, id);
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
    expect(steered.body.code).toBe(40001);
    expect(profile.data()).toEqual(activeBinding);
    expect(prompt.list().pending.map((item) => item.id)).toContain(queued.body.data.prompt_id);
    prompt.abort(queued.body.data.prompt_id);
    prompt.abort(active.body.data.prompt_id);
  });

  it('submits a bundled skill prompt through the skills field', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'kiki-ops' }, { name: 'kiki-profile' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(['running', 'queued']).toContain(submitted.body.data.status);
    expect(submitted.body.data.content).toEqual([{ type: 'text', text: 'Review this change.' }]);

    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
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
    await getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain(new Error('test cleanup'));
  });

  it('honors a client-chosen prompt_id on submit', async () => {
    const id = await createSession(home as string);
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
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

    const session = getLiveSessionById(server!.core.accessor, id);
    expect((await session!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const afterResume = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not survive a cold resume' }],
      prompt_id: 'submission-1',
    });
    expect(afterResume.body.code).toBe(40938);
    const resumed = getLiveSessionById(server!.core.accessor, id);
    expect((await resumed!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');
  });

  it('replays one accepted native child prompt after losing the HTTP response and rejects a changed payload', async () => {
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = {
      agent_id: child.id, prompt_id: 'native-child-retry', content: [{ type: 'text', text: 'one child run' }],
    };
    const first = await fetch(`${base}/api/sessions/${id}/prompts`, {
      method: 'POST', headers: authHeaders(server!, { 'content-type': 'application/json' }), body: JSON.stringify(payload),
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
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
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
    const steered = await call('POST', `/api/sessions/${id}/prompts/child-send-now:steer?agent_id=${child.id}`);
    expect(steered.body.code, steered.body.msg).toBe(0);
    expect(prompt.list().pending).toHaveLength(0);
    prompt.abort(active.body.data.prompt_id);
  });

  it('scopes native child prompt retry keys to their target within a session', async () => {
    const id = await createSession(home as string);
    const firstChild = await createHeldChild(id);
    const lifecycle = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService);
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
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const payload = { agent_id: child.id, prompt_id: 'native-child-rejected', content: [{ type: 'text', text: 'try again' }] };
    const rejected = await call<null>('POST', `/api/sessions/${id}/prompts`, { ...payload, model: 'not-configured' });
    expect(rejected.body.code).not.toBe(0);
    const accepted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    child.accessor.get(IAgentPromptService).abort(payload.prompt_id);
  });

  it('fails closed when a child prompt was accepted but its retry receipt did not commit', async () => {
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const dispatcher = child.accessor.get(IEventDispatcher);
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    let failOnce = true;
    vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (event) => {
      if (event instanceof PromptRetryCommitted && failOnce) {
        failOnce = false;
        throw new Error('receipt persist failed');
      }
      return dispatch(event);
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = { agent_id: child.id, prompt_id: 'native-child-uncommitted', content: [{ type: 'text', text: 'ambiguous' }] };
    const first = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(first.body.code).not.toBe(0);
    const retry = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code).toBe(40938);
    expect(retry.body.msg).toContain('accepted without a replayable receipt');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not replay an unflushed child receipt as if it were durably accepted', async () => {
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const wire = child.accessor.get(IWireService);
    const flush = wire.flush.bind(wire);
    let calls = 0;
    vi.spyOn(wire, 'flush').mockImplementation(async () => {
      if (++calls >= 2) throw new Error('storage flush failed');
      return flush();
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = { agent_id: child.id, prompt_id: 'native-child-unflushed', content: [{ type: 'text', text: 'needs durability' }] };
    const first = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(first.body.code).not.toBe(0);
    const retry = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(retry.body.code).not.toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('never admits two simultaneous native child submissions of one key', async () => {
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const dispatch = session.accessor.get(ISessionDispatchService);
    const recordRun = dispatch.recordRun.bind(dispatch);
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(dispatch, 'recordRun').mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return recordRun(...args);
    });
    const prompt = child.accessor.get(IAgentPromptService);
    const enqueue = vi.spyOn(prompt, 'enqueue');
    const payload = { agent_id: child.id, prompt_id: 'native-child-flight', content: [{ type: 'text', text: 'only one' }] };
    const first = call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    await entering;
    const concurrent = await call<null>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(concurrent.body.code).toBe(40938);
    release();
    const accepted = await first;
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const replay = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(replay.body.code).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    prompt.abort(payload.prompt_id);
  });

  it('replays an accepted native child receipt after server restart without re-enqueueing', async () => {
    const id = await createSession(home as string);
    const child = await createHeldChild(id);
    const payload = { agent_id: child.id, prompt_id: 'native-child-restart', content: [{ type: 'text', text: 'restart once' }] };
    const accepted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, payload);
    expect(accepted.body.code, accepted.body.msg).toBe(0);
    child.accessor.get(IAgentPromptService).abort(payload.prompt_id);
    await server!.close();
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home!, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const resumed = await resumeSessionById(server.core.accessor, id);
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill before any control override binds', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      plan_gate: 'gated',
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(agent!.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
    expect(agent!.accessor.get(IAgentPlanService).planGate).toBe('free');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill without materializing the main agent', async () => {
    const id = await createSession(home as string, false);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('accepts a bundled prompt_id and replays the matching receipt without another model request', async () => {
    await server!.core.accessor.get(IModelCatalogMutationService).updateModel('stub', { max_context_size: 100000 });
    const id = await createSession(home as string, false);
    await createMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    hold.dispose();
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const prompts = ['先搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];
    for (const text of prompts) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code).toBe(0);
    }

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session?.accessor.get(IAgentLifecycleService).get('main');
    const source = agent?.accessor.get(IAgentTitlePromptSource);
    expect(source).toBeDefined();
    await expect(source!.firstUserPrompts(3)).resolves.toEqual(prompts);
  });

  it('rejects a stale file reference without creating the agent or mutating the model', async () => {
    const id = await createSession(home as string, false);
    const session = getLiveSessionById(server!.core.accessor, id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'look' },
        { type: 'video', source: { kind: 'file', file_id: 'f_does_not_exist' } },
      ],
    });
    expect(body.code).toBe(40407);

    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a mis-kinded file reference without creating the agent', async () => {
    const id = await createSession(home as string, false);
    const session = getLiveSessionById(server!.core.accessor, id);

    const form = new FormData();
    form.set('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'spec.pdf');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'watch this' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(body.code).toBe(40001);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('carries an uploaded video into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const form = new FormData();
    form.set('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'what happens in this video?' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'session_media', file_id: uploaded.data.id },
      name: 'clip.mp4',
    });

    await expectSessionMedia(server!, id, `${uploaded.data.id}.mp4`, videoBytes);
  });

  it('carries a compressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);
    const uploaded = await uploadFile(bigPng, 'image/png', 'big.png');
    expect(uploaded.size).toBe(bigPng.length);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    const caption = content[0] as { type: string; text: string };
    expect(caption.type).toBe('text');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('3600x1800');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1] as { type: string; source: { kind: string; file_id: string } };
    expect(image.type).toBe('image');
    expect(image.source.kind).toBe('session_media');
    const finalFileId = image.source.file_id;
    expect(finalFileId).not.toBe(uploaded.id);

    const mediaPath = join(sessionMediaDir(server!, id), `${finalFileId}.png`);
    expect(pngDimensions(await readFileEventually(mediaPath))).toEqual({ width: 2000, height: 1000 });
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    const original = await server!.core.accessor.get(IFileService).get(uploaded.id);
    expect(original.meta.size).toBe(bigPng.length);

    const files = server!.core.accessor.get(IFileService);
    await vi.waitFor(async () => {
      const result = await files.get(finalFileId).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: 'file.not_found' });
    });

    expect(JSON.stringify(content)).not.toContain('kimi-file://');

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService).get();
    const reminder = memory.find((m) => m.origin?.kind === 'injection');
    const reminderText = reminder?.content[0];
    expect(reminderText?.type).toBe('text');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('<system-reminder>');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('Image compressed');
  });

  it('rolls back a compressed upload when a later prompt part fails to resolve', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const first = await uploadFile(solidPng(3600, 1800), 'image/png', 'big.png');
    const second = await uploadFile(solidPng(10, 10), 'image/png', 'small.png');
    const files = server!.core.accessor.get(IFileService);
    const originalGet = files.get.bind(files);
    const originalSave = files.save.bind(files);
    let secondGets = 0;
    let compressedFileId: string | undefined;
    const getSpy = vi.spyOn(files, 'get').mockImplementation(async (fileId) => {
      if (fileId === second.id && ++secondGets === 2) {
        throw new Error('injected second-part failure');
      }
      return originalGet(fileId);
    });
    const saveSpy = vi.spyOn(files, 'save').mockImplementation(async (...args) => {
      const saved = await originalSave(...args);
      compressedFileId = saved.id;
      return saved;
    });

    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [
          { type: 'image', source: { kind: 'file', file_id: first.id } },
          { type: 'image', source: { kind: 'file', file_id: second.id } },
        ],
      });

      expect(submitted.body.code).not.toBe(0);
      expect(compressedFileId).toBeDefined();
      if (compressedFileId === undefined) throw new Error('expected a compressed upload');
      await expect(originalGet(compressedFileId)).rejects.toMatchObject({
        code: 'file.not_found',
      });
    } finally {
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  it('carries an uncompressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const mediaPath = await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    expect(JSON.stringify(content)).not.toContain('kimi-file://');
  });

  it('resolves a queued uploaded image to a data URL when its provider turn starts', async () => {
    const requests: unknown[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider = createHttpServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        if (body.length === 0) return;
        requests.push(JSON.parse(body) as unknown);
        if (requests.length === 1) await firstGate;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: `chatcmpl-${String(requests.length)}`,
            choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
        );
      })();
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');

    try {
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      for (const model of ['stub', 'stub-alt']) {
        await mutations.updateModel(model, { max_context_size: 100000, capabilities: ['thinking', 'image_in'] });
      }
      const id = await createSession(home as string);
      const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'active turn' }],
        model: 'stub',
      });
      expect(active.body.data.status).toBe('running');
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 });

      const image = solidPng(10, 10);
      const uploaded = await uploadFile(image, 'image/png', 'queued.png');
      const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(queued.body.data.status).toBe('queued');
      await expect(server!.core.accessor.get(IFileService).get(uploaded.id)).resolves.toBeDefined();

      releaseFirst();
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 });
      expect(JSON.stringify(requests[1])).toContain(
        `data:image/png;base64,${image.toString('base64')}`,
      );
    } finally {
      releaseFirst();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it('accepts a stored session-media reference after the transient upload is deleted', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(first.body.code).toBe(0);
    await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    await server!.core.accessor.get(IFileService).delete(uploaded.id);

    const replayed = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'replay the stored image' },
        { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
      ],
    });

    expect(replayed.body.code).toBe(0);
    expect(replayed.body.data.content).toEqual([
      { type: 'text', text: 'replay the stored image' },
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const replayedMessage = main.accessor
        .get(IAgentContextMemoryService)
        .get()
        .find(
          (message) =>
            message.role === 'user' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'replay the stored image',
            ),
        );
      expect(replayedMessage).toBeDefined();
      expect(replayedMessage!.content).toContainEqual({
        type: 'image_url',
        imageUrl: {
          url: `kimi-file://${uploaded.id}`,
          id: uploaded.id,
          name: 'small.png',
        },
      });
    });
  });

  it('keeps the upload-backed reference when the session media dir is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const mediaDir = sessionMediaDir(server!, id);
    await mkdir(mediaDir, { recursive: true });
    await chmod(mediaDir, 0o555);
    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(submitted.body.code).toBe(0);

      const session = getLiveSessionById(server!.core.accessor, id);
      const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
      await vi.waitFor(() => {
        const message = main.accessor
          .get(IAgentContextMemoryService)
          .get()
          .find((m) => m.role === 'user' && m.content.some((part) => part.type === 'image_url'));
        expect(message).toBeDefined();
        expect(message!.content).toContainEqual({
          type: 'image_url',
          imageUrl: { url: `kimi-file://${uploaded.id}`, name: 'small.png' },
        });
      });

      const cacheDir = server!.core.accessor.get(IBootstrapService).cacheDir;
      await expect(readFile(join(cacheDir, `${uploaded.id}.png`))).rejects.toThrow();
    } finally {
      await chmod(mediaDir, 0o755);
    }
  });

  it('accepts three inline images whose JSON exceeds Fastify default bodyLimit and keeps all attachments', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const images = [1, 2, 3].map((marker) => paddedPng(300 * 1024, marker));
    const content = images.map((image) => ({
      type: 'image' as const,
      source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') },
    }));
    expect(Buffer.byteLength(JSON.stringify({ content }), 'utf8')).toBeGreaterThan(1 << 20);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, { content });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const returned = submitted.body.data.content as Array<{ type: string }>;
    expect(returned.filter((part) => part.type === 'image')).toHaveLength(3);

    const session = getLiveSessionById(server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const message = main.accessor.get(IAgentContextMemoryService).get()
        .find((item) => item.role === 'user' && item.content.filter((part) => part.type === 'image_url').length === 3);
      expect(message).toBeDefined();
    });
  });

  it('reports an oversized prompt body as a validation error without creating a prompt', async () => {
    const id = await createSession(home as string);
    const payload = JSON.stringify({
      content: [{ type: 'text', text: 'x'.repeat(PROMPT_BODY_LIMIT_BYTES) }],
    });
    const response = await server!.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/prompts`,
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      payload,
    });
    const submitted = JSON.parse(response.body) as Envelope<PromptItemWire>;
    expect(response.statusCode).toBe(413);
    expect(submitted.code).toBe(40001);
    expect(submitted.msg).toContain('request body exceeds');
    const listed = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.active).toBeNull();
    expect(listed.body.data.queued).toHaveLength(0);
  });

  it('compresses inline base64 image prompts into session media-originals', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: bigPng.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(2);
    const caption = content[0];
    if (caption?.type !== 'text') throw new Error('expected compression caption');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect((await realpath(pathMatch![1]!)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1];
    if (image?.type !== 'image' || image.source.kind !== 'base64') {
      throw new Error('expected resolved base64 image');
    }
    expect(pngDimensions(Buffer.from(image.source.data, 'base64'))).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  function avifBytes(): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('avif', 8, 'latin1');
    buf.write('avif', 16, 'latin1');
    return buf;
  }

  function heicBytes(): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('heic', 8, 'latin1');
    buf.write('heic', 16, 'latin1');
    return buf;
  }

  it('materializes an unsupported inline image as a model-independent file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: avifBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('accepts a HEIC image against the configured default model before any model binds', async () => {
    await writeConfigToml(home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "stub-kimi"') + [
      '', '[providers.kimi-stub]', 'type = "kimi"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "stub"',
      '', '[models.stub-kimi]', 'provider = "kimi-stub"', 'model = "kimi-k2"', 'max_context_size = 1000',
      'capabilities = ["thinking", "image_in"]', '',
    ].join('\n'));
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('image');
  });

  it('materializes HEIC when the default model does not accept it directly', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('preserves an uploaded unsupported image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(avifBytes())], { type: 'image/avif' }), 'photo.avif');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.data.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'photo.avif',
    });
  });

  it('preserves a remote image URL for request-time policy handling', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.com/pic.avif' } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/pic.avif' },
    });
  });

  async function uploadFile(
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): Promise<{ id: string; size: number }> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
    expect(uploaded.code).toBe(0);
    return uploaded.data;
  }

  function attachedPathFrom(notice: string): string {
    const match = /bytes\): (.+) — open it with the Read tool$/.exec(notice);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it('materializes an arbitrary file attachment into the session attachments dir', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const uploaded = await uploadFile(pdfBytes, 'application/pdf', 'report.pdf');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'summarize this' },
        { type: 'file', file_id: uploaded.id, name: 'report.pdf', media_type: 'application/pdf', size: pdfBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'summarize this' });
    const notice = content[1];
    expect(notice?.type).toBe('text');
    expect(notice?.text).toContain('Attached file "report.pdf"');
    expect(notice?.text).toContain('application/pdf');
    expect(notice?.text).toContain(`${pdfBytes.length} bytes`);
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath.replaceAll('\\', '/')).toContain('/attachments/');
    expect(attachedPath.endsWith(`${uploaded.id}-report.pdf`)).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(pdfBytes);
  });

  it('preserves an uploaded SVG image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const uploaded = await uploadFile(svgBytes, 'image/svg+xml', 'vector.svg');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'vector.svg',
    });
  });

  it('persists an unsupported inline image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const data = avifBytes();

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/avif',
            data: data.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('sanitizes an attachment file name before materializing it', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const scriptBytes = Buffer.from('#!/bin/sh\necho hi');
    const uploaded = await uploadFile(scriptBytes, 'text/plain', '../../etc/evil.sh');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'file', file_id: uploaded.id, name: '../../etc/evil.sh', media_type: 'text/plain', size: scriptBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const attachedPath = attachedPathFrom(content[0]?.text ?? '');
    expect(dirname(attachedPath).replaceAll('\\', '/').endsWith('/attachments')).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(scriptBytes);
  });

  it('replaces a queued prompt in place while preserving identity, order, and attachments', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
    await createHeldMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    const promptId = submitted.body.data.prompt_id;
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>(
      'POST',
      `/api/sessions/${id}/prompts/prompt_does_not_exist:abort`,
    );
    expect(body.code).toBe(40402);
  });

  it('cancels only the active main turn started by a background task notification', async () => {
    const id = await createSession(home as string);
    const otherId = await createSession(home as string);
    await createHeldMainAgent(id);
    await createMainAgent(otherId);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
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

    const client = new KikiClient({ baseUrl: base, token: server!.localOwnerToken });
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
    const id = await createSession(home as string);
    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    expect(list.body.data.active).toBeNull();
    expect(list.body.data.queued).toEqual([]);
  });

  it('stops queued and active child tasks through the GUI HTTP facade without crossing prompt ownership', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    const klient = createHttpKlient({ endpoint: base, token: server!.localOwnerToken });
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
      const klient = createMemoryKlient({ scope: server!.core });
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
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
      const mutations = server!.core.accessor.get(IModelCatalogMutationService);
      await mutations.updateProvider('stub', { base_url: `http://127.0.0.1:${String(address.port)}/v1` });
      await mutations.updateModel('stub', { max_context_size: 100000 });
      const id = await createSession(home as string);
      await createMainAgent(id);

      const session = getLiveSessionById(server!.core.accessor, id);
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

  it('reports incomplete persisted binding metadata for a known disposed agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      agent_id: 'agent_does_not_exist',
    });
    expect(body.code).toBe(40401);
  });

  it('rejects an unknown agent profile with 40001', async () => {
    const id = await createSession(home as string);
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
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the route-lock rejection', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
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
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'route-reviewer.md'),
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'route-reviewer',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
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
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'pinned-profile.md'),
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
      join(home as string, 'agents', 'override-profile.md'),
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
    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const id = await createSession(home as string);
    await createHeldMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(first.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
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

    await closeSessionById(server!.core.accessor, id);
    const resumed = await resumeSessionById(server!.core.accessor, id);
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
    const overriddenProfile = getLiveSessionById(server!.core.accessor, id)?.accessor
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = main?.accessor.get(IAgentProfileService);
    expect(profile?.data().profileName).toBe('agent');
    expect(profile?.data().thinkingLevel).toBe('high');
  });

  it('applies disabled_tools on the first prompt and replaces them on later prompts', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
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
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the tool-policy inheritance', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
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
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      disabled_tools: ['Bash'],
    });
    expect(body.code).toBe(40001);
  });

  it('persists disabled_tools across a cold resume', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const again = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
    });
    expect(again.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);
  });
});

import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getLiveSessionById,
  ConfigTarget,
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentProfileRegistry,
  IAgentProfileService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  IModelCatalog,
  normalizeAgentProfile,
  type IAgentScopeHandle,
} from '@kiki/agent-core-v2';
import { ToolCallDelta } from '@kiki/agent-core-v2/agent/loop/turnEvents';
import { IWireService } from '@kiki/agent-core-v2/wire/wire';
import { describe, expect, it } from 'vitest';

import { usePromptFixture } from './helpers/promptFixture';

type JsonRecord = Record<string, unknown>;
type CapturedRequest = { body: JsonRecord; headers: IncomingHttpHeaders };
type ProviderRoute = (request: CapturedRequest, response: ServerResponse) => Promise<void>;

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const ENV_KEY = 'EVAL_API_KEY';
const ENV_VALUE = 'eval-env-secret';
const LITERAL_KEY = 'literal-eval-secret';
const WRAPPER_LITERAL_KEY = 'wrapper-literal-eval-secret';
const STUB_PROFILE_PROMPT = 'legacy-stub-model-profile-override';

async function requestBody(request: import('node:http').IncomingMessage): Promise<CapturedRequest['body']> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedRequest['body'];
}

function sseEvent(payload: JsonRecord): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function finishSse(response: ServerResponse, payloads: readonly JsonRecord[], split = false): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  const body = `${payloads.map(sseEvent).join('')}data: [DONE]\n\n`;
  if (!split) {
    response.end(body);
    return;
  }
  for (let offset = 0; offset < body.length; offset += 11) response.write(body.slice(offset, offset + 11));
  response.end();
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readFixtureFile(path: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt >= 20) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function readFixtureFiles(root: string): Promise<Buffer> {
  const files: Buffer[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(await readFixtureFile(path));
    }
  };
  await visit(root);
  return Buffer.concat(files);
}

async function listenProvider(route: ProviderRoute): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await requestBody(request);
        await route({ body, headers: request.headers }, response);
      } catch {
        response.statusCode = 500;
        response.end();
      }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('provider did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function frontendProfile(baseUrl: string, model: string) {
  return normalizeAgentProfile({
    name: 'frontend',
    main: true,
    tools: ['AgentRun', 'CallTool', 'ReadMediaFile'],
    canSpawnSubagents: true,
    allowedSubagents: ['frontend'],
    modelAlias: 'stub',
    requestParams: { preserve_thinking: false, temperature: 0.8 },
    modelProfiles: [{ alias: 'stub', promptMode: 'append', prompt: STUB_PROFILE_PROMPT }],
    endpoint: {
      provider_type: 'openai',
      base_url: baseUrl,
      model,
      api_key_env: ENV_KEY,
    },
    systemPrompt: () => 'Use the available native tools and report concrete results.',
  });
}

async function createYoloSession(fixture: ReturnType<typeof usePromptFixture>): Promise<string> {
  const created = await fixture.call<{ id: string }>('POST', '/api/sessions', {
    metadata: { cwd: fixture.home },
    agent_config: { permission_mode: 'yolo' },
  });
  expect(created.body.code, created.body.msg).toBe(0);
  return created.body.data.id;
}

function assertEndpointRequest(request: CapturedRequest, expectedKey: string): void {
  expect(request.headers.authorization).toBe(`Bearer ${expectedKey}`);
  expect(Object.keys(request.headers).filter((key) => key.startsWith('x-kiki'))).toEqual([]);
  const text = JSON.stringify(request.body);
  expect(text).not.toContain('requestIdentity');
  expect(text).not.toContain('request_identity');
}

async function wireText(agent: IAgentScopeHandle): Promise<string> {
  const wire = agent.accessor.get(IWireService);
  await wire.flush();
  const records: unknown[] = [];
  for await (const record of wire.readJournal()) records.push(record);
  return JSON.stringify(records);
}

describe('native ad-hoc endpoint integration', () => {
  const fixture = usePromptFixture();

  it('runs a real native AgentRun endpoint with env auth, media, thinking replay, and request-boundary isolation', async () => {
    const requests: Array<CapturedRequest & { model: string }> = [];
    const childRequests: CapturedRequest[] = [];
    const parentRequests: CapturedRequest[] = [];
    const imagePath = join(fixture.home!, 'fixture.png');
    await writeFile(imagePath, PNG_BYTES);
    let childCount = 0;
    let parentCount = 0;
    const provider = await listenProvider(async (request, response) => {
      const model = String(request.body['model']);
      requests.push({ ...request, model });
      if (model === 'child-model') {
        childRequests.push(request);
        childCount += 1;
        if (childCount === 1) {
          finishSse(response, [
            { id: 'child-1', choices: [{ index: 0, delta: { reasoning_content: 'child-thought' }, finish_reason: null }] },
            { id: 'child-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'child-read', type: 'function', function: { name: 'ReadMediaFile', arguments: JSON.stringify({ path: imagePath }) } }] }, finish_reason: 'tool_calls' }] },
          ]);
        } else {
          finishSse(response, [
            { id: 'child-2', choices: [{ index: 0, delta: { reasoning_content: 'child-followup-thought', content: 'Child final.' }, finish_reason: 'stop' }] },
          ]);
        }
        return;
      }
      parentRequests.push(request);
      parentCount += 1;
      if (parentCount === 1) {
        const endpoint = {
          provider_type: 'openai',
          base_url: provider.baseUrl,
          model: 'child-model',
          api_key_env: ENV_KEY,
          max_context_size: 131072,
          max_completion_tokens: 32768,
          request_params: { preserve_thinking: true, temperature: 0 },
        };
        finishSse(response, [
          { id: 'parent-1', choices: [{ index: 0, delta: { reasoning_content: 'parent-first-thought' }, finish_reason: null }] },
          { id: 'parent-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'parent-agent-run', type: 'function', function: { name: 'AgentRun', arguments: JSON.stringify({ prompt: 'Inspect the fixture image.', description: 'Inspect image', profile: 'frontend', ...endpoint, effort: 'high', background: false }) } }] }, finish_reason: 'tool_calls' }] },
        ]);
      } else if (parentCount === 2) {
        finishSse(response, [{ id: 'parent-invalid', choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: 'invalid-model', type: 'function', function: { name: 'AgentRun', arguments: JSON.stringify({ profile: 'frontend', model: 'foo', prompt: 'Must reject bare model.', description: 'Invalid model', background: false }) } },
          { index: 1, id: 'invalid-empty', type: 'function', function: { name: 'AgentRun', arguments: JSON.stringify({ profile: 'frontend', endpoint: {}, prompt: 'Must reject empty endpoint.', description: 'Empty endpoint', background: false }) } },
        ] }, finish_reason: 'tool_calls' }] }]);
      } else if (parentCount === 3) {
        finishSse(response, [
          { id: 'parent-2', choices: [{ index: 0, delta: { reasoning_content: 'parent-final-thought', content: 'Parent final.' }, finish_reason: 'stop' }] },
        ]);
      } else {
        finishSse(response, [
          { id: 'parent-3', choices: [{ index: 0, delta: { content: 'Next prompt complete.' }, finish_reason: 'stop' }] },
        ]);
      }
    });
    const previousEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = ENV_VALUE;
    const profile = frontendProfile(provider.baseUrl, 'parent-model');
    const registration = fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'adhoc-endpoint-e2e-main',
      priority: 100,
      contribution: { profiles: [profile] },
    });
    const configPath = join(fixture.home!, 'config.toml');
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n[model_overrides]\ntemperature = 1\n`);
    await fixture.server!.core.accessor.get(IConfigService).reload();
    const configBefore = await readFile(configPath);
    const catalog = fixture.server!.core.accessor.get(IModelCatalog);
    const modelsBefore = await catalog.listModels();
    const providersBefore = await catalog.listProviders();
    try {
      const sessionId = await createYoloSession(fixture);
      const session = getLiveSessionById(fixture.server!.core.accessor, sessionId)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      await lifecycle.create({ agentId: 'main' });
      const main = lifecycle.get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'frontend' });
      const beforeBranch = lifecycle.list().map((agent) => agent.id).toSorted();
      await expect(lifecycle.fork('main', { agentId: 'denied-branch' })).rejects.toThrow('cannot be inherited');
      expect(lifecycle.list().map((agent) => agent.id).toSorted()).toEqual(beforeBranch);
      const submitted = await fixture.call('POST', `/api/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: 'Delegate image inspection.' }] });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      await main.accessor.get(IAgentLoopService).settled();
      expect(main.accessor.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
      const bound = main.accessor.get(IAgentProfileService).data();
      await fixture.server!.core.accessor.get(IConfigService).set('agentExecutorOverrides', { native: { defaults: { model_alias: 'stub', thinking_effort: 'low' } } }, ConfigTarget.Memory);
      const next = await fixture.call('POST', `/api/sessions/${sessionId}/prompts`, { prompt_id: 'adhoc-next', execution: { executor: 'native' }, content: [{ type: 'text', text: 'Continue after the child.' }] });
      expect(next.body.code, next.body.msg).toBe(0);
      await main.accessor.get(IAgentLoopService).settled();
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({ endpoint: bound.endpoint, modelAlias: bound.modelAlias, profileName: bound.profileName, thinkingLevel: bound.thinkingLevel });
      expect(parentRequests).toHaveLength(4);
      expect(childRequests).toHaveLength(2);
      assertEndpointRequest(parentRequests[0]!, ENV_VALUE);
      assertEndpointRequest(childRequests[0]!, ENV_VALUE);
      for (const request of requests) {
        expect(Object.keys(request.headers).filter((key) => key.startsWith('x-kiki'))).toEqual([]);
        expect(JSON.stringify(request.body)).not.toContain('requestIdentity');
        expect(JSON.stringify(request.body)).not.toContain('request_identity');
      }
      const childBody = childRequests[0]!.body;
      expect(childBody).toMatchObject({ reasoning_effort: 'high', max_tokens: 32768, preserve_thinking: true, temperature: 0 });
      expect(childBody).not.toHaveProperty('max_completion_tokens');
      expect(JSON.stringify(childRequests[1]!.body)).toContain('child-thought');
      expect(JSON.stringify(childRequests[1]!.body)).toContain('image_url');
      expect(JSON.stringify(parentRequests[3]!.body)).toContain('parent-final-thought');
      const rejections = parentRequests[2]!.body['messages'] as Array<{ role: string; tool_call_id?: string; content?: string }>;
      for (const id of ['invalid-model', 'invalid-empty']) expect(rejections.find((message) => message.tool_call_id === id)?.content).toContain('Endpoint overrides require');
      expect(JSON.stringify(requests)).not.toContain(STUB_PROFILE_PROMPT);
      const registered = fixture.server!.core.accessor.get(IAgentProfileRegistry).entries()
        .flatMap((entry) => entry.contribution.profiles)
        .find((candidate) => candidate.name === 'frontend');
      expect(registered).toMatchObject({ modelAlias: 'stub', modelProfiles: [{ alias: 'stub', prompt: STUB_PROFILE_PROMPT }] });
      const child = lifecycle.list().find((agent) => agent.id !== 'main');
      expect(child).toBeDefined();
      expect(child!.accessor.get(IAgentProfileService).data().boundProfile?.modelProfiles).toBeUndefined();
      expect(child!.accessor.get(IAgentProfileService).data().modelAlias).toContain('child-model');
      expect(JSON.stringify(childRequests[0]!.body)).not.toContain(STUB_PROFILE_PROMPT);
      expect(JSON.stringify(requests)).not.toContain('x-kiki');
      expect(JSON.stringify(requests)).not.toContain('requestIdentity');
      expect(await readFile(join(fixture.home!, 'config.toml'))).toEqual(configBefore);
      expect(await catalog.listModels()).toEqual(modelsBefore);
      expect(await catalog.listProviders()).toEqual(providersBefore);
    } finally {
      await registration.dispose();
      if (previousEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previousEnv;
      await closeServer(provider.server);
    }
  }, 45_000);

  it('streams literal AgentRun and CallTool api_keys while keeping public state secret-free', async () => {
    const requests: Array<CapturedRequest & { model: string }> = [];
    const childRequests: CapturedRequest[] = [];
    const parentRequests: CapturedRequest[] = [];
    const toolDeltas: ToolCallDelta[] = [];
    let parentCount = 0;
    const provider = await listenProvider(async (request, response) => {
      const model = String(request.body['model']);
      requests.push({ ...request, model });
      if (model === 'child-stream' || model === 'child-wrapper') {
        childRequests.push(request);
        finishSse(response, [{ id: model, choices: [{ index: 0, delta: { reasoning_content: model === 'child-stream' ? 'stream-child-thought' : 'wrapper-child-thought', content: model === 'child-stream' ? 'Streamed child final.' : 'Wrapper child final.' }, finish_reason: 'stop' }] }]);
        return;
      }
      parentRequests.push(request);
      parentCount += 1;
      if (parentCount === 1) {
        const args = JSON.stringify({ prompt: 'Use the literal-key endpoint.', description: 'Literal endpoint', profile: 'frontend', endpoint: {
          provider_type: 'openai', base_url: provider.baseUrl, model: 'child-stream', api_key: LITERAL_KEY,
          capabilities: ['tool_use', 'thinking'], support_efforts: ['low', 'medium', 'high', 'xhigh'], max_context_size: 131072,
        }, effort: 'high', background: false });
        const keyStart = args.indexOf(LITERAL_KEY);
        expect(keyStart).toBeGreaterThan(0);
        const pieces = [args.slice(0, keyStart + 5), args.slice(keyStart + 5, keyStart + 12), args.slice(keyStart + 12)];
        const calls = pieces.map((part, index) => ({ index: 0, ...(index === 0 ? { id: 'literal-run', type: 'function' } : {}), function: { ...(index === 0 ? { name: 'AgentRun' } : {}), arguments: part } }));
        finishSse(response, [
          { id: 'parent-stream', choices: [{ index: 0, delta: { reasoning_content: 'stream-parent-thought' }, finish_reason: null }] },
          ...calls.map((tool_calls, index) => ({ id: 'parent-stream', choices: [{ index: 0, delta: { tool_calls: [tool_calls] }, finish_reason: index === calls.length - 1 ? 'tool_calls' : null }] })),
        ], true);
      } else if (parentCount === 2) {
        const wrapperArgs = JSON.stringify({ name: 'AgentRun', arguments: { prompt: 'Run the wrapper endpoint.', description: 'Wrapper endpoint', profile: 'frontend', endpoint: {
          provider_type: 'openai', base_url: provider.baseUrl, model: 'child-wrapper', api_key: WRAPPER_LITERAL_KEY,
          capabilities: ['tool_use', 'thinking'], support_efforts: ['low', 'medium', 'high', 'xhigh'], max_context_size: 131072,
        }, effort: 'high', background: false } });
        const wrapperKeyStart = wrapperArgs.indexOf(WRAPPER_LITERAL_KEY);
        expect(wrapperKeyStart).toBeGreaterThan(0);
        const wrapperPieces = [wrapperArgs.slice(0, wrapperKeyStart + 5), wrapperArgs.slice(wrapperKeyStart + 5, wrapperKeyStart + 12), wrapperArgs.slice(wrapperKeyStart + 12)];
        const wrapperCalls = wrapperPieces.map((part, index) => ({ index: 0, ...(index === 0 ? { id: 'wrapper-run', type: 'function' } : {}), function: { ...(index === 0 ? { name: 'CallTool' } : {}), arguments: part } }));
        finishSse(response, wrapperCalls.map((tool_calls, index) => ({ id: 'parent-wrapper', choices: [{ index: 0, delta: { tool_calls: [tool_calls] }, finish_reason: index === wrapperCalls.length - 1 ? 'tool_calls' : null }] })), true);
      } else {
        finishSse(response, [{ id: 'parent-stream-final', choices: [{ index: 0, delta: { content: 'Parent streamed final.' }, finish_reason: 'stop' }] }]);
      }
    });
    const previousEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = ENV_VALUE;
    const registration = fixture.server!.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'adhoc-endpoint-e2e-stream',
      priority: 100,
      contribution: { profiles: [frontendProfile(provider.baseUrl, 'parent-stream')] },
    });
    let toolDeltaSubscription: { dispose(): void | Promise<void> } | undefined;
    try {
      const sessionId = await createYoloSession(fixture);
      const session = getLiveSessionById(fixture.server!.core.accessor, sessionId)!;
      await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
      const main = session.accessor.get(IAgentLifecycleService).get('main')!;
      await main.accessor.get(IAgentProfileService).bind({ profile: 'frontend' });
      toolDeltaSubscription = main.accessor.get(IEventBus).subscribe(ToolCallDelta, (event) => toolDeltas.push(event));
      const submitted = await fixture.call('POST', `/api/sessions/${sessionId}/prompts`, { content: [{ type: 'text', text: 'Run the literal endpoint.' }] });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      await main.accessor.get(IAgentLoopService).settled();
      expect(main.accessor.get(IAgentLoopService).status()).toMatchObject({ state: 'idle', lastTurnResult: 'completed' });
      expect(childRequests).toHaveLength(2);
      expect(childRequests[0]!.headers.authorization).toBe(`Bearer ${LITERAL_KEY}`);
      expect(childRequests[1]!.headers.authorization).toBe(`Bearer ${WRAPPER_LITERAL_KEY}`);
      const publicRequestBodies = JSON.stringify(requests.map((request) => request.body));
      for (const secret of [LITERAL_KEY, WRAPPER_LITERAL_KEY]) expect(publicRequestBodies).not.toContain(secret);
      const leakedModels = requests.filter((request) => [LITERAL_KEY, WRAPPER_LITERAL_KEY].some((secret) => JSON.stringify(request.body).includes(secret))).map((request) => request.model);
      expect(leakedModels).toEqual([]);
      expect(toolDeltas).toHaveLength(2);
      expect(toolDeltas.map((event) => event.name)).toEqual(['AgentRun', 'CallTool']);
      const publicDeltas = JSON.stringify(toolDeltas);
      expect(publicDeltas).toContain('[REDACTED]');
      expect(publicDeltas).not.toContain(LITERAL_KEY);
      expect(publicDeltas).not.toContain(WRAPPER_LITERAL_KEY);
      const mainContext = JSON.stringify(main.accessor.get(IAgentContextMemoryService).get());
      expect(mainContext).toContain('[REDACTED]');
      expect(mainContext).not.toContain(LITERAL_KEY);
      expect(mainContext).not.toContain(WRAPPER_LITERAL_KEY);
      const mainWire = await wireText(main);
      const child = session.accessor.get(IAgentLifecycleService).list().find((agent) => agent.id !== 'main');
      expect(child).toBeDefined();
      const childContext = JSON.stringify(child!.accessor.get(IAgentContextMemoryService).get());
      expect(childContext).not.toContain(LITERAL_KEY);
      expect(childContext).not.toContain(WRAPPER_LITERAL_KEY);
      const childWire = await wireText(child!);
      expect(mainWire).not.toContain(LITERAL_KEY);
      expect(mainWire).not.toContain(WRAPPER_LITERAL_KEY);
      expect(childWire).not.toContain(LITERAL_KEY);
      expect(childWire).not.toContain(WRAPPER_LITERAL_KEY);
      expect(mainWire).toContain('tool.call');
      expect(mainWire).toContain('[REDACTED]');
      for (const agent of session.accessor.get(IAgentLifecycleService).list()) {
        const dispatcher = agent.accessor.get(IEventDispatcher);
        expect(dispatcher.saveReplayCheckpoint).toBeDefined();
        expect(await dispatcher.saveReplayCheckpoint!()).toBe(true);
      }
      await fixture.server!.close();
      const persisted = await readFixtureFiles(fixture.home!);
      expect(persisted.length).toBeGreaterThan(0);
      for (const secret of [LITERAL_KEY, WRAPPER_LITERAL_KEY]) expect(persisted.includes(Buffer.from(secret))).toBe(false);
    } finally {
      await toolDeltaSubscription?.dispose();
      await registration.dispose();
      if (previousEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previousEnv;
      await closeServer(provider.server);
    }
  }, 45_000);
});

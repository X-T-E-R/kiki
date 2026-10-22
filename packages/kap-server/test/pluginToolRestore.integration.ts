import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse, PluginUsageResponse } from '@kiki/protocol';
import { IAgentLifecycleService, IAgentToolRegistryService, IPluginHostService, IWorkspaceService, getLiveSessionById } from '@kiki/agent-core-v2';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const ALPHA = 'plugin__alpha_kit__AlphaPing';
const BETA = 'plugin__beta_kit__BetaPing';

it('opens the same old and new sessions after plugin tools are off, uninstalled, or missing', async () => {
  const provider = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({
      id: 'local-reply',
      choices: [{ index: 0, delta: { content: 'local canned reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('missing provider address');
  const home = await mkdtemp(join(tmpdir(), 'kiki-plugin-restore-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(home, 'agents'), { recursive: true });
  const profilePath = join(home, 'agents', 'field-notes.md');
  const profileText = [
    '---',
    'name: field-notes',
    'description: Notes with two plugin tools',
    `tools: [Read, ${ALPHA}, ${BETA}]`,
    '---',
    'Keep the notes.',
    '',
  ].join('\n');
  await writeFile(profilePath, profileText);
  await writeFile(join(home, 'config.toml'), [
    'default_model = "stub"',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'api_key = "test-only"',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 8000',
    '',
  ].join('\n'));
  const sources = {
    'alpha-kit': await pluginDir(home, 'alpha-kit', 'AlphaPing'),
    'beta-kit': await pluginDir(home, 'beta-kit', 'BetaPing'),
  };
  let server = await boot(home);
  let base = `http://127.0.0.1:${server.port}`;
  try {
    for (const [id, source] of Object.entries(sources)) {
      await install(server, base, source);
      expect((await call(server, base, 'POST', `/api/plugins/${id}:enable`)).code).toBe(0);
    }
    await server.core.accessor.get(IWorkspaceService).createOrTouch(workspace);
    const oldSession = await createSession(server, base, workspace, 'field-notes');
    const freshSession = await createSession(server, base, workspace, 'agent');
    await send(server, base, oldSession, 'old session note');
    await send(server, base, freshSession, 'new session note');
    expect(await readFile(profilePath, 'utf8')).toBe(profileText);

    const states: { name: string; apply: () => Promise<void> }[] = [
      { name: 'installed', apply: async () => undefined },
      {
        name: 'off',
        apply: async () => {
          for (const id of Object.keys(sources)) expect((await call(server, base, 'POST', `/api/plugins/${id}:disable`)).code).toBe(0);
        },
      },
      {
        name: 'uninstall',
        apply: async () => {
          for (const id of Object.keys(sources)) expect((await call(server, base, 'POST', `/api/plugins/${id}:remove`)).code).toBe(0);
        },
      },
      {
        name: 'missing',
        apply: async () => {
          await rm(join(home, 'plugins'), { recursive: true, force: true });
          for (const source of Object.values(sources)) await rm(source, { recursive: true, force: true });
        },
      },
    ];
    for (const state of states) {
      await state.apply();
      await server.close();
      server = await boot(home);
      base = `http://127.0.0.1:${server.port}`;
      for (const [id, marker] of [[oldSession, 'old session note'], [freshSession, 'new session note']] as const) {
        const opened = await call<{ id: string; busy: boolean }>(server, base, 'GET', `/api/sessions/${id}`);
        expect(opened.code, state.name).toBe(0);
        const history = JSON.stringify(await call(server, base, 'GET', `/api/sessions/${id}/messages`));
        expect(history, state.name).toContain(marker);
        await send(server, base, id, `${state.name} ordinary send`);
        const after = JSON.stringify(await call(server, base, 'GET', `/api/sessions/${id}/messages`));
        expect(after, state.name).toContain(marker);
        expect(after, state.name).toContain('local canned reply');
        expect(after, state.name).toContain(`${state.name} ordinary send`);
      }
      expect(await readFile(profilePath, 'utf8'), state.name).toBe(profileText);
    }

    const live = getLiveSessionById(server.core.accessor, oldSession);
    if (live === undefined) throw new Error('old session was not opened');
    await expect(live.accessor.get(IAgentLifecycleService).create({
      agentId: 'explicit-new-profile',
      binding: { profile: 'field-notes', model: 'stub' },
    })).rejects.toThrow(new RegExp(`${ALPHA}[\\s\\S]*${BETA}`));
    const agent = live.accessor.get(IAgentLifecycleService).get('main');
    if (agent === undefined) throw new Error('restored main agent is missing');
    const results = [];
    for await (const result of agent.accessor.get(IAgentToolExecutorService).execute([
      { type: 'function', id: 'call-alpha', name: ALPHA, arguments: '{}' },
      { type: 'function', id: 'call-beta', name: BETA, arguments: '{}' },
    ], { signal: AbortSignal.timeout(10_000), turnId: 1 })) {
      results.push(result);
    }
    expect(results.map((result) => result.result)).toEqual([
      expect.objectContaining({ isError: true, output: expect.stringContaining(ALPHA) }),
      expect.objectContaining({ isError: true, output: expect.stringContaining(BETA) }),
    ]);
    await send(server, base, oldSession, 'still ordinary after the missing tools');
    expect(JSON.stringify(await call(server, base, 'GET', `/api/sessions/${oldSession}/messages`))).toContain('still ordinary after the missing tools');
    expect(await readFile(profilePath, 'utf8')).toBe(profileText);
  } finally {
    await server.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 180_000);

it('hot-enables deferred tools in the same old session through real SelectTools, request schema, execution and off', async () => {
  const name = 'plugin__example_mail__Mailbox';
  const requests: unknown[] = [];
  let scriptedStep = -1;
  const provider = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const step = scriptedStep < 0 ? -1 : scriptedStep++;
      const selected = step === 0;
      const tool = selected ? 'SelectTools' : name;
      const delta = step === 0 || step === 1 ? { tool_calls: [{ index: 0, id: `fixture-${step}`, type: 'function', function: {
        name: tool, arguments: selected ? JSON.stringify({ names: [name] }) : '{}',
      } }] } : { content: 'fixture read complete' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ id: `local-${requests.length}`, choices: [{ index: 0, delta, finish_reason: step === 0 || step === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('missing provider address');
  const home = await mkdtemp(join(tmpdir(), 'kiki-hot-plugin-'));
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(home, 'agents'), { recursive: true });
  await writeFile(join(home, 'agents', 'hot-fixture.md'), '---\nname: hot-fixture\ndescription: Hot capability fixture\nmain: true\ntools: ["*"]\n---\nUse the fixture tools.\n');
  await writeFile(join(home, 'config.toml'), [
    'default_model = "stub"', 'default_permission_mode = "yolo"',
    '[providers.stub]', 'type = "openai"', `base_url = "http://127.0.0.1:${address.port}/v1"`, 'api_key = "test-only"',
    '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 128000', 'capabilities = ["tool_use"]', '',
  ].join('\n'));
  vi.stubEnv('KIKI_EXPERIMENTAL_TOOL_SELECT', '1');
  const server = await boot(home);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const source = await pluginDir(home, 'example-mail', 'Mailbox', true);
    await install(server, base, source);
    const id = await createSession(server, base, workspace, 'hot-fixture');
    const setUsage = async (override: 'on' | 'off') => {
      const answer = await call<PluginUsageResponse>(server, base, 'POST', '/api/plugins/usage', { target: { session_id: id }, plugin_id: 'example-mail', override });
      expect(answer.code, answer.msg).toBe(0);
      return answer.data;
    };
    const panel = async () => {
      const answer = await call<AgentCapabilitiesResponse>(server, base, 'GET', `/api/agents/capabilities?session_id=${id}&agent_id=main`);
      expect(answer.code, answer.msg).toBe(0);
      return answer.data;
    };
    await setUsage('off');
    await send(server, base, id, 'save the old session before activation');
    const live = getLiveSessionById(server.core.accessor, id);
    if (live === undefined) throw new Error('fixture session was not opened');
    const agent = live.accessor.get(IAgentLifecycleService).get('main');
    if (agent === undefined) throw new Error('fixture main agent is missing');
    const registry = agent.accessor.get(IAgentToolRegistryService);
    const hosts = server.core.accessor.get(IPluginHostService);
    const executed = vi.spyOn(hosts, 'execute');
    expect(registry.resolve(name)).toBeUndefined();
    const catalogFailure = vi.spyOn(hosts, 'list').mockRejectedValue(new Error('fixture catalog unavailable'));
    try {
      const failed = await setUsage('on');
      expect(failed.apply_state).toBe('failed');
      expect(failed.errors.join('\n')).toContain('fixture catalog unavailable');
      expect(failed.plugins.find((plugin) => plugin.id === 'example-mail')?.effective).toBe(true);
      expect(registry.resolve(name)).toBeUndefined();
    } finally {
      catalogFailure.mockRestore();
    }
    expect((await setUsage('on')).apply_state).toBe('applied');
    expect((await panel()).tools?.find((tool) => tool.name === name)).toMatchObject({ state: 'enabled', policy_allowed: true, request_state: 'loadable' });
    const first = requests.length;
    scriptedStep = 0;
    await send(server, base, id, 'list fixture folders');
    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed.mock.calls[0]?.slice(0, 3)).toEqual(['example-mail', 'Mailbox', {}]);
    expect(requests.length - first).toBe(3);
    expect(JSON.stringify(requests[first])).toContain(name);
    const selectedRequest = requests[first + 1] as { messages: { content: string | { text?: string }[] | null }[] };
    const schemaText = selectedRequest.messages.flatMap((message) => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map((part) => part.text ?? '')).join('\n');
    const schemas = /<dynamic_tool_schemas>(.*?)<\/dynamic_tool_schemas>/s.exec(schemaText);
    expect(schemas).not.toBeNull();
    expect(JSON.parse(schemas![1]!)).toEqual(expect.arrayContaining([expect.objectContaining({ name, parameters: { type: 'object', additionalProperties: false } })]));
    expect((await panel()).tools?.find((tool) => tool.name === name)?.request_state).toBe('available');
    expect(getLiveSessionById(server.core.accessor, id)?.accessor.get(IAgentLifecycleService).get('main')).toBe(agent);
    expect((await setUsage('off')).plugins.find((plugin) => plugin.id === 'example-mail')?.effective).toBe(false);
    expect(registry.resolve(name)).toBeUndefined();
    expect((await panel()).tools?.find((tool) => tool.name === name)).toMatchObject({ state: 'disabled', request_state: 'unavailable', unavailable_reason_code: 'plugin_usage_disabled' });
    await send(server, base, id, 'confirm the tool is off');
    expect(JSON.stringify(requests.at(-1))).toContain('<tools_removed>');
    const blocked = [];
    for await (const result of agent.accessor.get(IAgentToolExecutorService).execute([
      { type: 'function', id: 'after-off', name, arguments: '{}' },
    ], { signal: AbortSignal.timeout(10_000), turnId: 4 })) blocked.push(result.result);
    expect(blocked).toEqual([expect.objectContaining({ isError: true })]);
    expect(executed).toHaveBeenCalledTimes(1);
    executed.mockRestore();
  } finally {
    await server.close();
    vi.unstubAllEnvs();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 90_000);

async function boot(home: string): Promise<RunningServer> {
  return startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent' });
}

async function pluginDir(home: string, id: string, tool: string, deferred = false): Promise<string> {
  const dir = join(home, 'plugin-sources', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'entry.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const manifest = JSON.parse(readFileSync(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));",
    'export function register(api) {',
    "  for (const definition of manifest['x-kiki'].tools) api.registerTool(definition, async () => ({ output: definition.name, isError: false }));",
    '}',
    '',
  ].join('\n'));
  await writeFile(join(dir, 'kimi.plugin.json'), JSON.stringify({
    name: id,
    version: '0.0.1',
    description: `${id} fixture`,
    'x-kiki': {
      engines: { kiki: '^0.4.0' },
      entry: './entry.mjs',
      permissions: { fs: 'workspace' },
      tools: [{ schemaVersion: 1, name: tool, description: tool, disclosure: deferred ? 'deferred' : undefined, parameters: { type: 'object', additionalProperties: false }, accesses: [{ kind: 'all' }] }],
    },
  }));
  return dir;
}

async function call<T>(server: RunningServer, base: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ code: number; msg?: string; data: T }> {
  const response = await authedFetch(server, base, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return await response.json() as { code: number; msg?: string; data: T };
}

async function install(server: RunningServer, base: string, source: string): Promise<void> {
  const preview = await call<{ fingerprint: string }>(server, base, 'POST', '/api/plugins:preview', { source });
  expect(preview.code, preview.msg).toBe(0);
  const installed = await call(server, base, 'POST', '/api/plugins', {
    source, fingerprint: preview.data.fingerprint, consent: true, defaultEnabled: true,
  });
  expect(installed.code, installed.msg).toBe(0);
}

async function createSession(server: RunningServer, base: string, cwd: string, profile: string): Promise<string> {
  const created = await call<{ id: string }>(server, base, 'POST', '/api/sessions', {
    metadata: { cwd },
    agent_config: { profile, model: 'stub' },
  });
  expect(created.code, created.msg).toBe(0);
  return created.data.id;
}

async function send(server: RunningServer, base: string, id: string, text: string): Promise<void> {
  const submitted = await call(server, base, 'POST', `/api/sessions/${id}/prompts`, {
    content: [{ type: 'text', text }],
  });
  expect(submitted.code, submitted.msg).toBe(0);
  const started = Date.now();
  for (;;) {
    const session = await call<{ busy: boolean }>(server, base, 'GET', `/api/sessions/${id}`);
    expect(session.code, session.msg).toBe(0);
    if (!session.data.busy) return;
    if (Date.now() - started > 20_000) throw new Error(`session ${id} stayed busy after "${text}"`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

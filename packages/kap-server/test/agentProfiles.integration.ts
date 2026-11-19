import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_WIRE_RECORD_KEY, AgentProfileSourceDiagnosticCodes, ensureMainAgent, IAgentExecutorRegistry,
  IAgentLifecycleService, IAgentLoopService, IAgentProfileRegistry, IAgentProfileService, IAgentPromptService,
  IAgentUsageService, IAppendLogStore, IConfigService, IFileSystemStorageService, IHostProcessService,
  ILogService, IManagedAdapterService, IModelService, ISessionAgentProfileCatalog, ISessionContext,
  ISessionInteractionService, ISessionManager, ISessionMetadata, ISubagentTool, IUsageFactStore,
  IWorkspaceInstanceManager, IWorkspaceService, normalizeAgentProfile, SOURCE_OWNED_ADAPTER_ROOT_ENV,
  type AgentExecutorSession, type AgentProfileCatalogSnapshot, type AgentProfileRegistration, type ResolvedAgentExecutor,
} from '@kiki/agent-core-v2';
import { recordExecutorAuth } from '@kiki/agent-core-v2/agent/execution/executorAuth';
import { invalidateCachedAgentFiles } from '@kiki/agent-core-v2/agent/profile/agentFileDiscoveryCache';
import { isToolActiveComposed } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { IHostFileSystem } from '@kiki/agent-core-v2/os/interface/hostFileSystem';
import { SHIPPED_AGENT_PROFILE_TEMPLATES } from '@kiki/agent-core-v2/app/shippedAgentProfiles/shippedAgentProfiles';
import { IAgentPlanService } from '@kiki/agent-core-v2/features/plan/plan';
import { createHooks } from '@kiki/agent-core-v2/hooks';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import { RuntimeSkillDiscovery } from '@kiki/agent-core-v2/workspace/workspaceSkillCatalog/runtimeSkillDiscovery';
import { createKlient } from '@kiki/klient/http';
import {
  agentCapabilitiesResponseSchema, ErrorCode, listNamedAgentProfilesResponseSchema, listShippedAgentProfilesResponseSchema,
} from '@kiki/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  saveSubagentProfileToolSettings, searchSubagentToolCatalog, subagentProfileToolDraft,
  subagentProfileToolFields, subagentSessionToolStates,
} from '../../session-core/src/settings/subagentToolSettings';
import { panelSkills } from '../src/routes/agentPanelCapabilities';
import { acquireWorkspaceProfileCatalog } from '../src/routes/agentProfileCapabilities';
import { registerAgentProfilesRoute } from '../src/routes/agentProfiles';
import { type RunningServer, startServer, type ServerStartOptions } from '../src/start';
import { usageRuntime } from '../src/usage/usageRuntime';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: Array<{ path: string; message: string }>;
}

const STUB_MODELS_TOML = [
  'default_model = "stub"',
  '[search]', 'enabled = false',
  '[cron]', 'manualTick = true',
  '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
  '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
  'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
  '[models.stub-alt]', 'provider = "stub"', 'model = "stub-alt"', 'max_context_size = 1000',
  'capabilities = ["thinking"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"',
  '[experimental]', '"agent-profile-routes" = true',
].join('\n');

function holdExternalSession() {
  const pending: Array<() => void> = [];
  let state: 'idle' | 'running' = 'idle';
  const finish = (): void => { state = 'idle'; for (const r of pending.splice(0)) r(); };
  return {
    finish,
    session: {
      run: async () => {
        state = 'running';
        const controller = new AbortController();
        let release = (): void => {};
        const result = new Promise((r) => { release = () => r({ type: 'cancelled', steps: 0 }); });
        pending.push(() => { state = 'idle'; release(); });
        return {
          agentId: 'main', completion: result.then(() => ({ summary: '' })),
          turn: { id: 1, signal: controller.signal, ready: Promise.resolve(), result, cancel: () => { controller.abort(); state = 'idle'; release(); return true; } },
        };
      },
      status: () => ({ state }),
      cancel: () => { finish(); return true; },
      settled: async () => {},
      shutdown: async () => { finish(); },
      updateBinding: () => {},
      hooks: createHooks(['onWillRun']),
    },
  };
}

function createHostClient(getServer: () => RunningServer, getBase: () => string) {
  const getJson = async <T>(path: string, signal?: AbortSignal): Promise<Envelope<T>> =>
    (await (await authedFetch(getServer(), getBase(), path, signal ? { signal } : {})).json()) as Envelope<T>;
  const postJson = async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<Envelope<T>> =>
    (await (await authedFetch(getServer(), getBase(), path, {
      method: 'POST', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    })).json()) as Envelope<T>;
  const patchJson = async <T>(path: string, body: unknown): Promise<Envelope<T>> =>
    (await (await authedFetch(getServer(), getBase(), path, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json()) as Envelope<T>;
  return { getJson, postJson, patchJson };
}

async function startIsolatedProfileServer(home: string, extra?: Partial<ServerStartOptions>): Promise<{ server: RunningServer; base: string }> {
  const server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home,
    instancesDir: join(home, 'instances'), userSkillDir: join(home, 'isolated-skills'),
    logLevel: 'silent', ...extra,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function withProfileHost<T>(
  setup: (home: string) => Promise<Partial<ServerStartOptions> | void>,
  fn: (ctx: {
    home: string;
    server: RunningServer;
    base: string;
    getJson: <R>(path: string, signal?: AbortSignal) => Promise<Envelope<R>>;
    postJson: <R>(path: string, body?: unknown, signal?: AbortSignal) => Promise<Envelope<R>>;
    patchJson: <R>(path: string, body: unknown) => Promise<Envelope<R>>;
    restart: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'kiki-agent-profiles-iso-'));
  let current: RunningServer | undefined;
  let base = '';
  let startOpts: Partial<ServerStartOptions> | undefined;
  const helpers = createHostClient(() => current!, () => base);
  try {
    startOpts = (await setup(home)) ?? undefined;
    const cfgPath = join(home, 'config.toml');
    const existingCfg = await readFile(cfgPath, 'utf8').catch(() => '');
    if (!existingCfg.includes('[search]')) {
      await writeFile(cfgPath, `${existingCfg}${existingCfg.endsWith('\n') || existingCfg === '' ? '' : '\n'}[search]\nenabled = false\n[cron]\nmanualTick = true\n`);
    }
    const booted = await startIsolatedProfileServer(home, startOpts);
    current = booted.server;
    base = booted.base;
    return await fn({
      home,
      get server() { return current!; },
      get base() { return base; },
      ...helpers,
      restart: async () => {
        await current!.close();
        current = undefined;
        const next = await startIsolatedProfileServer(home, startOpts);
        current = next.server;
        base = next.base;
      },
    });
  } finally {
    vi.restoreAllMocks();
    if (current !== undefined) await current.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

describe('agent profile pure projection & named resolution', () => {
  it('projects skill origins and invocation restrictions without returning skill bodies', () => {
    const shared = { name: 'example', description: 'Example skill', path: '/fixture/skills/example', dir: '/fixture/skills', content: 'PRIVATE SKILL BODY' };
    const skills = panelSkills([
      { ...shared, source: 'project', metadata: { disableModelInvocation: true } },
      { ...shared, name: 'global-example', source: 'user', metadata: {} },
      { ...shared, name: 'global-extra', source: 'extra', sourceRoot: '/configured/skills', metadata: {} },
      { ...shared, name: 'plugin-example', source: 'extra', plugin: { id: 'example-plugin' }, metadata: {} },
    ], true);
    expect(skills).toMatchObject([
      { scope: 'workspace', source: 'project', source_kind: 'project', state: 'disabled', disable_model_invocation: true, unavailable_reason_code: 'skill_model_invocation_disabled' },
      { scope: 'global', source: 'user', source_kind: 'user', state: 'enabled' },
      { scope: 'global', source: 'extra', source_kind: 'extra', source_root: '/configured/skills' },
      { scope: 'global', source: 'extra', source_kind: 'plugin' },
    ]);
    expect(JSON.stringify(skills)).not.toContain('PRIVATE SKILL BODY');
    expect(panelSkills([{ ...shared, source: 'builtin', metadata: { argumentHint: 'arg1' } }], false)[0]).toMatchObject({
      state: 'disabled', argument_hint: 'arg1', unavailable_reason_code: 'skill_tool_inactive',
    });
  });

  it('resolves a profile hidden from the catalog public view through its resolvable view', async () => {
    const helper = normalizeAgentProfile({ name: 'hidden-helper', definitionId: 'definition:hidden-helper', systemPrompt: () => '' });
    const lead = normalizeAgentProfile({
      name: 'hidden-lead', definitionId: 'definition:hidden-lead', allowedSubagents: ['hidden-helper'],
      subagentLeases: { 'hidden-helper': { name: 'hidden-helper', source: './_private/helper.md' } }, systemPrompt: () => '',
    });
    const exposed = normalizeAgentProfile({ name: 'exposed', definitionId: 'definition:exposed', systemPrompt: () => '' });
    const snapshot = {
      publicProfiles: new Map([[exposed.name, exposed]]),
      resolvableProfiles: new Map([[exposed.name, exposed], [lead.name, lead], [helper.name, helper]]),
      routes: new Map(),
      scopedBindings: new Map([[lead.definitionId!, new Map([
        ['hidden-helper', { parentDefinitionId: lead.definitionId!, alias: 'hidden-helper', source: './_private/helper.md', lease: { name: 'hidden-helper', source: './_private/helper.md' }, status: 'ready' as const, profile: helper, sourceDefinitionId: helper.definitionId }],
      ])]]),
      sourceDefinitions: new Map([[helper.definitionId!, helper]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    } as unknown as AgentProfileCatalogSnapshot;
    const catalog = { ready: Promise.resolve(), get: (name: string) => snapshot.publicProfiles.get(name), snapshot: () => snapshot } as unknown as ISessionAgentProfileCatalog;
    const session = { accessor: { get: (token: unknown) => token === ISessionContext ? { workspaceId: 'wd_named' } : catalog } };
    const registration: AgentProfileRegistration = { sourceId: 'user', priority: 50, contribution: { profiles: [lead, exposed] } };
    const handlers = new Map<string, (req: unknown, reply: { send(payload: unknown): unknown }) => unknown>();
    const app = { get: (p: string, _o: unknown, h: never) => { handlers.set(p, h); }, post: () => {}, patch: () => {} };
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentProfileRegistry) return { entries: () => [registration] };
          if (token === IAgentExecutorRegistry) return { get: () => undefined };
          if (token === IModelService) return { list: () => ({}), resolveId: () => undefined };
          if (token === IConfigService) return { ready: Promise.resolve(), get: () => undefined };
          if (token === ISessionManager) return { list: () => [session] };
          throw new Error('unexpected token');
        },
      },
    };
    registerAgentProfilesRoute(app as unknown as Parameters<typeof registerAgentProfilesRoute>[0], core as unknown as Parameters<typeof registerAgentProfilesRoute>[1]);
    let sent: unknown;
    await handlers.get('/agents')!({ id: 'req', query: {} }, { send: (payload) => { sent = payload; } });
    const body = sent as { code: number; data: { items: Array<{ name: string; allowed_subagents?: unknown }> } };
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.name).toSorted()).toEqual(['exposed', 'hidden-lead']);
    expect(body.data.items.find((i) => i.name === 'hidden-lead')?.allowed_subagents).toEqual([
      expect.objectContaining({ name: 'hidden-helper', scope: 'private', status: 'ready' }),
    ]);
  });
});

describe('GET /api/agents (shared default server partition)', () => {
  let server!: RunningServer;
  let home!: string;
  let scratchRoot!: string;
  let base!: string;
  let caseSeq = 0;
  const { getJson, postJson, patchJson } = createHostClient(() => server, () => base);

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-agent-profiles-shared-'));
    scratchRoot = await mkdtemp(join(tmpdir(), 'kiki-agent-profiles-cases-'));
    await writeFile(join(home, 'config.toml'), STUB_MODELS_TOML);
    const booted = await startIsolatedProfileServer(home);
    server = booted.server;
    base = booted.base;
    await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
  }, 45_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const manager = server.core.accessor.get(ISessionManager);
    for (const s of manager.list()) await manager.close(s.id).catch(() => undefined);
    const agentsDir = join(home, 'agents');
    const entries = await readdir(agentsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry !== 'builtin') await rm(join(agentsDir, entry), { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await server?.close();
    await Promise.all([
      rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
    ]);
  }, 30_000);

  async function nextWorkspace(prefix = 'ws'): Promise<string> {
    caseSeq += 1;
    const dir = join(scratchRoot, `${prefix}-${caseSeq}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it('creates a session with an explicit file and previews explicit profile files without registering or editing them', async () => {
    const ws = await nextWorkspace('explicit');
    const createPath = join(ws, 'selected-create.md');
    await writeFile(createPath, '---\nname: example-file\ndescription: Explicit fixture\nmain: false\nmodel_alias: stub\n---\nEXPLICIT_CREATE_BODY');
    const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: ws }, agent_config: { execution: { executor: 'native', profile_file: createPath } } });
    expect(created.code, created.msg).toBe(0);
    const profile = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
    expect(profile.data()).toMatchObject({ profileName: 'example-file', modelAlias: 'stub', execution: { selection: { executor: 'native', profile_file: expect.any(String) } } });
    expect(profile.data().systemPrompt).toContain('EXPLICIT_CREATE_BODY');
    expect(server.core.accessor.get(IAgentProfileRegistry).entries().flatMap((e) => e.contribution.profiles).some((c) => c.name === 'example-file')).toBe(false);

    const previewDir = await nextWorkspace('preview');
    const previewPath = join(previewDir, 'selected.md');
    const previewText = '---\nname: example-file\ndescription: Explicit fixture\nmain: false\nexecutor: grok-acp\nmodel_alias: grok\n---\nFILE_PROMPT';
    await writeFile(previewPath, previewText);
    const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
    try {
      const rest = klient.rest!;
      const beforeWs = await server.core.accessor.get(IWorkspaceService).list();
      const preview = await rest.agents.previewFile({ path: 'selected.md', cwd: previewDir });
      expect(preview.profile).toMatchObject({ name: 'example-file', main: false, source: 'explicit', executor: 'grok-acp', pinned_model_alias: 'grok' });
      expect(preview.profile.source_file?.toLowerCase()).toBe(previewPath.replaceAll('\\', '/').toLowerCase());
      expect((await rest.agents.list({ cwd: previewDir, effective: true })).items.some((p) => p.name === 'example-file')).toBe(false);
      expect(await server.core.accessor.get(IWorkspaceService).list()).toEqual(beforeWs);
      expect(await readFile(previewPath, 'utf8')).toBe(previewText);
      await expect(rest.agents.previewFile({ path: join(previewDir, 'missing.md') })).rejects.toThrow('Unable to load profile file');
      await writeFile(previewPath, '---\nname: invalid\nunknown_field: true\n---\ninvalid');
      await expect(rest.agents.previewFile({ path: previewPath })).rejects.toThrow('Unable to load profile file');
    } finally { await klient.close(); }
  });

  it('selects a file profile across executors without registering or editing it', async () => {
    const ws = await nextWorkspace('exec-file');
    const externalText = '---\nname: external-file\ndescription: External file\nexecutor: grok-acp\nmodel_alias: grok-raw\n---\nEXTERNAL_FILE\n';
    const nativeText = '---\nname: native-file\ndescription: Native file\nmodel_alias: stub\n---\nNATIVE_FILE\n';
    const externalPath = join(ws, 'external.md'), nativePath = join(ws, 'native.md');
    await Promise.all([writeFile(externalPath, externalText), writeFile(nativePath, nativeText)]);
    const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: ws } });
    expect(created.code).toBe(0);
    const main = await ensureMainAgent(server.core.accessor.get(ISessionManager).get(created.data.id)!);
    main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-file-selection', async (ctx) => {
      await new Promise<void>((r) => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener('abort', () => r(), { once: true }); });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const executors = server.core.accessor.get(IAgentExecutorRegistry);
    const resolve = executors.resolveExecutable.bind(executors);
    const held = holdExternalSession();
    const mocked = vi.spyOn(executors, 'resolveExecutable').mockImplementation(async (executorId, options): Promise<ResolvedAgentExecutor> => executorId === 'grok-acp'
      ? {
          descriptor: { ...executors.get(executorId)!, command: process.execPath, revision: 'fixture' },
          options: executors.resolve(executorId, options ?? {}).options,
          provider: {
            id: 'fixture-acp', protocol: 'acp-v1',
            validateOptions: (v) => v as Record<string, string | number | boolean>,
            validateBinding: (b) => ({ ok: true, binding: b }),
            create: () => held.session as unknown as AgentExecutorSession,
          },
        }
      : resolve(executorId, options));
    const registered = (name: string) => server.core.accessor.get(IAgentProfileRegistry).entries().flatMap((e) => e.contribution.profiles).some((c) => c.name === name);
    try {
      const native = await postJson<{ prompt_id: string }>(`/api/sessions/${created.data.id}/prompts`, { content: [{ type: 'text', text: 'Select.' }], execution: { executor: 'native', profile_file: externalPath } });
      expect(native.code).toBe(0);
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({
        executorId: 'native', modelAlias: 'stub', profileName: 'external-file',
        execution: { selection: { executor: 'native' }, effective: { model: 'stub' }, sources: { model: 'harness-default' } },
      });
      main.accessor.get(IAgentPromptService).abort(native.data.prompt_id);
      await vi.waitFor(() => expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined());

      const external = await postJson<{ prompt_id: string }>(`/api/sessions/${created.data.id}/prompts`, { content: [{ type: 'text', text: 'Select.' }], execution: { executor: 'grok-acp', profile_file: nativePath } });
      expect(external.code).toBe(0);
      expect(main.accessor.get(IAgentProfileService).data()).toMatchObject({
        executorId: 'grok-acp', profileName: 'native-file', execution: { selection: { executor: 'grok-acp' }, sources: { model: 'harness-default' } },
      });
      expect(main.accessor.get(IAgentProfileService).data().modelAlias).toBeUndefined();
      expect(await readFile(externalPath, 'utf8')).toBe(externalText);
      expect(await readFile(nativePath, 'utf8')).toBe(nativeText);
      expect(registered('external-file')).toBe(false);
      expect(registered('native-file')).toBe(false);
      main.accessor.get(IAgentPromptService).abort(external.data.prompt_id);
    } finally { held.finish(); mocked.mockRestore(); }
  }, 60_000);

  it('round-trips identity prompts through REST and exposes bound diagnostics through the typed panel facade', async () => {
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'prompt-main.md'), '---\nname: prompt-main\ndescription: Prompt main\nmain: true\nmodel_alias: stub\n---\nRole body.\n');
    const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'prompt-main' } });
    expect(created.code).toBe(0);
    const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
    try {
      const list = async () => listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(home)}`)).data).items.find((i) => i.name === 'prompt-main')!;
      const initial = await list();
      const patch = (changes: Record<string, unknown>) => patchJson('/api/agents/prompt-main', { workspace_id: initial.workspace_id, scope: 'user', ...changes });
      const model = { alias: 'stub', prompt_mode: 'append', prompt: 'COMMON BODY', main: { prompt_mode: 'append', prompt: 'MAIN BODY' }, independent: 'off', prompt_overrides: { fields: { 'system.shared': 'MODEL FIELD' }, main: 'off' } };
      expect(await patch({ prompt_overrides: { files: ['missing-common.toml'], fields: { 'system.shared': 'ROLE FIELD' }, main: { fields: { 'system.shared': 'MAIN FIELD' } } }, model_profiles: [model], allowed_subagents: [{ name: 'explore', model_prompts: 'replace', model_profiles: [{ alias: 'stub', prompt_overrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] }] })).toMatchObject({ code: 0 });
      expect(await list()).toMatchObject({ prompt_overrides: { main: { fields: { 'system.shared': 'MAIN FIELD' } } }, model_profiles: [model], allowed_subagents: [{ name: 'explore', model_prompts: 'replace', model_profiles: [{ prompt_overrides: { fields: { 'system.shared': 'LEASE FIELD' } } }] }] });
      expect(await patch({ model_profiles: [{ alias: 'stub', when: 'Updated menu only' }] })).toMatchObject({ code: 0 });
      expect((await list()).model_profiles?.[0]).toMatchObject(model);
      const unchecked = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' });
      expect(unchecked.prompt?.file_checks).toBeUndefined();
      const checked = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main', check_all_prompt_files: true });
      expect(checked.prompt?.file_checks).toMatchObject([{ surface: 'profile', branch: 'common', path: 'missing-common.toml', status: 'error' }]);
      expect(checked.prompt?.binding_revision).toBe(unchecked.prompt?.binding_revision);
      const rawCheck = await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main&check_all_prompt_files=true`);
      expect(agentCapabilitiesResponseSchema.parse(rawCheck.data).prompt?.file_checks).toEqual(checked.prompt?.file_checks);
      expect(await patch({ model_profiles: [{ alias: 'stub', prompt: null }] })).not.toMatchObject({ code: 0 });
      expect(await patch({ model_profiles: [{ alias: 'stub', main: null, independent: null, prompt_mode: null, prompt: null, prompt_overrides: null }], prompt_overrides: null, allowed_subagents: [{ name: 'explore', model_prompts: 'preserve' }] })).toMatchObject({ code: 0 });
      const cleared = await list();
      expect(cleared.prompt_overrides).toBeUndefined();
      for (const field of ['main', 'independent', 'prompt', 'prompt_mode', 'prompt_overrides']) expect(cleared.model_profiles?.[0]).not.toHaveProperty(field);
      const live = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' });
      expect(live.prompt).toMatchObject({ identity: { delegation_position: 'main', model_alias: 'stub', executor: 'native' }, apply_on: 'next-binding-or-context-rebuild' });
      await server.core.accessor.get(ISessionManager).close(created.data.id);
      const cold = await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main', check_all_prompt_files: true });
      expect(cold.live).toBe(false);
      expect(cold.prompt?.binding_revision).toBe(live.prompt?.binding_revision);
      expect(cold.prompt?.file_checks).toEqual([]);
    } finally { await klient.close(); }
  });

  it('persists explicit context groups, lists managed adapter releases, and round-trips spawn constraints', async () => {
    await mkdir(join(home, 'agents'), { recursive: true });
    const ctxPath = join(home, 'agents', 'context-main.md');
    const revPath = join(home, 'agents', 'cap-reviewer.md');
    await writeFile(ctxPath, '---\nname: context-main\ndescription: External main\nmain: true\nexecutor: claude-acp\n---\nPrompt.\n');
    await writeFile(revPath, '---\nname: cap-reviewer\ndescription: Reviews changes\nexecutor: codex-app-server\n---\nReview changes.\n');
    expect((await postJson('/api/sessions', { metadata: { cwd: home } })).code).toBe(0);

    const listNamed = async () => listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(home)}&effective=true`)).data).items;
    const initialCtx = (await listNamed()).find((p) => p.name === 'context-main')!;
    expect(initialCtx.kiki_context).toBeUndefined();
    for (const groups of [['memory', 'board', 'cron', 'threads', 'history', 'hooks'], [], null] as const) {
      expect((await patchJson('/api/agents/context-main', { scope: 'user', workspace_id: initialCtx.workspace_id, kiki_context: groups })).code).toBe(0);
      expect((await listNamed()).find((p) => p.name === 'context-main')?.kiki_context).toEqual(groups ?? undefined);
      if (groups === null) expect(await readFile(ctxPath, 'utf8')).not.toContain('kiki_context:');
      else expect(await readFile(ctxPath, 'utf8')).toContain('kiki_context:');
    }

    const adapters = await getJson<{ items: Array<{ id: string; release: { version: string }; phase: string; active?: unknown }> }>('/api/executors/installations');
    expect(adapters.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-acp', release: expect.objectContaining({ version: '0.84.0' }), phase: 'idle' }),
      expect.objectContaining({ id: 'codex-acp', release: expect.objectContaining({ version: '2.0.0' }), phase: 'idle' }),
    ]));
    expect((await postJson('/api/executors/constructor/install')).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);

    const executors = await getJson<{ items: Array<{ id: string; label: string; protocol: string; status: string }> }>('/api/executors');
    expect(executors.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'native', label: 'Kiki', status: 'ready' }),
      expect.objectContaining({ id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server' }),
    ]));
    const rev = (await listNamed()).find((i) => i.name === 'cap-reviewer')!;
    expect(rev.executor_fields).toMatchObject({ prompt: { state: 'mapped' }, pinned_model_alias: { state: 'mapped' }, tools: { state: 'ignored' }, spawn_constraints: { state: 'applied' } });
    const patched = await patchJson('/api/agents/cap-reviewer', { workspace_id: rev.workspace_id, scope: 'user', spawn_constraints: { allowed_models: ['provider/model'], disallowed_tools: ['Bash'] } });
    expect(patched).toMatchObject({ code: 0, data: { spawn_constraints: { allowed_models: ['provider/model'], disallowed_tools: ['Bash'] } } });
    expect(await readFile(revPath, 'utf8')).toContain('spawn_constraints:');
    const cleared = await patchJson('/api/agents/cap-reviewer', { workspace_id: rev.workspace_id, scope: 'user', spawn_constraints: null });
    expect(cleared.code).toBe(0);
    expect(cleared.data).not.toHaveProperty('spawn_constraints');
  });

  it('lists composer profiles without waiting for legacy discovery or unrelated skill discovery', async () => {
    const cwd = await nextWorkspace('composer-project');
    await mkdir(join(cwd, '.kiki', 'agents'), { recursive: true });
    const file = join(cwd, '.kiki', 'agents', 'example-lead.md');
    await writeFile(file, '---\nname: example-lead\ndescription: Example lead\nmain: true\ntools: [Read]\n---\nExample prompt.\n');
    const registry = server.core.accessor.get(IWorkspaceService);
    const listing = vi.spyOn(registry, 'list').mockImplementation(() => new Promise(() => {}));
    const touched = vi.spyOn(registry, 'createOrTouch');
    const skills = vi.spyOn(RuntimeSkillDiscovery.prototype, 'discover').mockImplementation(() => new Promise(() => {}));
    const client = createKlient({ endpoint: base, token: server.localOwnerToken, timeoutMs: 2000 });
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => client.rest!.agents.list({ cwd, effective: true })));
      for (const r of results) {
        expect(r.complete).toBe(true);
        expect(r.items.find((i) => i.name === 'example-lead')).toMatchObject({ main: true, tools: ['Read'], source: 'workspace' });
      }
      await writeFile(file, '---\nname: updated-lead\ndescription: Updated lead\nmain: true\ntools: [Read, Grep]\n---\nUpdated prompt.\n');
      invalidateCachedAgentFiles(server.core.accessor.get(IHostFileSystem));
      const updated = await client.rest!.agents.list({ cwd, effective: true });
      expect(updated.items.some((i) => i.name === 'example-lead')).toBe(false);
      expect(updated.items.find((i) => i.name === 'updated-lead')).toMatchObject({ tools: ['Read', 'Grep'] });
      await expect(client.rest!.agents.list({ cwd: join(cwd, 'missing'), effective: true })).rejects.toThrow('Workspace does not exist');
      expect(skills).not.toHaveBeenCalled();
      expect(touched).not.toHaveBeenCalled();
    } finally {
      await client.close();
      listing.mockRestore(); skills.mockRestore(); touched.mockRestore();
    }
  });

  it('probes draft directories without registration or Programs and registers once on submit', async () => {
    const cwd = await nextWorkspace('draft-project');
    const otherDraft = await nextWorkspace('draft-plain');
    await mkdir(join(cwd, '.kiki', 'agents'), { recursive: true });
    await mkdir(join(cwd, '.kiki', 'skills', 'draft-skill'), { recursive: true });
    await writeFile(join(cwd, '.kiki', 'agents', 'draft-lead.md'), '---\nname: draft-lead\ndescription: Draft lead\nmain: true\n---\nLead the task.\n');
    await writeFile(join(cwd, '.kiki', 'skills', 'draft-skill', 'SKILL.md'), '---\nname: draft-skill\ndescription: Draft skill\n---\nUse this skill.\n');
    await writeFile(join(cwd, 'example.txt'), 'example');
    const registry = server.core.accessor.get(IWorkspaceService);
    const touched = vi.spyOn(registry, 'createOrTouch');
    const manager = server.core.accessor.get(IWorkspaceInstanceManager);
    const before = await registry.list();
    for (const root of [otherDraft, cwd]) {
      expect((await getJson(`/api/agents?cwd=${encodeURIComponent(root)}&effective=true`)).code).toBe(0);
      const panel = await getJson(`/api/agents/capabilities?cwd=${encodeURIComponent(root)}&profile=${root === cwd ? 'draft-lead' : 'agent'}`);
      expect(panel.code).toBe(0);
      if (root === cwd) expect(agentCapabilitiesResponseSchema.parse(panel.data).skills?.some((s) => s.name === 'draft-skill')).toBe(true);
      expect((await postJson('/api/workspace/fs:search', { workspace: root, query: 'example' })).code).toBe(0);
      expect((await postJson('/api/workspace/fs:suggest', { workspace: root, query: 'example' })).code).toBe(0);
      expect((await postJson(`/api/sessions/${encodeURIComponent(root)}/fs:search`, { query: 'example' })).code).toBe(0);
    }
    expect(touched).not.toHaveBeenCalled();
    expect(await registry.list()).toEqual(before);
    expect(manager.findByRoot(cwd)).toBeUndefined();
    expect((await getJson(`/api/agents?cwd=${encodeURIComponent(join(cwd, 'missing'))}&effective=true`)).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect((await getJson(`/api/agents?cwd=${encodeURIComponent(join(cwd, 'example.txt'))}&effective=true`)).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect((await postJson('/api/workspace/fs:suggest', { workspace: join(cwd, 'missing'), query: 'example' })).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect((await postJson('/api/sessions', { metadata: { cwd }, agent_config: { profile: 'draft-lead' } })).code).toBe(0);
    expect(touched).toHaveBeenCalledTimes(1);
    const registered = (await registry.list()).find((w) => w.root === cwd)!;
    expect(registered).toBeDefined();
    const equivalentCwd = process.platform === 'win32' ? `${cwd.toUpperCase().replaceAll('\\', '/')}/` : `${cwd}/`;
    expect((await postJson('/api/sessions', { workspace_id: registered.id, metadata: { cwd: equivalentCwd } })).code).toBe(0);
    expect((await postJson('/api/sessions', { workspace_id: registered.id, metadata: { cwd: join(cwd, 'other') } })).code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('preserves subagent policies, previews ordered external prompts, and reuses draft catalog projections', async () => {
    const ws = await nextWorkspace('preview-prompt');
    await mkdir(join(ws, '.kiki', 'agents'), { recursive: true });
    await writeFile(join(ws, 'AGENTS.md'), 'Workspace policy for preview.\n');
    await writeFile(join(ws, '.kiki', 'agents', 'inherited-policy.md'), '---\nname: inherited-policy\ndescription: Inherits\n---\nBody.\n');
    await writeFile(join(ws, '.kiki', 'agents', 'strict-policy.md'), '---\nname: strict-policy\ndescription: Strict\nallowed_subagents: [explore]\n---\nBody.\n');
    await writeFile(join(ws, '.kiki', 'agents', 'advisory-policy.md'), '---\nname: advisory-policy\ndescription: Advisory\npreferred_subagents: [explore]\n---\nBody.\n');
    await mkdir(join(home, 'agents'), { recursive: true });
    await writeFile(join(home, 'agents', 'ext-reviewer.md'), [
      '---', 'name: ext-reviewer', 'description: Reviews changes', 'executor: codex-app-server',
      'executor_prompt:', '  delivery: replace', '  include: [agents_md, workspace_info]',
      '  body: Codex-only instructions', '  append: Final instruction', '---', 'Profile fallback.', '',
    ].join('\n'));
    invalidateCachedAgentFiles(server.core.accessor.get(IHostFileSystem));
    const wsReg = await server.core.accessor.get(IWorkspaceService).createOrTouch(ws);
    const profiles = listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(ws)}&effective=true`)).data).items;
    expect(profiles.find((p) => p.name === 'inherited-policy')).not.toHaveProperty('subagent_policy');
    expect(profiles.find((p) => p.name === 'strict-policy')).toMatchObject({ allowed_subagents: ['explore'] });
    expect(profiles.find((p) => p.name === 'advisory-policy')).toMatchObject({ preferred_subagents: ['explore'] });
    expect(profiles.find((p) => p.name === 'advisory-policy')).not.toHaveProperty('allowed_subagents');

    const result = await postJson<import('@kiki/protocol').ExecutorPromptPreviewResponse>('/api/agents/ext-reviewer/executor-prompt:preview', { workspace: wsReg.id });
    expect(result.code).toBe(0);
    expect(result.data.delivery).toEqual({ requested: 'replace', actual: 'replace', downgraded: false });
    expect(result.data.blocks.map((b) => b.id)).toEqual(['body', 'append', 'agents_md', 'workspace_info']);
    expect(result.data.blocks[0]?.text).toBe('Codex-only instructions');
    expect(result.data.blocks[2]?.text).toContain('Workspace policy for preview.');
    const downgraded = await postJson<import('@kiki/protocol').ExecutorPromptPreviewResponse>('/api/agents/ext-reviewer/executor-prompt:preview', { workspace: wsReg.id, executor: 'claude-acp' });
    expect(downgraded.data.delivery).toEqual({ requested: 'replace', actual: 'preamble', downgraded: true });
    expect((await postJson('/api/agents/ext-reviewer/executor-prompt:preview', { workspace: wsReg.id, executor: 'native' })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await postJson('/api/agents/ext-reviewer/executor-prompt:anything', { workspace: wsReg.id })).code).toBe(ErrorCode.VALIDATION_FAILED);

    const catWs = await nextWorkspace('catalog-cache');
    const info = vi.spyOn(server.core.accessor.get(ILogService), 'info');
    const [first, second] = await Promise.all([acquireWorkspaceProfileCatalog(server.core, { cwd: catWs }), acquireWorkspaceProfileCatalog(server.core, { cwd: catWs })]);
    const cached = await acquireWorkspaceProfileCatalog(server.core, { cwd: catWs });
    expect(first?.catalog).toBe(second?.catalog);
    expect(first?.catalog).toBe(cached?.catalog);
    expect(info).toHaveBeenCalledWith('workspace profile catalog acquisition completed', expect.objectContaining({ cache_state: 'hit', outcome: 'ready' }));
    await Promise.all([first?.dispose(), second?.dispose(), cached?.dispose()]);
    const manager = server.core.accessor.get(IWorkspaceInstanceManager);
    expect(manager.referenceCount(first!.workspaceId)).toBe(0);
    await manager.close(first!.workspaceId);
    const reopened = await acquireWorkspaceProfileCatalog(server.core, { cwd: catWs });
    expect(reopened?.catalog).not.toBe(first?.catalog);
    await reopened?.dispose();
  });

  it('answers capabilities on live, cold, and disposed-child sessions and enforces child tool restrictions', async () => {
    const ws = await nextWorkspace('cap-live-cold');
    await mkdir(join(ws, '.kiki', 'agents'), { recursive: true });
    await writeFile(join(ws, '.kiki', 'agents', 'board-default.md'), '---\nname: board-default\ndescription: Default tools\n---\nDefault policy.');
    await writeFile(join(ws, '.kiki', 'agents', 'bad-board.md'), '---\nname: bad-board\ndescription: Bad board\ntools: [Read, BoardRead]\n---\nBad.');
    const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: ws }, agent_config: { profile: 'agent', model: 'stub', thinking: 'low' } });
    expect(created.code).toBe(0);
    const manager = server.core.accessor.get(ISessionManager);
    const session = manager.get(created.data.id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);

    const liveMain = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`)).data);
    expect(liveMain).toMatchObject({
      context: 'live', live: true, owner: { agent_id: 'main', profile: 'agent' },
      profile: { name: 'agent', source: 'user', model: 'stub', model_source: 'profile', thinking_effort: 'low', effort_source: 'model', can_spawn_subagents: true },
    });
    expect(liveMain.profile?.source_file?.replaceAll('\\', '/')).toMatch(/agents\/builtin\/agent\.md$/);

    const child = await lifecycle.create({ agentId: 'agent-snapshot', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'explore', model: 'stub', thinking: 'low' } });
    await child.accessor.get(IAgentProfileService).setModel('stub-alt');
    child.accessor.get(IAgentProfileService).setThinking('high');
    const liveChild = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=agent-snapshot`)).data);
    expect(liveChild).toMatchObject({ context: 'live', live: true, profile: { name: 'explore', model: 'stub-alt', thinking_effort: 'high', can_spawn_subagents: false } });
    await lifecycle.remove('agent-snapshot');
    const snapChild = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=agent-snapshot`)).data);
    expect(snapChild).toMatchObject({ context: 'live', live: false, available: true, owner: { agent_id: 'agent-snapshot', profile: 'explore' }, profile: { model: 'stub-alt', thinking_effort: 'high' } });
    expect(snapChild.tools?.every((t) => t.state === 'unknown' || t.state === 'disabled')).toBe(true);

    await lifecycle.create({ agentId: 'child-optin', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'board-default', model: 'stub' } });
    const liveTools = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=child-optin`)).data).tools ?? [];
    expect(liveTools.find((t) => t.name === 'BoardRead')).toBeUndefined();
    expect(liveTools.find((t) => t.name === 'AskUserQuestion')?.state).toBe('disabled');
    expect(liveTools.find((t) => t.name === 'Read')?.state).toBe('enabled');
    await lifecycle.remove('child-optin');
    const deadTools = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=child-optin`)).data).tools ?? [];
    expect(deadTools.find((t) => t.name === 'BoardRead')).toBeUndefined();
    expect(deadTools.find((t) => t.name === 'Read')?.state).toBe('unknown');

    await expect(lifecycle.create({ agentId: 'child-named', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'bad-board', model: 'stub' } })).rejects.toThrow(/Tool pattern "BoardRead".*never activate/);

    await manager.close(created.data.id);
    expect(manager.get(created.data.id)).toBeUndefined();
    const coldMain = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`)).data);
    expect(coldMain).toMatchObject({ live: false, available: true, profile: { name: 'agent', model: 'stub' } });
    expect(manager.get(created.data.id)).toBeUndefined();
  });

  it('creates an external main session without a Kiki model pin and projects live launch admission from pure dispatch policy', async () => {
    const executors = server.core.accessor.get(IAgentExecutorRegistry);
    const resolve = executors.resolveExecutable.bind(executors);
    vi.spyOn(executors, 'resolveExecutable').mockImplementation(async (id, options) => id === 'grok-acp'
      ? {
          descriptor: { ...executors.get(id)!, command: process.execPath, revision: 'fixture' }, options: executors.resolve(id, options ?? {}).options,
          provider: { id: 'fixture-acp', protocol: 'acp-v1', validateOptions: (v) => v as Record<string, string | number | boolean>, validateBinding: (b) => ({ ok: true, binding: b }), create: () => { throw new Error('no launch'); } },
        }
      : resolve(id, options));
    const extReg = server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'external-main-fixture', priority: 50,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external-main', definitionId: 'external-main-fixture', main: true, executor: 'grok-acp', systemPrompt: () => '' })] },
    });
    try {
      const extCreated = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'external-main' } });
      expect(extCreated.code).toBe(0);
      const extMain = server.core.accessor.get(ISessionManager).get(extCreated.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
      expect(extMain.data()).toMatchObject({ executorId: 'grok-acp', thinkingLevel: 'off', systemPrompt: '' });
      expect(extMain.data().modelAlias).toBeUndefined();
      expect(extMain.isRunnable()).toBe(true);
    } finally { await extReg.dispose(); vi.restoreAllMocks(); }

    const admReg = server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'admission-example', priority: 50,
      contribution: {
        profiles: [
          normalizeAgentProfile({ name: 'lead-adm', main: true, tools: ['AgentRun'], allowedSubagents: ['native-helper', 'external-helper'], systemPrompt: () => '' }),
          ...['native', 'external'].map((executor) => normalizeAgentProfile({ name: `${executor}-helper`, executor, modelAlias: 'stub', systemPrompt: () => '' })),
        ],
      },
    });
    try {
      const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'lead-adm', model: 'stub' } });
      expect(created.code).toBe(0);
      const session = server.core.accessor.get(ISessionManager).get(created.data.id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const agent = lifecycle.get('main')!;
      const dispatch = session.accessor.get(ISessionDispatchService);
      const read = async (q = `session_id=${created.data.id}&agent_id=main`) => agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?${q}`)).data);

      const before = await read();
      expect(before.targets.find((t) => t.executor === 'native')).toMatchObject({ launch_allowed: true });
      expect(before.targets.find((t) => t.executor === 'external')).toMatchObject({ launch_allowed: true });
      const interactions = session.accessor.get(ISessionInteractionService);
      const pending = interactions.enqueue({ kind: 'approval', origin: { agentId: 'main' }, payload: { toolName: 'AgentRun' } });
      expect((await read()).tools?.find((t) => t.name === 'AgentRun')).toMatchObject({ state: 'approval-required', unavailable_reason_code: 'approval_pending' });
      interactions.respond(pending.id, { decision: 'cancelled' });

      const usage = agent.accessor.get(IAgentUsageService);
      usage.record('unpriced-fixture-model', { inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 }, undefined, { usageKnown: true });
      expect((await read()).metrics?.['main']).toMatchObject({ inputTokens: 15, totalTokens: 20, totalCostUsd: null });
      usage.record('unpriced-fixture-model', { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 }, undefined, { usageKnown: false });
      const sourceRead = vi.spyOn(server.core.accessor.get(IFileSystemStorageService), 'readStream');
      const settleUsage = vi.spyOn(usageRuntime(server.core).service, 'readAgentUsage');
      for (let req = 0; req < 2; req++) {
        const narrow = await read(`session_id=${created.data.id}&agent_id=main&metrics_only=true&metrics_settle=true&metrics_agent_ids=main`);
        expect(narrow.metrics?.['main']).toMatchObject({ totalTokens: 20, usageComplete: true, usagePartial: true, costPartial: true });
        expect(narrow.targets).toEqual([]);
      }
      await agent.accessor.get(IAgentPlanService).enter();
      const policy = dispatch.readLaunchPolicy(agent.id);
      expect(policy.planActive).toBe(true);
      const planned = await read();
      expect(planned.targets.find((t) => t.executor === 'native')).toMatchObject({ launch_allowed: true, execution_restriction: 'research-readonly' });
      expect(planned.targets.find((t) => t.executor === 'external')).toMatchObject({ launch_allowed: false });
      const draft = await read(`workspace_id=${session.accessor.get(ISessionContext).workspaceId}&profile=lead-adm`);
      expect(draft.context).toBe('draft');
      expect(draft.targets.every((t) => t.execution_restriction === undefined)).toBe(true);

      const profSvc = agent.accessor.get(IAgentProfileService);
      const profData = profSvc.data();
      vi.spyOn(profSvc, 'data').mockReturnValue({ ...profData, executionRestriction: 'research-readonly' });
      const readonly = await read();
      expect(readonly).toMatchObject({
        available: false, unavailable_reason_code: evaluateDispatchAdmission(dispatch.readLaunchPolicy(agent.id), 'spawn').reasonCode,
      });
      expect(settleUsage).not.toHaveBeenCalled();
      expect(sourceRead.mock.calls.filter(([, key]) => key === AGENT_WIRE_RECORD_KEY)).toEqual([]);
    } finally { vi.restoreAllMocks(); await admReg.dispose(); }
  });

  it('isolates workspace dispatch targets and projects scoped source leases without exposing private paths', async () => {
    const wsA = await nextWorkspace('iso-a'), wsB = await nextWorkspace('iso-b');
    await Promise.all([mkdir(join(wsA, '.kiki', 'agents'), { recursive: true }), mkdir(join(wsB, '.kiki', 'agents'), { recursive: true }), mkdir(join(wsA, '.git')), mkdir(join(wsB, '.git'))]);
    await writeFile(join(wsA, '.kiki', 'agents', 'workspace-choice.md'), '---\nname: workspace-choice\ndescription: Workspace A choice\nmain: true\n---\nUse A.\n');
    await writeFile(join(wsB, '.kiki', 'agents', 'workspace-choice.md'), '---\nname: workspace-choice\ndescription: Workspace B helper\nmain: false\n---\nUse B.\n');
    await writeFile(join(wsB, '.kiki', 'agents', 'workspace-main.md'), '---\nname: workspace-main\ndescription: Workspace B main\nmain: true\n---\nUse B.\n');
    const wsAId = (await postJson<{ id: string }>('/api/workspaces', { root: wsA })).data.id;
    const wsBId = (await postJson<{ id: string }>('/api/workspaces', { root: wsB })).data.id;

    const scopedA = listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?workspace_id=${encodeURIComponent(wsAId)}`)).data);
    expect(scopedA.items.find((p) => p.name === 'workspace-choice' && p.source === 'workspace')).toMatchObject({ description: 'Workspace A choice', workspace_id: wsAId, main: true });
    const scopedB = listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?workspace_id=${encodeURIComponent(wsBId)}`)).data);
    expect(scopedB.items.find((p) => p.name === 'workspace-choice' && p.source === 'workspace')).toMatchObject({ description: 'Workspace B helper', workspace_id: wsBId, main: false });
    const capsB = await getJson<{ targets: { profile: string }[] }>(`/api/agents/capabilities?workspace_id=${encodeURIComponent(wsBId)}&profile=workspace-main`);
    expect(capsB.data.targets.some((t) => t.profile === 'workspace-choice')).toBe(true);
    expect((await getJson('/api/agents?workspace_id=wd_missing')).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);

    const agentsDir = join(home, 'agents'), privateDir = join(agentsDir, '_private', 'research');
    await mkdir(privateDir, { recursive: true });
    const childPath = join(privateDir, 'writer.md');
    await writeFile(join(agentsDir, 'research-lead.md'), [
      '---', 'name: research-lead', 'description: Coordinates research', 'allowed_subagents:',
      '  - name: research-writer', '    source: ./_private/research/writer.md', '    description: Writes research summaries',
      '  - name: missing-writer', '    source: ./_private/research/missing.md', '---', 'Coordinate.', '',
    ].join('\n'));
    await writeFile(childPath, '---\nname: private-research-writer\ndescription: Internal research writer\n---\nWrite.\n');
    expect((await postJson('/api/sessions', { metadata: { cwd: home } })).code).toBe(0);
    const data = listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents')).data);
    const parent = data.items.find((p) => p.name === 'research-lead' && p.source === 'user');
    expect(parent?.allowed_subagents).toEqual([
      { name: 'research-writer', source: './_private/research/writer.md', scope: 'private', status: 'ready', description: 'Writes research summaries' },
      { name: 'missing-writer', source: './_private/research/missing.md', scope: 'private', status: 'unavailable', diagnostic: 'Source profile is unavailable', diagnostic_code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE },
    ]);
    expect(data.items.some((p) => p.name === 'private-research-writer')).toBe(false);
    expect(JSON.stringify(parent?.allowed_subagents)).not.toContain(childPath.replaceAll('\\', '/'));
    expect((await getJson(`/api/agents/capabilities?cwd=${encodeURIComponent(home)}&profile=research-writer&caller_profile=research-lead`)).code).toBe(0);
    expect((await getJson(`/api/agents/capabilities?cwd=${encodeURIComponent(home)}&profile=missing-writer&caller_profile=research-lead`)).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
    expect((await getJson(`/api/agents/capabilities?cwd=${encodeURIComponent(home)}&profile=private-research-writer`)).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);

    const parentDefId = 'definition:offline-lead';
    const readyLease = { name: 'offline-writer', source: './_private/writer.md' } as const;
    const unavailLease = { name: 'missing-writer', source: './_private/missing.md' } as const;
    const offlineReg = server.core.accessor.get(IAgentProfileRegistry).register({
      sourceId: 'workspace', priority: 30, workspaceKey: 'wd_offline',
      contribution: {
        profiles: [normalizeAgentProfile({ name: 'offline-lead', definitionId: parentDefId, allowedSubagents: [readyLease.name, unavailLease.name], subagentLeases: { [readyLease.name]: readyLease, [unavailLease.name]: unavailLease }, systemPrompt: () => '' })],
        scopedBindings: new Map([[parentDefId, new Map([
          [readyLease.name, { parentDefinitionId: parentDefId, alias: readyLease.name, source: readyLease.source, lease: readyLease, status: 'ready' as const, sourceDefinitionId: 'C:/Users/private/_private/writer.md' }],
          [unavailLease.name, { parentDefinitionId: parentDefId, alias: unavailLease.name, source: unavailLease.source, lease: unavailLease, status: 'unavailable' as const, diagnostic: { code: AgentProfileSourceDiagnosticCodes.UNAVAILABLE, severity: 'error' as const, message: 'Scoped source C:/Users/private/_private/missing.md is unavailable', path: 'C:/Users/private/_private/missing.md' } }],
        ])]]),
      },
    });
    try {
      const offlineBody = listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents')).data);
      const offlineParent = offlineBody.items.find((i) => i.name === 'offline-lead' && i.source === 'workspace');
      expect(JSON.stringify(offlineParent?.allowed_subagents)).not.toContain('C:/Users/private');
    } finally { await offlineReg.dispose(); }
  });

  it('creates, duplicates, validates non-editable PATCH fields, patches role/subagent fields, and manages shipped templates', async () => {
    expect((await postJson('/api/sessions', { metadata: { cwd: home } })).code).toBe(0);
    const workspaceId = listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents')).data).items.find((p) => p.source === 'user')?.workspace_id;
    expect(workspaceId).toBeTruthy();

    const createProfile = (body: Record<string, unknown>) => postJson('/api/agent-profiles', { workspace_id: workspaceId, scope: 'user', ...body });
    const created = await createProfile({
      name: 'custom-reviewer', description: 'Review carefully', when_to_use: 'After changes',
      main: false, pinned_model_alias: 'inherit', recipe: 'example', recipe_options: { research: true }, tools: ['Read'], prompt: 'Inspect the candidate.',
    });
    expect(created.code).toBe(0);
    const customPath = join(home, 'agents', 'custom-reviewer.md');
    expect(await readFile(customPath, 'utf8')).toContain('recipe: example');
    expect((await createProfile({ name: 'custom-reviewer', description: 'overwrite', prompt: 'No' })).code).toBe(ErrorCode.AGENT_PROFILE_ALREADY_EXISTS);
    expect((await createProfile({ name: '../escape', description: 'invalid', prompt: 'No' })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect((await createProfile({ name: 'custom-copy', template: 'duplicate:custom-reviewer' })).code).toBe(0);

    const patchedCustom = await patchJson('/api/agents/custom-reviewer', { workspace_id: workspaceId, scope: 'user', recipe: 'updated-example', recipe_options: { research: false }, prompt: 'Revised\nsecond line.' });
    expect(patchedCustom).toMatchObject({ code: 0, data: { prompt: 'Revised\nsecond line.', recipe: 'updated-example', recipe_options: { research: false } } });

    const nonEditable = await patchJson('/api/agents/custom-reviewer', { scope: 'user', workspace_id: workspaceId, executor_fields: { tools: { state: 'applied' } } });
    expect(nonEditable.code).toBe(40001);
    expect(nonEditable.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.stringMatching(/executor_fields|^$/) })]));

    expect((await createProfile({ name: 'team-lead', description: 'Lead', prompt: 'Lead the team.' })).code).toBe(0);
    const patchedLead = await patchJson('/api/agents/team-lead', {
      workspace_id: workspaceId, scope: 'user', main: true, restrict_models_to_menu: true,
      allowed_models: ['fixture/a'], allowed_efforts: ['max'], can_spawn_subagents: true, preferred_subagents: ['explore'], deny_subagents: ['blocked'],
      allowed_subagents: ['explore', { name: 'reviewer', model_alias: 'fixture/b', thinking_effort: 'high' }],
      model_profiles: [{ alias: 'fixture/a', when: 'long tasks', thinking_effort: 'max' }],
    });
    expect(patchedLead.code).toBe(0);
    expect(patchedLead.data).toMatchObject({ main: true, restrict_models_to_menu: true, allowed_models: ['fixture/a'], preferred_subagents: ['explore'], deny_subagents: ['blocked'] });

    const listShipped = async () => listShippedAgentProfilesResponseSchema.parse((await getJson('/api/agents/shipped')).data).items;
    const managed = (await listShipped()).filter((i) => i.managed);
    expect(managed.map((i) => i.template_id).toSorted()).toEqual(['agent', 'explore', 'general']);
    const agentEdit = await patchJson('/api/agents/agent', { scope: 'user', workspace_id: workspaceId, description: 'edited shipped copy' });
    expect(agentEdit.code).toBe(0);
    expect((await listShipped()).find((i) => i.template_id === 'agent')).toMatchObject({ managed: true, status: 'custom' });
    expect((await postJson<{ status: string }>('/api/agents/shipped/agent:restore', {})).data.status).toBe('clean');

    const generalPath = managed.find((i) => i.template_id === 'general')!.active_path!;
    const origGeneral = SHIPPED_AGENT_PROFILE_TEMPLATES.find((t) => t.id === 'general')!.text;
    try {
      await writeFile(generalPath, `${origGeneral}\nlocal tweak\n`);
      expect((await listShipped()).find((i) => i.template_id === 'general')?.status).toBe('custom');
      expect((await postJson('/api/agents/shipped/general:restore', {})).code).toBe(0);
      const backups = await readdir(join(home, 'agent-profile-state', 'backups'));
      expect(backups.some((n) => n.includes('general'))).toBe(true);
      await rm(generalPath);
      expect((await listShipped()).find((i) => i.template_id === 'general')?.status).toBe('removed');
      expect((await postJson('/api/agents/shipped/general:restore', {})).code).toBe(0);
      expect((await listShipped()).find((i) => i.template_id === 'general')?.status).toBe('clean');
      expect((await postJson('/api/agents/shipped/nope:restore', {})).code).toBe(ErrorCode.VALIDATION_FAILED);
      expect((await postJson('/api/agents/shipped/general:frobnicate', {})).code).toBe(ErrorCode.VALIDATION_FAILED);
    } finally {
      await postJson('/api/agents/shipped/agent:restore', {}).catch(() => undefined);
      await postJson('/api/agents/shipped/general:restore', {}).catch(() => undefined);
    }
  });
});

describe('GET /api/agents (isolated config, SYSTEM.md, and restart proofs)', () => {
  it('saves and re-reads subagent tool settings without overriding global or parent restrictions', async () => {
    const configText = '[search]\nenabled = false\n[cron]\nmanualTick = true\n[tools]\ndisabled = ["Bash"]\n';
    await withProfileHost(async (home) => {
      await writeFile(join(home, 'config.toml'), configText);
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'example-tool-reader.md'), [
        '---', 'name: example-tool-reader', 'description: Fixture tool reader', 'tools: [Bash, Read, AskUserQuestion]',
        'disallowedTools: [Write]', 'spawn_constraints:', '  disallowed_tools: [Edit]', '---', 'Keep this fixture prompt.', '',
      ].join('\n'));
      await writeFile(join(home, 'agents', 'example-external.md'), '---\nname: example-external\ndescription: External\nexecutor: claude-acp\ntools: [Bash]\ndisallowedTools: [Read]\n---\nExternal.\n');
    }, async ({ home, server, base }) => {
      await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
      const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
      try {
        const rest = klient.rest!;
        const initialCatalog = await rest.agents.list({ cwd: home, effective: true });
        const initial = initialCatalog.items.find((i) => i.name === 'example-tool-reader')!;
        const external = initialCatalog.items.find((i) => i.name === 'example-external')!;
        expect(subagentProfileToolFields(external)).toMatchObject([
          { field: 'tools', executor: 'claude-acp', applicability: 'ignored' },
          { field: 'disallowed_tools', applicability: 'ignored' },
        ]);
        const client = { updateNamedAgentProfile: rest.agents.update, listNamedAgentProfiles: rest.agents.list };
        const denied = await saveSubagentProfileToolSettings(client, initial, { tools: initial.tools!, disallowedTools: ['Write', 'Bash'] });
        expect(denied.disallowed_tools).toEqual(['Write', 'Bash']);
        const allowed = await saveSubagentProfileToolSettings(client, denied, { tools: ['Read', 'Bash'], disallowedTools: ['Write'] });
        expect(allowed).toMatchObject({ tools: ['Read', 'Bash'], disallowed_tools: ['Write'] });
        expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(configText);
        const panel = await klient.global.agentPanel.read({ workspace_id: initial.workspace_id!, profile: initial.name });
        expect(panel.tools?.find((t) => t.name === 'Bash')).toMatchObject({ state: 'disabled', unavailable_reason_code: 'draft_policy_disabled' });
        expect(subagentSessionToolStates(panel, undefined)).toBeUndefined();
        expect(subagentSessionToolStates(panel, 'main')).toBeUndefined();
        const layers = { profile: { tools: allowed.tools, disallowedTools: allowed.disallowed_tools }, global: { disabled: ['Bash'] }, subagent: { explicitProfileTools: allowed.tools, allowedTools: ['AskUserQuestion', 'BoardRead'] } };
        expect(isToolActiveComposed(layers, 'Bash')).toBe(false);
        expect(isToolActiveComposed({ ...layers, profile: { tools: ['AskUserQuestion'] } }, 'AskUserQuestion')).toBe(true);
        expect(isToolActiveComposed({ ...layers, profile: { tools: ['AskUserQuestion'] } }, 'MemoryWrite')).toBe(false);
        const empty = await saveSubagentProfileToolSettings(client, allowed, { tools: [], disallowedTools: [] });
        expect(subagentProfileToolDraft(empty)).toEqual({ tools: [], disallowedTools: [] });
        const inherited = await saveSubagentProfileToolSettings(client, empty, { tools: null, disallowedTools: null });
        expect(subagentProfileToolDraft(inherited)).toEqual({ tools: null, disallowedTools: null });
        expect(searchSubagentToolCatalog((await rest.runtime.listTools()).tools, 'Bash')).toEqual([]);
      } finally { await klient.close(); }
    });
  });

  it('previews unsaved canonical menu changes and keeps live and cold model domains frozen', async () => {
    await withProfileHost(async (home) => {
      await writeFile(join(home, 'config.toml'), [
        'default_model = "fixture/a"', '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
        ...['a', 'b', 'c'].flatMap((a) => [`[models."fixture/${a}"]`, 'provider = "stub"', `model = "${a}"`, 'max_context_size = 1000']),
        '[subagent]', 'deny_models = ["fixture/a"]',
      ].join('\n'));
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'menu-main.md'), [
        '---', 'name: menu-main', 'description: Menu main', 'main: true', 'model_alias: a', 'restrict_models_to_menu: true',
        'model_profiles:', '  - alias: b', '    when: advisory only', '    deny_models: [b]', '---', 'Prompt.', '',
      ].join('\n'));
    }, async ({ home, server, base, getJson, postJson, patchJson }) => {
      await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
      const list = async () => listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(home)}&effective=true`)).data).items.find((i) => i.name === 'menu-main')!;
      const initial = await list();
      expect(initial).toMatchObject({ restrict_models_to_menu: true, declared_model_menu: { aliases: ['b'], default_alias: 'a', identities: ['fixture/b', 'fixture/a'] }, effective_model_aliases: ['fixture/a', 'a'] });
      const preview = async (draft: import('@kiki/protocol').AgentModelMenuDraft) => (await postJson<import('@kiki/protocol').AgentModelMenuPreviewResponse>('/api/agents/menu-main/model-menu:preview', { workspace_id: initial.workspace_id, source_file: initial.source_file, draft })).data;
      expect(await preview({ pinned_model_alias: 'fixture/a' })).toMatchObject({ added_model_identities: [], removed_model_identities: [] });
      const draft = { pinned_model_alias: 'c', model_profiles: [{ alias: 'b' }] };
      expect(await preview(draft)).toEqual({
        restrict_models_to_menu: true, declared_model_menu: { aliases: ['b'], default_alias: 'c', identities: ['fixture/b', 'fixture/c'] },
        effective_model_aliases: ['fixture/c', 'c'], model_constraints_active: true, added_model_identities: ['fixture/c'], removed_model_identities: ['fixture/a'],
      });
      expect((await preview({ main: false })).effective_model_aliases).toEqual([]);
      const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'menu-main', model: 'fixture/c' } });
      const manager = server.core.accessor.get(ISessionManager);
      const mainBinding = manager.get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
      expect(mainBinding.data()).toMatchObject({ modelAlias: 'fixture/c', bindingAdvisories: [expect.objectContaining({ code: 'model_not_allowed' })] });
      await mainBinding.setModel('fixture/b');
      expect(mainBinding.data()).toMatchObject({ modelAlias: 'fixture/b', bindingAdvisories: [expect.objectContaining({ code: 'model_denied' })] });
      await mainBinding.setModel('fixture/a');
      expect(mainBinding.data().bindingAdvisories).toEqual([]);
      expect((await patchJson('/api/agents/menu-main', { workspace_id: initial.workspace_id, scope: 'user', source_file: initial.source_file, ...draft })).code).toBe(0);
      const readFrozen = async () => agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`)).data);
      expect((await readFrozen()).profile).toMatchObject({ declared_model_menu: initial.declared_model_menu, effective_model_aliases: initial.effective_model_aliases });
      await manager.close(created.data.id);
      const cold = await readFrozen();
      expect(cold.live).toBe(false);
      expect(cold.profile).toMatchObject({ declared_model_menu: initial.declared_model_menu, effective_model_aliases: initial.effective_model_aliases });
      expect(manager.get(created.data.id)).toBeUndefined();
      const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
      try { expect((await klient.global.agentPanel.read({ session_id: created.data.id, agent_id: 'main' })).profile).toEqual(cold.profile); }
      finally { await klient.close(); }
    });
  });

  it('installs and rolls back the selected source-owned adapter without changing executor config', async () => {
    let adapterDir = '', script = '';
    await withProfileHost(async (home) => {
      adapterDir = join(home, 'tools', 'agy-cli-adapter-909');
      script = join(adapterDir, 'agy-cli-acp.mjs');
      await mkdir(join(adapterDir, 'audit'), { recursive: true });
      await writeFile(script, 'export const legacy = "pre-mcp";\n');
      await writeFile(join(adapterDir, 'agy-file-admission.mjs'), 'export const admission = true;\n');
      await writeFile(join(adapterDir, 'agy-cli-audit-acp.mjs'), 'audit-copy\n');
      await writeFile(join(adapterDir, 'audit', 'session.ndjson'), '{"keep":true}\n');
      await writeFile(join(home, 'config.toml'), [
        '[agent_executors."agy-cli-909"]', 'protocol = "acp-v1"', 'args = []', 'source = "local-adapter"', 'supports_mcp = false',
        '[agent_executors."agy-cli-909".env]', 'KEEP_ME = "retain-adapter-env"',
        '[[agent_executors."agy-cli-909".sources]]', 'id = "local-adapter"', 'kind = "node-script"', `path = "${script.replaceAll('\\', '/')}"`,
        '[agent_executors."not-owned"]', 'protocol = "acp-v1"', 'args = []', 'source = "path"',
        '[[agent_executors."not-owned".sources]]', 'id = "path"', 'kind = "path-lookup"', 'command = "agy"', '',
      ].join('\n'));
      const env = { ...process.env };
      delete env[SOURCE_OWNED_ADAPTER_ROOT_ENV];
      return { env };
    }, async ({ home, server, postJson }) => {
      expect((await postJson('/api/executors/not-owned/install')).code).toBe(ErrorCode.AGENT_PROFILE_NOT_FOUND);
      const body = await postJson<{ release: { source: string; entry: string }; active?: { version: string } }>('/api/executors/agy-cli-909/install');
      expect(body.code).toBe(0);
      expect(body.data.release).toMatchObject({ source: 'bundled:external-harness', entry: 'agy-cli-acp.mjs' });
      expect(body.data.active?.version).toBe('0.5.1');
      expect(await readFile(script, 'utf8')).toBe(await readFile(new URL('../../../scripts/external-harness/agy-cli-acp.mjs', import.meta.url), 'utf8'));
      expect((await server.core.accessor.get(IManagedAdapterService).status('agy-cli-909')).supportsMcp).toBe(true);
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('supports_mcp = false');
      expect((await postJson('/api/executors/agy-cli-909/rollback')).code).toBe(0);
      expect(await readFile(script, 'utf8')).toBe('export const legacy = "pre-mcp";\n');
      expect(await readFile(join(adapterDir, 'audit', 'session.ndjson'), 'utf8')).toBe('{"keep":true}\n');
    });
  });

  it('previews user profiles before any workspace exists and keeps unscoped previews effective across SYSTEM.md and global extras', async () => {
    await withProfileHost(async (home) => {
      await writeFile(join(home, 'config.toml'), STUB_MODELS_TOML);
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'auto-lead.md'), '---\nname: auto-lead\ndescription: Auto lead\nmain: true\nmodel_alias: stub\n---\nLead.\n');
    }, async ({ home, server, getJson, postJson }) => {
      const readPreview = async () => listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents?unscoped=true')).data);
      const preview = await readPreview();
      expect(preview.items.find((i) => i.name === 'auto-lead')).toMatchObject({ source: 'user', main: true, pinned_model_alias: 'stub' });
      expect((await getJson<{ items: unknown[] }>('/api/workspaces')).data.items).toEqual([]);
      expect(server.core.accessor.get(IWorkspaceInstanceManager).list()).toEqual([]);
      const created = await postJson<{ id: string }>('/api/sessions', { agent_config: { profile: 'auto-lead' } });
      expect(server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService).data().profileName).toBe('auto-lead');
      const cwd = join(home, 'manual-project');
      await mkdir(join(cwd, '.kiki', 'agents'), { recursive: true });
      await writeFile(join(cwd, '.kiki', 'agents', 'project-only.md'), '---\nname: project-only\ndescription: Project lead\nmain: true\n---\nProject only.\n');
      expect(listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(cwd)}&effective=true`)).data).items.some((i) => i.name === 'project-only')).toBe(true);
      expect((await readPreview()).items.some((i) => i.name === 'project-only')).toBe(false);
    });

    await withProfileHost(async (home) => {
      const extra = join(home, 'global-agents');
      await writeFile(join(home, 'config.toml'), [
        `extra_agent_dirs = [${JSON.stringify(extra.replaceAll('\\', '/'))}, "relative-agents"]`,
        'skip_builtin_profile_installation = ["agent"]', 'disabled_named_profiles = ["disabled-lead", "agent"]',
      ].join('\n'));
      const file = (name: string, fields = '') => `---\nname: ${name}\ndescription: Example\nmain: true\n${fields}---\nLead.\n`;
      await Promise.all([mkdir(join(home, 'agents'), { recursive: true }), mkdir(extra, { recursive: true }), mkdir(join(home, 'relative-agents'), { recursive: true })]);
      await Promise.all([
        writeFile(join(home, 'SYSTEM.md'), '---\ndescription: User default\nmain: true\n---\nUser default instructions.\n'),
        writeFile(join(home, 'agents', 'shared-lead.md'), file('shared-lead')),
        writeFile(join(home, 'agents', 'disabled-lead.md'), file('disabled-lead')),
        writeFile(join(home, 'agents', 'private-lead.md'), file('private-lead', 'private: true\n')),
        writeFile(join(extra, 'shared-lead.md'), file('shared-lead')),
        writeFile(join(extra, 'extra-lead.md'), file('extra-lead')),
        writeFile(join(home, 'relative-agents', 'relative-lead.md'), file('relative-lead')),
      ]);
    }, async ({ home, server, getJson }) => {
      await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
      const read = async () => listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents?unscoped=true')).data);
      const preview = await read();
      expect(preview.items.filter((i) => i.name === 'shared-lead')).toMatchObject([{ source: 'extra' }]);
      expect(preview.items.find((i) => i.name === 'agent')).toMatchObject({ source: 'user', main: true, disabled: false });
      expect(preview.items.some((i) => ['disabled-lead', 'private-lead', 'relative-lead'].includes(i.name))).toBe(false);
      await writeFile(join(home, 'agents', 'new-lead.md'), '---\nname: new-lead\ndescription: New\nmain: true\n---\nNew.\n');
      await vi.waitFor(async () => expect((await read()).items.some((i) => i.name === 'new-lead')).toBe(true), { timeout: 5000 });
    });
  });

  it('discovers engine metadata, caller references, and selective executor checks without launching engines', async () => {
    const ids = ['codex-app-server', 'claude-acp', 'agy-cli', 'grok-acp'];
    const allowed = ['helper', 'unbound-helper', 'other-main', ...ids.map((id) => `engine:${id}`)];
    let configSnapshot = '';
    await withProfileHost(async (home) => {
      const exePath = join(home, 'installed-engine.exe');
      await writeFile(exePath, 'fixture executable metadata only');
      configSnapshot = [
        '[search]', 'enabled = false', '[cron]', 'manualTick = true',
        '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"',
        '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
        ...ids.flatMap((id) => [`[agent_executor_overrides."${id}"]`, `bin_path = ${JSON.stringify(id === 'agy-cli' ? join(home, 'missing-engine.exe') : exePath)}`, 'show_in_profile_list = false']),
        '[agent_executors.example]', 'protocol = "acp-v1"', 'args = []', 'source = "pinned"',
        'sources = [{ id = "first", kind = "explicit-path", path = "/fixture/first" }, { id = "pinned", kind = "explicit-path", path = "/fixture/pinned" }]',
        'diagnostics = [{ kind = "message", severity = "warning", message = "Fixture warning" }]', '',
      ].join('\n');
      await writeFile(join(home, 'config.toml'), configSnapshot);
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'reference-lead.md'), ['---', 'name: reference-lead', 'description: Lead', 'main: true', 'model_alias: stub', 'tools: [AgentRun]', `allowed_subagents: ${JSON.stringify(allowed)}`, '---', 'Coord.'].join('\n'));
      for (const name of ['helper', 'unbound-helper', 'hidden-helper', 'other-main']) {
        await writeFile(join(home, 'agents', `${name}.md`), ['---', `name: ${name}`, 'description: Fixture', `main: ${name === 'other-main'}`, ...(name === 'unbound-helper' ? [] : ['model_alias: stub']), '---', 'Fixture.'].join('\n'));
      }
    }, async ({ home, server, base, getJson, postJson }) => {
      const klient = createKlient({ endpoint: base, token: server.localOwnerToken });
      const spawn = vi.spyOn(server.core.accessor.get(IHostProcessService), 'spawn');
      try {
        const discovery = await klient.rest!.executors.discover();
        for (const id of ids) expect(discovery.items.find((i) => i.id === id)).toMatchObject({ installed: id !== 'agy-cli', status: id === 'agy-cli' ? 'missing' : 'installed' });
        const draft = await klient.rest!.agents.referenceCandidates({ cwd: home, profile: 'reference-lead' });
        expect(draft.items.map((i) => i.profile).toSorted()).toEqual(allowed.toSorted());
        expect(draft.items.find((i) => i.profile === 'engine:agy-cli')).toMatchObject({ available: false, unavailable_reason_code: 'engine_not_installed' });
        expect(spawn).not.toHaveBeenCalled();

        const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'reference-lead' } });
        const query = { session_id: created.data.id, agent_id: 'main' };
        const live = await klient.rest!.agents.referenceCandidates(query);
        await server.core.accessor.get(ISessionManager).close(created.data.id);
        expect(await klient.rest!.agents.referenceCandidates(query)).toEqual(live);
        expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(configSnapshot);
      } finally { spawn.mockRestore(); await klient.close(); }

      const registry = server.core.accessor.get(IAgentExecutorRegistry);
      const discSpy = vi.spyOn(registry, 'discover').mockImplementation(() => new Promise<never>(() => {}));
      try {
        expect((await getJson('/api/executors/example', AbortSignal.timeout(1000))).data).toMatchObject({ id: 'example', status: 'unknown' });
        discSpy.mockResolvedValueOnce([
          { id: 'first', kind: 'explicit-path', available: true, command: '/fixture/first', version: '1.0' },
          { id: 'pinned', kind: 'explicit-path', available: true, command: '/fixture/pinned', version: '2.0' },
        ]);
        expect((await postJson('/api/executors/example/check', undefined, AbortSignal.timeout(1000))).data).toMatchObject({ id: 'example', status: 'warning', selected_source: 'pinned', version: '2.0' });
        discSpy.mockResolvedValueOnce([]);
        await postJson('/api/executors/example/check', undefined, AbortSignal.timeout(1000));
        const afterCheck = await getJson<{ items: Array<{ id: string; status: string }> }>('/api/executors');
        expect(afterCheck.data.items.find((i) => i.id === 'example')?.status).toBe('unavailable');
      } finally { discSpy.mockRestore(); }
    });
  });

  it('keeps SYSTEM main profiles available, writes winning SYSTEM source, rejects malformed SYSTEM writes, and preserves external main', async () => {
    await withProfileHost(async (home) => {
      await writeFile(join(home, 'SYSTEM.md'), '---\ndescription: Custom default\npreferred_subagents: [explore]\n---\nCustom upgraded prompt.');
      await writeFile(join(home, 'config.toml'), [
        'disabled_named_profiles = ["agent"]', 'skip_builtin_profile_installation = ["agent"]',
        '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
        '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
      ].join('\n'));
    }, async ({ home, server, getJson, postJson }) => {
      await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
      const query = `cwd=${encodeURIComponent(home)}`;
      const profile = listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?${query}&effective=true`)).data).items.find((i) => i.name === 'agent');
      expect(profile).toMatchObject({ main: true, disabled: false, source: 'user', source_file: join(home, 'SYSTEM.md').replaceAll('\\', '/') });
      expect((await postJson('/api/config', { subagent: { main_dispatch_policy: 'strict', subagent_dispatch_policy: 'advisory' } })).code).not.toBe(0);
      const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } });
      expect(server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService).data().systemPrompt).toContain('Custom upgraded prompt.');
    });

    await withProfileHost(async (home) => {
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'agent.md'), '---\nname: agent\ndescription: Shadow default\noverride: true\n---\nShadow prompt.');
      await writeFile(join(home, 'SYSTEM.md'), '---\ndescription: Legacy main\n---\nLegacy main prompt.');
    }, async ({ home, server, getJson, patchJson }) => {
      await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
      const systemPath = join(home, 'SYSTEM.md'), agentPath = join(home, 'agents', 'agent.md');
      const readAgent = async () => listNamedAgentProfilesResponseSchema.parse((await getJson(`/api/agents?cwd=${encodeURIComponent(home)}&effective=true`)).data).items.find((i) => i.name === 'agent')!;
      const initial = await readAgent();
      const updated = await patchJson('/api/agents/agent', { workspace_id: initial.workspace_id, scope: 'user', description: 'Edited default' });
      expect(updated).toMatchObject({ code: 0, data: { main: true, source_file: systemPath.replaceAll('\\', '/'), description: 'Edited default' } });
      expect(await readFile(agentPath, 'utf8')).toContain('Shadow default');
      for (const badYaml of ['---\ntools: [Read\n---\nBroken.', '---\ntools: [Read]\nBroken.', '---\n- Read\n---\nBroken.']) {
        expect((await patchJson('/api/agents/agent', { workspace_id: initial.workspace_id, scope: 'user', source_file: initial.source_file, raw_text: badYaml })).code).toBe(ErrorCode.VALIDATION_FAILED);
      }
      await rm(systemPath);
      const baseOverride = '---\nname: agent\ndescription: Restricted override\noverride: true\ntools: [Read]\nallowed_subagents: []\n---\nRestricted prompt.';
      await writeFile(agentPath, baseOverride);
      const before = await readAgent();
      for (const mainVal of [undefined, false, true] as const) {
        const rawText = baseOverride.replace('override: true', `override: true\nexecutor: grok-acp${mainVal === undefined ? '' : `\nmain: ${mainVal}`}`);
        expect((await patchJson('/api/agents/agent', { workspace_id: before.workspace_id, scope: 'user', source_file: before.source_file, raw_text: rawText })).code).toBe(0);
        expect(await readAgent()).toMatchObject({ main: mainVal !== false, source: 'user', executor: 'grok-acp', tools: ['Read'] });
      }
    });
  });

  it('projects scoped runtime auth and blocks BoardRead even when allowed_tools names it', async () => {
    await withProfileHost(async (home) => {
      const script = join(home, 'codex-fixture.mjs');
      await writeFile(join(home, 'config.toml'), [
        'default_model = "stub"', '[subagent]', 'allowed_tools = ["BoardRead"]',
        '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
        '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
        '[agent_executor_overrides."codex-app-server"]', `bin_path = "${script.replaceAll('\\', '/')}"`,
      ].join('\n'));
      await mkdir(join(home, 'agents'), { recursive: true });
      await writeFile(join(home, 'agents', 'board-reader.md'), '---\nname: board-reader\ndescription: Board reader\n---\nRead.');
    }, async ({ home, server, getJson, postJson }) => {
      const script = join(home, 'codex-fixture.mjs');
      const missing = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { execution: { executor: 'codex-app-server' } } });
      expect(missing.code).toBe(ErrorCode.VALIDATION_FAILED);
      await writeFile(script, [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(new URL("./codex-fixture-invocations", import.meta.url), JSON.stringify(process.argv.slice(2)) + "\\n");',
        'if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(1);',
        'console.log("codex-fixture 1.0");',
      ].join('\n'));
      const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { execution: { executor: 'codex-app-server' } } });
      expect(created.code).toBe(0);
      const manager = server.core.accessor.get(ISessionManager);
      const session = manager.get(created.data.id)!;
      const agent = session.accessor.get(IAgentLifecycleService).get('main')!;
      const binding = agent.accessor.get(IAgentProfileService).data();
      await recordExecutorAuth({ agent, binding, descriptor: server.core.accessor.get(IAgentExecutorRegistry).get('codex-app-server')! }, home, { status: 'unknown', source: 'codex.account.updated', scope: 'vendor_account' });
      const readCap = async () => agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`)).data);
      const live = await readCap();
      expect(live.executor_auth).toMatchObject({ status: 'unknown', executor_id: 'codex-app-server', cwd: home });
      await manager.close(created.data.id);
      const cold = await readCap();
      expect(cold.live).toBe(false);
      expect(cold.executor_auth).toEqual(live.executor_auth);

      const nativeSession = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'agent', model: 'stub' } });
      const lifecycle = manager.get(nativeSession.data.id)!.accessor.get(IAgentLifecycleService);
      await lifecycle.create({ agentId: 'child-allowed', delegator: { kind: 'agent', agentId: 'main' }, binding: { profile: 'board-reader', model: 'stub' } });
      const childTools = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?session_id=${nativeSession.data.id}&agent_id=child-allowed`)).data).tools ?? [];
      expect(childTools.find((t) => t.name === 'BoardRead')).toBeUndefined();
    });
  });

  it('projects caller leases, file-backed route pins, configured global extras, private profiles, and override flags', async () => {
    await withProfileHost(async (home) => {
      const extraAgents = join(home, 'configured-agents'), extraSkills = join(home, 'configured-skills');
      await mkdir(extraAgents, { recursive: true });
      await mkdir(join(extraSkills, 'global-example'), { recursive: true });
      await writeFile(join(extraAgents, 'paper-architect.md'), '---\nname: paper-architect\ndescription: Configured global helper\n---\nHelp.\n');
      await writeFile(join(extraSkills, 'global-example', 'SKILL.md'), '---\nname: global-example\ndescription: Global example\n---\nBody.\n');
      await mkdir(join(home, 'agents', '.routes', 'reviewer'), { recursive: true });
      await writeFile(join(home, 'agents', 'reviewer.md'), [
        '---', 'name: reviewer', 'description: Reviews changes', 'whenToUse: Review important changes', 'main: true',
        'model_alias: provider/pinned', 'thinking_effort: high', 'service_tier: priority', 'context_budget: 4096', 'max_completion_tokens: 512',
        'request_params:', '  temperature: 0.4', 'tools: [Read, Bash]', 'disallowedTools: [Write]',
        'model_profiles:', '  - alias: provider/fast', '    when: Quick', '    context_budget: 2048', '    max_completion_tokens: 256', '    service_tier: flex', '    request_params:', '      temperature: 0.2', '    thinking_effort: low', '    allowed_efforts: [low, medium]',
        'spawn_constraints:', '  allowed_models: [provider/pinned]', '  deny_models: [provider/blocked]', '  allowed_efforts: [high]', '  disallowed_tools: [Write]',
        'allowed_subagents:', '  - explore', '  - name: reviewer-helper', '    description: Assists', '    model_alias: provider/fast', '    thinking_effort: low', '    allowed_models: [provider/fast]', '    tools: ["*"]', '    allowed_subagents: ["*"]', '    delegation_notice: off',
        '---', '', 'Review the change.', '',
      ].join('\n'));
      await writeFile(join(home, 'agents', '.routes', 'reviewer', 'fast.md'), '---\nid: reviewer.fast\nprofile: reviewer\ndescription: Fast review route\nprompt_mode: prepend\nmodel_alias: provider/route\n---\nPrioritize speed.\n');
      await writeFile(join(home, 'agents', 'm3-worker.md'), '---\nname: m3-worker\ndescription: Private worker\nprivate: true\n---\nPrivate.\n');
      await writeFile(join(home, 'agents', 'explore.md'), '---\nname: explore\ndescription: User explore\noverride: true\n---\nExplore.\n');
      await writeFile(join(home, 'config.toml'), [
        'disabled_named_profiles = ["disabled-helper", "reviewer"]',
        `extra_agent_dirs = [${JSON.stringify(extraAgents.replaceAll('\\', '/'))}]`,
        `extra_skill_dirs = [${JSON.stringify(extraSkills.replaceAll('\\', '/'))}]`,
        '[providers.stub]', 'type = "openai"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
        '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 1000',
        '[experimental]', '"agent-profile-routes" = true',
      ].join('\n'));
    }, async ({ home, server, getJson, postJson, patchJson }) => {
      const wsB = join(home, 'ws-b');
      await mkdir(join(wsB, '.kiki', 'agents'), { recursive: true });
      await writeFile(join(wsB, '.kiki', 'agents', 'other-helper.md'), '---\nname: other-helper\ndescription: Only B\n---\nB.\n');
      expect((await postJson('/api/sessions', { metadata: { cwd: home }, agent_config: { model: 'stub' } })).code).toBe(0);
      expect((await postJson('/api/sessions', { metadata: { cwd: wsB } })).code).toBe(0);

      const data = listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents')).data);
      expect(data.items.some((p) => p.name === 'm3-worker')).toBe(false);
      expect(data.items.find((p) => p.name === 'explore')?.override).toBe(true);
      const reviewer = data.items.find((p) => p.name === 'reviewer' && p.source === 'user')!;
      expect(reviewer).toMatchObject({
        name: 'reviewer', disabled: true, pinned_model_alias: 'provider/pinned', context_budget: 4096,
        routes: [{ id: 'reviewer.fast', model_alias: 'provider/route' }],
      });
      const expanded = listNamedAgentProfilesResponseSchema.parse((await getJson('/api/agents?expand=1')).data);
      expect(expanded.items.filter((p) => p.name === 'reviewer' && p.source === 'user')).toHaveLength(2);
      const patched = await patchJson('/api/agents/reviewer', {
        scope: 'user', workspace_id: reviewer.workspace_id, description: 'Reviews carefully',
        pinned_model_alias: 'provider/updated', routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }],
      });
      expect(patched).toMatchObject({ code: 0, data: { pinned_model_alias: 'provider/updated', routes: [{ id: 'reviewer.fast', model_alias: 'provider/route-updated' }] } });
      expect((await patchJson('/api/agents/reviewer', { scope: 'user', workspace_id: reviewer.workspace_id, raw_text: '---\nname: reviewer\ndescription: Mixed\n---\nBody.\n', description: 'mixed' })).code).toBe(40001);

      const wsA = join(home, 'ws-a');
      await mkdir(wsA, { recursive: true });
      const capsA = agentCapabilitiesResponseSchema.parse((await getJson(`/api/agents/capabilities?cwd=${encodeURIComponent(wsA)}&profile=agent`)).data);
      expect(capsA.targets.find((t) => t.profile === 'paper-architect')).toMatchObject({ source: 'extra' });
      expect(capsA.targets.some((t) => t.profile === 'other-helper')).toBe(false);
      expect(capsA.skills?.find((s) => s.name === 'global-example')).toMatchObject({ source: 'extra', scope: 'global' });

      const registry = server.core.accessor.get(IAgentProfileRegistry);
      const helper = (name: string, modelAlias?: string) => normalizeAgentProfile({ name, definitionId: `definition:${name}`, modelAlias, systemPrompt: () => 'PRIVATE_PROMPT' });
      const scoped = helper('private-helper');
      const lead = normalizeAgentProfile({
        name: 'lead', definitionId: 'definition:lead', main: true, tools: ['AgentRun'],
        allowedSubagents: ['leased-helper', 'unbound-helper', 'disabled-helper', 'blocked-helper', 'private-helper', 'missing-helper'],
        subagentLeases: {
          'leased-helper': { name: 'leased-helper', modelAlias: 'stub', thinkingEffort: 'off', allowedModels: ['stub'] },
          'blocked-helper': { name: 'blocked-helper', allowedModels: [] },
          'private-helper': { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' },
          'missing-helper': { name: 'missing-helper', source: './_private/missing.md' },
        },
        systemPrompt: () => 'Coord.',
      });
      const reg = registry.register({
        sourceId: 'example', priority: 50,
        contribution: {
          profiles: [lead, helper('leased-helper'), helper('unbound-helper'), helper('disabled-helper'), helper('blocked-helper'), helper('hidden-helper')],
          routes: ['stub', 'denied'].map((m) => ({ id: `leased-helper.${m}`, profile: 'leased-helper', description: 'Route', promptMode: 'inherit' as const, prompt: '', modelAlias: m, thinkingEffort: 'off', overriddenFields: ['modelAlias', 'thinkingEffort'], path: `/example/${m}.md` })),
          scopedBindings: new Map([[lead.definitionId!, new Map([
            ['private-helper', { parentDefinitionId: lead.definitionId!, alias: 'private-helper', source: './_private/helper.md', lease: { name: 'private-helper', source: './_private/helper.md', modelAlias: 'stub' }, status: 'ready' as const, profile: scoped, sourceDefinitionId: scoped.definitionId }],
            ['missing-helper', { parentDefinitionId: lead.definitionId!, alias: 'missing-helper', source: './_private/missing.md', lease: { name: 'missing-helper', source: './_private/missing.md' }, status: 'unavailable' as const }],
          ])]]),
        },
      });
      try {
        const created = await postJson<{ id: string }>('/api/sessions', { metadata: { cwd: home }, agent_config: { profile: 'lead', model: 'stub' } });
        const tool = server.core.accessor.get(ISessionManager).get(created.data.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(ISubagentTool);
        const desc = tool.description;
        const body = await getJson<{ targets: Array<{ profile: string; route?: string; defaults_available: boolean; model_alias?: string; model_source?: string }> }>(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main`);
        expect(body.data.targets.find((t) => t.route === 'leased-helper.stub')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'route' });
        expect(body.data.targets.find((t) => t.profile === 'leased-helper')).toMatchObject({ defaults_available: true, model_alias: 'stub', model_source: 'caller-lease' });
        expect(JSON.stringify(body.data)).not.toMatch(/PRIVATE_PROMPT|_private|sourceDefinitionId|YOUR_API_KEY/);
        await reg.dispose();
        expect(tool.description).toBe(desc);
      } finally { await reg.dispose(); }
    });
  });

  it('settles only the selected agent persisted usage after restart without rereading wire', async () => {
    await withProfileHost(async () => {}, async (ctx) => {
      const created = await ctx.postJson<{ id: string }>('/api/sessions', { metadata: { cwd: ctx.home } });
      expect(created.code).toBe(0);
      const session = ctx.server.core.accessor.get(ISessionManager).get(created.data.id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const main = lifecycle.get('main') ?? await lifecycle.create({ agentId: 'main' });
      main.accessor.get(IAgentUsageService).record('priced-fixture', { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 }, undefined, { usageKnown: true });
      main.accessor.get(IAgentUsageService).record('priced-fixture', { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }, undefined, { usageKnown: false });
      const child = await lifecycle.create({ agentId: 'agent-7' });
      child.accessor.get(IAgentUsageService).record('priced-fixture', { inputOther: 20, output: 10, inputCacheRead: 5, inputCacheCreation: 0 }, undefined, { usageKnown: true });
      await lifecycle.remove('agent-7');
      await ctx.restart();

      const wireRead = vi.spyOn(ctx.server.core.accessor.get(IAppendLogStore), 'read');
      const summaryRead = vi.spyOn(ctx.server.core.accessor.get(IUsageFactStore), 'summary');
      const initialData = agentCapabilitiesResponseSchema.parse((await ctx.getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main&metrics_only=true`)).data);
      expect(initialData.metrics?.['main']).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, usageComplete: false, usageSource: 'persisted' });
      expect(summaryRead).not.toHaveBeenCalled();
      expect(wireRead).not.toHaveBeenCalled();

      const data = agentCapabilitiesResponseSchema.parse((await ctx.getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=main&metrics_settle=true`)).data);
      expect(data.metrics?.['main']).toMatchObject({ totalTokens: 15, inputTokens: 10, outputTokens: 5, usagePartial: true, costPartial: true, usageSource: 'persisted' });
      expect(data.metrics?.['agent-7']).toBeUndefined();
      expect(summaryRead.mock.calls.every(([scope]) => scope.endsWith('/agents/main'))).toBe(true);
      expect(wireRead.mock.calls.filter(([, key]) => key === AGENT_WIRE_RECORD_KEY)).toEqual([]);

      summaryRead.mockClear();
      const childData = agentCapabilitiesResponseSchema.parse((await ctx.getJson(`/api/agents/capabilities?session_id=${created.data.id}&agent_id=agent-7&metrics_settle=true`)).data);
      expect(childData.metrics?.['agent-7']).toMatchObject({ totalTokens: 35, inputTokens: 25, outputTokens: 10, usagePartial: false, usageSource: 'persisted' });
      expect(summaryRead.mock.calls.every(([scope]) => scope.endsWith('/agents/agent-7'))).toBe(true);
      expect(wireRead.mock.calls.filter(([, key]) => key === AGENT_WIRE_RECORD_KEY)).toEqual([]);
    });
  });
});

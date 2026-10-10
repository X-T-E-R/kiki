import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentSkillService,
  IModelCatalogMutationService,
  ISessionManager,
  ISessionSkillCatalog,
  KIKI_OPS_SKILL,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { IAgentLLMRequesterService } from '@kiki/agent-core-v2/agent/llmRequester/llmRequester';
import {
  activateSkillResultSchema,
  builtinSkillContentResponseSchema,
  listSkillsResponseSchema,
} from '../src/protocol/rest-skill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface SkillWire {
  name: string;
  description: string;
  path: string;
  source: string;
  type?: string;
  disable_model_invocation?: boolean;
}

describe('server-v2 /api skills', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string = home as string): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/sessions', {
      metadata: { cwd },
      agent_config: { permission_mode: 'manual' },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const agents = session.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
  }

  async function registerWorkspace(root: string): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/workspaces', { root });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function makeWorkspaceDir(): Promise<string> {
    const dir = join(
      home as string,
      `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function seedProjectSkill(root: string, name: string): Promise<void> {
    const dir = join(root, '.kiki', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: e2e test skill ${name}\n---\n\nSay hello to $ARGUMENTS.\n`,
    );
  }

  async function seedExplicitSkill(root: string, name: string): Promise<void> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: explicit skill ${name}\n---\n\nSay hello to $ARGUMENTS.\n`,
    );
  }

  it('previews the global host skill and requires an explicit confirmed install body', async () => {
    const preview = await postJson<{ host: string; directory: string; path: string; overwrites: boolean; revision: string }>(
      '/api/skills/kiki-as-subagent:preview-install', { host: 'agents' },
    );
    expect(preview.body.code).toBe(0);
    expect(preview.body.data.path.replaceAll('\\', '/')).toMatch(/\/\.agents\/skills\/kiki-as-subagent\/SKILL\.md$/);
    expect(preview.body.data.revision).toMatch(/^[a-f0-9]{64}$/);
    const notConfirmed = await postJson('/api/skills/kiki-as-subagent:install', {
      host: 'agents', revision: preview.body.data.revision, confirmed: false,
    });
    expect(notConfirmed.body.code).toBe(40001);
  });

  it('discovers user and workspace Markdown commands and activates the latest prompt once', async () => {
    const root = await makeWorkspaceDir();
    await mkdir(join(home!, 'commands'), { recursive: true });
    await mkdir(join(root, '.kiki', 'commands'), { recursive: true });
    await writeFile(join(home!, 'commands', 'notes.md'), 'Discuss notes without creating files.');
    const commandPath = join(root, '.kiki', 'commands', 'brainstorm.md');
    await writeFile(commandPath, '---\ndescription: Discuss options\nargument-hint: "<topic>"\n---\nDiscuss $ARGUMENTS without creating files.');
    await seedProjectSkill(root, 'brainstorm');
    const workspaceId = await registerWorkspace(root);
    const workspace = await getJson<{ skills: SkillWire[] }>(`/api/workspaces/${workspaceId}/skills`);
    expect(workspace.body.code).toBe(0);
    expect(workspace.body.data.skills.find((skill) => skill.name === 'command:brainstorm')).toMatchObject({
      source: 'project', prompt_command: true, disable_model_invocation: true, argument_hint: '<topic>',
    });
    const id = await createSession(root);
    const listed = await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`);
    expect(listed.body.data.skills.find((skill) => skill.name === 'notes')).toMatchObject({ source: 'user', disable_model_invocation: true });
    expect(listed.body.data.skills.find((skill) => skill.name === 'brainstorm')?.path).toContain('SKILL.md');
    expect(listed.body.data.skills.find((skill) => skill.name === 'command:brainstorm')).toBeDefined();
    await writeFile(commandPath, '---\ndescription: Updated discussion\n---\nUpdated discussion: $ARGUMENTS.');
    await expect.poll(async () => (await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`))
      .body.data.skills.find((skill) => skill.name === 'command:brainstorm')?.description, { timeout: 10000 })
      .toBe('Updated discussion');
    const activated = await postJson(`/api/sessions/${id}/skills/command%3Abrainstorm:activate`, { args: 'menu choices' });
    expect(activated.body.code).toBe(0);
    const messages = await getJson<{ items: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }>(`/api/sessions/${id}/messages`);
    const bodies = messages.body.data.items.filter((message) => message.role === 'user')
      .flatMap((message) => message.content.map((part) => part.text ?? '')).join('\n');
    expect(bodies.match(/Updated discussion: menu choices\./g)).toHaveLength(1);
    await writeFile(join(home!, 'commands', 'notes.md'), 'Updated user notes.');
    await expect.poll(async () => (await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`))
      .body.data.skills.find((skill) => skill.name === 'notes')?.description, { timeout: 10000 })
      .toBe('Updated user notes.');
  });

  describe('GET /api/skills draft catalog', () => {
    it('lists global user skills and commands before there is a workspace or session', async () => {
      await seedExplicitSkill(join(home!, 'skills'), 'global-review');
      await mkdir(join(home!, 'commands'), { recursive: true });
      await writeFile(join(home!, 'commands', 'notes.md'), 'Discuss these notes.');
      const sessionsBefore = await getJson<{ items: unknown[] }>('/api/sessions');
      const workspacesBefore = await getJson<{ items: unknown[] }>('/api/workspaces');
      const listed = await getJson<{ skills: SkillWire[] }>('/api/skills');
      expect(listed.body.code).toBe(0);
      expect(listSkillsResponseSchema.parse(listed.body.data).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'kiki-ops', source: 'builtin' }),
        expect.objectContaining({ name: 'global-review', source: 'user' }),
        expect.objectContaining({ name: 'notes', source: 'user', prompt_command: true }),
      ]));
      expect((await getJson<{ items: unknown[] }>('/api/sessions')).body.data.items).toEqual(sessionsBefore.body.data.items);
      expect((await getJson<{ items: unknown[] }>('/api/workspaces')).body.data.items).toEqual(workspacesBefore.body.data.items);
    });

    it('previews a directory skill without registering it, and the same skill is available at actual session creation', async () => {
      const root = await makeWorkspaceDir();
      await mkdir(join(root, '.git'));
      await seedProjectSkill(root, 'directory-review');
      const before = await getJson<{ items: unknown[] }>('/api/workspaces');
      const preview = await getJson<{ skills: SkillWire[] }>(`/api/skills?cwd=${encodeURIComponent(root)}`);
      expect(preview.body.code).toBe(0);
      expect(preview.body.data.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'directory-review', source: 'project' })]));
      expect((await getJson<{ items: unknown[] }>('/api/workspaces')).body.data.items).toEqual(before.body.data.items);
      const id = await createSession(root);
      const actual = await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`);
      expect(actual.body.data.skills.find((skill) => skill.name === 'directory-review')).toEqual(preview.body.data.skills.find((skill) => skill.name === 'directory-review'));
      expect((await getJson<{ items: unknown[] }>('/api/models')).body.data.items).toEqual([]);
      const rejected = await postJson(`/api/sessions/${id}/skills/directory-review:activate`, {
        prompt_id: 'unbound-first-skill', args: 'sample', user_input: '/directory-review sample',
      });
      expect(rejected.body.code).toBe(50001);
      expect(rejected.body.msg).toContain('model.not_configured');
      expect(rejected.body.msg).not.toContain('another turn is active');
      const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      expect(main.accessor.get(IAgentPromptService).lookup('unbound-first-skill')).toMatchObject({ phase: 'terminal', terminal: { state: 'failed', result: { error: { code: 'model.not_configured' } } } });
      const models = server!.core.accessor.get(IModelCatalogMutationService);
      await models.createProvider({ id: 'fixture', type: 'openai', base_url: 'http://127.0.0.1:1/v1', api_key: 'fixture' });
      await models.createModel({ id: 'fixture', provider_id: 'fixture', remote_id: 'fixture', max_context_size: 100000 });
      await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'fixture', thinking: 'off' });
      const requester = vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'start').mockImplementation(() => ({
        trace: { traceId: 'fixture-first-skill' },
        result: Promise.resolve({
          message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture reply.' }], toolCalls: [] },
          usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          providerFinishReason: 'completed',
        }),
      }));
      try {
        const activation = await postJson(`/api/sessions/${id}/skills/directory-review:activate`, {
          args: 'sample', user_input: '/directory-review sample',
        });
        expect(activation.body.code, activation.body.msg).toBe(0);
        await main.accessor.get(IAgentLoopService).settled();
        const messages = await getJson<{ items: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }>(`/api/sessions/${id}/messages`);
        const sent = messages.body.data.items.filter((item) => item.role === 'user')
          .flatMap((item) => item.content.map((part) => part.text ?? '')).join('\n');
        expect(sent.match(/Say hello to sample\./g)).toHaveLength(1);
        expect(requester).toHaveBeenCalledTimes(1);
      } finally {
        requester.mockRestore();
      }
    });

    it('reports invalid or missing directories instead of presenting an empty catalog', async () => {
      expect((await getJson('/api/skills?cwd=relative')).body.code).toBe(40001);
      expect((await getJson(`/api/skills?cwd=${encodeURIComponent(join(home!, 'missing-directory'))}`)).body.code).toBe(40410);
    });
  });

  describe('GET /api/skills/{name}:content', () => {
    it('returns the embedded built-in body without using the filesystem or opening a session', async () => {
      const { body } = await getJson<{ name: string; content: string }>('/api/skills/kiki-ops:content');
      expect(body.code).toBe(0);
      expect(builtinSkillContentResponseSchema.parse(body.data)).toEqual({
        name: 'kiki-ops',
        content: KIKI_OPS_SKILL.content,
      });
      expect(body.data.content).toContain('# Kiki operations (kiki-ops)');
    });

    it('does not expose file skills or nonexistent names via the built-in channel', async () => {
      const root = await makeWorkspaceDir();
      await seedProjectSkill(root, 'local-only');
      const workspaceId = await registerWorkspace(root);
      const catalog = await getJson<{ skills: SkillWire[] }>(`/api/workspaces/${workspaceId}/skills`);
      expect(catalog.body.data.skills.find((skill) => skill.name === 'local-only')?.source).toBe('project');
      const missing = await getJson<null>('/api/skills/local-only:content');
      expect(missing.body.code).toBe(40415);
      const unknown = await getJson<null>('/api/skills/does-not-exist:content');
      expect(unknown.body.code).toBe(40415);
    });
  });

  describe('GET /api/sessions/{sid}/skills', () => {
    it('pins a live catalog until the response and keeps cold requests cold', async () => {
      await server!.close();
      server = undefined;
      vi.stubEnv('KIKI_EXPERIMENTAL_SESSION_IDLE_EVICTION', 'true');
      await writeFile(join(home!, 'config.toml'), '[session_residency]\nidle_ttl_ms = 0\nmin_idle_ms = 0\nsweep_interval_ms = 300000\n');
      server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home!, logLevel: 'silent' });
      base = `http://127.0.0.1:${server.port}`;
      const id = await createSession();
      const manager = server.core.accessor.get(ISessionManager);
      const catalog = getLiveSessionById(server.core.accessor, id)!.accessor.get(ISessionSkillCatalog);
      const originalReady = catalog.ready;
      let entered!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      Object.defineProperty(catalog, 'ready', {
        // oxlint-disable-next-line unicorn/no-thenable -- the fake `ready` must be a thenable so the request suspends exactly inside `await catalog.ready`, where this test observes the held session pin
        value: { then: (finish: () => void) => { entered(); return gate.then(finish); } },
        configurable: true,
      });
      try {
        const pending = getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`);
        await reached;
        expect(await manager.evictIfIdle!(id)).toBe(false);
        resume();
        expect((await pending).body.code).toBe(0);
        expect(await manager.evictIfIdle!(id)).toBe(true);
        const acquire = vi.spyOn(manager, 'acquire');
        const cold = await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`);
        expect(cold.body.code).toBe(0);
        expect(acquire).not.toHaveBeenCalled();
        expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();
        acquire.mockRestore();
      } finally {
        resume();
        Object.defineProperty(catalog, 'ready', { value: originalReady, configurable: true });
      }
    });

    it('returns 40401 for an unknown session', async () => {
      const { body } = await getJson<null>('/api/sessions/nope/skills');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('lists workspace skills for an archived (cold) session without resuming it', async () => {
      const id = await createSession();
      const archived = await postJson<{ archived: boolean }>(`/api/sessions/${id}:archive`);
      expect(archived.body.code).toBe(0);
      expect(getLiveSessionById((server as RunningServer).core.accessor, id)).toBeUndefined();

      const { body } = await getJson<{ skills: SkillWire[] }>(`/api/sessions/${id}/skills`);
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      expect(skills.some((s) => s.name === 'kiki-ops')).toBe(true);
      expect(getLiveSessionById((server as RunningServer).core.accessor, id)).toBeUndefined();
    });

    it('lists builtin skills projected to the wire shape', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;

      const opsSkill = skills.find((s) => s.name === 'kiki-ops');
      expect(opsSkill).toBeDefined();
      expect(opsSkill).toMatchObject({ source: 'builtin' });
      expect(opsSkill).not.toHaveProperty('is_sub_skill');
      expect(opsSkill).not.toHaveProperty('isSubSkill');
    });

    it('lists the narrow kiki-profile builtin skill', async () => {
      const id = await createSession();
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/sessions/${id}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;

      const profileSkill = skills.find((s) => s.name === 'kiki-profile');
      expect(profileSkill).toBeDefined();
      expect(profileSkill).toMatchObject({ source: 'builtin' });
      expect(profileSkill?.description.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/sessions/{sid}/skills/{name}:activate', () => {
    it('activates a builtin skill and returns the wire envelope', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        { args: '--help' },
      );
      expect(body.code).toBe(0);
      expect(activateSkillResultSchema.parse(body.data)).toEqual({
        activated: true,
        skill_name: 'kiki-ops',
      });
    });

    it('activates a skill on the requested native child without borrowing main', async () => {
      const id = await createSession();
      await createMainAgent(id);
      const session = getLiveSessionById(server!.core.accessor, id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({
        agentId: 'skill-child',
        binding: { profile: 'agent', model: 'stub', thinking: 'high' },
      });
      const main = lifecycle.get('main')!;
      const mainActivation = vi.spyOn(main.accessor.get(IAgentSkillService), 'activate');
      const childActivation = vi.spyOn(child.accessor.get(IAgentSkillService), 'activate');
      const userInput = '/kiki-ops --child\nKeep this exact submission.';
      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        {
          agent_id: child.id,
          prompt_id: 'child-skill-activation',
          args: '--child\nKeep this exact submission.',
          user_input: userInput,
        },
      );
      expect(body.code, body.msg).toBe(0);
      expect(body.data).toEqual({ activated: true, skill_name: 'kiki-ops' });
      expect(mainActivation).not.toHaveBeenCalled();
      expect(childActivation).toHaveBeenCalledWith(expect.objectContaining({
        name: 'kiki-ops',
        args: '--child\nKeep this exact submission.',
        userInput,
        promptId: 'child-skill-activation',
        retryFingerprint: expect.any(String),
      }));
    });

    it('rejects a missing child target without creating or borrowing main', async () => {
      const id = await createSession();
      const session = getLiveSessionById(server!.core.accessor, id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        { agent_id: 'missing-skill-child', args: '--must-fail' },
      );
      expect(body.code).toBe(40401);
      expect(body.msg).toContain('missing-skill-child');
      expect(lifecycle.get('main')).toBeUndefined();
    });

    it('rejects skill activation for an external executor instead of sending an ordinary prompt', async () => {
      const id = await createSession();
      await createMainAgent(id);
      const session = getLiveSessionById(server!.core.accessor, id)!;
      const child = await session.accessor.get(IAgentLifecycleService).create({
        agentId: 'external-skill-child',
        binding: { profile: 'agent', model: 'stub', thinking: 'high' },
      });
      const profile = child.accessor.get(IAgentProfileService);
      const binding = profile.data();
      vi.spyOn(profile, 'data').mockReturnValue({ ...binding, executorId: 'external-test' });
      const activation = vi.spyOn(child.accessor.get(IAgentSkillService), 'activate');
      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        { agent_id: child.id, args: '--external' },
      );
      expect(body.code).toBe(40001);
      expect(body.msg).toContain('external executor "external-test"');
      expect(body.msg).toContain('ordinary prompts');
      expect(activation).not.toHaveBeenCalled();
    });

    it('wakes a disposed child and replays the activation on that child only', async () => {
      const id = await createSession();
      await createMainAgent(id);
      const session = getLiveSessionById(server!.core.accessor, id)!;
      const lifecycle = session.accessor.get(IAgentLifecycleService);
      const child = await lifecycle.create({
        agentId: 'cold-skill-child',
        binding: { profile: 'agent', model: 'stub', thinking: 'high' },
      });
      await lifecycle.remove(child.id);
      const main = lifecycle.get('main')!;
      const mainActivation = vi.spyOn(main.accessor.get(IAgentSkillService), 'activate');
      let restoredActivationCalls = 0;
      let restoreRestoredActivation: (() => void) | undefined;
      const created = lifecycle.onDidCreate((handle) => {
        if (handle.id === child.id) {
          const service = handle.accessor.get(IAgentSkillService);
          const originalActivate = service.activate.bind(service);
          const activation = vi.spyOn(service, 'activate').mockImplementation(async (input) => {
            restoredActivationCalls++;
            return originalActivate(input);
          });
          restoreRestoredActivation = () => activation.mockRestore();
        }
      });
      try {
        const body = {
          agent_id: child.id,
          prompt_id: 'cold-child-skill',
          args: '--cold',
          user_input: '/kiki-ops --cold',
        };
        const first = await postJson<{ activated: boolean; skill_name: string }>(
          `/api/sessions/${id}/skills/kiki-ops:activate`,
          body,
        );
        expect(first.body.code, first.body.msg).toBe(0);
        expect(lifecycle.get(child.id)).toBeDefined();
        expect(restoredActivationCalls).toBe(1);
        expect(mainActivation).not.toHaveBeenCalled();
        const replay = await postJson<{ activated: boolean; skill_name: string }>(
          `/api/sessions/${id}/skills/kiki-ops:activate`,
          body,
        );
        expect(replay.body.data).toEqual(first.body.data);
        expect(restoredActivationCalls).toBe(1);
      } finally {
        created.dispose();
        mainActivation.mockRestore();
        restoreRestoredActivation?.();
      }
    });

    it('replays a client prompt_id skill activation and rejects a changed body without a second run', async () => {
      const id = await createSession();
      await createMainAgent(id);
      const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
      const activation = vi.spyOn(main.accessor.get(IAgentSkillService), 'activate');
      const noteBytes = Buffer.from('legacy skill retry attachment');
      const form = new FormData();
      form.set('file', new Blob([Uint8Array.from(noteBytes).buffer], { type: 'text/plain' }), 'retry.txt');
      const upload = await fetch(`${base}/api/files`, {
        method: 'POST', headers: authHeaders(server as RunningServer), body: form,
      } as never);
      const uploaded = (await upload.json()) as Envelope<{ id: string; size: number }>;
      expect(uploaded.code).toBe(0);
      const body = {
        prompt_id: 'legacy-skill-retry', args: '--help', user_input: '/kiki-ops --help',
        attachments: [{ type: 'file' as const, file_id: uploaded.data.id, name: 'retry.txt', media_type: 'text/plain', size: noteBytes.length }],
      };
      try {
        const first = await postJson<{ activated: boolean; skill_name: string }>(`/api/sessions/${id}/skills/kiki-ops:activate`, body);
        expect(first.body.code, first.body.msg).toBe(0);
        await main.accessor.get(IAgentLoopService).settled();
        const deleted = await fetch(`${base}/api/files/${uploaded.data.id}`, {
          method: 'DELETE', headers: authHeaders(server as RunningServer),
        } as never);
        expect((await deleted.json() as Envelope<{ deleted: boolean }>).data.deleted).toBe(true);
        const replay = await postJson<{ activated: boolean; skill_name: string }>(`/api/sessions/${id}/skills/kiki-ops:activate`, body);
        expect(replay.body.data).toEqual(first.body.data);
        const explicitMainReplay = await postJson<{ activated: boolean; skill_name: string }>(
          `/api/sessions/${id}/skills/kiki-ops:activate`,
          { ...body, agent_id: 'main' },
        );
        expect(explicitMainReplay.body.data).toEqual(first.body.data);
        const changed = await postJson<null>(`/api/sessions/${id}/skills/kiki-ops:activate`, {
          ...body,
          args: '--different',
          user_input: '/kiki-ops --different',
        });
        expect(changed.body.code).toBe(40938);
        const changedDependency = await postJson<null>(`/api/sessions/${id}/skills/kiki-ops:activate`, {
          ...body,
          after_model_switch: 'different-switch',
        });
        expect(changedDependency.body.code).toBe(40938);
        expect(activation).toHaveBeenCalledTimes(1);
      } finally {
        activation.mockRestore();
      }
    });

    it('carries the exact slash input through REST into the saved activation origin', async () => {
      const id = await createSession();
      await createMainAgent(id);
      const userInput = '/kiki-ops --help\nExplain this second line.';
      const activated = await postJson(`/api/sessions/${id}/skills/kiki-ops:activate`, {
        args: '--help\nExplain this second line.', user_input: userInput,
      });
      expect(activated.body.code).toBe(0);
      const messages = await getJson<{ items: Array<{ role: string; metadata?: { origin?: { kind?: string; userInput?: string } }; content: Array<{ type: string; text?: string }> }> }>(`/api/sessions/${id}/messages`);
      const user = messages.body.data.items.filter(message => message.role === 'user');
      expect(user).toHaveLength(1);
      expect(user[0]?.metadata?.origin).toMatchObject({ kind: 'skill_activation', userInput });
      expect(user[0]?.content.some(part => part.text?.includes('<skill-loaded'))).toBe(true);
    });

    it('derives the session title from the first skill activation', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const activated = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        { args: '--help' },
      );
      expect(activated.body.code).toBe(0);

      const got = await getJson<{ title: string }>(`/api/sessions/${id}`);
      expect(got.body.code).toBe(0);
      expect(got.body.data.title).toBe('/kiki-ops --help');
    });

    it('returns 40415 for an unknown skill', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/does-not-exist:activate`,
      );
      expect(body.code).toBe(40415);
    });

    it('returns 40401 for an unknown session', async () => {
      const { body } = await postJson<null>('/api/sessions/nope/skills/kiki-ops:activate');
      expect(body.code).toBe(40401);
      expect(body.msg).toMatch(/does not exist/);
    });

    it('rejects a bare {name} (no action) with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(`/api/sessions/${id}/skills/kiki-ops`);
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('rejects an unsupported action with 40001', async () => {
      const id = await createSession();
      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/kiki-ops:bogus`,
      );
      expect(body.code).toBe(40001);
      expect(body.msg).toMatch(/unsupported action/);
    });

    it('carries a file attachment into the activation message', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const noteBytes = Buffer.from('hello from the attachment');
      const form = new FormData();
      form.set('file', new Blob([noteBytes], { type: 'text/plain' }), 'note.txt');
      const uploadRes = await fetch(`${base}/api/files`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer),
        body: form,
      } as never);
      const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
      expect(uploaded.code).toBe(0);

      const { body } = await postJson<{ activated: boolean; skill_name: string }>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        {
          args: '--help',
          attachments: [
            {
              type: 'file',
              file_id: uploaded.data.id,
              name: 'note.txt',
              media_type: 'text/plain',
              size: noteBytes.length,
            },
          ],
        },
      );
      expect(body.code).toBe(0);
      expect(body.data).toEqual({ activated: true, skill_name: 'kiki-ops' });

      const messages = await getJson<{
        items: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      }>(`/api/sessions/${id}/messages`);
      const userMsg = messages.body.data.items.find((m) => m.role === 'user');
      expect(userMsg).toBeDefined();
      expect(userMsg!.content[0]?.type).toBe('text');
      expect(userMsg!.content[0]?.text).toContain('User activated the skill "kiki-ops"');
      const notice = userMsg!.content[1];
      expect(notice?.type).toBe('text');
      expect(notice?.text).toContain('Attached file "note.txt"');
      expect(notice?.text).toContain(`${noteBytes.length} bytes`);
      const attachedPath = /bytes\): (.+) — open it with the Read tool$/.exec(notice?.text ?? '')?.[1];
      expect(attachedPath).toBeDefined();
      expect(attachedPath?.replaceAll('\\', '/')).toContain('/attachments/');
      expect(await readFile(attachedPath!)).toEqual(noteBytes);
    });

    it('rejects an activation with a stale attachment file_id (40407)', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/kiki-ops:activate`,
        {
          attachments: [
            { type: 'file', file_id: 'f_does_not_exist', name: 'x.txt', media_type: 'text/plain', size: 1 },
          ],
        },
      );
      expect(body.code).toBe(40407);
    });

    it('rejects an unknown skill with attachments before materializing them (40415)', async () => {
      const id = await createSession();
      await createMainAgent(id);

      const noteBytes = Buffer.from('must never be materialized');
      const form = new FormData();
      form.set('file', new Blob([noteBytes], { type: 'text/plain' }), 'note.txt');
      const uploadRes = await fetch(`${base}/api/files`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer),
        body: form,
      } as never);
      const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
      expect(uploaded.code).toBe(0);

      const { body } = await postJson<null>(
        `/api/sessions/${id}/skills/does-not-exist:activate`,
        {
          attachments: [
            { type: 'file', file_id: uploaded.data.id, name: 'note.txt', media_type: 'text/plain', size: noteBytes.length },
          ],
        },
      );
      expect(body.code).toBe(40415);

      const sessionTree = await readdir(join(home as string, 'sessions'), { recursive: true });
      expect(sessionTree.filter((entry) => entry.includes('attachments'))).toEqual([]);
    });
  });

  describe('GET /api/workspaces/{wid}/skills', () => {
    it('lists skills for a workspace without creating a session', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-greeting');
      const wid = await registerWorkspace(workspaceDir);

      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/workspaces/${wid}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      const seeded = skills.find((s) => s.name === 'e2e-greeting');
      expect(seeded).toBeDefined();
      expect(seeded?.source).toBe('project');
      expect(seeded?.description).toBe('e2e test skill e2e-greeting');

      await seedProjectSkill(workspaceDir, 'e2e-added');
      await expect.poll(async () => {
        const refreshed = await getJson<{ skills: SkillWire[] }>(`/api/workspaces/${wid}/skills`);
        return refreshed.body.data.skills.some((skill) => skill.name === 'e2e-added');
      }, { timeout: 10_000 }).toBe(true);
    });

    it('matches the session listing for the same cwd', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-greeting');
      const wid = await registerWorkspace(workspaceDir);
      const sid = await createSession(workspaceDir);

      const [wsRes, sessRes] = await Promise.all([
        getJson<{ skills: SkillWire[] }>(`/api/workspaces/${wid}/skills`),
        getJson<{ skills: SkillWire[] }>(`/api/sessions/${sid}/skills`),
      ]);
      const wsSkills = listSkillsResponseSchema.parse(wsRes.body.data).skills;
      const sessSkills = listSkillsResponseSchema.parse(sessRes.body.data).skills;
      const names = (xs: readonly { name: string }[]) => xs.map((s) => s.name).toSorted();
      expect(names(wsSkills)).toEqual(names(sessSkills));
    });

    it('honors explicit skill dirs in workspace preview', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-explicit');
      const explicitDir = await makeWorkspaceDir();
      await seedExplicitSkill(explicitDir, 'e2e-explicit');

      await server!.close();
      server = undefined;
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        skillDirs: [explicitDir],
      });
      base = `http://127.0.0.1:${server.port}`;

      const wid = await registerWorkspace(workspaceDir);
      const { body } = await getJson<{ skills: SkillWire[] }>(
        `/api/workspaces/${wid}/skills`,
      );
      expect(body.code).toBe(0);
      const skills = listSkillsResponseSchema.parse(body.data).skills;
      const seeded = skills.find((s) => s.name === 'e2e-explicit');
      expect(seeded).toBeDefined();
      expect(seeded?.source).toBe('user');
      expect(seeded?.description).toBe('explicit skill e2e-explicit');
    });

    it('uses the selected user skill root without dropping project skills', async () => {
      const workspaceDir = await makeWorkspaceDir();
      await seedProjectSkill(workspaceDir, 'e2e-project');
      const selectedUserDir = await makeWorkspaceDir();
      await seedExplicitSkill(selectedUserDir, 'e2e-selected-user');
      await seedExplicitSkill(join(home as string, 'skills'), 'e2e-default-user');

      await server!.close();
      server = undefined;
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        userSkillDir: selectedUserDir,
      });
      base = `http://127.0.0.1:${server.port}`;

      const wid = await registerWorkspace(workspaceDir);
      const sid = await createSession(workspaceDir);
      const [workspaceResponse, sessionResponse] = await Promise.all([
        getJson<{ skills: SkillWire[] }>(`/api/workspaces/${wid}/skills`),
        getJson<{ skills: SkillWire[] }>(`/api/sessions/${sid}/skills`),
      ]);
      const workspaceSkills = listSkillsResponseSchema.parse(workspaceResponse.body.data).skills;
      const sessionSkills = listSkillsResponseSchema.parse(sessionResponse.body.data).skills;
      for (const skills of [workspaceSkills, sessionSkills]) {
        expect(skills.find((skill) => skill.name === 'e2e-selected-user')?.source).toBe('user');
        expect(skills.find((skill) => skill.name === 'e2e-project')?.source).toBe('project');
        expect(skills.some((skill) => skill.name === 'e2e-default-user')).toBe(false);
      }
    });

    it('returns 40410 for an unknown workspace', async () => {
      const { body } = await getJson<null>(
        '/api/workspaces/wd_does-not-exist_000000000000/skills',
      );
      expect(body.code).toBe(40410);
    });
  });
});

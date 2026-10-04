import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IAgentLifecycleService, IAgentProfileRegistry, IAgentProfileService, IAtomicDocumentStore, IConfigService, IEventBus, ISessionActivityView, ISessionIndex, ISessionManager, ISessionMetadata, IWorkspaceService, normalizeAgentProfile } from '@kiki/agent-core-v2';
import { TurnStarted } from '@kiki/agent-core-v2/agent/loop/turnEvents';
import { TurnEnded } from '@kiki/agent-core-v2/agent/loop/turnOps';
import { IBotService } from '@kiki/agent-core-v2/app/bot/bot';
import { IAgentExecutorRegistry, type AgentExecutorProvider } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import { ICronTaskPersistence } from '@kiki/agent-core-v2/app/cron/cronTaskPersistence';
import { IRoomService } from '@kiki/agent-core-v2/app/room/room';
import { IPersonaStore } from '@kiki/agent-core-v2/app/persona/personaStore';
import { IThreadCommunicationService } from '@kiki/agent-core-v2/app/threadCommunication/threadCommunication';
import { SEND_PEER_THREAD_MESSAGE, peerSendCapability } from '@kiki/agent-core-v2/app/threadCommunication/peerThreadCapability';
import { type PersonaSummary, type Session } from '@kiki/protocol';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> { code: number; msg: string; data: T }

describe('persona backend contracts', () => {
  let home: string;
  let server: RunningServer;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-persona-backend-'));
    await writeFile(join(home, 'config.toml'), [
      'default_model = "stub"', '[search]', 'enabled = false', '[providers.stub]', 'type = "openai"',
      'base_url = "http://127.0.0.1:9999"', 'api_key = "YOUR_API_KEY"',
      '[models.stub]', 'provider = "stub"', 'model = "stub"', 'max_context_size = 4000',
      '[models.other]', 'provider = "stub"', 'model = "other"', 'max_context_size = 4000',
    ].join('\n'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<Envelope<T>> {
    const response = await authedFetch(server, `http://127.0.0.1:${server.port}`, `/api${path}`, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await response.json() as Envelope<T>;
  }
  async function persona(id = 'example', homeWorkspace?: string) {
    return server.core.accessor.get(IPersonaStore).put({ id, name: id, description: `You are ${id}.`, homeWorkspace });
  }
  async function create(input: Record<string, unknown> = {}) {
    const result = await request<Session>('/sessions', 'POST', { persona: 'example', ...input });
    expect(result.code, result.msg).toBe(0);
    return result.data;
  }
  it('makes no-state summaries authoritative while keeping a missing daily pointer absent', async () => {
    await persona();
    const result = await request<PersonaSummary[]>('/personas');
    expect(result.code).toBe(0);
    expect(result.data[0]).toMatchObject({ pinned: false, hidden: false });
    expect(result.data[0]).not.toHaveProperty('homeSessionId');
  });
  it('projects cold canonical identity and filters conflicting legacy tags to one persona', async () => {
    await persona();
    await persona('other');
    const session = await create({ metadata: { cwd: home } });
    const handle = server.core.accessor.get(ISessionManager).get(session.id)!;
    await handle.accessor.get(ISessionMetadata).update({ custom: { bot_persona_id: 'other', room_persona_id: 'other' } });
    await server.core.accessor.get(ISessionManager).close(session.id);
    const listed = await request<{ items: Session[] }>('/sessions?persona=example&page_size=100');
    expect(listed.data.items.map((entry) => entry.id)).toContain(session.id);
    expect(listed.data.items.find((entry) => entry.id === session.id)?.agent_config.persona?.id).toBe('example');
    const other = await request<{ items: Session[] }>('/sessions?persona=other&page_size=100');
    expect(other.data.items).toEqual([]);
    expect(server.core.accessor.get(ISessionManager).get(session.id)).toBeUndefined();
  });
  it('projects legacy-only cold attribution without assigning conflicting metadata to two personas', async () => {
    await persona();
    await persona('other');
    const session = await create({ persona: undefined, metadata: { cwd: home } });
    await server.core.accessor.get(ISessionManager).get(session.id)!.accessor.get(ISessionMetadata).update({ custom: { bot_persona_id: 'example', room_persona_id: 'other' } });
    await server.core.accessor.get(ISessionManager).close(session.id);
    const own = await request<{ items: Session[] }>('/sessions?persona=example&page_size=100');
    expect(own.data.items[0]?.agent_config.persona?.id).toBe('example');
    expect((await request<{ items: Session[] }>('/sessions?persona=other&page_size=100')).data.items).toEqual([]);
  });
  it('resolves registered workspace ids as directories without changing existing conversations', async () => {
    const project = join(home, 'project');
    await mkdir(project);
    const workspace = await server.core.accessor.get(IWorkspaceService).createOrTouch(project);
    await persona('example', workspace.id);
    const session = await create();
    expect(session.metadata?.cwd).toBe(project);
    const saved = await request<import('@kiki/protocol').PersonaSnapshot>('/personas/example', 'PUT', { definition: { id: 'example', name: 'Example', description: 'Stored directory.', homeWorkspace: workspace.id } });
    expect(saved.code, saved.msg).toBe(0);
    expect(saved.data.definition.homeWorkspace).toBe(project);
    await persona('example', home);
    const old = await request<Session>(`/sessions/${session.id}`);
    expect(old.data.metadata?.cwd).toBe(session.metadata?.cwd);
  });
  it('keeps role defaults frozen across prompt rebuilding and only applies them explicitly', async () => {
    const original = await persona();
    const session = await create({ metadata: { cwd: home } });
    const profile = server.core.accessor.get(ISessionManager).get(session.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
    const latest = await server.core.accessor.get(IPersonaStore).put({ ...original.definition, description: 'Updated persona instruction.' });
    await profile.rebuildPromptContext();
    expect(profile.data().personaRevision).toBe(original.revision);
    await profile.applyPersonaSettings();
    expect(profile.data().personaRevision).toBe(latest.revision);
    expect(profile.data().systemPrompt).toContain('Updated persona instruction.');
  });
  it('prepares persona updates through the external executor binding validator without launching an executor', async () => {
    const executor = server.core.accessor.get(IAgentExecutorRegistry);
    const provider: AgentExecutorProvider = {
      id: 'fixture-provider', protocol: 'fixture-external', validateOptions: (input) => input as Record<string, string | number | boolean>,
      validateBinding: (binding) => ({ ok: true, binding }), create: vi.fn(() => { throw new Error('External execution is not allowed in this fixture.'); }),
    };
    const resolve = executor.resolveExecutable.bind(executor);
    vi.spyOn(executor, 'resolveExecutable').mockImplementation(async (id, options) => id === 'fixture-external'
      ? { descriptor: { id, protocol: 'fixture-external', args: [], revision: 'fixture' }, options: provider.validateOptions(options ?? {}), provider }
      : resolve(id, options));
    const validate = executor.validateBinding.bind(executor);
    const validation = vi.spyOn(executor, 'validateBinding').mockImplementation((id, options, binding) => id === 'fixture-external'
      ? provider.validateBinding(binding) : validate(id, options, binding));
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'external-persona-fixture', priority: 40,
      contribution: { profiles: [normalizeAgentProfile({ name: 'external', definitionId: 'fixture:external', description: 'External style', executor: 'fixture-external', modelAlias: 'external-model', systemPrompt: () => 'External work style.' })] },
    });
    try {
      const original = await server.core.accessor.get(IPersonaStore).put({ id: 'example', name: 'Example', description: 'Original external persona.', profile: 'external' });
      const session = await create({ metadata: { cwd: home } });
      const latest = await server.core.accessor.get(IPersonaStore).put({ ...original.definition, description: 'Latest external persona.' });
      const applied = await request<import('@kiki/protocol').SessionPersonaSettings>(`/sessions/${session.id}/persona-settings`, 'POST', {});
      expect(applied.code, applied.msg).toBe(0);
      expect(applied.data.boundRevision).toBe(latest.revision);
      expect(validation).toHaveBeenCalledWith('fixture-external', {}, expect.objectContaining({ modelAlias: 'external-model' }));
      expect(provider.create).not.toHaveBeenCalled();
    } finally { registration.dispose(); }
  });
  it('records explicit equal-valued selections and changes work style without refreshing the persona', async () => {
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'work-style-fixture', priority: 40,
      contribution: { profiles: [normalizeAgentProfile({ name: 'custom', definitionId: 'fixture:custom', description: 'Custom style', modelAlias: 'stub', tools: ['Read'], systemPrompt: () => 'Custom work style.' })] },
    });
    try {
      const original = await persona();
      const session = await create({ metadata: { cwd: home } });
      const profile = server.core.accessor.get(ISessionManager).get(session.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
      const selected = await request(`/sessions/${session.id}/profile`, 'POST', { agent_config: { profile: 'agent', model: 'stub', thinking: 'off' } });
      expect(selected.code, selected.msg).toBe(0);
      expect(profile.data().personaOverrides).toEqual({ profile: 'agent', model: 'stub', thinking: 'off' });
      await server.core.accessor.get(IPersonaStore).put({ ...original.definition, description: 'Should not implicitly apply.' });
      const switched = await request(`/sessions/${session.id}/profile`, 'POST', { agent_config: { profile: 'custom' } });
      expect(switched.code, switched.msg).toBe(0);
      expect(profile.data()).toMatchObject({ personaId: 'example', personaRevision: original.revision, profileName: 'custom', personaOverrides: { profile: 'custom', model: 'stub', thinking: 'off' } });
      expect(profile.data().systemPrompt).not.toContain('Should not implicitly apply.');
    } finally { registration.dispose(); }
  });
  it('preserves explicit override values and their sources through cold settings reads and clears them on restore defaults', async () => {
    const registration = server.core.accessor.get(IAgentProfileRegistry).register({ sourceId: 'persona-fixture', priority: 40,
      contribution: { profiles: [normalizeAgentProfile({ name: 'custom', definitionId: 'fixture:custom', description: 'Custom work style', modelAlias: 'stub', tools: ['Read'], systemPrompt: () => 'Custom work style.' })] },
    });
    try {
      const original = await persona();
      const session = await create({ metadata: { cwd: home }, agent_config: { profile: 'custom', model: 'stub', thinking: 'off' } });
      const latest = await server.core.accessor.get(IPersonaStore).put({ ...original.definition, profile: 'agent', modelAlias: 'other', description: 'Latest persona.' });
      await server.core.accessor.get(ISessionManager).close(session.id);
      const cold = await request<import('@kiki/protocol').SessionPersonaSettings>(`/sessions/${session.id}/persona-settings`);
      expect(cold.data).toMatchObject({ boundRevision: original.revision, latestRevision: latest.revision, hasUpdate: true, overrides: { profile: 'custom', model: 'stub', thinking: 'off' } });
      expect(server.core.accessor.get(ISessionManager).get(session.id)).toBeUndefined();
      const applied = await request<import('@kiki/protocol').SessionPersonaSettings>(`/sessions/${session.id}/persona-settings`, 'POST', {});
      expect(applied.code, applied.msg).toBe(0);
      expect(applied.data).toMatchObject({ boundRevision: latest.revision, hasUpdate: false, overrides: { profile: 'custom', model: 'stub', thinking: 'off' } });
      const profile = server.core.accessor.get(ISessionManager).get(session.id)!.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IAgentProfileService);
      expect(profile.data()).toMatchObject({ profileName: 'custom', profileDefinitionId: 'fixture:custom', modelAlias: 'stub', thinkingLevel: 'off' });
      const restored = await request<import('@kiki/protocol').SessionPersonaSettings>(`/sessions/${session.id}/persona-settings`, 'POST', { restoreDefaults: true });
      expect(restored.code, restored.msg).toBe(0);
      expect(restored.data.overrides).toEqual({});
      expect(profile.data()).toMatchObject({ profileName: 'agent', modelAlias: 'other', personaId: 'example' });
    } finally { registration.dispose(); }
  });
  it('rejects busy updates and failed preparation without changing the committed binding, then applies after cancellation', async () => {
    const original = await persona();
    const session = await create({ metadata: { cwd: home } });
    const handle = server.core.accessor.get(ISessionManager).get(session.id)!;
    const agent = handle.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = agent.accessor.get(IAgentProfileService);
    const old = profile.data();
    await server.core.accessor.get(IPersonaStore).put({ ...original.definition, modelAlias: 'missing-model' });
    await expect(profile.applyPersonaSettings()).rejects.toThrow();
    expect(profile.data()).toEqual(old);
    const latest = await server.core.accessor.get(IPersonaStore).put({ ...original.definition, description: 'Apply only when idle.' });
    agent.accessor.get(IEventBus).publish(new TurnStarted({ turnId: 1, origin: { kind: 'user' } }));
    expect(handle.accessor.get(ISessionActivityView).state().busy).toBe(true);
    const busy = await request(`/sessions/${session.id}/persona-settings`, 'POST', {});
    expect(busy.code).toBe(40001);
    expect(busy.msg).toMatch(/idle/);
    expect(profile.data().personaRevision).toBe(original.revision);
    agent.accessor.get(IEventBus).publish(new TurnEnded({ turnId: 1, reason: 'cancelled' }));
    expect(handle.accessor.get(ISessionActivityView).state().busy).toBe(false);
    const applied = await request(`/sessions/${session.id}/persona-settings`, 'POST', {});
    expect(applied.code, applied.msg).toBe(0);
    expect(profile.data().personaRevision).toBe(latest.revision);
  });
  it('rechecks busy admission after asynchronous preparation without committing the new persona', async () => {
    const original = await persona();
    const session = await create({ metadata: { cwd: home } });
    const agent = server.core.accessor.get(ISessionManager).get(session.id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const profile = agent.accessor.get(IAgentProfileService);
    const old = profile.data();
    const store = server.core.accessor.get(IPersonaStore);
    await store.put({ ...original.definition, description: 'Prepared but not committed.' });
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async (id) => {
      const value = await get(id);
      if (id === 'example') agent.accessor.get(IEventBus).publish(new TurnStarted({ turnId: 7, origin: { kind: 'user' } }));
      return value;
    });
    const rejected = await request(`/sessions/${session.id}/persona-settings`, 'POST', {});
    expect(rejected.code).toBe(40001);
    expect(rejected.msg).toMatch(/idle/);
    expect(profile.data()).toEqual(old);
    agent.accessor.get(IEventBus).publish(new TurnEnded({ turnId: 7, reason: 'cancelled' }));
  });
  it('claims the first daily conversation, preserves the winner and replaces only the pointer', async () => {
    await persona();
    const first = await create({ persona_home: true });
    expect(first.metadata?.cwd.replaceAll('\\', '/')).toBe(join(home, 'bots', 'example').replaceAll('\\', '/'));
    const store = server.core.accessor.get(IPersonaStore);
    expect((await store.getState('example')).homeSessionId).toBe(first.id);
    const next = await create({ persona_home: true, metadata: { cwd: home } });
    expect((await store.getState('example')).homeSessionId).toBe(first.id);
    const changed = await request(`/personas/example/home`, 'PUT', { sessionId: next.id });
    expect(changed.code, changed.msg).toBe(0);
    expect((await store.getState('example')).homeSessionId).toBe(next.id);
    expect(await server.core.accessor.get(ISessionIndex).get(first.id)).toBeDefined();
    await server.core.accessor.get(ISessionManager).close(next.id);
    expect((await request<{ homeSessionId: string }>('/personas/example/home', 'POST')).data.homeSessionId).toBe(next.id);
  });
  it('single-flights ensure-home without enabling old global gates and preserves explicit reply modes', async () => {
    await persona();
    const config = server.core.accessor.get(IConfigService);
    expect(config.get<{ enabled: boolean }>('bot').enabled).toBe(false);
    const homes = await Promise.all([request<{ homeSessionId: string }>('/personas/example/home', 'POST'), request<{ homeSessionId: string }>('/personas/example/home', 'POST')]);
    expect(homes[0]?.code).toBe(0);
    expect(homes[0]?.data.homeSessionId).toBe(homes[1]?.data.homeSessionId);
    const homeId = homes[0]!.data.homeSessionId;
    const session = await request<Session>(`/sessions/${homeId}`);
    expect(session.data.delivery).toBe('reply');
    expect(session.data.metadata).toMatchObject({ persona_home_managed: true, bot_persona_id: 'example' });
    expect(config.get<{ enabled: boolean }>('bot').enabled).toBe(false);
    const visible = await request('/personas/example/state', 'PATCH', { pinned: true, hidden: true });
    expect(visible.code).toBe(0);
    expect((await request<PersonaSummary[]>('/personas')).data[0]).toMatchObject({ pinned: true, hidden: true });
  });
  it('pauses only associated cron tasks on archive and does not restart them on restore or move their workspace', async () => {
    await persona();
    const session = await create({ metadata: { cwd: home } });
    const cron = server.core.accessor.get(ICronTaskPersistence);
    await cron.save(session.workspace_id, { id: 'a0000001', cron: '0 0 1 1 *', prompt: 'Fixture task', createdAt: Date.now(), recurring: true, tags: { sessionId: session.id } });
    await cron.save(session.workspace_id, { id: 'a0000002', cron: '0 0 1 1 *', prompt: 'Fixture task', createdAt: Date.now(), recurring: true });
    const archived = await request<import('@kiki/protocol').PersonaState>('/personas/example:archive', 'POST', { archived: true });
    expect(archived.code, archived.msg).toBe(0);
    expect(archived.data.pausedCronTasks).toEqual([{ workspaceId: session.workspace_id, taskId: 'a0000001', wasPaused: false }]);
    expect((await cron.get(session.workspace_id, 'a0000001'))?.paused).toBe(true);
    expect((await cron.get(session.workspace_id, 'a0000002'))?.paused).not.toBe(true);
    expect((await request('/personas/example:archive', 'POST', { archived: false })).code).toBe(0);
    expect((await cron.get(session.workspace_id, 'a0000001'))?.paused).toBe(true);
    expect((await request(`/sessions/${session.id}`)).code).toBe(0);
    expect((await request('/personas/example', 'DELETE')).code).toBe(0);
    expect(await cron.get(session.workspace_id, 'a0000001')).toBeUndefined();
    expect(await server.core.accessor.get(ISessionIndex).get(session.id)).toBeDefined();
  });
  it('does not leave an ensure-home orphan when first-send claiming wins the race', async () => {
    await persona();
    const store = server.core.accessor.get(IPersonaStore);
    const claim = store.claimHomeSession.bind(store);
    let winner: Session | undefined;
    let intercepted = false;
    vi.spyOn(store, 'claimHomeSession').mockImplementation(async (id, sessionId, expected) => {
      if (!intercepted) {
        intercepted = true;
        winner = await create({ metadata: { cwd: home }, persona_home: true });
      }
      return claim(id, sessionId, expected);
    });
    const ensured = await request<{ homeSessionId: string }>('/personas/example/home', 'POST');
    expect(ensured.code, ensured.msg).toBe(0);
    expect(ensured.data.homeSessionId).toBe(winner?.id);
    const sessions = await request<{ items: Session[] }>('/sessions?persona=example&page_size=100');
    expect(sessions.data.items.map((entry) => entry.id)).toEqual([winner?.id]);
  });
  it('rejects invalid or busy daily targets and retains the old pointer until cancellation', async () => {
    await persona();
    await persona('other');
    const daily = await create({ metadata: { cwd: home }, persona_home: true });
    const target = await create({ metadata: { cwd: home } });
    const other = await create({ persona: 'other', metadata: { cwd: home } });
    const ephemeral = await create({ ephemeral: true, metadata: { cwd: home } });
    for (const candidate of [other.id, ephemeral.id]) {
      expect((await request('/personas/example/home', 'PUT', { sessionId: candidate })).code).not.toBe(0);
    }
    const agent = server.core.accessor.get(ISessionManager).get(daily.id)!.accessor.get(IAgentLifecycleService).get('main')!;
    agent.accessor.get(IEventBus).publish(new TurnStarted({ turnId: 5, origin: { kind: 'user' } }));
    expect((await request('/personas/example/home', 'PUT', { sessionId: target.id })).code).not.toBe(0);
    expect((await server.core.accessor.get(IPersonaStore).getState('example')).homeSessionId).toBe(daily.id);
    agent.accessor.get(IEventBus).publish(new TurnEnded({ turnId: 5, reason: 'cancelled' }));
    expect((await request('/personas/example/home', 'PUT', { sessionId: target.id })).code).toBe(0);
  });
  it('admits new persona rooms without the old gate while preserving old paused rooms and their member history', async () => {
    await persona();
    await persona('other');
    const rooms = server.core.accessor.get(IRoomService);
    const room = await rooms.create({ name: 'Fixture room', workspace: home, members: [{ personaId: 'example', muted: true }, { personaId: 'other', muted: true }] });
    expect(room.legacyBotGate).toBe(false);
    expect(server.core.accessor.get(IConfigService).get<{ enabled: boolean }>('bot').enabled).toBe(false);
    const memberId = room.members[0]!.sessionId;
    expect((await request('/personas/example/home', 'PUT', { sessionId: memberId })).code).not.toBe(0);
    await rooms.pause(room.id);
    await server.core.accessor.get(IAtomicDocumentStore).set(`rooms/${room.id}`, 'room.json', { ...room, legacyBotGate: undefined, paused: true, pauseReason: 'manual' });
    const next = await rooms.create({ name: 'Another room', workspace: home, members: [{ personaId: 'example', muted: true }, { personaId: 'other', muted: true }] });
    expect(next.legacyBotGate).toBe(false);
    expect((await rooms.get(room.id))?.paused).toBe(true);
    await expect(rooms.continue(room.id)).rejects.toThrow(/disabled/i);
    await expect(rooms.postBotMessage(room.id, { sessionId: memberId, toolCallId: 'fixture-send', text: 'Blocked old room output.' })).rejects.toThrow(/disabled/i);
    expect((await request('/personas/example', 'DELETE')).code).toBe(0);
    expect((await server.core.accessor.get(ISessionIndex).get(memberId))?.archived).toBe(true);
  });
  it('routes a new named persona to an on-demand home, but does not revive old disabled message homes', async () => {
    await persona();
    const source = await create({ persona: undefined, metadata: { cwd: home } });
    const service = server.core.accessor.get(IBotService);
    expect((await service.resolve('@example'))?.homeSessionId).toBeUndefined();
    const send = vi.spyOn(peerSendCapability(server.core.accessor.get(IThreadCommunicationService)), SEND_PEER_THREAD_MESSAGE)
      .mockResolvedValue({ messageId: 'fixture-message', targetSeq: 1, acceptedAt: Date.now(), deduplicated: false, delivery: 'pending' });
    const receipt = await service.sendHandoff({ sourceSessionId: source.id, target: '@example', content: 'Fixture handoff.', idempotencyKey: 'new-handoff' });
    const daily = (await server.core.accessor.get(IPersonaStore).getState('example')).homeSessionId;
    expect(receipt.handoff?.targetSessionId).toBe(daily);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ sessionId: daily, personaId: 'example' }), allowWhenDisabled: true }));
    await server.core.accessor.get(ISessionManager).get(daily!)!.accessor.get(ISessionMetadata).update({ custom: { bot_persona_id: 'example' } });
    await expect(service.sendHandoff({ sourceSessionId: source.id, target: '@example', content: 'Old home handoff.', idempotencyKey: 'old-handoff' })).rejects.toThrow(/disabled/i);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records calls, replays scripted results, and captures listen subscriptions. */
class FakeChannel implements KlientChannel {
  readonly calls: Array<{ scope: ScopeRef; service: string; method: string; args: unknown[] }> = [];
  readonly subscriptions: Array<{
    scope: ScopeRef;
    source: EventSourceRef;
    dispose: ReturnType<typeof vi.fn>;
    onReady?: () => void;
    onError?: (error: Error) => void;
  }> = [];
  result: unknown;
  /** Keyed `${service}.${method}` result overrides. */
  readonly results = new Map<string, unknown>();
  private readonly handlers = new Map<number, (data: unknown) => void>();
  private nextSub = 0;

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ scope, service, method, args });
    const key = `${service}.${method}`;
    return Promise.resolve(this.results.has(key) ? this.results.get(key) : this.result);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_scope: ScopeRef, _service: string, _method: string, _args: unknown[]): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised in facade tests
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable {
    const id = this.nextSub;
    this.nextSub += 1;
    this.handlers.set(id, handler);
    const dispose = vi.fn(() => {
      this.handlers.delete(id);
    });
    this.subscriptions.push({ scope, source, dispose, onError, onReady });
    return { dispose };
  }

  /** Push a raw payload into the Nth subscription (0-based). */
  emit(index: number, data: unknown): void {
    this.handlers.get(index)?.(data);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SUMMARY = {
  id: 's1',
  workspaceId: 'w1',
  createdAt: 1,
  updatedAt: 2,
  archived: false,
};

describe('facade routing', () => {
  it.each([
    { pendingInteraction: 'none', busy: false, expected: 'idle' },
    { pendingInteraction: 'none', busy: true, expected: 'running' },
    { pendingInteraction: 'approval', busy: true, expected: 'awaiting_approval' },
    { pendingInteraction: 'question', busy: true, expected: 'awaiting_question' },
    { pendingInteraction: 'approval', busy: false, expected: 'awaiting_approval' },
    { pendingInteraction: 'question', busy: false, expected: 'awaiting_question' },
  ])('maps one session activity snapshot to $expected ($pendingInteraction, $busy)', async ({
    pendingInteraction, busy, expected,
  }) => {
    const channel = new FakeChannel();
    channel.result = { pendingInteraction, busy, mainTurnActive: false };
    const klient = createKlientFromChannel(channel);

    await expect(klient.session('s1').status()).resolves.toBe(expected);
    expect(channel.calls).toEqual([
      { scope: { sessionId: 's1' }, service: 'sessionActivityView', method: 'state', args: [] },
    ]);
  });

  it('does not report idle when the session activity request fails', async () => {
    const channel = new FakeChannel();
    const failure = new Error('transport disconnected');
    vi.spyOn(channel, 'call').mockRejectedValue(failure);
    const klient = createKlientFromChannel(channel);

    await expect(klient.session('s1').status()).rejects.toBe(failure);
    expect(channel.call).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed session activity instead of deriving an idle result', async () => {
    const channel = new FakeChannel();
    channel.result = { busy: false, mainTurnActive: false, pendingInteraction: 'unknown' };
    const klient = createKlientFromChannel(channel);

    await expect(klient.session('s1').status()).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('reshapes single-object params into positional wire args', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = {
      id: 'w1',
      root: '/x',
      name: 'n',
      createdAt: 1,
      lastOpenedAt: 2,
      pinned: true,
    };
    await expect(
      klient.global.workspaces.createOrTouch({ root: '/x', name: 'n' }),
    ).resolves.toMatchObject({ pinned: true });
    expect(channel.calls[0]).toMatchObject({
      service: 'workspaceService',
      method: 'createOrTouch',
      args: ['/x', 'n'],
    });

    channel.result = undefined; // void output
    await klient.global.plugins.setMcpServerEnabled({ id: 'p', server: 's', enabled: true });
    expect(channel.calls[1]).toMatchObject({
      service: 'pluginService',
      method: 'setPluginMcpServerEnabled',
      args: [{ id: 'p', server: 's', enabled: true }],
    });

    channel.results.set('oauthService.status', { loggedIn: false });
    await klient.global.auth.status();
    expect(channel.calls[2]).toMatchObject({
      service: 'oauthService',
      method: 'status',
      args: [undefined],
    });
  });

  it('forwards the login region option through the wire contract', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.results.set('oauthService.startLogin', {
      flow_id: 'f1',
      provider: 'managed:kimi-code',
      status: 'pending',
      verification_uri: 'https://example.com/device',
      verification_uri_complete: 'https://example.com/device?user_code=ABCD',
      user_code: 'ABCD',
      expires_in: 1800,
      expires_at: '2026-08-19T15:00:00.000Z',
      interval: 5,
    });
    await klient.global.auth.startLogin('managed:kimi-code', { region: 'global' });
    expect(channel.calls[0]).toMatchObject({
      service: 'oauthService',
      method: 'startLogin',
      args: ['managed:kimi-code', { region: 'global' }],
    });
  });

  it('routes capability calls through the registered app service contract', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const status = {
      id: 'kimi-cu',
      displayName: 'Kimi Computer Use',
      description: 'Background GUI automation',
      supported: true,
      state: 'partial',
      steps: [{ id: 'permissions', state: 'missing' }],
      // The completed-install note survives the contract parse (not stripped).
      install: { running: false, note: 'user-skill-migrated' },
    };
    channel.result = [status];

    await expect(klient.global.capabilities.list()).resolves.toEqual([status]);
    channel.result = status;
    await expect(klient.global.capabilities.get('kimi-cu')).resolves.toEqual(status);
    await expect(klient.global.capabilities.install('kimi-cu')).resolves.toEqual(status);

    expect(channel.calls).toEqual([
      { scope: {}, service: 'capabilityService', method: 'listCapabilities', args: [] },
      { scope: {}, service: 'capabilityService', method: 'getCapability', args: ['kimi-cu'] },
      { scope: {}, service: 'capabilityService', method: 'installCapability', args: ['kimi-cu'] },
    ]);
  });

  it('env() fans out property reads and merges them', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    const env = await klient.global.env();
    expect(env.platform).toBe('v');
    expect(env.logsDir).toBe('v');
    expect(env.clientVersion).toBe('v');
    expect(channel.calls).toHaveLength(12);
    expect(channel.calls.every((call) => call.service === 'bootstrapService')).toBe(true);
  });

  it('env() resolves once and serves repeats from the cache', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = 'v';
    channel.results.set('bootstrapService.clientIdentity', {
      productName: 'v',
      version: 'v',
      platform: 'v',
    });
    await klient.global.env();
    expect(channel.calls).toHaveLength(12);

    const again = await klient.global.env();
    expect(again.platform).toBe('v');
    expect(channel.calls).toHaveLength(12);
  });
});

describe('thread facade routing', () => {
  const target = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'session-b' };

  it('routes host-qualified list/read/send/wait and override calls at App scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('threadCommunicationService.hostId', 'host-a');
    channel.results.set('threadCommunicationService.listThreads', { threads: [] });
    channel.results.set('threadCommunicationService.readThread', { thread: target, turns: [] });
    channel.results.set('threadCommunicationService.sendMessage', {
      messageId: 'message-a', targetSeq: 1, acceptedAt: 2, deduplicated: false, delivery: 'pending',
    });
    channel.results.set('threadCommunicationService.waitThreads', {
      threads: [{ thread: target, cursor: 'cursor-a', activities: [] }], timedOut: true,
    });
    channel.results.set('threadCommunicationService.getWorkspaceOverride', false);
    channel.results.set('threadCommunicationService.setWorkspaceOverride', undefined);
    channel.results.set('threadCommunicationService.clearWorkspaceOverride', undefined);
    channel.results.set('threadCommunicationService.isWorkspaceEnabled', false);

    await expect(klient.global.threads.hostId()).resolves.toBe('host-a');
    await klient.global.threads.list({ workspaceId: 'workspace-b' });
    await klient.global.threads.read({ thread: target, limit: 3 });
    await klient.global.threads.send({ target, content: 'hello', idempotencyKey: 'key-a' });
    await klient.global.threads.wait({ threads: [{ thread: target }], timeoutMs: 0 });
    await expect(klient.global.threads.getWorkspaceOverride('workspace-b')).resolves.toBe(false);
    await klient.global.threads.setWorkspaceOverride('workspace-b', false);
    await klient.global.threads.clearWorkspaceOverride('workspace-b');
    await expect(klient.global.threads.isWorkspaceEnabled('workspace-b')).resolves.toBe(false);

    expect(channel.calls.every((call) => Object.keys(call.scope).length === 0)).toBe(true);
    expect(channel.calls.map(({ service, method, args }) => ({ service, method, args }))).toEqual([
      { service: 'threadCommunicationService', method: 'hostId', args: [] },
      { service: 'threadCommunicationService', method: 'listThreads', args: [{ workspaceId: 'workspace-b' }] },
      { service: 'threadCommunicationService', method: 'readThread', args: [{ thread: target, limit: 3 }] },
      { service: 'threadCommunicationService', method: 'sendMessage', args: [{ target, content: 'hello', idempotencyKey: 'key-a' }] },
      { service: 'threadCommunicationService', method: 'waitThreads', args: [{ threads: [{ thread: target }], timeoutMs: 0 }] },
      { service: 'threadCommunicationService', method: 'getWorkspaceOverride', args: ['workspace-b'] },
      { service: 'threadCommunicationService', method: 'setWorkspaceOverride', args: ['workspace-b', false] },
      { service: 'threadCommunicationService', method: 'clearWorkspaceOverride', args: ['workspace-b'] },
      { service: 'threadCommunicationService', method: 'isWorkspaceEnabled', args: ['workspace-b'] },
    ]);
  });

  it('rejects malformed references and wait bounds before transport', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.threads.read({ thread: { ...target, hostId: '' } }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    await expect(
      klient.global.threads.wait({ threads: Array.from({ length: 9 }, () => ({ thread: target })) }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    await expect(
      klient.global.threads.wait({ threads: [{ thread: target }, { thread: target }] }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    await expect(
      klient.global.threads.send({
        source: { ...target, sessionId: 'forged-source' },
        target,
        content: 'legacy input',
        idempotencyKey: 'legacy-key',
      } as never),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toEqual([]);
  });
});

describe('agent profile routing', () => {
  it('thinking calls route to agentProfileService with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = undefined; // void output
    await agent.setThinking('on');
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentProfileService',
      method: 'setThinking',
      args: ['on'],
    });

    channel.result = 'high';
    await expect(agent.getThinking()).resolves.toBe('high');
    expect(channel.calls[1]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentProfileService',
      method: 'getEffectiveThinkingLevel',
      args: [],
    });
  });
});

describe('agent skill routing', () => {
  it('promptWithSkills routes to agentSkillService.promptWithSkills with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = {
      turn_id: 7,
      prompt_id: 'p1',
      created_at: '2026-01-01T00:00:00.000Z',
      state: 'running',
      append_timing: 'agent_idle',
      revision: 0,
    };
    await expect(
      agent.promptWithSkills({
        input: [{ type: 'text', text: 'Review this change.' }],
        skills: [{ name: 'review' }, { name: 'security', args: 'src/app.ts' }],
      }),
    ).resolves.toEqual({
      turn_id: 7,
      prompt_id: 'p1',
      created_at: '2026-01-01T00:00:00.000Z',
      state: 'running',
      append_timing: 'agent_idle',
      revision: 0,
    });
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentSkillService',
      method: 'promptWithSkills',
      args: [
        {
          input: [{ type: 'text', text: 'Review this change.' }],
          skills: [{ name: 'review' }, { name: 'security', args: 'src/app.ts' }],
        },
      ],
    });
  });
});

describe('session skills routing', () => {
  it('skills.list routes to sessionSkillCatalog.list with the session scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    const summaries = [
      {
        name: 'review',
        description: 'review changes',
        path: '/skills/review/SKILL.md',
        source: 'project',
      },
    ];
    channel.result = summaries;
    await expect(klient.session('s1').skills.list()).resolves.toEqual(summaries);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1' },
      service: 'sessionSkillCatalog',
      method: 'list',
      args: [],
    });
  });

  it('skills.changed maps to the sessionSkillCatalog emitter', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];

    klient.session('s1').events.on('skills.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'sessionSkillCatalog',
      event: 'onDidChange',
    });

    channel.emit(0, 'workspace');
    await tick();
    expect(seen).toEqual(['workspace']);
  });

  it('activateSkill routes to agentSkillService with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = { turn_id: 3 };
    await expect(agent.activateSkill({ name: 'review', args: 'src/app.ts' })).resolves.toEqual({
      turn_id: 3,
    });
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentSkillService',
      method: 'activate',
      args: [{ name: 'review', args: 'src/app.ts' }],
    });
  });

  it('turn-driving calls route to their domain services with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const scope = { sessionId: 's1', agentId: 'main' };

    channel.results.set('agentPromptService.submit', { turn_id: 1 });
    channel.results.set('agentPromptService.submitSteer', { turn_id: 1 });
    channel.results.set('agentCommandService.list', []);
    await agent.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await agent.steer({ input: [{ type: 'text', text: 'steer' }] });
    await agent.cancel({ turnId: 2 });
    await agent.cancel();
    await agent.setPermission('yolo');
    await agent.listCommands();
    await agent.runCommand({ name: 'cmd', args: 'a b' });
    await agent.runCommand({ name: 'plain' });

    expect(channel.calls).toEqual([
      {
        scope,
        service: 'agentPromptService',
        method: 'submit',
        args: [{ input: [{ type: 'text', text: 'hi' }] }],
      },
      {
        scope,
        service: 'agentPromptService',
        method: 'submitSteer',
        args: [{ input: [{ type: 'text', text: 'steer' }] }],
      },
      { scope, service: 'agentLoopService', method: 'cancelFromUser', args: [2] },
      { scope, service: 'agentLoopService', method: 'cancelFromUser', args: [] },
      { scope, service: 'agentPermissionModeService', method: 'setModeAndBroadcast', args: ['yolo'] },
      { scope, service: 'agentCommandService', method: 'list', args: [] },
      { scope, service: 'agentCommandService', method: 'run', args: ['cmd', 'a b'] },
      { scope, service: 'agentCommandService', method: 'run', args: ['plain'] },
    ]);
  });

  it('getContext merges the contextMemory and tokenCounting reads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const scope = { sessionId: 's1', agentId: 'main' };

    channel.results.set('agentContextMemoryService.get', [{ role: 'user' }]);
    channel.results.set('agentTokenCountingService.statusSize', 42);
    await expect(agent.getContext()).resolves.toEqual({
      history: [{ role: 'user' }],
      tokenCount: 42,
    });
    expect(channel.calls).toEqual([
      { scope, service: 'agentContextMemoryService', method: 'get', args: [] },
      { scope, service: 'agentTokenCountingService', method: 'statusSize', args: [] },
    ]);
  });
});

describe('agent mcp / compaction routing', () => {
  it('cancels compaction through the agent-scoped contract', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(klient.session('s1').agent('child').cancelCompaction()).resolves.toBeUndefined();
    expect(channel.calls).toEqual([
      { scope: { sessionId: 's1', agentId: 'child' }, service: 'agentFullCompactionService', method: 'cancel', args: [] },
    ]);
  });
  it('getMcpServers returns the live snapshot with the agent scope', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    const entries = [
      { name: 'mock', transport: 'stdio', status: 'pending', toolCount: 0 },
    ];
    channel.results.set('agentMcpService.list', entries);
    await expect(agent.getMcpServers()).resolves.toEqual(entries);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentMcpService',
      method: 'list',
      args: [],
    });
    expect(channel.calls).toHaveLength(1);
  });

  it('compact issues a manual begin with the optional instruction', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    channel.result = true;
    await expect(agent.compact()).resolves.toBe(true);
    expect(channel.calls[0]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentFullCompactionService',
      method: 'begin',
      args: [{ source: 'manual', instruction: undefined }],
    });

    channel.result = false;
    await expect(agent.compact({ instruction: 'keep the plan' })).resolves.toBe(false);
    expect(channel.calls[1]).toEqual({
      scope: { sessionId: 's1', agentId: 'main' },
      service: 'agentFullCompactionService',
      method: 'begin',
      args: [{ source: 'manual', instruction: 'keep the plan' }],
    });
  });
});

describe('agent domain routing', () => {
  it('routes context, undo, plugin, swarm, task, MCP, and status reads through contracts', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('child');
    const scope = { sessionId: 's1', agentId: 'child' };
    channel.results.set('agentLoopService.status', {
      state: 'idle',
      pendingTurnIds: [],
      hasPendingRequests: false,
    });
    channel.results.set('agentProfileService.getModelCapabilities', {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 1000,
    });
    channel.results.set('agentProfileService.getAgentsMdWarning', 'warning');
    channel.results.set('agentPermissionModeService.mode', 'manual');
    channel.results.set('agentSwarmService.isActive', true);
    channel.results.set('agentMcpService.list', []);
    channel.results.set('agentMcpService.initialLoadDurationMs', 3);
    channel.results.set('agentConversationUndoService.undo', 1);
    channel.results.set('agentTaskService.detach', undefined);
    channel.results.set('agentFullCompactionService.isCompacting', false);
    channel.results.set('agentContextRebuildService.rebuild', {
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'injections'],
      changed: true,
      changes: { profile: true, promptFields: false, skills: false, instructions: true, plugins: false, injections: false },
    });

    await agent.activatePluginCommand({ pluginId: 'plugin', commandName: 'command', args: 'arg' });
    await agent.refreshPluginSessionStart();
    await expect(agent.getLoopStatus()).resolves.toMatchObject({ state: 'idle' });
    await expect(agent.getModelCapabilities()).resolves.toMatchObject({ max_context_tokens: 1000 });
    await expect(agent.getAgentsMdWarning()).resolves.toBe('warning');
    await agent.appendContext({ role: 'user', content: [], toolCalls: [] });
    await agent.clearContext();
    await expect(agent.rebuildContext()).resolves.toMatchObject({ changed: true });
    await expect(agent.undo(1)).resolves.toBe(1);
    await agent.enterSwarm('manual');
    await agent.exitSwarm();
    await expect(agent.getSwarmMode()).resolves.toBe(true);
    await agent.reconcileContextWhenIdle('swarm_mode');
    await agent.stopTaskWithReason({ taskId: 'task-1' });
    await expect(agent.detachTask('task-1')).resolves.toBeUndefined();
    await agent.waitForMcpInitialLoad();
    await expect(agent.getMcpStartupDuration()).resolves.toBe(3);
    await agent.reconnectMcpServer('server');
    await agent.connectMcpServer({
      name: 'server',
      config: { transport: 'stdio', command: 'node' },
    });
    await expect(agent.isCompacting()).resolves.toBe(false);

    expect(channel.calls).toEqual([
      { scope, service: 'agentPluginCommandService', method: 'activate', args: [{ pluginId: 'plugin', commandName: 'command', args: 'arg' }] },
      { scope, service: 'agentPluginService', method: 'refreshSessionStart', args: [] },
      { scope, service: 'agentLoopService', method: 'status', args: [] },
      { scope, service: 'agentProfileService', method: 'getModelCapabilities', args: [] },
      { scope, service: 'agentProfileService', method: 'getAgentsMdWarning', args: [] },
      { scope, service: 'agentContextMemoryService', method: 'append', args: [{ role: 'user', content: [], toolCalls: [] }] },
      { scope, service: 'agentContextMemoryService', method: 'clear', args: [] },
      { scope, service: 'agentContextRebuildService', method: 'rebuild', args: [] },
      { scope, service: 'agentConversationUndoService', method: 'undo', args: [1] },
      { scope, service: 'agentSwarmService', method: 'enter', args: ['manual'] },
      { scope, service: 'agentSwarmService', method: 'exit', args: [] },
      { scope, service: 'agentSwarmService', method: 'isActive', args: [] },
      { scope, service: 'agentContextInjectorService', method: 'reconcileWhenIdle', args: ['swarm_mode'] },
      { scope, service: 'agentTaskService', method: 'stop', args: ['task-1'] },
      { scope, service: 'agentTaskService', method: 'detach', args: ['task-1'] },
      { scope, service: 'agentMcpService', method: 'waitForInitialLoad', args: [] },
      { scope, service: 'agentMcpService', method: 'initialLoadDurationMs', args: [] },
      { scope, service: 'agentMcpService', method: 'reconnect', args: ['server'] },
      { scope, service: 'agentMcpService', method: 'connect', args: ['server', { transport: 'stdio', command: 'node' }] },
      { scope, service: 'agentFullCompactionService', method: 'isCompacting', args: [] },
    ]);
  });

  it('keeps the convenience stopTask user reason distinct from the explicit stop path', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');

    await agent.stopTask({ taskId: 'user-task' });
    await agent.stopTaskWithReason({ taskId: 'rpc-task' });

    expect(channel.calls).toEqual([
      { scope: { sessionId: 's1', agentId: 'main' }, service: 'agentTaskService', method: 'stopByUser', args: ['user-task'] },
      { scope: { sessionId: 's1', agentId: 'main' }, service: 'agentTaskService', method: 'stop', args: ['rpc-task'] },
    ]);
  });
});

describe('session domain routing', () => {
  it('routes todos, init, btw, and cron through their session contracts', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const session = klient.session('s1');
    const todos = [{ title: 'child task', status: 'in_progress' as const }];
    channel.results.set('sessionTodoService.getTodos', todos);
    channel.results.set('sessionBtwService.start', 'btw-child');
    channel.results.set('sessionCronService.list', [{ id: 'cron-1', cron: '* * * * *', prompt: 'tick', createdAt: 1 }]);
    channel.results.set('sessionCronService.getNextFireForTask', 42);

    await expect(session.todos.get('child')).resolves.toEqual(todos);
    await expect(session.todos.get()).resolves.toEqual(todos);
    await session.init.generateAgentsMd();
    await session.init.cancelInit();
    await expect(session.btw.start()).resolves.toBe('btw-child');
    await expect(session.cron.list()).resolves.toEqual([{ id: 'cron-1', cron: '* * * * *', prompt: 'tick', createdAt: 1 }]);
    await expect(session.cron.nextFireAt('cron-1')).resolves.toBe(42);

    expect(channel.calls).toEqual([
      { scope: { sessionId: 's1' }, service: 'sessionTodoService', method: 'getTodos', args: ['child'] },
      { scope: { sessionId: 's1' }, service: 'sessionTodoService', method: 'getTodos', args: [] },
      { scope: { sessionId: 's1' }, service: 'sessionInitService', method: 'generateAgentsMd', args: [] },
      { scope: { sessionId: 's1' }, service: 'sessionInitService', method: 'cancelInit', args: [] },
      { scope: { sessionId: 's1' }, service: 'sessionBtwService', method: 'start', args: [] },
      { scope: { sessionId: 's1' }, service: 'sessionCronService', method: 'list', args: [] },
      { scope: { sessionId: 's1' }, service: 'sessionCronService', method: 'getNextFireForTask', args: ['cron-1'] },
    ]);
  });
});

describe('session lifecycle routing', () => {
  it('delete calls the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.delete', undefined);

    await klient.session('s1').delete();

    expect(channel.calls).toEqual([
      { scope: {}, service: 'sessionManager', method: 'delete', args: ['s1'] },
    ]);
  });

  it('restore forwards resume options to the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.restore', { id: 's1', kind: 'session' });

    const opts = {
      mcpServers: { example: { transport: 'stdio' as const, command: 'node' } },
    };
    await expect(klient.session('s1').restore(opts)).resolves.toBe(true);

    expect(channel.calls[0]).toEqual({
      scope: {},
      service: 'sessionManager',
      method: 'restore',
      args: ['s1', opts],
    });
  });

  it('sessions.create forwards mcpServers to the App session manager', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.results.set('sessionManager.create', { id: 's1', kind: 'session' });
    channel.results.set('sessionMetadata.read', {
      id: 's1',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
    });

    const mcpServers = {
      example: { transport: 'stdio' as const, command: 'node', args: ['server.mjs'] },
    };
    await klient.global.sessions.create({ workDir: '/x', mcpServers });

    expect(channel.calls[0]).toMatchObject({
      scope: {},
      service: 'sessionManager',
      method: 'create',
      args: [{ workDir: '/x', mcpServers }],
    });
  });

  it('sessions.create rejects malformed mcpServers before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.create({
        workDir: '/x',
        mcpServers: { bad: { transport: 'http', url: 'not-a-url' } },
      }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls.some((call) => call.method === 'create')).toBe(false);
  });
});

describe('contract validation', () => {
  it('rejects invalid input before the call leaves the client', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });

  it('rejects drifted output payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = { id: 's1' }; // missing required SessionSummary fields
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
  });

  it('passes valid payloads through and returns parsed output', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    channel.result = SUMMARY;
    await expect(klient.global.sessions.get('s1')).resolves.toEqual(SUMMARY);
  });

  it('validate:false skips both directions', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel, { validate: false });
    channel.result = { anything: true };
    await expect(
      klient.global.sessions.list({ limit: '20' as unknown as number }),
    ).resolves.toEqual({ anything: true });
  });
});

describe('event hub', () => {
  it('waits for shared source attachment before submitting a fast prompt', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const seen: string[] = [];
    const delta = agent.events.on('assistant.delta', (event) => seen.push(event.delta));
    const ended = agent.events.on('turn.ended', () => seen.push('ended'));
    let submitted = false;
    const run = Promise.all([delta.ready, ended.ready]).then(async () => {
      submitted = true;
      channel.emit(0, { type: 'assistant.delta', turnId: 0, delta: 'first token' });
      channel.emit(0, { type: 'turn.ended', turnId: 0, reason: 'completed' });
      channel.result = { promptId: 'fast', turnId: 0, state: 'completed', result: { type: 'completed', steps: 1, truncated: false } };
      return agent.prompt({ input: [{ type: 'text', text: 'hello' }] }, { waitFor: 'terminal' });
    });
    await tick();
    expect(submitted).toBe(false);
    expect(channel.subscriptions).toHaveLength(1);
    channel.subscriptions[0]!.onReady!();
    expect(await run).toMatchObject({ state: 'completed', turnId: 0 });
    expect(channel.calls[0]!.method).toBe('submitAndWait');
    expect(seen).toEqual(['first token', 'ended']);
    const later = agent.events.on('assistant.delta', () => {});
    await later.ready;
    delta.dispose(); ended.dispose(); later.dispose();
    expect(channel.subscriptions[0]!.dispose).toHaveBeenCalledOnce();
  });

  it.each(['dispose', 'close', 'error'] as const)('rejects attachment when %s happens before readiness', async (action) => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const sub = klient.session('s1').agent('main').events.on('assistant.delta', () => {});
    const rejected = expect(sub.ready).rejects.toThrow();
    if (action === 'dispose') sub.dispose();
    else if (action === 'close') await klient.close();
    else channel.subscriptions[0]!.onError!(new Error('attachment failed'));
    await rejected;
    sub.dispose();
  });

  it('rejects a synchronous source attachment error', async () => {
    const channel = new FakeChannel();
    const listen = channel.listen.bind(channel);
    vi.spyOn(channel, 'listen').mockImplementation((scope, source, handler, onError, onReady) => {
      const subscription = listen(scope, source, handler, onError, onReady);
      onError?.(new Error('synchronous attachment failure'));
      return subscription;
    });
    const klient = createKlientFromChannel(channel);
    const sub = klient.session('s1').agent('main').events.on('assistant.delta', () => {});
    await expect(sub.ready).rejects.toThrow('synchronous attachment failure');
    sub.dispose();
  });

  it('requires a fresh attachment for a listener added during disconnection', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const events = klient.session('s1').agent('main').events;
    const first = events.on('assistant.delta', () => {});
    channel.subscriptions[0]!.onReady!();
    await first.ready;
    channel.subscriptions[0]!.onError!(new Error('disconnected'));
    const second = events.on('turn.ended', () => {});
    let ready = false;
    const attached = second.ready.then(() => { ready = true; });
    await tick();
    expect(ready).toBe(false);
    channel.subscriptions[0]!.onReady!();
    await attached;
    first.dispose(); second.dispose();
  });

  it('observes only after every source ack and discards initial-read races and late results', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const reads: Array<{ signal: AbortSignal; resolve: (value: number) => void }> = [];
    const read = vi.fn((signal: AbortSignal) => new Promise<number>((resolve) => {
      reads.push({ signal, resolve });
    }));
    const seen: number[] = [];
    const observation = klient.events.observe({
      events: ['config.changed', 'kosong.providers.changed', 'config.changed'], read,
    }, (value) => seen.push(value));
    expect(channel.subscriptions).toHaveLength(2);
    channel.subscriptions[0]?.onReady?.();
    await tick();
    expect(read).not.toHaveBeenCalled();
    channel.subscriptions[1]?.onReady?.();
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    channel.emit(0, {});
    await tick();
    expect(reads[0]?.signal.aborted).toBe(true);
    reads[1]?.resolve(2);
    await tick();
    reads[0]?.resolve(1);
    await tick();
    expect(seen).toEqual([2]);
    channel.emit(1, {});
    await tick();
    observation.dispose();
    expect(reads[2]?.signal.aborted).toBe(true);
    reads[2]?.resolve(3);
    await tick();
    expect(seen).toEqual([2]);
    expect(channel.subscriptions.every((sub) => sub.dispose.mock.calls.length === 1)).toBe(true);
    await klient.close();
  });

  it('invalidates on disconnect, waits for restored ack and cancels on hub close', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const reads: Array<{ signal: AbortSignal; resolve: (value: number) => void }> = [];
    const seen: number[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => errors.push(error));
    klient.events.observe({ events: ['config.changed'], read: (signal) => new Promise<number>((resolve) => {
      reads.push({ signal, resolve });
    }) }, (value) => seen.push(value));
    const source = channel.subscriptions[0]!;
    source.onReady?.();
    await tick();
    source.onError?.(new Error('disconnected'));
    reads[0]?.resolve(1);
    await tick();
    expect(seen).toEqual([]);
    expect(reads).toHaveLength(1);
    source.onReady?.();
    await tick();
    source.onError?.(new Error('disconnected again'));
    source.onReady?.();
    await tick();
    reads[2]?.resolve(3);
    reads[1]?.resolve(2);
    await tick();
    expect(seen).toEqual([3]);
    expect(errors).toHaveLength(2);
    channel.emit(0, {});
    await tick();
    await klient.close();
    expect(reads[3]?.signal.aborted).toBe(true);
    reads[3]?.resolve(4);
    source.onReady?.();
    await tick();
    expect(seen).toEqual([3]);
    expect(reads).toHaveLength(4);
  });

  it('reports failed readers and failed subscriptions without publishing an idle snapshot', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const errors: Error[] = [];
    const listener = vi.fn();
    klient.events.onError((error) => errors.push(error));
    const read = vi.fn(() => Promise.reject(new Error('unsupported state GET')));
    klient.events.observe({ events: ['config.changed'], read }, listener);
    channel.subscriptions[0]?.onReady?.();
    await tick();
    expect(errors[0]?.message).toBe('unsupported state GET');
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    const blockedRead = vi.fn(() => Promise.resolve('idle'));
    klient.events.observe({ events: ['config.changed'], read: blockedRead }, listener);
    channel.subscriptions[1]?.onError?.(new Error('unauthorized'));
    await tick();
    expect(blockedRead).not.toHaveBeenCalled();
    expect(errors[1]?.message).toBe('unauthorized');
    expect(() => klient.events.observe({ events: [], read }, listener)).toThrow('at least one event');
    await klient.close();
  });

  it('maps public names to emitter sources and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });

    klient.events.on('kosong.providers.changed', (event) => seen.push(event));
    expect(channel.subscriptions[0]?.source).toEqual({
      kind: 'emitter',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    channel.emit(0, { added: ['p1'], removed: [], changed: [] });
    channel.emit(0, { added: 'not-an-array' });
    await tick();
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });

  it('shares one bus subscription across bus-derived events and filters by type', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const archived: unknown[] = [];
    const catalog: unknown[] = [];

    const subA = klient.events.on('session.archived', (event) => archived.push(event));
    const subB = klient.events.on('kosong.changed', (event) => catalog.push(event));
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    channel.emit(0, { type: 'event.session.archived', payload: { sessionId: 's1' } });
    channel.emit(0, { type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] } });
    channel.emit(0, { type: 'unrelated.type', payload: {} });
    await tick();
    expect(archived).toEqual([{ sessionId: 's1' }]);
    expect(catalog).toEqual([{ changed: [], unchanged: [], failed: [] }]);

    subA.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    subB.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('delivers session.metaUpdated when the patch carries no lastPrompt', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
      errors.push(error);
    });

    klient.events.on('session.metaUpdated', (event) => seen.push(event));
    channel.emit(0, {
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: 'generated title',
        patch: { title: 'generated title', isCustomTitle: false },
      },
    });
    await tick();
    expect(seen).toEqual([
      {
        agentId: 'main',
        sessionId: 's1',
        title: 'generated title',
        patch: { title: 'generated title', isCustomTitle: false },
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('disposes the emitter subscription when the last listener detaches', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const a = klient.events.on('config.changed', () => undefined);
    const b = klient.events.on('config.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    a.dispose();
    expect(channel.subscriptions[0]?.dispose).not.toHaveBeenCalled();
    b.dispose();
    expect(channel.subscriptions[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards the newly registered agent stream events and validates payloads', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    const agent = klient.session('s1').agent('main');
    const seen = {
      delta: [] as unknown[],
      progress: [] as unknown[],
      started: [] as unknown[],
      blocked: [] as unknown[],
      cancelled: [] as unknown[],
      completed: [] as unknown[],
    };
    const errors: Error[] = [];
    agent.events.onError((error) => {
      errors.push(error);
    });

    agent.events.on('tool.call.delta', (event) => seen.delta.push(event));
    agent.events.on('tool.progress', (event) => seen.progress.push(event));
    agent.events.on('compaction.started', (event) => seen.started.push(event));
    agent.events.on('compaction.blocked', (event) => seen.blocked.push(event));
    agent.events.on('compaction.cancelled', (event) => seen.cancelled.push(event));
    agent.events.on('compaction.completed', (event) => seen.completed.push(event));

    // All six registrations share one `events` stream subscription bound to
    // the agent scope.
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    expect(channel.subscriptions[0]?.source).toEqual({ kind: 'stream', name: 'events' });

    const delta = { type: 'tool.call.delta', turnId: 1, toolCallId: 'tc1', name: 'Bash', argumentsPart: '{"command":' };
    const progress = {
      type: 'tool.progress',
      turnId: 1,
      toolCallId: 'tc1',
      update: { kind: 'stdout', text: 'chunk' },
    };
    const started = { type: 'compaction.started', trigger: 'auto' };
    const blocked = { type: 'compaction.blocked', turnId: 2 };
    const cancelled = { type: 'compaction.cancelled' };
    const completed = {
      type: 'compaction.completed',
      result: { summary: 's', compactedCount: 3, tokensBefore: 100, tokensAfter: 40 },
    };
    channel.emit(0, delta);
    channel.emit(0, progress);
    channel.emit(0, started);
    channel.emit(0, blocked);
    channel.emit(0, cancelled);
    channel.emit(0, completed);
    channel.emit(0, { type: 'tool.progress', turnId: 1, toolCallId: 'tc1' }); // missing update
    channel.emit(0, { type: 'unregistered.type', turnId: 1 });
    await tick();

    expect(seen.delta).toEqual([delta]);
    expect(seen.progress).toEqual([progress]);
    expect(seen.started).toEqual([started]);
    expect(seen.blocked).toEqual([blocked]);
    expect(seen.cancelled).toEqual([cancelled]);
    expect(seen.completed).toEqual([completed]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(KlientValidationError);
  });
});

describe('files routing', () => {
  const META = {
    id: 'f_1',
    name: 'a.png',
    media_type: 'image/png',
    size: 4,
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('routes the files save/get/delete lifecycle through fileService', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);

    channel.result = META;
    const meta = await klient.global.files.save({
      data: new Uint8Array([1, 2, 3, 4]),
      filename: 'a.png',
      mimeType: 'image/png',
    });
    expect(meta).toEqual(META);
    expect(channel.calls[0]).toMatchObject({
      scope: {},
      service: 'fileService',
      method: 'save',
      args: ['AQIDBA==', 'a.png', { mimeType: 'image/png' }],
    });

    channel.result = { meta: META, data: 'AQIDBA==' };
    const got = await klient.global.files.get('f_1');
    expect(got.meta).toEqual(META);
    expect([...got.data]).toEqual([1, 2, 3, 4]);
    expect(channel.calls[1]).toMatchObject({
      scope: {},
      service: 'fileService',
      method: 'get',
      args: ['f_1'],
    });

    channel.result = undefined;
    await expect(klient.global.files.delete('f_1')).resolves.toBeUndefined();
    expect(channel.calls[2]).toMatchObject({
      scope: {},
      service: 'fileService',
      method: 'delete',
      args: ['f_1'],
    });
  });

  it('files.save rejects invalid input before it hits the wire', async () => {
    const channel = new FakeChannel();
    const klient = createKlientFromChannel(channel);
    await expect(
      klient.global.files.save({ data: new Uint8Array(0), filename: '' }),
    ).rejects.toBeInstanceOf(KlientValidationError);
    expect(channel.calls).toHaveLength(0);
  });
});

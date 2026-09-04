import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionController } from '@kiki/session-core/session/sessionController';
import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import { MEDIA_STAGING_TTL_SECONDS } from '#/tui/constant/media';
import { buildLoadedTranscriptMarkdown, DaemonTUI } from '#/tui/daemon/daemon-tui';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

const created: DaemonTUI[] = [];

function driver(
  plan = false,
  sources: {
    readonly agentFiles?: readonly string[];
    readonly skillsDirs?: readonly string[];
    readonly continue?: boolean;
    readonly session?: string;
  } = {},
) {
  const tui = new DaemonTUI(
    { url: 'http://127.0.0.1:57580', token: 'secret' },
    {
      cliOptions: {
        session: sources.session,
        continue: sources.continue ?? false,
        yolo: false,
        auto: false,
        plan,
        model: 'model-a',
        thinking: 'off',
        agentFiles: sources.agentFiles ?? [],
        skillsDirs: sources.skillsDirs ?? [],
      },
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '1.0.0',
      workDir: 'C:\\repo',
    },
  );
  created.push(tui);
  const controllerState = {
    version: 0,
    sessionId: 'session-1',
    busy: false,
    blocks: [] as Array<Record<string, unknown>>,
    activePromptId: undefined as string | undefined,
    queuedPromptIds: [] as string[],
    turnTail: undefined as { turnId: string } | undefined,
    goal: null as null | { status: 'active' | 'paused' | 'blocked' | 'complete' },
  };
  const controllerListeners = new Set<() => void>();
  const controller = {
    sessionId: 'session-1',
    sendPrompt: vi.fn(async () => ({
      prompt_id: 'prompt-1',
      user_message_id: 'user-1',
      status: 'running',
      content: [{ type: 'text', text: 'prompt' }],
      created_at: '2026-01-01T00:00:00.000Z',
    })),
    abortActive: vi.fn(),
    close: vi.fn(),
    handleSessionRecord: vi.fn(),
    getForest: vi.fn(() => undefined),
    getState: vi.fn(() => controllerState),
    resync: vi.fn(),
    subscribe: vi.fn((listener: () => void) => {
      controllerListeners.add(listener);
      return () => controllerListeners.delete(listener);
    }),
  };
  const internal = tui as unknown as {
    controller: typeof controller;
    startupOverridesPending: boolean;
    sideControllers: Set<SessionController>;
    imageAttachments: ImageAttachmentStore;
    skillCommands: Map<
      string,
      { commandName: string; name: string; description: string }
    >;
    agentProfileCommands: Map<string, string>;
    client: {
      klient: Record<string, unknown>;
      listModels: ReturnType<typeof vi.fn>;
      listSessions: ReturnType<typeof vi.fn>;
      createSession: ReturnType<typeof vi.fn>;
      getGoal: ReturnType<typeof vi.fn>;
      undoSession: ReturnType<typeof vi.fn>;
      listAgentProfiles: ReturnType<typeof vi.fn>;
      listSkills: ReturnType<typeof vi.fn>;
      activateSkill: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
      setPermission: ReturnType<typeof vi.fn>;
      setProfile: ReturnType<typeof vi.fn>;
      setThinking: ReturnType<typeof vi.fn>;
      setPlanMode: ReturnType<typeof vi.fn>;
      setSwarmMode: ReturnType<typeof vi.fn>;
      setTitle: ReturnType<typeof vi.fn>;
      updateSessionProfile: ReturnType<typeof vi.fn>;
      renewServerLease: ReturnType<typeof vi.fn>;
      updateSessionSourceOverlay: ReturnType<typeof vi.fn>;
      resolveApproval: ReturnType<typeof vi.fn>;
      resolveQuestion: ReturnType<typeof vi.fn>;
      dismissQuestion: ReturnType<typeof vi.fn>;
      close(): Promise<void>;
    };
    handleInput(text: string): Promise<void>;
    handleSlash(text: string): Promise<void>;
    handleInterrupt(kind: 'ctrl-c'): Promise<void>;
    openSession(sessionId: string): Promise<void>;
    configureExplicitSources(sessionId: string): Promise<void>;
    ensureSourceOverlayLease(): Promise<string>;
    initializeSession(): Promise<void>;
    renderSession(view: unknown): void;
    settleAttachmentLeases(view: unknown): void;
    refreshAgentCommands(): Promise<void>;
    refreshSkillCommands(sessionId: string): Promise<void>;
    showSessionPicker(scope?: 'cwd' | 'all'): Promise<void>;
    respondApproval(block: unknown, response: unknown): Promise<void>;
    respondQuestion(block: unknown, response: unknown): Promise<void>;
    showStatus: ReturnType<typeof vi.fn>;
  };
  internal.controller = controller;
  const agentFacade = {
    prompt: vi.fn(),
    promptWithSkills: vi.fn(),
    steer: vi.fn(),
    compact: vi.fn(async () => true),
    getTasks: vi.fn(async () => []),
    stopTask: vi.fn(),
    getTaskOutput: vi.fn(async () => 'task output'),
    getUsage: vi.fn(async () => ({ total: {} })),
    getMcpServers: vi.fn(async () => []),
  };
  const sessionFacade = {
    agent: vi.fn(() => agentFacade),
    fork: vi.fn(async () => ({ id: 'fork-1' })),
    agents: vi.fn(async () => ({})),
  };
  const configFacade = {
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => ({})),
    replace: vi.fn(),
    replaceSections: vi.fn(),
    reload: vi.fn(),
  };
  const pluginsFacade = {
    list: vi.fn(async () => []),
    install: vi.fn(),
    setEnabled: vi.fn(),
    remove: vi.fn(),
    reload: vi.fn(),
  };
  const providerFacade = {
    listProviders: vi.fn(async () => []),
    addProvider: vi.fn(),
    removeProvider: vi.fn(),
    refreshProviders: vi.fn(),
  };
  const authFacade = {
    startLogin: vi.fn(async () => ({
      flow_id: 'flow-1',
      provider: 'example',
      status: 'authenticated',
    })),
    logout: vi.fn(async () => ({ logged_out: true, provider: 'example' })),
  };
  const filesFacade = {
    save: vi.fn(async () => ({ id: 'file-1' })),
    delete: vi.fn(),
  };
  const flagsFacade = {
    list: vi.fn(async () => [{ id: 'example-flag', enabled: true, source: 'config' }]),
  };
  const klientClose = vi.fn();
  internal.client.klient = {
    close: klientClose,
    session: vi.fn(() => sessionFacade),
    global: {
      config: configFacade,
      plugins: pluginsFacade,
      kosong: providerFacade,
      auth: authFacade,
      files: filesFacade,
      flags: flagsFacade,
    },
  };
  internal.client.listSessions = vi.fn(async () => ({ items: [], nextCursor: undefined }));
  internal.client.createSession = vi.fn(async () => ({ id: 'session-created' }));
  internal.client.getGoal = vi.fn(async () => null);
  internal.client.undoSession = vi.fn();
  internal.client.listModels = vi.fn(async () => ({
    items: [
      {
        provider: 'example',
        model: 'model-b',
        display_name: 'Model B',
        max_context_size: 128_000,
      },
    ],
  }));
  internal.client.listAgentProfiles = vi.fn(async () => ({
    items: [
      {
        name: 'reviewer',
        source: 'user',
        workspace_id: 'workspace-1',
        path: 'reviewer.md',
        description: 'Review changes',
        disabled: false,
        routes: [],
      },
    ],
  }));
  internal.client.listSkills = vi.fn(async () => ({ skills: [] }));
  internal.client.activateSkill = vi.fn();
  internal.client.setModel = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setPermission = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setProfile = vi.fn(async (_sessionId, profile) => ({
    id: 'session-1',
    agent_config: { model: 'profile-model', profile },
  }));
  internal.client.setThinking = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setPlanMode = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setSwarmMode = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setTitle = vi.fn(async (_sessionId, title) => ({ id: 'session-1', title }));
  internal.client.updateSessionProfile = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.renewServerLease = vi.fn(async () => ({
    lease_id: 'lease-1',
    expires_at: Date.now() + 60_000,
  }));
  internal.client.updateSessionSourceOverlay = vi.fn(async () => ({ profiles: 0, skills: 0 }));
  internal.client.resolveApproval = vi.fn();
  internal.client.resolveQuestion = vi.fn();
  internal.client.dismissQuestion = vi.fn();
  internal.showStatus = vi.fn();
  return {
    tui,
    internal,
    controller,
    controllerState,
    emitController: () => {
      for (const listener of controllerListeners) listener();
    },
    agentFacade,
    sessionFacade,
    configFacade,
    pluginsFacade,
    providerFacade,
    authFacade,
    filesFacade,
    klientClose,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const tui of created.splice(0)) {
    tui.state.footer.dispose();
    await (tui as unknown as { client: { close(): Promise<void> } }).client.close();
  }
});

describe('DaemonTUI commands', () => {
  it('labels loaded-view exports and omits tool, media, and other blocks', () => {
    const markdown = buildLoadedTranscriptMarkdown({
      sessionId: 'session-1',
      workDir: 'C:\\repo',
      blocks: [
        { kind: 'user', text: 'question with image', media: [{ kind: 'file', fileId: 'secret-media' }] },
        { kind: 'tool', name: 'Read', output: 'secret-tool-output' },
        { kind: 'assistant', text: 'answer' },
        { kind: 'notice', text: 'secret-notice' },
      ] as never,
      tokenCount: 10,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(markdown).toContain('# Kimi Loaded Transcript View');
    expect(markdown).toContain('Includes only loaded user and assistant text');
    expect(markdown).toContain('question with image');
    expect(markdown).toContain('answer');
    expect(markdown).not.toContain('secret-media');
    expect(markdown).not.toContain('secret-tool-output');
    expect(markdown).not.toContain('secret-notice');
  });

  it('keeps a REST-selected model for subsequent prompts', async () => {
    const { tui, internal, controller } = driver();

    await internal.handleSlash('/model model-b');
    await internal.handleInput('hello');

    expect(internal.client.setModel).toHaveBeenCalledWith('session-1', 'model-b');
    expect(tui.state.appState.model).toBe('model-b');
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', model: 'model-b' }),
    );
  });

  it('preserves plan mode in startup and prompt submissions', async () => {
    const { tui, internal, controller } = driver(true);

    await internal.handleInput('hello');

    expect(tui.state.appState.planMode).toBe(true);
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', planMode: true }),
    );
  });

  it('validates agent profiles and applies permission aliases through REST', async () => {
    const { tui, internal } = driver();

    await internal.handleSlash('/agent reviewer');
    await internal.handleSlash('/yolo');
    await internal.handleSlash('/auto');

    expect(internal.client.setProfile).toHaveBeenCalledWith('session-1', 'reviewer');
    expect(internal.client.setPermission).toHaveBeenNthCalledWith(1, 'session-1', 'yolo');
    expect(internal.client.setPermission).toHaveBeenNthCalledWith(2, 'session-1', 'auto');
    expect(tui.state.appState.agentProfile).toBe('reviewer');
    expect(tui.state.appState.permissionMode).toBe('auto');
  });

  it('applies plan, swarm, and title session actions through REST', async () => {
    const { tui, internal } = driver();

    await internal.handleSlash('/plan');
    await internal.handleSlash('/swarm');
    await internal.handleSlash('/title Release session');

    expect(internal.client.setPlanMode).toHaveBeenCalledWith('session-1', true);
    expect(internal.client.setSwarmMode).toHaveBeenCalledWith('session-1', true);
    expect(internal.client.setTitle).toHaveBeenCalledWith('session-1', 'Release session');
    expect(tui.state.appState).toMatchObject({
      planMode: true,
      swarmMode: true,
      sessionTitle: 'Release session',
    });
  });

  it('routes daemon-backed session and management commands through real facades', async () => {
    const {
      internal,
      controller,
      agentFacade,
      sessionFacade,
      configFacade,
      pluginsFacade,
      providerFacade,
      authFacade,
    } = driver();
    const openSession = vi.fn();
    internal.openSession = openSession;
    const marketplacePath = resolve(process.cwd(), '../../plugins/marketplace.json');

    await internal.handleSlash('/compact keep decisions');
    await internal.handleSlash('/tasks stop task-1');
    await internal.handleSlash('/fork Review copy');
    await internal.handleSlash(`/plugins marketplace ${marketplacePath}`);
    await internal.handleSlash('/plugins install C:\\plugins\\local');
    await internal.handleSlash('/provider add example {"type":"openai_legacy","baseUrl":"https://example.test","auth":{"method":"oauth"}}');
    await internal.handleSlash('/reload');
    await internal.handleSlash('/login example');
    await internal.handleSlash('/logout example');
    await internal.handleSlash('/mcp');
    await internal.handleSlash('/goal Ship the daemon TUI');
    await internal.handleSlash('/settings thinking {"enabled":true}');
    await internal.handleSlash('/undo');

    expect(agentFacade.compact).toHaveBeenCalledWith({ instruction: 'keep decisions' });
    expect(agentFacade.stopTask).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(sessionFacade.fork).toHaveBeenCalledWith({ title: 'Review copy' });
    expect(openSession).toHaveBeenCalledWith('fork-1');
    expect(pluginsFacade.install).toHaveBeenCalledWith('C:\\plugins\\local');
    expect(providerFacade.addProvider).toHaveBeenCalledWith(
      'example',
      expect.objectContaining({ baseUrl: 'https://example.test' }),
    );
    expect(configFacade.reload).toHaveBeenCalled();
    expect(authFacade.startLogin).toHaveBeenCalledWith('example');
    expect(authFacade.logout).toHaveBeenCalledWith('example');
    expect(agentFacade.getMcpServers).toHaveBeenCalledOnce();
    expect(internal.client.updateSessionProfile).toHaveBeenCalledWith('session-1', {
      agent_config: { goal_objective: 'Ship the daemon TUI' },
    });
    expect(configFacade.replace).toHaveBeenCalledWith({
      domain: 'thinking',
      value: { enabled: true },
    });
    expect(internal.client.undoSession).toHaveBeenCalledWith('session-1');
    expect(controller.resync).toHaveBeenCalled();
  });

  it('redacts settings output and rejects plaintext provider secrets', async () => {
    const { internal, configFacade, providerFacade } = driver();
    configFacade.getAll.mockResolvedValue({
      provider: {
        apiKey: 'settings-secret',
        headers: { Authorization: 'Bearer settings-token' },
      },
      nested: { enabled: true },
    });

    await internal.handleSlash('/settings');
    const rendered = String(internal.showStatus.mock.calls.at(-1)?.[0]);
    expect(rendered).not.toContain('settings-secret');
    expect(rendered).not.toContain('settings-token');
    expect(rendered).toContain('[redacted]');
    await expect(
      internal.handleSlash('/settings provider {"apiKey":"plaintext"}'),
    ).rejects.toThrow('sensitive field');
    expect(configFacade.replace).not.toHaveBeenCalled();

    await expect(
      internal.handleSlash('/provider add unsafe {"type":"openai_legacy","auth":{"method":"api-key","apiKey":"plaintext"}}'),
    ).rejects.toThrow('environment reference');
    expect(providerFacade.addProvider).not.toHaveBeenCalled();
  });

  it('resolves provider API keys only from environment references', async () => {
    const { internal, providerFacade } = driver();
    vi.stubEnv('DAEMON_TUI_PROVIDER_KEY', 'resolved-secret');

    await internal.handleSlash('/provider add safe {"type":"openai_legacy","auth":{"method":"api-key","apiKey":"$DAEMON_TUI_PROVIDER_KEY"}}');

    expect(providerFacade.addProvider).toHaveBeenCalledWith('safe', {
      type: 'openai_legacy',
      auth: { method: 'api-key', apiKey: 'resolved-secret' },
    });
  });

  it('replaces an existing goal through cancel then create profile updates', async () => {
    const { internal, controller } = driver();
    internal.client.getGoal.mockResolvedValue({ status: 'active' });

    await internal.handleSlash('/goal replace Finish the release');

    expect(internal.client.getGoal).toHaveBeenCalledWith('session-1');
    expect(internal.client.updateSessionProfile.mock.calls).toEqual([
      ['session-1', { agent_config: { goal_control: 'cancel' } }],
      ['session-1', { agent_config: { goal_objective: 'Finish the release' } }],
    ]);
    expect(controller.handleSessionRecord).toHaveBeenCalledTimes(2);
    expect(controller.resync).toHaveBeenCalledTimes(2);
  });

  it('creates a replacement goal without cancelling when no goal exists', async () => {
    const { internal } = driver();

    await internal.handleSlash('/goal replace Finish the release');

    expect(internal.client.updateSessionProfile.mock.calls).toEqual([
      ['session-1', { agent_config: { goal_objective: 'Finish the release' } }],
    ]);
  });

  it.each([undefined, null])('closes a side session when /btw returns %s', async (result) => {
    const { internal, agentFacade } = driver();
    agentFacade.prompt.mockResolvedValue(result as never);
    const open = vi.spyOn(SessionController.prototype, 'open').mockResolvedValue(undefined);

    try {
      await internal.handleSlash('/btw check this');
    } finally {
      open.mockRestore();
    }

    expect(internal.showStatus).toHaveBeenCalledWith('Side session fork-1 did not start.', 'error');
    expect(internal.sideControllers).toHaveLength(0);
  });

  it('steers ordinary input into an active goal', async () => {
    const { internal, controller, controllerState, agentFacade } = driver();
    controllerState.goal = { status: 'active' };

    await internal.handleInput('Use the focused regression test');

    expect(agentFacade.steer).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'Use the focused regression test' }],
    });
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(controller.resync).toHaveBeenCalledOnce();
  });

  it('keeps active-goal media until the steered turn settles', async () => {
    const { internal, controllerState, agentFacade, filesFacade } = driver();
    controllerState.goal = { status: 'active' };
    agentFacade.steer.mockResolvedValue({ turn_id: 42 });
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'steer-image-upload',
    );

    await internal.handleInput(`steer ${image.placeholder}`);
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.turnTail = { turnId: '42' };
    internal.settleAttachmentLeases(controllerState);
    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('steer-image-upload');
    });
  });

  it.each([undefined, null])(
    'retains steered media to bounded expiry when the launch result is %s',
    async (result) => {
      const { internal, controller, controllerState, agentFacade, filesFacade } = driver();
      controllerState.goal = { status: 'active' };
      agentFacade.steer.mockResolvedValue(result as never);
      const image = internal.imageAttachments.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        1,
        1,
        undefined,
        'unidentified-steer-upload',
      );

      await internal.handleInput(`steer ${image.placeholder}`);

      expect(controller.resync).toHaveBeenCalledOnce();
      expect(internal.imageAttachments.get(image.id)).toBeUndefined();
      expect(filesFacade.delete).not.toHaveBeenCalledWith('unidentified-steer-upload');
    },
  );

  it('uploads local files and sends real file content parts', async () => {
    const { tui, internal, controller, filesFacade } = driver();
    const path = resolve(process.cwd(), 'package.json');

    await internal.handleSlash(`/attach ${path}`);
    const draft = tui.state.editor.getText();
    await internal.handleInput(`inspect ${draft}`);

    expect(filesFacade.save).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'package.json',
        mimeType: 'application/json',
        expiresInSec: MEDIA_STAGING_TTL_SECONDS,
      }),
    );
    expect(draft).toContain('[file #1 package.json]');
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'file', file_id: 'file-1', name: 'package.json' }),
        ]),
      }),
    );
    expect(filesFacade.delete).toHaveBeenCalledWith('file-1');
  });

  it('keeps uploaded media until the accepted prompt settles', async () => {
    const { internal, controller, controllerState, filesFacade } = driver();
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'image-upload-1',
    );
    controller.sendPrompt.mockImplementation(async () => {
      controllerState.activePromptId = 'prompt-image';
      controllerState.blocks = [{
        kind: 'user',
        promptId: 'prompt-image',
        promptStatus: 'running',
      }];
      return {
        prompt_id: 'prompt-image',
        user_message_id: 'user-image',
        status: 'running',
        content: [{ type: 'text', text: 'inspect image' }],
        created_at: '2026-01-01T00:00:00.000Z',
      };
    });

    await internal.handleInput(`inspect ${image.placeholder}`);
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.version += 1;
    controllerState.activePromptId = undefined;
    controllerState.blocks = [{ kind: 'user', promptId: 'prompt-image' }];
    internal.settleAttachmentLeases(controllerState);

    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('image-upload-1');
    });
  });

  it('keeps tracking media settlement after switching sessions', async () => {
    const { internal, controller, controllerState, emitController, filesFacade } = driver();
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'switched-image-upload',
    );
    controller.sendPrompt.mockImplementation(async () => {
      controllerState.activePromptId = 'switched-image-prompt';
      return {
        prompt_id: 'switched-image-prompt',
        user_message_id: 'switched-image-user',
        status: 'running',
        content: [{ type: 'text', text: 'inspect image' }],
        created_at: '2026-01-01T00:00:00.000Z',
      };
    });

    await internal.handleInput(`inspect ${image.placeholder}`);
    internal.startupOverridesPending = false;
    await internal.openSession('session-2');
    expect(controller.close).not.toHaveBeenCalled();

    controllerState.version += 1;
    controllerState.activePromptId = undefined;
    emitController();

    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('switched-image-upload');
    });
    expect(controller.close).toHaveBeenCalledOnce();
  });

  it('does not delete media handed to an active prompt when the TUI closes', async () => {
    const { tui, internal, controller, controllerState, filesFacade } = driver();
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'active-image-upload',
    );
    controller.sendPrompt.mockImplementation(async () => {
      controllerState.activePromptId = 'active-image-prompt';
      controllerState.blocks = [{
        kind: 'user',
        promptId: 'active-image-prompt',
        promptStatus: 'running',
      }];
      return {
        prompt_id: 'active-image-prompt',
        user_message_id: 'active-image-user',
        status: 'running',
        content: [{ type: 'text', text: 'inspect image' }],
        created_at: '2026-01-01T00:00:00.000Z',
      };
    });

    await internal.handleInput(`inspect ${image.placeholder}`);
    await tui.close();

    expect(filesFacade.delete).not.toHaveBeenCalledWith('active-image-upload');
  });

  it('retains staged attachments after a failed send so the draft can retry', async () => {
    const { tui, internal, controller, filesFacade } = driver();
    const path = resolve(process.cwd(), 'package.json');
    controller.sendPrompt.mockRejectedValue(new Error('send failed'));

    await internal.handleSlash(`/attach ${path}`);
    const draft = tui.state.editor.getText();
    await expect(internal.handleInput(`inspect ${draft}`)).rejects.toThrow('send failed');

    expect(filesFacade.delete).not.toHaveBeenCalled();
  });

  it('aborts an active prompt instead of exiting on Ctrl-C', async () => {
    const { internal, controller, controllerState } = driver();
    controllerState.busy = true;

    await internal.handleInterrupt('ctrl-c');

    expect(controller.abortActive).toHaveBeenCalledOnce();
  });

  it('always stops the UI when daemon close fails', async () => {
    const { tui, klientClose } = driver();
    klientClose.mockRejectedValue(new Error('close failed'));
    const stop = vi.spyOn(tui.state.ui, 'stop');

    await expect(tui.close()).rejects.toThrow('close failed');
    klientClose.mockResolvedValue(undefined);

    expect(stop).toHaveBeenCalledOnce();
  });

  it('projects retry, todo, task, and context state into TUI chrome', () => {
    const { tui, internal } = driver();
    internal.renderSession({
      sessionId: 'session-1',
      session: undefined,
      blocks: [],
      model: 'model-a',
      profile: undefined,
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
      thinkingEffort: 'off',
      contextTokens: 10,
      maxContextTokens: 100,
      busy: true,
      turnRetry: { failedAttempt: 1, maxAttempts: 3, delayMs: 500 },
      todos: Array.from({ length: 6 }, (_, index) => ({
        title: `Todo ${String(index)}`,
        status: index === 0 ? 'in_progress' : 'pending',
      })),
      tasks: [
        { kind: 'bash', status: 'running' },
        { kind: 'subagent', status: 'running' },
      ],
      resyncing: false,
      resyncFailed: false,
      resyncAttempt: 0,
      goal: null,
    });

    expect(tui.state.appState.contextUsage).toBe(0.1);
    expect(tui.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, delayMs: 500 });
    expect(tui.state.todoPanel.hasOverflow()).toBe(true);
    expect(tui.state.editor.onToggleTodoExpand?.()).toBe(true);
    expect(internal.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Retrying attempt'),
      'normal',
    );
    expect(tui.state.footer.render(120).join('\n')).toContain('task');
  });

  it('binds image paste, todo expansion, undo, and built-in history callbacks', () => {
    const { tui } = driver();

    expect(tui.state.editor.onPasteImage).toBeTypeOf('function');
    expect(tui.state.editor.onToggleTodoExpand).toBeTypeOf('function');
    expect(tui.state.editor.onUndo).toBeTypeOf('function');
    expect(tui.state.editor.onRecall).toBeTypeOf('function');
    expect(tui.state.editor.onTextPaste).toBeTypeOf('function');
  });

  it('normalizes aliases, runs experiments, and rejects unknown slash input', async () => {
    const { tui, internal, controller, configFacade } = driver();

    await internal.handleSlash('/thinking high');
    await internal.handleSlash('/h');
    await internal.handleSlash('/config');
    await internal.handleSlash('/experimental');
    await internal.handleSlash('/custom value');

    expect(internal.client.setThinking).toHaveBeenCalledWith('session-1', 'high');
    expect(tui.state.appState.thinkingEffort).toBe('high');
    expect(internal.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Supported:'),
    );
    expect(configFacade.getAll).toHaveBeenCalledOnce();
    expect(internal.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('example-flag'),
    );
    expect(internal.showStatus).toHaveBeenCalledWith(
      'Unknown daemon TUI command: /custom',
      'error',
    );
    expect(controller.sendPrompt).not.toHaveBeenCalled();
  });

  it('matches mixed-case catalog slashes without collapsing argument whitespace', async () => {
    const { internal, controller } = driver();
    internal.client.listSkills.mockResolvedValue({
      skills: [
        {
          name: 'ReviewSkill',
          description: 'Review changes',
          source: 'user',
        },
      ],
    });
    internal.client.listAgentProfiles.mockResolvedValue({
      items: [
        {
          name: 'Reviewer',
          source: 'user',
          workspace_id: 'workspace-1',
          path: 'reviewer.md',
          description: 'Review changes',
          disabled: false,
          routes: [],
        },
      ],
    });
    await internal.refreshSkillCommands('session-1');
    await internal.refreshAgentCommands();

    expect(internal.skillCommands.get('skill:reviewskill')).toMatchObject({
      commandName: 'skill:ReviewSkill',
      name: 'ReviewSkill',
    });
    expect(internal.agentProfileCommands.get('reviewer')).toBe('Reviewer');

    await internal.handleSlash('/skill:ReviewSkill   staged  \t changes   ');
    await internal.handleSlash('/REVIEWER   inspect  \t tests   ');

    expect(internal.client.activateSkill).toHaveBeenCalledWith(
      'session-1',
      'ReviewSkill',
      'staged  \t changes',
    );
    expect(controller.sendPrompt).toHaveBeenCalledWith({
      text: 'inspect  \t tests',
      profile: 'Reviewer',
      model: undefined,
      thinking: undefined,
      permissionMode: 'manual',
      planMode: false,
      swarmMode: false,
    });
  });

  it('submits inline skills through the bundled prompt contract', async () => {
    const { internal, controller, agentFacade } = driver();
    internal.skillCommands.set('skill:reviewskill', {
      commandName: 'skill:ReviewSkill',
      name: 'ReviewSkill',
      description: 'Review changes',
    });

    await internal.handleInput('Please /skill:ReviewSkill inspect this change');

    expect(agentFacade.promptWithSkills).toHaveBeenCalledWith({
      input: [{ type: 'text', text: 'Please /skill:ReviewSkill inspect this change' }],
      skills: [{ name: 'ReviewSkill' }],
    });
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(controller.resync).toHaveBeenCalledOnce();
  });

  it('treats queued inline-skill results as observed until a later snapshot settles', async () => {
    const { internal, controllerState, agentFacade, filesFacade } = driver();
    internal.skillCommands.set('skill:reviewskill', {
      commandName: 'skill:ReviewSkill',
      name: 'ReviewSkill',
      description: 'Review changes',
    });
    agentFacade.promptWithSkills.mockResolvedValue({
      prompt_id: 'skill-prompt',
      created_at: '2026-01-01T00:00:00.000Z',
      state: 'queued',
    });
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'skill-image-upload',
    );

    await internal.handleInput(`Please /skill:ReviewSkill inspect ${image.placeholder}`);
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.version += 1;
    internal.settleAttachmentLeases(controllerState);
    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('skill-image-upload');
    });
  });

  it('registers and releases explicit sources as a client-owned session overlay', async () => {
    const { tui, internal } = driver(false, {
      skillsDirs: ['skills'],
      agentFiles: ['reviewer.md'],
    });

    await internal.configureExplicitSources('session-created');
    await tui.close();

    expect(internal.client.renewServerLease).toHaveBeenCalledWith(undefined);
    expect(internal.client.updateSessionSourceOverlay.mock.calls).toEqual([
      [
        'session-created',
        {
          lease_id: 'lease-1',
          agent_files: ['reviewer.md'],
          skill_dirs: ['skills'],
        },
      ],
      [
        'session-created',
        {
          lease_id: 'lease-1',
          agent_files: [],
          skill_dirs: [],
        },
      ],
    ]);
  });

  it('keeps a failed source release attached so close retries it', async () => {
    const { tui, internal } = driver(false, { skillsDirs: ['skills'] });
    internal.client.updateSessionSourceOverlay
      .mockResolvedValueOnce({ profiles: 0, skills: 1 })
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce({ profiles: 0, skills: 0 });

    await internal.configureExplicitSources('session-one');
    await expect(internal.configureExplicitSources('session-two')).rejects.toThrow('release failed');
    await tui.close();

    expect(internal.client.updateSessionSourceOverlay.mock.calls.slice(1)).toEqual([
      ['session-one', { lease_id: 'lease-1', agent_files: [], skill_dirs: [] }],
      ['session-one', { lease_id: 'lease-1', agent_files: [], skill_dirs: [] }],
    ]);
  });

  it('reattaches explicit sources when an expired lease is replaced', async () => {
    const { internal } = driver(false, {
      skillsDirs: ['skills'],
      agentFiles: ['reviewer.md'],
    });
    await internal.configureExplicitSources('session-one');
    internal.client.renewServerLease.mockResolvedValueOnce({
      lease_id: 'lease-2',
      expires_at: Date.now() + 60_000,
    });

    await internal.ensureSourceOverlayLease();

    expect(internal.client.updateSessionSourceOverlay).toHaveBeenLastCalledWith('session-one', {
      lease_id: 'lease-2',
      agent_files: ['reviewer.md'],
      skill_dirs: ['skills'],
    });
  });

  it('retries a failed reattach against the same replacement lease', async () => {
    const { internal } = driver(false, {
      skillsDirs: ['skills'],
      agentFiles: ['reviewer.md'],
    });
    await internal.configureExplicitSources('session-one');
    internal.client.renewServerLease
      .mockResolvedValueOnce({ lease_id: 'lease-2', expires_at: Date.now() + 60_000 })
      .mockResolvedValueOnce({ lease_id: 'lease-2', expires_at: Date.now() + 60_000 });
    internal.client.updateSessionSourceOverlay
      .mockRejectedValueOnce(new Error('reattach failed'))
      .mockResolvedValueOnce({ profiles: 1, skills: 1 });

    await expect(internal.ensureSourceOverlayLease()).rejects.toThrow('reattach failed');
    await internal.ensureSourceOverlayLease();

    expect(internal.client.renewServerLease.mock.calls.slice(-2)).toEqual([
      ['lease-1'],
      ['lease-2'],
    ]);
    expect(internal.client.updateSessionSourceOverlay).toHaveBeenLastCalledWith('session-one', {
      lease_id: 'lease-2',
      agent_files: ['reviewer.md'],
      skill_dirs: ['skills'],
    });
  });

  it('pages continue lookup until the current workspace is found', async () => {
    const { internal } = driver(false, { continue: true });
    const openSession = vi.fn();
    internal.openSession = openSession;
    internal.client.listSessions
      .mockResolvedValueOnce({
        items: [{ id: 'other', cwd: 'C:\\other' }],
        nextCursor: 'other',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'match', cwd: 'C:\\repo' }],
        nextCursor: undefined,
      });

    await internal.initializeSession();

    expect(internal.client.listSessions).toHaveBeenNthCalledWith(1, 50, undefined);
    expect(internal.client.listSessions).toHaveBeenNthCalledWith(2, 50, 'other');
    expect(openSession).toHaveBeenCalledWith('match');
    expect(internal.client.createSession).not.toHaveBeenCalled();
  });

  it('automatically pages the cwd session picker until a matching row is found', async () => {
    const { internal } = driver();
    internal.client.listSessions
      .mockResolvedValueOnce({
        items: [{ id: 'other', cwd: 'C:\\other' }],
        nextCursor: 'other',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'match', cwd: 'C:\\repo' }],
        nextCursor: undefined,
      });

    await internal.showSessionPicker('cwd');

    expect(internal.client.listSessions).toHaveBeenNthCalledWith(1, 50);
    expect(internal.client.listSessions).toHaveBeenNthCalledWith(2, 50, 'other');
  });

  it('keeps interaction response failures inside the TUI', async () => {
    const { internal, controller } = driver();
    const approval = {
      kind: 'approval',
      id: 'approval-1',
      request: {
        approval_id: 'approval-1',
        session_id: 'session-1',
        tool_call_id: 'tool-1',
        tool_name: 'Bash',
        action: 'run command',
        tool_input_display: { kind: 'generic' },
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2026-01-01T00:01:00.000Z',
      },
      resolution: undefined,
    };
    const question = {
      kind: 'question',
      id: 'question-1',
      request: {
        question_id: 'question-1',
        session_id: 'session-1',
        questions: [
          {
            id: 'q1',
            question: 'Choose?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      outcome: undefined,
    };
    internal.client.resolveApproval
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(
        new ApiError({
          code: API_CODES.APPROVAL_ALREADY_RESOLVED,
          msg: 'already resolved',
          data: null,
        }),
      );
    internal.client.resolveQuestion.mockRejectedValueOnce(
      new ApiError({
        code: API_CODES.QUESTION_EXPIRED,
        msg: 'expired',
        data: null,
      }),
    );
    controller.resync.mockRejectedValueOnce(new Error('resync offline')).mockResolvedValueOnce(undefined);

    await expect(
      internal.respondApproval(approval, { response: 'approved' }),
    ).resolves.toBeUndefined();
    await expect(
      internal.respondApproval(approval, { response: 'approved' }),
    ).resolves.toBeUndefined();
    await expect(
      internal.respondQuestion(question, { answers: ['A'], method: 'enter' }),
    ).resolves.toBeUndefined();

    expect(internal.showStatus).toHaveBeenCalledWith('offline', 'error');
    expect(internal.showStatus).toHaveBeenCalledWith('resync offline', 'error');
    expect(controller.resync).toHaveBeenCalledTimes(2);
  });
});

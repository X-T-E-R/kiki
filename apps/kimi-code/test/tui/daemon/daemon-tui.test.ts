import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import { DaemonTUI } from '#/tui/daemon/daemon-tui';

const created: DaemonTUI[] = [];

function driver(plan = false) {
  const tui = new DaemonTUI(
    { url: 'http://127.0.0.1:57580', token: 'secret' },
    {
      cliOptions: {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan,
        model: 'model-a',
        thinking: 'off',
        agentFiles: [],
      },
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '1.0.0',
      workDir: 'C:\\repo',
    },
  );
  created.push(tui);
  const controllerState = { busy: false, blocks: [], activePromptId: undefined };
  const controller = {
    sessionId: 'session-1',
    sendPrompt: vi.fn(),
    abortActive: vi.fn(),
    handleSessionRecord: vi.fn(),
    getForest: vi.fn(() => undefined),
    getState: vi.fn(() => controllerState),
    resync: vi.fn(),
  };
  const internal = tui as unknown as {
    controller: typeof controller;
    skillCommands: Map<
      string,
      { commandName: string; name: string; description: string }
    >;
    agentProfileCommands: Map<string, string>;
    client: {
      listModels: ReturnType<typeof vi.fn>;
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
      resolveApproval: ReturnType<typeof vi.fn>;
      resolveQuestion: ReturnType<typeof vi.fn>;
      dismissQuestion: ReturnType<typeof vi.fn>;
      close(): Promise<void>;
    };
    handleInput(text: string): Promise<void>;
    handleSlash(text: string): Promise<void>;
    handleInterrupt(kind: 'ctrl-c'): Promise<void>;
    refreshAgentCommands(): Promise<void>;
    refreshSkillCommands(sessionId: string): Promise<void>;
    respondApproval(block: unknown, response: unknown): Promise<void>;
    respondQuestion(block: unknown, response: unknown): Promise<void>;
    showStatus: ReturnType<typeof vi.fn>;
  };
  internal.controller = controller;
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
  internal.client.resolveApproval = vi.fn();
  internal.client.resolveQuestion = vi.fn();
  internal.client.dismissQuestion = vi.fn();
  internal.showStatus = vi.fn();
  return { tui, internal, controller, controllerState };
}

afterEach(async () => {
  for (const tui of created.splice(0)) {
    tui.state.footer.dispose();
    await (tui as unknown as { client: { close(): Promise<void> } }).client.close();
  }
});

describe('DaemonTUI commands', () => {
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

  it('aborts an active prompt instead of exiting on Ctrl-C', async () => {
    const { internal, controller, controllerState } = driver();
    controllerState.busy = true;

    await internal.handleInterrupt('ctrl-c');

    expect(controller.abortActive).toHaveBeenCalledOnce();
  });

  it('normalizes aliases, reports disabled commands, and rejects unknown slash input', async () => {
    const { tui, internal, controller } = driver();

    await internal.handleSlash('/thinking high');
    await internal.handleSlash('/h');
    await internal.handleSlash('/config');
    await internal.handleSlash('/custom value');

    expect(internal.client.setThinking).toHaveBeenCalledWith('session-1', 'high');
    expect(tui.state.appState.thinkingEffort).toBe('high');
    expect(internal.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Supported:'),
    );
    expect(internal.showStatus).toHaveBeenCalledWith(
      'Command is disabled in daemon TUI: /settings',
      'error',
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

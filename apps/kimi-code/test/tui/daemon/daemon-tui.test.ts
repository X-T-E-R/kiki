import { afterEach, describe, expect, it, vi } from 'vitest';

import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import { DaemonTUI } from '#/tui/daemon/daemon-tui';

const created: DaemonTUI[] = [];

function driver() {
  const tui = new DaemonTUI(
    { url: 'http://127.0.0.1:57580', token: 'secret' },
    {
      cliOptions: {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
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
  const controller = {
    sessionId: 'session-1',
    sendPrompt: vi.fn(),
    handleSessionRecord: vi.fn(),
    getForest: vi.fn(() => undefined),
    resync: vi.fn(),
  };
  const internal = tui as unknown as {
    controller: typeof controller;
    client: {
      listModels: ReturnType<typeof vi.fn>;
      listAgentProfiles: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
      setPermission: ReturnType<typeof vi.fn>;
      setProfile: ReturnType<typeof vi.fn>;
      resolveApproval: ReturnType<typeof vi.fn>;
      resolveQuestion: ReturnType<typeof vi.fn>;
      dismissQuestion: ReturnType<typeof vi.fn>;
      close(): Promise<void>;
    };
    handleInput(text: string): Promise<void>;
    handleSlash(text: string): Promise<void>;
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
  internal.client.setModel = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setPermission = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.setProfile = vi.fn(async () => ({ id: 'session-1' }));
  internal.client.resolveApproval = vi.fn();
  internal.client.resolveQuestion = vi.fn();
  internal.client.dismissQuestion = vi.fn();
  internal.showStatus = vi.fn();
  return { tui, internal, controller };
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

  it('labels known unavailable commands and preserves unknown slash input as a prompt', async () => {
    const { internal, controller } = driver();

    await internal.handleSlash('/help');
    await internal.handleSlash('/custom value');

    expect(internal.showStatus).toHaveBeenCalledWith(
      'Command is unavailable in daemon mode: /help',
      'error',
    );
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/custom value' }),
    );
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
    internal.client.resolveApproval.mockRejectedValueOnce(new Error('offline'));
    internal.client.resolveQuestion.mockRejectedValueOnce(
      new ApiError({
        code: API_CODES.QUESTION_EXPIRED,
        msg: 'expired',
        data: null,
      }),
    );

    await expect(
      internal.respondApproval(approval, { response: 'approved' }),
    ).resolves.toBeUndefined();
    await expect(
      internal.respondQuestion(question, { answers: ['A'], method: 'enter' }),
    ).resolves.toBeUndefined();

    expect(internal.showStatus).toHaveBeenCalledWith('offline', 'error');
    expect(controller.resync).toHaveBeenCalledTimes(1);
  });
});

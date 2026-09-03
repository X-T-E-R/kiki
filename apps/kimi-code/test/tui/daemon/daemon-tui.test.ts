import { afterEach, describe, expect, it, vi } from 'vitest';

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
  };
  const internal = tui as unknown as {
    controller: typeof controller;
    client: {
      listModels: ReturnType<typeof vi.fn>;
      listAgentProfiles: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
      setPermission: ReturnType<typeof vi.fn>;
      setProfile: ReturnType<typeof vi.fn>;
      close(): Promise<void>;
    };
    handleInput(text: string): Promise<void>;
    handleSlash(text: string): Promise<void>;
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
});

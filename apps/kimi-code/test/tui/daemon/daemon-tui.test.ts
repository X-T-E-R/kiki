import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from '@kiki/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageContent, Session, SessionSnapshotResponse } from '@kiki/protocol';
import type { SessionViewFacade, SessionViewSignal } from '@kiki/klient/session-view';
import type { TranscriptOpsCatchupResponse, TranscriptResponse } from '@kiki/transcript';
import { SendNowError, SessionController } from '@kiki/session-core/session/sessionController';
import { API_CODES, ApiError } from '@kiki/session-core/transport';

import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import {
  MEDIA_FILE_REF_MIN_REMAINING_MS,
  MEDIA_STAGING_TTL_SECONDS,
} from '#/tui/constant/media';
import type { DaemonFileAttachment } from '#/tui/daemon/attachments';
import type { ShowStatusOptions } from '#/tui/daemon/activity-status-helper';
import { buildLoadedTranscriptMarkdown, DaemonTUI } from '#/tui/daemon/daemon-tui';
import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import * as clipboardImage from '#/utils/clipboard/clipboard-image';

const created: DaemonTUI[] = [];
const temporaryHomes: string[] = [];

function plainText(text: string): string {
  return text.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Plain text of the transcript, where command read-outs land. */
function transcriptText(tui: DaemonTUI, width = 120): string {
  return plainText(tui.state.transcriptContainer.render(width).join('\n'));
}

function freshUploadExpiry(): number {
  return Date.now() + MEDIA_STAGING_TTL_SECONDS * 1_000;
}

function uploadMeta(id: string, expiresAt: number): { id: string; expires_at: string } {
  return { id, expires_at: new Date(expiresAt).toISOString() };
}

function sessionSnapshot(sessionId: string, model: string | null = 'model-a'): SessionSnapshotResponse {
  const session = {
    id: sessionId,
    workspace_id: 'wd_fixture_000000000000',
    title: 'Fixture session',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    busy: false,
    main_turn_active: false,
    metadata: { cwd: 'C:\\repo' },
    agent_config: { model: model === null ? '' : model },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  } satisfies Session;
  return {
    as_of_seq: 0,
    epoch: 'epoch-1',
    session,
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
    subagents: [],
  };
}

function transcriptPage(sessionId: string): TranscriptResponse {
  return {
    session_id: sessionId,
    agent_id: 'main',
    items: [],
    has_more: false,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    agents: [],
    pending_interactions: [],
    coverage: { kind: 'full', hasMoreOlder: false },
  };
}

function transcriptCatchup(sessionId: string): TranscriptOpsCatchupResponse {
  return {
    session_id: sessionId,
    agent_id: 'main',
    epoch: 'epoch-1',
    batches: [],
    through_seq: 0,
    complete: true,
  };
}

function sessionView(sessionId: string, model: string | null = 'model-a'): SessionViewFacade {
  return {
    snapshot: vi.fn(async () => sessionSnapshot(sessionId, model)),
    transcript: {
      page: vi.fn(async () => transcriptPage(sessionId)),
      catchUp: vi.fn(async () => transcriptCatchup(sessionId)),
    },
    subscribe: (_input, onSignal) => {
      let closed = false;
      const ready: SessionViewSignal = {
        type: 'ready',
        generation: 0,
        currentSessionCursor: { seq: 0, epoch: 'epoch-1' },
        reconnected: false,
      };
      queueMicrotask(() => {
        if (closed) return;
        onSignal(ready);
      });
      return {
        updateSessionCursor: vi.fn(),
        setTranscriptGrades: vi.fn(),
        updateTranscriptCursor: vi.fn(),
        restart: vi.fn(),
        nudge: vi.fn(),
        close: vi.fn(() => { closed = true; }),
      };
    },
  };
}

function driver(
  plan = false,
  sources: {
    readonly agentFiles?: readonly string[];
    readonly skillsDirs?: readonly string[];
    readonly continue?: boolean;
    readonly session?: string;
    readonly model?: string | null;
  } = {},
) {
  // Submitting through the editor persists input history under KIKI_HOME;
  // keep it out of the real home directory.
  const sessionModel = sources.model === null ? null : 'model-a';
  const home = mkdtempSync(join(tmpdir(), 'kiki-tui-home-'));
  temporaryHomes.push(home);
  vi.stubEnv('KIKI_HOME', home);
  const tui = new DaemonTUI(
    { url: 'http://127.0.0.1:57580', token: 'secret' },
    {
      cliOptions: {
        session: sources.session,
        continue: sources.continue ?? false,
        yolo: false,
        auto: false,
        plan,
        model: sources.model === null ? undefined : sources.model ?? 'model-a',
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
    resyncing: false,
    resyncFailed: false,
    blocks: [] as Array<Record<string, unknown>>,
    durableIngress: [] as Array<Record<string, unknown>>,
    todos: [] as Array<{ title: string; status: string }>,
    activePromptId: undefined as string | undefined,
    queuedPromptIds: [] as string[],
    turnStartedAt: undefined as number | undefined,
    tasks: [] as Array<{ kind: string; status: string }>,
    turnRetry: undefined as { failedAttempt: number; maxAttempts: number; delayMs: number } | undefined,
    resyncAttempt: 0,
    turnTail: undefined as { turnId: string } | undefined,
    goal: null as null | { status: 'active' | 'paused' | 'blocked' | 'complete' },
  };
  const controllerListeners = new Set<() => void>();
  const queuedPromptContents = new Map<string, readonly MessageContent[]>();
  const controller = {
    sessionId: 'session-1' as string,
    sendPrompt: vi.fn(async () => ({
      prompt_id: 'prompt-1',
      user_message_id: 'user-1',
      status: 'running',
      content: [{ type: 'text', text: 'prompt' }],
      created_at: '2026-01-01T00:00:00.000Z',
    })),
    sendPromptNow: vi.fn<SessionController['sendPromptNow']>(async (input) => {
      input.onAcknowledged?.();
      return { promptId: input.promptId!, outcome: 'accepted' };
    }),
    steerQueued: vi.fn<SessionController['steerQueued']>().mockResolvedValue({ outcome: 'accepted' }),
    getPendingSteers: vi.fn<SessionController['getPendingSteers']>().mockReturnValue([]),
    abortActive: vi.fn(),
    abortPrompt: vi.fn(async (promptId: string) => {
      controllerState.queuedPromptIds = controllerState.queuedPromptIds.filter((id) => id !== promptId);
      controllerState.blocks = controllerState.blocks.filter(
        (block) => !(block['kind'] === 'user' && block['promptId'] === promptId),
      );
      return true;
    }),
    readQueuedPromptContent: vi.fn(async (promptId: string) => queuedPromptContents.get(promptId)),
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
    fileAttachments: Map<number, DaemonFileAttachment>;
    attachmentSettlementLeases: Map<string, { deadlineAt: number }>;
    invalidUploadCleanups: Map<string, unknown>;
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
      listPersonas: ReturnType<typeof vi.fn>;
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
      setTitle: ReturnType<typeof vi.fn>;
      updateSessionProfile: ReturnType<typeof vi.fn>;
      abortPrompt: ReturnType<typeof vi.fn>;
      renewServerLease: ReturnType<typeof vi.fn>;
      updateSessionSourceOverlay: ReturnType<typeof vi.fn>;
      resolveApproval: ReturnType<typeof vi.fn>;
      resolveQuestion: ReturnType<typeof vi.fn>;
      dismissQuestion: ReturnType<typeof vi.fn>;
      close(): Promise<void>;
    };
    handleInput(text: string): Promise<void>;
    clearAttachments(): Promise<void>;
    handleClipboardPaste(): Promise<boolean>;
    ownInvalidUpload(fileId: string): Promise<void>;
    handleSlash(text: string): Promise<void>;
    handleInterrupt(kind: 'ctrl-c'): Promise<void>;
    openSession(sessionId: string): Promise<void>;
    configureExplicitSources(sessionId: string): Promise<void>;
    ensureSourceOverlayLease(): Promise<string>;
    initializeSession(): Promise<void>;
    refreshModels(): Promise<unknown>;
    renderSession(view: unknown): void;
    renderTranscript(view: unknown): void;
    renderActivityState(view: unknown): void;
    clearActivityTickTimer(): void;
    clearStatusNotice(): void;
    activityTickTimer: ReturnType<typeof setInterval> | undefined;
    activeStatusNotice: unknown;
    sourceOverlayErrorActive: boolean;
    settleAttachmentLeases(view: unknown): void;
    refreshAgentCommands(): Promise<void>;
    refreshSkillCommands(sessionId: string): Promise<void>;
    showSessionPicker(scope?: 'cwd' | 'all'): Promise<void>;
    respondApproval(block: unknown, response: unknown): Promise<void>;
    respondQuestion(block: unknown, response: unknown): Promise<void>;
    showStatus: ReturnType<typeof vi.fn<(message: string, options?: 'normal' | 'error' | ShowStatusOptions) => void>>;
  };
  internal.controller = controller;
  const addImage = internal.imageAttachments.addImage.bind(internal.imageAttachments);
  vi.spyOn(internal.imageAttachments, 'addImage').mockImplementation(
    (bytes, mime, width, height, original, fileId, fileExpiresAt) =>
      addImage(
        bytes,
        mime,
        width,
        height,
        original,
        fileId,
        fileExpiresAt ?? (fileId === undefined ? undefined : freshUploadExpiry()),
      ),
  );
  const agentFacade = {
    prompt: vi.fn(),
    promptWithSkills: vi.fn(),
    steer: vi.fn(),
    compact: vi.fn(async () => true),
    getTasks: vi.fn<import('@kiki/klient').AgentHandle['getTasks']>().mockResolvedValue([]),
    detachTask: vi.fn<import('@kiki/klient').AgentHandle['detachTask']>(),
    stopTask: vi.fn(),
    getTaskOutput: vi.fn(async () => 'task output'),
    getUsage: vi.fn(async () => ({ total: {} })),
    getMcpServers: vi.fn(async () => []),
  };
  const sessionFacade = {
    agent: vi.fn(() => agentFacade),
    fork: vi.fn(async () => ({ id: 'fork-1' })),
    agents: vi.fn(async () => ({})),
    view: sessionView('session-1', sessionModel),
  };
  const configFacade = {
    get: vi.fn(async (_key: string): Promise<string | undefined> => undefined),
    getAll: vi.fn(async () => ({})),
    replace: vi.fn(),
    replaceSections: vi.fn(),
    reload: vi.fn(),
  };
  const pluginsFacade = {
    list: vi.fn(async () => []),
    preview: vi.fn(async () => ({ id: 'fixture-source', fingerprint: 'f'.repeat(64), contributions: ['session-source:fixture'], consentRequired: true })),
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
    setDefaultModel: vi.fn(async () => ({ model: 'model-b' })),
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
    save: vi.fn(async () => ({
      id: 'file-1',
      expires_at: new Date(Date.now() + MEDIA_STAGING_TTL_SECONDS * 1_000).toISOString(),
    })),
    delete: vi.fn(async () => {}),
  };
  const flagsFacade = {
    list: vi.fn(async () => [{ id: 'example-flag', enabled: true, source: 'config' }]),
  };
  const klientClose = vi.fn();
  internal.client.klient = {
    close: klientClose,
    session: vi.fn((sessionId: string) => ({ ...sessionFacade, view: sessionView(sessionId, sessionModel) })),
    global: {
      config: configFacade,
      plugins: pluginsFacade,
      personas: { list: vi.fn(async () => []) },
      kosong: providerFacade,
      auth: authFacade,
      files: filesFacade,
      flags: flagsFacade,
    },
  };
  internal.client.listSessions = vi.fn(async () => ({ items: [], nextCursor: undefined }));
  internal.client.createSession = vi.fn(async () => ({ id: 'session-created' }));
  internal.client.listPersonas = vi.fn(async () => []);
  internal.client.getGoal = vi.fn(async () => null);
  internal.client.undoSession = vi.fn();
  internal.client.listModels = vi.fn(async () => ({
    items: [
      {
        id: 'model-b',
        provider_id: 'example',
        remote_id: 'model-b',
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
  internal.client.setTitle = vi.fn(async (_sessionId, title) => ({ id: 'session-1', title }));
  internal.client.updateSessionProfile = vi.fn(async () => ({
    id: 'session-1',
    agent_config: { model: 'model-a', profile: undefined },
  }));
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
    queuedPromptContents,
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
    const internal = tui as unknown as {
      clearActivityTickTimer(): void;
      clearStatusNotice(): void;
      inputHistory: Promise<unknown>;
    };
    internal.clearActivityTickTimer();
    internal.clearStatusNotice();
    tui.state.footer.dispose();
    await internal.inputHistory;
    await (tui as unknown as { client: { close(): Promise<void> } }).client.close();
  }
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('DaemonTUI steering and background shortcuts', () => {
  it('sends a busy draft immediately and clears it only when acknowledged', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    controllerState.queuedPromptIds = ['parked'];
    let acknowledge: (() => void) | undefined;
    let resolve: ((result: Awaited<ReturnType<SessionController['sendPromptNow']>>) => void) | undefined;
    controller.sendPromptNow.mockImplementationOnce((input) => {
      acknowledge = input.onAcknowledged;
      return new Promise((done) => { resolve = done; });
    });
    tui.state.editor.setText('change direction');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
    expect(controller.sendPromptNow).toHaveBeenCalledWith(expect.objectContaining({ text: 'change direction', promptId: expect.any(String) }));
    expect(tui.state.editor.getText()).toBe('change direction');
    acknowledge!();
    expect(tui.state.editor.getText()).toBe('');
    resolve!({ promptId: 'now', outcome: 'accepted' });
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('Prompt steering: accepted.', expect.objectContaining({ transient: true })));
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(controller.steerQueued).not.toHaveBeenCalled();
  });

  it('blocks repeated Ctrl+S and Enter while send-now is pending but keeps typing enabled', async () => {
    const { tui, controller, controllerState } = driver();
    controllerState.busy = true;
    let acknowledge: (() => void) | undefined;
    let resolve: ((result: Awaited<ReturnType<SessionController['sendPromptNow']>>) => void) | undefined;
    controller.sendPromptNow.mockImplementationOnce((input) => {
      acknowledge = input.onAcknowledged;
      return new Promise((done) => { resolve = done; });
    });

    tui.state.editor.setText('change direction');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
    expect(tui.state.editor.disableSubmit).toBe(true);

    tui.state.editor.handleInput('!');
    expect(tui.state.editor.getText()).toBe('change direction!');
    tui.state.editor.handleInput('\u0013');
    tui.state.editor.handleInput('\r');
    expect(controller.sendPromptNow).toHaveBeenCalledOnce();
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(tui.state.editor.getText()).toBe('change direction!');

    acknowledge!();
    resolve!({ promptId: 'now', outcome: 'accepted' });
    await vi.waitFor(() => expect(tui.state.editor.disableSubmit).toBe(false));
    expect(tui.state.editor.getText()).toBe('change direction!');
  });

  it('preserves edits made while a send-now acknowledgement is in flight', async () => {
    const { tui, controller, controllerState } = driver();
    controllerState.busy = true;
    controller.sendPromptNow.mockImplementationOnce(async (input) => {
      tui.state.editor.setText('next draft');
      input.onAcknowledged?.();
      return { promptId: input.promptId!, outcome: 'steered' };
    });
    tui.state.editor.setText('send this');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
    expect(tui.state.editor.getText()).toBe('next draft');
  });

  it('steers structured media, file attachments and inline skills through the shared controller', async () => {
    const { tui, internal, controller, controllerState, agentFacade } = driver();
    controllerState.busy = true;
    internal.skillCommands.set('review', { commandName: 'review', name: 'review', description: 'Review changes' });
    const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'image-upload');
    internal.fileAttachments.set(1, { id: 1, fileId: 'file-upload', expiresAt: freshUploadExpiry(), sourcePath: 'C:/fixture/input.txt', name: 'input.txt', mediaType: 'text/plain', size: 5, placeholder: '[file #1 input.txt]' });
    tui.state.editor.setText(`inspect /review ${image.placeholder} [file #1 input.txt]`);
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
    const input = controller.sendPromptNow.mock.calls[0]![0];
    expect(input.skills).toEqual([{ name: 'review' }]);
    expect(input.content).toEqual([
      { type: 'text', text: 'inspect /review ' },
      { type: 'image', source: { kind: 'file', file_id: 'image-upload' } },
      { type: 'text', text: ' ' },
      { type: 'file', file_id: 'file-upload', name: 'input.txt', media_type: 'text/plain', size: 5 },
    ]);
    expect(tui.state.editor.getText()).toBe('');
    expect(internal.imageAttachments.get(image.id)).toBeUndefined();
    expect(internal.fileAttachments.has(1)).toBe(false);
    expect(internal.attachmentSettlementLeases.has(`prompt:session-1:${input.promptId}`)).toBe(true);
    expect(agentFacade.promptWithSkills).not.toHaveBeenCalled();
  });

  it('retains submitted image and file references when an edited draft keeps their placeholders', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    let acknowledge: (() => void) | undefined;
    let resolve: ((result: Awaited<ReturnType<SessionController['sendPromptNow']>>) => void) | undefined;
    controller.sendPromptNow.mockImplementationOnce((input) => {
      acknowledge = input.onAcknowledged;
      return new Promise((done) => { resolve = done; });
    });
    const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'retained-image');
    internal.fileAttachments.set(1, { id: 1, fileId: 'retained-file', expiresAt: freshUploadExpiry(), sourcePath: 'C:/fixture/input.txt', name: 'input.txt', mediaType: 'text/plain', size: 5, placeholder: '[file #1 input.txt]' });
    const submitted = `inspect ${image.placeholder} [file #1 input.txt]`;
    const edited = `${submitted} with a comparison`;
    tui.state.editor.setText(submitted);
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
    const sentContent = controller.sendPromptNow.mock.calls[0]![0].content;
    expect(sentContent).toEqual([
      { type: 'text', text: 'inspect ' },
      { type: 'image', source: { kind: 'file', file_id: 'retained-image' } },
      { type: 'text', text: ' ' },
      { type: 'file', file_id: 'retained-file', name: 'input.txt', media_type: 'text/plain', size: 5 },
    ]);

    tui.state.editor.setText(edited);
    acknowledge!();
    expect(tui.state.editor.getText()).toBe(edited);
    resolve!({ promptId: 'first-steer', outcome: 'accepted' });
    await vi.waitFor(() => expect(tui.state.editor.disableSubmit).toBe(false));
    expect(internal.imageAttachments.get(image.id)).toBeDefined();
    expect(internal.fileAttachments.has(1)).toBe(true);
    expect(internal.attachmentSettlementLeases.size).toBe(0);

    controllerState.busy = false;
    await internal.handleInput(edited);
    expect(controller.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      text: edited,
      content: expect.arrayContaining(sentContent!),
    }));
  });

  it.each(['accepted', 'steered', 'started', 'queued'] as const)(
    'hands staged media off only after the final %s result when acknowledgement emptied the editor',
    async (outcome) => {
      const { tui, internal, controller, controllerState } = driver();
      controllerState.busy = true;
      let acknowledge: (() => void) | undefined;
      let resolve: ((result: Awaited<ReturnType<SessionController['sendPromptNow']>>) => void) | undefined;
      controller.sendPromptNow.mockImplementationOnce((input) => {
        acknowledge = input.onAcknowledged;
        return new Promise((done) => { resolve = done; });
      });
      const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'handoff-after-result');
      tui.state.editor.setText(`inspect ${image.placeholder}`);
      tui.state.editor.handleInput('\u0013');
      await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
      const promptId = controller.sendPromptNow.mock.calls[0]![0].promptId!;

      acknowledge!();
      expect(tui.state.editor.getText()).toBe('');
      expect(internal.imageAttachments.get(image.id)).toBeDefined();
      expect(internal.attachmentSettlementLeases.size).toBe(0);

      resolve!({ promptId, outcome });
      await vi.waitFor(() => expect(tui.state.editor.disableSubmit).toBe(false));
      expect(internal.imageAttachments.get(image.id)).toBeUndefined();
      expect(internal.attachmentSettlementLeases.has(`prompt:session-1:${promptId}`)).toBe(true);
    },
  );

  it.each(['restoring', 'held'] as const)(
    'keeps draft-owned staged image and file media when send-now is deferred as %s',
    async (outcome) => {
      const { tui, internal, controller, controllerState } = driver();
      controllerState.busy = true;
      controller.sendPromptNow.mockImplementationOnce(async (input) => {
        input.onAcknowledged?.();
        return { promptId: input.promptId!, outcome };
      });
      const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'deferred-image');
      internal.fileAttachments.set(1, { id: 1, fileId: 'deferred-file', expiresAt: freshUploadExpiry(), sourcePath: 'C:/fixture/input.txt', name: 'input.txt', mediaType: 'text/plain', size: 5, placeholder: '[file #1 input.txt]' });
      tui.state.editor.setText(`inspect ${image.placeholder} [file #1 input.txt]`);
      tui.state.editor.handleInput('\u0013');

      await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledOnce());
      expect(internal.imageAttachments.get(image.id)).toBeDefined();
      expect(internal.fileAttachments.has(1)).toBe(true);
      expect(internal.attachmentSettlementLeases.size).toBe(0);
      expect(internal.showStatus).toHaveBeenCalledWith(`Prompt steering: ${outcome}.`, expect.objectContaining({ transient: true }));
    },
  );

  it('restores a legacy-refused send-now draft after acknowledgement when the editor is empty', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    controller.sendPromptNow.mockImplementationOnce(async (input) => {
      input.onAcknowledged?.();
      throw new SendNowError('refused', new Error('legacy server refused the steer'));
    });
    tui.state.editor.setText('keep this draft');
    tui.state.editor.handleInput('\u0013');

    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('legacy server refused the steer', 'error'));
    expect(tui.state.editor.getText()).toBe('keep this draft');
    expect(tui.state.editor.disableSubmit).toBe(false);
  });

  it('leaves unknown-send uploads for TTL expiry when clearing staged attachments', async () => {
    const { tui, internal, controller, controllerState, filesFacade } = driver();
    controllerState.busy = true;
    const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'unconfirmed-image');
    internal.fileAttachments.set(1, { id: 1, fileId: 'unconfirmed-file', expiresAt: freshUploadExpiry(), sourcePath: 'C:/fixture/input.txt', name: 'input.txt', mediaType: 'text/plain', size: 5, placeholder: '[file #1 input.txt]' });
    controller.sendPromptNow.mockRejectedValueOnce(new SendNowError('unknown', new Error('reply lost')));
    tui.state.editor.setText(`inspect ${image.placeholder} [file #1 input.txt]`);
    tui.state.editor.handleInput('\u0013');

    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('Prompt delivery is unconfirmed. Check the queue before retrying.', 'error'));
    await internal.clearAttachments();

    expect(internal.imageAttachments.get(image.id)).toBeUndefined();
    expect(internal.fileAttachments.size).toBe(0);
    expect(filesFacade.delete).not.toHaveBeenCalledWith('unconfirmed-image');
    expect(filesFacade.delete).not.toHaveBeenCalledWith('unconfirmed-file');
  });

  it('keeps an unacknowledged draft and its media after a failed send', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    controller.sendPromptNow.mockRejectedValueOnce(new Error('send failed'));
    const image = internal.imageAttachments.addImage(new Uint8Array([1]), 'image/png', 20, 10, undefined, 'image-upload');
    const text = `inspect ${image.placeholder}`;
    tui.state.editor.setText(text);
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('send failed', 'error'));
    expect(tui.state.editor.getText()).toBe(text);
    expect(internal.imageAttachments.get(image.id)).toBeDefined();
    expect(tui.state.editor.disableSubmit).toBe(false);

    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPromptNow).toHaveBeenCalledTimes(2));
  });

  it('does not resubmit matching unconfirmed text through Ctrl+S and Enter', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    const text = 'possibly delivered already';
    controller.getPendingSteers.mockReturnValue([{
      promptId: 'unconfirmed-steer',
      text,
      createdAt: '2026-01-01T00:00:00.000Z',
      phase: 'unconfirmed',
    }]);
    tui.state.editor.setText(text);

    tui.state.editor.handleInput('\u0013');
    tui.state.editor.handleInput('\r');

    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('Prompt delivery is unconfirmed. Check the queue before retrying.', 'error'));
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(tui.state.editor.getText()).toBe(text);
  });

  it.each([
    { outcome: 'accepted' as const },
    { outcome: 'steered' as const },
    { outcome: 'started' as const },
    { outcome: 'queued' as const, reason: 'executor_deferred' as const },
    { outcome: 'not_pending' as const, reason: 'prompt_no_longer_pending' as const },
    { outcome: 'unconfirmed' as const },
    { outcome: 'failed' as const },
    { outcome: 'cancelled' as const },
  ])('steers the first parked prompt and reports $outcome accurately', async (result) => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    controllerState.queuedPromptIds = ['first', 'second'];
    controller.steerQueued.mockResolvedValueOnce(result);
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.steerQueued).toHaveBeenCalledExactlyOnceWith('first'));
    const reason = result.reason === undefined ? '.' : ` (${result.reason.replaceAll('_', ' ')}).`;
    expect(internal.showStatus).toHaveBeenCalledWith(`Prompt steering: ${result.outcome.replaceAll('_', ' ')}${reason}`, { tone: result.outcome === 'failed' ? 'error' : 'normal', transient: true });
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
  });

  it.each(['', '!echo hello'])('gives a transient notice when no input is steerable (%s)', async (text) => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = true;
    tui.state.editor.setText(text);
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('No prompt to steer.', { transient: true }));
    expect(tui.state.editor.getText()).toBe(text);
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
  });

  it('steers parked input without submitting or clearing a bash draft', async () => {
    const { tui, controller, controllerState } = driver();
    controllerState.busy = true;
    controllerState.queuedPromptIds = ['parked'];
    tui.state.editor.setInputMode('bash');
    tui.state.editor.setText('echo hello');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.steerQueued).toHaveBeenCalledExactlyOnceWith('parked'));
    expect(tui.state.editor.getText()).toBe('echo hello');
    expect(tui.state.editor.inputMode).toBe('bash');
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
  });

  it('submits ordinary idle input through the native editor submit path', async () => {
    const { tui, controller } = driver();
    tui.state.editor.setText('ordinary input');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(controller.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ text: 'ordinary input' })));
    expect(tui.state.editor.getText()).toBe('');
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
  });

  it('keeps slash commands on their normal command path while busy', async () => {
    const { tui, controller, controllerState } = driver();
    controllerState.busy = true;
    const focus = vi.spyOn(tui.state.ui, 'setFocus');
    tui.state.editor.setText('/help');
    tui.state.editor.handleInput('\u0013');
    await vi.waitFor(() => expect(focus).toHaveBeenCalled());
    expect(controller.sendPromptNow).not.toHaveBeenCalled();
    expect(controller.sendPrompt).not.toHaveBeenCalled();
  });

  const foreground = { kind: 'process' as const, taskId: 'foreground', description: 'Task', command: 'example-command', pid: 1, exitCode: null, status: 'running' as const, detached: false, startedAt: 1, endedAt: null };

  it('moves only live foreground tasks to background using their authoritative task receipts', async () => {
    const { tui, internal, controllerState, agentFacade, sessionFacade } = driver();
    controllerState.busy = true;
    agentFacade.getTasks.mockResolvedValueOnce([
      foreground,
      { ...foreground, taskId: 'second' },
      { ...foreground, taskId: 'background', detached: true },
      { ...foreground, taskId: 'finished', status: 'completed', endedAt: 2 },
      { ...foreground, taskId: 'unknown', detached: undefined },
    ]);
    agentFacade.detachTask.mockImplementation(async (taskId) => ({ ...foreground, taskId, detached: true }));
    tui.state.editor.handleInput('\u0002');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('Moved 2 foreground tasks to background.', { transient: true }));
    expect(agentFacade.getTasks).toHaveBeenCalledExactlyOnceWith({ activeOnly: true });
    expect(sessionFacade.agent).toHaveBeenCalledWith('main');
    expect(agentFacade.detachTask.mock.calls).toEqual([['foreground'], ['second']]);
  });

  it('reports pure model streaming without claiming there is a foreground task', async () => {
    const { tui, internal, controllerState, agentFacade } = driver();
    controllerState.busy = true;
    tui.state.editor.handleInput('\u0002');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('No foreground task to move to background.', { transient: true }));
    expect(agentFacade.detachTask).not.toHaveBeenCalled();
  });

  it('does not claim a task that finished before detach was moved to background', async () => {
    const { tui, internal, controllerState, agentFacade } = driver();
    controllerState.busy = true;
    agentFacade.getTasks.mockResolvedValueOnce([foreground]);
    agentFacade.detachTask.mockResolvedValueOnce({ ...foreground, status: 'completed', endedAt: 2 });
    tui.state.editor.handleInput('\u0002');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('No foreground task to move to background.', { transient: true }));
  });

  it('reports detach failures without a success notice', async () => {
    const { tui, internal, controllerState, agentFacade } = driver();
    controllerState.busy = true;
    agentFacade.getTasks.mockResolvedValueOnce([foreground]);
    agentFacade.detachTask.mockRejectedValueOnce(new Error('detach failed'));
    tui.state.editor.handleInput('\u0002');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('detach failed', 'error'));
  });

  it('leaves Ctrl+B to the editor when idle', () => {
    const { tui, agentFacade } = driver();
    expect(tui.state.editor.onCtrlB?.()).toBe(false);
    expect(agentFacade.getTasks).not.toHaveBeenCalled();
  });
});

describe('DaemonTUI commands', () => {
  it.each([80, 60, 24])('opens readable production help at %s columns and restores the draft', async (width) => {
    const { tui, internal, controllerState } = driver();
    const focus = vi.spyOn(tui.state.ui, 'setFocus');
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    vi.spyOn(tui.state.terminal, 'rows', 'get').mockReturnValue(24);
    tui.state.editor.setText('unfinished draft\n第二行');
    await internal.handleSlash('/help');
    const panel = focus.mock.lastCall?.[0];
    if (panel === undefined || panel === null) throw new Error('Help was not focused');
    expect(panel).not.toBe(tui.state.editor);
    const frames: string[] = [];
    let previous = '';
    for (let i = 0; i < 600; i++) {
      const lines = tui.state.editorContainer.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const frame = lines.join('\n').replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
      if (frame === previous) break;
      previous = frame;
      frames.push(frame);
      panel.handleInput?.('\u001B[B');
    }
    for (const text of [
      '/tasks [stop|output] [task-id]', 'Browse background tasks',
      '/help (/h, /?)', 'Not available in the terminal UI',
      'Export the session as a ZIP archive; use kiki export', 'Local docs:',
      'type / in the input box', 'Ctrl+-',
      'press twice over a draft', '/stop',
      'Send draft immediately into the running turn',
      'steer next queued prompt',
      'Move foreground tasks to background',
    ]) expect(frames.some((frame) => frame.replaceAll(/\s+/g, ' ').includes(text)), text).toBe(true);
    controllerState.busy = true;
    (tui as unknown as { renderActivityState(view: unknown): void }).renderActivityState({
      ...controllerState, tasks: [],
    });
    expect(focus.mock.lastCall?.[0]).toBe(panel);
    panel.handleInput?.('\u001B');
    expect(focus.mock.lastCall?.[0]).toBe(tui.state.editor);
    expect(tui.state.editor.getText()).toBe('unfinished draft\n第二行');
    expect(internal.client.createSession).not.toHaveBeenCalled();
  });

  it.each(['a', 'b'])('shows connection identity and cwd without a query or local-home substitution (%s)', async (scope) => {
    const homeId = scope === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const connection = {
      url: `http://example-${scope}.test:57580`, token: 'private-token',
      serverId: `daemon-${scope}`,
      identity: { homeId, hostId: `host-${scope}`, protocol: 1 as const },
    };
    const tui = new DaemonTUI(connection, {
      cliOptions: { continue: false, yolo: false, auto: false, plan: false, agentFiles: [], skillsDirs: [] },
      tuiConfig: DEFAULT_TUI_CONFIG, version: '1.0.0', workDir: `C:/workspace-${scope}`,
    });
    created.push(tui);
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    vi.stubEnv('KIKI_HOME', 'C:/client-only-home');
    const internal = tui as unknown as { handleSlash(text: string): Promise<void> };
    await internal.handleSlash('/status');
    const output = transcriptText(tui);
    expect(output).toContain(`Working directory: C:/workspace-${scope}`);
    expect(output).toContain(`Daemon: ${connection.url}`);
    expect(output).toContain(`Daemon ID: daemon-${scope}`);
    expect(output).toContain(`Home ID: ${homeId}`);
    expect(output).toContain(`Host ID: host-${scope}`);
    expect(output).toContain('Session: not started');
    expect(output).not.toContain('client-only-home');
    expect(output).not.toContain(connection.token);
  });

  it('renders usage before the first message without creating a session or checking auth', async () => {
    const { tui, internal, agentFacade } = driver();
    (internal as unknown as { controller?: unknown }).controller = undefined;
    const prototype = Object.getPrototypeOf(tui) as { showStatus(message: string): void };
    internal.showStatus.mockImplementation((message: string) => prototype.showStatus.call(tui, message));
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    const auth = internal.client.klient['global'] as { auth: { ensureReady: ReturnType<typeof vi.fn> } };
    auth.auth.ensureReady = vi.fn();
    await internal.handleSlash('/usage');
    const output = transcriptText(tui, 80);
    expect(output).toContain('No token usage recorded yet.');
    expect(output).not.toContain('/login');
    expect(internal.client.createSession).not.toHaveBeenCalled();
    expect(auth.auth.ensureReady).not.toHaveBeenCalled();
    expect(agentFacade.getUsage).not.toHaveBeenCalled();
  });

  it('shows the active session usage rather than the empty hint', async () => {
    const { tui, internal, agentFacade } = driver();
    agentFacade.getUsage.mockResolvedValue({ total: { inputTokens: 12 } } as never);
    await internal.handleSlash('/usage');
    expect(agentFacade.getUsage).toHaveBeenCalledTimes(1);
    const output = transcriptText(tui);
    expect(output).toContain('Usage');
    expect(output).toContain('total  input 12  output 0  total 12');
    expect(output).not.toContain('"inputTokens"');
    expect(output).not.toContain('No token usage');
    expect(internal.client.createSession).not.toHaveBeenCalled();
  });

  it('propagates active session usage failures instead of presenting an empty session', async () => {
    const { internal, agentFacade } = driver();
    agentFacade.getUsage.mockRejectedValue(new Error('usage unavailable'));
    await expect(internal.handleSlash('/usage')).rejects.toThrow('usage unavailable');
    expect(internal.showStatus).not.toHaveBeenCalled();
  });

  it('marks missing connection identity unavailable instead of guessing from client home', async () => {
    const { tui, internal } = driver();
    vi.stubEnv('KIKI_HOME', 'C:/client-only-home');
    await internal.handleSlash('/status');
    expect(transcriptText(tui)).toContain('Home ID: unavailable from this connection');
    expect(transcriptText(tui)).toContain('Host ID: unavailable from this connection');
    expect(transcriptText(tui)).not.toContain('client-only-home');
    expect(internal.client.createSession).not.toHaveBeenCalled();
  });

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

    expect(markdown).toContain('# Kiki Loaded Transcript View');
    expect(markdown).toContain('Includes only loaded user and assistant text');
    expect(markdown).toContain('question with image');
    expect(markdown).toContain('answer');
    expect(markdown).not.toContain('secret-media');
    expect(markdown).not.toContain('secret-tool-output');
    expect(markdown).not.toContain('secret-notice');
  });

  it('keeps a REST-selected model for subsequent prompts', async () => {
    const { tui, internal, controller, providerFacade } = driver();

    await internal.handleSlash('/model model-b');
    await internal.handleInput('hello');

    expect(internal.client.setModel).toHaveBeenCalledWith('session-1', 'model-b');
    expect(providerFacade.setDefaultModel).toHaveBeenCalledWith('model-b');
    expect(tui.state.appState.model).toBe('model-b');
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', model: 'model-b' }),
    );
  });

  it('does not replace an existing configured default when a model is selected', async () => {
    const { internal, configFacade, providerFacade } = driver();
    configFacade.get.mockResolvedValue('model-a');

    await internal.handleSlash('/model model-b');

    expect(configFacade.get).toHaveBeenCalledWith('defaultModel');
    expect(providerFacade.setDefaultModel).not.toHaveBeenCalled();
  });

  it('maps enabled REST models into the app-state catalog using effective metadata', async () => {
    const { tui, internal } = driver();
    internal.client.listModels.mockResolvedValue({
      items: [
        {
          id: 'model-b',
          provider_id: 'example',
          remote_id: 'remote-b',
          display_name: 'Model B',
          max_context_size: 128_000,
          enabled: true,
          capabilities: ['chat'],
          effective_capabilities: ['chat', 'tools'],
          protocol: 'openai',
          effective_protocol: 'kimi',
          support_efforts: ['off', 'high'],
          default_effort: 'high',
        },
        {
          id: 'model-c',
          provider_id: 'example',
          remote_id: 'remote-c',
          max_context_size: 64_000,
          capabilities: ['vision'],
          protocol: 'anthropic',
        },
        {
          id: 'disabled-model',
          provider_id: 'example',
          remote_id: 'disabled-remote',
          max_context_size: 32_000,
          enabled: false,
        },
      ],
    });

    await internal.refreshModels();

    expect(tui.state.appState.availableModels).toEqual({
      'model-b': {
        provider: 'example',
        model: 'remote-b',
        displayName: 'Model B',
        maxContextSize: 128_000,
        capabilities: ['chat', 'tools'],
        defaultEffort: 'high',
        supportEfforts: ['off', 'high'],
        protocol: 'kimi',
      },
      'model-c': {
        provider: 'example',
        model: 'remote-c',
        displayName: 'model-c',
        maxContextSize: 64_000,
        capabilities: ['vision'],
        defaultEffort: undefined,
        supportEfforts: undefined,
        protocol: 'anthropic',
      },
    });
  });

  it('opens model selection and preserves the draft when no model is selected', async () => {
    const { tui, internal, controller, providerFacade } = driver(false, { model: null });
    internal.client.listModels.mockResolvedValue({
      items: [
        { id: 'model-b', provider_id: 'example', remote_id: 'remote-b', max_context_size: 128_000 },
        { id: 'model-c', provider_id: 'example', remote_id: 'remote-c', max_context_size: 64_000 },
      ],
    });

    await internal.handleInput('choose a model before sending');

    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(internal.client.setModel).not.toHaveBeenCalled();
    expect(providerFacade.setDefaultModel).not.toHaveBeenCalled();
    expect(tui.state.editor.getText()).toBe('choose a model before sending');
    expect(tui.state.editorContainer.children[0]).not.toBe(tui.state.editor);
    expect(tui.state.editorContainer.render(80).join('\n')).toContain('Select a model');
  });

  it('seeds the pinned default profile model ahead of the global default without binding it', async () => {
    const { tui, internal, configFacade, providerFacade } = driver(false, { model: null });
    internal.startupOverridesPending = false;
    configFacade.get.mockResolvedValue('model-b');
    internal.client.listModels.mockResolvedValue({
      items: [
        { id: 'model-b', provider_id: 'example', remote_id: 'remote-b', max_context_size: 128_000 },
        { id: 'model-c', provider_id: 'example', remote_id: 'remote-c', max_context_size: 64_000 },
      ],
    });
    internal.client.listAgentProfiles.mockResolvedValue({
      items: [{
        name: 'agent',
        source: 'user',
        workspace_id: 'workspace-1',
        path: 'agent.md',
        description: 'Default agent',
        disabled: false,
        routes: [],
        pinned_model_alias: 'model-c',
        thinking_effort: 'high',
        executor: 'native',
      }],
    });

    await internal.openSession('session-1');

    expect(tui.state.appState.model).toBe('model-c');
    expect(tui.state.appState.thinkingEffort).toBe('high');
    expect(internal.client.listAgentProfiles).toHaveBeenCalledTimes(2);
    expect(internal.client.listAgentProfiles).toHaveBeenNthCalledWith(1, 'wd_fixture_000000000000');
    expect(internal.client.setModel).not.toHaveBeenCalled();
    expect(providerFacade.setDefaultModel).not.toHaveBeenCalled();
    expect(configFacade.get).toHaveBeenCalledWith('defaultModel');
    await tui.close();
  });

  it('withdraws queued messages newest-first, merges them into the draft, and reports an empty queue', async () => {
    const { tui, internal, controller, controllerState, queuedPromptContents } = driver();
    controllerState.queuedPromptIds = ['queued-1', 'queued-2'];
    controllerState.blocks = [
      { kind: 'user', promptId: 'queued-1', promptStatus: 'queued' },
      { kind: 'user', promptId: 'queued-2', promptStatus: 'queued' },
    ];
    queuedPromptContents.set('queued-1', [{ type: 'text', text: 'first queued message' }]);
    queuedPromptContents.set('queued-2', [{ type: 'text', text: 'second queued message' }]);
    tui.state.editor.setText('existing draft');

    await internal.handleSlash('/unqueue');
    expect(controller.abortPrompt).toHaveBeenCalledWith('queued-2');
    expect(tui.state.editor.getText()).toBe('existing draft\n\nsecond queued message');
    expect(internal.showStatus).toHaveBeenLastCalledWith(
      'Withdrew the queued message; it is back in the input box.',
      { transient: true },
    );

    await internal.handleSlash('/unqueue');
    expect(controller.abortPrompt).toHaveBeenLastCalledWith('queued-1');
    expect(tui.state.editor.getText()).toBe('existing draft\n\nsecond queued message\n\nfirst queued message');
    await internal.handleSlash('/unqueue');
    expect(internal.showStatus).toHaveBeenLastCalledWith('Nothing is queued.', { transient: true });
  });

  it('does not restore a queued message that starts while /unqueue is withdrawing it', async () => {
    const { tui, internal, controller, controllerState, queuedPromptContents } = driver();
    controllerState.queuedPromptIds = ['queued-race'];
    controllerState.blocks = [{ kind: 'user', promptId: 'queued-race', promptStatus: 'queued' }];
    queuedPromptContents.set('queued-race', [{ type: 'text', text: 'message that started' }]);
    tui.state.editor.setText('keep this draft');
    controller.abortPrompt.mockImplementationOnce(async (promptId) => {
      controllerState.queuedPromptIds = [];
      controllerState.blocks = [{ kind: 'user', promptId, promptStatus: 'running' }];
      return false;
    });

    await internal.handleSlash('/unqueue');

    expect(controller.abortPrompt).toHaveBeenCalledWith('queued-race');
    expect(tui.state.editor.getText()).toBe('keep this draft');
    expect(internal.showStatus).toHaveBeenLastCalledWith('That message has already started.', { transient: true });
  });

  it('does not restore queued content after switching sessions while reading it', async () => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.queuedPromptIds = ['queued-old-session'];
    tui.state.editor.setText('new session draft');
    let resolveContent!: (content: readonly MessageContent[] | undefined) => void;
    controller.readQueuedPromptContent.mockReturnValueOnce(
      new Promise((resolve) => { resolveContent = resolve; }),
    );

    const pendingUnqueue = internal.handleSlash('/unqueue');
    internal.controller = { ...controller, sessionId: 'session-2' };
    resolveContent([{ type: 'text', text: 'message from previous session' }]);
    await pendingUnqueue;

    expect(controller.abortPrompt).not.toHaveBeenCalled();
    expect(tui.state.editor.getText()).toBe('new session draft');
  });

  it('preserves plan mode in startup and prompt submissions', async () => {
    const { tui, internal, controller } = driver(true);

    await internal.handleInput('hello');

    expect(tui.state.appState.planMode).toBe(true);
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', planMode: true }),
    );
  });

  it('accepts review directly and offers it in the mounted permission selector', async () => {
    const { tui, internal } = driver();
    const focus = vi.spyOn(tui.state.ui, 'setFocus');
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    await internal.handleSlash('/permission review');
    expect(internal.client.setPermission).toHaveBeenCalledWith('session-1', 'review');
    expect(tui.state.appState.permissionMode).toBe('review');
    await internal.handleSlash('/permission manual');
    tui.state.editor.setText('unfinished draft');
    await internal.handleSlash('/permission');
    const picker = focus.mock.lastCall?.[0];
    if (picker === undefined || picker === null) throw new Error('Permission picker was not focused');
    const rendered = tui.state.editorContainer.render(80).join('\n');
    expect(rendered).toContain('Approve for me');
    picker.handleInput?.('\u001B[B');
    picker.handleInput?.('\u001B[B');
    picker.handleInput?.('\r');
    await vi.waitFor(() => { expect(tui.state.appState.permissionMode).toBe('review'); });
    expect(internal.client.setPermission).toHaveBeenLastCalledWith('session-1', 'review');
    expect(focus.mock.lastCall?.[0]).toBe(tui.state.editor);
    expect(tui.state.editor.getText()).toBe('unfinished draft');
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

  it('lists active personas and switches by starting a new session', async () => {
    const { tui, internal } = driver();
    internal.client.listPersonas.mockResolvedValue([
      { id: 'xiao-you', name: 'Yuzu', title: 'Release', revision: '2', archived: false },
      { id: 'archived', name: 'Archived', revision: '1', archived: true },
    ]);
    const openSession = vi.fn();
    internal.openSession = openSession;

    await internal.handleSlash('/persona list');
    expect(transcriptText(tui)).toContain('xiao-you · Yuzu · Release');
    expect(transcriptText(tui)).not.toContain('Archived');

    await internal.handleSlash('/persona switch xiao-you');
    expect(internal.client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ persona: 'xiao-you' }),
    );
    expect(openSession).toHaveBeenCalledWith('session-created');
    expect(internal.showStatus).toHaveBeenLastCalledWith('Started a new session with persona Yuzu.');
    await expect(internal.handleSlash('/persona switch archived')).rejects.toThrow(
      'Persona "archived" was not found.',
    );
  });

  it('applies plan and title session actions through REST', async () => {
    const { tui, internal } = driver();

    await internal.handleSlash('/plan');
    await internal.handleSlash('/title Release session');

    expect(internal.client.setPlanMode).toHaveBeenCalledWith('session-1', true);
    expect(internal.client.setTitle).toHaveBeenCalledWith('session-1', 'Release session');
    expect(tui.state.appState).toMatchObject({
      planMode: true,
      sessionTitle: 'Release session',
    });
  });

  it.each([
    '/plugins install --trust C:\\plugins\\local',
    '/plugins enable fixture-source',
    '/plugins disable fixture-source',
    '/plugins remove fixture-source',
  ])('refreshes the live session without a global plugin reload after %s', async (command) => {
    const { internal, controller, pluginsFacade, configFacade } = driver();
    await internal.handleSlash(command);
    expect(pluginsFacade.reload).not.toHaveBeenCalled();
    expect(configFacade.reload).not.toHaveBeenCalled();
    expect(controller.resync).toHaveBeenCalledOnce();
    expect(internal.client.listAgentProfiles).toHaveBeenCalled();
    expect(internal.client.listSkills).toHaveBeenCalledWith('session-1');
  });

  it('performs exactly one explicit global plugin reload', async () => {
    const { internal, controller, pluginsFacade } = driver();
    await internal.handleSlash('/plugins reload');
    expect(pluginsFacade.reload).toHaveBeenCalledOnce();
    expect(controller.resync).toHaveBeenCalledOnce();
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
    const marketplacePath = fileURLToPath(new URL('../../../../../plugins/marketplace.json', import.meta.url));

    await internal.handleSlash('/compact keep decisions');
    await internal.handleSlash('/tasks stop task-1');
    await internal.handleSlash('/fork Review copy');
    await internal.handleSlash(`/plugins marketplace ${marketplacePath}`);
    await expect(internal.handleSlash('/plugins install C:\\plugins\\local')).rejects.toThrow('consent once');
    expect(pluginsFacade.install).not.toHaveBeenCalled();
    await internal.handleSlash('/plugins install --trust C:\\plugins\\local');
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
    expect(openSession).not.toHaveBeenCalled();
    expect(internal.controller).toBe(controller);
    expect(internal.showStatus).toHaveBeenCalledWith('Session forked: fork-1');
    expect(pluginsFacade.install).toHaveBeenCalledWith({ source: 'C:\\plugins\\local', fingerprint: 'f'.repeat(64), consent: true });
    expect(pluginsFacade.preview).toHaveBeenCalledWith({ source: 'C:\\plugins\\local' });
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

  it('opens interactive settings by default, redacts /settings json output, and rejects plaintext provider secrets', async () => {
    const { tui, internal, configFacade, providerFacade } = driver();
    const focus = vi.spyOn(tui.state.ui, 'setFocus');
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    configFacade.getAll.mockResolvedValue({
      provider: {
        apiKey: 'settings-secret',
        headers: { Authorization: 'Bearer settings-token' },
      },
      nested: { enabled: true },
    });

    await internal.handleSlash('/settings');
    const dialog = focus.mock.lastCall?.[0];
    expect(dialog).toBeDefined();
    expect(dialog).not.toBe(tui.state.editor);
    const dialogFrame = tui.state.editorContainer.render(100).join('\n').replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(dialogFrame).toContain('Settings');
    expect(dialogFrame).toContain('Busy Enter behavior');
    expect(dialogFrame).toContain('Mouse reporting');
    expect(transcriptText(tui)).not.toContain('settings-secret');
    expect(configFacade.getAll).not.toHaveBeenCalled();
    dialog?.handleInput?.('\u001B');
    expect(focus.mock.lastCall?.[0]).toBe(tui.state.editor);

    await internal.handleSlash('/settings json');
    const rendered = transcriptText(tui);
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

  it('records server upload expiry for pasted images and videos', async () => {
    const { internal, filesFacade } = driver();
    const readClipboardMedia = vi.spyOn(clipboardImage, 'readClipboardMedia');
    const imageExpiry = Date.now() + 10 * 60_000;
    const videoExpiry = Date.now() + 20 * 60_000;
    const imageBytes = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    readClipboardMedia.mockResolvedValueOnce({
      kind: 'image',
      bytes: imageBytes,
      mimeType: 'image/png',
    });
    filesFacade.save.mockResolvedValueOnce(uploadMeta('pasted-image-upload', imageExpiry));

    try {
      await internal.handleClipboardPaste();
      await internal.imageAttachments.get(1)?.pending;
      expect(internal.imageAttachments.get(1)?.fileExpiresAt).toBe(imageExpiry);

      readClipboardMedia.mockResolvedValueOnce({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'sample.mp4',
        sourcePath: resolve(process.cwd(), 'package.json'),
      });
      filesFacade.save.mockResolvedValueOnce(uploadMeta('pasted-video-upload', videoExpiry));
      await internal.handleClipboardPaste();
      await internal.imageAttachments.get(2)?.pending;
      expect(internal.imageAttachments.get(2)?.fileExpiresAt).toBe(videoExpiry);
    } finally {
      readClipboardMedia.mockRestore();
    }
  });

  it('deduplicates concurrent cleanup ownership for the same invalid upload id', async () => {
    const { internal, filesFacade } = driver();
    let resolveDelete!: () => void;
    filesFacade.delete.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
    );

    const first = internal.ownInvalidUpload('shared-invalid-upload');
    const second = internal.ownInvalidUpload('shared-invalid-upload');
    expect(filesFacade.delete).toHaveBeenCalledOnce();
    expect(internal.invalidUploadCleanups.size).toBe(1);

    resolveDelete();
    await Promise.all([first, second]);
    expect(internal.invalidUploadCleanups.size).toBe(0);
  });

  it('owns and retries expiry-less initial image cleanup until deletion succeeds', async () => {
    vi.useFakeTimers();
    const { internal, filesFacade } = driver();
    const readClipboardMedia = vi.spyOn(clipboardImage, 'readClipboardMedia');
    readClipboardMedia.mockResolvedValueOnce({
      kind: 'image',
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      ),
      mimeType: 'image/png',
    });
    filesFacade.save.mockResolvedValueOnce({ id: 'expiry-less-image' } as never);
    filesFacade.delete.mockRejectedValueOnce(new Error('delete failed'));

    try {
      await internal.handleClipboardPaste();
      await internal.imageAttachments.get(1)?.pending;
      expect(internal.invalidUploadCleanups.has('expiry-less-image')).toBe(true);
      expect(filesFacade.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      expect(internal.invalidUploadCleanups.has('expiry-less-image')).toBe(false);
    } finally {
      readClipboardMedia.mockRestore();
      vi.useRealTimers();
    }
  });

  it('owns and retries expiry-less initial video cleanup until deletion succeeds', async () => {
    vi.useFakeTimers();
    const { internal, filesFacade } = driver();
    const readClipboardMedia = vi.spyOn(clipboardImage, 'readClipboardMedia');
    readClipboardMedia.mockResolvedValueOnce({
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'sample.mp4',
      sourcePath: resolve(process.cwd(), 'package.json'),
    });
    filesFacade.save.mockResolvedValueOnce({ id: 'expiry-less-video' } as never);
    filesFacade.delete.mockRejectedValueOnce(new Error('delete failed'));

    try {
      await internal.handleClipboardPaste();
      await internal.imageAttachments.get(1)?.pending;
      expect(internal.invalidUploadCleanups.has('expiry-less-video')).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      expect(internal.invalidUploadCleanups.has('expiry-less-video')).toBe(false);
    } finally {
      readClipboardMedia.mockRestore();
      vi.useRealTimers();
    }
  });

  it('owns and retries expiry-less ordinary file cleanup until deletion succeeds', async () => {
    vi.useFakeTimers();
    try {
      const { internal, filesFacade } = driver();
      filesFacade.save.mockResolvedValueOnce({ id: 'expiry-less-file' } as never);
      filesFacade.delete.mockRejectedValueOnce(new Error('delete failed'));

      await expect(
        internal.handleSlash(`/attach ${resolve(process.cwd(), 'package.json')}`),
      ).rejects.toThrow('Attachment upload did not include an expiry');
      expect(internal.invalidUploadCleanups.has('expiry-less-file')).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      expect(internal.invalidUploadCleanups.has('expiry-less-file')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries persistent invalid-upload cleanup during dispose and reports failure', async () => {
    const { tui, internal, filesFacade, klientClose } = driver();
    filesFacade.save.mockResolvedValueOnce({ id: 'persistent-invalid-upload' } as never);
    filesFacade.delete.mockRejectedValue(new Error('delete unavailable'));

    await expect(
      internal.handleSlash(`/attach ${resolve(process.cwd(), 'package.json')}`),
    ).rejects.toThrow('Attachment upload did not include an expiry');
    expect(internal.invalidUploadCleanups.has('persistent-invalid-upload')).toBe(true);

    await expect(tui.close()).rejects.toThrow('Failed to clean up invalid attachment uploads');

    expect(filesFacade.delete).toHaveBeenCalledTimes(2);
    expect(internal.invalidUploadCleanups.has('persistent-invalid-upload')).toBe(true);
    expect(klientClose).toHaveBeenCalledOnce();
  });

  it('uploads local files and sends real file content parts', async () => {
    const { tui, internal, controller, controllerState, filesFacade } = driver();
    const path = resolve(process.cwd(), 'package.json');
    const uploadExpiry = freshUploadExpiry();
    filesFacade.save.mockResolvedValueOnce(uploadMeta('file-1', uploadExpiry));

    await internal.handleSlash(`/attach ${path}`);
    expect(internal.fileAttachments.get(1)?.expiresAt).toBe(uploadExpiry);
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
    expect(filesFacade.delete).not.toHaveBeenCalledWith('file-1');

    controllerState.blocks = [{ kind: 'user', promptId: 'prompt-1' }];
    internal.settleAttachmentLeases(controllerState);
    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('file-1');
    });
  });

  it('refreshes an expired file from its retained source path', async () => {
    const { tui, internal, controller, filesFacade } = driver();
    const path = resolve(process.cwd(), 'package.json');
    await internal.handleSlash(`/attach ${path}`);
    const attachment = internal.fileAttachments.get(1)!;
    attachment.expiresAt = Date.now() - 1;
    const refreshedExpiry = Date.now() + 20 * 60_000;
    filesFacade.save.mockResolvedValueOnce(uploadMeta('fresh-file-upload', refreshedExpiry));

    await internal.handleInput(`inspect ${tui.state.editor.getText()}`);

    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'file', file_id: 'fresh-file-upload' }),
        ]),
      }),
    );
    expect(filesFacade.delete).toHaveBeenCalledWith('file-1');
    expect([...internal.attachmentSettlementLeases.values()][0]?.deadlineAt).toBe(refreshedExpiry);
  });

  it('retains an expired image draft after refresh failure and retries with a new upload', async () => {
    const { internal, controller, filesFacade } = driver();
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'expired-image-upload',
      Date.now() - 1,
    );
    filesFacade.save.mockRejectedValueOnce(new Error('refresh unavailable'));

    await expect(internal.handleInput(`inspect ${image.placeholder}`)).rejects.toThrow(
      'Attachment refresh failed',
    );
    expect(controller.sendPrompt).not.toHaveBeenCalled();
    expect(internal.imageAttachments.get(image.id)).toBe(image);
    expect(image.fileId).toBeUndefined();

    const refreshedExpiry = Date.now() + 10 * 60_000;
    filesFacade.save.mockResolvedValueOnce(uploadMeta('fresh-image-upload', refreshedExpiry));
    await internal.handleInput(`inspect ${image.placeholder}`);

    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          { type: 'image', source: { kind: 'file', file_id: 'fresh-image-upload' } },
        ]),
      }),
    );
    expect(controller.sendPrompt).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          { type: 'image', source: { kind: 'file', file_id: 'expired-image-upload' } },
        ]),
      }),
    );
    expect([...internal.attachmentSettlementLeases.values()][0]?.deadlineAt).toBe(refreshedExpiry);
  });

  it('keeps ownership when refresh cleanup initially fails, then retries deletion', async () => {
    vi.useFakeTimers();
    try {
      const { internal, controller, filesFacade } = driver();
      const image = internal.imageAttachments.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        1,
        1,
        undefined,
        'expired-image-upload',
        Date.now() - 1,
      );
      filesFacade.save.mockResolvedValueOnce({ id: 'expiry-less-refresh' } as never);
      filesFacade.delete.mockRejectedValueOnce(new Error('delete failed'));

      await expect(internal.handleInput(`inspect ${image.placeholder}`)).rejects.toThrow(
        'The refreshed upload did not include an expiry',
      );
      expect(controller.sendPrompt).not.toHaveBeenCalled();
      expect(internal.invalidUploadCleanups.has('expiry-less-refresh')).toBe(true);

      await vi.advanceTimersByTimeAsync(250);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      expect(internal.invalidUploadCleanups.has('expiry-less-refresh')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes an expired video from its retained source path', async () => {
    const { internal, controller, filesFacade } = driver();
    const sourcePath = resolve(process.cwd(), 'package.json');
    const video = internal.imageAttachments.addVideo('video/mp4', sourcePath, 'sample.mp4');
    video.fileId = 'expired-video-upload';
    video.fileExpiresAt = Date.now() - 1;
    const refreshedExpiry = Date.now() + 15 * 60_000;
    filesFacade.save.mockResolvedValueOnce(uploadMeta('fresh-video-upload', refreshedExpiry));

    await internal.handleInput(`inspect ${video.placeholder}`);

    expect(filesFacade.save).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'sample.mp4', mimeType: 'video/mp4' }),
    );
    expect(controller.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.arrayContaining([
          { type: 'video', source: { kind: 'file', file_id: 'fresh-video-upload' } },
        ]),
      }),
    );
    expect(filesFacade.delete).toHaveBeenCalledWith('expired-video-upload');
    expect([...internal.attachmentSettlementLeases.values()][0]?.deadlineAt).toBe(refreshedExpiry);
  });

  it('caps a multi-attachment settlement at the earliest real upload expiry', async () => {
    const { internal } = driver();
    const earliestExpiry = Date.now() + 5 * 60_000;
    const laterExpiry = Date.now() + 10 * 60_000;
    const first = internal.imageAttachments.addImage(
      new Uint8Array([1]),
      'image/png',
      1,
      1,
      undefined,
      'first-image-upload',
      earliestExpiry,
    );
    const second = internal.imageAttachments.addImage(
      new Uint8Array([2]),
      'image/png',
      1,
      1,
      undefined,
      'second-image-upload',
      laterExpiry,
    );

    await internal.handleInput(`compare ${first.placeholder} ${second.placeholder}`);

    expect([...internal.attachmentSettlementLeases.values()][0]?.deadlineAt).toBe(earliestExpiry);
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

  it('retries settled media deletion with bounded backoff during normal runtime', async () => {
    vi.useFakeTimers();
    try {
      const { internal, controller, controllerState, filesFacade } = driver();
      filesFacade.delete
        .mockRejectedValueOnce(new Error('delete failed once'))
        .mockRejectedValueOnce(new Error('delete failed twice'))
        .mockResolvedValueOnce(undefined);
      const image = internal.imageAttachments.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        1,
        1,
        undefined,
        'retry-image-upload',
      );
      controller.sendPrompt.mockResolvedValue({
        prompt_id: 'retry-image-prompt',
        user_message_id: 'retry-image-user',
        status: 'running',
        content: [{ type: 'text', text: 'inspect image' }],
        created_at: '2026-01-01T00:00:00.000Z',
      });

      await internal.handleInput(`inspect ${image.placeholder}`);
      controllerState.blocks = [{ kind: 'user', promptId: 'retry-image-prompt' }];
      internal.settleAttachmentLeases(controllerState);
      await Promise.resolve();
      await Promise.resolve();
      expect(filesFacade.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(249);
      expect(filesFacade.delete).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(filesFacade.delete).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(filesFacade.delete).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
    expect(filesFacade.delete).not.toHaveBeenCalled();
    expect(controller.close).not.toHaveBeenCalled();

    controllerState.blocks = [{ kind: 'user', promptId: 'switched-image-prompt' }];
    emitController();
    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('switched-image-upload');
    });
    expect(controller.close).toHaveBeenCalledOnce();
  });

  it('closes a retained settlement controller at the media TTL when no terminal arrives', async () => {
    vi.useFakeTimers();
    try {
      const { internal, controller, controllerState, filesFacade } = driver();
      const image = internal.imageAttachments.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        1,
        1,
        undefined,
        'never-settled-image-upload',
      );
      controller.sendPrompt.mockImplementation(async () => {
        controllerState.activePromptId = 'never-settled-prompt';
        return {
          prompt_id: 'never-settled-prompt',
          user_message_id: 'never-settled-user',
          status: 'running',
          content: [{ type: 'text', text: 'inspect image' }],
          created_at: '2026-01-01T00:00:00.000Z',
        };
      });

      await internal.handleInput(`inspect ${image.placeholder}`);
      internal.startupOverridesPending = false;
      await internal.openSession('session-2');
      await vi.advanceTimersByTimeAsync(MEDIA_STAGING_TTL_SECONDS * 1_000);

      expect(controller.close).toHaveBeenCalledOnce();
      expect(internal.sideControllers.has(controller as never)).toBe(false);
      expect(filesFacade.delete).not.toHaveBeenCalledWith('never-settled-image-upload');
    } finally {
      vi.useRealTimers();
    }
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

  it('puts a draft back when sending fails, but not once the daemon accepted it', async () => {
    const { tui, internal, controller } = driver();
    const editor = tui.state.editor;
    controller.sendPrompt.mockRejectedValueOnce(new Error('fetch failed'));
    editor.setText('a long instruction that took a minute to write');
    editor.handleInput('\r');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('fetch failed', 'error'));
    expect(editor.getText()).toBe('a long instruction that took a minute to write');

    // Accepted by the daemon, then a follow-up resync failed: restoring the
    // draft here would invite a duplicate send.
    const image = internal.imageAttachments.addImage(Buffer.from('image'), 'image/png', 2, 2, undefined, 'file-image');
    controller.resync.mockRejectedValueOnce(new Error('resync offline'));
    editor.setText(`look ${image.placeholder}`);
    editor.handleInput('\r');
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('resync offline', 'error'));
    expect(controller.sendPrompt).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe('');
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

  it('restores interrupted prompt text into drafts and avoids overwriting a shell command', async () => {
    const { tui, internal } = driver();
    internal.startupOverridesPending = false;
    const abortPrompt = vi.spyOn(internal.client, 'abortPrompt').mockResolvedValue({ aborted: true, at_seq: 2 } as never);
    await internal.openSession('session-1');
    const controller = internal.controller as unknown as SessionController;
    const editor = tui.state.editor;
    let seq = 0;
    const interrupt = async (promptId: string, text: string) => {
      seq += 1;
      const turnId = `turn-${promptId}`;
      const userMessageId = `user-${promptId}`;
      controller.handleTranscript({
        type: 'transcript.reset',
        session_id: 'session-1',
        agent_id: 'main',
        snapshot: {
          items: [{
            kind: 'turn',
            turnId,
            ordinal: seq,
            state: 'running',
            origin: { kind: 'user', payload: { promptId, userMessageId } },
            prompt: text,
            startedAt: '2026-01-01T00:00:00.000Z',
            steps: [{ kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state: 'running', frames: [] }],
          }],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [{
            promptId,
            status: 'running',
            userMessageId,
            content: [{ type: 'text', text }],
            createdAt: '2026-01-01T00:00:00.000Z',
          }],
          meta: { activity: 'turn' },
          hasMoreOlder: false,
        },
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        cursor: { seq, epoch: 'epoch-1' },
      } as never);
      await controller.abortActive();
    };

    editor.setText('');
    await interrupt('prompt-empty', 'interrupted with no draft');
    expect(editor.getText()).toBe('interrupted with no draft');
    expect(internal.showStatus).toHaveBeenLastCalledWith('Your message is back in the input box.', { transient: true });

    editor.setText('keep my follow-up');
    await interrupt('prompt-merge', 'interrupted prompt');
    expect(editor.getText()).toBe('keep my follow-up\n\ninterrupted prompt');

    const largePaste = Array.from({ length: 15 }, (_, index) => `large pasted line ${String(index + 1)}`).join('\n');
    editor.setText('');
    editor.handleInput(`\u001B[200~${largePaste}\u001B[201~`);
    expect(editor.getText()).toMatch(/\[paste #\d+/);
    await interrupt('prompt-paste', 'interrupted after the paste');
    expect(editor.getText()).toContain('[paste #');
    expect(editor.getExpandedText()).toBe(`${largePaste}\n\ninterrupted after the paste`);

    editor.setInputMode('bash');
    editor.setText('');
    await interrupt('prompt-shell-empty', 'restore into prompt mode');
    expect(editor.inputMode).toBe('prompt');
    expect(editor.getText()).toBe('restore into prompt mode');

    editor.setInputMode('bash');
    editor.setText('echo keep this');
    await interrupt('prompt-shell-draft', 'do not overwrite shell input');
    expect(editor.inputMode).toBe('bash');
    expect(editor.getText()).toBe('echo keep this');
    expect(internal.showStatus).toHaveBeenLastCalledWith(
      'Your message was not put back; press ↑ to recall it.',
      { transient: true },
    );
    expect(abortPrompt).toHaveBeenCalledTimes(5);
    await tui.close();
  });

  describe('Esc, Ctrl-C and Ctrl-D typed into the input box', () => {
    const ESC = '\u001B';
    const CTRL_C = '\u0003';
    const CTRL_D = '\u0004';
    const UP = '\u001B[A';

    function keys() {
      const setup = driver();
      const stop = vi.spyOn(setup.tui, 'stop').mockResolvedValue(undefined);
      vi.spyOn(setup.tui.state.ui, 'requestRender').mockImplementation(() => {});
      const editor = setup.tui.state.editor;
      return { ...setup, stop, editor, hint: () => setup.tui.state.footer.getTransientHint() };
    }

    it('interrupts a running turn at once when the input box is empty', () => {
      const { controller, controllerState, editor } = keys();
      controllerState.busy = true;
      editor.handleInput(ESC);
      expect(controller.abortActive).toHaveBeenCalledOnce();
    });

    it('asks for a second Esc before interrupting over a draft, and keeps the draft', () => {
      const { controller, controllerState, editor, hint } = keys();
      controllerState.busy = true;
      editor.setText('half typed draft');

      editor.handleInput(ESC);
      expect(controller.abortActive).not.toHaveBeenCalled();
      expect(hint()).toBe('Press Esc again to interrupt');

      editor.handleInput(ESC);
      expect(controller.abortActive).toHaveBeenCalledOnce();
      expect(editor.getText()).toBe('half typed draft');
      expect(hint()).toBeNull();
    });

    it('disarms the pending interrupt on any other key', () => {
      const { controller, controllerState, editor, hint } = keys();
      controllerState.busy = true;
      editor.setText('draft');
      editor.handleInput(ESC);
      editor.handleInput('x');
      expect(hint()).toBeNull();
      editor.handleInput(ESC);
      expect(controller.abortActive).not.toHaveBeenCalled();
      expect(editor.getText()).toBe('draftx');
    });

    it('does nothing on Esc while idle', () => {
      const { controller, editor, hint } = keys();
      editor.setText('draft');
      editor.handleInput(ESC);
      editor.handleInput(ESC);
      expect(controller.abortActive).not.toHaveBeenCalled();
      expect(editor.getText()).toBe('draft');
      expect(hint()).toBeNull();
    });

    it('leaves history browsing with Esc and restores the earlier draft instead of interrupting', () => {
      const { controller, controllerState, editor } = keys();
      editor.addToHistory('older prompt');
      controllerState.busy = true;
      editor.setText('my draft');
      editor.handleInput(UP);
      editor.handleInput(UP);
      expect(editor.getText()).toBe('older prompt');
      editor.handleInput(ESC);
      expect(editor.getText()).toBe('my draft');
      expect(controller.abortActive).not.toHaveBeenCalled();
    });

    it('clears a draft with Ctrl-C without arming exit, then exits on two presses over an empty input', () => {
      const { controller, editor, stop, hint } = keys();
      editor.setText('draft');
      editor.handleInput(CTRL_C);
      expect(editor.getText()).toBe('');
      expect(hint()).toBe('Ctrl+- to restore');
      editor.handleInput(CTRL_C);
      expect(hint()).toBe('Press Ctrl+C again to exit');
      expect(stop).not.toHaveBeenCalled();
      editor.handleInput(CTRL_C);
      expect(stop).toHaveBeenCalledOnce();
      expect(controller.abortActive).not.toHaveBeenCalled();
    });

    it('clears a draft and then interrupts with Ctrl-C while a turn runs', () => {
      const { controller, controllerState, editor, stop } = keys();
      controllerState.busy = true;
      editor.setText('draft');
      editor.handleInput(CTRL_C);
      expect(editor.getText()).toBe('');
      expect(controller.abortActive).not.toHaveBeenCalled();
      editor.handleInput(CTRL_C);
      expect(controller.abortActive).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
    });

    it('exits on two Ctrl-D presses over an empty input even while a turn runs', () => {
      const { controllerState, editor, stop, hint } = keys();
      controllerState.busy = true;
      editor.setText('ab');
      editor.handleInput('\u0001');
      editor.handleInput(CTRL_D);
      expect(editor.getText()).toBe('b');
      editor.setText('');
      editor.handleInput(CTRL_D);
      expect(hint()).toBe('Press Ctrl+D again to exit');
      expect(stop).not.toHaveBeenCalled();
      editor.handleInput(CTRL_D);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('closes the session picker on Ctrl-C when a session is open, and exits only from the startup picker', async () => {
      const open = keys();
      await open.internal.showSessionPicker();
      open.tui.state.editorContainer.children[0]!.handleInput?.(CTRL_C);
      expect(open.stop).not.toHaveBeenCalled();
      expect(open.tui.state.editorContainer.children[0]).toBe(open.editor);

      const startup = keys();
      (startup.internal as unknown as { controller: undefined }).controller = undefined;
      await startup.internal.showSessionPicker();
      startup.tui.state.editorContainer.children[0]!.handleInput?.(CTRL_C);
      expect(startup.stop).toHaveBeenCalledOnce();
    });
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
      thinkingEffort: 'off',
      contextTokens: 10,
      maxContextTokens: 100,
      busy: true,
      turnRetry: { failedAttempt: 1, maxAttempts: 3, delayMs: 4_000 },
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
    expect(tui.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, delayMs: 4_000 });
    expect(tui.state.todoPanel.hasOverflow()).toBe(true);
    expect(tui.state.editor.onToggleTodoExpand?.()).toBe(true);
    expect(internal.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Retrying (attempt 2 of 3) in 4s'),
      { tone: 'normal', source: 'activity' },
    );
    expect(tui.state.footer.render(120).join('\n')).toContain('task');
  });

  it('binds image paste, todo expansion, and history without hijacking editor undo', () => {
    const { tui } = driver();

    expect(tui.state.editor.onPasteImage).toBeTypeOf('function');
    expect(tui.state.editor.onToggleTodoExpand).toBeTypeOf('function');
    expect(tui.state.editor.onUndo).toBeUndefined();
    expect(tui.state.editor.onRecall).toBeTypeOf('function');
    expect(tui.state.editor.onTextPaste).toBeTypeOf('function');
  });

  it('recalls submitted input with Up and reloads it for the same working directory', async () => {
    const first = driver();
    const shell = vi.fn(async () => {});
    (first.internal.client as unknown as { runShellCommand: typeof shell }).runShellCommand = shell;
    const editor = first.tui.state.editor;
    // setText instead of per-key typing: a burst of synthetic keystrokes would
    // trip paste-burst detection and turn Enter into a newline.
    const submit = (text: string) => {
      if (text.startsWith('!')) editor.handleInput('!');
      editor.setText(text.replace(/^!/u, ''));
      editor.handleInput('\r');
    };
    submit('first prompt');
    submit('!ls -la');
    submit('second prompt');
    await vi.waitFor(() => expect(first.controller.sendPrompt).toHaveBeenCalledTimes(2));
    expect(shell).toHaveBeenCalledOnce();
    await (first.tui as unknown as { inputHistory: Promise<unknown> }).inputHistory;

    editor.handleInput('\u001B[A');
    expect(editor.getText()).toBe('second prompt');
    editor.handleInput('\u001B[A');
    expect(editor.getText()).toBe('first prompt');
    editor.handleInput('\u001B[B');
    editor.handleInput('\u001B[B');
    expect(editor.getText()).toBe('');

    const home = process.env['KIKI_HOME'];
    const second = driver();
    vi.stubEnv('KIKI_HOME', home);
    await (second.tui as unknown as { loadInputHistory(): Promise<unknown> }).loadInputHistory();
    const reloaded = second.tui.state.editor;
    reloaded.handleInput('\u001B[A');
    expect(reloaded.getText()).toBe('second prompt');
    reloaded.handleInput('\u001B[B');
    reloaded.handleInput('!');
    reloaded.handleInput('\u001B[A');
    expect(reloaded.inputMode).toBe('bash');
    expect(reloaded.getText()).toBe('ls -la');
  });

  it.each([false, true])('restores a Ctrl-C-cleared draft with native undo (busy=%s), leaving /undo explicit', async (busy) => {
    const { tui, internal, controller, controllerState } = driver();
    controllerState.busy = busy;
    const editor = tui.state.editor;
    const draft = 'Keep my unfinished draft\nincluding this line';
    editor.setText(draft);

    editor.handleInput('\u0003');
    expect(editor.getText()).toBe('');
    expect(tui.state.footer.getTransientHint()).toBe('Ctrl+- to restore');
    expect(controller.abortActive).not.toHaveBeenCalled();
    editor.handleInput('\u001F');
    expect(editor.getText()).toBe(draft);
    expect(tui.state.footer.getTransientHint()).toBeNull();
    expect(internal.client.undoSession).not.toHaveBeenCalled();
    expect(controller.resync).not.toHaveBeenCalled();

    await internal.handleSlash('/undo');
    expect(internal.client.undoSession).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(controller.resync).toHaveBeenCalledExactlyOnceWith({ rewrite: true });
    expect(editor.getText()).toBe(draft);
  });

  it('preserves native custom undo and other editor bindings without a session fallback', () => {
    const original = getKeybindings();
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.editor.undo': 'ctrl+z',
      'tui.editor.deleteToLineStart': 'ctrl+-',
    }));
    try {
      const { tui, internal } = driver();
      const editor = tui.state.editor;
      editor.setText('Custom draft');
      editor.setText('');
      editor.handleInput('\u001A');
      expect(editor.getText()).toBe('Custom draft');
      editor.handleInput('\u001F');
      expect(editor.getText()).toBe('');
      editor.handleInput('\u001A');
      expect(editor.getText()).toBe('Custom draft');
      expect(internal.client.undoSession).not.toHaveBeenCalled();
    } finally {
      setKeybindings(original);
    }
  });

  it('normalizes aliases, runs experiments, and rejects unknown slash input', async () => {
    const { tui, internal, controller, configFacade } = driver();
    const focus = vi.spyOn(tui.state.ui, 'setFocus');
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

    await internal.handleSlash('/thinking high');
    await internal.handleSlash('/h');
    const help = focus.mock.lastCall?.[0];
    if (help === undefined || help === null) throw new Error('Help was not focused');
    expect(help).not.toBe(tui.state.editor);
    expect(tui.state.editorContainer.render(80).join('\n')).toContain('Sessions & history');
    help.handleInput?.('\u001B');
    expect(focus.mock.lastCall?.[0]).toBe(tui.state.editor);
    await internal.handleSlash('/config');
    const configDialog = focus.mock.lastCall?.[0];
    expect(configDialog).toBeDefined();
    expect(configDialog).not.toBe(tui.state.editor);
    expect(tui.state.editorContainer.render(90).join('\n')).toContain('Busy Enter behavior');
    configDialog?.handleInput?.('\u001B');
    expect(focus.mock.lastCall?.[0]).toBe(tui.state.editor);
    await internal.handleSlash('/config json');
    await internal.handleSlash('/experimental');
    await internal.handleSlash('/custom value');

    expect(internal.client.setThinking).toHaveBeenCalledWith('session-1', 'high');
    expect(tui.state.appState.thinkingEffort).toBe('high');
    expect(configFacade.getAll).toHaveBeenCalledOnce();
    expect(transcriptText(tui)).toContain('example-flag');
    expect(internal.showStatus).toHaveBeenCalledWith(
      'Unknown command: /custom',
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

    expect(internal.skillCommands.get('reviewskill')).toMatchObject({
      commandName: 'ReviewSkill',
      name: 'ReviewSkill',
    });
    expect(internal.agentProfileCommands.get('reviewer')).toBe('Reviewer');

    await internal.handleSlash('/skill:ReviewSkill   staged  \t changes   ');
    await internal.handleSlash('/REVIEWER   inspect  \t tests   ');

    expect(internal.client.activateSkill).toHaveBeenCalledWith(
      'session-1',
      'ReviewSkill',
      'staged  \t changes',
      undefined,
    );
    expect(controller.sendPrompt).toHaveBeenCalledWith({
      text: 'inspect  \t tests',
      profile: 'Reviewer',
      model: undefined,
      thinking: undefined,
      permissionMode: 'manual',
      planMode: false,
    });
  });

  it('sends command attachments once and retains the failed command draft for retry', async () => {
    const { tui, internal } = driver();
    internal.client.listSkills.mockResolvedValue({ skills: [{
      name: 'brainstorm', description: 'Discuss options', path: '/workspace/.kiki/commands/brainstorm.md',
      source: 'project', prompt_command: true, argument_hint: '<topic>',
    }] });
    await internal.refreshSkillCommands('session-1');
    const image = internal.imageAttachments.addImage(Buffer.from('image'), 'image/png', 2, 2, undefined, 'file-image');
    const text = `/brainstorm menu ${image.placeholder}`;
    internal.client.activateSkill.mockRejectedValueOnce(new Error('Command unavailable'));
    tui.state.editor.onSubmit?.(text);
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith('Command unavailable', 'error'));
    expect(tui.state.editor.getText()).toBe(text);
    expect(internal.imageAttachments.get(image.id)).toBeDefined();
    internal.client.activateSkill.mockResolvedValueOnce({ activated: true, skill_name: 'brainstorm' });
    await internal.handleSlash(text);
    expect(internal.client.activateSkill).toHaveBeenLastCalledWith('session-1', 'brainstorm', 'menu ', [{
      type: 'image', source: { kind: 'file', file_id: 'file-image' },
    }]);
    expect(internal.imageAttachments.get(image.id)).toBeUndefined();
    expect(internal.client.setPlanMode).not.toHaveBeenCalled();
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

  it('refreshes a near-expiry image before submitting a queued inline-skill prompt', async () => {
    const { internal, agentFacade, filesFacade } = driver();
    internal.skillCommands.set('skill:reviewskill', {
      commandName: 'skill:ReviewSkill',
      name: 'ReviewSkill',
      description: 'Review changes',
    });
    agentFacade.promptWithSkills.mockResolvedValue({
      prompt_id: 'queued-skill-prompt',
      created_at: '2026-01-01T00:00:00.000Z',
      state: 'queued',
    });
    const uploadTime = Date.now();
    const oldExpiry = uploadTime + MEDIA_STAGING_TTL_SECONDS * 1_000;
    const image = internal.imageAttachments.addImage(
      new Uint8Array([1, 2, 3]),
      'image/png',
      1,
      1,
      undefined,
      'aging-image-upload',
      oldExpiry,
    );
    const submitTime = oldExpiry - MEDIA_FILE_REF_MIN_REMAINING_MS;
    const refreshedExpiry = submitTime + MEDIA_STAGING_TTL_SECONDS * 1_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(submitTime);
    filesFacade.save.mockResolvedValueOnce(uploadMeta('queued-fresh-image', refreshedExpiry));

    try {
      await internal.handleInput(`Please /skill:ReviewSkill inspect ${image.placeholder}`);
    } finally {
      now.mockRestore();
    }

    expect(agentFacade.promptWithSkills).toHaveBeenCalledWith({
      input: expect.arrayContaining([
        { type: 'image_url', imageUrl: { url: 'kimi-file://queued-fresh-image' } },
      ]),
      skills: [{ name: 'ReviewSkill' }],
    });
    expect(filesFacade.delete).toHaveBeenCalledWith('aging-image-upload');
    expect([...internal.attachmentSettlementLeases.values()][0]?.deadlineAt).toBe(refreshedExpiry);
  });

  it('keeps queued inline-skill media through a failed resync until terminal projection', async () => {
    const { internal, controller, controllerState, agentFacade, filesFacade } = driver();
    controller.resync.mockImplementationOnce(async () => {
      controllerState.resyncFailed = true;
      throw new Error('resync failed');
    });
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

    await expect(
      internal.handleInput(`Please /skill:ReviewSkill inspect ${image.placeholder}`),
    ).rejects.toThrow('resync failed');
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.version += 1;
    internal.settleAttachmentLeases(controllerState);
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.resyncFailed = false;
    internal.settleAttachmentLeases(controllerState);
    expect(filesFacade.delete).not.toHaveBeenCalled();

    controllerState.blocks = [{ kind: 'user', promptId: 'skill-prompt' }];
    internal.settleAttachmentLeases(controllerState);
    await vi.waitFor(() => {
      expect(filesFacade.delete).toHaveBeenCalledWith('skill-image-upload');
    });
  });

  it.each(['running', 'blocked'] as const)(
    'keeps %s inline-skill media until an explicit terminal prompt projection',
    async (state) => {
      const { internal, controllerState, agentFacade, filesFacade } = driver();
      internal.skillCommands.set('skill:reviewskill', {
        commandName: 'skill:ReviewSkill',
        name: 'ReviewSkill',
        description: 'Review changes',
      });
      agentFacade.promptWithSkills.mockResolvedValue({
        prompt_id: 'skill-prompt',
        created_at: '2026-01-01T00:00:00.000Z',
        state,
      });
      controllerState.blocks = [{ kind: 'user', promptId: 'skill-prompt', promptStatus: state }];
      const image = internal.imageAttachments.addImage(
        new Uint8Array([1, 2, 3]),
        'image/png',
        1,
        1,
        undefined,
        `${state}-skill-image-upload`,
      );

      await internal.handleInput(`Please /skill:ReviewSkill inspect ${image.placeholder}`);
      internal.settleAttachmentLeases(controllerState);
      expect(filesFacade.delete).not.toHaveBeenCalled();

      controllerState.resyncing = true;
      controllerState.blocks = [{ kind: 'user', promptId: 'skill-prompt' }];
      internal.settleAttachmentLeases(controllerState);
      expect(filesFacade.delete).not.toHaveBeenCalled();

      controllerState.resyncing = false;
      internal.settleAttachmentLeases(controllerState);
      await vi.waitFor(() => {
        expect(filesFacade.delete).toHaveBeenCalledWith(`${state}-skill-image-upload`);
      });
    },
  );

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

  it('holds an approval behind a dialog the user opened and arms it before keys can answer', async () => {
    vi.useFakeTimers();
    try {
      const { tui, internal, controllerState } = driver();
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
      const sync = internal as unknown as { syncInteractionBlocks(blocks: unknown[]): void };
      const focused = () => tui.state.editorContainer.children[0]!;
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

      await internal.handleSlash('/permission');
      const picker = focused();
      controllerState.busy = true;
      controllerState.blocks = [approval];
      sync.syncInteractionBlocks(controllerState.blocks);
      internal.renderActivityState(controllerState);
      expect(focused()).toBe(picker);
      expect(internal.showStatus).toHaveBeenLastCalledWith(
        'Waiting for your approval · Esc to close this dialog and review',
        expect.objectContaining({ source: 'activity' }),
      );

      // ↓ Enter still belong to the picker; the approval appears once it closes.
      picker.handleInput?.('\u001B[B');
      picker.handleInput?.('\r');
      await vi.waitFor(() => expect(internal.client.setPermission).toHaveBeenCalledOnce());
      expect(internal.client.resolveApproval).not.toHaveBeenCalled();
      const panel = focused();
      expect(panel).not.toBe(picker);
      expect(panel).not.toBe(tui.state.editor);

      // Keys that arrive right after mount (the tail of what the user was
      // typing) cannot answer it; once nothing arrived for the window, they can.
      panel.handleInput?.('2');
      panel.handleInput?.('\r');
      expect(internal.client.resolveApproval).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      panel.handleInput?.('1');
      await vi.waitFor(() => expect(internal.client.resolveApproval).toHaveBeenCalledOnce());
      expect(internal.client.resolveApproval).toHaveBeenCalledWith(
        'session-1',
        'approval-1',
        expect.objectContaining({ decision: 'approved', scope: undefined }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens an approval preview, returns to the same choice, and restores the editor if settled elsewhere', () => {
    vi.useFakeTimers();
    try {
      const { tui, internal } = driver();
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
      vi.spyOn(tui.state.terminal, 'rows', 'get').mockReturnValue(24);
      const oldText = Array.from({ length: 30 }, (_, index) => `original-line-${String(index + 1)}`).join('\n');
      const newText = Array.from({ length: 30 }, (_, index) => `preview-line-${String(index + 1)}`).join('\n');
      const approval = {
        kind: 'approval',
        id: 'approval-preview',
        request: {
          approval_id: 'approval-preview',
          session_id: 'session-1',
          tool_call_id: 'tool-preview',
          tool_name: 'Edit',
          action: 'edit file',
          tool_input_display: { kind: 'generic', detail: { file_path: 'example.txt', old_string: oldText, new_string: newText } },
          created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-01T00:01:00.000Z',
        },
        resolution: undefined,
      };
      const sync = (blocks: readonly unknown[]) => {
        (internal as unknown as { syncInteractionBlocks(blocks: readonly unknown[]): void }).syncInteractionBlocks(blocks);
      };
      const mounted = () => tui.state.editorContainer.children[0];
      tui.state.editorContainer.addChild(tui.state.editor);
      tui.state.ui.setFocus(tui.state.editor);
      sync([approval]);
      const panel = mounted();
      if (panel?.handleInput === undefined) throw new Error('Approval panel was not focused');
      const panelOutput = () => plainText(tui.state.editorContainer.render(80).join('\n'));
      const initialPanel = panelOutput();
      expect(initialPanel).toContain('Ctrl+E preview');
      expect(initialPanel).toContain('(Ctrl+E to preview)');
      expect(initialPanel).not.toContain('preview-line-30');

      vi.advanceTimersByTime(500);
      panel.handleInput('\u001B[B');
      const selectedPanel = panelOutput();
      panel.handleInput('\u0005');
      let viewer = mounted();
      if (viewer?.handleInput === undefined || viewer === panel) throw new Error('Approval preview was not focused');
      for (let index = 0; index < 50; index++) viewer.handleInput('\u001B[B');
      expect(panelOutput()).toContain('preview-line-30');
      expect(internal.client.resolveApproval).not.toHaveBeenCalled();

      viewer.handleInput('\u001B');
      expect(mounted()).toBe(panel);
      expect(panelOutput()).toBe(selectedPanel);
      expect(internal.client.resolveApproval).not.toHaveBeenCalled();

      panel.handleInput('\u0005');
      viewer = mounted();
      if (viewer?.handleInput === undefined || viewer === panel) throw new Error('Approval preview was not reopened');
      sync([]);
      expect(mounted()).toBe(tui.state.editor);
      expect(panelOutput()).not.toContain('preview-line-30');
      expect(internal.client.resolveApproval).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads canonical approval details and can recover after a failed request', async () => {
    const { tui, internal, sessionFacade } = driver();
    vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('Connection interrupted.'))
      .mockResolvedValueOnce([{
        id: 'approval-canonical',
        toolName: 'Edit',
        action: 'edit file',
        display: { kind: 'generic', detail: { path: 'example.txt', old_string: 'old', new_string: 'new' } },
      }]);
    internal.client.klient['session'] = vi.fn(() => ({ ...sessionFacade, approvals: { list } }));
    const approval = {
      kind: 'approval',
      id: 'approval-canonical',
      request: { approval_id: 'approval-canonical', tool_name: 'tool', action: 'Approve the action' },
      resolution: undefined,
    };
    const sync = () => (internal as unknown as {
      syncInteractionBlocks(blocks: readonly unknown[]): void;
    }).syncInteractionBlocks([approval]);
    tui.state.editorContainer.addChild(tui.state.editor);
    sync();
    await vi.waitFor(() => expect(internal.showStatus).toHaveBeenCalledWith(
      'Could not load approval: Connection interrupted. Run /reload to retry.', 'error',
    ));
    expect(tui.state.editorContainer.children[0]).toBe(tui.state.editor);
    expect(internal.client.resolveApproval).not.toHaveBeenCalled();
    sync();
    await vi.waitFor(() => expect(tui.state.editorContainer.children[0]).not.toBe(tui.state.editor));
    const output = plainText(tui.state.editorContainer.render(80).join('\n'));
    expect(output).toContain('example.txt');
    expect(output).toContain('Ctrl+E preview');
    expect(list).toHaveBeenCalledTimes(2);
    expect(internal.client.resolveApproval).not.toHaveBeenCalled();
  });

  it('toggles transcript output from both the approval panel and question dialog', () => {
    const { tui, internal } = driver();
    const tool = {
      kind: 'tool',
      id: 'tool-output',
      toolCallId: 'tool-output',
      name: 'Read',
      argsText: '{"path":"example.txt"}',
      args: { path: 'example.txt' },
      display: undefined,
      description: undefined,
      status: 'done',
      output: 'expanded-tool-output',
      isError: false,
      durationMs: 1,
      progressText: undefined,
      turnId: 'turn-1',
    };
    internal.renderTranscript({ blocks: [tool], busy: false, tasks: [] });
    expect(transcriptText(tui)).not.toContain('expanded-tool-output');
    const approval = {
      kind: 'approval',
      id: 'approval-toggle',
      request: {
        approval_id: 'approval-toggle',
        session_id: 'session-1',
        tool_call_id: 'tool-toggle',
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
      id: 'question-toggle',
      request: {
        question_id: 'question-toggle',
        session_id: 'session-1',
        questions: [{ id: 'q1', question: 'Choose?', options: [{ id: 'a', label: 'A' }] }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      outcome: undefined,
    };
    const sync = (blocks: readonly unknown[]) => {
      (internal as unknown as { syncInteractionBlocks(blocks: readonly unknown[]): void }).syncInteractionBlocks(blocks);
    };
    const mounted = () => tui.state.editorContainer.children[0];

    tui.state.editorContainer.addChild(tui.state.editor);
    tui.state.ui.setFocus(tui.state.editor);
    sync([approval]);
    const approvalPanel = mounted();
    if (approvalPanel?.handleInput === undefined) throw new Error('Approval panel was not focused');
    approvalPanel.handleInput('\u000F');
    expect(tui.state.toolOutputExpanded).toBe(true);
    expect(transcriptText(tui)).toContain('expanded-tool-output');

    sync([]);
    sync([question]);
    const questionDialog = mounted();
    if (questionDialog?.handleInput === undefined) throw new Error('Question dialog was not focused');
    questionDialog.handleInput('\u000F');
    expect(tui.state.toolOutputExpanded).toBe(false);
    expect(transcriptText(tui)).not.toContain('expanded-tool-output');
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

  describe('TUI activity and status presentation (TUI01/02 & AF1/AF2/AF3/AF4)', () => {
    it('clears activityContainer when transitioning from busy to idle without leaving a completed tag', () => {
      const { tui, internal, controllerState } = driver();
      const prototype = Object.getPrototypeOf(tui) as {
        showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
      };
      internal.showStatus.mockImplementation(
        (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
          prototype.showStatus.call(tui, message, options);
        },
      );
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

      // Set busy state
      controllerState.busy = true;
      internal.renderActivityState(controllerState);
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');

      // Transition to idle
      controllerState.busy = false;
      internal.renderActivityState(controllerState);
      expect(tui.state.activityContainer.render(80).join('\n').trim()).toBe('');
    });

    it('renders pure Working… when turnStartedAt is cold or unknown', () => {
      const { tui, internal, controllerState } = driver();
      const prototype = Object.getPrototypeOf(tui) as {
        showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
      };
      internal.showStatus.mockImplementation(
        (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
          prototype.showStatus.call(tui, message, options);
        },
      );
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

      controllerState.busy = true;
      controllerState.turnStartedAt = undefined;
      internal.renderActivityState(controllerState);
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');
      expect(tui.state.activityContainer.render(80).join('\n')).not.toContain('waited');
    });

    it('renders Window 1 waited suffix driven by real 1s tick timer and hands off to Window 2 on first agent response', async () => {
      vi.useFakeTimers();
      try {
        const { tui, internal, controllerState } = driver();
        const prototype = Object.getPrototypeOf(tui) as {
          showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
        };
        internal.showStatus.mockImplementation(
          (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
            prototype.showStatus.call(tui, message, options);
          },
        );
        vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

        const now = 1_700_000_000_000;
        vi.setSystemTime(now);

        controllerState.busy = true;
        controllerState.turnStartedAt = now;
        controllerState.blocks = [{ kind: 'user', id: 'u1', text: 'prompt', createdAt: new Date(now).toISOString() }];
        internal.renderActivityState(controllerState);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working 0s · Esc to interrupt');

        // The clock runs from the first second, driven by the 1s interval tick
        vi.advanceTimersByTime(2_000);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working 2s');
        vi.advanceTimersByTime(16_000);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working 18s · Esc to interrupt');

        // A narrow terminal keeps the state on one line and drops the hint
        const narrowWaited = tui.state.activityContainer.render(24);
        expect(narrowWaited.filter((line) => line.trim() !== '')).toHaveLength(1);
        expect(narrowWaited.join('\n')).toContain('Working 18s');

        // Agent first response arrives at t = 18s
        const firstResponseTime = now + 18_000;
        controllerState.blocks = [
          ...controllerState.blocks,
          {
            kind: 'assistant',
            id: 'a1',
            text: 'Here is the answer',
            streaming: false,
            createdAt: new Date(firstResponseTime).toISOString(),
          },
        ];

        // Trigger update with first agent response
        internal.renderActivityState(controllerState);

        // Advance 5 seconds in Window 2 via real tick
        vi.advanceTimersByTime(5_000);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working 23s · last response 5s ago · Esc to interrupt');

        // At 50 columns the interrupt hint outlasts the last-response detail
        const phone = tui.state.activityContainer.render(50).join('\n');
        expect(phone).toContain('Working 23s · Esc to interrupt');
        expect(phone).not.toContain('last response');

        // Switch session resets tracker and clears tick timer
        await internal.openSession('session-2');
        expect(internal.activityTickTimer).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders pure Working… when turnStartedAt is in the future due to clock skew', () => {
      vi.useFakeTimers();
      try {
        const { tui, internal, controllerState } = driver();
        const prototype = Object.getPrototypeOf(tui) as {
          showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
        };
        internal.showStatus.mockImplementation(
          (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
            prototype.showStatus.call(tui, message, options);
          },
        );
        vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

        const now = 1_700_000_000_000;
        vi.setSystemTime(now);

        controllerState.busy = true;
        controllerState.blocks = [
          { kind: 'user', id: 'old-u', text: 'old', createdAt: new Date(now - 60_000).toISOString() },
          { kind: 'assistant', id: 'old-a', text: 'old answer', streaming: false, createdAt: new Date(now - 59_000).toISOString() },
        ];
        for (const start of [undefined, now + 180_000]) {
          controllerState.turnStartedAt = start;
          internal.renderActivityState(controllerState);
          vi.advanceTimersByTime(60_000);
          expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');
          expect(tui.state.activityContainer.render(80).join('\n')).not.toMatch(/waited|last response/);
          expect(internal.activityTickTimer).toBeUndefined();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('transient notice restores activity after TTL, while non-transient status remains sticky', () => {
      vi.useFakeTimers();
      try {
        const { tui, internal, controllerState } = driver();
        const prototype = Object.getPrototypeOf(tui) as {
          showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
        };
        internal.showStatus.mockImplementation(
          (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
            prototype.showStatus.call(tui, message, options);
          },
        );
        vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

        controllerState.busy = true;
        internal.renderActivityState(controllerState);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');

        // Transient action receipt
        internal.showStatus('Copied the last assistant message.', { transient: true });
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Copied the last assistant message.');

        // Re-rendering activity does not wipe transient message before TTL
        internal.renderActivityState(controllerState);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Copied the last assistant message.');

        // After TTL passes, activity is restored
        vi.advanceTimersByTime(3_000);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');

        // Non-transient status (e.g. export path or web address)
        internal.showStatus('C:/export/result.md');
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('C:/export/result.md');

        // Even after time passes, non-transient status stays sticky and is not cleared by TTL
        vi.advanceTimersByTime(10_000);
        internal.renderActivityState(controllerState);
        expect(tui.state.activityContainer.render(80).join('\n')).toContain('C:/export/result.md');
      } finally {
        vi.useRealTimers();
      }
    });

    it('resyncFailed has highest priority and cannot be overwritten by showStatus until resync succeeds', () => {
      const { tui, internal, controllerState } = driver();
      const prototype = Object.getPrototypeOf(tui) as {
        showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
      };
      internal.showStatus.mockImplementation(
        (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
          prototype.showStatus.call(tui, message, options);
        },
      );
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

      // Sticky message in place
      internal.showStatus('C:/export/result.md');
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('C:/export/result.md');

      // resyncFailed activates
      controllerState.resyncFailed = true;
      internal.renderActivityState(controllerState);
      const output = tui.state.activityContainer.render(80).join('\n');
      expect(output).toContain('Session resync failed. Run /reload to retry.');

      // Also verify 24 column wrap retains /reload
      const narrow = tui.state.activityContainer.render(24).join('\n');
      expect(narrow).toContain('/reload');

      // Attempting to show status while resyncFailed is active is blocked
      internal.showStatus('Another notice while resync failed');
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Session resync failed. Run /reload to retry.');

      // When resync succeeds, normal activity state is restored
      controllerState.resyncFailed = false;
      controllerState.busy = true;
      internal.renderActivityState(controllerState);
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Working…');
    });

    it('clears source overlay error notice upon self-recovery without deleting unrelated notices', async () => {
      const { tui, internal } = driver();
      const prototype = Object.getPrototypeOf(tui) as {
        showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
      };
      internal.showStatus.mockImplementation(
        (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
          prototype.showStatus.call(tui, message, options);
        },
      );
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

      // 1. Simulate lease heartbeat failure
      internal.sourceOverlayErrorActive = true;
      internal.showStatus('Source overlay lease renewal failed: connection reset', {
        tone: 'error',
        source: 'source-overlay',
      });
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Source overlay lease renewal failed');

      // 2. An unrelated export result replaces the notice
      internal.showStatus('C:/export/result.md');
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('C:/export/result.md');

      // 3. Now ensureSourceOverlayLease succeeds while unrelated notice is active
      internal.client.renewServerLease.mockResolvedValueOnce({
        lease_id: 'lease-recovered',
        expires_at: Date.now() + 60_000,
      });

      await internal.ensureSourceOverlayLease();
      expect(internal.sourceOverlayErrorActive).toBe(false);
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('C:/export/result.md');
      internal.sourceOverlayErrorActive = true;
      internal.showStatus('Attachment upload failed', 'error');
      await internal.ensureSourceOverlayLease();
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Attachment upload failed');

      // 4. Now if lease renewal fails again and recovers with source-overlay notice intact
      internal.sourceOverlayErrorActive = true;
      internal.showStatus('Source overlay lease renewal failed: timeout', {
        tone: 'error',
        source: 'source-overlay',
      });
      expect(tui.state.activityContainer.render(80).join('\n')).toContain('Source overlay lease renewal failed: timeout');

      internal.client.renewServerLease.mockResolvedValueOnce({
        lease_id: 'lease-recovered-2',
        expires_at: Date.now() + 60_000,
      });
      await internal.ensureSourceOverlayLease();
      expect(internal.sourceOverlayErrorActive).toBe(false);
      expect(tui.state.activityContainer.render(80).join('\n')).not.toContain('Source overlay lease renewal failed');
    });

    it('clears timer and status notice on openSession and dispose', async () => {
      const { tui, internal } = driver();
      const prototype = Object.getPrototypeOf(tui) as {
        showStatus(message: string, options?: 'normal' | 'error' | ShowStatusOptions): void;
      };
      internal.showStatus.mockImplementation(
        (message: string, options?: 'normal' | 'error' | ShowStatusOptions) => {
          prototype.showStatus.call(tui, message, options);
        },
      );
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});

      internal.showStatus('Copied the last assistant message.', { transient: true });
      expect(internal.activeStatusNotice).toBeDefined();

      // Switch session clears notice and timer
      await internal.openSession('session-new');
      expect(internal.activeStatusNotice).toBeUndefined();

      // Re-set notice and test dispose
      internal.showStatus('Copied the last assistant message.', { transient: true });
      expect(internal.activeStatusNotice).toBeDefined();

      await tui.close();
      expect(internal.activeStatusNotice).toBeUndefined();
      expect(internal.activityTickTimer).toBeUndefined();
    });

    it('projects current-turn history, streaming and queued changes through the production ticker', async () => {
      vi.useFakeTimers();
      const { tui, internal, controllerState } = driver();
      internal.showStatus.mockImplementation(Object.getPrototypeOf(tui).showStatus.bind(tui));
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const frame = () => tui.state.activityContainer.render(80).join('\n');
      try {
        controllerState.busy = true;
        controllerState.turnStartedAt = now;
        controllerState.blocks = [
          { kind: 'user', id: 'old-u', text: 'old', createdAt: new Date(now - 60_000).toISOString() },
          { kind: 'assistant', id: 'old-a', text: 'old answer', streaming: false, createdAt: new Date(now - 59_000).toISOString() },
          { kind: 'user', id: 'new-u', text: 'new', createdAt: new Date(now).toISOString() },
        ];
        internal.renderActivityState(controllerState);
        vi.advanceTimersByTime(2_999);
        expect(frame()).toContain('Working 2s');
        vi.advanceTimersByTime(1);
        expect(frame()).toContain('Working 3s');
        controllerState.tasks = [{ kind: 'bash', status: 'running' }, { kind: 'subagent', status: 'running' }];
        vi.advanceTimersByTime(15_000);
        expect(frame()).toContain('Working 18s · 2 tasks running · Esc to interrupt');
        const narrow = tui.state.activityContainer.render(24);
        expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
        expect(narrow.join(' ')).toContain('Working 18s');

        const answer = { kind: 'assistant', id: 'new-a', text: 'Hello', streaming: true, createdAt: new Date(now + 18_000).toISOString() };
        controllerState.blocks.push(answer);
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('last response 1s ago');
        expect(frame()).not.toContain('waited');
        answer.text = 'Hello world';
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('last response 0s ago');
        controllerState.queuedPromptIds = ['queued-p'];
        controllerState.blocks.push({ kind: 'user', id: 'queued-u', promptId: 'queued-p', text: 'next', createdAt: new Date().toISOString() });
        vi.advanceTimersByTime(5_000);
        expect(frame()).toContain('last response 5s ago');
        expect(tui.state.activityContainer.render(120).join('\n').replaceAll(/\s+/g, ' ')).toContain('Ctrl+S steer queued');
        controllerState.blocks.push({ kind: 'tool', id: 'tool-1', status: 'running', progressText: '10%', startedAt: Date.now() });
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('last response 0s ago');
        controllerState.blocks.at(-1)!['progressText'] = '90%';
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('last response 0s ago');

        controllerState.busy = false;
        internal.renderActivityState(controllerState);
        expect(frame().trim()).toBe('');
        expect(internal.activityTickTimer).toBeUndefined();
        controllerState.busy = true;
        controllerState.turnStartedAt = Date.now();
        controllerState.blocks = [{ kind: 'user', id: 'untimed-u', text: 'run' }];
        internal.renderActivityState(controllerState);
        vi.advanceTimersByTime(3_000);
        expect(frame()).toContain('Working 3s');
        controllerState.blocks.push({ kind: 'subagent', id: 'untimed-sa', status: 'running', toolCallCount: 0 });
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('Working 4s · 2 tasks running');
        expect(frame()).not.toContain('last response');
        const closing = tui.close();
        await vi.advanceTimersByTimeAsync(1_000);
        await closing;
        expect(internal.activityTickTimer).toBeUndefined();
      } finally {
        internal.clearActivityTickTimer();
        internal.clearStatusNotice();
        vi.useRealTimers();
      }
    });

    it('keeps notices readable on ticks but yields to new work and recovery, including direct resync failures', () => {
      vi.useFakeTimers();
      const { tui, internal, controllerState } = driver();
      internal.showStatus.mockImplementation(Object.getPrototypeOf(tui).showStatus.bind(tui));
      vi.spyOn(tui.state.ui, 'requestRender').mockImplementation(() => {});
      vi.setSystemTime(1_700_000_000_000);
      const frame = () => tui.state.activityContainer.render(80).join('\n');
      try {
        internal.showStatus('https://example.test/result');
        internal.renderActivityState(controllerState);
        expect(frame()).toContain('https://example.test/result');
        controllerState.busy = true;
        controllerState.turnStartedAt = Date.now();
        internal.renderActivityState(controllerState);
        expect(frame()).toContain('Working 0s');
        internal.showStatus('Export: C:/export/result.md');
        vi.advanceTimersByTime(4_000);
        expect(frame()).toContain('C:/export/result.md');
        internal.showStatus('Upload failed', 'error');
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('Upload failed');
        controllerState.turnRetry = { failedAttempt: 1, maxAttempts: 3, delayMs: 400 };
        vi.advanceTimersByTime(1_000);
        expect(frame()).toContain('Retrying (attempt 2 of 3) in 1s');
        expect(internal.activityTickTimer).toBeUndefined();
        controllerState.resyncing = true;
        internal.renderActivityState(controllerState);
        expect(frame()).toContain('Resyncing session');
        controllerState.resyncFailed = true;
        internal.showStatus('Must not hide /reload');
        expect(frame()).toContain('Session resync failed. Run /reload to retry.');
        internal.showStatus('Another error', 'error');
        expect(frame()).toContain('Session resync failed. Run /reload to retry.');
      } finally {
        internal.clearActivityTickTimer();
        internal.clearStatusNotice();
        vi.useRealTimers();
      }
    });
  });

  describe('busy_submit, steering shortcuts, SGR mouse routing, and clean panels', () => {
    it('steers on plain Enter by default when busy while Alt+Enter and /queue queue for the next turn', async () => {
      const { tui, internal, controller, controllerState } = driver();
      controllerState.busy = true;

      // Default busySubmit === 'send_now': plain Enter steers immediately.
      tui.state.editor.setText('steer into active turn');
      tui.state.editor.handleInput('\r');
      await vi.waitFor(() =>
        expect(controller.sendPromptNow).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'steer into active turn' }),
        ),
      );
      expect(controller.sendPrompt).not.toHaveBeenCalled();

      // Alt+Enter explicitly queues even when busySubmit === 'send_now'.
      tui.state.editor.setText('queue for next turn');
      tui.state.editor.handleInput('\u001B\r');
      await vi.waitFor(() =>
        expect(controller.sendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'queue for next turn' }),
        ),
      );
      expect(tui.state.editor.getText()).toBe('');

      // /queue <prompt> also queues explicitly.
      await internal.handleSlash('/queue follow up after turn');
      expect(controller.sendPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: 'follow up after turn' }),
      );
    });

    it('queues on plain Enter when busy_submit is queue, while Ctrl+Enter and Ctrl+S always steer immediately', async () => {
      const { tui, controller, controllerState } = driver();
      controllerState.busy = true;
      tui.state.appState.busySubmit = 'queue';

      // Plain Enter queues when busySubmit === 'queue'.
      tui.state.editor.setText('queued via enter');
      tui.state.editor.handleInput('\r');
      await vi.waitFor(() =>
        expect(controller.sendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'queued via enter' }),
        ),
      );
      expect(controller.sendPromptNow).not.toHaveBeenCalled();

      // Ctrl+Enter (CSI-u `\x1b[13;5u`) ALWAYS steers immediately.
      tui.state.editor.setText('steered via ctrl-enter csi-u');
      tui.state.editor.handleInput('\u001B[13;5u');
      await vi.waitFor(() =>
        expect(controller.sendPromptNow).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'steered via ctrl-enter csi-u' }),
        ),
      );
      expect(tui.state.editor.getText()).toBe('');

      // Ctrl+Enter (modifyOtherKeys `\x1b[27;5;13~`) ALSO steers immediately.
      tui.state.editor.setText('steered via ctrl-enter modifyOtherKeys');
      tui.state.editor.handleInput('\u001B[27;5;13~');
      await vi.waitFor(() =>
        expect(controller.sendPromptNow).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'steered via ctrl-enter modifyOtherKeys' }),
        ),
      );
      expect(tui.state.editor.getText()).toBe('');

      // Ctrl+S (`\x13`) ALSO steers immediately.
      tui.state.editor.setText('steered via ctrl-s');
      tui.state.editor.handleInput('\u0013');
      await vi.waitFor(() =>
        expect(controller.sendPromptNow).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'steered via ctrl-s' }),
        ),
      );
      expect(tui.state.editor.getText()).toBe('');
    });

    it('steers the first queued prompt with Ctrl+Enter, Ctrl+S, and Alt+S when the input box is empty', async () => {
      const { tui, controller, controllerState } = driver();
      controllerState.busy = true;

      controllerState.queuedPromptIds = ['queued-1', 'queued-2'];
      tui.state.editor.setText('');
      tui.state.editor.handleInput('\u001B[13;5u');
      await vi.waitFor(() =>
        expect(controller.steerQueued).toHaveBeenCalledWith('queued-1'),
      );

      controllerState.queuedPromptIds = ['queued-2'];
      tui.state.editor.handleInput('\u0013');
      await vi.waitFor(() =>
        expect(controller.steerQueued).toHaveBeenCalledWith('queued-2'),
      );

      controllerState.queuedPromptIds = ['queued-3'];
      tui.state.editor.handleInput('\u001Bs');
      await vi.waitFor(() =>
        expect(controller.steerQueued).toHaveBeenCalledWith('queued-3'),
      );
    });

    it('renders /goal status as a formatted panel without raw JSON and handles empty goals cleanly', async () => {
      const { tui, internal } = driver();
      internal.client.getGoal.mockResolvedValueOnce(null);
      await internal.handleSlash('/goal');
      expect(transcriptText(tui)).toContain('No active goal. Start one with /goal <objective>.');

      internal.client.getGoal.mockResolvedValueOnce({
        id: 'goal-1',
        status: 'active',
        objective: 'Ship responsive TUI mouse and steering UX',
        completionCriterion: 'All Vitest suites pass with zero raw JSON walls',
        turnsUsed: 4,
        tokensUsed: 48_200,
        wallClockMs: 125_000,
        budget: {
          turnBudget: 12,
          tokenBudget: null,
          wallClockBudgetMs: null,
        },
      });
      await internal.handleSlash('/goal');
      const output = transcriptText(tui, 100);
      expect(output).toContain('Goal · active');
      expect(output).toContain('Ship responsive TUI mouse and steering UX');
      expect(output).toContain('✓ All Vitest suites pass with zero raw JSON walls');
      expect(output).toContain('after 12 turns (4/12)');
      expect(output).not.toContain('"completionCriterion"');
    });

    it('curates bare / autocomplete, hides disabled commands, and fuzzy-matches skills and agents with badges', async () => {
      const { tui, internal } = driver();
      internal.client.listSkills.mockResolvedValue({
        skills: [
          {
            name: 'visual-brief',
            description: 'Create visual briefings',
            source: 'user',
          },
        ],
      });
      await internal.refreshSkillCommands('session-1');
      await internal.refreshAgentCommands();

      const provider = (tui.state.editor as unknown as {
        autocompleteProvider: {
          getSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            options: { signal: AbortSignal; force?: boolean },
          ): Promise<{ items: Array<{ value: string; label: string; description?: string }> } | null>;
        };
      }).autocompleteProvider;
      const ac = new AbortController();

      // Bare `/` returns curated primary workflow commands and excludes disabled commands.
      const bare = await provider.getSuggestions(['/'], 0, 1, { signal: ac.signal });
      expect(bare).not.toBeNull();
      expect(bare!.items.length).toBeGreaterThanOrEqual(15);
      expect(bare!.items.length).toBeLessThanOrEqual(20);
      const bareValues = bare!.items.map((item) => item.value);
      expect(bareValues).toContain('model');
      expect(bareValues).toContain('settings');
      expect(bareValues).not.toContain('add-dir');
      expect(bareValues).not.toContain('export-md');
      expect(bareValues).not.toContain('skill:visual-brief');

      // Typing `/<query>` fuzzy-matches skills and agent profiles with kind badges.
      const skillMatch = await provider.getSuggestions(['/visual'], 0, 7, { signal: ac.signal });
      expect(
        skillMatch?.items.some(
          (item) => item.value === 'visual-brief' && item.description?.includes('[skill]'),
        ),
      ).toBe(true);

      const agentMatch = await provider.getSuggestions(['/review'], 0, 7, { signal: ac.signal });
      expect(agentMatch?.items.some((item) => item.value === 'reviewer' && item.description?.includes('[agent]'))).toBe(true);

      // Explicitly typing a disabled command still intercepts with a clear explanation.
      await internal.handleSlash('/add-dir C:/extra');
      expect(internal.showStatus).toHaveBeenCalledWith(
        expect.stringContaining('/add-dir is not available in the terminal UI'),
        'error',
      );
    });

    it('routes SGR mouse clicks and wheel across transcript blocks, footer pills, settings, and protected approvals, and toggles mouse reporting', async () => {
      vi.useFakeTimers();
      try {
        const { tui, internal, controllerState } = driver();
        const writes: string[] = [];
        let inputHandler: ((data: string) => void) | undefined;
        vi.spyOn(tui.state.terminal, 'columns', 'get').mockReturnValue(100);
        vi.spyOn(tui.state.terminal, 'rows', 'get').mockReturnValue(45);
        vi.spyOn(tui.state.terminal, 'start').mockImplementation((onInput) => {
          inputHandler = onInput;
        });
        vi.spyOn(tui.state.terminal, 'stop').mockImplementation(() => {
          inputHandler = undefined;
        });
        vi.spyOn(tui.state.terminal, 'write').mockImplementation((chunk: string) => {
          writes.push(chunk);
        });

        tui.state.editorContainer.addChild(tui.state.editor);
        tui.state.ui.setFocus(tui.state.editor);
        (internal as unknown as { mountFooter(): void }).mountFooter();
        tui.state.ui.start();

        // Starting TUI with default mouse=true enables SGR mouse reporting (`?1000h?1006h`).
        expect(writes.join('')).toContain('\u001B[?1000h\u001B[?1006h');

        // Render transcript with multi-line Thinking + Bash ToolCall blocks.
        controllerState.blocks = [
          {
            kind: 'thinking',
            id: 'think-1',
            text: Array.from({ length: 10 }, (_, idx) => `Reasoning step ${String(idx + 1)}`).join('\n'),
            streaming: false,
          },
          {
            kind: 'tool',
            id: 'tool-1',
            toolCallId: 'call-1',
            name: 'Bash',
            args: { command: 'pnpm test' },
            argsText: '{"command":"pnpm test"}',
            status: 'done',
            output: Array.from({ length: 20 }, (_, idx) => `output line ${String(idx + 1)}`).join('\n'),
          },
        ];
        internal.renderSession(controllerState);
        tui.state.ui.renderNow(true);

        const strip = (s: string) => s.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').replaceAll(/\u001B\]8;;.*?\u0007/g, '');
        const getFrameLines = () => {
          const state = (tui.state.ui as unknown as {
            captureRenderState(): { previousLines: string[]; previousViewportTop: number };
          }).captureRenderState();
          const all = state.previousLines.map(strip);
          return all.length > 45 ? all.slice(state.previousViewportTop) : all;
        };

        let lines = getFrameLines();
        const thinkingRow = lines.findIndex((line) => line.includes('Reasoning step 1'));
        expect(thinkingRow).toBeGreaterThanOrEqual(0);
        expect(lines.some((line) => line.includes('Reasoning step 9'))).toBe(false);
        expect(tui.state.toolOutputExpanded).toBe(false);

        // Left-click Thinking header row (1-indexed SGR col=5, row=thinkingRow+1) expands ONLY that block!
        inputHandler?.(`\u001B[<0;5;${String(thinkingRow + 1)}M`);
        tui.state.ui.renderNow();
        lines = getFrameLines();
        expect(lines.some((line) => line.includes('Reasoning step 9'))).toBe(true);
        expect(lines.some((line) => line.includes('output line 18'))).toBe(false);
        expect(tui.state.toolOutputExpanded).toBe(false);

        // Global Ctrl+O (`\x0f`) expands both ToolCall and Thinking blocks together.
        inputHandler?.('\u000F');
        tui.state.ui.renderNow();
        lines = getFrameLines();
        expect(tui.state.toolOutputExpanded).toBe(true);
        expect(lines.some((line) => line.includes('output line 18'))).toBe(true);

        // Left-clicking the model pill in the Footer opens the `/model` ChoicePicker.
        const footerRow = lines.findIndex((line) => line.includes('model-a'));
        expect(footerRow).toBeGreaterThanOrEqual(0);
        const modelCol = lines[footerRow]!.indexOf('model-a') + 2; // 1-indexed inside `model-a`
        inputHandler?.(`\u001B[<0;${String(modelCol)};${String(footerRow + 1)}M`);
        await vi.waitFor(() =>
          expect(tui.state.editorContainer.render(100).join('\n')).toContain('Model'),
        );
        expect(tui.state.ui.getFocusedComponent()).not.toBe(tui.state.editor);

        // Outside click above the picker dismisses ChoicePicker back to editor.
        inputHandler?.('\u001B[<0;2;1M');
        expect(tui.state.ui.getFocusedComponent()).toBe(tui.state.editor);

        // Open `/settings` dialog, click `Busy Enter behavior` to toggle to `Queue`, then outside-click to close.
        await internal.handleSlash('/settings');
        tui.state.ui.renderNow();
        lines = getFrameLines();
        const busySettingRow = lines.findIndex((line) => line.includes('Busy Enter behavior'));
        expect(busySettingRow).toBeGreaterThanOrEqual(0);
        expect(tui.state.appState.busySubmit).toBe('send_now');
        inputHandler?.(`\u001B[<0;6;${String(busySettingRow + 1)}M`);
        expect(tui.state.appState.busySubmit).toBe('queue');

        // Wheel down inside `/settings` moves selection without closing.
        inputHandler?.(`\u001B[<65;6;${String(busySettingRow + 1)}M`);
        expect(tui.state.ui.getFocusedComponent()).not.toBe(tui.state.editor);

        // Outside click dismisses `/settings`.
        inputHandler?.('\u001B[<0;2;1M');
        expect(tui.state.ui.getFocusedComponent()).toBe(tui.state.editor);

        // Mount an ApprovalPanel and verify outside click does NOT accidentally dismiss it,
        // while clicking an option after arming resolves the approval.
        const sync = internal as unknown as { syncInteractionBlocks(blocks: unknown[]): void };
        controllerState.busy = true;
        controllerState.blocks = [
          {
            kind: 'approval',
            id: 'approval-mouse',
            request: {
              approval_id: 'approval-mouse',
              session_id: 'session-1',
              tool_call_id: 'tool-mouse',
              tool_name: 'Bash',
              action: 'run command',
              tool_input_display: { kind: 'generic' },
              created_at: '2026-01-01T00:00:00.000Z',
              expires_at: '2026-01-01T00:01:00.000Z',
            },
            resolution: undefined,
          },
        ];
        sync.syncInteractionBlocks(controllerState.blocks);
        tui.state.ui.renderNow();
        const approvalPanel = tui.state.ui.getFocusedComponent();
        expect(approvalPanel).not.toBe(tui.state.editor);

        // Outside click on row 1 must NOT dismiss ApprovalPanel!
        inputHandler?.('\u001B[<0;2;1M');
        expect(tui.state.ui.getFocusedComponent()).toBe(approvalPanel);
        expect(internal.client.resolveApproval).not.toHaveBeenCalled();

        // Advance past arming window and click option 1 inside ApprovalPanel.
        vi.advanceTimersByTime(500);
        tui.state.ui.renderNow();
        lines = getFrameLines();
        const approveRow = lines.findIndex((line) => line.includes('1. Approve once'));
        expect(approveRow).toBeGreaterThanOrEqual(0);
        inputHandler?.(`\u001B[<0;6;${String(approveRow + 1)}M`);
        await vi.waitFor(() =>
          expect(internal.client.resolveApproval).toHaveBeenCalledWith(
            'session-1',
            'approval-mouse',
            expect.objectContaining({ decision: 'approved' }),
          ),
        );

        // Toggle mouse reporting off via Alt+M (`\x1bm`), verifying escape sequence & status, then back on via `/mouse on`.
        writes.length = 0;
        inputHandler?.('\u001Bm');
        expect(tui.state.appState.mouse).toBe(false);
        expect(writes.join('')).toContain('\u001B[?1006l');
        expect(writes.join('')).toContain('\u001B[?1000l');
        expect(internal.showStatus).toHaveBeenCalledWith(
          'Mouse reporting off — drag to select text',
          { transient: true },
        );

        writes.length = 0;
        await internal.handleSlash('/mouse on');
        expect(tui.state.appState.mouse).toBe(true);
        expect(writes.join('')).toContain('\u001B[?1000h\u001B[?1006h');
        expect(internal.showStatus).toHaveBeenCalledWith(
          'Mouse reporting on',
          { transient: true },
        );

        tui.state.ui.stop({ preserveScreen: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

it('reports a definite send-now authentication failure from the busy Enter path', async () => {
  const { tui, controller, controllerState } = driver();
  const status = (tui as unknown as { programStatus: { requireAuth(message: string | undefined): void } }).programStatus;
  const requireAuth = vi.spyOn(status, 'requireAuth');
  controllerState.busy = true;
  controller.sendPromptNow.mockRejectedValueOnce(new SendNowError('submit', new ApiError({ code: 40111, msg: 'Sign in required', data: null })));
  tui.state.editor.onSubmit?.('Continue');
  await vi.waitFor(() => expect(requireAuth).toHaveBeenCalledWith('Sign in required (code 40111)'));
});

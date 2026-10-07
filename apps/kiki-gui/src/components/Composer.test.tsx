// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushInputHistory, readInputHistory, resetInputHistoryForTests, type ComposerAttachment } from '@kiki/session-core/composer';
import { translate } from '@kiki/session-core/i18n';
import { resolveSelectedEffort, writeSettings } from '@kiki/session-core/settings';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter } from '@kiki/transcript';
import { createViewState, projectAgentTranscriptView } from '@kiki/session-core/session';
import { emptySnapshot, userTurnSnapshot } from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import type { HostFileDrop } from '../host';
import { I18nProvider } from '../i18n';
import { API_CODES, ApiError, type NamedAgentProfile } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { PERMISSION_MODES } from '../lib/permissionModes';
import { Composer } from './Composer';
import { activateSkillWithConditionalClear, canAbortActiveTurn } from './SessionView';

const { selectFilesNative, readClipboardFiles, connectionScope, onFileDrop, desktopRuntime, vscodeRuntime, preparePrompt } = vi.hoisted(() => ({
  readClipboardFiles: vi.fn(),
  connectionScope: { id: null as string | null, source: 'desktop' as 'desktop' | 'ssh' | 'remote' | 'manual', url: 'http://127.0.0.1:1234' },
  selectFilesNative: vi.fn(),
  onFileDrop: vi.fn(),
  desktopRuntime: { value: false },
  vscodeRuntime: { value: false },
  preparePrompt: vi.fn(async (content: string, _conversationId?: string) => content),
}));
const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listWorkspaceSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listExecutors = vi.fn();
const getConfig = vi.fn();
const getAgentCapabilities = vi.fn();
const uploadFile = vi.fn();
const meta = vi.fn();
const sshList = vi.fn();
const sshSessionHosts = vi.fn();
const sshAdd = vi.fn();
const sshRemove = vi.fn();
const sshHost = { id: 'example-host', name: 'Example host', source: 'kiki', hostname: 'example.test', agentAccess: 'offered' };
/** The engine catalog the execution panel offers. */
const EXECUTOR_ITEMS = [
  { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready' as const, model_binding: 'mapped' as const, thinking_binding: 'mapped' as const },
  { id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready' as const, version: '2.1.0', model_binding: 'mapped' as const, thinking_binding: 'unavailable' as const, connection: { login_status: 'logged_in' as const, default_args: [] } },
];
/** The native engine with the default main profile: an ordinary new session. */
const NATIVE_AGENT = { executor: 'native', profile: 'agent', overrides: undefined } as const;

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    connectionId: connectionScope.id,
    connectionSource: connectionScope.source,
    scopeId: connectionScope.source,
    config: { url: connectionScope.url },
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills,
      listNamedAgentProfiles,
      listExecutors,
      getConfig,
      getAgentCapabilities,
      uploadFile,
      meta,
      klient: { rest: { ssh: { list: sshList, sessionHosts: sshSessionHosts, addSessionHost: sshAdd, removeSessionHost: sshRemove } } },
    },
  }),
  // The persona chip's face; letter avatars need no connection.
  useOptionalConnection: () => undefined,
}));
vi.mock('../host', () => ({
  useHost: () =>
    desktopRuntime.value
      ? { kind: 'tauri', pickFiles: selectFilesNative, readClipboardFiles, onFileDrop }
      : { kind: 'browser' },
}));
vi.mock('../host/vscode', () => ({
  isVscodeWebview: () => vscodeRuntime.value,
  vscodeHost: { preparePrompt },
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetInputHistoryForTests();
  clearToasts();
  // Keep the existing Enter-path coverage explicit; the default is covered below.
  writeSettings({ sendShortcut: 'enter' });
  listModels.mockReset().mockResolvedValue({
    items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }],
  });
  getAgentCapabilities.mockReset().mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: true,
    profile: { name: 'agent', restrict_models_to_menu: false }, targets: [] });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  listWorkspaceSkills.mockReset().mockResolvedValue({ skills: [] });
  uploadFile.mockReset().mockResolvedValue({ id: 'file-1' });
  meta.mockReset().mockResolvedValue({ experimental_flags: { native_ssh: false } });
  sshList.mockReset().mockResolvedValue({ hosts: [sshHost] });
  sshSessionHosts.mockReset().mockResolvedValue({ hosts: [] });
  sshAdd.mockReset().mockResolvedValue({});
  sshRemove.mockReset().mockResolvedValue({});
  selectFilesNative.mockReset();
  readClipboardFiles.mockReset().mockResolvedValue(null);
  connectionScope.id = null;
  connectionScope.source = 'desktop';
  connectionScope.url = 'http://127.0.0.1:1234';
  onFileDrop.mockReset().mockImplementation((_callback: (drop: HostFileDrop) => void) => () => {});
  desktopRuntime.value = false;
  vscodeRuntime.value = false;
  preparePrompt.mockReset().mockImplementation(async (content: string, _conversationId?: string) => content);
  listNamedAgentProfiles.mockReset().mockResolvedValue({
    items: [
      {
        name: 'agent',
        source: 'builtin',
        main: true,
        disabled: false,
        routes: [],
        description: 'General-purpose built-in agent.',
      },
      {
        name: 'grok-only',
        source: 'user',
        main: true,
        disabled: false,
        routes: [],
        description: 'Grok-only profile.',
      },
      {
        // A main profile on an external engine: it must appear under that
        // engine only, never under the native one.
        name: 'reviewer',
        source: 'workspace',
        main: true,
        disabled: false,
        routes: [],
        executor: 'claude-acp',
        description: 'Reviews changes before they land.',
      },
      { name: 'legacy', source: 'workspace', main: false, disabled: true, routes: [] },
    ] satisfies NamedAgentProfile[],
  });
  listExecutors.mockReset().mockResolvedValue({ items: EXECUTOR_ITEMS });
  getConfig.mockReset().mockResolvedValue({});
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderComposer(
  props: Partial<Parameters<typeof Composer>[0]> = {},
): Promise<{
  container: HTMLDivElement;
  root: Root;
  queryClient: QueryClient;
  rerender: (props: Partial<Parameters<typeof Composer>[0]>) => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (nextProps: Partial<Parameters<typeof Composer>[0]>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              <Composer
                busy={false}
                disabled={false}
                value=""
                onChange={() => {}}
                model={undefined}
                defaultModel={undefined}
                serverDefaultModel="fixture/kiki-pro"
                modelSource="server-default"
                agentProfileCatalogMode={{ mode: 'global' }}
                permissionMode="manual"
                planMode={false}
                goalObjective=""
                efforts={undefined}
                effort={undefined}
                attachments={[]}
                onChangeAttachments={() => {}}
                onChangeModel={() => {}}
                onChangePermissionMode={() => {}}
                onChangePlanMode={() => {}}
                onChangeGoalObjective={() => {}}
                onChangeEffort={() => {}}
                onSend={() => {}}
                {...nextProps}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  await settle();
  await settle();
  return { container, root, queryClient: client, rerender };
}

/** Let react-query promises land and the re-render flush, on a macrotask cadence. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** Click through an element and let the resulting render flush. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * The execution control is a standalone toolbar control — reaching it just
 * means waiting for the profile catalog to land.
 */
async function waitForTrigger(container: HTMLDivElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trigger = container.querySelector<HTMLButtonElement>('#composer-execution-select');
    if (trigger !== null && container.querySelector('[data-selection-diagnostic][role="status"]') === null) return trigger;
    await settle();
  }
  throw new Error('execution control never rendered');
}

/** Open the permission mode chip's panel and hand back its trigger. */
async function openModePanel(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
  await click(trigger);
  return trigger;
}

/** Open the plan chip's panel and hand back its trigger. */
/** Opens ＋ and returns its trigger. */
async function openAddMenu(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-add-menu-trigger]')!;
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger);
  return trigger;
}

/** ＋ → Attach files (the attach action lives in the ＋ menu). */
async function clickAttach(container: HTMLDivElement): Promise<void> {
  await openAddMenu(container);
  await click(container.querySelector<HTMLButtonElement>('[data-attach-button]')!);
}

/** ＋ → Mode ▸ : the run-shape panel (Normal / Plan / Goal + sub-toggles). */
async function openPlanPanel(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = await openAddMenu(container);
  await click(container.querySelector<HTMLButtonElement>('[data-add-menu-mode]')!);
  return trigger;
}

describe('continuation stop control', () => {
  it.each([
    { origin: { kind: 'cron' as const }, promptId: 'p-cron' },
    { origin: { kind: 'other' as const, payload: { kind: 'agent_message', senderAgentId: 'peer' } }, promptId: 'p-mailbox' },
    { origin: { kind: 'other' as const, payload: { kind: 'task_notification' } }, promptId: undefined },
  ])('shows an actionable stop for a running $origin.kind turn with no prompt row', async ({ origin, promptId }) => {
    const running = projectAgentTranscriptView(createViewState('session-1'), 'main', emptySnapshot({
      items: [{ kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin, promptId, steps: [] }],
      prompts: [],
    }));
    expect(running.activePromptId).toBeUndefined();
    const onAbort = vi.fn();
    const { container, rerender } = await renderComposer({ busy: canAbortActiveTurn(running), onAbort });
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop this turn"]');
    expect(stop?.disabled).toBe(false);
    await click(stop!);
    expect(onAbort).toHaveBeenCalledTimes(1);

    const idle = projectAgentTranscriptView(running, 'main', emptySnapshot());
    await rerender({ busy: canAbortActiveTurn(idle), onAbort });
    expect(container.querySelector('button[aria-label="Stop this turn"]')).toBeNull();
  });

  it('keeps the stop control for visible user prompts', async () => {
    const running = projectAgentTranscriptView(createViewState('session-1'), 'main', userTurnSnapshot({ streaming: true }));
    const onAbort = vi.fn();
    const { container } = await renderComposer({ busy: canAbortActiveTurn(running), onAbort });
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop this turn"]');
    expect(stop).not.toBeNull();
    await click(stop!);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe('Composer host compatibility', () => {
  it('renders a new-session composer without Web Crypto randomUUID', async () => {
    const originalCrypto = globalThis.crypto;
    const cryptoWithoutRandomUUID = Object.create(originalCrypto);
    Object.defineProperty(cryptoWithoutRandomUUID, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    vi.stubGlobal('crypto', cryptoWithoutRandomUUID);

    await expect(renderComposer({ sessionId: undefined })).resolves.toBeDefined();
    vi.stubGlobal('crypto', originalCrypto);
  });

  it('defaults to Enter send with Shift+Enter reserved for newlines', async () => {
    localStorage.clear();
    writeSettings({});
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'default shortcut', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await pressKey(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    expect(onSend).toHaveBeenCalledWith('default shortcut', []);
  });

  it('never sends on an Enter that commits an IME candidate', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: '你好', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await pressKey(textarea, { key: 'Enter', isComposing: true });
    await pressKey(textarea, { key: 'Enter', keyCode: 229 });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends into the running turn on Ctrl/Cmd+Enter while busy, and queues on Enter', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ value: 'steer this', busy: true, onSend, onSendNow });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await pressKey(textarea, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(onSendNow).toHaveBeenCalledWith('steer this', []);
    expect(onSend).not.toHaveBeenCalled();
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    expect(onSend).toHaveBeenCalledWith('steer this', []);
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter as a newline under the ⌘/Ctrl+Enter setting', async () => {
    writeSettings({ sendShortcut: 'cmd-enter' });
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ value: 'cmd mode', busy: true, onSend, onSendNow });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    await pressKey(textarea, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(onSend).toHaveBeenCalledWith('cmd mode', []);
    await pressKey(textarea, { key: 'Enter', ctrlKey: true, shiftKey: true });
    await settle();
    expect(onSendNow).toHaveBeenCalledWith('cmd mode', []);
    writeSettings({ sendShortcut: 'enter' });
  });

  it('shows the working line with the latest response age while working', async () => {
    const at = Date.now() - 12_000;
    const { container } = await renderComposer({ value: '', busy: true, working: { lastResponseAt: at } });
    const line = container.querySelector('[data-composer-working]');
    expect(line?.textContent).toContain('Working · last response 12s ago');
    expect(container.querySelector('[data-composer-hints]')).toBeNull();
  });

  it('submits browser prompts synchronously without VS Code preflight state', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'browser prompt', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSend).toHaveBeenCalledWith('browser prompt', []);
    expect(preparePrompt).not.toHaveBeenCalled();
    // The send latch releases once the (void) submit settles a microtask later.
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
  });

  it('sends immediately on Ctrl+Enter even when the send shortcut is plain Enter', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'ctrl enter prompt', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('ctrl enter prompt', []);

    // Shift still wins: Ctrl+Shift+Enter stays a newline, not a send.
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('preserves a new-session key for creation and rotates between resident sessions', async () => {
    vscodeRuntime.value = true;
    const onSend = vi.fn();
    const rendered = await renderComposer({ value: 'new', sessionId: undefined, onSend });
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const newKey = preparePrompt.mock.calls[0]?.[1];

    await rendered.rerender({ value: 'session-a', sessionId: 'session-a', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    await rendered.rerender({ value: 'session-b', sessionId: 'session-b', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    await rendered.rerender({ value: 'new-again', sessionId: undefined, onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const newKeyAfterSession = preparePrompt.mock.calls[3]?.[1];

    await rendered.rerender({ value: 'session-c', sessionId: 'session-c', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(newKey).toMatch(/^vscode-conversation-/);
    expect(newKeyAfterSession).toMatch(/^vscode-conversation-/);
    expect(newKeyAfterSession).not.toBe(newKey);
    expect(newKeyAfterSession).not.toBe('session-b');
    expect(preparePrompt.mock.calls.map((call) => call[1])).toEqual([
      newKey,
      newKey,
      'session-b',
      newKeyAfterSession,
      newKeyAfterSession,
    ]);
  });
});

describe('Composer disable focus continuity', () => {
  async function disableFocusedInput() {
    const harness = await renderComposer();
    const textarea = harness.container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => { textarea.focus(); });
    await harness.rerender({ disabled: true });
    // jsdom neither force-blurs on disable nor lets disabled inputs blur.
    // Model Chromium's BODY fallback and its native blur with disabled=true.
    await act(async () => {
      textarea.disabled = false;
      textarea.blur();
      textarea.disabled = true;
      textarea.dispatchEvent(new FocusEvent('blur'));
    });
    expect(document.activeElement).toBe(document.body);
    return { ...harness, textarea };
  }

  it('restores the same input after a disable-caused blur', async () => {
    const { container, rerender, textarea } = await disableFocusedInput();
    await rerender({ disabled: false });
    expect(container.querySelector('textarea[data-composer]')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it.each([false, true])('does not reclaim focus after the user focuses elsewhere (then blurs=%s)', async (blurAgain) => {
    const { container, rerender } = await disableFocusedInput();
    const button = document.createElement('button');
    container.append(button);
    await act(async () => { button.focus(); if (blurAgain) button.blur(); });
    const active = document.activeElement;
    await rerender({ disabled: false });
    expect(document.activeElement).toBe(active);
  });

  it('does not autofocus a cold input or restore a deliberate enabled blur', async () => {
    const { container, rerender } = await renderComposer();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(document.activeElement).not.toBe(textarea);
    await rerender({ disabled: true });
    await rerender({ disabled: false });
    expect(document.activeElement).not.toBe(textarea);
    await act(async () => { textarea.focus(); textarea.blur(); });
    await rerender({ disabled: true });
    await rerender({ disabled: false });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Composer send latch', () => {
  it('ignores a rapid second trigger while the submission is in flight', async () => {
    const gate = deferred<void>();
    const onSend = vi.fn(() => gate.promise);
    const { container } = await renderComposer({ value: 'double tap', onSend });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(sendButton.disabled).toBe(false);

    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(1);
    // The intent alone disables the button — no waiting for the parent to
    // clear the draft or for `busy` to arrive.
    expect(sendButton.disabled).toBe(true);

    // The rapid second click during the round trip is swallowed.
    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(1);

    // Settling releases the latch, so a deliberate next send goes through.
    await act(async () => { gate.resolve(); });
    await settle();
    expect(sendButton.disabled).toBe(false);
    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('releases the latch for a retry when the submission rejects', async () => {
    const onSend = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('fixture offline')))
      .mockImplementationOnce(() => Promise.resolve());
    const { container } = await renderComposer({ value: 'retry me', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;

    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    await settle();
    expect(sendButton.disabled).toBe(false);

    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});

describe('Composer non-text sends', () => {
  it('enables and sends an annotation-only draft', async () => {
    const onSend = vi.fn();
    const annotations = [{ id: 'annotation-1', quote: 'selected source', comment: 'check this' }];
    const { container } = await renderComposer({ value: '', annotations, onSend });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;

    expect(sendButton.disabled).toBe(false);
    await click(sendButton);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('', []);
  });

  it.each([
    {
      label: 'image',
      attachment: {
        kind: 'image' as const,
        name: 'shot.png',
        mediaType: 'image/png',
        data: 'AA==',
        size: 1,
        previewUrl: 'data:image/png;base64,AA==',
      },
    },
    {
      label: 'file',
      attachment: {
        kind: 'upload' as const,
        name: 'notes.txt',
        mediaType: 'text/plain',
        size: 5,
        fileId: 'file-ready',
      },
    },
  ])('enables and sends a $label-only draft', async ({ attachment }) => {
    const onSend = vi.fn();
    const attachments = [attachment];
    const { container } = await renderComposer({ value: '', attachments, onSend });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;

    expect(sendButton.disabled).toBe(false);
    await click(sendButton);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('', attachments);
  });
});

describe('Composer execution control', () => {
  it.each([undefined, 'saved-session'])('hides unconfigured bare harnesses in the executable picker (%s)', async sessionId => {
    listExecutors.mockResolvedValue({ items: EXECUTOR_ITEMS.map(item => item.id === 'native' ? item : { ...item, connection: { login_status: 'unknown', default_args: [] } }) });
    getConfig.mockResolvedValue({ raw: { agent_executor_overrides: { 'claude-acp': { bin_path: '/opt/claude', defaults: { model_alias: 'fixture/kiki-pro' } } } } });
    const { container } = await renderComposer({ sessionId, execution: NATIVE_AGENT, onChangeExecution: () => {} });
    await click(container.querySelector('#composer-execution-select')!);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).toBeNull();
  });

  it('preserves a bound unavailable engine identity and offers configuration rather than an executable bare entry', async () => {
    listExecutors.mockResolvedValue({ items: EXECUTOR_ITEMS.map(item => item.id === 'native' ? item : { ...item, status: 'unavailable' }) });
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: { executor: 'claude-acp', profile: undefined, overrides: undefined }, onChangeExecution });
    const trigger = container.querySelector('#composer-execution-select')!;
    expect(trigger.textContent).toContain('Claude Code');
    await click(trigger);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).toBeNull();
    expect(container.querySelector('[data-execution-restore="claude-acp"]')?.textContent).toContain('This session still uses it');
    expect(container.querySelector('[data-execution-configure]')).not.toBeNull();
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('keeps the picked persona name on the chip at any toolbar width', async () => {
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
      personaPick: { value: { id: 'lin-lan', name: '林岚' }, onChange: () => {} },
    });
    const chip = container.querySelector('[data-composer-persona-chip="lin-lan"]');
    // The persona branch of the one control: the trigger keeps the face and the
    // name, and the panel behind it is still the engine list.
    const trigger = container.querySelector('#composer-execution-select');
    expect(chip).not.toBeNull();
    expect(trigger?.querySelector('span.truncate')?.textContent).toBe('林岚');
    // No container-query rule may turn the name into a screen-reader-only label.
    expect(chip?.innerHTML).not.toContain('sr-only');
    const clear = container.querySelector('[data-composer-persona-clear]');
    expect(clear?.getAttribute('aria-label')).toBe('Remove persona 林岚');
    await click(trigger!);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).not.toBeNull();
  });

  it('keeps the persona-branch control openable while a turn runs', async () => {
    const { container } = await renderComposer({
      busy: true,
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
      personaPick: { value: { id: 'lin-lan', name: '林岚' }, onChange: () => {} },
    });
    const trigger = await waitForTrigger(container);
    expect(trigger.disabled).toBe(false);
  });

  it('names the native engine as the product and lists only enabled main profiles', async () => {
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
    });
    const trigger = await waitForTrigger(container);
    expect(trigger.textContent).toContain('Kiki');
    expect(trigger.textContent).not.toContain('main');

    await click(trigger);
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    // Each engine offers its own bare row, plus only that engine's enabled
    // main profiles; a disabled or non-main profile never appears.
    expect(container.querySelectorAll('[data-execution-bare]').length).toBe(EXECUTOR_ITEMS.length);
    expect(options.some((text) => text.includes('grok-only'))).toBe(true);
    expect(options.some((text) => text.includes('reviewer'))).toBe(true);
    expect(options.some((text) => text.includes('legacy'))).toBe(false);
    // A profile appears exactly once, under the engine it belongs to.
    expect(options.filter((text) => text.includes('reviewer'))).toHaveLength(1);
    expect(
      container.querySelector('[data-execution-engine="claude-acp"] [data-execution-profile="reviewer"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-execution-engine="native"] [data-execution-profile="reviewer"]'),
    ).toBeNull();
    const nativeRow = [...container.querySelectorAll('[role="option"]')].find(
      (row) => row.textContent?.includes('grok-only'),
    );
    expect(nativeRow?.textContent).toContain('Grok-only profile.');
  });

  it('offers the bare harness under every engine, and it sends no profile', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    const trigger = await waitForTrigger(container);
    await click(trigger);
    // The bare row is the first entry of each engine: it runs the harness as it
    // is, with no Kiki profile invented for it.
    const bareRows = [...container.querySelectorAll<HTMLElement>('[data-execution-bare]')];
    expect(bareRows.length).toBeGreaterThan(0);
    const bareRow = bareRows.find((row) => row.getAttribute('data-execution-bare') === 'claude-acp');
    expect(bareRow?.textContent).toContain('Run this engine as it is');
    await click(bareRow!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'claude-acp', profile: undefined, overrides: undefined,
    });
  });

  it('reports a profile pick with its own engine, so one pick answers both halves', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await click(await waitForTrigger(container));
    const row = container.querySelector<HTMLElement>('[data-execution-profile="reviewer"]');
    expect(row).not.toBeNull();
    await click(row!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'claude-acp', profile: 'reviewer', overrides: undefined,
    });
  });

  it('clears a picked persona when the engine is chosen bare', async () => {
    const onPersona = vi.fn();
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
      personaPick: { value: { id: 'lin-lan', name: '林岚' }, onChange: onPersona },
    });
    // The chip is the persona branch; the engine choice is behind it.
    await click(await waitForTrigger(container));
    const bare = [...container.querySelectorAll<HTMLElement>('[data-execution-bare]')]
      .find((row) => row.getAttribute('data-execution-bare') === 'claude-acp');
    await click(bare!);
    expect(onPersona).toHaveBeenCalledWith(undefined);
  });

  it('shows rebuild context in the ＋ menu and calls it only after confirmation', async () => {
    const onRebuildContext = vi.fn(async () => ({ changed: true }));
    const { container } = await renderComposer({
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
      onRebuildContext,
    });
    await waitForTrigger(container);
    await openAddMenu(container);
    const rebuildRow = container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]');
    expect(rebuildRow?.textContent).toContain('Rebuild context');
    await click(rebuildRow!);
    expect(onRebuildContext).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Conversation messages and history are kept.',
    );
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Rebuild context',
    );
    await click(confirm!);
    await settle();
    expect(onRebuildContext).toHaveBeenCalledOnce();
    expect(getToasts().some((toast) => toast.tone === 'success' && toast.text.includes('latest sources'))).toBe(true);
  });

  it('reports rebuild failures and keeps the execution control openable while busy', async () => {
    const onRebuildContext = vi.fn(async () => { throw new Error('reload failed'); });
    const rendered = await renderComposer({
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
      onRebuildContext,
    });
    await waitForTrigger(rendered.container);
    await openAddMenu(rendered.container);
    await click(rendered.container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]')!);
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Rebuild context',
    );
    await click(confirm!);
    await settle();
    expect(getToasts().some((toast) => toast.tone === 'error' && toast.text.includes('reload failed'))).toBe(true);

    const onChangeWhileBusy = vi.fn();
    await rendered.rerender({
      busy: true,
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: onChangeWhileBusy,
      onRebuildContext,
    });
    // A running turn must not lock the control: it stays browsable, and the
    // tooltip says a pick lands on the next message.
    const trigger = rendered.container.querySelector<HTMLButtonElement>('#composer-execution-select')!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.title).toContain('next message');
    expect(trigger.title).not.toContain('rebuilding context');
    await click(trigger);
    const option = [...rendered.container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes('grok-only'));
    await click(option!);
    expect(onChangeWhileBusy).toHaveBeenCalledWith({
      executor: 'native', profile: 'grok-only', overrides: undefined,
    });
    // Rebuild stays locked: it really does rewrite the live turn's context.
    await openAddMenu(rendered.container);
    expect(rendered.container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]')?.disabled).toBe(true);
  });

  it('hides without a handler but preserves the choice and offers retry when the catalog fails', async () => {
    const { container } = await renderComposer({ agentProfile: 'agent' });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('#composer-execution-select')).toBeNull();

    listNamedAgentProfiles.mockRejectedValue(new Error('catalog offline'));
    const second = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
    });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(second.container.querySelector('#composer-execution-select')?.textContent).toContain('Kiki');
    expect(second.container.querySelector('[data-selection-diagnostic][role="status"]')?.textContent).toContain('catalog offline');
    expect(second.container.querySelector('[data-selection-diagnostic] button')?.textContent).toBe('Retry');
  });

  it('offers only enabled main profiles, preserving an invalid choice with a diagnostic', async () => {
    listNamedAgentProfiles.mockResolvedValue({
      items: [
        { name: 'agent', source: 'builtin', main: true, disabled: true, routes: [] },
        { name: 'reviewer', source: 'workspace', main: false, disabled: false, routes: [] },
      ] satisfies NamedAgentProfile[],
    });
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
    });
    const trigger = await waitForTrigger(container);
    await click(trigger);
    // The installed harness remains independently selectable without a profile.
    expect([...container.querySelectorAll('[data-execution-bare]')].map((row) =>
      (row as HTMLElement).dataset['executionBare'])).toEqual(['native', 'claude-acp']);
    expect(container.querySelectorAll('[data-execution-profile]')).toHaveLength(0);
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('unavailable');
  });

  it('offers a configured external engine even with no usable profile of its own', async () => {
    // The bare-harness row is the "run this engine as it is" choice, and it is
    // exactly what an engine with no Kiki profile still needs. It appears once
    // the machine is actually set up for that engine.
    listNamedAgentProfiles.mockResolvedValue({
      items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] }] satisfies NamedAgentProfile[],
    });
    getConfig.mockResolvedValue({ raw: { agent_executor_overrides: { 'claude-acp': { bin_path: '/usr/local/bin/claude' } } } });
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
    });
    const trigger = await waitForTrigger(container);
    for (let index = 0; index < 3; index += 1) await settle();
    await click(trigger);
    expect([...container.querySelectorAll('[data-execution-bare]')].map((row) =>
      (row as HTMLElement).dataset['executionBare'])).toEqual(['native', 'claude-acp']);
  });

  it('loads workspace main profiles and excludes non-main profiles', async () => {
    listNamedAgentProfiles.mockImplementation(async (workspaceId?: string) => ({
      items: workspaceId === 'wd_alpha'
        ? [
            { name: 'alpha-main', source: 'workspace', main: true, disabled: false, routes: [] },
            { name: 'alpha-helper', source: 'workspace', main: false, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[]
        : [],
    }));
    const { container } = await renderComposer({
      workspaceId: 'wd_alpha',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_alpha' },
      agentProfile: 'alpha-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'alpha-main', overrides: undefined },
      onChangeExecution: () => {},
    });
    const trigger = await waitForTrigger(container);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_alpha');
    await click(trigger);
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options.some((text) => text.includes('alpha-main'))).toBe(true);
    expect(options.some((text) => text.includes('alpha-helper'))).toBe(false);
  });

  it('does not reuse a stale profile catalog when the workspace changes', async () => {
    const workspaceB = deferred<{ items: NamedAgentProfile[] }>();
    listNamedAgentProfiles.mockImplementation((workspaceId?: string) => {
      if (workspaceId === 'wd_alpha') {
        return Promise.resolve({
          items: [
            { name: 'alpha-main', source: 'workspace', main: true, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[],
        });
      }
      if (workspaceId === 'wd_beta') return workspaceB.promise;
      return Promise.resolve({ items: [] });
    });
    const rendered = await renderComposer({
      workspaceId: 'wd_alpha',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_alpha' },
      agentProfile: 'alpha-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'alpha-main', overrides: undefined },
      onChangeExecution: () => {},
    });
    expect((await waitForTrigger(rendered.container)).textContent).toContain('alpha-main');

    await rendered.rerender({
      workspaceId: 'wd_beta',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_beta' },
      agentProfile: 'beta-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'beta-main', overrides: undefined },
      onChangeExecution: () => {},
    });
    await settle();
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_beta');
    expect(rendered.container.querySelector('#composer-execution-select')).not.toBeNull();

    workspaceB.resolve({
      items: [
        { name: 'beta-main', source: 'workspace', main: true, disabled: false, routes: [] },
      ],
    });
    const trigger = await waitForTrigger(rendered.container);
    expect(trigger.textContent).toContain('beta-main');
    await click(trigger);
    const options = [...rendered.container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options.some((text) => text.includes('beta-main'))).toBe(true);
    expect(options.some((text) => text.includes('alpha-main'))).toBe(false);
  });

  it('selects a bound workspace profile when its catalog arrives later', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    listNamedAgentProfiles.mockReturnValue(catalog.promise);
    const rendered = await renderComposer({
      sessionId: 'session-1',
      agentProfileCatalogMode: { mode: 'disabled' },
      agentProfile: 'workspace-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'workspace-main', overrides: undefined },
      onChangeExecution: () => {},
    });
    await settle();
    expect(listNamedAgentProfiles).not.toHaveBeenCalled();
    expect(rendered.container.querySelector('#composer-execution-select')).not.toBeNull();

    await rendered.rerender({
      workspaceId: 'wd_session',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_session' },
      sessionId: 'session-1',
      agentProfile: 'workspace-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'workspace-main', overrides: undefined },
      onChangeExecution: () => {},
    });
    catalog.resolve({
      items: [
        { name: 'workspace-main', source: 'workspace', main: true, disabled: false, routes: [] },
      ],
    });
    const trigger = await waitForTrigger(rendered.container);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_session');
    expect(trigger.textContent).toContain('workspace-main');
    await click(trigger);
    // The late-arriving profile is the selected row, and it lands on its own
    // engine rather than the first one listed.
    const selected = rendered.container.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.getAttribute('data-execution-profile')).toBe('workspace-main');
    expect(selected?.closest('[data-execution-engine]')?.getAttribute('data-execution-engine')).toBe('native');
  });

  it('accents the pill while a switch is pending', async () => {
    const { container } = await renderComposer({
      agentProfile: 'reviewer',
      agentProfilePending: true,
      onChangeAgentProfile: () => {},
      execution: { executor: 'claude-acp', profile: 'reviewer', overrides: undefined },
      onChangeExecution: () => {},
      executionPending: true,
    });
    const trigger = await waitForTrigger(container);
    // A pending switch names the engine/profile and when it applies.
    expect(trigger.textContent).toContain('reviewer · next message');
    expect(trigger.title).toContain('applies from your next message');
  });
});

describe('Composer permission chip', () => {
  const trigger = (container: HTMLDivElement) =>
    container.querySelector<HTMLButtonElement>('[data-mode-select] > button')!;
  const rows = (container: HTMLDivElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-mode-select] [role="option"]')];

  it('shows the current mode and lists every wire mode with its hint', async () => {
    const { container } = await renderComposer({ permissionMode: 'auto' });
    expect(trigger(container).getAttribute('aria-label')).toBe('Approvals');
    expect(trigger(container).textContent).toContain('Auto');
    expect(trigger(container).getAttribute('aria-haspopup')).toBe('listbox');
    expect(rows(container)).toHaveLength(0);

    await click(trigger(container));
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    // Data-driven: one row per offered mode, in display order.
    expect(rows(container).map((row) => row.dataset['permissionMode'])).toEqual(
      PERMISSION_MODES.map((mode) => mode.id),
    );
    expect(rows(container).map((row) => row.textContent ?? '')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Ask every time'),
        expect.stringContaining('Full access'),
      ]),
    );
    const selected = rows(container).find((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected?.dataset['permissionMode']).toBe('auto');
    expect(document.activeElement).toBe(selected);
  });

  it('stays quiet at rest and tints only Full access', async () => {
    const quiet = await renderComposer({ permissionMode: 'manual' });
    expect(trigger(quiet.container).dataset['permissionTone']).toBe('plain');
    const risky = await renderComposer({ permissionMode: 'yolo' });
    expect(trigger(risky.container).dataset['permissionTone']).toBe('danger');
  });

  it('reports picks through onChangePermissionMode and closes the panel', async () => {
    const onChangePermissionMode = vi.fn();
    const { container } = await renderComposer({ permissionMode: 'manual', onChangePermissionMode });
    await click(trigger(container));
    await click(rows(container).find((row) => row.dataset['permissionMode'] === 'yolo')!);
    expect(onChangePermissionMode).toHaveBeenCalledWith('yolo');
    expect(rows(container)).toHaveLength(0);
    expect(document.activeElement).toBe(trigger(container));
  });

  it('closes on Escape without changing the mode', async () => {
    const onChangePermissionMode = vi.fn();
    const { container } = await renderComposer({ permissionMode: 'manual', onChangePermissionMode });
    await click(trigger(container));
    await act(async () => {
      container.querySelector('[data-mode-select]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(rows(container)).toHaveLength(0);
    expect(onChangePermissionMode).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger(container));
  });

  it('closes when a pointerdown lands outside the dropdown', async () => {
    const { container } = await renderComposer({ permissionMode: 'manual' });
    await click(trigger(container));
    await act(async () => {
      // jsdom has no PointerEvent constructor; the listener only reads .target.
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(rows(container)).toHaveLength(0);
  });
});

describe('Composer run mode (Normal / Plan / Goal)', () => {
  const runRow = (container: HTMLDivElement, id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-run-mode-panel] [data-mode-switch="${id}"]`)!;

  it('rests on attach, agent-less model and permission — no mode chip in Normal', async () => {
    listModels.mockResolvedValue({
      items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 128000 }],
    });
    const { container } = await renderComposer();
    for (let index = 0; index < 5; index += 1) await settle();
    const labels = [...container.querySelectorAll<HTMLElement>('[data-composer-toolbar] button')]
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['Add and actions', 'Model', 'Approvals', 'Send message']);
    expect(container.querySelector('[data-run-mode-chip]')).toBeNull();
  });

  it('shows a mode chip only when not Normal, and its ✕ returns to Normal', async () => {
    const onChangePlanMode = vi.fn();
    const { container } = await renderComposer({ planMode: true, onChangePlanMode });
    const chip = container.querySelector<HTMLElement>('[data-run-mode-chip]')!;
    expect(chip.dataset['runModeChip']).toBe('plan');
    expect(chip.textContent).toContain('Plan');
    await click(chip.querySelector<HTMLButtonElement>('button[aria-label="Back to Normal mode"]')!);
    expect(onChangePlanMode).toHaveBeenCalledWith(false);
  });

  it('offers exactly Normal / Plan / Goal — no parallel-subagents switch', async () => {
    const { container } = await renderComposer({ onChangeGoalMode: vi.fn() });
    await openPlanPanel(container);
    const ids = [...container.querySelectorAll<HTMLElement>('[data-run-mode-panel] [data-mode-switch]')]
      .map((row) => row.dataset['modeSwitch']);
    expect(ids).toEqual(['normal', 'plan', 'goal']);
  });

  it('opens the Mode menu with Ctrl+Shift+M from the input', async () => {
    const { container } = await renderComposer();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-run-mode-panel]')).not.toBeNull();
  });

  it('keeps plan and goal mutually exclusive from the Mode panel', async () => {
    const onChangePlanMode = vi.fn();
    const onChangeGoalMode = vi.fn();
    const { container, rerender } = await renderComposer({ onChangePlanMode, onChangeGoalMode });
    await openPlanPanel(container);
    expect(runRow(container, 'normal').getAttribute('aria-checked')).toBe('true');
    await click(runRow(container, 'plan'));
    expect(onChangePlanMode).toHaveBeenLastCalledWith(true);

    // The panel stays open across the parent's echo.
    await rerender({ onChangePlanMode, onChangeGoalMode, planMode: true });
    expect(runRow(container, 'plan').getAttribute('aria-checked')).toBe('true');
    await click(runRow(container, 'goal'));
    // Goal turns plan off and arms goal in one pick.
    expect(onChangePlanMode).toHaveBeenLastCalledWith(false);
    expect(onChangeGoalMode).toHaveBeenLastCalledWith(true);
  });

  it('shows the plan gate only inside Plan and only with a gate handler', async () => {
    const onChangePlanGate = vi.fn();
    const { container } = await renderComposer({ planMode: true, planGate: 'free', onChangePlanGate });
    await openPlanPanel(container);
    const gate = runRow(container, 'planGate');
    expect(gate.getAttribute('aria-checked')).toBe('true');
    await click(gate);
    expect(onChangePlanGate).toHaveBeenCalledWith('gated');

    const normal = await renderComposer({ planGate: 'free', onChangePlanGate });
    await openPlanPanel(normal.container);
    expect(normal.container.querySelector('[data-mode-switch="planGate"]')).toBeNull();

    const bare = await renderComposer({ planMode: true });
    await openPlanPanel(bare.container);
    expect(bare.container.querySelector('[data-mode-switch="planGate"]')).toBeNull();
  });

  it('offers the objective field under Goal in a /new-style draft', async () => {
    const onChangeGoalObjective = vi.fn();
    const { container } = await renderComposer({ onChangeGoalObjective });
    await openPlanPanel(container);
    expect(container.querySelector('[data-goal-objective]')).toBeNull();
    await click(runRow(container, 'goal'));
    const field = container.querySelector<HTMLInputElement>('[data-goal-objective]')!;
    expect(container.querySelector('[data-goal-open]')).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, 'Ship the batch');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChangeGoalObjective).toHaveBeenCalledWith('Ship the batch');
  });

  it('hides the Goal row when no goal path is wired', async () => {
    const { container } = await renderComposer({ onChangeGoalObjective: undefined });
    await openPlanPanel(container);
    expect(container.querySelector('[data-goal-mode-toggle]')).toBeNull();
  });
});

describe('Composer goal mode', () => {
  it('sends `/goal <text>` as a goal prompt instead of opening the panel', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: '/goal ship the batch', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).toHaveBeenCalledWith('ship the batch', [], { goalObjective: 'ship the batch' });
    expect(container.querySelector('[data-run-mode-panel]')).toBeNull();
  });

  it('uses bare `/goal` to arm goal mode and open the Mode panel on it', async () => {
    const onSend = vi.fn();
    const onChangeGoalMode = vi.fn();
    const { container } = await renderComposer({ value: '/goal', onSend, onChangeGoalMode });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    expect(onChangeGoalMode).toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-run-mode-panel]')).not.toBeNull();
  });

  it('arms goal locally for the new-session draft and opens the objective', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: '/goal', onSend, onChangeGoalObjective: vi.fn() });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-goal-objective]')).not.toBeNull();
    expect(container.querySelector('[data-goal-armed]')).not.toBeNull();
  });

  it('arms goal from the Mode panel, flags the next message, and disarms from the chip', async () => {
    const onSend = vi.fn();
    const onChangeGoalMode = vi.fn();
    const { container, rerender } = await renderComposer({ onSend, onChangeGoalMode });
    await openPlanPanel(container);
    const toggle = container.querySelector<HTMLButtonElement>('[data-goal-mode-toggle]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(onChangeGoalMode).toHaveBeenCalledWith(true);

    // The parent owns the flag; rerender with the armed state it would set.
    await rerender({ onSend, onChangeGoalMode, goalMode: true, value: 'fix the flaky suite' });
    expect(container.querySelector('[data-goal-armed]')?.textContent).toContain(
      'this message becomes the objective',
    );
    expect(container.querySelector('[data-run-mode-chip]')?.getAttribute('data-run-mode-chip')).toBe('goal');
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).toHaveBeenCalledWith('fix the flaky suite', [], { goalObjective: 'fix the flaky suite' });

    const disarm = container.querySelector<HTMLButtonElement>('[data-goal-armed] button')!;
    await act(async () => { disarm.click(); });
    expect(onChangeGoalMode).toHaveBeenLastCalledWith(false);
  });

  it('shows no goal chip when no goal-mode handler is wired', async () => {
    const { container } = await renderComposer();
    expect(container.querySelector('[data-goal-armed]')).toBeNull();
    expect(container.querySelector('[data-run-mode-chip]')).toBeNull();
  });

  it('hides the persistent objective field when goal mode owns live-session creation', async () => {
    const { container } = await renderComposer({
      goalMode: true,
      onChangeGoalMode: vi.fn(),
      onChangeGoalObjective: undefined,
    });
    await openPlanPanel(container);
    expect(container.querySelector('[data-goal-objective]')).toBeNull();
  });
});

describe('Composer model chip', () => {
  const catalog = {
    items: [
      {
        id: 'fixture/kiki-pro',
        provider_id: 'fixture',
        remote_id: 'kiki-pro',
        display_name: 'Kiki Pro',
        max_context_size: 128000,
      },
      {
        id: 'fixture/kiki-air',
        provider_id: 'fixture',
        remote_id: 'kiki-air',
        display_name: 'Kiki Air',
        max_context_size: 128000,
      },
    ],
  };

  it('shows the durable AI-created binding rather than the model default before its first turn', async () => {
    listModels.mockResolvedValue(catalog);
    const transcript = new AgentTranscript('main');
    const reducer = new TranscriptFactReducer(transcript);
    reducer.apply(new TranscriptWireAdapter('main').add({
      type: 'profile.bind', modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high',
    }));
    const state = projectAgentTranscriptView(createViewState('created-thread'), 'main', transcript.snapshot());
    const onSend = vi.fn();
    const { container } = await renderComposer({
      model: state.model,
      modelSource: 'session',
      efforts: ['low', 'medium', 'high'],
      effort: resolveSelectedEffort(['low', 'medium', 'high'], state.thinkingEffort, 'medium'),
      value: 'Synthetic continuation',
      onSend,
    });
    expect(container.querySelector('[data-effort-label]')?.textContent).toBe('high');
    await click(container.querySelector('#composer-model-select')!);
    expect(container.querySelector('[data-effort="high"]')?.getAttribute('aria-checked')).toBe('true');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('carries the effort segment outside the truncating model label', async () => {
    listModels.mockResolvedValue(catalog);
    const { container } = await renderComposer({
      model: 'fixture/kiki-pro',
      efforts: ['low', 'high'],
      effort: 'high',
    });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('Kiki Pro');
    expect(trigger.querySelector('[data-effort-label]')?.textContent).toBe('high');
    // The gauge draws the depth: high is the top of two levels, all bars lit.
    expect(trigger.querySelector('[data-effort-gauge]')?.getAttribute('data-effort-gauge')).toBe('3');
    const label = trigger.querySelector('span.truncate')!;
    expect(label.className).toContain('truncate');
    expect(label.textContent).not.toContain('high');
  });

  it('orders displayed thinking effort and gauge without changing the selected value or support array', async () => {
    listModels.mockResolvedValue(catalog);
    const efforts = Object.freeze(['high', 'max', 'low', 'medium', 'xhigh']);
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({ model: 'fixture/kiki-pro', efforts, effort: 'high', onChangeEffort });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.querySelector('[data-effort-gauge]')?.getAttribute('data-effort-gauge')).toBe('2');
    expect(trigger.querySelector('[data-effort-label]')?.textContent).toBe('high');
    await click(trigger);
    expect([...container.querySelectorAll('[data-effort]')].map((node) => node.getAttribute('data-effort')))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(container.querySelector('[data-effort="high"]')?.getAttribute('aria-checked')).toBe('true');
    expect(onChangeEffort).not.toHaveBeenCalled();
    expect(efforts).toEqual(['high', 'max', 'low', 'medium', 'xhigh']);
    await click(container.querySelector('[data-effort="xhigh"]')!);
    expect(onChangeEffort).toHaveBeenCalledExactlyOnceWith('xhigh');
  });

  it('keeps unknown thinking effort values verbatim and selected in the sorted display', async () => {
    listModels.mockResolvedValue(catalog);
    const efforts = Object.freeze(['high', 'Vendor-ULTRA', 'low', 'Vendor-Fast', 'max']);
    const { container } = await renderComposer({ model: 'fixture/kiki-pro', efforts, effort: 'Vendor-ULTRA' });
    await click(container.querySelector('#composer-model-select')!);
    expect([...container.querySelectorAll('[data-effort]')].map((node) => node.getAttribute('data-effort')))
      .toEqual(['low', 'Vendor-ULTRA', 'high', 'Vendor-Fast', 'max']);
    expect(container.querySelector('[data-effort="Vendor-ULTRA"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-effort="Vendor-ULTRA"]')?.textContent).toContain('Vendor-ULTRA');
  });

  it('changes model and effort from the one panel', async () => {
    listModels.mockResolvedValue(catalog);
    const onChangeEffort = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({
      model: 'fixture/kiki-pro',
      efforts: ['low', 'high'],
      effort: 'high',
      onChangeEffort,
      onChangeModel,
    });
    for (let index = 0; index < 5; index += 1) await settle();
    await click(container.querySelector('#composer-model-select')!);
    await click(container.querySelector('[data-effort="low"]')!);
    expect(onChangeEffort).toHaveBeenCalledWith('low');
    const airRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('Kiki Air'),
    )!;
    await click(airRow);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-air');
  });

  it('reports a rejected model pick and keeps the live model on the trigger', async () => {
    listModels.mockResolvedValue(catalog);
    // A bound agent rebinds on the server, so a pick can fail (e.g. a closed
    // child whose persisted binding cannot be restored).
    const onChangeModel = vi.fn(() => Promise.reject(new Error('restore failed')));
    const { container } = await renderComposer({ model: 'fixture/kiki-pro', onChangeModel });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('Kiki Pro');
    await click(trigger);
    const airRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('Kiki Air'),
    )!;
    await click(airRow);
    await settle();
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-air');
    const failure = translate('en', 'subagent.modelChangeFailed', { detail: 'restore failed' });
    expect(getToasts().some((toast) => toast.tone === 'error' && toast.text === failure)).toBe(true);
    // The trigger renders the live value: a rejected pick cannot read as applied.
    expect(container.querySelector('#composer-model-select')!.textContent).toContain('Kiki Pro');
  });

  it('keeps the effort row reachable when the catalog is empty', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({
      efforts: ['low', 'high'],
      effort: 'low',
      onChangeEffort,
    });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('fixture/kiki-pro');
    await click(trigger);
    // No catalog means no filter input and no option list — just the rows.
    expect(container.querySelector('#composer-model-select-list')).toBeNull();
    await click(container.querySelector('[data-effort="high"]')!);
    expect(onChangeEffort).toHaveBeenCalledWith('high');
  });

  it('treats an ambiguous bare alias as available, naming the serving provider', async () => {
    listModels.mockResolvedValue({
      items: [
        {
          id: 'alpha/k3-256k',
          provider_id: 'alpha',
          remote_id: 'k3-256k',
          display_name: 'K3 256K',
          max_context_size: 128000,
        },
        {
          id: 'beta/k3-256k',
          provider_id: 'beta',
          remote_id: 'k3-256k',
          display_name: 'K3 256K',
          max_context_size: 128000,
        },
      ],
    });
    const { container } = await renderComposer({ serverDefaultModel: 'k3-256k' });
    for (let index = 0; index < 5; index += 1) await settle();
    // The engine resolves the same alias to the first candidate — not "unavailable".
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('K3 256K');

    await click(trigger);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(rows).toHaveLength(3);
    // The inherit row shows the resolved display name and the serving provider.
    expect(rows[0]?.querySelector('[data-option-label]')?.textContent).toBe('Follow default: K3 256K');
    // The serving provider rides the second line, not the name line.
    expect(rows[0]?.querySelector('[data-option-meta]')?.textContent).toContain('alpha');
    // Catalog rows group by provider.
    const headers = [...container.querySelectorAll('#composer-model-select-list p')].map(
      (node) => node.textContent,
    );
    expect(headers).toContain('alpha');
    expect(headers).toContain('beta');
  });

  it('resolves a bare-alias override onto the first candidate row', async () => {
    listModels.mockResolvedValue({
      items: [
        {
          id: 'alpha/k3-256k',
          provider_id: 'alpha',
          remote_id: 'k3-256k',
          display_name: 'K3 256K',
          max_context_size: 128000,
        },
        {
          id: 'beta/k3-256k',
          provider_id: 'beta',
          remote_id: 'k3-256k',
          display_name: 'K3 256K',
          max_context_size: 128000,
        },
      ],
    });
    const { container } = await renderComposer({ model: 'k3-256k' });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    // The trigger shows the resolved row's display name, not the raw alias.
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('K3 256K');
    expect(trigger.textContent).not.toContain('k3-256k');

    await click(trigger);
    const selected = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.getAttribute('aria-selected') === 'true',
    );
    expect(selected?.textContent).toContain('alpha/k3-256k');
  });

  it('uses runtime-effective capabilities for the vision badge', async () => {
    listModels.mockResolvedValue({
      items: [{
        id: 'vision',
        provider_id: 'openai',
        remote_id: 'gpt-4o',
        display_name: 'GPT-4o',
        max_context_size: 128000,
        capabilities: ['tool_use'],
        effective_capabilities: ['image_in', 'tool_use'],
      }],
    });
    const { container } = await renderComposer({ model: 'vision' });
    for (let index = 0; index < 5; index += 1) await settle();
    await click(container.querySelector('#composer-model-select')!);
    const row = container.querySelector<HTMLButtonElement>('[role="option"][data-option-value="vision"]')!;
    expect([...row.querySelectorAll('[data-option-fact]')].map((node) => node.textContent)).toEqual(['128k']);
  });

  it('shows context, auto-compact and a missing-vision mark, never capability or effort badges', async () => {
    listModels.mockResolvedValue({
      items: [
        {
          id: 'opus',
          provider_id: 'axon',
          remote_id: 'claude-opus-4-1',
          display_name: 'Claude Opus 4.1',
          max_context_size: 1_000_000,
          auto_compact: 800_000,
          capabilities: ['thinking', 'always_thinking', 'image_in', 'tool_use'],
          support_efforts: ['low', 'medium', 'high', 'max'],
          default_effort: 'high',
        },
        {
          id: 'qwen3-coder',
          provider_id: 'openrouter',
          remote_id: 'qwen/qwen3-coder',
          max_context_size: 262_144,
          capabilities: ['tool_use'],
        },
        { id: 'mystery', provider_id: 'openrouter', remote_id: 'mystery', max_context_size: 32_768 },
      ],
    });
    const { container } = await renderComposer({ model: 'opus' });
    for (let index = 0; index < 5; index += 1) await settle();
    await click(container.querySelector('#composer-model-select')!);
    const row = (value: string) =>
      container.querySelector<HTMLButtonElement>(`[role="option"][data-option-value="${value}"]`)!;
    const facts = (value: string) =>
      [...row(value).querySelectorAll('[data-option-fact]')].map((node) => node.textContent);

    expect(facts('opus')).toEqual(['1M', 'auto-compact 800k']);
    expect(row('opus').querySelector('[data-option-meta]')?.textContent).toContain('claude-opus-4-1');
    expect(row('opus').title).toBe('Claude Opus 4.1\nopus → claude-opus-4-1');
    // No display name: the alias is the label and is not repeated in the hint.
    expect(row('qwen3-coder').querySelector('[data-option-label]')?.textContent).toBe('qwen3-coder');
    expect(row('qwen3-coder').querySelector('[data-option-meta]')?.textContent).toContain('qwen/qwen3-coder');
    expect(facts('qwen3-coder')).toEqual(['262k', 'no vision']);
    // No declared capabilities means unknown, not missing.
    expect(facts('mystery')).toEqual(['33k']);
    const panel = container.querySelector('#composer-model-select-list')!.textContent ?? '';
    for (const hidden of ['thinking', 'image_in', 'tool_use', 'medium', 'max']) {
      expect(panel).not.toContain(hidden);
    }
  });
});

describe('Composer attachment button', () => {
  it('routes the browser file input into the attachment pipeline', async () => {
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({ onChangeAttachments });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    const clicked = vi.spyOn(input, 'click');
    await clickAttach(container);
    expect(clicked).toHaveBeenCalled();

    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // An upload stub lands immediately, matching the paste reservation path.
    expect(onChangeAttachments).toHaveBeenCalled();
  });

  it('rejects an oversized desktop pick before reading its contents', async () => {
    desktopRuntime.value = true;
    const read = vi.fn();
    selectFilesNative.mockResolvedValue([
      { name: 'huge.bin', size: 51 * 1024 * 1024, type: '', read },
    ]);
    const { container } = await renderComposer();

    await clickAttach(container);
    await settle();

    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      '"huge.bin" is 51.0 MB — files are capped at 50.0 MB each.',
    );
  });

  it('rejects a desktop pick at the attachment count cap before reading it', async () => {
    desktopRuntime.value = true;
    const read = vi.fn();
    selectFilesNative.mockResolvedValue([
      { name: 'ninth.txt', size: 4, type: 'text/plain', read },
    ]);
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      kind: 'file' as const,
      path: `file-${index}.txt`,
      name: `file-${index}.txt`,
      isDir: false,
    }));
    const { container } = await renderComposer({ attachments });

    await clickAttach(container);
    await settle();

    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain('At most 8 attachments per message.');
  });
});

async function dispatchClipboardPaste(target: Element, files: File[] = [], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } });
  await act(async () => { target.dispatchEvent(event); });
  await settle();
  return event;
}

describe('Composer file clipboard policy', () => {
  it.each(['keyboard', 'menu'])('inserts native large-file paths without upload through %s paste', async (gesture) => {
    desktopRuntime.value = true;
    const path = 'C:\\fixtures\\large report.bin';
    readClipboardFiles.mockResolvedValue({ paths: [path], media: [] });
    Object.assign(navigator, { clipboard: { readText: vi.fn(), writeText: vi.fn(), read: vi.fn() } });
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ onSend });
    await settle();
    const textarea = composerTextarea(container);
    await typeText(textarea, 'review old end');
    textarea.setSelectionRange(7, 10);
    if (gesture === 'keyboard') {
      const file = new File(['not the real contents'], 'large report.bin');
      Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 });
      await dispatchClipboardPaste(textarea, [file]);
    } else {
      await act(async () => { textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      await click(container.querySelector('[data-menu-action="paste"]')!);
      await settle();
      expect(navigator.clipboard.read).not.toHaveBeenCalled();
    }
    expect(textarea.value).toBe(`review "${path}" end`);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith(`review "${path}" end`, []);
  });

  it('never invents a browser file path or uploads an ordinary file, and keeps mixed text', async () => {
    const { container } = await renderStatefulComposer();
    await settle();
    const textarea = composerTextarea(container);
    await dispatchClipboardPaste(textarea, [new File(['private'], 'report.pdf', { type: 'application/pdf' })], 'caption');
    expect(textarea.value).toBe('caption');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('full path');
    expect(container.querySelector<HTMLButtonElement>('[data-send-ready]')!.disabled).toBe(false);
    await click(container.querySelector('[data-attachment-error] button')!);
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it('sends the preserved text despite a rejected file and clears its obsolete error', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ onSend });
    await settle();
    const textarea = composerTextarea(container);
    await dispatchClipboardPaste(textarea, [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })], 'caption');
    expect(container.querySelector('[data-attachment-error]')).not.toBeNull();
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('caption', []);
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
  });

  it('keeps supported images and videos on the attachment path, not ordinary uploads', async () => {
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({ onChangeAttachments });
    await dispatchClipboardPaste(composerTextarea(container), [
      new File(['png'], 'shot.png', { type: 'image/png' }),
      new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }),
      new File(['binary'], 'huge.bin'),
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0]?.[0].name).toBe('clip.mp4');
    expect(onChangeAttachments).toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('full path');
  });

  it('clears a failed attachment on a successful subsequent paste without locking text sends', async () => {
    desktopRuntime.value = true;
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ onSend });
    const textarea = composerTextarea(container);
    await typeText(textarea, 'keep this draft');
    selectFilesNative.mockResolvedValue([{ name: 'huge.bin', size: 60 * 1024 * 1024, type: '', read: vi.fn() }]);
    await clickAttach(container);
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('50.0 MB');
    readClipboardFiles.mockResolvedValue({ paths: ['C:/fixtures/success.txt'], media: [] });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await dispatchClipboardPaste(textarea);
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('keep this draft C:/fixtures/success.txt', []);
  });

  it('preserves ordinary desktop text and path paste while editing a queued prompt', async () => {
    desktopRuntime.value = true;
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'draft', onChange, queueEditing: true });
    const textarea = composerTextarea(container);
    textarea.setSelectionRange(5, 5);
    await dispatchClipboardPaste(textarea, [], ' text');
    expect(onChange).toHaveBeenCalledWith('draft text');
    readClipboardFiles.mockResolvedValue({ paths: ['C:/fixtures/report.txt'], media: [] });
    await dispatchClipboardPaste(textarea);
    expect(onChange).toHaveBeenCalledWith('draft C:/fixtures/report.txt');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it.each(['ssh', 'remote', 'manual'] as const)('inserts original local paths as draft text in a %s workspace without uploading or reading files', async (source) => {
    desktopRuntime.value = true;
    connectionScope.source = source;
    connectionScope.id = source === 'remote' ? 'remote-fixture' : null;
    if (source === 'manual') connectionScope.url = 'https://example.test';
    readClipboardFiles.mockResolvedValue({ paths: ['C:/fixtures/report.pdf'], media: [] });
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'draft', onChange });
    const textarea = composerTextarea(container);
    textarea.setSelectionRange(5, 5);
    await dispatchClipboardPaste(textarea);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('draft C:/fixtures/report.pdf');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(selectFilesNative).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
  });

  it('preserves edits made while the native clipboard read is pending', async () => {
    desktopRuntime.value = true;
    const pending = deferred<{ paths: string[]; media: [] }>();
    readClipboardFiles.mockReturnValue(pending.promise);
    const { container } = await renderStatefulComposer();
    const textarea = composerTextarea(container);
    await dispatchClipboardPaste(textarea);
    await typeText(textarea, 'new draft');
    await act(async () => { pending.resolve({ paths: ['C:/fixtures/report.txt'], media: [] }); });
    expect(textarea.value).toBe('new draft');
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('draft changed');
  });
});

function droppedFile(name: string, path?: string): File {
  const file = new File(['fixture'], name, { type: 'text/plain' });
  if (path !== undefined) Object.defineProperty(file, 'path', { value: path });
  return file;
}

async function dispatchFileDrop(target: Element, files: readonly File[]): Promise<Event> {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'] },
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('Composer file drops', () => {
  it('inserts an absolute path at the live caret without creating an attachment', async () => {
    const onChange = vi.fn();
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({
      value: 'fix this',
      onChange,
      onChangeAttachments,
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    textarea.setSelectionRange(4, 4);

    const event = await dispatchFileDrop(
      textarea,
      [droppedFile('note.txt', 'C:\\work\\note.txt')],
    );

    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('fix C:\\work\\note.txt this');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(onChangeAttachments).not.toHaveBeenCalled();
  });

  it('quotes whitespace paths, preserves drop order, and falls back to a browser file name', async () => {
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: '', onChange });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await dispatchFileDrop(textarea, [
      droppedFile('alpha.txt', 'C:\\my dir\\alpha.txt'),
      droppedFile('build.sh', '/home/example/build.sh'),
      droppedFile('browser-only.txt'),
    ]);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      '"C:\\my dir\\alpha.txt" /home/example/build.sh browser-only.txt',
    );
  });

  it('accepts native desktop drops only when their CSS position lands on the composer', async () => {
    desktopRuntime.value = true;
    let deliver: ((drop: HostFileDrop) => void) | undefined;
    onFileDrop.mockImplementation((callback: (drop: HostFileDrop) => void) => {
      deliver = callback;
      return () => {};
    });
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: '', onChange });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    const card = textarea.closest<HTMLDivElement>('[data-composer-card]')!;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 320,
      bottom: 230,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    expect(deliver).toBeDefined();
    await act(async () => {
      deliver?.({ paths: ['C:\\outside.txt'], position: { x: 10, y: 10 } });
    });
    expect(onChange).not.toHaveBeenCalled();

    textarea.setSelectionRange(0, 0);
    await act(async () => {
      deliver?.({ paths: ['C:\\my dir\\inside.txt'], position: { x: 100, y: 100 } });
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('"C:\\my dir\\inside.txt"');
  });
});

describe('Composer footer hints', () => {
  it('teaches an empty draft and steps aside once typing starts', async () => {
    const empty = await renderComposer({ value: '' });
    expect(empty.container.querySelector('[data-composer-hints]')).not.toBeNull();

    const typed = await renderComposer({ value: 'hello' });
    expect(typed.container.querySelector('[data-composer-hints]')).toBeNull();

    const working = await renderComposer({ value: '', busy: true });
    expect(working.container.querySelector('[data-composer-hints]')).toBeNull();
  });

  it('keeps the context meter inside the card whether the hints show or not', async () => {
    const contextUsage = { used: 1000, limit: 10_000 };
    const empty = await renderComposer({ value: '', contextUsage });
    const typed = await renderComposer({ value: 'hello', contextUsage });
    for (const { container } of [empty, typed]) {
      const meter = container.querySelector('[data-context-meter]');
      expect(meter?.closest('[data-composer-card]')).not.toBeNull();
      // Hints live outside the card, so they can never displace the meter.
      expect(container.querySelector('[data-composer-card] [data-composer-hints]')).toBeNull();
    }
  });
});

describe('Composer sendDisabled', () => {
  it('blocks the send button without locking the textarea', async () => {
    const { container } = await renderComposer({ value: 'hello', sendDisabled: true });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(textarea?.disabled).toBe(false);
    expect(sendButton?.disabled).toBe(true);
  });

  it('explains the blocked send through the button tooltip', async () => {
    const { container } = await renderComposer({
      value: 'hello',
      sendDisabled: true,
      sendDisabledTitle: 'Pick a workspace first',
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(true);
    expect(sendButton?.getAttribute('title')).toBe('Pick a workspace first');
  });

  it('swallows the send shortcut while sendDisabled', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', sendDisabled: true, onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends on the send shortcut when sendDisabled stays at its default', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });

  it('blocks duplicate Enter while VS Code turn preflight is pending', async () => {
    vscodeRuntime.value = true;
    const pending = deferred<string>();
    preparePrompt.mockReturnValue(pending.promise);
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(preparePrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
    pending.resolve('hello');
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

const workspaceSkill = {
  name: 'review',
  description: 'Review the current diff for risks',
  path: '/skills/review/SKILL.md',
  source: 'project' as const,
};

async function openSlashMenu(container: HTMLDivElement): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await act(async () => {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('Composer slash skill catalog', () => {
  it('loads workspace skills on /new without creating a session', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({
      value: '/',
      workspaceId: 'wd_fixture_0123456789ab',
    });
    for (let index = 0; index < 8; index += 1) await settle();

    expect(listWorkspaceSkills).toHaveBeenCalledWith('wd_fixture_0123456789ab');
    expect(listSessionSkills).not.toHaveBeenCalled();

    await openSlashMenu(container);
    const menu = container.querySelector('[data-composer-menu]');
    expect(menu?.textContent).toContain('/review');
    expect(menu?.textContent).toContain('/plan');
    expect(menu?.textContent).not.toContain('/fork');

    const empty = await renderComposer({ workspaceId: 'wd_fixture_0123456789ab' });
    expect(empty.container.querySelector('[data-composer-hints]')?.textContent).toContain('/ for skills');
  });

  it('reuses a fresh skills catalog when opening the slash menu again', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({ value: '/', workspaceId: 'wd_fixture_0123456789ab' });
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
    await pressKey(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, { key: 'Escape' });
    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
  });

  it('keeps the live session catalog on /s/:id even when a workspace id is also set', async () => {
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({
      value: '/',
      sessionId: 'session_live',
      workspaceId: 'wd_fixture_0123456789ab',
    });
    for (let index = 0; index < 8; index += 1) await settle();

    expect(listSessionSkills).toHaveBeenCalledWith('session_live');
    expect(listWorkspaceSkills).not.toHaveBeenCalled();

    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/fork');
  });

  it('does not fetch skills without a session or workspace', async () => {
    const { container } = await renderComposer();
    for (let index = 0; index < 5; index += 1) await settle();
    expect(listSessionSkills).not.toHaveBeenCalled();
    expect(listWorkspaceSkills).not.toHaveBeenCalled();
    expect(container.querySelector('[data-composer-hints]')?.textContent).toContain('/ for shortcuts');
  });

  it('waits for a pending catalog before sending /kiki-ops without an unknown warning', async () => {
    const catalog = deferred<{ skills: typeof workspaceSkill[] }>();
    listWorkspaceSkills.mockReturnValue(catalog.promise);
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/kiki-ops Explain profiles.',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
    await click(sendButton);
    expect(sendButton.disabled).toBe(true);
    expect(container.querySelector('[data-slash-confirm]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      catalog.resolve({ skills: [{ ...workspaceSkill, name: 'kiki-ops' }] });
    });
    await settle();
    expect(container.querySelector('[data-slash-confirm]')).toBeNull();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('kiki-ops', 'Explain profiles.', [], '/kiki-ops Explain profiles.');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps an unsent slash draft recoverable when its catalog fails, then retries activation', async () => {
    listWorkspaceSkills.mockRejectedValue(new Error('catalog offline'));
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/kiki-ops Help me get started.',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    await click(sendButton);
    await settle();
    expect(container.querySelector('[data-slash-confirm]')).toBeNull();
    expect(container.textContent).toContain('Could not load skills. Please try sending again.');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.value).toBe('/kiki-ops Help me get started.');
    expect(onSend).not.toHaveBeenCalled();
    expect(onActivateSkill).not.toHaveBeenCalled();

    listWorkspaceSkills.mockResolvedValue({ skills: [{ ...workspaceSkill, name: 'kiki-ops' }] });
    await click(sendButton);
    await settle();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('kiki-ops', 'Help me get started.', [], '/kiki-ops Help me get started.');
  });

  it('activates the built-in first-run command for a new directory without a workspace catalog', async () => {
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/kiki-ops Help me get started.',
      onActivateSkill,
      onSend,
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(listWorkspaceSkills).not.toHaveBeenCalled();
    expect(container.querySelector('[data-slash-confirm]')).toBeNull();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('kiki-ops', 'Help me get started.', [], '/kiki-ops Help me get started.');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('selects a command into the draft, shows source and args, and sends its catalog name once', async () => {
    const command = { ...workspaceSkill, name: 'plan', path: '/workspace/.kiki/commands/plan.md',
      prompt_command: true, disable_model_invocation: true, argument_hint: '<topic>' };
    listWorkspaceSkills.mockResolvedValue({ skills: [command] });
    const onChange = vi.fn();
    const onActivateSkill = vi.fn();
    const onChangePlanMode = vi.fn();
    const attachments = [{ kind: 'file' as const, path: '/workspace/note.txt', name: 'note.txt', isDir: false }];
    const rendered = await renderComposer({ value: '/', workspaceId: 'workspace-command',
      onChange, onActivateSkill, onChangePlanMode, attachments });
    await openSlashMenu(rendered.container);
    const row = [...rendered.container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((button) => button.textContent?.includes('/skill:plan'))!;
    expect(row.textContent).toContain('<topic>');
    expect(row.textContent).toContain('project');
    await act(async () => { row.click(); });
    expect(onChange).toHaveBeenLastCalledWith('/skill:plan ');
    expect(onActivateSkill).not.toHaveBeenCalled();
    expect(onChangePlanMode).not.toHaveBeenCalled();
    await rendered.rerender({ value: '/skill:plan menu options', workspaceId: 'workspace-command',
      onChange, onActivateSkill, onChangePlanMode, attachments });
    await act(async () => {
      rendered.container.querySelector('textarea[data-composer]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('plan', 'menu options', attachments, '/skill:plan menu options');
    expect(onChangePlanMode).not.toHaveBeenCalled();
  });

  it('activates a hand-typed `/skill args` draft with VS Code skill preflight', async () => {
    vscodeRuntime.value = true;
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(preparePrompt).toHaveBeenCalledWith('', expect.any(String), false);
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix', [], '/review --fix');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('activates a hand-typed `/skill args` draft on desktop', async () => {
    desktopRuntime.value = true;
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix', [], '/review --fix');
    expect(onSend).not.toHaveBeenCalled();
    expect(preparePrompt).not.toHaveBeenCalled();
  });

  it.each([false, true])('clears the accepted controlled slash draft but preserves new input during preflight: %s', async (edited) => {
    vscodeRuntime.value = true;
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const preflight = deferred<string>();
    preparePrompt.mockReturnValue(preflight.promise);
    const activation = deferred<void>();
    const attachments = [{ kind: 'file' as const, path: '/workspace/note.txt', name: 'note.txt', isDir: false }];
    const submitted = '/review --fix\nKeep the second line.';
    let currentDraft = submitted;
    const clear = vi.fn();
    const onChange = (text: string) => { currentDraft = text; };
    const onActivateSkill = vi.fn((name: string, args: string, sentAttachments: readonly ComposerAttachment[], userInput: string) =>
      activateSkillWithConditionalClear({
        activate: () => activation.promise,
        submitted: { draft: userInput, attachments: sentAttachments },
        current: () => ({ draft: currentDraft, attachments }),
        clear: () => { currentDraft = ''; clear(); },
      }));
    const props = { sessionId: 'session_live', value: submitted, attachments, onChange, onActivateSkill };
    const rendered = await renderComposer(props);
    const send = rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    await click(send);
    await click(send);
    if (edited) {
      currentDraft = 'new follow-up';
      await rendered.rerender({ ...props, value: currentDraft });
    }
    await act(async () => { preflight.resolve(''); });
    await settle();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix\nKeep the second line.', attachments, submitted);
    await act(async () => { activation.resolve(); });
    await settle();
    expect(currentDraft).toBe(edited ? 'new follow-up' : '');
    expect(clear).toHaveBeenCalledTimes(edited ? 0 : 1);
    await rendered.rerender({ ...props, value: currentDraft });
    expect(rendered.container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.value).toBe(currentDraft);
  });

  it('still activates a bare hand-typed `/skill` command', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '', [], '/review');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('preserves the IME preedit value and caret before a slash across catalog rerenders', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onChange = vi.fn();
    const props = { value: '/review tail', workspaceId: 'wd_fixture_0123456789ab', onChange };
    const { container, rerender } = await renderComposer(props);
    await openSlashMenu(container);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    // The browser owns preedit text before the corresponding input/prop update.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'ni/review tail');
    textarea.setSelectionRange(2, 2);
    await rerender(props);
    expect(textarea.value).toBe('ni/review tail');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
    expect(container.querySelector('textarea[data-composer]')).toBe(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '你/review tail');
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }));
    });
    expect(onChange).toHaveBeenLastCalledWith('你/review tail');
    expect(container.querySelector('[data-composer-menu]')).toBeNull();
  });

  it('defers slash recognition and menu keys until compositionend', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: '/rev', workspaceId: 'wd_fixture_0123456789ab', onChange });
    await openSlashMenu(container);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const key of ['Tab', 'Enter', 'Escape', 'ArrowDown']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        textarea.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'ni/rev');
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalledWith('/review ');
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');
    expect(textarea.value).toBe('ni/rev');
    expect(textarea.selectionStart).toBe(2);
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ni' }));
    });
    expect(container.querySelector('[data-composer-menu]')).toBeNull();
  });

  it('lets an open IME composition own Enter instead of accepting a slash row', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onChange = vi.fn();
    const { container } = await renderComposer({
      value: '/rev',
      workspaceId: 'wd_fixture_0123456789ab',
      onChange,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
      );
    });

    // The IME commit key passed through: no token completion, no send, menu open.
    expect(onChange).not.toHaveBeenCalledWith('/review ');
    expect(container.querySelector('[data-composer-menu]')).not.toBeNull();
  });

  it('routes /btw with a question to the side-question handler, never the main send', async () => {
    listSessionSkills.mockResolvedValue({ skills: [] });
    const onSend = vi.fn();
    const onSideQuestion = vi.fn();
    const onChange = vi.fn();
    const { container } = await renderComposer({
      value: '/btw what does --frozen-lockfile do?',
      sessionId: 'session_live',
      onSend,
      onSideQuestion,
      onChange,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSideQuestion).toHaveBeenCalledExactlyOnceWith('what does --frozen-lockfile do?');
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('lists /btw only where a side question can be opened', async () => {
    listSessionSkills.mockResolvedValue({ skills: [] });
    const withHandler = await renderComposer({ value: '/', sessionId: 'session_live', onSideQuestion: vi.fn() });
    for (let index = 0; index < 8; index += 1) await settle();
    await openSlashMenu(withHandler.container);
    expect(withHandler.container.querySelector('[data-composer-menu]')?.textContent).toContain('/btw');

    const without = await renderComposer({ value: '/', sessionId: 'session_live' });
    for (let index = 0; index < 8; index += 1) await settle();
    await openSlashMenu(without.container);
    expect(without.container.querySelector('[data-composer-menu]')?.textContent).not.toContain('/btw');
  });

  it('drops /btw with /fork when the external engine refused forking', async () => {
    listSessionSkills.mockResolvedValue({ skills: [] });
    const { container } = await renderComposer({
      value: '/',
      sessionId: 'session_live',
      onSideQuestion: vi.fn(),
      engine: { label: 'Codex', fork: false, images: true },
    });
    for (let index = 0; index < 8; index += 1) await settle();
    await openSlashMenu(container);
    const menu = container.querySelector('[data-composer-menu]')?.textContent ?? '';
    expect(menu).not.toContain('/btw');
    expect(menu).not.toContain('/fork');
  });

  it('sends a slash skill as prompt text when onActivateSkill is omitted', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('/review --fix', []);
  });
});

// ---- C-1/C-2/C-3: history recall, undo/redo, skill preview ----

type ComposerProps = Parameters<typeof Composer>[0];

/**
 * Stateful harness: the real parents (SessionView, /new) own the draft and
 * clear it parent-side after a send — no input event, no undo snapshot. The
 * history/undo tests need exactly that controlled round-trip.
 */
function StatefulHarness({
  onSend,
  ...props
}: Partial<ComposerProps>) {
  const [text, setText] = useState('');
  return (
    <Composer
      busy={false}
      disabled={false}
      model={undefined}
      defaultModel={undefined}
      serverDefaultModel="fixture/kiki-pro"
      modelSource="server-default"
      agentProfileCatalogMode={{ mode: 'global' }}
      permissionMode="manual"
      planMode={false}
      goalObjective=""
      efforts={undefined}
      effort={undefined}
      attachments={[]}
      onChangeAttachments={() => {}}
      onChangeModel={() => {}}
      onChangePermissionMode={() => {}}
      onChangePlanMode={() => {}}
      onChangeGoalObjective={() => {}}
      onChangeEffort={() => {}}
      value={text}
      onChange={setText}
      onSend={(sentText, sentAttachments, sentOptions) => {
        setText('');
        // Keep the spy's arity faithful: plain sends assert on exactly
        // (text, attachments).
        if (sentOptions === undefined) void onSend?.(sentText, sentAttachments);
        else void onSend?.(sentText, sentAttachments, sentOptions);
      }}
      {...props}
    />
  );
}

async function renderStatefulComposer(
  props: Partial<ComposerProps> = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <StatefulHarness {...props} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

function composerTextarea(container: HTMLDivElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
}

/** Set the textarea value through the native setter and fire the input event. */
async function typeText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(
  textarea: HTMLTextAreaElement,
  init: KeyboardEventInit,
): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

/** Flush the requestAnimationFrame caret landings (jsdom rAF runs on a timer). */
async function flushCaret(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('Composer ＋ menu', () => {
  const panelKey = async (container: HTMLDivElement, key: string) => {
    await act(async () => {
      (document.activeElement ?? container.querySelector('[data-add-menu]')!)
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  it('groups Add context above Session and drills in and back by keyboard', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill: vi.fn(),
      onRebuildContext: vi.fn(),
    });
    for (let index = 0; index < 6; index += 1) await settle();
    await openAddMenu(container);
    const groups = [...container.querySelectorAll('[data-add-panel] [role="group"]')].map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Add context', 'Session']);
    expect(document.activeElement?.hasAttribute('data-add-search')).toBe(true);

    // ↓ from the search lands on the first row; walk to Skills and drill in with →.
    await panelKey(container, 'ArrowDown');
    await panelKey(container, 'ArrowDown');
    expect(document.activeElement?.hasAttribute('data-add-menu-skills')).toBe(true);
    await panelKey(container, 'ArrowRight');
    await settle();
    expect(container.querySelector('[data-add-panel="skills"]')).not.toBeNull();
    expect(container.querySelector('[data-add-skill="review"]')).not.toBeNull();
    // Escape inside a drilled view goes back to the root, a second one closes.
    await panelKey(container, 'Escape');
    expect(container.querySelector('[data-add-panel="root"]')).not.toBeNull();
    await panelKey(container, 'Escape');
    expect(container.querySelector('[data-add-panel]')).toBeNull();
  });

  it('inserts a skill as the same /name token and chips it in the tray', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onChange = vi.fn();
    const { container, rerender } = await renderComposer({
      value: 'check the parser',
      onChange,
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill: vi.fn(),
    });
    for (let index = 0; index < 6; index += 1) await settle();
    await openAddMenu(container);
    await click(container.querySelector('[data-add-menu-skills]')!);
    await settle();
    await click(container.querySelector('[data-add-skill="review"]')!);
    expect(onChange).toHaveBeenLastCalledWith('/review check the parser');
    expect(container.querySelector('[data-add-panel]')).toBeNull();

    await rerender({
      value: '/review check the parser',
      onChange,
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill: vi.fn(),
    });
    const chip = container.querySelector('[data-context-tray] [data-skill-chip="review"]');
    expect(chip).not.toBeNull();
    await click(chip!.querySelector('button[aria-label="Remove skill review"]')!);
    expect(onChange).toHaveBeenLastCalledWith('check the parser');
  });

  it('searches files from the root and mentions a hit as the @ chip', async () => {
    const fsSearch = vi.fn().mockResolvedValue([
      { path: 'src/parser.ts', name: 'parser.ts', kind: 'file', score: 1, match_positions: [] },
    ]);
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({ fsSearch, onChangeAttachments, onRebuildContext: vi.fn() });
    await openAddMenu(container);
    const search = container.querySelector<HTMLInputElement>('[data-add-search]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'pars');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(fsSearch).toHaveBeenCalledWith('pars');
    await click(container.querySelector('[data-add-results] [data-add-file="src/parser.ts"]')!);
    expect(onChangeAttachments).toHaveBeenLastCalledWith([
      { kind: 'file', path: 'src/parser.ts', name: 'parser.ts', isDir: false },
    ]);
  });
});

describe('Composer input history', () => {
  it('recalls sent prompts with ArrowUp from an empty draft and walks both ways', async () => {
    pushInputHistory('s_hist', 'first prompt');
    pushInputHistory('s_hist', 'second prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);
    expect(textarea.value).toBe('');

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('second prompt');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first prompt');
    // The oldest entry sticks — no wrap-around.
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first prompt');
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('second prompt');
    // ArrowDown past the newest entry hands the pre-browse draft back.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('');
  });

  it('Escape exits recall and restores the in-progress draft', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'draft in progress');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
    await pressKey(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('draft in progress');
    // A second Escape is not ours anymore (nothing left to restore).
    await pressKey(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('draft in progress');
  });

  it('an edit during recall ends the browse and keeps the edited text', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
    await typeText(textarea, 'older prompt, edited');
    // No longer browsing: ArrowDown is not a recall key now.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('older prompt, edited');
  });

  it('refuses to enter history when the caret sits past the first line', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'line one\nline two');
    // The native setter landed the caret at the end (second line).
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('line one\nline two');
    // A caret on the FIRST line of a non-empty draft still enters history.
    await act(async () => {
      textarea.setSelectionRange(2, 2);
    });
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
  });

  it('records a send and recalls it afterwards', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ sessionId: 's_send', onSend });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'ship it');
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ship it', []);
    expect(readInputHistory('s_send')).toEqual(['ship it']);
    // The harness cleared the draft parent-side; ↑ brings the prompt back.
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('ship it');
    // Consecutive duplicate sends dedupe.
    await pressKey(textarea, { key: 'Enter' });
    expect(readInputHistory('s_send')).toEqual(['ship it']);
  });

  it('keeps ↑/↓ with an open slash menu — recall never intercepts them', async () => {
    pushInputHistory('s_menu', 'older prompt');
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderStatefulComposer({
      sessionId: 's_menu',
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = composerTextarea(container);

    await typeText(textarea, '/');
    await settle();
    const menu = container.querySelector('[data-composer-menu]');
    expect(menu).not.toBeNull();
    const selected = () =>
      [...container.querySelectorAll<HTMLElement>('[data-composer-menu] [role="option"]')]
        .findIndex((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(selected()).toBe(0);
    // The draft is untouched — no recall happened behind the menu.
    expect(textarea.value).toBe('/');
  });

  it('shows the history hint on an empty draft only when history exists', async () => {
    const bare = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(
      bare.container.querySelector('[data-composer-hints]')?.textContent,
    ).not.toContain('history');

    pushInputHistory('s_hint', 'older prompt');
    const seeded = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(seeded.container.querySelector('[data-composer-hints]')?.textContent).toContain(
      '↑ for history',
    );
  });
});

describe('Composer undo/redo', () => {
  it('walks the local stack with caret positions and redo', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_undo' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'hello');
    await typeText(textarea, 'hello world');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('hello');
    await flushCaret();
    expect(textarea.selectionStart).toBe(5);
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('');
    // The stack is empty now — further Ctrl+Z is a no-op.
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('hello');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('hello world');
    await flushCaret();
    expect(textarea.selectionStart).toBe(11);
  });

  it('a fresh edit clears the redo lane', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_redo' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'a');
    await typeText(textarea, 'ab');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('a');
    await typeText(textarea, 'ax');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('ax');
  });

  it('caps the stack at 100 entries', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_cap' });
    const textarea = composerTextarea(container);

    let value = '';
    for (let index = 0; index < 105; index += 1) {
      value += 'x';
      await typeText(textarea, value);
    }
    // 105 pushes, capped at 100: the five oldest snapshots fell off, so the
    // floor is the state before edit #6 — five characters.
    for (let index = 0; index < 100; index += 1) {
      await pressKey(textarea, { key: 'z', ctrlKey: true });
    }
    expect(textarea.value).toBe('xxxxx');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('xxxxx');
  });

  it('snapshots a sent prompt so Ctrl+Z resurrects it', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ sessionId: 's_send_undo', onSend });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'ship it');
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ship it', []);
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('ship it');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('');
  });
});

describe('Composer skill preview card', () => {
  const descSkill = {
    name: 'review',
    description: 'Review the current diff for risks',
    path: '/skills/review/SKILL.md',
    source: 'project' as const,
  };
  const bareSkill = {
    name: 'silent',
    description: '',
    path: '/skills/silent/SKILL.md',
    source: 'user' as const,
  };

  async function openPreviewMenu(container: HTMLDivElement): Promise<HTMLTextAreaElement> {
    const textarea = composerTextarea(container);
    await typeText(textarea, '/');
    for (let index = 0; index < 8; index += 1) await settle();
    expect(container.querySelector('[data-composer-menu]')).not.toBeNull();
    return textarea;
  }

  it('shows the full description for the keyboard-active skill row', async () => {
    listSessionSkills.mockResolvedValue({ skills: [descSkill, bareSkill] });
    const { container } = await renderStatefulComposer({ sessionId: 's_prev' });
    const textarea = await openPreviewMenu(container);

    const preview = container.querySelector('[data-skill-preview]');
    expect(preview?.textContent).toContain('/review');
    expect(preview?.textContent).toContain('Review the current diff for risks');
    expect(preview?.textContent).toContain('/skills/review/SKILL.md');

    // The skill with an empty description degrades to no card…
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
    // …and so do the client shortcut rows.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
    await pressKey(textarea, { key: 'ArrowUp' });
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');
  });

  it('follows the pointer over the keyboard selection and back', async () => {
    listSessionSkills.mockResolvedValue({ skills: [descSkill, bareSkill] });
    const { container } = await renderStatefulComposer({ sessionId: 's_prev_hover' });
    const textarea = await openPreviewMenu(container);

    // Keyboard selection sits on row 0 (review); hover the silent row.
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-composer-menu] [role="option"]')];
    const silentRow = rows.find((row) => row.textContent?.includes('/silent'))!;
    await act(async () => {
      silentRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();

    const reviewRow = rows.find((row) => row.textContent?.includes('/review'))!;
    await act(async () => {
      reviewRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');

    // Leaving the menu returns the preview to the keyboard-active row…
    const menu = container.querySelector('[data-composer-menu]')!;
    await act(async () => {
      menu.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');
    // …which then follows ArrowDown onto the description-less skill: no card.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
  });
});

describe('Composer restored selection diagnostics', () => {
  it('keeps the model selector and provider setup reachable with an empty catalog while preserving the draft', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'Keep this welcome draft.', serverDefaultModel: undefined, onChange });
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('Choose a model');
    await click(trigger);
    expect(container.querySelector('[data-model-configure]')?.textContent).toBe('Connect a provider or add models');
    expect(composerTextarea(container).value).toBe('Keep this welcome draft.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can pick a native model when no default is configured without discarding the welcome draft', async () => {
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ value: 'Keep this welcome draft.', serverDefaultModel: undefined, onChangeModel });
    await click(container.querySelector('#composer-model-select')!);
    await click(container.querySelector('[data-option-value="fixture/kiki-pro"]')!);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-pro');
    expect(composerTextarea(container).value).toBe('Keep this welcome draft.');
  });

  it.each([undefined, 'saved-session'])('sends immediately while catalogs and frozen details are pending (%s)', async (sessionId) => {
    listModels.mockReturnValue(new Promise(() => {}));
    listNamedAgentProfiles.mockReturnValue(new Promise(() => {}));
    getAgentCapabilities.mockReturnValue(new Promise(() => {}));
    const onSend = vi.fn();
    const { container } = await renderComposer({ sessionId, model: 'fixture/kiki-pro', agentProfile: 'agent', value: 'ready now', onSend });
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(button.disabled).toBe(false);
    await click(button);
    expect(onSend).toHaveBeenCalledWith('ready now', []);
  });

  it('keeps a bare external engine sendable without a native model or profile catalog', async () => {
    listModels.mockResolvedValue({ items: [] });
    listNamedAgentProfiles.mockReturnValue(new Promise(() => {}));
    const onSend = vi.fn();
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ value: 'hello', model: 'vendor-only', effort: 'vendor-effort', execution: { executor: 'claude-acp', profile: undefined, overrides: undefined }, onChangeExecution, onSend });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(container.querySelector('#composer-engine-model-select')?.textContent).toContain('Follow engine configuration');
  });

  it('accepts an external model ID verbatim without looking it up in the native catalog', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChangeExecution = vi.fn();
    const choice = { executor: 'claude-acp', profile: undefined, overrides: undefined };
    const { container } = await renderComposer({ execution: choice, onChangeExecution });
    await click(container.querySelector('#composer-engine-model-select')!);
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'vendor/model-id');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('[role="option"][title="vendor/model-id"]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ ...choice, overrides: { model: 'vendor/model-id', thinking: undefined } });
    expect(container.querySelector('[role="option"][title="vendor/model-id"]')).toBeNull();
  });

  it('clears explicit external model and thinking overrides when following the engine again', async () => {
    const onChangeExecution = vi.fn();
    const choice = { executor: 'claude-acp', profile: undefined, overrides: { model: 'vendor/model-v1', thinking: 'high' } };
    const { container } = await renderComposer({ execution: choice, onChangeExecution });
    await click(container.querySelector('#composer-engine-model-select')!);
    await click(container.querySelector('[data-option-value=""]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ ...choice, overrides: { model: null, thinking: null } });
  });
  it.each([
    { catalog: 'model', code: API_CODES.TIMEOUT },
    { catalog: 'profile', code: -1 },
  ])('allows sending without a banner when the $catalog catalog has transport error $code', async ({ catalog, code }) => {
    const failure = new ApiError({ code, msg: 'Connection unavailable', data: null });
    if (catalog === 'model') listModels.mockRejectedValueOnce(failure);
    else listNamedAgentProfiles.mockRejectedValueOnce(failure);
    const onSend = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({
      value: 'preserved prompt',
      model: 'fixture/kiki-pro',
      agentProfile: 'agent',
      onChangeModel,
      onSend,
    });
    expect(catalog === 'model' ? listModels : listNamedAgentProfiles).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
    await pressKey(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('preserved prompt', []);
    expect(onChangeModel).not.toHaveBeenCalled();
  });

  it('retries a timed-out model read in the background and clears the transient failure on success', async () => {
    listModels.mockRejectedValueOnce(new ApiError({ code: API_CODES.TIMEOUT, msg: 'Request timed out', data: null }));
    const { container, queryClient } = await renderComposer({ model: 'fixture/kiki-pro', value: 'hello' });
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryState(['models'])?.status).toBe('success');
    expect(queryClient.getQueryState(['models'])?.error).toBeNull();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
  });

  it('offers catalog retry without mistaking a failed read for an invalid binding', async () => {
    listModels.mockRejectedValue(new ApiError({ code: API_CODES.REQUEST_INVALID, msg: 'Invalid model config', data: null }));
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    expect(container.querySelector('[data-selection-diagnostic][role="status"]')?.textContent).toContain('Invalid model config');
    expect(container.querySelector('[data-selection-diagnostic] button')?.textContent).toBe('Retry');
    await pressKey(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('keeps a removed model visible, blocks sending, and keeps the input and reselect path usable', async () => {
    const onSend = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ model: 'fixture/deleted', value: 'hello', onSend, onChangeModel });
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('fixture/deleted');
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(input.disabled).toBe(false);
    await pressKey(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await click(container.querySelector('#composer-model-select')!);
    const valid = [...container.querySelectorAll('[role="option"]')].find((node) => node.getAttribute('data-option-value') === 'fixture/kiki-pro')!;
    await click(valid);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-pro');
  });

  it('preserves an incompatible effort without inventing a reset for a model with no default', async () => {
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({ effort: 'high', value: 'hello', onChangeEffort });
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('high');
    expect(container.querySelector('[data-selection-diagnostic] button')).toBeNull();
    expect(onChangeEffort).not.toHaveBeenCalled();
  });
});


describe('Composer queue edit mode', () => {
  function queueEditProps(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
    return {
      queueEditing: true,
      onQueueEditConfirm: vi.fn(async () => {}),
      onQueueEditCancel: vi.fn(),
      onQueueEditRemove: vi.fn(),
      ...overrides,
    };
  }

  it('allows selecting images while editing and confirms an image-only replacement', async () => {
    const onChangeAttachments = vi.fn();
    const props = queueEditProps({ onChangeAttachments });
    const { container, rerender } = await renderComposer({ value: 'queued', ...props });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.disabled).toBe(false);
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'added.png', { type: 'image/png' })], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChangeAttachments).toHaveBeenCalled();
    const image: ComposerAttachment = { kind: 'image', name: 'added.png', mediaType: 'image/png', data: 'cG5n', size: 3, previewUrl: 'data:image/png;base64,cG5n' };
    await rerender({ value: '', attachments: [image], ...props });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm edit"]')!;
    expect(button.disabled).toBe(false);
    await click(button);
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('', [image]);
  });

  it.each(['paste', 'drop'])('adds an image through %s while editing without inserting its filename as text', async (gesture) => {
    const onChangeAttachments = vi.fn();
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'queued', onChange, ...queueEditProps({ onChangeAttachments }) });
    const area = container.querySelector('textarea')!;
    const file = new File(['png'], 'added.png', { type: 'image/png' });
    if (gesture === 'paste') await dispatchClipboardPaste(area, [file]);
    else await dispatchFileDrop(area, [file]);
    expect(onChangeAttachments).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('waits for image reads before confirming an edit', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: 'edited', attachments: [{ kind: 'image', name: 'pending.png', data: '', size: 3, mediaType: 'image/png', previewUrl: '' }], ...props });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm edit"]')!;
    expect(button.disabled).toBe(true);
    await pressKey(container.querySelector('textarea')!, { key: 'Enter' });
    expect(props.onQueueEditConfirm).not.toHaveBeenCalled();
  });

  it('discards a native picker result after cancelling or switching edit ownership', async () => {
    desktopRuntime.value = true;
    const picker = deferred<[{ name: string; size: number; type: string; read: () => Promise<File> }]>();
    const read = vi.fn(async () => new File(['png'], 'late.png', { type: 'image/png' }));
    selectFilesNative.mockReturnValue(picker.promise);
    const onChangeAttachments = vi.fn();
    const props = queueEditProps({ onChangeAttachments, attachmentScopeKey: 'edit-1' });
    const { container, rerender } = await renderComposer({ value: 'same text', ...props });
    await clickAttach(container);
    await rerender({ value: 'same text', ...props, attachmentScopeKey: 'edit-2' });
    await act(async () => { picker.resolve([{ name: 'late.png', size: 3, type: 'image/png', read }]); });
    expect(read).not.toHaveBeenCalled();
    expect(onChangeAttachments).not.toHaveBeenCalled();
  });

  it('discards an image read finishing after its edit is cancelled', async () => {
    desktopRuntime.value = true;
    const contents = deferred<File>();
    selectFilesNative.mockResolvedValue([{ name: 'late.png', size: 3, type: 'image/png', read: () => contents.promise }]);
    const onChangeAttachments = vi.fn();
    const props = queueEditProps({ onChangeAttachments, attachmentScopeKey: 'edit-1' });
    const { container, rerender } = await renderComposer({ value: 'edited', ...props });
    await clickAttach(container);
    await settle();
    expect(onChangeAttachments).toHaveBeenCalledOnce();
    onChangeAttachments.mockClear();
    await rerender({ value: 'parked', onChangeAttachments });
    await act(async () => { contents.resolve(new File(['png'], 'late.png', { type: 'image/png' })); });
    await settle(); await settle();
    expect(onChangeAttachments).not.toHaveBeenCalled();
  });

  it('lets a parked draft image read finish without mutating the active queue edit', async () => {
    desktopRuntime.value = true;
    const contents = deferred<File>();
    selectFilesNative.mockResolvedValue([{ name: 'draft.png', size: 3, type: 'image/png', read: () => contents.promise }]);
    let draftAttachments: readonly ComposerAttachment[] = [];
    const onDraftAttachments = vi.fn((next: readonly ComposerAttachment[] | ((items: readonly ComposerAttachment[]) => readonly ComposerAttachment[])) => {
      draftAttachments = typeof next === 'function' ? next(draftAttachments) : next;
    });
    const onEditAttachments = vi.fn();
    const { container, rerender } = await renderComposer({ value: 'parked', onChangeAttachments: onDraftAttachments });
    await clickAttach(container); await settle();
    await rerender({ value: 'edited', ...queueEditProps({ onChangeAttachments: onEditAttachments, attachmentScopeKey: 'edit-1' }) });
    await act(async () => { contents.resolve(new File(['png'], 'draft.png', { type: 'image/png' })); });
    await settle(); await settle();
    expect(draftAttachments[0]).toMatchObject({ kind: 'image', data: 'cG5n' });
    expect(onEditAttachments).not.toHaveBeenCalled();
  });

  it('submits history edits verbatim without activating commands and keeps Ctrl+Enter semantics', async () => {
    const onSend = vi.fn();
    const onActivateSkill = vi.fn();
    const image: ComposerAttachment = { kind: 'retained', name: 'original.png', content: { type: 'image', source: { kind: 'url', url: 'https://example.test/original.png' } } };
    const { container } = await renderComposer({ value: '/goal edited', messageEditing: true, attachments: [image], onSend, onActivateSkill });
    const area = container.querySelector('textarea')!;
    await pressKey(area, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await pressKey(area, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/goal edited', [image]);
    expect(onActivateSkill).not.toHaveBeenCalled();
  });

  it('routes Enter to the queue edit confirm instead of a fresh send', async () => {
    const onSend = vi.fn();
    const props = queueEditProps({ onSend });
    const { container } = await renderComposer({ value: 'edited queued text', ...props });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm edit"]')!;

    expect(sendButton.disabled).toBe(false);
    await pressKey(textarea, { key: 'Enter' });
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('edited queued text', []);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('skips the slash typo guard while editing a queued message', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: '/not-a-skill at all', ...props });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await pressKey(textarea, { key: 'Enter' });
    // A slash-looking edit is queue text, not a command attempt: no guard.
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('/not-a-skill at all', []);
    expect(container.textContent).not.toContain('Send as plain text');
  });

  it('cancels the edit with Escape and from the banner', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: 'queued text', ...props });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    expect(container.querySelector('[data-queue-edit-banner]')?.textContent).toContain(
      'Editing a queued message',
    );
    await pressKey(textarea, { key: 'Escape' });
    expect(props.onQueueEditCancel).toHaveBeenCalledTimes(1);

    await click(container.querySelector('button[aria-label="Cancel editing"]')!);
    expect(props.onQueueEditCancel).toHaveBeenCalledTimes(2);
  });

  it('turns the stop button into a two-step remove while editing', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: 'queued text', busy: true, onAbort: vi.fn(), ...props });

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove this queued message"]',
    )!;
    // The turn-abort button is parked for the duration of the edit.
    expect(container.querySelector('button[aria-label="Stop this turn"]')).toBeNull();

    await click(removeButton);
    expect(props.onQueueEditRemove).not.toHaveBeenCalled();
    const armed = container.querySelector<HTMLButtonElement>('button[aria-label="Remove?"]')!;
    expect(armed.textContent).toContain('Remove?');

    await click(armed);
    expect(props.onQueueEditRemove).toHaveBeenCalledTimes(1);
  });

  it('latches the confirm while the round trip is in flight', async () => {
    const gate = deferred<void>();
    const props = queueEditProps({ onQueueEditConfirm: vi.fn(() => gate.promise) });
    const { container } = await renderComposer({ value: 'queued text', ...props });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm edit"]')!;

    await click(sendButton);
    expect(props.onQueueEditConfirm).toHaveBeenCalledTimes(1);
    expect(sendButton.disabled).toBe(true);

    await click(sendButton);
    expect(props.onQueueEditConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
    });
    await settle();
    expect(sendButton.disabled).toBe(false);
  });
});


describe('Composer projected profile model menu', () => {
  const menuProfile: NamedAgentProfile = {
    name: 'agent', source: 'user', main: true, disabled: false, routes: [],
    restrict_models_to_menu: true, pinned_model_alias: 'fixture/kiki-pro',
    declared_model_menu: { aliases: ['fixture/kiki-pro'], default_alias: 'fixture/kiki-pro', identities: ['fixture/kiki-pro'] },
    effective_model_aliases: ['fixture/kiki-pro'],
  };
  beforeEach(() => {
    listModels.mockResolvedValue({ items: [
      { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro' },
      { id: 'fixture/outside', provider_id: 'fixture', remote_id: 'outside' },
    ] });
    listNamedAgentProfiles.mockResolvedValue({ items: [menuProfile,
      { ...menuProfile, name: 'outside-profile', pinned_model_alias: 'fixture/outside', effective_model_aliases: ['fixture/outside'] },
    ] });
  });
  it('warns for hard-menu exclusions but lets main users select and send without hiding profiles', async () => {
    const onChangeModel = vi.fn();
    const onSend = vi.fn();
    const props = { agentProfile: 'agent', model: 'fixture/kiki-pro', value: 'hello', onChangeModel, onSend, onChangeAgentProfile: vi.fn(), execution: NATIVE_AGENT, onChangeExecution: vi.fn() };
    const { container, rerender } = await renderComposer(props);
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    expect(container.querySelector('[data-model-menu-warning]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('#composer-model-select')!.click());
    const outside = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes('fixture/outside'))!;
    expect(outside.getAttribute('aria-disabled')).not.toBe('true');
    expect(outside.textContent).toContain('profile:agent.restrict_models_to_menu');
    await act(async () => outside.click());
    expect(onChangeModel).toHaveBeenCalledWith('fixture/outside');
    await rerender({ ...props, model: 'fixture/outside' });
    expect(container.querySelector('[data-model-menu-warning]')?.textContent).toContain('profile:agent.restrict_models_to_menu');
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
    await act(async () => container.querySelector<HTMLButtonElement>('#composer-execution-select')!.click());
    expect([...document.body.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes('outside-profile'))).toBe(true);
  });
  it('does not warn or block main choices outside a recommended menu or stale projection', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ ...menuProfile, restrict_models_to_menu: false,
      model_constraints_active: false, preferred_models: ['fixture/kiki-pro'] }] });
    const onSend = vi.fn();
    const { container } = await renderComposer({ agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-menu-warning]')).toBeNull();
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('#composer-model-select')!.click());
    const outside = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes('fixture/outside'))!;
    expect(outside.getAttribute('aria-disabled')).not.toBe('true');
    expect(outside.textContent).not.toContain('profile:agent');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it.each(['pending', 'failed'])('does not invent a main restriction when capabilities are %s', async (status) => {
    getAgentCapabilities.mockImplementation(() => status === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('Unavailable')));
    const onSend = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it('warns without blocking a main hard allow/deny domain when menu restriction is off', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ ...menuProfile, restrict_models_to_menu: false, model_constraints_active: true,
      deny_models: ['fixture/outside'] }] });
    const onSend = vi.fn();
    const { container } = await renderComposer({ agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-menu-warning]')?.textContent).toContain('profile:agent');
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it('uses the frozen session domain instead of a newer disk declaration', async () => {
    getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: true, targets: [],
      profile: { name: 'agent', restrict_models_to_menu: true, effective_model_aliases: ['fixture/outside'] },
    });
    const onSend = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(getAgentCapabilities).toHaveBeenCalledWith({ session_id: 'saved-session', agent_id: 'main' });
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => container.querySelector<HTMLTextAreaElement>('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
});

describe('Composer send-timing menu', () => {
  const sendButton = (container: HTMLDivElement) =>
    container.querySelector<HTMLButtonElement>('button[data-send-ready]')!;
  const menu = (container: HTMLDivElement) =>
    container.querySelector<HTMLElement>('[data-send-timing-menu]');
  const menuRow = (container: HTMLDivElement, timing: string) =>
    container.querySelector<HTMLButtonElement>(`[data-send-timing="${timing}"]`)!;
  const rowLabels = (container: HTMLDivElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-send-timing-menu] [data-menu-row]')]
      .map((row) => row.textContent);

  /** Hover the send button and wait out the open delay. */
  const hoverOpen = async (container: HTMLDivElement) => {
    await act(async () => {
      container.querySelector('[data-send-timing-root]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  };

  it('stays closed while idle: every timing would start immediately', async () => {
    const { container } = await renderComposer({ busy: false, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    expect(menu(container)).toBeNull();
    await hoverOpen(container);
    expect(menu(container)).toBeNull();
    expect(sendButton(container).getAttribute('aria-haspopup')).toBeNull();
  });

  it('stays closed in queue-edit mode: the button is the edit confirm', async () => {
    const { container } = await renderComposer({
      busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn(),
      queueEditing: true, onQueueEditConfirm: vi.fn(),
    });
    await hoverOpen(container);
    expect(menu(container)).toBeNull();
  });

  it('stays closed where a busy plain send already steers (busySendsNow)', async () => {
    const { container } = await renderComposer({ busy: true, busySendsNow: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await hoverOpen(container);
    expect(menu(container)).toBeNull();
  });

  it('opens on hover while busy and lists the plain send, send-now and both deferred timings', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await hoverOpen(container);
    expect(menu(container)).not.toBeNull();
    expect(menu(container)!.getAttribute('aria-label')).toBe('Send timing');
    expect(rowLabels(container)).toEqual([
      'SendDefault timing: after this turn',
      'Send nowSend into the running turn — read after the current step',
      'Send after subagentsStarts once the running subagents finish',
      'Send after tasksStarts once every running task finishes; resident services excluded',
    ]);
  });

  it('names a non-default configured timing on the plain row', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'tasks_done', onSendNow: vi.fn() });
    await hoverOpen(container);
    expect(rowLabels(container)[0]).toBe('SendDefault timing: after tasks');
  });

  it('omits the send-now row where no steer path is wired', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle' });
    await hoverOpen(container);
    expect(rowLabels(container)).toHaveLength(3);
    expect(container.querySelector('[data-send-timing="now"]')).toBeNull();
  });

  it('plain row sends with the exact two-argument shape (no timing override)', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow });
    await hoverOpen(container);
    await click(menuRow(container, 'default'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toEqual(['hello', []]);
    expect(onSendNow).not.toHaveBeenCalled();
    expect(menu(container)).toBeNull();
  });

  it.each(['subagents_done', 'tasks_done'] as const)('row %s sends once with that appendTiming', async (timing) => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow });
    await hoverOpen(container);
    await click(menuRow(container, timing));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toEqual(['hello', [], { appendTiming: timing }]);
    expect(onSendNow).not.toHaveBeenCalled();
    expect(menu(container)).toBeNull();
  });

  it('send-now row takes the steer path (onSendNow), never the queue', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow });
    await hoverOpen(container);
    await click(menuRow(container, 'now'));
    expect(onSendNow).toHaveBeenCalledTimes(1);
    expect(onSendNow.mock.calls[0]).toEqual(['hello', []]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a one-shot timing pick does not leak into the next plain send', async () => {
    const onSend = vi.fn();
    const { container, rerender } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow: vi.fn() });
    await hoverOpen(container);
    await click(menuRow(container, 'subagents_done'));
    expect(onSend.mock.calls[0]).toEqual(['hello', [], { appendTiming: 'subagents_done' }]);
    // The next send (as if the user typed again) goes out plain.
    await rerender({ busy: true, value: 'again', sendTimingDefault: 'agent_idle', onSend, onSendNow: vi.fn() });
    await click(sendButton(container));
    expect(onSend.mock.calls[1]).toEqual(['again', []]);
  });

  it('opens from the keyboard: ↓ on the button focuses the first row, arrows walk, Escape refocuses the button', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    const button = sendButton(container);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(menu(container)).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(menuRow(container, 'default'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(menuRow(container, 'now'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(menuRow(container, 'default'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu(container)).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('↑ on the button opens the menu focused on the last row', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await act(async () => {
      sendButton(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(document.activeElement).toBe(menuRow(container, 'tasks_done'));
  });

  it('closes on a pointerdown outside and marks the button expanded only while open', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await hoverOpen(container);
    expect(menu(container)).not.toBeNull();
    await act(async () => {
      // jsdom has no PointerEvent constructor; the dismiss path only reads .target.
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(menu(container)).toBeNull();
    expect(sendButton(container).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('session SSH stays resident and rides no message', () => {
  it('preselects on /new without attempting a session join, handing the host to the draft only', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'Inspect the host', onSend });
    await openAddMenu(container);
    expect(container.querySelector('[data-add-menu-ssh]')).not.toBeNull();
    await click(container.querySelector('[data-add-menu-ssh]')!);
    await click(container.querySelector('[data-composer-ssh-host="example-host"]')!);
    expect(sshAdd).not.toHaveBeenCalled();
    expect(sshSessionHosts).not.toHaveBeenCalled();
    // The draft strip and the session strip say the same word: both are this
    // conversation's SSH context, and the scope is what the placement means.
    expect(container.querySelector('[data-composer-ssh-strip]')?.textContent).toContain('SSH');
    expect(container.querySelector('[data-composer-ssh-strip]')?.textContent).not.toContain('to join');
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    await click(container.querySelector('[data-add-menu-trigger]')!);
    await click(container.querySelector('button[aria-label="Send message"]')!);
    // No session exists yet, so the host travels to the draft, which joins it
    // before the first message. It is not an attachment on the draft's tray.
    expect(onSend).toHaveBeenCalledWith('Inspect the host', [{ kind: 'ssh', id: 'example-host', name: 'Example host' }]);
    expect(container.querySelector('[data-context-tray] [data-composer-ssh-chip]')).toBeNull();
    expect(container.querySelector('[data-attachment-chips]')?.textContent ?? '').not.toContain('Example host');
  });

  it('keeps the joined host resident across consecutive sends and a skill, with no ref in any of them', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onActivateSkill = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = await renderComposer({
      sessionId: 'session-example', value: 'Inspect the host', onSend, onActivateSkill,
    });
    expect(container.querySelector('[data-composer-ssh-strip]')?.textContent).toContain('SSH');
    expect(container.querySelector('[data-composer-ssh-strip]')?.textContent).not.toContain('Session');
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    await rerender({ sessionId: 'session-example', value: 'And now the build', onSend, onActivateSkill });
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    await rerender({ sessionId: 'session-example', value: '/review --fix', onSend, onActivateSkill });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend.mock.calls.map((call) => call[1])).toEqual([[], []]);
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix', [], '/review --fix');
    // Still there after all of it, and never removed behind the user's back.
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    expect(container.querySelector('[data-context-tray] [data-composer-ssh-chip]')).toBeNull();
    expect(sshRemove).not.toHaveBeenCalled();
  });

  it('leaves the session immediately and reads the server list back', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect the host', onSend: vi.fn() });
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    sshSessionHosts.mockResolvedValue({ hosts: [] });
    await click(container.querySelector('[data-composer-ssh-chip-remove]')!);
    await settle();
    expect(sshRemove).toHaveBeenCalledWith('session-example', 'example-host');
    // The server's read is the only thing that decides what the strip shows.
    for (let index = 0; index < 4; index += 1) await settle();
    expect(sshSessionHosts.mock.calls.at(-1)).toEqual(['session-example']);
    expect(container.querySelector('[data-composer-ssh-chip]')).toBeNull();
    // The last host leaving takes the whole strip with it: with no SSH context
    // this session is not in, and an "SSH 0" line beside the input would be a
    // control to clear rather than a fact about the session.
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    // The way back in is untouched — the ＋ menu still opens the host list.
    await openAddMenu(container);
    expect(container.querySelector('[data-add-menu-ssh]')).not.toBeNull();
  });

  it('draws no strip at all while this session has no joined host', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend: vi.fn() });
    for (let index = 0; index < 4; index += 1) await settle();
    // The list has been read and it is empty: this is a settled answer, not a
    // load still in flight.
    expect(sshSessionHosts).toHaveBeenCalledWith('session-example');
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    expect(container.querySelector('[data-composer-ssh-toggle]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('SSH 0');
  });

  it('holds the strip back until the session host list is read, rather than showing zero', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    // A list that never resolves: an unread session is not an empty session.
    sshSessionHosts.mockReturnValue(new Promise(() => {}));
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend: vi.fn() });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('SSH 0');
  });

  it('keeps the strip for the host context across a send, not only while a request runs', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend });
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    // The turn is over and nothing is in flight; the host is still joined, so
    // the strip is still the session's SSH context.
    await rerender({ sessionId: 'session-example', value: 'Again', onSend });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(container.querySelector('[data-composer-ssh-strip]')).not.toBeNull();
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
  });

  it('re-reads the joined list when another session opens', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container, rerender } = await renderComposer({ sessionId: 'session-example', value: 'a', onSend: vi.fn() });
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    sshSessionHosts.mockResolvedValue({ hosts: [] });
    await rerender({ sessionId: 'session-other', value: 'a', onSend: vi.fn() });
    await settle();
    expect(sshSessionHosts).toHaveBeenCalledWith('session-other');
    expect(container.querySelector('[data-composer-ssh-chip]')).toBeNull();
  });

  it('opens its own host list from the strip, and closes on Escape', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend: vi.fn() });
    const toggle = container.querySelector('[data-composer-ssh-toggle]')!;
    await click(toggle);
    expect(container.querySelector('[data-composer-ssh-list] [data-composer-ssh-panel]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-composer-ssh-list]')).toBeNull();
  });

  it('resets /new preselection on a session transition, without deleting persistent hosts', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const { container, rerender } = await renderComposer();
    await openAddMenu(container);
    await click(container.querySelector('[data-add-menu-ssh]')!);
    await click(container.querySelector('[data-composer-ssh-host="example-host"]')!);
    expect(container.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    await rerender({ sessionId: 'session-example' });
    await rerender({});
    expect(container.querySelector('[data-composer-ssh-chip]')).toBeNull();
    expect(sshRemove).not.toHaveBeenCalled();
  });

  it('names a queued switch in words above the input and keeps the row chip for wide toolbars', async () => {
    listModels.mockResolvedValue({
      items: [{ id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 }],
    });
    const { container } = await renderComposer({ pendingModelSwitch: { to: 'fixture/kiki-lite', mode: 'fresh' } });
    for (let index = 0; index < 5; index += 1) await settle();
    // The wrapped line names the model the way the picker does, not by its id:
    // at this width the id would be clipped to its vendor.
    const line = container.querySelector<HTMLElement>('[data-model-switch-pending-line="fresh"]')!;
    expect(line.textContent).toContain('Switching to Kiki Lite · Fresh context');
    expect(line.className).toContain('@min-[30rem]/composer:hidden');
    // The toolbar chip owns the opposite side of the same breakpoint, so one of
    // the two is always the thing on screen.
    const chip = container.querySelector<HTMLElement>('[data-model-switch-pending="fresh"]')!;
    expect(chip.textContent).toBe('Switching to Kiki Lite');
    expect(chip.className).toContain('@max-[30rem]/composer:hidden');
  });

  it('names a canonical same-model effort change and its target on both pending surfaces', async () => {
    listModels.mockResolvedValue({ items: [{ id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 }] });
    const { container } = await renderComposer({ pendingModelSwitch: { from: 'fixture/kiki-lite', to: 'kiki-lite', mode: 'direct', originalThinking: 'high', targetThinking: 'max' } });
    for (let index = 0; index < 5; index += 1) await settle();
    const line = container.querySelector<HTMLElement>('[data-model-switch-pending-line]')!;
    const chip = container.querySelector<HTMLElement>('[data-model-switch-pending]')!;
    expect(line.textContent).toContain('Reasoning change → max');
    expect(chip.textContent).toBe('Reasoning change → max');
    expect(line.textContent).not.toContain('Switching to');
  });

  it('shows next-message runtime controls as one cancellable prompt chip', async () => {
    const onCancel = vi.fn();
    const { container } = await renderComposer({
      pendingRuntimeControls: { profile: 'reviewer', model: 'fixture/kiki-lite', thinking: 'max' },
      onCancelRuntimeControls: onCancel,
    });
    const chip = container.querySelector<HTMLElement>('[data-runtime-controls-pending]')!;
    expect(chip.textContent).toContain('reviewer');
    expect(chip.textContent).toContain('fixture/kiki-lite');
    expect(chip.textContent).toContain('max');
    await click(container.querySelector<HTMLButtonElement>('[data-runtime-controls-cancel]')!);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('reports a failed switch-list read next to the input and retries on demand', async () => {
    const onRetry = vi.fn();
    const { container } = await renderComposer({ modelSwitchError: { detail: 'socket closed', onRetry } });
    const line = container.querySelector<HTMLElement>('[data-model-switch-error]')!;
    expect(line.textContent).toContain(translate('en', 'modelSwitch.listFailed'));
    expect(line.querySelector('span')?.getAttribute('title')).toBe('socket closed');
    const retry = line.querySelector<HTMLButtonElement>('button')!;
    expect(retry.textContent).toBe(translate('en', 'common.retry'));
    await act(async () => { retry.click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says nothing about switches when none is queued and the list read is fine', async () => {
    const { container } = await renderComposer();
    expect(container.querySelector('[data-model-switch-pending-line]')).toBeNull();
    expect(container.querySelector('[data-model-switch-error]')).toBeNull();
  });
});

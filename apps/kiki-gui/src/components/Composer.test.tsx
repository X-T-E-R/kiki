// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushInputHistory, readInputHistory, resetInputHistoryForTests, type ComposerAttachment, type ExecutionChoice } from '@kiki/session-core/composer';
import { translate } from '@kiki/session-core/i18n';
import { resolveSelectedEffort, writeSettings } from '@kiki/session-core/settings';
import { AgentTranscript, TranscriptFactReducer, TranscriptWireAdapter } from '@kiki/transcript';
import { createViewState, projectAgentTranscriptView } from '@kiki/session-core/session';
import { emptySnapshot, userTurnSnapshot } from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import type { HostFileDrop } from '../host';
import { I18nProvider } from '../i18n';
import { withPortalQueries } from '../test/portalQuery';
import { API_CODES, ApiError, type NamedAgentProfile } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { PERMISSION_MODES } from '../lib/permissionModes';
import { composerInputOf as registeredComposerInputOf } from '../lib/composerInput';
import { Composer } from './Composer';
import { useComposerWorking, type ComposerWorkingInput, type ComposerWorkingTiming } from './composerWorking';
import { composerInput, setComposerInputValue, type ComposerInputElement } from './composerInputTestUtils';
import { LazyMediaLightbox } from './preview/PreviewLoadBoundary';
import { activateSkillWithConditionalClear, canAbortActiveTurn } from './SessionView';

const { selectFilesNative, selectFilePathNative, readClipboardFiles, connectionScope, onFileDrop, desktopRuntime, vscodeRuntime, preparePrompt } = vi.hoisted(() => ({
  readClipboardFiles: vi.fn(),
  connectionScope: { id: null as string | null, source: 'desktop' as 'desktop' | 'ssh' | 'remote' | 'manual', url: 'http://127.0.0.1:1234', serverId: 'server-a', startedAt: 'generation-one', pluginSlots: false },
  selectFilesNative: vi.fn(),
  selectFilePathNative: vi.fn(),
  onFileDrop: vi.fn(),
  desktopRuntime: { value: false },
  vscodeRuntime: { value: false },
  preparePrompt: vi.fn(async (content: string, _conversationId?: string) => content),
}));
const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listWorkspaceSkills = vi.fn();
const listDraftSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listPersonas = vi.fn();
const previewAgentProfileFile = vi.fn();
const listExecutors = vi.fn();
const getExecutorModels = vi.fn();
const refreshExecutorModels = vi.fn();
const getConfig = vi.fn();
const getAgentCapabilities = vi.fn();
const previewFile = vi.fn();
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
const NATIVE_AGENT = { executor: 'native', profile: 'agent', profile_file: undefined, overrides: undefined } as const;
const EXTERNAL_BARE = { executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined } as const;
const PROFILE_SELECT_PROPS = { agentProfile: 'agent', onChangeAgentProfile: () => {}, execution: NATIVE_AGENT, onChangeExecution: () => {} } as const;

type ComposerProps = Parameters<typeof Composer>[0];

const DEFAULT_COMPOSER_PROPS: ComposerProps = {
  busy: false,
  disabled: false,
  value: '',
  onChange: () => {},
  model: undefined,
  defaultModel: undefined,
  serverDefaultModel: 'fixture/kiki-pro',
  modelSource: 'server-default',
  agentProfileCatalogMode: { mode: 'global' },
  permissionMode: 'manual',
  planMode: false,
  goalObjective: '',
  efforts: undefined,
  effort: undefined,
  attachments: [],
  onChangeAttachments: () => {},
  onChangeModel: () => {},
  onChangePermissionMode: () => {},
  onChangePlanMode: () => {},
  onChangeGoalObjective: () => {},
  onChangeEffort: () => {},
  onSend: () => {},
};

function executorModelsPayload(overrides: {
  source?: string;
  provenance?: string;
  revision?: string;
  apply_state?: string;
  observed_at?: number;
  models?: Record<string, unknown>;
  thinking_levels?: Record<string, unknown>;
  controls?: Record<string, unknown>;
} = {}) {
  const ready = { applicability: 'fresh_binding', apply_state: 'applied' };
  const unsupported = { applicability: 'unsupported', apply_state: 'unsupported' };
  return {
    executor_id: 'claude-acp',
    source: overrides.source ?? 'cli_probe',
    provenance: overrides.provenance ?? 'read_only_cli_probe',
    revision: overrides.revision ?? '1',
    apply_state: overrides.apply_state ?? 'ready',
    observed_at: overrides.observed_at ?? Date.now(),
    effective: {
      models: overrides.models ?? { state: 'ready', values: ['claude/sonnet'] },
      thinking_levels: overrides.thinking_levels ?? { state: 'unknown' },
      context: { state: 'unknown' },
      controls: {
        model_switch: ready,
        thinking_switch: ready,
        manual_compact: unsupported,
        ...overrides.controls,
      },
    },
  };
}

/**
 * A profile file on the connected host: not a registered profile, not a main
 * one, and named only by the path the session would run.
 */
const FILE_PROFILE = {
  name: 'research-writer',
  source: 'explicit',
  main: false,
  disabled: false,
  routes: [],
  executor: 'native',
  source_file: '/work/profiles/research.md',
  description: 'Writes up research.',
} satisfies NamedAgentProfile;

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    connectionId: connectionScope.id,
    connectionSource: connectionScope.source,
    scopeId: connectionScope.source,
    meta: { server_id: connectionScope.serverId, started_at: connectionScope.startedAt },
    config: { url: connectionScope.url },
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills,
      listDraftSkills,
      listNamedAgentProfiles,
      listPersonas,
      previewAgentProfileFile,
      listExecutors,
      getConfig,
      getAgentCapabilities,
      uploadFile,
      meta,
      klient: { rest: { executors: { getModels: getExecutorModels, refreshModels: refreshExecutorModels }, agents: { previewFile }, ssh: { list: sshList, sessionHosts: sshSessionHosts, addSessionHost: sshAdd, removeSessionHost: sshRemove } } },
    },
  }),
  // The picker only needs connection provenance; media surfaces are mocked separately.
  useOptionalConnection: () => (
    connectionScope.pluginSlots
      ? { connectionSource: connectionScope.source, connectionId: connectionScope.id, scopeId: connectionScope.source, config: { url: connectionScope.url, token: '' } }
      : { connectionSource: connectionScope.source }
  ),
}));
vi.mock('../host', () => ({
  useHost: () =>
    desktopRuntime.value
      ? { kind: 'tauri', pickFiles: selectFilesNative, pickFilePath: selectFilePathNative, readClipboardFiles, onFileDrop }
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

beforeAll(async () => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  await LazyMediaLightbox.preload();
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
  previewFile.mockReset();
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  listWorkspaceSkills.mockReset().mockResolvedValue({ skills: [] });
  listDraftSkills.mockReset().mockResolvedValue({ skills: [] });
  uploadFile.mockReset().mockResolvedValue({ id: 'file-1' });
  meta.mockReset().mockResolvedValue({ experimental_flags: { native_ssh: false } });
  sshList.mockReset().mockResolvedValue({ hosts: [sshHost] });
  sshSessionHosts.mockReset().mockResolvedValue({ hosts: [] });
  sshAdd.mockReset().mockResolvedValue({});
  sshRemove.mockReset().mockResolvedValue({});
  selectFilesNative.mockReset();
  selectFilePathNative.mockReset();
  readClipboardFiles.mockReset().mockResolvedValue(null);
  connectionScope.id = null;
  connectionScope.source = 'desktop';
  connectionScope.url = 'http://127.0.0.1:1234';
  connectionScope.serverId = 'server-a';
  connectionScope.startedAt = 'generation-one';
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
        source_file: '/fixture/profiles/grok-only.md',
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
        source_file: '/fixture/profiles/reviewer.md',
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
  listPersonas.mockReset().mockResolvedValue([
    { id: 'xiao-you', name: '小柚', title: '全栈架构师', revision: '1', archived: false },
    { id: 'nia', name: '妮娅', title: '个人管家', revision: '1', archived: false },
  ]);
  previewAgentProfileFile.mockReset().mockResolvedValue({ profile: FILE_PROFILE });
  getExecutorModels.mockReset().mockReturnValue(new Promise(() => {}));
  refreshExecutorModels.mockReset();
  getConfig.mockReset().mockResolvedValue({ raw: { agent_executor_overrides: { 'claude-acp': { show_in_profile_list: true } } } });
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
  const rerender = async (nextProps: Partial<ComposerProps>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              <Composer {...DEFAULT_COMPOSER_PROPS} {...nextProps} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  await settleMany(2);
  const queryable = withPortalQueries(container);
  return { container: queryable, root, queryClient: client, rerender };
}

/** Let react-query promises land and the re-render flush, on a macrotask cadence. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function settleMany(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) await settle();
}

function sendBtn(container: HTMLDivElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
}

function engineModelTrigger(container: HTMLDivElement): HTMLButtonElement {
  return (container.querySelector<HTMLButtonElement>('#composer-engine-model-select')
    ?? container.querySelector<HTMLButtonElement>('#composer-execution-select'))!;
}

function composerInputOf(container: HTMLDivElement): ComposerInputElement {
  return composerInput(container);
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeText(textarea: ComposerInputElement, value: string): Promise<void> {
  await act(async () => {
    setComposerInputValue(textarea, value);
  });
}

async function pressKey(textarea: ComposerInputElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

async function placeCaret(textarea: ComposerInputElement, start: number, end = start): Promise<void> {
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
  });
}

async function flushCaret(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
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

async function waitForProfileTrigger(container: HTMLDivElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trigger = container.querySelector<HTMLButtonElement>('#composer-profile-select');
    if (trigger !== null && container.querySelector('[data-selection-diagnostic][role="status"]') === null) return trigger;
    await settle();
  }
  throw new Error('profile control never rendered');
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

  it.each([
    { label: 'default Enter send vs Shift+Enter newline', setting: undefined, busy: false, key: { key: 'Enter', shiftKey: true }, sends: null, nextKey: { key: 'Enter' }, nextSends: 'onSend' },
    { label: 'IME composing / keyCode 229 never sends', setting: 'enter' as const, busy: false, key: { key: 'Enter', isComposing: true }, sends: null, nextKey: { key: 'Enter', keyCode: 229 }, nextSends: null },
    { label: 'Ctrl/Cmd+Enter steers while busy and Enter queues', setting: 'enter' as const, busy: true, key: { key: 'Enter', ctrlKey: true }, sends: 'onSendNow', nextKey: { key: 'Enter' }, nextSends: 'onSend' },
    { label: 'cmd-enter setting keeps Enter newline and sends on Ctrl+Enter / steers on Ctrl+Shift+Enter', setting: 'cmd-enter' as const, busy: true, key: { key: 'Enter' }, sends: null, nextKey: { key: 'Enter', ctrlKey: true }, nextSends: 'onSend', thirdKey: { key: 'Enter', ctrlKey: true, shiftKey: true }, thirdSends: 'onSendNow' },
    { label: 'Ctrl+Enter sends while idle and Ctrl+Shift+Enter stays newline', setting: 'enter' as const, busy: false, key: { key: 'Enter', ctrlKey: true }, sends: 'onSend', nextKey: { key: 'Enter', ctrlKey: true, shiftKey: true }, nextSends: null },
  ] as const)('send shortcut matrix: $label', async ({ setting, busy, key, sends, nextKey, nextSends, thirdKey, thirdSends }) => {
    if (setting === undefined) { localStorage.clear(); writeSettings({}); }
    else writeSettings({ sendShortcut: setting });
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ value: 'shortcut text', busy, onSend, onSendNow });
    const textarea = composerInput(container);
    const check = async (eventInit: KeyboardEventInit | undefined, target: 'onSend' | 'onSendNow' | null | undefined) => {
      if (eventInit === undefined) return;
      const before = { send: onSend.mock.calls.length, now: onSendNow.mock.calls.length };
      await pressKey(textarea, eventInit);
      await settle();
      expect(onSend).toHaveBeenCalledTimes(before.send + (target === 'onSend' ? 1 : 0));
      expect(onSendNow).toHaveBeenCalledTimes(before.now + (target === 'onSendNow' ? 1 : 0));
      if (target === 'onSend') expect(onSend).toHaveBeenLastCalledWith('shortcut text', []);
      if (target === 'onSendNow') expect(onSendNow).toHaveBeenLastCalledWith('shortcut text', []);
    };
    await check(key, sends);
    await check(nextKey, nextSends);
    await check(thirdKey, thirdSends);
    writeSettings({ sendShortcut: 'enter' });
  });

  it('renders working status with last-response time and switches to actionable queued state', async () => {
    const at = Date.now() - 12_000;
    const { container, rerender } = await renderComposer({ value: '', busy: true, working: { lastResponseAt: at } });
    const workingLine = container.querySelector('[data-composer-working]');
    expect(workingLine).not.toBeNull();
    expect(workingLine?.getAttribute('data-last-response-at')).toBe(String(at));
    expect(workingLine?.textContent).toContain('Working · last response');
    expect(container.querySelector('[data-composer-hints]')).toBeNull();

    await rerender({ value: '', busy: true, working: { lastResponseAt: at, queued: { waitedMs: 4_000, modelId: 'fixture/kiki-pro' } } });
    const queuedLine = container.querySelector('[data-composer-working]');
    expect(queuedLine).not.toBeNull();
    expect(queuedLine?.querySelector('[data-composer-queued-trigger]')).not.toBeNull();
  });

  it('keeps permission chip visible and renders profile mark plus effort in CompactModelSheet', async () => {
    const { container } = await renderComposer({
      execution: { executor: 'native', profile: undefined, overrides: undefined },
      onChangeExecution: vi.fn(),
      model: 'fixture/kiki-pro',
      efforts: ['low', 'medium', 'high'],
      effort: 'high',
      permissionMode: 'yolo',
    });
    const status = container.querySelector('[data-composer-status]')!;
    const segments = [...status.querySelectorAll<HTMLElement>(':scope > [data-status-segment]')];
    const compactIdx = segments.findIndex((el) => el.dataset['statusSegment'] === 'compact-model');
    const permIdx = segments.findIndex((el) => el.dataset['statusSegment'] === 'permission');
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    expect(permIdx).toBeGreaterThan(compactIdx);
    expect(segments[permIdx]!.className).not.toContain('@max-[30rem]/toolbar:hidden');

    const compactTrigger = container.querySelector<HTMLButtonElement>('[data-compact-model-sheet-trigger]')!;
    expect(compactTrigger).not.toBeNull();
    expect(compactTrigger.querySelector('[data-compact-model-effort]')?.textContent).toContain('High');
    expect(compactTrigger.querySelector('svg path[d*="M7 2.5"]')).not.toBeNull();
    expect(compactTrigger.querySelector('.lucide-star')).toBeNull();

    const permTrigger = container.querySelector<HTMLButtonElement>('[data-mode-select] > button')!;
    expect(permTrigger.getAttribute('aria-label')).toContain('Full access');
  });

  it('submits browser prompts synchronously without VS Code preflight state', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'browser prompt', onSend });
    await pressKey(composerInput(container), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('browser prompt', []);
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(sendBtn(container).disabled).toBe(false);
  });

  it('preserves a new-session key for creation and rotates between resident sessions', async () => {
    vscodeRuntime.value = true;
    const onSend = vi.fn();
    const rendered = await renderComposer({ value: 'new', sessionId: undefined, onSend });
    const textarea = composerInput(rendered.container);
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    const newKey = preparePrompt.mock.calls[0]?.[1];

    await rendered.rerender({ value: 'session-a', sessionId: 'session-a', onSend });
    await pressKey(textarea, { key: 'Enter' });
    await settle();

    await rendered.rerender({ value: 'session-b', sessionId: 'session-b', onSend });
    await pressKey(textarea, { key: 'Enter' });
    await settle();

    await rendered.rerender({ value: 'new-again', sessionId: undefined, onSend });
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    const newKeyAfterSession = preparePrompt.mock.calls[3]?.[1];

    await rendered.rerender({ value: 'session-c', sessionId: 'session-c', onSend });
    await pressKey(textarea, { key: 'Enter' });
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
    const textarea = composerInput(harness.container);
    await act(async () => { textarea.focus(); });
    await harness.rerender({ disabled: true });
    // jsdom neither force-blurs on disable nor lets disabled inputs blur.
    // Chromium moves focus to the body and fires blur (not focusout) while
    // the control is already disabled, then focusin on the body. The body
    // event is the platform fallback, not a control the user chose.
    await act(async () => {
      textarea.disabled = false;
      textarea.blur();
      textarea.disabled = true;
      textarea.dispatchEvent(new FocusEvent('blur'));
      document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.activeElement).toBe(document.body);
    return { ...harness, textarea };
  }

  it('restores the same input after a disable-caused blur', async () => {
    const { container, rerender, textarea } = await disableFocusedInput();
    await rerender({ disabled: false });
    expect(container.querySelector('[data-composer-input][contenteditable]')).toBe(textarea);
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

  it('restores the same input when the session id arrives after that blur', async () => {
    const { container, rerender, textarea } = await disableFocusedInput();
    await rerender({ disabled: true, sessionId: 'session-new', value: '' });
    expect(container.querySelector('[data-composer-input][contenteditable]')).toBe(textarea);
    expect(document.activeElement).not.toBe(textarea);
    await rerender({ disabled: false, sessionId: 'session-new', value: '' });
    expect(container.querySelector('[data-composer-input][contenteditable]')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it('does not pull the caret back when another control was chosen before the session id arrives', async () => {
    const { container, rerender } = await disableFocusedInput();
    const button = document.createElement('button');
    container.append(button);
    await act(async () => { button.focus(); });
    await rerender({ disabled: false, sessionId: 'session-new', value: '' });
    expect(document.activeElement).toBe(button);
    expect(container.querySelector('[data-composer-input][contenteditable]')).not.toBeNull();
  });

  it('does not autofocus a cold input or restore a deliberate enabled blur', async () => {
    const { container, rerender } = await renderComposer();
    const textarea = composerInput(container);
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
    const textarea = composerInput(container);
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
  it.each([false, true])('previews draft and edited images without a parent gallery (%s)', async (messageEditing) => {
    const { container } = await renderComposer({
      messageEditing,
      attachments: [{ kind: 'image', name: 'draft.png', mediaType: 'image/png', data: 'AA==', size: 1, previewUrl: 'data:image/png;base64,AA==' }],
    });
    const tile = container.querySelector<HTMLButtonElement>('[data-image-tile] button')!;
    await act(async () => { tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    expect(document.querySelector('[data-menu-item="copy-image"]')).not.toBeNull();
    expect(document.querySelector('[data-menu-item="save-image"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await click(tile);
    expect(document.querySelector('[role="dialog"][aria-label="draft.png"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  });

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
    await click(container.querySelector('#composer-profile-select')!);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).toBeNull();
  });

  it.each([
    { agent_executor_overrides: { 'claude-acp': { show_in_profile_list: false } } },
    { agent_executor_overrides: { 'claude-acp': { show_in_profile_list: true } }, agent_executor_display: { externals_visible: false } },
  ])('does not offer an explicitly hidden engine and keeps its current binding (%j)', async raw => {
    getConfig.mockResolvedValue({ raw });
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: EXTERNAL_BARE,
      onChangeExecution,
    });
    await click(await waitForProfileTrigger(container));
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).toBeNull();
    expect(container.querySelector('[data-execution-profile="reviewer"]')).toBeNull();
    const retained = container.querySelector('[data-execution-restore="claude-acp"]');
    expect(retained).not.toBeNull();
    expect(retained?.textContent).not.toContain('not ready');
    expect(retained?.querySelector('[data-execution-configure]')?.getAttribute('href')).toBe('/settings/ai?tab=providers#st-card-engines');
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('preserves a bound unavailable engine identity and offers configuration rather than an executable bare entry', async () => {
    listExecutors.mockResolvedValue({ items: EXECUTOR_ITEMS.map(item => item.id === 'native' ? item : { ...item, status: 'unavailable' }) });
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: EXTERNAL_BARE, onChangeExecution });
    const trigger = container.querySelector('#composer-profile-select')!;
    expect(trigger.textContent).toContain('Claude Code');
    await click(trigger);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).toBeNull();
    expect(container.querySelector('[data-execution-restore="claude-acp"]')?.textContent).toContain('This session still uses it');
    expect(container.querySelector('[data-execution-configure]')).not.toBeNull();
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('keeps the picked persona name on the chip at any toolbar width', async () => {
    const { container } = await renderComposer({
      ...PROFILE_SELECT_PROPS,
      personaPick: { value: { id: 'xiao-you', name: '小柚' }, onChange: () => {} },
    });
    const chip = container.querySelector('[data-composer-persona-chip="xiao-you"]');
    // The persona branch of the profile control: the trigger keeps the face and the
    // name, and the panel behind it is still the engine/profile list.
    const trigger = container.querySelector('#composer-profile-select') ?? container.querySelector('#composer-execution-select');
    expect(chip).not.toBeNull();
    expect(trigger?.querySelector('span.truncate')?.textContent).toBe('小柚');
    // No container-query rule may turn the name into a screen-reader-only label.
    expect(chip?.innerHTML).not.toContain('sr-only');
    const clear = container.querySelector('[data-composer-persona-clear]');
    expect(clear?.getAttribute('aria-label')).toBe('Remove persona 小柚');
    await click(container.querySelector('#composer-profile-select')!);
    expect(container.querySelector('[data-execution-bare="claude-acp"]')).not.toBeNull();
  });

  it('allows picking a persona directly from the profile select menu', async () => {
    const onSelectPersona = vi.fn();
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      ...PROFILE_SELECT_PROPS,
      onChangeExecution,
      personaPick: { value: undefined, onChange: onSelectPersona },
    });
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    expect(container.querySelector('[data-composer-persona-option="nia"]')).not.toBeNull();
    const niaOption = container.querySelector<HTMLButtonElement>('[data-composer-persona-option="nia"] button')!;
    expect(niaOption.textContent).toContain('妮娅');
    expect(niaOption.textContent).toContain('个人管家');

    onSelectPersona.mockClear();
    onChangeExecution.mockClear();

    await click(niaOption);
    expect(onSelectPersona).toHaveBeenCalledExactlyOnceWith('nia');
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('omits the persona group when personaPick is omitted', async () => {
    const { container } = await renderComposer(PROFILE_SELECT_PROPS);
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    expect(container.querySelector('[data-composer-persona-option]')).toBeNull();
  });

  it('filters personas by search query in the profile select menu', async () => {
    const { container } = await renderComposer({
      ...PROFILE_SELECT_PROPS,
      personaPick: { value: undefined, onChange: vi.fn() },
    });
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    const filterInput = container.querySelector<HTMLInputElement>('[data-execution-filter]')!;
    await setInputValue(filterInput, '妮娅');
    await settle();
    expect(container.querySelector('[data-composer-persona-option="nia"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-persona-option="xiao-you"]')).toBeNull();
  });

  it('renders persona failure and retry when persona catalog fails', async () => {
    listPersonas.mockRejectedValueOnce(new Error('Network error'));
    const { container } = await renderComposer({
      ...PROFILE_SELECT_PROPS,
      personaPick: { value: undefined, onChange: vi.fn() },
    });
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    await settle();
    expect(container.textContent).toContain('Could not load personas');

    // Profile and file entry options remain reachable and usable while persona loading fails
    expect(container.querySelector('[data-execution-bare="native"]')).not.toBeNull();
    expect(container.querySelector('[data-execution-profile="grok-only"]')).not.toBeNull();
    expect(container.querySelector('[data-execution-file-open]')).not.toBeNull();

    const retryBtn = [...container.querySelectorAll('button')].find((btn) => btn.textContent?.includes('Retry'))!;
    expect(retryBtn).toBeDefined();

    // Trigger retry, verify persona catalog recovers and error state clears
    await click(retryBtn);
    await settle();

    expect(listPersonas).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Could not load personas');
    expect(container.querySelector('[data-composer-persona-option="nia"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-persona-option="xiao-you"]')).not.toBeNull();
  });

  it('keeps the persona-branch control openable while a turn runs', async () => {
    const { container } = await renderComposer({
      busy: true,
      ...PROFILE_SELECT_PROPS,
      personaPick: { value: { id: 'xiao-you', name: '小柚' }, onChange: () => {} },
    });
    const trigger = await waitForProfileTrigger(container);
    expect(trigger.disabled).toBe(false);
  });

  it('keeps the execution label accessible while collapsing it to the icon only when the toolbar is too narrow for a label', async () => {
    const { container } = await renderComposer({ ...PROFILE_SELECT_PROPS, model: 'fixture/kiki-pro' });
    const trigger = await waitForTrigger(container);
    expect(trigger.hasAttribute('data-model-picker')).toBe(true);
    const label = trigger.querySelector<HTMLElement>(':scope > span.truncate');
    expect(label?.textContent).toContain('kiki-pro');
    expect(label?.className).toContain('@max-[16rem]/toolbar:sr-only');
    expect(trigger.title).not.toBe('');
  });

  it('names the native engine as the product and lists only enabled main profiles', async () => {
    const { container } = await renderComposer(PROFILE_SELECT_PROPS);
    const profileTrigger = await waitForProfileTrigger(container);
    expect(profileTrigger.textContent).toContain('Kiki');
    expect(profileTrigger.textContent).not.toContain('main');

    await click(profileTrigger);
    expect(container.querySelectorAll('[data-execution-bare]').length).toBe(EXECUTOR_ITEMS.length);
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options.some((text) => text.includes('grok-only'))).toBe(true);
    expect(options.some((text) => text.includes('reviewer'))).toBe(true);
    expect(options.some((text) => text.includes('legacy'))).toBe(false);
    expect(options.filter((text) => text.includes('reviewer'))).toHaveLength(1);
    expect(
      container.querySelector('[data-execution-profile="reviewer"]'),
    ).not.toBeNull();
    const nativeRow = [...container.querySelectorAll('[role="option"]')].find(
      (row) => row.textContent?.includes('grok-only'),
    );
    expect(nativeRow?.textContent).toContain('Grok-only profile.');
  });

  it('offers the bare harness under every engine, and it sends no profile', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ ...PROFILE_SELECT_PROPS, onChangeExecution });
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    // The bare row is the first entry of each engine: it runs the harness as it
    // is, with no Kiki profile invented for it.
    const bareRows = [...container.querySelectorAll<HTMLElement>('[data-execution-bare]')];
    expect(bareRows.length).toBeGreaterThan(0);
    const bareRow = bareRows.find((row) => row.getAttribute('data-execution-bare') === 'claude-acp');
    expect(bareRow?.textContent).toContain('Claude Code');
    expect(bareRow?.textContent).not.toContain('Run this engine as it is');
    await click(bareRow!);
    const apply = container.querySelector<HTMLButtonElement>('[data-execution-apply]');
    if (apply) await click(apply);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'claude-acp', profile: undefined, profile_file: undefined, overrides: undefined,
    });
  });

  it('reports a profile pick with its own engine, so one pick answers both halves', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ ...PROFILE_SELECT_PROPS, onChangeExecution });
    await click(await waitForProfileTrigger(container));
    const row = container.querySelector<HTMLElement>('[data-execution-profile="reviewer"]');
    expect(row).not.toBeNull();
    await click(row!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'claude-acp', profile: 'reviewer', profile_file: undefined, overrides: undefined,
    });
  });

  it('clears a picked persona when the engine is chosen bare', async () => {
    const onPersona = vi.fn();
    const { container } = await renderComposer({
      ...PROFILE_SELECT_PROPS,
      personaPick: { value: { id: 'xiao-you', name: '小柚' }, onChange: onPersona },
    });
    // The chip is the persona branch; the engine choice is behind it.
    await click(await waitForProfileTrigger(container));
    const bare = [...container.querySelectorAll<HTMLElement>('[data-execution-bare]')]
      .find((row) => row.getAttribute('data-execution-bare') === 'claude-acp');
    await click(bare!);
    const apply = container.querySelector<HTMLButtonElement>('[data-execution-apply]');
    if (apply) await click(apply);
    expect(onPersona).toHaveBeenCalledWith(undefined);
  });

  it('shows rebuild context in the ＋ menu and calls it only after confirmation', async () => {
    const onRebuildContext = vi.fn(async () => ({ changed: true }));
    const { container } = await renderComposer({ sessionId: 'session-1', ...PROFILE_SELECT_PROPS, onRebuildContext });
    await waitForTrigger(container);
    await openAddMenu(container);
    const rebuildRow = container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]');
    expect(rebuildRow?.textContent).toContain('Rebuild context');
    await click(rebuildRow!);
    expect(onRebuildContext).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      // The same conversation, and the sources reloaded — never described as a
      // new session or as a prompt-only refresh.
      'This is the same conversation: its messages and history are kept.',
    );
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Rebuild context',
    );
    await click(confirm!);
    await settle();
    expect(onRebuildContext).toHaveBeenCalledOnce();
    expect(getToasts().some((toast) => toast.tone === 'success' && toast.text.includes('current sources'))).toBe(true);
  });

  it('closes a same-session rebuild confirmation on service replacement and ignores the old result', async () => {
    let finish!: (result: { changed: boolean }) => void;
    const onRebuildContext = vi.fn(() => new Promise<{ changed: boolean }>(resolve => { finish = resolve; }));
    const props = { sessionId: 'session-1', execution: NATIVE_AGENT, onChangeExecution: () => {}, onRebuildContext };
    const rendered = await renderComposer(props);
    const open = async () => {
      await openAddMenu(rendered.container);
      await click(rendered.container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]')!);
    };
    await open();
    expect(rendered.container.querySelector('[role="alertdialog"]')).not.toBeNull();
    connectionScope.startedAt = 'generation-two';
    await rendered.rerender(props);
    expect(rendered.container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onRebuildContext).not.toHaveBeenCalled();
    await open();
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === 'Rebuild context')!;
    await click(confirm);
    connectionScope.startedAt = 'generation-three';
    await rendered.rerender(props);
    await act(async () => { finish({ changed: true }); });
    await settle();
    expect(getToasts().some(toast => toast.text.includes('current sources'))).toBe(false);
    expect(rendered.container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('reports rebuild failures and keeps the execution control openable while busy', async () => {
    const onRebuildContext = vi.fn(async () => { throw new Error('reload failed'); });
    const rendered = await renderComposer({ sessionId: 'session-1', ...PROFILE_SELECT_PROPS, onRebuildContext });
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
      ...PROFILE_SELECT_PROPS,
      onChangeExecution: onChangeWhileBusy,
      onRebuildContext,
    });
    // A running turn must not lock the control: it stays browsable, and the
    // tooltip says a pick lands on the next message.
    const trigger = (rendered.container.querySelector<HTMLButtonElement>('#composer-profile-select') ?? rendered.container.querySelector<HTMLButtonElement>('#composer-execution-select'))!;
    expect(trigger.disabled).toBe(false);
    expect(trigger.title).toContain('next message');
    expect(trigger.title).not.toContain('rebuilding context');
    await click(trigger);
    const option = [...rendered.container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes('grok-only'));
    await click(option!);
    expect(onChangeWhileBusy).toHaveBeenCalledWith({
      executor: 'native', profile: 'grok-only', profile_file: undefined, overrides: undefined,
    });
    // Rebuild stays locked: it really does rewrite the live turn's context.
    await openAddMenu(rendered.container);
    expect(rendered.container.querySelector<HTMLButtonElement>('[data-add-menu-rebuild]')?.disabled).toBe(true);
  });

  it('hides without a handler but preserves the choice and offers retry when the catalog fails', async () => {
    const { container } = await renderComposer({ agentProfile: 'agent' });
    await settleMany();
    expect(container.querySelector('#composer-profile-select')).toBeNull();

    listNamedAgentProfiles.mockRejectedValue(new Error('catalog offline'));
    const second = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      execution: NATIVE_AGENT,
      onChangeExecution: () => {},
    });
    await settleMany();
    expect(second.container.querySelector('#composer-profile-select')?.textContent).toContain('Kiki');
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
    const { container } = await renderComposer(PROFILE_SELECT_PROPS);
    const trigger = await waitForProfileTrigger(container);
    await click(trigger);
    // The installed harness remains independently selectable without a profile.
    expect([...container.querySelectorAll('[data-execution-bare]')].map((row) =>
      (row as HTMLElement).dataset['executionBare'])).toEqual(['native', 'claude-acp']);
    expect(container.querySelectorAll('[data-execution-profile]')).toHaveLength(0);
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('unavailable');
  });

  it('offers a configured external engine even with no usable profile of its own', async () => {
    listNamedAgentProfiles.mockResolvedValue({
      items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] }] satisfies NamedAgentProfile[],
    });
    getConfig.mockResolvedValue({ raw: { agent_executor_overrides: { 'claude-acp': { bin_path: '/usr/local/bin/claude', show_in_profile_list: true } } } });
    const { container } = await renderComposer(PROFILE_SELECT_PROPS);
    const trigger = await waitForProfileTrigger(container);
    await settleMany(3);
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
      execution: { executor: 'native', profile: 'alpha-main', profile_file: undefined, overrides: undefined },
      onChangeExecution: () => {},
    });
    const trigger = await waitForProfileTrigger(container);
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
      execution: { executor: 'native', profile: 'alpha-main', profile_file: undefined, overrides: undefined },
      onChangeExecution: () => {},
    });
    expect((await waitForProfileTrigger(rendered.container)).textContent).toContain('alpha-main');

    await rendered.rerender({
      workspaceId: 'wd_beta',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_beta' },
      agentProfile: 'beta-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'beta-main', profile_file: undefined, overrides: undefined },
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
    await settle();
    const trigger = await waitForProfileTrigger(rendered.container);
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
      execution: { executor: 'native', profile: 'workspace-main', profile_file: undefined, overrides: undefined },
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
      execution: { executor: 'native', profile: 'workspace-main', profile_file: undefined, overrides: undefined },
      onChangeExecution: () => {},
    });
    catalog.resolve({
      items: [
        { name: 'workspace-main', source: 'workspace', source_file: '/workspace/.kiki/profiles/workspace-main.md', main: true, disabled: false, routes: [] },
      ],
    });
    const trigger = await waitForProfileTrigger(rendered.container);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_session');
    expect(trigger.textContent).toContain('workspace-main');
    await click(trigger);
    // The late-arriving profile is the selected row, and it lands on its own
    // engine rather than the first one listed.
    const selected = rendered.container.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.getAttribute('data-execution-profile')).toBe('workspace-main');
    expect(selected?.closest('[data-execution-engine]')?.getAttribute('data-execution-engine')).toBe('native');
  });

  it('refreshes the workspace profile catalog in the background when opening the selector', async () => {
    const refreshGate = deferred<{ items: NamedAgentProfile[] }>();
    let callCount = 0;
    listNamedAgentProfiles.mockImplementation((workspaceId?: string) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          items: [
            { name: 'initial-main', source: 'workspace', main: true, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[],
        });
      }
      return refreshGate.promise;
    });
    const rendered = await renderComposer({
      workspaceId: 'wd_live',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_live' },
      agentProfile: 'initial-main',
      onChangeAgentProfile: () => {},
      execution: { executor: 'native', profile: 'initial-main', profile_file: undefined, overrides: undefined },
      onChangeExecution: () => {},
    });
    const trigger = await waitForProfileTrigger(rendered.container);
    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(1);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_live');

    // Opening the menu triggers a background catalog refresh without waiting 60s staleTime.
    await click(trigger);
    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(2);

    // While refresh is pending: existing cached profile is immediately visible and selectable, added-main not yet present
    let options = [...rendered.container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '');
    expect(options.some((text) => text.includes('initial-main'))).toBe(true);
    expect(options.some((text) => text.includes('added-main'))).toBe(false);

    const initialOption = rendered.container.querySelector<HTMLElement>('[role="option"][data-execution-profile="initial-main"]');
    expect(initialOption).not.toBeNull();

    // Resolve background refresh with added item
    refreshGate.resolve({
      items: [
        { name: 'initial-main', source: 'workspace', main: true, disabled: false, routes: [] },
        { name: 'added-main', source: 'workspace', main: true, disabled: false, routes: [] },
      ] satisfies NamedAgentProfile[],
    });
    for (let index = 0; index < 3; index += 1) await settle();

    // Verify newly added profile becomes visible after refresh completes
    options = [...rendered.container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '');
    expect(options.some((text) => text.includes('added-main'))).toBe(true);
  });

  it('keeps cached profiles selectable and draft execution intact if background refresh fails', async () => {
    let callCount = 0;
    const selectedExecution: ExecutionChoice = { executor: 'native', profile: 'initial-main', profile_file: undefined, overrides: undefined };
    const onChangeExecution = vi.fn();
    listNamedAgentProfiles.mockImplementation((workspaceId?: string) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          items: [
            { name: 'initial-main', source: 'workspace', main: true, disabled: false, routes: [] },
            { name: 'backup-main', source: 'workspace', main: true, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[],
        });
      }
      return Promise.reject(new Error('network error during background refresh'));
    });

    const rendered = await renderComposer({
      workspaceId: 'wd_live',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_live' },
      agentProfile: 'initial-main',
      onChangeAgentProfile: () => {},
      execution: selectedExecution,
      onChangeExecution,
    });

    const trigger = await waitForProfileTrigger(rendered.container);
    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(1);

    // Open menu - triggers background refresh which will reject
    await click(trigger);
    expect(listNamedAgentProfiles).toHaveBeenCalledTimes(2);
    await settle();

    // Draft / bound execution is untouched
    expect(trigger.textContent).toContain('initial-main');

    // Cached items remain visible and selectable in menu
    const options = [...rendered.container.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '');
    expect(options.some((text) => text.includes('initial-main'))).toBe(true);
    expect(options.some((text) => text.includes('backup-main'))).toBe(true);

    // Selecting a cached item works normally
    const backupOption = rendered.container.querySelector<HTMLElement>('[role="option"][data-execution-profile="backup-main"]');
    expect(backupOption).not.toBeNull();
    await click(backupOption!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'native',
      profile: 'backup-main',
      profile_file: undefined,
      overrides: undefined,
    });
  });

  it('accents the pill while a switch is pending', async () => {
    const { container } = await renderComposer({
      agentProfile: 'reviewer',
      agentProfilePending: true,
      onChangeAgentProfile: () => {},
      execution: { executor: 'claude-acp', profile: 'reviewer', profile_file: undefined, overrides: undefined },
      onChangeExecution: () => {},
      executionPending: true,
    });
    const trigger = await waitForProfileTrigger(container);
    // A pending switch names the engine/profile and when it applies.
    expect(trigger.textContent).toContain('reviewer · next message');
    expect(trigger.title).toContain('applies from your next message');
  });
});

describe('Composer profile file', () => {
  /** Open the panel, then its file form. */
  async function openFileForm(container: HTMLDivElement): Promise<void> {
    await click(await waitForProfileTrigger(container));
    await click(container.querySelector('[data-execution-file-open]')!);
  }

  async function typePath(container: HTMLDivElement, path: string): Promise<void> {
    await setInputValue(container.querySelector<HTMLInputElement>('[data-execution-file-path]')!, path);
  }

  it('reads a file where the session runs and reports it as the pick', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/work', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await openFileForm(container);
    await typePath(container, 'profiles/research.md');
    await click(container.querySelector('[data-execution-file-check]')!);
    await settle();

    // The path is resolved on the session's own host, not on this machine.
    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: 'profiles/research.md', cwd: '/work' },
      { signal: expect.anything() },
    );
    const preview = container.querySelector('[data-execution-file-preview]');
    expect(preview?.textContent).toContain('research-writer');
    expect(preview?.textContent).toContain('/work/profiles/research.md');
    expect(onChangeExecution).not.toHaveBeenCalled();

    await click(container.querySelector('[data-execution-file-use]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'native',
      profile: undefined,
      profile_file: '/work/profiles/research.md',
      overrides: undefined,
    });
  });

  it('trims surrounding path whitespace before previewing and using the file', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/work', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await openFileForm(container);
    await typePath(container, '  profiles/research.md  ');
    await click(container.querySelector('[data-execution-file-check]')!);
    await settle();

    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: 'profiles/research.md', cwd: '/work' },
      { signal: expect.anything() },
    );
    expect(container.querySelector('[data-execution-file-preview]')?.textContent).toContain('research-writer');
    await click(container.querySelector('[data-execution-file-use]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'native',
      profile: undefined,
      profile_file: '/work/profiles/research.md',
      overrides: undefined,
    });
  });

  it('discards a late preview after the path changes while the first check is pending', async () => {
    const first = deferred<{ profile: NamedAgentProfile }>();
    previewAgentProfileFile.mockImplementation((request: { path: string }) =>
      request.path === 'profiles/first.md'
        ? first.promise
        : Promise.resolve({ profile: { ...FILE_PROFILE, name: 'second-writer', source_file: '/work/profiles/second.md' } }),
    );
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/work', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution: vi.fn(),
    });
    await openFileForm(container);
    await typePath(container, 'profiles/first.md');
    await click(container.querySelector('[data-execution-file-check]')!);
    await settle();
    expect(container.querySelector('[data-execution-file-preview]')).toBeNull();

    await typePath(container, 'profiles/second.md');
    await act(async () => { first.resolve({ profile: { ...FILE_PROFILE, name: 'first-writer', source_file: '/work/profiles/first.md' } }); });
    await settle();

    expect(container.querySelector<HTMLInputElement>('[data-execution-file-path]')?.value).toBe('profiles/second.md');
    expect(container.querySelector('[data-execution-file-preview]')).toBeNull();
    expect(container.querySelector('[data-execution-file-use]')).toBeNull();
  });

  it('discards a late preview when the profile file scope changes while the first check is pending', async () => {
    const first = deferred<{ profile: NamedAgentProfile }>();
    previewAgentProfileFile.mockImplementation((_request: { path: string }) => first.promise);
    const rendered = await renderComposer({
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/work', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution: vi.fn(),
    });
    await openFileForm(rendered.container);
    await typePath(rendered.container, 'profiles/first.md');
    await click(rendered.container.querySelector('[data-execution-file-check]')!);
    await settle();
    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: 'profiles/first.md', cwd: '/work' },
      { signal: expect.anything() },
    );

    await rendered.rerender({
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/other', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution: vi.fn(),
    });
    expect(rendered.container.querySelector('[data-execution-file-preview]')).toBeNull();

    await act(async () => { first.resolve({ profile: { ...FILE_PROFILE, name: 'first-writer', source_file: '/work/profiles/first.md' } }); });
    await settle();

    expect(rendered.container.querySelector<HTMLInputElement>('[data-execution-file-path]')?.value).toBe('profiles/first.md');
    expect(rendered.container.querySelector('[data-execution-file-preview]')).toBeNull();
    expect(rendered.container.querySelector('[data-execution-file-use]')).toBeNull();
  });

  it('drops a late check when the server changes and the catalog cwd stays', async () => {
    const pending = {
      'server-a': deferred<{ profile: NamedAgentProfile }>(),
      'server-b': deferred<{ profile: NamedAgentProfile }>(),
    };
    previewAgentProfileFile.mockImplementation(() => pending[connectionScope.serverId as 'server-a' | 'server-b'].promise);
    const props = {
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd' as const, cwd: '/work', effective: true },
      execution: NATIVE_AGENT,
      onChangeExecution: vi.fn(),
    };
    const rendered = await renderComposer(props);
    await openFileForm(rendered.container);
    await typePath(rendered.container, 'profiles/research.md');
    await click(rendered.container.querySelector('[data-execution-file-check]')!);
    await settle();
    expect(previewAgentProfileFile).toHaveBeenCalledTimes(1);
    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: 'profiles/research.md', cwd: '/work' }, { signal: expect.any(AbortSignal) },
    );
    const signal = previewAgentProfileFile.mock.calls[0]![1].signal as AbortSignal;
    connectionScope.serverId = 'server-b';
    await rendered.rerender(props);
    expect(signal.aborted).toBe(true);
    await act(async () => { pending['server-a'].resolve({ profile: { ...FILE_PROFILE, name: 'stale-writer' } }); });
    await settle();
    expect(previewAgentProfileFile).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector('[data-execution-file-preview]')).toBeNull();
    expect(rendered.container.querySelector('[data-execution-file-use]')).toBeNull();
    expect(rendered.container.querySelector<HTMLInputElement>('[data-execution-file-path]')?.value).toBe('profiles/research.md');
  });

  it('drops a native pick that resolves after the server changes', async () => {
    desktopRuntime.value = true;
    const picked = deferred<string | null>();
    selectFilePathNative.mockImplementation(() => picked.promise);
    const props = { sessionId: 'saved-session', execution: NATIVE_AGENT, onChangeExecution: vi.fn() };
    const rendered = await renderComposer(props);
    await click(await waitForProfileTrigger(rendered.container));
    await click(rendered.container.querySelector('[data-execution-file-open]')!);
    expect(selectFilePathNative).toHaveBeenCalledOnce();
    connectionScope.serverId = 'server-b';
    await rendered.rerender(props);
    expect(rendered.container.querySelector<HTMLButtonElement>('[data-execution-file-open]')!.disabled).toBe(false);
    await act(async () => { picked.resolve('C:/work/profiles/research.md'); });
    await settle();
    expect(previewAgentProfileFile).not.toHaveBeenCalled();
    expect(rendered.container.querySelector('[data-execution-file-preview]')).toBeNull();
    expect(rendered.container.querySelector('[data-execution-file-use]')).toBeNull();
    expect(props.onChangeExecution).not.toHaveBeenCalled();
  });

  it('does not show a bound-file name resolved by the previous server', async () => {
    const pending = {
      'server-a': deferred<{ profile: NamedAgentProfile }>(),
      'server-b': deferred<{ profile: NamedAgentProfile }>(),
    };
    previewAgentProfileFile.mockImplementation(() => pending[connectionScope.serverId as 'server-a' | 'server-b'].promise);
    const execution = { executor: 'native', profile: undefined, profile_file: '/work/profiles/research.md', overrides: undefined } as const;
    const props = {
      sessionId: 'saved-session',
      agentProfileCatalogMode: { mode: 'cwd' as const, cwd: '/work', effective: true },
      execution,
      onChangeExecution: vi.fn(),
    };
    const rendered = await renderComposer(props);
    await click(await waitForProfileTrigger(rendered.container));
    await settle();
    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: '/work/profiles/research.md', cwd: '/work' }, { signal: expect.any(AbortSignal) },
    );
    connectionScope.serverId = 'server-b';
    await rendered.rerender(props);
    await settle();
    await act(async () => { pending['server-a'].resolve({ profile: { ...FILE_PROFILE, name: 'stale-writer' } }); });
    await settle();
    expect(rendered.container.querySelector('[data-execution-file-row]')?.textContent).not.toContain('stale-writer');
    await act(async () => { pending['server-b'].resolve({ profile: { ...FILE_PROFILE, name: 'live-writer' } }); });
    await settle();
    expect(rendered.container.querySelector('[data-execution-file-row]')?.textContent).toContain('live-writer');
  });

  it('opens the native path picker without reading bytes, previews the selected file, and waits for Use', async () => {
    desktopRuntime.value = true;
    selectFilePathNative.mockResolvedValueOnce('C:/work/profiles/research.md');
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await click(await waitForProfileTrigger(container));
    const picker = container.querySelector<HTMLButtonElement>('[data-execution-file-open]')!;
    expect(picker.dataset['executionFilePicker']).toBe('native');
    await click(picker);
    await settle();

    expect(selectFilePathNative).toHaveBeenCalledOnce();
    expect(previewAgentProfileFile).toHaveBeenCalledWith(
      { path: 'C:/work/profiles/research.md' },
      { signal: expect.anything() },
    );
    expect(container.querySelector('[data-execution-file-preview]')?.textContent).toContain('research-writer');
    expect(onChangeExecution).not.toHaveBeenCalled();
    await click(container.querySelector('[data-execution-file-use]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'native', profile: undefined, profile_file: '/work/profiles/research.md', overrides: undefined,
    });
  });

  it.each(['ssh', 'remote'] as const)('opens the path field instead of a local picker for a %s session', async (source) => {
    desktopRuntime.value = true;
    connectionScope.source = source;
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: NATIVE_AGENT, onChangeExecution: vi.fn() });
    await click(await waitForProfileTrigger(container));
    const picker = container.querySelector<HTMLButtonElement>('[data-execution-file-open]')!;
    expect(picker.dataset['executionFilePicker']).toBe('path');
    await click(picker);
    expect(selectFilePathNative).not.toHaveBeenCalled();
    expect(container.querySelector('[data-execution-file-path]')).not.toBeNull();
  });

  it('shows the server’s refusal in the panel and changes nothing', async () => {
    const onChangeExecution = vi.fn();
    previewAgentProfileFile.mockRejectedValue(new ApiError({
      code: API_CODES.REQUEST_INVALID,
      msg: 'Unable to load profile file "notes.txt": Choose a profile Markdown (.md) file',
      data: null,
    }));
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await openFileForm(container);
    await typePath(container, 'notes.txt');
    await click(container.querySelector('[data-execution-file-check]')!);
    await settle();

    const error = container.querySelector('[data-execution-file-error]');
    expect(error?.textContent).toContain('Choose a profile Markdown (.md) file');
    expect(container.querySelector('[data-execution-file-preview]')).toBeNull();
    expect(onChangeExecution).not.toHaveBeenCalled();
    // The form is still open on the same text, so the reader can fix the path.
    expect(container.querySelector<HTMLInputElement>('[data-execution-file-path]')?.value).toBe('notes.txt');
  });

  it('leaves the draft and the pick alone when the file form is closed', async () => {
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: NATIVE_AGENT,
      onChangeExecution,
    });
    await openFileForm(container);
    await typePath(container, 'profiles/research.md');
    await click(container.querySelector('[data-execution-file-back]')!);

    expect(previewAgentProfileFile).not.toHaveBeenCalled();
    expect(onChangeExecution).not.toHaveBeenCalled();
    // Back to the engine list, still on the bound engine.
    expect(container.querySelector('[data-execution-filter]')).not.toBeNull();
    expect(container.querySelector('[data-execution-file-path]')).toBeNull();
  });

  it('names a bound profile file and does not read it as the bare engine', async () => {
    const fileChoice = {
      executor: 'native',
      profile: undefined,
      profile_file: '/work/profiles/research.md',
      overrides: undefined,
    } as const;
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: fileChoice,
      onChangeExecution: vi.fn(),
    });
    const trigger = await waitForProfileTrigger(container);
    expect(trigger.textContent).toContain('research.md');
    expect(trigger.getAttribute('data-execution-profile-file')).toBe('/work/profiles/research.md');

    await click(trigger);
    await settle();
    const row = container.querySelector('[data-execution-file-row]');
    expect(row?.getAttribute('data-execution-file-row')).toBe('/work/profiles/research.md');
    // The declared name replaces the file name once the host has answered.
    expect(row?.textContent).toContain('research-writer');
    expect(row?.textContent).toContain('/work/profiles/research.md');
    expect(row?.getAttribute('aria-selected')).toBe('true');
    // The bare native row is not the current pick: the session runs a profile.
    expect(container.querySelector('[data-execution-bare="native"]')?.getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the current compact control on the bound engine while a switch waits', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload());
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: EXTERNAL_BARE,
      boundExecution: NATIVE_AGENT,
      executionPending: true,
      contextUsage: { used: 120, limit: 1_000 },
      onCompactContext: () => {},
      onChangeExecution: vi.fn(),
    });
    await click(container.querySelector('[data-context-meter]')!);
    expect(container.querySelector('[data-context-compact]')).not.toBeNull();
    expect(container.querySelector('[data-context-compact-unavailable]')).toBeNull();
  });

  it('lets an engine catalogue age out of the compact control, as the model menu shows it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      getExecutorModels.mockResolvedValue(executorModelsPayload({
        controls: { manual_compact: { applicability: 'fresh_binding', apply_state: 'applied' } },
      }));
      const { container } = await renderComposer({
        sessionId: 'saved-session',
        execution: EXTERNAL_BARE,
        contextUsage: { used: 120, limit: 1_000 },
        onCompactContext: () => {},
        onChangeExecution: vi.fn(),
      });
      await click(container.querySelector('[data-context-meter]')!);
      expect(container.querySelector('[data-context-compact]')).not.toBeNull();

      vi.setSystemTime(Date.now() + 61_000);
      await act(async () => { vi.advanceTimersByTime(1_100); });

      expect(container.querySelector('[data-context-compact-unavailable]')).not.toBeNull();
      expect(container.querySelector('[data-context-compact]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Composer permission chip', () => {
  const trigger = (container: HTMLDivElement) =>
    container.querySelector<HTMLButtonElement>('[data-mode-select] > button')!;
  const rows = (container: HTMLDivElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-permission-panel] [role="option"]')];

  it('shows the current mode and lists every wire mode with its hint', async () => {
    const { container } = await renderComposer({ permissionMode: 'auto' });
    expect(trigger(container).getAttribute('aria-label')).toBe('Approvals: Auto');
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
    expect(labels).toEqual(['Add and actions', 'Model', 'Approvals: Ask every time', 'Send message']);
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
    const textarea = composerInput(container);
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
    const first = await renderComposer({ planMode: true, planGate: 'free', onChangePlanGate });
    await openPlanPanel(first.container);
    const gate = runRow(first.container, 'planGate');
    expect(gate.getAttribute('aria-checked')).toBe('true');
    await click(gate);
    expect(onChangePlanGate).toHaveBeenCalledWith('gated');
    await act(async () => { first.root.unmount(); });

    const normal = await renderComposer({ planGate: 'free', onChangePlanGate });
    await openPlanPanel(normal.container);
    expect(normal.container.querySelector('[data-mode-switch="planGate"]')).toBeNull();
    await act(async () => { normal.root.unmount(); });

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
    await setInputValue(field, 'Ship the batch');
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
    const textarea = composerInput(container);
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
    const textarea = composerInput(container);
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
    const textarea = composerInput(container);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[data-goal-objective]')).not.toBeNull();
    expect(container.querySelector('[data-goal-armed]')).toBeNull();
    expect(container.querySelector('[data-composer-card]')?.getAttribute('data-run-mode')).toBe('goal');
    expect(container.querySelector('[data-run-mode-chip]')?.getAttribute('data-run-mode-chip')).toBe('goal');
  });

  it('arms goal from the Mode panel, flags the next message, and disarms from the RunModeChip', async () => {
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
    expect(container.querySelector('[data-goal-armed]')).toBeNull();
    expect(container.querySelector('[data-composer-card]')?.getAttribute('data-run-mode')).toBe('goal');
    expect(container.querySelector('[data-run-mode-chip]')?.getAttribute('data-run-mode-chip')).toBe('goal');
    const textarea = composerInput(container);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(onSend).toHaveBeenCalledWith('fix the flaky suite', [], { goalObjective: 'fix the flaky suite' });

    const disarm = container.querySelector<HTMLButtonElement>('[data-run-mode-chip="goal"] button:last-of-type')!;
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
      { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 128000 },
      { id: 'fixture/kiki-air', provider_id: 'fixture', remote_id: 'kiki-air', display_name: 'Kiki Air', max_context_size: 128000 },
    ],
  };
  const bareAliasCatalog = {
    items: ['alpha', 'beta'].map((provider_id) => ({
      id: `${provider_id}/k3-256k`, provider_id, remote_id: 'k3-256k', display_name: 'K3 256K', max_context_size: 128000,
    })),
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
    expect(container.querySelector('[data-effort-label]')?.textContent).toBe('High');
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
    expect(trigger.hasAttribute('data-model-picker')).toBe(true);
    expect(trigger.textContent).toContain('Kiki Pro');
    expect(trigger.querySelector('[data-effort-label]')?.textContent).toBe('High');
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
    expect(trigger.querySelector('[data-effort-label]')?.textContent).toBe('High');
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
    expect(trigger.textContent).toContain('kiki-pro');
    await click(trigger);
    // No catalog means no filter input and no option list — just the rows.
    expect(container.querySelector('#composer-model-select-list')).toBeNull();
    await click(container.querySelector('[data-effort="high"]')!);
    expect(onChangeEffort).toHaveBeenCalledWith('high');
  });

  it('treats an ambiguous bare alias as available, naming the serving provider', async () => {
    listModels.mockResolvedValue(bareAliasCatalog);
    const { container } = await renderComposer({ serverDefaultModel: 'k3-256k' });
    await settleMany();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('K3 256K');

    await click(trigger);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-option-label]')?.textContent).toBe('Follow default: K3 256K');
    expect(rows[0]?.querySelector('[data-option-meta]')?.textContent).toContain('alpha');
    const headers = [...container.querySelectorAll('#composer-model-select-list p')].map((node) => node.textContent);
    expect(headers).toContain('alpha');
    expect(headers).toContain('beta');
  });

  it('resolves a bare-alias override onto the first candidate row', async () => {
    listModels.mockResolvedValue(bareAliasCatalog);
    const { container } = await renderComposer({ model: 'k3-256k' });
    await settleMany();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
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

  it.each([
    {
      label: 'oversized desktop pick',
      pick: { name: 'huge.bin', size: 51 * 1024 * 1024, type: '' },
      attachments: [],
      error: '"huge.bin" is 51 MB — files are capped at 50 MB each.',
    },
    {
      label: 'desktop pick at the attachment count cap',
      pick: { name: 'ninth.txt', size: 4, type: 'text/plain' },
      attachments: Array.from({ length: 8 }, (_, index) => ({
        kind: 'file' as const, path: `file-${index}.txt`, name: `file-${index}.txt`, isDir: false,
      })),
      error: 'At most 8 attachments per message.',
    },
  ])('rejects $label before reading contents', async ({ pick, attachments, error }) => {
    desktopRuntime.value = true;
    const read = vi.fn();
    selectFilesNative.mockResolvedValue([{ ...pick, read }]);
    const { container } = await renderComposer({ attachments });
    await clickAttach(container);
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain(error);
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
    const textarea = composerInputOf(container);
    await typeText(textarea, 'review old end');
    textarea.setSelectionRange(7, 10);
    if (gesture === 'keyboard') {
      const file = new File(['not the real contents'], 'large report.bin');
      Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 });
      await dispatchClipboardPaste(textarea, [file]);
    } else {
      await act(async () => { textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
      await click(document.querySelector('[data-menu-action="paste"]')!);
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
    const textarea = composerInputOf(container);
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
    const textarea = composerInputOf(container);
    await dispatchClipboardPaste(textarea, [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })], 'caption');
    expect(container.querySelector('[data-attachment-error]')).not.toBeNull();
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('caption', []);
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
  });

  it('keeps supported images and videos on the attachment path, not ordinary uploads', async () => {
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({ sessionId: 'session-owner', onChangeAttachments });
    await dispatchClipboardPaste(composerInputOf(container), [
      new File(['png'], 'shot.png', { type: 'image/png' }),
      new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }),
      new File(['binary'], 'huge.bin'),
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0]?.[0].name).toBe('clip.mp4');
    expect(uploadFile.mock.calls[0]?.[1]).toBe('session-owner');
    expect(onChangeAttachments).toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('full path');
  });

  it('uploads /new file attachments without session ownership', async () => {
    const { container } = await renderComposer({ sessionId: undefined });
    await dispatchClipboardPaste(composerInputOf(container), [
      new File(['video'], 'draft.mp4', { type: 'video/mp4' }),
    ]);

    expect(uploadFile).toHaveBeenCalledExactlyOnceWith(expect.any(File), undefined);
  });

  it('clears a failed attachment on a successful subsequent paste without locking text sends', async () => {
    desktopRuntime.value = true;
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ onSend });
    const textarea = composerInputOf(container);
    await typeText(textarea, 'keep this draft');
    selectFilesNative.mockResolvedValue([{ name: 'huge.bin', size: 60 * 1024 * 1024, type: '', read: vi.fn() }]);
    await clickAttach(container);
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('50 MB');
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
    const textarea = composerInputOf(container);
    textarea.setSelectionRange(5, 5);
    await dispatchClipboardPaste(textarea, [], ' text');
    expect(onChange).toHaveBeenCalledWith('draft text');
    readClipboardFiles.mockResolvedValue({ paths: ['C:/fixtures/report.txt'], media: [] });
    await dispatchClipboardPaste(textarea);
    expect(onChange).toHaveBeenCalledWith('draft C:/fixtures/report.txt');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('normalizes CRLF document offsets for direct value and range edits', async () => {
    const { container } = await renderComposer({ value: 'a\nb' });
    const textarea = composerInputOf(container);
    const handle = registeredComposerInputOf(textarea);
    if (handle === null || handle instanceof HTMLTextAreaElement) throw new Error('registered CodeMirror handle missing');

    expect(() => handle.setValueAndCursor('a\r\nb', 4)).not.toThrow();
    expect(handle.value).toBe('a\nb');
    expect(handle.selectionStart).toBe(3);
    expect(handle.selectionEnd).toBe(3);

    handle.setSelectionRange(-1, 99, 'backward');
    expect(handle.selectionStart).toBe(0);
    expect(handle.selectionEnd).toBe(3);
    expect(handle.selectionDirection).toBe('backward');
    expect(() => handle.setRangeText('x\r\ny', 0, 3, 'select')).not.toThrow();
    expect(handle.value).toBe('x\ny');
    expect(handle.selectionStart).toBe(0);
    expect(handle.selectionEnd).toBe(3);
    expect(handle.selectionDirection).toBe('forward');
  });

  it('keeps a CRLF paste and subsequent input at the live caret', async () => {
    desktopRuntime.value = true;
    const { container } = await renderStatefulComposer();
    const textarea = composerInputOf(container);
    await typeText(textarea, 'before\nafter');
    await placeCaret(textarea, textarea.value.length);

    await dispatchClipboardPaste(textarea, [], 'clip\r\nend');
    expect(container.querySelector('[data-attachment-error]')?.textContent).toBeUndefined();
    expect(textarea.value).toBe('before\nafterclip\nend');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);

    const handle = registeredComposerInputOf(textarea);
    if (handle === null || handle instanceof HTMLTextAreaElement) throw new Error('registered CodeMirror handle missing');
    await act(async () => { handle.setRangeText('!'); });
    expect(textarea.value).toBe('before\nafterclip\nend!');
    expect(textarea.selectionStart).toBe(textarea.value.length);

    await typeText(textarea, 'before\nafter');
    await placeCaret(textarea, 7);
    await dispatchClipboardPaste(textarea, [], 'clip\r\nend');
    expect(textarea.value).toBe('before\nclip\nendafter');
    expect(textarea.selectionStart).toBe(15);
    await act(async () => { handle.setRangeText('!'); });
    expect(textarea.value).toBe('before\nclip\nend!after');
    expect(textarea.selectionStart).toBe(16);
  });

  it('pastes into an asynchronously restored CRLF draft without losing the suffix or caret', async () => {
    desktopRuntime.value = true;
    const onChange = vi.fn();
    const { container, rerender } = await renderComposer({ value: '', onChange });
    await rerender({ value: 'before\r\nafter', onChange });
    const textarea = composerInputOf(container);
    const handle = registeredComposerInputOf(textarea);
    if (handle === null || handle instanceof HTMLTextAreaElement) throw new Error('registered CodeMirror handle missing');
    expect(handle.value).toBe('before\nafter');
    await placeCaret(textarea, textarea.value.length);

    const thread = '/s/session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    await dispatchClipboardPaste(textarea, [], `\r\n${thread}`);
    expect(container.querySelector('[data-attachment-error]')?.textContent).toBeUndefined();
    expect(textarea.value).toBe(`before\nafter\n${thread}`);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(onChange).toHaveBeenLastCalledWith(`before\nafter\n${thread}`);
    expect(container.querySelectorAll('.composer-reference')).toHaveLength(1);
  });

  it('keeps the caret after a desktop link pasted into the middle of a draft', async () => {
    desktopRuntime.value = true;
    const { container } = await renderStatefulComposer();
    const textarea = composerInputOf(container);
    await typeText(textarea, 'before  after');
    await placeCaret(textarea, 7);
    const link = '/s/session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => link } });
    await act(async () => {
      textarea.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textarea.value).toBe(`before ${link} after`);
    expect(textarea.selectionStart).toBe(7 + link.length);
    expect(textarea.selectionEnd).toBe(7 + link.length);
    await flushCaret();
    expect(textarea.selectionStart).toBe(7 + link.length);
  });

  it('keeps the caret after replacing a selection with multiple references', async () => {
    desktopRuntime.value = true;
    const { container } = await renderStatefulComposer();
    const textarea = composerInputOf(container);
    await typeText(textarea, 'before REPLACE after');
    await placeCaret(textarea, 7, 14);
    const thread = '/s/session_0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
    const pasted = `${thread} and kiki://agents/claude-code`;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => pasted } });
    await act(async () => {
      textarea.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textarea.value).toBe(`before ${pasted} after`);
    expect(textarea.selectionStart).toBe(7 + pasted.length);
    expect(textarea.selectionEnd).toBe(7 + pasted.length);
    expect(container.querySelectorAll('.composer-reference')).toHaveLength(2);
  });

  it.each(['ssh', 'remote', 'manual'] as const)('inserts original local paths as draft text in a %s workspace without uploading or reading files', async (source) => {
    desktopRuntime.value = true;
    connectionScope.source = source;
    connectionScope.id = source === 'remote' ? 'remote-fixture' : null;
    if (source === 'manual') connectionScope.url = 'https://example.test';
    readClipboardFiles.mockResolvedValue({ paths: ['C:/fixtures/report.pdf'], media: [] });
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'draft', onChange });
    const textarea = composerInputOf(container);
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
    const textarea = composerInputOf(container);
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
    const textarea = composerInput(container);
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
    const textarea = composerInput(container);

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
    const textarea = composerInput(container);
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
  it('omits permanent desktop shortcut footer hints for a clean status line', async () => {
    const empty = await renderComposer({ value: '' });
    expect(empty.container.querySelector('[data-composer-hints]')).toBeNull();

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
  it.each([
    { label: 'blocks button and swallows Enter without locking textarea', sendDisabled: true, title: undefined, shouldSend: false },
    { label: 'explains blocked send through tooltip', sendDisabled: true, title: 'Pick a workspace first', shouldSend: false },
    { label: 'sends on Enter when sendDisabled stays default', sendDisabled: undefined, title: undefined, shouldSend: true },
  ])('$label', async ({ sendDisabled, title, shouldSend }) => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', sendDisabled, sendDisabledTitle: title, onSend });
    const textarea = composerInput(container);
    const button = sendBtn(container);
    expect(textarea.getAttribute('contenteditable')).toBe('true');
    expect(button.disabled).toBe(!shouldSend);
    if (title !== undefined) expect(button.getAttribute('title')).toBe(title);
    await pressKey(textarea, { key: 'Enter' });
    if (shouldSend) expect(onSend).toHaveBeenCalledWith('hello', []);
    else expect(onSend).not.toHaveBeenCalled();
  });

  it('blocks duplicate Enter while VS Code turn preflight is pending', async () => {
    vscodeRuntime.value = true;
    const pending = deferred<string>();
    preparePrompt.mockReturnValue(pending.promise);
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    const textarea = composerInput(container);

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
  const textarea = composerInput(container);
  await act(async () => {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('Composer slash skill catalog', () => {
  it.each([
    {
      label: 'workspace skills on /new without creating a session',
      props: { value: '/', workspaceId: 'wd_fixture_0123456789ab' },
      loader: 'workspace' as const,
      expectedArg: 'wd_fixture_0123456789ab',
      menuHas: ['/review', '/plan'],
      menuLacks: ['/fork'],
      checkEmptyHint: true,
    },
    {
      label: 'live session catalog on /s/:id even with workspaceId',
      props: { value: '/', sessionId: 'session_live', workspaceId: 'wd_fixture_0123456789ab' },
      loader: 'session' as const,
      expectedArg: 'session_live',
      menuHas: ['/fork'],
      menuLacks: [],
      checkEmptyHint: false,
    },
    {
      label: 'global skills on an automatic draft',
      props: { value: '/', onActivateSkill: vi.fn() },
      loader: 'draft' as const,
      expectedArg: undefined,
      menuHas: ['/review'],
      menuLacks: ['/fork'],
      checkEmptyHint: false,
      checkPreview: 'Review',
    },
  ])('loads $label', async ({ props, loader, expectedArg, menuHas, menuLacks, checkEmptyHint, checkPreview }) => {
    const fn = loader === 'workspace' ? listWorkspaceSkills : loader === 'session' ? listSessionSkills : listDraftSkills;
    fn.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer(props);
    await settleMany(8);
    expect(fn).toHaveBeenCalledWith(expectedArg);
    if (loader !== 'session') expect(listSessionSkills).not.toHaveBeenCalled();
    if (loader !== 'workspace') expect(listWorkspaceSkills).not.toHaveBeenCalled();

    await openSlashMenu(container);
    const menuText = container.querySelector('[data-composer-menu]')?.textContent ?? '';
    for (const item of menuHas) expect(menuText).toContain(item);
    for (const item of menuLacks) expect(menuText).not.toContain(item);
    if (checkPreview) expect(container.querySelector('[data-skill-preview]')?.textContent ?? container.textContent).toContain(checkPreview);
    if (checkEmptyHint) {
      const empty = await renderComposer({ workspaceId: 'wd_fixture_0123456789ab' });
      expect(empty.container.querySelector('[data-composer-hints]')).toBeNull();
    }
  });

  it('reuses a fresh skills catalog when opening the slash menu again', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({ value: '/', workspaceId: 'wd_fixture_0123456789ab' });
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
    await pressKey(composerInput(container), { key: 'Escape' });
    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/review');
    expect(listWorkspaceSkills).toHaveBeenCalledTimes(1);
  });

  it('loads a custom directory catalog and activates its skill with args and attachment unchanged', async () => {
    listDraftSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const attachment = { kind: 'file' as const, path: '/workspace/input.txt', name: 'input.txt', isDir: false };
    const { container } = await renderComposer({
      value: '/review --fix', attachments: [attachment], onActivateSkill,
      agentProfileCatalogMode: { mode: 'cwd', cwd: '/workspace/custom', effective: true },
    });
    await settleMany();
    await pressKey(composerInput(container), { key: 'Enter' });
    expect(listDraftSkills).toHaveBeenCalledWith('/workspace/custom');
    expect(listWorkspaceSkills).not.toHaveBeenCalled();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix', [attachment], '/review --fix');
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

  it('keeps an unsent slash draft recoverable with Send anyway when its catalog fails, and still retries activation', async () => {
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
    expect(container.querySelector('[data-slash-confirm]')).not.toBeNull();
    expect(container.textContent).toContain('Skills catalog is unavailable right now — keep editing or send as a plain message.');
    expect(composerInput(container).value).toBe('/kiki-ops Help me get started.');
    expect(onSend).not.toHaveBeenCalled();
    expect(onActivateSkill).not.toHaveBeenCalled();

    listWorkspaceSkills.mockResolvedValue({ skills: [{ ...workspaceSkill, name: 'kiki-ops' }] });
    await click(sendButton);
    await settle();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('kiki-ops', 'Help me get started.', [], '/kiki-ops Help me get started.');

    listWorkspaceSkills.mockRejectedValue(new Error('catalog offline'));
    const fallbackSend = vi.fn();
    const offline = await renderComposer({
      value: '/unknown-cmd ship as text',
      workspaceId: 'wd_fixture_9876543210fe',
      onActivateSkill,
      onSend: fallbackSend,
    });
    await click(offline.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    await settle();
    const sendAnyway = [...offline.container.querySelectorAll<HTMLButtonElement>('[data-slash-confirm] button')]
      .find((button) => button.textContent?.includes('Send anyway'))!;
    expect(sendAnyway).toBeDefined();
    await click(sendAnyway);
    expect(fallbackSend).toHaveBeenCalledExactlyOnceWith('/unknown-cmd ship as text', []);
  });

  it('sends leading file paths and runs builtin actions without waiting on a pending or failed skills catalog', async () => {
    listSessionSkills.mockReturnValue(new Promise(() => {}));
    const onSend = vi.fn();
    const onChangePlanMode = vi.fn();
    const onSideQuestion = vi.fn();

    const pathRender = await renderComposer({
      value: '/etc/hosts maps to the wrong loopback',
      sessionId: 'session_pending_skills',
      onSend,
    });
    await click(pathRender.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/etc/hosts maps to the wrong loopback', []);

    listSessionSkills.mockRejectedValue(new Error('skills rpc down'));
    const planRender = await renderComposer({
      value: '/plan',
      sessionId: 'session_failed_skills',
      onChangePlanMode,
    });
    await click(planRender.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onChangePlanMode).toHaveBeenCalledExactlyOnceWith(true);

    const btwRender = await renderComposer({
      value: '/btw check port 8080',
      sessionId: 'session_failed_skills_btw',
      onSideQuestion,
    });
    await click(btwRender.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onSideQuestion).toHaveBeenCalledExactlyOnceWith('check port 8080');
  });

  it('activates the built-in first-run command from the global catalog without a workspace', async () => {
    listDraftSkills.mockResolvedValue({ skills: [{ ...workspaceSkill, name: 'kiki-ops', source: 'builtin' }] });
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
      composerInput(rendered.container)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('plan', 'menu options', attachments, '/skill:plan menu options');
    expect(onChangePlanMode).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'VS Code skill preflight with args', runtime: 'vscode' as const, value: '/review --fix', expectedArgs: '--fix', expectPrepare: true },
    { label: 'desktop with args', runtime: 'desktop' as const, value: '/review --fix', expectedArgs: '--fix', expectPrepare: false },
    { label: 'bare `/skill` command', runtime: 'browser' as const, value: '/review', expectedArgs: '', expectPrepare: false },
  ])('activates a hand-typed slash command: $label', async ({ runtime, value, expectedArgs, expectPrepare }) => {
    if (runtime === 'vscode') vscodeRuntime.value = true;
    if (runtime === 'desktop') desktopRuntime.value = true;
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value, workspaceId: 'wd_fixture_0123456789ab', onActivateSkill, onSend,
    });
    await settleMany(8);
    await pressKey(composerInput(container), { key: 'Enter' });
    await settle();
    if (expectPrepare) expect(preparePrompt).toHaveBeenCalledWith('', expect.any(String), false);
    else expect(preparePrompt).not.toHaveBeenCalled();
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', expectedArgs, [], value);
    expect(onSend).not.toHaveBeenCalled();
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
    const send = sendBtn(rendered.container);
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
    expect(composerInput(rendered.container).value).toBe(currentDraft);
  });

  it('preserves the IME preedit value and caret before a slash across catalog rerenders', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onChange = vi.fn();
    const props = { value: '/review tail', workspaceId: 'wd_fixture_0123456789ab', onChange };
    const { container, rerender } = await renderComposer(props);
    await openSlashMenu(container);
    const textarea = composerInput(container);
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    // The browser owns preedit text before the corresponding input/prop update.
    setComposerInputValue(textarea, 'ni/review tail');
    textarea.setSelectionRange(2, 2);
    await rerender(props);
    expect(textarea.value).toBe('ni/review tail');
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);
    expect(container.querySelector('[data-composer-input][contenteditable]')).toBe(textarea);
    await act(async () => {
      setComposerInputValue(textarea, '你/review tail');
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
    const textarea = composerInput(container);
    await act(async () => {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const key of ['Tab', 'Enter', 'Escape', 'ArrowDown']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        textarea.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      setComposerInputValue(textarea, 'ni/rev');
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

    const textarea = composerInput(container);
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
    await settleMany(8);
    const textarea = composerInput(container);
    await pressKey(textarea, { key: 'Enter' });
    expect(onSideQuestion).toHaveBeenCalledExactlyOnceWith('what does --frozen-lockfile do?');
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('');
  });

  it.each([
    { label: 'with handler', onSideQuestion: vi.fn(), engine: undefined, hasBtw: true, hasFork: true },
    { label: 'without handler', onSideQuestion: undefined, engine: undefined, hasBtw: false, hasFork: true },
    { label: 'when external engine refuses forking', onSideQuestion: vi.fn(), engine: { label: 'Codex', fork: false, images: true }, hasBtw: false, hasFork: false },
  ])('slash menu /btw visibility: $label', async ({ onSideQuestion, engine, hasBtw, hasFork }) => {
    listSessionSkills.mockResolvedValue({ skills: [] });
    const { container } = await renderComposer({ value: '/', sessionId: 'session_live', onSideQuestion, engine });
    await settleMany(8);
    await openSlashMenu(container);
    const menu = container.querySelector('[data-composer-menu]')?.textContent ?? '';
    if (hasBtw) expect(menu).toContain('/btw');
    else expect(menu).not.toContain('/btw');
    if (hasFork) expect(menu).toContain('/fork');
    else expect(menu).not.toContain('/fork');
  });

  it('sends a slash skill as prompt text when onActivateSkill is omitted', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onSend,
    });
    await settleMany(8);
    const textarea = composerInput(container);
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/review --fix', []);
  });

  it('activates inline, multiline, and mixed leading+inline /skills via onSend.skills, chips them in the tray, and ignores route links/paths/URLs/fractions', async () => {
    listWorkspaceSkills.mockResolvedValue({
      skills: [
        workspaceSkill,
        { ...workspaceSkill, name: 'nb-writing', description: 'Distill prose' },
        { ...workspaceSkill, name: 'ref-only', description: 'Model-only ref', type: 'reference' },
      ],
    });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const onChange = vi.fn();
    const { container, rerender } = await renderComposer({
      value: 'Please use /nb-writing on 1/2 of /etc/hosts https://example.com/nb-writing and /ref-only\nThen run /review',
      onChange,
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 6; index += 1) await settle();

    // Tray chips & editor token highlights appear for both completed inline skills, excluding reference/paths/URLs/fractions
    expect(container.querySelector('[data-context-tray] [data-skill-chip="nb-writing"]')).not.toBeNull();
    expect(container.querySelector('[data-context-tray] [data-skill-chip="review"]')).not.toBeNull();
    expect(container.querySelector('[data-context-tray] [data-skill-chip="ref-only"]')).toBeNull();
    expect(container.querySelector('[data-composer-skill-token="nb-writing"]')).not.toBeNull();
    expect(container.querySelector('[data-composer-skill-token="review"]')).not.toBeNull();

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onActivateSkill).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      'Please use /nb-writing on 1/2 of /etc/hosts https://example.com/nb-writing and /ref-only\nThen run /review',
      [],
      { skills: [{ name: 'nb-writing' }, { name: 'review' }] },
    );

    // Removing an inline skill chip strips only that token
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Remove skill nb-writing"]')!);
    expect(onChange).toHaveBeenLastCalledWith(
      'Please use on 1/2 of /etc/hosts https://example.com/nb-writing and /ref-only\nThen run /review',
    );

    // Leading /review + inline /nb-writing sends both skills via onSend instead of dropping the second skill
    onSend.mockClear();
    onActivateSkill.mockClear();
    await rerender({
      value: '/review combine with /nb-writing please',
      onChange,
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 4; index += 1) await settle();
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(onActivateSkill).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      '/review combine with /nb-writing please',
      [],
      { skills: [{ name: 'review' }, { name: 'nb-writing' }] },
    );
  });

  it('waits for a cold skills catalog when the draft contains an inline /skill candidate, but not for /s/ route links or file paths', async () => {
    const catalog = deferred<{ skills: typeof workspaceSkill[] }>();
    listWorkspaceSkills.mockReturnValue(catalog.promise);
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: 'Please apply /reader-first-writing to this note',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    await click(sendButton);
    expect(sendButton.disabled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      catalog.resolve({ skills: [{ ...workspaceSkill, name: 'reader-first-writing' }] });
    });
    await settle();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      'Please apply /reader-first-writing to this note',
      [],
      { skills: [{ name: 'reader-first-writing' }] },
    );

    // Non-candidate inline slashes (GUI session link + file path + fraction) do NOT block on a cold catalog
    listSessionSkills.mockReturnValue(new Promise(() => {}));
    const directSend = vi.fn();
    const nonCandidate = await renderComposer({
      value: 'Compare 1/2 of /etc/hosts with /s/session_abc',
      sessionId: 'session_cold_non_skill',
      onActivateSkill,
      onSend: directSend,
    });
    await click(nonCandidate.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!);
    expect(directSend).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Compare 1/2 of /etc/hosts with /s/session_abc'),
      [],
      expect.anything(),
    );
  });
});

// ---- C-1/C-2/C-3: history recall, undo/redo, skill preview ----

function StatefulHarness({
  onSend,
  ...props
}: Partial<ComposerProps>) {
  const [text, setText] = useState('');
  return (
    <Composer
      {...DEFAULT_COMPOSER_PROPS}
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
  return { container: withPortalQueries(container), root };
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
    await setInputValue(search, 'pars');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(fsSearch).toHaveBeenCalledWith('pars', { signal: expect.any(AbortSignal) });
    await click(container.querySelector('[data-add-results] [data-add-file="src/parser.ts"]')!);
    expect(onChangeAttachments).toHaveBeenLastCalledWith([
      { kind: 'file', path: 'src/parser.ts', name: 'parser.ts', isDir: false },
    ]);
  });
});

describe('Composer input history', () => {
  it('recalls sent prompts consecutively on ArrowUp/ArrowDown including multi-line entries', async () => {
    pushInputHistory('s_hist', 'first line 1\nfirst line 2');
    pushInputHistory('s_hist', 'second prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerInputOf(container);
    expect(textarea.value).toBe('');

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('second prompt');
    await flushCaret();
    // Consecutive ArrowUp from the recalled entry's end steps straight to the older entry.
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first line 1\nfirst line 2');
    await flushCaret();
    // The oldest entry sticks — no wrap-around.
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first line 1\nfirst line 2');
    // Moving the caret into the middle keeps native cursor movement inside the prompt.
    await placeCaret(textarea, 5);
    await pressKey(textarea, { key: 'ArrowUp' });
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('first line 1\nfirst line 2');
    // From either edge while browsing, ArrowDown steps forward through history.
    await placeCaret(textarea, textarea.value.length);
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('second prompt');
    await flushCaret();
    // ArrowDown past the newest entry hands the pre-browse draft back.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('');
  });

  it('Escape exits recall and restores the in-progress draft', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerInputOf(container);

    await typeText(textarea, 'draft in progress');
    await placeCaret(textarea, 0);
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
    const textarea = composerInputOf(container);

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
    await typeText(textarea, 'older prompt, edited');
    // No longer browsing: ArrowDown is not a recall key now.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('older prompt, edited');
  });

  it('leaves multiline and wrapped drafts alone until the caret is at the text edge', async () => {
    pushInputHistory('s_hist', 'older prompt');
    pushInputHistory('s_hist', 'newer prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerInputOf(container);

    await typeText(textarea, 'line one\nline two');
    await placeCaret(textarea, textarea.value.length);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('line one\nline two');
    // The first logical line is not the top of the text.
    await placeCaret(textarea, 2);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('line one\nline two');
    await placeCaret(textarea, 0);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('newer prompt');
    await flushCaret();

    await placeCaret(textarea, 4);
    await pressKey(textarea, { key: 'ArrowUp' });
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('newer prompt');

    const wrapped = 'alpha '.repeat(30).trim();
    await pressKey(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('line one\nline two');
    await typeText(textarea, wrapped);
    await placeCaret(textarea, 12);
    await pressKey(textarea, { key: 'ArrowUp' });
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe(wrapped);
    await placeCaret(textarea, 0);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('newer prompt');
  });

  it('keeps Shift, a selection, and IME composition on the draft', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerInputOf(container);
    await typeText(textarea, 'keep this draft');

    await placeCaret(textarea, 0);
    await pressKey(textarea, { key: 'ArrowUp', shiftKey: true });
    expect(textarea.value).toBe('keep this draft');

    await placeCaret(textarea, 0, 4);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('keep this draft');

    await placeCaret(textarea, 0);
    await pressKey(textarea, { key: 'ArrowUp', keyCode: 229 });
    expect(textarea.value).toBe('keep this draft');

    await placeCaret(textarea, textarea.value.length);
    await pressKey(textarea, { key: 'ArrowDown', shiftKey: true });
    expect(textarea.value).toBe('keep this draft');
  });

  it('records a send and recalls it afterwards', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ sessionId: 's_send', onSend });
    const textarea = composerInputOf(container);

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
    const textarea = composerInputOf(container);

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

  it('omits permanent history hint noise on an empty draft', async () => {
    const bare = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(bare.container.querySelector('[data-composer-hints]')).toBeNull();

    pushInputHistory('s_hint', 'older prompt');
    const seeded = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(seeded.container.querySelector('[data-composer-hints]')).toBeNull();
  });
});

describe('Composer undo/redo', () => {
  it('walks the local stack with caret positions and redo', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_undo' });
    const textarea = composerInputOf(container);

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
    const textarea = composerInputOf(container);

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
    const textarea = composerInputOf(container);

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
    const textarea = composerInputOf(container);

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

  async function openPreviewMenu(container: HTMLDivElement): Promise<ComposerInputElement> {
    const textarea = composerInputOf(container);
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
    expect(composerInputOf(container).value).toBe('Keep this welcome draft.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('treats an empty model value as unselected, not as a removed model named ""', async () => {
    listModels.mockResolvedValue({ items: [] });
    const { container } = await renderComposer({ model: '', serverDefaultModel: undefined });
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    expect(container.textContent).not.toContain('Model “”');
    expect(container.querySelector('#composer-model-select')?.textContent).toContain('Choose a model');
  });

  it('can pick a native model when no default is configured without discarding the welcome draft', async () => {
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ value: 'Keep this welcome draft.', serverDefaultModel: undefined, onChangeModel });
    await click(container.querySelector('#composer-model-select')!);
    await click(container.querySelector('[data-option-value="fixture/kiki-pro"]')!);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-pro');
    expect(composerInputOf(container).value).toBe('Keep this welcome draft.');
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

  it('keeps an absent profile sendable while a partial catalog exposes its loaded choices', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ name: 'loaded-main', source: 'user', main: true, disabled: false, routes: [] }], complete: false });
    const onSend = vi.fn();
    const { container } = await renderComposer({ execution: { ...NATIVE_AGENT, profile: 'saved-main' }, agentProfile: 'saved-main', value: 'ready now', onSend, onChangeExecution: vi.fn() });
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    await click(await waitForProfileTrigger(container));
    expect(container.querySelector('[data-execution-profile="loaded-main"]')).not.toBeNull();
    await click(container.querySelector('button[aria-label="Send message"]')!);
    expect(onSend).toHaveBeenCalledWith('ready now', []);
  });

  it('keeps an explicitly disabled profile blocked even in a partial catalog', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ name: 'saved-main', source: 'user', main: true, disabled: true, routes: [] }], complete: false });
    const { container, queryClient } = await renderComposer({ agentProfile: 'saved-main', value: 'ready now' });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
    listNamedAgentProfiles.mockRejectedValue(new Error('catalog offline'));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['agentProfiles'] }); });
    await settle();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
  });

  it('keeps a bare external engine sendable without a native model or profile catalog', async () => {
    listModels.mockResolvedValue({ items: [] });
    listNamedAgentProfiles.mockReturnValue(new Promise(() => {}));
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', model: 'vendor-only', effort: 'vendor-effort', execution: EXTERNAL_BARE, onChangeExecution: vi.fn(), onSend });
    await click(sendBtn(container));
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(container.querySelector('#composer-engine-model-select')).toBeNull();
    expect(container.querySelector('[data-composer-engine-model]')?.textContent).toContain('Follow engine configuration');
  });

  it('accepts an external model ID verbatim without looking it up in the native catalog', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChangeExecution = vi.fn();
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      models: { state: 'ready', values: ['vendor/model-id'] },
      controls: { thinking_switch: { applicability: 'unknown', apply_state: 'unknown' } },
    }));
    const { container } = await renderComposer({ execution: EXTERNAL_BARE, onChangeExecution });
    await click(engineModelTrigger(container));
    await click(container.querySelector('[data-option-value="vendor/model-id"]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ ...EXTERNAL_BARE, overrides: { model: 'vendor/model-id' } });
    expect(onChangeExecution.mock.calls[0]?.[0].overrides).not.toHaveProperty('thinking');
    expect(container.querySelector('[data-option-value="vendor/model-id"]')).toBeNull();
  });

  it('closes without changing selection when Escape is pressed, and applies immediately on click', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChangeExecution = vi.fn();
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      models: { state: 'ready', values: ['vendor/model-id', 'vendor/model-other'] },
      controls: { thinking_switch: { applicability: 'unknown', apply_state: 'unknown' } },
    }));
    const { container } = await renderComposer({ execution: EXTERNAL_BARE, onChangeExecution });
    const trigger = engineModelTrigger(container);
    await click(trigger);
    container.querySelector('[data-execution-select]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(onChangeExecution).not.toHaveBeenCalled();
    await click(trigger);
    await click(container.querySelector('[data-option-value="vendor/model-id"]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ ...EXTERNAL_BARE, overrides: { model: 'vendor/model-id' } });
    expect(onChangeExecution.mock.calls[0]?.[0].overrides).not.toHaveProperty('thinking');
  });

  it('offers only the external engine models, never native catalog aliases', async () => {
    listModels.mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }] });
    getExecutorModels.mockResolvedValue(executorModelsPayload({ models: { state: 'ready', values: ['claude/sonnet', 'claude/opus'] } }));
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    await click(engineModelTrigger(container));
    expect(container.querySelector('[data-option-value="claude/sonnet"]')).not.toBeNull();
    expect(container.querySelector('[data-option-value="claude/opus"]')).not.toBeNull();
    expect(container.querySelector('[data-option-value="fixture/kiki-pro"]')).toBeNull();
    expect(container.querySelector('[data-external-model-provenance]')).toBeNull();
    expect(container.querySelector('[data-external-capability-facts]')).toBeNull();
  });

  it('shows partial engine models with the count still being reported', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({ models: { state: 'partial', values: ['vendor/model-a', 'vendor/model-b'] } }));
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    await click(engineModelTrigger(container));
    expect(container.querySelector('[data-option-value="vendor/model-a"]')).not.toBeNull();
    expect(container.querySelector('[data-option-value="vendor/model-b"]')).not.toBeNull();
    expect(container.querySelector('[data-external-model-status]')?.textContent).toContain('2 models so far; the engine is still reporting.');
  });

  it.each([
    {
      label: 'unavailable binding keeps saved model and shows diagnostic',
      payload: executorModelsPayload({
        apply_state: 'unavailable',
        models: { state: 'unavailable', diagnostic: 'CLI probe timed out' },
        controls: { model_switch: { applicability: 'unknown', apply_state: 'unknown' }, thinking_switch: { applicability: 'unknown', apply_state: 'unknown' } },
      }),
      overrides: { model: 'vendor/saved-model' },
      expectedText: 'vendor/saved-model',
      expectedTitle: ['This engine did not report its models.', 'CLI probe timed out'],
      sendValue: undefined,
    },
    {
      label: 'loading catalog keeps reply text sendable',
      payload: executorModelsPayload({
        source: 'negotiated', provenance: 'acp_negotiation', apply_state: 'loading',
        models: { state: 'loading' },
        controls: { model_switch: { applicability: 'unknown', apply_state: 'unknown' }, thinking_switch: { applicability: 'unknown', apply_state: 'unknown' } },
      }),
      overrides: undefined,
      expectedText: undefined,
      expectedTitle: ["Reading this engine's models…"],
      sendValue: 'continue',
    },
  ])('external engine model control when $label', async ({ payload, overrides, expectedText, expectedTitle, sendValue }) => {
    getExecutorModels.mockResolvedValue(payload);
    const onChangeExecution = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: { ...EXTERNAL_BARE, overrides },
      onChangeExecution,
      value: sendValue ?? '',
      onSend,
    });
    expect(container.querySelector('#composer-engine-model-select')).toBeNull();
    const identity = container.querySelector<HTMLElement>('[data-composer-engine-model]')!;
    if (expectedText !== undefined) expect(identity.textContent).toContain(expectedText);
    for (const part of expectedTitle) expect(identity.title).toContain(part);
    if (sendValue !== undefined) {
      await click(sendBtn(container));
      expect(onSend).toHaveBeenCalledWith(sendValue, []);
    }
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('marks a saved external model that is absent from a ready catalog without replacing it', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      source: 'negotiated', provenance: 'acp_negotiation',
      models: { state: 'ready', values: ['vendor/current-model'] },
    }));
    const { container } = await renderComposer({
      sessionId: 'saved-session',
      execution: { ...EXTERNAL_BARE, overrides: { model: 'vendor/saved-model' } },
      onChangeExecution: vi.fn(),
    });
    const trigger = engineModelTrigger(container);
    expect(trigger.textContent).toContain('vendor/saved-model');
    await click(trigger);
    const saved = container.querySelector('[data-option-value="vendor/saved-model"]')!;
    expect(saved.textContent).toContain("not in this engine's list");
    expect(saved.getAttribute('aria-selected')).toBe('true');
    expect(engineModelTrigger(container).textContent).toContain('vendor/saved-model');
  });

  it.each([
    { control: { applicability: 'unsupported' as const, apply_state: 'unsupported' as const, diagnostic: 'restart with --model' }, declared: true },
    { control: { applicability: 'unknown' as const, apply_state: 'unknown' as const }, declared: false },
  ])('marks the picker boundary only when the engine declares model switching unsupported ($control.applicability)', async ({ control, declared }) => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      source: 'negotiated', provenance: 'acp_negotiation',
      models: { state: 'ready', values: ['vendor/model-a'] },
      controls: {
        model_switch: control,
        thinking_switch: { applicability: 'unknown', apply_state: 'unknown' },
        manual_compact: { applicability: 'unknown', apply_state: 'unknown' },
      },
    }));
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    expect(container.querySelector('#composer-engine-model-select')).toBeNull();
    const identity = container.querySelector<HTMLElement>('[data-composer-engine-model]')!;
    if (declared) {
      expect(identity.title).toContain('does not accept a model change here');
      expect(identity.title).toContain('restart with --model');
    } else expect(identity.title).not.toContain('does not accept a model change here');
  });

  it('says the engine catalog read is old when it is stale, and refresh stays inside the model panel', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      observed_at: Date.now() - 120_000,
      models: { state: 'ready', values: ['vendor/old-model'] },
      controls: {
        model_switch: { applicability: 'unknown', apply_state: 'unknown' },
        thinking_switch: { applicability: 'unknown', apply_state: 'unknown' },
        manual_compact: { applicability: 'unknown', apply_state: 'unknown' },
      },
    }));
    const { container } = await renderComposer({ sessionId: 'saved-session', execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    expect(container.querySelector('#composer-engine-model-select')).toBeNull();
    const identity = container.querySelector<HTMLElement>('[data-composer-engine-model]')!;
    expect(identity.title).toContain('Last read over a minute ago.');
    expect(identity.title).not.toContain('not known yet');
    expect(container.querySelector('[data-external-model-refresh]')).toBeNull();
    await click(container.querySelector<HTMLButtonElement>('#composer-execution-select')!);
    const refresh = container.querySelector<HTMLButtonElement>('[data-external-model-refresh]')!;
    expect(refresh.disabled).toBe(false);
    expect(container.querySelector('[data-external-model-status]')?.textContent).toContain('Last read over a minute ago.');
  });

  it('preserves an absent-data binding without offering fabricated model choices', async () => {
    const { container } = await renderComposer({ execution: { ...EXTERNAL_BARE, overrides: { model: 'vendor/saved-model' } }, onChangeExecution: vi.fn() });
    expect(container.querySelector('#composer-engine-model-select')).toBeNull();
    expect(container.querySelector('[data-composer-engine-model]')?.textContent).toContain('vendor/saved-model');
    expect(container.querySelector('[data-option-value="fixture/kiki-pro"]')).toBeNull();
  });

  it('refreshes the typed executor catalog only from the explicit affordance', async () => {
    const observed = executorModelsPayload({ models: { state: 'ready', values: ['vendor/old-model'] } });
    const refreshed = {
      ...observed, revision: '2', observed_at: Date.now(),
      effective: { ...observed.effective, models: { state: 'ready' as const, values: ['vendor/new-model'] } },
    };
    const refreshResult = deferred<typeof refreshed>();
    getExecutorModels.mockResolvedValue(observed);
    refreshExecutorModels.mockReturnValue(refreshResult.promise);
    const { container } = await renderComposer({ execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    expect(refreshExecutorModels).not.toHaveBeenCalled();
    await click(engineModelTrigger(container));
    expect(container.querySelector('[data-option-value="vendor/old-model"]')).not.toBeNull();
    const refreshButton = container.querySelector<HTMLButtonElement>('[data-external-model-refresh]')!;
    await click(refreshButton);
    await settle();
    expect(refreshButton.disabled).toBe(true);
    expect(refreshButton.textContent).toContain('Refreshing…');
    await act(async () => { refreshResult.resolve(refreshed); });
    await settle();
    expect(refreshExecutorModels).toHaveBeenCalledExactlyOnceWith('claude-acp');
    expect(container.querySelector('[data-option-value="vendor/new-model"]')).not.toBeNull();
    expect(container.querySelector('[data-option-value="vendor/old-model"]')).toBeNull();
  });

  it('keeps the last known values and says so when refresh fails', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      source: 'negotiated', provenance: 'acp_negotiation', models: { state: 'ready', values: ['vendor/known-model'] },
    }));
    refreshExecutorModels.mockRejectedValue(new Error('refresh unavailable'));
    const { container } = await renderComposer({ execution: EXTERNAL_BARE, onChangeExecution: vi.fn() });
    await click(engineModelTrigger(container));
    await click(container.querySelector<HTMLButtonElement>('[data-external-model-refresh]')!);
    await settle();
    expect(refreshExecutorModels).toHaveBeenCalledExactlyOnceWith('claude-acp');
    expect(container.querySelector('[data-option-value="vendor/known-model"]')).not.toBeNull();
    expect(container.querySelector('[data-external-model-refresh-error]')?.textContent).toContain('Refresh failed; showing the last known values.');
  });

  it.each([true, false])('offers the meter compact action when supported (external=%s)', async (external) => {
    if (external) {
      getExecutorModels.mockResolvedValue(executorModelsPayload({
        models: { state: 'ready', values: ['vendor/model'] },
        controls: { manual_compact: { applicability: 'fresh_binding', apply_state: 'applied' } },
      }));
    }
    const { container } = await renderComposer({
      ...(external ? { execution: EXTERNAL_BARE, onChangeExecution: vi.fn() } : {}),
      contextUsage: { used: 400, limit: 1000 },
      onCompactContext: vi.fn(),
    });
    await click(container.querySelector<HTMLButtonElement>('[data-context-meter]')!);
    expect(container.querySelector('[data-executor-action="manual_compact"]')).not.toBeNull();
    expect(container.querySelector('[data-context-compact-unavailable]')).toBeNull();
  });

  it.each([
    {
      control: { applicability: 'unsupported' as const, apply_state: 'unsupported' as const, diagnostic: 'compact is not available' },
      sentence: 'This engine does not offer manual compaction.',
    },
    {
      control: { applicability: 'unknown' as const, apply_state: 'unknown' as const, diagnostic: 'compact is not available' },
      sentence: 'This engine has not said whether manual compaction works.',
    },
  ])('states the real reason on the meter instead of a dead compact action ($control.applicability)', async ({ control, sentence }) => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      models: { state: 'ready', values: ['vendor/model'] },
      controls: { manual_compact: control },
    }));
    const { container } = await renderComposer({
      execution: EXTERNAL_BARE, onChangeExecution: vi.fn(),
      contextUsage: { used: 400, limit: 1000 }, onCompactContext: vi.fn(),
    });
    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]')!;
    expect(meter.title).toContain(sentence);
    expect(meter.title).toContain('compact is not available');
    await click(meter);
    expect(container.querySelector('[data-executor-action="manual_compact"]')).toBeNull();
    const reason = container.querySelector('[data-context-compact-unavailable]')!;
    expect(reason.textContent).toContain(sentence);
    expect(reason.textContent).toContain('compact is not available');
  });

  it('says an external engine has not reported its capabilities instead of offering compaction', async () => {
    const { container } = await renderComposer({
      execution: EXTERNAL_BARE, onChangeExecution: vi.fn(),
      contextUsage: { used: 400, limit: 1000 }, onCompactContext: vi.fn(),
    });
    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]')!;
    expect(meter.title).toContain('has not reported its capabilities');
    await click(meter);
    expect(container.querySelector('[data-executor-action="manual_compact"]')).toBeNull();
    expect(container.querySelector('[data-context-compact-unavailable]')!.textContent).toContain('has not reported its capabilities');
  });

  it('clears explicit external model and thinking overrides when following the engine again', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      source: 'negotiated', provenance: 'acp_negotiation',
      models: { state: 'ready', values: ['vendor/model-v1'] },
      thinking_levels: { state: 'ready', values: ['high'] },
    }));
    const onChangeExecution = vi.fn();
    const choice = { ...EXTERNAL_BARE, overrides: { model: 'vendor/model-v1', thinking: 'high' } };
    const { container } = await renderComposer({ execution: choice, onChangeExecution });
    await click(engineModelTrigger(container));
    await click(container.querySelector('[data-option-value=""]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ ...choice, overrides: { model: null, thinking: null } });
  });

  it('changes native effort without publishing an execution choice', async () => {
    const onChangeExecution = vi.fn();
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({
      execution: NATIVE_AGENT,
      onChangeExecution,
      onChangeEffort,
      model: 'fixture/kiki-pro',
      effort: 'medium',
      efforts: ['low', 'medium', 'high'],
    });
    await click(container.querySelector('#composer-execution-select')!);
    const high = container.querySelector<HTMLButtonElement>('[data-execution-effort="high"]')!;
    expect(high).not.toBeNull();
    await click(high);
    expect(onChangeEffort).toHaveBeenCalledWith('high');
    expect(onChangeExecution).not.toHaveBeenCalled();
    expect(high.getAttribute('aria-checked')).toBe('false');
    const selected = container.querySelector<HTMLButtonElement>('[data-execution-effort="medium"]')!;
    expect(selected.getAttribute('aria-checked')).toBe('true');
    await click(container.querySelector('[data-execution-effort=""]')!);
    expect(onChangeEffort).toHaveBeenLastCalledWith('');
    expect(onChangeExecution).not.toHaveBeenCalled();
  });

  it('changes external effort without publishing an execution choice or replacing the model', async () => {
    getExecutorModels.mockResolvedValue(executorModelsPayload({
      source: 'negotiated', provenance: 'acp_negotiation',
      models: { state: 'ready', values: ['vendor/sonnet'] },
      thinking_levels: { state: 'ready', values: ['medium', 'high'] },
    }));
    const onChangeExecution = vi.fn();
    const onChangeEffort = vi.fn();
    const choice = { ...EXTERNAL_BARE, overrides: { model: 'vendor/sonnet', thinking: 'medium' } };
    const { container } = await renderComposer({ execution: choice, onChangeExecution, onChangeEffort, effort: 'medium' });
    const trigger = container.querySelector('#composer-execution-select')!;
    expect(trigger.textContent).toContain('vendor/sonnet');
    expect(container.textContent).not.toContain('This engine did not report its models.');
    await click(trigger);
    const high = container.querySelector<HTMLButtonElement>('[data-execution-effort="high"]')!;
    expect(high).not.toBeNull();
    await click(high);
    expect(onChangeEffort).toHaveBeenCalledWith('high');
    expect(onChangeExecution).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain('vendor/sonnet');
    expect(trigger.textContent).toContain('High');
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
    await pressKey(composerInput(container), { key: 'Enter' });
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
    const diagnostic = container.querySelector<HTMLElement>('[data-selection-diagnostic][role="status"]');
    expect(diagnostic?.textContent).toContain('Invalid model config');
    expect(diagnostic?.className).toContain('overflow-y-auto');
    expect(diagnostic?.className).toContain('max-h-');
    expect(container.querySelector('[data-selection-diagnostic] button')?.textContent).toBe('Retry');
    await pressKey(composerInput(container), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('portals upward AddMenu via Base UI Popover.Portal so card bottom bounds never clip it', async () => {
    const { container } = await renderComposer({ value: '' });
    await openAddMenu(container);
    const panel = document.querySelector<HTMLElement>('[data-add-panel]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('[data-composer-card]')).toBeNull();
  });

  it('keeps a removed model visible, blocks sending, and keeps the input and reselect path usable', async () => {
    const onSend = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ model: 'fixture/deleted', value: 'hello', onSend, onChangeModel });
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('fixture/deleted');
    const input = composerInput(container);
    expect(input.getAttribute('contenteditable')).toBe('true');
    await pressKey(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await click(container.querySelector('#composer-model-select')!);
    const valid = [...container.querySelectorAll('[role="option"]')].find((node) => node.getAttribute('data-option-value') === 'fixture/kiki-pro')!;
    await click(valid);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-pro');
  });

  it('opens the model chip menu straight from the invalid-model sentence', async () => {
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ model: 'fixture/deleted', value: 'hello', onChangeModel });
    const sentence = container.querySelector('[data-selection-diagnostic] button')!;
    expect(sentence.textContent).toContain('fixture/deleted');
    expect(container.querySelector('#composer-model-select')?.getAttribute('aria-expanded')).toBe('false');

    // The sentence is the recovery: one tap opens the chip's own catalog menu.
    await click(sentence);
    expect(container.querySelector('#composer-model-select')?.getAttribute('aria-expanded')).toBe('true');
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
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('', [image], undefined);
  });

  it.each(['paste', 'drop'])('adds an image through %s while editing without inserting its filename as text', async (gesture) => {
    const onChangeAttachments = vi.fn();
    const onChange = vi.fn();
    const { container } = await renderComposer({ value: 'queued', onChange, ...queueEditProps({ onChangeAttachments }) });
    const area = composerInput(container);
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
    await pressKey(composerInput(container), { key: 'Enter' });
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
    const area = composerInput(container);
    await pressKey(area, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await pressKey(area, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('/goal edited', [image], { presentation: undefined });
    expect(onActivateSkill).not.toHaveBeenCalled();
  });

  it('ends a message edit from a quiet X beside Send, not from a row below', async () => {
    const onSend = vi.fn(async () => {});
    const onQueueEditCancel = vi.fn();
    const { container } = await renderComposer({ value: 'edited text', messageEditing: true, onSend, onQueueEditCancel });
    const cancel = container.querySelector<HTMLButtonElement>('[data-edit-cancel]')!;
    const send = container.querySelector<HTMLButtonElement>('[data-edit-submit]')!;
    // One quiet round glyph: the words live on its tooltip and its accessible
    // name, so no second line of controls sits under the composer.
    expect(cancel.textContent).toBe('');
    expect(cancel.getAttribute('aria-label')).toBe('Cancel');
    expect(cancel.getAttribute('title')).toBe('Cancel');
    // It stands in Send's own row, immediately before it.
    expect(cancel.parentElement).toBe(send.parentElement?.parentElement);
    expect(cancel.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await click(cancel);
    expect(onQueueEditCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    // A plain composer has no such control at all.
    const { container: plain } = await renderComposer({ value: 'hello' });
    expect(plain.querySelector('[data-edit-cancel]')).toBeNull();
  });

  it('holds the edit X while the submit is in flight, and Escape cannot abandon it either', async () => {
    const onSend = vi.fn(() => new Promise<void>(() => {}));
    const onQueueEditCancel = vi.fn();
    const { container } = await renderComposer({ value: 'edited text', messageEditing: true, onSend, onQueueEditCancel });
    const textarea = composerInput(container);
    const cancel = () => container.querySelector<HTMLButtonElement>('[data-edit-cancel]')!;
    expect(cancel().disabled).toBe(false);
    await pressKey(textarea, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(cancel().disabled).toBe(true);
    await pressKey(textarea, { key: 'Escape' });
    expect(onQueueEditCancel).not.toHaveBeenCalled();
  });

  it('takes the caret when it opens a message edit, and only then', async () => {
    // The editor's own entry: with both of its props set it focuses its field…
    const { container } = await renderComposer({ value: 'edited text', messageEditing: true, autoFocus: true });
    expect(document.activeElement).toBe(container.querySelector('[data-composer-input][contenteditable]'));
    // …a composer that autofocuses for another reason is not this editor…
    const { container: plain } = await renderComposer({ value: 'hello', autoFocus: true });
    expect(document.activeElement).not.toBe(composerInput(plain));
    // …and a field that cannot hold a caret yet waits for the load, then takes it.
    const { container: gated, rerender } = await renderComposer({ value: 'edited text', messageEditing: true, autoFocus: true, disabled: true });
    expect(document.activeElement).not.toBe(composerInput(gated));
    await rerender({ value: 'edited text', messageEditing: true, autoFocus: true, disabled: false });
    expect(document.activeElement).toBe(composerInput(gated));
  });

  it('routes Enter to the queue edit confirm instead of a fresh send', async () => {
    const onSend = vi.fn();
    const props = queueEditProps({ onSend });
    const { container } = await renderComposer({ value: 'edited queued text', ...props });
    const textarea = composerInput(container);
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Confirm edit"]')!;

    expect(sendButton.disabled).toBe(false);
    await pressKey(textarea, { key: 'Enter' });
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('edited queued text', [], undefined);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('skips the slash typo guard while editing a queued message', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: '/not-a-skill at all', ...props });
    const textarea = composerInput(container);

    await pressKey(textarea, { key: 'Enter' });
    // A slash-looking edit is queue text, not a command attempt: no guard.
    expect(props.onQueueEditConfirm).toHaveBeenCalledExactlyOnceWith('/not-a-skill at all', [], undefined);
    expect(container.textContent).not.toContain('Send as plain text');
  });

  it('cancels the edit with Escape and from the banner', async () => {
    const props = queueEditProps();
    const { container } = await renderComposer({ value: 'queued text', ...props });
    const textarea = composerInput(container);

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
    name: 'agent', source: 'user', source_file: '/fixture/profiles/agent.md', main: true, disabled: false, routes: [],
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
      { ...menuProfile, name: 'outside-profile', source_file: '/fixture/profiles/outside.md', pinned_model_alias: 'fixture/outside', effective_model_aliases: ['fixture/outside'] },
    ] });
  });
  it('warns for hard-menu exclusions but lets main users select and send without hiding profiles', async () => {
    const onChangeModel = vi.fn();
    const onSend = vi.fn();
    const props = { agentProfile: 'agent', model: 'fixture/kiki-pro', value: 'hello', onChangeModel, onSend, onChangeAgentProfile: vi.fn(), execution: NATIVE_AGENT, onChangeExecution: vi.fn() };
    const { container, rerender } = await renderComposer(props);
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    expect(container.querySelector('[data-model-domain-note]')).toBeNull();
    await act(async () => (container.querySelector<HTMLButtonElement>('#composer-model-select') ?? container.querySelector<HTMLButtonElement>('#composer-execution-select'))!.click());
    const outside = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes('fixture/outside'))!;
    expect(outside.getAttribute('aria-disabled')).not.toBe('true');
    expect(outside.textContent).toContain('profile:agent.restrict_models_to_menu');
    await act(async () => outside.click());
    const applyBtn = document.body.querySelector<HTMLButtonElement>('[data-execution-apply]');
    if (applyBtn) await act(async () => applyBtn.click());
    expect(onChangeModel).toHaveBeenCalledWith('fixture/outside');
    await rerender({ ...props, model: 'fixture/outside' });
    expect(container.querySelector('[data-model-domain-note]')?.textContent).toContain('profile:agent.restrict_models_to_menu');
    expect(container.querySelector('[data-model-menu-warning]')).toBeNull();
    await act(async () => composerInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
    await act(async () => (container.querySelector<HTMLButtonElement>('#composer-profile-select') ?? container.querySelector<HTMLButtonElement>('#composer-execution-select'))!.click());
    expect([...document.body.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes('outside-profile'))).toBe(true);
  });
  it('does not warn or block main choices outside a recommended menu or stale projection', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ ...menuProfile, restrict_models_to_menu: false,
      model_constraints_active: false, preferred_models: ['fixture/kiki-pro'] }] });
    const onSend = vi.fn();
    const { container } = await renderComposer({ agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-domain-note]')).toBeNull();
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('#composer-model-select')!.click());
    const outside = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.includes('fixture/outside'))!;
    expect(outside.getAttribute('aria-disabled')).not.toBe('true');
    expect(outside.textContent).not.toContain('profile:agent');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => composerInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it.each(['pending', 'failed'])('does not invent a main restriction when capabilities are %s', async (status) => {
    getAgentCapabilities.mockImplementation(() => status === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('Unavailable')));
    const onSend = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => composerInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it('warns without blocking a main hard allow/deny domain when menu restriction is off', async () => {
    listNamedAgentProfiles.mockResolvedValue({ items: [{ ...menuProfile, restrict_models_to_menu: false, model_constraints_active: true,
      deny_models: ['fixture/outside'] }] });
    const onSend = vi.fn();
    const { container } = await renderComposer({ agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(container.querySelector('[data-model-domain-note]')?.textContent).toContain('profile:agent');
    await act(async () => composerInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
  it.each(['pending', 'failed'])('keeps subagent model choices usable when bound capabilities are %s', async (status) => {
    getAgentCapabilities.mockImplementation(() => status === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('Unavailable')));
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', agentId: 'child', variant: 'subagent', agentProfile: 'agent', model: 'fixture/kiki-pro', onChangeModel });
    await click(container.querySelector('#composer-model-select')!);
    const outside = container.querySelector<HTMLElement>('[data-option-value="fixture/outside"]')!;
    expect(outside.getAttribute('aria-disabled')).not.toBe('true');
    await click(outside);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/outside');
  });

  it('uses the frozen session domain instead of a newer disk declaration', async () => {
    getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: true, targets: [],
      profile: { name: 'agent', restrict_models_to_menu: true, effective_model_aliases: ['fixture/outside'] },
    });
    const onSend = vi.fn();
    const { container } = await renderComposer({ sessionId: 'saved-session', agentProfile: 'agent', model: 'fixture/outside', value: 'hello', onSend });
    expect(getAgentCapabilities).toHaveBeenCalledWith({ session_id: 'saved-session', agent_id: 'main' });
    expect(container.querySelector('[data-model-menu-blocked]')).toBeNull();
    await act(async () => composerInput(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });
});

describe('Composer on coarse pointers (phone contract)', () => {
  // jsdom has no matchMedia; `(pointer: coarse)` is the only query the
  // composer asks about. Stubbed per test so the desktop suites keep running
  // without the API at all.
  const mediaWindow = window as unknown as Record<string, unknown>;
  let originalMatchMedia: unknown;

  function stubCoarsePointer(): void {
    mediaWindow['matchMedia'] = (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  beforeEach(() => {
    originalMatchMedia = mediaWindow['matchMedia'];
  });

  afterEach(() => {
    if (originalMatchMedia === undefined) delete mediaWindow['matchMedia'];
    else mediaWindow['matchMedia'] = originalMatchMedia;
  });

  it('turns the software-keyboard Enter into a newline; sending belongs to the button', async () => {
    stubCoarsePointer();
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'mobile draft', onSend });
    const textarea = composerInput(container);
    expect(textarea.getAttribute('enterkeyhint')).toBe('enter');

    await pressKey(textarea, { key: 'Enter' });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('still sends from a hardware keyboard: Ctrl/Cmd+Enter steers the running turn', async () => {
    stubCoarsePointer();
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ value: 'steer this', busy: true, onSend, onSendNow });
    const textarea = composerInput(container);

    await pressKey(textarea, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(onSendNow).toHaveBeenCalledWith('steer this', []);
    expect(onSend).not.toHaveBeenCalled();

    // …while the IME's plain Enter stays the newline key even mid-turn.
    await pressKey(textarea, { key: 'Enter' });
    await settle();
    expect(onSend).not.toHaveBeenCalled();
    expect(onSendNow).toHaveBeenCalledTimes(1);
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

  it.each([
    { label: 'in queue-edit mode', props: { busy: true, queueEditing: true, onQueueEditConfirm: vi.fn() } },
    { label: 'in message-edit mode', props: { busy: false, messageEditing: true } },
    { label: 'when sendTimingDefault is omitted', props: { busy: false, sendTimingDefault: undefined } },
  ])('stays closed and hides caret $label', async ({ props }) => {
    const { container } = await renderComposer({ value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn(), ...props });
    expect(menu(container)).toBeNull();
    await hoverOpen(container);
    expect(menu(container)).toBeNull();
    expect(sendButton(container).getAttribute('aria-haspopup')).toBeNull();
    expect(container.querySelector('[data-send-timing-caret]')).toBeNull();
  });

  it('shows the split caret while idle with default, subagents_done, and tasks_done (omitting send-now and agent_idle)', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container, rerender } = await renderComposer({
      busy: false,
      busySendsNow: true,
      value: 'hello',
      sendTimingDefault: 'agent_idle',
      onSend,
      onSendNow,
    });
    const caret = container.querySelector<HTMLButtonElement>('[data-send-timing-caret]');
    expect(caret).not.toBeNull();
    expect(sendButton(container).getAttribute('aria-haspopup')).toBe('menu');

    // Hovering the plain Send button while idle stays quiet; clicking the caret opens the menu.
    await hoverOpen(container);
    expect(menu(container)).toBeNull();

    await click(caret!);
    expect(menu(container)).not.toBeNull();
    expect(container.querySelector('[data-send-timing="now"]')).toBeNull();
    expect(container.querySelector('[data-send-timing="agent_idle"]')).toBeNull();
    expect(rowLabels(container)).toEqual([
      'SendSend immediately',
      'Send after subagentsStarts once the running subagents finish',
      'Send after tasksStarts once every running task finishes',
    ]);

    await click(menuRow(container, 'tasks_done'));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello', [], { appendTiming: 'tasks_done' });
    expect(onSendNow).not.toHaveBeenCalled();
    expect(menu(container)).toBeNull();

    await rerender({
      busy: false,
      busySendsNow: true,
      value: 'again',
      sendTimingDefault: 'agent_idle',
      onSend,
      onSendNow,
    });
    const nextCaret = container.querySelector<HTMLButtonElement>('[data-send-timing-caret]')!;

    // Moving from caret to plain Send before the 180ms hover delay expires cancels the pending open.
    await act(async () => {
      nextCaret.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      nextCaret.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: sendButton(container) }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(menu(container)).toBeNull();

    // Keyboard activation (detail === 0) on the caret focuses the first row, and Escape returns focus to the caret.
    nextCaret.focus();
    await act(async () => {
      nextCaret.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(menu(container)).not.toBeNull();
    expect(document.activeElement).toBe(menuRow(container, 'default'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu(container)).toBeNull();
    expect(document.activeElement).toBe(nextCaret);
  });

  it('keeps the compact context meter ring visible on narrow toolbars even at low usage', async () => {
    const { container } = await renderComposer({
      value: '',
      contextUsage: { used: 10_000, limit: 200_000 },
    });
    const meter = container.querySelector<HTMLElement>('[data-context-meter]');
    expect(meter).not.toBeNull();
    const wrapper = meter!.closest<HTMLElement>('.flex.shrink-0.items-center');
    expect(wrapper?.className).toContain('@max-[17.5rem]/toolbar:hidden');
    expect(wrapper?.className).not.toContain('@max-[26.25rem]/toolbar:hidden');
    const percentSpan = meter!.querySelector<HTMLElement>('span.tabular-nums');
    expect(percentSpan?.className).toContain('@max-[24rem]/toolbar:sr-only');
  });

  it('leads with send-now and offers all three deferred timings where a busy plain send already steers (busySendsNow)', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({
      busy: true, busySendsNow: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow,
    });
    await hoverOpen(container);
    expect(menu(container)).not.toBeNull();
    expect(container.querySelector('[data-send-timing="default"]')).toBeNull();
    expect(rowLabels(container)).toEqual([
      'Send nowSend into the running turn — read before the next step',
      'Send after this turnStarts when the current turn ends',
      'Send after subagentsStarts once the running subagents finish',
      'Send after tasksStarts once every running task finishes',
    ]);
    await click(menuRow(container, 'agent_idle'));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello', [], { appendTiming: 'agent_idle' });
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it('opens on hover while busy and lists the plain send, send-now and both deferred timings', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await hoverOpen(container);
    expect(menu(container)).not.toBeNull();
    expect(menu(container)!.getAttribute('aria-label')).toBe('Send timing');
    expect(rowLabels(container)).toEqual([
      'SendDefault timing: after this turn',
      'Send nowSend into the running turn — read before the next step',
      'Send after subagentsStarts once the running subagents finish',
      'Send after tasksStarts once every running task finishes',
    ]);
  });

  it('stays open when the pointer re-enters during the leave grace, then sends from the menu', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow: vi.fn() });
    const root = container.querySelector('[data-send-timing-root]')!;
    await hoverOpen(container);
    await act(async () => {
      root.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    await act(async () => {
      root.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(menu(container)).not.toBeNull();
    await click(menuRow(container, 'tasks_done'));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello', [], { appendTiming: 'tasks_done' });
  });

  it('opens the same menu from the caret — the tap path where hover does not exist', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    const caret = container.querySelector<HTMLButtonElement>('button[aria-label="Send timing"]')!;
    expect(caret.getAttribute('aria-haspopup')).toBe('menu');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(menu(container)).toBeNull();

    await click(caret);
    expect(menu(container)).not.toBeNull();
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-controls')).toBe(menu(container)!.id);

    await click(caret);
    expect(menu(container)).toBeNull();
  });

  it('names a non-default configured timing on the plain row and omits send-now without steer handler', async () => {
    const first = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'tasks_done', onSendNow: vi.fn() });
    await hoverOpen(first.container);
    expect(rowLabels(first.container)[0]).toBe('SendDefault timing: after tasks');
    await act(async () => { first.root.unmount(); });

    const withoutSteer = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle' });
    await hoverOpen(withoutSteer.container);
    expect(rowLabels(withoutSteer.container)).toHaveLength(3);
    expect(withoutSteer.container.querySelector('[data-send-timing="now"]')).toBeNull();
  });

  it.each([
    { timing: 'default' as const, target: 'onSend', args: ['hello', []] },
    { timing: 'subagents_done' as const, target: 'onSend', args: ['hello', [], { appendTiming: 'subagents_done' }] },
    { timing: 'tasks_done' as const, target: 'onSend', args: ['hello', [], { appendTiming: 'tasks_done' }] },
    { timing: 'now' as const, target: 'onSendNow', args: ['hello', []] },
  ])('row $timing dispatches exact payload', async ({ timing, target, args }) => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({ busy: true, value: 'hello', sendTimingDefault: 'agent_idle', onSend, onSendNow });
    await hoverOpen(container);
    await click(menuRow(container, timing));
    if (target === 'onSend') {
      expect(onSend.mock.calls).toEqual([args]);
      expect(onSendNow).not.toHaveBeenCalled();
    } else {
      expect(onSendNow.mock.calls).toEqual([args]);
      expect(onSend).not.toHaveBeenCalled();
    }
    expect(menu(container)).toBeNull();
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

describe('Composer with a pending engine/profile switch', () => {
  // A confirmed switch waits for the next message and the running turn cannot
  // rebind, so "send now" would silently queue. While one is pending the
  // composer names the real result on the send button title, drops the
  // send-now row from the timing menu, and omits the working-line hint whose
  // "sends now" wording would promise what the key no longer does (the
  // pending chip on the same row already names the switch). Neither the key
  // nor the button change what they do.

  const PENDING_TITLE = 'Queue this prompt (Enter) — the pending switch applies with this message';

  it.each([
    {
      label: 'pending execution switch while busy',
      props: { busy: true, executionPending: true },
      title: PENDING_TITLE,
      ariaLabel: 'Queue prompt',
      hasSendNowHint: false,
    },
    {
      label: 'pending runtime model change while busy',
      props: { busy: true, pendingRuntimeControls: { model: 'fixture/other-model' }, working: { lastResponseAt: undefined } },
      title: PENDING_TITLE,
      ariaLabel: 'Queue prompt',
      hasSendNowHint: false,
    },
    {
      label: 'idle even with executionPending',
      props: { busy: false, executionPending: true },
      title: 'Send (Enter)',
      ariaLabel: 'Send message',
      hasSendNowHint: undefined,
    },
  ])('send button title and label: $label', async ({ props, title, ariaLabel, hasSendNowHint }) => {
    const { container } = await renderComposer({ value: 'hello', onSendNow: vi.fn(), ...props });
    const button = container.querySelector<HTMLButtonElement>('button[data-send-ready]')!;
    expect(button.getAttribute('title')).toBe(title);
    expect(button.getAttribute('aria-label')).toBe(ariaLabel);
    if (hasSendNowHint === false) expect(container.querySelector('[data-composer-send-now-hint]')).toBeNull();
  });

  it('omits the send-now row from the timing menu and keeps the real queue choices', async () => {
    const { container } = await renderComposer({ busy: true, value: 'hello', executionPending: true, sendTimingDefault: 'agent_idle', onSendNow: vi.fn() });
    await act(async () => {
      container.querySelector('[data-send-timing-root]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    const rows = [...container.querySelectorAll<HTMLElement>('[data-send-timing-menu] [data-menu-row]')]
      .map((row) => row.textContent);
    expect(container.querySelector('[data-send-timing="now"]')).toBeNull();
    expect(rows).toEqual([
      'SendDefault timing: after this turn',
      'Send after subagentsStarts once the running subagents finish',
      'Send after tasksStarts once every running task finishes',
    ]);
  });

  it('keeps the send-now key working — it fires onSendNow, which queues with the switch', async () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const { container } = await renderComposer({
      value: 'hello', busy: true, executionPending: true, onSend, onSendNow,
      working: { lastResponseAt: undefined },
    });
    // The hint's "sends now" wording would promise what the key no longer
    // does, so it leaves the row; the pending chip beside it names the switch.
    expect(container.querySelector('[data-composer-send-now-hint]')).toBeNull();

    const textarea = composerInput(container);
    await pressKey(textarea, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(onSendNow).toHaveBeenCalledWith('hello', []);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('restores the send-now hint once the pending switch is reverted', async () => {
    const seat = {
      value: 'hello', busy: true, onSendNow: vi.fn(),
      working: { lastResponseAt: undefined },
    };
    const { container, rerender } = await renderComposer({ ...seat, executionPending: true });
    expect(container.querySelector('[data-composer-send-now-hint]')).toBeNull();

    await rerender({ ...seat, executionPending: false });
    await settle();
    expect(container.querySelector('[data-composer-send-now-hint]')?.textContent)
      .toContain('⌘/Ctrl+Enter sends now');
  });

  it('keeps the plain wording without a pending binding or model change', async () => {
    const { container } = await renderComposer({
      value: 'hello', busy: true, sendTimingDefault: 'agent_idle', onSendNow: vi.fn(),
    });
    const button = container.querySelector<HTMLButtonElement>('button[data-send-ready]')!;
    expect(button.getAttribute('title')).toBe('Queue this prompt (Enter)');
    await act(async () => {
      container.querySelector('[data-send-timing-root]')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(container.querySelector('[data-send-timing="now"]')).not.toBeNull();
  });
});

describe('Composer input accessible name', () => {
  it('stays fixed while the placeholder drifts with state', async () => {
    const { container, rerender } = await renderComposer({ value: '', busy: false });
    const input = composerInput(container);
    expect(input.getAttribute('aria-label')).toBe('Message input');
    expect(input.querySelector('.cm-placeholder')?.textContent).toBe('What should Kiki work on…');
    await rerender({ value: '', busy: true });
    expect(input.getAttribute('aria-label')).toBe('Message input');
    expect(input.querySelector('.cm-placeholder')?.textContent).not.toBe('What should Kiki work on…');
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
    await click(container.querySelector('[data-composer-ssh-host="example-host"] button')!);
    expect(sshAdd).not.toHaveBeenCalled();
    expect(sshSessionHosts).not.toHaveBeenCalled();
    // External bare ContextStrip shows the summary trigger outside the card.
    const statusLine = container.querySelector('[data-composer-status-line]')!;
    const sshStrip = statusLine.querySelector('[data-composer-ssh-strip]')!;
    expect(sshStrip).not.toBeNull();
    expect(sshStrip.textContent).toContain('Example host');
    expect(sshStrip.textContent).not.toContain('to join');
    expect(container.querySelector('[data-composer-card] [data-composer-ssh-strip]')).toBeNull();
    await click(container.querySelector('[data-add-menu-trigger]')!);
    await click(container.querySelector('button[aria-label="Send message"]')!);
    // No session exists yet, so the host travels to the draft, which joins it
    // before the first message. It is not an attachment on the draft's tray.
    expect(onSend).toHaveBeenCalledWith('Inspect the host', [{ kind: 'ssh', id: 'example-host', name: 'Example host' }]);
    expect(container.querySelector('[data-context-tray] [data-composer-ssh-chip]')).toBeNull();
    expect(container.querySelector('[data-attachment-chips]')?.textContent ?? '').not.toContain('Example host');
  });

  it('carries a preselected SSH host with the first skill activation on /new', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    listDraftSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const { container } = await renderComposer({ value: '/review --fix', onActivateSkill });
    await openAddMenu(container);
    await click(container.querySelector('[data-add-menu-ssh]')!);
    await click(container.querySelector('[data-composer-ssh-host="example-host"] button')!);
    await click(container.querySelector('[data-add-menu-trigger]')!);
    await click(container.querySelector('button[aria-label="Send message"]')!);
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix',
      [{ kind: 'ssh', id: 'example-host', name: 'Example host' }], '/review --fix');
    expect(sshAdd).not.toHaveBeenCalled();
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
    expect(container.querySelector('[data-composer-status-line] [data-composer-ssh-strip]')?.textContent).toContain('Example host');
    expect(container.querySelector('[data-composer-ssh-strip]')?.textContent).not.toContain('Session');
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    await rerender({ sessionId: 'session-example', value: 'And now the build', onSend, onActivateSkill });
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    await rerender({ sessionId: 'session-example', value: '/review --fix', onSend, onActivateSkill });
    await settleMany(8);
    const textarea = composerInput(container);
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend.mock.calls.map((call) => call[1])).toEqual([[], []]);
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('review', '--fix', [], '/review --fix');
    // Still resident in the external ContextStrip after all of it.
    expect(container.querySelector('[data-composer-status-line] [data-composer-ssh-toggle]')?.textContent).toContain('Example host');
    expect(container.querySelector('[data-context-tray] [data-composer-ssh-chip]')).toBeNull();
    expect(sshRemove).not.toHaveBeenCalled();
  });

  it('leaves the session immediately from the upward SSH popover and reads the server list back', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect the host', onSend: vi.fn() });
    await click(container.querySelector('[data-composer-ssh-toggle]')!);
    expect(document.querySelector('[data-composer-ssh-chip="example-host"]')).not.toBeNull();
    sshSessionHosts.mockResolvedValue({ hosts: [] });
    await click(document.querySelector('[data-composer-ssh-chip-remove]')!);
    await settle();
    expect(sshRemove).toHaveBeenCalledWith('session-example', 'example-host');
    // The server's read is the only thing that decides what the strip shows.
    for (let index = 0; index < 4; index += 1) await settle();
    expect(sshSessionHosts.mock.calls.at(-1)).toEqual(['session-example']);
    expect(document.querySelector('[data-composer-ssh-chip]')).toBeNull();
    // The last host leaving takes the whole strip with it.
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    // The way back in is untouched — the ＋ menu still opens the host list.
    await openAddMenu(container);
    expect(container.querySelector('[data-add-menu-ssh]')).not.toBeNull();
  });

  it.each([
    { label: 'settled empty host list', pending: false },
    { label: 'unread pending host list', pending: true },
  ])('draws no SSH strip for $label instead of showing zero', async ({ pending }) => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    if (pending) sshSessionHosts.mockReturnValue(new Promise(() => {}));
    else sshSessionHosts.mockResolvedValue({ hosts: [] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend: vi.fn() });
    await settleMany(4);
    if (!pending) expect(sshSessionHosts).toHaveBeenCalledWith('session-example');
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    expect(container.querySelector('[data-composer-ssh-toggle]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('SSH 0');
  });

  it('keeps the strip for the host context across a send, not only while a request runs', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend });
    await click(container.querySelector('button[aria-label="Send message"]')!);
    await settle();
    await rerender({ sessionId: 'session-example', value: 'Again', onSend });
    for (let index = 0; index < 4; index += 1) await settle();
    expect(container.querySelector('[data-composer-status-line] [data-composer-ssh-strip]')).not.toBeNull();
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Example host');
  });

  it('re-reads the joined list when another session opens', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container, rerender } = await renderComposer({ sessionId: 'session-example', value: 'a', onSend: vi.fn() });
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Example host');
    sshSessionHosts.mockResolvedValue({ hosts: [] });
    await rerender({ sessionId: 'session-other', value: 'a', onSend: vi.fn() });
    await settle();
    expect(sshSessionHosts).toHaveBeenCalledWith('session-other');
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
  });

  it('opens its own host list upwards from the external strip, and closes on Escape', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({ hosts: [{ host: sshHost }] });
    const { container } = await renderComposer({ sessionId: 'session-example', value: 'Inspect', onSend: vi.fn() });
    const toggle = container.querySelector('[data-composer-ssh-toggle]')!;
    await click(toggle);
    expect(document.querySelector('[data-composer-ssh-list] [data-composer-ssh-panel]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-composer-ssh-list]')).toBeNull();
  });

  it('resets /new preselection on a session transition, without deleting persistent hosts', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const { container, rerender } = await renderComposer();
    await openAddMenu(container);
    await click(container.querySelector('[data-add-menu-ssh]')!);
    await click(container.querySelector('[data-composer-ssh-host="example-host"] button')!);
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Example host');
    await rerender({ sessionId: 'session-example' });
    await rerender({});
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
    expect(sshRemove).not.toHaveBeenCalled();
  });

  it.each(['applying', 'next_step', 'next_message'] as const)('shows an ordinary binding setting as a quiet %s label instead of a queued switch', async (state) => {
    listModels.mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 131072, support_efforts: ['high', 'max'], default_effort: 'high' }] });
    const { container } = await renderComposer({ model: 'fixture/kiki-pro', efforts: ['high', 'max'], effort: 'high', bindingSetting: { model: 'fixture/kiki-pro', thinking: 'max', state } });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('[data-binding-setting]')?.textContent).toBe(state === 'applying' ? 'Applying…' : state === 'next_step' ? 'Applies from the next step' : 'Applies from the next message');
    expect(container.querySelector('[data-model-switch-pending]')).toBeNull();
    expect(container.querySelector('[data-model-switch-pending-line]')).toBeNull();
    expect(container.querySelector('#composer-model-select')?.textContent).toContain('Max');
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

  it.each([
    { to: 'kiki-lite', targetThinking: 'max', expected: 'Reasoning change → max' },
    { to: 'fixture/model', targetThinking: null, expected: 'Reasoning change → Default' },
  ])('names a pending effort change ($expected) on both pending surfaces', async ({ to, targetThinking, expected }) => {
    listModels.mockResolvedValue({ items: [{ id: 'fixture/kiki-lite', provider_id: 'fixture', remote_id: 'kiki-lite', display_name: 'Kiki Lite', max_context_size: 131072 }] });
    const { container } = await renderComposer({ pendingModelSwitch: { from: to === 'kiki-lite' ? 'fixture/kiki-lite' : to, to, mode: 'direct', originalThinking: 'high', targetThinking } });
    await settleMany();
    const line = container.querySelector<HTMLElement>('[data-model-switch-pending-line]')!;
    const chip = container.querySelector<HTMLElement>('[data-model-switch-pending]')!;
    expect(line.textContent).toContain(expected);
    expect(chip.textContent).toBe(expected);
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


describe('Composer explicit profile file recovery', () => {
  it('previews a typed host path without stealing focus and applies only its canonical file source', async () => {
    previewAgentProfileFile.mockResolvedValue({ profile: {
      name: 'helper', source: 'file', source_file: '/workspace/profiles/helper.md',
      main: false, disabled: false, routes: [], executor: 'example-acp',
    } });
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({
      execution: { executor: 'native', profile: 'agent', overrides: undefined },
      onChangeExecution, agentProfileCatalogMode: { mode: 'cwd', cwd: '/workspace', effective: true },
    });
    await click((container.querySelector('[data-profile-trigger]') ?? container.querySelector('[data-execution-trigger]'))!);
    await click(container.querySelector('[data-execution-file-open]')!);
    const input = container.querySelector<HTMLInputElement>('[data-execution-file-path]')!;
    input.focus();
    await setInputValue(input, 'profiles/helper.md');
    expect(document.activeElement).toBe(input);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await settle();
    await settle();
    expect(previewAgentProfileFile).toHaveBeenCalledWith({ path: 'profiles/helper.md', cwd: '/workspace' }, { signal: expect.any(AbortSignal) });
    expect(onChangeExecution).not.toHaveBeenCalled();
    await click(container.querySelector('[data-execution-file-apply]')!);
    expect(onChangeExecution).toHaveBeenCalledWith({ executor: 'example-acp', profile: undefined, profile_file: '/workspace/profiles/helper.md', overrides: undefined });
  });
  const profile: NamedAgentProfile = {
    name: 'helper', source: 'file', source_file: '/workspace/helper.md', main: false,
    disabled: false, routes: [], pinned_model_alias: 'fixture/kiki-pro',
  };
  const execution = { executor: 'native', profile: undefined, profile_file: profile.source_file, overrides: undefined };

  it('validates a non-main file outside the curated catalog and clears its source when choosing bare', async () => {
    previewAgentProfileFile.mockResolvedValue({ profile });
    const onChangeExecution = vi.fn();
    const { container } = await renderComposer({ value: 'Hello', execution, onChangeExecution, agentProfile: 'helper' });
    expect(previewAgentProfileFile).toHaveBeenCalledWith({ path: profile.source_file, cwd: undefined, workspace_id: undefined }, { signal: expect.any(AbortSignal) });
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    const trigger = (container.querySelector('[data-profile-trigger]') ?? container.querySelector('[data-execution-trigger]'))!;
    expect(trigger.textContent).toContain('helper.md');
    await click(trigger);
    const unspecified = container.querySelector<HTMLElement>('[data-profile-unspecified]');
    if (unspecified) {
      await click(unspecified);
    } else {
      const bare = container.querySelector('[data-execution-bare="native"]')!;
      expect(bare.getAttribute('aria-selected')).toBe('false');
      await click(bare);
    }
    expect(onChangeExecution).toHaveBeenCalledWith({ executor: 'native', profile: undefined, profile_file: undefined, overrides: undefined });
  });

  it('keeps a failed file preview local, sends the saved choice and offers retry', async () => {
    previewAgentProfileFile.mockRejectedValue(new ApiError({ msg: 'Profile file is unavailable', code: 40001, data: null }));
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'Hello', execution, onChangeExecution: vi.fn(), agentProfile: 'helper', onSend });
    const diagnostic = container.querySelector('[data-selection-diagnostic][role="status"]')!;
    expect(diagnostic.textContent).toContain('Profile file is unavailable');
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(button.disabled).toBe(false);
    await click(button);
    expect(onSend).toHaveBeenCalledWith('Hello', []);
    previewAgentProfileFile.mockResolvedValue({ profile });
    await click(diagnostic.querySelector('button')!);
    await settle();
    await settle();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
  });

  it('sends a saved file while the preview is pending', async () => {
    previewAgentProfileFile.mockReturnValue(new Promise(() => {}));
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'Hello', execution, onChangeExecution: vi.fn(), agentProfile: 'helper', onSend });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(button.disabled).toBe(false);
    await click(button);
    expect(onSend).toHaveBeenCalledWith('Hello', []);
  });

  it('preserves a successful file preview’s explicit off choice', async () => {
    previewAgentProfileFile.mockResolvedValue({ profile: { ...profile, disabled: true } });
    const { container, queryClient } = await renderComposer({ value: 'Hello', execution, onChangeExecution: vi.fn(), agentProfile: 'helper' });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
    previewAgentProfileFile.mockRejectedValue(new Error('preview offline'));
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['profile-file-preview'] }); });
    await settle();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled).toBe(true);
  });

  it('clears external_connection_id and external_connection_name when picking default from external client', async () => {
    const onChangeExecution = vi.fn();
    const externalChoice = {
      executor: 'claude-acp',
      profile: undefined,
      profile_file: undefined,
      overrides: undefined,
      external_connection_id: 'conn_test_123',
      external_connection_name: 'Test Client',
    };
    const { container } = await renderComposer({ execution: externalChoice, onChangeExecution });
    const trigger = (container.querySelector('[data-profile-trigger]') ?? container.querySelector('[data-execution-trigger]'))!;
    await click(trigger);
    const unspecified = container.querySelector<HTMLElement>('[data-profile-unspecified]');
    if (unspecified) {
      await click(unspecified);
    } else {
      const bare = container.querySelector('[data-execution-bare="native"]')!;
      await click(bare);
    }
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'native',
      profile: undefined,
      profile_file: undefined,
      overrides: undefined,
      external_connection_id: undefined,
      external_connection_name: undefined,
    });
  });

  it('falls back to defaultModelOption instead of hardcoded K3 when model and effectiveModel are missing', async () => {
    const { container } = await renderComposer({
      model: undefined,
      defaultModel: undefined,
      serverDefaultModel: undefined,
      modelSource: 'server-default',
      execution: { executor: 'native', profile: undefined, overrides: undefined },
      onChangeExecution: vi.fn(),
    });
    const trigger = (container.querySelector('#composer-engine-model-select') ?? container.querySelector('#composer-execution-select'))!;
    expect(trigger.textContent).toContain('Default model');
    expect(trigger.textContent).not.toContain('K3');
  });
});


describe('Composer paged @ picker', () => {
  it('keeps an empty budget page continuable and exposes later hits without an eight-row cut', async () => {
    const hits = Array.from({ length: 12 }, (_, index) => ({ path: `src/part-${index}.ts`, name: `part-${index}.ts`, kind: 'file' as const, score: index, match_positions: [] }));
    const fsSearch = vi.fn().mockResolvedValueOnce({ items: [], next_cursor: 'page-2', sort_scope: 'page' }).mockResolvedValueOnce({ items: hits, sort_scope: 'page' });
    const onChangeAttachments = vi.fn();
    const { container } = await renderStatefulComposer({ fsSearch, onChangeAttachments });
    await typeText(composerInputOf(container), '@part');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
    await settle();
    expect(fsSearch).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('No files matching');
    await click(container.querySelector('[data-mention-file-more="more"]')!);
    await settle();
    expect(fsSearch).toHaveBeenLastCalledWith('part', { cursor: 'page-2', signal: expect.any(AbortSignal) });
    expect(container.querySelectorAll('[data-mention-file-list] [role="option"]')).toHaveLength(12);
    expect(container.querySelector('[data-mention-file-more]')).toBeNull();
    await click(container.querySelectorAll('[data-mention-file-list] [role="option"]')[11]!);
    expect(onChangeAttachments).toHaveBeenLastCalledWith([{ kind: 'file', path: 'src/part-0.ts', name: 'part-0.ts', isDir: false }]);
    expect(composerInputOf(container).value).toBe('');
  });

  it('aborts an unfinished mention page when the picker closes and never appends its late rows', async () => {
    const pending = deferred<readonly { path: string; name: string; kind: 'file'; score: number; match_positions: number[] }[]>();
    const fsSearch = vi.fn().mockReturnValue(pending.promise);
    const { container } = await renderStatefulComposer({ fsSearch });
    const textarea = composerInputOf(container);
    await typeText(textarea, '@part');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
    const signal = fsSearch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await pressKey(textarea, { key: 'Escape' });
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve([{ path: 'late.ts', name: 'late.ts', kind: 'file', score: 1, match_positions: [] }]); });
    await settle();
    expect(container.querySelector('[data-mention-file-list]')).toBeNull();
    expect(textarea.value).toBe('@part');
  });
});


it('renders and removes multiple quote chips while preserving the legacy quote caller', async () => {
  const removeItem = vi.fn();
  const removeLegacy = vi.fn();
  const { container, rerender } = await renderComposer({ quotes: [{ id: 'first', quote: 'First passage' }, { id: 'second', quote: 'Second passage' }], quote: 'Legacy passage', onRemoveQuoteItem: removeItem, onRemoveQuote: removeLegacy });
  await settle();
  expect([...container.querySelectorAll('[data-quote-chip]')].map(item => item.getAttribute('title'))).toEqual(['First passage', 'Second passage']);
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[data-quote-chip] button')[1]!.click());
  expect(removeItem).toHaveBeenCalledExactlyOnceWith('second');
  expect(removeLegacy).not.toHaveBeenCalled();
  await rerender({ quote: 'Legacy passage', onRemoveQuote: removeLegacy });
  expect(container.querySelector('[data-quote-chip]')?.getAttribute('title')).toBe('Legacy passage');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-quote-chip] button')!.click());
  expect(removeLegacy).toHaveBeenCalledTimes(1);
  await rerender({ quotes: [], quote: 'Legacy passage' });
  expect(container.querySelector('[data-quote-chip]')).toBeNull();
});

describe('Canonical 4-Layer Composer Slot Standard (Max-Loaded State)', () => {
  it('enforces Layer 1 (SSH + plugin slots) -> Layer 2 (media -> chips) -> Layer 3 (editor) -> Layer 4 (toolbar) with nothing severing tray from editor', async () => {
    connectionScope.pluginSlots = true;
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockResolvedValue({
      hosts: [
        { host: { ...sshHost, id: 'build-box', name: 'build-box' }, status: { state: 'ready' } },
        { host: { ...sshHost, id: 'staging-box', name: 'staging-box' }, status: { state: 'ready' } },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/plugins/gui-slots')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              slots: [
                {
                  pluginId: 'kiki-v42',
                  id: 'remote-seat',
                  slot: 'composer-toolbar',
                  label: { default: 'Remote Seat', zh: '远端工位' },
                  icon: 'terminal',
                  tone: 'neutral',
                  order: 10,
                  action: { kind: 'open_plugin_panel', panelId: 'workbench' },
                },
                {
                  pluginId: 'kiki-phone',
                  id: 'phone-preview',
                  slot: 'composer-toolbar',
                  label: { default: 'Phone Preview', zh: '手机预览' },
                  icon: 'smartphone',
                  tone: 'neutral',
                  order: 20,
                  action: { kind: 'open_plugin_panel', panelId: 'phone' },
                },
                {
                  pluginId: 'kiki-uu-remote',
                  id: 'uu-remote',
                  slot: 'composer-toolbar',
                  label: { default: 'UU Remote', zh: 'UU远程' },
                  icon: 'monitor',
                  tone: 'neutral',
                  order: 30,
                  action: { kind: 'open_plugin_panel', panelId: 'uu' },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const { container } = await renderComposer({
        sessionId: 'session-max-loaded',
        busy: true,
        working: { lastResponseAt: Date.now() - 1_500 },
        value: 'Check the attached screenshot and file',
        quotes: [{ id: 'q1', quote: 'Quoted snippet from earlier turn' }],
        attachments: [
          { kind: 'file', path: 'src/components/Composer.tsx', name: 'Composer.tsx', isDir: false },
          {
            kind: 'image',
            name: 'screenshot.png',
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
            previewUrl: 'data:image/png;base64,iVBORw0KGgo=',
            size: 12_400,
          },
        ],
      });
      await settle();
      await settle();

      const card = container.querySelector<HTMLElement>('[data-composer-card]');
      const tray = container.querySelector<HTMLElement>('[data-context-tray]');
      const shelf = container.querySelector<HTMLElement>('[data-context-shelf]');
      const editor = container.querySelector<HTMLElement>('[data-composer-editor]');
      const toolbar = container.querySelector<HTMLElement>('[data-composer-toolbar]');
      const statusLine = container.querySelector<HTMLElement>('[data-composer-status-line]');
      const workingLine = statusLine?.querySelector<HTMLElement>('[data-composer-working]') ?? null;
      const sshStrip = statusLine?.querySelector<HTMLElement>('[data-composer-ssh-strip]') ?? null;

      expect(card).not.toBeNull();
      expect(tray).not.toBeNull();
      expect(shelf).not.toBeNull();
      expect(editor).not.toBeNull();
      expect(toolbar).not.toBeNull();
      expect(statusLine).not.toBeNull();
      expect(workingLine).not.toBeNull();
      expect(sshStrip).not.toBeNull();
      expect(Boolean(workingLine!.compareDocumentPosition(sshStrip!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

      // Subtraction-first invariants: zero env-strip, zero plugin slots, zero SSH chips inside card!
      expect(container.querySelector('[data-composer-env-strip]')).toBeNull();
      expect(container.querySelector('[data-composer-env-divider]')).toBeNull();
      expect(card!.querySelector('[data-plugin-composer-slots]')).toBeNull();
      expect(card!.querySelector('[data-composer-ssh-strip]')).toBeNull();

      // SSH lives outside the card in the bare ContextStrip as `build-box +1`.
      expect(sshStrip!.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('build-box +1');

      // Card interior strictly holds 3 rows: 44px shelf -> editor -> toolbar, with zero elements between shelf & editor.
      const isBefore = (a: Element, b: Element) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(isBefore(tray!, editor!)).toBe(true);
      expect(isBefore(editor!, toolbar!)).toBe(true);
      expect(tray!.nextElementSibling).toBe(editor);

      // Inside single-row h-11 shelf: Image, File, and Quote share one horizontal track.
      expect(shelf!.querySelector('[data-image-tile][data-chip-variant="shelf"]')).not.toBeNull();
      expect(shelf!.querySelector('[title="src/components/Composer.tsx"][data-chip-variant="shelf"]')).not.toBeNull();
      expect(shelf!.querySelector('[data-quote-chip][data-chip-variant="shelf"]')).not.toBeNull();

      // Plugin panel slots live exclusively in top-right WorkspacePanelsControl, not duplicated inside `+` (AddMenu).
      await openAddMenu(container);
      expect(container.querySelectorAll('[data-add-menu-extensions] [data-add-extension]').length).toBe(0);
    } finally {
      connectionScope.pluginSlots = false;
      fetchSpy.mockRestore();
    }
  });
});

describe('Composer 10,000-model & 1,000+ skill virtualization scale', () => {
  it('opens a 10,000-model composer picker with <= 40 mounted options and filters instantly', async () => {
    const tenKModels = Array.from({ length: 10_000 }, (_, index) => ({
      id: `bulk/model-${index}`,
      provider_id: `provider-${index % 20}`,
      remote_id: `model-${index}`,
      display_name: `Model ${index}`,
      max_context_size: 262144,
      capabilities: ['chat', 'tool_use', 'image_in'],
      support_efforts: ['low', 'high'],
    }));
    listModels.mockResolvedValue({ items: tenKModels });
    const onChangeModel = vi.fn();

    const { container } = await renderComposer({
      model: 'bulk/model-0',
      serverDefaultModel: 'bulk/model-0',
      onChangeModel,
    });
    await settle();

    const modelTrigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(modelTrigger).not.toBeNull();
    await act(async () => { modelTrigger.click(); });

    const panel = container.querySelector<HTMLElement>('[data-select-panel]')!;
    expect(panel).not.toBeNull();
    const mountedOptions = panel.querySelectorAll('[role="option"]');
    expect(mountedOptions.length).toBeGreaterThan(0);
    expect(mountedOptions.length).toBeLessThanOrEqual(40);

    const search = panel.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'model-9999');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const matched = panel.querySelectorAll('[role="option"]');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.getAttribute('data-option-value')).toBe('bulk/model-9999');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onChangeModel).toHaveBeenCalledWith('bulk/model-9999');
  });

  it('virtualizes 1,200 skills in the / slash menu and filters cleanly', async () => {
    const skills = Array.from({ length: 1200 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Automated workflow skill number ${index}`,
      path: `/skills/skill-${index}/SKILL.md`,
      source: 'user' as const,
      user_invocable: true,
    }));
    listSessionSkills.mockResolvedValue({ skills });

    const { container } = await renderComposer({
      sessionId: 'session-1k-skills',
      value: '',
    });
    await settleMany(4);

    const input = composerInput(container);
    await act(async () => {
      setComposerInputValue(input, '/');
    });
    await settle();

    const menu = container.querySelector<HTMLElement>('[data-composer-menu]')!;
    expect(menu).not.toBeNull();
    const mountedRows = menu.querySelectorAll('[role="option"]');
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThanOrEqual(40);
    expect(Number(mountedRows[0]?.getAttribute('aria-setsize'))).toBeGreaterThanOrEqual(1200);

    await act(async () => {
      setComposerInputValue(input, '/skill-1199');
    });
    await settle();
    const narrowedRows = menu.querySelectorAll('[role="option"]');
    expect(narrowedRows).toHaveLength(1);
    expect(narrowedRows[0]?.textContent).toContain('/skill-1199');
  });
});

describe('Composer working timer', () => {
  it('ticks live working elapsed duration from 0s during TTFT and surfaces quiet age accurately', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const t0 = new Date('2026-11-26T10:00:00.000Z').getTime();
    vi.setSystemTime(t0);
    try {
      const { container, rerender } = await renderComposer({
        value: '',
        busy: true,
        working: { startedAt: t0, lastResponseAt: undefined },
      });
      const line = () => container.querySelector('[data-composer-working]');
      expect(line()?.getAttribute('data-turn-started-at')).toBe(String(t0));
      expect(line()?.textContent).toContain('Working · 0s');

      await act(async () => { vi.advanceTimersByTime(8_000); });
      expect(line()?.textContent).toContain('Working · 8s');

      // Recent activity (<10s ago) stays clean without redundant "just now" noise.
      await rerender({
        value: '',
        busy: true,
        working: { startedAt: t0, lastResponseAt: t0 + 6_000 },
      });
      expect(line()?.textContent).toContain('Working · 8s');
      expect(line()?.textContent).not.toContain('last response');

      // Once quiet for >= 10s after output, show both elapsed duration and quiet age.
      await act(async () => { vi.advanceTimersByTime(12_000); });
      expect(line()?.textContent).toContain('Working · 20s · last response 14s ago');
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates current-turn timing across async hydration, session switches, and settled prior turns', async () => {
    const now = new Date('2026-11-26T12:00:00.000Z').getTime();
    const sixHoursAgo = now - 6 * 3_600_000;
    const eightMinAgo = now - 8 * 60_000;
    const twoMinAgo = now - 2 * 60_000;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);

    let latest: ComposerWorkingTiming = { startedAt: undefined, lastResponseAt: undefined };
    function Harness(props: ComposerWorkingInput) {
      latest = useComposerWorking(props);
      return null;
    }

    const host = document.createElement('div');
    document.body.append(host);
    const localRoot = createRoot(host);
    try {
      // 1) Async hydration: busy arrives before blocks load -> loading historical
      // stalled blocks must seed their real timestamp, never Date.now().
      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-stalled"
            loaded={false}
            blocks={[]}
            turnStartedAt={undefined}
          />,
        );
      });
      expect(latest.lastResponseAt).toBeUndefined();

      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-stalled"
            loaded
            blocks={[
              { id: 'u1', kind: 'user', text: 'run long job', createdAt: new Date(eightMinAgo).toISOString() },
              { id: 't1', kind: 'tool', toolCallId: 'c1', name: 'Bash', argsText: '', args: {}, display: undefined, description: undefined, status: 'done', output: undefined, isError: false, startedAt: twoMinAgo - 15_000, durationMs: 15_000, durationSource: 'frame', progressText: undefined },
            ] as never}
            turnStartedAt={eightMinAgo}
          />,
        );
      });
      expect(latest.startedAt).toBe(eightMinAgo);
      expect(latest.lastResponseAt).toBe(twoMinAgo);

      // 2) Switching scopeKey to another busy session whose prior turn was 6h ago
      // (with real settled `promptStatus: undefined`) and whose new turn has
      // turnStartedAt=undefined must NOT leak 6h ago or Date.now().
      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-new-turn"
            loaded
            blocks={[
              { id: 'u-old', kind: 'user', text: 'old prompt', createdAt: new Date(sixHoursAgo).toISOString(), promptStatus: undefined },
              { id: 'a-old', kind: 'assistant', text: 'old reply', createdAt: new Date(sixHoursAgo + 10_000).toISOString(), streaming: false },
              { id: 'u-cur', kind: 'user', text: 'new prompt', createdAt: new Date(now - 3_000).toISOString(), promptStatus: 'running' },
            ] as never}
            turnStartedAt={undefined}
          />,
        );
      });
      expect(latest.startedAt).toBe(now - 3_000);
      expect(latest.lastResponseAt).toBeUndefined();

      // 3) Settled prior turn (`promptStatus: undefined`) with no new user block yet must NOT leak 6h ago either.
      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-settled-prior"
            loaded
            blocks={[
              { id: 'u-old', kind: 'user', text: 'old prompt', createdAt: new Date(sixHoursAgo).toISOString(), promptStatus: undefined },
              { id: 'a-old', kind: 'assistant', text: 'old reply', createdAt: new Date(sixHoursAgo + 10_000).toISOString(), streaming: false },
            ] as never}
            turnStartedAt={undefined}
          />,
        );
      });
      expect(latest.startedAt).toBe(now);
      expect(latest.lastResponseAt).toBeUndefined();

      // 4) Live output arriving during this turn (including parallel subagent progress) advances lastResponseAt cleanly.
      await act(async () => { vi.advanceTimersByTime(4_000); });
      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-settled-prior"
            loaded
            blocks={[
              { id: 'u-old', kind: 'user', text: 'old prompt', createdAt: new Date(sixHoursAgo).toISOString(), promptStatus: undefined },
              { id: 'a-old', kind: 'assistant', text: 'old reply', createdAt: new Date(sixHoursAgo + 10_000).toISOString(), streaming: false },
              { id: 'u-cur', kind: 'user', text: 'new prompt', createdAt: new Date(now).toISOString(), promptStatus: 'running' },
              { id: 's-bg', kind: 'subagent', subagentId: 'sub-1', name: 'worker', status: 'running', toolCallCount: 1, startedAt: new Date(now + 1_000).toISOString() },
              { id: 'a-cur', kind: 'assistant', text: 'hello', createdAt: new Date(now + 4_000).toISOString(), streaming: true },
            ] as never}
            turnStartedAt={now}
          />,
        );
      });
      expect(latest.lastResponseAt).toBe(now + 4_000);

      await act(async () => { vi.advanceTimersByTime(5_000); });
      await act(async () => {
        localRoot.render(
          <Harness
            busy
            scopeKey="session-settled-prior"
            loaded
            blocks={[
              { id: 'u-old', kind: 'user', text: 'old prompt', createdAt: new Date(sixHoursAgo).toISOString(), promptStatus: undefined },
              { id: 'a-old', kind: 'assistant', text: 'old reply', createdAt: new Date(sixHoursAgo + 10_000).toISOString(), streaming: false },
              { id: 'u-cur', kind: 'user', text: 'new prompt', createdAt: new Date(now).toISOString(), promptStatus: 'running' },
              { id: 's-bg', kind: 'subagent', subagentId: 'sub-1', name: 'worker', status: 'running', toolCallCount: 2, startedAt: new Date(now + 1_000).toISOString() },
              { id: 'a-cur', kind: 'assistant', text: 'hello', createdAt: new Date(now + 4_000).toISOString(), streaming: true },
            ] as never}
            turnStartedAt={now}
          />,
        );
      });
      expect(latest.lastResponseAt).toBe(now + 9_000);
    } finally {
      await act(async () => { localRoot.unmount(); });
      host.remove();
      vi.useRealTimers();
    }
  });
});

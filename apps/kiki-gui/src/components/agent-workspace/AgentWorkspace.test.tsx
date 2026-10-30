// @vitest-environment jsdom
import { act, createRef, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { translate } from '@kiki/session-core/i18n';
import type { PromptItem } from '@kiki/protocol';
import { buildAnnotationsPrefix, clearStoredDrafts, resetDraftMemoryForTests, resetComposerMemoryForTests } from '@kiki/session-core/composer';
import {
  createViewState,
  SendNowError,
  type AgentForest,
  type AgentTreeNode,
  type SessionController,
} from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { ApiError, ExternalAgentAttachmentUnsupportedError, NativeChildPromptConflictError, NativeChildPromptSendError, type AgentModelSwitchEvent, type QueuedModelSwitch } from '../../lib/client';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { AgentTreeView } from '../AgentTreeView';
import { relatedAgentNodes } from '../AgentBreadcrumb';
import { agentContinuationAvailable } from './AgentWorkspace';
import { AgentWorkspace } from './OwnedAgentWorkspace';

const harness = vi.hoisted(() => ({
  header: null as HTMLElement | null,
  dock: null as HTMLElement | null,
  shellEnabled: true,
  scopeId: 'direct:one',
  listModels: vi.fn(),
  getAgentExecutor: vi.fn(),
  agent: vi.fn(),
  setPermission: vi.fn(),
  getPermission: vi.fn(),
  enterPlan: vi.fn(),
  exitPlan: vi.fn(),
  getExecutorModels: vi.fn(),
  sendAgentMessage: vi.fn(),
  isNativeAgent: vi.fn(),
  stopAgentTask: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentEffort: vi.fn(),
  switchAgentModel: vi.fn(),
  updateAgentModelSwitch: vi.fn(),
  cancelAgentModelSwitch: vi.fn(),
  recoverAgentModelSwitch: vi.fn(),
  listAgentModelSwitches: vi.fn(),
  subscribeAgentModelSwitches: vi.fn(),
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  readCapabilities: vi.fn(),
  listSessionSkills: vi.fn(),
  activateSkill: vi.fn(),
  pushToast: vi.fn(),
  mediaProviderProps: [] as Array<{ apiRef?: unknown }>,
  host: { kind: 'browser' } as {
    kind: string;
    pickFiles?: () => Promise<Array<{ name: string; size: number; type: string; read(): Promise<File> }> | null>;
  },
}));

vi.mock('../../state/connection', () => {
  const client = {
      listModels: harness.listModels,
      getAgentCapabilities: harness.readCapabilities,
      listSessionSkills: harness.listSessionSkills,
      activateSkill: harness.activateSkill,
      sendAgentMessage: harness.sendAgentMessage,
      isNativeAgent: harness.isNativeAgent,
      stopAgentTask: harness.stopAgentTask,
      setAgentModel: harness.setAgentModel,
      setAgentEffort: harness.setAgentEffort,
      // Model-switch surface the workspace now mounts (panel + queue state).
      switchAgentModel: harness.switchAgentModel,
      updateAgentModelSwitch: harness.updateAgentModelSwitch,
      cancelAgentModelSwitch: harness.cancelAgentModelSwitch,
      recoverAgentModelSwitch: harness.recoverAgentModelSwitch,
      listAgentModelSwitches: harness.listAgentModelSwitches,
      subscribeAgentModelSwitches: harness.subscribeAgentModelSwitches,
      getConfig: harness.getConfig,
      patchConfig: harness.patchConfig,
      klient: { rest: { executors: { getModels: harness.getExecutorModels } } },
  };
  const connection = () => ({ scopeId: harness.scopeId, client,
    klient: {
      session: () => ({ getAgentExecutor: harness.getAgentExecutor, agent: harness.agent }),
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) =>
            harness.readCapabilities(query, options.signal),
        },
      },
    },
  });
  return { useConnection: connection, useOptionalConnection: connection };
});

vi.mock('../ConversationShell', () => ({
  EMPTY_SLOTS: { header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null },
  useOptionalConversationShell: () =>
    harness.shellEnabled
      ? {
          slots: {
            header: harness.header,
            dock: harness.dock,
            heroFooter: null,
            rail: null,
            footer: null,
            preview: null,
          },
        }
      : null,
}));
vi.mock('../ActivityHistory', () => ({ revealSubagentCard: () => true }));
vi.mock('../AgentBreadcrumb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AgentBreadcrumb')>();
  return {
    ...actual,
    AgentBreadcrumb: () => null,
    AgentRelations: () => null,
  };
});
vi.mock('../mediaPreview', () => ({
  MediaPreviewProvider: (props: { children?: ReactNode; apiRef?: unknown }) => {
    harness.mediaProviderProps.push(props);
    return props.children;
  },
}));
vi.mock('../PreviewToggleButton', () => ({ PreviewToggleButton: () => <div data-preview-toggle-probe /> }));
vi.mock('../RightRail', () => ({ RightRail: () => null }));
vi.mock('../../host', () => ({ useHost: () => harness.host }));
vi.mock('../../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: { preparePrompt: vi.fn() } }));
vi.mock('../Transcript', () => ({ Transcript: ({ state, agentId }: { state: { blocks: readonly unknown[]; loadError?: string; transcriptReady?: boolean }; agentId?: string }) =>
  <div data-timeline-agent={agentId ?? 'main'} data-timeline-blocks={state.blocks.length}
    data-timeline-error={state.loadError} data-timeline-ready={state.transcriptReady === true ? 'true' : 'false'} /> }));
vi.mock('./ResyncStatusBanner', () => ({ ResyncStatusBanner: () => null }));
vi.mock('../../lib/toasts', () => ({ pushToast: harness.pushToast }));

let root: Root;
let container: HTMLDivElement;
let header: HTMLDivElement;
let dock: HTMLDivElement;
let queries: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  resetDraftMemoryForTests();
  resetComposerMemoryForTests();
  clearStoredDrafts();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.listModels.mockResolvedValue({ items: [] });
  harness.getAgentExecutor.mockResolvedValue('native');
  harness.switchAgentModel.mockImplementation(async (_sessionId, agentId, input) => ({ operationId: input.operationId, agentId, state: 'pending', fromModel: input.model, toModel: input.model, mode: input.mode }));
  harness.agent.mockReturnValue({ setPermission: harness.setPermission, getPermission: harness.getPermission, enterPlan: harness.enterPlan, exitPlan: harness.exitPlan });
  harness.getPermission.mockResolvedValue('auto');
  harness.setPermission.mockResolvedValue(undefined);
  harness.enterPlan.mockResolvedValue(undefined);
  harness.exitPlan.mockResolvedValue(undefined);
  harness.getExecutorModels.mockResolvedValue(externalModelCatalog());
  harness.readCapabilities.mockResolvedValue({
    context: 'live',
    owner: { profile: 'general', agent_id: 'child' },
    available: true,
    profile: { name: 'general' },
    targets: [],
    tools: [],
    skills: [],
    metrics: {},
  });
  harness.shellEnabled = true;
  harness.isNativeAgent.mockResolvedValue(true);
  harness.scopeId = 'direct:one';
  harness.host = { kind: 'browser' };
  harness.mediaProviderProps.length = 0;
  harness.listSessionSkills.mockResolvedValue({ skills: [] });
  harness.activateSkill.mockResolvedValue({});
  // The child workspace mounts the model-switch surface: an empty list, an
  // attachable event pair, and the config reads behind the preferences.
  harness.listAgentModelSwitches.mockResolvedValue([]);
  harness.subscribeAgentModelSwitches.mockReturnValue({ ready: Promise.resolve(), dispose: () => {} });
  harness.getConfig.mockResolvedValue({});
  harness.patchConfig.mockResolvedValue({});
  harness.listModels.mockResolvedValue({ items: [
    { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro' },
    { id: 'fixture/other', provider_id: 'fixture', remote_id: 'other' },
  ] });
  container = document.createElement('div');
  header = document.createElement('div');
  dock = document.createElement('div');
  document.body.append(container, header, dock);
  harness.header = header;
  harness.dock = dock;
  root = createRoot(container);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queries.clear();
  harness.header = null;
  container.remove();
  header.remove();
  dock.remove();
  harness.dock = null;
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function attachmentButton(scope: HTMLElement = dock): Promise<HTMLButtonElement> {
  if (scope.querySelector('[data-attach-button]') === null) {
    await act(async () => { scope.querySelector<HTMLButtonElement>('[data-add-menu-trigger]')!.click(); });
  }
  return scope.querySelector<HTMLButtonElement>('[data-attach-button]')!;
}

async function clickAttach(): Promise<void> {
  const button = await attachmentButton();
  await act(async () => { button.click(); });
}

async function sendNowFromComposer(): Promise<void> {
  await act(async () => {
    dock.querySelector('textarea[data-composer]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
}

async function typeText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps dispatch policy out of the workspace header and mounts the shared composer', async () => {
  harness.readCapabilities.mockResolvedValue({
    context: 'live',
    owner: { profile: 'general', agent_id: 'child' },
    available: true,
    profile: { name: 'general', subagent_policy: 'strict' },
    targets: [],
    tools: [],
    skills: [],
    metrics: {},
  });
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: ['child'],
  };
  const child: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'general', label: 'General',
    status: 'completed', busy: false, toolCallCount: 0, childIds: [],
  };
  const forest: AgentForest = { roots: [main], byId: { main, child } };
  const sessionState = { ...createViewState('session'), loaded: true };

  await act(async () => root.render(
    <QueryClientProvider client={queries}>
      <I18nProvider>
        <MemoryRouter>
          <AgentWorkspace
          target={{ sessionId: 'session', agentId: 'child' }}
          controller={null}
          sessionState={sessionState}
          forest={forest}
          navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
          railOpen={false}
          railIsOverlay={false}
          onToggleRail={vi.fn()}
          onCloseRail={vi.fn()}
          onCancelTask={vi.fn()}
          onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
          previewApiRef={createRef<MediaPreviewApi>()}
        />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ));
  await settle();

  expect(harness.readCapabilities).toHaveBeenCalledExactlyOnceWith({ session_id: 'session', agent_id: 'child' });
  expect(header.querySelector('[data-dispatch-policy]')).toBeNull();
  expect(header.querySelector('[data-recommendation-status]')).toBeNull();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).not.toBeNull();
});

it('enables running fullscreen composer send, model switch, and stop', async () => {
  harness.sendAgentMessage.mockResolvedValue({});
  harness.setAgentModel.mockResolvedValue(undefined);
  harness.stopAgentTask.mockResolvedValue(undefined);
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'next step');
  await settle();
  expect(textarea.value).toBe('next step');
  const sendButton = dock.querySelector<HTMLButtonElement>('[aria-label="Queue prompt"]');
  expect(sendButton?.disabled).toBe(false);
  await act(async () => { sendButton?.click(); });
  await settle();
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String), undefined);
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  expect(modelSelect.disabled).toBe(false);
  await act(async () => { modelSelect.click(); });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
  });
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
  const workingLine = dock.querySelector('[data-composer-working]');
  expect(workingLine).not.toBeNull();
  expect(workingLine?.textContent).toContain('Working');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Stop this turn"]')?.click(); });
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'main', 'task-1');
});

it('tracks child agent working line and last response dynamically', async () => {
  const now = Date.now();
  const child1Time = now - 15_000;
  const child1Iso = new Date(child1Time).toISOString();
  const forest = {
    roots: [{ agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false, toolCallCount: 0, childIds: ['child-1', 'child-2'] }],
    byId: {
      main: { agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false, toolCallCount: 0, childIds: ['child-1', 'child-2'] },
      'child-1': { agentId: 'child-1', parentAgentId: 'main', name: 'worker1', label: 'Worker 1', model: 'fixture/kiki-pro', status: 'running', busy: true, toolCallCount: 0, childIds: [] },
      'child-2': { agentId: 'child-2', parentAgentId: 'main', name: 'worker2', label: 'Worker 2', model: 'fixture/kiki-pro', status: 'running', busy: true, toolCallCount: 0, childIds: [] },
    },
  } as AgentForest;

  const agentStates: Record<string, ReturnType<typeof createViewState>> = {
    'child-1': {
      ...createViewState('session'),
      loaded: true,
      busy: true,
      turnStartedAt: child1Time - 50_000,
      blocks: [
        { id: 'u1', kind: 'user', text: 'start child 1' },
        { id: 'a1', kind: 'assistant', text: 'working on it', createdAt: child1Iso, streaming: false },
      ] as never,
    },
    'child-2': {
      ...createViewState('session'),
      loaded: true,
      busy: true,
      turnStartedAt: child1Time - 100_000,
      blocks: [
        { id: 'u2', kind: 'user', text: 'start child 2' },
      ] as never,
    },
  };

  const listeners = new Map<string, Set<() => void>>();
  const notifyAgent = (agentId: string) => {
    listeners.get(agentId)?.forEach((cb) => cb());
  };

  const controller = {
    subscribeAgent: (agentId: string, cb: () => void) => {
      if (!listeners.has(agentId)) listeners.set(agentId, new Set());
      listeners.get(agentId)!.add(cb);
      return () => { listeners.get(agentId)?.delete(cb); };
    },
    getAgentState: (agentId: string) => agentStates[agentId] ?? EMPTY_AGENT_STATE,
    getForest: () => forest,
    retainHistoryRead: () => () => {},
    retainHistoryPreview: () => () => {},
    historyPreviewPending: () => false,
  } as unknown as SessionController;

  // 1. Cold busy child-1 mounts: seeds lastResponseAt from its own block timestamp
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'child-1' },
    controller,
    forest,
  });
  await settle();

  const workingLine = dock.querySelector('[data-composer-working]');
  expect(workingLine).not.toBeNull();
  expect(workingLine?.getAttribute('data-last-response-at')).toBe(String(child1Time));
  expect(workingLine?.textContent).toContain('Working · last response 15s ago');

  // 2. Main or other child output does not update child-1 lastResponseAt
  const dateNowSpy = vi.spyOn(Date, 'now');
  dateNowSpy.mockReturnValue(now + 30_000);
  agentStates['child-2'] = {
    ...agentStates['child-2']!,
    blocks: [
      { id: 'u2', kind: 'user', text: 'start child 2' },
      { id: 'a2', kind: 'assistant', text: 'child 2 speaks', createdAt: new Date(now + 20_000).toISOString(), streaming: false },
    ] as never,
  };
  await act(async () => { notifyAgent('child-2'); });
  await settle();
  expect(dock.querySelector('[data-composer-working]')?.getAttribute('data-last-response-at')).toBe(String(child1Time));

  // 3. Child-1 produces new output: signature changes and refreshes lastResponseAt
  const updatedTime = now + 30_000;
  agentStates['child-1'] = {
    ...agentStates['child-1']!,
    blocks: [
      { id: 'u1', kind: 'user', text: 'start child 1' },
      { id: 'a1', kind: 'assistant', text: 'working on it - step 2', createdAt: child1Iso, streaming: true },
    ] as never,
  };
  await act(async () => { notifyAgent('child-1'); });
  await settle();
  expect(dock.querySelector('[data-composer-working]')?.getAttribute('data-last-response-at')).toBe(String(updatedTime));

  // 4. Switch to child-3 (no outputs yet): does not inherit child-1 or child-2 timestamp
  agentStates['child-3'] = {
    ...createViewState('session'),
    loaded: true,
    busy: true,
    turnStartedAt: now - 100_000,
    blocks: [
      { id: 'u3', kind: 'user', text: 'start child 3' },
    ] as never,
  };
  const threeForest = {
    ...forest,
    byId: {
      ...forest.byId,
      'child-3': { agentId: 'child-3', parentAgentId: 'main', name: 'worker3', label: 'Worker 3', model: 'fixture/kiki-pro', status: 'running', busy: true, toolCallCount: 0, childIds: [] },
    },
  } as AgentForest;
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'child-3' },
    controller,
    forest: threeForest,
  });
  await settle();
  const child3Working = dock.querySelector('[data-composer-working]');
  expect(child3Working).not.toBeNull();
  expect(child3Working?.getAttribute('data-last-response-at')).toBeNull();
  expect(child3Working?.textContent).toContain('Working');
  expect(child3Working?.textContent).not.toContain('last response');

  // 5. Idle child (busy=false): working line completely unmounts
  agentStates['child-3'] = {
    ...agentStates['child-3']!,
    busy: false,
  };
  const idleForest = {
    ...threeForest,
    byId: {
      ...threeForest.byId,
      'child-3': { ...threeForest.byId['child-3']!, status: 'completed', busy: false },
    },
  } as AgentForest;
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'child-3' },
    controller,
    forest: idleForest,
  });
  await settle();
  expect(dock.querySelector('[data-composer-working]')).toBeNull();

  dateNowSpy.mockRestore();
});

async function sendNowToBusyChild(
  sendPromptNow: ReturnType<typeof vi.fn>,
): Promise<HTMLTextAreaElement> {
  const controller = Object.assign(
    controllerStub({ forest: testForest('running', true), agentStates: {} }),
    { sendPromptNow },
  );
  await renderWorkspace({ controller, forest: testForest('running', true) });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'look at the tests too');
  await settle();
  await sendNowFromComposer();
  await settle();
  return textarea;
}

it('steers a busy native child through the shared send-now ledger, not its mailbox', async () => {
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'steered' });
  const textarea = await sendNowToBusyChild(sendPromptNow);
  expect(sendPromptNow).toHaveBeenCalledWith({
    agentId: 'child', text: 'look at the tests too', content: [{ type: 'text', text: 'look at the tests too' }],
  });
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(textarea.value).toBe('');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('sends a busy native child timing pick once, then returns to the configured default', async () => {
  harness.sendAgentMessage.mockResolvedValue(null);
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'defer this child prompt');
  await act(async () => {
    dock.querySelector('[data-send-timing-root]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  const pick = dock.querySelector<HTMLButtonElement>('[data-send-timing="subagents_done"]');
  expect(pick).not.toBeNull();
  await act(async () => { pick!.click(); });
  await settle();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(1);
  expect(harness.sendAgentMessage).toHaveBeenLastCalledWith('session', 'child', 'defer this child prompt', [
    { type: 'text', text: 'defer this child prompt' },
  ], expect.any(String), undefined, 'subagents_done');

  await typeText(textarea, 'plain child prompt');
  await clickComposerSend();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(2);
  expect(harness.sendAgentMessage).toHaveBeenLastCalledWith('session', 'child', 'plain child prompt', [
    { type: 'text', text: 'plain child prompt' },
  ], expect.any(String), undefined);
});

it('keeps the original key and timing on an unconfirmed same-draft retry, then resets after acceptance', async () => {
  harness.sendAgentMessage
    .mockRejectedValueOnce(new NativeChildPromptSendError(new Error('response lost')))
    .mockResolvedValue(null);
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'defer this unconfirmed prompt');
  await act(async () => {
    dock.querySelector('[data-send-timing-root]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  await act(async () => { dock.querySelector<HTMLButtonElement>('[data-send-timing="subagents_done"]')!.click(); });
  await settle();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(1);
  const originalKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  expect(harness.sendAgentMessage.mock.calls[0]?.[6]).toBe('subagents_done');
  expect(textarea.value).toBe('defer this unconfirmed prompt');

  await clickComposerSend();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(2);
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(originalKey);
  expect(harness.sendAgentMessage.mock.calls[1]?.[6]).toBe('subagents_done');
  expect(textarea.value).toBe('');

  await typeText(textarea, 'next plain prompt');
  await clickComposerSend();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(3);
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(originalKey);
  expect(harness.sendAgentMessage).toHaveBeenLastCalledWith('session', 'child', 'next plain prompt', [
    { type: 'text', text: 'next plain prompt' },
  ], expect.any(String), undefined);
});

it('hands a refused child send-now back to the composer with the reason', async () => {
  const sendPromptNow = vi.fn().mockRejectedValue(new SendNowError('refused', new Error('model differs')));
  const textarea = await sendNowToBusyChild(sendPromptNow);
  expect(textarea.value).toBe('look at the tests too');
  expect(harness.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
});

it('recovers a failed child send-now into a newly mounted empty composer, including attachments', async () => {
  let rejectSend!: (error: unknown) => void;
  const sendPromptNow = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; }));
  const controller = Object.assign(
    controllerStub({ forest: testForest('running', true), agentStates: {} }),
    { sendPromptNow },
  );
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace({ controller, forest: testForest('running', true) });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'recover this turn');
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await sendNowFromComposer();
  await settle();
  expect(sendPromptNow).toHaveBeenCalledWith(expect.objectContaining({ text: 'recover this turn' }));
  expect(textarea.value).toBe('');

  await act(async () => root.render(null));
  await renderWorkspace({ controller: controllerStub({ forest: testForest('running', true), agentStates: {} }), forest: testForest('running', true) });
  await settle();
  const remounted = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  expect(remounted.value).toBe('');
  expect(dock.querySelector('[data-attachment-chips]')).toBeNull();

  await act(async () => { rejectSend(new SendNowError('refused', new Error('turn rejected'))); });
  await settle();
  expect(remounted.value).toBe('recover this turn');
  expect(dock.querySelector('[data-attachment-chips] img')).not.toBeNull();
});

it('does not overwrite a newer draft written by a remounted child before send-now fails', async () => {
  let rejectSend!: (error: unknown) => void;
  const sendPromptNow = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; }));
  const forest = testForest('running', true);
  await renderWorkspace({
    controller: Object.assign(controllerStub({ forest, agentStates: {} }), { sendPromptNow }),
    forest,
  });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'stale in-flight text');
  await sendNowFromComposer();
  await settle();
  await act(async () => root.render(null));
  await renderWorkspace({ controller: controllerStub({ forest, agentStates: {} }), forest });
  await settle();
  const remounted = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(remounted, 'newer mounted draft');
  await settle();
  await act(async () => { rejectSend(new SendNowError('refused', new Error('turn rejected'))); });
  await settle();
  expect(remounted.value).toBe('newer mounted draft');
});

it('uses the executor steer contract for an external child Send now instead of its ordinary mailbox', async () => {
  harness.isNativeAgent.mockResolvedValue(false);
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'steered' });
  await sendNowToBusyChild(sendPromptNow);
  expect(sendPromptNow).toHaveBeenCalledWith({
    agentId: 'child', text: 'look at the tests too', content: [{ type: 'text', text: 'look at the tests too' }],
  });
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
});

it('explains a queued child Send now with the reason the server reported', async () => {
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'queued', reason: 'steer_rejected' });
  await sendNowToBusyChild(sendPromptNow);
  expect(harness.pushToast).toHaveBeenCalledWith({ tone: 'info', text: translate('en', 'sv.steerQueuedRejected') });
});

it('does not guess delivery for a child Send now whose response was lost', async () => {
  const sendPromptNow = vi.fn().mockRejectedValue(new SendNowError('unknown', new Error('response lost')));
  const textarea = await sendNowToBusyChild(sendPromptNow);
  // The message may already be in the turn: it is neither re-sent nor claimed
  // as queued, and the composer stays empty for an explicit follow-up.
  expect(sendPromptNow).toHaveBeenCalledTimes(1);
  expect(textarea.value).toBe('');
  expect(harness.pushToast).toHaveBeenCalledWith(expect.objectContaining({
    tone: 'error',
    text: translate('en', 'sv.steerUnknown', { detail: 'response lost' }),
  }));
  expect(harness.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ text: translate('en', 'sv.steerQueued') }));
});

it('consumes the final durable reason after the first acknowledgement, once', async () => {
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'restoring' });
  const forest = testForest('running', true);
  const controller = Object.assign(controllerStub({ forest, agentStates: {} }), { sendPromptNow });
  await renderWorkspace({ controller, forest });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'late receipt');
  await settle();
  await sendNowFromComposer();
  await settle();
  expect(sendPromptNow).toHaveBeenCalled();
  expect(harness.pushToast).not.toHaveBeenCalled();

  const queued: PromptItem = {
    prompt_id: 'p', user_message_id: 'u', status: 'queued', admission: 'admitted',
    delivery_state: 'queued', delivery_reason: 'target_changed',
    content: [{ type: 'text', text: 'late receipt' }], created_at: '2026-10-20T00:00:00.000Z',
  };
  await renderWorkspace({
    controller, forest,
    sessionState: { ...createViewState('session'), loaded: true, durableIngress: [queued] },
  });
  await settle();
  expect(harness.pushToast).toHaveBeenCalledWith({ tone: 'info', text: translate('en', 'sv.steerQueuedTargetChanged') });

  // The same final receipt read again is not a second explanation.
  await renderWorkspace({
    controller, forest,
    sessionState: { ...createViewState('session'), loaded: true, durableIngress: [{ ...queued }] },
  });
  await settle();
  expect(harness.pushToast).toHaveBeenCalledTimes(1);

  // Once the prompt runs, the transcript owns it: no late queued notice.
  await renderWorkspace({
    controller, forest,
    sessionState: {
      ...createViewState('session'), loaded: true,
      durableIngress: [{ ...queued, status: 'running', delivery_state: undefined, delivery_reason: undefined }],
    },
  });
  await settle();
  expect(harness.pushToast).toHaveBeenCalledTimes(1);
});

it('lets a started child prompt win over a stale queued durable receipt', async () => {
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'restoring' });
  const forest = testForest('running', true);
  await renderWorkspace({ controller: Object.assign(controllerStub({ forest, agentStates: {} }), { sendPromptNow }), forest });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'already running');
  await settle();
  await sendNowFromComposer();
  await settle();
  expect(harness.pushToast).not.toHaveBeenCalled();

  // The transcript already shows the prompt running; the ingress still keeps
  // its earlier admitted/queued receipt with a reason. Canonical wins.
  const started = {
    ...createViewState('session'), loaded: true,
    blocks: [{ kind: 'user', id: 'row', promptId: 'p', promptStatus: 'running', text: 'already running', createdAt: '2026-10-20T00:00:00.000Z' }],
  } as ReturnType<typeof createViewState>;
  const stale: PromptItem = {
    prompt_id: 'p', user_message_id: 'u', status: 'queued', admission: 'admitted',
    delivery_state: 'queued', delivery_reason: 'target_changed',
    content: [{ type: 'text', text: 'already running' }], created_at: '2026-10-20T00:00:00.000Z',
  };
  await renderWorkspace({
    controller: Object.assign(controllerStub({ forest, agentStates: { child: started } }), { sendPromptNow }),
    forest,
    sessionState: { ...createViewState('session'), loaded: true, durableIngress: [stale] },
  });
  await settle();
  expect(harness.pushToast).not.toHaveBeenCalled();
});

/** Minimal durable-mailbox acceptance returned by `client.sendAgentMessage`. */
function mailboxReceipt(overrides: {
  delivery: 'queued' | 'delivered';
  resumed?: boolean;
  deduplicated?: boolean;
  payloadConflict?: boolean;
}) {
  return {
    message: {
      messageId: 'message-1', sessionId: 'session', sourceAgentId: 'main', sourceTaskName: 'user',
      senderKind: 'user' as const, targetAgentId: 'child', targetTaskName: 'child',
      acceptedAt: 1, targetSeq: 1,
    },
    deduplicated: overrides.deduplicated ?? false,
    payloadConflict: overrides.payloadConflict ?? false,
    delivery: overrides.delivery,
    resumed: overrides.resumed,
  };
}

async function sendFromComposer(text: string): Promise<HTMLTextAreaElement> {
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, text);
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Queue prompt"]')?.click();
  });
  await settle();
  return textarea;
}

it('toasts a queued mailbox receipt and clears the draft once the send settles', async () => {
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'queued' }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String), undefined);
  // A queued message reads as informational, not as a fresh delivery.
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.pending'),
  });
  expect(textarea.value).toBe('');
});

it('marks a delivered mailbox receipt that resumed the agent', async () => {
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'delivered', resumed: true }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  await sendFromComposer('next step');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'success',
    text: `${translate('en', 'agentMessage.delivered')} · ${translate('en', 'subagent.event.resumed')}`,
  });
});

it('presents a deduplicated receipt as already accepted, not as a fresh delivery', async () => {
  // The mailbox already held an equivalent message, so a queued delivery state
  // must not leak through as this send having queued a new prompt.
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'queued', deduplicated: true }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.deduplicated'),
  });
  expect(harness.pushToast).not.toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.pending'),
  });
  expect(textarea.value).toBe('');
});

it('fails closed on a payload conflict and keeps the draft instead of reading as delivered', async () => {
  harness.sendAgentMessage.mockResolvedValue(
    mailboxReceipt({ delivery: 'delivered', payloadConflict: true }),
  );
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  // The current text was not accepted: report it, never claim a delivery, and
  // never clear the draft.
  expect(harness.pushToast).not.toHaveBeenCalled();
  expect(textarea.value).toBe('next step');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.payloadConflict'));
  const conflictedKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(conflictedKey);
  expect(textarea.value).toBe('next step');
});

it('sends a native child without faking a mailbox receipt', async () => {
  // A native child keeps the prompt route; the composer must not invent a
  // queued/delivered receipt for a delivery it cannot observe.
  harness.sendAgentMessage.mockResolvedValue(null);
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String), undefined);
  expect(harness.pushToast).not.toHaveBeenCalled();
  expect(textarea.value).toBe('');
});

it('keeps the draft and raises no receipt when the mailbox send rejects', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('mailbox unavailable'));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.pushToast).not.toHaveBeenCalled();
  // The rejected send never reached the clear step, so the draft survives.
  expect(textarea.value).toBe('next step');
});

it('throws a definitive 40001 child rejection instead of showing an unknown outcome, retaining attachments', async () => {
  harness.sendAgentMessage.mockRejectedValue(new NativeChildPromptSendError(new ApiError({
    code: 40001,
    msg: 'prompt.rejected',
    data: null,
  })));
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'inspect');
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();
  expect(textarea.value).toBe('inspect');
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  expect(dock.querySelector('[role="alert"]')?.textContent).toContain('prompt.rejected');
  expect(dock.textContent).not.toContain(translate('en', 'agentMessage.promptOutcomeUnknown'));
  expect(dock.textContent).not.toContain(translate('en', 'agentMessage.attachmentOutcomeUnknown'));
});

it('keeps a 50001 child rejection in the unknown-outcome recovery path', async () => {
  harness.sendAgentMessage.mockRejectedValue(new NativeChildPromptSendError(new ApiError({
    code: 50001,
    msg: 'server.internal_error',
    data: null,
  })));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(textarea.value).toBe('next step');
  expect(dock.querySelector('[role="alert"]')?.textContent).toBe(translate('en', 'agentMessage.promptOutcomeUnknown'));
});

it('activates a child skill with its target, payload, switch dependency, and stable retry key', async () => {
  harness.listSessionSkills.mockResolvedValue({ skills: [{
    name: 'review', description: 'Review the current diff', path: '/skills/review/SKILL.md', source: 'project',
  }] });
  harness.listAgentModelSwitches.mockResolvedValue([pendingSwitch('skill-operation', 0)]);
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  harness.activateSkill.mockRejectedValueOnce(new Error('activation unavailable')).mockResolvedValueOnce({});
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, '/review --fix');
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();

  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.activateSkill).toHaveBeenCalledTimes(1);
  const firstBody = harness.activateSkill.mock.calls[0]?.[2] as Record<string, unknown>;
  expect(harness.activateSkill.mock.calls[0]?.slice(0, 2)).toEqual(['session', 'review']);
  expect(firstBody).toMatchObject({
    args: '--fix',
    agent_id: 'child',
    user_input: '/review --fix',
    after_model_switch: 'skill-operation',
    prompt_id: expect.any(String),
  });
  expect(firstBody['attachments']).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
  expect(textarea.value).toBe('/review --fix');

  await clickComposerSend();
  expect(harness.activateSkill).toHaveBeenCalledTimes(2);
  const secondBody = harness.activateSkill.mock.calls[1]?.[2];
  expect(harness.activateSkill.mock.calls[1]?.slice(0, 2)).toEqual(['session', 'review']);
  expect(secondBody).toEqual(firstBody);
  expect(harness.activateSkill.mock.calls[1]?.[2]?.agent_id).not.toBe('main');
  expect(textarea.value).toBe('');
  expect(dock.querySelector('[data-attachment-chips]')).toBeNull();
});

async function clickComposerSend() {
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Queue prompt"]')?.click();
  });
  await settle();
}

it('reuses one pending submission after a lost response, then releases it for an independent send', async () => {
  const accepted = new Map<string, string>();
  harness.sendAgentMessage.mockImplementation(async (_session: string, _agent: string, text: string, _content: unknown, key: string) => {
    if (typeof key !== 'string' || key.length === 0) throw new Error('missing idempotency key');
    const previous = accepted.get(key);
    if (previous !== undefined) return mailboxReceipt({ delivery: 'queued', deduplicated: true });
    accepted.set(key, text); // server accepted durably before the response was lost
    if (accepted.size === 1) throw new Error('response lost after accept');
    return mailboxReceipt({ delivery: 'queued' });
  });
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(textarea.value).toBe('next step');
  expect(accepted.size).toBe(1);
  await clickComposerSend();
  expect(accepted.size).toBe(1);
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
  expect(textarea.value).toBe('');
  expect(harness.pushToast).toHaveBeenCalledWith({ tone: 'info', text: translate('en', 'agentMessage.deduplicated') });
  await sendFromComposer('next step');
  expect(accepted.size).toBe(2);
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
});

it('replays a lost native prompt response under the same key without a mailbox delivery toast', async () => {
  const accepted = new Map<string, string>();
  harness.sendAgentMessage.mockImplementation(async (_session: string, _agent: string, text: string, _content: unknown, key: string) => {
    const previous = accepted.get(key);
    if (previous !== undefined) {
      if (previous !== text) throw new NativeChildPromptConflictError(new Error('prompt.id_conflict'));
      return null; // Replay of the native prompt receipt, not a mailbox receipt.
    }
    accepted.set(key, text);
    throw new NativeChildPromptSendError(new Error('response lost after native prompt acceptance'));
  });
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(textarea.value).toBe('next step');
  expect(dock.querySelector('[role="alert"]')?.textContent).toBe(translate('en', 'agentMessage.promptOutcomeUnknown'));
  await clickComposerSend();
  expect(accepted.size).toBe(1);
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
  expect(textarea.value).toBe('');
  expect(dock.querySelector('[role="alert"]')).toBeNull();
  expect(harness.pushToast).not.toHaveBeenCalled();
  await sendFromComposer('independent step');
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
});

it('keeps an ambiguous native conflict pending until an explicit edited send uses a new key', async () => {
  harness.sendAgentMessage.mockRejectedValueOnce(new NativeChildPromptConflictError(new Error('prompt.id_conflict')))
    .mockRejectedValueOnce(new NativeChildPromptConflictError(new Error('accepted without replayable receipt')))
    .mockResolvedValueOnce(null);
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  expect(textarea.value).toBe('next step');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.promptOutcomeUnknown'));
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(firstKey);
  expect(textarea.value).toBe('next step');
  await typeText(textarea, 'different step');
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(firstKey);
  expect(textarea.value).toBe('');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('retains attached draft on unknown native outcome and does not disguise an external rejection', async () => {
  harness.sendAgentMessage.mockRejectedValueOnce(new Error('response lost after attachment acceptance'))
    .mockRejectedValueOnce(new ExternalAgentAttachmentUnsupportedError());
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace();
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'inspect');
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  expect(textarea.value).toBe('inspect');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.attachmentOutcomeUnknown'));
  expect(harness.pushToast).not.toHaveBeenCalled();
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(firstKey);
  expect(dock.textContent).toContain('External agent messages support text only');
  expect(dock.textContent).not.toContain(translate('en', 'agentMessage.attachmentOutcomeUnknown'));
});

it('starts a new submission after an edit, even when undo restores the original text', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await typeText(textarea, 'revised');
  await sendFromComposer('next step');
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).not.toBe(firstKey);
  await sendFromComposer('new step');
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[1]?.[4]);
});

it('isolates pending submissions across connection, session, and target switches', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  await renderWorkspace();
  await settle();
  await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  harness.scopeId = 'direct:two';
  await renderWorkspace();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('');
  await sendFromComposer('next step');
  const secondKey = harness.sendAgentMessage.mock.calls[1]?.[4];
  expect(secondKey).not.toBe(firstKey);
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'child' } });
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('');
  await sendFromComposer('next step');
  const thirdKey = harness.sendAgentMessage.mock.calls[2]?.[4];
  expect(thirdKey).not.toBe(secondKey);
  const main = testForest().roots[0]!;
  const other: AgentTreeNode = { ...testForest().byId['child']!, agentId: 'other', name: 'other' };
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'other' }, forest: {
    roots: [main], byId: { ...testForest().byId, other },
  } });
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('');
  await sendFromComposer('next step');
  expect(harness.sendAgentMessage.mock.calls[3]?.[4]).not.toBe(thirdKey);
  expect(harness.sendAgentMessage.mock.calls[3]?.slice(0, 2)).toEqual(['other-session', 'other']);
});

it('changes the pending submission key when attachment payload changes', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace();
  await settle();
  await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).not.toBe(firstKey);
  expect(harness.sendAgentMessage.mock.calls[1]?.[3]).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'image' }),
  ]));
});

it('does not let an old target receipt erase the target draft restored in a new owner', async () => {
  let resolveSend!: (value: null) => void;
  harness.sendAgentMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
  await renderWorkspace();
  await sendFromComposer('A pending');
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'child' } });
  await renderWorkspace();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  expect(textarea.value).toBe('A pending');
  await typeText(textarea, 'A newer draft');
  await act(async () => { resolveSend(null); });
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'child' } });
  await renderWorkspace();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('A newer draft');
});

it('does not erase an edited draft when the in-flight receipt finally arrives', async () => {
  let resolveSend: (receipt: ReturnType<typeof mailboxReceipt>) => void = () => undefined;
  harness.sendAgentMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
  await renderWorkspace();
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'next step');
  await clickComposerSend();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(1);
  await typeText(textarea, 'edited while sending');
  await act(async () => { resolveSend(mailboxReceipt({ delivery: 'queued' })); });
  await settle();
  expect(textarea.value).toBe('edited while sending');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it.each([false, true])('updates a mounted child tree and composer after send and settlement (preview=%s)', async (preview) => {
  harness.sendAgentMessage.mockResolvedValue({});
  const listeners = new Set<() => void>();
  let sessionState = { ...createViewState('session'), loaded: true };
  let childState = { ...createViewState('session'), loaded: true };
  let forest = testForest('completed');
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const controller = {
    subscribe,
    subscribeAgent: (_agentId: string, listener: () => void) => subscribe(listener),
    getState: () => sessionState,
    getAgentState: () => childState,
    getForest: () => forest,
    retainHistoryRead: () => () => {},
    retainHistoryPreview: () => () => {},
    historyPreviewPending: () => false,
  } as unknown as SessionController;
  function MountedWorkspace() {
    const state = useSyncExternalStore(subscribe, () => sessionState);
    return <>
      <AgentTreeView forest={forest} selectedAgentId="child" onOpen={vi.fn()} />
      <AgentWorkspace
        target={{ sessionId: 'session', agentId: 'child' }}
        controller={controller} sessionState={state} forest={forest}
        navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
        railOpen={false} railIsOverlay={preview} onToggleRail={vi.fn()} onCloseRail={vi.fn()}
        onCancelTask={vi.fn()} onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
        inheritMediaPreview={preview} showBreadcrumb={!preview} showPreviewToggle={!preview}
        slots={preview ? { header, dock, rail: null, heroFooter: null, footer: null, preview: null } : undefined}
      />
    </>;
  }
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><MemoryRouter>
      <MountedWorkspace />
    </MemoryRouter></I18nProvider></QueryClientProvider>,
  ));
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  const statusText = () => container.querySelector('[data-agent-id="child"]')?.textContent;
  expect(statusText()).toContain(translate('en', 'subagent.status.completed'));
  expect(dock.querySelector('[aria-label="Stop this turn"]')).toBeNull();
  await typeText(textarea, 'continue');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(); });
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'continue', [{ type: 'text', text: 'continue' }], expect.any(String), undefined);
  const publishStatus = async (status: 'background' | 'completed') => {
    const busy = status === 'background';
    await act(async () => {
      forest = testForest(status, busy);
      childState = { ...childState, busy };
      sessionState = { ...sessionState, tasks: [{
        id: 'new-run-task', session_id: 'session', kind: 'subagent', status: busy ? 'running' : 'completed',
        description: 'Follow-up', agent_id: 'child', created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z',
      }] };
      for (const listener of listeners) listener();
    });
    await settle();
  };
  for (const status of ['background', 'completed'] as const) {
    const busy = status === 'background';
    await publishStatus(status);
    expect(statusText()).toContain(translate('en', `subagent.status.${status}`));
    expect(container.querySelector('[data-agent-id="child"] .status-dot-busy') !== null).toBe(busy);
    expect(dock.querySelector('[aria-label="Stop this turn"]') !== null).toBe(busy);
    expect(dock.querySelector('textarea[data-composer]')).toBe(textarea);
    expect(textarea.disabled).toBe(false);
    expect(header.querySelector('h1')?.textContent).toBe('General');
  }
});

it.each(['completed', 'cancelled', 'failed'] as const)(
  'keeps terminal %s composer sendable and model-switchable',
  async (status) => {
    harness.sendAgentMessage.mockResolvedValue({});
    harness.setAgentModel.mockResolvedValue(undefined);
    await renderWorkspace({ forest: testForest(status) });
    await settle();
    const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(textarea.disabled).toBe(false);
    expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(false);
    expect((await attachmentButton()).disabled).toBe(false);
    await typeText(textarea, 'wake up');
    await settle();
    const sendButton = dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(false);
    await act(async () => { sendButton?.click(); });
    expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'wake up', [
      { type: 'text', text: 'wake up' },
    ], expect.any(String), undefined);
    const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
    await act(async () => { modelSelect.click(); });
    await act(async () => {
      dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
    });
    expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
    // A closed child owns no running task, so the stop control stays unmounted.
    expect(dock.querySelector('[aria-label="Stop this turn"]')).toBeNull();
  },
);

it('toasts a failed model change and leaves the live model selected', async () => {
  harness.setAgentModel.mockRejectedValue(new Error('agent restore failed'));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  const before = modelSelect.textContent;
  await act(async () => { modelSelect.click(); });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
  });
  await settle();
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'subagent.modelChangeFailed', { detail: 'agent restore failed' }),
  });
  // The trigger reads the live agent, so a rejected pick must not read as applied.
  expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')!.textContent).toBe(before);
});

/** The effort ladder of the fixture model, used by the effort-pick tests. */
const EFFORT_CATALOG = {
  items: [
    {
      id: 'fixture/kiki-pro',
      provider_id: 'fixture',
      remote_id: 'kiki-pro',
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
    },
  ],
};

it.each([
  { effort: 'high', defaultEffort: 'high', supportEfforts: undefined },
  { effort: 'low', defaultEffort: undefined, supportEfforts: undefined },
  { effort: 'on', defaultEffort: 'on', supportEfforts: ['off', 'on'] },
  { effort: 'off', defaultEffort: undefined, supportEfforts: ['low', 'high'] },
])('shows effective child effort $effort without a spurious warning or backend rewrite', async ({ effort, defaultEffort, supportEfforts }) => {
  harness.listModels.mockResolvedValue({ items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro',
    capabilities: ['thinking'], support_efforts: supportEfforts, default_effort: defaultEffort }] });
  await renderWorkspace({ forest: testForest('running', true, { model: 'fixture/kiki-pro', thinkingEffort: effort }) });
  await settle();
  expect(header.querySelector('[data-agent-effort]')?.textContent).toContain(effort);
  expect(dock.textContent).not.toContain('unavailable for this model');
  expect(dock.querySelector('[data-selection-diagnostic]')).toBeNull();
  await typeText(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, 'continue');
  expect(dock.querySelector<HTMLButtonElement>('[aria-label="Queue prompt"]')?.disabled).toBe(false);
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
  expect(harness.setAgentModel).not.toHaveBeenCalled();
});

it('preserves an invalid saved on binding and offers explicit recovery rather than rewriting it', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  await renderWorkspace({ forest: testForest('running', true, { model: 'fixture/kiki-pro', thinkingEffort: 'on' }) });
  await settle();
  expect(header.querySelector('[data-agent-effort]')?.textContent).toContain('on');
  expect(dock.textContent).toContain('Effort “on” is unavailable for this model');
  expect(dock.textContent).toContain('Use model default effort');
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
  expect(harness.setAgentModel).not.toHaveBeenCalled();
});

it('does not invent a default recovery effort when the child model has none', async () => {
  harness.listModels.mockResolvedValue({ items: [{ ...EFFORT_CATALOG.items[0], default_effort: undefined }] });
  await renderWorkspace({ forest: testForest('running', true, { model: 'fixture/kiki-pro', thinkingEffort: 'on' }) });
  await settle();
  expect(dock.textContent).toContain('Effort “on” is unavailable for this model');
  expect(dock.textContent).not.toContain('Use model default effort');
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
});

it('applies a picked thinking effort through the agent facade and refreshes the agent read', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  harness.setAgentEffort.mockResolvedValue(undefined);
  const invalidate = vi.spyOn(queries, 'invalidateQueries');
  // The node carries a bare alias; the ladder must come from the catalog row it
  // resolves to (`fixture/kiki-pro`), not from a name match on the raw value.
  await renderWorkspace({
    forest: testForest('running', true, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('#composer-model-select')!.click();
  });
  const high = dock.querySelector<HTMLButtonElement>('[data-effort="high"]');
  expect(high).not.toBeNull();
  await act(async () => { high?.click(); });
  await settle();
  expect(harness.switchAgentModel).toHaveBeenCalledWith('session', 'child', expect.objectContaining({ model: 'kiki-pro', thinking: 'high', mode: 'direct', intent: 'setting' }));
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['agentCapabilities', { session_id: 'session', agent_id: 'child' }],
  });
});

it('keeps the effort pick disabled for a terminal subagent', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  await renderWorkspace({
    forest: testForest('completed', false, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  // A finished child stays wakeable, so the model rebind and the panel are
  // still offered; only the effort ladder is withheld.
  expect(modelSelect.disabled).toBe(false);
  await act(async () => { modelSelect.click(); });
  expect(dock.querySelector('[role="option"][data-option-value="fixture/kiki-pro"]')).not.toBeNull();
  expect(dock.querySelector('[data-effort]')).toBeNull();
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
});

it('toasts a failed effort change and leaves the live effort selected', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  harness.switchAgentModel.mockRejectedValue(new Error('agent restore failed'));
  await renderWorkspace({
    forest: testForest('running', true, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('#composer-model-select')!.click();
  });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[data-effort="high"]')?.click();
  });
  await settle();
  expect(harness.switchAgentModel).toHaveBeenCalledWith('session', 'child', expect.objectContaining({ model: 'kiki-pro', thinking: 'high', mode: 'direct' }));
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'subagent.effortChangeFailed', { detail: 'agent restore failed' }),
  });
  // The ladder reads the live agent, so a rejected pick must not read as applied.
  expect(dock.querySelector<HTMLButtonElement>('[data-effort="medium"]')?.getAttribute('aria-checked')).toBe('true');
  expect(dock.querySelector<HTMLButtonElement>('[data-effort="high"]')?.getAttribute('aria-checked')).toBe('false');
});

it('toasts a rejected stop and stays retryable; a pending stop double-click fires once and recovers', async () => {
  let rejectStop: (error: Error) => void = () => undefined;
  harness.stopAgentTask.mockImplementation(
    () => new Promise<void>((_resolve, reject) => { rejectStop = reject; }),
  );
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  // The stop control keeps one stable element across the pending state, but
  // its label flips to "stopping" while the request is in flight.
  const abort = () =>
    dock.querySelector<HTMLButtonElement>(
      '[aria-label="Stop this turn"], [aria-label="Stopping…"]',
    )!;
  expect(abort()).not.toBeNull();
  // Both clicks land in the same batch: the second must not fan out another
  // cancel even before React commits the pending state between the events.
  await act(async () => {
    abort().click();
    abort().click();
  });
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(1);
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'main', 'task-1');
  expect(abort().disabled).toBe(true);
  expect(abort().getAttribute('aria-label')).toBe(translate('en', 'tasks.stopping'));
  expect(harness.pushToast).not.toHaveBeenCalled();
  // The stop rejects: the failure surfaces as an error toast, never as success,
  // and the guard clears so the user can retry.
  await act(async () => { rejectStop(new Error('stop unavailable')); });
  await settle();
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'sv.stopTaskFailed', { detail: 'stop unavailable' }),
  });
  expect(abort().disabled).toBe(false);
  // Retry: a fresh request goes out and settles cleanly this time.
  harness.stopAgentTask.mockResolvedValue(undefined);
  await act(async () => { abort().click(); });
  await settle();
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(2);
  expect(abort().disabled).toBe(false);
  expect(harness.pushToast).toHaveBeenCalledTimes(1);
});

it('recovers the stop control after a successful stop pending round trip', async () => {
  let resolveStop: () => void = () => undefined;
  harness.stopAgentTask.mockImplementation(
    () => new Promise<void>((resolve) => { resolveStop = resolve; }),
  );
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  const abort = () =>
    dock.querySelector<HTMLButtonElement>(
      '[aria-label="Stop this turn"], [aria-label="Stopping…"]',
    )!;
  await act(async () => { abort().click(); });
  expect(abort().disabled).toBe(true);
  await act(async () => { resolveStop(); });
  await settle();
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(1);
  expect(abort().disabled).toBe(false);
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('stops a nested subagent task through its parent agent scope', async () => {
  const forest = nestedForest();
  // The dispatch task for B lives on A's task service; the session snapshot
  // carries none of it.
  const parentState = {
    ...createViewState('session'),
    loaded: true,
    tasks: [{ id: 'spawn-b', kind: 'subagent', status: 'running', agent_id: 'agent-b' }] as never,
  };
  harness.stopAgentTask.mockResolvedValue(undefined);
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'agent-b' },
    forest,
    controller: controllerStub({
      forest,
      agentStates: {
        'agent-a': parentState,
        'agent-b': { ...createViewState('session'), loaded: true },
      },
    }),
    sessionState: { ...createViewState('session'), loaded: true },
  });
  await settle();
  const abort = dock.querySelector<HTMLButtonElement>('[aria-label="Stop this turn"]');
  expect(abort).not.toBeNull();
  await act(async () => { abort?.click(); });
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'agent-a', 'spawn-b');
});

it('disables composer, model, and attach when the forest does not know the agent', async () => {
  await renderWorkspace({ forest: forestWithoutChild() });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
  expect(textarea?.disabled).toBe(true);
  expect(textarea?.placeholder).toBe(translate('en', 'subagent.composerUnavailable'));
  expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')).toBeNull();
  expect(dock.querySelector('[data-composer-engine-model]')).not.toBeNull();
  expect((await attachmentButton()).disabled).toBe(true);
  expect(dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.setAgentModel).not.toHaveBeenCalled();
  // The effort ladder rides the same gate: an unreachable agent offers no pick
  // and never reaches the effort switch.
  expect(dock.querySelector('[data-effort]')).toBeNull();
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
});

it('drops picker results that resolve after the agent leaves the forest', async () => {
  let resolvePicker: (files: Array<{ name: string; size: number; type: string; read(): Promise<File> }>) => void = () => undefined;
  const pickFiles = vi.fn(() => new Promise<Array<{ name: string; size: number; type: string; read(): Promise<File> }>>((resolve) => {
    resolvePicker = resolve;
  }));
  harness.host = { kind: 'browser', pickFiles };
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  const attachButton = await attachmentButton();
  expect(attachButton.disabled).toBe(false);
  await act(async () => { attachButton.click(); });
  expect(pickFiles).toHaveBeenCalledTimes(1);
  // The agent drops out of the forest while the picker is still open.
  await renderWorkspace({ forest: forestWithoutChild() });
  await settle();
  expect((await attachmentButton()).disabled).toBe(true);
  const file = new File(['x'], 'shot.png', { type: 'image/png' });
  resolvePicker([{ name: 'shot.png', size: 1, type: 'image/png', read: async () => file }]);
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).toBeNull();
});

it('keeps the preview-tab composer disabled for an agent the forest does not know', async () => {
  const previewHeader = document.createElement('div');
  const previewDock = document.createElement('div');
  document.body.append(previewHeader, previewDock);
  try {
    await renderWorkspace({
      forest: forestWithoutChild(),
      slots: {
        header: previewHeader,
        dock: previewDock,
        heroFooter: null,
        footer: null,
        rail: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      showBreadcrumb: false,
    });
    await settle();
    expect(previewDock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(true);
    expect(previewDock.querySelector<HTMLButtonElement>('#composer-model-select')).toBeNull();
    expect(previewDock.querySelector('[data-composer-engine-model]')).not.toBeNull();
  } finally {
    previewHeader.remove();
    previewDock.remove();
  }
});

const EMPTY_AGENT_STATE = {
  ...createViewState(''),
  loaded: true,
  transcriptReady: true,
  historyCoverageKind: 'full' as const,
};

it('mounts no annotation tray over the child dock — sent notes fold into the message bubble', async () => {
  const forest = testForest('completed');
  const blocks = [
    { id: 'a1', kind: 'assistant', text: 'The cursor pages older turns in batches of twenty.' },
    { id: 'u2', kind: 'user', text: `${buildAnnotationsPrefix([{ quote: 'batches of twenty', comment: 'match the cap' }])}ok?` },
  ] as unknown as ReturnType<typeof createViewState>['blocks'];
  await renderWorkspace({
    forest,
    controller: controllerStub({ forest, agentStates: { child: { ...createViewState('session'), loaded: true, blocks } } }),
  });
  await settle();
  // The "N notes already in this conversation" line is gone for good; the
  // note rides its own message (the transcript renders the bubble).
  expect(dock.querySelector('[data-annotation-tray-toggle]')).toBeNull();
  expect(container.querySelector('[data-annotation-tray]')).toBeNull();
});

/**
 * Minimal live-controller seat for the per-agent snapshots the workspace reads:
 * the child's live view state, the session forest, and the PARENT's task list
 * (a nested dispatch task is registered on its parent's task service, which is
 * the same per-agent view state the rail renders).
 */
function controllerStub(input: {
  forest: AgentForest;
  agentStates: Record<string, ReturnType<typeof createViewState>>;
}): SessionController {
  return {
    subscribeAgent: () => () => {},
    getAgentState: (agentId: string) => input.agentStates[agentId] ?? EMPTY_AGENT_STATE,
    getForest: () => input.forest,
    retainHistoryRead: () => () => {},
    retainHistoryPreview: () => () => {},
    historyPreviewPending: () => false,
  } as unknown as SessionController;
}

/** main → A → B, all running: B's task is owned by A, not by the session. */
function nestedForest(): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'running', busy: true,
    toolCallCount: 0, childIds: ['agent-a'],
  };
  const a: AgentTreeNode = {
    agentId: 'agent-a', parentAgentId: 'main', name: 'A', label: 'A', status: 'running', busy: true,
    toolCallCount: 0, childIds: ['agent-b'],
  };
  const b: AgentTreeNode = {
    agentId: 'agent-b', parentAgentId: 'agent-a', name: 'B', label: 'B', status: 'running', busy: true,
    toolCallCount: 0, childIds: [],
  };
  return { roots: [main], byId: { main, 'agent-a': a, 'agent-b': b } };
}

function forestWithoutChild(): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: [],
  };
  return { roots: [main], byId: { main } };
}

function testForest(
  status: AgentTreeNode['status'] = 'completed',
  busy = false,
  child: Partial<AgentTreeNode> = {},
): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: ['child'],
  };
  const childNode: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'general', label: 'General',
    model: 'fixture/kiki-pro',
    status, busy, toolCallCount: 0, childIds: [],
    ...child,
  };
  return { roots: [main], byId: { main, child: childNode } };
}

function externalModelCatalog(executor = 'example-acp', state: 'ready' | 'partial' | 'unknown' = 'ready', unsupported = false) {
  return {
    executor_id: executor, source: 'cli_probe', provenance: 'read_only_cli_probe',
    revision: 'fixture', apply_state: 'ready', observed_at: Date.now(),
    effective: {
      models: { state, values: ['gemini-3.8-flash-medium', 'vendor/other'] },
      thinking_levels: { state: 'ready', values: ['medium', 'high'] },
      context: { state: 'unknown' },
      controls: {
        model_switch: { applicability: unsupported ? 'unsupported' : 'fresh_binding', apply_state: unsupported ? 'unsupported' : 'applied' },
        thinking_switch: { applicability: 'fresh_binding', apply_state: 'applied' },
        manual_compact: { applicability: 'unsupported', apply_state: 'unsupported' },
      },
    },
  };
}

it('replies with a known external binding before the presentation profile arrives after 3 seconds', async () => {
  let presentationReady = false;
  harness.readCapabilities.mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => { presentationReady = true; resolve({ profile: { name: 'general', restrict_models_to_menu: true, model_menu: [] } }); }, 3000);
  }));
  harness.sendAgentMessage.mockResolvedValue({});
  await renderWorkspace({ forest: testForest('running', true, { executorId: 'example-acp', executorProtocol: 'acp-v1', model: 'gemini-3.8-flash-medium' }) });
  await settle();
  expect(harness.getAgentExecutor).not.toHaveBeenCalled();
  expect(harness.getExecutorModels).toHaveBeenCalledWith('example-acp');
  expect(dock.querySelector('[data-selection-diagnostic]')).toBeNull();
  await typeText(dock.querySelector('textarea')!, 'continue on the bound executor');
  const send = dock.querySelector<HTMLButtonElement>('[aria-label="Queue prompt"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => { send.click(); });
  await settle();
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'continue on the bound executor', expect.any(Array), expect.any(String), undefined);
  expect(presentationReady).toBe(false);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3000)); });
  expect(presentationReady).toBe(true);
  await settle();
  expect(dock.querySelector('[data-selection-diagnostic]')).toBeNull();
});

it('lists and switches raw models and efforts from the actual external executor, not native aliases', async () => {
  harness.listModels.mockResolvedValue({ items: [{ id: 'native/gemini-3.8-flash-medium', remote_id: 'gemini-3.8-flash-medium', provider_id: 'native', display_name: 'Native display' }] });
  await renderWorkspace({ forest: testForest('running', true, { executorId: 'example-acp', model: 'gemini-3.8-flash-medium', thinkingEffort: 'medium' }) });
  await settle();
  const pick = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  expect(pick.textContent).toContain('gemini-3.8-flash-medium');
  expect(pick.textContent).not.toContain('Native display');
  expect(pick.title).toContain('example-acp');
  await act(async () => { pick.click(); });
  expect(Array.from(dock.querySelectorAll('[role="option"]')).map((row) => row.getAttribute('data-option-value'))).toEqual(['gemini-3.8-flash-medium', 'vendor/other']);
  expect(dock.querySelector('[data-model-configure]')).toBeNull();
  await act(async () => { dock.querySelector<HTMLButtonElement>('[data-option-value="vendor/other"]')!.click(); });
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'vendor/other');
  await act(async () => { pick.click(); });
  expect(Array.from(dock.querySelectorAll('[data-effort]')).map((row) => row.getAttribute('data-effort'))).toEqual(['medium', 'high']);
  await act(async () => { dock.querySelector<HTMLButtonElement>('[data-effort="high"]')!.click(); });
  expect(harness.setAgentEffort).toHaveBeenCalledWith('session', 'child', 'high');
  expect(dock.querySelector('[data-binding-setting="next_message"]')?.textContent).toContain('Applies from the next message');
  expect(dock.querySelectorAll('[data-binding-setting]')).toHaveLength(1);
  expect(harness.switchAgentModel).not.toHaveBeenCalled();
});

it.each(['unknown', 'partial', 'failed', 'unsupported'] as const)('keeps %s external catalogs sendable without native replacement choices', async (kind) => {
  if (kind === 'failed') harness.getExecutorModels.mockRejectedValue(new Error('executor directory unavailable'));
  else harness.getExecutorModels.mockResolvedValue(externalModelCatalog('example-acp', kind === 'partial' ? 'partial' : kind === 'unknown' ? 'unknown' : 'ready', kind === 'unsupported'));
  await renderWorkspace({ forest: testForest('completed', false, { executorId: 'example-acp', model: 'vendor/unlisted' }) });
  await settle();
  await typeText(dock.querySelector('textarea')!, 'resume');
  expect(dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
  expect(dock.querySelector('[data-selection-diagnostic]')).toBeNull();
  const pick = dock.querySelector<HTMLButtonElement>('#composer-model-select');
  if (kind === 'partial') {
    await act(async () => { pick!.click(); });
    expect(dock.querySelector('[data-option-value="vendor/unlisted"]')).not.toBeNull();
    expect(dock.querySelector('[data-option-value="fixture/kiki-pro"]')).toBeNull();
  } else {
    expect(pick).toBeNull();
    expect(dock.querySelector('[data-composer-engine-model]')?.textContent).toContain('vendor/unlisted');
  }
});

it('blocks a truly invalid native model and effort while external identities remain independent', async () => {
  await renderWorkspace({ forest: testForest('completed', false, { executorId: 'native', model: 'vendor/missing' }) });
  await settle();
  await typeText(dock.querySelector('textarea')!, 'resume');
  expect(dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
  expect(dock.querySelector('[data-selection-diagnostic]')?.textContent).toContain('vendor/missing');
});

it('waits for the real child binding and offers retry on failure instead of assuming native', async () => {
  harness.getAgentExecutor.mockRejectedValue(new Error('binding read failed'));
  await renderWorkspace();
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  expect(dock.querySelector('[data-selection-diagnostic]')).toBeNull();
  harness.getAgentExecutor.mockResolvedValue('example-acp');
  await act(async () => { Array.from(dock.querySelectorAll('button')).find((button) => button.textContent === 'Retry')!.click(); });
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
  expect(harness.getExecutorModels).toHaveBeenCalledWith('example-acp');
});

it('does not carry an external catalog across executor or connection scope changes', async () => {
  harness.getExecutorModels.mockImplementation((id: string) => Promise.resolve({ ...externalModelCatalog(id), effective: { ...externalModelCatalog(id).effective, models: { state: 'ready', values: [`${harness.scopeId}/${id}`] } } }));
  await renderWorkspace({ forest: testForest('completed', false, { executorId: 'example-acp', model: 'raw/current' }) });
  await settle();
  await act(async () => { dock.querySelector<HTMLButtonElement>('#composer-model-select')!.click(); });
  expect(dock.querySelector('[data-option-value="direct:one/example-acp"]')).not.toBeNull();
  await renderWorkspace({ forest: testForest('completed', false, { executorId: 'other-acp', model: 'raw/other' }) });
  await settle();
  expect(dock.querySelector('[data-option-value="direct:one/example-acp"]')).toBeNull();
  harness.scopeId = 'direct:two';
  await renderWorkspace({ forest: testForest('completed', false, { executorId: 'other-acp', model: 'raw/other' }) });
  await settle();
  const pick = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  if (dock.querySelector('[role="option"]') === null) await act(async () => { pick.click(); });
  expect(dock.querySelector('[data-option-value="direct:two/other-acp"]')).not.toBeNull();
  expect(dock.querySelector('[data-option-value="direct:one/other-acp"]')).toBeNull();
});

function renderWorkspace(overrides: Partial<ComponentProps<typeof AgentWorkspace>> = {}) {
  const previewRef = createRef<MediaPreviewApi>();
  return act(async () => root.render(
    <QueryClientProvider client={queries}>
      <I18nProvider>
        <MemoryRouter>
          <AgentWorkspace
          target={{ sessionId: 'session', agentId: 'child' }}
          controller={null}
          sessionState={{ ...createViewState('session'), loaded: true }}
          forest={testForest()}
          navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
          railOpen={false}
          railIsOverlay={false}
          onToggleRail={vi.fn()}
          onCloseRail={vi.fn()}
          onCancelTask={vi.fn()}
          onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
          previewApiRef={previewRef}
          {...overrides}
        />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ));
}

it('releases per-agent transcript observation while an embedded tab is hidden', async () => {
  const release = vi.fn();
  const subscribeAgent = vi.fn(() => release);
  const controller = Object.assign(
    controllerStub({ forest: testForest(), agentStates: {} }),
    { subscribeAgent },
  );
  await renderWorkspace({ controller, transcriptVisible: true });
  expect(subscribeAgent).toHaveBeenCalledWith('child', expect.any(Function));
  expect(release).not.toHaveBeenCalled();

  await renderWorkspace({ controller, transcriptVisible: false });
  expect(release).toHaveBeenCalledTimes(1);
  expect(subscribeAgent).toHaveBeenCalledTimes(1);

  await renderWorkspace({ controller, transcriptVisible: true });
  expect(subscribeAgent).toHaveBeenCalledTimes(2);
});

it('mounts the owned media preview provider with the shared api ref by default', async () => {
  const previewRef = createRef<MediaPreviewApi>();
  const onToggleRail = vi.fn();
  await renderWorkspace({ previewApiRef: previewRef, onToggleRail });
  await settle();

  expect(harness.mediaProviderProps.length).toBeGreaterThan(0);
  expect(harness.mediaProviderProps[0]?.apiRef).toBe(previewRef);
  expect(header.querySelector('[data-preview-toggle-probe]')).not.toBeNull();
  // The shared rail's open-rail entry rides the workspace header while the
  // rail is collapsed, so a closed rail is reopenable from the agent page too.
  const toggle = header.querySelector<HTMLButtonElement>('[data-agent-rail-toggle]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => { toggle?.click(); });
  expect(onToggleRail).toHaveBeenCalledTimes(1);
});

it('renders no rail hide button once the rail is expanded', async () => {
  // The expanded rail keeps its own collapse affordances; this header carries
  // no "hide panel" button (the deleted view-level toggle).
  await renderWorkspace({ railOpen: true, onToggleRail: vi.fn() });
  await settle();

  expect(header.querySelector('[data-agent-rail-toggle]')).toBeNull();
  expect(header.textContent).not.toContain('← Back to session');
});

it('keeps the rail reopenable on the agent page after a closed rail (wide-screen route state)', async () => {
  // Main page closes the rail, then the user enters the same session's
  // subagent route: railOpen=false survives, the agent header replaces the
  // main header, and the shared rail's own toggle must still be reachable.
  const onToggleRail = vi.fn();
  await renderWorkspace({ railOpen: false, onToggleRail });
  await settle();

  const toggle = header.querySelector<HTMLButtonElement>('[data-agent-rail-toggle]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.getAttribute('title')).toBe('Show panel');
  // The toggle acts on the shared rail (the caller's state), not a local one.
  await act(async () => { toggle?.click(); });
  expect(onToggleRail).toHaveBeenCalledTimes(1);
  // No back-to-session button and no view-level hide button: navigation lives
  // in the breadcrumb/relations row, and the toggle is the rail's own control.
  expect(header.textContent).not.toContain('← Back to session');
});

it('embeds into caller-provided slots: no shell, no owned preview provider, no panel toggle', async () => {  harness.shellEnabled = false;
  const localHeader = document.createElement('div');
  document.body.append(localHeader);
  try {
    await renderWorkspace({
      slots: {
        header: localHeader,
        dock: null,
        heroFooter: null,
        rail: null,
        footer: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      previewApiRef: undefined,
    });
    await settle();

    // The header chrome portals into the provided slot even with no ambient shell.
    // The rail toggle defaults on; an embedding shell that passes
    // showRailToggle={false} (the preview tab, whose railOpen is a local
    // no-op) suppresses it.
    expect(localHeader.querySelector('[data-agent-rail-toggle]')).not.toBeNull();
    expect(header.querySelector('[data-agent-rail-toggle]')).toBeNull();
    // Ambient preview provider inherited: no owned provider, no apiRef seat.
    expect(harness.mediaProviderProps).toHaveLength(0);
    // The preview-panel toggle is suppressed where the workspace IS the panel.
    expect(localHeader.querySelector('[data-preview-toggle-probe]')).toBeNull();
  } finally {
    localHeader.remove();
  }
});

it('renders the agent’s own context meter and cumulative totals in the fullscreen dock', async () => {
  const childState = {
    ...createViewState('session'),
    loaded: true,
    contextTokens: 5_000,
    maxContextTokens: 10_000,
    usage: { total: { inputOther: 1_200, output: 340, inputCacheRead: 56, inputCacheCreation: 8 } },
  };
  // The card's cumulative block reads the canonical per-agent row, not the
  // snapshot projection: gross input counts the cache buckets separately.
  harness.readCapabilities.mockResolvedValue({
    context: 'live', owner: { profile: 'general', agent_id: 'child' }, available: true,
    profile: { name: 'general' }, targets: [], tools: [], skills: [],
    metrics: { child: {
      inputTokens: 1_264, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 8, totalTokens: 1_604,
      totalCostUsd: null, contextTokens: null, contextLimit: null, compactionCount: null,
      usageComplete: true, usagePartial: false, costPartial: true,
    } },
  });
  await renderWorkspace({
    controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
  });
  await settle();

  const meter = dock.querySelector<HTMLButtonElement>('[data-context-meter]');
  expect(meter).not.toBeNull();
  // 50% exactly is the warn threshold.
  expect(meter?.getAttribute('data-context-level')).toBe('warn');
  expect(meter?.textContent).toContain('50');

  await act(async () => { meter!.click(); });
  const details = dock.querySelector('[data-context-details]');
  const usageCard = details?.querySelector('[data-context-usage]');
  expect(usageCard?.textContent).toContain('Agent cumulative');
  expect(usageCard?.textContent).not.toContain('Session cumulative');
  expect(usageCard?.textContent).toContain('1.2k');
  expect(usageCard?.textContent).toContain('340');
  // Per-agent projections carry no pricing: the cost row stays hidden rather
  // than reading as $0.00, and a subagent has no compact action.
  expect(usageCard?.textContent).not.toContain('Cost');
  expect(details?.querySelector('[data-context-compact]')).toBeNull();
  // The deep link still targets the owning session's usage page.
  expect(usageCard?.querySelector('[data-context-usage-link]')).not.toBeNull();
});

it('turns the agent meter red past the danger threshold and neutral below warn', async () => {
  const childState = {
    ...createViewState('session'),
    loaded: true,
    contextTokens: 8_500,
    maxContextTokens: 10_000,
  };
  await renderWorkspace({
    controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
  });
  await settle();
  expect(dock.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe('danger');
});

it('omits the meter when the agent projection carries no context data', async () => {
  await renderWorkspace({
    controller: controllerStub({
      forest: testForest(),
      agentStates: { child: { ...createViewState('session'), loaded: true } },
    }),
  });
  await settle();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).not.toBeNull();
  expect(dock.querySelector('[data-context-meter]')).toBeNull();
});

it('renders the agent context meter in the preview-tab dock slots', async () => {
  const previewHeader = document.createElement('div');
  const previewDock = document.createElement('div');
  document.body.append(previewHeader, previewDock);
  try {
    const childState = {
      ...createViewState('session'),
      loaded: true,
      contextTokens: 2_000,
      maxContextTokens: 10_000,
    };
    await renderWorkspace({
      controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
      slots: {
        header: previewHeader,
        dock: previewDock,
        heroFooter: null,
        footer: null,
        rail: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      showBreadcrumb: false,
    });
    await settle();
    const meter = previewDock.querySelector('[data-context-meter]');
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute('data-context-level')).toBe('ok');
    expect(meter?.textContent).toContain('20');
  } finally {
    previewHeader.remove();
    previewDock.remove();
  }
});

it('hosts main in the shared timeline and chrome without child commands or another preview provider', async () => {
  const sessionState = { ...createViewState('session'), loaded: true };
  const retainHistoryRead = vi.fn(() => () => {});
  const controller = Object.assign(controllerStub({ forest: testForest(), agentStates: {} }), { retainHistoryRead });
  await renderWorkspace({
    controller,
    target: { sessionId: 'session', agentId: 'main' },
    sessionState,
    forest: testForest(),
    inheritMediaPreview: true,
    main: {
      header: <header data-main-header>Session controls</header>,
      timeline: {
        state: sessionState,
        onLoadOlder: vi.fn().mockResolvedValue(false),
        onResolveApproval: vi.fn().mockResolvedValue(undefined),
        onAnswerQuestion: vi.fn().mockResolvedValue(undefined),
        onDismissQuestion: vi.fn().mockResolvedValue(undefined),
      },
      dock: <div data-main-dock>Goal and queue</div>,
      rail: <div data-main-rail>Session details</div>,
    },
    railOpen: true,
    slots: { header, dock, rail: container, heroFooter: null, footer: null, preview: null },
  });
  expect(header.querySelector('[data-main-header]')).not.toBeNull();
  expect(container.querySelector('[data-agent-workspace-target="main"] [data-timeline-agent="main"]')).not.toBeNull();
  expect(dock.querySelector('[data-main-dock]')?.textContent).toContain('Goal and queue');
  expect(container.querySelector('[data-main-rail]')).not.toBeNull();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).toBeNull();
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.mediaProviderProps).toHaveLength(0);
  expect(retainHistoryRead).not.toHaveBeenCalled();
  expect(container.querySelector('[data-temporary-history-limit]')).toBeNull();
});


function pendingSwitch(operationId: string, queueIndex: number): QueuedModelSwitch {
  return { input: { operationId, model: `example/${operationId}`, mode: 'direct' }, revision: 0,
    receipt: { operationId, agentId: 'child', state: 'pending', mode: 'direct', fromModel: 'example/original', toModel: `example/${operationId}` },
    originalBinding: { model: 'example/original', thinking: '' }, queueIndex };
}

it('sends after the second pending switch and freezes that execution payload across a lost native acceptance', async () => {
  const switches = [pendingSwitch('first-operation', 0), pendingSwitch('tail-operation', 2)];
  harness.listAgentModelSwitches.mockResolvedValue(switches);
  let onEvent!: (event: AgentModelSwitchEvent) => void;
  harness.subscribeAgentModelSwitches.mockImplementation((_session, _agent, listener) => {
    onEvent = listener; return { ready: Promise.resolve(), dispose: () => {} };
  });
  harness.sendAgentMessage.mockRejectedValueOnce(new NativeChildPromptSendError(new Error('response lost'))).mockResolvedValueOnce(null);
  await renderWorkspace({ forest: testForest('completed') }); await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'continue on the target');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(); });
  const firstCall = harness.sendAgentMessage.mock.calls[0];
  expect(firstCall).toEqual(['session', 'child', 'continue on the target', [{ type: 'text', text: 'continue on the target' }], expect.any(String), 'tail-operation']);
  expect(textarea.value).toBe('continue on the target');
  await act(async () => { onEvent({ kind: 'queued', entry: pendingSwitch('later-operation', 3), queueIndex: 3 }); });
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(); });
  expect(harness.sendAgentMessage.mock.calls[1]).toEqual(firstCall);
  expect(textarea.value).toBe('');
});

it.each(['native', 'external'])(
  'keeps pending switch dependencies out of Send now execution for %s', async (executor) => {
    harness.listAgentModelSwitches.mockResolvedValue([pendingSwitch('tail-operation', 2)]);
    harness.isNativeAgent.mockResolvedValue(executor === 'native');
    const sendPromptNow = vi.fn().mockResolvedValue({ outcome: 'steered' });
    const forest = testForest('running', true);
    const controller = Object.assign(controllerStub({ forest, agentStates: {} }), { sendPromptNow });
    await renderWorkspace({ forest, controller }); await settle();
    const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await typeText(textarea, 'send on current binding');
    await sendNowFromComposer();
    expect(sendPromptNow).toHaveBeenCalledWith({ agentId: 'child', text: 'send on current binding', content: [{ type: 'text', text: 'send on current binding' }] });
    expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  },
);

it('renews the child context from its own menu, on the panel opened for fresh', async () => {
  const forest = testForest('completed');
  const blocks = [{ id: 'a1', kind: 'assistant', text: 'First pass done.' }] as unknown as ReturnType<typeof createViewState>['blocks'];
  await renderWorkspace({
    forest,
    controller: controllerStub({ forest, agentStates: { child: { ...createViewState('session'), loaded: true, blocks } } }),
  });
  await settle();
  const trigger = header.querySelector<HTMLButtonElement>('[data-agent-actions] button');
  expect(trigger).not.toBeNull();
  await act(async () => { trigger?.click(); });
  const item = document.body.querySelector<HTMLButtonElement>('[data-agent-fresh-context]');
  expect(item?.textContent).toBe(translate('en', 'modelSwitch.menuFreshContext'));
  await act(async () => { item?.click(); });
  // Same model, so only the two context-renewing modes: no direct row, fresh
  // already selected, and the panel renames itself.
  expect(document.body.querySelector('[data-model-switch-mode="direct"]')).toBeNull();
  expect(document.body.querySelector('[data-model-switch-mode="fresh"]')?.getAttribute('aria-checked')).toBe('true');
  expect(document.body.querySelector('[data-model-switch-mode="compact"]')).not.toBeNull();
  expect(document.body.textContent).toContain(translate('en', 'modelSwitch.dialog.titleSameModel'));
});

it('keeps no child menu when the child has no conversation to renew', async () => {
  await renderWorkspace({ controller: controllerStub({ forest: testForest(), agentStates: {} }) });
  await settle();
  expect(header.querySelector('[data-agent-actions]')).toBeNull();
});


it('keeps child A text and attachments through real A/B/A routes without sending them to B', async () => {
  harness.sendAgentMessage.mockResolvedValue(null);
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'a.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'a.png', { type: 'image/png' }),
  }] };
  const other: AgentTreeNode = { ...testForest().byId['child']!, agentId: 'other', name: 'other' };
  const forest = { ...testForest(), byId: { ...testForest().byId, other } };
  function RoutedWorkspace() {
    const { agentId } = useParams();
    return <AgentWorkspace
      target={{ sessionId: 'session', agentId: agentId! }} controller={null}
      sessionState={{ ...createViewState('session'), loaded: true }} forest={forest}
      navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
      railOpen={false} railIsOverlay={false} onToggleRail={vi.fn()} onCloseRail={vi.fn()}
      onCancelTask={vi.fn()} onStopAgentTask={vi.fn()}
    />;
  }
  function RoutedHarness() {
    const navigate = useNavigate();
    return <>
      <button data-child-a onClick={() => { void navigate('/s/session/agent/child'); }}>A</button>
      <button data-child-b onClick={() => { void navigate('/s/session/agent/other'); }}>B</button>
      <Routes><Route path="/s/:sessionId/agent/:agentId" element={<RoutedWorkspace />} /></Routes>
    </>;
  }
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider>
    <MemoryRouter initialEntries={['/s/session/agent/child']}><RoutedHarness /></MemoryRouter>
  </I18nProvider></QueryClientProvider>));
  await settle();
  await typeText(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, 'DRAFT FOR A');
  await clickAttach();
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-child-b]')!.click(); });
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('');
  expect(dock.querySelector('[data-attachment-chips]')).toBeNull();
  await sendFromComposer('MESSAGE FOR B');
  expect(harness.sendAgentMessage.mock.calls[0]?.slice(0, 4)).toEqual([
    'session', 'other', 'MESSAGE FOR B', [{ type: 'text', text: 'MESSAGE FOR B' }],
  ]);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-child-a]')!.click(); });
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('DRAFT FOR A');
  expect(dock.querySelector('[data-attachment-chips] img')?.getAttribute('alt')).toBe('a.png');
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.slice(0, 3)).toEqual(['session', 'child', 'DRAFT FOR A']);
  expect(harness.sendAgentMessage.mock.calls[1]?.[3]).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
});

it('falls back to main agent as parent when subagent is missing from forest', () => {
  const forest = forestWithoutChild();
  const related = relatedAgentNodes(forest, 'missing-child');
  expect(related.parent?.agentId).toBe('main');
  expect(related.siblings).toEqual([]);
  expect(related.children).toEqual([]);
});

it('retains delta view on mount and releases on unmount for deep-linked child agent', async () => {
  const retainAgentView = vi.fn();
  const releaseAgentView = vi.fn();
  const updateAgentView = vi.fn();
  const controller = Object.assign(
    controllerStub({ forest: testForest(), agentStates: {} }),
    { retainAgentView, releaseAgentView, updateAgentView },
  );
  await renderWorkspace({ controller, transcriptVisible: true });
  expect(retainAgentView).toHaveBeenCalledWith('workspace:session:child', 'child', 'delta');

  await act(async () => { root.unmount(); });
  expect(releaseAgentView).toHaveBeenCalledWith('workspace:session:child');
});

it('opens a persisted body when the recent forest omits its agent, but keeps the body as the continuation evidence', async () => {
  const legacyState = {
    ...createViewState('session'),
    loaded: true,
    transcriptReady: true,
    model: 'legacy/model',
    historyCoverageKind: 'full' as const,
    blocks: [{ kind: 'user', id: 'legacy-user', text: 'saved history' }] as never,
  };
  const forest = forestWithoutChild();
  const controller = controllerStub({ forest, agentStates: { child: legacyState } });
  await renderWorkspace({ controller, forest });
  await settle();

  expect(container.querySelector('[data-timeline-agent="child"]')?.getAttribute('data-timeline-blocks')).toBe('1');
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(false);
  expect(agentContinuationAvailable({ controller, node: undefined, subagent: undefined, state: legacyState })).toBe(true);
});

it('settles a loaded partial empty target as unavailable and never enables continuation', async () => {
  const main = forestWithoutChild().byId['main']!;
  const unknown: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'child', label: 'child', status: 'unknown',
    busy: false, toolCallCount: 0, childIds: [],
  };
  const forest: AgentForest = { roots: [main], byId: { main: { ...main, childIds: ['child'] }, child: unknown } };
  const unknownState = {
    ...createViewState('session'),
    loaded: true,
    transcriptReady: true,
    historyCoverageKind: 'unknown' as const,
  };
  const controller = controllerStub({ forest, agentStates: { child: unknownState } });
  await renderWorkspace({ controller, forest });
  await settle();

  expect(agentContinuationAvailable({ controller, node: unknown, subagent: undefined, state: unknownState })).toBe(false);
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(true);
  expect(container.querySelector('[data-timeline-error]')?.getAttribute('data-timeline-error')).toContain('Name not registered');
  expect(harness.getAgentExecutor).not.toHaveBeenCalled();
  await typeText(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!, 'must not send');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(); });
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
});


it('keeps a known legacy child editable when its executor metadata is absent', async () => {
  harness.getAgentExecutor.mockResolvedValue(undefined);
  await renderWorkspace({ forest: testForest('completed', false) });
  await settle();
  expect(harness.getAgentExecutor).toHaveBeenCalledWith('child');
  expect(queries.getQueryState(['agentExecutor', 'direct:one', 'session', 'child'])?.status).toBe('success');
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(false);
  expect(dock.textContent).not.toContain('data is undefined');
});

it('keeps a failed legacy executor read retryable without choosing a native executor', async () => {
  harness.getAgentExecutor.mockRejectedValue(new Error('executor metadata unavailable'));
  await renderWorkspace({ forest: testForest('completed', false) });
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(true);
  expect(dock.textContent).toContain('executor metadata unavailable');
  expect(dock.querySelector('button')?.textContent).toBe(translate('en', 'common.retry'));
});

async function clickRuntimeControl(selector: string) {
  const button = dock.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}

it('updates only the selected child permission and displays its effective ceiling', async () => {
  harness.getPermission.mockResolvedValue('manual');
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  await clickRuntimeControl('button[aria-label="Approvals"]');
  await clickRuntimeControl('[data-permission-mode="yolo"]');
  expect(harness.agent).toHaveBeenCalledWith('child');
  expect(harness.setPermission).toHaveBeenCalledWith('yolo', { broadcast: false });
  expect(dock.querySelector('button[aria-label="Approvals"]')?.textContent).toContain('Ask every time');
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
});

it('hides child runtime mode controls when an external executor owns them', async () => {
  await renderWorkspace({ forest: testForest('running', true, { executorId: 'example-acp', model: 'vendor/model' }) });
  await settle();
  expect(dock.querySelector('[data-runtime-modes-external]')?.textContent).toBe(translate('en', 'subagent.runtimeModesExternal'));
  expect(dock.querySelector('button[aria-label="Approvals"]')).toBeNull();
  await clickRuntimeControl('[data-add-menu-trigger]');
  expect(dock.querySelector('[data-add-menu-mode]')).toBeNull();
  expect(harness.setPermission).not.toHaveBeenCalled();
  expect(harness.enterPlan).not.toHaveBeenCalled();
});

it('enters and exits child plan mode live and restores a failed choice', async () => {
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  await clickRuntimeControl('[data-add-menu-trigger]');
  await clickRuntimeControl('[data-add-menu-mode]');
  await clickRuntimeControl('[data-mode-switch="plan"]');
  expect(harness.enterPlan).toHaveBeenCalledOnce();
  expect(dock.querySelector('[data-mode-switch="plan"]')?.getAttribute('aria-checked')).toBe('true');
  harness.exitPlan.mockRejectedValueOnce(new Error('child mode write failed'));
  await clickRuntimeControl('[data-mode-switch="normal"]');
  expect(dock.querySelector('[data-mode-switch="plan"]')?.getAttribute('aria-checked')).toBe('true');
  expect(harness.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', text: expect.stringContaining('child mode write failed') }));
  await clickRuntimeControl('[data-mode-switch="normal"]');
  expect(dock.querySelector('[data-mode-switch="normal"]')?.getAttribute('aria-checked')).toBe('true');
});

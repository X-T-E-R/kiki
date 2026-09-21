// @vitest-environment jsdom
import { act, createRef, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  createViewState,
  type AgentForest,
  type AgentTreeNode,
} from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { AgentWorkspace } from './AgentWorkspace';

const harness = vi.hoisted(() => ({
  header: null as HTMLElement | null,
  dock: null as HTMLElement | null,
  shellEnabled: true,
  listModels: vi.fn(),
  sendAgentMessage: vi.fn(),
  stopAgentTask: vi.fn(),
  setAgentModel: vi.fn(),
  readCapabilities: vi.fn(),
  listSessionSkills: vi.fn(),
  mediaProviderProps: [] as Array<{ apiRef?: unknown }>,
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels: harness.listModels,
      listSessionSkills: harness.listSessionSkills,
      sendAgentMessage: harness.sendAgentMessage,
      stopAgentTask: harness.stopAgentTask,
      setAgentModel: harness.setAgentModel,
    },
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) =>
            harness.readCapabilities(query, options.signal),
        },
      },
    },
  }),
}));

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
vi.mock('../AgentBreadcrumb', () => ({ AgentBreadcrumb: () => null, AgentRelations: () => null }));
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }));
vi.mock('../mediaPreview', () => ({
  MediaPreviewProvider: (props: { children?: ReactNode; apiRef?: unknown }) => {
    harness.mediaProviderProps.push(props);
    return props.children;
  },
  PreviewToggleButton: () => <div data-preview-toggle-probe />,
}));
vi.mock('../RightRail', () => ({ RightRail: () => null }));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: { preparePrompt: vi.fn() } }));
vi.mock('../Transcript', () => ({ Transcript: () => null }));
vi.mock('./ResyncStatusBanner', () => ({ ResyncStatusBanner: () => null }));
vi.mock('./SubagentDetailActions', () => ({ SubagentDetailActions: () => null }));
vi.mock('../../lib/toasts', () => ({ pushToast: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let header: HTMLDivElement;
let dock: HTMLDivElement;
let queries: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.listModels.mockResolvedValue({ items: [] });
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
  harness.mediaProviderProps.length = 0;
  harness.listSessionSkills.mockResolvedValue({ skills: [] });
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

  expect(harness.readCapabilities).not.toHaveBeenCalled();
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
  const sendButton = dock.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Queue prompt"]');
  expect(sendButton?.disabled).toBe(false);
  await act(async () => { sendButton?.click(); });
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ]);
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  expect(modelSelect.disabled).toBe(false);
  await act(async () => { modelSelect.click(); });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[role="option"][title="fixture/other"]')?.click();
  });
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Abort the running prompt"]')?.click(); });
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'main', 'task-1');
});

it.each(['completed', 'cancelled', 'failed'] as const)('disables terminal %s fullscreen composer send and model controls', async (status) => {
  await renderWorkspace({ forest: testForest(status) });
  await settle();
  expect(dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(true);
  expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(true);
  expect(dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.disabled).toBe(true);
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.setAgentModel).not.toHaveBeenCalled();
});

it('keeps preview-tab composer disabled for a cancelled child', async () => {
  const previewHeader = document.createElement('div');
  const previewDock = document.createElement('div');
  document.body.append(previewHeader, previewDock);
  try {
    await renderWorkspace({
      forest: testForest('cancelled'),
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
    expect(previewDock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(true);
  } finally {
    previewHeader.remove();
    previewDock.remove();
  }
});

function testForest(status: AgentTreeNode['status'] = 'completed', busy = false): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: ['child'],
  };
  const child: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'general', label: 'General',
    model: 'fixture/kiki-pro',
    status, busy, toolCallCount: 0, childIds: [],
  };
  return { roots: [main], byId: { main, child } };
}

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

it('mounts the owned media preview provider with the shared api ref by default', async () => {
  const previewRef = createRef<MediaPreviewApi>();
  await renderWorkspace({ previewApiRef: previewRef });
  await settle();

  expect(harness.mediaProviderProps.length).toBeGreaterThan(0);
  expect(harness.mediaProviderProps[0]?.apiRef).toBe(previewRef);
  expect(header.querySelector('[data-preview-toggle-probe]')).not.toBeNull();
  expect(header.querySelector('[data-agent-rail-toggle]')).not.toBeNull();
});

it('embeds into caller-provided slots: no shell, no owned preview provider, no panel toggle', async () => {
  harness.shellEnabled = false;
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

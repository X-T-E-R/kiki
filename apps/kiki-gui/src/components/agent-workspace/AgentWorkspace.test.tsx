// @vitest-environment jsdom
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  listModels: vi.fn(),
  readCapabilities: vi.fn(),
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels: harness.listModels,
      sendAgentMessage: vi.fn(),
      stopAgentTask: vi.fn(),
      setAgentModel: vi.fn(),
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
  useConversationShell: () => ({
    slots: {
      header: harness.header,
      dock: null,
      heroFooter: null,
      rail: null,
      footer: null,
      preview: null,
    },
  }),
}));
vi.mock('../ActivityHistory', () => ({ revealSubagentCard: () => true }));
vi.mock('../AgentBreadcrumb', () => ({ AgentBreadcrumb: () => null, AgentRelations: () => null }));
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }));
vi.mock('../mediaPreview', () => ({
  MediaPreviewProvider: ({ children }: { children: ReactNode }) => children,
  PreviewToggleButton: () => null,
}));
vi.mock('../RightRail', () => ({ RightRail: () => null }));
vi.mock('../Transcript', () => ({ Transcript: () => null }));
vi.mock('./ResyncStatusBanner', () => ({ ResyncStatusBanner: () => null }));
vi.mock('./SubagentDetailActions', () => ({ SubagentDetailActions: () => null }));
vi.mock('../../lib/toasts', () => ({ pushToast: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let header: HTMLDivElement;
let queries: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.listModels.mockResolvedValue({ items: [] });
  container = document.createElement('div');
  header = document.createElement('div');
  document.body.append(container, header);
  harness.header = header;
  root = createRoot(container);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queries.clear();
  harness.header = null;
  container.remove();
  header.remove();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

it('shows the profile dispatch policy when the workspace has no target rows', async () => {
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
      </I18nProvider>
    </QueryClientProvider>,
  ));
  await settle();

  expect(harness.readCapabilities).toHaveBeenCalledWith(
    { session_id: 'session', agent_id: 'child' },
    expect.any(AbortSignal),
  );
  expect(header.querySelector('[data-dispatch-policy="strict"]')?.textContent).toBe('Strict policy');
  expect(header.querySelector('[data-dispatch-policy="unknown"]')).toBeNull();
  expect(header.querySelector('[data-recommendation-status="unknown"]')?.textContent).toBe('Not reported');
});

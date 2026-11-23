// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionViewFacade } from '@kiki/klient/session-view';
import type { SessionSnapshotResponse } from '@kiki/protocol';
import { ApiError, API_CODES } from '@kiki/session-core/transport';

import { I18nProvider } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { ControllerRegistryProvider, LiveControllerRegistry } from '../../state/connection';
import { MobileChatScreen } from './MobileChatScreen';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()?.unmount();
  while (containers.length > 0) containers.pop()?.remove();
});

function createStubClient(options: {
  readonly getSnapshot: () => Promise<SessionSnapshotResponse>;
}): KikiClient {
  const emptyTranscriptPage: Awaited<ReturnType<SessionViewFacade['transcript']['page']>> = {
    session_id: 'session_test',
    agent_id: 'main',
    items: [],
    has_more: false,
    coverage: { kind: 'full', hasMoreOlder: false },
    tasks: [],
    attachments: [],
    interactions: [],
    todos: [],
    prompts: [],
    meta: {},
    agents: [],
    pending_interactions: [],
  };
  const sessions = {
    getSession: () => Promise.resolve({ id: 'session_test', title: 'Mobile Test', delivery: 'reply' }),
  };
  const sessionView = (): SessionViewFacade => ({
    snapshot: () => options.getSnapshot(),
    transcript: {
      page: () => Promise.resolve(emptyTranscriptPage),
      catchUp: () =>
        Promise.resolve({
          session_id: 'session_test',
          agent_id: 'main',
          epoch: 'epoch-1',
          batches: [],
          through_seq: 0,
          complete: true,
        }),
    },
    subscribe: () => ({
      close: () => {},
      nudge: () => {},
      restart: () => {},
      updateSessionCursor: () => {},
      setTranscriptGrades: () => {},
      updateTranscriptCursor: () => {},
    }),
  });
  return {
    baseUrl: 'http://127.0.0.1:0',
    sessions,
    sessionView,
    getModels: () => Promise.resolve({ models: [] }),
    getGitDiff: () => Promise.resolve({ files: [] }),
  } as unknown as KikiClient;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountMobileChat(client: KikiClient): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  const registry = new LiveControllerRegistry({ maxParked: 0 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ControllerRegistryProvider value={registry}>
              <MobileChatScreen
                spaceKey="local"
                spaceName="Main space"
                sessionId="session_test"
                client={client}
                onOpenWorkbench={() => {}}
                onOpenVoiceForChat={() => {}}
              />
            </ControllerRegistryProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  });
  await flushMicrotasks();
  return container;
}

describe('MobileChatScreen initial load failures', () => {
  it('replaces loading with an alert and retries transient initial read failures', async () => {
    let attempts = 0;
    const getSnapshot = vi.fn(async (): Promise<SessionSnapshotResponse> => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary snapshot read failure');
      }
      return {
        as_of_seq: 1,
        epoch: 'epoch-1',
        session: {
          id: 'session_test',
          workspace_id: 'wd_test_000000000000',
          title: 'Recovered Session',
          created_at: '2026-11-23T00:00:00Z',
          updated_at: '2026-11-23T00:00:00Z',
          busy: false,
          metadata: { cwd: '/repo' },
          agent_config: { model: '' },
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
        },
        messages: { items: [], has_more: false },
        in_flight_turn: null,
        pending_approvals: [],
        pending_questions: [],
      };
    });
    const container = await mountMobileChat(createStubClient({ getSnapshot }));

    const alert = container.querySelector('[data-mobile-load-error]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('temporary snapshot read failure');
    const retryButton = container.querySelector<HTMLButtonElement>('[data-mobile-retry-load]');
    expect(retryButton).not.toBeNull();

    await act(async () => {
      retryButton?.click();
    });
    await flushMicrotasks();

    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-mobile-load-error]')).toBeNull();
  });

  it('hides retry when the session was deleted', async () => {
    const getSnapshot = vi.fn(async (): Promise<SessionSnapshotResponse> => {
      throw new ApiError({
        code: API_CODES.SESSION_NOT_FOUND,
        msg: 'session session_test does not exist',
        data: null,
      });
    });
    const container = await mountMobileChat(createStubClient({ getSnapshot }));

    const alert = container.querySelector('[data-mobile-load-error]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('session session_test does not exist');
    expect(container.querySelector('[data-mobile-retry-load]')).toBeNull();
  });
});

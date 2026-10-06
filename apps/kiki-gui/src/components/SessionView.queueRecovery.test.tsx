// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ConversationShell } from './ConversationShell';
import { SessionRouteView } from './SessionView';
import { SubmissionRecovery } from './SubmissionRecovery';
import { preserveSubmission, readUnconfirmedSubmissions, readDraft, resetDraftMemoryForTests, readComposerState } from '@kiki/session-core/composer';
import { createViewState } from '@kiki/session-core/session';

const fixture = vi.hoisted(() => ({ autoCompact: true, queued: true }));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}), getConfig: async () => ({}),
    listNamedAgentProfiles: async () => ({ items: [] }),
    getSessionGoal: async () => null,
    getAgentCapabilities: async () => ({ context: 'live', available: false, targets: [] }),
    listModels: async () => ({ items: [] }),
    getAutoCompact: async () => {
      if (!fixture.autoCompact) throw new Error('unavailable');
      return { tokens: 80000, source: 'global', effectiveMaxContextTokens: 100000, reservedContextTokens: 20000 };
    },
    getContextStrategy: async () => ({ strategy: 'summarize', source: 'global' }),
    listAgentModelSwitches: async () => [],
    subscribeAgentModelSwitches: () => ({ ready: Promise.resolve(), dispose: () => {} }),
    klient: { session: () => ({ agent: () => ({ events: { on: () => ({ ready: Promise.resolve(), dispose: () => {} }) } }) }) },
  };
  const registry = { acquire: (_id: string, _scope: object, create: () => { open(): Promise<void>; close(): void }) => {
    const controller = create(); return { controller, ready: controller.open(), release: () => controller.close() };
  } };
  return { useConnection: () => ({ client, meta: { capabilities: {} }, wsStatus: 'closed' }),
    useOptionalConnection: () => null, useControllerRegistry: () => registry };
});
vi.mock('@kiki/session-core/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/session-core/session')>();
  class Controller {
    readonly subscribe = () => () => {};
    readonly subscribeInterruptedPrompt = () => () => {};
    readonly subscribeAgent = () => () => {};
    readonly state = {
      ...actual.createViewState('session-example'), loaded: true, transcriptReady: true,
      session: { id: 'session-example', title: 'Queue recovery example', workspace_id: 'workspace-example', metadata: { cwd: '/example' }, agent_config: { profile: 'agent' }, profile: 'agent', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      blocks: fixture.queued ? [{ kind: 'user' as const, id: 'queued-example', promptId: 'queued-example', promptStatus: 'queued' as const, text: 'retain this queued message', createdAt: '2026-01-01T00:00:00Z' }] : [],
      queuedPromptIds: fixture.queued ? ['queued-example'] : [],
    };
    getState = () => this.state;
    getAgentState = () => this.state;
    setFocusedAgent() {}
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return actual.buildAgentForest([], []); }
    retainHistoryRead() { return () => {}; }
  }
  return { ...actual, SessionController: Controller };
});
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./Transcript', async (original) => ({ ...(await original<typeof import('./Transcript')>()), Transcript: () => <div data-transcript /> }));
vi.mock('./SelectionQuoteButton', () => ({ SelectionQuoteButton: () => null }));
vi.mock('./mediaPreview', () => ({ PreviewToggleButton: () => null, useMediaPreview: () => undefined, MediaPreviewProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./RightRail', () => ({ RightRail: () => null }));
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetDraftMemoryForTests();
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div'); document.body.append(container);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; container.remove(); vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it('keeps a queued composer seat mounted when real auto-compaction status is available', async () => {
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
        <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
      </Routes></MemoryRouter></I18nProvider>
    </QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.querySelector('textarea[data-composer]')).not.toBeNull();
  expect(container.querySelector('[data-queue-count]')?.textContent).toContain('1');
});

it('keeps unknown sends recoverable through an empty snapshot, restores only by user action, and retires authoritative ack', async () => {
  preserveSubmission({ sessionId: 'session-example', agentId: 'main', promptId: 'one', createdAt: '2026-01-01T00:00:00Z',
    content: [{ type: 'text', text: 'saved with an image' }, { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } }] });
  root = createRoot(container);
  const state = createViewState('session-example');
  await act(async () => root!.render(<I18nProvider><SubmissionRecovery sessionId="session-example" state={state} /></I18nProvider>));
  expect(container.textContent).toContain('no send confirmation');
  expect(readDraft('session-example')).toBe('');
  expect(readUnconfirmedSubmissions('session-example')).toHaveLength(1);
  const restore = [...container.querySelectorAll('button')].find(button => button.textContent === 'Restore to composer');
  await act(async () => restore!.click());
  expect(readDraft('session-example')).toBe('saved with an image');
  expect(readComposerState('session-example').attachments).toHaveLength(1);
  expect(readUnconfirmedSubmissions('session-example')).toHaveLength(1);
  await act(async () => root!.render(<I18nProvider><SubmissionRecovery sessionId="session-example" state={{ ...state, queuedPromptIds: ['one'] }} /></I18nProvider>));
  expect(container.querySelector('[data-submission-recovery]')).toBeNull();
  expect(readUnconfirmedSubmissions('session-example')).toEqual([]);
});

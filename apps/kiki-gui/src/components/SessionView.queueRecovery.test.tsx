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
import { emptySessionUsage } from '@kiki/protocol';

const fixture = vi.hoisted(() => ({ controller: undefined as object | undefined, autoCompact: true, queued: true, partialPrompts: false, structureUnread: false, loadEntities: vi.fn(async () => true), loadContent: vi.fn(async () => true) }));
/** A snapshot field the header shows, cut in the window — the composer's remainder. */
const STRUCTURE_REF = { source: { kind: 'snapshot' as const, id: '' }, revision: 'rev-1', path: ['session', 'title'], kind: 'text' as const, offset: 12, total: 40 };
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
      contentRefs: fixture.structureUnread ? [STRUCTURE_REF] : undefined,
      globalCoverage: fixture.partialPrompts ? { version: 1 as const,
        tasks: { returned: 0, total: 0, hasMore: false }, attachments: { returned: 0, total: 0, hasMore: false },
        prompts: { returned: 8, total: 12, hasMore: true },
      } : undefined,
    };
    loadTranscriptEntities = fixture.loadEntities;
    loadContentSegment = fixture.loadContent;
    getState = () => this.state;
    getAgentState = () => this.state;
    setFocusedAgent() {}
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return actual.buildAgentForest([], []); }
    retainHistoryRead() { return () => {}; }
  }
  return { ...actual, SessionController: function SessionControllerFixture() { return fixture.controller ?? new Controller(); } };
});
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./Transcript', async (original) => ({ ...(await original<typeof import('./Transcript')>()), Transcript: () => <div data-transcript /> }));
vi.mock('./SelectionQuoteButton', () => ({ SelectionQuoteButton: () => null }));
vi.mock('./mediaPreview', () => ({ PreviewToggleButton: () => null, useMediaPreview: () => undefined, MediaPreviewProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./RightRail', () => ({ RightRail: () => null }));
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.controller = undefined;
  fixture.queued = true;
  fixture.partialPrompts = false;
  fixture.structureUnread = false;
  fixture.loadEntities.mockClear();
  fixture.loadContent.mockClear();
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


it('keeps partial prompt records reachable with no loaded queued row and requests exactly one main-agent page', async () => {
  fixture.queued = false;
  fixture.partialPrompts = true;
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
        <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
      </Routes></MemoryRouter></I18nProvider>
    </QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const disclosure = container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]');
  expect(disclosure?.textContent).toContain('More message records');
  expect(container.querySelector('[data-queue-count]')).toBeNull();
  expect(fixture.loadEntities).not.toHaveBeenCalled();
  await act(async () => disclosure!.click());
  const action = container.querySelector<HTMLButtonElement>('[data-content-continuation-action]');
  expect(container.textContent).toContain('8 / 12 message records loaded');
  await act(async () => action!.click());
  expect(fixture.loadEntities).toHaveBeenCalledExactlyOnceWith('main', 'prompt');
  expect(container.querySelector('textarea[data-composer]')).not.toBeNull();
});

it('reads session structure a window did not carry without waiting for a press', async () => {
  fixture.queued = false;
  fixture.structureUnread = true;
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
        <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
      </Routes></MemoryRouter></I18nProvider>
    </QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // The outlet is for a read in flight or one that failed, never for a ref that
  // is merely waiting: this one was read on its own, so nothing hangs as
  // "session content not loaded".
  expect(fixture.loadContent).toHaveBeenCalledExactlyOnceWith('main', STRUCTURE_REF);
});

it('parks a remainder read that advanced nothing instead of retrying it', async () => {
  fixture.queued = false;
  fixture.structureUnread = true;
  fixture.loadContent.mockResolvedValue(false);
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
        <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
      </Routes></MemoryRouter></I18nProvider>
    </QueryClientProvider>));
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  // A ref that cannot advance is skipped rather than read again on every render,
  // so a stuck structure cannot spin the drain.
  expect(fixture.loadContent).toHaveBeenCalledExactlyOnceWith('main', STRUCTURE_REF);
});


it('renders the canonical queue again after a fresh controller mount without resubmitting messages', async () => {
  const actual = await vi.importActual<typeof import('@kiki/session-core/session')>('@kiki/session-core/session');
  const submit = vi.fn();
  let receive: Parameters<import('@kiki/klient/session-view').SessionViewFacade['subscribe']>[1] | undefined;
  const createController = () => {
    const view: import('@kiki/klient/session-view').SessionViewFacade = {
      snapshot: vi.fn(async () => ({
        as_of_seq: 10, epoch: 'session-epoch',
        session: { id: 'session-example', title: 'Queue recovery example', workspace_id: 'workspace-example',
          metadata: { cwd: '/example' }, agent_config: { model: 'example/model', profile: 'agent' },
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          busy: false, usage: emptySessionUsage(), permission_rules: [], message_count: 0, last_seq: 10 },
        messages: { items: [], has_more: false }, in_flight_turn: null, pending_approvals: [], pending_questions: [],
      } satisfies import('@kiki/protocol').SessionSnapshotResponse)),
      transcript: { page: vi.fn(), catchUp: vi.fn() },
      subscribe: (_input, listener) => {
        receive = listener;
        return { updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} };
      },
    };
    return new actual.SessionController({ submitPrompt: submit } as unknown as import('@kiki/session-core/transport').SessionTransport,
      view, 'session-example');
  };
  const render = async () => {
    root = createRoot(container);
    await act(async () => root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
          <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
        </Routes></MemoryRouter></I18nProvider>
      </QueryClientProvider>));
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  };
  const baseline = async () => {
    await act(async () => {
      receive!({ type: 'transcript', generation: 1, event: {
        type: 'transcript.reset', session_id: 'session-example', agent_id: 'main', grade: 'delta',
        cursor: { seq: 1, epoch: 'transcript-epoch' }, coverage: { kind: 'full', hasMoreOlder: false },
        snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], meta: {}, prompts: [
          { promptId: 'saved-one', userMessageId: 'saved-one', status: 'queued', queuePosition: 1,
            content: [{ type: 'text', text: 'First saved message' }], createdAt: '2026-01-01T00:00:00Z' },
          { promptId: 'saved-two', userMessageId: 'saved-two', status: 'queued', queuePosition: 0,
            content: [{ type: 'text', text: 'Second saved message' }], createdAt: '2026-01-01T00:00:01Z' },
        ] },
      } });
      await new Promise(resolve => setTimeout(resolve, 40));
    });
  };
  for (let mount = 0; mount < 2; mount++) {
    fixture.controller = createController();
    await render();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(false);
    await baseline();
    expect(container.querySelector('[data-queue-count]')?.textContent).toContain('2');
    const toggle = container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]');
    if (container.querySelector('[data-queue-item]') === null) await act(async () => toggle!.click());
    expect([...container.querySelectorAll('[data-queue-item]')].map(row => row.getAttribute('data-queue-item'))).toEqual(['saved-two', 'saved-one']);
    expect(container.textContent).toContain('First saved message');
    expect(container.textContent).toContain('Second saved message');
    expect(submit).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = undefined;
  }
});

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
import { preserveSubmission, readUnconfirmedSubmissions, readDraft, resetDraftMemoryForTests, readComposerState, writeComposerState, createQuote, selectionCarryoverPresentation } from '@kiki/session-core/composer';
import { createViewState } from '@kiki/session-core/session';
import { emptySessionUsage } from '@kiki/protocol';

const fixture = vi.hoisted(() => ({ controller: undefined as object | undefined, autoCompact: true, dependencies: undefined as Promise<void> | undefined, queued: true, partialPrompts: false, structureUnread: false, loadEntities: vi.fn(async () => true), loadContent: vi.fn(async () => true), readMedia: vi.fn(), pushToast: vi.fn() }));
vi.mock('../lib/toasts', () => ({ pushToast: fixture.pushToast }));
/** A snapshot field the header shows, cut in the window — the composer's remainder. */
const STRUCTURE_REF = { source: { kind: 'snapshot' as const, id: '' }, revision: 'rev-1', path: ['session', 'title'], kind: 'text' as const, offset: 12, total: 40 };
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}), getConfig: async () => ({}),
    listNamedAgentProfiles: async () => { await fixture.dependencies; return { items: [{ name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] }] }; },
    getSessionGoal: async () => null,
    getAgentCapabilities: async () => ({ context: 'live', available: false, targets: [] }),
    listModels: async () => { await fixture.dependencies; return { items: [{ id: 'example/model', provider_id: 'example', remote_id: 'model', support_efforts: ['high'], default_effort: 'high' }] }; },
    getAutoCompact: async () => {
      await fixture.dependencies;
      if (!fixture.autoCompact) throw new Error('unavailable');
      return { tokens: 80000, source: 'global', effectiveMaxContextTokens: 100000, reservedContextTokens: 20000 };
    },
    getContextStrategy: async () => ({ strategy: 'summarize', source: 'global' }),
    readSessionMediaBytes: fixture.readMedia,
    readingOptions: () => ({ timeoutMs: 5000 }),
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
vi.mock('./Transcript', async (original) => ({ ...(await original<typeof import('./Transcript')>()), Transcript: ({ state }: { state: import('@kiki/session-core/session').SessionViewState }) => <div data-transcript>{state.blocks.filter(block => block.kind === 'user' && block.promptStatus !== 'queued').map(block => <div key={block.id} data-user-message={block.id}>{block.kind === 'user' ? block.text : ''}</div>)}</div> }));
vi.mock('./SelectionQuoteButton', () => ({ SelectionQuoteButton: ({ onQuote, onAnnotate }: { onQuote: (quote: string) => void; onAnnotate: (quote: string, comment: string) => void }) => <><button data-fixture-quote onClick={() => onQuote('new passage')}>Quote new passage</button><button data-fixture-annotation onClick={() => onAnnotate('new annotated passage', 'keep this note')}>Annotate new passage</button></> }));
vi.mock('./mediaPreview', () => ({ PreviewToggleButton: () => null, useMediaPreview: () => undefined, MediaPreviewProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./RightRail', () => ({ RightRail: () => null }));
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.controller = undefined;
  fixture.dependencies = undefined;
  fixture.queued = true;
  fixture.partialPrompts = false;
  fixture.structureUnread = false;
  fixture.loadEntities.mockClear();
  fixture.loadContent.mockClear();
  fixture.readMedia.mockReset();
  fixture.pushToast.mockClear();
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
  const disclosure = container.querySelector<HTMLButtonElement>('[data-composer-status-line] [data-prompt-records-remainder] button');
  expect(disclosure?.textContent).toContain('More message records');
  expect(container.querySelector('[data-header-toggle="queue"]')).toBeNull();
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


it('updates an appended queue from the transcript event before REST finishes, without repeating the pending message in the timeline', async () => {
  const actual = await vi.importActual<typeof import('@kiki/session-core/session')>('@kiki/session-core/session');
  let acknowledge!: (result: import('@kiki/protocol').PromptSubmitResult) => void;
  const submit = vi.fn((_sessionId: string, _input: import('@kiki/protocol').PromptSubmission) => new Promise<import('@kiki/protocol').PromptSubmitResult>(resolve => { acknowledge = resolve; }));
  let receive!: Parameters<import('@kiki/klient/session-view').SessionViewFacade['subscribe']>[1];
  const view: import('@kiki/klient/session-view').SessionViewFacade = {
    snapshot: vi.fn(async () => ({ as_of_seq: 10, epoch: 'session-epoch',
      session: { id: 'session-example', title: 'Temporary append example', workspace_id: 'workspace-example',
        metadata: { cwd: '/example', ephemeral: true }, agent_config: { model: 'example/model', profile: 'agent' },
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        busy: true, usage: emptySessionUsage(), permission_rules: [], message_count: 0, last_seq: 10 },
      messages: { items: [], has_more: false }, in_flight_turn: null, pending_approvals: [], pending_questions: [],
    } satisfies import('@kiki/protocol').SessionSnapshotResponse)),
    transcript: { page: vi.fn(), catchUp: vi.fn() },
    subscribe: (_input, listener) => {
      receive = listener;
      return { updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} };
    },
  };
  fixture.controller = new actual.SessionController({ submitPrompt: submit } as unknown as import('@kiki/session-core/transport').SessionTransport, view, 'session-example');
  root = createRoot(container);
  await act(async () => root!.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes>
        <Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route>
      </Routes></MemoryRouter></I18nProvider>
    </QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => {
    receive({ type: 'transcript', generation: 1, event: {
      type: 'transcript.reset', session_id: 'session-example', agent_id: 'main', grade: 'delta',
      cursor: { seq: 1, epoch: 'transcript-epoch' }, coverage: { kind: 'full', hasMoreOlder: false },
      snapshot: { items: [{ kind: 'turn', turnId: 'active-turn', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: 'Earlier message', steps: [] }],
        tasks: [], interactions: [], attachments: [], todos: [], meta: {}, prompts: [] },
    } });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Append this ordinary message');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(readDraft('session-example')).toBe('Append this ordinary message');
  expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(false);
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Queue prompt"], button[aria-label="Send message"]');
  expect(send).not.toBeNull();
  expect(send?.disabled, send?.title).toBe(false);
  await act(async () => { send!.click(); });
  expect(submit).toHaveBeenCalledTimes(1);
  const submission = submit.mock.calls[0]![1] as import('@kiki/protocol').PromptSubmission;
  expect(submission.model).toBeUndefined();
  expect(submission.thinking).toBeUndefined();
  expect(container.querySelector('[data-transcript]')?.textContent).toContain('Append this ordinary message');
  const prompt = { promptId: submission.prompt_id!, userMessageId: 'message-appended', status: 'queued' as const,
    content: submission.content, createdAt: '2026-01-01T00:00:02Z', queuePosition: 0 };
  await act(async () => {
    receive({ type: 'transcript', generation: 1, event: {
      type: 'transcript.reset', session_id: 'session-example', agent_id: 'main', grade: 'delta',
      cursor: { seq: 2, epoch: 'transcript-epoch' }, coverage: { kind: 'full', hasMoreOlder: false },
      snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], meta: {}, prompts: [prompt] },
    } });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  expect(container.querySelector('[data-queue-count]')?.textContent).toContain('1');
  const toggle = container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]')!;
  await act(async () => { toggle.click(); });
  expect(container.querySelector('[data-queue-item]')?.textContent).toContain('Append this ordinary message');
  expect(container.querySelector('[data-queue-runtime-controls]')).toBeNull();
  expect(container.querySelector('[data-transcript]')?.textContent).not.toContain('Append this ordinary message');
  await act(async () => { acknowledge({ prompt_id: prompt.promptId, user_message_id: prompt.userMessageId,
    status: 'queued', content: prompt.content, created_at: prompt.createdAt, append_timing: 'agent_idle' }); });
  expect(container.querySelectorAll('[data-queue-item]')).toHaveLength(1);
  expect(container.querySelector('[data-transcript]')?.textContent).not.toContain('Append this ordinary message');
});


it.each([false, true])('accepts a send before delayed presentation dependencies settle (baseline=%s)', async (hasBaseline) => {
  const actual = await vi.importActual<typeof import('@kiki/session-core/session')>('@kiki/session-core/session');
  let releaseDependencies!: () => void;
  fixture.dependencies = new Promise<void>(resolve => { releaseDependencies = resolve; });
  let acknowledge!: (result: import('@kiki/protocol').PromptSubmitResult) => void;
  const submit = vi.fn((_sessionId: string, _input: import('@kiki/protocol').PromptSubmission) => new Promise<import('@kiki/protocol').PromptSubmitResult>(resolve => { acknowledge = resolve; }));
  let receive!: Parameters<import('@kiki/klient/session-view').SessionViewFacade['subscribe']>[1];
  let releaseHistory!: (page: Awaited<ReturnType<import('@kiki/klient/session-view').SessionViewFacade['transcript']['page']>>) => void;
  const page = vi.fn(() => new Promise<Awaited<ReturnType<import('@kiki/klient/session-view').SessionViewFacade['transcript']['page']>>>(resolve => { releaseHistory = resolve; }));
  const view: import('@kiki/klient/session-view').SessionViewFacade = {
    snapshot: vi.fn(async () => ({ as_of_seq: 10, epoch: 'session-epoch',
      session: { id: 'session-example', title: 'Early send example', workspace_id: 'workspace-example', metadata: { cwd: '/example' },
        agent_config: { model: 'example/model', profile: 'agent' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        busy: false, usage: emptySessionUsage(), permission_rules: [], message_count: 0, last_seq: 10 },
      messages: { items: [], has_more: false }, in_flight_turn: null, pending_approvals: [], pending_questions: [],
    } satisfies import('@kiki/protocol').SessionSnapshotResponse)),
    transcript: { page, catchUp: vi.fn() },
    subscribe: (_input, listener) => { receive = listener; return { updateSessionCursor() {}, setTranscriptGrades() {}, updateTranscriptCursor() {}, restart() {}, nudge() {}, close() {} }; },
  };
  const controller = new actual.SessionController({ submitPrompt: submit } as unknown as import('@kiki/session-core/transport').SessionTransport, view, 'session-example');
  fixture.controller = controller;
  const turn = (ordinal: number, text: string) => ({ kind: 'turn' as const, turnId: `t${ordinal}`, ordinal, state: 'completed' as const, origin: { kind: 'user' as const }, prompt: text, steps: [] });
  const baseline = async () => act(async () => {
    receive({ type: 'transcript', generation: 1, event: { type: 'transcript.reset', session_id: 'session-example', agent_id: 'main', grade: 'delta',
      cursor: { seq: 1, epoch: 'transcript-epoch' }, coverage: { kind: 'unknown', hasMoreOlder: true }, read: { source: 'cold', readiness: 'partial', reason: 'source_unverified' },
      snapshot: { items: [turn(2, 'Latest retained message')], hasMoreOlder: true, tasks: [], interactions: [], attachments: [], todos: [], meta: {}, prompts: [] } } });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes><Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route></Routes></MemoryRouter></I18nProvider>
  </QueryClientProvider>));
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  let loading: Promise<boolean> | undefined;
  if (hasBaseline) { await baseline(); await act(async () => { loading = controller.loadOlderMessages(); }); }
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(input.disabled).toBe(false);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Send without waiting for history');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  expect(send?.disabled, send?.title).toBe(false);
  await act(async () => { send.click(); });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-transcript]')?.textContent).toContain('Send without waiting for history');
  if (!hasBaseline) await baseline();
  const submission = submit.mock.calls[0]![1];
  await act(async () => {
    receive({ type: 'transcript', generation: 1, event: { type: 'transcript.ops', session_id: 'session-example', agent_id: 'main', cursor: { seq: 2, epoch: 'transcript-epoch' }, through_seq: 2,
      ops: [{ op: 'turn.upsert', turn: { ...turn(3, 'Send without waiting for history'), promptId: submission.prompt_id, message: { messageId: submission.prompt_id!, role: 'user', revision: 0, provenance: { source: 'engine' } }, state: 'running' } }] } });
    acknowledge({ prompt_id: submission.prompt_id!, user_message_id: submission.prompt_id!, status: 'running', content: submission.content, created_at: '2026-01-01T00:00:02Z' });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  expect([...container.querySelectorAll('[data-user-message]')].filter(row => row.textContent === 'Send without waiting for history')).toHaveLength(1);
  await act(async () => {
    if (hasBaseline) { releaseHistory({ session_id: 'session-example', agent_id: 'main', items: [turn(1, 'Older message')], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], pending_interactions: [], has_more: false, coverage: { kind: 'unknown', hasMoreOlder: true }, read: { source: 'cold', readiness: 'partial' } }); await loading; }
    releaseDependencies();
    await new Promise(resolve => setTimeout(resolve, 40));
  });
  expect([...container.querySelectorAll('[data-user-message]')].map(row => row.textContent)).toEqual(hasBaseline
    ? ['Older message', 'Latest retained message', 'Send without waiting for history']
    : ['Latest retained message', 'Send without waiting for history']);
});


it.each(['session_media', 'blobref'] as const)('restores serialized queued %s originals for preview, cancel and replacement', async source => {
  const hash = 'a'.repeat(64);
  const fileId = source === 'blobref' ? `blobref:main:${hash}` : 'saved-image';
  const content: import('@kiki/protocol').MessageContent[] = JSON.parse(JSON.stringify([
    { type: 'text', text: 'saved with image' },
    { type: 'image', name: 'saved.png', source: source === 'blobref' ? { kind: 'url', url: `blobref:image/png;${hash}` } : { kind: 'session_media', file_id: fileId } },
    { type: 'image', name: 'inline.png', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]));
  const holdQueued = vi.fn(async () => {});
  const replaceQueued = vi.fn(async () => {});
  const controller = {
    state: { ...createViewState('session-example'), loaded: true, transcriptReady: true,
      session: { id: 'session-example', title: 'Queue edit', workspace_id: 'workspace-example', metadata: { cwd: '/example' }, agent_config: { model: 'example/model', profile: 'agent' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      blocks: [{ kind: 'user', id: 'queued-example', promptId: 'queued-example', promptStatus: 'queued', text: 'saved with image', queuedContent: content, media: [{ kind: 'image', fileId, name: 'saved.png' }], createdAt: '2026-01-01T00:00:00Z' }], queuedPromptIds: ['queued-example'] },
    subscribe: () => () => {}, subscribeInterruptedPrompt: () => () => {}, subscribeAgent: () => () => {},
    getState: () => controller.state, getAgentState: () => controller.state, getForest: () => ({ roots: [], byId: {} }),
    open: async () => {}, close() {}, setFocusedAgent() {}, refreshSession: async () => {}, retainHistoryRead: () => () => {},
    contentRefsFor: () => [], holdQueued, replaceQueued,
  };
  fixture.controller = controller;
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
  fixture.readMedia.mockResolvedValue({ bytes: png, mime: 'image/png', name: 'saved.png' });
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes><Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route></Routes></MemoryRouter></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]')!.click());
  const edit = () => container.querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt"]')!;
  await act(async () => edit().click());
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(fixture.readMedia).toHaveBeenCalledWith('session-example', fileId, { timeoutMs: 5000 });
  expect(container.querySelector('[data-context-tray] img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel editing"]')!.click());
  expect(replaceQueued).not.toHaveBeenCalled();
  expect(controller.state.blocks[0]?.queuedContent).toEqual(content);
  await act(async () => edit().click());
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Confirm edit"]')!.click());
  expect(replaceQueued).toHaveBeenCalledWith('queued-example', 'saved with image', content.slice(1), undefined);
  fixture.readMedia.mockRejectedValue(new Error('Original unavailable'));
  await act(async () => edit().click());
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', text: expect.stringContaining('Original unavailable') }));
  expect(container.querySelector('[aria-label="Confirm edit"]')).toBeNull();
  expect(controller.state.blocks[0]?.queuedContent).toEqual(content);
  expect(holdQueued).toHaveBeenCalledWith('queued-example', false);
});


it.each([
  ['ordinary', false, false], ['ordinary', true, false], ['now', false, false], ['now', true, false],
  ['ordinary', false, true], ['ordinary', true, true], ['now', false, true], ['now', true, true],
] as const)('snapshots multiple quotes for %s send and preserves new quotes after rejection=%s, detached=%s', async (mode, rejected, detached) => {
  const first = createQuote('first passage');
  const second = createQuote('second passage');
  writeComposerState('session-example', { attachments: [], annotations: [], quotes: [first, second], permissionMode: undefined, planMode: undefined, planGate: undefined, goalObjective: undefined, modelOverride: undefined, effortOverride: undefined });
  let accept!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  let callbacks!: { onPreservation: (persisted: boolean) => void; onAcknowledged: () => void; content: import('@kiki/protocol').MessageContent[] };
  const send = vi.fn((input: typeof callbacks) => { callbacks = input; return new Promise((resolve, fail) => { accept = resolve; reject = fail; }); });
  const controller = {
    state: { ...createViewState('session-example'), loaded: true, transcriptReady: true, busy: mode === 'now',
      session: { id: 'session-example', title: 'Selection send', workspace_id: 'workspace-example', metadata: { cwd: '/example' }, agent_config: { model: 'example/model', profile: 'agent' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } },
    subscribe: () => () => {}, subscribeInterruptedPrompt: () => () => {}, subscribeAgent: () => () => {},
    getState: () => controller.state, getAgentState: () => controller.state, getForest: () => ({ roots: [], byId: {} }),
    open: async () => {}, close() {}, setFocusedAgent() {}, refreshSession: async () => {}, retainHistoryRead: () => () => {},
    sendPrompt: send, sendPromptNow: send,
  };
  fixture.controller = controller;
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes><Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route></Routes></MemoryRouter></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.querySelectorAll('[data-quote-chip]')).toHaveLength(2);
  const input = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: mode === 'now', bubbles: true })));
  expect(send).toHaveBeenCalledTimes(1);
  const text = callbacks.content.find(part => part.type === 'text')!;
  expect(text).toMatchObject({ type: 'text', text: expect.stringContaining('first passage') });
  expect(text).toMatchObject({ type: 'text', text: expect.stringContaining('second passage'), presentation: { spans: [expect.objectContaining({ quote: 'first passage' }), expect.objectContaining({ quote: 'second passage' })] } });
  await act(async () => callbacks.onPreservation(true));
  expect(container.querySelectorAll('[data-quote-chip]')).toHaveLength(0);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-fixture-quote]')!.click());
  const newer = readComposerState('session-example').quotes![0]!;
  if (detached) { await act(async () => root!.unmount()); root = undefined; }
  await act(async () => {
    if (rejected) reject(new Error('Submit refused'));
    else { callbacks.onAcknowledged(); accept(mode === 'now' ? { outcome: 'delivered' } : { status: 'queued', prompt_id: 'submitted-example' }); }
  });
  const retained = readComposerState('session-example').quotes!;
  expect(retained.map(item => item.id)).toEqual(rejected ? [first.id, second.id, newer.id] : [newer.id]);
  expect(new Set(retained.map(item => item.id)).size).toBe(retained.length);
});

it('migrates a legacy draft quote and restores all serialized queued quotes through cancel and replacement', async () => {
  writeComposerState('session-example', { attachments: [], annotations: [], quote: 'legacy passage', permissionMode: undefined, planMode: undefined, planGate: undefined, goalObjective: undefined, modelOverride: undefined, effortOverride: undefined });
  const carry = selectionCarryoverPresentation([], [createQuote('queued first'), createQuote('queued second')]);
  const content = JSON.parse(JSON.stringify([{ type: 'text', text: `${carry.prefix}queued body`, presentation: carry.presentation }]));
  const replaceQueued = vi.fn(async () => {});
  const controller = {
    state: { ...createViewState('session-example'), loaded: true, transcriptReady: true,
      session: { id: 'session-example', title: 'Selection queue', workspace_id: 'workspace-example', metadata: { cwd: '/example' }, agent_config: { model: 'example/model', profile: 'agent' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      blocks: [{ kind: 'user', id: 'queued-example', promptId: 'queued-example', promptStatus: 'queued', text: content[0].text, presentation: carry.presentation, queuedContent: content, createdAt: '2026-01-01T00:00:00Z' }], queuedPromptIds: ['queued-example'] },
    subscribe: () => () => {}, subscribeInterruptedPrompt: () => () => {}, subscribeAgent: () => () => {},
    getState: () => controller.state, getAgentState: () => controller.state, getForest: () => ({ roots: [], byId: {} }),
    open: async () => {}, close() {}, setFocusedAgent() {}, refreshSession: async () => {}, retainHistoryRead: () => () => {},
    contentRefsFor: () => [], holdQueued: vi.fn(async () => {}), replaceQueued,
  };
  fixture.controller = controller;
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes><Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route></Routes></MemoryRouter></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(readComposerState('session-example').quotes?.map(item => item.quote)).toEqual(['legacy passage']);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]')!.click());
  const edit = async () => { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt"]')!.click()); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
  await edit();
  expect([...container.querySelectorAll('[data-quote-chip]')].map(item => item.getAttribute('title'))).toEqual(['queued first', 'queued second']);
  expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.value).toBe('queued body');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel editing"]')!.click());
  expect(container.querySelector('[data-quote-chip]')?.getAttribute('title')).toBe('legacy passage');
  expect(replaceQueued).not.toHaveBeenCalled();
  await edit();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Confirm edit"]')!.click());
  expect(replaceQueued).toHaveBeenCalledWith('queued-example', content[0].text, [], carry.presentation);
  expect(container.querySelector('[data-quote-chip]')?.getAttribute('title')).toBe('legacy passage');
});


it('parks quotes and annotations added while a queued image original loads and restores them on cancel', async () => {
  writeComposerState('session-example', { attachments: [], annotations: [], quotes: [], permissionMode: undefined, planMode: undefined, planGate: undefined, goalObjective: undefined, modelOverride: undefined, effortOverride: undefined });
  const content: import('@kiki/protocol').MessageContent[] = [
    { type: 'text', text: 'queued image body' },
    { type: 'image', name: 'saved.png', source: { kind: 'session_media', file_id: 'saved-image' } },
  ];
  const holdQueued = vi.fn(async () => {});
  const replaceQueued = vi.fn(async () => {});
  const controller = {
    state: { ...createViewState('session-example'), loaded: true, transcriptReady: true,
      session: { id: 'session-example', title: 'Loading queue image', workspace_id: 'workspace-example', metadata: { cwd: '/example' }, agent_config: { model: 'example/model', profile: 'agent' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      blocks: [{ kind: 'user', id: 'queued-example', promptId: 'queued-example', promptStatus: 'queued', text: 'queued image body', queuedContent: content, media: [{ kind: 'image', fileId: 'saved-image', name: 'saved.png' }], createdAt: '2026-01-01T00:00:00Z' }], queuedPromptIds: ['queued-example'] },
    subscribe: () => () => {}, subscribeInterruptedPrompt: () => () => {}, subscribeAgent: () => () => {},
    getState: () => controller.state, getAgentState: () => controller.state, getForest: () => ({ roots: [], byId: {} }),
    open: async () => {}, close() {}, setFocusedAgent() {}, refreshSession: async () => {}, retainHistoryRead: () => () => {},
    contentRefsFor: () => [], holdQueued, replaceQueued,
  };
  fixture.controller = controller;
  let resolveOriginal!: (result: { bytes: Uint8Array; mime: string; name: string }) => void;
  fixture.readMedia.mockReturnValue(new Promise(resolve => { resolveOriginal = resolve; }));
  root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><MemoryRouter initialEntries={['/s/session-example']}><Routes><Route element={<ConversationShell />}><Route path="/s/:id" element={<SessionRouteView sessionId="session-example" sessions={[]} onToggleSidebar={() => {}} />} /></Route></Routes></MemoryRouter></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-header-toggle="queue"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit queued prompt"]')!.click());
  expect(fixture.readMedia).toHaveBeenCalledWith('session-example', 'saved-image', { timeoutMs: 5000 });
  expect(container.querySelector('[aria-label="Cancel editing"]')).toBeNull();
  expect(holdQueued).toHaveBeenCalledWith('queued-example', true);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-fixture-quote]')!.click();
    container.querySelector<HTMLButtonElement>('[data-fixture-annotation]')!.click();
  });
  const added = readComposerState('session-example');
  expect(added.quotes?.map(item => item.quote)).toEqual(['new passage']);
  expect(added.annotations?.map(item => item.comment)).toEqual(['keep this note']);
  expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('');
  await act(async () => {
    resolveOriginal({ bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), char => char.charCodeAt(0)), mime: 'image/png', name: 'saved.png' });
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  expect(container.querySelector('[data-context-tray] img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!.value).toBe('queued image body');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Cancel editing"]')!.click());
  expect(readComposerState('session-example').quotes).toEqual(added.quotes);
  expect(readComposerState('session-example').annotations).toEqual(added.annotations);
  expect(container.querySelector('[data-quote-chip]')?.getAttribute('title')).toBe('new passage');
  expect(replaceQueued).not.toHaveBeenCalled();
  expect(controller.state.blocks[0]!.queuedContent).toEqual(content);
  expect(holdQueued).toHaveBeenCalledWith('queued-example', false);
});

// @vitest-environment jsdom

import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { clearComposerState, clearStoredDrafts, readComposerState, resetComposerMemoryForTests, resetDraftMemoryForTests, type SelectionAnnotation } from '@kiki/session-core/composer';
import { SendNowError } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { SessionRouteView } from './SessionView';

const { seat, submit, queueStub, fixture } = vi.hoisted(() => ({
  fixture: { external: false },
  seat: { composer: null as unknown },
  submit: {
    // Each send hands the test a deferred result so it can inspect the
    // composer mid-flight, then settle it (accepted / queued / rejected).
    calls: [] as { text: string; input?: { model?: string; thinking?: string; permissionMode?: string; appendTiming?: 'agent_idle' | 'subagents_done' | 'tasks_done' }; now?: true; resolve: (value: unknown) => void; reject: (error: unknown) => void }[],
    steered: [] as string[],
  },
  queueStub: {
    // Queued prompts the stub controller reports; set before rendering.
    items: [] as { promptId: string; text: string }[],
    replaced: [] as { promptId: string; text: string }[],
  },
}));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({ default_model: 'provider/native-model' }),
    listModels: () => Promise.resolve({ items: [] }),
  };
  const registry = {
    add: () => {},
    delete: () => {},
    acquire: (_sessionId: string, _scope: object, create: () => { open: () => Promise<void>; close: () => void }) => {
      const controller = create();
      return { controller, ready: controller.open(), release: () => { controller.close(); } };
    },
  };
  return {
    useConnection: () => ({ client, meta: { capabilities: {} }, socket: null, wsStatus: 'closed' }),
    useControllerRegistry: () => registry,
  };
});
vi.mock('@kiki/session-core/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/session-core/session')>();
  class StubSessionController {
    readonly sessionId: string;
    readonly subscribe = () => () => {};
    readonly subscribeInterruptedPrompt = () => () => {};
    readonly getState: () => ReturnType<typeof actual.createViewState>;

    constructor(_sessions: unknown, _view: unknown, sessionId: string) {
      this.sessionId = sessionId;
      const base = actual.createViewState(sessionId);
      const state = fixture.external
        ? { ...base, session: { id: sessionId, executor_id: 'claude-acp', metadata: {}, agent_config: {} } as NonNullable<typeof base.session> }
        : base;
      // The queued view is cached by items identity: useSyncExternalStore
      // re-reads the snapshot every render, so a fresh object per call would
      // re-render forever.
      let cachedItems: readonly { promptId: string; text: string }[] = [];
      let queuedState: ReturnType<typeof actual.createViewState> | null = null;
      this.getState = () => {
        if (queueStub.items.length === 0) return state;
        if (queueStub.items !== cachedItems || queuedState === null) {
          cachedItems = queueStub.items;
          queuedState = {
            ...state,
            loaded: true,
            queuedPromptIds: queueStub.items.map((item) => item.promptId),
            blocks: [
              ...state.blocks,
              ...queueStub.items.map((item) => ({
                kind: 'user' as const,
                id: `user-${item.promptId}`,
                promptId: item.promptId,
                text: item.text,
                createdAt: '2026-01-01T00:00:00.000Z',
                promptStatus: 'queued' as const,
              })),
            ],
          };
        }
        return queuedState;
      };
    }

    setFocusedAgent() {}
    sendPrompt(input: { text: string; model?: string; thinking?: string; permissionMode?: string; appendTiming?: 'agent_idle' | 'subagents_done' | 'tasks_done' }) {
      return new Promise((resolve, reject) => { submit.calls.push({ text: input.text, input, resolve, reject }); });
    }
    // Send now goes through the controller's steer ledger, never a queue-then-steer pair.
    sendPromptNow(input: { text: string; model?: string; thinking?: string; permissionMode?: string }) {
      return new Promise((resolve, reject) => { submit.calls.push({ text: input.text, input, now: true, resolve, reject }); });
    }
    steerQueued(promptId: string) { submit.steered.push(promptId); return Promise.resolve(); }
    replaceQueued(promptId: string, text: string) {
      queueStub.replaced.push({ promptId, text });
      const item = queueStub.items.find((entry) => entry.promptId === promptId);
      if (item !== undefined) item.text = text;
      return Promise.resolve();
    }
    abortPrompt() { return Promise.resolve(); }
    holdQueued() { return Promise.resolve(); }
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return undefined; }
  }
  return { ...actual, SessionController: StubSessionController };
});
vi.mock('./ConversationShell', () => {
  // A real dock target so the tray portals somewhere the test can count.
  const dock = document.createElement('div');
  dock.setAttribute('data-test-dock', '');
  document.body.append(dock);
  const slots = { header: null, dock, heroFooter: null, rail: null, footer: null, preview: null };
  return {
    EMPTY_SLOTS: { header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null },
    useConversationShell: () => ({ slots }),
    useOptionalConversationShell: () => ({ slots }),
    useRegisterSeat: (next: { composer: unknown }) => { seat.composer = next.composer; },
  };
});
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./mediaPreview', () => ({
  MediaPreviewProvider: ({ children }: { children: ReactNode }) => children,
  PreviewToggleButton: () => null,
  useMediaPreview: () => undefined,
}));
vi.mock('./Transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Transcript')>();
  return { ...actual, Transcript: () => <div data-transcript /> };
});
vi.mock('./SelectionQuoteButton', () => ({
  SelectionQuoteButton: ({ onAnnotate }: { onAnnotate: (quote: string, comment: string) => void }) => (
    <button type="button" data-annotate onClick={() => { onAnnotate('selected source', 'keep this'); }}>
      Annotate
    </button>
  ),
}));

function RoutesWithNavigation() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" data-switch-b onClick={() => { void navigate('/s/session-b'); }}>B</button>
      <button type="button" data-switch-a onClick={() => { void navigate('/s/session-a'); }}>A</button>
      <Routes>
        <Route path="/s/:id" element={<ActiveSession />} />
      </Routes>
    </>
  );
}

function ActiveSession() {
  const { id } = useParams<{ id: string }>();
  return <SessionRouteView sessionId={id} sessions={[]} onToggleSidebar={() => {}} />;
}

type ComposerProps = {
  value: string;
  annotations: readonly SelectionAnnotation[];
  onSend: (
    text: string,
    attachments: readonly never[],
    options?: { readonly goalObjective?: string; readonly appendTiming?: 'agent_idle' | 'subagents_done' | 'tasks_done' },
  ) => Promise<unknown> | undefined;
  onSendNow: (text: string, attachments: readonly never[]) => Promise<unknown> | undefined;
  onChangeModel: (model: string | undefined) => void;
  onChangePermissionMode: (mode: 'manual' | 'auto' | 'yolo') => void;
  serverDefaultModel?: string;
  onQueueEditConfirm?: (text: string) => Promise<void>;
  onQueueEditCancel?: () => void;
  onUpdateAnnotation?: (id: string, comment: string) => void;
};

function composerProps(): ComposerProps {
  expect(isValidElement(seat.composer)).toBe(true);
  const context = seat.composer as ReactElement<{ children: ReactElement<ComposerProps> }>;
  return context.props.children.props;
}

function currentAnnotations(): readonly SelectionAnnotation[] {
  return composerProps().annotations;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('session selection annotations', () => {
  it.each([false, true])('only inherits native model defaults for native sessions: external=%s', async (external) => {
    resetComposerMemoryForTests();
    clearComposerState('session-a');
    fixture.external = external;
    submit.calls.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queries.setQueryData(['config'], { default_model: 'provider/native-model' });
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={queries}>
          <I18nProvider><MemoryRouter initialEntries={['/s/session-a']}><RoutesWithNavigation /></MemoryRouter></I18nProvider>
        </QueryClientProvider>);
      });
      expect(composerProps().serverDefaultModel).toBe(external ? undefined : 'provider/native-model');
      let sent: Promise<unknown> | undefined;
      await act(async () => { sent = composerProps().onSend('hello', []); });
      expect(submit.calls.at(-1)?.input).toMatchObject({ model: external ? undefined : 'provider/native-model' });
      expect(submit.calls.at(-1)?.input?.permissionMode).toBeUndefined();
      await act(async () => { submit.calls.at(-1)!.resolve({ status: 'running', prompt_id: 'first' }); await sent; });
      await act(async () => { composerProps().onChangePermissionMode('yolo'); });
      await act(async () => { composerProps().onChangeModel('opus'); });
      await act(async () => { sent = composerProps().onSend('explicit', []); });
      expect(submit.calls.at(-1)?.input?.model).toBe('opus');
      expect(submit.calls.at(-1)?.input?.permissionMode).toBe('yolo');
      await act(async () => { submit.calls.at(-1)!.resolve({ status: 'running', prompt_id: 'second' }); await sent; });
    } finally {
      fixture.external = false;
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
  it('rides the send-timing pick as appendTiming, else the configured default', async () => {
    resetComposerMemoryForTests();
    clearComposerState('session-a');
    submit.calls.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider><MemoryRouter initialEntries={['/s/session-a']}><RoutesWithNavigation /></MemoryRouter></I18nProvider>
        </QueryClientProvider>);
      });
      let sent: Promise<unknown> | undefined;
      // The menu's one-shot pick overrides the configured default once.
      await act(async () => { sent = composerProps().onSend('timed', [], { appendTiming: 'subagents_done' }); });
      expect(submit.calls.at(-1)?.input?.appendTiming).toBe('subagents_done');
      await act(async () => { submit.calls.at(-1)!.resolve({ status: 'queued', prompt_id: 'p-timed' }); await sent; });
      // A plain send keeps the settings default ('agent_idle').
      await act(async () => { sent = composerProps().onSend('plain', []); });
      expect(submit.calls.at(-1)?.input?.appendTiming).toBe('agent_idle');
      await act(async () => { submit.calls.at(-1)!.resolve({ status: 'running', prompt_id: 'p-plain' }); await sent; });
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
  it('keeps unsent annotations after switching away and back without leaking to another session', async () => {
    resetComposerMemoryForTests();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <I18nProvider>
              <MemoryRouter initialEntries={['/s/session-a']}>
                <RoutesWithNavigation />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      expect(currentAnnotations()).toEqual([]);
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-annotate]')!.click(); });
      expect(currentAnnotations()).toMatchObject([{ quote: 'selected source', comment: 'keep this' }]);

      await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-b]')!.click(); });
      expect(currentAnnotations()).toEqual([]);
      expect(readComposerState('session-a').annotations).toMatchObject([
        { quote: 'selected source', comment: 'keep this' },
      ]);
      expect(readComposerState('session-b').annotations).toEqual([]);

      await act(async () => { container.querySelector<HTMLButtonElement>('[data-switch-a]')!.click(); });
      expect(currentAnnotations()).toMatchObject([{ quote: 'selected source', comment: 'keep this' }]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      resetComposerMemoryForTests();
    }
  });

  const accepted = (status: 'running' | 'queued') => ({
    prompt_id: 'prompt-1', user_message_id: 'msg-1', status, created_at: '2026-01-01T00:00:00.000Z', content: [],
  });

  async function withSession(run: (container: HTMLElement) => Promise<void>): Promise<void> {
    resetComposerMemoryForTests();
    submit.calls.length = 0;
    submit.steered.length = 0;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <I18nProvider>
              <MemoryRouter initialEntries={['/s/session-a']}>
                <RoutesWithNavigation />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-annotate]')!.click(); });
      expect(currentAnnotations()).toHaveLength(1);
      await run(container);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      resetComposerMemoryForTests();
    }
  }

  it.each([
    ['a plain send', 'running', false],
    ['a send that parks in the queue', 'queued', false],
    ['send now (steered into the running turn)', 'queued', true],
  ] as const)('takes the notes off the composer the moment %s goes out', async (_label, status, now) => {
    await withSession(async () => {
      let sent: Promise<unknown> | undefined;
      await act(async () => {
        sent = now ? composerProps().onSendNow('go on', []) : composerProps().onSend('go on', []);
      });
      expect(submit.calls).toHaveLength(1);
      expect(submit.calls[0]!.text).toContain('keep this');
      expect(submit.calls[0]!.now).toBe(now ? true : undefined);
      // In flight: the notes already ride the prompt, not the composer.
      expect(currentAnnotations()).toEqual([]);
      await act(async () => {
        submit.calls[0]!.resolve(now ? { promptId: 'prompt-1', outcome: 'steered' } : accepted(status));
        await sent;
      });
      expect(currentAnnotations()).toEqual([]);
      expect(readComposerState('session-a').annotations).toEqual([]);
      // The ledger steers by itself; the view never issues a follow-up steer.
      expect(submit.steered).toEqual([]);
    });
  });

  it.each([
    ['refused by the running turn', 'refused', true],
    ['never reached the server', 'submit', true],
    ['lost in an unknown state', 'unknown', false],
  ] as const)('hands a send-now back to the composer when it was %s', async (_label, reason, restored) => {
    await withSession(async () => {
      let sent: Promise<unknown> | undefined;
      await act(async () => { sent = composerProps().onSendNow('go on', []); });
      expect(currentAnnotations()).toEqual([]);
      await act(async () => { submit.calls[0]!.reject(new SendNowError(reason, new Error('busy'))); await sent; });
      // Only a send that provably never landed returns its notes; an unknown
      // outcome may already be in the turn, so it is not duplicated.
      expect(currentAnnotations()).toHaveLength(restored ? 1 : 0);
    });
  });

  it('hands the notes back when the send fails, ahead of any added meanwhile', async () => {
    await withSession(async (container) => {
      let sent: Promise<unknown> | undefined;
      await act(async () => { sent = composerProps().onSend('go on', []); });
      expect(currentAnnotations()).toEqual([]);
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-annotate]')!.click(); });
      const added = currentAnnotations();
      expect(added).toHaveLength(1);
      await act(async () => { submit.calls[0]!.reject(new Error('offline')); await sent; });
      const back = currentAnnotations();
      expect(back).toHaveLength(2);
      expect(back[1]).toBe(added[0]);
      expect(back[0]!.id).not.toBe(added[0]!.id);
    });
  });

  it('a queue edit restores the parked prompt\u2019s notes as live draft annotations', async () => {
    queueStub.items = [{ promptId: 'p-queued', text: '> quoted passage\n\nComment: noted\n\nqueued body' }];
    queueStub.replaced = [];
    resetComposerMemoryForTests();
    resetDraftMemoryForTests();
    clearStoredDrafts();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const composerHost = document.createElement('div');
    document.body.append(composerHost);
    const composerRoot = createRoot(composerHost);
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <I18nProvider>
              <MemoryRouter initialEntries={['/s/session-a']}>
                <RoutesWithNavigation />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        composerRoot.render(
          <QueryClientProvider client={new QueryClient()}>
            <I18nProvider><MemoryRouter>{seat.composer as ReactElement}</MemoryRouter></I18nProvider>
          </QueryClientProvider>,
        );
      });
      // Open the queue sheet, then start the row's round-trip edit.
      const summary = [...composerHost.querySelectorAll('button')].find((b) => b.textContent?.includes('1 queued'))!;
      await act(async () => { summary.click(); });
      const editButton = [...composerHost.querySelectorAll<HTMLButtonElement>('[data-queue-item="p-queued"] button')]
        .find((b) => b.getAttribute('aria-label') === 'Edit queued prompt')!;
      await act(async () => { editButton.click(); });

      // Notes and body split back apart: the chip lives, the draft holds only the body.
      expect(currentAnnotations()).toMatchObject([{ quote: 'quoted passage', comment: 'noted' }]);
      expect(composerProps().value).toBe('queued body');

      // Editing the note rides the confirm back into the queued text's prefix.
      const noteId = currentAnnotations()[0]!.id;
      await act(async () => { composerProps().onUpdateAnnotation!(noteId, 'noted harder'); });
      await act(async () => { await composerProps().onQueueEditConfirm!('edited body'); });
      expect(queueStub.replaced).toEqual([
        { promptId: 'p-queued', text: '> quoted passage\n\nComment: noted harder\n\nedited body' },
      ]);
      // The composer then hands its pre-edit state back: empty here.
      expect(currentAnnotations()).toEqual([]);
      expect(composerProps().value).toBe('');
    } finally {
      await act(async () => { composerRoot.unmount(); });
      composerHost.remove();
      await act(async () => { root.unmount(); });
      container.remove();
      queueStub.items = [];
      queueStub.replaced = [];
      resetComposerMemoryForTests();
      resetDraftMemoryForTests();
      clearStoredDrafts();
    }
  });

  it('shows an unsent note once: as the composer chip, never also in the tray', async () => {
    await withSession(async (container) => {
      const composerHost = document.createElement('div');
      document.body.append(composerHost);
      const composerRoot = createRoot(composerHost);
      try {
        await act(async () => {
          composerRoot.render(
            <QueryClientProvider client={new QueryClient()}>
              <I18nProvider><MemoryRouter>{seat.composer as ReactElement}</MemoryRouter></I18nProvider>
            </QueryClientProvider>,
          );
        });
        // Every surface that could carry an unsent note: the page, the composer
        // seat and the dock above it. Unsent notes fold into ONE pill in the
        // composer; its panel (hover/click) is part of the pill.
        const surfaces = [container, composerHost, document.querySelector('[data-test-dock]')!];
        const pills = surfaces.flatMap((root) => [...root.querySelectorAll('[data-composer-notes-pill]')]);
        expect(pills).toHaveLength(1);
        expect(pills[0]!.textContent).toContain('1 note');
        expect(surfaces.some((root) => root.querySelector('[data-annotation-chip]') !== null)).toBe(false);
        expect(surfaces.some((root) => root.querySelector('[data-annotation-tray-row]') !== null)).toBe(false);
        expect(document.querySelector('[data-annotation-tray]')).toBeNull();
      } finally {
        await act(async () => { composerRoot.unmount(); });
        composerHost.remove();
      }
    });
  });
});

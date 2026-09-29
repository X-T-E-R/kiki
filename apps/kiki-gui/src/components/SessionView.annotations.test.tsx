// @vitest-environment jsdom

import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readComposerState, resetComposerMemoryForTests, type SelectionAnnotation } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { SessionRouteView } from './SessionView';

const { seat, submit } = vi.hoisted(() => ({
  seat: { composer: null as unknown },
  submit: {
    // Each send hands the test a deferred result so it can inspect the
    // composer mid-flight, then settle it (accepted / queued / rejected).
    calls: [] as { text: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }[],
    steered: [] as string[],
  },
}));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({}),
    listModels: () => Promise.resolve({ items: [] }),
  };
  const registry = { add: () => {}, delete: () => {} };
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
    readonly getState: () => ReturnType<typeof actual.createViewState>;

    constructor(_sessions: unknown, _view: unknown, sessionId: string) {
      this.sessionId = sessionId;
      const state = actual.createViewState(sessionId);
      this.getState = () => state;
    }

    setFocusedAgent() {}
    sendPrompt(input: { text: string }) {
      return new Promise((resolve, reject) => { submit.calls.push({ text: input.text, resolve, reject }); });
    }
    steerQueued(promptId: string) { submit.steered.push(promptId); return Promise.resolve(); }
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return undefined; }
  }
  return { ...actual, SessionController: StubSessionController };
});
vi.mock('./ConversationShell', () => ({
  EMPTY_SLOTS: { header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null },
  useConversationShell: () => ({ slots: { header: null, dock: null, rail: null, footer: null } }),
  useOptionalConversationShell: () => ({ slots: { header: null, dock: null, rail: null, footer: null } }),
  useRegisterSeat: (next: { composer: unknown }) => { seat.composer = next.composer; },
}));
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
  annotations: readonly SelectionAnnotation[];
  onSend: (text: string, attachments: readonly never[]) => Promise<unknown> | undefined;
  onSendNow: (text: string, attachments: readonly never[]) => Promise<unknown> | undefined;
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
    ['send now (queued, then steered in)', 'queued', true],
  ] as const)('takes the notes off the composer the moment %s goes out', async (_label, status, now) => {
    await withSession(async () => {
      let sent: Promise<unknown> | undefined;
      await act(async () => {
        sent = now ? composerProps().onSendNow('go on', []) : composerProps().onSend('go on', []);
      });
      expect(submit.calls).toHaveLength(1);
      expect(submit.calls[0]!.text).toContain('keep this');
      // In flight: the notes already ride the prompt, not the composer.
      expect(currentAnnotations()).toEqual([]);
      await act(async () => { submit.calls[0]!.resolve(accepted(status)); await sent; });
      expect(currentAnnotations()).toEqual([]);
      expect(readComposerState('session-a').annotations).toEqual([]);
      expect(submit.steered).toEqual(now ? ['prompt-1'] : []);
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
});

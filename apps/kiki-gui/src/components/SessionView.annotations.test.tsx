// @vitest-environment jsdom

import { act, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readComposerState, resetComposerMemoryForTests, type SelectionAnnotation } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { SessionRouteView } from './SessionView';

const { seat } = vi.hoisted(() => ({ seat: { composer: null as unknown } }));

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
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return undefined; }
  }
  return { ...actual, SessionController: StubSessionController };
});
vi.mock('./ConversationShell', () => ({
  useConversationShell: () => ({ slots: { header: null, dock: null, rail: null, footer: null } }),
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

function currentAnnotations(): readonly SelectionAnnotation[] {
  expect(isValidElement(seat.composer)).toBe(true);
  const context = seat.composer as ReactElement<{ children: ReactElement<{ annotations: readonly SelectionAnnotation[] }> }>;
  return context.props.children.props.annotations;
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
});

// @vitest-environment jsdom

import { act, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { MediaPreviewApi } from './mediaPreviewContext';
import { SessionRouteView } from './SessionView';

// SessionView with its surroundings stubbed down to what an agent open from
// the rail touches: the rail (which calls onOpenSubagent), the preview
// provider (which opens a tab and renders it), and the viewport width.

const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({}),
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
  const forest = actual.buildAgentForest([], [
    { agentId: 'main', name: 'Main' },
    { agentId: 'worker', parentAgentId: 'main', name: 'Worker', status: 'running' },
  ]);
  class StubSessionController {
    readonly sessionId: string;
    readonly subscribe = () => () => {};
    readonly subscribeInterruptedPrompt = () => () => {};
    readonly subscribeAgent = () => () => {};
    readonly getState: () => ReturnType<typeof actual.createViewState>;
    readonly getAgentState: () => ReturnType<typeof actual.createViewState>;
    constructor(_sessions: unknown, _view: unknown, sessionId: string) {
      this.sessionId = sessionId;
      const state = actual.createViewState(sessionId);
      this.getState = () => state;
      this.getAgentState = () => state;
    }
    setFocusedAgent() {}
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return forest; }
  }
  return { ...actual, SessionController: StubSessionController };
});
const slots = vi.hoisted(() => ({ header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null } as Record<string, HTMLElement | null>));
vi.mock('./ConversationShell', () => ({
  EMPTY_SLOTS: { header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null },
  useConversationShell: () => ({ slots }),
  useOptionalConversationShell: () => ({ slots }),
  useRegisterSeat: () => {},
}));
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./Transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Transcript')>();
  return { ...actual, Transcript: () => <div data-transcript /> };
});
vi.mock('./SelectionQuoteButton', () => ({ SelectionQuoteButton: () => null }));
// The preview: a tab strip that opens (and selects) an agent tab.
vi.mock('./mediaPreview', () => ({
  PreviewToggleButton: () => null,
  useMediaPreview: () => undefined,
  MediaPreviewProvider: ({ children, apiRef }: { children: ReactNode; apiRef: Ref<MediaPreviewApi> }) => {
    const [tabs, setTabs] = useState<string[]>([]);
    useImperativeHandle(apiRef, () => ({
      openAgentPanel: (agentId: string) => {
        opened.push(agentId);
        setTabs((current) => (current.includes(agentId) ? current : [...current, agentId]));
      },
    }) as unknown as MediaPreviewApi);
    return (
      <>
        <div role="tablist">
          {tabs.map((id, index) => (
            <div key={id} role="tab" tabIndex={0} data-preview-tab-key={`panel:${id}`}
              aria-selected={index === tabs.length - 1}>{id}</div>
          ))}
        </div>
        {children}
      </>
    );
  },
}));
// The rail: the three ways it opens an agent, all through onOpenSubagent.
function StubRail({ onOpenSubagent }: { onOpenSubagent: (agentId: string) => void }) {
  return (
    <aside data-session-rail>
      <button type="button" data-entry="roster" onClick={() => { onOpenSubagent('worker'); }}>row</button>
      <button type="button" data-entry="needs-you" onClick={() => { onOpenSubagent('worker'); }}>from</button>
      <button type="button" data-entry="relation" onClick={() => { onOpenSubagent('worker'); }}>chip</button>
    </aside>
  );
}
vi.mock('./RightRail', () => ({ RightRail: StubRail }));

let narrow = true;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width') ? narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

async function mountAt(width: 'narrow' | 'wide') {
  narrow = width === 'narrow';
  opened.length = 0;
  const host = document.createElement('div');
  document.body.append(host);
  for (const name of ['header', 'dock', 'rail', 'footer'] as const) {
    const slot = document.createElement('div');
    slot.dataset['slot'] = name;
    host.append(slot);
    slots[name] = slot;
  }
  const container = document.createElement('div');
  host.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/session-a']}>
            <Routes>
              <Route path="/s/:id" element={<SessionRouteView sessionId="session-a" sessions={[]} onToggleSidebar={() => {}} />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  const rail = () => host.querySelector('[data-session-rail]');
  const openRail = async () => {
    if (rail() === null) await act(async () => { host.querySelector<HTMLButtonElement>('[data-rail-toggle]')!.click(); });
  };
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    for (const name of Object.keys(slots)) slots[name] = null;
  };
  return { host, rail, openRail, unmount };
}

const frames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

describe('opening a subagent from the overlay rail', () => {
  it.each(['roster', 'needs-you', 'relation'])('closes the narrow rail and focuses the new tab (%s)', async (entry) => {
    const view = await mountAt('narrow');
    try {
      await view.openRail();
      expect(view.rail()).not.toBeNull();
      await act(async () => { view.host.querySelector<HTMLButtonElement>(`[data-entry="${entry}"]`)!.click(); });
      await frames();
      expect(opened).toEqual(['worker']);
      expect(view.rail()).toBeNull();
      const tab = view.host.querySelector<HTMLElement>('[data-preview-tab-key="panel:worker"]')!;
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab);
      expect(view.host.querySelector('[data-rail-toggle]')!.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the docked rail open on a wide viewport', async () => {
    const view = await mountAt('wide');
    try {
      await view.openRail();
      await act(async () => { view.host.querySelector<HTMLButtonElement>('[data-entry="roster"]')!.click(); });
      await frames();
      expect(opened).toEqual(['worker']);
      expect(view.rail()).not.toBeNull();
      expect(view.host.querySelector('[data-preview-tab-key="panel:worker"]')!.getAttribute('aria-selected')).toBe('true');
    } finally {
      await view.unmount();
    }
  });
});

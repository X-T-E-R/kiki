// @vitest-environment jsdom

import { act, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import type { MediaPreviewApi } from './mediaPreviewContext';
import { readTimelineView, writeTimelineView } from './message/messageViewMode';
import { SessionRouteView, SessionTitle } from './SessionView';

// SessionView with its surroundings stubbed down to what an agent open from
// the rail touches: the rail (which calls onOpenSubagent), the preview
// provider (which opens a tab and renders it), and the viewport width.

const { opened, fixture } = vi.hoisted(() => ({
  opened: [] as string[],
  fixture: { session: undefined as Session | undefined },
}));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    klient: { session: () => ({ agent: () => ({ events: { on: () => ({ ready: Promise.resolve(), dispose: () => {} }) } }) }) },
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({}),
    listModels: () => Promise.resolve({ items: [] }),
    listAgentModelSwitches: () => Promise.resolve([]),
    subscribeAgentModelSwitches: () => ({ ready: Promise.resolve(), dispose: () => {} }),
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
    useOptionalConnection: () => null,
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
      const state = { ...actual.createViewState(sessionId), session: fixture.session };
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
type MediaChangeListener = (event: MediaQueryListEvent) => void;
const narrowListeners = new Set<MediaChangeListener>();

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('matchMedia', (query: string) => {
    const isNarrowQuery = query.includes('max-width: 1023px');
    return {
      matches: isNarrowQuery || query.includes('max-width: 639px') ? narrow : false,
      media: query,
      addEventListener: (event: string, listener: MediaChangeListener) => {
        if (isNarrowQuery && event === 'change') narrowListeners.add(listener);
      },
      removeEventListener: (event: string, listener: MediaChangeListener) => {
        if (isNarrowQuery && event === 'change') narrowListeners.delete(listener);
      },
    };
  });
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

async function resizeTo(width: 'narrow' | 'wide'): Promise<void> {
  await act(async () => {
    narrow = width === 'narrow';
    const event = { matches: narrow, media: '(max-width: 1023px)' } as MediaQueryListEvent;
    for (const listener of narrowListeners) listener(event);
  });
}

async function mountAt(width: 'narrow' | 'wide', railOpenByDefault = true) {
  narrow = width === 'narrow';
  localStorage.setItem('kiki.settings', JSON.stringify({ railOpenByDefault }));
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
  const toggle = () => host.querySelector<HTMLButtonElement>('[data-rail-toggle]');
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    for (const name of Object.keys(slots)) slots[name] = null;
  };
  return { host, rail, toggle, unmount };
}

async function mountTitleWithoutRail() {
  const onEditingChange = vi.fn();
  const onRename = vi.fn(async () => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SessionTitle
          title="Release prep"
          cwd="C:/fixture/workshop"
          editing={false}
          onEditingChange={onEditingChange}
          onRename={onRename}
        />
      </I18nProvider>,
    );
  });
  return {
    host,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

describe('message-view controls and the persona menu', () => {
  // Two independent questions, tested apart: the reply mode decides whether the
  // message view exists at all, and the binding decides whether the conversation
  // has a persona's surfaces to offer. The old single `isBotSession` answered
  // both with "is this a Bot", which gave an ordinary persona session a message
  // view it never asked for.
  const sessions = [
    { label: 'ordinary reply', delivery: 'reply', agent_config: {}, metadata: {}, message: false, persona: false, bound: false },
    { label: 'ordinary message', delivery: 'message', agent_config: {}, metadata: {}, message: true, persona: false, bound: false },
    { label: 'invalid Bot metadata', delivery: 'reply', agent_config: {}, metadata: { bot_persona_id: 123 }, message: false, persona: false, bound: false },
    { label: 'persona in reply mode', delivery: 'reply', agent_config: { persona: { id: 'example-bot', name: 'Example Bot' } }, metadata: {}, message: false, persona: true, bound: true },
    { label: 'message-delivering Bot home', delivery: 'message', agent_config: {}, metadata: { bot_persona_id: 'example-bot' }, message: true, persona: true, bound: false },
  ] as const;

  describe.each(['narrow', 'wide'] as const)('%s header', (width) => {
    it.each(sessions)('follows the reply mode and the persona binding: $label', async (session) => {
      fixture.session = {
        id: 'session-a', title: 'Example session', workspace_id: 'ws_a',
        agent_config: session.agent_config, metadata: session.metadata, delivery: session.delivery,
      } as Session;
      writeTimelineView('session-a', 'process');
      const view = await mountAt(width);
      try {
        expect(view.host.querySelector('[data-timeline-view-switch]') !== null).toBe(session.message);
        expect(view.host.querySelector('[data-session-persona-identity]') !== null).toBe(session.bound);
        await act(async () => { view.host.querySelector<HTMLButtonElement>('[data-session-actions] > button')!.click(); });
        expect(view.host.querySelectorAll('[data-timeline-view-menu]').length).toBe(session.message && width === 'narrow' ? 2 : 0);
        // The menu carries the reply-mode rows for either reason: a persona's
        // session, or a session whose delivery is the message mode itself.
        expect(view.host.querySelectorAll('[data-delivery-option]').length).toBe(session.persona || session.message ? 2 : 0);
        // Three persona pages plus this conversation's binding-settings drawer.
        expect([...view.host.querySelectorAll('[data-persona-menu]')].map((entry) => entry.getAttribute('data-persona-menu'))).toEqual(session.persona ? [
          'persona.menu.conversations', 'persona.menu.settings', 'persona.menu.memory', 'persona.menu.binding',
        ] : []);
        expect(view.host.querySelector('[data-bot-settings-open]')).toBeNull();
        expect(view.host.querySelector('[data-session-rename]')).not.toBeNull();
        expect(view.host.querySelector('[data-side-question]')).not.toBeNull();

        const shortcut = new KeyboardEvent('keydown', { key: '.', code: 'Period', ctrlKey: true, shiftKey: true, cancelable: true });
        await act(async () => { window.dispatchEvent(shortcut); });
        expect(shortcut.defaultPrevented).toBe(session.message);
        expect(readTimelineView('session-a', fixture.session)).toBe(session.message ? 'message' : 'process');
      } finally {
        await view.unmount();
        fixture.session = undefined;
      }
    });
  });
});

describe('right rail responsive layout', () => {
  it('does not render the rail or a header entry below the lg breakpoint', async () => {
    const view = await mountAt('narrow');
    try {
      expect(view.rail()).toBeNull();
      expect(view.host.querySelector('.app-overlay-backdrop')).toBeNull();
      expect(view.toggle()).toBeNull();
      expect(view.host.querySelector('[data-agent-rail-toggle]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('renders the rail inline on wide screens and follows railOpenByDefault', async () => {
    const openByDefault = await mountAt('wide', true);
    try {
      expect(openByDefault.rail()).not.toBeNull();
      expect(openByDefault.toggle()?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await openByDefault.unmount();
    }

    const closedByDefault = await mountAt('wide', false);
    try {
      expect(closedByDefault.rail()).toBeNull();
      expect(closedByDefault.toggle()?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await closedByDefault.unmount();
    }
  });

  it('preserves the wide-screen preference across wide → narrow → wide', async () => {
    const view = await mountAt('wide', true);
    try {
      expect(view.rail()).not.toBeNull();
      await act(async () => { view.toggle()!.click(); });
      expect(view.rail()).toBeNull();
      expect(view.toggle()?.getAttribute('aria-expanded')).toBe('false');

      await resizeTo('narrow');
      expect(view.rail()).toBeNull();
      expect(view.toggle()).toBeNull();

      await resizeTo('wide');
      expect(view.rail()).toBeNull();
      expect(view.toggle()?.getAttribute('aria-expanded')).toBe('false');

      await act(async () => { view.toggle()!.click(); });
      expect(view.rail()).not.toBeNull();
      await resizeTo('narrow');
      await resizeTo('wide');
      expect(view.rail()).not.toBeNull();
      expect(view.toggle()?.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the conversation mounted in cockpit mode and at narrow widths', async () => {
    localStorage.setItem('kiki.railMode', 'cockpit');
    const view = await mountAt('wide');
    try {
      const transcript = view.host.querySelector('[data-transcript]');
      expect(transcript).not.toBeNull();
      expect(view.rail()).not.toBeNull();
      await resizeTo('narrow');
      expect(view.host.querySelector('[data-transcript]')).toBe(transcript);
      expect(view.rail()).toBeNull();
      await resizeTo('wide');
      expect(view.host.querySelector('[data-transcript]')).toBe(transcript);
      expect(view.rail()).not.toBeNull();
    } finally {
      await view.unmount();
      localStorage.removeItem('kiki.railMode');
    }
  });

  it('does not make the cwd a rail entry when the rail is unavailable', async () => {
    const view = await mountTitleWithoutRail();
    try {
      const cwd = view.host.querySelector('[data-session-cwd]');
      expect(cwd?.tagName).toBe('SPAN');
      await act(async () => { cwd?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(view.host.querySelector('[data-session-rail]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });
});

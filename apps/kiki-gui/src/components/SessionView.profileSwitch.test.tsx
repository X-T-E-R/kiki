// @vitest-environment jsdom

/**
 * The running-turn profile switch, walked as a user: a turn is in flight, the
 * profile chip stays browsable, a pick asks once, and the next message carries
 * the new profile while the running turn keeps the old one.
 *
 * These are whole-SessionView tests on purpose. The unit helpers in
 * SessionView.test.tsx cover the send-time projection; what can break here is
 * the wiring between the chip, the confirm dialog, the pending chip and the
 * submission, and that wiring only exists once the real component is mounted.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { clearComposerState, clearStoredDrafts, resetComposerMemoryForTests, resetDraftMemoryForTests } from '@kiki/session-core/composer';
import { settingsSnapshot } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from '../lib/toasts';
import { ConversationShell } from './ConversationShell';
import { SessionRouteView } from './SessionView';

const { listNamedAgentProfiles, sendPrompt, steerQueued, sendPromptNow, promptResult, fixture, abort } = vi.hoisted(() => ({
  listNamedAgentProfiles: vi.fn(),
  sendPrompt: vi.fn(),
  steerQueued: vi.fn(),
  sendPromptNow: vi.fn(),
  promptResult: { current: { status: 'started' as 'started' | 'queued', prompt_id: 'prompt-1' } },
  abort: vi.fn(),
  fixture: { session: undefined as Session | undefined, busy: false, profile: 'agent' },
}));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({}),
    listNamedAgentProfiles,
    getSessionGoal: () => Promise.resolve(null),
    getAgentCapabilities: () => Promise.resolve({ context: 'live', available: false, targets: [] }),
    listModels: () => Promise.resolve({ items: [] }),
    listAgentModelSwitches: () => Promise.resolve([]),
    subscribeAgentModelSwitches: () => ({ ready: Promise.resolve(), dispose: () => {} }),
    klient: {
      session: () => ({
        agent: () => ({
          events: { on: () => ({ ready: Promise.resolve(), dispose: () => {} }) },
        }),
      }),
    },
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
  class StubSessionController {
    readonly sessionId = 'session-a';
    readonly subscribe = () => () => {};
    readonly subscribeInterruptedPrompt = () => () => {};
    readonly subscribeAgent = () => () => {};
    // One state object identity, refreshed only when the fixture changes: a
    // fresh object per call would re-enter every subscriber on each poll and
    // spin React's update limit.
    readonly state = {
      ...actual.createViewState('session-a'),
      loaded: true,
      transcriptReady: true,
      // A started conversation plus a turn in flight: the two facts that make
      // this the mid-run case rather than a blank session.
      blocks: [{
        kind: 'user' as const,
        id: 'user-1',
        text: 'earlier message',
        createdAt: '2026-10-06T00:00:00.000Z',
      }],
      session: fixture.session,
      busy: fixture.busy,
      abortablePromptId: fixture.busy ? 'prompt-active' : undefined,
      profile: fixture.profile,
    };
    readonly getState = () => this.state;
    readonly getAgentState = () => this.state;
    setFocusedAgent() {}
    // A real switch rebinds the agent, so the session record reports the new
    // profile on the next read. Without this the chip would keep naming the old
    // binding forever, which is a stub artefact rather than product behaviour.
    refreshSession() { return Promise.resolve(); }
    open() { return Promise.resolve(); }
    close() {}
    getForest() { return actual.buildAgentForest([], []); }
    retainHistoryRead() { return () => {}; }
    async sendPrompt(input: unknown) {
      const result = await sendPrompt(input);
      // The engine binds the profile carried by the message it accepts, so the
      // session record reports it from then on. This is the observable end of
      // the switch, and it is what the chip reflects.
      const carried = (input as { execution?: { profile?: string } }).execution?.profile;
      if (carried !== undefined) {
        fixture.profile = carried;
        this.state.profile = carried;
        if (this.state.session !== undefined) {
          this.state.session = { ...this.state.session, agent_config: { ...this.state.session.agent_config, profile: carried } };
        }
      }
      return result;
    }
    async steerQueued(promptId: string) { return steerQueued(promptId); }
    async sendPromptNow(input: unknown) { return sendPromptNow(input); }
    async abort() { return abort(); }
  }
  return { ...actual, SessionController: StubSessionController };
});
// The real shell is what mounts the seat's composer, so it is used as-is: a stub
// that dropped the seat would hide the exact control under test.
vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('./Transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Transcript')>();
  return { ...actual, Transcript: () => <div data-transcript /> };
});
vi.mock('./SelectionQuoteButton', () => ({ SelectionQuoteButton: () => null }));
vi.mock('./mediaPreview', () => ({
  PreviewToggleButton: () => null,
  useMediaPreview: () => undefined,
  MediaPreviewProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('./RightRail', () => ({ RightRail: () => null }));

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.unstubAllGlobals();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const host of hosts.splice(0)) host.remove();
  clearToasts();
});

function profileCatalog() {
  listNamedAgentProfiles.mockResolvedValue({
    items: [
      { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
      { name: 'reviewer', source: 'workspace', main: true, disabled: false, routes: [] },
    ],
  });
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  hosts.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <MemoryRouter initialEntries={['/s/session-a']}>
            <Routes>
              {/* The real shell mounts the seat's composer; only the header
                  actions are stubbed, which nothing here touches. */}
              <Route element={<ConversationShell />}>
                <Route
                  path="/s/:id"
                  element={<SessionRouteView sessionId="session-a" sessions={[]} onToggleSidebar={() => {}} />}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelector('#composer-execution-select') !== null) break;
    await settle();
  }
  return { container };
}

/** The composer and its panels are queried through the whole mounted tree. */
function ui(container: HTMLElement): HTMLElement {
  return container;
}

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error('element to click is missing');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const profileTrigger = (container: HTMLElement) =>
  ui(container).querySelector<HTMLButtonElement>('#composer-execution-select');

const profileRow = (container: HTMLElement, name: string) =>
  [...ui(container).querySelectorAll<HTMLElement>('[data-execution-profile]')]
    .find((row) => row.dataset['executionProfile'] === name);

const dialogButton = (container: HTMLElement, label: string) =>
  [...ui(container).querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((button) => button.textContent?.trim() === label);

const composerInput = (container: HTMLElement) =>
  ui(container).querySelector<HTMLTextAreaElement>('textarea[data-composer]');

async function type(text: string, container: HTMLElement): Promise<void> {
  const input = composerInput(container);
  if (input === null) throw new Error('composer input is missing');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function sendNextMessage(container: HTMLElement): Promise<void> {
  await type('the next message', container);
  // The composer's own send button: a queued send while a turn runs, which is
  // exactly the situation a confirmed switch has to work in.
  const send = [...ui(container).querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.getAttribute('aria-label')?.startsWith('Queue'));
  await click(send);
  await settle();
  await settle();
}

beforeEach(() => {
  clearComposerState('session-a');
  clearStoredDrafts();
  resetComposerMemoryForTests();
  resetDraftMemoryForTests();
  clearToasts();
  sendPrompt.mockReset().mockImplementation(async () => promptResult.current);
  steerQueued.mockReset().mockResolvedValue(undefined);
  sendPromptNow.mockReset().mockResolvedValue({ outcome: 'sent' });
  abort.mockReset().mockResolvedValue(undefined);
  profileCatalog();
  fixture.busy = true;
  fixture.profile = 'agent';
  // A workspace_id is what puts the profile catalog in scope; without it the
  // picker is deliberately empty.
  fixture.session = {
    workspace_id: 'wd_alpha',
    title: 'Release prep',
    agent_config: { profile: 'agent' },
    metadata: {},
  } as unknown as Session;
  promptResult.current = { status: 'started', prompt_id: 'prompt-1' };
});

describe('switching profile while a turn is running', () => {
  it('keeps the chip browsable mid-run and asks once before recording the switch', async () => {
    const { container } = await mount();
    const trigger = profileTrigger(container);
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(false);

    await click(trigger);
    await settle();
    expect(profileRow(container, 'reviewer')).toBeDefined();
    await click(profileRow(container, 'reviewer'));

    // One confirmation, naming the profile and when it lands.
    const dialog = ui(container).querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Switch to Kiki?');
    expect(dialog?.textContent).toContain('The reviewer profile supplies Kiki’s prompt, tools and context');
    expect(dialog?.textContent).toContain('next message');
    // Mid-run, the dialog also answers the question a running user has.
    expect(dialog?.textContent).toContain('running now');
    // Nothing has switched yet, and the running turn was not touched.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(profileTrigger(container)?.textContent).toContain('Kiki');

    await click(dialogButton(container, 'Switch engine'));
    // Pending is shown as pending, in words, not as already-applied.
    expect(profileTrigger(container)?.textContent).toContain('next message');
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation leaves the running binding exactly as it was', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Cancel'));

    expect(ui(container).querySelector('[role="alertdialog"]')).toBeNull();
    expect(profileTrigger(container)?.textContent).toContain('Kiki');
    expect(profileTrigger(container)?.textContent).not.toContain('next message');

    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    // A cancelled switch must leave the submission exactly as an ordinary one:
    // the resolved profile is undefined, so nothing is sent to bind.
    expect((sendPrompt.mock.calls[0]?.[0] as { profile?: string }).profile).toBeUndefined();
  });

  it('sends the confirmed profile on the next user message and never into the running turn', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));

    await sendNextMessage(container);

    // The next user message carries the new profile, with model/thinking
    // withheld so the new profile's own pins apply.
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = sendPrompt.mock.calls[0]?.[0] as { execution?: { executor: string; profile?: string }; model?: string; thinking?: string };
    expect(submission.execution).toEqual({ executor: 'native', profile: 'reviewer' });
    expect(submission.model).toBeUndefined();
    expect(submission.thinking).toBeUndefined();
    // It opened its own turn instead of steering into the live one, and the
    // live one was never interrupted.
    expect(steerQueued).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    // Pending is settled: the chip names the new profile with no pending mark.
    expect(profileTrigger(container)?.textContent).toContain('reviewer');
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
  });

  it('keeps confirmed profile controls on their own message turn even with Send now', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));
    await type('continue with the chosen profile', container);
    await act(async () => {
      composerInput(container)?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, shiftKey: settingsSnapshot().sendShortcut !== 'enter', bubbles: true,
      }));
    });
    await settle();
    await settle();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[0]).toMatchObject({ execution: { executor: 'native', profile: 'reviewer' } });
    expect(sendPromptNow).not.toHaveBeenCalled();
    expect(steerQueued).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not steer a queued switch message into the running turn', async () => {
    // The engine refuses to steer a prompt whose profile differs from the live
    // binding, so the GUI must not ask: the message stays queued and runs next.
    promptResult.current = { status: 'queued', prompt_id: 'prompt-queued' };
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));

    await sendNextMessage(container);

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(steerQueued).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(getToasts().some((toast) => toast.tone === 'error')).toBe(false);
  });

  it('keeps the pick for a retry when the send fails on the network', async () => {
    sendPrompt.mockRejectedValueOnce(new Error('offline'));
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));

    await sendNextMessage(container);

    // The selection survives so the user can retry deliberately; nothing was
    // resent on its own.
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(profileTrigger(container)?.textContent).toContain('next message');
  });

  it('re-picking the current profile drops the pending switch', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));
    expect(profileTrigger(container)?.textContent).toContain('next message');

    await click(profileTrigger(container));
    await settle();
    // The profile row keeps its stable identity under the engine control.
    await click(profileRow(container, 'agent'));

    // No confirmation for a revert, and no pending state left behind.
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(profileTrigger(container)?.textContent).toContain('Kiki');
    expect(profileTrigger(container)?.textContent).not.toContain('next message');

    await sendNextMessage(container);
    expect((sendPrompt.mock.calls[0]?.[0] as { profile?: string }).profile).toBeUndefined();
  });
});

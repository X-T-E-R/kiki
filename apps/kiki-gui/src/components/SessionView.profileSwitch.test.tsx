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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const { listNamedAgentProfiles, listModels, sendPrompt, steerQueued, sendPromptNow, promptResult, fixture, abort, getExecutorModels } = vi.hoisted(() => ({
  listNamedAgentProfiles: vi.fn(),
  listModels: vi.fn(),
  sendPrompt: vi.fn(),
  steerQueued: vi.fn(),
  sendPromptNow: vi.fn(),
  promptResult: { current: { status: 'started' as 'started' | 'queued', prompt_id: 'prompt-1' } },
  abort: vi.fn(),
  getExecutorModels: vi.fn(),
  fixture: { session: undefined as Session | undefined, busy: false, profile: 'agent', model: undefined as string | undefined },
}));

vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../state/connection', () => {
  const client = {
    sessionView: () => ({}),
    getConfig: () => Promise.resolve({}),
    listNamedAgentProfiles,
    getSessionGoal: () => Promise.resolve(null),
    getAgentCapabilities: () => Promise.resolve({ context: 'live', available: false, targets: [] }),
    listModels,
    listAgentModelSwitches: () => Promise.resolve([]),
    subscribeAgentModelSwitches: () => ({ ready: Promise.resolve(), dispose: () => {} }),
    klient: {
      session: () => ({
        agent: () => ({
          events: { on: () => ({ ready: Promise.resolve(), dispose: () => {} }) },
        }),
      }),
      rest: { executors: { getModels: getExecutorModels } },
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
      model: fixture.model,
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
      { name: 'reviewer', source: 'workspace', source_file: '/workspace/.kiki/profiles/reviewer.md', main: true, disabled: false, routes: [] },
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
    if (container.querySelector('#composer-profile-select') !== null) break;
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
  ui(container).querySelector<HTMLButtonElement>('#composer-profile-select');

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
  listModels.mockReset().mockResolvedValue({ items: [] });
  getExecutorModels.mockReset().mockResolvedValue({
    executor_id: 'claude-acp', source: 'negotiated', provenance: 'acp_negotiation', revision: '1', apply_state: 'ready', observed_at: Date.now(),
    effective: {
      models: { state: 'ready', values: ['vendor/sonnet'] },
      thinking_levels: { state: 'ready', values: ['low', 'medium', 'high'] },
      context: { state: 'unknown' },
      controls: {
        model_switch: { applicability: 'fresh_binding', apply_state: 'applied' },
        thinking_switch: { applicability: 'fresh_binding', apply_state: 'applied' },
        manual_compact: { applicability: 'unsupported', apply_state: 'unsupported' },
      },
    },
  });
  profileCatalog();
  fixture.busy = true;
  fixture.profile = 'agent';
  fixture.model = undefined;
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

  it('names the real queue-with-switch result on the send affordances while the switch waits', async () => {
    const { container } = await mount();
    await type('carry the switch', container);

    const sendButton = () => [...ui(container).querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === 'Queue prompt');
    const openTimingMenu = async () => {
      await act(async () => {
        ui(container).querySelector('[data-send-timing-root]')!
          .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 300); }); });
    };
    const closeTimingMenu = async () => {
      await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    };

    // Ordinary busy baseline: the plain queue name and a real send-now row.
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter)');
    await openTimingMenu();
    expect(ui(container).querySelector('[data-send-timing="now"]')).not.toBeNull();
    await closeTimingMenu();

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));
    await settle();

    // Pending switch: the button title names the consequence and the timing
    // menu lists only the choices that exist (no send-now row). The key
    // itself still works — into the queue, carrying the switch.
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter) — the pending switch applies with this message');
    await openTimingMenu();
    expect(ui(container).querySelector('[data-send-timing="now"]')).toBeNull();
    await closeTimingMenu();

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
  });

  it('restores the plain send names when the pending pick is reverted', async () => {
    const { container } = await mount();
    await type('carry the switch', container);
    const sendButton = () => [...ui(container).querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === 'Queue prompt');

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await click(dialogButton(container, 'Switch engine'));
    await settle();
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter) — the pending switch applies with this message');

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'agent'));
    await settle();
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter)');
  });
});

function catalogModel(id: string, displayName: string) {
  return { id, provider_id: 'fixture', remote_id: id, display_name: displayName, max_context_size: 128000 };
}

function workspaceProfile(name: string, extras: { readonly pinned_model_alias?: string } = {}) {
  return {
    name,
    source: 'workspace' as const,
    source_file: `/workspace/.kiki/profiles/${name}.md`,
    main: true,
    disabled: false,
    routes: [],
    ...extras,
  };
}

async function waitForElement(container: HTMLElement, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = container.querySelector(selector);
    if (found !== null) return found;
    await settle();
  }
  throw new Error(`missing ${selector}`);
}

describe('a model switch waiting for the next message', () => {
  it('keeps the next-message hint on the profile chip and the model confirm', async () => {
    fixture.model = 'fixture/live-model';
    listModels.mockResolvedValue({
      items: [catalogModel('fixture/live-model', 'Live'), catalogModel('fixture/other-model', 'Other')],
    });
    const { container } = await mount();
    await click(await waitForElement(container, '#composer-execution-select'));
    await click(await waitForElement(container, '[data-execution-model="fixture/other-model"]'));
    await settle();

    // A started conversation still asks before an engine binding changes, and
    // the model switch keeps its own confirm.
    expect(dialogButton(container, 'Switch engine')).toBeDefined();
    expect(container.querySelector('[data-model-switch-mode]')).not.toBeNull();

    await click(dialogButton(container, 'Switch engine'));
    await settle();

    const profile = profileTrigger(container);
    const model = container.querySelector('#composer-execution-select');
    expect(profile?.textContent).toContain('next message');
    expect(model?.textContent).not.toContain('next message');
    expect(model?.textContent).toContain('fixture/live-model');
    expect(model?.getAttribute('data-execution-pending')).toBe('true');
    expect(container.querySelector('[data-model-switch-mode]')).not.toBeNull();
  });
});

describe('same-executor model selection across a profile switch', () => {
  const liveModel = 'fixture/live-model';

  beforeEach(() => {
    fixture.model = liveModel;
    listModels.mockResolvedValue({
      items: [catalogModel(liveModel, 'Live'), catalogModel('fixture/pinned-model', 'Pinned')],
    });
    listNamedAgentProfiles.mockResolvedValue({
      items: [
        { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [] },
        workspaceProfile('open'),
        workspaceProfile('pinned', { pinned_model_alias: 'fixture/pinned-model' }),
      ],
    });
  });

  async function chooseLiveModel(container: HTMLElement): Promise<void> {
    await click(await waitForElement(container, '#composer-execution-select'));
    await click(await waitForElement(container, `[data-execution-model="${liveModel}"]`));
    await settle();
  }

  async function chooseProfile(container: HTMLElement, name: string): Promise<void> {
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, name));
    await settle();
    await click(dialogButton(container, 'Switch engine'));
    await settle();
  }

  it('sends the model the user selected on this executor when the next profile has no pin', async () => {
    const { container } = await mount();
    await chooseLiveModel(container);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await chooseProfile(container, 'open');

    const modelTrigger = container.querySelector('#composer-execution-select');
    expect(modelTrigger?.textContent).toContain('Live');
    await sendNextMessage(container);

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = sendPrompt.mock.calls[0]?.[0] as {
      execution?: { executor?: string; profile?: string; overrides?: { model?: string | null } };
      model?: string;
      thinking?: string;
    };
    expect(submission.execution).toMatchObject({ executor: 'native', profile: 'open' });
    expect(submission.execution?.overrides).toBeUndefined();
    expect(submission.model).toBe(liveModel);
    expect(submission.thinking).toBeUndefined();
  });

  it('adopts a profile pin instead of sending the previously selected model', async () => {
    const { container } = await mount();
    await chooseLiveModel(container);
    await chooseProfile(container, 'pinned');

    const modelTrigger = container.querySelector('#composer-execution-select');
    expect(modelTrigger?.textContent).toContain('Pinned');
    expect(modelTrigger?.textContent).not.toContain('Live');
    await sendNextMessage(container);

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = sendPrompt.mock.calls[0]?.[0] as {
      execution?: { executor?: string; profile?: string; overrides?: { model?: string | null } };
      model?: string;
      thinking?: string;
    };
    expect(submission.execution).toMatchObject({ executor: 'native', profile: 'pinned' });
    expect(submission.execution?.overrides?.model).toBeUndefined();
    expect(submission.model).toBeUndefined();
    expect(submission.thinking).toBeUndefined();
  });
});

const EFFORT_SHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp', 'effort-switch-185');

function submissionOf(call: unknown): {
  execution?: { executor?: string; profile?: string; overrides?: { model?: string | null; thinking?: string | null } };
  model?: string;
  thinking?: string | null;
  profile?: string;
} {
  return call as {
    execution?: { executor?: string; profile?: string; overrides?: { model?: string | null; thinking?: string | null } };
    model?: string;
    thinking?: string | null;
    profile?: string;
  };
}

describe('effort-only changes stay on the current engine', () => {
  const liveModel = 'fixture/live-model';

  function liveCatalog() {
    listModels.mockResolvedValue({
      items: [{
        id: liveModel,
        provider_id: 'fixture',
        remote_id: liveModel,
        display_name: 'Live',
        max_context_size: 128000,
        support_efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
      }],
    });
  }

  it('changes native effort without an engine confirmation and keeps executor and model off the payload', async () => {
    fixture.model = liveModel;
    liveCatalog();
    const { container } = await mount();
    await click(await waitForElement(container, '#composer-execution-select'));
    const high = await waitForElement(container, '[data-execution-effort="high"]');
    await click(high);
    await settle();

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).not.toContain('Switch to Kiki?');
    expect(container.textContent).not.toContain('This engine did not report its models.');
    expect(container.textContent).not.toContain('Could not validate choices');
    const trigger = container.querySelector('#composer-execution-select');
    expect(trigger?.textContent).toContain(liveModel);
    expect(trigger?.textContent).toContain('high');
    expect(high.getAttribute('aria-checked')).toBe('true');
    expect(high.className).toContain('bg-panel');
    expect(high.className).not.toContain('text-paper');

    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = submissionOf(sendPrompt.mock.calls[0]?.[0]);
    expect(submission.thinking).toBe('high');
    expect(submission.execution).toBeUndefined();
    expect(submission.model).toBeUndefined();
    expect(submission.profile).toBeUndefined();
  }, 60_000);

  it('renders the selected native effort capsule in the historical panel color', async () => {
    fixture.model = liveModel;
    liveCatalog();
    const { container } = await mount();
    await click(await waitForElement(container, '#composer-execution-select'));
    await click(await waitForElement(container, '[data-execution-effort="high"]'));
    await settle();
    const selectedButton = container.querySelector<HTMLButtonElement>('[data-execution-effort="high"]');
    expect(selectedButton?.getAttribute('aria-checked')).toBe('true');
    expect(selectedButton?.className ?? '').toContain('bg-panel');
    const track = selectedButton?.parentElement;
    if (track === null || track === undefined) throw new Error('effort track is missing');

    const { existsSync } = await import('node:fs');
    const { readdir } = await import('node:fs/promises');
    const assets = [join(process.cwd(), 'dist', 'assets'), join(process.cwd(), 'apps', 'kiki-gui', 'dist', 'assets')]
      .find((dir) => existsSync(dir));
    if (assets === undefined) throw new Error('compiled gui stylesheet is missing');
    const cssName = (await readdir(assets)).find((name) => name.startsWith('index-') && name.endsWith('.css'));
    if (cssName === undefined) throw new Error(`no compiled stylesheet in ${assets}`);

    await mkdir(EFFORT_SHOT_DIR, { recursive: true });
    await writeFile(join(EFFORT_SHOT_DIR, 'selected-effort.html'), track.outerHTML);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ args: ['--no-proxy-server'] });
    try {
      const page = await browser.newPage({ viewport: { width: 520, height: 160 }, deviceScaleFactor: 2 });
      await page.setContent(
        '<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head>'
        + '<body class="bg-canvas text-ink"><div class="bg-surface p-6">' + track.outerHTML + '</div></body></html>',
      );
      await page.addStyleTag({ path: join(assets, cssName) });
      // The capsules exist before the stylesheet, so transition-colors starts
      // on the unstyled button face. Settle on the token the class actually sets.
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
      const selected = page.locator('[data-execution-effort="high"]');
      const idle = page.locator('[data-execution-effort="medium"]');
      const color = await selected.evaluate((el) => {
        const style = getComputedStyle(el);
        return { backgroundColor: style.backgroundColor, color: style.color, className: el.className };
      });
      const idleColor = await idle.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(color.backgroundColor).toBe('rgb(255, 253, 250)');
      expect(color.color).toBe('rgb(27, 26, 23)');
      expect(color.backgroundColor).not.toBe('rgb(27, 26, 23)');
      expect(color.className).toContain('bg-panel');
      expect(color.className).not.toContain('text-paper');
      expect(idleColor).not.toBe('rgb(27, 26, 23)');
      const shot = join(EFFORT_SHOT_DIR, 'selected-effort.png');
      await page.locator('body > div').screenshot({ path: shot });
      await writeFile(join(EFFORT_SHOT_DIR, 'selected-effort-color.json'), JSON.stringify({
        selected: color,
        idleBackground: idleColor,
        stylesheet: join(assets, cssName),
        shot,
      }, null, 2));
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('changes external effort without an engine confirmation and keeps the bound model', async () => {
    fixture.model = undefined;
    listModels.mockResolvedValue({
      items: [{
        id: 'fixture/kiki-pro',
        provider_id: 'fixture',
        remote_id: 'kiki-pro',
        display_name: 'Kiki Pro',
        max_context_size: 128000,
        support_efforts: ['low', 'medium', 'high'],
        default_effort: 'medium',
      }],
    });
    fixture.session = {
      workspace_id: 'wd_alpha',
      title: 'Release prep',
      executor_id: 'claude-acp',
      agent_config: {
        profile: 'agent',
        execution: {
          version: 1,
          selection: { executor: 'claude-acp', overrides: { model: 'vendor/sonnet', thinking: 'medium' } },
          effective: { model: 'vendor/sonnet', thinking: 'medium', kiki_context: [], allow_kiki_subagents: false },
          sources: {},
          generation: 1,
        },
      },
      metadata: {},
    } as unknown as Session;

    const { container } = await mount();
    const trigger = await waitForElement(container, '#composer-execution-select');
    expect(trigger.textContent).toContain('vendor/sonnet');
    await click(trigger);
    const high = await waitForElement(container, '[data-execution-effort="high"]');
    await click(high);
    await settle();

    expect(getExecutorModels).toHaveBeenCalled();
    expect(listModels).toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).not.toContain('Switch to');
    expect(container.textContent).not.toContain('This engine did not report its models.');
    expect(container.textContent).not.toContain('Could not validate choices');
    const titles = [...container.querySelectorAll<HTMLElement>('[title]')].map((el) => el.title).join('\n');
    expect(titles).not.toContain('This engine did not report its models.');
    expect(trigger.textContent).toContain('vendor/sonnet');
    expect(trigger.textContent).toContain('high');
    expect(trigger.textContent).not.toContain('medium');

    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = submissionOf(sendPrompt.mock.calls[0]?.[0]);
    expect(submission.thinking).toBe('high');
    expect(submission.execution).toBeUndefined();
    expect(submission.model).toBeUndefined();
    expect(submission.profile).toBeUndefined();
  }, 60_000);

  it('sends null when Default clears an external thinking override', async () => {
    fixture.model = undefined;
    listModels.mockResolvedValue({ items: [] });
    fixture.session = {
      workspace_id: 'wd_alpha',
      title: 'Release prep',
      executor_id: 'claude-acp',
      agent_config: {
        profile: 'agent',
        execution: {
          version: 1,
          selection: { executor: 'claude-acp', overrides: { model: 'vendor/sonnet', thinking: 'medium' } },
          effective: { model: 'vendor/sonnet', thinking: 'medium', kiki_context: [], allow_kiki_subagents: false },
          sources: {},
          generation: 1,
        },
      },
      metadata: {},
    } as unknown as Session;

    const { container } = await mount();
    await click(await waitForElement(container, '#composer-execution-select'));
    await click(await waitForElement(container, '[data-execution-effort=""]'));
    await settle();

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).not.toContain('Switch to');
    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    const submission = submissionOf(sendPrompt.mock.calls[0]?.[0]);
    expect(submission.thinking).toBeNull();
    expect(submission.execution).toBeUndefined();
    expect(submission.model).toBeUndefined();
    expect(submission.profile).toBeUndefined();
  }, 60_000);
});

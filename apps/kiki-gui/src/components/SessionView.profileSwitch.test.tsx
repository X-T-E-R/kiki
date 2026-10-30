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
import { resolveCompiledGuiStylesheet } from '../testSupport/compiledGuiStylesheet';

const { listNamedAgentProfiles, listModels, sendPrompt, submitPrompt, steerQueued, sendPromptNow, promptResult, fixture, abort, getExecutorModels } = vi.hoisted(() => ({
  listNamedAgentProfiles: vi.fn(),
  listModels: vi.fn(),
  sendPrompt: vi.fn(),
  submitPrompt: vi.fn(),
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
    private readonly sender = new actual.SessionController(
      { submitPrompt } as unknown as ConstructorParameters<typeof actual.SessionController>[0],
      {} as ConstructorParameters<typeof actual.SessionController>[1],
      'session-a',
      { ephemeral: true },
    );
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
    close() { this.sender.close(); }
    getForest() { return actual.buildAgentForest([], []); }
    retainHistoryRead() { return () => {}; }
    async sendPrompt(input: unknown) {
      const result = await sendPrompt(input);
      await this.sender.sendPrompt(input as Parameters<typeof this.sender.sendPrompt>[0]);
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
  submitPrompt.mockReset().mockImplementation(async (_sessionId, request) => ({
    ...promptResult.current, prompt_id: request.prompt_id, user_message_id: 'user-next',
    content: request.content, created_at: '2026-10-20T00:00:00.000Z',
  }));
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
  it('keeps the chip browsable mid-run, applies the pick at once, and the undo toast restores the prior controls', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    expect(profileRow(container, 'reviewer')).toBeDefined();
    await click(profileRow(container, 'reviewer'));

    // No confirmation: the switch is reversible, so it applies immediately and
    // the running turn is untouched.
    expect(ui(container).querySelector('[role="alertdialog"]')).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    // Pending is shown as pending, in words, not as already-applied.
    expect(profileTrigger(container)?.textContent).toContain('next message');

    // The undo toast restores the live binding's controls.
    const toast = getToasts().find((entry) => entry.undo !== undefined);
    expect(toast?.text).toContain('Switched to');
    await act(async () => { await toast!.undo!.run(); });
    await settle();
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
  });

  it('re-picking the live profile after an applied switch drops the pending controls', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    // Applied at once, no dialog, toast shown.
    expect(ui(container).querySelector('[role="alertdialog"]')).toBeNull();
    expect(profileTrigger(container)?.textContent).toContain('next message');

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'agent'));
    expect(profileTrigger(container)?.textContent).toContain('Kiki');
    expect(profileTrigger(container)?.textContent).not.toContain('next message');

    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('sends the applied profile on the next user message and never into the running turn', async () => {
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));

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

    await sendNextMessage(container);

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(steerQueued).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(getToasts().some((toast) => toast.tone === 'error')).toBe(false);
  });

  it('explains a Send now that has to open its own turn instead of queueing silently', async () => {
    promptResult.current = { status: 'queued', prompt_id: 'prompt-queued' };
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await type('continue with the chosen profile', container);
    await act(async () => {
      composerInput(container)?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, shiftKey: settingsSnapshot().sendShortcut !== 'enter', bubbles: true,
      }));
    });
    await settle();
    await settle();
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPromptNow).not.toHaveBeenCalled();
    expect(steerQueued).not.toHaveBeenCalled();
    const texts = getToasts().map((toast) => toast.text);
    expect(texts.some((text) => text.includes('needs its own turn'))).toBe(true);
    // The binding change — not a turn that happened to end — is the reason.
    expect(texts.some((text) => text.includes('The turn ended first'))).toBe(false);
  });

  it('keeps the pick for a retry when the send fails on the network', async () => {
    sendPrompt.mockRejectedValueOnce(new Error('offline'));
    const { container } = await mount();
    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));

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

    // Ordinary busy baseline: the plain queue name, a real send-now row, and
    // the key-teaching hint on the working line.
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter)');
    expect(ui(container).querySelector('[data-composer-send-now-hint]')?.textContent)
      .toContain('sends now');
    await openTimingMenu();
    expect(ui(container).querySelector('[data-send-timing="now"]')).not.toBeNull();
    await closeTimingMenu();

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'reviewer'));
    await settle();

    // Pending switch: the button title names the consequence and the timing
    // menu lists only the choices that exist (no send-now row). The visible
    // hint leaves the working line rather than promise "sends now". The key
    // itself still works — into the queue, carrying the switch.
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter) — the pending switch applies with this message');
    expect(ui(container).querySelector('[data-composer-send-now-hint]')).toBeNull();
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
    await settle();
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter) — the pending switch applies with this message');
    expect(ui(container).querySelector('[data-composer-send-now-hint]')).toBeNull();

    await click(profileTrigger(container));
    await settle();
    await click(profileRow(container, 'agent'));
    await settle();
    expect(sendButton()?.getAttribute('title')).toBe('Queue this prompt (Enter)');
    expect(ui(container).querySelector('[data-composer-send-now-hint]')?.textContent)
      .toContain('sends now');
  });
});

function catalogModel(id: string, displayName: string) {
  return { id, provider_id: 'fixture', remote_id: id, display_name: displayName, max_context_size: 128000,
    support_efforts: ['low', 'medium', 'high'], default_effort: 'medium' };
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
  beforeEach(() => {
    fixture.model = 'fixture/live-model';
    listModels.mockResolvedValue({
      items: [catalogModel('fixture/live-model', 'Live'), catalogModel('fixture/other-model', 'Other')],
    });
  });

  async function pickModel(container: HTMLElement, model = 'fixture/other-model') {
    await click(await waitForElement(container, '#composer-execution-select'));
    await click(await waitForElement(container, `[data-execution-model="${model}"]`));
    await settle();
  }

  it('asks only about the model, confirms once and sends that target without rebinding the engine', async () => {
    const { container } = await mount();
    await pickModel(container);
    expect(container.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialogButton(container, 'Switch engine')).toBeUndefined();
    expect(container.querySelector('[data-model-switch-mode]')).not.toBeNull();
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
    expect(container.querySelector('[data-runtime-controls-pending]')).toBeNull();
    expect(sendPrompt).not.toHaveBeenCalled();

    await click(dialogButton(container, 'Switch when idle'));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(profileTrigger(container)?.textContent).toContain('next message');
    expect(container.querySelector('#composer-execution-select')?.textContent).toContain('Other');
    expect(container.querySelector('#composer-execution-select')?.textContent).not.toContain('next message');
    expect(container.querySelectorAll('[data-execution-cancel-pending]')).toHaveLength(1);
    expect(container.querySelector('[data-runtime-controls-pending]')).toBeNull();

    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[0]).toMatchObject({ model: 'fixture/other-model', modelSwitchMode: 'direct' });
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt.mock.calls[0]?.[1]).toMatchObject({ model: 'fixture/other-model', model_switch_mode: 'direct' });
    expect(submitPrompt.mock.calls[0]?.[1].execution).toBeUndefined();
    expect(submitPrompt.mock.calls[0]?.[1].thinking).toBeUndefined();
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toBeUndefined();
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).thinking).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });

  it('cancels before confirmation without creating any pending controls or changing the next request', async () => {
    const { container } = await mount();
    await pickModel(container);
    await click(dialogButton(container, 'Cancel'));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
    expect(container.querySelector('[data-execution-cancel-pending]')).toBeNull();
    expect(container.querySelector('#composer-execution-select')?.textContent).not.toContain('Other');
    await sendNextMessage(container);
    const submission = submissionOf(sendPrompt.mock.calls[0]?.[0]);
    expect(submission.model).toBeUndefined();
    expect(submission.thinking).toBeUndefined();
    expect(submission.execution).toBeUndefined();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt.mock.calls[0]?.[1].model).toBeUndefined();
    expect(submitPrompt.mock.calls[0]?.[1].thinking).toBeUndefined();
    expect(submitPrompt.mock.calls[0]?.[1].execution).toBeUndefined();
  });

  it('cancels the confirmed transaction and renders reselection without retaining a target or a second dialog', async () => {
    const { container } = await mount();
    await pickModel(container);
    const confirmFrame = container.innerHTML;
    await click(dialogButton(container, 'Switch when idle'));
    const pendingFrame = container.innerHTML;
    await click(container.querySelector('[data-execution-cancel-pending]'));
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
    expect(container.querySelector('#composer-execution-select')?.textContent).not.toContain('Other');
    const cancelledFrame = container.innerHTML;
    await pickModel(container);
    expect(container.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    const reselectedFrame = container.innerHTML;
    await click(dialogButton(container, 'Cancel'));
    await sendNextMessage(container);
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).model).toBeUndefined();
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toBeUndefined();
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).thinking).toBeUndefined();

    for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
    const directory = join(EFFORT_SHOT_DIR, '..', 'switch-transaction');
    const { cssPath } = resolveCompiledGuiStylesheet();
    await mkdir(directory, { recursive: true });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ args: ['--no-proxy-server'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
      for (const [name, frame] of Object.entries({ confirm: confirmFrame, pending: pendingFrame, cancelled: cancelledFrame, reselected: reselectedFrame })) {
        await page.setContent('<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body class="bg-canvas text-ink">' + frame + '</body></html>');
        await page.addStyleTag({ path: cssPath });
        await page.evaluate(() => {
          for (const animation of document.getAnimations()) {
            if (animation.effect?.getComputedTiming().iterations === Infinity) animation.pause();
            else animation.finish();
          }
        });
        expect(await page.locator('[role="alertdialog"]').count()).toBe(name === 'confirm' || name === 'reselected' ? 1 : 0);
        expect(await page.locator('[data-execution-cancel-pending]').count()).toBe(name === 'pending' ? 1 : 0);
        await page.screenshot({ path: join(directory, `${name}.png`) });
        await writeFile(join(directory, `${name}.html`), frame);
      }
      await writeFile(join(directory, 'calltrace.json'), JSON.stringify({ sendPrompt: sendPrompt.mock.calls, submitPrompt: submitPrompt.mock.calls, sendPromptNow: sendPromptNow.mock.calls, abort: abort.mock.calls }, null, 2));
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps a confirmed compact model switch on its next turn even with Send now', async () => {
    promptResult.current = { status: 'queued', prompt_id: 'prompt-queued' };
    const { container } = await mount();
    await pickModel(container);
    await click(container.querySelector('[data-model-switch-mode="compact"]'));
    await click(dialogButton(container, 'Switch when idle'));
    await type('continue on the new model', container);
    await act(async () => {
      composerInput(container)?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, shiftKey: settingsSnapshot().sendShortcut !== 'enter', bubbles: true,
      }));
    });
    await settle();
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt.mock.calls[0]?.[1]).toMatchObject({ model: 'fixture/other-model', model_switch_mode: 'compact' });
    expect(sendPromptNow).not.toHaveBeenCalled();
    expect(steerQueued).not.toHaveBeenCalled();
  });

  it('keeps an earlier confirmed model when a replacement is cancelled', async () => {
    listModels.mockResolvedValue({ items: [catalogModel('fixture/live-model', 'Live'), catalogModel('fixture/other-model', 'Other'), catalogModel('fixture/third-model', 'Third')] });
    const { container } = await mount();
    await pickModel(container);
    await click(dialogButton(container, 'Switch when idle'));
    await pickModel(container, 'fixture/third-model');
    await click(dialogButton(container, 'Cancel'));
    expect(container.querySelector('#composer-execution-select')?.textContent).toContain('Other');
    await sendNextMessage(container);
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).model).toBe('fixture/other-model');
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toBeUndefined();
  });

  it('sends the confirmed model even when the live native binding contains an older model override', async () => {
    fixture.session = { ...fixture.session!, agent_config: { ...fixture.session!.agent_config, execution: {
      version: 1, selection: { executor: 'native', profile: 'agent', overrides: { model: 'fixture/live-model' } },
      effective: { model: 'fixture/live-model', kiki_context: [], allow_kiki_subagents: false }, sources: {}, generation: 1,
    } } } as Session;
    const { container } = await mount();
    await pickModel(container);
    await click(dialogButton(container, 'Switch when idle'));
    await sendNextMessage(container);
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).model).toBe('fixture/other-model');
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toBeUndefined();
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

  it('cancels a pinned profile and restores the live display and request', async () => {
    const { container } = await mount();
    await chooseProfile(container, 'pinned');
    expect(container.querySelector('#composer-execution-select')?.textContent).toContain('Pinned');
    await click(container.querySelector('[data-execution-cancel-pending]'));
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
    expect(container.querySelector('#composer-execution-select')?.textContent).not.toContain('Pinned');
    await sendNextMessage(container);
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toBeUndefined();
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).model).toBeUndefined();
  });

  it('replaces a pinned pending profile with an unpinned one without leaking the previous pin', async () => {
    const { container } = await mount();
    await chooseProfile(container, 'pinned');
    await chooseProfile(container, 'open');
    expect(container.querySelector('#composer-execution-select')?.textContent).not.toContain('Pinned');
    await sendNextMessage(container);
    const submission = submissionOf(sendPrompt.mock.calls[0]?.[0]);
    expect(submission.execution).toMatchObject({ executor: 'native', profile: 'open' });
    expect(submission.execution?.overrides?.model).toBeUndefined();
    expect(submission.model).toBeUndefined();
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

describe('returning from an external engine to native Kiki', () => {
  it('uses the native profile contract, cancels without a rebind and confirms on the next pick', async () => {
    fixture.session = { ...fixture.session!, executor_id: 'claude-acp', agent_config: { ...fixture.session!.agent_config, execution: {
      version: 1, selection: { executor: 'claude-acp', overrides: { model: 'vendor/sonnet' } },
      effective: { model: 'vendor/sonnet', kiki_context: [], allow_kiki_subagents: false }, sources: {}, generation: 1,
    } } } as Session;
    const { container } = await mount();
    const pickNative = async () => {
      await click(profileTrigger(container));
      await click(await waitForElement(container, '[data-execution-bare="native"]'));
    };
    await pickNative();
    expect(container.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('The agent profile supplies Kiki’s prompt, tools and context');
    expect(dialog?.textContent).toContain('Kiki continues with this conversation’s context');
    expect(dialog?.textContent).not.toContain('no Kiki profile');
    expect(dialog?.textContent).not.toContain('does not hand it the old conversation');
    await click(dialogButton(container, 'Cancel'));
    expect(profileTrigger(container)?.textContent).not.toContain('next message');
    expect(container.querySelector('#composer-execution-select')?.textContent).toContain('vendor/sonnet');
    expect(sendPrompt).not.toHaveBeenCalled();
    await pickNative();
    await click(dialogButton(container, 'Switch engine'));
    await sendNextMessage(container);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).execution).toEqual({ executor: 'native', profile: 'agent' });
    expect(submissionOf(sendPrompt.mock.calls[0]?.[0]).model).toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });
});

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

    // The painted colour below is resolved from the compiled tokens, so the
    // proof needs the build: a missing stylesheet fails here instead of passing
    // the class checks without the colour they stand for.
    const { cssPath } = resolveCompiledGuiStylesheet();

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
      await page.addStyleTag({ path: cssPath });
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
        stylesheet: cssPath,
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

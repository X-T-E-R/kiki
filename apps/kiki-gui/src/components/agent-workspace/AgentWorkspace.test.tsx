// @vitest-environment jsdom
import { act, createRef, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { translate } from '@kiki/session-core/i18n';
import { buildAnnotationsPrefix } from '@kiki/session-core/composer';
import {
  createViewState,
  SendNowError,
  type AgentForest,
  type AgentTreeNode,
  type SessionController,
} from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { ExternalAgentAttachmentUnsupportedError, NativeChildPromptConflictError, NativeChildPromptSendError } from '../../lib/client';
import type { MediaPreviewApi } from '../mediaPreviewContext';
import { AgentTreeView } from '../AgentTreeView';
import { AgentWorkspace } from './AgentWorkspace';

const harness = vi.hoisted(() => ({
  header: null as HTMLElement | null,
  dock: null as HTMLElement | null,
  shellEnabled: true,
  scopeId: 'direct:one',
  listModels: vi.fn(),
  sendAgentMessage: vi.fn(),
  isNativeAgent: vi.fn(),
  stopAgentTask: vi.fn(),
  setAgentModel: vi.fn(),
  setAgentEffort: vi.fn(),
  readCapabilities: vi.fn(),
  listSessionSkills: vi.fn(),
  pushToast: vi.fn(),
  mediaProviderProps: [] as Array<{ apiRef?: unknown }>,
  host: { kind: 'browser' } as {
    kind: string;
    pickFiles?: () => Promise<Array<{ name: string; size: number; type: string; read(): Promise<File> }> | null>;
  },
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    scopeId: harness.scopeId,
    client: {
      listModels: harness.listModels,
      getAgentCapabilities: harness.readCapabilities,
      listSessionSkills: harness.listSessionSkills,
      sendAgentMessage: harness.sendAgentMessage,
      isNativeAgent: harness.isNativeAgent,
      stopAgentTask: harness.stopAgentTask,
      setAgentModel: harness.setAgentModel,
      setAgentEffort: harness.setAgentEffort,
    },
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) =>
            harness.readCapabilities(query, options.signal),
        },
      },
    },
  }),
}));

vi.mock('../ConversationShell', () => ({
  EMPTY_SLOTS: { header: null, dock: null, heroFooter: null, rail: null, footer: null, preview: null },
  useOptionalConversationShell: () =>
    harness.shellEnabled
      ? {
          slots: {
            header: harness.header,
            dock: harness.dock,
            heroFooter: null,
            rail: null,
            footer: null,
            preview: null,
          },
        }
      : null,
}));
vi.mock('../ActivityHistory', () => ({ revealSubagentCard: () => true }));
vi.mock('../AgentBreadcrumb', () => ({ AgentBreadcrumb: () => null, AgentRelations: () => null }));
vi.mock('../mediaPreview', () => ({
  MediaPreviewProvider: (props: { children?: ReactNode; apiRef?: unknown }) => {
    harness.mediaProviderProps.push(props);
    return props.children;
  },
  PreviewToggleButton: () => <div data-preview-toggle-probe />,
}));
vi.mock('../RightRail', () => ({ RightRail: () => null }));
vi.mock('../../host', () => ({ useHost: () => harness.host }));
vi.mock('../../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: { preparePrompt: vi.fn() } }));
vi.mock('../Transcript', () => ({ Transcript: ({ state, agentId }: { state: { blocks: readonly unknown[] }; agentId?: string }) =>
  <div data-timeline-agent={agentId ?? 'main'} data-timeline-blocks={state.blocks.length} /> }));
vi.mock('./ResyncStatusBanner', () => ({ ResyncStatusBanner: () => null }));
vi.mock('../../lib/toasts', () => ({ pushToast: harness.pushToast }));

let root: Root;
let container: HTMLDivElement;
let header: HTMLDivElement;
let dock: HTMLDivElement;
let queries: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.listModels.mockResolvedValue({ items: [] });
  harness.readCapabilities.mockResolvedValue({
    context: 'live',
    owner: { profile: 'general', agent_id: 'child' },
    available: true,
    profile: { name: 'general' },
    targets: [],
    tools: [],
    skills: [],
    metrics: {},
  });
  harness.shellEnabled = true;
  harness.isNativeAgent.mockResolvedValue(true);
  harness.scopeId = 'direct:one';
  harness.host = { kind: 'browser' };
  harness.mediaProviderProps.length = 0;
  harness.listSessionSkills.mockResolvedValue({ skills: [] });
  harness.listModels.mockResolvedValue({ items: [
    { id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro' },
    { id: 'fixture/other', provider_id: 'fixture', remote_id: 'other' },
  ] });
  container = document.createElement('div');
  header = document.createElement('div');
  dock = document.createElement('div');
  document.body.append(container, header, dock);
  harness.header = header;
  harness.dock = dock;
  root = createRoot(container);
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queries.clear();
  harness.header = null;
  container.remove();
  header.remove();
  dock.remove();
  harness.dock = null;
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function typeText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('keeps dispatch policy out of the workspace header and mounts the shared composer', async () => {
  harness.readCapabilities.mockResolvedValue({
    context: 'live',
    owner: { profile: 'general', agent_id: 'child' },
    available: true,
    profile: { name: 'general', subagent_policy: 'strict' },
    targets: [],
    tools: [],
    skills: [],
    metrics: {},
  });
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: ['child'],
  };
  const child: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'general', label: 'General',
    status: 'completed', busy: false, toolCallCount: 0, childIds: [],
  };
  const forest: AgentForest = { roots: [main], byId: { main, child } };
  const sessionState = { ...createViewState('session'), loaded: true };

  await act(async () => root.render(
    <QueryClientProvider client={queries}>
      <I18nProvider>
        <MemoryRouter>
          <AgentWorkspace
          target={{ sessionId: 'session', agentId: 'child' }}
          controller={null}
          sessionState={sessionState}
          forest={forest}
          navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
          railOpen={false}
          railIsOverlay={false}
          onToggleRail={vi.fn()}
          onCloseRail={vi.fn()}
          onCancelTask={vi.fn()}
          onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
          previewApiRef={createRef<MediaPreviewApi>()}
        />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ));
  await settle();

  expect(harness.readCapabilities).toHaveBeenCalledExactlyOnceWith({ session_id: 'session', agent_id: 'child' });
  expect(header.querySelector('[data-dispatch-policy]')).toBeNull();
  expect(header.querySelector('[data-recommendation-status]')).toBeNull();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).not.toBeNull();
});

it('enables running fullscreen composer send, model switch, and stop', async () => {
  harness.sendAgentMessage.mockResolvedValue({});
  harness.setAgentModel.mockResolvedValue(undefined);
  harness.stopAgentTask.mockResolvedValue(undefined);
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'next step');
  await settle();
  expect(textarea.value).toBe('next step');
  // Busy child: the button sends into the running turn (there is no queue strip to park in).
  const sendButton = dock.querySelector<HTMLButtonElement>('[aria-label="Send into this turn"]');
  expect(sendButton?.disabled).toBe(false);
  await act(async () => { sendButton?.click(); });
  await settle();
  // No controller to steer through: falls back to the mailbox path.
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String));
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  expect(modelSelect.disabled).toBe(false);
  await act(async () => { modelSelect.click(); });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
  });
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Abort the running prompt"]')?.click(); });
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'main', 'task-1');
});

async function sendNowToBusyChild(
  sendPromptNow: ReturnType<typeof vi.fn>,
): Promise<HTMLTextAreaElement> {
  const controller = Object.assign(
    controllerStub({ forest: testForest('running', true), agentStates: {} }),
    { sendPromptNow },
  );
  await renderWorkspace({ controller, forest: testForest('running', true) });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'look at the tests too');
  await settle();
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send into this turn"]')?.click(); });
  await settle();
  return textarea;
}

it('steers a busy native child through the shared send-now ledger, not its mailbox', async () => {
  const sendPromptNow = vi.fn().mockResolvedValue({ promptId: 'p', outcome: 'steered' });
  const textarea = await sendNowToBusyChild(sendPromptNow);
  expect(sendPromptNow).toHaveBeenCalledWith({
    agentId: 'child', text: 'look at the tests too', content: [{ type: 'text', text: 'look at the tests too' }],
  });
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(textarea.value).toBe('');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('hands a refused child send-now back to the composer with the reason', async () => {
  const sendPromptNow = vi.fn().mockRejectedValue(new SendNowError('refused', new Error('model differs')));
  const textarea = await sendNowToBusyChild(sendPromptNow);
  expect(textarea.value).toBe('look at the tests too');
  expect(harness.pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
});

it('keeps an external-executor child on its mailbox when sending into a busy turn', async () => {
  harness.isNativeAgent.mockResolvedValue(false);
  harness.sendAgentMessage.mockResolvedValue({});
  const sendPromptNow = vi.fn();
  await sendNowToBusyChild(sendPromptNow);
  expect(sendPromptNow).not.toHaveBeenCalled();
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'look at the tests too', [
    { type: 'text', text: 'look at the tests too' },
  ], expect.any(String));
});

/** Minimal durable-mailbox acceptance returned by `client.sendAgentMessage`. */
function mailboxReceipt(overrides: {
  delivery: 'queued' | 'delivered';
  resumed?: boolean;
  deduplicated?: boolean;
  payloadConflict?: boolean;
}) {
  return {
    message: {
      messageId: 'message-1', sessionId: 'session', sourceAgentId: 'main', sourceTaskName: 'user',
      senderKind: 'user' as const, targetAgentId: 'child', targetTaskName: 'child',
      content: 'next step', acceptedAt: 1, targetSeq: 1,
    },
    deduplicated: overrides.deduplicated ?? false,
    payloadConflict: overrides.payloadConflict ?? false,
    delivery: overrides.delivery,
    resumed: overrides.resumed,
  };
}

async function sendFromComposer(text: string): Promise<HTMLTextAreaElement> {
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, text);
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Queue prompt"]')?.click();
  });
  await settle();
  return textarea;
}

it('toasts a queued mailbox receipt and clears the draft once the send settles', async () => {
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'queued' }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String));
  // A queued message reads as informational, not as a fresh delivery.
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.pending'),
  });
  expect(textarea.value).toBe('');
});

it('marks a delivered mailbox receipt that resumed the agent', async () => {
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'delivered', resumed: true }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  await sendFromComposer('next step');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'success',
    text: `${translate('en', 'agentMessage.delivered')} · ${translate('en', 'subagent.event.resumed')}`,
  });
});

it('presents a deduplicated receipt as already accepted, not as a fresh delivery', async () => {
  // The mailbox already held an equivalent message, so a queued delivery state
  // must not leak through as this send having queued a new prompt.
  harness.sendAgentMessage.mockResolvedValue(mailboxReceipt({ delivery: 'queued', deduplicated: true }));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.deduplicated'),
  });
  expect(harness.pushToast).not.toHaveBeenCalledWith({
    tone: 'info',
    text: translate('en', 'agentMessage.pending'),
  });
  expect(textarea.value).toBe('');
});

it('fails closed on a payload conflict and keeps the draft instead of reading as delivered', async () => {
  harness.sendAgentMessage.mockResolvedValue(
    mailboxReceipt({ delivery: 'delivered', payloadConflict: true }),
  );
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  // The current text was not accepted: report it, never claim a delivery, and
  // never clear the draft.
  expect(harness.pushToast).not.toHaveBeenCalled();
  expect(textarea.value).toBe('next step');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.payloadConflict'));
  const conflictedKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(conflictedKey);
  expect(textarea.value).toBe('next step');
});

it('sends a native child without faking a mailbox receipt', async () => {
  // A native child keeps the prompt route; the composer must not invent a
  // queued/delivered receipt for a delivery it cannot observe.
  harness.sendAgentMessage.mockResolvedValue(null);
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'next step', [
    { type: 'text', text: 'next step' },
  ], expect.any(String));
  expect(harness.pushToast).not.toHaveBeenCalled();
  expect(textarea.value).toBe('');
});

it('keeps the draft and raises no receipt when the mailbox send rejects', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('mailbox unavailable'));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(harness.pushToast).not.toHaveBeenCalled();
  // The rejected send never reached the clear step, so the draft survives.
  expect(textarea.value).toBe('next step');
});

async function clickComposerSend() {
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[aria-label="Send message"], [aria-label="Queue prompt"]')?.click();
  });
  await settle();
}

it('reuses one pending submission after a lost response, then releases it for an independent send', async () => {
  const accepted = new Map<string, string>();
  harness.sendAgentMessage.mockImplementation(async (_session: string, _agent: string, text: string, _content: unknown, key: string) => {
    if (typeof key !== 'string' || key.length === 0) throw new Error('missing idempotency key');
    const previous = accepted.get(key);
    if (previous !== undefined) return mailboxReceipt({ delivery: 'queued', deduplicated: true });
    accepted.set(key, text); // server accepted durably before the response was lost
    if (accepted.size === 1) throw new Error('response lost after accept');
    return mailboxReceipt({ delivery: 'queued' });
  });
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(textarea.value).toBe('next step');
  expect(accepted.size).toBe(1);
  await clickComposerSend();
  expect(accepted.size).toBe(1);
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
  expect(textarea.value).toBe('');
  expect(harness.pushToast).toHaveBeenCalledWith({ tone: 'info', text: translate('en', 'agentMessage.deduplicated') });
  await sendFromComposer('next step');
  expect(accepted.size).toBe(2);
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
});

it('replays a lost native prompt response under the same key without a mailbox delivery toast', async () => {
  const accepted = new Map<string, string>();
  harness.sendAgentMessage.mockImplementation(async (_session: string, _agent: string, text: string, _content: unknown, key: string) => {
    const previous = accepted.get(key);
    if (previous !== undefined) {
      if (previous !== text) throw new NativeChildPromptConflictError(new Error('prompt.id_conflict'));
      return null; // Replay of the native prompt receipt, not a mailbox receipt.
    }
    accepted.set(key, text);
    throw new NativeChildPromptSendError(new Error('response lost after native prompt acceptance'));
  });
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  expect(textarea.value).toBe('next step');
  expect(dock.querySelector('[role="alert"]')?.textContent).toBe(translate('en', 'agentMessage.promptOutcomeUnknown'));
  await clickComposerSend();
  expect(accepted.size).toBe(1);
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
  expect(textarea.value).toBe('');
  expect(dock.querySelector('[role="alert"]')).toBeNull();
  expect(harness.pushToast).not.toHaveBeenCalled();
  await sendFromComposer('independent step');
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[0]?.[4]);
});

it('keeps an ambiguous native conflict pending until an explicit edited send uses a new key', async () => {
  harness.sendAgentMessage.mockRejectedValueOnce(new NativeChildPromptConflictError(new Error('prompt.id_conflict')))
    .mockRejectedValueOnce(new NativeChildPromptConflictError(new Error('accepted without replayable receipt')))
    .mockResolvedValueOnce(null);
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  expect(textarea.value).toBe('next step');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.promptOutcomeUnknown'));
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(firstKey);
  expect(textarea.value).toBe('next step');
  await typeText(textarea, 'different step');
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(firstKey);
  expect(textarea.value).toBe('');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('retains attached draft on unknown native outcome and does not disguise an external rejection', async () => {
  harness.sendAgentMessage.mockRejectedValueOnce(new Error('response lost after attachment acceptance'))
    .mockRejectedValueOnce(new ExternalAgentAttachmentUnsupportedError());
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace();
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'inspect');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.click(); });
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  expect(textarea.value).toBe('inspect');
  expect(dock.textContent).toContain(translate('en', 'agentMessage.attachmentOutcomeUnknown'));
  expect(harness.pushToast).not.toHaveBeenCalled();
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).toBe(firstKey);
  expect(dock.textContent).toContain('External agent messages support text only');
  expect(dock.textContent).not.toContain(translate('en', 'agentMessage.attachmentOutcomeUnknown'));
});

it('starts a new submission after an edit, even when undo restores the original text', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  await renderWorkspace();
  await settle();
  const textarea = await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await typeText(textarea, 'revised');
  await sendFromComposer('next step');
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).not.toBe(firstKey);
  await sendFromComposer('new step');
  expect(harness.sendAgentMessage.mock.calls[2]?.[4]).not.toBe(harness.sendAgentMessage.mock.calls[1]?.[4]);
});

it('isolates pending submissions across connection, session, and target switches', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  await renderWorkspace();
  await settle();
  await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  harness.scopeId = 'direct:two';
  await renderWorkspace();
  await clickComposerSend();
  const secondKey = harness.sendAgentMessage.mock.calls[1]?.[4];
  expect(secondKey).not.toBe(firstKey);
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'child' } });
  await clickComposerSend();
  const thirdKey = harness.sendAgentMessage.mock.calls[2]?.[4];
  expect(thirdKey).not.toBe(secondKey);
  const main = testForest().roots[0]!;
  const other: AgentTreeNode = { ...testForest().byId['child']!, agentId: 'other', name: 'other' };
  await renderWorkspace({ target: { sessionId: 'other-session', agentId: 'other' }, forest: {
    roots: [main], byId: { ...testForest().byId, other },
  } });
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[3]?.[4]).not.toBe(thirdKey);
  expect(harness.sendAgentMessage.mock.calls[3]?.slice(0, 2)).toEqual(['other-session', 'other']);
});

it('changes the pending submission key when attachment payload changes', async () => {
  harness.sendAgentMessage.mockRejectedValue(new Error('response lost'));
  harness.host = { kind: 'browser', pickFiles: async () => [{
    name: 'shot.png', size: 1, type: 'image/png',
    read: async () => new File(['x'], 'shot.png', { type: 'image/png' }),
  }] };
  await renderWorkspace();
  await settle();
  await sendFromComposer('next step');
  const firstKey = harness.sendAgentMessage.mock.calls[0]?.[4];
  await act(async () => { dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.click(); });
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).not.toBeNull();
  await clickComposerSend();
  expect(harness.sendAgentMessage.mock.calls[1]?.[4]).not.toBe(firstKey);
  expect(harness.sendAgentMessage.mock.calls[1]?.[3]).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'image' }),
  ]));
});

it('does not erase an edited draft when the in-flight receipt finally arrives', async () => {
  let resolveSend: (receipt: ReturnType<typeof mailboxReceipt>) => void = () => undefined;
  harness.sendAgentMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
  await renderWorkspace();
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await typeText(textarea, 'next step');
  await clickComposerSend();
  expect(harness.sendAgentMessage).toHaveBeenCalledTimes(1);
  await typeText(textarea, 'edited while sending');
  await act(async () => { resolveSend(mailboxReceipt({ delivery: 'queued' })); });
  await settle();
  expect(textarea.value).toBe('edited while sending');
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it.each([false, true])('updates a mounted child tree and composer after send and settlement (preview=%s)', async (preview) => {
  harness.sendAgentMessage.mockResolvedValue({});
  const listeners = new Set<() => void>();
  let sessionState = { ...createViewState('session'), loaded: true };
  let childState = { ...createViewState('session'), loaded: true };
  let forest = testForest('completed');
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const controller = {
    subscribe,
    subscribeAgent: (_agentId: string, listener: () => void) => subscribe(listener),
    getState: () => sessionState,
    getAgentState: () => childState,
    getForest: () => forest,
  } as unknown as SessionController;
  function MountedWorkspace() {
    const state = useSyncExternalStore(subscribe, () => sessionState);
    return <>
      <AgentTreeView forest={forest} selectedAgentId="child" onOpen={vi.fn()} />
      <AgentWorkspace
        target={{ sessionId: 'session', agentId: 'child' }}
        controller={controller} sessionState={state} forest={forest}
        navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
        railOpen={false} railIsOverlay={preview} onToggleRail={vi.fn()} onCloseRail={vi.fn()}
        onCancelTask={vi.fn()} onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
        inheritMediaPreview={preview} showBreadcrumb={!preview} showPreviewToggle={!preview}
        slots={preview ? { header, dock, rail: null, heroFooter: null, footer: null, preview: null } : undefined}
      />
    </>;
  }
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><MemoryRouter>
      <MountedWorkspace />
    </MemoryRouter></I18nProvider></QueryClientProvider>,
  ));
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  const statusText = () => container.querySelector('[data-agent-id="child"]')?.textContent;
  expect(statusText()).toContain(translate('en', 'subagent.status.completed'));
  expect(dock.querySelector('[aria-label="Abort the running prompt"]')).toBeNull();
  await typeText(textarea, 'continue');
  await act(async () => { dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click(); });
  expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'continue', [{ type: 'text', text: 'continue' }], expect.any(String));
  const publishStatus = async (status: 'background' | 'completed') => {
    const busy = status === 'background';
    await act(async () => {
      forest = testForest(status, busy);
      childState = { ...childState, busy };
      sessionState = { ...sessionState, tasks: [{
        id: 'new-run-task', session_id: 'session', kind: 'subagent', status: busy ? 'running' : 'completed',
        description: 'Follow-up', agent_id: 'child', created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z',
      }] };
      for (const listener of listeners) listener();
    });
    await settle();
  };
  for (const status of ['background', 'completed'] as const) {
    const busy = status === 'background';
    await publishStatus(status);
    expect(statusText()).toContain(translate('en', `subagent.status.${status}`));
    expect(container.querySelector('[data-agent-id="child"] .status-dot-busy') !== null).toBe(busy);
    expect(dock.querySelector('[aria-label="Abort the running prompt"]') !== null).toBe(busy);
    expect(dock.querySelector('textarea[data-composer]')).toBe(textarea);
    expect(textarea.disabled).toBe(false);
    expect(header.querySelector('h1')?.textContent).toBe('General');
  }
});

it.each(['completed', 'cancelled', 'failed'] as const)(
  'keeps terminal %s composer sendable and model-switchable',
  async (status) => {
    harness.sendAgentMessage.mockResolvedValue({});
    harness.setAgentModel.mockResolvedValue(undefined);
    await renderWorkspace({ forest: testForest(status) });
    await settle();
    const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(textarea.disabled).toBe(false);
    expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(false);
    expect(dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.disabled).toBe(false);
    await typeText(textarea, 'wake up');
    await settle();
    const sendButton = dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(false);
    await act(async () => { sendButton?.click(); });
    expect(harness.sendAgentMessage).toHaveBeenCalledWith('session', 'child', 'wake up', [
      { type: 'text', text: 'wake up' },
    ], expect.any(String));
    const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
    await act(async () => { modelSelect.click(); });
    await act(async () => {
      dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
    });
    expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
    // A closed child owns no running task, so the stop control stays unmounted.
    expect(dock.querySelector('[aria-label="Abort the running prompt"]')).toBeNull();
  },
);

it('toasts a failed model change and leaves the live model selected', async () => {
  harness.setAgentModel.mockRejectedValue(new Error('agent restore failed'));
  await renderWorkspace({ forest: testForest('completed') });
  await settle();
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  const before = modelSelect.textContent;
  await act(async () => { modelSelect.click(); });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[role="option"][data-option-value="fixture/other"]')?.click();
  });
  await settle();
  expect(harness.setAgentModel).toHaveBeenCalledWith('session', 'child', 'fixture/other');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'subagent.modelChangeFailed', { detail: 'agent restore failed' }),
  });
  // The trigger reads the live agent, so a rejected pick must not read as applied.
  expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')!.textContent).toBe(before);
});

/** The effort ladder of the fixture model, used by the effort-pick tests. */
const EFFORT_CATALOG = {
  items: [
    {
      id: 'fixture/kiki-pro',
      provider_id: 'fixture',
      remote_id: 'kiki-pro',
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'medium',
    },
  ],
};

it('applies a picked thinking effort through the agent facade and refreshes the agent read', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  harness.setAgentEffort.mockResolvedValue(undefined);
  const invalidate = vi.spyOn(queries, 'invalidateQueries');
  // The node carries a bare alias; the ladder must come from the catalog row it
  // resolves to (`fixture/kiki-pro`), not from a name match on the raw value.
  await renderWorkspace({
    forest: testForest('running', true, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('#composer-model-select')!.click();
  });
  const high = dock.querySelector<HTMLButtonElement>('[data-effort="high"]');
  expect(high).not.toBeNull();
  await act(async () => { high?.click(); });
  await settle();
  expect(harness.setAgentEffort).toHaveBeenCalledWith('session', 'child', 'high');
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ['agentCapabilities', { session_id: 'session', agent_id: 'child' }],
  });
});

it('keeps the effort pick disabled for a terminal subagent', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  await renderWorkspace({
    forest: testForest('completed', false, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  const modelSelect = dock.querySelector<HTMLButtonElement>('#composer-model-select')!;
  // A finished child stays wakeable, so the model rebind and the panel are
  // still offered; only the effort ladder is withheld.
  expect(modelSelect.disabled).toBe(false);
  await act(async () => { modelSelect.click(); });
  expect(dock.querySelector('[role="option"][data-option-value="fixture/kiki-pro"]')).not.toBeNull();
  expect(dock.querySelector('[data-effort]')).toBeNull();
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
});

it('toasts a failed effort change and leaves the live effort selected', async () => {
  harness.listModels.mockResolvedValue(EFFORT_CATALOG);
  harness.setAgentEffort.mockRejectedValue(new Error('agent restore failed'));
  await renderWorkspace({
    forest: testForest('running', true, { model: 'kiki-pro', thinkingEffort: 'medium' }),
  });
  await settle();
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('#composer-model-select')!.click();
  });
  await act(async () => {
    dock.querySelector<HTMLButtonElement>('[data-effort="high"]')?.click();
  });
  await settle();
  expect(harness.setAgentEffort).toHaveBeenCalledWith('session', 'child', 'high');
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'subagent.effortChangeFailed', { detail: 'agent restore failed' }),
  });
  // The ladder reads the live agent, so a rejected pick must not read as applied.
  expect(dock.querySelector<HTMLButtonElement>('[data-effort="medium"]')?.getAttribute('aria-checked')).toBe('true');
  expect(dock.querySelector<HTMLButtonElement>('[data-effort="high"]')?.getAttribute('aria-checked')).toBe('false');
});

it('toasts a rejected stop and stays retryable; a pending stop double-click fires once and recovers', async () => {
  let rejectStop: (error: Error) => void = () => undefined;
  harness.stopAgentTask.mockImplementation(
    () => new Promise<void>((_resolve, reject) => { rejectStop = reject; }),
  );
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  // The stop control keeps one stable element across the pending state, but
  // its label flips to "stopping" while the request is in flight.
  const abort = () =>
    dock.querySelector<HTMLButtonElement>(
      '[aria-label="Abort the running prompt"], [aria-label="Stopping…"]',
    )!;
  expect(abort()).not.toBeNull();
  // Both clicks land in the same batch: the second must not fan out another
  // cancel even before React commits the pending state between the events.
  await act(async () => {
    abort().click();
    abort().click();
  });
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(1);
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'main', 'task-1');
  expect(abort().disabled).toBe(true);
  expect(abort().getAttribute('aria-label')).toBe(translate('en', 'tasks.stopping'));
  expect(harness.pushToast).not.toHaveBeenCalled();
  // The stop rejects: the failure surfaces as an error toast, never as success,
  // and the guard clears so the user can retry.
  await act(async () => { rejectStop(new Error('stop unavailable')); });
  await settle();
  expect(harness.pushToast).toHaveBeenCalledWith({
    tone: 'error',
    text: translate('en', 'sv.stopTaskFailed', { detail: 'stop unavailable' }),
  });
  expect(abort().disabled).toBe(false);
  // Retry: a fresh request goes out and settles cleanly this time.
  harness.stopAgentTask.mockResolvedValue(undefined);
  await act(async () => { abort().click(); });
  await settle();
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(2);
  expect(abort().disabled).toBe(false);
  expect(harness.pushToast).toHaveBeenCalledTimes(1);
});

it('recovers the stop control after a successful stop pending round trip', async () => {
  let resolveStop: () => void = () => undefined;
  harness.stopAgentTask.mockImplementation(
    () => new Promise<void>((resolve) => { resolveStop = resolve; }),
  );
  await renderWorkspace({
    forest: testForest('running', true),
    sessionState: {
      ...createViewState('session'),
      loaded: true,
      tasks: [{ id: 'task-1', kind: 'subagent', status: 'running', agent_id: 'child' }] as never,
    },
  });
  await settle();
  const abort = () =>
    dock.querySelector<HTMLButtonElement>(
      '[aria-label="Abort the running prompt"], [aria-label="Stopping…"]',
    )!;
  await act(async () => { abort().click(); });
  expect(abort().disabled).toBe(true);
  await act(async () => { resolveStop(); });
  await settle();
  expect(harness.stopAgentTask).toHaveBeenCalledTimes(1);
  expect(abort().disabled).toBe(false);
  expect(harness.pushToast).not.toHaveBeenCalled();
});

it('stops a nested subagent task through its parent agent scope', async () => {
  const forest = nestedForest();
  // The dispatch task for B lives on A's task service; the session snapshot
  // carries none of it.
  const parentState = {
    ...createViewState('session'),
    loaded: true,
    tasks: [{ id: 'spawn-b', kind: 'subagent', status: 'running', agent_id: 'agent-b' }] as never,
  };
  harness.stopAgentTask.mockResolvedValue(undefined);
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'agent-b' },
    forest,
    controller: controllerStub({
      forest,
      agentStates: {
        'agent-a': parentState,
        'agent-b': { ...createViewState('session'), loaded: true },
      },
    }),
    sessionState: { ...createViewState('session'), loaded: true },
  });
  await settle();
  const abort = dock.querySelector<HTMLButtonElement>('[aria-label="Abort the running prompt"]');
  expect(abort).not.toBeNull();
  await act(async () => { abort?.click(); });
  expect(harness.stopAgentTask).toHaveBeenCalledWith('session', 'agent-a', 'spawn-b');
});

it('disables composer, model, and attach when the forest does not know the agent', async () => {
  await renderWorkspace({ forest: forestWithoutChild() });
  await settle();
  const textarea = dock.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
  expect(textarea?.disabled).toBe(true);
  expect(textarea?.placeholder).toBe(translate('en', 'subagent.composerUnavailable'));
  expect(dock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(true);
  expect(dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.disabled).toBe(true);
  expect(dock.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.setAgentModel).not.toHaveBeenCalled();
  // The effort ladder rides the same gate: an unreachable agent offers no pick
  // and never reaches the effort switch.
  expect(dock.querySelector('[data-effort]')).toBeNull();
  expect(harness.setAgentEffort).not.toHaveBeenCalled();
});

it('drops picker results that resolve after the agent leaves the forest', async () => {
  let resolvePicker: (files: Array<{ name: string; size: number; type: string; read(): Promise<File> }>) => void = () => undefined;
  const pickFiles = vi.fn(() => new Promise<Array<{ name: string; size: number; type: string; read(): Promise<File> }>>((resolve) => {
    resolvePicker = resolve;
  }));
  harness.host = { kind: 'browser', pickFiles };
  await renderWorkspace({ forest: testForest('running', true) });
  await settle();
  const attachButton = dock.querySelector<HTMLButtonElement>('[data-attach-button]')!;
  expect(attachButton.disabled).toBe(false);
  await act(async () => { attachButton.click(); });
  expect(pickFiles).toHaveBeenCalledTimes(1);
  // The agent drops out of the forest while the picker is still open.
  await renderWorkspace({ forest: forestWithoutChild() });
  await settle();
  expect(dock.querySelector<HTMLButtonElement>('[data-attach-button]')?.disabled).toBe(true);
  const file = new File(['x'], 'shot.png', { type: 'image/png' });
  resolvePicker([{ name: 'shot.png', size: 1, type: 'image/png', read: async () => file }]);
  await settle();
  expect(dock.querySelector('[data-attachment-chips]')).toBeNull();
});

it('keeps the preview-tab composer disabled for an agent the forest does not know', async () => {
  const previewHeader = document.createElement('div');
  const previewDock = document.createElement('div');
  document.body.append(previewHeader, previewDock);
  try {
    await renderWorkspace({
      forest: forestWithoutChild(),
      slots: {
        header: previewHeader,
        dock: previewDock,
        heroFooter: null,
        footer: null,
        rail: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      showBreadcrumb: false,
    });
    await settle();
    expect(previewDock.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.disabled).toBe(true);
    expect(previewDock.querySelector<HTMLButtonElement>('#composer-model-select')?.disabled).toBe(true);
  } finally {
    previewHeader.remove();
    previewDock.remove();
  }
});

const EMPTY_AGENT_STATE = createViewState('');

it('mounts no annotation tray over the child dock — sent notes fold into the message bubble', async () => {
  const forest = testForest('completed');
  const blocks = [
    { id: 'a1', kind: 'assistant', text: 'The cursor pages older turns in batches of twenty.' },
    { id: 'u2', kind: 'user', text: `${buildAnnotationsPrefix([{ quote: 'batches of twenty', comment: 'match the cap' }])}ok?` },
  ] as unknown as ReturnType<typeof createViewState>['blocks'];
  await renderWorkspace({
    forest,
    controller: controllerStub({ forest, agentStates: { child: { ...createViewState('session'), loaded: true, blocks } } }),
  });
  await settle();
  // The "N notes already in this conversation" line is gone for good; the
  // note rides its own message (the transcript renders the bubble).
  expect(dock.querySelector('[data-annotation-tray-toggle]')).toBeNull();
  expect(container.querySelector('[data-annotation-tray]')).toBeNull();
});

/**
 * Minimal live-controller seat for the per-agent snapshots the workspace reads:
 * the child's live view state, the session forest, and the PARENT's task list
 * (a nested dispatch task is registered on its parent's task service, which is
 * the same per-agent view state the rail renders).
 */
function controllerStub(input: {
  forest: AgentForest;
  agentStates: Record<string, ReturnType<typeof createViewState>>;
}): SessionController {
  return {
    subscribeAgent: () => () => {},
    getAgentState: (agentId: string) => input.agentStates[agentId] ?? EMPTY_AGENT_STATE,
    getForest: () => input.forest,
  } as unknown as SessionController;
}

/** main → A → B, all running: B's task is owned by A, not by the session. */
function nestedForest(): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'running', busy: true,
    toolCallCount: 0, childIds: ['agent-a'],
  };
  const a: AgentTreeNode = {
    agentId: 'agent-a', parentAgentId: 'main', name: 'A', label: 'A', status: 'running', busy: true,
    toolCallCount: 0, childIds: ['agent-b'],
  };
  const b: AgentTreeNode = {
    agentId: 'agent-b', parentAgentId: 'agent-a', name: 'B', label: 'B', status: 'running', busy: true,
    toolCallCount: 0, childIds: [],
  };
  return { roots: [main], byId: { main, 'agent-a': a, 'agent-b': b } };
}

function forestWithoutChild(): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: [],
  };
  return { roots: [main], byId: { main } };
}

function testForest(
  status: AgentTreeNode['status'] = 'completed',
  busy = false,
  child: Partial<AgentTreeNode> = {},
): AgentForest {
  const main: AgentTreeNode = {
    agentId: 'main', name: 'main', label: 'Main', status: 'completed', busy: false,
    toolCallCount: 0, childIds: ['child'],
  };
  const childNode: AgentTreeNode = {
    agentId: 'child', parentAgentId: 'main', name: 'general', label: 'General',
    model: 'fixture/kiki-pro',
    status, busy, toolCallCount: 0, childIds: [],
    ...child,
  };
  return { roots: [main], byId: { main, child: childNode } };
}

function renderWorkspace(overrides: Partial<ComponentProps<typeof AgentWorkspace>> = {}) {
  const previewRef = createRef<MediaPreviewApi>();
  return act(async () => root.render(
    <QueryClientProvider client={queries}>
      <I18nProvider>
        <MemoryRouter>
          <AgentWorkspace
          target={{ sessionId: 'session', agentId: 'child' }}
          controller={null}
          sessionState={{ ...createViewState('session'), loaded: true }}
          forest={testForest()}
          navigation={{ openAgent: vi.fn(), openAgentRoute: vi.fn(), openSession: vi.fn() }}
          railOpen={false}
          railIsOverlay={false}
          onToggleRail={vi.fn()}
          onCloseRail={vi.fn()}
          onCancelTask={vi.fn()}
          onStopAgentTask={vi.fn().mockResolvedValue(undefined)}
          previewApiRef={previewRef}
          {...overrides}
        />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  ));
}

it('releases per-agent transcript observation while an embedded tab is hidden', async () => {
  const release = vi.fn();
  const subscribeAgent = vi.fn(() => release);
  const controller = Object.assign(
    controllerStub({ forest: testForest(), agentStates: {} }),
    { subscribeAgent },
  );
  await renderWorkspace({ controller, transcriptVisible: true });
  expect(subscribeAgent).toHaveBeenCalledWith('child', expect.any(Function));
  expect(release).not.toHaveBeenCalled();

  await renderWorkspace({ controller, transcriptVisible: false });
  expect(release).toHaveBeenCalledTimes(1);
  expect(subscribeAgent).toHaveBeenCalledTimes(1);

  await renderWorkspace({ controller, transcriptVisible: true });
  expect(subscribeAgent).toHaveBeenCalledTimes(2);
});

it('mounts the owned media preview provider with the shared api ref by default', async () => {
  const previewRef = createRef<MediaPreviewApi>();
  const onToggleRail = vi.fn();
  await renderWorkspace({ previewApiRef: previewRef, onToggleRail });
  await settle();

  expect(harness.mediaProviderProps.length).toBeGreaterThan(0);
  expect(harness.mediaProviderProps[0]?.apiRef).toBe(previewRef);
  expect(header.querySelector('[data-preview-toggle-probe]')).not.toBeNull();
  // The shared rail's open-rail entry rides the workspace header while the
  // rail is collapsed, so a closed rail is reopenable from the agent page too.
  const toggle = header.querySelector<HTMLButtonElement>('[data-agent-rail-toggle]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => { toggle?.click(); });
  expect(onToggleRail).toHaveBeenCalledTimes(1);
});

it('renders no rail hide button once the rail is expanded', async () => {
  // The expanded rail keeps its own collapse affordances; this header carries
  // no "hide panel" button (the deleted view-level toggle).
  await renderWorkspace({ railOpen: true, onToggleRail: vi.fn() });
  await settle();

  expect(header.querySelector('[data-agent-rail-toggle]')).toBeNull();
  expect(header.textContent).not.toContain('← Back to session');
});

it('keeps the rail reopenable on the agent page after a closed rail (wide-screen route state)', async () => {
  // Main page closes the rail, then the user enters the same session's
  // subagent route: railOpen=false survives, the agent header replaces the
  // main header, and the shared rail's own toggle must still be reachable.
  const onToggleRail = vi.fn();
  await renderWorkspace({ railOpen: false, onToggleRail });
  await settle();

  const toggle = header.querySelector<HTMLButtonElement>('[data-agent-rail-toggle]');
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.getAttribute('title')).toBe('Show panel');
  // The toggle acts on the shared rail (the caller's state), not a local one.
  await act(async () => { toggle?.click(); });
  expect(onToggleRail).toHaveBeenCalledTimes(1);
  // No back-to-session button and no view-level hide button: navigation lives
  // in the breadcrumb/relations row, and the toggle is the rail's own control.
  expect(header.textContent).not.toContain('← Back to session');
});

it('embeds into caller-provided slots: no shell, no owned preview provider, no panel toggle', async () => {  harness.shellEnabled = false;
  const localHeader = document.createElement('div');
  document.body.append(localHeader);
  try {
    await renderWorkspace({
      slots: {
        header: localHeader,
        dock: null,
        heroFooter: null,
        rail: null,
        footer: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      previewApiRef: undefined,
    });
    await settle();

    // The header chrome portals into the provided slot even with no ambient shell.
    // The rail toggle defaults on; an embedding shell that passes
    // showRailToggle={false} (the preview tab, whose railOpen is a local
    // no-op) suppresses it.
    expect(localHeader.querySelector('[data-agent-rail-toggle]')).not.toBeNull();
    expect(header.querySelector('[data-agent-rail-toggle]')).toBeNull();
    // Ambient preview provider inherited: no owned provider, no apiRef seat.
    expect(harness.mediaProviderProps).toHaveLength(0);
    // The preview-panel toggle is suppressed where the workspace IS the panel.
    expect(localHeader.querySelector('[data-preview-toggle-probe]')).toBeNull();
  } finally {
    localHeader.remove();
  }
});

it('renders the agent’s own context meter and cumulative totals in the fullscreen dock', async () => {
  const childState = {
    ...createViewState('session'),
    loaded: true,
    contextTokens: 5_000,
    maxContextTokens: 10_000,
    usage: { total: { inputOther: 1_200, output: 340, inputCacheRead: 56, inputCacheCreation: 8 } },
  };
  await renderWorkspace({
    controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
  });
  await settle();

  const meter = dock.querySelector<HTMLButtonElement>('[data-context-meter]');
  expect(meter).not.toBeNull();
  // 50% exactly is the warn threshold.
  expect(meter?.getAttribute('data-context-level')).toBe('warn');
  expect(meter?.textContent).toContain('50');

  await act(async () => { meter!.click(); });
  const details = dock.querySelector('[data-context-details]');
  const usageCard = details?.querySelector('[data-context-usage]');
  expect(usageCard?.textContent).toContain('Agent cumulative');
  expect(usageCard?.textContent).not.toContain('Session cumulative');
  expect(usageCard?.textContent).toContain('1.2k');
  expect(usageCard?.textContent).toContain('340');
  // Per-agent projections carry no pricing: the cost row stays hidden rather
  // than reading as $0.00, and a subagent has no compact action.
  expect(usageCard?.textContent).not.toContain('Cost');
  expect(details?.querySelector('[data-context-compact]')).toBeNull();
  // The deep link still targets the owning session's usage page.
  expect(usageCard?.querySelector('[data-context-usage-link]')).not.toBeNull();
});

it('turns the agent meter red past the danger threshold and neutral below warn', async () => {
  const childState = {
    ...createViewState('session'),
    loaded: true,
    contextTokens: 8_500,
    maxContextTokens: 10_000,
  };
  await renderWorkspace({
    controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
  });
  await settle();
  expect(dock.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe('danger');
});

it('omits the meter when the agent projection carries no context data', async () => {
  await renderWorkspace({
    controller: controllerStub({
      forest: testForest(),
      agentStates: { child: { ...createViewState('session'), loaded: true } },
    }),
  });
  await settle();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).not.toBeNull();
  expect(dock.querySelector('[data-context-meter]')).toBeNull();
});

it('renders the agent context meter in the preview-tab dock slots', async () => {
  const previewHeader = document.createElement('div');
  const previewDock = document.createElement('div');
  document.body.append(previewHeader, previewDock);
  try {
    const childState = {
      ...createViewState('session'),
      loaded: true,
      contextTokens: 2_000,
      maxContextTokens: 10_000,
    };
    await renderWorkspace({
      controller: controllerStub({ forest: testForest(), agentStates: { child: childState } }),
      slots: {
        header: previewHeader,
        dock: previewDock,
        heroFooter: null,
        footer: null,
        rail: null,
        preview: null,
      },
      inheritMediaPreview: true,
      showPreviewToggle: false,
      showBreadcrumb: false,
    });
    await settle();
    const meter = previewDock.querySelector('[data-context-meter]');
    expect(meter).not.toBeNull();
    expect(meter?.getAttribute('data-context-level')).toBe('ok');
    expect(meter?.textContent).toContain('20');
  } finally {
    previewHeader.remove();
    previewDock.remove();
  }
});

it('hosts main in the shared timeline and chrome without child commands or another preview provider', async () => {
  const sessionState = { ...createViewState('session'), loaded: true };
  await renderWorkspace({
    target: { sessionId: 'session', agentId: 'main' },
    sessionState,
    forest: testForest(),
    inheritMediaPreview: true,
    main: {
      header: <header data-main-header>Session controls</header>,
      timeline: {
        state: sessionState,
        onLoadOlder: vi.fn().mockResolvedValue(false),
        onResolveApproval: vi.fn().mockResolvedValue(undefined),
        onAnswerQuestion: vi.fn().mockResolvedValue(undefined),
        onDismissQuestion: vi.fn().mockResolvedValue(undefined),
      },
      dock: <div data-main-dock>Goal and queue</div>,
      rail: <div data-main-rail>Session details</div>,
    },
    railOpen: true,
    slots: { header, dock, rail: container, heroFooter: null, footer: null, preview: null },
  });
  expect(header.querySelector('[data-main-header]')).not.toBeNull();
  expect(container.querySelector('[data-agent-workspace-target="main"] [data-timeline-agent="main"]')).not.toBeNull();
  expect(dock.querySelector('[data-main-dock]')?.textContent).toContain('Goal and queue');
  expect(container.querySelector('[data-main-rail]')).not.toBeNull();
  expect(dock.querySelector('[data-composer-variant="subagent"]')).toBeNull();
  expect(harness.sendAgentMessage).not.toHaveBeenCalled();
  expect(harness.mediaProviderProps).toHaveLength(0);
});

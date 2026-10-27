// @vitest-environment jsdom

import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, MemoryRouter, RouterProvider, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readInputHistory, resetInputHistoryForTests } from '@kiki/session-core/composer';
import { writeSettings } from '@kiki/session-core/settings';
import type { NamedAgentProfile } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';
import { ConversationShell, useRegisterSeat, type ConversationSeat } from './ConversationShell';
import { ContextBreakdownProvider } from './ContextMeter';

const { vscodeRuntime, preparePrompt } = vi.hoisted(() => ({
  vscodeRuntime: { value: false },
  preparePrompt: vi.fn(async (content: string) => content),
}));

const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listWorkspaceSkills = vi.fn();
const listDraftSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();
const previewAgentProfileFile = vi.fn();
const listExecutors = vi.fn();
const getExecutorModels = vi.fn();
const refreshExecutorModels = vi.fn();
const getConfig = vi.fn();
const getAgentCapabilities = vi.fn();
const previewFile = vi.fn();
const uploadFile = vi.fn();
const meta = vi.fn();
const sshList = vi.fn();
const sshSessionHosts = vi.fn();
const sshAdd = vi.fn();
const sshRemove = vi.fn();

const sshHost = {
  id: 'example-host',
  name: 'Example host',
  source: 'kiki',
  hostname: 'example.test',
  agentAccess: 'offered',
};

const reviewSkill = {
  name: 'review',
  description: 'Review the current diff for risks',
  path: '/skills/review/SKILL.md',
  source: 'project' as const,
};

const PROFILES = [
  { name: 'agent', source: 'builtin', main: true, disabled: false, routes: [], description: 'General-purpose built-in agent.' },
] satisfies NamedAgentProfile[];

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    connectionId: null,
    connectionSource: 'desktop' as const,
    scopeId: 'desktop',
    meta: { server_id: 'server-a' },
    config: { url: 'http://127.0.0.1:1234' },
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills,
      listDraftSkills,
      listNamedAgentProfiles,
      previewAgentProfileFile,
      listExecutors,
      getConfig,
      getAgentCapabilities,
      uploadFile,
      meta,
      klient: {
        rest: {
          executors: { getModels: getExecutorModels, refreshModels: refreshExecutorModels },
          agents: { previewFile },
          ssh: { list: sshList, sessionHosts: sshSessionHosts, addSessionHost: sshAdd, removeSessionHost: sshRemove },
        },
      },
    },
  }),
  useOptionalConnection: () => ({ connectionSource: 'desktop' as const }),
}));

vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' as const }),
}));

vi.mock('../host/vscode', () => ({
  isVscodeWebview: () => vscodeRuntime.value,
  vscodeHost: { preparePrompt },
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  clearToasts();
  resetInputHistoryForTests();
  writeSettings({ sendShortcut: 'enter' });
  vscodeRuntime.value = false;
  preparePrompt.mockReset().mockImplementation(async (content: string) => content);
  listModels.mockReset().mockResolvedValue({
    items: [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', max_context_size: 128000 }],
  });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  listWorkspaceSkills.mockReset().mockResolvedValue({ skills: [] });
  listDraftSkills.mockReset().mockResolvedValue({ skills: [] });
  listNamedAgentProfiles.mockReset().mockResolvedValue({ items: PROFILES });
  previewAgentProfileFile.mockReset().mockResolvedValue({ profile: PROFILES[0] });
  listExecutors.mockReset().mockResolvedValue({ items: [] });
  getExecutorModels.mockReset().mockReturnValue(new Promise(() => {}));
  refreshExecutorModels.mockReset();
  getConfig.mockReset().mockResolvedValue({ raw: {} });
  getAgentCapabilities.mockReset().mockResolvedValue({
    context: 'live',
    owner: { agent_id: 'main' },
    available: true,
    profile: { name: 'agent', restrict_models_to_menu: false },
    targets: [],
  });
  previewFile.mockReset();
  uploadFile.mockReset().mockResolvedValue({ id: 'file-1' });
  meta.mockReset().mockResolvedValue({ experimental_flags: { native_ssh: false } });
  sshList.mockReset().mockResolvedValue({ hosts: [sshHost] });
  sshSessionHosts.mockReset().mockResolvedValue({ hosts: [] });
  sshAdd.mockReset().mockResolvedValue({});
  sshRemove.mockReset().mockResolvedValue({});
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  clearToasts();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function deferred<T = undefined>(): { promise: Promise<T>; resolve: (value?: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value?: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = (value) => { next(value as T); };
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

type ComposerProps = Parameters<typeof Composer>[0];

function baseProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    busy: false,
    disabled: false,
    value: 'hello',
    onChange: () => {},
    model: undefined,
    defaultModel: undefined,
    serverDefaultModel: 'fixture/kiki-pro',
    modelSource: 'server-default',
    agentProfileCatalogMode: { mode: 'global' },
    permissionMode: 'manual',
    planMode: false,
    goalObjective: '',
    efforts: undefined,
    effort: undefined,
    attachments: [],
    onChangeAttachments: () => {},
    onChangeModel: () => {},
    onChangePermissionMode: () => {},
    onChangePlanMode: () => {},
    onChangeGoalObjective: () => {},
    onChangeEffort: () => {},
    onSend: () => {},
    ...overrides,
  };
}

async function renderComposer(props: Partial<ComposerProps> = {}): Promise<{
  container: HTMLDivElement;
  rerender: (next: Partial<ComposerProps>) => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (next: Partial<ComposerProps>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              <Composer {...baseProps(next)} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  await settle(4);
  return { container, rerender };
}

function sendButton(container: ParentNode): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[data-send-ready], button[aria-label="Send message"], button[aria-label="Queue prompt"]');
  if (button === null) throw new Error('send button missing');
  return button;
}

function textareaOf(container: ParentNode): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
  if (textarea === null) throw new Error('composer textarea missing');
  return textarea;
}

async function pressEnter(container: ParentNode): Promise<void> {
  const textarea = textareaOf(container);
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function pressUndo(container: ParentNode): Promise<void> {
  const textarea = textareaOf(container);
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  });
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function joinHost(container: ParentNode): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-add-menu-trigger]');
  if (trigger === null) throw new Error('add menu trigger missing');
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger);
  const sshRow = container.querySelector('[data-add-menu-ssh]');
  if (sshRow !== null) await click(sshRow);
  const hostRow = container.querySelector('[data-composer-ssh-host="example-host"]');
  if (hostRow === null) throw new Error('ssh host row missing');
  const button = hostRow.querySelector('button') ?? hostRow;
  await click(button);
}

describe('catalog reads and the running turn are not the submit latch', () => {
  it('keeps a plain draft sendable while the model and slash catalogs are pending', async () => {
    listModels.mockReturnValue(new Promise(() => {}));
    listSessionSkills.mockReturnValue(new Promise(() => {}));
    const { container } = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    expect(sendButton(container).disabled).toBe(false);
    expect(sendButton(container).hasAttribute('data-send-ready')).toBe(true);
  });

  it('keeps send available while the session is busy, and still sends once per submit', async () => {
    const hung = deferred();
    const onSend = vi.fn(() => hung.promise);
    const { container } = await renderComposer({ sessionId: 'session-a', value: 'hello', busy: true, onSend });
    expect(sendButton(container).disabled).toBe(false);
    const textarea = textareaOf(container);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);
    hung.resolve();
    await settle(2);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(false);
  });
});

describe('resident submit latch', () => {
  it('drops an unresolved send when the session changes and ignores that settle on the next session', async () => {
    const hung = deferred();
    const sendA = vi.fn(() => hung.promise);
    const sendB = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    const textarea = textareaOf(container);
    await pressEnter(container);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);

    await rerender({ sessionId: 'session-b', value: 'from-b', onSend: sendB });
    await settle(2);
    expect(textareaOf(container)).toBe(textarea);
    expect(textareaOf(container).value).toBe('from-b');
    expect(sendButton(container).disabled).toBe(false);

    hung.resolve();
    await settle(2);
    expect(sendB).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('from-b');
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
    await pressEnter(container);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledWith('from-b', []);
  });

  it('keeps B locked when A settles during B\'s own submit', async () => {
    const hungA = deferred();
    const hungB = deferred();
    const sendA = vi.fn(() => hungA.promise);
    const sendB = vi.fn(() => hungB.promise);
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await pressEnter(container);
    await rerender({ sessionId: 'session-b', value: 'from-b', onSend: sendB });
    await pressEnter(container);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);

    hungA.resolve();
    await settle(2);
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);
    expect(textareaOf(container).value).toBe('from-b');

    hungB.resolve();
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);
  });

  it('keeps A\'s in-flight submit when the route returns to A, so Enter does not send again', async () => {
    const hungA = deferred();
    const sendA = vi.fn(() => hungA.promise);
    const sendB = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await pressEnter(container);
    expect(sendA).toHaveBeenCalledTimes(1);
    await rerender({ sessionId: 'session-b', value: 'from-b', onSend: sendB });
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);

    await rerender({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await settle(2);
    expect(sendButton(container).disabled).toBe(true);
    await pressEnter(container);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('from-a');

    hungA.resolve();
    await settle(2);
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(false);
    await pressEnter(container);
    expect(sendA).toHaveBeenCalledTimes(2);
  });

  it('does not show A\'s submit error after the session changes', async () => {
    const hung = deferred();
    const sendA = vi.fn(() => hung.promise);
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await pressEnter(container);
    hung.reject(new Error('session-a failed'));
    await settle(2);
    expect(container.querySelector('[data-attachment-error]')?.textContent).toContain('session-a failed');

    await rerender({ sessionId: 'session-b', value: 'from-b', onSend: vi.fn(async () => {}) });
    await settle(2);
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
  });

  it('drops the latch on unmount, including a settle that lands afterwards', async () => {
    const hung = deferred();
    const sendA = vi.fn(() => hung.promise);
    const first = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await pressEnter(first.container);
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    for (const container of containers.splice(0)) container.remove();
    hung.resolve();
    await settle(2);

    const sendB = vi.fn(async () => {});
    const second = await renderComposer({ sessionId: 'session-b', value: 'from-b', onSend: sendB });
    expect(sendButton(second.container).disabled).toBe(false);
    await pressEnter(second.container);
    expect(sendB).toHaveBeenCalledTimes(1);
  });

  it('does not send the new session when /new\'s create is still in flight', async () => {
    const created = deferred();
    const createSend = vi.fn(() => created.promise);
    const sessionSend = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({ value: 'first message', onSend: createSend });
    const textarea = textareaOf(container);
    await pressEnter(container);
    expect(createSend).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);

    await rerender({ sessionId: 'session-new', value: 'first message', onSend: sessionSend });
    await settle(2);
    expect(textareaOf(container)).toBe(textarea);
    expect(textareaOf(container).value).toBe('first message');
    expect(sessionSend).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(false);

    created.resolve();
    await settle(2);
    expect(createSend).toHaveBeenCalledTimes(1);
    expect(sessionSend).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('first message');
  });

  it('does not let the /new create latch unlock a submit the new session started', async () => {
    const created = deferred();
    const createSend = vi.fn(() => created.promise);
    const sessionHung = deferred();
    const sessionSend = vi.fn(() => sessionHung.promise);
    const { container, rerender } = await renderComposer({ value: 'first message', onSend: createSend });
    await pressEnter(container);
    expect(createSend).toHaveBeenCalledTimes(1);

    await rerender({ sessionId: 'session-new', value: 'second message', onSend: sessionSend });
    await settle(2);
    expect(sessionSend).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(false);
    await pressEnter(container);
    expect(sessionSend).toHaveBeenCalledTimes(1);
    expect(sessionSend).toHaveBeenCalledWith('second message', []);
    expect(sendButton(container).disabled).toBe(true);

    created.resolve();
    await settle(2);
    expect(createSend).toHaveBeenCalledTimes(1);
    expect(sessionSend).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);
    expect(textareaOf(container).value).toBe('second message');

    sessionHung.resolve();
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);
  });
});

describe('vscode prepare that resolves after a session switch', () => {
  it('delivers the prepared prompt to the session that started it and does not edit the next draft', async () => {
    vscodeRuntime.value = true;
    const prepared = deferred<string>();
    preparePrompt.mockReturnValue(prepared.promise);
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});
    const changes: string[] = [];
    const onChange = (next: string) => { changes.push(next); };
    const { container, rerender } = await renderComposer({
      sessionId: 'session-a',
      value: 'from-a',
      onChange,
      onSend: sendA,
    });
    await pressEnter(container);
    expect(preparePrompt).toHaveBeenCalledTimes(1);
    expect(sendA).not.toHaveBeenCalled();

    await rerender({ sessionId: 'session-b', value: 'from-b', onChange, onSend: sendB });
    await settle(2);
    prepared.resolve('prepared-a');
    await settle(4);

    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendA).toHaveBeenCalledWith('prepared-a', []);
    expect(sendB).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('from-b');
    expect(readInputHistory('session-a')).toEqual(['from-a']);
    expect(readInputHistory('session-b')).toEqual([]);
    await pressUndo(container);
    expect(changes).toEqual([]);
    expect(textareaOf(container).value).toBe('from-b');
  });

  it('does not paint a prepare failure onto the session that is now open', async () => {
    vscodeRuntime.value = true;
    const prepared = deferred<string>();
    preparePrompt.mockReturnValue(prepared.promise);
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'from-a', onSend: sendA });
    await pressEnter(container);
    await rerender({ sessionId: 'session-b', value: 'from-b', onSend: sendB });
    prepared.reject(new Error('prepare failed'));
    await settle(4);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
    expect(textareaOf(container).value).toBe('from-b');
    expect(sendButton(container).disabled).toBe(false);
  });

  it('activates the original session\'s skill after prepare and does not send or edit the next session', async () => {
    vscodeRuntime.value = true;
    listSessionSkills.mockResolvedValue({ skills: [reviewSkill] });
    const prepared = deferred<string>();
    preparePrompt.mockReturnValue(prepared.promise);
    const activateA = vi.fn(async () => {});
    const activateB = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});
    const changes: string[] = [];
    const onChange = (next: string) => { changes.push(next); };
    const { container, rerender } = await renderComposer({
      sessionId: 'session-a',
      value: '/review --fix',
      onChange,
      onActivateSkill: activateA,
    });
    await pressEnter(container);
    expect(preparePrompt).toHaveBeenCalled();
    expect(activateA).not.toHaveBeenCalled();

    await rerender({
      sessionId: 'session-b',
      value: 'from-b',
      onChange,
      onActivateSkill: activateB,
      onSend: sendB,
    });
    prepared.resolve('');
    await settle(4);
    expect(activateA).toHaveBeenCalledTimes(1);
    expect(activateB).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('from-b');
    await pressUndo(container);
    expect(changes).toEqual([]);
  });
});

describe('resident slash catalog wait', () => {
  it('waits only for the slash submit that started the refetch', async () => {
    const catalog = deferred<{ skills: readonly [] }>();
    listSessionSkills.mockReturnValue(catalog.promise);
    const sendA = vi.fn(async () => {});
    const sendB = vi.fn(async () => {});
    const { container, rerender } = await renderComposer({
      sessionId: 'session-a',
      value: '/review --fix',
      onSend: sendA,
    });
    expect(sendButton(container).disabled).toBe(false);
    await pressEnter(container);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(true);

    await rerender({ sessionId: 'session-b', value: 'plain text', onSend: sendB });
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);
    catalog.resolve({ skills: [] });
    await settle(4);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(textareaOf(container).value).toBe('plain text');
    expect(container.querySelector('[data-attachment-error]')).toBeNull();
  });

  it('does not let a stale slash refetch submit or unlock the next session\'s own wait', async () => {
    const catalog = deferred<{ skills: readonly (typeof reviewSkill)[] }>();
    listSessionSkills.mockReturnValue(catalog.promise);
    const activateA = vi.fn(async () => {});
    const activateB = deferred();
    const activateBFn = vi.fn(() => activateB.promise);
    const { container, rerender } = await renderComposer({
      sessionId: 'session-a',
      value: '/review --fix',
      onActivateSkill: activateA,
    });
    await pressEnter(container);
    await rerender({
      sessionId: 'session-b',
      value: '/review --fix',
      onActivateSkill: activateBFn,
    });
    await pressEnter(container);
    expect(sendButton(container).disabled).toBe(true);

    catalog.resolve({ skills: [reviewSkill] });
    await settle(4);
    expect(activateA).not.toHaveBeenCalled();
    expect(activateBFn).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);
    activateB.resolve();
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);
  });
});

describe('session SSH send gate', () => {
  it('does not block send when native ssh is off', async () => {
    sshSessionHosts.mockRejectedValue(new Error('hosts unavailable'));
    const { container } = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    expect(sshSessionHosts).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(false);
  });

  it('does not block send while an existing session\'s host list is unread or failed', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    sshSessionHosts.mockReturnValue(new Promise(() => {}));
    const hanging = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    expect(sendButton(hanging.container).disabled).toBe(false);
    expect(hanging.container.querySelector('[data-composer-ssh-strip]')).toBeNull();

    sshSessionHosts.mockRejectedValue(new Error('hosts unavailable'));
    const failed = await renderComposer({ sessionId: 'session-b', value: 'hello' });
    expect(sshSessionHosts).toHaveBeenCalled();
    expect(sendButton(failed.container).disabled).toBe(false);
    expect(failed.container.querySelector('[role="alert"]')).toBeNull();
    expect(failed.container.querySelector('[data-composer-ssh-strip]')).toBeNull();
  });

  it('blocks only the session whose join is in flight', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const joins: Array<ReturnType<typeof deferred<undefined>>> = [];
    sshAdd.mockImplementation(() => {
      const next = deferred();
      joins.push(next);
      return next.promise;
    });
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    expect(sendButton(container).disabled).toBe(false);
    await joinHost(container);
    expect(sshAdd).toHaveBeenCalledTimes(1);
    expect(sendButton(container).disabled).toBe(true);

    await rerender({ sessionId: 'session-b', value: 'hello' });
    await settle(4);
    expect(sshSessionHosts).toHaveBeenCalledWith('session-b');
    expect(sendButton(container).disabled).toBe(false);

    await joinHost(container);
    expect(sshAdd).toHaveBeenCalledTimes(2);
    expect(sendButton(container).disabled).toBe(true);
    joins[0]?.resolve();
    await settle(4);
    expect(sendButton(container).disabled).toBe(true);
    joins[1]?.resolve();
    await settle(4);
    expect(sendButton(container).disabled).toBe(false);
  });

  it('still blocks A when its join is in flight after A → B → A', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const join = deferred();
    sshAdd.mockReturnValue(join.promise);
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    await joinHost(container);
    await rerender({ sessionId: 'session-b', value: 'hello' });
    await settle(2);
    expect(sendButton(container).disabled).toBe(false);
    await rerender({ sessionId: 'session-a', value: 'hello' });
    await settle(2);
    expect(sendButton(container).disabled).toBe(true);
    join.resolve();
    await settle(4);
    expect(sendButton(container).disabled).toBe(false);
  });

  it('does not toast a join failure onto the session that is now open', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
    const join = deferred();
    sshAdd.mockReturnValue(join.promise);
    const { container, rerender } = await renderComposer({ sessionId: 'session-a', value: 'hello' });
    await joinHost(container);
    await rerender({ sessionId: 'session-b', value: 'hello' });
    join.reject(new Error('add failed'));
    await settle(4);
    expect(getToasts()).toEqual([]);
    expect(sendButton(container).disabled).toBe(false);
  });
});

describe('ConversationShell route seat', () => {
  function Publisher({ sends }: { sends: { a: () => Promise<void>; b: () => Promise<void> } }) {
    const { sessionId = '' } = useParams();
    const onSend = sessionId === 'session-b' ? sends.b : sends.a;
    const value = sessionId === 'session-b' ? 'from-b' : 'from-a';
    const seat = useMemo<ConversationSeat>(() => ({
      phase: 'active',
      composer: (
        <ContextBreakdownProvider value={undefined}>
          <Composer {...baseProps({ sessionId, value, onSend })} />
        </ContextBreakdownProvider>
      ),
    }), [sessionId, value, onSend]);
    useRegisterSeat(seat);
    return <p data-publisher={sessionId} />;
  }

  function EmptySeat() {
    const seat = useMemo<ConversationSeat>(() => ({ phase: 'active', composer: null }), []);
    useRegisterSeat(seat);
    return <p data-publisher="empty" />;
  }

  async function mountShell(sends: { a: () => Promise<void>; b: () => Promise<void> }, withGap: boolean) {
    const router = createMemoryRouter([
      {
        path: '/',
        element: <ConversationShell />,
        children: [
          { path: 's/:sessionId', element: <Publisher sends={sends} /> },
          ...(withGap ? [{ path: 'gap', element: <EmptySeat /> }] : []),
        ],
      },
    ], { initialEntries: ['/s/session-a'] });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <RouterProvider router={router} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle(4);
    return router;
  }

  it('keeps the textarea across /s/a → /s/b and does not keep A\'s unresolved send', async () => {
    const hung = deferred();
    const sends = { a: vi.fn(() => hung.promise), b: vi.fn(async () => {}) };
    const router = await mountShell(sends, false);
    const textarea = textareaOf(document);
    await pressEnter(document);
    expect(sends.a).toHaveBeenCalledTimes(1);

    await act(async () => {
      await router.navigate('/s/session-b');
    });
    await settle(4);
    expect(document.querySelector('[data-publisher]')?.getAttribute('data-publisher')).toBe('session-b');
    expect(textareaOf(document)).toBe(textarea);
    expect(textareaOf(document).value).toBe('from-b');
    expect(sendButton(document).disabled).toBe(false);
    await pressEnter(document);
    expect(sends.b).toHaveBeenCalledTimes(1);
    hung.resolve();
    await settle(2);
    expect(sends.b).toHaveBeenCalledTimes(1);
  });

  it('leaves the next session sendable when nothing is in flight', async () => {
    const sends = { a: vi.fn(async () => {}), b: vi.fn(async () => {}) };
    const router = await mountShell(sends, false);
    await act(async () => {
      await router.navigate('/s/session-b');
    });
    await settle(4);
    expect(textareaOf(document).value).toBe('from-b');
    expect(sendButton(document).disabled).toBe(false);
  });

  it('mounts a fresh composer when the seat publishes null between sessions', async () => {
    const hung = deferred();
    const sends = { a: vi.fn(() => hung.promise), b: vi.fn(async () => {}) };
    const router = await mountShell(sends, true);
    await pressEnter(document);
    const previous = textareaOf(document);
    await act(async () => {
      await router.navigate('/gap');
    });
    await settle(2);
    expect(document.querySelector('textarea[data-composer]')).toBeNull();
    await act(async () => {
      await router.navigate('/s/session-b');
    });
    await settle(4);
    expect(textareaOf(document)).not.toBe(previous);
    expect(sendButton(document).disabled).toBe(false);
    await pressEnter(document);
    expect(sends.b).toHaveBeenCalledTimes(1);
    hung.resolve();
    await settle(2);
    expect(sends.b).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushInputHistory, readInputHistory, resetInputHistoryForTests } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import type { NamedAgentProfile } from '../lib/client';
import { clearToasts, getToasts } from '../lib/toasts';
import { Composer } from './Composer';

const { selectFilesNative, desktopRuntime, vscodeRuntime, preparePrompt } = vi.hoisted(() => ({
  selectFilesNative: vi.fn(),
  desktopRuntime: { value: false },
  vscodeRuntime: { value: false },
  preparePrompt: vi.fn(async (content: string, _conversationId?: string) => content),
}));
const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listWorkspaceSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();
const uploadFile = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels,
      listSessionSkills,
      listWorkspaceSkills,
      listNamedAgentProfiles,
      uploadFile,
    },
  }),
}));
vi.mock('../host', () => ({
  useHost: () =>
    desktopRuntime.value
      ? { kind: 'tauri', pickFiles: selectFilesNative }
      : { kind: 'browser' },
}));
vi.mock('../host/vscode', () => ({
  isVscodeWebview: () => vscodeRuntime.value,
  vscodeHost: { preparePrompt },
}));

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetInputHistoryForTests();
  clearToasts();
  listModels.mockReset().mockResolvedValue({ items: [{ model: 'fixture/kiki-pro', provider: 'fixture' }] });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
  listWorkspaceSkills.mockReset().mockResolvedValue({ skills: [] });
  uploadFile.mockReset().mockResolvedValue({ id: 'file-1' });
  selectFilesNative.mockReset();
  desktopRuntime.value = false;
  vscodeRuntime.value = false;
  preparePrompt.mockReset().mockImplementation(async (content: string, _conversationId?: string) => content);
  listNamedAgentProfiles.mockReset().mockResolvedValue({
    items: [
      {
        name: 'agent',
        source: 'builtin',
        main: true,
        disabled: false,
        routes: [],
        description: 'General-purpose built-in agent.',
      },
      {
        name: 'grok-only',
        source: 'user',
        main: true,
        disabled: false,
        routes: [],
        description: 'Grok-only profile.',
      },
      { name: 'reviewer', source: 'workspace', main: false, disabled: false, routes: [] },
      { name: 'legacy', source: 'workspace', main: false, disabled: true, routes: [] },
    ] satisfies NamedAgentProfile[],
  });
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderComposer(
  props: Partial<Parameters<typeof Composer>[0]> = {},
): Promise<{
  container: HTMLDivElement;
  root: Root;
  rerender: (props: Partial<Parameters<typeof Composer>[0]>) => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rerender = async (nextProps: Partial<Parameters<typeof Composer>[0]>) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              <Composer
                busy={false}
                disabled={false}
                value=""
                onChange={() => {}}
                model={undefined}
                defaultModel={undefined}
                serverDefaultModel="fixture/kiki-pro"
                modelSource="server-default"
                agentProfileCatalogMode={{ mode: 'global' }}
                permissionMode="manual"
                planMode={false}
                swarmMode={false}
                goalObjective=""
                goalStatus={undefined}
                goalControl={undefined}
                efforts={undefined}
                effort={undefined}
                attachments={[]}
                onChangeAttachments={() => {}}
                onChangeModel={() => {}}
                onChangePermissionMode={() => {}}
                onChangePlanMode={() => {}}
                onChangeSwarmMode={() => {}}
                onChangeGoalObjective={() => {}}
                onChangeGoalControl={() => {}}
                onChangeEffort={() => {}}
                onSend={() => {}}
                {...nextProps}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
  };
  await rerender(props);
  await settle();
  await settle();
  return { container, root, rerender };
}

/** Let react-query promises land and the re-render flush, on a macrotask cadence. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** Click through an element and let the resulting render flush. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * The agent-profile picker is a standalone toolbar control — reaching it just
 * means waiting for the profile catalog to land.
 */
async function waitForTrigger(container: HTMLDivElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trigger = container.querySelector<HTMLButtonElement>('#composer-agent-profile-select');
    if (trigger !== null && container.querySelector('[data-selection-diagnostic][role="status"]') === null) return trigger;
    await settle();
  }
  throw new Error('profile select never rendered');
}

/** Open the permission mode chip's panel and hand back its trigger. */
async function openModePanel(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
  await click(trigger);
  return trigger;
}

/** Open the plan chip's panel and hand back its trigger. */
async function openPlanPanel(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Plan"]')!;
  await click(trigger);
  return trigger;
}

describe('Composer host compatibility', () => {
  it('renders a new-session composer without Web Crypto randomUUID', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { ...originalCrypto, randomUUID: undefined });

    await expect(renderComposer({ sessionId: undefined })).resolves.toBeDefined();
    vi.stubGlobal('crypto', originalCrypto);
  });

  it('submits browser prompts synchronously without VS Code preflight state', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'browser prompt', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSend).toHaveBeenCalledWith('browser prompt', []);
    expect(preparePrompt).not.toHaveBeenCalled();
    // The send latch releases once the (void) submit settles a microtask later.
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
  });

  it('preserves a new-session key for creation and rotates between resident sessions', async () => {
    vscodeRuntime.value = true;
    const onSend = vi.fn();
    const rendered = await renderComposer({ value: 'new', sessionId: undefined, onSend });
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const newKey = preparePrompt.mock.calls[0]?.[1];

    await rendered.rerender({ value: 'session-a', sessionId: 'session-a', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    await rendered.rerender({ value: 'session-b', sessionId: 'session-b', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    await rendered.rerender({ value: 'new-again', sessionId: undefined, onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const newKeyAfterSession = preparePrompt.mock.calls[3]?.[1];

    await rendered.rerender({ value: 'session-c', sessionId: 'session-c', onSend });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();

    expect(newKey).toMatch(/^vscode-conversation-/);
    expect(newKeyAfterSession).toMatch(/^vscode-conversation-/);
    expect(newKeyAfterSession).not.toBe(newKey);
    expect(newKeyAfterSession).not.toBe('session-b');
    expect(preparePrompt.mock.calls.map((call) => call[1])).toEqual([
      newKey,
      newKey,
      'session-b',
      newKeyAfterSession,
      newKeyAfterSession,
    ]);
  });
});

describe('Composer send latch', () => {
  it('ignores a rapid second trigger while the submission is in flight', async () => {
    const gate = deferred<void>();
    const onSend = vi.fn(() => gate.promise);
    const { container } = await renderComposer({ value: 'double tap', onSend });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(sendButton.disabled).toBe(false);

    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(1);
    // The intent alone disables the button — no waiting for the parent to
    // clear the draft or for `busy` to arrive.
    expect(sendButton.disabled).toBe(true);

    // The rapid second click during the round trip is swallowed.
    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(1);

    // Settling releases the latch, so a deliberate next send goes through.
    await act(async () => { gate.resolve(); });
    await settle();
    expect(sendButton.disabled).toBe(false);
    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('releases the latch for a retry when the submission rejects', async () => {
    const onSend = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('fixture offline')))
      .mockImplementationOnce(() => Promise.resolve());
    const { container } = await renderComposer({ value: 'retry me', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;

    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    await settle();
    expect(sendButton.disabled).toBe(false);

    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});

describe('Composer agent profile picker', () => {
  it('renders the bound profile without a main suffix and lists only enabled main profiles', async () => {
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
    });
    const trigger = await waitForTrigger(container);
    expect(trigger.textContent).toContain('agent');
    expect(trigger.textContent).not.toContain('main');

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    // Only enabled main profiles are offered; non-main and disabled drop out.
    expect(options.some((text) => text.includes('grok-only'))).toBe(true);
    expect(options.some((text) => text.includes('reviewer'))).toBe(false);
    expect(options.some((text) => text.includes('legacy'))).toBe(false);
    expect(options.findIndex((text) => text.includes('agent'))).toBeLessThan(
      options.findIndex((text) => text.includes('grok-only')),
    );
    expect(options.some((text) => text.includes('main'))).toBe(false);
    // Rows carry the useful facts: description, source badge.
    const agentRow = [...container.querySelectorAll('[role="option"]')].find(
      (row) => row.textContent?.includes('agent'),
    );
    expect(agentRow?.textContent).toContain('General-purpose built-in agent.');
    expect(agentRow?.textContent).toContain('builtin');
  });

  it('reports picks through onChangeAgentProfile (the parent owns the confirm flow)', async () => {
    const onChangeAgentProfile = vi.fn();
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile,
    });
    const trigger = await waitForTrigger(container);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const grokRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('grok-only'),
    );
    expect(grokRow).toBeDefined();
    await act(async () => {
      grokRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangeAgentProfile).toHaveBeenCalledWith('grok-only');
  });

  it('shows rebuild context in the profile menu and calls it only after confirmation', async () => {
    const onRebuildContext = vi.fn(async () => ({ changed: true }));
    const { container } = await renderComposer({
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      onRebuildContext,
    });
    await click(await waitForTrigger(container));
    const rebuildRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('Rebuild context'),
    );
    expect(rebuildRow).toBeDefined();
    await click(rebuildRow!);
    expect(onRebuildContext).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Conversation messages and history are kept.',
    );
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Rebuild context',
    );
    await click(confirm!);
    await settle();
    expect(onRebuildContext).toHaveBeenCalledOnce();
    expect(getToasts().some((toast) => toast.tone === 'success' && toast.text.includes('latest sources'))).toBe(true);
  });

  it('reports rebuild failures and disables the profile menu while busy', async () => {
    const onRebuildContext = vi.fn(async () => { throw new Error('reload failed'); });
    const rendered = await renderComposer({
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      onRebuildContext,
    });
    await click(await waitForTrigger(rendered.container));
    const rebuildRow = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('Rebuild context'),
    );
    await click(rebuildRow!);
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (button) => button.textContent === 'Rebuild context',
    );
    await click(confirm!);
    await settle();
    expect(getToasts().some((toast) => toast.tone === 'error' && toast.text.includes('reload failed'))).toBe(true);

    await rendered.rerender({
      busy: true,
      sessionId: 'session-1',
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
      onRebuildContext,
    });
    const trigger = rendered.container.querySelector<HTMLButtonElement>('#composer-agent-profile-select')!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.title).toContain('Wait for the current turn');
  });

  it('hides without a handler but preserves the choice and offers retry when the catalog fails', async () => {
    const { container } = await renderComposer({ agentProfile: 'agent' });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('#composer-agent-profile-select')).toBeNull();

    listNamedAgentProfiles.mockRejectedValue(new Error('catalog offline'));
    const second = await renderComposer({ agentProfile: 'agent', onChangeAgentProfile: () => {} });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(second.container.querySelector('#composer-agent-profile-select')?.textContent).toContain('agent');
    expect(second.container.querySelector('[role="alert"]')?.textContent).toContain('catalog offline');
    expect(second.container.querySelector('[role="alert"] button')?.textContent).toBe('Retry');
  });

  it('offers only enabled main profiles, preserving an invalid choice with a diagnostic', async () => {
    listNamedAgentProfiles.mockResolvedValue({
      items: [
        { name: 'agent', source: 'builtin', main: true, disabled: true, routes: [] },
        { name: 'reviewer', source: 'workspace', main: false, disabled: false, routes: [] },
      ] satisfies NamedAgentProfile[],
    });
    const { container } = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
    });
    const trigger = await waitForTrigger(container);
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options).toHaveLength(0);
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('unavailable');
  });

  it('loads workspace main profiles and excludes non-main profiles', async () => {
    listNamedAgentProfiles.mockImplementation(async (workspaceId?: string) => ({
      items: workspaceId === 'wd_alpha'
        ? [
            { name: 'alpha-main', source: 'workspace', main: true, disabled: false, routes: [] },
            { name: 'alpha-helper', source: 'workspace', main: false, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[]
        : [],
    }));
    const { container } = await renderComposer({
      workspaceId: 'wd_alpha',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_alpha' },
      agentProfile: 'alpha-main',
      onChangeAgentProfile: () => {},
    });
    const trigger = await waitForTrigger(container);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_alpha');
    await click(trigger);
    const options = [...container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options.some((text) => text.includes('alpha-main'))).toBe(true);
    expect(options.some((text) => text.includes('alpha-helper'))).toBe(false);
  });

  it('does not reuse a stale profile catalog when the workspace changes', async () => {
    const workspaceB = deferred<{ items: NamedAgentProfile[] }>();
    listNamedAgentProfiles.mockImplementation((workspaceId?: string) => {
      if (workspaceId === 'wd_alpha') {
        return Promise.resolve({
          items: [
            { name: 'alpha-main', source: 'workspace', main: true, disabled: false, routes: [] },
          ] satisfies NamedAgentProfile[],
        });
      }
      if (workspaceId === 'wd_beta') return workspaceB.promise;
      return Promise.resolve({ items: [] });
    });
    const rendered = await renderComposer({
      workspaceId: 'wd_alpha',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_alpha' },
      agentProfile: 'alpha-main',
      onChangeAgentProfile: () => {},
    });
    expect((await waitForTrigger(rendered.container)).textContent).toContain('alpha-main');

    await rendered.rerender({
      workspaceId: 'wd_beta',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_beta' },
      agentProfile: 'beta-main',
      onChangeAgentProfile: () => {},
    });
    await settle();
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_beta');
    expect(rendered.container.querySelector('#composer-agent-profile-select')).not.toBeNull();

    workspaceB.resolve({
      items: [
        { name: 'beta-main', source: 'workspace', main: true, disabled: false, routes: [] },
      ],
    });
    const trigger = await waitForTrigger(rendered.container);
    expect(trigger.textContent).toContain('beta-main');
    await click(trigger);
    const options = [...rendered.container.querySelectorAll('[role="option"]')].map(
      (row) => row.textContent ?? '',
    );
    expect(options.some((text) => text.includes('beta-main'))).toBe(true);
    expect(options.some((text) => text.includes('alpha-main'))).toBe(false);
  });

  it('selects a bound workspace profile when its catalog arrives later', async () => {
    const catalog = deferred<{ items: NamedAgentProfile[] }>();
    listNamedAgentProfiles.mockReturnValue(catalog.promise);
    const rendered = await renderComposer({
      sessionId: 'session-1',
      agentProfileCatalogMode: { mode: 'disabled' },
      agentProfile: 'workspace-main',
      onChangeAgentProfile: () => {},
    });
    await settle();
    expect(listNamedAgentProfiles).not.toHaveBeenCalled();
    expect(rendered.container.querySelector('#composer-agent-profile-select')).not.toBeNull();

    await rendered.rerender({
      workspaceId: 'wd_session',
      agentProfileCatalogMode: { mode: 'workspace', workspaceId: 'wd_session' },
      sessionId: 'session-1',
      agentProfile: 'workspace-main',
      onChangeAgentProfile: () => {},
    });
    catalog.resolve({
      items: [
        { name: 'workspace-main', source: 'workspace', main: true, disabled: false, routes: [] },
      ],
    });
    const trigger = await waitForTrigger(rendered.container);
    expect(listNamedAgentProfiles).toHaveBeenCalledWith('wd_session');
    expect(trigger.textContent).toContain('workspace-main');
    expect(trigger.textContent).not.toContain('agent');
    await click(trigger);
    expect(rendered.container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('accents the pill while a switch is pending', async () => {
    const { container } = await renderComposer({
      agentProfile: 'reviewer',
      agentProfilePending: true,
      onChangeAgentProfile: () => {},
    });
    const trigger = await waitForTrigger(container);
    expect(trigger.textContent).toContain('reviewer');
    expect(trigger.className).toContain('border-accent');
  });
});

describe('Composer mode dropdown', () => {
  it('shows the current mode on the trigger and opens the option panel', async () => {
    const { container } = await renderComposer({ permissionMode: 'auto' });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('auto');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const options = [...container.querySelectorAll<HTMLElement>('[data-mode-select] [role="option"]')];
    expect(options).toHaveLength(3);
    // Each row carries its hint line; the current mode is aria-selected.
    expect(options.map((row) => row.textContent ?? '')).toEqual([
      expect.stringContaining('Approve every action'),
      expect.stringContaining('Approve reads, ask for writes'),
      expect.stringContaining('Never ask'),
    ]);
    expect(options.map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    // Focus lands on the current option when the panel opens.
    expect(document.activeElement).toBe(options[1]);
  });

  it('reports picks through onChangePermissionMode and closes the panel', async () => {
    const onChangePermissionMode = vi.fn();
    const { container } = await renderComposer({ permissionMode: 'manual', onChangePermissionMode });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const yoloRow = [...container.querySelectorAll<HTMLElement>('[data-mode-select] [role="option"]')]
      .find((row) => row.textContent?.includes('yolo'))!;
    await act(async () => {
      yoloRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChangePermissionMode).toHaveBeenCalledWith('yolo');
    expect(container.querySelector('[data-mode-select] [role="option"]')).toBeNull();
    // Focus returns to the trigger after a pick.
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape without changing the mode', async () => {
    const onChangePermissionMode = vi.fn();
    const { container } = await renderComposer({ permissionMode: 'manual', onChangePermissionMode });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-mode-select] [role="option"]')).not.toBeNull();
    await act(async () => {
      container.querySelector('[data-mode-select]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-mode-select] [role="option"]')).toBeNull();
    expect(onChangePermissionMode).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when a pointerdown lands outside the dropdown', async () => {
    const { container } = await renderComposer({ permissionMode: 'manual' });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-mode-select] [role="option"]')).not.toBeNull();
    await act(async () => {
      // jsdom has no PointerEvent constructor; the listener only reads .target.
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[data-mode-select] [role="option"]')).toBeNull();
  });

  it('keeps plan and swarm state off the permission trigger', async () => {
    const { container } = await renderComposer({
      permissionMode: 'manual',
      planMode: true,
      swarmMode: true,
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
    expect(trigger.textContent).toContain('manual');
    expect(trigger.textContent).not.toContain('plan');
    expect(trigger.textContent).not.toContain('swarm');
  });

  it('spells the active plan/swarm combination on the plan trigger', async () => {
    const { container } = await renderComposer({ planMode: true, swarmMode: true });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Plan"]')!;
    expect(trigger.textContent).toContain('plan · swarm');

    const resting = await renderComposer();
    const restingTrigger = resting.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Plan"]',
    )!;
    expect(restingTrigger.textContent).toContain('plan');
    expect(restingTrigger.textContent).not.toContain('swarm');
  });

  it('reports plan and swarm from the plan panel and keeps it open for the next pick', async () => {
    const onChangePlanMode = vi.fn();
    const onChangeSwarmMode = vi.fn();
    const { container } = await renderComposer({ onChangePlanMode, onChangeSwarmMode });
    await openPlanPanel(container);
    const plan = container.querySelector<HTMLButtonElement>('[data-plan-select] [data-mode-switch="plan"]')!;
    const swarm = container.querySelector<HTMLButtonElement>('[data-plan-select] [data-mode-switch="swarm"]')!;
    expect(plan.getAttribute('aria-pressed')).toBe('false');
    await click(plan);
    await click(swarm);
    expect(onChangePlanMode).toHaveBeenCalledWith(true);
    expect(onChangeSwarmMode).toHaveBeenCalledWith(true);
    // Combinations are the point — the panel stays put between toggles.
    expect(container.querySelector('[data-plan-select] [data-mode-switch]')).not.toBeNull();
  });

  it('reports the plan gate from the plan panel; the row hides without a gate handler', async () => {
    const onChangePlanGate = vi.fn();
    const { container } = await renderComposer({ planGate: 'free', onChangePlanGate });
    await openPlanPanel(container);
    const gate = container.querySelector<HTMLButtonElement>(
      '[data-plan-select] [data-mode-switch="planGate"]',
    )!;
    // free = the "auto plan mode" switch reads on.
    expect(gate.getAttribute('aria-pressed')).toBe('true');
    await click(gate);
    expect(onChangePlanGate).toHaveBeenCalledWith('gated');
    expect(container.querySelector('[data-plan-select] [data-mode-switch="planGate"]')).not.toBeNull();

    // Without the session-scoped handler pair (e.g. /new) there is no gate row.
    const bare = await renderComposer();
    await openPlanPanel(bare.container);
    expect(bare.container.querySelector('[data-mode-switch="planGate"]')).toBeNull();
  });

  it('expands the goal objective inside the plan panel', async () => {
    const onChangeGoalObjective = vi.fn();
    const { container } = await renderComposer({ onChangeGoalObjective });
    await openPlanPanel(container);
    expect(container.querySelector('[data-goal-objective]')).toBeNull();
    await click(container.querySelector('[data-goal-open]')!);
    const field = container.querySelector<HTMLInputElement>('[data-goal-objective]')!;
    expect(document.activeElement).toBe(field);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, 'Ship the batch');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChangeGoalObjective).toHaveBeenCalledWith('Ship the batch');
  });

  it('rests on one trigger per control, each carrying its own state', async () => {
    listModels.mockResolvedValue({
      items: [{ provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro' }],
    });
    const { container } = await renderComposer({ planMode: true, swarmMode: true });
    for (let index = 0; index < 5; index += 1) await settle();
    const buttons = [...container.querySelectorAll<HTMLElement>('[data-composer-toolbar] button')];
    // Attach, mode, plan, model, send — and nothing else at rest (no agent
    // handler was passed, so the profile control stays hidden).
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Attach files',
      'Mode',
      'Plan',
      'Model',
      'Send message',
    ]);
    expect(buttons[1]?.textContent).toContain('manual');
    expect(buttons[2]?.textContent).toContain('plan · swarm');
  });
});

describe('Composer goal run-state chip', () => {
  it('traces a live goal and drives pause/cancel through onChangeGoalControl', async () => {
    const onChangeGoalControl = vi.fn();
    const { container } = await renderComposer({
      goalStatus: 'active',
      goalObjective: 'Ship the batch',
      onChangeGoalControl,
    });
    const chip = container.querySelector<HTMLElement>('[data-goal-chip]');
    expect(chip?.textContent).toContain('goal · active');
    expect(chip?.getAttribute('aria-label')).toBe('Goal — active');
    const pause = container.querySelector<HTMLButtonElement>('[data-goal-chip] button[aria-label="pause"]')!;
    await click(pause);
    expect(onChangeGoalControl).toHaveBeenCalledWith('pause');
    expect(
      container.querySelector('[data-goal-chip] button[aria-label="cancel"]'),
    ).not.toBeNull();
  });

  it('offers resume instead of pause while paused, and nothing once complete', async () => {
    const paused = await renderComposer({ goalStatus: 'paused' });
    expect(
      paused.container.querySelector('[data-goal-chip] button[aria-label="resume"]'),
    ).not.toBeNull();
    expect(
      paused.container.querySelector('[data-goal-chip] button[aria-label="pause"]'),
    ).toBeNull();

    const complete = await renderComposer({ goalStatus: 'complete' });
    expect(complete.container.querySelector('[data-goal-chip]')).not.toBeNull();
    expect(complete.container.querySelectorAll('[data-goal-chip] button')).toHaveLength(0);
  });

  it('disappears with no goal on the session', async () => {
    const { container } = await renderComposer();
    expect(container.querySelector('[data-goal-chip]')).toBeNull();
  });
});

describe('Composer model chip', () => {
  const catalog = {
    items: [
      { provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro' },
      { provider: 'fixture', model: 'fixture/kiki-air', display_name: 'Kiki Air' },
    ],
  };

  it('carries the effort segment outside the truncating model label', async () => {
    listModels.mockResolvedValue(catalog);
    const { container } = await renderComposer({
      model: 'fixture/kiki-pro',
      efforts: ['low', 'high'],
      effort: 'high',
    });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('Kiki Pro');
    expect(trigger.textContent).toContain('· high');
    const label = trigger.querySelector('span')!;
    expect(label.className).toContain('truncate');
    expect(label.textContent).not.toContain('high');
  });

  it('changes model and effort from the one panel', async () => {
    listModels.mockResolvedValue(catalog);
    const onChangeEffort = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({
      model: 'fixture/kiki-pro',
      efforts: ['low', 'high'],
      effort: 'high',
      onChangeEffort,
      onChangeModel,
    });
    for (let index = 0; index < 5; index += 1) await settle();
    await click(container.querySelector('#composer-model-select')!);
    await click(container.querySelector('[data-effort="low"]')!);
    expect(onChangeEffort).toHaveBeenCalledWith('low');
    const airRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.textContent?.includes('Kiki Air'),
    )!;
    await click(airRow);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-air');
  });

  it('keeps the effort row reachable when the catalog is empty', async () => {
    listModels.mockResolvedValue({ items: [] });
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({
      efforts: ['low', 'high'],
      effort: 'low',
      onChangeEffort,
    });
    for (let index = 0; index < 5; index += 1) await settle();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('fixture/kiki-pro');
    await click(trigger);
    // No catalog means no filter input and no option list — just the rows.
    expect(container.querySelector('#composer-model-select-list')).toBeNull();
    await click(container.querySelector('[data-effort="high"]')!);
    expect(onChangeEffort).toHaveBeenCalledWith('high');
  });

  it('treats an ambiguous bare alias as available, naming the serving provider', async () => {
    listModels.mockResolvedValue({
      items: [
        { provider: 'alpha', model: 'alpha/k3-256k', display_name: 'K3 256K' },
        { provider: 'beta', model: 'beta/k3-256k', display_name: 'K3 256K' },
      ],
    });
    const { container } = await renderComposer({ serverDefaultModel: 'k3-256k' });
    for (let index = 0; index < 5; index += 1) await settle();
    // The engine resolves the same alias to the first candidate — not "unavailable".
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('K3 256K');

    await click(trigger);
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(rows).toHaveLength(3);
    // The inherit row shows the resolved display name and the serving provider.
    expect(rows[0]?.textContent).toContain('inherit server default');
    expect(rows[0]?.textContent).toContain('K3 256K');
    expect(rows[0]?.textContent).toContain('alpha');
    // Catalog rows group by provider.
    const headers = [...container.querySelectorAll('#composer-model-select-list p')].map(
      (node) => node.textContent,
    );
    expect(headers).toContain('alpha');
    expect(headers).toContain('beta');
  });

  it('resolves a bare-alias override onto the first candidate row', async () => {
    listModels.mockResolvedValue({
      items: [
        { provider: 'alpha', model: 'alpha/k3-256k', display_name: 'K3 256K' },
        { provider: 'beta', model: 'beta/k3-256k', display_name: 'K3 256K' },
      ],
    });
    const { container } = await renderComposer({ model: 'k3-256k' });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('[data-selection-diagnostic]')).toBeNull();
    // The trigger shows the resolved row's display name, not the raw alias.
    const trigger = container.querySelector<HTMLButtonElement>('#composer-model-select')!;
    expect(trigger.textContent).toContain('K3 256K');
    expect(trigger.textContent).not.toContain('k3-256k');

    await click(trigger);
    const selected = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.getAttribute('aria-selected') === 'true',
    );
    expect(selected?.textContent).toContain('alpha/k3-256k');
  });
});

describe('Composer attachment button', () => {
  it('routes the browser file input into the paste/drop attachment path', async () => {
    const onChangeAttachments = vi.fn();
    const { container } = await renderComposer({ onChangeAttachments });
    const button = container.querySelector<HTMLButtonElement>('[data-attach-button]')!;
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    const clicked = vi.spyOn(input, 'click');
    await click(button);
    expect(clicked).toHaveBeenCalled();

    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // An upload stub lands immediately — the same reservation paste makes.
    expect(onChangeAttachments).toHaveBeenCalled();
  });

  it('rejects an oversized desktop pick before reading its contents', async () => {
    desktopRuntime.value = true;
    const read = vi.fn();
    selectFilesNative.mockResolvedValue([
      { name: 'huge.bin', size: 51 * 1024 * 1024, type: '', read },
    ]);
    const { container } = await renderComposer();

    await click(container.querySelector('[data-attach-button]')!);
    await settle();

    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      '"huge.bin" is 51.0 MB — files are capped at 50.0 MB each.',
    );
  });

  it('rejects a desktop pick at the attachment count cap before reading it', async () => {
    desktopRuntime.value = true;
    const read = vi.fn();
    selectFilesNative.mockResolvedValue([
      { name: 'ninth.txt', size: 4, type: 'text/plain', read },
    ]);
    const attachments = Array.from({ length: 8 }, (_, index) => ({
      kind: 'file' as const,
      path: `file-${index}.txt`,
      name: `file-${index}.txt`,
      isDir: false,
    }));
    const { container } = await renderComposer({ attachments });

    await click(container.querySelector('[data-attach-button]')!);
    await settle();

    expect(read).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(container.textContent).toContain('At most 8 attachments per message.');
  });
});

describe('Composer footer hints', () => {
  it('teaches an empty draft and steps aside once typing starts', async () => {
    const empty = await renderComposer({ value: '' });
    expect(empty.container.querySelector('[data-composer-hints]')).not.toBeNull();

    const typed = await renderComposer({ value: 'hello' });
    expect(typed.container.querySelector('[data-composer-hints]')).toBeNull();

    const working = await renderComposer({ value: '', busy: true });
    expect(working.container.querySelector('[data-composer-hints]')).toBeNull();
  });

  it('keeps the meter anchored whether the hints show or not', async () => {
    const contextUsage = { used: 1000, limit: 10_000 };
    const empty = await renderComposer({ value: '', contextUsage });
    const typed = await renderComposer({ value: 'hello', contextUsage });
    const spacerOf = (container: HTMLDivElement) =>
      container.querySelector<HTMLElement>('[data-composer-hints]')?.parentElement ??
      container.querySelector<HTMLElement>('.min-h-4');
    expect(spacerOf(empty.container)?.className).toBe(spacerOf(typed.container)?.className);
  });
});

describe('Composer sendDisabled', () => {
  it('blocks the send button without locking the textarea', async () => {
    const { container } = await renderComposer({ value: 'hello', sendDisabled: true });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(textarea?.disabled).toBe(false);
    expect(sendButton?.disabled).toBe(true);
  });

  it('explains the blocked send through the button tooltip', async () => {
    const { container } = await renderComposer({
      value: 'hello',
      sendDisabled: true,
      sendDisabledTitle: 'Pick a workspace first',
    });
    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(true);
    expect(sendButton?.getAttribute('title')).toBe('Pick a workspace first');
  });

  it('swallows the send shortcut while sendDisabled', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', sendDisabled: true, onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends on the send shortcut when sendDisabled stays at its default', async () => {
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('hello', []);
  });

  it('blocks duplicate Enter while VS Code turn preflight is pending', async () => {
    vscodeRuntime.value = true;
    const pending = deferred<string>();
    preparePrompt.mockReturnValue(pending.promise);
    const onSend = vi.fn();
    const { container } = await renderComposer({ value: 'hello', onSend });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(preparePrompt).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
    pending.resolve('hello');
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

const workspaceSkill = {
  name: 'review',
  description: 'Review the current diff for risks',
  path: '/skills/review/SKILL.md',
  source: 'project' as const,
};

async function openSlashMenu(container: HTMLDivElement): Promise<void> {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
  await act(async () => {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('Composer slash skill catalog', () => {
  it('loads workspace skills on /new without creating a session', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({
      value: '/',
      workspaceId: 'wd_fixture_0123456789ab',
    });
    for (let index = 0; index < 8; index += 1) await settle();

    expect(listWorkspaceSkills).toHaveBeenCalledWith('wd_fixture_0123456789ab');
    expect(listSessionSkills).not.toHaveBeenCalled();

    await openSlashMenu(container);
    const menu = container.querySelector('[data-composer-menu]');
    expect(menu?.textContent).toContain('/review');
    expect(menu?.textContent).toContain('/plan');
    expect(menu?.textContent).not.toContain('/fork');

    const empty = await renderComposer({ workspaceId: 'wd_fixture_0123456789ab' });
    expect(empty.container.querySelector('[data-composer-hints]')?.textContent).toContain('/ for skills');
  });

  it('keeps the live session catalog on /s/:id even when a workspace id is also set', async () => {
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderComposer({
      value: '/',
      sessionId: 'session_live',
      workspaceId: 'wd_fixture_0123456789ab',
    });
    for (let index = 0; index < 8; index += 1) await settle();

    expect(listSessionSkills).toHaveBeenCalledWith('session_live');
    expect(listWorkspaceSkills).not.toHaveBeenCalled();

    await openSlashMenu(container);
    expect(container.querySelector('[data-composer-menu]')?.textContent).toContain('/fork');
  });

  it('does not fetch skills without a session or workspace', async () => {
    const { container } = await renderComposer();
    for (let index = 0; index < 5; index += 1) await settle();
    expect(listSessionSkills).not.toHaveBeenCalled();
    expect(listWorkspaceSkills).not.toHaveBeenCalled();
    expect(container.querySelector('[data-composer-hints]')?.textContent).toContain('/ for shortcuts');
  });

  it('selects a command into the draft, shows source and args, and sends its catalog name once', async () => {
    const command = { ...workspaceSkill, name: 'plan', path: '/workspace/.kiki/commands/plan.md',
      prompt_command: true, disable_model_invocation: true, argument_hint: '<topic>' };
    listWorkspaceSkills.mockResolvedValue({ skills: [command] });
    const onChange = vi.fn();
    const onActivateSkill = vi.fn();
    const onChangePlanMode = vi.fn();
    const attachments = [{ kind: 'file' as const, path: '/workspace/note.txt', name: 'note.txt', isDir: false }];
    const rendered = await renderComposer({ value: '/', workspaceId: 'workspace-command',
      onChange, onActivateSkill, onChangePlanMode, attachments });
    await openSlashMenu(rendered.container);
    const row = [...rendered.container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find((button) => button.textContent?.includes('/skill:plan'))!;
    expect(row.textContent).toContain('<topic>');
    expect(row.textContent).toContain('project');
    await act(async () => { row.click(); });
    expect(onChange).toHaveBeenLastCalledWith('/skill:plan ');
    expect(onActivateSkill).not.toHaveBeenCalled();
    expect(onChangePlanMode).not.toHaveBeenCalled();
    await rendered.rerender({ value: '/skill:plan menu options', workspaceId: 'workspace-command',
      onChange, onActivateSkill, onChangePlanMode, attachments });
    await act(async () => {
      rendered.container.querySelector('textarea[data-composer]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onActivateSkill).toHaveBeenCalledExactlyOnceWith('plan', 'menu options', attachments);
    expect(onChangePlanMode).not.toHaveBeenCalled();
  });

  it('runs VS Code autosave preflight before activating a workspace skill', async () => {
    vscodeRuntime.value = true;
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(preparePrompt).toHaveBeenCalledWith('', expect.any(String), false);
    expect(onActivateSkill).toHaveBeenCalledWith('review', '--fix', []);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('activates Tauri skills synchronously without VS Code preflight state', async () => {
    desktopRuntime.value = true;
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onActivateSkill = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onActivateSkill,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onActivateSkill).toHaveBeenCalledWith('review', '--fix', []);
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
  });

  it('sends a slash skill as prompt text when onActivateSkill is omitted', async () => {
    listWorkspaceSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const onSend = vi.fn();
    const { container } = await renderComposer({
      value: '/review --fix',
      workspaceId: 'wd_fixture_0123456789ab',
      onSend,
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('/review --fix', []);
  });
});

// ---- C-1/C-2/C-3: history recall, undo/redo, skill preview ----

type ComposerProps = Parameters<typeof Composer>[0];

/**
 * Stateful harness: the real parents (SessionView, /new) own the draft and
 * clear it parent-side after a send — no input event, no undo snapshot. The
 * history/undo tests need exactly that controlled round-trip.
 */
function StatefulHarness({
  onSend,
  ...props
}: Partial<ComposerProps>) {
  const [text, setText] = useState('');
  return (
    <Composer
      busy={false}
      disabled={false}
      model={undefined}
      defaultModel={undefined}
      serverDefaultModel="fixture/kiki-pro"
      modelSource="server-default"
      agentProfileCatalogMode={{ mode: 'global' }}
      permissionMode="manual"
      planMode={false}
      swarmMode={false}
      goalObjective=""
      goalStatus={undefined}
      goalControl={undefined}
      efforts={undefined}
      effort={undefined}
      attachments={[]}
      onChangeAttachments={() => {}}
      onChangeModel={() => {}}
      onChangePermissionMode={() => {}}
      onChangePlanMode={() => {}}
      onChangeSwarmMode={() => {}}
      onChangeGoalObjective={() => {}}
      onChangeGoalControl={() => {}}
      onChangeEffort={() => {}}
      value={text}
      onChange={setText}
      onSend={(sentText, sentAttachments) => {
        setText('');
        onSend?.(sentText, sentAttachments);
      }}
      {...props}
    />
  );
}

async function renderStatefulComposer(
  props: Partial<ComposerProps> = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <MemoryRouter>
            <StatefulHarness {...props} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

function composerTextarea(container: HTMLDivElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
}

/** Set the textarea value through the native setter and fire the input event. */
async function typeText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(
  textarea: HTMLTextAreaElement,
  init: KeyboardEventInit,
): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

/** Flush the requestAnimationFrame caret landings (jsdom rAF runs on a timer). */
async function flushCaret(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('Composer input history', () => {
  it('recalls sent prompts with ArrowUp from an empty draft and walks both ways', async () => {
    pushInputHistory('s_hist', 'first prompt');
    pushInputHistory('s_hist', 'second prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);
    expect(textarea.value).toBe('');

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('second prompt');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first prompt');
    // The oldest entry sticks — no wrap-around.
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first prompt');
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('second prompt');
    // ArrowDown past the newest entry hands the pre-browse draft back.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('');
  });

  it('Escape exits recall and restores the in-progress draft', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'draft in progress');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
    await pressKey(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('draft in progress');
    // A second Escape is not ours anymore (nothing left to restore).
    await pressKey(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('draft in progress');
  });

  it('an edit during recall ends the browse and keeps the edited text', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
    await typeText(textarea, 'older prompt, edited');
    // No longer browsing: ArrowDown is not a recall key now.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('older prompt, edited');
  });

  it('refuses to enter history when the caret sits past the first line', async () => {
    pushInputHistory('s_hist', 'older prompt');
    const { container } = await renderStatefulComposer({ sessionId: 's_hist' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'line one\nline two');
    // The native setter landed the caret at the end (second line).
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('line one\nline two');
    // A caret on the FIRST line of a non-empty draft still enters history.
    await act(async () => {
      textarea.setSelectionRange(2, 2);
    });
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('older prompt');
  });

  it('records a send and recalls it afterwards', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ sessionId: 's_send', onSend });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'ship it');
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ship it', []);
    expect(readInputHistory('s_send')).toEqual(['ship it']);
    // The harness cleared the draft parent-side; ↑ brings the prompt back.
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('ship it');
    // Consecutive duplicate sends dedupe.
    await pressKey(textarea, { key: 'Enter' });
    expect(readInputHistory('s_send')).toEqual(['ship it']);
  });

  it('keeps ↑/↓ with an open slash menu — recall never intercepts them', async () => {
    pushInputHistory('s_menu', 'older prompt');
    listSessionSkills.mockResolvedValue({ skills: [workspaceSkill] });
    const { container } = await renderStatefulComposer({
      sessionId: 's_menu',
    });
    for (let index = 0; index < 8; index += 1) await settle();
    const textarea = composerTextarea(container);

    await typeText(textarea, '/');
    await settle();
    const menu = container.querySelector('[data-composer-menu]');
    expect(menu).not.toBeNull();
    const selected = () =>
      [...container.querySelectorAll<HTMLElement>('[data-composer-menu] [role="option"]')]
        .findIndex((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected()).toBe(0);
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(selected()).toBe(0);
    // The draft is untouched — no recall happened behind the menu.
    expect(textarea.value).toBe('/');
  });

  it('shows the history hint on an empty draft only when history exists', async () => {
    const bare = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(
      bare.container.querySelector('[data-composer-hints]')?.textContent,
    ).not.toContain('history');

    pushInputHistory('s_hint', 'older prompt');
    const seeded = await renderStatefulComposer({ sessionId: 's_hint' });
    expect(seeded.container.querySelector('[data-composer-hints]')?.textContent).toContain(
      '↑ for history',
    );
  });
});

describe('Composer undo/redo', () => {
  it('walks the local stack with caret positions and redo', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_undo' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'hello');
    await typeText(textarea, 'hello world');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('hello');
    await flushCaret();
    expect(textarea.selectionStart).toBe(5);
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('');
    // The stack is empty now — further Ctrl+Z is a no-op.
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('hello');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('hello world');
    await flushCaret();
    expect(textarea.selectionStart).toBe(11);
  });

  it('a fresh edit clears the redo lane', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_redo' });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'a');
    await typeText(textarea, 'ab');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('a');
    await typeText(textarea, 'ax');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('ax');
  });

  it('caps the stack at 100 entries', async () => {
    const { container } = await renderStatefulComposer({ sessionId: 's_cap' });
    const textarea = composerTextarea(container);

    let value = '';
    for (let index = 0; index < 105; index += 1) {
      value += 'x';
      await typeText(textarea, value);
    }
    // 105 pushes, capped at 100: the five oldest snapshots fell off, so the
    // floor is the state before edit #6 — five characters.
    for (let index = 0; index < 100; index += 1) {
      await pressKey(textarea, { key: 'z', ctrlKey: true });
    }
    expect(textarea.value).toBe('xxxxx');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('xxxxx');
  });

  it('snapshots a sent prompt so Ctrl+Z resurrects it', async () => {
    const onSend = vi.fn();
    const { container } = await renderStatefulComposer({ sessionId: 's_send_undo', onSend });
    const textarea = composerTextarea(container);

    await typeText(textarea, 'ship it');
    await pressKey(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('ship it', []);
    expect(textarea.value).toBe('');
    await pressKey(textarea, { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('ship it');
    await pressKey(textarea, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(textarea.value).toBe('');
  });
});

describe('Composer skill preview card', () => {
  const descSkill = {
    name: 'review',
    description: 'Review the current diff for risks',
    path: '/skills/review/SKILL.md',
    source: 'project' as const,
  };
  const bareSkill = {
    name: 'silent',
    description: '',
    path: '/skills/silent/SKILL.md',
    source: 'user' as const,
  };

  async function openPreviewMenu(container: HTMLDivElement): Promise<HTMLTextAreaElement> {
    const textarea = composerTextarea(container);
    await typeText(textarea, '/');
    for (let index = 0; index < 8; index += 1) await settle();
    expect(container.querySelector('[data-composer-menu]')).not.toBeNull();
    return textarea;
  }

  it('shows the full description for the keyboard-active skill row', async () => {
    listSessionSkills.mockResolvedValue({ skills: [descSkill, bareSkill] });
    const { container } = await renderStatefulComposer({ sessionId: 's_prev' });
    const textarea = await openPreviewMenu(container);

    const preview = container.querySelector('[data-skill-preview]');
    expect(preview?.textContent).toContain('/review');
    expect(preview?.textContent).toContain('Review the current diff for risks');
    expect(preview?.textContent).toContain('/skills/review/SKILL.md');

    // The skill with an empty description degrades to no card…
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
    // …and so do the client shortcut rows.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
    await pressKey(textarea, { key: 'ArrowUp' });
    await pressKey(textarea, { key: 'ArrowUp' });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');
  });

  it('follows the pointer over the keyboard selection and back', async () => {
    listSessionSkills.mockResolvedValue({ skills: [descSkill, bareSkill] });
    const { container } = await renderStatefulComposer({ sessionId: 's_prev_hover' });
    const textarea = await openPreviewMenu(container);

    // Keyboard selection sits on row 0 (review); hover the silent row.
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-composer-menu] [role="option"]')];
    const silentRow = rows.find((row) => row.textContent?.includes('/silent'))!;
    await act(async () => {
      silentRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();

    const reviewRow = rows.find((row) => row.textContent?.includes('/review'))!;
    await act(async () => {
      reviewRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');

    // Leaving the menu returns the preview to the keyboard-active row…
    const menu = container.querySelector('[data-composer-menu]')!;
    await act(async () => {
      menu.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(container.querySelector('[data-skill-preview]')?.textContent).toContain('/review');
    // …which then follows ArrowDown onto the description-less skill: no card.
    await pressKey(textarea, { key: 'ArrowDown' });
    expect(container.querySelector('[data-skill-preview]')).toBeNull();
  });
});

describe('Composer restored selection diagnostics', () => {
  it('keeps a removed model visible, blocks sending, and keeps the input and reselect path usable', async () => {
    const onSend = vi.fn();
    const onChangeModel = vi.fn();
    const { container } = await renderComposer({ model: 'fixture/deleted', value: 'hello', onSend, onChangeModel });
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('fixture/deleted');
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-composer]')!;
    expect(input.disabled).toBe(false);
    await pressKey(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    await click(container.querySelector('#composer-model-select')!);
    const valid = [...container.querySelectorAll('[role="option"]')].find((node) => node.getAttribute('title') === 'fixture/kiki-pro')!;
    await click(valid);
    expect(onChangeModel).toHaveBeenCalledWith('fixture/kiki-pro');
  });

  it('preserves an incompatible effort and provides an explicit reset even on a model without efforts', async () => {
    const onChangeEffort = vi.fn();
    const { container } = await renderComposer({ effort: 'high', value: 'hello', onChangeEffort });
    expect(container.querySelector('[data-selection-diagnostic]')?.textContent).toContain('high');
    await click(container.querySelector('[data-selection-diagnostic] button')!);
    expect(onChangeEffort).toHaveBeenCalledWith(undefined);
  });
});

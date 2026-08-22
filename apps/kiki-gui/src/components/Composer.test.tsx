// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { NamedAgentProfile } from '../lib/client';
import { Composer } from './Composer';

const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { listModels, listSessionSkills, listNamedAgentProfiles } }),
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
  listModels.mockReset().mockResolvedValue({ items: [] });
  listSessionSkills.mockReset().mockResolvedValue({ skills: [] });
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
            <Composer
              busy={false}
              disabled={false}
              value=""
              onChange={() => {}}
              model={undefined}
              defaultModel={undefined}
              serverDefaultModel="fixture/kiki-pro"
              modelSource="server-default"
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
              {...props}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root };
}

/** Let react-query promises land and the re-render flush, on a macrotask cadence. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForTrigger(container: HTMLDivElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const trigger = container.querySelector<HTMLButtonElement>('#composer-agent-profile-select');
    if (trigger !== null) return trigger;
    await settle();
  }
  throw new Error('profile select never rendered');
}

describe('Composer agent profile picker', () => {
  it('renders the bound profile without a main suffix and lists only main profiles', async () => {
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
    expect(options.some((text) => text.includes('grok-only'))).toBe(true);
    expect(options.some((text) => text.includes('reviewer'))).toBe(false);
    expect(options.some((text) => text.includes('legacy'))).toBe(false);
    expect(options.some((text) => text.includes('main'))).toBe(false);
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

  it('stays hidden without a change handler or when the catalog is unavailable', async () => {
    const { container } = await renderComposer({ agentProfile: 'agent' });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(container.querySelector('#composer-agent-profile-select')).toBeNull();

    listNamedAgentProfiles.mockRejectedValue(new Error('404'));
    const second = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
    });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(second.container.querySelector('#composer-agent-profile-select')).toBeNull();
  });

  it('keeps a disabled main profile selectable while hiding subagent profiles', async () => {
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
    expect(options).toHaveLength(1);
    expect(options[0]).toContain('agent');
    expect(options.some((text) => text.includes('reviewer'))).toBe(false);
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

describe('Composer permission mode dropdown', () => {
  it('shows the current mode on the trigger and opens the option panel', async () => {
    const { container } = await renderComposer({ permissionMode: 'auto' });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Permission mode"]');
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
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Permission mode"]')!;
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
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Permission mode"]')!;
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
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Permission mode"]')!;
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
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import type { NamedAgentProfile } from '../lib/client';
import { Composer } from './Composer';

const { selectFilesNative, desktopRuntime } = vi.hoisted(() => ({
  selectFilesNative: vi.fn(),
  desktopRuntime: { value: false },
}));
const listModels = vi.fn();
const listSessionSkills = vi.fn();
const listNamedAgentProfiles = vi.fn();
const uploadFile = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: { listModels, listSessionSkills, listNamedAgentProfiles, uploadFile },
  }),
}));
vi.mock('../lib/desktop', () => ({
  isDesktopRuntime: () => desktopRuntime.value,
  selectFilesNative,
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
  uploadFile.mockReset().mockResolvedValue({ id: 'file-1' });
  selectFilesNative.mockReset();
  desktopRuntime.value = false;
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

/** Click through an element and let the resulting render flush. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * The agent-profile picker lives inside the merged model chip's panel, so
 * reaching it means opening that chip first (and waiting for both catalogs).
 */
async function waitForTrigger(container: HTMLDivElement): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const chip = container.querySelector<HTMLButtonElement>('#composer-model-select');
    if (chip !== null) {
      if (chip.getAttribute('aria-expanded') !== 'true') await click(chip);
      const trigger = container.querySelector<HTMLButtonElement>('#composer-agent-profile-select');
      if (trigger !== null) return trigger;
    }
    await settle();
  }
  throw new Error('profile select never rendered');
}

/** Open the mode chip's panel and hand back its trigger. */
async function openModePanel(container: HTMLDivElement): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
  await click(trigger);
  return trigger;
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
    // With no model catalog and no effort either, the chip degrades to inert
    // text — there is no panel left to hold a profile row.
    expect(container.querySelector('#composer-model-select')).toBeNull();
    expect(container.querySelector('#composer-agent-profile-select')).toBeNull();

    listNamedAgentProfiles.mockRejectedValue(new Error('404'));
    const second = await renderComposer({
      agentProfile: 'agent',
      onChangeAgentProfile: () => {},
    });
    for (let index = 0; index < 5; index += 1) await settle();
    expect(second.container.querySelector('#composer-model-select')).toBeNull();
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

  it('spells the active combination on the trigger', async () => {
    const { container } = await renderComposer({
      permissionMode: 'manual',
      planMode: true,
      swarmMode: true,
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Mode"]')!;
    expect(trigger.textContent).toContain('manual · plan · swarm');
  });

  it('reports plan and swarm from the panel and keeps it open for the next pick', async () => {
    const onChangePlanMode = vi.fn();
    const onChangeSwarmMode = vi.fn();
    const { container } = await renderComposer({ onChangePlanMode, onChangeSwarmMode });
    await openModePanel(container);
    const plan = container.querySelector<HTMLButtonElement>('[data-mode-switch="plan"]')!;
    const swarm = container.querySelector<HTMLButtonElement>('[data-mode-switch="swarm"]')!;
    expect(plan.getAttribute('aria-pressed')).toBe('false');
    await click(plan);
    await click(swarm);
    expect(onChangePlanMode).toHaveBeenCalledWith(true);
    expect(onChangeSwarmMode).toHaveBeenCalledWith(true);
    // Combinations are the point — the panel stays put between toggles.
    expect(container.querySelector('[data-mode-select] [role="option"]')).not.toBeNull();
  });

  it('expands the goal objective inside the same panel', async () => {
    const onChangeGoalObjective = vi.fn();
    const { container } = await renderComposer({ onChangeGoalObjective });
    await openModePanel(container);
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

  it('leaves no plan, swarm or goal control in the resting toolbar', async () => {
    listModels.mockResolvedValue({
      items: [{ provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro' }],
    });
    const { container } = await renderComposer({ planMode: true, swarmMode: true });
    for (let index = 0; index < 5; index += 1) await settle();
    const buttons = [...container.querySelectorAll<HTMLElement>('[data-composer-toolbar] button')];
    // Attach, mode, model, send — and nothing else at rest.
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Attach files',
      'Mode',
      'Model',
      'Send message',
    ]);
    expect(buttons[1]?.textContent).toContain('manual · plan · swarm');
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
});

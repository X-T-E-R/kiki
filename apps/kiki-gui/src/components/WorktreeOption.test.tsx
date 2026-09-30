// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSettings, writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import type { NewSessionDraftState } from './NewSessionDraft';
import { WorktreeOption } from './WorktreeOption';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  writeSettings({ worktreeSkipConfirm: false });
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  for (const node of [...document.body.querySelectorAll('[role="alertdialog"]')]) node.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function draftState(
  overrides: Partial<NewSessionDraftState> = {},
): NewSessionDraftState & { setWorktreeRequested: ReturnType<typeof vi.fn> } {
  return {
    worktreeAvailability: { kind: 'ready', root: 'C:/repo' },
    worktreeRequested: false,
    busy: false,
    setWorktreeRequested: vi.fn(),
    ...overrides,
  } as unknown as NewSessionDraftState & { setWorktreeRequested: ReturnType<typeof vi.fn> };
}

async function renderOption(state: NewSessionDraftState): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <WorktreeOption state={state} />
      </I18nProvider>,
    );
  });
  return container;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function dialogButton(label: string): HTMLButtonElement {
  const button = [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  expect(button, `dialog button "${label}"`).toBeDefined();
  return button!;
}

describe('WorktreeOption', () => {
  it.each([{ kind: 'hidden' }, { kind: 'not-git' }, { kind: 'remote' }] as const)(
    'renders nothing while the target is $kind',
    async (availability) => {
      const container = await renderOption(draftState({ worktreeAvailability: availability }));
      expect(container.querySelector('[data-new-worktree]')).toBeNull();
    },
  );

  it('asks once before turning on, and cancel leaves the switch off', async () => {
    const state = draftState();
    const container = await renderOption(state);
    const toggle = container.querySelector<HTMLInputElement>('[data-new-worktree-toggle]')!;
    await act(async () => { click(toggle); });
    expect(state.setWorktreeRequested).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('kiki/');
    expect(dialog()?.textContent).toContain('~/.kiki/worktrees/');

    await act(async () => { click(dialogButton('Cancel')); });
    expect(dialog()).toBeNull();
    expect(state.setWorktreeRequested).not.toHaveBeenCalled();

    await act(async () => { click(toggle); });
    await act(async () => { click(dialogButton('Turn on')); });
    expect(dialog()).toBeNull();
    expect(state.setWorktreeRequested).toHaveBeenCalledWith(true);
    expect(readSettings().worktreeSkipConfirm).toBe(false);
  });

  it('"Don’t ask again" skips the dialog from then on and Settings can bring it back', async () => {
    const state = draftState();
    const container = await renderOption(state);
    const toggle = container.querySelector<HTMLInputElement>('[data-new-worktree-toggle]')!;
    await act(async () => { click(toggle); });
    await act(async () => { click(dialog()!.querySelector('[data-new-worktree-skip-confirm]')!); });
    await act(async () => { click(dialogButton('Turn on')); });
    expect(readSettings().worktreeSkipConfirm).toBe(true);

    const again = draftState();
    const second = await renderOption(again);
    await act(async () => { click(second.querySelector<HTMLInputElement>('[data-new-worktree-toggle]')!); });
    expect(dialog()).toBeNull();
    expect(again.setWorktreeRequested).toHaveBeenCalledWith(true);
  });

  it('turning back off never asks', async () => {
    const state = draftState({ worktreeRequested: true });
    const container = await renderOption(state);
    await act(async () => { click(container.querySelector<HTMLInputElement>('[data-new-worktree-toggle]')!); });
    expect(dialog()).toBeNull();
    expect(state.setWorktreeRequested).toHaveBeenCalledWith(false);
  });
});

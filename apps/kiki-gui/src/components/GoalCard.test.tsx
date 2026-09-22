// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { GoalSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ApiError } from '../lib/client';
import { GoalCard, RecoveryHoldBar } from './GoalCard';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function goalFixture(patch: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'Ship the batch',
    status: 'active',
    followUpTiming: 'subagents_done',
    controlRevision: 2,
    turnsUsed: 1,
    tokensUsed: 100,
    wallClockMs: 1000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    ...patch,
  };
}

async function renderCard(
  props: Partial<Parameters<typeof GoalCard>[0]> = {},
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <GoalCard
          goal={goalFixture()}
          onRefresh={() => Promise.resolve(goalFixture())}
          onUpdate={() => Promise.resolve(goalFixture())}
          onPause={() => Promise.resolve()}
          onResume={() => Promise.resolve()}
          onCancel={() => Promise.resolve()}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return { container, root };
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function keyDown(element: Element, key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('GoalCard', () => {
  it('shows the objective, status, and follow-up timing with pause + cancel for an active goal', async () => {
    const { container } = await renderCard();
    const card = container.querySelector('[data-goal-card]')!;
    expect(card.textContent).toContain('Ship the batch');
    expect(card.textContent).toContain('active');
    expect(card.textContent).toContain('Subagents done');
    expect(card.querySelector('button[title^="Pause the goal"]')).not.toBeNull();
    expect(card.querySelector('button[title^="Resume the goal"]')).toBeNull();
  });

  it('offers resume instead of pause for a paused goal', async () => {
    const onResume = vi.fn(() => Promise.resolve());
    const { container } = await renderCard({ goal: goalFixture({ status: 'paused' }), onResume });
    expect(container.querySelector('button[title^="Resume the goal"]')).not.toBeNull();
    expect(container.querySelector('button[title^="Pause the goal"]')).toBeNull();
    await click(container.querySelector('button[title^="Resume the goal"]')!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before resuming a blocked goal and lets Escape disarm it', async () => {
    const onResume = vi.fn(() => Promise.resolve());
    const { container } = await renderCard({ goal: goalFixture({ status: 'blocked' }), onResume });
    const resume = container.querySelector('button[title^="Resume this blocked goal"]')!;
    await click(resume);
    expect(onResume).not.toHaveBeenCalled();
    const armed = container.querySelector('button[title="Resume goal?"]')!;
    const escape = await keyDown(armed, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('button[title="Resume goal?"]')).toBeNull();
    await click(container.querySelector('button[title^="Resume this blocked goal"]')!);
    await click(container.querySelector('button[title="Resume goal?"]')!);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('hides itself once the goal is complete', async () => {
    const { container } = await renderCard({ goal: goalFixture({ status: 'complete' }) });
    expect(container.querySelector('[data-goal-card]')).toBeNull();
  });

  it('arms cancel, lets Escape disarm it, and cancels on the confirmed click', async () => {
    const onCancel = vi.fn(() => Promise.resolve());
    const { container } = await renderCard({ onCancel });
    await click(container.querySelector('button[title^="Cancel the goal"]')!);
    expect(onCancel).not.toHaveBeenCalled();
    const escape = await keyDown(container.querySelector('button[title="Cancel goal?"]')!, 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('button[title="Cancel goal?"]')).toBeNull();
    await click(container.querySelector('button[title^="Cancel the goal"]')!);
    await click(container.querySelector('button[title="Cancel goal?"]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('edits against the refreshed goalId + revision and saves the form values', async () => {
    const onRefresh = vi.fn(() =>
      Promise.resolve(goalFixture({ goalId: 'goal-real', controlRevision: 7, objective: 'Fresh objective' })),
    );
    const onUpdate = vi.fn(() => Promise.resolve(goalFixture()));
    const { container } = await renderCard({ onRefresh, onUpdate });
    await click(container.querySelector('button[title^="Edit the objective"]')!);
    await settle();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    const objective = container.querySelector<HTMLTextAreaElement>('[data-goal-editor] textarea')!;
    expect(objective.value).toBe('Fresh objective');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(objective, 'Rewritten objective');
      objective.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(container.querySelector('[data-goal-editor] [data-goal-timing="tasks_done"]')!);
    await click(container.querySelector('[data-goal-save]')!);
    await settle();
    expect(onUpdate).toHaveBeenCalledWith({
      goalId: 'goal-real',
      expectedRevision: 7,
      objective: 'Rewritten objective',
      completionCriterion: null,
      followUpTiming: 'tasks_done',
    });
  });

  it('reloads the form and says so when the revision conflicts', async () => {
    const onRefresh = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(goalFixture({ controlRevision: 2 })))
      .mockImplementationOnce(() =>
        Promise.resolve(goalFixture({ controlRevision: 5, objective: 'Concurrent edit' })),
      );
    const onUpdate = vi.fn(() =>
      Promise.reject(new ApiError({ code: 40001, msg: 'The goal definition revision changed', data: null })),
    );
    const { container } = await renderCard({ onRefresh, onUpdate });
    await click(container.querySelector('button[title^="Edit the objective"]')!);
    await settle();
    await click(container.querySelector('[data-goal-save]')!);
    await settle();
    expect(container.querySelector('[data-goal-conflict]')?.textContent).toContain('changed elsewhere');
    // The form reseeded from the authoritative snapshot.
    const objective = container.querySelector<HTMLTextAreaElement>('[data-goal-editor] textarea')!;
    expect(objective.value).toBe('Concurrent edit');
  });

  it('shows a non-conflict update failure inline', async () => {
    const onUpdate = vi.fn(() => Promise.reject(new Error('network down')));
    const { container } = await renderCard({ onUpdate });
    await click(container.querySelector('button[title^="Edit the objective"]')!);
    await settle();
    await click(container.querySelector('[data-goal-save]')!);
    await settle();
    expect(container.querySelector('[data-goal-error]')?.textContent).toContain('network down');
  });

  it('shows a pause failure inline and keeps the goal visible', async () => {
    const onPause = vi.fn(() => Promise.reject(new Error('engine busy')));
    const { container } = await renderCard({ onPause });
    await click(container.querySelector('button[title^="Pause the goal"]')!);
    await settle();
    expect(container.querySelector('[data-goal-error]')?.textContent).toContain('engine busy');
    expect(container.querySelector('[data-goal-card]')).not.toBeNull();
  });
});

describe('RecoveryHoldBar', () => {
  async function renderBar(
    props: Partial<Parameters<typeof RecoveryHoldBar>[0]> = {},
  ): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <RecoveryHoldBar count={2} pending={false} onConfirm={() => {}} {...props} />
        </I18nProvider>,
      );
    });
    return { container, root };
  }

  it('announces the restored queue and confirms through onConfirm', async () => {
    const onConfirm = vi.fn();
    const { container } = await renderBar({ count: 2, onConfirm });
    const bar = container.querySelector('[data-recovery-hold]')!;
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.textContent).toContain('2 queued messages were restored');
    await click(bar.querySelector('button:not([disabled])')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons while confirmation is pending', async () => {
    const { container } = await renderBar({ pending: true });
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-recovery-hold] button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.disabled).toBe(true);
  });

  it('keeps a usable resume entry after clicking Later without confirming the queue', async () => {
    const onConfirm = vi.fn();
    const { container, root } = await renderBar({ onConfirm });
    await click(container.querySelectorAll('[data-recovery-hold] button')[1]!);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.querySelector('[data-recovery-hold]')).toBeNull();
    const compact = container.querySelector('[data-recovery-hold-compact]')!;
    expect(compact.getAttribute('role')).toBe('status');
    expect(compact.textContent).toContain('Resume queue');
    expect(compact.textContent).not.toContain('Later');
    await click(compact.querySelector('button')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<I18nProvider><RecoveryHoldBar count={2} pending onConfirm={onConfirm} /></I18nProvider>);
    });
    const pendingButton = container.querySelector<HTMLButtonElement>('[data-recovery-hold-compact] button')!;
    expect(pendingButton.disabled).toBe(true);
    await click(pendingButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => { root.render(null); });
    await act(async () => {
      root.render(<I18nProvider><RecoveryHoldBar count={1} pending={false} onConfirm={onConfirm} /></I18nProvider>);
    });
    expect(container.querySelector('[data-recovery-hold]')).not.toBeNull();
    expect(container.querySelector('[data-recovery-hold-compact]')).toBeNull();
  });
});

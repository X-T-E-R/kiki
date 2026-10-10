// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ComposerHeader, type ComposerHeaderSection } from './ComposerHeader';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { for (const container of containers.splice(0)) container.remove(); });
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

function section(id: string, patch: Partial<ComposerHeaderSection> = {}): ComposerHeaderSection {
  return {
    summary: `${id} summary`,
    ariaLabel: `${id} detail`,
    panel: <p data-panel={id}>{id} panel</p>,
    ...patch,
  };
}

type Props = Parameters<typeof ComposerHeader>[0];

async function renderHeader(props: Props): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  await act(async () => { root.render(<ComposerHeader {...props} />); });
  return { container, root };
}

const half = (container: HTMLElement, id: 'goal' | 'queue') =>
  container.querySelector<HTMLButtonElement>(`[data-header-toggle="${id}"]`)!;
const panel = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="region"]')!;

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

describe('ComposerHeader', () => {
  it('renders nothing without a goal or a queue, so the composer stays as it is', async () => {
    const { container } = await renderHeader({});
    expect(container.querySelector('[data-composer-header]')).toBeNull();
  });

  it('shows the row text of both halves, goal first, with the queue alone when there is no goal', async () => {
    const { container } = await renderHeader({ goal: section('goal'), queue: section('queue') });
    const halves = Array.from(container.querySelectorAll('[data-header-toggle]'));
    expect(halves.map((node) => node.getAttribute('data-header-toggle'))).toEqual(['goal', 'queue']);
    expect(halves.map((node) => node.textContent)).toEqual(['goal summary', 'queue summary']);
    const alone = await renderHeader({ queue: section('queue') });
    expect(alone.container.querySelectorAll('[data-header-toggle]')).toHaveLength(1);
  });

  it('expands one detail at a time from aria-wired disclosure buttons', async () => {
    const { container } = await renderHeader({ goal: section('goal'), queue: section('queue') });
    const goal = half(container, 'goal');
    const queue = half(container, 'queue');
    expect(goal.getAttribute('aria-expanded')).toBe('false');
    expect(goal.getAttribute('aria-controls')).toBe(panel(container).id);
    expect(panel(container).hasAttribute('data-open')).toBe(false);

    await click(goal);
    expect(goal.getAttribute('aria-expanded')).toBe('true');
    expect(panel(container).getAttribute('aria-label')).toBe('goal detail');
    expect(container.querySelector('[data-panel="goal"]')).not.toBeNull();

    await click(queue);
    expect(goal.getAttribute('aria-expanded')).toBe('false');
    expect(queue.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-panel="goal"]')).toBeNull();
    expect(container.querySelector('[data-panel="queue"]')).not.toBeNull();

    await click(queue);
    expect(queue.getAttribute('aria-expanded')).toBe('false');
    expect(panel(container).hasAttribute('data-open')).toBe(false);
  });

  it('collapses on Escape (focus back on its half) and on a click outside the card row', async () => {
    const { container } = await renderHeader({ goal: section('goal') });
    const goal = half(container, 'goal');
    await click(goal);
    goal.focus();
    await pressEscape();
    expect(goal.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(goal);

    await click(goal);
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(goal.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a forced detail open through Escape, outside clicks and its own button', async () => {
    const { container } = await renderHeader({ goal: section('goal'), queue: section('queue', { forceOpen: true }) });
    const queue = half(container, 'queue');
    expect(queue.getAttribute('aria-expanded')).toBe('true');
    await pressEscape();
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await click(queue);
    await click(half(container, 'goal'));
    expect(queue.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes from the sheet backdrop (the phone outside-tap path)', async () => {
    const { container } = await renderHeader({ queue: section('queue') });
    const queue = half(container, 'queue');
    expect(container.querySelector('[data-header-backdrop]')).toBeNull();
    await click(queue);
    const backdrop = container.querySelector<HTMLElement>('[data-header-backdrop]')!;
    expect(backdrop).not.toBeNull();
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(queue.getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores the backdrop while a detail is pinned open (the queue edit hold)', async () => {
    const { container } = await renderHeader({ queue: section('queue', { forceOpen: true }) });
    const queue = half(container, 'queue');
    expect(queue.getAttribute('aria-expanded')).toBe('true');
    const backdrop = container.querySelector<HTMLElement>('[data-header-backdrop]')!;
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(queue.getAttribute('aria-expanded')).toBe('true');
  });

  it('fades the queue text once when its count grows after the session settled, never on the cold load', async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { container, root } = await renderHeader({ goal: section('goal'), settled: false });
    await act(async () => { root.render(<ComposerHeader goal={section('goal')} settled />); });
    now += 100;
    await act(async () => {
      root.render(<ComposerHeader goal={section('goal')} queue={section('queue', { count: 1 })} settled />);
    });
    expect(half(container, 'queue').hasAttribute('data-bump')).toBe(false);

    now += 2_000;
    await act(async () => {
      root.render(<ComposerHeader goal={section('goal')} queue={section('queue', { count: 2 })} settled />);
    });
    const first = half(container, 'queue').getAttribute('data-bump');
    expect(first).not.toBeNull();
    await act(async () => {
      root.render(<ComposerHeader goal={section('goal')} queue={section('queue', { count: 1 })} settled />);
    });
    expect(half(container, 'queue').getAttribute('data-bump')).toBe(first);
    await act(async () => {
      root.render(<ComposerHeader goal={section('goal')} queue={section('queue', { count: 2 })} settled />);
    });
    expect(half(container, 'queue').getAttribute('data-bump')).not.toBe(first);
    clock.mockRestore();
  });
});

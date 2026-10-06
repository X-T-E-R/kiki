// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AutoCompactStatus, ContextStrategyStatus } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from '../lib/toasts';
import { ContextMeter, type ContextMeterAutoCompact } from './ContextMeter';
import type { ContextStrategyHandle } from './useContextStrategy';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const mounted: { root: Root; container: HTMLDivElement }[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  clearToasts();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const point: AutoCompactStatus = { tokens: 467_500, source: 'legacy', effectiveMaxContextTokens: 550_000, reservedContextTokens: 50_000 };
const st = (strategy: ContextStrategyStatus['strategy'], source: ContextStrategyStatus['source']): ContextStrategyStatus => ({ strategy, source, shadow: false });

function handle(initial: ContextStrategyStatus | undefined, overrides: Partial<ContextStrategyHandle> = {}): ContextStrategyHandle {
  return {
    status: initial,
    writable: true,
    refresh: vi.fn(),
    write: vi.fn(async (strategy) => st(strategy ?? 'auto', strategy === null ? 'default' : 'session')),
    saveGlobal: vi.fn(async (strategy) => st(strategy, 'global')),
    compact: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function render(strategy: ContextStrategyHandle | undefined, onCompact = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const autoCompact: ContextMeterAutoCompact = {
    status: point,
    running: false,
    modelLabel: 'Opus 5.5',
    profile: { name: 'builder', editable: true },
    onCommit: vi.fn(),
    onSave: vi.fn(),
    strategy,
  };
  await act(async () => {
    root.render(<I18nProvider><ContextMeter used={300_000} limit={550_000} autoCompact={autoCompact} onCompact={onCompact} /></I18nProvider>);
  });
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
  return container;
}

const click = async (element: Element | null) => {
  await act(async () => { (element as HTMLElement).click(); });
};

describe('ContextStrategySection', () => {
  it('shows the inherited main-agent default with auto checked and explains the summary fallback', async () => {
    const strategy = handle(st('auto', 'default'));
    const container = await render(strategy);
    const block = container.querySelector('[data-context-strategy]')!;
    expect(block.getAttribute('data-strategy-source')).toBe('default');
    expect(container.querySelector('[data-strategy-option="auto"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-strategy-option="summarize"]')?.getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('[data-strategy-hint]')?.textContent).toBe('Built-in main-agent default. Starts fresh when the work notes cover the work, otherwise summarizes.');
    expect(container.querySelector('[data-strategy-source-trigger]')?.textContent).toContain('Built-in default');
    expect(container.querySelector('[data-strategy-option="auto"]')?.textContent).toBe('Auto');
    expect(strategy.write).not.toHaveBeenCalled();
    expect(strategy.compact).not.toHaveBeenCalled();
  });

  it.each(['summarize', 'fresh'] as const)('keeps an explicit global %s selected', async (strategy) => {
    const container = await render(handle(st(strategy, 'global')));
    expect(container.querySelector(`[data-strategy-option="${strategy}"]`)?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-strategy-source-trigger]')?.textContent).toContain('Global default');
    expect(container.querySelector('[data-strategy-hint]')?.textContent).not.toContain('default.');
  });

  it('names the profile a strategy comes from', async () => {
    const container = await render(handle(st('fresh', 'profile')));
    expect(container.querySelector('[data-strategy-source-trigger]')?.textContent).toContain('From profile builder');
    expect(container.querySelector('[data-strategy-hint]')?.textContent).toContain('work notes');
  });

  it('writes a session override on pick and resets to the inherited layer', async () => {
    const strategy = handle(st('auto', 'default'));
    const container = await render(strategy);
    await click(container.querySelector('[data-strategy-option="fresh"]'));
    expect(strategy.write).toHaveBeenCalledWith('fresh');
    expect(container.querySelector('[data-strategy-note]')?.textContent).toBe('Applies from the next compaction.');

    const overridden = handle(st('fresh', 'session'));
    const next = await render(overridden);
    await click(next.querySelector('[data-strategy-source-trigger]'));
    await click(next.querySelector('[data-strategy-reset]'));
    expect(overridden.write).toHaveBeenCalledWith(null);
  });

  it('moves the selection with arrow keys', async () => {
    const strategy = handle(st('auto', 'default'));
    const container = await render(strategy);
    const group = container.querySelector('[role="radiogroup"]')!;
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(strategy.write).toHaveBeenCalledWith('summarize');
  });

  it('saves the choice globally and confirms it', async () => {
    const strategy = handle(st('auto', 'session'));
    const container = await render(strategy);
    await click(container.querySelector('[data-strategy-source-trigger]'));
    await click(container.querySelector('[data-strategy-save-global]'));
    expect(strategy.saveGlobal).toHaveBeenCalledWith('auto');
    expect(getToasts().at(-1)?.text).toBe('Auto is now the global default.');
  });

  it('reports a failed write inline', async () => {
    const strategy = handle(st('auto', 'default'), { write: vi.fn(async () => { throw new Error('boom'); }) });
    const container = await render(strategy);
    await click(container.querySelector('[data-strategy-option="auto"]'));
    const note = container.querySelector('[data-strategy-note]')!;
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toBe('Couldn’t change the strategy. Try again.');
  });

  it('locks the control for an external executor and a subagent', async () => {
    const executor = await render(handle(st('summarize', 'executor')));
    expect(executor.querySelector<HTMLButtonElement>('[data-strategy-option="fresh"]')?.disabled).toBe(true);
    expect(executor.querySelector('[data-strategy-source-trigger]')).toBeNull();
    expect(executor.querySelector('[data-context-compact-with]')).toBeNull();

    const sub = await render(handle(st('summarize', 'subagent'), { writable: false }));
    expect(sub.querySelector<HTMLButtonElement>('[data-strategy-option="auto"]')?.disabled).toBe(true);
    expect(sub.textContent).toContain('Per-session changes apply to the main agent only.');
  });

  it('omits the block on an engine without the route', async () => {
    const container = await render(undefined);
    expect(container.querySelector('[data-context-strategy]')).toBeNull();
    expect(container.querySelector('[data-context-compact-with]')).toBeNull();
    expect(container.querySelector('[data-context-compact]')).not.toBeNull();
  });

  it('compacts now with a chosen strategy', async () => {
    const onCompact = vi.fn();
    const strategy = handle(st('auto', 'default'));
    const container = await render(strategy, onCompact);
    await click(container.querySelector('[data-context-compact-with]'));
    await click(container.querySelector('[data-context-compact-option="fresh"]'));
    expect(strategy.compact).toHaveBeenCalledWith('fresh');
    expect(onCompact).not.toHaveBeenCalled();
    expect(getToasts().at(-1)?.text).toBe('Manual compaction requested.');
  });
});

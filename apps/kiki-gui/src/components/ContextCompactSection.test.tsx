// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AutoCompactStatus, AutoCompactWriteResult } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { clearToasts, getToasts } from '../lib/toasts';
import { ContextMeter, type ContextMeterAutoCompact } from './ContextMeter';

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
  vi.useRealTimers();
});
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const status = (tokens: number, source: AutoCompactStatus['source'], usable = 550_000): AutoCompactStatus => ({
  tokens, source, effectiveMaxContextTokens: usable, reservedContextTokens: 50_000,
});
const result = (effective: AutoCompactStatus, fallback: AutoCompactStatus, extra: Partial<AutoCompactWriteResult> = {}): AutoCompactWriteResult => ({
  effective, default: fallback, overrideCleared: false, ...extra,
});

async function render(props: { used: number; limit?: number; autoCompact?: ContextMeterAutoCompact }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const draw = async (next: typeof props) => {
    await act(async () => {
      root.render(<I18nProvider><ContextMeter used={next.used} limit={next.limit ?? 550_000} autoCompact={next.autoCompact} /></I18nProvider>);
    });
  };
  await draw(props);
  await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
  return { container, draw };
}

function wiring(overrides: Partial<ContextMeterAutoCompact> = {}): ContextMeterAutoCompact {
  return {
    status: status(467_500, 'legacy'),
    running: false,
    modelLabel: 'Opus 5.5',
    profile: { name: 'agent', editable: false },
    onCommit: vi.fn(async (tokens: number | null) => result(status(tokens ?? 467_500, tokens === null ? 'legacy' : 'session'), status(467_500, 'legacy'))),
    onSave: vi.fn(),
    ...overrides,
  };
}

function setRange(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ContextMeter with a compaction point', () => {
  it('colours the ring against the point, not the window', async () => {
    // 380k of 550k is 69% of the window (the old ratio would say amber) but
    // ≥ 80% of a 467.5k point: warn. 470k passes the point: danger.
    const { container, draw } = await render({ used: 300_000, autoCompact: wiring() });
    expect(container.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe('ok');
    await draw({ used: 380_000, autoCompact: wiring() });
    expect(container.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe('warn');
    await draw({ used: 470_000, autoCompact: wiring() });
    expect(container.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe('danger');
  });

  it('shows the source and remaining room, and keeps plain rows without a point', async () => {
    const { container } = await render({ used: 312_000, autoCompact: wiring() });
    const section = container.querySelector('[data-context-compact-section]');
    expect(section?.getAttribute('data-compact-source')).toBe('legacy');
    expect(section?.textContent).toContain('Default · 467.5k (built-in)');
    expect(section?.textContent).toContain('155.5k until automatic compaction.');
    expect(section?.textContent).toContain('Reserve 50k above the point.');

    const plain = await render({ used: 312_000 });
    expect(plain.container.querySelector('[data-context-compact-section]')).toBeNull();
    expect(plain.container.querySelector('[data-context-details]')?.textContent).toContain('Available');
  });

  it('updates the copy while dragging and commits only on release', async () => {
    const autoCompact = wiring();
    const { container } = await render({ used: 312_000, autoCompact });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => { setRange(slider, 296_000); });
    expect(autoCompact.onCommit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-compact-status]')?.textContent).toContain('Below current use. Compacts before your next message is answered.');
    // jsdom has no PointerEvent; React maps the `pointerup` type either way.
    await act(async () => { slider.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    expect(autoCompact.onCommit).toHaveBeenCalledTimes(1);
    expect(autoCompact.onCommit).toHaveBeenCalledWith(296_000);
  });

  it('says a running session compacts before the next step', async () => {
    const { container } = await render({ used: 430_000, autoCompact: wiring({ status: status(400_000, 'session'), running: true }) });
    expect(container.querySelector('[data-compact-status]')?.textContent).toContain('Compacts before the next step.');
    expect(container.querySelector('[data-compact-overflow]')).not.toBeNull();
  });

  it('commits arrow-key moves 600ms after the last key', async () => {
    vi.useFakeTimers();
    const autoCompact = wiring();
    const { container } = await render({ used: 100_000, autoCompact });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => {
      setRange(slider, 464_000);
      slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
      setRange(slider, 456_000);
      slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(autoCompact.onCommit).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(autoCompact.onCommit).toHaveBeenCalledTimes(1);
    expect(autoCompact.onCommit).toHaveBeenCalledWith(456_000);
  });

  it('parses typed input, clamps to the adjustable ceiling and says so', async () => {
    const autoCompact = wiring({
      onCommit: vi.fn(async (tokens: number | null) => result(status(tokens!, 'session'), status(467_500, 'legacy'))),
    });
    const { container } = await render({ used: 100_000, autoCompact });
    const input = container.querySelector<HTMLInputElement>('[data-compact-input]')!;
    const type = async (text: string) => {
      await act(async () => { input.focus(); });
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    };
    await type('73%');
    expect(autoCompact.onCommit).toHaveBeenLastCalledWith(401_500);
    await type('900k');
    expect(autoCompact.onCommit).toHaveBeenLastCalledWith(522_500);
    expect(container.querySelector('[data-compact-note]')?.textContent).toContain('Adjusted to 522.5k (highest adjustable point).');
    await type('lots');
    expect(container.querySelector('[data-compact-note]')?.textContent).toContain('Enter tokens like 400k');
    expect(autoCompact.onCommit).toHaveBeenCalledTimes(2);
  });

  it('offers presets that fit the model and marks the current one', async () => {
    const autoCompact = wiring({ status: status(350_000, 'session') });
    const { container } = await render({ used: 100_000, autoCompact });
    const presets = [...container.querySelectorAll<HTMLButtonElement>('[data-token-presets="compact"] [data-token-preset]')];
    expect(presets.map((button) => button.textContent)).toEqual(['250k', '350k', '400k']);
    expect(presets.find((button) => button.textContent === '350k')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { presets[0]!.click(); });
    expect(autoCompact.onCommit).toHaveBeenCalledWith(250_000);
  });

  it('drags a 358.6k window to exactly 95%, with only the final 5% hatched', async () => {
    const autoCompact = wiring({ status: status(304_810, 'legacy', 358_600) });
    const { container } = await render({ used: 100_000, limit: 358_600, autoCompact });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    expect(slider.max).toBe('340670');
    expect(slider.step).toBe('1');
    expect(container.querySelector<HTMLElement>('[data-compact-reserve]')?.style.width).toBe('5%');
    await act(async () => { setRange(slider, 340_670); });
    expect(container.querySelector<HTMLElement>('[data-compact-thumb]')?.style.left).toBe('95%');
    expect(container.querySelector('[data-compact-status]')?.textContent).toContain('Reserve 17.9k above the point.');
    expect(autoCompact.onCommit).not.toHaveBeenCalled();
    await act(async () => { slider.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
    expect(autoCompact.onCommit).toHaveBeenCalledWith(340_670);
  });

  it('keeps 8k keyboard moves and reaches the exact ceiling with End', async () => {
    vi.useFakeTimers();
    const autoCompact = wiring({ status: status(304_000, 'session', 358_600) });
    const { container } = await render({ used: 100_000, limit: 358_600, autoCompact });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(slider.value).toBe('312000');
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(slider.value).toBe('340670');
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(autoCompact.onCommit).toHaveBeenCalledWith(340_670);
  });

  it('locks the slider when the expanded window still leaves no room', async () => {
    const { container } = await render({ used: 10_000, limit: 64_000, autoCompact: wiring({ status: status(14_000, 'legacy', 64_000) }) });
    expect(container.querySelector('[data-compact-slider]')).toBeNull();
    expect(container.textContent).toContain('The window is too small to move the compaction point.');
  });

  it('labels a usable limit below the configured window', async () => {
    const { container } = await render({ used: 180_000, autoCompact: wiring({ status: status(250_000, 'legacy', 300_000) }) });
    expect(container.querySelector('[data-compact-limit]')?.textContent).toBe('Usable 300k / window 550k');
  });

  it('source menu: model default takes over and offers undo; built-in profile is disabled', async () => {
    const undo = vi.fn(async () => {});
    const onSave = vi.fn(async () => ({
      result: result(status(400_000, 'model'), status(400_000, 'model'), { overrideCleared: true, savedAs: 400_000 }),
      undo,
    }));
    const { container } = await render({ used: 100_000, autoCompact: wiring({ status: status(400_000, 'session'), onSave }) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-source-trigger]')!.click(); });
    const menu = container.querySelector('[data-compact-source-menu]')!;
    expect(menu.textContent).toContain('Default for Opus 5.5 (400k)');
    expect(menu.textContent).toContain('Global default (72.7%)');
    expect(menu.querySelector<HTMLButtonElement>('[data-compact-save="profile"]')?.disabled).toBe(true);
    expect(menu.querySelector('[data-compact-reset]')).not.toBeNull();
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-compact-save="model"]')!.click(); });
    expect(onSave).toHaveBeenCalledWith('model', 400_000);
    const toast = getToasts().at(-1);
    expect(toast?.text).toBe('Saved as the Opus 5.5 default: 400k.');
    toast?.retry?.run();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('says which layer still wins when a saved default cannot take over', async () => {
    const onSave = vi.fn(async () => ({
      result: result(status(420_000, 'session'), status(400_000, 'model'), { savedAs: '76.36363636%' }),
    }));
    const { container } = await render({ used: 100_000, autoCompact: wiring({ status: status(420_000, 'session'), onSave }) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-source-trigger]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-save="global"]')!.click(); });
    expect(container.querySelector('[data-compact-note]')?.textContent)
      .toBe('Saved as the global default (76.4%), but model sets 400k. This session stays at 420k.');
    expect(getToasts()).toHaveLength(0);
  });

  it('reset clears the session override with tokens: null', async () => {
    const autoCompact = wiring({ status: status(400_000, 'session') });
    const { container } = await render({ used: 100_000, autoCompact });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-source-trigger]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-reset]')!.click(); });
    expect(autoCompact.onCommit).toHaveBeenCalledWith(null);
  });

  it('explains a read-only profile rejection', async () => {
    const onSave = vi.fn(async () => { throw Object.assign(new Error('read only'), { code: 40934 }); });
    const { container } = await render({ used: 100_000, autoCompact: wiring({ profile: { name: 'custom', editable: true }, onSave }) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-source-trigger]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-compact-save="profile"]')!.click(); });
    expect(container.querySelector('[data-compact-note="error"]')?.textContent).toContain('Built-in profiles can’t be changed');
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { GlobalCompactionCard, inheritedCompactPoint, readLoopControl } from './ContextWindowSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), patchConfig: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider><GlobalCompactionCard /></I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

describe('GlobalCompactionCard', () => {
  it('shows the legacy ratio and replaces it with a percentage on save', async () => {
    client.getConfig.mockResolvedValue({ loop_control: { maxStepsPerTurn: 40, compactionTriggerRatio: 0.8 } });
    client.patchConfig.mockResolvedValue({ loop_control: { maxStepsPerTurn: 40, autoCompact: '75%' } });
    await render();
    const input = container.querySelector<HTMLInputElement>('[data-global-auto-compact]')!;
    expect(input.value).toBe('80');
    expect(container.textContent).toContain('older compaction_trigger_ratio (80%)');
    await type(input, '75');
    expect(client.patchConfig).toHaveBeenCalledWith({
      loop_control: { maxStepsPerTurn: 40, autoCompact: '75%' },
      replace_domains: ['loop_control'],
    });
  });

  it('refuses a percentage outside 1–100 without writing', async () => {
    client.getConfig.mockResolvedValue({ loop_control: { autoCompact: '85%' } });
    await render();
    const input = container.querySelector<HTMLInputElement>('[data-global-auto-compact]')!;
    expect(input.value).toBe('85');
    await type(input, '140');
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter a percentage between 1 and 100.');
  });
});

describe('inherited compaction point', () => {
  it('uses the global percentage, clamped to limit − reserve, or the legacy formula', () => {
    expect(inheritedCompactPoint(550_000, readLoopControl({ auto_compact: '85%' }))).toEqual({ tokens: 467_500, from: 'global', percent: '85%' });
    expect(inheritedCompactPoint(550_000, readLoopControl({ autoCompact: '95%' })).tokens).toBe(500_000);
    expect(inheritedCompactPoint(200_000, readLoopControl({}))).toEqual({ tokens: 150_000, from: 'legacy' });
    expect(inheritedCompactPoint(550_000, readLoopControl({ compactionSoftContextSize: 300_000 })).tokens).toBe(300_000);
  });
});

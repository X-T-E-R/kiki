// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsagePricingResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { PricingPanel, perMillion, perToken } from './PricingPanel';

const getUsagePricing = vi.fn();
const setUsagePricing = vi.fn();
const listModels = vi.fn();
const updateModel = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getUsagePricing, setUsagePricing, listModels, updateModel } }),
}));

const act_ = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const containers: HTMLDivElement[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  act_.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
});
afterAll(() => {
  act_.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

const RESPONSE: UsagePricingResponse = {
  items: [
    { model: 'k2', pricing_model: null, matched_key: 'k2', source: 'litellm-cache', prices: { input_cost_per_token: 0.6e-6, output_cost_per_token: 2.5e-6, currency: 'USD' } },
    { model: 'mystery-9', pricing_model: null, matched_key: null, source: 'unknown', prices: null },
    { model: 'mine', pricing_model: null, matched_key: 'mine', source: 'override', prices: { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 0.1e-6, currency: 'USD' } },
  ],
  overrides: { mine: { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6, cache_read_input_token_cost: 0.1e-6, currency: 'USD' } },
};

async function flush() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={client}>
        <I18nProvider><PricingPanel models={['mystery-9']} onClose={() => {}} /></I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const row = (model: string) => document.querySelector<HTMLElement>(`[data-pricing-row="${model}"]`)!;

beforeEach(() => {
  for (const mock of [getUsagePricing, setUsagePricing, listModels, updateModel]) mock.mockReset();
  getUsagePricing.mockResolvedValue(RESPONSE);
  setUsagePricing.mockResolvedValue(RESPONSE);
  listModels.mockResolvedValue({ items: [{ id: 'k2' }] });
  updateModel.mockResolvedValue({});
});

describe('PricingPanel', () => {
  it('converts between per-token wire prices and per-million figures', () => {
    expect(perMillion(2.5e-6)).toBe('2.5');
    expect(perMillion(undefined)).toBe('');
    expect(perToken('3')).toBeCloseTo(3e-6);
    expect(perToken('')).toBeUndefined();
    expect(perToken('-1')).toBeNull();
  });

  it('lists each model with its source and per-million prices; missing cache prices read unknown', async () => {
    await render();
    expect(getUsagePricing).toHaveBeenCalledWith(['mystery-9']);
    expect(row('k2').querySelector('[data-pricing-source]')?.textContent).toBe('LiteLLM catalog');
    expect(row('k2').textContent).toContain('$0.6');
    expect(row('k2').textContent).toContain('$2.5');
    // No cache prices on the wire: unknown, never $0.
    expect(row('k2').textContent).toContain('Unknown');
    expect(row('k2').textContent).not.toContain('$0 ');
    expect(row('mystery-9').querySelector('[data-pricing-source]')?.textContent).toBe('No price');
    expect(document.querySelector('[data-pricing-unknown-count]')?.textContent).toBe('1 without a price');
  });

  it('saves a typed price as a per-token override and the billing model through the model patch', async () => {
    await render();
    await act(async () => { row('k2').querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const inputs = [...row('k2').querySelectorAll<HTMLInputElement>('form input')];
    await act(async () => {
      setValue(inputs[0]!, '0.8');
      setValue(inputs[2]!, '');
      setValue(inputs[5]!, 'kimi-k2-thinking');
    });
    await act(async () => { row('k2').querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await flush();
    const override = setUsagePricing.mock.calls[0]![0].overrides.k2;
    expect(override.input_cost_per_token).toBeCloseTo(0.8e-6);
    expect(override.output_cost_per_token).toBeCloseTo(2.5e-6);
    expect(override).not.toHaveProperty('cache_read_input_token_cost');
    expect(override.currency).toBe('USD');
    expect(updateModel).toHaveBeenCalledWith('k2', { pricing_model: 'kimi-k2-thinking' });
  });

  it('refuses a missing required price and clears an override back to the catalog', async () => {
    await render();
    await act(async () => { row('mystery-9').querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    await act(async () => { row('mystery-9').querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
    await flush();
    expect(setUsagePricing).not.toHaveBeenCalled();
    expect(row('mystery-9').querySelector('[role="alert"]')).not.toBeNull();

    await act(async () => { row('mine').querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const clear = [...row('mine').querySelectorAll('button')].find((button) => button.textContent === 'Use the catalog price')!;
    await act(async () => { clear.click(); });
    await flush();
    expect(setUsagePricing).toHaveBeenCalledWith({ overrides: { mine: null } });
  });
});

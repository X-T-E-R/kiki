// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ToolPolicyCard } from './AutomationSection';
import { ExperimentalRows } from './ExperimentalRows';
import { pickOption } from './testControls';

interface FixtureConfig {
  tools: { enabled: string[]; disabled: string[] };
  hooks: unknown[];
  experimental: Record<string, boolean>;
}
let config: FixtureConfig;
const client = {
  getConfig: vi.fn(async () => structuredClone(config)),
  listTools: vi.fn(async () => ({ tools: ['Read', 'Write', 'ThreadCreate', 'ThreadList'].map((name) => ({ name, description: name, active: true })) })),
  meta: vi.fn(async () => ({ experimental_flags: { 'tool-select': false, task_wait: true, search_worker: true } })),
  patchConfig: vi.fn(async (patch: Record<string, any>) => {
    const { replace_domains: _, ...values } = patch;
    config = { ...config, ...values };
    return structuredClone(config);
  }),
};
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
const policy = (name: string) => container.querySelector(`[aria-label="Policy for ${name}"]`)!.closest('[data-tool-policy]')!;
const policyValue = (name: string) => policy(name).getAttribute('data-tool-policy');
async function pick(target: Element, label: string) { await pickOption(target, label); await flush(); }
async function click(text: string, scope: Element = container) {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent === text)!;
  expect(button, text).toBeTruthy();
  await act(async () => { button.click(); });
  await flush();
}
async function mount(view: 'automation' | 'rows' = 'automation') {
  await act(async () => root.render(<QueryClientProvider client={query}><I18nProvider>{view === 'rows' ? <ExperimentalRows section="mcp" /> : <ToolPolicyCard />}</I18nProvider></QueryClientProvider>));
  await flush();
  await flush();
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  config = { tools: { enabled: [], disabled: [] }, hooks: [], experimental: {} };
  client.patchConfig.mockClear();
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); query.clear(); });

describe('safe automation drafts', () => {
  it('lists ThreadCreate separately, defaults to inherited on and can disable only that tool', async () => {
    await mount();
    expect(policyValue('ThreadCreate')).toBe('inherited');
    expect(policyValue('ThreadList')).toBe('inherited');
    expect(policy('ThreadCreate').closest('div.grid')?.textContent).toContain('Currently available on this server');
    await pick(policy('ThreadCreate'), 'Deny');
    await click('Save tool policy');
    expect(config.tools).toEqual({ enabled: [], disabled: ['ThreadCreate'] });
    expect(policyValue('ThreadList')).toBe('inherited');
  });

  it('preserves tool edits across failed saves', async () => {
    await mount();
    await pick(policy('Write'), 'Deny');
    client.patchConfig.mockRejectedValueOnce(new Error('offline'));
    await click('Save tool policy');
    expect(container.textContent).toContain('offline');
    expect(policyValue('Write')).toBe('disabled');
    await click('Save tool policy');
    expect(config.tools.disabled).toEqual(['Write']);
  });

  it('saves each Experimental row on change, keeps other overrides and flags an environment override', async () => {
    await mount('rows');
    const rows = container.querySelector('#st-card-exp-mcp')!;
    expect(rows.querySelector('[data-experimental-row="tool-select"]')).not.toBeNull();
    expect(rows.querySelector('[data-experimental-row="search_worker"]')).toBeNull();
    const choose = async (flag: string, value: string) => {
      const button = rows.querySelector<HTMLButtonElement>(`[data-experimental-row="${flag}"] [data-experimental-choice="${value}"]`)!;
      await act(async () => { button.click(); });
      await flush();
    };
    config.experimental = { search_worker: false };
    await choose('tool-select', 'on');
    expect(config.experimental).toEqual({ search_worker: false, 'tool-select': true });
    // The server still reports it off: an env var outranks the saved choice.
    expect(rows.querySelector('[data-experimental-row="tool-select"] [data-flag-effective]')?.textContent).toBe('Currently off');
    expect(rows.querySelector('[data-experimental-row="tool-select"] [data-experimental-env]')).not.toBeNull();
    await choose('tool-select', 'default');
    expect(config.experimental).toEqual({ search_worker: false });
  });
});

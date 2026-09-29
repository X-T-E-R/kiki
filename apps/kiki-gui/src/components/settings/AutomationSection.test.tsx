// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { HooksSection, ToolPolicyCard } from './AutomationSection';
import { ExperimentalRows } from './ExperimentalRows';

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
async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(text: string, scope: Element = container) {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent === text)!;
  expect(button, text).toBeTruthy();
  await act(async () => { button.click(); });
  await flush();
}
async function mount(view: 'automation' | 'rows' = 'automation') {
  await act(async () => root.render(<QueryClientProvider client={query}><I18nProvider>{view === 'rows' ? <ExperimentalRows section="mcp" /> : <><ToolPolicyCard /><HooksSection /></>}</I18nProvider></QueryClientProvider>));
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
    const create = container.querySelector<HTMLSelectElement>('[aria-label="Policy for ThreadCreate"]')!;
    const list = container.querySelector<HTMLSelectElement>('[aria-label="Policy for ThreadList"]')!;
    expect(create.value).toBe('inherited');
    expect(list.value).toBe('inherited');
    expect(create.closest('div.grid')?.textContent).toContain('Currently available on this server');
    await change(create, 'disabled');
    await click('Save tool policy');
    expect(config.tools).toEqual({ enabled: [], disabled: ['ThreadCreate'] });
    expect(list.value).toBe('inherited');
  });

  it('preserves a hook draft across tool save/refetch, validates, saves and reloads', async () => {
    await mount();
    await click('Add rule');
    const event = container.querySelector<HTMLSelectElement>('#st-card-hooks select')!;
    expect(event.value).toBe('PreToolUse');
    expect([...event.options].some((option) => option.textContent?.includes('PreToolUse'))).toBe(false);
    const command = container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')!;
    await change(command, 'echo example');
    const tools = container.querySelector('#st-card-tools')!;
    await change(tools.querySelector('select')!, 'allowlist');
    expect((tools.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await change(tools.querySelector<HTMLSelectElement>('[aria-label="Policy for Read"]')!, 'enabled');
    await click('Save tool policy');
    expect(config.tools).toEqual({ enabled: ['Read'], disabled: [] });
    expect(command.value).toBe('echo example');
    await act(async () => query.setQueryData(['config'], { ...config, hooks: [] }));
    await flush();
    expect(command.value).toBe('echo example');
    const matcher = container.querySelector<HTMLInputElement>('#st-card-hooks input:not([type="number"])')!;
    await change(matcher, '[');
    await click('Save actions');
    expect(container.textContent).toContain('check matcher');
    expect(config.hooks).toEqual([]);
    expect(command.value).toBe('echo example');
    await change(matcher, '^Read$');
    await click('Save actions');
    expect(config.hooks).toEqual([{ event: 'PreToolUse', command: 'echo example', matcher: '^Read$' }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')!.value).toBe('echo example');
  });

  it('keeps invalid advanced JSON editable and round-trips all supported fields through the form', async () => {
    await mount();
    await click('Advanced: edit JSON');
    const json = container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')!;
    await change(json, '{broken');
    await click('Use rule form');
    expect(json.value).toBe('{broken');
    expect(client.patchConfig).not.toHaveBeenCalled();
    const rule = { event: 'Notification', command: 'echo example', matcher: 'ready', timeout: 17 };
    await change(json, JSON.stringify([rule]));
    await click('Use rule form');
    expect(container.querySelector<HTMLSelectElement>('#st-card-hooks select')!.value).toBe('Notification');
    expect(container.querySelector<HTMLInputElement>('#st-card-hooks input[type="number"]')!.value).toBe('17');
    await click('Save actions');
    expect(config.hooks).toEqual([rule]);
  });

  it('preserves tool edits across hook saves and failed saves', async () => {
    await mount();
    await change(container.querySelector<HTMLSelectElement>('[aria-label="Policy for Write"]')!, 'disabled');
    await click('Add rule');
    await change(container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')!, 'echo example');
    await click('Save actions');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Policy for Write"]')!.value).toBe('disabled');
    client.patchConfig.mockRejectedValueOnce(new Error('offline'));
    await click('Save tool policy');
    expect(container.textContent).toContain('offline');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Policy for Write"]')!.value).toBe('disabled');
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

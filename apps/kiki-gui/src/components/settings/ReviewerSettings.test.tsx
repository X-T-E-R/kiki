// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ReviewerSettings } from './ReviewerSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), listModels: vi.fn(), patchConfig: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../dirtyGuard', () => ({ useDirtyReporter: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.textContent?.trim() === label)!;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  client.getConfig.mockResolvedValue({ permission: {} });
  client.listModels.mockResolvedValue({ items: [{ id: 'test-model', provider_id: 'test', display_name: 'Test model' }] });
  client.patchConfig.mockImplementation(async (patch: { permission: { reviewer: Record<string, unknown> } }) => ({ permission: { reviewer: {
    backend: patch.permission.reviewer['backend'], model: patch.permission.reviewer['model'],
    jevConsent: patch.permission.reviewer['jev_consent'],
    timeoutMs: patch.permission.reviewer['timeout_ms'],
    allowThreshold: patch.permission.reviewer['allow_threshold'],
    denyThreshold: patch.permission.reviewer['deny_threshold'],
    categories: patch.permission.reviewer['categories'],
    hasApiKey: patch.permission.reviewer['api_key'] !== undefined,
  } } }));
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider>
    <ReviewerSettings />
  </I18nProvider></QueryClientProvider>));
  await settle();
}

describe('permission reviewer settings', () => {
  it('saves a configured model, thresholds and selected checks in one panel', async () => {
    await render();
    const model = container.querySelector('#reviewer-model')!;
    await act(async () => (model as HTMLButtonElement).click());
    await settle();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((element) => element.textContent?.includes('Test model'))!.click());
    const timeout = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await change(timeout, '5000');
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: expect.objectContaining({
      backend: 'model', model: 'test-model', timeout_ms: 5000, allow_threshold: 0.9,
      api_key: undefined, categories: expect.arrayContaining(['policy_compliance']),
    }) } });
  });

  it('keeps Jev disabled until consent and never displays a newly saved key', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-backend-choice="jev"]')!.click());
    expect(button('Save').disabled).toBe(true);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(button('Save').disabled).toBe(false);
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await change(key, 'private-fixture-key');
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: expect.objectContaining({
      backend: 'jev', jev_consent: true, api_key: 'private-fixture-key',
    }) } });
    expect(container.textContent).not.toContain('private-fixture-key');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
  });

  it('permits Jev with consent and no entered key when the server has an environment key', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-backend-choice="jev"]')!.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: expect.objectContaining({
      backend: 'jev', jev_consent: true, api_key: undefined,
    }) } });
  });

  it('preserves a stored Jev key when changing other reviewer fields', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      backend: 'jev', jevConsent: true, hasApiKey: true,
      timeoutMs: 8000, allowThreshold: 0.9, denyThreshold: 0.9,
      categories: ['policy_compliance'],
    } } });
    await render();
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('Key saved');
    await change(container.querySelector<HTMLInputElement>('input[type="number"]')!, '9000');
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: expect.objectContaining({
      backend: 'jev', api_key: undefined, timeout_ms: 9000,
    }) } });
  });

  it('discards all reviewer changes without writing', async () => {
    await render();
    await change(container.querySelector<HTMLInputElement>('input[type="number"]')!, '6000');
    await act(async () => button('Discard changes').click());
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('8000');
    expect(client.patchConfig).not.toHaveBeenCalled();
  });
});

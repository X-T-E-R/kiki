// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ReviewerSettings } from './ReviewerSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), listModels: vi.fn(), patchConfig: vi.fn(), revealSecret: vi.fn() } }));
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
    timeoutMs: patch.permission.reviewer['timeout_ms'],
    allowThreshold: patch.permission.reviewer['allow_threshold'],
    denyThreshold: patch.permission.reviewer['deny_threshold'],
    categories: patch.permission.reviewer['categories'],
    hasApiKey: typeof patch.permission.reviewer['api_key'] === 'string',
    apiKeySource: typeof patch.permission.reviewer['api_key'] === 'string' ? 'kiki' : 'none',
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

  it('treats selecting Jev as consent: no checkbox, saves at once, and never sends a consent flag', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-backend-choice="jev"]')!.click());
    expect(container.querySelector('[data-reviewer-jev] input[type="checkbox"]')).toBeNull();
    expect(container.textContent).toContain('Selecting Jev sends up to 3 recent user messages');
    expect(button('Save').disabled).toBe(false);
    const key = container.querySelector<HTMLInputElement>('#reviewer-api-key')!;
    await change(key, 'private-fixture-key');
    await act(async () => button('Save').click());
    await settle();
    const sent = client.patchConfig.mock.calls[0]![0].permission.reviewer as Record<string, unknown>;
    expect(sent).toMatchObject({ backend: 'jev', api_key: 'private-fixture-key' });
    expect(sent).not.toHaveProperty('jev_consent');
    expect(container.textContent).not.toContain('private-fixture-key');
  });

  it('shows an environment key as its source, reveals it on demand, and saves nothing for it', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      backend: 'jev', hasApiKey: true, apiKeySource: 'environment', apiKeyEnv: 'TYPESAFE_API_KEY',
      timeoutMs: 8000, allowThreshold: 0.9, denyThreshold: 0.9, categories: ['policy_compliance'],
    } } });
    client.revealSecret.mockResolvedValue({ source: 'environment', env_name: 'TYPESAFE_API_KEY', value: 'env-fixture-key' });
    await render();
    expect(container.textContent).toContain('From environment variable TYPESAFE_API_KEY');
    expect(client.revealSecret).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click());
    await settle();
    expect(client.revealSecret).toHaveBeenCalledWith({ kind: 'reviewer_api_key' });
    expect(container.querySelector<HTMLInputElement>('#reviewer-api-key')!.value).toBe('env-fixture-key');
    // An env key cannot be cleared from Kiki; it can only be overridden.
    expect(container.querySelector('[data-secret-clear]')).toBeNull();
    expect(container.querySelector('[data-secret-edit]')?.textContent).toBe('Override in Kiki');
  });

  it('clears a saved key with null', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      backend: 'jev', hasApiKey: true, apiKeySource: 'kiki',
      timeoutMs: 8000, allowThreshold: 0.9, denyThreshold: 0.9, categories: ['policy_compliance'],
    } } });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-secret-clear]')!.click());
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig.mock.calls[0]![0].permission.reviewer).toMatchObject({ api_key: null });
  });

  it('preserves a stored Jev key when changing other reviewer fields', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      backend: 'jev', hasApiKey: true, apiKeySource: 'kiki',
      timeoutMs: 8000, allowThreshold: 0.9, denyThreshold: 0.9,
      categories: ['policy_compliance'],
    } } });
    await render();
    const key = container.querySelector<HTMLInputElement>('#reviewer-api-key')!;
    expect(key.readOnly).toBe(true);
    expect(key.value).not.toContain('fixture');
    expect(container.textContent).toContain('Saved in Kiki');
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

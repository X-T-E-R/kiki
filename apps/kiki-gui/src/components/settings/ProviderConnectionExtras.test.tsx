// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ProviderConnectionExtras } from './ProviderConnectionExtras';
import { pickValue } from './testControls';

const getProviderEntity = vi.fn();
const updateProvider = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getProviderEntity, updateProvider } }),
}));

const ENTITY = {
  id: 'gw', type: 'openai', has_api_key: true, status: 'connected', revision: 'rev-1',
  custom_header_keys: ['X-Team', 'Authorization'], env_keys: ['PROXY_TOKEN'],
  oauth: { storage: 'keyring', signed_in: true },
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getProviderEntity.mockReset().mockResolvedValue(ENTITY);
  updateProvider.mockReset().mockResolvedValue({ provider: ENTITY, revision: 'rev-2' });
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><ProviderConnectionExtras providerId="gw" /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const button = (root: Element, text: string) => [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === text)!;

describe('ProviderConnectionExtras', () => {
  it('lists stored header and env names without their values and shows the OAuth storage', async () => {
    const container = await render();
    const headers = container.querySelector('[data-provider-named="header"]')!;
    expect(headers.textContent).toContain('X-Team');
    expect(headers.textContent).toContain('Authorization');
    // Write-only: the mask is shown, there is no reveal route, and nothing can be viewed or copied.
    for (const field of headers.querySelectorAll('[data-secret-field]')) {
      expect(field.querySelector<HTMLInputElement>('input')!.value).not.toContain('Bearer');
      expect(field.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.disabled).toBe(true);
      expect(field.querySelector<HTMLButtonElement>('[data-secret-copy]')!.disabled).toBe(true);
    }
    expect(container.querySelector('[data-provider-oauth="keyring"]')?.textContent).toContain('system keyring');
    expect(button(container, 'Save')?.disabled ?? true).toBe(true);
  });

  it('sends only replaced, added and removed names plus the model source', async () => {
    const container = await render();
    await pickValue(container.querySelector('[data-provider-model-source]')!, 'data-provider-model-source', 'discover');
    const team = container.querySelector('[data-provider-named-entry="X-Team"]')!;
    await type(team.querySelector<HTMLInputElement>('[data-secret-field] input')!, 'red');
    const auth = container.querySelector('[data-provider-named-entry="Authorization"]')!;
    await click(auth.querySelector('button[aria-label="Remove Authorization"]')!);
    const env = container.querySelector('[data-provider-named="env"]')!;
    await click(button(env, 'Add variable'));
    const added = env.querySelector('[data-provider-named-entry="new"]')!;
    await type(added.querySelector<HTMLInputElement>('[data-secret-field] input')!, 'v1');
    await click(button(container, 'Save'));
    expect(updateProvider).not.toHaveBeenCalled();
    expect(env.querySelector('[role="alert"]')?.textContent).toContain('Enter a name');
    await type(added.querySelector<HTMLInputElement>('[data-named-entry]')!, 'KIMI_BASE_URL');
    await click(button(container, 'Save'));
    expect(updateProvider).toHaveBeenCalledWith('gw', {
      base_revision: 'rev-1',
      model_source: 'discover',
      custom_headers: { 'X-Team': 'red', Authorization: null },
      env: { KIMI_BASE_URL: 'v1' },
    });
  });
});

// @vitest-environment jsdom

/**
 * Model-catalog row editor: model parameters are editable from the catalog
 * detail surface itself (not only from the provider editor) and save through
 * the same provider-form channel — here against the OAuth-managed
 * `managed:kimi-code` provider, whose colon id must round-trip unchanged
 * (no new_id) exactly as the kap-server replace route accepts.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import type { ServerConnection } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { ModelCatalogCard } from './ModelsSection';

const listModels = vi.fn();
const getConfig = vi.fn();
const listProviders = vi.fn();
const setDefaultModel = vi.fn();
const patchConfig = vi.fn();

const CONNECTION: ServerConnection = { url: 'https://server.example.test/', token: 'test-token' };

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: { listModels, getConfig, listProviders, setDefaultModel, patchConfig },
    config: CONNECTION,
  }),
}));

const PROVIDER: ProviderCatalogItem = {
  id: 'managed:kimi-code',
  type: 'kimi',
  base_url: 'https://api.managed.example.test/v1',
  default_model: 'managed:kimi-code/kimi-k2',
  has_api_key: false,
  status: 'connected',
  models: ['managed:kimi-code/kimi-k2'],
};

const MODELS: ModelCatalogItem[] = [
  {
    provider: 'managed:kimi-code',
    model: 'managed:kimi-code/kimi-k2',
    display_name: 'Kimi K2',
    max_context_size: 262144,
    capabilities: ['chat'],
    support_efforts: ['high'],
  },
];

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const fetchMock = vi.fn();

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  listModels.mockReset().mockResolvedValue({ items: MODELS });
  getConfig.mockReset().mockResolvedValue({
    default_model: 'managed:kimi-code/kimi-k2',
    default_provider: 'managed:kimi-code',
  });
  listProviders.mockReset().mockResolvedValue({ items: [PROVIDER] });
  setDefaultModel.mockReset();
  patchConfig.mockReset();
  fetchMock.mockReset().mockImplementation(async () => ({
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', data: { provider: PROVIDER } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderCard(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <ModelCatalogCard />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ModelCatalogCard row editor', () => {
  it('edits model parameters in place and saves them through the provider-form channel', async () => {
    const container = await renderCard();
    expect(container.textContent).toContain('managed:kimi-code/kimi-k2');

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit parameters for managed:kimi-code/kimi-k2"]',
    );
    expect(editButton, 'row edit toggle').not.toBeNull();
    await act(async () => {
      editButton!.click();
    });

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Display name for kimi-k2"]',
    );
    expect(nameInput, 'display name input').not.toBeNull();
    expect(nameInput!.value).toBe('Kimi K2');
    await act(async () => {
      setInputValue(nameInput!, 'K2 Thinking');
    });

    const saveButton = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Save',
    );
    expect(saveButton, 'save button').toBeDefined();
    expect(saveButton!.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://server.example.test/api/providers/managed%3Akimi-code');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['new_id']).toBeUndefined();
    expect(body['type']).toBe('kimi');
    expect(body['base_url']).toBe('https://api.managed.example.test/v1');
    expect(body['default_model']).toBe('kimi-k2');
    expect(body['models']).toEqual([
      {
        model: 'kimi-k2',
        max_context_size: 262144,
        display_name: 'K2 Thinking',
        capabilities: ['chat'],
        support_efforts: ['high'],
        request_identity: null,
      },
    ]);

    expect(container.textContent).toContain(
      'The server saved the parameters for managed:kimi-code/kimi-k2.',
    );
  });
});

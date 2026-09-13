// @vitest-environment jsdom

/**
 * Provider-form save channel regressions: the server (kap-server replace
 * route) validates `new_id` only on an actual rename, so an unchanged id
 * outside the create-time pattern — e.g. the OAuth-managed
 * `managed:kimi-code` — must save; a rename to an id outside the pattern
 * must still be rejected client-side with val.providerId.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import type { ServerConnection } from '@kiki/session-core/settings';

import { I18nProvider } from '../i18n';
import { ProviderEditor } from './ProviderFields';

const refreshProvider = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({ client: { refreshProvider } }),
}));
vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const CONNECTION: ServerConnection = { url: 'https://server.example.test/', token: 'test-token' };

const MANAGED_PROVIDER: ProviderCatalogItem = {
  id: 'managed:kimi-code',
  type: 'kimi',
  base_url: 'https://api.managed.example.test/v1',
  default_model: 'managed:kimi-code/kimi-k2',
  has_api_key: false,
  status: 'connected',
  models: ['managed:kimi-code/kimi-k2'],
};

const MANAGED_MODELS: ModelCatalogItem[] = [
  {
    provider: 'managed:kimi-code',
    model: 'managed:kimi-code/kimi-k2',
    max_context_size: 262144,
    capabilities: ['chat'],
    support_efforts: ['high'],
  },
];

const PLAIN_PROVIDER: ProviderCatalogItem = {
  id: 'example',
  type: 'openai',
  base_url: 'https://api.example.test/v1',
  default_model: 'example/gpt-test',
  has_api_key: true,
  status: 'connected',
  models: ['example/gpt-test'],
};

const PLAIN_MODELS: ModelCatalogItem[] = [
  { provider: 'example', model: 'example/gpt-test', max_context_size: 128000 },
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
  fetchMock.mockReset().mockImplementation(async () => ({
    status: 200,
    json: async () => ({ code: 0, msg: 'ok', data: { provider: MANAGED_PROVIDER } }),
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

async function renderEditor(
  provider: ProviderCatalogItem,
  models: readonly ModelCatalogItem[],
  managed: boolean,
  onSaved: () => Promise<void>,
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <ProviderEditor
            provider={provider}
            models={models}
            connection={CONNECTION}
            managed={managed}
            onSaved={onSaved}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`button not found: ${text}`);
  return button;
}

describe('ProviderEditor save channel', () => {
  it('saves an unchanged managed:kimi-code id without new_id (server accepts ids outside the create pattern when unchanged)', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(MANAGED_PROVIDER, MANAGED_MODELS, true, onSaved);

    const baseUrlInput = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'https://api.managed.example.test/v1',
    );
    expect(baseUrlInput, 'base URL input').toBeDefined();
    await act(async () => {
      setInputValue(baseUrlInput!, 'https://api.changed.example.test/v1');
    });

    const saveButton = buttonByText(container, 'Save provider');
    expect(saveButton.disabled).toBe(false);
    await act(async () => {
      saveButton.click();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://server.example.test/api/providers/managed%3Akimi-code');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['new_id']).toBeUndefined();
    expect(body['id']).toBeUndefined();
    expect(body['api_key']).toBeUndefined();
    expect(body['type']).toBe('kimi');
    expect(body['base_url']).toBe('https://api.changed.example.test/v1');
    expect(body['default_model']).toBe('kimi-k2');
    expect(body['models']).toEqual([
      {
        model: 'kimi-k2',
        max_context_size: 262144,
        capabilities: ['chat'],
        support_efforts: ['high'],
        request_identity: null,
      },
    ]);

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Server saved provider managed:kimi-code.');
  });

  it('rejects a rename to an id outside the server pattern before any request', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(PLAIN_PROVIDER, PLAIN_MODELS, false, onSaved);

    const idInput = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'example',
    );
    expect(idInput, 'provider id input').toBeDefined();
    await act(async () => {
      setInputValue(idInput!, 'bad:id');
    });

    await act(async () => {
      buttonByText(container, 'Save provider').click();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Provider ID must start with a letter or digit and use only letters, digits, spaces, - or _.',
    );
  });
});

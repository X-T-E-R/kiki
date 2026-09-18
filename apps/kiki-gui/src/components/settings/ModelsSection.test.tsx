// @vitest-environment jsdom

/**
 * Model-catalog row editor: a row is read as its own entity
 * (`GET /models/{id}`) and saved as a sparse patch carrying the revision that
 * read returned. Unlisted fields — including ones this client version does not
 * know, such as `max_output_size` — are never sent, so they cannot be cleared;
 * a concurrent edit surfaces as a conflict instead of an overwrite. The
 * managed shape uses a real `kimi-code/...` alias under `managed:kimi-code`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetModelResponse, ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import type { ServerConnection } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { ModelCatalogCard } from './ModelsSection';

const listModels = vi.fn();
const getConfig = vi.fn();
const listProviders = vi.fn();
const setDefaultModel = vi.fn();
const patchConfig = vi.fn();
const getModel = vi.fn();
const updateModel = vi.fn();

const CONNECTION: ServerConnection = { url: 'https://server.example.test/', token: 'test-token' };

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels,
      getConfig,
      listProviders,
      setDefaultModel,
      patchConfig,
      getModel,
      updateModel,
    },
    config: CONNECTION,
  }),
}));

const PROVIDER: ProviderCatalogItem = {
  id: 'managed:kimi-code',
  type: 'kimi',
  base_url: 'https://api.managed.example.test/v1',
  default_model: 'kimi-code/kimi-k2',
  has_api_key: false,
  status: 'connected',
  models: ['kimi-code/kimi-k2'],
};

const MODELS: ModelCatalogItem[] = [
  {
    id: 'kimi-code/kimi-k2',
    provider_id: 'managed:kimi-code',
    remote_id: 'kimi-k2',
    display_name: 'Kimi K2',
    max_context_size: 262144,
    capabilities: ['chat'],
    support_efforts: ['high'],
  },
];

const ENTITY: GetModelResponse = {
  id: 'kimi-code/kimi-k2',
  provider_id: 'managed:kimi-code',
  provider_source: 'provider',
  remote_id: 'kimi-k2',
  display_name: 'Kimi K2',
  max_context_size: 262144,
  capabilities: ['chat'],
  support_efforts: ['high'],
  adaptive_thinking: true,
  revision: 'rev-7',
  issues: [],
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
});

beforeEach(() => {
  listModels.mockReset().mockResolvedValue({ items: MODELS });
  getConfig.mockReset().mockResolvedValue({
    default_model: 'kimi-code/kimi-k2',
    default_provider: 'managed:kimi-code',
  });
  listProviders.mockReset().mockResolvedValue({ items: [PROVIDER] });
  setDefaultModel.mockReset();
  patchConfig.mockReset();
  getModel.mockReset().mockResolvedValue(ENTITY);
  updateModel.mockReset().mockResolvedValue(ENTITY);
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
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
  it('reads the model entity and saves a sparse patch with its revision', async () => {
    const container = await renderCard();
    expect(container.textContent).toContain('kimi-k2');

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
    );
    expect(editButton, 'row edit toggle').not.toBeNull();
    await act(async () => {
      editButton!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getModel).toHaveBeenCalledWith('kimi-code/kimi-k2');
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Display name for kimi-code/kimi-k2"]',
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

    expect(updateModel).toHaveBeenCalledTimes(1);
    const [modelId, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    expect(modelId).toBe('kimi-code/kimi-k2');
    expect(patch).toEqual({ display_name: 'K2 Thinking', base_revision: 'rev-7' });
    // Nothing the user did not touch is on the wire, so hidden and unknown
    // fields cannot be cleared by saving this row.
    expect(patch).not.toHaveProperty('remote_id');
    expect(patch).not.toHaveProperty('adaptive_thinking');
    expect(patch).not.toHaveProperty('max_context_size');
    expect(patch).not.toHaveProperty('capabilities');

    expect(container.textContent).toContain(
      'The server saved the parameters for kimi-code/kimi-k2.',
    );
  });
});

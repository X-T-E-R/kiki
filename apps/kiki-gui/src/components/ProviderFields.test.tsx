// @vitest-environment jsdom

/**
 * Provider-form save regressions, exercised through the shared klient client:
 *
 *  - an unchanged colon id (`managed:kimi-code`) saves other fields — no
 *    create-time id pattern is applied to an existing entity;
 *  - the provider patch never carries a model list;
 *  - a model row is saved as its own entity, so hidden fields such as
 *    `max_output_size` and `adaptive_thinking` survive a display-name edit;
 *  - a local alias whose text says nothing about the remote model
 *    (`fast` → `vendor/model:v1`) keeps its identity;
 *  - the real OAuth-generated shape (`managed:kimi-code` with `kimi-code/...`
 *    aliases) round-trips without being rewritten.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { ProviderEditor } from './ProviderFields';

const refreshProvider = vi.fn();
const getProviderEntity = vi.fn();
const updateProvider = vi.fn();
const updateModel = vi.fn();
const createModel = vi.fn();
const deleteModel = vi.fn();
const deleteProviderEntity = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: {
      refreshProvider,
      getProviderEntity,
      updateProvider,
      updateModel,
      createModel,
      deleteModel,
      deleteProviderEntity,
    },
  }),
}));
vi.mock('../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const MANAGED_PROVIDER: ProviderCatalogItem = {
  id: 'managed:kimi-code',
  type: 'kimi',
  base_url: 'https://api.managed.example.test/v1',
  default_model: 'kimi-code/kimi-k2',
  has_api_key: false,
  status: 'connected',
  models: ['kimi-code/kimi-k2'],
};

const MANAGED_MODELS: ModelCatalogItem[] = [
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

const COLON_PROVIDER: ProviderCatalogItem = {
  id: 'edge:gateway',
  type: 'openai',
  base_url: 'https://edge.example.test/v1',
  default_model: 'fast',
  has_api_key: true,
  status: 'connected',
  models: ['fast'],
};

const FAST_MODELS: ModelCatalogItem[] = [
  {
    id: 'fast',
    provider_id: 'edge:gateway',
    remote_id: 'vendor/model:v1',
    display_name: 'Fast',
    max_context_size: 200000,
  },
];

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
});

beforeEach(() => {
  refreshProvider.mockReset();
  getProviderEntity.mockReset().mockImplementation(async (id: string) => ({
    ...(id === 'managed:kimi-code' ? MANAGED_PROVIDER : COLON_PROVIDER),
    revision: 'rev-1',
  }));
  updateProvider.mockReset().mockResolvedValue({ ...COLON_PROVIDER, revision: 'rev-2' });
  updateModel.mockReset().mockResolvedValue({});
  createModel.mockReset().mockResolvedValue({});
  deleteModel.mockReset().mockResolvedValue(undefined);
  deleteProviderEntity.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
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
          <ProviderEditor provider={provider} models={models} managed={managed} onSaved={onSaved} />
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
  it('patches an unchanged managed:kimi-code id without any model list or id rewrite', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(MANAGED_PROVIDER, MANAGED_MODELS, true, onSaved);

    const baseUrlInput = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'https://api.managed.example.test/v1',
    );
    expect(baseUrlInput, 'base URL input').toBeDefined();
    await act(async () => {
      setInputValue(baseUrlInput!, 'https://api.changed.example.test/v1');
    });

    await act(async () => {
      buttonByText(container, 'Save provider').click();
    });

    expect(getProviderEntity).toHaveBeenCalledWith('managed:kimi-code');
    expect(updateProvider).toHaveBeenCalledTimes(1);
    const [providerId, patch] = updateProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(providerId).toBe('managed:kimi-code');
    expect(patch).toEqual({
      base_url: 'https://api.changed.example.test/v1',
      base_revision: 'rev-1',
    });
    expect(patch).not.toHaveProperty('models');
    expect(patch).not.toHaveProperty('id');
    expect(patch).not.toHaveProperty('api_key');
    expect(patch).not.toHaveProperty('new_id');
    expect(updateModel).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Server saved provider managed:kimi-code.');
  });

  it('keeps a local alias and its remote target when only the display name changes', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, onSaved);

    const editToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit model 1 details"]',
    );
    expect(editToggle, 'model row toggle').not.toBeNull();
    await act(async () => {
      editToggle!.click();
    });

    const displayNameInput = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'Fast',
    );
    expect(displayNameInput, 'display name input').toBeDefined();
    await act(async () => {
      setInputValue(displayNameInput!, 'Fast (renamed)');
    });

    await act(async () => {
      buttonByText(container, 'Save provider').click();
    });

    expect(updateModel).toHaveBeenCalledTimes(1);
    const [modelId, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    expect(modelId).toBe('fast');
    expect(patch).toEqual({ display_name: 'Fast (renamed)' });
    expect(patch).not.toHaveProperty('remote_id');
    expect(updateProvider).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('shows the stored local alias and remote id separately', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    expect(container.textContent).toContain('vendor/model:v1');
    expect(container.textContent).toContain('fast');
  });

  it('round-trips the real managed:kimi-code / kimi-code/... alias shape', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(MANAGED_PROVIDER, MANAGED_MODELS, true, onSaved);

    const editToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit model 1 details"]',
    );
    expect(editToggle, 'managed model row toggle').not.toBeNull();
    await act(async () => {
      editToggle!.click();
    });

    const displayNameInput = [...container.querySelectorAll('input')].find(
      (input) => input.value === 'Kimi K2',
    );
    expect(displayNameInput, 'managed display name input').toBeDefined();
    await act(async () => {
      setInputValue(displayNameInput!, 'K2 (mine)');
    });

    await act(async () => {
      buttonByText(container, 'Save provider').click();
    });

    expect(updateModel).toHaveBeenCalledTimes(1);
    const [modelId, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    // The alias never loses its generated prefix, and the patch touches only
    // the display name: the alias, the remote id, the capabilities and the
    // stored protocol fields stay exactly as they were.
    expect(modelId).toBe('kimi-code/kimi-k2');
    expect(patch).toEqual({ display_name: 'K2 (mine)' });
    expect(deleteModel).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

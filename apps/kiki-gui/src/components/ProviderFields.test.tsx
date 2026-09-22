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

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { NewProviderWizard, ProviderEditor } from './ProviderFields';
import { DirtyGuardContext } from './dirtyGuard';
import { ConnectionsTab } from './settings/ProvidersSection';

const listDiscoveredModels = vi.fn(async () => ({ items: [] as Array<{ provider_id: string; fetched_at: number | null; attempted_at: number; models: Array<{ remote_id: string }> }> }));
const refreshProvider = vi.fn();
const getCatalogProvider = vi.fn();
const getProviderEntity = vi.fn();
const getModel = vi.fn();
const updateProvider = vi.fn();
const updateModel = vi.fn();
const createModel = vi.fn();
const deleteModel = vi.fn();
const deleteProviderEntity = vi.fn();
const createProvider = vi.fn();
const listProviders = vi.fn();
const listModels = vi.fn();
const getAuth = vi.fn();
const getOAuthStatus = vi.fn();
const reportDirty = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    config: {},
    client: {
      listDiscoveredModels,
      refreshProvider,
      getCatalogProvider,
      getProviderEntity,
      getModel,
      updateProvider,
      updateModel,
      createModel,
      deleteModel,
      deleteProviderEntity,
      createProvider,
      listProviders,
      listModels,
      getAuth,
      getOAuthStatus,
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
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  refreshProvider.mockReset();
  getCatalogProvider.mockReset().mockImplementation(async (id: string) => {
    if (id !== 'edge:gateway') throw new Error('catalog entry not found');
    return {
      id,
      name: 'Edge Gateway',
      wire_type: 'openai',
      guessed: false,
      needs_base_url: false,
      rejected: false,
      reject_reason: null,
      env_key: null,
      models: [
        {
          id: 'vendor/model:v2',
          name: 'Vendor Model V2',
          max_context_size: 1048576,
          capabilities: ['tool_use', 'thinking'],
          support_efforts: ['low', 'high'],
          reasoning: true,
        },
      ],
    };
  });
  getProviderEntity.mockReset().mockImplementation(async (id: string) => ({
    ...(id === 'managed:kimi-code' ? MANAGED_PROVIDER : COLON_PROVIDER),
    revision: 'provider-rev-1',
  }));
  getModel.mockReset().mockImplementation(async (id: string) => {
    const model = [...MANAGED_MODELS, ...FAST_MODELS].find((candidate) => candidate.id === id)!;
    return { ...model, provider_source: 'provider', revision: `${id}-rev-1`, issues: [] };
  });
  updateProvider.mockReset().mockResolvedValue({ ...COLON_PROVIDER, revision: 'provider-rev-2' });
  updateModel.mockReset().mockImplementation(async (id: string) => ({
    ...(await getModel(id)),
    revision: `${id}-rev-2`,
  }));
  createModel.mockReset().mockResolvedValue({
    ...FAST_MODELS[0],
    id: 'edge:gateway/new-model',
    provider_source: 'provider',
    revision: 'new-model-rev-1',
    issues: [],
  });
  deleteModel.mockReset().mockResolvedValue(undefined);
  deleteProviderEntity.mockReset().mockResolvedValue(undefined);
  createProvider.mockReset().mockImplementation(async (body) => ({ ...body, revision: 'created-rev' }));
  listProviders.mockReset().mockResolvedValue({ items: [COLON_PROVIDER, MANAGED_PROVIDER] });
  listModels.mockReset().mockResolvedValue({ items: [...FAST_MODELS, ...MANAGED_MODELS] });
  getAuth.mockReset().mockResolvedValue({ ready: true, providers_count: 2 });
  getOAuthStatus.mockReset().mockResolvedValue(null);
  reportDirty.mockClear();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSurface(children: ReactNode) {
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
            <DirtyGuardContext.Provider value={{ dirty: false, reportDirty, navigate: () => {} }}>
              {children}
            </DirtyGuardContext.Provider>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, client };
}

async function renderEditor(
  provider: ProviderCatalogItem,
  models: readonly ModelCatalogItem[],
  managed: boolean,
  onSaved: () => Promise<void>,
): Promise<HTMLDivElement> {
  return (await renderSurface(
    <ProviderEditor provider={provider} models={models} managed={managed} onSaved={onSaved} />,
  )).container;
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
  it('keeps provider A draft and baseline through provider B save and real query invalidation', async () => {
    updateModel.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const renamed = { ...MANAGED_MODELS[0]!, display_name: String(patch['display_name']) };
      listModels.mockResolvedValue({ items: [...FAST_MODELS, renamed] });
      return { ...renamed, revision: `${id}-rev-2`, issues: [] };
    });
    const { container } = await renderSurface(<ConnectionsTab />);
    const editors = [...container.querySelectorAll<HTMLDetailsElement>('#st-card-providers details')];
    const first = editors[0]!;
    const second = editors[1]!;
    await act(async () => { for (const editor of editors) editor.open = true; });
    const baseUrl = [...first.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    const apiKey = first.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      setInputValue(baseUrl, 'https://draft.example.test/v1');
      setInputValue(apiKey, 'YOUR_API_KEY');
      second.querySelector<HTMLButtonElement>('button[aria-label="Edit model 1 details"]')!.click();
    });
    const name = second.querySelector<HTMLInputElement>('input[aria-label="Model 1 display name"]')!;
    await act(async () => { setInputValue(name, 'Changed elsewhere'); });
    await act(async () => { buttonByText(second, 'Save provider').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(listModels.mock.calls.length).toBeGreaterThan(1);
    expect(baseUrl.value).toBe('https://draft.example.test/v1');
    expect(apiKey.value).toBe('YOUR_API_KEY');
    expect(buttonByText(first, 'Save provider').disabled).toBe(false);
    expect(reportDirty.mock.calls.findLast(([id]) => id === 'provider:edge:gateway')).toEqual(['provider:edge:gateway', true]);
    expect(getProviderEntity.mock.calls.filter(([id]) => id === 'edge:gateway')).toHaveLength(1);
    await act(async () => { buttonByText(first, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenCalledWith('edge:gateway', {
      base_url: 'https://draft.example.test/v1', api_key: 'YOUR_API_KEY', base_revision: 'provider-rev-1',
    });
    expect(updateModel).toHaveBeenCalledTimes(1);
  });

  it('preserves a dirty draft and its original revision through refresh and background catalog updates', async () => {
    const { container, client } = await renderSurface(<ConnectionsTab />);
    const first = container.querySelector<HTMLDetailsElement>('#st-card-providers details')!;
    const baseUrl = [...first.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => { setInputValue(baseUrl, 'https://draft.example.test/v1'); });
    const external = { ...COLON_PROVIDER, base_url: 'https://external.example.test/v1' };
    getProviderEntity.mockResolvedValue({ ...external, revision: 'provider-rev-2' });
    listProviders.mockResolvedValue({ items: [external, MANAGED_PROVIDER] });
    refreshProvider.mockResolvedValue({ changed: [{ provider_id: COLON_PROVIDER.id, added: 1, removed: 0 }], failed: [], unchanged: [] });
    await act(async () => { buttonByText(first, 'Test connection & pull models').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      client.setQueryData(['models'], { items: [...FAST_MODELS, { ...MANAGED_MODELS[0], display_name: 'Background catalog change' }] });
    });
    expect(baseUrl.value).toBe('https://draft.example.test/v1');
    expect(getProviderEntity.mock.calls.filter(([id]) => id === 'edge:gateway')).toHaveLength(1);
    updateProvider.mockRejectedValueOnce(new Error('Provider changed since it was read.'));
    await act(async () => { buttonByText(first, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenCalledWith('edge:gateway', {
      base_url: 'https://draft.example.test/v1', base_revision: 'provider-rev-1',
    });
    expect(first.textContent).toContain('Provider changed since it was read.');
    expect(baseUrl.value).toBe('https://draft.example.test/v1');
    expect(buttonByText(first, 'Save provider').disabled).toBe(false);
  });

  it('saves a connection without models after removing the last wizard row', async () => {
    const onSaved = vi.fn(async () => {});
    const { container } = await renderSurface(<NewProviderWizard onSaved={onSaved} />);
    const template = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('OpenAI'))!;
    await act(async () => { template.click(); });
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'YOUR_API_KEY'); });
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove model"]')!;
    expect(remove.disabled).toBe(false);
    await act(async () => { remove.click(); });
    expect(container.querySelector('#provider-model-0-id')).toBeNull();
    await act(async () => { buttonByText(container, 'Create provider').click(); });
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai', api_key: 'YOUR_API_KEY', models: [] }));
    expect(createProvider.mock.calls[0]![0].default_model).toBeUndefined();
    expect(createModel).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('allows unrelated repairs with a dangling default and exposes clearing or replacing it', async () => {
    const dangling = { ...COLON_PROVIDER, default_model: 'removed-alias' };
    const container = await renderEditor(dangling, FAST_MODELS, false, async () => {});
    const baseUrl = [...container.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => {
      setInputValue(baseUrl, 'https://repaired.example.test/v1');
      setInputValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, 'YOUR_API_KEY');
    });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      base_url: 'https://repaired.example.test/v1', api_key: 'YOUR_API_KEY', base_revision: 'provider-rev-1',
    });
    const select = [...container.querySelectorAll('select')].find((input) => input.value === 'removed-alias')!;
    expect([...select.options].map((option) => option.value)).toEqual(['', 'removed-alias', 'fast']);
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { default_model: null, base_revision: 'provider-rev-2' });
    await act(async () => { select.value = 'fast'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { default_model: 'fast', base_revision: 'provider-rev-2' });
    expect(updateModel).not.toHaveBeenCalled();
  });

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
      base_revision: 'provider-rev-1',
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
    expect(patch).toEqual({ display_name: 'Fast (renamed)', base_revision: 'fast-rev-1' });
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
    expect(patch).toEqual({
      display_name: 'K2 (mine)',
      base_revision: 'kimi-code/kimi-k2-rev-1',
    });
    expect(deleteModel).not.toHaveBeenCalled();
    expect(createModel).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps the first writer when two editors save the same model field', async () => {
    let storedName = 'Fast';
    let revision = 'fast-rev-1';
    let conflictCode: number | undefined;
    getModel.mockImplementation(async () => ({
      ...FAST_MODELS[0],
      display_name: storedName,
      provider_source: 'provider',
      revision,
      issues: [],
    }));
    updateModel.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if (patch['base_revision'] !== revision) {
        conflictCode = 40941;
        throw Object.assign(new Error('Model changed since it was read.'), { code: conflictCode });
      }
      storedName = String(patch['display_name']);
      revision = 'fast-rev-2';
      return { ...(await getModel('fast')), revision };
    });

    const first = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    const second = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    for (const [container, name] of [[first, 'First writer'], [second, 'Second writer']] as const) {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[aria-label="Edit model 1 details"]')!.click();
      });
      const input = [...container.querySelectorAll('input')].find((candidate) => candidate.value === 'Fast')!;
      await act(async () => { setInputValue(input, name); });
    }

    await act(async () => { buttonByText(first, 'Save provider').click(); });
    await act(async () => { buttonByText(second, 'Save provider').click(); });

    expect(updateModel).toHaveBeenCalledTimes(2);
    expect(updateModel.mock.calls[0]?.[1]).toMatchObject({
      display_name: 'First writer',
      base_revision: 'fast-rev-1',
    });
    expect(updateModel.mock.calls[1]?.[1]).toMatchObject({
      display_name: 'Second writer',
      base_revision: 'fast-rev-1',
    });
    expect(conflictCode).toBe(40941);
    expect(storedName).toBe('First writer');
    expect(second.textContent).toContain('Model changed since it was read.');
  });

  it('records a created model before a later provider failure so retry can continue', async () => {
    const onSaved = vi.fn(async () => {});
    updateProvider
      .mockRejectedValueOnce(new Error('Provider changed since it was read.'))
      .mockResolvedValueOnce({ ...COLON_PROVIDER, revision: 'provider-rev-2' });
    createModel.mockResolvedValue({
      id: 'edge:gateway/new-model',
      provider_id: 'edge:gateway',
      provider_source: 'provider',
      remote_id: 'new-model',
      max_context_size: 128000,
      revision: 'new-model-rev-1',
      issues: [],
    });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, onSaved);

    await act(async () => { buttonByText(container, 'Add model').click(); });
    const remoteSelect = container.querySelector<HTMLButtonElement>('#provider-model-1-id')!;
    await act(async () => { remoteSelect.click(); });
    const remoteInput = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const baseUrlInput = [...container.querySelectorAll('input')].find(
      (candidate) => candidate.value === 'https://edge.example.test/v1',
    )!;
    await act(async () => { setInputValue(remoteInput, 'new-model'); });
    const customRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Use “new-model”'),
    );
    expect(customRow, 'custom model option').toBeDefined();
    await act(async () => { customRow!.click(); });
    await act(async () => { setInputValue(baseUrlInput, 'https://edge-2.example.test/v1'); });

    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(createModel).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('edge:gateway/new-model');
    expect(container.textContent).toContain('Provider changed since it was read.');

    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(createModel).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Server saved provider edge:gateway.');
  });

  it('does not replay successful model edits or deletions after a partial provider save failure', async () => {
    updateProvider.mockRejectedValueOnce(new Error('Provider changed since it was read.'));
    const obsolete = { ...FAST_MODELS[0]!, id: 'obsolete', remote_id: 'obsolete' };
    const container = await renderEditor(COLON_PROVIDER, [...FAST_MODELS, obsolete], false, async () => {});
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit model 1 details"]')!.click(); });
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>('input[aria-label="Model 1 display name"]')!, 'Renamed'); });
    await act(async () => { container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove model"]')[1]!.click(); });
    const baseUrl = [...container.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => { setInputValue(baseUrl, 'https://changed.example.test/v1'); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(deleteModel).toHaveBeenCalledWith('obsolete', { baseRevision: 'obsolete-rev-1' });
    expect(container.textContent).toContain('Provider changed since it was read.');
    expect(baseUrl.value).toBe('https://changed.example.test/v1');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(deleteModel).toHaveBeenCalledTimes(1);
    expect(updateProvider).toHaveBeenCalledTimes(2);
    expect(buttonByText(container, 'Save provider').disabled).toBe(true);
  });

  it('fills known parameters when a directory model is selected', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    await act(async () => { buttonByText(container, 'Add model').click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('#provider-model-1-id')!.click(); });

    const directoryRow = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('vendor/model:v2'),
    );
    expect(directoryRow, 'directory model option').toBeDefined();
    await act(async () => { directoryRow!.click(); });

    expect(container.querySelector<HTMLButtonElement>('#provider-model-1-id')!.textContent)
      .toContain('vendor/model:v2');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model 2 display name"]')!.value)
      .toBe('Vendor Model V2');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model 2 context size"]')!.value)
      .toBe('1048.576');
    expect(container.textContent).toContain('tool_use');
    expect(container.textContent).toContain('thinking');
    expect(container.textContent).toContain('low');
    expect(container.textContent).toContain('high');
  });

  it('keeps known parameters unchanged for a manually entered unknown model ID', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    await act(async () => { buttonByText(container, 'Add model').click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('#provider-model-1-id')!.click(); });
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { setInputValue(input, 'vendor/private-preview'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
    });

    expect(container.querySelector<HTMLButtonElement>('#provider-model-1-id')!.textContent)
      .toContain('vendor/private-preview');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model 2 display name"]')!.value)
      .toBe('');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model 2 context size"]')!.value)
      .toBe('128');
  });

  it('fetches only on click and creates a discovered model only after choosing and saving', async () => {
    const items = [{ provider_id: 'edge:gateway', fetched_at: 100, attempted_at: 100, models: [{ remote_id: 'remote-suggested' }] }];
    refreshProvider.mockImplementation(async () => {
      listDiscoveredModels.mockResolvedValue({ items });
      return { changed: [], unchanged: ['edge:gateway'], failed: [], discovered: items };
    });
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, onSaved);
    expect(refreshProvider).not.toHaveBeenCalled();
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(createModel).not.toHaveBeenCalled();
    expect(updateModel).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => { buttonByText(container, 'Add model').click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('#provider-model-1-id')!.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) => row.textContent?.includes('remote-suggested'))!;
    expect(option.textContent).toContain('from provider');
    await act(async () => { option.click(); });
    expect(createModel).not.toHaveBeenCalled();
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ provider_id: 'edge:gateway', remote_id: 'remote-suggested' }));
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('reports an empty refresh result as unsupported instead of unchanged success', async () => {
    refreshProvider.mockResolvedValue({ changed: [], unchanged: [], failed: [] });
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, onSaved);
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });

    expect(container.textContent).toContain('This provider has no refreshable catalog source.');
    expect(container.textContent).not.toContain('Catalog unchanged.');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('reports removals and additions from the scoped refresh result', async () => {
    refreshProvider.mockResolvedValue({
      changed: [{
        provider_id: 'edge:gateway',
        provider_name: 'Edge Gateway',
        added: 2,
        removed: 1,
      }],
      unchanged: [],
      failed: [],
    });
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, onSaved);
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });

    expect(container.textContent).toContain('Refresh completed. 2 added, 1 removed.');
    expect(onSaved).toHaveBeenCalledOnce();
  });
});

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
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { patchModelRequestSchema, type GetModelResponse, type ModelCatalogItem, type ProviderCatalogItem } from '@kiki/protocol';
import { readSettings, writeSettings, type ServerConnection } from '@kiki/session-core/settings';

import { translate } from '@kiki/session-core/i18n';
import { I18nProvider } from '../../i18n';
import { DirtyGuardContext } from '../dirtyGuard';
import { DefaultModelBar } from './DefaultModelBar';
import { CatalogRefreshCard, GlobalDefaultsCard, ThinkingCard } from './ModelsSection';
import { ProviderModelsHarness } from './testProviderModels';
import { ModelSwitchCard } from './ModelSwitchCard';
import { optionLabels, pickValue } from './testControls';
import { RouterDirtyGuard } from './testDirtyGuard';

const listDiscoveredModels = vi.fn();
const refreshAllProviders = vi.fn();
const createModel = vi.fn();

const listModels = vi.fn();
const getConfig = vi.fn();
const listProviders = vi.fn();
const setDefaultModel = vi.fn();
const patchConfig = vi.fn();
const getModel = vi.fn();
const updateModel = vi.fn();
const setSubagentDefaultModel = vi.fn();
const setFastModel = vi.fn();

const CONNECTION: ServerConnection = { url: 'https://server.example.test/', token: 'test-token' };

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listDiscoveredModels,
      refreshAllProviders,
      createModel,
      listModels,
      getConfig,
      listProviders,
      setDefaultModel,
      patchConfig,
      getModel,
      updateModel,
      setSubagentDefaultModel,
      setFastModel,
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
  effective_parameters: {},
  parameter_sources: {},
  revision: 'rev-7',
  issues: [],
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  refreshAllProviders.mockReset();
  createModel.mockReset().mockResolvedValue({});
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

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function renderCard(
  reportDirty = (_id: string, _dirty: boolean) => {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <RouterDirtyGuard reportDirty={reportDirty}>
              <DefaultModelBar tab="providers" />
              <ProviderModelsHarness />
              <CatalogRefreshCard />
            </RouterDirtyGuard>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The model editor opens in a side panel portaled to <body>: query the
  // whole document so the card and its panel read as one surface.
  return document.body;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Opens the `i` beside a label and returns the bubble text. */
async function helpText(scope: Element): Promise<string | undefined> {
  const trigger = scope.querySelector<HTMLButtonElement>('[data-setting-help]');
  if (trigger === null) return undefined;
  await act(async () => { trigger.click(); });
  return document.body.querySelector('[data-setting-help-bubble] [data-effective-protocol]')?.textContent ?? undefined;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ProviderModelList row editor', () => {
  it('makes configured models selectable while the connection status read is still pending', async () => {
    listProviders.mockReturnValue(new Promise(() => {}));
    const started = performance.now();
    const container = await renderCard();
    expect(container.textContent).not.toContain('Loading model catalog');
    expect(container.querySelector('#st-default-model')?.textContent).toContain('Kimi K2');
    expect(container.querySelector('#st-default-model')?.hasAttribute('disabled')).toBe(false);
    expect(container.querySelector('[data-group-attention]')).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(refreshAllProviders).not.toHaveBeenCalled();
  });

  it('keeps cached models and the selected default readable when revalidation fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await renderCard(undefined, queryClient);
    listModels.mockRejectedValueOnce(new Error('fixture revalidation failed'));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['models'] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('fixture revalidation failed');
    expect(container.querySelector('#st-default-model')?.textContent).toContain('Kimi K2');
    expect(container.querySelector('#st-default-model')?.hasAttribute('disabled')).toBe(false);
    expect(queryClient.getQueryData(['models'])).toEqual({ items: MODELS });
  });

  it('retains cached models and the selected default when a revalidation is cancelled', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await renderCard(undefined, queryClient);
    let resolve!: (value: { items: ModelCatalogItem[] }) => void;
    listModels.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    let revalidation!: Promise<void>;
    await act(async () => { revalidation = queryClient.invalidateQueries({ queryKey: ['models'] }); });
    await act(async () => { await queryClient.cancelQueries({ queryKey: ['models'] }); });
    await act(async () => { resolve({ items: [] }); await revalidation; });
    expect(queryClient.getQueryData(['models'])).toEqual({ items: MODELS });
    expect(container.querySelector('#st-default-model')?.textContent).toContain('Kimi K2');
    expect(container.textContent).not.toContain('Loading model catalog');
  });

  it('isolates late catalog responses after switching connection query scopes', async () => {
    let resolveOld!: (value: { items: ModelCatalogItem[] }) => void;
    listModels.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const oldQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const old = await renderCard(undefined, oldQueryClient);
    await act(async () => { roots.shift()!.unmount(); });
    const nextQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = await renderCard(undefined, nextQueryClient);
    await act(async () => { resolveOld({ items: [{ ...MODELS[0]!, id: 'old/model', display_name: 'Old connection model' }] }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(current.textContent).not.toContain('Old connection model');
    expect(nextQueryClient.getQueryData(['models'])).toEqual({ items: MODELS });
    expect(current.querySelector('#st-default-model')?.textContent).toContain('Kimi K2');
  });

  it('fetches suggestions only on click and saves the selected suggestion as a model', async () => {
    const items = [{ provider_id: 'gateway', fetched_at: 100, attempted_at: 100, models: [{ remote_id: 'remote-suggested' }] }];
    refreshAllProviders.mockImplementation(async () => {
      listDiscoveredModels.mockResolvedValue({ items });
      return { changed: [], unchanged: ['gateway'], failed: [], discovered: items };
    });
    const container = await renderCard();
    expect(refreshAllProviders).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Get models')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(createModel).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Suggestions — not configured yet"]')!.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('remote-suggested'))!;
    expect(option.textContent).toContain('Suggestions — not configured yet');
    await act(async () => { option.click(); });
    expect(createModel).not.toHaveBeenCalled();
    const capabilities = container.querySelector('[role="group"][aria-label="Capabilities for remote-suggested"]')!;
    expect(capabilities.querySelector('button[aria-pressed="true"]')?.textContent).toBe('thinking');
    expect([...capabilities.querySelectorAll('button[aria-pressed="true"]')].map((button) => button.textContent)).toEqual(['thinking', 'tool_use']);
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'gateway/remote-suggested', provider_id: 'gateway', remote_id: 'remote-suggested', max_context_size: 250000, capabilities: ['thinking', 'tool_use'] }));
    expect(setDefaultModel).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it.each([{ reported: [] }, { reported: ['image_in'] }])('keeps the reported capability list $reported without adding defaults', async ({ reported }) => {
    listDiscoveredModels.mockResolvedValue({ items: [{
      provider_id: 'gateway', fetched_at: 100, attempted_at: 100,
      models: [{ remote_id: 'remote-suggested', capabilities: reported }],
    }] });
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Suggestions — not configured yet"]')!.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent?.includes('remote-suggested'))!;
    await act(async () => { option.click(); });
    const capabilities = container.querySelector('[role="group"][aria-label="Capabilities for remote-suggested"]')!;
    expect([...capabilities.querySelectorAll('button[aria-pressed="true"]')].map((button) => button.textContent)).toEqual(reported);
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ capabilities: reported }));
  });

  it('preserves discovered capabilities without duplicates and lets the user uncheck defaults', async () => {
    listDiscoveredModels.mockResolvedValue({
      items: [{
        provider_id: 'gateway',
        fetched_at: 100,
        attempted_at: 100,
        models: [{ remote_id: 'remote-suggested', max_context_size: 64000, capabilities: ['image_in', 'tool_use', 'thinking', 'tool_use'] }],
      }],
    });
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Suggestions — not configured yet"]')!.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('remote-suggested'))!;
    await act(async () => { option.click(); });
    const capabilities = container.querySelector('[role="group"][aria-label="Capabilities for remote-suggested"]')!;
    expect([...capabilities.querySelectorAll('button[aria-pressed="true"]')].map((button) => button.textContent)).toEqual(['thinking', 'tool_use', 'image_in']);
    await act(async () => { [...capabilities.querySelectorAll('button')].find((button) => button.textContent === 'thinking')!.click(); });
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({
      max_context_size: 64000,
      capabilities: ['image_in', 'tool_use'],
    }));
  });

  it('edits model generation preferences independently of metadata, including zero and API default', async () => {
    getModel.mockResolvedValue({ ...ENTITY, effective_parameters: { temperature: 0.7, max_completion_tokens: 8192 }, parameter_sources: { temperature: '[providers.*.defaults]' } });
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector<HTMLElement>('[data-generation-editor="model:kimi-code/kimi-k2"]')!;
    expect(editor.textContent).toContain('[providers.*.defaults]');
    await pickValue(editor.querySelector('button[aria-label="Temperature mode"]')!, 'data-param-mode', 'custom');
    expect(editor.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('0');
    await pickValue(editor.querySelector('button[aria-label="Top P mode"]')!, 'data-param-mode', 'api_default');
    await act(async () => { [...editor.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save parameters')!.click(); });
    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      base_revision: 'rev-7', parameters: { temperature: 0, top_p: { kind: 'api_default' } },
    });
    expect(patchConfig).not.toHaveBeenCalled();
  });

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

    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
  });

  it('names the resolved provider format on the inherit option without writing it', async () => {
    getModel.mockResolvedValue({ ...ENTITY, effective_protocol: 'openai', protocol_source: 'provider' });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const field = container.querySelector<HTMLElement>('[data-model-protocol-field]')!;
    expect(field.dataset['modelProtocolField']).toBe('inherit');
    expect((await optionLabels(field))[0]).toBe('Provider default · Chat Completions');
    // Where the format comes from is reference text behind the label's `i`.
    expect(field.textContent).not.toContain('Effective format');
    expect(await helpText(field)).toBe('Effective format: Chat Completions · provider type');

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Display name for kimi-code/kimi-k2"]',
    )!;
    await act(async () => { setInputValue(nameInput, 'K2 Thinking'); });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
    });

    // The resolved format is display only: an unrelated save carries no
    // protocol key, so inheritance is never pinned by accident.
    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      display_name: 'K2 Thinking', base_revision: 'rev-7',
    });
  });

  it('shows format, endpoint, and credential sources and the ignored override fields', async () => {
    getModel.mockResolvedValue({
      ...ENTITY,
      protocol: 'google-genai',
      effective_protocol: 'google-genai',
      protocol_source: 'model',
      endpoint_source: 'model',
      auth_source: 'env',
      auth_env: 'OPENAI_API_KEY',
      base_url: 'https://model.example.test/gemini?key=secret-token',
      issues: [{ code: 'model.override_routing_rejected', severity: 'warning', path: 'overrides', message: 'base_url, protocol' }],
    });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const line = await helpText(container.querySelector('[data-model-protocol-field]')!);
    expect(line).toBe('Effective format: Google GenAI · this model · endpoint model · credential env (OPENAI_API_KEY)');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('model.example.test');
    expect(line).not.toContain('https://');
    const banner = container.querySelector('[data-model-issues]')?.textContent;
    expect(banner).toBe('These override fields were ignored: base_url, protocol.');
    expect(banner).not.toContain('secret-token');
    expect(banner).not.toContain('https://');
  });

  it('saves a chosen request format as a sparse protocol patch', async () => {
    getModel.mockResolvedValue({ ...ENTITY, effective_protocol: 'openai' });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    await pickValue(container.querySelector('[data-model-protocol-field]')!, 'data-model-protocol', 'openai_responses');
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
    });

    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      protocol: 'openai_responses', base_revision: 'rev-7',
    });
  });

  it('clears a stored format override back to the provider default', async () => {
    getModel.mockResolvedValue({ ...ENTITY, protocol: 'anthropic', effective_protocol: 'anthropic' });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const field = container.querySelector<HTMLElement>('[data-model-protocol-field]')!;
    expect(field.dataset['modelProtocolField']).toBe('anthropic');
    await pickValue(field, 'data-model-protocol', 'inherit');
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
    });

    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      protocol: null, base_revision: 'rev-7',
    });
  });

  it('saves a chosen request format for a suggested model', async () => {
    const items = [{ provider_id: 'gateway', fetched_at: 100, attempted_at: 100, models: [{ remote_id: 'remote-suggested' }] }];
    refreshAllProviders.mockImplementation(async () => {
      listDiscoveredModels.mockResolvedValue({ items });
      return { changed: [], unchanged: ['gateway'], failed: [], discovered: items };
    });
    const container = await renderCard();
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Get models')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Suggestions — not configured yet"]')!.click(); });
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes('remote-suggested'))!;
    await act(async () => { option.click(); });

    await pickValue(container.querySelector('[data-model-protocol-field]')!, 'data-model-protocol', 'anthropic');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });

    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'gateway/remote-suggested', protocol: 'anthropic',
    }));
  });

  it('edits the remote id and image policy while leaving model inheritance explicit', async () => {
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.textContent).toContain('Inherit provider');
    const remoteId = container.querySelector<HTMLInputElement>(
      'input[aria-label="Remote ID for kimi-code/kimi-k2"]',
    )!;
    await act(async () => { setInputValue(remoteId, 'kimi-k2.5'); });
    await pickValue(container.querySelector('button[aria-label="Accepted image types source"]')!, 'data-image-accepted-mode', 'custom');
    await pickValue(container.querySelector('button[aria-label="Unsupported image conversion"]')!, 'data-image-conversion', 'png');
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click();
    });

    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      remote_id: 'kimi-k2.5',
      images: {
        accepted_types: ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'],
        convert_unsupported: 'png',
      },
      base_revision: 'rev-7',
    });
  });

  it('saves engine fields as a sparse patch, clears emptied ones with null and blocks bad JSON', async () => {
    getModel.mockResolvedValue({ ...ENTITY, aliases: ['old-k2'], context_budget: 90_000, request_params: { store: false } });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const fields = container.querySelector('[data-model-engine-fields="kimi-code/kimi-k2"]')!;
    const field = <T extends HTMLElement>(name: string) => container.querySelector<T>(`[data-model-engine="${name}"]`)!;
    expect(fields.textContent).toContain('old-k2');
    // The context budget has one entrance: the usage row in Basics.
    expect(fields.querySelector('[data-model-engine="contextBudget"]')).toBeNull();
    const budget = container.querySelector<HTMLInputElement>('[data-usage-shared="context_budget"] input')!;
    expect(budget.value).toBe('90k');
    await act(async () => { setInputValue(field<HTMLInputElement>('maxInputSize'), '120000'); });
    await act(async () => { setInputValue(budget, ''); });
    await act(async () => { setInputValue(field<HTMLInputElement>('offEffort'), 'none'); });
    await pickValue(fields.querySelector('[data-model-engine-adaptive]')!, 'data-model-engine-adaptive', 'inherit');
    await act(async () => { setTextareaValue(field<HTMLTextAreaElement>('cognition'), '{ "overlay": '); });
    const save = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save().click(); });
    expect(updateModel).not.toHaveBeenCalled();
    // The prompt structure editors live with the prompts, and the refusal is shown there.
    expect(container.querySelector('[data-model-prompt-structure] [role="alert"]')?.textContent).toContain('not valid JSON');
    await act(async () => { setTextareaValue(field<HTMLTextAreaElement>('cognition'), '{ "overlay": "cog.md", "anchor_steps": 2 }'); });
    await act(async () => { setTextareaValue(field<HTMLTextAreaElement>('requestParams'), ''); });
    await act(async () => { save().click(); });
    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      max_input_size: 120_000,
      context_budget: null,
      off_effort: 'none',
      adaptive_thinking: null,
      request_params: null,
      cognition: { overlay: 'cog.md', anchor_steps: 2 },
      base_revision: 'rev-7',
    });
  });

  it('offers model editing even when the provider type cannot use the provider form', async () => {
    listProviders.mockResolvedValue({ items: [{ ...PROVIDER, type: 'future-protocol' }] });
    const container = await renderCard();
    expect(container.querySelector(
      'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
    )).not.toBeNull();
  });

  it('localizes known model issues and keeps server prose only for unknown codes', async () => {
    getModel.mockResolvedValue({
      ...ENTITY,
      issues: [
        {
          code: 'model.provider_missing',
          severity: 'error',
          path: 'provider_id',
          message: 'backend provider message',
        },
        {
          code: 'model.future_issue',
          severity: 'warning',
          path: 'future',
          message: 'future backend message',
        },
      ],
    });
    const container = await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
      )!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // A known code gets its own copy and no config path; only an unknown code
    // keeps the server's words, with the path that locates them.
    const banner = container.querySelector('[data-model-issues]')!;
    expect(banner.querySelector('[data-model-issue="model.provider_missing"]')?.textContent).toBe('The referenced provider is not configured.');
    expect(banner.textContent).not.toContain('backend provider message');
    expect(banner.querySelector('[data-model-issue="model.future_issue"]')?.textContent).toBe('future: future backend message');
  });

  it('states an applied Recipe in its own tab, in the reader language, instead of a raw banner', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      getModel.mockResolvedValue({
        ...ENTITY,
        recipe: 'inst-1',
        issues: [{ code: 'recipe-selected', severity: 'warning', path: 'recipe', message: 'Recipe selected; saved model prompts and Recipe-covered settings are retained but ignored.' }],
      });
      const container = await renderCard();
      const editLabel = translate('zh', 'st.models.editAria', { model: ENTITY.id });
      await act(async () => { [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === editLabel)!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.querySelector('[data-model-issues]')).toBeNull();
      expect(container.textContent).not.toContain('Recipe selected');
      expect(container.textContent).not.toContain('recipe:');
      expect(container.querySelector('[data-model-editor-tab-badge="recipe"]')?.textContent).toBe('已应用');
      expect(container.querySelector('[data-model-recipe-issue]')?.textContent).toBe('已应用 Recipe，其覆盖的提示词和参数在此处不生效');
    } finally {
      localStorage.removeItem('kiki.locale');
    }
  });
});

/**
 * Collapsing a row is a peek, not a close: the editor stays mounted (folded
 * and inert) with its draft, baseline and dirty flag intact, and only an
 * explicit Close — confirmed while dirty — drops the draft.
 */
describe('ProviderModelList context window and compaction point', () => {
  const openEditor = async (container: HTMLElement) => {
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    // The parameter group hangs off the entity read, so it lands a tick after
    // the window block beside it.
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (document.querySelector('[data-compact-point-field]') !== null) break;
    }
    return container;
  };
  const saveButton = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!;

  it('keeps the window and the compaction point apart and saves the point as tokens', async () => {
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', loop_control: { autoCompact: '85%' } });
    const container = await renderCard();
    const fields = await openEditor(container);
    expect(fields.textContent).toContain('Context window');
    // The compaction point lives in the parameter group now, not in a second
    // block under the window: one row holds the number and its track.
    const point = fields.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    // Empty = inherit; the placeholder names what applies instead.
    expect(point.value).toBe('');
    expect(point.placeholder).toBe('Default 212.1k (global 85%)');
    // The verified window presets mark the current 256k (262,144) window.
    const windowPresets = [...fields.querySelectorAll<HTMLButtonElement>('[data-token-presets="window:kimi-code/kimi-k2"] button')];
    expect(windowPresets.map((button) => button.textContent)).toEqual(['128k', '200k', '256k', '400k', '500k', '1M']);
    expect(windowPresets.find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent).toBe('256k');

    await act(async () => { point.focus(); setInputValue(point, '75%'); });
    await act(async () => { point.blur(); });
    expect(point.value).toBe('196.6k');
    await act(async () => { saveButton(container).click(); });
    expect(updateModel).toHaveBeenLastCalledWith('kimi-code/kimi-k2', { auto_compact: 196_608, base_revision: 'rev-7' });
  });

  it('offers compaction presets under the model limit and clears the point with null', async () => {
    getModel.mockResolvedValue({ ...ENTITY, auto_compact: 150_000 });
    const container = await renderCard();
    const fields = await openEditor(container);
    const presets = [...fields.querySelectorAll<HTMLButtonElement>('[data-token-presets="model:kimi-code/kimi-k2"] button')];
    expect(presets.map((button) => button.textContent)).toEqual(['125k', '150k', '200k']);
    const current = presets.find((button) => button.textContent === '150k')!;
    expect(current.getAttribute('aria-pressed')).toBe('true');
    // Clicking the selected preset again returns the field to "inherit".
    await act(async () => { current.click(); });
    await act(async () => { saveButton(container).click(); });
    expect(updateModel).toHaveBeenLastCalledWith('kimi-code/kimi-k2', { auto_compact: null, base_revision: 'rev-7' });
  });

  it('picks a window preset into the draft window', async () => {
    const container = await renderCard();
    const fields = await openEditor(container);
    await act(async () => {
      [...fields.querySelectorAll<HTMLButtonElement>('[data-token-presets="window:kimi-code/kimi-k2"] button')]
        .find((button) => button.textContent === '1M')!.click();
    });
    await act(async () => { saveButton(container).click(); });
    expect(updateModel).toHaveBeenLastCalledWith('kimi-code/kimi-k2', { max_context_size: 1_000_000, base_revision: 'rev-7' });
  });
});

describe('ProviderModelList row editor draft retention', () => {
  const editToggle = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
  )!;
  const nameInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>(
    'input[aria-label="Display name for kimi-code/kimi-k2"]',
  )!;
  const editorWrapper = (container: HTMLElement) => container.querySelector<HTMLElement>(
    '[data-model-row-editor="kimi-code/kimi-k2"]',
  );
  const buttonByText = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === text)!;

  async function openEditor(container: HTMLElement): Promise<HTMLElement> {
    // The row editor and the blocks inside it are portaled to <body>, so a
    // query against the card that opened them would find nothing.
    await act(async () => { editToggle(container).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // The editor reads its entity through a query of its own, and the
    // parameter group hangs off that read, so the surface settles a few ticks
    // after the row opens rather than in the same one.
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (document.querySelector('[data-compact-point-field]') !== null) break;
    }
    return document.documentElement;
  }

  it('opens the editor beside the list and keeps the rows in place', async () => {
    const container = await renderCard();
    const rowsBefore = container.querySelectorAll('[data-model-row]').length;
    await openEditor(container);
    const panel = container.querySelector('[data-model-detail="kimi-code/kimi-k2"]');
    expect(panel).not.toBeNull();
    // The editor lives in the panel, not inside the row, so the list never reflows.
    expect(panel!.contains(editorWrapper(container))).toBe(true);
    expect(container.querySelector('[data-model-row="kimi-code/kimi-k2"] [data-model-row-editor]')).toBeNull();
    expect(container.querySelectorAll('[data-model-row]')).toHaveLength(rowsBefore);
    expect(editToggle(container).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a draft that survives the collapse when the discard is refused', async () => {
    const container = await renderCard();
    await openEditor(container);
    await act(async () => { setInputValue(nameInput(container), 'K2 Thinking'); });
    await act(async () => { editToggle(container).click(); });
    await act(async () => { editToggle(container).click(); });

    await act(async () => { buttonByText(container, 'Close').click(); });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () => { buttonByText(container, 'Keep editing').click(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(nameInput(container).value).toBe('K2 Thinking');
    expect(buttonByText(container, 'Save').disabled).toBe(false);
  });

  it('drops the draft only when the explicit close is confirmed', async () => {
    const container = await renderCard();
    await openEditor(container);
    await act(async () => { setInputValue(nameInput(container), 'K2 Thinking'); });
    await act(async () => { buttonByText(container, 'Close').click(); });
    await act(async () => { buttonByText(container, 'Discard and leave').click(); });
    expect(editorWrapper(container)).toBeNull();
    expect(container.querySelector('input[aria-label="Display name for kimi-code/kimi-k2"]')).toBeNull();
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('closes a clean editor without asking', async () => {
    const container = await renderCard();
    await openEditor(container);
    await act(async () => { buttonByText(container, 'Close').click(); });
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(editorWrapper(container)).toBeNull();
  });
});

describe('ModelCatalogRowEditor request identity save guard', () => {
  it.each([
    { locale: 'en', text: '', expected: 'Custom overrides require a non-empty JSON object.' },
    { locale: 'en', text: '{', expected: 'Request identity overrides must be valid JSON.' },
    { locale: 'zh', text: '', expected: '仅自定义覆盖模式需要非空 JSON 对象。' },
    { locale: 'zh', text: '{', expected: '请求身份覆盖必须是有效的 JSON。' },
  ])('shows $locale inline feedback for "$text" without PATCH or unhandled rejection', async ({ locale, text, expected }) => {
    localStorage.setItem('kiki.locale', locale);
    const errors: unknown[] = [];
    const onError = (error: unknown) => { errors.push(error); };
    process.on('unhandledRejection', onError);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    try {
      const container = await renderCard();
      const editLabel = translate(locale as 'en' | 'zh', 'st.models.editAria', { model: ENTITY.id });
      const toggle = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === editLabel)!;
      await act(async () => { toggle.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const identityLabel = translate(locale as 'en' | 'zh', 'st.models.requestIdentity');
      const select = container.querySelector(`[data-model-row-editor] button[aria-label="${identityLabel}"]`)!;
      await pickValue(select, 'data-request-identity-choice', 'custom_overrides');
      const textarea = container.querySelector<HTMLTextAreaElement>('[data-request-identity-overrides]')!;
      await act(async () => { setTextareaValue(textarea, text); });
      const saveLabel = translate(locale as 'en' | 'zh', 'common.save');
      const save = [...container.querySelectorAll('button')].find((button) => button.textContent === saveLabel)!;
      await act(async () => { save.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.textContent).toContain(expected);
      expect(updateModel).not.toHaveBeenCalled();
      expect(textarea.value).toBe(text);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
      process.off('unhandledRejection', onError);
      localStorage.removeItem('kiki.locale');
    }
  });
});

describe('ThinkingCard display order', () => {
  it('sorts the default model efforts without changing the configured selection or saving', async () => {
    const support_efforts = ['high', 'max', 'low', 'medium', 'xhigh', 'Vendor-ULTRA'];
    listModels.mockResolvedValue({ items: [{ ...MODELS[0], support_efforts, default_effort: 'max' }] });
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', thinking: { effort: 'high' } });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><I18nProvider><ThinkingCard /></I18nProvider></QueryClientProvider>);
    });
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(choices.map((node) => node.textContent)).toEqual(['Low', 'Medium', 'High', 'Very high', 'Max', 'Vendor-ULTRA']);
    expect(choices.filter((node) => node.getAttribute('aria-pressed') === 'true').map((node) => node.textContent)).toEqual(['High']);
    expect(support_efforts).toEqual(['high', 'max', 'low', 'medium', 'xhigh', 'Vendor-ULTRA']);
    expect(patchConfig).not.toHaveBeenCalled();
  });
});

describe('GlobalDefaultsCard', () => {
  async function renderDefaults(): Promise<HTMLDivElement> {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={client}><I18nProvider><GlobalDefaultsCard /></I18nProvider></QueryClientProvider></MemoryRouter>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return container;
  }

  it('shows the subagent and fast model rows with their meaning and writes each one', async () => {
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', fast_model: 'kimi-code/kimi-k2', subagent: {} });
    setSubagentDefaultModel.mockResolvedValue(undefined);
    setFastModel.mockResolvedValue(undefined);
    const container = await renderDefaults();
    expect([...container.querySelectorAll<HTMLElement>('[data-default-row]')].map((row) => row.dataset['defaultRow']))
      .toEqual(['session-title', 'fast', 'subagent']);
    const subagentRow = container.querySelector('[data-default-row="subagent"]')!;
    expect(subagentRow.textContent).toContain('Used when neither the subagent nor the dispatch names a model.');
    expect(container.querySelector('[data-default-row="fast"]')!.textContent).toContain('small background jobs');
    // No title model, so the title row says the honest thing: nothing writes
    // a title on its own. A fast model is not a title source any more.
    expect(container.querySelector('[data-default-row="session-title"]')!.textContent).toContain('Not set; titles are not written automatically.');
    expect(container.querySelector('[data-default-row="session-title"]')!.textContent).not.toContain('Falls back to fast model');
    await act(async () => { subagentRow.querySelector<HTMLButtonElement>('#st-default-subagent-model')!.click(); });
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Kimi K2'))!;
    await act(async () => { option.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(setSubagentDefaultModel).toHaveBeenCalledWith('kimi-code/kimi-k2');
    const fastRow = container.querySelector('[data-default-row="fast"]')!;
    await act(async () => { fastRow.querySelector<HTMLButtonElement>('#st-default-fast-model')!.click(); });
    const unset = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Not set'))!;
    await act(async () => { unset.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(setFastModel).toHaveBeenCalledWith('');
  });

  // The engine writes a title with `session_title.model` and nothing else
  // (no fast_model, no managed tool), so the empty option says "no titles"
  // in every configuration rather than naming a hidden source.
  it('keeps the empty title option free of a fast model and a subscription claim', async () => {
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', fast_model: 'kimi-code/kimi-k2', subagent: {} });
    const container = await renderDefaults();
    await act(async () => { container.querySelector<HTMLButtonElement>('#st-default-title-model')!.click(); });
    const empty = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.includes('No title model'))!;
    expect(empty.textContent).toContain('Pick a model to write titles');
    expect(empty.textContent).not.toContain('fast model');
    // An entitlement promise here would name a tool the engine never calls.
    expect(empty.textContent).not.toContain('Included with your subscription');
  });

  it('says the same thing about the empty title option with no fast model set', async () => {
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', subagent: {} });
    const container = await renderDefaults();
    await act(async () => { container.querySelector<HTMLButtonElement>('#st-default-title-model')!.click(); });
    const empty = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.includes('No title model'))!;
    expect(empty.textContent).toContain('Pick a model to write titles');
    expect(empty.textContent).not.toContain('Included with your subscription');
    expect(empty.textContent).not.toContain('fast model');
  });

  it('picks the new-session default model in DefaultModelBar', async () => {
    const secondModel: ModelCatalogItem = {
      id: 'kimi-code/kimi-k1',
      provider_id: 'managed:kimi-code',
      remote_id: 'kimi-k1',
      display_name: 'Kimi K1',
      max_context_size: 131072,
      capabilities: ['chat'],
      support_efforts: ['high'],
    };
    listModels.mockResolvedValue({ items: [MODELS[0]!, secondModel] });
    getConfig.mockResolvedValue({ default_model: 'kimi-code/kimi-k2', fast_model: 'kimi-code/kimi-k1', subagent: {} });
    setDefaultModel.mockResolvedValue(undefined);
    patchConfig.mockResolvedValue({});

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
              <DirtyGuardContext.Provider value={{ dirty: false, reportDirty: () => {}, navigate: () => {} }}>
                <DefaultModelBar />
                <GlobalDefaultsCard />
              </DirtyGuardContext.Provider>
            </I18nProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.querySelector('[data-default-model-others]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('#st-default-model')!.click(); });
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes('Kimi K1'))!;
    await act(async () => { option.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(setDefaultModel).toHaveBeenCalledWith('kimi-code/kimi-k1');
  });
});

describe('default model cross-tab selection ownership', () => {
  const modelA: ModelCatalogItem = { ...MODELS[0]!, id: 'gateway/model-a', provider_id: 'gateway', display_name: 'Model A' };
  const modelB = MODELS[0]!;

  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function renderTabs() {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const show = async (tab: 'models' | 'defaults') => {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <I18nProvider>
                <DirtyGuardContext.Provider value={{ dirty: false, reportDirty: () => {}, navigate: () => {} }}>
                  {tab === 'models' ? (
                    <ProviderModelsHarness />
                  ) : (
                    <>
                      <DefaultModelBar />
                      <GlobalDefaultsCard />
                    </>
                  )}
                </DirtyGuardContext.Provider>
              </I18nProvider>
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    };
    listModels.mockResolvedValue({ items: [modelA, modelB] });
    writeSettings({ defaultModel: modelB.id, defaultEffort: 'high' });
    return { container, queryClient, show };
  }

  it('finishes the old server write chain before applying the last cross-tab pick, including the original default in DefaultModelBar', async () => {
    const initial = { default_model: modelB.id, default_provider: modelB.provider_id, session_title: { model: 'title-model' }, thinking: { effort: 'high' } };
    let server = { ...initial };
    const modelGate = deferred<void>();
    const providerGate = deferred<void>();
    const writes: string[] = [];
    getConfig.mockImplementation(async () => ({ ...server }));
    setDefaultModel.mockImplementation(async (id: string) => {
      if (id === modelA.id) await modelGate.promise;
      server = { ...server, default_model: id };
      writes.push(`model:${id}`);
      return { default_model: id };
    });
    patchConfig.mockImplementation(async ({ default_model, default_provider }: { default_model?: string; default_provider?: string }) => {
      if (default_provider === modelA.provider_id) await providerGate.promise;
      server = { ...server, ...(default_model !== undefined ? { default_model } : {}), ...(default_provider !== undefined ? { default_provider } : {}) };
      if (default_provider !== undefined) writes.push(`provider:${default_provider}`);
      return { ...server };
    });
    const { container, queryClient, show } = await renderTabs();
    await show('models');
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-model-row="${modelA.id}"] button[aria-pressed]`)!.click(); });
    await show('defaults');
    await pickValue(container.querySelector('#st-default-model')!, '', modelB.id);
    expect(setDefaultModel.mock.calls.map(([id]) => id)).toEqual([modelA.id]);
    await act(async () => { modelGate.resolve(); });
    expect(patchConfig).toHaveBeenCalledWith({ default_model: modelA.id, default_provider: modelA.provider_id });
    expect(setDefaultModel.mock.calls.map(([id]) => id)).toEqual([modelA.id]);
    expect(queryClient.getQueryData(['config'])).toEqual(initial);
    expect(readSettings().defaultModel).toBe(modelB.id);
    await act(async () => { providerGate.resolve(); });
    expect(writes).toEqual([`model:${modelA.id}`, `provider:${modelA.provider_id}`, `model:${modelB.id}`, `provider:${modelB.provider_id}`]);
    expect(server).toEqual(initial);
    expect(queryClient.getQueryData(['config'])).toEqual(server);
    expect(readSettings()).toMatchObject({ defaultModel: modelB.id, defaultEffort: 'high' });
    expect(container.querySelector('#st-default-model')!.textContent).toContain('Kimi K2');
  });

  it('lets the latest catalog pick run after an older DefaultModelBar request rejects, without stale error recovery', async () => {
    let server = { default_model: 'initial-model', default_provider: 'initial-provider', fast_model: 'fast-model' };
    const modelGate = deferred<void>();
    getConfig.mockImplementation(async () => ({ ...server }));
    setDefaultModel.mockImplementation(async (id: string) => {
      if (id === modelA.id) await modelGate.promise;
      server = { ...server, default_model: id };
      return { default_model: id };
    });
    patchConfig.mockImplementation(async ({ default_model, default_provider }: { default_model?: string; default_provider?: string }) => {
      server = { ...server, ...(default_model !== undefined ? { default_model } : {}), ...(default_provider !== undefined ? { default_provider } : {}) };
      return { ...server };
    });
    const { container, queryClient, show } = await renderTabs();
    await show('defaults');
    await pickValue(container.querySelector('#st-default-model')!, '', modelA.id);
    await show('models');
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-model-row="${modelB.id}"] button[aria-pressed]`)!.click(); });
    expect(setDefaultModel.mock.calls.map(([id]) => id)).toEqual([modelA.id]);
    const reads = getConfig.mock.calls.length;
    await act(async () => { modelGate.reject(new Error('old selection failed')); });
    expect(setDefaultModel.mock.calls.map(([id]) => id)).toEqual([modelA.id, modelB.id]);
    expect(patchConfig.mock.calls).toEqual([[{ default_model: modelB.id, default_provider: modelB.provider_id }]]);
    expect(getConfig).toHaveBeenCalledTimes(reads + 1);
    expect(server).toEqual({ default_model: modelB.id, default_provider: modelB.provider_id, fast_model: 'fast-model' });
    expect(queryClient.getQueryData(['config'])).toEqual(server);
    expect(readSettings().defaultModel).toBe(modelB.id);
    expect(container.textContent).not.toContain('old selection failed');
    expect(container.querySelector(`[data-model-row="${modelB.id}"]`)!.getAttribute('data-default')).toBe('true');
  });
});

describe('ProviderModelList list and detail hierarchy', () => {
  it('states the default once and marks capabilities with at most three words', async () => {
    listModels.mockResolvedValue({ items: [{ ...MODELS[0], capabilities: ['thinking', 'image_in', 'tool_use', 'video_in', 'audio_in'] }] });
    const container = await renderCard();
    expect(container.querySelector('[data-default-model-line]')!.textContent).toContain('Kimi K2');
    // One default statement above the list; the model appears once, under its
    // own connection and starred there. There is no separate "In use" group.
    expect(container.querySelectorAll('[data-provider-models] [data-model-row][data-default="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-list-group="in-use"]')).toBeNull();
    expect(container.textContent).not.toContain('In use\n');
    const marks = container.querySelector('[data-capability-marks]')!;
    expect([...marks.querySelectorAll('[data-capability]')].map((node) => node.getAttribute('data-capability')))
      .toEqual(['thinking', 'image_in', 'tool_use']);
    expect(container.querySelector('[data-model-row]')!.textContent).not.toContain('video_in');
  });

  it('splits the editor into Basics, Prompts, Recipe and Advanced tabs', async () => {
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]')!;
    const tabs = [...editor.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(tabs.map((tab) => tab.dataset['modelEditorTab'])).toEqual(['basics', 'prompts', 'recipe', 'advanced']);
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Basics', 'Prompts', 'Recipe', 'Advanced']);
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.dataset['modelEditorTab'])).toEqual(['basics']);
    const panel = (tab: string) => editor.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby="${tabs.find((node) => node.dataset['modelEditorTab'] === tab)!.id}"]`)!;
    // The default effort and the usage rows sit in Basics, writing the shared value.
    expect(panel('basics').querySelector('[data-usage-row="thinking_effort"]')).not.toBeNull();
    // The identity scope belongs to the prompts only, never the page header.
    expect(panel('basics').querySelector('[data-model-scope-choice]')).toBeNull();
    expect(panel('prompts').querySelector('[data-model-scope-choice="main"]')).not.toBeNull();
    expect(panel('recipe').querySelector('[data-model-recipe]')).not.toBeNull();
    expect([...panel('advanced').querySelectorAll('[data-advanced]')].map((node) => node.getAttribute('data-advanced'))).toEqual([
      'model-kimi-code/kimi-k2', 'model-images-kimi-code/kimi-k2', 'model-sampling-kimi-code/kimi-k2',
      'model-engine-kimi-code/kimi-k2', 'model-guard-kimi-code/kimi-k2',
    ]);
    // Arrow keys move between tabs and select them.
    await act(async () => { tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(panel('prompts').hidden).toBe(false);
    expect(panel('basics').hidden).toBe(true);
  });

  it('opens the detail with name, effort, context and capabilities first, and keeps overrides under Advanced', async () => {
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]')!;
    const advanced = editor.querySelector<HTMLElement>('[data-model-advanced-groups]')!;
    const engine = editor.querySelector<HTMLElement>('[data-advanced="model-engine-kimi-code/kimi-k2"]')!;
    const body = engine.querySelector<HTMLElement>('[id^="advanced-"]')!;
    expect(body.hidden).toBe(true);
    expect(body.querySelector('[data-model-engine-fields="kimi-code/kimi-k2"]')).not.toBeNull();
    // Common fields sit outside the disclosure — capabilities included. What a
    // model can do is one of the things a person opens this panel to decide, so
    // it is on the ordinary surface where the value being saved can be read.
    expect(advanced.contains(editor.querySelector('input[aria-label="Remote ID for kimi-code/kimi-k2"]'))).toBe(false);
    expect(advanced.contains(editor.querySelector('input[aria-label="Display name for kimi-code/kimi-k2"]'))).toBe(false);
    expect(advanced.contains(editor.querySelector('[data-model-context-fields]'))).toBe(false);
    expect(advanced.contains(editor.querySelector('[role="group"][aria-label="Effort levels for kimi-code/kimi-k2"]'))).toBe(false);
    const capabilities = editor.querySelector('[data-model-capabilities="kimi-code/kimi-k2"]');
    expect(capabilities).not.toBeNull();
    expect(advanced.contains(capabilities!)).toBe(false);
    expect(capabilities!.querySelector('[role="group"][aria-label="Capabilities for kimi-code/kimi-k2"]')).not.toBeNull();
  });

  it('displays default badge on default model and updates both defaultModel and patchConfig when setting new default', async () => {
    const k1: ModelCatalogItem = {
      id: 'managed:kimi-code/kimi-k1',
      provider_id: 'managed:kimi-code',
      remote_id: 'kimi-k1',
      display_name: 'Kimi K1',
      max_context_size: 131072,
      capabilities: ['chat'],
      support_efforts: [],
    };
    listModels.mockResolvedValue({ items: [MODELS[0], k1] });
    setDefaultModel.mockResolvedValue(undefined);
    patchConfig.mockResolvedValue({});
    const container = await renderCard();

    const defaultRow = container.querySelector<HTMLElement>('[data-model-row="kimi-code/kimi-k2"]')!;
    expect(defaultRow.getAttribute('data-default')).toBe('true');
    expect(defaultRow.querySelector('[data-default-badge]')).not.toBeNull();
    expect(defaultRow.querySelector('[data-default-badge]')?.textContent).toBe('Default');

    const nonDefaultRow = container.querySelector<HTMLElement>('[data-model-row="managed:kimi-code/kimi-k1"]')!;
    expect(nonDefaultRow.getAttribute('data-default')).toBeNull();
    expect(nonDefaultRow.querySelector('[data-default-badge]')).toBeNull();

    const starBtn = nonDefaultRow.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
    expect(starBtn).not.toBeNull();
    await act(async () => starBtn.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(setDefaultModel).toHaveBeenCalledWith('managed:kimi-code/kimi-k1');
    expect(patchConfig).toHaveBeenCalledWith({
      default_model: 'managed:kimi-code/kimi-k1',
      default_provider: 'managed:kimi-code',
    });
  });

  it('renders default control banner in model detail panel and triggers set default from panel', async () => {
    const k1: ModelCatalogItem = {
      id: 'managed:kimi-code/kimi-k1',
      provider_id: 'managed:kimi-code',
      remote_id: 'kimi-k1',
      display_name: 'Kimi K1',
      max_context_size: 131072,
      capabilities: ['chat'],
      support_efforts: [],
    };
    const k1Entity: GetModelResponse = {
      ...ENTITY,
      id: 'managed:kimi-code/kimi-k1',
      remote_id: 'kimi-k1',
      display_name: 'Kimi K1',
    };
    listModels.mockResolvedValue({ items: [MODELS[0], k1] });
    getModel.mockImplementation(async (id: string) => (id === 'managed:kimi-code/kimi-k1' ? k1Entity : ENTITY));
    setDefaultModel.mockResolvedValue(undefined);
    patchConfig.mockResolvedValue({});
    const container = await renderCard();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const defaultBanner = container.querySelector<HTMLElement>('[data-model-default-control="kimi-code/kimi-k2"]')!;
    expect(defaultBanner).not.toBeNull();
    expect(defaultBanner.getAttribute('data-is-default')).toBe('true');
    expect(defaultBanner.querySelector('[data-default-badge]')).not.toBeNull();
    expect(defaultBanner.querySelector('[data-set-default-button]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for managed:kimi-code/kimi-k1"]')!.click();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const nonDefaultBanner = container.querySelector<HTMLElement>('[data-model-default-control="managed:kimi-code/kimi-k1"]')!;
    expect(nonDefaultBanner).not.toBeNull();
    expect(nonDefaultBanner.getAttribute('data-is-default')).toBe('false');
    const setDefaultBtn = nonDefaultBanner.querySelector<HTMLButtonElement>('[data-set-default-button]')!;
    expect(setDefaultBtn).not.toBeNull();

    await act(async () => setDefaultBtn.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(setDefaultModel).toHaveBeenCalledWith('managed:kimi-code/kimi-k1');
    expect(patchConfig).toHaveBeenCalledWith({
      default_model: 'managed:kimi-code/kimi-k1',
      default_provider: 'managed:kimi-code',
    });
  });
});

describe('model prompt identity settings', () => {
  afterEach(() => {
    for (const [, patch] of updateModel.mock.calls) {
      assert.doesNotThrow(() => patchModelRequestSchema.parse(patch));
    }
  });

  it('returns to a clean draft when a temporary main difference is restored to common', async () => {
    getModel.mockResolvedValue({ ...ENTITY, cognition: { overlay: 'common.md' } });
    const container = await renderCard();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector('[data-model-cognition-editor]')!;
    const save = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!;
    expect(save().disabled).toBe(true);
    await act(async () => editor.querySelector<HTMLButtonElement>('[data-prompt-branch-main="off"]')!.click());
    expect(save().disabled).toBe(false);
    await act(async () => editor.querySelector<HTMLButtonElement>('[data-prompt-branch-main="same"]')!.click());
    expect(save().disabled).toBe(true);
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('saves main-only differences without copying common steering or anchor', async () => {
    getModel.mockResolvedValue({ ...ENTITY, cognition: { overlay: 'common.md', steering: 'reminder.md', anchor: 'anchor.md' } });
    const container = await renderCard();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector('[data-model-cognition-editor]')!;
    await act(async () => editor.querySelector<HTMLButtonElement>('[data-prompt-branch-main="custom"]')!.click());
    const mainPath = editor.querySelector<HTMLTextAreaElement>('[data-prompt-custom="main"] textarea')!;
    expect(mainPath.value).toBe('');
    await act(async () => setTextareaValue(mainPath, 'main.md'));
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => save.click());
    expect(updateModel).toHaveBeenCalledWith('kimi-code/kimi-k2', {
      base_revision: 'rev-7', cognition: { overlay: 'common.md', steering: 'reminder.md', anchor: 'anchor.md', main: { overlay: 'main.md' } },
    });
  });
});

describe('ModelSwitchCard', () => {
  const switchConfig = (overrides: Record<string, unknown> = {}) => ({
    default_mode: 'direct',
    confirm: true,
    rules: [],
    ...overrides,
  });

  async function renderSwitchCard(): Promise<HTMLElement> {
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
              <DirtyGuardContext.Provider value={{ dirty: false, reportDirty: () => {}, navigate: () => {} }}>
                <ModelSwitchCard />
              </DirtyGuardContext.Provider>
            </I18nProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    return container;
  }

  const modeButton = (container: HTMLElement, value: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`[data-model-switch-default-mode="${value}"]`)!;

  async function click(element: Element): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('reads the stored preferences and lists the rules in their stored order', async () => {
    getConfig.mockResolvedValue({
      default_model: 'kimi-code/kimi-k2',
      model_switch: switchConfig({
        default_mode: 'fresh',
        confirm: false,
        rules: [
          { id: 'first', enabled: true, from_models: ['example/a-*'], to_models: ['example/b'], mode: 'compact', confirm: true },
          { id: 'second', enabled: false, mode: 'fresh' },
        ],
      }),
    });
    const container = await renderSwitchCard();
    expect(modeButton(container, 'fresh').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    const ruleRows = container.querySelectorAll('[data-model-switch-rule]');
    expect(ruleRows).toHaveLength(2);
    expect(ruleRows[0]!.textContent).toContain('example/a-* → example/b');
    expect(ruleRows[0]!.textContent).toContain('Summarize first');
    expect(ruleRows[0]!.textContent).toContain('Always ask');
    expect(ruleRows[1]!.textContent).toContain('Any model → Any model');
  });

  it('saves a default-mode pick straight away without touching the rule table', async () => {
    const rules = [{ id: 'keep', enabled: true, to_models: ['example/b'], mode: 'compact' }];
    getConfig.mockResolvedValue({ model_switch: switchConfig({ rules }) });
    patchConfig.mockResolvedValue({ model_switch: switchConfig({ default_mode: 'fresh', rules }) });
    const container = await renderSwitchCard();
    await click(modeButton(container, 'fresh'));
    expect(patchConfig).toHaveBeenCalledExactlyOnceWith({
      model_switch: { default_mode: 'fresh' },
    });
    expect(container.textContent).toContain('Saved');
  });

  it('holds rule edits as one draft and saves the whole table once', async () => {
    getConfig.mockResolvedValue({ model_switch: switchConfig() });
    patchConfig.mockResolvedValue({ model_switch: switchConfig() });
    const container = await renderSwitchCard();
    await click(container.querySelector<HTMLButtonElement>('[data-model-switch-rule-add]')!);
    const editor = container.querySelector<HTMLElement>('[data-model-switch-rule-editor]')!;
    const [fromInput, toInput] = editor.querySelectorAll<HTMLInputElement>('input[type="text"]');
    setInputValue(fromInput!, 'example/old-*');
    setInputValue(toInput!, 'example/new, example/alt?');
    await click(editor.querySelector<HTMLButtonElement>('[data-model-switch-rule-mode="fresh"]')!);
    expect(patchConfig).not.toHaveBeenCalled();
    const footer = container.querySelector<HTMLElement>('[data-settings-draft="model-switch-rules"]')!;
    expect(footer.hidden).toBe(false);
    await click(footer.querySelector<HTMLButtonElement>('button')!);
    const payload = patchConfig.mock.calls[0]![0] as { model_switch: { rules: unknown[] } };
    expect(payload.model_switch.rules).toHaveLength(1);
    expect(payload.model_switch.rules[0]).toMatchObject({
      enabled: true,
      mode: 'fresh',
      from_models: ['example/old-*'],
      to_models: ['example/new', 'example/alt?'],
    });
  });

  it('keeps the rule draft on screen when the save fails', async () => {
    getConfig.mockResolvedValue({ model_switch: switchConfig() });
    patchConfig.mockRejectedValue(new Error('offline'));
    const container = await renderSwitchCard();
    await click(container.querySelector<HTMLButtonElement>('[data-model-switch-rule-add]')!);
    const footer = container.querySelector<HTMLElement>('[data-settings-draft="model-switch-rules"]')!;
    await click(footer.querySelector<HTMLButtonElement>('button')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-model-switch-rule-editor]')).not.toBeNull();
    expect(container.querySelectorAll('[data-model-switch-rule]')).toHaveLength(1);
    expect(container.textContent).toContain('offline');
  });

  it('drops the draft back to the stored table on discard', async () => {
    getConfig.mockResolvedValue({ model_switch: switchConfig() });
    const container = await renderSwitchCard();
    await click(container.querySelector<HTMLButtonElement>('[data-model-switch-rule-add]')!);
    expect(container.querySelectorAll('[data-model-switch-rule]')).toHaveLength(1);
    await click(container.querySelector<HTMLButtonElement>('[data-settings-discard="model-switch-rules"]')!);
    expect(container.querySelectorAll('[data-model-switch-rule]')).toHaveLength(0);
    expect(container.querySelector('[data-model-switch-rules-empty]')).not.toBeNull();
  });

  it('answers every rule preview side with words, never with an empty value', async () => {
    getConfig.mockResolvedValue({ model_switch: switchConfig() });
    const container = await renderSwitchCard();
    await click(container.querySelector<HTMLButtonElement>('[data-model-switch-rule-add]')!);
    const editor = container.querySelector<HTMLElement>('[data-model-switch-rule-editor]')!;
    const preview = editor.querySelector<HTMLElement>('[data-model-switch-rule-preview]')!;
    // A fresh rule names no model on either side, so both sides take any model.
    expect(preview.textContent).toContain('From matches: Any model');
    expect(preview.textContent).toContain('To matches: Any model');
    const [fromInput] = editor.querySelectorAll<HTMLInputElement>('input[type="text"]');
    setInputValue(fromInput!, 'example/missing-*');
    expect(preview.textContent).toContain('From matches: no known model');
    setInputValue(fromInput!, 'kimi-code/kimi-*');
    expect(preview.textContent).toContain('From matches: kimi-code/kimi-k2');
  });

  it('says nothing rather than guessing while the model catalog is unreadable', async () => {
    getConfig.mockResolvedValue({ model_switch: switchConfig() });
    listModels.mockReturnValue(new Promise(() => {}));
    const container = await renderSwitchCard();
    await click(container.querySelector<HTMLButtonElement>('[data-model-switch-rule-add]')!);
    const editor = container.querySelector<HTMLElement>('[data-model-switch-rule-editor]')!;
    expect(editor.querySelector('[data-model-switch-rule-preview]')).toBeNull();
  });
});

/**
 * Usage policy: one model, one shared set of values, with an identity branch
 * carrying only its differences. The wire is `usage: { main?, independent? }`
 * plus the server-resolved `usage_effective` / `usage_sources`; the GUI edits
 * differences and never rewrites the shared layer.
 */
describe('ModelCatalogRowEditor usage policy', () => {
  const MODEL_ID = 'kimi-code/kimi-k2';
  const usageEntity = (usage: unknown, effective?: unknown, sources?: unknown, shared?: Partial<GetModelResponse>): GetModelResponse => ({
    ...ENTITY,
    support_efforts: ['low', 'medium', 'high'],
    effective_parameters: { thinking_effort: 'medium', service_tier: 'auto', max_completion_tokens: 8192 },
    parameters: { thinking_effort: 'medium', service_tier: 'auto', max_completion_tokens: 8192 },
    auto_compact: 200_000,
    context_budget: 180_000,
    usage,
    usage_effective: effective,
    usage_sources: sources,
    ...shared,
  } as GetModelResponse);

  const openRow = async (entity: GetModelResponse) => {
    getModel.mockResolvedValue(entity);
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (document.querySelector('[data-main-usage-policy]') !== null) break;
    }
    // Let the detail pane's focus-to-heading frame land before a popover opens.
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => { resolve(undefined); })); });
    return document.body;
  };

  const saveModel = async () => {
    const editor = document.querySelector<HTMLElement>('[data-model-row-editor]')!;
    const button = [...editor.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent === 'Save')!;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  const row = (field: string) => document.querySelector<HTMLElement>(`[data-usage-row="${field}"]`)!;
  const shared = (field: string) => row(field).querySelector<HTMLElement>(`[data-usage-shared="${field}"]`)!;
  const identity = (field: string, position: string) =>
    document.querySelector<HTMLElement>(`[data-usage-identities="${field}"] [data-usage-position="${position}"]`)!;
  // The per-agent layer is an anchored popover portaled to <body>; absent while closed.
  const identities = (field: string) => document.querySelector<HTMLElement>(`[data-usage-identities="${field}"]`);
  const identityInput = (field: string, position: string) => identity(field, position).querySelector<HTMLInputElement>('input[data-usage-value]')!;
  const toggle = (field: string) => row(field).querySelector<HTMLButtonElement>('[data-usage-identity-toggle]')!;
  const expand = async (field: string) => {
    if (toggle(field).getAttribute('aria-expanded') === 'false') await act(async () => { toggle(field).click(); });
  };

  it('is editable on a model that has never configured a difference', async () => {
    const container = await openRow(ENTITY);
    expect(container.querySelector('[data-main-usage-policy]')).not.toBeNull();
    expect(row('thinking_effort').querySelector('[data-usage-override-marker]')).toBeNull();
    expect(toggle('thinking_effort').textContent).toBe('Per agent');
  });

  it('keeps the per-agent toggle quiet until a row is hovered or focused, and visible once a field differs', async () => {
    await openRow(usageEntity({ main: { thinking_effort: 'high' } }));
    // An overridden field always shows who differs.
    expect(toggle('thinking_effort').hasAttribute('data-usage-toggle-quiet')).toBe(false);
    expect(toggle('thinking_effort').className).not.toContain('opacity-0');
    // A field without a difference hides the toggle visually but keeps it in the tab order.
    const quiet = toggle('service_tier');
    expect(quiet.hasAttribute('data-usage-toggle-quiet')).toBe(true);
    expect(quiet.className).toContain('opacity-0');
    expect(quiet.className).toContain('group-focus-within:opacity-100');
    expect(quiet.className).toContain('focus-visible:opacity-100');
    expect(quiet.tabIndex).toBe(0);
    expect(quiet.disabled).toBe(false);
    act(() => { quiet.focus(); });
    expect(document.activeElement).toBe(quiet);
    // Opening it keeps it visible while the identity rows are shown.
    await expand('service_tier');
    expect(toggle('service_tier').hasAttribute('data-usage-toggle-quiet')).toBe(false);
  });

  it('picks the default effort from the efforts the model supports', async () => {
    await openRow(usageEntity(undefined));
    expect(await optionLabels(shared('thinking_effort'))).toEqual(['Not set', 'Low', 'Medium', 'High', 'Off']);
    // The support set and the default are two settings and read as two.
    expect(document.body.textContent).toContain('Supported effort levels');
    expect(document.body.textContent).toContain('Default thinking effort');
  });

  it('writes the same shared parameters patch when the default effort is picked in Basics', async () => {
    await openRow(usageEntity({ main: { thinking_effort: 'high' } }));
    await pickValue(shared('thinking_effort'), 'data-usage-value', 'low');
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, { parameters: { thinking_effort: 'low' }, base_revision: 'rev-7' });
  });

  it('writes the shared tier and token ceiling into parameters and leaves the branches alone', async () => {
    await openRow(usageEntity({ main: { auto_compact: 160000 } }));
    await pickValue(shared('service_tier'), 'data-usage-value', 'flex');
    await act(async () => { setInputValue(shared('max_completion_tokens').querySelector('input')!, '16k'); });
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, {
      parameters: { service_tier: 'flex', max_completion_tokens: 16000 }, base_revision: 'rev-7',
    });
  });

  it('keeps temperature and top_p in the Advanced sampling group only', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high' } }));
    for (let tick = 0; tick < 6 && container.querySelector('[data-generation-editor="model:kimi-code/kimi-k2"]') === null; tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    const editor = container.querySelector<HTMLElement>('[data-generation-editor="model:kimi-code/kimi-k2"]')!;
    expect(editor.closest('[data-advanced="model-sampling-kimi-code/kimi-k2"]')).not.toBeNull();
    expect(editor.querySelector('button[aria-label="Temperature mode"]')).not.toBeNull();
    expect(editor.querySelector('button[aria-label="Top P mode"]')).not.toBeNull();
    expect(editor.querySelector('button[aria-label="Thinking mode / effort mode"]')).toBeNull();
    expect(editor.querySelector('button[aria-label="Service tier mode"]')).toBeNull();
    expect(editor.querySelector('button[aria-label="Max generated tokens mode"]')).toBeNull();
  });
  it('marks a field an identity overrides on the row itself and opens its value in place', async () => {
    await openRow(usageEntity({ main: { thinking_effort: 'high', auto_compact: 160000 } }));
    // The marker names who differs, on the row it differs on.
    expect(row('thinking_effort').querySelector('[data-usage-override-marker]')?.getAttribute('data-usage-override-marker')).toBe('main');
    expect(toggle('thinking_effort').textContent).toBe('Main agent');
    expect(row('service_tier').querySelector('[data-usage-override-marker]')).toBeNull();
    // Collapsed until asked for; the shared value stays the first thing on the row.
    expect(identities('thinking_effort')).toBeNull();
    await expand('thinking_effort');
    expect(identities('thinking_effort')).not.toBeNull();
    expect(identity('thinking_effort', 'main').querySelector('[data-usage-restore]')).not.toBeNull();
    expect(identity('thinking_effort', 'independent').querySelector('[data-usage-restore]')).toBeNull();
  });

  it('restores inheritance by writing null for the field rather than omitting it', async () => {
    await openRow(usageEntity({ main: { thinking_effort: 'high', auto_compact: 160000 } }));
    await expand('thinking_effort');
    await act(async () => { identity('thinking_effort', 'main').querySelector<HTMLButtonElement>('[data-usage-restore]')!.click(); });
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, { usage: { main: { thinking_effort: null } }, base_revision: 'rev-7' });
  });

  it('sets a main-agent effort from the same picker choices and names the shared fallback', async () => {
    await openRow(usageEntity(undefined));
    await expand('thinking_effort');
    const picker = identity('thinking_effort', 'main');
    expect(await optionLabels(picker)).toEqual(['Same as all · Medium', 'Low', 'Medium', 'High', 'Off']);
    await pickValue(picker, 'data-usage-value', 'high');
    expect(toggle('thinking_effort').textContent).toBe('Main agent');
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, { usage: { main: { thinking_effort: 'high' } }, base_revision: 'rev-7' });
  });

  it('keeps "off" and "not sent" apart from being unset', async () => {
    await openRow(usageEntity({ main: {} }));
    await expand('thinking_effort');
    await pickValue(identity('thinking_effort', 'main'), 'data-usage-value', 'off');
    await expand('service_tier');
    await pickValue(identity('service_tier', 'main'), 'data-usage-value', 'not_sent');
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      usage: { main: { thinking_effort: 'off', service_tier: { kind: 'api_default' } } },
    }));
  });

  it('refuses an invalid token count, opens the row that holds it, and saves once it is valid', async () => {
    await openRow(usageEntity({ main: {} }));
    await expand('context_budget');
    await act(async () => { setInputValue(identityInput('context_budget', 'main'), '0'); });
    await act(async () => { toggle('context_budget').click(); });
    await saveModel();
    expect(updateModel).not.toHaveBeenCalled();
    expect(identities('context_budget')).not.toBeNull();
    expect(identity('context_budget', 'main').querySelector('[data-usage-issue="context_budget"]')?.textContent).toBe('Use a whole number of tokens, 1 or more.');
    expect(identityInput('context_budget', 'main').value).toBe('0');
    await act(async () => { setInputValue(identityInput('context_budget', 'main'), '4096'); });
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({ usage: { main: { context_budget: 4096 } } }));
  });

  it('reads a token count in the k form, and keeps the wire an integer', async () => {
    await openRow(usageEntity({ main: { context_budget: 160_000 } }));
    await expand('context_budget');
    const field = () => identityInput('context_budget', 'main');
    expect(field().value).toBe('160k');
    field().focus();
    await act(async () => { setInputValue(field(), '160000'); });
    // Mid-edit the typed text stands; it settles to the k form when left.
    expect(field().value).toBe('160000');
    await act(async () => { field().blur(); });
    expect(field().value).toBe('160k');
    await act(async () => { setInputValue(field(), '0.2M'); });
    await saveModel();
    expect(updateModel).toHaveBeenLastCalledWith(MODEL_ID, expect.objectContaining({ usage: { main: { context_budget: 200000 } } }));
  });

  it('keeps an unreadable token count on screen for the row to report', async () => {
    await openRow(usageEntity({ main: { context_budget: 160_000 } }));
    await expand('context_budget');
    const field = () => identityInput('context_budget', 'main');
    field().focus();
    await act(async () => { setInputValue(field(), 'abc'); });
    await act(async () => { field().blur(); });
    expect(field().value).toBe('abc');
    await saveModel();
    expect(updateModel).not.toHaveBeenCalled();
    expect(identity('context_budget', 'main').querySelector('[data-usage-issue]')).not.toBeNull();
  });

  it('clears one position without touching the other', async () => {
    await openRow(usageEntity({ main: { thinking_effort: 'high' }, independent: { thinking_effort: 'off' } }));
    expect(toggle('thinking_effort').textContent).toBe('Main agent · Delegated agent');
    await expand('thinking_effort');
    await act(async () => { identity('thinking_effort', 'main').querySelector<HTMLButtonElement>('[data-usage-restore]')!.click(); });
    await saveModel();
    const sent = updateModel.mock.calls[0]?.[1] as { usage: Record<string, unknown> };
    expect(sent.usage).toEqual({ main: { thinking_effort: null } });
  });
  it('states the resolved value and its origin only where the server clamps a difference', async () => {
    await openRow(usageEntity(
      { main: { context_budget: 200_000 } },
      { main: { context_budget: '180000' } },
      { main: { context_budget: '[models.*.context_budget]' } },
    ));
    await expand('context_budget');
    const line = identity('context_budget', 'main');
    expect(line.querySelector('[data-usage-effective="context_budget"]')?.textContent).toBe('180k');
    // The origin is a config path: reference text behind an `i`.
    expect(line.textContent).not.toContain('[models.*.context_budget]');
    await act(async () => { line.querySelector<HTMLButtonElement>('[data-setting-help]')!.click(); });
    expect(document.body.querySelector('[data-setting-help-bubble]')?.textContent).toContain('[models.*.context_budget]');
    // Once edited, the saved projection answers a draft the person replaced.
    await act(async () => { setInputValue(identityInput('context_budget', 'main'), '90000'); });
    expect(identity('context_budget', 'main').querySelector('[data-usage-effective]')).toBeNull();
  });

  it('locks the usage controls against edits and restore while a save is in flight', async () => {
    const entity = usageEntity({ main: { context_budget: 150_000 } });
    let resolveSave: ((saved: GetModelResponse) => void) | undefined;
    updateModel.mockImplementation(() => new Promise<GetModelResponse>((resolve) => { resolveSave = resolve; }));
    await openRow(entity);
    await expand('context_budget');
    await act(async () => { setInputValue(identityInput('context_budget', 'main'), '120000'); });
    await saveModel();
    const restore = identity('context_budget', 'main').querySelector<HTMLButtonElement>('[data-usage-restore]')!;
    expect(identityInput('context_budget', 'main').disabled).toBe(true);
    expect(shared('service_tier').querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!.disabled).toBe(true);
    expect(restore.disabled).toBe(true);
    await act(async () => { restore.click(); });
    expect(identityInput('context_budget', 'main').value).toBe('120k');
    await act(async () => { resolveSave?.({ ...entity, revision: 'rev-8' }); });
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(identityInput('context_budget', 'main').disabled).toBe(false);
    expect(identityInput('context_budget', 'main').value).toBe('150k');
  });

  it('leaves an unset shared value empty rather than writing 0', async () => {
    await openRow(usageEntity({ main: {} }, undefined, undefined, { context_budget: undefined, auto_compact: undefined }));
    expect(shared('context_budget').querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!.value).toBe('');
  });

  it('edits a main compaction point on a model that has never configured one', async () => {
    await openRow({ ...ENTITY } as GetModelResponse);
    await expand('auto_compact');
    await act(async () => { setInputValue(identityInput('auto_compact', 'main'), '120000'); });
    await saveModel();
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, { usage: { main: { auto_compact: 120000 } }, base_revision: 'rev-7' });
  });

  it('writes only the shared point from the shared track and keeps an untouched branch out of the patch', async () => {
    await openRow(usageEntity({ main: { auto_compact: 120_000 } }, { main: { auto_compact: '120000' } }));
    const slider = document.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => { slider.focus(); setInputValue(slider, '100000'); });
    await act(async () => { slider.blur(); });
    await saveModel();
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    expect(sent.auto_compact).toBeGreaterThan(0);
    expect(sent.usage).toBeUndefined();
  });

  it('writes the shared point without disturbing an untouched branch', async () => {
    await openRow(usageEntity({ main: { auto_compact: 160000 } }));
    const point = document.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    await act(async () => { point.focus(); setInputValue(point, '150000'); point.blur(); });
    await saveModel();
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    expect(sent.auto_compact).toBe(150000);
    expect(sent.usage).toBeUndefined();
  });

  it('writes a main compaction point into the branch, not the model', async () => {
    await openRow(usageEntity({ main: { auto_compact: 160000 } }));
    await expand('auto_compact');
    expect(identityInput('auto_compact', 'main').value).toBe('160k');
    await act(async () => { setInputValue(identityInput('auto_compact', 'main'), '150k'); });
    await saveModel();
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    expect(sent.auto_compact).toBeUndefined();
    expect(sent.usage).toEqual({ main: { auto_compact: 150000 } });
  });
});

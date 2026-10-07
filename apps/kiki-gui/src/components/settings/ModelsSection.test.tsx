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
import type { ServerConnection } from '@kiki/session-core/settings';

import { translate } from '@kiki/session-core/i18n';
import { I18nProvider } from '../../i18n';
import { DirtyGuardContext } from '../dirtyGuard';
import { CatalogRefreshCard, GlobalDefaultsCard, ModelCatalogCard, ThinkingCard } from './ModelsSection';
import { ModelSwitchCard } from './ModelSwitchCard';
import { pickValue } from './testControls';

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

async function renderCard(reportDirty = (_id: string, _dirty: boolean) => {}): Promise<HTMLElement> {
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
              <ModelCatalogCard />
              <CatalogRefreshCard />
            </DirtyGuardContext.Provider>
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

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ModelCatalogCard row editor', () => {
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
    const field = <T extends HTMLElement>(name: string) => fields.querySelector<T>(`[data-model-engine="${name}"]`)!;
    expect(fields.textContent).toContain('old-k2');
    expect(field<HTMLInputElement>('contextBudget').value).toBe('90000');
    await act(async () => { setInputValue(field<HTMLInputElement>('maxInputSize'), '120000'); });
    await act(async () => { setInputValue(field<HTMLInputElement>('contextBudget'), ''); });
    await act(async () => { setInputValue(field<HTMLInputElement>('offEffort'), 'none'); });
    await pickValue(fields.querySelector('[data-model-engine-adaptive]')!, 'data-model-engine-adaptive', 'inherit');
    await act(async () => { setTextareaValue(field<HTMLTextAreaElement>('cognition'), '{ "overlay": '); });
    const save = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await act(async () => { save().click(); });
    expect(updateModel).not.toHaveBeenCalled();
    expect(fields.querySelector('[role="alert"]')?.textContent).toContain('not valid JSON');
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

    expect(container.textContent).toContain('provider_id: The referenced provider is not configured.');
    expect(container.textContent).not.toContain('backend provider message');
    expect(container.textContent).toContain('future: future backend message');
  });
});

/**
 * Collapsing a row is a peek, not a close: the editor stays mounted (folded
 * and inert) with its draft, baseline and dirty flag intact, and only an
 * explicit Close — confirmed while dirty — drops the draft.
 */
describe('ModelCatalogCard context window and compaction point', () => {
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

describe('ModelCatalogCard row editor draft retention', () => {
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

  it('keeps an open draft while the list is searched, filtered empty and cleared', async () => {
    listModels.mockResolvedValue({ items: [...MODELS, { ...MODELS[0], id: 'other', remote_id: 'other-model', display_name: 'Other model' }] });
    const reportDirty = vi.fn();
    const container = await renderCard(reportDirty);
    await openEditor(container);
    const input = nameInput(container);
    await act(async () => { setInputValue(input, 'K2 Thinking'); });
    expect(reportDirty).toHaveBeenCalledWith('catalog-model:kimi-code/kimi-k2', true);
    reportDirty.mockClear();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await act(async () => { setInputValue(search, 'other-model'); });
    expect(container.querySelector('[data-model-row="kimi-code/kimi-k2"]')).toBeNull();
    expect(container.querySelector('[data-model-row="other"]')).not.toBeNull();
    await act(async () => { setInputValue(search, 'zzz-no-match'); });
    expect(container.querySelector('[data-list-empty="no-match"]')).not.toBeNull();
    await act(async () => { setInputValue(search, ''); });
    // The panel never unmounted: same input, same draft, still dirty.
    expect(nameInput(container)).toBe(input);
    expect(input.value).toBe('K2 Thinking');
    expect(buttonByText(container, 'Save').disabled).toBe(false);
    expect(reportDirty).not.toHaveBeenCalledWith('catalog-model:kimi-code/kimi-k2', false);
    expect(updateModel).not.toHaveBeenCalled();
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
    expect(choices.map((node) => node.textContent)).toEqual(['Low', 'Medium', 'High', 'Xhigh', 'Max', 'Vendor-ULTRA']);
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
      .toEqual(['new-session', 'session-title', 'fast', 'subagent']);
    const subagentRow = container.querySelector('[data-default-row="subagent"]')!;
    expect(subagentRow.textContent).toContain('only when a subagent has no other pin');
    expect(container.querySelector('[data-default-row="fast"]')!.textContent).toContain('small background jobs');
    // No title model, so the title row says the honest thing: nothing writes
    // a title on its own. A fast model is not a title source any more.
    expect(container.querySelector('[data-default-row="session-title"]')!.textContent).toContain('No model picked, so no title is written on its own.');
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
});

describe('ModelCatalogCard list and detail hierarchy', () => {
  it('states the default once and marks capabilities with at most three words', async () => {
    listModels.mockResolvedValue({ items: [{ ...MODELS[0], capabilities: ['thinking', 'image_in', 'tool_use', 'video_in', 'audio_in'] }] });
    const container = await renderCard();
    expect(container.querySelector('[data-default-model-line]')!.textContent).toContain('Kimi K2');
    // One default statement above the list; the model appears once, under its
    // own connection and starred there. There is no separate "In use" group.
    expect(container.querySelectorAll('[data-list-group^="provider:"] [data-model-row][data-default="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-list-group="in-use"]')).toBeNull();
    expect(container.textContent).not.toContain('In use\n');
    const marks = container.querySelector('[data-capability-marks]')!;
    expect([...marks.querySelectorAll('[data-capability]')].map((node) => node.getAttribute('data-capability')))
      .toEqual(['thinking', 'image_in', 'tool_use']);
    expect(container.querySelector('[data-model-row]')!.textContent).not.toContain('video_in');
  });

  it('opens the detail with name, effort, context and capabilities first, and keeps overrides under Advanced', async () => {
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editor = container.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]')!;
    const advanced = editor.querySelector<HTMLElement>('[data-advanced="model-kimi-code/kimi-k2"]')!;
    const body = advanced.querySelector<HTMLElement>('[id^="advanced-"]')!;
    expect(body.hidden).toBe(true);
    expect(body.querySelector('input[aria-label="Remote ID for kimi-code/kimi-k2"]')).not.toBeNull();
    // Common fields sit outside the disclosure — capabilities included. What a
    // model can do is one of the things a person opens this panel to decide, so
    // it is on the ordinary surface where the value being saved can be read.
    expect(advanced.contains(editor.querySelector('input[aria-label="Display name for kimi-code/kimi-k2"]'))).toBe(false);
    expect(advanced.contains(editor.querySelector('[data-model-context-fields]'))).toBe(false);
    expect(advanced.contains(editor.querySelector('[role="group"][aria-label="Effort levels for kimi-code/kimi-k2"]'))).toBe(false);
    const capabilities = editor.querySelector('[data-model-capabilities="kimi-code/kimi-k2"]');
    expect(capabilities).not.toBeNull();
    expect(advanced.contains(capabilities!)).toBe(false);
    expect(capabilities!.querySelector('[role="group"][aria-label="Capabilities for kimi-code/kimi-k2"]')).not.toBeNull();
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
    return document.body;
  };

  const saveModel = async (container: HTMLElement) => {
    // The editor is portaled, so the Save that belongs to this row is the one
    // inside it rather than any Save on the page.
    const editor = document.querySelector<HTMLElement>('[data-model-row-editor]') ?? container;
    const button = [...editor.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent === 'Save')!;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  // The scope switch is owned by the page, not by the usage group: one switch
  // decides which layer every overridable group on the page is editing.
  const scopeButton = (container: HTMLElement, scope: string) =>
    container.querySelector<HTMLButtonElement>(`[data-model-scope-choice="${scope}"]`);

  it('is editable on a model that has never configured a difference', async () => {
    // Absent `usage` is the ordinary case, not a missing feature: the block
    // must still be there to write the first difference into.
    const container = await openRow(ENTITY);
    expect(container.querySelector('[data-main-usage-policy]')).not.toBeNull();
  });

  it("edits the model own values in the shared scope", async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high' } }));
    const block = container.querySelector<HTMLElement>('[data-main-usage-policy]')!;
    expect(block.getAttribute('data-usage-scope')).toBe('shared');
    // The shared scope writes the model's own parameters, through the same rows.
    expect(block.querySelector<HTMLInputElement>('[data-usage-value="thinking_effort"]')!.value).toBe('medium');
    // The shared layer states it is the default, not that it overrides every
    // use: an identity may still set its own value on top of it. That sentence
    // belongs to the page-level scope switch now, which owns the layer.
    expect(container.querySelector('[data-model-edit-scope="shared"]')?.textContent)
      .toContain(translate('en', 'st.modelScope.sharedHint'));
    // No difference row and no restore action while editing the shared layer.
    expect(block.querySelector('[data-usage-restore]')).toBeNull();
    setInputValue(block.querySelector<HTMLInputElement>('[data-usage-value="thinking_effort"]')!, 'low');
    await saveModel(container);
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      parameters: { thinking_effort: 'low' },
    }));
  });

  it('leaves an unset shared value empty rather than writing 0', async () => {
    const container = await openRow(usageEntity(
      { main: {} },
      { main: { thinking_effort: 'medium' } },
      undefined,
      { context_budget: undefined, auto_compact: undefined },
    ));
    const block = container.querySelector<HTMLElement>('[data-main-usage-policy]')!;
    // Neither an absent budget nor an absent compaction point may read as 0.
    expect(block.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!.value).toBe('');
    const compact = block.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    expect(compact.value).toBe('');
  });

  it('counts the differences a main-agent branch holds', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high', auto_compact: 160000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-model-scope-differences]')?.textContent).toBe('2');
    expect(container.querySelector('[data-usage-value="thinking_effort"]')).not.toBeNull();
  });

  it('states the resolved value and its origin only where a difference exists', async () => {
    const container = await openRow(usageEntity(
      { main: { thinking_effort: 'high' } },
      { main: { thinking_effort: 'high', service_tier: 'auto' } },
      { main: { thinking_effort: '[models.*.usage.main]' } },
    ));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const block = container.querySelector<HTMLElement>('[data-usage-fields="main"]')!;
    expect(block.querySelector('[data-usage-effective="thinking_effort"]')?.textContent).toBe('high');
    // The origin is a config path, so it is reference text behind the label's
    // `i` rather than a line on the first screen.
    expect(block.textContent).not.toContain('[models.*.usage.main]');
    const help = [...block.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-expanded') !== null
        || button.getAttribute('aria-label')?.includes('more') === true);
    await act(async () => { help?.click(); });
    expect(document.body.textContent).toContain('[models.*.usage.main]');
    // service_tier carries no difference, so nothing is restated for it.
    expect(block.querySelector('[data-usage-effective="service_tier"]')).toBeNull();
  });

  it('sends only the changed difference', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high' } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const compact = container.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    // The compaction field commits on blur, so it has to hold focus first.
    await act(async () => { compact.focus(); setInputValue(compact, '160000'); });
    await act(async () => { compact.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      base_revision: 'rev-7',
      usage: { main: { auto_compact: 160000 } },
    }));
  });

  it('restores inheritance by writing null for the field rather than omitting it', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high', auto_compact: 160000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-restore="thinking_effort"]')!.click(); });
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      usage: { main: { thinking_effort: null } },
    }));
  });

  it('keeps "off" and "not sent" apart from being unset', async () => {
    const container = await openRow(usageEntity({ main: {} }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const effort = container.querySelector<HTMLInputElement>('[data-usage-value="thinking_effort"]')!;
    expect(effort.value).toBe('');
    // An empty field inherits: the shared value is the placeholder, not a value.
    expect(effort.placeholder).toBe('medium');
    setInputValue(container.querySelector<HTMLInputElement>('[data-usage-value="thinking_effort"]')!, 'off');
    expect(container.querySelector('[data-usage-effective="thinking_effort"]')?.textContent).toBe('Off');
    const tier = container.querySelector<HTMLButtonElement>('button[aria-label="Service tier"]')!;
    await pickValue(tier, 'data-usage-value', 'not_sent');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      usage: { main: { thinking_effort: 'off', service_tier: { kind: 'api_default' } } },
    }));
  });

  it('refuses an invalid token count, keeps the draft, and saves once it is valid', async () => {
    const container = await openRow(usageEntity({ main: {} }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    setInputValue(container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!, '0');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(updateModel).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-issue="context_budget"]')?.textContent).toBe('Use a whole number of tokens, 1 or more.');
    expect(container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!.value).toBe('0');
    setInputValue(container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!, '4096');
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({ usage: { main: { context_budget: 4096 } } }));
  });

  it('reads a token count the way the compaction point does, and keeps the wire an integer', async () => {
    const container = await openRow(usageEntity({ main: { context_budget: 160_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = () => container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!;
    // Stored as a number, it is shown the way its neighbours are shown.
    expect(field().value).toBe('160k');
    // `160k` and `160000` are the same value, and both land on the wire as 160000.
    setInputValue(field(), '160k');
    expect(field().value).toBe('160k');
    setInputValue(field(), '0.2M');
    expect(field().value).toBe('0.2M');
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(); });
    expect(updateModel).toHaveBeenLastCalledWith(MODEL_ID, expect.objectContaining({ usage: { main: { context_budget: 200000 } } }));
  });

  it('normalises a token count to the k form only once the field is left', async () => {
    const container = await openRow(usageEntity({ main: { context_budget: 160_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!;
    field.focus();
    await act(async () => { setInputValue(field, '160000'); });
    // Mid-edit the typed text stands; a half-typed number is never rescaled.
    expect(field.value).toBe('160000');
    await act(async () => { field.blur(); });
    expect(field.value).toBe('160k');
  });

  it('keeps an unreadable token count on screen for the row to report', async () => {
    const container = await openRow(usageEntity({ main: { context_budget: 160_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = () => container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!;
    field().focus();
    await act(async () => { setInputValue(field(), 'abc'); });
    await act(async () => { field().blur(); });
    expect(field().value).toBe('abc');
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(); });
    expect(updateModel).not.toHaveBeenCalled();
    expect(container.querySelector('[data-usage-issue="context_budget"]')).not.toBeNull();
  });

  it('names the effort chips as what the model supports, not the default', async () => {
    const container = await openRow(usageEntity({ main: {} }));
    // The support set and the per-identity default are two different fields and
    // must not read as the same setting managed twice.
    expect(document.body.textContent).toContain('Supported effort levels');
    expect(document.body.textContent).toContain('Default thinking effort');
  });

  it('pairs the short fields and gives only the compaction row the full measure', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high', context_budget: 160_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const fields = container.querySelector<HTMLElement>('[data-usage-fields="main"]')!;
    // A two-column grid that collapses to one column on a narrow width, so the
    // same order and the same fields stay reachable either way.
    expect(fields.className).toContain('sm:grid-cols-2');
    const cellOf = (field: string) => fields.querySelector<HTMLElement>(`[data-usage-row="${field}"]`)!.parentElement!;
    // The two pickers and the two token counts are all short controls, so each
    // pair shares a line: a number is read in one glance and does not need a
    // row to itself.
    for (const field of ['thinking_effort', 'service_tier', 'context_budget', 'max_completion_tokens']) {
      expect(cellOf(field).className).not.toContain('col-span-2');
    }
    // Only the compaction row spans the full width: it alone carries the
    // presets, the hint and the track.
    expect(cellOf('auto_compact').className).toContain('sm:col-span-2');
    // All five remain present and in the same order.
    expect([...fields.querySelectorAll('[data-usage-row]')].map((row) => row.getAttribute('data-usage-row')))
      .toEqual(['thinking_effort', 'service_tier', 'auto_compact', 'context_budget', 'max_completion_tokens']);
  });

  it('puts the restore control at the end of its own row, wherever the row wraps', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high', context_budget: 160_000, auto_compact: 120_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    // One action, one anchor: the same control in the same place in every row,
    // never drifting between a hint and a slider as the row wraps. `ms-auto` is
    // what holds it at the end of the first line, so that is the thing asserted;
    // jsdom has no layout, so a geometry check here would prove nothing.
    for (const field of ['thinking_effort', 'context_budget', 'auto_compact']) {
      const row = container.querySelector<HTMLElement>(`[data-usage-row="${field}"]`)!;
      const control = row.querySelector<HTMLElement>('.flex.min-w-0.flex-wrap')!;
      const restore = row.querySelector<HTMLElement>('[data-usage-restore]')!;
      expect(restore).not.toBeNull();
      // It lives in the control row itself, not after the hint or the track.
      expect(restore.parentElement).toBe(control);
      expect(restore.className).toContain('ms-auto');
      expect(restore.className).toContain('self-start');
      // Last in the row, so nothing can be appended after it and push it off
      // the line. The issue line only exists while a value is wrong.
      const trailing = [...control.children].filter((child) => !child.hasAttribute('data-usage-issue'));
      expect(trailing[trailing.length - 1]).toBe(restore);
    }
  });

  it('clears one position without touching the other', async () => {
    const container = await openRow(usageEntity({ main: { thinking_effort: 'high' }, independent: { thinking_effort: 'off' } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-restore="thinking_effort"]')!.click(); });
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({ usage: { main: { thinking_effort: null } } }));
    const sent = updateModel.mock.calls[0]?.[1] as { usage: Record<string, unknown> };
    expect(sent.usage['independent']).toBeUndefined();
  });

  it('does not present a stale projection as the result of an unsaved edit', async () => {
    // The server answered the last save: context_budget 180k from the model.
    const container = await openRow(usageEntity(
      { main: { context_budget: 150000 } },
      { main: { context_budget: '150000' } },
      { main: { context_budget: '[models.*.usage.main.context_budget]' } },
    ));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = () => container.querySelector<HTMLElement>('[data-usage-row="context_budget"]')!;
    const field = () => container.querySelector<HTMLInputElement>('[data-usage-value="context_budget"]')!;
    // Before any edit the saved projection is the truth and may be shown.
    expect(row().querySelector('[data-usage-effective="context_budget"]')?.textContent).toBe('150k');
    expect(row().querySelector('[data-usage-source="context_budget"]')).toBeNull();
    // Once edited, that projection answers a draft the person has replaced.
    setInputValue(field(), '90000');
    expect(row().querySelector('[data-usage-effective="context_budget"]')?.textContent).toBe('90k');
    expect(row().querySelector('[data-usage-source="context_budget"]')).toBeNull();
    // And the saved projection comes back once a save has been answered.
    await saveModel(container);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(row().querySelector('[data-usage-source="context_budget"]')).toBeNull();
  });

  it('edits a main difference on a model that has never configured one', async () => {
    // No `usage` key at all: the model simply has no difference yet, which is
    // every model until somebody writes one. That must not hide the editor.
    getModel.mockResolvedValue({ ...ENTITY } as GetModelResponse);
    const container = await renderCard();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for kimi-code/kimi-k2"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-main-usage-policy]')).not.toBeNull();
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-model-scope-differences]')).toBeNull();
    const compact = container.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    await act(async () => { compact.focus(); setInputValue(compact, '120000'); });
    await act(async () => { compact.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    expect(updateModel).toHaveBeenCalledWith(MODEL_ID, expect.objectContaining({
      usage: { main: { auto_compact: 120000 } },
    }));
  });

  it('offers every identity, including one the server has no branch for', async () => {
    const without = await openRow(usageEntity({ main: {} }));
    expect(scopeButton(without, 'independent')).not.toBeNull();
    expect(scopeButton(without, 'main')).not.toBeNull();
    expect(scopeButton(without, 'shared')).not.toBeNull();
  });

  it('offers the independent position once a branch exists for it', async () => {
    const withIndependent = await openRow(usageEntity({ main: {}, independent: { service_tier: 'flex' } }));
    expect(scopeButton(withIndependent, 'independent')).not.toBeNull();
  });

  it('writes the shared layer without disturbing an untouched branch', async () => {
    const container = await openRow(usageEntity({ main: { auto_compact: 160000 } }));
    // The shared scope edits the model's own compaction point, so the main
    // branch it already carries must come through the save unchanged or not
    // at all: a shared edit is not a reason to rewrite a difference.
    const point = container.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    await act(async () => { point.focus(); setInputValue(point, '150000'); point.blur(); });
    await saveModel(container);
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    expect(sent.auto_compact).toBe(150000);
    expect(sent.usage).toBeUndefined();
  });

  it('writes only the main branch when the identity track is dragged', async () => {
    // The shared point is 200k; the main branch says 120k. Dragging in the main
    // scope must move the identity's point and leave the shared one alone.
    const container = await openRow(usageEntity(
      { main: { auto_compact: 120_000 } },
      { main: { auto_compact: '120000' }, sub: { auto_compact: '200000' } },
    ));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => { slider.focus(); setInputValue(slider, '90000'); });
    await act(async () => { slider.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: { main?: Record<string, unknown> } };
    // The shared value is untouched, and only the main branch moves.
    expect(sent.auto_compact).toBeUndefined();
    expect(typeof sent.usage?.main?.['auto_compact']).toBe('number');
  });

  it('writes only the shared point when the shared track is dragged', async () => {
    const container = await openRow(usageEntity(
      { main: { auto_compact: 120_000 } },
      { main: { auto_compact: '120000' } },
    ));
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    await act(async () => { slider.focus(); setInputValue(slider, '100000'); });
    await act(async () => { slider.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    // The track snaps to its own step; what matters is the layer it wrote.
    expect(sent.auto_compact).toBeGreaterThan(0);
    // An untouched branch is not rewritten just because the shared layer moved.
    expect(sent.usage).toBeUndefined();
  });

  it('measures the track against the identity budget, not the shared one', async () => {
    // Shared budget 180k; the main branch tightens it to 90k. The track and
    // its hint must reflect the ceiling that actually limits this scope.
    const container = await openRow(usageEntity(
      { main: { context_budget: 120_000 } },
      { main: { context_budget: '120000' }, sub: { context_budget: '180000' } },
    ));
    const sharedCeiling = Number(container.querySelector<HTMLInputElement>('[data-compact-slider]')!.max);
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const slider = container.querySelector<HTMLInputElement>('[data-compact-slider]')!;
    // Both exact ceilings: the identity's is lower because its budget is, and a
    // regression to the shared number would fail here rather than slip through.
    expect(sharedCeiling).toBe(130_000);
    expect(Number(slider.max)).toBe(70_000);
    // And nothing on screen quotes the other scope's saved budget.
    const row = container.querySelector<HTMLElement>('[data-usage-row="auto_compact"]')!;
    expect(row.textContent).not.toContain('180k');
  });

  it('measures an inheriting identity against the shared point, not the global default', async () => {
    // The model sets 120k of its own, and the global default would be 85% of a
    // much larger window. An identity that sets nothing inherits the model's
    // point, so its track has to land on 120k and nowhere else.
    const container = await openRow(usageEntity(
      { main: { thinking_effort: 'high' } },
      { main: { auto_compact: '120000' }, sub: { auto_compact: '120000' } },
    ));
    getConfig.mockResolvedValue({ loop_control: { autoCompact: '85%' } });
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = container.querySelector<HTMLElement>('[data-usage-row="auto_compact"]')!;
    // The input stays empty, because empty is how an identity says "inherit".
    expect(row.querySelector<HTMLInputElement>('[data-compact-point-field] input')!.value).toBe('');
    // The track lands on the shared point as the shared clamp resolves it, not
    // on the 85% global default the engine would otherwise fall back to.
    expect(row.querySelector<HTMLInputElement>('[data-compact-slider]')!.value).toBe('130000');
    // And the placeholder names what it falls back to rather than a global default.
    const placeholder = row.querySelector<HTMLInputElement>('[data-compact-point-field] input')!.placeholder;
    expect(placeholder).not.toContain('%');
    expect(placeholder).not.toContain('85');
  });

  it('follows an unsaved shared point when the identity inherits it', async () => {
    const container = await openRow(usageEntity(
      { main: { thinking_effort: 'high' } },
      { main: { auto_compact: '120000' }, sub: { auto_compact: '120000' } },
    ));
    // Move the shared point without saving, then look at the identity.
    const sharedPoint = container.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    await act(async () => { sharedPoint.focus(); setInputValue(sharedPoint, '100000'); sharedPoint.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = container.querySelector<HTMLElement>('[data-usage-row="auto_compact"]')!;
    expect(row.querySelector<HTMLInputElement>('[data-compact-slider]')!.value).toBe('100000');
  });

  it('clears only the identity branch when an inherited difference is restored', async () => {
    const container = await openRow(usageEntity({ main: { auto_compact: 120_000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-restore="auto_compact"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    // Clearing the difference is `null` inside the branch, and the model's own
    // shared point is not part of this edit.
    expect(sent.usage).toEqual({ main: { auto_compact: null } });
    expect(sent.auto_compact).toBeUndefined();
  });

  it('writes the identity layer when that scope is the one being edited', async () => {
    const container = await openRow(usageEntity({ main: { auto_compact: 160000 } }));
    await act(async () => { scopeButton(container, 'main')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const point = container.querySelector<HTMLInputElement>('[data-compact-point-field="model:kimi-code/kimi-k2"] input')!;
    await act(async () => { point.focus(); setInputValue(point, '150000'); point.blur(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await saveModel(container);
    const sent = updateModel.mock.calls[0]?.[1] as { auto_compact?: number; usage?: unknown };
    // The same control writes the branch, not the model, when that is the
    // scope on screen; the shared value stays where it was.
    expect(sent.auto_compact).toBeUndefined();
    expect(sent.usage).toEqual({ main: { auto_compact: 150000 } });
  });
});

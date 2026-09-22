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

import { translate } from '@kiki/session-core/i18n';
import { I18nProvider } from '../../i18n';
import { DirtyGuardContext } from '../dirtyGuard';
import { CatalogRefreshCard, ModelCatalogCard } from './ModelsSection';

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

async function renderCard(reportDirty = (_id: string, _dirty: boolean) => {}): Promise<HTMLDivElement> {
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
  return container;
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
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!.click(); });
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'gateway/remote-suggested', provider_id: 'gateway', remote_id: 'remote-suggested', max_context_size: 128000 }));
    expect(setDefaultModel).not.toHaveBeenCalled();
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

    expect(container.textContent).toContain(
      'The server saved the parameters for kimi-code/kimi-k2.',
    );
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
    const acceptedMode = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Accepted image types source"]',
    )!;
    const conversion = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Unsupported image conversion"]',
    )!;
    await act(async () => {
      setInputValue(remoteId, 'kimi-k2.5');
      setSelectValue(acceptedMode, 'custom');
      setSelectValue(conversion, 'png');
    });
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
 * Collapsing a row is a peek, not a close: the editor stays mounted behind
 * `display: none` with its draft, baseline and dirty flag intact, and only an
 * explicit Close — confirmed while dirty — drops the draft.
 */
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

  async function openEditor(container: HTMLElement): Promise<void> {
    await act(async () => { editToggle(container).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('hides a collapsed editor without dropping its draft', async () => {
    const container = await renderCard();
    await openEditor(container);
    await act(async () => { setInputValue(nameInput(container), 'K2 Thinking'); });
    expect(buttonByText(container, 'Save').disabled).toBe(false);

    await act(async () => { editToggle(container).click(); });
    expect(editorWrapper(container)!.style.display).toBe('none');
    expect(nameInput(container).value).toBe('K2 Thinking');
    expect(container.querySelector('[data-collapsed-draft]')?.textContent).toBe('Unsaved');

    await act(async () => { editToggle(container).click(); });
    expect(editorWrapper(container)!.style.display).toBe('');
    expect(nameInput(container).value).toBe('K2 Thinking');
    expect(buttonByText(container, 'Save').disabled).toBe(false);
    expect(updateModel).not.toHaveBeenCalled();
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

  it('keeps a dirty editor mounted across filtering for another model and clearing the query', async () => {
    listModels.mockResolvedValue({ items: [...MODELS, { ...MODELS[0], id: 'other', remote_id: 'other-model', display_name: 'Other model' }] });
    const container = await renderCard();
    await openEditor(container);
    const input = nameInput(container);
    await act(async () => { setInputValue(input, 'K2 Thinking'); });
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await act(async () => { setInputValue(search, 'other-model'); });
    const row = editorWrapper(container)!.parentElement!;
    expect(row.style.display).toBe('none');
    expect(nameInput(container)).toBe(input);
    expect(input.value).toBe('K2 Thinking');
    expect(container.textContent).not.toContain('No models match');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameters for other"]')!.closest<HTMLElement>('.rounded-lg')!.style.display).toBe('');

    await act(async () => { setInputValue(search, 'zzz-no-match'); });
    expect(container.textContent).toContain('No models match');
    expect(row.parentElement!.parentElement!.style.display).toBe('none');
    await act(async () => { setInputValue(search, ''); });
    expect(row.style.display).toBe('');
    expect(row.parentElement!.parentElement!.style.display).toBe('');
    expect(nameInput(container)).toBe(input);
    expect(input.value).toBe('K2 Thinking');
    expect(buttonByText(container, 'Save').disabled).toBe(false);
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('reports the dirty state to the guard while the row is hidden by search', async () => {
    const reportDirty = vi.fn();
    const container = await renderCard(reportDirty);
    await openEditor(container);
    await act(async () => { setInputValue(nameInput(container), 'K2 Thinking'); });
    expect(reportDirty).toHaveBeenCalledWith('catalog-model:kimi-code/kimi-k2', true);
    reportDirty.mockClear();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await act(async () => { setInputValue(search, 'zzz-no-match'); });
    expect(editorWrapper(container)!.parentElement!.style.display).toBe('none');
    expect(reportDirty).not.toHaveBeenCalledWith('catalog-model:kimi-code/kimi-k2', false);
    await act(async () => { setInputValue(search, ''); });
    expect(reportDirty).not.toHaveBeenCalledWith('catalog-model:kimi-code/kimi-k2', false);
    await act(async () => { editToggle(container).click(); });
    expect(container.querySelector('[data-collapsed-draft]')?.textContent).toBe('Unsaved');
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
      const select = [...container.querySelectorAll<HTMLSelectElement>('[data-model-row-editor] label select')]
        .find((candidate) => candidate.closest('label')?.textContent?.startsWith(identityLabel))!;
      await act(async () => { setSelectValue(select, 'custom_overrides'); });
      const textarea = container.querySelector<HTMLTextAreaElement>('[data-model-row-editor] textarea')!;
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

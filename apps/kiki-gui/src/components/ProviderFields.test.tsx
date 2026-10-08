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
import type { OAuthMethodStatus } from '@kiki/klient';

import { I18nProvider } from '../i18n';
import { accountState, needsSignInAction } from './accountSignInState';
import { AccountConnectionPanel } from './AccountConnectionPanel';
import { NewProviderWizard, ProviderEditor } from './ProviderFields';
import { DirtyGuardContext } from './dirtyGuard';
import { ConnectionsTab } from './settings/ProvidersSection';
import { SettingsCardMountContext } from './settings/SectionCard';
import { optionValues, openOptions, pickValue } from './settings/testControls';

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
const startOAuthLogin = vi.fn();
const cancelOAuthLogin = vi.fn(async () => ({ cancelled: true, status: 'cancelled' }));
const listOAuthMethods = vi.fn(async (): Promise<unknown[]> => []);
const probeOriginalOAuth = vi.fn(async (): Promise<unknown> => ({}));
const connectOriginalOAuth = vi.fn(async (_request?: Record<string, unknown>): Promise<unknown> => ({}));
const SIGNED_IN_KIMI = [
  { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
    account: { state: 'unknown' }, quota: { state: 'unknown' } },
];
const listProviderHealth = vi.fn(async (): Promise<{ items: unknown[] }> => ({ items: [] }));
const testProviderConnection = vi.fn();
const logoutOAuth = vi.fn(async () => ({ logged_out: true }));
const reportDirty = vi.fn();
const revealSecret = vi.fn();
const connectionClientOverride = vi.hoisted(() => ({ current: null as object | null, scopeId: null as string | null }));

// One client for the whole run, like the app's connection context: a fresh
// object per render would renew every callback that depends on it.
vi.mock('../state/connection', () => {
  let connection: ReturnType<typeof build>;
  const build = () => ({
    config: {},
    scopeId: 'scope-a',
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
      startOAuthLogin,
      cancelOAuthLogin,
      listOAuthMethods,
      logoutOAuth,
      probeOriginalOAuth,
      connectOriginalOAuth,
      listProviderHealth,
      testProviderConnection,
      revealSecret,
    },
  });
  return { useConnection: () => {
    connection ??= build();
    return {
      ...connection,
      client: connectionClientOverride.current ?? connection.client,
      scopeId: connectionClientOverride.scopeId ?? connection.scopeId,
    };
  } };
});
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
  connectionClientOverride.current = null;
  connectionClientOverride.scopeId = null;
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  listProviderHealth.mockReset().mockResolvedValue({ items: [] });
  testProviderConnection.mockReset();
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
  startOAuthLogin.mockReset().mockResolvedValue({
    flow_id: 'flow-1', provider: 'managed:openai-codex', status: 'pending',
    verification_uri: 'https://auth.example.test/device',
    verification_uri_complete: 'https://auth.example.test/device?code=WXYZ-1234',
    user_code: 'WXYZ-1234', expires_in: 900, interval: 5,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
  });
  cancelOAuthLogin.mockClear();
  logoutOAuth.mockClear();
  probeOriginalOAuth.mockReset().mockResolvedValue({
    provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'file',
    state: 'ready', account: { state: 'known', id: 'dev@example.test' }, can_connect: true,
  });
  connectOriginalOAuth.mockReset().mockResolvedValue({
    provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'file',
    state: 'ready', account: { state: 'known', id: 'dev@example.test' }, can_connect: true,
  });
  reportDirty.mockClear();
  revealSecret.mockReset().mockResolvedValue({ source: 'kiki', value: 'sk-stored' });
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
  const rerender = async (content: ReactNode) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <I18nProvider>
              <DirtyGuardContext.Provider value={{ dirty: false, reportDirty, navigate: () => {} }}>
                {content}
              </DirtyGuardContext.Provider>
            </I18nProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
  };
  await rerender(children);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, client, rerender };
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

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The provider key field; a stored key has to be opened for editing first. */
function keyInput(container: ParentNode): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-secret-field] input')!;
}
async function typeKey(container: ParentNode, value: string): Promise<void> {
  const edit = container.querySelector<HTMLButtonElement>('[data-secret-field] [data-secret-edit]');
  if (edit !== null) await act(async () => { edit.click(); });
  await act(async () => { setInputValue(keyInput(container), value); });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`button not found: ${text}`);
  return button;
}

describe('ProviderEditor save channel', () => {
  it('masks a stored key, reveals it on request, and only sends a changed key', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    expect(keyInput(container).value).not.toContain('sk-stored');
    expect(container.textContent).toContain('Saved in Kiki');
    expect(revealSecret).not.toHaveBeenCalled();
    expect(buttonByText(container, 'Save provider').disabled).toBe(true);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(revealSecret).toHaveBeenCalledWith({ kind: 'provider_api_key', provider_id: COLON_PROVIDER.id });
    expect(keyInput(container).value).toBe('sk-stored');

    const url = [...container.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => { setInputValue(url, 'https://edge-2.example.test/v1'); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      base_url: 'https://edge-2.example.test/v1', base_revision: 'provider-rev-1',
    });

    await typeKey(container, 'sk-new');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { api_key: 'sk-new', base_revision: 'provider-rev-2' });
    // After a save the field returns to the masked, stored state.
    expect(keyInput(container).value).not.toContain('sk-new');
  });

  it('shows an edited key as saved after the save, and reveals the new value', async () => {
    // Replacing one stored key with another leaves `has_api_key` and a
    // content-hashed revision unchanged; the field must still settle.
    updateProvider.mockResolvedValue({ ...COLON_PROVIDER, revision: 'provider-rev-1' });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    await typeKey(container, 'sk-new');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { api_key: 'sk-new', base_revision: 'provider-rev-1' });

    const field = container.querySelector<HTMLElement>('[data-secret-field]')!;
    expect(field.dataset['secretMode']).toBe('keep');
    expect(field.dataset['secretSource']).toBe('kiki');
    expect(keyInput(container).readOnly).toBe(true);
    expect(keyInput(container).value).not.toBe('');
    expect(field.textContent).toContain('Saved in Kiki');
    expect(field.querySelector('[data-secret-edit]')).not.toBeNull();
    expect(buttonByText(container, 'Save provider').disabled).toBe(true);

    revealSecret.mockResolvedValue({ source: 'kiki', value: 'sk-new' });
    await act(async () => { field.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(keyInput(container).value).toBe('sk-new');
  });

  it('shows a cleared key as not set after the save, with nothing to reveal', async () => {
    let provider = COLON_PROVIDER;
    const { container } = await renderSurface(<></>);
    const root = roots.at(-1)!;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = async () => {
      await act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={client}>
              <I18nProvider>
                <DirtyGuardContext.Provider value={{ dirty: false, reportDirty, navigate: () => {} }}>
                  <ProviderEditor provider={provider} models={FAST_MODELS} onSaved={onSaved} />
                </DirtyGuardContext.Provider>
              </I18nProvider>
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    };
    const onSaved = async () => {};
    await render();

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-clear]')!.click(); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { api_key: '', base_revision: 'provider-rev-1' });
    // The catalog refetch after the save is what flips `has_api_key`.
    provider = { ...provider, has_api_key: false };
    await render();

    const field = container.querySelector<HTMLElement>('[data-secret-field]')!;
    expect(field.dataset['secretSource']).toBe('none');
    expect(field.dataset['secretMode']).toBe('keep');
    expect(field.textContent).toContain('Not set');
    expect(keyInput(container).value).toBe('');
    expect(field.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.disabled).toBe(true);
    expect(field.querySelector('[data-secret-edit]')).toBeNull();
    revealSecret.mockClear();
    await act(async () => { field.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click(); });
    expect(revealSecret).not.toHaveBeenCalled();
  });

  it('shows an environment key by name, reveals it, and saves a Kiki override', async () => {
    const envProvider: ProviderCatalogItem = { ...COLON_PROVIDER, has_api_key: true, api_key_env: 'OPENAI_API_KEY' };
    revealSecret.mockResolvedValue({ source: 'environment', env_name: 'OPENAI_API_KEY', value: 'sk-from-env' });
    const container = await renderEditor(envProvider, FAST_MODELS, false, async () => {});
    expect(container.textContent).toContain('From environment variable OPENAI_API_KEY');
    expect(container.querySelector('[data-secret-clear]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(keyInput(container).value).toBe('sk-from-env');
    await typeKey(container, 'sk-inline');
    expect(container.textContent).toContain('Saving stores this value in Kiki and uses it instead');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenCalledWith(envProvider.id, { api_key: 'sk-inline', base_revision: 'provider-rev-1' });
  });

  it('saves provider defaults as a scoped sparse patch and clears only the selected field', async () => {
    getProviderEntity.mockResolvedValue({ ...COLON_PROVIDER, revision: 'provider-rev-1', defaults: { temperature: 0, max_completion_tokens: 8192 } });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    const editor = container.querySelector<HTMLElement>('[data-generation-editor="provider:edge:gateway"]')!;
    expect(editor.textContent).toContain('models without local overrides');
    await pickValue(editor.querySelector('button[aria-label="Temperature mode"]')!, 'data-param-mode', 'inherit');
    await pickValue(editor.querySelector('button[aria-label="Max generated tokens mode"]')!, 'data-param-mode', 'custom');
    await act(async () => { [...editor.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save parameters')!.click(); });
    expect(updateProvider).toHaveBeenCalledWith('edge:gateway', { base_revision: 'provider-rev-1', defaults: { temperature: null } });
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('probes with a changed unsaved key but uses the stored key when untouched', async () => {
    refreshProvider.mockResolvedValue({ changed: [], unchanged: [COLON_PROVIDER.id], failed: [] });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, undefined);
    await typeKey(container, 'sk-draft');
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, 'sk-draft');
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it('never sends a draft key to the saved address while the draft connection is unsaved', async () => {
    refreshProvider.mockResolvedValue({ changed: [], unchanged: [COLON_PROVIDER.id], failed: [] });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    const url = [...container.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => { setInputValue(url, 'https://edge-2.example.test/v1'); });
    await typeKey(container, 'YOUR_API_KEY');
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Save this connection first');

    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      base_url: 'https://edge-2.example.test/v1', api_key: 'YOUR_API_KEY', base_revision: 'provider-rev-1',
    });
    await typeKey(container, 'sk-next');
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, 'sk-next');
  });

  it('never sends a draft key to the saved protocol while the draft protocol is unsaved', async () => {
    refreshProvider.mockResolvedValue({ changed: [], unchanged: [COLON_PROVIDER.id], failed: [] });
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    // Stored editors scope their field ids so several can share the page.
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Protocol"]')!.click(); });
    // The panel is portaled to <body>, so the rows are read from the open
    // panel rather than from the editor's own root.
    const anthropic = openOptions(container)
      .find((option) => option.textContent?.includes('Anthropic Messages'))!;
    await act(async () => { anthropic.click(); });
    await typeKey(container, 'YOUR_API_KEY');
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Save this connection first');

    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      type: 'anthropic', api_key: 'YOUR_API_KEY', base_revision: 'provider-rev-1',
    });
    await act(async () => { buttonByText(container, 'Test connection & pull models').click(); });
    expect(refreshProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, undefined);
  });

  it('clears a stored key in the field as a pending change that saves "" and can be undone', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-clear]')!.click(); });
    expect(container.textContent).toContain('Will be removed when you save');
    expect(updateProvider).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-undo]')!.click(); });
    expect(buttonByText(container, 'Save provider').disabled).toBe(true);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-secret-clear]')!.click(); });
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      api_key: '', base_revision: 'provider-rev-1',
    });
  });

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
    await act(async () => { setInputValue(baseUrl, 'https://draft.example.test/v1'); });
    await typeKey(first, 'YOUR_API_KEY');
    await act(async () => { second.querySelector<HTMLButtonElement>('button[aria-label="Edit model 1 details"]')!.click(); });
    const name = second.querySelector<HTMLInputElement>('input[aria-label="Model 1 display name"]')!;
    await act(async () => { setInputValue(name, 'Changed elsewhere'); });
    await act(async () => { buttonByText(second, 'Save provider').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(listModels.mock.calls.length).toBeGreaterThan(1);
    expect(baseUrl.value).toBe('https://draft.example.test/v1');
    expect(keyInput(first).value).toBe('YOUR_API_KEY');
    expect(buttonByText(first, 'Save provider').disabled).toBe(false);
    expect(reportDirty.mock.calls.findLast(([id]) => id === 'provider:edge:gateway')).toEqual(['provider:edge:gateway', true]);
    // Revision reads plus the generation defaults and connection extras editors' own entity reads.
    expect(getProviderEntity.mock.calls.filter(([id]) => id === 'edge:gateway')).toHaveLength(4);
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
    const readsBeforeRefresh = listProviders.mock.calls.length;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['providers'] });
    });
    await act(async () => {
      client.setQueryData(['models'], { items: [...FAST_MODELS, { ...MANAGED_MODELS[0], display_name: 'Background catalog change' }] });
    });
    expect(listProviders.mock.calls.length).toBeGreaterThan(readsBeforeRefresh);
    expect(baseUrl.value).toBe('https://draft.example.test/v1');
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
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-connection-source-choice="manual"]')!.click(); });
    const template = container.querySelector<HTMLButtonElement>('button[data-provider-template="openai"]');
    expect(template, 'OpenAI preset').not.toBeNull();
    await act(async () => { template!.click(); });
    expect(container.querySelector<HTMLInputElement>('input[value="openai"]')).not.toBeNull();
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

  it('a protocol card in Settings names the connection from its address and flags an empty one', async () => {
    const onSaved = vi.fn(async () => {});
    const { container } = await renderSurface(<NewProviderWizard onSaved={onSaved} />);
    // A key needs a service to go to: the directory is the default source, so
    // the hand-written path is one switch away.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-connection-source-choice="manual"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-provider-protocol="openai"]')!.click(); });
    await act(async () => { buttonByText(container, 'Create provider').click(); });
    expect(createProvider).not.toHaveBeenCalled();
    expect(container.querySelector('#provider-field-base-url-issue')?.textContent).toBe('Fill in the Base URL first.');
    const baseUrl = container.querySelector<HTMLInputElement>('#provider-field-base-url')!;
    await act(async () => { setInputValue(baseUrl, 'https://api.deepseek.com/v1'); });
    expect(container.querySelector('#provider-field-base-url-issue')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('#provider-field-id')!.value).toBe('deepseek');
    await act(async () => { setInputValue(container.querySelector<HTMLInputElement>('#provider-field-id')!, ''); });
    await act(async () => { buttonByText(container, 'Create provider').click(); });
    expect(container.querySelector('#provider-field-id-issue')?.textContent).toBe('Give this connection a name.');
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('allows unrelated repairs with a dangling default and exposes clearing or replacing it', async () => {
    const dangling = { ...COLON_PROVIDER, default_model: 'removed-alias' };
    const container = await renderEditor(dangling, FAST_MODELS, false, async () => {});
    const baseUrl = [...container.querySelectorAll('input')].find((input) => input.value === COLON_PROVIDER.base_url)!;
    await act(async () => { setInputValue(baseUrl, 'https://repaired.example.test/v1'); });
    await typeKey(container, 'YOUR_API_KEY');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, {
      base_url: 'https://repaired.example.test/v1', api_key: 'YOUR_API_KEY', base_revision: 'provider-rev-1',
    });
    const select = container.querySelector('[data-provider-default-model="removed-alias"]')!;
    expect(await optionValues(select)).toEqual(['', 'removed-alias', 'fast']);
    await pickValue(select, 'data-provider-default-model', '');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { default_model: null, base_revision: 'provider-rev-2' });
    await pickValue(select, 'data-provider-default-model', 'fast');
    await act(async () => { buttonByText(container, 'Save provider').click(); });
    expect(updateProvider).toHaveBeenLastCalledWith(COLON_PROVIDER.id, { default_model: 'fast', base_revision: 'provider-rev-2' });
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('patches an unchanged managed:kimi-code id without any model list or id rewrite', async () => {
    const onSaved = vi.fn(async () => {});
    const container = await renderEditor(MANAGED_PROVIDER, MANAGED_MODELS, true, onSaved);

    // An account connection's address and protocol belong to the provider, so
    // the form offers neither: the fields that remain are the ones the person
    // actually owns.
    expect(container.querySelector('#provider-field-base-url')).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('#provider-field-id')).toBeNull();

    const select = [...container.querySelectorAll<HTMLElement>('[data-provider-default-model]')][0]!;
    expect(select, 'provider default model select').toBeDefined();
    await pickValue(select, 'data-provider-default-model', '');
    await act(async () => {
      buttonByText(container, 'Save provider').click();
    });

    expect(getProviderEntity).toHaveBeenCalledWith('managed:kimi-code');
    expect(updateProvider).toHaveBeenCalledTimes(1);
    const [providerId, patch] = updateProvider.mock.calls[0] as [string, Record<string, unknown>];
    expect(providerId).toBe('managed:kimi-code');
    expect(patch).toEqual({
      default_model: null,
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
      max_context_size: 250000,
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
    expect(createModel).toHaveBeenCalledWith(expect.objectContaining({
      max_context_size: 250000,
      capabilities: ['thinking', 'tool_use'],
    }));
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
      .toBe('250');
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

describe('Connections list', () => {
  const LOCAL_PROVIDER: ProviderCatalogItem = {
    id: 'ollama',
    type: 'openai',
    base_url: 'http://localhost:11434/v1',
    has_api_key: false,
    status: 'connected',
    models: [],
  };

  it('groups connections by how they are reached, not by vendor, and states health in words', async () => {
    listOAuthMethods.mockResolvedValue(SIGNED_IN_KIMI);
    listProviders.mockResolvedValue({ items: [COLON_PROVIDER, LOCAL_PROVIDER, { ...MANAGED_PROVIDER }] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const rows = [...container.querySelectorAll<HTMLElement>('[data-connection-row]')];
    expect(rows.map((row) => [row.dataset['connectionRow'], row.dataset['connectionKind']])).toEqual([
      ['managed:kimi-code', 'account'],
      ['edge:gateway', 'api'],
      ['ollama', 'local'],
    ]);
    // The account row names the sign-in and its kind, never a wire protocol.
    const accountSummary = rows[0]!.querySelector('summary')!.textContent;
    expect(accountSummary).toContain('Kimi Code');
    expect(accountSummary).toContain('Account');
    expect(accountSummary).not.toContain('Moonshot');
    expect(rows[2]!.querySelector('summary')!.textContent).toContain('Local server · localhost:11434');
    expect(rows[1]!.querySelector('[data-connection-status]')!.textContent).toContain('Connected');
    // No per-row protocol/identity/key pills in the collapsed row.
    expect(rows[1]!.querySelector('summary')!.textContent).not.toContain('key stored');
  });

  it('shows an error row with the last failure and a fix, and signs an account out from its row', async () => {
    listDiscoveredModels.mockResolvedValue({
      items: [{ provider_id: 'edge:gateway', fetched_at: null, attempted_at: 1, failure_reason: '401 Unauthorized', models: [] }],
    } as never);
    listOAuthMethods.mockResolvedValue(SIGNED_IN_KIMI);
    listProviders.mockResolvedValue({ items: [COLON_PROVIDER, MANAGED_PROVIDER] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const errored = container.querySelector<HTMLDetailsElement>('[data-connection-row="edge:gateway"]')!;
    expect(errored.dataset['connectionHealth']).toBe('error');
    await act(async () => { errored.open = true; });
    expect(errored.querySelector('[data-connection-error]')!.textContent).toContain('401 Unauthorized');

    const account = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:kimi-code"]')!;
    await act(async () => { account.open = true; });
    await act(async () => { buttonByText(account, 'Sign out').click(); });
    expect(logoutOAuth).toHaveBeenCalledWith({ provider: 'kimi-code' });
  });

  it('uses the last connection test over the model fetch and tests again with one request at a time', async () => {
    listDiscoveredModels.mockResolvedValue({
      items: [{ provider_id: 'edge:gateway', fetched_at: null, attempted_at: 1, failure_reason: 'upstream said: secret body', models: [] }],
    } as never);
    listProviderHealth.mockResolvedValue({ items: [{
      provider_id: 'edge:gateway', model_id: 'fast', ok: false, checked_at: Date.now() - 60_000, duration_ms: 734,
      error_code: 'request_failed', http_status: 401, error: 'The test request failed (HTTP 401).',
    }] });
    let finish: (value: unknown) => void = () => {};
    testProviderConnection.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    listProviders.mockResolvedValue({ items: [COLON_PROVIDER] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="edge:gateway"]')!;
    await act(async () => { row.open = true; });
    const error = row.querySelector('[data-connection-error]')!;
    // Only the server's generic text, plus a fix keyed by the status.
    expect(error.textContent).toContain('The test request failed (HTTP 401).');
    expect(error.textContent).not.toContain('secret body');
    expect(error.textContent).toContain('The key was refused');
    expect(row.querySelector('[data-connection-last-test]')!.textContent).toContain('734ms');

    const button = row.querySelector<HTMLButtonElement>('[data-connection-test-button]')!;
    await act(async () => { button.click(); });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Testing');
    await act(async () => { button.click(); });
    expect(testProviderConnection).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ provider_id: 'edge:gateway', model_id: 'fast', ok: true, checked_at: Date.now(), duration_ms: 212 }); });
    expect(row.dataset['connectionHealth']).toBe('ok');
    expect(row.querySelector('[data-connection-error]')).toBeNull();
    expect(row.querySelector('[data-connection-last-test="ok"]')!.textContent).toContain('Test passed');
  });

  it('shows the account and a percent or absolute quota, and nothing for an unknown quota', async () => {
    const codex: ProviderCatalogItem = { ...MANAGED_PROVIDER, id: 'managed:openai-codex', models: [] };
    const copilot: ProviderCatalogItem = { ...MANAGED_PROVIDER, id: 'managed:github-copilot', models: [] };
    listOAuthMethods.mockResolvedValue([
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
        account: { state: 'known', id: 'dev@example.test' }, quota: { state: 'known', label: 'Weekly limit', remaining: 38.4, unit: 'percent' } },
      { id: 'github-copilot', label: 'GitHub Copilot', provider: 'managed:github-copilot', protocol: 'openai', signed_in: true,
        account: { state: 'known', id: 'octo' }, quota: { state: 'known', label: 'Premium interactions', remaining: 1240, unit: 'count' } },
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: true,
        account: { state: 'known', id: 'user-1' }, quota: { state: 'unknown' } },
    ]);
    listProviders.mockResolvedValue({ items: [MANAGED_PROVIDER, copilot, codex] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const summary = (id: string) => container.querySelector(`[data-connection-row="${id}"] summary`)!;
    expect(summary('managed:kimi-code').querySelector('[data-connection-account]')!.textContent).toBe('dev@example.test');
    expect(summary('managed:kimi-code').querySelector('[data-connection-quota="percent"]')!.textContent).toBe('Weekly limit: 38% left');
    expect(summary('managed:github-copilot').querySelector('[data-connection-quota="count"]')!.textContent).toBe('Premium interactions: 1,240 left');
    expect(summary('managed:openai-codex').querySelector('[data-connection-quota]')).toBeNull();
    expect(summary('managed:openai-codex').textContent).not.toMatch(/\b0\b.*left/);
  });

  it('keeps request identity and image policy behind Advanced', async () => {
    const container = await renderEditor(COLON_PROVIDER, FAST_MODELS, false, async () => {});
    const advanced = container.querySelector<HTMLElement>('[data-advanced="provider-edge:gateway"]')!;
    expect(advanced.querySelector('[id^="advanced-"]')!.hasAttribute('hidden')).toBe(true);
    await act(async () => { advanced.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    expect(advanced.querySelector('[id^="advanced-"]')!.hasAttribute('hidden')).toBe(false);
    expect(advanced.textContent).toContain('Provider request identity');
  });

  it('offers one add entry — sign in, or a service by key — over an empty list', async () => {
    listProviders.mockResolvedValue({ items: [] });
    listOAuthMethods.mockResolvedValue([
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
        account: { state: 'unknown' }, quota: { state: 'unknown' } },
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false,
        account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ]);
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-connections-empty]')).not.toBeNull();

    // An empty page is the add flow, and the two ways in are one question.
    const picker = container.querySelector<HTMLElement>('[data-connection-method-picker]')!;
    expect(picker.dataset['connectionMethod']).toBe('api');
    // A key needs a service, so the directory leads and the hand-written path
    // is a switch away — not a second card to find.
    expect(picker.querySelector<HTMLElement>('[data-connection-source]')!.dataset['connectionSource']).toBe('directory');
    expect(picker.querySelector('[data-catalog-picker]')).not.toBeNull();
    expect(picker.querySelectorAll('[data-provider-protocol]')).toHaveLength(0);
    await act(async () => { picker.querySelector<HTMLButtonElement>('[data-connection-source-choice="manual"]')!.click(); });
    expect(picker.querySelectorAll('[data-provider-protocol]')).toHaveLength(5);


    // Signing in is the other lane, and it offers only what the list does not
    // already have. The fixture has no connections at all, so both appear.
    await act(async () => { picker.querySelector<HTMLButtonElement>('[data-connection-choice="account"]')!.click(); });
    const methods = [...picker.querySelectorAll<HTMLElement>('[data-oauth-method]')];
    expect(methods.map((row) => row.getAttribute('data-oauth-method'))).toEqual(['kimi-code', 'openai-codex']);
    expect(methods[1]!.querySelector('[data-account-sign-in-button]')).not.toBeNull();
  });

  it('offers no sign-in for an account the list already has, and leaves that row to recover it', async () => {
    listOAuthMethods.mockResolvedValue([
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
        connection_state: 'ready', account: { state: 'unknown' }, quota: { state: 'unknown' } },
      { id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai', signed_in: true,
        connection_state: 'reconnect_required', account: { state: 'known', id: 'team@example.test' }, quota: { state: 'unknown' } },
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false,
        account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ]);
    // Both accounts exist as connections, one of them with a spent credential.
    listProviders.mockResolvedValue({ items: [
      { ...MANAGED_PROVIDER, id: 'managed:kimi-code' },
      { ...MANAGED_PROVIDER, id: 'managed:grok-build', status: 'unconfigured', models: [] },
    ] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // The add flow opens beside a list that already has rows, in a portaled
    // side panel, so it is reached through the document rather than the tree
    // the page rendered into.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-add-connection]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const picker = document.querySelector<HTMLElement>('[data-connection-method-picker]');
    expect(picker, 'the add flow opened').not.toBeNull();
    await act(async () => { picker!.querySelector<HTMLButtonElement>('[data-connection-choice="account"]')!.click(); });

    // The filter is the configured provider id, not the credential: a spent
    // Grok token still has a connection, and that row is where it is recovered.
    const offered = [...picker!.querySelectorAll('[data-oauth-method]')].map((row) => row.getAttribute('data-oauth-method'));
    expect(offered).toEqual(['openai-codex']);
    // And both connections are still on the list, Grok among them.
    expect([...container.querySelectorAll('[data-connection-row]')].map((row) => row.getAttribute('data-connection-row')))
      .toEqual(expect.arrayContaining(['managed:kimi-code', 'managed:grok-build']));
  });
  });

  it('keeps an account in one row: its state, its account and the way back in', async () => {
    const codex: ProviderCatalogItem = { ...MANAGED_PROVIDER, id: 'managed:openai-codex', status: 'unconfigured', models: [] };
    listOAuthMethods.mockResolvedValue([
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
        signed_in: true, connection_state: 'reconnect_required', account: { state: 'known', id: 'dev@example.test' }, quota: { state: 'unknown' } },
    ]);
    listProviders.mockResolvedValue({ items: [codex] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // A due refresh is still connected: Kiki renews it, so nothing is asked of
    // the person.
    const dueRefresh = accountState({ signed_in: true, connection_state: 'refresh_required' }, undefined);
    expect(dueRefresh.state).toBe('connected');
    expect(needsSignInAction(dueRefresh)).toBe(false);

    // One row holds the whole account: the name a person recognizes, the
    // account behind it, the state, and the one action that changes it.
    const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
    expect(row.querySelector('summary')!.textContent).toContain('ChatGPT');
    expect(row.dataset['connectionHealth']).toBe('setup');
    expect(row.querySelector('summary')!.textContent).toContain('Sign-in expired');
    await act(async () => { row.open = true; });
    const panel = row.querySelector<HTMLElement>('[data-connection-account-panel="openai-codex"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('The provider no longer accepts this sign-in');
    expect(panel.querySelector('[data-connection-sign-in]')!.textContent).toContain('Sign in again');
    // The state is stated once, by the row: the panel adds the action and the
    // reason, not a second copy of the status the header already carries.
    expect(panel.querySelector('[data-account-state]')).toBeNull();
    expect(panel.querySelector('[data-account-state-mark]')).toBeNull();
    // The account it knows is still shown — the sign-in is spent, not the account.
    expect(row.querySelector('[data-connection-account]')!.textContent).toBe('dev@example.test');
    // A spent credential is neither removed nor replaced by a second row.
    expect(container.querySelectorAll('[data-connection-row]')).toHaveLength(1);
  });

  it('gives a connected account its sign-out on the same row', async () => {
    const kimi: ProviderCatalogItem = { ...MANAGED_PROVIDER, id: 'managed:kimi-code' };
    listOAuthMethods.mockResolvedValue([
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true,
        connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' }, quota: { state: 'unknown' } },
    ]);
    listProviders.mockResolvedValue({ items: [kimi] });
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:kimi-code"]')!;
    await act(async () => { row.open = true; });
    const panel = row.querySelector<HTMLElement>('[data-connection-account-panel="kimi-code"]')!;
    // Connected keeps the green mark on the row; a spent credential is amber.
    expect(panel.querySelector('[data-account-state-mark]')).toBeNull();
    expect(row.querySelector('summary')!.textContent).toContain('Connected');
    await act(async () => { panel.querySelector<HTMLButtonElement>('[data-connection-sign-out]')!.click(); });
    expect(logoutOAuth).toHaveBeenCalledWith({ provider: 'kimi-code' });
  });

  it('states a cancelled sign-in once, and leaves no connection behind', async () => {
    listOAuthMethods.mockResolvedValue([
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
        signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ]);
    listProviders.mockResolvedValue({ items: [] });
    // The server keeps the flow it issued and answers the poll with it, which
    // is what the real service does while the code is live.
    const flow = (status: string) => ({
      flow_id: 'flow-1', provider: 'managed:openai-codex', status,
      verification_uri: 'https://auth.example.test/device',
      verification_uri_complete: 'https://auth.example.test/device?code=WXYZ-1234',
      user_code: 'WXYZ-1234', expires_in: 900, interval: 5,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    });
    let issued = false;
    startOAuthLogin.mockImplementation(async () => { issued = true; return flow('pending'); });
    getOAuthStatus.mockImplementation(async () => (issued ? flow('cancelled') : null));
    const { container } = await renderSurface(<ConnectionsTab />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const picker = () => document.querySelector<HTMLElement>('[data-connection-method-picker]')!;
    await act(async () => { picker().querySelector<HTMLButtonElement>('[data-connection-choice="account"]')!.click(); });
    const row = () => container.querySelector<HTMLElement>('[data-oauth-method="openai-codex"]')!;
    await act(async () => { row().querySelector<HTMLButtonElement>('[data-account-sign-in-button]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // The reason is said once: the card names it, the row adds no second copy
    // of it and offers the single retry.
    const terminal = row().querySelector<HTMLElement>('[data-oauth-terminal="cancelled"]')!;
    expect(terminal.textContent).toContain('Sign-in was cancelled.');
    expect(row().querySelector('[data-account-detail="failed"]')).toBeNull();
    expect([...terminal.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Dismiss']);

    // A flow that never completed creates no connection: the list is still
    // empty rather than holding a row pretending to be signed in.
    expect(container.querySelector('[data-connection-list]')).toBeNull();
    expect(createProvider).not.toHaveBeenCalled();

    // Dismissing puts the card away, and the catalog returns to the only fact
    // the server still has: no credential, so "Not signed in" with a fresh
    // Sign in. The row does not keep a remembered failure the server no
    // longer reports — the dismissal is the person closing that thread.
    await act(async () => { terminal.querySelector<HTMLButtonElement>('[data-oauth-dismiss]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(row().querySelector('[data-oauth-terminal]')).toBeNull();
    expect(row().querySelector<HTMLElement>('[data-account-state]')!.dataset['accountState']).toBe('signIn');
    expect(row().textContent).not.toContain('You cancelled the sign-in');
  });

  it('opens the sign-in lane for a #st-card-auth deep link, in both list states', async () => {
    // `/new` and settings search both still point at this id. There is no
    // sign-in card any more, so the link has to land on the one add flow and
    // say it is on screen — the page only scrolls to a card that announces
    // itself, so a flow that renders without announcing would be a dead link.
    const announce = vi.fn();
    listOAuthMethods.mockResolvedValue([
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
        signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ]);

    const renderLinked = async () => {
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      const root = createRoot(container);
      roots.push(root);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={['/settings/ai?tab=providers#st-card-auth']}>
            <QueryClientProvider client={client}>
              <I18nProvider>
                <SettingsCardMountContext.Provider value={announce}>
                  <ConnectionsTab />
                </SettingsCardMountContext.Provider>
              </I18nProvider>
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      // The add flow opens in a portal, so tearing the tree down — not just
      // removing the container — is what actually takes the flow off the page.
      return async () => { await act(async () => { root.unmount(); }); };
    };

    // With connections on the page the flow opens beside the list, and the id
    // it carries is the one the link asked for.
    listProviders.mockResolvedValue({ items: [MANAGED_PROVIDER] });
    const unmount = await renderLinked();
    expect(announce).toHaveBeenCalledWith('st-card-auth');
    const flow = document.querySelector<HTMLElement>('[data-connection-method-picker]');
    expect(flow).not.toBeNull();
    // The account lane is the one a sign-in link asked for, not the key form.
    expect(flow!.querySelector<HTMLElement>('[data-connection-choice="account"]')!.getAttribute('aria-checked')).toBe('true');
    // Exactly one element owns the id, so the page's scroll lands on one place.
    expect(document.querySelectorAll('#st-card-auth')).toHaveLength(1);
    await unmount();

    // With nothing configured the flow is the page, and the link still lands.
    announce.mockClear();
    listProviders.mockResolvedValue({ items: [] });
    const unmountEmpty = await renderLinked();
    expect(announce).toHaveBeenCalledWith('st-card-auth');
    expect(document.querySelector('[data-connection-method-picker]')).not.toBeNull();
    expect(document.querySelectorAll('#st-card-auth')).toHaveLength(1);
    await unmountEmpty();
  });

  describe('reusing the machine’s own sign-in', () => {
    const CODEX_ROW: ProviderCatalogItem = { ...MANAGED_PROVIDER, id: 'managed:openai-codex' };
    const codexMethod = (extra: Record<string, unknown> = {}) => ({
      id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses',
      signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' },
      quota: { state: 'unknown' }, ...extra,
    });
    const panel = () => document.querySelector<HTMLElement>('[data-original-source="openai-codex"]')!;

    it.each(['completed', 'pending'] as const)('invalidates a %s probe when the client changes', async (status) => {
      const method = codexMethod() as OAuthMethodStatus;
      const onChanged = vi.fn();
      const found = {
        provider: 'openai-codex', home_dir: '/server-a/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'known', id: 'account-a@example.test' }, can_connect: true,
      };
      let release!: (value: unknown) => void;
      if (status === 'pending') {
        probeOriginalOAuth.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      } else {
        probeOriginalOAuth.mockResolvedValueOnce(found);
      }
      const { rerender } = await renderSurface(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });

      const probeB = vi.fn(async () => ({ ...found, home_dir: '/server-b/.codex', account: { state: 'known', id: 'account-b@example.test' } }));
      const connectB = vi.fn(async () => ({ ...found, account: { state: 'known', id: 'account-b@example.test' } }));
      connectionClientOverride.current = { probeOriginalOAuth: probeB, connectOriginalOAuth: connectB };
      await rerender(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      if (status === 'pending') await act(async () => { release(found); });

      expect(panel().querySelector('[data-original-source-result]')).toBeNull();
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();
      expect(panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.disabled).toBe(false);
      expect(connectB).not.toHaveBeenCalled();
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      expect(panel().textContent).toContain('account-b@example.test');
      expect(panel().textContent).not.toContain('account-a@example.test');
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      expect(connectB).toHaveBeenCalledWith({ provider: 'openai-codex', expected_account_id: 'account-b@example.test' });
      expect(connectOriginalOAuth).not.toHaveBeenCalled();
    });

    it.each(['success', 'error'] as const)('ignores server A’s late %s after server B has answered', async (outcome) => {
      const method = codexMethod() as OAuthMethodStatus;
      const onChanged = vi.fn();
      let release!: (value: unknown) => void;
      let reject!: (reason: Error) => void;
      probeOriginalOAuth.mockImplementationOnce(() => new Promise((resolve, fail) => { release = resolve; reject = fail; }));
      const { rerender } = await renderSurface(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      const foundB = {
        provider: 'openai-codex', home_dir: '/server-b/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'known', id: 'account-b@example.test' }, can_connect: true,
      };
      const connectB = vi.fn(async () => foundB);
      connectionClientOverride.current = { probeOriginalOAuth: vi.fn(async () => foundB), connectOriginalOAuth: connectB };
      await rerender(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      expect(panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.disabled).toBe(false);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => {
        if (outcome === 'success') release({ ...foundB, account: { state: 'known', id: 'account-a@example.test' } });
        else reject(new Error('server A cannot read its sign-in'));
      });
      expect(panel().textContent).toContain('account-b@example.test');
      expect(panel().textContent).not.toContain('account-a@example.test');
      expect(panel().textContent).not.toContain('server A cannot read its sign-in');
      expect(panel().querySelector('[data-original-source-connect]')).not.toBeNull();
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      expect(connectB).toHaveBeenCalledWith({ provider: 'openai-codex', expected_account_id: 'account-b@example.test' });
    });

    it('invalidates a pending probe when the connection scope changes with the same client', async () => {
      const method = codexMethod() as OAuthMethodStatus;
      const onChanged = vi.fn();
      let release!: (value: unknown) => void;
      probeOriginalOAuth.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const { rerender } = await renderSurface(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      connectionClientOverride.scopeId = 'scope-b';
      await rerender(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      await act(async () => { release({
        provider: 'openai-codex', home_dir: '/server/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'known', id: 'scope-a@example.test' }, can_connect: true,
      }); });
      expect(panel().querySelector('[data-original-source-result]')).toBeNull();
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();
      expect(panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.disabled).toBe(false);
      expect(connectOriginalOAuth).not.toHaveBeenCalled();
    });

    it('invalidates a pending probe when the account method changes', async () => {
      const method = codexMethod() as OAuthMethodStatus;
      const onChanged = vi.fn();
      let release!: (value: unknown) => void;
      probeOriginalOAuth.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const { container, rerender } = await renderSurface(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await rerender(<AccountConnectionPanel method={{ ...method, id: 'grok-build', provider: 'managed:grok-build' }} onChanged={onChanged} />);
      await act(async () => { release({
        provider: 'openai-codex', home_dir: '/server/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'known', id: 'codex@example.test' }, can_connect: true,
      }); });
      const source = container.querySelector('[data-original-source="grok-build"]')!;
      expect(source.querySelector('[data-original-source-result]')).toBeNull();
      expect(source.querySelector('[data-original-source-connect]')).toBeNull();
      expect(source.querySelector<HTMLButtonElement>('[data-original-source-probe]')!.disabled).toBe(false);
      expect(connectOriginalOAuth).not.toHaveBeenCalled();
    });

    it.each(['openai-codex', 'grok-build'] as const)('recovers %s in the attached custom home, not the default home', async (id) => {
      const homeDir = `/srv/custom/${id}`;
      const method = {
        ...codexMethod(), id, provider: `managed:${id}`, connection_state: 'reconnect_required',
        auth_source: { kind: 'local_original', home_dir: homeDir, storage_backend: 'file', source_state: 'account_changed' },
      } as OAuthMethodStatus;
      const ready = {
        provider: id, home_dir: homeDir, storage_backend: 'file', state: 'ready',
        account: { state: 'known', id: 'replacement@example.test' }, can_connect: true,
      };
      probeOriginalOAuth.mockResolvedValue(ready);
      connectOriginalOAuth.mockResolvedValue(ready);
      const onChanged = vi.fn();
      const { container, rerender } = await renderSurface(<AccountConnectionPanel
        method={{ ...method, connection_state: 'ready', auth_source: { kind: 'local_original', home_dir: homeDir, storage_backend: 'file', source_state: 'ready' } }}
        onChanged={onChanged}
      />);
      expect(container.querySelector('[data-original-source-probe]')).toBeNull();
      await rerender(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      const source = container.querySelector<HTMLElement>(`[data-original-source="${id}"]`)!;
      await act(async () => { source.querySelector<HTMLButtonElement>('[data-original-source-advanced]')!.click(); });
      expect(source.querySelector<HTMLInputElement>('[data-original-source-home-dir]')!.value).toBe(homeDir);
      await act(async () => { source.querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      expect(probeOriginalOAuth).toHaveBeenCalledWith({ provider: id, home_dir: homeDir });
      expect(probeOriginalOAuth).not.toHaveBeenCalledWith({ provider: id });
      expect(source.querySelector<HTMLElement>('[data-original-source-result]')!.dataset['originalSourceResult']).toBe('connectable');
      await act(async () => { source.querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      expect(connectOriginalOAuth).toHaveBeenCalledWith({ provider: id, home_dir: homeDir, expected_account_id: 'replacement@example.test' });
      expect(onChanged).toHaveBeenCalledOnce();
    });

    it('reads the machine before offering to attach, and names the account it found', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });

      // Nothing is offered before the machine has been read: attaching to an
      // account nobody has seen is not a decision someone can make.
      expect(panel().querySelector('[data-original-source-result]')).toBeNull();
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();

      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      expect(panel().querySelector<HTMLElement>('[data-original-source-result]')!.dataset['originalSourceResult']).toBe('connectable');
      expect(panel().textContent).toContain('dev@example.test');
      // A credential in a plain file is a fact about this machine worth saying.
      expect(panel().textContent).toContain('a file on disk');
      // The provider here is the method id, never the managed: provider id.
      expect(probeOriginalOAuth).toHaveBeenCalledWith({ provider: 'openai-codex' });
    });

    it('connects carrying the account it just showed, then re-reads the list', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      // expected_account_id is what stops a credential replaced in the
      // meantime from being adopted silently.
      expect(connectOriginalOAuth).toHaveBeenCalledWith({ provider: 'openai-codex', expected_account_id: 'dev@example.test' });
      // The method list is the authority on what is connected, so it is re-read.
      expect(listOAuthMethods.mock.calls.length).toBeGreaterThan(1);
    });

    it('connects a Kimi Code slot that has no account id, and sends no invented one', async () => {
      const method = {
        id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai',
        signed_in: true, connection_state: 'ready', account: { state: 'unknown' },
        quota: { state: 'unknown' },
      } as OAuthMethodStatus;
      const found = {
        provider: 'kimi-code', home_dir: '/server/.kimi-code', storage_backend: 'keyring',
        state: 'ready', account: { state: 'unknown' }, can_connect: true,
      };
      probeOriginalOAuth.mockResolvedValue(found);
      connectOriginalOAuth.mockResolvedValue(found);
      const onChanged = vi.fn();
      await renderSurface(<AccountConnectionPanel method={method} onChanged={onChanged} />);
      const source = document.querySelector<HTMLElement>('[data-original-source="kimi-code"]')!;
      await act(async () => { source.querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });

      // Kimi Code keeps a credential slot, not an account: the panel says what
      // was found without naming an account, and connect is still offered.
      expect(source.querySelector<HTMLElement>('[data-original-source-result]')!.dataset['originalSourceResult']).toBe('connectable');
      expect(source.textContent).toContain('Found the sign-in Kimi Code already has on this machine.');
      await act(async () => { source.querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      const request = connectOriginalOAuth.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(request).toMatchObject({ provider: 'kimi-code' });
      expect(request['expected_account_id']).toBeUndefined();
      expect(onChanged).toHaveBeenCalled();
    });

    it('still refuses a Codex connect whose probe found no account identity', async () => {
      const method = codexMethod() as OAuthMethodStatus;
      probeOriginalOAuth.mockResolvedValue({
        provider: 'openai-codex', home_dir: '/server/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'unknown' }, can_connect: true,
      });
      await renderSurface(<AccountConnectionPanel method={method} onChanged={vi.fn()} />);
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-connect]')!.click(); });
      expect(connectOriginalOAuth).not.toHaveBeenCalled();
    });

    it('refuses a stale check rather than connecting to what the machine no longer has', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(panel().querySelector('[data-original-source-connect]')).not.toBeNull();

      // Pointing the search at a different directory is a different question,
      // so the previous answer stops being offered as the thing to connect to.
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-advanced]')!.click(); });
      const input = panel().querySelector<HTMLInputElement>('[data-original-source-home-dir]')!;
      await act(async () => { setInputValue(input, '/srv/agent-home/.codex'); });

      expect(panel().querySelector('[data-original-source-result]')).toBeNull();
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();
      expect(connectOriginalOAuth).not.toHaveBeenCalled();
    });

    it('discards a check that answers a directory the person has already left', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      // The machine takes its time. The probe is asked about one directory and
      // the person moves back to the default before the answer lands — so the
      // answer is about a folder that is no longer on screen.
      let release: ((value: unknown) => void) | null = null;
      probeOriginalOAuth.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-advanced]')!.click(); });
      const input = panel().querySelector<HTMLInputElement>('[data-original-source-home-dir]')!;
      await act(async () => { setInputValue(input, '/srv/agent-home/.codex'); });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });

      // Back to the default before the answer arrives.
      await act(async () => { setInputValue(input, ''); });
      await act(async () => { release!({
        provider: 'openai-codex', home_dir: '/srv/agent-home/.codex', storage_backend: 'file',
        state: 'ready', account: { state: 'known', id: 'other@example.test' }, can_connect: true,
      }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      // An answer about a directory nobody is looking at is not an answer about
      // this screen, and it must not become something to connect to.
      expect(panel().querySelector('[data-original-source-result]')).toBeNull();
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();
    });

    it('sends a pointed-at directory on the next check', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-advanced]')!.click(); });
      const input = panel().querySelector<HTMLInputElement>('[data-original-source-home-dir]')!;
      await act(async () => { setInputValue(input, '/srv/agent-home/.codex'); });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      expect(probeOriginalOAuth).toHaveBeenCalledWith({ provider: 'openai-codex', home_dir: '/srv/agent-home/.codex' });
    });

    it('explains a machine whose sign-in was replaced, and attaches nothing', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      probeOriginalOAuth.mockResolvedValue({
        provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'keyring',
        state: 'account_changed', account: { state: 'known', id: 'other@example.test' },
        can_connect: false, reason: 'account changed on disk',
      });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      // The reason a person can act on, not the server's wording of it.
      expect(panel().querySelector<HTMLElement>('[data-original-source-result]')!.dataset['originalSourceResult']).toBe('accountChanged');
      expect(panel().textContent).toContain('now a different account');
      expect(panel().textContent).not.toContain('account changed on disk');
      expect(panel().querySelector('[data-original-source-connect]')).toBeNull();
    });

    it('treats a due renewal as usable rather than as a problem', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      probeOriginalOAuth.mockResolvedValue({
        provider: 'openai-codex', home_dir: '/home/dev/.codex', storage_backend: 'encrypted',
        state: 'refresh_required', account: { state: 'known', id: 'dev@example.test' }, can_connect: true,
      });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-probe]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      expect(panel().querySelector<HTMLElement>('[data-original-source-result]')!.dataset['originalSourceResult']).toBe('connectable');
      expect(panel().textContent).toContain('an encrypted store');
      expect(panel().textContent).toContain('Kiki renews it when it runs out');
      expect(panel().querySelector('[data-original-source-connect]')).not.toBeNull();
    });

    it('does not promise a renewal the machine cannot back, and keeps the way back', async () => {
      // Attached, but the credential on the machine has been replaced. The
      // server maps that to a sign-in that must be redone, so the row says so;
      // this panel must not contradict it by promising a renewal.
      listOAuthMethods.mockResolvedValue([codexMethod({
        connection_state: 'reconnect_required',
        auth_source: {
          kind: 'local_original', home_dir: '/home/dev/.codex', storage_backend: 'file', source_state: 'account_changed',
        },
      })]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });

      // The row owns the state, in sign-in words.
      expect(row.querySelector('summary')!.textContent).toContain('Sign-in expired');
      // The panel says what is actually wrong, in the same vocabulary a check uses.
      expect(panel().querySelector<HTMLElement>('[data-original-source-unusable]')!.dataset['originalSourceUnusable']).toBe('accountChanged');
      expect(panel().textContent).toContain('now a different account');
      // And it does not claim a working credential that Kiki will renew.
      expect(panel().textContent).not.toContain('Kiki renews it when it runs out');
      expect(panel().textContent).not.toContain('This connection now uses the sign-in already on this machine');
      // The description of what reuse is is also a claim about this credential,
      // so it is written as a capability rather than a statement of fact.
      expect(panel().textContent).toContain('Kiki can use the sign-in Codex has on this machine');
      expect(panel().textContent).not.toContain('Kiki uses the sign-in Codex already has on this machine');
      // Replacing a spent credential is done by checking the machine, so the
      // check stays available beside the way to let go of it.
      expect(panel().querySelector('[data-original-source-probe]')).not.toBeNull();
      expect(panel().querySelector('[data-original-source-detach]')).not.toBeNull();
    });

    it('lets go of the machine’s sign-in without claiming the other app was signed out', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod({
        auth_source: { kind: 'local_original', home_dir: '/home/dev/.codex', storage_backend: 'file', source_state: 'ready' },
      })]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });

      expect(panel().querySelector<HTMLElement>('[data-original-source-state]')!.dataset['originalSourceState']).toBe('ready');
      // The consequence is on screen before the button, because the mistake this
      // prevents is pressing it while expecting to sign out the other app.
      // What will happen, not what has: this connection is still attached, and
      // "Kiki no longer uses that sign-in" would be false until the button is
      // pressed.
      expect(panel().textContent).toContain('Kiki will stop using that sign-in');
      expect(panel().textContent).toContain('Codex is unaffected');
      expect(panel().textContent).not.toContain('Kiki no longer uses that sign-in');
      // One action, one button. A generic "Sign out" beside "Stop using it"
      // would be the same action twice — the mistake this page used to make
      // with two lists — and nothing offers to attach what is already attached.
      expect(panel().querySelectorAll('[data-original-source-detach]')).toHaveLength(1);
      expect(row.querySelector('[data-connection-sign-out]')).toBeNull();
      expect(panel().querySelector('[data-original-source-probe]')).toBeNull();
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-detach]')!.click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

      expect(logoutOAuth).toHaveBeenCalledWith({ provider: 'openai-codex' });
      expect(listOAuthMethods.mock.calls.length).toBeGreaterThan(1);
    });

    it('hints each app’s own directory rather than another app’s', async () => {
      listOAuthMethods.mockResolvedValue([codexMethod()]);
      listProviders.mockResolvedValue({ items: [CODEX_ROW] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:openai-codex"]')!;
      await act(async () => { row.open = true; });
      await act(async () => { panel().querySelector<HTMLButtonElement>('[data-original-source-advanced]')!.click(); });

      // Codex's row hints at Codex's directory. A hint naming another vendor's
      // path sends someone to a folder that is not there.
      expect(panel().querySelector<HTMLInputElement>('[data-original-source-home-dir]')!.placeholder).toBe('~/.codex');
    });

    it('offers no reuse for a method whose machine sign-in is not a thing', async () => {
      listOAuthMethods.mockResolvedValue([{
        id: 'octo', label: 'Octo', provider: 'managed:octo', protocol: 'openai',
        signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'dev@example.test' },
        quota: { state: 'unknown' },
      }]);
      listProviders.mockResolvedValue({ items: [{ ...MANAGED_PROVIDER, id: 'managed:octo' }] });
      const { container } = await renderSurface(<ConnectionsTab />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = container.querySelector<HTMLDetailsElement>('[data-connection-row="managed:octo"]')!;
      await act(async () => { row.open = true; });

      expect(document.querySelector('[data-original-source]')).toBeNull();
      expect(probeOriginalOAuth).not.toHaveBeenCalled();
    });
  });

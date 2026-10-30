// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ProvidersSection } from './ProvidersSection';
import { resetListPrefsCache } from './list';

const listProviders = vi.fn();
const listModels = vi.fn();
const listOAuthMethods = vi.fn();
const listDiscoveredModels = vi.fn();
const getConfig = vi.fn();
const listExecutors = vi.fn();
const getCatalogProvider = vi.fn();
const getProviderEntity = vi.fn();
const getModel = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listProviders,
      listModels,
      listOAuthMethods,
      listDiscoveredModels,
      getConfig,
      listExecutors,
      getCatalogProvider,
      getProviderEntity,
      getModel,
    },
  }),
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  resetListPrefsCache();
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  listProviders.mockReset().mockResolvedValue({
    items: [
      { id: 'openai-api', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1' },
    ],
  });
  listModels.mockReset().mockResolvedValue({
    items: [
      { id: 'gpt-4o', provider_id: 'openai-api', model: 'gpt-4o' },
    ],
  });
  listOAuthMethods.mockReset().mockResolvedValue([
    {
      id: 'kimi',
      provider: 'kimi',
      label: 'Kimi Code',
      signed_in: true,
      connection_state: 'connected',
      account: { state: 'known', id: 'user@example.test' },
    },
  ]);
  getConfig.mockReset().mockResolvedValue({
    agent_executors: [],
    agent_executor_display: { externals_visible: true },
  });
  listExecutors.mockReset().mockResolvedValue([]);
  getCatalogProvider.mockReset().mockResolvedValue({ id: 'openai-api', models: [] });
  getProviderEntity.mockReset().mockResolvedValue({
    id: 'openai-api',
    type: 'openai',
    has_api_key: true,
    status: 'connected',
    revision: 'rev-1',
    custom_header_keys: [],
    env_keys: [],
  });
  getModel.mockReset().mockResolvedValue({ model: 'gpt-4o' });
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
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <ProvidersSection />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('ProvidersSection zone order and status', () => {
  it('renders the zones in order: API, OAuth, Local harnesses, then decision services', async () => {
    const container = await render();
    const zones = [...container.querySelectorAll('[data-providers-zone]')];
    expect(zones.map((zone) => zone.getAttribute('data-providers-zone')))
      .toEqual(['apikey', 'oauth', 'harnesses', 'decision']);
  });

  it('lists a decision service in its own card and not among chat connections', async () => {
    listProviders.mockResolvedValue({ items: [
      { id: 'openai-api', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1' },
      { id: 'typesafe', type: 'system_one', service: 'decision', status: 'connected', base_url: 'https://api.typesafe.ai/v1', default_model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY', has_api_key: false },
    ] });
    const container = await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-providers-zone="apikey"] [data-connection-row="typesafe"]')).toBeNull();
    expect(container.querySelector('[data-providers-zone="decision"] [data-decision-row="typesafe"]')).not.toBeNull();
  });

  it('renders cards for all three zones with correct ids and clean unnumbered titles in order', async () => {
    const container = await render();
    const providersCard = container.querySelector('#st-card-providers');
    const authCard = container.querySelector('#st-card-auth');
    const enginesCard = container.querySelector('#st-card-engines');
    expect(providersCard).not.toBeNull();
    expect(authCard).not.toBeNull();
    expect(enginesCard).not.toBeNull();
    expect(providersCard?.textContent).toContain('API services');
    expect(providersCard?.textContent).not.toMatch(/[①②③]/);
    expect(authCard?.textContent).toContain('Account sign-in (subscription)');
    expect(authCard?.textContent).not.toMatch(/[①②③]/);
    expect(enginesCard?.textContent).toContain('CLI engines on this machine');
    expect(enginesCard?.textContent).not.toContain('Local CLI harnesses');
    expect(enginesCard?.textContent).not.toMatch(/[①②③]/);
  });

  it('shows a failed model read on the providers card and retries it in place', async () => {
    listModels.mockRejectedValueOnce(new Error('fixture local read failed'));
    const container = await render();
    const card = container.querySelector('#st-card-providers')!;
    expect(card.textContent).toContain('fixture local read failed');
    const retry = [...card.querySelectorAll<HTMLButtonElement>('[data-providers-read-error] button')]
      .find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(card.textContent).not.toContain('fixture local read failed');
    expect(listModels).toHaveBeenCalledTimes(2);
  });
});

const API_PROVIDER = {
  id: 'openai-api', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1',
};
const ACCOUNT_PROVIDER = {
  id: 'copilot', type: 'openai', status: 'connected', base_url: 'https://api.githubcopilot.com',
};
const LOCAL_PROVIDER = {
  id: 'ollama', type: 'openai', status: 'connected', base_url: 'http://127.0.0.1:11434/v1',
};
const CONFIGURED_ACCOUNT = {
  id: 'github-copilot',
  provider: 'copilot',
  label: 'GitHub Copilot',
  signed_in: true,
  connection_state: 'ready',
  account: { state: 'known', id: 'octo@example.test' },
  quota: { state: 'unknown' },
};
const FRESH_ACCOUNT = {
  id: 'grok-build',
  provider: 'grok-build',
  label: 'Grok Build',
  signed_in: false,
  account: { state: 'unknown' },
  quota: { state: 'unknown' },
};

function zoneRows(container: ParentNode, zone: string): string[] {
  return [...container.querySelectorAll(`[data-providers-zone="${zone}"] [data-connection-row]`)]
    .map((row) => row.getAttribute('data-connection-row') ?? '');
}

function installMixedProviders() {
  listProviders.mockResolvedValue({ items: [LOCAL_PROVIDER, ACCOUNT_PROVIDER, API_PROVIDER] });
  listModels.mockResolvedValue({ items: [] });
  listOAuthMethods.mockResolvedValue([CONFIGURED_ACCOUNT, FRESH_ACCOUNT]);
}

async function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[data-list-search]');
  if (input === null) throw new Error('missing search');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ProvidersSection configured rows', () => {
  it('puts each configured provider in one zone and does not sign in a configured account again', async () => {
    installMixedProviders();
    const container = await render();
    // A local HTTP server is an API at a local address: it lists with the API
    // services, and the CLI-engine card holds no connection rows.
    expect(zoneRows(container, 'apikey')).toEqual(['openai-api', 'ollama']);
    expect(zoneRows(container, 'oauth')).toEqual(['copilot']);
    expect(zoneRows(container, 'harnesses')).toEqual([]);
    const rows = [...container.querySelectorAll('[data-connection-row]')];
    expect(rows.map((row) => row.getAttribute('data-connection-row'))).toEqual(['openai-api', 'ollama', 'copilot']);
    expect(new Set(rows.map((row) => row.getAttribute('data-connection-row'))).size).toBe(3);

    const account = container.querySelector<HTMLElement>('[data-providers-zone="oauth"] [data-connection-row="copilot"]');
    expect(account?.tagName).toBe('DETAILS');
    expect(account?.getAttribute('data-connection-kind')).toBe('account');
    expect(account?.querySelector('[data-connection-account-panel="github-copilot"]')).not.toBeNull();
    expect(account?.textContent).toContain('Models');
    expect(account?.textContent).toContain('Save provider');
    expect(container.querySelectorAll('[data-oauth-method="github-copilot"]')).toHaveLength(0);
    expect(container.querySelector('[data-providers-zone="oauth"] [data-oauth-method="grok-build"]')).not.toBeNull();
    expect(container.querySelector('[data-providers-zone="apikey"] [data-connection-row="copilot"]')).toBeNull();
    expect([...container.querySelectorAll('[data-list-filter]')].map((chip) => chip.getAttribute('data-list-filter')))
      .toEqual(['all', 'api', 'account', 'local', 'attention']);
    const search = container.querySelector('[data-list-search]');
    expect(search).not.toBeNull();
    expect(container.querySelector('[data-providers-zone="apikey"]')!.contains(search)).toBe(false);
  });

  it('searches across zones and a miss drops rows without dropping the sign-in catalog', async () => {
    installMixedProviders();
    const container = await render();
    await typeSearch(container, 'ollama');
    expect(zoneRows(container, 'apikey')).toEqual(['ollama']);
    expect(zoneRows(container, 'harnesses')).toEqual([]);
    expect(zoneRows(container, 'oauth')).toEqual([]);
    expect(container.querySelector('[data-list-empty="no-match"]')).toBeNull();

    await typeSearch(container, 'zzzz-no-match');
    expect(container.querySelectorAll('[data-connection-row]')).toHaveLength(0);
    expect(container.querySelector('[data-list-empty="no-match"]')).not.toBeNull();
    expect(container.querySelector('[data-oauth-method="grok-build"]')).not.toBeNull();

    await typeSearch(container, '');
    expect(zoneRows(container, 'apikey')).toEqual(['openai-api', 'ollama']);
    expect(zoneRows(container, 'oauth')).toEqual(['copilot']);
    expect(zoneRows(container, 'harnesses')).toEqual([]);
  });

  it('keeps every row when oauth methods resolve after providers, then moves the account', async () => {
    let resolveMethods: (value: unknown) => void = () => {};
    listProviders.mockResolvedValue({ items: [API_PROVIDER, ACCOUNT_PROVIDER, LOCAL_PROVIDER] });
    listModels.mockResolvedValue({ items: [] });
    listOAuthMethods.mockReturnValue(new Promise((resolve) => { resolveMethods = resolve; }));
    const container = await render();
    expect(container.querySelectorAll('[data-connection-row]')).toHaveLength(3);
    expect(zoneRows(container, 'apikey')).toEqual(['copilot', 'openai-api', 'ollama']);
    expect(zoneRows(container, 'oauth')).toEqual([]);
    expect(zoneRows(container, 'harnesses')).toEqual([]);

    await act(async () => { resolveMethods([CONFIGURED_ACCOUNT, FRESH_ACCOUNT]); });
    await expect.poll(() => ({
      api: zoneRows(container, 'apikey'),
      oauth: zoneRows(container, 'oauth'),
      local: zoneRows(container, 'harnesses'),
    })).toEqual({
      api: ['openai-api', 'ollama'],
      oauth: ['copilot'],
      local: [],
    });
    expect(container.querySelectorAll('[data-connection-row="copilot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-oauth-method="github-copilot"]')).toHaveLength(0);
  });

  it('keeps every row when providers resolve after oauth methods', async () => {
    let resolveProviders: (value: unknown) => void = () => {};
    listOAuthMethods.mockResolvedValue([CONFIGURED_ACCOUNT, FRESH_ACCOUNT]);
    listModels.mockResolvedValue({ items: [] });
    listProviders.mockReturnValue(new Promise((resolve) => { resolveProviders = resolve; }));
    const container = await render();
    expect(container.querySelectorAll('[data-connection-row]')).toHaveLength(0);
    expect(container.querySelector('[data-oauth-method="github-copilot"]')).not.toBeNull();

    await act(async () => {
      resolveProviders({ items: [LOCAL_PROVIDER, API_PROVIDER, ACCOUNT_PROVIDER] });
    });
    await expect.poll(() => ({
      api: zoneRows(container, 'apikey'),
      oauth: zoneRows(container, 'oauth'),
      local: zoneRows(container, 'harnesses'),
    })).toEqual({
      api: ['openai-api', 'ollama'],
      oauth: ['copilot'],
      local: [],
    });
    expect(container.querySelectorAll('[data-connection-row]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-oauth-method="github-copilot"]')).toHaveLength(0);
    expect(container.querySelector('[data-oauth-method="grok-build"]')).not.toBeNull();
  });
});

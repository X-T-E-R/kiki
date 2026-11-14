// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AiSection } from './AiSection';
import { DefaultModelBar } from './DefaultModelBar';
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
const listCatalogProviders = vi.fn();
const listRecipes = vi.fn();
const getRequestGovernance = vi.fn();
const getMemoryAdvisorSettings = vi.fn();
const updateProvider = vi.fn();
const probeDecisionSource = vi.fn();

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
      listCatalogProviders,
      listRecipes,
      getRequestGovernance,
      getMemoryAdvisorSettings,
      updateProvider,
      probeDecisionSource,
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
  listCatalogProviders.mockReset().mockResolvedValue({ items: [] });
  listRecipes.mockReset().mockResolvedValue([]);
  getRequestGovernance.mockReset().mockResolvedValue({ revision: 'rev-1', rules: [], runtime: { inflight: [], queued: [] } });
  getMemoryAdvisorSettings.mockReset().mockResolvedValue({
    enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true,
    advisor: { mode: 'off' },
    advisor_status: { state: 'off', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 },
  });
  updateProvider.mockReset();
  probeDecisionSource.mockReset();
  listProviders.mockReset().mockResolvedValue({
    items: [
      { id: 'openai-api', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1', has_api_key: true },
    ],
  });
  listModels.mockReset().mockResolvedValue({
    items: [
      { id: 'gpt-4o', provider_id: 'openai-api', remote_id: 'gpt-4o', display_name: 'GPT-4o', max_context_size: 128000 },
    ],
  });
  listOAuthMethods.mockReset().mockResolvedValue([
    {
      id: 'kimi',
      provider: 'kimi',
      label: 'Kimi Code',
      signed_in: true,
      connection_state: 'ready',
      account: { state: 'known', id: 'user@example.test' },
      quota: { state: 'unknown' },
    },
  ]);
  getConfig.mockReset().mockResolvedValue({
    default_model: 'gpt-4o',
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
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', { language: 'en-US' });
});

afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(node: React.ReactElement = <ProvidersSection />, initialEntries: string[] = ['/settings/ai']): Promise<HTMLDivElement> {
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
          <MemoryRouter initialEntries={initialEntries}>
            {node}
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

function installPhoneTouchMatchMedia(): () => void {
  const prev = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('pointer: coarse') && query.includes('max-width: 639px'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return () => { window.matchMedia = prev; };
}

const API_PROVIDER = {
  id: 'openai-api', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1', has_api_key: true,
};
const MISSING_KEY_PROVIDER = {
  id: 'alt-api', type: 'openai', status: 'unconfigured', base_url: 'https://api.alt.example.test/v1', has_api_key: false,
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
const SEARCHABLE_FILLERS = Array.from({ length: 6 }, (_, index) => ({
  id: `search-fixture-${index + 1}`,
  type: 'openai',
  status: 'connected',
  base_url: `https://search-fixture-${index + 1}.example.test/v1`,
  has_api_key: true,
}));

function connectionRows(container: ParentNode): string[] {
  return [...container.querySelectorAll('[data-providers-zone="connections"] [data-connection-row]')]
    .map((row) => row.getAttribute('data-connection-row') ?? '');
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

describe('Models status card, attention, and tabs', () => {
  it('shows the status card first with default model and attention count, and all three tabs on AiSection', async () => {
    listProviders.mockResolvedValue({ items: [API_PROVIDER, MISSING_KEY_PROVIDER] });
    const container = await render(<AiSection />);

    const statusCard = container.querySelector('[data-ai-status-card]')!;
    expect(statusCard).not.toBeNull();
    expect(statusCard.textContent).toContain('New conversations use GPT-4o');
    expect(statusCard.textContent).toContain('2 connections, 1 needs attention');

    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['Connections', 'Defaults', 'Recipes']);

    // Fewer than 8 connections: no search, filter, or sort clutter.
    expect(container.querySelector('[data-list-search]')).toBeNull();
    expect(container.querySelector('[data-list-filter]')).toBeNull();
  });

  it('shows the empty status message and inline three-lane add card when nothing is connected', async () => {
    listProviders.mockResolvedValue({ items: [] });
    listModels.mockResolvedValue({ items: [] });
    getConfig.mockResolvedValue({ default_model: '', agent_executors: [] });
    const container = await render(<AiSection />);

    const statusCard = container.querySelector('[data-ai-status-card]')!;
    expect(statusCard.textContent).toContain('No model connected yet. Connect one so Kiki can answer.');
    expect(container.querySelector('[data-connections-empty]')).toBeNull();
    expect(container.querySelector('[data-first-run-card="lanes"]')).not.toBeNull();
  });

  it('surfaces a missing-key connection in Needs attention with Add key opening and focusing its key input', async () => {
    listProviders.mockResolvedValue({ items: [API_PROVIDER, MISSING_KEY_PROVIDER] });
    getProviderEntity.mockImplementation(async (id: string) => ({
      id,
      type: 'openai',
      has_api_key: id === 'openai-api',
      status: id === 'openai-api' ? 'connected' : 'unconfigured',
      revision: 'rev-1',
      custom_header_keys: [],
      env_keys: [],
    }));
    const container = await render(<ProvidersSection />);

    const attention = container.querySelector('[data-connections-attention]')!;
    expect(attention).not.toBeNull();
    expect(attention.textContent).toContain('Needs attention');
    expect(attention.textContent).toContain('alt-api');
    expect(attention.textContent).toContain('Needs a key');

    const addKeyButton = attention.querySelector<HTMLButtonElement>('[data-attention-row="alt-api"] [data-attention-fix]')!;
    expect(addKeyButton.textContent).toBe('Add key');
    expect(addKeyButton.className).not.toContain('text-accent-ink');

    await act(async () => { addKeyButton.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    const targetRow = container.querySelector<HTMLDetailsElement>('[data-connection-row="alt-api"]')!;
    expect(targetRow.open).toBe(true);
    const keyInput = targetRow.querySelector<HTMLInputElement>('[data-secret-field] input')!;
    expect(keyInput).not.toBeNull();
    expect(document.activeElement).toBe(keyInput);
  });

  it('renders every connection row with its visible status word on phone touch mode', async () => {
    const restoreMatchMedia = installPhoneTouchMatchMedia();
    try {
      listProviders.mockResolvedValue({ items: [API_PROVIDER, MISSING_KEY_PROVIDER] });
      const container = await render(<ProvidersSection />);

      const rows = [...container.querySelectorAll<HTMLElement>('[data-providers-zone="connections"] [data-connection-row]')];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const statusEl = row.querySelector<HTMLElement>('[data-connection-status]')!;
        expect(statusEl).not.toBeNull();
        expect(statusEl.querySelector('.sr-only')).toBeNull();
        expect(statusEl.querySelector('.hidden')).toBeNull();
      }
      const byId = new Map(rows.map((row) => [row.dataset['connectionRow'], row.querySelector('[data-connection-status]')!.textContent]));
      expect(byId.get('openai-api')).toContain('Connected');
      expect(byId.get('alt-api')).toContain('Needs a key');
    } finally {
      restoreMatchMedia();
    }
  });

  it('shows the Who decides and Concurrency cards on Defaults tab, and redirects legacy #st-card-decision-connections links', async () => {
    const container = await render(<AiSection />, ['/settings/ai?tab=defaults']);
    const judgesCard = container.querySelector('#st-card-decision-judges');
    expect(judgesCard).not.toBeNull();
    expect(judgesCard!.textContent).toContain('Who decides');
    const concurrencyCard = container.querySelector('#st-card-concurrency');
    expect(concurrencyCard).not.toBeNull();
    expect(concurrencyCard!.textContent).toContain('Concurrency limits');

    const legacy = await render(<AiSection />, ['/settings/ai?tab=providers#st-card-decision-connections']);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(legacy.querySelector('#st-card-decision-judges')).not.toBeNull();
  });

  it('shows SettingsLoadFailure with Retry when listOAuthMethods fails in the account lane', async () => {
    listProviders.mockResolvedValue({ items: [] });
    listOAuthMethods.mockRejectedValue(new Error('oauth backend offline'));
    const container = await render(<ProvidersSection />);

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-first-run-lane="account"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("Couldn't load the available sign-in methods: oauth backend offline");
    listOAuthMethods.mockResolvedValue([FRESH_ACCOUNT]);
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((btn) => btn.textContent === 'Retry')!;
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-oauth-method="grok-build"]')).not.toBeNull();
  });
});

describe('ProvidersSection unified connections list and folds', () => {
  it('renders unified connections list followed by Command-line agents without a buried decision fold', async () => {
    listProviders.mockResolvedValue({ items: [LOCAL_PROVIDER, ACCOUNT_PROVIDER, API_PROVIDER] });
    listModels.mockResolvedValue({ items: [] });
    listOAuthMethods.mockResolvedValue([CONFIGURED_ACCOUNT, FRESH_ACCOUNT]);
    const container = await render();

    const zones = [...container.querySelectorAll('[data-providers-zone]')].map((z) => z.getAttribute('data-providers-zone'));
    expect(zones).toEqual(['connections', 'harnesses']);
    expect(container.querySelector('[data-decision-fold]')).toBeNull();
    expect(container.querySelector('#st-card-auth')).toBeNull();
    expect(container.querySelectorAll('[data-oauth-method]')).toHaveLength(0);

    expect(connectionRows(container)).toEqual(['openai-api', 'copilot', 'ollama']);
    expect(container.querySelector('[data-engines-fold] summary')!.textContent)
      .toContain('Command-line agents (on the computer running Kiki)');

    // No external engines configured: the visibility switch does not show inside the engines fold.
    expect(container.querySelector('[data-external-engines-visibility]')).toBeNull();
  });

  it('lists a standalone decision service directly in Connections with a Decision badge and attaches capabilities on chat connections', async () => {
    const chatWithCap = {
      ...API_PROVIDER,
      decision_capabilities: { openai_decisions: { model: 'decisions-alpha' } },
    };
    listProviders.mockResolvedValue({ items: [
      chatWithCap,
      { id: 'typesafe', type: 'system_one', service: 'decision', status: 'connected', base_url: 'https://api.typesafe.ai/v1', default_model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY', has_api_key: true },
    ] });
    getProviderEntity.mockImplementation(async (id: string) => (id === 'typesafe'
      ? { id: 'typesafe', type: 'system_one', service: 'decision', status: 'connected', base_url: 'https://api.typesafe.ai/v1', default_model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY', has_api_key: true, revision: 'rev-1', custom_header_keys: [], env_keys: [] }
      : { ...chatWithCap, revision: 'rev-1', custom_header_keys: [], env_keys: [] }));
    probeDecisionSource.mockResolvedValue({ ok: true, duration_ms: 42, status: { state: 'ready' } });

    const container = await render(<ProvidersSection />, ['/settings/ai?tab=providers&decision=typesafe#st-card-providers']);
    expect(connectionRows(container)).toEqual(['openai-api', 'typesafe']);
    const decisionRow = container.querySelector<HTMLDetailsElement>('[data-connection-row="typesafe"]')!;
    expect(decisionRow.open).toBe(true);
    expect(decisionRow.querySelector('[data-decision-badge]')?.textContent).toBe('Decision');

    const chatRow = container.querySelector<HTMLDetailsElement>('[data-connection-row="openai-api"]')!;
    chatRow.open = true;
    const capPanel = chatRow.querySelector('[data-provider-decision-capabilities="openai-api"]')!;
    expect(capPanel).not.toBeNull();
    const modelInput = capPanel.querySelector<HTMLInputElement>('[data-decision-capability-model="openai_decisions"]')!;
    expect(modelInput.value).toBe('decisions-alpha');
    const testBtn = capPanel.querySelector<HTMLButtonElement>('[data-decision-capability-test="openai_decisions"]')!;
    await act(async () => { testBtn.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(probeDecisionSource).toHaveBeenCalledWith(
      { kind: 'connection', connection: 'openai-api', protocol: 'openai_decisions' },
      'openai-api@https://api.openai.com',
    );
    expect(capPanel.textContent).toContain('Answered in 42 ms.');
  });

  it('shows a failed connection list read with Retry and falls back to Default (unknown) on the status card when default model cannot resolve', async () => {
    listProviders.mockRejectedValueOnce(new Error('fixture connection list failed'));
    getConfig.mockResolvedValue({ default_model: '', agent_executors: [] });
    listModels.mockResolvedValue({ items: [] });
    const container = await render(
      <>
        <DefaultModelBar />
        <ProvidersSection />
      </>,
    );
    expect(container.querySelector('[data-ai-status-card]')!.textContent).toContain('Default (unknown)');
    const card = container.querySelector('#st-card-providers')!;
    expect(card.textContent).toContain("Couldn't load the connection list: fixture connection list failed");

    listProviders.mockResolvedValueOnce({ items: [API_PROVIDER] });
    const retry = [...card.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Retry')!;
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(connectionRows(container)).toEqual(['openai-api']);
  });

  it('searches across connections at >= 8 rows and finds by model display name', async () => {
    listProviders.mockResolvedValue({ items: [
      { id: 'acme', type: 'openai', status: 'connected', base_url: 'https://api.openai.com/v1', has_api_key: true },
      { id: 'other', type: 'openai', status: 'connected', base_url: 'https://other.example.test/v1', has_api_key: true },
      ...SEARCHABLE_FILLERS,
    ] });
    listModels.mockResolvedValue({ items: [
      { id: 'acme/zz-local', provider_id: 'acme', remote_id: 'zz-remote', display_name: 'Northwind Writer', max_context_size: 8000 },
      { id: 'other/plain', provider_id: 'other', remote_id: 'plain', display_name: 'Plain', max_context_size: 8000 },
    ] });
    const container = await render();
    await typeSearch(container, 'Northwind');
    expect(connectionRows(container)).toEqual(['acme']);
    await typeSearch(container, 'zzzz-no-match');
    expect(connectionRows(container)).toEqual([]);
    expect(container.querySelector('[data-list-empty="no-match"]')).not.toBeNull();
  });
});

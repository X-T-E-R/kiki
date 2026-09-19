// @vitest-environment jsdom

/**
 * NbSearchSection: readiness status from capabilities, narrow nb_search
 * replace-domain save, and the on-demand diagnostics check with cancel.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { SETTINGS_SEARCH_SPEC } from '@kiki/session-core/settings';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { NbSearchSection } from './NbSearchSection';
import { CARD_ID_TO_TAB, NB_SEARCH_TABS } from './nbSearch/types';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const getNbSearchCapabilities = vi.fn();
const testNbSearch = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, getNbSearchCapabilities, testNbSearch } }),
}));
vi.mock('../../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const CAPABILITIES: NbSearchCapabilities = {
  schema_version: '3.0',
  revision: 'config-fixture',
  providers: {
    descriptors: [
      { provider_id: 'exa', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: ['user_location'] },
      { provider_id: 'example', adapter_version: '1', query_operations: [{ operation_id: 'documents', output: { channel: 'typed', schema_id: 'example.documents@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
    ],
    instances: [
      {
        id: 'exa.default',
        provider_id: 'exa',
        enabled: true,
        availability: 'unavailable',
        issues: [{ code: 'CREDENTIAL_NOT_CONFIGURED' }, { code: 'LANE_NOT_CONFIGURED' }],
        credential: { requirement: 'required', configured: false, slot_id: 'exa.default' },
        endpoint: { requirement: 'optional', configured: false },
      },
      {
        id: 'direct-http.default',
        provider_id: 'direct-http',
        enabled: true,
        availability: 'ready',
        issues: [],
        credential: { requirement: 'none', configured: false },
        endpoint: { requirement: 'none', configured: false },
      },
    ],
  },
  search: {
    lanes: [
      { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync'], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'fast', cost: 'cheap' },
      { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'example.documents', output: { channel: 'typed', schema_id: 'example.documents@1' }, execution_modes: ['sync', 'async'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
    presets: [],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [{ kind: 'url', enabled: true, max_bytes: 2_097_152 }],
    chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
    pipelines: [
      { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'direct-http', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'jina-reader', role: 'reader' }], availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], latency: 'medium', cost: 'free' },
    ],
    limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 65_536 },
  },
  jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
let renderedQueryClient: QueryClient;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  getConfig.mockReset().mockResolvedValue({} as KikiConfigResponse);
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({ ...patch }));
  getNbSearchCapabilities.mockReset().mockResolvedValue(CAPABILITIES);
  testNbSearch.mockReset().mockResolvedValue({
    revision: 'config-fixture',
    search: { configured: true, available: true, selection: 'github.repositories', issues: [] },
    fetch: { configured: true, available: true, selection: 'direct.fetch -> jina.reader', issues: ['LANE_NOT_CONFIGURED'] },
  });
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

async function renderSection(initialEntry = '/settings/search'): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  renderedQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={renderedQueryClient}>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route path="/settings/search" element={<NbSearchSection />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('NbSearchSection status', () => {
  it('shows WebSearch fail-closed and FetchURL degraded from capabilities alone', async () => {
    const container = await renderSection();
    const status = container.querySelector('#st-card-search-status')!;
    expect(status.textContent).toContain('WebSearch');
    expect(status.textContent).toContain('Not configured');
    expect(status.textContent).toContain('refuses to run');
    // jina.reader is unavailable but the chain still runs: degraded, with the issue code surfaced.
    expect(status.textContent).toContain('Degraded');
    expect(status.textContent).toContain('LANE_NOT_CONFIGURED');
    // The status card never triggers the backend check on its own.
    expect(testNbSearch).not.toHaveBeenCalled();
  });

  it('lists lanes for the default-lane choice and providers with credential state', async () => {
    const container = await renderSection();
    const defaults = container.querySelector('#st-card-search-defaults')!;
    expect(defaults.textContent).toContain('exa.search');
    expect(defaults.textContent).toContain('results · nb-search.results@1');
    expect(defaults.textContent).toContain('github.repositories');
    expect(defaults.textContent).toContain('example.documents');
    expect(defaults.textContent).toContain('typed · example.documents@1');
    expect(defaults.textContent).toContain('No default (fail closed)');
    const providers = container.querySelector('#st-card-search-providers')!;
    expect(providers.textContent).toContain('exa.default');
    expect(providers.textContent).toContain('credential missing');
    expect(providers.querySelectorAll('textarea')).toHaveLength(1);
    expect(providers.textContent).toContain('user_location');
    // The env input holds a variable NAME only; no secret field exists.
    const envInput = providers.querySelector<HTMLInputElement>('input[placeholder="NB_SEARCH_EXA_API_KEY"]')!;
    expect(envInput.value).toBe('');
  });
});

describe('NbSearchSection save', () => {
  it('patches only nb_search and refetches capabilities after a lane choice and credential env edit', async () => {
    getNbSearchCapabilities
      .mockReset()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce({
        ...CAPABILITIES,
        revision: 'config-after-save',
        search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
      });
    const container = await renderSection();
    const defaults = container.querySelector('#st-card-search-defaults')!;
    const laneRadio = [...defaults.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('github.repositories'))!;
    await click(laneRadio);

    const providers = container.querySelector('#st-card-search-providers')!;
    const envInput = providers.querySelector<HTMLInputElement>('input[placeholder="NB_SEARCH_EXA_API_KEY"]')!;
    await setInputValue(envInput, 'TEAM_EXA_API_KEY');

    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    expect(saveButton.disabled).toBe(false);
    await click(saveButton);
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: {
        defaults: { search_lane: 'github.repositories' },
        credential_slots: { 'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      },
      replace_domains: ['nb_search'],
    });
    expect(getNbSearchCapabilities).toHaveBeenCalledTimes(2);
    expect(container.querySelector('#st-card-search-status')!.textContent).toContain('Ready');
  });

  it('keeps a dirty draft intact when capabilities refetch in the background', async () => {
    getNbSearchCapabilities
      .mockReset()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce({ ...CAPABILITIES, revision: 'background-refresh' });
    const container = await renderSection();
    const envInput = container.querySelector<HTMLInputElement>(
      '#st-card-search-providers input[placeholder="NB_SEARCH_EXA_API_KEY"]',
    )!;
    await setInputValue(envInput, 'UNSAVED_EXA_API_KEY');
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      await renderedQueryClient.invalidateQueries({ queryKey: ['nb-search-capabilities'] });
    });

    expect(getNbSearchCapabilities).toHaveBeenCalledTimes(2);
    expect(envInput.value).toBe('UNSAVED_EXA_API_KEY');
    expect(saveButton.disabled).toBe(false);
  });

  it('resets a custom fetch chain to runtime defaults while preserving a file sibling', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {
        defaults: {
          fetch_chain: [
            { input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader'] },
            { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
          ],
        },
      },
    } as KikiConfigResponse);
    const container = await renderSection();
    const fetchCard = container.querySelector('#st-card-search-fetch')!;
    const resetButton = [...fetchCard.querySelectorAll('button')]
      .find((button) => button.textContent === 'Use runtime default')!;
    await click(resetButton);
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: {
        defaults: {
          fetch_chain: [
            { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
          ],
        },
      },
      replace_domains: ['nb_search'],
    });
    expect(fetchCard.textContent).toContain('Inheriting the runtime default chain');
  });

  it('preserves a non-instance credential slot id across read, edit, and save', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {
        provider_instances: {
          'exa.default': {
            provider_id: 'exa',
            enabled: true,
            credential_slot_id: 'team-search',
            options: {},
          },
        },
        credential_slots: {
          'team-search': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
        },
      },
    } as KikiConfigResponse);
    const container = await renderSection();
    const envInput = container.querySelector<HTMLInputElement>(
      '#st-card-search-providers input[placeholder="NB_SEARCH_EXA_API_KEY"]',
    )!;
    expect(envInput.value).toBe('TEAM_EXA_API_KEY');
    await setInputValue(envInput, 'ROTATED_EXA_API_KEY');
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    const patch = patchConfig.mock.calls[0]![0] as {
      nb_search: {
        provider_instances: Record<string, { credential_slot_id?: string }>;
        credential_slots: Record<string, { provider_id: string; env: string }>;
      };
    };
    expect(patch.nb_search.provider_instances['exa.default']!.credential_slot_id).toBe('team-search');
    expect(patch.nb_search.credential_slots).toEqual({
      'team-search': { provider_id: 'exa', env: 'ROTATED_EXA_API_KEY' },
    });
  });

  it('rejects a non-numeric execution field without patching', async () => {
    const container = await renderSection();
    const execution = container.querySelector('#st-card-search-execution')!;
    const concurrencyInput = [...execution.querySelectorAll('label')]
      .find((label) => label.textContent!.includes('Max concurrent provider calls'))!
      .querySelector('input')!;
    await setInputValue(concurrencyInput, 'two');
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();
    expect(patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('not a non-negative whole number');
  });
});

describe('NbSearchSection configuration source', () => {
  it('renders unknowns instead of guessing when the server reports no config_source', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: false },
    } as KikiConfigResponse);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    // CAPABILITIES carries no config_source: status reads unknown and the
    // effective-layers flow is not inferred from the draft toggle.
    expect(sourceCard.textContent).toContain('Status unavailable');
    expect(sourceCard.textContent).not.toContain('Effective source precedence');
    // Saved reuse=false must not read as an unsaved change.
    expect(sourceCard.textContent).not.toContain('takes effect after saving');
    const toggle = sourceCard.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(false);
    // The credentials hint only describes the reuse path; hidden while off.
    expect(sourceCard.textContent).not.toContain('does not read another shell');
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    expect(saveButton.disabled).toBe(true);

    // Toggling flags the draft against the saved baseline.
    await click(toggle);
    expect(sourceCard.textContent).toContain('takes effect after saving');
    expect(saveButton.disabled).toBe(false);
  });

  it('localizes known config_source issue codes and keeps unknown codes verbatim', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'unreadable',
        availability: 'unavailable',
        issues: ['LOCAL_CONFIG_UNREADABLE', 'FUTURE_BACKEND_CODE'],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Check the file and its access permissions');
    expect(sourceCard.textContent).not.toContain('LOCAL_CONFIG_UNREADABLE');
    expect(sourceCard.textContent).toContain('FUTURE_BACKEND_CODE');
    // Layers are rendered when the server reports them.
    expect(sourceCard.textContent).toContain('Effective source precedence');
    // The shared credentials hint copy shows while reuse is on.
    expect(sourceCard.textContent).toContain('does not read another shell');
    // The status card localizes the same known source codes (readiness folds
    // config_source issues when availability is unavailable) while keeping
    // unknown codes raw.
    const statusCard = container.querySelector('#st-card-search-status')!;
    expect(statusCard.textContent).toContain('Check the file and its access permissions');
    expect(statusCard.textContent).not.toContain('LOCAL_CONFIG_UNREADABLE');
    expect(statusCard.textContent).toContain('FUTURE_BACKEND_CODE');
  });

  it('shows the local credential file as not checked when the server did not report it', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present',
        availability: 'ready',
        issues: [],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Local credential file');
    // Missing field means "not checked", never a guessed "missing".
    expect(sourceCard.textContent).toContain('Not checked');
    expect(sourceCard.textContent).not.toContain('Server environment and local nb-search credentials');
  });

  it('renders loaded local credentials and the combined credential source', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present',
        local_credentials: 'present',
        credential_source: 'environment+local',
        availability: 'ready',
        issues: [],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Local credential file');
    expect(sourceCard.textContent).toContain('Loaded');
    expect(sourceCard.textContent).toContain('Server environment and local nb-search credentials');
  });

  it('renders ignored credentials and the environment-only source when reuse is off', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: false },
    } as KikiConfigResponse);
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: false,
        layers: ['defaults', 'environment', 'kiki'],
        local_config: 'ignored',
        local_credentials: 'ignored',
        credential_source: 'environment',
        availability: 'ready',
        issues: [],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    const credentialRow = [...sourceCard.querySelectorAll('div')]
      .find((div) => div.textContent?.startsWith('Local credential file'))!;
    expect(credentialRow.textContent).toContain('Skipped');
    expect(credentialRow.textContent).toContain('Server environment');
    expect(credentialRow.textContent).not.toContain('local nb-search credentials');
    // The local tier is gone from the effective layers.
    const layersText = [...sourceCard.querySelectorAll('span')]
      .filter((span) => /^\d+\./.test(span.textContent ?? ''))
      .map((span) => span.textContent);
    expect(layersText.join(' ')).not.toContain('Server nb-search configuration');
    // Saved reuse=false is the baseline: no draft-changed hint.
    expect(sourceCard.textContent).not.toContain('takes effect after saving');
  });

  it('renders a recovery hint when local credential permission checks time out', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present',
        local_credentials: 'unreadable',
        availability: 'unavailable',
        issues: ['LOCAL_CREDENTIALS_TIMEOUT'],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Local credential permission checks timed out');
    expect(sourceCard.textContent).toContain('Retry or turn local reuse off');
    expect(sourceCard.textContent).not.toContain('LOCAL_CREDENTIALS_TIMEOUT');
  });

  it('renders a rejected credential file with its recovery hint', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present',
        local_credentials: 'rejected',
        credential_source: 'environment+local',
        availability: 'ready',
        issues: ['LOCAL_CREDENTIAL_BINDING_MISMATCH'],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Binding or protection check failed');
    expect(sourceCard.textContent).toContain('no longer matches the saved credential binding');
    expect(sourceCard.textContent).not.toContain('LOCAL_CREDENTIAL_BINDING_MISMATCH');
  });
});

describe('NbSearchSection diagnostics', () => {
  it('runs the readiness check on demand and renders the result', async () => {
    const container = await renderSection();
    const diagnostics = container.querySelector('#st-card-search-diagnostics')!;
    const runButton = [...diagnostics.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run readiness check')!;
    await click(runButton);
    await flush();
    expect(testNbSearch).toHaveBeenCalledTimes(1);
    expect(diagnostics.textContent).toContain('config-fixture');
    expect(diagnostics.textContent).toContain('github.repositories');
  });

  it('shows the error when the check fails', async () => {
    testNbSearch.mockRejectedValueOnce(new Error('kap-server unreachable'));
    const container = await renderSection();
    const diagnostics = container.querySelector('#st-card-search-diagnostics')!;
    const runButton = [...diagnostics.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run readiness check')!;
    await click(runButton);
    await flush();
    expect(diagnostics.textContent).toContain('Readiness check failed');
    expect(diagnostics.textContent).toContain('kap-server unreachable');
  });
});

describe('NbSearchSection sub-pages and progressive disclosure', () => {
  it('navigates across sub-pages via tab clicks and keyboard arrows', async () => {
    const container = await renderSection();

    const overviewTab = container.querySelector('#nb-search-tab-overview')!;
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    const fetchTab = container.querySelector('#nb-search-tab-fetch')!;
    const providersTab = container.querySelector('#nb-search-tab-providers')!;
    const advancedTab = container.querySelector('#nb-search-tab-advanced')!;

    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    expect(searchTab.getAttribute('aria-selected')).toBe('false');

    // Panel visibility follows active tab
    const overviewPanel = container.querySelector('#nb-search-panel-overview')!;
    const searchPanel = container.querySelector('#nb-search-panel-search')!;
    expect(overviewPanel.className).not.toContain('hidden');
    expect(searchPanel.className).toContain('hidden');

    // Click to switch tab
    await click(searchTab);
    expect(searchTab.getAttribute('aria-selected')).toBe('true');
    expect(overviewTab.getAttribute('aria-selected')).toBe('false');
    expect(searchPanel.className).not.toContain('hidden');
    expect(overviewPanel.className).toContain('hidden');

    // Keyboard arrow right on searchTab
    await act(async () => {
      searchTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(fetchTab.getAttribute('aria-selected')).toBe('true');

    // Keyboard End jumps to last tab (advanced)
    await act(async () => {
      fetchTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(advancedTab.getAttribute('aria-selected')).toBe('true');

    // Keyboard Home jumps to first tab (overview)
    await act(async () => {
      advancedTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
  });

  it('prioritizes search lanes: default/pinned first, available sync second, others third, and supports pinning', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {
        defaults: { search_lane: 'github.repositories' },
      },
    } as KikiConfigResponse);
    const container = await renderSection();
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);

    const searchPanel = container.querySelector('#nb-search-panel-search')!;
    // Current default should be marked with badge
    expect(searchPanel.textContent).toContain('Current default');
    expect(searchPanel.textContent).toContain('github.repositories');

    // Pinning a lane
    const pinButtons = [...searchPanel.querySelectorAll('button')].filter((b) => b.textContent === '☆');
    expect(pinButtons.length).toBeGreaterThan(0);
    await click(pinButtons[0]!);
    expect(searchPanel.textContent).toContain('Pinned');

    // Filter lanes
    const searchInput = searchPanel.querySelector<HTMLInputElement>('input[type="search"]')!;
    await setInputValue(searchInput, 'example');
    expect(searchPanel.textContent).toContain('example.documents');
    expect(searchPanel.textContent).not.toContain('github.repositories');
  });

  it('toggles reuse local configuration and saves only nb_search_source', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: true },
    } as KikiConfigResponse);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    expect(sourceCard.textContent).toContain('Reuse server nb-search configuration');
    expect(sourceCard.textContent).toContain('Configuration host');
    expect(sourceCard.textContent).toContain('Connected Kiki server');

    // Toggle reuseLocalConfig
    const toggle = sourceCard.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    await click(toggle);
    expect(toggle.checked).toBe(false);

    // Save button should be enabled due to dirty draft
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    expect(saveButton.disabled).toBe(false);
    await click(saveButton);
    await flush();

    // Source-only save: no nb_search replace, no canonical form payload.
    expect(patchConfig).toHaveBeenCalledWith({
      nb_search_source: { reuse_local_config: false },
      replace_domains: ['nb_search_source'],
    });
  });

  it('keeps the saved nb_search domain untouched byte-for-byte on a source-only save', async () => {
    const savedConfig = {
      providers: {},
      nb_search: {
        defaults: { search_lane: 'github.repositories' },
        execution: { retry_count: 2, fetch: { max_redirects: 3 } },
        vendor_extension: { nested: { keep: ['a', 'b'] } },
      },
      nb_search_source: { reuse_local_config: true },
    } as unknown as KikiConfigResponse;
    getConfig.mockResolvedValueOnce(savedConfig);
    // Replace semantics: domains outside replace_domains survive as-is.
    patchConfig.mockImplementation(
      async (patch: Record<string, unknown>) => ({ ...savedConfig, ...patch }) as KikiConfigResponse,
    );
    const container = await renderSection();

    const toggle = container.querySelector<HTMLInputElement>(
      '#st-card-search-source input[type="checkbox"]',
    )!;
    await click(toggle);
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    const patch = patchConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('nb_search');
    // A follow-up nb_search edit must still start from the intact saved domain.
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);
    const laneRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('example.documents'))!;
    await click(laneRadio);
    await click(saveButton);
    await flush();
    const secondPatch = patchConfig.mock.calls[1]![0] as {
      nb_search: Record<string, unknown>;
      replace_domains: string[];
    };
    expect(secondPatch.replace_domains).toEqual(['nb_search']);
    expect(secondPatch.nb_search['vendor_extension']).toEqual({ nested: { keep: ['a', 'b'] } });
    expect(secondPatch.nb_search['execution']).toEqual({ retry_count: 2, fetch: { max_redirects: 3 } });
    expect(secondPatch.nb_search['defaults']).toEqual({ search_lane: 'example.documents' });
  });

  it('combines both replace domains when the toggle and nb_search fields change together', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: true },
    } as KikiConfigResponse);
    const container = await renderSection();

    const toggle = container.querySelector<HTMLInputElement>(
      '#st-card-search-source input[type="checkbox"]',
    )!;
    await click(toggle);
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);
    const laneRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('github.repositories'))!;
    await click(laneRadio);

    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: { defaults: { search_lane: 'github.repositories' } },
      nb_search_source: { reuse_local_config: false },
      replace_domains: ['nb_search', 'nb_search_source'],
    });
  });

  it('keeps the draft when a source-only save fails', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: true },
    } as KikiConfigResponse);
    patchConfig.mockRejectedValueOnce(new Error('config write rejected'));
    const container = await renderSection();

    const toggle = container.querySelector<HTMLInputElement>(
      '#st-card-search-source input[type="checkbox"]',
    )!;
    await click(toggle);
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    expect(container.textContent).toContain('config write rejected');
    // Draft preserved: toggle stays off, save stays enabled for a retry.
    expect(toggle.checked).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(container.querySelector('[data-dirty-indicator]')).not.toBeNull();
  });

  it('recovers from a broken local config by turning reuse off without touching nb_search', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
    } as KikiConfigResponse);
    getNbSearchCapabilities.mockReset().mockResolvedValue({
      ...CAPABILITIES,
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'invalid',
        availability: 'unavailable',
        issues: ['EFFECTIVE_CONFIG_INVALID'],
      },
    } as NbSearchCapabilities);
    const container = await renderSection();

    const sourceCard = container.querySelector('#st-card-search-source')!;
    // Localized recovery hint instead of a bare code.
    expect(sourceCard.textContent).toContain('turn reuse off to isolate the local file');
    expect(sourceCard.textContent).not.toContain('EFFECTIVE_CONFIG_INVALID');

    const toggle = sourceCard.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(toggle);
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search_source: { reuse_local_config: false },
      replace_domains: ['nb_search_source'],
    });
  });

  it('shows the error shell with retry when the post-save capabilities refresh fails', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {},
      nb_search_source: { reuse_local_config: true },
    } as KikiConfigResponse);
    getNbSearchCapabilities
      .mockReset()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce(new Error('capabilities endpoint down'))
      .mockResolvedValueOnce({
        ...CAPABILITIES,
        revision: 'config-after-retry',
        search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
      });
    const container = await renderSection();
    expect(container.querySelector('#st-card-search-source')).not.toBeNull();

    const toggle = container.querySelector<HTMLInputElement>(
      '#st-card-search-source input[type="checkbox"]',
    )!;
    await click(toggle);
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    await click(saveButton);
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search_source: { reuse_local_config: false },
      replace_domains: ['nb_search_source'],
    });
    // The stale pre-save capabilities must not pose as the new state: the
    // editor is gone, the error and a retry affordance are shown. The amber
    // note says the save itself landed and only the refresh failed.
    expect(container.querySelector('#st-card-search-source')).toBeNull();
    expect(container.textContent).toContain('Configuration saved, but status could not be refreshed');
    expect(container.textContent).toContain('capabilities endpoint down');
    expect(container.querySelector('#st-card-search-status')!.textContent).not.toContain('Ready');

    const retryButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retry')!;
    await click(retryButton);
    await flush();
    await flush();

    expect(container.querySelector('#st-card-search-source')).not.toBeNull();
    expect(container.querySelector('#st-card-search-status')!.textContent).toContain('Ready');
  });

  it('does not show the saved-status note when the initial capabilities load fails', async () => {
    getNbSearchCapabilities.mockReset().mockRejectedValue(new Error('server unreachable'));
    const container = await renderSection();

    // The initial-load failure renders only the raw error; the post-save note
    // is reserved for the save-then-refresh path.
    expect(container.textContent).toContain('server unreachable');
    expect(container.textContent).not.toContain('Configuration saved, but status could not be refreshed');
    expect(container.textContent).not.toContain('Retry');
  });

  it('filters providers by query and status pill on providers sub-page', async () => {
    const container = await renderSection();
    const providersTab = container.querySelector('#nb-search-tab-providers')!;
    await click(providersTab);

    const providersPanel = container.querySelector('#nb-search-panel-providers')!;
    expect(providersPanel.textContent).toContain('exa.default');
    expect(providersPanel.textContent).toContain('direct-http.default');

    // Filter by needs attention
    const attentionPill = [...providersPanel.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Needs attention'))!;
    await click(attentionPill);
    expect(providersPanel.textContent).toContain('exa.default');
    expect(providersPanel.textContent).not.toContain('direct-http.default');

    // Filter by text
    const searchInput = providersPanel.querySelector<HTMLInputElement>('input[type="search"]')!;
    await setInputValue(searchInput, 'direct');
    // direct is not in 'attention', so list is empty
    expect(providersPanel.textContent).toContain('No providers matching the filter');

    // Reset status pill to all
    const allPill = [...providersPanel.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('All'))!;
    await click(allPill);
    expect(providersPanel.textContent).toContain('direct-http.default');
  });

  it('supports discard edits in the sticky action bar', async () => {
    const container = await renderSection();
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);

    const laneRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('github.repositories'))!;
    await click(laneRadio);

    const discardButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Discard edits')!;
    expect(discardButton).toBeDefined();
    await click(discardButton);

    // After discard, default should be restored
    const noDefaultRadio = container.querySelector<HTMLInputElement>('input[type="radio"]')!;
    expect(noDefaultRadio.checked).toBe(true);
    expect(container.querySelector('button[disabled]')?.textContent).toContain('Save search & retrieval');
  });

  it('resolves tab-hash conflict by prioritizing the specific card hash anchor', async () => {
    // When URL has tab=overview but hash points to st-card-search-providers, providers tab wins
    const container = await renderSection('/settings/search?tab=overview#st-card-search-providers');
    const providersTab = container.querySelector('#nb-search-tab-providers')!;
    const overviewTab = container.querySelector('#nb-search-tab-overview')!;
    expect(providersTab.getAttribute('aria-selected')).toBe('true');
    expect(overviewTab.getAttribute('aria-selected')).toBe('false');

    const providersPanel = container.querySelector('#nb-search-panel-providers')!;
    expect(providersPanel.className).not.toContain('hidden');
  });

  it('retains dirty draft across sub-page tab switches without popping leave guard', async () => {
    const container = await renderSection('/settings/search?tab=search');

    // Make an edit on search lanes tab
    const laneRadio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('github.repositories'))!;
    await click(laneRadio);

    // Switch to fetch tab
    const fetchTab = container.querySelector('#nb-search-tab-fetch')!;
    await click(fetchTab);

    // Verify fetch panel is active and no leave dialog interrupted the tab switch
    expect(fetchTab.getAttribute('aria-selected')).toBe('true');
    const fetchPanel = container.querySelector('#nb-search-panel-fetch')!;
    expect(fetchPanel.className).not.toContain('hidden');

    // Switch back to search tab: draft edit is still preserved
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);
    const radioNow = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((radio) => radio.closest('label')!.textContent!.includes('github.repositories'))!;
    expect(radioNow.checked).toBe(true);

    // Save button remains enabled with unsaved indicator
    const saveButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save search & retrieval')!;
    expect(saveButton.disabled).toBe(false);
  });
});

/**
 * The settings search index (session-core) and this leaf's own anchor→tab map
 * declare the same target twice. A hit navigates with `?tab=`, so an indexed
 * card that carries no tab — or a tab this leaf does not mount it in — flashes
 * a panel the page keeps hidden.
 */
describe('search-leaf targets match the settings search index', () => {
  it('points every indexed search card at the tab this leaf mounts it in', async () => {
    const entries = SETTINGS_SEARCH_SPEC.filter((entry) => entry.section === 'search');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.tab, entry.cardId).toBe(CARD_ID_TO_TAB[entry.cardId]);
    }
    for (const tab of NB_SEARCH_TABS) {
      expect(entries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    // Rendering a hit's target must actually mount the card it flashes.
    for (const entry of entries) {
      const container = await renderSection(`/settings/search?tab=${entry.tab}`);
      const panel = container.querySelector(`#nb-search-panel-${entry.tab}`);
      expect(panel, entry.cardId).not.toBeNull();
      expect(panel!.className, entry.cardId).not.toContain('hidden');
      expect(panel!.querySelector(`#${entry.cardId}`), entry.cardId).not.toBeNull();
    }
  });
});

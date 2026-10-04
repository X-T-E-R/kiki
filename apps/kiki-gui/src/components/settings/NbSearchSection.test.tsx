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
import { SETTINGS_SEARCH_SPEC, searchTabForCard } from '@kiki/session-core/settings';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { NbSearchSection } from './NbSearchSection';
import { DirtyGuardContext, type DirtyGuardValue } from '../dirtyGuard';
import { CARD_ID_TO_TAB, NB_SEARCH_TABS } from './nbSearch/types';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const getNbSearchCapabilities = vi.fn();
const testNbSearch = vi.fn();
const readNbSearchCredential = vi.fn();
const writeNbSearchCredential = vi.fn();
const readNbSearchKeyUsage = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ scopeId: 'fixture-connection', client: { getConfig, patchConfig, getNbSearchCapabilities, testNbSearch, readNbSearchCredential, writeNbSearchCredential, readNbSearchKeyUsage } }),
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
      { provider_id: 'direct-http', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'fetch' }], activation: { credential: 'none', endpoint: 'none' }, option_keys: [] },
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

/**
 * The two server-side projections 386 added, for the tests that need what only
 * they can say: which instance really serves a lane, and the lower layer's fetch
 * order ("restore source order" has nothing to restore without it). Kept out of
 * the shared stub so every S1 test still describes a server that sends neither.
 */
const PROJECTED_CAPABILITIES: NbSearchCapabilities = {
  ...CAPABILITIES,
  /**
   * A projection names the instance behind every lane, and the save validates
   * those references — so the stub has to report the instances and descriptors
   * the projection points at, the way a real server does. A projection that
   * references something the server does not report makes every save fail.
   */
  providers: {
    descriptors: [
      ...CAPABILITIES.providers.descriptors.map((descriptor): typeof descriptor => descriptor.provider_id === 'exa'
        // A lane's operation has to exist on the provider the projection names,
        // and the save validates exactly that.
        ? {
            ...descriptor,
            query_operations: [{
              operation_id: 'search',
              output: { channel: 'results', schema_id: 'nb-search.results@1' },
              built_in_async: true,
            }],
          }
        : descriptor),
      { provider_id: 'github', adapter_version: '1', query_operations: [{ operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
      { provider_id: 'jina-reader', adapter_version: '1', query_operations: [], fetch_operations: [{ operation_id: 'reader' }], activation: { credential: 'none', endpoint: 'optional' }, option_keys: [] },
    ],
    instances: [
      ...CAPABILITIES.providers.instances,
      { id: 'github.default', provider_id: 'github', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: false, slot_id: 'github.default' }, endpoint: { requirement: 'none', configured: false } },
      { id: 'jina-reader.default', provider_id: 'jina-reader', enabled: true, availability: 'unavailable', issues: [{ code: 'LANE_NOT_CONFIGURED' }], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'example.default', provider_id: 'example', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
    ],
  },
  fetch: {
    ...CAPABILITIES.fetch,
    // A pipeline a saved file chain can legitimately name; the save checks that
    // every configured pipeline really exists.
    pipelines: [
      ...CAPABILITIES.fetch.pipelines,
      { id: 'direct.local', input_kinds: ['file'], media_types: ['text/plain'], representations: ['markdown'], execution_modes: ['sync'], egress: 'none', stages: [{ id: 'direct-local', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
  },
  configuration: {
    lanes: {
      'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
      'github.repositories': { provider_instance_id: 'github.default', operation_id: 'repositories', latency: 'fast', cost: 'free' },
      'example.documents': { provider_instance_id: 'example.default', operation_id: 'documents', latency: 'fast', cost: 'free' },
      'direct.fetch': { provider_instance_id: 'direct-http.default', operation_id: 'fetch', latency: 'fast', cost: 'free' },
      'jina.reader': { provider_instance_id: 'jina-reader.default', operation_id: 'reader', latency: 'medium', cost: 'free' },
    },
    presets: {},
    provider_instance_ids: ['exa.default', 'direct-http.default'],
    default_search_lane: 'exa.search',
    fetch_chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['jina.reader'] }],
    file_scopes: [],
  },
  inherited_configuration: {
    lanes: {
      'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
      'github.repositories': { provider_instance_id: 'github.default', operation_id: 'repositories', latency: 'fast', cost: 'free' },
      'example.documents': { provider_instance_id: 'example.default', operation_id: 'documents', latency: 'fast', cost: 'free' },
      'direct.fetch': { provider_instance_id: 'direct-http.default', operation_id: 'fetch', latency: 'fast', cost: 'free' },
      'jina.reader': { provider_instance_id: 'jina-reader.default', operation_id: 'reader', latency: 'medium', cost: 'free' },
    },
    presets: {},
    provider_instance_ids: ['exa.default', 'direct-http.default'],
    default_search_lane: 'exa.search',
    fetch_chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
    file_scopes: [],
  },
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
  readNbSearchCredential.mockReset().mockResolvedValue({ instance_id: 'exa.default', slot_id: 'exa.default', stored: false, active: false, source: 'none', version: 'none', binding_version: 'fixture-binding' });
  writeNbSearchCredential.mockReset().mockResolvedValue({ instance_id: 'exa.default', slot_id: 'exa.default', stored: true, active: true, source: 'managed', version: 'fixture-version', binding_version: 'fixture-binding' });
  readNbSearchKeyUsage.mockReset().mockResolvedValue({
    provider_instance_id: 'exa.default',
    provider_id: 'exa',
    balance_supported: false,
    keys: [{ key_index: 1, state: 'unknown' }, { key_index: 2, state: 'unknown' }],
  });
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

async function renderSection(
  initialEntry = '/settings/search',
  dirtyGuard: DirtyGuardValue | null = null,
): Promise<HTMLDivElement> {
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
          <DirtyGuardContext.Provider value={dirtyGuard}>
            <MemoryRouter initialEntries={[initialEntry]}>
              <Routes>
                <Route path="/settings/search" element={<NbSearchSection />} />
              </Routes>
            </MemoryRouter>
          </DirtyGuardContext.Provider>
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

/** The server already reporting a saved override for Exa: it appears in the list. */
const CONFIGURED_EXA = {
  providers: {},
  nb_search: {
    provider_instances: { 'exa.default': { provider_id: 'exa', enabled: true } },
  },
} as unknown as KikiConfigResponse;

/** The providers tab lists configured services; a row opens the editor. */
async function openServiceDetail(container: HTMLDivElement, instanceId: string): Promise<HTMLDivElement> {
  const tab = container.querySelector('#nb-search-tab-providers')!;
  await click(tab);
  const row = container.querySelector(`[data-nb-search-service-row="${instanceId}"]`);
  expect(row, `${instanceId} is not in the configured service list`).not.toBeNull();
  await click(row!);
  const detail = container.querySelector<HTMLDivElement>(`[data-nb-search-service="${instanceId}"]`);
  expect(detail, `${instanceId} editor did not open`).not.toBeNull();
  return detail!;
}

/** Opens the service directory from whichever entry point this state offers. */
async function openDirectory(container: HTMLDivElement): Promise<Element> {
  const providers = container.querySelector('#st-card-search-providers')!;
  const button = providers.querySelector('[data-nb-search-add-service], [data-nb-search-add-service-empty]')!;
  await click(button);
  return providers.querySelector('[data-nb-search-directory]')!;
}

/** The page-level commit button, shared by every tab. */
function saveButtonOf(container: HTMLDivElement): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Save search & retrieval')!;
}

const MANAGED_KEYS = {
  instance_id: 'exa.default',
  slot_id: 'exa.default',
  stored: true,
  active: true,
  source: 'managed',
  version: 'fixture-old',
  binding_version: 'fixture-binding',
};

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

  it('lists lanes for the default-lane choice, and shows the real inherited default', async () => {
    const container = await renderSection();
    const defaults = container.querySelector('#st-card-search-defaults')!;
    expect(defaults.textContent).toContain('exa.search');
    expect(defaults.textContent).toContain('results · nb-search.results@1');
    expect(defaults.textContent).toContain('github.repositories');
    expect(defaults.textContent).toContain('example.documents');
    expect(defaults.textContent).toContain('typed · example.documents@1');
    // No Kiki override: the row says so, instead of claiming search is off
    // while the engine may be serving an inherited default.
    expect(defaults.textContent).toContain('Use the current default');
    expect(defaults.textContent).toContain('No default search lane is set');
  });

  it('names the lane actually in use when the default is inherited', async () => {
    getNbSearchCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
    });
    const container = await renderSection('/settings/search?tab=search');
    const panel = container.querySelector('#nb-search-panel-search')!;
    // Nothing is overridden here, so the page has to report the engine's own lane.
    expect(panel.textContent).toContain('Use the current default');
    expect(panel.textContent).toContain('Using the default: github.repositories');
    expect(panel.querySelector('[data-nb-search-lane-inherited-badge]')).not.toBeNull();
  });

  it('shows an empty service list and the directory entry when nothing is configured', async () => {
    const container = await renderSection('/settings/search?tab=providers');
    const providers = container.querySelector('#st-card-search-providers')!;
    // Nothing configured is a normal state, not a page of open forms.
    expect(providers.textContent).toContain('No service configured');
    expect(providers.textContent).not.toContain('exa.default');
    expect(providers.querySelectorAll('textarea')).toHaveLength(0);
    // Exactly one way to add one: the empty state owns the accent action.
    expect(providers.querySelector('[data-nb-search-add-service-empty]')).not.toBeNull();
    expect(providers.querySelector('[data-nb-search-add-service]')).toBeNull();
  });

  it('lists a configured service as one compact row and opens its editor', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const container = await renderSection('/settings/search?tab=providers');
    const providers = container.querySelector('#st-card-search-providers')!;
    const rows = providers.querySelectorAll('[data-nb-search-service-row]');
    expect(rows).toHaveLength(1);
    // A human name leads; the instance id stays secondary.
    expect(rows[0]!.textContent).toContain('Exa');
    expect(rows[0]!.textContent).toContain('exa.default');
    expect(rows[0]!.querySelector('[data-nb-search-row-state]')!.getAttribute('data-nb-search-row-state')).toBe('needsKey');
    // One editor pane, for the service the user has — not one per instance.
    const editors = providers.querySelectorAll('[data-nb-search-service]');
    expect(editors).toHaveLength(1);
    expect(editors[0]!.getAttribute('data-nb-search-service')).toBe('exa.default');

    const detail = await openServiceDetail(container, 'exa.default');
    expect(detail.textContent).toContain('exa.default');
    expect(detail.querySelector('[data-nb-search-base-url]')).not.toBeNull();
    expect(detail.querySelector('[data-nb-search-credential-env]')).not.toBeNull();
  });

  it('adds a service from the searchable directory using its real instance id', async () => {
    const container = await renderSection('/settings/search?tab=providers');
    const providers = container.querySelector('#st-card-search-providers')!;
    const directory = await openDirectory(container);
    // Every instance the server reports is reachable by its own id — nothing is
    // guessed from a provider name.
    expect(directory.querySelector('[data-nb-search-directory-row="exa.default"]')).not.toBeNull();
    expect(directory.querySelector('[data-nb-search-directory-row="direct-http.default"]')).not.toBeNull();

    // Search narrows the directory.
    await setInputValue(directory.querySelector<HTMLInputElement>('input[type="search"]')!, 'direct-http');
    expect(directory.querySelector('[data-nb-search-directory-row="direct-http.default"]')).not.toBeNull();
    expect(directory.querySelector('[data-nb-search-directory-row="exa.default"]')).toBeNull();

    // Choosing it stages an override and opens the editor.
    await click(directory.querySelector('[data-nb-search-directory-row="direct-http.default"]')!);
    expect(providers.querySelector('[data-nb-search-service="direct-http.default"]')).not.toBeNull();
    expect(saveButtonOf(container).disabled).toBe(false);
  });

  it('reveals saved keys only on demand, then replaces and clears them', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    // Reading for display never returns a value; only an explicit reveal does.
    readNbSearchCredential.mockImplementation(async (_id: string, reveal: boolean) => (
      reveal ? { ...MANAGED_KEYS, value: 'key-one,key-two' } : MANAGED_KEYS
    ));

    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;

    // Nothing is fetched for display except the source.
    expect(keys.textContent).toContain('Saved in Kiki');
    expect(readNbSearchCredential).toHaveBeenCalledWith('exa.default', false);
    expect(keys.querySelector('[data-key-row]')).toBeNull();

    // Showing the keys is an explicit read, and a read alone is not an edit.
    await click(keys.querySelector('[data-key-show]')!);
    expect(readNbSearchCredential).toHaveBeenCalledWith('exa.default', true);
    expect(keys.querySelectorAll('[data-key-row]')).toHaveLength(2);
    expect(keys.querySelector('[data-keys-count]')!.textContent).toContain('2 of 32');
    expect(keys.textContent).not.toContain('key-one');
    expect(saveButtonOf(container).disabled).toBe(true);

    // Revealing one row shows that key only.
    await click(keys.querySelector('[data-key-reveal="0"]')!);
    expect(keys.querySelector('[data-key-row="0"]')!.textContent).toContain('key-one');
    expect(keys.querySelector('[data-key-row="1"]')!.textContent).not.toContain('key-two');

    // Replacing starts an edit; the page is now dirty.
    await click(keys.querySelector('[data-key-replace]')!);
    expect(saveButtonOf(container).disabled).toBe(false);
    await click(keys.querySelector('[data-key-remove="1"]')!);
    expect(keys.querySelectorAll('[data-key-row]')).toHaveLength(1);

    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'key-one', 'fixture-old', 'fixture-binding');

    // Clearing commits a null value through the same version-checked path.
    const cleared = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    await click(cleared.querySelector('[data-key-clear]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', null, 'fixture-old', 'fixture-binding');
  });

  it('shows a key stored in the environment and writes a Kiki key over it', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const envView = { instance_id: 'exa.default', slot_id: 'exa.default', stored: false, active: false, source: 'environment', env_name: 'NB_SEARCH_EXA_API_KEY', version: 'none', binding_version: 'fixture-binding' };
    readNbSearchCredential
      .mockResolvedValueOnce(envView)
      .mockResolvedValueOnce({ ...envView, value: 'fixture-env-value' })
      .mockResolvedValueOnce(envView);
    writeNbSearchCredential.mockResolvedValueOnce({ ...envView, stored: true, active: true, source: 'managed', version: 'fixture-new' });

    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    expect(keys.textContent).toContain('From environment variable NB_SEARCH_EXA_API_KEY');
    // A value the user did not save here cannot be cleared here.
    expect(keys.querySelector('[data-key-clear]')).toBeNull();

    await click(keys.querySelector('[data-key-show]')!);
    await click(keys.querySelector('[data-key-reveal="0"]')!);
    expect(keys.querySelector('[data-key-row="0"]')!.textContent).toContain('fixture-env-value');
    await click(keys.querySelector('[data-key-replace]')!);
    expect(saveButtonOf(container).disabled).toBe(false);

    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'fixture-env-value', 'none', 'fixture-binding');
  });

  it('keeps an unsaved key when the credential write fails, and reports which half landed', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const empty = { instance_id: 'exa.default', slot_id: 'exa.default', stored: false, active: false, source: 'none', version: 'none', binding_version: 'fixture-binding' };
    readNbSearchCredential.mockResolvedValue(empty);
    writeNbSearchCredential.mockRejectedValueOnce(new Error('credential store unreachable'));

    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    await setInputValue(keys.querySelector<HTMLInputElement>('[data-key-input]')!, 'fixture-typed-key');
    await click(keys.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();

    // The key write failed and says so; the typed key is still there to retry.
    expect(container.textContent).toContain('The settings were saved, but the key was not');
    expect(container.textContent).toContain('credential store unreachable');
    const after = container.querySelector('[data-nb-search-keys="exa.default"]')!;
    expect(after.textContent).toContain('fixture-typed-key');
    expect(saveButtonOf(container).disabled).toBe(false);
  });

  it('refuses to save a key list the server cannot hold, without dropping any key', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    readNbSearchCredential.mockResolvedValue({ instance_id: 'exa.default', slot_id: 'exa.default', stored: false, active: false, source: 'none', version: 'none', binding_version: 'fixture-binding' });

    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    const tooMany = Array.from({ length: 33 }, (_, index) => `key-${index}`).join(',');
    await setInputValue(keys.querySelector<HTMLInputElement>('[data-key-input]')!, tooMany);
    await click(keys.querySelector('[data-key-add]')!);

    // 33 keys are all kept: the user's credential is never silently truncated.
    expect(keys.querySelectorAll('[data-key-row]')).toHaveLength(33);
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).not.toHaveBeenCalled();
    expect(container.textContent).toContain('more than the 32 this server accepts');
    expect(container.textContent).toContain('Remove 1 before saving');

    // A duplicate blocks the save for the same reason. Free a slot first: the
    // add row disappears once the list is full, which is the honest ceiling.
    await click(keys.querySelector('[data-key-remove="32"]')!);
    await click(keys.querySelector('[data-key-remove="31"]')!);
    await setInputValue(keys.querySelector<HTMLInputElement>('[data-key-input]')!, 'key-0');
    await click(keys.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).not.toHaveBeenCalled();
    expect(container.textContent).toContain('The same key appears twice');
  });

  it('keeps key strategy and cache TTL through a save and read-back', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    patchConfig.mockImplementation(async (patch: Record<string, unknown>) => ({ ...patch }) as unknown as KikiConfigResponse);
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');

    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-balance-ttl]')!, '600000');
    const strategy = detail.querySelector('[data-nb-search-key-strategy]')!;
    await click(strategy.querySelector('button')!);
    await flush();
    const option = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Try them in order')!;
    await click(option);
    await click(saveButtonOf(container));
    await flush();

    const patch = patchConfig.mock.calls[0]![0] as {
      nb_search: { provider_instances: Record<string, { key_strategy?: string; balance_ttl_ms?: number; base_url?: string }> };
    };
    expect(patch.nb_search.provider_instances['exa.default']!.key_strategy).toBe('priority');
    expect(patch.nb_search.provider_instances['exa.default']!.balance_ttl_ms).toBe(600_000);
    expect(patch.nb_search.provider_instances['exa.default']!.base_url).toBeUndefined();
  });

  it('clearing the Base URL keeps saved key strategy and TTL', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {
        provider_instances: {
          'exa.default': {
            provider_id: 'exa',
            enabled: true,
            base_url: 'https://example.test/search',
            key_strategy: 'priority',
            balance_ttl_ms: 600_000,
            options: { user_location: 'fixture', hidden_vendor_flag: true },
          },
        },
      },
    } as unknown as KikiConfigResponse);
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-base-url]')!, '');
    await click(saveButtonOf(container));
    await flush();

    const patch = patchConfig.mock.calls[0]![0] as {
      nb_search: { provider_instances: Record<string, Record<string, unknown>> };
    };
    const saved = patch.nb_search.provider_instances['exa.default']!;
    expect(saved['base_url']).toBeUndefined();
    expect(saved['key_strategy']).toBe('priority');
    expect(saved['balance_ttl_ms']).toBe(600_000);
  });

  it('removes a service explicitly and leaves the other instances alone', async () => {
    getConfig.mockResolvedValueOnce({
      providers: {},
      nb_search: {
        provider_instances: {
          'exa.default': { provider_id: 'exa', enabled: true },
          'tavily.default': { provider_id: 'tavily', enabled: true },
        },
      },
    } as unknown as KikiConfigResponse);
    getNbSearchCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      providers: {
        ...CAPABILITIES.providers,
        descriptors: [
          ...CAPABILITIES.providers.descriptors,
          { provider_id: 'tavily', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'required', endpoint: 'none' }, option_keys: [] },
        ],
        instances: [
          ...CAPABILITIES.providers.instances,
          {
            id: 'tavily.default',
            provider_id: 'tavily',
            enabled: true,
            availability: 'ready' as const,
            issues: [],
            credential: { requirement: 'required' as const, configured: true, slot_id: 'tavily.default' },
            endpoint: { requirement: 'none' as const, configured: false },
          },
        ],
      },
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-nb-search-service-remove]')!);
    const confirm = document.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!;
    expect(confirm.textContent).toBe('Remove service');
    await click(confirm);
    await click(saveButtonOf(container));
    await flush();

    const patch = patchConfig.mock.calls[0]![0] as {
      nb_search: { provider_instances: Record<string, unknown> };
    };
    expect(patch.nb_search.provider_instances['exa.default']).toBeUndefined();
    expect(patch.nb_search.provider_instances['tavily.default']).toEqual({ provider_id: 'tavily', enabled: true });
  });
});

describe('NbSearchSection save', () => {
  it('patches only nb_search and refetches capabilities after a lane choice and credential env edit', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    getNbSearchCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      revision: 'config-after-save',
      search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
    });
    const container = await renderSection();
    const defaults = container.querySelector('#st-card-search-defaults')!;
    const laneRadio = defaults.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="github.repositories"] input[type="radio"]',
    )!;
    await click(laneRadio);

    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-credential-env]')!, 'TEAM_EXA_API_KEY');

    const saveButton = saveButtonOf(container);
    expect(saveButton.disabled).toBe(false);
    await click(saveButton);
    await flush();

    // The saved provider override rides along untouched; only the edited fields move.
    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: {
        provider_instances: { 'exa.default': { provider_id: 'exa', enabled: true } },
        defaults: { search_lane: 'github.repositories' },
        credential_slots: { 'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      },
      replace_domains: ['nb_search'],
    });
    expect(container.querySelector('#st-card-search-status')!.textContent).toContain('Ready');
  });

  it('keeps a dirty draft intact when capabilities refetch in the background', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const container = await renderSection();
    const detail = await openServiceDetail(container, 'exa.default');
    const envInput = detail.querySelector<HTMLInputElement>('[data-nb-search-credential-env]')!;
    await setInputValue(envInput, 'UNSAVED_EXA_API_KEY');
    const saveButton = saveButtonOf(container);
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      await renderedQueryClient.invalidateQueries({ queryKey: ['nb-search-capabilities'] });
    });

    expect(envInput.value).toBe('UNSAVED_EXA_API_KEY');
    expect(saveButton.disabled).toBe(false);
  });

  it('saves an address and a key together as one connection', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    readNbSearchCredential.mockResolvedValue({ instance_id: 'exa.default', slot_id: 'exa.default', stored: false, active: false, source: 'none', version: 'none', binding_version: 'fixture-binding' });
    const container = await renderSection();
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-base-url]')!, 'https://example.test/v1');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    await setInputValue(keys.querySelector<HTMLInputElement>('[data-key-input]')!, 'fixture-key');
    await click(keys.querySelector('[data-key-add]')!);

    // Editing the address must not lock the key field: they are one decision.
    expect(keys.querySelector('[data-key-input]')!.hasAttribute('disabled')).toBe(false);
    await click(saveButtonOf(container));
    await flush();

    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: {
        provider_instances: {
          'exa.default': {
            provider_id: 'exa',
            enabled: true,
            credential_slot_id: undefined,
            base_url: 'https://example.test/v1',
            key_strategy: undefined,
            balance_ttl_ms: undefined,
            options: undefined,
          },
        },
      },
      replace_domains: ['nb_search'],
    });
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'fixture-key', 'none', 'fixture-binding');
  });

  it('restores one fetch group to its source order and keeps the custom sibling', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue(PROJECTED_CAPABILITIES);
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
    const container = await renderSection('/settings/search?tab=fetch');
    const fetchCard = container.querySelector('#st-card-search-fetch')!;
    // The url → markdown group is the one on screen; its action takes the
    // source order for that group only.
    await click(fetchCard.querySelector('[data-nb-search-fetch-restore]')!);
    const saveButton = saveButtonOf(container);
    expect(saveButton.disabled, 'save must be enabled after a fetch-group change').toBe(false);
    await click(saveButton);
    await flush();
    expect(container.querySelector('[data-feedback-tone="error"]')?.textContent ?? null).toBeNull();

    // fetch_chain is one array, so the restored group is written with the
    // sibling group that is still custom — the file chain must survive.
    expect(patchConfig).toHaveBeenCalledWith({
      nb_search: {
        defaults: {
          fetch_chain: [
            { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
            { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
          ],
        },
      },
      replace_domains: ['nb_search'],
    });
  });

  it('restores every fetch group to inheritance instead of a snapshot', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue(PROJECTED_CAPABILITIES);
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
    const container = await renderSection('/settings/search?tab=fetch');
    const fetchCard = container.querySelector('#st-card-search-fetch')!;
    await click(fetchCard.querySelector('[data-nb-search-fetch-restore-all]')!);
    await click(saveButtonOf(container));
    await flush();

    // Only restoring every group drops the Kiki snapshot, which is the one
    // action that really goes back to the lower layer.
    const patch = patchConfig.mock.calls.at(-1)![0] as { nb_search: { defaults?: Record<string, unknown> } };
    expect(patch.nb_search.defaults?.['fetch_chain']).toBeUndefined();
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
    const detail = await openServiceDetail(container, 'exa.default');
    const envInput = detail.querySelector<HTMLInputElement>('[data-nb-search-credential-env]')!;
    expect(envInput.value).toBe('TEAM_EXA_API_KEY');
    await setInputValue(envInput, 'ROTATED_EXA_API_KEY');
    const saveButton = saveButtonOf(container);
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

  it('retains pending keys and their leave guard through a failed first capabilities refresh and retry', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    patchConfig.mockImplementation(async (patch: Record<string, unknown>) => ({ ...CONFIGURED_EXA, ...patch }));
    getNbSearchCapabilities
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce(new Error('first refresh unavailable'));
    const reported = new Map<string, boolean>();
    const container = await renderSection('/settings/search?tab=providers', {
      dirty: false,
      reportDirty: (id, dirty) => { reported.set(id, dirty); },
      navigate: vi.fn(),
    });
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-pending-key');
    await click(detail.querySelector('[data-key-add]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-base-url]')!, 'https://example.test/search');
    await click(saveButtonOf(container));
    await flush();

    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(writeNbSearchCredential).not.toHaveBeenCalled();
    expect(reported.get('nb-search-keys')).toBe(true);
    expect(container.textContent).toContain('One key you entered is still not stored');
    expect(container.querySelector('[data-search-action-bar]')).toBeNull();
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!);
    await flush();
    const recovered = await openServiceDetail(container, 'exa.default');
    await click(recovered.querySelector('[data-key-reveal="0"]')!);
    expect(recovered.textContent).toContain('example-pending-key');
    expect(saveButtonOf(container).disabled).toBe(false);
    await click(saveButtonOf(container));
    await flush();
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-pending-key', 'none', 'fixture-binding');
    expect(reported.get('nb-search-keys')).toBe(false);
  });

  it('marks post-key-write capabilities as stale on every tab and retries status without rewriting keys', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    getNbSearchCapabilities
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce(new Error('post-key refresh unavailable'));
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-saved-key');
    await click(detail.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();

    expect(writeNbSearchCredential).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-feedback-tone="info"]')?.textContent).toContain('state shown is the one from before the save');
    expect(container.querySelector('[data-feedback-tone="success"]')).toBeNull();
    const stale = container.querySelector('[data-nb-search-status-stale]');
    expect(stale).not.toBeNull();
    expect(stale!.closest('[role="tabpanel"]')).toBeNull();
    await click(container.querySelector('#nb-search-tab-overview')!);
    expect(container.querySelector('[data-nb-search-status-stale]')).not.toBeNull();
    expect(saveButtonOf(container).disabled).toBe(true);
    getNbSearchCapabilities.mockResolvedValueOnce({
      ...CAPABILITIES,
      revision: 'after-key-refresh-retry',
      search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
    });
    await click(stale!.querySelector('button')!);
    await flush();
    expect(container.querySelector('[data-nb-search-status-stale]')).toBeNull();
    expect(container.querySelector('#st-card-search-status')!.textContent).toContain('Ready');
    expect(writeNbSearchCredential).toHaveBeenCalledTimes(1);
  });

  it('rejects an edit observed at v1 after another client writes v2 instead of silently overwriting it', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const binding = 'c'.repeat(64);
    let stored = { value: 'example-original-key', version: 'a'.repeat(64) };
    readNbSearchCredential.mockImplementation(async (_id: string, reveal: boolean) => ({
      ...MANAGED_KEYS, version: stored.version, binding_version: binding, value: reveal ? stored.value : undefined,
    }));
    // Same compare-and-swap rule as fixture-server.mjs:1837, not a predetermined failure.
    writeNbSearchCredential.mockImplementation(async (_id: string, value: string, version: string, expectedBinding: string) => {
      if (version !== stored.version || expectedBinding !== binding) {
        throw Object.assign(new Error('Managed nb-search credential or binding changed; reload.'), { code: 40941 });
      }
      stored = { value, version: 'd'.repeat(64) };
      return { ...MANAGED_KEYS, version: stored.version, binding_version: binding };
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-key-show]')!);
    await click(detail.querySelector('[data-key-replace]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-user-input');
    await click(detail.querySelector('[data-key-add]')!);
    stored = { value: 'example-other-client-key', version: 'b'.repeat(64) };
    await click(saveButtonOf(container));
    await flush();

    expect(stored.value).toBe('example-other-client-key');
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-original-key,example-user-input', 'a'.repeat(64), binding);
    expect(container.querySelector('[data-feedback-tone="error"]')?.textContent).toContain('This key changed on the server while you were editing');
    expect(container.textContent).not.toContain('Managed nb-search credential or binding changed; reload.');
    const pendingRow = detail.querySelector('[data-key-row="1"]')!;
    if (pendingRow.querySelector('[data-key-value="masked"]')) await click(pendingRow.querySelector('[data-key-reveal]')!);
    expect(pendingRow.textContent).toContain('example-user-input');
    expect(saveButtonOf(container).disabled).toBe(false);
    // Reading again explicitly accepts the new base without dropping the user's list.
    await click(detail.querySelector('[data-key-show]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(stored.value).toBe('example-original-key,example-user-input');
    expect(writeNbSearchCredential).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('rebases a binding migrated by our address patch, including refresh recovery=%s', async (refreshFails) => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const oldBinding = 'a'.repeat(64);
    const newBinding = 'b'.repeat(64);
    let binding = oldBinding;
    let stored = { value: 'example-original-key', version: 'c'.repeat(64) };
    readNbSearchCredential.mockImplementation(async (_id: string, reveal: boolean) => ({
      ...MANAGED_KEYS, version: stored.version, binding_version: binding, value: reveal ? stored.value : undefined,
    }));
    patchConfig.mockImplementation(async (patch: Record<string, unknown>) => {
      binding = newBinding;
      stored = { value: 'example-migrated-key', version: 'd'.repeat(64) };
      return { ...CONFIGURED_EXA, ...patch };
    });
    writeNbSearchCredential.mockImplementation(async (_id: string, value: string, version: string, expectedBinding: string) => {
      if (version !== stored.version || expectedBinding !== binding) {
        throw Object.assign(new Error('Managed nb-search credential or binding changed; reload.'), { code: 40941 });
      }
      stored = { value, version: 'e'.repeat(64) };
      return { ...MANAGED_KEYS, version: stored.version, binding_version: binding };
    });
    getNbSearchCapabilities.mockResolvedValueOnce(CAPABILITIES);
    if (refreshFails) getNbSearchCapabilities.mockRejectedValueOnce(new Error('migration refresh unavailable'));
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-key-show]')!);
    await click(detail.querySelector('[data-key-replace]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-user-input');
    await click(detail.querySelector('[data-key-add]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-base-url]')!, 'https://example.test/migrated');
    await click(saveButtonOf(container));
    await flush();
    if (refreshFails) {
      expect(writeNbSearchCredential).not.toHaveBeenCalled();
      await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!);
      await flush();
      expect(saveButtonOf(container).disabled).toBe(false);
      await click(saveButtonOf(container));
      await flush();
    }
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-original-key,example-user-input', 'd'.repeat(64), newBinding);
    expect(stored.value).toBe('example-original-key,example-user-input');
    expect(container.querySelector('[data-feedback-tone="success"]')).not.toBeNull();
  });

  it('does not rebase a version-only concurrent change merely because a config patch also landed', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const binding = 'a'.repeat(64);
    let stored = { value: 'example-original-key', version: 'b'.repeat(64) };
    readNbSearchCredential.mockImplementation(async (_id: string, reveal: boolean) => ({
      ...MANAGED_KEYS, version: stored.version, binding_version: binding, value: reveal ? stored.value : undefined,
    }));
    writeNbSearchCredential.mockImplementation(async (_id: string, value: string, version: string) => {
      if (version !== stored.version) throw Object.assign(new Error('version conflict'), { code: 40941 });
      stored = { value, version: 'd'.repeat(64) };
      return { ...MANAGED_KEYS, version: stored.version, binding_version: binding };
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-key-show]')!);
    await click(detail.querySelector('[data-key-replace]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-balance-ttl]')!, '60000');
    stored = { value: 'example-other-client-key', version: 'c'.repeat(64) };
    await click(saveButtonOf(container));
    await flush();
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-original-key', 'b'.repeat(64), binding);
    expect(stored.value).toBe('example-other-client-key');
    expect(container.textContent).toContain('This key changed on the server while you were editing');
  });

  it('captures a version when replacing without reveal and preserves it through row edits', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const binding = 'a'.repeat(64);
    let version = 'b'.repeat(64);
    readNbSearchCredential.mockImplementation(async () => ({ ...MANAGED_KEYS, version, binding_version: binding }));
    writeNbSearchCredential.mockImplementation(async (_id: string, _value: string, expectedVersion: string) => {
      if (version !== expectedVersion) throw Object.assign(new Error('version conflict'), { code: 40941 });
      return { ...MANAGED_KEYS, version, binding_version: binding };
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-key-replace]')!);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-first-key,example-second-key');
    await click(detail.querySelector('[data-key-add]')!);
    await click(detail.querySelector('[data-key-up="1"]')!);
    version = 'c'.repeat(64);
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-second-key,example-first-key', 'b'.repeat(64), binding);
    expect(container.textContent).toContain('This key changed on the server while you were editing');
  });

  it('keeps successful keys committed while a sibling conflicts and retries only the unresolved key', async () => {
    getConfig.mockResolvedValue({
      ...CONFIGURED_EXA,
      nb_search: { provider_instances: {
        'exa.default': { provider_id: 'exa', enabled: true },
        'exa.backup': { provider_id: 'exa', enabled: true },
      } },
    });
    getNbSearchCapabilities.mockResolvedValue({
      ...CAPABILITIES,
      providers: { ...CAPABILITIES.providers, instances: [
        ...CAPABILITIES.providers.instances, { ...CAPABILITIES.providers.instances[0]!, id: 'exa.backup' },
      ] },
    });
    const binding = 'a'.repeat(64);
    const stored = new Map([
      ['exa.default', { value: 'example-primary-key', version: 'b'.repeat(64) }],
      ['exa.backup', { value: 'example-backup-key', version: 'c'.repeat(64) }],
    ]);
    readNbSearchCredential.mockImplementation(async (id: string, reveal: boolean) => ({
      ...MANAGED_KEYS, instance_id: id, slot_id: id, version: stored.get(id)!.version,
      binding_version: binding, value: reveal ? stored.get(id)!.value : undefined,
    }));
    writeNbSearchCredential.mockImplementation(async (id: string, value: string, version: string) => {
      if (version !== stored.get(id)!.version) throw Object.assign(new Error('version conflict'), { code: 40941 });
      stored.set(id, { value, version: 'd'.repeat(64) });
      return { ...MANAGED_KEYS, instance_id: id, version: 'd'.repeat(64), binding_version: binding };
    });
    const container = await renderSection('/settings/search?tab=providers');
    for (const id of ['exa.default', 'exa.backup']) {
      const detail = await openServiceDetail(container, id);
      await click(detail.querySelector('[data-key-show]')!);
      await click(detail.querySelector('[data-key-replace]')!);
      await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, `example-input-${id}`);
      await click(detail.querySelector('[data-key-add]')!);
    }
    stored.set('exa.backup', { value: 'example-other-client-key', version: 'e'.repeat(64) });
    await click(saveButtonOf(container));
    await flush();
    expect(stored.get('exa.default')!.value).toBe('example-primary-key,example-input-exa.default');
    expect(stored.get('exa.backup')!.value).toBe('example-other-client-key');
    expect(container.textContent).toContain('This key changed on the server while you were editing');
    await click(container.querySelector('[data-nb-search-service-row="exa.backup"]')!);
    const unresolved = container.querySelector('[data-nb-search-service="exa.backup"]')!;
    expect(unresolved.querySelector('[data-keys-mode="set"]')).not.toBeNull();
    await click(unresolved.querySelector('[data-key-show]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential.mock.calls.filter(([id]) => id === 'exa.default')).toHaveLength(1);
    expect(writeNbSearchCredential.mock.calls.filter(([id]) => id === 'exa.backup')).toHaveLength(2);
    expect(stored.get('exa.backup')!.value).toBe('example-backup-key,example-input-exa.backup');
  });

  it.each(['save', 'background refresh'])('clears stale availability after a later successful %s', async (recovery) => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    patchConfig.mockImplementation(async (patch: Record<string, unknown>) => ({ ...CONFIGURED_EXA, ...patch }));
    getNbSearchCapabilities
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce(new Error('post-key refresh unavailable'));
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-saved-key');
    await click(detail.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(container.querySelector('[data-nb-search-status-stale]')).not.toBeNull();
    const ttl = detail.querySelector<HTMLInputElement>('[data-nb-search-balance-ttl]')!;
    await setInputValue(ttl, '60000');
    getNbSearchCapabilities.mockResolvedValue({
      ...CAPABILITIES, revision: 'fresh-after-stale', search: { ...CAPABILITIES.search, default_lane: 'github.repositories' },
    });
    if (recovery === 'save') await click(saveButtonOf(container));
    else await act(async () => { await renderedQueryClient.invalidateQueries({ queryKey: ['nb-search-capabilities'] }); });
    await flush();
    expect(container.querySelector('[data-nb-search-status-stale]')).toBeNull();
    expect(container.querySelector('#st-card-search-status')!.textContent).toContain('Ready');
    expect(writeNbSearchCredential).toHaveBeenCalledTimes(1);
    if (recovery === 'background refresh') {
      expect(ttl.value).toBe('60000');
      expect(saveButtonOf(container).disabled).toBe(false);
    }
  });

  it('keeps an unexpected binding change as a conflict instead of attributing it to a later patch', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    let binding = 'a'.repeat(64);
    let version = 'b'.repeat(64);
    readNbSearchCredential.mockImplementation(async (_id: string, reveal: boolean) => ({
      ...MANAGED_KEYS, version, binding_version: binding, value: reveal ? 'example-original-key' : undefined,
    }));
    writeNbSearchCredential.mockImplementation(async (_id: string, _value: string, expectedVersion: string, expectedBinding: string) => {
      if (expectedVersion !== version || expectedBinding !== binding) throw Object.assign(new Error('binding conflict'), { code: 40941 });
      return { ...MANAGED_KEYS, version, binding_version: binding };
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await click(detail.querySelector('[data-key-show]')!);
    await click(detail.querySelector('[data-key-replace]')!);
    binding = 'c'.repeat(64);
    version = 'd'.repeat(64);
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-nb-search-balance-ttl]')!, '60000');
    await click(saveButtonOf(container));
    await flush();
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(writeNbSearchCredential).toHaveBeenCalledWith('exa.default', 'example-original-key', 'b'.repeat(64), 'a'.repeat(64));
    expect(container.textContent).toContain('This key changed on the server while you were editing');
  });

  it('protects the direct-paste read-to-write window and retains that base on a failed write retry', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const binding = 'a'.repeat(64);
    let version = 'none';
    let serverValue: string | null = null;
    const view = () => ({
      ...MANAGED_KEYS, stored: false, source: 'none', version, binding_version: binding,
    });
    readNbSearchCredential.mockImplementation(async () => view());
    writeNbSearchCredential.mockImplementation(async (_id: string, value: string, expectedVersion: string) => {
      if (serverValue === null) {
        // A competing write arrives after the save's first base read.
        serverValue = 'example-other-client-key';
        version = 'b'.repeat(64);
      }
      if (expectedVersion !== version) throw Object.assign(new Error('version conflict'), { code: 40941 });
      serverValue = value;
      return view();
    });
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-direct-paste');
    await click(detail.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();
    expect(serverValue).toBe('example-other-client-key');
    expect(writeNbSearchCredential).toHaveBeenLastCalledWith('exa.default', 'example-direct-paste', 'none', binding);
    expect(container.textContent).toContain('This key changed on the server while you were editing');
    await click(saveButtonOf(container));
    await flush();
    expect(writeNbSearchCredential).toHaveBeenLastCalledWith('exa.default', 'example-direct-paste', 'none', binding);
    expect(serverValue).toBe('example-other-client-key');
  });

  it('keeps the stale-status retry available after a failed retry without losing a new config edit', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    getNbSearchCapabilities
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce(new Error('post-key refresh unavailable'))
      .mockRejectedValueOnce(new Error('retry still unavailable'));
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    await setInputValue(detail.querySelector<HTMLInputElement>('[data-key-input]')!, 'example-saved-key');
    await click(detail.querySelector('[data-key-add]')!);
    await click(saveButtonOf(container));
    await flush();
    const ttl = detail.querySelector<HTMLInputElement>('[data-nb-search-balance-ttl]')!;
    await setInputValue(ttl, '60000');
    await click(container.querySelector('[data-nb-search-status-stale] button')!);
    await flush();
    expect(container.querySelector('[data-nb-search-status-stale]')).not.toBeNull();
    expect(container.querySelector('#st-card-search-providers')).not.toBeNull();
    expect(ttl.value).toBe('60000');
    expect(saveButtonOf(container).disabled).toBe(false);
    expect(writeNbSearchCredential).toHaveBeenCalledTimes(1);
    await click(container.querySelector('[data-nb-search-status-stale] button')!);
    await flush();
    expect(container.querySelector('[data-nb-search-status-stale]')).toBeNull();
    expect(ttl.value).toBe('60000');
    expect(writeNbSearchCredential).toHaveBeenCalledTimes(1);
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
    expect(sourceCard.textContent).toContain('Values saved here take priority');
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
    // The chosen lane is marked, and it heads the list because it is in use.
    expect(searchPanel.textContent).toContain('Current default');
    expect(searchPanel.textContent).toContain('github.repositories');

    // Pinning a lane
    const pinButtons = [...searchPanel.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'false' && b.querySelector('[data-icon="pin"]') !== null);
    expect(pinButtons.length).toBeGreaterThan(0);
    await click(pinButtons[0]!);
    expect(searchPanel.textContent).toContain('Pinned');

    // Filter lanes: the row goes away, not merely the words. The inherit row
    // still names the lane in use, which is the point of it.
    const searchInput = searchPanel.querySelector<HTMLInputElement>('input[type="search"]')!;
    await setInputValue(searchInput, 'example');
    expect(searchPanel.textContent).toContain('example.documents');
    expect(searchPanel.querySelector('[data-nb-search-lane-row="github.repositories"]')).toBeNull();
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
    const laneRadio = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="example.documents"] input[type="radio"]',
    )!;
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
    const laneRadio = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="github.repositories"] input[type="radio"]',
    )!;
    await click(laneRadio);

    const saveButton = saveButtonOf(container);
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

  it('narrows the service directory instead of a whole-catalogue form list', async () => {
    const container = await renderSection('/settings/search?tab=providers');
    const providers = container.querySelector('#st-card-search-providers')!;
    const directory = await openDirectory(container);

    // Every service the server reports is listed, with its own state word.
    expect(directory.querySelectorAll('[data-nb-search-directory-row]')).toHaveLength(2);
    expect(directory.textContent).toContain('Exa');
    expect(directory.textContent).toContain('Direct HTTP');
    expect(directory.textContent).toContain('needs a key');
    expect(directory.textContent).toContain('no key needed');

    const searchInput = directory.querySelector<HTMLInputElement>('input[type="search"]')!;
    await setInputValue(searchInput, 'direct');
    expect(directory.querySelector('[data-nb-search-directory-row="direct-http.default"]')).not.toBeNull();
    expect(directory.querySelector('[data-nb-search-directory-row="exa.default"]')).toBeNull();

    // A query nothing matches says so, and clearing it brings the list back.
    await setInputValue(searchInput, 'nothing-matches-this');
    expect(directory.textContent).toContain('No service matches');
    await click([...directory.querySelectorAll('button')].find((b) => b.textContent === 'Clear search and filters')!);
    expect(directory.querySelector('[data-nb-search-directory-row="exa.default"]')).not.toBeNull();
  });

  it('supports discard edits in the sticky action bar', async () => {
    const container = await renderSection();
    const searchTab = container.querySelector('#nb-search-tab-search')!;
    await click(searchTab);

    const laneRadio = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="github.repositories"] input[type="radio"]',
    )!;
    await click(laneRadio);

    const discardButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Discard edits')!;
    expect(discardButton).toBeDefined();
    await click(discardButton);

    // After discard the draft is back to "no override", so the inherit row wins.
    const inheritRadio = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-inherit] input[type="radio"]',
    )!;
    expect(inheritRadio.checked).toBe(true);
    expect(saveButtonOf(container).disabled).toBe(true);
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
    const laneRadio = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="github.repositories"] input[type="radio"]',
    )!;
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
    const radioNow = container.querySelector<HTMLInputElement>(
      '[data-nb-search-lane-row="github.repositories"] input[type="radio"]',
    )!;
    expect(radioNow.checked).toBe(true);

    // Save button remains enabled with unsaved indicator
    expect(saveButtonOf(container).disabled).toBe(false);
  });

  it('keeps a key draft across tab switches and registers it with the leave guard', async () => {
    getConfig.mockResolvedValue(CONFIGURED_EXA);
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const keys = detail.querySelector('[data-nb-search-keys="exa.default"]')!;
    await setInputValue(keys.querySelector<HTMLInputElement>('[data-key-input]')!, 'fixture-unsaved-key');
    await click(keys.querySelector('[data-key-add]')!);

    // Leave the tab and come back: the key is still typed and still unsaved.
    await click(container.querySelector('#nb-search-tab-overview')!);
    await click(container.querySelector('#nb-search-tab-providers')!);
    const after = container.querySelector('[data-nb-search-keys="exa.default"]')!;
    expect(after.textContent).toContain('fixture-unsaved-key');
    expect(saveButtonOf(container).disabled).toBe(false);
    expect(container.querySelector('[data-dirty-indicator]')).not.toBeNull();
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
    for (const [cardId, tab] of Object.entries(CARD_ID_TO_TAB)) {
      expect(searchTabForCard(cardId), cardId).toBe(tab);
    }
    for (const tab of NB_SEARCH_TABS) {
      expect(entries.some((entry) => entry.tab === tab), tab).toBe(true);
    }
    // Rendering a hit's target must actually mount the card it flashes. The
    // Experimental rows are mounted by SettingsPage after the leaf, not in a panel.
    for (const entry of entries.filter((item) => item.cardId !== 'st-card-exp-search')) {
      const container = await renderSection(`/settings/search?tab=${entry.tab}`);
      const panel = container.querySelector(`#nb-search-panel-${entry.tab}`);
      expect(panel, entry.cardId).not.toBeNull();
      expect(panel!.className, entry.cardId).not.toContain('hidden');
      expect(panel!.querySelector(`#${entry.cardId}`), entry.cardId).not.toBeNull();
    }
  });
});

describe('NbSearchSection S2 mounted surfaces', () => {
  it('renders the S2 editing surfaces on the product route', async () => {
    const container = await renderSection('/settings/search?tab=search');
    const lanes = container.querySelector('#st-card-search-defaults')!;
    // The advanced binding is passed by the page itself, so these are the real
    // product surfaces, not a harness-only branch.
    expect(lanes.querySelector('[data-nb-search-lane-edit]'), 'lane row editing').not.toBeNull();
    expect(lanes.querySelector('[data-nb-search-lane-add]'), 'new search method').not.toBeNull();

    const fetchCard = container.querySelector('#st-card-search-fetch')!;
    expect(fetchCard.querySelector('[data-nb-search-fetch-combo]'), 'input/output pair picker').not.toBeNull();
    expect(fetchCard.querySelector('[data-nb-search-fetch-input]'), 'input kind').not.toBeNull();
    expect(fetchCard.querySelector('[data-nb-search-fetch-representation]'), 'representation').not.toBeNull();
    expect(fetchCard.querySelector('[data-nb-search-fetch-chain]'), 'ordered pipeline chain').not.toBeNull();

    expect(container.querySelector('[data-nb-search-filescope-state]'), 'file scopes').not.toBeNull();
    expect(container.querySelector('[data-nb-search-quality-mode]'), 'quality fallback').not.toBeNull();
  });

  it('creates a second instance of one service with its own slot and variable, then saves both', async () => {
    getNbSearchCapabilities.mockReset().mockResolvedValue(PROJECTED_CAPABILITIES);
    getConfig.mockResolvedValueOnce(CONFIGURED_EXA);
    const container = await renderSection('/settings/search?tab=providers');

    await click(container.querySelector('[data-nb-search-new-instance]')!);
    const editor = container.querySelector('[data-nb-search-instance-editor]')!;
    await click(editor.querySelector('[data-nb-search-provider-option="exa"]')!);
    expect(editor.querySelector<HTMLInputElement>('[data-nb-search-instance-id]')!.value).toBe('exa.custom');
    expect(editor.querySelector<HTMLInputElement>('[data-nb-search-instance-env]')!.value)
      .toBe('NB_SEARCH_EXA_CUSTOM_API_KEY');
    await click(editor.querySelector('[data-nb-search-instance-create]')!);

    // It is listed and editable before the server has ever seen it, and its
    // state does not borrow a readiness or a credential state.
    const row = container.querySelector('[data-nb-search-service-row="exa.custom"]')!;
    expect(row.querySelector('[data-nb-search-row-state]')!.getAttribute('data-nb-search-row-state')).toBe('unsaved');
    const detail = container.querySelector('[data-nb-search-service="exa.custom"]')!;
    expect(detail.textContent).toContain('not saved yet');
    expect(detail.querySelector('[data-nb-search-key-usage]'), 'nothing to read from a draft instance').toBeNull();
    expect(detail.textContent).toContain('Key status can be checked once this service is saved.');
    // The old instance is still there, with its own editor.
    expect(container.querySelector('[data-nb-search-service-row="exa.default"]')).not.toBeNull();

    await click(saveButtonOf(container));
    await flush();

    const patch = patchConfig.mock.calls.at(-1)![0] as {
      nb_search: {
        provider_instances: Record<string, Record<string, unknown>>;
        credential_slots: Record<string, Record<string, unknown>>;
      };
    };
    expect(Object.keys(patch.nb_search.provider_instances).sort()).toEqual(['exa.custom', 'exa.default']);
    expect(patch.nb_search.provider_instances['exa.custom']).toMatchObject({
      provider_id: 'exa',
      enabled: true,
      credential_slot_id: 'exa.custom',
    });
    // Its own variable, not the sibling's.
    expect(patch.nb_search.credential_slots['exa.custom'])
      .toEqual({ provider_id: 'exa', env: 'NB_SEARCH_EXA_CUSTOM_API_KEY' });
    expect(patch.nb_search.credential_slots['exa.default']).toBeUndefined();
  });

  it('reads key status only when asked, and shows the unknown state honestly', async () => {
    getConfig.mockResolvedValueOnce(CONFIGURED_EXA);
    const container = await renderSection('/settings/search?tab=providers');
    const detail = await openServiceDetail(container, 'exa.default');
    const panel = detail.querySelector('[data-nb-search-key-usage="exa.default"]')!;
    expect(readNbSearchKeyUsage).not.toHaveBeenCalled();
    expect(panel.querySelector('[data-nb-search-key-usage-idle]')).not.toBeNull();

    await click(panel.querySelector('[data-nb-search-key-usage-load]')!);
    await flush();
    expect(readNbSearchKeyUsage).toHaveBeenCalledWith('exa.default', false);
    const states = [...panel.querySelectorAll('[data-nb-search-key-state]')];
    expect(states).toHaveLength(2);
    expect(states.map((node) => node.getAttribute('data-nb-search-key-state'))).toEqual(['unknown', 'unknown']);

    // Reading again is the one thing that asks the server again.
    await click(panel.querySelector('[data-nb-search-key-usage-refresh]')!);
    await flush();
    expect(readNbSearchKeyUsage).toHaveBeenLastCalledWith('exa.default', true);
  });

  it('keeps the key-status read out of the save path', async () => {
    getConfig.mockResolvedValueOnce(CONFIGURED_EXA);
    const container = await renderSection('/settings/search?tab=providers');
    await openServiceDetail(container, 'exa.default');
    await flush();
    expect(readNbSearchKeyUsage).not.toHaveBeenCalled();
  });
});

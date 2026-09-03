// @vitest-environment jsdom

/**
 * NbSearchSection: readiness status from capabilities, narrow nb_search
 * replace-domain save, and the on-demand diagnostics check with cancel.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { NbSearchSection } from './NbSearchSection';

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

const CAPABILITIES = {
  schema_version: '3.0',
  revision: 'config-fixture',
  providers: {
    descriptors: [
      { provider_id: 'exa', adapter_version: '1', query_operations: [], fetch_operations: [], activation: { credential: 'required', endpoint: 'optional' }, option_keys: [] },
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

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSection(): Promise<HTMLDivElement> {
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
          <NbSearchSection />
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
    expect(defaults.textContent).toContain('github.repositories');
    expect(defaults.textContent).toContain('No default (fail closed)');
    const providers = container.querySelector('#st-card-search-providers')!;
    expect(providers.textContent).toContain('exa.default');
    expect(providers.textContent).toContain('credential missing');
    // The env input holds a variable NAME only; no secret field exists.
    const envInput = providers.querySelector<HTMLInputElement>('input[placeholder="NB_SEARCH_EXA_API_KEY"]')!;
    expect(envInput.value).toBe('');
  });
});

describe('NbSearchSection save', () => {
  it('patches only nb_search with replace_domains after a lane choice and credential env edit', async () => {
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
        provider_instances: {
          'exa.default': {
            provider_id: 'exa',
            enabled: true,
            credential_slot_id: 'exa.default',
            base_url: undefined,
            options: {},
          },
        },
        credential_slots: { 'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' } },
      },
      replace_domains: ['nb_search'],
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

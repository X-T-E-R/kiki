// @vitest-environment jsdom

/**
 * S2: the advanced nb-search editors behind the page's single draft.
 *
 * Every case drives the real tab components with the real session-core helpers
 * and then runs the real `nbSearchConfigPatch`, so what is asserted is the body
 * the page would send — plus a re-read of the echoed config, which is what the
 * next page load sees.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { NbSearchCapabilities, NbSearchConfigPatch } from '@kiki/protocol';
import { selectFetchRoute } from '@kiki/protocol';
import {
  nbSearchConfigPatch,
  nbSearchDraftFromConfig,
  type NbSearchDraft,
} from '@kiki/session-core/settings';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { NbSearchLanesTab } from './NbSearchLanesTab';
import { NbSearchFetchTab } from './NbSearchFetchTab';
import { NbSearchAdvancedTab } from './NbSearchAdvancedTab';
import { NbSearchInstanceEditor } from './NbSearchInstanceEditor';
import { NbSearchKeyUsagePanel } from './NbSearchKeyUsagePanel';
import type { NbSearchAdvancedBinding } from './advancedSupport';

/** The default input × output pairs, which is what the source layer carries too. */
const FETCH_CHAINS: NbSearchCapabilities['fetch']['chains'] = [
  { input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] },
  { input_kind: 'url', representation: 'text', pipelines: ['direct.fetch'] },
  { input_kind: 'inline_text', representation: 'markdown', pipelines: ['direct.local'] },
  { input_kind: 'inline_text', representation: 'text', pipelines: ['direct.local'] },
  { input_kind: 'inline_bytes', representation: 'markdown', pipelines: ['direct.local'] },
  { input_kind: 'inline_bytes', representation: 'text', pipelines: ['direct.local'] },
  { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
  { input_kind: 'file', representation: 'text', pipelines: ['direct.local'] },
];

const SOURCE_LANES = {
  'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
  'exa.synthesis': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'medium', cost: 'expensive' },
  'github.repositories': { provider_instance_id: 'github.default', operation_id: 'repositories', latency: 'fast', cost: 'free' },
} satisfies NonNullable<NbSearchCapabilities['inherited_configuration']>['lanes'];

const CAPABILITIES: NbSearchCapabilities = {
  schema_version: '3.0',
  revision: 's2-fixture',
  configuration: {
    lanes: SOURCE_LANES,
    presets: {},
    provider_instance_ids: ['direct-http.default', 'exa.default', 'github.default', 'tavily.default'],
    fetch_chains: [],
    file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }],
  },
  /**
   * The layers below Kiki: the only thing that says an item is source-provided.
   * The effective catalogs above cannot say it, because they list whatever is in
   * force — a method added on this page appears there as soon as it is saved.
   */
  inherited_configuration: {
    lanes: SOURCE_LANES,
    presets: { fast: { lanes: ['github.repositories'] } },
    provider_instance_ids: ['direct-http.default', 'exa.default', 'github.default', 'tavily.default'],
    default_search_lane: 'github.repositories',
    fetch_chains: FETCH_CHAINS,
    file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }],
  },
  providers: {
    descriptors: [
      {
        provider_id: 'exa',
        adapter_version: '1',
        query_operations: [
          { operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
          { operation_id: 'synthesis', output: { channel: 'typed', schema_id: 'exa.synthesis@1' }, built_in_async: true },
        ],
        fetch_operations: [],
        activation: { credential: 'required', endpoint: 'optional' },
        option_keys: [],
      },
      {
        provider_id: 'tavily',
        adapter_version: '1',
        query_operations: [
          { operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
          { operation_id: 'research', output: { channel: 'typed', schema_id: 'tavily.research@1' }, built_in_async: true },
        ],
        fetch_operations: [],
        activation: { credential: 'required', endpoint: 'optional' },
        option_keys: [],
      },
      {
        provider_id: 'github',
        adapter_version: '1',
        query_operations: [
          { operation_id: 'repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true },
        ],
        fetch_operations: [],
        activation: { credential: 'none', endpoint: 'none' },
        option_keys: [],
      },
      {
        provider_id: 'direct-http',
        adapter_version: '1',
        query_operations: [],
        fetch_operations: [{ operation_id: 'fetch' }, { operation_id: 'local' }],
        activation: { credential: 'none', endpoint: 'none' },
        option_keys: [],
      },
    ],
    instances: [
      { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: true, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'tavily.default', provider_id: 'tavily', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'required', configured: false, slot_id: 'tavily.default' }, endpoint: { requirement: 'optional', configured: false } },
      { id: 'github.default', provider_id: 'github', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
      { id: 'direct-http.default', provider_id: 'direct-http', enabled: true, availability: 'ready', issues: [], credential: { requirement: 'none', configured: false }, endpoint: { requirement: 'none', configured: false } },
    ],
  },
  search: {
    default_lane: 'github.repositories',
    lanes: [
      { id: 'exa.search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
      { id: 'exa.synthesis', output: { channel: 'typed', schema_id: 'exa.synthesis@1' }, execution_modes: ['async'], availability: 'ready', issues: [], latency: 'medium', cost: 'expensive' },
      { id: 'github.repositories', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
    ],
    presets: [
      { name: 'fast', lanes: ['github.repositories'], execution_modes: ['sync'], availability: 'ready', issues: [] },
    ],
    limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
  },
  fetch: {
    default_representation: 'markdown',
    inputs: [
      { kind: 'url', enabled: true, max_bytes: 2_097_152 },
      { kind: 'inline_text', enabled: true, max_bytes: 2_097_152 },
      { kind: 'inline_bytes', enabled: true, max_bytes: 2_097_152 },
      { kind: 'file', enabled: false, max_bytes: 2_097_152 },
    ],
    chains: FETCH_CHAINS,
    pipelines: [
      { id: 'direct.fetch', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'direct-http', role: 'acquire' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'direct.local', input_kinds: ['inline_text', 'inline_bytes', 'file'], media_types: ['text/plain'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'none', stages: [{ id: 'direct-http', role: 'convert' }], availability: 'ready', issues: [], latency: 'fast', cost: 'free' },
      { id: 'jina.reader', input_kinds: ['url'], media_types: ['text/html'], representations: ['markdown', 'text'], execution_modes: ['sync'], egress: 'url', stages: [{ id: 'jina-reader', role: 'reader' }], availability: 'ready', issues: [], latency: 'medium', cost: 'free' },
    ],
    // What the server reports for the maintained package. The page reads this
    // projection; it never rebuilds the built-in rule list itself.
    routing: {
      enabled: true,
      builtin_enabled: true,
      package: {
        id: 'kiki-common-direct',
        version: '1',
        maintainer: 'Kiki',
        summary: 'Known GitHub raw text and repository JSON endpoints, npm metadata, and PyPI JSON; direct-only.',
      },
      builtin_rules: [
        { id: 'github-raw-text', match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/**/*.md'] }, action: { pipelines: ['direct.fetch'] } },
        { id: 'github-repository-json', match: { origin: 'https://api.github.com', path_globs: ['/repos/*/*'] }, action: { pipelines: ['direct.fetch'] } },
      ],
      disabled_builtin_rules: [],
      rules: [],
    },
    limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 2_097_152 },
  },
  jobs: { result_ttl_seconds: 3_600, cancel_supported: true },
};

/**
 * What the server reports after a save that added a method and a preset here:
 * both appear in the effective catalogs, and neither appears in the source layer.
 */
const CAPABILITIES_AFTER_LOCAL: NbSearchCapabilities = {
  ...CAPABILITIES,
  configuration: {
    ...CAPABILITIES.configuration!,
    lanes: {
      ...CAPABILITIES.configuration!.lanes,
      'exa.local': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
    },
    presets: { preset: { lanes: ['exa.search'] } },
  },
  search: {
    ...CAPABILITIES.search,
    lanes: [
      ...CAPABILITIES.search.lanes,
      { id: 'exa.local', output: { channel: 'results', schema_id: 'nb-search.results@1' }, execution_modes: ['sync'], availability: 'ready', issues: [], latency: 'fast', cost: 'cheap' },
    ],
    presets: [
      ...CAPABILITIES.search.presets,
      { name: 'preset', lanes: ['exa.search'], execution_modes: ['sync'], availability: 'ready', issues: [] },
    ],
  },
};

/** Unknown keys S2 must carry through untouched. */
const BASE_CONFIG = {
  home: '/srv/nb-search',
  log_level: 'debug',
  retention_hours: 48,
  defaults: { search_lane: 'github.repositories' },
} as unknown as NbSearchConfigPatch;

const hosts: { draft: NbSearchDraft; config: NbSearchConfigPatch | undefined; patch: Record<string, unknown> | null } = {
  draft: null as unknown as NbSearchDraft,
  config: undefined,
  patch: null,
};

function Host({
  capabilities: initialCapabilities,
  capabilitiesAfterSave,
  initialConfig,
  view,
}: {
  capabilities: NbSearchCapabilities;
  /**
   * What the server reports once a save lands. A local entry shows up in the
   * effective catalog here, exactly as it does in the product after a reload.
   */
  capabilitiesAfterSave?: NbSearchCapabilities;
  initialConfig: NbSearchConfigPatch | undefined;
  view: 'lanes' | 'fetch' | 'advanced' | 'instance';
}) {
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [config, setConfig] = useState(initialConfig);
  const [draft, setDraft] = useState<NbSearchDraft>(() => nbSearchDraftFromConfig(initialConfig, initialCapabilities));
  hosts.draft = draft;
  hosts.config = config;
  const binding: NbSearchAdvancedBinding = { capabilities, draft, config, onChange: setDraft };
  return (
    <div>
      <button
        type="button"
        data-save
        onClick={() => {
          const patch = nbSearchConfigPatch(config, draft, capabilities);
          hosts.patch = patch as unknown as Record<string, unknown>;
          // The server replaces the whole domain and echoes it; re-reading the
          // echo, against the capabilities it now reports, is what the next page
          // load does.
          const nextCapabilities = capabilitiesAfterSave ?? capabilities;
          setConfig(patch.nb_search);
          setCapabilities(nextCapabilities);
          setDraft(nbSearchDraftFromConfig(patch.nb_search, nextCapabilities));
        }}
      >
        save
      </button>
      {view === 'lanes' ? (
        <NbSearchLanesTab
          capabilities={capabilities}
          defaultSearchLane={draft.defaultSearchLane}
          onSelectLane={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'fetch' ? (
        <NbSearchFetchTab
          capabilities={capabilities}
          fetchChain={draft.fetchChain}
          fetchChainInherited={draft.fetchChainInherited}
          onChangeChain={() => undefined}
          onToggleInherited={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'advanced' ? (
        <NbSearchAdvancedTab
          execution={draft.execution}
          testRun={{ status: 'idle' }}
          onUpdateExecution={(patch) => {
            setDraft((current) => ({ ...current, execution: { ...current.execution, ...patch } }));
          }}
          onRunCheck={() => undefined}
          onCancelCheck={() => undefined}
          advanced={binding}
        />
      ) : null}
      {view === 'instance' ? (
        <NbSearchInstanceEditor
          capabilities={capabilities}
          draft={draft}
          onCancel={() => undefined}
          onCreated={(next) => {
            setDraft(next);
          }}
        />
      ) : null}
    </div>
  );
}

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  hosts.patch = null;
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

async function render(
  view: 'lanes' | 'fetch' | 'advanced' | 'instance',
  initialConfig: NbSearchConfigPatch | undefined = BASE_CONFIG,
  options: { capabilitiesAfterSave?: NbSearchCapabilities; capabilities?: NbSearchCapabilities } = {},
): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <Host
          capabilities={options.capabilities ?? CAPABILITIES}
          capabilitiesAfterSave={options.capabilitiesAfterSave}
          initialConfig={initialConfig}
          view={view}
        />
      </I18nProvider>,
    );
  });
  return container;
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function save(container: HTMLElement): Promise<void> {
  await click(container.querySelector('[data-save]'));
}

/** Pick an option from a `SettingsSelect` popover (rendered in the body portal). */
async function choose(container: HTMLElement, dataAttr: string, value: string): Promise<void> {
  await click(container.querySelector(`[${dataAttr}] button`));
  const option = document.querySelector(`[data-option-value="${value}"]`);
  expect(option, `option ${value} of ${dataAttr}`).not.toBeNull();
  await click(option);
}

const nbSearchOf = (): NbSearchConfigPatch | undefined => hosts.patch?.['nb_search'] as NbSearchConfigPatch | undefined;

describe('S2 search methods', () => {
  it('creates a local method, saves it, and reads it back as a saved lane', async () => {
    const container = await render('lanes');
    await click(container.querySelector('[data-nb-search-lane-add]'));

    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-lane-id]');
    expect(idInput).not.toBeNull();
    await setInputValue(idInput!, 'exa.local');
    await pressEnter(idInput!);
    expect(container.querySelector('[data-nb-search-lane-row="exa.local"]')).not.toBeNull();
    expect(container.querySelector('[data-nb-search-lane-row="exa.local"]')!.textContent).toContain('Exa · search');
    // The row is not registered with the engine yet, and says so.
    expect(container.querySelector('[data-nb-search-lane-execution="pending"]')).not.toBeNull();

    await save(container);
    expect(nbSearchOf()?.lanes).toEqual({
      'exa.local': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' },
    });
    // Re-read of the echoed config keeps the method, so the row is still there.
    expect(hosts.draft.advanced?.lanes['exa.local']).toEqual({
      provider_instance_id: 'exa.default',
      operation_id: 'search',
      latency: 'fast',
      cost: 'cheap',
    });
    expect(container.querySelector('[data-nb-search-lane-row="exa.local"]')).not.toBeNull();
  });

  it('selects the new method as the default and keeps it across the save', async () => {
    const container = await render('lanes');
    await click(container.querySelector('[data-nb-search-lane-add]'));
    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-lane-id]')!;
    await setInputValue(idInput, 'exa.local');
    await pressEnter(idInput);
    await click(container.querySelector('[data-nb-search-lane-row="exa.local"] input[type="radio"]'));
    await save(container);
    expect(nbSearchOf()?.defaults).toEqual({ search_lane: 'exa.local' });
    expect(hosts.draft.defaultSearchLane).toBe('exa.local');
  });

  it('names the entries that still use a method before deleting it', async () => {
    const container = await render('lanes');
    await click(container.querySelector('[data-nb-search-lane-add]'));
    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-lane-id]')!;
    await setInputValue(idInput, 'exa.local');
    await pressEnter(idInput);
    await click(container.querySelector('[data-nb-search-lane-row="exa.local"] input[type="radio"]'));

    await click(container.querySelector('[data-nb-search-lane-remove]'));
    const references = container.querySelector('[data-nb-search-lane-references]');
    expect(references).not.toBeNull();
    expect(references!.textContent).toContain('the default search method');
    expect(references!.textContent).toContain('defaults.search_lane');
  });

  it('overrides a source-provided method and restores the source version', async () => {
    const container = await render('lanes');
    // The source layer has this method, so the row says so and the editor offers
    // an override instead of edit-in-place.
    expect(
      container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.search"]')!.dataset['nbSearchLaneOrigin'],
    ).toBe('source');
    await click(container.querySelector('[data-nb-search-lane-edit="exa.search"]'));
    // Read-only until the override is built.
    expect(container.querySelector('[data-nb-search-lane-readonly]')).not.toBeNull();
    expect(container.querySelector('[data-nb-search-lane-remove]')).toBeNull();
    await click(container.querySelector('[data-nb-search-lane-override]'));
    expect(container.querySelector('[data-nb-search-lane-readonly]')).toBeNull();
    expect(hosts.draft.advanced?.lanes['exa.search']).toEqual({
      provider_instance_id: 'exa.default',
      operation_id: 'search',
      latency: 'fast',
      cost: 'cheap',
    });
    // Now it is an override: the source is still below it, so restoring is the
    // action, and deleting it outright is not offered.
    const editor = container.querySelector<HTMLElement>('[data-nb-search-lane-editor="exa.search"]')!;
    expect(editor.dataset['nbSearchLaneSource']).toBe('override');
    expect(editor.querySelector('[data-nb-search-lane-remove]')).toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.search"]')!.dataset['nbSearchLaneOrigin'],
    ).toBe('override');

    await click(container.querySelector('[data-nb-search-lane-restore]'));
    expect(hosts.draft.advanced?.lanes['exa.search']).toBeUndefined();
  });

  it('adds a preset from the page draft and saves only the local entry', async () => {
    const container = await render('lanes');
    expect(container.querySelector('[data-nb-search-preset-row="fast"]')).not.toBeNull();
    await click(container.querySelector('[data-nb-search-preset-add]'));
    const presetRow = container.querySelector('[data-nb-search-preset-row="preset"]');
    expect(presetRow).not.toBeNull();
    expect(presetRow!.textContent).toContain('1 method');
    await save(container);
    expect(nbSearchOf()?.presets).toEqual({ preset: { lanes: ['exa.search'] } });
  });
});

describe('S2 item source across a save and reload', () => {
  it('keeps a method added here local once the catalog reports it', async () => {
    const container = await render('lanes', BASE_CONFIG, { capabilitiesAfterSave: CAPABILITIES_AFTER_LOCAL });
    await click(container.querySelector('[data-nb-search-lane-add]'));
    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-lane-id]')!;
    await setInputValue(idInput, 'exa.local');
    await pressEnter(idInput);
    await save(container);

    // The method is served by the engine now, and is still Kiki's own: the
    // effective catalog lists it, the layers below do not.
    const row = container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.local"]')!;
    expect(row.dataset['nbSearchLaneOrigin']).toBe('local');
    expect(row.querySelector<HTMLElement>('[data-nb-search-lane-source-badge]')!.dataset['nbSearchLaneSourceBadge']).toBe('local');
    // The rows the source really provides are untouched by that.
    expect(
      container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.synthesis"]')!.dataset['nbSearchLaneOrigin'],
    ).toBe('source');

    // The editor is still the one that opened when the method was added, so
    // close and open it again: this is the interaction a reload gives you.
    await click(container.querySelector('[data-nb-search-lane-edit="exa.local"]'));
    expect(container.querySelector('[data-nb-search-lane-editor="exa.local"]')).toBeNull();
    await click(container.querySelector('[data-nb-search-lane-edit="exa.local"]'));
    const editor = container.querySelector<HTMLElement>('[data-nb-search-lane-editor="exa.local"]')!;
    expect(editor.dataset['nbSearchLaneSource']).toBe('local');
    // Editable in place, deletable, and with no source to restore.
    expect(editor.querySelector<HTMLInputElement>('[data-nb-search-lane-id]')!.readOnly).toBe(false);
    expect(editor.querySelector('[data-nb-search-lane-remove]')).not.toBeNull();
    expect(editor.querySelector('[data-nb-search-lane-override]')).toBeNull();
    expect(editor.querySelector('[data-nb-search-lane-restore]')).toBeNull();
  });

  it('keeps a preset added here local once the catalog reports it', async () => {
    const container = await render('lanes', BASE_CONFIG, { capabilitiesAfterSave: CAPABILITIES_AFTER_LOCAL });
    await click(container.querySelector('[data-nb-search-preset-add]'));
    await save(container);

    const row = container.querySelector<HTMLElement>('[data-nb-search-preset-row="preset"]')!;
    expect(row.dataset['nbSearchPresetOrigin']).toBe('local');
    expect(row.querySelector<HTMLElement>('[data-nb-search-preset-source-badge]')!.dataset['nbSearchPresetSourceBadge']).toBe('local');
    expect(
      container.querySelector<HTMLElement>('[data-nb-search-preset-row="fast"]')!.dataset['nbSearchPresetOrigin'],
    ).toBe('source');

    await click(container.querySelector('[data-nb-search-preset-open="preset"]'));
    expect(container.querySelector('[data-nb-search-preset-editor="preset"]')).toBeNull();
    await click(container.querySelector('[data-nb-search-preset-open="preset"]'));
    const editor = container.querySelector<HTMLElement>('[data-nb-search-preset-editor="preset"]')!;
    expect(editor.dataset['nbSearchPresetSource']).toBe('local');
    expect(editor.querySelector('[data-nb-search-preset-remove]')).not.toBeNull();
    expect(editor.querySelector('[data-nb-search-preset-restore]')).toBeNull();
  });
});

describe('S2 item source when the lower layer was not reported', () => {
  /**
   * A server may omit `inherited_configuration` when reading the layer below
   * fails — the contract allows the omission beyond the old fixtures. That is
   * not the same as "the layer below declares nothing", so no origin may be
   * named from it: a local declaration is still local without promising it is
   * the only one, and an entry nothing here declares stays unconfirmed.
   */
  const { inherited_configuration: _notReported, ...rest } = CAPABILITIES;
  const NO_PROJECTION: NbSearchCapabilities = rest;
  const CATALOG_WITHOUT_PROJECTION: NbSearchCapabilities = {
    ...NO_PROJECTION,
    search: {
      ...NO_PROJECTION.search,
      presets: [{
        name: 'engine-only',
        lanes: ['exa.search'],
        execution_modes: ['sync'],
        availability: 'ready',
        issues: [],
      }],
    },
  };
  const LOCAL_CONFIG = {
    ...BASE_CONFIG,
    lanes: { 'exa.local': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' } },
  } as unknown as NbSearchConfigPatch;

  it('keeps a local method editable and deletable without calling it the only declaration', async () => {
    const container = await render('lanes', LOCAL_CONFIG, { capabilities: NO_PROJECTION });
    const row = container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.local"]')!;
    expect(row.dataset['nbSearchLaneOrigin']).toBe('localUnconfirmed');
    const badge = row.querySelector<HTMLElement>('[data-nb-search-lane-source-badge]')!;
    expect(badge.dataset['nbSearchLaneSourceBadge']).toBe('localUnconfirmed');
    expect(badge.textContent).toContain('local setting');

    await click(container.querySelector('[data-nb-search-lane-edit="exa.local"]'));
    const editor = container.querySelector<HTMLElement>('[data-nb-search-lane-editor="exa.local"]')!;
    expect(editor.dataset['nbSearchLaneSource']).toBe('localUnconfirmed');
    // The sentence names what is missing instead of claiming the item is local only.
    expect(editor.querySelector('[data-nb-search-lane-origin]')!.textContent).toContain('was not reported');
    // Editing and deleting the local declaration stay available; handing it to a
    // source version does not, because no source was reported.
    expect(editor.querySelector<HTMLInputElement>('[data-nb-search-lane-id]')!.readOnly).toBe(false);
    expect(editor.querySelector('[data-nb-search-lane-remove]')).not.toBeNull();
    expect(editor.querySelector('[data-nb-search-lane-restore]')).toBeNull();
  });

  it('says the origin is unconfirmed when nothing here declares the method', async () => {
    const container = await render('lanes', BASE_CONFIG, { capabilities: NO_PROJECTION });
    const row = container.querySelector<HTMLElement>('[data-nb-search-lane-row="exa.search"]')!;
    expect(row.dataset['nbSearchLaneOrigin']).toBe('unknown');
    const badge = row.querySelector<HTMLElement>('[data-nb-search-lane-source-badge]')!;
    expect(badge.dataset['nbSearchLaneSourceBadge']).toBe('unknown');
    expect(badge.textContent).toContain('origin unconfirmed');

    await click(container.querySelector('[data-nb-search-lane-edit="exa.search"]'));
    const editor = container.querySelector<HTMLElement>('[data-nb-search-lane-editor="exa.search"]')!;
    expect(editor.dataset['nbSearchLaneSource']).toBe('unknown');
    expect(editor.querySelector('[data-nb-search-lane-origin]')!.textContent).toContain('unconfirmed');
    // Nothing local to delete, and no source to restore: neither action is offered.
    expect(editor.querySelector('[data-nb-search-lane-remove]')).toBeNull();
    expect(editor.querySelector('[data-nb-search-lane-restore]')).toBeNull();
  });

  it('treats presets the same way, from both directions', async () => {
    const container = await render('lanes', BASE_CONFIG, { capabilities: CATALOG_WITHOUT_PROJECTION });
    // Reported by the effective catalog only: the origin stays unconfirmed.
    const engineRow = container.querySelector<HTMLElement>('[data-nb-search-preset-row="engine-only"]')!;
    expect(engineRow.dataset['nbSearchPresetOrigin']).toBe('unknown');
    expect(
      engineRow.querySelector<HTMLElement>('[data-nb-search-preset-source-badge]')!.dataset['nbSearchPresetSourceBadge'],
    ).toBe('unknown');

    // Declared on this page: local setting, deletable, no restore.
    await click(container.querySelector('[data-nb-search-preset-add]'));
    const localRow = container.querySelector<HTMLElement>('[data-nb-search-preset-row="preset"]')!;
    expect(localRow.dataset['nbSearchPresetOrigin']).toBe('localUnconfirmed');
    expect(localRow.querySelector<HTMLElement>('[data-nb-search-preset-source-badge]')!.textContent).toContain('local setting');
    await click(container.querySelector('[data-nb-search-preset-open="preset"]'));
    await click(container.querySelector('[data-nb-search-preset-open="preset"]'));
    const editor = container.querySelector<HTMLElement>('[data-nb-search-preset-editor="preset"]')!;
    expect(editor.dataset['nbSearchPresetSource']).toBe('localUnconfirmed');
    expect(editor.querySelector('[data-nb-search-preset-remove]')).not.toBeNull();
    expect(editor.querySelector('[data-nb-search-preset-restore]')).toBeNull();
  });
});

describe('S2 fetch chains', () => {
  const chainOf = (inputKind: string, representation: string) => hosts.draft.advanced?.fetchChains
    .find((chain) => chain.inputKind === inputKind && chain.representation === representation)?.pipelines;

  it('edits each input × output pair without dropping the other pairs', async () => {
    const container = await render('fetch');
    // url → markdown: take the pair over, then drop its second fallback step.
    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    await click(container.querySelectorAll('[data-nb-search-fetch-remove]')[1] ?? null);
    expect(chainOf('url', 'markdown')).toEqual(['direct.fetch']);

    // url → text: a different pair, edited from its own inherited chain.
    await choose(container, 'data-nb-search-fetch-representation', 'text');
    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    await click(container.querySelector('[data-nb-search-fetch-add]'));
    expect(chainOf('url', 'text')).toEqual(['direct.fetch', 'jina.reader']);
    // Switching pairs never rewrote the other one.
    expect(chainOf('url', 'markdown')).toEqual(['direct.fetch']);

    await save(container);
    // The donor replaces the whole chain array, so the body carries every pair;
    // the six untouched ones keep their effective pipelines instead of vanishing.
    const defaults = nbSearchOf()!.defaults!;
    expect(defaults.search_lane).toBe('github.repositories');
    expect(defaults.fetch_chain).toHaveLength(8);
    expect(defaults.fetch_chain![0]).toEqual({ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch'] });
    expect(defaults.fetch_chain![1]).toEqual({ input_kind: 'url', representation: 'text', pipelines: ['direct.fetch', 'jina.reader'] });
    expect(defaults.fetch_chain!.filter((chain) => chain.input_kind === 'file')).toEqual([
      { input_kind: 'file', representation: 'markdown', pipelines: ['direct.local'] },
      { input_kind: 'file', representation: 'text', pipelines: ['direct.local'] },
    ]);
  });

  it('takes one pair back to the source order while the others stay untouched', async () => {
    const container = await render('fetch');
    expect(container.querySelector('[data-nb-search-fetch-restore-all]')).toBeNull();

    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    expect(container.querySelector<HTMLElement>('[data-nb-search-fetch-mode]')!.dataset['nbSearchFetchMode']).toBe('edited');
    expect(container.querySelector('[data-nb-search-fetch-snapshot]')!.textContent).toContain('1 pair uses the Kiki order');

    await click(container.querySelector('[data-nb-search-fetch-restore]'));
    expect(container.querySelector<HTMLElement>('[data-nb-search-fetch-mode]')!.dataset['nbSearchFetchMode']).toBe('source');
    expect(container.querySelector('[data-nb-search-fetch-restore-all]')).toBeNull();
    await save(container);
    // Nothing left to override: the whole defaults domain keeps only the lane.
    expect(nbSearchOf()?.defaults).toEqual({ search_lane: 'github.repositories' });
  });

  it('restores inheritance for every pair only through the all-pairs action', async () => {
    const container = await render('fetch');
    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    await choose(container, 'data-nb-search-fetch-representation', 'text');
    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    expect(container.querySelector('[data-nb-search-fetch-snapshot]')!.textContent).toContain('2 pairs use the Kiki order');

    await save(container);
    // Any per-pair edit saves the whole array as a Kiki snapshot.
    expect(nbSearchOf()!.defaults!.fetch_chain).toHaveLength(8);

    await click(container.querySelector('[data-nb-search-fetch-restore-all]'));
    expect(hosts.draft.advanced?.fetchChains.every((chain) => chain.inherited)).toBe(true);
    await save(container);
    expect(nbSearchOf()!.defaults!.fetch_chain).toBeUndefined();
  });
});

describe('S2 fetch routing', () => {
  /**
   * The page never decides a route itself: it writes the config and reads the
   * server's projection. These cases drive the real editor through the real
   * draft, then run the real `nbSearchConfigPatch` so what is asserted is the
   * body the page would send, plus a re-read of the echo.
   */
  it.each([
    { enabled: false, builtin_enabled: true },
    { enabled: true, builtin_enabled: false },
  ])('keeps inherited switches, coverage, preview and saved values consistent: %j', async (routing) => {
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      inherited_configuration: { ...CAPABILITIES.inherited_configuration!, routing },
      fetch: { ...CAPABILITIES.fetch, routing: { ...CAPABILITIES.fetch.routing!, ...routing } },
    };
    const container = await render('fetch', BASE_CONFIG, { capabilities });
    const builtinSwitch = container.querySelector<HTMLButtonElement>(`[data-nb-search-routing-builtin-switch="${routing.builtin_enabled ? 'on' : 'off'}"]`)!;
    expect(builtinSwitch.getAttribute('aria-pressed')).toBe('true');
    expect(builtinSwitch.disabled).toBe(true);
    expect(container.querySelector('[data-nb-search-routing-enabled]')!.getAttribute('data-nb-search-routing-enabled')).toBe(String(routing.enabled));
    expect(container.querySelector('[data-nb-search-routing-builtin-rule="github-raw-text"]')!.getAttribute('data-nb-search-routing-builtin-rule-active')).toBe('false');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://raw.githubusercontent.com/o/r/main/README.md');
    expect(container.querySelector('[data-nb-search-routing-preview-result="default"]')).not.toBeNull();
    await save(container);
    expect(nbSearchOf()?.fetch?.routing).toBeUndefined();
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await save(container);
    expect(nbSearchOf()?.fetch?.routing).toMatchObject(routing);
  });

  it('inherits omitted custom fields and restores the source instead of the saved effective override', async () => {
    const routing = { enabled: false, builtin_enabled: false, disabled_builtin_rules: ['github-raw-text'], rules: [] };
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      inherited_configuration: { ...CAPABILITIES.inherited_configuration!, routing },
      fetch: { ...CAPABILITIES.fetch, routing: { ...CAPABILITIES.fetch.routing!, ...routing, builtin_enabled: true } },
    };
    const container = await render('fetch', {
      ...BASE_CONFIG,
      fetch: { routing: { builtin_enabled: true } },
    }, { capabilities });
    expect(container.querySelector('[data-nb-search-routing-enabled="false"]')).not.toBeNull();
    expect(container.querySelector('[data-nb-search-routing-builtin-switch="on"]')!.getAttribute('aria-pressed')).toBe('true');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://raw.githubusercontent.com/o/r/main/README.md');
    expect(container.querySelector('[data-nb-search-routing-preview-result="default"]')).not.toBeNull();
    await click(container.querySelector('[data-nb-search-routing-mode-choice="inherited"]'));
    expect(container.querySelector('[data-nb-search-routing-builtin-switch="off"]')!.getAttribute('aria-pressed')).toBe('true');
    await save(container);
    expect(nbSearchOf()?.fetch?.routing).toBeUndefined();
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await save(container);
    expect(nbSearchOf()?.fetch?.routing).toEqual(routing);
  });

  it('clears disabled inherited routing to built-in defaults before and after saving', async () => {
    const routing = { enabled: false, builtin_enabled: false, disabled_builtin_rules: ['github-raw-text'], rules: [] };
    const capabilities: NbSearchCapabilities = {
      ...CAPABILITIES,
      inherited_configuration: { ...CAPABILITIES.inherited_configuration!, routing },
      fetch: { ...CAPABILITIES.fetch, routing: { ...CAPABILITIES.fetch.routing!, ...routing } },
    };
    const container = await render('fetch', {
      ...BASE_CONFIG,
      fetch: { file_scopes: [{ id: 'docs', root: '/srv/docs' }] },
    }, { capabilities });
    await click(container.querySelector('[data-nb-search-routing-mode-choice="cleared"]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://raw.githubusercontent.com/o/r/main/README.md');
    const expectDefaults = () => {
      expect(container.querySelector('[data-nb-search-routing-builtin-switch="on"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('[data-nb-search-routing-builtin-rule="github-raw-text"]')!.getAttribute('data-nb-search-routing-builtin-rule-active')).toBe('true');
      expect(container.querySelector('[data-nb-search-routing-builtin-disabled]')).toBeNull();
      expect(container.querySelector('[data-nb-search-routing-preview-result="builtin"]')!.textContent).toContain('direct.fetch');
    };
    expectDefaults();
    await save(container);
    expect(nbSearchOf()?.fetch).toEqual({ file_scopes: [{ id: 'docs', root: '/srv/docs' }], routing: null });
    expectDefaults();
    await click(container.querySelector('[data-nb-search-routing-mode-choice="inherited"]'));
    expect(container.querySelector('[data-nb-search-routing-builtin-switch="off"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-nb-search-routing-preview-result="default"]')).not.toBeNull();
  });

  it('previews the unsaved fallback chain for both no match and a user default action', async () => {
    const container = await render('fetch');
    await click(container.querySelector('[data-nb-search-fetch-customize]'));
    await click(container.querySelector('[data-nb-search-fetch-remove]'));
    expect(hosts.draft.fetchChain).toEqual(['jina.reader']);
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://example.test/page');
    expect(container.querySelector('[data-nb-search-routing-preview-result="default"]')!.textContent).toContain('jina.reader');
    expect(container.querySelector('[data-nb-search-routing-preview-result="default"]')!.textContent).not.toContain('direct.fetch');
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'keep-default');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://example.test');
    await click(container.querySelector('[data-nb-search-routing-new-save]'));
    await click(container.querySelector('[data-nb-search-routing-rule-action="default"]'));
    expect(container.querySelector('[data-nb-search-routing-preview-result="user"]')!.textContent).toContain('jina.reader');
    expect(container.querySelector('[data-nb-search-routing-preview-result="user"]')!.textContent).not.toContain('direct.fetch');
    await save(container);
    expect(nbSearchOf()?.defaults?.fetch_chain?.find((chain) => chain.input_kind === 'url' && chain.representation === 'markdown')?.pipelines).toEqual(['jina.reader']);
    expect(selectFetchRoute(
      { url: 'https://example.test/page' }, nbSearchOf()?.fetch?.routing ?? undefined, ['jina.reader'],
    )).toMatchObject({ origin: 'user', rule_id: 'keep-default', pipelines: ['jina.reader'] });
  });

  it('shows the maintained package and its coverage before anything is edited', async () => {
    const container = await render('fetch');
    expect(container.querySelector('[data-nb-search-routing-mode="inherited"]')!.textContent).toContain('Following the source');
    // The package id and version come from the server's projection.
    expect(container.querySelector('[data-nb-search-routing-package]')!.textContent).toContain('kiki-common-direct 1');
    // Its rule list is shown, not hidden behind a details block.
    expect(container.querySelector('[data-nb-search-routing-builtin-rule="github-raw-text"]')!.textContent).toContain('direct.fetch');
    expect(container.querySelector<HTMLElement>('[data-nb-search-routing-builtin-rule="github-raw-text"]')!
      .dataset['nbSearchRoutingBuiltinRuleActive']).toBe('true');
    // The builtin switch is not editable while the source is in force.
    expect(container.querySelector<HTMLButtonElement>('[data-nb-search-routing-builtin-switch="off"]')!.disabled).toBe(true);
    // No sentence in this group may ship an unfilled placeholder.
    for (const node of container.querySelectorAll('[data-nb-search-routing-builtin], [data-nb-search-routing-rules]')) {
      expect(node.textContent).not.toContain('{');
    }
  });

  it('numbers the per-rule labels the way the row does', async () => {
    // A configuration that already carries saved rules, so the editor opens on
    // real rows rather than on a rule the test just typed.
    const container = await render('fetch', {
      ...BASE_CONFIG,
      fetch: {
        routing: {
          rules: [
            { id: 'docs-reference', match: { origin: 'https://docs.example.test', path_globs: ['/reference/**'] }, action: { pipelines: ['direct.fetch'] } },
            { id: 'keep-old-chain', match: { origin: 'https://raw.githubusercontent.com', path_globs: ['/fixture/special/**'] }, action: { use: 'default' } },
          ],
        },
      },
    });
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    const rules = container.querySelectorAll('[data-nb-search-routing-rule]');
    expect(rules.length).toBe(2);
    // The second rule's labels name the second rule, not a raw {n}.
    expect(rules[1]!.querySelector('label')!.textContent).toContain('Rule name 2');
    for (const rule of rules) expect(rule.textContent).not.toContain('{');
  });

  it('saves a user rule, keeps file scopes, and reads the rule back', async () => {
    // A config that already carries file scopes, which is the case where a
    // routing-only save could drop them.
    const container = await render('fetch', {
      ...BASE_CONFIG,
      fetch: { file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }] },
    } as unknown as NbSearchConfigPatch);
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'docs-direct');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://docs.example.test');
    await click(container.querySelector('[data-nb-search-routing-new-save]'));

    expect(container.querySelector('[data-nb-search-routing-rule="docs-direct"]')).not.toBeNull();
    await save(container);

    // The routing domain is written whole, and the file scopes the config
    // already had survive a routing-only save.
    expect(nbSearchOf()?.fetch).toEqual({
      file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }],
      routing: { enabled: true, builtin_enabled: true, rules: [{ id: 'docs-direct', match: { origin: 'https://docs.example.test' }, action: { pipelines: ['direct.fetch'] } }] },
    });

    // Re-read of the echoed config keeps the rule, so the next page load shows it.
    expect(hosts.draft.advanced?.routing).toEqual({
      enabled: true,
      builtin_enabled: true,
      rules: [{ id: 'docs-direct', match: { origin: 'https://docs.example.test' }, action: { pipelines: ['direct.fetch'] } }],
    });
    expect(container.querySelector('[data-nb-search-routing-rule="docs-direct"]')).not.toBeNull();
  });

  it('lets a user rule take a request the maintained package would have taken', async () => {
    const container = await render('fetch');
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'raw-elsewhere');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://raw.githubusercontent.com');
    await click(container.querySelector('[data-nb-search-routing-new-save]'));
    // Route the same site the built-in package covers through a different lane.
    await choose(container, 'data-nb-search-routing-pipeline-step', 'jina.reader');
    await save(container);

    expect(nbSearchOf()?.fetch?.routing?.rules).toEqual([
      { id: 'raw-elsewhere', match: { origin: 'https://raw.githubusercontent.com' }, action: { pipelines: ['jina.reader'] } },
    ]);

    // The real standard-package selector, on the saved body: the user rule wins
    // over the built-in one for the same URL, and an explicit pipeline still
    // wins over both. This is the plan the runtime would execute.
    const saved = nbSearchOf()?.fetch?.routing ?? undefined;
    expect(saved).toBeDefined();
    const defaults = ['direct.fetch', 'jina.reader'];
    expect(selectFetchRoute({ url: 'https://raw.githubusercontent.com/o/r/main/README.md', representation: 'markdown', execution: 'sync' }, saved, defaults))
      .toMatchObject({ origin: 'user', rule_id: 'raw-elsewhere', pipelines: ['jina.reader'] });
    expect(selectFetchRoute({ url: 'https://raw.githubusercontent.com/o/r/main/README.md', pipeline: 'jina.reader', representation: 'markdown', execution: 'sync' }, saved, defaults))
      .toMatchObject({ origin: 'explicit', pipelines: ['jina.reader'] });
  });

  it('turns the maintained package off without touching the user rules', async () => {
    const container = await render('fetch');
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'docs-direct');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://docs.example.test');
    await click(container.querySelector('[data-nb-search-routing-new-save]'));
    await click(container.querySelector('[data-nb-search-routing-builtin-switch="off"]'));
    await save(container);

    expect(nbSearchOf()?.fetch?.routing).toMatchObject({ builtin_enabled: false });
    // The user's own rule is untouched by the package switch.
    expect(nbSearchOf()?.fetch?.routing?.rules).toHaveLength(1);
    // And the standard selector agrees: the covered URL now falls to the chain.
    expect(selectFetchRoute(
      { url: 'https://raw.githubusercontent.com/o/r/main/README.md', representation: 'markdown', execution: 'sync' },
      nbSearchOf()?.fetch?.routing ?? undefined,
      ['direct.fetch', 'jina.reader'],
    )).toMatchObject({ origin: 'default' });
  });

  it('clears the inherited rules explicitly and restores them, never touching file scopes', async () => {
    const container = await render('fetch', {
      ...BASE_CONFIG,
      fetch: { file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }] },
    } as unknown as NbSearchConfigPatch);
    await click(container.querySelector('[data-nb-search-routing-mode-choice="cleared"]'));
    // A clear is not a silent "fetching is off": the row says the package
    // still runs, and its rules are still shown in force.
    const mode = container.querySelector('[data-nb-search-routing-mode="cleared"]')!;
    expect(mode.textContent).toContain('Inherited rules cleared');
    expect(mode.nextElementSibling!.textContent).toContain('still runs');
    expect(container.querySelector<HTMLElement>('[data-nb-search-routing-builtin-rule="github-raw-text"]')!
      .dataset['nbSearchRoutingBuiltinRuleActive']).toBe('true');
    await save(container);
    // Routing is cleared, the file scopes the config already had are not.
    expect(nbSearchOf()?.fetch).toEqual({
      file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }],
      routing: null,
    });

    await click(container.querySelector('[data-nb-search-routing-mode-choice="inherited"]'));
    await save(container);
    // Routing is back to inheritance, so it leaves the body. The file scopes
    // the previous save wrote are part of the config now, so they stay: only
    // the field this page stopped declaring is removed.
    expect(nbSearchOf()?.fetch).toEqual({ file_scopes: [{ id: 'docs', root: '/srv/docs', media_types: ['text/plain'] }] });
  });

  it('predicts a route offline without contacting anything', async () => {
    const container = await render('fetch');
    expect(container.querySelector('[data-nb-search-routing-preview-result]')).toBeNull();
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://raw.githubusercontent.com/o/r/main/README.md');
    // The preview is the engine's own selector: builtin rule, direct only.
    const result = container.querySelector<HTMLElement>('[data-nb-search-routing-preview-result]')!;
    expect(result.dataset['nbSearchRoutingPreviewResult']).toBe('builtin');
    expect(result.textContent).toContain('github-raw-text');
    expect(result.textContent).toContain('direct.fetch');

    // A URL no rule covers is predicted to use the chain, and says so.
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-preview-input]')!, 'https://example.test/page');
    expect(container.querySelector<HTMLElement>('[data-nb-search-routing-preview-result]')!.dataset['nbSearchRoutingPreviewResult']).toBe('default');
  });

  it('drops a rule on delete and reports the duplicate name instead of saving it', async () => {
    const container = await render('fetch');
    await click(container.querySelector('[data-nb-search-routing-mode-choice="custom"]'));
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'docs-direct');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://docs.example.test');
    await click(container.querySelector('[data-nb-search-routing-new-save]'));

    // A second rule with the same name is refused with a reason, not a silent no-op.
    await click(container.querySelector('[data-nb-search-routing-add]'));
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-id]')!, 'docs-direct');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-routing-new-origin]')!, 'https://other.example.test');
    expect(container.querySelector('[data-nb-search-routing-new-issue]')!.textContent).toContain('already exists');
    expect(container.querySelector<HTMLButtonElement>('[data-nb-search-routing-new-save]')!.disabled).toBe(true);
    await click(container.querySelector('[data-nb-search-routing-new-cancel]'));

    await click(container.querySelector('[data-nb-search-routing-rule="docs-direct"] [data-nb-search-routing-rule-remove]'));
    expect(container.querySelector('[data-nb-search-routing-rule="docs-direct"]')).toBeNull();
    await save(container);
    expect(nbSearchOf()?.fetch?.routing?.rules).toEqual([]);
  });
});

describe('S2 advanced domains', () => {
  it('clears file scopes explicitly and restores inheritance afterwards', async () => {
    const container = await render('advanced');
    expect(container.querySelector('[data-nb-search-filescope-state="inherit"]')!.textContent).toContain('1 scopes');
    expect(container.querySelector('[data-nb-search-filescope-inherited]')!.textContent).toContain('/srv/docs');

    await click(container.querySelector('[data-nb-search-filescope-clear]'));
    expect(hosts.draft.advanced?.fileScopes).toEqual([]);
    await save(container);
    expect(nbSearchOf()?.fetch).toEqual({ file_scopes: [] });

    await click(container.querySelector('[data-nb-search-filescope-restore]'));
    expect(hosts.draft.advanced?.fileScopes).toBeUndefined();
    await save(container);
    expect(nbSearchOf()?.fetch).toBeUndefined();
  });

  it('writes the quality threshold and an explicit empty marker list', async () => {
    const container = await render('advanced');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-quality-min]')!, '500');
    await click(container.querySelector('[data-nb-search-quality-mode="custom"]'));
    await save(container);
    expect(nbSearchOf()?.execution).toEqual({ fetch: { quality: { min_content_chars: 500, blocked_markers: [] } } });
  });

  it('carries keys it does not render through the replace body', async () => {
    const container = await render('advanced');
    await setInputValue(container.querySelector<HTMLInputElement>('[data-nb-search-quality-min]')!, '500');
    await save(container);
    expect(nbSearchOf()?.home).toBe('/srv/nb-search');
    expect(nbSearchOf()?.log_level).toBe('debug');
    expect(nbSearchOf()?.retention_hours).toBe(48);
  });
});

describe('S2 key status', () => {
  const TEAM_USAGE = {
    provider_instance_id: 'firecrawl.default',
    provider_id: 'firecrawl',
    balance_supported: true,
    keys: [
      { key_index: 1, state: 'ready' as const, usage: { scope: 'team' as const, unit: 'credits' as const, used: null, limit: 500, remaining: 320, checked_at: '2026-10-03T09:00:00Z' } },
      { key_index: 2, state: 'ready' as const, usage: { scope: 'team' as const, unit: 'credits' as const, used: null, limit: 500, remaining: 320, checked_at: '2026-10-03T09:00:00Z' } },
      { key_index: 3, state: 'ready' as const, usage_error: 'unavailable' as const },
    ],
  };

  it('reads nothing until asked, then shows a shared team balance per key without summing it', async () => {
    const readUsage = vi.fn().mockResolvedValue(TEAM_USAGE);
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <I18nProvider>
          <NbSearchKeyUsagePanel instanceId="firecrawl.default" readUsage={readUsage} />
        </I18nProvider>,
      );
    });
    expect(readUsage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-nb-search-key-usage-result]')).toBeNull();

    await click(container.querySelector('[data-nb-search-key-usage-load]'));
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(readUsage).toHaveBeenCalledWith(false);

    // Two keys of one team report the same remaining: each row keeps 320.
    const rows = [...container.querySelectorAll('[data-nb-search-key-usage-keys] > li')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('team quota');
    expect(rows[0]!.textContent).toContain('320');
    expect(rows[1]!.textContent).toContain('320');
    expect(container.textContent).not.toContain('640');
    expect(rows[2]!.textContent).toContain('balance unavailable');

    await click(container.querySelector('[data-nb-search-key-usage-refresh]'));
    expect(readUsage).toHaveBeenLastCalledWith(true);
  });
});

describe('S2 second service instance', () => {
  it('creates an independent binding for a second instance of one provider', async () => {
    const container = await render('instance');
    await click(container.querySelector('[data-nb-search-provider-option="tavily"]'));

    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-instance-id]')!;
    expect(idInput.value).toBe('tavily.custom');
    await click(container.querySelector('summary'));
    const env = container.querySelector<HTMLInputElement>('[data-nb-search-instance-env]');
    expect(env!.value).toBe('NB_SEARCH_TAVILY_CUSTOM_API_KEY');

    await click(container.querySelector('[data-nb-search-instance-create]'));
    expect(hosts.draft.providers['tavily.custom']).toMatchObject({
      providerId: 'tavily',
      credentialSlotId: 'tavily.custom',
      credentialSlotExplicit: true,
      isNew: true,
    });
    expect(hosts.draft.credentialSlots?.['tavily.custom']).toEqual({
      provider_id: 'tavily',
      env: 'NB_SEARCH_TAVILY_CUSTOM_API_KEY',
    });
    // The engine's own tavily.default slot is untouched by the new binding.
    expect(hosts.draft.providers['tavily.default']!.credentialSlotId).toBe('tavily.default');
  });

  it('refuses an instance id the server already reports', async () => {
    const container = await render('instance');
    await click(container.querySelector('[data-nb-search-provider-option="github"]'));
    const idInput = container.querySelector<HTMLInputElement>('[data-nb-search-instance-id]')!;
    await setInputValue(idInput, 'github.default');
    expect(container.querySelector('[data-field-issue]')!.textContent).toContain('already uses this ID');
    expect(container.querySelector<HTMLButtonElement>('[data-nb-search-instance-create]')!.disabled).toBe(true);
  });
});

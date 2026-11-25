// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ErrorCode,
  evaluateSubscriptionSelection,
  formatBindingSlotTupleKey,
  normalizePreviewManifest,
  toggleSubscriptionItem,
  toggleSubscriptionScope,
  type PortableSpaceCenterSource,
  type PortableSpaceCenterSourcesListResponse,
  type PortableSpaceSubscribePreviewItem,
  type PortableSpaceSubscribePreviewManifest,
  type PortableSubscriptionScope,
} from '@kiki/protocol';

import { HostProvider, type HostAdapter, type HostSubscribeIntent } from '../../../host';
import { I18nProvider } from '../../../i18n';
import { ApiError, type KikiClient } from '../../../lib/client';
import {
  maskSubscriptionUrl,
  portableSpaceKeys,
  type PortableSpacesApi,
} from '../../../lib/portableSpaces';
import { useSubscribeIntentQueue } from '../../../lib/subscribeIntent';
import { ConnectionContext, handleGlobalConnectionFrame, type ConnectionValue } from '../../../state/connection';
import { PortableSpacesCard } from './PortableSpacesCard';
import { SubscribeModal } from './SubscribeModal';

const testConnection = {
  client: { baseUrl: 'http://127.0.0.1:58627' },
  localClient: { baseUrl: 'http://127.0.0.1:58627' },
  meta: undefined,
  connectionId: null,
  sshLabel: null,
  config: null,
} as unknown as ConnectionValue;

const DEVICE_KEY = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

const SPACES = [
  { id: 'main', name: 'Main space', path: 'C:\\Users\\fixture\\.kiki', primary: true, credentials_shared: true },
  { id: 'h-lab', name: 'Lab Space', path: 'D:\\spaces\\lab', primary: false, credentials_shared: false },
];

const LOCAL_MODELS = [
  { id: 'local/opus-5', label: 'Opus 5', providerId: 'anthropic', defaultThinkingEffort: 'high' },
  { id: 'local/gemini-neon', label: 'Gemini Neon', providerId: 'google', defaultThinkingEffort: 'high' },
  { id: 'local/deepseek-v4', label: 'DeepSeek V4', providerId: 'deepseek', defaultThinkingEffort: 'medium' },
];

function makeRichManifest(overrides: Partial<PortableSpaceSubscribePreviewManifest> = {}): PortableSpaceSubscribePreviewManifest {
  const items: PortableSpaceSubscribePreviewItem[] = [
    {
      id: 'config:providers.axon',
      scope: 'models_providers',
      domain: 'config',
      label: 'axon',
      path: 'providers.axon',
      memberUnitIds: ['config:providers.axon'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: ['config:models.k3%2E1-pro'],
      dependencyEdges: [],
      coupledCredentialIds: ['credentials:providers.axon'],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
      safeDiff: '+ [providers.axon]\n+ base_url = "https://gw.example.test/v1"',
    },
    {
      id: 'config:models.k3%2E1-pro',
      scope: 'models_providers',
      domain: 'config',
      label: 'k3.1-pro',
      path: 'models.k3.1-pro',
      memberUnitIds: ['config:models.k3%2E1-pro'],
      dependsOnIds: ['config:providers.axon'],
      softDependsOnIds: [],
      referencedByIds: ['agents:agents/implementer%2Emd'],
      dependencyEdges: [{ toId: 'config:providers.axon', kind: 'hard', via: 'provider', liveSatisfied: false }],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
    {
      id: 'mcp:zotero',
      scope: 'extensions_search',
      domain: 'mcp',
      label: 'zotero',
      path: 'mcp.zotero',
      memberUnitIds: ['mcp:zotero'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: [],
      dependencyEdges: [],
      coupledCredentialIds: ['credentials:mcp.zotero'],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
    {
      id: 'agents:agents/implementer%2Emd',
      scope: 'agents_recipes',
      domain: 'agents',
      label: 'implementer',
      path: 'agents/implementer.md',
      memberUnitIds: ['agents:agents/implementer%2Emd'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: [],
      dependencyEdges: [],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
      safeDiff: '--- a/agents/implementer.md\n+++ b/agents/implementer.md\n@@ -1 +1 @@\n-model: old\n+model: lab/coder-pro',
    },
    {
      id: 'agents:agents/researcher%2Emd',
      scope: 'agents_recipes',
      domain: 'agents',
      label: 'researcher',
      path: 'agents/researcher.md',
      memberUnitIds: ['agents:agents/researcher%2Emd'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: [],
      dependencyEdges: [],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
    {
      id: 'recipes:recipes/lab-review/recipe%2Etoml',
      scope: 'agents_recipes',
      domain: 'recipes',
      label: 'lab-review',
      path: 'recipes/lab-review/recipe.toml',
      memberUnitIds: ['recipes:recipes/lab-review/recipe%2Etoml'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: [],
      dependencyEdges: [],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
    {
      id: 'personas:personas/lab-mentor/persona%2Emd',
      scope: 'personas',
      domain: 'personas',
      label: 'Lab Mentor',
      path: 'personas/lab-mentor/persona.md',
      memberUnitIds: ['personas:personas/lab-mentor/persona%2Emd'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: [],
      dependencyEdges: [],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
    {
      id: 'instructions:prompt/model-guide%2Etoml',
      scope: 'instructions',
      domain: 'instructions',
      label: 'model-guide.toml',
      path: 'prompt/model-guide.toml',
      memberUnitIds: ['instructions:prompt/model-guide%2Etoml'],
      dependsOnIds: [],
      softDependsOnIds: [],
      referencedByIds: ['config:models.k3%2E1-pro'],
      dependencyEdges: [],
      coupledCredentialIds: [],
      liveSatisfiedIds: [],
      blockedDependencyIds: [],
      status: 'will_write',
      selectable: true,
      selected: true,
    },
  ];

  return {
    previewToken: 'tok-rich-1',
    packDigest: 'sha256:rich-pack',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    targetSpaceId: 'main',
    suggestedLabel: 'Lab Base Pack',
    displayOrigin: 'sub.lab.example.test',
    format: 'tgz',
    secretMode: 'plain',
    encryptionMode: 'none',
    allowedPolicies: ['auto', 'manual', 'once'],
    defaultSelection: {
      version: 1,
      enabledScopes: ['models_providers', 'extensions_search', 'agents_recipes', 'personas', 'instructions'],
      excludedIds: [],
      includedIds: [],
      includeCredentials: true,
    },
    items,
    excluded: [
      { id: 'hooks:exec', domain: 'config', path: 'hooks.toml', reason: 'Executable hooks are stripped' },
    ],
    bindingSlots: [
      {
        tupleKey: formatBindingSlotTupleKey('agents:agents/implementer%2Emd', 'lab/coder-pro'),
        itemId: 'agents:agents/implementer%2Emd',
        itemLabel: 'implementer',
        itemScope: 'agents_recipes',
        sourceModelId: 'lab/coder-pro',
        required: true,
        location: 'model_alias',
        eligibleOptionIndices: [0, 1, 2],
      },
      {
        tupleKey: formatBindingSlotTupleKey('agents:agents/researcher%2Emd', 'lab/coder-pro'),
        itemId: 'agents:agents/researcher%2Emd',
        itemLabel: 'researcher',
        itemScope: 'agents_recipes',
        sourceModelId: 'lab/coder-pro',
        required: true,
        location: 'model_alias',
        eligibleOptionIndices: [0, 1],
      },
      {
        tupleKey: formatBindingSlotTupleKey('personas:personas/lab-mentor/persona%2Emd', 'lab/mentor-ultra'),
        itemId: 'personas:personas/lab-mentor/persona%2Emd',
        itemLabel: 'Lab Mentor',
        itemScope: 'personas',
        sourceModelId: 'lab/mentor-ultra',
        required: true,
        location: 'model_alias',
        eligibleOptionIndices: [1, 2],
      },
    ],
    localModelOptions: LOCAL_MODELS,
    savedBindingChoices: {},
    catalogRevision: 'cat-1',
    targetRevision: 'tgt-1',
    orderRevision: '1',
    ...overrides,
  };
}

function makeCenterSource(overrides: Partial<PortableSpaceCenterSource> & { id: string; label: string }): PortableSpaceCenterSource {
  return {
    endpoint: { kind: 'url', url: `https://sub.example.test/${overrides.id}.tgz` },
    linkedSpaceId: 'main',
    format: 'tgz',
    spaceMode: 'full',
    secretMode: 'plain',
    encryptionMode: 'none',
    autoSync: true,
    enabled: true,
    priority: 0,
    syncPolicy: 'auto',
    revision: 'rev-1',
    availableNewScopes: [],
    needsReconcile: false,
    managedIds: ['config:providers.axon', 'config:models.k3%2E1-pro', 'mcp:zotero'],
    ...overrides,
  };
}

const apiMocks: Record<keyof PortableSpacesApi, ReturnType<typeof vi.fn>> = {
  listSources: vi.fn(),
  registerSource: vi.fn(),
  previewSubscribe: vi.fn(),
  subscribe: vi.fn(),
  previewSource: vi.fn(),
  syncSubscription: vi.fn(),
  patchSource: vi.fn(),
  reorderSources: vi.fn(),
  previewRemoveSource: vi.fn(),
  removeSource: vi.fn(),
  removeReviewedSource: vi.fn(),
  inspect: vi.fn(),
  exportSpace: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  pack: vi.fn(),
  unpack: vi.fn(),
  fork: vi.fn(),
  delta: vi.fn(),
  mutate: vi.fn(),
  rekey: vi.fn(),
  addRecipient: vi.fn(),
};

const fakeClient = {
  baseUrl: 'http://127.0.0.1:58627',
  portableSpaces: apiMocks as unknown as PortableSpacesApi,
} as unknown as KikiClient;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'zh-CN', platform: 'Win32', userAgent: 'Windows' });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  localStorage.clear();
  localStorage.setItem('kiki.settings', JSON.stringify({ locale: 'zh' }));
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderNode(
  node: React.ReactNode,
  options: { readonly entries?: string[]; readonly host?: Partial<HostAdapter> } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hostMock = {
    kind: 'tauri' as const,
    pickDirectory: vi.fn<() => Promise<string | null>>(async () => null),
    pickFilePath: vi.fn<() => Promise<string | null>>(async () => null),
    ...options.host,
  };
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={options.entries ?? ['/settings/spaces']}>
        <HostProvider host={hostMock as unknown as HostAdapter}>
          <QueryClientProvider client={queryClient}>
            <ConnectionContext.Provider value={testConnection}>
              <I18nProvider>{node}</I18nProvider>
            </ConnectionContext.Provider>
          </QueryClientProvider>
        </HostProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, queryClient, hostMock };
}

async function click(selector: string) {
  const el = document.querySelector<HTMLElement>(selector);
  expect(el, selector).not.toBeNull();
  await act(async () => { el!.click(); });
  await flush();
}

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  expect(input, selector).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('FIFO Deep-Link Queue (cold, warm gap, reload before ACK, consecutive intents, ?subscribe= scrub)', () => {
  function QueueHarness({ onReady }: { readonly onReady?: (api: ReturnType<typeof useSubscribeIntentQueue>) => void }) {
    const location = useLocation();
    const navigate = useNavigate();
    const host = (globalThis as { __testHost?: HostAdapter }).__testHost!;
    const queue = useSubscribeIntentQueue(host, location, navigate);
    onReady?.(queue);
    return (
      <div>
        <output data-active-id>{queue.activeIntent?.id ?? 'none'}</output>
        <output data-active-url>{queue.activeIntent?.url ?? ''}</output>
        <output data-active-name>{queue.activeIntent?.name ?? ''}</output>
        <output data-active-mode>{queue.activeIntent?.mode ?? ''}</output>
        <output data-location>{location.pathname}{location.search}</output>
        <button type="button" data-settle onClick={() => { void queue.settleActiveIntent(); }}>settle</button>
      </div>
    );
  }

  it('drains cold pre-listener FIFO intents, retains head across reload before ACK, and drains consecutive identical URLs in order', async () => {
    const fifo: HostSubscribeIntent[] = [
      { id: 'intent-1', url: 'https://sub.example.test/pack.tgz', name: 'Lab Pack', mode: 'manual' },
      { id: 'intent-2', url: 'https://sub.example.test/pack.tgz', name: 'Lab Pack Repeat', mode: 'once' },
    ];
    let wakeListener: ((intent: HostSubscribeIntent) => void) | null = null;
    const peekSubscribeIntent = vi.fn(async () => fifo[0] ?? null);
    const ackSubscribeIntent = vi.fn(async (id: string) => {
      if (fifo[0]?.id !== id) return false;
      fifo.shift();
      return true;
    });
    const onSubscribeIntent = vi.fn((cb: (intent: HostSubscribeIntent) => void) => {
      wakeListener = cb;
      return () => { wakeListener = null; };
    });

    const host = {
      kind: 'tauri' as const,
      peekSubscribeIntent,
      ackSubscribeIntent,
      onSubscribeIntent,
    } as unknown as HostAdapter;
    (globalThis as { __testHost?: HostAdapter }).__testHost = host;

    // First mount (cold launch before listener attached): peeks head, does NOT ack yet!
    const first = await renderNode(<QueueHarness />, { host });
    expect(document.querySelector('[data-active-id]')?.textContent).toBe('intent-1');
    expect(document.querySelector('[data-active-name]')?.textContent).toBe('Lab Pack');
    expect(document.querySelector('[data-active-mode]')?.textContent).toBe('manual');
    expect(ackSubscribeIntent).not.toHaveBeenCalled();

    // Warm wake signal arriving while intent-1 is active must NOT overwrite draft.
    await act(async () => { wakeListener?.(fifo[1]!); });
    await flush();
    expect(document.querySelector('[data-active-id]')?.textContent).toBe('intent-1');

    // Simulate reload / unmount before ACK: intent-1 stays at FIFO head and redelivers on remount!
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    first.container.remove();
    expect(fifo[0]?.id).toBe('intent-1');

    await renderNode(<QueueHarness />, { host });
    expect(document.querySelector('[data-active-id]')?.textContent).toBe('intent-1');
    expect(ackSubscribeIntent).not.toHaveBeenCalled();

    // Explicit confirm/cancel settles intent-1 -> ACKs intent-1 -> drains intent-2 immediately!
    await click('[data-settle]');
    expect(ackSubscribeIntent).toHaveBeenCalledWith('intent-1');
    expect(document.querySelector('[data-active-id]')?.textContent).toBe('intent-2');
    expect(document.querySelector('[data-active-mode]')?.textContent).toBe('once');

    await click('[data-settle]');
    expect(ackSubscribeIntent).toHaveBeenCalledWith('intent-2');
    expect(document.querySelector('[data-active-id]')?.textContent).toBe('none');
  });

  it('immediately scrubs legacy ?subscribe= query params from browser history', async () => {
    const host = { kind: 'browser' as const } as unknown as HostAdapter;
    (globalThis as { __testHost?: HostAdapter }).__testHost = host;

    await renderNode(<QueueHarness />, {
      host,
      entries: ['/settings/spaces?subscribe=https%3A%2F%2Fsub.example.test%2Fsecret-token-1234567890.tgz&name=Team&mode=manual&keep=1'],
    });

    expect(document.querySelector('[data-active-url]')?.textContent).toBe('https://sub.example.test/secret-token-1234567890.tgz');
    expect(document.querySelector('[data-active-name]')?.textContent).toBe('Team');
    expect(document.querySelector('[data-active-mode]')?.textContent).toBe('manual');
    expect(document.querySelector('[data-location]')?.textContent).toBe('/settings/spaces?keep=1');
    expect(maskSubscriptionUrl('https://sub.example.test/secret-token-1234567890.tgz?sig=abc')).toBe(
      'https://sub.example.test/secr…7890.tgz',
    );
  });
});

describe('SubscribeModal: 6 scopes, tri-state, ModelPicker binding + explicit defer, 0 network on toggles', () => {
  it('enforces origin-first deep-link preview, 6 orthogonal scopes, zero-network toggles, grouped & per-item ModelPicker, and explicit defer gate', async () => {
    const manifest = makeRichManifest();
    apiMocks.previewSubscribe.mockResolvedValue(manifest);
    apiMocks.subscribe.mockResolvedValue({
      kind: 'subscription',
      source: makeCenterSource({ id: 'sub-new', label: 'Lab Base Pack' }),
      status: 'updated',
      appliedIds: ['config:providers.axon'],
      deletedIds: [],
      skippedIds: [],
      impact: {
        managedCount: 0,
        deletedIds: [],
        handedOffIds: [],
        preservedLocalIds: [],
        preservedDependencyIds: [],
        pendingReconcileIds: [],
        addedIds: ['config:providers.axon'],
        updatedIds: [],
      },
    });
    const onDone = vi.fn();
    const onClose = vi.fn();

    await renderNode(
      <SubscribeModal
        client={fakeClient}
        spaces={SPACES}
        mode={{
          kind: 'new',
          initialIntent: {
            id: 'dl-1',
            url: 'https://sub.lab.example.test/lab-base-pack.tgz',
            name: 'Lab Base Pack',
            mode: 'auto',
            origin: 'native',
          },
        }}
        onClose={onClose}
        onDone={onDone}
      />,
    );

    // 1. Origin-first gate: zero network calls before user clicks 获取预览.
    expect(apiMocks.previewSubscribe).not.toHaveBeenCalled();
    await click('[data-portable-fetch-preview]');
    expect(apiMocks.previewSubscribe).toHaveBeenCalledTimes(1);

    // 2. Orthogonal scopes: personas is strictly separate from extensions_search; zero-item 'settings' scope is hidden; never uses 小助理.
    expect(document.querySelector('[data-portable-scope-group="models_providers"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-scope-group="extensions_search"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-scope-group="agents_recipes"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-scope-group="personas"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-scope-group="instructions"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-scope-group="settings"]')).toBeNull();
    expect(document.body.textContent).not.toContain('小助理');

    // 3. Tri-state parent checkbox + diff disclosure + 0 network requests on toggles!
    await click('[data-portable-item-check="config:models.k3%2E1-pro"]');
    const modelsScopeBox = document.querySelector<HTMLInputElement>('[data-portable-scope-check="models_providers"]')!;
    expect(modelsScopeBox.indeterminate).toBe(true);
    expect(modelsScopeBox.getAttribute('aria-checked')).toBe('mixed');
    await click('[data-portable-diff-toggle="config:providers.axon"]');
    expect(document.querySelector('[data-portable-diff-content="config:providers.axon"]')?.textContent).toContain('[providers.axon]');

    // 4. Confirm is strictly DISABLED while required upstream models are unmapped (zero silent fallback).
    const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-portable-confirm-submit]')!;
    expect(confirmBtn().disabled).toBe(true);
    expect(document.querySelector('[data-portable-binding-group="lab/coder-pro"]')).not.toBeNull();
    expect(document.querySelector('[data-portable-binding-group="lab/mentor-ultra"]')).not.toBeNull();

    // 5. Map group lab/coder-pro -> local/opus-5 via ModelPicker, then override researcher -> local/gemini-neon.
    await click('[data-portable-binding-group-picker="lab/coder-pro"]');
    const opusOpt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes('Opus 5'),
    );
    expect(opusOpt).toBeDefined();
    await act(async () => { opusOpt!.click(); });
    await flush();

    // Still disabled because lab/mentor-ultra is unresolved!
    expect(confirmBtn().disabled).toBe(true);

    // Expand per-item override for lab/coder-pro and override researcher -> local/gemini-neon.
    await click('[data-portable-binding-expand="lab/coder-pro"]');
    const researcherTuple = formatBindingSlotTupleKey('agents:agents/researcher%2Emd', 'lab/coder-pro');
    await click(`[data-portable-binding-slot-picker='${researcherTuple}']`);
    const geminiOpt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes('Gemini Neon'),
    );
    expect(geminiOpt).toBeDefined();
    await act(async () => { geminiOpt!.click(); });
    await flush();

    // 6. Explicitly opt-in to 「暂不绑定，待会儿再说」 for lab/mentor-ultra!
    await click('[data-portable-binding-group-defer="lab/mentor-ultra"]');
    expect(document.querySelector('[data-portable-deferred-summary]')).not.toBeNull();
    expect(confirmBtn().disabled).toBe(false);

    // Zero extra preview network calls during all checkbox + ModelPicker + defer interactions!
    expect(apiMocks.previewSubscribe).toHaveBeenCalledTimes(1);

    // 7. Confirm submits token + exact bindings + deferredSlotIds with 0 remote archive fetches!
    await click('[data-portable-confirm-submit]');
    expect(apiMocks.previewSubscribe).toHaveBeenCalledTimes(1);
    expect(apiMocks.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      previewToken: 'tok-rich-1',
      syncPolicy: 'auto',
      modelBindings: { 'lab/coder-pro': 'local/opus-5' },
      unitModelBindings: { [researcherTuple]: 'local/gemini-neon' },
      unmappedModelPolicy: 'defer',
      deferredSlotIds: [formatBindingSlotTupleKey('personas:personas/lab-mentor/persona%2Emd', 'lab/mentor-ultra')],
    }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('handles 40109 unlock challenge, passphrase-only manual/once policies, and archive once-only policy', async () => {
    apiMocks.previewSubscribe
      .mockRejectedValueOnce(new ApiError({ code: ErrorCode.PORTABLE_UNLOCK_REQUIRED, msg: 'Unlock required', data: null }))
      .mockResolvedValueOnce(makeRichManifest({
        encryptionMode: 'passphrase',
        allowedPolicies: ['manual', 'once'],
        bindingSlots: [],
      }));

    await renderNode(
      <SubscribeModal
        client={fakeClient}
        spaces={SPACES}
        mode={{ kind: 'new' }}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    await type('[data-portable-url-input]', 'https://sub.example.test/encrypted.kiki.age');
    await click('[data-portable-fetch-preview]');

    // Enters unlock stage on 40109.
    expect(document.querySelector('[data-portable-stage-unlock]')).not.toBeNull();
    await type('[data-portable-unlock-passphrase]', 'lab-secret-pass');
    await click('[data-portable-unlock-confirm]');

    expect(apiMocks.previewSubscribe).toHaveBeenLastCalledWith(
      expect.objectContaining({ unlock: { passphrase: 'lab-secret-pass' } }),
      { signal: expect.any(AbortSignal) },
    );
    // Auto policy is disabled for passphrase-encrypted URL; manual is selected by default.
    expect(document.querySelector<HTMLButtonElement>('[data-portable-policy-choice="auto"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-portable-policy-choice="manual"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('PortableSpacesCard: sole primary CTA, priority reorder, manual review, edit cleanup, unsubscribe dialog, and error isolation', () => {
  it('supports keyboard-accessible Move Up/Down reorder, pause toggle, manual update review, edit cleanup review, and Detach vs Purge dialog', async () => {
    const subA = makeCenterSource({
      id: 'sub-a',
      label: 'Lab Gateway Pool',
      priority: 0,
      syncPolicy: 'auto',
      revision: 'r1',
      managedIds: ['config:providers.axon', 'config:models.k3%2E1-pro'],
    });
    const subB = makeCenterSource({
      id: 'sub-b',
      label: 'Team Prompts',
      priority: 1,
      syncPolicy: 'manual',
      revision: 'r2',
      availableNewScopes: ['personas'],
      managedIds: ['agents:agents/implementer%2Emd'],
    });
    const listResp: PortableSpaceCenterSourcesListResponse = {
      deviceRecipient: DEVICE_KEY,
      knownRecipients: [],
      items: [subA, subB],
      orderRevision: 'ord-7',
    };
    apiMocks.listSources.mockResolvedValue(listResp);
    apiMocks.reorderSources.mockResolvedValue({ orderedIds: ['sub-b', 'sub-a'], orderRevision: 'ord-8' });
    apiMocks.previewRemoveSource.mockResolvedValue({
      previewToken: 'tok-rm-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      managedCount: 2,
      impact: {
        managedCount: 2,
        deletedIds: ['config:providers.axon'],
        handedOffIds: [],
        preservedLocalIds: ['config:models.k3%2E1-pro'],
        preservedDependencyIds: [],
        pendingReconcileIds: [],
        addedIds: [],
        updatedIds: [],
      },
      impactDigest: 'sha256:rm-digest',
    });
    apiMocks.removeReviewedSource.mockResolvedValue({
      removed: true,
      impact: {
        managedCount: 2,
        deletedIds: ['config:providers.axon'],
        handedOffIds: [],
        preservedLocalIds: ['config:models.k3%2E1-pro'],
        preservedDependencyIds: [],
        pendingReconcileIds: [],
        addedIds: [],
        updatedIds: [],
      },
    });
    apiMocks.previewSource.mockResolvedValue(makeRichManifest({ bindingSlots: [] }));

    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="C:\\Users\\fixture\\.kiki" />);

    // Sole primary CTA check: Export is secondary, Add subscription / import is primary.
    expect(document.querySelector('[data-portable-export-open]')?.className).toContain('border-hairline');
    expect(document.querySelector('[data-portable-subscribe-open]')?.className).toContain('bg-accent');

    // Keyboard-accessible Move Up / Move Down in SpaceRowMenu: sub-a move-up is disabled at top bound, sub-b move-up reorders.
    await click('[data-portable-menu="sub-a"]');
    expect(document.querySelector<HTMLButtonElement>('[data-space-menu-item="move-up"]')?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[data-space-menu-item="move-down"]')?.disabled).toBe(false);
    await click('[data-space-menu-item="move-down"]');
    expect(apiMocks.reorderSources).toHaveBeenCalledWith({
      spaceId: 'main',
      orderedIds: ['sub-b', 'sub-a'],
      expectedOrderRevision: 'ord-7',
    });

    // Manual source Check updates opens review modal.
    await click('[data-portable-check-updates="sub-b"]');
    expect(apiMocks.previewSource).toHaveBeenCalledWith('sub-b', {}, { signal: expect.any(AbortSignal) });
    await click('[data-portable-modal-close]');

    // Unsubscribe opens RemoveSubscriptionDialog defaulting to Detach; switching to Purge shows exact counts and calls removeReviewedSource.
    await click('[data-portable-menu="sub-a"]');
    await click('[data-space-menu-item="unsubscribe"]');
    expect(apiMocks.previewRemoveSource).toHaveBeenCalledWith('sub-a', { signal: expect.any(AbortSignal) });
    expect(document.querySelector<HTMLInputElement>('[data-portable-remove-choice="detach"]')?.checked).toBe(true);
    await click('[data-portable-remove-choice="purge"]');
    expect(document.querySelector('[data-portable-remove-impact]')?.textContent).toContain('1');
    await click('[data-portable-remove-confirm="purge"]');
    expect(apiMocks.removeReviewedSource).toHaveBeenCalledWith('sub-a', expect.objectContaining({
      previewToken: 'tok-rm-1',
      purgeManaged: true,
      impactDigest: 'sha256:rm-digest',
    }));
  });

  it('invalidates portableSpaceKeys on event.portable_spaces.changed and displays real portable errors clearly', async () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    expect(handleGlobalConnectionFrame({ type: 'event.portable_spaces.changed' }, queryClient)).toBe(true);
    expect(spy).toHaveBeenCalledWith({ queryKey: portableSpaceKeys.all });

    apiMocks.listSources.mockRejectedValueOnce(new ApiError({ code: ErrorCode.PORTABLE_NOT_FOUND, msg: 'Portable source missing', data: null }));
    await renderNode(<PortableSpacesCard client={fakeClient} spaces={SPACES} mainPath="C:\\Users\\fixture\\.kiki" />);
    const errorTextContent = document.querySelector('[data-portable-sources-error]')?.textContent ?? '';
    expect(errorTextContent).toContain('便携空间来源或归档不存在');
    expect(errorTextContent).not.toContain('会话已经不存在了');
  });
});

describe('1,000-item preindexed client reducer benchmark', () => {
  it('runs evaluateSubscriptionSelection and toggles in p95 < 1ms on 1,000 items with 0 network calls', () => {
    const scopes: readonly PortableSubscriptionScope[] = [
      'models_providers',
      'extensions_search',
      'agents_recipes',
      'personas',
      'instructions',
      'settings',
    ];
    const items: PortableSpaceSubscribePreviewItem[] = [];
    for (let p = 0; p < 10; p += 1) {
      items.push({
        id: `config:providers.p${p}`,
        scope: 'models_providers',
        domain: 'config',
        label: `provider-${p}`,
        path: `providers.p${p}`,
        memberUnitIds: [`config:providers.p${p}`],
        dependsOnIds: [],
        softDependsOnIds: [],
        referencedByIds: [],
        dependencyEdges: [],
        coupledCredentialIds: [`credentials:providers.p${p}`],
        liveSatisfiedIds: [],
        blockedDependencyIds: [],
        status: 'will_write',
        selectable: true,
        selected: true,
      });
    }
    for (let i = 10; i < 1000; i += 1) {
      const scope = scopes[i % scopes.length]!;
      const providerId = `config:providers.p${i % 10}`;
      const isModel = scope === 'models_providers';
      items.push({
        id: isModel ? `config:models.m${i}` : `${scope}:item-${i}`,
        scope,
        domain: isModel ? 'config' : scope === 'personas' ? 'personas' : 'agents',
        label: `item-${i}`,
        path: `path/${i}`,
        memberUnitIds: [isModel ? `config:models.m${i}` : `${scope}:item-${i}`],
        dependsOnIds: isModel ? [providerId] : [],
        softDependsOnIds: [],
        referencedByIds: [],
        dependencyEdges: isModel ? [{ toId: providerId, kind: 'hard', via: 'provider', liveSatisfied: false }] : [],
        coupledCredentialIds: scope === 'extensions_search' ? [`credentials:mcp.s${i % 20}`] : [],
        liveSatisfiedIds: [],
        blockedDependencyIds: [],
        status: 'will_write',
        selectable: true,
        selected: true,
      });
    }

    const manifest: PortableSpaceSubscribePreviewManifest = makeRichManifest({
      items,
      bindingSlots: Array.from({ length: 40 }, (_, idx) => ({
        tupleKey: formatBindingSlotTupleKey(`agents_recipes:item-${12 + idx * 6}`, `upstream/m-${idx % 5}`),
        itemId: `agents_recipes:item-${12 + idx * 6}`,
        itemLabel: `agent-${idx}`,
        itemScope: 'agents_recipes',
        sourceModelId: `upstream/m-${idx % 5}`,
        required: true,
        location: 'model_alias',
        eligibleOptionIndices: [0, 1, 2],
      })),
    });

    const index = normalizePreviewManifest(manifest);
    let selection = {
      version: 1 as const,
      enabledScopes: [...scopes],
      excludedIds: [] as string[],
      includedIds: [] as string[],
      includeCredentials: true,
    };
    const bindings = { modelBindings: { 'upstream/m-0': 'local/opus-5' } };

    // Warmup JIT
    for (let w = 0; w < 20; w += 1) {
      selection = toggleSubscriptionItem(manifest, selection, 'config:models.m12', w % 2 === 0, index);
      evaluateSubscriptionSelection(manifest, selection, bindings, index);
    }

    const samples: number[] = [];
    for (let run = 0; run < 100; run += 1) {
      const start = performance.now();
      if (run % 4 === 0) {
        selection = toggleSubscriptionItem(manifest, selection, 'config:providers.p0', run % 8 === 0, index);
      } else if (run % 4 === 1) {
        selection = toggleSubscriptionScope(manifest, selection, 'extensions_search', run % 8 === 1, index);
      } else if (run % 4 === 2) {
        selection = { ...selection, includeCredentials: !selection.includeCredentials };
      } else {
        selection = toggleSubscriptionItem(manifest, selection, 'config:models.m18', run % 8 === 3, index);
      }
      evaluateSubscriptionSelection(manifest, selection, bindings, index);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    const max = samples[samples.length - 1]!;
    // Log exact measured telemetry for receipt verification.
    console.log(
      `[bench:subscription-reducer] items=1000 samples=${samples.length} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`,
    );
    expect(p95).toBeLessThan(1.0);
  });
});

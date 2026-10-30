// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { DecisionConnectionsCard } from './DecisionConnections';
import { DecisionJudgeRows } from './DecisionSources';
import { optionLabels, pickOption } from './testControls';

const { client, navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
  client: {
    getConfig: vi.fn(), patchConfig: vi.fn(), listModels: vi.fn(), listProviders: vi.fn(), listOAuthMethods: vi.fn(),
    getMemoryAdvisorSettings: vi.fn(), patchMemoryAdvisorSettings: vi.fn(),
    createProvider: vi.fn(), updateProvider: vi.fn(), getProviderEntity: vi.fn(), deleteProviderEntity: vi.fn(),
    revealSecret: vi.fn(), probeDecisionSource: vi.fn(),
  },
}));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../dirtyGuard', () => ({ useDirtyReporter: vi.fn(), useGuardedNavigate: () => navigate }));

const JEV = { id: 'typesafe', type: 'system_one', service: 'decision', decision_protocol: 'system_one', base_url: 'https://api.typesafe.ai/v1',
  default_model: 'jev-latest', api_key_env: 'TYPESAFE_API_KEY', has_api_key: true, status: 'connected' };
const RERANK = { id: 'rerank', type: 'pair_score', service: 'decision', decision_protocol: 'pair_score', base_url: 'https://rerank.example.test/v1',
  default_model: 'gliclass-small', has_api_key: true, status: 'connected' };
const CHAT = { id: 'openai', type: 'openai', base_url: 'https://api.example.test/v1', has_api_key: true, status: 'connected' };

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const byText = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;

beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  client.getConfig.mockResolvedValue({ permission: { reviewer: { backend: 'model', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: false } } });
  client.listModels.mockResolvedValue({ items: [{ id: 'cheap-judge', provider_id: 'openai', remote_id: 'cheap-judge-1', max_context_size: 128000 }] });
  client.listProviders.mockResolvedValue({ items: [CHAT, JEV, RERANK] });
  client.listOAuthMethods.mockResolvedValue([]);
  client.getProviderEntity.mockImplementation(async (id: string) => ({ ...[CHAT, JEV, RERANK].find((item) => item.id === id), id, revision: 'r0' }));
  client.getMemoryAdvisorSettings.mockResolvedValue({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true,
    advisor: { mode: 'off' }, advisor_status: { state: 'off', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 } });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });

async function render(node: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queries}><I18nProvider>{node}</I18nProvider></QueryClientProvider></MemoryRouter>));
  await settle();
}

describe('Who decides', () => {
  it('offers decision services and chat models; the reviewer cannot pick a rerank service', async () => {
    await render(<DecisionJudgeRows />);
    const labels = await optionLabels(container.querySelector('#st-decision-reviewer')!);
    expect(labels.some((label) => label.startsWith('typesafe'))).toBe(true);
    expect(labels.some((label) => label.includes('cheap-judge') || label.includes('Cheap'))).toBe(true);
    const trigger = container.querySelector<HTMLButtonElement>('#st-decision-reviewer')!;
    await act(async () => trigger.click());
    const rerank = [...document.querySelectorAll<HTMLElement>('[data-select-panel] [role="option"]')].find((row) => row.textContent?.includes('rerank'))!;
    expect(rerank.getAttribute('aria-disabled')).toBe('true');
    expect(rerank.textContent).toContain('Ranking only, not for approvals');
    await act(async () => trigger.click());
  });

  it('saves one consumer\'s source alone and never turns the advisor on', async () => {
    client.patchMemoryAdvisorSettings.mockImplementation(async (patch: { advisor: Record<string, unknown> }) => ({
      enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true, advisor: { mode: 'off', ...patch.advisor },
      advisor_status: { state: 'off', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 },
    }));
    await render(<DecisionJudgeRows />);
    await pickOption(container.querySelector('#st-decision-memory')!, 'typesafe');
    await settle();
    expect(client.patchMemoryAdvisorSettings).toHaveBeenCalledWith({ advisor: { source: { kind: 'connection', connection: 'typesafe' } } }, undefined);
    expect(client.patchConfig).not.toHaveBeenCalled();
    // A named model for the same connection is its own small save.
    const model = container.querySelector<HTMLInputElement>('#st-decision-memory-model')!;
    expect(model.placeholder).toBe('Default: jev-latest');
    await type(model, 'jev-fast');
    await act(async () => byText('Save model name').click());
    await settle();
    expect(client.patchMemoryAdvisorSettings).toHaveBeenLastCalledWith({ advisor: { source: { kind: 'connection', connection: 'typesafe', model: 'jev-fast' } } }, undefined);
  });

  it('clears a source with null and keeps the row usable after a failed save', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { backend: 'model', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: false,
      source: { kind: 'model', model: 'cheap-judge' } } } });
    client.patchConfig.mockRejectedValueOnce(new Error('config is read-only'));
    await render(<DecisionJudgeRows />);
    await pickOption(container.querySelector('#st-decision-reviewer')!, 'Not set');
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: { source: null } } });
    expect(container.textContent).toContain('Could not save: config is read-only');
    expect(container.querySelector<HTMLButtonElement>('#st-decision-reviewer')!.disabled).toBe(false);
  });

  it('keeps a typed model name with its connection: switching asks first and never carries it over', async () => {
    const SECOND = { ...JEV, id: 'typesafe-b' };
    client.listProviders.mockResolvedValue({ items: [CHAT, JEV, SECOND, RERANK] });
    let advisor: Record<string, unknown> = { mode: 'off', source: { kind: 'connection', connection: 'typesafe' } };
    const reply = () => ({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true, advisor,
      advisor_status: { state: 'off', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 } });
    client.getMemoryAdvisorSettings.mockImplementation(async () => reply());
    client.patchMemoryAdvisorSettings.mockImplementation(async (patch: { advisor: Record<string, unknown> }) => { advisor = { ...advisor, ...patch.advisor }; return reply(); });
    await render(<DecisionJudgeRows />);
    const model = () => container.querySelector<HTMLInputElement>('#st-decision-memory-model')!;
    await type(model(), 'jev-fast');
    // Cancel keeps the draft and the source.
    await pickOption(container.querySelector('#st-decision-memory')!, 'typesafe-b');
    expect(document.body.textContent).toContain('Picking another source discards it.');
    await act(async () => byText('Keep editing').click());
    expect(client.patchMemoryAdvisorSettings).not.toHaveBeenCalled();
    expect(model().value).toBe('jev-fast');
    // Discarding switches, and the other connection starts from its own (empty) saved name.
    await pickOption(container.querySelector('#st-decision-memory')!, 'typesafe-b');
    await act(async () => byText('Discard and switch').click());
    await settle();
    expect(client.patchMemoryAdvisorSettings).toHaveBeenLastCalledWith({ advisor: { source: { kind: 'connection', connection: 'typesafe-b' } } }, undefined);
    expect(model().value).toBe('');
    expect(container.querySelector('[data-decision-judge="memory"]')!.textContent).not.toContain('Unsaved changes');
  });

  it('clears an older reviewer setting with source:null even though no source is saved', async () => {
    let reviewer: Record<string, unknown> = { backend: 'jev', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: true, apiKeySource: 'kiki' };
    client.getConfig.mockImplementation(async () => ({ permission: { reviewer } }));
    client.patchConfig.mockImplementation(async () => { reviewer = { ...reviewer, backend: 'model' }; return { permission: { reviewer } }; });
    await render(<DecisionJudgeRows />);
    expect(container.querySelector('[data-decision-judge="reviewer"]')!.textContent).toContain('Using the older Jev key on the Reviewer card.');
    await pickOption(container.querySelector('#st-decision-reviewer')!, 'Not set');
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: { source: null } } });
    // The echo is what the server saved: the older Jev setting is gone.
    expect(container.querySelector('[data-decision-judge="reviewer"]')!.textContent).toContain('Not set. Reviews ask you.');
  });

  it('clears an older advisor model setting along with the source', async () => {
    let advisor: Record<string, unknown> = { mode: 'rank', selector: { protocol: 'chat_json', model: 'cheap-judge' } };
    const reply = () => ({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true, advisor,
      advisor_status: { state: 'ready', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 } });
    client.getMemoryAdvisorSettings.mockImplementation(async () => reply());
    client.patchMemoryAdvisorSettings.mockImplementation(async (patch: { advisor: Record<string, unknown> }) => {
      const next = { ...advisor };
      for (const [key, value] of Object.entries(patch.advisor)) { if (value === null) delete next[key]; else next[key] = value; }
      advisor = next;
      return reply();
    });
    await render(<DecisionJudgeRows />);
    expect(container.querySelector('[data-decision-judge="memory"]')!.textContent).toContain('Still using the source saved in the older settings: cheap-judge.');
    await pickOption(container.querySelector('#st-decision-memory')!, 'Not set');
    await settle();
    expect(client.patchMemoryAdvisorSettings).toHaveBeenCalledWith({ advisor: { source: null, selector: null } }, undefined);
    expect(container.querySelector('[data-decision-judge="memory"]')!.textContent).toContain('Not set. Memory uses keyword matches.');
    expect(container.textContent).not.toContain('cheap-judge.');
  });

  it('does not call a source missing while the connection list is still loading', async () => {
    let finish: (value: unknown) => void = () => {};
    client.getConfig.mockResolvedValue({ permission: { reviewer: { backend: 'model', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: false,
      source: { kind: 'connection', connection: 'typesafe' } } } });
    client.listProviders.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(<DecisionJudgeRows />);
    const trigger = () => container.querySelector('#st-decision-reviewer')!.textContent ?? '';
    expect(trigger()).not.toContain('(missing)');
    expect(container.querySelector('[data-decision-judge="reviewer"]')!.getAttribute('data-decision-problem')).toBeNull();
    await act(async () => { finish({ items: [CHAT, RERANK] }); });
    await settle();
    // Loaded, and the saved typesafe connection is not among them.
    expect(trigger()).toContain('typesafe (missing)');
  });

  it('names a deleted connection and links to adding one', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { backend: 'model', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: false,
      source: { kind: 'connection', connection: 'gone' }, source_status: { state: 'unconfigured', connection: 'gone' } } } });
    await render(<DecisionJudgeRows />);
    const row = container.querySelector('[data-decision-judge="reviewer"]')!;
    expect(row.getAttribute('data-decision-problem')).toBe('missing_connection');
    expect(row.textContent).toContain('This connection no longer exists.');
    // The trigger itself says the pick is gone, not just the open menu.
    expect(container.querySelector('#st-decision-reviewer')!.textContent).toContain('gone (missing)');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-decision-fix]')!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/ai?tab=providers#decision-connection-add');
  });

  it('points a missing key at its connection', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { backend: 'model', allowThreshold: 0.9, denyThreshold: 0.9, categories: [], hasApiKey: false,
      source: { kind: 'connection', connection: 'typesafe' }, source_status: { state: 'auth', connection: 'typesafe', credential_source: 'none' } } } });
    await render(<DecisionJudgeRows />);
    const row = container.querySelector('[data-decision-judge="reviewer"]')!;
    expect(row.getAttribute('data-decision-problem')).toBe('auth');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-decision-fix]')!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/ai?tab=providers&decision=typesafe#st-card-decision-connections');
  });
});

describe('decision connections', () => {
  const onChanged = vi.fn(async () => {});

  it('adds Jev without a key: the server variable is named, never copied', async () => {
    client.createProvider.mockResolvedValue({ ...JEV, id: 'typesafe-2', revision: 'r1' });
    await render(<DecisionConnectionsCard providers={[]} configuredIds={new Set(['typesafe'])} onChanged={onChanged} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-add]')!.click());
    expect(container.querySelector<HTMLInputElement>('[data-decision-id]')!.value).toBe('typesafe-2');
    expect(container.textContent).toContain('Leave empty to use TYPESAFE_API_KEY from the server environment.');
    expect(container.querySelector('[data-decision-new]')!.textContent).not.toContain('Context');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-create]')!.click());
    await settle();
    expect(client.createProvider).toHaveBeenCalledWith({
      id: 'typesafe-2', type: 'system_one', base_url: 'https://api.typesafe.ai/v1', api_key: undefined,
      api_key_env: 'TYPESAFE_API_KEY', default_model: 'jev-latest', decision_endpoint: undefined,
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('adds a rerank service with any address and model, and keeps its endpoint on that origin', async () => {
    await render(<DecisionConnectionsCard providers={[]} configuredIds={new Set()} onChanged={onChanged} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-add]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-preset="pair_score"]')!.click());
    await type(container.querySelector<HTMLInputElement>('[data-decision-base-url]')!, 'https://rerank.example.test/v1');
    await type(container.querySelector<HTMLInputElement>('[data-decision-model]')!, 'gliclass-small');
    const endpoint = container.querySelector<HTMLInputElement>('[data-decision-endpoint]')!;
    await type(endpoint, 'https://other.example.test/score');
    expect(container.querySelector('[data-decision-endpoint-issue]')?.getAttribute('data-decision-endpoint-issue')).toBe('origin');
    expect(container.querySelector<HTMLButtonElement>('[data-decision-create]')!.disabled).toBe(true);
    await type(endpoint, '/v2/score');
    expect(container.querySelector('[data-decision-endpoint-issue]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-create]')!.click());
    await settle();
    expect(client.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rerank', type: 'pair_score', base_url: 'https://rerank.example.test/v1', default_model: 'gliclass-small', decision_endpoint: '/v2/score', api_key_env: undefined,
    }));
  });

  it('tests a saved connection against its own destination with sample data only', async () => {
    client.probeDecisionSource.mockResolvedValue({ ok: false, reason: 'timeout', duration_ms: 3000, status: { state: 'ready' } });
    await render(<DecisionConnectionsCard providers={[JEV] as never} configuredIds={new Set(['typesafe'])} onChanged={onChanged} />);
    const row = container.querySelector<HTMLDetailsElement>('[data-decision-row="typesafe"]')!;
    expect(row.textContent).toContain('Jev · TypeSafe');
    expect(row.textContent).toContain('From environment variable TYPESAFE_API_KEY');
    // The default row shows the button only, not the internal `<id>@<origin>` key.
    expect(row.querySelector('[data-decision-test-result]')?.textContent).toBe('');
    expect(row.textContent).not.toContain('typesafe@https://api.typesafe.ai');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-decision-test-button]')!.click());
    await settle();
    expect(client.probeDecisionSource).toHaveBeenCalledWith({ kind: 'connection', connection: 'typesafe' }, 'typesafe@https://api.typesafe.ai');
    expect(row.textContent).toContain('Test failed: The service did not answer in time.');
    expect(row.getAttribute('data-decision-health')).toBe('error');
  });

  it('saves a changed model name with the connection revision', async () => {
    client.getProviderEntity.mockResolvedValue({ ...JEV, revision: 'r7' });
    client.updateProvider.mockResolvedValue({ ...JEV, revision: 'r8' });
    await render(<DecisionConnectionsCard providers={[JEV] as never} configuredIds={new Set(['typesafe'])} onChanged={onChanged} />);
    await type(container.querySelector<HTMLInputElement>('[data-decision-row="typesafe"] [data-decision-model]')!, 'jev-next');
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenCalledWith('typesafe', {
      base_revision: 'r7', base_url: undefined, default_model: 'jev-next', decision_endpoint: undefined, api_key_env: undefined, api_key: undefined,
    });
  });
  it('reads the key line from the listing: a named variable first, missing only when it is not set', async () => {
    const UNSET = { ...JEV, id: 'jev-unset', has_api_key: false, status: 'unconfigured' };
    await render(<DecisionConnectionsCard providers={[JEV, UNSET] as never} configuredIds={new Set(['typesafe', 'jev-unset'])} onChanged={onChanged} />);
    const set = container.querySelector('[data-decision-row="typesafe"]')!;
    expect(set.querySelector('[data-secret-source]')?.getAttribute('data-secret-source')).toBe('environment');
    expect(set.getAttribute('data-decision-health')).toBe('ok');
    const unset = container.querySelector('[data-decision-row="jev-unset"]')!;
    expect(unset.querySelector('[data-secret-source]')?.getAttribute('data-secret-source')).toBe('environment');
    expect(unset.getAttribute('data-decision-health')).toBe('setup');
    expect(unset.textContent).toContain('TYPESAFE_API_KEY is not set on the server');
    // A variable that is not set is still a destination the test can try.
    expect(unset.querySelector('[data-decision-test-button]')).not.toBeNull();
  });

  it('lets a keyless or custom-header service be tested; an auth failure comes from the service', async () => {
    const OPEN = { id: 'local-judge', type: 'system_one', service: 'decision', decision_protocol: 'system_one', base_url: 'http://127.0.0.1:9000/v1',
      default_model: 'judge', has_api_key: false, status: 'unconfigured', custom_header_keys: ['X-Api-Token'] };
    client.probeDecisionSource.mockResolvedValue({ ok: false, reason: 'auth', duration_ms: 12, status: { state: 'ready' } });
    await render(<DecisionConnectionsCard providers={[OPEN] as never} configuredIds={new Set(['local-judge'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="local-judge"]')!;
    expect(row.getAttribute('data-decision-health')).toBe('ok');
    expect(row.textContent).not.toContain('Needs a key');
    expect(row.textContent).toContain('No key. Fine for services that need none or read a custom header.');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-decision-test-button]')!.click());
    await settle();
    expect(client.probeDecisionSource).toHaveBeenCalledWith({ kind: 'connection', connection: 'local-judge' }, 'local-judge@http://127.0.0.1:9000');
    expect(row.querySelector('[data-decision-status]')?.textContent).toContain('The service rejected the key.');
  });

  it('sets, changes and clears the key variable on any connection without copying a key', async () => {
    client.getProviderEntity.mockResolvedValue({ ...RERANK, revision: 'r1' });
    client.updateProvider.mockResolvedValue({ ...RERANK, api_key_env: 'RERANK_KEY', revision: 'r2' });
    await render(<DecisionConnectionsCard providers={[RERANK] as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="rerank"]')!;
    const env = row.querySelector<HTMLInputElement>('[data-decision-key-env]')!;
    await type(env, '1BAD');
    expect(row.textContent).toContain('Use letters, digits and "_", not starting with a digit.');
    await type(env, 'RERANK_KEY');
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenLastCalledWith('rerank', expect.objectContaining({ base_revision: 'r1', api_key_env: 'RERANK_KEY', api_key: undefined }));
    // Clearing the name writes null; the stored key is left alone.
    await type(row.querySelector<HTMLInputElement>('[data-decision-key-env]')!, '');
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenLastCalledWith('rerank', expect.objectContaining({ base_revision: 'r2', api_key_env: null, api_key: undefined }));
  });

  it('drops a revealed key after a save that replaces it', async () => {
    client.getProviderEntity.mockResolvedValue({ ...RERANK, revision: 'r1' });
    client.updateProvider.mockResolvedValue({ ...RERANK, revision: 'r1' });
    client.revealSecret.mockResolvedValueOnce({ value: 'old-key-value' }).mockResolvedValueOnce({ value: 'new-key-value' });
    await render(<DecisionConnectionsCard providers={[RERANK] as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="rerank"]')!;
    const field = () => row.querySelector<HTMLInputElement>('[data-secret-field] input')!;
    await act(async () => row.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click());
    await settle();
    expect(field().value).toBe('old-key-value');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-secret-edit]')!.click());
    await type(field(), 'new-key-value');
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenLastCalledWith('rerank', expect.objectContaining({ api_key: 'new-key-value' }));
    // Same listing, same revision: the old copy is still gone.
    expect(field().value).not.toBe('old-key-value');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.click());
    await settle();
    expect(field().value).toBe('new-key-value');
    expect(client.revealSecret).toHaveBeenCalledTimes(2);
  });

  it('refuses a base URL with a user name or password', async () => {
    await render(<DecisionConnectionsCard providers={[]} configuredIds={new Set()} onChanged={onChanged} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-add]')!.click());
    await type(container.querySelector<HTMLInputElement>('[data-decision-base-url]')!, 'https://user:pass@api.example.test/v1');
    expect(container.textContent).toContain('Remove the user name or password from the URL.');
    expect(container.querySelector<HTMLButtonElement>('[data-decision-create]')!.disabled).toBe(true);
  });

  it('keeps an edit against the revision it was made on, so another save of the address is not undone', async () => {
    client.getProviderEntity.mockResolvedValue({ ...RERANK, revision: 'r1' });
    client.updateProvider.mockResolvedValue({ ...RERANK, default_model: 'gliclass-large', base_url: 'https://moved.example.test/v1', revision: 'r3' });
    const view = (providers: unknown[]) => <DecisionConnectionsCard providers={providers as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />;
    await render(view([RERANK]));
    const row = () => container.querySelector('[data-decision-row="rerank"]')!;
    await type(row().querySelector<HTMLInputElement>('[data-decision-model]')!, 'gliclass-large');
    // Someone else moves the address; the list refreshes under the open draft.
    await render(view([{ ...RERANK, base_url: 'https://moved.example.test/v1' }]));
    expect(row().querySelector<HTMLInputElement>('[data-decision-model]')!.value).toBe('gliclass-large');
    await act(async () => byText('Save service').click());
    await settle();
    // Only the touched field is written, against the revision the edit started from.
    expect(client.updateProvider).toHaveBeenCalledWith('rerank', {
      base_revision: 'r1', base_url: undefined, default_model: 'gliclass-large', decision_endpoint: undefined, api_key_env: undefined, api_key: undefined,
    });
  });

  it('takes the address and revision from one entity read: a newer save is shown, never paired with the old list row', async () => {
    // The list still holds the old address; the entity read already has the newer save.
    client.getProviderEntity.mockResolvedValue({ ...RERANK, base_url: 'https://moved.example.test/v1', revision: 'r2' });
    client.updateProvider.mockResolvedValue({ ...RERANK, base_url: 'https://moved.example.test/v1', default_model: 'gliclass-large', revision: 'r3' });
    await render(<DecisionConnectionsCard providers={[RERANK] as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="rerank"]')!;
    expect(row.querySelector<HTMLInputElement>('[data-decision-base-url]')!.value).toBe('https://moved.example.test/v1');
    expect(row.querySelector('[data-decision-conflict]')).toBeNull();
    await type(row.querySelector<HTMLInputElement>('[data-decision-model]')!, 'gliclass-large');
    await act(async () => byText('Save service').click());
    await settle();
    // Only the model is written; the newer address is not sent back as an edit.
    expect(client.updateProvider).toHaveBeenCalledWith('rerank', {
      base_revision: 'r2', base_url: undefined, default_model: 'gliclass-large', decision_endpoint: undefined, api_key_env: undefined, api_key: undefined,
    });
  });

  it('when a late entity read finds a newer value for the field being edited, keeps the draft and shows the clash instead of saving over it', async () => {
    let answer: (value: unknown) => void = () => {};
    client.getProviderEntity.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    client.updateProvider.mockResolvedValue({ ...RERANK, base_url: 'https://mine.example.test/v1', revision: 'r3' });
    await render(<DecisionConnectionsCard providers={[RERANK] as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="rerank"]')!;
    const base = () => row.querySelector<HTMLInputElement>('[data-decision-base-url]')!;
    // The list shows the old address; the person edits it while the read is still out.
    await type(base(), 'https://mine.example.test/v1');
    await act(async () => { answer({ ...RERANK, base_url: 'https://moved.example.test/v1', revision: 'r2' }); });
    await settle();
    expect(base().value).toBe('https://mine.example.test/v1');
    expect(row.querySelector('[data-decision-conflict]')?.getAttribute('data-decision-conflict')).toBe('baseUrl');
    expect(row.textContent).toContain('the saved one was https://moved.example.test/v1');
    expect(client.updateProvider).not.toHaveBeenCalled();
    // Saving after seeing the clash is the person's choice, against the revision they now see.
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenCalledWith('rerank', expect.objectContaining({ base_revision: 'r2', base_url: 'https://mine.example.test/v1' }));
  });

  it('on a revision conflict keeps the draft, takes the newer address and shows a same-field clash', async () => {
    client.getProviderEntity.mockResolvedValueOnce({ ...RERANK, revision: 'r1' })
      .mockResolvedValueOnce({ ...RERANK, base_url: 'https://moved.example.test/v1', default_model: 'gliclass-medium', revision: 'r2' });
    client.updateProvider.mockRejectedValueOnce(Object.assign(new Error('revision conflict'), { code: 40941 }))
      .mockResolvedValueOnce({ ...RERANK, base_url: 'https://moved.example.test/v1', default_model: 'gliclass-large', revision: 'r3' });
    await render(<DecisionConnectionsCard providers={[RERANK] as never} configuredIds={new Set(['rerank'])} onChanged={onChanged} />);
    const row = container.querySelector('[data-decision-row="rerank"]')!;
    await type(row.querySelector<HTMLInputElement>('[data-decision-model]')!, 'gliclass-large');
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenCalledTimes(1);
    expect(row.querySelector<HTMLInputElement>('[data-decision-model]')!.value).toBe('gliclass-large');
    expect(row.querySelector<HTMLInputElement>('[data-decision-base-url]')!.value).toBe('https://moved.example.test/v1');
    expect(row.querySelector('[data-decision-conflict]')?.getAttribute('data-decision-conflict')).toBe('defaultModel');
    expect(row.textContent).toContain('the saved one was gliclass-medium');
    // Saving again is the person's call, against the new revision.
    await act(async () => byText('Save service').click());
    await settle();
    expect(client.updateProvider).toHaveBeenLastCalledWith('rerank', expect.objectContaining({ base_revision: 'r2', base_url: undefined, default_model: 'gliclass-large' }));
  });
});

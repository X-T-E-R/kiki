// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { DecisionJudgeRows } from './DecisionSources';
import { ReviewerSettings } from './ReviewerSettings';

const { client } = vi.hoisted(() => ({ client: { getConfig: vi.fn(), listModels: vi.fn(), listProviders: vi.fn(), patchConfig: vi.fn(), revealSecret: vi.fn(), moveReviewerKey: vi.fn(), getMemoryAdvisorSettings: vi.fn(), patchMemoryAdvisorSettings: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../dirtyGuard', () => ({ useDirtyReporter: vi.fn(), useGuardedNavigate: () => navigate }));
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.textContent?.trim() === label)!;
beforeEach(() => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
  client.getConfig.mockResolvedValue({ permission: {} });
  client.listModels.mockResolvedValue({ items: [{ id: 'test-model', provider_id: 'test', display_name: 'Test model' }] });
  client.listProviders.mockResolvedValue({ items: [] });
  client.getMemoryAdvisorSettings.mockResolvedValue({ enabled: true, approval: 'auto', budget: 2000, workspaces: {}, effective_enabled: true,
    advisor: { mode: 'off' }, advisor_status: { state: 'off', consent_required: false, logical_calls: 0, requests: 0, retries: 0, displaced_ids: [], unjudged_count: 0 } });
  client.patchConfig.mockImplementation(async (patch: { permission: { reviewer: Record<string, unknown> } }) => ({ permission: { reviewer: {
    backend: patch.permission.reviewer['backend'], model: patch.permission.reviewer['model'],
    timeoutMs: patch.permission.reviewer['timeout_ms'],
    allowThreshold: patch.permission.reviewer['allow_threshold'],
    denyThreshold: patch.permission.reviewer['deny_threshold'],
    categories: patch.permission.reviewer['categories'],
    hasApiKey: typeof patch.permission.reviewer['api_key'] === 'string',
    apiKeySource: typeof patch.permission.reviewer['api_key'] === 'string' ? 'kiki' : 'none',
  } } }));
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  // The reviewer card shows the source; the decision-models rows (Models &
  // providers) are where an older key is moved, so both render together.
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queries}><I18nProvider>
    <ReviewerSettings />
    <DecisionJudgeRows />
  </I18nProvider></QueryClientProvider></MemoryRouter>));
  await settle();
}

const TUNING = { timeoutMs: 8000, allowThreshold: 0.9, denyThreshold: 0.9, categories: ['policy_compliance'] };

describe('permission reviewer settings', () => {
  it('saves only tuning: the source, backend and key are never written from this card', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      ...TUNING, backend: 'model', hasApiKey: false, source: { kind: 'connection', connection: 'typesafe' },
      source_status: { state: 'ready', connection: 'typesafe', model: 'jev-latest', protocol: 'system_one' },
    } } });
    client.listProviders.mockResolvedValue({ items: [{ id: 'typesafe', type: 'system_one', service: 'decision', default_model: 'jev-latest', has_api_key: false, status: 'connected' }] });
    await render();
    expect(container.querySelector('#reviewer-model')).toBeNull();
    expect(container.querySelector('#reviewer-api-key')).toBeNull();
    expect(container.querySelector('[data-decision-summary-value]')?.textContent).toBe('typesafe · jev-latest');
    await change(container.querySelector<HTMLInputElement>('input[type="number"]')!, '5000');
    await act(async () => button('Save').click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ permission: { reviewer: {
      timeout_ms: 5000, allow_threshold: 0.9, deny_threshold: 0.9, categories: ['policy_compliance'],
    } } });
  });

  it('links the read-only source to Decision models', async () => {
    await render();
    expect(container.querySelector('[data-decision-summary-value]')?.textContent).toBe('Not chosen');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-decision-change]')!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/ai?tab=providers#st-card-decision-connections');
  });

  it('echoes an older Jev key and moves it on the server into a free connection ID', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki' } } });
    client.listProviders.mockResolvedValue({ items: [{ id: 'typesafe', type: 'openai', has_api_key: true, status: 'connected' }] });
    client.moveReviewerKey.mockImplementation(async () => {
      // The server has moved the key and pointed the reviewer at the new connection.
      client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: false, apiKeySource: 'none',
        source: { kind: 'connection', connection: 'typesafe-2' }, source_status: { state: 'ready', connection: 'typesafe-2', model: 'jev-latest', protocol: 'system_one' } } } });
      return { connection: 'typesafe-2', state: 'complete', retryable: false };
    });
    await render();
    expect(container.querySelector('[data-decision-summary-value]')?.textContent).toBe('Jev · TypeSafe');
    expect(container.querySelector('[data-reviewer-legacy]')?.getAttribute('data-reviewer-legacy')).toBe('key');
    // The id the suggestion would collide with is skipped.
    expect(container.querySelector<HTMLInputElement>('[data-reviewer-move-id]')!.value).toBe('typesafe-2');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-move-key]')!.click());
    await settle();
    expect(client.moveReviewerKey).toHaveBeenCalledWith('typesafe-2');
    expect(client.revealSecret).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Moved. The reviewer now uses typesafe-2.');
    // The refreshed config is what the card shows: the new source, no key left to move.
    expect(container.querySelector('[data-decision-summary-value]')?.textContent).toBe('typesafe-2');
    expect(container.querySelector('[data-reviewer-legacy]')).toBeNull();
  });

  it('refuses a taken ID before sending', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki' } } });
    client.listProviders.mockResolvedValue({ items: [{ id: 'mine', type: 'openai', has_api_key: true, status: 'connected' }] });
    await render();
    await change(container.querySelector<HTMLInputElement>('[data-reviewer-move-id]')!, 'mine');
    expect(container.textContent).toContain('A connection with this ID already exists.');
    expect(container.querySelector<HTMLButtonElement>('[data-reviewer-move-key]')!.disabled).toBe(true);
  });

  it('after a partial move re-reads settings, offers the same ID or a new one, and never retries on its own', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki' } } });
    client.moveReviewerKey.mockResolvedValueOnce({ connection: 'typesafe', state: 'connection_saved', retryable: true });
    await render();
    const reads = client.getConfig.mock.calls.length;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-move-key]')!.click());
    await settle();
    expect(client.moveReviewerKey).toHaveBeenCalledTimes(1);
    expect(client.getConfig.mock.calls.length).toBeGreaterThan(reads);
    expect(container.querySelector('[data-reviewer-move]')?.getAttribute('data-reviewer-move')).toBe('connection_saved');
    expect(container.textContent).toContain('check it, then move again with the ID shown or a new one');
    // The half-made connection now exists, yet its own ID stays allowed.
    client.listProviders.mockResolvedValue({ items: [{ id: 'typesafe', type: 'system_one', has_api_key: true, status: 'connected' }] });
    await settle();
    expect(button('Retry').disabled).toBe(false);
    await change(container.querySelector<HTMLInputElement>('[data-reviewer-move-id]')!, 'typesafe-new');
    client.moveReviewerKey.mockResolvedValueOnce({ connection: 'typesafe-new', state: 'complete', retryable: false });
    await act(async () => button('Retry').click());
    await settle();
    expect(client.moveReviewerKey).toHaveBeenLastCalledWith('typesafe-new');
    expect(client.moveReviewerKey).toHaveBeenCalledTimes(2);
  });

  it('keeps the move after source_switched re-reads a new source while the old key is still saved, and finishes it', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki' } } });
    client.moveReviewerKey.mockImplementationOnce(async () => {
      client.listProviders.mockResolvedValue({ items: [{ id: 'typesafe', type: 'system_one', service: 'decision', has_api_key: true, status: 'connected' }] });
      client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki',
        source: { kind: 'connection', connection: 'typesafe' }, source_status: { state: 'ready', connection: 'typesafe', model: 'jev-latest', protocol: 'system_one' } } } });
      return { connection: 'typesafe', state: 'source_switched', retryable: true };
    });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-move-key]')!.click());
    await settle();
    // The refreshed source is shown, and the leftover key keeps its way out.
    expect(container.querySelector('[data-decision-summary-value]')?.textContent).toBe('typesafe');
    expect(container.querySelector('[data-reviewer-legacy]')?.getAttribute('data-reviewer-legacy')).toBe('key');
    expect(container.textContent).toContain('An older TypeSafe key is still saved in the reviewer settings.');
    expect(container.textContent).not.toContain('still uses its own TypeSafe key');
    expect(container.querySelector<HTMLInputElement>('[data-reviewer-move-id]')!.value).toBe('typesafe');
    client.moveReviewerKey.mockImplementationOnce(async () => {
      client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: false, apiKeySource: 'none',
        source: { kind: 'connection', connection: 'typesafe' }, source_status: { state: 'ready', connection: 'typesafe', model: 'jev-latest', protocol: 'system_one' } } } });
      return { connection: 'typesafe', state: 'complete', retryable: false };
    });
    await act(async () => button('Retry').click());
    await settle();
    expect(client.moveReviewerKey).toHaveBeenLastCalledWith('typesafe');
    expect(container.querySelector('[data-reviewer-legacy]')).toBeNull();
    expect(container.textContent).toContain('Moved. The reviewer now uses typesafe.');
  });

  it('after a reload still offers to move a key left behind, next to whatever source is saved now', async () => {
    // A newer source was saved meanwhile (a chat model), yet the old key is still kept.
    client.getConfig.mockResolvedValue({ permission: { reviewer: { ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'kiki',
      source: { kind: 'model', model: 'test/test-model' }, source_status: { state: 'ready', model: 'test-model', protocol: 'chat_json' } } } });
    client.listProviders.mockResolvedValue({ items: [{ id: 'typesafe', type: 'system_one', service: 'decision', has_api_key: true, status: 'connected' }] });
    await render();
    expect(container.querySelector('[data-reviewer-legacy]')?.getAttribute('data-reviewer-legacy')).toBe('key');
    expect(container.textContent).toContain('An older TypeSafe key is still saved in the reviewer settings.');
    // The card does not claim the old key, or the connection, is the one in use.
    expect(container.textContent).not.toContain('still uses its own TypeSafe key');
    expect(container.textContent).not.toContain('now uses');
    // The source is not a connection, so a free ID is suggested, never the taken one.
    expect(container.querySelector<HTMLInputElement>('[data-reviewer-move-id]')!.value).toBe('typesafe-2');
    expect(client.moveReviewerKey).not.toHaveBeenCalled();
  });

  it('for an environment key offers a Jev connection instead of a key field', async () => {
    client.getConfig.mockResolvedValue({ permission: { reviewer: {
      ...TUNING, backend: 'jev', hasApiKey: true, apiKeySource: 'environment', apiKeyEnv: 'TYPESAFE_API_KEY',
    } } });
    await render();
    expect(container.textContent).toContain('Jev reads TYPESAFE_API_KEY from the server.');
    expect(container.querySelector('[data-reviewer-move-key]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-reviewer-add-jev]')!.click());
    expect(navigate).toHaveBeenCalledWith('/settings/ai?tab=providers#decision-connection-add');
  });

  it('discards tuning changes without writing', async () => {
    await render();
    await change(container.querySelector<HTMLInputElement>('input[type="number"]')!, '6000');
    await act(async () => button('Discard changes').click());
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('8000');
    expect(client.patchConfig).not.toHaveBeenCalled();
  });
});

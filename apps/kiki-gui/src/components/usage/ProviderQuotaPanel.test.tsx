// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerQuotaSnapshotSchema, type OAuthFlowSnapshot, type ProviderQuotaMeter, type ProviderQuotaSnapshot, type ProviderQuotaSource } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { ProviderQuotaPanel } from './ProviderQuotaPanel';

const mockUseProviderQuotas = vi.fn();
vi.mock('../../lib/providerQuota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/providerQuota')>()),
  useProviderQuotas: () => mockUseProviderQuotas(),
}));
const client = {
  listOAuthMethods: vi.fn(), startOAuthLogin: vi.fn(), getOAuthStatus: vi.fn(), cancelOAuthLogin: vi.fn(),
};
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
const refreshSource = vi.fn();
const setSourceEnabled = vi.fn();
const refetch = vi.fn();
const disposals: Array<() => void> = [];
const pending: OAuthFlowSnapshot = {
  flow_id: 'flow-1', provider: 'managed:openai-codex', status: 'pending',
  verification_uri: 'https://auth.example.test/device', verification_uri_complete: 'https://auth.example.test/device?code=TEST',
  user_code: 'TEST-1234', expires_in: 900, interval: 60, expires_at: '2099-01-01T00:00:00Z',
};
function meter(patch: Partial<ProviderQuotaMeter> = {}): ProviderQuotaMeter {
  return { id: 'm1', label: 'Balance', unit: 'money', unit_label: 'USD', currency: 'USD', used: null, limit: null, remaining: null, scope: 'account', ...patch };
}
function source(patch: Partial<ProviderQuotaSource> = {}): ProviderQuotaSource {
  return { id: 'account-1', label: 'Example account', kind: 'provider', provider_id: 'example', account_label: 'person@example.test',
    enabled: true, supported: true, status: 'ready', refreshing: false, refresh_mode: 'explicit',
    auth: { action: 'provider_settings', provider: 'example' }, source: { label: 'Official API', url: 'https://api.example.test/usage' }, meters: [], ...patch };
}
function show(sources: ProviderQuotaSource[], stale = false) {
  const snapshot: ProviderQuotaSnapshot = { schema_version: '1', generated_at: '2026-10-10T12:00:00Z', sources };
  expect(providerQuotaSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  mockUseProviderQuotas.mockReturnValue({ snapshot, loading: false, isError: false, stale, refetch, isRefetching: false,
    refreshSource, setSourceEnabled, refreshingSourceId: undefined });
}
function Location() { const location = useLocation(); return <output data-location>{location.pathname}{location.hash}</output>; }
async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={query}><MemoryRouter initialEntries={['/usage?panel=quota']}><I18nProvider><ProviderQuotaPanel /><Location /></I18nProvider></MemoryRouter></QueryClientProvider>); });
  disposals.push(() => { root.unmount(); query.clear(); container.remove(); });
  return container;
}
async function click(container: Element, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector)!;
  expect(button).not.toBeNull();
  await act(async () => { button.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.setItem('kiki.locale', 'en');
  refreshSource.mockResolvedValue(undefined); setSourceEnabled.mockResolvedValue(undefined);
  client.listOAuthMethods.mockResolvedValue([{ id: 'openai-codex', provider: 'managed:openai-codex', label: 'ChatGPT' }]);
  client.startOAuthLogin.mockResolvedValue(pending);
  client.getOAuthStatus.mockResolvedValue(pending);
  client.cancelOAuthLogin.mockImplementation(async () => { client.getOAuthStatus.mockResolvedValue({ ...pending, status: 'cancelled' }); return { cancelled: true, status: 'cancelled' }; });
});
afterEach(() => { for (const dispose of disposals.splice(0)) act(dispose); });

describe('ProviderQuotaPanel', () => {
  it('renders truthful empty and stale states without requesting credentials', async () => {
    show([], true); const container = await mount();
    expect(container.querySelector('[data-quota-empty]')?.textContent).toContain('No quota information available');
    expect(container.querySelector('[data-quota-stale]')).not.toBeNull();
    expect(client.startOAuthLogin).not.toHaveBeenCalled();
    expect(client.listOAuthMethods).not.toHaveBeenCalled();
  });
  it('preserves independent accounts, real zero, units, windows and partial meter failures', async () => {
    show([source({ meters: [
      meter({ id: 'zero', remaining: 0 }),
      meter({ id: 'tokens', label: 'Rolling tokens', unit: 'tokens', unit_label: 'tokens', currency: undefined, used: 24500, limit: 100000, window: { label: '5h', duration_seconds: 18000, reset_at: '2026-10-10T15:00:00Z' } }),
      meter({ id: 'requests', unit: 'requests', unit_label: 'requests', used: 0, limit: 500, window: { label: '1d' } }),
      meter({ id: 'credits', unit: 'credits', unit_label: 'credits', remaining: 500, scope: 'team' }),
      meter({ id: 'percent', unit: 'percent', unit_label: '%', used: 0, limit: 100, remaining: 100 }),
      meter({ id: 'count', unit: 'count', unit_label: 'calls', remaining: 2 }),
      meter({ id: 'failed-key', status: 'error', message: 'Key usage unavailable' }),
    ] }), source({ id: 'account-2', account_label: 'other@example.test', status: 'stale', meters: [meter({ remaining: 42.5 })] })]);
    const container = await mount();
    expect(container.querySelectorAll('[data-quota-item]')).toHaveLength(2);
    const first = container.querySelector('[data-quota-item="account-1"]')!;
    expect(first.textContent).toContain('0.00 USD'); expect(first.textContent).not.toContain('42.50 USD');
    expect(first.querySelector('[data-quota-meter="tokens"]')?.textContent).toContain('24500/100000 · 25% tokens');
    expect(first.querySelector('[data-quota-meter="tokens"]')?.textContent).toContain('5h');
    expect(first.querySelector('[data-quota-meter="requests"]')?.textContent).toContain('0/500 · 0% requests');
    expect(first.querySelector('[data-quota-meter="credits"]')?.textContent).toContain('500 credits');
    expect(first.querySelector('[data-quota-meter="credits"]')?.textContent).toContain('Team');
    expect(first.querySelector('[data-quota-meter="percent"]')?.textContent).toContain('0%');
    expect(first.querySelector('[data-quota-meter="count"]')?.textContent).toContain('2 calls');
    expect(first.querySelector('[data-quota-meter="failed-key"] [data-meter-status="error"]')).not.toBeNull();
    expect(first.querySelector('[data-quota-meter="failed-key"]')?.textContent).toContain('Unknown');
    expect(first.querySelector('[data-quota-meter="zero"] [data-quota-progress]')).toBeNull();
    expect(container.querySelector('[data-quota-item="account-2"] [data-meter-status="stale"]')).not.toBeNull();
  });
  it('refreshes just the clicked source, toggles collection, and reports a failed action', async () => {
    show([source(), source({ id: 'off', enabled: false, status: 'off' })]);
    const container = await mount();
    expect(refreshSource).not.toHaveBeenCalled();
    await click(container, '[data-quota-source-refresh="account-1"]');
    expect(refreshSource).toHaveBeenCalledExactlyOnceWith('account-1');
    expect(container.querySelector('[data-quota-source-refresh="off"]')).toBeNull();
    await click(container, '[data-quota-item="account-1"] input[type="checkbox"]');
    expect(setSourceEnabled).toHaveBeenCalledExactlyOnceWith('account-1', false);
    refreshSource.mockRejectedValueOnce(new Error('offline'));
    await click(container, '[data-quota-source-refresh="account-1"]');
    expect(container.textContent).toContain('offline');
    await click(container, '[data-quota-refresh-button]');
    expect(refreshSource).toHaveBeenLastCalledWith('account-1');
    expect(refreshSource).not.toHaveBeenCalledWith('off');
  });
  it('header refresh calls refreshSource for enabled supported sources respecting cooldown and keeping errors on the card', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    show([
      source({ id: 'src-ready', enabled: true, supported: true }),
      source({ id: 'src-locked', enabled: true, supported: true, refresh_after: future }),
      source({ id: 'src-off', enabled: false, supported: true }),
      source({ id: 'src-unsupported', enabled: true, supported: false }),
    ]);
    refreshSource.mockRejectedValueOnce(new Error('upstream quota unavailable'));
    const container = await mount();
    await click(container, '[data-quota-refresh-button]');
    expect(refreshSource).toHaveBeenCalledExactlyOnceWith('src-ready');
    expect(refreshSource).not.toHaveBeenCalledWith('src-locked');
    expect(refreshSource).not.toHaveBeenCalledWith('src-off');
    expect(refreshSource).not.toHaveBeenCalledWith('src-unsupported');
    const failedCard = container.querySelector('[data-quota-item="src-ready"]')!;
    expect(failedCard.textContent).toContain('upstream quota unavailable');
  });
  it('header refresh falls back to refetch when no source is eligible to refresh', async () => {
    show([]);
    const container = await mount();
    await click(container, '[data-quota-refresh-button]');
    expect(refetch).toHaveBeenCalledOnce();
    expect(refreshSource).not.toHaveBeenCalled();
  });
  it('starts the real method only on click, shows the returned device flow and can cancel it', async () => {
    show([source({ status: 'auth_required', auth: { action: 'oauth_login', provider: 'managed:openai-codex' } })]);
    const container = await mount();
    expect(client.startOAuthLogin).not.toHaveBeenCalled();
    await click(container, '[data-quota-auth-action]');
    expect(client.startOAuthLogin).toHaveBeenCalledExactlyOnceWith({ provider: 'openai-codex' });
    expect(container.textContent).toContain('TEST-1234');
    expect(container.querySelector('[data-location]')?.textContent).toBe('/usage');
    expect(refreshSource).not.toHaveBeenCalled();
    await click(container, '[data-oauth-cancel]');
    expect(client.cancelOAuthLogin).toHaveBeenCalledExactlyOnceWith({ provider: 'managed:openai-codex' });
    expect(container.querySelector('[data-oauth-terminal="cancelled"]')).not.toBeNull();
  });
  it('keeps a failed login visible and retryable without navigation or quota refresh', async () => {
    show([source({ status: 'auth_required', auth: { action: 'oauth_login', provider: 'openai-codex' } })]);
    client.startOAuthLogin.mockRejectedValueOnce(new Error('Login unavailable'));
    const container = await mount(); await click(container, '[data-quota-auth-action]');
    expect(container.textContent).toContain('Login unavailable');
    expect(container.querySelector('[data-location]')?.textContent).toBe('/usage');
    expect(refreshSource).not.toHaveBeenCalled();
    await click(container, '[data-quota-auth-action]'); expect(container.textContent).toContain('TEST-1234');
  });
  it.each([
    ['provider_settings', '/settings/ai#st-card-providers'],
    ['external_service_settings', '/settings/search#st-card-search-providers'],
    ['executor_login', '/settings/ai#st-card-engines'],
  ] as const)('routes %s recovery to its actual settings surface', async (action, target) => {
    show([source({ status: 'auth_required', auth: { action, provider: 'example' } })]);
    const container = await mount(); await click(container, '[data-quota-auth-action]');
    expect(container.querySelector('[data-location]')?.textContent).toBe(target);
    expect(client.startOAuthLogin).not.toHaveBeenCalled();
  });
});

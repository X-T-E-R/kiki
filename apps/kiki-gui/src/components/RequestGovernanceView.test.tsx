// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { RequestGovernanceBadge, RequestGovernanceView } from './RequestGovernanceView';
import type { RequestGovernanceSnapshot } from '@kiki/protocol';

const connection = vi.hoisted(() => ({ scopeId: 'test-domain', wsStatus: 'open', client: { getRequestGovernance: vi.fn() } }));
vi.mock('../state/connection', () => ({ useConnection: () => connection }));
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) act(dispose); vi.useRealTimers(); });
const snapshot: RequestGovernanceSnapshot = {
  domainId: 'this-service', runtimeEpoch: 'epoch-example', seq: 1, asOf: '2026-01-01T12:00:00Z',
  active: 3, queued: 2, coverage: { native: 'managed', external: 'unmanaged' },
  dimensions: [{ dimension: 'provider', id: 'provider-example', active: 3, queued: 2 }],
  rules: [{ id: 'provider-cap', resource: 'model_request', scope: 'global', providers: ['provider-example'], maxConcurrent: 3, subagentsOnly: false, overflow: 'queue' }],
  waiting: [],
};

describe('live request governance', () => {
  it('keeps the last authoritative counts on disconnection and marks them stale, never zero', async () => {
    vi.useFakeTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('kiki.locale', 'en');
    connection.wsStatus = 'open';
    connection.client.getRequestGovernance.mockResolvedValue(snapshot);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const render = () => { root.render(<QueryClientProvider client={queryClient}><I18nProvider><RequestGovernanceBadge /><RequestGovernanceView view="realtime" /></I18nProvider></QueryClientProvider>); };
    disposals.push(() => { root.unmount(); queryClient.clear(); container.remove(); reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });
    await act(async () => { render(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-queued]')?.textContent).toBe('2');
    expect(container.textContent).toContain('External executors: unmanaged');
    connection.wsStatus = 'closed';
    connection.client.getRequestGovernance.mockRejectedValue(new Error('offline'));
    await act(async () => { render(); await vi.advanceTimersByTimeAsync(1100); });
    expect(container.querySelector('[data-governance-active]')?.textContent).toBe('3');
    expect(container.querySelector('[data-governance-queued]')?.textContent).toBe('2');
    expect(container.querySelector('[data-request-governance-badge]')?.textContent).toContain('3 · +2');
    expect(container.textContent).toContain('State stale');
  });
});

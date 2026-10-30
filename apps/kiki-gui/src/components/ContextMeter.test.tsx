// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCapabilitiesResponse } from '@kiki/protocol';
import { I18nProvider } from '../i18n';
import type { KikiClient } from '../lib/client';
import { applyCompactionProgress, useCompactionProgress, type CompactionProgress, type CompactionProgressEvent } from './useCompactionProgress';
import {
  CONTEXT_DANGER_RATIO,
  CONTEXT_WARN_RATIO,
  ContextBreakdownProvider,
  ContextMeter,
  contextUsageDanger,
  contextUsageLevel,
  contextUsageWarns,
} from './ContextMeter';
import { mapCanonicalAgentUsage } from './agent-panel/useCanonicalAgentUsage';

const canonicalMocks = vi.hoisted(() => ({
  connection: null as unknown,
  read: vi.fn(),
}));

vi.mock('../state/connection', () => ({
  useOptionalConnection: () => canonicalMocks.connection,
}));

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

beforeEach(() => {
  canonicalMocks.connection = null;
  canonicalMocks.read.mockReset();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

describe('context usage thresholds', () => {
  it('warns at 50% and turns danger at 80%', () => {
    expect(CONTEXT_WARN_RATIO).toBe(0.5);
    expect(CONTEXT_DANGER_RATIO).toBe(0.8);
    expect(contextUsageWarns(50, 100)).toBe(true);
    expect(contextUsageWarns(49, 100)).toBe(false);
    expect(contextUsageDanger(80, 100)).toBe(true);
    expect(contextUsageDanger(79, 100)).toBe(false);
    expect(contextUsageLevel(49, 100)).toBe('ok');
    expect(contextUsageLevel(50, 100)).toBe('warn');
    expect(contextUsageLevel(80, 100)).toBe('danger');
  });
});

function canonicalResponse(agentId: string, metrics: NonNullable<AgentCapabilitiesResponse['metrics']>[string]): AgentCapabilitiesResponse {
  return {
    context: 'live',
    live: true,
    owner: { agent_id: agentId },
    available: true,
    targets: [],
    metrics: { [agentId]: metrics },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('canonical current-agent cumulative usage', () => {
  it('subtracts cache buckets from input and preserves unknown fields', () => {
    expect(mapCanonicalAgentUsage({
      inputTokens: 100,
      outputTokens: 7,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 107,
      totalCostUsd: 0.04,
      contextTokens: null,
      contextLimit: null,
      compactionCount: null,
    })).toEqual({
      input_tokens: 30,
      output_tokens: 7,
      cache_read_tokens: 60,
      cache_creation_tokens: 10,
      total_cost_usd: 0.04,
    });
    expect(mapCanonicalAgentUsage(undefined)).toEqual({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      total_cost_usd: null,
    });
  });

  it('waits for details to open, scopes settle to the current agent, and reuses the fresh result on reopen', async () => {
    const pending = deferred<AgentCapabilitiesResponse>();
    const signals: AbortSignal[] = [];
    canonicalMocks.connection = {
      spaceKey: 'main',
      scopeId: 'local',
      meta: { server_id: 'server-1' },
      klient: { global: { agentPanel: { read: canonicalMocks.read } } },
    };
    canonicalMocks.read.mockImplementation((query: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      expect(query).toEqual({
        session_id: 'session_abc',
        agent_id: 'child_7',
        metrics_settle: true,
        metrics_only: true,
        metrics_agent_ids: ['child_7'],
      });
      return pending.promise;
    });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <ContextMeter
                used={80_000}
                limit={200_000}
                usageScope="agent"
                agentId="child_7"
                sessionId="session_abc"
                usage={{ input_tokens: 900, output_tokens: 800, cache_read_tokens: 700, cache_creation_tokens: 600, total_cost_usd: 9 }}
              />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    expect(canonicalMocks.read).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(canonicalMocks.read).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-context-usage-loading]')).not.toBeNull();
    pending.resolve(canonicalResponse('child_7', {
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 60,
      cacheWriteTokens: 10,
      totalTokens: 105,
      totalCostUsd: 0.012,
      contextTokens: null,
      contextLimit: null,
      compactionCount: null,
    }));
    await act(async () => { await pending.promise; });
    const usage = container.querySelector('[data-context-usage]');
    expect(usage?.textContent).toContain('Agent cumulative');
    expect(usage?.textContent).toContain('Input30');
    expect(usage?.textContent).toContain('Output5');
    expect(usage?.textContent).toContain('$0.012');
    expect(usage?.textContent).not.toContain('900');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(canonicalMocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
  });

  it('reads main-session accounting, aborts on session switch and close, and marks the known subtotal', async () => {
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const signals: AbortSignal[] = [];
    const agentRead = vi.fn();
    canonicalMocks.connection = {
      spaceKey: 'main',
      scopeId: 'local',
      client: { klient: { rest: { sessionUsageAccounting: canonicalMocks.read }, events: { on: () => ({ dispose: () => {} }) } } },
      klient: { global: { agentPanel: { read: agentRead } } },
    };
    canonicalMocks.read.mockImplementation((id: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return id === 'session_a' ? first.promise : second.promise;
    });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
    };
    await act(async () => {
      root.render(
        <I18nProvider><MemoryRouter>
          <ContextMeter used={40_000} limit={200_000} usageScope="session" agentId="main" sessionId="session_a" usage={usage} />
        </MemoryRouter></I18nProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(canonicalMocks.read).toHaveBeenCalledWith('session_a', { signal: expect.any(AbortSignal) });
    expect(agentRead).not.toHaveBeenCalled();
    first.resolve({
      version: 2,
      subject: { session_id: 'session_a', scope: 'session' },
      covered_at: 1,
      complete: true,
      freshness: 'stale',
      tokens: { input_other: 10, output: 0, input_cache_read: 0, input_cache_creation: 0 },
      tokens_unknown: true,
      cost_usd_estimated: 0.01,
      cost_unknown: true,
    });
    await act(async () => { await first.promise; });
    const detail = container.querySelector('[data-context-usage]');
    expect(detail?.textContent).toContain('Input10');
    expect(detail?.textContent).toContain('$0.010');
    expect(detail?.querySelector('[data-usage-accounting-known-subtotal]')).not.toBeNull();
    expect(detail?.querySelector('[data-context-usage-freshness="stale"]')?.textContent).toBe('May be out of date');

    await act(async () => {
      root.render(
        <I18nProvider><MemoryRouter>
          <ContextMeter used={40_000} limit={200_000} sessionId="session_b" usage={usage} />
        </MemoryRouter></I18nProvider>,
      );
    });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => { root.unmount(); });
  });

  it('continues incomplete session accounting and keeps freshness independent of source coverage', async () => {
    vi.useFakeTimers();
    let root: Root | undefined;
    const accounting = {
      version: 2, subject: { session_id: 'session_a', scope: 'session' }, covered_at: 1,
      complete: false, freshness: 'unverified', tokens: { input_other: 10, output: 0, input_cache_read: 0, input_cache_creation: 0 },
      tokens_unknown: false, cost_usd_estimated: 0.01, cost_unknown: false,
    };
    canonicalMocks.connection = {
      spaceKey: 'main', scopeId: 'local',
      client: { klient: { rest: { sessionUsageAccounting: canonicalMocks.read }, events: { on: () => ({ dispose: () => {} }) } } },
    };
    canonicalMocks.read.mockResolvedValueOnce(accounting)
      .mockResolvedValueOnce({ ...accounting, complete: true, freshness: 'current', tokens_unknown: true });
    try {
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      root = createRoot(container);
      await act(async () => { root!.render(<I18nProvider><MemoryRouter><ContextMeter used={40_000} limit={200_000} usageScope="session" sessionId="session_a" /></MemoryRouter></I18nProvider>); });
      expect(canonicalMocks.read).not.toHaveBeenCalled();
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
      expect(container.querySelector('[data-context-usage-freshness="unverified"]')?.textContent).toBe('Not yet checked');
      await act(async () => { vi.advanceTimersByTime(249); });
      expect(canonicalMocks.read).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(canonicalMocks.read).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-context-usage-freshness]')).toBeNull();
      expect(container.querySelector('[data-context-usage-error]')?.textContent).toContain('Some usage or prices are unknown');
      await act(async () => { vi.advanceTimersByTime(14_999); });
      expect(canonicalMocks.read).toHaveBeenCalledTimes(2);
    } finally {
      if (root !== undefined) await act(async () => { root!.unmount(); });
      vi.useRealTimers();
    }
  });

  it('keeps child-agent usage self-scoped without reading the session record', async () => {
    const agentRead = vi.fn().mockResolvedValue(canonicalResponse('child_7', {
      inputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 10,
      totalCostUsd: null,
      contextTokens: null,
      contextLimit: null,
      compactionCount: null,
    }));
    canonicalMocks.connection = {
      spaceKey: 'main',
      scopeId: 'local',
      client: { getSession: canonicalMocks.read },
      klient: { global: { agentPanel: { read: agentRead } } },
    };
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider><MemoryRouter>
            <ContextMeter
              used={40_000}
              limit={200_000}
              sessionId="session_a"
              agentId="child_7"
              usageScope="agent"
              usage={{ input_tokens: 9, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: null }}
            />
          </MemoryRouter></I18nProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(canonicalMocks.read).not.toHaveBeenCalled();
    expect(agentRead).toHaveBeenCalled();
    expect(container.querySelector('[data-context-usage]')?.textContent).toContain('Agent cumulative');
    expect(container.querySelector('[data-context-usage]')?.textContent).toContain('Input9');
    await act(async () => { root.unmount(); });
    queryClient.clear();
  });

  it('keeps refreshing live numbers through the own header after settle coverage completes', async () => {
    vi.useFakeTimers();
    let root: Root | undefined;
    try {
      const settled = deferred<AgentCapabilitiesResponse>();
      const live = deferred<AgentCapabilitiesResponse>();
      canonicalMocks.connection = {
        spaceKey: 'main',
        scopeId: 'local',
        meta: { server_id: 'server-1' },
        klient: { global: { agentPanel: { read: canonicalMocks.read } } },
      };
      let calls = 0;
      canonicalMocks.read.mockImplementation((query: unknown) => {
        calls += 1;
        if (calls === 1) {
          expect(query).toEqual({
            session_id: 'session_abc',
            agent_id: 'child_7',
            metrics_settle: true,
            metrics_only: true,
            metrics_agent_ids: ['child_7'],
          });
          return settled.promise;
        }
        expect(query).toEqual({
          session_id: 'session_abc',
          agent_id: 'child_7',
          metrics_settle: false,
          metrics_only: true,
        });
        return live.promise;
      });
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      root = createRoot(container);
      const queryClient = new QueryClient();
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider>
              <MemoryRouter>
                <ContextMeter used={40_000} limit={200_000} usageScope="agent" agentId="child_7" sessionId="session_abc" />
              </MemoryRouter>
            </I18nProvider>
          </QueryClientProvider>,
        );
      });
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
      expect(calls).toBe(1);
      settled.resolve(canonicalResponse('child_7', {
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 60,
        cacheWriteTokens: 10,
        totalTokens: 105,
        totalCostUsd: 0.012,
        contextTokens: null,
        contextLimit: null,
        compactionCount: null,
        usageComplete: true,
      }));
      await act(async () => { await settled.promise; });
      expect(container.querySelector('[data-context-usage]')?.textContent).toContain('Input30');
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(calls).toBe(2);
      live.resolve(canonicalResponse('child_7', {
        inputTokens: 220,
        outputTokens: 8,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        totalTokens: 228,
        totalCostUsd: 0.02,
        contextTokens: null,
        contextLimit: null,
        compactionCount: null,
        usageComplete: true,
      }));
      await act(async () => { await live.promise; });
      const usage = container.querySelector('[data-context-usage]');
      expect(usage?.textContent).toContain('Input100');
      expect(usage?.textContent).toContain('Output8');
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
      expect(calls).toBe(2);
    } finally {
      if (root !== undefined) await act(async () => { root!.unmount(); });
      vi.useRealTimers();
    }
  });

  it.each([false, true])('settles again after a newer header loses source coverage (reopen: %s)', async (reopen) => {
    vi.useFakeTimers();
    let root: Root | undefined;
    try {
      const row = {
        inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10,
        totalTokens: 105, totalCostUsd: 0.012, contextTokens: null, contextLimit: null,
        compactionCount: null, usageComplete: true, usagePartial: false, costPartial: false,
        usageSource: 'persisted' as const,
      };
      const updated = { ...row, inputTokens: 220, outputTokens: 8, totalTokens: 228,
        cacheReadTokens: 100, cacheWriteTokens: 20, usagePartial: true, costPartial: true };
      canonicalMocks.connection = {
        spaceKey: 'main', scopeId: 'local', meta: { server_id: 'server-1' },
        klient: { global: { agentPanel: { read: canonicalMocks.read } } },
      };
      canonicalMocks.read
        .mockResolvedValueOnce(canonicalResponse('child_7', row))
        .mockResolvedValueOnce(canonicalResponse('child_7', {
          ...row, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
          totalTokens: null, totalCostUsd: null, usageComplete: false, usagePartial: true, costPartial: true,
        }))
        .mockResolvedValue(canonicalResponse('child_7', updated));
      const container = document.createElement('div');
      document.body.append(container);
      containers.push(container);
      root = createRoot(container);
      const queryClient = new QueryClient();
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <I18nProvider><MemoryRouter>
              <ContextMeter used={40_000} limit={200_000} usageScope="agent" agentId="child_7" sessionId="session_abc" />
            </MemoryRouter></I18nProvider>
          </QueryClientProvider>,
        );
      });
      const toggle = () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); };
      await act(async () => { toggle(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(container.querySelector('[data-context-usage]')?.textContent).toContain('Not reported');
      if (reopen) {
        await act(async () => { toggle(); });
        await act(async () => { toggle(); });
      } else {
        await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      }
      expect(canonicalMocks.read).toHaveBeenNthCalledWith(3, {
        session_id: 'session_abc', agent_id: 'child_7', metrics_settle: true,
        metrics_only: true, metrics_agent_ids: ['child_7'],
      }, { signal: expect.any(AbortSignal) });
      expect(container.querySelector('[data-context-usage]')?.textContent).toContain('Input100');
      expect(container.querySelector('[data-context-usage-error]')?.textContent).toContain('incomplete');
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(canonicalMocks.read).toHaveBeenNthCalledWith(4, {
        session_id: 'session_abc', agent_id: 'child_7', metrics_settle: false, metrics_only: true,
      }, { signal: expect.any(AbortSignal) });
    } finally {
      if (root !== undefined) await act(async () => { root!.unmount(); });
      vi.useRealTimers();
    }
  });

  it('aborts the bounded waiter when details close before the settle returns', async () => {
    const pending = deferred<AgentCapabilitiesResponse>();
    let signal: AbortSignal | undefined;
    canonicalMocks.connection = {
      spaceKey: 'main',
      scopeId: 'local',
      meta: { server_id: 'server-1' },
      klient: { global: { agentPanel: { read: canonicalMocks.read } } },
    };
    canonicalMocks.read.mockImplementation((_query: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return pending.promise;
    });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <ContextMeter used={40_000} limit={200_000} usageScope="agent" agentId="child_7" sessionId="session_abc" />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(signal?.aborted).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(signal?.aborted).toBe(true);
    pending.resolve(canonicalResponse('child_7', {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      totalCostUsd: null,
      contextTokens: null,
      contextLimit: null,
      compactionCount: null,
    }));
    await act(async () => { await pending.promise; });
    await act(async () => { root.unmount(); });
  });

  it('renders partial and unknown canonical fields without inventing zero cost', async () => {
    const pending = deferred<AgentCapabilitiesResponse>();
    canonicalMocks.connection = {
      spaceKey: 'main',
      scopeId: 'local',
      meta: { server_id: 'server-1' },
      klient: { global: { agentPanel: { read: canonicalMocks.read } } },
    };
    canonicalMocks.read.mockReturnValue(pending.promise);
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const queryClient = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <ContextMeter used={40_000} limit={200_000} usageScope="agent" agentId="main" sessionId="session_abc" />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    pending.resolve(canonicalResponse('main', {
      inputTokens: null,
      outputTokens: 4,
      cacheReadTokens: null,
      cacheWriteTokens: 2,
      totalTokens: null,
      totalCostUsd: null,
      contextTokens: null,
      contextLimit: null,
      compactionCount: null,
      usagePartial: true,
      usageComplete: true,
      costPartial: true,
    }));
    await act(async () => { await pending.promise; });
    const usage = container.querySelector('[data-context-usage]');
    expect(usage?.textContent).toContain('Agent cumulative');
    expect(usage?.textContent).toContain('incomplete');
    expect(usage?.textContent).toContain('Not reported');
    expect(usage?.textContent).not.toContain('$0.00');
    expect(usage?.textContent).not.toContain('Session cumulative');
    await act(async () => { root.unmount(); });
  });
});

describe('ContextMeter interaction', () => {
  it.each([
    { used: 0, effectiveLimit: undefined, expected: '0% · 0' },
    { used: 762, effectiveLimit: undefined, expected: '0% · 762' },
    { used: 76_200, effectiveLimit: undefined, expected: '15% · 76.2k' },
    { used: 76_200, effectiveLimit: 300_000, expected: '25% · 76.2k' },
  ])('shows current used tokens next to the detail header percentage: $expected', async ({ used, effectiveLimit, expected }) => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const autoCompact = effectiveLimit === undefined ? undefined : {
      status: { tokens: 250_000, source: 'legacy' as const, effectiveMaxContextTokens: effectiveLimit, reservedContextTokens: 50_000 },
      running: false,
      onCommit: vi.fn(),
      onSave: vi.fn(),
    };
    const draw = async (currentUsed: number) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <ContextMeter
              used={currentUsed}
              limit={500_000}
              autoCompact={autoCompact}
              usage={{ input_tokens: 900_000, output_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: null }}
            />
          </I18nProvider>,
        );
      });
    };
    await draw(used);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });

    const headerValue = () => container.querySelector('[data-context-details] > div:first-child > span')?.textContent;
    expect(headerValue()).toBe(expected);
    // Both values update from current context use, not the lifetime usage total.
    await draw(150_000);
    expect(headerValue()).toBe(effectiveLimit === undefined ? '30% · 150.0k' : '50% · 150.0k');
    await act(async () => { root.unmount(); });
  });

  it('opens details without compacting, then compacts only from the panel action', async () => {
    const onCompact = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter used={80_000} limit={100_000} onCompact={onCompact} />
        </I18nProvider>,
      );
    });

    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]');
    expect(meter).not.toBeNull();
    await act(async () => { meter!.click(); });

    expect(onCompact).not.toHaveBeenCalled();
    const details = container.querySelector('[data-context-details]');
    expect(details?.textContent).toContain('Context details');
    expect(details?.textContent).toContain('Used');
    expect(details?.textContent).toContain('Available');
    expect(details?.textContent).toContain('Limit');

    const compact = container.querySelector<HTMLButtonElement>('[data-context-compact]');
    expect(compact).not.toBeNull();
    await act(async () => { compact!.click(); });

    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-context-details]')).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('renders the ring with a level data attribute and warns amber at exactly 50%', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter used={50_000} limit={100_000} />
        </I18nProvider>,
      );
    });

    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]');
    expect(meter?.getAttribute('data-context-level')).toBe('warn');
    expect(meter?.querySelector('svg')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it('renders danger red above 80%', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter used={90_000} limit={100_000} />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[data-context-meter]')?.getAttribute('data-context-level')).toBe(
      'danger',
    );
    await act(async () => { root.unmount(); });
  });

  it('can open details below when embedded in a top header', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter used={8_000} limit={32_000} placement="below" />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    expect(container.querySelector('[data-context-details]')?.className).toContain('top-full');
    await act(async () => { root.unmount(); });
  });

  it('closes the detail card on an outside pointer and on Escape from anywhere', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<I18nProvider><ContextMeter used={8_000} limit={32_000} /></I18nProvider>);
    });
    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]')!;

    await act(async () => { meter.click(); });
    expect(container.querySelector('[data-context-details]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[data-context-details]')).toBeNull();

    await act(async () => { meter.click(); });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-context-details]')).toBeNull();

    await act(async () => { meter.click(); });
    const details = container.querySelector<HTMLElement>('[data-context-details]')!;
    await act(async () => {
      details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-context-details]')).toBeNull();
    expect(document.activeElement).toBe(meter);
    await act(async () => { root.unmount(); });
  });

  it('shows the lifetime session usage and cost in the detail card', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter
            used={80_000}
            limit={200_000}
            usage={{
              input_tokens: 12_400,
              output_tokens: 2_100,
              cache_read_tokens: 8_000,
              cache_creation_tokens: 500,
              total_cost_usd: 0.0432,
            }}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const usage = container.querySelector('[data-context-usage]');
    expect(usage?.textContent).toContain('Session cumulative');
    expect(container.querySelector('[data-context-details]')?.textContent).toContain(
      'Context window',
    );
    expect(usage?.textContent).toContain('Input');
    expect(usage?.textContent).toContain('Output');
    expect(usage?.textContent).toContain('Cache read');
    expect(usage?.textContent).toContain('Cache write');
    expect(usage?.textContent).toContain('$0.043');
    expect(usage?.textContent).toContain('Total tokens');
    await act(async () => { root.unmount(); });
  });

  it('never shows placeholder zeros when the usage read failed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter
            used={40_000}
            limit={200_000}
            usage={{ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: 0 }}
            usageError="read-failed"
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const usage = container.querySelector('[data-context-usage]');
    expect(container.querySelector('[data-context-usage-error]')?.textContent).toContain('Couldn’t read cumulative usage.');
    expect(container.querySelector('[data-context-usage-error]')?.getAttribute('title')).toBe('read-failed');
    // The zeros the server falls back to are placeholders, not a measurement.
    expect(usage?.textContent).not.toContain('Input');
    expect(usage?.textContent).not.toContain('Total tokens');
    expect(usage?.textContent).not.toContain('$0.00');
    await act(async () => { root.unmount(); });
  });

  it('keeps the numbers and marks them incomplete when one agent’s usage was skipped', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter
            used={40_000}
            limit={200_000}
            usage={{ input_tokens: 900, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0, total_cost_usd: null }}
            usageError="agent-read-failed"
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const usage = container.querySelector('[data-context-usage]');
    expect(container.querySelector('[data-context-usage-error]')?.textContent).toContain('incomplete');
    expect(usage?.textContent).toContain('Input');
    expect(usage?.textContent).toContain('Total tokens');
    await act(async () => { root.unmount(); });
  });

  it('titles agent-scoped usage as the agent and hides the unpriced cost row', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter
            used={40_000}
            limit={200_000}
            usageScope="agent"
            usage={{
              input_tokens: 12_400,
              output_tokens: 2_100,
              cache_read_tokens: 8_000,
              cache_creation_tokens: 500,
              total_cost_usd: null,
            }}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const usage = container.querySelector('[data-context-usage]');
    expect(usage?.textContent).toContain('Agent cumulative');
    expect(usage?.textContent).not.toContain('Session cumulative');
    // Per-agent projections carry no pricing: the cost row hides instead of
    // reading as $0.00, while the token rows and their total stay.
    expect(usage?.textContent).not.toContain('Cost');
    expect(usage?.textContent).toContain('Input');
    expect(usage?.textContent).toContain('Total tokens');
    await act(async () => { root.unmount(); });
  });

  it('links to the prefetched session view on /usage when sessionId is set', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter>
            <ContextMeter
              used={80_000}
              limit={200_000}
              sessionId="session_abc"
              usage={{
                input_tokens: 100,
                output_tokens: 10,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                total_cost_usd: 0.01,
              }}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const link = container.querySelector<HTMLAnchorElement>('[data-context-usage-link]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(
      '/usage?panel=history&dimension=session&session=session_abc',
    );
    expect(link?.textContent).toContain('Usage');
    await act(async () => { root.unmount(); });
  });

  it('renders the estimated system/tools/messages breakdown from context', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextBreakdownProvider
            value={{
              systemTokens: 12_000,
              toolsTokens: 8_000,
              messagesTokens: 60_000,
              estimated: true,
            }}
          >
            <ContextMeter used={80_000} limit={100_000} />
          </ContextBreakdownProvider>
        </I18nProvider>,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click();
    });

    const breakdown = container.querySelector('[data-context-breakdown]');
    expect(breakdown?.textContent).toContain('Breakdown');
    expect(breakdown?.textContent).toContain('estimated');
    expect(breakdown?.textContent).toContain('System');
    expect(breakdown?.textContent).toContain('12.0k');
    expect(breakdown?.textContent).toContain('Tools');
    expect(breakdown?.textContent).toContain('8.0k');
    expect(breakdown?.textContent).toContain('Messages');
    expect(breakdown?.textContent).toContain('60.0k');
    await act(async () => { root.unmount(); });
  });
});

describe('compaction progress lifetime', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: KikiClient;
  let listeners: Map<string, Map<string, (event: CompactionProgressEvent) => void>>;
  let disposals: ReturnType<typeof vi.fn>[];
  let mounted: boolean;

  function Probe({ sessionId, currentClient, used }: { sessionId?: string; currentClient: KikiClient; used: number }) {
    const progress = useCompactionProgress(currentClient, sessionId);
    return <I18nProvider><ContextBreakdownProvider value={undefined} compaction={progress}><ContextMeter used={used} limit={100_000} /></ContextBreakdownProvider></I18nProvider>;
  }
  async function draw(sessionId: string | undefined = 'session-a', currentClient = client, used = 80_000) {
    await act(async () => { root.render(<Probe sessionId={sessionId} currentClient={currentClient} used={used} />); });
  }
  async function emit(event: CompactionProgressEvent, sessionId = 'session-a') {
    await act(async () => { listeners.get(sessionId)!.get(event.type)!(event); });
  }
  async function advance(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }
  function completed(trigger: 'manual' | 'auto'): CompactionProgressEvent {
    return { type: 'compaction.completed', trigger, result: { summary: 'summary', compactedCount: 2, tokensBefore: 30, tokensAfter: 10 } };
  }
  const hint = () => container.querySelector('[data-compaction-progress]');

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    disposals = [];
    client = { klient: { session: (id: string) => ({ agent: () => ({ events: {
      on: (type: string, listener: (event: CompactionProgressEvent) => void) => {
        if (!listeners.has(id)) listeners.set(id, new Map());
        listeners.get(id)!.set(type, listener);
        const dispose = vi.fn(() => { listeners.get(id)!.delete(type); });
        disposals.push(dispose);
        return { ready: Promise.resolve(), dispose };
      },
    } }) }) } } as unknown as KikiClient;
    container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    root = createRoot(container);
    mounted = true;
  });
  afterEach(async () => {
    if (mounted) await act(async () => { root.unmount(); });
    vi.useRealTimers();
  });

  it.each(['auto', 'manual'] as const)('hides %s completion after three seconds without extending it on rerender', async (source) => {
    await draw();
    await emit(completed(source));
    expect(hint()?.textContent).toBe(source === 'auto' ? 'Automatic compaction complete' : 'Manual compaction complete');
    await advance(2_000);
    await draw('session-a', client, 20_000);
    await advance(999);
    expect(hint()?.getAttribute('data-compaction-progress')).toBe('completed');
    await advance(1);
    expect(hint()).toBeNull();
    expect(container.querySelector('[data-context-meter]')).not.toBeNull();
  });

  it.each(['queued', 'running'] as const)('keeps new %s progress past the previous success deadline', async (phase) => {
    await draw();
    await emit(completed('auto'));
    await advance(2_999);
    await act(async () => {
      listeners.get('session-a')!.get('compaction.started')!({ type: 'compaction.started', trigger: 'manual', phase });
      vi.advanceTimersByTime(1);
    });
    if (phase === 'queued') await emit(completed('auto'));
    expect(hint()?.getAttribute('data-compaction-progress')).toBe(phase);
    await advance(5_000);
    expect(hint()?.textContent).toBe(`Manual compaction ${phase === 'queued' ? 'queued' : 'running'}`);
  });

  it('keeps running and a readable failure reason longer than three seconds', async () => {
    await draw();
    await emit({ type: 'compaction.started', trigger: 'auto' });
    await advance(5_000);
    expect(hint()?.getAttribute('data-compaction-progress')).toBe('running');
    await emit({ type: 'compaction.cancelled', trigger: 'auto', reason: 'No safe prefix' });
    await advance(5_000);
    expect(hint()?.getAttribute('data-compaction-progress')).toBe('failed');
    expect(hint()?.getAttribute('title')).toBe('No safe prefix');
  });

  it.each(['session', 'client'] as const)('cancels old completion on %s change without clearing the new hint', async (change) => {
    await draw();
    await emit(completed('auto'));
    const oldListener = listeners.get('session-a')!.get('compaction.completed')!;
    await advance(2_000);
    const sessionId = change === 'session' ? 'session-b' : 'session-a';
    await draw(sessionId, change === 'client' ? Object.create(client) as KikiClient : client);
    expect(hint()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(disposals.slice(0, 3).every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    await emit(completed('manual'), sessionId);
    await act(async () => { oldListener(completed('auto')); });
    await advance(1_000);
    expect(hint()?.textContent).toBe('Manual compaction complete');
    await advance(2_000);
    expect(hint()).toBeNull();
  });

  it('cancels the success timer and event subscriptions on unmount', async () => {
    await draw();
    await emit(completed('manual'));
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { root.unmount(); });
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });
});

describe('manual compaction progress', () => {
  it('keeps manual queue attribution when an earlier automatic compaction finishes', () => {
    const queued = applyCompactionProgress(undefined, { type: 'compaction.started', trigger: 'manual', phase: 'queued' });
    expect(applyCompactionProgress(queued, { type: 'compaction.completed', trigger: 'auto', result: { summary: 'auto', compactedCount: 2, tokensBefore: 30, tokensAfter: 10 } })).toEqual(queued);
    expect(applyCompactionProgress(queued, { type: 'compaction.completed', result: { summary: 'unknown source', compactedCount: 2, tokensBefore: 30, tokensAfter: 10 } })).toEqual(queued);
    expect(applyCompactionProgress({ source: 'manual', phase: 'running' }, { type: 'compaction.completed', result: { summary: 'older server', compactedCount: 2, tokensBefore: 30, tokensAfter: 10 } })).toBeUndefined();
    expect(applyCompactionProgress(queued, { type: 'compaction.cancelled', trigger: 'manual', reason: 'No safe prefix' })).toEqual({ source: 'manual', phase: 'failed', reason: 'No safe prefix' });
  });

  it('shows queue, execution, completion and real failure without disabling an unrelated active turn', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    const onCompact = vi.fn();
    const draw = async (compaction?: CompactionProgress) => {
      await act(async () => { root.render(<I18nProvider><ContextBreakdownProvider value={undefined} compaction={compaction}><ContextMeter used={80_000} limit={100_000} onCompact={onCompact} /></ContextBreakdownProvider></I18nProvider>); });
    };
    await draw({ source: 'auto', phase: 'running' });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(container.querySelector<HTMLButtonElement>('[data-context-compact]')?.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-compact]')!.click(); });
    expect(onCompact).toHaveBeenCalledTimes(1);
    await draw({ source: 'manual', phase: 'queued' });
    expect(container.querySelector('[data-compaction-progress]')?.textContent).toBe('Manual compaction queued');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-context-meter]')!.click(); });
    expect(container.querySelector<HTMLButtonElement>('[data-context-compact]')?.disabled).toBe(true);
    await draw({ source: 'manual', phase: 'running' });
    expect(container.textContent).toContain('Manual compaction running');
    await draw({ source: 'manual', phase: 'completed' });
    expect(container.textContent).toContain('Manual compaction complete');
    expect(container.querySelector<HTMLButtonElement>('[data-context-compact]')?.disabled).toBe(false);
    await draw({ source: 'manual', phase: 'failed', reason: 'No safe prefix' });
    expect(container.querySelector('[data-compaction-progress]')?.getAttribute('title')).toBe('No safe prefix');
    await act(async () => { root.unmount(); });
  });
});

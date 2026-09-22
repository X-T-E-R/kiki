// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import {
  CONTEXT_DANGER_RATIO,
  CONTEXT_WARN_RATIO,
  ContextBreakdownProvider,
  ContextMeter,
  contextUsageDanger,
  contextUsageLevel,
  contextUsageWarns,
} from './ContextMeter';

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

describe('ContextMeter interaction', () => {
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
      '/usage?dimension=session&session=session_abc',
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
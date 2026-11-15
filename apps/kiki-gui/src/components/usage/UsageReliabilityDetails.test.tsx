// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usageResponseSchema } from '@kiki/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { UsageReliabilityDetails } from './UsageReliabilityDetails';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const containers: HTMLDivElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

const response = usageResponseSchema.parse({
  query: { granularity: 'day', dimension: 'model', range: { preset: 'all', start_at: null, end_at: null,
    defaulted_to_all_history: false }, models: [], providers: [], agent_ids: [], workspace_ids: [],
    include_archived: true, timezone_offset_minutes: 0 },
  summary: { tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    cost_usd_estimated: 0, cost_unknown: false, session_count: 0 },
  trend: [], sessions: { items: [], total: 0, has_more: false, next_page_token: null },
  reliability: { complete: false, coverage: { earliest_at: null, latest_at: null },
    scanned_sessions: 0, incomplete_sessions: 0, unknown_price_models: [],
    includes_deleted_sessions: true, incomplete_reason: null },
});

describe('UsageReliabilityDetails', () => {
  it.each([
    { complete: false, tokensUnknown: false },
    { complete: true, tokensUnknown: false },
    { complete: false, tokensUnknown: true },
  ])('uses a compact status without redundant subtotal prose for %j', async ({ complete, tokensUnknown }) => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<I18nProvider><UsageReliabilityDetails summary={{ ...response.summary, tokens_unknown: tokensUnknown,
          tokens: { ...response.summary.tokens, input_other: 100 } }}
          reliability={{ ...response.reliability, complete }} /></I18nProvider>);
      });
      expect(container.querySelector<HTMLElement>('[data-usage-reliability-state]')?.dataset['usageReliabilityState'])
        .toBe(complete ? 'complete' : 'partial');
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!.click(); });
      expect(container.querySelector('[data-usage-incomplete]')).toBeNull();
      expect(container.querySelector('[data-usage-accounting-known-subtotal]')).toBeNull();
      expect(container.textContent).not.toContain('Known subtotal only');
      if (!complete) {
        expect(container.querySelector('[data-usage-reliability-toggle] [data-icon="partial"]')).not.toBeNull();
        expect(container.querySelector('[data-usage-reliability-toggle]')?.textContent).toContain('About these totals');
        expect(container.querySelector('[data-usage-reliability] dl')?.className).not.toMatch(/mt-4|border-t/);
      }
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});

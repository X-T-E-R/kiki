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
  it.each([false, true])('uses shared completeness=%s even when all reason lists are empty', async (complete) => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<I18nProvider><UsageReliabilityDetails summary={response.summary}
          reliability={{ ...response.reliability, complete }} /></I18nProvider>);
      });
      expect(container.querySelector<HTMLElement>('[data-usage-reliability-state]')?.dataset['usageReliabilityState'])
        .toBe(complete ? 'complete' : 'partial');
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!.click(); });
      if (complete) expect(container.querySelector('[data-usage-incomplete]')).toBeNull();
      else expect(container.querySelector('[data-usage-incomplete]')?.textContent).toMatch(/Coverage.*Partial|覆盖范围.*不完整/);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});

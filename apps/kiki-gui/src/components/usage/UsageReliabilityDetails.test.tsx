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
  query: {
    granularity: 'day',
    dimension: 'model',
    range: {
      preset: 'all',
      start_at: null,
      end_at: null,
      defaulted_to_all_history: false,
    },
    models: [],
    providers: [],
    agent_ids: [],
    workspace_ids: [],
    include_archived: true,
    timezone_offset_minutes: 0,
  },
  summary: {
    tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    cost_usd_estimated: 0,
    cost_unknown: false,
    session_count: 0,
  },
  trend: [],
  sessions: { items: [], total: 0, has_more: false, next_page_token: null },
  reliability: {
    complete: false,
    coverage: { earliest_at: null, latest_at: null },
    scanned_sessions: 0,
    incomplete_sessions: 0,
    unknown_price_models: [],
    includes_deleted_sessions: true,
    incomplete_reason: null,
  },
});

describe('UsageReliabilityDetails', () => {
  it.each([
    { complete: false, tokensUnknown: false },
    { complete: true, tokensUnknown: false },
    { complete: false, tokensUnknown: true },
  ])('uses a compact icon status with on-demand popover for %j', async ({ complete, tokensUnknown }) => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <UsageReliabilityDetails
              summary={{
                ...response.summary,
                tokens_unknown: tokensUnknown,
                tokens: { ...response.summary.tokens, input_other: 100 },
              }}
              reliability={{ ...response.reliability, complete }}
            />
          </I18nProvider>,
        );
      });
      expect(container.querySelector<HTMLElement>('[data-usage-reliability-state]')?.dataset['usageReliabilityState'])
        .toBe(complete ? 'complete' : 'partial');
      const toggle = container.querySelector<HTMLButtonElement>('[data-usage-reliability-toggle]')!;
      expect(toggle.textContent).toBe('');
      expect(toggle.getAttribute('aria-label')).toContain(complete ? 'Complete' : 'Partial');
      expect(document.body.querySelector('[data-usage-reliability]')).toBeNull();
      await act(async () => { toggle.click(); });
      const popover = document.body.querySelector('[data-usage-reliability]')!;
      expect(popover).not.toBeNull();
      expect(popover.id).toBe(toggle.getAttribute('aria-controls'));
      expect(popover.textContent).toContain(complete ? 'Complete · 0 scanned' : 'Partial · 0 scanned');
      expect(popover.textContent).not.toContain('Known subtotal only');
      if (!complete) {
        expect(toggle.querySelector('[data-icon="partial"]')).not.toBeNull();
      } else {
        expect(toggle.querySelector('[data-icon="info"]')).not.toBeNull();
      }
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});

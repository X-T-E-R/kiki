import type { ExecutorModelCatalogResponse } from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

import {
  EXECUTOR_CAPABILITY_STALE_AFTER_MS,
  isExecutorActionAvailable,
  mapExecutorCapabilities,
} from './executorCapabilities';

function response(overrides: Partial<ExecutorModelCatalogResponse> = {}): ExecutorModelCatalogResponse {
  return {
    executor_id: 'agy-cli',
    source: 'cli_probe',
    provenance: 'read_only_cli_probe',
    revision: 'descriptor-1',
    apply_state: 'ready',
    observed_at: 100_000,
    executor_version: '1.2.3',
    effective: {
      models: { state: 'ready', values: ['agy/model-a'] },
      thinking_levels: { state: 'partial', values: ['medium'] },
      context: { state: 'unknown', diagnostic: 'Context is not reported.' },
      controls: {
        model_switch: { applicability: 'fresh_binding', apply_state: 'applied' },
        thinking_switch: { applicability: 'fresh_binding', apply_state: 'applied' },
        manual_compact: { applicability: 'unsupported', apply_state: 'unsupported', diagnostic: 'compact is unsupported' },
      },
    },
    ...overrides,
  };
}

describe('executor capability presentation', () => {
  it('maps the typed response and exposes provenance and diagnostics', () => {
    const presentation = mapExecutorCapabilities(response(), 100_001);

    expect(presentation).toMatchObject({
      freshness: 'fresh',
      source: 'cli_probe',
      provenance: 'read_only_cli_probe',
      engine_version: '1.2.3',
      models: { kind: 'ready', values: ['agy/model-a'] },
      thinking_levels: { kind: 'partial' },
      context: { kind: 'unknown', diagnostic: 'Context is not reported.' },
      controls: {
        model_switch: { kind: 'ready' },
        manual_compact: { kind: 'unavailable', diagnostic: 'compact is unsupported' },
      },
    });
  });

  it('degrades every typed dimension to unknown once the observation is stale', () => {
    const presentation = mapExecutorCapabilities(response(), 100_000 + EXECUTOR_CAPABILITY_STALE_AFTER_MS);

    expect(presentation.freshness).toBe('stale');
    expect(presentation.models.kind).toBe('unknown');
    expect(presentation.context.kind).toBe('unknown');
    expect(presentation.controls.model_switch.kind).toBe('unknown');
  });

  it('treats an under-reported apply receipt as writable when the pass is concrete', () => {
    const presentation = mapExecutorCapabilities(response({
      effective: {
        ...response().effective,
        controls: {
          model_switch: { advertised: true, applicability: 'fresh_binding', apply_state: 'unknown' },
          thinking_switch: { advertised: true, applicability: 'live', apply_state: 'unknown' },
          manual_compact: { advertised: true, applicability: 'next_binding', apply_state: 'unknown' },
        },
      },
    }), 100_001);

    expect(presentation.controls.model_switch).toMatchObject({
      kind: 'ready', applicability: 'fresh_binding', apply_state: 'unknown', advertised: true,
    });
    expect(presentation.controls.thinking_switch.kind).toBe('ready');
    expect(presentation.controls.manual_compact.kind).toBe('ready');
    expect(isExecutorActionAvailable(presentation.controls.model_switch)).toBe(true);
  });

  it('keeps an unknown or refused model switch unavailable to write', () => {
    const unknown = mapExecutorCapabilities(response({
      effective: {
        ...response().effective,
        controls: {
          ...response().effective.controls,
          model_switch: { applicability: 'unknown', apply_state: 'unknown' },
        },
      },
    }), 100_001);
    const refused = mapExecutorCapabilities(response({
      effective: {
        ...response().effective,
        controls: {
          ...response().effective.controls,
          model_switch: { advertised: false, applicability: 'fresh_binding', apply_state: 'unknown' },
        },
      },
    }), 100_001);
    const unsupported = mapExecutorCapabilities(response({
      effective: {
        ...response().effective,
        controls: {
          ...response().effective.controls,
          model_switch: { applicability: 'unsupported', apply_state: 'unsupported' },
        },
      },
    }), 100_001);
    const stale = mapExecutorCapabilities(response({
      effective: {
        ...response().effective,
        controls: {
          ...response().effective.controls,
          model_switch: { advertised: true, applicability: 'fresh_binding', apply_state: 'unknown' },
        },
      },
    }), 100_000 + EXECUTOR_CAPABILITY_STALE_AFTER_MS);

    expect(unknown.controls.model_switch.kind).toBe('unknown');
    expect(refused.controls.model_switch.kind).toBe('unavailable');
    expect(unsupported.controls.model_switch.kind).toBe('unavailable');
    expect(stale.controls.model_switch.kind).toBe('unknown');
    expect(isExecutorActionAvailable(unknown.controls.model_switch)).toBe(false);
    expect(isExecutorActionAvailable(refused.controls.model_switch)).toBe(false);
  });

  it('offers actions only for a ready dimension', () => {
    expect(isExecutorActionAvailable({ kind: 'ready' })).toBe(true);
    expect(isExecutorActionAvailable({ kind: 'partial' })).toBe(false);
    expect(isExecutorActionAvailable({ kind: 'unknown' })).toBe(false);
    expect(isExecutorActionAvailable({ kind: 'unavailable' })).toBe(false);
    expect(isExecutorActionAvailable({ kind: 'absent' })).toBe(false);
    expect(isExecutorActionAvailable(undefined)).toBe(false);
  });
});

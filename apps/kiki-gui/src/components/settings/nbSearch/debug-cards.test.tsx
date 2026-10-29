// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { engineLaneProfiles } from './serviceCards';

const CAPABILITIES = {
  providers: {
    descriptors: [],
    instances: [
      { id: 'exa.default', provider_id: 'exa', enabled: true, availability: 'unavailable', issues: [], credential: { requirement: 'required', configured: false, slot_id: 'exa.default' }, endpoint: { requirement: 'optional', configured: false } },
    ],
  },
  search: { lanes: [], presets: [], limits: {} },
  fetch: { inputs: [], chains: [], pipelines: [], limits: {} },
} as unknown as NbSearchCapabilities;

describe('engineLaneProfiles', () => {
  it('maps configuration lanes to providers', () => {
    const caps = {
      ...CAPABILITIES,
      configuration: {
        lanes: { 'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' } },
      },
    } as unknown as NbSearchCapabilities;
    expect(engineLaneProfiles(caps)).toEqual({ 'exa.search': { provider_id: 'exa', operation_id: 'search' } });
  });
  it('maps inherited lanes to providers', () => {
    const caps = {
      ...CAPABILITIES,
      inherited_configuration: {
        lanes: { 'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap' } },
      },
    } as unknown as NbSearchCapabilities;
    expect(engineLaneProfiles(caps)).toEqual({ 'exa.search': { provider_id: 'exa', operation_id: 'search' } });
  });
});

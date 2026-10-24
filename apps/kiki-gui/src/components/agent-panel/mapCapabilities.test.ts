import { describe, expect, it } from 'vitest';
import type { AgentCapabilitiesResponse } from '@kiki/protocol';
import { CAPABILITY_REASON_LABEL_KEYS, mapPanelTools } from './mapCapabilities';

type RawTool = NonNullable<AgentCapabilitiesResponse['tools']>[number];

describe('mapCapabilities', () => {
  it('maps all 4 new capability reason codes in CAPABILITY_REASON_LABEL_KEYS', () => {
    expect(CAPABILITY_REASON_LABEL_KEYS.tool_not_registered).toBe('capabilityReason.tool_not_registered');
    expect(CAPABILITY_REASON_LABEL_KEYS.plugin_catalog_failed).toBe('capabilityReason.plugin_catalog_failed');
    expect(CAPABILITY_REASON_LABEL_KEYS.plugin_usage_disabled).toBe('capabilityReason.plugin_usage_disabled');
    expect(CAPABILITY_REASON_LABEL_KEYS.plugin_usage_unavailable).toBe('capabilityReason.plugin_usage_unavailable');
  });

  it('maps tool policy_allowed and request_state without collapsing loadable or policyAllowed', () => {
    const rawTools: RawTool[] = [
      {
        name: 'mcp__weather__get',
        category: 'mcp',
        source: 'mcp',
        state: 'disabled',
        policy_allowed: true,
        request_state: 'loadable',
        unavailable_reason: 'Plugin is loadable on demand',
        unavailable_reason_code: 'plugin_catalog_failed',
      },
      {
        name: 'mcp__search__query',
        category: 'mcp',
        source: 'mcp',
        state: 'enabled',
        policy_allowed: true,
        request_state: 'available',
      },
    ];
    const mapped = mapPanelTools(rawTools);
    expect(mapped[0]).toMatchObject({
      name: 'mcp__weather__get',
      state: 'disabled',
      policyAllowed: true,
      requestState: 'loadable',
      unavailableReasonCode: 'plugin_catalog_failed',
    });
    expect(mapped[1]).toMatchObject({
      name: 'mcp__search__query',
      state: 'enabled',
      policyAllowed: true,
      requestState: 'available',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { persistedPanelMetricAgentIds } from '../src/routes/agentProfileCapabilities';

describe('persisted panel metric agent ids', () => {
  it('keeps an ordinary read on the addressed agent', () => {
    expect(persistedPanelMetricAgentIds({ agent_id: 'main' })).toEqual(['main']);
    expect(persistedPanelMetricAgentIds({
      agent_id: 'main', metrics_settle: false, metrics_agent_ids: ['child', 'main'],
    })).toEqual(['main']);
    expect(persistedPanelMetricAgentIds({
      agent_id: 'child', metrics_settle: true, metrics_agent_ids: [],
    })).toEqual(['child']);
  });

  it('settles the requested tree in one id list', () => {
    expect(persistedPanelMetricAgentIds({ agent_id: 'main', metrics_settle: true })).toEqual(['main']);
    expect(persistedPanelMetricAgentIds({
      agent_id: 'main', metrics_settle: true, metrics_agent_ids: ['child', 'main', 'child'],
    })).toEqual(['child', 'main']);
  });
});

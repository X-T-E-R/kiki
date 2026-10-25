import { describe, expect, it } from 'vitest';
import { UNKNOWN_AGENT_PANEL_METRICS } from '@kiki/session-core/session/agentPanel';
import { isCompletePanelMetrics, isUnsettledPanelMetrics, mergePanelMetrics, panelMetricsCapabilitiesKey, panelMetricsSettleKey, panelMetricsSourceRevision } from './panelMetricsQuery';
import type { AgentTokenUsage } from './types';

const cold: AgentTokenUsage = {
  ...UNKNOWN_AGENT_PANEL_METRICS,
  usagePartial: true,
  costPartial: true,
  usageSource: 'persisted',
};

const counted: AgentTokenUsage = {
  ...UNKNOWN_AGENT_PANEL_METRICS,
  inputTokens: 9,
  outputTokens: 5,
  totalTokens: 14,
  totalCostUsd: 0.02,
  usagePartial: false,
  usageSource: 'persisted',
};

describe('panel metrics settle merge', () => {
  it('treats a missing or cold placeholder row as unsettled and a reported row as final', () => {
    expect(isUnsettledPanelMetrics(undefined)).toBe(true);
    expect(isUnsettledPanelMetrics(cold)).toBe(true);
    expect(isUnsettledPanelMetrics(UNKNOWN_AGENT_PANEL_METRICS)).toBe(false);
    expect(isUnsettledPanelMetrics(counted)).toBe(false);
    expect(isUnsettledPanelMetrics({ ...counted, totalTokens: 0, totalCostUsd: 0, inputTokens: 0, outputTokens: 0 })).toBe(false);
    expect(isUnsettledPanelMetrics({ ...cold, totalTokens: 5, usagePartial: true })).toBe(false);
  });

  it('keeps a completed settle when a later header read is still a cold placeholder', () => {
    const merged = mergePanelMetrics(
      { main: cold, child: { ...counted, usageSource: 'live', totalTokens: 3, inputTokens: 2, outputTokens: 1 } },
      { main: counted },
    );
    expect(merged['main']).toMatchObject({ totalTokens: 14, usageSource: 'persisted' });
    expect(merged['child']).toMatchObject({ totalTokens: 3, usageSource: 'live' });
  });

  it('lets a newer complete persisted header replace an older settle', () => {
    const newer = { ...counted, totalTokens: 40, totalCostUsd: 0.08, inputTokens: 30, outputTokens: 10 };
    const merged = mergePanelMetrics({ main: newer }, { main: counted });
    expect(merged['main']).toMatchObject({ totalTokens: 40, totalCostUsd: 0.08 });
    expect(isCompletePanelMetrics(newer)).toBe(true);
    expect(isCompletePanelMetrics(cold)).toBe(false);
    expect(isCompletePanelMetrics(UNKNOWN_AGENT_PANEL_METRICS)).toBe(false);
  });

  it('lets the newer stamp win when both the header and the settle are complete', () => {
    const header = { ...counted, totalTokens: 40 };
    const settled = { ...counted, totalTokens: 14 };
    expect(mergePanelMetrics({ main: header }, { main: settled }, {
      headerStamp: 1,
      settledStamp: { main: 2 },
    })['main']).toMatchObject({ totalTokens: 14 });
    expect(mergePanelMetrics({ main: header }, { main: settled }, {
      headerStamp: 3,
      settledStamp: { main: 2 },
    })['main']).toMatchObject({ totalTokens: 40 });
  });

  it('does not let an unsettled settle row replace a live total', () => {
    const live = { ...counted, usageSource: 'live' as const, totalTokens: 8 };
    expect(mergePanelMetrics({ main: live }, { main: cold })['main']).toMatchObject({ totalTokens: 8, usageSource: 'live' });
  });

  it('keys one settle for the sorted tree and moves when the source revision or serverId moves', () => {
    expect(panelMetricsSettleKey('session', 'main', ['child', 'main'])).toEqual([
      'agentPanelMetrics', 'session', 'main', ['child', 'main'], '', '',
    ]);
    expect(panelMetricsSettleKey('session', 'main', ['main', 'child'], 'child=1', 'srv-1')).toEqual([
      'agentPanelMetrics', 'session', 'main', ['child', 'main'], 'child=1', 'srv-1',
    ]);
  });

  it('isolates capabilities query keys by spaceKey, scopeId and serverId while preserving agentCapabilities prefix', () => {
    const query = { session_id: 'session', agent_id: 'main' };
    expect(panelMetricsCapabilitiesKey(query, 'main', 'local', 'srv-1')).toEqual([
      'agentCapabilities', query, 'main', 'local', 'srv-1',
    ]);
    expect(panelMetricsCapabilitiesKey(query, 'other', 'remote', 'srv-2')).toEqual([
      'agentCapabilities', query, 'other', 'remote', 'srv-2',
    ]);
  });


  it('keeps a dead source stable and moves for usage, transcript, or roster changes', () => {
    expect(panelMetricsSourceRevision(undefined)).toBe('');
    const stable = { cursorSeq: 4, cursorEpoch: 'e', transcriptResetVersion: 1, usage: { total: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } } };
    expect(panelMetricsSourceRevision(stable)).toBe(panelMetricsSourceRevision({ ...stable }));
    expect(panelMetricsSourceRevision({ ...stable, cursorSeq: 99, usage: { ...stable.usage, currentTurn: { output: 9 } } })).toBe(panelMetricsSourceRevision(stable));
    expect(panelMetricsSourceRevision({ ...stable, usage: { total: { inputOther: 2, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } } })).not.toBe(panelMetricsSourceRevision(stable));
    expect(panelMetricsSourceRevision({ ...stable, cursorEpoch: 'rewritten' })).not.toBe(panelMetricsSourceRevision(stable));
    expect(panelMetricsSourceRevision({ rosterUsage: { total: { inputOther: 0, output: 3, inputCacheRead: 0, inputCacheCreation: 0 } } })).not.toBe('');
  });
});


it('does not retry a fully read unknown record but keeps an interrupted known prefix unsettled', () => {
  const unknown = { ...cold, usageComplete: true };
  expect(isUnsettledPanelMetrics(unknown)).toBe(false);
  expect(isCompletePanelMetrics(unknown)).toBe(true);
  expect(mergePanelMetrics({ main: unknown }, { main: counted })['main']).toEqual(unknown);
  expect(isUnsettledPanelMetrics({ ...counted, usageComplete: false, usagePartial: true })).toBe(true);
});

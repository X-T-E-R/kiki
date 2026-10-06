import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildAgentForest, sessionAgentForestFromAgentSnapshots, type AgentRosterDescriptor } from '@kiki/session-core/session';
import { CHILD_AGENT_ID, childFailureWireRecords, childRetryWireRecords, replayAgentWire } from '@kiki/session-core/session/__fixtures__/canonicalTranscript';
import { I18nProvider } from '../i18n';
import { AgentTreeView } from './AgentTreeView';
import { AgentIdentitySection } from './agent-panel/AgentIdentitySection';

function renderRow(entry: AgentRosterDescriptor): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AgentTreeView forest={buildAgentForest([], [entry])} onOpen={() => {}} />
    </I18nProvider>,
  );
}

describe('AgentTreeView tool-count display', () => {
  beforeAll(() => vi.stubGlobal('navigator', { language: 'en-US' }));
  afterAll(() => vi.unstubAllGlobals());

  it('shows an explicitly known terminal count, including zero', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'completed',
      toolCallCount: 0, toolCallCountKnown: true,
    });
    expect(html).toContain('Completed');
    expect(html).toContain('0 tools');
    expect(html).not.toContain('Not reported');
  });

  it('silently omits the count on an older terminal row with no stored value', () => {
    const html = renderRow({ agentId: 'child', name: 'Child', status: 'failed' });
    expect(html).toContain('Failed');
    expect(html).not.toContain(' tools');
    expect(html).not.toContain('Not reported');
  });

  it('silently omits an ambiguous in-progress count', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'running',
      toolCallCount: 0, toolCallCountKnown: false,
    });
    expect(html).toContain('Running');
    expect(html).not.toContain(' tools');
    expect(html).not.toContain('Not reported');
  });

  it('shows a waking child as refreshing without dropping its last-known metadata', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'completed', refreshing: true,
      refreshingUntil: new Date(Date.now() + 120_000).toISOString(),
      model: 'provider/previous', endedAt: '2026-01-01T00:00:02.000Z',
    });
    expect(html).toContain('Child');
    expect(html).toContain('Refreshing');
    expect(html).toContain('provider/previous');
    expect(html).toContain('bg-amber-rule');
    expect(html).not.toContain('Status unknown');
  });

  it('stops showing refresh feedback after the wake lease expires', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'completed', refreshing: true,
      refreshingUntil: new Date(Date.now() - 1).toISOString(),
    });
    expect(html).toContain('Completed');
    expect(html).not.toContain('Refreshing');
    expect(html).not.toContain('bg-amber-rule');
  });

  it('shows the same turn failure summary from live facts and a reopened cold transcript', () => {
    for (const cold of [false, true]) {
      const snapshot = replayAgentWire(CHILD_AGENT_ID, childFailureWireRecords, cold);
      const html = renderToStaticMarkup(<I18nProvider><AgentTreeView
        forest={sessionAgentForestFromAgentSnapshots(new Map([[CHILD_AGENT_ID, snapshot]]))}
        onOpen={() => {}}
      /></I18nProvider>);
      expect(html).toContain('data-agent-turn-outcome="failed"');
      expect(html).toContain('Last turn failed');
      expect(html).toContain('Connection closed');
      expect(html).not.toContain('retry 2/5 in');
    }
  });

  it('names the last failed attempt after recovery rather than claiming the provider is still retrying', () => {
    const snapshot = replayAgentWire(CHILD_AGENT_ID, childRetryWireRecords, true);
    const html = renderToStaticMarkup(<I18nProvider><AgentTreeView
      forest={sessionAgentForestFromAgentSnapshots(new Map([[CHILD_AGENT_ID, snapshot]]))}
      onOpen={() => {}}
    /></I18nProvider>);
    expect(html).toContain('Last turn cancelled');
    expect(html).toContain('Last attempt failed (APIConnectionError, 2/5): Connection closed');
    expect(html).not.toContain('retry 2/5 in');
  });

  it('renders a persisted terminal roster error as visible text, not just a tooltip', () => {
    const html = renderRow({ agentId: 'child', name: 'Child', status: 'failed', error: 'Connection closed' });
    expect(html).toContain('>Connection closed</span>');
  });

  it('keeps terminal, idle and unknown rows neutral and untimed even with a stale busy hint', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'lost', 'idle', 'unknown']) {
      const html = renderRow({ agentId: 'child', name: 'Child', status, busy: true, startedAt: '2026-01-01T00:00:00.000Z' });
      expect(html).not.toContain('status-dot-busy');
      expect(html).not.toContain('bg-success');
      expect(html).not.toMatch(/\d+h\s\d+m/);
    }
  });

  it('keeps the identity status mark inactive for terminal, unknown and idle identities', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'lost', 'unknown', 'idle'] as const) {
      const html = renderToStaticMarkup(<I18nProvider><AgentIdentitySection
        identity={{ id: 'child', profile: 'example', label: 'Recorded worker', status, context: 'live' }}
      /></I18nProvider>);
      expect(html).not.toContain('status-dot-busy');
      expect(html).not.toContain('bg-success');
    }
  });

  it('renders an unknown tree node instead of dropping the row', () => {
    const html = renderRow({ agentId: 'child', name: 'Child', status: 'unknown' });
    expect(html).toContain('Child');
    expect(html).toContain('Status unknown');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildAgentForest, type AgentRosterDescriptor } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { AgentTreeView } from './AgentTreeView';

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
    expect(html).toContain('completed');
    expect(html).toContain('0 tools');
    expect(html).not.toContain('Not reported');
  });

  it('silently omits the count on an older terminal row with no stored value', () => {
    const html = renderRow({ agentId: 'child', name: 'Child', status: 'failed' });
    expect(html).toContain('failed');
    expect(html).not.toContain(' tools');
    expect(html).not.toContain('Not reported');
  });

  it('silently omits an ambiguous in-progress count', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'running',
      toolCallCount: 0, toolCallCountKnown: false,
    });
    expect(html).toContain('running');
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
    expect(html).toContain('refreshing');
    expect(html).toContain('provider/previous');
    expect(html).toContain('bg-amber-rule');
    expect(html).not.toContain('status unknown');
  });

  it('stops showing refresh feedback after the wake lease expires', () => {
    const html = renderRow({
      agentId: 'child', name: 'Child', status: 'completed', refreshing: true,
      refreshingUntil: new Date(Date.now() - 1).toISOString(),
    });
    expect(html).toContain('completed');
    expect(html).not.toContain('refreshing');
    expect(html).not.toContain('bg-amber-rule');
  });

  it('renders an unknown tree node instead of dropping the row', () => {
    const html = renderRow({ agentId: 'child', name: 'Child', status: 'unknown' });
    expect(html).toContain('Child');
    expect(html).toContain('status unknown');
  });
});

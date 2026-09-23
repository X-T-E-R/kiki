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
});

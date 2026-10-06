// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentHooksInspect } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { AgentHooksSection } from './AgentHooksSection';
import { ApiError } from '../../lib/client';

const mockGetAgentHooksInspect = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      getAgentHooksInspect: mockGetAgentHooksInspect,
    },
  }),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function renderSection(sessionId = 's1', agentId = 'main') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <AgentHooksSection sessionId={sessionId} agentId={agentId} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  // Flush promises
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => { root.unmount(); });
      queryClient.clear();
      container.remove();
    },
  };
}

const sampleInspect: AgentHooksInspect = {
  revision: 'rev-1',
  binding: { executorId: 'exec-1', agentRole: 'root' },
  sources: [
    { namespace: 'workspace', path: '.kiki/hooks.ts', status: 'loaded' },
    { namespace: 'plugin', path: 'external/broken.ts', status: 'invalid' },
  ],
  diagnostics: [{ path: 'external/broken.ts', message: 'Syntax error on line 4' }],
  rules: [
    {
      id: 'guard-rule',
      path: '.kiki/hooks.ts',
      namespace: 'workspace',
      event: 'step.before',
      action: { type: 'inject' },
      active: true,
      completedSteps: 3,
      nextDue: 5,
      order: 0,
      resetPending: false,
    },
    {
      id: 'disabled-rule',
      path: '.kiki/hooks.ts',
      namespace: 'workspace',
      event: 'turn.after',
      action: { type: 'observe' },
      active: false,
      reason: 'Executor lacks observe capability',
      completedSteps: 0,
      order: 1,
      resetPending: false,
    },
  ],
};

describe('AgentHooksSection', () => {
  it('renders loading line while pending', async () => {
    mockGetAgentHooksInspect.mockReturnValue(new Promise(() => {}));
    const { container, cleanup } = await renderSection('s-loading', 'main');
    expect(container.querySelector('[data-agent-hooks-state="loading"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Reading automatic rules');
    await cleanup();
  });

  it('renders quiet unavailable line on 404', async () => {
    mockGetAgentHooksInspect.mockRejectedValue(new ApiError({ code: 404, msg: 'Not found', data: null }));
    const { container, cleanup } = await renderSection('s-404', 'main');
    expect(container.querySelector('[data-agent-hooks-state="unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain('This server cannot show automatic rules yet.');
    await cleanup();
  });

  it('renders load failed with retry on generic error', async () => {
    mockGetAgentHooksInspect.mockRejectedValue(new Error('Network drop'));
    const { container, cleanup } = await renderSection('s-err', 'main');
    expect(container.querySelector('[data-agent-hooks-state="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-retry]')).not.toBeNull();
    await cleanup();
  });

  it('renders nothing when no rule, source fault or diagnostic exists', async () => {
    mockGetAgentHooksInspect.mockResolvedValue({
      revision: 'rev-0',
      binding: { executorId: 'exec-1' },
      sources: [{ namespace: 'workspace', path: '.kiki/hooks.ts', status: 'absent' }],
      diagnostics: [],
      rules: [],
    });
    const { container, cleanup } = await renderSection('s-empty', 'main');
    expect(container.querySelector('[data-agent-hooks-section]')).toBeNull();
    expect(container.textContent).toBe('');
    await cleanup();
  });

  it('keeps the section when a source failed but no rule survived', async () => {
    mockGetAgentHooksInspect.mockResolvedValue({
      revision: 'rev-0',
      binding: { executorId: 'exec-1' },
      sources: [{ namespace: 'plugin', path: 'external/broken.ts', status: 'invalid' }],
      diagnostics: [{ path: 'external/broken.ts', message: 'Syntax error on line 4' }],
      rules: [],
    });
    const { container, cleanup } = await renderSection('s-faulty', 'main');
    expect(container.querySelector('[data-agent-hooks-state="faulty"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-summary]')?.textContent).toBe('Check sources');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { toggle.click(); });
    expect(container.querySelector('[data-agent-hooks-sources]')?.textContent).toContain('external/broken.ts');
    expect(container.querySelector('[data-agent-hooks-diagnostics]')?.textContent).toContain('Syntax error on line 4');
    expect(container.querySelector('[data-agent-hooks-rule]')).toBeNull();
    await cleanup();
  });

  it('recovers from a read failure and keeps the rules it then finds', async () => {
    mockGetAgentHooksInspect.mockRejectedValue(new Error('Network drop'));
    const { container, cleanup } = await renderSection('s-recover', 'main');
    expect(container.querySelector('[data-agent-hooks-state="failed"]')).not.toBeNull();

    mockGetAgentHooksInspect.mockResolvedValue({ ...sampleInspect, sources: [], diagnostics: [] });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-agent-hooks-retry]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-agent-hooks-state="ready"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-summary]')?.textContent).toBe('1 active');
    expect(container.querySelector('[data-agent-hooks-retry]')).toBeNull();
    await cleanup();
  });

  it('renders summary when closed and unfolds rules + degraded sources + diagnostics', async () => {
    mockGetAgentHooksInspect.mockResolvedValue(sampleInspect);
    const { container, cleanup } = await renderSection('s-ready', 'main');
    expect(container.querySelector('[data-agent-hooks-state="faulty"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-summary]')?.textContent).toBe('Check sources');
    expect(container.textContent).toContain('Automatic rules');

    // Unfold
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    // Check rules rendered
    expect(container.querySelector('[data-agent-hooks-rule="guard-rule"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-rule="disabled-rule"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-inactive]')?.textContent).toBe('inactive');

    // Check degraded sources block
    expect(container.querySelector('[data-agent-hooks-sources]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-sources]')?.textContent).toContain('external/broken.ts');

    // Check diagnostics block
    expect(container.querySelector('[data-agent-hooks-diagnostics]')?.textContent).toContain('Syntax error on line 4');

    await cleanup();
  });

  it('keeps a loaded source out of the fault list and shows a rule set with no fault', async () => {
    mockGetAgentHooksInspect.mockResolvedValue({
      revision: 'rev-2',
      binding: { executorId: 'exec-1' },
      sources: [{ namespace: 'workspace', path: '.kiki/hooks.ts', status: 'loaded' }],
      diagnostics: [],
      rules: [sampleInspect.rules[0]],
    });
    const { container, cleanup } = await renderSection('s-clean', 'main');
    expect(container.querySelector('[data-agent-hooks-state="ready"]')).not.toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => { toggle.click(); });
    expect(container.querySelector('[data-agent-hooks-rule="guard-rule"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-hooks-sources]')).toBeNull();
    expect(container.querySelector('[data-agent-hooks-diagnostics]')).toBeNull();
    await cleanup();
  });
});

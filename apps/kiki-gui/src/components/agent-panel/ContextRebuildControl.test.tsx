// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../i18n';
import type { AgentPromptDiagnostics } from '@kiki/protocol';
import { ContextRebuildControl } from './ContextRebuildControl';
import { PromptEffectiveDetails } from './PromptEffectiveDetails';

const control = vi.fn();
const setEnabled = vi.fn();
const rebuild = vi.fn();
const session = vi.fn((sessionId: string) => ({
  agent: (agentId: string) => ({
    contextRebuildControl: () => control(sessionId, agentId),
    setContextRebuildEnabled: setEnabled,
    rebuildContext: rebuild,
  }),
}));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => ({ klient: { session } }),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(ids: { sessionId?: string; agentId?: string } = {}): Promise<void> {
  const sessionId = ids.sessionId ?? 'session-1';
  const agentId = ids.agentId ?? 'main';
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider>
      <ContextRebuildControl sessionId={sessionId} agentId={agentId} />
    </I18nProvider></QueryClientProvider>);
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

const prompt: AgentPromptDiagnostics = {
  identity: { delegation_position: 'main', profile: 'agent', executor: 'native' },
  apply_on: 'next-binding-or-context-rebuild',
  channels: [
    { id: 'system.shared', channel: 'system', state: 'effective', sources: [] },
  ],
};

async function renderDiagnostic(): Promise<void> {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider>
      <PromptEffectiveDetails value={prompt} query={{ session_id: 'session-1', agent_id: 'main' }} defaultOpen />
    </I18nProvider></QueryClientProvider>);
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function openSystemChannel(): Promise<void> {
  const details = container.querySelector<HTMLDetailsElement>('details[data-prompt-channel="system.shared"]');
  await act(async () => {
    if (details === null) return;
    details.open = true;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
}

const applied = {
  enabled: true,
  outcome: 'applied' as const,
  trigger: 'compaction' as const,
  at: '2026-10-25T01:02:03.000Z',
  changes: { profile: true, promptFields: false, skills: false, instructions: false, plugins: false, mcp: false, injections: false },
  rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'],
  unsupported: [],
};

describe('ContextRebuildControl', () => {
  it('keeps the default face to the switch and leaves the source list out of the DOM', async () => {
    control.mockResolvedValue(applied);
    await render();
    expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Auto-update context');
    expect(container.querySelector('h4')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-surface]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-outcome]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-applies]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-error]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    expect(container.querySelector('ul')).toBeNull();
    expect(container.textContent).not.toContain('Last rebuild');
    expect(container.textContent).not.toContain('system prompt');
    expect(container.textContent).not.toContain('frozen for the conversation');
    expect(container.textContent).not.toMatch(/\brestart\b/i);
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')?.getAttribute('aria-label')).toBe('After compaction');
    expect(container.querySelector('details[data-context-rebuild-sources]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-sources]')).toBeNull();
    expect(container.textContent).not.toContain('Sources');
    expect(container.textContent).not.toContain('Updated');
    expect(container.textContent).not.toContain('Unchanged');
  });

  it('keeps a main-agent failure to one error line and retries through the same rebuild', async () => {
    control.mockResolvedValue({
      enabled: true,
      outcome: 'failed',
      trigger: 'restore',
      at: '2026-10-25T01:02:03.000Z',
      error: 'disk down',
      rebuilt: [],
      unsupported: [],
    });
    rebuild.mockRejectedValue(new Error('still down'));
    await render();
    expect(container.querySelector('[data-context-rebuild-surface]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('disk down');
    expect(container.querySelector('[data-context-rebuild-retry]')?.textContent).toBe('Retry');
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-rebuild-retry]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('still down');
  });

  it('does not offer manual rebuild on a non-main agent', async () => {
    control.mockResolvedValue({
      enabled: true,
      outcome: 'failed',
      trigger: 'restore',
      at: '2026-10-25T01:02:03.000Z',
      error: 'disk down',
      rebuilt: [],
      unsupported: [],
    });
    await render({ agentId: 'child' });
    expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Auto-update context');
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('disk down');
    expect(container.querySelector('[data-context-rebuild] button')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('drops the previous session report when the session changes', async () => {
    let releaseB: (value: { enabled: boolean; rebuilt: []; unsupported: [] }) => void = () => {};
    const gate = new Promise<{ enabled: boolean; rebuilt: []; unsupported: [] }>((resolve) => { releaseB = resolve; });
    control.mockImplementation((sessionId: string) => {
      if (sessionId === 'session-b') return gate;
      return Promise.resolve({
        enabled: true, outcome: 'failed', trigger: 'restore', at: '2026-10-25T01:02:03.000Z',
        error: 'disk down', rebuilt: [], unsupported: [],
      });
    });
    rebuild.mockRejectedValue(new Error('still down'));
    await render({ sessionId: 'session-a' });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-rebuild-retry]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('still down');
    await render({ sessionId: 'session-b' });
    expect(container.textContent).not.toContain('still down');
    expect(container.textContent).not.toContain('disk down');
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    releaseB({ enabled: false, rebuilt: [], unsupported: [] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).not.toContain('disk down');
  });

  it('clears the previous result before the next agent control arrives', async () => {
    let release: (value: { enabled: boolean; rebuilt: []; unsupported: [] }) => void = () => {};
    const gate = new Promise<{ enabled: boolean; rebuilt: []; unsupported: [] }>((resolve) => { release = resolve; });
    control.mockImplementation((sessionId: string, agentId: string) => {
      if (sessionId === 'session-b' || agentId === 'child') return gate;
      return Promise.resolve(applied);
    });
    await render({ sessionId: 'session-a', agentId: 'main' });
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).not.toBeNull();
    await render({ sessionId: 'session-b', agentId: 'main' });
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-error]')).toBeNull();
    expect(container.textContent).not.toContain('After compaction');
    await render({ sessionId: 'session-a', agentId: 'child' });
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild] button')).toBeNull();
    expect(container.textContent).not.toContain('After compaction');
    release({ enabled: false, rebuilt: [], unsupported: [] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).toBeNull();
  });

  it('does not start another read while the previous one is still running', async () => {
    vi.useFakeTimers();
    let release: (value: typeof applied) => void = () => {};
    const gate = new Promise<typeof applied>((resolve) => { release = resolve; });
    control.mockImplementation(() => gate);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><I18nProvider>
        <ContextRebuildControl sessionId="session-1" agentId="main" />
      </I18nProvider></QueryClientProvider>);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(control).toHaveBeenCalledTimes(1);
    control.mockResolvedValue(applied);
    release(applied);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(control.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(control).toHaveBeenCalledTimes(2);
  });

  it('names each context boundary inside the diagnostic instead of a generic restart', async () => {
    const triggers = [
      ['fresh_start', 'After a fresh start'],
      ['summary', 'After a summary'],
      ['model_switch_fresh', 'After a fresh context window'],
      ['model_switch_compact', 'After a compacted context window'],
      ['context_clear', 'After clearing the context'],
      ['restore', 'After session recovery'],
    ] as const;
    for (const [trigger, label] of triggers) {
      control.mockResolvedValue({
        ...applied,
        trigger,
        changes: { profile: false, promptFields: false, skills: false, instructions: false, plugins: false, mcp: false, injections: false },
      });
      await render({ sessionId: trigger });
      expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Auto-update context');
      expect(container.querySelector('[data-context-rebuild-surface]')).toBeNull();
      expect(container.querySelector('[data-context-rebuild-mark="applied"]')?.getAttribute('aria-label')).toBe(label);
      expect(container.textContent).not.toContain(`agentPanel.rebuild.trigger.${trigger}`);
      expect(container.textContent).not.toMatch(/\brestart\b/i);
    }
    expect(container.textContent).not.toContain('model switch that keeps the current context');
  });

  it('keeps an unsupported executor boundary in the diagnostic instead of calling it refreshed', async () => {
    control.mockResolvedValue({
      enabled: false,
      outcome: 'applied',
      trigger: 'manual',
      at: '2026-10-25T01:02:03.000Z',
      changes: { profile: false, promptFields: false, skills: false, instructions: false, plugins: false, mcp: false, injections: false },
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'mcp'],
      unsupported: [
        { surface: 'executor_session', reason: 'The running codex session is not restarted.' },
        { surface: 'plugins', reason: 'Plugin session-start reminders are native context.' },
        { surface: 'injections', reason: 'Native context injections are not applied.' },
      ],
    });
    await render();
    expect(container.querySelector('[data-context-rebuild-surface]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    expect(container.textContent).not.toContain('codex');
    expect(container.querySelector('ul')).toBeNull();
  });

  it('shows the source range only after the existing prompt channel is opened', async () => {
    control.mockResolvedValue({
      ...applied,
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'mcp'],
      unsupported: [
        { surface: 'executor_session', reason: 'The running codex session is not restarted.' },
        { surface: 'plugins', reason: 'Plugin session-start reminders are native context.' },
      ],
    });
    await renderDiagnostic();
    expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Auto-update context');
    expect(container.querySelector('[data-context-rebuild-surface]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    expect(container.textContent).not.toContain('codex');
    expect(container.textContent).not.toContain('Last rebuild');
    await openSystemChannel();
    expect(container.querySelector('details[data-context-rebuild-sources]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-surface="profile"]')?.getAttribute('data-context-rebuild-status')).toBe('updated');
    expect(container.querySelector('[data-context-rebuild-surface="skills"]')?.getAttribute('data-context-rebuild-status')).toBe('unchanged');
    expect(container.querySelector('[data-context-rebuild-surface="plugins"]')?.getAttribute('data-context-rebuild-status')).toBe('unsupported');
    expect(container.querySelector('[data-context-rebuild-surface="executor_session"]')?.textContent).toContain('codex');
    expect(container.querySelector('[data-prompt-channel="system.shared"]')?.textContent).not.toContain('Last rebuild');
  });

  it('leaves an uncompared source unlabeled instead of calling it unchanged', async () => {
    control.mockResolvedValue({
      enabled: true,
      outcome: 'partial',
      trigger: 'manual',
      at: '2026-10-25T01:02:03.000Z',
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins'],
      unsupported: [],
    });
    await renderDiagnostic();
    await openSystemChannel();
    const profile = container.querySelector('[data-context-rebuild-surface="profile"]');
    const mcp = container.querySelector('[data-context-rebuild-surface="mcp"]');
    expect(profile?.getAttribute('data-context-rebuild-status')).toBe('unknown');
    expect(profile?.textContent).not.toContain('Unchanged');
    expect(profile?.textContent).not.toContain('Updated');
    expect(mcp?.getAttribute('data-context-rebuild-status')).toBe('unfinished');
    expect(container.textContent).not.toContain('Unchanged');
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../i18n';
import { ContextRebuildControl } from './ContextRebuildControl';

const control = vi.fn();
const setEnabled = vi.fn();
const rebuild = vi.fn();
const session = vi.fn(() => ({ agent: () => ({ contextRebuildControl: control, setContextRebuildEnabled: setEnabled, rebuildContext: rebuild }) }));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => ({ klient: { session } }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  const queryClient = new QueryClient();
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider>
      <ContextRebuildControl sessionId="session-1" agentId="main" />
    </I18nProvider></QueryClientProvider>);
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function sources(): HTMLDetailsElement | null {
  return container.querySelector('details[data-context-rebuild-sources]');
}

describe('ContextRebuildControl', () => {
  it('keeps the default face to the switch and a small finished mark', async () => {
    control.mockResolvedValue({
      enabled: true,
      outcome: 'applied',
      trigger: 'compaction',
      at: '2026-10-25T01:02:03.000Z',
      changes: { profile: true, promptFields: false, skills: false, instructions: false, plugins: false, mcp: false, injections: false },
      rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'],
      unsupported: [],
    });
    await render();
    expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Rebuild context');
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')?.getAttribute('aria-label')).toBe('After compaction');
    expect(container.querySelector('[data-context-rebuild-error]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-applies]')).toBeNull();
    expect(container.textContent).not.toContain('system prompt');
    expect(container.textContent).not.toContain('frozen for the conversation');
    expect(container.textContent).not.toMatch(/\brestart\b/i);
    const details = sources();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Sources');
    expect(details?.querySelector('[data-context-rebuild-surface="profile"]')?.getAttribute('data-context-rebuild-status')).toBe('updated');
    expect(details?.querySelector('[data-context-rebuild-surface="skills"]')?.getAttribute('data-context-rebuild-status')).toBe('unchanged');
    expect(details?.querySelector('[data-context-rebuild-outcome="applied"]')?.textContent).toContain('After compaction');
  });

  it('keeps the failure to one error line and retries through the same rebuild', async () => {
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
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('disk down');
    expect(container.querySelector('[data-context-rebuild-retry]')?.textContent).toBe('Retry');
    expect(container.querySelector('[data-context-rebuild-mark="applied"]')).toBeNull();
    expect(container.querySelector('[data-context-rebuild-applies]')).toBeNull();
    const details = sources();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('[data-context-rebuild-outcome="failed"]')).not.toBeNull();
    expect(details?.querySelector('[data-context-rebuild-surface="profile"]')?.getAttribute('data-context-rebuild-status')).toBe('unfinished');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-context-rebuild-retry]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-context-rebuild-error]')?.textContent).toBe('still down');
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
        enabled: true, outcome: 'applied', trigger, at: '2026-10-25T01:02:03.000Z',
        changes: { profile: false, promptFields: false, skills: false, instructions: false, plugins: false, mcp: false, injections: false },
        rebuilt: ['profile', 'prompt_fields', 'skills', 'instructions', 'plugins', 'mcp', 'injections'],
        unsupported: [],
      });
      await render();
      expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Rebuild context');
      expect(container.querySelector('[data-context-rebuild-mark="applied"]')?.getAttribute('aria-label')).toBe(label);
      expect(sources()?.open).toBe(false);
      expect(sources()?.querySelector('[data-context-rebuild-outcome="applied"]')?.textContent).toContain(label);
      expect(container.textContent).not.toContain(`agentPanel.rebuild.trigger.${trigger}`);
    }
    expect(container.textContent).not.toContain('model switch that keeps the current context');
    expect(container.textContent).not.toMatch(/\brestart\b/i);
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
    expect(container.querySelector('[data-context-rebuild-switch]')?.textContent).toBe('Rebuild context');
    expect(container.querySelector('[data-context-rebuild-retry]')).toBeNull();
    const details = sources();
    expect(details?.open).toBe(false);
    expect(details?.querySelector('[data-context-rebuild-surface="plugins"]')?.getAttribute('data-context-rebuild-status')).toBe('unsupported');
    expect(details?.querySelector('[data-context-rebuild-surface="executor_session"]')?.textContent).toContain('codex');
    expect(details?.querySelector('[data-context-rebuild-surface="executor_session"]')?.textContent).not.toContain('Updated');
  });
});

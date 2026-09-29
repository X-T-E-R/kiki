// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { AgentMessagingCard } from './CommunicationSection';
import { LoopLimitsCard } from './LoopLimitsCard';
import { RetryPolicyCard } from './RetryPolicyCard';
import { SessionResidencyCard } from './SessionResidencyCard';
import { TaskPolicyCard } from './TaskRuntimeSettings';
import { WorktreePolicy } from './WorktreePolicy';
import { commitText, pickValue, selectText } from './testControls';

const getConfig = vi.fn();
const patchConfig = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig } }),
}));

const CONFIG = {
  agents: { notify_parent: true },
  thread_communication: { enabled: true },
  loop_control: { autoCompact: '85%', maxAttemptsPerStep: 5 },
  task: { maxRunningTasks: 4 },
  session_residency: { idleTtlMs: 600_000, maxLiveSessions: 8, minIdleMs: 60_000, sweepIntervalMs: 30_000, maxConcurrentRestores: 1, maxQueuedRestores: 8 },
  worktree: {
    enabled: true, root: '', branchPrefix: 'kiki/', defaultBase: 'head', gitTimeoutMs: 300_000,
    cleanup: { auto: true, afterDays: 7, disposableIgnored: ['node_modules/', 'dist/'] },
  },
} as unknown as KikiConfigResponse;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getConfig.mockReset().mockResolvedValue(CONFIG);
  patchConfig.mockReset().mockResolvedValue(CONFIG);
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider>{node}</I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('config gap cards', () => {
  it('saves each delegation notice switch as its own agents.delegation merge', async () => {
    const container = await render(<AgentMessagingCard />);
    const sub = container.querySelector<HTMLInputElement>('[data-agent-messaging="delegation-sub"] input[type="checkbox"]')!;
    const independent = container.querySelector<HTMLInputElement>('[data-agent-messaging="delegation-independent"] input[type="checkbox"]')!;
    expect(sub.checked).toBe(true);
    expect(independent.checked).toBe(true);
    await click(sub);
    expect(patchConfig).toHaveBeenLastCalledWith({ agents: { delegation: { sub: false } } });
    await click(independent);
    expect(patchConfig).toHaveBeenLastCalledWith({ agents: { delegation: { independent: false } } });
  });

  it('merges turn limits into loop_control without replacing the domain', async () => {
    const container = await render(<LoopLimitsCard />);
    const steps = container.querySelector<HTMLInputElement>('[data-loop-max-steps]')!;
    expect(steps.value).toBe('');
    await commitText(steps, '40');
    expect(patchConfig).toHaveBeenLastCalledWith({ loop_control: { max_steps_per_turn: 40 } });
    const attempts = container.querySelector<HTMLInputElement>('[data-loop-max-attempts]')!;
    expect(attempts.value).toBe('5');
    await commitText(attempts, 'x');
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('whole number');
    const strategy = container.querySelector('[data-loop-subagent-strategy]')!;
    expect(selectText(strategy)).toContain('Summarize');
    await pickValue(strategy, 'data-loop-subagent-strategy', 'fresh');
    expect(patchConfig).toHaveBeenLastCalledWith({ loop_control: { subagent_context_strategy: 'fresh' } });
    for (const [patch] of patchConfig.mock.calls) expect(patch).not.toHaveProperty('replace_domains');
  });

  it('sends bash_file_tool_hints with the task policy draft', async () => {
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const hints = [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label')?.textContent?.includes('Suggest file tools'))!;
    expect(hints.checked).toBe(true);
    await click(hints);
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig.mock.calls[0]![0]).toMatchObject({ task: { bash_file_tool_hints: false } });
  });

  it('writes a residency duration in ms from seconds and rejects out-of-range counts', async () => {
    const container = await render(<SessionResidencyCard />);
    const idle = container.querySelector<HTMLInputElement>('[data-residency-idle-ttl-ms]')!;
    expect(idle.value).toBe('600');
    await commitText(idle, '120');
    expect(patchConfig).toHaveBeenLastCalledWith({ session_residency: { idle_ttl_ms: 120_000 } });
    const live = container.querySelector<HTMLInputElement>('[data-residency-max-live-sessions]')!;
    await commitText(live, '0');
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('from 1 to 64');
  });

  it('replaces the retry domain with ordered, validated policies', async () => {
    const container = await render(<RetryPolicyCard />);
    const card = container.querySelector('#st-card-retry')!;
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Add policy')!);
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('error pattern');
    const row = card.querySelector('[data-retry-policy="0"]')!;
    const [match, attempts, backoff] = [...row.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')];
    await type(match!, '^provider\\.rate_limit$');
    await type(attempts!, '6');
    await type(backoff!, '1000');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig).toHaveBeenCalledWith({
      retry: { policies: [{ match: '^provider\\.rate_limit$', max_attempts: 6, backoff: 1000, retry: true }] },
      replace_domains: ['retry'],
    });
  });

  it('saves worktree policy fields one at a time and validates the branch prefix', async () => {
    const container = await render(<WorktreePolicy />);
    await click(container.querySelector('[data-worktree-base="fresh"]')!);
    expect(patchConfig).toHaveBeenLastCalledWith({ worktree: { default_base: 'fresh' } });
    const prefix = container.querySelector<HTMLInputElement>('[data-worktree-prefix]')!;
    await commitText(prefix, 'Agent');
    expect(patchConfig).toHaveBeenCalledTimes(1);
    await commitText(prefix, 'agent/');
    expect(patchConfig).toHaveBeenLastCalledWith({ worktree: { branch_prefix: 'agent/' } });
    await commitText(container.querySelector<HTMLInputElement>('[data-worktree-after-days]')!, '3');
    expect(patchConfig).toHaveBeenLastCalledWith({ worktree: { cleanup: { after_days: 3 } } });
    await commitText(container.querySelector<HTMLInputElement>('[data-worktree-git-timeout]')!, '45');
    expect(patchConfig).toHaveBeenLastCalledWith({ worktree: { git_timeout_ms: 45_000 } });
    const disposable = container.querySelector<HTMLTextAreaElement>('[data-worktree-disposable]')!;
    expect(disposable.value).toBe('node_modules/\ndist/');
    await type(disposable, 'node_modules/\n.venv/\n\nnode_modules/');
    await act(async () => { disposable.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(patchConfig).toHaveBeenLastCalledWith({ worktree: { cleanup: { disposable_ignored: ['node_modules/', '.venv/'] } } });
  });
});

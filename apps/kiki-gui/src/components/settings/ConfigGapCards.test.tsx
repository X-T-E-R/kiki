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
import { CronRuntimeCard, TaskPolicyCard } from './TaskRuntimeSettings';
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

  it('keeps everyday task limits on the card, moves the CLI run and kill grace under Advanced', async () => {
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const advanced = card.querySelector('[data-task-policy-advanced]')!;
    const fieldFor = (label: string) => [...card.querySelectorAll('label')]
      .find((node) => node.textContent === label)!.control as HTMLInputElement;
    for (const label of ['Maximum running tasks', 'Bash task timeout (s)']) {
      expect(advanced.contains(fieldFor(label))).toBe(false);
    }
    for (const label of ['Wait ceiling (s)', 'Maximum steered turns', 'Kill grace period (ms)']) {
      expect(advanced.contains(fieldFor(label))).toBe(true);
    }
    // The rule "empty uses the engine default" is stated once, by the card
    // lead. Each number's own default, its 0, and its floor live behind that
    // field's `i` — the page opens without five copies of the same sentence.
    expect(card.textContent).toContain('A number left empty uses the engine default.');
    expect(card.textContent).not.toContain('Empty allows any number of background tasks at once');
    // A switch already shows whether it is on: "on by default" restated under
    // it told a reader nothing they could not see. What each switch *does*
    // stays, because that is not visible anywhere else.
    for (const suffix of ['On by default.', 'Off by default.']) {
      expect(card.textContent).not.toContain(suffix);
    }
    expect(card.textContent).toContain('keeps running as a background task instead of being stopped.');
    expect(card.textContent).toContain('leaves running background tasks alone instead of stopping them.');
    expect(card.textContent).toContain('add a short hint pointing to Read, Grep or Edit.');
    const openHelp = async (label: string): Promise<string> => {
      const node = [...card.querySelectorAll('label')].find((entry) => entry.textContent === label)!;
      const trigger = node.parentElement!.querySelector<HTMLButtonElement>('[data-setting-help]')!;
      await act(async () => { trigger.click(); });
      // Read through this trigger's own describedby target: only one bubble is
      // open at a time, so the page-level query would prove nothing.
      const id = trigger.getAttribute('aria-describedby');
      return id === null ? '' : document.querySelector(`#${id}`)?.textContent ?? '';
    };
    expect(await openHelp('Maximum running tasks')).toContain('At least 1.');
    expect(await openHelp('Bash task timeout (s)')).toContain('600 s');
    expect(await openHelp('Wait ceiling (s)')).toContain('2147483 s');
    expect(await openHelp('Maximum steered turns')).toContain('100000');
    expect(await openHelp('Kill grace period (ms)')).toContain('5000 ms');
    expect(card.textContent).toContain('Command-line non-interactive runs');
  });

  it('names the three non-interactive outcomes and keeps the stored value as a caption', async () => {
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const choices = [...card.querySelectorAll<HTMLElement>('[data-task-print-mode-choice]')];
    expect(choices.map((choice) => choice.dataset['taskPrintModeChoice'])).toEqual(['exit', 'drain', 'steer']);
    expect(choices[0]!.textContent).toContain('Exit right away');
    expect(choices[1]!.textContent).toContain('Wait for tasks, then exit');
    expect(choices[2]!.textContent).toContain('Stay running, steer turns');
    for (const [index, mode] of ['exit', 'drain', 'steer'].entries()) {
      expect(choices[index]!.textContent).toContain(mode);
    }
    // The picker shows the engine's own default, so a config with no explicit mode reads as steer.
    expect((card.querySelector('[data-task-print-mode]') as HTMLElement).dataset['taskPrintMode']).toBe('steer');
    await click(choices[1]!.querySelector('input')!);
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig.mock.calls[0]![0]).toMatchObject({ task: { print_background_mode: 'drain' } });
  });

  it('reads the auto-background switch as the engine default and writes an explicit value', async () => {
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const toggle = (label: string) => [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label')?.textContent?.includes(label))!;
    // The engine auto-backgrounds a timed-out command unless told not to.
    expect(toggle('Auto-background Bash on timeout').checked).toBe(true);
    expect(toggle('Keep tasks alive on exit').checked).toBe(false);
    await click(toggle('Auto-background Bash on timeout'));
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig.mock.calls[0]![0]).toMatchObject({ task: { bash_auto_background_on_timeout: false } });
  });

  it('clears a saved CLI limit instead of writing the engine default', async () => {
    getConfig.mockResolvedValue({ ...CONFIG, task: { printWaitCeilingS: 30, printMaxTurns: 12 } });
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const wait = [...card.querySelectorAll('label')].find((node) => node.textContent === 'Wait ceiling (s)')!.control as HTMLInputElement;
    expect(wait.value).toBe('30');
    await type(wait, '');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    const patch = patchConfig.mock.calls.at(-1)![0] as { task: Record<string, unknown> };
    expect(patch.task['print_wait_ceiling_s']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(patch.task))).not.toHaveProperty('print_wait_ceiling_s');
    expect(patch.task['print_max_turns']).toBe(12);
  });

  it('keeps the task draft and names the failure when the save is rejected', async () => {
    getConfig.mockResolvedValue({ task: { maxRunningTasks: 4 } });
    patchConfig.mockRejectedValueOnce(new Error('server offline'));
    const container = await render(<TaskPolicyCard />);
    const card = container.querySelector('#st-card-task-policy')!;
    const maxRunning = [...card.querySelectorAll('label')].find((node) => node.textContent === 'Maximum running tasks')!.control as HTMLInputElement;
    expect(maxRunning.value).toBe('4');
    await type(maxRunning, '6');
    const save = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await click(save);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('server offline');
    // The draft is still the user's, not the last stored value.
    expect(maxRunning.value).toBe('6');
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('shows cron diagnostics as on/off in readable units and never as controls', async () => {
    getConfig.mockResolvedValue({
      ...CONFIG,
      cron: { debug: true, noJitter: false, noStale: true, disabled: false, manualTick: false, clock: 'utc', pollIntervalMs: 30_000 },
    });
    const container = await render(<CronRuntimeCard />);
    const card = container.querySelector('#st-card-cron')!;
    const rowValue = (label: string) => [...card.querySelectorAll('dt')]
      .find((term) => term.textContent === label)!.nextElementSibling!.textContent;
    expect(rowValue('Debug logging')).toBe('On');
    expect(rowValue('Disable jitter')).toBe('Off');
    expect(rowValue('Manual tick mode')).toBe('Off');
    expect(rowValue('Clock')).toBe('utc');
    expect(rowValue('Poll interval (s)')).toBe('30');
    expect(card.querySelector('input, [role="switch"]')).toBeNull();
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

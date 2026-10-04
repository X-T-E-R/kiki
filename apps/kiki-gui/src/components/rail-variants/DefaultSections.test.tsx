// @vitest-environment jsdom

/**
 * The rail's 能力 block (DefaultSections CapabilitiesBlock): folded is the
 * head's per-kind counts and nothing else, because the names behind them read
 * as a wall of slugs rather than a summary — they live in the block's own
 * detail, where each carries its scope and state. A failed read (or an answer
 * without the capability fields) keeps the block as a plain title, one grey
 * status line and a text retry — "can't be read right now", never an alert and
 * never a silent gap.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { CapabilitiesBlock } from './DefaultSections';

const { readCapabilities } = vi.hoisted(() => ({ readCapabilities: vi.fn() }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) => readCapabilities(query, options.signal),
        },
      },
    },
  }),
  useOptionalControllerRegistry: () => null,
}));

const full: AgentCapabilitiesResponse = {
  context: 'live',
  owner: { profile: 'agent', agent_id: 'main' },
  available: true,
  tools: [
    { name: 'Read', source: 'builtin', category: 'filesystem', state: 'enabled' },
    { name: 'Write', source: 'builtin', category: 'filesystem', state: 'enabled' },
    { name: 'Bash', source: 'builtin', category: 'shell', state: 'enabled' },
    { name: 'Grep', source: 'builtin', category: 'filesystem', state: 'disabled' },
    { name: 'mcp__github__search_issues', source: 'mcp', category: 'mcp', state: 'enabled' },
    { name: 'mcp__figma__get_frame', source: 'mcp', category: 'mcp', state: 'disconnected' },
  ],
  skills: [
    { name: 'release-notes', description: 'Draft release notes', source: 'project', scope: 'workspace', path: 'w/release-notes/SKILL.md', state: 'enabled' },
    { name: 'api-diff', description: 'Compare API snapshots', source: 'project', scope: 'workspace', path: 'w/api-diff/SKILL.md', state: 'enabled' },
    { name: 'code-review', description: 'Review a diff', source: 'user', scope: 'global', path: 'g/code-review/SKILL.md', state: 'enabled' },
    { name: 'disabled-skill', description: 'Switched off', source: 'user', scope: 'global', path: 'g/disabled/SKILL.md', state: 'disabled' },
  ],
  targets: [
    { profile: 'explore', executor: 'native', defaults_available: true, launch_allowed: true },
    { profile: 'release-bot', executor: 'native', defaults_available: true, launch_allowed: false, launch_unavailable_reason_code: 'strict_subagent_policy_blocked' },
  ],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  readCapabilities.mockReset();
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'zh');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <CapabilitiesBlock sessionId="sess-1" agentId="main" />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

describe('CapabilitiesBlock', () => {
  it('folds to the counts head alone, and expands onto the named detail', async () => {
    readCapabilities.mockResolvedValue(full);
    await render();
    await settle();
    const block = container.querySelector('[data-rail-capabilities]')!;
    // Folded: the head keeps the per-kind counts, the tabs stay unmounted.
    const head = block.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('工具 3 · 技能 4 · 子智能体 2 · 扩展 2');
    expect(block.querySelector('[data-agent-capabilities-section]')).toBeNull();
    // No name pile-up above the fold. Those slugs are a wall of ids, and the
    // detail below carries each one with its scope and state.
    expect(block.querySelector('[data-rail-capabilities-preview]')).toBeNull();
    expect(block.textContent).not.toContain('api-diff');
    expect(block.textContent).not.toContain('release-notes');
    expect(block.textContent).not.toContain('+1');
    // Open: the full tabs mount, where every name is readable on purpose —
    // each behind its own tab, with its scope and state.
    await act(async () => { head.click(); });
    expect(block.querySelector('[data-agent-capabilities-section]')).not.toBeNull();
    expect(block.querySelector('[data-capability-tab-button="skills"]')).not.toBeNull();
    const skills = block.querySelector<HTMLButtonElement>('[data-capability-tab-button="skills"]')!;
    await act(async () => { skills.click(); });
    expect(block.textContent).toContain('api-diff');
    expect(block.textContent).toContain('release-notes');
    // Close: the block is the counts head again, and nothing more.
    await act(async () => { head.click(); });
    expect(block.querySelector('[data-agent-capabilities-section]')).toBeNull();
    expect(block.textContent).not.toContain('api-diff');
  });

  it('keeps every usable name reachable in the detail, disabled ones out of the counts', async () => {
    readCapabilities.mockResolvedValue({
      context: 'live',
      owner: { profile: 'agent', agent_id: 'main' },
      available: true,
      tools: full.tools!.filter((tool) => tool.source === 'builtin'),
      skills: [],
      targets: [],
    });
    await render();
    await settle();
    // Built-ins alone: 3 of 4 enabled (Grep is off), and no name line at all.
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    expect(head.textContent).toContain('工具 3');
    expect(container.querySelector('[data-rail-capabilities-preview]')).toBeNull();
    await act(async () => { head.click(); });
    expect(container.querySelector('[data-agent-capabilities-section]')).not.toBeNull();
  });

  it('shows a quiet status line with a text retry when the read fails, and recovers', async () => {
    readCapabilities.mockRejectedValueOnce(new Error('fixture offline'));
    await render();
    await settle();
    const block = container.querySelector('[data-rail-capabilities]')!;
    // The block stays: title, one grey line, a text retry. No alert, no fold.
    expect(block.textContent).toContain('能力');
    const status = block.querySelector('[data-rail-capabilities-unavailable]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.className).toContain('text-ink-faint');
    expect(status.className).not.toMatch(/danger|amber|attention/);
    expect(status.textContent).toContain('暂时读不到能力信息。');
    expect(block.querySelector('[role="alert"]')).toBeNull();
    expect(block.querySelector('[aria-expanded]')).toBeNull();
    const retry = block.querySelector<HTMLButtonElement>('[data-rail-capabilities-retry]')!;
    expect(retry.textContent).toBe('重试');
    readCapabilities.mockResolvedValue(full);
    await act(async () => { retry.click(); });
    await settle();
    expect(readCapabilities).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
    // Back to a working folded block: counts, no alert, nothing left over.
    expect(container.querySelector('[data-rail-capabilities]')?.textContent).toContain('工具 3');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the same quiet line when the answer lacks the capability fields', async () => {
    readCapabilities.mockResolvedValue({
      context: 'live',
      owner: { profile: 'agent', agent_id: 'main' },
      available: false,
      unavailable_reason: 'This fixture does not seed agent capability policy.',
      targets: [],
    });
    await render();
    await settle();
    const status = container.querySelector('[data-rail-capabilities-unavailable]')!;
    expect(status.textContent).toContain('暂时读不到能力信息。');
    expect(container.querySelector('[data-rail-capabilities-retry]')).not.toBeNull();
  });

  it('stays hidden while the first read is in flight', async () => {
    readCapabilities.mockReturnValue(new Promise(() => {}));
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities]')).toBeNull();
  });
});

// @vitest-environment jsdom

/**
 * The rail's 能力 block (DefaultSections CapabilitiesBlock): the one folded
 * entry for everything the focused agent can use — tools, skills, subagent
 * targets and the session's plugins. Folded is the head's per-kind counts and
 * nothing else, because the names behind them read as a wall of slugs rather
 * than a summary — they live in the block's own detail, where each carries its
 * scope and state.
 *
 * The block reads two answers that fail independently: the agent-panel read
 * (tools/skills/subagents) and the plugin-usage read. A failed capability read
 * leaves one quiet line inside each of the three capability tabs while the
 * plugins tab keeps working; a failed plugin read is one quiet line inside the
 * plugins tab while the other three keep theirs. A server that answers a scope
 * unsupported simply has no such tab, and a server without either scope has no
 * block at all.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse, PluginUsageItem, PluginUsageResponse } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { buildAgentForest, type NoticeBlock } from '@kiki/session-core/session';
import { translate } from '@kiki/session-core/i18n';
import { ActivityFeed, CapabilitiesBlock } from './DefaultSections';

const { readCapabilities, getUsage } = vi.hoisted(() => ({ readCapabilities: vi.fn(), getUsage: vi.fn() }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) => readCapabilities(query, options.signal),
        },
      },
    },
    client: {
      getPluginUsage: (target: unknown) => getUsage(target),
      setPluginUsage: () => Promise.reject(new Error('writes are not under test here')),
      listPluginMarketplace: () => Promise.resolve({ entries: [] }),
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

/** The old-server shape: an answer without the capability fields. */
const withoutCapabilities: AgentCapabilitiesResponse = {
  context: 'live',
  owner: { profile: 'agent', agent_id: 'main' },
  available: false,
  unavailable_reason: 'This fixture does not seed agent capability policy.',
  targets: [],
} as AgentCapabilitiesResponse;

const unsupported = () => Object.assign(new Error('unsupported procedure'), { code: 12 });

function plugin(overrides: Partial<PluginUsageItem> = {}): PluginUsageItem {
  return {
    id: 'demo',
    displayName: 'Demo Plugin',
    version: '1.0.0',
    home_enabled: true,
    global_enabled: true,
    state: 'ok',
    override: 'inherit',
    effective: true,
    app_service: false,
    skillCount: 1,
    mcpServerCount: 0,
    ...overrides,
  } as PluginUsageItem;
}

function pluginAnswer(overrides: Partial<PluginUsageResponse> = {}): PluginUsageResponse {
  return {
    home_id: 'home-1',
    target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' },
    revision: 7,
    apply_state: 'applied',
    errors: [],
    plugins: [plugin()],
    ...overrides,
  } as PluginUsageResponse;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  readCapabilities.mockReset();
  getUsage.mockReset();
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
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <CapabilitiesBlock sessionId="sess-1" agentId="main" />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

/** The folded head, opened. */
async function openFold(): Promise<HTMLElement> {
  const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
  await act(async () => { head.click(); });
  return head;
}

async function tab(id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-capability-tab-button="${id}"]`);
  if (button === null) throw new Error(`no tab ${id}`);
  await act(async () => { button.click(); });
}

describe('CapabilitiesBlock', () => {
  it('folds to the counts head alone, and expands onto the four tabs', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    const block = container.querySelector('[data-rail-capabilities]')!;
    // Folded: the head keeps the per-kind counts, the tabs stay unmounted.
    // Tools count every source that is on — three built-ins and the connected
    // MCP server — and the plugins segment is the session's usable count.
    const head = block.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('工具 4 · 技能 4 · 子智能体 2 · 插件 1');
    expect(head.textContent).not.toContain('扩展');
    expect(block.querySelector('[data-agent-capabilities-section]')).toBeNull();
    // No name pile-up above the fold. Those slugs are a wall of ids, and the
    // detail below carries each one with its scope and state.
    expect(block.querySelector('[data-rail-capabilities-preview]')).toBeNull();
    expect(block.textContent).not.toContain('api-diff');
    expect(block.textContent).not.toContain('release-notes');
    // Open: the four tabs mount, and every name is readable on purpose — each
    // behind its own tab, with its scope and state.
    await openFold();
    expect(block.querySelector('[data-agent-capabilities-section]')).not.toBeNull();
    expect(block.querySelectorAll('[data-capability-tab-button]')).toHaveLength(4);
    await tab('skills');
    expect(block.textContent).toContain('api-diff');
    expect(block.textContent).toContain('release-notes');
    // The plugins tab is the session's list, rows and all.
    await tab('plugins');
    expect(block.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
    // Close: the block is the counts head again, and nothing more.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-rail-capabilities] [aria-expanded]')!.click(); });
    expect(block.querySelector('[data-agent-capabilities-section]')).toBeNull();
    expect(block.textContent).not.toContain('api-diff');
  });

  it('counts on the plugins tab badge only what this session can actually use', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockResolvedValue(pluginAnswer({
      plugins: [
        plugin({ id: 'a', effective: true }),
        plugin({ id: 'b', effective: false }),
        plugin({ id: 'c', effective: false, home_enabled: false, reason: 'home_disabled' }),
      ],
    }));
    await render();
    await settle();
    await openFold();
    // Three installed, one usable here: the badge carries the old chapter's
    // "此处可用 N" semantics, not the installed count.
    expect(container.querySelector('[data-capability-tab-button="plugins"]')!.textContent).toContain('1');
    expect(container.querySelector('[data-capability-tab-button="plugins"]')!.textContent).not.toContain('3');
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
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    // Built-ins alone: 3 of 4 enabled (Grep is off), and no name line at all.
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    expect(head.textContent).toContain('工具 3');
    expect(container.querySelector('[data-rail-capabilities-preview]')).toBeNull();
    await act(async () => { head.click(); });
    expect(container.querySelector('[data-agent-capabilities-section]')).not.toBeNull();
  });

  it('keeps the failed capability read to one quiet line inside each of its tabs, and recovers', async () => {
    readCapabilities.mockRejectedValueOnce(new Error('fixture offline'));
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    const block = container.querySelector('[data-rail-capabilities]')!;
    // The block stays a fold: the plugins half is still true, so the head has
    // no fake counts and no alert, and the failure is told where it belongs.
    expect(block.textContent).toContain('能力');
    expect(block.querySelector('[role="alert"]')).toBeNull();
    await openFold();
    const status = block.querySelector('[data-rail-capabilities-unavailable]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.className).toContain('text-ink-faint');
    expect(status.className).not.toMatch(/danger|amber|attention/);
    expect(status.textContent).toContain('暂时读不到能力信息。');
    // The plugins tab is a different read and is not dragged into the failure.
    await tab('plugins');
    expect(block.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
    await tab('tools');
    const retry = block.querySelector<HTMLButtonElement>('[data-rail-capabilities-retry]')!;
    expect(retry.textContent).toBe('重试');
    readCapabilities.mockResolvedValue(full);
    await act(async () => { retry.click(); });
    await settle();
    expect(readCapabilities).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
  });

  it('tells a failed plugin read inside the plugins tab only', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockRejectedValue(new Error('network down'));
    await render();
    await settle();
    await openFold();
    // The three capability tabs work; only the plugins tab carries the line.
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    await tab('plugins');
    const line = container.querySelector('[data-rail-plugins-unavailable]')!;
    expect(line.textContent).toContain('暂时读不到当前对话的插件使用情况。');
    expect(line.querySelector('button')!.textContent).toBe('重试');
  });

  it('has no plugins tab when the server does not offer plugin usage', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockRejectedValue(unsupported());
    await render();
    await settle();
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    expect(head.textContent).toContain('工具 4');
    expect(head.textContent).not.toContain('插件');
    await act(async () => { head.click(); });
    expect(container.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
    expect(container.querySelector('[data-capability-tab-button="plugins"]')).toBeNull();
  });

  it('is the plugins chapter alone, without a tab strip, when the server has no capability scope', async () => {
    readCapabilities.mockResolvedValue(withoutCapabilities);
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    expect(head.textContent).toContain('能力');
    expect(head.textContent).toContain('插件 1');
    expect(head.textContent).not.toContain('工具');
    await act(async () => { head.click(); });
    // One kind only: the list itself, with no strip that would hold one tab.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
  });

  it('has no block at all when the server offers neither scope', async () => {
    readCapabilities.mockResolvedValue(withoutCapabilities);
    getUsage.mockRejectedValue(unsupported());
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities]')).toBeNull();
  });

  it('stays hidden while the first reads are in flight', async () => {
    readCapabilities.mockReturnValue(new Promise(() => {}));
    getUsage.mockReturnValue(new Promise(() => {}));
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities]')).toBeNull();
  });
});

const compactionKeys = [
  'transcript.marker.compactionFresh', 'transcript.marker.compactionSummarize',
  'transcript.marker.compactionFallback', 'transcript.marker.compactionRescue',
  'transcript.marker.compactionFailed', 'transcript.marker.compaction',
] as const;

describe.each(['zh', 'en'] as const)('ActivityFeed compaction labels (%s)', (locale) => {
  it.each(compactionKeys)('preserves %s in the collapsed and expanded feed', async (key) => {
    localStorage.setItem('kiki.locale', locale);
    const notice: NoticeBlock = {
      kind: 'notice', id: 'compact-example', text: 'compaction', tone: 'neutral',
      i18n: { key }, createdAt: '2026-01-01T00:00:00.000Z',
    };
    await act(async () => {
      root.render(<I18nProvider><ActivityFeed blocks={[notice]} forest={buildAgentForest([], [])} onOpenAgent={() => {}} /></I18nProvider>);
    });
    const head = container.querySelector<HTMLButtonElement>('[data-inspector-recent] > button')!;
    const expected = translate(locale, key);
    expect(head.textContent).toContain(expected);
    await act(async () => { head.click(); });
    const row = container.querySelector('[data-inspector-recent] ol li')!;
    expect(row.textContent).toContain(expected);
    expect(row.querySelector('[title]')?.getAttribute('title')).toBe(expected);
  });
});

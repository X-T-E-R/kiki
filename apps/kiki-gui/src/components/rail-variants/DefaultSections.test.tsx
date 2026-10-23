// @vitest-environment jsdom

/**
 * The rail splits observation from control into two independent folded entries.
 * Tools, skills, and subagent targets stay in the three-tab observation fold;
 * plugins, system capabilities, and MCP servers live in the control fold.
 * Plugin and MCP tools remain observable in the complete tools inventory.
 *
 * The agent-panel and plugin-usage reads fail independently. A failed read
 * leaves a quiet retry line in its own group. A partial capability answer keeps
 * the tabs that answered and gives only the missing kind the retry. Explicit
 * unsupported errors hide their own group, not the system and MCP controls.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilitiesResponse, OptionalCapabilitySessionResponse, PluginUsageItem, PluginUsageResponse } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { buildAgentForest, type NoticeBlock } from '@kiki/session-core/session';
import { translate } from '@kiki/session-core/i18n';
import { OptionalCapabilityRows } from '../capabilities/optionalCapabilityUi';
import { clearPendingNewSessionCapabilities } from '../capabilities/newSessionCapabilities';
import { ActivityFeed, CapabilitiesBlock } from './DefaultSections';

const { readCapabilities, getUsage, getConfig, getSessionCaps, setSessionCap } = vi.hoisted(() => ({
  readCapabilities: vi.fn(),
  getUsage: vi.fn(),
  getConfig: vi.fn(),
  getSessionCaps: vi.fn(),
  setSessionCap: vi.fn(),
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    scopeId: 'test-scope',
    spaceKey: 'local',
    connectionId: 'test-conn',
    klient: {
      global: {
        agentPanel: {
          read: (query: unknown, options: { signal: AbortSignal }) => readCapabilities(query, options.signal),
        },
      },
    },
    client: {
      getConfig: () => getConfig(),
      getSessionOptionalCapabilities: (sessionId: string) => getSessionCaps(sessionId),
      setSessionOptionalCapability: (sessionId: string, body: unknown) => setSessionCap(sessionId, body),
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

/**
 * The degraded shape: the server's own "capabilities unavailable" answer
 * (`available: false`, no optional fields), the way a session that is not
 * live or a fixture without a capability seed responds. It is a partial
 * answer — not proof the scope is unoffered, which only an explicit
 * unsupported error says.
 */
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
  getConfig.mockReset();
  getSessionCaps.mockReset();
  setSessionCap.mockReset();
  getConfig.mockResolvedValue({});
  getSessionCaps.mockResolvedValue(buildSessionCapabilities());
  clearPendingNewSessionCapabilities();
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

let queryClient: QueryClient;

async function render() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
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

/** The observation fold, opened. */
async function openFold(): Promise<HTMLElement> {
  const head = container.querySelector<HTMLElement>('[data-rail-capabilities="observation"] [aria-expanded]')!;
  await act(async () => { head.click(); });
  return head;
}

/** The control fold, opened. */
async function openControls(): Promise<HTMLElement> {
  const head = container.querySelector<HTMLElement>('[data-rail-capabilities="control"] [aria-expanded]')!;
  await act(async () => { head.click(); });
  return head;
}

async function tab(id: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-capability-tab-button="${id}"]`);
  if (button === null) throw new Error(`no tab ${id}`);
  await act(async () => { button.click(); });
}

describe('CapabilitiesBlock', () => {
  it('keeps observation and control as independent default-closed folds', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockResolvedValue(pluginAnswer());
    getSessionCaps.mockResolvedValue(buildSessionCapabilities());
    await render();
    await settle();
    const observation = container.querySelector('[data-rail-capabilities="observation"]')!;
    const controls = container.querySelector('[data-rail-capabilities="control"]')!;
    const observationHead = observation.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    const controlHead = controls.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(observationHead.getAttribute('aria-expanded')).toBe('false');
    expect(controlHead.getAttribute('aria-expanded')).toBe('false');
    expect(observationHead.textContent).toContain('工具 4 · 技能 4 · 子智能体 2');
    expect(observationHead.textContent).not.toContain('插件');
    expect(controlHead.textContent).toBe('能力控制');
    expect(controlHead.querySelector('[data-fold-summary]')).toBeNull();
    expect(observation.querySelector('[data-agent-capabilities-section]')).toBeNull();
    expect(controls.querySelector('[data-rail-plugin="demo"]')).toBeNull();

    await openFold();
    expect(observationHead.getAttribute('aria-expanded')).toBe('true');
    expect(controlHead.getAttribute('aria-expanded')).toBe('false');
    expect(observation.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
    expect(observation.querySelector('[data-capability-tab-button="plugins"]')).toBeNull();
    expect(observation.querySelector('[data-capability-group-chip="mcp:github"]')).not.toBeNull();
    await tab('skills');
    expect(observation.textContent).toContain('api-diff');
    expect(observation.textContent).toContain('release-notes');

    await openControls();
    expect(observationHead.getAttribute('aria-expanded')).toBe('true');
    expect(controlHead.getAttribute('aria-expanded')).toBe('true');
    expect(controls.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
    expect(controls.querySelector('[data-optional-capability="browser"]')).not.toBeNull();
    expect(controls.querySelector('[data-capability-tab-button]')).toBeNull();

    await act(async () => { observationHead.click(); });
    expect(observation.querySelector('[data-agent-capabilities-section]')).toBeNull();
    expect(controls.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
  });

  it('counts usable plugins only inside the expanded plugin group', async () => {
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
    const head = container.querySelector('[data-rail-capabilities="control"] [aria-expanded]')!;
    expect(head.textContent).toBe('能力控制');
    expect(head.querySelector('[data-fold-summary]')).toBeNull();
    expect(container.querySelector('[data-rail-plugin-count]')).toBeNull();
    await openControls();
    expect(container.querySelector('[data-rail-control-group="plugins"] h4')?.textContent).toBe('插件1');
    expect(container.querySelector('[data-rail-plugin-count]')?.textContent).toBe('1');
    expect(container.querySelectorAll('[data-rail-plugin]')).toHaveLength(3);
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
    expect(block.textContent).toContain('能力清单');
    expect(block.querySelector('[role="alert"]')).toBeNull();
    await openFold();
    const status = block.querySelector('[data-rail-capabilities-unavailable]')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.className).toContain('text-ink-faint');
    expect(status.className).not.toMatch(/danger|amber|attention/);
    expect(status.textContent).toContain('暂时读不到能力信息。');
    // The control fold is a different read and is not dragged into the failure.
    await openControls();
    expect(container.querySelector('[data-rail-capabilities="control"] [data-rail-plugin="demo"]')).not.toBeNull();
    const retry = block.querySelector<HTMLButtonElement>('[data-rail-capabilities-retry]')!;
    expect(retry.textContent).toBe('重试');
    readCapabilities.mockResolvedValue(full);
    await act(async () => { retry.click(); });
    await settle();
    expect(readCapabilities).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
  });

  it('tells a failed plugin read inside the control fold only', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockRejectedValue(new Error('network down'));
    await render();
    await settle();
    await openFold();
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    await openControls();
    const line = container.querySelector('[data-rail-plugins-unavailable]')!;
    expect(line.textContent).toContain('暂时读不到当前对话的插件使用情况。');
    expect(line.querySelector('button')!.textContent).toBe('重试');
    expect(container.querySelector('[data-rail-capabilities="observation"] [data-rail-plugins-unavailable]')).toBeNull();
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

  it('keeps controls without an observation tab strip when the capability scope is unsupported', async () => {
    readCapabilities.mockRejectedValue(unsupported());
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities="observation"]')).toBeNull();
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities="control"] [aria-expanded]')!;
    expect(head.textContent).toBe('能力控制');
    expect(head.querySelector('[data-fold-summary]')).toBeNull();
    await act(async () => { head.click(); });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
    expect(container.querySelector('[data-rail-control-group="system"]')).not.toBeNull();
  });

  it('keeps the system-control fold when observation and plugin usage are unsupported', async () => {
    readCapabilities.mockRejectedValue(unsupported());
    getUsage.mockRejectedValue(unsupported());
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities="observation"]')).toBeNull();
    expect(container.querySelector('[data-rail-capabilities="control"]')).not.toBeNull();
    await openControls();
    expect(container.querySelector('[data-rail-control-group="plugins"]')).toBeNull();
    expect(container.querySelector('[data-rail-control-group="system"]')).not.toBeNull();
  });

  it('keeps tools and subagents when the answer omits only the skills field', async () => {
    readCapabilities.mockResolvedValue({
      context: 'live',
      owner: { profile: 'agent', agent_id: 'main' },
      available: true,
      tools: full.tools,
      targets: full.targets,
    });
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    // The folded head reports the kinds that answered, not a zero for skills.
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    const summary = head.querySelector('[data-fold-summary]')!;
    expect(summary.textContent).toContain('工具 4');
    expect(summary.textContent).toContain('子智能体 2');
    expect(summary.textContent).not.toContain('技能');
    await openFold();
    // The tools tab kept its content; the skills tab carries the quiet line.
    expect(container.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    await tab('subagents');
    expect(container.textContent).toContain('explore');
    await tab('skills');
    const line = container.querySelector<HTMLElement>('[data-rail-capabilities-unavailable]')!;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toContain('text-ink-faint');
    // The retry re-reads, and a complete answer closes the gap.
    readCapabilities.mockResolvedValue(full);
    await act(async () => { line.querySelector<HTMLButtonElement>('[data-rail-capabilities-retry]')!.click(); });
    await settle();
    expect(readCapabilities).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
    expect(container.textContent).toContain('api-diff');
  });

  it('keeps skills and subagents when the answer omits only the tools field', async () => {
    readCapabilities.mockResolvedValue({
      context: 'live',
      owner: { profile: 'agent', agent_id: 'main' },
      available: true,
      skills: full.skills,
      targets: full.targets,
    });
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    const summary = head.querySelector('[data-fold-summary]')!;
    expect(summary.textContent).toContain('技能 4');
    expect(summary.textContent).toContain('子智能体 2');
    expect(summary.textContent).not.toContain('工具');
    await openFold();
    // The tools tab carries the quiet line; the skills tab kept its content.
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).not.toBeNull();
    expect(container.querySelector('[data-capability-tab-button="tools"]')!.textContent).not.toContain('6');
    await tab('skills');
    expect(container.textContent).toContain('api-diff');
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
  });

  it('reads a degraded answer with neither optional field as partial, not as an absent scope', async () => {
    readCapabilities.mockResolvedValue(withoutCapabilities);
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    // The observation fold stays with three tabs: tools and skills get the quiet
    // line and subagents shows the answered empty list. Plugins stay in controls.
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities="observation"] [aria-expanded]')!;
    const summary = head.querySelector('[data-fold-summary]')!;
    expect(summary.textContent).toContain('子智能体 0');
    expect(summary.textContent).not.toContain('插件');
    expect(summary.textContent).not.toContain('工具');
    expect(summary.textContent).not.toContain('技能');
    await openFold();
    expect(container.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).not.toBeNull();
    await tab('subagents');
    expect(container.textContent).toContain('这个智能体不能派发子智能体。');
    await openControls();
    expect(container.querySelector('[data-rail-capabilities="control"] [data-rail-plugin="demo"]')).not.toBeNull();
  });

  it('shows the full inventory when available:false ships with the fields, as a live dispatch-off answer does', async () => {
    readCapabilities.mockResolvedValue({
      ...full,
      available: false,
      unavailable_reason: 'AgentRun is not active for this agent',
      unavailable_reason_code: 'agent_run_inactive',
    });
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    // available:false is a dispatch flag, not a scope verdict: every tab keeps
    // its content and the head keeps every count.
    const head = container.querySelector<HTMLElement>('[data-rail-capabilities] [aria-expanded]')!;
    expect(head.textContent).toContain('工具 4 · 技能 4 · 子智能体 2');
    expect(head.textContent).not.toContain('插件');
    await openFold();
    expect(container.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
  });

  it('keeps the last good answer through a failed background refetch', async () => {
    readCapabilities.mockResolvedValue(full);
    getUsage.mockResolvedValue(pluginAnswer());
    await render();
    await settle();
    await openFold();
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    readCapabilities.mockRejectedValue(new Error('network down'));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['agentCapabilities'] }); });
    await settle();
    // Stale data keeps rendering: no quiet line, no lost tabs.
    expect(container.querySelectorAll('[data-capability-group-chip]').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-rail-capabilities-unavailable]')).toBeNull();
    expect(container.querySelectorAll('[data-capability-tab-button]')).toHaveLength(3);
  });

  it('hides unresolved observation while keeping the default-closed control entry', async () => {
    readCapabilities.mockReturnValue(new Promise(() => {}));
    getUsage.mockReturnValue(new Promise(() => {}));
    await render();
    await settle();
    expect(container.querySelector('[data-rail-capabilities="observation"]')).toBeNull();
    expect(container.querySelector('[data-rail-capabilities="control"] [aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
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

function buildSessionCapabilities(
  overrides: Partial<Record<'browser' | 'computer' | 'memory' | 'thread' | 'web', Partial<OptionalCapabilitySessionResponse['rows'][number]>>> = {},
  revision = 1,
): OptionalCapabilitySessionResponse {
  const defaults = { browser: false, computer: false, memory: true, thread: true, web: true } as const;
  return {
    revision,
    host_id: 'local',
    rows: (['browser', 'computer', 'memory', 'thread', 'web'] as const).map((id) => {
      const defaultOn = defaults[id];
      const base: OptionalCapabilitySessionResponse['rows'][number] = {
        id,
        choice: 'inherit',
        effective: defaultOn,
        source: 'default',
        reason: defaultOn ? 'admitted' : 'unbound',
        allowed: true,
        host_locked: false,
        default_on: defaultOn,
        unresolved: false,
        applies: id === 'memory' || id === 'thread' ? 'next-step' : 'next-model-request',
      };
      return { ...base, ...overrides[id] };
    }),
  };
}

describe('OptionalCapabilityRows', () => {
  it('applies the factory default matrix on draft (thread/web/memory on, browser/computer off) and isolates draft choices', async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <OptionalCapabilityRows />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.querySelector('[data-optional-capabilities]')?.getAttribute('data-optional-capabilities')).toBe('draft');
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-effective')).toBe('false');
    expect(container.querySelector('[data-optional-capability="computer"]')?.getAttribute('data-optional-effective')).toBe('false');
    expect(container.querySelector('[data-optional-capability="memory"]')?.getAttribute('data-optional-effective')).toBe('true');
    expect(container.querySelector('[data-optional-capability="thread"]')?.getAttribute('data-optional-effective')).toBe('true');
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-effective')).toBe('true');

    // Toggle browser on in draft -> shows session override + restore default action
    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="browser"] [data-optional-set="on"]')!.click();
    });
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('on');
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-effective')).toBe('true');
    expect(container.querySelector('[data-optional-fact="browser"]')?.textContent).toBe('本会话开启');
    const restore = container.querySelector<HTMLButtonElement>('[data-optional-restore="browser"]');
    expect(restore).not.toBeNull();

    // Restore inheritance returns browser to inherit (off by default)
    await act(async () => { restore!.click(); });
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('inherit');
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-effective')).toBe('false');
    expect(container.querySelector('[data-optional-restore="browser"]')).toBeNull();
  });

  it('disables blocked capabilities and handles rapid switching, error rollback, and session isolation', async () => {
    getSessionCaps.mockImplementation((sessionId: string) => {
      if (sessionId === 'sess-a') {
        return Promise.resolve(buildSessionCapabilities({
          memory: { allowed: false, effective: false, source: 'off', reason: 'allowed_off' },
        }));
      }
      return Promise.resolve(buildSessionCapabilities());
    });

    let rejectFirst!: (reason: unknown) => void;
    let resolveSecond!: (value: OptionalCapabilitySessionResponse) => void;
    setSessionCap
      .mockImplementationOnce(() => new Promise<OptionalCapabilitySessionResponse>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<OptionalCapabilitySessionResponse>((resolve) => { resolveSecond = resolve; }))
      .mockImplementationOnce(() => Promise.reject(new Error('write rejected')));

    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <OptionalCapabilityRows sessionId="sess-a" />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    // Hard-off capability is disabled and shows 完全关闭
    const memoryInput = container.querySelector<HTMLInputElement>('#optional-cap-sess-a-memory')!;
    expect(memoryInput.disabled).toBe(true);
    expect(container.querySelector('[data-optional-fact="memory"]')?.textContent).toBe('完全关闭');

    // Rapid switching on browser: click ON then immediately OFF before first request finishes
    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="browser"] [data-optional-set="on"]')!.click();
    });
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-effective')).toBe('true');

    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="browser"] [data-optional-set="off"]')!.click();
    });
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('off');
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-effective')).toBe('false');

    // Stale first rejection must not clobber the newer second click
    await act(async () => { rejectFirst(new Error('stale failure')); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('off');

    await act(async () => {
      resolveSecond(buildSessionCapabilities({
        browser: { choice: 'off', effective: false, source: 'session', reason: 'session_off' },
      }));
    });
    await settle();
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('off');

    // A failing write rolls back optimistic state and reports alert on sess-a only
    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="web"] [data-optional-set="off"]')!.click();
    });
    await settle();
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-effective')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('write rejected');

    // Switching to sess-b does not bleed sess-a's error or session choice
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <OptionalCapabilityRows sessionId="sess-b" />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-optional-capability="browser"]')?.getAttribute('data-optional-choice')).toBe('inherit');
  });

  it('keeps whole-session snapshot monotonic when concurrent writes on different capabilities resolve out of order', async () => {
    getSessionCaps.mockResolvedValue(buildSessionCapabilities({
      memory: { choice: 'inherit', effective: false, default_on: false, source: 'default', reason: 'unbound' },
    }, 0));

    let resolveMemoryA!: (value: OptionalCapabilitySessionResponse) => void;
    let resolveWebB!: (value: OptionalCapabilitySessionResponse) => void;
    setSessionCap
      .mockImplementationOnce(() => new Promise<OptionalCapabilitySessionResponse>((resolve) => { resolveMemoryA = resolve; }))
      .mockImplementationOnce(() => new Promise<OptionalCapabilitySessionResponse>((resolve) => { resolveWebB = resolve; }));

    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <OptionalCapabilityRows sessionId="sess-race" />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    // 1. Dispatch request A: memory -> on (rev 1)
    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="memory"] [data-optional-set="on"]')!.click();
    });
    // 2. Dispatch request B: web -> off (rev 2) before A returns
    await act(async () => {
      container.querySelector<HTMLElement>('[data-optional-capability="web"] [data-optional-set="off"]')!.click();
    });
    expect(container.querySelector('[data-optional-capability="memory"]')?.getAttribute('data-optional-choice')).toBe('on');
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-choice')).toBe('off');

    // 3. Response B (rev 2, where both memory=on and web=off have landed) arrives FIRST
    await act(async () => {
      resolveWebB(buildSessionCapabilities({
        memory: { choice: 'on', effective: true, default_on: false, source: 'session', reason: 'admitted' },
        web: { choice: 'off', effective: false, source: 'session', reason: 'session_off' },
      }, 2));
    });
    await settle();
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-choice')).toBe('off');
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-effective')).toBe('false');

    // 4. Older response A (rev 1, where web was still inherit/on) arrives SECOND (out of order)
    await act(async () => {
      resolveMemoryA(buildSessionCapabilities({
        memory: { choice: 'on', effective: true, default_on: false, source: 'session', reason: 'admitted' },
        web: { choice: 'inherit', effective: true, source: 'default', reason: 'admitted' },
      }, 1));
    });
    await settle();

    // Late rev 1 snapshot must not overwrite rev 2's web=off state
    expect(container.querySelector('[data-optional-capability="memory"]')?.getAttribute('data-optional-choice')).toBe('on');
    expect(container.querySelector('[data-optional-capability="memory"]')?.getAttribute('data-optional-effective')).toBe('true');
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-choice')).toBe('off');
    expect(container.querySelector('[data-optional-capability="web"]')?.getAttribute('data-optional-effective')).toBe('false');
  });
});

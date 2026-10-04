// @vitest-environment jsdom

/**
 * The capability rail reads tools as groups: one chip per built-in category,
 * MCP server, plugin or user-owned tool, carrying `on/total` and the five
 * reported states, opening the group's complete membership — including the
 * tools that are off, unconnected or unconfirmed. Nothing here may fall back
 * to one row per tool, hide a switched-off tool from its own group, or let a
 * search change a group's denominator.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import type { AgentSubagentTarget, AgentSkillCapability, AgentToolCapability } from './types';

function tool(
  name: string,
  category: string,
  state: AgentToolCapability['state'],
  extra: Partial<AgentToolCapability> = {},
): AgentToolCapability {
  return { name, category, state, source: 'builtin', description: `${name} description`, ...extra };
}

const TOOLS: readonly AgentToolCapability[] = [
  tool('Read', 'os/backends', 'enabled'),
  tool('Write', 'os/backends', 'disabled', { unavailableReasonCode: 'tool_policy_disabled' }),
  tool('Grep', 'os/backends', 'enabled'),
  tool('Glob', 'os/backends', 'enabled'),
  tool('Bash', 'os/backends', 'enabled'),
  tool('Edit', 'os/backends', 'enabled'),
  tool('ReadMediaFile', 'os/backends', 'enabled'),
  tool('WebSearch', 'nbSearch', 'approval-required'),
  tool('FetchURL', 'nbSearch', 'enabled'),
  // A category the app has no localized label for keeps its raw value.
  tool('MemoryRead', 'memory', 'unknown'),
  tool('Skill', 'skill', 'disabled', { unavailableReason: 'Disabled by effective tool policy', unavailableReasonCode: 'tool_policy_disabled' }),
  tool('mcp__github__search_issues', 'mcp', 'enabled', { source: 'mcp' }),
  tool('mcp__github__create_pr', 'mcp', 'disabled', { source: 'mcp', unavailableReasonCode: 'tool_policy_disabled' }),
  tool('mcp__figma__get_frame', 'mcp', 'disconnected', { source: 'mcp', unavailableReason: 'Required runtime capability is not connected', unavailableReasonCode: 'runtime_not_connected' }),
  tool('plugin__release_kit__stage_tag', 'plugin', 'enabled', { source: 'plugin' }),
  tool('MyHostTool', 'custom', 'enabled', { source: 'user' }),
];

const SKILLS: readonly AgentSkillCapability[] = [
  { id: 'workspace:release-notes', name: 'release-notes', scope: 'workspace', state: 'enabled' },
];
const TARGETS: readonly AgentSubagentTarget[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The slice's copy is asserted in Chinese, the primary locale of this rail.
  window.localStorage.setItem('kiki.locale', 'zh');
  // jsdom has no layout: the group panel restores the opened row by scrolling.
  Element.prototype.scrollIntoView = () => undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function render(tools: readonly AgentToolCapability[], inlineGroupDetail = true): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider>
        {/* The rail host: one scroll region, the value this slice must restore. */}
        <div data-agent-panel-scroll>
          <AgentCapabilitiesSection tools={tools} skills={SKILLS} subagentTargets={TARGETS} inlineGroupDetail={inlineGroupDetail} />
        </div>
      </I18nProvider>,
    );
  });
}

/** The host's scroller; jsdom has no layout, so its offset is installed here. */
function host(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-agent-panel-scroll]')!;
}
function hostScroll(top: number): void {
  Object.defineProperty(host(), 'scrollTop', { value: top, writable: true, configurable: true });
}

/** `count` tools in as many groups of their own. */
function oneToolPerGroup(count: number): AgentToolCapability[] {
  return Array.from({ length: count }, (_, index) => tool(`Tool${index}`, `domain-${index}`, 'enabled'));
}

function chip(key: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-capability-group-chip="${key}"]`);
  if (found === null) throw new Error(`no chip for ${key}`);
  return found;
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent?.trim() ?? '';
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function tab(id: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-capability-tab-button="${id}"]`);
  if (button === null) throw new Error(`no tab ${id}`);
  await click(button);
}

describe('capability tool groups', () => {
  it('reads one chip per category with on/total, and keeps switched-off tools out of no list', async () => {
    await render(TOOLS);
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(5);
    expect(chip('builtin:os/backends').dataset['capabilityGroupCount']).toBe('6/7');
    // Approval-required is on: WebSearch waits for approval, FetchURL is on.
    expect(chip('builtin:nbSearch').dataset['capabilityGroupCount']).toBe('2/2');
    // A known built-in category reads in the app's own words.
    expect(chip('builtin:memory').textContent).toContain('记忆');
    // Every state unconfirmed reads as `?/1`, never as off.
    expect(chip('builtin:memory').textContent).toContain('?/1');
    // The user's own registration is its own group, not a skill contribution.
    expect(chip('user:custom').textContent).toContain('自定义工具');
    // No per-tool rows and no "N off" summary line survived the compression.
    expect(container.querySelector('[data-capability-item]')).toBeNull();
    expect(text('[data-capability-group-list="tools"]')).not.toContain('个未开启');
    // An unknown category keeps its raw token: there is no per-tool dictionary.
    await render([...TOOLS, tool('MysteryTool', 'zeta-domain', 'enabled')]);
    expect(chip('builtin:zeta-domain').textContent).toContain('zeta-domain');
  });

  it('shows the group name and x/y on the chip, and keeps the state words in the accessible name', async () => {
    await render(TOOLS);
    // The bubble reads the ratio alone: "on" on every bubble repeats what
    // `x/y` already says. The state word stays in the accessible name.
    const os = chip('builtin:os/backends');
    expect(os.textContent).toContain('6/7');
    expect(os.textContent).not.toContain('开启');
    expect(os.getAttribute('aria-label')).toContain('6/7 开启');
    // Nothing confirmed reads as `?/1` on the chip, and still names the state.
    const memory = chip('builtin:memory');
    expect(memory.textContent).toContain('?/1');
    expect(memory.textContent).not.toContain('开启');
    expect(memory.getAttribute('aria-label')).toContain('?/1 开启');
    // The group panel's meta line is the same bare ratio: the overview keeps
    // the numbers and drops the state word, which each row states for itself.
    await click(os);
    const meta = text('[data-tool-group-meta]');
    expect(meta).toContain('6/7');
    expect(meta).not.toContain('开启');
    expect(meta).toContain('内置');
    expect(text('[data-tool-group-item="Read"]')).toContain('开启');
    expect(text('[data-tool-group-item="Write"]')).toContain('未开启');
  });

  it('opens the complete group, including the tools that are off', async () => {
    await render(TOOLS);
    await click(chip('builtin:os/backends'));
    expect(container.querySelector('[data-tool-group-detail="builtin:os/backends"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-group-item="Read"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-group-item="Write"]')).not.toBeNull();
    expect(text('[data-tool-group-section="off"]')).toContain('未开启');
    // The panel is a read-only view: no bulk toggle exists.
    expect(container.querySelector('[data-tool-group-detail] input[type="checkbox"]')).toBeNull();
  });

  it('opens every member of an extension group, not just its first tool', async () => {
    await render(TOOLS);
    await tab('extensions');
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(3);
    expect(chip('mcp:github').dataset['capabilityGroupCount']).toBe('1/2');
    await click(chip('mcp:github'));
    expect(container.querySelector('[data-tool-group-item="mcp__github__search_issues"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-group-item="mcp__github__create_pr"]')).not.toBeNull();
    // Short names are what the reader recognises; the full name stays the identity.
    expect(text('[data-tool-group-item="mcp__github__search_issues"]')).toContain('search_issues');
    // A disconnected member keeps its own word and never reads as off.
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    await click(chip('mcp:figma'));
    expect(text('[data-tool-group-section="disconnected"]')).toContain('未连接');
  });

  it('previews on hover after a pause, and closes on Escape', async () => {
    vi.useFakeTimers();
    await render(TOOLS);
    const target = chip('builtin:nbSearch');
    // React synthesizes enter/leave from the mouseover/mouseout pair.
    await act(async () => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(container.querySelector('[data-capability-group-preview]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(100); });
    const preview = container.querySelector('[data-capability-group-preview="builtin:nbSearch"]');
    expect(preview).not.toBeNull();
    // A tool waiting for approval is on: it counts in the numerator.
    expect(preview?.textContent).toContain('2/2 开启');
    expect(preview?.textContent).toContain('其中 1 个待确认');
    expect(target.getAttribute('aria-describedby')).not.toBeNull();
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-capability-group-preview]')).toBeNull();
  });

  it('shows the preview immediately on keyboard focus', async () => {
    vi.useFakeTimers();
    await render(TOOLS);
    const target = chip('builtin:memory');
    await act(async () => target.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null })));
    expect(container.querySelector('[data-capability-group-preview="builtin:memory"]')).not.toBeNull();
  });

  it('finds a switched-off tool by name without changing the group counts', async () => {
    await render(TOOLS);
    const search = container.querySelector<HTMLInputElement>('[data-capability-filter="tools"]')!;
    await type(search, 'Write');
    expect(container.querySelector('[data-capability-group-chip][data-capability-group-hits="1"]')).not.toBeNull();
    expect(chip('builtin:os/backends').dataset['capabilityGroupCount']).toBe('6/7');
    expect(container.querySelector('[data-capability-item]')).toBeNull();
  });

  it('offers no match copy and a clear control when nothing matches', async () => {
    await render(TOOLS);
    await type(container.querySelector<HTMLInputElement>('[data-capability-filter="tools"]')!, 'zzz');
    expect(text('[data-capability-group-nomatch]')).toContain('没有匹配的工具或分组');
    await click(container.querySelector<HTMLButtonElement>('[data-capability-search-clear]')!);
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(5);
  });

  it('keeps the in-group filter while a single tool is open, and restores the chip', async () => {
    await render(TOOLS);
    await click(chip('builtin:os/backends'));
    const inGroup = container.querySelector<HTMLInputElement>('[data-tool-group-search]')!;
    await type(inGroup, 'Write');
    expect(text('[data-tool-group-count]')).toContain('1 / 7');
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-item="Write"]')!);
    expect(container.querySelector('[data-tool-detail]')).not.toBeNull();
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-tool-back]')!);
    expect(container.querySelector<HTMLInputElement>('[data-tool-group-search]')?.value).toBe('Write');
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    expect(container.querySelector('[data-tool-group-detail]')).toBeNull();
    expect(document.activeElement).toBe(chip('builtin:os/backends'));
  });

  it('says a group is gone instead of showing a stale membership', async () => {
    await render(TOOLS);
    await click(chip('builtin:memory'));
    await render(TOOLS.filter((entry) => entry.category !== 'memory'));
    expect(container.querySelector('[data-tool-group-gone]')).not.toBeNull();
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    expect(container.querySelector('[data-capability-group-chip]')).not.toBeNull();
  });

  it('shows eighteen groups without folding, and folds only a long list', async () => {
    await render(oneToolPerGroup(18));
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(18);
    expect(container.querySelector('[data-capability-groups-more]')).toBeNull();
    await render(oneToolPerGroup(26));
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(24);
    expect(container.querySelector('[data-capability-groups-more]')?.getAttribute('data-capability-groups-more')).toBe('2');
    await click(container.querySelector<HTMLButtonElement>('[data-capability-groups-more]')!);
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(26);
    await click(container.querySelector<HTMLButtonElement>('[data-capability-groups-less]')!);
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(24);
  });

  it('clears a tools search the same way whether the tab is clicked or arrowed', async () => {
    await render(TOOLS);
    const query = () => container.querySelector<HTMLInputElement>('[data-capability-filter="tools"]');
    await type(query()!, 'Write');
    await tab('extensions');
    await tab('tools');
    expect(query()?.value).toBe('');
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(5);
    await type(query()!, 'Write');
    const tablist = container.querySelector<HTMLDivElement>('[role="tablist"]')!;
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(query()?.value).toBe('');
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(5);
  });

  it('restores the host scroll offset and the focused row on the way back', async () => {
    await render(TOOLS);
    // Group → one tool → back: the list keeps the row and the exact offset.
    hostScroll(140);
    await click(chip('builtin:os/backends'));
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-item="Write"]')!);
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-tool-back]')!);
    expect(host().scrollTop).toBe(140);
    expect(document.activeElement).toBe(container.querySelector('[data-tool-group-item="Write"]'));
    // Cluster → group → back: the chips come back at the offset they left.
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    hostScroll(80);
    await click(chip('builtin:nbSearch'));
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    expect(host().scrollTop).toBe(80);
    expect(document.activeElement).toBe(chip('builtin:nbSearch'));
  });

  it('keeps skills as their own chips and leaves their list alone', async () => {
    await render(TOOLS);
    await tab('skills');
    expect(container.querySelector('[data-capability-chip]')).not.toBeNull();
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(0);
  });
});

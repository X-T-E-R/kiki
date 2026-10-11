// @vitest-environment jsdom

/**
 * The capability rail reads tools as groups: one chip per built-in category,
 * MCP server, plugin or user-owned tool, carrying `on/total` and the five
 * reported states, opening the group's complete membership — including the
 * tools that are off, unconnected or unconfirmed. Nothing here may fall back
 * to one row per tool, hide a switched-off tool from its own group, or let a
 * search change a group's denominator.
 *
 * The two ways into a group are separate facts. Hover and keyboard focus show
 * one floating preview that must leave the page's geometry untouched; a click
 * expands the group in place under the chips, taking nothing away.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { AgentCapabilitiesSection, SKILL_ROWS } from './AgentCapabilitiesSection';
import type { AgentSubagentTarget, AgentSkillCapability, AgentToolCapability } from './types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  // jsdom has no layout: the group panel restores the opened row by scrolling,
  // and the skills fold reads real wrapped rows. This models both from a
  // declared column width and a declared chip row height, so the fold and the
  // hover's non-movement are asserted against a real geometry rather than
  // against "jsdom happened to be 0".
  installLayout(LAYOUT_DEFAULT);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

/** The column's width and the chip row's height, in CSS pixels. */
const LAYOUT_DEFAULT = { width: 300, rowHeight: 32, chipsPerRow: 4 };
let layout: { width: number; rowHeight: number; chipsPerRow: number } = LAYOUT_DEFAULT;

/** The box a cluster or a list would report, from the same row model. */
function measuredOffset(this: HTMLElement): number {
  if (this.matches('[data-capability-skill-cluster]')) {
    const count = this.querySelectorAll('[data-capability-chip]').length;
    const natural = Math.max(1, Math.ceil(count / layout.chipsPerRow)) * layout.rowHeight;
    // A clipped cluster reports its cut height, as a real box would.
    const cap = this.style.maxHeight;
    return cap === '' ? natural : Math.min(natural, Number.parseInt(cap, 10));
  }
  if (this.matches('[data-capability-group-list]')) {
    return Math.max(1, Math.ceil(this.querySelectorAll('[data-capability-group-chip]').length / layout.chipsPerRow)) * layout.rowHeight;
  }
  return layout.width;
}

/**
 * Re-lays the live DOM after a render so the next measurement reads real boxes.
 *
 * Positions are viewport coordinates with a non-zero origin for the capability
 * block, and a cluster's wrapper sits above its list by a page-level offset —
 * which is the arrangement that made a chip's `offsetTop` (relative to the
 * nearest positioned ancestor) disagree with the list it wraps in. A model that
 * zeroes those offsets cannot reproduce the fold that actually shipped, so the
 * numbers here carry them.
 */
function installLayout(shape: { width: number; rowHeight: number; chipsPerRow: number }): void {
  layout = shape;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries: readonly unknown[]) => void) { resizeCallbacks.push(callback); }
    observe(): void { /* delivered by notifyResize, like a real frame */ }
    unobserve(): void { /* nothing tracked per element here */ }
    disconnect(): void { /* replaced on each mount */ }
  });
  for (const [property, measure] of [
    ['offsetHeight', measuredOffset],
    ['offsetWidth', measuredOffset],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get: measure,
    });
  }
  /** Where the block begins on the page; nothing here is at the origin. */
  const PAGE_TOP = 40;
  /** The distance from a cluster's positioned wrapper down to its list. */
  const WRAPPER_GAP = 0;
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const list = this.closest<HTMLElement>('[data-capability-skill-cluster]');
      if (this.matches('[data-capability-group-list]')) {
        return { left: 8, top: PAGE_TOP, right: 8 + layout.width, bottom: PAGE_TOP + layout.rowHeight, width: layout.width, height: layout.rowHeight, x: 8, y: PAGE_TOP, toJSON: () => ({}) };
      }
      if (list !== null && (this === list || this.closest('[data-capability-item]') !== null)) {
        // A skill cluster and the chips in it, laid out relative to the list's
        // own top so a row is a row.
        const rows = this.matches('[data-capability-skill-cluster]')
          ? 0
          : Math.floor(chipIndex(this) / layout.chipsPerRow) * layout.rowHeight;
        const top = PAGE_TOP + rows;
        const height = this.matches('[data-capability-skill-cluster]')
          ? naturalClusterHeight(list)
          : layout.rowHeight;
        return { left: 12, top, right: 12 + layout.width, bottom: top + height, width: layout.width, height, x: 12, y: top, toJSON: () => ({}) };
      }
      if (this.matches('[data-capability-skill-clip]')) {
        // The positioned wrapper the fade hangs from, and the box a measure
        // should read for the column's width.
        const height = naturalClusterHeight(this);
        return { left: 8, top: PAGE_TOP - WRAPPER_GAP, right: 8 + layout.width, bottom: PAGE_TOP + height, width: layout.width, height, x: 8, y: PAGE_TOP, toJSON: () => ({}) };
      }
      const top = PAGE_TOP + (this.matches('[data-capability-group-chip]') ? Math.floor(chipIndex(this) / layout.chipsPerRow) * layout.rowHeight : 0);
      return { left: 12, top, right: 12 + 64, bottom: top + 28, width: 64, height: 28, x: 12, y: top, toJSON: () => ({}) };
    },
  });
}

/** Observers created by the current mount; a frame is delivered to all of them. */
const resizeCallbacks: ((entries: readonly unknown[]) => void)[] = [];

/** One layout frame: what a real browser delivers after a resize settles. */
async function notifyResize(): Promise<void> {
  await act(async () => {
    for (const callback of resizeCallbacks) callback([{ contentRect: { width: layout.width, height: 0 } }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** How tall a skill cluster wraps when nothing is clipping it. */
function naturalClusterHeight(scope: HTMLElement): number {
  const list = scope.matches('[data-capability-skill-cluster]') ? scope : scope.querySelector('[data-capability-skill-cluster]');
  if (list === null) return 0;
  const count = list.querySelectorAll('[data-capability-chip]').length;
  return Math.max(1, Math.ceil(count / layout.chipsPerRow)) * layout.rowHeight;
}

/** A chip's ordinal inside its own wrapping cluster, for the row model. */
function chipIndex(element: HTMLElement): number {
  const list = element.closest('[data-capability-skill-cluster], [data-capability-group-list]');
  if (list === null) return 0;
  return Array.from(list.querySelectorAll('[data-capability-item], [data-capability-group-chip]'))
    .indexOf(element.closest('[data-capability-item]') as Element);
}

/** The cluster's own height as the fold sees it. */
function clusterHeight(): number {
  return container.querySelector<HTMLElement>('[data-capability-skill-cluster]')?.offsetHeight ?? 0;
}

async function render(tools: readonly AgentToolCapability[], skills: readonly AgentSkillCapability[] = SKILLS): Promise<void> {
  await act(async () => {
    root.render(
      <I18nProvider>
        {/* The rail host: one scroll region, the value this slice must restore. */}
        <div data-agent-panel-scroll>
          <AgentCapabilitiesSection tools={tools} skills={skills} subagentTargets={TARGETS} />
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
    expect(document.querySelector('[data-capability-group-preview]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(100); });
    const preview = document.querySelector('[data-capability-group-preview="builtin:nbSearch"]');
    expect(preview).not.toBeNull();
    // A tool waiting for approval is on: it counts in the numerator.
    expect(preview?.textContent).toContain('2/2 开启');
    expect(preview?.textContent).toContain('其中 1 个待确认');
    expect(target.getAttribute('aria-describedby')).not.toBeNull();
    // It is a layer, not a row: the card is outside the column's own flow.
    expect(preview?.parentElement).toBe(document.body);
    expect(container.contains(preview as Node)).toBe(false);
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-capability-group-preview]')).toBeNull();
  });

  it('shows the preview immediately on keyboard focus', async () => {
    vi.useFakeTimers();
    await render(TOOLS);
    const target = chip('builtin:memory');
    await act(async () => target.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: null })));
    expect(document.querySelector('[data-capability-group-preview="builtin:memory"]')).not.toBeNull();
  });

  it('keeps the page geometry untouched while a preview is open', async () => {
    vi.useFakeTimers();
    await render(TOOLS);
    // Everything after the cluster, measured before the pointer arrives.
    const before = {
      tabs: container.querySelector<HTMLElement>('[data-capability-tab-button="tools"]')!.getBoundingClientRect().top,
      list: container.querySelector<HTMLElement>('[data-capability-group-list]')!.offsetHeight,
      follow: container.querySelector<HTMLElement>('[data-agent-panel-scroll]')!.scrollHeight,
    };
    const target = chip('builtin:nbSearch');
    await act(async () => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(document.querySelector('[data-capability-group-preview]')).not.toBeNull();
    // A floating preview reads without pushing the conversation or the rest of
    // the rail down: this is the whole reason it left the flow.
    expect(container.querySelector<HTMLElement>('[data-capability-group-list]')!.offsetHeight).toBe(before.list);
    expect(container.querySelector<HTMLElement>('[data-capability-tab-button="tools"]')!.getBoundingClientRect().top).toBe(before.tabs);
    expect(container.querySelector<HTMLElement>('[data-agent-panel-scroll]')!.scrollHeight).toBe(before.follow);
    // Nor does it leave a gap behind when it closes.
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector<HTMLElement>('[data-capability-group-list]')!.offsetHeight).toBe(before.list);
  });

  it('lets a click reach the chip under an open preview', async () => {
    vi.useFakeTimers();
    await render(TOOLS);
    // The card is wider than the chip it describes, so it lands over the chips
    // beside it. It must never take a click that was aimed at one of them.
    const other = chip('builtin:nbSearch');
    await act(async () => chip('builtin:os/backends').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    await act(async () => { vi.advanceTimersByTime(400); });
    const preview = document.querySelector('[data-capability-group-preview]')!;
    expect(preview).not.toBeNull();
    expect(preview.className).toContain('pointer-events-none');
    vi.useRealTimers();
    await click(other);
    expect(container.querySelector('[data-capability-group-expanded="builtin:nbSearch"]')).not.toBeNull();
  });

  it('expands a clicked group in place, below the cluster, not over it', async () => {
    await render(TOOLS);
    // The cluster and the tab strip are the reader's map; a click adds a panel
    // under the chips and takes nothing away.
    const cluster = container.querySelector('[data-capability-group-list]')!;
    const tabs = container.querySelector('[role="tablist"]')!;
    await click(chip('builtin:os/backends'));
    // Still the same cluster, still the same tabs: the page was not replaced.
    expect(container.querySelector('[data-capability-group-list]')).toBe(cluster);
    expect(container.querySelector('[role="tablist"]')).toBe(tabs);
    // The panel lives after the chips and before the tabs panel's end, inside
    // the column: an expansion, not a takeover and not an overlay.
    const expanded = container.querySelector('[data-capability-group-expanded="builtin:os/backends"]')!;
    expect(expanded).not.toBeNull();
    const list = container.querySelector('[data-capability-group-list]')!;
    expect(list.compareDocumentPosition(expanded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-capability-group-drawer]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[data-tool-group-item="Read"]')).not.toBeNull();
    // Back collapses it and leaves the chips as they were.
    await click(container.querySelector<HTMLButtonElement>('[data-tool-group-back]')!);
    expect(container.querySelector('[data-capability-group-expanded]')).toBeNull();
    expect(container.querySelectorAll('[data-capability-group-chip]')).toHaveLength(5);
  });

  it('keeps one group open at a time and marks the open chip', async () => {
    await render(TOOLS);
    await click(chip('builtin:os/backends'));
    expect(chip('builtin:os/backends').getAttribute('aria-expanded')).toBe('true');
    await click(chip('builtin:nbSearch'));
    expect(container.querySelectorAll('[data-capability-group-expanded]')).toHaveLength(1);
    expect(container.querySelector('[data-capability-group-expanded="builtin:nbSearch"]')).not.toBeNull();
    expect(chip('builtin:os/backends').getAttribute('aria-expanded')).toBe('false');
  });

  it('closes an open group when the tab changes', async () => {
    await render(TOOLS);
    await click(chip('builtin:os/backends'));
    expect(container.querySelector('[data-capability-group-expanded]')).not.toBeNull();
    // The panel expands in place, so a group left open across a tab switch
    // would sit in the other tab's cluster and read as that tab's detail.
    await tab('extensions');
    expect(container.querySelector('[data-capability-group-expanded]')).toBeNull();
    // The other tab's own chips open normally afterwards.
    await click(chip('mcp:github'));
    expect(container.querySelector('[data-capability-group-expanded="mcp:github"]')).not.toBeNull();
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

describe('the skills fold', () => {
  const manySkills = (count: number): AgentSkillCapability[] => Array.from({ length: count }, (_, index) => ({
    id: `global:skill-${index}`,
    name: `skill-${index}`,
    scope: 'global' as const,
    state: 'enabled' as const,
    path: `C:/skills/skill-${index}/SKILL.md`,
  }));

  const skillChips = () => container.querySelectorAll('[data-capability-chip]').length;
  const isFolded = () => container.querySelector('[data-capability-skill-folded]') !== null;
  const foldControl = () => container.querySelector<HTMLButtonElement>('[data-capability-more]');
  /** The fold control of one named scope, since each scope folds on its own. */
  const scopeFoldControl = (scope: 'workspace' | 'global') =>
    container.querySelector<HTMLButtonElement>(`[data-capability-group="${scope}"] [data-capability-more]`);
  /** The cut the fold applies, in px: `SKILL_ROWS` chip rows. */
  const cutHeight = () => container.querySelector<HTMLElement>('[data-capability-skill-cluster]')?.style.maxHeight ?? '';
  /** The height the list really wraps to, from the same layout model. */
  const naturalRows = () => Math.ceil(skillChips() / layout.chipsPerRow);

  it('shows no fold control for a list that fits in the rows it is allowed', async () => {
    // The real counterexample: eight chips wrapping into three rows are all
    // visible, and a control claiming "N more" under them is simply wrong. It
    // is what a fold decided before the list settled reported.
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 3 });
    const eight: AgentSkillCapability[] = [
      'api-diff', 'changelog-scan', 'code-review', 'doc-drift',
      'migration-plan', 'perf-note', 'release-notes', 'test-matrix',
    ].map((name) => ({ id: `workspace:${name}`, name, scope: 'workspace' as const, state: 'enabled' as const }));
    await render(TOOLS, eight);
    await tab('skills');
    // Eight chips over three per row is three rows, inside the four the fold
    // allows, so every chip is readable and nothing is hidden.
    expect(container.querySelectorAll('[data-capability-chip]')).toHaveLength(8);
    expect(naturalRows()).toBe(3);
    expect(isFolded()).toBe(false);
    expect(cutHeight()).toBe('');
    // No cut, no fade, and above all no control claiming chips are hidden.
    expect(container.querySelector('[data-capability-skill-fade]')).toBeNull();
    expect(foldControl()).toBeNull();
    expect(container.textContent).not.toContain('还有');
  });

  it('folds on real wrapped rows, and the count is the chips the cut hides', async () => {
    // Four chips per row, 18 skills = five rows. The fold keeps four rows, so
    // exactly the last row's two chips are what the cut hides.
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(isFolded()).toBe(true);
    expect(skillChips()).toBe(18);
    // Five rows of chips, cut to four: the fold is a row count, not a chip
    // count, and every chip is still in the list.
    expect(naturalRows()).toBe(5);
    expect(cutHeight()).toBe(`${SKILL_ROWS * 32}px`);
    expect(foldControl()?.textContent).toContain('还有 2 项');
  });

  it('holds the same four rows at a different column width', async () => {
    // The same list in a narrower column wraps to nine rows and still keeps
    // four: the fold is rows, so the cut never drifts with the width. Two chips
    // per row below the fourth row means ten are hidden instead of two.
    installLayout({ width: 180, rowHeight: 32, chipsPerRow: 2 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(isFolded()).toBe(true);
    // Nine rows here, four shown: the column got narrower, the cut did not.
    expect(naturalRows()).toBe(9);
    expect(cutHeight()).toBe(`${SKILL_ROWS * 32}px`);
    expect(foldControl()?.textContent).toContain('还有 10 项');
  });

  it('re-measures when the column changes width with no React involved', async () => {
    // A sidebar drag or a viewport change is pure layout: the children are the
    // same objects, the component never re-renders, and the effect's
    // dependencies cannot fire. Only a size observation notices, so the fold
    // has to be able to follow the column.
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(scopeFoldControl('global')?.textContent).toContain('还有 2 项');

    // The column narrows to two per row: the same 18 chips wrap to nine rows, so
    // ten of them now sit under the cut. Nothing about the chips changed, only
    // the column, so only a size observation can produce this.
    installLayout({ width: 180, rowHeight: 32, chipsPerRow: 2 });
    await act(async () => { await notifyResize(); });
    expect(scopeFoldControl('global')?.textContent).toContain('还有 10 项');

    // And back: the fold returns to what the wider column hides.
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await act(async () => { await notifyResize(); });
    expect(scopeFoldControl('global')?.textContent).toContain('还有 2 项');
  });

  it('re-counts when chips change at an unchanged size', async () => {
    // Same width, same wrapped height, fewer chips: a size guard that only
    // compares width and height would keep the old count, because nothing about
    // the box moved. The number has to follow the chips that are actually there.
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(scopeFoldControl('global')?.textContent).toContain('还有 2 项');

    // Eighteen chips wrap to five rows at four per row. Two more fill the last
    // row, so the list is still five rows tall and the measured height is
    // unchanged — but four chips are now under the cut instead of two.
    await render(TOOLS, manySkills(20));
    await tab('skills');
    const list = container.querySelector<HTMLElement>('[data-capability-group="global"] [data-capability-skill-cluster]')!;
    expect(list.querySelectorAll('[data-capability-chip]')).toHaveLength(20);
    expect(scopeFoldControl('global')?.textContent).toContain('还有 4 项');
  });

  it('does not fold a list that already fits in four rows', async () => {
    installLayout({ width: 400, rowHeight: 32, chipsPerRow: 6 });
    await render(TOOLS, manySkills(12));
    await tab('skills');
    // Twelve chips over six per row is exactly two rows: nothing to fold, no
    // cut applied, and no fold control claiming a count of zero.
    expect(isFolded()).toBe(false);
    expect(cutHeight()).toBe('');
    expect(foldControl()).toBeNull();
  });

  it('settles on one cut instead of oscillating between folded and open', async () => {
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    // Applying the cut changes the list's own height, which a naive observer
    // would treat as new information and measure again, forever. The chip that
    // was clicked must therefore still be the same live element.
    const chip = container.querySelector<HTMLElement>('[data-capability-item="skill-0"]')!;
    await click(chip);
    expect(container.querySelector('[data-capability-item="skill-0"]')).toBe(chip);
    expect(isFolded()).toBe(true);
    expect(cutHeight()).toBe(`${SKILL_ROWS * 32}px`);
  });

  it('unfolds on the toggle and refolds on the way back', async () => {
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(cutHeight()).toBe(`${SKILL_ROWS * 32}px`);
    await click(foldControl()!);
    expect(isFolded()).toBe(false);
    expect(cutHeight()).toBe('');
    expect(foldControl()?.textContent).toContain('收起');
    await click(foldControl()!);
    expect(isFolded()).toBe(true);
    expect(cutHeight()).toBe(`${SKILL_ROWS * 32}px`);
  });

  it('never folds while a search is running, and lifts the fold on the match', async () => {    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    await render(TOOLS, manySkills(18));
    await tab('skills');
    expect(isFolded()).toBe(true);
    const search = container.querySelector<HTMLInputElement>('[data-capability-filter="skills"]');
    expect(search).not.toBeNull();
    await type(search!, 'skill-1');
    // Every match is reachable: filtering is an explicit reader request.
    expect(isFolded()).toBe(false);
    expect(skillChips()).toBeGreaterThan(1);
  });

  it('folds each scope on its own rows', async () => {
    installLayout({ width: 300, rowHeight: 32, chipsPerRow: 4 });
    const mixed: AgentSkillCapability[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `workspace:ws-${index}`, name: `ws-skill-${index}`,
        scope: 'workspace' as const, state: 'enabled' as const,
      })),
      ...manySkills(18),
    ];
    await render(TOOLS, mixed);
    await tab('skills');
    // Both scopes are present and each carries its own label and count.
    expect(container.querySelector('[data-capability-group="workspace"]')).not.toBeNull();
    expect(container.querySelector('[data-capability-group="global"]')).not.toBeNull();
    // The global list is long enough to fold; the short workspace list is not
    // pushed into a fold just because it sits above one that is.
    const clusters = container.querySelectorAll<HTMLElement>('[data-capability-skill-cluster]');
    expect(clusters).toHaveLength(2);
    expect(clusters[1]!.dataset['capabilitySkillFolded']).toBe('');
    expect(clusters[0]!.dataset['capabilitySkillFolded']).toBeUndefined();
  });
});

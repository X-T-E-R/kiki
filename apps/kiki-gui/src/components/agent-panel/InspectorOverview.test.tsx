// @vitest-environment jsdom

/**
 * The resident overview's reading order: context bar (with automatic-compaction
 * tick mark) and one measured figures row. Secondary ratios, compaction copy,
 * turn counts and session start time live in hover/aria tooltips instead of
 * verbose standing captions.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { InspectorOverview, type OverviewFigures } from './InspectorOverview';

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => { localStorage.setItem('kiki.locale', 'zh'); });
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

const NOW = Date.now();
const STARTED = new Date(NOW - ((4 * 24 + 2) * 60 * 60 * 1000)).toISOString();

async function render(props: {
  figures?: OverviewFigures;
  treeFigures?: OverviewFigures;
  scope?: 'agent' | 'tree';
  contextUsed?: number;
  contextLimit?: number;
  compactPoint?: number;
  startedAt?: string;
  turns?: number;
  toolCalls?: number;
  onScope?: (scope: 'agent' | 'tree') => void;
}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(InspectorOverview, {
      figures: props.figures ?? {},
      scope: props.scope ?? 'agent',
      onScope: props.onScope ?? (() => {}),
      ...(props.treeFigures !== undefined ? { treeFigures: props.treeFigures } : {}),
      ...(props.contextUsed !== undefined ? { contextUsed: props.contextUsed } : {}),
      ...(props.contextLimit !== undefined ? { contextLimit: props.contextLimit } : {}),
      ...(props.compactPoint !== undefined ? { compactPoint: props.compactPoint } : {}),
      ...(props.startedAt !== undefined ? { startedAt: props.startedAt } : {}),
      ...(props.turns !== undefined ? { turns: props.turns } : {}),
      ...(props.toolCalls !== undefined ? { toolCalls: props.toolCalls } : {}),
    })));
  });
  return container;
}

describe('the overview keeps standing telemetry compact and preserves details in tooltips', () => {
  it('omits standing percentage/compaction/turns captions while preserving them in tooltips and aria attributes', async () => {
    const container = await render({
      contextUsed: 25_900, contextLimit: 262_000, compactPoint: 212_000,
      figures: { costUsd: 0.04, totalTokens: 22_500, cacheRate: 39, compactions: 2 },
      startedAt: STARTED, turns: 4,
    });

    // No standing caption paragraphs clutter the overview.
    expect(container.querySelector('[data-overview-session]')).toBeNull();
    expect(container.querySelector('[data-overview-context] p')).toBeNull();
    expect(container.textContent).not.toContain('前开始');
    expect(container.textContent).not.toContain('占窗口');
    expect(container.textContent).not.toContain('到 212k 时压缩');

    // Context tick mark stays on the bar and preserves full ratio/compaction info in tooltips/aria.
    const contextBlock = container.querySelector<HTMLElement>('[data-overview-context]')!;
    const meter = container.querySelector<HTMLElement>('[role="meter"]')!;
    const tick = container.querySelector<HTMLElement>('[data-overview-compact-mark]')!;
    expect(tick).not.toBeNull();
    expect(contextBlock.title).toContain('占窗口 10%');
    expect(contextBlock.title).toContain('到 212k 时压缩');
    expect(meter.getAttribute('aria-valuetext')).toContain('占窗口 10%');
    expect(meter.getAttribute('aria-valuetext')).toContain('到 212k 时压缩');
    expect(tick.title).toContain('212,000');

    // Figures row carries turns, compactions and absolute start time in hover title and aria-label.
    const usageRow = container.querySelector<HTMLElement>('[data-agent-usage]')!;
    expect(container.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.04');
    expect(usageRow.title).toContain('4 轮');
    expect(usageRow.title).toContain('压缩 2 次');
    expect(usageRow.title).toContain(new Date(STARTED).toLocaleString());
    expect(usageRow.getAttribute('aria-label')).toContain('4 轮');
  });

  it('keeps the absolute start time accessible even when a fresh session has no figures yet', async () => {
    const container = await render({ startedAt: STARTED });
    expect(container.querySelector('[data-overview-session]')).toBeNull();
    const carried = container.querySelector('[data-overview-started]')!;
    expect(carried).not.toBeNull();
    expect(carried.className).toContain('sr-only');
    expect(carried.textContent).toContain(new Date(STARTED).toLocaleString());
  });

  it('prints no start time at all when the session does not report one', async () => {
    const container = await render({ turns: 3 });
    const carried = container.querySelector('[data-overview-started]')!;
    expect(carried.textContent).toBe('3 轮');
    expect(carried.textContent).not.toContain('会话开始于');
  });
});

describe('the overview owns the figures, and the scope that changes them', () => {
  it('keeps 本智能体 / 全树 available and marks the selected partial tree', async () => {
    const container = await render({
      figures: { totalTokens: 1_200 },
      treeFigures: { totalTokens: 1_200, incomplete: true },
      scope: 'tree',
      contextUsed: 1_200, contextLimit: 100_000,
    });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const agent = group.querySelector<HTMLButtonElement>('[data-usage-scope="agent"]')!;
    const tree = group.querySelector<HTMLButtonElement>('[data-usage-scope="tree"]')!;
    expect(agent.textContent).toBe('本智能体');
    expect(tree.textContent).toContain('全树');
    expect(tree.disabled).toBe(false);
    expect(tree.hasAttribute('data-usage-scope-incomplete')).toBe(true);
    expect(tree.title).toContain('整棵树部分统计');
  });

  it('keeps the partial tree state as a quiet icon, and only while it is shown', async () => {
    const partial = await render({
      figures: { totalTokens: 1_200 },
      treeFigures: { totalTokens: 1_200, incomplete: true },
      scope: 'tree',
    });
    const note = partial.querySelector<HTMLElement>('[data-overview-tree-incomplete]')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe('');
    expect(note.querySelector('[data-icon="partial"]')).not.toBeNull();
    expect(note.getAttribute('aria-label')).toContain('整棵树');
    expect(partial.querySelector('[data-metrics-counting]')).toBeNull();
    const agent = await render({
      figures: { totalTokens: 1_200 },
      treeFigures: { totalTokens: 1_200, incomplete: true },
    });
    expect(agent.querySelector('[data-overview-tree-incomplete]')).toBeNull();
  });

  it('has no whole tree to switch to on a subagent, so no switch is drawn', async () => {
    const container = await render({ figures: { totalTokens: 1_200 } });
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('really switches the numbers when whole-tree figures exist, and keeps the switch discoverable', async () => {
    const picked: string[] = [];
    const container = await render({
      figures: { costUsd: 0.05, totalTokens: 1_200 },
      treeFigures: { costUsd: 0.15, totalTokens: 3_400 },
      onScope: (scope) => { picked.push(scope); },
    });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const tree = group.querySelector<HTMLButtonElement>('[data-usage-scope="tree"]')!;
    expect(tree.disabled).toBe(false);
    expect(tree.hasAttribute('data-usage-scope-incomplete')).toBe(false);
    expect(tree.title).toBe('整棵智能体树');
    expect(container.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.05');
    await act(async () => { tree.click(); });
    expect(picked).toEqual(['tree']);
  });

  it('does not keep a permission mode, a model or any setup line of its own', async () => {
    const container = await render({
      figures: { costUsd: 0.05, totalTokens: 1_200, cacheRate: 0 },
      contextUsed: 1_200, contextLimit: 100_000, turns: 1,
    });
    expect(container.querySelector('[data-overview-setup]')).toBeNull();
    expect(container.textContent).not.toContain('自动');
    expect(container.textContent).not.toContain('完全放行');
    expect(container.textContent).not.toContain('每步询问');
    expect(container.textContent).not.toContain('权限');
    expect(container.querySelector('[data-agent-usage]')?.getAttribute('title')).toContain('1 轮');
  });

  it('lays the figures out in one measured row, so an absent figure closes its gap', async () => {
    const full = await render({ figures: { costUsd: 0.05, totalTokens: 1_200, cacheRate: 12 } });
    const one = await render({ figures: { totalTokens: 1_200 } });
    for (const container of [full, one]) {
      const row = container.querySelector<HTMLElement>('[data-agent-usage]')!;
      expect(row).not.toBeNull();
      expect(row.className).toContain('flex');
      expect(row.className).not.toContain('grid-cols-3');
      expect(row.className).not.toContain('col-span-3');
    }
    expect(full.querySelectorAll('[data-overview-fact]')).toHaveLength(3);
    expect(one.querySelectorAll('[data-overview-fact]')).toHaveLength(1);
  });

  it('keeps a partial count as a quiet icon', async () => {
    const container = await render({ figures: { totalTokens: 1_200, partial: true } });
    const status = container.querySelector('[data-agent-usage] [role="status"]');
    expect(status?.textContent).toBe('');
    expect(status?.querySelector('[data-icon="partial"]')).not.toBeNull();
    expect(status?.getAttribute('aria-label')).toContain('部分统计');
  });
});

describe('the overview keeps its restyle hooks addressable', () => {
  it('names the context figure for the rail to style', async () => {
    const container = await render({ contextUsed: 25_900, contextLimit: 262_000 });
    const figure = container.querySelector<HTMLElement>('[data-overview-context-figures]');
    expect(figure).not.toBeNull();
    expect(figure?.textContent).toContain('25.9k');
    expect(figure?.className).not.toContain('[&');
  });

  it('gives every fact a stable name for the host layout to target', async () => {
    const container = await render({ figures: { costUsd: 0.05, totalTokens: 1_200, cacheRate: 12 } });
    for (const name of ['cost', 'tokens', 'cache']) {
      const fact = container.querySelector<HTMLElement>(`[data-overview-fact="${name}"]`);
      expect(fact).not.toBeNull();
      expect(fact?.firstElementChild?.tagName).toBe('DIV');
    }
  });
});

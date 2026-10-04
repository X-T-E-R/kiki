// @vitest-environment jsdom

/**
 * The resident overview's reading order: what is happening now on the first
 * screen, what this conversation has been through on the line under it, and
 * when it started only when someone asks.
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
/** Four days and two hours ago, so a relative age would be unmistakable. */
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

function sessionLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-overview-session]');
}

describe('the overview separates the present from this conversation\'s history', () => {
  it('does not print how old the session is beside the present figures', async () => {
    const container = await render({
      contextUsed: 25_900, contextLimit: 262_000, compactPoint: 212_000,
      figures: { costUsd: 0.04, totalTokens: 22_500, cacheRate: 39 },
      startedAt: STARTED, turns: 4,
    });

    // The working line keeps what this conversation has done …
    const line = sessionLine(container)!;
    expect(line.textContent).toContain('4');
    // … and says nothing about how long ago it started.
    expect(container.textContent).not.toContain('前开始');
    expect(line.textContent).not.toContain('前开始');
    // The compaction point, the figures and the cache title are untouched.
    expect(container.querySelector('[data-overview-compact-mark]')).not.toBeNull();
    expect(container.textContent).toContain('到 212k 时压缩');
    expect(container.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.04');
  });

  it('keeps the absolute start time as the hover on that line', async () => {
    const container = await render({ startedAt: STARTED, turns: 4 });
    expect(sessionLine(container)!.title).toContain(new Date(STARTED).toLocaleString());
  });

  it('leaves nothing empty when a fresh session has no counters yet', async () => {
    const container = await render({ startedAt: STARTED });

    // No dangling line and no hover target on nothing: the fact is still there.
    expect(sessionLine(container)).toBeNull();
    const carried = container.querySelector('[data-overview-started]')!;
    expect(carried).not.toBeNull();
    expect(carried.className).toContain('sr-only');
    expect(carried.textContent).toContain(new Date(STARTED).toLocaleString());
  });

  it('prints no start time at all when the session does not report one', async () => {
    const container = await render({ turns: 3 });
    expect(sessionLine(container)!.textContent).toBeTruthy();
    expect(sessionLine(container)!.title).toBe('');
    expect(container.querySelector('[data-overview-started]')).toBeNull();
  });
});

describe('the overview owns the figures, and the scope that changes them', () => {
  it('keeps 本智能体 / 全树 standing on a tree that is not fully counted, and marks it', async () => {
    // A tree the server has not finished counting is a state the rail passes
    // through on every cold open. The switch must not blink out of existence
    // while it lasts, and the marked side must say what it could not count.
    const container = await render({
      figures: { totalTokens: 1_200 },
      treeFigures: { totalTokens: 1_200, incomplete: true },
      contextUsed: 1_200, contextLimit: 100_000,
    });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const agent = group.querySelector<HTMLButtonElement>('[data-usage-scope="agent"]')!;
    const tree = group.querySelector<HTMLButtonElement>('[data-usage-scope="tree"]')!;
    expect(agent.textContent).toBe('本智能体');
    expect(tree.textContent).toContain('全树');
    expect(tree.disabled).toBe(false);
    expect(tree.hasAttribute('data-usage-scope-incomplete')).toBe(true);
    expect(tree.title).toContain('尚未上报');
  });

  it('says in words which counts the partial tree left out, and only while it is shown', async () => {
    const partial = await render({
      figures: { totalTokens: 1_200 },
      treeFigures: { totalTokens: 1_200, incomplete: true },
      scope: 'tree',
    });
    const note = partial.querySelector<HTMLElement>('[data-overview-tree-incomplete]')!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('仍在统计中');
    // The agent scope is a full count; it claims nothing it cannot back.
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
    // Measurable tree: no incomplete mark, and the control is live.
    expect(tree.disabled).toBe(false);
    expect(tree.hasAttribute('data-usage-scope-incomplete')).toBe(false);
    expect(tree.title).toBe('整棵智能体树');
    expect(container.querySelector('[data-overview-fact="cost"]')?.textContent).toContain('$0.05');
    await act(async () => { tree.click(); });
    expect(picked).toEqual(['tree']);
  });

  it('does not keep a permission mode, a model or any setup line of its own', async () => {
    // The profile card already carries model / effort / window, and the
    // composer's permission chip carries the mode. Restating either below the
    // numbers is the duplication this component exists without.
    const container = await render({
      figures: { costUsd: 0.05, totalTokens: 1_200, cacheRate: 0 },
      contextUsed: 1_200, contextLimit: 100_000, turns: 1,
    });
    expect(container.querySelector('[data-overview-setup]')).toBeNull();
    expect(container.textContent).not.toContain('自动');
    expect(container.textContent).not.toContain('完全放行');
    expect(container.textContent).not.toContain('每步询问');
    expect(container.textContent).not.toContain('权限');
    // The work line is still there, and it is the only quiet line.
    expect(sessionLine(container)!.textContent).toContain('1');
  });

  it('lays the figures out in one measured row, so an absent figure closes its gap', async () => {
    const full = await render({ figures: { costUsd: 0.05, totalTokens: 1_200, cacheRate: 12 } });
    const one = await render({ figures: { totalTokens: 1_200 } });
    // A fixed three-column grid would hold two blank thirds open next to a
    // single figure; the row is measured by its own content instead.
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

  it('keeps a partial count labelled as partial', async () => {
    const container = await render({ figures: { totalTokens: 1_200, partial: true } });
    expect(container.textContent).toContain('部分统计');
  });
});

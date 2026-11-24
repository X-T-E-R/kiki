import { visibleWidth, type SgrMouseEvent } from '@kiki/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentBreadcrumbComponent,
  type AgentBreadcrumbState,
} from '#/tui/components/chrome/agent-breadcrumb';
import {
  QueueBannerComponent,
  type QueueBannerItem,
} from '#/tui/components/chrome/queue-banner';
import {
  ContextPanelComponent,
  type ContextPanelData,
} from '#/tui/components/messages/context-panel';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function hexToRgbSequence(hex: string): string {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `\x1B[38;2;${String(r)};${String(g)};${String(b)}m`;
}

function stationaryLeftClick(col: number, row = 0): SgrMouseEvent {
  return {
    button: 0,
    col,
    row,
    release: false,
    wheel: null,
    motion: false,
    leftClick: true,
    rightClick: false,
    type: 'click',
  };
}

function columnOf(renderedLine: string, needle: string): number {
  const plain = stripAnsi(renderedLine);
  const idx = plain.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  return visibleWidth(plain.slice(0, idx));
}

describe('holistic TUI chrome & context leaf components', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
    currentTheme.setPalette(darkColors);
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    currentTheme.setPalette(darkColors);
  });

  describe('QueueBannerComponent', () => {
    it('returns zero rows when empty and after clearing', () => {
      const banner = new QueueBannerComponent();
      expect(banner.render(80)).toEqual([]);

      banner.setItems([{ id: '1', phase: 'steering', preview: 'focus on parser' }]);
      expect(banner.render(80).length).toBeGreaterThan(0);

      banner.setItems([]);
      expect(banner.render(80)).toEqual([]);
    });

    it('separates Steering (primary) and Queued (textMuted) and shows queued hint only when queued items exist', () => {
      const banner = new QueueBannerComponent();
      banner.setItems([{ id: 's1', phase: 'steering', preview: 'tighten retry logic' }]);

      const steeringOnly = banner.render(80);
      expect(steeringOnly).toHaveLength(1);
      expect(stripAnsi(steeringOnly[0]!)).toContain('Steering');
      expect(stripAnsi(steeringOnly[0]!)).toContain('↳ tighten retry logic');
      expect(steeringOnly[0]!).toContain(hexToRgbSequence(darkColors.primary));
      expect(stripAnsi(steeringOnly.join('\n'))).not.toContain('Ctrl+Enter send now');

      banner.setItems([
        { id: 'q1', phase: 'queued', preview: 'update docs next' },
        { id: 's1', phase: 'steering', preview: 'tighten retry logic' },
      ]);

      const combined = banner.render(80);
      expect(combined).toHaveLength(3);
      expect(stripAnsi(combined[0]!)).toContain('Steering');
      expect(stripAnsi(combined[0]!)).toContain('↳ tighten retry logic');
      expect(stripAnsi(combined[1]!)).toContain('Queued');
      expect(stripAnsi(combined[1]!)).toContain('↳ update docs next');
      expect(combined[1]!).toContain(hexToRgbSequence(darkColors.textMuted));
      expect(stripAnsi(combined[2]!)).toContain('↑ / Alt+↑ edit · Ctrl+Enter send now');
    });

    it('caps output at 4 rows under overflow and sanitizes control sequences and newlines', () => {
      const items: QueueBannerItem[] = [
        { id: 's1', phase: 'steering', preview: 'line1\n\x1b[31mline2\x1b[0m\t\rline3\x07' },
        { id: 's2', phase: 'steering', preview: 'second steering item' },
        { id: 's3', phase: 'steering', preview: 'third steering item' },
        { id: 'q1', phase: 'queued', preview: 'first queued' },
        { id: 'q2', phase: 'queued', preview: 'second queued' },
      ];
      const banner = new QueueBannerComponent(items);
      const lines = banner.render(80);

      expect(lines.length).toBeLessThanOrEqual(4);
      const plain = lines.map(stripAnsi);
      expect(plain[0]).toContain('↳ line1 line2 line3');
      expect(plain.join('\n')).toContain('Steering');
      expect(plain.join('\n')).toContain('Queued');
      expect(plain[plain.length - 1]).toContain('+2 more');
      expect(plain[plain.length - 1]).toContain('↑ / Alt+↑ edit · Ctrl+Enter send now');

      // Narrow widths never overflow.
      for (const line of banner.render(24)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }

      // Theme switching repaints without caching module-level chalk styles.
      currentTheme.setPalette(lightColors);
      const lightLines = banner.render(80);
      expect(lightLines[0]!).toContain(hexToRgbSequence(lightColors.primary));
    });
  });

  describe('AgentBreadcrumbComponent', () => {
    it('returns zero rows when focused on main with zero active peers', () => {
      const onSelect = vi.fn();
      const onMerge = vi.fn();
      const bar = new AgentBreadcrumbComponent(onSelect, onMerge);
      bar.setState({
        focusedAgentId: 'main',
        path: [{ id: 'main', label: 'main', kind: 'main' }],
        activePeerCount: 0,
        canMergeFocusedBranch: false,
      });

      expect(bar.render(100)).toEqual([]);
      expect(bar.routeMouse(stationaryLeftClick(2), 0, 2)).toBe(false);
      expect(onSelect).not.toHaveBeenCalled();
      expect(onMerge).not.toHaveBeenCalled();
    });

    it('renders on main when active peers exist without [main] or [Merge]', () => {
      const onSelect = vi.fn();
      const bar = new AgentBreadcrumbComponent(onSelect);
      bar.setState({
        focusedAgentId: 'main',
        path: [{ id: 'main', label: 'main', kind: 'main' }],
        activePeerCount: 2,
        canMergeFocusedBranch: false,
      });

      const lines = bar.render(100);
      expect(lines).toHaveLength(1);
      const plain = stripAnsi(lines[0]!);
      expect(plain).toContain('main');
      expect(plain).toContain('2 active');
      expect(plain).toContain('Alt+←/→ switch · /agents');
      expect(plain).not.toContain('[main]');
      expect(plain).not.toContain('[Merge]');
    });

    it('renders branch & child breadcrumbs and dispatches exact stationary leftClick spans', () => {
      const onSelect = vi.fn();
      const onMerge = vi.fn();
      const bar = new AgentBreadcrumbComponent(onSelect, onMerge);

      const branchState: AgentBreadcrumbState = {
        focusedAgentId: 'branch-ui',
        path: [
          { id: 'main', label: 'main', kind: 'main' },
          { id: 'branch-ui', label: 'refactor-ui', kind: 'branch' },
        ],
        activePeerCount: 1,
        canMergeFocusedBranch: true,
      };
      bar.setState(branchState);

      const lines = bar.render(100);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      const plain = stripAnsi(line);
      expect(plain).toContain('main ▸ ⎇ refactor-ui');
      expect(plain).toContain('[main]');
      expect(plain).toContain('[Merge]');
      expect(plain).toContain('Alt+←/→ switch · /agents');

      const mainSegCol = columnOf(line, 'main');
      const branchSegCol = columnOf(line, '⎇ refactor-ui');
      const mainBtnCol = columnOf(line, '[main]');
      const mergeBtnCol = columnOf(line, '[Merge]');

      expect(bar.routeMouse(stationaryLeftClick(mainSegCol), 0, mainSegCol)).toBe(true);
      expect(onSelect).toHaveBeenLastCalledWith('main');

      expect(bar.routeMouse(stationaryLeftClick(branchSegCol + 2), 0, branchSegCol + 2)).toBe(true);
      expect(onSelect).toHaveBeenLastCalledWith('branch-ui');

      expect(bar.routeMouse(stationaryLeftClick(mainBtnCol + 1), 0, mainBtnCol + 1)).toBe(true);
      expect(onSelect).toHaveBeenLastCalledWith('main');

      expect(bar.routeMouse(stationaryLeftClick(mergeBtnCol + 1), 0, mergeBtnCol + 1)).toBe(true);
      expect(onMerge).toHaveBeenCalledTimes(1);
      expect(onMerge).toHaveBeenCalledWith('branch-ui');

      // Non-stationary / non-left-click / wrong line events must not dispatch.
      expect(
        bar.routeMouse(
          { ...stationaryLeftClick(mergeBtnCol), motion: true },
          0,
          mergeBtnCol,
        ),
      ).toBe(false);
      expect(
        bar.routeMouse(
          { ...stationaryLeftClick(mergeBtnCol), release: true, leftClick: false },
          0,
          mergeBtnCol,
        ),
      ).toBe(false);
      expect(bar.routeMouse(stationaryLeftClick(mergeBtnCol), 1, mergeBtnCol)).toBe(false);
      expect(onMerge).toHaveBeenCalledTimes(1);

      // Child view omits [Merge] when canMergeFocusedBranch is false.
      bar.setState({
        focusedAgentId: 'child-1',
        path: [
          { id: 'main', label: 'main', kind: 'main' },
          { id: 'child-1', label: 'worker-1', kind: 'child', phase: 'running' },
        ],
        activePeerCount: 1,
        canMergeFocusedBranch: false,
      });
      const childLines = bar.render(100);
      const childPlain = stripAnsi(childLines[0]!);
      expect(childPlain).toContain('main ▸ ● worker-1 (running)');
      expect(childPlain).toContain('[main]');
      expect(childPlain).not.toContain('[Merge]');

      // Narrow width keeps buttons accurate and respects width cap.
      bar.setState(branchState);
      const narrow = bar.render(34);
      expect(narrow).toHaveLength(1);
      expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(34);
      const narrowMergeCol = columnOf(narrow[0]!, '[Merge]');
      expect(bar.routeMouse(stationaryLeftClick(narrowMergeCol), 0, narrowMergeCol)).toBe(true);
      expect(onMerge).toHaveBeenCalledTimes(2);
    });
  });

  describe('ContextPanelComponent', () => {
    it('renders bordered box, target header, stacked proportional ASCII bar, and estimated rows with positive limit', () => {
      const data: ContextPanelData = {
        targetLabel: 'main',
        contextTokens: 32 * 1024,
        maxContextTokens: 128 * 1024,
        breakdown: {
          systemTokens: 4 * 1024,
          toolsTokens: 8 * 1024,
          messagesTokens: 20 * 1024,
          estimated: true,
        },
      };
      const panel = new ContextPanelComponent(data);
      const lines = panel.render(80);
      const plain = lines.map(stripAnsi).join('\n');

      // Primary top/bottom horizontal box borders.
      expect(stripAnsi(lines[0]!)).toMatch(/╭─+╮/);
      expect(stripAnsi(lines[lines.length - 1]!)).toMatch(/╰─+╯/);
      expect(lines[0]!).toContain(hexToRgbSequence(darkColors.primary));
      expect(lines[lines.length - 1]!).toContain(hexToRgbSequence(darkColors.primary));

      expect(plain).toContain('Context window · main');
      expect(plain).toContain('32k / 128k (25%)');

      // Stacked proportional ASCII bar with System (#), Tools (=), Messages (+), Free (.).
      const barMatch = plain.match(/\[([#=+.-]+)\]/);
      expect(barMatch).not.toBeNull();
      const barBody = barMatch![1]!;
      expect(barBody).toContain('#');
      expect(barBody).toContain('=');
      expect(barBody).toContain('+');
      expect(barBody).toContain('.');

      // Explicit estimated buckets + Free, and no invented buckets.
      expect(plain).toMatch(/System\s+4k\s+\(estimated\)/);
      expect(plain).toMatch(/Tools\s+8k\s+\(estimated\)/);
      expect(plain).toMatch(/Messages\s+20k\s+\(estimated\)/);
      expect(plain).toMatch(/Free\s+96k/);
      expect(plain).not.toMatch(/\b(MCP|Skills|Memory|Auto-compact)\b/i);
    });

    it('never renders a percentage or Free row when maxContextTokens is missing or <= 0', () => {
      for (const maxContextTokens of [undefined, 0, -4096] as const) {
        const panel = new ContextPanelComponent({
          targetLabel: 'worker-2',
          contextTokens: 16 * 1024,
          maxContextTokens,
          breakdown: {
            systemTokens: 2 * 1024,
            toolsTokens: 4 * 1024,
            messagesTokens: 10 * 1024,
            estimated: true,
          },
        });
        const plain = panel.render(80).map(stripAnsi).join('\n');
        expect(plain).toContain('Context window · worker-2');
        expect(plain).toContain('16k');
        expect(plain).not.toContain('%');
        expect(plain).not.toContain('Free');
        expect(plain).toContain('(estimated)');
      }
    });

    it('renders Breakdown unavailable and optional reason when breakdown is omitted', () => {
      const panel = new ContextPanelComponent({
        targetLabel: 'main',
        contextTokens: 12 * 1024,
        maxContextTokens: 64 * 1024,
        unavailableReason: 'provider did not report per-bucket token counts',
      });
      const plain = panel.render(80).map(stripAnsi).join('\n');

      expect(plain).toContain('Context window · main');
      expect(plain).toContain('12k / 64k (19%)');
      expect(plain).toContain('Breakdown unavailable');
      expect(plain).toContain('provider did not report per-bucket token counts');

      // Narrow widths never overflow and light theme repaints borders.
      currentTheme.setPalette(lightColors);
      for (const w of [24, 12, 6]) {
        const rendered = panel.render(w);
        for (const line of rendered) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(w);
        }
      }
      expect(panel.render(80)[0]!).toContain(hexToRgbSequence(lightColors.primary));
    });
  });
});

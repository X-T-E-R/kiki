/**
 * AgentBreadcrumbComponent — single-line focus/navigation chrome bar showing
 * the active agent/branch path, quick `[main]` / `[Merge]` controls, and
 * keyboard hints.
 *
 * Returns zero rows when focused on `main` with no active peers. Records exact
 * visible column hit spans during `render(width)` for stationary left clicks.
 */

import type { Component, MouseRoutable, SgrMouseEvent } from '@kiki/pi-tui';
import { truncateToWidth, visibleWidth } from '@kiki/pi-tui';

import { FOLD_COLLAPSED_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

export interface AgentBreadcrumbSegment {
  readonly id: string;
  readonly label: string;
  readonly kind: 'main' | 'branch' | 'child';
  readonly phase?: string;
}

export interface AgentBreadcrumbState {
  readonly focusedAgentId: string;
  readonly path: readonly AgentBreadcrumbSegment[];
  readonly activePeerCount: number;
  readonly canMergeFocusedBranch: boolean;
}

type HitAction =
  | { readonly kind: 'select'; readonly agentId: string }
  | { readonly kind: 'merge'; readonly branchId: string };

interface BreadcrumbHitSpan {
  readonly startCol: number;
  readonly endCol: number;
  readonly action: HitAction;
}

interface ActionButton {
  readonly raw: string;
  readonly styled: string;
  readonly width: number;
  readonly action: HitAction;
}

const BRANCH_MARK = '⎇';
const CHILD_MARK = STATUS_BULLET.trim();
const PATH_SEPARATOR = ` ${FOLD_COLLAPSED_MARK} `;
const MAIN_BUTTON_LABEL = '[main]';
const MERGE_BUTTON_LABEL = '[Merge]';
const RIGHT_HINT = 'Alt+←/→ switch · /agents';
const DEFAULT_STATE: AgentBreadcrumbState = {
  focusedAgentId: 'main',
  path: [],
  activePeerCount: 0,
  canMergeFocusedBranch: false,
};

function sanitizeInline(text: string): string {
  return sanitizeShellOutput(text)
    .replace(/[\r\n\t\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSegmentText(segment: AgentBreadcrumbSegment): string {
  const label = sanitizeInline(segment.label) || sanitizeInline(segment.id) || 'agent';
  const phase = segment.phase !== undefined ? sanitizeInline(segment.phase) : '';
  const phaseSuffix = phase.length > 0 ? ` (${phase})` : '';
  if (segment.kind === 'branch') return `${BRANCH_MARK} ${label}${phaseSuffix}`;
  if (segment.kind === 'child') return `${CHILD_MARK} ${label}${phaseSuffix}`;
  return `${label}${phaseSuffix}`;
}

export class AgentBreadcrumbComponent implements Component, MouseRoutable {
  private state: AgentBreadcrumbState = DEFAULT_STATE;
  private hitSpans: BreadcrumbHitSpan[] = [];

  constructor(
    private readonly onSelectAgent: (agentId: string) => void,
    private readonly onMergeBranch?: (branchId: string) => void,
  ) {}

  setState(state: AgentBreadcrumbState): void {
    this.state = state;
  }

  invalidate(): void {}

  routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
    if (!event.leftClick || event.motion || event.release || event.wheel !== null) return false;
    if (line !== 0) return false;

    const hit = this.hitSpans.find((span) => col >= span.startCol && col < span.endCol);
    if (hit === undefined) return false;

    if (hit.action.kind === 'select') {
      this.onSelectAgent(hit.action.agentId);
      return true;
    }

    if (this.onMergeBranch === undefined) return false;
    this.onMergeBranch(hit.action.branchId);
    return true;
  }

  render(width: number): string[] {
    if (width <= 0) {
      this.hitSpans = [];
      return [];
    }

    const { focusedAgentId, activePeerCount, canMergeFocusedBranch } = this.state;
    if (focusedAgentId === 'main' && activePeerCount === 0) {
      this.hitSpans = [];
      return [];
    }

    const segments: readonly AgentBreadcrumbSegment[] =
      this.state.path.length > 0
        ? this.state.path
        : [
            {
              id: focusedAgentId,
              label: focusedAgentId,
              kind: focusedAgentId === 'main' ? 'main' : 'child',
            },
          ];

    const buttons: ActionButton[] = [];
    if (focusedAgentId !== 'main') {
      buttons.push({
        raw: MAIN_BUTTON_LABEL,
        styled: currentTheme.fg('primary', MAIN_BUTTON_LABEL),
        width: visibleWidth(MAIN_BUTTON_LABEL),
        action: { kind: 'select', agentId: 'main' },
      });
    }
    if (canMergeFocusedBranch) {
      buttons.push({
        raw: MERGE_BUTTON_LABEL,
        styled: currentTheme.boldFg('accent', MERGE_BUTTON_LABEL),
        width: visibleWidth(MERGE_BUTTON_LABEL),
        action: { kind: 'merge', branchId: focusedAgentId },
      });
    }

    const buttonsTotalWidth =
      buttons.length === 0
        ? 0
        : 2 +
          buttons.reduce((sum, btn, idx) => sum + btn.width + (idx > 0 ? 1 : 0), 0);

    const indent = width >= 12 ? '  ' : '';
    const reserveButtons = buttonsTotalWidth > 0 && width >= indent.length + buttonsTotalWidth + 8;
    const pathLimit = reserveButtons ? width - buttonsTotalWidth : width;

    const spans: BreadcrumbHitSpan[] = [];
    const parts: string[] = [];
    let col = 0;

    if (indent.length > 0) {
      parts.push(indent);
      col += indent.length;
    }

    const sepStyled = currentTheme.fg('textMuted', PATH_SEPARATOR);
    const sepWidth = visibleWidth(PATH_SEPARATOR);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (i > 0) {
        if (col + sepWidth >= pathLimit) break;
        parts.push(sepStyled);
        col += sepWidth;
      }

      const remaining = pathLimit - col;
      if (remaining <= 0) break;

      const rawText = formatSegmentText(seg);
      const isFocused = seg.id === focusedAgentId;
      const styled = isFocused
        ? currentTheme.boldFg('primary', rawText)
        : currentTheme.fg('text', rawText);
      const segWidth = visibleWidth(rawText);

      if (segWidth <= remaining) {
        parts.push(styled);
        spans.push({
          startCol: col,
          endCol: col + segWidth,
          action: { kind: 'select', agentId: seg.id },
        });
        col += segWidth;
      } else {
        const clipped = truncateToWidth(styled, remaining, '…');
        const clippedWidth = visibleWidth(clipped);
        if (clippedWidth > 0) {
          parts.push(clipped);
          spans.push({
            startCol: col,
            endCol: col + clippedWidth,
            action: { kind: 'select', agentId: seg.id },
          });
          col += clippedWidth;
        }
        break;
      }
    }

    // When on main with active peers, show peer count inline if room permits.
    if (focusedAgentId === 'main' && activePeerCount > 0) {
      const peerText = ` · ${String(activePeerCount)} active`;
      const peerWidth = visibleWidth(peerText);
      if (col + peerWidth <= pathLimit) {
        parts.push(currentTheme.fg('textMuted', peerText));
        col += peerWidth;
      }
    }

    // Render action buttons (`[main]`, `[Merge]`) with exact column spans.
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i]!;
      const gap = i === 0 ? '  ' : ' ';
      if (col + gap.length + btn.width > width) break;
      parts.push(gap);
      col += gap.length;
      parts.push(btn.styled);
      spans.push({
        startCol: col,
        endCol: col + btn.width,
        action: btn.action,
      });
      col += btn.width;
    }

    // Right-align keyboard hint when it fits without crowding controls.
    const hintWidth = visibleWidth(RIGHT_HINT);
    if (col + 2 + hintWidth <= width) {
      const pad = width - col - hintWidth;
      parts.push(' '.repeat(pad));
      parts.push(currentTheme.fg('textMuted', RIGHT_HINT));
    }

    this.hitSpans = spans;
    return [truncateToWidth(parts.join(''), width, '…')];
  }
}

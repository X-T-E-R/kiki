import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type MouseRoutable,
  type SgrMouseEvent,
} from '@kiki/pi-tui';

import { FOLD_COLLAPSED_MARK, FOLD_EXPANDED_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export interface LiveSubagentRowData {
  readonly blockId: string;
  readonly subagentId: string;
  readonly name: string;
  readonly description?: string;
  readonly summary?: string;
  readonly status: string;
  readonly isLive: boolean;
  readonly activity?: string;
  readonly error?: string;
  readonly expanded: boolean;
}

interface HitRegion {
  readonly row: number;
  readonly inspectStartCol: number;
  readonly inspectEndCol: number;
  readonly blockId: string;
  readonly subagentId: string;
}

const INSPECT_BADGE = '[inspect →]';

function statusBadge(status: string, isLive: boolean): string {
  if (status === 'failed' || status === 'lost' || status === 'cancelled') {
    return currentTheme.fg('error', `✗ ${status}`);
  }
  if (!isLive) {
    return currentTheme.fg('success', `✓ ${status}`);
  }
  return currentTheme.fg('primary', `${STATUS_BULLET.trim()} ${status}`);
}

/**
 * Rich live card for a single active subagent block so running/background/suspended
 * subagents never collapse into a 1-line opaque box while work is in flight.
 */
export class LiveSubagentCardComponent implements Component, MouseRoutable {
  private data: LiveSubagentRowData;
  private hit: HitRegion | undefined;

  constructor(
    data: LiveSubagentRowData,
    private readonly onToggleExpand: (blockId: string, expanded: boolean) => void,
    private readonly onInspect?: (subagentId: string) => void,
  ) {
    this.data = data;
  }

  update(data: LiveSubagentRowData): void {
    this.data = data;
  }

  invalidate(): void {}

  routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
    if (!event.leftClick || this.hit === undefined || line !== this.hit.row) return false;
    if (
      this.onInspect !== undefined &&
      this.hit.inspectStartCol >= 0 &&
      col >= this.hit.inspectStartCol &&
      col < this.hit.inspectEndCol
    ) {
      this.onInspect(this.hit.subagentId);
      return true;
    }
    this.onToggleExpand(this.hit.blockId, !this.data.expanded);
    return true;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const marker = this.data.expanded
      ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
      : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
    const desc = this.data.description ? currentTheme.dim(` · ${this.data.description}`) : '';
    const lead = `  ${marker} ${statusBadge(this.data.status, this.data.isLive)} ${currentTheme.boldFg('primary', this.data.name)}${desc}`;
    let headerLine = lead;
    let inspectStartCol = -1;
    let inspectEndCol = -1;
    if (this.onInspect !== undefined && safeWidth >= 28) {
      const badgeWidth = visibleWidth(INSPECT_BADGE);
      const maxLeadWidth = Math.max(1, safeWidth - badgeWidth - 2);
      const clippedLead = truncateToWidth(lead, maxLeadWidth, '…');
      const leadWidth = visibleWidth(clippedLead);
      inspectStartCol = leadWidth + 2;
      inspectEndCol = inspectStartCol + badgeWidth;
      headerLine = `${clippedLead}  ${currentTheme.fg('accent', INSPECT_BADGE)}`;
    } else {
      headerLine = truncateToWidth(lead, safeWidth, '…');
    }
    this.hit = {
      row: 1,
      inspectStartCol,
      inspectEndCol,
      blockId: this.data.blockId,
      subagentId: this.data.subagentId,
    };

    const lines = ['', headerLine];
    if (this.data.error !== undefined && this.data.error.length > 0) {
      const errFirst = this.data.error.split(/\r?\n/u, 1)[0] ?? this.data.error;
      lines.push(truncateToWidth(`      ${currentTheme.fg('error', `Error: ${errFirst}`)}`, safeWidth, '…'));
    } else if (this.data.activity !== undefined && this.data.activity.length > 0) {
      lines.push(truncateToWidth(`      ${currentTheme.dim(this.data.activity)}`, safeWidth, '…'));
    }

    if (this.data.expanded && this.data.summary !== undefined && this.data.summary.length > 0) {
      for (const rawLine of this.data.summary.split(/\r?\n/u)) {
        lines.push(truncateToWidth(`      ${currentTheme.dim(rawLine)}`, safeWidth, '…'));
      }
    }
    return lines;
  }
}

/**
 * Rich live group renderer for a `SubagentGroup` containing at least one live child.
 * Shows one identifiable row per live or failed child with independent disclosure
 * toggle and `[inspect →]` transcript jump hit targets.
 */
export class LiveSubagentGroupComponent implements Component, MouseRoutable {
  private rows: readonly LiveSubagentRowData[];
  private groupExpanded: boolean;
  private childHits: HitRegion[] = [];

  constructor(
    rows: readonly LiveSubagentRowData[],
    groupExpanded: boolean,
    private readonly onToggleGroup: () => void,
    private readonly onToggleChild: (blockId: string, expanded: boolean) => void,
    private readonly onInspect?: (subagentId: string) => void,
  ) {
    this.rows = rows;
    this.groupExpanded = groupExpanded;
  }

  update(rows: readonly LiveSubagentRowData[], groupExpanded: boolean): void {
    this.rows = rows;
    this.groupExpanded = groupExpanded;
  }

  invalidate(): void {}

  routeMouse(event: SgrMouseEvent, line: number, col: number): boolean {
    if (!event.leftClick) return false;
    if (line === 1) {
      this.onToggleGroup();
      return true;
    }
    for (const hit of this.childHits) {
      if (line !== hit.row) continue;
      if (
        this.onInspect !== undefined &&
        hit.inspectStartCol >= 0 &&
        col >= hit.inspectStartCol &&
        col < hit.inspectEndCol
      ) {
        this.onInspect(hit.subagentId);
        return true;
      }
      const row = this.rows.find((item) => item.blockId === hit.blockId);
      if (row !== undefined) {
        this.onToggleChild(row.blockId, !row.expanded);
        return true;
      }
    }
    return false;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const total = this.rows.length;
    const liveCount = this.rows.filter((r) => r.isLive).length;
    const failedCount = this.rows.filter(
      (r) => r.status === 'failed' || r.status === 'lost' || (r.error !== undefined && r.error.length > 0),
    ).length;
    const doneCount = total - liveCount - failedCount;

    const counts: string[] = [];
    if (liveCount > 0) counts.push(`${String(liveCount)} active`);
    if (doneCount > 0) counts.push(`${String(doneCount)} done`);
    if (failedCount > 0) counts.push(`${String(failedCount)} failed`);

    const groupMarker = this.groupExpanded
      ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
      : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
    const headerTitle = `Agents · ${String(total)} (${counts.join(', ')})`;
    const headerLine = truncateToWidth(
      `  ${groupMarker} ${currentTheme.boldFg('primary', headerTitle)}`,
      safeWidth,
      '…',
    );

    const lines = ['', headerLine];
    this.childHits = [];

    // Even if user collapsed the group header, keep failed children visible; when
    // expanded (default while live), render every live/failed child plus settled summary.
    const visibleRows = this.groupExpanded
      ? this.rows.filter((r) => r.isLive || r.status === 'failed' || r.status === 'lost' || r.expanded || (r.error !== undefined && r.error.length > 0))
      : this.rows.filter((r) => r.status === 'failed' || r.status === 'lost' || (r.error !== undefined && r.error.length > 0));
    const hiddenDoneCount = this.groupExpanded ? total - visibleRows.length : 0;

    visibleRows.forEach((row, index) => {
      const isLast = index === visibleRows.length - 1 && hiddenDoneCount === 0;
      const branch = isLast ? '└─' : '├─';
      const cont = isLast ? '   ' : '│  ';
      const childMarker = row.expanded
        ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
        : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
      const desc = row.description ? currentTheme.dim(` · ${row.description}`) : '';
      const lead = `  ${currentTheme.dim(branch)} ${childMarker} ${statusBadge(row.status, row.isLive)} ${currentTheme.fg('primary', row.name)}${desc}`;

      let rowLine = lead;
      let inspectStartCol = -1;
      let inspectEndCol = -1;
      if (this.onInspect !== undefined && safeWidth >= 32) {
        const badgeWidth = visibleWidth(INSPECT_BADGE);
        const maxLeadWidth = Math.max(1, safeWidth - badgeWidth - 2);
        const clippedLead = truncateToWidth(lead, maxLeadWidth, '…');
        const leadWidth = visibleWidth(clippedLead);
        inspectStartCol = leadWidth + 2;
        inspectEndCol = inspectStartCol + badgeWidth;
        rowLine = `${clippedLead}  ${currentTheme.fg('accent', INSPECT_BADGE)}`;
      } else {
        rowLine = truncateToWidth(lead, safeWidth, '…');
      }

      const rowIndex = lines.length;
      this.childHits.push({
        row: rowIndex,
        inspectStartCol,
        inspectEndCol,
        blockId: row.blockId,
        subagentId: row.subagentId,
      });
      lines.push(rowLine);

      if (row.error !== undefined && row.error.length > 0) {
        const firstErr = row.error.split(/\r?\n/u, 1)[0] ?? row.error;
        lines.push(
          truncateToWidth(`  ${currentTheme.dim(cont)}  ${currentTheme.fg('error', `Error: ${firstErr}`)}`, safeWidth, '…'),
        );
      } else if (row.isLive && row.activity !== undefined && row.activity.length > 0) {
        lines.push(
          truncateToWidth(`  ${currentTheme.dim(cont)}  ${currentTheme.dim(row.activity)}`, safeWidth, '…'),
        );
      }
      if (row.expanded && row.summary !== undefined && row.summary.length > 0) {
        for (const rawLine of row.summary.split(/\r?\n/u).slice(0, 6)) {
          lines.push(truncateToWidth(`  ${currentTheme.dim(cont)}  ${currentTheme.dim(rawLine)}`, safeWidth, '…'));
        }
      }
    });

    if (hiddenDoneCount > 0) {
      lines.push(
        truncateToWidth(
          `  ${currentTheme.dim(`└─ ${String(hiddenDoneCount)} finished peer${hiddenDoneCount === 1 ? '' : 's'}`)}`,
          safeWidth,
          '…',
        ),
      );
    }

    return lines;
  }
}

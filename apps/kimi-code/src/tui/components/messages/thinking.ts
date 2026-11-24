/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 */

import {
  extractThinkingSummary,
  formatThinkingDuration,
  sanitizeThinkingText,
} from '@kiki/session-core/session';
import {
  Text,
  truncateToWidth,
  type Component,
  type MouseRoutable,
  type SgrMouseEvent,
  type TUI,
} from '@kiki/pi-tui';

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MESSAGE_INDENT,
  THINKING_PREVIEW_LINES,
} from '#/tui/constant/rendering';
import { FOLD_COLLAPSED_MARK, FOLD_EXPANDED_MARK } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component, MouseRoutable {
  private text: string;
  private cleanText: string;
  private mode: ThinkingRenderMode;
  private expanded = false;
  private durationMs: number | undefined;
  private onToggleExpanded: ((expanded: boolean) => void) | undefined;
  private readonly ui: TUI | undefined;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | undefined;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;
  private hasTruncationHint = false;

  constructor(
    text: string,
    _showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    ui?: TUI,
  ) {
    this.text = text;
    this.cleanText = sanitizeThinkingText(text);
    this.mode = mode;
    this.ui = ui;
    this.textComponent = new Text(this.styled(this.cleanText), 0, 0);
    if (mode === 'live') {
      this.startSpinner();
    }
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.cleanText));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.cleanText = sanitizeThinkingText(text);
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.cleanText));
  }

  setDurationMs(durationMs: number | undefined): void {
    if (this.durationMs === durationMs) return;
    this.durationMs = durationMs;
    this.markRenderDirty();
  }

  setOnToggleExpanded(listener: ((expanded: boolean) => void) | undefined): void {
    this.onToggleExpanded = listener;
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(): void {
    if (this.mode === 'finalized') return;
    this.mode = 'finalized';
    this.markRenderDirty();
    this.stopSpinner();
  }

  dispose(): void {
    this.stopSpinner();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (!event.leftClick) return false;
    const isHeaderRow = line === 1;
    const isHintRow = this.hasTruncationHint && line === 1 + THINKING_PREVIEW_LINES;
    if (!isHeaderRow && !isHintRow) return false;
    this.setExpanded(!this.expanded);
    this.onToggleExpanded?.(this.expanded);
    this.ui?.requestRender();
    return true;
  }

  private buildHeaderLine(width: number): string {
    const isLive = this.mode === 'live';
    const marker = this.expanded
      ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
      : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
    const headline = extractThinkingSummary(this.text, { streaming: isLive });
    const duration = formatThinkingDuration(this.durationMs);
    const parts: string[] = [];
    if (isLive) {
      const spinner = BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0];
      parts.push(headline !== undefined ? `${spinner} Thinking: ${headline}` : `${spinner} Thinking`);
    } else {
      parts.push(headline !== undefined ? `Thought: ${headline}` : 'Thought');
    }
    if (duration !== undefined) parts.push(duration);
    const label = parts.join(' · ');
    return truncateToWidth(`  ${marker} ${currentTheme.fg('textDim', label)}`, Math.max(1, width), '…');
  }

  render(width: number): string[] {
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      return this.renderCache.lines;
    }

    this.hasTruncationHint = false;
    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.cleanText.length > 0 ? this.textComponent.render(contentWidth) : [];
    const header = this.buildHeaderLine(width);

    let rendered: string[];
    if (this.mode === 'live') {
      if (this.expanded) {
        rendered = ['', header, ...contentLines.map((line) => MESSAGE_INDENT + line)];
      } else {
        const visibleLines =
          contentLines.length > THINKING_PREVIEW_LINES
            ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
            : contentLines;
        rendered = ['', header, ...visibleLines.map((line) => MESSAGE_INDENT + line)];
      }
    } else if (this.expanded) {
      rendered = ['', header, ...contentLines.map((line) => MESSAGE_INDENT + line)];
    } else {
      // Settled compact state: single informative header (`▸ Thought: <headline> · <duration>`)
      // with zero raw multi-line leakage.
      rendered = ['', header];
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }

  private startSpinner(): void {
    if (this.ui === undefined || this.spinnerInterval !== undefined) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      this.markRenderDirty();
      this.ui?.requestRender();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval === undefined) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }
}

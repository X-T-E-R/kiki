/**
 * Renders a user message in the transcript.
 */

import { Spacer, Text, truncateToWidth, visibleWidth, type Component } from '@kiki/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { USER_MESSAGE_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { markOsc133Zone } from '#/tui/utils/osc133';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

function sanitizeViaClient(viaClient?: string): string | undefined {
  if (viaClient === undefined) return undefined;
  const cleaned = sanitizeShellOutput(viaClient).replaceAll(/[\u007F-\u009F\s]+/gu, ' ').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export class UserMessageComponent implements Component {
  private text: string;
  private readonly bullet?: string;
  private sourceLabel?: string;
  private viaClient?: string;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    text: string,
    images?: ImageAttachment[],
    bullet?: string,
    sourceLabel?: string,
    viaClient?: string,
  ) {
    this.text = text;
    this.bullet = bullet;
    this.sourceLabel = sourceLabel;
    this.viaClient = sanitizeViaClient(viaClient);
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
  }

  updateContent(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
  }

  setSourceLabel(sourceLabel?: string): void {
    if (this.sourceLabel === sourceLabel) return;
    this.sourceLabel = sourceLabel;
    this.markRenderDirty();
  }

  setViaClient(viaClient?: string): void {
    const next = sanitizeViaClient(viaClient);
    if (this.viaClient === next) return;
    this.viaClient = next;
    this.markRenderDirty();
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.markRenderDirty();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const marker = this.bullet ?? USER_MESSAGE_BULLET;
    const bullet = marker.length > 0 ? currentTheme.boldFg('roleUser', marker) : '';
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(safeWidth)) {
      lines.push(line);
    }

    // Text is re-dyed from the current theme; invalidate() (theme change) clears
    // the render cache so the new colours are picked up on the next render.
    const indent = ' '.repeat(bulletWidth);
    if (this.sourceLabel !== undefined) {
      const sourceLines = new Text(currentTheme.fg('textDim', this.sourceLabel), 0, 0).render(
        contentWidth,
      );
      for (let i = 0; i < sourceLines.length; i++) {
        lines.push((i === 0 ? bullet : indent) + sourceLines[i]);
      }
    }

    const hasText = this.text.length > 0;
    const textLines =
      hasText || this.viaClient === undefined
        ? new Text(currentTheme.boldFg('roleUser', this.text), 0, 0).render(contentWidth)
        : [];
    for (let i = 0; i < textLines.length; i++) {
      const prefix = this.sourceLabel === undefined && i === 0 ? bullet : indent;
      lines.push(prefix + textLines[i]);
    }

    if (this.viaClient !== undefined) {
      const viaPlain = `via ${this.viaClient}`;
      if (hasText && textLines.length > 0) {
        const trimmedLastText = textLines.at(-1)!.replace(/ +$/u, '');
        if (visibleWidth(trimmedLastText) + 2 + visibleWidth(viaPlain) <= contentWidth) {
          const trimmedRenderedLast = lines.at(-1)!.replace(/ +$/u, '');
          lines[lines.length - 1] = `${trimmedRenderedLast}  ${currentTheme.fg('textDim', viaPlain)}`;
        } else {
          lines.push(indent + currentTheme.fg('textDim', truncateToWidth(viaPlain, contentWidth, '…')));
        }
      } else {
        const prefix = this.sourceLabel === undefined ? bullet : indent;
        lines.push(prefix + currentTheme.fg('textDim', truncateToWidth(viaPlain, contentWidth, '…')));
      }
    }

    // Images — indented to align with text after the bullet
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(contentWidth);
      for (const line of imageLines) {
        lines.push(' '.repeat(bulletWidth) + line);
      }
    }

    const rendered = markOsc133Zone(
      lines.map((line) => {
        // Inline image sequences (Kitty / iTerm2) carry their own placement
        // information and have zero visible width, but pi-tui's truncateToWidth
        // treats the embedded base64 payload as visible text and would chop the
        // escape sequence in half, leaving garbage like "0m...". Skip truncation
        // for those lines; the image itself already respects maxWidthCells.
        if (isImageLine(line)) return line;
        return truncateToWidth(line, safeWidth, '…');
      }),
    );
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}

function isImageLine(line: string): boolean {
  return line.includes('\u001B_G') || line.includes('\u001B]1337;File=');
}

/**
 * Invisible turn-boundary marker for replay. Some replayed records start a
 * new turn without anything to show — the goal driver's synthetic
 * continuation prompt is model-facing and never rendered live — but the
 * transcript still needs a mounted boundary component so step/assistant
 * folding (and window trimming) can find the turn edges. Renders zero lines.
 */
export class ReplayTurnBoundaryComponent implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [];
  }
}

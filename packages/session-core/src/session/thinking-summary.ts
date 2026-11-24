/**
 * Pure display helpers for extracting concise, readable thinking summaries
 * from already-visible reasoning text without fabricating withheld content.
 */

const EMPTY_HTML_COMMENT = /<!--\s*-->/gu;
const TRAILING_OPEN_COMMENT = /<!--[^>]*$/u;
const REDACTED_LINE = /^\s*\[REDACTED\]\s*$/giu;
const INLINE_REDACTED = /\[REDACTED\]/giu;
const BOLD_HEADING_RE = /^\*\*([^*\n]{2,140})\*\*(?:\s*[:—–-]\s*)?$/u;
const MARKDOWN_HEADING_RE = /^#{1,3}\s+(.{2,140})$/u;
const UNTERMINATED_BOLD_RE = /^\*\*[^*\n]+$/u;

export interface ExtractThinkingSummaryOptions {
  readonly streaming?: boolean;
  readonly maxChars?: number;
}

/**
 * Strip empty HTML comment noise (e.g. `<!-- -->` emitted by reasoning models)
 * and placeholder-only `[REDACTED]` markers while preserving genuine prose.
 */
export function sanitizeThinkingText(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(EMPTY_HTML_COMMENT, '');
  cleaned = cleaned.replace(REDACTED_LINE, '');
  // If after removing inline [REDACTED] nothing remains on a line, drop that noise line.
  const lines = cleaned.split(/\r?\n/u).map((line) => {
    const withoutRedacted = line.replace(INLINE_REDACTED, '').trim();
    return withoutRedacted.length === 0 && line.trim().length > 0 ? '' : line;
  });
  return lines.join('\n').replace(/^\n+|\n+$/gu, '');
}

function clipSummary(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function extractHeadingFromLine(trimmed: string): string | undefined {
  const bold = BOLD_HEADING_RE.exec(trimmed);
  if (bold !== null) {
    const inner = bold[1]!.trim();
    return inner.length > 0 ? inner : undefined;
  }
  const md = MARKDOWN_HEADING_RE.exec(trimmed);
  if (md !== null) {
    const inner = md[1]!.replace(/^\*\*|\*\*$/gu, '').trim();
    return inner.length > 0 ? inner : undefined;
  }
  return undefined;
}

/**
 * Extract a concise thinking headline from visible reasoning text:
 * - While streaming: prefers the latest *complete* standalone `**Heading**`
 *   or `# Heading`, holding the previous complete heading across an incomplete
 *   trailing heading or partial `<!--` token.
 * - When settled: uses the latest complete heading if present, otherwise falls
 *   back to the first non-empty display line clipped to `maxChars`.
 * - Returns `undefined` when no displayable text exists (e.g. only `[REDACTED]`
 *   or empty comments).
 */
export function extractThinkingSummary(
  text: string,
  options: ExtractThinkingSummaryOptions = {},
): string | undefined {
  const streaming = options.streaming === true;
  const maxChars = Math.max(12, options.maxChars ?? 72);
  let cleaned = sanitizeThinkingText(text);
  if (streaming) {
    cleaned = cleaned.replace(TRAILING_OPEN_COMMENT, '').trimEnd();
  }
  if (cleaned.trim().length === 0) return undefined;

  const rawLines = cleaned.split(/\r?\n/u);
  const endsWithNewline = /\r?\n$/u.test(text);

  let latestCompleteHeading: string | undefined;
  let firstDisplayLine: string | undefined;

  for (let i = 0; i < rawLines.length; i += 1) {
    const trimmed = rawLines[i]!.trim();
    if (trimmed.length === 0) continue;
    const isLastOpenLine = streaming && !endsWithNewline && i === rawLines.length - 1;
    if (isLastOpenLine && (UNTERMINATED_BOLD_RE.test(trimmed) || trimmed.startsWith('<!--'))) {
      continue;
    }
    const heading = extractHeadingFromLine(trimmed);
    if (heading !== undefined) {
      latestCompleteHeading = heading;
    } else if (firstDisplayLine === undefined && !trimmed.startsWith('<!--')) {
      firstDisplayLine = trimmed.replace(/^\*+|\*+$/gu, '').trim();
    }
  }

  if (latestCompleteHeading !== undefined) {
    return clipSummary(latestCompleteHeading, maxChars);
  }
  if (!streaming && firstDisplayLine !== undefined && firstDisplayLine.length > 0) {
    return clipSummary(firstDisplayLine, maxChars);
  }
  return undefined;
}

/** Format a non-negative observed/canonical thinking duration in ms. */
export function formatThinkingDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 1) return '<1s';
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds)}s`;
}

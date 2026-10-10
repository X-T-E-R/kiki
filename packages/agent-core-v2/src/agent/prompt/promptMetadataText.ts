import type { ContentPart } from '#/kosong/contract/message';
import { matchSingleMediaPathTag } from '#/agent/media/mediaRef';

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

interface MetadataTextRange {
  start: number;
  end: number;
}

interface MetadataPresentationSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

function readPresentationSpans(value: unknown): readonly MetadataPresentationSpan[] {
  if (typeof value !== 'object' || value === null) return [];
  const spans = (value as { spans?: unknown }).spans;
  if (!Array.isArray(spans)) return [];
  return spans.filter((span): span is MetadataPresentationSpan => {
    if (typeof span !== 'object' || span === null) return false;
    const candidate = span as { start?: unknown; end?: unknown; kind?: unknown };
    return Number.isInteger(candidate.start) && Number.isInteger(candidate.end) && typeof candidate.kind === 'string';
  });
}

function imageCompressionRanges(text: string, presentation: unknown): MetadataTextRange[] {
  const ranges = readPresentationSpans(presentation)
    .filter((span) => span.kind === 'image_compression' && span.start >= 0 && span.end > span.start && span.end <= text.length)
    .map(({ start, end }) => ({ start, end }))
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: MetadataTextRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

function removeMarkedCompressionText(text: string, presentation: unknown): string {
  const ranges = imageCompressionRanges(text, presentation);
  if (ranges.length === 0) return text;
  let cursor = 0;
  const output: string[] = [];
  for (const range of ranges) {
    output.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  output.push(text.slice(cursor));
  return output.join('');
}

export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);
}

export function promptMetadataTextFromContentParts(
  parts: readonly ContentPart[],
): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    const text = promptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return promptMetadataTextFromText(texts.join('\n'));
}

export function promptMetadataTextFromText(text: string): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, MAX_LAST_PROMPT_LENGTH);
}

function promptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text': {
      if (matchSingleMediaPathTag(part.text) !== undefined) return undefined;
      const text = removeMarkedCompressionText(part.text, part.presentation);
      return text.trim().length === 0 ? undefined : text;
    }
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}

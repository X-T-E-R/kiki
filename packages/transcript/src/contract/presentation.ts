import { z } from 'zod';

const selectionSourceSchema = z.object({
  blockId: z.string(), version: z.string(), start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(), text: z.string(),
});

export const textPresentationSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  kind: z.enum(['context', 'image_compression', 'source', 'selection', 'attachment']),
  quote: z.string().optional(),
  comment: z.string().optional(),
  source: selectionSourceSchema.nullable().optional(),
  attachment: z.object({ path: z.string(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative() }).optional(),
}).refine((span) => span.end >= span.start);

/** Display-only generated spans in raw JavaScript code-unit offsets; never origin or trust evidence. */
export const textPresentationSchema = z.object({ spans: z.array(textPresentationSpanSchema) });
export type TextPresentation = z.infer<typeof textPresentationSchema>;
export type TextPresentationSpan = z.infer<typeof textPresentationSpanSchema>;

export function readTextPresentation(value: unknown): TextPresentation | undefined {
  const parsed = textPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Merge validated text-part spans using the same separator as the raw-text consumer. */
export function contentTextPresentation(parts: readonly unknown[], separator = ''): TextPresentation | undefined {
  const spans: TextPresentationSpan[] = [];
  let offset = 0;
  let textCount = 0;
  for (const raw of parts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const part = raw as { type?: string; text?: string; presentation?: unknown };
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    if (textCount++ > 0) offset += separator.length;
    const presentation = readTextPresentation(part.presentation);
    for (const span of presentation?.spans ?? []) {
      if (span.end <= part.text.length) spans.push({ ...span, start: offset + span.start, end: offset + span.end });
    }
    offset += part.text.length;
  }
  return spans.length === 0 ? undefined : { spans };
}

export function shiftTextPresentation(presentation: TextPresentation | undefined, offset: number): TextPresentation | undefined {
  return presentation === undefined ? undefined : { spans: presentation.spans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset })) };
}

/** Project a display window without changing raw text, revisions, or offsets; unknown history stays literal. */
export function projectPresentedText(text: string, presentation?: TextPresentation, offset = 0): string {
  const end = offset + text.length;
  const ranges = (presentation?.spans ?? []).filter((span) => span.end > offset && span.start < end)
    .toSorted((a, b) => a.start - b.start);
  let cursor = 0;
  const output: string[] = [];
  for (const span of ranges) {
    const start = Math.max(0, span.start - offset);
    const stop = Math.min(text.length, span.end - offset);
    if (start > cursor) output.push(text.slice(cursor, start));
    cursor = Math.max(cursor, stop);
  }
  output.push(text.slice(cursor));
  return output.join('');
}

import { projectPresentedText, type TextPresentation } from '@kiki/transcript';
import { findConversationRefs } from './threadRefs';
import { parseSelectionCarryovers } from './timelineAnnotations';

interface PresentedText {
  readonly text: string;
  readonly presentation?: TextPresentation;
}

function contextBlocks(message: PresentedText): string[] {
  return message.presentation?.spans.flatMap((span) => {
    if (span.kind !== 'context') return [];
    const raw = message.text.slice(span.start, span.end);
    return /^\s*<thread_refs>[\s\S]*<\/thread_refs>\s*$/u.test(raw) ? [raw] : [];
  }) ?? [];
}

function entries(context: string): { raw: string; key: string; start: number; end: number }[] {
  return [...context.matchAll(/<(thread_ref|room_ref)\b[^>]*\/>(?:\r?\n)?/gu)].flatMap((match) => {
    const id = /\bid="([^"]+)"/u.exec(match[0])?.[1];
    return id === undefined ? [] : [{ raw: match[0], key: `${match[1] === 'thread_ref' ? 'session' : 'room'}:${id}`, start: match.index, end: match.index + match[0].length }];
  });
}

/** Keep the original hidden payload only for links that survive an edit verbatim. */
export function reconcileEditedThreadRefs(original: PresentedText, edited: PresentedText): PresentedText {
  const contexts = contextBlocks(original);
  if (contexts.length === 0) return edited;
  const oldLinks = findConversationRefs(parseSelectionCarryovers(original.text, original.presentation).body);
  const body = projectPresentedText(edited.text, edited.presentation);
  const links = findConversationRefs(body);
  const unchanged = new Set(links.filter((link) => oldLinks.some((old) => old.kind === link.kind && old.id === link.id && old.raw === link.raw))
    .map((link) => `${link.kind}:${link.id}`));
  const oldEntries = new Map(contexts.flatMap(entries).map((entry) => [entry.key, entry.raw]));
  const freshEntries = new Map(contextBlocks(edited).flatMap(entries).map((entry) => [entry.key, entry.raw]));
  const remaining = new Map<string, string>();
  for (const link of links) {
    const key = `${link.kind}:${link.id}`;
    const raw = unchanged.has(key) ? oldEntries.get(key) ?? freshEntries.get(key) : freshEntries.get(key);
    if (raw !== undefined) remaining.set(key, raw);
  }
  if (remaining.size === 0) return { text: body };

  const additions = [...remaining].filter(([key]) => !oldEntries.has(key)).map(([, raw]) => raw).join('');
  const retained = contexts.map((context, index) => {
    const tags = entries(context);
    let result = '';
    let cursor = 0;
    let kept = 0;
    for (const tag of tags) {
      result += context.slice(cursor, tag.start);
      const raw = remaining.get(tag.key);
      if (raw !== undefined) {
        result += raw;
        remaining.delete(tag.key);
        kept += 1;
      }
      cursor = tag.end;
    }
    if (index === 0 && additions !== '') result += additions;
    result += context.slice(cursor);
    return kept > 0 || (index === 0 && additions !== '') ? result : '';
  }).join('');
  return {
    text: body + retained,
    presentation: { spans: [{ start: body.length, end: body.length + retained.length, kind: 'context' }] },
  };
}

import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';

const SEGMENT_TARGET = 2000;
const LARGE_DOCUMENT = 16_000;
const REFERENCE_DEFINITION = /\]:/;

/** Keep document-scoped syntax on the single-parser path, as in Transcript's
 * settled-prefix cache. Streamdown supplies the boundaries for fences, lists,
 * tables and HTML; concatenating its blocks preserves the source verbatim. */
export function splitStaticDocument(text: string): string[] {
  if (text.length < LARGE_DOCUMENT || REFERENCE_DEFINITION.test(text) || text.includes('$$') || text.includes('\\[') || text.includes('\\(')) return [text];
  const blocks = parseMarkdownIntoBlocks(text);
  const segments: string[] = [];
  let segment = '';
  for (const block of blocks) {
    if (segment !== '' && segment.length + block.length > SEGMENT_TARGET) {
      segments.push(segment);
      segment = '';
    }
    segment += block;
  }
  if (segment !== '') segments.push(segment);
  return segments;
}

/** Append one segment's parse/JSX/DOM commit per task, without reparsing the
 * resident prefix. Schedule only after the preceding commit: queuing every
 * segment at once lets React batch them back into a single long task. Timers
 * also keep loading when a minimized window pauses animation frames. */
export function StaticDocument({ children = '', ...props }: ComponentProps<typeof Streamdown>) {
  const segments = useMemo(() => splitStaticDocument(children), [children]);
  const [progress, setProgress] = useState({ segments, count: 1 });
  const count = progress.segments === segments ? progress.count : 1;
  if (progress.segments !== segments) setProgress({ segments, count });
  useEffect(() => {
    if (count >= segments.length) return;
    const task = window.setTimeout(() => { setProgress({ segments, count: count + 1 }); }, 0);
    return () => { window.clearTimeout(task); };
  }, [segments, count]);
  if (segments.length === 1) return <Streamdown {...props}>{children}</Streamdown>;
  return <div aria-busy={count < segments.length}>{segments.slice(0, count).map((segment, index) => (
    <Streamdown key={index} {...props}>{segment}</Streamdown>
  ))}</div>;
}

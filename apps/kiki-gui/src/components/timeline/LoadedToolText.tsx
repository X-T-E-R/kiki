import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { useI18n } from '../../i18n';
import { toolRecordCopy } from '../toolRecordCopy';
import { CopyButton } from './ContentCopyButton';

export function recordText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function LoadedToolText({
  text,
  prepareCopy,
  copy = true,
  copyLabel,
  className = 'max-h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink',
}: {
  text: string;
  prepareCopy?: (signal: AbortSignal) => Promise<string>;
  copy?: boolean;
  /** Body named in the copy tooltip (e.g. "Input"). */
  copyLabel?: string;
  className?: string;
}) {
  const { locale } = useI18n();
  return (
    <div data-loaded-tool-text>
      {copy ? <div className="flex justify-end text-[12px] text-ink-faint"><CopyButton text={text} prepare={prepareCopy} label={copyLabel === undefined || prepareCopy !== undefined ? copyLabel : `${copyLabel} · ${toolRecordCopy('loadedOnly', locale)}`} /></div> : null}
      <ReadableToolText text={text} className={className} />
    </div>
  );
}

export function ReadableToolText({ text, className }: { text: string; className: string }) {
  return text.length <= 32_768 ? <pre className={className}>{text}</pre> : <VirtualToolText text={text} className={className} />;
}

function VirtualToolText({ text, className }: { text: string; className: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const chunks = useMemo(() => {
    const values: string[] = [];
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 4096);
      const newline = text.lastIndexOf('\n', end);
      if (newline > offset + 2048) end = newline + 1;
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
      values.push(text.slice(offset, end));
      offset = end;
    }
    return values;
  }, [text]);
  const virtualizer = useVirtualizer({ count: chunks.length, getScrollElement: () => scroll.current, estimateSize: () => 180, overscan: 2 });
  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    const reveal = (event: Event) => {
      const { pattern, occurrence } = (event as CustomEvent<{ pattern: RegExp; occurrence: number }>).detail;
      const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags))];
      const match = matches[Math.min(occurrence, matches.length - 1)];
      if (match === undefined) return;
      let offset = 0;
      const index = chunks.findIndex((chunk) => { offset += chunk.length; return offset > match.index; });
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    };
    element.addEventListener('kiki:reveal-tool-match', reveal);
    return () => { element.removeEventListener('kiki:reveal-tool-match', reveal); };
  }, [text, chunks, virtualizer]);
  return (
    <div ref={scroll} className={className} style={{ height: 240 }} data-virtual-tool-text>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => <pre key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="m-0 whitespace-pre-wrap break-words" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>{chunks[item.index]}</pre>)}
      </div>
    </div>
  );
}

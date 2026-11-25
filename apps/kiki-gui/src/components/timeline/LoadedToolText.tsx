import { useEffect, useMemo, useRef } from 'react';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';

import { CopyButton } from './ContentCopyButton';

export interface ToolTextVirtualizeConfig {
  readonly charThreshold: number;
  readonly lineThreshold: number;
  readonly chunkChars: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
  readonly estimatedChunkHeight: number;
  readonly overscan: number;
}

export const DEFAULT_TOOL_TEXT_VIRTUALIZE_CONFIG: ToolTextVirtualizeConfig = {
  charThreshold: 6_144,
  lineThreshold: 100,
  chunkChars: 4_096,
  initialWidth: 640,
  initialHeight: 240,
  estimatedChunkHeight: 180,
  overscan: 2,
};

export function shouldVirtualizeToolText(
  text: string,
  config: ToolTextVirtualizeConfig = DEFAULT_TOOL_TEXT_VIRTUALIZE_CONFIG,
): boolean {
  if (text.length > config.charThreshold) return true;
  let newlines = 0;
  let index = -1;
  while ((index = text.indexOf('\n', index + 1)) !== -1) {
    newlines += 1;
    if (newlines > config.lineThreshold) return true;
  }
  return false;
}

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
  virtualizeConfig,
}: {
  text: string;
  prepareCopy?: (signal: AbortSignal) => Promise<string>;
  copy?: boolean;
  /** Body named in the copy tooltip (e.g. "Input"). */
  copyLabel?: string;
  className?: string;
  virtualizeConfig?: Partial<ToolTextVirtualizeConfig>;
}) {
  return (
    <div data-loaded-tool-text>
      {copy ? <div className="flex justify-end text-[12px] text-ink-faint"><CopyButton text={text} prepare={prepareCopy} label={copyLabel} /></div> : null}
      <ReadableToolText text={text} className={className} virtualizeConfig={virtualizeConfig} />
    </div>
  );
}

export function ReadableToolText({
  text,
  className,
  virtualizeConfig,
}: {
  text: string;
  className: string;
  virtualizeConfig?: Partial<ToolTextVirtualizeConfig>;
}) {
  const config = virtualizeConfig === undefined
    ? DEFAULT_TOOL_TEXT_VIRTUALIZE_CONFIG
    : { ...DEFAULT_TOOL_TEXT_VIRTUALIZE_CONFIG, ...virtualizeConfig };
  return shouldVirtualizeToolText(text, config)
    ? <VirtualToolText text={text} className={className} config={config} />
    : <pre className={className}>{text}</pre>;
}

function VirtualToolText({
  text,
  className,
  config,
}: {
  text: string;
  className: string;
  config: ToolTextVirtualizeConfig;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const chunkChars = Math.max(512, config.chunkChars);
  const chunks = useMemo(() => {
    const values: string[] = [];
    const halfChunk = Math.floor(chunkChars / 2);
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + chunkChars);
      if (end < text.length) {
        const minNewline = offset + halfChunk + 1;
        for (let pos = end; pos >= minNewline; pos -= 1) {
          if (text.charCodeAt(pos) === 10) {
            end = pos + 1;
            break;
          }
        }
      }
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
      values.push(text.slice(offset, end));
      offset = end;
    }
    return values;
  }, [text, chunkChars]);
  const virtualizer = useVirtualizer({
    count: chunks.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => config.estimatedChunkHeight,
    overscan: config.overscan,
    initialRect: { width: config.initialWidth, height: config.initialHeight },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb(rect.height > 0 ? rect : { width: rect.width > 0 ? rect.width : config.initialWidth, height: config.initialHeight });
      }),
    measureElement: (element, entry, instance) => {
      const height = Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height);
      if (height > 0) return height;
      const index = instance.indexFromElement(element);
      return instance.options.estimateSize(index >= 0 ? index : 0);
    },
  });
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
  const scrollClassName = className.includes('overflow-auto') ? className : `overflow-auto ${className}`;
  return (
    <div ref={scroll} className={scrollClassName} style={{ height: config.initialHeight }} data-virtual-tool-text>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => <pre key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="m-0 whitespace-pre-wrap break-words" style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>{chunks[item.index]}</pre>)}
      </div>
    </div>
  );
}

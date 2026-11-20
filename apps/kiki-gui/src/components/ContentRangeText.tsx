import { useEffect, useRef, useState, type ReactNode } from 'react';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { CONTENT_RANGE_CHARS, type SessionController } from '@kiki/session-core/session';
import { projectPresentedText, type ContentRef, type TextPresentation } from '@kiki/transcript';

import { useI18n } from '../i18n';
import { useTranscriptController, useTranscriptTarget } from './transcriptDetail';

export interface ContentRangeVirtualizeConfig {
  readonly estimateSize: number;
  readonly overscan: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
}

export const DEFAULT_CONTENT_RANGE_VIRTUALIZE_CONFIG: ContentRangeVirtualizeConfig = {
  estimateSize: 180,
  overscan: 2,
  initialWidth: 640,
  initialHeight: 240,
};

export function ContentRangeText({
  contentRef,
  callerAgentId,
  label,
  headingPresent = false,
  presentation,
  renderText,
  fallbackPrefixText,
  virtualizeConfig,
}: {
  contentRef: ContentRef;
  callerAgentId?: string;
  label: string;
  headingPresent?: boolean;
  presentation?: TextPresentation;
  renderText?: (text: string) => ReactNode;
  fallbackPrefixText?: string;
  virtualizeConfig?: Partial<ContentRangeVirtualizeConfig>;
}) {
  const controller = useTranscriptController();
  const target = useTranscriptTarget();
  const scroll = useRef<HTMLDivElement>(null);
  const config = virtualizeConfig === undefined
    ? DEFAULT_CONTENT_RANGE_VIRTUALIZE_CONFIG
    : { ...DEFAULT_CONTENT_RANGE_VIRTUALIZE_CONFIG, ...virtualizeConfig };
  const count = Math.ceil(contentRef.total / CONTENT_RANGE_CHARS);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroll.current,
    estimateSize: () => config.estimateSize,
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
  const agentId = callerAgentId ?? target?.agentId;
  const key = JSON.stringify([contentRef.source, contentRef.path, contentRef.revision]);
  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; offset: number }>).detail;
      if (detail.key === key) virtualizer.scrollToIndex(Math.floor(detail.offset / CONTENT_RANGE_CHARS), { align: 'center' });
    };
    element.addEventListener('kiki:reveal-content-match', reveal);
    return () => { element.removeEventListener('kiki:reveal-content-match', reveal); };
  }, [key, virtualizer]);
  if (controller === undefined || agentId === undefined) return null;
  return <div data-content-range-text data-content-range-key={key}>
    {headingPresent ? null : <p className="mb-1 text-[12px] text-ink-faint">{label}</p>}
    <div ref={scroll} className="h-60 overflow-auto rounded-md bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed text-ink select-text" aria-label={label}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => <div key={`${contentRef.revision}/${item.key}`} data-index={item.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}>
          <RangeBlock
            controller={controller}
            agentId={agentId}
            contentRef={contentRef}
            offset={item.index * CONTENT_RANGE_CHARS}
            presentation={presentation}
            renderText={renderText}
            fallbackPrefixText={item.index === 0 ? fallbackPrefixText : undefined}
          />
        </div>)}
      </div>
    </div>
  </div>;
}

function RangeBlock({ controller, agentId, contentRef, offset, presentation, renderText, fallbackPrefixText }: {
  controller: SessionController;
  agentId: string;
  contentRef: ContentRef;
  offset: number;
  presentation?: TextPresentation;
  renderText?: (text: string) => ReactNode;
  fallbackPrefixText?: string;
}) {
  const { t } = useI18n();
  const key = JSON.stringify([contentRef.source, contentRef.path, contentRef.revision]);
  const rangeKey = `${key}@${offset}`;
  const peeked = controller.peekContentRange?.(agentId, contentRef, offset);
  const previewFallback = offset === 0
    ? (fallbackPrefixText !== undefined && fallbackPrefixText !== ''
      ? fallbackPrefixText
      : controller.peekContentPrefix?.(agentId, contentRef))
    : undefined;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly text: string } | undefined>(
    () => (peeked !== undefined ? { key: rangeKey, text: peeked } : undefined),
  );
  const [failedKey, setFailedKey] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const hasPeeked = peeked !== undefined;
  const resolvedText = peeked ?? (loaded?.key === rangeKey ? loaded.text : undefined);
  useEffect(() => {
    if (peeked !== undefined && attempt === 0) {
      setLoaded((current) => (current?.key === rangeKey && current.text === peeked ? current : { key: rangeKey, text: peeked }));
      setFailedKey(undefined);
      return;
    }
    const abort = new AbortController();
    setFailedKey(undefined);
    void controller.readContentRange(agentId, contentRef, offset, abort.signal).then((value) => {
      if (!abort.signal.aborted) {
        setLoaded({ key: rangeKey, text: value });
        setFailedKey(undefined);
      }
    }, () => { if (!abort.signal.aborted) setFailedKey(rangeKey); });
    return () => { abort.abort(); };
  }, [controller, agentId, key, rangeKey, offset, attempt, hasPeeked]);
  const failed = failedKey === rangeKey;
  const text = resolvedText ?? (!failed ? previewFallback : undefined);
  if (text === undefined) return <div className="min-h-20 text-ink-faint" role="status">{t(failed ? 'transcript.content.failed' : 'transcript.content.loading')}{failed ? <button type="button" className="ml-2 underline" onClick={() => { setAttempt((value) => value + 1); }}>{t('common.retry')}</button> : null}</div>;
  const displayed = projectPresentedText(text, presentation, offset);
  return renderText === undefined ? <pre className="m-0 whitespace-pre-wrap break-words">{displayed}</pre> : <div className="whitespace-pre-wrap break-words">{renderText(displayed)}</div>;
}

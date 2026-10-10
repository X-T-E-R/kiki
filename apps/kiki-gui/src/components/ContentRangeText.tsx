import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CONTENT_RANGE_CHARS, type SessionController } from '@kiki/session-core/session';
import type { ContentRef } from '@kiki/transcript';

import { useI18n } from '../i18n';
import { useTranscriptController, useTranscriptTarget } from './transcriptDetail';

export function ContentRangeText({ contentRef, callerAgentId, label, headingPresent = false }: { contentRef: ContentRef; callerAgentId?: string; label: string; headingPresent?: boolean }) {
  const controller = useTranscriptController();
  const target = useTranscriptTarget();
  const scroll = useRef<HTMLDivElement>(null);
  const count = Math.ceil(contentRef.total / CONTENT_RANGE_CHARS);
  const virtualizer = useVirtualizer({ count, getScrollElement: () => scroll.current, estimateSize: () => 180, overscan: 2 });
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
          <RangeBlock controller={controller} agentId={agentId} contentRef={contentRef} offset={item.index * CONTENT_RANGE_CHARS} />
        </div>)}
      </div>
    </div>
  </div>;
}

function RangeBlock({ controller, agentId, contentRef, offset }: { controller: SessionController; agentId: string; contentRef: ContentRef; offset: number }) {
  const { t } = useI18n();
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([contentRef.source, contentRef.path, contentRef.revision]);
  useEffect(() => {
    const abort = new AbortController();
    setText(undefined); setFailed(false);
    void controller.readContentRange(agentId, contentRef, offset, abort.signal).then((value) => {
      if (!abort.signal.aborted) setText(value);
    }, () => { if (!abort.signal.aborted) setFailed(true); });
    return () => { abort.abort(); };
  }, [controller, agentId, key, offset, attempt]);
  return text !== undefined ? <pre className="m-0 whitespace-pre-wrap break-words">{text}</pre> : <div className="min-h-20 text-ink-faint" role="status">{t(failed ? 'transcript.content.failed' : 'transcript.content.loading')}{failed ? <button type="button" className="ml-2 underline" onClick={() => { setAttempt((value) => value + 1); }}>{t('common.retry')}</button> : null}</div>;
}

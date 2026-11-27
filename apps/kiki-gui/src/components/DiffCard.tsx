/**
 * DiffCard — renders edit-tool hunks as a unified diff: single new-file
 * line-number gutter, muted `… N unchanged lines` separators between hunks,
 * insert/delete row tints confined to the content area (gutter stays clean),
 * on one flat panel surface with no frame (it sits inside a tool step).
 * Rendering recipe follows grok-build's edit.rs (Apache-2.0, see lib/diff.ts);
 * tints use kiki's success/danger palette at low alpha on paper.
 */

import { useMemo, useRef, useState } from 'react';
import { diffWordsWithSpace } from 'diff';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { hunkGapLines, type DiffHunk, type DiffLine } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { usePhoneMode } from '../lib/layoutHooks';

export interface DiffCardVirtualizeConfig {
  readonly lineThreshold: number;
  readonly estimatedRowHeight: number;
  readonly overscan: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
  readonly maxViewportHeight: number;
}

export const DEFAULT_DIFF_CARD_VIRTUALIZE_CONFIG: DiffCardVirtualizeConfig = {
  lineThreshold: 160,
  estimatedRowHeight: 20,
  overscan: 16,
  initialWidth: 640,
  initialHeight: 360,
  maxViewportHeight: 448,
};

const MOBILE_INLINE_DIFF_CAP = 80;
const MAX_INTRALINE_RUN = 8;
const MAX_INTRALINE_CHARS = 600;

interface IntralineSpan {
  readonly text: string;
  readonly changed: boolean;
}

function buildHunkIntralineMap(hunk: DiffHunk): ReadonlyMap<number, readonly IntralineSpan[]> {
  const map = new Map<number, readonly IntralineSpan[]>();
  let index = 0;
  while (index < hunk.length) {
    if (hunk[index]!.tag !== 'delete') {
      index += 1;
      continue;
    }
    const delStart = index;
    while (index < hunk.length && hunk[index]!.tag === 'delete') index += 1;
    const delEnd = index;
    const insStart = index;
    while (index < hunk.length && hunk[index]!.tag === 'insert') index += 1;
    const insEnd = index;
    const delCount = delEnd - delStart;
    const insCount = insEnd - insStart;
    if (delCount > 0 && delCount === insCount && delCount <= MAX_INTRALINE_RUN) {
      for (let offset = 0; offset < delCount; offset += 1) {
        const delLine = hunk[delStart + offset]!;
        const insLine = hunk[insStart + offset]!;
        if (
          delLine.text.length === 0 ||
          insLine.text.length === 0 ||
          delLine.text.length > MAX_INTRALINE_CHARS ||
          insLine.text.length > MAX_INTRALINE_CHARS
        ) {
          continue;
        }
        const changes = diffWordsWithSpace(delLine.text, insLine.text);
        if (!changes.some((part) => !part.added && !part.removed)) continue;
        const delSpans: IntralineSpan[] = [];
        const insSpans: IntralineSpan[] = [];
        for (const part of changes) {
          if (part.added) {
            insSpans.push({ text: part.value, changed: true });
          } else if (part.removed) {
            delSpans.push({ text: part.value, changed: true });
          } else {
            delSpans.push({ text: part.value, changed: false });
            insSpans.push({ text: part.value, changed: false });
          }
        }
        map.set(delStart + offset, delSpans);
        map.set(insStart + offset, insSpans);
      }
    }
  }
  return map;
}

type VirtualDiffItem =
  | { readonly kind: 'gap'; readonly key: string; readonly gap: number | undefined }
  | {
      readonly kind: 'line';
      readonly key: string;
      readonly line: DiffLine;
      readonly spans?: readonly IntralineSpan[];
    };

function DiffRow({
  line,
  gutterWidth,
  phoneMode,
  spans,
}: {
  line: DiffLine;
  gutterWidth: number | undefined;
  phoneMode: boolean;
  spans?: readonly IntralineSpan[];
}) {
  const gutter =
    gutterWidth === undefined ? undefined : line.tag === 'delete' ? String(line.lo) : line.ln > 0 ? String(line.ln) : '';
  const tint =
    line.tag === 'insert'
      ? 'bg-success/[0.09]'
      : line.tag === 'delete'
        ? 'bg-danger/[0.08]'
        : undefined;
  const changedSpanClass =
    line.tag === 'insert'
      ? 'rounded-[3px] bg-success/24 text-ink'
      : 'rounded-[3px] bg-danger/22 text-ink';
  const marker =
    line.tag === 'insert' ? '+' : line.tag === 'delete' ? '−' : ' ';
  const markerTone =
    line.tag === 'insert'
      ? 'text-success'
      : line.tag === 'delete'
        ? 'text-danger'
        : 'text-ink-faint';
  return (
    <div data-diff-tag={line.tag} className={`flex ${phoneMode ? 'min-w-max' : ''}`}>
      {gutterWidth === undefined ? null : (
        <span
          className={`shrink-0 pr-1.5 text-right text-ink-faint tabular-nums select-none ${phoneMode ? 'w-9' : 'pr-2'}`}
          style={phoneMode ? undefined : { width: `${gutterWidth + 2}ch` }}
        >
          {gutter}
        </span>
      )}
      <span className={`w-3 shrink-0 text-center select-none ${markerTone}`}>{marker}</span>
      <span
        className={`flex-1 px-1.5 ${
          phoneMode ? 'whitespace-pre pr-3' : 'min-w-0 whitespace-pre-wrap break-all'
        } ${tint ?? ''}`}
      >
        {spans !== undefined && spans.length > 0
          ? spans.map((span, idx) => (
              span.changed
                ? <mark key={idx} className={`${changedSpanClass} bg-transparent font-inherit`}>{span.text}</mark>
                : <span key={idx}>{span.text}</span>
            ))
          : (line.text === '' ? ' ' : line.text)}
      </span>
    </div>
  );
}

function VirtualDiffCard({
  hunks,
  numbered,
  gutterWidth,
  surface,
  config,
  phoneMode,
}: {
  hunks: readonly DiffHunk[];
  numbered: boolean;
  gutterWidth: number | undefined;
  surface: string;
  config: DiffCardVirtualizeConfig;
  phoneMode: boolean;
}) {
  const { tp, t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo<VirtualDiffItem[]>(() => {
    const rows: VirtualDiffItem[] = [];
    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex]!;
      const intraline = buildHunkIntralineMap(hunk);
      if (hunkIndex > 0) {
        const previous = hunks[hunkIndex - 1]!;
        const gap = numbered ? hunkGapLines(previous, hunk) : undefined;
        rows.push({ kind: 'gap', key: `gap:${hunkIndex}`, gap });
      }
      for (let lineIndex = 0; lineIndex < hunk.length; lineIndex += 1) {
        rows.push({
          kind: 'line',
          key: `line:${hunkIndex}:${lineIndex}`,
          line: hunk[lineIndex]!,
          spans: intraline.get(lineIndex),
        });
      }
    }
    return rows;
  }, [hunks, numbered]);
  const viewportHeight = Math.min(config.maxViewportHeight, Math.max(config.initialHeight, config.estimatedRowHeight * 8));
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => config.estimatedRowHeight,
    overscan: config.overscan,
    initialRect: { width: config.initialWidth, height: viewportHeight },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb(rect.height > 0 ? rect : { width: rect.width > 0 ? rect.width : config.initialWidth, height: viewportHeight });
      }),
    measureElement: (element, entry, instance) => {
      const height = Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height);
      if (height > 0) return height;
      const index = instance.indexFromElement(element);
      return instance.options.estimateSize(index >= 0 ? index : 0);
    },
  });
  return (
    <div
      ref={scrollRef}
      data-virtual-diff-card
      data-base-ui-swipe-ignore="x"
      style={{ height: viewportHeight }}
      className={`overflow-auto rounded-md py-1 font-mono text-[length:calc(var(--kiki-code-font-size,12.5px)-0.5px)] leading-[1.6] ${surface}`}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index]!;
          return (
            <div
              key={item.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, minWidth: '100%', transform: `translateY(${virtualItem.start}px)` }}
            >
              {item.kind === 'gap' ? (
                <div className="my-1 px-3 py-0.5 font-sans text-[12px] text-ink-faint italic select-none">
                  {item.gap !== undefined ? tp('diff.unchanged', item.gap) : t('diff.unchangedSome')}
                </div>
              ) : (
                <DiffRow line={item.line} gutterWidth={gutterWidth} phoneMode={phoneMode} spans={item.spans} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DiffCard({
  hunks,
  numbered = true,
  surface = 'bg-panel',
  virtualizeConfig,
}: {
  hunks: readonly DiffHunk[];
  /**
   * False when the hunks were built from a snippet whose place in the file is
   * unknown (an edit's old/new text): their line numbers would count from the
   * snippet, and the gaps between hunks would count snippet lines, so neither
   * is shown rather than passed off as file positions.
   */
  numbered?: boolean;
  /** The surface, for a card that already sits on the panel colour. */
  surface?: string;
  virtualizeConfig?: Partial<DiffCardVirtualizeConfig>;
}) {
  const { tp, t, locale } = useI18n();
  const phoneMode = usePhoneMode();
  const [expanded, setExpanded] = useState(false);
  const config = virtualizeConfig === undefined
    ? DEFAULT_DIFF_CARD_VIRTUALIZE_CONFIG
    : { ...DEFAULT_DIFF_CARD_VIRTUALIZE_CONFIG, ...virtualizeConfig };
  // Gutter width from the largest line number shown (grok-build's layout).
  let maxLine = 1;
  let totalLines = 0;
  for (const hunk of hunks) {
    totalLines += hunk.length;
    for (const line of hunk) {
      maxLine = Math.max(maxLine, line.lo, line.ln);
    }
  }
  const gutterWidth = numbered ? String(maxLine).length : undefined;
  const hunkHighlights = useMemo(
    () => hunks.map((hunk) => buildHunkIntralineMap(hunk)),
    [hunks],
  );

  if (totalLines > config.lineThreshold) {
    return (
      <VirtualDiffCard
        hunks={hunks}
        numbered={numbered}
        gutterWidth={gutterWidth}
        surface={surface}
        config={config}
        phoneMode={phoneMode}
      />
    );
  }

  const cappedOnPhone = phoneMode && !expanded && totalLines > MOBILE_INLINE_DIFF_CAP;
  let remainingBudget = cappedOnPhone ? MOBILE_INLINE_DIFF_CAP : Number.POSITIVE_INFINITY;

  return (
    <div className={`rounded-md ${surface}`}>
      <div
        data-diff-card=""
        data-diff-mobile={phoneMode ? '' : undefined}
        data-base-ui-swipe-ignore="x"
        className="overflow-x-auto py-1 font-mono text-[length:calc(var(--kiki-code-font-size,12.5px)-0.5px)] leading-[1.6]"
      >
        {hunks.map((hunk, hunkIndex) => {
          if (remainingBudget <= 0) return null;
          const visibleLines = hunk.slice(0, remainingBudget);
          remainingBudget -= visibleLines.length;
          const previous = hunkIndex > 0 ? hunks[hunkIndex - 1] : undefined;
          const gap = previous !== undefined && numbered ? hunkGapLines(previous, hunk) : undefined;
          const intraline = hunkHighlights[hunkIndex];
          return (
            <div key={hunkIndex}>
              {hunkIndex > 0 ? (
                <div className="my-1 px-3 py-0.5 font-sans text-[12px] text-ink-faint italic select-none">
                  {gap !== undefined ? tp('diff.unchanged', gap) : t('diff.unchangedSome')}
                </div>
              ) : null}
              <div>
                {visibleLines.map((line, lineIndex) => (
                  <DiffRow
                    key={lineIndex}
                    line={line}
                    gutterWidth={gutterWidth}
                    phoneMode={phoneMode}
                    spans={intraline?.get(lineIndex)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {cappedOnPhone ? (
        <button
          type="button"
          data-diff-expand=""
          onClick={() => { setExpanded(true); }}
          className="flex min-h-11 w-full items-center justify-center border-t border-hairline/70 px-3 text-[12px] font-sans text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
        >
          {locale === 'zh' ? `展开全部 ${totalLines} 行` : `Show all ${totalLines} lines`}
        </button>
      ) : null}
    </div>
  );
}

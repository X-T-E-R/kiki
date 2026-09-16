import { memo } from 'react';
import { useI18n } from '../i18n';
import { useCollapsibleOverflow } from '../lib/collapsibleOverflow';

export interface ClampTextProps {
  readonly text: string;
  readonly className?: string;
  readonly lines?: 2 | 3 | 4;
}

/**
 * Clamped text with on-demand show more / show less toggle when content overflows.
 * Uses useCollapsibleOverflow to measure scrollHeight vs clientHeight.
 */
export const ClampText = memo(function ClampText({
  text,
  className = '',
  lines = 3,
}: ClampTextProps) {
  const { t } = useI18n();
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLParagraphElement>(text);
  const clampClass = lines === 2 ? 'line-clamp-2' : lines === 4 ? 'line-clamp-4' : 'line-clamp-3';

  return (
    <div>
      <p
        ref={contentRef}
        id={contentId}
        className={`${className} ${expanded ? '' : clampClass}`}
      >
        {text}
      </p>
      {isOverflowing || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] text-ink-faint transition-colors hover:text-accent cursor-pointer"
        >
          {expanded ? t('transcript.showLess') : t('transcript.showMore')}
          <span aria-hidden className="text-[9px]">{expanded ? '▴' : '▾'}</span>
        </button>
      ) : null}
    </div>
  );
});

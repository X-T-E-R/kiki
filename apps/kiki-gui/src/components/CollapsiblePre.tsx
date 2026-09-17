import { memo, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { useCollapsibleOverflow } from '../lib/collapsibleOverflow';

export interface CollapsiblePreProps extends React.HTMLAttributes<HTMLPreElement> {
  readonly children: ReactNode;
  readonly className?: string;
  readonly maxHeightClass?: string;
  readonly contentKey?: unknown;
}

/**
 * Preformatted code/output box with max-height constraint and on-demand
 * "Show more / Show less" toggle when content overflows the container.
 */
export const CollapsiblePre = memo(function CollapsiblePre({
  children,
  className = '',
  maxHeightClass = 'max-h-72',
  contentKey,
  ...rest
}: CollapsiblePreProps) {
  const { t } = useI18n();
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLPreElement>(contentKey ?? children);

  return (
    <div className="relative">
      <pre
        ref={contentRef}
        id={contentId}
        {...rest}
        className={`${className} ${expanded ? 'max-h-none' : maxHeightClass} overflow-auto`}
      >
        {children}
      </pre>
      {isOverflowing || expanded ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint transition-colors hover:text-accent cursor-pointer"
          >
            {expanded ? t('transcript.showLess') : t('transcript.showMore')}
            <span aria-hidden className="text-[9px]">{expanded ? '▴' : '▾'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
});

import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';

type TableProps = ComponentProps<'table'> & { node?: unknown };

interface ScrollOverflowState {
  readonly hasOverflow: boolean;
  readonly canScrollLeft: boolean;
  readonly canScrollRight: boolean;
}

const NO_OVERFLOW: ScrollOverflowState = {
  hasOverflow: false,
  canScrollLeft: false,
  canScrollRight: false,
};

const EDGE_TOLERANCE_PX = 2;

export function KikiMarkdownTable({ children, className, node: _node, ...props }: TableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [overflow, setOverflow] = useState<ScrollOverflowState>(NO_OVERFLOW);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const { scrollLeft, scrollWidth, clientWidth } = element;
    const hasOverflow = scrollWidth > clientWidth + EDGE_TOLERANCE_PX;
    const canScrollLeft = hasOverflow && scrollLeft > EDGE_TOLERANCE_PX;
    const canScrollRight = hasOverflow && scrollLeft + clientWidth < scrollWidth - EDGE_TOLERANCE_PX;
    setOverflow((previous) =>
      previous.hasOverflow === hasOverflow &&
      previous.canScrollLeft === canScrollLeft &&
      previous.canScrollRight === canScrollRight
        ? previous
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const scrollElement = scrollRef.current;
    if (scrollElement === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    if (tableRef.current !== null) observer.observe(tableRef.current);
    return () => { observer.disconnect(); };
  }, [measure, children]);

  return (
    <div
      data-streamdown="table-wrapper"
      data-overflow-x={overflow.hasOverflow || undefined}
      data-can-scroll-left={overflow.canScrollLeft || undefined}
      data-can-scroll-right={overflow.canScrollRight || undefined}
      className="kiki-md-table-wrap"
    >
      <div
        ref={scrollRef}
        tabIndex={overflow.hasOverflow ? 0 : undefined}
        onScroll={measure}
        className="kiki-md-table-scroll"
      >
        <table
          {...props}
          ref={tableRef}
          data-streamdown="table"
          className={['w-full', className].filter(Boolean).join(' ')}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

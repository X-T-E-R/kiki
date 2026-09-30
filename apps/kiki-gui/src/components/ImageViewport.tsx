/**
 * ImageViewport — the preview tab's full-resolution image surface. It always
 * renders the original bytes. "Fit" scales the image down to the panel width
 * (never up) and leaves resampling to the browser's high-quality path; "100%"
 * maps one image pixel to one device pixel. A click toggles between the two,
 * anchored on the clicked point, and at 100% a mouse drag pans the scroller
 * (touch keeps native scrolling).
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useI18n } from '../i18n';

export type ImageZoom = 'fit' | 'actual';

/** Live devicePixelRatio: re-reads when the window moves to another display or zooms. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const update = () => { setDpr(window.devicePixelRatio || 1); };
    media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); };
  }, [dpr]);
  return dpr;
}

const PAN_THRESHOLD = 4;

/**
 * Mouse drag-to-pan for a scroll container. A press only becomes a pan after
 * it travels a few pixels, so a plain click still reaches the element;
 * `consumePan()` reports (once) whether the click that follows ended a pan.
 */
export function useDragPan(enabled: boolean) {
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const panned = useRef(false);
  const [dragging, setDragging] = useState(false);

  const end = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (state === null || state.id !== event.pointerId) return;
    panned.current = state.moved;
    drag.current = null;
    setDragging(false);
  };

  return {
    dragging,
    consumePan: () => {
      const value = panned.current;
      panned.current = false;
      return value;
    },
    handlers: {
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        panned.current = false;
        if (!enabled || event.button !== 0 || event.pointerType === 'touch') return;
        const element = event.currentTarget;
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: element.scrollLeft,
          top: element.scrollTop,
          moved: false,
        };
      },
      onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
        const state = drag.current;
        if (state === null || state.id !== event.pointerId) return;
        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;
        if (!state.moved) {
          if (Math.hypot(dx, dy) < PAN_THRESHOLD) return;
          state.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }
        event.currentTarget.scrollLeft = state.left - dx;
        event.currentTarget.scrollTop = state.top - dy;
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}

const SEGMENT_CLASS = 'rounded-[5px] px-2 py-0.5 transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink';

/** Where the zoom toggle should land: this image fraction under this viewport point. */
interface ZoomAnchor {
  readonly fx: number;
  readonly fy: number;
  readonly px: number;
  readonly py: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function ImageViewport({
  src,
  alt,
  caption,
  meta,
  actions,
  onError,
}: {
  readonly src: string;
  readonly alt: string;
  /** Leading header text (the file path). */
  readonly caption: ReactNode;
  /** Trailing detail after the dimensions (e.g. the byte size). */
  readonly meta?: string;
  readonly actions?: ReactNode;
  readonly onError?: () => void;
}) {
  const { t } = useI18n();
  const dpr = useDevicePixelRatio();
  const [zoom, setZoom] = useState<ImageZoom>('fit');
  const [natural, setNatural] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  const pan = useDragPan(zoom === 'actual');

  useEffect(() => {
    setNatural(null);
    setZoom('fit');
  }, [src]);

  // After a zoom switch, scroll so the anchored image point stays put.
  useLayoutEffect(() => {
    const target = anchor.current;
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    anchor.current = null;
    if (target === null || scroller === null || image === null) return;
    scroller.scrollLeft = image.offsetLeft + target.fx * image.offsetWidth - target.px;
    scroller.scrollTop = image.offsetTop + target.fy * image.offsetHeight - target.py;
  }, [zoom]);

  const switchZoom = (next: ImageZoom, point?: { readonly x: number; readonly y: number }) => {
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    if (next === zoom) return;
    if (scroller !== null && image !== null) {
      const box = scroller.getBoundingClientRect();
      const rect = image.getBoundingClientRect();
      const x = point?.x ?? box.left + box.width / 2;
      const y = point?.y ?? box.top + box.height / 2;
      anchor.current = {
        fx: rect.width > 0 ? clamp01((x - rect.left) / rect.width) : 0.5,
        fy: rect.height > 0 ? clamp01((y - rect.top) / rect.height) : 0.5,
        px: x - box.left,
        py: y - box.top,
      };
    }
    setZoom(next);
  };

  const actualWidth = natural === null ? undefined : natural.width / dpr;
  const dimensions = natural === null ? undefined : `${natural.width} × ${natural.height}`;
  const detail = [dimensions, meta].filter((part) => part !== undefined).join(' · ');

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{caption}</span>
        {detail !== '' ? (
          <span className="shrink-0 font-mono text-[11px] text-ink-faint" data-image-meta>{detail}</span>
        ) : null}
        <span role="group" aria-label={t('preview.zoomGroup')} className="flex shrink-0 items-center gap-0.5 rounded-md bg-ink/[0.05] p-0.5 text-[11px]">
          {(['fit', 'actual'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={zoom === option}
              data-image-zoom={option}
              onClick={() => { switchZoom(option); }}
              className={`${SEGMENT_CLASS} ${
                zoom === option ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {option === 'fit' ? t('preview.zoomFit') : t('preview.zoomActual')}
            </button>
          ))}
        </span>
        {actions}
      </div>
      <div
        ref={scrollerRef}
        tabIndex={0}
        data-image-viewport={zoom}
        aria-label={alt}
        onClick={(event) => {
          if (pan.consumePan()) return;
          switchZoom(zoom === 'fit' ? 'actual' : 'fit', { x: event.clientX, y: event.clientY });
        }}
        {...pan.handlers}
        className={`relative min-h-0 flex-1 select-none overflow-auto p-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
          zoom === 'fit' ? 'cursor-zoom-in' : pan.dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={(event) => {
            const image = event.currentTarget;
            setNatural({ width: image.naturalWidth, height: image.naturalHeight });
          }}
          onError={onError}
          style={zoom === 'actual' && actualWidth !== undefined ? { width: actualWidth, maxWidth: 'none' } : undefined}
          className={`mx-auto block h-auto rounded-lg border border-hairline ${zoom === 'fit' ? 'max-w-full' : ''}`}
        />
      </div>
    </>
  );
}

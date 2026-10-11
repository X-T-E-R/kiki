/**
 * The cluster's one hover/focus preview, as a floating layer anchored to the
 * chip it describes. It is portaled to `<body>` and positioned `fixed`, so
 * reading a preview never reflows the rail: the chips below keep the exact
 * geometry they had before the pointer arrived. The chip's `aria-describedby`
 * still points at it, and Escape closes it, so the layer adds no reading
 * order of its own.
 *
 * Placement follows the chip's own box: below it when there is room, above
 * when the viewport is tighter, and always clamped inside the window. The
 * width is capped at the cluster's measured width so the card never spans
 * more than the row it belongs to.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { floatingSurfaceZIndex } from '../../lib/uiBusy';

import { useI18n } from '../../i18n';
import { clampOverlayPosition } from '../../lib/overlayPosition';
import { toolGroupCountLine } from './toolGroupText';
import { toolGroupPreview, type ToolGroup } from './toolGroups';

/** The viewer's padding around the card, matching `clampOverlayPosition`. */
const MARGIN = 8;
/** Stacks above the chip once the space below drops under this. */
const MIN_BELOW = 96;
/** Never wider than this on a wide rail, however wide the cluster is. */
const MAX_WIDTH = 360;

export interface GroupPreviewAnchor {
  /** The chip's box in viewport coordinates, measured when the preview opened. */
  readonly rect: DOMRect;
  /** The cluster's width, so the card belongs to this row and no wider. */
  readonly clusterWidth: number;
}

export function GroupPreviewCard({
  id,
  group,
  title,
  anchor,
}: {
  readonly id: string;
  readonly group: ToolGroup;
  readonly title: string;
  readonly anchor: GroupPreviewAnchor;
}) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const { counts } = group;
  const preview = toolGroupPreview(group);
  const width = Math.min(MAX_WIDTH, Math.max(200, anchor.clusterWidth));

  // The card is placed from its measured size, so it waits one frame before
  // it knows which side of the chip it can afford to sit on.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null) return undefined;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      setSize((current) =>
        current?.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height });
    });
    observer.observe(card);
    return () => { observer.disconnect(); };
  }, []);

  // First paint before the measurement: the natural width, so the reader never
  // sees a one-frame flash of a collapsed box.
  const place = (): { left: number; top: number } => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const height = size?.height ?? 0;
    const below = viewport.height - anchor.rect.bottom;
    const top = below >= Math.max(MIN_BELOW, height)
      ? anchor.rect.bottom + 6
      : Math.max(MARGIN, anchor.rect.top - height - 6);
    return clampOverlayPosition(anchor.rect.left, top, { width, height }, viewport, MARGIN);
  };

  const names = (list: readonly string[], label: string, more: number) => (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="truncate">{list.join(' · ')}{more > 0 ? '…' : ''}</span>
    </span>
  );

  const lines = [
    <span key="head" className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate text-ink-soft">{title}</span>
      <span className="shrink-0 tabular-nums text-ink-faint">{toolGroupCountLine(t, counts)}</span>
      {counts.approvalRequired > 0 ? (
        <span className="shrink-0 text-amber-ink">{t('inspector.cap.groupPending', { count: counts.approvalRequired })}</span>
      ) : null}
    </span>,
  ];
  if (preview.onNames.length > 0) {
    lines.push(names(preview.onNames, t('inspector.cap.stateOn'), counts.on - preview.onNames.length));
  }
  // The last line reports the states that need a look before the rest of the
  // list: unconnected first, then unconfirmed, then off.
  if (preview.disconnectedNames.length > 0) {
    lines.push(names(preview.disconnectedNames, t('inspector.cap.stateDisconnected'), counts.disconnected - preview.disconnectedNames.length));
  } else if (counts.unknown > 0) {
    lines.push(<span key="unknown" className="text-ink-faint">{t('inspector.cap.groupUnknownNote', { count: counts.unknown })}</span>);
  } else if (preview.offNames.length > 0) {
    lines.push(names(preview.offNames, t('inspector.cap.stateOff'), counts.disabled - preview.offNames.length));
  }

  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role="tooltip"
      data-capability-group-preview={group.key}
      style={{ ...place(), width, zIndex: floatingSurfaceZIndex(null) }}
      // The card is information, not a control: it is wider than the chip and
      // lands over its neighbours, so it must never take a click that was
      // aimed at the cluster underneath. Entering it still cancels the
      // close timer so a reader who moves toward it keeps it open.
      className="anim-enter pointer-events-none fixed space-y-0.5 rounded-lg border border-hairline bg-panel px-2.5 py-2 text-[11.5px] leading-4 text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
    >
      {lines.map((line, index) => (
        <p key={index} className="flex min-w-0 items-baseline gap-1.5">
          {line}
          {index === lines.length - 1 ? (
            <span className="ml-auto shrink-0 text-ink-faint">{t('inspector.cap.previewHint')}</span>
          ) : null}
        </p>
      ))}
    </div>,
    document.body,
  );
}

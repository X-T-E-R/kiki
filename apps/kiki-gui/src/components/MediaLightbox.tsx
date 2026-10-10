/**
 * MediaLightbox — fullscreen image viewer over the Dialog primitive: dark
 * backdrop, click/Esc to close, fit↔actual-size zoom toggle, and image saving
 * from the context menu. The image itself never closes the overlay on click (it zooms);
 * closing happens from the backdrop, the × button, or Escape. Actual size is
 * one image pixel per device pixel, and a mouse drag pans it.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import { Dialog } from './Dialog';
import { MiniContextMenu } from './MiniContextMenu';
import { Icon } from './icons';
import { useDevicePixelRatio, useDragPan } from './ImageViewport';

export function MediaLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [actualSize, setActualSize] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState<number | undefined>();
  const dpr = useDevicePixelRatio();
  const pan = useDragPan(actualSize);
  const label = name ?? t('media.viewImage');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (menu !== null) document.querySelector<HTMLButtonElement>('[data-lightbox-image-menu] [role="menuitem"]')?.focus();
  }, [menu]);

  const download = () => {
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = name ?? 'image';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  const controlClass =
    'rounded-full border border-shell-hairline bg-shell-hover px-3 py-1 text-[11.5px] font-medium text-shell-ink transition-colors hover:bg-shell-hover';

  return (
    <Dialog
      onClose={() => { if (menu !== null) setMenu(null); else onClose(); }}
      ariaLabel={label}
      overlayId="media-lightbox"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/85 p-4"
      panelClassName="anim-enter flex max-h-full max-w-full flex-col items-center gap-3 outline-none"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-autofocus
          onClick={() => { setActualSize((value) => !value); }}
          className={controlClass}
        >
          {actualSize ? t('media.zoomFit') : t('media.zoomActual')}
        </button>

        <button type="button" onClick={onClose} aria-label={t('common.close')} className={controlClass}>
          <Icon name="close" />
        </button>
      </div>
      <div
        {...pan.handlers}
        className={
          actualSize
            ? `max-h-[86vh] max-w-[94vw] select-none overflow-auto ${pan.dragging ? 'cursor-grabbing' : 'cursor-grab'}`
            : 'flex items-center justify-center'
        }
      >
        <img
          src={src}
          alt={label}
          tabIndex={0}
          onContextMenu={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.top });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.top });
          }}
          draggable={false}
          onLoad={(event) => { setNaturalWidth(event.currentTarget.naturalWidth); }}
          onClick={() => {
            if (pan.consumePan()) return;
            setActualSize((value) => !value);
          }}
          style={actualSize && naturalWidth !== undefined ? { width: naturalWidth / dpr } : undefined}
          className={
            actualSize
              ? 'max-w-none'
              : 'max-h-[80vh] max-w-[92vw] cursor-zoom-in rounded-lg object-contain'
          }
        />
      </div>
      {menu === null ? null : <MiniContextMenu x={menu.x} y={menu.y} entries={[{ key: 'save-image', label: t('media.download'), run: download }]} onClose={() => { setMenu(null); }} ariaLabel={label} overlayId="lightbox-image-menu" dataAttribute="data-lightbox-image-menu" modalOwnerId="media-lightbox" />}
    </Dialog>
  );
}

/**
 * MediaLightbox — fullscreen image viewer over the Dialog primitive: dark
 * backdrop, click/Esc to close, fit↔actual-size zoom toggle, and a download
 * button. The image itself never closes the overlay on click (it zooms);
 * closing happens from the backdrop, the × button, or Escape. Actual size is
 * one image pixel per device pixel, and a mouse drag pans it.
 */

import { useEffect, useState } from 'react';

import { useI18n } from '../i18n';
import { Dialog } from './Dialog';
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
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setFailed(false); setNaturalWidth(undefined); setActualSize(false); }, [src]);
  const dpr = useDevicePixelRatio();
  const pan = useDragPan(actualSize);
  const label = name ?? t('media.viewImage');

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
      onClose={onClose}
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
        <button type="button" onClick={download} className={controlClass}>
          {t('media.download')}
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
        {failed ? <div role="alert" className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-shell-ink">
          <span>{t('media.unavailable', { name: label })}</span>
          <button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }} className={controlClass}>{t('transcript.detail.retry')}</button>
        </div> : <img
          key={attempt}
          src={src}
          alt={label}
          draggable={false}
          decoding="async"
          onError={() => { setFailed(true); }}
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
        />}
      </div>
    </Dialog>
  );
}

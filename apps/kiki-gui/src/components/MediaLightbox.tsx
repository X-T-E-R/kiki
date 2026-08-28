/**
 * MediaLightbox — fullscreen image viewer over the Dialog primitive: dark
 * backdrop, click/Esc to close, fit↔actual-size zoom toggle, and a download
 * button. The image itself never closes the overlay on click (it zooms);
 * closing happens from the backdrop, the × button, or Escape.
 */

import { useState } from 'react';

import { useI18n } from '../i18n';
import { Dialog } from './Dialog';

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
    'rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11.5px] font-medium text-white/90 transition-colors hover:bg-white/20';

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
          ×
        </button>
      </div>
      <div
        className={
          actualSize
            ? 'max-h-[86vh] max-w-[94vw] overflow-auto'
            : 'flex items-center justify-center'
        }
      >
        <img
          src={src}
          alt={label}
          onClick={() => { setActualSize((value) => !value); }}
          className={
            actualSize
              ? 'max-w-none cursor-zoom-out'
              : 'max-h-[80vh] max-w-[92vw] cursor-zoom-in rounded-lg object-contain'
          }
        />
      </div>
    </Dialog>
  );
}

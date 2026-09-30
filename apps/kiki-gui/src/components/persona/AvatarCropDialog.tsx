/**
 * Avatar crop dialog — pick a picture, frame it, choose circle or square.
 *
 * The frame is the result: what shows inside it is exactly what the persona
 * will wear, at the size it will wear it (the three live previews underneath
 * are the list, sidebar and message sizes). The picture moves under a still
 * frame — drag, arrow keys, wheel or the zoom slider — and can never leave a
 * gap, so there is no "fit" state to explain. Save renders the square to a
 * 256 px PNG and uploads that; the original never leaves the machine.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { PersonaAvatarShape } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import {
  AVATAR_MAX_ZOOM,
  AVATAR_MIN_ZOOM,
  AVATAR_OUTPUT_SIZE,
  cropLayout,
  initialCrop,
  panCrop,
  sourceRect,
  zoomCrop,
  type AvatarCrop,
} from './avatarCrop';
import { avatarRadius } from './PersonaAvatar';

const FRAME = 264;
const PREVIEW_SIZES = [40, 24] as const;
const KEY_STEP = 8;

export interface AvatarCropResult {
  readonly file: File;
  readonly shape: PersonaAvatarShape;
}

export function AvatarCropDialog({ file, name, initialShape = 'square', busy = false, onCancel, onSave }: {
  readonly file: File;
  /** Whose face this is, for the dialog's name and the preview's alt. */
  readonly name: string;
  readonly initialShape?: PersonaAvatarShape;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onSave: (result: AvatarCropResult) => void;
}) {
  const { t } = useI18n();
  const zoomId = useId();
  const shapeId = useId();
  const [url, setUrl] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [crop, setCrop] = useState<AvatarCrop>({ cx: 0, cy: 0, zoom: 1 });
  const [shape, setShape] = useState<PersonaAvatarShape>(initialShape);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ readonly x: number; readonly y: number; readonly crop: AvatarCrop } | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    setImage(null);
    setFailed(false);
    const element = new Image();
    element.onload = () => {
      setImage(element);
      setCrop(initialCrop(element.naturalWidth, element.naturalHeight));
    };
    element.onerror = () => { setFailed(true); };
    element.src = next;
    return () => { URL.revokeObjectURL(next); };
  }, [file]);

  const width = image?.naturalWidth ?? 1;
  const height = image?.naturalHeight ?? 1;
  const pan = useCallback((dx: number, dy: number, box = FRAME) => {
    setCrop((current) => panCrop(current, dx, dy, box, width, height));
  }, [width, height]);
  const zoomTo = useCallback((zoom: number) => {
    setCrop((current) => zoomCrop(current, zoom, width, height));
  }, [width, height]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (image === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop };
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    setCrop(panCrop(start.crop, event.clientX - start.x, event.clientY - start.y, FRAME, width, height));
  };
  const endDrag = () => { drag.current = null; setDragging(false); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const moves: Record<string, readonly [number, number]> = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move !== undefined) { event.preventDefault(); pan(move[0], move[1]); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomTo(crop.zoom * 1.15); }
    if (event.key === '-') { event.preventDefault(); zoomTo(crop.zoom / 1.15); }
  };
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Non-passive, so the wheel zooms the picture instead of scrolling the page behind it.
    const frame = frameRef.current;
    if (frame === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setCrop((current) => zoomCrop(current, current.zoom * Math.exp(-event.deltaY / 600), width, height));
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => { frame.removeEventListener('wheel', onWheel); };
  }, [width, height, image]);

  const save = async () => {
    if (image === null) return;
    const rect = sourceRect(crop, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
    const blob = await new Promise<Blob | null>((resolve) => { canvas.toBlob(resolve, 'image/png'); });
    if (blob === null) return;
    onSave({ file: new File([blob], 'avatar.png', { type: 'image/png' }), shape });
  };

  const layout = useMemo(() => image === null ? null : cropLayout(crop, width, height, FRAME), [image, crop, width, height]);
  const frameRadius = shape === 'circle' ? FRAME / 2 : avatarRadius(FRAME);

  return (
    <Dialog
      onClose={() => { if (!busy) onCancel(); }}
      ariaLabel={t('persona.avatarEditTitle', { name })}
      overlayId="persona-avatar-crop"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.sm} !p-0`}
      overlayData={{ 'data-persona-avatar-crop': image === null ? (failed ? 'error' : 'loading') : 'ready' }}
    >
      <div className="flex items-center gap-3 border-b border-hairline px-5 py-3">
        <h2 className="min-w-0 flex-1 truncate font-display text-[18px] font-semibold text-ink">{t('persona.avatarEditTitle', { name })}</h2>
        <button type="button" onClick={onCancel} disabled={busy} aria-label={t('common.close')} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="px-5 pt-5 pb-4">
        {/* The stage: a quiet paper well, the frame centred in it. */}
        <div className="flex justify-center rounded-xl bg-ink/[0.035] py-6">
          <div
            ref={frameRef}
            role="group"
            tabIndex={0}
            aria-label={t('persona.avatarFrameAria')}
            aria-describedby={`${zoomId}-hint`}
            data-persona-avatar-frame={shape}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            style={{ width: FRAME, height: FRAME, borderRadius: frameRadius, touchAction: 'none' }}
            className={`relative shrink-0 overflow-hidden bg-panel ring-1 ring-ink/[0.10] outline-none transition-[border-radius] duration-200 focus-visible:ring-2 focus-visible:ring-selected-ink motion-reduce:transition-none ${
              image === null ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'
            }`}
          >
            {image !== null && layout !== null && url !== null ? (
              <img
                src={url}
                alt=""
                draggable={false}
                className="pointer-events-none absolute max-w-none select-none"
                style={{ width: layout.width, height: layout.height, left: layout.left, top: layout.top }}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-6 text-center text-[12.5px] text-ink-faint" aria-live="polite">
                {failed ? t('persona.avatarReadFailed') : t('persona.avatarReading')}
              </div>
            )}
          </div>
        </div>
        <p id={`${zoomId}-hint`} className="mt-2 text-center text-[12px] text-ink-faint">{t('persona.avatarFrameHint')}</p>

        <div className="mt-4 flex items-center gap-3">
          <label htmlFor={zoomId} className="shrink-0 text-[12.5px] text-ink-soft">{t('persona.avatarZoom')}</label>
          <button type="button" aria-label={t('persona.avatarZoomOut')} disabled={image === null || crop.zoom <= AVATAR_MIN_ZOOM} onClick={() => { zoomTo(crop.zoom / 1.25); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
            <Icon name="dash" size={14} />
          </button>
          <input
            id={zoomId}
            type="range"
            data-persona-avatar-zoom
            min={AVATAR_MIN_ZOOM}
            max={AVATAR_MAX_ZOOM}
            step={0.01}
            value={crop.zoom}
            disabled={image === null}
            onChange={(event) => { zoomTo(Number(event.target.value)); }}
            className="min-w-0 flex-1 accent-[var(--color-selected-ink)]"
          />
          <button type="button" aria-label={t('persona.avatarZoomIn')} disabled={image === null || crop.zoom >= AVATAR_MAX_ZOOM} onClick={() => { zoomTo(crop.zoom * 1.25); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
            <Icon name="plus" size={14} />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span id={shapeId} className="text-[12.5px] text-ink-soft">{t('persona.avatarShape')}</span>
            <div role="radiogroup" aria-labelledby={shapeId} className="inline-flex items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
              {(['square', 'circle'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={shape === value}
                  data-persona-avatar-shape={value}
                  onClick={() => { setShape(value); }}
                  className={`flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:h-11 ${
                    shape === value ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <span aria-hidden className={`inline-block h-3 w-3 border-[1.5px] border-current ${value === 'circle' ? 'rounded-full' : 'rounded-[3px]'}`} />
                  {t(value === 'circle' ? 'persona.avatarShapeCircle' : 'persona.avatarShapeSquare')}
                </button>
              ))}
            </div>
          </div>
          {/* Live previews at the sizes the face is actually worn. */}
          <div className="flex items-end gap-2" aria-hidden data-persona-avatar-previews>
            {PREVIEW_SIZES.map((size) => (
              <CropPreview key={size} size={size} shape={shape} url={url} layout={image === null ? null : cropLayout(crop, width, height, size)} />
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
        <button type="button" onClick={onCancel} disabled={busy} className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}>{t('common.cancel')}</button>
        <button type="button" data-persona-avatar-save data-autofocus disabled={image === null || busy} onClick={() => { void save(); }} className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`}>
          {busy ? t('common.saving') : t('persona.avatarSave')}
        </button>
      </div>
    </Dialog>
  );
}

function CropPreview({ size, shape, url, layout }: {
  readonly size: number;
  readonly shape: PersonaAvatarShape;
  readonly url: string | null;
  readonly layout: ReturnType<typeof cropLayout> | null;
}) {
  return (
    <span
      style={{ width: size, height: size, borderRadius: shape === 'circle' ? size / 2 : avatarRadius(size) }}
      className="relative inline-block shrink-0 overflow-hidden bg-panel ring-1 ring-inset ring-ink/[0.07]"
    >
      {url !== null && layout !== null ? (
        <img src={url} alt="" draggable={false} className="absolute max-w-none" style={{ width: layout.width, height: layout.height, left: layout.left, top: layout.top }} />
      ) : null}
    </span>
  );
}

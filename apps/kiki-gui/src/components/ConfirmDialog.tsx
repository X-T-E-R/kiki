/**
 * In-app confirmation modal for destructive settings actions (replaces
 * window.confirm): ink backdrop, Esc/backdrop cancel, focus trapped inside
 * the panel with the safe option focused first, focus restored on close.
 */

import { useEffect, useRef } from 'react';

import { useI18n } from '../i18n';
import { registerOverlay } from '../lib/uiBusy';
import { DANGER_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly body?: string;
  /** Consequence bullets listed under the body so the choice is informed. */
  readonly consequences?: readonly string[];
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly tone?: 'danger' | 'default';
  readonly busy?: boolean;
  /** uiBusy overlay id so Escape closes this dialog instead of aborting. */
  readonly overlayId?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  consequences,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  busy = false,
  overlayId = 'confirm-dialog',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => { restoreRef.current?.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, overlayId, onCancel]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Tab') {
      const focusables = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const first = focusables[0];
      const last = focusables.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-shell/20 p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="anim-enter w-full max-w-[420px] rounded-2xl border border-hairline bg-panel p-5 shadow-[0_12px_32px_rgba(28,25,23,0.18)]"
        onClick={(event) => { event.stopPropagation(); }}
        onKeyDown={onKeyDown}
      >
        <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
        {body !== undefined ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">{body}</p>
        ) : null}
        {consequences !== undefined && consequences.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-ink-soft">
            {consequences.map((item) => <li key={item}>{item}</li>)}
          </ul>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? DANGER_BUTTON : PRIMARY_BUTTON}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

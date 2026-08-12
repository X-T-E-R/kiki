/**
 * Toasts — the fixed bottom-right stack fed by `lib/toasts.ts`. Success/info
 * entries self-dismiss after TOAST_AUTO_DISMISS_MS; errors stay until the ×
 * (or an optional retry) settles them. Mounted once at the app root.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { useI18n } from '../i18n';
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  TOAST_AUTO_DISMISS_MS,
  type ToastItem,
} from '../lib/toasts';

const TONE_CLASS: Record<ToastItem['tone'], string> = {
  success: 'border-success/40 text-success',
  info: 'border-hairline text-ink',
  error: 'border-danger/40 text-danger',
};

const TONE_ICON: Record<ToastItem['tone'], string> = {
  success: '✓',
  info: '·',
  error: '×',
};

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useI18n();

  // Sticky errors have no timer; success/info self-dismiss.
  useEffect(() => {
    if (toast.tone === 'error') return;
    const timer = setTimeout(() => { dismissToast(toast.id); }, TOAST_AUTO_DISMISS_MS);
    return () => { clearTimeout(timer); };
  }, [toast.id, toast.tone]);

  return (
    <div
      role="status"
      className={`anim-enter flex w-80 items-start gap-2 rounded-xl border bg-panel px-3 py-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)] ${TONE_CLASS[toast.tone]}`}
    >
      <span aria-hidden className="mt-px shrink-0 text-[12px] font-bold">
        {TONE_ICON[toast.tone]}
      </span>
      <p className="min-w-0 flex-1 text-[12px] leading-snug break-words">{toast.text}</p>
      {toast.retry !== undefined ? (
        <button
          type="button"
          onClick={() => {
            dismissToast(toast.id);
            toast.retry?.run();
          }}
          className="shrink-0 rounded-md border border-current px-1.5 py-0.5 text-[10.5px] font-medium transition-opacity hover:opacity-75"
        >
          {t('common.retry')}
        </button>
      ) : null}
      {toast.tone === 'error' ? (
        <button
          type="button"
          aria-label={t('toast.dismissAria')}
          onClick={() => { dismissToast(toast.id); }}
          className="shrink-0 rounded-md px-1 text-[12px] leading-none transition-opacity hover:opacity-70"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastCard toast={toast} />
        </div>
      ))}
    </div>
  );
}

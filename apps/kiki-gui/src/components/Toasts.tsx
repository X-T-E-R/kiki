/**
 * Toasts — the fixed bottom-right stack fed by `lib/toasts.ts`. Success/info
 * entries self-dismiss after TOAST_AUTO_DISMISS_MS; errors stay until the ×
 * (or an optional retry) settles them. Mounted once at the app root.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
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
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Sticky errors have no timer; success/info self-dismiss.
  useEffect(() => {
    if (toast.tone === 'error') return;
    const timer = setTimeout(() => { dismissToast(toast.id); }, TOAST_AUTO_DISMISS_MS);
    return () => { clearTimeout(timer); };
  }, [toast.id, toast.tone]);

  const metaLine = [
    toast.code !== undefined ? `code ${toast.code}` : undefined,
    toast.requestId !== undefined ? `req ${toast.requestId}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const copyPayload = [
    toast.text,
    metaLine !== '' ? metaLine : undefined,
    toast.detail !== undefined ? toast.detail : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

  const handleCopy = () => {
    void copyTextToClipboard(copyPayload).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  };

  return (
    <div
      role="status"
      className={`anim-enter flex w-88 flex-col rounded-xl border bg-panel p-2.5 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)] ${TONE_CLASS[toast.tone]}`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-px shrink-0 text-[12px] font-bold">
          {TONE_ICON[toast.tone]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-snug break-words">{toast.text}</p>
          {metaLine !== '' ? (
            <p className="mt-0.5 font-mono text-[10px] opacity-75">{metaLine}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {toast.tone === 'error' ? (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border border-current px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-75"
              title={copyPayload}
            >
              {copied ? t('cb.copied') : t('cb.copy')}
            </button>
          ) : null}
          {toast.retry !== undefined ? (
            <button
              type="button"
              onClick={() => {
                dismissToast(toast.id);
                toast.retry?.run();
              }}
              className="rounded-md border border-current px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-75"
            >
              {t('common.retry')}
            </button>
          ) : null}
          {toast.tone === 'error' ? (
            <button
              type="button"
              aria-label={t('toast.dismissAria')}
              onClick={() => { dismissToast(toast.id); }}
              className="rounded-md px-1 text-[12px] leading-none transition-opacity hover:opacity-70"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
      {toast.detail !== undefined && toast.detail !== '' ? (
        <div className="mt-1.5 pt-1 border-t border-hairline/50">
          <button
            type="button"
            onClick={() => { setExpanded((v) => !v); }}
            className="text-[10px] font-medium underline opacity-80 hover:opacity-100"
          >
            {expanded ? t('cb.collapse') : t('ia.detail.details')}
          </button>
          {expanded ? (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-paper/60 p-1.5 font-mono text-[10px] text-ink-soft">
              {toast.detail}
            </pre>
          ) : null}
        </div>
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

/**
 * Toasts — the bottom-right stack fed by `lib/toasts.ts`: inside the content
 * column when a <ToastAnchor/> is mounted, else fixed to the viewport. Success/info
 * entries self-dismiss after TOAST_AUTO_DISMISS_MS; errors stay until the ×
 * (or an optional retry) settles them. Mounted once at the app root.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { useI18n } from '../i18n';
import { Icon, type IconName } from './icons';
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

// A toast IS the "just finished, you should know" moment, so success keeps
// its check here — unlike a timeline row, where success is silent.
const TONE_ICON: Record<ToastItem['tone'], IconName | null> = {
  success: 'check',
  info: null,
  error: 'cross',
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
      className={`anim-enter flex w-88 max-w-full flex-col rounded-xl border bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)] ${TONE_CLASS[toast.tone]}`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-[2px] flex w-3.5 shrink-0 justify-center">
          {TONE_ICON[toast.tone] === null ? null : <Icon name={TONE_ICON[toast.tone]!} />}
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
              className="inline-flex items-center gap-1 rounded-md border border-current px-1.5 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-75"
              title={copyPayload}
            >
              {copied ? <Icon name="check" size={12} /> : null}
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
              {toast.retry.label ?? t('common.retry')}
            </button>
          ) : null}
          {toast.tone === 'error' ? (
            <button
              type="button"
              aria-label={t('toast.dismissAria')}
              onClick={() => { dismissToast(toast.id); }}
              className="flex h-5 w-5 items-center justify-center rounded-md transition-opacity hover:opacity-70"
            >
              <Icon name="close" size={12} />
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

// Anchor registry: a surface that owns a content column (ConversationShell)
// mounts a <ToastAnchor/> so the stack lands inside that column instead of on
// the viewport corner, where it would cover the rail and the composer's tray.
// The newest mounted anchor wins; with none, the stack stays viewport-fixed.
let anchors: readonly HTMLElement[] = [];
const anchorListeners = new Set<() => void>();

function subscribeAnchors(listener: () => void): () => void {
  anchorListeners.add(listener);
  return () => { anchorListeners.delete(listener); };
}

function getAnchor(): HTMLElement | null {
  return anchors.at(-1) ?? null;
}

function setAnchors(next: readonly HTMLElement[]): void {
  anchors = next;
  for (const listener of anchorListeners) listener();
}

/**
 * Where the toast stack sits inside a content column. The owner positions
 * this box (see `.toast-anchor` in index.css); the stack grows upward from it.
 */
export function ToastAnchor({ className }: { className?: string }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (node === null) return;
    setAnchors([...anchors, node]);
    return () => { setAnchors(anchors.filter((anchor) => anchor !== node)); };
  }, [node]);
  return <div ref={setNode} data-toast-anchor="" className={className} />;
}

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const anchor = useSyncExternalStore(subscribeAnchors, getAnchor, getAnchor);
  if (toasts.length === 0) return null;
  const stack = (
    <div
      data-toast-stack={anchor === null ? 'viewport' : 'anchored'}
      className={`pointer-events-none flex flex-col items-end gap-2 ${
        anchor === null ? 'fixed right-4 bottom-4 z-[60]' : 'absolute right-0 bottom-0 max-w-full'
      }`}
    >
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto max-w-full">
          <ToastCard toast={toast} />
        </div>
      ))}
    </div>
  );
  return anchor === null ? stack : createPortal(stack, anchor);
}

/**
 * Toasts — the bottom-right stack fed by `lib/toasts.ts` and rendered through
 * `@base-ui/react/toast`: inside the content column when a `<ToastAnchor/>` is
 * mounted, else fixed to the viewport. Success/info entries self-dismiss after
 * `TOAST_AUTO_DISMISS_MS`; errors stay sticky (`timeout: 0`) until dismissed or
 * retried. Mounted once at the app root.
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Toast } from '@base-ui/react/toast';

import { useI18n } from '../i18n';
import { Icon, type IconName } from './icons';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  addItemToManager,
  dismissToast,
  getToasts,
  MAX_TOASTS,
  TOAST_AUTO_DISMISS_MS,
  toastManager,
  type ToastItem,
} from '../lib/toasts';

const TONE_CLASS: Record<ToastItem['tone'], string> = {
  success: 'border-success/40 text-success',
  info: 'border-hairline text-ink',
  error: 'border-danger/40 text-danger',
};

// A toast IS the "just finished, you should know" moment, so success keeps
// its check here — unlike a timeline row, where success is silent. Error uses
// a warning triangle instead of a bare cross so it never pairs two `×` glyphs
// with the right-hand dismiss button.
const TONE_ICON: Record<ToastItem['tone'], IconName | null> = {
  success: 'check',
  info: null,
  error: 'warning',
};

function ToastCard({
  toastObj,
  toast,
  paused,
}: {
  readonly toastObj: Toast.Root.ToastObject<ToastItem>;
  readonly toast: ToastItem;
  readonly paused: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const duration = toast.durationMs ?? TOAST_AUTO_DISMISS_MS;

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
    <Toast.Root
      toast={toastObj}
      role="status"
      data-toast={toast.undo !== undefined ? 'undo' : toast.tone}
      className={`anim-enter pointer-events-auto relative flex w-88 max-w-full flex-col overflow-hidden rounded-xl border bg-panel p-2 shadow-[0_8px_24px_-10px_rgba(28,25,23,0.3)] ${toast.undo !== undefined ? TONE_CLASS.info : TONE_CLASS[toast.tone]}`}
    >
      <div className="flex items-start gap-2">
        {toast.undo === undefined && TONE_ICON[toast.tone] !== null ? (
          <span aria-hidden className="mt-[2px] flex w-3.5 shrink-0 justify-center">
            <Icon name={TONE_ICON[toast.tone]!} />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-[12px] leading-snug break-words">{toast.text}</Toast.Title>
          {metaLine !== '' ? (
            <p className="mt-0.5 font-mono text-[10px] opacity-75">{metaLine}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {toast.tone === 'error' ? (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-normal text-danger transition-colors hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-selected-ink"
              title={copyPayload}
            >
              {copied ? <Icon name="check" size={12} /> : null}
              {copied ? t('connect.desktopCopied') : t('contextMenu.copy')}
            </button>
          ) : null}
          {toast.action !== undefined ? (
            <button
              type="button"
              data-toast-action
              onClick={() => {
                dismissToast(toast.id);
                void toast.action?.run();
              }}
              className="rounded-md px-2 py-0.5 text-[12px] font-normal text-selected-ink transition-colors hover:bg-selected-ink/10 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:py-2"
            >
              {toast.action.label}
            </button>
          ) : null}
          {toast.undo !== undefined ? (
            <button
              type="button"
              data-toast-undo
              onClick={() => {
                dismissToast(toast.id);
                void toast.undo?.run();
              }}
              className="rounded-md px-2 py-0.5 text-[12px] font-normal text-selected-ink transition-colors hover:bg-selected-ink/10 focus-visible:outline-2 focus-visible:outline-selected-ink pointer-coarse:py-2"
            >
              {toast.undo.label ?? t('toast.undo')}
            </button>
          ) : null}
          {toast.retry !== undefined ? (
            <button
              type="button"
              onClick={() => {
                dismissToast(toast.id);
                toast.retry?.run();
              }}
              className="rounded-md border border-current px-1.5 py-0.5 text-[10px] font-normal transition-opacity hover:opacity-75"
            >
              {toast.retry.label ?? t('common.retry')}
            </button>
          ) : null}
          {toast.undo !== undefined || toast.tone === 'error' ? (
            <Toast.Close
              aria-label={t('toast.dismissAria')}
              onClick={() => { dismissToast(toast.id); }}
              className={
                toast.undo !== undefined
                  ? 'flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink pointer-coarse:h-9 pointer-coarse:w-9'
                  : 'flex h-5 w-5 items-center justify-center rounded-md transition-opacity hover:opacity-70'
              }
            >
              <Icon name="close" size={12} />
            </Toast.Close>
          ) : null}
        </div>
      </div>
      {toast.undo !== undefined ? (
        // The time left to undo, as a hairline that drains; it holds still
        // while paused and under reduced motion it is simply absent.
        <span aria-hidden data-toast-countdown className="toast-countdown absolute inset-x-0 bottom-0 h-[2px] origin-left bg-selected-ink/35"
          style={{ animationDuration: `${duration}ms`, animationPlayState: paused ? 'paused' : 'running' }} />
      ) : null}
      {toast.detail !== undefined && toast.detail !== '' ? (
        <div className="mt-1.5 pt-1 border-t border-hairline/50">
          <button
            type="button"
            onClick={() => { setExpanded((v) => !v); }}
            className="text-[10px] font-normal underline opacity-80 hover:opacity-100"
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
    </Toast.Root>
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

function ToastStack({ anchor }: { readonly anchor: HTMLElement | null }) {
  const { toasts } = Toast.useToastManager<ToastItem>();
  const [paused, setPaused] = useState(false);

  // Sync any toasts pushed before `<Toasts />` mounted into the Base UI manager.
  useEffect(() => {
    const queued = getToasts();
    if (queued.length === 0) return;
    const present = new Set(toasts.map((entry) => entry.id));
    for (const item of queued) {
      if (!present.has(String(item.id))) {
        addItemToManager(item);
      }
    }
    // Mount-time hydration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (toasts.length === 0) return null;

  const viewport = (
    <Toast.Viewport
      data-toast-stack={anchor === null ? 'viewport' : 'anchored'}
      onPointerEnter={() => { setPaused(true); }}
      onPointerLeave={() => { setPaused(false); }}
      onFocusCapture={() => { setPaused(true); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
      className={`pointer-events-none flex flex-col items-end gap-2 ${
        anchor === null ? 'fixed right-4 bottom-[max(1rem,var(--kiki-safe-bottom-inset))] z-[60]' : 'absolute right-0 bottom-0 max-w-full'
      }`}
    >
      {toasts.map((toastObj) => {
        const item = toastObj.data;
        if (item === undefined) return null;
        return (
          <ToastCard
            key={toastObj.id}
            toastObj={toastObj}
            toast={item}
            paused={paused}
          />
        );
      })}
    </Toast.Viewport>
  );

  return anchor === null ? viewport : <Toast.Portal container={anchor}>{viewport}</Toast.Portal>;
}

export function Toasts() {
  const anchor = useSyncExternalStore(subscribeAnchors, getAnchor, getAnchor);
  return (
    <Toast.Provider toastManager={toastManager} timeout={TOAST_AUTO_DISMISS_MS} limit={MAX_TOASTS}>
      <ToastStack anchor={anchor} />
    </Toast.Provider>
  );
}

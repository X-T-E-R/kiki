/**
 * Dialog — the shared modal primitive: ink backdrop, Escape to close, a focus
 * trap, and `role="dialog"`/`aria-modal`. Rendered through a body portal so
 * fixed positioning is never captured by a transformed ancestor (the mobile
 * sidebar drawer translates itself). While mounted it registers with the
 * uiBusy overlay set, so the global Escape-to-abort handler yields to it.
 *
 * Initial focus goes to the child's `[data-autofocus]` element when present —
 * if it is momentarily disabled (a query still in flight), no fallback runs and
 * the child re-focuses it once it enables. Without a marked element the first
 * focusable control takes focus; focus returns to the previously focused
 * element on close.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { registerOverlay } from '../lib/uiBusy';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const DEFAULT_PANEL_CLASS =
  'anim-enter w-full max-w-[360px] rounded-2xl border border-hairline bg-panel p-5 shadow-[0_16px_48px_-16px_rgba(28,25,23,0.35)]';

export function Dialog({
  onClose,
  ariaLabel,
  overlayId,
  panelClassName,
  children,
}: {
  onClose: () => void;
  /** Accessible name for the dialog (mirrors the visible title). */
  ariaLabel: string;
  /** uiBusy overlay registration id — unique per dialog kind. */
  overlayId: string;
  /** Replaces the default panel chrome (larger dialogs restyle width/padding). */
  panelClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes; uiBusy keeps the global abort handler out of the way.
  useEffect(() => {
    const unregister = registerOverlay(overlayId);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, overlayId]);

  // Initial focus, Tab trap, and focus restore on unmount.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A marked-but-disabled autofocus target suppresses the fallback: moving
    // initial focus to another control inside the child would defeat the
    // child's re-focus-on-enable (e.g. NewSessionDialog's Composer textarea
    // waits on the workspaces query).
    const marked = panel.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
    const initial =
      marked ??
      (panel.querySelector('[data-autofocus]') === null
        ? panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        : null);
    (initial ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onKeyDown);
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={panelClassName ?? DEFAULT_PANEL_CLASS}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

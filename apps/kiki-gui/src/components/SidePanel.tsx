/**
 * SidePanel — the create/multi-step tier of the surface ladder
 * (components/overlays/README.md). A sheet from the right edge over a light
 * scrim, built on Dialog (focus trap, Escape, portal, uiBusy registration),
 * with a fixed head, a scrolling body and an optional pinned footer.
 *
 * Use it only to create something or to walk a multi-step flow. Editing an
 * existing object happens in the page (`overlays/DetailSplit`); a short
 * self-contained form is a Dialog; one to three fields are an
 * `AnchoredPopover`.
 *
 * Deeper steps push inside this same panel: pass `back` and the header shows
 * a Back control in front of the title (see `overlays/PanelStack` for the
 * step state). A panel never opens a second panel or a dialog on top of
 * itself; the only thing allowed above it is one ConfirmDialog.
 */

import type { ReactNode } from 'react';

import { useI18n } from '../i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';

/** Widths come from the overlay size tiers (overlays/sizes.ts): md 480, lg 640. */
const WIDTHS = {
  md: 'sm:max-w-[480px]',
  lg: 'sm:max-w-[640px]',
} as const;

export function SidePanel({
  title,
  description,
  overlayId,
  onClose,
  footer,
  width = 'md',
  children,
  data,
  back,
  stepKey,
  dismissible,
  closeAriaLabel,
}: {
  title: string;
  /** One line under the title: what this panel changes. */
  description?: ReactNode;
  /** uiBusy overlay id, unique per panel kind. */
  overlayId: string;
  onClose: () => void;
  /** Pinned under the body: the form's own actions (Save, Cancel). */
  footer?: ReactNode;
  width?: keyof typeof WIDTHS;
  children: ReactNode;
  data?: Record<`data-${string}`, string>;
  /** In-panel push navigation: a Back control before the title returns one step. */
  back?: { readonly label: string; readonly onClick: () => void; readonly data?: Record<`data-${string}`, string> };
  /** Changes with the step, so the body re-enters and scrolls to top. */
  stepKey?: string;
  /** Forwarded to Dialog: false keeps scrim clicks and a bare Escape from closing. */
  dismissible?: boolean;
  /** Override for the header close button's accessible name (a wizard's exit is a decision). */
  closeAriaLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId={overlayId}
      overlayData={data}
      dismissible={dismissible ?? true}
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-shell/20"
      panelClassName={`kiki-side-panel flex h-full w-full max-w-full flex-col overflow-hidden bg-panel shadow-[var(--kiki-sheet-shadow),-16px_0_48px_-20px_rgb(var(--kiki-shadow-ink)/0.35)] outline-none sm:rounded-l-[var(--kiki-sheet-radius)] ${WIDTHS[width]}`}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-hairline px-5 pt-4 pb-3">
        {back !== undefined ? (
          <button type="button" onClick={back.onClick} aria-label={back.label} title={back.label} data-panel-back {...back.data}
            className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11">
            <Icon name="arrowLeft" size={16} />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[18px] leading-7 font-semibold tracking-tight text-ink">{title}</h2>
          {description !== undefined ? <p className="mt-0.5 text-[12.5px] leading-5 text-ink-faint">{description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeAriaLabel ?? t('common.close')}
          className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div key={stepKey} data-panel-step={stepKey} className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-4 ${stepKey !== undefined ? 'anim-enter' : ''}`}>{children}</div>
      {footer !== undefined ? (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline bg-panel px-5 py-3">{footer}</footer>
      ) : null}
    </Dialog>
  );
}

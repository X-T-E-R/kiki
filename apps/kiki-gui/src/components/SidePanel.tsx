/**
 * SidePanel — the drawer tier of the form ladder. A sheet that slides in
 * from the right edge over a light scrim, built on Dialog (focus trap,
 * Escape, portal, uiBusy registration), with a fixed head, a scrolling body
 * and an optional pinned footer for the form's actions.
 *
 * Which surface a form gets is decided by how much it asks:
 *   - one or two fields that edit a row in place: the row itself opens
 *     (`InlineEditor`, a card that expands with the grid-rows transition);
 *   - a short, self-contained form (a name, a pair of choices, a confirm):
 *     a Dialog at `sm` / `md`;
 *   - a long form, a table to edit, or anything the user compares against
 *     the page behind it: this SidePanel.
 * Pages never append a bare form block into their own flow.
 */

import type { ReactNode } from 'react';

import { useI18n } from '../i18n';
import { Dialog } from './Dialog';
import { Icon } from './icons';

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
}) {
  const { t } = useI18n();
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={title}
      overlayId={overlayId}
      overlayData={data}
      overlayClassName="fixed inset-0 z-50 flex justify-end bg-shell/20"
      panelClassName={`kiki-side-panel flex h-full w-full max-w-full flex-col overflow-hidden bg-panel shadow-[var(--kiki-sheet-shadow),-16px_0_48px_-20px_rgb(var(--kiki-shadow-ink)/0.35)] outline-none sm:rounded-l-[var(--kiki-sheet-radius)] ${WIDTHS[width]}`}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-hairline px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[18px] leading-7 font-semibold tracking-tight text-ink">{title}</h2>
          {description !== undefined ? <p className="mt-0.5 text-[12.5px] leading-5 text-ink-faint">{description}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-4">{children}</div>
      {footer !== undefined ? (
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline bg-panel px-5 py-3">{footer}</footer>
      ) : null}
    </Dialog>
  );
}

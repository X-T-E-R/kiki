/**
 * The only widths an overlay may take (see README.md). Pick a tier; never
 * hand-write `max-w-[…px]` on a Dialog or SidePanel.
 *
 * Dialog (`DIALOG_SIZE`, centered):
 * - `sm` 520px — a confirm, a rename, a single prompt.
 * - `md` 640px — a short self-contained form (a handful of fields).
 * - `lg` 880px — a self-contained task with one large writing surface.
 *
 * SidePanel (`width` prop, right edge):
 * - `md` 480px — a create form with one column of fields.
 * - `lg` 640px — a create or multi-step flow with a catalog/grid step.
 *
 * Anything wider is not an overlay. Editing an existing object belongs in
 * the page (`DetailSplit`); a workspace surface (a board, a log) is a page.
 */

import { DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';

export type DialogSize = 'sm' | 'md' | 'lg';
export type PanelSize = 'md' | 'lg';

export const DIALOG_SIZE: Readonly<Record<DialogSize, string>> = {
  sm: DIALOG_PANEL_SIZES.sm,
  md: DIALOG_PANEL_SIZES.md,
  lg: DIALOG_PANEL_SIZES.lg,
};

/** Full panel chrome for a Dialog of one tier: `panelClassName={dialogPanelClass('md')}`. */
export function dialogPanelClass(size: DialogSize, extra = ''): string {
  return `${DIALOG_PANEL_BASE} ${DIALOG_SIZE[size]}${extra === '' ? '' : ` ${extra}`}`;
}

/**
 * The permission modes the GUI offers, as data: the composer's permission
 * chip/menu and the onboarding Approvals step both render from this list, so
 * adding, reordering or relabelling a mode is a one-row change here.
 *
 * Rows are filtered against the wire enum (`promptPermissionModeSchema`): a
 * mode the connected protocol does not know yet (e.g. `review` before the
 * backend ships it) is never offered, and appears on its own once the enum
 * carries it.
 */

import { promptPermissionModeSchema, type PermissionMode } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

/** Visual weight of a mode on the resting chip. */
export type PermissionModeTone = 'plain' | 'danger';

export interface PermissionModeDef {
  readonly id: string;
  readonly labelKey: I18nKey;
  readonly hintKey: I18nKey;
  readonly tone: PermissionModeTone;
}

const ALL_PERMISSION_MODES: readonly PermissionModeDef[] = [
  { id: 'manual', labelKey: 'composer.perm.manual', hintKey: 'composer.perm.manualHint', tone: 'plain' },
  { id: 'auto', labelKey: 'composer.perm.auto', hintKey: 'composer.perm.autoHint', tone: 'plain' },
  { id: 'review', labelKey: 'composer.perm.review', hintKey: 'composer.perm.reviewHint', tone: 'plain' },
  { id: 'yolo', labelKey: 'composer.perm.yolo', hintKey: 'composer.perm.yoloHint', tone: 'danger' },
];

const WIRE_MODES: ReadonlySet<string> = new Set(promptPermissionModeSchema.options);

/** The offered modes, in display order, limited to what the wire accepts. */
export const PERMISSION_MODES: readonly (PermissionModeDef & { readonly id: PermissionMode })[] =
  ALL_PERMISSION_MODES.filter(
    (mode): mode is PermissionModeDef & { readonly id: PermissionMode } => WIRE_MODES.has(mode.id),
  );

/** The mode first-run recommends (and new users default to). */
export const RECOMMENDED_PERMISSION_MODE: PermissionMode = 'auto';

export function permissionModeDef(id: string): PermissionModeDef | undefined {
  return PERMISSION_MODES.find((mode) => mode.id === id);
}

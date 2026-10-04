/**
 * ModelSwitchDialog — the second confirmation after a model pick: how the
 * conversation should continue on the new model (direct / compact / fresh).
 * Three plain radio rows in the existing type scale, a "don't ask again"
 * checkbox that writes the switch preferences, and a shortcut into the
 * settings card. Reuses ConfirmDialog, so Esc / backdrop / Cancel all keep
 * the current model, draft and attachments untouched.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import type { ModelSwitchMode } from '../../lib/client';
import { ConfirmDialog } from '../ConfirmDialog';

const MODE_ORDER = ['direct', 'compact', 'fresh'] as const satisfies readonly ModelSwitchMode[];

export interface ModelSwitchDialogProps {
  readonly open: boolean;
  /** Canonical id of the model in use right now. */
  readonly fromModel: string;
  /** Canonical id of the picked target model. */
  readonly toModel: string;
  /** Preselected mode: the preference resolution, or the edited operation's. */
  readonly initialMode: ModelSwitchMode;
  /**
   * Set when the panel edits a pending queue control item instead of
   * accepting a new one; confirm then reads as saving the change.
   */
  readonly editing?: boolean;
  /** A running turn: the switch queues for the idle boundary. */
  readonly busy?: boolean;
  /** Disable every control while the accept/update request is in flight. */
  readonly submitting?: boolean;
  /** Rule id the remember checkbox would update; undefined writes the default. */
  readonly matchedRuleId?: string;
  readonly onConfirm: (choice: { readonly mode: ModelSwitchMode; readonly remember: boolean }) => void;
  readonly onCancel: () => void;
  readonly onOpenSettings?: () => void;
}

export function ModelSwitchDialog({
  open,
  fromModel,
  toModel,
  initialMode,
  editing = false,
  busy = false,
  submitting = false,
  matchedRuleId,
  onConfirm,
  onCancel,
  onOpenSettings,
}: ModelSwitchDialogProps) {
  const { t } = useI18n();

  const sameModel = fromModel === toModel;
  // A direct "switch" onto the bound model changes nothing; only the two
  // context-renewing modes mean something for the same-model entry.
  const modes: readonly ModelSwitchMode[] = sameModel ? MODE_ORDER.filter((entry) => entry !== 'direct') : MODE_ORDER;
  // The preselection must be a mode this panel actually shows: a same-model
  // entry never preselects the hidden direct row.
  const initialSelection = modes.includes(initialMode) ? initialMode : modes[0]!;
  const [mode, setMode] = useState<ModelSwitchMode>(initialSelection);
  const [remember, setRemember] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  // Re-arm the choice each time the panel opens for a new pick.
  useEffect(() => {
    if (open) {
      setMode(initialSelection);
      setRemember(false);
    }
  }, [open, initialSelection]);

  const onGroupKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = modes.indexOf(mode);
    const next = modes[(index + delta + modes.length) % modes.length]!;
    setMode(next);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-model-switch-mode="${next}"]`)?.focus();
  };

  return (
    <ConfirmDialog
      open={open}
      overlayId="model-switch-dialog"
      title={sameModel ? t('modelSwitch.dialog.titleSameModel') : t('modelSwitch.dialog.title', { model: toModel })}
      body={t('modelSwitch.dialog.current', { model: fromModel })}
      confirmLabel={
        editing
          ? t('modelSwitch.dialog.saveEdit')
          : busy
            ? t('modelSwitch.dialog.confirmWhenIdle')
            : t('modelSwitch.dialog.confirm')
      }
      tone="default"
      busy={submitting}
      onConfirm={() => { onConfirm({ mode, remember }); }}
      onCancel={onCancel}
    >
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={t('modelSwitch.dialog.modesAria')}
        onKeyDown={onGroupKey}
        className="mt-4 flex flex-col"
      >
        {modes.map((entry) => {
          const checked = entry === mode;
          return (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={checked}
              data-model-switch-mode={entry}
              tabIndex={checked ? 0 : -1}
              disabled={submitting}
              onClick={() => { setMode(entry); }}
              className="group flex items-start gap-2.5 rounded-md px-1.5 py-2 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-60 pointer-coarse:py-3"
            >
              <span
                aria-hidden
                className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  checked ? 'border-selected-ink' : 'border-hairline-strong group-hover:border-ink-faint'
                }`}
              >
                {checked ? <span className="h-1.5 w-1.5 rounded-full bg-selected-ink" /> : null}
              </span>
              <span className="min-w-0">
                <span className={`block text-[13px] leading-snug ${checked ? 'font-medium text-ink' : 'text-ink'}`}>
                  {t(`modelSwitch.dialog.mode.${entry}`)}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-soft">
                  {t(`modelSwitch.dialog.mode.${entry}.hint`, { from: fromModel, to: toModel })}
                </span>
                {entry === 'fresh' && checked ? (
                  <span data-model-switch-fresh-extra className="mt-0.5 block text-[12px] leading-snug text-ink-faint">
                    {t('modelSwitch.dialog.mode.fresh.hintExtra', { from: fromModel })}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-hairline pt-3">
        <label className="flex min-h-8 cursor-pointer items-center gap-1.5 text-[12px] text-ink-soft">
          <input
            type="checkbox"
            data-model-switch-remember
            checked={remember}
            disabled={submitting}
            onChange={(event) => { setRemember(event.target.checked); }}
            className="h-3.5 w-3.5 accent-[var(--color-selected-ink)]"
          />
          {t('modelSwitch.dialog.remember')}
        </label>
        {remember ? (
          <span data-model-switch-remember-scope className="text-[11px] text-ink-faint">
            {matchedRuleId !== undefined
              ? t('modelSwitch.dialog.rememberRule', { rule: matchedRuleId })
              : t('modelSwitch.dialog.rememberDefault')}
          </span>
        ) : null}
        {onOpenSettings !== undefined ? (
          <button
            type="button"
            data-model-switch-open-settings
            disabled={submitting}
            onClick={onOpenSettings}
            className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
          >
            {t('modelSwitch.dialog.settings')}
          </button>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

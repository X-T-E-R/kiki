/**
 * PluginStatusCapsules — E12 Slot 2 (`status-capsule`).
 *
 * Compact status-bar capsules aligned with Kiki's Paper & Ink status line: a
 * 6px semantic indicator dot (`idle | active | ok | warn | error`), localized
 * label, and optional single-line tabular telemetry value. Interactive only
 * when the contribution declares an `action`.
 */

import type { PluginGuiSlotContribution } from '@kiki/protocol';
import {
  resolvePluginLocalizedText,
  selectStatusCapsuleSlots,
  type PluginStatusCapsuleSlotContribution,
} from '@kiki/session-core';

import { useI18n } from '../../i18n';
import { STATUS_SEGMENT_CLASS } from '../ComposerControls';
import { Spinner } from '../icons';
import { useExecutePluginSlotAction, usePluginGuiSlots } from './PluginComposerSlots';

const DOT_TONE_CLASSES: Readonly<Record<PluginStatusCapsuleSlotContribution['dotTone'], string>> = {
  idle: 'bg-ink-faint/60',
  active: 'bg-accent',
  ok: 'bg-success',
  warn: 'bg-amber-rule',
  error: 'bg-danger',
};

export function PluginStatusCapsules({
  slots,
  sessionId,
  workspaceId,
  disabled = false,
  onOpenPanel,
}: {
  readonly slots?: readonly PluginGuiSlotContribution[];
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly disabled?: boolean;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { t, locale } = useI18n();
  const queried = usePluginGuiSlots({ sessionId, workspaceId });
  const effectiveSlots = slots ?? queried.slots;
  const capsules = selectStatusCapsuleSlots(effectiveSlots);
  const { execute, busyKey } = useExecutePluginSlotAction();

  if (capsules.length === 0) return null;

  return (
    <div
      role="group"
      aria-label={t('pluginSlot.statusAria')}
      data-plugin-status-capsules
      className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden @max-[32rem]/toolbar:hidden"
    >
      {capsules.map((capsule) => {
        const key = `${capsule.pluginId}:${capsule.id}`;
        const label = resolvePluginLocalizedText(capsule.label, locale);
        const fullText =
          capsule.valueText !== undefined && capsule.valueText !== ''
            ? `${label} · ${capsule.valueText}`
            : label;
        const isBusy = busyKey === key;

        const content = (
          <>
            {isBusy ? (
              <Spinner label={label} />
            ) : (
              <span
                aria-hidden
                data-plugin-capsule-dot={capsule.dotTone}
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE_CLASSES[capsule.dotTone]}`}
              />
            )}
            <span className="min-w-0 truncate text-[12px] leading-4 text-ink-soft">{label}</span>
            {capsule.valueText !== undefined && capsule.valueText !== '' ? (
              <span
                data-plugin-capsule-value
                className="max-w-28 shrink-0 truncate font-mono text-[11.5px] leading-4 text-ink-faint tabular-nums @max-[38rem]/toolbar:hidden"
              >
                {capsule.valueText}
              </span>
            ) : null}
          </>
        );

        if (capsule.action === undefined) {
          return (
            <span
              key={key}
              title={fullText}
              data-plugin-status-capsule={key}
              className="inline-flex h-7 max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 select-none"
            >
              {content}
            </span>
          );
        }

        const action = capsule.action;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled || isBusy}
            title={fullText}
            aria-label={fullText}
            data-plugin-status-capsule={key}
            onClick={() => {
              void execute(
                {
                  pluginId: capsule.pluginId,
                  label,
                  action,
                  sessionId,
                  workspaceId,
                  onOpenPanel,
                },
                key,
              );
            }}
            className={`${STATUS_SEGMENT_CLASS} max-w-48`}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

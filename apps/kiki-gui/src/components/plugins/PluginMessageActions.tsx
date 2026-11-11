/**
 * PluginMessageActions — E12 Slot 3 (`message-action`).
 *
 * Contributes role-filtered (`user | assistant`) menu items directly inside
 * `MessageRowActions`'s overflow menu so there is one unified message action
 * surface without extra floating chrome.
 */

import type { PluginGuiSlotContribution } from '@kiki/protocol';
import {
  resolvePluginLocalizedText,
  selectMessageActionSlots,
  type PluginMessageActionSlotContribution,
} from '@kiki/session-core';

import { useI18n } from '../../i18n';
import { Spinner } from '../icons';
import { useExecutePluginSlotAction, usePluginGuiSlots } from './PluginComposerSlots';

const MENU_ITEM_CLASS =
  'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40';

export function useRolePluginMessageActions(input: {
  readonly role?: 'user' | 'assistant';
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly slots?: readonly PluginGuiSlotContribution[];
}): readonly PluginMessageActionSlotContribution[] {
  const queried = usePluginGuiSlots({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  });
  if (input.role === undefined) return [];
  return selectMessageActionSlots(input.slots ?? queried.slots, input.role);
}

export function PluginMessageActions({
  role,
  messageId,
  messageText,
  sessionId,
  workspaceId,
  slots,
  disabled = false,
  onSelect,
  onOpenPanel,
}: {
  readonly role: 'user' | 'assistant';
  readonly messageId?: string;
  readonly messageText?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly slots?: readonly PluginGuiSlotContribution[];
  readonly disabled?: boolean;
  readonly onSelect?: () => void;
  readonly onOpenPanel?: (pluginId: string, panelId: string) => void;
}) {
  const { locale } = useI18n();
  const items = useRolePluginMessageActions({ role, sessionId, workspaceId, slots });
  const { execute, busyKey } = useExecutePluginSlotAction();

  if (items.length === 0) return null;

  return (
    <>
      {items.map((item) => {
        const key = `${item.pluginId}:${item.id}`;
        const label = resolvePluginLocalizedText(item.label, locale);
        const isBusy = busyKey === key;
        return (
          <button
            key={key}
            type="button"
            role="menuitem"
            disabled={disabled || isBusy}
            title={label}
            aria-label={label}
            data-plugin-message-action={key}
            onClick={() => {
              onSelect?.();
              void execute(
                {
                  pluginId: item.pluginId,
                  label,
                  action: item.action,
                  sessionId,
                  workspaceId,
                  contextPayload: {
                    role,
                    ...(messageId !== undefined ? { messageId } : undefined),
                    ...(messageText !== undefined && messageText !== ''
                      ? { messagePreview: messageText.slice(0, 2_000) }
                      : undefined),
                  },
                  onOpenPanel,
                },
                key,
              );
            }}
            className={MENU_ITEM_CLASS}
          >
            <span className="truncate">{label}</span>
            {isBusy ? <Spinner label={label} /> : null}
          </button>
        );
      })}
    </>
  );
}

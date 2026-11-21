/**
 * SidebarSnoozePopover — preset snooze picker using `@base-ui/react`
 * (`AnchoredPopover` on desktop, `ActionSheet` on phone).
 */

import type { RefObject } from 'react';

import type { SnoozePreset } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { usePhoneMode } from '../../lib/layoutHooks';
import { Icon } from '../icons';
import { ActionSheet } from '../overlays/ActionSheet';
import { AnchoredPopover } from '../overlays/AnchoredPopover';

const PRESETS: readonly { readonly preset: SnoozePreset; readonly labelKey: 'sidebar.inbox.snooze.30m' | 'sidebar.inbox.snooze.1h' | 'sidebar.inbox.snooze.3h' | 'sidebar.inbox.snooze.tomorrow' }[] = [
  { preset: '30m', labelKey: 'sidebar.inbox.snooze.30m' },
  { preset: '1h', labelKey: 'sidebar.inbox.snooze.1h' },
  { preset: '3h', labelKey: 'sidebar.inbox.snooze.3h' },
  { preset: 'tomorrow', labelKey: 'sidebar.inbox.snooze.tomorrow' },
];

export interface SidebarSnoozePopoverProps {
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly onSelect: (preset: SnoozePreset) => void;
  readonly onClose: () => void;
}

export function SidebarSnoozePopover({
  anchorRef,
  onSelect,
  onClose,
}: SidebarSnoozePopoverProps) {
  const { t } = useI18n();
  const isPhone = usePhoneMode();

  const content = (
    <div className="flex flex-col gap-0.5" data-snooze-menu>
      {PRESETS.map(({ preset, labelKey }) => (
        <button
          key={preset}
          type="button"
          role="menuitem"
          data-snooze-preset={preset}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(preset);
            onClose();
          }}
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper pointer-coarse:min-h-11"
        >
          <Icon name="clock" size={14} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );

  if (isPhone) {
    return (
      <ActionSheet
        ariaLabel={t('sidebar.inbox.snooze')}
        overlayId="sidebar-snooze-sheet"
        onClose={onClose}
        dataAttribute="data-snooze-popover"
      >
        {content}
      </ActionSheet>
    );
  }

  return (
    <AnchoredPopover
      open
      onClose={onClose}
      anchorRef={anchorRef}
      id="sidebar-snooze-popover"
      label={t('sidebar.inbox.snooze')}
      role="menu"
      widthClassName="w-[164px]"
      className="!p-1"
      data={{ 'data-snooze-popover': '' }}
    >
      {content}
    </AnchoredPopover>
  );
}

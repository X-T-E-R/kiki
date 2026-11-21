/**
 * SidebarModeSwitch — crisp `[ 待办 | 会话 ]` 2-segment toggle aligned on the
 * Zone 1 `18px` left keyline.
 *
 * Carries the Zone 1 two-tier inbox signal (`data-activity-badge` +
 * `data-activity-badge-tone`):
 *   - `needsYouCount > 0`: vermilion count pill (`bg-attention`)
 *   - `needsYouCount === 0 && unreadCount > 0`: quiet `7px` dot (`bg-ink-soft/65`)
 *   - `total === 0`: nothing
 */

import type { SidebarMode } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';

export interface SidebarModeSwitchProps {
  readonly mode: SidebarMode;
  readonly onChange: (mode: SidebarMode) => void;
  readonly needsYouCount: number;
  readonly unreadCount: number;
  readonly total: number;
}

export function SidebarModeSwitch({
  mode,
  onChange,
  needsYouCount,
  unreadCount,
  total,
}: SidebarModeSwitchProps) {
  const { t } = useI18n();
  const hasSignal = total > 0;
  const hasNeedsYou = needsYouCount > 0;
  const hasUnreadOnly = !hasNeedsYou && unreadCount > 0;

  return (
    <div className="px-2.5 pb-1.5" data-sidebar-mode-wrap>
      <div
        role="tablist"
        aria-label={t('sidebar.mode.aria')}
        data-sidebar-mode-switch
        className="grid grid-cols-2 rounded-lg bg-ink/[0.045] p-0.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'inbox'}
          data-sidebar-mode="inbox"
          onClick={() => { onChange('inbox'); }}
          className={`flex h-7 items-center justify-center gap-1.5 rounded-[6px] px-2 text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${
            mode === 'inbox'
              ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
              : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className="truncate">{t('sidebar.mode.inbox')}</span>
          {hasSignal ? (
            hasNeedsYou ? (
              <span
                data-activity-badge={total}
                data-activity-badge-tone="needs-you"
                aria-hidden
                className="inline-flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-attention px-1 text-[10px] leading-none font-semibold tabular-nums text-on-accent"
              >
                {needsYouCount > 99 ? '99+' : needsYouCount}
              </span>
            ) : hasUnreadOnly ? (
              <span
                data-activity-badge={total}
                data-activity-badge-tone="unread"
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full bg-ink-soft/65"
              />
            ) : null
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'sessions'}
          data-sidebar-mode="sessions"
          onClick={() => { onChange('sessions'); }}
          className={`flex h-7 items-center justify-center rounded-[6px] px-2 text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:h-9 ${
            mode === 'sessions'
              ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
              : 'text-ink-soft hover:text-ink'
          }`}
        >
          <span className="truncate">{t('sidebar.mode.sessions')}</span>
        </button>
      </div>
    </div>
  );
}

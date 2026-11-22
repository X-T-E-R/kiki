/**
 * SidebarModeSwitch — Zone 1 `18px`-keyline typographic tab bar (`待办` / `会话`)
 * with an optional right-aligned action cluster on the same row.
 *
 * Carries the Zone 1 two-tier inbox signal (`data-activity-badge` +
 * `data-activity-badge-tone`):
 *   - `needsYouCount > 0`: compact vermilion tint pill (`bg-attention/14 text-attention`)
 *   - `needsYouCount === 0 && unreadCount > 0`: quiet `6px` dot (`bg-ink-soft/65`)
 *   - `total === 0`: nothing
 */

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';

import type { SidebarMode } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';

export interface SidebarModeSwitchProps {
  readonly mode: SidebarMode;
  readonly onChange: (mode: SidebarMode) => void;
  readonly needsYouCount: number;
  readonly unreadCount: number;
  readonly total: number;
  /** Optional right-aligned inline utility controls (e.g. session list tools). */
  readonly actions?: ReactNode;
}

export function SidebarModeSwitch({
  mode,
  onChange,
  needsYouCount,
  unreadCount,
  total,
  actions,
}: SidebarModeSwitchProps) {
  const { t } = useI18n();
  const inboxTabRef = useRef<HTMLButtonElement>(null);
  const sessionsTabRef = useRef<HTMLButtonElement>(null);
  const hasSignal = total > 0;
  const hasNeedsYou = needsYouCount > 0;
  const hasUnreadOnly = !hasNeedsYou && unreadCount > 0;

  const selectTab = useCallback((nextMode: SidebarMode) => {
    onChange(nextMode);
    if (nextMode === 'inbox') inboxTabRef.current?.focus();
    else sessionsTabRef.current?.focus();
  }, [onChange]);

  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      selectTab(mode === 'inbox' ? 'sessions' : 'inbox');
    } else if (event.key === 'Home') {
      event.preventDefault();
      selectTab('inbox');
    } else if (event.key === 'End') {
      event.preventDefault();
      selectTab('sessions');
    }
  }, [mode, selectTab]);

  return (
    <div className="@container px-2.5" data-sidebar-mode-wrap>
      <div className="flex h-8 items-center justify-between gap-1 border-b border-hairline/70 pr-0.5 pl-2 pointer-coarse:h-10">
        <div
          role="tablist"
          aria-label={t('sidebar.mode.aria')}
          data-sidebar-mode-switch
          onKeyDown={onTabKeyDown}
          className="flex h-full shrink-0 items-stretch gap-3"
        >
          <button
            ref={inboxTabRef}
            type="button"
            role="tab"
            aria-selected={mode === 'inbox'}
            tabIndex={mode === 'inbox' ? 0 : -1}
            data-sidebar-mode="inbox"
            onClick={() => { onChange('inbox'); }}
            className={`relative flex h-full shrink-0 items-center gap-1 whitespace-nowrap text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
              mode === 'inbox'
                ? 'font-medium text-ink after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-ink'
                : 'font-normal text-ink-faint hover:text-ink-soft'
            }`}
          >
            <span>{t('sidebar.mode.inbox')}</span>
            {hasSignal ? (
              hasNeedsYou ? (
                <span
                  data-activity-badge={total}
                  data-activity-badge-tone="needs-you"
                  aria-hidden
                  className="inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-attention/14 px-1 text-[10.5px] leading-none font-medium tabular-nums text-attention"
                >
                  {needsYouCount > 99 ? '99+' : needsYouCount}
                </span>
              ) : hasUnreadOnly ? (
                <span
                  data-activity-badge={total}
                  data-activity-badge-tone="unread"
                  aria-hidden
                  className="h-[6px] w-[6px] shrink-0 rounded-full bg-ink-soft/65"
                />
              ) : null
            ) : null}
          </button>
          <button
            ref={sessionsTabRef}
            type="button"
            role="tab"
            aria-selected={mode === 'sessions'}
            tabIndex={mode === 'sessions' ? 0 : -1}
            data-sidebar-mode="sessions"
            onClick={() => { onChange('sessions'); }}
            className={`relative flex h-full shrink-0 items-center whitespace-nowrap text-[12.5px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink ${
              mode === 'sessions'
                ? 'font-medium text-ink after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-ink'
                : 'font-normal text-ink-faint hover:text-ink-soft'
            }`}
          >
            <span>{t('sidebar.mode.sessions')}</span>
          </button>
        </div>
        {actions !== undefined && actions !== null ? (
          <div className="flex shrink-0 items-center gap-0.5" data-sidebar-mode-actions>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

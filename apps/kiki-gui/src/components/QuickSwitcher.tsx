/**
 * QuickSwitcher — the Ctrl+K centered overlay. Empty query lists the most
 * recent sessions; a query merges local title/cwd matches with global-search
 * hits (`POST /search`). ↑↓ moves the active row, Enter opens it, Esc closes
 * (handled by Dialog). Replaces the old Ctrl+K-focuses-the-sidebar-search
 * behavior.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Session, Workspace } from '@kiki/protocol';

import {
  buildSwitcherItems,
  settingsCardRoute,
  type SwitcherItem,
  type SwitcherSettingItem,
} from '@kiki/session-core/sessions';
import {
  buildSettingsSearchIndex,
  searchSettings,
  settingsSectionLabels,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { useSessionSearch } from '../lib/sessionSearch';
import { Dialog } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';

export function QuickSwitcher({
  sessions,
  workspaces = [],
  initialQuery,
  onClose,
}: {
  sessions: readonly Session[];
  workspaces?: readonly Workspace[];
  /** Seeds the search (the conversation find bar hands its query over). */
  initialQuery?: string;
  onClose: () => void;
}) {
  const { t, time } = useI18n();
  const navigate = useGuardedNavigate();
  const [input, setInput] = useState(initialQuery ?? '');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const untitled = t('sidebar.untitled');
  // The same two-layer engine as the sidebar: instant local ranking plus the
  // debounced, abortable content search.
  const search = useSessionSearch({
    text: input,
    sessions,
    workspaces,
    untitled,
    queryKeyPrefix: 'quick-switcher-search',
  });
  const localMatches = useMemo(
    () => (search.parsed.text.trim() === '' ? undefined : search.local.sessions.map((match) => match.session.source)),
    [search.local.sessions, search.parsed.text],
  );
  const usageActionTitle = t('switcher.action.usage');
  const settingsActionTitle = t('switcher.action.settings');
  // The settings index is the same one the settings page searches, so a name
  // that works there works here — and lands on the card, not the section.
  const settingsIndex = useMemo(
    () => buildSettingsSearchIndex(settingsSectionLabels(t), t),
    [t],
  );
  const settingsMatches: SwitcherSettingItem[] = useMemo(
    () =>
      searchSettings(settingsIndex, input).map((entry) => ({
        kind: 'setting',
        cardId: entry.cardId,
        sectionLabel: entry.sectionLabel,
        title: entry.title,
        route: settingsCardRoute(entry.section, entry.cardId, entry.tab),
      })),
    [settingsIndex, input],
  );
  const items = useMemo(
    () =>
      buildSwitcherItems({
        query: input,
        sessions,
        hits: search.hits,
        untitled,
        localMatches,
        actions: [
          { actionId: 'usage', title: usageActionTitle, route: '/usage' },
          { actionId: 'board', title: t('nav.board'), route: '/board' },
          { actionId: 'cron', title: t('nav.cron'), route: '/cron' },
          { actionId: 'memory', title: t('nav.memory'), route: '/memory' },
          { actionId: 'settings', title: settingsActionTitle, route: '/settings' },
        ],
        settings: settingsMatches,
      }),
    [
      input,
      sessions,
      search.hits,
      localMatches,
      untitled,
      usageActionTitle,
      settingsActionTitle,
      settingsMatches,
    ],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [input]);

  // Keep the active row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const openItem = (item: SwitcherItem | undefined) => {
    if (item === undefined) return;
    onClose();
    if (item.kind === 'action' || item.kind === 'setting') navigate(item.route);
    else if (item.kind === 'hit') {
      const route = item.agentId && item.agentId !== 'main'
        ? `/s/${item.sessionId}/agent/${item.agentId}` : `/s/${item.sessionId}`;
      navigate(item.turn === undefined ? route : `${route}?turn=${item.turn}`);
    } else navigate(`/s/${item.sessionId}`);
  };

  const onInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (items.length === 0 ? 0 : (index + 1) % items.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) =>
        items.length === 0 ? 0 : (index - 1 + items.length) % items.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openItem(items[activeIndex]);
    }
  };

  const searching = search.contentPending;
  const firstActionIndex = items.findIndex((item) => item.kind === 'action');
  const firstSessionIndex = items.findIndex((item) => item.kind === 'session');
  const firstHitIndex = items.findIndex((item) => item.kind === 'hit');
  const firstSettingIndex = items.findIndex((item) => item.kind === 'setting');

  return (
    <Dialog
      onClose={onClose}
      ariaLabel={t('switcher.aria')}
      overlayId="quick-switcher"
      panelClassName="anim-enter w-full max-w-[560px] overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_16px_48px_-16px_rgb(var(--kiki-shadow-ink)/0.35)]"
    >
      <div className="border-b border-hairline px-4 py-3">
        <input
          type="text"
          data-autofocus
          value={input}
          onChange={(event) => { setInput(event.target.value); }}
          onKeyDown={onInputKeyDown}
          placeholder={t('switcher.placeholder')}
          aria-label={t('switcher.aria')}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switcher-list"
          aria-activedescendant={items.length > 0 ? `quick-switcher-item-${activeIndex}` : undefined}
          className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      <div
        ref={listRef}
        id="quick-switcher-list"
        role="listbox"
        className="max-h-[340px] overflow-y-auto p-2"
      >
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-ink-faint">
            {searching ? t('sidebar.searching') : input.trim() === '' ? t('switcher.empty') : t('switcher.noMatches', { query: input.trim() })}
          </p>
        ) : (
          items.map((item, index) => {
            const active = index === activeIndex;
            const headerText =
              index === firstActionIndex
                ? t('switcher.pages')
                : index === firstSessionIndex
                  ? input.trim() === ''
                    ? t('switcher.recent')
                    : t('switcher.sessions')
                  : index === firstHitIndex
                    ? t('switcher.matches')
                    : index === firstSettingIndex
                      ? t('switcher.settings')
                      : null;
            const itemKey =
              item.kind === 'action'
                ? `action-${item.actionId}`
                : item.kind === 'setting'
                  ? `setting-${item.cardId}`
                  : `${item.kind}-${item.sessionId}-${index}`;
            return (
              <div key={itemKey}>
                {headerText !== null ? (
                  <p className={`px-2 pb-0.5 text-[12px] font-medium text-ink-faint ${index === 0 ? 'pt-1' : 'pt-2'}`}>
                    {headerText}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={`quick-switcher-item-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  onClick={() => { openItem(item); }}
                  onMouseMove={() => { if (!active) setActiveIndex(index); }}
                  className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] ${
                    active ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
                  }`}
                >
                  {item.kind === 'action' ? (
                    <span className="flex items-center gap-2">
                      <Icon name="arrowUpRight" size={14} className="text-ink-faint" />
                      <span className="truncate text-[13px] font-medium text-ink">
                        {item.title}
                      </span>
                    </span>
                  ) : item.kind === 'setting' ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="shrink-0 text-[12px] text-ink-faint">
                        {item.sectionLabel}
                      </span>
                      <Icon name="chevron" size={12} className="text-ink-faint" />
                      <span className="truncate text-[13px] font-medium text-ink">
                        {item.title}
                      </span>
                    </span>
                  ) : item.kind === 'session' ? (
                    <>
                      <span className="truncate text-[13px] font-medium text-ink">
                        {item.title}
                      </span>
                      <span className="flex items-center gap-1.5 text-[12px] text-ink-faint">
                        <span className="truncate">{item.cwd}</span>
                        <span className="shrink-0">· {time.relativeTime(item.updatedAt)}</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="line-clamp-2 text-[12px] leading-snug text-ink">
                        {item.snippet}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                        <span className="truncate">
                          {item.sessionTitle.trim() !== '' ? item.sessionTitle : untitled}
                        </span>
                        <span className="shrink-0">· {t(`sidebar.results.role.${item.role}`)}</span>
                      </span>
                    </>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-hairline px-4 py-2 text-[11px] text-ink-faint">
        {t('switcher.hint')}
      </div>
    </Dialog>
  );
}

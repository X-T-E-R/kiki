import { useRef } from 'react';
import type { I18nKey } from '@kiki/session-core/i18n';
import type { NbSearchTab } from './types';
import { NB_SEARCH_TABS } from './types';
import { useI18n } from '../../../i18n';

export function NbSearchTabBar({
  activeTab,
  onSelectTab,
  attentionCount = 0,
  dirty = false,
}: {
  activeTab: NbSearchTab;
  onSelectTab: (tab: NbSearchTab) => void;
  attentionCount?: number;
  dirty?: boolean;
}) {
  const { t, tp } = useI18n();
  const tabsRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const nextIndex = (index + 1) % NB_SEARCH_TABS.length;
      onSelectTab(NB_SEARCH_TABS[nextIndex]!);
      focusTab(nextIndex);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prevIndex = (index - 1 + NB_SEARCH_TABS.length) % NB_SEARCH_TABS.length;
      onSelectTab(NB_SEARCH_TABS[prevIndex]!);
      focusTab(prevIndex);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onSelectTab(NB_SEARCH_TABS[0]!);
      focusTab(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      const lastIndex = NB_SEARCH_TABS.length - 1;
      onSelectTab(NB_SEARCH_TABS[lastIndex]!);
      focusTab(lastIndex);
    }
  };

  const focusTab = (index: number) => {
    const buttons = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };

  const tabLabelKey = (tab: NbSearchTab): I18nKey => {
    switch (tab) {
      case 'overview':
        return 'st.nbSearch.tab.overview';
      case 'search':
        return 'st.nbSearch.tab.search';
      case 'fetch':
        return 'st.nbSearch.tab.fetch';
      case 'providers':
        return 'st.nbSearch.tab.providers';
      case 'advanced':
        return 'st.nbSearch.tab.advanced';
    }
  };

  return (
    <div
      ref={tabsRef}
      role="tablist"
      aria-label={t('st.nbSearch.statusTitle')}
      className="flex flex-wrap items-center gap-1 border-b border-hairline pb-px text-[12.5px]"
    >
      {NB_SEARCH_TABS.map((tab, index) => {
        const active = tab === activeTab;
        return (
          <button
            key={tab}
            id={`nb-search-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`nb-search-panel-${tab}`}
            tabIndex={active ? 0 : -1}
            data-nb-search-tab={tab}
            onClick={() => { onSelectTab(tab); }}
            onKeyDown={(event) => { handleKeyDown(event, index); }}
            className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-t-md ${
              active
                ? 'border-accent font-semibold text-ink'
                : 'border-transparent text-ink-soft hover:border-hairline hover:text-ink'
            }`}
          >
            <span>{t(tabLabelKey(tab))}</span>
            {tab === 'providers' && attentionCount > 0 ? (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-card border border-amber-rule/60 px-1 text-[9px] font-bold text-amber-ink"
                title={tp('st.nbSearch.tabBar.attention', attentionCount)}
              >
                {attentionCount}
              </span>
            ) : null}
            {active && dirty ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent"
                title={t('st.tools.unsaved')}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

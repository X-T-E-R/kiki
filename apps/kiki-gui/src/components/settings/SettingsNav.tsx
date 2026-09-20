import { useEffect, useMemo, useRef, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  SETTINGS_NAV_TREE,
  buildSettingsSearchIndex,
  searchSettings,
  settingsSectionLabels,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { SECTIONS, type SectionId } from './sections';

/**
 * Settings search field plus its hit list. Both the wide nav column and the
 * narrow-viewport header mount one, so search is never a desktop-only path.
 */
export function SettingsSearch({
  focusToken,
  onSearchHit,
  className = '',
  idle,
}: {
  /** Changes on every Ctrl+, so a repeat press refocuses; null means no focus. */
  focusToken: string | null;
  onSearchHit: (entry: SettingsSearchEntry) => void;
  className?: string;
  /** Navigation shown while the field is empty; hits replace it while typing. */
  idle?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildSettingsSearchIndex(settingsSectionLabels(t), t), [t]);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim() !== '';

  // Ctrl+, lands here: type, Enter to jump, Esc to leave. Only the visible
  // instance takes focus — the other one is display:none at this breakpoint.
  useEffect(() => {
    if (focusToken === null) return;
    const input = inputRef.current;
    if (input === null || input.offsetParent === null) return;
    input.focus();
    input.select();
  }, [focusToken]);

  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="search"
        data-settings-search
        aria-label={t('st.search.aria')}
        placeholder={t('st.search.placeholder')}
        value={query}
        onChange={(event) => { setQuery(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setQuery('');
            event.currentTarget.blur();
          } else if (event.key === 'Enter' && results.length > 0) {
            event.preventDefault();
            onSearchHit(results[0]!);
            setQuery('');
          }
        }}
        className="w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      {searching ? (
        <div className="mt-1 space-y-0.5" role="listbox" aria-label={t('st.search.aria')}>
          {results.map((entry) => (
            <button
              key={entry.cardId}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => { onSearchHit(entry); setQuery(''); }}
              className="w-full truncate rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
            >
              {entry.groupLabel !== '' ? (
                <>
                  <span className="text-ink-faint">{entry.groupLabel}</span>
                  <span className="mx-1 text-ink-faint">›</span>
                </>
              ) : null}
              <span className="text-ink-faint">{entry.sectionLabel}</span>
              <span className="mx-1 text-ink-faint">›</span>
              <span className="text-ink">{entry.title}</span>
            </button>
          ))}
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-[11.5px] text-ink-faint">{t('st.search.empty', { query: query.trim() })}</p>
          ) : null}
        </div>
      ) : (idle ?? null)}
    </div>
  );
}

/**
 * The settings navigation tree: non-clickable group headers with clickable
 * leaf sections, plus top-level leaves (About & updates) that belong to no
 * group. Shared by the desktop rail and the mobile drawer so both breakpoints
 * present the same hierarchy.
 */
export function SettingsNavTree({
  active,
  onNavigate,
  onAfterNavigate,
}: {
  /** Null on the unknown-section page: tree stays visible, nothing highlighted. */
  active: SectionId | null;
  onNavigate: (section: SectionId) => void;
  /** Drawer hosts pass a close hook; the desktop rail leaves it unset. */
  onAfterNavigate?: () => void;
}) {
  const { t } = useI18n();
  const labelFor = (id: string) => SECTIONS.find((section) => section.id === id)?.labelKey;
  const leafButton = (id: string) => {
    const labelKey = labelFor(id);
    if (labelKey === undefined) return null;
    return (
      <button
        key={id}
        type="button"
        data-settings-nav-leaf={id}
        onClick={() => { onNavigate(id as SectionId); onAfterNavigate?.(); }}
        className={`rounded-lg px-2 py-2 text-left text-[13px] transition-colors ${active === id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'}`}
      >
        {t(labelKey)}
      </button>
    );
  };

  const nbSearchSubtabs: readonly { tab: string; labelKey: I18nKey }[] = [
    { tab: 'overview', labelKey: 'st.nbSearch.tab.overview' },
    { tab: 'search', labelKey: 'st.nbSearch.tab.search' },
    { tab: 'fetch', labelKey: 'st.nbSearch.tab.fetch' },
    { tab: 'providers', labelKey: 'st.nbSearch.tab.providers' },
    { tab: 'advanced', labelKey: 'st.nbSearch.tab.advanced' },
  ];

  return (
    <div className="mt-2 flex flex-col gap-3" data-settings-nav-tree>
      {SETTINGS_NAV_TREE.map((node) => {
        if (node.kind === 'leaf') {
          return <div key={`leaf-${node.section}`} data-settings-nav-ungrouped={node.section}>{leafButton(node.section)}</div>;
        }
        if (node.sections.length === 0) return null;
        return (
          <div key={node.id} data-settings-nav-group={node.id}>
            <p className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
              {t(node.labelKey)}
            </p>
            <div className="flex flex-col">
              {node.sections.map((id) => (
                <div key={id} className="flex flex-col">
                  {leafButton(id)}
                  {id === 'search' && active === 'search' ? (
                    <div className="ml-3 my-0.5 flex flex-col gap-0.5 border-l border-hairline pl-2" data-settings-nav-subtabs="search">
                      {nbSearchSubtabs.map((sub) => (
                        <button
                          key={sub.tab}
                          type="button"
                          data-settings-nav-subtab={sub.tab}
                          onClick={() => {
                            onNavigate(`search?tab=${sub.tab}` as unknown as SectionId);
                            onAfterNavigate?.();
                          }}
                          className="rounded px-2 py-1 text-left text-[11.5px] text-ink-soft transition-colors hover:bg-paper hover:text-ink"
                        >
                          {t(sub.labelKey)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SettingsNav({
  active,
  searchFocusToken,
  onNavigate,
  onSearchHit,
}: {
  active: SectionId | null;
  searchFocusToken: string | null;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  return (
    <nav className="flex h-full w-full flex-col overflow-y-auto overscroll-y-contain border-r border-hairline bg-panel p-2 lg:w-[232px]">
      <SettingsSearch
        focusToken={searchFocusToken}
        onSearchHit={onSearchHit}
        className="px-1"
        idle={<SettingsNavTree active={active} onNavigate={onNavigate} />}
      />
    </nav>
  );
}

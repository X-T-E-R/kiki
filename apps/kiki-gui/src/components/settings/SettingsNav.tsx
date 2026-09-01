import { useEffect, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import {
  buildSettingsSearchIndex,
  searchSettings,
  settingsSectionLabels,
  type SettingsSearchEntry,
} from '../../lib/settings';
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

export function SettingsNav({
  active,
  searchFocusToken,
  onNavigate,
  onSearchHit,
}: {
  active: SectionId;
  searchFocusToken: string | null;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  return (
    <nav className="flex h-full w-full flex-col overflow-y-auto border-r border-hairline bg-panel p-2 lg:w-[200px]">
      <SettingsSearch
        focusToken={searchFocusToken}
        onSearchHit={onSearchHit}
        className="px-1"
        idle={
          <div className="mt-2 flex flex-col">
            {SECTIONS.map((section) => (
              <button key={section.id} type="button" onClick={() => { onNavigate(section.id); }} className={`rounded-lg px-2 py-2 text-left text-[13px] transition-colors ${active === section.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-paper hover:text-ink'}`}>{t(section.labelKey)}</button>
            ))}
          </div>
        }
      />
    </nav>
  );
}

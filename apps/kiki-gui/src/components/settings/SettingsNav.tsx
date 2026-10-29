import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  SETTINGS_NAV_TREE,
  buildSettingsSearchIndex,
  canonicalNavSection,
  searchSettings,
  settingsSectionLabels,
  type SettingsNavGroupSpec,
  type SettingsNavNode,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { useOptionalInstalledPlugins } from '../capabilities/usePlugins';
import { SECTIONS, type SectionId } from './sections';

const LEAF_QUERY_PREFIXES: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  ai: [['config']],
  workspaces: [['workspaces', 'catalog']],
  memory: [['memory-settings']],
  extensions: [['workspace-skills'], ['mcp-managed-servers'], ['plugins']],
  skills: [['workspace-skills']],
  mcp: [['mcp-managed-servers']],
  plugins: [['plugins']],
  'browser-control': [['browser'], ['capability', 'kiki-computer']],
  'computer-control': [['capability', 'kiki-computer']],
};

/**
 * Settings search field plus its hit list. Both the wide nav column and the
 * narrow-viewport header mount one, so search is never a desktop-only path.
 */
export function SettingsSearch({
  focusToken,
  onSearchHit,
  className = '',
  idle,
  navTree = SETTINGS_NAV_TREE,
}: {
  /** Changes on every Ctrl+, so a repeat press refocuses; null means no focus. */
  focusToken: string | null;
  onSearchHit: (entry: SettingsSearchEntry) => void;
  className?: string;
  /** Navigation shown while the field is empty; hits replace it while typing. */
  idle?: React.ReactNode;
  /** Navigation tree the breadcrumb group line follows. */
  navTree?: readonly SettingsNavNode[];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => {
    return buildSettingsSearchIndex(settingsSectionLabels(t), t, navTree);
  }, [t, navTree]);
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
        className="h-8 w-full rounded-md bg-ink/[0.04] px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.06] focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
      />
      {searching ? (
        <div className="mt-2 flex flex-col gap-0.5" role="listbox" aria-label={t('st.search.aria')}>
          {results.map((entry) => (
            <button
              key={entry.cardId}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => { onSearchHit(entry); setQuery(''); }}
              className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink/[0.04]"
            >
              <span className="block truncate text-[13px] text-ink">{entry.title}</span>
              <span className="block truncate text-[12px] leading-4 text-ink-faint">
                {entry.groupLabel !== '' ? <>{entry.groupLabel}<Icon name="chevron" size={12} className="mx-0.5 inline-block align-[-2px]" /></> : null}
                {entry.sectionLabel}
              </span>
            </button>
          ))}
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-ink-faint">{t('st.search.empty', { query: query.trim() })}</p>
          ) : null}
        </div>
      ) : (idle ?? null)}
    </div>
  );
}

/**
 * The settings navigation tree: one continuous list of non-clickable intent
 * groups with clickable leaves. Shared by the desktop rail and the mobile
 * drawer so both breakpoints present the same hierarchy.
 */
export function SettingsNavTree({
  active,
  activeTab,
  onNavigate,
  onAfterNavigate,
  tree = SETTINGS_NAV_TREE,
}: {
  /** Null on the unknown-section page: tree stays visible, nothing highlighted. */
  active: SectionId | null;
  activeTab?: string | null;
  onNavigate: (section: SectionId) => void;
  /** Drawer hosts pass a close hook; the desktop rail leaves it unset. */
  onAfterNavigate?: () => void;
  /** Navigation tree. */
  tree?: readonly SettingsNavNode[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const installed = useOptionalInstalledPlugins();
  const labelFor = (id: string) => SECTIONS.find((section) => section.id === id)?.labelKey;
  const activeCanonical = active !== null ? canonicalNavSection(active, activeTab) : null;

  const subscribeErrors = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(listener), [queryClient]);
  const readErrors = useCallback(() => Object.entries(LEAF_QUERY_PREFIXES).filter(([id, queryKeys]) => {
    const cached = queryKeys.flatMap((queryKey) => queryClient.getQueryCache().findAll({ queryKey }));
    return cached.some((query) => query.state.status === 'error' || (id === 'plugins' || id === 'extensions') &&
      (query.state.data as { plugins?: { state?: string; hasErrors?: boolean }[] } | undefined)?.plugins?.some(
        (plugin) => plugin.state === 'error' || plugin.hasErrors === true,
      ));
  }).map(([id]) => id).join('\0'), [queryClient]);
  const errorKeys = useSyncExternalStore(subscribeErrors, readErrors, readErrors);
  const errorLeaves = useMemo(() => new Set(errorKeys.split('\0')), [errorKeys]);

  const leafButton = (id: string) => {
    const labelKey = labelFor(id);
    if (labelKey === undefined) return null;
    const isPluginContainer = id === 'plugins' || id === 'extensions';
    const isCurrent = id === active || id === activeCanonical;
    // A plugin in an error state still belongs to the extensions leaf even
    // though the tree no longer lists installed plugins under it.
    const errored = errorLeaves.has(id) || isPluginContainer && installed.plugins.some((plugin) => plugin.state === 'error' || plugin.hasErrors);
    return (
      <button
        key={id}
        type="button"
        data-settings-nav-leaf={id}
        aria-current={isCurrent ? 'page' : undefined}
        onClick={() => { onNavigate(id as SectionId); onAfterNavigate?.(); }}
        className={`row-interactive flex h-8 items-center gap-2 px-3 text-left text-[13px] ${
          isCurrent ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
        {errored ? (
          <span aria-hidden data-settings-nav-error={id} className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
        ) : null}
      </button>
    );
  };

  // A page's tabs and an open plugin's page live inside the page itself; the
  // tree stays two levels: intent groups and the leaves a reader navigates to.
  const groups = tree.filter(
    (node): node is SettingsNavGroupSpec => node.kind === 'group' && node.sections.length > 0,
  );

  return (
    <div className="mt-4 flex flex-col gap-4" data-settings-nav-tree>
      {groups.map((node) => (
        <div key={node.id} data-settings-nav-group={node.id}>
          <p className="flex h-7 items-center px-2 text-[12px] font-medium text-section-ink">
            {t(node.labelKey)}
          </p>
          <div className="flex flex-col gap-0.5">
            {node.sections.map((id) => leafButton(id))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SettingsNav({
  active,
  activeTab,
  searchFocusToken,
  onNavigate,
  onSearchHit,
}: {
  active: SectionId | null;
  activeTab?: string | null;
  searchFocusToken: string | null;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('st.nav.browse')} className="flex h-full w-full flex-col overflow-y-auto overscroll-y-contain px-3 pb-4 pt-3 lg:w-[232px]">
      <SettingsSearch
        focusToken={searchFocusToken}
        onSearchHit={onSearchHit}
        navTree={SETTINGS_NAV_TREE}
        idle={<SettingsNavTree active={active} activeTab={activeTab} onNavigate={onNavigate} tree={SETTINGS_NAV_TREE} />}
      />
    </nav>
  );
}

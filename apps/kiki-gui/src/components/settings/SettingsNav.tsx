import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  PLUGIN_SETTINGS_QUERY_KEY,
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
import {
  iaPrototypeModeSnapshot,
  subscribeIaPrototypeMode,
  writeIaPrototypeMode,
} from '../../lib/settingsIaPrototype';
import { Icon } from '../icons';
import { useOptionalInstalledPlugins } from '../capabilities/usePlugins';
import { navTreeForMode, prototypeGroupForSection } from './navPrototype';
import { SECTIONS, type SectionId } from './sections';
import { SettingsSegmented } from './SettingsPrimitives';

const LEAF_QUERY_PREFIXES: Readonly<Record<string, readonly unknown[]>> = {
  ai: ['config'],
  workspaces: ['workspaces', 'catalog'],
  memory: ['memory-settings'],
  skills: ['workspace-skills'],
  mcp: ['mcp-managed-servers'],
  plugins: ['plugins'],
  'browser-control': ['browser'],
  'computer-control': ['capability', 'kiki-computer'],
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
  /** Candidate tree the breadcrumb group line follows (IA experiment). */
  navTree?: readonly SettingsNavNode[];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => {
    const base = buildSettingsSearchIndex(settingsSectionLabels(t), t, navTree);
    // A leaf the candidate tree re-homes (identity in `objects` mode) borrows
    // its host leaf's group, so the breadcrumb never loses a line.
    return base.map((entry) => {
      if (entry.groupLabel !== '') return entry;
      const group = prototypeGroupForSection(entry.section, navTree);
      return group === undefined ? entry : { ...entry, groupLabel: t(group.labelKey) };
    });
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
  activePluginId,
  onNavigate,
  onAfterNavigate,
  tree: treeProp,
}: {
  /** Null on the unknown-section page: tree stays visible, nothing highlighted. */
  active: SectionId | null;
  activeTab?: string | null;
  /**
   * The installed plugin whose own settings page is open, when one is. The
   * Plugins group expands to name it, so the reader can see where they are
   * without opening anything.
   */
  activePluginId?: string | null;
  onNavigate: (section: SectionId) => void;
  /** Drawer hosts pass a close hook; the desktop rail leaves it unset. */
  onAfterNavigate?: () => void;
  /** Candidate tree (IA experiment); unset means follow the prototype switch. */
  tree?: readonly SettingsNavNode[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const iaMode = useSyncExternalStore(subscribeIaPrototypeMode, iaPrototypeModeSnapshot, () => null);
  const tree = treeProp ?? navTreeForMode(iaMode);
  // The Plugins group lists what is installed, so the reader can jump straight
  // to one plugin's settings without going back through the list first. It
  // reads the query the list reads, so it costs nothing extra and never shows
  // a plugin the list would not.
  const installed = useOptionalInstalledPlugins();
  const plugins = installed.plugins;
  const labelFor = (id: string) => SECTIONS.find((section) => section.id === id)?.labelKey;
  const activeCanonical = active !== null ? canonicalNavSection(active, activeTab) : null;

  const subscribeErrors = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(listener), [queryClient]);
  const readErrors = useCallback(() => Object.entries(LEAF_QUERY_PREFIXES).filter(([id, queryKey]) => {
    const cached = queryClient.getQueryCache().findAll({ queryKey });
    return cached.some((query) => query.state.status === 'error' || id === 'plugins' &&
      (query.state.data as { plugins?: { state?: string; hasErrors?: boolean }[] } | undefined)?.plugins?.some(
        (plugin) => plugin.state === 'error' || plugin.hasErrors === true,
      ));
  }).map(([id]) => id).join('\0'), [queryClient]);
  const errorKeys = useSyncExternalStore(subscribeErrors, readErrors, readErrors);
  const errorLeaves = useMemo(() => new Set(errorKeys.split('\0')), [errorKeys]);

  const leafButton = (id: string) => {
    const labelKey = labelFor(id);
    if (labelKey === undefined) return null;
    const isCurrent = (id === active || id === activeCanonical) && !(id === 'plugins' && activePluginId !== null && activePluginId !== undefined);
    const errored = errorLeaves.has(id) || id === 'plugins' && plugins.some((plugin) => plugin.state === 'error' || plugin.hasErrors);
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

  const nbSearchSubtabs: readonly { tab: string; labelKey: I18nKey }[] = [
    { tab: 'overview', labelKey: 'st.nbSearch.tab.overview' },
    { tab: 'search', labelKey: 'st.nbSearch.tab.search' },
    { tab: 'fetch', labelKey: 'st.nbSearch.tab.fetch' },
    { tab: 'providers', labelKey: 'st.nbSearch.tab.providers' },
    { tab: 'advanced', labelKey: 'st.nbSearch.tab.advanced' },
  ];

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
            {node.sections.map((id) => (
              <div key={id} className="flex flex-col">
                {leafButton(id)}
                {id === 'search' && (active === 'search' || activeCanonical === 'search') ? (
                  <div className="mt-0.5 flex flex-col gap-0.5" data-settings-nav-subtabs="search">
                    {nbSearchSubtabs.map((sub) => (
                      <button
                        key={sub.tab}
                        type="button"
                        data-settings-nav-subtab={sub.tab}
                        onClick={() => {
                          onNavigate(`search?tab=${sub.tab}` as unknown as SectionId);
                          onAfterNavigate?.();
                        }}
                        className="row-interactive flex h-7 items-center pl-5 pr-2 text-left text-[12px] text-ink-soft hover:text-ink"
                      >
                        {t(sub.labelKey)}
                      </button>
                    ))}
                  </div>
                ) : null}
                {id === 'plugins' && (active === 'plugins' || activeCanonical === 'plugins') && plugins.length > 0 ? (
                  <div className="mt-0.5 flex flex-col gap-0.5" data-settings-nav-subtabs="plugins">
                    {plugins.map((plugin) => (
                      <button
                        key={plugin.id}
                        type="button"
                        data-settings-nav-plugin={plugin.id}
                        aria-current={activePluginId === plugin.id ? 'page' : undefined}
                        onClick={() => {
                          onNavigate(`plugins?${PLUGIN_SETTINGS_QUERY_KEY}=${encodeURIComponent(plugin.id)}` as unknown as SectionId);
                          onAfterNavigate?.();
                        }}
                        className={`row-interactive flex min-h-7 items-center gap-1.5 truncate py-1 pl-5 pr-2 text-left text-[12px] ${
                          activePluginId === plugin.id ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{plugin.displayName}</span>
                        {plugin.state === 'error' || plugin.hasErrors ? (
                          <span className="shrink-0 text-[11px] font-medium text-danger">{t('cap.state.error')}</span>
                        ) : plugin.enabled ? null : (
                          <span className="shrink-0 text-[11px] text-ink-faint">{t('cap.state.off')}</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
      {iaMode !== null ? (
        <div className="mt-2 border-t border-hairline pt-3" data-settings-ia-picker>
          <p className="px-2 pb-1.5 text-[12px] text-ink-faint">{t('st.ia.prototype')}</p>
          <div className="px-2">
            <SettingsSegmented<string>
              ariaLabel={t('st.ia.prototype')}
              dataAttr="data-ia-mode"
              value={iaMode}
              onChange={(next) => { writeIaPrototypeMode(next === 'current' ? null : next === 'objects' ? 'objects' : 'taskflow'); }}
              choices={[
                { value: 'current', label: t('st.ia.current') },
                { value: 'taskflow', label: t('st.ia.taskflow') },
                { value: 'objects', label: t('st.ia.objects') },
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsNav({
  active,
  activeTab,
  activePluginId,
  searchFocusToken,
  onNavigate,
  onSearchHit,
}: {
  active: SectionId | null;
  activeTab?: string | null;
  activePluginId?: string | null;
  searchFocusToken: string | null;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
}) {
  const { t } = useI18n();
  const iaMode = useSyncExternalStore(subscribeIaPrototypeMode, iaPrototypeModeSnapshot, () => null);
  const tree = navTreeForMode(iaMode);
  return (
    <nav aria-label={t('st.nav.browse')} className="flex h-full w-full flex-col overflow-y-auto overscroll-y-contain px-3 pb-4 pt-3 lg:w-[232px]">
      <SettingsSearch
        focusToken={searchFocusToken}
        onSearchHit={onSearchHit}
        navTree={tree}
        idle={<SettingsNavTree active={active} activeTab={activeTab} activePluginId={activePluginId} onNavigate={onNavigate} tree={tree} />}
      />
    </nav>
  );
}

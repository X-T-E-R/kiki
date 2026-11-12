import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  SETTINGS_NAV_TREE,
  buildSettingsSearchIndex,
  canonicalNavSection,
  isDecisionConnection,
  pluginSettingsPath,
  searchSettings,
  settingsSectionLabels,
  type SettingsNavGroupSpec,
  type SettingsNavNode,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import type { PluginSummary } from '../../lib/client';
import { useOptionalConnection } from '../../state/connection';
import { Icon } from '../icons';
import { PLUGIN_QUERY_KEYS } from '../capabilities/usePlugins';
import { isLocalBaseUrl } from '../providerPresets';
import { SECTIONS, type SectionId } from './sections';
import { isImeKeyEvent } from '../../lib/shortcuts';
import { useCoarsePointer } from '../../lib/layoutHooks';

/**
 * Keyboard shortcuts only record key presses, so touch neither lists the
 * section nor finds it in search. `/settings/shortcuts` still opens it, for a
 * tablet with a keyboard attached.
 */
function listedOnTouch(section: string): boolean {
  return section !== 'shortcuts';
}

/** One thing in settings that needs the reader: which object, what is wrong, where it is fixed. */
export interface SettingsAttentionItem {
  readonly key: string;
  /** The leaf that owns the object. */
  readonly section: 'ai' | 'extensions';
  /** The object's own name, as its row shows it. */
  readonly object: string;
  /** The state word (glossary "State words"), never a bare colour. */
  readonly problemKey: I18nKey;
  /** Address under `/settings/` that opens the object's own card or page. */
  readonly target: string;
}

/**
 * How long the settings index reuses what it last read. Opening the index
 * reads the two lists once when they are older than this and otherwise uses
 * the cache; nothing polls, and nothing reads again while the index stays open.
 */
const ATTENTION_STALE_MS = 60_000;

/** The word for a model connection that cannot answer, or null when it can. */
function connectionProblem(provider: ProviderCatalogItem): I18nKey | null {
  // Decision services carry no chat model and a turned-off connection is not
  // used, so neither is a problem a new conversation would run into.
  if (isDecisionConnection(provider) || provider.enabled === false) return null;
  if (provider.status === 'error') return 'st.connections.statusError';
  if (provider.status !== 'unconfigured') return null;
  if (provider.oauth !== undefined) return 'st.account.state.signIn';
  const needsKey = !provider.has_api_key && provider.api_key_env === undefined && !isLocalBaseUrl(provider.base_url);
  return needsKey ? 'st.connections.statusNeedsKey' : 'st.connections.statusSetup';
}

function pluginBroken(plugin: PluginSummary): boolean {
  return plugin.state === 'error' || plugin.hasErrors;
}

/**
 * What needs attention across settings, from the two reads that can say so:
 * the model connections and the installed plugins' status (design §2.1.1).
 *
 * Read once when the navigation opens (from cache when it is fresh), never
 * polled. A list that has not arrived yet, or whose read failed, contributes
 * nothing: what is not known is not shown, and a read that failed is not a
 * problem with any object, so it never marks a leaf either.
 */
export function useSettingsAttention(): readonly SettingsAttentionItem[] {
  const client = useOptionalConnection()?.client;
  const enabled = client !== undefined;
  const reads = { enabled, staleTime: ATTENTION_STALE_MS, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => client!.listProviders(), ...reads });
  const plugins = useQuery({ queryKey: PLUGIN_QUERY_KEYS.installed, queryFn: () => client!.listPlugins(), ...reads });
  const providerItems = providers.status === 'success' ? providers.data.items : undefined;
  const pluginItems = plugins.status === 'success' ? plugins.data.plugins : undefined;
  return useMemo(() => [
    ...(providerItems ?? []).flatMap((provider): SettingsAttentionItem[] => {
      const problemKey = connectionProblem(provider);
      return problemKey === null ? [] : [{
        key: `connection:${provider.id}`, section: 'ai', object: provider.id, problemKey,
        target: 'ai?tab=providers#st-card-providers',
      }];
    }),
    ...(pluginItems ?? []).filter(pluginBroken).map((plugin): SettingsAttentionItem => ({
      key: `plugin:${plugin.id}`, section: 'extensions', object: plugin.displayName, problemKey: 'st.plugins.error',
      target: pluginSettingsPath(plugin.id).replace(/^\/settings\//u, ''),
    })),
  ], [providerItems, pluginItems]);
}

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
  onDismiss,
  floatingResults = false,
}: {
  /** Changes on every Ctrl+, so a repeat press refocuses; null means no focus. */
  focusToken: string | null;
  onSearchHit: (entry: SettingsSearchEntry) => void;
  className?: string;
  /** Navigation shown while the field is empty; hits replace it while typing. */
  idle?: React.ReactNode;
  /** Navigation tree the breadcrumb group line follows. */
  navTree?: readonly SettingsNavNode[];
  /** Escape in the field also closes whatever opened it (the phone header). */
  onDismiss?: () => void;
  /**
   * Hits drop down over the page from the field's positioned ancestor instead
   * of pushing content below the field: the field sits in a header row.
   */
  floatingResults?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const coarsePointer = useCoarsePointer();
  const index = useMemo(() => {
    const entries = buildSettingsSearchIndex(settingsSectionLabels(t), t, navTree);
    return coarsePointer ? entries.filter((entry) => listedOnTouch(entry.section)) : entries;
  }, [t, navTree, coarsePointer]);
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
          if (isImeKeyEvent(event)) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            setQuery('');
            event.currentTarget.blur();
            onDismiss?.();
          } else if (event.key === 'Enter' && results.length > 0) {
            event.preventDefault();
            onSearchHit(results[0]!);
            setQuery('');
          }
        }}
        className="h-8 w-full rounded-md bg-ink/[0.04] px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-ink/[0.06] focus:bg-panel focus:shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]"
      />
      {searching ? (
        <div role="listbox" aria-label={t('st.search.aria')} data-settings-search-results
          className={floatingResults
            ? 'absolute inset-x-0 top-full z-20 flex max-h-[min(60vh,28rem)] flex-col gap-0.5 overflow-y-auto overscroll-y-contain border-b border-hairline bg-canvas px-3 py-2 shadow-[var(--kiki-sheet-shadow)]'
            : 'mt-2 flex flex-col gap-0.5'}>
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
 * groups with clickable leaves. Shared by the desktop rail and the narrow
 * settings list (`/settings` below lg) so both breakpoints present the same
 * hierarchy.
 */
export function SettingsNavTree({
  active,
  activeTab,
  onNavigate,
  onAfterNavigate,
  tree = SETTINGS_NAV_TREE,
  showAttention = false,
}: {
  /** Null on the unknown-section page: tree stays visible, nothing highlighted. */
  active: SectionId | null;
  activeTab?: string | null;
  /** A leaf id, or an address under `/settings/` (an attention row's card). */
  onNavigate: (section: SectionId) => void;
  /** Drawer hosts pass a close hook; the desktop rail leaves it unset. */
  onAfterNavigate?: () => void;
  /** Navigation tree. */
  tree?: readonly SettingsNavNode[];
  /**
   * The phone index: a "Needs attention" group at the top lists each problem
   * (which object, what is wrong) and opens its card. The desktop rail marks
   * the leaves only.
   */
  showAttention?: boolean;
}) {
  const { t } = useI18n();
  const coarsePointer = useCoarsePointer();
  const attention = useSettingsAttention();
  const labelFor = (id: string) => SECTIONS.find((section) => section.id === id)?.labelKey;
  const activeCanonical = active !== null ? canonicalNavSection(active, activeTab) : null;
  const attentionLeaves = useMemo(() => new Set<string>(attention.map((item) => item.section)), [attention]);

  const leafButton = (id: string) => {
    const labelKey = labelFor(id);
    if (labelKey === undefined) return null;
    // The page itself stays current in the tree when opened by address.
    if (coarsePointer && !listedOnTouch(id) && id !== active) return null;
    const isCurrent = id === active || id === activeCanonical;
    return (
      <button
        key={id}
        type="button"
        data-settings-nav-leaf={id}
        aria-current={isCurrent ? 'page' : undefined}
        onClick={() => { onNavigate(id as SectionId); onAfterNavigate?.(); }}
        className={`row-interactive flex h-8 items-center gap-2 px-3 text-left text-[13px] pointer-coarse:h-11 pointer-coarse:text-[15px] ${
          isCurrent ? 'font-medium text-ink' : 'text-ink-soft hover:text-ink'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
        {/* A word, not a dot: the state reads without colour (rule 4). */}
        {attentionLeaves.has(id) ? (
          <span data-settings-nav-attention={id} className="shrink-0 text-[12px] font-normal text-attention">
            {t('st.nav.leafAttention')}
          </span>
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
      {showAttention && attention.length > 0 ? (
        <div data-settings-attention>
          <p className="flex h-7 items-center px-2 text-[12px] font-medium text-attention">
            {t('st.nav.needsAttention')}
          </p>
          <div className="flex flex-col gap-0.5">
            {attention.map((item) => {
              const sectionKey = labelFor(item.section);
              return (
                <button
                  key={item.key}
                  type="button"
                  data-settings-attention-row={item.key}
                  onClick={() => { onNavigate(item.target); onAfterNavigate?.(); }}
                  className="row-interactive flex h-8 items-center gap-2 px-3 text-left text-[13px] text-ink pointer-coarse:h-11 pointer-coarse:text-[15px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t('st.nav.attentionRow', {
                      section: sectionKey === undefined ? item.section : t(sectionKey),
                      object: item.object,
                      problem: t(item.problemKey),
                    })}
                  </span>
                  <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
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
  showAttention = false,
}: {
  active: SectionId | null;
  activeTab?: string | null;
  searchFocusToken: string | null;
  onNavigate: (section: SectionId) => void;
  onSearchHit: (entry: SettingsSearchEntry) => void;
  /** The phone index lists what needs attention above the groups. */
  showAttention?: boolean;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t('st.nav.browse')} className="flex h-full w-full flex-col overflow-y-auto overscroll-y-contain px-3 pb-4 pt-3 lg:w-[232px]">
      <SettingsSearch
        focusToken={searchFocusToken}
        onSearchHit={onSearchHit}
        navTree={SETTINGS_NAV_TREE}
        idle={<SettingsNavTree active={active} activeTab={activeTab} onNavigate={onNavigate} tree={SETTINGS_NAV_TREE} showAttention={showAttention} />}
      />
    </nav>
  );
}

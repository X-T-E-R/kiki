import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  SETTINGS_SECTION_META,
  resolveSettingsRoute,
  settingsGroupForSection,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { AboutSection } from './settings/AboutSection';
import { AdvancedSection } from './settings/AdvancedSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { Icon } from './icons';
import { AgentsSection } from './settings/AgentsSection';
import { AiSection } from './settings/AiSection';
import { AutomationSection } from './settings/AutomationSection';
import { CommunicationSection } from './settings/CommunicationSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { GeneralSection } from './settings/GeneralSection';
import { McpSection } from './settings/McpSection';
import { NbSearchSection } from './settings/NbSearchSection';
import { PluginsSection } from './settings/PluginsSection';
import { SECTIONS, type SectionId } from './settings/sections';
import { ScopeTag, SettingsFlashContext, SettingsPageScopeContext } from './settings/SectionCard';
import { SettingsNav, SettingsNavTree, SettingsSearch } from './settings/SettingsNav';
import { SkillsSection } from './settings/SkillsSection';
import { SubagentsSection } from './settings/SubagentsSection';
import { UnifiedAgentManager } from './settings/UnifiedAgentManager';
import { TasksSection } from './settings/TasksSection';
import { UnknownSettingsSection } from './settings/UnknownSection';
import { SettingsWorkspaceScopeContext } from './settings/workspaceScope';
import { WorkspacesSection } from './settings/WorkspacesSection';

export { mcpConfigFromDraft, parseNamedAgentTools } from '@kiki/session-core/settings';

/**
 * One line on what the leaf is for and its default write target. The leaf's
 * name lives in the page header (T2), so the content pane opens with prose,
 * and the T1 section titles below are its only headings.
 */
function SectionIntro({ section }: { section: SectionId }) {
  const { t } = useI18n();
  const meta = SETTINGS_SECTION_META[section];
  if (meta === undefined) return null;
  const scope = meta.scopes[0];
  return <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-6">
    <p data-settings-intro className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t(meta.purposeKey)}</p>
    {scope !== undefined ? <ScopeTag scope={scope} page /> : null}
  </div>;
}

/**
 * Narrow-viewport navigation: the old flat <select> could not express the
 * group hierarchy, so the current location is a button that opens a drawer
 * holding the same grouped tree the desktop rail shows.
 */
function MobileSettingsDrawer({
  active,
  open,
  onClose,
  onNavigate,
}: {
  active: SectionId;
  open: boolean;
  onClose: () => void;
  onNavigate: (section: SectionId) => void;
}) {
  const { t } = useI18n();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t('st.nav.browse')}>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="absolute inset-0 bg-shell/20"
      />
      <div className="absolute inset-y-0 left-0 flex w-[280px] flex-col overflow-y-auto overscroll-y-contain bg-canvas p-3 shadow-[var(--kiki-sheet-shadow)]">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="font-display text-[15px] font-semibold text-ink">{t('st.title')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <SettingsNavTree active={active} onNavigate={onNavigate} onAfterNavigate={onClose} />
      </div>
    </div>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const rawNavigate = useNavigate();
  const dirty = useDirtyGuard()?.dirty === true;
  const [focusCard, setFocusCard] = useState<{ cardId: string; nonce: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `/settings/<section>#st-card-…` focuses one card, so callers elsewhere in
  // the app (the /new readiness card) can point at the exact control instead
  // of dropping the user at the top of a long section.
  const { hash, search, state, key } = useLocation();
  const resolution = resolveSettingsRoute(section, hash);
  const active: SectionId | null =
    resolution.status === 'ok' ? (resolution.section as SectionId) : null;
  // Workspace-scoped sections (Skills' catalog, MCP's config card) report
  // the workspace their edits target; the scope header names it. Reset on
  // page change — the next section reports its own selection.
  const [workspaceScopeName, setWorkspaceScopeName] = useState<string | null>(null);
  useEffect(() => { setWorkspaceScopeName(null); }, [active]);

  // Canonicalize legacy / card-moved targets in place: replace, never push,
  // and bypass the dirty guard — this is a redirect, not a user navigation.
  // A resolved tab (legacy `/settings/models` → `ai?tab=models`) is merged
  // into the existing query so server/token deep-link params survive. A
  // legacy card hash (`#st-card-sidecar`) is rewritten to its canonical card
  // so the scroll + flash lands on the renamed target.
  useEffect(() => {
    if (resolution.status !== 'ok') return;
    const params = new URLSearchParams(search);
    const sectionMoved = resolution.section !== section
      && !(section === undefined && resolution.section === 'general');
    const tabMoved = resolution.tab !== undefined && params.get('tab') !== resolution.tab;
    const targetHash = resolution.cardId !== undefined ? `#${resolution.cardId}` : hash;
    const cardMoved = targetHash !== hash;
    if (!sectionMoved && !tabMoved && !cardMoved) return;
    if (resolution.tab !== undefined) params.set('tab', resolution.tab);
    const query = params.toString();
    void rawNavigate(`/settings/${resolution.section}${query === '' ? '' : `?${query}`}${targetHash}`, { replace: true });
  }, [resolution, section, search, hash, rawNavigate]);

  // Ctrl+, arrives with this flag; clicking Settings in the sidebar does not,
  // so an ordinary visit still leaves focus where the user put it. The location
  // key changes on every press, so Ctrl+, from inside settings refocuses too.
  const searchFocusToken =
    (state as { focusSearch?: boolean } | null)?.focusSearch === true ? key : null;
  useEffect(() => {
    const cardId = hash.replace(/^#/, '');
    if (!cardId.startsWith('st-card-')) return;
    setFocusCard({ cardId, nonce: Date.now() });
  }, [hash]);

  // Scroll + flash the card a search hit pointed at, then disarm.
  useEffect(() => {
    if (focusCard === null) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector(`#${CSS.escape(focusCard.cardId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const timer = setTimeout(() => { setFocusCard(null); }, 2000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [focusCard]);

  // A dirty providers editor also guards closing the app itself.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => { window.removeEventListener('beforeunload', handler); };
  }, [dirty]);

  const guardedNavigate = useCallback((target: string) => {
    navigate(`/settings/${target}`);
  }, [navigate]);

  const onSearchHit = (entry: SettingsSearchEntry) => {
    setFocusCard({ cardId: entry.cardId, nonce: Date.now() });
    setDrawerOpen(false);
    // Tabbed sections (the merged ai entry) need the tab in the target so the
    // hit's card is actually mounted when the flash scroll runs.
    const target = entry.tab === undefined ? entry.section : `${entry.section}?tab=${entry.tab}`;
    if (entry.section !== active || entry.tab !== undefined) guardedNavigate(target);
  };

  const activeGroup = active === null ? undefined : settingsGroupForSection(active);
  const activeLabelKey = active === null ? undefined : SECTIONS.find((candidate) => candidate.id === active)?.labelKey;

  const pane = active === null ? null
    : active === 'general' ? <GeneralSection />
    : active === 'appearance' ? <AppearanceSection />
    : active === 'ai' ? <AiSection />
    : active === 'connection' ? <ConnectionSection />
    : active === 'agents' ? <><UnifiedAgentManager /><AgentsSection /></>
    : active === 'subagents' ? <SubagentsSection />
    : active === 'communication' ? <CommunicationSection />
    : active === 'skills' ? <SkillsSection />
    : active === 'mcp' ? <McpSection />
    : active === 'plugins' ? <PluginsSection />
    : active === 'automation' ? <AutomationSection />
    : active === 'tasks' ? <TasksSection />
    : active === 'search' ? <NbSearchSection />
    : active === 'workspaces' ? <WorkspacesSection />
    : active === 'advanced' ? <AdvancedSection />
    : <AboutSection />;

  const activeLabel = activeLabelKey === undefined ? undefined : t(activeLabelKey);

  return (
    <SettingsFlashContext.Provider value={focusCard?.cardId ?? null}>
    <SettingsWorkspaceScopeContext.Provider value={setWorkspaceScopeName}>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-6">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink md:hidden">
          <Icon name="menu" size={16} />
        </button>
        {/* The page title is the leaf; "Settings" is the breadcrumb above it. */}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          <span className={activeLabel === undefined ? '' : 'font-normal text-ink-faint'}>{t('st.title')}</span>
          {activeLabel !== undefined ? <><span aria-hidden className="font-normal text-ink-faint">/</span><span data-settings-page-title className="truncate">{activeLabel}</span></> : null}
        </h1>
      </header>
      <main className="flex min-h-0 flex-1 border-t border-hairline">
        <div className="hidden shrink-0 border-r border-hairline lg:block"><SettingsNav active={active} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={onSearchHit} /></div>
        <div className="flex min-w-0 flex-1 flex-col">
          {active !== null ? (
            <div className="border-b border-hairline px-4 py-2 lg:hidden">
              <SettingsSearch
                focusToken={searchFocusToken}
                onSearchHit={onSearchHit}
                idle={
                  <button
                    type="button"
                    data-settings-nav-trigger
                    onClick={() => { setDrawerOpen(true); }}
                    className="mt-2 flex h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.04]"
                  >
                    <span className="min-w-0 truncate">
                      {activeGroup !== undefined ? (
                        <span className="text-ink-faint">{t(activeGroup.labelKey)}<span aria-hidden> / </span></span>
                      ) : null}
                      <span>{activeLabel ?? active}</span>
                    </span>
                    <Icon name="chevron" size={12} className="rotate-90 text-ink-faint" />
                  </button>
                }
              />
              <MobileSettingsDrawer
                active={active}
                open={drawerOpen}
                onClose={() => { setDrawerOpen(false); }}
                onNavigate={guardedNavigate}
              />
            </div>
          ) : null}
          {active === null ? (
            <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto">
              <UnknownSettingsSection section={section ?? ''} onSearchHit={onSearchHit} />
            </div>
          ) : (
            <div data-settings-scroll className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-6 lg:px-10 lg:pt-8">
              <div className="mx-auto max-w-[720px]">
                <SectionIntro section={active} />
                {workspaceScopeName !== null ? <span className="sr-only">{t('st.scope.workspace')} {workspaceScopeName}</span> : null}
                <SettingsPageScopeContext.Provider value={SETTINGS_SECTION_META[active]?.scopes[0] ?? null}>
                  <div className="space-y-6">{pane}</div>
                </SettingsPageScopeContext.Provider>
              </div>
            </div>
          )}
        </div>
      </main>
    </SettingsWorkspaceScopeContext.Provider>
    </SettingsFlashContext.Provider>
  );
}

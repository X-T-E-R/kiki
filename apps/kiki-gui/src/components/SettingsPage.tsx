import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  AI_SETTINGS_DEFAULT_TAB,
  SETTINGS_SECTION_META,
  experimentalTabForSection,
  resolveSettingsRoute,
  settingsGroupForSection,
  settingsSectionIsDeviceOnly,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { AboutSection } from './settings/AboutSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { Icon } from './icons';
import { AgentsSection } from './settings/AgentsSection';
import { AiSection } from './settings/AiSection';
import { HooksSection } from './settings/AutomationSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DeveloperSection } from './settings/DeveloperSection';
import { ExperimentalRows } from './settings/ExperimentalRows';
import { GeneralSection } from './settings/GeneralSection';
import { LabsSection } from './settings/LabsSection';
import { McpSection } from './settings/McpSection';
import { MemorySection } from './settings/MemorySection';
import { NbSearchSection } from './settings/NbSearchSection';
import { IdentitySection } from './settings/IdentitySection';
import { NotificationsSection } from './settings/NotificationsSection';
import { PermissionsSection } from './settings/PermissionsSection';
import { PluginsSection } from './settings/PluginsSection';
import { SECTIONS, type SectionId } from './settings/sections';
import { SettingsFlashContext, SettingsPageScopeContext } from './settings/SectionCard';
import { SessionsSection } from './settings/SessionsSection';
import { SettingsNav, SettingsNavTree, SettingsSearch } from './settings/SettingsNav';
import { SkillsSection } from './settings/SkillsSection';
import { SpacesSection } from './settings/SpacesSection';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { currentSpace } from '../lib/spaces';
import { SubagentsSection } from './settings/SubagentsSection';
import { UnifiedAgentManager } from './settings/UnifiedAgentManager';
import { TasksSection } from './settings/TasksSection';
import { UnknownSettingsSection } from './settings/UnknownSection';
import { SettingsWorkspaceScopeContext } from './settings/workspaceScope';
import { WorkspacesSection } from './settings/WorkspacesSection';
import { SshSection } from './ssh/SshSection';

export { mcpConfigFromDraft, parseNamedAgentTools } from '@kiki/session-core/settings';

/**
 * Address of the connected server, only when it is somewhere else. The
 * built-in server on this machine (loopback, or the origin serving this
 * page) returns null: its port means nothing to a person, so the settings
 * never print it. An SSH scope or another host returns its label.
 */
function useRemoteServerAddress(): string | null {
  const { config, sshLabel } = useConnection();
  if (sshLabel !== null) return sshLabel;
  const url = config.url.trim();
  if (url === '') return null;
  try {
    const parsed = new URL(url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
    if (loopback || parsed.host === window.location.host) return null;
    return parsed.host;
  } catch {
    return url;
  }
}

/**
 * Page intro: what the leaf is for, when a card title does not already say
 * it, then a quiet status line that only appears when there is something to
 * say: a remote server (named in the hover title; the local one is never
 * mentioned), the workspace a picker targets, or unsaved changes, so a draft
 * deep in a long page is never invisible.
 */
function SectionIntro({ section, workspaceName, remoteAddress, dirty }: {
  section: SectionId;
  workspaceName: string | null;
  remoteAddress: string | null;
  dirty: boolean;
}) {
  const { t } = useI18n();
  const meta = SETTINGS_SECTION_META[section];
  if (meta === undefined) return null;
  // Device pages (General, Appearance, Connection) never write to the server.
  const remote = remoteAddress !== null && !settingsSectionIsDeviceOnly(section);
  const status = remote || workspaceName !== null || dirty;
  if (meta.purposeKey === undefined && !status) return null;
  return <div className="space-y-2 pb-6">
    {meta.purposeKey !== undefined ? <p data-settings-intro className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t(meta.purposeKey)}</p> : null}
    {status ? <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint" data-settings-page-status>
      {remote ? (
        <span data-settings-remote-line title={t('st.storage.remoteTitle', { address: remoteAddress })}>
          {t('st.storage.pageServerRemote')}
        </span>
      ) : null}
      {workspaceName !== null ? <span data-settings-storage-workspace>{remote ? '· ' : ''}{t('st.storage.workspace', { name: workspaceName })}</span> : null}
      {dirty ? (
        <span role="status" data-settings-unsaved className="inline-flex items-center gap-1.5 font-medium text-accent-ink">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          {t('st.storage.unsaved')}
        </span>
      ) : null}
    </p> : null}
  </div>;
}

/**
 * §6.4: inside an independent space every settings page opens with one thin
 * line in the space's color, so an edit is never made in the wrong space.
 * The main space shows nothing new.
 */
function SpaceBand() {
  const { t } = useI18n();
  const space = currentSpace();
  if (space === null) return null;
  const name = space.name ?? space.homeId;
  return (
    <p data-settings-space-band className="mb-5 flex items-center gap-2 border-l-2 py-0.5 pl-2.5 text-[12px] text-ink-soft"
      style={{ borderColor: space.color ?? 'var(--color-hairline-strong)' }}>
      <SpaceDot color={space.color} size={7} />
      <span className="min-w-0 truncate">{t('st.spaces.band', { name })}</span>
    </p>
  );
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
  const remoteAddress = useRemoteServerAddress();
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
    : active === 'connection' ? <ConnectionSection />
    : active === 'ai' ? <AiSection />
    : active === 'identity' ? <IdentitySection />
    : active === 'agents' ? <><UnifiedAgentManager /><AgentsSection /></>
    : active === 'subagents' ? <SubagentsSection />
    : active === 'sessions' ? <SessionsSection />
    : active === 'notifications' ? <NotificationsSection />
    : active === 'memory' ? <MemorySection />
    : active === 'permissions' ? <PermissionsSection />
    : active === 'tasks' ? <TasksSection />
    : active === 'skills' ? <SkillsSection />
    : active === 'mcp' ? <McpSection />
    : active === 'plugins' ? <PluginsSection />
    : active === 'search' ? <NbSearchSection />
    : active === 'hooks' ? <HooksSection />
    : active === 'spaces' ? <SpacesSection />
    : active === 'workspaces' ? <WorkspacesSection />
    : active === 'ssh' ? <SshSection />
    : active === 'developer' ? <DeveloperSection />
    : active === 'labs' ? <LabsSection />
    : <AboutSection />;

  // A feature page ends with the experimental flags that change it; tabbed
  // pages show them on one tab only, so a hit on the rows lands where they are.
  const experimentalTab = active === null ? undefined : experimentalTabForSection(active);
  const currentTab = new URLSearchParams(search).get('tab')
    ?? (active === 'ai' ? AI_SETTINGS_DEFAULT_TAB : active === 'search' ? 'overview' : null);
  const showExperimental = active !== null && active !== 'labs'
    && (experimentalTab === undefined || currentTab === experimentalTab);

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
                <SpaceBand />
                <SectionIntro section={active} workspaceName={workspaceScopeName} remoteAddress={remoteAddress} dirty={dirty} />
                <SettingsPageScopeContext.Provider value={settingsSectionIsDeviceOnly(active) ? 'app' : 'server'}>
                  <div className="space-y-6">{pane}{showExperimental ? <ExperimentalRows section={active} /> : null}</div>
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

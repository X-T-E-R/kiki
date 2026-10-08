import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  AI_SETTINGS_DEFAULT_TAB,
  SETTINGS_SECTION_META,
  experimentalTabForSection,
  pluginSettingsIdFromQuery,
  resolveSettingsRoute,
  settingsGroupForSection,
  settingsSectionIsDeviceOnly,
  settingsSectionSupportsSpace,
  workspaceSettingsIdFromQuery,
  type SettingsSearchEntry,
} from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { prefersReducedMotion } from '../lib/motion';
import { useConnection } from '../state/connection';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { AboutSection } from './settings/AboutSection';
import { DesktopLogCard } from './settings/DesktopLogCard';
import { AppearanceSection } from './settings/AppearanceSection';
import { Icon } from './icons';
import { AgentsSection } from './settings/AgentsSection';
import { AiSection } from './settings/AiSection';
import { HooksSection } from './settings/hooks/HooksSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DeveloperSection } from './settings/DeveloperSection';
import { ExperimentalRows } from './settings/ExperimentalRows';
import { ExternalClientsSection } from './settings/ExternalClientsSection';
import { GeneralSection } from './settings/GeneralSection';
import { LabsSection } from './settings/LabsSection';
import { McpSection } from './settings/McpSection';
import { MemorySection } from './settings/MemorySection';
import { NbSearchSection } from './settings/NbSearchSection';
import { IdentitySection } from './settings/IdentitySection';
import { NotificationsSection } from './settings/NotificationsSection';
import { PermissionsSection } from './settings/PermissionsSection';
import { PluginsSection } from './settings/PluginsSection';
import { BrowserControlSection } from './settings/BrowserControlSection';
import { ComputerControlSection } from './settings/ComputerControlSection';
import { SECTIONS, type SectionId } from './settings/sections';
import { SettingsCardMountContext, SettingsFlashContext, SettingsPageScopeContext } from './settings/SectionCard';
import { SessionsSection } from './settings/SessionsSection';
import { SessionsImportPage } from './settings/SessionsImportPage';
import { ShortcutsSection } from './settings/ShortcutsSection';
import { SettingsNav, SettingsNavTree, SettingsSearch } from './settings/SettingsNav';
import { SkillsSection } from './settings/SkillsSection';
import { SpacesSection } from './settings/SpacesSection';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { currentSpace } from '../lib/spaces';
import { spaceSettingsTargetIsSpace, spaceSettingsTargetOf } from '../lib/spaceSettings';
import { SubagentsSection } from './settings/SubagentsSection';
import { UnifiedAgentManager } from './settings/UnifiedAgentManager';
import { TasksSection } from './settings/TasksSection';
import { UnknownSettingsSection } from './settings/UnknownSection';
import { SettingsWorkspaceScopeContext, WorkspaceDetailNameContext } from './settings/workspaceScope';
import { WorkspacesSection } from './settings/WorkspacesSection';
import { SshSection } from './ssh/SshSection';
import { NavBackButton } from './NavBackButton';
import { getCurrentVisit, getUiSnapshot, saveScrollPosition, saveUiSnapshot } from '../lib/navHistory';

export { mcpConfigFromDraft, parseNamedAgentTools } from '@kiki/session-core/settings';

/** Keys that move the pane by themselves — the ones that mean "I am scrolling". */
const SCROLL_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

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
function SectionIntro({ section, workspaceName, remoteAddress, dirty, hidePurpose }: {
  section: SectionId;
  workspaceName: string | null;
  remoteAddress: string | null;
  dirty: boolean;
  /** A sub-page that answers its own question, which the section line would
   *  contradict rather than introduce (a single plugin's own settings). */
  hidePurpose?: boolean;
}) {
  const { t } = useI18n();
  const meta = SETTINGS_SECTION_META[section];
  if (meta === undefined) return null;
  // Hiding a redundant orientation line is not hiding the status. Where a
  // change is written, and whether one is unsaved, are facts the reader needs on
  // every page that can hold a draft — including a plugin's own page, which is
  // exactly where an unsaved draft is easiest to lose.
  const purposeKey = hidePurpose === true ? undefined : meta.purposeKey;
  // Device pages (General, Appearance, Connection) never write to the server.
  const remote = remoteAddress !== null && !settingsSectionIsDeviceOnly(section);
  const status = remote || workspaceName !== null || dirty;
  if (purposeKey === undefined && !status) return null;
  return <div className="space-y-2 pb-6">
    {purposeKey !== undefined ? <p data-settings-intro className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t(purposeKey)}</p> : null}
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
    <p data-settings-space-band className="mb-5 flex items-center gap-2 border-l-2 py-0.5 pl-3 text-[12px] text-ink-soft"
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
  activePluginId,
  open,
  onClose,
  onNavigate,
}: {
  active: SectionId;
  activePluginId: string | null;
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
        <SettingsNavTree active={active} activePluginId={activePluginId} onNavigate={onNavigate} onAfterNavigate={onClose} />
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
  const { client, meta } = useConnection();
  const inSpace = spaceSettingsTargetIsSpace(spaceSettingsTargetOf(client, meta));
  const [cardRequest, setCardRequest] = useState<{ cardId: string; section: string; locationKey: string; nonce: number } | null>(null);
  const [flashCard, setFlashCard] = useState<{ cardId: string; nonce: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `/settings/<section>#st-card-…` focuses one card, so callers elsewhere in
  // the app (the /new readiness card) can point at the exact control instead
  // of dropping the user at the top of a long section.
  const { hash, search, state, key } = useLocation();
  const resolution = resolveSettingsRoute(section, hash);
  const active: SectionId | null =
    resolution.status === 'ok' ? (resolution.section as SectionId) : null;
  const pageScope = active === null ? 'server'
    : settingsSectionSupportsSpace(active) && inSpace ? 'space'
    : settingsSectionIsDeviceOnly(active) ? 'app'
    : 'server';
  // Workspace-scoped sections (Skills' catalog, MCP's config card) report
  // the workspace their edits target; the scope header names it. Reset on
  // page change — the next section reports its own selection.
  const [workspaceScopeName, setWorkspaceScopeName] = useState<string | null>(null);
  // One workspace's own page names itself in the breadcrumb. Set by the page
  // itself (the same handshake the scope header already uses) rather than
  // resolved here, so the header and the breadcrumb cannot disagree.
  const [workspaceDetailName, setWorkspaceDetailName] = useState<string | null>(null);
  useEffect(() => { setWorkspaceScopeName(null); }, [active]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // App commits the target visit in its layout transition, before this effect.
  // The shared section container must also reset for a newly pushed visit.
  useEffect(() => {
    const visit = getCurrentVisit();
    if (!visit || !scrollRef.current) return;
    const saved = getUiSnapshot<{ scrollTop?: number }>(visit.visitId);
    const container = scrollRef.current;
    container.scrollTop = saved?.scrollTop ?? 0;
    const handleScroll = () => {
      saveUiSnapshot(visit.visitId, { scrollTop: container.scrollTop });
      saveScrollPosition(visit.visitId, '[data-settings-scroll]', container.scrollTop);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => { container.removeEventListener('scroll', handleScroll); };
  }, [active, key]);

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

  // Import history is a built-in session surface with exactly one address. The
  // redirect that carries an old `/capabilities?view=import` bookmark here
  // lives on the Capabilities page, because that is the address being changed;
  // this page needs no effect of its own, and one that navigated to the address
  // it was already on would only churn the location key.

  // Ctrl+, arrives with this flag; clicking Settings in the sidebar does not,
  // so an ordinary visit still leaves focus where the user put it. The location
  // key changes on every press, so Ctrl+, from inside settings refocuses too.
  const searchFocusToken =
    (state as { focusSearch?: boolean } | null)?.focusSearch === true ? key : null;
  useEffect(() => {
    const cardId = hash.replace(/^#/, '');
    if (!cardId.startsWith('st-card-')) return;
    // A visit that already holds the reader's own scroll position restores it
    // (`scrollRef` above), so the hash it was left with does not pull the pane
    // again when the reader comes back: the snapshot outranks the older target.
    const visit = getCurrentVisit();
    if (visit !== null && getUiSnapshot<{ scrollTop?: number }>(visit.visitId)?.scrollTop !== undefined) return;
    setCardRequest({ cardId, section: resolution.section, locationKey: key, nonce: Date.now() });
  }, [hash, resolution.section, key]);

  // Locating one card is a handshake, not a deadline: `/settings/<section>#
  // st-card-…` and a search hit both ask for a card id, and the page waits until
  // the card that owns that id says it is on screen (`SettingsCardMountContext`,
  // announced by `SectionCard`). A card that loads its own data can therefore
  // arrive as late as it likes — the two seconds below are how long the located
  // card stays highlighted, not how long the page waits for it.
  const locateCard = useCallback((id: string) => {
    if (cardRequest === null || cardRequest.cardId !== id
      || cardRequest.section !== active || cardRequest.locationKey !== key) return;
    setCardRequest(null);
    setFlashCard({ cardId: id, nonce: cardRequest.nonce });
    const target = document.querySelector(`#${CSS.escape(id)}`);
    if (target !== null && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
  }, [cardRequest, active, key]);

  // The highlight, held from the moment the card was located.
  useEffect(() => {
    if (flashCard === null) return;
    const timer = setTimeout(() => { setFlashCard(null); }, 2000);
    return () => { clearTimeout(timer); };
  }, [flashCard]);

  // A request must not outlive the reader's own move: scrolling away drops it, so
  // a slow card keeps its place instead of pulling the view later.
  useEffect(() => {
    if (cardRequest === null) return;
    const drop = () => { setCardRequest(null); };
    const onKey = (event: KeyboardEvent) => { if (SCROLL_KEYS.has(event.key)) drop(); };
    window.addEventListener('wheel', drop, { passive: true, once: true });
    window.addEventListener('touchstart', drop, { passive: true, once: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', drop);
      window.removeEventListener('touchstart', drop);
      window.removeEventListener('keydown', onKey);
    };
  }, [cardRequest]);

  // …and a request belongs to one committed visit, including its tab: leaving
  // drops it. Keep a new hash request queued by this visit's effect above.
  useEffect(() => {
    setCardRequest((current) => current !== null
      && (current.section !== active || current.locationKey !== key) ? null : current);
  }, [active, key]);

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
    setDrawerOpen(false);
    if (entry.section === active && (entry.tab === undefined || entry.tab === currentTab)) {
      setCardRequest({ cardId: entry.cardId, section: entry.section, locationKey: key, nonce: Date.now() });
      return;
    }
    // Carry the target through the existing deep-link route, not local state on
    // the source page: the router may commit later, or the dirty guard may cancel.
    // Only the committed destination asks its mounted card to locate itself.
    setCardRequest(null);
    const target = entry.tab === undefined ? entry.section : `${entry.section}?tab=${entry.tab}`;
    guardedNavigate(`${target}#${entry.cardId}`);
  };

  const activeGroup = active === null ? undefined : settingsGroupForSection(active);
  const activeLabelKey = active === null ? undefined : SECTIONS.find((candidate) => candidate.id === active)?.labelKey;
  // One installed plugin's own settings page, or the installed list. The
  // section's card hash targets the list, so a bookmark to the Plugins leaf
  // lands on the list even when the query still names a plugin.
  const activePluginId = active === 'plugins' && hash.replace(/^#/, '') === ''
    ? pluginSettingsIdFromQuery(search)
    : null;

  // One workspace's own page, or the list. A workspace is the unit a reader
  // configures, so it gets a page rather than a dialog; the query selects it,
  // exactly as `?plugin=` selects a plugin's own settings page.
  const activeWorkspaceId = active === 'workspaces' && hash.replace(/^#/, '') === ''
    ? workspaceSettingsIdFromQuery(search)
    : null;
  // Leaving one workspace's page clears the breadcrumb name it set, so the next
  // visit does not inherit the previous object's name.
  useEffect(() => { setWorkspaceDetailName(null); }, [activeWorkspaceId]);

  // Import history is a built-in session surface, not a plugin sub-view. It
  // answers `/settings/sessions/import` directly; the legacy plugin address is
  // redirected there above, so it has exactly one home.
  const pane = active === null ? null
    : section === 'sessions/import' ? <SessionsImportPage />
    : active === 'general' ? <GeneralSection />
    : active === 'appearance' ? <AppearanceSection />
    : active === 'shortcuts' ? <ShortcutsSection />
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
    : active === 'external-clients' ? <ExternalClientsSection />
    : active === 'plugins' ? <PluginsSection pluginId={activePluginId} />
    : active === 'browser-control' ? <BrowserControlSection />
    : active === 'computer-control' ? <ComputerControlSection />
    : active === 'search' ? <NbSearchSection />
    : active === 'hooks' ? <HooksSection />
    : active === 'spaces' ? <SpacesSection />
    : active === 'workspaces' ? <WorkspacesSection workspaceId={activeWorkspaceId} />
    : active === 'ssh' ? <SshSection />
    : active === 'developer' ? <DeveloperSection />
    : active === 'labs' ? <LabsSection />
    : <><AboutSection /><DesktopLogCard /></>;

  // A feature page ends with the experimental flags that change it; tabbed
  // pages show them on one tab only, so a hit on the rows lands where they are.
  const experimentalTab = active === null ? undefined : experimentalTabForSection(active);
  const currentTab = new URLSearchParams(search).get('tab')
    ?? (active === 'ai' ? AI_SETTINGS_DEFAULT_TAB : active === 'search' ? 'overview' : null);
  const showExperimental = active !== null && active !== 'labs'
    && (experimentalTab === undefined || currentTab === experimentalTab);

  // A workspace's own page names the workspace in the breadcrumb, the way an
  // open plugin's page names its plugin: the page IS that object, and the
  // section label alone would not say which one.
  const activeLabel = workspaceDetailName ?? (activeLabelKey === undefined ? undefined : t(activeLabelKey));

  return (
    <SettingsCardMountContext.Provider value={locateCard}>
    <SettingsFlashContext.Provider value={flashCard?.cardId ?? null}>
    <SettingsWorkspaceScopeContext.Provider value={setWorkspaceScopeName}>
      <WorkspaceDetailNameContext.Provider value={setWorkspaceDetailName}>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-6">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink md:hidden">
          <Icon name="menu" size={16} />
        </button>
        <NavBackButton />
        {/* The page title is the leaf; "Settings" is the breadcrumb above it. */}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          <span className={activeLabel === undefined ? '' : 'font-normal text-ink-faint'}>{t('st.title')}</span>
          {activeLabel !== undefined ? <><span aria-hidden className="font-normal text-ink-faint">/</span><span data-settings-page-title className="truncate">{activeLabel}</span></> : null}
        </h1>
      </header>
      <main className="flex min-h-0 flex-1 border-t border-hairline">
        <div className="hidden shrink-0 border-r border-hairline lg:block"><SettingsNav active={active} activePluginId={activePluginId} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={onSearchHit} /></div>
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
                activePluginId={activePluginId}
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
            <div ref={scrollRef} data-settings-scroll className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-6 lg:px-10 lg:pt-8">
              <div className="mx-auto max-w-[720px]">
                <SpaceBand />
                <SectionIntro section={active} workspaceName={workspaceScopeName} remoteAddress={remoteAddress} dirty={dirty} hidePurpose={activePluginId !== null} />
                <SettingsPageScopeContext.Provider value={pageScope}>
                  <div className="space-y-6">{pane}{showExperimental ? <ExperimentalRows section={active} /> : null}</div>
                </SettingsPageScopeContext.Provider>
              </div>
            </div>
          )}
        </div>
      </main>
      </WorkspaceDetailNameContext.Provider>
    </SettingsWorkspaceScopeContext.Provider>
    </SettingsFlashContext.Provider>
    </SettingsCardMountContext.Provider>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import {
  AI_SETTINGS_DEFAULT_TAB,
  BROWSER_CONTROL_SETTINGS_DEFAULT_TAB,
  CONNECTION_SERVICES_SETTINGS_DEFAULT_TAB,
  DEVELOPER_SETTINGS_DEFAULT_TAB,
  DEVELOPER_SETTINGS_TABS,
  EXTENSIONS_SETTINGS_DEFAULT_TAB,
  SETTINGS_NAV_TREE,
  SETTINGS_SECTION_META,
  developerTabLabelKey,
  experimentalTabForSection,
  normalizeAiTab,
  normalizeDeveloperTab,
  pluginSettingsIdFromQuery,
  resolveSettingsRoute,
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
import { useSidebarContext } from './sidebarContext';
import { Icon } from './icons';
import { AgentsSection } from './settings/AgentsSection';
import { AiSection } from './settings/AiSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { DefaultsTab } from './settings/ModelsSection';
import { EngineParametersSection } from './settings/EngineParametersSection';
import { HooksSection } from './settings/hooks/HooksSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { DeveloperSection } from './settings/DeveloperSection';
import { ExperimentalRows } from './settings/ExperimentalRows';
import { ExtensionsSection } from './settings/ExtensionsSection';
import { PluginSettingsSectionSlotList } from './plugins/PluginSettingsSectionCard';
import { ConnectionServicesSection } from './settings/ConnectionServicesSection';
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
import { SECTIONS, type SectionId } from './settings/sections';
import { SettingsCardMountContext, SettingsFlashContext, SettingsPageScopeContext } from './settings/SectionCard';
import { SettingsTabs } from './settings/SettingsPrimitives';
import { SettingsPaneBoundary } from './settings/SettingsPaneBoundary';
import { SessionsSection } from './settings/SessionsSection';
import { SessionsImportPage } from './settings/SessionsImportPage';
import { ShortcutsSection } from './settings/ShortcutsSection';
import {
  REMOTE_SPACE_NAV_TREE,
  SettingsNav,
  SettingsSearch,
  settingsSectionAllowedInRemoteSpace,
} from './settings/SettingsNav';
import { useOptionalInstalledPlugins } from './capabilities/usePlugins';
import { SkillsSection } from './settings/SkillsSection';
import { SpacesSection } from './settings/SpacesSection';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { currentSpace, useSpaces } from '../lib/spaces';
import { connectionIdOfSpaceKey, useRemoteConnections } from '../lib/remoteConnections';
import { sanitizeHumanLabel, useServerHandshake, useSpaceLocation } from '../lib/spaceLocation';
import { spaceSettingsTargetIsSpace, spaceSettingsTargetOf } from '../lib/spaceSettings';
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
 * The card that owns an object section's *list* page (`InstalledPluginsList`'s
 * `st-card-plugins`, `WorkspacesSection`'s `st-card-workspaces`). That one hash
 * means "the list", so a bookmark to the leaf still lands there even when the
 * query names an object.
 *
 * Every other hash stays a jump *inside* the page the query names: an object
 * page's own card hash opens that object and flashes the card, and a hash that
 * names nothing (a stale anchor from another section, a copied address with a
 * fragment on it) still opens the object — the query is what the address is
 * for, and a page that silently fell back to its list would read as a dead
 * link rather than as a link to a thing.
 */
const OBJECT_LIST_CARD_HASH: Readonly<Partial<Record<SectionId, string>>> = {
  plugins: '#st-card-plugins',
  extensions: '#st-card-plugins',
  workspaces: '#st-card-workspaces',
  // The Recipe library is the Models page's Recipes tab.
  ai: '#st-card-recipes-library',
};

/** Below `lg` the rail is hidden, so search lives behind the header's magnifier. */
const WIDE_SETTINGS_QUERY = '(min-width: 1024px)';

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
 *
 * The name comes only from the space list or the pairing record, both read
 * from this window's own home. A space whose name is not known (yet) is
 * called "another space", never by its internal key (`remote:<uuid>`, a
 * home id).
 */
function SpaceBand() {
  const { t } = useI18n();
  const { localClient, connectionId, spaceKey } = useConnection();
  const space = currentSpace();
  const pairingId =
    (typeof connectionId === 'string' && connectionId !== '' ? connectionId : null) ??
    (space === null ? null : connectionIdOfSpaceKey(space.homeId)) ??
    (typeof spaceKey === 'string' ? connectionIdOfSpaceKey(spaceKey) : null);
  const pairings = useRemoteConnections(pairingId === null ? null : localClient ?? null);
  const spaces = useSpaces(space !== null && pairingId === null && space.name === undefined ? localClient ?? null : null);
  const localHandshake = useServerHandshake(space !== null && pairingId === null ? localClient ?? null : null);
  if (space === null && pairingId === null) return null;
  const record = pairingId === null ? undefined : pairings.data?.find((entry) => entry.id === pairingId);
  const name = pairingId !== null
    ? sanitizeHumanLabel(record?.label)
    : sanitizeHumanLabel(space?.name) ?? sanitizeHumanLabel(spaces.data?.find((item) => item.id === space?.homeId)?.name);
  const rawComputer = pairingId !== null
    ? sanitizeHumanLabel(record?.target?.hostId)
    : sanitizeHumanLabel(localHandshake.data?.targetLabel);
  const computer = rawComputer !== undefined && rawComputer !== name ? rawComputer : undefined;
  const bandText = name === undefined
    ? t('st.spaces.bandUnnamed')
    : computer !== undefined
      ? t('st.spaces.bandWithComputer', { name, computer })
      : t('st.spaces.band', { name });
  return (
    <p data-settings-space-band className="mb-5 flex items-center gap-2 border-l-2 py-0.5 pl-3 text-[12px] text-ink-soft"
      style={{ borderColor: space?.color ?? 'var(--color-hairline-strong)' }}>
      <SpaceDot color={space?.color} size={7} />
      <span className="min-w-0 truncate">{bandText}</span>
    </p>
  );
}

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const rawNavigate = useNavigate();
  const dirty = useDirtyGuard()?.dirty === true;
  const remoteAddress = useRemoteServerAddress();
  const { client, meta, connectionId, spaceKey } = useConnection();
  const inPairedSpace =
    (typeof connectionId === 'string' && connectionId !== '') ||
    connectionIdOfSpaceKey(currentSpace()?.homeId ?? '') !== null ||
    (typeof spaceKey === 'string' && connectionIdOfSpaceKey(spaceKey) !== null);
  const spaceLocation = useSpaceLocation({ enabled: inPairedSpace });
  const inSpace = spaceSettingsTargetIsSpace(spaceSettingsTargetOf(client, meta));
  const navTree = inPairedSpace ? REMOTE_SPACE_NAV_TREE : SETTINGS_NAV_TREE;
  const remoteSpaceNotice = inPairedSpace
    ? (spaceLocation.spaceName !== t('sidebar.space.unnamed')
      ? t('st.spaces.remoteSettingsNote', { space: spaceLocation.spaceName })
      : t('st.spaces.remoteSettingsNoteUnnamed'))
    : undefined;
  const [cardRequest, setCardRequest] = useState<{ cardId: string; section: string; locationKey: string; nonce: number } | null>(null);
  const [flashCard, setFlashCard] = useState<{ cardId: string; nonce: number } | null>(null);

  // `/settings/<section>#st-card-…` focuses one card, so callers elsewhere in
  // the app (the /new readiness card) can point at the exact control instead
  // of dropping the user at the top of a long section.
  const { hash, search, state, key } = useLocation();

  const resolution = resolveSettingsRoute(section, hash, search);
  const active: SectionId | null =
    resolution.status === 'ok' ? (resolution.section as SectionId) : null;
  // Bare `/settings` (no section, no card to land on). Wide, it is the
  // General page beside the rail, as it always was; below lg it is the list of
  // sections itself, and a section is the page you tap into and back out of.
  // The switch is CSS (`lg:`), so neither width renders the other's layout for
  // a frame while a media query settles.
  const settingsIndex = (section === undefined || section === '')
    && resolution.status === 'ok' && resolution.cardId === undefined;
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
  // A resolved tab (legacy `/settings/models` → `ai?tab=providers`) is merged
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

  // Below lg a section page has no search row: the header's magnifier swaps
  // the title for the field (design §2.1.1). The value is the field's focus
  // token while it is open — set by the magnifier tap or by Ctrl+F, both the
  // reader's own action — and null while the title shows. Any move to another
  // page or visit closes it.
  const [headerSearchToken, setHeaderSearchToken] = useState<string | null>(null);
  useEffect(() => { setHeaderSearchToken(null); }, [active, key]);
  useEffect(() => {
    if (searchFocusToken === null || settingsIndex || active === null) return;
    const wide = typeof window.matchMedia === 'function' && window.matchMedia(WIDE_SETTINGS_QUERY).matches;
    if (!wide) setHeaderSearchToken(searchFocusToken);
    // Only a new Ctrl+F asks; the page's own changes do not reopen the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchFocusToken]);
  useEffect(() => {
    const cardId = hash.replace(/^#/, '');
    if (!cardId.startsWith('st-card-')) return;
    // A visit that already holds the reader's own scroll position restores it
    // (`scrollRef` above), so the hash it was left with does not pull the pane
    // again when the reader comes back: the snapshot outranks the older target.
    const visit = getCurrentVisit();
    if (visit !== null && getUiSnapshot<{ scrollTop?: number }>(visit.visitId)?.scrollTop !== undefined) return;
    // The request keys on the page that must mount the card. In objects mode
    // the resolver still names the shipped leaf (identity) while the card
    // actually mounts on its host page (ai) — the handshake must use the
    // mapped page or the flash never fires on a re-homed deep link.
    if (active === null) return;
    setCardRequest({ cardId, section: active, locationKey: key, nonce: Date.now() });
  }, [hash, active, key]);

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
    void navigate(`/settings/${target}`);
  }, [navigate]);

  // Carry the target through the existing deep-link route, not local state on
  // the source page: the router may commit later, or the dirty guard may cancel.
  // Only the committed destination asks its mounted card to locate itself.
  const openSearchHit = (entry: SettingsSearchEntry) => {
    setCardRequest(null);
    const target = entry.tab === undefined ? entry.section : `${entry.section}?tab=${entry.tab}`;
    guardedNavigate(`${target}#${entry.cardId}`);
  };

  const onSearchHit = (entry: SettingsSearchEntry) => {
    if (entry.section === active && (entry.tab === undefined || entry.tab === currentTab)) {
      setCardRequest({ cardId: entry.cardId, section: entry.section, locationKey: key, nonce: Date.now() });
      return;
    }
    openSearchHit(entry);
  };

  const activeLabelKey = active === null ? undefined : SECTIONS.find((candidate) => candidate.id === active)?.labelKey;
  // One installed plugin's own settings page, or the installed list. Only the
  // list's own card hash means the list (see `OBJECT_LIST_CARD_HASH`); the
  // query selects the plugin for every other address, so a copied or bookmarked
  // link to a plugin opens that plugin instead of quietly showing the list.
  const onListCard = active !== null && OBJECT_LIST_CARD_HASH[active] === hash;
  const activePluginId = (active === 'plugins' || active === 'extensions') && !onListCard
    ? pluginSettingsIdFromQuery(search)
    : null;

  // One workspace's own page, or the list. A workspace is the unit a reader
  // configures, so it gets a page rather than a dialog; the query selects it,
  // exactly as `?plugin=` selects a plugin's own settings page.
  const activeWorkspaceId = active === 'workspaces' && !onListCard
    ? workspaceSettingsIdFromQuery(search)
    : null;

  const rawTab = new URLSearchParams(search).get('tab');
  // An old address (`/settings/recipes`, `/settings/identity`) names its tab
  // only through the resolver until the redirect above rewrites the query; the
  // pages this file draws tabs for read it from there so the first frame is
  // already the right tab.
  const pageTab = rawTab ?? (resolution.status === 'ok' ? resolution.tab : undefined);
  const aiTab = active === 'ai' ? normalizeAiTab(pageTab) ?? AI_SETTINGS_DEFAULT_TAB : null;
  const developerTab = normalizeDeveloperTab(pageTab) ?? DEVELOPER_SETTINGS_DEFAULT_TAB;

  const currentTab = active === 'developer' ? developerTab
    : active === 'ai' ? aiTab
    : active === 'extensions' ? (rawTab ?? EXTENSIONS_SETTINGS_DEFAULT_TAB)
    : active === 'browser-control' ? (rawTab ?? BROWSER_CONTROL_SETTINGS_DEFAULT_TAB)
    : active === 'connection-services' ? (rawTab ?? CONNECTION_SERVICES_SETTINGS_DEFAULT_TAB)
    : active === 'search' ? (rawTab ?? 'overview')
    : null;

  // A tab switch on a page whose strip this page draws: guarded like a section
  // switch, keeping the rest of the query (server/token deep-link params) but
  // dropping the keys that only mean something on the tab being left.
  const selectTab = (target: SectionId, tab: string, dropKeys: readonly string[] = []) => {
    const params = new URLSearchParams(search);
    for (const dropKey of dropKeys) params.delete(dropKey);
    params.set('tab', tab);
    void navigate(`/settings/${target}?${params.toString()}`);
  };

  const hiddenInRemoteSpace = inPairedSpace && active !== null && !settingsSectionAllowedInRemoteSpace(active);
  // Import history is a built-in session surface, not a plugin sub-view. It
  // answers `/settings/sessions/import` directly; the legacy plugin address is
  // redirected there above, so it has exactly one home.
  const pane = active === null ? null
    : hiddenInRemoteSpace ? (
        <p data-settings-remote-only-notice className="text-[13px] leading-5 text-ink-soft">
          {remoteSpaceNotice}
        </p>
      )
    : section === 'sessions/import' ? <SessionsImportPage />
    : active === 'general' ? <GeneralSection />
    : active === 'appearance' ? <AppearanceSection />
    : active === 'shortcuts' ? <ShortcutsSection />
    : active === 'connection' ? <ConnectionSection />
    : active === 'ai' ? <AiSection resolvedTab={aiTab ?? undefined} />
    : active === 'providers' ? <ProvidersSection />
    : active === 'models' ? <DefaultsTab />
    : active === 'connection-services' ? <ConnectionServicesSection />
    : active === 'identity' ? <IdentitySection />
    : active === 'agents' ? <AgentsSection />
    : active === 'subagents' ? <AgentsSection />
    : active === 'sessions' ? <SessionsSection />
    : active === 'notifications' ? <NotificationsSection />
    : active === 'memory' ? <MemorySection />
    : active === 'permissions' ? <PermissionsSection />
    : active === 'tasks' ? <TasksSection />
    : active === 'skills' ? <SkillsSection />
    : active === 'mcp' ? <McpSection />
    : active === 'external-clients' ? <ConnectionServicesSection />
    : active === 'plugins' ? <PluginsSection pluginId={activePluginId} />
    // The two leaves merged into one page: browser-control hosts both tabs,
    // and `?tab=computer` selects the computer tab, so the old split keeps its
    // addresses.
    : active === 'browser-control' || active === 'computer-control' ? <BrowserControlSection />
    : active === 'search' ? <NbSearchSection />
    : active === 'hooks' ? <HooksSection />
    : active === 'spaces' ? <SpacesSection />
    : active === 'workspaces' ? <WorkspacesSection key={activeWorkspaceId ?? 'catalog'} workspaceId={activeWorkspaceId} />
    : active === 'ssh' ? <SshSection />
    // Developer & labs: the page itself, Engine parameters (the engine
    // internals moved off the everyday pages) and Request identity.
    : active === 'developer' ? (
        <div className="space-y-4">
          <SettingsTabs tabs={DEVELOPER_SETTINGS_TABS} current={developerTab} ariaLabel={t('st.section.developer')} dataAttr="data-developer-tab"
            labelOf={(tab) => t(developerTabLabelKey(tab))}
            onSelect={(tab) => { selectTab('developer', tab); }} />
          {developerTab === 'engine' ? <EngineParametersSection />
            : developerTab === 'identity' ? <IdentitySection />
            : <DeveloperSection />}
        </div>
      )
    : active === 'labs' ? <LabsSection />
    : active === 'extensions' ? <ExtensionsSection pluginId={activePluginId} />
    : active === 'environment-tools' ? (
        currentTab === 'search' ? <NbSearchSection />
        : <div className="space-y-6"><NbSearchSection /><BrowserControlSection /></div>
      )
    : active === 'remote' ? <div className="space-y-6"><ConnectionSection /><SshSection /><ConnectionServicesSection /></div>
    : active === 'system' ? <div className="space-y-6"><DeveloperSection /><AboutSection /><DesktopLogCard /></div>
    : <><AboutSection /><DesktopLogCard /></>;

  // A feature page ends with the experimental flags that change it; tabbed
  // pages show them on one tab only, so a hit on the rows lands where they are.
  const experimentalTab = active === null ? undefined : experimentalTabForSection(active);
  // A plugin's own page is about that plugin; the page's flags stay on the list.
  const showExperimental = !inPairedSpace && !hiddenInRemoteSpace
    && active !== null && active !== 'labs' && activePluginId === null
    && (experimentalTab === undefined || currentTab === experimentalTab);

  // A workspace's own page names the workspace in the breadcrumb, the way an
  // open plugin's page names its plugin: the page IS that object, and the
  // section label alone would not say which one.
  const activeLabel = workspaceDetailName ?? (activeLabelKey === undefined ? undefined : t(activeLabelKey));
  // An open plugin's page gets one more breadcrumb segment with its own name;
  // the navigation no longer lists installed plugins under the leaf.
  const installedPlugins = useOptionalInstalledPlugins().plugins;
  const pluginLabel = activePluginId === null
    ? undefined
    : installedPlugins.find((plugin) => plugin.id === activePluginId)?.displayName ?? activePluginId;

  const { sidebarOpen } = useSidebarContext();

  return (
    <SettingsCardMountContext.Provider value={locateCard}>
    <SettingsFlashContext.Provider value={flashCard?.cardId ?? null}>
    <SettingsWorkspaceScopeContext.Provider value={setWorkspaceScopeName}>
      <WorkspaceDetailNameContext.Provider value={setWorkspaceDetailName}>
      <header className="relative flex h-12 shrink-0 items-center gap-2 px-4 lg:px-6">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink md:hidden"
        >
          <Icon name="menu" size={16} />
        </button>
        <NavBackButton />
        {/* Below lg, an open search takes the title's place; at lg the rail
            holds search, so the title always shows there. */}
        {headerSearchToken !== null ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 lg:hidden" data-settings-header-search>
            <SettingsSearch
              className="min-w-0 flex-1"
              focusToken={headerSearchToken}
              onSearchHit={(entry) => { setHeaderSearchToken(null); onSearchHit(entry); }}
              onDismiss={() => { setHeaderSearchToken(null); }}
              navTree={navTree}
              floatingResults
            />
            <button
              type="button"
              data-settings-search-close
              aria-label={t('common.close')}
              onClick={() => { setHeaderSearchToken(null); }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : null}
        {/* The page title is the leaf; "Settings" is the breadcrumb above it.
            The narrow section list is no leaf, so there it is just "Settings". */}
        <h1 className={`${headerSearchToken !== null ? 'max-lg:hidden ' : ''}flex min-w-0 flex-1 items-baseline gap-1.5 truncate font-display text-[15px] font-semibold tracking-tight text-ink`}>
          <span className={activeLabel === undefined ? '' : settingsIndex ? 'lg:font-normal lg:text-ink-faint' : 'font-normal text-ink-faint'}>{t('st.title')}</span>
          {activeLabel !== undefined ? <><span aria-hidden className={`font-normal text-ink-faint${settingsIndex ? ' hidden lg:inline' : ''}`}>/</span><span data-settings-page-title className={`truncate${settingsIndex ? ' hidden lg:inline' : ''}`}>{activeLabel}</span></> : null}
          {pluginLabel !== undefined ? <><span aria-hidden className="font-normal text-ink-faint">/</span><span data-settings-plugin-title className="truncate font-normal text-ink-faint">{pluginLabel}</span></> : null}
        </h1>
        {active !== null && !settingsIndex && headerSearchToken === null ? (
          <button
            type="button"
            data-settings-search-open
            aria-label={t('st.search.aria')}
            onClick={() => { setHeaderSearchToken(String(Date.now())); }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink lg:hidden"
          >
            <Icon name="search" size={16} />
          </button>
        ) : null}
      </header>
      <main className="flex min-h-0 flex-1 border-t border-hairline">
        <div className="hidden shrink-0 border-r border-hairline lg:block"><SettingsNav active={active} activeTab={currentTab} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={onSearchHit} navTree={navTree} remoteNotice={remoteSpaceNotice} /></div>
        {settingsIndex ? (
          // The narrow list marks no leaf as current (nothing is open yet), and
          // a search hit always opens its section: the General pane under the
          // list is display:none here, so locating a card in place would land
          // on a page nobody can see.
          <div data-settings-index className="flex min-w-0 flex-1 lg:hidden">
            <SettingsNav active={null} activeTab={null} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={openSearchHit} showAttention navTree={navTree} remoteNotice={remoteSpaceNotice} />
          </div>
        ) : null}
        <div className={`${settingsIndex ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col`}>
          {active === null ? (
            <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto">
              <UnknownSettingsSection section={section ?? ''} onSearchHit={onSearchHit} />
            </div>
          ) : (
            <div ref={scrollRef} data-settings-scroll className="relative min-h-0 flex-1 overflow-y-auto px-4 pb-[var(--settings-scroll-pb)] pt-[var(--settings-scroll-pt)] [--settings-scroll-pb:4rem] [--settings-scroll-pt:1.5rem] has-[[data-detail-split=open]]:[--settings-scroll-pb:0px] lg:px-10 lg:[--settings-scroll-pt:2rem]">
              {/* An open in-page detail (overlays/DetailSplit) takes a wider
                  column: rail + editor need the room a reading column does not. */}
              <div className="mx-auto max-w-[720px] transition-[max-width] duration-[var(--kiki-motion-base)] ease-[var(--kiki-ease-out)] has-[[data-detail-split=open]]:max-w-[1180px]">
                <SpaceBand />
                {hiddenInRemoteSpace ? null : (
                  <SectionIntro section={active} workspaceName={workspaceScopeName} remoteAddress={remoteAddress} dirty={dirty} hidePurpose={activePluginId !== null} />
                )}
                <SettingsPageScopeContext.Provider value={pageScope}>
                  <SettingsPaneBoundary resetKey={`${active}\u0000${search}\u0000${key}`}>
                    <div className="space-y-6">
                      {pane}
                      {!hiddenInRemoteSpace && (active === 'plugins' || active === 'extensions') && activePluginId === null ? (
                        <PluginSettingsSectionSlotList workspaceId={activeWorkspaceId ?? undefined} />
                      ) : null}
                      {showExperimental ? <ExperimentalRows section={active} /> : null}
                    </div>
                  </SettingsPaneBoundary>
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

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n/locale';
import {
  SETTINGS_SECTION_META,
  resolveSettingsRoute,
  settingsGroupForSection,
  type SettingsSearchEntry,
} from '../lib/settings';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { AboutSection } from './settings/AboutSection';
import { AgentsSection } from './settings/AgentsSection';
import { CapabilitiesSection } from './settings/CapabilitiesSection';
import { ConnectionSection } from './settings/ConnectionSection';
import { GeneralSection } from './settings/GeneralSection';
import { ModelsSection } from './settings/ModelsSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { SECTIONS, type SectionId } from './settings/sections';
import { SettingsFlashContext } from './settings/SectionCard';
import { SettingsNav, SettingsNavTree, SettingsSearch } from './settings/SettingsNav';
import { UnknownSettingsSection } from './settings/UnknownSection';
import { WorkspacesSection } from './settings/WorkspacesSection';

export { mcpConfigFromDraft } from './settings/McpConfigManager';
export { parseNamedAgentTools } from './settings/AgentsSection';

/** Page-top signpost: what this page is for and whose behavior its edits change. */
function ScopeHeader({ section }: { section: SectionId }) {
  const { t } = useI18n();
  const meta = SETTINGS_SECTION_META[section];
  if (meta === undefined) return null;
  const labelKey = SECTIONS.find((candidate) => candidate.id === section)?.labelKey;
  return (
    <header data-settings-scope-header={meta.scopes.join('+')} className="mb-3 border-b border-hairline pb-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
          {labelKey === undefined ? section : t(labelKey)}
        </h2>
        {/* Until the batches 2/3 split lands a page can write more than one
            scope; show every one of them instead of a flattering single badge. */}
        {meta.scopes.map((scope) => (
          <span
            key={scope}
            className="rounded-full border border-hairline bg-paper px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-faint"
            title={t('st.scope.label')}
          >
            {t(`st.scope.${scope}` as I18nKey)}
          </span>
        ))}
      </div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{t(meta.purposeKey)}</p>
    </header>
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
      <div className="absolute inset-y-0 left-0 flex w-[260px] flex-col overflow-y-auto border-r border-hairline bg-panel p-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="font-display text-[13px] font-semibold text-ink">{t('st.title')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          >
            <span aria-hidden>✕</span>
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

  // Canonicalize legacy / card-moved targets in place: replace, never push,
  // and bypass the dirty guard — this is a redirect, not a user navigation.
  useEffect(() => {
    if (resolution.status !== 'ok' || resolution.section === section) return;
    if (section === undefined && resolution.section === 'general') return;
    rawNavigate(`/settings/${resolution.section}${search}${hash}`, { replace: true });
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
    if (entry.section !== active) guardedNavigate(entry.section);
  };

  const activeGroup = active === null ? undefined : settingsGroupForSection(active);
  const activeLabelKey = active === null ? undefined : SECTIONS.find((candidate) => candidate.id === active)?.labelKey;

  const pane = active === null ? null
    : active === 'general' ? <GeneralSection />
    : active === 'models' ? <ModelsSection />
    : active === 'connection' ? <ConnectionSection />
    : active === 'providers' ? <ProvidersSection />
    : active === 'agents' ? <AgentsSection />
    : active === 'capabilities' ? <CapabilitiesSection />
    : active === 'workspaces' ? <WorkspacesSection />
    : <AboutSection />;

  return (
    <SettingsFlashContext.Provider value={focusCard?.cardId ?? null}>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"><span aria-hidden>☰</span></button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">{t('st.title')}</h1>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="hidden lg:block"><SettingsNav active={active} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={onSearchHit} /></div>
        <div className="flex min-w-0 flex-1 flex-col">
          {active !== null ? (
            <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
              <SettingsSearch
                focusToken={searchFocusToken}
                onSearchHit={onSearchHit}
                idle={
                  <button
                    type="button"
                    data-settings-nav-trigger
                    onClick={() => { setDrawerOpen(true); }}
                    className="mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none transition-colors focus:border-accent"
                  >
                    <span className="min-w-0 truncate">
                      {activeGroup !== undefined ? (
                        <>
                          <span className="text-ink-faint">{t(activeGroup.labelKey)}</span>
                          <span className="mx-1 text-ink-faint">›</span>
                        </>
                      ) : null}
                      <span>{activeLabelKey === undefined ? active : t(activeLabelKey)}</span>
                    </span>
                    <span aria-hidden className="shrink-0 text-[11px] text-ink-faint">▾</span>
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
            <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto px-4 py-3 lg:px-8">
              <div className="mx-auto max-w-[760px]">
                <ScopeHeader section={active} />
                <div className="space-y-3">{pane}</div>
              </div>
            </div>
          )}
        </div>
      </main>
    </SettingsFlashContext.Provider>
  );
}

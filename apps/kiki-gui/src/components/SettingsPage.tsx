import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import { useI18n } from '../i18n';
import type { SettingsSearchEntry } from '../lib/settings';
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
import { SettingsNav, SettingsSearch } from './settings/SettingsNav';
import { WorkspacesSection } from './settings/WorkspacesSection';

export { mcpConfigFromDraft } from './settings/McpConfigManager';
export { parseNamedAgentTools } from './settings/AgentsSection';

export function SettingsPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { section } = useParams<{ section?: string }>();
  const { t } = useI18n();
  const active: SectionId = SECTIONS.find((candidate) => candidate.id === section)?.id ?? 'general';
  const navigate = useGuardedNavigate();
  const dirty = useDirtyGuard()?.dirty === true;
  const [focusCard, setFocusCard] = useState<{ cardId: string; nonce: number } | null>(null);

  const guardedNavigate = useCallback((target: string) => {
    navigate(`/settings/${target}`);
  }, [navigate]);

  // `/settings/<section>#st-card-…` focuses one card, so callers elsewhere in
  // the app (the /new readiness card) can point at the exact control instead
  // of dropping the user at the top of a long section.
  const { hash, state, key } = useLocation();
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

  const onSearchHit = (entry: SettingsSearchEntry) => {
    setFocusCard({ cardId: entry.cardId, nonce: Date.now() });
    if (entry.section !== active) guardedNavigate(entry.section);
  };

  const pane = active === 'general' ? <GeneralSection /> : active === 'models' ? <ModelsSection /> : active === 'connection' ? <ConnectionSection /> : active === 'providers' ? <ProvidersSection /> : active === 'agents' ? <AgentsSection /> : active === 'capabilities' ? <CapabilitiesSection /> : active === 'workspaces' ? <WorkspacesSection /> : <AboutSection />;

  return (
    <SettingsFlashContext.Provider value={focusCard?.cardId ?? null}>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button type="button" onClick={onToggleSidebar} aria-label={t('sv.openMenuAria')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"><span aria-hidden>☰</span></button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">{t('st.title')}</h1>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className="hidden lg:block"><SettingsNav active={active} searchFocusToken={searchFocusToken} onNavigate={guardedNavigate} onSearchHit={onSearchHit} /></div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-hairline bg-panel px-4 py-2 lg:hidden">
            <SettingsSearch
              focusToken={searchFocusToken}
              onSearchHit={onSearchHit}
              idle={
                <select className="mt-2 w-full rounded-md border border-hairline bg-paper px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent" value={active} onChange={(event) => { guardedNavigate(event.target.value); }}>
                  {SECTIONS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.labelKey)}</option>)}
                </select>
              }
            />
          </div>
          <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-8"><div className="mx-auto max-w-[760px] space-y-4">{pane}</div></div>
        </div>
      </main>
    </SettingsFlashContext.Provider>
  );
}

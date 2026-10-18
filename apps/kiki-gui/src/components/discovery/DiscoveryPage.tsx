/**
 * DiscoveryPage — the route map and discovery hub (/discover).
 *
 * Provides:
 * - Direct access to the 1-minute spotlight tour and the 5 interest routes
 *   arranged as a dual-column visual gallery with micro wireframes.
 * - Resume button if a tour was paused/left mid-way.
 * - Pure local presentation without creating fake sessions or sending model requests.
 * - Route to start a real task via /new draft.
 * - The current model connection, with the Settings card that owns configuring it.
 */

import {
  DISCOVERY_ROUTES,
  discoveryRouteProgress,
} from '@kiki/session-core/discovery';
import { useI18n } from '../../i18n';
import { useSidebarContext } from '../sidebarContext';
import { Icon } from '../icons';
import { WorkspaceHeader } from '../agent-workspace';
import { useDiscovery } from './DiscoveryContext';
import { DiscoveryRouteRow } from './DiscoveryRouteRow';
import { MODEL_SETTINGS_HREF, ModelConnectionEntry, useModelConnection } from './ModelConnectionEntry';
import { useGuardedNavigate } from '../dirtyGuard';
import { PAGE_WIDTH } from '../PageChrome';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

function RouteMicroWireframe({ routeId }: { readonly routeId: string }) {
  if (routeId === 'overview') {
    return (
      <svg className="h-10 w-full text-ink-faint/35" viewBox="0 0 200 48" fill="none" stroke="currentColor">
        <rect x="4" y="4" width="40" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <line x1="12" y1="12" x2="36" y2="12" strokeWidth="1.5" />
        <line x1="12" y1="18" x2="28" y2="18" strokeWidth="1.5" />
        <line x1="12" y1="24" x2="32" y2="24" strokeWidth="1.5" />
        <rect x="52" y="4" width="144" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <line x1="62" y1="12" x2="140" y2="12" strokeWidth="1.5" />
        <line x1="62" y1="18" x2="170" y2="18" strokeWidth="1.5" />
        <line x1="62" y1="24" x2="110" y2="24" strokeWidth="1.5" />
        <rect x="62" y="32" width="124" height="8" rx="2" strokeWidth="1" strokeDasharray="2 2" />
      </svg>
    );
  }
  if (routeId === 'do-first') {
    return (
      <svg className="h-10 w-full text-ink-faint/35" viewBox="0 0 200 48" fill="none" stroke="currentColor">
        <rect x="4" y="4" width="192" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <circle cx="18" cy="16" r="3.5" strokeWidth="1.5" className="text-accent" />
        <line x1="28" y1="16" x2="120" y2="16" strokeWidth="1.5" />
        <circle cx="18" cy="28" r="3.5" strokeWidth="1.5" className="text-emerald-500" />
        <line x1="28" y1="28" x2="160" y2="28" strokeWidth="1.5" />
        <rect x="28" y="36" width="60" height="5" rx="2" strokeWidth="1" className="fill-accent/10" />
      </svg>
    );
  }
  if (routeId === 'understand') {
    return (
      <svg className="h-10 w-full text-ink-faint/35" viewBox="0 0 200 48" fill="none" stroke="currentColor">
        <rect x="4" y="4" width="192" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <circle cx="20" cy="20" r="7" strokeWidth="1.5" />
        <line x1="25" y1="25" x2="33" y2="33" strokeWidth="2" strokeLinecap="round" />
        <line x1="46" y1="14" x2="180" y2="14" strokeWidth="1.5" />
        <line x1="46" y1="22" x2="140" y2="22" strokeWidth="1.5" />
        <line x1="46" y1="30" x2="160" y2="30" strokeWidth="1.5" />
      </svg>
    );
  }
  if (routeId === 'sustain') {
    return (
      <svg className="h-10 w-full text-ink-faint/35" viewBox="0 0 200 48" fill="none" stroke="currentColor">
        <rect x="4" y="4" width="58" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <line x1="12" y1="14" x2="48" y2="14" strokeWidth="1.5" />
        <line x1="12" y1="22" x2="40" y2="22" strokeWidth="1.5" />
        <rect x="71" y="4" width="58" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <line x1="79" y1="14" x2="115" y2="14" strokeWidth="1.5" />
        <line x1="79" y1="22" x2="105" y2="22" strokeWidth="1.5" />
        <rect x="138" y="4" width="58" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
        <line x1="146" y1="14" x2="182" y2="14" strokeWidth="1.5" />
        <line x1="146" y1="22" x2="170" y2="22" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg className="h-10 w-full text-ink-faint/35" viewBox="0 0 200 48" fill="none" stroke="currentColor">
      <rect x="4" y="4" width="42" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
      <rect x="54" y="4" width="42" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
      <rect x="104" y="4" width="42" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
      <rect x="154" y="4" width="42" height="40" rx="4" strokeWidth="1.5" className="fill-ink/[0.02]" />
      <circle cx="25" cy="24" r="5" strokeWidth="1.5" />
      <circle cx="75" cy="24" r="5" strokeWidth="1.5" />
      <circle cx="125" cy="24" r="5" strokeWidth="1.5" />
      <circle cx="175" cy="24" r="5" strokeWidth="1.5" />
    </svg>
  );
}

export function DiscoveryPage({
  onToggleSidebar,
}: {
  readonly onToggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { state, view, startRoute, resumeDiscovery, leaveDiscovery } = useDiscovery();
  const modelConnection = useModelConnection();

  /**
   * Running anything needs a connection, so the model row sits on the same side
   * of the map as "start with a real task". Opening Settings leaves the guide
   * with its position kept, which is what puts the resume tag — the way back —
   * on the page the person lands on.
   */
  const openModelSettings = () => {
    if (state.lifecycle === 'active') leaveDiscovery();
    navigate(MODEL_SETTINGS_HREF);
  };

  const { sidebarOpen } = useSidebarContext();

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-canvas text-ink" data-discovery-page>
      <WorkspaceHeader main>
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-panel hover:text-ink md:hidden"
        >
          <Icon name="menu" size={16} />
        </button>
        <div className="flex items-center gap-2">
          <Icon name="compass" size={16} className="text-accent" />
          <h2 className="font-display text-[15px] font-semibold text-ink">
            {t('discovery.title')}
          </h2>
        </div>
      </WorkspaceHeader>

      <main className={`mx-auto w-full ${PAGE_WIDTH.reading} flex-1 px-6 py-8`}>
        {/* Intro Banner */}
        <section data-discovery-welcome className="rounded-2xl border border-hairline bg-paper p-6 shadow-[var(--kiki-sheet-shadow)]">
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-ink-soft">
            <span className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-accent-ink">
              <Icon name="compass" size={12} />
              {t('discovery.noModel')}
            </span>
            <span className="text-ink-faint">·</span>
            <span>{t('discovery.guide')}</span>
          </div>

          <h1 className="mt-3 font-display text-[22px] font-bold tracking-tight text-ink sm:text-[24px]">
            {t('discovery.welcome.title')}
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-soft">
            {t('discovery.welcome.body')}
          </p>

          {/* 1-Minute Spotlight Tour Card */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/40 bg-accent-soft/20 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-accent">
                <Icon name="compass" size={16} />
                <h3 className="font-display text-[15px] font-semibold text-ink">
                  {t('onboarding.depart.tour.title')}
                </h3>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                {t('onboarding.depart.tour.subtitle')}
              </p>
            </div>
            <button
              type="button"
              data-discovery-start-overview
              onClick={() => { void startRoute('overview'); }}
              className={`shrink-0 ${PRIMARY_BUTTON}`}
            >
              {t('onboarding.depart.tour.startBtn')}
            </button>
          </div>

          {/* Resume banner if there is an active/left tour */}
          {view.resume ? (
            <div
              data-discovery-resume-banner
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft/20 p-4"
            >
              <div className="min-w-0">
                <span className="text-[12px] font-medium text-ink-soft">
                  {t('discovery.continue')}
                </span>
                <p className="font-display text-[14px] font-semibold text-ink">
                  {view.route ? t(view.route.titleKey) : ''} ({view.position}/{view.total})
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void resumeDiscovery(); }}
                className={PRIMARY_BUTTON}
              >
                {t('discovery.continue')}
              </button>
            </div>
          ) : null}
        </section>

        {/* Discovery Routes — Responsive Dual-Column Visual Card Gallery */}
        <section className="mt-8" aria-labelledby="discovery-routes-heading">
          <h3
            id="discovery-routes-heading"
            className="text-[13px] font-semibold uppercase tracking-wider text-section-ink"
          >
            {t('discovery.routesHeading')}
          </h3>

          <div
            className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"
            role="group"
            aria-labelledby="discovery-routes-heading"
          >
            {DISCOVERY_ROUTES.map((route) => {
              const current = view.resume && state.route === route.id;
              return (
                <div
                  key={route.id}
                  className={`flex flex-col justify-between overflow-hidden rounded-xl border border-hairline bg-paper p-3.5 shadow-[var(--kiki-sheet-shadow)] transition-all hover:border-hairline-strong ${
                    current ? 'ring-2 ring-selected-ink/40' : ''
                  }`}
                >
                  <div className="mb-2 rounded-lg bg-canvas/60 p-2">
                    <RouteMicroWireframe routeId={route.id} />
                  </div>
                  <DiscoveryRouteRow
                    route={route}
                    progress={discoveryRouteProgress(state, route.id)}
                    current={current}
                    onSelect={() => { void (current ? resumeDiscovery() : startRoute(route.id)); }}
                    data={{
                      'data-discovery-route-card': route.id,
                      'data-start-route': route.id,
                    }}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* Start a Real Task Option */}
        <section className="mt-8 rounded-xl border border-hairline bg-paper p-5 shadow-[var(--kiki-sheet-shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="font-display text-[15px] font-semibold text-ink">
                {t('discovery.realTask')}
              </h3>
              <p className="mt-0.5 text-[12px] text-ink-soft">
                {t('discovery.realTaskHint')}
              </p>
            </div>
            <button
              type="button"
              data-discovery-real-task
              onClick={() => { navigate('/new'); }}
              className={SECONDARY_BUTTON}
            >
              {t('sidebar.newSession')}
            </button>
          </div>

          <div className="mt-4 border-t border-hairline pt-4" data-discovery-model-connection>
            <ModelConnectionEntry info={modelConnection} onOpen={openModelSettings} />
          </div>
        </section>
      </main>
    </div>
  );
}

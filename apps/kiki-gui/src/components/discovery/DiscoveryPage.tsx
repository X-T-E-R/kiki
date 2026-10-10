/**
 * DiscoveryPage — the route map and discovery hub (/discover).
 *
 * Provides:
 * - Direct access to the overview tour ("Take me on a tour") and the 4 interest
 *   routes, as the same DiscoveryRouteRow the welcome's closing step renders.
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
import { Icon } from '../icons';
import { WorkspaceHeader } from '../agent-workspace';
import { useDiscovery } from './DiscoveryContext';
import { DiscoveryRouteRow } from './DiscoveryRouteRow';
import { MODEL_SETTINGS_HREF, ModelConnectionEntry, useModelConnection } from './ModelConnectionEntry';
import { useGuardedNavigate } from '../dirtyGuard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

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

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-canvas text-ink" data-discovery-page>
      <WorkspaceHeader main>
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
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

      <main className="mx-auto w-full max-w-[800px] flex-1 px-6 py-8">
        {/* Intro Banner */}
        <section className="rounded-2xl border border-hairline bg-paper p-6 shadow-[var(--kiki-sheet-shadow)]">
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

          {/* Resume banner if there is an active/left tour */}
          {view.resume ? (
            <div
              data-discovery-resume-banner
              className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/40 bg-accent-soft/20 p-4"
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

        {/* Discovery Routes — the same rows the welcome's closing step uses,
            gathered on one sheet. The route in progress resumes where it was
            left instead of starting over. */}
        <section className="mt-8" aria-labelledby="discovery-routes-heading">
          <h3
            id="discovery-routes-heading"
            className="text-[13px] font-semibold uppercase tracking-wider text-section-ink"
          >
            {t('discovery.routesHeading')}
          </h3>

          <div className="mt-3 space-y-0.5 rounded-xl border border-hairline bg-paper p-1.5 shadow-[var(--kiki-sheet-shadow)]">
            {DISCOVERY_ROUTES.map((route) => {
              const current = view.resume && state.route === route.id;
              return (
                <DiscoveryRouteRow
                  key={route.id}
                  route={route}
                  progress={discoveryRouteProgress(state, route.id)}
                  current={current}
                  onSelect={() => { void (current ? resumeDiscovery() : startRoute(route.id)); }}
                  data={{ 'data-discovery-route-card': route.id, 'data-start-route': route.id }}
                />
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

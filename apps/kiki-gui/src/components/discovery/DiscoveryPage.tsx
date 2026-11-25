/**
 * DiscoveryPage — the help entry (/discover).
 *
 * One main path: the overview tour, mapped to its actual registered stations on
 * warm paper without calling a model. Below it, the three focused topic routes
 * (`understand`, `sustain`, `extend`) stand as peer hairline rows. An
 * interrupted tour reports its exact checkpoint at the top with an explicit
 * resume action. Viewing this page never writes progress.
 */

import {
  DISCOVERY_ROUTES,
  discoveryProgress,
  discoveryRoute,
  discoveryRouteProgress,
  discoveryStation,
  type DiscoveryRouteId,
  type DiscoveryStationId,
  type DiscoveryState,
} from '@kiki/session-core/discovery';

import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { PAGE_WIDTH, PageHeader } from '../PageChrome';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { useDiscovery } from './DiscoveryContext';
import { DiscoveryRouteRow, type DiscoveryStationMarkerState } from './DiscoveryRouteRow';

/** The overview tour is the main path; these three topics are focused entry points. */
const TOPIC_ROUTES: ReadonlySet<DiscoveryRouteId> = new Set<DiscoveryRouteId>(['understand', 'sustain', 'extend']);

function stationMarkerState(
  state: DiscoveryState,
  routeId: DiscoveryRouteId,
  stationId: DiscoveryStationId,
  resumable: boolean,
): DiscoveryStationMarkerState {
  if (resumable && state.route === routeId && state.station === stationId) return 'resumable';
  const progress = discoveryProgress(state, stationId);
  if (progress.tried) return 'tried';
  if (progress.seen) return 'seen';
  if (progress.skipped) return 'skipped';
  return 'unvisited';
}

export function DiscoveryPage({
  onToggleSidebar,
}: {
  readonly onToggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const { state, view, startRoute, resumeDiscovery } = useDiscovery();
  const overview = discoveryRoute('overview');
  const overviewProgress = discoveryRouteProgress(state, 'overview');
  const overviewFinished = state.lifecycle === 'finished' && state.route === 'overview';
  const showOverviewMeta = overviewProgress.seen > 0 || overviewProgress.skipped > 0 || overviewFinished;
  const topics = DISCOVERY_ROUTES.filter((route) => TOPIC_ROUTES.has(route.id));

  const stationStateLabel = (marker: DiscoveryStationMarkerState): string => {
    if (marker === 'resumable') return t('discovery.hub.stationCurrent');
    if (marker === 'tried') return t('discovery.tried');
    if (marker === 'seen') return t('discovery.seen');
    if (marker === 'skipped') return t('discovery.skipped');
    return t('discovery.hub.stationUnvisited');
  };

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-paper text-ink" data-discovery-page>
      <PageHeader title={t('discovery.title')} onToggleSidebar={onToggleSidebar} width="reading" />

      <main className="flex-1 px-4 py-6 sm:py-10 lg:px-6">
        <div className={`mx-auto w-full ${PAGE_WIDTH.reading}`}>
          {view.resume ? (
            <div
              data-discovery-resume
              className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-r-lg border-l-2 border-selected-ink bg-selected-ink/[0.05] py-3 pl-4 pr-3.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-5 font-normal text-ink">
                  {t('discovery.hub.resumeAt', { step: view.position })}
                  {view.total > 0 ? (
                    <span className="ml-2 text-[12px] font-normal tabular-nums text-selected-ink">
                      {t('discovery.tour.stepBadge', { current: view.position, total: view.total })}
                    </span>
                  ) : null}
                </p>
                {view.route !== undefined && view.station !== undefined ? (
                  <p className="mt-0.5 truncate text-[12px] text-ink-soft">
                    {t('discovery.hub.resumeDetail', {
                      route: t(view.route.titleKey),
                      station: t(view.station.titleKey),
                    })}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className={`${SECONDARY_BUTTON} shrink-0 pointer-coarse:min-h-11`}
                onClick={() => { void resumeDiscovery(); }}
              >
                {t('discovery.continue')}
              </button>
            </div>
          ) : null}

          <section data-discovery-tour>
            <h2 className="font-sans text-[24px] leading-8 font-bold text-ink">
              {t('discovery.hub.headline')}
            </h2>
            <p className="mt-2.5 max-w-[56ch] text-[14px] leading-relaxed text-ink-soft">
              {t('discovery.hub.intro')}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2.5">
              <button
                type="button"
                data-discovery-start-overview
                onClick={() => { void startRoute('overview'); }}
                className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5 pointer-coarse:min-h-11`}
              >
                <span>{t('firstRun.tour.start')}</span>
                <Icon name="arrowRight" size={14} />
              </button>
              <span className="inline-flex flex-wrap items-center gap-x-2 text-[13px] leading-5 text-ink-faint">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="compass" size={12} className="shrink-0 text-ink-faint" />
                  <span>{t('discovery.noModel')}</span>
                </span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{t('discovery.stops', { count: overview.stations.length })}</span>
              </span>
            </div>

            <div className="mt-8 border-t border-hairline/80 pt-5" data-discovery-overview-rail>
              {showOverviewMeta ? (
                <p data-discovery-overview-summary className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] tabular-nums text-ink-faint">
                  <span>{t('discovery.hub.overviewProgress', { seen: overviewProgress.seen, total: overviewProgress.total })}</span>
                  {overviewProgress.skipped > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>{t('discovery.hub.overviewSkipped', { count: overviewProgress.skipped })}</span>
                    </>
                  ) : null}
                  {overviewFinished ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-ink-soft">{t('discovery.finished')}</span>
                    </>
                  ) : null}
                </p>
              ) : null}

              <ol
                aria-label={t('discovery.hub.routeRailAria')}
                className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:gap-2"
              >
                {overview.stations.map((stationId, index) => {
                  const station = discoveryStation(stationId);
                  const marker = stationMarkerState(state, 'overview', stationId, view.resume);
                  const isLast = index === overview.stations.length - 1;
                  const stateWord = stationStateLabel(marker);
                  const nodeClasses = marker === 'resumable'
                    ? 'border-selected-ink bg-selected-ink text-panel ring-4 ring-selected-ink/15'
                    : marker === 'tried' || marker === 'seen'
                      ? 'border-ink bg-ink text-paper'
                      : marker === 'skipped'
                        ? 'border-dashed border-ink-faint bg-paper text-ink-faint'
                        : 'border-hairline-strong bg-paper text-ink-faint';
                  return (
                    <li
                      key={stationId}
                      data-discovery-station={stationId}
                      data-discovery-station-state={marker}
                      className="flex min-w-0 items-start gap-3 sm:flex-col sm:gap-2"
                    >
                      <div className="flex shrink-0 items-center sm:w-full">
                        <span
                          aria-hidden
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[12px] leading-4 font-normal tabular-nums ${nodeClasses}`}
                        >
                          {marker === 'tried' || marker === 'seen' ? (
                            <Icon name="check" size={12} />
                          ) : (
                            index + 1
                          )}
                        </span>
                        {isLast ? null : (
                          <span aria-hidden className="ml-2 hidden h-px flex-1 bg-hairline sm:block" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 sm:w-full sm:pr-2">
                        <span
                          className={`block text-[13px] leading-5 font-normal ${
                            marker === 'resumable'
                              ? 'text-selected-ink'
                              : marker === 'tried' || marker === 'seen'
                                ? 'text-ink'
                                : 'text-ink-soft'
                          }`}
                        >
                          {t(station.titleKey)}
                        </span>
                        {marker !== 'unvisited' ? (
                          <span
                            className={`mt-0.5 block text-[12px] leading-4 ${
                              marker === 'resumable' ? 'text-selected-ink' : 'text-ink-faint'
                            }`}
                          >
                            {stateWord}
                          </span>
                        ) : (
                          <span className="sr-only">{stateWord}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>

          <section className="mt-10 border-t border-hairline pt-7" aria-labelledby="discovery-topics-heading">
            <h2 id="discovery-topics-heading" className="text-[12px] leading-4 font-normal text-section-ink">
              {t('discovery.hub.topics')}
            </h2>
            <div
              className="mt-2.5 divide-y divide-hairline/80 border-y border-hairline/80"
              role="group"
              aria-labelledby="discovery-topics-heading"
            >
              {topics.map((route) => {
                const current = view.resume && state.route === route.id;
                const finished = state.lifecycle === 'finished' && state.route === route.id && !current;
                const stationStates = route.stations.map((stationId) =>
                  stationMarkerState(state, route.id, stationId, view.resume),
                );
                return (
                  <DiscoveryRouteRow
                    key={route.id}
                    route={route}
                    progress={discoveryRouteProgress(state, route.id)}
                    stationStates={stationStates}
                    current={current}
                    finished={finished}
                    onSelect={() => { void (current ? resumeDiscovery() : startRoute(route.id)); }}
                    data={{ 'data-start-route': route.id }}
                  />
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

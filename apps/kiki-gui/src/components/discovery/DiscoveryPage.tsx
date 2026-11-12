/**
 * DiscoveryPage — the help entry (/discover).
 *
 * One main path: the one-minute tour, which walks the real interface through a
 * task without calling a model. Below it, the parts someone may want to look
 * at on their own, as plain rows. A tour left part-way says where it stopped,
 * at the top, with the way back.
 *
 * Nothing here starts work or reads the model connection: starting a task is
 * the new-conversation page, and connecting a model is the card there and
 * Settings › Models.
 */

import { DISCOVERY_ROUTES, discoveryRouteProgress, type DiscoveryRouteId } from '@kiki/session-core/discovery';

import { useI18n } from '../../i18n';
import { PAGE_WIDTH, PageHeader } from '../PageChrome';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { useDiscovery } from './DiscoveryContext';
import { DiscoveryRouteRow } from './DiscoveryRouteRow';

/** The tour itself is the main path; these are the parts worth a look on their own. */
const TOPIC_ROUTES: ReadonlySet<DiscoveryRouteId> = new Set<DiscoveryRouteId>(['understand', 'sustain', 'extend']);

export function DiscoveryPage({
  onToggleSidebar,
}: {
  readonly onToggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const { state, view, startRoute, resumeDiscovery } = useDiscovery();
  const topics = DISCOVERY_ROUTES.filter((route) => TOPIC_ROUTES.has(route.id));

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-canvas text-ink" data-discovery-page>
      <PageHeader title={t('discovery.title')} onToggleSidebar={onToggleSidebar} width="reading" />

      <main className="flex-1 px-4 py-6 sm:py-8 lg:px-6">
        <div className={`mx-auto w-full ${PAGE_WIDTH.reading}`}>
          {view.resume ? (
            <p data-discovery-resume className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
              <span>{t('discovery.hub.resumeAt', { step: view.position })}</span>
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void resumeDiscovery(); }}>
                {t('discovery.continue')}
              </button>
            </p>
          ) : null}

          <section data-discovery-tour>
            <p className="max-w-[60ch] text-[14px] leading-relaxed text-ink-soft">{t('discovery.hub.intro')}</p>
            <button
              type="button"
              data-discovery-start-overview
              onClick={() => { void startRoute('overview'); }}
              className={`mt-4 ${PRIMARY_BUTTON} pointer-coarse:min-h-11`}
            >
              {t('firstRun.tour.start')}
            </button>
          </section>

          <section className="mt-10" aria-labelledby="discovery-topics-heading">
            <h2 id="discovery-topics-heading" className="text-[13px] font-medium text-ink-soft">
              {t('discovery.hub.topics')}
            </h2>
            <div className="-mx-3 mt-2" role="group" aria-labelledby="discovery-topics-heading">
              {topics.map((route) => {
                const current = view.resume && state.route === route.id;
                return (
                  <DiscoveryRouteRow
                    key={route.id}
                    route={route}
                    progress={discoveryRouteProgress(state, route.id)}
                    current={current}
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

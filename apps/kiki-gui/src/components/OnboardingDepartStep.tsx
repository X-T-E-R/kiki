/**
 * The depart page — the last step. Models come last on purpose: the user has
 * walked the guide, and connecting a model is where Kiki's value shows, so
 * this page hands off rather than configures. Nothing here writes a provider.
 *
 * Three ways out, in order. ① names the real connection paths and opens the
 * existing Connections card through the wizard's guarded navigation. ② installs
 * the `kiki-ops` skill into an agent the user already has — through the one
 * install dialog Settings owns, preview then confirm with the pinned revision —
 * and then hands over a single line to paste there. Kiki cannot yet detect
 * which hosts are installed, so the picker is a neutral list with no default
 * and no recommendation; a cancelled or failed install leaves the page as it
 * was. ③ is the quiet escape: the five discovery routes, folded away so the
 * page stays short, starting exactly as the hub's rows do through the shared
 * DiscoveryContext. The hub keeps the resume banner and the model-connection
 * row; neither is copied here.
 */

import { useState } from 'react';

import { DISCOVERY_ROUTES, discoveryRouteProgress, type DiscoveryRouteId } from '@kiki/session-core/discovery';

import { useI18n } from '../i18n';
import type { HostSkillTarget } from '../lib/client';
import { FeedbackLine, type Feedback } from './controls';
import { DisclosureChevron } from './icons';
import { DiscoveryRouteRow, useDiscovery } from './discovery';
import { HOST_SKILL_HOSTS, HostSkillInstallDialog } from './settings/HostSkillInstallCard';
import { CopyButton } from './timeline/ContentCopyButton';
import { PRIMARY_BUTTON as SHARED_PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

// On the dark accent white text falls below AA; the on-accent ink holds it.
const PRIMARY_BUTTON = `${SHARED_PRIMARY_BUTTON} dark:text-primary-foreground`;

/** Heading of one path; the circled number carries the order, the title the promise. */
function PathTitle({ children }: { readonly children: string }) {
  return <h4 className="font-display text-[14px] leading-5 font-semibold text-ink">{children}</h4>;
}

export function OnboardingDepartStep({
  onOpenModelSettings,
  onStartRoute,
  discoverBusy,
  discoverFeedback,
}: {
  readonly onOpenModelSettings: () => void;
  readonly onStartRoute: (routeId: DiscoveryRouteId) => void;
  readonly discoverBusy: boolean;
  readonly discoverFeedback: Feedback;
}) {
  const { t } = useI18n();
  const { state: discoveryState } = useDiscovery();
  const [installHost, setInstallHost] = useState<HostSkillTarget | null>(null);
  const [installedHost, setInstalledHost] = useState<HostSkillTarget | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const hostName = (id: HostSkillTarget) => t(HOST_SKILL_HOSTS.find((host) => host.id === id)!.name);
  const pasteLine = t('onboarding.depart.agent.line');

  return (
    <div className="mt-3" data-onboarding-depart>
      <section data-onboarding-depart-model className="pb-4">
        <PathTitle>{t('onboarding.depart.model.title')}</PathTitle>
        <p className="mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-ink-soft">
          {t('onboarding.depart.model.body')}
        </p>
        <button
          type="button"
          data-onboarding-model-settings
          data-autofocus
          onClick={onOpenModelSettings}
          className={`mt-3 ${PRIMARY_BUTTON}`}
        >
          {t('onboarding.depart.model.action')}
        </button>
      </section>

      <section data-onboarding-depart-agent className="border-t border-hairline py-4">
        <PathTitle>{t('onboarding.depart.agent.title')}</PathTitle>
        <p className="mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-ink-soft">
          {t('onboarding.depart.agent.body')}
        </p>
        {/* Hosts in the catalog's own order, as plain peers: no default, no
            recommendation, because Kiki cannot see which ones are installed. */}
        <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label={t('onboarding.depart.agent.title')}>
          {HOST_SKILL_HOSTS.map((host) => (
            <button
              key={host.id}
              type="button"
              data-onboarding-host={host.id}
              aria-label={t('onboarding.depart.agent.installFor', { host: t(host.name) })}
              onClick={() => { setInstallHost(host.id); }}
              className={SECONDARY_BUTTON}
            >
              {t(host.name)}
            </button>
          ))}
        </div>
        {installedHost !== null ? (
          <div className="mt-3" data-onboarding-agent-line>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              {t('onboarding.depart.agent.installed', { host: hostName(installedHost) })}
            </p>
            <div className="mt-1.5 inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-hairline bg-paper pl-2.5">
              <code className="truncate font-mono text-[12px] text-ink" title={pasteLine}>{pasteLine}</code>
              <CopyButton text={pasteLine} label={t('onboarding.depart.agent.copy')} />
            </div>
          </div>
        ) : null}
      </section>

      <section data-onboarding-depart-browse className="border-t border-hairline pt-2">
        <button
          type="button"
          data-onboarding-browse-open
          aria-expanded={browseOpen}
          onClick={() => { setBrowseOpen((open) => !open); }}
          className="group flex w-full items-center justify-between gap-3 rounded-[10px] px-1 py-2 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
        >
          <span className="min-w-0">
            <span className="block font-display text-[14px] leading-5 font-semibold text-ink">
              {t('onboarding.depart.browse.title')}
            </span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">{t('onboarding.discover.body')}</span>
          </span>
          <DisclosureChevron open={browseOpen} size={14} className="shrink-0 text-ink-faint transition-colors group-hover:text-ink" />
        </button>
        {browseOpen ? (
          <div className="mt-1 space-y-1" role="group" aria-label={t('onboarding.depart.browse.title')}>
            {/* The five routes of the shared catalog, one quiet row each: the
                whole row is the action and the stops count stays a whisper.
                No accent button here — five peer places to start, not one
                recommended action; that is ① above. */}
            {DISCOVERY_ROUTES.map((route) => (
              <DiscoveryRouteRow
                key={route.id}
                route={route}
                progress={discoveryRouteProgress(discoveryState, route.id)}
                disabled={discoverBusy}
                onSelect={() => { onStartRoute(route.id); }}
                data={{ 'data-onboarding-route': route.id }}
              />
            ))}
            <FeedbackLine feedback={discoverFeedback} />
          </div>
        ) : null}
      </section>

      {installHost !== null ? (
        <HostSkillInstallDialog
          host={installHost}
          skill="kiki-ops"
          hostName={hostName(installHost)}
          onClose={() => { setInstallHost(null); }}
          onInstalled={() => {
            setInstalledHost(installHost);
            setInstallHost(null);
          }}
        />
      ) : null}
    </div>
  );
}

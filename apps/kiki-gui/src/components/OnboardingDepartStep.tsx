/**
 * The depart page — the last step. Models come last on purpose: the user has
 * walked the guide, and connecting a model is where Kiki's value shows, so
 * this page hands off rather than configures. Nothing here writes a provider.
 *
 * Three ways out, in order:
 * ① Checks the model service readiness: if ready, start the first chat; if
 *    not ready, link directly to Settings to configure a provider.
 * ② Installs the `kiki-ops` skill into an agent the user already has, and then
 *    hands over a single line to paste there.
 * ③ 1-minute spotlight tour and 5 core discovery routes, laid out cleanly for
 *    immediate exploration without disclosure accordions.
 */

import { useState } from 'react';

import { DISCOVERY_ROUTES, discoveryRouteProgress, type DiscoveryRouteId } from '@kiki/session-core/discovery';

import { useI18n } from '../i18n';
import type { HostSkillTarget } from '../lib/client';
import { FeedbackLine, type Feedback } from './controls';
import { DiscoveryRouteRow, useDiscovery } from './discovery';
import { MODEL_SETTINGS_HREF, useModelConnection } from './discovery/ModelConnectionEntry';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
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
  onDismiss,
  onOpenModelSettings,
  onStartRoute,
  discoverBusy,
  discoverFeedback,
}: {
  readonly onDismiss?: () => void;
  readonly onOpenModelSettings?: () => void;
  readonly onStartRoute: (routeId: DiscoveryRouteId) => void;
  readonly discoverBusy: boolean;
  readonly discoverFeedback: Feedback;
}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { state: discoveryState } = useDiscovery();
  const connection = useModelConnection();
  const [installHost, setInstallHost] = useState<HostSkillTarget | null>(null);
  const [installedHost, setInstalledHost] = useState<HostSkillTarget | null>(null);

  const hostName = (id: HostSkillTarget) => t(HOST_SKILL_HOSTS.find((host) => host.id === id)!.name);
  const pasteLine = t('onboarding.depart.agent.line');

  const handleOpenModelSettings = () => {
    if (onOpenModelSettings) {
      onOpenModelSettings();
    } else {
      onDismiss?.();
      void navigate('/settings/providers?from=onboarding');
    }
  };

  const handleStartChat = () => {
    onDismiss?.();
    void navigate('/new');
  };

  return (
    <div className="mt-3" data-onboarding-depart>
      {/* 1. Model Connection Status and CTAs */}
      <section data-onboarding-depart-model className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PathTitle>{t('onboarding.depart.model.title')}</PathTitle>
          {connection.state === 'ready' ? (
            <span
              data-onboarding-model-ready
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {t('onboarding.depart.model.readyBadge')}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {t('onboarding.depart.model.notReadyBadge')}
            </span>
          )}
        </div>
        <p className="mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-ink-soft">
          {t('onboarding.depart.model.body')}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          {connection.state === 'ready' ? (
            <>
              <button
                type="button"
                data-onboarding-start-chat
                data-autofocus
                onClick={handleStartChat}
                className={PRIMARY_BUTTON}
              >
                {t('onboarding.depart.model.startChatCta')}
              </button>
              <button
                type="button"
                data-onboarding-model-settings
                onClick={handleOpenModelSettings}
                className={SECONDARY_BUTTON}
              >
                {t('discovery.model.manage')}
              </button>
            </>
          ) : (
            <button
              type="button"
              data-onboarding-model-settings
              data-autofocus
              onClick={handleOpenModelSettings}
              className={PRIMARY_BUTTON}
            >
              {t('onboarding.depart.model.configureCta')}
            </button>
          )}
        </div>
      </section>

      {/* 2. Configure via agent */}
      <section data-onboarding-depart-agent className="border-t border-hairline py-4">
        <PathTitle>{t('onboarding.depart.agent.title')}</PathTitle>
        <p className="mt-1.5 max-w-[56ch] text-[13px] leading-relaxed text-ink-soft">
          {t('onboarding.depart.agent.body')}
        </p>
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

      {/* 3. Spotlight Tour and Catalog Routes (flat, no accordion) */}
      <section data-onboarding-depart-browse className="border-t border-hairline pt-4">
        {/* 1-Minute Interactive Spotlight Tour Card */}
        <div className="rounded-xl border border-accent/30 bg-accent-soft/20 p-4 transition-colors">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-accent">
                <Icon name="compass" size={14} />
                <h4 className="font-display text-[14px] font-semibold text-ink">
                  {t('onboarding.depart.tour.title')}
                </h4>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                {t('onboarding.depart.tour.subtitle')}
              </p>
            </div>
            <button
              type="button"
              data-onboarding-tour-start
              onClick={() => { onStartRoute('overview'); }}
              className={`shrink-0 ${PRIMARY_BUTTON} text-[12px] py-1.5 px-3`}
            >
              {t('onboarding.depart.tour.startBtn')}
            </button>
          </div>
        </div>

        {/* Flat list of the 5 catalog routes */}
        <div className="mt-3 space-y-1" role="group" aria-label={t('onboarding.depart.browse.title')}>
          {DISCOVERY_ROUTES.map((route) => (
            <div key={route.id} className="w-full">
              <DiscoveryRouteRow
                route={route}
                progress={discoveryRouteProgress(discoveryState, route.id)}
                disabled={discoverBusy}
                onSelect={() => { onStartRoute(route.id); }}
                data={{ 'data-onboarding-route': route.id }}
              />
            </div>
          ))}
          <FeedbackLine feedback={discoverFeedback} />
        </div>
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

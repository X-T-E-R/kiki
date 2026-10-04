/**
 * Settings → Plugins holds only what the server owns: the catalog address
 * and the WebBridge browser runtime. Installing, enabling and inspecting
 * plugins happen on the Capabilities page; the card links there.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { CapabilityStatus } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { CatalogSourceField } from '../capabilities/AddSourceDialog';
import { CapabilityLink } from '../capabilities/CapabilityLink';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, InlineError, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

function BusyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="anim-enter flex items-center gap-2 text-[12px] leading-4 text-ink-faint">
      <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
      {children}
    </p>
  );
}

function QueryRetry({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <InlineError error={error} />
      <button type="button" className={SECONDARY_BUTTON} data-plugins-retry onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}

const WEBBRIDGE_BLOCKER_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  'daemon-binary': 'st.plugins.runtimeStep.daemon-binary',
  daemon: 'st.plugins.runtimeStep.daemon',
  skill: 'st.plugins.runtimeStep.skill',
  extension: 'st.plugins.runtimeStep.extension',
  detect: 'st.plugins.runtimeStep.detect',
};

function WebBridgeReadiness() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [confirming, setConfirming] = useState<CapabilityStatus | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [requesting, setRequesting] = useState(false);
  const query = useQuery({
    queryKey: ['capability', 'kimi-webbridge'],
    queryFn: () => client.getCapability('kimi-webbridge'),
    refetchInterval: (result) => result.state.data?.install.running ? 1_000 : false,
  });
  const capability = query.data;
  const prepare = async (plan: CapabilityStatus) => {
    const digest = plan.plan?.artifact.sha256;
    if (digest === undefined) return;
    setConfirming(null);
    setRequesting(true);
    setFeedback(null);
    try {
      await client.installCapability('kimi-webbridge', digest);
      await query.refetch();
      setFeedback({ tone: 'info', text: t('st.plugins.runtimeStarted') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRequesting(false);
    }
  };
  const steps = capability?.steps ?? [];
  // Only the steps that decide whether the feature works, not the checks that
  // merely describe it. A required step that is not ready is the one thing the
  // reader has to act on, so it names itself in the first screen.
  const blocking = steps.filter((step) => step.optional !== true && step.state !== 'ok');
  const needsSetup = capability !== undefined && capability.state !== 'unsupported' &&
    steps.some((step) => step.id === 'daemon' && step.state === 'missing');
  return (
    <SectionCard id="st-card-webbridge" title={t('st.plugins.runtimeTitle')}>
      <div className="space-y-2" data-webbridge-readiness>
        {query.isPending ? <BusyHint>{t('st.plugins.loading')}</BusyHint> : query.isError ? (
          <QueryRetry error={query.error} onRetry={() => { void query.refetch(); }} />
        ) : capability !== undefined ? (
          <>
            <p className="text-[13px] font-medium text-ink" data-webbridge-state={capability.state}>
              {t(`st.plugins.runtimeState.${capability.state}`)}
            </p>
            {capability.state === 'partial' && blocking.length > 0 ? (
              <p className="text-[12px] leading-4 text-ink-soft" data-webbridge-blocking>
                {t('st.plugins.runtimeState.partialHint', {
                  items: blocking.map((step) => t(WEBBRIDGE_BLOCKER_LABEL_KEYS[step.id] ?? 'st.plugins.runtimeStep.detect')).join('、'),
                })}
              </p>
            ) : null}
            {capability.install.running ? <BusyHint>{capability.install.step ?? t('st.plugins.runtimeStarted')}</BusyHint> : null}
            {capability.install.error ? <FeedbackLine feedback={{ tone: 'error', text: capability.install.error }} /> : null}
            {capability.plan?.browserExtensionUrl === 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc' ? (
              <a className="inline-block text-[12px] font-medium text-selected-ink hover:underline"
                href={capability.plan.browserExtensionUrl} target="_blank" rel="noopener noreferrer"
                data-webbridge-extension>
                {t('st.plugins.browserExtension')}
              </a>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }} data-webbridge-check>
                {t('st.plugins.checkHealth')}
              </button>
              {capability.plan !== undefined && needsSetup ? (
                <button type="button" className={PRIMARY_BUTTON} data-webbridge-prepare
                  disabled={requesting || capability.install.running}
                  onClick={() => { setConfirming(capability); }}>
                  {capability.install.error ? t('st.plugins.retryRuntime') : t('st.plugins.prepareRuntime')}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
        <FeedbackLine feedback={feedback} />
      </div>
      {confirming?.plan !== undefined ? (
        <ConfirmDialog open overlayId="confirm-webbridge-runtime"
          title={t('st.plugins.runtimeConfirmTitle')}
          body={t('st.plugins.runtimeConfirmBody')}
          consequences={[
            `${confirming.plan.artifact.version} · ${confirming.plan.artifact.url}`,
            `SHA-256 ${confirming.plan.artifact.sha256}`,
            confirming.plan.destination,
          ]}
          confirmLabel={t('st.plugins.prepareRuntime')}
          onCancel={() => { setConfirming(null); }}
          onConfirm={() => { void prepare(confirming); }} />
      ) : null}
    </SectionCard>
  );
}

export function PluginsSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SectionCard id="st-card-plugins" title={t('st.plugins.title')}>
        <div className="space-y-5">
          <CapabilityLink kind="plugins" />
          <CatalogSourceField />
        </div>
      </SectionCard>
      <WebBridgeReadiness />
    </div>
  );
}

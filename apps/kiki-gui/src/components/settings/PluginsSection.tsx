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
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
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

const WEBBRIDGE_STEP_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  'daemon-binary': 'st.plugins.runtimeStep.daemon-binary',
  daemon: 'st.plugins.runtimeStep.daemon',
  'daemon-identity': 'st.plugins.runtimeStep.daemon',
  skill: 'st.plugins.runtimeStep.skill',
  'plugin-integrity': 'st.plugins.runtimeStep.skill',
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
  return (
    <SectionCard id="st-card-webbridge" title={t('st.plugins.runtimeTitle')}>
      <div className="space-y-2" data-webbridge-readiness>
        <Hint>{t('st.plugins.runtimeHint')}</Hint>
        {query.isPending ? <BusyHint>{t('st.plugins.loading')}</BusyHint> : query.isError ? (
          <QueryRetry error={query.error} onRetry={() => { void query.refetch(); }} />
        ) : capability !== undefined ? (
          <>
            <p className="text-[12px] text-ink-soft" data-webbridge-state={capability.state}>
              {t(`st.plugins.runtimeState.${capability.state}`)}
            </p>
            <ul className="space-y-1">
              {capability.steps.map((step) => {
                const stepLabelKey = WEBBRIDGE_STEP_LABEL_KEYS[step.id];
                return (
                  <li className="text-[11px] text-ink-soft" key={step.id} data-webbridge-step={step.id}
                    data-webbridge-step-kind={step.optional === true ? 'verification' : 'function'}>
                    {stepLabelKey === undefined ? step.id : t(stepLabelKey)}
                    {' · '}{step.optional === true ? `${t('st.plugins.optional')} · ` : ''}
                    {t(`st.plugins.runtimeStepState.${step.state}`)}
                    {step.detail ? ` · ${step.detail}` : ''}
                  </li>
                );
              })}
            </ul>
            {capability.state === 'ready' && capability.steps.some((step) => step.optional === true && step.state !== 'ok') ? (
              <Hint>{t('st.plugins.runtimeIdentityUnverified')}</Hint>
            ) : null}
            {capability.install.running ? <BusyHint>{capability.install.step ?? t('st.plugins.runtimeStarted')}</BusyHint> : null}
            {capability.install.error ? <FeedbackLine feedback={{ tone: 'error', text: capability.install.error }} /> : null}
            {capability.install.note ? <p className="text-[11px] text-ink-soft" data-webbridge-install-note>
              {capability.install.note.endsWith('identity-unverified') || capability.install.note.endsWith('extension-unverified')
                ? t('st.plugins.runtimeIdentityUnverified') : capability.install.note}
            </p> : null}
            {capability.plan?.browserExtensionUrl === 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc' ? (
              <a className="inline-block text-[11px] font-medium text-selected-ink hover:underline"
                href={capability.plan.browserExtensionUrl} target="_blank" rel="noopener noreferrer"
                data-webbridge-extension>
                {t('st.plugins.browserExtension')}
              </a>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }} data-webbridge-check>
                {t('st.plugins.checkHealth')}
              </button>
              {capability.plan !== undefined && capability.steps.some((step) => step.id === 'daemon' &&
                step.state === 'missing' && !step.detail?.startsWith('Unverified: loopback status')) ? (
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
            confirming.plan.note,
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

/**
 * WebBridge readiness — whether the local bridge behind the Kimi route is
 * actually working, and the one action that starts it.
 *
 * It renders as one status line inside the Kimi route's open body (name ·
 * state · what is left, plus its check), not as a second fold on the row: the
 * route's own 高级 fold already carries the step-by-step detection. Its old
 * bookmark still lands here (`st-card-webbridge`): the block announces the id
 * the way a settings card does and flashes when a search hit asks for it.
 */

import { useContext, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { ExternalLink } from '../../../host/ExternalLink';
import type { CapabilityStatus } from '../../../lib/client';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, InlineError, type Feedback } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { SettingsCardMountContext, SettingsFlashContext } from '../SectionCard';

function BusyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="anim-enter flex items-center gap-2 text-[12px] leading-4 text-ink-faint">
      <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
      {children}
    </p>
  );
}

/**
 * The stale approval the bridge may still name: the store window's pending
 * approval is gone, which is a fact of the flow (the window lapsed), not a
 * failure of the bridge. It gets one quiet line plus the retry, never a red
 * error block.
 */
function isStaleApproval(error: unknown, locale: Parameters<typeof errorText>[0]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The raw envelope names it (`approval.not_found`); so does the mapped text
  // in either locale once the client has already translated it.
  if (/approval/i.test(message) && /not_?found|40401/i.test(message)) return true;
  return errorText(locale, error) === errorText(locale, new Error('approval.not_found'));
}

function QueryRetry({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t, locale } = useI18n();
  if (isStaleApproval(error, locale)) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-webbridge-approval-expired>
        <p className="text-[12px] text-ink-soft">{t('st.webbridge.approvalExpired')}</p>
        <button type="button" className={SECONDARY_BUTTON} data-plugins-retry onClick={onRetry}>
          {t('st.webbridge.reconnect')}
        </button>
      </div>
    );
  }
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

function isValidHttpUrl(url: string | undefined): boolean {
  if (url === undefined || url === '') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function WebBridgeReadiness() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [confirming, setConfirming] = useState<CapabilityStatus | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [requesting, setRequesting] = useState(false);
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => { onCardMount?.('st-card-webbridge'); }, [onCardMount]);
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
  const runtimeMissing = steps.some((step) => (step.id === 'daemon' || step.id === 'skill') && (step.state === 'missing' || step.state === 'failed'));
  const stepFailed = steps.some((step) => step.state === 'failed');
  const needsSetup = capability !== undefined && capability.state !== 'unsupported' && (capability.state === 'not_installed' || runtimeMissing || stepFailed);
  return (
    <div
      id="st-card-webbridge"
      data-settings-card="st-card-webbridge"
      data-webbridge-readiness
      className={`mt-2.5 scroll-mt-4 space-y-2 text-[12px] ${flashId === 'st-card-webbridge' ? 'settings-card-flash' : ''}`}
    >
      {/* A status line, not a fold: what the bridge is, in the route's own
          words, with its one check beside it. */}
      {query.isPending ? <BusyHint>{t('st.plugins.loading')}</BusyHint> : query.isError ? (
        <QueryRetry error={query.error} onRetry={() => { void query.refetch(); }} />
      ) : capability !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-ink-soft">
            <span className="text-ink">{t('st.plugins.runtimeTitle')}</span>
            <span data-webbridge-state={capability.state}>{` · ${t(`st.plugins.runtimeState.${capability.state}`)}`}</span>
            {capability.state === 'partial' && blocking.length > 0 ? (
              <span className="text-ink-faint" data-webbridge-blocking>
                {` · ${t('st.plugins.runtimeState.partialHint', {
                  items: blocking.map((step) => t(WEBBRIDGE_BLOCKER_LABEL_KEYS[step.id] ?? 'st.plugins.runtimeStep.detect')).join('、'),
                })}`}
              </span>
            ) : null}
          </p>
          {capability.install.running ? <BusyHint>{capability.install.step ?? t('st.plugins.runtimeStarted')}</BusyHint> : null}
          {capability.install.error ? <FeedbackLine feedback={{ tone: 'error', text: capability.install.error }} /> : null}
          <span className="flex flex-wrap items-center gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }} data-webbridge-check>
              {t('st.plugins.checkHealth')}
            </button>
            {capability.plan !== undefined && needsSetup ? (
              <button type="button" className={SECONDARY_BUTTON} data-webbridge-prepare
                disabled={requesting || capability.install.running}
                onClick={() => { setConfirming(capability); }}>
                {capability.install.error || steps.some((step) => step.state === 'failed') ? t('st.plugins.retryRuntime') : t('st.plugins.prepareRuntime')}
              </button>
            ) : null}
            {isValidHttpUrl(capability.plan?.browserExtensionUrl) ? (
              <ExternalLink className="inline-block text-[12px] text-selected-ink hover:underline"
                href={capability.plan!.browserExtensionUrl!}
                data-webbridge-extension>
                {t('st.plugins.browserExtension')}
              </ExternalLink>
            ) : null}
          </span>
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
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
    </div>
  );
}
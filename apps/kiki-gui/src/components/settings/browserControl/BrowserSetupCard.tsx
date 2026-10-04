import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SectionCard } from '../SectionCard';
import { AdvancedDetails } from '../fields';
import { SettingsSelect } from '../SettingsPrimitives';
import { Link } from 'react-router-dom';
import { experimentalCardId, experimentalSectionForFlag } from '@kiki/session-core/settings';

const ID = 'kiki-browser';
const STEP_KEYS: Readonly<Record<string, I18nKey>> = {
  'driver-download': 'st.browser.setup.driverDownload',
  'chrome-metadata': 'st.browser.setup.chromeMetadata',
  'chrome-download': 'st.browser.setup.chromeDownload',
  extract: 'st.browser.setup.extract',
  verify: 'st.browser.setup.verify',
};

export function BrowserSetupCard() {
  const { client, scopeId, sshLabel } = useConnection();
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const key = ['capability', ID, scopeId];
  const flag = useQuery({ queryKey: ['browser-native-flag', scopeId], queryFn: () => client.klient.global.flags.enabled('native_browser') });
  const query = useQuery({ queryKey: key, queryFn: () => client.getCapability(ID),
    refetchInterval: (result) => result.state.data?.install.running === true ? 1_000 : false });
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [mode, setMode] = useState<'managed-browser' | 'driver-only'>('managed-browser');
  const status = query.data;
  const driverReady = status?.steps.find((step) => step.id === 'driver')?.state === 'ok';
  const chromeReady = status?.steps.find((step) => step.id === 'chrome')?.state === 'ok';

  const run = async (cancel: boolean) => {
    if (status?.plan === undefined) return;
    setRequesting(true);
    setFeedback(null);
    try {
      const next = cancel ? await client.cancelCapability(ID) : await client.installCapability(ID, status.plan.artifact.sha256, mode);
      queries.setQueryData(key, next);
    } catch (error) { setFeedback({ tone: 'error', text: errorText(locale, error) }); }
    finally { setRequesting(false); }
  };

  return (
    <SectionCard id="st-card-browser-setup" title={t('st.browser.setup.title')}>
      <div className="space-y-3" data-browser-setup>
        <Hint>{sshLabel === null ? t('st.browser.setup.host') : t('st.browser.setup.hostSsh', { label: sshLabel })}</Hint>
        {flag.data === false ? <p className="flex flex-wrap items-baseline gap-2 text-[12px] text-ink-soft" data-browser-setup-flag>
          {t('st.browser.setup.flagOff')}
          <Link className="underline underline-offset-2" to={`/settings/${experimentalSectionForFlag('native_browser')}#${experimentalCardId(experimentalSectionForFlag('native_browser'))}`}>{t('st.browser.flagOffAction')}</Link>
        </p> : null}
        {query.isPending ? <p className="text-[12px] text-ink-faint" role="status">{t('st.browser.setup.detecting')}</p>
          : query.isError || status === undefined ? <div className="space-y-2"><InlineError error={query.error} /><button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }}>{t('common.retry')}</button></div>
            : <>
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <span className="text-[12px] text-ink-soft">{t('st.browser.setup.mode')}</span>
                <SettingsSelect<'managed-browser' | 'driver-only'> id="browser-setup-mode" ariaLabel={t('st.browser.setup.mode')} dataAttr="data-browser-setup-mode" value={mode} disabled={requesting || status.install.running}
                  choices={[{ value: 'managed-browser', label: t('st.browser.setup.modeProfile') }, { value: 'driver-only', label: t('st.browser.setup.modeCdp') }]} onChange={setMode} />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink" data-browser-setup-state={status.state}>
                <span>{t('st.browser.setup.driver')} · {t(driverReady ? 'st.browser.setup.ready' : 'st.browser.setup.missing')}</span>
                <span>{t('st.browser.setup.chrome')} · {t(chromeReady ? 'st.browser.setup.ready' : 'st.browser.setup.missing')}</span>
                <span className="ml-auto flex gap-2">
                  <button type="button" className={SECONDARY_BUTTON} data-browser-setup-check disabled={requesting} onClick={() => { void query.refetch(); }}>{t('st.browser.setup.check')}</button>
                  {status.supported && (!driverReady || (mode === 'managed-browser' && !chromeReady)) && !status.install.running ? <button type="button" className={PRIMARY_BUTTON} data-browser-install disabled={requesting} onClick={() => { void run(false); }}>{t(status.install.error === undefined ? 'st.browser.setup.install' : 'st.browser.setup.retry')}</button> : null}
                </span>
              </div>
              {status.supported ? <Hint>{t(driverReady && (chromeReady || mode === 'driver-only') ? 'st.browser.setup.next' : 'st.browser.setup.scope')}</Hint> : <Hint>{t('st.browser.setup.unsupported')}</Hint>}
              {mode === 'driver-only' ? <Hint>{t('st.browser.setup.modeCdpHint')}</Hint> : null}
              {status.install.running ? <div className="flex flex-wrap items-center gap-3" role="status" data-browser-install-progress>
                <span className="text-[12px] text-ink-soft">{t(STEP_KEYS[status.install.step ?? ''] ?? 'st.browser.setup.installing')}{status.install.percent === undefined ? '' : ` · ${Math.round(status.install.percent)}%`}</span>
                <button type="button" className={SECONDARY_BUTTON} data-browser-install-cancel disabled={requesting} onClick={() => { void run(true); }}>{t('common.cancel')}</button>
              </div> : null}
              {status.install.note === 'cancelled' ? <p className="text-[12px] text-ink-soft" role="status">{t('st.browser.setup.cancelled')}</p> : null}
              {status.install.error === undefined ? null : <FeedbackLine feedback={{ tone: 'error', text: status.install.error }} />}
              <AdvancedDetails summary={t('st.browser.setup.details')}>
                <div className="space-y-1 text-[11px] text-ink-soft">
                  <p>{t('st.browser.setup.integrity')}</p>
                  <p className="break-all font-mono">{status.plan?.destination}</p>
                  {status.steps.map((step) => <p key={step.id}>{step.id} · {t(`st.plugins.runtimeStepState.${step.state}`)}{step.detail === undefined ? '' : ` · ${step.detail}`}</p>)}
                </div>
              </AdvancedDetails>
            </>}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

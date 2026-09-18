import { useState } from 'react';

import { readDesktopPrefs, writeDesktopPrefs } from '@kiki/session-core/settings';
import { useHost, type DesktopUpdate } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { requestOnboardingOpen } from '../OnboardingWizard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

export function AboutSection() {
  const host = useHost();
  const { meta } = useConnection();
  const { t } = useI18n();
  const guiVersion = import.meta.env['VITE_APP_VERSION'] ?? '0.0.0-dev';
  const buildSha = import.meta.env['VITE_BUILD_SHA'] as string | undefined;
  const isDesktop = host.kind === 'tauri';
  const [channel, setChannel] = useState<'stable' | 'beta'>(() => readDesktopPrefs().updateChannel);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'installing'>('idle');
  const [updateMessage, setUpdateMessage] = useState<Feedback>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  const checkForUpdate = () => {
    if (host.kind !== 'tauri') return;
    setUpdateStatus('checking');
    setUpdateMessage(null);
    void host.checkDesktopUpdate()
      .then((next) => {
        setUpdate(next);
        setUpdateMessage(next === null ? { tone: 'success', text: t('st.about.upToDate') } : null);
      })
      .catch((error: unknown) => {
        setUpdate(null);
        setUpdateMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { setUpdateStatus('idle'); });
  };

  const installUpdate = () => {
    if (update === null) return;
    setConfirmInstall(false);
    setUpdateStatus('installing');
    setUpdateMessage(null);
    void update.install().catch((error: unknown) => {
      setUpdateStatus('idle');
      setUpdateMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };

  const versionRows: { label: string; value: string }[] = [
    { label: t('st.about.desktopVersion'), value: guiVersion },
    { label: t('st.about.serverVersion'), value: meta.server_version },
    ...(buildSha !== undefined && buildSha !== ''
      ? [{ label: t('st.about.build'), value: buildSha.slice(0, 12) }]
      : []),
    { label: t('st.about.serverId'), value: meta.server_id },
    { label: t('st.about.backend'), value: meta.backend ?? 'v1' },
  ];

  return (
    <SectionCard id="st-card-about" title={t('st.about.title')}>
      <dl className="space-y-1.5 text-[12.5px]">
        {versionRows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4">
            <dt className="shrink-0 text-ink-faint">{row.label}</dt>
            <dd className="break-all text-right font-mono text-[12px] text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>

      {isDesktop ? (
        <div className="mt-4 space-y-3 border-t border-hairline pt-4">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div>
              <span className="text-[12.5px] font-medium text-ink">{t('st.about.channel')}</span>
              {channel === 'beta' ? (
                <p className="mt-0.5 text-[11px] leading-relaxed text-amber-ink">{t('st.about.betaHint')}</p>
              ) : null}
            </div>
            <select
              value={channel}
              aria-label={t('st.about.channel')}
              onChange={(event) => {
                const next = event.target.value === 'beta' ? 'beta' : 'stable';
                setChannel(next);
                setUpdate(null);
                setUpdateMessage(null);
                writeDesktopPrefs({ updateChannel: next });
                void host.writeDesktopPrefs?.({ updateChannel: next });
              }}
              className={SMALL_INPUT}
            >
              <option value="stable">{t('st.about.stable')}</option>
              <option value="beta">{t('st.about.beta')}</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={checkForUpdate} disabled={updateStatus !== 'idle'} className={SECONDARY_BUTTON}>
              {updateStatus === 'checking' ? t('st.about.checking') : t('st.about.checkUpdate')}
            </button>
            {update !== null ? (
              <button type="button" onClick={() => { setConfirmInstall(true); }} disabled={updateStatus !== 'idle'} className={PRIMARY_BUTTON}>
                {updateStatus === 'installing' ? t('st.about.installing') : t('st.about.install', { version: update.version })}
              </button>
            ) : null}
          </div>
          {update?.notes !== undefined && update.notes !== '' ? <p className="whitespace-pre-wrap text-[11.5px] text-ink-soft">{update.notes}</p> : null}
          <FeedbackLine feedback={updateMessage} />
        </div>
      ) : (
        <div className="mt-4 border-t border-hairline pt-3">
          <Hint>{t('st.about.browserHint')}</Hint>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-hairline pt-4">
        <Hint>{t('onboarding.reenterHint')}</Hint>
        <button
          type="button"
          onClick={() => { requestOnboardingOpen(); }}
          className={SECONDARY_BUTTON}
        >
          {t('onboarding.reenter')}
        </button>
      </div>

      <ConfirmDialog
        open={confirmInstall && update !== null}
        overlayId="confirm-about-install"
        title={update === null ? '' : t('st.about.install', { version: update.version })}
        body={update === null ? undefined : t('st.about.installConfirm', { version: update.version })}
        confirmLabel={update === null ? '' : t('st.about.install', { version: update.version })}
        tone="danger"
        busy={updateStatus === 'installing'}
        onConfirm={installUpdate}
        onCancel={() => { setConfirmInstall(false); }}
      />
    </SectionCard>
  );
}

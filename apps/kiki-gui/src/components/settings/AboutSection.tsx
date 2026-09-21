import { useEffect, useState } from 'react';

import {
  readDesktopPrefs,
  writeDesktopPrefs,
  type AutoUpdateMode,
} from '@kiki/session-core/settings';
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
  const initialPrefs = readDesktopPrefs();
  const [channel, setChannel] = useState<'stable' | 'beta'>(initialPrefs.updateChannel);
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateMode>(initialPrefs.autoUpdate);
  const [updatesSupported, setUpdatesSupported] = useState<boolean | null>(null);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'installing'>('idle');
  const [updateMessage, setUpdateMessage] = useState<Feedback>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    let active = true;
    void host.supportsDesktopUpdates().then(
      (supported) => { if (active) setUpdatesSupported(supported); },
      () => { if (active) setUpdatesSupported(false); },
    );
    return () => { active = false; };
  }, [host]);

  const checkForUpdate = () => {
    if (host.kind !== 'tauri' || updatesSupported !== true) return;
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
    void update.install()
      .then(() => {
        setUpdate(null);
        setUpdateMessage({ tone: 'success', text: t('st.about.installedRestart') });
      })
      .catch((error: unknown) => {
        setUpdateMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { setUpdateStatus('idle'); });
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
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[12.5px] font-medium text-ink">{t('st.about.channel')}</span>
              <select
                value={channel}
                aria-label={t('st.about.channel')}
                disabled={updatesSupported !== true}
                onChange={(event) => {
                  const next = event.target.value === 'beta' ? 'beta' : 'stable';
                  setChannel(next);
                  setUpdate(null);
                  setUpdateMessage(null);
                  writeDesktopPrefs({ updateChannel: next });
                  void host.writeDesktopPrefs({ updateChannel: next });
                }}
                className={`${SMALL_INPUT} w-full`}
              >
                <option value="stable">{t('st.about.stable')}</option>
                <option value="beta">{t('st.about.beta')}</option>
              </select>
              {channel === 'beta' ? (
                <p className="text-[11px] leading-relaxed text-amber-ink">{t('st.about.betaHint')}</p>
              ) : null}
            </label>
            <label className="space-y-1">
              <span className="text-[12.5px] font-medium text-ink">{t('st.about.autoUpdate')}</span>
              <select
                value={autoUpdate}
                aria-label={t('st.about.autoUpdate')}
                disabled={updatesSupported !== true}
                onChange={(event) => {
                  const value = event.target.value;
                  const next: AutoUpdateMode = value === 'off' || value === 'install' ? value : 'notify';
                  setAutoUpdate(next);
                  writeDesktopPrefs({ autoUpdate: next });
                  void host.writeDesktopPrefs({ autoUpdate: next });
                }}
                className={`${SMALL_INPUT} w-full`}
              >
                <option value="off">{t('st.about.autoUpdateOff')}</option>
                <option value="notify">{t('st.about.autoUpdateNotify')}</option>
                <option value="install">{t('st.about.autoUpdateInstall')}</option>
              </select>
            </label>
          </div>
          {updatesSupported === false ? <Hint>{t('st.about.updatesUnavailable')}</Hint> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={checkForUpdate} disabled={updatesSupported !== true || updateStatus !== 'idle'} className={SECONDARY_BUTTON}>
              {updateStatus === 'checking' ? t('st.about.checking') : t('st.about.checkUpdate')}
            </button>
            {update !== null ? (
              <button type="button" onClick={() => { setConfirmInstall(true); }} disabled={updatesSupported !== true || updateStatus !== 'idle'} className={PRIMARY_BUTTON}>
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

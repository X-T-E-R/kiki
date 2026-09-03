import { useState } from 'react';

import { readDesktopPrefs, writeDesktopPrefs } from '@kiki/session-core/settings';
import { useHost, type DesktopUpdate } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
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
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  const checkForUpdate = () => {
    if (host.kind !== 'tauri') return;
    setUpdateStatus('checking');
    setUpdateMessage(null);
    void host.checkDesktopUpdate()
      .then((next) => {
        setUpdate(next);
        setUpdateMessage(next === null ? t('st.about.upToDate') : null);
      })
      .catch((error: unknown) => {
        setUpdate(null);
        setUpdateMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => { setUpdateStatus('idle'); });
  };

  const installUpdate = () => {
    if (update === null || !window.confirm(t('st.about.installConfirm', { version: update.version }))) return;
    setUpdateStatus('installing');
    setUpdateMessage(null);
    void update.install().catch((error: unknown) => {
      setUpdateStatus('idle');
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <SectionCard id="st-card-about" title={t('st.about.title')}>
      <div className="space-y-2 text-[12.5px] text-ink-soft">
        <p>{t('st.about.desktopVersion')}: <span className="font-mono text-ink">{guiVersion}</span></p>
        <p>{t('st.about.serverVersion')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
        {buildSha !== undefined && buildSha !== '' ? <p>{t('st.about.build')}: <span className="font-mono text-ink">{buildSha.slice(0, 12)}</span></p> : null}
        <p>{t('st.about.serverId')}: <span className="font-mono text-ink">{meta.server_id}</span></p>
        <p>{t('st.about.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
      </div>

      {isDesktop ? (
        <div className="mt-4 space-y-3 border-t border-hairline pt-4">
          <label className="flex items-center justify-between gap-4 text-[12.5px] text-ink-soft">
            <span>{t('st.about.channel')}</span>
            <select
              value={channel}
              onChange={(event) => {
                const next = event.target.value === 'beta' ? 'beta' : 'stable';
                setChannel(next);
                setUpdate(null);
                setUpdateMessage(null);
                writeDesktopPrefs({ updateChannel: next });
                void host.writeDesktopPrefs?.({ updateChannel: next });
              }}
              className="rounded-lg border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              <option value="stable">{t('st.about.stable')}</option>
              <option value="beta">{t('st.about.beta')}</option>
            </select>
          </label>
          {channel === 'beta' ? <p className="text-[11.5px] text-amber-ink">{t('st.about.betaHint')}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={checkForUpdate} disabled={updateStatus !== 'idle'} className={SECONDARY_BUTTON}>
              {updateStatus === 'checking' ? t('st.about.checking') : t('st.about.checkUpdate')}
            </button>
            {update !== null ? (
              <button type="button" onClick={installUpdate} disabled={updateStatus !== 'idle'} className={PRIMARY_BUTTON}>
                {updateStatus === 'installing' ? t('st.about.installing') : t('st.about.install', { version: update.version })}
              </button>
            ) : null}
          </div>
          {update?.notes !== undefined && update.notes !== '' ? <p className="whitespace-pre-wrap text-[11.5px] text-ink-soft">{update.notes}</p> : null}
          {updateMessage !== null ? <p className="font-mono text-[11px] text-ink-soft">{updateMessage}</p> : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

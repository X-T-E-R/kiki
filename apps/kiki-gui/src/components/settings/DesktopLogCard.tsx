import { useEffect, useState } from 'react';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { DESKTOP_LOG_LEVELS, writeDesktopPrefs, type DesktopLogLevel } from '@kiki/session-core/settings';
import { useHost, type DesktopLogInfo } from '../../host';
import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { FeedbackLine, SaveStatus, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSelect } from './SettingsPrimitives';
import { useInstantSave } from './useInstantSave';

/** Human size for the rotation line: 5 MiB, 512 KiB. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * About › Desktop log (desktop runtime only): where the backend writes its
 * log, a button to open that folder, and the verbosity the next backend
 * launch uses. The level never reconfigures a running or externally managed
 * backend, so the card says when it takes effect. Browser and remote clients
 * have no local log folder and render nothing.
 */
export function DesktopLogCard() {
  const host = useHost();
  const { t, locale } = useI18n();
  const save = useInstantSave();
  const [info, setInfo] = useState<DesktopLogInfo | null>(null);
  const [loadError, setLoadError] = useState<Feedback>(null);
  const [level, setLevel] = useState<DesktopLogLevel | null>(null);
  const [savedLevel, setSavedLevel] = useState<DesktopLogLevel | null>(null);
  const [opening, setOpening] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<Feedback>(null);
  const desktop = host.kind === 'tauri';

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    let active = true;
    host.desktopLogInfo().then(
      (next) => {
        if (!active) return;
        setInfo(next);
        setLevel(next.logLevel);
        setSavedLevel(next.logLevel);
      },
      (error: unknown) => { if (active) setLoadError({ tone: 'error', text: errorText(locale, error) }); },
    );
    return () => { active = false; };
  }, [host, locale]);

  if (!desktop) return null;

  const changeLevel = (next: DesktopLogLevel) => {
    if (host.kind !== 'tauri') return;
    setLevel(next);
    void save.run(async () => {
      await host.writeDesktopPrefs({ logLevel: next });
      writeDesktopPrefs({ logLevel: next });
    }).then((ok) => { if (!ok) setLevel(savedLevel); });
  };

  const openFolder = () => {
    if (host.kind !== 'tauri') return;
    setOpening(true);
    setActionFeedback(null);
    void host.openDesktopLogDirectory()
      .catch((error: unknown) => { setActionFeedback({ tone: 'error', text: t('st.desktopLog.openFailed', { detail: errorText(locale, error) }) }); })
      .finally(() => { setOpening(false); });
  };

  const copyPath = () => {
    if (info === null) return;
    void copyTextToClipboard(info.backendLogPath).then(
      () => { setActionFeedback({ tone: 'success', text: t('st.desktopLog.copied') }); },
      (error: unknown) => { setActionFeedback({ tone: 'error', text: errorText(locale, error) }); },
    );
  };

  // The level on disk differs from what the running backend was started with.
  const pendingRestart = info !== null && level !== null && level !== info.logLevel && info.appliesOnNextLaunch;

  return (
    <SectionCard id="st-card-desktop-log" title={t('st.desktopLog.title')} scope="app">
      <div className="space-y-3">
        {info !== null ? (
          <div data-desktop-log-path className="space-y-1.5">
            <p className="text-[13px] text-ink">{t('st.desktopLog.fileLabel')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 max-w-full flex-1 break-all rounded-md bg-ink/[0.04] px-3 py-1.5 font-mono text-[11.5px] text-ink-soft">
                {info.backendLogPath}
              </code>
              <button type="button" onClick={copyPath} className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                aria-label={t('st.desktopLog.copyAria')}>
                <Icon name="copy" size={12} />
                {t('st.desktopLog.copy')}
              </button>
              <button type="button" data-desktop-log-open onClick={openFolder} disabled={opening}
                className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}>
                <Icon name="external" size={12} />
                {opening ? t('st.desktopLog.opening') : t('st.desktopLog.openFolder')}
              </button>
            </div>
            <p className="text-[12px] text-ink-faint">
              {t('st.desktopLog.rotation', { size: formatBytes(info.maxBytes), count: info.backups })}
            </p>
          </div>
        ) : null}
        <FeedbackLine feedback={actionFeedback} />
        {level !== null ? (
          <SettingField label={t('st.desktopLog.levelLabel')} help={t('st.desktopLog.levelHint')}>
            <SaveStatus saving={save.saving} saved={save.saved} />
            <SettingsSelect<DesktopLogLevel>
              ariaLabel={t('st.desktopLog.levelLabel')}
              dataAttr="data-desktop-log-level"
              mono
              value={level}
              disabled={save.saving}
              onChange={changeLevel}
              choices={DESKTOP_LOG_LEVELS.map((value) => ({
                value,
                label: value,
                hint: t(`st.desktopLog.level.${value}` as I18nKey),
              }))}
            />
          </SettingField>
        ) : null}
        {pendingRestart ? (
          <p data-desktop-log-pending className="text-[12px] text-amber-ink">
            {t('st.desktopLog.pending', { current: info.logLevel, next: level })}
          </p>
        ) : null}
        <FeedbackLine feedback={save.error ?? loadError} />
      </div>
    </SectionCard>
  );
}

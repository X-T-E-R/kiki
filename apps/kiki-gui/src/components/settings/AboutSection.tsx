import { useEffect, useRef, useState } from 'react';

import {
  readDesktopPrefs,
  writeDesktopPrefs,
  type AutoUpdateMode,
  type DesktopNativePrefs,
} from '@kiki/session-core/settings';
import { useHost, type DesktopUpdate } from '../../host';
import { isDesktopUpdateSelectionChanged } from '../../host/host';
import { useI18n } from '../../i18n';
import { checkForUpdateNow, hydrateUpdatePrefs, persistUpdatePreference, resetUpdateCheckCache } from '../../lib/desktopUpdates';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../controls';
import { requestOnboardingOpen } from '../OnboardingWizard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { DependentField, SettingField } from './fields';
import { SettingsSelect } from './SettingsPrimitives';

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
  const [persistError, setPersistError] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const checkGeneration = useRef(0);
  const installRunning = useRef(false);
  const confirmed = useRef({ autoUpdate: initialPrefs.autoUpdate, updateChannel: initialPrefs.updateChannel });
  const writes = useRef({ autoUpdate: 0, updateChannel: 0 });
  useEffect(() => () => { checkGeneration.current += 1; }, []);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    let active = true;
    void host.supportsDesktopUpdates().then(
      (supported) => { if (active) setUpdatesSupported(supported); },
      () => { if (active) setUpdatesSupported(false); },
    );
    return () => { active = false; };
  }, [host]);

  // Checking and installing stay one control on purpose. A manual check always
  // runs, whatever the automatic preference or a skipped version says, and it
  // says plainly whether there was something new.
  const checkForUpdate = () => {
    if (host.kind !== 'tauri' || updatesSupported !== true || installRunning.current) return;
    const generation = ++checkGeneration.current;
    setUpdateStatus('checking');
    setUpdateMessage(null);
    void checkForUpdateNow(host, Date.now(), channel)
      .then(({ result, persisted }) => {
        if (generation !== checkGeneration.current || readDesktopPrefs().updateChannel !== channel) return;
        if (!persisted) setPersistError(t('st.about.updateDialog.persistFailed'));
        if (result.kind === 'update') {
          setUpdate(result.update);
          setUpdateMessage(null);
          return;
        }
        setUpdate(null);
        setUpdateMessage({
          tone: result.kind === 'failed' ? 'error' : 'success',
          text: result.kind === 'failed' ? t('st.about.checkFailed') : t('st.about.upToDate'),
        });
      })
      .finally(() => { if (generation === checkGeneration.current) setUpdateStatus('idle'); });
  };

  const installUpdate = () => {
    if (update === null || installRunning.current) return;
    installRunning.current = true;
    setConfirmInstall(false);
    setUpdateStatus('installing');
    setUpdateMessage(null);
    void Promise.resolve().then(() => update.install())
      .then(() => {
        setUpdate(null);
        setUpdateMessage({ tone: 'success', text: t('st.about.installedRestart') });
      })
      .catch(async (error: unknown) => {
        if (isDesktopUpdateSelectionChanged(error)) {
          setUpdate(null);
          resetUpdateCheckCache();
          await hydrateUpdatePrefs(host);
          const current = readDesktopPrefs();
          confirmed.current = { autoUpdate: current.autoUpdate, updateChannel: current.updateChannel };
          checkGeneration.current += 1;
          setChannel(current.updateChannel);
          setAutoUpdate(current.autoUpdate);
        }
        setUpdateMessage({ tone: 'error', text: t('st.about.installFailed') });
      })
      .finally(() => { installRunning.current = false; setUpdateStatus('idle'); });
  };

  /** Ordered writes advance the confirmed value; only the latest failure may restore it. */
  const writeNative = <K extends 'autoUpdate' | 'updateChannel'>(key: K, next: DesktopNativePrefs[K]) => {
    setPersistError(null);
    if (host.kind !== 'tauri') return;
    const generation = ++writes.current[key];
    void persistUpdatePreference(host, { [key]: next } as Partial<DesktopNativePrefs>).then(
      () => { confirmed.current[key] = next; },
      async () => {
        if (generation !== writes.current[key]) return;
        // A failed write may follow a successful choice in another window.
        const native = await host.readDesktopPrefs?.().catch(() => null);
        if (generation !== writes.current[key]) return;
        if (native?.[key] !== undefined) confirmed.current[key] = native[key];
        const previous = confirmed.current[key];
        writeDesktopPrefs({ [key]: previous });
        if (key === 'autoUpdate') setAutoUpdate(confirmed.current.autoUpdate);
        else {
          checkGeneration.current += 1;
          setChannel(confirmed.current.updateChannel);
          setUpdate(null);
          setConfirmInstall(false);
          if (!installRunning.current) setUpdateStatus('idle');
        }
        setPersistError(t('st.about.prefsSaveFailed'));
      },
    );
  };

  const writeMode = (next: AutoUpdateMode) => {
    setAutoUpdate(next);
    writeDesktopPrefs({ autoUpdate: next });
    writeNative('autoUpdate', next);
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
          <SettingField label={t('st.about.channel')}
            help={channel === 'beta' ? <span className="text-amber-ink">{t('st.about.betaHint')}</span> : undefined}>
            <SettingsSelect<'stable' | 'beta'>
              ariaLabel={t('st.about.channel')}
              value={channel}
              disabled={updatesSupported !== true}
              onChange={(next) => {
                checkGeneration.current += 1;
                setChannel(next);
                setUpdate(null);
                setConfirmInstall(false);
                if (!installRunning.current) setUpdateStatus('idle');
                setUpdateMessage(null);
                writeDesktopPrefs({ updateChannel: next });
                writeNative('updateChannel', next);
              }}
              choices={[
                { value: 'stable', label: t('st.about.stable') },
                { value: 'beta', label: t('st.about.beta') },
              ]}
            />
          </SettingField>
          {/* One switch, then the one question it opens. With checking off there
              is nothing left to choose, so the second row is not rendered. */}
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.about.autoCheck')}
              checked={autoUpdate !== 'off'}
              disabled={updatesSupported !== true}
              onChange={(checked) => { writeMode(checked ? 'notify' : 'off'); }}
            />
            <Hint>
              {autoUpdate === 'off'
                ? t('st.about.autoCheckOffHint')
                : autoUpdate === 'install'
                  // What happens next differs by mode. This line sits directly
                  // above the select that chooses the mode, so the clause reads
                  // as describing that choice rather than as a safety promise
                  // that only one of its two values keeps.
                  ? t('st.about.autoCheckInstallHint')
                  : t('st.about.autoCheckHint')}
            </Hint>
          </div>
          <DependentField when={autoUpdate !== 'off' && updatesSupported === true}>
            <SettingField label={t('st.about.whenFound')}>
              <SettingsSelect<Exclude<AutoUpdateMode, 'off'>>
                ariaLabel={t('st.about.whenFound')}
                value={autoUpdate === 'off' ? 'notify' : autoUpdate}
                onChange={(next) => { writeMode(next); }}
                choices={[
                  { value: 'notify', label: t('st.about.autoUpdateNotify') },
                  { value: 'install', label: t('st.about.autoUpdateInstall') },
                ]}
              />
            </SettingField>
          </DependentField>
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
          {persistError === null ? null : (
            <FeedbackLine feedback={{ tone: 'error', text: persistError }} />
          )}
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

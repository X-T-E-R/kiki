import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PermissionMode } from '@kiki/protocol';

import { clearStoredDrafts } from '@kiki/session-core/composer';
import { errorText, type Locale } from '@kiki/session-core/i18n';
import {
  readDesktopPrefs,
  readSettings,
  writeDesktopPrefs,
  writeSettings,
  type SendShortcut,
  type ThemePreference,
} from '@kiki/session-core/settings';
import type { KikiConfigResponse } from '@kiki/session-core/transport';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { ExperimentalSection } from './ExperimentalSection';
import { SessionTitleModelFields } from './SessionTitleModelSettings';
import { mergeConfigEcho } from './configEcho';
import { useSavedTick } from './useSavedTick';

export function GeneralSection() {
  const host = useHost();
  const { client } = useConnection();
  const { t, locale, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(readSettings);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('manual');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const isDesktop = host.kind === 'tauri';

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const syncFromConfig = useCallback((config: KikiConfigResponse | undefined) => {
    if (config === undefined) return;
    const mode = config.default_permission_mode;
    if (mode === 'manual' || mode === 'auto' || mode === 'yolo') setPermissionMode(mode);
  }, []);

  useEffect(() => { syncFromConfig(configQuery.data); }, [configQuery.data, syncFromConfig]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) {
        setDesktopPrefs(prefs);
        writeDesktopPrefs(prefs);
      }
    });
  }, [host]);

  // The permission default saves independently from planning defaults. The
  // narrow patch keeps the plan configuration untouched on this page.
  const applyPermissionMode = async (mode: PermissionMode) => {
    setPermissionMode(mode);
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_permission_mode: mode });
      const merged = mergeConfigEcho(
        queryClient.getQueryData<KikiConfigResponse>(['config']) ?? configQuery.data,
        echoed,
      );
      queryClient.setQueryData(['config'], merged);
      syncFromConfig(merged);
      const echoedMode = merged.default_permission_mode;
      if (echoedMode === 'manual' || echoedMode === 'auto' || echoedMode === 'yolo') {
        writeSettings({ defaultPermissionMode: echoedMode });
      }
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncFromConfig(configQuery.data);
    } finally {
      setSaving(false);
    }
  };

  const updateLocal = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeSettings(patch);
  };

  return (
    <div className="space-y-3">
      <SectionCard id="st-card-language" title={t('st.language.title')}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Hint>{t('st.language.hint')}</Hint>
          <select
            id="language-select"
            aria-label={t('st.language.title')}
            className={SMALL_INPUT}
            value={locale}
            onChange={(event) => { setLocale(event.target.value as Locale); }}
          >
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </div>
      </SectionCard>

      <SectionCard id="st-card-appearance" title={t('st.appearance.title')}>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span id="theme-label" className="text-[12.5px] font-medium text-ink">
              {t('st.appearance.theme')}
            </span>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="theme-label">
              {(['light', 'dark', 'system'] as ThemePreference[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  data-theme-choice={choice}
                  aria-pressed={settings.theme === choice}
                  onClick={() => { updateLocal({ theme: choice }); }}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    settings.theme === choice
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {t(`st.appearance.theme.${choice}`)}
                </button>
              ))}
            </div>
          </div>
          <Hint>{t('st.appearance.themeHint')}</Hint>
        </div>
      </SectionCard>

      <SectionCard id="st-card-permission-defaults" title={t('st.defaults.title')}>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span id="default-permission-mode-label" className="text-[12.5px] font-medium text-ink">{t('st.defaults.permissionMode')}</span>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="default-permission-mode-label">
              {(['manual', 'auto', 'yolo'] as PermissionMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={saving}
                  onClick={() => void applyPermissionMode(mode)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                    permissionMode === mode
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-hairline text-ink-soft hover:border-hairline-strong'
                  }`}
                >
                  {t(`composer.mode.${mode}`)}
                </button>
              ))}
              <SavedTick show={tick} />
            </div>
          </div>
          <p className={`text-[11px] leading-relaxed ${permissionMode === 'yolo' ? 'text-amber-ink' : 'text-ink-faint'}`}>
            {t(`composer.mode.${permissionMode}Hint`)}
          </p>
          <Hint>{t('st.defaults.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
          {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-composer" title={t('st.composer.title')}>
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <label htmlFor="send-shortcut-select" className="text-[12.5px] font-medium text-ink">{t('st.composer.sendShortcut')}</label>
            <select
              id="send-shortcut-select"
              className={SMALL_INPUT}
              value={settings.sendShortcut}
              onChange={(event) => { updateLocal({ sendShortcut: event.target.value as SendShortcut }); }}
            >
              <option value="enter">{t('st.composer.shortcutEnter')}</option>
              <option value="cmd-enter">{t('st.composer.shortcutCmdEnter')}</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Toggle
              label={t('st.composer.persistDrafts')}
              checked={settings.draftPersistence}
              onChange={(checked) => {
                updateLocal({ draftPersistence: checked });
                if (!checked) clearStoredDrafts();
              }}
            />
          </div>
          <Hint>{t('st.composer.persistDraftsHint')}</Hint>
        </div>
      </SectionCard>

      <ExperimentalSection
        featureIds={['auto_session_title']}
        cardId="st-card-session-title"
        titleKey="st.experimental.sessionTitle"
      >
        <SessionTitleModelFields />
      </ExperimentalSection>

      <SectionCard id="st-card-desktop" title={t('st.desktop.title')} badge="desktop" aside={isDesktop ? undefined : t('st.desktop.browserHint')}>
        {isDesktop ? (
        <fieldset className="space-y-4">
          <Toggle
            label={t('st.desktop.notifications')}
            checked={desktopPrefs.notifications}
            disabled={!isDesktop}
            onChange={(checked) => {
              const next = { ...desktopPrefs, notifications: checked };
              setDesktopPrefs(next);
              writeDesktopPrefs(next);
              void host.writeDesktopPrefs(next);
            }}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {([
              { closeToTray: true, titleKey: 'st.desktop.tray', descriptionKey: 'st.desktop.trayDesc' },
              { closeToTray: false, titleKey: 'st.desktop.quit', descriptionKey: 'st.desktop.quitDesc' },
            ] as const).map((option) => (
              <label
                key={option.titleKey}
                className={`cursor-pointer rounded-xl border p-3 ${
                  desktopPrefs.closeToTray === option.closeToTray ? 'border-accent bg-accent-soft' : 'border-hairline bg-paper'
                }`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="close-behavior"
                    checked={desktopPrefs.closeToTray === option.closeToTray}
                    onChange={() => {
                      const next = { ...desktopPrefs, closeToTray: option.closeToTray };
                      setDesktopPrefs(next);
                      writeDesktopPrefs(next);
                      void host.writeDesktopPrefs(next);
                    }}
                    className="mt-0.5 accent-[var(--color-accent)]"
                  />
                  <span>
                    <span className="block text-[12.5px] font-semibold text-ink">{t(option.titleKey)}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">{t(option.descriptionKey)}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        ) : null}
      </SectionCard>

    </div>
  );
}

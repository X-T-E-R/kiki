import { useEffect, useState, useSyncExternalStore } from 'react';

import { clearStoredDrafts } from '@kiki/session-core/composer';
import type { Locale } from '@kiki/session-core/i18n';
import {
  readDesktopPrefs,
  writeDesktopPrefs,
  writeSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type SendShortcut,
} from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { Hint, Toggle } from '../controls';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { AppendTimingField } from './CommunicationSection';

/**
 * General: preferences of this device only. Every control writes the local
 * settings store (or the desktop host) and applies on the spot, so the page
 * has no save buttons and no server round-trips. Server-side session
 * behaviour lives on Sessions and Permissions.
 */
export function GeneralSection() {
  const host = useHost();
  const { t, locale, setLocale } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const isDesktop = host.kind === 'tauri';

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) {
        setDesktopPrefs(prefs);
        writeDesktopPrefs(prefs);
      }
    });
  }, [host]);

  const updateDesktop = (patch: Partial<typeof desktopPrefs>) => {
    const next = { ...desktopPrefs, ...patch };
    setDesktopPrefs(next);
    writeDesktopPrefs(next);
    if (host.kind === 'tauri') void host.writeDesktopPrefs(next);
  };

  return (
    <>
      <SectionCard id="st-card-language" title={t('st.language.title')}>
        <SettingField label={t('st.language.title')} labelId="language-label" help={t('st.language.hint')}>
          <SettingsSegmented<Locale>
            ariaLabelledBy="language-label"
            dataAttr="data-locale-choice"
            value={locale}
            onChange={setLocale}
            choices={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]}
          />
        </SettingField>
      </SectionCard>

      <SectionCard id="st-card-composer" title={t('st.composer.title')}>
        <div className="space-y-1">
          <SettingField
            label={t('st.composer.sendShortcut')}
            labelId="send-shortcut-label"
            help={
              <span data-send-shortcut-help={settings.sendShortcut}>
                {t(settings.sendShortcut === 'cmd-enter' ? 'st.composer.shortcutCmdEnterHint' : 'st.composer.shortcutEnterHint')}
              </span>
            }
          >
            <SettingsSelect<SendShortcut>
              id="send-shortcut-select"
              ariaLabel={t('st.composer.sendShortcut')}
              value={settings.sendShortcut}
              onChange={(value) => { writeSettings({ sendShortcut: value }); }}
              choices={[
                { value: 'enter', label: t('st.composer.shortcutEnter') },
                { value: 'cmd-enter', label: t('st.composer.shortcutCmdEnter') },
              ]}
            />
          </SettingField>
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.composer.persistDrafts')}
              checked={settings.draftPersistence}
              onChange={(checked) => {
                writeSettings({ draftPersistence: checked });
                if (!checked) clearStoredDrafts();
              }}
            />
            <Hint>{t('st.composer.persistDraftsHint')}</Hint>
          </div>
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.transcript.foldSteps')}
              checked={settings.foldSteps}
              onChange={(checked) => { writeSettings({ foldSteps: checked }); }}
            />
            <Hint>{t('st.transcript.foldStepsHint')}</Hint>
          </div>
          <div data-settings-field data-setting-rail-open className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.layout.railOpenByDefault')}
              checked={settings.railOpenByDefault}
              onChange={(checked) => { writeSettings({ railOpenByDefault: checked }); }}
            />
            <Hint>{t('st.layout.railOpenByDefaultHint')}</Hint>
          </div>
          <AppendTimingField />
        </div>
      </SectionCard>

      <SectionCard id="st-card-desktop" title={t('st.desktop.title')} effect="desktop" aside={isDesktop ? undefined : t('st.desktop.browserHint')}>
        {isDesktop ? (
          <fieldset className="space-y-4">
            {/* System notifications live on Notifications & messages. */}
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('st.desktop.title')}>
              {([
                { closeToTray: true, titleKey: 'st.desktop.tray', descriptionKey: 'st.desktop.trayDesc' },
                { closeToTray: false, titleKey: 'st.desktop.quit', descriptionKey: 'st.desktop.quitDesc' },
              ] as const).map((option) => {
                const selected = desktopPrefs.closeToTray === option.closeToTray;
                return (
                  <label
                    key={option.titleKey}
                    className={`cursor-pointer rounded-lg p-3 transition-colors ${
                      selected ? 'bg-panel shadow-[var(--kiki-sheet-shadow)]' : 'bg-ink/[0.03] hover:bg-ink/[0.05]'
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="close-behavior"
                        checked={selected}
                        onChange={() => { updateDesktop({ closeToTray: option.closeToTray }); }}
                        className="mt-0.5 accent-[var(--color-accent)]"
                      />
                      <span>
                        <span className="block text-[13px] font-medium text-ink">{t(option.titleKey)}</span>
                        <span className="mt-0.5 block text-[12px] text-ink-faint">{t(option.descriptionKey)}</span>
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}
      </SectionCard>
    </>
  );
}

import { useEffect, useState, useSyncExternalStore } from 'react';

import { clearStoredDrafts } from '@kiki/session-core/composer';
import type { Locale } from '@kiki/session-core/i18n';
import {
  ALL_SIDEBAR_NAV_KEYS,
  readDesktopPrefs,
  writeDesktopPrefs,
  writeLayoutPreferences,
  writeSettings,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  type SendShortcut,
} from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { ConfirmDialog } from '../ConfirmDialog';
import { Hint, Toggle } from '../controls';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { AppendTimingField } from './CommunicationSection';
import { SpacePrefOrigin } from './spaces/SpacePrefOrigin';

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
  const layoutPrefs = useLayoutPreferences();
  const [desktopPrefs, setDesktopPrefs] = useState(readDesktopPrefs);
  const [confirmClearDrafts, setConfirmClearDrafts] = useState(false);
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
              }}
            />
            <Hint>{t('st.composer.persistDraftsHint')}</Hint>
            <div className="pt-1">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                data-composer-clear-drafts
                onClick={() => setConfirmClearDrafts(true)}
              >
                {t('st.composer.clearDrafts')}
              </button>
            </div>
          </div>
          <div data-settings-field className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.transcript.foldSteps')}
              checked={settings.foldSteps}
              onChange={(checked) => { writeSettings({ foldSteps: checked }); }}
            />
            <Hint>{t('st.transcript.foldStepsHint')}</Hint>
            <SpacePrefOrigin item="foldSteps" label={t('st.transcript.foldSteps')} />
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
          {/* The /new worktree opt-in's "don't ask again" lands back here. */}
          <div data-settings-field data-setting-worktree-confirm className="space-y-0.5 py-1">
            <Toggle
              layout="row"
              label={t('st.composer.worktreeConfirm')}
              checked={!settings.worktreeSkipConfirm}
              onChange={(checked) => { writeSettings({ worktreeSkipConfirm: !checked }); }}
            />
            <Hint>{t('st.composer.worktreeConfirmHint')}</Hint>
            <SpacePrefOrigin item="worktreeSkipConfirm" label={t('st.composer.worktreeConfirm')} />
          </div>
          <div className="space-y-0.5">
            <SpacePrefOrigin item="defaultAppendTiming" label={t('st.communication.appendTimingTitle')} />
          </div>
          <AppendTimingField />
        </div>
      </SectionCard>

      <SectionCard id="st-card-sidebar-nav" title={t('st.sidebarNav.title')}>
        <div className="space-y-2">
          <Hint>{t('st.sidebarNav.hint')}</Hint>
          <div data-sidebar-nav-toggles className="grid gap-2 sm:grid-cols-2">
            {ALL_SIDEBAR_NAV_KEYS.map((key) => {
              const isPinned = layoutPrefs.pinnedNavItems.includes(key);
              const label = key === 'personas'
                ? t('persona.nav')
                : key === 'discover'
                  ? t('discovery.title')
                  : t(`nav.${key}`);
              return (
                <div key={key} data-nav-item-toggle={key} className="py-1">
                  <Toggle
                    layout="row"
                    label={label}
                    checked={isPinned}
                    onChange={(checked) => {
                      const next = checked
                        ? Array.from(new Set([...layoutPrefs.pinnedNavItems, key]))
                        : layoutPrefs.pinnedNavItems.filter((k) => k !== key);
                      writeLayoutPreferences({ pinnedNavItems: next });
                    }}
                  />
                </div>
              );
            })}
          </div>
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
                        className="mt-0.5 accent-[var(--color-selected-ink)]"
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
      {confirmClearDrafts ? (
        <ConfirmDialog
          open
          overlayId="confirm-clear-drafts"
          title={t('st.composer.clearDraftsConfirmTitle')}
          body={t('st.composer.clearDraftsConfirmBody')}
          confirmLabel={t('st.composer.clearDrafts')}
          tone="danger"
          onCancel={() => { setConfirmClearDrafts(false); }}
          onConfirm={() => {
            clearStoredDrafts();
            setConfirmClearDrafts(false);
          }}
        />
      ) : null}
    </>
  );
}

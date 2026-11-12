import { useEffect, useState, useSyncExternalStore } from 'react';

import type { AttentionKind } from '@kiki/session-core/sessions';
import {
  readDesktopPrefs,
  settingsServerSnapshot,
  settingsSnapshot,
  subscribeSettings,
  writeDesktopPrefs,
  writeSettings,
} from '@kiki/session-core/settings';

import { useHost } from '../../../host';
import { browserNotificationPermission } from '../../../host/browser';
import type { SystemNotificationPermission } from '../../../host/notificationPermission';
import { tauriNotificationPermission } from '../../../host/tauri';
import { useI18n } from '../../../i18n';
import { Toggle } from '../../controls';
import { SettingField, SettingsBox } from '../fields';
import { SectionCard } from '../SectionCard';

const KINDS: readonly { kind: AttentionKind; labelKey: 'st.away.completed' | 'st.away.failed' | 'st.away.question' | 'st.away.approval' }[] = [
  { kind: 'approval', labelKey: 'st.away.approval' },
  { kind: 'question', labelKey: 'st.away.question' },
  { kind: 'completed', labelKey: 'st.away.completed' },
  { kind: 'failed', labelKey: 'st.away.failed' },
];

/**
 * System notifications on this device while Kiki is in the background: the
 * master switch (the desktop `notifications` preference, which the native
 * side also reads for other spaces), one status line stating the OS/browser
 * permission in words, and one switch per kind. Instant apply, device-local.
 * Hosts that cannot raise a notification get one line instead.
 */
export function AwayNotificationsCard() {
  const host = useHost();
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const [enabled, setEnabled] = useState(() => readDesktopPrefs().notifications);
  const supported = host.notify !== undefined;
  const [permission, setPermission] = useState<SystemNotificationPermission | undefined>(() =>
    host.kind === 'browser' && supported ? browserNotificationPermission() : undefined,
  );

  useEffect(() => {
    if (!supported) {
      setPermission(undefined);
      return undefined;
    }
    let live = true;
    const refreshPermission = () => {
      if (host.kind === 'tauri') {
        void tauriNotificationPermission()
          .then((next) => { if (live) setPermission(next); })
          .catch(() => { if (live) setPermission(undefined); });
        return;
      }
      if (host.kind === 'browser') {
        setPermission(browserNotificationPermission());
      }
    };
    refreshPermission();
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      live = false;
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, [host.kind, supported]);

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => {
      if (prefs !== null) setEnabled(prefs.notifications);
    });
  }, [host]);

  const setMaster = (next: boolean) => {
    setEnabled(next);
    writeDesktopPrefs({ notifications: next });
    if (host.kind === 'tauri') void host.writeDesktopPrefs({ notifications: next });
  };

  return (
    <SectionCard
      id="st-card-notify-away"
      title={t('st.away.title')}
      scope="app"
      aside={!supported ? t('st.away.browserHint') : undefined}
    >
      {supported ? (
        <div className="min-w-0 space-y-4" data-notify-away>
          <div className="space-y-1.5">
            <SettingsBox>
              <SettingField label={t('st.away.enabled')} htmlFor="notify-away-enabled" help={t('st.away.hint')}>
                <Toggle id="notify-away-enabled" layout="bare" label={t('st.away.enabled')} checked={enabled} onChange={setMaster} />
              </SettingField>
            </SettingsBox>
            {permission !== undefined ? (
              <p
                data-notify-os-permission={permission}
                className={`text-[12px] leading-snug ${permission === 'denied' ? 'text-amber-ink' : 'text-ink-soft'}`}
              >
                {t(`st.notifications.osPermission.${permission}`)}
              </p>
            ) : null}
          </div>
          {enabled ? (
            <fieldset data-notify-away-kinds className="min-w-0 space-y-1">
              <legend className="px-0 pb-1 text-[13px] font-medium text-ink">{t('st.away.kindsLabel')}</legend>
              <SettingsBox>
                {KINDS.map(({ kind, labelKey }) => (
                  <div key={kind} data-notify-away-kind={kind}>
                    <SettingField label={t(labelKey)} help={kind === 'completed' ? t('st.away.completedHint') : undefined}>
                      <Toggle
                        layout="bare"
                        label={t(labelKey)}
                        checked={settings.awayNotifications[kind]}
                        onChange={(checked) => {
                          writeSettings({ awayNotifications: { ...settings.awayNotifications, [kind]: checked } });
                        }}
                      />
                    </SettingField>
                  </div>
                ))}
              </SettingsBox>
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

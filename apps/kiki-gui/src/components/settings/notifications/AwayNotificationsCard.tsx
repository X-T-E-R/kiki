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
import { useI18n } from '../../../i18n';
import { Toggle } from '../../controls';
import { DependentField, SettingField } from '../fields';
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
 * side also reads for other spaces) and one switch per kind. Instant apply,
 * device-local. Hosts that cannot raise a notification get one line instead.
 */
export function AwayNotificationsCard() {
  const host = useHost();
  const { t } = useI18n();
  const settings = useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsServerSnapshot);
  const [enabled, setEnabled] = useState(() => readDesktopPrefs().notifications);
  const supported = host.notify !== undefined;
  const [permission, setPermission] = useState(() => typeof window === 'undefined' ? undefined : window.Notification?.permission);

  useEffect(() => {
    if (host.kind !== 'browser' || !supported) return;
    const refreshPermission = () => setPermission(window.Notification?.permission);
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
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
      aside={!supported ? t('st.away.browserHint') : host.kind === 'browser' && permission === 'denied' ? t('st.away.permissionDenied') : undefined}
    >
      {supported ? (
        <div className="min-w-0 space-y-2" data-notify-away>
          <SettingField label={t('st.away.enabled')} htmlFor="notify-away-enabled" help={t('st.away.hint')}>
            <Toggle id="notify-away-enabled" layout="bare" label={t('st.away.enabled')} checked={enabled} onChange={setMaster} />
          </SettingField>
          <DependentField when={enabled}>
            <fieldset data-notify-away-kinds className="space-y-0.5">
              <legend className="pb-1 text-[12px] text-ink-soft">{t('st.away.kindsLabel')}</legend>
              {KINDS.map(({ kind, labelKey }) => (
                <div key={kind} data-notify-away-kind={kind}>
                  <Toggle
                    layout="row"
                    label={t(labelKey)}
                    checked={settings.awayNotifications[kind]}
                    onChange={(checked) => {
                      writeSettings({ awayNotifications: { ...settings.awayNotifications, [kind]: checked } });
                    }}
                  />
                  {kind === 'completed' ? <p className="pb-2 text-[12px] leading-relaxed text-ink-faint">{t('st.away.completedHint')}</p> : null}
                </div>
              ))}
            </fieldset>
          </DependentField>
        </div>
      ) : null}
    </SectionCard>
  );
}

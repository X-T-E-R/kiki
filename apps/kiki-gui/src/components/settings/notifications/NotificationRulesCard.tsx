import { useEffect, useState } from 'react';
import type { NotificationGlobalSettings } from '@kiki/klient';
import { readDesktopPrefs } from '@kiki/session-core/settings';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { FeedbackLine, Hint, SaveStatus, Toggle } from '../../controls';
import { DependentField, SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { CommitInput, SettingsSelect } from '../SettingsPrimitives';
import { useInstantSave } from '../useInstantSave';
import { useNotificationWrites } from './useNotifications';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;
const DEFAULT_QUIET = { start: '22:00', end: '08:00' };

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([current, localTimeZone(), 'UTC', ...all])];
}

/**
 * The rules every channel shares: master switch, quiet hours, viewing and
 * short-turn filters, plus the two facts people ask before trusting it (what
 * leaves the machine, and whether anything arrives with the window closed).
 * Instant apply; each write sends the whole global object back.
 */
export function NotificationRulesCard({ global }: { global: NotificationGlobalSettings }) {
  const { t } = useI18n();
  const host = useHost();
  const { api, apply } = useNotificationWrites();
  const save = useInstantSave();
  const [pending, setPending] = useState<string | null>(null);
  const [closeToTray, setCloseToTray] = useState(() => readDesktopPrefs().closeToTray);
  const isDesktop = host.kind === 'tauri';

  useEffect(() => {
    if (host.kind !== 'tauri') return;
    void host.readDesktopPrefs().then((prefs) => { if (prefs !== null) setCloseToTray(prefs.closeToTray); });
  }, [host]);

  const write = (key: string, next: NotificationGlobalSettings) => {
    setPending(key);
    void save.run(async () => { apply(await api.updateSettings(next)); });
  };
  const status = (key: string) => pending === key ? <SaveStatus saving={save.saving} saved={save.saved} /> : null;
  const quiet = global.quiet_hours;
  const zone = quiet?.time_zone ?? localTimeZone();
  const runtimeKey = !isDesktop ? 'st.notify.runtime.browser' : closeToTray ? 'st.notify.runtime.tray' : 'st.notify.runtime.quit';

  return (
    <SectionCard id="st-card-notify-rules" title={t('st.notify.rulesTitle')}>
      <div className="min-w-0 space-y-2" data-notify-rules>
        <SettingField label={t('st.notify.enabled')} htmlFor="notify-enabled" help={t('st.notify.enabledHint')}>
          {status('enabled')}
          <Toggle id="notify-enabled" layout="bare" label={t('st.notify.enabled')} checked={global.enabled}
            disabled={save.saving} onChange={(enabled) => { write('enabled', { ...global, enabled }); }} />
        </SettingField>
        <DependentField when={global.enabled}>
          <div className="space-y-2">
            <SettingField label={t('st.notify.quiet')} htmlFor="notify-quiet" help={t('st.notify.quietHint')}>
              {status('quiet')}
              <Toggle id="notify-quiet" layout="bare" label={t('st.notify.quiet')} checked={quiet !== undefined}
                disabled={save.saving}
                onChange={(on) => {
                  const { quiet_hours: _drop, ...rest } = global;
                  write('quiet', on ? { ...rest, quiet_hours: { ...DEFAULT_QUIET, time_zone: localTimeZone() } } : rest);
                }} />
            </SettingField>
            {quiet !== undefined ? (
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2 pb-1" data-notify-quiet>
                <label className="flex items-center gap-2 text-[12px] text-ink-soft">
                  {t('st.notify.quietFrom')}
                  <CommitInput dataAttr="data-notify-quiet-start" className="w-[4.5rem] text-center" inputMode="numeric" value={quiet.start}
                    ariaLabel={`${t('st.notify.quiet')} ${t('st.notify.quietFrom')}`} disabled={save.saving}
                    validate={(text) => TIME.test(text) ? null : t('st.notify.timeInvalid')}
                    onCommit={(start) => { write('quiet-range', { ...global, quiet_hours: { ...quiet, start } }); }} />
                </label>
                <label className="flex items-center gap-2 text-[12px] text-ink-soft">
                  {t('st.notify.quietTo')}
                  <CommitInput dataAttr="data-notify-quiet-end" className="w-[4.5rem] text-center" inputMode="numeric" value={quiet.end}
                    ariaLabel={`${t('st.notify.quiet')} ${t('st.notify.quietTo')}`} disabled={save.saving}
                    validate={(text) => TIME.test(text) ? null : t('st.notify.timeInvalid')}
                    onCommit={(end) => { write('quiet-range', { ...global, quiet_hours: { ...quiet, end } }); }} />
                </label>
                <span className="flex items-center gap-2 text-[12px] text-ink-soft">
                  {t('st.notify.quietZone')}
                  <SettingsSelect id="notify-quiet-zone" ariaLabel={t('st.notify.quietZone')} value={zone} mono
                    disabled={save.saving}
                    choices={timeZones(zone).map((id) => ({ value: id, label: id }))}
                    onChange={(time_zone) => { write('quiet-range', { ...global, quiet_hours: { ...quiet, time_zone } }); }} />
                </span>
                {status('quiet-range')}
              </div>
            ) : null}
            <SettingField label={t('st.notify.viewing')} htmlFor="notify-viewing" help={t('st.notify.viewingHint')}>
              {status('viewing')}
              <Toggle id="notify-viewing" layout="bare" label={t('st.notify.viewing')} checked={global.suppress_viewing_session}
                disabled={save.saving} onChange={(suppress_viewing_session) => { write('viewing', { ...global, suppress_viewing_session }); }} />
            </SettingField>
            <SettingField label={t('st.notify.minWork')} htmlFor="notify-min-work" help={t('st.notify.minWorkHint')}>
              {status('minWork')}
              <CommitInput id="notify-min-work" dataAttr="data-notify-min-work" className="w-20 text-right" inputMode="numeric"
                value={String(Math.round(global.min_work_ms / 1000))} disabled={save.saving}
                validate={(text) => /^\d+$/u.test(text) && Number(text) <= 86_400 ? null : t('st.notify.minWorkInvalid')}
                onCommit={(text) => { write('minWork', { ...global, min_work_ms: Number(text) * 1000 }); }} />
              <span className="text-[12px] text-ink-faint">{t('st.notify.seconds')}</span>
            </SettingField>
          </div>
        </DependentField>
        <FeedbackLine feedback={save.error} />
        <dl className="grid gap-x-6 gap-y-2 border-t border-hairline pt-3 sm:grid-cols-[8rem_minmax(0,1fr)]" data-notify-facts>
          <dt className="text-[12px] text-ink-soft">{t('st.notify.privacyLabel')}</dt>
          <dd><Hint>{t('st.notify.privacy')}</Hint></dd>
          <dt className="text-[12px] text-ink-soft">{t('st.notify.runtimeLabel')}</dt>
          <dd data-notify-runtime={isDesktop ? (closeToTray ? 'tray' : 'quit') : 'browser'}><Hint>{t(runtimeKey)}</Hint></dd>
        </dl>
      </div>
    </SectionCard>
  );
}

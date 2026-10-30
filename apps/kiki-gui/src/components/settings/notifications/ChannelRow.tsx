import { useState } from 'react';
import type { NotificationChannel, NotificationDelivery, NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';

import { useI18n } from '../../../i18n';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, SaveStatus, Toggle, type Feedback } from '../../controls';
import { DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { CardActions, SettingField, SettingsGroup } from '../fields';
import { CommitInput } from '../SettingsPrimitives';
import { useInstantSave } from '../useInstantSave';
import { ChannelFields } from './ChannelFields';
import { brandOfPush } from './catalog';
import { ChannelStatus } from './ChannelStatus';
import { DeliveryLog } from './DeliveryLog';
import { channelState, channelsUsing, errorKindKey, lastDelivery, providerGuideKey, providerLabel, reasonKey } from './model';
import { ChannelListRow } from './rowParts';
import { useNotificationWrites } from './useNotifications';

/**
 * One alert channel as a row of "My channels": name, type, the state that
 * matters, and its switch on one line. Underneath, in the order a person
 * sets one up: where to get the credentials, the connection, where messages
 * go, check and test, then recent activity. Which moments it hears is chosen
 * in the rules tab, not here. Instant apply.
 */
export function ChannelRow({ channelId, channel, settings, provider, deliveries, open, onToggle }: {
  channelId: string;
  channel: NotificationChannel;
  settings: NotificationSettings;
  provider: NotificationProviderDescriptor | undefined;
  deliveries: readonly NotificationDelivery[];
  open: boolean;
  onToggle: () => void;
}) {
  const { t, time } = useI18n();
  const { api, apply, refresh, refreshDeliveries } = useNotificationWrites();
  const save = useInstantSave();
  const [pending, setPending] = useState<string | null>(null);
  const [action, setAction] = useState<'check' | 'test' | null>(null);
  const [result, setResult] = useState<Feedback>(null);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const instanceId = channel.provider_instance_id;
  const instance = settings.provider_instances[instanceId];
  const providerId = instance?.provider_id ?? '';
  const typeName = providerLabel(t, providerId);
  const name = channel.label ?? instance?.label ?? typeName;
  const state = channelState(channel, instance, provider, settings.credential_slots);
  const unavailable = state === 'dependency';
  const sent = lastDelivery(deliveries, false);
  const failed = lastDelivery(deliveries, true);
  const lastError = failed !== undefined && (sent === undefined || failed.created_at > sent.created_at) ? failed : undefined;
  const bodyId = `notify-channel-${channelId}`;
  const status = (key: string) => pending === key ? <SaveStatus saving={save.saving} saved={save.saved} /> : null;
  const { health: _health, ...persisted } = channel;

  const writeChannel = (key: string, next: Partial<NotificationChannel>) => {
    setPending(key);
    void save.run(async () => { apply(await api.upsertChannel(channelId, { ...persisted, ...next })); });
  };

  const check = async () => {
    setAction('check');
    setResult(null);
    try {
      const outcome = await api.checkCredential(instanceId);
      const params = { provider: typeName };
      setResult(outcome.result === 'ok' ? { tone: 'success', text: t('st.notify.check.ok', params) }
        : outcome.result === 'requires_test_send' ? { tone: 'info', text: t('st.notify.check.requiresTest', params) }
          : { tone: 'error', text: t(outcome.health === 'unauthorized' ? 'st.notify.check.unauthorized' : 'st.notify.check.connection', params) });
      await refresh();
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAction(null);
    }
  };

  const test = async () => {
    setAction('test');
    setResult(null);
    try {
      const delivery = await api.sendTest(channelId);
      setResult(delivery.status === 'accepted_by_provider' ? { tone: 'success', text: t('st.notify.test.accepted', { provider: typeName }) }
        : delivery.status === 'failed' || delivery.status === 'unknown' || delivery.status === 'expired'
          ? { tone: 'error', text: t('st.notify.test.failed', { reason: t(errorKindKey(delivery.result?.error_kind)) }) }
          : { tone: 'info', text: t('st.notify.test.queued') });
      await Promise.all([refresh(), refreshDeliveries()]);
    } catch (error) {
      setResult({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setAction(null);
    }
  };

  const onlyUser = channelsUsing(settings, instanceId).length <= 1;
  const remove = async () => {
    setRemoving(true);
    const ok = await save.run(async () => {
      apply(onlyUser ? await api.deleteInstance(instanceId) : await api.deleteChannel(channelId));
    });
    setRemoving(false);
    if (ok) setConfirming(false);
  };

  return (
    <ChannelListRow
      data={{ 'data-notify-channel': channelId, 'data-channel-row': `push:${channelId}` }}
      brand={brandOfPush(providerId)} twoWay={false} name={name}
      status={<ChannelStatus state={state} enabled={channel.enabled} paused={!settings.global.enabled} />}
      meta={name !== typeName ? typeName : undefined}
      open={open} onToggle={onToggle} bodyId={bodyId}
      expandLabel={t('st.notify.expandAria', { name })}
      control={<>
        {status('enabled')}
        <Toggle layout="bare" label={t('st.notify.channelToggle', { name })} checked={channel.enabled && !unavailable}
          disabled={save.saving || unavailable} onChange={(enabled) => { writeChannel('enabled', { enabled }); }} />
      </>}
    >
        {unavailable ? (
          <p className="max-w-[62ch] text-[12px] leading-snug text-amber-ink" data-notify-dependency>
            {t(reasonKey(provider?.status_reason))}
          </p>
        ) : null}
        {providerGuideKey(providerId) !== undefined && (state === 'noCredential' || state === 'unauthorized') ? (
          <p className="max-w-[62ch] text-[12px] leading-5 text-ink-soft" data-notify-guide={providerId}>
            {t(providerGuideKey(providerId)!)}
          </p>
        ) : null}
        <SettingField label={t('st.notify.name')} htmlFor={`${bodyId}-label`}>
          {status('label')}
          <CommitInput id={`${bodyId}-label`} className="w-56" value={channel.label ?? ''} placeholder={typeName} disabled={save.saving}
            onCommit={(text) => {
              const { label: _drop, ...rest } = persisted;
              setPending('label');
              void save.run(async () => { apply(await api.upsertChannel(channelId, text === '' ? rest : { ...rest, label: text })); });
            }} />
        </SettingField>
        {instance !== undefined && provider !== undefined && !unavailable ? (
          <ChannelFields channelId={channelId} channel={channel} instanceId={instanceId} instance={instance} provider={provider}
            settings={settings} save={save} pending={pending} setPending={setPending} />
        ) : null}
        <FeedbackLine feedback={save.error} />
        {!unavailable ? (
          <SettingsGroup title={t('st.notify.checkSection')}>
            <CardActions>
              <button type="button" data-notify-check className={SECONDARY_BUTTON} disabled={action !== null || save.saving} onClick={() => void check()}>
                {action === 'check' ? t('st.notify.checking') : t('st.notify.check')}
              </button>
              <button type="button" data-notify-test className={SECONDARY_BUTTON}
                disabled={action !== null || save.saving || !channel.enabled || !settings.global.enabled} onClick={() => void test()}>
                {action === 'test' ? t('st.notify.testing') : t('st.notify.test')}
              </button>
            </CardActions>
            <div data-notify-result><FeedbackLine feedback={result} /></div>
          </SettingsGroup>
        ) : null}
        <SettingsGroup title={t('st.notify.activity')}>
        <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-[6rem_minmax(0,1fr)]" data-notify-activity>
          <dt className="text-ink-soft">{t('st.notify.lastSent')}</dt>
          <dd className="text-ink">{sent === undefined ? <span className="text-ink-faint">{t('st.notify.never')}</span> : time.relativeTime(sent.created_at)}</dd>
          {lastError !== undefined ? <>
            <dt className="text-ink-soft">{t('st.notify.lastError')}</dt>
            <dd className="text-danger">{time.relativeTime(lastError.created_at)} · {t(errorKindKey(lastError.result?.error_kind))}</dd>
          </> : null}
        </dl>
        <DeliveryLog deliveries={deliveries} />
        </SettingsGroup>
        <div className="flex justify-end">
          <button type="button" data-notify-remove className={DANGER_GHOST_BUTTON} disabled={save.saving} onClick={() => { setConfirming(true); }}>
            {t('st.notify.remove')}
          </button>
        </div>
      <ConfirmDialog open={confirming} title={t('st.notify.removeTitle', { name })} body={t('st.notify.removeBody')}
        consequences={[t(onlyUser ? 'st.notify.removeConnection' : 'st.notify.removeKeepConnection')]}
        confirmLabel={t('st.notify.remove')} busy={removing} overlayId="notify-remove"
        onConfirm={() => void remove()} onCancel={() => { setConfirming(false); }} />
    </ChannelListRow>
  );
}

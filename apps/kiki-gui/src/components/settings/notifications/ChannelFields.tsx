import type { NotificationChannel, NotificationInstance, NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';

import { useI18n } from '../../../i18n';
import { SaveStatus } from '../../controls';
import { AdvancedDetails, SettingField, SettingsGroup } from '../fields';
import { CommitInput, SettingsSelect } from '../SettingsPrimitives';
import type { InstantSave } from '../useInstantSave';
import { CommitJsonField } from './fieldControls';
import { channelsUsing, fieldLabel, freshRevision, instanceSlots, slotSpec, type InstanceField } from './model';
import { SlotSecretField } from './SlotSecretField';
import { useNotificationWrites } from './useNotifications';

/**
 * The connection (instance) and target fields of one channel, rendered from
 * the provider schema. Required and optional follow the schema; JSON fields
 * sit in a collapsed Advanced tail. Every field saves itself.
 */
export function ChannelFields({ channelId, channel, instanceId, instance, provider, settings, save, pending, setPending }: {
  channelId: string;
  channel: NotificationChannel;
  instanceId: string;
  instance: NotificationInstance;
  provider: NotificationProviderDescriptor;
  settings: NotificationSettings;
  save: InstantSave;
  pending: string | null;
  setPending: (key: string) => void;
}) {
  const { t, tp } = useI18n();
  const { api, apply, refresh, reveal } = useNotificationWrites();
  const shared = channelsUsing(settings, instanceId).length - 1;
  const status = (key: string) => pending === key ? <SaveStatus saving={save.saving} saved={save.saved} /> : null;
  const { health: _health, ...persisted } = instance;

  const writeOptions = (key: string, options: Record<string, unknown>, slots = instanceSlots(settings, instanceId)) => {
    setPending(key);
    return save.run(async () => {
      apply(await api.upsertInstance(instanceId, { ...persisted, options, revision: freshRevision() }, slots));
    });
  };
  const writeTarget = (key: string, target: Record<string, unknown>) => {
    setPending(key);
    const { health: _h, ...rest } = channel;
    void save.run(async () => { apply(await api.upsertChannel(channelId, { ...rest, target, revision: freshRevision() })); });
  };

  const commitSecret = async (field: InstanceField, value: string | null): Promise<boolean> => {
    const current = instance.options[field.key];
    const slotId = typeof current === 'string' ? current : undefined;
    if (value === null && !field.required && slotId !== undefined) {
      // An optional credential that is cleared leaves the connection entirely.
      const { [field.key]: _drop, ...options } = instance.options;
      const { [slotId]: _slot, ...slots } = instanceSlots(settings, instanceId);
      return writeOptions(field.key, options, slots);
    }
    setPending(field.key);
    return save.run(async () => {
      let target = slotId;
      if (target === undefined) {
        const spec = slotSpec(instance.provider_id, instanceId, field.purpose ?? field.key);
        target = `${instanceId}.${field.purpose ?? field.key}`;
        apply(await api.upsertInstance(instanceId, { ...persisted, options: { ...instance.options, [field.key]: target }, revision: freshRevision() },
          { ...instanceSlots(settings, instanceId), [target]: spec }));
      }
      await api.setCredential(target, value);
      await refresh();
    });
  };

  const plain = provider.instance_fields.filter((field) => field.kind !== 'json');
  const advanced = provider.instance_fields.filter((field) => field.kind === 'json');

  return (
    <>
      {plain.length > 0 || advanced.length > 0 ? (
        <SettingsGroup title={t('st.notify.connection')} help={shared > 0 ? tp('st.notify.connectionShared', shared, { n: shared }) : undefined}>
          {plain.map((field) => {
            const label = fieldLabel(t, provider.id, field);
            const value = instance.options[field.key];
            const inputId = `notify-${channelId}-${field.key}`;
            if (field.kind === 'secret') {
              const slotId = typeof value === 'string' ? value : undefined;
              return (
                <div key={field.key} className="py-1">
                  <SlotSecretField label={label} optional={!field.required}
                    configured={slotId !== undefined && settings.credential_slots[slotId]?.configured === true}
                    disabled={save.saving} reveal={() => reveal(slotId ?? '')}
                    onCommit={(next) => commitSecret(field, next)} />
                </div>
              );
            }
            if (field.kind === 'select') {
              return (
                <SettingField key={field.key} label={label}>
                  {status(field.key)}
                  <SettingsSelect id={inputId} ariaLabel={label} mono value={typeof value === 'string' ? value : ''}
                    disabled={save.saving} choices={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                    onChange={(next) => { void writeOptions(field.key, { ...instance.options, [field.key]: next }); }} />
                </SettingField>
              );
            }
            return (
              <SettingField key={field.key} label={field.required ? label : `${label} · ${t('st.notify.optional')}`} htmlFor={inputId}>
                {status(field.key)}
                <CommitInput id={inputId} className={field.kind === 'number' ? 'w-28 text-right' : 'w-64 font-mono'}
                  value={value === undefined ? '' : String(value)} disabled={save.saving}
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                  validate={(text) => field.required && text === '' ? t('st.notify.fieldRequired', { field: label }) : null}
                  onCommit={(text) => {
                    const { [field.key]: _drop, ...rest } = instance.options;
                    void writeOptions(field.key, text === '' ? rest : { ...rest, [field.key]: field.kind === 'number' ? Number(text) : text });
                  }} />
              </SettingField>
            );
          })}
          {advanced.length > 0 ? (
            <AdvancedDetails summary={t('st.notify.advanced')} data-notify-advanced>
              {advanced.map((field) => (
                <div key={field.key} className="space-y-1 pb-1">
                  <label htmlFor={`notify-${channelId}-${field.key}`} className="block text-[12px] text-ink">{fieldLabel(t, provider.id, field)}</label>
                  <CommitJsonField id={`notify-${channelId}-${field.key}`} label={fieldLabel(t, provider.id, field)}
                    value={instance.options[field.key]} disabled={save.saving}
                    onCommit={(next) => {
                      const { [field.key]: _drop, ...rest } = instance.options;
                      void writeOptions(field.key, next === undefined ? rest : { ...rest, [field.key]: next });
                    }} />
                  {field.key === 'private_grant' ? <p className="text-[11px] text-ink-faint">{t('st.notify.field.privateGrantHint')}</p> : null}
                  {status(field.key)}
                </div>
              ))}
            </AdvancedDetails>
          ) : null}
        </SettingsGroup>
      ) : null}
      {provider.target_fields.length > 0 ? (
        <SettingsGroup title={t('st.notify.target')}>
          {provider.target_fields.map((field) => {
            const label = fieldLabel(t, provider.id, field);
            const value = channel.target[field.key];
            const inputId = `notify-${channelId}-target-${field.key}`;
            return (
              <SettingField key={field.key} label={field.required ? label : `${label} · ${t('st.notify.optional')}`} htmlFor={inputId}>
                {status(`target.${field.key}`)}
                <CommitInput id={inputId} className={field.kind === 'number' ? 'w-28 text-right' : 'w-48 font-mono'}
                  value={value === undefined ? '' : String(value)} disabled={save.saving}
                  inputMode={field.kind === 'number' ? 'numeric' : undefined}
                  validate={(text) => field.required && text === '' ? t('st.notify.fieldRequired', { field: label })
                    : field.kind === 'number' && text !== '' && !/^-?\d+$/u.test(text) ? t('st.notify.fieldRequired', { field: label }) : null}
                  onCommit={(text) => {
                    const { [field.key]: _drop, ...rest } = channel.target;
                    writeTarget(`target.${field.key}`, text === '' ? rest : { ...rest, [field.key]: field.kind === 'number' ? Number(text) : text });
                  }} />
              </SettingField>
            );
          })}
        </SettingsGroup>
      ) : null}
    </>
  );
}

import { useId, useMemo, useState } from 'react';
import type { NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { FeedbackLine, type Feedback } from '../../controls';
import { INPUT } from '../../ui';
import { AdvancedDetails } from '../fields';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../SecretField';
import { FieldIssue, FORM_LABEL, SettingsDraftFooter, SettingsSelect } from '../SettingsPrimitives';
import { JSON_TEXTAREA } from './fieldControls';
import {
  fieldLabel, freshRevision, instanceSlots, isAddable, nextId, parseJsonObject, providerLabel, reasonKey, slotSpec, unavailableProviders,
} from './model';
import { useNotificationWrites } from './useNotifications';

const NEW = '__new__';

/**
 * Create form for a built-in channel (Draft mode: one commit). It either
 * reuses an existing connection of the same type, so several channels share
 * one bot or webhook, or creates a new one from the provider schema. The
 * types the registry lists but cannot send with yet are named under the
 * picker, not offered.
 */
export function AddChannelForm({ settings, providers, onDone }: {
  settings: NotificationSettings;
  providers: readonly NotificationProviderDescriptor[];
  onDone: (channelId: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const { api, apply, refresh } = useNotificationWrites();
  const scope = useId();
  const addable = useMemo(() => providers.filter(isAddable), [providers]);
  const unavailable = useMemo(() => unavailableProviders(providers), [providers]);
  const [providerId, setProviderId] = useState(addable[0]?.id ?? '');
  const provider = addable.find((candidate) => candidate.id === providerId);
  const existing = Object.entries(settings.provider_instances).filter(([, instance]) => instance.provider_id === providerId);
  const [connection, setConnection] = useState<string>(NEW);
  const connectionId = connection !== NEW && existing.some(([id]) => id === connection) ? connection : NEW;
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, SecretDraft>>({});
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (provider === undefined) return null;
  const typeName = providerLabel(t, provider.id);
  const fields = connectionId === NEW ? provider.instance_fields : [];
  const dirty = label !== '' || Object.values(values).some((value) => value !== '') || Object.values(secrets).some((draft) => draft.mode === 'set');
  const key = (kind: 'i' | 't', name: string) => `${kind}.${name}`;
  const setValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setIssues(({ [name]: _drop, ...rest }) => rest);
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const field of fields) {
      const name = key('i', field.key);
      const text = field.kind === 'secret' ? (secrets[name]?.mode === 'set' ? (secrets[name] as { value: string }).value.trim() : '') : (values[name] ?? '').trim();
      if (field.required && text === '') found[name] = t('st.notify.fieldRequired', { field: fieldLabel(t, provider.id, field) });
      if (field.kind === 'json' && !parseJsonObject(text).ok) found[name] = t('st.notify.jsonInvalid');
      if (field.kind === 'number' && text !== '' && !/^-?\d+$/u.test(text)) found[name] = t('st.notify.fieldRequired', { field: fieldLabel(t, provider.id, field) });
    }
    for (const field of provider.target_fields) {
      const name = key('t', field.key);
      const text = (values[name] ?? '').trim();
      if ((field.required && text === '') || (field.kind === 'number' && text !== '' && !/^-?\d+$/u.test(text))) {
        found[name] = t('st.notify.fieldRequired', { field: fieldLabel(t, provider.id, field) });
      }
    }
    return found;
  };

  const submit = async () => {
    const found = validate();
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      let instanceId = connectionId;
      if (instanceId === NEW) {
        instanceId = nextId(provider.id.replace(/_/gu, '-'), Object.keys(settings.provider_instances));
        const options: Record<string, unknown> = {};
        const slots = instanceSlots(settings, instanceId);
        const writes: [string, string][] = [];
        for (const field of fields) {
          const name = key('i', field.key);
          if (field.kind === 'secret') {
            const draft = secrets[name];
            if (draft?.mode !== 'set' || draft.value.trim() === '') continue;
            const spec = slotSpec(provider.id, instanceId, field.purpose ?? field.key);
            const slotId = `${instanceId}.${field.purpose ?? field.key}`;
            slots[slotId] = spec;
            options[field.key] = slotId;
            writes.push([slotId, draft.value.trim()]);
            continue;
          }
          const text = (values[name] ?? '').trim();
          if (text === '') continue;
          options[field.key] = field.kind === 'number' ? Number(text)
            : field.kind === 'json' ? (parseJsonObject(text) as { value: unknown }).value : text;
        }
        apply(await api.upsertInstance(instanceId, { provider_id: provider.id, enabled: true, revision: freshRevision(), options }, slots));
        for (const [slotId, value] of writes) await api.setCredential(slotId, value);
      }
      const target: Record<string, unknown> = {};
      for (const field of provider.target_fields) {
        const text = (values[key('t', field.key)] ?? '').trim();
        if (text !== '') target[field.key] = field.kind === 'number' ? Number(text) : text;
      }
      const channelId = nextId(provider.id.replace(/_/gu, '-'), Object.keys(settings.channels));
      apply(await api.upsertChannel(channelId, {
        provider_instance_id: instanceId, enabled: true, revision: freshRevision(), target, directions: ['send'],
        scenes: { work_complete: true, question_pending: true }, ...(label.trim() === '' ? {} : { label: label.trim() }),
      }));
      await refresh();
      onDone(channelId);
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.notify.addFailed', { detail: errorText(locale, error) }) });
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const textInput = (name: string, label: string, mono: boolean, numeric: boolean) => (
    <div key={name} className="min-w-0 space-y-1">
      <label htmlFor={`${scope}-${name}`} className={FORM_LABEL}>{label}</label>
      <input id={`${scope}-${name}`} className={`${INPUT} ${mono ? 'font-mono' : ''} ${issues[name] !== undefined ? 'border-danger' : ''}`}
        value={values[name] ?? ''} inputMode={numeric ? 'numeric' : undefined} spellCheck={false} autoComplete="off"
        aria-invalid={issues[name] !== undefined} aria-describedby={issues[name] !== undefined ? `${scope}-${name}-issue` : undefined}
        onChange={(event) => { setValue(name, event.target.value); }} />
      <FieldIssue id={`${scope}-${name}-issue`} text={issues[name] ?? null} />
    </div>
  );
  const labelFor = (field: { key: string; label: string; required: boolean }) =>
    field.required ? fieldLabel(t, provider.id, field) : `${fieldLabel(t, provider.id, field)} · ${t('st.notify.optional')}`;
  const plain = fields.filter((field) => field.kind !== 'json');
  const advanced = fields.filter((field) => field.kind === 'json');

  return (
    <div className="space-y-4" data-notify-add>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <span id={`${scope}-provider`} className={FORM_LABEL}>{t('st.notify.provider')}</span>
          <SettingsSelect variant="form" id={`${scope}-provider-select`} ariaLabel={t('st.notify.provider')} value={providerId}
            dataAttr="data-notify-add-provider" disabled={saving}
            choices={addable.map((candidate) => ({ value: candidate.id, label: providerLabel(t, candidate.id) }))}
            onChange={(next) => { setProviderId(next); setConnection(NEW); setValues({}); setSecrets({}); setIssues({}); }} />
        </div>
        {existing.length > 0 ? (
          <div className="min-w-0 space-y-1">
            <span className={FORM_LABEL}>{t('st.notify.connection')}</span>
            <SettingsSelect variant="form" id={`${scope}-connection`} ariaLabel={t('st.notify.connection')} value={connectionId}
              dataAttr="data-notify-add-connection" disabled={saving}
              choices={[...existing.map(([id, instance]) => ({ value: id, label: instance.label ?? id })), { value: NEW, label: t('st.notify.newConnection') }]}
              onChange={setConnection} />
          </div>
        ) : null}
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${scope}-label`} className={FORM_LABEL}>{`${t('st.notify.name')} · ${t('st.notify.optional')}`}</label>
          <input id={`${scope}-label`} className={INPUT} value={label} placeholder={typeName} autoComplete="off"
            onChange={(event) => { setLabel(event.target.value); }} />
        </div>
        {plain.map((field) => {
          const name = key('i', field.key);
          if (field.kind === 'secret') {
            return (
              <div key={name} className="min-w-0 sm:col-span-2">
                <SecretField id={`${scope}-${name}`} label={labelFor(field)} source="none" draft={secrets[name] ?? KEEP_SECRET} disabled={saving}
                  onChange={(draft) => { setSecrets((current) => ({ ...current, [name]: draft })); setIssues(({ [name]: _drop, ...rest }) => rest); }} />
                <FieldIssue id={`${scope}-${name}-issue`} text={issues[name] ?? null} />
              </div>
            );
          }
          if (field.kind === 'select') {
            const options = field.options ?? [];
            return (
              <div key={name} className="min-w-0 space-y-1">
                <span className={FORM_LABEL}>{labelFor(field)}</span>
                <SettingsSelect variant="form" mono ariaLabel={labelFor(field)} value={values[name] ?? options[0] ?? ''} disabled={saving}
                  choices={options.map((option) => ({ value: option, label: option }))} onChange={(next) => { setValue(name, next); }} />
              </div>
            );
          }
          return textInput(name, labelFor(field), true, field.kind === 'number');
        })}
        {provider.target_fields.map((field) => textInput(key('t', field.key), labelFor(field), true, field.kind === 'number'))}
      </div>
      {advanced.length > 0 ? (
        <AdvancedDetails summary={t('st.notify.advanced')}>
          {advanced.map((field) => {
            const name = key('i', field.key);
            return (
              <div key={name} className="space-y-1">
                <label htmlFor={`${scope}-${name}`} className={FORM_LABEL}>{labelFor(field)}</label>
                <textarea id={`${scope}-${name}`} className={`${JSON_TEXTAREA} ${issues[name] !== undefined ? 'border-danger' : 'border-hairline'}`}
                  value={values[name] ?? ''} spellCheck={false} placeholder='{"host": "10.0.0.5"}'
                  aria-invalid={issues[name] !== undefined} onChange={(event) => { setValue(name, event.target.value); }} />
                <FieldIssue id={`${scope}-${name}-issue`} text={issues[name] ?? null} />
                {field.key === 'private_grant' ? <p className="text-[11px] text-ink-faint">{t('st.notify.field.privateGrantHint')}</p> : null}
              </div>
            );
          })}
        </AdvancedDetails>
      ) : null}
      {unavailable.length > 0 ? (
        <div className="space-y-0.5" data-notify-unavailable>
          <p className="text-[12px] font-medium text-ink-soft">{t('st.notify.unavailableTitle')}</p>
          <ul className="space-y-0.5">
            {unavailable.map((candidate) => (
              <li key={candidate.id} data-notify-unavailable-provider={candidate.id} className="flex flex-wrap items-baseline gap-x-2 text-[12px] leading-5">
                <span className="text-ink">{providerLabel(t, candidate.id)}</span>
                <span className="text-amber-ink">{t('st.notify.state.dependency')}</span>
                <span className="text-ink-faint">{t(reasonKey(candidate.status_reason))}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <FeedbackLine feedback={feedback} />
      <SettingsDraftFooter id="notify-add" persistent dirty={dirty || connectionId !== NEW} saving={saving}
        saveLabel={t('st.notify.add')} onSave={() => void submit()} onDiscard={() => { onDone(null); }} />
    </div>
  );
}

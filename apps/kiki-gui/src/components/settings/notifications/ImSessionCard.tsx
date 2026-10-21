import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImCatalog, ImConfirmRequest, ImPasteResult, ImSessionSnapshot } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';

const KEY = ['im-sessions'] as const;

export function ImSessionCard() {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const snapshot = useQuery({ queryKey: KEY, queryFn: () => client.imSessions.snapshot() });
  const catalog = useQuery({ queryKey: [...KEY, 'catalog'], queryFn: () => client.imSessions.catalog(), enabled: snapshot.isSuccess });
  const [text, setText] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<'queue' | 'steer'>('queue');
  const [reply, setReply] = useState<'final' | 'edit'>('final');
  const [actions, setActions] = useState(true);
  const [alsoHome, setAlsoHome] = useState(false);
  const [pasteNote, setPasteNote] = useState<ImPasteResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  const apply = (next: ImSessionSnapshot) => { queryClient.setQueryData(KEY, next); };
  const run = async (work: () => Promise<ImSessionSnapshot | void>) => {
    setError(undefined);
    try { const next = await work(); if (next !== undefined) apply(next); }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('st.im.error')); }
  };

  const data = snapshot.data;
  const people = catalog.data;
  const choices = targetChoices(people);
  const selected = choices.some((choice) => choice.value === target) ? target : choices[0]?.value ?? '';

  return (
    <SectionCard id="st-card-im-session" title={t('st.im.title')}>
      <div className="min-w-0 space-y-3" data-im-session>
        <p className="text-[12px] leading-5 text-ink-soft">{t('st.im.hint')}</p>
        {snapshot.isError ? <FeedbackLine feedback={{ tone: 'error', text: t('st.im.error') }} /> : null}
        {data === undefined ? <div data-im-loading aria-busy="true" className="min-h-16" /> : (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <SettingField label={t('st.im.allowed')} htmlFor="im-allowed">
                <Toggle id="im-allowed" layout="bare" label={t('st.im.allowed')} checked={data.policy.allowed}
                  onChange={(allowed) => { void run(() => client.imSessions.setPolicy({ ...data.policy, allowed })); }} />
              </SettingField>
              <SettingField label={t('st.im.default')} htmlFor="im-default">
                <Toggle id="im-default" layout="bare" label={t('st.im.default')} checked={data.policy.default_enabled}
                  onChange={(default_enabled) => { void run(() => client.imSessions.setPolicy({ ...data.policy, default_enabled })); }} />
              </SettingField>
            </div>
            <label className="block space-y-1 text-[12px] text-ink-soft">
              <span>{t('st.im.paste')}</span>
              <textarea data-im-paste value={text} rows={3} placeholder={t('st.im.pastePlaceholder')} className={INPUT}
                onChange={(event) => { setText(event.target.value); }} />
            </label>
            {data.instances.length > 0 ? (
              <SettingField label={t('st.im.instance')} htmlFor="im-instance">
                <SettingsSelect id="im-instance" variant="form" ariaLabel={t('st.im.instance')} value={instanceId}
                  emptyText={t('st.im.paste')}
                  choices={[{ value: '', label: t('st.im.paste') }, ...data.instances.map((item) => ({ value: item.id, label: item.label ?? item.provider_kind }))]}
                  onChange={setInstanceId} dataAttr="data-im-instance" />
              </SettingField>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={SECONDARY_BUTTON} data-im-check disabled={text.trim() === ''}
                onClick={() => { void run(async () => {
                  const result = await client.imSessions.paste(text, instanceId === '' ? undefined : instanceId);
                  setPasteNote(result);
                  setText('');
                  const checked = await client.imSessions.check(result.provider_instance_id);
                  if (checked.ok) return client.imSessions.listen(result.provider_instance_id, true);
                  return client.imSessions.snapshot();
                }); }}>
                {t('st.im.check')}
              </button>
            </div>
            {pasteNote !== undefined && pasteNote.ignored_keys.length > 0 ? <p className="text-[12px] text-ink-soft" data-im-ignored>{t('st.im.ignored')}: {pasteNote.ignored_keys.join(', ')}</p> : null}
            {pasteNote?.chat_hint_ignored === true ? <p className="text-[12px] text-ink-soft" data-im-chat-hint>{t('st.im.chatHint')}</p> : null}
            {data.instances.map((item) => (
              <div key={item.id} data-im-instance-row={item.id} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium text-ink">{item.label ?? item.provider_kind}</span>
                <span className="text-ink-faint" data-im-adapter={item.adapter}>{item.account_id ?? item.adapter}</span>
                {item.conflict === 'webhook' ? <span data-im-webhook className="text-ink">{t('st.im.webhook')}</span> : null}
                {item.adapter === 'missing' ? <span data-im-missing>{t('st.im.missing')}</span> : null}
                <button type="button" className={SECONDARY_BUTTON} data-im-listen={item.id}
                  onClick={() => { void run(async () => { await client.imSessions.check(item.id); return client.imSessions.listen(item.id, !item.listening); }); }}>
                  {item.listening ? t('st.im.stop') : t('st.im.listen')}
                </button>
              </div>
            ))}
            {data.discoveries.map((item) => (
              <div key={item.id} data-im-discovery={item.id} className="space-y-2 rounded-lg border border-hairline bg-paper px-3 py-2">
                <p className="text-[13px] text-ink">{t('st.im.discovery')}</p>
                <p className="text-[12px] text-ink-soft">{[item.identity.chat_title, item.identity.sender_name, item.preview].filter(Boolean).join(' · ')}</p>
                <SettingsSelect id={`im-target-${item.id}`} variant="form" ariaLabel={t('st.im.target')} value={selected} choices={choices}
                  emptyText={t('st.im.target')} onChange={setTarget} dataAttr="data-im-target" />
                <div className="flex flex-wrap gap-3">
                  <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={setBusy} dataAttr="data-im-busy"
                    choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
                  <SettingsSegmented ariaLabel={t('st.im.text')} value={reply} onChange={setReply} dataAttr="data-im-text"
                    choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />
                  <SettingsSegmented ariaLabel={t('st.im.actions')} value={actions ? 'on' : 'off'} onChange={(value) => { setActions(value === 'on'); }} dataAttr="data-im-actions"
                    choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
                </div>
                <label className="flex items-center gap-2 text-[12px] text-ink-soft">
                  <input type="checkbox" data-im-also-home checked={alsoHome} onChange={(event) => { setAlsoHome(event.target.checked); }} />
                  {t('st.im.alsoHome')}
                </label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={SECONDARY_BUTTON} data-im-confirm={item.id} disabled={selected === ''}
                    onClick={() => { void run(() => client.imSessions.confirm(item.id, confirmBody(selected, busy, reply, actions, alsoHome))); }}>
                    {t('st.im.confirm')}
                  </button>
                  <button type="button" className={SECONDARY_BUTTON} data-im-dismiss={item.id}
                    onClick={() => { void run(() => client.imSessions.dismiss(item.id)); }}>{t('st.im.dismiss')}</button>
                </div>
              </div>
            ))}
            {data.bindings.map((binding) => (
              <div key={binding.id} data-im-binding={binding.id} className="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
                <span className="text-ink">{binding.identity.sender_name ?? binding.identity.sender_id}</span>
                <span className="text-ink-faint">{binding.session_id}</span>
                <SettingsSegmented ariaLabel={t('st.im.busy')} value={binding.busy} dataAttr="data-im-binding-busy"
                  onChange={(value) => { void run(() => client.imSessions.updateBinding(binding.id, { busy: value })); }}
                  choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
                <SettingsSegmented ariaLabel={t('st.im.text')} value={binding.reply} dataAttr="data-im-binding-text"
                  onChange={(value) => { void run(() => client.imSessions.updateBinding(binding.id, { reply: value })); }}
                  choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />
                <button type="button" className={SECONDARY_BUTTON} data-im-session-switch={binding.id}
                  onClick={() => { void run(() => client.imSessions.updateBinding(binding.id, { session_enabled: binding.session_enabled === false })); }}>
                  {t('st.im.sessionSwitch')}: {binding.session_enabled === false ? t('st.im.off') : t('st.im.on')}
                </button>
                <button type="button" className={SECONDARY_BUTTON} data-im-enabled={binding.id}
                  onClick={() => { void run(() => client.imSessions.updateBinding(binding.id, { enabled: !binding.enabled })); }}>
                  {binding.enabled ? t('st.im.disable') : t('st.im.enable')}
                </button>
                <button type="button" className={SECONDARY_BUTTON} data-im-remove={binding.id}
                  onClick={() => { void run(() => client.imSessions.removeBinding(binding.id)); }}>{t('st.im.remove')}</button>
              </div>
            ))}
            {data.bindings.length === 0 && data.discoveries.length === 0 ? <p className="text-[12px] text-ink-faint" data-im-empty>{t('st.im.empty')}</p> : null}
            {data.strangers.length > 0 ? <p data-im-strangers className="text-[12px] text-ink-soft">{t('st.im.strangers')}: {data.strangers.reduce((sum, item) => sum + item.count, 0)}</p> : null}
            {data.voice_fallbacks > 0 ? <p data-im-voice className="text-[12px] text-ink-soft">{t('st.im.voice')}: {data.voice_fallbacks}</p> : null}
            {error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: error }} /> : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}

function targetChoices(catalog: ImCatalog | undefined): { value: string; label: string }[] {
  if (catalog === undefined) return [];
  return [
    ...catalog.personas.map((persona) => ({ value: `persona:${persona.id}`, label: persona.name })),
    ...catalog.sessions.map((session) => ({ value: `session:${session.id}`, label: session.title })),
  ];
}

function confirmBody(selected: string, busy: 'queue' | 'steer', reply: 'final' | 'edit', actions: boolean, alsoHome: boolean): ImConfirmRequest {
  const [kind, id] = selected.split(':') as ['persona' | 'session', string];
  const target = kind === 'session' ? { kind: 'session' as const, session_id: id } : { kind: 'persona' as const, persona_id: id };
  return { target, busy, reply, mobile_interactions: actions, ...(alsoHome ? { also_home: true } : {}) };
}

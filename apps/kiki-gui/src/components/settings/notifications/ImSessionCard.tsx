import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  imSessionAdmitted,
  type ImBinding,
  type ImBindingPatch,
  type ImCatalog,
  type ImConfirmRequest,
  type ImConnectionDetail,
  type ImDiscovery,
  type ImIdentity,
  type ImPasteResult,
  type ImProviderKind,
  type ImSessionSnapshot,
} from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import { wechatQrImage } from './wechatQr';

const KEY = ['im-sessions'] as const;
type ImInstanceStatus = ImSessionSnapshot['instances'][number];
type Translator = ReturnType<typeof useI18n>['t'];

function useImAction() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (work: () => Promise<ImSessionSnapshot | void>): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await work();
      if (next !== undefined) queryClient.setQueryData(KEY, next);
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      setError(message.includes('unsupported_wechat_group') ? t('st.im.wechatDirectOnly') : message || t('st.im.error'));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

export function ImSessionCard() {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const snapshot = useQuery({
    queryKey: KEY,
    queryFn: () => client.imSessions.snapshot(),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  const catalog = useQuery({
    queryKey: [...KEY, 'catalog'],
    queryFn: () => client.imSessions.catalog(),
    enabled: snapshot.data !== undefined,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [text, setText] = useState('');
  const [connectInstanceId, setConnectInstanceId] = useState('');
  const [pasteNote, setPasteNote] = useState<ImPasteResult>();
  const data = snapshot.data;
  const selectedConnectInstance = data?.instances.some((item) => item.id === connectInstanceId) === true ? connectInstanceId : '';
  const checkOnlyInstanceId = selectedConnectInstance || (data?.instances.length === 1 ? data.instances[0]!.id : '');
  const showConnectForm = connectOpen || data?.instances.length === 0;
  const requestedTarget = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('target') ?? '';
  const initialTarget = /^(persona|session):.+/u.test(requestedTarget) ? requestedTarget : '';
  const accounts = useMemo(() => {
    if (data === undefined) return [];
    const result = [...data.instances];
    for (const item of [...data.bindings, ...data.discoveries]) {
      if (!result.some((account) => account.id === item.provider_instance_id)) {
        result.push({ id: item.provider_instance_id, provider_kind: item.provider_kind, account_id: item.account_id, configured: false, listening: false, adapter: 'missing' });
      }
    }
    return result;
  }, [data]);

  return (
    <SectionCard id="st-card-im-session" title={t('st.im.title')}>
      <div className="min-w-0 space-y-5 [&_button]:min-h-9 [&_button]:text-[13px] max-md:[&_button]:min-h-11" data-im-session>
        {snapshot.isError ? <div className="flex flex-wrap items-center gap-2">
          <FeedbackLine feedback={{ tone: 'error', text: t('st.im.loadError') }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-retry onClick={() => { void snapshot.refetch(); }}>{t('st.im.retry')}</button>
        </div> : null}
        {data === undefined ? <p data-im-loading aria-busy="true" className="py-4 text-[13px] text-ink-soft">{t('st.im.loading')}</p> : <>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <SettingField label={t('st.im.allowed')} htmlFor="im-allowed">
                <Toggle id="im-allowed" layout="bare" label={t('st.im.allowed')} checked={data.policy.allowed} disabled={action.saving}
                  onChange={(allowed) => { void action.run(() => client.imSessions.setPolicy({ ...data.policy, allowed })); }} />
              </SettingField>
              <SettingField label={t('st.im.default')} htmlFor="im-default">
                <Toggle id="im-default" layout="bare" label={t('st.im.default')} checked={data.policy.default_enabled} disabled={action.saving}
                  onChange={(default_enabled) => { void action.run(() => client.imSessions.setPolicy({ ...data.policy, default_enabled })); }} />
              </SettingField>
            </div>
            {accounts.length > 0 ? <button type="button" className={SECONDARY_BUTTON} data-im-connect-toggle aria-expanded={showConnectForm}
              onClick={() => { setConnectOpen((open) => !open); }}>{t(showConnectForm ? 'st.im.connectHide' : 'st.im.connectNew')}</button> : null}
          </div>
          <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
          {catalog.isError ? <div className="flex flex-wrap items-center gap-2" data-im-catalog-error>
            <FeedbackLine feedback={{ tone: 'error', text: t('st.im.catalogError') }} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void catalog.refetch(); }}>{t('st.im.retry')}</button>
          </div> : null}

          <div className={showConnectForm ? 'space-y-3 border-y border-hairline py-4' : 'hidden'} data-im-connect-drawer>
            <p className="text-[13px] leading-5 text-ink-soft">{t('st.im.hint')}</p>
            <WechatScan onConfirmed={(id) => {
              setConnectOpen(false);
              void action.run(async () => {
                const fresh = await client.imSessions.snapshot();
                queryClient.setQueryData(KEY, fresh);
                const wechat = fresh.instances.find((item) => item.id === id && item.provider_kind === 'wechat_bridge');
                if (wechat === undefined) return fresh;
                if (wechat.listening && wechat.connection !== 'auth_expired' && wechat.connection !== 'stopped' && wechat.adapter !== 'stopped') return fresh;
                const checked = await client.imSessions.check(wechat.id);
                if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
                return client.imSessions.listen(wechat.id, true);
              });
            }} />
            <label className="block space-y-1 text-[13px] text-ink-soft">
              <span>{t('st.im.paste')}</span>
              <textarea data-im-paste value={text} rows={2} placeholder={t('st.im.pastePlaceholder')} className={INPUT} onChange={(event) => { setText(event.target.value); }} />
            </label>
            {data.instances.length > 0 ? <SettingField label={t('st.im.instance')} htmlFor="im-instance">
              <SettingsSelect id="im-instance" variant="form" ariaLabel={t('st.im.instance')} value={selectedConnectInstance} emptyText={t('st.im.newAccount')}
                choices={[{ value: '', label: t('st.im.newAccount') }, ...data.instances.map((item) => ({ value: item.id, label: `${instanceDisplayName(item, t)} · ${item.account_id ?? item.id}` }))]}
                onChange={setConnectInstanceId} dataAttr="data-im-instance" />
            </SettingField> : null}
            <button type="button" className={SECONDARY_BUTTON} data-im-check disabled={action.saving || (text.trim() === '' && checkOnlyInstanceId === '')}
              onClick={() => { void action.run(async () => {
                let id = checkOnlyInstanceId;
                if (text.trim() !== '') {
                  const result = await client.imSessions.paste(text, selectedConnectInstance === '' ? undefined : selectedConnectInstance);
                  setPasteNote(result);
                  setText('');
                  id = result.provider_instance_id;
                  setConnectInstanceId(id);
                  queryClient.setQueryData(KEY, await client.imSessions.snapshot());
                }
                const checked = await client.imSessions.check(id);
                if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
                const next = await client.imSessions.listen(id, true);
                setConnectOpen(false);
                return next;
              }); }}>{t('st.im.check')}</button>
            {pasteNote !== undefined && pasteNote.ignored_keys.length > 0 ? <p className="text-[13px] text-ink-soft" data-im-ignored>{t('st.im.ignored')}: {pasteNote.ignored_keys.join(', ')}</p> : null}
            {pasteNote?.chat_hint_ignored === true ? <p className="text-[13px] text-ink-soft" data-im-chat-hint>{t('st.im.chatHint')}</p> : null}
          </div>

          <div className="space-y-6" data-im-accounts>
            {accounts.map((account) => <AccountChannels key={account.id} account={account} data={data} catalog={catalog.data} initialTarget={initialTarget} refresh={() => { void snapshot.refetch(); }} reauthorize={() => { setConnectInstanceId(account.id); setConnectOpen(true); }} />)}
          </div>
          {accounts.length === 0 ? <p data-im-empty className="text-[13px] text-ink-soft">{t('st.im.empty')}</p> : null}
          {data.strangers.length > 0 ? <p data-im-strangers className="text-[13px] text-ink-soft">{t('st.im.strangers')}: {data.strangers.reduce((sum, item) => sum + item.count, 0)}</p> : null}
          {data.voice_fallbacks > 0 ? <p data-im-voice className="text-[13px] text-ink-soft">{t('st.im.voice')}: {data.voice_fallbacks}</p> : null}
        </>}
      </div>
    </SectionCard>
  );
}

function AccountChannels({ account, data, catalog, initialTarget, refresh, reauthorize }: {
  account: ImInstanceStatus; data: ImSessionSnapshot; catalog: ImCatalog | undefined; initialTarget: string; refresh: () => void; reauthorize: () => void;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const action = useImAction();
  const [adding, setAdding] = useState(false);
  const bindings = data.bindings.filter((item) => item.provider_instance_id === account.id);
  const discoveries = data.discoveries.filter((item) => item.provider_instance_id === account.id);
  const state = instanceStateInfo(account, t);
  const showAdd = adding || bindings.length === 0;
  const startListening = () => action.run(async () => {
    const checked = await client.imSessions.check(account.id);
    if (!checked.ok) throw new Error(checked.detail ?? t('st.im.error'));
    return client.imSessions.listen(account.id, true);
  });
  const listen = () => { void (account.listening ? action.run(() => client.imSessions.listen(account.id, false)) : startListening()); };
  return <section data-im-account={account.id} className="min-w-0 border-t border-hairline pt-4">
    <div data-im-instance-row={account.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="text-[14px] font-medium text-ink">{instanceDisplayName(account, t)}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
          <span className="break-all font-mono" data-im-adapter={account.adapter}>{account.account_id ?? account.id}</span>
          <span data-im-instance-state={state.state} data-im-connection={account.connection}>{state.label}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {bindings.length > 0 ? <button type="button" className={SECONDARY_BUTTON} data-im-start-bind={account.id} aria-expanded={showAdd}
          onClick={() => { setAdding((open) => !open); }}>{t(showAdd ? 'st.im.closeBindFlow' : 'st.im.bindAction')}</button> : null}
        {state.state === 'auth_expired' ? <button type="button" className={SECONDARY_BUTTON} data-im-reauthorize={account.id} onClick={reauthorize}>{t('st.im.reauthorize')}</button> : null}
        {state.state === 'stopped' && account.listening ? <button type="button" className={SECONDARY_BUTTON} data-im-retry-connection={account.id} disabled={action.saving || account.adapter === 'missing'} onClick={() => { void startListening(); }}>{t('st.im.retryConnection')}</button> : null}
        {account.listening || bindings.length > 0 ? <button type="button" className={SECONDARY_BUTTON} data-im-listen={account.id} disabled={action.saving || account.adapter === 'missing'} onClick={listen}>{t(account.listening ? 'st.im.stop' : 'st.im.listen')}</button> : null}
      </div>
    </div>
    {account.connection_detail !== undefined ? <ConnectionFailure detail={account.connection_detail} /> : state.state === 'auth_expired' ? <p className="mt-2 text-[13px] text-amber-ink">{t('st.im.authExpiredHint')}</p> : null}
    {account.conflict === 'webhook' ? <p data-im-webhook className="mt-2 text-[13px] text-amber-ink">{t('st.im.webhook')}</p> : null}
    {account.adapter === 'missing' ? <p data-im-missing className="mt-2 text-[13px] text-ink-soft">{t('st.im.missing')}</p> : null}
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
    {bindings.length > 0 ? <div data-im-bindings-list className="mt-3 divide-y divide-hairline">
      {bindings.map((binding) => <BindingRow key={binding.id} binding={binding} policy={data.policy} catalog={catalog} />)}
    </div> : null}
    {showAdd ? <div data-im-bind-flow={account.id} className="mt-3 space-y-2 bg-ink/[0.025] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-medium text-ink">{t('st.im.bindTitle')}</h4>
        <button type="button" className={SECONDARY_BUTTON} data-im-refresh-discovery onClick={refresh}>{t('st.im.refreshDiscovery')}</button>
      </div>
      <p className="text-[13px] leading-5 text-ink-soft" data-im-awaiting-discovery>{t(account.provider_kind === 'wechat_bridge' ? account.listening ? 'st.im.wechatDiscover' : 'st.im.wechatAwaitingListen' : account.listening ? 'st.im.waitingBody' : 'st.im.awaitingListenBody')}</p>
      {!account.listening && account.adapter !== 'missing' ? <button type="button" data-im-bind-listen className={SECONDARY_BUTTON} disabled={action.saving} onClick={listen}>{t('st.im.startListenNow')}</button> : null}
    </div> : null}
    {discoveries.length > 0 ? <div className="mt-3 divide-y divide-hairline" data-im-discoveries={account.id}>
      {discoveries.map((discovery) => <DiscoveryRow key={discovery.id} discovery={discovery} catalog={catalog} initialTarget={initialTarget} />)}
    </div> : null}
  </section>;
}

function BindingRow({ binding, policy, catalog }: { binding: ImBinding; policy: ImSessionSnapshot['policy']; catalog: ImCatalog | undefined }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const action = useImAction();
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [search, setSearch] = useState('');
  const sessions = useQuery({
    queryKey: [...KEY, 'session-search', search.trim()],
    queryFn: async () => (await client.listSessions({ q: search.trim(), page_size: 20 })).items,
    enabled: expanded && search.trim() !== '',
  });
  const targetCatalog = catalog === undefined ? undefined : { ...catalog, sessions: [...new Map([...catalog.sessions, ...(sessions.data ?? []).map((item) => ({ id: item.id, title: item.title?.trim() || item.id }))].map((item) => [item.id, item])).values()] };
  const identity = identityLabel(binding.identity, t);
  const on = binding.enabled && imSessionAdmitted({ allowed: policy.allowed, defaultEnabled: policy.default_enabled, sessionEnabled: binding.session_enabled });
  const blocked = !policy.allowed || !binding.enabled;
  const update = (patch: ImBindingPatch) => { void action.run(() => client.imSessions.updateBinding(binding.id, patch)); };
  const targetValue = binding.persona_id === undefined ? `session:${binding.session_id}` : `persona:${binding.persona_id}`;
  return <div data-im-binding={binding.id} aria-busy={action.saving} className="space-y-3 py-4">
    <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,1fr)_auto] md:items-center">
      <div className="min-w-0 space-y-1">
        <p className="break-words text-[14px] font-medium text-ink" data-im-binding-identity>{identity}</p>
        <IdentityIds identity={binding.identity} />
      </div>
      <div className="min-w-0">
        <SettingsSelect id={`im-binding-target-${binding.id}`} variant="form" ariaLabel={`${identity}: ${t('st.im.target')}`} value={targetValue}
          choices={bindingTargetChoices(targetCatalog, binding, t)} emptyText={binding.session_id} disabled={action.saving}
          onChange={(value) => { update({ target: parseTarget(value) }); }} dataAttr="data-im-binding-target" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" role="switch" aria-checked={on} aria-label={`${identity}: ${t('st.im.sessionSwitch')}`}
          className={SECONDARY_BUTTON} data-im-session-switch={binding.id} disabled={action.saving || blocked}
          onClick={() => { update({ session_enabled: !on }); }}>{t('st.im.sessionSwitch')}: {t(on ? 'st.im.on' : 'st.im.off')}</button>
        <button type="button" className={SECONDARY_BUTTON} data-im-binding-options-toggle={binding.id} aria-expanded={expanded}
          onClick={() => { setExpanded((open) => !open); setRemoving(false); }}>{t('st.im.bindingOptions')}</button>
      </div>
    </div>
    {blocked ? <p className="text-[13px] text-ink-soft" data-im-binding-blocked>{t(!policy.allowed ? 'st.im.railOffAllowed' : 'st.im.railOffBinding')}</p> : null}
    {expanded ? <div data-im-binding-details={binding.id} className="space-y-3">
      <input type="search" data-im-binding-target-search value={search} aria-label={t('st.im.searchTarget')} placeholder={t('st.im.searchTarget')} className={`${INPUT} max-w-sm`} onChange={(event) => { setSearch(event.target.value); }} />
      {sessions.isError ? <p role="alert" className="text-[13px] text-danger">{t('st.im.searchError')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-ink-soft">{t('st.im.sessionSwitch')}</span>
        <SettingsSegmented ariaLabel={`${identity}: ${t('st.im.sessionSwitch')}`} value={binding.session_enabled === undefined ? 'default' : binding.session_enabled ? 'on' : 'off'} disabled={action.saving}
          dataAttr="data-im-binding-policy" choices={[{ value: 'default', label: t('st.im.followDefault') }, { value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]}
          onChange={(value) => { update({ session_enabled: value === 'default' ? null : value === 'on' }); }} />
      </div>
      <BindingOptions kind={binding.provider_kind} busy={binding.busy} reply={binding.reply} actions={binding.mobile_interactions} disabled={action.saving} prefix="data-im-binding"
        onBusy={(busy) => { update({ busy }); }} onReply={(reply) => { update({ reply }); }} onActions={(mobile_interactions) => { update({ mobile_interactions }); }} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BUTTON} data-im-enabled={binding.id} disabled={action.saving} onClick={() => { update({ enabled: !binding.enabled }); }}>{t(binding.enabled ? 'st.im.disable' : 'st.im.enable')}</button>
        {removing ? <>
          <span className="text-[13px] text-ink-soft">{t('st.im.removeConfirm', { name: identity })}</span>
          <button type="button" className={SECONDARY_BUTTON} data-im-remove-confirm={binding.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.removeBinding(binding.id)); }}>{t('st.im.remove')}</button>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { setRemoving(false); }}>{t('common.cancel')}</button>
        </> : <button type="button" className={SECONDARY_BUTTON} data-im-remove={binding.id} onClick={() => { setRemoving(true); }}>{t('st.im.remove')}</button>}
      </div>
    </div> : null}
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
  </div>;
}

function DiscoveryRow({ discovery, catalog, initialTarget }: { discovery: ImDiscovery; catalog: ImCatalog | undefined; initialTarget: string }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const action = useImAction();
  const [target, setTarget] = useState(initialTarget);
  const [alsoHome, setAlsoHome] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<'queue' | 'steer'>('queue');
  const [reply, setReply] = useState<'final' | 'edit'>('final');
  const [actions, setActions] = useState(true);
  const unsupported = discovery.provider_kind === 'wechat_bridge' && (discovery.identity.chat_kind === 'group' || discovery.identity.topic_id !== '0');
  const selected = target || (catalog?.personas[0] !== undefined ? `persona:${catalog.personas[0].id}` : catalog?.sessions[0] !== undefined ? `session:${catalog.sessions[0].id}` : '');
  return <div data-im-discovery={discovery.id} className="space-y-3 py-4">
    <div className="space-y-1">
      <p className="text-[13px] text-ink-soft">{t('st.im.discovery')}</p>
      <p className="break-words text-[14px] font-medium text-ink">{identityLabel(discovery.identity, t)}</p>
      <IdentityIds identity={discovery.identity} />
      {discovery.preview !== '' ? <p className="truncate text-[13px] text-ink-soft" title={discovery.preview}>{discovery.preview}</p> : null}
    </div>
    {unsupported ? <p data-im-unsupported className="text-[13px] leading-5 text-ink-soft">{t('st.im.wechatDirectOnly')}</p> : <TargetPicker id={`im-target-${discovery.id}`} value={selected} onChange={setTarget} catalog={catalog} disabled={action.saving} />}
    {!unsupported && selected.startsWith('persona:') ? <label className="flex min-h-8 items-center gap-2 text-[13px] text-ink-soft">
      <input type="checkbox" data-im-also-home checked={alsoHome} disabled={action.saving} onChange={(event) => { setAlsoHome(event.target.checked); }} />{t('st.im.alsoHome')}
    </label> : null}
    {expanded ? <BindingOptions kind={discovery.provider_kind} busy={busy} reply={reply} actions={actions} disabled={action.saving} prefix="data-im"
      onBusy={setBusy} onReply={setReply} onActions={setActions} /> : null}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={PRIMARY_BUTTON} data-im-confirm={discovery.id} disabled={unsupported || selected.length <= 8 || catalog === undefined || action.saving}
        onClick={() => { void action.run(async () => {
          const next = await client.imSessions.confirm(discovery.id, { target: parseTarget(selected), busy, reply: liveText(discovery.provider_kind) ? reply : 'final', mobile_interactions: actions, also_home: selected.startsWith('persona:') && alsoHome });
          void queryClient.invalidateQueries({ queryKey: [...KEY, 'catalog'] });
          return next;
        }); }}>{t('st.im.confirm')}</button>
      <button type="button" className={SECONDARY_BUTTON} data-im-dismiss={discovery.id} disabled={action.saving} onClick={() => { void action.run(() => client.imSessions.dismiss(discovery.id)); }}>{t('st.im.dismiss')}</button>
      {!unsupported ? <button type="button" className={SECONDARY_BUTTON} data-im-advanced-toggle aria-expanded={expanded} onClick={() => { setExpanded((open) => !open); }}>{t('st.im.advancedOptions')}</button> : null}
    </div>
    <FeedbackLine feedback={action.error === undefined ? null : { tone: 'error', text: action.error }} />
  </div>;
}

function TargetPicker({ id, value, onChange, catalog, disabled }: { id: string; value: string; onChange: (value: string) => void; catalog: ImCatalog | undefined; disabled: boolean }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [search, setSearch] = useState('');
  const kind = value.startsWith('session:') ? 'session' : 'persona';
  const query = search.trim();
  const sessions = useQuery({
    queryKey: [...KEY, 'session-search', query],
    queryFn: async () => (await client.listSessions({ q: query, page_size: 20 })).items,
    enabled: query !== '' && kind === 'session',
  });
  const choices = [...(catalog?.personas ?? []).map((item) => ({ value: `persona:${item.id}`, label: `${t('st.im.kindPersona')} · ${item.name}` })),
    ...[...new Map([...(catalog?.sessions ?? []), ...(sessions.data ?? []).map((item) => ({ id: item.id, title: item.title?.trim() || item.id }))].map((item) => [item.id, item])).values()]
      .map((item) => ({ value: `session:${item.id}`, label: `${t('st.im.kindSession')} · ${item.title}` }))];
  if (value.length > 8 && !choices.some((item) => item.value === value)) choices.unshift({ value, label: value.slice(8) });
  const filtered = choices.filter((item) => item.value === value || (item.value.startsWith(`${kind}:`) && item.label.toLowerCase().includes(query.toLowerCase())));
  return <div className="space-y-2" data-im-target-editor={id}>
    <div className="flex flex-wrap items-center gap-2">
      <SettingsSegmented ariaLabel={t('st.im.target')} value={kind} disabled={disabled} dataAttr="data-im-target-kind"
        choices={[{ value: 'persona', label: t('st.im.kindPersona') }, { value: 'session', label: t('st.im.kindSession') }]}
        onChange={(next) => { setSearch(''); onChange(choices.find((item) => item.value.startsWith(`${next}:`))?.value ?? `${next}:`); }} />
      {kind === 'session' || choices.length > 6 ? <input type="search" value={search} data-im-target-search placeholder={t('st.im.searchTarget')} aria-label={t('st.im.searchTarget')} className={`${INPUT} min-w-0 flex-1`} onChange={(event) => { setSearch(event.target.value); }} /> : null}
    </div>
    <SettingsSelect id={id} variant="form" ariaLabel={t('st.im.target')} value={value} choices={filtered} onChange={onChange} disabled={disabled || filtered.length === 0} emptyText={t('st.im.noTargetsYet')} dataAttr="data-im-target" />
    {sessions.isError ? <p role="alert" className="text-[13px] text-danger">{t('st.im.searchError')}</p> : null}
  </div>;
}

function BindingOptions({ kind, busy, reply, actions, disabled, prefix, onBusy, onReply, onActions }: {
  kind: ImProviderKind; busy: 'queue' | 'steer'; reply: 'final' | 'edit'; actions: boolean; disabled: boolean; prefix: string;
  onBusy: (value: 'queue' | 'steer') => void; onReply: (value: 'final' | 'edit') => void; onActions: (value: boolean) => void;
}) {
  const { t } = useI18n();
  return <div className="flex flex-wrap items-start gap-x-6 gap-y-3" data-im-bind-advanced>
    <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.busy')}</p>
      <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={onBusy} disabled={disabled} dataAttr={`${prefix}-busy`} choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
    </div>
    <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.text')}</p>
      <ReplyMode kind={kind} value={reply} onChange={onReply} disabled={disabled} dataAttr={`${prefix}-text`} />
    </div>
    <div className="space-y-1"><p className="text-[13px] text-ink-soft">{t('st.im.actions')}</p>
      <SettingsSegmented ariaLabel={t('st.im.actions')} value={actions ? 'on' : 'off'} disabled={disabled} dataAttr={`${prefix}-actions`} onChange={(value) => { onActions(value === 'on'); }} choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
    </div>
  </div>;
}

function IdentityIds({ identity }: { identity: ImIdentity }) {
  const { t } = useI18n();
  return <p className="break-all font-mono text-[12px] leading-5 text-ink-soft" data-im-identity-ids>
    {t('st.im.chatId')}: {identity.chat_id} · {t('st.im.senderId')}: {identity.sender_id}{identity.topic_id !== '0' ? ` · ${t('st.im.topicId')}: ${identity.topic_id}` : ''}
  </p>;
}

function identityLabel(identity: ImIdentity, t: Translator): string {
  return [identity.chat_title ?? identity.sender_name ?? identity.chat_id,
    identity.chat_title !== undefined ? identity.sender_name : undefined,
    identity.topic_id !== '0' ? identity.topic_title ?? `${t('st.im.topicId')} ${identity.topic_id}` : undefined].filter(Boolean).join(' · ');
}

function parseTarget(value: string): ImConfirmRequest['target'] {
  return value.startsWith('persona:') ? { kind: 'persona', persona_id: value.slice(8) } : { kind: 'session', session_id: value.slice(8) };
}

function bindingTargetChoices(catalog: ImCatalog | undefined, binding: ImBinding, t: Translator): { value: string; label: string }[] {
  const choices = [
    ...(catalog?.personas ?? []).map((item) => ({ value: `persona:${item.id}`, label: `${t('st.im.kindPersona')} · ${item.name}` })),
    ...(catalog?.sessions ?? []).map((item) => ({ value: `session:${item.id}`, label: `${t('st.im.kindSession')} · ${item.title}` })),
  ];
  const current = binding.persona_id === undefined ? `session:${binding.session_id}` : `persona:${binding.persona_id}`;
  if (!choices.some((choice) => choice.value === current)) choices.unshift({ value: current, label: binding.persona_id ?? binding.session_id });
  return choices;
}

function providerDisplayName(kind: ImProviderKind, t: Translator): string {
  return t(`st.im.provider.${kind}`);
}

function instanceDisplayName(item: ImInstanceStatus, t: Translator): string {
  const platform = providerDisplayName(item.provider_kind, t);
  return item.label !== undefined && item.label.trim() !== '' && item.label !== item.provider_kind ? `${item.label} (${platform})` : platform;
}

function instanceStateInfo(item: ImInstanceStatus, t: Translator): { state: 'listening' | 'starting' | 'reconnecting' | 'auth_expired' | 'stopped'; label: string } {
  const connection: string | undefined = item.connection;
  if (connection === 'auth_expired') return { state: 'auth_expired', label: t('st.im.stateAuthExpired') };
  if (!item.listening) return { state: 'stopped', label: t('st.im.stateStopped') };
  if (connection === 'starting') return { state: 'starting', label: t('st.im.stateStarting') };
  if (connection === 'reconnecting') return { state: 'reconnecting', label: t('st.im.stateReconnecting') };
  if (connection === 'stopped' || item.adapter === 'stopped' || item.adapter === 'missing') return { state: 'stopped', label: t('st.im.stateListenerStopped') };
  return { state: 'listening', label: t('st.im.stateListening') };
}

function ConnectionFailure({ detail }: { detail: ImConnectionDetail }) {
  const { t } = useI18n();
  const values = [detail.http_status === undefined ? undefined : `HTTP ${detail.http_status}`, detail.ret === undefined ? undefined : `ret ${detail.ret}`, detail.errcode === undefined ? undefined : `errcode ${detail.errcode}`].filter(Boolean);
  if (values.length === 0 && detail.failure_count === undefined && detail.retry_in_ms === undefined) return <p data-im-connection-detail className="mt-2 text-[13px] leading-5 text-ink-soft">{t(`st.im.failure.${detail.code}`)}</p>;
  return <details data-im-connection-detail className="mt-2 text-[13px] leading-5 text-ink-soft">
    <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-selected-ink">{t(`st.im.failure.${detail.code}`)}</summary>
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-4 font-mono">
      {values.length > 0 ? <span>{values.join(' · ')}</span> : null}
      {detail.failure_count !== undefined ? <span>{t('st.im.failureCount', { count: detail.failure_count })}</span> : null}
      {detail.retry_in_ms !== undefined ? <span>{t('st.im.retryDelay', { seconds: Math.ceil(detail.retry_in_ms / 1000) })}</span> : null}
    </div>
  </details>;
}

function liveText(kind: ImProviderKind): boolean {
  return kind === 'telegram' || kind === 'feishu_app';
}

function ReplyMode({ kind, value, onChange, disabled, dataAttr }: { kind: ImProviderKind; value: 'final' | 'edit'; onChange: (value: 'final' | 'edit') => void; disabled: boolean; dataAttr: string }) {
  const { t } = useI18n();
  if (!liveText(kind)) return <div className="max-w-sm space-y-1 text-[13px] leading-5 text-ink-soft">
    <span className="text-ink" data-im-text-fixed={kind}>{t('st.im.final')}</span>
    <p data-im-text-note>{t(kind === 'onebot_v11' ? 'st.im.qqText' : 'st.im.wechatText')}</p>
    {kind === 'onebot_v11' ? <p data-im-file-note>{t('st.im.fileNote')}</p> : null}
  </div>;
  return <SettingsSegmented ariaLabel={t('st.im.text')} value={value} onChange={onChange} disabled={disabled} dataAttr={dataAttr} choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />;
}

function WechatScan({ onConfirmed }: { onConfirmed?: (providerInstanceId?: string) => void }) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [loginId, setLoginId] = useState<string | undefined>();
  const [image, setImage] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const polling = loginId !== undefined && (status === undefined || status === 'wait' || status === 'scaned' || status === 'scaned_but_redirect');

  useEffect(() => {
    if (!polling || loginId === undefined) return;
    let stop = false;
    const tick = () => {
      void client.imSessions.pollWechatQr(loginId).then((result) => {
        if (stop) return;
        setStatus(result.status);
        if (result.status === 'confirmed') {
          void queryClient.invalidateQueries({ queryKey: KEY });
          onConfirmed?.(result.provider_instance_id);
        }
      }).catch((caught: unknown) => {
        if (stop) return;
        const message = caught instanceof Error ? caught.message : '';
        if (message === 'wechat_login_cancelled' || message === 'unknown_login') return;
        setError(message.length > 0 ? message : t('st.im.error'));
      });
    };
    const timer = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(timer); };
  }, [client, loginId, onConfirmed, polling, queryClient, t]);

  const start = () => {
    setError(undefined);
    setVerifyCode('');
    void client.imSessions.startWechatQr().then((started) => {
      setLoginId(started.login_id);
      setImage(started.image);
      setStatus('wait');
    }).catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : t('st.im.error')); });
  };
  const cancel = () => {
    const id = loginId;
    setLoginId(undefined);
    setImage(undefined);
    setStatus('cancelled');
    if (id !== undefined) void client.imSessions.cancelWechatQr(id);
  };

  return (
    <div className="space-y-2" data-im-wechat>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY_BUTTON} data-im-wechat-scan onClick={start}>{t('st.im.wechatScan')}</button>
        {loginId !== undefined ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-cancel onClick={cancel}>{t('st.im.wechatCancel')}</button> : null}
        {status === 'expired' || status === 'verify_code_blocked' ? <button type="button" className={SECONDARY_BUTTON} data-im-wechat-retry onClick={start}>{t('st.im.retry')}</button> : null}
      </div>
      {image !== undefined && status !== 'cancelled' ? <WechatImage image={image} /> : null}
      {status !== undefined && status !== 'confirmed' ? <p className="text-[13px] text-ink-soft" data-im-wechat-status>{t(wechatStatusKey(status))}</p> : null}
      {status === 'need_verifycode' ? (
        <div className="flex flex-wrap items-center gap-2">
          <input data-im-wechat-verify value={verifyCode} className={INPUT} aria-label={t('st.im.wechatVerify')}
            onChange={(event) => { setVerifyCode(event.target.value); }} />
          <button type="button" className={SECONDARY_BUTTON} data-im-wechat-verify-submit disabled={verifyCode.trim() === ''}
            onClick={() => {
              if (loginId === undefined) return;
              void client.imSessions.pollWechatQr(loginId, verifyCode.trim()).then((result) => {
                setStatus(result.status);
                if (result.status === 'confirmed') {
                  void queryClient.invalidateQueries({ queryKey: KEY });
                  onConfirmed?.(result.provider_instance_id);
                }
              }).catch((caught: unknown) => { setError(caught instanceof Error ? caught.message : t('st.im.error')); });
            }}>{t('st.im.check')}</button>
        </div>
      ) : null}
      {error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: error }} /> : null}
    </div>
  );
}

function WechatImage({ image }: { image: string }) {
  if (image.startsWith('data:image')) return <img alt="" src={image} data-im-wechat-image className="h-40 w-40 bg-paper" />;
  const drawn = wechatQrImage(image);
  if (drawn !== undefined) {
    return (
      <div className="space-y-1">
        <img alt="" src={drawn} data-im-wechat-image className="h-40 w-40 bg-paper" />
        {image.startsWith('https://') ? <input readOnly data-im-wechat-code value={image} className={INPUT} /> : null}
      </div>
    );
  }
  return <input readOnly data-im-wechat-code value={image} className={INPUT} />;
}

function wechatStatusKey(status: string): 'st.im.wechatWaiting' | 'st.im.wechatScanned' | 'st.im.wechatExpired' | 'st.im.wechatVerify' | 'st.im.wechatBlocked' | 'st.im.wechatBound' | 'st.im.wechatCancel' | 'st.im.error' {
  if (status === 'wait') return 'st.im.wechatWaiting';
  if (status === 'scaned' || status === 'scaned_but_redirect') return 'st.im.wechatScanned';
  if (status === 'expired') return 'st.im.wechatExpired';
  if (status === 'need_verifycode') return 'st.im.wechatVerify';
  if (status === 'verify_code_blocked') return 'st.im.wechatBlocked';
  if (status === 'binded_redirect') return 'st.im.wechatBound';
  if (status === 'cancelled') return 'st.im.wechatCancel';
  return 'st.im.error';
}

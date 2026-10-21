import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  imSessionAdmitted,
  type ImBinding,
  type ImCatalog,
  type ImConfirmRequest,
  type ImPasteResult,
  type ImProviderKind,
  type ImSessionSnapshot,
} from '@kiki/protocol';

type ImInstanceStatus = ImSessionSnapshot['instances'][number];

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Toggle } from '../../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { SettingField } from '../fields';
import { SectionCard } from '../SectionCard';
import { SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';
import { wechatQrImage } from './wechatQr';

const KEY = ['im-sessions'] as const;

export function ImSessionCard() {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: KEY,
    queryFn: () => client.imSessions.snapshot(),
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  const catalog = useQuery({
    queryKey: [...KEY, 'catalog'],
    queryFn: () => client.imSessions.catalog(),
    enabled: snapshot.isSuccess || snapshot.data !== undefined,
  });

  const [text, setText] = useState('');
  const [connectInstanceId, setConnectInstanceId] = useState('');
  const [bindInstanceId, setBindInstanceId] = useState('');
  const [routeBindingId, setRouteBindingId] = useState('');
  const [target, setTarget] = useState('');
  const [targetKind, setTargetKind] = useState<'persona' | 'session'>('persona');
  const [targetSearch, setTargetSearch] = useState('');
  const [busy, setBusy] = useState<'queue' | 'steer'>('queue');
  const [reply, setReply] = useState<'final' | 'edit'>('final');
  const [actions, setActions] = useState(true);
  const [alsoHome, setAlsoHome] = useState(false);
  const [pasteNote, setPasteNote] = useState<ImPasteResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [connectOpen, setConnectOpen] = useState(false);
  const [bindFlowOpen, setBindFlowOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [expandedBindings, setExpandedBindings] = useState<Record<string, boolean>>({});

  const trimmedSearch = targetSearch.trim();
  const searchedSessions = useQuery({
    queryKey: [...KEY, 'session-search', trimmedSearch],
    queryFn: async () => {
      const maybeList = (client as {
        listSessions?: (query: { q?: string; page_size?: number }) => Promise<{ items: readonly { id: string; title?: string }[] }>;
      }).listSessions;
      if (typeof maybeList !== 'function') return [];
      const res = await maybeList.call(client, { q: trimmedSearch, page_size: 20 });
      return res.items.map((item) => ({ id: item.id, title: item.title?.trim() || item.id }));
    },
    enabled: trimmedSearch.length > 0 && typeof (client as { listSessions?: unknown }).listSessions === 'function',
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const paramTarget = new URLSearchParams(window.location.search).get('target');
    if (paramTarget !== null && (paramTarget.startsWith('persona:') || paramTarget.startsWith('session:'))) {
      setTarget(paramTarget);
      setBindFlowOpen(true);
    }
  }, []);

  const apply = (next: ImSessionSnapshot) => { queryClient.setQueryData(KEY, next); };
  const run = async (work: () => Promise<ImSessionSnapshot | void>) => {
    setError(undefined);
    try {
      const next = await work();
      if (next !== undefined) apply(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('st.im.error'));
    }
  };

  const data = snapshot.data;
  const people = useMemo<ImCatalog | undefined>(() => {
    if (catalog.data === undefined) return undefined;
    const extra = searchedSessions.data ?? [];
    if (extra.length === 0) return catalog.data;
    const seen = new Set(catalog.data.sessions.map((item) => item.id));
    const merged = [...catalog.data.sessions];
    for (const item of extra) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return { ...catalog.data, sessions: merged };
  }, [catalog.data, searchedSessions.data]);
  const allChoices = useMemo(() => targetChoices(people, t), [people, t]);
  const selected = allChoices.some((choice) => choice.value === target) ? target : allChoices[0]?.value ?? '';

  useEffect(() => {
    if (selected.startsWith('persona:')) setTargetKind('persona');
    else if (selected.startsWith('session:')) setTargetKind('session');
  }, [selected]);

  const selectChoices = useMemo(() => {
    const query = targetSearch.trim().toLowerCase();
    const matching = query === ''
      ? allChoices
      : allChoices.filter((choice) => choice.rawLabel.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query));
    const preferred = matching.filter((choice) => choice.kind === targetKind);
    const rest = matching.filter((choice) => choice.kind !== targetKind);
    const ordered = [...preferred, ...rest];
    if (selected !== '' && !ordered.some((choice) => choice.value === selected)) {
      const current = allChoices.find((choice) => choice.value === selected);
      if (current !== undefined) return [current, ...ordered];
    }
    return ordered;
  }, [allChoices, selected, targetKind, targetSearch]);

  const selectedConnectInstance = data !== undefined && data.instances.some((item) => item.id === connectInstanceId)
    ? connectInstanceId
    : '';
  const checkOnlyInstanceId = selectedConnectInstance !== ''
    ? selectedConnectInstance
    : data?.instances.length === 1
      ? data.instances[0]!.id
      : '';

  const effectiveBindInstanceId = data === undefined
    ? ''
    : data.instances.some((item) => item.id === bindInstanceId)
      ? bindInstanceId
      : data.instances.length === 1
        ? data.instances[0]!.id
        : '';

  const activeInstance: ImInstanceStatus | undefined = data?.instances.find((item) => item.id === effectiveBindInstanceId)
    ?? (data?.instances.length === 1 ? data.instances[0] : undefined);
  const hasInstances = (data?.instances.length ?? 0) > 0;
  const hasDiscoveries = (data?.discoveries.length ?? 0) > 0;
  const hasBindings = (data?.bindings.length ?? 0) > 0;

  const candidateBindings = useMemo(() => {
    if (data === undefined) return [];
    if (effectiveBindInstanceId !== '') {
      return data.bindings.filter((item) => item.provider_instance_id === effectiveBindInstanceId);
    }
    return data.bindings;
  }, [data, effectiveBindInstanceId]);

  const visibleDiscoveries = useMemo(() => {
    if (data === undefined) return [];
    if (effectiveBindInstanceId !== '' && data.instances.length > 1) {
      return data.discoveries.filter((item) => item.provider_instance_id === effectiveBindInstanceId);
    }
    return data.discoveries;
  }, [data, effectiveBindInstanceId]);

  const selectedRouteBinding: ImBinding | undefined = candidateBindings.length === 1
    ? candidateBindings[0]
    : candidateBindings.find((item) => item.id === routeBindingId);

  const showConnectForm = !hasInstances || connectOpen;
  const showBindFlow = hasDiscoveries || bindFlowOpen || (hasInstances && !hasBindings);

  const handleKindChange = (nextKind: 'persona' | 'session') => {
    setTargetKind(nextKind);
    if (!selected.startsWith(`${nextKind}:`)) {
      const firstOfKind = allChoices.find((choice) => choice.kind === nextKind);
      if (firstOfKind !== undefined) setTarget(firstOfKind.value);
    }
  };

  const startInstanceListening = (id: string) => {
    void run(async () => {
      const checked = await client.imSessions.check(id);
      if (!checked.ok) {
        setError(checked.detail ?? t('st.im.error'));
        return client.imSessions.snapshot();
      }
      return client.imSessions.listen(id, true);
    });
  };

  return (
    <SectionCard id="st-card-im-session" title={t('st.im.title')}>
      <div className="min-w-0 space-y-4" data-im-session>
        {snapshot.isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <FeedbackLine feedback={{ tone: 'error', text: t('st.im.error') }} />
            <button type="button" className={SECONDARY_BUTTON} data-im-retry onClick={() => { void snapshot.refetch(); }}>{t('st.im.retry')}</button>
          </div>
        ) : null}
        {data === undefined ? <div data-im-loading aria-busy="true" className="min-h-16" /> : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-hairline pb-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <SettingField label={t('st.im.allowed')} htmlFor="im-allowed">
                  <Toggle id="im-allowed" layout="bare" label={t('st.im.allowed')} checked={data.policy.allowed}
                    onChange={(allowed) => { void run(() => client.imSessions.setPolicy({ ...data.policy, allowed })); }} />
                </SettingField>
                <SettingField label={t('st.im.default')} htmlFor="im-default">
                  <Toggle id="im-default" layout="bare" label={t('st.im.default')} checked={data.policy.default_enabled}
                    onChange={(default_enabled) => { void run(() => client.imSessions.setPolicy({ ...data.policy, default_enabled })); }} />
                </SettingField>
              </div>
              {hasInstances ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    data-im-connect-toggle
                    aria-expanded={showConnectForm}
                    onClick={() => { setConnectOpen((prev) => !prev); }}
                  >
                    {showConnectForm ? t('st.im.connectHide') : t('st.im.connectNew')}
                  </button>
                </div>
              ) : null}
            </div>

            {hasInstances ? (
              <div className="divide-y divide-hairline rounded-lg border border-hairline bg-paper/60" data-im-accounts>
                {data.instances.map((item) => {
                  const stateInfo = instanceStateInfo(item, t);
                  return (
                    <div key={item.id} data-im-instance-row={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-[12.5px]">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{instanceDisplayName(item, t)}</span>
                        <span className="font-mono text-[11.5px] text-ink-faint" data-im-adapter={item.adapter}>{item.account_id ?? item.adapter}</span>
                        <span
                          data-im-instance-state={stateInfo.state}
                          data-im-connection={item.connection}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${
                            item.listening ? 'bg-ink/[0.06] font-medium text-ink' : 'text-ink-faint'
                          }`}
                        >
                          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${stateInfo.transient ? 'animate-pulse bg-ink-soft' : item.listening ? 'bg-ink' : 'bg-ink-faint/60'}`} />
                          {stateInfo.label}
                        </span>
                        {item.conflict === 'webhook' ? <span data-im-webhook className="text-[11.5px] text-amber-ink">{t('st.im.webhook')}</span> : null}
                        {item.adapter === 'missing' ? <span data-im-missing className="text-[11.5px] text-ink-soft">{t('st.im.missing')}</span> : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {!showBindFlow || data.instances.length > 1 ? (
                          <button
                            type="button"
                            className={!showBindFlow && !hasBindings ? PRIMARY_BUTTON : SECONDARY_BUTTON}
                            data-im-start-bind={item.id}
                            onClick={() => {
                              setBindInstanceId(item.id);
                              setRouteBindingId('');
                              setBindFlowOpen(true);
                            }}
                          >
                            {t('st.im.bindAction')}
                          </button>
                        ) : null}
                        <button type="button" className={SECONDARY_BUTTON} data-im-listen={item.id}
                          onClick={() => { void run(async () => {
                            if (item.listening) return client.imSessions.listen(item.id, false);
                            const checked = await client.imSessions.check(item.id);
                            if (!checked.ok) {
                              setError(checked.detail ?? t('st.im.error'));
                              return client.imSessions.snapshot();
                            }
                            return client.imSessions.listen(item.id, true);
                          }); }}>
                          {item.listening ? t('st.im.stop') : t('st.im.listen')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className={showConnectForm ? 'space-y-3 rounded-lg border border-hairline bg-paper/40 p-3.5' : 'hidden'} data-im-connect-drawer>
              <p className="text-[12px] leading-5 text-ink-soft">{t('st.im.hint')}</p>
              <WechatScan onConfirmed={(providerInstanceId) => {
                setConnectOpen(false);
                setBindFlowOpen(true);
                void run(async () => {
                  const fresh = await client.imSessions.snapshot();
                  apply(fresh);
                  if (providerInstanceId === undefined) return;
                  const wechat = fresh.instances.find((item) => item.id === providerInstanceId && item.provider_kind === 'wechat_bridge');
                  if (wechat === undefined) return;
                  setBindInstanceId(wechat.id);
                  setRouteBindingId('');
                  if (wechat.listening) return;
                  const checked = await client.imSessions.check(wechat.id);
                  if (!checked.ok) {
                    setError(checked.detail ?? t('st.im.error'));
                    return;
                  }
                  return client.imSessions.listen(wechat.id, true);
                });
              }} />
              <label className="block space-y-1 text-[12px] text-ink-soft">
                <span>{t('st.im.paste')}</span>
                <textarea data-im-paste value={text} rows={2} placeholder={t('st.im.pastePlaceholder')} className={INPUT}
                  onChange={(event) => { setText(event.target.value); }} />
              </label>
              {data.instances.length > 0 ? (
                <SettingField label={t('st.im.instance')} htmlFor="im-instance">
                  <SettingsSelect id="im-instance" variant="form" ariaLabel={t('st.im.instance')} value={selectedConnectInstance}
                    emptyText={t('st.im.paste')}
                    choices={[{ value: '', label: t('st.im.paste') }, ...data.instances.map((item) => ({ value: item.id, label: instanceDisplayName(item, t) }))]}
                    onChange={setConnectInstanceId} dataAttr="data-im-instance" />
                </SettingField>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={SECONDARY_BUTTON} data-im-check disabled={text.trim() === '' && checkOnlyInstanceId === ''}
                  onClick={() => { void run(async () => {
                    if (text.trim() === '') {
                      const checked = await client.imSessions.check(checkOnlyInstanceId);
                      if (checked.ok) return client.imSessions.listen(checkOnlyInstanceId, true);
                      return client.imSessions.snapshot();
                    }
                    const result = await client.imSessions.paste(
                      text,
                      selectedConnectInstance === '' ? undefined : selectedConnectInstance,
                    );
                    setPasteNote(result);
                    setText('');
                    setBindInstanceId(result.provider_instance_id);
                    setConnectOpen(false);
                    setBindFlowOpen(true);
                    const checked = await client.imSessions.check(result.provider_instance_id);
                    if (checked.ok) return client.imSessions.listen(result.provider_instance_id, true);
                    return client.imSessions.snapshot();
                  }); }}>
                  {t('st.im.check')}
                </button>
              </div>
              {pasteNote !== undefined && pasteNote.ignored_keys.length > 0 ? <p className="text-[12px] text-ink-soft" data-im-ignored>{t('st.im.ignored')}: {pasteNote.ignored_keys.join(', ')}</p> : null}
              {pasteNote?.chat_hint_ignored === true ? <p className="text-[12px] text-ink-soft" data-im-chat-hint>{t('st.im.chatHint')}</p> : null}
            </div>

            {hasBindings ? (
              <div className="space-y-2" data-im-bindings-list>
                <p className="text-[11.5px] font-medium tracking-wide text-ink-faint">{t('st.im.bindingsTitle')}</p>
                <div className="divide-y divide-hairline rounded-lg border border-hairline bg-paper">
                  {data.bindings.map((binding) => {
                    const isExpanded = expandedBindings[binding.id] === true;
                    const targetOptions = bindingTargetChoices(people, binding, t);
                    return (
                      <div key={binding.id} data-im-binding={binding.id} className="space-y-2.5 px-3.5 py-2.5 text-[12px]">
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft">
                              {providerDisplayName(binding.provider_kind, t)}
                            </span>
                            <span className="font-medium text-ink">
                              {binding.identity.sender_name ?? binding.identity.chat_title ?? binding.identity.sender_id}
                            </span>
                            <span aria-hidden className="text-ink-faint">→</span>
                            <SettingsSelect
                              id={`im-binding-target-${binding.id}`}
                              variant="row"
                              ariaLabel={t('st.im.session')}
                              value={binding.session_id}
                              choices={targetOptions}
                              emptyText={binding.session_id}
                              onChange={(nextValue) => {
                                if (nextValue.startsWith('persona:')) {
                                  const personaId = nextValue.slice('persona:'.length);
                                  void run(() => client.imSessions.updateBinding(binding.id, {
                                    target: { kind: 'persona', persona_id: personaId },
                                  }));
                                  return;
                                }
                                const sessionId = nextValue.startsWith('session:') ? nextValue.slice('session:'.length) : nextValue;
                                void run(() => client.imSessions.updateBinding(binding.id, {
                                  target: { kind: 'session', session_id: sessionId },
                                }));
                              }}
                              dataAttr="data-im-binding-target"
                            />
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="button" className={SECONDARY_BUTTON} data-im-session-switch={binding.id}
                              onClick={() => { void run(() => client.imSessions.updateBinding(binding.id, { session_enabled: !(binding.session_enabled ?? data.policy.default_enabled) })); }}>
                              {t('st.im.sessionSwitch')}: {imSessionAdmitted({ allowed: data.policy.allowed, defaultEnabled: data.policy.default_enabled, sessionEnabled: binding.session_enabled }) ? t('st.im.on') : t('st.im.off')}
                            </button>
                            <button type="button" className={SECONDARY_BUTTON} data-im-enabled={binding.id}
                              onClick={() => { void run(() => client.imSessions.updateBinding(binding.id, { enabled: !binding.enabled })); }}>
                              {binding.enabled ? t('st.im.disable') : t('st.im.enable')}
                            </button>
                            <button
                              type="button"
                              className={SECONDARY_BUTTON}
                              data-im-binding-options-toggle={binding.id}
                              aria-expanded={isExpanded}
                              onClick={() => { setExpandedBindings((prev) => ({ ...prev, [binding.id]: !isExpanded })); }}
                            >
                              {t('st.im.bindingOptions')}
                            </button>
                          </div>
                        </div>

                        <div className={isExpanded ? 'flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-2.5' : 'hidden'} data-im-binding-details={binding.id}>
                          <div className="flex flex-wrap items-start gap-3">
                            <SettingsSegmented ariaLabel={t('st.im.busy')} value={binding.busy} dataAttr="data-im-binding-busy"
                              onChange={(value) => { void run(() => client.imSessions.updateBinding(binding.id, { busy: value })); }}
                              choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
                            <ReplyMode kind={binding.provider_kind} value={binding.reply} dataAttr="data-im-binding-text"
                              onChange={(value) => { void run(() => client.imSessions.updateBinding(binding.id, { reply: value })); }} />
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] text-ink-soft">{t('st.im.actions')}</span>
                              <SettingsSegmented ariaLabel={t('st.im.actions')} value={binding.mobile_interactions ? 'on' : 'off'} dataAttr="data-im-binding-actions"
                                onChange={(value) => { void run(() => client.imSessions.updateBinding(binding.id, { mobile_interactions: value === 'on' })); }}
                                choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {binding.session_enabled !== undefined ? (
                              <button type="button" className={SECONDARY_BUTTON} data-im-follow-default={binding.id}
                                onClick={() => { void run(() => client.imSessions.updateBinding(binding.id, { session_enabled: null })); }}>{t('st.im.followDefault')}</button>
                            ) : null}
                            <button type="button" className={SECONDARY_BUTTON} data-im-remove={binding.id}
                              onClick={() => { void run(() => client.imSessions.removeBinding(binding.id)); }}>{t('st.im.remove')}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {showBindFlow ? (
              <div data-im-bind-flow className="space-y-3 rounded-lg border border-hairline bg-paper p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-ink">{t('st.im.bindTitle')}</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      data-im-advanced-toggle
                      aria-expanded={advancedOpen}
                      onClick={() => { setAdvancedOpen((prev) => !prev); }}
                      className="text-[12px] text-ink-soft underline-offset-2 hover:text-ink hover:underline"
                    >
                      {t('st.im.advancedOptions')}
                    </button>
                    {hasBindings && !hasDiscoveries ? (
                      <button
                        type="button"
                        className="text-[12px] text-ink-soft hover:text-ink"
                        data-im-close-bind
                        onClick={() => { setBindFlowOpen(false); }}
                      >
                        {t('st.im.closeBindFlow')}
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <SettingsSegmented
                    ariaLabel={t('st.im.target')}
                    value={targetKind}
                    onChange={handleKindChange}
                    dataAttr="data-im-target-kind"
                    choices={[
                      { value: 'persona', label: t('st.im.kindPersona') },
                      { value: 'session', label: t('st.im.kindSession') },
                    ]}
                  />
                  <div className="min-w-[180px] flex-1">
                    <SettingsSelect
                      id="im-target-primary"
                      variant="form"
                      ariaLabel={t('st.im.target')}
                      value={selected}
                      choices={selectChoices}
                      emptyText={t('st.im.target')}
                      onChange={setTarget}
                      dataAttr="data-im-target"
                    />
                  </div>
                  {allChoices.length > 6 || targetSearch !== '' || (targetKind === 'session' && typeof (client as { listSessions?: unknown }).listSessions === 'function') ? (
                    <input
                      type="search"
                      data-im-target-search
                      value={targetSearch}
                      placeholder={t('st.im.searchTarget')}
                      aria-label={t('st.im.searchTarget')}
                      onChange={(event) => { setTargetSearch(event.target.value); }}
                      className={`${INPUT} h-8 w-36 text-[12px] sm:w-44`}
                    />
                  ) : null}
                  {selected.startsWith('persona:') ? (
                    <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                      <input
                        type="checkbox"
                        data-im-also-home
                        checked={alsoHome}
                        onChange={(event) => { setAlsoHome(event.target.checked); }}
                      />
                      {t('st.im.alsoHome')}
                    </label>
                  ) : null}
                  {candidateBindings.length > 1 && visibleDiscoveries.length === 0 ? (
                    <div className="min-w-[160px]">
                      <SettingsSelect
                        id="im-route-binding"
                        variant="form"
                        ariaLabel={t('st.im.bindingsTitle')}
                        value={selectedRouteBinding?.id ?? ''}
                        choices={[
                          { value: '', label: t('st.im.bindingsTitle') },
                          ...candidateBindings.map((item) => ({
                            value: item.id,
                            label: bindingIdentityLabel(item, t),
                          })),
                        ]}
                        emptyText={t('st.im.bindingsTitle')}
                        onChange={setRouteBindingId}
                        dataAttr="data-im-route-binding"
                      />
                    </div>
                  ) : null}
                  {candidateBindings.length > 0 && visibleDiscoveries.length === 0 && selected !== '' ? (
                    <button
                      type="button"
                      className={PRIMARY_BUTTON}
                      disabled={selectedRouteBinding === undefined}
                      data-im-route-existing={selectedRouteBinding?.id ?? ''}
                      onClick={() => {
                        if (selectedRouteBinding === undefined) return;
                        const parsed = confirmBody(selected, busy, reply, actions, alsoHome).target;
                        void run(() => client.imSessions.updateBinding(selectedRouteBinding.id, {
                          target: parsed,
                          ...(selectedRouteBinding.enabled ? {} : { enabled: true }),
                        })).then(() => {
                          setBindFlowOpen(false);
                        });
                      }}
                    >
                      {selectedRouteBinding !== undefined && candidateBindings.length === 1
                        ? `${t('st.im.routeExisting')} · ${bindingIdentityLabel(selectedRouteBinding, t)}`
                        : t('st.im.routeExisting')}
                    </button>
                  ) : null}
                </div>

                {visibleDiscoveries.length > 0 ? (
                  <div className="space-y-2 border-t border-hairline pt-3">
                    {visibleDiscoveries.map((item) => (
                      <div key={item.id} data-im-discovery={item.id} className="space-y-2.5 rounded-md border border-hairline bg-canvas/50 px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                              <span className="font-medium text-ink">{providerDisplayName(item.provider_kind, t)}</span>
                              <span className="text-ink-faint">·</span>
                              <span className="font-medium text-ink">{[item.identity.chat_title, item.identity.sender_name].filter(Boolean).join(' · ') || item.identity.sender_id}</span>
                            </div>
                            {item.preview !== undefined && item.preview !== '' ? (
                              <p className="truncate text-[12px] text-ink-soft">{item.preview}</p>
                            ) : (
                              <p className="text-[12px] text-ink-soft">{t('st.im.discovery')}</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className={PRIMARY_BUTTON}
                              data-im-confirm={item.id}
                              disabled={selected === ''}
                              onClick={() => {
                                void run(() => client.imSessions.confirm(
                                  item.id,
                                  confirmBody(selected, busy, liveText(item.provider_kind) ? reply : 'final', actions, alsoHome),
                                )).then(() => { setBindFlowOpen(false); });
                              }}
                            >
                              {t('st.im.confirm')}
                            </button>
                            <button
                              type="button"
                              className={SECONDARY_BUTTON}
                              data-im-dismiss={item.id}
                              onClick={() => { void run(() => client.imSessions.dismiss(item.id)); }}
                            >
                              {t('st.im.dismiss')}
                            </button>
                          </div>
                        </div>

                        <div className={advancedOpen ? 'flex flex-wrap items-start gap-4 border-t border-hairline pt-2.5' : 'hidden'} data-im-bind-advanced>
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] text-ink-soft">{t('st.im.busy')}</span>
                            <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={setBusy} dataAttr="data-im-busy"
                              choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
                          </div>
                          <ReplyMode kind={item.provider_kind} value={reply} onChange={setReply} dataAttr="data-im-text" />
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] text-ink-soft">{t('st.im.actions')}</span>
                            <SettingsSegmented ariaLabel={t('st.im.actions')} value={actions ? 'on' : 'off'} onChange={(value) => { setActions(value === 'on'); }} dataAttr="data-im-actions"
                              choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : activeInstance !== undefined ? (
                  <div className="space-y-2.5 border-t border-hairline pt-3">
                    <div data-im-awaiting-discovery className="flex flex-wrap items-center justify-between gap-3 text-[12px]">
                      {activeInstance.listening ? (
                        <>
                          <p className="flex min-w-0 flex-1 items-center gap-2 text-ink-soft" data-im-waiting-discovery>
                            <span aria-hidden className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-ink" />
                            <span className="font-medium text-ink">
                              {activeInstance.connection === 'starting'
                                ? t('st.im.stateStarting')
                                : activeInstance.connection === 'reconnecting'
                                  ? t('st.im.stateReconnecting')
                                  : t('st.im.waitingTitle')}
                            </span>
                            <span className="truncate">{t('st.im.waitingBody')}</span>
                          </p>
                          <button
                            type="button"
                            className={SECONDARY_BUTTON}
                            data-im-refresh-discovery
                            onClick={() => { void snapshot.refetch(); }}
                          >
                            {t('st.im.refreshDiscovery')}
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="min-w-0 flex-1 text-ink-soft">{t('st.im.awaitingListenBody')}</p>
                          <button
                            type="button"
                            className={PRIMARY_BUTTON}
                            data-im-bind-listen
                            onClick={() => { startInstanceListening(activeInstance.id); }}
                          >
                            {t('st.im.startListenNow')}
                          </button>
                        </>
                      )}
                    </div>
                    <div className={advancedOpen ? 'flex flex-wrap items-start gap-4 pt-1' : 'hidden'} data-im-bind-advanced>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-ink-soft">{t('st.im.busy')}</span>
                        <SettingsSegmented ariaLabel={t('st.im.busy')} value={busy} onChange={setBusy} dataAttr="data-im-busy"
                          choices={[{ value: 'queue', label: t('st.im.queue') }, { value: 'steer', label: t('st.im.steer') }]} />
                      </div>
                      <ReplyMode kind={activeInstance.provider_kind} value={reply} onChange={setReply} dataAttr="data-im-text" />
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-ink-soft">{t('st.im.actions')}</span>
                        <SettingsSegmented ariaLabel={t('st.im.actions')} value={actions ? 'on' : 'off'} onChange={(value) => { setActions(value === 'on'); }} dataAttr="data-im-actions"
                          choices={[{ value: 'on', label: t('st.im.on') }, { value: 'off', label: t('st.im.off') }]} />
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!hasBindings && !hasDiscoveries ? (
              <p className={showBindFlow ? 'hidden' : 'text-[12px] text-ink-faint'} data-im-empty>{t('st.im.empty')}</p>
            ) : null}
            {data.strangers.length > 0 ? <p data-im-strangers className="text-[12px] text-ink-soft">{t('st.im.strangers')}: {data.strangers.reduce((sum, item) => sum + item.count, 0)}</p> : null}
            {data.voice_fallbacks > 0 ? <p data-im-voice className="text-[12px] text-ink-soft">{t('st.im.voice')}: {data.voice_fallbacks}</p> : null}
            {error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: error }} /> : null}
          </>
        )}
      </div>
    </SectionCard>
  );
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
      {status !== undefined && status !== 'confirmed' ? <p className="text-[12px] text-ink-soft" data-im-wechat-status>{t(wechatStatusKey(status))}</p> : null}
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

function providerDisplayName(kind: ImProviderKind, t: ReturnType<typeof useI18n>['t']): string {
  if (kind === 'wechat_bridge') return t('st.im.provider.wechat_bridge');
  if (kind === 'telegram') return t('st.im.provider.telegram');
  if (kind === 'feishu_app') return t('st.im.provider.feishu_app');
  if (kind === 'onebot_v11') return t('st.im.provider.onebot_v11');
  return kind;
}

function instanceStateInfo(
  item: ImInstanceStatus,
  t: ReturnType<typeof useI18n>['t'],
): { state: 'listening' | 'starting' | 'reconnecting' | 'stopped'; label: string; transient: boolean } {
  if (!item.listening) {
    return { state: 'stopped', label: t('st.im.stateStopped'), transient: false };
  }
  if (item.connection === 'starting') {
    return { state: 'starting', label: t('st.im.stateStarting'), transient: true };
  }
  if (item.connection === 'reconnecting') {
    return { state: 'reconnecting', label: t('st.im.stateReconnecting'), transient: true };
  }
  return { state: 'listening', label: t('st.im.stateListening'), transient: false };
}

function instanceDisplayName(item: ImInstanceStatus, t: ReturnType<typeof useI18n>['t']): string {
  const platform = providerDisplayName(item.provider_kind, t);
  if (item.label !== undefined && item.label.trim() !== '' && item.label !== item.provider_kind) {
    return `${item.label} (${platform})`;
  }
  return platform;
}

function bindingIdentityLabel(binding: ImBinding, t: ReturnType<typeof useI18n>['t']): string {
  const platform = providerDisplayName(binding.provider_kind, t);
  const who = [binding.identity.chat_title, binding.identity.sender_name].filter(Boolean).join(' · ')
    || binding.identity.sender_id
    || binding.identity.chat_id;
  return `${platform} · ${who}`;
}

function bindingTargetChoices(
  catalog: ImCatalog | undefined,
  binding: ImBinding,
  t: ReturnType<typeof useI18n>['t'],
): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [];

  for (const persona of catalog?.personas ?? []) {
    const isCurrentPersona = binding.persona_id === persona.id
      || (persona.home_session_id !== undefined && persona.home_session_id === binding.session_id);
    const value = isCurrentPersona ? binding.session_id : `persona:${persona.id}`;
    if (!choices.some((item) => item.value === value)) {
      choices.push({ value, label: `${t('st.im.kindPersona')} · ${persona.name}` });
    }
  }

  for (const session of catalog?.sessions ?? []) {
    if (!choices.some((item) => item.value === session.id)) {
      choices.push({ value: session.id, label: `${t('st.im.kindSession')} · ${session.title}` });
    }
  }

  if (!choices.some((choice) => choice.value === binding.session_id)) {
    choices.unshift({ value: binding.session_id, label: binding.session_id });
  }
  return choices;
}

interface TargetChoiceItem {
  value: string;
  label: string;
  rawLabel: string;
  kind: 'persona' | 'session';
}

function targetChoices(catalog: ImCatalog | undefined, t: ReturnType<typeof useI18n>['t']): TargetChoiceItem[] {
  if (catalog === undefined) return [];
  return [
    ...catalog.personas.map((persona) => ({
      value: `persona:${persona.id}`,
      label: `${t('st.im.kindPersona')} · ${persona.name}`,
      rawLabel: persona.name,
      kind: 'persona' as const,
    })),
    ...catalog.sessions.map((session) => ({
      value: `session:${session.id}`,
      label: `${t('st.im.kindSession')} · ${session.title}`,
      rawLabel: session.title,
      kind: 'session' as const,
    })),
  ];
}

function liveText(kind: ImProviderKind): boolean {
  return kind === 'telegram' || kind === 'feishu_app';
}

function ReplyMode({ kind, value, onChange, dataAttr }: {
  kind: ImProviderKind;
  value: 'final' | 'edit';
  onChange: (value: 'final' | 'edit') => void;
  dataAttr: string;
}) {
  const { t } = useI18n();
  if (!liveText(kind)) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="text-[12px] text-ink" data-im-text-fixed={kind}>{t('st.im.final')}</span>
        <p className="text-[12px] leading-5 text-ink-soft" data-im-text-note>{t(kind === 'onebot_v11' ? 'st.im.qqText' : 'st.im.wechatText')}</p>
        {kind === 'onebot_v11' ? <p className="text-[12px] leading-5 text-ink-soft" data-im-file-note>{t('st.im.fileNote')}</p> : null}
      </div>
    );
  }
  return (
    <SettingsSegmented ariaLabel={t('st.im.text')} value={value} onChange={onChange} dataAttr={dataAttr}
      choices={[{ value: 'final', label: t('st.im.final') }, { value: 'edit', label: t('st.im.edit') }]} />
  );
}

function confirmBody(selected: string, busy: 'queue' | 'steer', reply: 'final' | 'edit', actions: boolean, alsoHome: boolean): ImConfirmRequest {
  const [kind, id] = selected.split(':') as ['persona' | 'session', string];
  const target = kind === 'session' ? { kind: 'session' as const, session_id: id } : { kind: 'persona' as const, persona_id: id };
  return { target, busy, reply, mobile_interactions: actions, ...(alsoHome ? { also_home: true } : {}) };
}

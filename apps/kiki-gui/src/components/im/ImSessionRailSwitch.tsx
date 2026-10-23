import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { imSessionAdmitted, type ImProviderKind, type ImSessionSnapshot } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';

export function ImSessionRailSwitch({ sessionId }: { sessionId: string }) {
  const connection = useOptionalConnection();
  if (connection === null) return null;
  return <ImSessionRailBody key={sessionId} sessionId={sessionId} />;
}

function ImSessionRailBody({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const snapshot = useQuery({
    queryKey: ['im-sessions'],
    queryFn: () => connection!.client.imSessions.snapshot(),
    enabled: connection !== null,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  if (connection === null || snapshot.data === undefined) return null;

  const bindings = snapshot.data.bindings.filter((binding) => binding.session_id === sessionId);
  const policy = snapshot.data.policy;
  const discoveries = snapshot.data.discoveries;
  const instances = snapshot.data.instances;

  const runAction = (id: string, work: () => Promise<ImSessionSnapshot>) => {
    setBusyId(id);
    setError(undefined);
    void (async () => {
      try {
        const latest = await work();
        queryClient.setQueryData(['im-sessions'], latest);
      } catch (caught) {
        setError(caught instanceof Error && caught.message.length > 0 ? caught.message : t('st.im.error'));
        void queryClient.invalidateQueries({ queryKey: ['im-sessions'] });
      } finally {
        setBusyId(undefined);
      }
    })();
  };

  if (bindings.length === 0) {
    if (!policy.allowed || discoveries.length === 0) return null;

    if (discoveries.length === 1) {
      const item = discoveries[0]!;
      const identityText = chatIdentityLabel(item.provider_kind, item.identity, t);
      const busy = busyId === item.id;
      return (
        <div data-im-rail={sessionId} data-im-rail-on="no" className="min-w-0 text-[12px] text-ink-soft">
          <button
            type="button"
            disabled={busyId !== undefined}
            data-im-rail-busy={busy ? 'yes' : 'no'}
            data-im-rail-action="bind"
            data-im-rail-confirm={item.id}
            className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
            onClick={() => {
              runAction(item.id, () => connection.client.imSessions.confirm(item.id, {
                target: { kind: 'session', session_id: sessionId },
              }));
            }}
          >
            {t('st.im.sessionSwitch')}: {busy ? t('st.im.railBusy') : <>{t('st.im.railBind')} (<span data-im-rail-identity={item.id} className="text-ink">{identityText}</span>)</>}
          </button>
          {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
        </div>
      );
    }

    return (
      <div data-im-rail={sessionId} data-im-rail-on="no" data-im-rail-multi="discoveries" className="min-w-0 space-y-1.5 text-[12px] text-ink-soft">
        <p className="font-medium text-ink">{t('st.im.sessionSwitch')}</p>
        {discoveries.map((item) => {
          const identityText = chatIdentityLabel(item.provider_kind, item.identity, t);
          const busy = busyId === item.id;
          return (
            <div key={item.id} data-im-rail-discovery={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span data-im-rail-identity={item.id} className="min-w-0 truncate text-ink">{identityText}</span>
              <button
                type="button"
                disabled={busyId !== undefined}
                data-im-rail-busy={busy ? 'yes' : 'no'}
                data-im-rail-confirm={item.id}
                className="shrink-0 underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
                onClick={() => {
                  runAction(item.id, () => connection.client.imSessions.confirm(item.id, {
                    target: { kind: 'session', session_id: sessionId },
                  }));
                }}
              >
                {busy ? t('st.im.railBusy') : t('st.im.railBind')}
              </button>
            </div>
          );
        })}
        {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
      </div>
    );
  }

  return (
    <div data-im-rail={sessionId} data-im-rail-on={bindings.every((binding) => bindingAdmitted(binding, policy)) ? 'yes' : 'no'} data-im-rail-multi={bindings.length > 1 ? 'bindings' : undefined} className="min-w-0 space-y-1 text-[12px] text-ink-soft">
      <p className="font-medium text-ink">{t('st.im.sessionSwitch')}</p>
      {bindings.map((binding) => {
        const on = bindingAdmitted(binding, policy);
        const blocked = !policy.allowed ? 'allowed' : !binding.enabled ? 'disabled' : undefined;
        const connectionState = instances.find((instance) => instance.id === binding.provider_instance_id)?.connection;
        const busy = busyId === binding.id;
        const identityText = chatIdentityLabel(binding.provider_kind, binding.identity, t);
        return (
          <div key={binding.id} data-im-rail-binding={binding.id} data-im-rail-binding-on={on ? 'yes' : 'no'} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span data-im-rail-identity={binding.id} className="min-w-0 flex-1 truncate text-ink" title={identityText}>{identityText}</span>
            {blocked === undefined ? (
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={identityText}
                disabled={busyId !== undefined}
                data-im-rail-busy={busy ? 'yes' : 'no'}
                data-im-rail-binding-toggle={binding.id}
                className="shrink-0 rounded underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:no-underline"
                onClick={() => {
                  runAction(binding.id, () => connection.client.imSessions.updateBinding(binding.id, { session_enabled: !on }));
                }}
              >
                {busy ? t('st.im.railBusy') : on ? t('st.im.on') : t('st.im.off')}
              </button>
            ) : (
              <>
                <span data-im-rail-blocked={blocked} className="shrink-0 text-ink-faint">{t('st.im.off')}</span>
                <span data-im-rail-reason className="basis-full text-[11.5px] text-ink-faint">
                  {t(blocked === 'allowed' ? 'st.im.railOffAllowed' : 'st.im.railOffBinding')}
                </span>
              </>
            )}
            {connectionState === 'starting' || connectionState === 'reconnecting' ? (
              <span data-im-rail-connection={connectionState} className="basis-full truncate text-[11.5px] text-ink-faint">
                {t(connectionState === 'starting' ? 'st.im.stateStarting' : 'st.im.stateReconnecting')}
              </span>
            ) : null}
          </div>
        );
      })}
      {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
    </div>
  );
}

function bindingAdmitted(
  binding: ImSessionSnapshot['bindings'][number],
  policy: ImSessionSnapshot['policy'],
): boolean {
  return binding.enabled && imSessionAdmitted({
    allowed: policy.allowed,
    defaultEnabled: policy.default_enabled,
    sessionEnabled: binding.session_enabled,
  });
}

function providerName(kind: ImProviderKind, t: ReturnType<typeof useI18n>['t']): string {
  if (kind === 'wechat_bridge') return t('st.im.provider.wechat_bridge');
  if (kind === 'telegram') return t('st.im.provider.telegram');
  if (kind === 'feishu_app') return t('st.im.provider.feishu_app');
  if (kind === 'onebot_v11') return t('st.im.provider.onebot_v11');
  return kind;
}

function chatIdentityLabel(
  kind: ImProviderKind,
  identity: { chat_id: string; sender_id: string; topic_id?: string; chat_title?: string; sender_name?: string },
  t: ReturnType<typeof useI18n>['t'],
): string {
  const platform = providerName(kind, t);
  const named = [identity.chat_title, identity.sender_name].filter(Boolean).join(' · ');
  const sender = named === '' && identity.sender_id !== identity.chat_id ? identity.sender_id : undefined;
  const channel = identity.topic_id !== undefined && identity.topic_id !== '' && identity.topic_id !== '0'
    ? `${identity.chat_id}/${identity.topic_id}`
    : identity.chat_id;
  return [platform, named || sender, channel].filter(Boolean).join(' · ');
}

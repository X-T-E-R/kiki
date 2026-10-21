import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { imSessionAdmitted, type ImProviderKind, type ImSessionSnapshot } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';

export function ImSessionRailSwitch({ sessionId }: { sessionId: string }) {
  const connection = useOptionalConnection();
  if (connection === null) return null;
  return <ImSessionRailBody sessionId={sessionId} />;
}

function ImSessionRailBody({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const snapshot = useQuery({
    queryKey: ['im-sessions'],
    queryFn: () => connection!.client.imSessions.snapshot(),
    enabled: connection !== null,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => query.state.data?.instances.some((item) => item.listening) === true ? 2_000 : false,
  });
  const bindings = (snapshot.data?.bindings ?? []).filter((binding) => binding.session_id === sessionId);
  if (connection === null || snapshot.data === undefined) return null;
  const policy = snapshot.data.policy;
  const discoveries = snapshot.data.discoveries;
  const otherBindings = bindings.length === 0 ? snapshot.data.bindings : [];
  const instances = snapshot.data.instances;
  const listeningInstances = instances.filter((item) => item.listening);

  const runAction = (work: () => Promise<ImSessionSnapshot>) => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        const latest = await work();
        queryClient.setQueryData(['im-sessions'], latest);
      } catch (caught) {
        setError(caught instanceof Error && caught.message.length > 0 ? caught.message : t('st.im.error'));
        void queryClient.invalidateQueries({ queryKey: ['im-sessions'] });
      } finally {
        setBusy(false);
      }
    })();
  };

  if (bindings.length === 0) {
    if (!policy.allowed || (discoveries.length === 0 && otherBindings.length === 0 && instances.length === 0)) {
      return null;
    }

    if (discoveries.length > 0) {
      if (discoveries.length === 1) {
        const item = discoveries[0]!;
        const identityText = chatIdentityLabel(item.provider_kind, item.identity, t);
        return (
          <div data-im-rail={sessionId} data-im-rail-on="no" className="min-w-0 text-[12px] text-ink-soft">
            <button
              type="button"
              disabled={busy}
              data-im-rail-busy={busy ? 'yes' : 'no'}
              data-im-rail-action="bind"
              data-im-rail-confirm={item.id}
              className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
              onClick={() => {
                runAction(() => connection.client.imSessions.confirm(item.id, {
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
            return (
              <div key={item.id} data-im-rail-discovery={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span data-im-rail-identity={item.id} className="min-w-0 truncate text-ink">{identityText}</span>
                <button
                  type="button"
                  disabled={busy}
                  data-im-rail-busy={busy ? 'yes' : 'no'}
                  data-im-rail-confirm={item.id}
                  className="shrink-0 underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
                  onClick={() => {
                    runAction(() => connection.client.imSessions.confirm(item.id, {
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

    if (otherBindings.length > 0) {
      if (otherBindings.length === 1) {
        const item = otherBindings[0]!;
        const identityText = chatIdentityLabel(item.provider_kind, item.identity, t);
        return (
          <div data-im-rail={sessionId} data-im-rail-on="no" className="min-w-0 text-[12px] text-ink-soft">
            <button
              type="button"
              disabled={busy}
              data-im-rail-busy={busy ? 'yes' : 'no'}
              data-im-rail-action="route"
              data-im-rail-route={item.id}
              className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
              onClick={() => {
                runAction(() => connection.client.imSessions.updateBinding(item.id, {
                  target: { kind: 'session', session_id: sessionId },
                }));
              }}
            >
              {t('st.im.sessionSwitch')}: {busy ? t('st.im.railBusy') : <>{t('st.im.railRoute')} (<span data-im-rail-identity={item.id} className="text-ink">{identityText}</span>)</>}
            </button>
            {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
          </div>
        );
      }
      return (
        <div data-im-rail={sessionId} data-im-rail-on="no" data-im-rail-multi="bindings" className="min-w-0 space-y-1.5 text-[12px] text-ink-soft">
          <p className="font-medium text-ink">{t('st.im.sessionSwitch')}</p>
          {otherBindings.map((item) => {
            const identityText = chatIdentityLabel(item.provider_kind, item.identity, t);
            return (
              <div key={item.id} data-im-rail-binding={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span data-im-rail-identity={item.id} className="min-w-0 truncate text-ink">{identityText}</span>
                <button
                  type="button"
                  disabled={busy}
                  data-im-rail-busy={busy ? 'yes' : 'no'}
                  data-im-rail-route={item.id}
                  className="shrink-0 underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
                  onClick={() => {
                    runAction(() => connection.client.imSessions.updateBinding(item.id, {
                      target: { kind: 'session', session_id: sessionId },
                    }));
                  }}
                >
                  {busy ? t('st.im.railBusy') : t('st.im.railRoute')}
                </button>
              </div>
            );
          })}
          {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
        </div>
      );
    }

    if (listeningInstances.length > 0) {
      const transient = listeningInstances.find((item) => item.connection !== undefined)?.connection;
      const statusText = transient === 'starting'
        ? t('st.im.stateStarting')
        : transient === 'reconnecting'
          ? t('st.im.stateReconnecting')
          : t('st.im.waitingTitle');
      return (
        <div data-im-rail={sessionId} data-im-rail-on="no" className="min-w-0 text-[12px] text-ink-soft">
          <p data-im-rail-waiting data-im-rail-connection={transient}>
            {t('st.im.sessionSwitch')}: {statusText} ({listeningInstances.map((item) => instanceIdentityLabel(item, t)).join(', ')})
          </p>
          {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
        </div>
      );
    }

    const startListening = (instanceId: string) => {
      runAction(async () => {
        const checked = await connection.client.imSessions.check(instanceId);
        if (!checked.ok) {
          setError(checked.detail ?? t('st.im.error'));
          return connection.client.imSessions.snapshot();
        }
        return connection.client.imSessions.listen(instanceId, true);
      });
    };

    if (instances.length === 1) {
      const inst = instances[0]!;
      const instLabel = instanceIdentityLabel(inst, t);
      return (
        <div data-im-rail={sessionId} data-im-rail-on="no" className="min-w-0 text-[12px] text-ink-soft">
          <button
            type="button"
            disabled={busy}
            data-im-rail-busy={busy ? 'yes' : 'no'}
            data-im-rail-action="listen"
            data-im-rail-listen={inst.id}
            className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
            onClick={() => { startListening(inst.id); }}
          >
            {t('st.im.sessionSwitch')}: {busy ? t('st.im.railBusy') : <>{t('st.im.railBind')} (<span data-im-rail-identity={inst.id} className="text-ink">{instLabel}</span>)</>}
          </button>
          {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
        </div>
      );
    }

    return (
      <div data-im-rail={sessionId} data-im-rail-on="no" data-im-rail-multi="instances" className="min-w-0 space-y-1.5 text-[12px] text-ink-soft">
        <p className="font-medium text-ink">{t('st.im.sessionSwitch')}</p>
        {instances.map((inst) => {
          const instLabel = instanceIdentityLabel(inst, t);
          return (
            <div key={inst.id} data-im-rail-instance={inst.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span data-im-rail-identity={inst.id} className="min-w-0 truncate text-ink">{instLabel}</span>
              <button
                type="button"
                disabled={busy}
                data-im-rail-busy={busy ? 'yes' : 'no'}
                data-im-rail-listen={inst.id}
                className="shrink-0 underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
                onClick={() => { startListening(inst.id); }}
              >
                {busy ? t('st.im.railBusy') : t('st.im.listen')}
              </button>
            </div>
          );
        })}
        {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
      </div>
    );
  }
  const on = bindings.every((binding) => binding.enabled && imSessionAdmitted({ allowed: policy.allowed, defaultEnabled: policy.default_enabled, sessionEnabled: binding.session_enabled }));
  const blocked = !policy.allowed ? 'allowed' : bindings.some((binding) => !binding.enabled) ? 'disabled' : undefined;
  const boundConnection = bindings
    .map((binding) => instances.find((inst) => inst.id === binding.provider_instance_id)?.connection)
    .find((conn): conn is 'starting' | 'reconnecting' => conn !== undefined);
  const turn = () => {
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        let latest: ImSessionSnapshot | undefined;
        for (const binding of bindings) {
          latest = await connection.client.imSessions.updateBinding(binding.id, { session_enabled: !on });
        }
        if (latest !== undefined) queryClient.setQueryData(['im-sessions'], latest);
      } catch (caught) {
        setError(caught instanceof Error && caught.message.length > 0 ? caught.message : t('st.im.error'));
        void queryClient.invalidateQueries({ queryKey: ['im-sessions'] });
      } finally {
        setBusy(false);
      }
    })();
  };
  return (
    <div data-im-rail={sessionId} data-im-rail-on={on ? 'yes' : 'no'} className="min-w-0 text-[12px] text-ink-soft">
      {blocked === undefined ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={busy} data-im-rail-busy={busy ? 'yes' : 'no'}
            className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
            onClick={turn}>
            {t('st.im.sessionSwitch')}: {busy ? t('st.im.railBusy') : on ? t('st.im.on') : t('st.im.off')}
          </button>
          {boundConnection !== undefined ? (
            <span data-im-rail-connection={boundConnection} className="text-ink-faint">
              ({t(boundConnection === 'starting' ? 'st.im.stateStarting' : 'st.im.stateReconnecting')})
            </span>
          ) : null}
        </div>
      ) : (
        <p data-im-rail-blocked={blocked}>
          {t('st.im.sessionSwitch')}: {t('st.im.off')}
          <span data-im-rail-reason className="mt-1 block">{t(blocked === 'allowed' ? 'st.im.railOffAllowed' : 'st.im.railOffBinding')}</span>
        </p>
      )}
      {error !== undefined ? <p data-im-rail-error className="mt-1 text-ink">{error}</p> : null}
    </div>
  );
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
  identity: { chat_id: string; sender_id: string; chat_title?: string; sender_name?: string },
  t: ReturnType<typeof useI18n>['t'],
): string {
  const platform = providerName(kind, t);
  const who = [identity.chat_title, identity.sender_name].filter(Boolean).join(' · ') || identity.sender_id || identity.chat_id;
  return `${platform} · ${who}`;
}

function instanceIdentityLabel(
  instance: ImSessionSnapshot['instances'][number],
  t: ReturnType<typeof useI18n>['t'],
): string {
  const platform = providerName(instance.provider_kind, t);
  const account = instance.label?.trim() || instance.account_id;
  return account !== undefined && account !== '' && account !== instance.provider_kind
    ? `${platform} (${account})`
    : platform;
}

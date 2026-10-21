import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { imSessionAdmitted, type ImSessionSnapshot } from '@kiki/protocol';

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
  if (connection === null || bindings.length === 0 || snapshot.data === undefined) return null;
  const policy = snapshot.data.policy;
  const on = bindings.every((binding) => binding.enabled && imSessionAdmitted({ allowed: policy.allowed, defaultEnabled: policy.default_enabled, sessionEnabled: binding.session_enabled }));
  const blocked = !policy.allowed ? 'allowed' : bindings.some((binding) => !binding.enabled) ? 'disabled' : undefined;
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
        <button type="button" disabled={busy} data-im-rail-busy={busy ? 'yes' : 'no'}
          className="underline-offset-2 hover:text-ink hover:underline disabled:no-underline"
          onClick={turn}>
          {t('st.im.sessionSwitch')}: {busy ? t('st.im.railBusy') : on ? t('st.im.on') : t('st.im.off')}
        </button>
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

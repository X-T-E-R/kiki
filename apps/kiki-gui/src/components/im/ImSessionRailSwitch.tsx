import { useQuery, useQueryClient } from '@tanstack/react-query';

import { imSessionAdmitted } from '@kiki/protocol';

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
  return (
    <button
      type="button"
      data-im-rail={sessionId}
      data-im-rail-on={on ? 'yes' : 'no'}
      className="text-[12px] text-ink-soft underline-offset-2 hover:text-ink hover:underline"
      onClick={() => {
        void Promise.all(bindings.map((binding) => connection.client.imSessions.updateBinding(binding.id, { session_enabled: !on })))
          .then((next) => { const last = next.at(-1); if (last !== undefined) queryClient.setQueryData(['im-sessions'], last); });
      }}
    >
      {t('st.im.sessionSwitch')}: {on ? t('st.im.on') : t('st.im.off')}
    </button>
  );
}

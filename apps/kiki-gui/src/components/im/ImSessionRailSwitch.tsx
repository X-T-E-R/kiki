import { useQuery, useQueryClient } from '@tanstack/react-query';

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
  });
  const bindings = (snapshot.data?.bindings ?? []).filter((binding) => binding.session_id === sessionId);
  if (connection === null || bindings.length === 0) return null;
  const on = bindings.every((binding) => binding.session_enabled !== false && binding.enabled);
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

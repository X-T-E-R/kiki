import type { ExecutorAuthObservation } from '@kiki/protocol';
import { useI18n } from '../../i18n';

export function ExecutorAuthStatus({ observation }: { observation?: ExecutorAuthObservation }) {
  const { t } = useI18n();
  if (observation === undefined) return null;
  return <p data-executor-auth={observation.status}
    className={`text-[12px] ${observation.status === 'required' ? 'text-amber-ink' : 'text-ink-soft'}`}
    title={`${observation.source} · ${observation.cwd} · ${new Date(observation.observed_at).toLocaleString()}`}>
    {t(observation.scope === 'vendor_account' ? 'st.engines.runtimeAuth.account' : 'st.engines.runtimeAuth.session')} · {t(observation.status === 'required' ? 'st.engines.login.required' : `st.engines.login.${observation.status}`)}
  </p>;
}

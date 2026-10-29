import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { ChannelState } from './model';
import { StatusText, type StatusTone } from './rowParts';

const STATE_KEY: Record<ChannelState, I18nKey> = {
  dependency: 'st.notify.state.dependency',
  unauthorized: 'st.notify.state.unauthorized',
  connection: 'st.notify.state.connection',
  noCredential: 'st.notify.state.noCredential',
  ok: 'st.notify.state.ok',
  idle: 'st.channels.state.ready',
};

const STATE_TONE: Record<ChannelState, StatusTone> = {
  dependency: 'warn',
  unauthorized: 'error',
  connection: 'error',
  noCredential: 'warn',
  ok: 'ok',
  idle: 'idle',
};

/**
 * The one state an alert row leads with. A problem always shows; otherwise
 * the person's own off switch, then the paused master switch, then health.
 */
export function ChannelStatus({ state, enabled, paused }: { state: ChannelState; enabled: boolean; paused: boolean }) {
  const { t } = useI18n();
  const problem = state !== 'ok' && state !== 'idle';
  if (!problem && !enabled) return <StatusText tone="idle" data={{ 'data-notify-state': state }}>{t('st.notify.filter.disabled')}</StatusText>;
  if (!problem && paused) return <StatusText tone="idle" data={{ 'data-notify-state': state }}>{t('st.notify.pausedShort')}</StatusText>;
  return <StatusText tone={STATE_TONE[state]} data={{ 'data-notify-state': state }}>{t(STATE_KEY[state])}</StatusText>;
}

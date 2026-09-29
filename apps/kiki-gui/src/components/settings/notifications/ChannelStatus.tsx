import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { ChannelState } from './model';

const STATE_KEY: Record<ChannelState, I18nKey | null> = {
  dependency: 'st.notify.state.dependency',
  unauthorized: 'st.notify.state.unauthorized',
  connection: 'st.notify.state.connection',
  noCredential: 'st.notify.state.noCredential',
  ok: 'st.notify.state.ok',
  idle: null,
};

/** Dot color per state; the words carry the meaning, the dot only groups them. */
const STATE_DOT: Record<ChannelState, string> = {
  dependency: 'bg-amber-rule',
  unauthorized: 'bg-danger',
  connection: 'bg-danger',
  noCredential: 'bg-amber-rule',
  ok: 'bg-success',
  idle: 'bg-hairline-strong',
};

const STATE_TEXT: Record<ChannelState, string> = {
  dependency: 'text-amber-ink',
  unauthorized: 'text-danger',
  connection: 'text-danger',
  noCredential: 'text-amber-ink',
  ok: 'text-ink-soft',
  idle: 'text-ink-faint',
};

/** The one state a row leads with; `idle` (configured, never checked) says nothing. */
export function ChannelStatus({ state }: { state: ChannelState }) {
  const { t } = useI18n();
  const key = STATE_KEY[state];
  if (key === null) return null;
  return (
    <span data-notify-state={state} className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${STATE_TEXT[state]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} />
      {t(key)}
    </span>
  );
}

/** Quiet capability tags: facts about the channel type, not about this channel's health. */
export function CapabilityTags({ sendOnly, unverified }: { sendOnly: boolean; unverified: boolean }) {
  const { t } = useI18n();
  const tag = 'rounded-[4px] border border-hairline px-1.5 py-px text-[11px] leading-4 text-ink-faint';
  return (
    <>
      {sendOnly ? <span className={tag} data-notify-tag="send-only">{t('st.notify.sendOnly')}</span> : null}
      {unverified ? <span className={tag} data-notify-tag="unverified" title={t('st.notify.unverifiedHint')}>{t('st.notify.unverified')}</span> : null}
    </>
  );
}

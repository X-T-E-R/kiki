/**
 * App-global connection banner: a quiet amber strip over the sheet while the
 * server socket is not open — "reconnecting…" while it retries, and once
 * closed, a manual reconnect button plus the fact that sending still works.
 * `role="status"` makes the socket losing / regaining the connection a
 * polite announcement (this is a discrete, non-user-triggered event); it is
 * not `alert` because the banner can persist and self-heal. The composer's
 * own footer notice shows the same fact and deliberately stays silent so the
 * two surfaces never double-announce.
 */

import type { TerminalConnectionStatus } from '@kiki/klient';

import { useI18n } from '../i18n';

export function AppConnectionBanner({
  wsStatus,
  onReconnect,
}: {
  readonly wsStatus: TerminalConnectionStatus;
  readonly onReconnect: () => void;
}) {
  const { t } = useI18n();
  if (wsStatus === 'open') return null;
  return (
    <div
      data-app-banner
      role="status"
      className="shrink-0 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-center text-[12px] font-medium text-amber-ink"
    >
      <span>{wsStatus === 'connecting' ? t('app.reconnecting') : t('app.disconnected')}</span>
      {wsStatus === 'closed' ? (
        <>
          {' · '}
          <button
            type="button"
            onClick={() => { onReconnect(); }}
            className="rounded-sm border border-amber-ink/40 px-1.5 py-px font-semibold transition-colors hover:bg-amber-ink/10"
          >
            {t('app.reconnectNow')}
          </button>
          {' · '}
          <span className="font-normal">{t('app.disconnectedSendHint')}</span>
        </>
      ) : null}
    </div>
  );
}

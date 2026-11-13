import { useState, useSyncExternalStore } from 'react';
import type { TerminalConnectionStatus } from '@kiki/klient';

import { useI18n } from '../i18n';
import { useSpaceLocation } from '../lib/spaceLocation';
import { useOptionalConnection } from '../state/connection';
import { connectionLog, subscribeConnectionLog, type ConnectionLogEntry } from '../state/connectionDiagnostics';
import type { DesktopRecovery } from '../state/desktopConnection';
import { Dialog } from './Dialog';
import { SECONDARY_BUTTON } from './ui';

const REPEATED_RETRY_THRESHOLD = 3;

function latestRetryAttempt(log: readonly ConnectionLogEntry[]): number {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i];
    if (entry === undefined) continue;
    if (entry.kind === 'open') return 0;
    if (entry.kind === 'retry') return entry.attempt;
  }
  return 0;
}

/** One stable strip across discovery, backoff and socket reconnection. */
export function AppConnectionBanner({
  wsStatus, suppressInitialConnecting, onReconnect, recovery, onOpenConnectionSettings, onBackToLocal,
}: {
  readonly wsStatus: TerminalConnectionStatus;
  readonly suppressInitialConnecting?: boolean;
  readonly onReconnect: () => void;
  readonly recovery?: DesktopRecovery;
  readonly onOpenConnectionSettings?: () => void;
  readonly onBackToLocal?: () => void;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const bannerVisible = !((wsStatus === 'open' || (wsStatus === 'connecting' && suppressInitialConnecting === true)) && recovery === undefined);
  const location = useSpaceLocation({ enabled: bannerVisible });
  const conn = useOptionalConnection();
  const log = useSyncExternalStore(subscribeConnectionLog, connectionLog, connectionLog);

  if (!bannerVisible) return null;
  const blocked = recovery?.status === 'blocked';
  const retrying = recovery?.status === 'retrying' || (!blocked && wsStatus === 'connecting');
  const canReconnect = !blocked && recovery === undefined;
  const failure = recovery?.failure;

  const retryAttempt = latestRetryAttempt(log);
  const repeatedRemoteFailure = location.inRemoteScope && !blocked && (retryAttempt >= REPEATED_RETRY_THRESHOLD || !retrying);
  const backAction = onBackToLocal ?? conn?.activateLocal;

  let label: string;
  if (blocked) {
    label = t(
      failure?.kind === 'authentication'
        ? 'app.connectionAuthBlocked'
        : failure?.kind === 'protocol'
          ? 'app.connectionProtocolBlocked'
          : 'app.connectionIdentityBlocked',
    );
  } else if (location.inRemoteScope) {
    if (retrying && retryAttempt >= REPEATED_RETRY_THRESHOLD) {
      label = t('app.stillUnreachableRemote', { space: location.spaceName });
    } else if (retrying) {
      label = t('app.reconnectingRemote', { space: location.spaceName });
    } else {
      label = t('app.disconnectedRemote', { space: location.spaceName });
    }
  } else {
    label = retrying ? t('app.reconnecting') : t('app.disconnected');
  }

  const reconnectLabel = repeatedRemoteFailure ? t('app.retryNow') : t('app.reconnectNow');
  const buttonClass = 'shrink-0 rounded-sm border border-amber-ink/40 px-1.5 py-px font-semibold transition-colors hover:bg-amber-ink/10 disabled:opacity-50';
  return <>
    <div data-app-banner data-recovery-state={blocked ? 'blocked' : retrying ? 'retrying' : 'closed'} role="status"
      className="flex h-16 shrink-0 flex-wrap content-center items-center justify-center gap-x-3 gap-y-1 border-b border-amber-rule/40 bg-amber-card px-3 text-center text-[12px] font-medium text-amber-ink sm:h-10">
      <span>{label}</span>
      {blocked && onOpenConnectionSettings ? <button type="button" className={buttonClass} onClick={onOpenConnectionSettings}>{t('app.connectionSettings')}</button> : null}
      {canReconnect ? <button type="button" data-banner-reconnect onClick={onReconnect} className={buttonClass}>{reconnectLabel}</button> : null}
      {repeatedRemoteFailure && backAction !== undefined ? (
        <button type="button" data-banner-back-local onClick={backAction} className={buttonClass}>
          {t('app.backToSpace', { space: location.localSpaceName })}
        </button>
      ) : null}
      {recovery ? <button type="button" className={buttonClass} disabled={!failure} onClick={() => { setDetails(true); }}>{t('app.connectionDetails')}</button> : null}
    </div>
    {details && failure ? <Dialog onClose={() => { setDetails(false); }} ariaLabel={t('app.connectionDetails')} overlayId="connection-failure-details" stacked>
      <h2 className="font-display text-lg text-ink">{t('app.connectionDetails')}</h2>
      <pre className="mt-4 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-panel-soft p-3 font-mono text-xs text-ink">{[failure.message, ...failure.stderrTail, failure.logPath].filter(Boolean).join('\n')}</pre>
      <div className="mt-4 flex justify-end gap-3">
        {onOpenConnectionSettings ? <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDetails(false); onOpenConnectionSettings(); }}>{t('app.connectionSettings')}</button> : null}
        <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDetails(false); }}>{t('common.close')}</button>
      </div>
    </Dialog> : null}
  </>;
}

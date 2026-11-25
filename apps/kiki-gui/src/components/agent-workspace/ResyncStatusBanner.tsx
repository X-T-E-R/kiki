/**
 * ResyncStatusBanner — the session resync/rewrite status strip rendered above
 * the dock while the controller catches up with the server.
 */

import type { SessionViewState } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { ConversationDockColumn } from '../ConversationDockColumn';
import { KikiMark } from '../Wordmark';

export function ResyncStatusBanner({
  resyncing,
  resyncFailed,
  error,
  sendPaused = false,
  onRetry,
}: {
  resyncing: boolean;
  resyncFailed: boolean;
  error?: SessionViewState['resyncError'];
  sendPaused?: boolean;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (!resyncing && !resyncFailed && error === undefined) return null;
  return (
    <ConversationDockColumn
      className="pt-1"
      innerClassName="space-y-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-[11.5px] text-ink-soft"
      data-resync-status
      role={resyncing ? 'status' : 'alert'}
    >
      <div className="flex flex-wrap items-center gap-2">
        {resyncing ? <KikiMark className="status-dot-busy" /> : null}
        <span>
          {resyncing ? t('sv.resyncing') : t('sv.resyncFailed')}
          {sendPaused ? ` · ${t('sv.sendPaused')}` : null}
        </span>
        {!resyncing && onRetry !== undefined ? (
          <button type="button" onClick={onRetry}
            className="rounded-full border border-hairline px-2 py-0.5 font-normal transition-colors hover:border-accent hover:text-ink">
            {t('sv.resyncRetryNow')}
          </button>
        ) : null}
      </div>
      {error !== undefined ? <div className="break-words text-danger">
        <p>{error.message}</p>
        {error.code !== undefined || error.requestId !== undefined ? <p className="break-all font-mono text-[10.5px]">{[error.code, error.requestId].filter(Boolean).join(' · ')}</p> : null}
      </div> : null}
    </ConversationDockColumn>
  );
}

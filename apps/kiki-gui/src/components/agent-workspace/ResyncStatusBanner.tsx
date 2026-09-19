/**
 * ResyncStatusBanner — the session resync/rewrite status strip rendered above
 * the dock while the controller catches up with the server.
 */

import type { SessionViewState } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { KikiMark } from '../Wordmark';

export function ResyncStatusBanner({
  resyncing,
  resyncFailed,
  error,
  onRetry,
}: {
  resyncing: boolean;
  resyncFailed: boolean;
  error?: SessionViewState['resyncError'];
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (!resyncing && !resyncFailed && error === undefined) return null;
  return (
    <div className="px-6 pt-1" data-resync-status role={resyncing ? 'status' : 'alert'}>
      <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)] space-y-1 rounded-lg border border-hairline bg-panel px-3 py-2 text-[11.5px] text-ink-soft">
        <div className="flex flex-wrap items-center gap-2">
          {resyncing ? <KikiMark className="status-dot-busy" /> : null}
          <span>{resyncing ? t('sv.resyncing') : t('sv.resyncFailed')} · {t('sv.sendPaused')}</span>
          {!resyncing && onRetry !== undefined ? (
            <button type="button" onClick={onRetry}
              className="rounded-full border border-hairline px-2 py-0.5 font-medium transition-colors hover:border-accent hover:text-accent">
              {t('sv.resyncRetryNow')}
            </button>
          ) : null}
        </div>
        {error !== undefined ? <div className="break-words text-danger">
          <p>{error.message}</p>
          {error.code !== undefined || error.requestId !== undefined ? <p className="break-all font-mono text-[10.5px]">{[error.code, error.requestId].filter(Boolean).join(' · ')}</p> : null}
        </div> : null}
      </div>
    </div>
  );
}

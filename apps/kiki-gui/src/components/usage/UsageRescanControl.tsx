import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { formatGrouped } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Icon } from '../icons';

function useUsageRescanState() {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const queryKey = ['usage-rescan', scopeId] as const;
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => client.getUsageRescan(),
    refetchOnMount: false,
    retryOnMount: false,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? 3000
        : query.state.data?.state === 'running'
          ? 1000
          : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => client.startUsageRescan(),
    onSuccess: (status) => { queryClient.setQueryData(queryKey, status); },
  });
  const status = statusQuery.data;
  const finishedAt = status?.state === 'completed' ? status.finished_at : null;
  useEffect(() => {
    if (finishedAt === null || finishedAt === undefined) return;
    void queryClient.invalidateQueries({ queryKey: ['usage-v2'] });
  }, [finishedAt, queryClient]);

  return { status, statusQuery, start };
}

/**
 * Quiet inline badge rendered on the filter bar ONLY while a full rescan is
 * actively running or failed. Idle and completed states render nothing.
 */
export function UsageRescanActiveBadge() {
  const { t } = useI18n();
  const { status, statusQuery } = useUsageRescanState();
  const running = status?.state === 'running';
  const failed = status?.state === 'failed' || statusQuery.error !== null;
  if (!running && !failed) return null;

  if (failed) {
    return (
      <span role="alert" data-usage-rescan-alert className="text-[11.5px] text-danger">
        {t(statusQuery.error !== null ? 'usage.rescan.progressFailed' : 'usage.rescan.failed')}
      </span>
    );
  }
  if (status?.state !== 'running') return null;

  return (
    <div
      role="status"
      data-usage-rescan-running
      title={t('usage.rescan.records', { count: status.scanned_records })}
      className="inline-flex items-center gap-2 rounded-full border border-hairline bg-panel px-2.5 py-0.5 text-[11px] text-ink-soft tabular-nums"
    >
      <Icon name="refresh" size={12} className="animate-spin text-ink-faint" />
      <span>
        {t('usage.rescan.progress', {
          scanned: formatGrouped(status.scanned_sessions),
          total: formatGrouped(status.total_sessions),
        })}
      </span>
      <progress
        aria-label={t('usage.rescan.action')}
        value={status.scanned_sessions}
        max={Math.max(1, status.total_sessions)}
        className="h-1 w-14 overflow-hidden rounded-full accent-ink-soft [&::-webkit-progress-bar]:bg-hairline [&::-webkit-progress-value]:bg-ink-soft [&::-moz-progress-bar]:bg-ink-soft"
      />
    </div>
  );
}

/**
 * Popover-resident rescan trigger and progress readout inside `UsageReliabilityDetails`.
 */
export function UsageRescanControl() {
  const { t } = useI18n();
  const { status, statusQuery, start } = useUsageRescanState();
  const running = status?.state === 'running';
  const requestError = start.error ?? statusQuery.error;
  const failed = status?.state === 'failed' || requestError !== null;

  return (
    <div data-usage-rescan className="flex flex-col items-end gap-1 text-[11.5px]">
      <button
        type="button"
        data-usage-rescan-start
        title={t('usage.rescan.hint')}
        disabled={running || start.isPending}
        onClick={() => { start.mutate(); }}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-normal text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50"
      >
        <Icon name="refresh" size={12} className={running || start.isPending ? 'animate-spin' : undefined} />
        <span>{t(start.isPending ? 'usage.rescan.starting' : running ? 'usage.rescan.running' : 'usage.rescan.action')}</span>
      </button>
      {failed ? (
        <p role="alert" className="text-right text-[11px] text-danger">
          {t(start.error !== null ? 'usage.rescan.startFailed' : statusQuery.error !== null ? 'usage.rescan.progressFailed' : 'usage.rescan.failed')}
        </p>
      ) : running ? (
        <div role="status" className="w-40 space-y-1 text-right text-[11px] text-ink-faint tabular-nums" title={t('usage.rescan.records', { count: status.scanned_records })}>
          <p>{t('usage.rescan.progress', { scanned: formatGrouped(status.scanned_sessions), total: formatGrouped(status.total_sessions) })}</p>
          <progress
            aria-label={t('usage.rescan.action')}
            value={status.scanned_sessions}
            max={Math.max(1, status.total_sessions)}
            className="block h-1 w-full overflow-hidden rounded-full accent-ink-soft [&::-webkit-progress-bar]:bg-hairline [&::-webkit-progress-value]:bg-ink-soft [&::-moz-progress-bar]:bg-ink-soft"
          />
        </div>
      ) : status?.state === 'completed' ? (
        <span role="status" className="text-right text-[11px] text-ink-faint">
          {t('usage.rescan.completed', { count: formatGrouped(status.scanned_sessions) })}
        </span>
      ) : null}
    </div>
  );
}

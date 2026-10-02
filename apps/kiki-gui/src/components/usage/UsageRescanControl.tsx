import { useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { formatGrouped } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';

export function UsageRescanControl({ children }: { children?: ReactNode }) {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = ['usage-rescan', scopeId];
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => client.getUsageRescan(),
    refetchInterval: (query) => query.state.status === 'error' ? 3000 : query.state.data?.state === 'running' ? 1000 : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => client.startUsageRescan(),
    onSuccess: (status) => { queryClient.setQueryData(queryKey, status); },
  });
  const status = statusQuery.data;
  const running = status?.state === 'running';
  const finishedAt = status?.state === 'completed' ? status.finished_at : null;
  useEffect(() => {
    if (finishedAt === null || finishedAt === undefined) return;
    void queryClient.invalidateQueries({ queryKey: ['usage-v2'] });
    void queryClient.invalidateQueries({ queryKey: ['usage-v2-strip'] });
  }, [finishedAt, queryClient]);
  const requestError = start.error ?? statusQuery.error;
  const failed = status?.state === 'failed' || requestError !== null;

  return (
    <div data-usage-rescan className="ml-auto flex max-w-full flex-col items-end gap-1 text-[11.5px]">
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {children}
        <button
          type="button"
          data-usage-rescan-start
          title={t('usage.rescan.hint')}
          disabled={running || start.isPending}
          onClick={() => { start.mutate(); }}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
        >
          {t(start.isPending ? 'usage.rescan.starting' : running ? 'usage.rescan.running' : 'usage.rescan.action')}
        </button>
      </div>
      {failed ? (
        <p role="alert" className="max-w-64 text-right text-danger">
          {t(start.error !== null ? 'usage.rescan.startFailed' : statusQuery.error !== null ? 'usage.rescan.progressFailed' : 'usage.rescan.failed')}
        </p>
      ) : running ? (
        <div role="status" className="w-48 max-w-full space-y-1 text-ink-faint" title={t('usage.rescan.records', { count: status.scanned_records })}>
          <p className="text-right font-mono tabular-nums">{t('usage.rescan.progress', { scanned: formatGrouped(status.scanned_sessions), total: formatGrouped(status.total_sessions) })}</p>
          <progress
            aria-label={t('usage.rescan.action')}
            value={status.scanned_sessions}
            max={Math.max(1, status.total_sessions)}
            className="block h-0.5 w-full overflow-hidden rounded-full accent-ink-soft [&::-webkit-progress-bar]:bg-hairline [&::-webkit-progress-value]:bg-ink-soft [&::-moz-progress-bar]:bg-ink-soft"
          />
        </div>
      ) : status?.state === 'completed' ? (
        <span role="status" className="text-right text-ink-faint">{t('usage.rescan.completed', { count: formatGrouped(status.scanned_sessions) })}</span>
      ) : null}
    </div>
  );
}

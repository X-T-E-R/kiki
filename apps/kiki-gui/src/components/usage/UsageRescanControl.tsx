import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';

export function UsageRescanControl() {
  const { client, scopeId } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = ['usage-rescan', scopeId];
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => client.getUsageRescan(),
    refetchInterval: (query) => query.state.data?.state === 'running' ? 1000 : false,
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
  const error = requestError instanceof Error ? requestError.message : status?.error;

  return (
    <div data-usage-rescan className="space-y-1.5 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          data-usage-rescan-start
          title={t('usage.rescan.hint')}
          disabled={running || start.isPending}
          onClick={() => { start.mutate(); }}
          className="inline-flex h-7 items-center rounded-md px-2 text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50"
        >
          {t('usage.rescan.action')}
        </button>
        {status?.state === 'completed' && requestError === null ? (
          <span role="status" className="text-success">{t('usage.rescan.completed', { count: status.scanned_sessions })}</span>
        ) : !running ? (
          <span className="text-ink-faint">{t('usage.rescan.hint')}</span>
        ) : null}
      </div>
      {running ? (
        <div role="status" className="max-w-md space-y-1 px-2">
          <div className="flex flex-wrap justify-between gap-x-3 text-ink-soft tabular-nums">
            <span>{t('usage.rescan.progress', { scanned: status.scanned_sessions, total: status.total_sessions })}</span>
            <span>{t('usage.rescan.records', { count: status.scanned_records })}</span>
          </div>
          <progress
            aria-label={t('usage.rescan.action')}
            value={status.scanned_sessions}
            max={Math.max(1, status.total_sessions)}
            className="block h-1.5 w-full overflow-hidden rounded-full accent-accent"
          />
        </div>
      ) : null}
      {status?.state === 'failed' || requestError !== null ? (
        <p role="alert" className="px-2 text-danger">
          {t(status?.state === 'failed' ? 'usage.rescan.failed' : start.error !== null ? 'usage.rescan.startFailed' : 'usage.rescan.progressFailed')}
          {error ? ` ${error}` : ''}
        </p>
      ) : null}
    </div>
  );
}

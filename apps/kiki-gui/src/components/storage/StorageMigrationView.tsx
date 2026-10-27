import { useEffect, useRef, useState } from 'react';
import type { StorageMigrationAction, StorageMigrationView } from '@kiki/protocol';
import { formatBytes } from '@kiki/session-core/composer/attachments';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Wordmark } from '../Wordmark';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, DANGER_BUTTON } from '../ui';

export function StorageMigrationViewComponent({
  initialView,
  onComplete,
}: {
  readonly initialView?: StorageMigrationView;
  readonly onComplete?: () => void;
}) {
  const { client, meta, scopeId } = useConnection();
  const { t } = useI18n();

  const [view, setView] = useState<StorageMigrationView | null>(initialView ?? null);
  const [loading, setLoading] = useState(initialView === undefined);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef({ client, scopeId, onComplete, t });
  latest.current = { client, scopeId, onComplete, t };
  const controls = useRef<{
    refresh: () => Promise<void>;
    action: (action: StorageMigrationAction['action']) => Promise<void>;
  } | null>(null);
  const serverId = meta.server_id;
  const homeId = meta.server_home_id;
  const mode = meta.storage_mode;

  useEffect(() => {
    let active = true;
    let completed = false;
    let pending = false;
    let revision = 0;
    let currentView = initialView;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readFlight: Promise<void> | undefined;
    const current = () => active && latest.current.client === client && latest.current.scopeId === scopeId;
    const complete = () => {
      if (!current() || completed) return;
      completed = true;
      latest.current.onComplete?.();
    };
    const schedule = (delay?: number) => {
      if (timer !== undefined) clearTimeout(timer);
      if (!current() || completed || pending) return;
      const busy = currentView?.transition.state === 'starting' || currentView?.transition.cleanupPending === true ||
        ['running', 'cancelling'].includes(currentView?.status.state ?? '');
      timer = setTimeout(() => { void refresh(); }, delay ?? (busy ? 1000 : 3000));
    };
    const refresh = (): Promise<void> => {
      if (!current() || pending || completed) return Promise.resolve();
      if (readFlight !== undefined) return readFlight;
      if (timer !== undefined) clearTimeout(timer);
      const captured = revision;
      readFlight = (async () => {
        try {
          const next = await client.getStorageMigration();
          if (!current() || captured !== revision) return;
          currentView = next;
          setView(next);
          setError(null);
          if (next.mode === 'normal' || next.transition.state === 'starting') {
            const nextMeta = await client.meta();
            if (!current() || captured !== revision) return;
            if (nextMeta.storage_mode === 'normal') {
              if (nextMeta.server_id === serverId && nextMeta.server_home_id === homeId) complete();
              else setError(latest.current.t('storage.migration.identityChanged'));
            }
          }
        } catch (error) {
          if (current() && captured === revision) setError(error instanceof Error ? error.message : String(error));
        } finally {
          readFlight = undefined;
          if (current()) {
            setLoading(false);
            schedule();
          }
        }
      })();
      return readFlight;
    };
    const action = async (action: StorageMigrationAction['action']) => {
      if (!current() || pending) return;
      pending = true;
      const captured = ++revision;
      if (timer !== undefined) clearTimeout(timer);
      setActionPending(true);
      setError(null);
      try {
        const next = await client.postStorageMigrationAction(action);
        if (!current() || captured !== revision) return;
        currentView = next;
        setView(next);
      } catch (error) {
        if (current() && captured === revision) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current() && captured === revision) {
          pending = false;
          setActionPending(false);
          schedule();
        }
      }
    };
    controls.current = { refresh, action };
    setView(initialView ?? null);
    setLoading(initialView === undefined);
    setActionPending(false);
    setError(null);
    if (mode === 'normal') complete();
    else if (initialView === undefined) void refresh();
    else schedule();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      controls.current = null;
    };
  }, [client, scopeId, serverId, homeId, mode, initialView]);

  const handleAction = (action: StorageMigrationAction['action']) => controls.current?.action(action);
  const fetchStatus = () => controls.current?.refresh();

  const actions = view?.actions ?? [];
  const status = view?.status;
  const transition = view?.transition;
  const isCleaningWaiting = transition?.cleanupPending === true && !actions.includes('retry_cleanup');
  const isCleanupFailed = transition?.cleanupPending === true && actions.includes('retry_cleanup');
  const stateLabel = status?.state === 'complete' && isCleanupFailed
    ? t('storage.migration.cleanupFailureTitle')
    : status?.state === 'complete' && transition?.state === 'failed'
      ? t('storage.migration.startupFailureTitle')
      : status ? t(`storage.migration.status.${status.state}`) : '';

  const progress = status?.progress;
  const progressText = progress
    ? progress.totalItems !== undefined && progress.totalBytes !== undefined
      ? t('storage.migration.progressWithTotal', {
          items: progress.items,
          totalItems: progress.totalItems,
          bytes: formatBytes(progress.bytes),
          totalBytes: formatBytes(progress.totalBytes),
        })
      : t('storage.migration.progress', {
          items: progress.items,
          bytes: formatBytes(progress.bytes),
        })
    : null;

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-canvas p-4 text-ink select-none sm:p-6">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-paper p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center justify-between">
          <Wordmark size="md" />
          <span
            data-testid="storage-authority-badge"
            className="rounded-full bg-hairline/60 px-2.5 py-0.5 text-[11px] font-medium text-ink-soft"
          >
            {status?.authority === 'sqlite'
              ? t('storage.migration.authority.sqlite')
              : t('storage.migration.authority.legacy')}
          </span>
        </div>

        <h1 className="font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {t('storage.migration.title')}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
          {t('storage.migration.description')}
        </p>

        {loading ? (
          <div className="mt-8 flex items-center justify-center py-6 text-sm text-ink-faint">
            {t('storage.migration.action.refresh')}…
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {/* Status card */}
            <div className="rounded-xl border border-hairline/80 bg-canvas/40 p-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ink-soft">
                  {status ? t(`storage.migration.phase.${status.phase}`) : ''}
                </span>
                <span
                  data-testid="migration-state-tag"
                  className="text-[12px] font-semibold text-ink"
                >
                  {stateLabel}
                </span>
              </div>

              {progressText !== null && (
                <div className="mt-2 text-[12px] text-ink-faint" data-testid="migration-progress">
                  {progressText}
                </div>
              )}

              {/* Startup state indicator */}
              {transition?.state === 'starting' && (
                <div
                  data-testid="transition-starting"
                  className="mt-3 flex items-center text-[12px] font-medium text-accent"
                >
                  <span className="mr-2 inline-block h-2 w-2 motion-safe:animate-ping rounded-full bg-accent" />
                  {t('storage.migration.starting')}
                </div>
              )}

              {/* Cleanup waiting indicator */}
              {isCleaningWaiting && (
                <div
                  data-testid="cleanup-pending-waiting"
                  className="mt-3 flex items-center text-[12px] text-ink-soft"
                >
                  <span className="mr-2 inline-block h-2 w-2 motion-safe:animate-pulse rounded-full bg-ink-faint" />
                  {t('storage.migration.cleanupPending')}
                </div>
              )}
            </div>

            {/* Error displays */}
            {error !== null && (
              <div
                data-testid="network-error-banner"
                className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger break-words"
              >
                {error}
              </div>
            )}

            {view?.operationFailure && (
              <div
                data-testid="operation-failure-banner"
                className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger"
              >
                <div className="font-semibold break-words">{view.operationFailure.code}</div>
                <div className="mt-0.5 text-ink-soft break-words">{view.operationFailure.message}</div>
              </div>
            )}

            {status?.warning && (
              <p
                data-testid="migration-warning"
                role="status"
                className="rounded-lg border border-amber-rule/40 bg-amber-card p-3 text-[12px] leading-relaxed text-amber-ink break-words"
              >
                {status.warning.code === 'mailbox.checkpoint_warning'
                  ? t('storage.migration.checkpointWarning')
                  : status.warning.message}
              </p>
            )}

            {/* Status migration failure (e.g. data import/verify error) */}
            {status?.failure && (
              <div
                data-testid="migration-failure-banner"
                className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger"
              >
                <div className="font-semibold break-words">{status.failure.code}</div>
                <div className="mt-0.5 text-ink-soft break-words">{status.failure.message}</div>
                {(status.failure.source || status.failure.key) && (
                  <div className="mt-1 text-[11px] text-ink-faint font-mono break-all">
                    {status.failure.source && <span>{status.failure.source}</span>}
                    {status.failure.source && status.failure.key && <span> · </span>}
                    {status.failure.key && <span>{status.failure.key}</span>}
                  </div>
                )}
              </div>
            )}

            {/* Transition failures (original startup failure + cleanup failure) */}
            {transition?.failure && (
              <div
                data-testid="startup-failure-banner"
                className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger"
              >
                <div className="font-semibold break-words">{t('storage.migration.startupFailureTitle')}</div>
                <div className="mt-0.5 text-ink-soft break-words">{transition.failure.message}</div>
              </div>
            )}

            {isCleanupFailed && transition?.cleanupFailure && (
              <div
                data-testid="cleanup-failure-banner"
                className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-[12px] text-danger"
              >
                <div className="font-semibold break-words">{t('storage.migration.cleanupFailureTitle')}</div>
                <div className="mt-0.5 text-ink-soft break-words">{transition.cleanupFailure.message}</div>
              </div>
            )}

            {/* Source breakdown (if legacy sources detected) */}
            {status?.sources && status.sources.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {status.sources.map((src) => (
                  <div
                    key={src.name}
                    className="flex items-center justify-between text-[11px] text-ink-soft"
                  >
                    <span className="truncate pr-2">{src.name}</span>
                    <span className="shrink-0 text-ink-faint" data-testid="migration-source-stage">
                      {src.exists ? (
                        <>
                          {t(`storage.migration.source.${src.stage ?? 'discovered'}`)}
                          {src.bytes !== undefined && <> · {formatBytes(src.bytes)}</>}
                        </>
                      ) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons (strictly driven by view.actions) */}
            <div className="flex flex-wrap gap-2 pt-2">
              {actions.includes('migrate') && (
                <button
                  type="button"
                  data-action="migrate"
                  disabled={actionPending}
                  onClick={() => handleAction('migrate')}
                  className={PRIMARY_BUTTON}
                >
                  {t('storage.migration.action.migrate')}
                </button>
              )}

              {actions.includes('start') && (
                <button
                  type="button"
                  data-action="start"
                  disabled={actionPending}
                  onClick={() => handleAction('start')}
                  className={PRIMARY_BUTTON}
                >
                  {t('storage.migration.action.start')}
                </button>
              )}

              {actions.includes('retry_cleanup') && (
                <button
                  type="button"
                  data-action="retry_cleanup"
                  disabled={actionPending}
                  onClick={() => handleAction('retry_cleanup')}
                  className={DANGER_BUTTON}
                >
                  {t('storage.migration.action.retry_cleanup')}
                </button>
              )}

              {actions.includes('cancel') && (
                <button
                  type="button"
                  data-action="cancel"
                  disabled={actionPending}
                  onClick={() => handleAction('cancel')}
                  className={SECONDARY_BUTTON}
                >
                  {t('storage.migration.action.cancel')}
                </button>
              )}

              {actions.includes('rollback') && (
                <button
                  type="button"
                  data-action="rollback"
                  disabled={actionPending}
                  onClick={() => handleAction('rollback')}
                  className={SECONDARY_BUTTON}
                >
                  {t('storage.migration.action.rollback')}
                </button>
              )}

              <button
                type="button"
                data-action="refresh"
                disabled={actionPending}
                onClick={() => fetchStatus()}
                className={`${SECONDARY_BUTTON} ml-auto`}
              >
                {t('storage.migration.action.refresh')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

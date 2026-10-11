/**
 * Usage → External sync (/usage?panel=export).
 *
 * The third reading of the usage question: not "what did I spend" but "where
 * does it go". Three exits are supported — vibecafe.ai, the Kiki usage webhook,
 * and a script the user writes — and every one of them is a destination the
 * server owns, so this screen projects `/api/usage-export` instead of keeping a
 * second copy of that state.
 *
 * Reading order: which server and home is reporting (and, right-aligned, the one
 * action that adds a destination); the pending-data ceiling; then a flat list
 * where a quiet row opens its detail in place. A healthy destination says
 * nothing beyond its state word; a blocked one names the recorded category and
 * the action that clears it. Failures stay inside the row they belong to, so a
 * destination that cannot authenticate never covers the list, and nothing here
 * touches the chat surface.
 *
 * Honesty rules: a failed status request is never shown as an empty list; a
 * `writer: false` snapshot is shown read-only; the consent state is the server's
 * own fingerprint, never a client guess; a paused or drafted destination keeps
 * its queue and says so; and every count comes from the wire.
 */

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { UsageExportHandoff, UsageExportPreview, UsageExportScope } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { InlineError } from '../../controls';
import { Icon } from '../../icons';
import { InlineEditor } from '../../InlineEditor';
import { DANGER_GHOST_BUTTON, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { UsageExportForm } from './UsageExportForm';
import { HandoffSection } from './UsageExportHandoff';
import { UsageExportPreviewBlock } from './UsageExportPreview';
import {
  USAGE_EXPORT_QUERY_KEY,
  categoryIsKnown,
  categoryTextKey,
  consentIsCurrent,
  downloadFileName,
  downloadJson,
  floorToHalfHour,
  formatBytes,
  kindLabelKey,
  kindShortKey,
  needsAttention,
  queueIsEmpty,
  queuePending,
  stateLabelKey,
  targetSummary,
  usageExportApi,
  handoffViewOf,
  utcLabel,
  type UsageExportEntry,
} from '../../../lib/usageExport';

const NOTICE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';
const DETAIL_ROW = 'flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px] leading-5';
const DETAIL_TERM = 'text-ink-faint';
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_8rem_9rem_6rem_1rem]';
const GHOST = 'rounded-md px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50';

/** States whose chip carries the amber "attention" tone rather than plain ink. */
const ATTENTION_STATES = new Set(['needs-auth', 'queue-full', 'quarantined', 'remote-diverged', 'adapter-unavailable']);

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`;
}

export function UsageExportPanel() {
  const { klient, scopeId, meta, config, sshLabel } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const api = usageExportApi(klient);

  const statusQuery = useQuery({
    queryKey: [USAGE_EXPORT_QUERY_KEY, 'status', scopeId],
    queryFn: () => api!.status(),
    enabled: api !== undefined,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.status === 'error') return 10_000;
      return query.state.data?.destinations.some((item) => item.destination.enabled) === true ? 15_000 : false;
    },
  });

  const [form, setForm] = useState<{ readonly entry: UsageExportEntry | undefined } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ readonly id: string; readonly error: unknown } | null>(null);
  const [preview, setPreview] = useState<{ readonly id: string; readonly value: UsageExportPreview } | null>(null);
  const [handoff, setHandoff] = useState<{ readonly id: string; readonly value: UsageExportHandoff | null } | null>(null);
  const [confirm, setConfirm] = useState<{ readonly kind: 'remove' | 'clearQueue' | 'withdraw'; readonly entry: UsageExportEntry } | null>(null);
  const [capacity, setCapacity] = useState<string | null>(null);
  const [capacityInvalid, setCapacityInvalid] = useState(false);

  // A scope switch (another server or home) must not paint the previous
  // connection's failure or busy state into the new one.
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [USAGE_EXPORT_QUERY_KEY] });

  const run = async (key: string, destinationId: string, work: () => Promise<unknown>) => {
    const started = scopeId;
    setBusyKey(key);
    setFailure(null);
    try {
      await work();
      if (scopeRef.current !== started) return;
      await invalidate();
    } catch (error) {
      if (scopeRef.current === started) setFailure({ id: destinationId, error });
    } finally {
      setBusyKey(null);
    }
  };

  const sourceLabel = sshLabel ?? (config.url === '' ? 'local' : config.url.replace(/^https?:\/\//, ''));
  const home = meta.server_home_id ?? 'main';
  const entries = statusQuery.data?.destinations ?? [];
  const writable = statusQuery.data?.writer ?? false;
  const queueLimit = entries[0]?.queue.limit_bytes;
  const queueUsed = entries.reduce((sum, item) => sum + item.queue.bytes, 0);
  const activeConfirm = confirm;
  const copy = activeConfirm === null ? null : (() => {
    const entry = activeConfirm.entry;
    if (activeConfirm.kind === 'clearQueue') {
      return {
        title: t('usage.export.confirm.clearQueue.title'),
        body: t('usage.export.confirm.clearQueue.body', { name: entry.destination.label, count: queuePending(entry.queue) }),
        consequences: [] as readonly string[],
        confirmLabel: t('usage.export.confirm.clearQueue.confirm'),
      };
    }
    if (activeConfirm.kind === 'withdraw') {
      return {
        title: t('usage.export.confirm.withdraw.title', { name: entry.destination.label }),
        body: t('usage.export.confirm.withdraw.body'),
        consequences: [] as readonly string[],
        confirmLabel: t('usage.export.confirm.withdraw.confirm'),
      };
    }
    const pending = queuePending(entry.queue);
    return {
      title: t('usage.export.confirm.remove.title', { name: entry.destination.label }),
      body: t('usage.export.confirm.remove.body'),
      consequences: [pending > 0
        ? t('usage.export.confirm.remove.pending', { count: pending })
        : t('usage.export.confirm.remove.clean')],
      confirmLabel: pending > 0
        ? t('usage.export.confirm.remove.discard', { count: pending })
        : t('usage.export.confirm.remove.confirm'),
    };
  })();

  const onConfirm = () => {
    if (activeConfirm === null || api === undefined) return;
    const entry = activeConfirm.entry;
    setConfirm(null);
    if (activeConfirm.kind === 'clearQueue') {
      void run(`clear-queue:${entry.destination.id}`, entry.destination.id, () => api.clearQueue(entry.destination.id, true));
    } else if (activeConfirm.kind === 'withdraw') {
      void run(`withdraw:${entry.destination.id}`, entry.destination.id, () => api.withdraw(entry.destination.id, true));
    } else {
      void run(`remove:${entry.destination.id}`, entry.destination.id, () => api.remove(entry.destination.id, queuePending(entry.queue) > 0));
    }
  };

  if (api === undefined) {
    return (
      <div className="space-y-3" data-usage-export-panel>
        <SourceLine server={sourceLabel} home={home} />
        <p role="alert" data-usage-export-no-transport className={NOTICE_AMBER}>{t('usage.export.noTransport')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-usage-export-panel>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <SourceLine server={sourceLabel} home={home} />
          <p data-usage-export-source-note className="mt-1 max-w-[76ch] text-[12px] leading-relaxed text-ink-faint">
            {t('usage.export.sourceNote')}
          </p>
        </div>
        <button
          type="button"
          data-usage-export-add
          disabled={!writable || busyKey !== null}
          onClick={() => { setForm({ entry: undefined }); }}
          className={SECONDARY_BUTTON}
        >
          {t('usage.export.add')}
        </button>
      </div>

      {!writable && !statusQuery.isPending && !statusQuery.isError ? (
        <div data-usage-export-readonly className={NOTICE_AMBER}>
          <p className="font-medium">{t('usage.export.readonly.title')}</p>
          <p className="mt-0.5">{t('usage.export.readonly.body')}</p>
        </div>
      ) : null}

      {statusQuery.isPending ? (
        <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-panel px-4 py-12 text-[13px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
          {t('usage.export.loading')}
        </div>
      ) : statusQuery.isError ? (
        <div data-usage-export-load-error className="rounded-xl border border-danger/30 bg-danger/5 p-5">
          <p className="text-[13px] font-medium text-danger">{t('usage.export.loadFailed')}</p>
          <div className="mt-1"><InlineError error={statusQuery.error} /></div>
          <button type="button" className={`mt-3 ${SECONDARY_BUTTON}`} onClick={() => void statusQuery.refetch()}>{t('common.retry')}</button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-hairline pb-3 text-[12px]">
            <p data-usage-export-scan className="text-ink-faint">
              {statusQuery.data?.scan_complete === true
                ? t('usage.export.detail.scanComplete')
                : statusQuery.data?.scan_error !== null && statusQuery.data?.scan_error !== undefined
                  ? t('usage.export.detail.scanFailed', { reason: t(categoryTextKey(statusQuery.data.scan_error)) })
                  : t('usage.export.detail.scanRunning')}
            </p>
            {queueLimit !== undefined ? (
              <div className="ml-auto flex flex-wrap items-center gap-x-2">
                <span data-usage-export-capacity className={`font-mono tabular-nums ${queueUsed / queueLimit > 0.8 ? 'text-amber-ink' : 'text-ink-soft'}`}>
                  {t('usage.export.capacity.value', { used: formatBytes(queueUsed), limit: formatBytes(queueLimit) })}
                </span>
                {queueUsed / queueLimit > 0.8 ? <span className="text-[11.5px] text-amber-ink">{t('usage.export.capacity.warning')}</span> : null}
                {capacity === null ? (
                  <button
                    type="button"
                    data-usage-export-capacity-edit
                    disabled={!writable || busyKey !== null}
                    onClick={() => { setCapacity(String(queueLimit)); }}
                    className={GHOST}
                  >
                    {t('usage.export.capacity.change')}
                  </button>
                ) : (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const bytes = Number(capacity);
                      if (!Number.isInteger(bytes) || bytes <= 0) { setCapacityInvalid(true); return; }
                      setCapacityInvalid(false);
                      void run('capacity', '', () => api.setQueueCapacity(bytes)).then(() => { setCapacity(null); });
                    }}
                  >
                    <input
                      value={capacity}
                      inputMode="numeric"
                      aria-label={t('usage.export.capacity.title')}
                      aria-invalid={capacityInvalid}
                      onChange={(event) => { setCapacity(event.target.value); setCapacityInvalid(false); }}
                      className="h-7 w-28 rounded-md border border-hairline bg-paper px-2 text-right font-mono text-[12px] text-ink tabular-nums outline-none focus:border-selected-ink"
                    />
                    <button type="submit" className="h-7 rounded-md border border-hairline px-2 text-[12px] text-ink-soft hover:text-ink">
                      {t('usage.export.capacity.change')}
                    </button>
                    {capacityInvalid ? <span role="alert" className="text-[11.5px] text-danger">{t('usage.export.capacity.invalid')}</span> : null}
                  </form>
                )}
              </div>
            ) : null}
          </div>

          {entries.length === 0 ? (
            <div data-usage-export-empty className="rounded-xl border border-hairline bg-panel px-4 py-8">
              <p className="text-[13px] font-medium text-ink">{t('usage.export.empty.title')}</p>
              <p className="mt-1 max-w-[76ch] text-[12.5px] leading-relaxed text-ink-soft">{t('usage.export.empty.body')}</p>
              <button type="button" data-usage-export-empty-add disabled={!writable} onClick={() => { setForm({ entry: undefined }); }} className={`mt-3 ${PRIMARY_BUTTON}`}>
                {t('usage.export.empty.add')}
              </button>
            </div>
          ) : (
            <div data-usage-export-list>
              <div aria-hidden className={`${ROW_GRID} px-2 pb-2 text-[11px] text-ink-faint`}>
                <span>{t('usage.export.col.destination')}</span>
                <span className="hidden sm:block">{t('usage.export.col.endpoint')}</span>
                <span className="hidden sm:block">{t('usage.export.col.state')}</span>
                <span className="hidden sm:block">{t('usage.export.col.timing')}</span>
                <span className="hidden text-right sm:block">{t('usage.export.col.queue')}</span>
                <span className="hidden sm:block" />
              </div>
              <ol className="divide-y divide-hairline border-t border-hairline">
                {entries.map((entry) => (
                  <DestinationRow
                    key={entry.destination.id}
                    entry={entry}
                    open={openId === entry.destination.id}
                    writable={writable}
                    busyKey={busyKey}
                    failure={failure?.id === entry.destination.id ? failure.error : null}
                    preview={preview?.id === entry.destination.id ? preview.value : null}
                    handoff={handoff?.id === entry.destination.id ? handoff.value : undefined}
                    onHandoff={(value) => { setHandoff({ id: entry.destination.id, value }); }}
                    onSettled={() => { void invalidate(); }}
                    onToggle={() => {
                      const id = entry.destination.id;
                      setOpenId((current) => (current === id ? null : id));
                      setPreview((current) => (current?.id === id ? null : current));
                      setFailure(null);
                    }}
                    onEdit={() => { setForm({ entry }); }}
                    onRun={run}
                    onPreview={(value) => { setPreview(value === null ? null : { id: entry.destination.id, value }); }}
                    onConfirm={(kind) => { setConfirm({ kind, entry }); }}
                    onExport={(payload, suffix) => { downloadJson(downloadFileName(entry.destination.label, entry.destination.id, suffix), payload); }}
                  />
                ))}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3 text-[12px]">
            <button
              type="button"
              data-usage-export-diagnostics
              disabled={busyKey !== null}
              onClick={() => {
                void run('diagnostics', '', async () => {
                  downloadJson(downloadFileName('diagnostics', scopeId, 'diagnostics'), await api.diagnostics());
                });
              }}
              className={GHOST}
            >
              {t('usage.export.action.diagnostics')}
            </button>
            <p className="min-w-0 flex-1 basis-64 text-[11.5px] text-ink-faint">{t('usage.export.diagnosticsHint')}</p>
            {writable ? (
              <button
                type="button"
                data-usage-export-rebuild
                disabled={busyKey !== null}
                onClick={() => { void run('rebuild', '', () => api.rebuild(true)); }}
                className={GHOST}
              >
                {t('usage.export.action.rebuild')}
              </button>
            ) : null}
          </div>
        </>
      )}

      {form !== null ? (
        <UsageExportForm
          entry={form.entry}
          onClose={() => { setForm(null); }}
          onSaved={() => { setForm(null); void invalidate(); }}
          onUpdated={() => { void invalidate(); }}
        />
      ) : null}

      {copy === null ? null : (
        <ConfirmDialog
          open
          title={copy.title}
          body={copy.body}
          consequences={copy.consequences}
          confirmLabel={copy.confirmLabel}
          overlayId="usage-export-confirm"
          busy={busyKey !== null}
          onConfirm={onConfirm}
          onCancel={() => { setConfirm(null); }}
        />
      )}
    </div>
  );
}

function SourceLine({ server, home }: { readonly server: string; readonly home: string }) {
  const { t } = useI18n();
  return (
    <p data-usage-export-source className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px]">
      <span className="text-ink-faint">{t('usage.export.sourceLabel')}</span>
      <span className="font-mono break-all text-ink">{t('usage.export.sourceValue', { server, home })}</span>
    </p>
  );
}

function StateChip({ state }: { readonly state: UsageExportEntry['destination']['state'] }) {
  const { t } = useI18n();
  const attention = ATTENTION_STATES.has(state);
  return (
    <span
      data-usage-export-state={state}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] ${
        attention ? 'border-amber-rule/50 text-amber-ink' : state === 'ready' ? 'border-hairline text-ink-soft' : 'border-hairline text-ink-faint'
      }`}
    >
      {state === 'ready' ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" /> : null}
      {attention ? <Icon name="warning" size={12} /> : null}
      {t(stateLabelKey(state))}
    </span>
  );
}

/** One compact bounded range for "send history"; it reuses the preview + consent. */
function BackfillForm({ entry, onRun, onPreview, onClose }: {
  readonly entry: UsageExportEntry;
  readonly onRun: (key: string, destinationId: string, work: () => Promise<unknown>) => Promise<void>;
  readonly onPreview: (value: UsageExportPreview | null) => void;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { klient } = useConnection();
  const api = usageExportApi(klient);
  const toLocal = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [start, setStart] = useState(() => toLocal(entry.destination.scope.start_at));
  const [bounded, setBounded] = useState(false);
  const [end, setEnd] = useState(() => toLocal(floorToHalfHour(Date.now())));
  const [invalid, setInvalid] = useState(false);

  const startAt = new Date(start).getTime();
  const endAt = new Date(end).getTime();

  const submit = () => {
    if (api === undefined) return;
    if (!Number.isFinite(startAt) || (bounded && (!Number.isFinite(endAt) || endAt <= startAt))) { setInvalid(true); return; }
    setInvalid(false);
    const scope: UsageExportScope = {
      start_at: Math.floor(startAt / 1_800_000) * 1_800_000,
      end_at: bounded ? Math.ceil(endAt / 1_800_000) * 1_800_000 : null,
      include_ephemeral: entry.destination.scope.include_ephemeral,
      excluded_workspace_ids: [...entry.destination.scope.excluded_workspace_ids],
    };
    void onRun(`backfill:${entry.destination.id}`, entry.destination.id, async () => {
      onPreview(await api.backfill(entry.destination.id, scope));
      onClose();
    });
  };

  return (
    <div data-usage-export-backfill className="space-y-2">
      <p className={`${'text-[11.5px] leading-relaxed text-ink-faint'} max-w-[76ch]`}>{t('usage.export.form.historyHint')}</p>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="block space-y-1">
          <span className="block text-[12px] text-ink-soft">{t('usage.export.form.historyFrom')}</span>
          <input
            data-usage-export-backfill-start
            type="datetime-local"
            value={start}
            onChange={(event) => { setStart(event.target.value); setInvalid(false); }}
            className="h-8 w-56 rounded-md border border-hairline bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-selected-ink"
          />
        </label>
        {bounded ? (
          <label className="block space-y-1">
            <span className="block text-[12px] text-ink-soft">{t('usage.customRange.end')}</span>
            <input
              data-usage-export-backfill-end
              type="datetime-local"
              value={end}
              onChange={(event) => { setEnd(event.target.value); setInvalid(false); }}
              className="h-8 w-56 rounded-md border border-hairline bg-paper px-2 font-mono text-[12px] text-ink outline-none focus:border-selected-ink"
            />
          </label>
        ) : null}
        <button type="button" onClick={submit} disabled={api === undefined} className={SECONDARY_BUTTON}>
          {t('usage.export.action.backfill')}
        </button>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink-soft">
        <input type="checkbox" checked={bounded} onChange={(event) => { setBounded(event.target.checked); }} />
        {t('usage.customRange.end')}
      </label>
      {invalid ? <p role="alert" className="text-[12px] text-danger">{t('usage.export.handoff.cutoffInvalid')}</p> : null}
    </div>
  );
}

function DestinationRow({
  entry, open, writable, busyKey, failure, preview, handoff, onHandoff, onSettled, onToggle, onEdit, onRun, onPreview, onConfirm, onExport,
}: {
  readonly entry: UsageExportEntry;
  readonly open: boolean;
  readonly writable: boolean;
  readonly busyKey: string | null;
  readonly failure: unknown;
  readonly preview: UsageExportPreview | null;
  /** `undefined` until this row has read its own handoff state. */
  readonly handoff: UsageExportHandoff | null | undefined;
  readonly onHandoff: (next: UsageExportHandoff | null) => void;
  readonly onSettled: () => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onRun: (key: string, destinationId: string, work: () => Promise<unknown>) => Promise<void>;
  readonly onPreview: (value: UsageExportPreview | null) => void;
  readonly onConfirm: (kind: 'remove' | 'clearQueue' | 'withdraw') => void;
  readonly onExport: (payload: unknown, suffix: string) => void;
}) {
  const { t, time } = useI18n();
  const { klient } = useConnection();
  const api = usageExportApi(klient);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const { destination, queue } = entry;
  const handoffView = api === undefined || handoff === undefined ? null : handoffViewOf(handoff, destination);
  const summary = targetSummary(destination.target);
  const pending = queuePending(queue);
  const busy = (suffix: string) => busyKey === `${suffix}:${destination.id}`;
  const anyBusy = busyKey !== null;
  const actionable = writable && api !== undefined;
  const consent = consentIsCurrent(destination);
  const drift = destination.enabled && !consent;


  const recovering: I18nKey | null = drift
    ? 'usage.export.recover.consent'
    : destination.state === 'needs-auth' ? 'usage.export.recover.needs-auth'
      : destination.state === 'queue-full' ? 'usage.export.recover.queue-full'
        : destination.state === 'quarantined' ? 'usage.export.recover.quarantined'
          : destination.state === 'remote-diverged' ? 'usage.export.recover.remote-diverged'
            : destination.state === 'adapter-unavailable' ? 'usage.export.recover.adapter-unavailable'
              : destination.state === 'retrying' ? 'usage.export.recover.retrying'
                : null;
  /**
   * The recorded category is the precise fact, and the recovery line is the
   * action. Several categories only restate the line that is already above
   * them, so they are shown alone: a second copy of the same sentence is not
   * information. Anything not in that list still adds the specific reason.
   */
  const RECOVERY_LINE_OWNS_THE_REASON: ReadonlySet<string> = new Set([
    'needs-auth', 'http_auth', 'queue-full', 'export-queue-full',
    'remote-diverged', 'remote_diverged', 'adapter-unavailable', 'adapter_unavailable',
  ]);
  const showCategory = destination.error_category !== null
    && (recovering === null || !RECOVERY_LINE_OWNS_THE_REASON.has(destination.error_category));

  /**
   * Resuming re-presents the fingerprint the server already recorded for this
   * configuration, so a shrink or a period change continues without a second
   * consent — and a configuration that drifted is refused by the server, which
   * the recovery line then explains.
   */
  const resume = async () => {
    const fingerprint = destination.consent_fingerprint;
    if (fingerprint === null || api === undefined) return;
    await api.enable(destination.id, { preview_fingerprint: fingerprint, acknowledge: true });
  };

  const scheduleKey = ([0, 5, 15, 30, 60] as readonly number[]).includes(destination.schedule_minutes)
    ? (`usage.export.schedule.${destination.schedule_minutes}` as I18nKey)
    : ('usage.export.schedule.30' as I18nKey);

  return (
    <li data-usage-export-destination={destination.id}>
      <button
        type="button"
        data-usage-export-row
        aria-expanded={open}
        aria-controls={`usage-export-detail-${destination.id}`}
        onClick={onToggle}
        className={`${ROW_GRID} w-full rounded-md px-2 py-2.5 text-left transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink sm:py-2`}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-[13px] text-ink" title={destination.label}>{destination.label}</span>
            <span className="sm:hidden"><StateChip state={destination.state} /></span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-x-1.5 text-[11.5px] text-ink-faint">
            <span className="shrink-0">{t(kindShortKey(destination.target.kind))}</span>
            {destination.schedule_minutes === 0 ? <span className="shrink-0">· {t('usage.export.schedule.0')}</span> : null}
          </span>
          {/* The columns to the right are desktop-only; the narrow layout keeps
              the same three facts under the name instead of dropping them. */}
          <span className="mt-0.5 block min-w-0 sm:hidden">
            <span className="block truncate font-mono text-[11.5px] text-ink-soft" title={summary.exact}>{summary.exact}</span>
            <span className="mt-0.5 block text-[11.5px] text-ink-faint">
              {destination.last_success_at === null ? t('usage.export.neverSent') : time.relativeTime(new Date(destination.last_success_at).toISOString())}
              {' · '}
              {pending === 0 ? t('usage.export.queue.none') : t('usage.export.queue.pending', { count: pending })}
              {queue.quarantined > 0 ? <span className="text-amber-ink">{' · '}{t('usage.export.queue.quarantined', { count: queue.quarantined })}</span> : null}
            </span>
          </span>
        </span>

        <span className="hidden min-w-0 font-mono text-[12px] break-all text-ink-soft sm:block" title={summary.exact}>{summary.exact}</span>

        <span className="hidden min-w-0 sm:block"><StateChip state={destination.state} /></span>

        <span className="hidden min-w-0 text-[11.5px] leading-4 text-ink-faint sm:block">
          <span className="block truncate" title={destination.last_success_at === null ? undefined : time.absoluteTime(new Date(destination.last_success_at).toISOString())}>
            {destination.last_success_at === null ? t('usage.export.neverSent') : time.relativeTime(new Date(destination.last_success_at).toISOString())}
          </span>
          <span className="block truncate" title={destination.next_at === null ? undefined : time.absoluteTime(new Date(destination.next_at).toISOString())}>
            {destination.next_at === null ? t('usage.export.noNext') : t('usage.export.nextAt', { time: time.timeUntil(new Date(destination.next_at).toISOString()) })}
          </span>
        </span>

        <span className="hidden text-right text-[11.5px] leading-4 text-ink-faint sm:block">
          <span data-usage-export-pending className={`block font-mono tabular-nums ${pending > 0 ? 'text-ink-soft' : ''}`}>
            {pending === 0 ? t('usage.export.queue.none') : t('usage.export.queue.pending', { count: pending })}
          </span>
          {queue.oldest_at !== null ? (
            <span className="block truncate">{t('usage.export.queue.oldest', { time: time.relativeTime(new Date(queue.oldest_at).toISOString()) })}</span>
          ) : null}
          {queue.quarantined > 0 ? (
            <span data-usage-export-quarantined className="block text-amber-ink tabular-nums">{t('usage.export.queue.quarantined', { count: queue.quarantined })}</span>
          ) : null}
        </span>

        <span className="justify-self-end text-ink-faint">
          <Icon name="chevron" size={14} className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
        </span>
      </button>

      <InlineEditor open={open} id={`usage-export-detail-${destination.id}`} lazy className="mb-3">
        <div className="space-y-3" data-usage-export-detail={destination.id}>
          {!writable ? <p className={NOTICE_AMBER}>{t('usage.export.readonly.body')}</p> : null}

          {recovering !== null || showCategory ? (
            <p data-usage-export-recovery role="status" className={NOTICE_AMBER}>
              {recovering !== null ? t(recovering) : null}
              {showCategory && destination.error_category !== null ? (
                <span className={recovering !== null ? 'mt-1 block text-[12px]' : ''}>
                  {t(categoryTextKey(destination.error_category))}
                  {!categoryIsKnown(destination.error_category) ? <span className="ml-1 font-mono">{destination.error_category}</span> : null}
                </span>
              ) : null}
            </p>
          ) : null}

          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div className={DETAIL_ROW}>
              <dt className={DETAIL_TERM}>{t('usage.export.col.destination')}</dt>
              <dd data-usage-export-detail-kind className="text-ink">{t(kindLabelKey(destination.target.kind))}</dd>
            </div>
            <div className={DETAIL_ROW}>
              <dt className={DETAIL_TERM}>{t('usage.export.detail.schedule')}</dt>
              <dd className="text-ink">{t(scheduleKey)}</dd>
            </div>
            <div className={`${DETAIL_ROW} sm:col-span-2`}>
              <dt className={DETAIL_TERM}>{t(destination.target.kind === 'script' ? 'usage.export.detail.command' : 'usage.export.detail.endpoint')}</dt>
              <dd data-usage-export-detail-target className="min-w-0 font-mono break-all text-ink">{summary.exact}</dd>
            </div>
            <div className={`${DETAIL_ROW} sm:col-span-2`}>
              <dt className={DETAIL_TERM}>{t('usage.export.detail.scope')}</dt>
              <dd data-usage-export-detail-scope className="min-w-0 text-ink">
                <span className="font-mono break-all">{utcLabel(destination.scope.start_at)}</span>
                {destination.scope.excluded_workspace_ids.length > 0
                  ? <span className="text-ink-soft">{' · '}{t('usage.export.detail.scopeExcluded', { count: destination.scope.excluded_workspace_ids.length })}</span>
                  : null}
                <span className="text-ink-soft">{' · '}{t(destination.scope.include_ephemeral ? 'usage.export.detail.ephemeralOn' : 'usage.export.detail.ephemeralOff')}</span>
              </dd>
            </div>
            <div className={DETAIL_ROW}>
              <dt className={DETAIL_TERM}>{t('usage.export.detail.credential')}</dt>
              <dd data-usage-export-detail-credential className="text-ink">
                {t(`usage.export.detail.credential.${destination.target.kind === 'script' ? 'none' : destination.credential_storage}` as I18nKey)}
              </dd>
            </div>
            <div className={`${DETAIL_ROW} sm:col-span-2`}>
              <dt className={DETAIL_TERM}>{t('usage.export.detail.consent')}</dt>
              <dd data-usage-export-detail-consent className="min-w-0 text-ink">
                {drift
                  ? <span className="text-amber-ink">{t('usage.export.detail.consent.changed')}</span>
                  : consent
                    ? t('usage.export.detail.consent.granted')
                    : <span className="text-ink-soft">{t('usage.export.detail.consent.none')} · {t('usage.export.detail.consent.noneHint')}</span>}
              </dd>
            </div>
          </dl>

          {destination.target.kind !== 'script' ? (
            <details data-usage-export-identity className="text-[12px] leading-relaxed text-ink-soft [&[open]>summary]:mb-1">
              <summary className="cursor-pointer text-ink-faint underline decoration-dotted underline-offset-2">
                {t('usage.export.detail.identityShow')}
              </summary>
              <p className="mt-1" data-usage-export-identity-body>
                <span className="font-mono break-all text-ink">{t('usage.export.detail.identity', { fingerprint: shortId(destination.account_fingerprint) })}</span>
                <span className="mt-0.5 block text-ink-soft">{t('usage.export.detail.identityNote')}</span>
              </p>
            </details>
          ) : null}

          {preview !== null ? (
            <div data-usage-export-detail-preview className="border-t border-hairline pt-3">
              <UsageExportPreviewBlock
                preview={preview}
                stale={false}
                footer={(
                  <button
                    type="button"
                    data-usage-export-detail-enable
                    disabled={anyBusy || !actionable}
                    onClick={() => {
                      void onRun(`enable:${destination.id}`, destination.id, () => api!.enable(destination.id, { preview_fingerprint: preview.preview_fingerprint, acknowledge: true }));
                    }}
                    className={SECONDARY_BUTTON}
                  >
                    {t('usage.export.consent.enable')}
                  </button>
                )}
              />
            </div>
          ) : null}

          <div className="border-t border-hairline pt-3">
            <button
              type="button"
              data-usage-export-backfill-open
              aria-expanded={backfillOpen}
              disabled={!actionable}
              onClick={() => { setBackfillOpen((current) => !current); }}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:opacity-50"
            >
              <Icon name={backfillOpen ? 'collapse' : 'expand'} size={12} />
              {t('usage.export.action.backfill')}
            </button>
            {backfillOpen && api !== undefined ? (
              <div className="mt-2">
                <BackfillForm entry={entry} onRun={onRun} onPreview={onPreview} onClose={() => { setBackfillOpen(false); }} />
              </div>
            ) : null}
          </div>

          {api === undefined || destination.target.kind !== 'vibe' ? null : (
            <div className="border-t border-hairline pt-3">
              <HandoffSection
                api={api}
                destination={destination}
                view={handoffView}
                handoff={handoff ?? null}
                onHandoff={onHandoff}
                onSettled={onSettled}
              />
            </div>
          )}

          <div data-usage-export-actions className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline pt-3">
            <button
              type="button"
              data-usage-export-sync
              disabled={anyBusy || !actionable || !destination.enabled || needsAttention(destination.state)}
              onClick={() => { void onRun(`sync:${destination.id}`, destination.id, () => api!.syncNow(destination.id)); }}
              className={SECONDARY_BUTTON}
            >
              {t(busy('sync') ? 'usage.export.busy.working' : 'usage.export.action.sync')}
            </button>
            <button
              type="button"
              data-usage-export-test
              disabled={anyBusy || !actionable}
              onClick={() => { void onRun(`test:${destination.id}`, destination.id, () => api!.testProtocol(destination.id)); }}
              className={SECONDARY_BUTTON}
            >
              {t(busy('test') ? 'usage.export.busy.working' : 'usage.export.action.test')}
            </button>
            {destination.enabled ? (
              <button
                type="button"
                data-usage-export-pause
                disabled={anyBusy || !actionable}
                onClick={() => { void onRun(`pause:${destination.id}`, destination.id, () => api!.disable(destination.id)); }}
                className={SECONDARY_BUTTON}
              >
                {t('usage.export.action.pause')}
              </button>
            ) : consent ? (
              <button
                type="button"
                data-usage-export-resume
                disabled={anyBusy || !actionable}
                onClick={() => { void onRun(`resume:${destination.id}`, destination.id, resume); }}
                className={SECONDARY_BUTTON}
              >
                {t('usage.export.action.resume')}
              </button>
            ) : null}
            <button
              type="button"
              data-usage-export-preview
              disabled={anyBusy || api === undefined}
              onClick={() => {
                void onRun(`preview:${destination.id}`, destination.id, async () => {
                  onPreview(await api!.preview(destination.id));
                });
              }}
              className={SECONDARY_BUTTON}
            >
              {t('usage.export.action.preview')}
            </button>
            {queue.quarantined > 0 ? (
              <button
                type="button"
                data-usage-export-retry
                disabled={anyBusy || !actionable}
                onClick={() => { void onRun(`retry:${destination.id}`, destination.id, () => api!.retry(destination.id)); }}
                className={SECONDARY_BUTTON}
              >
                {t('usage.export.action.retry')}
              </button>
            ) : null}
            <button type="button" data-usage-export-edit disabled={anyBusy || !actionable} onClick={onEdit} className={GHOST}>
              {t('usage.export.action.edit')}
            </button>
            <button
              type="button"
              data-usage-export-export-local
              disabled={anyBusy || api === undefined}
              onClick={() => {
                void onRun(`export:${destination.id}`, destination.id, async () => {
                  onExport(await api!.exportLocal(destination.id), 'pending');
                });
              }}
              className={GHOST}
            >
              {t('usage.export.action.exportLocal')}
            </button>
            {!queueIsEmpty(queue) ? (
              <button type="button" data-usage-export-clear-queue disabled={anyBusy || !actionable} onClick={() => { onConfirm('clearQueue'); }} className={DANGER_GHOST_BUTTON}>
                {t('usage.export.action.clearQueue')}
              </button>
            ) : null}
            {destination.target.kind !== 'vibe' && destination.last_success_at !== null ? (
              <button type="button" data-usage-export-withdraw disabled={anyBusy || !actionable} onClick={() => { onConfirm('withdraw'); }} className={DANGER_GHOST_BUTTON}>
                {t('usage.export.action.withdraw')}
              </button>
            ) : null}
            <button type="button" data-usage-export-remove disabled={anyBusy || !actionable} onClick={() => { onConfirm('remove'); }} className={`ml-auto ${DANGER_GHOST_BUTTON}`}>
              {t('usage.export.action.remove')}
            </button>
          </div>

          {destination.target.kind === 'vibe' && destination.last_success_at !== null ? (
            <p data-usage-export-withdraw-note className="text-[11.5px] text-ink-faint">{t('usage.export.confirm.withdraw.unsupported')}</p>
          ) : null}

          {failure !== null ? <InlineError error={failure} /> : null}
        </div>
      </InlineEditor>
    </li>
  );
}

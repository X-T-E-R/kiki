/**
 * Settings › Workspaces › Worktrees: every Kiki-managed worktree with its
 * branch, owning session, state and last known changes. Removal always
 * inspects first and confirms any loss against those exact numbers; a
 * worktree whose session is still active cannot be removed. Clean up runs the
 * server's retention rules as a dry run first, then asks.
 */

import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Session } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { shortCwd } from '@kiki/session-core/sessions';
import { useI18n } from '../../i18n';
import {
  visibleWorktrees,
  worktreeApi,
  worktreeKeys,
  type WorktreeInspection,
  type WorktreeRecord,
  type WorktreeRemovalOutcome,
} from '../../lib/worktrees';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Hint, InlineError } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { WorktreeRemoveDialog, outcomeReasonKey } from './WorktreeRemoveDialog';
import { WorktreePolicy, useWorktreePolicy } from './WorktreePolicy';

type Notice =
  | { readonly tone: 'success' | 'info'; readonly text: string }
  | { readonly tone: 'error'; readonly text: string; readonly path?: string }
  | null;

type GcPlan = { readonly removable: number; readonly kept: number };

export function WorktreesCard() {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const available = client.klient.rest !== undefined;
  const afterDays = useWorktreePolicy().data?.cleanup.afterDays ?? 7;
  const list = useQuery({
    queryKey: worktreeKeys.list(),
    queryFn: () => worktreeApi(client).list(),
    enabled: available,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
  const records = useMemo(() => visibleWorktrees(list.data?.worktrees ?? []), [list.data]);
  const sessionIds = useMemo(() => [...new Set(records.map((record) => record.owner.sessionId))], [records]);
  const sessionQueries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ['worktrees', 'owner-session', id],
      queryFn: () => client.getSession(id),
      staleTime: 10_000,
      retry: false,
    })),
  });
  const sessions = new Map<string, { readonly session?: Session; readonly settled: boolean }>(
    sessionIds.map((id, index) => [id, { session: sessionQueries[index]?.data, settled: sessionQueries[index]?.isPending === false }]),
  );
  const [inspections, setInspections] = useState<ReadonlyMap<string, WorktreeInspection>>(new Map());
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorktreeRecord | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [gcBusy, setGcBusy] = useState(false);
  const [gcPlan, setGcPlan] = useState<GcPlan | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: worktreeKeys.all });
  };
  const remember = (id: string, inspection: WorktreeInspection) => {
    setInspections((current) => new Map(current).set(id, inspection));
  };

  const check = (record: WorktreeRecord) => {
    setChecking(record.id);
    setNotice(null);
    void worktreeApi(client).inspect(record.id)
      .then((inspection) => { remember(record.id, inspection); })
      .catch((error: unknown) => { setNotice({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setChecking(null); });
  };

  const planCleanup = () => {
    setGcBusy(true);
    setNotice(null);
    void worktreeApi(client).gc(true)
      .then(({ candidates }) => {
        const removable = candidates.filter((entry) => entry.outcome === 'removed').length;
        const kept = candidates.length - removable;
        if (removable > 0) setGcPlan({ removable, kept });
        else setNotice({ tone: 'info', text: kept === 0 ? t('st.worktrees.cleanupNone') : tp('st.worktrees.cleanupOnlyKept', kept) });
      })
      .catch((error: unknown) => { setNotice({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setGcBusy(false); });
  };

  const runCleanup = () => {
    setGcPlan(null);
    setGcBusy(true);
    void worktreeApi(client).gc(false)
      .then(({ candidates }) => {
        const removed = candidates.filter((entry) => entry.outcome === 'removed').length;
        setNotice({ tone: 'success', text: t('st.worktrees.cleanupResult', { removed, kept: candidates.length - removed }) });
        refresh();
      })
      .catch((error: unknown) => { setNotice({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setGcBusy(false); });
  };

  const onRemoved = (record: WorktreeRecord, outcome: WorktreeRemovalOutcome) => {
    setRemoving(null);
    setNotice(outcome === 'removed'
      ? { tone: 'success', text: t('st.worktrees.removed', { branch: record.branch }) }
      : { tone: 'error', text: t('st.worktrees.notRemoved', { branch: record.branch, reason: t(outcomeReasonKey(outcome)) }), path: record.path });
    refresh();
  };

  if (!available) return null;

  return (
    <SectionCard id="st-card-worktrees" title={t('st.worktrees.title')}>
      <div className="space-y-2">
        <Hint>{t('st.worktrees.hint')}</Hint>
        {list.isLoading ? <Hint>{t('st.worktrees.loading')}</Hint> : null}
        {list.isError ? <InlineError error={list.error} /> : null}
        {list.isSuccess && records.length === 0 ? (
          <p data-worktrees-empty className="rounded-lg border border-dashed border-hairline px-3 py-4 text-[12px] leading-relaxed text-ink-faint">
            {t('st.worktrees.empty')}
          </p>
        ) : null}
        {records.length > 0 ? (
          <ul data-worktree-list className="divide-y divide-hairline rounded-lg border border-hairline bg-paper">
            {records.map((record) => (
              <WorktreeRow
                key={record.id}
                record={record}
                owner={sessions.get(record.owner.sessionId)}
                inspection={inspections.get(record.id) ?? record.lastInspection}
                checking={checking === record.id}
                onCheck={() => { check(record); }}
                onRemove={() => { setNotice(null); setRemoving(record); }}
              />
            ))}
          </ul>
        ) : null}
        {notice !== null ? <WorktreeNotice notice={notice} /> : null}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 pt-1">
          <button
            type="button"
            data-worktrees-cleanup
            disabled={gcBusy || !list.isSuccess}
            onClick={planCleanup}
            className={`${SECONDARY_BUTTON} shrink-0`}
          >
            {gcBusy ? t('st.worktrees.cleanupChecking') : t('st.worktrees.cleanup')}
          </button>
          <p className="min-w-0 flex-1 basis-64 text-[12px] leading-snug text-ink-faint">{t('st.worktrees.cleanupRule', { days: afterDays })}</p>
        </div>
        <div className="pt-4">
          <WorktreePolicy />
        </div>
      </div>

      {removing !== null ? (
        <WorktreeRemoveDialog
          record={removing}
          onClose={() => { setRemoving(null); }}
          onInspected={(inspection) => { remember(removing.id, inspection); }}
          onDone={(outcome) => { onRemoved(removing, outcome); }}
        />
      ) : null}
      {gcPlan !== null ? (
        <ConfirmDialog
          open
          overlayId="confirm-worktree-cleanup"
          title={t('st.worktrees.cleanupConfirmTitle')}
          body={tp('st.worktrees.cleanupConfirmBody', gcPlan.removable)}
          consequences={gcPlan.kept > 0 ? [tp('st.worktrees.cleanupKeepCount', gcPlan.kept)] : undefined}
          confirmLabel={t('st.worktrees.cleanup')}
          tone="danger"
          onCancel={() => { setGcPlan(null); }}
          onConfirm={runCleanup}
        />
      ) : null}
    </SectionCard>
  );
}

function WorktreeNotice({ notice }: { notice: NonNullable<Notice> }) {
  const { t } = useI18n();
  const tone = notice.tone === 'error'
    ? 'border-danger/30 bg-danger/5 text-danger'
    : notice.tone === 'success'
      ? 'border-success/30 bg-success/5 text-success'
      : 'border-hairline bg-paper text-ink-soft';
  return (
    <div data-worktree-notice={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2.5 py-2 text-[12px] leading-snug ${tone}`}>
      <p>{notice.text}</p>
      {notice.tone === 'error' && notice.path !== undefined ? (
        <p data-worktree-kept-path className="mt-1 font-mono text-[11px] break-all text-ink-soft">
          {t('st.worktrees.keptAt', { path: notice.path })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The row's state word. A session that still exists and is not archived owns
 * the checkout ("In use"); an archived one says since when, which is what the
 * seven-day cleanup rule counts from.
 */
function stateLabel(
  t: ReturnType<typeof useI18n>['t'],
  time: ReturnType<typeof useI18n>['time'],
  record: WorktreeRecord,
  owner: Session | undefined,
): { readonly text: string; readonly tone: 'soft' | 'faint' | 'danger' } {
  if (record.state === 'remove_failed') return { text: t('st.worktrees.state.failed'), tone: 'danger' };
  if (record.state === 'creating') return { text: t('st.worktrees.state.creating'), tone: 'faint' };
  if (record.state === 'removing') return { text: t('st.worktrees.state.removing'), tone: 'faint' };
  if (record.state === 'orphaned') return { text: t('st.worktrees.state.orphaned'), tone: 'faint' };
  if (owner !== undefined && owner.archived !== true) return { text: t('st.worktrees.state.inUse'), tone: 'soft' };
  if (owner !== undefined) {
    return { text: t('st.worktrees.state.archived', { time: time.relativeTime(owner.archived_at ?? owner.updated_at) }), tone: 'faint' };
  }
  return { text: t('st.worktrees.state.ready'), tone: 'faint' };
}

function ChangesLine({ inspection }: { inspection: WorktreeInspection | undefined }) {
  const { t, tp } = useI18n();
  if (inspection === undefined) return <span className="text-ink-faint">{t('st.worktrees.notChecked')}</span>;
  if (inspection.failed) return <span className="text-amber-ink">{t('st.worktrees.checkFailed')}</span>;
  const parts: string[] = [];
  if (inspection.dirtyFiles > 0) parts.push(tp('st.worktrees.dirty', inspection.dirtyFiles));
  if (inspection.unpushedCommits > 0) parts.push(tp('st.worktrees.unpushed', inspection.unpushedCommits));
  if (parts.length === 0 && inspection.ignoredNonDisposable.length === 0) {
    return <span data-worktree-changes="clean" className="text-ink-faint">{t('st.worktrees.clean')}</span>;
  }
  const ignored = inspection.ignoredNonDisposable;
  const full = [...parts, ...(ignored.length > 0 ? [t('st.worktrees.ignored', { names: ignored.slice(0, 5).join(', ') })] : [])];
  const short = [...parts, ...(ignored.length > 0 ? [t('st.worktrees.ignoredShort', { names: ignored.slice(0, 2).join(', ') })] : [])];
  return (
    <span data-worktree-changes="dirty" title={full.join('\n')} className="font-medium text-amber-ink">
      {short.join(', ')}
    </span>
  );
}

function WorktreeRow({
  record,
  owner,
  inspection,
  checking,
  onCheck,
  onRemove,
}: {
  record: WorktreeRecord;
  owner: { readonly session?: Session; readonly settled: boolean } | undefined;
  inspection: WorktreeInspection | undefined;
  checking: boolean;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const { t, time } = useI18n();
  const navigate = useGuardedNavigate();
  const session = owner?.session;
  const state = stateLabel(t, time, record, session);
  const inUse = session !== undefined && session.archived !== true;
  const ownerPending = owner?.settled !== true;
  const busy = record.state === 'creating' || record.state === 'removing';
  const title = session === undefined ? undefined : (session.title !== '' ? session.title : t('sidebar.untitled'));
  const removeDisabled = inUse || ownerPending || busy;
  const stateClass = state.tone === 'danger' ? 'text-danger' : state.tone === 'soft' ? 'text-ink-soft' : 'text-ink-faint';
  const inUseId = `worktree-in-use-${record.id}`;
  return (
    <li data-worktree-row={record.id} data-worktree-state={record.state} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex min-w-0 items-baseline gap-2" title={`${record.branch}\n${record.repo.sourceRoot} @ ${record.base.ref}`}>
          <span className="flex min-w-0 items-center gap-1.5 self-center text-[13px] text-ink">
            <Icon name="branch" size={12} className="text-ink-faint" />
            <span className="min-w-0 truncate font-mono text-[12.5px]">{record.branch}</span>
          </span>
          <span data-worktree-state-label className={`shrink-0 text-[11.5px] ${stateClass}`}>{state.text}</span>
        </p>
        <p className="flex min-w-0 items-center gap-x-1.5 text-[12px] leading-5 text-ink-faint">
          {title !== undefined ? (
            <button
              type="button"
              data-worktree-session
              onClick={() => { navigate(`/s/${session!.id}`); }}
              aria-label={t('st.worktrees.openSessionAria', { title })}
              className="min-w-0 max-w-[45%] shrink-[3] truncate rounded-sm text-ink-soft underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {title}
            </button>
          ) : ownerPending ? null : (
            <span className="shrink-0">{t('st.worktrees.sessionMissing')}</span>
          )}
          {title !== undefined || !ownerPending ? <span aria-hidden>·</span> : null}
          <span className="min-w-0 shrink truncate"><ChangesLine inspection={inspection} /></span>
          {/* Narrow rows keep the facts that decide an action; the source rides the row tooltip. */}
          <span aria-hidden className="hidden sm:inline">·</span>
          <span className="hidden min-w-0 shrink-[2] truncate sm:inline" title={record.repo.sourceRoot}>{shortCwd(record.repo.sourceRoot)}</span>
        </p>
        {record.state === 'remove_failed' ? (
          <div data-worktree-kept-path className="mt-1 border-l-2 border-danger/60 pl-2">
            {record.removal !== undefined ? (
              <p className="text-[12px] leading-5 text-danger">{t(outcomeReasonKey(record.removal.outcome))}</p>
            ) : null}
            <p className="font-mono text-[11px] leading-4 break-all text-ink-soft">{t('st.worktrees.keptAt', { path: record.path })}</p>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          data-worktree-check
          disabled={checking || busy}
          onClick={onCheck}
          aria-label={t('st.worktrees.checkAria', { branch: record.branch })}
          className={SECONDARY_BUTTON}
        >
          {checking ? t('st.worktrees.checking') : t('st.worktrees.check')}
        </button>
        {/* A disabled button fires no hover in some engines; the wrapper carries the tooltip. */}
        <span title={inUse ? t('st.worktrees.removeInUse') : undefined} className="inline-flex">
          <button
            type="button"
            data-worktree-remove
            disabled={removeDisabled}
            onClick={onRemove}
            aria-label={t('st.worktrees.removeAria', { branch: record.branch })}
            aria-describedby={inUse ? inUseId : undefined}
            className={SECONDARY_BUTTON}
          >
            {t('st.worktrees.remove')}
          </button>
        </span>
        {inUse ? <span id={inUseId} data-worktree-in-use className="sr-only">{t('st.worktrees.removeInUse')}</span> : null}
      </div>
    </li>
  );
}

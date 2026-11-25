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
import { compactSessionId } from '../../lib/compactIdentifier';
import { useThreadTitle } from '../../lib/threadTitles';
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
import { SectionCard } from './SectionCard';
import { WorktreeRemoveDialog, outcomeReasonKey } from './WorktreeRemoveDialog';
import { WorktreePolicy, useWorktreePolicy } from './WorktreePolicy';

type Notice =
  | { readonly tone: 'success' | 'info'; readonly text: string }
  | { readonly tone: 'error'; readonly text: string; readonly path?: string }
  | null;

type GcPlan = { readonly removable: number; readonly kept: number };

const WORKTREE_SESSION_FETCH_CONCURRENCY = 2;

const ROW_ACTION =
  'inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-[13px] leading-5 text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ink-soft pointer-coarse:h-11 pointer-coarse:px-3';

const ROW_REMOVE_ACTION =
  'inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-[13px] leading-5 text-ink-soft transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-ink-soft pointer-coarse:h-11 pointer-coarse:px-3';

function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => { waiting.push(resolve); });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

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
  const limitSessionFetch = useMemo(() => createConcurrencyLimiter(WORKTREE_SESSION_FETCH_CONCURRENCY), [client]);
  const sessionQueries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ['worktrees', 'owner-session', id],
      queryFn: () => limitSessionFetch(() => client.getSession(id)),
      enabled: available,
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
  const [helpOpen, setHelpOpen] = useState(false);

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
      <div className="space-y-2.5">
        {list.isLoading ? <Hint>{t('st.worktrees.loading')}</Hint> : null}
        {list.isError ? <InlineError error={list.error} /> : null}
        {list.isSuccess && records.length === 0 ? (
          <p data-worktrees-empty className="py-1 text-[13px] leading-5 text-ink-faint">
            {t('st.worktrees.empty')}
          </p>
        ) : null}
        {records.length > 0 ? (
          <ul data-worktree-list className="divide-y divide-hairline border-y border-hairline">
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
        {records.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <button
                type="button"
                data-worktrees-cleanup
                disabled={gcBusy || !list.isSuccess}
                onClick={planCleanup}
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-ink/[0.05] px-3 text-[13px] leading-5 font-normal text-ink transition-colors hover:bg-ink/[0.09] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11"
              >
                {gcBusy ? t('st.worktrees.cleanupChecking') : t('st.worktrees.cleanup')}
              </button>
              <button
                type="button"
                data-worktrees-help-toggle
                aria-expanded={helpOpen}
                aria-controls="worktrees-help-panel"
                onClick={() => { setHelpOpen((open) => !open); }}
                className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 text-[12px] leading-4 font-normal text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:h-11"
              >
                <Icon
                  name="chevron"
                  size={12}
                  className={`shrink-0 text-ink-faint transition-transform duration-[var(--kiki-motion-quick)] ease-out motion-reduce:transition-none ${helpOpen ? 'rotate-90' : ''}`}
                />
                <span>{t('st.help.label')}</span>
              </button>
            </div>
            {helpOpen ? (
              <div
                id="worktrees-help-panel"
                data-worktrees-help-body
                className="max-w-[60ch] space-y-1.5 border-l-2 border-hairline pl-3 text-[12px] leading-4 text-ink-soft"
              >
                <p>{t('st.worktrees.cleanupRule', { days: afterDays })}</p>
                <p className="text-ink-faint">{t('st.worktrees.hint')}</p>
              </div>
            ) : null}
          </div>
        ) : null}
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
    ? 'border-danger bg-danger/5 text-danger'
    : notice.tone === 'success'
      ? 'border-success bg-success/5 text-success'
      : 'border-hairline-strong bg-ink/[0.03] text-ink-soft';
  return (
    <div
      data-worktree-notice={notice.tone}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`rounded-r-md border-l-2 px-3 py-2 text-[12px] leading-4 ${tone}`}
    >
      <p>{notice.text}</p>
      {notice.tone === 'error' && notice.path !== undefined ? (
        <p data-worktree-kept-path className="mt-1 font-mono text-[12px] leading-4 break-all text-ink-soft">
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
): { readonly text: string; readonly tone: 'active' | 'faint' | 'danger' } {
  if (record.state === 'remove_failed') return { text: t('st.worktrees.state.failed'), tone: 'danger' };
  if (record.state === 'creating') return { text: t('st.worktrees.state.creating'), tone: 'faint' };
  if (record.state === 'removing') return { text: t('st.worktrees.state.removing'), tone: 'faint' };
  if (record.state === 'orphaned') return { text: t('st.worktrees.state.orphaned'), tone: 'faint' };
  if (owner !== undefined && owner.archived !== true) return { text: t('st.worktrees.state.inUse'), tone: 'active' };
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
    <span data-worktree-changes="dirty" title={full.join('\n')} className="font-normal text-amber-ink">
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
  const shownTitle = useThreadTitle(session?.title || t('sidebar.untitled'));
  const title = session === undefined ? undefined : shownTitle;
  const removeDisabled = inUse || ownerPending || busy;
  const stateClass = state.tone === 'danger'
    ? 'rounded-full bg-danger/10 px-2 py-0.5 text-[12px] font-normal leading-4 text-danger'
    : state.tone === 'active'
      ? 'rounded-full bg-selected-ink/[0.09] px-2 py-0.5 text-[12px] font-normal leading-4 text-selected-ink'
      : 'text-[12px] leading-4 tabular-nums text-ink-faint';
  const inUseId = `worktree-in-use-${record.id}`;
  return (
    <li
      data-worktree-row={record.id}
      data-worktree-state={record.state}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2.5 transition-colors hover:bg-ink/[0.02]"
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1" title={`${record.branch}\n${record.repo.sourceRoot} @ ${record.base.ref}`}>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-ink">
            <Icon name="branch" size={12} className="shrink-0 text-ink-faint" />
            <span className="min-w-0 truncate font-mono text-[13px] leading-5">{record.branch}</span>
          </span>
          <span data-worktree-state-label className={`shrink-0 ${stateClass}`}>{state.text}</span>
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-x-1.5 text-[12px] leading-5 text-ink-faint">
          {title !== undefined ? (
            <button
              type="button"
              data-worktree-session
              onClick={() => { void navigate(`/s/${session!.id}`); }}
              aria-label={t('st.worktrees.openSessionAria', { title })}
              className="min-w-0 max-w-[45%] shrink-[3] truncate rounded-sm text-ink-soft underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            >
              {title}
            </button>
          ) : ownerPending ? null : (
            <span
              data-worktree-session-missing
              title={record.owner.sessionId}
              className="shrink-0"
            >
              {t('st.worktrees.sessionMissing')}{record.owner.sessionId ? ` (${compactSessionId(record.owner.sessionId)})` : ''}
            </span>
          )}
          {title !== undefined || !ownerPending ? <span aria-hidden>·</span> : null}
          <span className="min-w-0 shrink truncate"><ChangesLine inspection={inspection} /></span>
          {/* Narrow rows keep the facts that decide an action; the source rides the row tooltip. */}
          <span aria-hidden className="hidden sm:inline">·</span>
          <span className="hidden min-w-0 shrink-[2] truncate sm:inline" title={record.repo.sourceRoot}>{shortCwd(record.repo.sourceRoot)}</span>
        </p>
        {record.state === 'remove_failed' ? (
          <div data-worktree-kept-path className="mt-1.5 border-l-2 border-danger/60 pl-2">
            {record.removal !== undefined ? (
              <p className="text-[12px] leading-5 text-danger">{t(outcomeReasonKey(record.removal.outcome))}</p>
            ) : null}
            <p className="font-mono text-[12px] leading-4 break-all text-ink-soft">{t('st.worktrees.keptAt', { path: record.path })}</p>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-worktree-check
          disabled={checking || busy}
          onClick={onCheck}
          aria-label={t('st.worktrees.checkAria', { branch: record.branch })}
          className={ROW_ACTION}
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
            className={ROW_REMOVE_ACTION}
          >
            {t('st.worktrees.remove')}
          </button>
        </span>
        {inUse ? <span id={inUseId} data-worktree-in-use className="sr-only">{t('st.worktrees.removeInUse')}</span> : null}
      </div>
    </li>
  );
}

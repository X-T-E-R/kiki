/**
 * GoalCard — the session goal's detail, grown inside the composer card (see
 * ComposerHeader; the row summary itself is GoalHeaderSummary):
 *
 *   - the objective in full, its status word and the follow-up condition
 *     (plus the completion criterion when one is set);
 *   - the controls in plain view: Edit, Pause/Resume (by status), and a
 *     two-step Cancel (first click arms, second confirms — same idiom as the
 *     queue strip's remove);
 *   - Edit opens an inline form (objective, completion criterion, follow-up
 *     timing). Opening it first pulls the authoritative snapshot so the save
 *     rides the real goalId + controlRevision; a revision conflict (40001)
 *     reloads the form with the latest values and says so inline instead of
 *     failing silently;
 *   - a completed goal needs no control surface, so the composer row drops it
 *     and leaves the timeline record to speak (`goalShowsInHeader`).
 *
 * RecoveryHoldBar — the cold-recovery gate: after a server restart a restored
 * queue stays parked until someone confirms; this slim bar above the composer
 * is that confirmation ("queue restored, resume?"). The Later dismiss
 * collapses the explanation into a compact one-line resume button — it keeps
 * the queue parked and the entry visible until the hold actually clears.
 */

import { useEffect, useRef, useState } from 'react';

import type { GoalFollowUpTiming, GoalSnapshot } from '@kiki/protocol';

import { API_CODES, ApiError } from '../lib/client';
import type { UpdateAgentGoalInput } from '../lib/client';
import { useI18n } from '../i18n';
import { Icon } from './icons';
import { LifeMark } from './LifeMark';

/** The armed cancel falls back to idle after this long without the second click. */
const CANCEL_ARM_TIMEOUT_MS = 5_000;

const GOAL_FOLLOW_UP_TIMINGS: readonly GoalFollowUpTiming[] = ['subagents_done', 'tasks_done'];

const GOAL_TIMING_LABEL_KEY = {
  subagents_done: 'timing.subagentsDone',
  tasks_done: 'timing.tasksDone',
} as const;

/** A completed goal leaves the composer row; every other goal gets its half. */
export function goalShowsInHeader(goal: GoalSnapshot | null | undefined): goal is GoalSnapshot {
  return goal !== undefined && goal !== null && goal.status !== 'complete';
}

/**
 * The goal half of the composer's top row: LifeMark, the objective on one
 * truncated line (visible at every width), and the status word. Accent only
 * while a blocked goal waits on the user: the mark and the word "blocked".
 */
export function GoalHeaderSummary({ goal }: { readonly goal: GoalSnapshot }) {
  const { t } = useI18n();
  const statusTone =
    goal.status === 'blocked' ? 'text-accent-ink' : goal.status === 'paused' ? 'text-amber-ink' : 'text-ink-faint';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="flex w-[7px] shrink-0 justify-center">
        {goal.status === 'active' ? <LifeMark markId="goal-row" life="working" still /> : null}
        {goal.status === 'blocked' ? <LifeMark markId="goal-row" life="waiting" /> : null}
      </span>
      <span data-goal-title className="min-w-0 truncate text-ink">{goal.objective}</span>
      <span data-goal-status-word className={`shrink-0 ${statusTone}`}>
        {t(`composer.goalStatus.${goal.status}`)}
      </span>
    </span>
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GoalCard({
  goal,
  onRefresh,
  onUpdate,
  onPause,
  onResume,
  onCancel,
}: {
  /** Projected goal (display truth); ids/revisions come from `onRefresh`. */
  readonly goal: GoalSnapshot;
  /** Pull the authoritative snapshot (real goalId + controlRevision). */
  readonly onRefresh: () => Promise<GoalSnapshot | null>;
  readonly onUpdate: (input: UpdateAgentGoalInput) => Promise<GoalSnapshot>;
  readonly onPause: () => Promise<unknown>;
  readonly onResume: () => Promise<unknown>;
  readonly onCancel: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState('');
  const [criterion, setCriterion] = useState('');
  const [followUpTiming, setFollowUpTiming] = useState<GoalFollowUpTiming>('subagents_done');
  const [baseline, setBaseline] = useState<{ goalId: string; controlRevision?: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<'refresh' | 'save' | 'pause' | 'resume' | 'cancel' | null>(null);
  const [armedResume, setArmedResume] = useState(false);
  const [armedCancel, setArmedCancel] = useState(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
      if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
    },
    [],
  );

  const seedForm = (snapshot: GoalSnapshot) => {
    setObjective(snapshot.objective);
    setCriterion(snapshot.completionCriterion ?? '');
    setFollowUpTiming(snapshot.followUpTiming ?? 'subagents_done');
  };

  const openEditor = () => {
    setActionError(null);
    setConflict(false);
    setEditing(true);
    setPending('refresh');
    seedForm(goal);
    void onRefresh()
      .then((snapshot) => {
        if (snapshot === null) {
          setActionError(errorDetail(new Error('no goal')));
          setEditing(false);
          return;
        }
        setBaseline({ goalId: snapshot.goalId, controlRevision: snapshot.controlRevision });
        seedForm(snapshot);
      })
      .catch((error: unknown) => {
        setActionError(errorDetail(error));
        setEditing(false);
      })
      .finally(() => {
        setPending(null);
      });
  };

  const save = () => {
    if (baseline === null || pending !== null) return;
    const trimmed = objective.trim();
    if (trimmed === '') return;
    setPending('save');
    setActionError(null);
    void onUpdate({
      goalId: baseline.goalId,
      expectedRevision: baseline.controlRevision,
      objective: trimmed,
      completionCriterion: criterion.trim() === '' ? null : criterion.trim(),
      followUpTiming,
    })
      .then(() => {
        setEditing(false);
        setConflict(false);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === API_CODES.REQUEST_INVALID) {
          // Version conflict: reload the form from the authoritative snapshot
          // and let the user review before saving again.
          setConflict(true);
          void onRefresh()
            .then((snapshot) => {
              if (snapshot !== null) {
                setBaseline({ goalId: snapshot.goalId, controlRevision: snapshot.controlRevision });
                seedForm(snapshot);
              }
            })
            .catch(() => undefined);
          return;
        }
        setActionError(errorDetail(error));
      })
      .finally(() => {
        setPending(null);
      });
  };

  const act = (kind: 'pause' | 'resume' | 'cancel', action: () => Promise<unknown>) => {
    if (pending !== null) return;
    setPending(kind);
    setActionError(null);
    void action()
      .catch((error: unknown) => {
        setActionError(errorDetail(error));
      })
      .finally(() => {
        setPending(null);
      });
  };

  const clickResume = () => {
    if (goal.status !== 'blocked') {
      act('resume', onResume);
      return;
    }
    if (!armedResume) {
      setArmedResume(true);
      if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = setTimeout(() => { setArmedResume(false); }, CANCEL_ARM_TIMEOUT_MS);
      return;
    }
    if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
    setArmedResume(false);
    act('resume', onResume);
  };

  const clickCancel = () => {
    if (!armedCancel) {
      setArmedCancel(true);
      if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = setTimeout(() => { setArmedCancel(false); }, CANCEL_ARM_TIMEOUT_MS);
      return;
    }
    if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
    setArmedCancel(false);
    act('cancel', onCancel);
  };

  if (goal.status === 'complete') return null;

  const busy = pending !== null;
  const timingLabel =
    goal.followUpTiming !== undefined ? t(GOAL_TIMING_LABEL_KEY[goal.followUpTiming]) : undefined;

  const actionClass =
    'h-6 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none';
  const statusTone =
    goal.status === 'active' ? 'text-ink-faint' : goal.status === 'paused' ? 'text-amber-ink' : 'text-accent-ink';
  const followUp = timingLabel !== undefined ? t('goal.followUp', { timing: timingLabel }) : undefined;

  return (
    <section
      data-goal-card
      data-goal-status={goal.status}
      aria-label={t('goal.cardAria')}
      className="px-1.5 pt-1.5"
    >
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        {/* The row below already carries the status mark; the detail aligns
            its full objective with the row's title instead of repeating it. */}
        <span aria-hidden className="w-[7px] shrink-0" />
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-[13px] leading-5 break-words text-ink">{goal.objective}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint">
            <span className={statusTone}>{t(`composer.goalStatus.${goal.status}`)}</span>
            {followUp !== undefined ? <span>{followUp}</span> : null}
            {goal.completionCriterion !== undefined && goal.completionCriterion !== '' ? (
              <span className="min-w-0 truncate" title={goal.completionCriterion}>
                {t('goal.doneWhen', { criterion: goal.completionCriterion })}
              </span>
            ) : null}
          </p>
        </div>
        {editing ? null : (
          <span data-goal-actions className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={openEditor}
              title={t('goal.editTitle')}
              className={actionClass}
            >
              {t('goal.edit')}
            </button>
            {goal.status === 'active' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => { act('pause', onPause); }}
                title={t('goal.pauseTitle')}
                className={actionClass}
              >
                {t('goal.pause')}
              </button>
            ) : null}
            {goal.status === 'paused' || goal.status === 'blocked' ? (
              <button
                type="button"
                disabled={busy}
                onClick={clickResume}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && armedResume) {
                    event.preventDefault();
                    event.stopPropagation();
                    setArmedResume(false);
                  }
                }}
                title={
                  armedResume
                    ? t('goal.resumeConfirm')
                    : goal.status === 'blocked'
                      ? t('goal.resumeBlockedTitle')
                      : t('goal.resumeTitle')
                }
                className={armedResume ? `${actionClass} bg-ink/[0.05] text-ink` : actionClass}
              >
                {armedResume ? t('goal.resumeConfirm') : t('goal.resume')}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={clickCancel}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && armedCancel) {
                  event.preventDefault();
                  event.stopPropagation();
                  setArmedCancel(false);
                }
              }}
              title={armedCancel ? t('goal.cancelConfirm') : t('goal.cancelTitle')}
              className={`h-6 rounded-md px-1.5 text-[12px] font-medium transition-colors duration-[var(--kiki-motion-quick)] disabled:opacity-50 focus-visible:ring-2 focus-visible:outline-none ${
                armedCancel
                  ? 'bg-danger/10 text-danger hover:bg-danger/15 focus-visible:ring-danger/50'
                  : 'text-ink-soft hover:bg-danger/10 hover:text-danger focus-visible:ring-selected-ink/50'
              }`}
            >
              {armedCancel ? t('goal.cancelConfirm') : t('goal.cancel')}
            </button>
          </span>
        )}
      </div>
        {editing ? (
          <div className="mt-2 space-y-2 pb-1 pl-[15px]" data-goal-editor>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                {t('goal.editObjective')}
              </span>
              <textarea
                value={objective}
                onChange={(event) => { setObjective(event.target.value); }}
                rows={2}
                disabled={pending === 'refresh' || pending === 'save'}
                className="w-full resize-none rounded-lg border border-hairline bg-panel px-2 py-1 text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                {t('goal.editCriterion')}
              </span>
              <input
                value={criterion}
                onChange={(event) => { setCriterion(event.target.value); }}
                disabled={pending === 'refresh' || pending === 'save'}
                className="w-full rounded-lg border border-hairline bg-panel px-2 py-1 text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-ink-soft">
                {t('goal.editTiming')}
              </span>
              <span
                role="radiogroup"
                aria-label={t('goal.editTiming')}
                className="flex items-center gap-0.5 rounded-lg bg-ink/[0.04] p-0.5"
              >
                {GOAL_FOLLOW_UP_TIMINGS.map((timing) => (
                  <button
                    key={timing}
                    type="button"
                    role="radio"
                    aria-checked={timing === followUpTiming}
                    data-goal-timing={timing}
                    onClick={() => { setFollowUpTiming(timing); }}
                    className={`h-6 rounded-md px-2 text-[12px] transition-colors duration-[var(--kiki-motion-quick)] focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none ${
                      timing === followUpTiming ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
                    }`}
                  >
                    {t(GOAL_TIMING_LABEL_KEY[timing])}
                  </button>
                ))}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setConflict(false);
                    setActionError(null);
                  }}
                  disabled={pending === 'save'}
                  className="h-7 rounded-md px-2.5 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={pending !== null || objective.trim() === ''}
                  data-goal-save
                  className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
                >
                  {t('common.save')}
                </button>
              </span>
            </div>
            {conflict ? (
              <p role="status" data-goal-conflict className="text-[12px] text-amber-ink">
                {t('goal.conflict')}
              </p>
            ) : null}
          </div>
        ) : null}
        {actionError !== null ? (
          <p role="alert" data-goal-error className="mt-1 pb-1 pl-[15px] break-words text-[12px] text-danger">
            {t('goal.actionFailed', { detail: actionError })}
          </p>
        ) : null}
    </section>
  );
}

export function RecoveryHoldBar({
  count,
  pending,
  onConfirm,
}: {
  readonly count: number;
  readonly pending: boolean;
  readonly onConfirm: () => void;
}) {
  const { t, tp } = useI18n();
  const [compact, setCompact] = useState(false);
  if (compact) {
    return (
      <div className="px-6 pb-1.5" data-recovery-hold-wrapper>
        <div
          data-recovery-hold-compact
          role="status"
          aria-label={t('sv.queueRecovered.title')}
          className="anim-enter mx-auto flex max-w-[var(--kiki-chat-content-width,760px)] items-center justify-end gap-2"
        >
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
          >
            {t('sv.queueRecovered.confirm')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="px-6 pb-2" data-recovery-hold-wrapper>
      <div className="mx-auto max-w-[var(--kiki-chat-content-width,760px)]">
      <section
        data-recovery-hold
        role="status"
        aria-label={t('sv.queueRecovered.title')}
        className="anim-enter rounded-[10px] border border-hairline bg-canvas py-1 pr-1 pl-3"
      >
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <Icon name="hold" size={14} className="text-ink-faint" />
          <span className="min-w-0 flex-1 text-[13px] text-ink-soft">
            {tp('sv.queueRecovered.body', count)}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
          >
            {t('sv.queueRecovered.confirm')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setCompact(true)}
            className="h-7 shrink-0 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
          >
            {t('sv.queueRecovered.dismiss')}
          </button>
        </div>
      </section>
      </div>
    </div>
  );
}

/**
 * GoalCard — the session goal as a persistent card floating above the composer
 * (rendered in the dock slot, over the queue strip):
 *
 *   - header row: ◎ marker, status pill (active / paused / blocked), the
 *     objective (two-line clamp, full text on hover), and the follow-up timing
 *     when the server reports one;
 *   - actions on the right: Edit, Pause/Resume (by status), and a two-step
 *     Cancel (first click arms, second confirms — same idiom as the queue
 *     strip's remove);
 *   - Edit opens an inline form (objective, completion criterion, follow-up
 *     timing). Opening it first pulls the authoritative snapshot so the save
 *     rides the real goalId + controlRevision; a revision conflict (40001)
 *     reloads the form with the latest values and says so inline instead of
 *     failing silently;
 *   - a completed goal needs no control surface, so the card hides itself and
 *     leaves the timeline record to speak.
 *
 * RecoveryHoldBar — the cold-recovery gate: after a server restart a restored
 * queue stays parked until someone confirms; this slim bar above the queue
 * strip is that confirmation ("queue restored, resume?"), with a Later
 * dismiss that keeps the queue parked.
 */

import { useEffect, useRef, useState } from 'react';

import type { GoalFollowUpTiming, GoalSnapshot } from '@kiki/protocol';

import { API_CODES, ApiError } from '../lib/client';
import type { UpdateAgentGoalInput } from '../lib/client';
import { useI18n } from '../i18n';

/** The armed cancel falls back to idle after this long without the second click. */
const CANCEL_ARM_TIMEOUT_MS = 5_000;

const GOAL_FOLLOW_UP_TIMINGS: readonly GoalFollowUpTiming[] = ['subagents_done', 'tasks_done'];

const GOAL_TIMING_LABEL_KEY = {
  subagents_done: 'timing.subagentsDone',
  tasks_done: 'timing.tasksDone',
} as const;

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
  const [armedCancel, setArmedCancel] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
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

  const clickCancel = () => {
    if (!armedCancel) {
      setArmedCancel(true);
      if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => { setArmedCancel(false); }, CANCEL_ARM_TIMEOUT_MS);
      return;
    }
    if (armTimerRef.current !== null) clearTimeout(armTimerRef.current);
    setArmedCancel(false);
    act('cancel', onCancel);
  };

  if (goal.status === 'complete') return null;

  const busy = pending !== null;
  const timingLabel =
    goal.followUpTiming !== undefined ? t(GOAL_TIMING_LABEL_KEY[goal.followUpTiming]) : undefined;

  return (
    <div className="px-6 pb-1.5" data-goal-card-wrapper>
      <section
        data-goal-card
        aria-label={t('goal.cardAria')}
        className="anim-enter mx-auto max-w-[760px] rounded-xl border border-accent/35 bg-panel px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden className="shrink-0 text-[12px] text-accent">
            ◎
          </span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-semibold tracking-[0.04em] uppercase ${
              goal.status === 'active'
                ? 'bg-accent/15 text-accent'
                : goal.status === 'paused'
                  ? 'bg-amber-rule/25 text-amber-ink'
                  : 'bg-danger/10 text-danger'
            }`}
          >
            {t(`composer.goalStatus.${goal.status}`)}
          </span>
          <span
            title={goal.objective}
            className="min-w-0 flex-1 truncate text-[12px] text-ink"
          >
            {goal.objective}
          </span>
          {timingLabel !== undefined ? (
            <span className="hidden shrink-0 text-[10px] text-ink-faint sm:inline">
              {t('goal.followUp', { timing: timingLabel })}
            </span>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={openEditor}
              title={t('goal.editTitle')}
              className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
            >
              {t('goal.edit')}
            </button>
            {goal.status === 'active' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => { act('pause', onPause); }}
                title={t('goal.pauseTitle')}
                className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
              >
                {t('goal.pause')}
              </button>
            ) : null}
            {goal.status === 'paused' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => { act('resume', onResume); }}
                title={t('goal.resumeTitle')}
                className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
              >
                {t('goal.resume')}
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={clickCancel}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && armedCancel) {
                  event.preventDefault();
                  setArmedCancel(false);
                }
              }}
              title={armedCancel ? t('goal.cancelConfirm') : t('goal.cancelTitle')}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:outline-none ${
                armedCancel
                  ? 'border-danger/60 bg-danger/10 text-danger hover:bg-danger/20 focus-visible:ring-danger/50'
                  : 'border-hairline text-ink-soft hover:border-danger/60 hover:text-danger focus-visible:ring-accent/50'
              }`}
            >
              {armedCancel ? t('goal.cancelConfirm') : t('goal.cancel')}
            </button>
          </span>
        </div>
        {editing ? (
          <div className="mt-2 space-y-1.5 border-t border-hairline/70 pt-2" data-goal-editor>
            <label className="block">
              <span className="mb-0.5 block text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                {t('goal.editObjective')}
              </span>
              <textarea
                value={objective}
                onChange={(event) => { setObjective(event.target.value); }}
                rows={2}
                disabled={pending === 'refresh' || pending === 'save'}
                className="w-full resize-none rounded-lg border border-hairline bg-paper px-2 py-1 text-[12px] text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="mb-0.5 block text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                {t('goal.editCriterion')}
              </span>
              <input
                value={criterion}
                onChange={(event) => { setCriterion(event.target.value); }}
                disabled={pending === 'refresh' || pending === 'save'}
                className="w-full rounded-lg border border-hairline bg-paper px-2 py-1 text-[12px] text-ink focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                {t('goal.editTiming')}
              </span>
              <span
                role="radiogroup"
                aria-label={t('goal.editTiming')}
                className="flex items-center gap-0.5 rounded-full border border-hairline bg-paper p-0.5"
              >
                {GOAL_FOLLOW_UP_TIMINGS.map((timing) => (
                  <button
                    key={timing}
                    type="button"
                    role="radio"
                    aria-checked={timing === followUpTiming}
                    data-goal-timing={timing}
                    onClick={() => { setFollowUpTiming(timing); }}
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none ${
                      timing === followUpTiming ? 'bg-accent text-white' : 'text-ink-soft hover:bg-hairline/60'
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
                  className="rounded-full border border-hairline px-2.5 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={pending !== null || objective.trim() === ''}
                  data-goal-save
                  className="rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
                >
                  {t('common.save')}
                </button>
              </span>
            </div>
            {conflict ? (
              <p role="status" data-goal-conflict className="text-[11px] text-amber-ink">
                {t('goal.conflict')}
              </p>
            ) : null}
          </div>
        ) : null}
        {actionError !== null ? (
          <p role="alert" data-goal-error className="mt-1.5 break-words text-[11px] text-danger">
            {t('goal.actionFailed', { detail: actionError })}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function RecoveryHoldBar({
  count,
  pending,
  onConfirm,
  onDismiss,
}: {
  readonly count: number;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  const { t, tp } = useI18n();
  return (
    <div className="px-6 pb-1.5" data-recovery-hold-wrapper>
      <section
        data-recovery-hold
        role="status"
        aria-label={t('sv.queueRecovered.title')}
        className="anim-enter mx-auto max-w-[760px] rounded-xl border border-hairline bg-panel px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className="shrink-0 text-[11px] text-ink-faint">
            ◔
          </span>
          <span className="min-w-0 flex-1 text-[11.5px] text-ink-soft">
            {tp('sv.queueRecovered.body', count)}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-medium text-white transition-colors hover:bg-accent/85 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
          >
            {t('sv.queueRecovered.confirm')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onDismiss}
            className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:outline-none"
          >
            {t('sv.queueRecovered.dismiss')}
          </button>
        </div>
      </section>
    </div>
  );
}

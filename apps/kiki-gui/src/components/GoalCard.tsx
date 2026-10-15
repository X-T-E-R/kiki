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
 *     timing, and optional hard budgets). Opening it first pulls the authoritative snapshot so the save
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

import type { GoalBudgetPatch, GoalFollowUpTiming, GoalSnapshot } from '@kiki/protocol';

import { API_CODES, ApiError } from '../lib/client';
import type { UpdateAgentGoalInput } from '../lib/client';
import { useI18n } from '../i18n';
import { DisclosureChevron, Icon, Spinner } from './icons';
import { InlineEditor } from './InlineEditor';
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

function budgetField(value: number | null, divisor = 1): string {
  return value === null ? '' : String(value / divisor);
}

export function GoalPauseButton({ onPause }: { readonly onPause: () => Promise<unknown> }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        data-goal-pause
        disabled={pending}
        aria-busy={pending}
        title={t('goal.pauseTitle')}
        className="h-6 shrink-0 rounded-md px-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
        onClick={() => {
          if (pending) return;
          setPending(true);
          setError(null);
          void onPause().catch((cause: unknown) => {
            setError(errorDetail(cause));
          }).finally(() => { setPending(false); });
        }}
      >
        <span className="flex items-center gap-1">{pending ? <Spinner label={t('goal.pause')} size={12} /> : null}{t('goal.pause')}</span>
      </button>
      {error === null ? null : <span role="alert" data-goal-error className="max-w-56 text-[12px] text-danger">{t('goal.actionFailed', { detail: error })}</span>}
    </span>
  );
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
  const [tokenBudget, setTokenBudget] = useState('');
  const [turnBudget, setTurnBudget] = useState('');
  const [wallClockBudget, setWallClockBudget] = useState('');
  const [baseline, setBaseline] = useState<{ goalId: string; controlRevision?: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<'refresh' | 'save' | 'pause' | 'resume' | 'cancel' | null>(null);
  const [armedResume, setArmedResume] = useState(false);
  const [armedCancel, setArmedCancel] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [criterionExpanded, setCriterionExpanded] = useState(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
      if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (actionError !== null && editing) {
      errorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      const timer = setTimeout(() => {
        errorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
      }, 50);
      return () => {
        clearTimeout(timer);
      };
    }
  }, [actionError, editing]);

  const seedForm = (snapshot: GoalSnapshot) => {
    setObjective(snapshot.objective);
    setCriterion(snapshot.completionCriterion ?? '');
    setFollowUpTiming(snapshot.followUpTiming ?? 'subagents_done');
    setTokenBudget(budgetField(snapshot.budget.tokenBudget));
    setTurnBudget(budgetField(snapshot.budget.turnBudget));
    setWallClockBudget(budgetField(snapshot.budget.wallClockBudgetMs, 1_000));
  };

  const openEditor = () => {
    setActionError(null);
    setConflict(false);
    setAdvancedOpen(false);
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
    setActionError(null);
    const seconds = Number(wallClockBudget);
    const wallClockBudgetMs = wallClockBudget.trim() === '' ? null : Math.round(seconds * 1_000);
    const budgetLimits: GoalBudgetPatch = {
      tokenBudget: tokenBudget.trim() === '' ? null : Number(tokenBudget),
      turnBudget: turnBudget.trim() === '' ? null : Number(turnBudget),
      wallClockBudgetMs,
    };
    if (Object.values(budgetLimits).some((value) => value !== null && (!Number.isSafeInteger(value) || value <= 0)) ||
      (wallClockBudgetMs !== null && (wallClockBudgetMs < 1_000 || wallClockBudgetMs / 1_000 !== seconds))) {
      setActionError(t('goal.invalidBudget'));
      setAdvancedOpen(true);
      return;
    }
    setPending('save');
    const input: UpdateAgentGoalInput = {
      goalId: baseline.goalId,
      expectedRevision: baseline.controlRevision,
      objective: trimmed,
      completionCriterion: criterion.trim() === '' ? null : criterion.trim(),
      followUpTiming,
      budgetLimits,
    };
    void onUpdate(input)
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
      className="px-3 py-2.5 sm:px-3.5 sm:py-3 space-y-2.5"
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span aria-hidden className="w-[7px] shrink-0" />
          <p data-goal-objective className="min-w-0 flex-1 text-[13.5px] leading-5 font-medium break-words text-ink">
            {goal.objective}
          </p>
        </div>
        <span data-goal-actions className="flex shrink-0 items-center gap-0.5 ml-1">
          <button
            type="button"
            hidden={editing}
            disabled={busy}
            onClick={openEditor}
            title={t('goal.editTitle')}
            className={actionClass}
          >
            {t('goal.edit')}
          </button>
          {goal.status === 'active' ? <GoalPauseButton onPause={onPause} /> : null}
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
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[15px] text-[12px] text-ink-faint">
        <span data-goal-status-word className={statusTone}>
          {t(`composer.goalStatus.${goal.status}`)}
        </span>
        {followUp !== undefined ? <span>·</span> : null}
        {followUp !== undefined ? <span data-goal-followup>{followUp}</span> : null}
      </div>

      {goal.completionCriterion !== undefined && goal.completionCriterion !== '' ? (
        <div
          data-goal-criterion
          className="ml-[15px] rounded-lg bg-ink/[0.025] border border-hairline/60 px-3 py-2 text-[12px] text-ink-soft"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink-faint text-[11.5px]">
              {t('goal.criterionLabel')}
            </span>
            {goal.completionCriterion.length > 50 ? (
              <button
                type="button"
                data-goal-criterion-toggle
                onClick={() => { setCriterionExpanded((open) => !open); }}
                aria-expanded={criterionExpanded}
                className="cursor-pointer text-[11px] font-medium text-ink-faint transition-colors hover:text-ink underline-offset-2 hover:underline"
              >
                {criterionExpanded ? t('transcript.showLess') : t('transcript.showMore')}
              </button>
            ) : null}
          </div>
          <p
            data-goal-criterion-text
            className={`mt-1 break-words whitespace-pre-wrap text-ink leading-relaxed ${
              !criterionExpanded && goal.completionCriterion.length > 50 ? 'line-clamp-2' : ''
            }`}
            title={t('goal.doneWhen', { criterion: goal.completionCriterion })}
          >
            {goal.completionCriterion}
          </p>
        </div>
      ) : null}

      <div
        data-goal-budgets
        className="ml-[15px] grid grid-cols-1 sm:grid-cols-3 gap-2 pt-0.5 text-[12px] tabular-nums"
      >
        {([
          ['turns', goal.turnsUsed, goal.budget.turnBudget, goal.budget.turnBudgetReached],
          ['tokens', goal.tokensUsed, goal.budget.tokenBudget, goal.budget.tokenBudgetReached],
          ['seconds', Math.floor(goal.wallClockMs / 1_000), goal.budget.wallClockBudgetMs === null ? null : goal.budget.wallClockBudgetMs / 1_000, goal.budget.wallClockBudgetReached],
        ] as const).map(([unit, used, limit, reached]) => (
          <div
            key={unit}
            data-goal-budget={unit}
            className={`flex flex-col gap-0.5 rounded-lg bg-ink/[0.025] px-2.5 py-1.5 border border-hairline/60 ${
              reached ? 'border-amber/40 bg-amber/[0.04]' : ''
            }`}
          >
            <span className="text-[11px] text-ink-faint font-normal">
              {t(`goal.budget.${unit}`)}
            </span>
            <span className="flex items-baseline gap-1 text-[13px] font-medium leading-none mt-0.5">
              <span className={reached ? 'text-amber-ink' : 'text-ink'}>
                {used.toLocaleString()}
              </span>
              <span className="text-[11px] text-ink-faint font-normal">
                {limit === null ? ` · ${t('goal.noLimit')}` : `/${limit.toLocaleString()}`}
                {reached ? ` · ${t('goal.limitReached')}` : ''}
              </span>
            </span>
          </div>
        ))}
      </div>

      {goal.status === 'blocked' && goal.budget.overBudget ? (
        <p className="ml-[15px] mt-1 text-[12px] text-amber-ink">{t('goal.budgetBlocked')}</p>
      ) : null}

      <InlineEditor open={editing} lazy className="mt-2 mb-1 ml-[15px] space-y-3">
          <div className="space-y-3" data-goal-editor>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                {t('goal.editObjective')}
              </span>
              <textarea
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value);
                  if (actionError !== null) setActionError(null);
                }}
                rows={2}
                disabled={pending === 'refresh' || pending === 'save'}
                placeholder={t('composer.placeholder')}
                className="w-full resize-none rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-[13px] leading-5 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-60 transition-colors"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink-soft">
                {t('goal.editCriterion')}
              </span>
              <input
                value={criterion}
                onChange={(event) => {
                  setCriterion(event.target.value);
                  if (actionError !== null) setActionError(null);
                }}
                disabled={pending === 'refresh' || pending === 'save'}
                placeholder={t('goal.editCriterion')}
                className="w-full rounded-lg border border-hairline/60 bg-panel/60 px-2.5 py-1 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:bg-panel focus:outline-none disabled:opacity-60 transition-colors"
              />
            </label>
            <div className="pt-0.5">
              <button
                type="button"
                data-goal-advanced-toggle
                onClick={() => { setAdvancedOpen((open) => !open); }}
                className="flex items-center gap-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink focus-visible:outline-none"
              >
                <DisclosureChevron open={advancedOpen} size={12} />
                <span>{t('st.section.advanced')}</span>
                {(turnBudget.trim() !== '' || tokenBudget.trim() !== '' || wallClockBudget.trim() !== '') ? (
                  <span className="rounded-full bg-accent/10 px-1.5 py-0.2 text-[10px] font-medium text-accent">
                    {t('goal.hardBudgets')}
                  </span>
                ) : null}
              </button>
              <div
                data-goal-advanced
                className={advancedOpen ? 'mt-2 space-y-3 rounded-lg border border-hairline/40 bg-ink/[0.02] p-2.5' : 'hidden'}
              >
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
                          timing === followUpTiming
                            ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                            : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        {t(GOAL_TIMING_LABEL_KEY[timing])}
                      </button>
                    ))}
                  </span>
                </div>
                <fieldset disabled={busy} className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <legend className="text-[12px] font-medium text-ink-soft">{t('goal.hardBudgets')}</legend>
                    <button
                      type="button"
                      className={actionClass}
                      onClick={() => {
                        setTurnBudget('');
                        setTokenBudget('');
                        setWallClockBudget('');
                        if (actionError !== null) setActionError(null);
                      }}
                    >
                      {t('goal.clearBudgets')}
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {([
                      { unit: 'turns', value: turnBudget, setter: setTurnBudget, step: 1, min: 1, defaultVal: '5' },
                      { unit: 'tokens', value: tokenBudget, setter: setTokenBudget, step: 1000, min: 1, defaultVal: '10000' },
                      { unit: 'seconds', value: wallClockBudget, setter: setWallClockBudget, step: 10, min: 1, defaultVal: '300' },
                    ] as const).map(({ unit, value, setter, step, min, defaultVal }) => {
                      const isCustom = value.trim() !== '';
                      return (
                        <div
                          key={unit}
                          data-goal-budget-row={unit}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline/40 bg-panel/80 px-2 py-1.5"
                        >
                          <span className="text-[12px] text-ink-soft">
                            {t(`goal.budget.${unit}`)}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span
                              role="radiogroup"
                              aria-label={t(`goal.budget.${unit}`)}
                              className="flex items-center gap-0.5 rounded-lg bg-ink/[0.04] p-0.5"
                            >
                              <button
                                type="button"
                                role="radio"
                                aria-checked={!isCustom}
                                data-goal-budget-mode={`${unit}-unlimited`}
                                onClick={() => {
                                  setter('');
                                  if (actionError !== null) setActionError(null);
                                }}
                                className={`h-5 rounded px-1.5 text-[11px] transition-colors focus-visible:outline-none ${
                                  !isCustom
                                    ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                                    : 'text-ink-soft hover:text-ink'
                                }`}
                              >
                                {t('goal.noLimit')}
                              </button>
                              <button
                                type="button"
                                role="radio"
                                aria-checked={isCustom}
                                data-goal-budget-mode={`${unit}-custom`}
                                onClick={() => {
                                  if (!isCustom) setter(defaultVal);
                                  if (actionError !== null) setActionError(null);
                                }}
                                className={`h-5 rounded px-1.5 text-[11px] transition-colors focus-visible:outline-none ${
                                  isCustom
                                    ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                                    : 'text-ink-soft hover:text-ink'
                                }`}
                              >
                                {t('st.nbSearch.advanced.customValue')}
                              </button>
                            </span>
                            <div className={`flex items-center gap-1 ${isCustom ? '' : 'hidden'}`}>
                              <button
                                type="button"
                                aria-label={t('goal.budget.decrease', { unit: t(`goal.budget.${unit}` as const) })}
                                disabled={Number(value) <= min}
                                onClick={() => {
                                  const current = Number(value) || min;
                                  const next = Math.max(min, Math.round((current - step) * 1000) / 1000);
                                  setter(String(next));
                                  if (actionError !== null) setActionError(null);
                                }}
                                className="flex h-5 w-5 items-center justify-center rounded border border-hairline bg-paper text-ink-soft hover:bg-ink/[0.05] hover:text-ink disabled:opacity-30 focus-visible:outline-none"
                              >
                                <Icon name="dash" size={12} />
                              </button>
                              <input
                                type="number"
                                min={min}
                                step={unit === 'seconds' ? 0.001 : 1}
                                value={value}
                                data-goal-budget-input={unit}
                                placeholder={t('goal.noLimit')}
                                onChange={(event) => {
                                  setter(event.target.value);
                                  if (actionError !== null) setActionError(null);
                                }}
                                className="h-5 w-16 rounded border border-hairline bg-paper px-1 text-center text-[11px] tabular-nums text-ink focus:border-accent focus:outline-none"
                              />
                              <button
                                type="button"
                                aria-label={t('goal.budget.increase', { unit: t(`goal.budget.${unit}` as const) })}
                                onClick={() => {
                                  const current = Number(value) || 0;
                                  const next = Math.round((current + step) * 1000) / 1000;
                                  setter(String(next));
                                  if (actionError !== null) setActionError(null);
                                }}
                                className="flex h-5 w-5 items-center justify-center rounded border border-hairline bg-paper text-ink-soft hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none"
                              >
                                <Icon name="plus" size={12} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <span className="block text-[11px] text-ink-faint">{t('goal.budgetHint')}</span>
                </fieldset>
              </div>
            </div>
            {actionError !== null ? (
              <p
                ref={errorRef}
                role="alert"
                data-goal-error
                className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[12px] leading-snug break-words text-danger"
              >
                {t('goal.actionFailed', { detail: actionError })}
              </p>
            ) : null}
            {conflict ? (
              <p role="status" data-goal-conflict className="text-[12px] text-amber-ink">
                {t('goal.conflict')}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setConflict(false);
                  setActionError(null);
                }}
                disabled={pending === 'save'}
                className="h-7 rounded-md px-3 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={pending !== null || baseline === null || objective.trim() === ''}
                data-goal-save
                className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </InlineEditor>
        {!editing && actionError !== null ? (
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
  if (count <= 0) return null;
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
            className="h-7 shrink-0 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
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
            className="h-7 shrink-0 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none"
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

/**
 * CronTaskEditor — the create/edit form for one scheduled task.
 *
 * The form speaks in schedules, not expressions: once-or-repeat, then a
 * cadence (hour / day / week / month), a time, and the days. Nobody has to
 * know what a cron field is to set a task that runs every morning at 09:00.
 *
 * The expression still exists, in two places, and neither of them is a trap:
 *
 *   - A task whose rule the controls cannot hold opens in `advanced` mode
 *     with the rule exactly as the server sent it. Saving from there writes
 *     the text back untouched. A complex rule is never quietly narrowed into
 *     a simpler one, which is the failure this panel exists to avoid.
 *   - The user can move to `advanced` on purpose, and back to the controls
 *     when the expression is one they cover.
 *
 * Nothing here decides when the task fires. The schedule controls produce the
 * expression the server schedules with; the moment it reported is the only
 * truth the page ever shows.
 *
 * Failure never costs work: a rejected save keeps every field, keeps the
 * panel open, and says what to do next. Cancel is the only thing that
 * discards a draft, and it asks first when there is one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { Session, Workspace } from '@kiki/protocol';
import {
  DEFAULT_CRON_FORM,
  isValidCron,
  readCronForm,
  weekdayKey,
  writeCronForm,
  type CronCadence,
  type CronForm,
} from '@kiki/session-core/util';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES, Dialog } from './Dialog';
import { Icon } from './icons';
import { SearchableSelect } from './SearchableSelect';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

/** Options for "every N hours"; 1 is the plain hourly case. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
/** Weekday order people read a week in, starting Sunday (cron's 0). */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const CADENCES: readonly CronCadence[] = ['hourly', 'daily', 'weekly', 'monthly'];
const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

export type CronEditorMode = 'create' | 'edit';

export interface CronTaskEditorProps {
  readonly mode: CronEditorMode;
  /** The task being edited; absent for a new one. */
  readonly task?: {
    readonly id: string;
    readonly session_id: string | null;
    readonly workspace_id: string;
    readonly cron: string;
    /**
     * Deliberately absent. The caller only ever holds a truncated preview of
     * the prompt, and the editor reads the real text itself; accepting a
     * prompt here would invite a caller to pass the preview and make a save
     * write the truncation over the task.
     */
    readonly recurring: boolean;
  } | undefined;
  readonly sessions: readonly Session[];
  readonly workspaceOptions: readonly Workspace[];
  /** Source conversation id, for the update route's disambiguation query. */
  readonly sourceSessionId: string | undefined;
  /** Conversation the page is scoped to; the form opens on it. */
  readonly preferredSessionId: string | undefined;
  readonly busy: boolean;
  /** A save the server refused, shown without losing the draft. */
  readonly error?: string | undefined;
  readonly onSubmit: (input: {
    readonly session_id: string;
    readonly cron: string;
    readonly prompt: string;
    readonly recurring: boolean;
  }) => void;
  readonly onClose: () => void;
}

const LABEL = 'block text-[12px] font-medium text-ink-soft';
const SECTION = 'space-y-2.5';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The expression a one-shot picks out: a pinned day, so "tomorrow 09:00"
 * cannot quietly become "the 9th of every month".
 */
function writeOneShotCron(at: Date): string {
  return `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
}

function toLocalDateInput(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function toLocalTimeInput(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Reads a `datetime-local` value in the browser's own zone, not UTC. */
function readLocalDateTime(date: string, time: string): Date | undefined {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (dateMatch === null || timeMatch === null) return undefined;
  const at = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  return Number.isNaN(at.getTime()) ? undefined : at;
}

interface Draft {
  readonly recurring: boolean;
  readonly form: CronForm;
  readonly prompt: string;
  readonly sessionId: string;
  /** `undefined` until the user opens the expression editor. */
  readonly advancedCron: string | undefined;
  readonly oneShotDate: string;
  readonly oneShotTime: string;
}

export function CronTaskEditor({
  mode,
  task,
  sessions,
  workspaceOptions,
  sourceSessionId,
  preferredSessionId,
  busy,
  error,
  onSubmit,
  onClose,
}: CronTaskEditorProps) {
  const { t, time } = useI18n();
  const { client } = useConnection();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // The list row carries a *preview* of the prompt, and the preview is
  // shorter than the prompt. Seeding the editor with it would make saving a
  // truncation: the detail read below is what makes the text savable, and
  // until it lands the field is disabled rather than briefly holding a
  // shortened text a fast save could capture.
  const detail = useQuery({
    queryKey: ['cron-task-detail', task?.workspace_id ?? '', task?.id ?? '', task?.session_id ?? null],
    queryFn: async (): Promise<{ readonly prompt: string }> =>
      (await client.getCronTask(task?.id ?? '', sourceSessionId)).task,
    enabled: task !== undefined,
    staleTime: 30_000,
    retry: false,
  });
  /** True until the real prompt is in hand, or until reading it failed. */
  const promptPending = task !== undefined && detail.data === undefined && !detail.isError;

  const initial = useMemo((): Draft => {
    const now = new Date();
    const defaultSession = task?.session_id ?? preferredSessionId ?? sessions[0]?.id ?? '';
    if (task === undefined) {
      return {
        recurring: true,
        form: DEFAULT_CRON_FORM,
        prompt: '',
        sessionId: defaultSession,
        advancedCron: undefined,
        // A new task is almost always "later today" rather than "some day".
        oneShotDate: toLocalDateInput(now),
        oneShotTime: toLocalTimeInput(new Date(now.getTime() + 60 * 60_000)),
      };
    }
    const read = readCronForm(task.cron);
    if (task.recurring && read.kind === 'friendly') {
      return {
        recurring: true,
        form: read.form,
        // Empty on purpose: the caller never supplies a prompt, because what
        // it holds is a truncated preview. The real text arrives from the
        // detail read, and nothing derived from a preview is ever submitted.
        prompt: '',
        sessionId: task.session_id ?? defaultSession,
        advancedCron: undefined,
        oneShotDate: toLocalDateInput(now),
        oneShotTime: toLocalTimeInput(now),
      };
    }
    // A one-shot and any rule the controls cannot hold open on the
    // expression, with the server's own text already in the box.
    return {
      recurring: task.recurring,
      form: read.kind === 'friendly' ? read.form : DEFAULT_CRON_FORM,
      prompt: '',
      sessionId: task.session_id ?? defaultSession,
      advancedCron: task.cron,
      oneShotDate: toLocalDateInput(now),
      oneShotTime: toLocalTimeInput(now),
    };
  }, [task, preferredSessionId, sessions]);

  const [draft, setDraft] = useState<Draft>(initial);
  const [promptError, setPromptError] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [touched, setTouched] = useState(false);
  // Which fields this editor has actually changed, tracked per field rather
  // than as one "touched" bit. The prompt in particular is seeded from an
  // async read that can land after the user has moved on to the schedule, so
  // touching the frequency must not be mistaken for having edited the prompt.
  const [edited, setEdited] = useState<ReadonlySet<'prompt' | 'form'>>(new Set());
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const [weekdayError, setWeekdayError] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Seed the prompt from the real detail, once, and only while the prompt
  // itself is untouched. This is the only path that can put text in the box
  // for an existing task.
  const fullPrompt = detail.data?.prompt;
  const promptSeeded = useRef(false);
  useEffect(() => {
    if (fullPrompt === undefined || promptSeeded.current) return;
    promptSeeded.current = true;
    setDraft((current) => (editedRef.current.has('prompt') ? current : { ...current, prompt: fullPrompt }));
  }, [fullPrompt]);

  // Reset the draft only when the editor is pointed at a different task, not
  // whenever the surrounding page re-renders: the conversation list is a
  // live prop, and a background refetch must not wipe a half-written form.
  const draftFor = useRef(task?.id ?? 'create');
  useEffect(() => {
    const key = task?.id ?? 'create';
    if (draftFor.current === key) return;
    draftFor.current = key;
    // A different task means a different prompt to seed, so the one-shot
    // guard has to rearm with the draft.
    promptSeeded.current = false;
    setEdited(new Set());
    setDraft(initial);
  }, [task?.id, initial]);

  const patch = useCallback((next: Partial<Draft>, field: 'prompt' | 'form' = 'form') => {
    setTouched(true);
    setEdited((current) => (current.has(field) ? current : new Set(current).add(field)));
    setSubmitError(undefined);
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  // Editing an existing rule: the target list is the task's own workspace,
  // because the server refuses a rebind across workspaces with a plain
  // validation error. Offering the whole directory would be offering
  // something that cannot be saved.
  const editableWorkspaces = useMemo(
    () => (task === undefined ? workspaceOptions : workspaceOptions.filter((entry) => entry.id === task.workspace_id)),
    [task, workspaceOptions],
  );
  const workspaceById = useMemo(
    () => new Map(workspaceOptions.map((entry) => [entry.id, entry])),
    [workspaceOptions],
  );
  const sessionOptions = useMemo(() => sessions
    .filter((session) => editableWorkspaces.some((workspace) => workspace.id === session.workspace_id))
    .toSorted((left, right) => {
      const leftAt = left.updated_at ?? '';
      const rightAt = right.updated_at ?? '';
      return rightAt.localeCompare(leftAt);
    })
    .map((session) => ({
      value: session.id,
      label: session.title.trim() === '' ? t('cron.form.bindUnbound') : session.title,
      // The workspace groups the rows and names where the task will live.
      group: workspaceById.get(session.workspace_id)?.name ?? session.workspace_id,
      // When the conversation was last active, which is what a person
      // picking the target is actually scanning for. The workspace id is
      // still searchable, just never printed.
      hint: session.updated_at === undefined ? undefined : time.relativeTime(session.updated_at),
      keywords: session.workspace_id,
    })), [sessions, editableWorkspaces, workspaceById, t, time]);

  const selectedWorkspaceId = useMemo(() => {
    const session = sessions.find((entry) => entry.id === draft.sessionId);
    return session?.workspace_id ?? editableWorkspaces[0]?.id;
  }, [sessions, draft.sessionId, editableWorkspaces]);

  const advanced = draft.advancedCron !== undefined;
  const advancedCron = draft.advancedCron ?? '';
  const advancedValid = isValidCron(advancedCron);

  const expression = useMemo((): string | undefined => {
    if (advanced) return advancedValid ? advancedCron.trim() : undefined;
    if (!draft.recurring) {
      const at = readLocalDateTime(draft.oneShotDate, draft.oneShotTime);
      return at === undefined ? undefined : writeOneShotCron(at);
    }
    if (draft.form.cadence === 'weekly' && draft.form.weekdays.length === 0) return undefined;
    return writeCronForm(draft.form);
  }, [advanced, advancedValid, advancedCron, draft]);

  // An existing task can only be saved once the real prompt is in hand: a
  // save built from the list row's preview would write the truncation over
  // the prompt. A create has no detail to wait for, so its own typed text is
  // the prompt.
  const promptReady = task === undefined || !promptPending;
  const canSubmit = expression !== undefined
    && draft.prompt.trim() !== ''
    && promptReady
    && draft.sessionId !== ''
    && !busy;

  const close = useCallback(() => {
    if (touched && !busy) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [touched, busy, onClose]);

  const submit = () => {
    if (!promptReady) {
      setPromptError(t('cron.form.promptStillLoading'));
      return;
    }
    if (expression === undefined || draft.prompt.trim() === '') {
      setPromptError(draft.prompt.trim() === '' ? t('cron.form.error.promptRequired') : undefined);
      if (draft.form.cadence === 'weekly' && draft.form.weekdays.length === 0) setWeekdayError(true);
      return;
    }
    setPromptError(undefined);
    setWeekdayError(false);
    onSubmit({
      session_id: draft.sessionId,
      cron: expression,
      prompt: draft.prompt,
      recurring: draft.recurring,
    });
  };

  const setCadence = (cadence: CronCadence) => {
    if (cadence === 'weekly' && draft.form.weekdays.length === 0) {
      patch({ form: { ...draft.form, cadence, weekdays: [1] } });
      return;
    }
    patch({ form: { ...draft.form, cadence } });
  };

  const toggleWeekday = (day: number) => {
    const next = draft.form.weekdays.includes(day)
      ? draft.form.weekdays.filter((entry) => entry !== day)
      : [...draft.form.weekdays, day];
    setWeekdayError(false);
    patch({ form: { ...draft.form, weekdays: next } });
  };

  const useControls = () => {
    const read = readCronForm(advancedCron);
    patch({
      advancedCron: undefined,
      form: read.kind === 'friendly' ? read.form : draft.form,
    });
  };

  return (
    <>
      <Dialog
        onClose={close}
        ariaLabel={t(mode === 'create' ? 'cron.form.createTitle' : 'cron.form.editTitle')}
        overlayId="cron-task-editor"
        panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[min(88vh,900px)] overflow-y-auto`}
      >
        <h3 data-cron-editor-title className="font-display text-[18px] font-semibold text-ink">
          {t(mode === 'create' ? 'cron.form.createTitle' : 'cron.form.editTitle')}
        </h3>

        <div className="mt-5 space-y-5">
          {/* When */}
          <fieldset className={SECTION}>
            <legend className={LABEL}>{t('cron.form.kind')}</legend>
            <div role="radiogroup" aria-label={t('cron.form.kind')} className="flex flex-wrap gap-1.5">
              <Choice
                role="radio"
                aria-checked={!draft.recurring}
                onSelect={() => { patch({ recurring: false }); }}
                active={!draft.recurring}
              >
                {t('cron.form.kind.once')}
              </Choice>
              <Choice
                role="radio"
                aria-checked={draft.recurring}
                onSelect={() => { patch({ recurring: true }); }}
                active={draft.recurring}
              >
                {t('cron.form.kind.recurring')}
              </Choice>
            </div>
          </fieldset>

          {!draft.recurring && !advanced ? (
            <div data-cron-once className={SECTION}>
              <span className={LABEL}>{t('cron.form.repeat')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  data-cron-once-date
                  aria-label={t('cron.form.kind.once')}
                  value={draft.oneShotDate}
                  onChange={(event) => { patch({ oneShotDate: event.target.value }); }}
                  className={`${INPUT} w-auto flex-1`}
                />
                <input
                  type="time"
                  data-cron-once-time
                  aria-label={t('cron.form.at')}
                  value={draft.oneShotTime}
                  onChange={(event) => { patch({ oneShotTime: event.target.value }); }}
                  className={`${INPUT} w-auto`}
                />
              </div>
            </div>
          ) : null}

          {draft.recurring && !advanced ? (
            <>
              <fieldset className={SECTION}>
                <legend className={LABEL}>{t('cron.form.repeat')}</legend>
                <div role="radiogroup" aria-label={t('cron.form.repeat')} className="flex flex-wrap gap-1.5">
                  {CADENCES.map((cadence) => (
                    <Choice
                      key={cadence}
                      role="radio"
                      data-cron-cadence={cadence}
                      aria-checked={draft.form.cadence === cadence}
                      onSelect={() => { setCadence(cadence); }}
                      active={draft.form.cadence === cadence}
                    >
                      {t(`cron.form.cadence.${cadence}`)}
                    </Choice>
                  ))}
                </div>
              </fieldset>

              {draft.form.cadence === 'hourly' ? (
                <div data-cron-hourly className="flex flex-wrap items-center gap-2">
                  <select
                    data-cron-hour-step
                    aria-label={t('cron.form.repeat')}
                    value={draft.form.hourStep}
                    onChange={(event) => { patch({ form: { ...draft.form, hourStep: Number(event.target.value) } }); }}
                    className={`${INPUT} w-auto`}
                  >
                    {HOUR_STEPS.map((step) => (
                      <option key={step} value={step}>
                        {step === 1 ? t('cron.form.everyHour') : t('cron.form.everyNHours', { n: step })}
                      </option>
                    ))}
                  </select>
                  <select
                    data-cron-minute
                    aria-label={t('cron.form.minuteOf', { m: draft.form.minute })}
                    value={draft.form.minute}
                    onChange={(event) => { patch({ form: { ...draft.form, minute: Number(event.target.value) } }); }}
                    className={`${INPUT} w-auto`}
                  >
                    {MINUTES.map((minute) => (
                      <option key={minute} value={minute}>
                        {minute === 0 ? t('cron.form.minuteOnTheHour') : t('cron.form.minuteOf', { m: minute })}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {draft.form.cadence === 'weekly' ? (
                <fieldset data-cron-weekdays className={SECTION}>
                  <legend className={LABEL}>{t('cron.form.onDays')}</legend>
                  <div role="group" aria-label={t('cron.form.onDays')} className="flex flex-wrap gap-1.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const on = draft.form.weekdays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          role="checkbox"
                          data-cron-weekday={day}
                          aria-checked={on}
                          onClick={() => { toggleWeekday(day); }}
                          className={`h-8 min-w-11 rounded-md border px-2.5 text-[12px] transition-colors ${
                            on
                              ? 'border-hairline bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                              : 'border-dashed border-hairline-strong text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
                          }`}
                        >
                          {t(weekdayKey(day))}
                        </button>
                      );
                    })}
                  </div>
                  {weekdayError ? (
                    <p role="alert" data-cron-weekday-error className="text-[12px] text-danger">
                      {t('cron.form.error.weekdaysRequired')}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}

              {draft.form.cadence === 'monthly' ? (
                <div data-cron-monthly className="flex flex-wrap items-center gap-2">
                  <select
                    data-cron-day-of-month
                    aria-label={t('cron.form.dayOfMonth', { day: draft.form.dayOfMonth })}
                    value={draft.form.dayOfMonth}
                    onChange={(event) => { patch({ form: { ...draft.form, dayOfMonth: Number(event.target.value) } }); }}
                    className={`${INPUT} w-auto`}
                  >
                    {DAYS.map((day) => (
                      <option key={day} value={day}>{t('cron.form.dayOfMonth', { day })}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              {draft.form.cadence !== 'hourly' ? (
                <div className={SECTION}>
                  <span className={LABEL}>{t('cron.form.at')}</span>
                  <input
                    type="time"
                    data-cron-time
                    aria-label={t('cron.form.at')}
                    value={`${pad(draft.form.hour)}:${pad(draft.form.minute)}`}
                    onChange={(event) => {
                      const [hour, minute] = event.target.value.split(':');
                      patch({
                        form: {
                          ...draft.form,
                          hour: Number(hour),
                          minute: Number(minute),
                        },
                      });
                    }}
                    className={`${INPUT} w-auto`}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {advanced ? (
            <div data-cron-advanced className={SECTION}>
              <label htmlFor="cron-advanced-input" className={LABEL}>{t('cron.form.advancedLabel')}</label>
              <p className="text-[12px] leading-relaxed text-ink-soft">{t('cron.form.advancedHint')}</p>
              <input
                id="cron-advanced-input"
                data-cron-advanced-input
                data-autofocus
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={advancedCron}
                placeholder={t('cron.form.advancedPlaceholder')}
                onChange={(event) => { patch({ advancedCron: event.target.value }); }}
                className={`${INPUT} font-mono`}
              />
              {advancedCron.trim() !== '' && !advancedValid ? (
                <p role="alert" data-cron-advanced-error className="text-[12px] leading-relaxed text-danger">
                  {t('cron.form.advancedInvalid')}
                </p>
              ) : null}
              {readCronForm(advancedCron).kind === 'friendly' ? (
                <button type="button" data-cron-advanced-back onClick={useControls} className={`${SECONDARY_BUTTON} self-start`}>
                  {t('cron.form.advancedBack')}
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              data-cron-advanced-switch
              onClick={() => { patch({ advancedCron: expression ?? writeCronForm(draft.form) }); }}
              className="self-start text-[12px] text-ink-soft underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {t('cron.form.advancedSwitch')}
            </button>
          )}

          {/* Where it runs. Above the prompt, so the picker's own panel
              opens downward over empty space rather than over the field the
              user is about to type into. */}
          <div className={SECTION}>
            <span className={LABEL}>{t('cron.form.bind')}</span>
            <p className="text-[12px] leading-relaxed text-ink-soft">{t('cron.form.bindHint')}</p>
            {sessionOptions.length === 0 ? (
              <p data-cron-bind-empty className="text-[12px] text-ink-faint">{t('cron.form.bindEmpty')}</p>
            ) : (
              <SearchableSelect
                id="cron-bind-session"
                options={sessionOptions}
                value={draft.sessionId}
                onChange={(value) => { patch({ sessionId: value }); }}
                ariaLabel={t('cron.form.bind')}
                searchPlaceholder={t('cron.form.bindSearch')}
                emptyText={t('cron.form.bindEmpty')}
                noMatchText={(query) => t('cron.form.bindSearchEmpty', { query })}
                hideFilter={sessionOptions.length <= 8}
                buttonClassName={`${INPUT} flex items-center gap-1.5 text-left`}
                placement="above"
              />
            )}
            {selectedWorkspaceId !== undefined ? (
              <p data-cron-bind-workspace className="text-[12px] text-ink-faint">
                {t('cron.detail.workspace')}: {workspaceById.get(selectedWorkspaceId)?.name ?? selectedWorkspaceId}
              </p>
            ) : null}
            {task !== undefined ? (
              <p data-cron-bind-note className="text-[12px] leading-relaxed text-ink-faint">
                {t('cron.detail.bindingSame')}
              </p>
            ) : null}
          </div>

          {/* What runs */}
          <div className={SECTION}>
            <label htmlFor="cron-prompt" className={LABEL}>{t('cron.form.prompt')}</label>
            <textarea
              id="cron-prompt"
              data-cron-prompt
              ref={promptRef}
              rows={4}
              value={draft.prompt}
              disabled={promptPending}
              placeholder={t('cron.form.promptPlaceholder')}
              aria-invalid={promptError !== undefined}
              aria-busy={promptPending}
              onChange={(event) => { setPromptError(undefined); patch({ prompt: event.target.value }, 'prompt'); }}
              className={`${INPUT} min-h-[88px] resize-y leading-relaxed`}
            />
            {promptPending ? (
              <p data-cron-prompt-loading className="text-[12px] text-ink-faint">{t('cron.form.promptLoading')}</p>
            ) : null}
            {/* A read that failed is recoverable: say so, and let the user
                type the prompt they meant rather than saving a preview. */}
            {detail.isError ? (
              <div role="status" data-cron-prompt-error className="text-[12px] leading-relaxed text-danger">
                <p>{t('cron.form.detailUnavailable')}</p>
                <button
                  type="button"
                  data-cron-prompt-retry
                  onClick={() => { void detail.refetch(); }}
                  className="mt-0.5 font-medium underline underline-offset-2"
                >
                  {t('common.retry')}
                </button>
              </div>
            ) : null}
            {promptError !== undefined ? (
              <p role="alert" data-cron-prompt-error className="text-[12px] text-danger">{promptError}</p>
            ) : null}
          </div>
        </div>

        {(error ?? submitError) !== undefined ? (
          <p role="alert" data-cron-submit-error className="mt-4 text-[12.5px] leading-relaxed text-danger">
            {error ?? submitError}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" data-cron-cancel onClick={close} disabled={busy} className={SECONDARY_BUTTON}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            data-cron-save
            onClick={submit}
            disabled={!canSubmit}
            className={PRIMARY_BUTTON}
          >
            {busy
              ? t('common.saving')
              : t(mode === 'create' ? 'cron.panel.create' : 'common.save')}
          </button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title={t('common.cancel')}
        body={t('cron.form.discardBody')}
        confirmLabel={t('cron.form.discardConfirm')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        // This confirmation is a sibling of the editor's Dialog, not a child
        // of it, so it cannot inherit modal stacking through context. It has
        // to claim it: both overlays otherwise sit at z-50 and the editor
        // panel keeps the confirm button out of reach.
        stacked
        overlayId="cron-task-editor-discard"
        onCancel={() => { setConfirmDiscard(false); }}
        onConfirm={() => { setConfirmDiscard(false); onClose(); }}
      />
    </>
  );
}

/** A segmented option: the raised sheet when it is the one that is true. */
function Choice({
  active,
  onSelect,
  children,
  ...rest
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
  readonly role?: 'radio';
  readonly 'aria-checked'?: boolean;
  readonly 'data-cron-cadence'?: CronCadence;
}) {
  return (
    <button
      type="button"
      {...rest}
      onClick={onSelect}
      className={`h-8 rounded-md border px-3 text-[12px] transition-colors ${
        active
          ? 'border-hairline bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
          : 'border-dashed border-hairline-strong text-ink-soft hover:bg-ink/[0.04] hover:text-ink'
      }`}
    >
      {active ? <Icon name="check" size={12} className="mr-1 inline-block align-[-1px] text-ink-soft" /> : null}
      {children}
    </button>
  );
}

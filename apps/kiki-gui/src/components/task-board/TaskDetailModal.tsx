import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, LocalizedError, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_SIZES } from '../Dialog';
import { Markdown } from '../Markdown';
import { RelativeTime } from '../RelativeTime';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { segmentClass } from '../WorkspaceScopeControl';
import { BoardAssociatedTodos } from './BoardAssociatedTodos';
import { FolderGlyph, PriorityGlyph, SessionGlyph, StatusGlyph } from './glyphs';
import { isClosedStatus, PRIORITY_LABEL_KEYS, STATUS_LABEL_KEYS, toIso } from './TaskCard';
import { DEFAULT_BOARD_COLUMNS, type BoardColumnDef, type BoardTask, type BoardTaskStatus, type TaskPriority, type BoardSessionOption } from './types';

export interface TaskDetailModalProps {
  readonly task: BoardTask;
  readonly availableSessions?: readonly BoardSessionOption[];
  readonly sessionLabels?: Readonly<Record<string, string>>;
  readonly statusOptions?: readonly BoardColumnDef[];
  readonly showPrompt?: boolean;
  /** A write for this card is in flight (status move or save). */
  readonly pending?: boolean;
  readonly onClose: () => void;
  readonly onSave?: (updated: Partial<BoardTask>) => void | Promise<void>;
  /** One-click status transition; omitted → status is read-only outside Edit. */
  readonly onMoveStatus?: (taskId: string, status: BoardTaskStatus) => void | Promise<void>;
  readonly onRunInSession?: (taskId: string, sessionId?: string) => void;
  readonly onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  readonly onDelete?: (taskId: string) => void | Promise<void>;
}

const FIELD_LABEL = 'block text-[12px] font-medium text-ink-soft';
const TEXT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[14px] text-ink focus:border-accent focus:outline-hidden';
const SELECT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-hidden';
const AREA_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-hidden';
const SECTION_TITLE = 'text-[12px] font-medium text-ink-soft';

const RESULT_LABEL_KEYS: Record<NonNullable<BoardTask['executions'][number]['result']> | 'running', I18nKey> = {
  succeeded: 'taskBoard.result.succeeded',
  failed: 'taskBoard.result.failed',
  cancelled: 'taskBoard.result.cancelled',
  running: 'taskBoard.result.running',
};

/** The one obvious next step from each Own Work status; the status list covers the rest. */
const NEXT_STEP: Partial<Record<BoardTaskStatus, { readonly status: BoardTaskStatus; readonly labelKey: I18nKey }>> = {
  active: { status: 'in_progress', labelKey: 'taskBoard.detail.action.start' },
  in_progress: { status: 'done', labelKey: 'taskBoard.detail.action.done' },
  paused: { status: 'in_progress', labelKey: 'taskBoard.detail.action.resume' },
  done: { status: 'active', labelKey: 'taskBoard.detail.action.reopen' },
  cancelled: { status: 'active', labelKey: 'taskBoard.detail.action.reopen' },
  superseded: { status: 'active', labelKey: 'taskBoard.detail.action.reopen' },
};

function CloseGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 10.5 10.5 5.5M6.5 5.5h4v4" />
    </svg>
  );
}

export const TaskDetailModal = memo(function TaskDetailModal({
  task, availableSessions = [], sessionLabels = {}, statusOptions = DEFAULT_BOARD_COLUMNS, showPrompt = true,
  pending: movePending = false, onClose, onSave, onMoveStatus, onRunInSession, onOpenSession, onDelete,
}: TaskDetailModalProps) {
  const { t, locale } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prompt, setPrompt] = useState(showPrompt ? task.prompt ?? '' : task.category ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority ?? 'medium');
  const [status, setStatus] = useState<BoardTask['status']>(task.status);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([...(task.associatedSessionIds ?? [])]);
  const [pending, setPending] = useState(false);
  const [moving, setMoving] = useState<BoardTaskStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const deletingRef = useRef(false);
  const baseRevision = useRef(task.revision);
  const close = () => { if (!submitting.current && !deletingRef.current) onClose(); };
  useEffect(() => {
    if (isEditing) return;
    setTitle(task.title); setDescription(task.description);
    setPrompt(showPrompt ? task.prompt ?? '' : task.category ?? '');
    setPriority(task.priority ?? 'medium'); setStatus(task.status);
    setSelectedSessionIds([...(task.associatedSessionIds ?? [])]);
    baseRevision.current = task.revision;
  }, [task, showPrompt, isEditing]);

  const statusLabel = (option: BoardColumnDef): string =>
    option.label ?? (option.labelKey === undefined ? t(STATUS_LABEL_KEYS[option.status]) : t(option.labelKey));
  const archived = task.archivedAt !== undefined;
  const busy = pending || deleting || movePending || moving !== null;
  const canMove = onMoveStatus !== undefined && !archived && task.detailLoaded !== false;
  const nextStep = NEXT_STEP[task.status];
  const nextStepAvailable = canMove && nextStep !== undefined && statusOptions.some((option) => option.status === nextStep.status);
  const sessionIds = task.associatedSessionIds ?? [];
  // Edit mode lists every known session plus any linked id the picker does not know.
  const sessionChoices = useMemo(() => {
    const known = new Set(availableSessions.map((session) => session.id));
    return [
      ...availableSessions,
      ...(task.associatedSessionIds ?? []).filter((id) => !known.has(id)).map((id) => ({ id, title: sessionLabels[id] ?? id })),
    ];
  }, [availableSessions, sessionLabels, task.associatedSessionIds]);

  const handleMove = async (target: BoardTaskStatus) => {
    if (!canMove || busy || target === task.status) return;
    setMoving(target); setError(null);
    try {
      await onMoveStatus(task.id, target);
    } catch (failure) {
      const fallback = new LocalizedError({ key: 'taskBoard.error.operationFailed' });
      setError(errorText(locale, failure instanceof Error ? failure : fallback));
    } finally {
      setMoving(null);
    }
  };

  const handleSave = async () => {
    if (submitting.current || !onSave) return;
    if (!title.trim()) { setError(t('taskBoard.detail.validation.titleRequired')); return; }
    submitting.current = true; setPending(true); setError(null);
    try {
      await onSave({ title: title.trim(), description, prompt: showPrompt ? prompt : undefined,
        category: showPrompt ? undefined : prompt, priority, status,
        revision: baseRevision.current, associatedSessionIds: selectedSessionIds });
      setIsEditing(false);
    } catch (failure) {
      const fallback = new LocalizedError({ key: 'taskBoard.detail.error.updateFailed' });
      setError(errorText(locale, failure instanceof Error ? failure : fallback));
    } finally {
      submitting.current = false; setPending(false);
    }
  };

  const handleDelete = async () => {
    if (onDelete === undefined || deletingRef.current || submitting.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await onDelete(task.id);
      setConfirmDelete(false);
    } catch (failure) {
      const fallback = new LocalizedError({ key: 'taskBoard.error.operationFailed' });
      setError(errorText(locale, failure instanceof Error ? failure : fallback));
      setConfirmDelete(false);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <Dialog
      stacked
      overlayId="task-board-detail"
      overlayData={{ 'data-task-detail-modal': '' }}
      ariaLabel={t('taskBoard.detail.title')}
      onClose={close}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/40 backdrop-blur-xs p-3 sm:p-4"
      panelClassName={`anim-enter flex max-h-[min(920px,calc(100vh-1.5rem))] w-full sm:w-[calc(100vw-3rem)] ${DIALOG_PANEL_SIZES.xl} flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_20px_60px_-20px_rgb(var(--kiki-shadow-ink)/0.45)] font-sans text-ink`}
    >
        {/* Header: where the card lives, then its id; the title leads the body. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-5 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-ink-faint">
            {task.workspaceTitle ? (
              <>
                <span data-task-detail-workspace className="flex min-w-0 items-center gap-1.5 text-ink-soft" title={t('taskBoard.detail.field.workspace')}>
                  <FolderGlyph />
                  <span className="truncate">{task.workspaceTitle}</span>
                </span>
                <span aria-hidden>/</span>
              </>
            ) : null}
            <span className="min-w-0 truncate font-mono text-[11.5px]">{task.recordId ?? task.id}</span>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending || deleting}
            aria-label={t('taskBoard.detail.close')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50"
          >
            <CloseGlyph />
          </button>
        </div>

        {/* Content Area */}
        <div inert={pending} className="min-h-0 flex-1 overflow-y-auto text-[13px]">
          {error ? <p role="alert" className="mx-5 mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[12.5px] text-danger sm:mx-6">{error}</p> : null}
          {task.detailLoaded === false ? <p role="status" className="px-5 pt-4 text-ink-soft sm:px-6">{t('taskBoard.detail.loading')}</p> : null}
          {isEditing ? (
            /* Editing Mode: single roomy column, large writing surfaces */
            <div className="mx-auto max-w-[760px] space-y-5 px-5 py-5 sm:px-6">
              <div>
                <label htmlFor="task-detail-title" className={FIELD_LABEL}>
                  {t('taskBoard.detail.field.title')}
                </label>
                <input
                  id="task-detail-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={TEXT_INPUT}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="task-detail-status" className={FIELD_LABEL}>
                    {t('taskBoard.detail.field.status')}
                  </label>
                  <select
                    id="task-detail-status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BoardTask['status'])}
                    className={SELECT_INPUT}
                  >
                    {statusOptions.map((option) => <option key={option.status} value={option.status}>{statusLabel(option)}</option>)}
                  </select>
                </div>

                <div>
                  <label htmlFor="task-detail-priority" className={FIELD_LABEL}>
                    {t('taskBoard.detail.field.priority')}
                  </label>
                  <select
                    id="task-detail-priority"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className={SELECT_INPUT}
                  >
                    {(Object.keys(PRIORITY_LABEL_KEYS) as TaskPriority[]).map((value) => (
                      <option key={value} value={value}>{t(PRIORITY_LABEL_KEYS[value])}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="task-detail-description" className={FIELD_LABEL}>
                  {t('taskBoard.detail.field.descriptionContext')}
                </label>
                <textarea
                  id="task-detail-description"
                  rows={8}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={AREA_INPUT}
                />
                <p className="mt-1 text-[11.5px] text-ink-faint">{t('taskBoard.detail.markdownHint')}</p>
              </div>

              <div>
                <label htmlFor="task-detail-prompt" className={FIELD_LABEL}>
                  {showPrompt ? t('taskBoard.detail.field.executionPrompt') : t('taskBoard.detail.field.category')}
                </label>
                {showPrompt ? (
                  <textarea
                    id="task-detail-prompt"
                    rows={6}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className={`${AREA_INPUT} font-mono text-[12.5px]`}
                  />
                ) : (
                  <input
                    id="task-detail-prompt"
                    type="text"
                    maxLength={256}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className={TEXT_INPUT}
                  />
                )}
              </div>

              <fieldset>
                <legend className={FIELD_LABEL}>{t('taskBoard.detail.field.associateSession')}</legend>
                {sessionChoices.length === 0 ? (
                  <p className="mt-1.5 text-[12px] text-ink-faint">{t('taskBoard.detail.noSessionsAvailable')}</p>
                ) : (
                  <ul data-task-detail-session-picker className="mt-1.5 max-h-52 divide-y divide-hairline overflow-y-auto rounded-lg border border-hairline bg-paper">
                    {sessionChoices.map((session) => {
                      const checked = selectedSessionIds.includes(session.id);
                      return (
                        <li key={session.id}>
                          <label className="flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 text-[13px] text-ink transition-colors hover:bg-panel">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setSelectedSessionIds((current) => checked
                                ? current.filter((id) => id !== session.id)
                                : [...current, session.id])}
                              className="h-4 w-4 shrink-0 accent-[var(--color-selected-ink)]"
                            />
                            <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </fieldset>
            </div>
          ) : (
            /* Readonly View Mode: the requirement reads like a document on the
             * left; state, sessions and history rail on the right. */
            <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-w-0 px-5 py-5 sm:px-7 sm:py-6">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-soft">
                  <span data-task-detail-status={task.status} className="flex items-center gap-1.5">
                    <StatusGlyph status={task.status} />
                    {t(STATUS_LABEL_KEYS[task.status])}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <PriorityGlyph priority={task.priority ?? 'medium'} />
                    {t(PRIORITY_LABEL_KEYS[task.priority ?? 'medium'])}
                  </span>
                  {task.category && showPrompt ? <span className="text-ink-faint">{task.category}</span> : null}
                </div>
                <h3 className="mt-3 font-display text-[22px] leading-snug font-semibold break-words text-ink">
                  {task.title}
                </h3>

                <section className="mt-5" aria-label={t('taskBoard.detail.description')}>
                  {task.description.trim() !== '' ? (
                    <div data-task-detail-description className="text-ink">
                      <Markdown mode="static" text={task.description} />
                    </div>
                  ) : task.detailLoaded !== false ? (
                    <p className="text-[13px] text-ink-faint">{t('taskBoard.detail.noDescription')}</p>
                  ) : null}
                </section>

                {showPrompt && task.prompt ? (
                  <section className="mt-6">
                    <h4 className={SECTION_TITLE}>{t('taskBoard.detail.assignedPrompt')}</h4>
                    <pre className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-hairline bg-paper p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-soft">
                      {task.prompt}
                    </pre>
                  </section>
                ) : null}
                {!showPrompt && task.category ? (
                  <section className="mt-6">
                    <h4 className={SECTION_TITLE}>{t('taskBoard.detail.field.category')}</h4>
                    <p className="mt-1.5 text-[13px] text-ink-soft">{task.category}</p>
                  </section>
                ) : null}
              </div>

              <aside className="min-w-0 space-y-5 border-t border-hairline bg-paper/50 px-5 py-5 lg:border-t-0 lg:border-l">
                {/* Status transitions: the current one is the lifted chip. */}
                <section>
                  <h4 className={SECTION_TITLE}>{t('taskBoard.detail.field.status')}</h4>
                  <div role="group" aria-label={t('taskBoard.detail.moveTo')} data-task-detail-status-list className="mt-2 grid grid-cols-2 gap-1 rounded-[9px] border border-hairline bg-paper p-0.5">
                    {statusOptions.map((option) => {
                      const current = option.status === task.status;
                      return (
                        <button
                          key={option.status}
                          type="button"
                          data-task-detail-move={option.status}
                          aria-pressed={current}
                          disabled={!canMove || (busy && !current)}
                          onClick={() => { void handleMove(option.status); }}
                          className={`${segmentClass(current, 'h-8 px-2 text-[12.5px]')} w-full justify-start disabled:cursor-default ${!current ? 'disabled:opacity-55 disabled:hover:bg-transparent' : ''}`}
                        >
                          {moving === option.status
                            ? <span aria-hidden className="spinner h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-hairline-strong border-t-accent" />
                            : <StatusGlyph status={option.status} />}
                          <span className="min-w-0 truncate">{statusLabel(option)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section data-task-detail-sessions>
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className={SECTION_TITLE}>{t('taskBoard.detail.linkedSessions')}</h4>
                    <span className="text-[11.5px] text-ink-faint tabular-nums">{sessionIds.length}</span>
                  </div>
                  {sessionIds.length > 0 ? (
                    <ul className="mt-2 divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
                      {sessionIds.map((sid) => {
                        const label = sessionLabels[sid];
                        return (
                          <li key={sid}>
                            <button
                              type="button"
                              data-task-detail-open-session={sid}
                              disabled={onOpenSession === undefined}
                              onClick={() => onOpenSession?.(sid, task.workspaceId)}
                              title={t('taskBoard.detail.openSession')}
                              className="group flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[13px] text-ink transition-colors hover:bg-paper focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default"
                            >
                              <SessionGlyph className="h-3.5 w-3.5 text-ink-faint" />
                              <span className={`min-w-0 flex-1 truncate ${label === undefined ? 'font-mono text-[11.5px] text-ink-soft' : ''}`}>{label ?? sid}</span>
                              {onOpenSession ? <span className="text-ink-faint transition-colors group-hover:text-ink"><ArrowGlyph /></span> : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">{t('taskBoard.detail.decoupled')}</p>
                  )}
                  <BoardAssociatedTodos sessionIds={sessionIds} sessionLabels={sessionLabels} />
                </section>

                {task.executions.length > 0 || (task.linkedExecutionIds?.length ?? 0) > 0 ? (
                  <section>
                    <div className="flex items-baseline justify-between gap-2">
                      <h4 className={SECTION_TITLE}>{t('taskBoard.detail.attemptsHistory')}</h4>
                      <span className="text-[11.5px] text-ink-faint tabular-nums">{task.executions.length || task.linkedExecutionIds?.length}</span>
                    </div>
                    {task.executions.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {task.executions.map((exec) => (
                          <li key={exec.id} className="rounded-lg border border-hairline bg-panel px-3 py-2 text-[12px]">
                            <div className="flex items-center justify-between gap-2">
                              <span className={`shrink-0 font-medium ${exec.result === 'succeeded' ? 'text-success' : exec.result === 'failed' ? 'text-danger' : exec.result === 'cancelled' ? 'text-ink-faint' : 'text-accent'}`}>
                                {t(RESULT_LABEL_KEYS[exec.result ?? 'running'])}
                              </span>
                              {exec.sessionId && onOpenSession ? (
                                <button type="button" onClick={() => onOpenSession(exec.sessionId!, task.workspaceId)} className="min-w-0 truncate text-ink-soft underline-offset-2 hover:text-ink hover:underline">
                                  {sessionLabels[exec.sessionId] ?? exec.sessionId}
                                </button>
                              ) : null}
                            </div>
                            {exec.error ? <p className="mt-1 text-[11.5px] leading-snug break-words text-danger">{exec.error}</p> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-[12px] leading-relaxed break-all text-ink-faint">{t('taskBoard.detail.linkedExecutionRefs', { ids: task.linkedExecutionIds!.join(', ') })}</p>
                    )}
                  </section>
                ) : null}

                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-hairline pt-4 text-[12px]">
                  <dt className="text-ink-faint">{t('taskBoard.detail.updated')}</dt>
                  <dd className="text-right text-ink-soft tabular-nums"><RelativeTime at={toIso(task.updatedAt)} /></dd>
                  <dt className="text-ink-faint">{t('taskBoard.detail.created')}</dt>
                  <dd className="text-right text-ink-soft tabular-nums"><RelativeTime at={toIso(task.createdAt)} /></dd>
                </dl>
              </aside>
            </div>
          )}
        </div>

        {/* Footer: destructive left, edit + the one next step right. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline px-5 py-3 sm:px-6">
          <div>
            {onDelete ? (
              <button
                type="button"
                onClick={() => { setConfirmDelete(true); }}
                disabled={deleting || pending}
                className="h-8 rounded-md px-2 text-[12.5px] text-danger transition-colors hover:bg-danger/5 disabled:opacity-50"
              >
                {t('taskBoard.detail.delete')}
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {isEditing ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setIsEditing(false)}
                  className={`${SECONDARY_BUTTON} h-8 text-[12.5px]`}
                >
                  {t('taskBoard.detail.cancel')}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { void handleSave(); }}
                  className={`${PRIMARY_BUTTON} h-8 text-[12.5px]`}
                >
                  {t('taskBoard.detail.save')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!onSave || task.detailLoaded === false || archived || busy}
                  onClick={() => { setError(null); setIsEditing(true); }}
                  className={`${SECONDARY_BUTTON} h-8 text-[12.5px]`}
                >
                  {t('taskBoard.detail.edit')}
                </button>
                {onRunInSession ? (
                  <button
                    type="button"
                    onClick={() => onRunInSession(task.id, selectedSessionIds[0])}
                    className={`${SECONDARY_BUTTON} h-8 text-[12.5px]`}
                  >
                    {t('taskBoard.detail.execute')}
                  </button>
                ) : null}
                {nextStep !== undefined && nextStepAvailable ? (
                  <button
                    type="button"
                    data-task-detail-next={nextStep.status}
                    disabled={busy}
                    onClick={() => { void handleMove(nextStep.status); }}
                    className={`${isClosedStatus(task.status) ? SECONDARY_BUTTON : PRIMARY_BUTTON} h-8 text-[12.5px]`}
                  >
                    {t(nextStep.labelKey)}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t('taskBoard.detail.deleteTitle')}
        body={t('taskBoard.detail.deleteBody')}
        confirmLabel={t('taskBoard.detail.deleteConfirm')}
        busy={deleting}
        overlayId="task-board-delete-card"
        onConfirm={() => { void handleDelete(); }}
        onCancel={() => { if (!deletingRef.current) setConfirmDelete(false); }}
      />
    </Dialog>
  );
});

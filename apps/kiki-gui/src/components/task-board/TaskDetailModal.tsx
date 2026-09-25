import { memo, useEffect, useRef, useState } from 'react';
import { errorText, LocalizedError, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_SIZES } from '../Dialog';
import { BoardAssociatedTodos } from './BoardAssociatedTodos';
import { DEFAULT_BOARD_COLUMNS, type BoardColumnDef, type BoardTask, type BoardTaskStatus, type TaskPriority, type BoardSessionOption } from './types';

export interface TaskDetailModalProps {
  readonly task: BoardTask;
  readonly availableSessions?: readonly BoardSessionOption[];
  readonly sessionLabels?: Readonly<Record<string, string>>;
  readonly statusOptions?: readonly BoardColumnDef[];
  readonly showPrompt?: boolean;
  readonly onClose: () => void;
  readonly onSave?: (updated: Partial<BoardTask>) => void | Promise<void>;
  readonly onRunInSession?: (taskId: string, sessionId?: string) => void;
  readonly onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  readonly onDelete?: (taskId: string) => void | Promise<void>;
}

const FIELD_LABEL =
  'block font-mono text-[11px] font-semibold text-ink-faint uppercase tracking-wider';
const TEXT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink focus:border-accent focus:outline-hidden';
const SELECT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[12.5px] text-ink focus:border-accent focus:outline-hidden';
const AREA_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-hidden';
const SECTION_TITLE =
  'font-mono text-[11px] font-semibold text-ink-faint uppercase tracking-wider';

const COLUMN_LABEL_KEYS: Partial<Record<BoardTaskStatus, I18nKey>> = {
  backlog: 'taskBoard.column.backlog',
  todo: 'taskBoard.column.todo',
  running: 'taskBoard.column.running',
  done: 'taskBoard.column.done',
  failed: 'taskBoard.column.failed',
  active: 'taskBoard.column.active',
  in_progress: 'taskBoard.column.in_progress',
  paused: 'taskBoard.column.paused',
  cancelled: 'taskBoard.column.cancelled',
  superseded: 'taskBoard.column.superseded',
};

const PRIORITY_LABEL_KEYS: Record<TaskPriority, I18nKey> = {
  urgent: 'taskBoard.priority.urgent',
  high: 'taskBoard.priority.high',
  medium: 'taskBoard.priority.medium',
  low: 'taskBoard.priority.low',
};

const RESULT_LABEL_KEYS: Record<NonNullable<BoardTask['executions'][number]['result']> | 'running', I18nKey> = {
  succeeded: 'taskBoard.result.succeeded',
  failed: 'taskBoard.result.failed',
  cancelled: 'taskBoard.result.cancelled',
  running: 'taskBoard.result.running',
};

export const TaskDetailModal = memo(function TaskDetailModal({
  task, availableSessions = [], sessionLabels = {}, statusOptions = DEFAULT_BOARD_COLUMNS, showPrompt = true,
  onClose, onSave, onRunInSession, onOpenSession, onDelete,
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
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/40 backdrop-blur-xs p-4"
      panelClassName={`flex max-h-[min(920px,calc(100vh-3rem))] w-[calc(100vw-3rem)] ${DIALOG_PANEL_SIZES.xl} flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_20px_60px_-20px_rgba(28,25,23,0.45)] font-sans text-ink`}
    >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-paper/50 px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 font-mono text-[12px] font-semibold uppercase tracking-wider text-accent">
              {t('taskBoard.detail.title')}
            </span>
            <span className="min-w-0 truncate rounded-full border border-hairline bg-paper px-2.5 py-0.5 font-mono text-[10.5px] text-ink-faint">
              {task.recordId ?? task.id}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending || deleting}
            aria-label={t('taskBoard.detail.close')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Content Area */}
        <div inert={pending} className="min-h-0 flex-1 overflow-y-auto text-[13px]">
          {error ? <p role="alert" className="mx-6 mt-5 rounded-lg border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">{error}</p> : null}
          {task.detailLoaded === false ? <p role="status" className="px-6 pt-5 text-ink-soft">{t('taskBoard.detail.loading')}</p> : null}
          {isEditing ? (
            /* Editing Mode: single roomy column, large writing surfaces */
            <div className="space-y-5 p-6">
              <div>
                <label className={FIELD_LABEL}>
                  {t('taskBoard.detail.field.title')}
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={TEXT_INPUT}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={FIELD_LABEL}>
                    {t('taskBoard.detail.field.status')}
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BoardTask['status'])}
                    className={SELECT_INPUT}
                  >
                    {statusOptions.map((option) => <option key={option.status} value={option.status}>{option.label ?? (option.labelKey === undefined ? option.status : t(option.labelKey))}</option>)}
                  </select>
                </div>

                <div>
                  <label className={FIELD_LABEL}>
                    {t('taskBoard.detail.field.priority')}
                  </label>
                  <select
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
                <label className={FIELD_LABEL}>
                  {t('taskBoard.detail.field.descriptionContext')}
                </label>
                <textarea
                  rows={6}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={AREA_INPUT}
                />
              </div>

              <div>
                <label className={FIELD_LABEL}>
                  {showPrompt ? t('taskBoard.detail.field.executionPrompt') : t('taskBoard.detail.field.category')}
                </label>
                <textarea
                  rows={showPrompt ? 8 : 2}
                  maxLength={showPrompt ? undefined : 256}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className={`${AREA_INPUT} font-mono text-[12.5px]`}
                />
              </div>

              <div>
                <label className={FIELD_LABEL}>
                  {t('taskBoard.detail.field.associateSession')}
                </label>
                <select
                  multiple
                  value={selectedSessionIds}
                  onChange={(e) => setSelectedSessionIds(Array.from(e.target.selectedOptions, (option) => option.value).filter(Boolean))}
                  className={`${SELECT_INPUT} min-h-28`}
                >
                  <option value="">{t('taskBoard.detail.noSession')}</option>
                  {availableSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} ({s.id})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            /* Readonly View Mode: requirement body on the left, execution
             * context (sessions, todos, attempts) railed on the right. */
            <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_330px]">
              <div className="min-w-0 space-y-5 p-6">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-accent">
                      {t(PRIORITY_LABEL_KEYS[task.priority ?? 'medium'])}
                    </span>
                    <span className="rounded-md border border-hairline bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft">
                      {t('taskBoard.detail.field.status')}: {COLUMN_LABEL_KEYS[task.status] === undefined ? task.status : t(COLUMN_LABEL_KEYS[task.status]!)}
                    </span>
                    {task.workspaceTitle ? (
                      <span className="font-mono text-[11.5px] text-ink-faint">
                        📁 {t('taskBoard.detail.field.workspace')}: {task.workspaceTitle}
                      </span>
                    ) : null}
                  </div>
                  <h3 className="mt-2.5 font-display text-[21px] font-semibold leading-snug text-ink">
                    {task.title}
                  </h3>
                </div>

                {task.description ? (
                  <div>
                    <h4 className={SECTION_TITLE}>
                      {t('taskBoard.detail.description')}
                    </h4>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-soft">
                      {task.description}
                    </p>
                  </div>
                ) : null}

                {task.prompt || task.category ? (
                  <div>
                    <h4 className={SECTION_TITLE}>
                      {showPrompt ? t('taskBoard.detail.assignedPrompt') : t('taskBoard.detail.field.category')}
                    </h4>
                    <pre className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-hairline bg-paper p-3.5 font-mono text-[12px] leading-relaxed text-ink-soft">
                      {showPrompt ? task.prompt : task.category}
                    </pre>
                  </div>
                ) : null}
              </div>

              <aside className="min-w-0 space-y-4 border-t border-hairline bg-paper/40 p-5 lg:border-t-0 lg:border-l">
                {/* Associated Sessions Section */}
                <div className="rounded-xl border border-hairline bg-panel p-3.5">
                  <div className="flex items-center justify-between">
                    <span className={SECTION_TITLE}>
                      {t('taskBoard.detail.linkedSessions')}
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                      {t('taskBoard.detail.linkedCount', { count: task.associatedSessionIds?.length ?? 0 })}
                    </span>
                  </div>

                  {task.associatedSessionIds && task.associatedSessionIds.length > 0 ? (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {task.associatedSessionIds.map((sid) => (
                        <button
                          key={sid}
                          type="button"
                          onClick={() => onOpenSession?.(sid, task.workspaceId)}
                          className="flex min-w-0 items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1.5 font-mono text-[11.5px] text-ink transition-colors hover:border-accent hover:text-accent"
                        >
                          <span className="shrink-0">⌁</span>
                          <span className="truncate">{sessionLabels[sid] ?? sid}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
                      {t('taskBoard.detail.decoupled')}
                    </p>
                  )}
                </div>

                <BoardAssociatedTodos
                  sessionIds={task.associatedSessionIds ?? []}
                  sessionLabels={sessionLabels}
                />

                {/* Execution Attempts History */}
                <div className="rounded-xl border border-hairline bg-panel p-3.5">
                  <div className="flex items-center justify-between">
                    <span className={SECTION_TITLE}>
                      {t('taskBoard.detail.attemptsHistory')}
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                      {t('taskBoard.detail.attemptCount', { count: task.executions.length })}
                    </span>
                  </div>

                  {task.executions.length > 0 ? (
                    <ul className="mt-2.5 space-y-2">
                      {task.executions.map((exec) => (
                        <li
                          key={exec.id}
                          className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[11.5px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-medium ${
                                  exec.result === 'succeeded'
                                    ? 'bg-success/10 text-success'
                                    : exec.result === 'failed'
                                      ? 'bg-danger/10 text-danger'
                                      : 'bg-accent-soft text-accent'
                                }`}
                              >
                                {t(RESULT_LABEL_KEYS[exec.result ?? 'running'])}
                              </span>
                              <span className="truncate font-mono text-ink-soft">
                                {sessionLabels[exec.sessionId ?? ''] ?? exec.sessionId ?? 'session-init'}
                              </span>
                            </div>

                            {exec.sessionId && onOpenSession ? (
                              <button
                                type="button"
                                onClick={() => onOpenSession(exec.sessionId!, task.workspaceId)}
                                className="shrink-0 font-mono text-[10.5px] text-accent hover:underline"
                              >
                                {t('taskBoard.detail.viewSession')}
                              </button>
                            ) : null}
                          </div>
                          {exec.error ? (
                            <p className="mt-1 break-words text-[11px] leading-snug text-danger" title={exec.error}>
                              {exec.error}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 break-all text-[11.5px] leading-relaxed text-ink-faint">{task.linkedExecutionIds?.length ? t('taskBoard.detail.linkedExecutionRefs', { ids: task.linkedExecutionIds.join(', ') }) : t('taskBoard.detail.noExecutionRefs')}</p>
                  )}
                </div>
              </aside>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper/40 px-6 py-4">
          <div>
            {onDelete ? (
              <button
                type="button"
                onClick={() => { setConfirmDelete(true); }}
                disabled={deleting || pending}
                className="font-mono text-[12px] text-danger hover:underline"
              >
                {t('taskBoard.detail.delete')}
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2.5">
            {isEditing ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setIsEditing(false)}
                  className="rounded-lg border border-hairline px-3.5 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-paper"
                >
                  {t('taskBoard.detail.cancel')}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { void handleSave(); }}
                  className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
                >
                  {t('taskBoard.detail.save')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!onSave || task.detailLoaded === false || task.archivedAt !== undefined}
                  onClick={() => { setError(null); setIsEditing(true); }}
                  className="rounded-lg border border-hairline px-3.5 py-2 text-[12.5px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
                >
                  {t('taskBoard.detail.edit')}
                </button>
                {onRunInSession ? (
                  <button
                    type="button"
                    onClick={() => onRunInSession(task.id, selectedSessionIds[0])}
                    className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
                  >
                    {t('taskBoard.detail.execute')}
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

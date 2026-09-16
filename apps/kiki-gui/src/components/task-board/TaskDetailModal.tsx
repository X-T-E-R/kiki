import { memo, useEffect, useRef, useState } from 'react';
import { DIALOG_PANEL_SIZES } from '../Dialog';
import { BoardAssociatedTodos } from './BoardAssociatedTodos';
import { DEFAULT_BOARD_COLUMNS, type BoardColumnDef, type BoardTask, type TaskPriority, type BoardSessionOption } from './types';

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

export const TaskDetailModal = memo(function TaskDetailModal({
  task, availableSessions = [], sessionLabels = {}, statusOptions = DEFAULT_BOARD_COLUMNS, showPrompt = true,
  onClose, onSave, onRunInSession, onOpenSession, onDelete,
}: TaskDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prompt, setPrompt] = useState(showPrompt ? task.prompt ?? '' : task.category ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority ?? 'medium');
  const [status, setStatus] = useState<BoardTask['status']>(task.status);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([...(task.associatedSessionIds ?? [])]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const baseRevision = useRef(task.revision);
  const close = () => { if (!submitting.current) onClose(); };
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
    if (!title.trim()) { setError('Task title is required.'); return; }
    submitting.current = true; setPending(true); setError(null);
    try {
      await onSave({ title: title.trim(), description, prompt: showPrompt ? prompt : undefined,
        category: showPrompt ? undefined : prompt, priority, status,
        revision: baseRevision.current, associatedSessionIds: selectedSessionIds });
      setIsEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The update failed. Your draft is retained.');
    } finally {
      submitting.current = false; setPending(false);
    }
  };

  return (
    <div
      data-task-detail-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-shell/40 backdrop-blur-xs p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={`flex max-h-[min(920px,calc(100vh-3rem))] w-[calc(100vw-3rem)] ${DIALOG_PANEL_SIZES.xl} flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_20px_60px_-20px_rgba(28,25,23,0.45)] font-sans text-ink`}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-paper/50 px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="shrink-0 font-mono text-[12px] font-semibold uppercase tracking-wider text-accent">
              Task Details
            </span>
            <span className="min-w-0 truncate rounded-full border border-hairline bg-paper px-2.5 py-0.5 font-mono text-[10.5px] text-ink-faint">
              {task.recordId ?? task.id}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close detail modal"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Content Area */}
        <div inert={pending} className="min-h-0 flex-1 overflow-y-auto text-[13px]">
          {error ? <p role="alert" className="mx-6 mt-5 rounded-lg border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">{error}</p> : null}
          {task.detailLoaded === false ? <p role="status" className="px-6 pt-5 text-ink-soft">Loading task details…</p> : null}
          {isEditing ? (
            /* Editing Mode: single roomy column, large writing surfaces */
            <div className="space-y-5 p-6">
              <div>
                <label className={FIELD_LABEL}>
                  Title
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
                    Status
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as BoardTask['status'])}
                    className={SELECT_INPUT}
                  >
                    {statusOptions.map((option) => <option key={option.status} value={option.status}>{option.label}</option>)}
                  </select>
                </div>

                <div>
                  <label className={FIELD_LABEL}>
                    Priority
                  </label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className={SELECT_INPUT}
                  >
                    <option value="urgent">P0 紧急</option>
                    <option value="high">P1 高</option>
                    <option value="medium">P2 中</option>
                    <option value="low">P3 低</option>
                  </select>
                </div>
              </div>

              <div>
                <label className={FIELD_LABEL}>
                  Description / Context
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
                  {showPrompt ? 'Execution Prompt' : 'Category / 归类'}
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
                  Associate Existing Session
                </label>
                <select
                  multiple
                  value={selectedSessionIds}
                  onChange={(e) => setSelectedSessionIds(Array.from(e.target.selectedOptions, (option) => option.value).filter(Boolean))}
                  className={`${SELECT_INPUT} min-h-28`}
                >
                  <option value="">-- No session linked --</option>
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
                      {task.priority?.toUpperCase() ?? 'MEDIUM'}
                    </span>
                    <span className="rounded-md border border-hairline bg-paper px-2 py-0.5 font-mono text-[11px] text-ink-soft">
                      状态: {task.status}
                    </span>
                    {task.workspaceTitle ? (
                      <span className="font-mono text-[11.5px] text-ink-faint">
                        📁 工作区: {task.workspaceTitle}
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
                      Description
                    </h4>
                    <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-soft">
                      {task.description}
                    </p>
                  </div>
                ) : null}

                {task.prompt || task.category ? (
                  <div>
                    <h4 className={SECTION_TITLE}>
                      {showPrompt ? 'Assigned Execution Prompt' : 'Category / 归类'}
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
                      Linked Execution Sessions
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                      {task.associatedSessionIds?.length ?? 0} linked
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
                      This card is currently decoupled from any active execution session.
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
                      Execution Attempts History
                    </span>
                    <span className="font-mono text-[10.5px] text-ink-faint">
                      {task.executions.length} attempts
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
                                {exec.result ?? 'RUNNING'}
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
                                View Session →
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
                    <p className="mt-2 break-all text-[11.5px] leading-relaxed text-ink-faint">{task.linkedExecutionIds?.length ? `Linked execution references (status not loaded): ${task.linkedExecutionIds.join(', ')}` : 'No execution references recorded.'}</p>
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
                onClick={() => {
                  if (confirm('Delete this task card?')) onDelete(task.id);
                }}
                className="font-mono text-[12px] text-danger hover:underline"
              >
                Delete Card
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
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={handleSave}
                  className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
                >
                  Save Changes
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
                  Edit Task
                </button>
                {onRunInSession ? (
                  <button
                    type="button"
                    onClick={() => onRunInSession(task.id, selectedSessionIds[0])}
                    className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
                  >
                    Execute In Session ↗
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

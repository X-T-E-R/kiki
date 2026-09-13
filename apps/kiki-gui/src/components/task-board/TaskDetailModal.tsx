import { memo, useEffect, useRef, useState } from 'react';
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
      <div className="flex flex-col w-full max-w-2xl max-h-[90vh] rounded-2xl border border-hairline bg-panel shadow-xl overflow-hidden font-sans text-ink">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5 bg-paper/50">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-accent uppercase tracking-wider">
              Task Details
            </span>
            <span className="rounded-full bg-paper border border-hairline px-2 py-0.5 font-mono text-[10px] text-ink-faint">
              {task.recordId ?? task.id}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close detail modal"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint hover:bg-paper hover:text-ink transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content Area */}
        <div inert={pending} className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 text-[12.5px]">
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
          {task.detailLoaded === false ? <p role="status">Loading task details…</p> : null}
          {isEditing ? (
            /* Editing Mode */
            <div className="space-y-3">
              <div>
                <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                  Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    Status
                  </label>
                  <select
                    value={status}
                    disabled={['done', 'cancelled', 'superseded'].includes(task.status)}
                    onChange={(e) => setStatus(e.target.value as BoardTask['status'])}
                    className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden"
                  >
                    {statusOptions.map((option) => <option key={option.status} value={option.status}>{option.label}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    Priority
                  </label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden"
                  >
                    <option value="urgent">P0 紧急</option>
                    <option value="high">P1 高</option>
                    <option value="medium">P2 中</option>
                    <option value="low">P3 低</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                  Description / Context
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                  {showPrompt ? 'Execution Prompt' : 'Category / 归类'}
                </label>
                <textarea
                  rows={showPrompt ? 4 : 1}
                  maxLength={showPrompt ? undefined : 256}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                  Associate Existing Session
                </label>
                <select
                  multiple
                  value={selectedSessionIds}
                  onChange={(e) => setSelectedSessionIds(Array.from(e.target.selectedOptions, (option) => option.value).filter(Boolean))}
                  className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink focus:border-accent focus:outline-hidden"
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
            /* Readonly View Mode */
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent">
                    {task.priority?.toUpperCase() ?? 'MEDIUM'}
                  </span>
                  <span className="rounded-md bg-paper border border-hairline px-2 py-0.5 font-mono text-[10.5px] text-ink-soft">
                    状态: {task.status}
                  </span>
                  {task.workspaceTitle ? (
                    <span className="font-mono text-[11px] text-ink-faint">
                      📁 工作区: {task.workspaceTitle}
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-2 text-[17px] font-semibold text-ink leading-tight">
                  {task.title}
                </h3>
              </div>

              {task.description ? (
                <div>
                  <h4 className="font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    Description
                  </h4>
                  <p className="mt-1 whitespace-pre-wrap text-ink-soft leading-relaxed">
                    {task.description}
                  </p>
                </div>
              ) : null}

              {task.prompt || task.category ? (
                <div>
                  <h4 className="font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    {showPrompt ? 'Assigned Execution Prompt' : 'Category / 归类'}
                  </h4>
                  <pre className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-hairline bg-paper p-2.5 font-mono text-[11px] text-ink-soft leading-snug">
                    {showPrompt ? task.prompt : task.category}
                  </pre>
                </div>
              ) : null}

              {/* Associated Sessions Section */}
              <div className="rounded-xl border border-hairline bg-paper/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    Linked Execution Sessions
                  </span>
                  <span className="text-[10px] font-mono text-ink-faint">
                    {task.associatedSessionIds?.length ?? 0} linked
                  </span>
                </div>

                {task.associatedSessionIds && task.associatedSessionIds.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {task.associatedSessionIds.map((sid) => (
                      <button
                        key={sid}
                        type="button"
                        onClick={() => onOpenSession?.(sid, task.workspaceId)}
                        className="flex items-center gap-1 rounded-md border border-hairline bg-panel px-2 py-1 font-mono text-[11px] text-ink hover:border-accent hover:text-accent transition-colors"
                      >
                        <span>⌁ Session</span>
                        <span className="text-ink-faint truncate max-w-28">{sid}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-ink-faint">
                    This card is currently decoupled from any active execution session.
                  </p>
                )}
              </div>

              <BoardAssociatedTodos
                sessionIds={task.associatedSessionIds ?? []}
                sessionLabels={sessionLabels}
              />

              {/* Execution Attempts History */}
              <div className="rounded-xl border border-hairline bg-paper/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                    Execution Attempts History
                  </span>
                  <span className="text-[10px] font-mono text-ink-faint">
                    {task.executions.length} attempts
                  </span>
                </div>

                {task.executions.length > 0 ? (
                  <ul className="mt-2 space-y-1.5">
                    {task.executions.map((exec) => (
                      <li
                        key={exec.id}
                        className="flex items-center justify-between rounded-lg border border-hairline bg-panel px-2.5 py-1.5 text-[11px]"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-1.5 py-0.2 font-mono text-[9px] font-medium ${
                              exec.result === 'succeeded'
                                ? 'bg-success/10 text-success'
                                : exec.result === 'failed'
                                  ? 'bg-danger/10 text-danger'
                                  : 'bg-accent-soft text-accent'
                            }`}
                          >
                            {exec.result ?? 'RUNNING'}
                          </span>
                          <span className="font-mono text-ink-soft">
                            {exec.sessionId ?? 'session-init'}
                          </span>
                          {exec.error ? (
                            <span className="text-danger truncate max-w-44" title={exec.error}>
                              {exec.error}
                            </span>
                          ) : null}
                        </div>

                        {exec.sessionId && onOpenSession ? (
                          <button
                            type="button"
                            onClick={() => onOpenSession(exec.sessionId!, task.workspaceId)}
                            className="font-mono text-[10px] text-accent hover:underline"
                          >
                            View Session →
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 break-all text-[11px] text-ink-faint">{task.linkedExecutionIds?.length ? `Linked execution references (status not loaded): ${task.linkedExecutionIds.join(', ')}` : 'No execution references recorded.'}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-hairline px-5 py-3 bg-paper/40">
          <div>
            {onDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Delete this task card?')) onDelete(task.id);
                }}
                className="text-[11px] text-danger hover:underline font-mono"
              >
                Delete Card
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {isEditing ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setIsEditing(false)}
                  className="rounded-lg border border-hairline px-3 py-1.5 text-[11.5px] font-medium text-ink-soft hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={handleSave}
                  className="rounded-lg bg-accent px-4 py-1.5 text-[11.5px] font-medium text-panel hover:bg-accent-deep transition-colors shadow-xs"
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
                  className="rounded-lg border border-hairline px-3 py-1.5 text-[11.5px] font-medium text-ink hover:border-accent hover:text-accent transition-colors"
                >
                  Edit Task
                </button>
                {onRunInSession ? (
                  <button
                    type="button"
                    onClick={() => onRunInSession(task.id, selectedSessionIds[0])}
                    className="rounded-lg bg-accent px-4 py-1.5 text-[11.5px] font-medium text-panel hover:bg-accent-deep transition-colors shadow-xs"
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

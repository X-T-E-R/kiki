import { memo, useRef, useState } from 'react';
import type { NewTaskFormData, TaskPriority, BoardWorkspaceOption, BoardSessionOption } from './types';

export interface NewTaskModalProps {
  readonly workspaces?: readonly BoardWorkspaceOption[];
  readonly sessions?: readonly BoardSessionOption[];
  readonly defaultWorkspaceId?: string;
  readonly showPrompt?: boolean;
  readonly onClose: () => void;
  readonly onCreate: (data: NewTaskFormData) => void | Promise<void>;
}

export const NewTaskModal = memo(function NewTaskModal({
  workspaces = [], sessions = [], defaultWorkspaceId, showPrompt = true, onClose, onCreate,
}: NewTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? '');
  const [associatedSessionId, setAssociatedSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const close = () => { if (!submitting.current) onClose(); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!title.trim()) { setError('Task title is required.'); return; }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onCreate({ requestKey, title: title.trim(), description: description.trim(),
        prompt: showPrompt ? prompt.trim() : '', category: showPrompt ? undefined : prompt.trim(),
        priority, workspaceId: workspaceId || undefined, associatedSessionId: associatedSessionId || undefined });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The card was not saved. Your draft is retained.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <div
      data-new-task-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-shell/40 backdrop-blur-xs p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col w-full max-w-lg rounded-2xl border border-hairline bg-panel shadow-xl overflow-hidden font-sans text-ink"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5 bg-paper/50">
          <span className="font-mono text-[11px] font-semibold text-accent uppercase tracking-wider">
            Create Board Task / 新建需求
          </span>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label="Close modal"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-faint hover:bg-paper hover:text-ink transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <div inert={pending} className="p-5 space-y-3.5 text-[12px]">
          {error ? (
            <div className="rounded-md border border-danger/20 bg-danger/10 p-2 text-danger text-[11.5px]">
              {error}
            </div>
          ) : null}

          <div>
            <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
              Task Title *
            </label>
            <input
              type="text"
              autoFocus
              placeholder="e.g. Implement user settings caching layer"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error) setError(null);
              }}
              className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-hidden"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-ink focus:border-accent focus:outline-hidden"
              >
                <option value="urgent">P0 紧急</option>
                <option value="high">P1 高</option>
                <option value="medium">P2 中</option>
                <option value="low">P3 低</option>
              </select>
            </div>

            <div>
              <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
                Workspace Target
              </label>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-ink focus:border-accent focus:outline-hidden"
              >
                <option value="">Current Workspace / 当前工作区</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
              Description / Requirements Context
            </label>
            <textarea
              rows={2}
              placeholder="Background context, acceptance criteria or notes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-ink focus:border-accent focus:outline-hidden"
            />
          </div>

          <div>
            <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
              {showPrompt ? 'Initial Agent Prompt (Optional)' : 'Category / 归类'}
            </label>
            <textarea
              rows={showPrompt ? 3 : 1}
              maxLength={showPrompt ? undefined : 256}
              placeholder={showPrompt ? 'Prompt sent to agent when execution is triggered...' : 'Feature, idea, improvement...'}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 font-mono text-[11px] text-ink focus:border-accent focus:outline-hidden"
            />
          </div>

          <div>
            <label className="block font-mono text-[10.5px] font-semibold text-ink-faint uppercase">
              Associate Existing Session (Optional)
            </label>
            <select
              value={associatedSessionId}
              onChange={(e) => setAssociatedSessionId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline bg-paper px-3 py-1.5 text-ink focus:border-accent focus:outline-hidden"
            >
              <option value="">-- No session linked (decoupled) --</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.id})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3 bg-paper/40">
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-lg border border-hairline px-3 py-1.5 text-[11.5px] font-medium text-ink-soft hover:bg-paper"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-1.5 text-[11.5px] font-medium text-panel hover:bg-accent-deep transition-colors shadow-xs"
          >
            Create Task Card
          </button>
        </div>
      </form>
    </div>
  );
});

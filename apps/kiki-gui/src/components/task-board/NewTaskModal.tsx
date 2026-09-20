import { memo, useRef, useState } from 'react';
import { errorText, LocalizedError, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { DIALOG_PANEL_SIZES } from '../Dialog';
import type { NewTaskFormData, TaskPriority, BoardWorkspaceOption, BoardSessionOption } from './types';

export interface NewTaskModalProps {
  readonly workspaces?: readonly BoardWorkspaceOption[];
  readonly sessions?: readonly BoardSessionOption[];
  readonly defaultWorkspaceId?: string;
  readonly showPrompt?: boolean;
  readonly onClose: () => void;
  readonly onCreate: (data: NewTaskFormData) => void | Promise<void>;
}

const FIELD_LABEL =
  'block font-mono text-[11px] font-semibold text-ink-faint uppercase tracking-wider';
const TEXT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden';
const SELECT_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[12.5px] text-ink focus:border-accent focus:outline-hidden';
const AREA_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3.5 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden';

const PRIORITY_LABEL_KEYS: Record<TaskPriority, I18nKey> = {
  urgent: 'taskBoard.priority.urgent',
  high: 'taskBoard.priority.high',
  medium: 'taskBoard.priority.medium',
  low: 'taskBoard.priority.low',
};

export const NewTaskModal = memo(function NewTaskModal({
  workspaces = [], sessions = [], defaultWorkspaceId, showPrompt = true, onClose, onCreate,
}: NewTaskModalProps) {
  const { t, locale } = useI18n();
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
    if (!title.trim()) { setError(t('taskBoard.new.validation.titleRequired')); return; }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onCreate({ requestKey, title: title.trim(), description: description.trim(),
        prompt: showPrompt ? prompt.trim() : '', category: showPrompt ? undefined : prompt.trim(),
        priority, workspaceId: workspaceId || undefined, associatedSessionId: associatedSessionId || undefined });
    } catch (failure) {
      const fallback = new LocalizedError({ key: 'taskBoard.new.error.createFailed' });
      setError(errorText(locale, failure instanceof Error ? failure : fallback));
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
        className={`flex max-h-[calc(100vh-3rem)] w-[calc(100vw-3rem)] ${DIALOG_PANEL_SIZES.lg} flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-[0_20px_60px_-20px_rgba(28,25,23,0.45)] font-sans text-ink`}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-hairline bg-paper/50 px-6 py-4">
          <span className="font-mono text-[12px] font-semibold uppercase tracking-wider text-accent">
            {t('taskBoard.new.title')}
          </span>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            aria-label={t('taskBoard.new.close')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <div inert={pending} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 text-[13px]">
          {error ? (
            <div className="rounded-lg border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
              {error}
            </div>
          ) : null}

          <div>
            <label className={FIELD_LABEL}>
              {t('taskBoard.new.titleLabel')}
            </label>
            <input
              type="text"
              autoFocus
              placeholder={t('taskBoard.new.titlePlaceholder')}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (error) setError(null);
              }}
              className={TEXT_INPUT}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={FIELD_LABEL}>
                {t('taskBoard.new.priority')}
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

            <div>
              <label className={FIELD_LABEL}>
                {t('taskBoard.new.workspaceTarget')}
              </label>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className={SELECT_INPUT}
              >
                <option value="">{t('taskBoard.new.currentWorkspace')}</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={FIELD_LABEL}>
              {t('taskBoard.new.descriptionContext')}
            </label>
            <textarea
              rows={5}
              placeholder={t('taskBoard.new.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={AREA_INPUT}
            />
          </div>

          <div>
            <label className={FIELD_LABEL}>
              {showPrompt ? t('taskBoard.new.initialPrompt') : t('taskBoard.new.category')}
            </label>
            <textarea
              rows={showPrompt ? 7 : 2}
              maxLength={showPrompt ? undefined : 256}
              placeholder={showPrompt ? t('taskBoard.new.initialPromptPlaceholder') : t('taskBoard.new.categoryPlaceholder')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className={`${AREA_INPUT} font-mono text-[12.5px]`}
            />
          </div>

          <div>
            <label className={FIELD_LABEL}>
              {t('taskBoard.new.associateSession')}
            </label>
            <select
              value={associatedSessionId}
              onChange={(e) => setAssociatedSessionId(e.target.value)}
              className={SELECT_INPUT}
            >
              <option value="">{t('taskBoard.new.noSession')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.id})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-hairline bg-paper/40 px-6 py-4">
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-lg border border-hairline px-3.5 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-paper"
          >
            {t('taskBoard.new.cancel')}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
          >
            {t('taskBoard.new.create')}
          </button>
        </div>
      </form>
    </div>
  );
});

import { memo, useRef, useState } from 'react';
import { errorText, LocalizedError, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useThreadTitleResolver } from '../../lib/threadTitles';
import { SearchableSelect } from '../SearchableSelect';
import { SidePanel } from '../SidePanel';
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
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[14px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden';
const SELECT_INPUT =
  'mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12.5px] text-ink outline-hidden transition-colors hover:border-hairline-strong focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint pointer-coarse:min-h-11';
const AREA_INPUT =
  'mt-1.5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-hidden';

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
  const resolveTitle = useThreadTitleResolver(sessions.map((session) => session.title), sessions);
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
    <SidePanel
      title={t('taskBoard.new.title')}
      overlayId="task-board-new-card"
      width="lg"
      onClose={close}
      data={{ 'data-new-task-modal': '' }}
      footer={(
        <>
          <button
            type="submit"
            form="task-board-new-form"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-medium text-panel shadow-xs transition-colors hover:bg-accent-deep"
          >
            {t('taskBoard.new.create')}
          </button>
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="ml-auto rounded-lg border border-hairline px-3 py-2 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-paper"
          >
            {t('taskBoard.new.cancel')}
          </button>
        </>
      )}
    >
      <form id="task-board-new-form" onSubmit={(event) => { void handleSubmit(event); }} className="flex min-h-0 flex-col">
        <div inert={pending} className="space-y-4 text-[13px]">
          {error ? (
            <div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
              {error}
            </div>
          ) : null}

          <div>
            <label className={FIELD_LABEL}>
              {t('taskBoard.new.titleLabel')}
            </label>
            <input
              type="text"
              data-autofocus
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
              <label htmlFor="new-task-priority" className={FIELD_LABEL}>
                {t('taskBoard.new.priority')}
              </label>
              <SearchableSelect
                id="new-task-priority"
                ariaLabel={t('taskBoard.new.priority')}
                value={priority}
                onChange={(next) => setPriority(next as TaskPriority)}
                options={(Object.keys(PRIORITY_LABEL_KEYS) as TaskPriority[]).map((value) => ({
                  value,
                  label: t(PRIORITY_LABEL_KEYS[value]),
                }))}
                buttonClassName={SELECT_INPUT}
              />
            </div>

            <div>
              <label htmlFor="new-task-workspace" className={FIELD_LABEL}>
                {t('taskBoard.new.workspaceTarget')}
              </label>
              <SearchableSelect
                id="new-task-workspace"
                ariaLabel={t('taskBoard.new.workspaceTarget')}
                value={workspaceId}
                onChange={setWorkspaceId}
                options={[
                  { value: '', label: t('taskBoard.new.currentWorkspace') },
                  ...workspaces.map((ws) => ({ value: ws.id, label: ws.title })),
                ]}
                buttonClassName={SELECT_INPUT}
              />
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
            <label htmlFor="new-task-session" className={FIELD_LABEL}>
              {t('taskBoard.new.associateSession')}
            </label>
            <SearchableSelect
              id="new-task-session"
              ariaLabel={t('taskBoard.new.associateSession')}
              value={associatedSessionId}
              onChange={setAssociatedSessionId}
              options={[
                { value: '', label: t('taskBoard.new.noSession') },
                ...sessions.map((s) => ({
                  value: s.id,
                  label: `${resolveTitle(s.title)} (${s.id})`,
                  keywords: s.id,
                })),
              ]}
              buttonClassName={SELECT_INPUT}
            />
          </div>
        </div>
      </form>
    </SidePanel>
  );
});

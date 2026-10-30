import { useEffect, useState } from 'react';
import type { SessionController, SessionViewState } from '@kiki/session-core/session';
import type { PromptItem } from '@kiki/protocol';
import { useI18n } from '../i18n';

export function RestoreAdmissionStatus({ state, controller }: {
  readonly state: SessionViewState;
  readonly controller: SessionController | null;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const items = (state.durableIngress ?? []).filter(item => item.admission === 'restoring' || item.admission === 'held' || item.admission === 'failed');
  const restoringIds = JSON.stringify(items.filter(item => item.admission === 'restoring').map(item => item.prompt_id));
  useEffect(() => {
    const ids = JSON.parse(restoringIds) as string[];
    if (ids.length === 0 || controller === null) return;
    let next = 0;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void controller.refreshDurablePrompt(ids[next++ % ids.length]!).catch(() => {}).finally(() => { reading = false; });
    }, 1000);
    return () => clearInterval(timer);
  }, [restoringIds, controller]);
  if (items.length === 0) return null;
  const act = async (item: PromptItem, retry: boolean) => {
    if (controller === null) return;
    setPending(item.prompt_id);
    setError(undefined);
    try {
      if (retry) await controller.resumeDurableIngress(item.prompt_id, { content: item.content });
      else await controller.abortPrompt(item.prompt_id);
      await controller.refreshDurableIngress();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setPending(undefined); }
  };
  return <section className="max-h-52 shrink-0 overflow-y-auto border-b border-hairline bg-panel px-4 py-3 text-sm" data-restore-admission>
    {items.map(item => <div key={item.prompt_id} className="flex items-start gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p role="status" className="font-medium text-ink">
          {item.admission === 'restoring'
            ? item.restore_progress?.queue_position !== undefined
              ? t('sv.restore.waiting', { position: item.restore_progress.queue_position })
              : t('sv.restore.active')
            : t(item.admission_duplicate_of === undefined ? 'sv.restore.failed' : 'sv.restore.duplicate')}
          {item.restore_progress !== undefined ? <span className="ml-2 font-mono text-xs font-normal text-ink-muted">{Math.floor(item.restore_progress.elapsed_ms / 1000)}s</span> : null}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-muted">{item.content.filter(part => part.type === 'text').map(part => part.text).join(' ') || t('sv.fileEcho')}</p>
        {item.restore_progress !== undefined ? <p className="mt-1 font-mono text-[11px] text-ink-muted">{item.restore_progress.phase}</p> : null}
        {item.admission_error !== undefined && item.admission_duplicate_of === undefined ? <p className="mt-1 break-words text-xs text-ink-muted">{item.admission_error.message}</p> : null}
      </div>
      <div className="flex shrink-0 gap-2">
        {item.admission !== 'restoring' ? <button type="button" className="rounded-md border border-hairline px-2.5 py-1 text-xs font-medium hover:bg-paper disabled:opacity-50" disabled={pending !== undefined || controller === null} onClick={() => { void act(item, true); }}>{t(item.admission_duplicate_of === undefined ? 'sv.restore.retry' : 'sv.restore.sendSeparately')}</button> : null}
        <button type="button" className="rounded-md px-2.5 py-1 text-xs text-ink-muted hover:bg-paper disabled:opacity-50" disabled={pending !== undefined || controller === null} onClick={() => { void act(item, false); }}>{t('sv.restore.cancel')}</button>
      </div>
    </div>)}
    {error !== undefined ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}
  </section>;
}

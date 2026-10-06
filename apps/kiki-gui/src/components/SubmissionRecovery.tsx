import { useEffect, useState } from 'react';
import { forgetUnconfirmedSubmission, readUnconfirmedSubmissions, restorePromptToDraft } from '@kiki/session-core/composer';
import type { SessionViewState } from '@kiki/session-core/session';
import { useI18n } from '../i18n';

export function SubmissionRecovery({ sessionId, state }: { readonly sessionId: string; readonly state: SessionViewState }) {
  const { t } = useI18n();
  const [items, setItems] = useState(() => readUnconfirmedSubmissions(sessionId));
  const [restored, setRestored] = useState<readonly string[]>([]);
  useEffect(() => {
    const known = new Set([...state.queuedPromptIds, ...state.blocks.flatMap(block => block.kind === 'user' && block.steerStatus === undefined && block.promptId !== undefined ? [block.promptId] : [])]);
    if (state.activePromptId !== undefined) known.add(state.activePromptId);
    const next = items.filter(item => !known.has(item.promptId));
    if (next.length === items.length) return;
    for (const item of items) if (known.has(item.promptId)) forgetUnconfirmedSubmission(sessionId, item.promptId);
    setItems(next);
  }, [sessionId, state, items]);
  if (items.length === 0) return null;
  return <section role="status" className="rounded-lg border border-hairline bg-panel p-3 text-sm" data-submission-recovery>
    <p className="font-medium">{t('sv.submissionRecovery.title')}</p>
    <p className="mt-1 text-ink-muted">{t('sv.submissionRecovery.body')}</p>
    {items.map(item => <details key={item.promptId} className="mt-2 rounded-md border border-hairline p-2">
      <summary className="cursor-pointer truncate">{item.content.filter(part => part.type === 'text').map(part => part.text).join('\n') || t('sv.fileEcho')}</summary>
      <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">{item.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n')}</pre>
      <div className="flex gap-3">
        <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-50" disabled={restored.includes(item.promptId)} onClick={() => {
          restorePromptToDraft(sessionId, item.content);
          setRestored(current => [...current, item.promptId]);
        }}>{t('sv.submissionRecovery.restore')}</button>
        <button type="button" className="rounded-md border border-hairline px-3 py-1.5 text-xs text-ink-muted" onClick={() => {
          forgetUnconfirmedSubmission(sessionId, item.promptId);
          setItems(current => current.filter(entry => entry.promptId !== item.promptId));
        }}>{t('sv.submissionRecovery.dismiss')}</button>
      </div>
    </details>)}
  </section>;
}

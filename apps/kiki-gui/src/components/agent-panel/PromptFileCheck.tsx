import { useEffect, useRef, useState } from 'react';
import type { AgentPromptDiagnostics } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { useOptionalConnection } from '../../state/connection';
import { FilePathLink } from '../mediaParts';
import { agentCapabilitiesErrorText } from './mapCapabilities';

type FileChecks = AgentPromptDiagnostics['file_checks'];
type CheckState = { status: 'idle' | 'checking' } | { status: 'done'; checks: FileChecks } | { status: 'error'; error: unknown };
const CHANNEL_LABEL = {
  prompt_overrides: 'st.promptIdentity.fieldsTitle',
  cognition_overlay: 'st.promptIdentity.overlay',
  cognition_steering: 'st.promptIdentity.steering',
  cognition_anchor: 'st.promptIdentity.anchor',
} as const;

export function PromptFileCheck({ sessionId, agentId, initialChecks }: {
  sessionId: string;
  agentId: string;
  initialChecks?: FileChecks;
}) {
  const { t } = useI18n();
  const klient = useOptionalConnection()?.klient;
  const [state, setState] = useState<CheckState>({ status: 'idle' });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  const check = async () => {
    if (klient === undefined || pending.current !== null) return;
    const controller = new AbortController();
    pending.current = controller;
    setState({ status: 'checking' });
    try {
      const result = await klient.global.agentPanel.read({ session_id: sessionId, agent_id: agentId, check_all_prompt_files: true }, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ status: 'done', checks: result.prompt?.file_checks });
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: 'error', error });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };
  const checks = state.status === 'done' ? state.checks : state.status === 'idle' ? initialChecks : undefined;
  const errors = checks?.filter((entry) => entry.status === 'error').length ?? 0;
  return <section className="min-w-0 space-y-2 pt-6" data-prompt-file-check>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-[12px] font-medium text-ink">{t('agentPanel.prompt.files.title')}</h4>
      <button type="button" data-prompt-file-check-run disabled={klient === undefined || state.status === 'checking'} onClick={() => void check()}
        className="rounded px-2 py-1 text-[12px] text-ink-soft hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:opacity-50">
        {t(state.status === 'checking' ? 'agentPanel.prompt.files.checking' : 'agentPanel.prompt.files.check')}
      </button>
    </div>
    {state.status === 'checking' ? <p role="status" className="text-[11.5px] text-ink-faint">{t('agentPanel.prompt.files.checkingHint')}</p> : null}
    {state.status === 'error' ? <p role="alert" className="break-words text-[12px] leading-5 text-danger">{agentCapabilitiesErrorText(state.error, t)}</p> : null}
    {state.status === 'done' && checks === undefined ? <p role="status" data-prompt-file-check-missing className="text-[12px] leading-5 text-ink-faint">{t('agentPanel.prompt.files.notReported')}</p> : null}
    {checks?.length === 0 ? <p role="status" data-prompt-file-check-empty className="text-[12px] leading-5 text-ink-faint">{t('agentPanel.prompt.files.empty')}</p> : null}
    {checks !== undefined && checks.length > 0 ? <details open={errors > 0 || undefined} data-prompt-file-check-results>
      <summary className={`cursor-pointer rounded py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${errors > 0 ? 'text-danger' : 'text-ink-soft'}`}>
        {t('agentPanel.prompt.files.summary', { count: checks.length, errors })}
      </summary>
      <ul className="space-y-3 pt-2">
        {checks.map((entry, index) => <li key={`${entry.branch}:${entry.path}:${index}`} className="min-w-0 space-y-1 text-[11.5px] leading-5" data-prompt-file-status={entry.status}>
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink-soft"><FilePathLink path={entry.path} /></span>
            <span className={`shrink-0 ${entry.status === 'error' ? 'text-danger' : 'text-ink-faint'}`}>{t(`agentPanel.prompt.files.${entry.status}`)}</span>
          </div>
          <p className="break-words text-ink-faint">{[t(`st.promptIdentity.${entry.branch}`), t(CHANNEL_LABEL[entry.channel]), entry.surface, entry.model_alias].filter(Boolean).join(' · ')}</p>
          {entry.reason !== undefined ? <p className="break-words text-danger">{entry.reason}</p> : null}
        </li>)}
      </ul>
    </details> : null}
  </section>;
}

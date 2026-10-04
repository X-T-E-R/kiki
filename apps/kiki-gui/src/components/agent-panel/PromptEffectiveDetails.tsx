import type { AgentCapabilitiesQuery, AgentPromptDiagnostics } from '@kiki/protocol';
import { useI18n } from '../../i18n';
import { FilePathLink } from '../mediaPreview';
import { PromptFileCheck } from './PromptFileCheck';

type PromptEffectiveData = AgentPromptDiagnostics;

const GROUPS = [
  { id: 'system', channels: ['system', 'delegation', 'model_profile', 'cognition_overlay'] },
  { id: 'tool', channels: ['tool'] },
  { id: 'steering', channels: ['cognition_steering'] },
  { id: 'anchor', channels: ['cognition_anchor'] },
] as const;

export function PromptEffectiveDetails({ value, query, unavailable = false, loading = false, defaultOpen = false }: {
  value?: PromptEffectiveData;
  query?: AgentCapabilitiesQuery;
  unavailable?: boolean;
  loading?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  const request = value?.request;
  return <details open={defaultOpen || undefined} data-profile-section="prompt" className="min-w-0 py-1">
    <summary className="cursor-pointer rounded py-1 text-[13px] font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
      {t('agentPanel.prompt.title')}
    </summary>
    {value === undefined ? <p role="status" className="pt-2 text-[12px] leading-5 text-ink-faint" data-prompt-unavailable>
      {t(loading ? 'diagnostics.loading' : unavailable ? 'agentPanel.prompt.unavailable' : 'agentPanel.prompt.notReported')}
    </p> : <div className="min-w-0 space-y-6 pt-3">
      <div className="space-y-1" data-prompt-identity>
        <p className="text-[13px] font-medium text-ink">{t(`agentPanel.prompt.identity.${value.identity.delegation_position}`)}</p>
        <p className="break-words text-[12px] text-ink-soft">{[value.identity.profile, value.identity.model_alias, value.identity.executor].filter(Boolean).join(' · ')}</p>
        {value.binding_revision !== undefined ? <p className="break-all text-[11px] text-ink-faint">{t('agentPanel.prompt.bindingRevision')}: <span className="font-mono">{value.binding_revision}</span></p> : null}
        {value.disk_revision !== undefined ? <p className="break-all text-[11px] text-ink-faint">{t('agentPanel.prompt.diskRevision')}: <span className="font-mono">{value.disk_revision}</span></p> : null}
        {value.disk_changed === true ? <p className="pt-1 text-[12px] leading-5 text-amber-ink" data-prompt-disk-changed>{t('agentPanel.prompt.diskChanged')}</p> : null}
        {value.disk_error !== undefined ? <p className="pt-1 text-[12px] leading-5 text-danger" data-prompt-disk-error>{value.disk_error}</p> : null}
        {value.lease_model_prompts !== undefined ? <p className="pt-1 text-[12px] leading-5 text-ink-soft">{t(`agentPanel.prompt.lease.${value.lease_model_prompts}`)}</p> : null}
      </div>
      {GROUPS.map((group) => {
        const channels = value.channels.filter((entry) => (group.channels as readonly string[]).includes(entry.channel));
        if (channels.length === 0) return null;
        return <section key={group.id} className="min-w-0 space-y-2" data-prompt-channel-group={group.id}>
          <h4 className="text-[12px] font-medium text-ink">{t(`agentPanel.prompt.channel.${group.id}`)}</h4>
          <div className="space-y-3">
            {channels.map((entry, index) => <details key={`${entry.channel}:${entry.id}:${index}`} className="min-w-0" data-prompt-channel={entry.id} data-prompt-state={entry.state}>
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
                <span className="min-w-0 flex-1 break-words font-mono text-[11.5px] text-ink-soft">{entry.id}</span>
                <span className={entry.state === 'shadowed' || entry.state === 'unsupported' ? 'text-amber-ink' : 'text-ink-faint'}>{t(`agentPanel.prompt.state.${entry.state}`)}</span>
                {entry.selection !== undefined ? <span className="w-full text-[11.5px] text-ink-faint">{t(`agentPanel.prompt.selection.${entry.selection}`)}</span> : null}
              </summary>
              <div className="space-y-2 pt-2 text-[11.5px] leading-5 text-ink-soft">
                {entry.reason !== undefined ? <p data-prompt-reason>{entry.reason}</p> : null}
                {entry.anchor_steps !== undefined || entry.anchor_scope !== undefined ? <AnchorWindow steps={entry.anchor_steps} scope={entry.anchor_scope} /> : null}
                {entry.sources.length > 0 ? <ol className="space-y-2" aria-label={t('agentPanel.prompt.sources')}>
                  {entry.sources.map((source, sourceIndex) => <li key={`${source.path}:${sourceIndex}`} className="min-w-0" data-prompt-source>
                    <p className="text-ink-faint">{source.order ?? sourceIndex + 1}. {source.surface} · {source.kind}</p>
                    {source.path !== undefined ? <p className="break-all font-mono text-[11px]"><FilePathLink path={source.path} />{source.line !== undefined ? `:${source.line}` : ''}</p> : null}
                  </li>)}
                </ol> : <p className="text-ink-faint">{t('agentPanel.prompt.noSource')}</p>}
              </div>
            </details>)}
          </div>
        </section>;
      })}
      <section className="min-w-0 space-y-2" data-prompt-request>
        <h4 className="text-[12px] font-medium text-ink">{t('agentPanel.prompt.request')}</h4>
        {request === undefined ? <p className="text-[12px] leading-5 text-ink-faint">{t('agentPanel.prompt.noRequest')}</p> : <div className="space-y-3 text-[12px]">
          <p className="text-ink-soft">{t(request.anchor_applied === undefined ? 'agentPanel.prompt.anchorUnknown' : request.anchor_applied ? 'agentPanel.prompt.anchorApplied' : 'agentPanel.prompt.anchorNotApplied')}</p>
          {request.anchor_steps !== undefined || request.anchor_scope !== undefined ? <AnchorWindow steps={request.anchor_steps} scope={request.anchor_scope} /> : null}
          <dl className="space-y-2">
            <Fact label={t('agentPanel.prompt.requestAt')} value={new Date(request.at).toLocaleString()} />
            {request.model_alias !== undefined ? <Fact label={t('agentPanel.label.model')} value={request.model_alias} /> : null}
            {request.turn_step !== undefined ? <Fact label={t('agentPanel.prompt.step')} value={request.turn_step} /> : null}
            {request.attempt !== undefined ? <Fact label={t('agentPanel.prompt.attempt')} value={request.attempt} /> : null}
            <Fact label={t('agentPanel.prompt.systemHash')} value={request.system_prompt_hash} />
            <Fact label={t('agentPanel.prompt.toolsHash')} value={request.tools_hash} />
            {request.binding_revision !== undefined ? <Fact label={t('agentPanel.prompt.bindingRevision')} value={request.binding_revision} /> : null}
            {request.cognition_revision !== undefined ? <Fact label={t('agentPanel.prompt.cognitionRevision')} value={String(request.cognition_revision)} /> : null}
          </dl>
        </div>}
      </section>
    </div>}
    {query !== undefined && 'session_id' in query ? <PromptFileCheck key={`${query.session_id}:${query.agent_id}`}
      sessionId={query.session_id} agentId={query.agent_id} initialChecks={value?.file_checks} /> : null}
  </details>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 space-y-0.5"><dt className="text-[11.5px] text-ink-faint">{label}</dt><dd className="break-all font-mono text-[11px] leading-5 text-ink-soft">{value}</dd></div>;
}

function AnchorWindow({ steps, scope }: { steps?: number; scope?: 'session' | 'turn' }) {
  const { t } = useI18n();
  return <p className="text-[11.5px] leading-5 text-ink-faint" data-prompt-anchor-window>
    {scope !== undefined ? t(`st.promptIdentity.anchorScope.${scope}`) : null}
    {steps !== undefined ? ` · ${t('agentPanel.prompt.anchorSteps', { count: steps })}` : null}
  </p>;
}

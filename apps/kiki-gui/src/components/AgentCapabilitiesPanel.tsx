import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentCapabilitiesQuery, AgentCapabilityTarget } from '@kiki/protocol';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { ProfileDetailSections } from './agent-panel/ProfileDetailSections';

export function AgentCapabilitiesPanel({ query }: { query: AgentCapabilitiesQuery }) {
  const { klient } = useConnection();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const capabilities = useQuery({
    queryKey: ['agentCapabilities', query],
    queryFn: ({ signal }) => klient.global.agentPanel.read(query, { signal }),
    enabled: open,
    staleTime: 0,
    refetchInterval: false,
    retry: false,
  });
  const data = capabilities.data;
  const live = 'session_id' in query;
  const scope = live ? `${query.session_id} / ${query.agent_id}`
    : `${'cwd' in query ? query.cwd : query.workspace_id} / ${query.profile}`;
  const source = (value: AgentCapabilityTarget['effort_source']) => value === undefined
    ? t('diagnostics.unknown') : t(`diagnostics.source.${value}`);
  return (
    <section data-agent-capabilities className="min-w-0 text-left text-[11.5px]">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }}
        className="flex items-center gap-1.5 rounded-md px-1 py-1 text-ink-soft transition-colors hover:text-accent">
        <span aria-hidden className="text-[9px]">{open ? '▾' : '▸'}</span>{t('diagnostics.title')}
      </button>
      {open ? <div className="mt-1 max-h-60 space-y-2 overflow-y-auto rounded-lg border border-hairline bg-paper p-2.5 sm:max-h-80" data-capability-context={live ? 'live' : 'draft'}>
        <p className="font-medium text-ink">{t(live ? 'diagnostics.live' : 'diagnostics.draft')}</p>
        <p className="break-all font-mono text-[10px] text-ink-faint">{scope}</p>
        {capabilities.isPending ? <p role="status" className="text-ink-soft">{t('diagnostics.loading')}</p> : null}
        {capabilities.isError ? <div role="alert" className="text-danger">
          <p>{t('diagnostics.error')} · {capabilities.error.message}</p>
          <button type="button" onClick={() => { void capabilities.refetch(); }} className="mt-1 underline">{t('common.retry')}</button>
        </div> : null}
        {!capabilities.isError && data !== undefined ? <>
          {data.owner.profile !== undefined ? <p className="break-all text-ink-soft">{t('agentPanel.profileDetail')} · {data.owner.profile}</p> : null}
          {data.profile !== undefined ? <details data-profile-details className="rounded border border-hairline bg-panel p-2">
            <summary className="cursor-pointer font-medium text-ink hover:text-accent">{t('agentPanel.profileDetail')} · {t('diagnostics.source')}</summary>
            <div className="mt-2">
              <ProfileDetailSections profile={data.profile} query={query} />
            </div>
          </details> : null}
          {data.tools !== undefined ? [...new Set(data.tools.map((tool) => tool.category))].map((category) => <details key={category} data-tool-category={category}>
            <summary>{category} · {data.tools!.filter((tool) => tool.category === category).length}</summary>
            {data.tools!.filter((tool) => tool.category === category).map((tool) => <p key={tool.name} className="break-words">
              {tool.name} · {tool.source} · {tool.state}{tool.unavailable_reason === undefined ? '' : ` · ${tool.unavailable_reason}`}
            </p>)}
          </details>) : null}
          {data.skills !== undefined ? <details data-skill-sources><summary>{t('st.section.skills')} · {data.skills.length}</summary>
            {data.skills.map((skill) => <p key={`${skill.source}:${skill.path}`} className="break-words">{skill.name} · {skill.source} · {skill.state}</p>)}
          </details> : null}
          {!data.available ? <p role="status" className="break-words text-danger">{t('diagnostics.unavailable')} · {data.unavailable_reason ?? t('diagnostics.unknown')}</p> : null}
          {data.targets.length === 0 ? <p className="text-ink-faint">{t('diagnostics.empty')}</p> : null}
          {data.targets.map((target, index) => <article key={`${target.profile}:${target.route ?? ''}:${index}`} className="space-y-1 rounded-md border border-hairline bg-panel p-2" data-capability-target={target.profile}>
            <p className="break-all font-mono font-medium text-ink">{target.profile}{target.route === undefined ? '' : ` / ${target.route}`}</p>
            {target.description !== undefined ? <p className="break-words text-ink-soft">{target.description}</p> : null}
            <p className="break-all text-ink-soft">{t('diagnostics.executor')} · {target.executor}</p>
            <p className="break-all text-ink">{t('diagnostics.model')} · {target.model_alias ?? t('diagnostics.unknown')}</p>
            <p className="text-[10.5px] text-ink-faint">{t('diagnostics.source')} · {source(target.model_source)}</p>
            <p className="break-all text-ink">{t('diagnostics.effort')} · {target.thinking_effort ?? t('diagnostics.unknown')}</p>
            <p className="text-[10.5px] text-ink-faint">{t('diagnostics.source')} · {source(target.effort_source)}</p>
            <p className={target.defaults_available ? 'text-success' : 'text-danger'}>{t(target.defaults_available ? 'diagnostics.defaultsReady' : 'diagnostics.defaultsMissing')}</p>
            {target.unavailable_reason !== undefined ? <p className="break-words text-danger">{target.unavailable_reason}</p> : null}
            {live && data.context === 'live' ? <>
              <p className={target.launch_allowed === true ? 'text-success' : 'text-ink-soft'}>{target.launch_allowed === undefined ? t('diagnostics.unknown') : t(target.launch_allowed ? 'diagnostics.allowed' : 'diagnostics.blocked')}</p>
              {target.launch_unavailable_reason !== undefined ? <p className="break-words text-danger">{target.launch_unavailable_reason}</p> : null}
              {target.execution_restriction === 'research-readonly' ? <p className="text-accent">{t('diagnostics.readonly')}</p> : null}
            </> : null}
          </article>)}
        </> : null}
      </div> : null}
    </section>
  );
}

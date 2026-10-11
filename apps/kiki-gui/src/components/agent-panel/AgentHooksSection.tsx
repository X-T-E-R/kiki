import { memo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentHooksInspect } from '@kiki/protocol';
import { ApiError } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { InspectorChevron, INSPECTOR_HEAD } from './InspectorSection';

export interface AgentHooksSectionProps {
  readonly sessionId: string;
  readonly agentId: string;
}

/**
 * A 404 (older server without the route) reads as "cannot show", a quiet
 * absence like other capability gaps — not a retryable failure.
 */
function isHooksUnsupportedError(error: unknown): boolean {
  if (error instanceof ApiError && error.code === 404) return true;
  const message = error instanceof Error ? error.message : '';
  return /unknown (route|service)|not found|unsupported/i.test(message);
}

function QuietHead() {
  const { t } = useI18n();
  return <h3 className="flex h-8 items-center gap-1.5"><span className={INSPECTOR_HEAD}>{t('agentPanel.hooks')}</span></h3>;
}

/**
 * `absent` is a source file that was never written, which is the same as no
 * configuration. Only a source that failed to load is a fault worth reading.
 */
function faultySources(inspect: AgentHooksInspect): AgentHooksInspect['sources'] {
  return inspect.sources.filter((source) => source.status === 'invalid' || source.status === 'unavailable');
}

function SourceList({ sources }: { readonly sources: AgentHooksInspect['sources'] }) {
  return (
    <ul data-agent-hooks-sources className="mt-2 space-y-0.5">
      {sources.map((source) => (
        <li key={`${source.namespace}:${source.path}`} className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-ink-faint">
          <span className="min-w-0 truncate font-mono" title={source.path}>{source.path}</span>
          <span className="shrink-0">{source.status}</span>
        </li>
      ))}
    </ul>
  );
}

function DiagnosticList({ diagnostics }: { readonly diagnostics: AgentHooksInspect['diagnostics'] }) {
  return (
    <ul data-agent-hooks-diagnostics className="mt-1 space-y-0.5">
      {diagnostics.map((diagnostic, index) => (
        <li key={index} className="text-[11px] leading-snug text-ink-faint">
          <span className="font-mono">{diagnostic.path}</span>{diagnostic.hookId !== undefined ? ` (${diagnostic.hookId})` : ''}: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

function RuleRow({ rule }: { readonly rule: AgentHooksInspect['rules'][number] }) {
  const { t } = useI18n();
  return (
    <li data-agent-hooks-rule={rule.id} className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[12.5px] font-medium text-ink-soft">{rule.id}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">{rule.event}</span>
        {!rule.active ? (
          <span data-agent-hooks-inactive className="shrink-0 rounded-sm bg-ink/[0.06] px-1 text-[10.5px] leading-4 text-ink-faint">
            {t('agentPanel.hooks.inactive')}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-ink-faint">
        <span className="min-w-0 truncate font-mono" title={rule.path}>{rule.path}</span>
        {rule.completedSteps > 0 ? (
          <span className="shrink-0 tabular-nums">{t('agentPanel.hooks.steps', { count: rule.completedSteps })}</span>
        ) : null}
        {rule.nextDue !== undefined ? (
          <span className="shrink-0 tabular-nums">{t('agentPanel.hooks.nextDue', { step: rule.nextDue })}</span>
        ) : null}
      </div>
      {!rule.active && rule.reason !== undefined ? (
        <p className="text-[11px] leading-snug text-ink-faint">{rule.reason}</p>
      ) : null}
    </li>
  );
}

/**
 * The agent panel's on-demand answer to "which rules run for this agent, and
 * from where". Closed it is one summary line; open it lists each rule's id,
 * source path, event, active flag and cadence state. Rule text itself stays on
 * disk — the inspect payload deliberately omits it.
 *
 * An agent with nothing configured has no chapter here at all: a heading over
 * an empty line only teaches the reader to ignore the rail. What must stay
 * visible is the opposite case — a source that failed to load or a diagnostic
 * the user has to act on renders the chapter even when no rule survived.
 */
export const AgentHooksSection = memo(function AgentHooksSection({ sessionId, agentId }: AgentHooksSectionProps) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [open, setOpen] = useState(false);
  const inspect = useQuery({
    queryKey: ['agent-hooks-inspect', sessionId, agentId],
    queryFn: () => client.getAgentHooksInspect(sessionId, agentId),
    refetchInterval: open ? 10_000 : false,
    retry: false,
  });

  if (inspect.isPending) {
    return <section data-agent-hooks-section data-agent-hooks-state="loading">
      <QuietHead />
      <p role="status" className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">{t('agentPanel.hooks.loading')}</p>
    </section>;
  }
  if (inspect.isError) {
    if (isHooksUnsupportedError(inspect.error)) {
      return <section data-agent-hooks-section data-agent-hooks-state="unavailable">
        <QuietHead />
        <p className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">{t('agentPanel.hooks.unavailable')}</p>
      </section>;
    }
    return <section data-agent-hooks-section data-agent-hooks-state="failed">
      <QuietHead />
      <p role="alert" className="pb-0.5 text-[12px] leading-relaxed text-ink-faint">
        {t('agentPanel.hooks.loadFailed')}{' '}
        <button
          type="button"
          data-agent-hooks-retry
          onClick={() => { void inspect.refetch(); }}
          className="font-medium text-selected-ink transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
        >
          {t('common.retry')}
        </button>
      </p>
    </section>;
  }

  const rules = [...inspect.data.rules].sort((a, b) => a.order - b.order);
  const degradedSources = faultySources(inspect.data);
  const diagnostics = inspect.data.diagnostics;
  if (rules.length === 0 && degradedSources.length === 0 && diagnostics.length === 0) {
    return null;
  }
  const activeCount = rules.filter((rule) => rule.active).length;
  const faulty = degradedSources.length > 0 || diagnostics.length > 0;
  return (
    <section data-agent-hooks-section data-agent-hooks-state={faulty ? 'faulty' : 'ready'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="group -ml-1.5 flex min-h-8 w-[calc(100%+0.375rem)] min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left transition-colors hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
      >
        <span className={`${INSPECTOR_HEAD} transition-colors group-hover:text-ink`}>{t('agentPanel.hooks')}</span>
        {!open ? (
          <span data-agent-hooks-summary className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">
            {faulty
              ? t('agentPanel.hooks.summaryFaulty')
              : t('agentPanel.hooks.summary', { count: activeCount })}
          </span>
        ) : <span className="flex-1" />}
        <InspectorChevron open={open} />
      </button>
      {open ? (
        <div className="pt-1">
          {rules.length > 0 ? (
            <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-y-contain pr-0.5">
              {rules.map((rule) => <RuleRow key={`${rule.path}:${rule.id}`} rule={rule} />)}
            </ul>
          ) : null}
          {degradedSources.length > 0 ? <SourceList sources={degradedSources} /> : null}
          {diagnostics.length > 0 ? <DiagnosticList diagnostics={diagnostics} /> : null}
        </div>
      ) : null}
    </section>
  );
});

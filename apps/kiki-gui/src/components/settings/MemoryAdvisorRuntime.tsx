import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import type { MemoryAdvisorConfig, MemoryAdvisorStatus } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { memoryAdvisorReasonKey, memoryAdvisorView } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint } from '../controls';
import { RelativeTime } from '../RelativeTime';
import { SECONDARY_BUTTON } from '../ui';
import { SettingField } from './fields';
import { SettingsSelect } from './SettingsPrimitives';

const TONE_TEXT = { muted: 'text-ink-soft', ok: 'text-ink', caution: 'text-amber-ink', danger: 'text-danger' } as const;

interface RuntimeRead {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status: MemoryAdvisorStatus | null;
  readonly at: string;
}

/**
 * What the advisor actually did in one running agent: the settings above say
 * what is configured; this says whether the last call timed out, was refused
 * or recommended something. Read on request only. A session that is not
 * loaded answers `null` and stays that way: nothing here starts or resumes it.
 */
export function MemoryAdvisorRuntime({ workspaceId, config }: {
  readonly workspaceId?: string;
  readonly config: MemoryAdvisorConfig | undefined;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const sessionsQuery = useQuery({
    queryKey: ['memory-advisor-runtime-sessions', workspaceId ?? null],
    queryFn: () => client.listSessions({ workspace_id: workspaceId, page_size: 20, exclude_empty: true }),
    staleTime: 15_000,
  });
  const sessions = sessionsQuery.data?.items ?? [];
  const [picked, setPicked] = useState<string | undefined>();
  const sessionId = sessions.some((session) => session.id === picked) ? picked : sessions[0]?.id;
  const [agentId, setAgentId] = useState('main');
  const read = useMutation({
    mutationFn: async (target: { sessionId: string; agentId: string }): Promise<RuntimeRead> => ({
      ...target,
      status: await client.getMemoryAdvisorStatus(target.sessionId, target.agentId),
      at: new Date().toISOString(),
    }),
  });
  const agent = agentId.trim() === '' ? 'main' : agentId.trim();
  // A result belongs to the session and agent it was read for. Picking
  // another one hides it instead of showing the previous session's numbers.
  const current = read.data !== undefined && read.data.sessionId === sessionId && read.data.agentId === agent ? read.data : undefined;
  const failure = read.isError && read.variables?.sessionId === sessionId && read.variables.agentId === agent ? read.error : undefined;

  return (
    <div data-memory-advisor-runtime className="space-y-1 pt-3">
      <p className="text-[13px] font-medium text-ink">{t('memory.advisor.runtime')}</p>
      <Hint>{t('memory.advisor.runtimeHint')}</Hint>
      {sessions.length === 0 && !sessionsQuery.isPending ? (
        <p data-memory-advisor-runtime-empty className="py-1 text-[12px] text-ink-faint">{t('memory.advisor.runtimeNoSessions')}</p>
      ) : sessionId !== undefined ? (
        <>
          <SettingField label={t('memory.advisor.runtimeSession')}>
            <SettingsSelect id="memory-advisor-runtime-session" dataAttr="data-memory-advisor-runtime-session" ariaLabel={t('memory.advisor.runtimeSession')}
              className="max-w-64" value={sessionId} onChange={setPicked}
              choices={sessions.map((session) => ({
                value: session.id,
                label: session.title.trim() === '' ? t('sidebar.untitled') : session.title,
                hint: session.busy ? t('memory.advisor.runtimeBusy') : undefined,
              }))} />
          </SettingField>
          <SettingField label={t('memory.advisor.runtimeAgent')} htmlFor="memory-advisor-runtime-agent">
            <input id="memory-advisor-runtime-agent" data-memory-advisor-runtime-agent className="h-8 w-28 rounded-md border border-hairline bg-paper px-3 font-mono text-[12px] text-ink outline-none transition-colors hover:border-hairline-strong focus:border-selected-ink"
              value={agentId} spellCheck={false} autoComplete="off" onChange={(event) => { setAgentId(event.target.value); }} />
            <button type="button" data-memory-advisor-runtime-read className={SECONDARY_BUTTON} disabled={read.isPending}
              onClick={() => { read.mutate({ sessionId, agentId: agent }); }}>
              {read.isPending ? t('memory.advisor.runtimeReading') : t('memory.advisor.runtimeRead')}
            </button>
          </SettingField>
        </>
      ) : null}
      {failure !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: t('memory.advisor.runtimeFailed', { detail: errorText(locale, failure) }) }} /> : null}
      {current !== undefined ? <RuntimeResult read={current} config={config} /> : null}
    </div>
  );
}

function RuntimeResult({ read, config }: { readonly read: RuntimeRead; readonly config: MemoryAdvisorConfig | undefined }) {
  const { t } = useI18n();
  const status = read.status;
  if (status === null) {
    return (
      <p data-memory-advisor-runtime-result="none" role="status" className="py-1 text-[12px] leading-snug text-ink-soft">
        {t('memory.advisor.runtimeNone')}
      </p>
    );
  }
  const view = memoryAdvisorView(config, status);
  const reasonKey = memoryAdvisorReasonKey(status.reason);
  const facts: [string, string | number][] = [
    [t('memory.advisor.runtimeCalls'), status.logical_calls],
    [t('memory.advisor.runtimeRequests'), status.requests],
    [t('memory.advisor.runtimeRetries'), status.retries],
    [t('memory.advisor.runtimeRecommended'), status.recommended_count ?? 0],
    [t('memory.advisor.runtimeDisplaced'), status.displaced_ids.length],
    [t('memory.advisor.runtimeUnjudged'), status.unjudged_count],
  ];
  if (status.enumeration !== undefined) facts.push([t('memory.advisor.runtimeCoverage'), t(`memory.advisor.coverage.${status.enumeration}`)]);
  return (
    <div data-memory-advisor-runtime-result={status.state} role="status" className="space-y-1.5 pt-1">
      <p className={`text-[13px] ${TONE_TEXT[view.tone]}`}>
        {t(`memory.advisor.state.${status.state}`)}
        {reasonKey !== undefined ? <span data-memory-advisor-runtime-reason className="ml-2 text-[12px]">{t(reasonKey)}</span> : null}
      </p>
      <dl className="grid max-w-md grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-2">
            <dt className="truncate text-ink-faint">{label}</dt>
            <dd className="font-mono tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-ink-faint">
        {t('memory.advisor.runtimeReadAt')} <RelativeTime at={read.at} />
      </p>
    </div>
  );
}

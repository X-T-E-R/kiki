import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { experimentalFlagRows } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

const TOOL_FLAGS = new Set(['tool-select', 'task_wait']);
const FLAG_COPY = {
  'tool-select': 'st.experimental.toolSelect',
  task_wait: 'st.experimental.taskWait',
  search_worker: 'st.experimental.searchWorker',
  persistence_minidb_readmodel: 'st.experimental.readModel',
  auto_session_title: 'st.experimental.sessionTitle',
  subagent_release_idle: 'st.experimental.subagentIdle',
  'agent-profile-routes': 'st.experimental.agentRoutes',
  external_delegation_mcp: 'st.experimental.delegation',
  task_board: 'st.experimental.taskBoard',
} as const;
const KNOWN_FEATURE_IDS = new Set(Object.keys(FLAG_COPY));

export interface ExperimentalSectionProps {
  /** Keep the old tools-only slice available while the controls are re-homed. */
  toolsOnly?: boolean;
  /** Restrict the card to flags owned by one capability page. */
  featureIds?: readonly string[];
  /** Include server-specific extension flags in addition to featureIds. */
  includeUnknown?: boolean;
  /** Override the capability card's heading and anchor. */
  titleKey?: I18nKey;
  cardId?: string;
  /** Render the advanced feature card closed until the user asks for details. */
  collapsible?: boolean;
  summaryKey?: I18nKey;
  /** Extra controls rendered inside the same card after the flag rows. */
  children?: ReactNode;
}

export function ExperimentalSection({
  toolsOnly = false,
  featureIds,
  includeUnknown = false,
  titleKey,
  cardId,
  collapsible = false,
  summaryKey = 'st.advanced.performanceSummary',
  children,
}: ExperimentalSectionProps) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const metaQuery = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });

  const merge = (base: Record<string, boolean>) => {
    const next = { ...base };
    for (const [id, value] of Object.entries(changes)) {
      if (value === null) delete next[id];
      else next[id] = value;
    }
    return next;
  };
  const rows = experimentalFlagRows(metaQuery.data ?? {}, { experimental: merge(configQuery.data?.experimental ?? {}) })
    .filter((row) => {
      if (featureIds !== undefined) {
        return featureIds.includes(row.id) || (includeUnknown && !KNOWN_FEATURE_IDS.has(row.id));
      }
      return TOOL_FLAGS.has(row.id) === toolsOnly;
    });
  const queryPending = metaQuery.isLoading || configQuery.isLoading;
  const queryError = metaQuery.isError || configQuery.isError;
  if (featureIds !== undefined && !includeUnknown && !queryPending && !queryError && rows.length === 0) return null;

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const latest = await client.getConfig();
      const echoed = await client.patchConfig({
        experimental: merge(latest.experimental ?? {}),
        replace_domains: ['experimental'],
      });
      queryClient.setQueryData(['config'], echoed);
      setChanges({});
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      setFeedback({ tone: 'success', text: t('st.experimental.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <div className="space-y-3">
      <details className="text-[12px] text-ink-soft">
        <summary className="cursor-pointer">{t('st.experimental.prioritySummary')}</summary>
        <p className="mt-1">{t('st.experimental.priority')}</p>
        <p className="mt-1">{t('st.experimental.priorityDetails')}</p>
      </details>
      {metaQuery.isLoading || configQuery.isLoading ? <Hint>{t('st.runtime.loading')}</Hint> : null}
      <fieldset disabled={saving || configQuery.data === undefined} className="min-w-0 space-y-2 disabled:opacity-60">
        {rows.map((row) => {
          const copy = FLAG_COPY[row.id as keyof typeof FLAG_COPY];
          const featureLabel = t(copy ?? 'st.experimental.unknownFeature');
          const effective = metaQuery.data?.experimental_flags?.[row.id];
          return (
            <div key={row.id} className="grid gap-2 border-b border-hairline py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <p className="text-[13px] text-ink">{featureLabel}</p>
                <details data-technical-details className="text-[11px] text-ink-soft">
                  <summary className="cursor-pointer">{t('st.experimental.technicalDetails')}</summary>
                  <p className="mt-1 break-all font-mono">{t('st.experimental.flagId', { id: row.id })}</p>
                </details>
                <p className="text-[12px] text-ink-soft">{t(effective === undefined ? 'st.experimental.effectiveUnknown' : effective ? 'st.experimental.effectiveOn' : 'st.experimental.effectiveOff')}</p>
                {effective !== undefined && row.override !== undefined && effective !== row.override ? <p className="text-[12px] text-ink-soft">{t('st.experimental.mismatch')}</p> : null}
              </div>
              <label className="grid gap-1 text-[12px] text-ink">
                {t('st.experimental.configChoice')}
                <select className={SMALL_INPUT} aria-label={t('st.experimental.overrideLabel', { feature: featureLabel })} value={row.override === undefined ? 'inherit' : String(row.override)} onChange={(event) => {
                  setChanges((current) => ({ ...current, [row.id]: event.target.value === 'inherit' ? null : event.target.value === 'true' }));
                  setFeedback(null);
                }}>
                  <option value="inherit">{t('st.experimental.inherited')}</option>
                  <option value="true">{t('st.experimental.configOn')}</option>
                  <option value="false">{t('st.experimental.configOff')}</option>
                </select>
              </label>
            </div>
          );
        })}
        {rows.length === 0 && !metaQuery.isLoading && !configQuery.isLoading ? <Hint>{t('st.experimental.empty')}</Hint> : null}
      </fieldset>
      <button type="button" className={PRIMARY_BUTTON} disabled={saving || Object.keys(changes).length === 0} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
      {metaQuery.isError ? <InlineError error={metaQuery.error} /> : null}
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );

  return (
    <SectionCard
      id={cardId ?? (toolsOnly ? 'st-card-tool-experiments' : 'st-card-experimental')}
      title={t(titleKey ?? (toolsOnly ? 'st.experimental.toolsTitle' : 'st.experimental.title'))}
    >
      {collapsible ? (
        <details>
          <summary className="cursor-pointer text-[12px] text-ink-soft">{t(summaryKey)}</summary>
          <div className="mt-3">{body}</div>
        </details>
      ) : body}
      {children}
    </SectionCard>
  );
}

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { experimentalFlagRows } from '@kiki/session-core/settings';
import type { KikiConfigPatch, KikiConfigResponse } from '@kiki/session-core/transport';
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

function effectiveBadgeClass(effective: boolean | undefined): string {
  if (effective === true) {
    return 'border-success/40 bg-success/10 text-success';
  }
  if (effective === false) {
    return 'border-hairline bg-paper text-ink-soft';
  }
  return 'border-hairline bg-paper text-ink-faint';
}

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
  /** Whether extra child controls have unsaved changes. */
  extraDirty?: boolean;
  /** Called during save to contribute extra domain patches (e.g. session_title). */
  onSaveExtra?: () => KikiConfigPatch | null | Promise<KikiConfigPatch | null>;
  /** Called after successful save with the server's echoed config. */
  onSavedExtra?: (echoed: KikiConfigResponse) => void;
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
  extraDirty = false,
  onSaveExtra,
  onSavedExtra,
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

  const hasFlagChanges = Object.keys(changes).length > 0;
  const dirty = hasFlagChanges || extraDirty;

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const latest = await client.getConfig();
      const extraPatch = onSaveExtra ? await onSaveExtra() : null;
      const replaceDomains = new Set<string>();
      if (hasFlagChanges) {
        replaceDomains.add('experimental');
      }
      for (const domain of extraPatch?.replace_domains ?? []) {
        replaceDomains.add(domain);
      }

      const patch: KikiConfigPatch = {
        ...(hasFlagChanges || latest.experimental !== undefined
          ? { experimental: merge(latest.experimental ?? {}) }
          : {}),
        ...(extraPatch ?? {}),
        replace_domains: replaceDomains.size > 0 ? [...replaceDomains] : undefined,
      };

      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setChanges({});
      await queryClient.invalidateQueries({ queryKey: ['meta'] });
      onSavedExtra?.(echoed);
      setFeedback({ tone: 'success', text: t('st.experimental.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const isSingleFlagCard = rows.length === 1 && featureIds?.length === 1;

  const body = (
    <div className="space-y-3">
      {metaQuery.isLoading || configQuery.isLoading ? <Hint>{t('st.runtime.loading')}</Hint> : null}
      <fieldset disabled={saving || configQuery.data === undefined} className="min-w-0 space-y-3 disabled:opacity-60">
        {rows.map((row) => {
          const copy = FLAG_COPY[row.id as keyof typeof FLAG_COPY];
          const featureLabel = t(copy ?? 'st.experimental.unknownFeature');
          const effective = metaQuery.data?.experimental_flags?.[row.id];
          const isMismatch = effective !== undefined && row.override !== undefined && effective !== row.override;

          return (
            <div
              key={row.id}
              className={`space-y-2 ${isSingleFlagCard ? 'py-1' : 'border-b border-hairline py-3 last:border-b-0'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 flex flex-wrap items-center gap-2">
                  {!isSingleFlagCard ? (
                    <span className="text-[13px] font-medium text-ink">{featureLabel}</span>
                  ) : null}
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-wide ${effectiveBadgeClass(effective)}`}
                  >
                    {t(
                      effective === undefined
                        ? 'st.experimental.effectiveUnknown'
                        : effective
                          ? 'st.experimental.effectiveOn'
                          : 'st.experimental.effectiveOff',
                    )}
                  </span>
                  {isMismatch ? (
                    <span
                      className="inline-flex items-center rounded-full border border-amber-rule/60 bg-amber-card px-2 py-0.5 text-[10px] font-medium text-amber-ink"
                      title={t('st.experimental.mismatch')}
                    >
                      {t('st.experimental.mismatchBadge')}
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor={`experimental-flag-${row.id}`} className="text-[12px] text-ink-soft shrink-0">
                    {t('st.experimental.configChoice')}
                  </label>
                  <select
                    id={`experimental-flag-${row.id}`}
                    className={SMALL_INPUT}
                    aria-label={t('st.experimental.overrideLabel', { feature: featureLabel })}
                    value={row.override === undefined ? 'inherit' : String(row.override)}
                    onChange={(event) => {
                      setChanges((current) => ({
                        ...current,
                        [row.id]: event.target.value === 'inherit' ? null : event.target.value === 'true',
                      }));
                      setFeedback(null);
                    }}
                  >
                    <option value="inherit">{t('st.experimental.inherited')}</option>
                    <option value="true">{t('st.experimental.configOn')}</option>
                    <option value="false">{t('st.experimental.configOff')}</option>
                  </select>
                </div>
              </div>

              <details data-technical-details className="text-[11px] text-ink-soft">
                <summary className="cursor-pointer select-none text-ink-faint hover:text-ink-soft transition-colors">
                  {t('st.experimental.rulesAndDetails')}
                </summary>
                <div className="mt-1.5 space-y-1 rounded-md border border-hairline/60 bg-paper/60 p-2.5 text-[11px] text-ink-soft leading-relaxed">
                  <p className="font-mono text-[10.5px] text-ink-faint">{t('st.experimental.flagId', { id: row.id })}</p>
                  <p>{t('st.experimental.priority')}</p>
                  <p className="text-ink-faint">{t('st.experimental.priorityDetails')}</p>
                  {isMismatch ? (
                    <p className="text-[11px] font-medium text-amber-ink">{t('st.experimental.mismatch')}</p>
                  ) : null}
                </div>
              </details>
            </div>
          );
        })}
        {rows.length === 0 && !metaQuery.isLoading && !configQuery.isLoading ? <Hint>{t('st.experimental.empty')}</Hint> : null}
      </fieldset>

      {children}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {dirty ? <span className="text-[11px] font-medium text-amber-ink">{t('st.tools.unsaved')}</span> : null}
      </div>

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
    </SectionCard>
  );
}

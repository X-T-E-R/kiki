/**
 * Which service decides, for each job that asks one. A source is a decision
 * connection (with its default model or a named one) or a chat model; each
 * job stores its own pointer, so changing one never changes another, and the
 * key stays with the connection. The consumer cards show the choice read-only
 * and link here.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { DecisionSource, DecisionSourceStatus, ProviderCatalogItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import {
  DECISION_CONNECTION_ADD_ROUTE,
  DECISION_JUDGES_ROUTE,
  DECISION_SOURCE_PROBLEM_KEYS,
  decisionProtocolAllowed,
  decisionProtocolOf,
  decisionSourceFromValue,
  decisionSourceProblem,
  decisionSourceValue,
  decisionSourceWithModel,
  decisionConnectionRoute,
  isDecisionConnection,
  sameDecisionSource,
  type DecisionConsumer,
  type DecisionSourceProblem,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDirtyReporter, useGuardedNavigate } from '../dirtyGuard';
import { useMemoryAdvisor } from '../memory/useMemoryAdvisor';
import { buildCatalogModelOptions, useProviderGroupLabel } from '../modelSelectOptions';
import { hostLabel } from '../providerPresets';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const PICKER =
  'flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-ink/[0.04] px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.07] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint';
const LINK = 'text-[12px] font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink';

const providersQueryOptions = (client: ReturnType<typeof useConnection>['client']) => ({
  queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000,
});

/** The name a person recognizes for a source, used on triggers and summaries. */
function sourceLabel(source: DecisionSource, providers: readonly ProviderCatalogItem[] | undefined, chatLabel: (id: string) => string | undefined): string {
  if (source.kind === 'model') return chatLabel(source.model) ?? source.model;
  const provider = providers?.find((item) => item.id === source.connection);
  const model = source.model ?? provider?.default_model;
  return model === undefined ? source.connection : `${source.connection} · ${model}`;
}

/**
 * One picker over both kinds of source, grouped. Decision services first
 * (the reviewer sees rerank services but cannot pick them: a relevance score
 * is not the chance an action is safe), then every chat model. A saved source
 * that no longer resolves stays visible as "(missing)" so it can be replaced.
 */
export function DecisionSourcePicker({ id, consumer, value, onChange, disabled, ariaLabel }: {
  readonly id: string;
  readonly consumer: DecisionConsumer;
  readonly value: DecisionSource | undefined;
  readonly onChange: (source: DecisionSource | null) => void;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const providersQuery = useQuery(providersQueryOptions(client));
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const groupLabel = useProviderGroupLabel();
  const providers = providersQuery.data?.items;
  const models = modelsQuery.data?.items ?? [];
  // Only once both lists have loaded can a saved source be called missing.
  const current = decisionSourceValue(value);
  const missing = current !== '' && value !== undefined && providers !== undefined && !modelsQuery.isPending
    && !(value.kind === 'connection'
      ? providers.some((provider) => provider.id === value.connection && isDecisionConnection(provider))
      : models.some((model) => model.id === value.model));
  const options = useMemo<SearchableSelectOption[]>(() => {
    const decision = (providers ?? []).filter(isDecisionConnection).map((provider): SearchableSelectOption => {
      const protocol = decisionProtocolOf(provider) ?? 'system_one';
      const allowed = decisionProtocolAllowed(consumer, protocol);
      return {
        value: `connection:${provider.id}`,
        label: provider.id,
        hint: [hostLabel(provider.effective_base_url ?? provider.base_url), provider.default_model].filter(Boolean).join(' · ') || undefined,
        description: allowed ? undefined : t('st.decision.picker.pairScoreOnly'),
        badges: [{ label: t(`st.decision.protocol.${protocol}`) }],
        group: t('st.decision.picker.groupDecision'),
        disabled: !allowed,
        keywords: `${provider.id} ${provider.base_url ?? ''} ${provider.default_model ?? ''}`,
      };
    });
    const chat = buildCatalogModelOptions(models, t, { groupLabel }).map((option) => ({
      ...option, value: `model:${option.value}`, group: `${t('st.decision.picker.groupChat')} · ${option.group ?? ''}`,
    }));
    const list: SearchableSelectOption[] = [{ value: '', label: t('st.decision.picker.none') }, ...decision, ...chat];
    if (current !== '' && value !== undefined && providers !== undefined && !modelsQuery.isPending && !list.some((option) => option.value === current)) {
      list.splice(1, 0, {
        value: current,
        label: t('st.decision.picker.missing', { id: value.kind === 'connection' ? value.connection : value.model }),
      });
    }
    return list;
  }, [providers, models, consumer, t, groupLabel, value, modelsQuery.isPending]);
  const chatLabel = (modelId: string) => models.find((item) => item.id === modelId)?.display_name;
  return (
    <SearchableSelect id={id} value={decisionSourceValue(value)} options={options} ariaLabel={ariaLabel}
      searchPlaceholder={t('st.decision.picker.search')} emptyText={t('st.decision.picker.none')}
      align="end" placement="auto" disabled={disabled} buttonClassName={PICKER}
      triggerLabel={value === undefined ? undefined
        : missing ? t('st.decision.picker.missing', { id: value.kind === 'connection' ? value.connection : value.model })
          : sourceLabel(value, providers, chatLabel)}
      onChange={(next) => { onChange(next === '' ? null : decisionSourceFromValue(next, value)); }} />
  );
}

/** What a row needs from its consumer: the saved pointer, the server's reading of it, and a writer. */
interface JudgeRowModel {
  readonly consumer: DecisionConsumer;
  readonly source: DecisionSource | undefined;
  readonly status: DecisionSourceStatus | undefined;
  /** An older setting still in effect while no source is saved, in words. */
  readonly legacy?: string;
  readonly loading: boolean;
  readonly error: unknown;
  readonly write: (source: DecisionSource | null) => Promise<void>;
}

/**
 * "Who decides": approval review and Memory Advisor, one row each. A pick
 * saves at once; a model name for a connection is a small draft with its own
 * save. Each row writes only its own consumer's `source`, never the advisor's
 * on/off, so picking a source does not switch anything on.
 */
export function DecisionJudgesCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const advisor = useMemoryAdvisor();
  const reviewer = configQuery.data?.permission?.reviewer;
  const advisorConfig = advisor.data?.advisor;
  const rows: readonly (JudgeRowModel & { readonly label: string; readonly help: string; readonly unset: string })[] = [
    {
      consumer: 'reviewer',
      label: t('st.decision.row.reviewer'),
      help: t('st.decision.row.reviewerHelp'),
      unset: t('st.decision.row.reviewerUnset'),
      source: reviewer?.source,
      status: reviewer?.source_status,
      legacy: reviewer?.source !== undefined ? undefined
        : reviewer?.backend === 'jev' ? t('st.decision.row.reviewerLegacy')
          : reviewer?.model !== undefined ? t('st.reviewer.legacyModel', { model: reviewer.model }) : undefined,
      loading: configQuery.isPending,
      error: configQuery.error,
      write: async (source) => {
        queryClient.setQueryData(['config'], await client.patchConfig({ permission: { reviewer: { source } } }));
      },
    },
    {
      consumer: 'memory',
      label: t('st.decision.row.memory'),
      help: t('st.decision.row.memoryHelp'),
      unset: t('st.decision.row.memoryUnset'),
      source: advisorConfig?.source,
      status: advisor.data?.advisor_status?.source_status,
      legacy: advisorConfig?.source === undefined && advisorConfig?.selector !== undefined
        ? t('st.decision.row.memoryLegacy', { model: advisorConfig.selector.model }) : undefined,
      loading: advisor.query.isPending,
      error: advisor.query.error,
      // Clearing also drops an older model setting, so nothing stays in effect.
      write: async (source) => {
        await advisor.save.mutateAsync({ advisor: source === null && advisorConfig?.selector !== undefined ? { source, selector: null } : { source } });
      },
    },
  ];
  return (
    <SectionCard id="st-card-decision-judges" title={t('st.decision.judgesTitle')}>
      <div className="space-y-3">
        <Hint>{t('st.decision.judgesHint')}</Hint>
        <div className="divide-y divide-hairline">
          {rows.map((row) => <JudgeRow key={row.consumer} {...row} />)}
        </div>
      </div>
    </SectionCard>
  );
}

function JudgeRow({ consumer, label, help, unset, source, status, legacy, loading, error, write }: JudgeRowModel & {
  readonly label: string;
  readonly help: string;
  readonly unset: string;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const providersQuery = useQuery(providersQueryOptions(client));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const connection = source?.kind === 'connection' ? source : undefined;
  const provider = connection === undefined ? undefined : providersQuery.data?.items.find((item) => item.id === connection.connection);
  // The model name is the one free-text part, so it is a draft with its own
  // save; every other change here applies on pick. The draft belongs to the
  // connection it was typed for: another source never inherits it.
  const savedModel = connection?.model ?? '';
  const [modelDraft, setModelDraft] = useState<{ readonly connection: string; readonly value: string } | null>(null);
  const model = modelDraft !== null && modelDraft.connection === connection?.connection ? modelDraft.value : savedModel;
  const setModel = (value: string) => {
    if (connection !== undefined) setModelDraft({ connection: connection.connection, value });
  };
  const modelDirty = connection !== undefined && model.trim() !== savedModel;
  useDirtyReporter(`decision-judge:${consumer}`, modelDirty);
  const [pendingSwitch, setPendingSwitch] = useState<{ readonly next: DecisionSource | null } | null>(null);
  const problem: DecisionSourceProblem | null = decisionSourceProblem(consumer, source, status, providersQuery.data?.items);

  const commit = async (next: DecisionSource | null) => {
    if (busy) return;
    if (next !== null && sameDecisionSource(next, source)) return;
    // Not set with nothing saved and no older setting in effect: nothing to clear.
    if (next === null && source === undefined && legacy === undefined) return;
    setBusy(true);
    setFeedback(null);
    try {
      await write(next);
      if (next === null || next.kind !== 'connection' || next.connection !== connection?.connection) setModelDraft(null);
      ping();
    } catch (cause) {
      setFeedback({ tone: 'error', text: t('st.decision.saveFailed', { detail: errorText(locale, cause) }) });
    } finally {
      setBusy(false);
    }
  };
  const pickerId = `st-decision-${consumer}`;
  const fix = problem === 'missing_connection' || problem === 'not_decision' || problem === 'pair_score_reviewer'
    ? { label: t('st.decision.fix.addService'), route: DECISION_CONNECTION_ADD_ROUTE }
    : (problem === 'auth' || problem === 'protocol' || problem === 'missing_model' || problem === 'unconfigured') && connection !== undefined
      ? { label: t('st.decision.fix.openConnection'), route: decisionConnectionRoute(connection.connection) }
      : undefined;
  return (
    <div data-decision-judge={consumer} data-decision-problem={problem ?? undefined}
      className="grid gap-x-6 gap-y-1.5 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start">
      <div className="min-w-0 sm:pt-1.5">
        <div className="flex items-center gap-2">
          <label htmlFor={pickerId} className="text-[13px] text-ink">{label}</label>
          <SaveStatus saving={busy} saved={saved} />
        </div>
        <p className="text-[12px] leading-4 text-ink-faint">{source === undefined ? legacy ?? unset : help}</p>
        {problem !== null ? (
          <div role="alert" className="mt-1 space-y-0.5">
            <p className="max-w-[62ch] text-[12px] leading-snug text-danger">{t(DECISION_SOURCE_PROBLEM_KEYS[problem])}</p>
            {fix !== undefined ? (
              <button type="button" data-decision-fix className={LINK} onClick={() => { void navigate(fix.route); }}>{fix.label}</button>
            ) : null}
          </div>
        ) : null}
        {error !== null && error !== undefined ? <InlineError error={error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
      <div className="min-w-0 space-y-2">
        <DecisionSourcePicker id={pickerId} consumer={consumer} value={source} ariaLabel={label}
          disabled={busy || loading} onChange={(next) => {
            // An unsaved model name asks first: switching would leave it behind.
            if (modelDirty && !(next !== null && sameDecisionSource(next, source))) { setPendingSwitch({ next }); return; }
            void commit(next);
          }} />
        {connection !== undefined ? (
          <div className="space-y-1">
            <label htmlFor={`${pickerId}-model`} className="block text-[12px] text-ink-soft">{t('st.decision.row.modelOverride')}</label>
            <input id={`${pickerId}-model`} data-decision-judge-model className={`${INPUT} font-mono`} value={model}
              placeholder={provider?.default_model === undefined ? '' : t('st.decision.row.modelDefault', { model: provider.default_model })}
              spellCheck={false} autoComplete="off" disabled={busy}
              onChange={(event) => { setModel(event.target.value); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && modelDirty) { event.preventDefault(); void commit(decisionSourceWithModel(connection, model)); }
              }} />
            <SettingsDraftFooter id={`decision-judge-${consumer}`} dirty={modelDirty} saving={busy}
              saveLabel={t('st.decision.row.saveModel')}
              onSave={() => { void commit(decisionSourceWithModel(connection, model)); }}
              onDiscard={() => { setModelDraft(null); }} />
          </div>
        ) : null}
      </div>
      <ConfirmDialog open={pendingSwitch !== null} overlayId={`decision-judge-switch:${consumer}`}
        title={t('st.dirty.leaveTitle')} body={t('st.decision.row.switchBody')}
        confirmLabel={t('st.decision.row.switchConfirm')} cancelLabel={t('st.dirty.stay')}
        onConfirm={() => {
          const next = pendingSwitch?.next ?? null;
          setPendingSwitch(null); setModelDraft(null);
          void commit(next);
        }}
        onCancel={() => { setPendingSwitch(null); }} />
    </div>
  );
}

/**
 * The read-only line a consumer card shows instead of its own model, protocol
 * and endpoint fields: what this job uses, whether it works, and a link to the
 * one place it is chosen.
 */
export function DecisionSourceSummary({ consumer, source, status, legacy }: {
  readonly consumer: DecisionConsumer;
  readonly source: DecisionSource | undefined;
  readonly status: DecisionSourceStatus | undefined;
  readonly legacy?: string;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const providersQuery = useQuery(providersQueryOptions(client));
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const problem = decisionSourceProblem(consumer, source, status, providersQuery.data?.items);
  const chatLabel = (id: string) => modelsQuery.data?.items.find((item) => item.id === id)?.display_name;
  return (
    <div data-decision-summary={consumer} data-decision-problem={problem ?? undefined} className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[13px] text-ink-soft">{t('st.decision.source')}</span>
        <span data-decision-summary-value className={`min-w-0 break-all ${source === undefined ? 'text-[12.5px] text-ink-soft' : 'font-mono text-[12px] text-ink'}`}>
          {source === undefined ? legacy ?? t('st.decision.sourceNone') : sourceLabel(source, providersQuery.data?.items, chatLabel)}
        </span>
        <button type="button" data-decision-change className={LINK} onClick={() => { void navigate(DECISION_JUDGES_ROUTE); }}>
          {t('st.decision.change')}
        </button>
      </div>
      {problem !== null ? <p role="alert" className="max-w-[62ch] text-[12px] leading-snug text-danger">{t(DECISION_SOURCE_PROBLEM_KEYS[problem])}</p> : null}
    </div>
  );
}

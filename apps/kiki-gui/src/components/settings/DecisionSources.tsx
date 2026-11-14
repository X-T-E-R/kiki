/**
 * Which service decides, for each job that asks one. A source is a decision
 * connection (with its default model or a named one) or a chat model; each
 * job stores its own pointer, so changing one never changes another, and the
 * key stays with the connection. The consumer cards show the choice read-only
 * and link here.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { providerIdSchema, type DecisionSource, type DecisionSourceStatus, type MoveReviewerKeyResult, type ProviderCatalogItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import {
  DECISION_CONNECTION_ADD_ROUTE,
  DECISION_SOURCE_PROBLEM_KEYS,
  DECISION_PROTOCOLS,
  decisionProtocolAllowed,
  decisionProtocolOf,
  decisionSourceFromValue,
  decisionSourceProblem,
  decisionSourceValue,
  decisionSourceWithModel,
  decisionConnectionRoute,
  isDecisionConnection,
  resolveCatalogDecisionTarget,
  sameDecisionSource,
  type DecisionConsumer,
  type DecisionSourceProblem,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, SaveStatus, type Feedback } from '../controls';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDirtyReporter, useGuardedNavigate } from '../dirtyGuard';
import { useMemoryAdvisor } from '../memory/useMemoryAdvisor';
import { buildCatalogModelOptions, useProviderGroupLabel } from '../modelSelectOptions';
import { ModelPicker } from '../ModelPicker';
import { hostLabel } from '../providerPresets';
import type { SearchableSelectOption } from '../SearchableSelect';
import { INPUT, INPUT_BOX, SECONDARY_BUTTON } from '../ui';
import { FieldIssue, SettingsDraftFooter, TEXT_BUTTON } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { isImeKeyEvent } from '../../lib/shortcuts';

const PICKER =
  'flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-ink/[0.04] px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.07] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint';
const LINK = TEXT_BUTTON;

const providersQueryOptions = (client: ReturnType<typeof useConnection>['client']) => ({
  queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000,
});

/** The name a person recognizes for a source, used on triggers and summaries. */
function sourceLabel(
  source: DecisionSource,
  providers: readonly ProviderCatalogItem[] | undefined,
  chatLabel: (id: string) => string | undefined,
  protocolName?: (protocol: NonNullable<Extract<DecisionSource, { kind: 'connection' }>['protocol']>) => string,
): string {
  if (source.kind === 'model') return chatLabel(source.model) ?? source.model;
  const provider = providers?.find((item) => item.id === source.connection);
  const target = provider === undefined ? null : resolveCatalogDecisionTarget(provider, source.protocol);
  const model = source.model ?? target?.defaultModel;
  const qualifier = model ?? (source.protocol === undefined ? undefined : protocolName?.(source.protocol) ?? source.protocol);
  return qualifier === undefined || qualifier === '' ? source.connection : `${source.connection} · ${qualifier}`;
}

/**
 * One picker over both kinds of source, grouped. Decision services first —
 * standalone decision connections and chat connections with attached decision
 * capabilities (the reviewer sees rerank services but cannot pick them: a
 * relevance score is not the chance an action is safe) — then every chat model.
 * A saved source that no longer resolves stays visible as "(missing)" so it
 * can be replaced.
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
      ? providers.some((provider) => provider.id === value.connection && resolveCatalogDecisionTarget(provider, value.protocol) !== null)
      : models.some((model) => model.id === value.model));
  const options = useMemo<SearchableSelectOption[]>(() => {
    const decision: SearchableSelectOption[] = [];
    for (const provider of providers ?? []) {
      if (isDecisionConnection(provider)) {
        const protocol = decisionProtocolOf(provider) ?? 'system_one';
        const allowed = decisionProtocolAllowed(consumer, protocol);
        const host = hostLabel(provider.effective_base_url ?? provider.base_url);
        const isJev = protocol === 'system_one' && host === 'api.typesafe.ai';
        const envMissing = provider.api_key_env !== undefined && !provider.has_api_key;
        const needsModel = (provider.default_model ?? '') === '';
        const statusDesc = provider.status === 'error' ? t('st.connections.statusError')
          : envMissing ? t('st.decision.status.envMissing', { name: provider.api_key_env ?? '' })
            : needsModel ? t('st.decision.status.needsModel') : t('st.decision.status.ready');
        const jevDesc = isJev ? `${t('st.decision.preset.jev')} · ${statusDesc}` : statusDesc;
        decision.push({
          value: `connection:${provider.id}`,
          label: provider.id,
          hint: [host, provider.default_model].filter(Boolean).join(' · ') || undefined,
          description: allowed ? jevDesc : t('st.decision.picker.pairScoreOnly'),
          badges: [{ label: t(`st.decision.protocol.${protocol}`) }],
          group: t('st.decision.picker.groupDecision'),
          disabled: !allowed,
          keywords: `${provider.id} ${isJev ? 'Jev TypeSafe' : ''} ${protocol} ${provider.base_url ?? ''} ${provider.default_model ?? ''}`,
        });
        continue;
      }
      const capabilities = provider.decision_capabilities;
      if (capabilities === undefined) continue;
      const host = hostLabel(provider.effective_base_url ?? provider.base_url);
      const envMissing = provider.api_key_env !== undefined && !provider.has_api_key;
      for (const protocol of DECISION_PROTOCOLS) {
        const cap = capabilities[protocol];
        if (cap === undefined) continue;
        const allowed = decisionProtocolAllowed(consumer, protocol);
        const needsModel = (cap.model ?? '') === '';
        const statusDesc = provider.status === 'error' ? t('st.connections.statusError')
          : envMissing ? t('st.decision.status.envMissing', { name: provider.api_key_env ?? '' })
            : needsModel ? t('st.decision.status.needsModel') : t('st.decision.status.ready');
        decision.push({
          value: `connection:${provider.id}#${protocol}`,
          label: provider.id,
          hint: [host, cap.model].filter(Boolean).join(' · ') || undefined,
          description: allowed ? statusDesc : t('st.decision.picker.pairScoreOnly'),
          badges: [{ label: t(`st.decision.protocol.${protocol}`) }],
          group: t('st.decision.picker.groupDecision'),
          disabled: !allowed,
          keywords: `${provider.id} ${protocol} ${provider.base_url ?? ''} ${cap.model ?? ''}`,
        });
      }
    }
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
  }, [providers, models, consumer, t, groupLabel, value, current, modelsQuery.isPending]);
  const chatLabel = (modelId: string) => models.find((item) => item.id === modelId)?.display_name;
  const protocolName = (protocol: NonNullable<Extract<DecisionSource, { kind: 'connection' }>['protocol']>) => t(`st.decision.protocol.${protocol}`);
  return (
    <ModelPicker id={id} value={decisionSourceValue(value)} options={options} allowCustomValue={false} ariaLabel={ariaLabel}
      searchPlaceholder={t('st.decision.picker.search')} emptyText={t('st.decision.picker.none')}
      align="end" placement="auto" disabled={disabled} buttonClassName={PICKER}
      triggerLabel={value === undefined ? undefined
        : missing ? t('st.decision.picker.missing', { id: value.kind === 'connection' ? value.connection : value.model })
          : sourceLabel(value, providers, chatLabel, protocolName)}
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
  /** Re-runs the failed read; absent when the row cannot refetch on its own. */
  readonly retry?: () => void;
  readonly write: (source: DecisionSource | null) => Promise<void>;
  /** Older-settings cleanup that belongs to this job (the reviewer's own Jev key). */
  readonly extra?: React.ReactNode;
}

/**
 * Shared reviewer legacy key/env helper, used on both Defaults › Who decides
 * and Permissions › Reviewer so an older TypeSafe key can be migrated wherever
 * the person opens the reviewer setting.
 */
export function useReviewerDecisionExtra(reviewer: {
  readonly source?: DecisionSource;
  readonly backend?: string;
  readonly apiKeySource?: string;
  readonly hasApiKey?: boolean;
  readonly apiKeyEnv?: string;
} | undefined): React.ReactNode {
  const { t } = useI18n();
  const [moved, setMoved] = useState<string | null>(null);
  const legacyJev = reviewer?.source === undefined && reviewer?.backend === 'jev';
  const keySource = reviewer?.apiKeySource ?? (reviewer?.hasApiKey === true ? 'kiki' : 'none');
  if (keySource === 'kiki') return <LegacyJevKey source={reviewer?.source} onMoved={setMoved} />;
  if (legacyJev) return <LegacyJevEnv keyEnv={reviewer?.apiKeyEnv} />;
  if (moved !== null) return <p role="status" className="text-[12px] text-success">{t('st.reviewer.moveDone', { id: moved })}</p>;
  return null;
}

/**
 * "Who decides": approval review and Memory Advisor, one row each, on the
 * Defaults tab. A pick saves at once; a model name for a connection is a small
 * draft with its own save. Each row writes only its own consumer's `source`,
 * never the advisor's on/off, so picking a source does not switch anything on.
 */
export function DecisionJudgeRows() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const advisor = useMemoryAdvisor();
  const reviewer = configQuery.data?.permission?.reviewer;
  const reviewerExtra = useReviewerDecisionExtra(reviewer);
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
      extra: reviewerExtra,
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
      retry: () => { void advisor.query.refetch(); },
      // Clearing also drops an older model setting, so nothing stays in effect.
      write: async (source) => {
        await advisor.save.mutateAsync({ advisor: source === null && advisorConfig?.selector !== undefined ? { source, selector: null } : { source } });
      },
    },
  ];
  return (
    <div className="divide-y divide-hairline" data-decision-judges>
      {rows.map((row) => <DecisionSourceField key={row.consumer} {...row} scope="defaults" />)}
    </div>
  );
}

/**
 * Interactive decision source selector used both in Defaults › Who decides and
 * directly in place on each consumer card (Permissions › Reviewer and Memory ›
 * Memory Advisor). Selecting a source saves immediately; when a connection is
 * chosen, an optional model override input lets this job pick its own model.
 * Problem links ("Open connection" / "Add a decision service") appear only when
 * the chosen source has a configuration or credential issue.
 */
export function DecisionSourceField({
  consumer,
  label,
  help,
  unset,
  source,
  status,
  legacy,
  loading,
  error,
  retry,
  write,
  extra,
  scope = 'card',
}: JudgeRowModel & {
  readonly label: string;
  readonly help: string;
  readonly unset: string;
  readonly scope?: 'defaults' | 'card';
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const providersQuery = useQuery(providersQueryOptions(client));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [saved, ping] = useSavedTick();
  const connection = source?.kind === 'connection' ? source : undefined;
  const connectionTargetKey = connection === undefined ? undefined : decisionSourceValue(connection);
  const provider = connection === undefined ? undefined : providersQuery.data?.items.find((item) => item.id === connection.connection);
  const resolvedTarget = provider === undefined || connection === undefined ? null : resolveCatalogDecisionTarget(provider, connection.protocol);
  const defaultModel = resolvedTarget?.defaultModel;
  // The model name is the one free-text part, so it is a draft with its own
  // save; every other change here applies on pick. The draft belongs to the
  // connection target it was typed for: another source never inherits it.
  const savedModel = connection?.model ?? '';
  const [modelDraft, setModelDraft] = useState<{ readonly target: string; readonly value: string } | null>(null);
  const model = modelDraft !== null && modelDraft.target === connectionTargetKey ? modelDraft.value : savedModel;
  const setModel = (value: string) => {
    if (connectionTargetKey !== undefined) setModelDraft({ target: connectionTargetKey, value });
  };
  const modelDirty = connection !== undefined && model.trim() !== savedModel;
  useDirtyReporter(`decision-judge:${scope}:${consumer}`, modelDirty);
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
      if (next === null || next.kind !== 'connection' || decisionSourceValue(next) !== connectionTargetKey) setModelDraft(null);
      ping();
    } catch (cause) {
      setFeedback({ tone: 'error', text: t('st.decision.saveFailed', { detail: errorText(locale, cause) }) });
    } finally {
      setBusy(false);
    }
  };
  const pickerId = scope === 'defaults' ? `st-decision-${consumer}` : `st-decision-${scope}-${consumer}`;
  const fix = decisionProblemFix(problem, source, t);
  const rowAttrs = scope === 'defaults'
    ? { 'data-decision-judge': consumer }
    : { 'data-decision-field': consumer };
  return (
    <div {...rowAttrs} data-decision-problem={problem ?? undefined}
      className={`grid gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-start ${scope === 'defaults' ? 'py-3 first:pt-0' : 'py-1'}`}>
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
        {error !== null && error !== undefined ? (
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-faint" data-decision-read-error>
            <span>{errorText(locale, error)}</span>
            {retry !== undefined ? (
              <button type="button" className={LINK} onClick={retry}>{t('common.retry')}</button>
            ) : null}
          </p>
        ) : null}
        <FeedbackLine feedback={feedback} />
        {extra !== undefined && extra !== null ? <div className="mt-2">{extra}</div> : null}
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
              placeholder={defaultModel === undefined || defaultModel === '' ? '' : t('st.decision.row.modelDefault', { model: defaultModel })}
              spellCheck={false} autoComplete="off" disabled={busy}
              onChange={(event) => { setModel(event.target.value); }}
              onKeyDown={(event) => {
                if (isImeKeyEvent(event)) return;
                if (event.key === 'Enter' && modelDirty) { event.preventDefault(); void commit(decisionSourceWithModel(connection, model)); }
              }} />
            <SettingsDraftFooter id={`decision-judge-${scope}-${consumer}`} dirty={modelDirty} saving={busy}
              saveLabel={t('st.decision.row.saveModel')}
              onSave={() => { void commit(decisionSourceWithModel(connection, model)); }}
              onDiscard={() => { setModelDraft(null); }} />
          </div>
        ) : null}
      </div>
      <ConfirmDialog open={pendingSwitch !== null} overlayId={`decision-judge-switch:${scope}:${consumer}`}
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

function decisionProblemFix(
  problem: DecisionSourceProblem | null,
  source: DecisionSource | undefined,
  t: ReturnType<typeof useI18n>['t'],
): { readonly label: string; readonly route: string } | undefined {
  if (problem === 'missing_connection' || problem === 'pair_score_reviewer') {
    return { label: t('st.decision.fix.addService'), route: DECISION_CONNECTION_ADD_ROUTE };
  }
  if (problem === 'not_decision' && source?.kind === 'connection') {
    return { label: t('st.decision.fix.openConnection'), route: decisionConnectionRoute(source.connection) };
  }
  if (problem === 'not_decision') {
    return { label: t('st.decision.fix.addService'), route: DECISION_CONNECTION_ADD_ROUTE };
  }
  if ((problem === 'auth' || problem === 'protocol' || problem === 'missing_model' || problem === 'unconfigured') && source?.kind === 'connection') {
    return { label: t('st.decision.fix.openConnection'), route: decisionConnectionRoute(source.connection) };
  }
  return undefined;
}
function LegacyJevEnv({ keyEnv }: { readonly keyEnv?: string }) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  return (
    <div data-reviewer-legacy="env" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">{t('st.reviewer.legacyEnv', { name: keyEnv ?? 'TYPESAFE_API_KEY' })}</p>
      <button type="button" data-reviewer-add-jev className={SECONDARY_BUTTON}
        onClick={() => { void navigate(DECISION_CONNECTION_ADD_ROUTE); }}>{t('st.reviewer.addJev')}</button>
    </div>
  );
}

/**
 * A TypeSafe key still saved in the reviewer's own settings. The server moves
 * it (the browser never holds it) into a connection and points the reviewer
 * there. Shown for as long as that key is saved, so a move that stopped part
 * way can be finished after a refresh or a reload; nothing retries on its own.
 * The connection the reviewer already points at may be named again (it may
 * hold the moved key); otherwise a free ID is needed, and the server keeps a
 * connection that holds a different key as it is.
 */
function LegacyJevKey({ source, onMoved }: {
  readonly source: DecisionSource | undefined;
  /** A finished move clears the key, and with it this block; the card keeps the word. */
  readonly onMoved: (id: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const taken = new Set((providersQuery.data?.items ?? []).map((item) => item.id));
  const [partial, setPartial] = useState<MoveReviewerKeyResult | null>(null);
  const pointed = source?.kind === 'connection' && taken.has(source.connection) ? source.connection : undefined;
  const reusable = partial?.connection ?? pointed;
  const [id, setId] = useState('');
  const [touched, setTouched] = useState(false);
  const [moving, setMoving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Until the person types, the field follows the facts: the connection the
  // reviewer points at, or the first free `typesafe` ID.
  useEffect(() => {
    if (touched || !providersQuery.isSuccess) return;
    if (reusable !== undefined) { setId(reusable); return; }
    if (!taken.has('typesafe')) { setId('typesafe'); return; }
    for (let n = 2; ; n++) if (!taken.has(`typesafe-${n}`)) { setId(`typesafe-${n}`); break; }
  }, [providersQuery.isSuccess, providersQuery.data, reusable, touched]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = id.trim();
  const idIssue = trimmed === '' || trimmed === reusable ? null
    : !providerIdSchema.safeParse(trimmed).success ? t('st.decision.idInvalid')
      : taken.has(trimmed) ? t('st.decision.idTaken') : null;
  const move = async () => {
    if (moving || trimmed === '' || idIssue !== null) return;
    setMoving(true); setFeedback(null);
    try {
      const result = await client.moveReviewerKey(trimmed);
      // One request per click. The server keeps newer settings when it meets
      // them, so the cards re-read and say what is true now.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
      ]);
      setTouched(false);
      if (result.state === 'complete') {
        setPartial(null);
        onMoved(result.connection);
      } else {
        setPartial(result);
        setFeedback({ tone: 'error', text: t('st.reviewer.movePartial') });
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.reviewer.moveFailed', { detail: errorText(locale, error) }) });
    } finally { setMoving(false); }
  };
  return (
    <div data-reviewer-legacy="key" data-reviewer-move={partial?.state ?? 'idle'} className="space-y-2">
      <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">
        {source === undefined ? t('st.reviewer.legacyKey') : t('st.reviewer.legacyKeyLeft')}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-[12px] text-ink-soft">{t('st.reviewer.moveId')}</span>
          <input data-reviewer-move-id className={`${INPUT_BOX} w-48 font-mono`} value={id}
            disabled={moving} spellCheck={false} autoComplete="off" aria-invalid={idIssue !== null}
            aria-describedby={idIssue === null ? undefined : 'reviewer-move-id-issue'}
            onChange={(event) => { setId(event.target.value); setTouched(true); setFeedback(null); }} />
        </label>
        <button type="button" data-reviewer-move-key className={SECONDARY_BUTTON}
          disabled={moving || trimmed === '' || idIssue !== null || !providersQuery.isSuccess} onClick={() => void move()}>
          {moving ? t('st.reviewer.moving') : partial !== null ? t('common.retry') : t('st.reviewer.moveKey')}
        </button>
      </div>
      <FieldIssue id="reviewer-move-id-issue" text={idIssue} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

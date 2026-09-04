import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NbSearchCapabilities, NbSearchTestStatus } from '@moonshot-ai/protocol';

import { errorText } from '@kiki/session-core/i18n';
import {
  formatNbSearchOutput,
  nbSearchConfigPatch,
  nbSearchDraftDirty,
  nbSearchDraftFromConfig,
  nbSearchIssueCodes,
  nbSearchReadinessFromCapabilities,
  type NbSearchDraft,
  type NbSearchProviderDraft,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { useDirtyReporter } from '../dirtyGuard';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';

/**
 * Search & retrieval leaf: structured ownership of the `nb_search` config
 * domain (providers, default lane, fetch chain, execution budgets) so users
 * never touch raw JSON. Status derives from the already-fetched capabilities
 * payload; the backend readiness check runs only on explicit request. Saves
 * replace the whole domain — the draft round-trips the full saved object, so
 * fields this page does not render survive untouched.
 */

type NbSearchReadiness = NbSearchTestStatus['search'];
type ReadinessState = 'ready' | 'degraded' | 'unconfigured' | 'unavailable';

function webSearchState(readiness: NbSearchReadiness): ReadinessState {
  if (!readiness.configured) return 'unconfigured';
  return readiness.available ? 'ready' : 'unavailable';
}

function fetchUrlState(readiness: NbSearchReadiness): ReadinessState {
  if (!readiness.configured) return 'unconfigured';
  if (!readiness.available) return 'unavailable';
  return readiness.issues.length > 0 ? 'degraded' : 'ready';
}

const STATE_BADGE: Record<ReadinessState, string> = {
  ready: 'border-success/40 bg-success/10 text-success',
  degraded: 'border-amber-rule/60 bg-amber-card text-amber-ink',
  unconfigured: 'border-hairline bg-paper text-ink-faint',
  unavailable: 'border-danger/40 bg-danger/5 text-danger',
};

function StateBadge({ state }: { state: ReadinessState }) {
  const { t } = useI18n();
  const labelKey =
    state === 'ready' ? 'st.nbSearch.stateReady'
      : state === 'degraded' ? 'st.nbSearch.stateDegraded'
        : state === 'unconfigured' ? 'st.nbSearch.stateUnconfigured'
          : 'st.nbSearch.stateUnavailable';
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${STATE_BADGE[state]}`}>
      {t(labelKey)}
    </span>
  );
}

function IssueList({ issues }: { issues: readonly string[] }) {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <p className="font-mono text-[10.5px] text-danger">
      {t('st.nbSearch.issuesLabel')}: {issues.join(', ')}
    </p>
  );
}

function StatusRow({ label, state, readiness }: { label: string; state: ReadinessState; readiness: NbSearchReadiness }) {
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-ink">{label}</span>
        <StateBadge state={state} />
        {readiness.selection !== undefined ? (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-ink-faint">{readiness.selection}</span>
        ) : null}
      </div>
      <IssueList issues={readiness.issues} />
    </div>
  );
}

function NumberField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-[11px] font-medium text-ink-soft">
      {label}
      <input
        className={`${INPUT} mt-1 font-mono`}
        inputMode="numeric"
        value={value}
        onChange={(event) => { onChange(event.target.value); }}
      />
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-hairline bg-paper p-3">
      <legend className="px-1 text-[12px] font-semibold text-ink">{title}</legend>
      {children}
    </fieldset>
  );
}

function AvailabilityBadge({ availability }: { availability: 'ready' | 'unavailable' }) {
  const { t } = useI18n();
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
      availability === 'ready'
        ? 'border-success/40 bg-success/10 text-success'
        : 'border-danger/40 bg-danger/5 text-danger'
    }`}>
      {availability === 'ready' ? t('st.nbSearch.availabilityReady') : t('st.nbSearch.availabilityUnavailable')}
    </span>
  );
}

function ProviderInstanceCard({ instance, descriptor, providerDraft, onChange }: {
  instance: NbSearchCapabilities['providers']['instances'][number];
  descriptor: NbSearchCapabilities['providers']['descriptors'][number] | undefined;
  providerDraft: NbSearchProviderDraft;
  onChange: (patch: Partial<NbSearchProviderDraft>) => void;
}) {
  const { t } = useI18n();
  const attention = instance.availability === 'unavailable' || instance.issues.length > 0;
  const [open, setOpen] = useState(attention);
  const needsCredential = instance.credential.requirement !== 'none';
  const needsEndpoint = instance.endpoint.requirement === 'required' || instance.endpoint.requirement === 'optional';
  const showOptions = (descriptor?.option_keys.length ?? 0) > 0;
  return (
    <details
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      className="rounded-lg border border-hairline bg-paper px-3 py-2"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-ink">{instance.id}</span>
        <AvailabilityBadge availability={instance.availability} />
        <span className="text-[10px] text-ink-faint">
          {instance.credential.requirement === 'none'
            ? t('st.nbSearch.credentialNone')
            : instance.credential.configured
              ? t('st.nbSearch.credentialConfigured')
              : t(instance.credential.requirement === 'unknown' ? 'st.nbSearch.credentialRequired' : 'st.nbSearch.credentialMissing')}
          {' · '}
          {instance.endpoint.requirement === 'none'
            ? t('st.nbSearch.endpointNone')
            : instance.endpoint.configured
              ? t('st.nbSearch.endpointConfigured')
              : t(instance.endpoint.requirement === 'required' ? 'st.nbSearch.endpointMissing' : 'st.nbSearch.endpointOptional')}
        </span>
      </summary>
      <div className="mt-2 space-y-2 border-t border-hairline pt-2">
        <Toggle
          label={t('st.nbSearch.enabled')}
          checked={providerDraft.enabled}
          onChange={(enabled) => { onChange({ enabled }); }}
        />
        <IssueList issues={nbSearchIssueCodes(instance.issues)} />
        {needsCredential ? (
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.credentialEnvLabel')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={providerDraft.credentialEnv}
              placeholder={t('st.nbSearch.credentialEnvPlaceholder')}
              onChange={(event) => { onChange({ credentialEnv: event.target.value }); }}
            />
            <Hint>{t('st.nbSearch.credentialEnvHint')}</Hint>
          </label>
        ) : null}
        {needsEndpoint ? (
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.baseUrlLabel')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={providerDraft.baseUrl}
              placeholder="https://"
              onChange={(event) => { onChange({ baseUrl: event.target.value }); }}
            />
          </label>
        ) : null}
        {showOptions ? (
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.optionsLabel')}
            <textarea
              className={`${INPUT} mt-1 min-h-16 font-mono`}
              value={providerDraft.optionsJson}
              placeholder="{}"
              onChange={(event) => { onChange({ optionsJson: event.target.value }); }}
            />
            <Hint>{t('st.nbSearch.optionsHint', { keys: descriptor?.option_keys.join(', ') ?? '' })}</Hint>
          </label>
        ) : null}
      </div>
    </details>
  );
}

type TestRun =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'ok'; readonly result: NbSearchTestStatus }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'cancelled' };

export function NbSearchSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<NbSearchDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [testRun, setTestRun] = useState<TestRun>({ status: 'idle' });
  const testAbort = useRef<AbortController | null>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const capsQuery = useQuery({
    queryKey: ['nb-search-capabilities'],
    queryFn: () => client.getNbSearchCapabilities(),
    staleTime: 30_000,
  });

  const capabilities = capsQuery.data;
  const baseline = useMemo(
    () => capabilities === undefined || configQuery.data === undefined
      ? null
      : nbSearchDraftFromConfig(configQuery.data.nb_search, capabilities),
    [configQuery.data, capabilities],
  );
  useEffect(() => {
    if (baseline !== null) setDraft(baseline);
  }, [baseline]);

  const dirty = draft !== null && baseline !== null && nbSearchDraftDirty(baseline, draft);
  useDirtyReporter('nb-search', dirty);

  if (draft === null || capabilities === undefined) {
    return (
      <SectionCard id="st-card-search-status" title={t('st.nbSearch.statusTitle')}>
        {configQuery.isError ? <InlineError error={configQuery.error} />
          : capsQuery.isError ? <InlineError error={capsQuery.error} />
            : <Hint>{t('st.nbSearch.loading')}</Hint>}
      </SectionCard>
    );
  }

  const readiness = nbSearchReadinessFromCapabilities(capabilities);
  const updateProviders = (id: string, patch: Partial<NbSearchProviderDraft>) => {
    setDraft((current) => current === null ? current : {
      ...current,
      providers: { ...current.providers, [id]: { ...current.providers[id]!, ...patch } },
    });
  };
  const updateExecution = (patch: Partial<NbSearchDraft['execution']>) => {
    setDraft((current) => current === null ? current : { ...current, execution: { ...current.execution, ...patch } });
  };

  const save = async () => {
    let patch;
    try {
      patch = nbSearchConfigPatch(configQuery.data?.nb_search, draft, capabilities);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      // The runtime rebuilds on config change; capabilities reflect the new
      // readiness after refetch.
      await queryClient.invalidateQueries({ queryKey: ['nb-search-capabilities'] });
      setFeedback({ tone: 'success', text: t('st.nbSearch.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    const controller = new AbortController();
    testAbort.current = controller;
    setTestRun({ status: 'running' });
    try {
      const result = await client.testNbSearch(controller.signal);
      setTestRun({ status: 'ok', result });
    } catch (error) {
      if (controller.signal.aborted) setTestRun({ status: 'cancelled' });
      else setTestRun({ status: 'error', message: errorText(locale, error) });
    } finally {
      testAbort.current = null;
    }
  };

  const laneIds = new Set(capabilities.search.lanes.map((lane) => lane.id));
  const pipelineById = new Map(capabilities.fetch.pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const descriptorByProvider = new Map(capabilities.providers.descriptors.map((d) => [d.provider_id, d]));
  const sortedInstances = capabilities.providers.instances.toSorted((a, b) =>
    a.availability === b.availability ? a.id.localeCompare(b.id) : a.availability === 'ready' ? 1 : -1);
  const anyPartial =
    capabilities.providers.instances.some((instance) => instance.issues.length > 0)
    || capabilities.search.lanes.some((lane) => lane.issues.length > 0)
    || capabilities.fetch.pipelines.some((pipeline) => pipeline.issues.length > 0);

  return (
    <>
      <SectionCard id="st-card-search-status" title={t('st.nbSearch.statusTitle')}>
        <div className="space-y-2">
          <Hint>{t('st.nbSearch.statusHint')}</Hint>
          <StatusRow label={t('st.nbSearch.webSearch')} state={webSearchState(readiness.search)} readiness={readiness.search} />
          <StatusRow label={t('st.nbSearch.fetchUrl')} state={fetchUrlState(readiness.fetch)} readiness={readiness.fetch} />
          {!readiness.search.configured ? (
            <p className="rounded-md border border-amber-rule/60 bg-amber-card px-2.5 py-2 text-[11px] text-amber-ink">
              {t('st.nbSearch.failClosedNote')}
            </p>
          ) : null}
          {anyPartial ? <Hint>{t('st.nbSearch.partialReadyHint')}</Hint> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-search-defaults" title={t('st.nbSearch.defaultsTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.nbSearch.defaultsHint')}</Hint>
          <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
            <span className="text-[11px] font-medium text-ink-soft">{t('st.nbSearch.defaultLaneLabel')}</span>
            <label className="flex items-center gap-2 rounded-lg border border-hairline bg-paper px-3 py-2">
              <input
                type="radio"
                name="nb-search-default-lane"
                checked={draft.defaultSearchLane === ''}
                onChange={() => { setDraft({ ...draft, defaultSearchLane: '' }); }}
              />
              <span className="text-[12px] text-ink-soft">{t('st.nbSearch.noDefaultLane')}</span>
            </label>
            {capabilities.search.lanes.map((lane) => (
              <label key={lane.id} className="flex items-start gap-2 rounded-lg border border-hairline bg-paper px-3 py-2">
                <input
                  type="radio"
                  name="nb-search-default-lane"
                  className="mt-0.5"
                  checked={draft.defaultSearchLane === lane.id}
                  onChange={() => { setDraft({ ...draft, defaultSearchLane: lane.id }); }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] font-medium text-ink">{lane.id}</span>
                    <AvailabilityBadge availability={lane.availability} />
                    <span className="font-mono text-[10px] text-ink-faint">{formatNbSearchOutput(lane.output)}</span>
                    <span className="font-mono text-[10px] text-ink-faint">{lane.latency} · {lane.cost}</span>
                  </span>
                  <IssueList issues={nbSearchIssueCodes(lane.issues)} />
                </span>
              </label>
            ))}
            {draft.defaultSearchLane !== '' && !laneIds.has(draft.defaultSearchLane) ? (
              <label className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
                <input
                  type="radio"
                  name="nb-search-default-lane"
                  className="mt-0.5"
                  checked
                  onChange={() => { setDraft({ ...draft, defaultSearchLane: '' }); }}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-[12px] font-medium text-danger">{draft.defaultSearchLane}</span>
                  <IssueList issues={['LANE_NOT_REGISTERED']} />
                </span>
              </label>
            ) : null}
          </fieldset>

          <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-ink-soft">{t('st.nbSearch.fetchChainLabel')}</span>
              <span className="flex items-center gap-2">
                <span className="text-[10px] text-ink-faint">
                  {draft.fetchChainInherited ? t('st.nbSearch.chainInherited') : t('st.nbSearch.chainCustom')}
                </span>
                {draft.fetchChainInherited ? (
                  <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft({ ...draft, fetchChainInherited: false }); }}>
                    {t('st.nbSearch.customizeChain')}
                  </button>
                ) : (
                  <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft({ ...draft, fetchChainInherited: true }); }}>
                    {t('st.nbSearch.resetChain')}
                  </button>
                )}
              </span>
            </div>
            <Hint>{t('st.nbSearch.fetchChainHint')}</Hint>
            {draft.fetchChain.map((pipelineId, index) => {
              const pipeline = pipelineById.get(pipelineId);
              return (
                <div key={`${index}:${pipelineId}`} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-ink-faint">{index + 1}</span>
                  <select
                    className={`${SMALL_INPUT} min-w-0 flex-1 font-mono`}
                    value={pipelineId}
                    disabled={draft.fetchChainInherited}
                    aria-label={`${t('st.nbSearch.fetchChainLabel')} ${index + 1}`}
                    onChange={(event) => {
                      const next = [...draft.fetchChain];
                      next[index] = event.target.value;
                      setDraft({ ...draft, fetchChain: next });
                    }}
                  >
                    {pipeline === undefined ? <option value={pipelineId}>{pipelineId}</option> : null}
                    {capabilities.fetch.pipelines.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.id}</option>
                    ))}
                  </select>
                  {pipeline !== undefined ? <AvailabilityBadge availability={pipeline.availability} /> : null}
                  {!draft.fetchChainInherited ? (
                    <>
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        aria-label={t('st.nbSearch.movePipelineUp', { n: index + 1 })}
                        disabled={index === 0}
                        onClick={() => {
                          const next = [...draft.fetchChain];
                          [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                          setDraft({ ...draft, fetchChain: next });
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        aria-label={t('st.nbSearch.movePipelineDown', { n: index + 1 })}
                        disabled={index === draft.fetchChain.length - 1}
                        onClick={() => {
                          const next = [...draft.fetchChain];
                          [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                          setDraft({ ...draft, fetchChain: next });
                        }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        aria-label={t('st.nbSearch.removePipeline', { n: index + 1 })}
                        onClick={() => {
                          setDraft({ ...draft, fetchChain: draft.fetchChain.filter((_, candidate) => candidate !== index) });
                        }}
                      >
                        ×
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}
            {!draft.fetchChainInherited ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => {
                  const unused = capabilities.fetch.pipelines.find((pipeline) => !draft.fetchChain.includes(pipeline.id));
                  setDraft({ ...draft, fetchChain: [...draft.fetchChain, unused?.id ?? ''] });
                }}
              >
                {t('st.nbSearch.addPipeline')}
              </button>
            ) : null}
          </fieldset>
        </div>
      </SectionCard>

      <SectionCard id="st-card-search-providers" title={t('st.nbSearch.providersTitle')}>
        <div className="space-y-2">
          <Hint>{t('st.nbSearch.providersHint')}</Hint>
          <fieldset disabled={saving} className="space-y-2 disabled:opacity-60">
            {sortedInstances.map((instance) => (
              <ProviderInstanceCard
                key={instance.id}
                instance={instance}
                descriptor={descriptorByProvider.get(instance.provider_id)}
                providerDraft={draft.providers[instance.id]!}
                onChange={(patch) => { updateProviders(instance.id, patch); }}
              />
            ))}
          </fieldset>
        </div>
      </SectionCard>

      <SectionCard id="st-card-search-execution" title={t('st.nbSearch.executionTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.nbSearch.executionHint')}</Hint>
          <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
            <Group title={t('st.nbSearch.groupBudgets')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField label={t('st.nbSearch.maxProviderCalls')} value={draft.execution.maxProviderCalls} onChange={(maxProviderCalls) => { updateExecution({ maxProviderCalls }); }} />
                <NumberField label={t('st.nbSearch.maxConcurrency')} value={draft.execution.maxConcurrency} onChange={(maxConcurrency) => { updateExecution({ maxConcurrency }); }} />
                <NumberField label={t('st.nbSearch.retryCount')} value={draft.execution.retryCount} onChange={(retryCount) => { updateExecution({ retryCount }); }} />
              </div>
            </Group>
            <Group title={t('st.nbSearch.groupTimeouts')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField label={t('st.nbSearch.searchTimeout')} value={draft.execution.searchTimeoutMs} onChange={(searchTimeoutMs) => { updateExecution({ searchTimeoutMs }); }} />
                <NumberField label={t('st.nbSearch.fetchTimeout')} value={draft.execution.fetchTimeoutMs} onChange={(fetchTimeoutMs) => { updateExecution({ fetchTimeoutMs }); }} />
              </div>
            </Group>
            <Group title={t('st.nbSearch.groupFetchLimits')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField label={t('st.nbSearch.maxInlineBytes')} value={draft.execution.maxInlineBytes} onChange={(maxInlineBytes) => { updateExecution({ maxInlineBytes }); }} />
                <NumberField label={t('st.nbSearch.maxSourceBytes')} value={draft.execution.fetchMaxSourceBytes} onChange={(fetchMaxSourceBytes) => { updateExecution({ fetchMaxSourceBytes }); }} />
                <NumberField label={t('st.nbSearch.maxResponseBytes')} value={draft.execution.fetchMaxResponseBytes} onChange={(fetchMaxResponseBytes) => { updateExecution({ fetchMaxResponseBytes }); }} />
                <NumberField label={t('st.nbSearch.maxContentChars')} value={draft.execution.fetchMaxContentChars} onChange={(fetchMaxContentChars) => { updateExecution({ fetchMaxContentChars }); }} />
                <NumberField label={t('st.nbSearch.maxRedirects')} value={draft.execution.fetchMaxRedirects} onChange={(fetchMaxRedirects) => { updateExecution({ fetchMaxRedirects }); }} />
              </div>
            </Group>
          </fieldset>
          <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? t('common.saving') : t('st.nbSearch.save')}
          </button>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-search-diagnostics" title={t('st.nbSearch.diagnosticsTitle')}>
        <div className="space-y-2">
          <Hint>{t('st.nbSearch.diagnosticsHint')}</Hint>
          <div className="flex items-center gap-2">
            {testRun.status === 'running' ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => { testAbort.current?.abort(); }}
              >
                {t('st.nbSearch.cancel')}
              </button>
            ) : (
              <button type="button" className={PRIMARY_BUTTON} onClick={() => void runCheck()}>
                {t('st.nbSearch.runCheck')}
              </button>
            )}
            {testRun.status === 'running' ? <span className="text-[11px] text-ink-faint">{t('st.nbSearch.running')}</span> : null}
          </div>
          {testRun.status === 'ok' ? (
            <div className="space-y-2">
              <p className="font-mono text-[10.5px] text-ink-faint">{t('st.nbSearch.lastChecked', { revision: testRun.result.revision })}</p>
              <StatusRow label={t('st.nbSearch.webSearch')} state={webSearchState(testRun.result.search)} readiness={testRun.result.search} />
              <StatusRow label={t('st.nbSearch.fetchUrl')} state={fetchUrlState(testRun.result.fetch)} readiness={testRun.result.fetch} />
            </div>
          ) : null}
          {testRun.status === 'error' ? (
            <FeedbackLine feedback={{ tone: 'error', text: `${t('st.nbSearch.checkFailed')}: ${testRun.message}` }} />
          ) : null}
          {testRun.status === 'cancelled' ? (
            <FeedbackLine feedback={{ tone: 'info', text: t('st.nbSearch.cancelled') }} />
          ) : null}
        </div>
      </SectionCard>
    </>
  );
}

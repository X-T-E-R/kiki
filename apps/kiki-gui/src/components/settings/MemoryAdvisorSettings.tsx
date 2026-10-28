import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import type { MemoryAdvisorConfig, MemoryAdvisorProbeResult, MemorySettingsPatch } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  MEMORY_ADVISOR_DEFAULTS,
  MEMORY_ADVISOR_NUMBER_FIELDS,
  MEMORY_ADVISOR_PROTOCOLS,
  MEMORY_ADVISOR_RANGES,
  memoryAdvisorConsentPatch,
  memoryAdvisorConsented,
  memoryAdvisorEndpointIssue,
  memoryAdvisorModelBaseUrl,
  memoryAdvisorModePatch,
  memoryAdvisorReasonKey,
  memoryAdvisorSelectorFromDraft,
  parseMemoryAdvisorNumber,
  type MemoryAdvisorNumberField,
  type MemoryAdvisorProtocol,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { StatusDot } from '../capabilities/primitives';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, SaveStatus, Toggle, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { useMemoryAdvisor } from '../memory/useMemoryAdvisor';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect } from '../SearchableSelect';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { MemoryAdvisorRuntime } from './MemoryAdvisorRuntime';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField, SettingsGroup } from './fields';
import { CommitInput, SETTINGS_SELECT_TRIGGER, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

const CONNECTIONS_ROUTE = '/settings/ai?tab=providers#st-card-providers';
/** The selected model's own editor, inside its connection (`?model=` opens it). */
const modelSettingsRoute = (modelId: string) => `/settings/ai?tab=providers&model=${encodeURIComponent(modelId)}#st-card-providers`;
const ADD_MODEL_ROUTE = '/settings/ai?tab=providers#st-card-providers-add';

interface SelectorDraft {
  readonly protocol: MemoryAdvisorProtocol;
  readonly model: string;
  readonly endpoint: string;
}

function draftOf(advisor: MemoryAdvisorConfig | undefined): SelectorDraft {
  const selector = advisor?.selector;
  return { protocol: selector?.protocol ?? 'chat_json', model: selector?.model ?? '', endpoint: selector?.endpoint ?? '' };
}

const sameDraft = (a: SelectorDraft, b: SelectorDraft) => a.protocol === b.protocol && a.model === b.model && a.endpoint === b.endpoint;

/** Which write a save status belongs to, so only that row says "Saved". */
type WriteSlot = 'switch' | 'selector' | 'consent' | 'mode' | 'children' | MemoryAdvisorNumberField | 'remove';

/**
 * Memory Advisor: the quick switch on the heading, then the three decisions a
 * person makes in order (which model, whether memory may leave for it, and
 * how hard it may work). Common choices are on the first screen; tuning is
 * behind Advanced with the schema's own ranges and defaults.
 */
export function MemoryAdvisorSettingsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const [params, setParams] = useSearchParams();
  const workspacesQuery = useQuery({ queryKey: ['workspaces', 'catalog'], queryFn: () => client.listWorkspaceCatalog(), staleTime: 30_000 });
  const workspaces = workspacesQuery.data?.items ?? [];
  const requested = params.get('workspace');
  const workspace = workspaces.find((item) => item.id === requested) ?? workspaces[0];
  const advisor = useMemoryAdvisor(workspace?.id);
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const [saved, ping] = useSavedTick();
  const [slot, setSlot] = useState<WriteSlot | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const data = advisor.data;
  const config = data?.advisor;
  const status = data?.advisor_status;
  const view = advisor.view;
  const baseline = useMemo(() => draftOf(config), [config]);
  const [draft, setDraft] = useState<SelectorDraft>(baseline);
  const [seen, setSeen] = useState<SelectorDraft>(baseline);
  // A load, a save from another entry or the echo of this one moves the
  // baseline: an untouched draft follows it, an edited one stays its owner's.
  if (!sameDraft(seen, baseline)) {
    setSeen(baseline);
    if (sameDraft(draft, seen)) setDraft(baseline);
  }
  const dirty = !sameDraft(draft, baseline);

  const models = modelsQuery.data?.items ?? [];
  const modelOptions = useMemo(() => buildCatalogModelOptions(models, t), [models, t]);
  const chosenModel = models.find((item) => item.id === draft.model.trim());
  const needsEndpoint = draft.protocol !== 'chat_json';
  // The catalog row has no URL; the model entity carries its own override.
  const modelEntityQuery = useQuery({
    queryKey: ['model-entity', chosenModel?.id],
    queryFn: () => client.getModel(chosenModel!.id),
    enabled: needsEndpoint && chosenModel !== undefined,
    staleTime: 60_000,
  });
  const endpointPending = needsEndpoint && chosenModel !== undefined && (modelEntityQuery.isPending || providersQuery.isPending);
  const modelBaseUrl = memoryAdvisorModelBaseUrl(
    modelEntityQuery.data,
    providersQuery.data?.items.find((item) => item.id === chosenModel?.provider_id),
    status?.model === chosenModel?.id ? status?.origin : undefined,
  );
  const endpointIssue = !needsEndpoint || draft.endpoint.trim() === '' || endpointPending
    ? null
    : memoryAdvisorEndpointIssue(draft.endpoint, modelBaseUrl);
  const providerOrigin = (() => { try { return modelBaseUrl === undefined ? undefined : new URL(modelBaseUrl).origin; } catch { return undefined; } })();
  const selector = memoryAdvisorSelectorFromDraft(draft);
  const selectorValid = selector !== null && endpointIssue === null && !(needsEndpoint && endpointPending);

  /** One write at a time; resolves `true` only when the server accepted it. */
  const write = (next: WriteSlot, patch: MemorySettingsPatch): Promise<boolean> => {
    if (advisor.save.isPending) return Promise.resolve(false);
    setSlot(next);
    return advisor.save.mutateAsync(patch).then(() => { ping(); return true; }, () => false);
  };
  const statusFor = (key: WriteSlot) => (slot === key ? <SaveStatus saving={advisor.save.isPending} saved={saved && !advisor.save.isError} /> : null);
  const busy = advisor.query.isPending || advisor.save.isPending;

  const probe = useMutation({
    mutationFn: (destination: string) => client.probeMemoryAdvisor(destination),
  });
  useEffect(() => { probe.reset(); }, [status?.destination, workspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectWorkspace = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('workspace', id);
    setParams(next, { replace: true });
  };

  const destination = status?.destination;
  const consented = workspace !== undefined && destination !== undefined && memoryAdvisorConsented(config, workspace.id, destination);
  const memoryOff = status?.state === 'disabled' || data?.effective_enabled === false;
  const reasonKey = memoryAdvisorReasonKey(status?.reason);
  const feedback: Feedback = advisor.query.isError
    ? { tone: 'error', text: t('memory.advisor.loadFailed', { detail: errorText(locale, advisor.query.error) }) }
    : advisor.save.isError
      ? { tone: 'error', text: t('memory.advisor.saveFailed', { detail: errorText(locale, advisor.save.error) }) }
      : null;
  const dot = view.tone === 'ok' ? 'ok' : view.tone === 'danger' ? 'error' : view.tone === 'caution' ? 'waiting' : 'off';

  return (
    <SectionCard id="st-card-memory-advisor" title={t('memory.advisor.title')} actions={(
      <span className="inline-flex items-center gap-2">
        {statusFor('switch')}
        <Toggle id="memory-advisor-enabled" layout="bare" label={t('memory.advisor.switch')} checked={view.on}
          disabled={busy}
          onChange={(on) => { void write('switch', memoryAdvisorModePatch(on, config)); }} />
      </span>
    )}>
      <div className="min-w-0 space-y-5" data-memory-advisor-settings>
        <div className="space-y-1">
          <p data-memory-advisor-status={view.kind} role="status" className="flex items-center gap-2 text-[13px] text-ink">
            {dot === 'off' ? null : <span aria-hidden className="inline-flex"><StatusDot state={dot} label="" /></span>}
            <span>{t(view.stateKey)}</span>
            {status?.model !== undefined && view.on ? <span className="truncate font-mono text-[12px] text-ink-faint">{status.model}</span> : null}
          </p>
          {memoryOff ? <p data-memory-advisor-memory-off className="max-w-[62ch] text-[12px] leading-snug text-amber-ink">{t('memory.advisor.memoryOff')}</p>
            : view.kind === 'problem' && reasonKey !== undefined ? <p data-memory-advisor-reason className="max-w-[62ch] text-[12px] leading-snug text-danger">{t(reasonKey)}</p>
              : <Hint>{t('memory.advisor.switchHint')}</Hint>}
        </div>

        <SettingsGroup title={t('memory.advisor.selectorGroup')}>
          {models.length === 0 && !modelsQuery.isPending ? (
            <div data-memory-advisor-no-models className="flex flex-wrap items-center gap-3">
              <Hint>{t('memory.advisor.modelMissing')}</Hint>
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void navigate(ADD_MODEL_ROUTE); }}>{t('memory.advisor.addModel')}</button>
            </div>
          ) : null}
          <SettingField label={t('memory.advisor.model')} htmlFor="memory-advisor-model" help={t('memory.advisor.modelHint')}>
            <SearchableSelect id="memory-advisor-model" value={draft.model} options={modelOptions} allowCustomValue
              ariaLabel={t('memory.advisor.model')} emptyText={t('memory.advisor.modelEmpty')}
              searchPlaceholder={t('memory.advisor.modelEmpty')} align="end" placement="auto"
              buttonClassName={`${SETTINGS_SELECT_TRIGGER} min-w-56 max-w-72`}
              onChange={(model) => { setDraft((current) => ({ ...current, model })); }} />
          </SettingField>
          <SettingField label={t('memory.advisor.protocol')} labelId="memory-advisor-protocol-label"
            help={t(`memory.advisor.protocolHint.${draft.protocol}` as I18nKey)}>
            <SettingsSegmented<MemoryAdvisorProtocol> ariaLabelledBy="memory-advisor-protocol-label" dataAttr="data-memory-advisor-protocol"
              value={draft.protocol} onChange={(protocol) => { setDraft((current) => ({ ...current, protocol })); }}
              choices={MEMORY_ADVISOR_PROTOCOLS.map((value) => ({ value, label: t(`memory.advisor.protocol.${value}` as I18nKey) }))} />
          </SettingField>
          {draft.protocol !== 'chat_json' ? (
            <SettingField label={t('memory.advisor.endpoint')} htmlFor="memory-advisor-endpoint" layout="stack"
              help={providerOrigin === undefined || endpointIssue !== null ? undefined : t('memory.advisor.endpointHint', { origin: providerOrigin })}>
              <input id="memory-advisor-endpoint" data-memory-advisor-endpoint className={`${INPUT} max-w-xl font-mono text-[12px]`}
                value={draft.endpoint} placeholder={providerOrigin === undefined ? 'https://' : `${providerOrigin}/`} spellCheck={false} autoComplete="off"
                aria-invalid={endpointIssue !== null} aria-describedby={endpointIssue === null ? undefined : 'memory-advisor-endpoint-issue'}
                onChange={(event) => { setDraft((current) => ({ ...current, endpoint: event.target.value })); }} />
              {endpointIssue !== null ? (
                <div id="memory-advisor-endpoint-issue" data-memory-advisor-endpoint-issue={endpointIssue.kind} role="alert" className="space-y-1">
                  <p className="max-w-[62ch] text-[12px] leading-snug text-danger">
                    {endpointIssue.kind === 'invalid' ? t('memory.advisor.endpointInvalid')
                      : endpointIssue.kind === 'origin' ? t('memory.advisor.endpointOrigin', { origin: endpointIssue.origin })
                        : t('memory.advisor.endpointNoProvider')}
                  </p>
                  {endpointIssue.kind === 'invalid' ? null : (
                    <button type="button" className="text-[12px] font-medium text-accent-ink hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
                      onClick={() => { void navigate(chosenModel === undefined ? CONNECTIONS_ROUTE : modelSettingsRoute(chosenModel.id)); }}>{t('memory.advisor.openModelSettings')}</button>
                  )}
                </div>
              ) : null}
            </SettingField>
          ) : null}
          <SettingsDraftFooter id="memory-advisor-selector" dirty={dirty} saving={advisor.save.isPending && slot === 'selector'}
            saveDisabled={!selectorValid} saveLabel={t('memory.advisor.saveSelector')}
            onSave={() => { if (selector !== null) void write('selector', { advisor: { selector } }); }}
            onDiscard={() => { setDraft(baseline); }} />
          {!dirty && config?.selector !== undefined ? (
            <div className="flex items-center gap-2 pt-1">
              <button type="button" data-memory-advisor-clear className={SECONDARY_BUTTON} disabled={busy}
                onClick={() => { void write('selector', { advisor: { selector: null } }); }}>{t('memory.advisor.clearSelector')}</button>
              {statusFor('selector')}
            </div>
          ) : null}
        </SettingsGroup>
        <SettingsGroup title={t('memory.advisor.egress')}>
          {workspaces.length === 0 && !workspacesQuery.isPending ? <Hint>{t('memory.advisor.egressNoWorkspace')}</Hint> : null}
          {workspace !== undefined && destination !== undefined && workspaces.length > 1 ? (
            <SettingField label={t('memory.advisor.egressWorkspace')}>
              <SettingsSelect id="memory-advisor-workspace" dataAttr="data-memory-advisor-workspace" ariaLabel={t('memory.advisor.egressWorkspace')}
                className="max-w-64" value={workspace.id} onChange={selectWorkspace}
                choices={workspaces.map((item) => ({ value: item.id, label: item.name, hint: item.root }))} />
            </SettingField>
          ) : null}
          {workspace !== undefined && destination === undefined ? <Hint>{t('memory.advisor.egressNoDestination')}</Hint> : null}
          {workspace !== undefined && destination !== undefined ? (
            <div data-memory-advisor-egress={consented ? 'allowed' : 'required'} className="space-y-2">
              <dl className="grid max-w-xl grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-[13px]">
                <dt className="text-ink-soft">{t('memory.advisor.destination')}</dt>
                <dd data-memory-advisor-destination className="min-w-0 break-all font-mono text-[12px] text-ink">{destination}</dd>
              </dl>
              <p className="max-w-[62ch] text-[12px] leading-snug text-ink-soft">
                {t('memory.advisor.egressBody', { workspace: workspace.name, destination: status?.origin ?? destination })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {consented ? (
                  <>
                    <span data-memory-advisor-allowed className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft">
                      <span aria-hidden className="inline-flex"><StatusDot state="ok" label="" /></span>{t('memory.advisor.egressAllowed')}
                    </span>
                    <button type="button" data-memory-advisor-revoke className={SECONDARY_BUTTON} disabled={busy}
                      onClick={() => { void write('consent', memoryAdvisorConsentPatch(config, workspace.id, destination, false)); }}>{t('memory.advisor.egressRevoke')}</button>
                  </>
                ) : (
                  <button type="button" data-memory-advisor-allow className={PRIMARY_BUTTON} disabled={busy}
                    onClick={() => { void write('consent', memoryAdvisorConsentPatch(config, workspace.id, destination, true)); }}>{t('memory.advisor.egressAllow')}</button>
                )}
                {statusFor('consent')}
              </div>
            </div>
          ) : null}
          {destination !== undefined ? <ProbeRow result={probe.data} error={probe.error} pending={probe.isPending} onRun={() => { probe.mutate(destination); }} /> : null}
        </SettingsGroup>
        <AdvancedDetails summary={t('memory.advisor.advanced')} data-memory-advisor-advanced>
          <div className="space-y-1 text-[13px] text-ink">
            <SettingField label={t('memory.advisor.mode')} labelId="memory-advisor-mode-label"
              help={t(config?.mode === 'select' ? 'memory.advisor.modeHint.select' : 'memory.advisor.modeHint.rank')}>
              {statusFor('mode')}
              <SettingsSegmented<'rank' | 'select'> ariaLabelledBy="memory-advisor-mode-label" dataAttr="data-memory-advisor-mode"
                value={config?.mode === 'select' ? 'select' : 'rank'} disabled={busy || !view.on}
                onChange={(mode) => { void write('mode', { advisor: { mode } }); }}
                choices={[
                  { value: 'rank', label: t('memory.advisor.mode.rank') },
                  { value: 'select', label: t('memory.advisor.mode.select'), disabled: config?.selector?.protocol === 'pair_score' },
                ]} />
            </SettingField>
            <SettingField label={t('memory.advisor.children')} htmlFor="memory-advisor-children" help={t('memory.advisor.childrenHint')}>
              {statusFor('children')}
              <Toggle id="memory-advisor-children" layout="bare" label={t('memory.advisor.children')}
                checked={config?.apply_to_children ?? MEMORY_ADVISOR_DEFAULTS.apply_to_children} disabled={busy}
                onChange={(apply_to_children) => { void write('children', { advisor: { apply_to_children } }); }} />
            </SettingField>
            <div className="grid gap-x-6 gap-y-1 pt-1 sm:grid-cols-2" data-memory-advisor-numbers>
              {MEMORY_ADVISOR_NUMBER_FIELDS.map((field) => {
                const range = MEMORY_ADVISOR_RANGES[field];
                return (
                  <SettingField key={field} label={t(`memory.advisor.field.${field}` as I18nKey)} htmlFor={`memory-advisor-${field}`}
                    detail={t('memory.advisor.fieldDefault', { value: range.fallback })}>
                    {statusFor(field)}
                    <CommitInput id={`memory-advisor-${field}`} dataAttr={`data-memory-advisor-${field.replaceAll('_', '-')}`}
                      className="w-24 text-right" inputMode="numeric" disabled={busy}
                      value={String(config?.[field] ?? range.fallback)}
                      validate={(text) => (parseMemoryAdvisorNumber(field, text) === null ? t('memory.advisor.fieldInvalid', { min: range.min, max: range.max }) : null)}
                      onCommit={(text) => { void write(field, { advisor: { [field]: Number(text) } }); }} />
                  </SettingField>
                );
              })}
            </div>
            <MemoryAdvisorRuntime workspaceId={workspace?.id} config={config} />
            {config !== undefined ? (
              <div className="pt-3">
                <button type="button" data-memory-advisor-remove className={DANGER_GHOST_BUTTON} disabled={busy}
                  onClick={() => { setConfirmRemove(true); }}>{t('memory.advisor.remove')}</button>
              </div>
            ) : null}
          </div>
        </AdvancedDetails>
        <ConfirmDialog open={confirmRemove} title={t('memory.advisor.removeTitle')} body={t('memory.advisor.removeBody')}
          confirmLabel={t('memory.advisor.removeConfirm')} busy={advisor.save.isPending}
          onCancel={() => { setConfirmRemove(false); advisor.save.reset(); }}
          onConfirm={() => { void write('remove', { advisor: null }).then((ok) => { if (ok) setConfirmRemove(false); }); }}>
          {/* A refused removal keeps the dialog open: the reason sits here and
              the same button tries again. */}
          {slot === 'remove' && advisor.save.isError ? (
            <p data-memory-advisor-remove-error role="alert" className="text-[12px] leading-snug text-danger">
              {t('memory.advisor.saveFailed', { detail: errorText(locale, advisor.save.error) })}
            </p>
          ) : null}
        </ConfirmDialog>

        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * The optional synthetic check. It goes to the confirmed destination only, so
 * it is offered once a destination exists; the result line says how the
 * selector answered, or why it did not, in the same reasons the status uses.
 */
function ProbeRow({ result, error, pending, onRun }: {
  readonly result: MemoryAdvisorProbeResult | undefined;
  readonly error: unknown;
  readonly pending: boolean;
  readonly onRun: () => void;
}) {
  const { t, locale } = useI18n();
  const reasonKey = memoryAdvisorReasonKey(result?.status.reason);
  const feedback: Feedback = pending ? null
    : error !== null && error !== undefined ? { tone: 'error', text: t('memory.advisor.testFailed', { reason: errorText(locale, error) }) }
      : result === undefined ? null
        : result.ok ? {
          tone: 'success',
          text: [
            t('memory.advisor.testOk', { ms: Math.round(result.duration_ms) }),
            result.usage_known && result.input_tokens !== undefined ? t('memory.advisor.testTokens', { input: result.input_tokens, output: result.output_tokens ?? 0 }) : '',
          ].filter((part) => part !== '').join(' '),
        }
          : { tone: 'error', text: t('memory.advisor.testFailed', { reason: reasonKey === undefined ? t(`memory.advisor.state.${result.status.state}` as I18nKey) : t(reasonKey) }) };
  return (
    <div data-memory-advisor-probe className="space-y-1.5 pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" data-memory-advisor-test className={SECONDARY_BUTTON} disabled={pending} onClick={onRun}>
          {pending ? t('memory.advisor.testing') : t('memory.advisor.test')}
        </button>
        <span className="text-[12px] text-ink-faint">{t('memory.advisor.testHint')}</span>
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

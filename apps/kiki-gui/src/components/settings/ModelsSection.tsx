import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';

import type {
  GenerationParametersPatch,
  GenerationParametersWire,
  ModelCatalogItem,
  ModelEntity,
  ModelGenerationMigrationPreviewResponse,
  ModelProtocol,
  ModelSteeringSource,
  ProviderCatalogItem,
} from '@kiki/protocol';

import { errorText, issueText, type I18nKey } from '@kiki/session-core/i18n';
import {
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_MODEL_SUPPORT_EFFORTS,
  KNOWN_CAPABILITIES,
  KNOWN_EFFORTS,
  modelPatchBody,
  providerModelDraftFromCatalog,
  providerModelDraftsEqual,
  requestIdentityLayerDraftFromPolicy,
  requestIdentityPolicyFromDraft,
  sessionTitleModelPatch,
  sortThinkingEffortsForDisplay,
  validateImagePolicyDraft,
  validateRequestIdentityLayerDraft,
  writeSettings,
  type ProviderModelDraft,
  type RequestIdentityLayerDraft,
} from '@kiki/session-core/settings';
import { formatTokens } from '@kiki/session-core/util';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ChipSelect } from '../ChipSelect';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, SavedTick, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import {
  AdvancedDisclosure,
  CapabilityMarks,
  ContextStepper,
  ImagePolicyEditor,
  SavedGenerationParametersEditor,
} from '../ProviderFields';
import { GlobalCompactionCard, ModelContextFields, CompactPointTrack, useModelCompactionTrack } from './ContextWindowSettings';
import { CompactPointField } from './CompactPointField';
import { RequestIdentityLayerEditor } from '../RequestIdentityLayerEditor';
import { REQUEST_IDENTITY_QUERY_KEY, useCustomIdentityChoices } from './identityCatalog';
import { SearchableSelect } from '../SearchableSelect';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { FORM_LABEL, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { effortLabel } from './profileEditor/profileDraft';
import { SettingField } from './fields';
import { useInstantSave } from './useInstantSave';
import { LoopLimitsCard } from './LoopLimitsCard';
import { RetryPolicyCard } from './RetryPolicyCard';
import { TokenCountingCard } from './CommunicationSection';
import { ModelSwitchCard } from './ModelSwitchCard';
import {
  ModelEngineFieldError,
  ModelEngineFields,
  modelEngineDraft,
  modelEngineDraftsEqual,
  modelEnginePatch,
  type EngineField,
  type ModelEngineDraft,
} from './ModelEngineFields';
import { MainUsagePolicyFields, type SharedUsageEdit, type UsagePolicyView } from './MainUsagePolicyFields';
import { ModelEditScopeSwitch } from './ModelEditScopeSwitch';
import { ModelProtocolField } from './ModelProtocolField';
import { protocolChoiceFrom, protocolCreateField, protocolPatchField, type ModelProtocolChoice } from './modelProtocolDraft';
import { ModelRecipeField } from './ModelRecipeField';
import { ModelPromptBodies } from './ModelPromptBodies';
import { branchSelectionFor, modelPromptsDraft, modelPromptsEqual, modelPromptsPatch, type ModelPromptsDraft } from './modelPromptsDraft';
import { ModelSteerSources } from './ModelSteerSources';
import {
  modelSteerSourcesDraft, steerCadenceProblem, steerScopeFor, steerSourceDraft, steerSourcesEqual, steerSourcesPatch,
  STEER_SCOPES, STEER_SOURCES,
  type ModelSteerSourcesDraft, type SteerSourceDraft,
} from './modelSteerSourceDraft';
import { PROMPT_POSITIONS, type EditScope } from './modelEditScope';
import { cognitionSlotPatchAtScope, initialSlotText, slotView, type CognitionSlot } from './modelCognitionBodies';
import {
  EMPTY_USAGE_BRANCH,
  USAGE_POLICY_FIELDS,
  USAGE_POSITIONS,
  usageBranchDraft,
  usageBranchProblem,
  usageEffectiveFor,
  setUsageText,
  usagePolicyDraftsEqual,
  usagePolicyPatch,
  usageSourceFor,
  type UsageBranchDraft,
  type UsagePolicyDraft,
  type UsagePolicyField,
  type UsagePosition,
} from './mainUsagePolicyDraft';
import { useSavedTick } from './useSavedTick';
import { QuestionGuardFields, rangeTextFor } from './QuestionGuardFields';
import {
  EMPTY_GUARD_DRAFT,
  clearGuardNumber,
  guardDraftFromModelBehavior,
  guardDraftProblem,
  guardDraftsEqual,
  guardEffective,
  guardInherited,
  questionGuardModelPatch,
  setGuardNumber,
  type GuardNumberField,
  type QuestionGuardDraft,
} from './questionGuardDraft';
import { DisclosureChevron, Icon } from '../icons';
import { selectGlobalDefaultModel } from './defaultModelSelection';
import { OriginBadge } from './spaces/OriginBadge';
import { DetailBack, DetailRailGroup, DetailRailItem, DetailSplit, useDetailParam } from '../overlays';
import { LIST_ROW_HEIGHT, ListBody, type ListDensity } from './list';

function requestIdentityDraftsEqual(
  a: RequestIdentityLayerDraft,
  b: RequestIdentityLayerDraft,
): boolean {
  return a.requestIdentityChoice === b.requestIdentityChoice
    && a.requestIdentityOverridesJson === b.requestIdentityOverridesJson;
}

export function GlobalRequestIdentityCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RequestIdentityLayerDraft>(() =>
    requestIdentityLayerDraftFromPolicy(undefined));
  const [baseline, setBaseline] = useState<RequestIdentityLayerDraft>(() =>
    requestIdentityLayerDraftFromPolicy(undefined));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  // Text draft, parsed on save: a JSON problem lands under the textarea, not in the footer.
  const [jsonIssue, setJsonIssue] = useState<string | null>(null);
  const [saved, markSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const customProfiles = useCustomIdentityChoices();
  const dirty = !requestIdentityDraftsEqual(draft, baseline);

  useEffect(() => {
    if (configQuery.data === undefined || dirty) return;
    const next = requestIdentityLayerDraftFromPolicy(configQuery.data.request_identity);
    setDraft(next);
    setBaseline(next);
  }, [configQuery.data, dirty]);

  const save = async () => {
    let requestIdentity: ReturnType<typeof requestIdentityPolicyFromDraft>;
    try {
      requestIdentity = requestIdentityPolicyFromDraft(draft);
    } catch (error) {
      setJsonIssue(errorText(locale, error));
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ request_identity: requestIdentity ?? null });
      queryClient.setQueryData(['config'], echoed);
      void queryClient.invalidateQueries({ queryKey: REQUEST_IDENTITY_QUERY_KEY });
      const next = requestIdentityLayerDraftFromPolicy(echoed.request_identity);
      setDraft(next);
      setBaseline(next);
      markSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-request-identity" title={t('st.requestIdentity.defaultTitle')}>
      <RequestIdentityLayerEditor
        value={draft}
        onChange={(next) => { setDraft(next); setJsonIssue(null); }}
        label={t('st.requestIdentity.defaultLabel')}
        inheritLabel={t('st.requestIdentity.inheritBuiltin')}
        hint={t('st.requestIdentity.defaultHint')}
        issue={jsonIssue}
        customProfiles={customProfiles}
      />
      {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
      <SettingsDraftFooter id="global-request-identity" dirty={dirty} saving={saving} saved={saved}
        saveDisabled={jsonIssue !== null}
        onSave={() => void save()}
        onDiscard={() => { setDraft(baseline); setJsonIssue(null); setFeedback(null); }} />
      <FeedbackLine feedback={feedback} />
    </SectionCard>
  );
}

/**
 * Which per-job defaults point at each model. Marks a row in place; it is not
 * a group or a filter, so a model in use is found where it already lives.
 */
function useModelRoles(): ReadonlyMap<string, readonly string[]> {
  const { client } = useConnection();
  const { t } = useI18n();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const config = configQuery.data;
  return useMemo(() => {
    const out = new Map<string, string[]>();
    const add = (id: string | undefined, label: string) => {
      if (id === undefined || id === '') return;
      out.set(id, [...(out.get(id) ?? []), label]);
    };
    add(config?.default_model, t('st.defaults.row.newSession'));
    add(config?.session_title?.model, t('st.defaults.row.title'));
    add(config?.fast_model, t('st.defaults.row.fast'));
    add(config?.subagent?.defaultModel, t('st.defaults.row.subagent'));
    return out;
  }, [config, t]);
}

/** The `?model=` query: the one model whose editor a link asks to open. */
export const MODEL_QUERY_PARAM = 'model';

/**
 * The stored models of one connection, inside its provider editor.
 *
 * A row opens the model's detail in the page (`ModelDetailSplit`, the
 * in-page detail tier): the connections fold into a rail and the editor
 * takes the column, addressed by `?model=<id>`. The provider form around the
 * rows owns the connection and the rows that do not exist yet; it never
 * writes a stored model's fields itself, so there is one draft per model.
 *
 * The star sets the global new-session default.
 */
export function ProviderModelList({ providerId, models }: {
  providerId: string;
  /** Every configured model; the list keeps this connection's own. */
  models: readonly ModelCatalogItem[];
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const detail = useDetailParam(MODEL_QUERY_PARAM);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const defaultModel = configQuery.data?.default_model;
  const roles = useModelRoles();
  const own = useMemo(
    () => models.filter((item) => item.provider_id === providerId)
      .toSorted((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel)
        || (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id)),
    [models, providerId, defaultModel],
  );

  const selectDefaultModel = async (item: ModelCatalogItem) => {
    setBusy(true);
    setFeedback(null);
    const selection = selectGlobalDefaultModel(client, queryClient, item);
    try {
      if (await selection.completed) ping();
    } catch (error) {
      if (selection.isCurrent()) setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-provider-models={providerId}>
      {own.length > 0 ? (
        <ListBody items={own} keyOf={(item) => item.id} density="comfortable" label={t('st.providerModels.title')}
          virtualizeAfter={Number.POSITIVE_INFINITY}
          renderRow={(item) => (
            <ModelRow
              item={item}
              density="comfortable"
              isDefault={item.id === defaultModel}
              roles={roles.get(item.id)}
              attention={false}
              busy={busy}
              open={item.id === detail.selected}
              onSetDefault={() => void selectDefaultModel(item)}
              onOpen={() => { detail.open(item.id); }}
            />
          )} />
      ) : (
        <p className="text-[12px] leading-4 text-ink-faint" data-provider-models-empty>{t('st.providerModels.empty')}</p>
      )}
      <SavedTick show={tick} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/**
 * The connections page with one model open in it. `list` is the page as it
 * reads without a model; with `?model=<id>` it folds into a rail of
 * connections and their models, and the model editor takes the column. No
 * scrim, nothing modal: the rail switches models, Back or Close returns, and
 * an unsaved draft is guarded by the shared leave prompt.
 */
export function ModelDetailSplit({ list, models, providers, ready, providerLabel, onChanged }: {
  list: React.ReactNode;
  models: readonly ModelCatalogItem[];
  providers: readonly ProviderCatalogItem[];
  /** The model list has loaded; a `?model=` naming no model then closes. */
  ready: boolean;
  /** Rail heading per connection; defaults to its id. */
  providerLabel?: (providerId: string) => string;
  onChanged: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const detail = useDetailParam(MODEL_QUERY_PARAM);
  const [busy, setBusy] = useState(false);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const defaultModel = configQuery.data?.default_model;
  const roles = useModelRoles();
  const item = detail.selected === null ? undefined : models.find((model) => model.id === detail.selected);
  // A link to a model that is not there (removed, or never was) lands on the list.
  useEffect(() => {
    if (ready && detail.selected !== null && item === undefined) detail.close();
  }, [ready, detail.selected, item, detail.close]);

  const groups = useMemo(() => [...new Set(models.map((model) => model.provider_id))].map((id) => ({
    id,
    models: models.filter((model) => model.provider_id === id)
      .toSorted((a, b) => (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id)),
  })), [models]);

  const setDefault = async (target: ModelCatalogItem) => {
    setBusy(true);
    try {
      await selectGlobalDefaultModel(client, queryClient, target).completed;
    } catch {
      // The editor's default control re-reads config; nothing to keep here.
    } finally {
      setBusy(false);
    }
  };

  const rail = <div data-model-rail>
    {groups.map((group) => (
      <DetailRailGroup key={group.id} label={providerLabel?.(group.id) ?? group.id} count={group.models.length}>
        {group.models.map((model) => (
          <DetailRailItem key={model.id} itemKey={model.id} label={model.display_name ?? model.id}
            current={model.id === item?.id}
            trailing={model.id === defaultModel ? <Icon name="starFilled" size={12} className="shrink-0 text-ink-soft" /> : undefined}
            onSelect={() => { detail.open(model.id); }} />
        ))}
      </DetailRailGroup>
    ))}
  </div>;

  const editor = item === undefined ? null : (
    <div data-model-detail={item.id} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="basis-full md:hidden">
          <DetailBack label={t('st.providerModels.title')} onClick={detail.close} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 data-detail-heading tabIndex={-1} className="truncate font-display text-[20px] leading-tight text-ink outline-none">{item.display_name ?? item.id}</h3>
          <p className="mt-1 truncate font-mono text-[11.5px] text-ink-faint">{item.id}</p>
        </div>
        <button type="button" onClick={detail.close} aria-label={t('common.close')} title={t('common.close')} data-detail-close
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink md:flex">
          <Icon name="close" size={14} />
        </button>
      </header>
      <div data-model-row-editor={item.id} className="flex min-w-0 flex-col">
        <ModelCatalogRowEditor
          key={item.id}
          item={item}
          inheritedImageTypes={providers.find((provider) => provider.id === item.provider_id)?.images?.accepted_types}
          isDefault={item.id === defaultModel}
          defaultBusy={busy}
          roles={roles.get(item.id)}
          onSetDefault={() => void setDefault(item)}
          onSaved={onChanged}
          onClose={detail.close}
          onRemoved={detail.close}
        />
      </div>
    </div>
  );

  return <DetailSplit selected={item?.id ?? null} label={t('st.providerModels.title')} list={list} rail={rail} detail={editor}
    data={{ 'data-model-split': '' }} />;
}

/**
 * Picker look for the per-job default rows below. The new-session default is
 * not one of them: it is the bar above every Models & providers tab
 * (`DefaultModelBar`), so it is stated in exactly one place.
 */
const DEFAULT_PICKER =
  'flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-ink/[0.04] px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.07] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint';

/**
 * Every "which model does this job use" choice besides new sessions: titles,
 * the fast model and subagents. Each row applies on pick.
 */
export function GlobalDefaultsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'title' | 'subagent' | 'fast' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const models = modelsQuery.data?.items ?? [];
  const titleModel = configQuery.data?.session_title?.model ?? '';
  const subagentModel = configQuery.data?.subagent?.defaultModel ?? '';
  const fastModel = configQuery.data?.fast_model ?? '';
  const options = useMemo(() => buildCatalogModelOptions(models, t), [models, t]);

  // These two keys PATCH the normal config route, then re-read GET /config.
  const pickConfigModel = async (which: 'subagent' | 'fast', modelId: string) => {
    if (modelId === (which === 'subagent' ? subagentModel : fastModel)) return;
    setBusy(which);
    setFeedback(null);
    try {
      if (which === 'subagent') await client.setSubagentDefaultModel(modelId);
      else await client.setFastModel(modelId);
      queryClient.setQueryData(['config'], await client.getConfig());
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  const pickTitle = async (modelId: string) => {
    if (modelId === titleModel) return;
    setBusy('title');
    setFeedback(null);
    try {
      // The patch writes only the model, so the moments and the title
      // instruction configured elsewhere are left exactly as they are.
      queryClient.setQueryData(['config'], await client.patchConfig(sessionTitleModelPatch(modelId)));
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  const rows = [
    {
      id: 'session-title',
      origin: { domain: 'session_title', keyPath: ['model'] },
      label: t('st.defaults.row.title'),
      help: titleModel === ''
        ? t('st.defaults.row.titleUnset')
        : t('st.defaults.row.titleHelp'),
      picker: (
        <SearchableSelect
          id="st-default-title-model"
          value={titleModel}
          options={[{
            value: '',
            label: t('st.sessionTitleModel.noneDefault'),
            // The engine writes titles with this model and nothing else, so
            // the empty option is "no titles", not a hidden default.
            description: t('st.sessionTitleModel.noneDesc'),
          }, ...options]}
          onChange={(value) => void pickTitle(value)}
          ariaLabel={t('st.defaults.row.title')}
          searchPlaceholder={t('st.models.searchPlaceholder')}
          emptyText={t('st.sessionTitleModel.noneDefault')}
          allowCustomValue
          disabled={busy !== null}
          buttonClassName={DEFAULT_PICKER}
        />
      ),
    },
    {
      id: 'fast',
      origin: { domain: 'fast_model', keyPath: [] },
      label: t('st.defaults.row.fast'),
      help: t('st.defaults.row.fastHelp'),
      picker: (
        <SearchableSelect
          id="st-default-fast-model"
          value={fastModel}
          options={[{ value: '', label: t('st.defaults.row.fastUnset') }, ...options]}
          onChange={(value) => void pickConfigModel('fast', value)}
          ariaLabel={t('st.defaults.row.fast')}
          searchPlaceholder={t('st.models.searchPlaceholder')}
          emptyText={t('st.defaults.row.fastUnset')}
          allowCustomValue
          disabled={busy !== null}
          buttonClassName={DEFAULT_PICKER}
        />
      ),
    },
    {
      id: 'subagent',
      origin: { domain: 'subagent', keyPath: ['defaultModel'] },
      label: t('st.defaults.row.subagent'),
      help: t('st.defaults.row.subagentHelp'),
      picker: (
        <SearchableSelect
          id="st-default-subagent-model"
          value={subagentModel}
          options={[{ value: '', label: t('st.defaults.row.subagentUnset') }, ...options]}
          onChange={(value) => void pickConfigModel('subagent', value)}
          ariaLabel={t('st.defaults.row.subagent')}
          searchPlaceholder={t('st.models.searchPlaceholder')}
          emptyText={t('st.defaults.row.subagentUnset')}
          allowCustomValue
          disabled={busy !== null}
          buttonClassName={DEFAULT_PICKER}
        />
      ),
    },
  ];
  const pickerId: Record<string, string> = {
    'session-title': 'st-default-title-model',
    fast: 'st-default-fast-model', subagent: 'st-default-subagent-model',
  };

  return (
    <SectionCard id="st-card-global-defaults" title={t('st.defaults.globalTitle')}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Hint>{t('st.defaults.globalHint')}</Hint>
          <span className="ml-auto"><SavedTick show={tick} /></span>
        </div>
        <div className="divide-y divide-hairline">
          {rows.map((row) => (
            <div key={row.id} data-default-row={row.id}
              className="grid gap-x-6 gap-y-1.5 py-3 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:items-center">
              <div className="min-w-0">
                <label htmlFor={pickerId[row.id]} className="text-[13px] text-ink">{row.label}</label>
                <p className="text-[12px] leading-4 text-ink-faint">{row.help}</p>
                {/* Only inside an independent space: where this value comes from. */}
                <div className="pt-1 empty:hidden" data-default-origin={row.id}>
                  <OriginBadge config={configQuery.data} domain={row.origin.domain} keyPath={row.origin.keyPath} label={row.label} />
                </div>
              </div>
              <div className="min-w-0">{row.picker}</div>
            </div>
          ))}
        </div>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function ThinkingCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effort, setEffort] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();

  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const defaultModel = configQuery.data?.default_model;
  const defaultItem = (modelsQuery.data?.items ?? []).find((item) => item.id === defaultModel);
  const thinking = asRecord(configQuery.data?.thinking);

  const syncThinking = useCallback(() => {
    const configured = thinking?.['effort'];
    setThinkingEnabled(thinking?.['enabled'] !== false);
    setEffort(typeof configured === 'string' ? configured : (defaultItem?.default_effort ?? ''));
  }, [defaultItem?.default_effort, thinking]);

  useEffect(() => { syncThinking(); }, [syncThinking]);

  const saveThinking = async (enabled: boolean, nextEffort: string) => {
    setThinkingEnabled(enabled);
    setEffort(nextEffort);
    if (enabled && nextEffort.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.thinking.emptyError') });
      syncThinking();
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ thinking: { enabled, effort: nextEffort.trim() || undefined } });
      queryClient.setQueryData(['config'], echoed);
      const echoedThinking = asRecord(echoed.thinking);
      const echoedEnabled = echoedThinking?.['enabled'] !== false;
      const echoedEffort = typeof echoedThinking?.['effort'] === 'string' ? echoedThinking['effort'] : nextEffort.trim();
      setThinkingEnabled(echoedEnabled);
      setEffort(echoedEffort);
      writeSettings({ defaultEffort: echoedEffort || undefined });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncThinking();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard id="st-card-thinking" title={t('st.thinking.title')}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Toggle label={t('st.thinking.enable')} checked={thinkingEnabled} disabled={busy} onChange={(checked) => void saveThinking(checked, effort)} />
          {defaultItem?.support_efforts !== undefined && defaultItem.support_efforts.length > 0 ? (
            <SettingsSegmented
              ariaLabel={t('st.thinking.title')}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(value) => void saveThinking(thinkingEnabled, value)}
              choices={sortThinkingEffortsForDisplay(defaultItem.support_efforts).map((level) => ({ value: level, label: effortLabel(level) }))}
            />
          ) : (
            <input
              aria-label={t('st.thinking.title')}
              className={`${SMALL_INPUT} w-32`}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(event) => { setEffort(event.target.value); }}
              onBlur={() => void saveThinking(thinkingEnabled, effort)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveThinking(thinkingEnabled, effort);
              }}
              placeholder={t('st.thinking.placeholder')}
            />
          )}
          <SavedTick show={tick} />
        </div>
        <Hint>{t('st.thinking.hint')}</Hint>
        <FeedbackLine feedback={feedback} />
        <ThinkingKeepField stored={typeof thinking?.['keep'] === 'string' ? thinking['keep'] : undefined} />
      </div>
    </SectionCard>
  );
}

const THINKING_KEEP_OFF = new Set(['0', 'false', 'no', 'off', 'none', 'null']);

/**
 * `[thinking].keep`: pass earlier turns' reasoning back to the model. The
 * engine reads any off-word as "off" and treats every other string as a
 * keep mode; a custom stored value is listed as its own choice.
 */
function ThinkingKeepField({ stored }: { stored: string | undefined }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const save = useInstantSave();
  const current = stored === undefined ? 'all' : THINKING_KEEP_OFF.has(stored.trim().toLowerCase()) ? 'none' : stored;
  const choices = [
    { value: 'all', label: t('st.thinking.keepAll') },
    { value: 'none', label: t('st.thinking.keepNone') },
    ...(current !== 'all' && current !== 'none' ? [{ value: current, label: current }] : []),
  ];
  return (
    <>
      <SettingField label={t('st.thinking.keep')} help={t('st.thinking.keepHelp')}>
        <SaveStatus saving={save.saving} saved={save.saved} />
        <SettingsSelect
          id="thinking-keep"
          ariaLabel={t('st.thinking.keep')}
          value={current}
          dataAttr="data-thinking-keep"
          disabled={save.saving}
          choices={choices}
          onChange={(keep) => {
            void save.run(async () => {
              const echoed = await client.patchConfig({ thinking: { keep } });
              queryClient.setQueryData(['config'], echoed);
            });
          }}
        />
      </SettingField>
      <FeedbackLine feedback={save.error} />
    </>
  );
}

/**
 * What a newly added model gets when discovery did not say.
 *
 * Discovery often reports nothing about a model's capabilities, and a model
 * added with an empty list is one Kiki cannot use tools with. So a *new* model
 * starts from the default pair only when discovery reported no list at all.
 * An explicit list, including an empty one, is never widened.
 */
function defaultCapabilitiesFor(discovered: readonly string[] | undefined): string[] {
  return [...new Set(discovered ?? DEFAULT_MODEL_CAPABILITIES)];
}

/**
 * Effort levels in reading order, lowest first. Applied when someone edits
 * the set, never to a stored value that was only opened: reordering on read
 * would turn an untouched row into a pending change.
 */
function sortEfforts(values: readonly string[]): string[] {
  return [...sortThinkingEffortsForDisplay([...values])];
}

/** Explicit fetching and a separate, user-confirmed model creation flow. */
export function CatalogRefreshCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [selected, setSelected] = useState('');
  const [alias, setAlias] = useState('');
  const [context, setContext] = useState(250000);
  const [capabilities, setCapabilities] = useState<string[]>([...DEFAULT_MODEL_CAPABILITIES]);
  // Efforts are seeded, never imposed: a discovery that reports its own set
  // wins, and only a model that reports none starts from the low/high pair.
  const [efforts, setEfforts] = useState<string[]>([...DEFAULT_MODEL_SUPPORT_EFFORTS]);
  const [protocol, setProtocol] = useState<ModelProtocolChoice>('inherit');
  const discovered = useQuery({ queryKey: ['discovered-models'], queryFn: () => client.listDiscoveredModels() });
  const choices = (discovered.data?.items ?? []).flatMap((group) => group.models.map((model) => ({
    value: JSON.stringify([group.provider_id, model.remote_id]),
    providerId: group.provider_id,
    model,
  })));
  const choice = choices.find((item) => item.value === selected);
  useDirtyReporter('discovered-model-draft', choice !== undefined);

  const fetchModels = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await client.refreshAllProviders();
      await queryClient.invalidateQueries({ queryKey: ['discovered-models'] });
      if (result.changed.length > 0) {
        await Promise.all(['models', 'providers', 'config'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      }
      const count = result.discovered?.reduce((sum, group) => sum + group.models.length, 0) ?? 0;
      setFeedback(result.failed.length > 0
        ? { tone: 'error', text: t('st.catalogRefresh.failed', { providers: result.failed.map((failure) => failure.provider).join(', ') }) }
        : { tone: 'success', text: count > 0
          ? t('st.catalogRefresh.fetched', { count, providers: result.discovered?.length ?? 0 })
          : t('st.catalogRefresh.fetchedNone') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (choice === undefined) return;
    setBusy(true);
    setFeedback(null);
    try {
      await client.createModel({
        id: alias.trim() || undefined,
        provider_id: choice.providerId,
        remote_id: choice.model.remote_id,
        display_name: choice.model.display_name,
        max_context_size: context,
        capabilities,
        support_efforts: efforts,
        ...protocolCreateField(protocol),
      });
      setSelected('');
      await Promise.all(['models', 'providers', 'discovered-models'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      setFeedback({ tone: 'success', text: t('st.models.paramsSaved', { model: alias || choice.model.remote_id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setBusy(false); }
  };

  return (
    <SectionCard id="st-card-catalog-refresh" title={t('st.catalogRefresh.title')}>
      <div className="space-y-3">
        <Hint>{t('st.catalogRefresh.hint')}</Hint>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => void fetchModels()}>
          {busy ? t('st.catalogRefresh.fetching') : t('st.catalogRefresh.getModels')}
        </button>
        <SearchableSelect
          value={selected}
          options={choices.map((item) => ({ value: item.value, label: item.model.remote_id, description: item.model.display_name, group: item.providerId, badges: [{ label: t('st.providers.catalogGroupSuggested'), accent: true }] }))}
          onChange={(value) => {
            setSelected(value);
            const item = choices.find((candidate) => candidate.value === value);
            setAlias(item === undefined ? '' : `${item.providerId}/${item.model.remote_id}`);
            setContext(item?.model.max_context_size ?? 250000);
            setCapabilities(defaultCapabilitiesFor(item?.model.capabilities));
            setEfforts(item?.model.support_efforts !== undefined && item.model.support_efforts.length > 0
              ? sortEfforts(item.model.support_efforts)
              : [...DEFAULT_MODEL_SUPPORT_EFFORTS]);
            setProtocol('inherit');
          }}
          ariaLabel={t('st.providers.catalogGroupSuggested')}
          searchPlaceholder={t('st.providers.modelSearchPlaceholder')}
          emptyText={t('st.catalogRefresh.empty')}
          disabled={busy}
        />
        {choice !== undefined ? (
          <div className="space-y-3 pt-3" data-catalog-refresh-form>
            <Hint>{t('st.catalogRefresh.saveHint')}</Hint>
            <label className={FORM_LABEL}>{t('st.catalogRefresh.alias')}
              <input className={`${INPUT} mt-1 font-normal`} value={alias} disabled={busy} onChange={(event) => { setAlias(event.target.value); }} />
            </label>
            <div className="space-y-1">
              <p className={FORM_LABEL}>{t('st.compact.windowLabel')}</p>
              <ContextStepper value={context} onChange={setContext} ariaLabel={t('st.models.contextAria', { model: choice.model.remote_id })} />
            </div>
            <div className="space-y-1">
              <p className={FORM_LABEL}>{t('st.chips.efforts')}</p>
              <ChipSelect
                values={efforts}
                knownOptions={KNOWN_EFFORTS}
                onChange={(next) => { setEfforts(sortEfforts(next)); }}
                ariaLabel={t('st.models.effortsAria', { model: choice.model.remote_id })}
                addPlaceholder={t('st.chips.addPlaceholder')}
                removeLabel={(value) => t('st.chips.removeAria', { value })}
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <p className={FORM_LABEL}>{t('st.chips.capabilities')}</p>
              <ChipSelect
                values={capabilities}
                knownOptions={KNOWN_CAPABILITIES}
                onChange={setCapabilities}
                ariaLabel={t('st.models.capsAria', { model: choice.model.remote_id })}
                addPlaceholder={t('st.chips.addPlaceholder')}
                removeLabel={(value) => t('st.chips.removeAria', { value })}
                disabled={busy}
              />
            </div>
            <ModelProtocolField model={choice.model.remote_id} value={protocol} onChange={setProtocol} disabled={busy} />
            <div className="flex flex-wrap gap-2">
              <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => void save()}>{t('common.save')}</button>
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => { setSelected(''); }}>{t('common.cancel')}</button>
            </div>
          </div>
        ) : null}
        {(discovered.data?.items ?? []).map((group) => (
          <p key={group.provider_id} className={`text-[12px] ${group.failure_reason === undefined ? 'text-ink-faint' : 'text-danger'}`}>
            {group.provider_id} · {t('st.catalogRefresh.suggestedCount', { count: group.models.length })}
            {group.fetched_at === null ? '' : ` · ${new Date(group.fetched_at).toLocaleString(locale)}`}
            {group.failure_reason === undefined ? '' : ` · ${t('st.catalogRefresh.lastFailure', { reason: group.failure_reason })}`}
          </p>
        ))}
        {discovered.isError ? <InlineError error={discovered.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

const MIGRATION_REASON_KEYS: Readonly<Record<ModelGenerationMigrationPreviewResponse['needs_review'][number]['code'], I18nKey>> = {
  invalid_model: 'st.modelMigration.reasonInvalidModel',
  invalid_parameters: 'st.modelMigration.reasonInvalidParameters',
  invalid_value: 'st.modelMigration.reasonInvalidValue',
  differs: 'st.modelMigration.reasonDiffers',
  ambiguous: 'st.modelMigration.reasonAmbiguous',
  default_effort: 'st.modelMigration.reasonDefaultEffort',
  max_output_size: 'st.modelMigration.reasonMaxOutputSize',
};

export function ModelGenerationMigrationCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ModelGenerationMigrationPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | 'restore' | null>(null);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ type: 'apply' } | { type: 'restore'; backupKey: string } | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);

  const refresh = async () => {
    setBusy('preview');
    setPreview(null);
    try {
      setPreview(await client.previewModelGenerationMigration());
      setMessage(null);
    } catch {
      setMessage({ tone: 'error', text: t('st.modelMigration.failed') });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (preview === null || confirmation === null || inFlight.current) return;
    const selected = confirmation;
    inFlight.current = true;
    setConfirmation(null);
    setBusy(selected.type);
    setRestoringKey(selected.type === 'restore' ? selected.backupKey : null);
    try {
      if (selected.type === 'apply') {
        await client.applyModelGenerationMigration(preview.revision);
        setMessage({ tone: 'success', text: t('st.modelMigration.applied', { count: preview.changes.length }) });
        setPreview(null);
      } else {
        await client.restoreModelGenerationMigration(selected.backupKey, preview.revision);
        setMessage({ tone: 'success', text: t('st.modelMigration.restored') });
        setPreview(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
        queryClient.invalidateQueries({ queryKey: ['generation-entity'] }),
      ]);
    } catch (error) {
      setPreview(null);
      const conflict = error !== null && typeof error === 'object' && 'code' in error && error.code === 40941;
      setMessage({ tone: 'error', text: t(conflict ? 'st.modelMigration.conflict' : 'st.modelMigration.failed') });
    } finally {
      inFlight.current = false;
      setRestoringKey(null);
      setBusy(null);
    }
  };

  return (
    <SectionCard id="st-card-model-migration" title={t('st.modelMigration.title')}>
      <div className="space-y-3">
        <Hint>{t('st.modelMigration.hint')}</Hint>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy !== null} onClick={() => void refresh()}>
          {t(busy === 'preview' ? 'st.modelMigration.previewing' : 'st.modelMigration.preview')}
        </button>
        {preview !== null ? (
          <>
            {preview.changes.length === 0 ? <Hint>{t('st.modelMigration.noChanges')}</Hint> : (
              <div>
                <p className="text-xs font-medium text-ink">{t('st.modelMigration.changesTitle')}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-soft">
                  {preview.changes.map(({ model_id: model, fields }) => (
                    <li key={model}>{t('st.modelMigration.changeRow', { model, fields: fields.join(', ') })}</li>
                  ))}
                </ul>
                <button type="button" className={`${PRIMARY_BUTTON} mt-2`} disabled={busy !== null} onClick={() => { setConfirmation({ type: 'apply' }); }}>
                  {t(busy === 'apply' ? 'st.modelMigration.applying' : 'st.modelMigration.apply')}
                </button>
              </div>
            )}
            {preview.needs_review.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-ink">{t('st.modelMigration.needsReviewTitle')}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-soft">
                  {preview.needs_review.map(({ model_id: model, code, field }, index) => (
                    <li key={`${model}-${code}-${index}`}>{t('st.modelMigration.needsReviewRow', {
                      model, reason: t(MIGRATION_REASON_KEYS[code], { field: field ?? '' }),
                    })}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.backups.length > 0 ? (
              <div>
                <p className="text-xs font-medium text-ink">{t('st.modelMigration.backupListTitle')}</p>
                <ul className="mt-1 space-y-2">
                  {preview.backups.map((backup) => (
                    <li key={backup} className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                      <code className="break-all">{backup}</code>
                      <button type="button" className={SECONDARY_BUTTON}
                        disabled={busy !== null}
                        onClick={() => { setConfirmation({ type: 'restore', backupKey: backup }); }}>
                        {t(restoringKey === backup ? 'st.modelMigration.restoring' : 'st.modelMigration.restore')}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
        {message !== null ? <FeedbackLine feedback={message} /> : null}
      </div>
      <ConfirmDialog
        open={confirmation !== null}
        title={t(confirmation?.type === 'restore' ? 'st.modelMigration.restoreConfirmTitle' : 'st.modelMigration.applyConfirmTitle')}
        body={t(confirmation?.type === 'restore' ? 'st.modelMigration.restoreConfirmBody' : 'st.modelMigration.applyConfirmBody')}
        consequences={confirmation?.type === 'restore' ? [confirmation.backupKey] : preview?.changes.map(({ model_id: model, fields }) => t('st.modelMigration.changeRow', { model, fields: fields.join(', ') }))}
        confirmLabel={t(confirmation?.type === 'restore' ? 'st.modelMigration.restoreConfirmAction' : 'st.modelMigration.applyConfirmAction')}
        onConfirm={() => void confirm()}
        onCancel={() => { setConfirmation(null); }}
      />
    </SectionCard>
  );
}

const MAINTENANCE_CARDS = new Set(['#st-card-catalog-refresh', '#st-card-model-migration']);

/**
 * One-off model chores at the end of Providers & accounts: fetch models from
 * every connection at once, and the legacy parameter migration. Each
 * connection already fetches and adds its own models, so these stay folded
 * until a link points at one of them.
 */
export function ModelMaintenance() {
  const { t } = useI18n();
  const { hash } = useLocation();
  const linked = MAINTENANCE_CARDS.has(hash);
  const [open, setOpen] = useState(linked);
  useEffect(() => { if (linked) setOpen(true); }, [linked, hash]);
  return (
    <details className="group pt-4" data-models-maintenance open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}>
      <summary className="flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={false} className="text-ink-soft transition-transform group-open:rotate-90" />
        {t('st.models.maintenance')}
      </summary>
      {open ? (
        <div className="space-y-6 pt-4">
          <CatalogRefreshCard />
          <ModelGenerationMigrationCard />
        </div>
      ) : null}
    </details>
  );
}

/**
 * Defaults tab: which model each job uses, then how models behave by default
 * (thinking, compaction), then what new sessions are allowed to do. Request
 * identity is a protocol-level override and sits last.
 */
export function DefaultsTab() {
  return (
    <div className="space-y-6">
      <GlobalDefaultsCard />
      <ModelSwitchCard />
      <ThinkingCard />
      <GlobalCompactionCard />
      <LoopLimitsCard />
      <RetryPolicyCard />
      <TokenCountingCard />
    </div>
  );
}

const MODEL_ISSUE_KEYS: Readonly<Record<string, I18nKey>> = {
  'model.remote_id_missing': 'st.models.issue.remoteIdMissing',
  'model.provider_missing': 'st.models.issue.providerMissing',
  'model.endpoint_missing': 'st.models.issue.endpointMissing',
  'model.max_context_size_missing': 'st.models.issue.contextMissing',
  'model.protocol_unresolved': 'st.models.issue.protocolUnresolved',
  'model.request_identity_invalid': 'st.models.issue.requestIdentityInvalid',
  'model.override_routing_rejected': 'st.models.issue.overrideRouting',
  'recipe-selected': 'st.models.issue.recipeSelected',
  'recipe-unavailable': 'st.models.issue.recipeUnavailable',
};

/**
 * One catalog row: star (global default), name + remote id, context, the
 * jobs it serves, capability words. The whole row opens the model's detail
 * in the page; nothing expands in place, so a 40-model list never reflows.
 */
function ModelRow({
  item,
  density,
  isDefault,
  roles,
  attention,
  busy,
  open,
  onSetDefault,
  onOpen,
}: {
  item: ModelCatalogItem;
  density: ListDensity;
  isDefault: boolean;
  /** The jobs this model is the default for, if any. */
  roles: readonly string[] | undefined;
  /** Its connection is not working. */
  attention: boolean;
  busy: boolean;
  /** Its detail is open. */
  open: boolean;
  onSetDefault: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const compact = density === 'compact';
  return (
    <div
      data-model-row={item.id}
      data-default={isDefault ? 'true' : undefined}
      data-open={open ? '' : undefined}
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      className={`flex h-full items-center gap-1 pr-2 pl-1 transition-colors ${open ? 'bg-paper shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]' : 'hover:bg-ink/[0.02]'}`}
    >
      <button
        type="button"
        onClick={onSetDefault}
        disabled={busy || isDefault}
        aria-label={t('st.models.starAria', { model: item.id })}
        title={isDefault ? t('st.models.starredTitle') : t('st.models.unstarredTitle')}
        aria-pressed={isDefault}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-11 ${
          isDefault ? 'text-ink' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'
        }`}
      >
        <Icon name={isDefault ? 'starFilled' : 'star'} size={14} />
      </button>
      <button
        type="button"
        aria-label={t('st.models.editAria', { model: item.id })}
        aria-expanded={open}
        data-detail-trigger={item.id}
        title={t('st.models.editTitle')}
        onClick={onOpen}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch rounded-md pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
      >
        <span className={`min-w-0 flex-1 ${compact ? 'flex items-baseline gap-2' : ''}`}>
          <span className={`flex min-w-0 items-center gap-2 ${compact ? 'shrink' : ''}`}>
            <span className="truncate text-[13px] font-medium text-ink">{item.display_name ?? item.id}</span>
            {isDefault ? (
              <span
                data-default-badge
                className="inline-flex shrink-0 items-center rounded bg-selected-ink/10 px-1.5 py-0.5 text-[11px] font-medium text-selected-ink"
              >
                {t('st.models.default')}
              </span>
            ) : null}
            {attention ? <span className="shrink-0 text-attention" title={t('st.models.providerAttention')}><Icon name="warning" size={12} /></span> : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
            <span className="truncate font-mono text-[11px]">{item.remote_id}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatTokens(item.max_context_size)}</span>
            {roles !== undefined && !compact ? (
              <span className="hidden min-w-0 truncate text-ink-soft sm:inline">· {t('st.models.inUseAs', { roles: roles.join('、') })}</span>
            ) : null}
          </span>
        </span>
        <span className="hidden sm:inline-flex"><CapabilityMarks capabilities={item.capabilities} /></span>
        <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
      </button>
    </div>
  );
}

/**
 * In-place editor for one catalog row. Opening the row reads the model entity
 * (`GET /models/{id}`), so the editor works from the stored record — its local
 * alias, its exact remote id, its revision and its issues — instead of
 * rebuilding anything from the list projection. Saving sends only the fields
 * the user changed together with the revision that read returned, so a
 * concurrent edit surfaces as a conflict instead of a silent overwrite.
 * Closing goes through the page's guarded navigation: an unsaved draft gets
 * the shared leave prompt, and only a confirmed leave drops it.
 */
function ModelCatalogRowEditor({
  item,
  inheritedImageTypes,
  isDefault = false,
  defaultBusy = false,
  roles,
  onSetDefault,
  onSaved,
  onClose,
  onRemoved,
}: {
  item: ModelCatalogItem;
  inheritedImageTypes: readonly string[] | undefined;
  isDefault?: boolean;
  defaultBusy?: boolean;
  roles?: readonly string[];
  onSetDefault?: () => void;
  onSaved: () => Promise<void>;
  onClose: () => void;
  /** The model is gone; close without asking about drafts it no longer has. */
  onRemoved?: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const entityQuery = useQuery({
    queryKey: ['model-entity', item.id],
    queryFn: () => client.getModel(item.id),
  });
  const entity = entityQuery.data;
  const [draft, setDraft] = useState<ProviderModelDraft | null>(null);
  const [baseline, setBaseline] = useState<ProviderModelDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [detailSaved, pingDetailSaved] = useSavedTick();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The compaction point rides beside the shared model draft: it is a token
  // count on the model entity, edited here and nowhere in the provider form.
  const [autoCompact, setAutoCompact] = useState<number | undefined>(undefined);
  const [autoCompactBaseline, setAutoCompactBaseline] = useState<number | undefined>(undefined);
  // Engine-only fields (aliases, sizes, JSON tables) ride beside it the same way.
  const [engine, setEngine] = useState<ModelEngineDraft | null>(null);
  const [engineBaseline, setEngineBaseline] = useState<ModelEngineDraft | null>(null);
  const [engineIssue, setEngineIssue] = useState<{ field: EngineField; text: string } | null>(null);
  // The identity difference layer rides beside them: shared values stay in the
  // editors above it, and only the differences live here.
  const [usage, setUsage] = useState<UsagePolicyDraft | null>(null);
  const [usageBaseline, setUsageBaseline] = useState<UsagePolicyDraft | null>(null);
  const [usageIssue, setUsageIssue] = useState<{ position: UsagePosition; field: UsagePolicyField } | null>(null);
  // Which agents the Prompts tab is writing for. Usage values carry their own
  // per-identity line under each row in Basics, so this scope is prompts-only.
  const [editScope, setEditScope] = useState<EditScope>('shared');
  // The prompt groups get their own draft rather than riding the engine draft,
  // because they are whole objects with a branch each: rebuilding them from the
  // entity on every render would drop an explicit `same` nobody touched.
  const [prompts, setPrompts] = useState<ModelPromptsDraft | null>(null);
  const [promptsBaseline, setPromptsBaseline] = useState<ModelPromptsDraft | null>(null);
  const promptsDirty = prompts !== null && promptsBaseline !== null && !modelPromptsEqual(prompts, promptsBaseline);

  useEffect(() => {
    if (entity === undefined || promptsDirty) return;
    const next = modelPromptsDraft(entity);
    if (promptsBaseline === null || !modelPromptsEqual(next, promptsBaseline)) {
      setPrompts(next);
      setPromptsBaseline(next);
    }
  }, [entity, promptsDirty, promptsBaseline]);

  /**
   * The per-source steer draft.
   *
   * It gets its own draft rather than folding into `prompts` for one reason:
   * a source keeps its private words while its mode is `off` or `inherit`, and a
   * draft rebuilt from the stored object on every render would drop them the
   * moment the row was not in `custom`. The draft therefore holds all nine
   * sources for all three levels and only compares against the baseline when
   * it is about to become a patch.
   */
  const [steerSources, setSteerSources] = useState<ModelSteerSourcesDraft | null>(null);
  const [steerSourcesBaseline, setSteerSourcesBaseline] = useState<ModelSteerSourcesDraft | null>(null);
  const [steerIssue, setSteerIssue] = useState<ModelSteeringSource | undefined>(undefined);
  const steerSourcesDirty = steerSources !== null && steerSourcesBaseline !== null && !steerSourcesEqual(steerSources, steerSourcesBaseline);
  const [activeEditorTab, setActiveEditorTab] = useState<EditorTab>('basics');

  useEffect(() => {
    if (entity === undefined || steerSourcesDirty) return;
    const next = modelSteerSourcesDraft(entity);
    if (steerSourcesBaseline === null || !steerSourcesEqual(next, steerSourcesBaseline)) {
      setSteerSources(next);
      setSteerSourcesBaseline(next);
    }
  }, [entity, steerSourcesDirty, steerSourcesBaseline]);

  /**
   * One source changed at the level on screen.
   *
   * The row owns the shape of its own change — it builds the next draft from
   * the one it is showing — so this only has to place it. Both intents arrive
   * here: choosing a mode never rewrites words, and typing words never changes
   * what the source currently does.
   */
  const setSteerSource = (source: ModelSteeringSource, next: SteerSourceDraft) => {
    if (steerSources === null) return;
    const scope = steerScopeFor(editScope);
    if (steerSources[scope][source] === undefined) return;
    setSteerSources({ ...steerSources, [scope]: { ...steerSources[scope], [source]: next } });
  };

  // Prompt prose for the scope on screen. Kept as text rather than written
  // straight into cognition: converting a file-backed slot into model-owned
  // text is a one-way move, so it waits for an explicit save.
  //
  // The draft is keyed by scope and slot together, because the same slot means
  // a different thing per identity: `shared` is the model's own declaration and
  // `main` is a difference that replaces the whole object for that identity.
  // Keying by slot alone carried one identity's words into another's on save.
  const [bodyDraft, setBodyDraft] = useState<Record<string, string>>({});
  const [bodySaves, setBodySaves] = useState<Record<string, string>>({});
  const bodyKey = (scope: EditScope, slot: CognitionSlot) => `${scope}:${slot}`;
  // A draft is only pending once it differs from what the stored value was; an
  // editor that opens on a body and is closed untouched must not dirty the page.
  const bodySavesDirty = Object.keys(bodySaves).length > 0;
  /**
   * The drafts for the scope on screen, keyed by slot alone again.
   *
   * Switching scope must show what that identity stores, not the words typed
   * into another one, so each scope's slots are projected out of the shared map.
   */
  const scopedBodyDraft: Record<string, string> = {};
  for (const [key, text] of Object.entries(bodyDraft)) {
    if (key.startsWith(`${editScope}:`)) scopedBodyDraft[key.slice(editScope.length + 1)] = text;
  }
  /** Identities whose prompts differ from the shared ones, for the "Applies to" marker. */
  const customizedScopes = new Set<EditScope>(prompts === null ? [] : PROMPT_POSITIONS.filter((position) =>
    prompts.cognition[position].kind === 'custom' || prompts.cognition[position].kind === 'off'
    || prompts.fields[position].kind === 'custom' || prompts.fields[position].kind === 'off'));
  // The shared scope of the parameter group writes the model's own generation
  // parameters, which live in `parameters` rather than on the entity root.
  const [sharedGeneration, setSharedGeneration] = useState<GenerationParametersWire>({});
  const [sharedGenerationBaseline, setSharedGenerationBaseline] = useState<GenerationParametersWire>({});
  // The question guard is a difference layer like the usage one above it: a
  // field this model does not hold stays inheriting, so a row that is opened
  // and saved without a decision writes no `behavior` at all.
  const [behavior, setBehavior] = useState<QuestionGuardDraft>(EMPTY_GUARD_DRAFT);
  const [behaviorBaseline, setBehaviorBaseline] = useState<QuestionGuardDraft>(EMPTY_GUARD_DRAFT);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const globalGuard = configQuery.data?.interaction?.askUserQuestionGuard;
  // The request format rides beside the shared draft the same way. Its draft
  // is the stored value only (`protocol`), never the resolved one: seeding it
  // from `effective_protocol` would turn "follows the provider" into a pinned
  // override the first time someone saved an unrelated field.
  const [protocol, setProtocol] = useState<ModelProtocolChoice>('inherit');
  const [protocolBaseline, setProtocolBaseline] = useState<ModelProtocolChoice>('inherit');
  const protocolDirty = protocol !== protocolBaseline;
  useEffect(() => {
    if (entity === undefined || protocolDirty) return;
    const next = protocolChoiceFrom(entity.protocol);
    setProtocol(next);
    setProtocolBaseline(next);
  }, [entity, protocolDirty]);
  // What the provider reported, for the Model ID picker. Read-only: picking
  // one only fills the draft, and any other ID can still be typed.
  const discoveredQuery = useQuery({ queryKey: ['discovered-models'], queryFn: () => client.listDiscoveredModels() });

  useEffect(() => {
    if (entity === undefined) return;
    if (draft !== null && baseline !== null && !providerModelDraftsEqual(draft, baseline)) return;
    const next = providerModelDraftFromCatalog(entity);
    if (draft !== null && providerModelDraftsEqual(draft, next)) return;
    setDraft(next);
    setBaseline(next);
  }, [entity, draft, baseline]);

  const compactDirty = autoCompact !== autoCompactBaseline;
  useEffect(() => {
    if (entity === undefined || compactDirty) return;
    setAutoCompact(entity.auto_compact);
    setAutoCompactBaseline(entity.auto_compact);
  }, [entity, compactDirty]);

  const engineDirty = engine !== null && engineBaseline !== null && !modelEngineDraftsEqual(engine, engineBaseline);
  useEffect(() => {
    if (entity === undefined || engineDirty) return;
    const next = modelEngineDraft(entity);
    setEngine(next);
    setEngineBaseline(next);
  }, [entity, engineDirty]);

  const usageDirty = usage !== null && usageBaseline !== null && !usagePolicyDraftsEqual(usage, usageBaseline);
  const sharedGenerationDirty = JSON.stringify(sharedGeneration) !== JSON.stringify(sharedGenerationBaseline);
  const behaviorDirty = !guardDraftsEqual(behavior, behaviorBaseline);
  useEffect(() => {
    if (entity === undefined || sharedGenerationDirty) return;
    const next = entity.parameters ?? {};
    setSharedGeneration(next);
    setSharedGenerationBaseline(next);
  }, [entity, sharedGenerationDirty]);
  useEffect(() => {
    // An unsaved difference must survive a re-read of the entity, so the
    // baseline only moves when the stored value actually differs from it.
    if (entity === undefined || behaviorDirty) return;
    const next = guardDraftFromModelBehavior(entity.behavior);
    if (!guardDraftsEqual(next, behaviorBaseline)) {
      setBehavior(next);
      setBehaviorBaseline(next);
    }
  }, [entity, behaviorDirty, behaviorBaseline]);
  useEffect(() => {
    // An unsaved difference must survive a re-read of the entity, so the
    // baseline only moves when the stored value actually differs from it.
    if (entity === undefined || usageDirty) return;
    const branches: Record<string, UsageBranchDraft> = {};
    for (const position of USAGE_POSITIONS) branches[position] = usageBranchDraft(entity, position);
    const next = branches as UsagePolicyDraft;
    if (usageBaseline !== null && usagePolicyDraftsEqual(next, usageBaseline)) return;
    setUsage(next);
    setUsageBaseline(next);
  }, [entity, usageDirty, usageBaseline]);

  // The compaction track measures the shared point. An identity's own point is
  // a plain token count on its line under the row, like its other values.
  const sharedContextBudget = engine !== null && /^\d+$/.test(engine.contextBudget.trim())
    ? Number(engine.contextBudget.trim()) : undefined;
  const compaction = useModelCompactionTrack({
    windowTokens: draft?.maxContextSize ?? 0,
    inputTokens: engine !== null && /^\d+$/.test(engine.maxInputSize.trim()) ? Number(engine.maxInputSize.trim()) : undefined,
    contextBudget: sharedContextBudget,
    overrides: engine?.overrides,
    autoCompact,
    loopControl: configQuery.data?.loop_control,
  });

  // A package being authored is a draft too: leaving the panel with words typed
  // and unsaved would lose them exactly as the model's own fields would.
  const [recipeDraftDirty, setRecipeDraftDirty] = useState(false);
  const modelDirty = (draft !== null && baseline !== null && !providerModelDraftsEqual(draft, baseline))
    || compactDirty || engineDirty || usageDirty || sharedGenerationDirty || behaviorDirty
    || promptsDirty || bodySavesDirty || steerSourcesDirty || protocolDirty;
  const dirty = modelDirty || recipeDraftDirty;
  useDirtyReporter(`catalog-model:${item.id}`, dirty);

  if (entityQuery.isError) return <InlineError error={entityQuery.error} />;
  if (entity === undefined || draft === null || baseline === null || engine === null || engineBaseline === null) {
    return <Hint>{t('st.models.loading')}</Hint>;
  }

  // Only the clamp warning changes what someone should type; the general
  // "empty uses the global default" sentence is what the placeholder says.
  const compactionHint = compaction.hint === t('st.compact.pointHint') ? undefined : compaction.hint;
  const compactionTrack = (
    <CompactPointTrack
      label={t('st.compact.trackLabel')}
      dataAttribute={`model:${entity.id}`}
      usable={compaction.usable}
      bounds={compaction.bounds}
      reserved={compaction.reserved}
      value={compaction.trackValue}
      title={compaction.trackTitle}
      reason={compaction.trackReason}
      pinned={compaction.overridden}
      onChange={(tokens) => { if (!saving) setAutoCompact(tokens); }}
    />
  );

  /**
   * Editing a shared row writes the model's own value. Each field goes to the
   * draft that already owns it, so one Save writes every layer and no value is
   * held in two places. `thinking_effort`, `service_tier` and
   * `max_completion_tokens` live in `parameters`, written as a sparse patch.
   */
  const applySharedUsageEdit = (edit: SharedUsageEdit) => {
    if (edit['auto_compact'] !== undefined) {
      setAutoCompact(edit['auto_compact'] === '' ? undefined : Number(edit['auto_compact']));
    }
    if (edit['context_budget'] !== undefined) {
      setEngine({ ...engine, contextBudget: edit['context_budget'] });
      setEngineIssue(null);
    }
    if (edit['thinking_effort'] !== undefined) {
      setSharedGeneration({ ...sharedGeneration, thinking_effort: edit['thinking_effort'] === '' ? undefined : edit['thinking_effort'] });
    }
    if (edit['service_tier'] !== undefined) {
      setSharedGeneration({ ...sharedGeneration, service_tier: edit['service_tier'] === '' ? undefined : edit['service_tier'] as never });
    }
    if (edit['max_completion_tokens'] !== undefined) {
      const text = edit['max_completion_tokens'];
      setSharedGeneration({ ...sharedGeneration, max_completion_tokens: text === '' ? undefined : Number(text) });
    }
    setUsageIssue(null);
  };

  const save = async (recipeReference?: string | null) => {
    const refuse = (text: string) => {
      setFeedback({ tone: 'error', text });
      if (recipeReference !== undefined) throw new Error(text);
    };
    if (draft.remoteId.trim() === '') {
      refuse(issueText(locale, { key: 'val.modelIdEmpty' }));
      return;
    }
    const imageIssue = validateImagePolicyDraft(draft, inheritedImageTypes);
    if (imageIssue !== null) {
      refuse(issueText(locale, imageIssue));
      return;
    }
    // The request-identity layer validates inside the patch body (and throws a
    // LocalizedError for bad JSON or an empty custom layer); it runs inside the
    // try so the event-entry `void save()` surfaces it as inline feedback
    // instead of an unhandled rejection, and no PATCH leaves the page.
    setSaving(true);
    setFeedback(null);
    try {
      const identityIssue = validateRequestIdentityLayerDraft(draft);
      if (identityIssue !== null) {
        refuse(issueText(locale, identityIssue));
        return;
      }
      let enginePatch;
      try {
        enginePatch = modelEnginePatch(engine, engineBaseline);
      } catch (error) {
        if (!(error instanceof ModelEngineFieldError)) throw error;
        const text = t(error.key === 'count' ? 'st.modelEngine.issueCount' : error.key === 'json' ? 'st.modelEngine.issueJson' : 'st.modelEngine.issueObject');
        setEngineIssue({ field: error.field, text });
        if (recipeReference !== undefined) throw new Error(text, { cause: error });
        return;
      }
      setEngineIssue(null);
      // The difference layer is validated before anything leaves the page, so a
      // half-typed token count cannot ride along with a valid PATCH.
      const usageProblem = usage === null
        ? undefined
        : USAGE_POSITIONS.map((position) => ({ position, field: usageBranchProblem(usage[position] ?? EMPTY_USAGE_BRANCH) }))
          .find((entry) => entry.field !== undefined);
      setUsageIssue(usageProblem?.field === undefined ? null : { position: usageProblem.position, field: usageProblem.field });
      if (usageProblem?.field !== undefined) {
        if (recipeReference !== undefined) throw new Error(t('st.usagePolicy.issueCount'));
        return;
      }
      const usagePatch = usage === null || usageBaseline === null ? {} : usagePolicyPatch(usage, usageBaseline);
      const generationPatch = generationParametersPatch(sharedGeneration, sharedGenerationBaseline);
      // A half-typed threshold must not ride along with an otherwise valid
      // PATCH, so the guard refuses the whole save the same way the row above
      // refuses a half-typed token count.
      const guardProblem = guardDraftProblem(behavior, (field) => rangeTextFor(t, field));
      if (guardProblem !== null) {
        if (recipeReference !== undefined) throw new Error(guardProblem.text);
        return;
      }
      const behaviorPatch = questionGuardModelPatch(behavior, behaviorBaseline);
      // A source's repeat count is checked before anything leaves the page, for
      // the same reason the usage row above refuses a half-typed token count: a
      // `NaN` that reached the model would be stored as this source's timing.
      const steerProblem = steerSources === null || steerSourcesBaseline === null
        ? undefined
        : STEER_SOURCES.find((source) => STEER_SCOPES.some((scope) => {
          const draft = steerSourceDraft(steerSources, scope, source);
          return draft.mode === 'custom' && steerCadenceProblem(draft.custom.cadence.intervalSteps) !== undefined;
        }));
      setSteerIssue(steerProblem);
      if (steerProblem !== undefined) {
        if (recipeReference !== undefined) throw new Error(t('st.steerSource.cadenceCount'));
        return;
      }
      const fieldPatch = modelPatchBody(draft, baseline);
      const protocolPatch = protocolPatchField(protocol, protocolBaseline);
      if (fieldPatch === null && !compactDirty && Object.keys(enginePatch).length === 0
        && Object.keys(usagePatch).length === 0 && generationPatch === null
        && behaviorPatch === undefined && !promptsDirty && !bodySavesDirty && !steerSourcesDirty
        && !protocolDirty && recipeReference === undefined) return;
      // A changed Advanced object is the complete target, including deletions
      // and null clears. Otherwise the stored object is the base. The prompt
      // editor contributes only fields changed against its own baseline.
      const promptBase = {
        ...entity,
        cognition: enginePatch.cognition === undefined ? entity.cognition : enginePatch.cognition ?? undefined,
        prompt_overrides: enginePatch.prompt_overrides === undefined ? entity.prompt_overrides : enginePatch.prompt_overrides ?? undefined,
      };
      const promptPatch = modelPromptsPatch(promptBase, prompts ?? modelPromptsDraft(entity), promptsBaseline ?? modelPromptsDraft(entity));
      // Prose has the final say on its explicit scope and slot, not on an entire
      // identity. Carry the accumulating object forward for multi-slot saves.
      let cognition = promptPatch.cognition ?? promptBase.cognition;
      for (const [key, text] of Object.entries(bodySaves)) {
        const separator = key.indexOf(':');
        const scope = key.slice(0, separator) as EditScope;
        const slot = key.slice(separator + 1) as CognitionSlot;
        cognition = cognitionSlotPatchAtScope({ ...entity, cognition }, scope, slot, text).cognition;
      }
      const patch = {
        ...fieldPatch,
        ...(compactDirty ? { auto_compact: autoCompact ?? null } : {}),
        ...enginePatch,
        ...usagePatch,
        ...promptPatch,
        ...(generationPatch === null ? {} : { parameters: generationPatch }),
        ...(behaviorPatch === undefined ? {} : { behavior: behaviorPatch }),
        ...protocolPatch,
      };
      if (bodySavesDirty) patch.cognition = cognition;
      if (recipeReference !== undefined) patch.recipe = recipeReference;
      // The source declarations travel in the same transaction and under the
      // same revision, as their own field rather than folded into `cognition`:
      // the server merges a source entry field by field, so a whole-object
      // cognition write would either drop the change or be dropped by it.
      const steerPatch = steerSources === null || steerSourcesBaseline === null
        ? undefined
        : steerSourcesPatch(steerSources, steerSourcesBaseline);
      if (steerPatch !== undefined) patch.steering_sources_patch = steerPatch;
      const saved = await client.updateModel(entity.id, { ...patch, base_revision: entity.revision });
      // Drafts and baselines advance together to the accepted entity before a
      // refresh can replace them. Never restore pre-save closure values after
      // the fresh entity has already reached the clean-draft effects.
      const savedDraft = providerModelDraftFromCatalog(saved);
      const savedEngine = modelEngineDraft(saved);
      const savedPrompts = modelPromptsDraft(saved);
      const savedUsage = Object.fromEntries(USAGE_POSITIONS.map((position) => [position, usageBranchDraft(saved, position)])) as UsagePolicyDraft;
      const savedGeneration = saved.parameters ?? {};
      const savedBehavior = guardDraftFromModelBehavior(saved.behavior);
      setDraft(savedDraft);
      setBaseline(savedDraft);
      setAutoCompact(saved.auto_compact);
      setAutoCompactBaseline(saved.auto_compact);
      setEngine(savedEngine);
      setEngineBaseline(savedEngine);
      setPrompts(savedPrompts);
      setPromptsBaseline(savedPrompts);
      setUsage(savedUsage);
      setUsageBaseline(savedUsage);
      setSharedGeneration(savedGeneration);
      setSharedGenerationBaseline(savedGeneration);
      setBehavior(savedBehavior);
      setBehaviorBaseline(savedBehavior);
      setBodyDraft({});
      setBodySaves({});
      const savedSteerSources = modelSteerSourcesDraft(saved);
      setSteerSources(savedSteerSources);
      setSteerSourcesBaseline(savedSteerSources);
      setSteerIssue(undefined);
      const savedProtocol = protocolChoiceFrom(saved.protocol);
      setProtocol(savedProtocol);
      setProtocolBaseline(savedProtocol);
      queryClient.setQueryData(['model-entity', item.id], saved);
      await onSaved();
      await entityQuery.refetch();
      pingDetailSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      if (recipeReference !== undefined) throw error;
    } finally {
      setSaving(false);
    }
  };

  /**
   * Removing deletes the stored model under the revision this editor read, so
   * a concurrent edit is refused instead of silently discarded. A failure
   * keeps the panel open with every draft and the server's reason.
   */
  const remove = async () => {
    setRemoving(true);
    setFeedback(null);
    try {
      await client.deleteModel(entity.id, { baseRevision: entity.revision });
      setConfirmRemove(false);
      queryClient.removeQueries({ queryKey: ['model-entity', item.id] });
      await onSaved();
      onRemoved?.();
    } catch (error) {
      setConfirmRemove(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRemoving(false);
    }
  };

  /**
   * Discard puts every draft back on its baseline at once. It is the same
   * "nothing pending" state a fresh open would show, so nothing half-reset can
   * ride along with the next save. A package being authored in the Recipe
   * section keeps its own cancel and is not touched here.
   */
  const discard = () => {
    setDraft(baseline);
    setAutoCompact(autoCompactBaseline);
    setEngine(engineBaseline);
    setEngineIssue(null);
    if (usageBaseline !== null) setUsage(usageBaseline);
    setUsageIssue(null);
    if (promptsBaseline !== null) setPrompts(promptsBaseline);
    setBodyDraft({});
    setBodySaves({});
    if (steerSourcesBaseline !== null) setSteerSources(steerSourcesBaseline);
    setSteerIssue(undefined);
    setSharedGeneration(sharedGenerationBaseline);
    setBehavior(behaviorBaseline);
    setProtocol(protocolBaseline);
    setFeedback(null);
  };

  // The IDs this provider reported, plus whatever the draft holds now so the
  // trigger always reads the value that will be saved.
  const reportedModels = (discoveredQuery.data?.items ?? [])
    .filter((group) => group.provider_id === entity.provider_id)
    .flatMap((group) => group.models);
  const remoteIdOptions = [
    ...(draft.remoteId.trim() === '' || reportedModels.some((model) => model.remote_id === draft.remoteId)
      ? []
      : [{ value: draft.remoteId, label: draft.remoteId }]),
    ...reportedModels.map((model) => ({
      value: model.remote_id,
      label: model.remote_id,
      description: model.display_name,
      keywords: model.display_name,
    })),
  ];
  // While the stored value inherits, the server's resolved format is the
  // provider's, and the inherit option can name it.
  const resolvedProtocol: ModelProtocol | undefined = protocolBaseline === 'inherit' ? entity.effective_protocol : undefined;

  const sectionId = (section: EditorSectionName) => `model-editor-${section}-${entity.id}`;

  // Known server issues get their own copy and lose the field path, which is
  // a config key rather than something a person reads. The Recipe notice is
  // stated in the Recipe tab, so it is not repeated as a page-wide banner.
  const recipeSelected = entity.issues.some((issue) => issue.code === 'recipe-selected');
  const bannerIssues = entity.issues.filter((issue) => issue.code !== 'recipe-selected');
  const efforts = sortThinkingEffortsForDisplay([...draft.supportEfforts]);
  const tabs: readonly { id: EditorTab; label: string; badge?: string }[] = [
    { id: 'basics', label: t('st.modelEditor.tab.basics') },
    { id: 'prompts', label: t('st.modelEditor.tab.prompts') },
    { id: 'recipe', label: t('st.modelEditor.tab.recipe'), badge: entity.recipe === undefined ? undefined : t('st.modelEditor.recipeOn') },
    { id: 'advanced', label: t('st.modelEditor.tab.advanced') },
  ];
  const tabId = (tab: EditorTab) => `model-editor-tab-${tab}-${entity.id}`;
  const panelId = (tab: EditorTab) => `model-editor-panel-${tab}-${entity.id}`;
  const focusTab = (tab: EditorTab) => {
    setActiveEditorTab(tab);
    document.getElementById(tabId(tab))?.focus();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6" data-model-editor-layout>
      <div className="sticky top-[calc(-1*var(--settings-scroll-pt,0px))] z-10 border-b border-hairline bg-canvas pt-1">
        <div role="tablist" aria-label={t('st.modelEditor.navAria')} className="-mb-px flex items-end gap-4 overflow-x-auto"
          onKeyDown={(event) => {
            const index = tabs.findIndex((tab) => tab.id === activeEditorTab);
            if (event.key === 'ArrowRight') { event.preventDefault(); focusTab(tabs[(index + 1) % tabs.length]!.id); }
            if (event.key === 'ArrowLeft') { event.preventDefault(); focusTab(tabs[(index - 1 + tabs.length) % tabs.length]!.id); }
            if (event.key === 'Home') { event.preventDefault(); focusTab(tabs[0]!.id); }
            if (event.key === 'End') { event.preventDefault(); focusTab(tabs[tabs.length - 1]!.id); }
          }}>
          {tabs.map((tab) => {
            const selected = activeEditorTab === tab.id;
            return (
              <button
                key={tab.id}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId(tab.id)}
                tabIndex={selected ? 0 : -1}
                data-model-editor-tab={tab.id}
                onClick={() => { setActiveEditorTab(tab.id); }}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-[13px] outline-none transition-colors focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${
                  selected ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                }`}
              >
                {tab.label}
                {tab.badge === undefined ? null : (
                  <span data-model-editor-tab-badge={tab.id}
                    className="rounded bg-selected-ink/10 px-1.5 py-px text-[10.5px] font-medium text-selected-ink">{tab.badge}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {bannerIssues.length > 0 ? (
        <ul role="status" data-model-issues className="space-y-0.5 rounded-md bg-amber-card px-3 py-2 text-[12px] leading-5 text-amber-ink">
          {bannerIssues.map((issue, index) => {
            const key = MODEL_ISSUE_KEYS[issue.code];
            const text = key === undefined
              ? `${issue.path}: ${issue.message}`
              : issue.code === 'model.override_routing_rejected'
                ? t(key, { fields: issue.message })
                : t(key);
            return <li key={`${issue.code}-${index}`} data-model-issue={issue.code}>{text}</li>;
          })}
        </ul>
      ) : null}
      <div id={panelId('basics')} role="tabpanel" aria-labelledby={tabId('basics')} hidden={activeEditorTab !== 'basics'} className="space-y-8">
        <EditorSection id={sectionId('basics')} title={t('st.modelEditor.section.model')}
          aside={(
            <div data-model-default-control={item.id} data-is-default={isDefault ? 'true' : 'false'} className="flex items-center">
              {isDefault ? (
                <span data-default-badge className="inline-flex items-center gap-1 rounded bg-selected-ink/10 px-1.5 py-0.5 text-[11.5px] font-medium text-selected-ink">
                  <Icon name="starFilled" size={12} />
                  {t('st.models.currentDefault')}
                </span>
              ) : onSetDefault !== undefined ? (
                <button type="button" data-set-default-button disabled={defaultBusy} onClick={onSetDefault}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint pointer-coarse:h-9">
                  <Icon name="star" size={12} />
                  {t('st.models.unstarredTitle')}
                </button>
              ) : null}
            </div>
          )}>
          <div className="grid gap-3 sm:grid-cols-2">
            {/*
              The ID the provider is asked for: searchable over what the provider
              reported and open to any other value. The local alias never changes here.
            */}
            <div className="min-w-0 space-y-1" data-model-remote-id={entity.id}>
              <p className={FORM_LABEL}>{t('st.models.remoteIdLabel')}</p>
              <SearchableSelect
                options={remoteIdOptions}
                value={draft.remoteId}
                onChange={(remoteId) => { setDraft({ ...draft, remoteId }); }}
                ariaLabel={t('st.models.remoteIdAria', { model: entity.id })}
                allowCustomValue
                customValueLabel={(id) => t('st.providers.useCustomModel', { id })}
                searchPlaceholder={t('st.providers.modelSearchPlaceholder')}
                emptyText={t('st.providers.catalogEmpty')}
                disabled={saving}
                buttonClassName={`${INPUT} flex items-center justify-between gap-2 text-left font-mono`}
              />
              <input
                type="text"
                className="sr-only"
                aria-label={t('st.models.remoteIdAria', { model: entity.id })}
                value={draft.remoteId}
                onChange={(event) => { setDraft({ ...draft, remoteId: event.target.value }); }}
              />
            </div>
            <label className={`${FORM_LABEL} min-w-0`}>
              {t('st.models.displayNameLabel')}
              <input
                className={`${INPUT} mt-1 font-normal`}
                aria-label={t('st.models.displayNameAria', { model: entity.id })}
                value={draft.displayName}
                onChange={(event) => { setDraft({ ...draft, displayName: event.target.value }); }}
                placeholder={entity.remote_id}
              />
            </label>
            <div className="min-w-0 space-y-1">
              <p className={FORM_LABEL}>{t('st.modelEditor.provider')}</p>
              <p className="flex h-8 min-w-0 items-center rounded-md bg-ink/[0.03] px-3 font-mono text-[12.5px] text-ink-soft" title={entity.provider_id}>
                <span className="truncate">{entity.provider_id}</span>
              </p>
            </div>
            <ModelProtocolField
              model={entity.id}
              value={protocol}
              resolved={resolvedProtocol}
              source={protocolBaseline === 'inherit' ? entity.protocol_source : undefined}
              endpointSource={entity.endpoint_source}
              authSource={entity.auth_source}
              endpointEnv={entity.endpoint_env}
              authEnv={entity.auth_env}
              onChange={setProtocol}
              disabled={saving}
            />
          </div>
        </EditorSection>
        <EditorSection id={sectionId('usage')} title={t('st.modelEditor.section.usage')}>
          {usage !== null ? (
            <MainUsagePolicyFields
              modelId={entity.id}
              view={usagePolicyView(entity, usage, usageDirty, usageIssue, autoCompact, engine, sharedGeneration)}
              efforts={efforts}
              onSharedChange={applySharedUsageEdit}
              onChange={(next) => { setUsage(next); setUsageIssue(null); }}
              sharedIssue={engineIssue?.field === 'contextBudget' ? { field: 'context_budget', text: engineIssue.text } : null}
              compactionTrack={compactionTrack}
              compactionControl={(
                <CompactPointField
                  dataAttribute={`model:${entity.id}`}
                  labelClassName="sr-only"
                  label={t('st.compact.pointLabel')}
                  value={autoCompact}
                  onChange={setAutoCompact}
                  disabled={saving}
                  windowTokens={compaction.usable}
                  placeholder={compaction.inheritedLabel}
                  presets={compaction.presets}
                  presetsLabel={compaction.presetsLabel}
                  hint={compactionHint}
                />
              )}
              disabled={saving}
            />
          ) : null}
        </EditorSection>
        <EditorSection id={sectionId('capabilities')} title={t('st.modelEditor.section.capabilities')}>
          <ModelContextFields
            modelId={entity.id}
            windowTokens={draft.maxContextSize}
            inputTokens={/^\d+$/.test(engine.maxInputSize.trim()) ? Number(engine.maxInputSize.trim()) : undefined}
            contextBudget={/^\d+$/.test(engine.contextBudget.trim()) ? Number(engine.contextBudget.trim()) : undefined}
            overrides={engine.overrides}
            onWindowChange={(maxContextSize) => { setDraft({ ...draft, maxContextSize }); }}
            autoCompact={autoCompact}
            onAutoCompactChange={setAutoCompact}
            loopControl={configQuery.data?.loop_control}
            hideCompaction
          />
          <div className="space-y-1.5">
            <p className={FORM_LABEL}>{t('st.chips.efforts')}</p>
            <ChipSelect
              values={draft.supportEfforts}
              knownOptions={KNOWN_EFFORTS}
              onChange={(supportEfforts) => { setDraft({ ...draft, supportEfforts: sortEfforts(supportEfforts) }); }}
              ariaLabel={t('st.models.effortsAria', { model: entity.id })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
          <div className="space-y-1.5" data-model-capabilities={entity.id}>
            <p className={FORM_LABEL}>{t('st.chips.capabilities')}</p>
            <ChipSelect
              values={draft.capabilities}
              knownOptions={KNOWN_CAPABILITIES}
              onChange={(capabilities) => { setDraft({ ...draft, capabilities }); }}
              ariaLabel={t('st.models.capsAria', { model: entity.id })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
        </EditorSection>
      </div>
      <div id={panelId('prompts')} role="tabpanel" aria-labelledby={tabId('prompts')} hidden={activeEditorTab !== 'prompts'} className="space-y-6">
        <ModelEditScopeSwitch scope={editScope} customized={customizedScopes} onScopeChange={setEditScope} />
        {recipeSelected ? (
          <p className="text-[12px] text-selected-ink" data-prompts-recipe-note>{t('st.models.issue.recipeSelected')}</p>
        ) : null}
        <ModelPromptBodies
          modelId={entity.id}
          bodies={entity.cognition_bodies}
          scope={editScope}
          branchSelection={branchSelectionFor(editScope, prompts)}
          draft={scopedBodyDraft}
          // Typing is the decision: a slot backed by an author file converts to
          // a body on the model when this page saves, like any other field.
          onDraftChange={(slot, text) => {
            const key = bodyKey(editScope, slot);
            setBodyDraft((current) => ({ ...current, [key]: text }));
            setBodySaves((current) => {
              const next = { ...current };
              if (text === initialSlotText(slotView(entity.cognition_bodies, editScope, slot))) delete next[key];
              else next[key] = text;
              return next;
            });
          }}
          disabled={saving}
        />
        <div className="space-y-1">
          {/*
            The sources that can start a turn without a person typing. Most are
            simply off, so they stay folded; the body stays mounted so an edit
            survives collapsing it.
          */}
          <AdvancedDisclosure id={`model-steer-${entity.id}`} label={t('st.steerSource.disclosure')} summary={t('st.steerSource.summary')}>
            <div className="space-y-3">
              <ModelSteerSources
                bodies={entity.cognition_bodies}
                scope={editScope}
                draft={steerSources}
                branchOff={branchSelectionFor(editScope, prompts) === 'off'}
                identityInheritsShared={editScope !== 'shared' && branchSelectionFor(editScope, prompts) === 'common'}
                onDraftChange={setSteerSource}
                disabled={saving}
              />
              {steerIssue !== undefined ? (
                <p role="alert" className="text-[12px] leading-5 text-danger" data-steer-source-issue>
                  {t('st.steerSource.cadenceCount')}
                </p>
              ) : null}
            </div>
          </AdvancedDisclosure>
          <AdvancedDisclosure id={`model-prompt-structure-${entity.id}`} label={t('st.modelEditor.group.promptStructure')}
            defaultOpen={engineIssue?.field === 'cognition' || engineIssue?.field === 'promptOverrides'}>
            <ModelEngineFields part="prompts" modelId={entity.id} value={engine} issue={engineIssue} disabled={saving}
              onChange={(next) => { setEngine(next); setEngineIssue(null); }} />
          </AdvancedDisclosure>
        </div>
      </div>
      <div id={panelId('recipe')} role="tabpanel" aria-labelledby={tabId('recipe')} hidden={activeEditorTab !== 'recipe'} className="space-y-4">
        {recipeSelected ? (
          <p className="rounded-md bg-selected-ink/[0.07] px-3 py-2 text-[12px] leading-5 text-selected-ink" data-model-recipe-issue>
            {t('st.models.issue.recipeSelected')}
          </p>
        ) : null}
        <ModelRecipeField
          modelId={entity.id}
          modelName={draft.displayName.trim() === '' ? entity.id : draft.displayName.trim()}
          onCommitRecipe={save}
          appliedId={entity.recipe}
          disabled={saving}
          onDraftChange={setRecipeDraftDirty}
        />
      </div>
      <div id={panelId('advanced')} role="tabpanel" aria-labelledby={tabId('advanced')} hidden={activeEditorTab !== 'advanced'}
        className="space-y-1" data-model-advanced-groups>
        {/*
          Named groups, each folded. A group opens on its own when the last
          save was refused for a field inside it, so the error is never hidden.
        */}
        <AdvancedDisclosure id={`model-${entity.id}`} label={t('st.modelEditor.group.requestIdentity')}
          defaultOpen={draft.requestIdentityChoice !== 'inherit'}>
          <RequestIdentityLayerEditor
            value={draft}
            onChange={(identity) => { setDraft({ ...draft, ...identity }); }}
            label={t('st.models.requestIdentity')}
            inheritLabel={t('st.requestIdentity.inheritProvider')}
          />
        </AdvancedDisclosure>
        <AdvancedDisclosure id={`model-images-${entity.id}`} label={t('st.modelEditor.group.images')}>
          <ImagePolicyEditor
            value={draft}
            onChange={(images) => { setDraft({ ...draft, ...images }); }}
            inheritLabel={t('st.images.inheritProvider')}
          />
        </AdvancedDisclosure>
        <AdvancedDisclosure id={`model-sampling-${entity.id}`} label={t('st.modelEditor.group.sampling')}>
          {/*
            Effort, tier and the token cap have their one entrance in Basics;
            only temperature and top_p remain here.
          */}
          <SavedGenerationParametersEditor scope="model" id={entity.id} onSaved={onSaved} keys={['temperature', 'top_p']} />
        </AdvancedDisclosure>
        <AdvancedDisclosure id={`model-engine-${entity.id}`} label={t('st.modelEditor.group.engine')}
          defaultOpen={engineIssue !== null && engineIssue.field !== 'contextBudget'
            && engineIssue.field !== 'cognition' && engineIssue.field !== 'promptOverrides'}>
          <ModelEngineFields modelId={entity.id} value={engine} issue={engineIssue} disabled={saving}
            onChange={(next) => { setEngine(next); setEngineIssue(null); }} />
        </AdvancedDisclosure>
        <AdvancedDisclosure id={`model-guard-${entity.id}`} label={t('st.modelEditor.group.questionGuard')}>
          <div data-model-behavior={entity.id}>
            <QuestionGuardFields
              scope="model"
              draft={behavior}
              enabled={guardEffective(globalGuard, behavior).enabled}
              disabled={saving}
              inherited={(field) => guardInherited(field, globalGuard, behavior)}
              onEnabledChange={(choice) => { setBehavior({ ...behavior, enabled: choice }); }}
              onNumberCommit={(field: GuardNumberField, text) => { setBehavior(setGuardNumber(behavior, field, text)); }}
              onNumberClear={(field) => { setBehavior(clearGuardNumber(behavior, field)); }}
            />
          </div>
        </AdvancedDisclosure>
      </div>
      {/*
        The actions stay pinned to the bottom of the detail: on a form this long
        the save button used to be a scroll away from the field just edited.
        A failed or conflicting save keeps every draft, and the error sits
        right beside the button that produced it.
      */}
      <div
        className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] z-10 mt-auto flex flex-wrap items-center gap-2 border-t border-hairline bg-canvas/95 py-3 backdrop-blur-sm"
        data-model-editor-actions
      >
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || !modelDirty} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving || !modelDirty} onClick={discard} data-model-editor-discard>
          {t('st.advanced.discard')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onClose}>
          {t('common.close')}
        </button>
        {dirty ? (
          <span role="status" className="text-[12px] text-ink-faint">{t('st.draft.unsaved')}</span>
        ) : <SavedTick show={detailSaved} />}
        {onRemoved !== undefined ? (
          <button type="button" className={`${DANGER_GHOST_BUTTON} ml-auto`} data-model-remove={entity.id}
            disabled={saving || removing} onClick={() => { setConfirmRemove(true); }}>
            {t('st.providerModels.remove')}
          </button>
        ) : null}
        <div className="basis-full empty:hidden"><FeedbackLine feedback={feedback} /></div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        stacked
        overlayId={`catalog-model-remove:${entity.id}`}
        title={t('st.providerModels.removeTitle', { model: entity.display_name ?? entity.id })}
        body={t('st.providerModels.removeBody')}
        consequences={[
          ...(roles !== undefined && roles.length > 0
            ? [t('st.providerModels.removeDefault', { model: entity.id, roles: roles.join(locale === 'zh' ? '、' : ', ') })]
            : []),
          t('st.providerModels.removeSessions'),
        ]}
        confirmLabel={t('st.providerModels.remove')}
        busy={removing}
        onConfirm={() => void remove()}
        onCancel={() => { setConfirmRemove(false); }}
      />
    </div>
  );
}

type EditorTab = 'basics' | 'prompts' | 'recipe' | 'advanced';
type EditorSectionName = 'basics' | 'usage' | 'capabilities';

/** One named group inside a tab: a quiet heading, an optional action at its end. */
function EditorSection({ id, title, aside, children }: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="min-w-0 space-y-4" data-model-editor-section={id}>
      <header className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-[13px] font-semibold text-ink">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** A stored identity value, or undefined when it inherits. */
function identityUsageNumber(value: string | undefined): number | undefined {
  return value === undefined || value === '' || !/^\d+$/.test(value.trim())
    ? undefined
    : Number(value.trim());
}

/** The lower of two optional token counts: the engine's own budget rule. */
function minOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * The shared generation parameters, as a sparse patch: only the keys that
 * changed, with `null` for a key the person emptied. Sending the whole object
 * would otherwise rewrite values this editor does not even show.
 */
function generationParametersPatch(
  draft: GenerationParametersWire,
  baseline: GenerationParametersWire,
): GenerationParametersPatch | null {
  const patch: Record<string, unknown> = {};
  for (const key of ['thinking_effort', 'service_tier', 'max_completion_tokens'] as const) {
    if (JSON.stringify(draft[key]) === JSON.stringify(baseline[key])) continue;
    patch[key] = draft[key] ?? null;
  }
  return Object.keys(patch).length === 0 ? null : patch as GenerationParametersPatch;
}

/**
 * What the shared layer holds right now, and what each identity really gets.
 *
 * The shared side is read from the same effective projection the
 * request-parameter editor shows, so the two never disagree about what
 * "shared" means. The two draft-carried numbers are passed in rather than read
 * back from the entity: while the editor is dirty the draft is the value the
 * user is looking at, and a difference reviewed against a stale shared value
 * would be reviewed against the wrong baseline.
 *
 * The resolved side comes from `usage_effective` / `usage_sources`, which the
 * server computes per position. When the server does not report one, the row
 * falls back to the position's own draft value, and simply shows no origin
 * rather than inventing one.
 */
function usagePolicyView(
  entity: ModelEntity,
  draft: UsagePolicyDraft,
  dirty: boolean,
  issue: { position: UsagePosition; field: UsagePolicyField } | null,
  autoCompact: number | undefined,
  engine: ModelEngineDraft,
  sharedGeneration: GenerationParametersWire,
): UsagePolicyView {
  const count = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined);
  // The shared layer reads the drafts, not the stored entity: an edit made in
  // the shared scope has to show up immediately, or the row would report the
  // value the person just replaced.
  const sharedText: Record<UsagePolicyField, string> = {
    thinking_effort: sharedGeneration.thinking_effort ?? '',
    service_tier: sharedGeneration.service_tier === undefined
      ? (typeof entity.service_tier === 'string' ? entity.service_tier : '')
      : (typeof sharedGeneration.service_tier === 'string' ? sharedGeneration.service_tier : ''),
    auto_compact: String(autoCompact ?? entity.auto_compact ?? ''),
    context_budget: count(engine.contextBudget) === undefined ? '' : String(count(engine.contextBudget)),
    max_completion_tokens: sharedGeneration.max_completion_tokens === undefined
      ? ''
      : String(sharedGeneration.max_completion_tokens),
  };
  const resolved: Record<string, UsagePolicyView['resolved'][UsagePosition]> = {};
  for (const position of USAGE_POSITIONS) {
    const table = usageEffectiveFor(entity, position) ?? {};
    resolved[position] = Object.fromEntries(USAGE_POLICY_FIELDS.map((field) => {
      const raw = table[field];
      const value = raw === undefined || typeof raw === 'object' ? '' : String(raw);
      return [field, { value, source: usageSourceFor(entity, position, field) }];
    }));
  }
  return { draft, shared: sharedText, resolved: resolved as UsagePolicyView['resolved'], issue, dirty };
}

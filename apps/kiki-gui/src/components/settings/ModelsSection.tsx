import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  GenerationParametersPatch,
  GenerationParametersWire,
  ModelCatalogItem,
  ModelEntity,
  ModelGenerationMigrationPreviewResponse,
} from '@kiki/protocol';

import { errorText, issueText, type I18nKey } from '@kiki/session-core/i18n';
import {
  DEFAULT_MODEL_CAPABILITIES,
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
import { useDirtyReporter, useGuardedNavigate } from '../dirtyGuard';
import {
  AdvancedDisclosure,
  CapabilityMarks,
  ContextStepper,
  ImagePolicyEditor,
  SavedGenerationParametersEditor,
} from '../ProviderFields';
import { OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { GlobalCompactionCard, ModelContextFields, CompactPointTrack, useModelCompactionTrack } from './ContextWindowSettings';
import { CompactPointField } from './CompactPointField';
import { vendorLabelFor } from '../providerPresets';
import { RequestIdentityLayerEditor } from '../RequestIdentityLayerEditor';
import { REQUEST_IDENTITY_QUERY_KEY, useCustomIdentityChoices } from './identityCatalog';
import { SearchableSelect } from '../SearchableSelect';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { FORM_LABEL, SettingsDraftFooter, SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { effortLabel } from './profileEditor/profileDraft';
import { SettingField } from './fields';
import { useInstantSave } from './useInstantSave';
import { LoopLimitsCard } from './LoopLimitsCard';
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
import { ModelRecipeField } from './ModelRecipeField';
import { ModelPromptBodies } from './ModelPromptBodies';
import { branchSelectionFor, modelPromptsDraft, modelPromptsEqual, modelPromptsPatch, type ModelPromptsDraft } from './modelPromptsDraft';
import { scopeDifferenceSummary, type EditScope } from './modelEditScope';
import { cognitionSlotPatchAtScope, initialSlotText, slotView, type CognitionSlot } from './modelCognitionBodies';
import {
  EMPTY_USAGE_BRANCH,
  USAGE_POLICY_FIELDS,
  USAGE_POSITIONS,
  usageBranchDraft,
  countUsageDifferences,
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
import { isInSubspace } from '../../lib/spaces';
import { OriginBadge } from './spaces/OriginBadge';
import { SidePanel } from '../SidePanel';
import {
  LIST_ROW_HEIGHT,
  ListBody,
  ListEmpty,
  ListGroup,
  ListToolbar,
  groupItems,
  useListView,
  type ListDensity,
  type ListFilterSpec,
  type ListSortSpec,
} from './list';

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
 * Tab 2 of the merged entry (redesign §3.3): the cross-provider model
 * catalog — search everything, grouped by provider, metadata per row. The
 * star picks the GLOBAL default model (and carries its provider along); the
 * per-provider default is a separate concept, shown as a group-header chip
 * and edited inside the provider editor on the Connections tab. A row also
 * expands into an in-place parameter editor: model parameters are editable
 * from BOTH this detail surface and the provider editor, through the same
 * validation and save channel.
 */
export function ModelCatalogCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const [editing, setEditing] = useState<string | null>(null);
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
    enabled: typeof client.listOAuthMethods === 'function',
  });
  const items = modelsQuery.data?.items ?? [];
  const providers = useMemo(
    () => new Map((providersQuery.data?.items ?? []).map((provider) => [provider.id, provider])),
    [providersQuery.data],
  );
  const defaultModel = configQuery.data?.default_model;
  const defaultProvider = configQuery.data?.default_provider ?? '';

  // Row edits write one model entity each; every dependent read refreshes.
  const refreshCatalog = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['generation-entity'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]);
  }, [queryClient]);

  // Which defaults point at each model, and what they serve it. This marks a
  // row in place; it is not a group or a filter, so a model in use is found
  // where it already lives rather than in a second list of the same rows.
  const config = configQuery.data;
  const roles = useMemo(() => {
    const out = new Map<string, string[]>();
    const add = (id: string | undefined, label: string) => {
      if (id === undefined || id === '') return;
      out.set(id, [...(out.get(id) ?? []), label]);
    };
    add(defaultModel, t('st.defaults.row.newSession'));
    add(config?.session_title?.model, t('st.defaults.row.title'));
    add(config?.fast_model, t('st.defaults.row.fast'));
    add(config?.subagent?.defaultModel, t('st.defaults.row.subagent'));
    return out;
  }, [defaultModel, config, t]);
  const attention = useCallback((item: ModelCatalogItem) => {
    // No connection, or one that is not working: either way the model cannot run.
    const status = providers.get(item.provider_id)?.status;
    return status !== 'connected';
  }, [providers]);
  const accountLabels = useMemo(
    () => new Map((methodsQuery.data ?? []).map((method) => [method.provider, method.label])),
    [methodsQuery.data],
  );
  const groupLabel = useCallback((providerId: string) => providerId === '' ? t('st.models.group.noProvider') :
    accountLabels.get(providerId) ?? vendorLabelFor(providers.get(providerId)?.base_url) ?? providerId,
  [accountLabels, providers, t]);

  // No "In use" filter: a model that some role points at is already marked on
  // its own row, and a category of them repeated the list under a second name.
  const filters = useMemo<ListFilterSpec<ModelCatalogItem>[]>(() => [
    { id: 'attention', label: t('st.models.filter.attention'), test: attention, tone: 'attention' },
    { id: 'reasoning', label: t('st.models.filter.reasoning'), test: (item) => hasCapability(item, 'thinking') },
    { id: 'vision', label: t('st.models.filter.vision'), test: (item) => hasCapability(item, 'image_in') },
  ], [t, attention]);
  const sorts = useMemo<ListSortSpec<ModelCatalogItem>[]>(() => [
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id) },
  ], [t]);
  const keyOf = useCallback((item: ModelCatalogItem) => item.id, []);
  const textOf = useCallback((item: ModelCatalogItem) => [
    item.id, item.remote_id, item.display_name, item.provider_id, groupLabel(item.provider_id), ...(item.capabilities ?? []),
  ], [groupLabel]);
  const view = useListView({ listId: 'models', items, keyOf, textOf, filters, sorts });

  // Group order: the default provider, then providers by name. The list is
  // already one flat set of rows, so it is grouped by provider only.
  const groups = useMemo(() => {
    const providerIds = [...new Set(items.map((item) => item.provider_id))]
      .toSorted((a, b) => Number(b === defaultProvider) - Number(a === defaultProvider) || groupLabel(a).localeCompare(groupLabel(b)));
    return groupItems(
      items,
      view.visible,
      (item) => [{ key: `provider:${item.provider_id}`, label: groupLabel(item.provider_id) }],
      providerIds.map((id) => `provider:${id}`),
    ).filter((group) => group.items.length > 0);
  }, [items, view.visible, defaultProvider, groupLabel]);

  // Starring a model carries its provider along as the global default provider.
  const selectDefaultModel = async (item: ModelCatalogItem) => {
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.setDefaultModel(item.id);
      queryClient.setQueryData(['config'], (current: Record<string, unknown> | undefined) => ({
        ...current,
        default_model: echoed.default_model,
      }));
      writeSettings({ defaultModel: echoed.default_model });
      if (item.provider_id !== defaultProvider) {
        const echoedConfig = await client.patchConfig({ default_provider: item.provider_id });
        queryClient.setQueryData(['config'], echoedConfig);
      }
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  const catalogEmpty = !modelsQuery.isLoading && !modelsQuery.isError && items.length === 0;
  const defaultItem = items.find((item) => item.id === defaultModel);
  const editingItem = items.find((item) => item.id === editing);

  const renderRow = (item: ModelCatalogItem) => (
    <ModelRow
      item={item}
      density={view.density}
      isDefault={item.id === defaultModel}
      roles={roles.get(item.id)}
      attention={attention(item)}
      busy={busy}
      open={item.id === editing}
      onSetDefault={() => void selectDefaultModel(item)}
      onOpen={() => { setEditing(item.id); }}
    />
  );

  return (
    <SectionCard id="st-card-models" title={t('st.models.defaultTitle')}>
      <div className="space-y-3">
        {/* The one global default, stated once, above the list it is picked from. */}
        <div data-default-model-line className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="text-ink-soft">{t('st.models.newSessionsUse')}</span>
          {defaultItem !== undefined ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-ink">
              <Icon name="starFilled" size={12} className="text-ink" />
              <span className="truncate">{defaultItem.display_name ?? defaultItem.id}</span>
              <span className="truncate text-[12px] font-normal text-ink-faint">{groupLabel(defaultItem.provider_id)}</span>
            </span>
          ) : (
            <span className="text-ink-faint">{defaultModel ?? t('st.models.noDefault')}</span>
          )}
          <span className="ml-auto"><SavedTick show={tick} /></span>
        </div>
        {items.length > 0 ? (
          <ListToolbar view={view} total={items.length} filters={filters}
            searchLabel={t('st.models.searchAria')} searchPlaceholder={t('st.models.searchWide')} />
        ) : null}
        {items.length > 0 && view.visible.length === 0 ? (
          <ListEmpty kind="no-match" title={t('st.models.noMatchTitle')}
            body={view.query.trim() === '' ? undefined : t('st.models.searchEmpty', { query: view.query.trim() })}
            onClear={view.clear} />
        ) : null}
        <div>
          {groups.map((group) => {
            const isProvider = group.key.startsWith('provider:');
            const provider = isProvider ? providers.get(group.key.slice('provider:'.length)) : undefined;
            // A provider id no connection answers to is as broken as a failing one.
            // The no-connection group already says so in its label.
            const broken = !isProvider || group.key === 'provider:' || providersQuery.data === undefined ? undefined
              : provider === undefined ? 'missing' : provider.status !== 'connected' ? provider.status : undefined;
            return (
              <ListGroup key={group.key} groupKey={group.key} label={group.label} count={group.items.length} total={group.total}
                folded={view.isFolded(group.key)} onToggle={() => { view.toggleFold(group.key); }}
                trailing={broken !== undefined ? (
                  <span data-group-attention className="inline-flex shrink-0 items-center gap-1 text-[12px] text-attention">
                    <Icon name="warning" size={12} />{t(broken === 'unconfigured' ? 'st.models.providerUnconfigured' : broken === 'missing' ? 'st.models.group.noProvider' : 'st.models.providerAttention')}
                  </span>
                ) : undefined}>
                <ListBody items={group.items} keyOf={keyOf} density={view.density} renderRow={renderRow} label={group.label} />
              </ListGroup>
            );
          })}
        </div>
        {catalogEmpty ? (
          <ListEmpty kind="none" title={t('st.models.emptyCatalog')}
            action={(
              <button type="button" className={SECONDARY_BUTTON}
                onClick={() => { navigate('/settings/ai?tab=providers#st-card-providers-add'); }}>
                {t('st.models.goProviders')}
              </button>
            )} />
        ) : null}
        {modelsQuery.isLoading ? <Hint>{t('st.models.loading')}</Hint> : null}
        {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
      {editingItem !== undefined ? (
        <ModelDetailPanel
          key={editingItem.id}
          item={editingItem}
          inheritedImageTypes={providers.get(editingItem.provider_id)?.images?.accepted_types}
          onSaved={refreshCatalog}
          onClose={() => { setEditing(null); }}
        />
      ) : null}
    </SectionCard>
  );
}

/**
 * Tab 3 opener (redesign §3.3): the GLOBAL default provider/model new
 * sessions start with. The provider is a plain select; the model is chosen
 * by starring a row on the Available models tab, so this card links there
 * instead of duplicating the picker. This is deliberately distinct from the
 * per-provider default edited inside each provider.
 */
const DEFAULT_PICKER =
  'flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-ink/[0.04] px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.07] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint';

/**
 * Every "which model does X" choice in one place: new sessions, then the
 * background jobs that run on their own model (session titles). Each row
 * applies on pick. The new-session pick carries its connection along as the
 * default provider, the same rule the star in the model list follows.
 */
export function GlobalDefaultsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'model' | 'title' | 'subagent' | 'fast' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const models = modelsQuery.data?.items ?? [];
  const defaultModel = configQuery.data?.default_model ?? '';
  const defaultProvider = configQuery.data?.default_provider ?? '';
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

  const pickDefault = async (modelId: string) => {
    const item = models.find((candidate) => candidate.id === modelId);
    if (item === undefined || modelId === defaultModel) return;
    setBusy('model');
    setFeedback(null);
    try {
      const echoed = await client.setDefaultModel(item.id);
      queryClient.setQueryData(['config'], (current: Record<string, unknown> | undefined) => ({ ...current, default_model: echoed.default_model }));
      writeSettings({ defaultModel: echoed.default_model });
      // Inside a space the write lands in the space's own config; re-read so
      // the row's origin mark reads "This space".
      if (isInSubspace()) void queryClient.invalidateQueries({ queryKey: ['config'] });
      if (item.provider_id !== defaultProvider) {
        queryClient.setQueryData(['config'], await client.patchConfig({ default_provider: item.provider_id }));
      }
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
      id: 'new-session',
      origin: { domain: 'default_model', keyPath: [] },
      label: t('st.defaults.row.newSession'),
      help: t('st.defaults.row.newSessionHelp'),
      picker: (
        <SearchableSelect
          id="st-default-model"
          value={defaultModel}
          options={options}
          onChange={(value) => void pickDefault(value)}
          ariaLabel={t('st.defaults.row.newSession')}
          searchPlaceholder={t('st.models.searchPlaceholder')}
          emptyText={t('st.models.noDefault')}
          disabled={busy !== null || models.length === 0}
          buttonClassName={DEFAULT_PICKER}
        />
      ),
    },
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
    'new-session': 'st-default-model', 'session-title': 'st-default-title-model',
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
 * starts from the default pair — and only then: whatever discovery actually
 * reported is kept, with the defaults filling only the gaps. That is the same
 * rule the model editor applies to a model that has nothing stored, and it is
 * why a discovery that reports a narrower set is not silently widened.
 */
function defaultCapabilitiesFor(discovered: readonly string[] | undefined): string[] {
  if (discovered === undefined) return [...DEFAULT_MODEL_CAPABILITIES];
  return [...new Set([...discovered, ...DEFAULT_MODEL_CAPABILITIES])];
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
        support_efforts: choice.model.support_efforts,
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
          }}
          ariaLabel={t('st.providers.catalogGroupSuggested')}
          searchPlaceholder={t('st.providers.modelSearchPlaceholder')}
          emptyText={t('st.catalogRefresh.empty')}
          disabled={busy}
        />
        {choice !== undefined ? (
          <div className="space-y-3 border-t border-hairline pt-3" data-catalog-refresh-form>
            <Hint>{t('st.catalogRefresh.saveHint')}</Hint>
            <label className={FORM_LABEL}>{t('st.catalogRefresh.alias')}
              <input className={`${INPUT} mt-1 font-normal`} value={alias} disabled={busy} onChange={(event) => { setAlias(event.target.value); }} />
            </label>
            <div className="space-y-1">
              <p className={FORM_LABEL}>{t('st.compact.windowLabel')}</p>
              <ContextStepper value={context} onChange={setContext} ariaLabel={t('st.models.contextAria', { model: choice.model.remote_id })} />
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

/** Models tab: the cross-connection list first, then adding models, then one-off maintenance. */
export function ModelsTab() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <ModelCatalogCard />
      <CatalogRefreshCard />
      <details className="group border-t border-hairline pt-4" data-models-maintenance>
        <summary className="flex h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.04] hover:text-ink [&::-webkit-details-marker]:hidden">
          <DisclosureChevron open={false} className="text-ink-soft transition-transform group-open:rotate-90" />
          {t('st.models.maintenance')}
        </summary>
        <div className="pt-4"><ModelGenerationMigrationCard /></div>
      </details>
    </div>
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
};

function hasCapability(item: ModelCatalogItem, capability: string): boolean {
  const caps = item.effective_capabilities ?? item.capabilities ?? [];
  return caps.includes(capability) || (capability === 'thinking' && caps.includes('always_thinking'));
}

/**
 * One catalog row: star (global default), name + remote id, context, the
 * jobs it serves, capability words. The whole row opens the model's detail
 * panel; nothing expands in place, so a 40-model list never reflows.
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
  /** Its detail panel is open. */
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
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('st.models.editTitle')}
        onClick={onOpen}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-3 self-stretch rounded-md pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
      >
        <span className={`min-w-0 flex-1 ${compact ? 'flex items-baseline gap-2' : ''}`}>
          <span className={`flex min-w-0 items-center gap-2 ${compact ? 'shrink' : ''}`}>
            <span className="truncate text-[13px] font-medium text-ink">{item.display_name ?? item.id}</span>
            {isDefault ? <span className="sr-only">{t('st.models.default')}</span> : null}
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
 * The model's editor, in a side panel beside the list rather than inside
 * the row. Closing with unsaved changes asks first; the list and its scroll
 * position stay exactly where they were.
 */
function ModelDetailPanel({ item, inheritedImageTypes, onSaved, onClose }: {
  item: ModelCatalogItem;
  inheritedImageTypes: readonly string[] | undefined;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => { if (dirty) setConfirming(true); else onClose(); };
  return (
    <SidePanel
      title={item.display_name ?? item.id}
      description={<span className="font-mono text-[11px]">{item.id}</span>}
      overlayId={`catalog-model:${item.id}`}
      onClose={requestClose}
      width="lg"
      data={{ 'data-model-detail': item.id }}
    >
      <div data-model-row-editor={item.id}>
        <ModelCatalogRowEditor
          item={item}
          inheritedImageTypes={inheritedImageTypes}
          onSaved={onSaved}
          onDirtyChange={setDirty}
          onClose={requestClose}
        />
      </div>
      <ConfirmDialog
        open={confirming}
        overlayId={`catalog-model-discard:${item.id}`}
        title={t('st.dirty.leaveTitle')}
        body={t('st.dirty.leaveBody')}
        confirmLabel={t('st.dirty.leaveConfirm')}
        cancelLabel={t('st.dirty.stay')}
        onConfirm={() => { setConfirming(false); onClose(); }}
        onCancel={() => { setConfirming(false); }}
      />
    </SidePanel>
  );
}

/**
 * In-place editor for one catalog row. Opening the row reads the model entity
 * (`GET /models/{id}`), so the editor works from the stored record — its local
 * alias, its exact remote id, its revision and its issues — instead of
 * rebuilding anything from the list projection. Saving sends only the fields
 * the user changed together with the revision that read returned, so a
 * concurrent edit surfaces as a conflict instead of a silent overwrite.
 * Closing is explicit: the parent keeps this editor mounted while the row is
 * collapsed, and only a Close that survives the discard guard drops the draft.
 */
function ModelCatalogRowEditor({
  item,
  inheritedImageTypes,
  onSaved,
  onDirtyChange,
  onClose,
}: {
  item: ModelCatalogItem;
  inheritedImageTypes: readonly string[] | undefined;
  onSaved: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
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
  const [usageScope, setUsageScope] = useState<'shared' | UsagePosition>('shared');
  // One scope for the page. The two prompt groups and the usage group all have
  // a real per-identity layer on the wire; the rest of the model does not, and
  // stays a single set of shared values whichever tab is open.
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
  /**
   * What this identity actually differs on, in words. Naming the groups beats a
   * badge per field: the reader learns which group to go to instead of decoding
   * a colour.
   */
  const scopeBranch = editScope === 'shared' ? undefined : prompts === null ? undefined : {
    cognition: prompts.cognition[editScope],
    fields: prompts.fields[editScope],
  };
  const scopeDifferences = editScope === 'shared' || scopeBranch === undefined || usage === null
    ? 0
    : countUsageDifferences(usage[editScope] ?? EMPTY_USAGE_BRANCH);
  const scopeSummary = editScope === 'shared' || scopeBranch === undefined
    ? undefined
    : scopeDifferenceSummary({
      usageFields: countUsageDifferences(usage?.[editScope] ?? EMPTY_USAGE_BRANCH),
      promptsCustom: scopeBranch.cognition.kind === 'custom' || scopeBranch.fields.kind === 'custom',
      promptsOff: scopeBranch.cognition.kind === 'off' || scopeBranch.fields.kind === 'off',
    });
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

  /**
   * The compaction point and track, read through whichever scope is on screen.
   *
   * An identity inherits the shared window and input limit but carries its own
   * budget and trigger point, and the engine resolves the two with the same
   * lower-of-the-two rule it uses everywhere else: a difference can tighten the
   * budget, never widen it past the shared value. Feeding the shared numbers
   * while an identity was on screen would show one scope's ceiling above the
   * other scope's number, and dragging the track would write the shared point.
   *
   * This resolves the scope the engine would; it is not a second solver, and it
   * never invents a value the shared layer or the identity does not hold.
   */
  const sharedContextBudget = engine !== null && /^\d+$/.test(engine.contextBudget.trim())
    ? Number(engine.contextBudget.trim()) : undefined;
  const compactionScope: UsagePosition | 'shared' = usageScope;
  const identityBudget = compactionScope === 'shared' || usage === null
    ? undefined
    : identityUsageNumber(usage[compactionScope]?.contextBudget);
  const identityPoint = compactionScope === 'shared' || usage === null
    ? undefined
    : identityUsageNumber(usage[compactionScope]?.autoCompact);
  const compaction = useModelCompactionTrack({
    windowTokens: draft?.maxContextSize ?? 0,
    inputTokens: engine !== null && /^\d+$/.test(engine.maxInputSize.trim()) ? Number(engine.maxInputSize.trim()) : undefined,
    // The budget on screen is the one that actually limits this scope.
    contextBudget: minOptional(sharedContextBudget, identityBudget),
    overrides: engine?.overrides,
    // An identity that sets no point of its own is still measured against the
    // model's shared point, unsaved edits included: the track answers "where
    // does this scope land", and for an inheriting scope that is the shared
    // value rather than the global default the engine would otherwise use.
    autoCompact: compactionScope === 'shared' ? autoCompact : (identityPoint ?? autoCompact),
    loopControl: configQuery.data?.loop_control,
  });

  // A package being authored is a draft too: leaving the panel with words typed
  // and unsaved would lose them exactly as the model's own fields would.
  const [recipeDraftDirty, setRecipeDraftDirty] = useState(false);
  const modelDirty = (draft !== null && baseline !== null && !providerModelDraftsEqual(draft, baseline))
    || compactDirty || engineDirty || usageDirty || sharedGenerationDirty || behaviorDirty
    || promptsDirty || bodySavesDirty;
  const dirty = modelDirty || recipeDraftDirty;
  useDirtyReporter(`catalog-model:${item.id}`, dirty);
  // The row owns the collapse/close decision, and the draft stays dirty while
  // the editor is hidden, so the parent needs this flag either way.
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  if (entityQuery.isError) return <InlineError error={entityQuery.error} />;
  if (entity === undefined || draft === null || baseline === null || engine === null || engineBaseline === null) {
    return <Hint>{t('st.models.loading')}</Hint>;
  }

  /**
   * Editing in the shared scope writes the model's own value. Each field goes
   * to the draft that already owns it, so one Save writes both layers and no
   * value is ever held in two places at once. `thinking_effort`, `service_tier`
   * and `max_completion_tokens` live in `parameters`, which this editor writes
   * through a sparse patch alongside the rest.
   */
  /**
   * The compaction point, read and written through whichever scope is on
   * screen: the shared scope edits the model's own value, an identity scope
   * edits only its difference. One control, two layers.
   */
  const compactionPoint: number | undefined = compactionScope === 'shared' ? autoCompact : identityPoint;
  const setCompactionPoint = (next: number | undefined) => {
    if (compactionScope === 'shared') { setAutoCompact(next); return; }
    if (usage === null) return;
    setUsage({
      ...usage,
      [compactionScope]: setUsageText(
        usage[compactionScope] ?? EMPTY_USAGE_BRANCH, 'auto_compact', next === undefined ? '' : String(next)),
    });
  };

  // The shared scope falls back to the global default, so it keeps the shared
  // hint. An identity scope inherits the shared value, which the scope line
  // above already states, so the global-default sentence would be false here.
  const compactionHint = compaction.hint === undefined
    ? undefined
    : compaction.hint === t('st.compact.pointHint')
      ? (compactionScope === 'shared' ? compaction.hint : t('st.compact.pointHintIdentity'))
      : compaction.hint;
  const compactionTrack = (
    <div className="space-y-1 pt-1">
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
        onChange={setCompactionPoint}
      />

    </div>
  );

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
      const fieldPatch = modelPatchBody(draft, baseline);
      if (fieldPatch === null && !compactDirty && Object.keys(enginePatch).length === 0
        && Object.keys(usagePatch).length === 0 && generationPatch === null
        && behaviorPatch === undefined && !promptsDirty && !bodySavesDirty && recipeReference === undefined) return;
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
      };
      if (bodySavesDirty) patch.cognition = cognition;
      if (recipeReference !== undefined) patch.recipe = recipeReference;
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

  return (
    <div className="space-y-4">
      {entity.issues.length > 0 ? (
        <p role="status" className="rounded-md bg-amber-card px-3 py-1.5 text-[12px] leading-4 text-amber-ink">
          {entity.issues.map((issue) => {
            const key = MODEL_ISSUE_KEYS[issue.code];
            return `${issue.path}: ${key === undefined ? issue.message : t(key)}`;
          }).join(' · ')}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={FORM_LABEL}>
          {t('st.models.displayNameLabel')}
          <input
            className={`${INPUT} mt-1 font-normal`}
            aria-label={t('st.models.displayNameAria', { model: entity.id })}
            value={draft.displayName}
            onChange={(event) => { setDraft({ ...draft, displayName: event.target.value }); }}
            placeholder={entity.remote_id}
          />
        </label>
        <div className={FORM_LABEL}>
          {t('st.chips.efforts')}
          <div className="mt-1.5 font-normal">
            <ChipSelect
              values={draft.supportEfforts}
              knownOptions={KNOWN_EFFORTS}
              onChange={(supportEfforts) => { setDraft({ ...draft, supportEfforts }); }}
              ariaLabel={t('st.models.effortsAria', { model: entity.id })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
        </div>
      </div>
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
      {/*
        One scope for the page. It sits above the two groups that have a real
        per-identity layer on the wire, so switching to  re-points those
        rows instead of showing a second copy of the form.
      */}
      <ModelEditScopeSwitch
        scope={editScope}
        summary={scopeSummary}
        differences={scopeDifferences}
        onScopeChange={(next) => { setEditScope(next); setUsageScope(next); }}
      />
      {/*
        The prompt prose, always open and at the top of the identity section.
        What a model is told is the reason to open this page. Editing a readable
        file-backed slot saves its text onto the model without touching the file.
      */}
      <div className="border-t border-hairline pt-4">
        <ModelPromptBodies
          modelId={entity.id}
          bodies={entity.cognition_bodies}
          scope={editScope}
          branchSelection={branchSelectionFor(editScope, prompts)}
          draft={scopedBodyDraft}
          // Typing is the decision. A slot backed by an author file converts to
          // a body on the model when this page saves, exactly like any other
          // field; asking again per slot made the one confirmation the page did
          // offer easy to miss and easy to skip by accident.
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
      </div>
      {usage !== null ? (
        <MainUsagePolicyFields
          modelId={entity.id}
          scope={usageScope}
          view={usagePolicyView(entity, usage, usageDirty, usageIssue, autoCompact, engine, sharedGeneration)}
          onSharedChange={applySharedUsageEdit}
          onChange={(next) => { setUsage(next); setUsageIssue(null); }}
          compaction={compactionTrack}
          compactionControl={(
            <CompactPointField
              dataAttribute={`model:${entity.id}`}
              labelClassName="sr-only"
              label={t('st.compact.pointLabel')}
              value={compactionPoint}
              onChange={setCompactionPoint}
              windowTokens={compaction.usable}
              placeholder={compactionScope === 'shared'
                ? compaction.inheritedLabel
                : t('st.usagePolicy.inheritSharedPoint')}
              presets={compaction.presets}
              presetsLabel={compaction.presetsLabel}
              hint={compactionHint}
            />
          )}
          disabled={saving}
        />
      ) : null}
      {/*
        Capabilities sit on the ordinary surface of the editor, not inside the
        advanced fold: what this model can do is one of the two or three things
        a person opens this panel to decide, and folding it away is what let a
        model's real submitted capabilities go unchecked.
      */}
      <div className="space-y-1" data-model-capabilities={entity.id}>
        <p className={FORM_LABEL}>{t('st.chips.capabilities')}</p>
        <ChipSelect
          values={draft.capabilities}
          knownOptions={KNOWN_CAPABILITIES}
          onChange={(capabilities) => { setDraft({ ...draft, capabilities }); }}
          ariaLabel={t('st.models.capsAria', { model: entity.id })}
          addPlaceholder={t('st.chips.addPlaceholder')}
          removeLabel={(value) => t('st.chips.removeAria', { value })}
        />
        <Hint>{t('st.models.capabilitiesHint')}</Hint>
      </div>
      {/*
        The Recipe row sits above the scope switch on purpose. Which recipe a
        model uses is a decision about the model as a whole, so putting it under
        an identity tab would read as "this recipe is for the main agent only".
      */}
      <ModelRecipeField
        modelId={entity.id}
        modelName={draft.displayName.trim() === '' ? entity.id : draft.displayName.trim()}
        onCommitRecipe={save}
        appliedId={entity.recipe}
        disabled={saving}
        onDraftChange={setRecipeDraftDirty}
      />
      <AdvancedDisclosure id={`model-${entity.id}`} summary={t('st.models.advancedSummary')}>
        <label className={FORM_LABEL}>
          {t('st.models.remoteIdLabel')}
          <input
            className={`${INPUT} mt-1 font-mono font-normal`}
            aria-label={t('st.models.remoteIdAria', { model: entity.id })}
            value={draft.remoteId}
            onChange={(event) => { setDraft({ ...draft, remoteId: event.target.value }); }}
            placeholder="model-id"
          />
          <span className="mt-1 block font-mono text-[11px] font-normal text-ink-faint">{t('st.models.aliasLine', { alias: entity.id })}</span>
        </label>
        <ImagePolicyEditor
          value={draft}
          onChange={(images) => { setDraft({ ...draft, ...images }); }}
          inheritLabel={t('st.images.inheritProvider')}
        />
        <SavedGenerationParametersEditor scope="model" id={entity.id} onSaved={onSaved} />
        <RequestIdentityLayerEditor
          value={draft}
          onChange={(identity) => { setDraft({ ...draft, ...identity }); }}
          label={t('st.models.requestIdentity')}
          inheritLabel={t('st.requestIdentity.inheritProvider')}
          hint={t('st.models.requestIdentityHint')}
        />
        <ModelEngineFields modelId={entity.id} value={engine} issue={engineIssue} disabled={saving}
          onChange={(next) => { setEngine(next); setEngineIssue(null); }} />
        <div className="border-t border-hairline pt-3" data-model-behavior={entity.id}>
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
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || !modelDirty} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onClose}>
          {t('common.close')}
        </button>
        {dirty ? (
          <span className="text-[12px] text-ink-faint">{t('st.draft.unsaved')}</span>
        ) : <SavedTick show={detailSaved} />}
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
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

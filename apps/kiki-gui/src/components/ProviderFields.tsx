/**
 * Provider editing surface — the template wizard for new providers, the
 * collapsible editor for configured ones, and their shared field set:
 * protocol/baseUrl/key, the remote /models probe, collapsible model rows
 * (unit-ed context stepper, chip multi-selects, inline default star), and
 * the millisecond unit input reused by the sidecar card.
 *
 * Every save goes through the shared klient client as a sparse entity write:
 * `updateProvider` touches only the connection fields the user changed (never
 * a model list), and each model row is its own entity — created, patched or
 * deleted on its own. The draft→wire mapping itself lives in session-core
 * (`providerCreateBody` / `providerPatchBody` / `modelCreateBody` /
 * `modelPatchBody`), so the GUI owns no second copy of the wire contract.
 */

import { useEffect, useMemo, useState } from 'react';

import type { CatalogModelItem, ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';

import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  fetchRemoteModels,
  humanizeMs,
  isProviderDraftDirty,
  KNOWN_CAPABILITIES,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MIME_TYPES,
  MS_UNIT_FACTORS,
  msUnitFor,
  modelCreateBody,
  modelPatchBody,
  PROVIDER_TEMPLATES,
  PROVIDER_WIRE_TYPES,
  providerCreateBody,
  providerDraftFromCatalog,
  providerPatchBody,
  validateNewProviderDraft,
  validateProviderDraft,
  type ImagePolicyDraft,
  type MsUnit,
  type ProviderDraft,
  type ProviderModelDraft,
  type ProviderTemplate,
} from '@kiki/session-core/settings';
import { formatTokens } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { ChipSelect } from './ChipSelect';
import { ConfirmDialog } from './ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from './controls';
import { useDirtyReporter } from './dirtyGuard';
import { RequestIdentityLayerEditor } from './RequestIdentityLayerEditor';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from './ui';

interface ProviderModelCatalogChoice {
  readonly id: string;
  readonly name?: string;
  readonly maxContextSize: number;
  readonly capabilities: readonly string[];
  readonly supportEfforts: readonly string[];
}

function configuredCatalogChoice(model: ModelCatalogItem): ProviderModelCatalogChoice {
  return {
    id: model.remote_id,
    name: model.display_name,
    maxContextSize: model.max_context_size,
    capabilities: model.capabilities ?? [],
    supportEfforts: model.support_efforts ?? [],
  };
}

function directoryCatalogChoice(model: CatalogModelItem): ProviderModelCatalogChoice {
  return {
    id: model.id,
    name: model.name,
    maxContextSize: model.max_context_size,
    capabilities: model.capabilities ?? [],
    supportEfforts: model.support_efforts ?? [],
  };
}

export function blankProviderDraft(): ProviderDraft {
  return {
    id: '',
    type: 'openai',
    baseUrl: '',
    defaultModel: '',
    apiKey: '',
    clearApiKey: false,
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
    models: [blankModel()],
  };
}

function blankModel(): ProviderModelDraft {
  return {
    id: '',
    remoteId: '',
    maxContextSize: 128000,
    displayName: '',
    capabilities: [],
    supportEfforts: [],
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
  };
}

// ---- unit-ed numeric inputs ----

function StepButton({
  direction,
  label,
  disabled,
  onStep,
}: {
  direction: 1 | -1;
  label: string;
  disabled?: boolean;
  onStep: (direction: 1 | -1) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={() => { onStep(direction); }}
      className="flex w-7 items-center justify-center rounded-md border border-hairline bg-paper text-[13px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      {direction === 1 ? '+' : '−'}
    </button>
  );
}

const CONTEXT_UNITS = [
  { id: 'tokens', factor: 1, label: 'tok' },
  { id: 'K', factor: 1_000, label: 'K' },
  { id: 'M', factor: 1_000_000, label: 'M' },
] as const;
type ContextUnit = (typeof CONTEXT_UNITS)[number]['id'];

function autoContextUnit(value: number): ContextUnit {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return 'M';
  if (value >= 1_000 && value % 1_000 === 0) return 'K';
  return 'tokens';
}

/** Context-size stepper: numeric value paired with a tok/K/M unit select. */
export function ContextStepper({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  const [unit, setUnit] = useState<ContextUnit>(() => autoContextUnit(value));
  const factor = CONTEXT_UNITS.find((candidate) => candidate.id === unit)?.factor ?? 1;
  const shown = Math.round((value / factor) * 1000) / 1000;
  const commit = (display: number) => {
    if (!Number.isFinite(display)) return;
    onChange(Math.max(1, Math.round(display * factor)));
  };
  return (
    <div className="flex items-center gap-1">
      <StepButton direction={-1} label={t('st.stepper.decrease')} onStep={() => { commit(shown - 1); }} />
      <input
        type="number"
        min={0}
        step="any"
        aria-label={ariaLabel}
        className={`${SMALL_INPUT} w-24 text-right`}
        value={shown}
        onChange={(event) => { commit(Number(event.target.value)); }}
      />
      <StepButton direction={1} label={t('st.stepper.increase')} onStep={() => { commit(shown + 1); }} />
      <select
        aria-label={ariaLabel}
        className={SMALL_INPUT}
        value={unit}
        onChange={(event) => { setUnit(event.target.value as ContextUnit); }}
      >
        {CONTEXT_UNITS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
      </select>
    </div>
  );
}

const MS_UNITS: readonly { id: MsUnit; label: string }[] = [
  { id: 'ms', label: 'ms' },
  { id: 'seconds', label: 's' },
  { id: 'minutes', label: 'min' },
  { id: 'hours', label: 'h' },
];

/**
 * Millisecond field with a unit select and a live humanized preview
 * ("= 2 h"); the wire value stays integer ms.
 */
export function MsUnitInput({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: number;
  onChange: (ms: number) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [unit, setUnit] = useState<MsUnit>(() => msUnitFor(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    // External loads re-pick the unit; while typing, the user's unit stands.
    if (!focused) setUnit(msUnitFor(value));
  }, [focused, value]);
  const factor = MS_UNIT_FACTORS[unit];
  const shown = Math.round((value / factor) * 100) / 100;
  const commit = (display: number) => {
    if (!Number.isFinite(display)) return;
    onChange(Math.max(0, Math.round(display * factor)));
  };
  const humanized = humanizeMs(value);
  return (
    <div>
      <div className="mt-1 flex items-center gap-1">
        <StepButton direction={-1} label={t('st.stepper.decrease')} disabled={disabled} onStep={() => { commit(shown - 1); }} />
        <input
          type="number"
          min={0}
          step="any"
          aria-label={ariaLabel}
          disabled={disabled}
          className={`${INPUT} w-24 text-right`}
          value={shown}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          onChange={(event) => { commit(Number(event.target.value)); }}
        />
        <StepButton direction={1} label={t('st.stepper.increase')} disabled={disabled} onStep={() => { commit(shown + 1); }} />
        <select
          aria-label={ariaLabel}
          disabled={disabled}
          className={SMALL_INPUT}
          value={unit}
          onChange={(event) => { setUnit(event.target.value as MsUnit); }}
        >
          {MS_UNITS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
      </div>
      <p className="mt-1 text-[10.5px] text-ink-faint">= {t(`st.unit.${humanized.unit}`, { n: humanized.value })}</p>
    </div>
  );
}

export function ImagePolicyEditor({
  value,
  onChange,
  inheritLabel,
}: {
  value: ImagePolicyDraft;
  onChange: (value: ImagePolicyDraft) => void;
  inheritLabel: string;
}) {
  const { t } = useI18n();
  const acceptedMode = value.imageAcceptedTypes === null ? 'inherit' : 'custom';
  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-panel/50 p-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
        {t('st.images.title')}
      </p>
      <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
        <span className="text-[10.5px] font-medium text-ink-soft">
          {t('st.images.acceptedTypes')}
        </span>
        <select
          aria-label={t('st.images.acceptedTypesModeAria')}
          className={SMALL_INPUT}
          value={acceptedMode}
          onChange={(event) => {
            onChange({
              ...value,
              imageAcceptedTypes: event.target.value === 'inherit'
                ? null
                : [...KNOWN_IMAGE_MIME_TYPES],
            });
          }}
        >
          <option value="inherit">{inheritLabel}</option>
          <option value="custom">{t('st.images.custom')}</option>
        </select>
      </div>
      {value.imageAcceptedTypes === null ? (
        <Hint>{t('st.images.inheritHint')}</Hint>
      ) : (
        <ChipSelect
          values={value.imageAcceptedTypes}
          knownOptions={KNOWN_IMAGE_MIME_TYPES}
          onChange={(imageAcceptedTypes) => { onChange({ ...value, imageAcceptedTypes }); }}
          ariaLabel={t('st.images.acceptedTypesAria')}
          addPlaceholder={t('st.images.addMime')}
          removeLabel={(mime) => t('st.images.removeMimeAria', { mime })}
        />
      )}
      <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
        <span className="text-[10.5px] font-medium text-ink-soft">
          {t('st.images.convertUnsupported')}
        </span>
        <select
          aria-label={t('st.images.convertUnsupportedAria')}
          className={SMALL_INPUT}
          value={value.imageConvertUnsupported ?? ''}
          onChange={(event) => {
            onChange({
              ...value,
              imageConvertUnsupported: event.target.value === ''
                ? null
                : event.target.value as NonNullable<ImagePolicyDraft['imageConvertUnsupported']>,
            });
          }}
        >
          <option value="">{inheritLabel}</option>
          {(['off', 'auto', 'png', 'jpeg'] as const).map((mode) => (
            <option key={mode} value={mode}>{t(`st.images.convert.${mode}`)}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ---- model draft rows ----

function ModelDraftRow({
  model,
  index,
  isDefault,
  canRemove,
  catalogModels,
  onChange,
  onRemove,
  onSetDefault,
}: {
  model: ProviderModelDraft;
  index: number;
  isDefault: boolean;
  canRemove: boolean;
  catalogModels: readonly ProviderModelCatalogChoice[];
  onChange: (patch: Partial<ProviderModelDraft>) => void;
  onRemove: () => void;
  onSetDefault: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(model.remoteId === '');
  const n = index + 1;
  const requestIdentitySummary = model.requestIdentityChoice === 'inherit'
    ? 'inherit'
    : model.requestIdentityChoice;
  const rowLabel = model.id || model.remoteId;
  const catalogOptions = useMemo<readonly SearchableSelectOption[]>(() =>
    catalogModels.map((candidate) => ({
      value: candidate.id,
      label: candidate.id,
      description: candidate.name,
      keywords: candidate.name,
      badges: [
        { label: formatTokens(candidate.maxContextSize) },
        ...candidate.capabilities.slice(0, 2).map((capability) => ({ label: capability })),
        ...(candidate.supportEfforts.length > 0
          ? [{ label: t('st.providers.catalogEfforts', { count: candidate.supportEfforts.length }) }]
          : []),
      ],
    })), [catalogModels, t]);
  const selectModelId = (remoteId: string) => {
    const catalogModel = catalogModels.find((candidate) => candidate.id === remoteId);
    if (catalogModel === undefined) {
      onChange({ remoteId });
      return;
    }
    onChange({
      remoteId,
      displayName: catalogModel.name ?? '',
      maxContextSize: catalogModel.maxContextSize,
      capabilities: [...catalogModel.capabilities],
      supportEfforts: [...catalogModel.supportEfforts],
    });
  };
  return (
    <div className="rounded-lg border border-hairline bg-panel p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t('st.providers.defaultStarAria', { model: rowLabel || '…' })}
          title={t('st.providers.defaultStarTitle')}
          disabled={model.remoteId === ''}
          onClick={onSetDefault}
          className={`shrink-0 text-[15px] leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            isDefault ? 'text-accent' : 'text-hairline-strong hover:text-accent'
          }`}
        >
          {isDefault ? '★' : '☆'}
        </button>
        <button
          type="button"
          aria-label={t('st.providers.modelExpandAria', { n })}
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`truncate font-mono text-[12px] ${model.remoteId === '' ? 'text-ink-faint' : 'text-ink'}`}>
            {model.remoteId === '' ? 'model-id' : model.remoteId}
          </span>
          {model.id !== '' ? (
            <span className="hidden shrink-0 truncate font-mono text-[10px] text-ink-faint sm:inline">
              {model.id}
            </span>
          ) : null}
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{formatTokens(model.maxContextSize)}</span>
          {model.capabilities.slice(0, 3).map((capability) => (
            <span key={capability} className="hidden shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px text-[9.5px] text-ink-faint sm:inline">
              {capability}
            </span>
          ))}
          <span className="hidden shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px text-[9.5px] text-ink-faint sm:inline">
            {t(`st.providers.requestIdentityBadge.${requestIdentitySummary}`)}
          </span>
          <span aria-hidden className={`ml-auto shrink-0 text-[10px] text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        </button>
        <button
          type="button"
          disabled={!canRemove}
          onClick={onRemove}
          className={`${SECONDARY_BUTTON} shrink-0 px-2 text-danger`}
        >
          ×
        </button>
      </div>
      {open ? (
        <div className="mt-3 space-y-2.5 border-t border-hairline pt-3">
          {model.id !== '' ? (
            <p className="truncate font-mono text-[10px] text-ink-faint">{model.id}</p>
          ) : null}
          <div className="grid items-start gap-2 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <SearchableSelect
                id={`provider-model-${index}-id`}
                options={catalogOptions}
                value={model.remoteId}
                onChange={selectModelId}
                ariaLabel={t('st.providers.modelIdAria', { n })}
                allowCustomValue
                customValueLabel={(id) => t('st.providers.useCustomModel', { id })}
                searchPlaceholder={t('st.providers.modelSearchPlaceholder')}
                emptyText={t('st.providers.catalogEmpty')}
                buttonClassName={`${INPUT} flex items-center justify-between gap-2 text-left font-mono`}
                panelClassName="anim-enter absolute left-0 top-full z-40 mt-1 w-[min(30rem,calc(100vw-48px))] overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_12px_32px_-12px_rgba(28,25,23,0.35)]"
              />
              <Hint>{t('st.providers.catalogModelHint')}</Hint>
            </div>
            <input
              className={INPUT}
              aria-label={t('st.providers.modelNameAria', { n })}
              value={model.displayName}
              onChange={(event) => { onChange({ displayName: event.target.value }); }}
              placeholder={t('st.providers.displayNamePlaceholder')}
            />
          </div>
          <ContextStepper
            value={model.maxContextSize}
            onChange={(maxContextSize) => { onChange({ maxContextSize }); }}
            ariaLabel={t('st.providers.modelContextAria', { n })}
          />
          <div className="space-y-1">
            <p className="text-[10.5px] font-medium text-ink-faint">{t('st.chips.capabilities')}</p>
            <ChipSelect
              values={model.capabilities}
              knownOptions={KNOWN_CAPABILITIES}
              onChange={(capabilities) => { onChange({ capabilities }); }}
              ariaLabel={t('st.providers.modelCapsAria', { n })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10.5px] font-medium text-ink-faint">{t('st.chips.efforts')}</p>
            <ChipSelect
              values={model.supportEfforts}
              knownOptions={KNOWN_EFFORTS}
              onChange={(supportEfforts) => { onChange({ supportEfforts }); }}
              ariaLabel={t('st.providers.modelEffortsAria', { n })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
          <ImagePolicyEditor
            value={model}
            onChange={(images) => { onChange(images); }}
            inheritLabel={t('st.images.inheritProvider')}
          />
          <div className="border-t border-hairline pt-3">
            <RequestIdentityLayerEditor
              value={model}
              onChange={(identity) => { onChange(identity); }}
              label={t('st.models.requestIdentity')}
              inheritLabel={t('st.requestIdentity.inheritProvider')}
              hint={t('st.models.requestIdentityHint')}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---- shared field set (wizard + editor) ----

export function ProviderFields({
  draft,
  onChange,
  hasStoredKey,
  managed = false,
  idLocked = false,
  refreshProviderId,
  catalogModels = [],
  onRefreshed,
}: {
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  hasStoredKey: boolean;
  /** OAuth-managed providers have no usable API-key save/clear/delete surface. */
  managed?: boolean;
  /**
   * A stored connection keeps its technical id: profile pins, sessions and the
   * model aliases reference it, so this form edits the display-name-level
   * fields only (in-place renaming is not part of this slice).
   */
  idLocked?: boolean;
  /** When set, Test connection uses the server-side provider discovery service. */
  refreshProviderId?: string;
  catalogModels?: readonly ProviderModelCatalogChoice[];
  onRefreshed?: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<Feedback>(null);
  const availableCatalogModels = useMemo<readonly ProviderModelCatalogChoice[]>(() =>
    catalogModels.length > 0
      ? catalogModels
      : draft.models
          .filter((model) => model.remoteId !== '')
          .map((model) => ({
            id: model.remoteId,
            name: model.displayName || undefined,
            maxContextSize: model.maxContextSize,
            capabilities: model.capabilities,
            supportEfforts: model.supportEfforts,
          })), [catalogModels, draft.models]);

  const updateModel = (index: number, patch: Partial<ProviderModelDraft>) => {
    onChange({
      ...draft,
      models: draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model),
    });
  };

  const probe = async () => {
    setProbing(true);
    setProbeFeedback(null);
    try {
      if (refreshProviderId !== undefined) {
        const result = await client.refreshProvider(refreshProviderId);
        const failure = result.failed.find((entry) => entry.provider === refreshProviderId);
        if (failure !== undefined) throw new Error(failure.reason);
        const change = result.changed.find((entry) => entry.provider_id === refreshProviderId);
        const unchanged = result.unchanged.includes(refreshProviderId);
        if (change === undefined && !unchanged) {
          setProbeFeedback({ tone: 'error', text: t('st.fetchModels.serverUnsupported') });
          return;
        }
        await onRefreshed?.();
        setProbeFeedback({
          tone: 'success',
          text: change === undefined
            ? t('st.fetchModels.serverUnchanged')
            : change.added === 0 && change.removed === 0
              ? t('st.fetchModels.serverUpdated')
              : t('st.fetchModels.serverChanged', {
                  added: change.added,
                  removed: change.removed,
                }),
        });
        return;
      }
      const models = await fetchRemoteModels({ type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      onChange({
        ...draft,
        models,
        defaultModel: models.some((model) => model.remoteId === draft.defaultModel)
          ? draft.defaultModel
          : (models[0]?.remoteId ?? ''),
      });
      setProbeFeedback({ tone: 'success', text: t('st.fetchModels.success', { count: models.length }) });
    } catch (error) {
      // A failed fetch surfaces as a bare TypeError ("Failed to fetch") —
      // unreachable host or a desktop CSP block; give it readable copy.
      setProbeFeedback({
        tone: 'error',
        text:
          error instanceof TypeError
            ? t('st.fetchModels.networkError')
            : errorText(locale, error),
      });
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] font-medium text-ink-soft">{t('st.providers.idLabel')}
          <input
            className={`${INPUT} mt-1 disabled:cursor-not-allowed disabled:opacity-60`}
            value={draft.id}
            disabled={managed || idLocked}
            onChange={(event) => { onChange({ ...draft, id: event.target.value }); }}
          />
        </label>
        <label className="text-[11px] font-medium text-ink-soft">{t('st.providers.protocol')}
          <select
            className={`${INPUT} mt-1 disabled:cursor-not-allowed disabled:opacity-60`}
            value={draft.type}
            disabled={managed}
            onChange={(event) => { onChange({ ...draft, type: event.target.value as ProviderDraft['type'] }); }}
          >
            {PROVIDER_WIRE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-[11px] font-medium text-ink-soft">{t('st.providers.baseUrl')}
        <input className={`${INPUT} mt-1`} value={draft.baseUrl} onChange={(event) => { onChange({ ...draft, baseUrl: event.target.value }); }} placeholder="https://api.example.com/v1" />
      </label>
      <RequestIdentityLayerEditor
        value={draft}
        onChange={(identity) => { onChange({ ...draft, ...identity }); }}
        label={t('st.providers.requestIdentity')}
        inheritLabel={t('st.requestIdentity.inheritGlobal')}
        hint={t('st.providers.requestIdentityHint')}
      />
      <ImagePolicyEditor
        value={draft}
        onChange={(images) => { onChange({ ...draft, ...images }); }}
        inheritLabel={t('st.images.inheritBuiltin')}
      />
      {managed ? (
        <Hint>{t('st.providers.managedHint')}</Hint>
      ) : (
        <div>
          <label className="block text-[11px] font-medium text-ink-soft">{t('st.providers.apiKey')}
            <input
              type="password"
              autoComplete="new-password"
              className={`${INPUT} mt-1`}
              value={draft.apiKey}
              disabled={draft.clearApiKey}
              onChange={(event) => { onChange({ ...draft, apiKey: event.target.value }); }}
              placeholder={hasStoredKey ? t('st.providers.keyStored') : t('st.providers.keyNew')}
            />
          </label>
          <Hint>{t('st.providers.keyHint')}</Hint>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={SECONDARY_BUTTON} disabled={probing} onClick={() => void probe()}>
          {probing ? t('st.fetchModels.working') : t('st.fetchModels.button')}
        </button>
        <div className="min-w-0 flex-1"><FeedbackLine feedback={probeFeedback} /></div>
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-ink-soft">{t('st.providers.models')}</p>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { onChange({ ...draft, models: [...draft.models, blankModel()] }); }}>{t('st.providers.addModel')}</button>
        </div>
        {draft.models.map((model, index) => (
          <ModelDraftRow
            key={model.id || `new-${index}`}
            model={model}
            index={index}
            isDefault={
              model.remoteId !== ''
              && (model.id === draft.defaultModel || model.remoteId === draft.defaultModel)
            }
            canRemove={draft.models.length > 1}
            catalogModels={availableCatalogModels}
            onChange={(patch) => { updateModel(index, patch); }}
            onRemove={() => {
              const models = draft.models.filter((_, modelIndex) => modelIndex !== index);
              onChange({
                ...draft,
                models,
                defaultModel:
                  model.id === draft.defaultModel || model.remoteId === draft.defaultModel
                    ? (models[0]?.id ?? models[0]?.remoteId ?? '')
                    : draft.defaultModel,
              });
            }}
            onSetDefault={() => { onChange({ ...draft, defaultModel: model.id || model.remoteId }); }}
          />
        ))}
      </div>
    </div>
  );
}

// ---- editor for a configured provider ----

export function ProviderEditor({
  provider,
  models,
  managed = false,
  onSaved,
}: {
  provider: ProviderCatalogItem;
  models: readonly ModelCatalogItem[];
  /** OAuth-managed providers keep the editable fields but no credential surface. */
  managed?: boolean;
  onSaved: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const initial = useMemo(() => providerDraftFromCatalog(provider, models), [provider, models]);
  const [draft, setDraft] = useState(initial);
  const [directoryModels, setDirectoryModels] = useState<readonly CatalogModelItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirming, setConfirming] = useState<'remove' | 'clearKey' | null>(null);
  const [revisions, setRevisions] = useState<{
    provider: string;
    models: ReadonlyMap<string, string>;
  } | null>(null);
  const catalogModels = useMemo(() => {
    const choices = new Map<string, ProviderModelCatalogChoice>();
    for (const model of models) {
      if (model.provider_id === provider.id) choices.set(model.remote_id, configuredCatalogChoice(model));
    }
    for (const model of directoryModels) choices.set(model.id, directoryCatalogChoice(model));
    return [...choices.values()];
  }, [directoryModels, models, provider.id]);

  useEffect(() => { setDraft(initial); }, [initial]);
  useEffect(() => {
    let current = true;
    setDirectoryModels([]);
    void client.getCatalogProvider(provider.id).then((catalogProvider) => {
      if (current) setDirectoryModels(catalogProvider.models);
    }).catch(() => {
      if (current) setDirectoryModels([]);
    });
    return () => { current = false; };
  }, [provider.id]);
  useEffect(() => {
    let current = true;
    setRevisions(null);
    void Promise.all([
      client.getProviderEntity(provider.id),
      Promise.all((initial?.models ?? []).filter((model) => model.id !== '').map(
        async (model) => [model.id, (await client.getModel(model.id)).revision] as const,
      )),
    ]).then(([providerEntity, modelEntries]) => {
      if (current) setRevisions({ provider: providerEntity.revision, models: new Map(modelEntries) });
    }).catch((error: unknown) => {
      if (current) setFeedback({ tone: 'error', text: errorText(locale, error) });
    });
    return () => { current = false; };
  }, [initial, provider.id]);

  const dirty = draft !== null && initial !== null && isProviderDraftDirty(draft, initial);
  useDirtyReporter(`provider:${provider.id}`, dirty);

  if (draft === null) {
    return (
      <div className="rounded-xl border border-hairline bg-paper p-3">
        <p className="text-[13px] font-semibold text-ink">{provider.id}</p>
        <Hint>{t('st.providers.cannotRewrite')}</Hint>
      </div>
    );
  }

  const save = async (override?: Partial<ProviderDraft>) => {
    const next = { ...draft, ...override };
    const validation = validateProviderDraft(next);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
      return;
    }
    if (revisions === null) return;
    setSaving(true);
    setFeedback(null);
    let mutationSucceeded = false;
    try {
      let normalized = next;
      const revisionMap = new Map(revisions.models);
      for (const [index, row] of next.models.entries()) {
        if (row.id !== '') continue;
        const created = await client.createModel(modelCreateBody(provider.id, row));
        mutationSucceeded = true;
        revisionMap.set(created.id, created.revision);
        normalized = {
          ...normalized,
          models: normalized.models.map((candidate, candidateIndex) =>
            candidateIndex === index ? { ...candidate, id: created.id } : candidate),
        };
        setDraft(normalized);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      for (const row of normalized.models) {
        const baseline = initial!.models.find((model) => model.id === row.id);
        if (baseline === undefined) continue;
        const rowPatch = modelPatchBody(row, baseline);
        if (rowPatch === null) continue;
        const baseRevision = revisionMap.get(row.id);
        if (baseRevision === undefined) throw new Error(`Missing revision for model ${row.id}`);
        const updated = await client.updateModel(row.id, {
          ...rowPatch,
          base_revision: baseRevision,
        });
        mutationSucceeded = true;
        revisionMap.set(row.id, updated.revision);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      for (const row of initial!.models) {
        const kept = normalized.models.some((model) => model.id === row.id);
        if (kept || row.id === '') continue;
        const baseRevision = revisionMap.get(row.id);
        if (baseRevision === undefined) throw new Error(`Missing revision for model ${row.id}`);
        await client.deleteModel(row.id, { baseRevision });
        mutationSucceeded = true;
        revisionMap.delete(row.id);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      const connectionPatch = providerPatchBody(normalized, initial!);
      if (connectionPatch !== null) {
        const updatedProvider = await client.updateProvider(provider.id, {
          ...connectionPatch,
          base_revision: revisions.provider,
        });
        mutationSucceeded = true;
        setRevisions({ provider: updatedProvider.revision, models: revisionMap });
      }
      setDraft({ ...normalized, apiKey: '', clearApiKey: false });
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.providers.savedEcho', { id: provider.id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      if (mutationSucceeded) await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await client.deleteProviderEntity(provider.id);
      await onSaved();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      setSaving(false);
    }
  };

  const statusDot =
    provider.status === 'connected' ? 'bg-success'
      : provider.status === 'error' ? 'bg-danger'
        : 'bg-amber-rule';

  const requestIdentitySummary = provider.request_identity === undefined
    ? 'inherit'
    : (provider.request_identity.preset ?? 'custom_overrides');
  const requestIdentityFull = requestIdentitySummary === 'inherit'
    ? t('st.requestIdentity.inheritGlobal')
    : t(`st.requestIdentity.option.${requestIdentitySummary}`);

  return (
    <details className="rounded-xl border border-hairline bg-paper p-3">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[13px] font-semibold text-ink">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
        {provider.id}
        <span className="rounded-full border border-hairline bg-panel px-1.5 py-px font-mono text-[9.5px] font-normal text-ink-faint">{provider.type}</span>
        <span
          title={`${t('st.providers.requestIdentity')}: ${requestIdentityFull}`}
          className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] font-normal text-ink-faint"
        >
          {t(`st.providers.requestIdentityBadge.${requestIdentitySummary}`)}
        </span>
        {provider.default_model !== undefined ? (
          <span className="truncate font-mono text-[10px] font-normal text-ink-faint">{provider.default_model}</span>
        ) : null}
        {provider.has_api_key ? (
          <span className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] font-normal text-ink-faint">{t('st.providers.keyBadge')}</span>
        ) : null}
        {dirty ? (
          <span className="rounded-full border border-amber-rule/60 bg-amber-card px-1.5 py-px text-[9.5px] font-medium text-amber-ink">{t('st.dirty.badge')}</span>
        ) : null}
      </summary>
      <div className="mt-4 space-y-4">
        <ProviderFields
          draft={draft}
          onChange={setDraft}
          hasStoredKey={provider.has_api_key}
          managed={managed}
          idLocked
          refreshProviderId={provider.id}
          catalogModels={catalogModels}
          onRefreshed={onSaved}
        />
        {/* OAuth-managed providers keep the save button for the editable
            fields; the credential clear/delete danger zone stays hidden. */}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving || revisions === null || !dirty} onClick={() => void save()}>
            {saving ? t('common.saving') : t('st.providers.save')}
          </button>
          {dirty ? <span className="text-[10.5px] font-medium text-amber-ink">{t('st.dirty.badge')}</span> : null}
        </div>
        {managed ? null : (
          <div className="rounded-lg border border-danger/25 bg-danger/[0.03] p-3">
            <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-danger">{t('st.danger.title')}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={DANGER_GHOST_BUTTON}
                disabled={saving || !provider.has_api_key}
                onClick={() => { setConfirming('clearKey'); }}
              >
                {t('st.danger.clearKey')}
              </button>
              <button
                type="button"
                className={DANGER_GHOST_BUTTON}
                disabled={saving}
                onClick={() => { setConfirming('remove'); }}
              >
                {t('st.danger.removeProvider')}
              </button>
            </div>
          </div>
        )}
        <FeedbackLine feedback={feedback} />
      </div>
      <ConfirmDialog
        open={confirming === 'remove'}
        title={t('st.confirm.removeTitle', { id: provider.id })}
        body={t('st.confirm.removeBody')}
        consequences={[t('st.confirm.removeC1', { id: provider.id }), t('st.confirm.removeC2')]}
        confirmLabel={t('st.confirm.removeAction')}
        busy={saving}
        onConfirm={() => { setConfirming(null); void remove(); }}
        onCancel={() => { setConfirming(null); }}
      />
      <ConfirmDialog
        open={confirming === 'clearKey'}
        title={t('st.confirm.clearKeyTitle')}
        body={t('st.confirm.clearKeyBody', { id: provider.id })}
        confirmLabel={t('st.confirm.clearKeyAction')}
        busy={saving}
        onConfirm={() => { setConfirming(null); void save({ clearApiKey: true, apiKey: '' }); }}
        onCancel={() => { setConfirming(null); }}
      />
    </details>
  );
}

// ---- new-provider template wizard ----

export function NewProviderWizard({
  onSaved,
}: {
  onSaved: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const blank = useMemo(blankProviderDraft, []);
  const [step, setStep] = useState<'template' | 'form'>('template');
  const [draft, setDraft] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const dirty = step === 'form' && isProviderDraftDirty(draft, blank);
  useDirtyReporter('new-provider', dirty);

  const chooseTemplate = (template: ProviderTemplate | null) => {
    setDraft({
      ...blank,
      type: template?.type ?? 'openai',
      baseUrl: template?.baseUrl ?? '',
      id: template?.type ?? '',
    });
    setFeedback(null);
    setStep('form');
  };

  const save = async () => {
    const normalized = {
      ...draft,
      defaultModel:
        draft.defaultModel
        || (draft.models[0]?.id ?? draft.models[0]?.remoteId ?? ''),
    };
    const validation = validateNewProviderDraft(normalized);
    if (validation !== null) {
      setFeedback({ tone: 'error', text: issueText(locale, validation) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const created = await client.createProvider(providerCreateBody(normalized));
      setDraft(blank);
      setStep('template');
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.providers.createdEcho', { id: created.id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  if (step === 'template') {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {PROVIDER_TEMPLATES.map((template) => (
            <button
              key={template.type}
              type="button"
              onClick={() => { chooseTemplate(template); }}
              className="rounded-xl border border-hairline bg-paper p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
            >
              <span className="block text-[13px] font-semibold text-ink">{template.label}</span>
              <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint">{template.baseUrl}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => { chooseTemplate(null); }}
            className="rounded-xl border border-dashed border-hairline bg-paper p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
          >
            <span className="block text-[13px] font-semibold text-ink">{t('st.wizard.manual')}</span>
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint">{t('st.wizard.manualHint')}</span>
          </button>
        </div>
        <Hint>{t('st.wizard.chooseTemplate')}</Hint>
        <FeedbackLine feedback={feedback} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => { setDraft(blank); setFeedback(null); setStep('template'); }}
        className="text-[11.5px] font-medium text-accent transition-colors hover:text-accent-deep"
      >
        {t('st.wizard.back')}
      </button>
      <ProviderFields draft={draft} onChange={setDraft} hasStoredKey={false} />
      <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>
        {saving ? t('st.providers.creating') : t('st.providers.create')}
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

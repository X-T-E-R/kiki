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

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  CatalogModelItem,
  DiscoveredModel,
  GenerationParametersWire,
  GenerationParametersPatch,
  GetModelResponse,
  GetProviderResponse,
  ListProviderHealthResponse,
  ModelCatalogItem,
  ProviderCatalogItem,
  ProviderConnectionTestResult,
} from '@kiki/protocol';
import type { OAuthMethodStatus } from '@kiki/klient';

import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  humanizeMs,
  isProviderDraftDirty,
  KNOWN_CAPABILITIES,
  KNOWN_EFFORTS,
  KNOWN_IMAGE_MIME_TYPES,
  MS_UNIT_FACTORS,
  msUnitFor,
  modelCreateBody,
  modelPatchBody,
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
} from '@kiki/session-core/settings';
import { formatTokens } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { DisclosureChevron, Icon } from './icons';
import { useConnection } from '../state/connection';
import { ChipSelect } from './ChipSelect';
import { ConfirmDialog } from './ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from './controls';
import { useDirtyReporter } from './dirtyGuard';
import { RequestIdentityLayerEditor } from './RequestIdentityLayerEditor';
import { ConnectionMethodPicker } from './ConnectionMethodPicker';
import {
  API_PROTOCOLS,
  baseUrlRequired,
  connectionFieldIssue,
  draftForPreset,
  hostLabel,
  isLocalBaseUrl,
  PROTOCOL_ORDER,
  protocolLabel,
  vendorLabelFor,
  withBaseUrl,
  type ConnectionFieldIssue,
  type ConnectionKind,
  type ProviderPreset,
} from './providerPresets';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';
import { FieldIssue, FORM_LABEL, FORM_SELECT_TRIGGER, SettingsSelect } from './settings/SettingsPrimitives';
import { SecretField, type SecretDraft } from './settings/SecretField';
import { ProviderConnectionExtras } from './settings/ProviderConnectionExtras';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from './ui';

/**
 * Where a model-picker option came from. `configured` is a stored model entity
 * the server can already use; `discovered` is a provider list an explicit fetch
 * brought back; `directory` is the local models.dev directory; `draft` is a row
 * this form already holds. Only `configured` options are configured models —
 * every other source is a suggestion that becomes a model on the next save.
 */
type ProviderModelChoiceSource = 'configured' | 'discovered' | 'directory' | 'draft';

interface ProviderModelCatalogChoice {
  /**
   * The exact model name sent upstream. A local alias (`ProviderModelDraft.id`)
   * is never derived from it, and picking an option never clears the alias of
   * an existing row.
   */
  readonly remoteId: string;
  readonly name?: string;
  /** `0` means the source reports no context size for this model. */
  readonly maxContextSize: number;
  readonly capabilities: readonly string[];
  readonly supportEfforts: readonly string[];
  readonly source: ProviderModelChoiceSource;
}

function configuredCatalogChoice(model: ModelCatalogItem): ProviderModelCatalogChoice {
  return {
    remoteId: model.remote_id,
    name: model.display_name,
    maxContextSize: model.max_context_size,
    capabilities: model.capabilities ?? [],
    supportEfforts: model.support_efforts ?? [],
    source: 'configured',
  };
}

function directoryCatalogChoice(model: CatalogModelItem): ProviderModelCatalogChoice {
  return {
    remoteId: model.id,
    name: model.name,
    maxContextSize: model.max_context_size,
    capabilities: model.capabilities ?? [],
    supportEfforts: model.support_efforts ?? [],
    source: 'directory',
  };
}

function discoveredCatalogChoice(model: DiscoveredModel): ProviderModelCatalogChoice {
  return {
    remoteId: model.remote_id,
    name: model.display_name,
    maxContextSize: model.max_context_size ?? 0,
    capabilities: model.capabilities ?? [],
    supportEfforts: model.support_efforts ?? [],
    source: 'discovered',
  };
}

function draftCatalogChoice(model: ProviderModelDraft): ProviderModelCatalogChoice {
  return {
    remoteId: model.remoteId,
    name: model.displayName === '' ? undefined : model.displayName,
    maxContextSize: model.maxContextSize,
    capabilities: model.capabilities,
    supportEfforts: model.supportEfforts,
    source: 'draft',
  };
}

/**
 * Merge option sources by remote id. The first source owns the entry (its
 * provenance and its metadata); later sources only fill fields the winner left
 * empty, so a configured model is never relabelled as a suggestion and a
 * provider's bare model list still benefits from directory metadata.
 */
export function mergeModelCatalogChoices(
  ...sources: readonly (readonly ProviderModelCatalogChoice[])[]
): ProviderModelCatalogChoice[] {
  const merged = new Map<string, ProviderModelCatalogChoice>();
  for (const source of sources) {
    for (const choice of source) {
      const existing = merged.get(choice.remoteId);
      merged.set(
        choice.remoteId,
        existing === undefined
          ? choice
          : {
              ...existing,
              name: existing.name ?? choice.name,
              maxContextSize:
                existing.maxContextSize > 0 ? existing.maxContextSize : choice.maxContextSize,
              capabilities:
                existing.capabilities.length > 0 ? existing.capabilities : choice.capabilities,
              supportEfforts:
                existing.supportEfforts.length > 0 ? existing.supportEfforts : choice.supportEfforts,
            },
      );
    }
  }
  return [...merged.values()];
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
    maxContextSize: 250000,
    displayName: '',
    capabilities: ['thinking', 'tool_use'],
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
      {/* Unit switch: the same raised-paper segmented look as the settings
          pickers, instead of a native select that ignores the theme. */}
      <div role="group" aria-label={t('st.stepper.unitAria')} data-context-unit
        className="ml-1 inline-flex items-center gap-0.5 rounded-md bg-ink/[0.04] p-0.5">
        {CONTEXT_UNITS.map((candidate) => {
          const selected = candidate.id === unit;
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              data-context-unit-choice={candidate.id}
              onClick={() => { setUnit(candidate.id); }}
              className={`h-6 min-w-7 rounded-[5px] px-1.5 font-mono text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:h-9 ${
                selected ? 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>
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
        <SettingsSelect<MsUnit>
          variant="form"
          className="w-auto"
          dataAttr="data-ms-unit"
          ariaLabel={ariaLabel}
          disabled={disabled}
          value={unit}
          onChange={setUnit}
          choices={MS_UNITS.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
        />
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">= {t(`st.unit.${humanized.unit}`, { n: humanized.value })}</p>
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
      <p className="text-[12px] font-medium text-ink-soft">
        {t('st.images.title')}
      </p>
      <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
        <span className="text-[11px] font-medium text-ink-soft">
          {t('st.images.acceptedTypes')}
        </span>
        <SettingsSelect<'inherit' | 'custom'>
          variant="form"
          dataAttr="data-image-accepted-mode"
          ariaLabel={t('st.images.acceptedTypesModeAria')}
          value={acceptedMode}
          onChange={(next) => {
            onChange({
              ...value,
              imageAcceptedTypes: next === 'inherit' ? null : [...KNOWN_IMAGE_MIME_TYPES],
            });
          }}
          choices={[
            { value: 'inherit', label: inheritLabel },
            { value: 'custom', label: t('st.images.custom') },
          ]}
        />
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
        <span className="text-[11px] font-medium text-ink-soft">
          {t('st.images.convertUnsupported')}
        </span>
        <SettingsSelect
          variant="form"
          dataAttr="data-image-conversion"
          ariaLabel={t('st.images.convertUnsupportedAria')}
          value={value.imageConvertUnsupported ?? ''}
          onChange={(next) => {
            onChange({
              ...value,
              imageConvertUnsupported: next === ''
                ? null
                : next as NonNullable<ImagePolicyDraft['imageConvertUnsupported']>,
            });
          }}
          choices={[
            { value: '', label: inheritLabel },
            ...(['off', 'auto', 'png', 'jpeg'] as const).map((mode) => ({ value: mode, label: t(`st.images.convert.${mode}`) })),
          ]}
        />
      </div>
    </div>
  );
}

// ---- progressive disclosure ----

/**
 * "Advanced" disclosure for rarely touched fields. The body stays mounted
 * (only `hidden` toggles), so drafts, dirty flags and field ids survive a
 * collapse and a search hit can still reach a field inside it.
 */
export function AdvancedDisclosure({
  id,
  summary,
  children,
  defaultOpen = false,
}: {
  id: string;
  /** Short list of what is inside, e.g. "Capabilities · image policy". */
  summary?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-advanced={id} data-open={open ? 'true' : undefined} className="border-t border-hairline pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`advanced-${id}`}
        onClick={() => { setOpen((value) => !value); }}
        className="-ml-1 flex min-h-7 w-full items-center gap-1.5 rounded-md px-1 text-left outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <DisclosureChevron open={open} className="text-ink-soft" />
        <span className="text-[12px] font-medium text-ink-soft">{t('st.advanced.disclosure')}</span>
        {summary !== undefined && !open ? (
          <span className="min-w-0 truncate text-[12px] text-ink-faint">{summary}</span>
        ) : null}
      </button>
      <div id={`advanced-${id}`} hidden={!open} className="space-y-4 pt-3">
        {children}
      </div>
    </div>
  );
}

/** Capabilities that change what the user can do with a model, in reading order. */
const CAPABILITY_MARKS = [
  { capability: 'thinking', key: 'st.models.capReasoning' },
  { capability: 'image_in', key: 'st.models.capVision' },
  { capability: 'tool_use', key: 'st.models.capTools' },
] as const;

/**
 * At most three quiet words for what a model can do — reasoning, vision,
 * tools — instead of a tag per capability. Everything else stays in the
 * model's advanced overrides.
 */
export function CapabilityMarks({ capabilities }: { capabilities: readonly string[] | undefined }) {
  const { t } = useI18n();
  const present = CAPABILITY_MARKS.filter((mark) =>
    capabilities?.includes(mark.capability) === true
    || (mark.capability === 'thinking' && capabilities?.includes('always_thinking') === true));
  if (present.length === 0) return null;
  return (
    <span data-capability-marks className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-faint">
      {present.map((mark, index) => (
        <span key={mark.capability} data-capability={mark.capability}>
          {index > 0 ? <span aria-hidden className="mr-1.5">·</span> : null}
          {t(mark.key)}
        </span>
      ))}
    </span>
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
  onSaved,
}: {
  model: ProviderModelDraft;
  index: number;
  isDefault: boolean;
  canRemove: boolean;
  catalogModels: readonly ProviderModelCatalogChoice[];
  onChange: (patch: Partial<ProviderModelDraft>) => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onSaved?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(model.remoteId === '');
  const n = index + 1;
  const requestIdentitySummary = model.requestIdentityChoice === 'inherit'
    ? 'inherit'
    : model.requestIdentityChoice;
  const rowLabel = model.id || model.remoteId;
  const selectedChoice = catalogModels.find((candidate) => candidate.remoteId === model.remoteId);
  // A row without a stored alias does not exist on the server yet, so a
  // suggestion picked here is configured only by the next save.
  const selectedIsSuggestion = model.remoteId !== ''
    && model.id === ''
    && (selectedChoice?.source === 'discovered' || selectedChoice?.source === 'directory');
  const catalogOptions = useMemo<readonly SearchableSelectOption[]>(() =>
    catalogModels.map((candidate) => ({
      value: candidate.remoteId,
      label: candidate.remoteId,
      description: candidate.name,
      keywords: candidate.name,
      group: candidate.source === 'configured'
        ? t('st.providers.catalogGroupConfigured')
        : candidate.source === 'draft'
          ? t('st.providers.catalogGroupDraft')
          : t('st.providers.catalogGroupSuggested'),
      badges: [
        ...(candidate.source === 'directory' || candidate.source === 'discovered'
          ? [{
              label: candidate.source === 'discovered'
                ? t('st.providers.catalogFromProvider')
                : t('st.providers.catalogFromDirectory'),
              accent: true,
            }]
          : []),
        ...(candidate.maxContextSize > 0 ? [{ label: formatTokens(candidate.maxContextSize) }] : []),
        ...candidate.capabilities.slice(0, 2).map((capability) => ({ label: capability })),
        ...(candidate.supportEfforts.length > 0
          ? [{ label: t('st.providers.catalogEfforts', { count: candidate.supportEfforts.length }) }]
          : []),
      ],
    })), [catalogModels, t]);
  const selectModelId = (remoteId: string) => {
    const catalogModel = catalogModels.find((candidate) => candidate.remoteId === remoteId);
    if (catalogModel === undefined) {
      onChange({ remoteId });
      return;
    }
    onChange({
      remoteId,
      displayName: catalogModel.name ?? '',
      maxContextSize: catalogModel.maxContextSize > 0 ? catalogModel.maxContextSize : model.maxContextSize,
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
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            isDefault ? 'text-ink' : 'text-ink-faint hover:text-ink'
          }`}
        >
          <Icon name={isDefault ? 'starFilled' : 'star'} />
        </button>
        <button
          type="button"
          aria-label={t('st.providers.modelExpandAria', { n })}
          aria-expanded={open}
          onClick={() => { setOpen((value) => !value); }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {/* Name in the reading font; the wire id stays mono but quiet. */}
          <span className={`truncate text-[13px] ${model.remoteId === '' ? 'text-ink-faint' : 'font-medium text-ink'}`}>
            {model.remoteId === '' ? 'model-id' : model.displayName || model.remoteId}
          </span>
          {model.remoteId !== '' ? (() => {
            const ids = [
              ...((model.displayName || model.remoteId) !== model.remoteId ? [model.remoteId] : []),
              ...(model.id !== '' && model.id !== model.remoteId ? [model.id] : []),
            ];
            return ids.length > 0 ? (
              <span className="hidden min-w-0 shrink truncate font-mono text-[11px] text-ink-faint sm:inline">
                {ids.join(' · ')}
              </span>
            ) : null;
          })() : null}
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{formatTokens(model.maxContextSize)}</span>
          <span className="hidden sm:inline-flex"><CapabilityMarks capabilities={model.capabilities} /></span>
          {requestIdentitySummary !== 'inherit' ? (
            <span className="hidden shrink-0 text-[11px] text-ink-faint sm:inline">
              {t(`st.providers.requestIdentityBadge.${requestIdentitySummary}`)}
            </span>
          ) : null}
          <DisclosureChevron open={open} className="ml-auto text-ink-faint" />
        </button>
        <button
          type="button"
          disabled={!canRemove}
          aria-label={t('st.providers.removeModel')}
          onClick={onRemove}
          className={`${SECONDARY_BUTTON} shrink-0 px-2 text-danger`}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {open ? (
        <div className="mt-3 space-y-2.5 border-t border-hairline pt-3">
          {model.id !== '' ? (
            <p className="truncate font-mono text-[11px] text-ink-faint">{model.id}</p>
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
              {selectedIsSuggestion ? (
                <p data-model-suggestion className="text-[11px] font-medium text-accent-ink">
                  {t('st.providers.catalogSuggestionNote')}
                </p>
              ) : null}
            </div>
            <input
              className={INPUT}
              aria-label={t('st.providers.modelNameAria', { n })}
              value={model.displayName}
              onChange={(event) => { onChange({ displayName: event.target.value }); }}
              placeholder={t('st.providers.displayNamePlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <p className={FORM_LABEL}>{t('st.compact.windowLabel')}</p>
            <ContextStepper
              value={model.maxContextSize}
              onChange={(maxContextSize) => { onChange({ maxContextSize }); }}
              ariaLabel={t('st.providers.modelContextAria', { n })}
            />
          </div>
          <div className="space-y-1">
            <p className={FORM_LABEL}>{t('st.chips.efforts')}</p>
            <ChipSelect
              values={model.supportEfforts}
              knownOptions={KNOWN_EFFORTS}
              onChange={(supportEfforts) => { onChange({ supportEfforts }); }}
              ariaLabel={t('st.providers.modelEffortsAria', { n })}
              addPlaceholder={t('st.chips.addPlaceholder')}
              removeLabel={(value) => t('st.chips.removeAria', { value })}
            />
          </div>
          <AdvancedDisclosure id={`draft-model-${index}`} summary={t('st.models.draftAdvancedSummary')}>
            <div className="space-y-1">
              <p className={FORM_LABEL}>{t('st.chips.capabilities')}</p>
              <ChipSelect
                values={model.capabilities}
                knownOptions={KNOWN_CAPABILITIES}
                onChange={(capabilities) => { onChange({ capabilities }); }}
                ariaLabel={t('st.providers.modelCapsAria', { n })}
                addPlaceholder={t('st.chips.addPlaceholder')}
                removeLabel={(value) => t('st.chips.removeAria', { value })}
              />
            </div>
            <ImagePolicyEditor
              value={model}
              onChange={(images) => { onChange(images); }}
              inheritLabel={t('st.images.inheritProvider')}
            />
            {model.id !== '' ? <SavedGenerationParametersEditor scope="model" id={model.id} onSaved={onSaved} /> : null}
            <RequestIdentityLayerEditor
              value={model}
              onChange={(identity) => { onChange(identity); }}
              label={t('st.models.requestIdentity')}
              inheritLabel={t('st.requestIdentity.inheritProvider')}
              hint={t('st.models.requestIdentityHint')}
            />
          </AdvancedDisclosure>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The provider draft keeps its wire shape (`apiKey` + `clearApiKey`, with the
 * stored key never in the baseline); these two map it onto the shared secret
 * field's keep / set / clear draft.
 */
function providerSecretDraft(draft: ProviderDraft, baselineApiKey: string, editing: boolean): SecretDraft {
  if (draft.clearApiKey) return { mode: 'clear' };
  return draft.apiKey === baselineApiKey && !editing ? { mode: 'keep' } : { mode: 'set', value: draft.apiKey };
}

function withProviderSecret(draft: ProviderDraft, next: SecretDraft, baselineApiKey: string): ProviderDraft {
  if (next.mode === 'clear') return { ...draft, apiKey: baselineApiKey, clearApiKey: true };
  return { ...draft, apiKey: next.mode === 'set' ? next.value : baselineApiKey, clearApiKey: false };
}

// ---- shared field set (wizard + editor) ----

export function ProviderFields({
  draft,
  onChange,
  hasStoredKey,
  baselineApiKey = '',
  apiKeyEnv,
  managed = false,
  idLocked = false,
  refreshProviderId,
  baselineBaseUrl,
  baselineType,
  catalogModels = [],
  onRefreshed,
  fieldIssue = null,
  advancedExtra,
  revealKey,
}: {
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  hasStoredKey: boolean;
  baselineApiKey?: string;
  apiKeyEnv?: string;
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
  /**
   * The saved connection target. A server-side probe always runs against the
   * stored address and protocol, so a draft key may only be sent while both
   * still match the values this form holds.
   */
  baselineBaseUrl?: string;
  baselineType?: ProviderDraft['type'];
  /**
   * Model-picker options. A saved provider passes its configured models plus
   * the local directory and any fetched suggestions (see
   * `mergeModelCatalogChoices`); the unsaved wizard passes none and the picker
   * falls back to the rows this form already holds.
   */
  catalogModels?: readonly ProviderModelCatalogChoice[];
  onRefreshed?: () => Promise<void>;
  /** New connections only: the field-level problem the last create attempt found. */
  fieldIssue?: ConnectionFieldIssue | null;
  /** Saved connections add their request defaults to the advanced block. */
  advancedExtra?: React.ReactNode;
  /** Fetches the effective key (saved or environment) on explicit request. */
  revealKey?: () => Promise<string | undefined>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const idIssue = fieldIssue?.field === 'id' ? issueText(locale, fieldIssue.issue) : null;
  const baseUrlIssue = fieldIssue?.field === 'baseUrl' ? issueText(locale, fieldIssue.issue) : null;
  const [probing, setProbing] = useState(false);
  const [probeFeedback, setProbeFeedback] = useState<Feedback>(null);
  // Listings never carry the key, so "editing an empty value" is local state.
  const [keyEditing, setKeyEditing] = useState(false);
  useEffect(() => { setKeyEditing(false); }, [baselineApiKey, hasStoredKey, apiKeyEnv]);
  const queryClient = useQueryClient();
  const [localSuggestions, setLocalSuggestions] = useState<readonly ProviderModelCatalogChoice[]>([]);
  useEffect(() => { setLocalSuggestions([]); }, [draft.baseUrl, draft.apiKey, draft.type]);
  const availableCatalogModels = useMemo(() => mergeModelCatalogChoices(
    catalogModels,
    localSuggestions,
    draft.models.filter((model) => model.remoteId !== '').map(draftCatalogChoice),
  ), [catalogModels, localSuggestions, draft.models]);

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
        // The server-side probe always runs against the stored connection, so
        // an unsaved address or protocol would send a draft key to the old one.
        if ((baselineBaseUrl !== undefined && draft.baseUrl !== baselineBaseUrl)
          || (baselineType !== undefined && draft.type !== baselineType)) {
          setProbeFeedback({ tone: 'info', text: t('st.fetchModels.unsavedTarget') });
          return;
        }
        const draftKey = !draft.clearApiKey && draft.apiKey !== baselineApiKey && draft.apiKey !== ''
          ? draft.apiKey
          : undefined;
        const result = await client.refreshProvider(refreshProviderId, draftKey);
        await queryClient.invalidateQueries({ queryKey: ['discovered-models'] });
        const failure = result.failed.find((entry) => entry.provider === refreshProviderId);
        if (failure !== undefined) throw new Error(failure.reason);
        const change = result.changed.find((entry) => entry.provider_id === refreshProviderId);
        if (change !== undefined) {
          await onRefreshed?.();
          setProbeFeedback({ tone: 'success', text: t('st.fetchModels.serverChanged', { added: change.added, removed: change.removed }) });
          return;
        }
        const suggestions = result.discovered?.find((group) => group.provider_id === refreshProviderId);
        if (suggestions !== undefined) {
          setProbeFeedback({ tone: 'success', text: suggestions.models.length === 0
            ? t('st.fetchModels.noNewSuggestions')
            : t('st.fetchModels.suggestions', { count: suggestions.models.length }) });
          return;
        }
        setProbeFeedback(result.unchanged.includes(refreshProviderId)
          ? { tone: 'success', text: t('st.fetchModels.serverUnchanged') }
          : { tone: 'error', text: t('st.fetchModels.serverUnsupported') });
        return;
      }
      // Probe through the server: a browser-direct fetch from the desktop
      // WebView is blocked by CORS on most provider endpoints.
      const models = await client.probeProviderDraft({ type: draft.type, baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      setLocalSuggestions(models.map((model) => ({ ...draftCatalogChoice(model), source: 'discovered' })));
      setProbeFeedback({ tone: 'success', text: t('st.fetchModels.suggestions', { count: models.length }) });
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

  // A new connection chooses among the public protocols; a stored or preset
  // connection on another adapter keeps its own protocol in the list.
  const protocolChoices = (idLocked || managed ? PROTOCOL_ORDER : API_PROTOCOLS)
    .filter((type) => PROVIDER_WIRE_TYPES.includes(type));
  const protocols = protocolChoices.includes(draft.type) ? protocolChoices : [draft.type, ...protocolChoices];
  // The new-connection form keeps stable ids (focus-on-error targets them);
  // every stored editor on the page gets its own, so labels stay unique.
  const scope = useId();
  const baseUrlId = idLocked || managed ? `${scope}-base-url` : 'provider-field-base-url';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {/* A stored connection is named in its row header; its id is fixed. */}
        {idLocked || managed ? null : (
          <div className="min-w-0">
            <label htmlFor="provider-field-id" className={FORM_LABEL}>{t('st.providers.idLabel')}</label>
            <input
              id="provider-field-id"
              className={`${INPUT} mt-1 ${idIssue !== null ? 'border-danger/60' : ''}`}
              value={draft.id}
              aria-invalid={idIssue !== null || undefined}
              aria-describedby={idIssue !== null ? 'provider-field-id-issue' : undefined}
              placeholder="my-provider"
              onChange={(event) => { onChange({ ...draft, id: event.target.value }); }}
            />
            <FieldIssue id="provider-field-id-issue" text={idIssue} />
          </div>
        )}
        <div className="min-w-0">
          <span className={FORM_LABEL}>{t('st.providers.protocol')}</span>
          <div className="mt-1">
            <SearchableSelect
              id={idLocked || managed ? `${scope}-protocol` : 'provider-field-protocol'}
              ariaLabel={t('st.providers.protocol')}
              value={draft.type}
              disabled={managed}
              hideFilter
              options={protocols.map((type) => ({ value: type, label: protocolLabel(type), hint: type }))}
              onChange={(next) => { onChange({ ...draft, type: next as ProviderDraft['type'] }); }}
              buttonClassName={FORM_SELECT_TRIGGER}
            />
          </div>
        </div>
      </div>
      <div>
        <label htmlFor={baseUrlId} className={FORM_LABEL}>{t('st.providers.baseUrl')}</label>
        <input
          id={baseUrlId}
          className={`${INPUT} mt-1 ${baseUrlIssue !== null ? 'border-danger/60' : ''}`}
          value={draft.baseUrl}
          aria-invalid={baseUrlIssue !== null || undefined}
          aria-describedby={baseUrlIssue !== null ? 'provider-field-base-url-issue' : undefined}
          onChange={(event) => {
            // A new connection's id follows the address until the user names it.
            onChange(idLocked || managed ? { ...draft, baseUrl: event.target.value } : withBaseUrl(draft, event.target.value));
          }}
          placeholder="https://api.example.com/v1"
        />
        <FieldIssue id="provider-field-base-url-issue" text={baseUrlIssue} />
      </div>
      {managed ? (
        <Hint>{t('st.providers.managedHint')}</Hint>
      ) : (
        <div>
          <SecretField
            label={t('st.providers.apiKey')}
            source={apiKeyEnv !== undefined ? 'environment' : hasStoredKey ? 'kiki' : 'none'}
            envName={apiKeyEnv}
            draft={providerSecretDraft(draft, baselineApiKey, keyEditing)}
            onChange={(next) => {
              setKeyEditing(next.mode === 'set');
              onChange(withProviderSecret(draft, next, baselineApiKey));
            }}
            reveal={revealKey}
            placeholder={hasStoredKey || apiKeyEnv !== undefined ? undefined : t('st.providers.keyNew')}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3" data-connection-test>
        <button type="button" className={SECONDARY_BUTTON} disabled={probing} onClick={() => void probe()}>
          {probing ? t('st.fetchModels.working') : t('st.fetchModels.button')}
        </button>
        <div className="min-w-0 flex-1"><FeedbackLine feedback={probeFeedback} /></div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className={FORM_LABEL}>
            {t('st.providers.models')}
            <span className="ml-1.5 font-normal text-ink-faint">{draft.models.filter((model) => model.remoteId !== '').length}</span>
          </p>
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { onChange({ ...draft, models: [...draft.models, blankModel()] }); }}>{t('st.providers.addModel')}</button>
        </div>
        {idLocked ? (
          <div className="space-y-1">
            <span className={FORM_LABEL}>{t('st.models.providerDefault')}</span>
            <SettingsSelect
              variant="form"
              dataAttr="data-provider-default-model"
              ariaLabel={t('st.models.providerDefault')}
              value={draft.defaultModel}
              onChange={(defaultModel) => { onChange({ ...draft, defaultModel }); }}
              choices={[
                { value: '', label: t('st.auth.none') },
                ...(draft.defaultModel !== '' && !draft.models.some((model) => (model.id || model.remoteId) === draft.defaultModel)
                  ? [{ value: draft.defaultModel, label: draft.defaultModel }]
                  : []),
                ...draft.models.filter((model) => model.remoteId !== '').map((model) => ({
                  value: model.id || model.remoteId,
                  label: model.displayName || model.id || model.remoteId,
                  hint: model.displayName !== '' ? model.remoteId : undefined,
                })),
              ]}
            />
          </div>
        ) : null}
        {draft.models.map((model, index) => (
          <ModelDraftRow
            key={model.id || `new-${index}`}
            model={model}
            index={index}
            isDefault={
              model.remoteId !== ''
              && (model.id === draft.defaultModel || model.remoteId === draft.defaultModel)
            }
            canRemove
            catalogModels={availableCatalogModels}
            onChange={(patch) => { updateModel(index, patch); }}
            onRemove={() => {
              const models = draft.models.filter((_, modelIndex) => modelIndex !== index);
              const first = models[0];
              onChange({
                ...draft,
                models,
                defaultModel:
                  model.id === draft.defaultModel || model.remoteId === draft.defaultModel
                    ? (first === undefined ? '' : first.id || first.remoteId)
                    : draft.defaultModel,
              });
            }}
            onSetDefault={() => { onChange({ ...draft, defaultModel: model.id || model.remoteId }); }}
            onSaved={onRefreshed}
          />
        ))}
      </div>
      <AdvancedDisclosure id={`provider-${draft.id || 'new'}`} summary={t('st.providers.advancedSummary')}>
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
        {advancedExtra}
      </AdvancedDisclosure>
    </div>
  );
}

// ---- editor for a configured provider ----

/** Shared cache key for `GET /providers:health`; a test result is written back into it. */
export const PROVIDER_HEALTH_QUERY_KEY = ['provider-health'] as const;

type KnownQuota = Extract<OAuthMethodStatus['quota'], { state: 'known' }>;

/** "Premium interactions: 72% left" / "Chat: 1,240 left". Never called for an unknown quota. */
export function formatQuota(quota: KnownQuota, locale: string, t: ReturnType<typeof useI18n>['t']): string {
  const amount = quota.unit === 'percent'
    ? t('st.connections.quotaPercent', { n: Math.round(quota.remaining) })
    : t('st.connections.quotaCount', { n: quota.remaining.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') });
  return t('st.connections.quotaLine', { label: quota.label, amount });
}

/** A fix the person can act on, keyed by what the server reported (never its raw text). */
function connectionFixKey(result: ProviderConnectionTestResult | undefined) {
  if (result?.error_code === 'model_not_configured') return 'st.connections.fixNoModel' as const;
  const status = result?.http_status;
  if (status === 401 || status === 403) return 'st.connections.fixAuth' as const;
  if (status === 404) return 'st.connections.fixNotFound' as const;
  if (status === 429) return 'st.connections.fixRateLimit' as const;
  if (status !== undefined && status >= 500) return 'st.connections.fixServer' as const;
  if (result?.error_code === 'model_unavailable') return 'st.connections.fixModel' as const;
  return 'st.connections.errorFix' as const;
}

export function ProviderEditor({
  provider,
  models,
  managed = false,
  modelCount,
  onSaved,
  accountLabel,
  account,
  onSignOut,
  signingOut = false,
}: {
  provider: ProviderCatalogItem;
  models: readonly ModelCatalogItem[];
  /** OAuth-managed providers keep the editable fields but no credential surface. */
  managed?: boolean;
  /** Configured models on this connection, shown in the collapsed row. */
  modelCount?: number;
  onSaved: () => Promise<void>;
  /** Signed-in account name for an OAuth connection ("GitHub Copilot"). */
  accountLabel?: string;
  /** The sign-in method's account and quota facts; `unknown` parts are not shown. */
  account?: Pick<OAuthMethodStatus, 'signed_in' | 'account' | 'quota'>;
  /** OAuth connections sign out instead of clearing a key. */
  onSignOut?: () => void;
  signingOut?: boolean;
}) {
  const { t, locale, time } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const initial = useMemo(() => providerDraftFromCatalog(provider, models), [provider, models]);
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [readSnapshot, setReadSnapshot] = useState(initial);
  const [directoryModels, setDirectoryModels] = useState<readonly CatalogModelItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirming, setConfirming] = useState<'remove' | null>(null);
  const [revisions, setRevisions] = useState<{
    provider: string;
    models: ReadonlyMap<string, string>;
  } | null>(null);
  // The key is fetched only when the user asks to see or copy it; a new
  // revision makes the field drop any previously revealed copy.
  const revealKey = useCallback(
    async () => (await client.revealSecret({ kind: 'provider_api_key', provider_id: provider.id })).value,
    [client, provider.id, provider.has_api_key, provider.api_key_env, revisions?.provider],
  );
  const discovered = useQuery({ queryKey: ['discovered-models'], queryFn: () => client.listDiscoveredModels() });
  const healthQuery = useQuery({
    queryKey: PROVIDER_HEALTH_QUERY_KEY,
    queryFn: () => client.listProviderHealth(),
    enabled: typeof client.listProviderHealth === 'function',
    staleTime: 30_000,
    retry: false,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult>();
  const catalogModels = useMemo(() => mergeModelCatalogChoices(
    models.filter((model) => model.provider_id === provider.id).map(configuredCatalogChoice),
    (discovered.data?.items.find((group) => group.provider_id === provider.id)?.models ?? []).map(discoveredCatalogChoice),
    directoryModels.map(directoryCatalogChoice),
  ), [directoryModels, discovered.data, models, provider.id]);
  const dirty = draft !== null && baseline !== null && isProviderDraftDirty(draft, baseline);

  // A dirty editor keeps its baseline AND revisions, even when another writer
  // refreshes the shared catalog. New reads must not bless a stale draft.
  useEffect(() => {
    if (initial === readSnapshot || dirty || saving) return;
    setDraft(initial);
    setBaseline(initial);
    setReadSnapshot(initial);
  }, [initial, readSnapshot, dirty, saving]);
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
      Promise.all((readSnapshot?.models ?? []).filter((model) => model.id !== '').map(
        async (model) => [model.id, (await client.getModel(model.id)).revision] as const,
      )),
    ]).then(([providerEntity, modelEntries]) => {
      if (current) setRevisions({ provider: providerEntity.revision, models: new Map(modelEntries) });
    }).catch((error: unknown) => {
      if (current) setFeedback({ tone: 'error', text: errorText(locale, error) });
    });
    return () => { current = false; };
  }, [readSnapshot, provider.id]);

  useDirtyReporter(`provider:${provider.id}`, dirty);

  if (draft === null || baseline === null) {
    return (
      <div className="rounded-xl border border-hairline bg-paper p-3">
        <p className="text-[13px] font-semibold text-ink">{provider.id}</p>
        <Hint>{t('st.providers.cannotRewrite')}</Hint>
      </div>
    );
  }

  const save = async (override?: Partial<ProviderDraft>) => {
    const next = { ...draft, ...override };
    const validation = validateProviderDraft(next, baseline);
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
      let savedBaseline = baseline;
      const revisionMap = new Map(revisions.models);
      for (const [index, row] of next.models.entries()) {
        if (row.id !== '') continue;
        const created = await client.createModel(modelCreateBody(provider.id, row));
        mutationSucceeded = true;
        revisionMap.set(created.id, created.revision);
        const savedRow = { ...row, id: created.id };
        normalized = {
          ...normalized,
          models: normalized.models.map((candidate, candidateIndex) =>
            candidateIndex === index ? savedRow : candidate),
        };
        savedBaseline = { ...savedBaseline, models: [...savedBaseline.models, savedRow] };
        setDraft(normalized);
        setBaseline(savedBaseline);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      for (const row of normalized.models) {
        const previous = savedBaseline.models.find((model) => model.id === row.id);
        if (previous === undefined) continue;
        const rowPatch = modelPatchBody(row, previous);
        if (rowPatch === null) continue;
        const baseRevision = revisionMap.get(row.id);
        if (baseRevision === undefined) throw new Error(`Missing revision for model ${row.id}`);
        const updated = await client.updateModel(row.id, {
          ...rowPatch,
          base_revision: baseRevision,
        });
        mutationSucceeded = true;
        revisionMap.set(row.id, updated.revision);
        savedBaseline = {
          ...savedBaseline,
          models: savedBaseline.models.map((model) => model.id === row.id ? row : model),
        };
        setBaseline(savedBaseline);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      for (const row of savedBaseline.models) {
        const kept = normalized.models.some((model) => model.id === row.id);
        if (kept || row.id === '') continue;
        const baseRevision = revisionMap.get(row.id);
        if (baseRevision === undefined) throw new Error(`Missing revision for model ${row.id}`);
        await client.deleteModel(row.id, { baseRevision });
        mutationSucceeded = true;
        revisionMap.delete(row.id);
        savedBaseline = { ...savedBaseline, models: savedBaseline.models.filter((model) => model.id !== row.id) };
        setBaseline(savedBaseline);
        setRevisions({ provider: revisions.provider, models: revisionMap });
      }
      const connectionPatch = providerPatchBody(normalized, savedBaseline);
      if (connectionPatch !== null) {
        const updatedProvider = await client.updateProvider(provider.id, {
          ...connectionPatch,
          base_revision: revisions.provider,
        });
        mutationSucceeded = true;
        setRevisions({ provider: updatedProvider.revision, models: revisionMap });
      }
      // The saved key is not kept in the draft: the listing never carries it,
      // and the field fetches it again through the reveal route on request.
      const saved = { ...normalized, apiKey: '', clearApiKey: false };
      setDraft(saved);
      setBaseline(saved);
      await onSaved();
      setFeedback({ tone: 'success', text: t('st.providers.savedEcho', { id: provider.id }) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      if (mutationSucceeded) await onSaved().catch(() => {});
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

  const kind: ConnectionKind = managed ? 'account' : isLocalBaseUrl(provider.base_url) ? 'local' : 'api';
  const vendor = vendorLabelFor(provider.base_url);
  const host = hostLabel(provider.base_url);
  const lastFailure = discovered.data?.items.find((group) => group.provider_id === provider.id)?.failure_reason;
  const count = modelCount ?? models.filter((model) => model.provider_id === provider.id).length;
  // The explicit connection test is the freshest fact; the last model fetch
  // and the catalog status only speak when nothing was tested yet.
  const lastTest = testResult ?? healthQuery.data?.items.find((item) => item.provider_id === provider.id);
  // Health in words, not only a dot: "needs a key" is the common fix-me state.
  const needsKey = kind === 'api' && !provider.has_api_key && provider.api_key_env === undefined;
  const health: 'ok' | 'error' | 'setup' = provider.status === 'unconfigured' || needsKey
    ? 'setup'
    : lastTest !== undefined
      ? (lastTest.ok ? 'ok' : 'error')
      : provider.status === 'error' || lastFailure !== undefined ? 'error' : 'ok';
  const healthText = health === 'error'
    ? t('st.connections.statusError')
    : health === 'setup'
      ? (needsKey ? t('st.connections.statusNeedsKey') : t('st.connections.statusSetup'))
      : t('st.connections.statusOk');
  const checkedAgo = lastTest === undefined ? undefined : time.relativeTime(new Date(lastTest.checked_at).toISOString());
  const identity = account?.signed_in === true && account.account.state === 'known' ? account.account.id : undefined;
  const quota = account?.signed_in === true && account.quota.state === 'known' ? account.quota : undefined;
  const quotaText = quota === undefined ? undefined : formatQuota(quota, locale, t);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const result = await client.testProviderConnection(provider.id);
      setTestResult(result);
      queryClient.setQueryData(PROVIDER_HEALTH_QUERY_KEY, (current: ListProviderHealthResponse | undefined) => ({
        items: [...(current?.items ?? []).filter((item) => item.provider_id !== provider.id), result],
      }));
    } catch (error) {
      setTestResult(undefined);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <details
      data-connection-row={provider.id}
      data-connection-kind={kind}
      data-connection-health={health}
      className="group/provider border-b border-hairline last:border-b-0 [&[open]]:bg-paper"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/[0.05] text-ink-soft">
          <Icon name={kind === 'account' ? 'agent' : kind === 'local' ? 'system' : 'web'} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{accountLabel ?? vendor ?? provider.id}</span>
            {accountLabel !== undefined || vendor !== undefined ? (
              <span className="hidden truncate font-mono text-[11px] text-ink-faint sm:inline">{provider.id}</span>
            ) : null}
          </span>
          <span className="block truncate text-[12px] text-ink-faint">
            {t(`st.connections.kind.${kind}`)}
            {identity !== undefined ? <> · <span data-connection-account className="text-ink-soft">{identity}</span></> : null}
            {host !== undefined && kind !== 'account' ? ` · ${host}` : ''}
            {' · '}{t('st.connections.modelCount', { count })}
            {quotaText !== undefined ? <> · <span data-connection-quota={quota?.unit} className="tabular-nums text-ink-soft"
              title={quota?.reset_at === undefined ? undefined : t('st.connections.quotaResets', { time: time.absoluteTime(quota.reset_at) ?? quota.reset_at })}>{quotaText}</span></> : null}
          </span>
        </span>
        {dirty ? <span className="shrink-0 text-[11px] font-medium text-amber-ink">{t('st.dirty.badge')}</span> : null}
        <span data-connection-status={health}
          title={checkedAgo === undefined ? undefined : t('st.connections.testedAgo', { time: checkedAgo })}
          className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${
          health === 'error' ? 'text-danger' : health === 'setup' ? 'text-amber-ink' : 'text-ink-faint'}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
            health === 'error' ? 'bg-danger' : health === 'setup' ? 'bg-amber-rule' : 'bg-success'}`} />
          <span className="hidden sm:inline">{healthText}</span>
          <span className="sr-only sm:hidden">{healthText}</span>
        </span>
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/provider:rotate-90" />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1 sm:pl-[3.25rem]">
        {health === 'error' ? (
          <div role="alert" data-connection-error className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
            <p className="text-[12px] font-medium text-danger">
              {lastTest !== undefined ? t('st.connections.testFailedTitle') : t('st.connections.errorTitle')}
            </p>
            <p className="mt-0.5 break-words text-[12px] leading-4 text-ink-soft">
              {lastTest !== undefined
                ? (lastTest.error ?? t('st.connections.errorGeneric'))
                : (lastFailure ?? t('st.connections.errorGeneric'))}
            </p>
            <p className="mt-1 text-[12px] leading-4 text-ink-faint">{t(connectionFixKey(lastTest))}</p>
          </div>
        ) : null}
        {health !== 'setup' ? (
          <div data-connection-health-test className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <button type="button" data-connection-test-button className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
              disabled={testing || saving} aria-busy={testing} onClick={() => void runTest()}>
              {testing ? <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" /> : null}
              {testing ? t('st.connections.testing') : t('st.connections.test')}
            </button>
            <p data-connection-last-test={lastTest === undefined ? 'none' : lastTest.ok ? 'ok' : 'error'} aria-live="polite"
              className="min-w-0 text-[12px] leading-4 text-ink-faint">
              {testing ? t('st.connections.testingHint')
                : lastTest === undefined ? t('st.connections.neverTested')
                  : <>
                    <span className={lastTest.ok ? 'text-success' : 'text-danger'}>
                      {lastTest.ok ? t('st.connections.testOk') : t('st.connections.testFailed')}
                    </span>
                    {' · '}{checkedAgo}
                    {' · '}<span className="tabular-nums">{time.formatDuration(lastTest.duration_ms)}</span>
                    {lastTest.model_id !== undefined ? <> · <span className="font-mono text-[11.5px]">{lastTest.model_id}</span></> : null}
                  </>}
            </p>
          </div>
        ) : null}
        <fieldset disabled={saving} className="min-w-0 disabled:opacity-60">
          <ProviderFields
            draft={draft}
            onChange={setDraft}
            hasStoredKey={provider.has_api_key}
            baselineApiKey={baseline.apiKey}
            baselineBaseUrl={baseline.baseUrl}
            baselineType={baseline.type}
            apiKeyEnv={provider.api_key_env}
            revealKey={provider.has_api_key || provider.api_key_env !== undefined ? revealKey : undefined}
            managed={managed}
            idLocked
            refreshProviderId={provider.id}
            catalogModels={catalogModels}
            onRefreshed={onSaved}
            advancedExtra={<>
              <SavedGenerationParametersEditor scope="provider" id={provider.id} onSaved={onSaved} />
              <ProviderConnectionExtras providerId={provider.id} onSaved={onSaved} />
            </>}
          />
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving || revisions === null || !dirty} onClick={() => void save()}>
            {saving ? t('common.saving') : t('st.providers.save')}
          </button>
          {dirty ? <span className="text-[12px] text-ink-faint">{t('st.tools.unsaved')}</span> : null}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {managed ? (
              onSignOut !== undefined ? (
                <button type="button" className={SECONDARY_BUTTON} disabled={saving || signingOut} onClick={onSignOut}>
                  {signingOut ? t('st.auth.working') : t('st.connections.signOut')}
                </button>
              ) : null
            ) : (
              <>
                <button type="button" className={DANGER_GHOST_BUTTON} disabled={saving} onClick={() => { setConfirming('remove'); }}>
                  {t('st.danger.removeProvider')}
                </button>
              </>
            )}
          </span>
        </div>
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
    </details>
  );
}

type ParameterKey = keyof GenerationParametersWire;
const PARAMETER_KEYS = ['temperature', 'top_p', 'max_completion_tokens', 'thinking_effort', 'service_tier'] as const satisfies readonly ParameterKey[];

function parameterLabel(key: ParameterKey, zh: boolean): string {
  const labels = zh
    ? { temperature: '温度', top_p: 'Top P', max_completion_tokens: '最大生成 token', thinking_effort: '思考模式 / 档位', service_tier: '服务档位' }
    : { temperature: 'Temperature', top_p: 'Top P', max_completion_tokens: 'Max generated tokens', thinking_effort: 'Thinking mode / effort', service_tier: 'Service tier' };
  return labels[key];
}

function parameterValue(value: GenerationParametersWire[ParameterKey], zh: boolean): string {
  if (value === undefined) return '—';
  if (typeof value === 'object') return zh ? 'API 默认' : 'API default';
  return String(value);
}

export function SavedGenerationParametersEditor({
  scope, id, onSaved,
}: {
  scope: 'model' | 'provider';
  id: string;
  onSaved?: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const queryClient = useQueryClient();
  const query = useQuery<GetModelResponse | GetProviderResponse>({
    queryKey: ['generation-entity', scope, id],
    queryFn: () => scope === 'model' ? client.getModel(id) : client.getProviderEntity(id),
  });
  const entity = query.data;
  const configured = entity === undefined ? undefined : scope === 'model'
    ? (entity as { parameters?: GenerationParametersWire }).parameters
    : (entity as { defaults?: GenerationParametersWire }).defaults;
  const effective = entity !== undefined && 'effective_parameters' in entity
    ? entity.effective_parameters : undefined;
  const sources = entity !== undefined && 'parameter_sources' in entity
    ? entity.parameter_sources : undefined;
  const supportEfforts = entity !== undefined && 'support_efforts' in entity
    ? entity.support_efforts : undefined;
  const alwaysThinking = entity !== undefined && 'capabilities' in entity
    ? entity.capabilities?.includes('always_thinking') === true : false;
  const [draft, setDraft] = useState<GenerationParametersWire>({});
  const [baseline, setBaseline] = useState<GenerationParametersWire>({});
  const [revision, setRevision] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const dirty = PARAMETER_KEYS.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]));
  useDirtyReporter(`generation:${scope}:${id}`, dirty);

  useEffect(() => {
    if (entity === undefined || dirty || saving || entity.revision === revision) return;
    const next = configured ?? {};
    setDraft(next);
    setBaseline(next);
    setRevision(entity.revision);
  }, [entity, configured, dirty, saving, revision]);

  const change = (key: ParameterKey, value: GenerationParametersWire[ParameterKey]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFeedback(null);
  };
  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const key of PARAMETER_KEYS) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])) patch[key] = draft[key] ?? null;
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setFeedback(null);
    try {
      if (scope === 'model') {
        if (draft.thinking_effort === 'off' && alwaysThinking) {
          throw new Error(zh ? '该模型声明强制思考，不能选择关闭。' : 'This model requires thinking; Off is unavailable.');
        }
        await client.updateModel(id, { base_revision: revision, parameters: patch as GenerationParametersPatch });
      } else {
        await client.updateProvider(id, { base_revision: revision, defaults: patch as GenerationParametersPatch });
      }
      setBaseline(draft);
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
        queryClient.invalidateQueries({ queryKey: ['model-entity'] }),
      ]);
      await onSaved?.();
      setFeedback({ tone: 'success', text: zh ? '已保存。下一次请求生效；角色上限仍可收紧。' : 'Saved for future requests; profile limits may still reduce the budget.' });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  if (query.isError) return <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, query.error) }} />;
  if (entity === undefined || revision === '') return <Hint>{zh ? '正在读取参数…' : 'Loading parameters…'}</Hint>;
  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-panel/50 p-3" data-generation-editor={`${scope}:${id}`}>
      <p className="text-[11px] font-semibold text-ink-soft">
        {scope === 'provider' ? (zh ? '供应商默认请求参数' : 'Provider request defaults') : (zh ? '此模型的请求参数' : 'Model request parameters')}
      </p>
      <Hint>{scope === 'provider'
        ? (zh ? '影响此供应商下未覆盖的模型；已有模型及角色覆盖保持优先。' : 'Applies to models without local overrides; model and profile overrides take precedence.')
        : (zh ? '继承值来自供应商；最大生成 token 是偏好，仍受模型和角色硬上限约束。' : 'Inherits provider defaults; generated-token preferences remain subject to model and profile caps.')}</Hint>
      {PARAMETER_KEYS.map((key) => {
        const value = draft[key];
        const mode = value === undefined ? 'inherit' : typeof value === 'object' ? 'api_default' : 'custom';
        const label = parameterLabel(key, zh);
        const canOmit = key === 'temperature' || key === 'top_p' || key === 'service_tier';
        return (
          <div key={key} className="grid gap-1 sm:grid-cols-[9rem_8rem_minmax(0,1fr)] sm:items-center">
            <label className="text-[11px] font-medium text-ink-soft" htmlFor={`${scope}-${id}-${key}`}>{label}</label>
            <SettingsSelect<'inherit' | 'custom' | 'api_default'>
              variant="form"
              dataAttr="data-param-mode"
              ariaLabel={`${label} ${zh ? '模式' : 'mode'}`}
              value={mode}
              disabled={saving}
              onChange={(next) => {
                change(key, next === 'inherit' ? undefined : next === 'api_default' ? { kind: 'api_default' }
                  : key === 'thinking_effort' ? 'on' : key === 'service_tier' ? 'auto' : key === 'max_completion_tokens' ? 8192 : 0);
              }}
              choices={[
                { value: 'inherit', label: zh ? '继承 / 未设置' : 'Inherit / unset' },
                { value: 'custom', label: zh ? '自定义' : 'Custom' },
                ...(canOmit ? [{ value: 'api_default' as const, label: zh ? 'API 默认（不发送）' : 'API default (omit)' }] : []),
              ]}
            />
            <div>
              {mode === 'custom' && key === 'service_tier' ? (
                <SettingsSelect id={`${scope}-${id}-${key}`} variant="form" mono dataAttr="data-service-tier" ariaLabel={label}
                  value={typeof value === 'string' ? value : 'auto'} disabled={saving}
                  onChange={(next) => { change(key, next as GenerationParametersWire['service_tier']); }}
                  choices={(['auto', 'default', 'flex', 'priority'] as const).map((tier) => ({ value: tier, label: tier }))} />
              ) : mode === 'custom' && key === 'thinking_effort' ? (
                <div className="flex gap-1">
                  <SettingsSelect<'on' | 'off' | 'effort'> variant="form" className="w-auto" dataAttr="data-thinking-choice" ariaLabel={zh ? '思考选择' : 'Thinking choice'}
                    value={value === 'on' || value === 'off' ? value : 'effort'} disabled={saving}
                    onChange={(next) => { change(key, next === 'effort' ? (supportEfforts?.[0] ?? 'high') : next); }}
                    choices={[
                      { value: 'on', label: zh ? '自动' : 'Auto' },
                      ...(alwaysThinking ? [] : [{ value: 'off' as const, label: zh ? '关闭' : 'Off' }]),
                      { value: 'effort', label: zh ? '指定档位' : 'Specific effort' },
                    ]} />
                  {value !== 'on' && value !== 'off' ? <input id={`${scope}-${id}-${key}`} className={SMALL_INPUT} value={typeof value === 'string' ? value : ''}
                    disabled={saving} list={supportEfforts?.length ? `${scope}-${id}-efforts` : undefined}
                    onChange={(event) => { change(key, event.target.value); }} /> : null}
                  {supportEfforts?.length ? <datalist id={`${scope}-${id}-efforts`}>{supportEfforts.map((effort) => <option key={effort} value={effort} />)}</datalist> : null}
                </div>
              ) : mode === 'custom' ? (
                <input id={`${scope}-${id}-${key}`} className={SMALL_INPUT} type="number" min={key === 'max_completion_tokens' ? 1 : 0}
                  max={key === 'top_p' ? 1 : undefined} step={key === 'max_completion_tokens' ? 1 : 'any'}
                  value={typeof value === 'number' ? value : 0} disabled={saving}
                  onChange={(event) => { change(key, Number(event.target.value)); }} />
              ) : null}
              {scope === 'model' ? <p className="text-[11px] text-ink-faint">
                {zh ? '生效' : 'Effective'}: {parameterValue(effective?.[key], zh)} · {sources?.[key] ?? (zh ? '适配器 / API 默认' : 'adapter / API default')}
              </p> : null}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={!dirty || saving} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存参数' : 'Save parameters')}</button>
        {dirty ? <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { setDraft(baseline); setFeedback(null); }}>{zh ? '放弃修改' : 'Discard changes'}</button> : null}
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

// ---- new-provider template wizard ----

export function NewProviderWizard({
  onSaved,
  onAccountChanged,
  initialMethod = 'api',
}: {
  onSaved: () => Promise<void>;
  /** An account sign-in completed or signed out inside the picker. */
  onAccountChanged?: () => Promise<void> | void;
  initialMethod?: 'api' | 'account';
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const blank = useMemo(blankProviderDraft, []);
  const [step, setStep] = useState<'template' | 'form'>('template');
  const [draft, setDraft] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [fieldIssue, setFieldIssue] = useState<ConnectionFieldIssue | null>(null);

  const dirty = step === 'form' && isProviderDraftDirty(draft, blank);
  useDirtyReporter('new-provider', dirty);

  // An edit to the flagged field clears its error; the next create re-checks.
  const editDraft = (next: ProviderDraft) => {
    if ((fieldIssue?.field === 'id' && next.id !== draft.id)
      || (fieldIssue?.field === 'baseUrl' && next.baseUrl !== draft.baseUrl)) setFieldIssue(null);
    setDraft(next);
  };

  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const chooseTemplate = (picked: ProviderPreset | null, protocol?: ProviderDraft['type']) => {
    setPreset(picked);
    setDraft(draftForPreset(picked, protocol));
    setFeedback(null);
    setFieldIssue(null);
    setStep('form');
  };

  const save = async () => {
    const normalized = {
      ...draft,
      defaultModel:
        draft.defaultModel
        || (draft.models[0]?.id ?? draft.models[0]?.remoteId ?? ''),
    };
    const issue = connectionFieldIssue(normalized, { requireBaseUrl: baseUrlRequired(normalized.type) });
    setFieldIssue(issue);
    if (issue !== null) {
      setFeedback(null);
      document.getElementById(issue.field === 'id' ? 'provider-field-id' : 'provider-field-base-url')?.focus();
      return;
    }
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
        <ConnectionMethodPicker initialMethod={initialMethod} onPickApi={chooseTemplate} onAccountChanged={onAccountChanged ?? onSaved} />
        <FeedbackLine feedback={feedback} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => { setDraft(blank); setFeedback(null); setFieldIssue(null); setStep('template'); }}
          className="-ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-[12px] font-medium text-ink-soft transition-colors hover:text-ink"
        >
          <Icon name="arrowLeft" size={12} />
          {t('st.wizard.back')}
        </button>
        <span className="text-[12px] text-ink-faint">
          {preset === null ? protocolLabel(draft.type) : `${preset.label} · ${protocolLabel(preset.type)}`}
        </span>
      </div>
      {preset?.keyOptional === true ? <Hint>{t('st.presets.localHint')}</Hint> : null}
      <ProviderFields draft={draft} onChange={editDraft} hasStoredKey={false} fieldIssue={fieldIssue} />
      <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>
        {saving ? t('st.providers.creating') : t('st.providers.create')}
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

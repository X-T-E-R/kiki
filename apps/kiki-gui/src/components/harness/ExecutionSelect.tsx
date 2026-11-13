/**
 * ExecutionSelect — the composer's execution control ([Model · Effort]).
 *
 * Renders through the shared `ModelPicker` (single-column model & effort
 * popover on desktop, bottom sheet on coarse-pointer phones). Engine / Profile
 * identity is chosen via `ProfileSelect`. Model picking is immediate with
 * inline thinking effort segment capsules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type {
  ExecutorCatalogItem,
  ExecutorModelCatalogResponse,
  ModelCatalogItem,
  NamedAgentProfile,
} from '@kiki/protocol';
import {
  isNativeExecutor,
  type ExecutionChoice,
} from '@kiki/session-core/composer';
import type { I18nKey } from '@kiki/session-core/i18n';
import {
  resolveCatalogModel,
  sortThinkingEffortsForDisplay,
  type ComposerModelSource,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { externalClientsFacade } from '../../lib/externalClients';
import { mapExecutorCapabilities, type ExecutorCapabilityPresentation } from '../../lib/executorCapabilities';
import { useNow } from '../RelativeTime';
import { useOptionalConnection } from '../../state/connection';
import {
  COMPOSER_PANEL_START,
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  useComposerPanelAnchor,
} from '../ComposerControls';
import { ModelPicker } from '../ModelPicker';
import { POPOVER_SURFACE_CLASS, type SearchableSelectOption } from '../SearchableSelect';
import { useProviderGroupLabel } from '../modelSelectOptions';
import { Icon } from '../icons';

/**
 * `ready` / `partial` / `unavailable` are an advertised effort list (an empty
 * list and an unavailable dimension included). `unknown`, `absent`, and
 * `loading` have not named legal efforts, so a model click must not clear one.
 */
function advertisedThinkingLevels(
  capabilities: ExecutorCapabilityPresentation | undefined,
): readonly string[] | undefined {
  const levels = capabilities?.thinking_levels;
  if (levels?.kind === 'unavailable') return [];
  if (levels?.kind === 'ready' || levels?.kind === 'partial') return levels.values ?? [];
  return undefined;
}

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

/** Selected effort capsule from the model-chip row: a paper sheet on the paper track, not an ink fill. */
const EFFORT_SELECTED_CLASS = 'bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]';
const EFFORT_IDLE_CLASS = 'text-ink-soft hover:text-ink';

export interface ExecutionSelectProps {
  readonly choice: ExecutionChoice;
  readonly pending?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: ExecutionChoice) => void;
  readonly catalog: readonly ExecutorCatalogItem[];
  readonly profiles: readonly NamedAgentProfile[];
  readonly nativeLabel: string;
  readonly models?: readonly ModelCatalogItem[];
  readonly modelOptions?: readonly SearchableSelectOption[];
  readonly currentModel?: string;
  readonly effectiveModel?: string;
  readonly modelShortLabel?: string;
  readonly modelSource?: ComposerModelSource;
  readonly currentEffort?: string;
  readonly efforts?: readonly string[];
  readonly onChangeModel?: (model: string | undefined) => void | Promise<void>;
  readonly onChangeEffort?: (effort: string) => void;
  readonly onCancelPending?: () => void;
  readonly executorResponse?: ExecutorModelCatalogResponse;
  readonly executorRefreshBusy?: boolean;
  readonly executorRefreshFailed?: boolean;
  readonly onRefreshExecutorModels?: () => void;
  readonly onRequireSwitchConfirmation?: (toModel: string) => void;
  /** Why the bound model sits outside the profile's menu; shown as a dot with the reason in the tooltip. */
  readonly domainNote?: string;
  /** Called after a pick is committed and the menu closed (never on Escape / cancel). */
  readonly onPicked?: () => void;
}

export function ExecutionSelect({
  choice,
  pending = false,
  busy = false,
  disabled = false,
  onChange,
  catalog,
  profiles: _profiles,
  nativeLabel,
  models = [],
  modelOptions = [],
  currentModel,
  effectiveModel,
  modelShortLabel,
  currentEffort,
  efforts = [],
  onChangeModel,
  onChangeEffort,
  onCancelPending,
  executorResponse,
  executorRefreshBusy = false,
  executorRefreshFailed = false,
  onRefreshExecutorModels,
  onRequireSwitchConfirmation,
  domainNote,
  onPicked,
}: ExecutionSelectProps) {
  const { t } = useI18n();
  const now = useNow();
  const rootRef = useRef<HTMLDivElement>(null);
  const providerGroupLabel = useProviderGroupLabel();
  const optConnection = useOptionalConnection();

  useComposerPanelAnchor(rootRef);

  const [closeSignal, setCloseSignal] = useState(0);
  const requestClose = useCallback(() => {
    setCloseSignal((value) => value + 1);
  }, []);

  // External effort is not stored on the choice: writing overrides.thinking
  // would look like an engine switch. The local pick paints the capsule until
  // the parent reports the new effort, and resets when the engine or model changes.
  const [pickedEffort, setPickedEffort] = useState<string | null | undefined>(undefined);
  const effortChoiceKey = `${choice.executor}\0${choice.profile ?? ''}\0${choice.profile_file ?? ''}\0${choice.external_connection_id ?? ''}\0${choice.overrides?.model ?? ''}\0${String(choice.overrides?.thinking)}`;
  useEffect(() => { setPickedEffort(undefined); }, [effortChoiceKey]);

  const isNative = isNativeExecutor(choice.executor);
  const engineItem = catalog.find((item) => item.id === choice.executor);
  const engineLabel = isNative ? nativeLabel : (engineItem?.label ?? choice.executor);
  const isExternalClient = choice.external_connection_id !== undefined;

  // External queries
  const executorModelsQuery = useQuery({
    queryKey: ['executor-models', optConnection?.connectionId, optConnection?.scopeId, choice.executor],
    queryFn: () => optConnection?.client?.klient?.rest?.executors?.getModels(choice.executor),
    enabled: !isNative && optConnection?.client?.klient?.rest?.executors !== undefined,
    staleTime: 60_000,
    retry: false,
  });

  // The model catalog the composer reads, observed without a request of its
  // own: a catalog that answered empty means no model is connected, which is
  // what the chip says instead of "Default model". A catalog still loading or
  // failed says nothing of the kind.
  const catalogQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => optConnection!.client.listModels(),
    enabled: false,
  });
  const noModelConnected = catalogQuery.isSuccess && catalogQuery.data.items.length === 0;

  const effectiveExecutorResponse = (executorResponse !== undefined)
    ? executorResponse
    : executorModelsQuery.data;

  const executorCapabilities = useMemo(() => {
    if (isNative || !effectiveExecutorResponse) return undefined;
    return mapExecutorCapabilities(effectiveExecutorResponse, now);
  }, [isNative, effectiveExecutorResponse, now]);

  const executorReportedModels = useMemo(() => {
    if (!executorCapabilities) return [];
    const kind = executorCapabilities.models.kind;
    return (kind === 'ready' || kind === 'partial') ? (executorCapabilities.models.values ?? []) : [];
  }, [executorCapabilities]);

  const executorEffortLevels = useMemo(() => {
    if (!executorCapabilities) return [];
    return executorCapabilities.thinking_levels.values ?? [];
  }, [executorCapabilities]);

  // Diagnostics statusLine for external engines
  const statusLine = useMemo(() => {
    if (isNative || !executorCapabilities) return undefined;
    const modelDimension = executorCapabilities.models;
    const modelState = modelDimension.kind;
    const statusMessage = modelState === 'loading'
      ? t('composer.engineModelLoading')
      : modelState === 'partial'
        ? t('composer.engineModelPartial', { count: executorReportedModels.length })
        : modelState === 'unavailable'
          ? t('composer.engineModelUnavailable')
          : modelState === 'unknown' ? t('composer.engineModelUnknown') : undefined;
    const stale = executorCapabilities.freshness === 'stale';
    const modelDiagnostic = modelDimension.diagnostic !== undefined && modelDimension.diagnostic !== ''
      ? modelDimension.diagnostic
      : undefined;
    const modelNote = statusMessage === undefined || (stale && modelState === 'unknown')
      ? undefined
      : (modelState === 'unavailable' || modelState === 'unknown') && modelDiagnostic !== undefined
        ? `${statusMessage} · ${modelDiagnostic}`
        : statusMessage;
    return executorRefreshFailed
      ? t('composer.engineCapabilityRefreshFailed')
      : [modelNote, stale ? t('composer.engineCapabilityStale') : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' · ') || undefined;
  }, [isNative, executorCapabilities, t, executorReportedModels.length, executorRefreshFailed]);

  const externalDiagnosticTitle = useMemo(() => {
    if (isNative || !executorCapabilities) return undefined;
    const switchCtrl = executorCapabilities.controls.model_switch;
    const switchLine = switchCtrl.kind === 'unavailable'
      ? [t('composer.engineModelSwitchUnavailable'), switchCtrl.diagnostic]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ')
      : undefined;
    return [engineLabel, statusLine, switchLine].filter(Boolean).join(' · ') || undefined;
  }, [isNative, executorCapabilities, t, statusLine, engineLabel]);

  const resolvedCurrentModel = useMemo(() => {
    if (!isNative) return undefined;
    const targetId = currentModel ?? effectiveModel;
    return targetId ? resolveCatalogModel(models ?? [], targetId) : undefined;
  }, [isNative, currentModel, effectiveModel, models]);

  const displayEfforts = useMemo((): readonly string[] => {
    if (isNative) {
      const modelEfforts = resolvedCurrentModel?.support_efforts;
      if (modelEfforts !== undefined) {
        return sortThinkingEffortsForDisplay(modelEfforts);
      }
      return sortThinkingEffortsForDisplay(efforts ?? []);
    }
    return executorEffortLevels;
  }, [isNative, resolvedCurrentModel, efforts, executorEffortLevels]);

  const supportsEffort = isNative
    ? displayEfforts.length > 0
    : (executorCapabilities?.controls?.thinking_switch?.kind !== 'unavailable' && displayEfforts.length > 0);

  const boundEffort = isNative ? currentEffort : (choice.overrides?.thinking ?? undefined);
  const activeEffort = pickedEffort !== undefined ? (pickedEffort ?? undefined) : (boundEffort || undefined);

  const switchControl = executorCapabilities?.controls?.model_switch;
  const supportsModelOverride = isNative || (switchControl && switchControl.kind !== 'unavailable');
  const currentExecutorNeedsSetup = !isNative && engineItem?.status === 'unavailable';
  const showSetupNotice = !supportsModelOverride || currentExecutorNeedsSetup;

  // External client connections
  const extFacade = useMemo(() => externalClientsFacade(optConnection?.client?.klient), [optConnection?.client]);
  const extClientsQuery = useQuery({
    queryKey: ['external-clients'],
    queryFn: () => extFacade!.list(),
    staleTime: 15_000,
    retry: false,
    enabled: extFacade !== undefined,
  });
  const externalConnections = extClientsQuery.data?.connections ?? [];

  // Handlers for instant selection
  const handleSelectDefault = useCallback(() => {
    if (isNative && onChangeModel !== undefined) {
      void onChangeModel(undefined);
      onPicked?.();
      return;
    }
    onChange({
      ...choice,
      external_connection_id: undefined,
      external_connection_name: undefined,
      overrides: choice.overrides !== undefined ? { model: null, thinking: null } : undefined,
    });
    onPicked?.();
  }, [isNative, onChangeModel, onChange, choice, onPicked]);

  const handleSelectNativeModel = useCallback((modelId: string) => {
    if (onRequireSwitchConfirmation) {
      onRequireSwitchConfirmation(modelId);
      return;
    }
    if (onChangeModel !== undefined) {
      void onChangeModel(modelId);
      onPicked?.();
      return;
    }
    const m = (models ?? []).find((item) => item.id === modelId);
    const nextEfforts = m?.support_efforts ?? [];
    const nextEffort = (currentEffort && nextEfforts.includes(currentEffort)) ? currentEffort : undefined;
    onChange({
      ...choice,
      external_connection_id: undefined,
      external_connection_name: undefined,
      overrides: {
        model: modelId,
        thinking: nextEffort ?? undefined,
      },
    });
    onPicked?.();
  }, [onRequireSwitchConfirmation, models, currentEffort, onChangeModel, onChange, choice, onPicked]);

  const handleSelectExternalModel = useCallback((modelVal: string) => {
    if (onRequireSwitchConfirmation) {
      onRequireSwitchConfirmation(modelVal);
      return;
    }
    const advertised = advertisedThinkingLevels(executorCapabilities);
    const current = choice.overrides?.thinking;
    const thinking = advertised === undefined
      ? (current === '' ? undefined : current)
      : current === null
        ? null
        : (typeof current === 'string' && current !== '' && advertised.includes(current) ? current : undefined);
    const { thinking: _previous, ...rest } = choice.overrides ?? {};
    onChange({
      ...choice,
      external_connection_id: undefined,
      external_connection_name: undefined,
      overrides: thinking === undefined && advertised === undefined
        ? { ...rest, model: modelVal }
        : { ...rest, model: modelVal, thinking },
    });
    onPicked?.();
  }, [onRequireSwitchConfirmation, choice, executorCapabilities, onChange, onPicked]);

  const handleSelectEffort = useCallback((effortVal: string | undefined) => {
    if (!isNative) setPickedEffort(effortVal ?? null);
    // Effort keeps the current binding. Publishing an execution choice here
    // would confirm a new context and can clear a bare external engine's persona.
    onChangeEffort?.(effortVal ?? '');
  }, [isNative, onChangeEffort]);

  const pickerValue = isExternalClient
    ? `__ext__:${choice.external_connection_id}`
    : isNative
      ? (currentModel ?? '')
      : (typeof choice.overrides?.model === 'string' ? choice.overrides.model : '');

  const pickerOptions = useMemo<readonly SearchableSelectOption[]>(() => {
    const defaultRow: SearchableSelectOption = {
      value: '',
      label: t('composer.execution.defaultModelOption'),
      dataAttrs: {
        'data-menu-row': '',
        'data-execution-model-default': '',
        'data-execution-model': '',
      },
    };
    if (showSetupNotice) return [defaultRow];
    if (isNative) {
      const nativeRows = (models ?? []).map((m): SearchableSelectOption => {
        const opt = modelOptions?.find((o) => o.value === m.id);
        const modelLabel = m.display_name ?? m.id;
        const showDistinctId = Boolean(m.display_name && m.display_name !== m.id);
        const optText = opt?.description ?? opt?.hint;
        const showOptText = Boolean(optText && optText !== m.id && optText !== m.display_name);
        return {
          value: m.id,
          label: modelLabel,
          disabled: opt?.disabled,
          group: m.provider_id ? providerGroupLabel(m.provider_id) : undefined,
          hint: showDistinctId ? m.id : (showOptText ? optText : undefined),
          description: showDistinctId && showOptText ? optText : undefined,
          badges: opt?.badges,
          title: opt?.title ?? modelLabel,
          keywords: `${m.id} ${m.remote_id ?? ''} ${m.display_name ?? ''} ${m.provider_id}`,
          dataAttrs: {
            'data-menu-row': '',
            'data-execution-model': m.id,
          },
        };
      });
      return [defaultRow, ...nativeRows];
    }
    const externalRows: SearchableSelectOption[] = executorReportedModels.map((val) => ({
      value: val,
      label: val,
      keywords: val,
      dataAttrs: {
        'data-menu-row': '',
        'data-execution-model': val,
      },
    }));
    const savedOverride = typeof choice.overrides?.model === 'string' ? choice.overrides.model : '';
    const isReadyCatalog = executorCapabilities?.models.kind === 'ready';
    if (savedOverride !== '' && !executorReportedModels.includes(savedOverride)) {
      externalRows.push({
        value: savedOverride,
        label: savedOverride,
        badges: isReadyCatalog
          ? [{ label: t('composer.engineModelNotInList'), tone: 'caution' }]
          : undefined,
        keywords: savedOverride,
        dataAttrs: {
          'data-menu-row': '',
          'data-execution-model': savedOverride,
        },
      });
    }
    return [defaultRow, ...externalRows];
  }, [
    t,
    showSetupNotice,
    isNative,
    models,
    modelOptions,
    providerGroupLabel,
    executorReportedModels,
    choice.overrides?.model,
    executorCapabilities?.models.kind,
  ]);

  // Format trigger label: Model · Effort
  const triggerLabel = useMemo(() => {
    if (choice.external_connection_id !== undefined) {
      return choice.external_connection_name ?? t('st.section.connectionServices');
    }
    if (isNative) {
      const fallbackModel = noModelConnected ? t('new.modelChip.none') : t('composer.execution.defaultModelOption');
      const resolvedModel = currentModel
        ? (resolveCatalogModel(models ?? [], currentModel)?.display_name ?? currentModel)
        : (effectiveModel ?? modelShortLabel ?? fallbackModel);
      const parts = [resolvedModel, activeEffort].filter(Boolean);
      return parts.join(' · ');
    }
    const targetModel = choice.overrides?.model;
    if (targetModel) {
      const parts = [targetModel, activeEffort].filter(Boolean);
      return parts.join(' · ');
    }
    return t('composer.engineModelFollow');
  }, [choice, isNative, currentModel, models, effectiveModel, modelShortLabel, activeEffort, noModelConnected, t]);

  const triggerTitle = [
    pending
      ? t('composer.execution.pendingTitle')
      : busy
        ? t('composer.execution.busyTitle')
        : externalDiagnosticTitle ?? t('composer.execution.title', { engine: engineLabel }),
    domainNote,
  ].filter(Boolean).join('\n');

  const panelHeader = (!isNative && (onRefreshExecutorModels !== undefined || statusLine !== undefined)) ? (
    <div>
      {onRefreshExecutorModels !== undefined ? (
        <div className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-1.5">
          <span className="truncate text-[12px] font-medium text-ink-soft">{engineLabel}</span>
          <button
            type="button"
            data-external-model-refresh
            disabled={executorRefreshBusy}
            onClick={onRefreshExecutorModels}
            className="shrink-0 text-[11px] text-ink-faint hover:text-ink disabled:opacity-50"
          >
            {executorRefreshBusy ? t('composer.engineCapabilityRefreshing') : t('composer.engineCapabilityRefresh')}
          </button>
        </div>
      ) : null}
      {statusLine !== undefined ? (
        <div data-external-model-status className="border-b border-hairline px-3 py-1.5 text-[11.5px] leading-snug text-ink-faint">
          <p data-external-model-refresh-error={executorRefreshFailed ? true : undefined} className="truncate" title={statusLine}>
            {statusLine}
          </p>
        </div>
      ) : null}
    </div>
  ) : undefined;

  const panelFooter = (
    showSetupNotice
    || externalConnections.length > 0
    || (supportsEffort && displayEfforts.length > 0)
  ) ? (
    <>
      {showSetupNotice ? (
        <div data-execution-restore={choice.executor} className="space-y-2 border-t border-hairline p-3">
          <p className="text-[12px] leading-snug text-ink-faint">
            {currentExecutorNeedsSetup
              ? t('composer.execution.needsSetup', { engine: engineLabel })
              : (switchControl?.diagnostic || t('composer.engineModelSwitchUnavailable'))}
          </p>
          <Link
            to="/settings/ai?tab=providers#st-card-engines"
            data-execution-configure
            onClick={requestClose}
            className="text-[12px] font-medium text-ink underline decoration-dotted underline-offset-2"
          >
            {t('composer.execution.configure')}
          </Link>
        </div>
      ) : null}
      {externalConnections.length > 0 ? (
        <div data-execution-external-clients className="border-t border-hairline p-1">
          <div className="px-2 pt-1 pb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-faint">
            {t('st.section.connectionServices')}
          </div>
          {externalConnections.map((conn) => {
            const selected = choice.external_connection_id === conn.id;
            return (
              <button
                key={conn.id}
                type="button"
                role="option"
                aria-selected={selected}
                data-menu-row
                data-execution-external-connection={conn.id}
                onClick={() => {
                  onChange({
                    executor: 'external-client',
                    profile: undefined,
                    profile_file: undefined,
                    external_connection_id: conn.id,
                    external_connection_name: conn.name,
                    overrides: undefined,
                  });
                  requestClose();
                  onPicked?.();
                }}
                className={`${MENU_ROW_CLASS} items-start ${selected ? MENU_ROW_SELECTED_CLASS : ''}`}
              >
                <Check on={selected} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{conn.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {supportsEffort && displayEfforts.length > 0 ? (
        <div className="shrink-0 border-t border-hairline bg-surface/50 px-3 py-2.5">
          <p className="mb-1 text-[11.5px] font-medium text-ink-faint">
            {t('composer.execution.effortHeading')}
          </p>
          <div role="radiogroup" aria-label={t('composer.execution.effortHeading')} className="flex flex-wrap gap-0.5 rounded-md bg-paper p-0.5">
            <button
              type="button"
              role="radio"
              aria-checked={!activeEffort}
              data-effort=""
              data-execution-effort=""
              onClick={() => { handleSelectEffort(undefined); }}
              className={`rounded px-2 py-0.5 text-[11.5px] transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                !activeEffort ? EFFORT_SELECTED_CLASS : EFFORT_IDLE_CLASS
              }`}
            >
              {t('composer.execution.defaultEffort')}
            </button>
            {displayEfforts.map((level) => {
              const isLevelActive = activeEffort === level;
              return (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={isLevelActive}
                  data-effort={level}
                  data-execution-effort={level}
                  onClick={() => { handleSelectEffort(level); }}
                  className={`rounded px-2 py-0.5 text-[11.5px] capitalize transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none ${
                    isLevelActive ? EFFORT_SELECTED_CLASS : EFFORT_IDLE_CLASS
                  }`}
                >
                  {t(`composer.effort.${level}` as I18nKey) === `composer.effort.${level}` ? level : t(`composer.effort.${level}` as I18nKey)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  ) : undefined;

  return (
    <div ref={rootRef} className="relative min-w-0" data-execution-select>
      <ModelPicker
        id="composer-execution-select"
        options={pickerOptions}
        value={pickerValue}
        disabled={disabled}
        allowCustomValue={!isNative && !showSetupNotice}
        customValueLabel={(custom) => t('composer.model.useCustomId', { id: custom })}
        hideFilter={showSetupNotice}
        hideChevron
        density="compact"
        placement="above"
        closeSignal={closeSignal}
        ariaLabel={t('composer.execution.panelLabel')}
        searchPlaceholder={t('composer.model.searchPlaceholder')}
        title={triggerTitle}
        triggerData={{
          'data-execution-trigger': '',
          'data-execution-engine-value': choice.executor,
          'data-execution-profile-file': choice.profile_file,
          'data-execution-pending': pending ? 'true' : undefined,
          'data-composer-engine-model': isNative ? undefined : engineLabel,
        }}
        panelData={{ 'data-execution-panel': '' }}
        triggerIcon={(
          <Icon
            name={isExternalClient ? 'external' : isNative ? 'agent' : 'terminal'}
            size={14}
            className={STATUS_SEGMENT_ICON_CLASS}
          />
        )}
        triggerLabel={triggerLabel}
        labelClassName="@max-[16rem]/toolbar:sr-only"
        triggerSuffix={domainNote !== undefined ? (
          <span data-model-domain-note className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-rule">
            <span className="sr-only">{domainNote}</span>
          </span>
        ) : undefined}
        buttonClassName={`${STATUS_SEGMENT_CLASS} max-w-64 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.executor !== 'native' || isExternalClient ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
        panelClassName={`anim-enter ${COMPOSER_PANEL_START} flex max-h-[min(var(--cp-max-h,none),28rem)] w-[min(340px,calc(100vw-2rem))] flex-col overflow-hidden ${POPOVER_SURFACE_CLASS} [&>*]:shrink-0 [&>[role=listbox]]:min-h-0 [&>[role=listbox]]:shrink`}
        panelHeader={panelHeader}
        panelFooter={panelFooter}
        onChange={(next) => {
          if (next === '') {
            handleSelectDefault();
            return;
          }
          if (isNative) {
            handleSelectNativeModel(next);
            return;
          }
          handleSelectExternalModel(next);
        }}
      />

      {pending && onCancelPending !== undefined ? (
        <button
          type="button"
          data-execution-cancel-pending
          aria-label={t('composer.execution.cancelPending')}
          title={t('composer.execution.cancelPending')}
          onClick={() => { onCancelPending(); }}
          className="absolute top-1/2 -right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-9 pointer-coarse:w-9"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </div>
  );
}

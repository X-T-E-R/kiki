/**
 * ExecutionSelect — the composer's execution control ([Model · Effort]).
 *
 * Implements the single-column lightweight model & effort popover.
 * Engine / Profile identity is chosen via ProfileSelect.
 * Model picking is immediate (即点即切) with inline thinking effort segment capsules.
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
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  useComposerPanelAnchor,
  usePopover,
} from '../ComposerControls';
import type { SearchableSelectOption } from '../SearchableSelect';
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
}: ExecutionSelectProps) {
  const { t } = useI18n();
  const now = useNow();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const optConnection = useOptionalConnection();

  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const close = useCallback((refocus?: boolean) => {
    openRef.current = false;
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  const popoverKeyDown = usePopover(open, close, rootRef, 'composer-execution-select');

  useComposerPanelAnchor(rootRef, open);

  const [openDirection, setOpenDirection] = useState<'up' | 'down'>('up');
  useEffect(() => {
    if (!open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect && rect.top > 0 && rect.top < 380 && window.innerHeight - rect.bottom > rect.top) {
      setOpenDirection('down');
    } else {
      setOpenDirection('up');
    }
  }, [open]);

  const [modelSearch, setModelSearch] = useState('');
  // External effort is not stored on the choice: writing overrides.thinking
  // would look like an engine switch. The local pick paints the capsule until
  // the parent reports the new effort, and resets when the engine or model changes.
  const [pickedEffort, setPickedEffort] = useState<string | null | undefined>(undefined);
  const effortChoiceKey = `${choice.executor}\0${choice.profile ?? ''}\0${choice.profile_file ?? ''}\0${choice.external_connection_id ?? ''}\0${choice.overrides?.model ?? ''}\0${String(choice.overrides?.thinking)}`;
  useEffect(() => { setPickedEffort(undefined); }, [effortChoiceKey]);

  useEffect(() => {
    if (!open) {
      setModelSearch('');
    } else {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 0);
    }
  }, [open]);

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

  // Filtered models
  const filteredNativeModels = useMemo(() => {
    const list = models ?? [];
    const q = modelSearch.trim().toLowerCase();
    if (q === '') return list;
    return list.filter((m) =>
      `${m.id} ${m.display_name ?? ''} ${m.provider_id}`.toLowerCase().includes(q)
    );
  }, [models, modelSearch]);

  const groupedNativeModels = useMemo(() => {
    const groups: { providerId: string; items: ModelCatalogItem[] }[] = [];
    for (const m of filteredNativeModels) {
      const p = m.provider_id || '';
      let g = groups.find((item) => item.providerId === p);
      if (!g) {
        g = { providerId: p, items: [] };
        groups.push(g);
      }
      g.items.push(m);
    }
    return groups;
  }, [filteredNativeModels]);

  const filteredExternalModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (q === '') return executorReportedModels;
    return executorReportedModels.filter((val) => val.toLowerCase().includes(q));
  }, [executorReportedModels, modelSearch]);

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

  const isDefaultSelected = isNative
    ? (currentModel === undefined || currentModel === '')
    : (choice.overrides?.model === undefined || choice.overrides?.model === null || choice.overrides?.model === '');

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

  // Handlers for instant selection (即点即切)
  const handleSelectDefault = useCallback(() => {
    if (isNative && onChangeModel !== undefined) {
      void onChangeModel(undefined);
      close(true);
      return;
    }
    onChange({
      ...choice,
      external_connection_id: undefined,
      external_connection_name: undefined,
      overrides: choice.overrides !== undefined ? { model: null, thinking: null } : undefined,
    });
    close(true);
  }, [isNative, onChangeModel, onChangeEffort, onChange, choice, close]);

  const handleSelectNativeModel = useCallback((modelId: string) => {
    if (onRequireSwitchConfirmation) {
      onRequireSwitchConfirmation(modelId);
      close(true);
      return;
    }
    if (onChangeModel !== undefined) {
      void onChangeModel(modelId);
      close(true);
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
    close(true);
  }, [onRequireSwitchConfirmation, models, currentEffort, onChangeModel, onChangeEffort, onChange, choice, close]);

  const handleSelectExternalModel = useCallback((modelVal: string) => {
    if (onRequireSwitchConfirmation) {
      onRequireSwitchConfirmation(modelVal);
      close(true);
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
    close(true);
  }, [onRequireSwitchConfirmation, choice, executorCapabilities, onChange, close]);

  const handleSelectEffort = useCallback((effortVal: string | undefined) => {
    if (!isNative) setPickedEffort(effortVal ?? null);
    // Effort keeps the current binding. Publishing an execution choice here
    // would confirm a new context and can clear a bare external engine's persona.
    onChangeEffort?.(effortVal ?? '');
  }, [isNative, onChangeEffort]);

  // Format trigger label: Model · Effort
  const triggerLabel = useMemo(() => {
    if (choice.external_connection_id !== undefined) {
      return choice.external_connection_name ?? t('st.section.connectionServices');
    }
    if (isNative) {
      const fallbackModel = t('composer.execution.defaultModelOption');
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
  }, [choice, isNative, currentModel, models, effectiveModel, modelShortLabel, activeEffort, t]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(true);
    } else {
      popoverKeyDown(e);
    }
  }, [open, close, popoverKeyDown]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/keyboard handling
    <div ref={rootRef} className="relative min-w-0" data-execution-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        role="button"
        aria-haspopup="true"
        aria-expanded={open}
        id="composer-execution-select"
        data-execution-trigger
        data-execution-engine-value={choice.executor}
        data-execution-profile-file={choice.profile_file}
        data-execution-pending={pending ? 'true' : undefined}
        data-composer-engine-model={isNative ? undefined : engineLabel}
        disabled={disabled}
        title={pending
          ? t('composer.execution.pendingTitle')
          : busy
            ? t('composer.execution.busyTitle')
            : externalDiagnosticTitle ?? t('composer.execution.title', { engine: engineLabel })}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
        className={`${STATUS_SEGMENT_CLASS} max-w-64 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.executor !== 'native' || isExternalClient ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Icon
          name={isExternalClient ? 'external' : isNative ? 'agent' : 'terminal'}
          size={14}
          className={STATUS_SEGMENT_ICON_CLASS}
        />
        <span className="min-w-0 truncate @max-[24rem]/toolbar:sr-only">
          {/* The profile chip on the left already says the switch applies on
              the next message. The model chip keeps the pending accent, title,
              and cancel, and names only the model and effort. */}
          {triggerLabel}
        </span>
      </button>

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

      {open ? (
        <div
          ref={panelRef}
          data-execution-panel
          role="dialog"
          aria-label={t('composer.execution.panelLabel')}
          className={`anim-enter absolute left-0 z-50 w-[min(340px,calc(100vw-2rem))] flex max-h-[min(var(--cp-max-h,none),28rem)] flex-col overflow-hidden rounded-[var(--radius-card)] border border-hairline bg-paper text-ink shadow-lg ${openDirection === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}
          style={{ backgroundColor: 'var(--color-paper)' }}
        >
          {!isNative && onRefreshExecutorModels ? (
            <div className="flex items-center justify-between border-b border-hairline px-3 py-1.5 shrink-0">
              <span className="font-medium text-[12px] text-ink-soft truncate">{engineLabel}</span>
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

          {/* Header & Search */}
          <div className="border-b border-hairline p-2 shrink-0">
            <input
              ref={searchInputRef}
              type="text"
              data-select-search
              data-execution-model-search
              value={modelSearch}
              onChange={(e) => { setModelSearch(e.target.value); }}
              placeholder={t('composer.model.searchPlaceholder')}
              aria-label={t('composer.execution.filterAria')}
              className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink outline-none focus-visible:border-selected-ink placeholder:text-ink-faint"
            />
          </div>

          {!isNative && statusLine !== undefined ? (
            <div data-external-model-status className="px-3 pt-2 text-[11.5px] leading-snug text-ink-faint">
              <p data-external-model-refresh-error={executorRefreshFailed ? true : undefined} className="truncate" title={statusLine}>
                {statusLine}
              </p>
            </div>
          ) : null}

          {/* Model List */}
          <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
            {/* Default Option */}
            <button
              type="button"
              role="option"
              aria-selected={isDefaultSelected}
              data-menu-row
              data-execution-model-default
              data-execution-model=""
              data-option-value=""
              onClick={handleSelectDefault}
              className={`${MENU_ROW_CLASS} items-start min-h-[40px] ${isDefaultSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
            >
              <Check on={isDefaultSelected} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-1">
                  <span className="font-medium text-ink">{t('composer.execution.defaultModelOption')}</span>
                </span>
              </span>
            </button>

            {/* Needs Setup or Switch Unavailable Notice */}
            {!supportsModelOverride || currentExecutorNeedsSetup ? (
              <div data-execution-restore={choice.executor} className="p-3 space-y-2 border-t border-hairline">
                <p className="text-[12px] leading-snug text-ink-faint">
                  {currentExecutorNeedsSetup
                    ? t('composer.execution.needsSetup', { engine: engineLabel })
                    : (switchControl?.diagnostic || t('composer.engineModelSwitchUnavailable'))}
                </p>
                <Link
                  to="/settings/ai?tab=providers#st-card-engines"
                  data-execution-configure
                  onClick={() => { close(); }}
                  className="text-[12px] font-medium text-ink underline decoration-dotted underline-offset-2"
                >
                  {t('composer.execution.configure')}
                </Link>
              </div>
            ) : isNative ? (
              /* Native Models */
              groupedNativeModels.map((g) => (
                <div key={g.providerId} className="space-y-0.5">
                  {g.providerId && groupedNativeModels.length > 1 ? (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                      {g.providerId}
                    </div>
                  ) : null}
                  {g.items.map((m) => {
                    const sel = currentModel === m.id;
                    const opt = modelOptions?.find((o) => o.value === m.id);
                    const modelLabel = m.display_name ?? m.id;
                    const showDistinctId = m.display_name && m.display_name !== m.id;
                    const optText = opt?.description ?? opt?.hint;
                    const showOptText = optText && optText !== m.id && optText !== m.display_name;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={sel}
                        aria-disabled={opt?.disabled ? 'true' : undefined}
                        disabled={opt?.disabled}
                        data-menu-row
                        data-option-value={m.id}
                        data-execution-model={m.id}
                        onClick={() => { handleSelectNativeModel(m.id); }}
                        className={`${MENU_ROW_CLASS} items-start min-h-[40px] ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
                      >
                        <Check on={sel} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">{modelLabel}</span>
                          {showDistinctId ? (
                            <span className="block truncate font-mono text-[11px] text-ink-faint">{m.id}</span>
                          ) : null}
                          {showOptText ? (
                            <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                              {optText}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              /* External Models */
              <>
                {filteredExternalModels.map((val) => {
                  const sel = choice.overrides?.model === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      role="option"
                      aria-selected={sel}
                      data-menu-row
                      data-option-value={val}
                      data-execution-model={val}
                      onClick={() => { handleSelectExternalModel(val); }}
                      className={`${MENU_ROW_CLASS} items-start min-h-[40px] ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
                    >
                      <Check on={sel} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{val}</span>
                      </span>
                    </button>
                  );
                })}

                {choice.overrides?.model !== undefined && choice.overrides?.model !== null && choice.overrides?.model !== '' && !filteredExternalModels.includes(choice.overrides.model) ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected="true"
                    data-menu-row
                    data-option-value={choice.overrides.model}
                    data-execution-model={choice.overrides.model}
                    onClick={() => {}}
                    className={`${MENU_ROW_CLASS} items-start ${MENU_ROW_SELECTED_CLASS}`}
                  >
                    <Check on={true} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{choice.overrides.model}</span>
                      <span className="mt-0.5 inline-block rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        {t('composer.engineModelNotInList')}
                      </span>
                    </span>
                  </button>
                ) : null}

                {modelSearch.trim() !== '' && !filteredExternalModels.includes(modelSearch.trim()) ? (
                  <button
                    type="button"
                    role="option"
                    data-menu-row
                    onClick={() => { handleSelectExternalModel(modelSearch.trim()); }}
                    className={`${MENU_ROW_CLASS} text-selected-ink font-medium`}
                  >
                    <Check on={choice.overrides?.model === modelSearch.trim()} />
                    <span className="min-w-0 flex-1 truncate">
                      {t('composer.model.useCustomId', { id: modelSearch.trim() })}
                    </span>
                  </button>
                ) : null}
              </>
            )}

            {/* External client connections if any */}
            {externalConnections.length > 0 ? (
              <div data-execution-external-clients className="mt-1 border-t border-hairline pt-1">
                <div className="px-2 pb-0.5 text-[10.5px] font-medium uppercase tracking-wider text-ink-faint">
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
                        close(true);
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
          </div>

          {/* Thinking Effort Section */}
          {supportsEffort && displayEfforts.length > 0 ? (
            <div className="border-t border-hairline bg-surface/50 px-3 py-2.5 shrink-0">
              <p className="mb-1 text-[11.5px] font-medium text-ink-faint">
                {t('composer.execution.effortHeading')}
              </p>
              <div className="flex flex-wrap gap-0.5 rounded-md bg-paper p-0.5">
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
                      {level}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

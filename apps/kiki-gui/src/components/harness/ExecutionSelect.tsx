/**
 * ExecutionSelect — the composer's execution control (Engine + Model + Thinking Effort).
 *
 * Implements the unified 运行 (Execution) entry point according to Task 31 design:
 * Desktop: two-column panel (engines on the left, engine models + thinking effort on the right).
 * Narrow (390px): drill-down single page (models view with back button to engine list).
 *
 * Profile identity is preserved when changing engines. When the active Profile
 * does not specify defaults for the target engine, "Use {engine} default" is selected,
 * without borrowing native pins or fabricating overrides.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import {
  configuredEngineDescriptors,
  engineDisplayOf,
  engineOverridesOf,
  visibleEngines,
} from '../settings/profileEditor/engines';

import type {
  ExecutorCatalogItem,
  ExecutorModelCatalogResponse,
  ModelCatalogItem,
  NamedAgentProfile,
} from '@kiki/protocol';
import {
  isNativeExecutor,
  NATIVE_EXECUTOR,
  profileExecutor,
  type ExecutionChoice,
} from '@kiki/session-core/composer';
import {
  composerDefaultsForProfile,
  resolveCatalogModel,
  sortThinkingEffortsForDisplay,
  type ComposerModelSource,
} from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { externalClientsFacade } from '../../lib/externalClients';
import { mapExecutorCapabilities, isExecutorActionAvailable } from '../../lib/executorCapabilities';
import { useNow } from '../RelativeTime';
import { useConnection, useOptionalConnection } from '../../state/connection';
import {
  COMPOSER_PANEL_START,
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  useComposerPanelAnchor,
  usePopover,
} from '../ComposerControls';
import { POPOVER_SURFACE_CLASS, type SearchableSelectOption } from '../SearchableSelect';
import { Icon } from '../icons';

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

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
  profiles,
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
  const { t, locale } = useI18n();
  const now = useNow();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { client } = useConnection();
  const optConnection = useOptionalConnection();
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

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

  // Active Profile and its defaults
  const activeProfile = useMemo(() => {
    return profiles.find((p) => p.name === choice.profile);
  }, [profiles, choice.profile]);

  const activeProfileDefaultExecutor = activeProfile ? profileExecutor(activeProfile) : NATIVE_EXECUTOR;
  const activeProfileDefaults = useMemo(() => {
    if (!activeProfile) return undefined;
    return composerDefaultsForProfile(profiles, activeProfile.name);
  }, [activeProfile, profiles]);

  // Draft state while the panel is open
  const [editingExecutor, setEditingExecutor] = useState(choice.executor);
  const [editingModel, setEditingModel] = useState<string | undefined>(
    isNativeExecutor(choice.executor) ? currentModel : (choice.overrides?.model ?? undefined)
  );
  const [editingEffort, setEditingEffort] = useState<string | undefined>(
    isNativeExecutor(choice.executor) ? currentEffort : (choice.overrides?.thinking ?? undefined)
  );
  const [modelSearch, setModelSearch] = useState('');
  const [narrowPage, setNarrowPage] = useState<'models' | 'engines'>('models');
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 639px)');
    const update = () => { setIsNarrow(mql.matches); };
    update();
    mql.addEventListener('change', update);
    return () => { mql.removeEventListener('change', update); };
  }, []);

  // When panel opens, sync draft with current choice
  useEffect(() => {
    if (open) {
      setEditingExecutor(choice.executor);
      setEditingModel(isNativeExecutor(choice.executor) ? currentModel : (choice.overrides?.model ?? undefined));
      setEditingEffort(isNativeExecutor(choice.executor) ? currentEffort : (choice.overrides?.thinking ?? undefined));
      setModelSearch('');
      setNarrowPage('models');
    }
  }, [open, choice.executor, choice.overrides?.model, choice.overrides?.thinking, currentModel, currentEffort]);

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

  // Available visible engines
  const externalEngines = useMemo(() => {
    return visibleEngines(
      catalog,
      profiles,
      engineOverridesOf(configQuery.data),
      engineDisplayOf(configQuery.data),
      configuredEngineDescriptors(configQuery.data)
    ).filter((item) => item.id !== NATIVE_EXECUTOR);
  }, [catalog, profiles, configQuery.data]);

  const externalLabelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of externalEngines) {
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    }
    return counts;
  }, [externalEngines]);

  const engineItem = catalog.find((item) => item.id === choice.executor);
  const engineLabel = isNativeExecutor(choice.executor) ? nativeLabel : (engineItem?.label ?? choice.executor);

  const editingEngineItem = catalog.find((item) => item.id === editingExecutor);
  const editingEngineLabel = isNativeExecutor(editingExecutor) ? nativeLabel : (editingEngineItem?.label ?? editingExecutor);

  const retainedExternal = !isNativeExecutor(choice.executor) && choice.external_connection_id === undefined
    && !externalEngines.some((item) => item.id === choice.executor);

  const editingExecutorModelsQuery = useQuery({
    queryKey: ['executor-models', optConnection?.connectionId, optConnection?.scopeId, editingExecutor],
    queryFn: () => optConnection?.client?.klient?.rest?.executors?.getModels(editingExecutor),
    enabled: !isNativeExecutor(editingExecutor) && optConnection?.client?.klient?.rest?.executors !== undefined,
    staleTime: 60_000,
    retry: false,
  });

  const effectiveExecutorResponse = (editingExecutor === choice.executor && executorResponse)
    ? executorResponse
    : editingExecutorModelsQuery.data;

  // External capabilities for editingExecutor
  const executorCapabilities = useMemo(() => {
    if (isNativeExecutor(editingExecutor) || !effectiveExecutorResponse) return undefined;
    return mapExecutorCapabilities(effectiveExecutorResponse, now);
  }, [editingExecutor, effectiveExecutorResponse, now]);

  const executorReportedModels = useMemo(() => {
    if (!executorCapabilities) return [];
    const kind = executorCapabilities.models.kind;
    return (kind === 'ready' || kind === 'partial') ? (executorCapabilities.models.values ?? []) : [];
  }, [executorCapabilities]);

  const executorEffortLevels = useMemo(() => {
    if (!executorCapabilities) return [];
    return executorCapabilities.thinking_levels.values ?? [];
  }, [executorCapabilities]);

  // Handle switching executor inside the panel
  const handleSelectExecutor = useCallback((newExecutor: string) => {
    setEditingExecutor(newExecutor);
    setModelSearch('');
    if (newExecutor === choice.executor) {
      setEditingModel(isNativeExecutor(newExecutor) ? currentModel : (choice.overrides?.model ?? undefined));
      setEditingEffort(isNativeExecutor(newExecutor) ? currentEffort : (choice.overrides?.thinking ?? undefined));
    } else {
      // Switching to a different executor: default to undefined (engine/profile default)
      setEditingModel(undefined);
      setEditingEffort(undefined);
    }
    if (isNarrow) {
      setNarrowPage('models');
    }
  }, [choice.executor, choice.overrides?.model, choice.overrides?.thinking, currentModel, currentEffort, isNarrow]);

  // Handle reset to defaults
  const handleResetDefaults = useCallback(() => {
    if (activeProfile && activeProfileDefaultExecutor) {
      setEditingExecutor(activeProfileDefaultExecutor);
    } else {
      setEditingExecutor(NATIVE_EXECUTOR);
    }
    setEditingModel(undefined);
    setEditingEffort(undefined);
    setModelSearch('');
    if (isNarrow) {
      setNarrowPage('models');
    }
  }, [activeProfile, activeProfileDefaultExecutor, isNarrow]);

  const profileResetLabel = (activeProfile && activeProfile.name !== 'agent') ? activeProfile.name : undefined;
  const resetDefaultsLabel = profileResetLabel
    ? (locale === 'zh' ? `恢复${profileResetLabel}默认` : `Reset to ${profileResetLabel} default`)
    : (locale === 'zh' ? '恢复默认' : 'Reset to default');

  // Handle apply selection
  const isSwitchingExecutor = editingExecutor !== choice.executor;
  const applyButtonLabel = (isSwitchingExecutor || onRequireSwitchConfirmation)
    ? (locale === 'zh' ? '继续' : 'Continue')
    : (locale === 'zh' ? '用于下一条' : 'Apply for next');

  const handleApply = useCallback(() => {
    const nextProfile = (editingExecutor !== choice.executor && choice.profile === 'agent')
      ? undefined
      : choice.profile;
    const hasOverrides = editingModel !== undefined || editingEffort !== undefined;
    const nextChoice: ExecutionChoice = {
      ...choice,
      executor: editingExecutor,
      profile: nextProfile,
      overrides: hasOverrides ? {
        model: editingModel ?? null,
        thinking: editingEffort ?? undefined,
      } : (choice.overrides !== undefined ? { model: null, thinking: null } : undefined),
    };
    if (choice.external_connection_id !== undefined) {
      delete (nextChoice as unknown as Record<string, unknown>)['external_connection_id'];
      delete (nextChoice as unknown as Record<string, unknown>)['external_connection_name'];
    }
    onChange(nextChoice);
    if (isNativeExecutor(editingExecutor)) {
      if (onChangeModel) void onChangeModel(editingModel);
      if (onChangeEffort && editingEffort) onChangeEffort(editingEffort);
    }
    close(true);
  }, [choice, editingExecutor, editingModel, editingEffort, onChange, onChangeModel, onChangeEffort, close]);

  // Format trigger label: Engine · Model · Effort
  const triggerLabel = useMemo(() => {
    if (choice.external_connection_id !== undefined) {
      return choice.external_connection_name ?? t('st.section.connectionServices');
    }
    if (isNativeExecutor(choice.executor)) {
      const resolvedModel = currentModel ? (resolveCatalogModel(models ?? [], currentModel)?.display_name ?? currentModel) : (effectiveModel ?? modelShortLabel ?? 'K3');
      const parts = [nativeLabel, resolvedModel, currentEffort].filter(Boolean);
      return parts.join(' · ');
    }
    const targetModel = choice.overrides?.model;
    const targetEffort = choice.overrides?.thinking;
    if (targetModel) {
      const parts = [engineLabel, targetModel, targetEffort].filter(Boolean);
      return parts.join(' · ');
    }
    return `${engineLabel} · ${t('composer.engineModelFollow')}`;
  }, [choice, isNativeExecutor, currentModel, models, effectiveModel, modelShortLabel, currentEffort, nativeLabel, engineLabel, t]);

  // Diagnostics statusLine for external engines
  const statusLine = useMemo(() => {
    if (isNativeExecutor(choice.executor) || !executorCapabilities) return undefined;
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
  }, [choice.executor, executorCapabilities, t, executorReportedModels.length, executorRefreshFailed]);

  // Diagnostics title for external engines
  const externalDiagnosticTitle = useMemo(() => {
    if (isNativeExecutor(choice.executor) || !executorCapabilities) return undefined;
    const switchControl = executorCapabilities.controls.model_switch;
    const switchLine = switchControl.kind === 'unavailable'
      ? [t('composer.engineModelSwitchUnavailable'), switchControl.diagnostic]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ')
      : undefined;
    return [engineLabel, statusLine, switchLine].filter(Boolean).join(' · ') || undefined;
  }, [choice.executor, executorCapabilities, t, statusLine, engineLabel]);

  const isExternalClient = choice.external_connection_id !== undefined;

  // Filtered native models
  const filteredNativeModels = useMemo(() => {
    const list = models ?? [];
    const q = modelSearch.trim().toLowerCase();
    if (q === '') return list;
    return list.filter((m) =>
      `${m.id} ${m.display_name ?? ''} ${m.provider_id}`.toLowerCase().includes(q)
    );
  }, [models, modelSearch]);

  // Filtered external models
  const filteredExternalModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (q === '') return executorReportedModels;
    return executorReportedModels.filter((val) => val.toLowerCase().includes(q));
  }, [executorReportedModels, modelSearch]);

  // Default option details for editingExecutor
  const editingProfileDefault = useMemo(() => {
    if (!activeProfile || profileExecutor(activeProfile) !== editingExecutor) {
      return undefined;
    }
    return activeProfileDefaults;
  }, [activeProfile, activeProfileDefaults, editingExecutor]);

  const profileDefaultName = (activeProfile && activeProfile.name !== 'agent') ? activeProfile.name : nativeLabel;
  const defaultOptionTitle = editingProfileDefault
    ? (locale === 'zh'
        ? `使用 ${profileDefaultName} 默认`
        : `Use ${profileDefaultName} default`)
    : (locale === 'zh'
        ? `使用 ${editingEngineLabel} 默认`
        : `Use ${editingEngineLabel} default`);

  const defaultOptionPreview = editingProfileDefault
    ? [editingProfileDefault.model, editingProfileDefault.thinking].filter(Boolean).join(' · ')
    : undefined;

  const isEditingDefaultSelected = editingModel === undefined || editingModel === '';

  // Resolved catalog model for editingModel in native execution
  const resolvedEditingModel = useMemo(() => {
    if (!isNativeExecutor(editingExecutor)) return undefined;
    const targetId = editingModel ?? currentModel ?? effectiveModel;
    return targetId ? resolveCatalogModel(models ?? [], targetId) : undefined;
  }, [editingExecutor, editingModel, currentModel, effectiveModel, models]);

  // Supported effort levels for current editing model/engine
  const displayEfforts = useMemo((): readonly string[] => {
    if (isNativeExecutor(editingExecutor)) {
      const modelEfforts = resolvedEditingModel?.support_efforts;
      if (modelEfforts !== undefined) {
        return sortThinkingEffortsForDisplay(modelEfforts);
      }
      return sortThinkingEffortsForDisplay(efforts ?? []);
    }
    return executorEffortLevels;
  }, [editingExecutor, resolvedEditingModel, efforts, executorEffortLevels]);

  const handleSelectModel = useCallback((modelId: string | undefined) => {
    setEditingModel(modelId);
    if (modelId === undefined) {
      setEditingEffort(undefined);
      return;
    }
    if (isNativeExecutor(editingExecutor)) {
      const nextCatalog = resolveCatalogModel(models ?? [], modelId);
      const nextEfforts = nextCatalog?.support_efforts ?? [];
      if (editingEffort && !nextEfforts.includes(editingEffort)) {
        setEditingEffort(undefined);
      }
    } else {
      if (editingEffort && !executorEffortLevels.includes(editingEffort)) {
        setEditingEffort(undefined);
      }
    }
  }, [editingExecutor, models, editingEffort, executorEffortLevels]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(true);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && open) {
      e.preventDefault();
      e.stopPropagation();
      handleApply();
    } else {
      popoverKeyDown(e);
    }
  }, [open, close, handleApply, popoverKeyDown]);

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
        data-composer-engine-model={isNativeExecutor(choice.executor) ? undefined : engineLabel}
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
        className={`${STATUS_SEGMENT_CLASS} max-w-64 ${pending ? 'pr-5 font-medium text-accent-ink hover:text-accent-ink' : choice.executor !== NATIVE_EXECUTOR || isExternalClient ? STATUS_SEGMENT_SET : ''} disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <Icon
          name={isExternalClient ? 'external' : isNativeExecutor(choice.executor) ? 'agent' : 'terminal'}
          size={14}
          className={STATUS_SEGMENT_ICON_CLASS}
        />
        <span className="min-w-0 truncate">
          {pending ? t('composer.execution.pendingSuffix', { name: triggerLabel }) : triggerLabel}
        </span>
      </button>

      {!isNativeExecutor(choice.executor) && onRefreshExecutorModels && (executorCapabilities?.freshness === 'stale' || executorRefreshFailed) ? (
        <button
          type="button"
          data-external-model-refresh
          disabled={executorRefreshBusy}
          onClick={(e) => {
            e.stopPropagation();
            onRefreshExecutorModels();
          }}
          aria-label={t('composer.engineCapabilityRefreshAria')}
          title={t('composer.engineCapabilityRefreshAria')}
          className="rounded p-1 text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
        >
          <Icon name="refresh" size={12} />
        </button>
      ) : null}

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
        isNarrow ? (
          /* Narrow Screen (< 640px / 390px): Bottom Sheet with Drill-down Navigation */
          <div
            data-execution-panel
            role="dialog"
            aria-modal="true"
            aria-label={t('composer.execution.panelLabel')}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-xl border-t border-hairline bg-paper shadow-2xl"
          >
            {narrowPage === 'models' ? (
              <>
                <div className="flex items-center justify-between border-b border-hairline px-3 py-2 shrink-0">
                  <button
                    type="button"
                    data-execution-narrow-back
                    onClick={() => { setNarrowPage('engines'); }}
                    className="flex items-center gap-1 text-[13px] font-medium text-ink hover:text-selected-ink"
                  >
                    <Icon name="arrowLeft" size={14} />
                    <span>{editingEngineLabel}</span>
                  </button>
                  <span className="text-[13px] font-medium text-ink-soft">
                    {locale === 'zh' ? '运行方式' : 'Execution'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { close(true); }}
                    className="rounded p-1 text-ink-faint hover:text-ink"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
                  {!isNativeExecutor(editingExecutor) && statusLine !== undefined ? (
                    <div data-external-model-status className="text-[11.5px] leading-snug text-ink-faint">
                      <p data-external-model-refresh-error={executorRefreshFailed ? true : undefined} className="truncate" title={statusLine}>
                        {statusLine}
                      </p>
                    </div>
                  ) : null}

                  <input
                    type="text"
                    data-execution-model-search
                    value={modelSearch}
                    onChange={(e) => { setModelSearch(e.target.value); }}
                    placeholder={locale === 'zh' ? '搜索模型' : 'Search models'}
                    className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus-visible:border-selected-ink placeholder:text-ink-faint"
                  />

                  {/* Default Row */}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isEditingDefaultSelected}
                    data-execution-model-default
                    data-option-value=""
                    onClick={() => {
                      handleSelectModel(undefined);
                    }}
                    className={`${MENU_ROW_CLASS} items-start min-h-[44px] ${isEditingDefaultSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
                  >
                    <Check on={isEditingDefaultSelected} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-1">
                        <span className="font-medium text-ink">{defaultOptionTitle}</span>
                        {defaultOptionPreview ? (
                          <span className="text-[11.5px] text-ink-faint">{defaultOptionPreview}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>

                  {/* Models list */}
                  <div className="space-y-0.5">
                    {isNativeExecutor(editingExecutor) ? (
                      filteredNativeModels.map((m) => {
                        const sel = editingModel === m.id;
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
                            data-option-value={m.id}
                            onClick={() => {
                              handleSelectModel(m.id);
                            }}
                            className={`${MENU_ROW_CLASS} items-start min-h-[44px] ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
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
                      })
                    ) : (
                      filteredExternalModels.map((val) => {
                        const sel = editingModel === val;
                        return (
                          <button
                            key={val}
                            type="button"
                            role="option"
                            aria-selected={sel}
                            data-option-value={val}
                            onClick={() => {
                              handleSelectModel(val);
                            }}
                            className={`${MENU_ROW_CLASS} items-start min-h-[44px] ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
                          >
                            <Check on={sel} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium text-ink">{val}</span>
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>

                  {/* Thinking Effort */}
                  {displayEfforts.length > 0 ? (
                    <div className="border-t border-hairline pt-2.5">
                      <p className="mb-1 text-[12px] font-medium text-ink-faint">
                        {locale === 'zh' ? '思考强度' : 'Thinking effort'}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={editingEffort === undefined}
                          onClick={() => { setEditingEffort(undefined); }}
                          className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
                            editingEffort === undefined
                              ? 'bg-ink text-paper'
                              : 'bg-panel text-ink hover:text-selected-ink'
                          }`}
                        >
                          {locale === 'zh' ? '默认' : 'Default'}
                        </button>
                        {displayEfforts.map((level: string) => (
                          <button
                            key={level}
                            type="button"
                            role="radio"
                            aria-checked={editingEffort === level}
                            data-effort={level}
                            onClick={() => { setEditingEffort(level); }}
                            className={`rounded px-2.5 py-1 text-[12px] font-medium capitalize transition-colors ${
                              editingEffort === level
                                ? 'bg-ink text-paper'
                                : 'bg-panel text-ink hover:text-selected-ink'
                            }`}
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between border-t border-hairline px-3 py-2 shrink-0 bg-paper">
                  <button
                    type="button"
                    onClick={handleResetDefaults}
                    className="text-[12px] text-ink-soft hover:text-ink underline decoration-dotted"
                  >
                    {resetDefaultsLabel}
                  </button>
                  <button
                    type="button"
                    data-execution-apply
                    onClick={handleApply}
                    className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-paper hover:opacity-90"
                  >
                    {applyButtonLabel}
                  </button>
                </div>
              </>
            ) : (
              /* Narrow Page: Engines List */
              <>
                <div className="flex items-center justify-between border-b border-hairline px-3 py-2 shrink-0">
                  <span className="text-[13px] font-medium text-ink">
                    {locale === 'zh' ? '选择引擎' : 'Select Engine'}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setNarrowPage('models'); }}
                    className="rounded p-1 text-ink-faint hover:text-ink"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  <div data-execution-engine="native">
                    <button
                      type="button"
                      role="option"
                      aria-selected={editingExecutor === NATIVE_EXECUTOR}
                      data-execution-bare="native"
                      onClick={() => { handleSelectExecutor(NATIVE_EXECUTOR); }}
                      className={`${MENU_ROW_CLASS} min-h-[44px] ${editingExecutor === NATIVE_EXECUTOR ? MENU_ROW_SELECTED_CLASS : ''}`}
                    >
                      <Check on={editingExecutor === NATIVE_EXECUTOR} />
                      <span className="font-medium text-ink">{nativeLabel}</span>
                    </button>
                  </div>
                  {externalEngines.map((item) => (
                    <div key={item.id} data-execution-engine={item.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={editingExecutor === item.id}
                        data-execution-bare={item.id}
                        onClick={() => { handleSelectExecutor(item.id); }}
                        className={`${MENU_ROW_CLASS} min-h-[44px] ${editingExecutor === item.id ? MENU_ROW_SELECTED_CLASS : ''}`}
                      >
                        <Check on={editingExecutor === item.id} />
                        <span className="font-medium text-ink">{item.label}</span>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          /* Desktop Layout (>= 640px): 620px Two-Column Panel */
          <div
            data-execution-panel
            role="dialog"
            aria-label={t('composer.execution.panelLabel')}
            className={`anim-enter ${COMPOSER_PANEL_START} flex max-h-[min(var(--cp-max-h,none),32rem)] w-[620px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-[10px] border border-hairline bg-paper shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]`}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-hairline px-3 py-2 shrink-0">
              <span className="text-[12.5px] font-medium text-ink">
                {locale === 'zh' ? '运行方式' : 'Execution Mode'}
              </span>
              <button
                type="button"
                onClick={() => { close(true); }}
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-ink hover:bg-paper"
              >
                {t('common.close')}
              </button>
            </div>

            {/* Body: Two columns */}
            <div className="flex flex-row flex-1 min-h-0 min-h-[220px] divide-x divide-hairline overflow-hidden">
              {/* Left Column: Engines (w-48) */}
              <div className="w-48 shrink-0 flex flex-col overflow-y-auto p-1.5 bg-panel/30 space-y-0.5">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                  {locale === 'zh' ? '引擎' : 'Engines'}
                </div>

                {/* Native row */}
                <div data-execution-engine="native" data-current={choice.executor === NATIVE_EXECUTOR ? 'true' : undefined}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={editingExecutor === NATIVE_EXECUTOR}
                    data-menu-row
                    data-execution-bare="native"
                    onClick={() => { handleSelectExecutor(NATIVE_EXECUTOR); }}
                    className={`${MENU_ROW_CLASS} items-start ${editingExecutor === NATIVE_EXECUTOR ? MENU_ROW_SELECTED_CLASS : ''}`}
                  >
                    <Check on={editingExecutor === NATIVE_EXECUTOR} />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{nativeLabel}</span>
                  </button>
                </div>

                {/* External engines */}
                {externalEngines.map((item) => {
                  const duplicateLabel = (externalLabelCounts.get(item.label) ?? 0) > 1;
                  const hint = duplicateLabel
                    ? [item.id, item.version].filter((part) => part !== undefined && part !== '').join(' · ')
                    : undefined;
                  const isCurrent = editingExecutor === item.id;
                  return (
                    <div key={item.id} data-execution-engine={item.id} data-current={choice.executor === item.id ? 'true' : undefined}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        data-menu-row
                        data-execution-bare={item.id}
                        onClick={() => { handleSelectExecutor(item.id); }}
                        className={`${MENU_ROW_CLASS} items-start ${isCurrent ? MENU_ROW_SELECTED_CLASS : ''} ${item.status === 'unavailable' ? 'opacity-70' : ''}`}
                      >
                        <Check on={isCurrent} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-ink">{item.label}</span>
                          {hint ? (
                            <span className="block truncate font-mono text-[10.5px] text-ink-faint">{hint}</span>
                          ) : null}
                        </span>
                      </button>
                    </div>
                  );
                })}

                {/* Retained External if bound unavailable */}
                {retainedExternal ? (
                  <div data-execution-restore={choice.executor} className="mx-1 my-2 space-y-1 px-2 py-1.5 border-t border-hairline">
                    <p className="text-[11.5px] leading-snug text-ink-faint">
                      {t(engineItem?.status === 'unavailable' ? 'composer.execution.needsSetup' : 'composer.execution.keptEngine', { engine: engineLabel })}
                    </p>
                    <Link
                      to="/settings/ai?tab=providers#st-card-engines"
                      data-execution-configure
                      onClick={() => { close(); }}
                      className="text-[11.5px] font-medium text-ink underline decoration-dotted underline-offset-2"
                    >
                      {t('composer.execution.configure')}
                    </Link>
                  </div>
                ) : null}

                {/* External client connections */}
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

              {/* Right Column: Model Selection + Thinking Effort (flex-1) */}
              <div className="flex-1 min-w-0 flex flex-col p-3 overflow-y-auto gap-3">
                <div className="flex items-center justify-between border-b border-hairline pb-1.5">
                  <span className="font-medium text-[13px] text-ink">{editingEngineLabel}</span>
                  {!isNativeExecutor(editingExecutor) && onRefreshExecutorModels ? (
                    <button
                      type="button"
                      data-external-model-refresh
                      disabled={executorRefreshBusy}
                      onClick={onRefreshExecutorModels}
                      className="text-[11px] text-ink-faint hover:text-ink disabled:opacity-50"
                    >
                      {executorRefreshBusy ? t('composer.engineCapabilityRefreshing') : t('composer.engineCapabilityRefresh')}
                    </button>
                  ) : null}
                </div>

                {!isNativeExecutor(editingExecutor) && statusLine !== undefined ? (
                  <div data-external-model-status className="text-[11.5px] leading-snug text-ink-faint">
                    <p data-external-model-refresh-error={executorRefreshFailed ? true : undefined} className="truncate" title={statusLine}>
                      {statusLine}
                    </p>
                  </div>
                ) : null}

                {/* Model Search */}
                <input
                  type="text"
                  data-execution-model-search
                  value={modelSearch}
                  onChange={(e) => { setModelSearch(e.target.value); }}
                  placeholder={locale === 'zh' ? '搜索模型' : 'Search models'}
                  className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink outline-none focus-visible:border-selected-ink placeholder:text-ink-faint"
                />

                {/* Model list */}
                <div className="space-y-1 flex-1 overflow-y-auto max-h-48 pr-1">
                  {/* Default option */}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isEditingDefaultSelected}
                    data-execution-model-default
                    data-option-value=""
                    onClick={() => {
                      handleSelectModel(undefined);
                    }}
                    className={`${MENU_ROW_CLASS} items-start ${isEditingDefaultSelected ? MENU_ROW_SELECTED_CLASS : ''}`}
                  >
                    <Check on={isEditingDefaultSelected} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-1">
                        <span className="font-medium text-ink">{defaultOptionTitle}</span>
                        {defaultOptionPreview ? (
                          <span className="text-[11.5px] text-ink-faint">{defaultOptionPreview}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>

                  {/* Catalog models */}
                  {isNativeExecutor(editingExecutor) ? (
                    filteredNativeModels.map((m) => {
                      const sel = editingModel === m.id;
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
                          data-option-value={m.id}
                          onClick={() => {
                            handleSelectModel(m.id);
                          }}
                          className={`${MENU_ROW_CLASS} items-start ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
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
                    })
                  ) : (
                    filteredExternalModels.map((val) => {
                      const sel = editingModel === val;
                      return (
                        <button
                          key={val}
                          type="button"
                          role="option"
                          aria-selected={sel}
                          data-option-value={val}
                          onClick={() => {
                            handleSelectModel(val);
                          }}
                          className={`${MENU_ROW_CLASS} items-start ${sel ? MENU_ROW_SELECTED_CLASS : ''}`}
                        >
                          <Check on={sel} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink">{val}</span>
                          </span>
                        </button>
                      );
                    })
                  )}

                  {!isNativeExecutor(editingExecutor) && editingModel !== undefined && editingModel !== '' && !filteredExternalModels.includes(editingModel) ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected="true"
                      data-option-value={editingModel}
                      onClick={() => {}}
                      className={`${MENU_ROW_CLASS} items-start ${MENU_ROW_SELECTED_CLASS}`}
                    >
                      <Check on={true} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{editingModel}</span>
                        <span className="mt-0.5 inline-block rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          {t('composer.engineModelNotInList')}
                        </span>
                      </span>
                    </button>
                  ) : null}

                  {!isNativeExecutor(editingExecutor) && modelSearch.trim() !== '' && !filteredExternalModels.includes(modelSearch.trim()) ? (
                    <button
                      type="button"
                      role="option"
                      onClick={() => { setEditingModel(modelSearch.trim()); }}
                      className={`${MENU_ROW_CLASS} text-selected-ink font-medium`}
                    >
                      <Check on={editingModel === modelSearch.trim()} />
                      <span className="min-w-0 flex-1 truncate">
                        {locale === 'zh' ? `使用模型 ID "${modelSearch.trim()}"` : `Use model ID "${modelSearch.trim()}"`}
                      </span>
                    </button>
                  ) : null}
                </div>

                {/* Thinking Effort Section */}
                {displayEfforts.length > 0 ? (
                  <div className="border-t border-hairline pt-2 shrink-0">
                    <p className="mb-1 text-[11.5px] font-medium text-ink-faint">
                      {locale === 'zh' ? '思考强度' : 'Thinking effort'}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={editingEffort === undefined}
                        onClick={() => { setEditingEffort(undefined); }}
                        className={`rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                          editingEffort === undefined
                            ? 'bg-ink text-paper'
                            : 'bg-panel text-ink hover:text-selected-ink'
                        }`}
                      >
                        {locale === 'zh' ? '默认' : 'Default'}
                      </button>
                      {displayEfforts.map((level: string) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={editingEffort === level}
                          data-effort={level}
                          onClick={() => { setEditingEffort(level); }}
                          className={`rounded px-2 py-0.5 text-[11.5px] font-medium capitalize transition-colors ${
                            editingEffort === level
                              ? 'bg-ink text-paper'
                              : 'bg-panel text-ink hover:text-selected-ink'
                          }`}
                        >
                          {level}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-hairline px-3 py-2 bg-paper shrink-0">
              <button
                type="button"
                onClick={handleResetDefaults}
                className="text-[12px] text-ink-soft hover:text-ink underline decoration-dotted"
              >
                {resetDefaultsLabel}
              </button>
              <button
                type="button"
                data-execution-apply
                onClick={handleApply}
                className="rounded bg-ink px-3.5 py-1 text-[12px] font-medium text-paper hover:opacity-90 transition-opacity"
              >
                {applyButtonLabel}
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}

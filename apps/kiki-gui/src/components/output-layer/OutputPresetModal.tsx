/**
 * OutputPresetModal — the create/edit panel for Output Layer presets (the
 * side-panel tier: one form that walks one object, never stacked over the
 * preset picker). Direct access to saveable preset configurations without
 * credential duplication.
 */

import { useState, useId, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOptionalConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Icon } from '../icons';
import { SearchableSelect } from '../SearchableSelect';
import { SidePanel } from '../SidePanel';
import { buildCatalogModelOptions, useProviderGroupLabel } from '../modelSelectOptions';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, SMALL_INPUT } from '../ui';
import type { OutputLayerPreset, OutputLayerSettings } from './types';
import { useOutputLayer } from './outputLayerStore';
import { useOutputLayerClient } from './useOutputLayerClient';

export function OutputPresetModal({
  preset,
  open,
  onClose,
  onSaved,
  sessionId,
}: {
  preset?: OutputLayerPreset | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (savedPreset: OutputLayerPreset) => void;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const clientApi = connection?.client;
  const outputClient = useOutputLayerClient(sessionId);
  const { settings: currentSettings, configuration, contextKey, savePreset, deletePreset } = useOutputLayer(sessionId);
  const queryClient = useQueryClient();
  const scopeKey = connection?.spaceKey ?? connection?.scopeId ?? 'local';
  const serverId = connection?.meta?.server_id ?? '';
  const activeContext = useRef(contextKey);
  activeContext.current = contextKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const templates = configuration?.templates ?? [];
  const initialTemplate = templates.find((item) => item.id === 'custom') ?? templates[0];

  const isEditing = preset !== undefined && preset !== null;
  const overlayId = useId();

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [templateId, setTemplateId] = useState(initialTemplate?.id ?? '');
  const [label, setLabel] = useState(preset?.label ?? initialTemplate?.label ?? t('outputPreset.defaultLabel'));
  const [instruction, setInstruction] = useState(preset?.instruction ?? initialTemplate?.instruction ?? '');
  const [modelMode, setModelMode] = useState<'catalog' | 'custom'>(
    preset?.connectionId || preset?.customModelId ? 'custom' : 'catalog',
  );
  const [modelId, setModelId] = useState(preset?.modelId ?? '');
  const [connectionId, setConnectionId] = useState(preset?.connectionId ?? '');
  const [customModelId, setCustomModelId] = useState(preset?.customModelId ?? '');
  const [contextWindow, setContextWindow] = useState(preset?.contextWindow ?? initialTemplate?.contextWindow ?? 32768);
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>(
    preset?.maxOutputTokens !== undefined && preset?.maxOutputTokens !== null
      ? String(preset.maxOutputTokens)
      : '',
  );

  const [groupChars, setGroupChars] = useState(currentSettings?.groupChars ?? 600);
  const [preloadBefore, setPreloadBefore] = useState(currentSettings?.preloadBefore ?? 1);
  const [preloadAfter, setPreloadAfter] = useState(currentSettings?.preloadAfter ?? 1);
  const [historyTokens, setHistoryTokens] = useState(currentSettings?.historyTokens ?? 16384);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const isCustomIncomplete =
    modelMode === 'custom' && Boolean(connectionId.trim()) !== Boolean(customModelId.trim());

  // Load Kiki catalog models
  const modelsQuery = useQuery({
    queryKey: ['models', scopeKey, serverId],
    queryFn: () => clientApi!.listModels(),
    enabled: clientApi !== undefined,
    staleTime: 60_000,
  });

  // Load Kiki providers for custom model connections
  const providersQuery = useQuery({
    queryKey: ['providers', scopeKey, serverId],
    queryFn: () => clientApi!.listProviders(),
    enabled: clientApi !== undefined,
    staleTime: 60_000,
  });

  const providerGroupLabel = useProviderGroupLabel();

  const modelOptions = useMemo(() => {
    const items = modelsQuery.data?.items ?? [];
    return [
      {
        value: '',
        label: t('outputPreset.noModelLabel'),
        group: t('outputPreset.noModelGroup'),
        keywords: t('outputPreset.noModelKeywords'),
      },
      ...buildCatalogModelOptions(items, t, {
        groupLabel: providerGroupLabel,
        currentId: modelId,
      }),
    ];
  }, [modelsQuery.data, t, providerGroupLabel, modelId]);

  if (!open) return null;

  const handleSave = async () => {
    if (saving) return;
    setSaveError(null);
    if (isCustomIncomplete) {
      setSaveError(t('outputPreset.errorCustomPair'));
      return;
    }
    const trimmedMaxTokens = maxOutputTokens.trim();
    const nextMaxTokens = trimmedMaxTokens === '' ? undefined : Number(trimmedMaxTokens);
    if (nextMaxTokens !== undefined && (!Number.isFinite(nextMaxTokens) || !Number.isInteger(nextMaxTokens) || nextMaxTokens <= 0)) {
      setSaveError(t('outputPreset.errorMaxTokens'));
      return;
    }
    if (!label.trim() || !instruction.trim()) {
      setSaveError(t('outputPreset.errorRequired'));
      return;
    }
    const nextPreset: OutputLayerPreset = {
      id: preset?.id ?? crypto.randomUUID(),
      label: label.trim(),
      instruction: instruction.trim(),
      modelId: modelMode === 'catalog' ? modelId.trim() || undefined : undefined,
      connectionId: modelMode === 'custom' ? connectionId.trim() || undefined : undefined,
      customModelId: modelMode === 'custom' ? customModelId.trim() || undefined : undefined,
      contextWindow,
      maxOutputTokens: nextMaxTokens,
    };
    const nextSettings: OutputLayerSettings = {
      groupChars: Math.max(80, Math.min(10000, Number(groupChars) || 600)),
      preloadBefore: Math.max(0, Math.min(20, isNaN(Number(preloadBefore)) ? 1 : Number(preloadBefore))),
      preloadAfter: Math.max(0, Math.min(20, isNaN(Number(preloadAfter)) ? 1 : Number(preloadAfter))),
      historyTokens: Math.max(0, Math.min(1048576, isNaN(Number(historyTokens)) ? 16384 : Number(historyTokens))),
    };
    const savingContext = contextKey;
    setSaving(true);
    try {
      await savePreset(nextPreset, { settings: nextSettings, client: outputClient, sessionId });
      if (!mounted.current || activeContext.current !== savingContext) return;
      void queryClient.invalidateQueries({ queryKey: ['plugin', 'output-layer-configuration'] });
      onSaved?.(nextPreset);
      onClose();
    } catch (err: unknown) {
      if (mounted.current && activeContext.current === savingContext) {
        setSaveError(err instanceof Error ? err.message : t('outputPreset.errorSave'));
      }
    } finally {
      if (mounted.current && activeContext.current === savingContext) setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!preset?.id || saving) return;
    const deletingContext = contextKey;
    setSaving(true);
    setSaveError(null);
    try {
      await deletePreset(preset.id, { client: outputClient, sessionId });
      if (!mounted.current || activeContext.current !== deletingContext) return;
      void queryClient.invalidateQueries({ queryKey: ['plugin', 'output-layer-configuration'] });
      onClose();
    } catch (err: unknown) {
      if (mounted.current && activeContext.current === deletingContext) {
        setSaveError(err instanceof Error ? err.message : t('outputPreset.errorDelete'));
      }
    } finally {
      if (mounted.current && activeContext.current === deletingContext) setSaving(false);
    }
  };

  return (
    <SidePanel
      title={isEditing ? t('outputPreset.editTitle') : t('outputPreset.addTitle')}
      overlayId={`output-preset-${overlayId}`}
      width="md"
      onClose={onClose}
      footer={(
        <>
          {isEditing ? (
            <button
              type="button"
              onClick={() => { void handleDelete(); }}
              disabled={saving}
              className={`rounded px-2.5 py-1 text-[12px] font-medium text-danger hover:bg-danger/10 ${
                saving ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {t('outputPreset.delete')}
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={SECONDARY_BUTTON}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={saving}
              className={`${PRIMARY_BUTTON} ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {saving ? t('outputPreset.saving') : t('outputPreset.save')}
            </button>
          </div>
        </>
      )}
    >
      <div className="space-y-4">
        {!isEditing && templates.length > 0 ? (
          <div>
            <label htmlFor={`${overlayId}-template`} className="mb-1 block text-[12px] font-medium text-ink-soft">{t('outputPreset.templateLabel')}</label>
            <select
              id={`${overlayId}-template`}
              aria-label={t('outputPreset.templateLabel')}
              className={INPUT}
              value={templateId}
              onChange={(event) => {
                const template = templates.find((item) => item.id === event.target.value);
                if (!template) return;
                setTemplateId(template.id);
                setLabel(template.label);
                setInstruction(template.instruction);
                setContextWindow(template.contextWindow);
                setModelMode('catalog');
                setModelId('');
                setConnectionId('');
                setCustomModelId('');
                setMaxOutputTokens('');
                setSaveError(null);
              }}
            >
              {templates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
            </select>
          </div>
        ) : null}

        {/* Preset Label */}
        <div>
          <label htmlFor={`${overlayId}-name`} className="mb-1 block text-[12px] font-medium text-ink-soft">{t('outputPreset.nameLabel')}</label>
          <input
            id={`${overlayId}-name`}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={INPUT}
            placeholder={t('outputPreset.namePlaceholder')}
          />
        </div>

        {/* Model Selection */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[12px] font-medium text-ink-soft">{t('outputPreset.modelLabel')}</label>
            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="modelMode"
                  checked={modelMode === 'catalog'}
                  onChange={() => setModelMode('catalog')}
                />
                {t('outputPreset.modeCatalog')}
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="modelMode"
                  checked={modelMode === 'custom'}
                  onChange={() => setModelMode('custom')}
                />
                {t('outputPreset.modeCustom')}
              </label>
            </div>
          </div>

          {modelMode === 'catalog' ? (
            <SearchableSelect
              value={modelId}
              options={modelOptions}
              onChange={setModelId}
              ariaLabel={t('outputPreset.selectModelAria')}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`${overlayId}-connection`} className="sr-only">{t('outputPreset.connectionLabel')}</label>
                <select
                  id={`${overlayId}-connection`}
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">{t('outputPreset.connectionPlaceholder')}</option>
                  {(providersQuery.data?.items ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.id} ({provider.type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${overlayId}-custom-model`} className="sr-only">{t('outputPreset.customModelLabel')}</label>
                <input
                  id={`${overlayId}-custom-model`}
                  type="text"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                  className={INPUT}
                  placeholder={t('outputPreset.customModelPlaceholder')}
                />
              </div>
            </div>
          )}
        </div>

        {/* System Instruction */}
        <div>
          <label htmlFor={`${overlayId}-instruction`} className="mb-1 block text-[12px] font-medium text-ink-soft">{t('outputPreset.instructionLabel')}</label>
          <textarea
            id={`${overlayId}-instruction`}
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className={`${INPUT} resize-none font-mono text-[12px]`}
            placeholder={t('outputPreset.instructionPlaceholder')}
          />
        </div>

        {/* Collapsible Advanced Settings */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-[12px] font-medium text-ink-faint hover:text-ink"
          >
            <Icon
              name="chevron"
              size={12}
              className={showAdvanced ? 'rotate-90 transition-transform' : 'transition-transform'}
            />
            {t('outputPreset.advancedToggle')}
          </button>

          {showAdvanced ? (
            <div className="mt-2.5 space-y-3 rounded-lg border border-hairline bg-paper/60 p-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor={`${overlayId}-group-chars`} className="mb-1 block text-[11px] font-medium text-ink-soft">{t('outputPreset.groupCharsLabel')}</label>
                  <input
                    id={`${overlayId}-group-chars`}
                    type="number"
                    value={groupChars}
                    onChange={(e) => setGroupChars(parseInt(e.target.value, 10) || 600)}
                    className={SMALL_INPUT + ' w-full'}
                    min={80}
                    max={2000}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">{t('outputPreset.groupCharsHint')}</span>
                </div>
                <div>
                  <label htmlFor={`${overlayId}-preload-before`} className="mb-1 block text-[11px] font-medium text-ink-soft">{t('outputPreset.preloadBeforeLabel')}</label>
                  <input
                    id={`${overlayId}-preload-before`}
                    type="number"
                    value={preloadBefore}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPreloadBefore(v === '' ? 0 : Math.max(0, parseInt(v, 10) || 0));
                    }}
                    className={SMALL_INPUT + ' w-full'}
                    min={0}
                    max={5}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">{t('outputPreset.preloadHint')}</span>
                </div>
                <div>
                  <label htmlFor={`${overlayId}-preload-after`} className="mb-1 block text-[11px] font-medium text-ink-soft">{t('outputPreset.preloadAfterLabel')}</label>
                  <input
                    id={`${overlayId}-preload-after`}
                    type="number"
                    value={preloadAfter}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPreloadAfter(v === '' ? 0 : Math.max(0, parseInt(v, 10) || 0));
                    }}
                    className={SMALL_INPUT + ' w-full'}
                    min={0}
                    max={5}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">{t('outputPreset.preloadHint')}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`${overlayId}-max-output`} className="mb-1 block text-[11px] font-medium text-ink-soft">{t('outputPreset.maxOutputLabel')}</label>
                  <input
                    id={`${overlayId}-max-output`}
                    type="text"
                    inputMode="numeric"
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(e.target.value)}
                    className={SMALL_INPUT + ' w-full'}
                    placeholder={t('outputPreset.maxOutputPlaceholder')}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">
                    {t('outputPreset.maxOutputHint')}
                  </span>
                </div>
                <div>
                  <label htmlFor={`${overlayId}-history`} className="mb-1 block text-[11px] font-medium text-ink-soft">{t('outputPreset.historyLabel')}</label>
                  <input
                    id={`${overlayId}-history`}
                    type="number"
                    value={historyTokens}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryTokens(v === '' ? 0 : Math.max(0, parseInt(v, 10) || 0));
                    }}
                    className={SMALL_INPUT + ' w-full'}
                    min={0}
                    max={1048576}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">
                    {t('outputPreset.historyHint')}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {saveError ? (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {saveError}
          </div>
        ) : null}
      </div>
    </SidePanel>
  );
}

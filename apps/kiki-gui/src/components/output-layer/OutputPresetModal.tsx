/**
 * OutputPresetModal — dialog for creating and editing Output Layer presets.
 * Direct access to saveable preset configurations without credential duplication.
 */

import { useState, useId, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOptionalConnection } from '../../state/connection';
import { useI18n } from '../../i18n';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { Icon } from '../icons';
import { SearchableSelect } from '../SearchableSelect';
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
  const [label, setLabel] = useState(preset?.label ?? initialTemplate?.label ?? '新预设');
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
        label: '未选择模型 (保持原文，不触发处理)',
        group: '未设置',
        keywords: 'none empty 未选择 留空',
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
      setSaveError('自定义模型需要同时选择已有连接并填写模型 ID。');
      return;
    }
    const trimmedMaxTokens = maxOutputTokens.trim();
    const nextMaxTokens = trimmedMaxTokens === '' ? undefined : Number(trimmedMaxTokens);
    if (nextMaxTokens !== undefined && (!Number.isFinite(nextMaxTokens) || !Number.isInteger(nextMaxTokens) || nextMaxTokens <= 0)) {
      setSaveError('输出上限必须是正整数；留空则不额外限制。');
      return;
    }
    if (!label.trim() || !instruction.trim()) {
      setSaveError('请填写预设名称和提示词。');
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
        setSaveError(err instanceof Error ? err.message : '保存失败，请重试');
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
        setSaveError(err instanceof Error ? err.message : '删除失败，请重试');
      }
    } finally {
      if (mounted.current && activeContext.current === deletingContext) setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? '编辑输出层预设' : '添加输出层预设'}
      overlayId={overlayId}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Icon name="sliders" size={16} />
            </span>
            <h2 className="text-[15px] font-semibold text-ink">
              {isEditing ? '编辑预设' : '新增预设'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint hover:bg-ink/[0.04] hover:text-ink"
            aria-label="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {!isEditing && templates.length > 0 ? (
          <div>
            <label htmlFor={`${overlayId}-template`} className="mb-1 block text-[12px] font-medium text-ink-soft">内置模板</label>
            <select
              id={`${overlayId}-template`}
              aria-label="内置模板"
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
          <label className="mb-1 block text-[12px] font-medium text-ink-soft">预设名称</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={INPUT}
            placeholder="例如：流式翻译"
          />
        </div>

        {/* Model Selection */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[12px] font-medium text-ink-soft">处理模型</label>
            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="modelMode"
                  checked={modelMode === 'catalog'}
                  onChange={() => setModelMode('catalog')}
                />
                从模型目录选择
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="modelMode"
                  checked={modelMode === 'custom'}
                  onChange={() => setModelMode('custom')}
                />
                已有连接自定义模型 ID
              </label>
            </div>
          </div>

          {modelMode === 'catalog' ? (
            <SearchableSelect
              value={modelId}
              options={modelOptions}
              onChange={setModelId}
              ariaLabel="选择模型"
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <select
                  value={connectionId}
                  onChange={(e) => setConnectionId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">选择连接 / 提供商...</option>
                  {(providersQuery.data?.items ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.id} ({provider.type})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <input
                  type="text"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                  className={INPUT}
                  placeholder="输入自定义模型 ID (如 gemini-2.0-flash)"
                />
              </div>
            </div>
          )}
          {isCustomIncomplete ? (
            <p className="mt-1 text-[11px] text-danger">
              自定义模型需要同时选择已有连接并填写模型 ID。
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-ink-faint">
              复用 Kiki 已有连接凭证，无需重复输入 API Key。
            </p>
          )}
        </div>

        {/* System Instruction */}
        <div>
          <label className="mb-1 block text-[12px] font-medium text-ink-soft">提示词指令</label>
          <textarea
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            className={`${INPUT} resize-none font-mono text-[12px]`}
            placeholder="提示词指令..."
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
            高级参数 (分组大小、预加载与 Token 预算)
          </button>

          {showAdvanced ? (
            <div className="mt-2.5 space-y-3 rounded-lg border border-hairline bg-paper/60 p-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-soft">单组字符数 (Unicode)</label>
                  <input
                    type="number"
                    value={groupChars}
                    onChange={(e) => setGroupChars(parseInt(e.target.value, 10) || 600)}
                    className={SMALL_INPUT + ' w-full'}
                    min={80}
                    max={2000}
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">默认 600</span>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-soft">向前预加载组数</label>
                  <input
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
                  <span className="mt-0.5 block text-[10px] text-ink-faint">默认 1</span>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-soft">向后预加载组数</label>
                  <input
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
                  <span className="mt-0.5 block text-[10px] text-ink-faint">默认 1</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-soft">单次输出预算 (Tokens)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(e.target.value)}
                    className={SMALL_INPUT + ' w-full'}
                    placeholder="不限制"
                  />
                  <span className="mt-0.5 block text-[10px] text-ink-faint">
                    单组最大输出 tokens（默认不限制）
                  </span>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-ink-soft">历史预算 (Tokens)</label>
                  <input
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
                    历史上下文上限，0 为关闭（默认 16,384）
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {saveError ? (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {saveError}
          </div>
        ) : null}

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-hairline pt-3">
          <div>
            {isEditing ? (
              <button
                type="button"
                onClick={() => { void handleDelete(); }}
                disabled={saving}
                className={`rounded px-2.5 py-1 text-[12px] font-medium text-danger hover:bg-danger/10 ${
                  saving ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                删除预设
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={saving} className={SECONDARY_BUTTON}>
              取消
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={saving}
              className={`${PRIMARY_BUTTON} ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {saving ? '保存中...' : '保存预设'}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

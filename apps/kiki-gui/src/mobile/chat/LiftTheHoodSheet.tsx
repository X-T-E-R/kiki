import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { Block, ToolBlock } from '@kiki/session-core/session';

import { Icon } from '../../components/icons';
import { ActionSheet } from '../../components/overlays/ActionSheet';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';

export type HoodTab = 'info' | 'tools' | 'diff';

export interface MobileFileChange {
  readonly id: string;
  readonly path: string;
  readonly toolName: string;
  readonly added: number;
  readonly removed: number;
  readonly oldText?: string;
  readonly newText?: string;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'edit', 'write', 'apply_patch']);

function countLines(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  return value.split('\n').length;
}

export function extractFileChanges(blocks: readonly Block[]): readonly MobileFileChange[] {
  const changes: MobileFileChange[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool' || !FILE_EDIT_TOOLS.has(block.name)) continue;
    const args = (block.args && typeof block.args === 'object' ? block.args : {}) as Record<string, unknown>;
    const rawPath =
      typeof args['path'] === 'string'
        ? args['path']
        : typeof args['file_path'] === 'string'
          ? args['file_path']
          : typeof args['target'] === 'string'
            ? args['target']
            : block.description;
    if (rawPath === undefined || rawPath.trim() === '') continue;
    const oldText = typeof args['old_string'] === 'string' ? args['old_string'] : undefined;
    const newText =
      typeof args['new_string'] === 'string'
        ? args['new_string']
        : typeof args['content'] === 'string'
          ? args['content']
          : undefined;
    changes.push({
      id: block.id,
      path: rawPath.trim(),
      toolName: block.name,
      added: countLines(newText),
      removed: countLines(oldText),
      oldText,
      newText,
    });
  }
  return changes;
}

function formatToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2) ?? '';
  } catch {
    return '';
  }
}

interface LiftTheHoodSheetProps {
  readonly open: boolean;
  readonly initialTab: HoodTab;
  /** Opens the Changes tab on this file instead of the first one. */
  readonly initialChangeId?: string;
  /** Opens the info tab with the model list already expanded. */
  readonly initialModelPicker?: boolean;
  readonly onClose: () => void;
  readonly client: KikiClient;
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly sessionTitle: string;
  readonly currentModel?: string;
  readonly personaName?: string;
  readonly selectedModel?: string;
  readonly onSelectModel: (model: string | undefined) => void;
  readonly blocks: readonly Block[];
  readonly onOpenWorkbench: () => void;
}

export function LiftTheHoodSheet({
  open,
  initialTab,
  initialChangeId,
  initialModelPicker = false,
  onClose,
  client,
  spaceKey,
  spaceName,
  sessionTitle,
  currentModel,
  personaName,
  selectedModel,
  onSelectModel,
  blocks,
  onOpenWorkbench,
}: LiftTheHoodSheetProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<HoodTab>(initialTab);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // Every open starts from the caller's tab and file; nothing lingers from the last visit.
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelectedChangeId(initialChangeId ?? null);
    setModelPickerOpen(initialModelPicker);
    setExpandedToolId(null);
  }, [open, initialTab, initialChangeId, initialModelPicker]);

  useEffect(() => {
    if (!open || tab !== 'diff' || selectedChangeId === null) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-mobile-hood-change="${CSS.escape(selectedChangeId)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [open, tab, selectedChangeId]);

  const tools = useMemo(
    () => blocks.filter((block): block is ToolBlock => block.kind === 'tool'),
    [blocks],
  );
  const changes = useMemo(() => extractFileChanges(blocks), [blocks]);

  const modelsQuery = useQuery({
    queryKey: ['mobile-models', spaceKey, client.baseUrl],
    enabled: open && modelPickerOpen,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await client.listModels();
      return res.items.filter((model) => model.enabled !== false);
    },
  });

  if (!open) return null;

  const activeChange = changes.find((entry) => entry.id === selectedChangeId) ?? changes[0];

  const tabs: readonly { readonly id: HoodTab; readonly label: string }[] = [
    { id: 'info', label: t('mobile.chat.tabInfo') },
    { id: 'tools', label: `${t('mobile.chat.tabTools')} ${tools.length > 0 ? tools.length : ''}`.trim() },
    { id: 'diff', label: `${t('mobile.chat.tabDiff')} ${changes.length > 0 ? changes.length : ''}`.trim() },
  ];

  return (
    <ActionSheet
      role="dialog"
      ariaLabel={t('mobile.chat.hoodTitle')}
      overlayId="mobile-lift-hood"
      dataAttribute="data-mobile-hood-sheet"
      onClose={onClose}
      sheetClassName="kiki-space-switch-sheet max-h-[82dvh]! rounded-t-[24px]!"
    >
      <div className="kiki-mobile-sheet-grabber" aria-hidden="true" />
      <div className="flex items-center justify-between gap-2 pb-1 pl-4 pr-2">
        <h2 className="min-w-0 truncate text-[16px] font-semibold text-ink">{t('mobile.chat.hoodTitle')}</h2>
        <button
          type="button"
          aria-label={t('mobile.voice.cancel')}
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-faint hover:bg-ink/[0.06]"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b border-hairline/70 px-4 pb-3">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-mobile-hood-tab={entry.id}
            onClick={() => { setTab(entry.id); }}
            aria-pressed={tab === entry.id}
            className={`h-11 rounded-full px-4 text-[13.5px] font-medium transition-colors ${
              tab === entry.id ? 'bg-ink text-paper' : 'bg-canvas text-ink-soft'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {tab === 'info' ? (
          <div className="space-y-4">
            <div className="divide-y divide-hairline/70 rounded-2xl border border-hairline/80 bg-paper">
              <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                <span className="text-[13px] text-ink-faint">{t('mobile.space.label')}</span>
                <span className="min-w-0 truncate text-[14px] font-medium text-ink">{spaceName}</span>
              </div>
              {personaName !== undefined ? (
                <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                  <span className="text-[13px] text-ink-faint">{t('mobile.chat.personaLabel')}</span>
                  <span className="min-w-0 truncate text-[14px] font-medium text-ink">{personaName}</span>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => { setModelPickerOpen((prev) => !prev); }}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-3.5 py-3 text-left"
              >
                <span className="text-[13px] text-ink-faint">{t('mobile.chat.modelLabel')}</span>
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[14px] font-medium text-ink">
                  <span className="truncate">{selectedModel ?? currentModel ?? t('mobile.chat.defaultModel')}</span>
                  <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint ${modelPickerOpen ? 'rotate-90' : ''}`} />
                </span>
              </button>
            </div>

            {modelPickerOpen ? (
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-2xl border border-hairline/80 bg-paper p-2">
                {modelsQuery.isLoading ? (
                  <p className="px-2 py-3 text-[13px] text-ink-faint">{t('mobile.chat.modelLoading')}</p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectModel(undefined);
                        setModelPickerOpen(false);
                      }}
                      className="flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-[14px] text-ink hover:bg-ink/[0.04]"
                    >
                      <span>{t('mobile.chat.defaultModel')}</span>
                      {selectedModel === undefined ? <Icon name="check" size={14} /> : null}
                    </button>
                    {(modelsQuery.data ?? []).map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => {
                          onSelectModel(model.id);
                          setModelPickerOpen(false);
                        }}
                        className="flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-[14px] text-ink hover:bg-ink/[0.04]"
                      >
                        <span className="min-w-0 truncate">{model.display_name || model.id}</span>
                        {selectedModel === model.id ? <Icon name="check" size={14} className="shrink-0" /> : null}
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="px-1 text-[12px] text-ink-faint truncate">{sessionTitle}</p>
              <button
                type="button"
                data-mobile-hood-workbench
                onClick={() => {
                  onClose();
                  onOpenWorkbench();
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[14px] font-medium text-paper"
              >
                <Icon name="external" size={14} />
                <span>{t('mobile.chat.openWorkbench')}</span>
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'tools' ? (
          tools.length === 0 ? (
            <p className="py-10 text-center text-[13.5px] text-ink-faint">{t('mobile.chat.noTools')}</p>
          ) : (
            <div className="space-y-2">
              {tools.map((tool) => {
                const expanded = expandedToolId === tool.id;
                const outputText = formatToolOutput(tool.output);
                return (
                  <div key={tool.id} className="overflow-hidden rounded-2xl border border-hairline/80 bg-paper">
                    <button
                      type="button"
                      onClick={() => { setExpandedToolId((cur) => (cur === tool.id ? null : tool.id)); }}
                      className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
                    >
                      <Icon
                        name={tool.status === 'error' ? 'warning' : 'tool'}
                        size={14}
                        className={tool.status === 'error' ? 'text-danger' : 'text-ink-faint'}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ink">{tool.name}</span>
                        {tool.description !== undefined ? (
                          <span className="block truncate text-[12px] text-ink-faint">{tool.description}</span>
                        ) : null}
                      </span>
                      <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint ${expanded ? 'rotate-90' : ''}`} />
                    </button>
                    {expanded ? (
                      <div className="space-y-2 border-t border-hairline/60 bg-canvas/55 px-3.5 py-3">
                        {tool.argsText.trim() !== '' ? (
                          <pre className="max-h-36 overflow-auto rounded-lg bg-panel p-2.5 font-mono text-[11.5px] text-ink-soft">
                            {tool.argsText}
                          </pre>
                        ) : null}
                        {outputText !== '' ? (
                          <pre className="max-h-48 overflow-auto rounded-lg bg-panel p-2.5 font-mono text-[11.5px] text-ink">
                            {outputText}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        ) : null}

        {tab === 'diff' ? (
          changes.length === 0 ? (
            <p className="py-10 text-center text-[13.5px] text-ink-faint">{t('mobile.chat.noChanges')}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {changes.map((entry) => {
                  const shortName = entry.path.split(/[\\/]/).pop() ?? entry.path;
                  const active = activeChange?.id === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      data-mobile-hood-change={entry.id}
                      aria-pressed={active}
                      onClick={() => { setSelectedChangeId(entry.id); }}
                      className={`inline-flex h-11 shrink-0 items-center rounded-full px-3.5 font-mono text-[12.5px] ${
                        active ? 'bg-ink text-paper' : 'border border-hairline bg-paper text-ink-soft'
                      }`}
                    >
                      {shortName}
                    </button>
                  );
                })}
              </div>

              {activeChange !== undefined ? (
                <div className="overflow-hidden rounded-2xl border border-hairline/80 bg-paper">
                  <div className="flex items-center justify-between gap-2 border-b border-hairline/70 px-3.5 py-2.5">
                    <span className="min-w-0 truncate font-mono text-[12px] text-ink">{activeChange.path}</span>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums">
                      <span className="text-success">+{activeChange.added}</span>{' '}
                      <span className="text-danger">-{activeChange.removed}</span>
                    </span>
                  </div>
                  <div className="max-h-[42dvh] overflow-auto p-3 font-mono text-[12px] leading-[1.5]">
                    {activeChange.oldText !== undefined ? (
                      <pre className="mb-2 whitespace-pre-wrap break-all rounded-lg bg-danger/10 p-2 text-danger">
                        {activeChange.oldText}
                      </pre>
                    ) : null}
                    {activeChange.newText !== undefined ? (
                      <pre className="whitespace-pre-wrap break-all rounded-lg bg-success/10 p-2 text-success">
                        {activeChange.newText}
                      </pre>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </ActionSheet>
  );
}

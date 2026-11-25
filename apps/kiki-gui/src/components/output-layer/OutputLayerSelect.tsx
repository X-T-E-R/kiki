/* oxlint-disable eslint-plugin-import(no-cycle) */
/**
 * OutputLayerSelect — compact dropdown control placed at the status line of Composer
 * (lower right corner near permission/meter).
 *
 * Allows choosing active preset (or turning off), toggling processed/original view,
 * and directly editing or adding presets.
 */

import { useState, useRef, useEffect } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '../icons';
import {
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  owningModalId,
  resolveFloatingOwners,
} from '../../lib/uiBusy';
import { MODAL_ESCAPE_ATTRIBUTE } from '../Dialog';
import {
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  POPOVER_LABEL_CLASS,
  STATUS_SEGMENT_CLASS,
  STATUS_SEGMENT_ICON_CLASS,
  STATUS_SEGMENT_SET,
  usePopover,
} from '../ComposerControls';
import { POPOVER_SURFACE_CLASS } from '../SearchableSelect';
import { useOutputLayer } from './outputLayerStore';
import { useOutputLayerClient } from './useOutputLayerClient';
import { OutputPresetModal } from './OutputPresetModal';
import { type OutputLayerPreset, hasConfiguredModel } from './types';

function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-accent transition-opacity ${
        on ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden
    >
      <Icon name="check" size={12} />
    </span>
  );
}

export function OutputLayerSelect({
  sessionId,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
}: {
  sessionId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = setControlledOpen ?? setUncontrolledOpen;

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<OutputLayerPreset | null>(null);

  useOutputLayerClient(sessionId);
  const {
    contextKey,
    isPluginEnabled,
    presets,
    activePresetId,
    activePreset,
    viewMode,
    setActivePreset,
    setViewMode,
  } = useOutputLayer(sessionId);

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onKeyDown = usePopover(open, close, rootRef, 'composer-output-layer', panelRef);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [open]);

  if (!isPluginEnabled) return null;

  const isEnabled = activePresetId !== null && activePreset !== undefined;
  const triggerLabel = isEnabled
    ? `${activePreset.label}${viewMode === 'original' ? ' (原文)' : ''}`
    : '输出层';

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow navigation */}
      <div ref={rootRef} className="relative" data-output-layer-select onKeyDown={onKeyDown}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="输出层预设选择"
          title={isEnabled ? `输出层：${activePreset.label}` : '输出层 (流式翻译/说人话)'}
          onClick={() => setOpen(!open)}
          data-segment-set={isEnabled ? '' : undefined}
          className={`${STATUS_SEGMENT_CLASS} ${isEnabled ? `max-w-40 ${STATUS_SEGMENT_SET}` : 'px-1.5'}`}
        >
          <Icon name="sliders" size={14} className={isEnabled ? 'text-accent' : STATUS_SEGMENT_ICON_CLASS} />
          <span className={isEnabled ? 'min-w-0 truncate @max-[30rem]/toolbar:sr-only' : 'sr-only'}>{triggerLabel}</span>
        </button>

        {open ? (
          <Popover.Root
            open
            modal={false}
            onOpenChange={(nextOpen, eventDetails) => {
              if (nextOpen) return;
              if (eventDetails.reason === 'escape-key') {
                close(true);
                return;
              }
              eventDetails.cancel();
            }}
          >
            <Popover.Portal>
              <Popover.Positioner
                anchor={triggerRef}
                side="top"
                align="end"
                sideOffset={6}
                collisionPadding={8}
                positionMethod="fixed"
                style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
              >
                <Popover.Popup
                  ref={panelRef}
                  data-output-layer-panel
                  initialFocus={false}
                  finalFocus={false}
                  onKeyDown={onKeyDown}
                  {...{
                    [FLOATING_OWNER_ATTRIBUTE]: 'composer-output-layer',
                    [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current, 'composer-output-layer'),
                    [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                  }}
                  className={`composer-floating-panel anim-enter flex max-h-[min(var(--available-height,420px),420px,calc(100dvh-120px))] w-80 flex-col overflow-hidden p-1.5 outline-none ${POPOVER_SURFACE_CLASS}`}
                >
            {/* View Mode Switcher Header */}
            {isEnabled ? (
              <div className="mb-2 flex shrink-0 items-center justify-between rounded-md bg-paper p-1 border border-hairline">
                <span className="px-2 text-[11px] font-normal text-ink-soft">显示版本</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setViewMode('processed')}
                    className={`rounded px-2 py-0.5 text-[11px] font-normal transition-colors ${
                      viewMode === 'processed'
                        ? 'bg-accent/15 text-accent'
                        : 'text-ink-faint hover:text-ink'
                    }`}
                  >
                    处理版
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('original')}
                    className={`rounded px-2 py-0.5 text-[11px] font-normal transition-colors ${
                      viewMode === 'original'
                        ? 'bg-accent/15 text-accent'
                        : 'text-ink-faint hover:text-ink'
                    }`}
                  >
                    原文
                  </button>
                </div>
              </div>
            ) : null}

            <p className={`shrink-0 ${POPOVER_LABEL_CLASS}`}>输出预设</p>

            <div role="listbox" aria-label="输出层预设" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
              {/* Option: Off / None */}
              <button
                type="button"
                role="option"
                data-menu-row
                aria-selected={activePresetId === null}
                onClick={() => {
                  setActivePreset(null);
                  close(true);
                }}
                className={`${MENU_ROW_CLASS} ${activePresetId === null ? MENU_ROW_SELECTED_CLASS : ''}`}
              >
                <CheckMark on={activePresetId === null} />
                <span className="min-w-0 flex-1">
                  <span className="block font-normal text-ink">关闭输出层</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                    显示主模型原始回复
                  </span>
                </span>
              </button>

              {/* Presets List */}
              {presets.map((preset) => {
                const isSelected = activePresetId === preset.id;
                const isConfigured = hasConfiguredModel(preset);
                return (
                  <div
                    key={preset.id}
                    className={`group/row flex w-full items-center rounded-md ${
                      isSelected ? MENU_ROW_SELECTED_CLASS : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    <button
                      type="button"
                      role="option"
                      data-menu-row
                      aria-selected={isSelected}
                      onClick={() => {
                        setActivePreset(preset.id);
                        close(true);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2 px-3 py-1.5 text-left text-[13px] text-ink outline-none"
                    >
                      <CheckMark on={isSelected} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-normal">
                          <span>{preset.label}</span>
                          {!isConfigured ? (
                            <span className="rounded bg-ink/[0.06] px-1 py-0.2 text-[10px] font-normal text-ink-faint">
                              未选模型
                            </span>
                          ) : null}
                        </span>
                        {preset.instruction ? (
                          <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">
                            {preset.instruction}
                          </span>
                        ) : null}
                      </span>
                    </button>

                    {/* Edit button */}
                    <button
                      type="button"
                      title={isConfigured ? '编辑预设' : '配置模型'}
                      aria-label={`编辑预设 ${preset.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingPreset(preset);
                        setModalOpen(true);
                        close(false);
                      }}
                      className={`mr-1.5 rounded p-1 transition-opacity hover:bg-ink/[0.06] hover:text-ink focus:opacity-100 group-hover/row:opacity-100 ${
                        !isConfigured ? 'text-accent opacity-75' : 'text-ink-faint opacity-0'
                      }`}
                    >
                      <Icon name="edit" size={12} />
                    </button>
                  </div>
                );
              })}
            </div>


            {/* Bottom Action: Add Preset */}
            <div className="mt-1.5 border-t border-hairline pt-1">
              <button
                type="button"
                data-menu-row
                onClick={() => {
                  setEditingPreset(null);
                  setModalOpen(true);
                  close(false);
                }}
                className={`${MENU_ROW_CLASS} text-accent hover:text-accent font-normal`}
              >
                <Icon name="plus" size={12} className="shrink-0 text-accent" />
                <span>新增预设...</span>
              </button>
            </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
      </div>

      {modalOpen ? (
        <OutputPresetModal
          key={`${contextKey}:${editingPreset?.id ?? 'new'}`}
          preset={editingPreset}
          open={modalOpen}
          sessionId={sessionId}
          onClose={() => {
            setModalOpen(false);
            setEditingPreset(null);
          }}
          onSaved={(saved) => {
            setActivePreset(saved.id);
          }}
        />
      ) : null}
    </>
  );
}

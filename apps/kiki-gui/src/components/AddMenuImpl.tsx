import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject, type UIEvent } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { Popover } from '@base-ui/react/popover';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { FsSearchHit, PermissionMode } from '@kiki/protocol';
import type { McpServerLocator } from '@kiki/klient';
import { type SlashItem } from '@kiki/session-core/commands';
import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { useFsSearchFeed } from '../lib/fsSearchFeed';
import { lazyComponent } from '../lib/lazyComponent';
import { isCoarsePointer, useCoarsePointer, usePhoneMode } from '../lib/layoutHooks';
import { useLayerHistory } from '../lib/layerHistory';
import { PERMISSION_MODES, permissionModeDef } from '../lib/permissionModes';
import { isImeKeyEvent } from '../lib/shortcuts';
import { getPickerScaleConfig } from '../lib/subagentScaleConfig';
import {
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  hasOpenOwnedFloatingPortal,
  owningModalId,
  resolveFloatingOwners,
} from '../lib/uiBusy';
import { QUIET_BUTTON, StatusDot } from './capabilities/primitives';
import {
  heldByConversation,
  mcpRowMatches,
  overrideForSwitch,
  type McpOverride,
  type McpSessionRow,
} from './capabilities/sessionMcp';
import {
  type AddMenuExtensionItem,
  type AddMenuHost,
  type AddMenuPlugin,
  type AddMenuProps,
  type AddMenuView,
  handledPopoverKeyEvents,
  MENU_ROW_CLASS,
  MENU_ROW_SELECTED_CLASS,
  POPOVER_LABEL_CLASS,
  RUN_MODES,
  type RunModeControls,
  SendTimingRows,
  usePopover,
} from './ComposerControls';
import { Toggle } from './controls';
import { MODAL_ESCAPE_ATTRIBUTE } from './Dialog';
import { Icon, Spinner } from './icons';
import { POPOVER_SURFACE_CLASS } from './popoverSurfaceClass';
import { TIMING_SHORT_KEY } from './queueTimingKeys';

const LazyOptionalCapabilityRows = lazyComponent(() =>
  import('./capabilities/optionalCapabilityUi').then((m) => m.OptionalCapabilityRows),
);

if (import.meta.env.MODE === 'test') {
  await LazyOptionalCapabilityRows.preload();
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-[var(--kiki-motion-quick)] ${on ? 'bg-selected-ink' : 'bg-hairline-strong'}`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.2)] transition-[left] duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${on ? 'left-3.5' : 'left-0.5'}`}
      />
    </span>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

function MenuIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0 text-ink-soft">
      <path d={d} stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function planGateEffectiveText(
  free: boolean,
  permissionMode: PermissionMode | undefined,
  t: (key: I18nKey, params?: I18nParams) => string,
): string | undefined {
  if (free) return undefined;
  if (permissionMode === 'manual') return t('composer.planGateFreeHint');
  return undefined;
}

function RunModePanel({ controls }: { controls: RunModeControls }) {
  const { t } = useI18n();
  const { runMode } = controls;
  const showGate = controls.planGateFree !== undefined && controls.onChangePlanGateFree !== undefined;
  const showObjective = controls.onChangeGoalObjective !== undefined;
  return (
    <div data-run-mode-panel>
      <p className={POPOVER_LABEL_CLASS}>{t('composer.runModeHeading')}</p>
      <div role="radiogroup" aria-label={t('composer.runModeHeading')}>
        {RUN_MODES.filter((mode) => mode.id !== 'goal' || controls.goalAvailable).map((mode) => {
          const on = runMode === mode.id;
          return (
            <div key={mode.id}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                data-menu-row
                data-mode-switch={mode.id}
                data-goal-mode-toggle={mode.id === 'goal' ? '' : undefined}
                onClick={() => { controls.onChangeRunMode(mode.id); }}
                className={`${MENU_ROW_CLASS} items-start ${on ? MENU_ROW_SELECTED_CLASS : ''}`}
              >
                <Check on={on} />
                <span className="min-w-0 flex-1">
                  <span className="block font-normal text-ink">{t(mode.labelKey)}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t(mode.hintKey)}</span>
                </span>
              </button>
              {on && mode.id === 'plan' && showGate ? (
                <>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={controls.planGateFree}
                    data-menu-row
                    data-mode-switch="planGate"
                    onClick={() => { controls.onChangePlanGateFree?.(!controls.planGateFree); }}
                    className={`${MENU_ROW_CLASS} mt-0.5 pl-8`}
                  >
                    <span className="min-w-0 flex-1">{t('composer.planGateFree')}</span>
                    <Switch on={controls.planGateFree === true} />
                  </button>
                  {(() => {
                    const effective = planGateEffectiveText(controls.planGateFree === true, controls.permissionMode, t);
                    return effective !== undefined ? (
                      <p data-plan-gate-effective className="pr-3 pb-1 pl-8 text-[12px] leading-snug text-ink-faint">
                        {effective}
                      </p>
                    ) : null;
                  })()}
                </>
              ) : null}
              {on && mode.id === 'goal' && showObjective ? (
                <div className="pt-1.5 pr-3 pb-2 pl-8" data-goal-open>
                  <label htmlFor="composer-goal-objective" className="text-[12px] font-normal text-ink-faint">
                    {t('composer.goalObjective')}
                  </label>
                  <input
                    id="composer-goal-objective"
                    data-goal-objective
                    value={controls.goalObjective ?? ''}
                    onChange={(event) => { controls.onChangeGoalObjective?.(event.target.value); }}
                    placeholder={t('composer.goalObjectiveNext')}
                    className="mt-1 w-full rounded-md border border-hairline bg-paper px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SEARCH_ROW_LIMIT = 5;
const FILE_DEBOUNCE_MS = 200;
const ADD_MENU_LIST_EST_HEIGHT = 280;

function VirtualizedAddMenuList<T>({
  items,
  keyOf,
  estimateHeight,
  renderItem,
  className,
  onScroll,
  dataAttrs,
  footer,
}: {
  readonly items: readonly T[];
  readonly keyOf: (item: T, index: number) => string;
  readonly estimateHeight: number;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly className: string;
  readonly onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  readonly dataAttrs?: Readonly<Record<string, string | undefined>>;
  readonly footer?: ReactNode;
}) {
  const pickerScale = getPickerScaleConfig();
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => { setScrollEl(node); }, []);
  const isVirtualized = items.length > pickerScale.selectVirtualizeThreshold;
  const virtualizer = useVirtualizer({
    count: isVirtualized ? items.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateHeight,
    getItemKey: (index) => keyOf(items[index]!, index),
    overscan: pickerScale.virtualOverscan,
    initialRect: { width: 312, height: ADD_MENU_LIST_EST_HEIGHT },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement;
      if (el === null) return;
      const emit = () => {
        const rect = el.getBoundingClientRect();
        const height = Math.round(rect.height || el.clientHeight);
        const width = Math.round(rect.width || el.clientWidth);
        if (height > 0) cb({ width, height });
      };
      emit();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(emit);
      observer.observe(el);
      return () => { observer.disconnect(); };
    },
    measureElement: (el) => {
      const height = Math.round(el.getBoundingClientRect().height);
      return height > 0 ? height : estimateHeight;
    },
    useFlushSync: false,
  });

  return (
    <div ref={setScrollNode} className={className} onScroll={onScroll} {...dataAttrs}>
      {isVirtualized ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index];
            if (item === undefined) return null;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {renderItem(item, row.index)}
              </div>
            );
          })}
        </div>
      ) : (
        items.map((item, index) => (
          <div key={keyOf(item, index)}>{renderItem(item, index)}</div>
        ))
      )}
      {footer}
    </div>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); }, delay);
    return () => { clearTimeout(timer); };
  }, [value, delay]);
  return debounced;
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <p role="presentation" className={POPOVER_LABEL_CLASS}>{children}</p>;
}

function Chevron() {
  return <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />;
}

function SkillRow({ item, onInsert, result = false }: { item: SlashItem; onInsert: (item: SlashItem) => void; result?: boolean }) {
  const hint = item.skill?.argument_hint;
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-skill={item.name}
      aria-disabled={item.disabled === true || undefined}
      title={item.description}
      onClick={() => { if (item.disabled !== true) onInsert(item); }}
      className={`${MENU_ROW_CLASS} items-start aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
    >
      <Icon name="skill" size={14} className="mt-[3px] shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-normal text-ink">/{item.name}</span>
          {hint !== undefined && hint !== '' ? <span className="truncate text-[12px] text-ink-faint">{hint}</span> : null}
        </span>
        {item.description !== '' ? (
          <span className="mt-0.5 block truncate text-[12px] leading-snug text-ink-faint">{item.description}</span>
        ) : null}
      </span>
    </button>
  );
}

function PluginRow({ plugin, busy, onToggle, result = false }: {
  plugin: AddMenuPlugin;
  busy: boolean;
  onToggle: (pluginId: string, enabled: boolean) => void;
  result?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      role="menuitem"
      aria-disabled={!plugin.available || undefined}
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-plugin={plugin.id}
      className={MENU_ROW_CLASS + ' aria-disabled:cursor-not-allowed aria-disabled:opacity-60'}
    >
      <Icon name="skill" size={14} className="shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink">{plugin.name}</span>
          {plugin.contributions !== '' ? (
            <span className="truncate text-[12px] text-ink-faint">{plugin.contributions}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[12px] leading-snug text-ink-faint">
          {!plugin.available
            ? t('composer.addMenu.pluginBlocked')
            : plugin.source === 'session'
              ? plugin.enabled ? t('composer.addMenu.pluginOnSession') : t('composer.addMenu.pluginOffSession')
              : plugin.source === 'workspace'
                ? plugin.enabled ? t('composer.addMenu.pluginOnWorkspace') : t('composer.addMenu.pluginOffWorkspace')
                : plugin.enabled
                  ? t('composer.addMenu.pluginFromGlobal')
                  : t('composer.addMenu.pluginOffGlobal')}
        </span>
      </span>
      <span className="shrink-0">
        <Toggle
          label={t('composer.addMenu.pluginToggle', { name: plugin.name })}
          layout="bare"
          checked={plugin.enabled}
          disabled={busy || !plugin.available}
          onChange={(enabled) => { onToggle(plugin.id, enabled); }}
        />
      </span>
    </div>
  );
}

function mcpDotState(row: McpSessionRow): 'ok' | 'busy' | 'error' | 'off' | 'waiting' {
  if (row.condition === 'off-here' || row.condition === 'off-config' || row.condition === 'plugin-off') return 'off';
  if (row.condition === 'signed-out') return 'waiting';
  if (row.condition === 'connecting') return 'busy';
  if (row.condition === 'live') return row.connection === 'connected' ? 'ok' : 'waiting';
  if (row.condition === 'on-here') return row.connection === 'connected' ? 'ok' : 'busy';
  return 'error';
}

function mcpStateKey(row: McpSessionRow): I18nKey {
  if (row.override === 'off') return 'composer.addMenu.mcpOffSession';
  if (row.override === 'on') return 'composer.addMenu.mcpOnSession';
  if (row.condition === 'plugin-off') return 'composer.addMenu.mcpPluginMuted';
  if (row.condition === 'off-config') return 'composer.addMenu.mcpConfigOff';
  if (row.condition === 'signed-out') return 'composer.addMenu.mcpNeedsAuth';
  if (row.condition === 'connecting') return 'st.mcp.status.connecting';
  if (row.condition === 'failed') return 'st.mcp.status.error';
  if (row.condition === 'live') return row.connection === 'connected' ? 'st.mcp.status.connected' : 'composer.addMenu.mcpSourceOn';
  return 'st.mcp.status.disconnected';
}

function McpRow({ row, busy, retrying, busyOn, onOverride, onReconnect, result = false }: {
  row: McpSessionRow;
  busy: boolean;
  retrying: boolean;
  busyOn: boolean | undefined;
  onOverride: (locator: McpServerLocator, override: McpOverride, name: string) => void;
  onReconnect: (name: string) => void;
  result?: boolean;
}) {
  const { t } = useI18n();
  const held = heldByConversation(row);
  const checked = busy && busyOn !== undefined ? busyOn : held;
  const stateKey = mcpStateKey(row);
  const state = t(stateKey, stateKey === 'composer.addMenu.mcpPluginMuted' ? { name: row.pluginLabel ?? '' } : undefined);
  const showsEngineError = row.error !== undefined && (row.condition === 'failed' || row.condition === 'unavailable');
  const detail = showsEngineError ? row.error! : state;
  const locator = row.locator;
  const origin = row.origin === 'plugin'
    ? t('composer.addMenu.mcpFromPlugin', { name: row.pluginLabel ?? '' })
    : row.origin === 'caller'
      ? t('composer.addMenu.mcpFromConversation')
      : t('composer.addMenu.mcpFromConfig');
  return (
    <div
      role="menuitem"
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-mcp={row.name}
      data-add-mcp-state={row.condition}
      data-add-mcp-override={row.override}
      className={`${MENU_ROW_CLASS} items-start`}
    >
      <span className="mt-[5px] flex shrink-0">
        <StatusDot state={mcpDotState(row)} label={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink">{row.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-ink-faint">{row.transport}</span>
        </span>
        <span className={`mt-0.5 block truncate text-[12px] leading-snug ${showsEngineError ? 'text-danger' : 'text-ink-faint'}`}>
          {detail}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-ink-faint">{origin}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {row.addressable && locator !== undefined ? (
          <Toggle
            label={t('composer.addMenu.mcpToggle', { name: row.name })}
            layout="bare"
            checked={checked}
            disabled={busy}
            onChange={(on) => { onOverride(locator, overrideForSwitch(row, on), row.name); }}
          />
        ) : null}
        {row.canReconnect ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => { onReconnect(row.name); }}
            className={`${QUIET_BUTTON} min-h-6 px-1 text-[11px]`}
          >
            {retrying ? t('composer.addMenu.mcpRetrying') : t('composer.addMenu.mcpReconnect')}
          </button>
        ) : null}
        {row.canRestore && locator !== undefined ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => { onOverride(locator, 'inherit', row.name); }}
            className={`${QUIET_BUTTON} min-h-6 px-1 text-[11px]`}
          >
            {t('composer.addMenu.mcpUseConfig')}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function FileRow({ hit, onMention, result = false }: { hit: FsSearchHit; onMention: (hit: FsSearchHit) => void; result?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-file={hit.path}
      title={hit.path}
      onClick={() => { onMention(hit); }}
      className={MENU_ROW_CLASS}
    >
      <Icon name="file" size={14} className="shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
        {hit.name}{hit.kind === 'directory' ? '/' : ''}
      </span>
      {hit.path.includes('/') ? (
        <span className="max-w-[45%] min-w-0 truncate font-mono text-[11px] text-ink-faint">{hit.path.slice(0, hit.path.lastIndexOf('/'))}</span>
      ) : null}
    </button>
  );
}

function FileContinueRow({
  pending,
  failed,
  onMore,
}: {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly onMore: () => void;
}) {
  const { t } = useI18n();
  const label = failed ? t('common.retry') : pending ? t('sidebar.loadingMore') : t('sidebar.searchLoadMore');
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-file-more={failed ? 'retry' : pending ? 'pending' : 'more'}
      aria-busy={pending || undefined}
      aria-label={failed ? t('composer.filesFailed') : label}
      onClick={() => { if (!pending) onMore(); }}
      className={`${MENU_ROW_CLASS} text-ink-soft`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function AddMenuImpl({
  view,
  onViewChange,
  attachDisabled,
  onAttach,
  onCaptureCamera,
  onPickPhotos,
  onRebuild,
  rebuildDisabled,
  runMode,
  timing,
  ssh,
  skills,
  plugins,
  mcp,
  optional,
  files,
  extensions,
  permission,
}: AddMenuProps) {
  const { t, locale } = useI18n();
  const phoneMode = usePhoneMode();
  const coarse = useCoarsePointer();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = view !== 'closed';
  const [query, setQuery] = useState('');
  const [sheetSnap, setSheetSnap] = useState<Drawer.Root.SnapPoint | null>(0.68);
  const drilledRef = useRef(false);
  const close = (refocus = false) => {
    drilledRef.current = false;
    onViewChange('closed');
    if (refocus && !isCoarsePointer()) triggerRef.current?.focus();
  };
  useLayerHistory('composer-add', open && phoneMode, () => { close(false); });
  const drill = (next: AddMenuView) => {
    drilledRef.current = true;
    setQuery('');
    onViewChange(next);
  };
  const back = () => {
    drilledRef.current = false;
    setQuery('');
    onViewChange('root');
  };
  useEffect(() => {
    if (!open || view === 'root' || !drilledRef.current) return;
    const onEscapeCapture = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || handledPopoverKeyEvents.has(event)) return;
      if (hasOpenOwnedFloatingPortal('composer-add')) return;
      handledPopoverKeyEvents.add(event);
      event.preventDefault();
      event.stopPropagation();
      if (query !== '' && document.activeElement instanceof HTMLElement && document.activeElement.dataset['addSearch'] !== undefined) {
        setQuery('');
        return;
      }
      back();
    };
    window.addEventListener('keydown', onEscapeCapture, true);
    return () => { window.removeEventListener('keydown', onEscapeCapture, true); };
  }, [open, view, query]);
  const popoverKeyDown = usePopover(open, close, rootRef, 'composer-add', panelRef);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const attachOnly =
    !coarse && !phoneMode &&
    runMode === undefined && timing === undefined && onRebuild === undefined && ssh === undefined && skills === undefined
    && plugins === undefined && mcp === undefined && optional === undefined && files === undefined
    && (extensions === undefined || extensions.items.length === 0) && permission === undefined;
  const searchable = skills !== undefined || plugins !== undefined || mcp !== undefined || files !== undefined
    || (extensions !== undefined && extensions.items.length > 0)
    || (ssh?.hosts !== undefined && ssh.hosts.length > 0);

  const trimmed = query.trim();
  const deferredTrimmed = useDeferredValue(trimmed);
  const needle = deferredTrimmed.toLowerCase();
  const searching = view === 'root' && trimmed !== '';
  const sourceAvailable =
    view === 'ssh' ? ssh !== undefined
    : view === 'timing' ? timing !== undefined
    : view === 'mode' ? runMode !== undefined
    : view === 'skills' ? skills !== undefined
    : view === 'plugins' ? plugins !== undefined
    : view === 'mcp' ? mcp !== undefined
    : view === 'optional' ? optional !== undefined
    : view === 'mention' ? files !== undefined
    : view === 'permission' ? permission !== undefined
    : true;
  const resolvedView: AddMenuView = sourceAvailable ? view : 'root';
  const fileQuery = useDebounced(trimmed, FILE_DEBOUNCE_MS);
  const fileCurrent = fileQuery === trimmed;
  const fileFeed = useFsSearchFeed({
    enabled: open && files !== undefined && fileCurrent && (view === 'mention' || trimmed !== ''),
    scopeKey: files?.scopeKey ?? 'none',
    query: fileQuery,
    search: (text, page) => files?.search(text, page) ?? Promise.resolve([]),
  });
  const fileItems = fileCurrent ? fileFeed.items : [];
  const rootFilePreview = fileItems.slice(0, SEARCH_ROW_LIMIT);
  const fileWaiting = files !== undefined && (view === 'mention' || trimmed !== '') && fileItems.length === 0
    && (!fileCurrent || fileFeed.pendingInitial);

  const skillIndex = useMemo(() => {
    const items = skills?.items;
    if (items === undefined || items.length === 0) return [];
    return items.map((item) => ({
      item,
      nameLower: item.name.toLowerCase(),
      descLower: item.description.toLowerCase(),
    }));
  }, [skills?.items]);

  const skillMatches = useMemo(() => {
    if (!open || skills === undefined) return [];
    if (needle === '') return skills.items;
    const r0: SlashItem[] = [];
    const r1: SlashItem[] = [];
    const r2: SlashItem[] = [];
    for (let i = 0; i < skillIndex.length; i += 1) {
      const entry = skillIndex[i]!;
      if (entry.nameLower.startsWith(needle)) r0.push(entry.item);
      else if (entry.nameLower.includes(needle)) r1.push(entry.item);
      else if (entry.descLower.includes(needle)) r2.push(entry.item);
    }
    return [...r0, ...r1, ...r2];
  }, [open, skills, skillIndex, needle]);

  const hostIndex = useMemo(
    () => (ssh?.hosts ?? []).map((host) => ({
      host,
      haystack: `${host.name}\0${host.detail ?? ''}`.toLowerCase(),
    })),
    [ssh?.hosts],
  );
  const hostMatches = useMemo(() => {
    if (!open || hostIndex.length === 0) return [];
    if (needle === '') return ssh?.hosts ?? [];
    const out: AddMenuHost[] = [];
    for (let i = 0; i < hostIndex.length; i += 1) {
      if (hostIndex[i]!.haystack.includes(needle)) out.push(hostIndex[i]!.host);
    }
    return out;
  }, [open, hostIndex, ssh?.hosts, needle]);

  const pluginIndex = useMemo(
    () => (plugins?.items ?? []).map((plugin) => ({
      plugin,
      haystack: `${plugin.name}\0${plugin.contributions}`.toLowerCase(),
    })),
    [plugins?.items],
  );
  const pluginMatches = useMemo(() => {
    if (!open || plugins === undefined) return [];
    if (needle === '') return plugins.items;
    const out: AddMenuPlugin[] = [];
    for (let i = 0; i < pluginIndex.length; i += 1) {
      if (pluginIndex[i]!.haystack.includes(needle)) out.push(pluginIndex[i]!.plugin);
    }
    return out;
  }, [open, plugins, pluginIndex, needle]);

  const mcpMatches = useMemo(() => {
    if (!open || mcp === undefined) return [];
    if (needle === '') return mcp.items;
    return mcp.items.filter((row) => mcpRowMatches(row, needle));
  }, [open, mcp, needle]);

  const extensionIndex = useMemo(
    () => (extensions?.items ?? []).map((item) => ({
      item,
      haystack: `${item.label}\0${item.tooltip ?? ''}\0${item.pluginId}`.toLowerCase(),
    })),
    [extensions?.items],
  );
  const extensionMatches = useMemo(() => {
    if (!open || extensions === undefined) return [];
    if (needle === '') return extensions.items;
    const out: AddMenuExtensionItem[] = [];
    for (let i = 0; i < extensionIndex.length; i += 1) {
      if (extensionIndex[i]!.haystack.includes(needle)) out.push(extensionIndex[i]!.item);
    }
    return out;
  }, [open, extensions, extensionIndex, needle]);

  const onShowSkills = skills?.onShow;
  const onShowPlugins = plugins?.onShow;
  const onShowMcp = mcp?.onShow;
  useEffect(() => {
    if (open && (view === 'skills' || view === 'root')) onShowSkills?.();
    if (open && view === 'plugins') onShowPlugins?.();
    if (open && view === 'mcp') onShowMcp?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view]);

  const focusAddMenuView = useCallback((panel: HTMLElement | null) => {
    if (panel === null) return;
    const field =
      view === 'mode'
        ? panel.querySelector<HTMLElement>('[data-goal-objective]')
        : isCoarsePointer() ? null : panel.querySelector<HTMLElement>('[data-add-search]');
    (field ?? panel.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [data-menu-row]:not([data-add-back])') ?? panel.querySelector<HTMLElement>('[data-menu-row]'))?.focus();
  }, [view]);

  const attachAddPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node !== null) focusAddMenuView(node);
  }, [focusAddMenuView]);

  useEffect(() => {
    if (!open) return;
    focusAddMenuView(panelRef.current ?? rootRef.current);
  }, [open, view, focusAddMenuView]);

  const firstRow = () =>
    (panelRef.current ?? rootRef.current)?.querySelector<HTMLElement>('[data-menu-row]:not([data-add-back]):not(:disabled):not([aria-disabled="true"])') ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || isImeKeyEvent(event)) return;
    const target = event.target as HTMLElement;
    const inSearch = target.dataset['addSearch'] !== undefined;
    if (event.key === 'Escape') {
      if (handledPopoverKeyEvents.has(event.nativeEvent)) return;
      if (inSearch && query !== '') {
        handledPopoverKeyEvents.add(event.nativeEvent);
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        return;
      }
      if (view !== 'root' && drilledRef.current) {
        handledPopoverKeyEvents.add(event.nativeEvent);
        event.preventDefault();
        event.stopPropagation();
        back();
        return;
      }
    }
    if (inSearch) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        firstRow()?.focus();
        return;
      }
      if (event.key === 'ArrowLeft' && query === '' && view !== 'root' && drilledRef.current) {
        event.preventDefault();
        back();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        firstRow()?.click();
        return;
      }
    } else if (target.tagName !== 'INPUT') {
      if (event.key === 'ArrowRight' && target.dataset['addDrill'] !== undefined) {
        event.preventDefault();
        target.click();
        return;
      }
      if (event.key === 'ArrowLeft' && view !== 'root' && drilledRef.current) {
        event.preventDefault();
        back();
        return;
      }
      const search = (panelRef.current ?? rootRef.current)?.querySelector<HTMLInputElement>('[data-add-search]');
      if (search !== null && search !== undefined && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        search.focus();
      }
    }
    popoverKeyDown(event);
  };

  if (attachOnly) {
    return (
      <button
        type="button"
        data-attach-button
        onClick={onAttach}
        disabled={attachDisabled}
        aria-label={t('composer.attachAria')}
        title={t('composer.attachTitle')}
        className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-md text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  const insertSkill = (item: SlashItem) => { close(); skills?.onInsert(item); };
  const busyPlugins = plugins?.busyId;
  const busyMcp = mcp?.busyName;
  const togglePlugin = (pluginId: string, enabled: boolean) => { plugins?.onToggle(pluginId, enabled); };
  const mentionFile = (hit: FsSearchHit) => { close(); files?.onMention(hit); };
  const revealFiles = () => {
    drilledRef.current = true;
    onViewChange('mention');
  };
  const continueFiles = () => {
    if (fileFeed.pendingMore || fileFeed.pendingRestart) return;
    if (fileFeed.failed) fileFeed.retry();
    else fileFeed.loadMore();
  };
  const onFileScroll = (event: UIEvent<HTMLDivElement>) => {
    if (fileFeed.failed || fileFeed.pendingMore || fileFeed.pendingRestart || fileFeed.exhausted) return;
    const node = event.currentTarget;
    if (node.scrollHeight - node.scrollTop - node.clientHeight > 32) return;
    fileFeed.loadMore();
  };
  const rootCanContinue = fileCurrent && !fileWaiting
    && (fileItems.length > rootFilePreview.length || !fileFeed.exhausted);
  const showFileContinue = fileCurrent && !fileWaiting && (
    !fileFeed.exhausted || fileFeed.failed || fileFeed.pendingMore || fileFeed.pendingRestart
  );

  const searchField = (placeholder: string) => (
    <div className="px-1 pt-0.5 pb-1">
      <label className="flex h-8 items-center gap-2 rounded-md bg-ink/[0.04] px-3 text-ink-faint focus-within:ring-2 focus-within:ring-selected-ink/40">
        <Icon name="search" size={14} className="shrink-0" />
        <input
          data-add-search
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
    </div>
  );

  const backRow = (label: string) =>
    drilledRef.current ? (
      <button type="button" role="menuitem" data-menu-row data-add-back onClick={back} className={`${MENU_ROW_CLASS} text-ink-soft`}>
        <Icon name="chevron" size={12} className="shrink-0 rotate-180 text-ink-faint" />
        <span className="flex-1 font-normal">{label}</span>
      </button>
    ) : null;

  const drillRow = (id: AddMenuView, icon: ReactNode, label: string, trailing?: ReactNode, data?: Record<string, string>) => (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-drill
      {...data}
      aria-haspopup="menu"
      onClick={() => { drill(id); }}
      className={MENU_ROW_CLASS}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {trailing}
      <Chevron />
    </button>
  );

  const note = (text: string, tone: 'faint' | 'danger' = 'faint') => (
    <p role={tone === 'danger' ? 'alert' : undefined} className={`px-3 py-1.5 text-[12px] leading-4 ${tone === 'danger' ? 'text-danger' : 'text-ink-faint'}`}>
      {text}
    </p>
  );

  const rootBody = searching ? (
    <div data-add-results data-file-order={files !== undefined && fileCurrent ? fileFeed.order : undefined}>
      {skills !== undefined && skillMatches.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.skills')}</GroupLabel>
          {skillMatches.slice(0, SEARCH_ROW_LIMIT).map((item) => (
            <SkillRow key={item.name} item={item} onInsert={insertSkill} result />
          ))}
        </>
      ) : null}
      {files !== undefined && rootFilePreview.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.files')}</GroupLabel>
          {rootFilePreview.map((hit) => <FileRow key={hit.path} hit={hit} onMention={mentionFile} result />)}
          {rootCanContinue ? <FileContinueRow pending={false} failed={false} onMore={revealFiles} /> : null}
        </>
      ) : files !== undefined && rootCanContinue ? (
        <FileContinueRow pending={fileFeed.pendingMore || fileFeed.pendingRestart} failed={false} onMore={revealFiles} />
      ) : null}
      {plugins !== undefined && pluginMatches.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.plugins')}</GroupLabel>
          {pluginMatches.slice(0, SEARCH_ROW_LIMIT).map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} busy={busyPlugins === plugin.id} onToggle={togglePlugin} result />
          ))}
        </>
      ) : null}
      {mcp !== undefined && mcpMatches.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.mcp')}</GroupLabel>
          {mcpMatches.slice(0, SEARCH_ROW_LIMIT).map((row) => (
            <McpRow
              key={row.name}
              row={row}
              busy={busyMcp === row.name}
              retrying={busyMcp === row.name && mcp.busyAction === 'retry'}
              busyOn={busyMcp === row.name ? mcp.busyOn : undefined}
              onOverride={mcp.onOverride}
              onReconnect={mcp.onReconnect}
              result
            />
          ))}
        </>
      ) : null}
      {hostMatches.length > 0 && ssh?.onToggleHost !== undefined ? (
        <>
          <GroupLabel>{t('composer.addMenu.ssh')}</GroupLabel>
          {hostMatches.slice(0, SEARCH_ROW_LIMIT).map((host) => (
            <button
              key={host.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={host.joined}
              data-menu-row
              data-add-result
              data-add-host={host.id}
              onClick={() => { ssh.onToggleHost?.(host.id); }}
              className={`${MENU_ROW_CLASS} items-start`}
            >
              <Check on={host.joined} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{host.name}</span>
                {host.detail !== undefined ? <span className="block truncate font-mono text-[12px] leading-4 text-ink-faint">{host.detail}</span> : null}
              </span>
            </button>
          ))}
        </>
      ) : null}
      {extensionMatches.length > 0 && extensions !== undefined ? (
        <>
          <GroupLabel>{locale === 'zh' ? '工作台与扩展' : 'Extensions'}</GroupLabel>
          {extensionMatches.slice(0, SEARCH_ROW_LIMIT).map((item) => {
            const isBusy = extensions.busyKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                data-menu-row
                data-add-result
                data-add-extension={item.key}
                data-plugin-composer-slot={item.key}
                disabled={extensions.disabled || isBusy}
                title={item.tooltip ?? item.label}
                onClick={() => { close(); item.onTrigger(); }}
                className={MENU_ROW_CLASS}
              >
                {isBusy ? <Spinner label={item.label} /> : <Icon name={item.iconName} size={14} className="shrink-0 text-ink-soft" />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.badgeText !== undefined && item.badgeText !== '' ? (
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint tabular-nums">{item.badgeText}</span>
                ) : null}
              </button>
            );
          })}
        </>
      ) : null}
      {skillMatches.length === 0 && hostMatches.length === 0 && pluginMatches.length === 0 && mcpMatches.length === 0 && extensionMatches.length === 0
        && (files === undefined || (fileCurrent && fileItems.length === 0 && fileFeed.exhausted && !fileFeed.failed && !fileWaiting))
        ? note(t('composer.addMenu.noMatch', { query: trimmed }))
        : null}
      {fileWaiting ? note(t('composer.filesSearching')) : null}
      {files !== undefined && fileCurrent && fileFeed.failed && fileItems.length === 0 ? (
        <>
          {note(t('composer.filesFailed'), 'danger')}
          <FileContinueRow pending={false} failed onMore={fileFeed.retry} />
        </>
      ) : null}
    </div>
  ) : (
    <>
      <div role="group" aria-label={t('composer.addMenu.contextGroup')}>
        <GroupLabel>{t('composer.addMenu.contextGroup')}</GroupLabel>
        {(coarse || phoneMode) && (onCaptureCamera !== undefined || onPickPhotos !== undefined) ? (
          <div data-add-mobile-media-strip="" className="grid grid-cols-3 gap-2 px-2 pt-0.5 pb-2">
            <button
              type="button"
              role="menuitem"
              data-menu-row
              data-add-camera=""
              disabled={attachDisabled || onCaptureCamera === undefined}
              onClick={() => { close(); onCaptureCamera?.(); }}
              className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-hairline bg-paper px-2 py-2.5 text-[12.5px] text-ink transition-colors hover:bg-ink/[0.04] disabled:opacity-45"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-soft">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              <span>{locale === 'zh' ? '拍照' : 'Camera'}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-row
              data-add-photos=""
              disabled={attachDisabled || onPickPhotos === undefined}
              onClick={() => { close(); onPickPhotos?.(); }}
              className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-hairline bg-paper px-2 py-2.5 text-[12.5px] text-ink transition-colors hover:bg-ink/[0.04] disabled:opacity-45"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-soft">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
              <span>{locale === 'zh' ? '相册' : 'Photos'}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-menu-row
              data-attach-button
              disabled={attachDisabled}
              onClick={() => { close(); onAttach(); }}
              className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border border-hairline bg-paper px-2 py-2.5 text-[12.5px] text-ink transition-colors hover:bg-ink/[0.04] disabled:opacity-45"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-ink-soft">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              </svg>
              <span>{locale === 'zh' ? '文件' : 'Files'}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            role="menuitem"
            data-menu-row
            data-attach-button
            disabled={attachDisabled}
            onClick={() => { close(); onAttach(); }}
            className={MENU_ROW_CLASS}
          >
            <MenuIcon d="M9.5 6.5 6.2 9.8a2.3 2.3 0 0 1-3.3-3.3l3.9-3.9a1.5 1.5 0 0 1 2.2 2.2L5.3 8.5a.7.7 0 0 1-1-1l3.2-3.2" />
            <span className="flex-1">{t('composer.addMenu.attach')}</span>
            <span className="text-[12px] text-ink-faint pointer-coarse:hidden">{t('composer.addMenu.attachHint')}</span>
          </button>
        )}
        {skills !== undefined
          ? drillRow('skills', <Icon name="skill" size={14} className="shrink-0 text-ink-soft" />, t('composer.addMenu.skills'),
              <span className="font-mono text-[12px] text-ink-faint">/</span>, { 'data-add-menu-skills': '' })
          : null}
        {files !== undefined
          ? drillRow('mention', <span aria-hidden className="flex w-3.5 shrink-0 justify-center font-mono text-[13px] leading-none text-ink-soft">@</span>,
              t('composer.addMenu.mention'), <span className="font-mono text-[12px] text-ink-faint">@</span>, { 'data-add-menu-mention': '' })
          : null}
        {ssh !== undefined
          ? drillRow('ssh', <Icon name="terminal" size={14} className="shrink-0 text-ink-soft" />, t('composer.addMenu.ssh'),
              ssh.count > 0 ? <span className="text-[12px] text-ink-faint tabular-nums">{ssh.count}</span> : undefined, { 'data-add-menu-ssh': '' })
          : null}
      </div>
      {runMode !== undefined || permission !== undefined || onRebuild !== undefined || timing !== undefined ? (
        <div role="group" aria-label={t('composer.addMenu.sessionGroup')} className="mt-1 border-t border-hairline pt-1">
          <GroupLabel>{t('composer.addMenu.sessionGroup')}</GroupLabel>
          {permission !== undefined
            ? drillRow('permission', <Icon name="lock" size={14} className="shrink-0 text-ink-soft" />, t('composer.permAria'),
                <span className="text-[12px] text-ink-faint">{t((permissionModeDef(permission.value) ?? PERMISSION_MODES[0]!).labelKey)}</span>,
                { 'data-add-menu-permission': '' })
            : null}
          {runMode !== undefined
            ? drillRow('mode', <Icon name={runMode.runMode === 'goal' ? 'goal' : 'plan'} size={14} className="shrink-0 text-ink-soft" />, t('composer.addMenu.mode'),
                <span className="text-[12px] text-ink-faint">{t(RUN_MODES.find((m) => m.id === runMode.runMode)!.labelKey)}</span>,
                { 'data-add-menu-mode': '' })
            : null}
          {timing !== undefined
            ? drillRow('timing', <MenuIcon d="M6 2.8A3.2 3.2 0 1 0 6 9.2 3.2 3.2 0 0 0 6 2.8M6 4.3V6l1.2 1.2" />, t('composer.addMenu.timing'),
                <span className="text-[12px] text-ink-faint">{t(timing.busySendsNow ? 'composer.sendTiming.now' : TIMING_SHORT_KEY[timing.defaultTiming])}</span>,
                { 'data-add-menu-timing': '' })
            : null}
          {onRebuild !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-menu-row
              data-add-menu-rebuild
              disabled={rebuildDisabled}
              onClick={() => { close(); onRebuild(); }}
              className={MENU_ROW_CLASS}
            >
              <MenuIcon d="M9.6 5A3.7 3.7 0 0 0 3 3.8M2.4 7A3.7 3.7 0 0 0 9 8.2M3 2v1.9h1.9M9 10V8.1H7.1" />
              <span className="flex-1">{t('composer.addMenu.rebuild')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );

  const skillsBody = skills === undefined ? null : (
    <div data-add-skills-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.skills'))}
      {searchField(t('composer.addMenu.searchSkills'))}
      {skills.status === 'loading' && skills.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{note(t('composer.addMenu.skillsLoading'))}</div>
      ) : skills.status === 'error' && skills.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{note(t('composer.addMenu.skillsFailed'), 'danger')}</div>
      ) : skillMatches.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {note(trimmed === '' ? t('composer.addMenu.skillsEmpty') : t('composer.addMenu.noMatch', { query: trimmed }))}
        </div>
      ) : (
        <VirtualizedAddMenuList
          items={skillMatches}
          keyOf={(item) => item.name}
          estimateHeight={44}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          renderItem={(item) => <SkillRow item={item} onInsert={insertSkill} />}
        />
      )}
    </div>
  );

  const pluginsBody = plugins === undefined ? null : (
    <div data-add-plugins-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.plugins'))}
      {searchField(t('composer.addMenu.searchPlugins'))}
      {plugins.loading && plugins.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">{note(t('composer.addMenu.pluginsLoading'))}</div>
      ) : plugins.failed && plugins.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">{note(t('composer.addMenu.pluginsFailed'), 'danger')}</div>
      ) : pluginMatches.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">
          {note(trimmed === '' ? t('composer.addMenu.pluginsEmpty') : t('composer.addMenu.noMatch', { query: trimmed }))}
        </div>
      ) : (
        <VirtualizedAddMenuList
          items={pluginMatches}
          keyOf={(plugin) => plugin.id}
          estimateHeight={48}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5"
          renderItem={(plugin) => (
            <PluginRow plugin={plugin} busy={busyPlugins === plugin.id} onToggle={togglePlugin} />
          )}
        />
      )}
      <p className="shrink-0 px-3 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.addMenu.pluginsHint')}</p>
    </div>
  );

  const optionalBody = optional === undefined ? null : (
    <div data-add-optional-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.optional'))}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1.5">
        <LazyOptionalCapabilityRows sessionId={optional.sessionId} />
      </div>
    </div>
  );

  const mcpBody = mcp === undefined ? null : (
    <div data-add-mcp-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.mcp'))}
      {searchField(t('composer.addMenu.searchMcp'))}
      {mcp.externalEngine === undefined ? null : note(t('composer.addMenu.mcpExternalHint', { engine: mcp.externalEngine }))}
      {mcp.failed && mcp.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">{note(t('composer.addMenu.mcpFailed'), 'danger')}</div>
      ) : mcp.loading && mcp.items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">{note(t('composer.addMenu.mcpLoading'))}</div>
      ) : mcpMatches.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5">
          {note(trimmed === '' ? t('composer.addMenu.mcpEmpty') : t('composer.addMenu.noMatch', { query: trimmed }))}
        </div>
      ) : (
        <VirtualizedAddMenuList
          items={mcpMatches}
          keyOf={(row) => row.name}
          estimateHeight={64}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1.5"
          renderItem={(row) => (
            <McpRow
              row={row}
              busy={busyMcp === row.name}
              retrying={busyMcp === row.name && mcp.busyAction === 'retry'}
              busyOn={busyMcp === row.name ? mcp.busyOn : undefined}
              onOverride={mcp.onOverride}
              onReconnect={mcp.onReconnect}
            />
          )}
        />
      )}
      {mcp.failure === undefined ? null : (
        <p role="alert" className="flex shrink-0 items-start gap-2 px-3 pt-1 pb-0.5 text-[12px] leading-4 text-danger">
          <span className="min-w-0 flex-1">
            {t('composer.addMenu.mcpWriteFailed', { name: mcp.failure.name, detail: mcp.failure.message })}
          </span>
          <button type="button" onClick={mcp.onDismissFailure} className={`${QUIET_BUTTON} min-h-6 px-1 text-[11px]`}>
            {t('composer.addMenu.mcpDismiss')}
          </button>
        </p>
      )}
      <p className="shrink-0 px-3 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">
        {mcp.writable ? t('composer.addMenu.mcpHint') : t('composer.addMenu.mcpNoWrite')}
      </p>
    </div>
  );

  const mentionBody = files === undefined ? null : (
    <div data-add-mention-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.mention'))}
      {searchField(t('composer.addMenu.searchFiles'))}
      {fileWaiting || (fileFeed.failed && fileItems.length === 0) || (fileItems.length === 0 && fileFeed.exhausted) ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-add-file-list data-file-order={fileFeed.order} onScroll={onFileScroll}>
          {fileWaiting ? note(t('composer.filesSearching'))
            : fileFeed.failed && fileItems.length === 0 ? note(t('composer.filesFailed'), 'danger')
            : note(trimmed === '' ? t('composer.filesEmpty') : t('composer.filesNoMatch', { query: trimmed }))}
          {showFileContinue ? (
            <FileContinueRow
              pending={fileFeed.pendingMore || fileFeed.pendingRestart}
              failed={fileFeed.failed}
              onMore={continueFiles}
            />
          ) : null}
        </div>
      ) : (
        <VirtualizedAddMenuList
          items={fileItems}
          keyOf={(hit) => hit.path}
          estimateHeight={34}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          onScroll={onFileScroll}
          dataAttrs={{ 'data-add-file-list': '', 'data-file-order': fileFeed.order }}
          renderItem={(hit) => <FileRow hit={hit} onMention={mentionFile} />}
          footer={showFileContinue ? (
            <FileContinueRow
              pending={fileFeed.pendingMore || fileFeed.pendingRestart}
              failed={fileFeed.failed}
              onMore={continueFiles}
            />
          ) : null}
        />
      )}
      <p className="shrink-0 px-3 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.addMenu.mentionHint')}</p>
    </div>
  );

  const panelAriaLabel =
    resolvedView === 'ssh' ? t('composer.ssh.heading')
      : resolvedView === 'mode' ? t('composer.runModeHeading')
      : resolvedView === 'timing' ? t('composer.sendTimingAria')
      : resolvedView === 'skills' ? t('composer.addMenu.skills')
      : resolvedView === 'plugins' ? t('composer.addMenu.plugins')
      : resolvedView === 'optional' ? t('composer.addMenu.optional')
      : resolvedView === 'mcp' ? t('composer.addMenu.mcp')
      : resolvedView === 'mention' ? t('composer.addMenu.mention')
      : resolvedView === 'permission' ? t('composer.permAria')
      : t('composer.addMenuAria');

  const panelContent = resolvedView === 'root' ? (
    <>
      {searchable ? searchField(t('composer.addMenu.search')) : null}
      <div data-add-root-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rootBody}
      </div>
    </>
  ) : resolvedView === 'skills' ? (
    skillsBody
  ) : resolvedView === 'plugins' ? (
    pluginsBody
  ) : resolvedView === 'optional' ? (
    optionalBody
  ) : resolvedView === 'mcp' ? (
    mcpBody
  ) : resolvedView === 'mention' ? (
    mentionBody
  ) : resolvedView === 'ssh' && ssh !== undefined ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.ssh'))}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {ssh.renderPanel(close)}
      </div>
    </div>
  ) : resolvedView === 'timing' && timing !== undefined ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.timing'))}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SendTimingRows
          defaultTiming={timing.defaultTiming}
          canSendNow={timing.canSendNow}
          busy={timing.busy}
          busySendsNow={timing.busySendsNow}
          onPick={(choice) => { close(); timing.onPick(choice); }}
        />
      </div>
    </div>
  ) : resolvedView === 'permission' && permission !== undefined ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-add-permission-view>
      {backRow(t('composer.permAria'))}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {PERMISSION_MODES.map((mode) => {
          const selected = mode.id === permission.value;
          return (
            <button
              key={mode.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              data-menu-row
              data-add-permission-option={mode.id}
              onClick={() => { permission.onChange(mode.id); close(); }}
              className={MENU_ROW_CLASS}
            >
              <Check on={selected} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate ${mode.tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{t(mode.labelKey)}</span>
                <span className="block truncate text-[11.5px] leading-4 text-ink-faint">{t(mode.hintKey)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  ) : runMode !== undefined ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {backRow(t('composer.addMenu.mode'))}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <RunModePanel controls={runMode} />
      </div>
    </div>
  ) : null;

  const useMobileSheet =
    phoneMode && (typeof document === 'undefined' || document.documentElement.dataset['keyboard'] === undefined);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative self-start" data-add-menu data-plan-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-add-menu-trigger
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('composer.addMenuAria')}
        title={t('composer.addMenuAria')}
        onClick={() => { if (open) close(); else { drilledRef.current = false; setSheetSnap(0.68); onViewChange('root'); } }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none aria-expanded:bg-paper aria-expanded:text-ink pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${open ? 'rotate-45' : ''}`}>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && useMobileSheet ? (
        <Drawer.Root
          open
          modal="trap-focus"
          onOpenChange={(nextOpen) => {
            if (!nextOpen) close(false);
          }}
          snapPoints={[0.68, 0.92]}
          snapPoint={sheetSnap}
          onSnapPointChange={setSheetSnap}
          swipeDirection="down"
        >
          <Drawer.VirtualKeyboardProvider>
            <Drawer.Portal>
              <Drawer.Backdrop className="kiki-drawer-backdrop" />
              <Drawer.Viewport className="kiki-drawer-viewport-bottom">
                <Drawer.Popup
                  ref={attachAddPanelRef}
                  data-add-panel={resolvedView}
                  role={resolvedView === 'mode' ? 'dialog' : 'menu'}
                  aria-label={panelAriaLabel}
                  onKeyDown={onKeyDown}
                  {...{
                    [FLOATING_OWNER_ATTRIBUTE]: 'composer-add',
                    [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current, 'composer-add'),
                    [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                  }}
                  className="kiki-drawer-bottom h-[88dvh] px-2 pt-0.5 pb-[calc(8px+var(--kiki-safe-bottom-inset))]"
                >
                  <div className="kiki-mobile-sheet-grabber" aria-hidden />
                  {panelContent}
                </Drawer.Popup>
              </Drawer.Viewport>
            </Drawer.Portal>
          </Drawer.VirtualKeyboardProvider>
        </Drawer.Root>
      ) : open ? (
        <Popover.Root
          open
          modal={false}
          onOpenChange={(nextOpen, eventDetails) => {
            if (nextOpen) return;
            if (eventDetails.reason === 'escape-key') {
              const raw = eventDetails.event;
              const nativeEvent = raw instanceof Event
                ? raw
                : (typeof raw === 'object' && raw !== null && 'nativeEvent' in raw && (raw as { nativeEvent: unknown }).nativeEvent instanceof Event
                    ? (raw as { nativeEvent: Event }).nativeEvent
                    : null);
              if (nativeEvent !== null && handledPopoverKeyEvents.has(nativeEvent)) {
                eventDetails.cancel();
                return;
              }
              if (hasOpenOwnedFloatingPortal('composer-add')) {
                eventDetails.cancel();
                return;
              }
              if (query !== '' && document.activeElement instanceof HTMLElement && document.activeElement.dataset['addSearch'] !== undefined) {
                if (nativeEvent !== null) handledPopoverKeyEvents.add(nativeEvent);
                eventDetails.cancel();
                setQuery('');
                return;
              }
              if (view !== 'root' && drilledRef.current) {
                if (nativeEvent !== null) handledPopoverKeyEvents.add(nativeEvent);
                eventDetails.cancel();
                back();
                return;
              }
              if (nativeEvent !== null) handledPopoverKeyEvents.add(nativeEvent);
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
              align="start"
              sideOffset={6}
              collisionPadding={8}
              positionMethod="fixed"
              style={{ zIndex: floatingSurfaceZIndex(triggerRef.current) }}
            >
              <Popover.Popup
                ref={attachAddPanelRef}
                data-add-panel={resolvedView}
                role={resolvedView === 'mode' ? 'dialog' : 'menu'}
                aria-label={panelAriaLabel}
                initialFocus={false}
                finalFocus={false}
                {...{
                  [FLOATING_OWNER_ATTRIBUTE]: 'composer-add',
                  [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerRef.current, 'composer-add'),
                  [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerRef.current),
                }}
                className={`composer-floating-panel anim-enter flex max-h-[min(var(--available-height,420px),420px,calc(100dvh-120px))] w-80 flex-col overflow-hidden p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
              >
                {panelContent}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </div>
  );
}

export function CompactModelSheetDrawer({
  open,
  onOpenChange,
  triggerRef,
  ariaLabel,
  heading,
  profileNode,
  executionNode,
}: {
  readonly open: boolean;
  readonly onOpenChange: (nextOpen: boolean, eventDetails: { reason?: string; event?: Event; cancel: () => void }) => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly ariaLabel: string;
  readonly heading: string;
  readonly profileNode: ReactNode;
  readonly executionNode: ReactNode;
}) {
  const triggerEl = triggerRef.current;
  return (
    <Drawer.Root
      open={open}
      modal="trap-focus"
      onOpenChange={onOpenChange}
      swipeDirection="down"
    >
      <Drawer.VirtualKeyboardProvider>
        <Drawer.Portal>
          <Drawer.Backdrop className="kiki-drawer-backdrop" />
          <Drawer.Viewport className="kiki-drawer-viewport-bottom">
            <Drawer.Popup
              data-compact-model-sheet=""
              aria-label={ariaLabel}
              {...{
                [FLOATING_OWNER_ATTRIBUTE]: 'compact-model-sheet',
                [FLOATING_PORTAL_OWNERS_ATTRIBUTE]: resolveFloatingOwners(triggerEl),
                [MODAL_ESCAPE_ATTRIBUTE]: owningModalId(triggerEl),
              }}
              className="kiki-drawer-bottom px-4 pt-1 pb-[calc(16px+var(--kiki-safe-bottom-inset))]"
            >
              <div className="kiki-mobile-sheet-grabber" aria-hidden />
              <p className="px-1 pb-2 text-[12px] font-normal text-ink-faint">
                {heading}
              </p>
              <div className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-paper p-2.5 [&_button]:w-full [&_button]:justify-between">
                {profileNode}
                <div className="h-px bg-hairline/70" />
                {executionNode}
              </div>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.VirtualKeyboardProvider>
    </Drawer.Root>
  );
}

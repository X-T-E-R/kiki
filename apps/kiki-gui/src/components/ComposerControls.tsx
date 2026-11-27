/**
 * ComposerControls — the popover controls on the composer's status line:
 *
 * - AddMenu (＋): searchable "add" menu — cold trigger shell in this module,
 *   full open sheet/popover body lazy-loaded via `./AddMenuImpl`.
 * - RunModeChip: shown only when the run mode is not Normal; its ✕ returns
 *   to Normal.
 * - PermissionSelect: the approvals chip + menu, rendered from the
 *   data-driven PERMISSION_MODES list (tone decides the resting colour).
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import type { DeferredAppendTiming, FsSearchHit, PermissionMode } from '@kiki/protocol';
import type { McpServerLocator } from '@kiki/klient';
import { type SlashItem } from '@kiki/session-core/commands';

import { useI18n } from '../i18n';
import type { FsSearchFeedSearch } from '../lib/fsSearchFeed';
import { lazyComponent } from '../lib/lazyComponent';
import { useCoarsePointer, usePhoneMode } from '../lib/layoutHooks';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE, permissionModeDef } from '../lib/permissionModes';
import {
  COMPOSER_FLOATING_GROUP,
  containsOrOwnsFloatingTarget,
  FLOATING_OWNER_ATTRIBUTE,
  FLOATING_PORTAL_OWNERS_ATTRIBUTE,
  floatingSurfaceZIndex,
  hasOpenOwnedFloatingPortal,
  MODAL_ESCAPE_ATTRIBUTE,
  notifyFloatingGroupOpen,
  owningModalId,
  registerOverlay,
  resolveFloatingOwners,
  subscribeFloatingGroup,
} from '../lib/uiBusy';
import type { OverrideSource } from './capabilities/pluginUsage';
import type { McpOverride, McpSessionRow } from './capabilities/sessionMcp';
import type { McpPickAction } from './capabilities/useMcpPicker';
import { Icon, type IconName } from './icons';
import { POPOVER_SURFACE_CLASS } from './popoverSurfaceClass';
import { TIMING_HINT_KEY, TIMING_SHORT_KEY } from './queueTimingKeys';

const LazyAddMenuImpl = lazyComponent(() => import('./AddMenuImpl').then((m) => m.AddMenuImpl));
const LazyAnchoredFloatingPopover = lazyComponent(() => import('./ComposerPopovers').then((m) => m.AnchoredFloatingPopover));

if (import.meta.env.MODE === 'test') {
  await Promise.all([LazyAddMenuImpl.preload(), LazyAnchoredFloatingPopover.preload()]);
}

export const STATUS_SEGMENT_CLASS =
  'group/segment flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 aria-expanded:bg-ink/[0.04] aria-expanded:text-ink disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-11';

export const STATUS_SEGMENT_SET = 'text-ink';

export const STATUS_SEGMENT_ICON_CLASS =
  'text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] group-hover/segment:text-current group-aria-expanded/segment:text-current';

export const MENU_ROW_SELECTED_CLASS = 'bg-paper font-normal text-ink shadow-[var(--kiki-sheet-shadow)] hover:bg-paper';

export const POPOVER_LABEL_CLASS = 'px-3 pt-1.5 pb-1 text-[12px] font-normal text-ink-faint';

export const MENU_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none pointer-coarse:min-h-11 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-50';

export const DEFERRED_SEND_TIMING_PICKS = ['agent_idle', 'subagents_done', 'tasks_done'] as const satisfies readonly DeferredAppendTiming[];
export const SEND_TIMING_PICKS = ['subagents_done', 'tasks_done'] as const satisfies readonly DeferredAppendTiming[];

export type SendTimingChoice = 'default' | 'now' | DeferredAppendTiming;

export type RunMode = 'normal' | 'plan' | 'goal';

const PANEL_GAP_PX = 6;

export const ComposerCardContext = createContext<RefObject<HTMLElement | null> | undefined>(undefined);

export function useComposerPanelAnchor(rootRef: RefObject<HTMLElement | null>, open?: unknown): void {
  const cardRef = useContext(ComposerCardContext);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || cardRef === undefined) return;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { measure(); });
    let observed: HTMLElement | null = null;
    const measure = () => {
      const card = cardRef.current;
      if (card === null) return;
      if (observed !== card) {
        if (observed !== null) observer?.unobserve(observed);
        observed = card;
        observer?.observe(card);
        if (card.parentElement !== null) observer?.observe(card.parentElement);
      }
      const origin = root.querySelector<HTMLElement>(':scope > [data-searchable-select]') ?? root;
      const rootRect = origin.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
      const panelBottomEdge =
        viewportHeight > 0
          ? Math.min(cardRect.top - PANEL_GAP_PX, viewportHeight - 8)
          : cardRect.top - PANEL_GAP_PX;
      root.style.setProperty('--cp-bottom', `${Math.max(0, rootRect.bottom - panelBottomEdge)}px`);
      root.style.setProperty('--cp-left', `${cardRect.left - rootRect.left}px`);
      root.style.setProperty('--cp-right', `${rootRect.right - cardRect.right}px`);
      root.style.setProperty('--cp-max-w', `${cardRect.width}px`);
      let clipTop = 0;
      for (let node = origin.parentElement; node !== null; node = node.parentElement) {
        if (card.contains(node)) continue;
        const style = getComputedStyle(node);
        if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
          clipTop = Math.max(clipTop, node.getBoundingClientRect().top);
          break;
        }
      }
      const viewportLimit = viewportHeight > 0 ? Math.max(160, viewportHeight - 120) : 600;
      const hardCap = viewportHeight > 0 ? Math.max(80, Math.floor(panelBottomEdge - 8)) : 600;
      const roomAbove = Math.min(
        viewportLimit,
        hardCap,
        Math.max(Math.min(160, hardCap), Math.floor(panelBottomEdge - clipTop - 8)),
      );
      root.style.setProperty('--cp-max-h', `${roomAbove}px`);
    };
    measure();
    let frame: number | undefined = requestAnimationFrame(() => {
      frame = undefined;
      measure();
    });
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const onScroll = (event: Event) => {
      if (open === false) return;
      const target = event.target;
      const card = cardRef.current;
      if (
        open === undefined &&
        card !== null &&
        target instanceof Node &&
        target !== document &&
        !target.contains(card)
      ) {
        return;
      }
      scheduleMeasure();
    };
    root.addEventListener('pointerdown', measure, true);
    root.addEventListener('keydown', measure, true);
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener('pointerdown', measure, true);
      root.removeEventListener('keydown', measure, true);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', onScroll, true);
      observer?.disconnect();
    };
  }, [rootRef, cardRef, open]);
}

const PANEL_Y = 'bottom-[var(--cp-bottom,calc(100%_+_6px))] max-w-[min(var(--cp-max-w,100vw),calc(100vw_-_32px))]';
export const COMPOSER_PANEL_START = `composer-floating-panel absolute z-40 ${PANEL_Y} left-[var(--cp-left,0px)]`;
export const COMPOSER_PANEL_END = `composer-floating-panel absolute z-40 ${PANEL_Y} right-[var(--cp-right,0px)]`;

export function ComposerPanelOrigin({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useComposerPanelAnchor(ref);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const root = ref.current;
      if (root === null || root.contains(event.target as Node)) return;
      const trigger = root.querySelector<HTMLButtonElement>('[data-searchable-select] > button[aria-expanded="true"]');
      if (trigger === null) return;
      event.preventDefault();
      trigger.click();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}

export const handledPopoverKeyEvents = new WeakSet<Event>();

export function usePopoverDismiss(
  open: boolean,
  close: (refocus?: boolean) => void,
  rootRef: RefObject<HTMLElement | null>,
  overlayId: string,
  panelRef?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const isComposerGroup = overlayId.startsWith('composer-');
  useEffect(() => {
    if (!isComposerGroup) return undefined;
    return subscribeFloatingGroup(COMPOSER_FLOATING_GROUP, overlayId, () => {
      closeRef.current(false);
    });
  }, [isComposerGroup, overlayId]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    root.setAttribute(FLOATING_OWNER_ATTRIBUTE, overlayId);
    return () => {
      if (root.getAttribute(FLOATING_OWNER_ATTRIBUTE) === overlayId) {
        root.removeAttribute(FLOATING_OWNER_ATTRIBUTE);
      }
    };
  }, [overlayId, rootRef]);
  useEffect(() => {
    if (!open) return;
    if (isComposerGroup) {
      notifyFloatingGroupOpen(COMPOSER_FLOATING_GROUP, overlayId, rootRef.current);
    }
    const release = registerOverlay(overlayId);
    const onPointerDown = (event: PointerEvent) => {
      const inRoot = rootRef.current !== null && containsOrOwnsFloatingTarget(rootRef.current, event.target, overlayId);
      const inPanel = panelRef?.current !== null && panelRef?.current !== undefined
        && containsOrOwnsFloatingTarget(panelRef.current, event.target, overlayId);
      if (!inRoot && !inPanel) {
        closeRef.current();
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || handledPopoverKeyEvents.has(event)) return;
      if (
        containsOrOwnsFloatingTarget(rootRef.current, event.target, overlayId) ||
        (panelRef?.current !== null && panelRef?.current !== undefined && containsOrOwnsFloatingTarget(panelRef.current, event.target, overlayId)) ||
        hasOpenOwnedFloatingPortal(overlayId)
      ) {
        return;
      }
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, overlayId, rootRef, panelRef, isComposerGroup]);
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || handledPopoverKeyEvents.has(event.nativeEvent)) return;
    const inSurface =
      containsOrOwnsFloatingTarget(rootRef.current, event.target, overlayId) ||
      (panelRef?.current !== null && panelRef?.current !== undefined && containsOrOwnsFloatingTarget(panelRef.current, event.target, overlayId));
    if (!inSurface || hasOpenOwnedFloatingPortal(overlayId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeRef.current(true);
  };
}

export function usePopover(
  open: boolean,
  close: (refocus?: boolean) => void,
  rootRef: RefObject<HTMLDivElement | null>,
  overlayId: string,
  panelRef?: RefObject<HTMLElement | null>,
) {
  const onDismissKeyDown = usePopoverDismiss(open, close, rootRef, overlayId, panelRef);

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      onDismissKeyDown(event);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.defaultPrevented || handledPopoverKeyEvents.has(event.nativeEvent)) return;
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      handledPopoverKeyEvents.add(event.nativeEvent);
      event.preventDefault();
      const panelRows = [...(panelRef?.current?.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)') ?? [])];
      const localRows = panelRows.length > 0
        ? panelRows
        : [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)') ?? [])];
      const rows = localRows.length > 0
        ? localRows
        : [...document.querySelectorAll<HTMLElement>(`[${FLOATING_OWNER_ATTRIBUTE}="${overlayId}"] [data-menu-row]:not(:disabled)`)];
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row === document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      rows[(index + delta + rows.length) % rows.length]?.focus();
    }
  };
}

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

export const RUN_MODES: readonly { id: RunMode; labelKey: 'composer.runMode.normal' | 'composer.runMode.plan' | 'composer.runMode.goal'; hintKey: 'composer.runMode.normalHint' | 'composer.runMode.planHint' | 'composer.runMode.goalHint' }[] = [
  { id: 'normal', labelKey: 'composer.runMode.normal', hintKey: 'composer.runMode.normalHint' },
  { id: 'plan', labelKey: 'composer.runMode.plan', hintKey: 'composer.runMode.planHint' },
  { id: 'goal', labelKey: 'composer.runMode.goal', hintKey: 'composer.runMode.goalHint' },
];

export interface RunModeControls {
  readonly runMode: RunMode;
  readonly onChangeRunMode: (mode: RunMode) => void;
  readonly goalAvailable: boolean;
  readonly planGateFree?: boolean;
  readonly onChangePlanGateFree?: (free: boolean) => void;
  readonly permissionMode?: PermissionMode;
  readonly goalObjective?: string;
  readonly onChangeGoalObjective?: (objective: string) => void;
}

export type AddMenuView = 'closed' | 'root' | 'mode' | 'ssh' | 'skills' | 'mention' | 'timing' | 'plugins' | 'mcp' | 'optional' | 'permission';

export interface AddMenuExtensionItem {
  readonly key: string;
  readonly pluginId: string;
  readonly slotId: string;
  readonly label: string;
  readonly tooltip?: string;
  readonly badgeText?: string;
  readonly iconName: IconName;
  readonly actionKind: string;
  readonly onTrigger: () => void;
}

export interface AddMenuExtensions {
  readonly items: readonly AddMenuExtensionItem[];
  readonly busyKey?: string | null;
  readonly disabled?: boolean;
}

export interface AddMenuHost {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly joined: boolean;
}

export interface AddMenuSkills {
  readonly items: readonly SlashItem[];
  readonly status: 'loading' | 'error' | 'ready';
  readonly onInsert: (item: SlashItem) => void;
  readonly onShow?: () => void;
}

export interface AddMenuPlugin {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly source: OverrideSource;
  readonly contributions: string;
}

export interface AddMenuPlugins {
  readonly items: readonly AddMenuPlugin[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly busyId?: string;
  readonly onShow?: () => void;
  readonly onToggle: (pluginId: string, enabled: boolean) => void;
}

export interface AddMenuMcp {
  readonly items: readonly McpSessionRow[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly writable: boolean;
  readonly busyName?: string;
  readonly busyAction?: McpPickAction;
  readonly busyOn?: boolean;
  readonly failure?: { readonly name: string; readonly message: string };
  readonly onDismissFailure: () => void;
  readonly onShow?: () => void;
  readonly onOverride: (locator: McpServerLocator, override: McpOverride, name: string) => void;
  readonly onReconnect: (name: string) => void;
  readonly externalEngine?: string;
}

export interface AddMenuFiles {
  readonly search: FsSearchFeedSearch;
  readonly scopeKey: string;
  readonly onMention: (hit: FsSearchHit) => void;
}

export interface AddMenuProps {
  readonly view: AddMenuView;
  readonly onViewChange: (view: AddMenuView) => void;
  readonly attachDisabled: boolean;
  readonly onAttach: () => void;
  readonly onCaptureCamera?: () => void;
  readonly onPickPhotos?: () => void;
  readonly onRebuild?: () => void;
  readonly rebuildDisabled?: boolean;
  readonly runMode?: RunModeControls;
  readonly timing?: {
    readonly defaultTiming: DeferredAppendTiming;
    readonly canSendNow: boolean;
    readonly busy?: boolean;
    readonly busySendsNow?: boolean;
    readonly onPick: (choice: SendTimingChoice) => void;
  };
  readonly ssh?: {
    readonly count: number;
    readonly renderPanel: (close: (refocus?: boolean) => void) => ReactNode;
    readonly hosts?: readonly AddMenuHost[];
    readonly onToggleHost?: (id: string) => void;
  };
  readonly skills?: AddMenuSkills;
  readonly plugins?: AddMenuPlugins;
  readonly mcp?: AddMenuMcp;
  readonly optional?: { readonly sessionId?: string };
  readonly files?: AddMenuFiles;
  readonly extensions?: AddMenuExtensions;
  readonly permission?: {
    readonly value: PermissionMode;
    readonly onChange: (mode: PermissionMode) => void;
  };
}

export function SendTimingRows({
  defaultTiming,
  canSendNow,
  busy = true,
  busySendsNow = false,
  onPick,
}: {
  readonly defaultTiming: DeferredAppendTiming;
  readonly canSendNow: boolean;
  readonly busy?: boolean;
  readonly busySendsNow?: boolean;
  readonly onPick: (choice: SendTimingChoice) => void;
}) {
  const { t } = useI18n();
  const showSendNow = busy && canSendNow;
  const showDefault = !(busy && busySendsNow);
  const deferredPicks = busy && busySendsNow ? DEFERRED_SEND_TIMING_PICKS : SEND_TIMING_PICKS;
  const defaultHint = !busy && defaultTiming === 'agent_idle'
    ? t('composer.sendTiming.sendIdleHint')
    : t('composer.sendTiming.sendHint', { timing: t(TIMING_SHORT_KEY[defaultTiming]) });
  return (
    <>
      {showDefault ? (
        <button
          type="button"
          role="menuitem"
          data-menu-row
          data-send-timing="default"
          onClick={() => { onPick('default'); }}
          className={`${MENU_ROW_CLASS} items-start`}
        >
          <span className="min-w-0 flex-1">
            <span className="block font-normal text-ink">{t('composer.sendTiming.send')}</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">
              {defaultHint}
            </span>
          </span>
        </button>
      ) : null}
      {showSendNow ? (
        <button
          type="button"
          role="menuitem"
          data-menu-row
          data-send-timing="now"
          onClick={() => { onPick('now'); }}
          className={`${MENU_ROW_CLASS} items-start`}
        >
          <span className="min-w-0 flex-1">
            <span className="block font-normal text-ink">{t('composer.sendTiming.now')}</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t('composer.sendTiming.nowHint')}</span>
          </span>
        </button>
      ) : null}
      {deferredPicks.map((timing) => (
        <button
          key={timing}
          type="button"
          role="menuitem"
          data-menu-row
          data-send-timing={timing}
          onClick={() => { onPick(timing); }}
          className={`${MENU_ROW_CLASS} items-start`}
        >
          <span className="min-w-0 flex-1">
            <span className="block font-normal text-ink">
              {t('composer.sendTiming.timed', { timing: t(TIMING_SHORT_KEY[timing]) })}
            </span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t(TIMING_HINT_KEY[timing])}</span>
          </span>
        </button>
      ))}
    </>
  );
}

export function AddMenu(props: AddMenuProps) {
  const { t } = useI18n();
  const phoneMode = usePhoneMode();
  const coarse = useCoarsePointer();
  const [everOpened, setEverOpened] = useState(props.view !== 'closed');
  if (props.view !== 'closed' && !everOpened) {
    setEverOpened(true);
  }

  const attachOnly =
    !coarse && !phoneMode &&
    props.runMode === undefined && props.timing === undefined && props.onRebuild === undefined && props.ssh === undefined && props.skills === undefined
    && props.plugins === undefined && props.mcp === undefined && props.optional === undefined && props.files === undefined
    && (props.extensions === undefined || props.extensions.items.length === 0) && props.permission === undefined;

  if (attachOnly) {
    return (
      <button
        type="button"
        data-attach-button
        onClick={props.onAttach}
        disabled={props.attachDisabled}
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

  if (!everOpened && props.view === 'closed') {
    return (
      <div className="relative self-start" data-add-menu data-plan-select>
        <button
          type="button"
          data-add-menu-trigger
          aria-haspopup="menu"
          aria-expanded={false}
          aria-label={t('composer.addMenuAria')}
          title={t('composer.addMenuAria')}
          onClick={() => {
            setEverOpened(true);
            props.onViewChange('root');
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden className="transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    );
  }

  return <LazyAddMenuImpl {...props} />;
}

export function RunModeChip({
  runMode,
  onOpen,
  onClear,
  compact = false,
}: {
  readonly runMode: RunMode;
  readonly onOpen: () => void;
  readonly onClear: () => void;
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  if (runMode === 'normal') return null;
  const label = t(RUN_MODES.find((mode) => mode.id === runMode)!.labelKey);
  return (
    <span
      data-run-mode-chip={runMode}
      className="anim-enter flex h-7 shrink-0 items-center rounded-md bg-paper text-[13px] font-normal text-ink shadow-[var(--kiki-sheet-shadow)] pointer-coarse:h-10"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t('composer.runModeHeading')}: ${label}`}
        title={t(RUN_MODES.find((mode) => mode.id === runMode)!.hintKey)}
        className={`flex h-full items-center gap-1.5 rounded-l-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${
          compact ? '@max-[460px]/composer-shell:pr-0.5 @max-[460px]/composer-shell:pl-1.5' : ''
        }`}
      >
        <Icon name={runMode === 'goal' ? 'goal' : 'plan'} size={14} className="text-ink-soft" />
        <span className={compact ? '@max-[460px]/composer-shell:sr-only' : '@max-[360px]/composer-shell:sr-only'}>{label}</span>
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('composer.runModeClear')}
        title={t('composer.runModeClear')}
        className="flex h-full w-6 items-center justify-center rounded-r-md text-ink-faint outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:w-9"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

export function PermissionSelect({
  open,
  onOpenChange,
  value,
  onChange,
  compact = false,
  nativeAutoPermission = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
  readonly compact?: boolean;
  readonly nativeAutoPermission?: boolean;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = permissionModeDef(value) ?? PERMISSION_MODES[0]!;
  const danger = current.tone === 'danger';
  const close = (refocus = false) => {
    onOpenChange(false);
    if (refocus) triggerRef.current?.focus();
  };
  const onKeyDown = usePopover(open, close, rootRef, 'composer-mode', panelRef);

  const attachPermissionPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    node?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [open]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative" data-mode-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t('composer.permAria')}: ${t(current.labelKey)}`}
        title={`${t(current.labelKey)} — ${t(current.id === 'auto' && nativeAutoPermission ? 'composer.perm.autoNativeHint' : current.hintKey)}`}
        data-permission-tone={current.tone}
        data-permission-native-auto={nativeAutoPermission ? 'true' : undefined}
        onClick={() => { onOpenChange(!open); }}
        data-segment-set={value !== RECOMMENDED_PERMISSION_MODE ? '' : undefined}
        className={`${STATUS_SEGMENT_CLASS} max-w-56 @max-[30rem]/toolbar:gap-1 @max-[30rem]/toolbar:px-1.5 ${
          compact
            ? '@max-[420px]/composer-shell:w-7 @max-[420px]/composer-shell:pointer-coarse:w-11 @max-[420px]/composer-shell:justify-center @max-[420px]/composer-shell:px-0'
            : '@max-[380px]/composer-shell:w-7 @max-[380px]/composer-shell:pointer-coarse:w-11 @max-[380px]/composer-shell:justify-center @max-[380px]/composer-shell:px-0'
        } ${
          danger
            ? 'bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger aria-expanded:bg-danger/15 aria-expanded:text-danger'
            : value !== RECOMMENDED_PERMISSION_MODE ? STATUS_SEGMENT_SET : ''
        }`}
      >
        <Icon name="gate" size={14} className={`shrink-0 ${danger ? '' : STATUS_SEGMENT_ICON_CLASS}`} />
        <span className={`min-w-0 truncate ${compact ? '@max-[420px]/composer-shell:sr-only' : '@max-[380px]/composer-shell:sr-only'}`}>{t(current.labelKey)}</span>
      </button>
      {open ? (
        <LazyAnchoredFloatingPopover
          anchorRef={triggerRef}
          side="top"
          align="end"
          sideOffset={6}
          ownerId="composer-mode"
          popupRef={attachPermissionPanelRef}
          dataAttrs={{ 'data-permission-panel': '' }}
          onEscapeClose={() => { close(true); }}
          className={`composer-floating-panel anim-enter flex max-h-[min(var(--available-height,420px),420px,calc(100dvh-120px))] w-72 flex-col overflow-hidden p-1 outline-none ${POPOVER_SURFACE_CLASS}`}
        >
          <p className={`shrink-0 ${POPOVER_LABEL_CLASS}`}>{t('composer.permAria')}</p>
          <div role="listbox" aria-label={t('composer.permAria')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {PERMISSION_MODES.map((mode) => {
              const isCurrent = mode.id === value;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="option"
                  data-menu-row
                  data-mode-row
                  data-permission-mode={mode.id}
                  aria-selected={isCurrent}
                  onClick={() => {
                    onChange(mode.id);
                    close(true);
                  }}
                  className={`${MENU_ROW_CLASS} items-start ${isCurrent ? MENU_ROW_SELECTED_CLASS : ''}`}
                >
                  <Check on={isCurrent} />
                  <span className="min-w-0 flex-1">
                    <span className={`block font-normal ${mode.tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
                      {t(mode.labelKey)}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">
                      {t(mode.id === 'auto' && nativeAutoPermission ? 'composer.perm.autoNativeHint' : mode.hintKey)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </LazyAnchoredFloatingPopover>
      ) : null}
    </div>
  );
}

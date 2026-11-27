/**
 * Shared session context menu and mutation controller — single source of truth
 * for Sidebar session rows, persona subthreads, persona management rows,
 * persona conversation switchers, inbox rows, search results, and archived rows.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { useQueryClient } from '@tanstack/react-query';

import type { Session, SessionSeedMode } from '@kiki/protocol';
import {
  compactReceiptOutcome,
  compactSessionContext,
  exportSessionArchive,
  forkSession,
  sessionActionErrorText,
  undoLastTurn,
  type SessionActionContext,
} from '@kiki/session-core/commands';
import { appendToDraft, requestComposerInsert, threadRefLink } from '@kiki/session-core/composer';
import { errorText } from '@kiki/session-core/i18n';
import {
  isPinnedSession,
  pinMetadataPatch,
  sessionNotificationMode,
  toggleMutedNotificationMode,
  togglePinned,
  type SessionListData,
} from '@kiki/session-core/sessions';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useLayerHistory } from '../lib/layerHistory';
import { useCoarsePointer, usePhoneMode } from '../lib/layoutHooks';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { invalidatePersonaSessionLists } from '../lib/personaFreshness';
import { updateSessionNotificationMode } from '../lib/sessionNotificationMutation';
import { sessionRelationOf } from '../lib/sessionThreads';
import { readTopLevelThreads } from '../lib/threadDisplayMemory';
import { pushToast, runToastAction } from '../lib/toasts';
import { floatingSurfaceZIndex, registerOverlay } from '../lib/uiBusy';
import { unzoomedPoint, unzoomedViewport } from '../lib/uiZoom';
import { useOptionalConnection } from '../state/connection';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog, DIALOG_DEFAULT_PANEL_CLASS } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import type { MiniMenuEntry } from './MiniContextMenu';
import { ActionSheet } from './overlays/ActionSheet';
import { JoinRoomDialog, NewThreadRoomDialog } from './room/ThreadRoomDialogs';
import { isSubagentSession, useThreadCommsEnabled } from './room/threadRooms';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';
import { WorktreeArchiveDialog } from './WorktreeArchiveDialog';

export type SessionContentAction = 'undo' | 'compact' | 'export';
type SessionSubmenuKey = 'branch' | 'fork' | 'more';

const BRANCH_SEED_MODES: readonly SessionSeedMode[] = ['fresh', 'compact', 'verbatim'];
const FORK_SEED_MODES: readonly SessionSeedMode[] = ['verbatim', 'fresh', 'compact'];

export const SESSION_ROW_MENU_ITEM =
  'w-full rounded-md px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-paper focus-visible:bg-paper pointer-coarse:min-h-11 pointer-coarse:text-[14px]';
export const SESSION_ROW_MENU_DISABLED =
  'disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent';

export interface SessionMenuProps {
  readonly session: Session;
  /** Copy-link href (supports `/p/:connectionId/s/:id` for remote sessions). */
  readonly copyLinkHref?: string;
  /** True when the row belongs to a paired remote computer; suppresses local-only actions. */
  readonly isRemote?: boolean;
  /** The row's shown title, for the menu's accessible name. */
  readonly title: string;
  readonly topLevel?: boolean;
  readonly onToggleThreadDisplay?: () => void;
  readonly scopeId: string;
  /** The open conversation; the thread-reference entry needs one to insert into. */
  readonly activeSessionId: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  readonly onRename: () => void;
  readonly onTogglePin: () => void;
  readonly onToggleMute?: () => void;
  readonly onTogglePrivate: () => void;
  readonly onCreateBranch: (seed: SessionSeedMode) => void;
  readonly onForkSession: (seed: SessionSeedMode) => void;
  readonly onAction: (action: SessionContentAction) => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  /** Optional destructive delete for archived sessions. */
  readonly onDeleteArchived?: () => void;
  /** Optional surface-specific top entries (e.g. "Set as daily conversation"). */
  readonly extraTopEntries?: readonly MiniMenuEntry[];
  /** `[thread_communication].enabled`; undefined while the config loads. */
  readonly threadCommsEnabled: boolean | undefined;
  readonly onJoinRoom?: () => void;
  /** Its archive is in flight: only the entries that would race it go quiet. */
  readonly archiving?: boolean;
  /** Its privacy toggle is in flight: prevents concurrent conflicting toggles. */
  readonly privateBusy?: boolean;
  /** Portal to `document.body` (use inside overflow-clipped containers or popovers). */
  readonly portal?: boolean;
}

/**
 * The shared session row context menu: list management + direct branch/fork
 * submenus, with export/compact/undo under More on desktop and bottom-sheet
 * navigation on phone viewports.
 */
export function SessionContextMenu(props: SessionMenuProps) {
  const { t } = useI18n();
  const [sheetSubmenu, setSheetSubmenu] = useState<'branch' | 'fork' | null>(null);
  if (!usePhoneMode()) return <SessionPointerMenu {...props} />;
  const modes = sheetSubmenu === 'branch' ? BRANCH_SEED_MODES : FORK_SEED_MODES;
  return (
    <ActionSheet
      ariaLabel={t('sidebar.sessionActionsFor', { title: props.title })}
      overlayId="session-menu"
      dataAttribute="data-session-menu"
      onClose={() => {
        setSheetSubmenu(null);
        props.onClose();
      }}
    >
      {sheetSubmenu === null ? (
        <SessionMenuEntries
          {...props}
          phone
          onOpenSeedSubmenu={(kind) => { setSheetSubmenu(kind); }}
        />
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            data-menu-item="seed-back"
            className={`${SESSION_ROW_MENU_ITEM} text-ink-soft`}
            onClick={() => { setSheetSubmenu(null); }}
          >
            {t(sheetSubmenu === 'branch' ? 'menu.branch' : 'menu.fork')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitem"
              data-menu-item={`${sheetSubmenu}-${mode}`}
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => {
                const kind = sheetSubmenu;
                setSheetSubmenu(null);
                if (kind === 'branch') props.onCreateBranch(mode);
                else props.onForkSession(mode);
              }}
            >
              {t(`transcript.branch.seed.${mode}`)}
            </button>
          ))}
        </>
      )}
    </ActionSheet>
  );
}

function renderExtraEntries(entries: readonly MiniMenuEntry[] | undefined, onClose: () => void) {
  if (entries === undefined || entries.length === 0) return null;
  return (
    <>
      {entries.map((entry, index) =>
        'separator' in entry ? (
          <div key={`extra-sep-${index}`} className="mx-1 my-1 border-t border-hairline" />
        ) : (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            data-menu-item={entry.key}
            disabled={entry.disabled}
            className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED} ${
              entry.danger === true ? 'hover:text-danger' : ''
            }`}
            onClick={() => {
              onClose();
              runToastAction(entry.label, entry.run);
            }}
          >
            {entry.label}
          </button>
        ),
      )}
      <div className="mx-1 my-1 border-t border-hairline" />
    </>
  );
}

/** The menu's first level, shared by the desktop menu and the phone sheet. */
function SessionMenuEntries({
  session,
  copyLinkHref,
  isRemote = false,
  phone,
  topLevel = false,
  onToggleThreadDisplay,
  scopeId,
  activeSessionId,
  onClose,
  onRename,
  onTogglePin,
  onToggleMute,
  onTogglePrivate,
  onCreateBranch,
  onForkSession,
  onArchive,
  onRestore,
  onDeleteArchived,
  extraTopEntries,
  threadCommsEnabled,
  onJoinRoom,
  archiving = false,
  privateBusy = false,
  activeSubmenu = null,
  branchRef,
  forkRef,
  onOpenSeedSubmenu,
}: SessionMenuProps & {
  phone: boolean;
  activeSubmenu?: SessionSubmenuKey | null;
  branchRef?: RefObject<HTMLButtonElement | null>;
  forkRef?: RefObject<HTMLButtonElement | null>;
  onOpenSeedSubmenu?: (kind: 'branch' | 'fork') => void;
}) {
  const host = useHost();
  const { t } = useI18n();
  const archived = session.archived === true;
  const canTogglePrivate = session.ephemeral !== true && !isSubagentSession(session);
  const canBranchOrFork = !isRemote && canTogglePrivate;
  const cwd = session.metadata?.cwd ?? '';
  const canReveal = !phone && !isRemote && !scopeId.startsWith('ssh:') && host.revealPath !== undefined && cwd !== '';
  const canAddToConversation = !isRemote && activeSessionId !== undefined && activeSessionId !== session.id;
  const canJoinRoom = !isRemote && !isSubagentSession(session) && threadCommsEnabled !== false && onJoinRoom !== undefined;
  const runAndClose = (label: string, action: () => Promise<void>) => {
    onClose();
    runToastAction(label, action);
  };
  return (
    <>
      {renderExtraEntries(extraTopEntries, onClose)}
      {onToggleThreadDisplay !== undefined && sessionRelationOf(session)?.kind === 'thread' ? (
        <>
          <button type="button" role="menuitem" data-menu-item="thread-display" className={SESSION_ROW_MENU_ITEM} onClick={onToggleThreadDisplay}>
            {topLevel ? t('menu.showNested') : t('menu.showTopLevel')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
        </>
      ) : null}
      {archived ? (
        <>
          <button type="button" role="menuitem" data-menu-item="restore" className={SESSION_ROW_MENU_ITEM} onClick={onRestore}>
            {t('menu.restore')}
          </button>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={SESSION_ROW_MENU_ITEM}
            onClick={() => {
              runAndClose(t('menu.copyThreadLink'), () => copyTextToClipboard(copyLinkHref ?? `/s/${session.id}`));
            }}
          >
            {t('menu.copyThreadLink')}
          </button>
          {cwd !== '' ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="copy-path"
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.copyWorkingDirectory'), () => copyTextToClipboard(cwd)); }}
            >
              {t('menu.copyWorkingDirectory')}
            </button>
          ) : null}
          {canReveal ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="open-folder"
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.openWorkingDirectory'), () => host.revealPath!(cwd)); }}
            >
              {t('menu.openWorkingDirectory')}
            </button>
          ) : null}
          {onDeleteArchived !== undefined ? (
            <>
              <div className="mx-1 my-1 border-t border-hairline" />
              <button
                type="button"
                role="menuitem"
                data-menu-item="delete"
                className={`${SESSION_ROW_MENU_ITEM} hover:text-danger`}
                onClick={onDeleteArchived}
              >
                {t('archive.delete')}
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            data-menu-item="pin"
            disabled={archiving}
            className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED}`}
            onClick={onTogglePin}
          >
            {isPinnedSession(session) ? t('menu.unpin') : t('menu.pin')}
          </button>
          {onToggleMute !== undefined ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="toggle-mute"
              data-menu-action="toggle-mute"
              disabled={archiving}
              className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED}`}
              onClick={onToggleMute}
            >
              {sessionNotificationMode(session) === 'all' ? t('menu.muteNotifications') : t('menu.unmuteNotifications')}
            </button>
          ) : null}
          <button type="button" role="menuitem" data-menu-item="rename" className={SESSION_ROW_MENU_ITEM} onClick={onRename}>
            {t('menu.rename')}
          </button>
          {canTogglePrivate ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="private"
              disabled={archiving || privateBusy}
              className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED}`}
              onClick={onTogglePrivate}
            >
              {t(session.private === true ? 'private.exitPrivate' : 'private.makePrivate')}
            </button>
          ) : null}
          {canBranchOrFork ? (
            <>
              <div className="mx-1 my-1 border-t border-hairline" />
              <button
                ref={branchRef}
                type="button"
                role="menuitem"
                data-menu-item="branch"
                disabled={archiving}
                aria-haspopup={phone ? undefined : 'menu'}
                aria-expanded={phone ? undefined : activeSubmenu === 'branch'}
                className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED} flex items-center gap-2 ${!phone && activeSubmenu === 'branch' ? 'bg-paper' : ''}`}
                onClick={() => {
                  if (phone && onOpenSeedSubmenu !== undefined) {
                    onOpenSeedSubmenu('branch');
                    return;
                  }
                  onCreateBranch('fresh');
                }}
              >
                <span className="min-w-0 flex-1 truncate">{t('menu.branch')}</span>
                <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
              </button>
              <button
                ref={forkRef}
                type="button"
                role="menuitem"
                data-menu-item="fork"
                disabled={archiving}
                aria-haspopup={phone ? undefined : 'menu'}
                aria-expanded={phone ? undefined : activeSubmenu === 'fork'}
                className={`${SESSION_ROW_MENU_ITEM} ${SESSION_ROW_MENU_DISABLED} flex items-center gap-2 ${!phone && activeSubmenu === 'fork' ? 'bg-paper' : ''}`}
                onClick={() => {
                  if (phone && onOpenSeedSubmenu !== undefined) {
                    onOpenSeedSubmenu('fork');
                    return;
                  }
                  onForkSession('verbatim');
                }}
              >
                <span className="min-w-0 flex-1 truncate">{t('menu.fork')}</span>
                <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
              </button>
            </>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="copy-link"
            className={SESSION_ROW_MENU_ITEM}
            onClick={() => {
              runAndClose(t('menu.copyThreadLink'), () => copyTextToClipboard(copyLinkHref ?? `/s/${session.id}`));
            }}
          >
            {t('menu.copyThreadLink')}
          </button>
          {canAddToConversation ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="add-to-conversation"
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => {
                if (activeSessionId === undefined) return;
                onClose();
                const link = threadRefLink(session.id);
                if (!requestComposerInsert(activeSessionId, link)) appendToDraft(activeSessionId, link);
              }}
            >
              {t('menu.addToConversation')}
            </button>
          ) : null}
          {canJoinRoom ? (
            <button type="button" role="menuitem" data-menu-item="join-room" className={SESSION_ROW_MENU_ITEM} onClick={onJoinRoom}>
              {t('room.joinRoom')}
            </button>
          ) : null}
          {cwd !== '' ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="copy-path"
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.copyWorkingDirectory'), () => copyTextToClipboard(cwd)); }}
            >
              {t('menu.copyWorkingDirectory')}
            </button>
          ) : null}
          {canReveal ? (
            <button
              type="button"
              role="menuitem"
              data-menu-item="open-folder"
              className={SESSION_ROW_MENU_ITEM}
              onClick={() => { runAndClose(t('menu.openWorkingDirectory'), () => host.revealPath!(cwd)); }}
            >
              {t('menu.openWorkingDirectory')}
            </button>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="archive"
            disabled={archiving}
            className={`${SESSION_ROW_MENU_ITEM} hover:text-danger ${SESSION_ROW_MENU_DISABLED}`}
            onClick={onArchive}
          >
            {archiving ? t('sidebar.archiving') : t('menu.archive')}
          </button>
        </>
      )}
    </>
  );
}

function SessionPointerMenu(props: SessionMenuProps) {
  const { session, title, x, y, onClose, onAction, portal = false } = props;
  const { t } = useI18n();
  const archived = session.archived === true;
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = menuRef.current;
    if (node !== null) setSize({ width: node.offsetWidth, height: node.offsetHeight });
    node?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);

  const restoreTriggerFocus = () => {
    const trigger = returnFocusRef.current;
    if (trigger === null || trigger === document.body || !trigger.isConnected) return;
    trigger.focus();
  };
  const point = unzoomedPoint(x, y);
  const position = clampOverlayPosition(
    point.x,
    point.y,
    size ?? { width: 176, height: 0 },
    unzoomedViewport(),
  );
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayerHistory('session-menu', useCoarsePointer(), onClose);
  useEffect(() => {
    const unregister = registerOverlay('session-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const owned = menuRef.current?.contains(document.activeElement) === true;
      closeRef.current();
      if (owned) restoreTriggerFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('[data-session-menu]') === null) {
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const branchRef = useRef<HTMLButtonElement>(null);
  const forkRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<SessionSubmenuKey | null>(null);
  const [submenuFocus, setSubmenuFocus] = useState(0);
  const anchorForSubmenu = (key: SessionSubmenuKey | null): HTMLButtonElement | null => {
    if (key === 'branch') return branchRef.current;
    if (key === 'fork') return forkRef.current;
    if (key === 'more') return moreRef.current;
    return null;
  };
  const openSubmenu = (key: SessionSubmenuKey, focus: boolean) => {
    setActiveSubmenu(key);
    if (focus) setSubmenuFocus((count) => count + 1);
  };
  useEffect(() => {
    if (submenuFocus > 0) submenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [submenuFocus]);
  const [submenuPlace, setSubmenuPlace] = useState<{ top: number; left: boolean }>({ top: 0, left: false });
  useLayoutEffect(() => {
    const submenu = submenuRef.current;
    const anchor = anchorForSubmenu(activeSubmenu);
    const menuNode = menuRef.current;
    if (activeSubmenu === null || submenu === null || anchor === null || menuNode === null) return;
    const rect = anchor.getBoundingClientRect();
    const menuRect = menuNode.getBoundingClientRect();
    const baseTop = rect.top - menuRect.top - 5;
    const overflow = rect.top - 5 + submenu.offsetHeight - (window.innerHeight - 8);
    setSubmenuPlace({
      top: overflow > 0 ? baseTop - overflow : baseTop,
      left: rect.right + 8 + submenu.offsetWidth > window.innerWidth - 8,
    });
  }, [activeSubmenu]);
  const contentActions: readonly { action: SessionContentAction; label: string; danger?: boolean }[] = [
    { action: 'export', label: t('menu.export') },
    { action: 'compact', label: t('menu.compact') },
    { action: 'undo', label: t('menu.undo'), danger: true },
  ];

  const submenuEntries = activeSubmenu === 'branch'
    ? BRANCH_SEED_MODES.map((mode) => ({
        key: `branch-${mode}`,
        label: t(`transcript.branch.seed.${mode}`),
        danger: false,
        onSelect: () => { props.onCreateBranch(mode); },
      }))
    : activeSubmenu === 'fork'
      ? FORK_SEED_MODES.map((mode) => ({
          key: `fork-${mode}`,
          label: t(`transcript.branch.seed.${mode}`),
          danger: false,
          onSelect: () => { props.onForkSession(mode); },
        }))
      : activeSubmenu === 'more'
        ? contentActions.map((entry) => ({
            key: entry.action,
            label: entry.label,
            danger: entry.danger === true,
            onSelect: () => { onAction(entry.action); },
          }))
        : [];
  const submenuLabel = activeSubmenu === 'branch'
    ? t('menu.branch')
    : activeSubmenu === 'fork'
      ? t('menu.fork')
      : t('sidebar.menu.more');

  const zIndex = portal ? floatingSurfaceZIndex(null) : undefined;
  const node = (
    <div
      ref={menuRef}
      data-session-menu
      role="menu"
      aria-label={t('sidebar.sessionActionsFor', { title })}
      onKeyDown={(event) => {
        const submenu = submenuRef.current;
        const inSubmenu = submenu !== null && event.target instanceof Node && submenu.contains(event.target);
        if (inSubmenu && event.key === 'ArrowLeft') {
          event.preventDefault();
          const parent = anchorForSubmenu(activeSubmenu);
          setActiveSubmenu(null);
          parent?.focus();
          return;
        }
        if (!inSubmenu && event.key === 'ArrowRight') {
          const key: SessionSubmenuKey | null = event.target === branchRef.current ? 'branch'
            : event.target === forkRef.current ? 'fork'
              : event.target === moreRef.current ? 'more'
                : null;
          if (key !== null) {
            event.preventDefault();
            openSubmenu(key, true);
            return;
          }
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
        const scope = inSubmenu ? submenu : menuRef.current;
        const items = [...(scope?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
          .filter((item) => inSubmenu || submenu === null || !submenu.contains(item));
        if (items.length === 0) return;
        event.preventDefault();
        if (!inSubmenu) setActiveSubmenu(null);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
        items[next]?.focus();
      }}
      onPointerOver={(event) => {
        if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) return;
        const item = event.target.closest('[role="menuitem"]');
        if (item === null || submenuRef.current?.contains(item) === true) return;
        if (item === branchRef.current) openSubmenu('branch', false);
        else if (item === forkRef.current) openSubmenu('fork', false);
        else if (item === moreRef.current) openSubmenu('more', false);
        else setActiveSubmenu(null);
      }}
      onClick={(event) => {
        if (!(event.target instanceof HTMLElement) || event.target.closest('[role="menuitem"]') === null) return;
        const menuNode = menuRef.current;
        queueMicrotask(() => {
          if (menuNode === null || menuNode.isConnected) return;
          const active = document.activeElement;
          if (active !== null && active !== document.body && active instanceof HTMLElement && active.isConnected) return;
          restoreTriggerFocus();
        });
      }}
      className="anim-enter fixed z-50 w-44 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)]"
      style={{ left: position.left, top: position.top, ...(zIndex === undefined ? {} : { zIndex }) }}
    >
      <SessionMenuEntries
        {...props}
        phone={false}
        activeSubmenu={activeSubmenu}
        branchRef={branchRef}
        forkRef={forkRef}
      />
      {archived || props.isRemote === true ? null : (
        <>
          <div className="mx-1 my-1 border-t border-hairline" />
          <button
            ref={moreRef}
            type="button"
            role="menuitem"
            data-menu-item="more"
            aria-haspopup="menu"
            aria-expanded={activeSubmenu === 'more'}
            className={`${SESSION_ROW_MENU_ITEM} flex items-center gap-2 ${activeSubmenu === 'more' ? 'bg-paper' : ''}`}
            onClick={() => { openSubmenu('more', true); }}
          >
            <span className="min-w-0 flex-1 truncate">{t('sidebar.menu.more')}</span>
            <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />
          </button>
          {activeSubmenu !== null ? (
            <div
              ref={submenuRef}
              role="menu"
              aria-label={submenuLabel}
              data-session-submenu={activeSubmenu}
              className={`anim-enter absolute w-40 rounded-lg border border-hairline bg-panel p-1 shadow-[0_8px_24px_-10px_rgb(var(--kiki-shadow-ink)/0.3)] ${
                submenuPlace.left ? 'right-full mr-2' : 'left-full ml-2'
              }`}
              style={{ top: submenuPlace.top }}
            >
              {submenuEntries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="menuitem"
                  data-menu-item={entry.key}
                  className={`${SESSION_ROW_MENU_ITEM} ${entry.danger ? 'hover:text-danger' : ''}`}
                  onClick={entry.onSelect}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
  if (portal) {
    return (
      <Popover.Root open modal={false}>
        <Popover.Portal>{node}</Popover.Portal>
      </Popover.Root>
    );
  }
  return node;
}

/** Compact rename dialog used when renaming a session outside Sidebar's inline row editor. */
export function SessionRenameDialog({
  session,
  onSubmit,
  onClose,
}: {
  readonly session: Session;
  readonly onSubmit: (title: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const initialTitle = session.title.trim() !== '' ? session.title : (session.last_prompt?.trim() ?? '');
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (next === '' || next === session.title.trim()) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      onClose();
    } catch (cause: unknown) {
      setError(errorText(locale, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onClose={() => { if (!busy) onClose(); }}
      ariaLabel={t('rename.title')}
      overlayId="session-rename-dialog"
      panelClassName={`${DIALOG_DEFAULT_PANEL_CLASS} max-w-[380px] p-4`}
    >
      <form onSubmit={(event) => { void handleSubmit(event); }} className="flex flex-col gap-3">
        <h2 className="font-display text-[15px] font-bold text-ink">{t('rename.title')}</h2>
        <input
          ref={inputRef}
          type="text"
          data-session-rename-input
          value={title}
          onChange={(event) => { setTitle(event.target.value); }}
          placeholder={t('sidebar.untitled')}
          disabled={busy}
          className="h-9 w-full rounded-md border border-hairline bg-paper px-2.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        {error !== null ? (
          <p role="alert" className="text-[12px] text-danger">{error}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className={SECONDARY_BUTTON}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            data-session-rename-save
            disabled={busy || title.trim() === ''}
            className={PRIMARY_BUTTON}
          >
            {t('common.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export interface OpenSessionMenuOptions {
  readonly title?: string;
  readonly copyLinkHref?: string;
  readonly isRemote?: boolean;
  readonly extraTopEntries?: readonly MiniMenuEntry[];
  readonly onDeleteArchived?: () => void;
  readonly afterAction?: () => void;
}

interface ActiveSessionMenuState extends OpenSessionMenuOptions {
  readonly session: Session;
  readonly x: number;
  readonly y: number;
}

/**
 * Self-contained controller hook that wires the full `SessionContextMenu`
 * (rename, pin, private, branch, fork, export, compact, undo, join room,
 * archive/restore, worktree archive) onto any surface listing sessions.
 */
export function useSessionContextMenu(options: {
  readonly activeSessionId?: string;
  readonly portal?: boolean;
} = {}) {
  const { activeSessionId, portal = true } = options;
  const host = useHost();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const scopeId = connection?.scopeId ?? 'local';
  const { t, locale } = useI18n();
  const threadCommsEnabled = useThreadCommsEnabled(client);

  const [menu, setMenu] = useState<ActiveSessionMenuState | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<Session | null>(null);
  const [confirmArchiveWorktree, setConfirmArchiveWorktree] = useState<Session | null>(null);
  const [confirmDeleteArchived, setConfirmDeleteArchived] = useState<Session | null>(null);
  const [joiningRoom, setJoiningRoom] = useState<readonly Session[] | null>(null);
  const [roomDraft, setRoomDraft] = useState<readonly Session[] | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [privateBusyId, setPrivateBusyId] = useState<string | null>(null);
  const [deletingArchived, setDeletingArchived] = useState(false);

  const refreshAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['archived-sessions'] });
    invalidatePersonaSessionLists(queryClient);
  }, [queryClient]);

  const patchSessionCaches = useCallback((sessionId: string, transform: (entry: Session) => Session) => {
    queryClient.setQueriesData<SessionListData>({ queryKey: ['sessions'] }, (old) =>
      old === undefined || !Array.isArray(old.pages)
        ? old
        : {
            ...old,
            pages: old.pages.map((page) => (!Array.isArray(page?.items) ? page : {
              ...page,
              items: page.items.map((entry) => (entry.id === sessionId ? transform(entry) : entry)),
            })),
          },
    );
    if (queryClient.getQueryData(['session', sessionId]) !== undefined) {
      queryClient.setQueryData<Session>(['session', sessionId], (old) =>
        old === undefined ? old : transform(old),
      );
    }
  }, [queryClient]);

  const actionContext: SessionActionContext | undefined = useMemo(
    () => (client === undefined ? undefined : { client, host, refreshSessions: refreshAll, navigate }),
    [client, host, refreshAll, navigate],
  );

  const openSessionMenu = useCallback(
    (session: Session, x: number, y: number, extra?: OpenSessionMenuOptions) => {
      setMenu({ session, x, y, ...extra });
    },
    [],
  );
  const closeSessionMenu = useCallback(() => { setMenu(null); }, []);

  const titleOf = (session: Session, override?: string): string => {
    if (override !== undefined && override.trim() !== '') return override;
    if (session.title.trim() !== '') return session.title;
    if (session.last_prompt?.trim()) return session.last_prompt;
    return t('sidebar.untitled');
  };

  const handleTogglePin = (session: Session) => {
    setMenu(null);
    if (client === undefined || typeof client.updateSessionProfile !== 'function') return;
    const next = togglePinned(isPinnedSession(session));
    const metadata = pinMetadataPatch(session, next);
    patchSessionCaches(session.id, (entry) => ({
      ...entry,
      metadata: { ...entry.metadata, ...metadata, cwd: entry.metadata.cwd },
    }));
    void client
      .updateSessionProfile(session.id, { metadata })
      .then(() => { refreshAll(); })
      .catch((error: unknown) => {
        refreshAll();
        pushToast({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const handleToggleMute = (session: Session) => {
    setMenu(null);
    if (client === undefined || typeof client.updateSessionProfile !== 'function') return;
    const nextMode = toggleMutedNotificationMode(sessionNotificationMode(session));
    void updateSessionNotificationMode({
      client,
      queryClient,
      session,
      mode: nextMode,
    })
      .then(() => { refreshAll(); })
      .catch((error: unknown) => {
        refreshAll();
        pushToast({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const handleTogglePrivate = (session: Session) => {
    setMenu(null);
    if (client === undefined || typeof client.updateSession !== 'function' || privateBusyId === session.id) return;
    const nextPrivate = session.private !== true;
    setPrivateBusyId(session.id);
    void client
      .updateSession(session.id, { private: nextPrivate })
      .then((updated) => {
        patchSessionCaches(session.id, (entry) => ({ ...entry, ...updated, private: nextPrivate }));
        refreshAll();
        void queryClient.invalidateQueries({ queryKey: ['global-search'] });
        pushToast({ tone: 'success', text: t(nextPrivate ? 'private.madeToast' : 'private.exitedToast') });
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('private.updateFailed', { detail: errorText(locale, error) }) });
      })
      .finally(() => {
        setPrivateBusyId((current) => (current === session.id ? null : current));
      });
  };

  const handleCreateBranch = (session: Session, seed: SessionSeedMode) => {
    const afterAction = menu?.afterAction;
    setMenu(null);
    if (client === undefined || typeof client.createBranch !== 'function') return;
    void client
      .createBranch(session.id, { seed, tools_locked: false })
      .then((created) => {
        refreshAll();
        afterAction?.();
        void navigate(`/s/${session.id}/agent/${encodeURIComponent(created.agent_id)}`);
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('branch.failed', { detail: sessionActionErrorText(locale, error) }) });
      });
  };

  const handleForkSession = (session: Session, seed: SessionSeedMode) => {
    const afterAction = menu?.afterAction;
    setMenu(null);
    if (actionContext === undefined) return;
    void forkSession(actionContext, session, { seed })
      .then(() => { afterAction?.(); })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('action.forkFailed', { detail: sessionActionErrorText(locale, error) }) });
      });
  };

  const handleAction = (session: Session, action: SessionContentAction) => {
    setMenu(null);
    if (action === 'undo') {
      setConfirmUndo(session);
      return;
    }
    if (actionContext === undefined) return;
    const label = titleOf(session);
    if (action === 'export') {
      void exportSessionArchive(actionContext, session)
        .then((saved) => {
          if (saved) pushToast({ tone: 'success', text: t('action.exportDone', { title: label }) });
        })
        .catch((error: unknown) => {
          pushToast({ tone: 'error', text: t('action.exportFailed', { detail: sessionActionErrorText(locale, error) }) });
        });
    } else {
      void compactSessionContext(actionContext, session)
        .then((receipt) => {
          if (compactReceiptOutcome(receipt) === 'duplicate') {
            pushToast({ tone: 'info', text: t('context.compaction.manual.duplicate') });
            return;
          }
          pushToast({ tone: 'success', text: t('action.compactRequested', { title: label }) });
        })
        .catch((error: unknown) => {
          pushToast({ tone: 'error', text: t('action.compactFailed', { detail: sessionActionErrorText(locale, error) }) });
        });
    }
  };

  const handleArchive = (session: Session) => {
    setMenu(null);
    if (client === undefined || typeof client.archiveSession !== 'function') return;
    if (session.worktree !== undefined) {
      setConfirmArchiveWorktree(session);
      return;
    }
    if (archivingId === session.id) return;
    setArchivingId(session.id);
    const exclude = [...readTopLevelThreads(scopeId)].filter((id) => id !== session.id);
    void client
      .archiveSession(session.id, { include_attached: true, exclude_session_ids: exclude })
      .then(() => {
        patchSessionCaches(session.id, (entry) => ({ ...entry, archived: true }));
        refreshAll();
        if (activeSessionId === session.id) void navigate('/new');
      })
      .catch((error: unknown) => {
        refreshAll();
        pushToast({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => {
        setArchivingId((current) => (current === session.id ? null : current));
      });
  };

  const handleRestore = (session: Session) => {
    setMenu(null);
    if (client === undefined || typeof client.restoreSession !== 'function') return;
    void client
      .restoreSession(session.id)
      .then(() => {
        patchSessionCaches(session.id, (entry) => ({ ...entry, archived: false }));
        refreshAll();
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: errorText(locale, error) });
      });
  };

  const handleDeleteArchived = () => {
    const target = confirmDeleteArchived;
    if (target === null || client === undefined || typeof client.deleteArchivedSession !== 'function' || deletingArchived) return;
    setDeletingArchived(true);
    const exclude = [...readTopLevelThreads(scopeId)].filter((id) => id !== target.id);
    const label = titleOf(target);
    void client
      .deleteArchivedSession(target.id, { exclude_session_ids: exclude })
      .then((result) => {
        if (result.failed.length > 0) {
          pushToast({ tone: 'error', text: result.failed[0]?.message ?? t('archive.deleteFailed') });
        } else {
          pushToast({ tone: 'success', text: t('archive.deleteOneDone', { title: label }) });
        }
        setConfirmDeleteArchived(null);
        refreshAll();
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: errorText(locale, error) });
      })
      .finally(() => {
        setDeletingArchived(false);
      });
  };

  const menuPortal = (
    <>
      {menu !== null ? (
        <SessionContextMenu
          session={menu.session}
          copyLinkHref={menu.copyLinkHref}
          isRemote={menu.isRemote}
          title={titleOf(menu.session, menu.title)}
          scopeId={scopeId}
          activeSessionId={activeSessionId}
          x={menu.x}
          y={menu.y}
          portal={portal}
          extraTopEntries={menu.extraTopEntries}
          onClose={closeSessionMenu}
          onRename={() => {
            setRenaming(menu.session);
            setMenu(null);
          }}
          onTogglePin={() => { handleTogglePin(menu.session); }}
          onToggleMute={() => { handleToggleMute(menu.session); }}
          onTogglePrivate={() => { handleTogglePrivate(menu.session); }}
          onCreateBranch={(seed) => { handleCreateBranch(menu.session, seed); }}
          onForkSession={(seed) => { handleForkSession(menu.session, seed); }}
          onAction={(action) => { handleAction(menu.session, action); }}
          onArchive={() => { handleArchive(menu.session); }}
          onRestore={() => { handleRestore(menu.session); }}
          onDeleteArchived={
            menu.onDeleteArchived !== undefined
              ? () => {
                  const fn = menu.onDeleteArchived;
                  setMenu(null);
                  fn?.();
                }
              : menu.session.archived === true && client !== undefined && typeof client.deleteArchivedSession === 'function'
                ? () => {
                    setConfirmDeleteArchived(menu.session);
                    setMenu(null);
                  }
                : undefined
          }
          archiving={archivingId === menu.session.id}
          privateBusy={privateBusyId === menu.session.id}
          threadCommsEnabled={menu.isRemote === true ? false : threadCommsEnabled}
          onJoinRoom={
            client !== undefined
              ? () => {
                  setJoiningRoom([menu.session]);
                  setMenu(null);
                }
              : undefined
          }
        />
      ) : null}
      {renaming !== null ? (
        <SessionRenameDialog
          session={renaming}
          onClose={() => { setRenaming(null); }}
          onSubmit={async (nextTitle) => {
            if (client === undefined || typeof client.updateSessionProfile !== 'function') return;
            const target = renaming;
            patchSessionCaches(target.id, (entry) => ({ ...entry, title: nextTitle }));
            const updated = await client.updateSessionProfile(target.id, { title: nextTitle });
            if (updated !== undefined && updated !== null && typeof updated === 'object' && 'id' in updated) {
              patchSessionCaches(target.id, (entry) => ({ ...entry, ...updated, title: nextTitle }));
            }
            refreshAll();
          }}
        />
      ) : null}
      {confirmUndo !== null ? (
        <ConfirmDialog
          open
          title={t('undo.title')}
          body={t('undo.bodyNamed', { title: titleOf(confirmUndo) })}
          confirmLabel={t('undo.confirm')}
          overlayId="shared-session-confirm-undo"
          onConfirm={() => {
            const target = confirmUndo;
            setConfirmUndo(null);
            if (actionContext === undefined) return;
            void undoLastTurn(actionContext, target)
              .then(() => {
                pushToast({ tone: 'success', text: t('action.undoDone', { title: titleOf(target) }) });
              })
              .catch((error: unknown) => {
                pushToast({ tone: 'error', text: t('action.undoFailed', { detail: sessionActionErrorText(locale, error) }) });
              });
          }}
          onCancel={() => { setConfirmUndo(null); }}
        />
      ) : null}
      {confirmDeleteArchived !== null ? (
        <ConfirmDialog
          open
          overlayId="shared-session-delete-archived"
          title={t('archive.deleteOneTitle')}
          body={t('archive.deleteOneBody', { title: titleOf(confirmDeleteArchived) })}
          consequences={[t('archive.deleteOneFamily'), t('archive.deleteOneTopLevel')]}
          confirmLabel={t('archive.deleteOneConfirm')}
          busy={deletingArchived}
          onConfirm={handleDeleteArchived}
          onCancel={() => { if (!deletingArchived) setConfirmDeleteArchived(null); }}
        />
      ) : null}
      {confirmArchiveWorktree?.worktree !== undefined ? (
        <WorktreeArchiveDialog
          session={{ ...confirmArchiveWorktree, worktree: confirmArchiveWorktree.worktree }}
          excludeSessionIds={[...readTopLevelThreads(scopeId)].filter((id) => id !== confirmArchiveWorktree.id)}
          onClose={() => { setConfirmArchiveWorktree(null); }}
          onArchiveFailed={refreshAll}
          onArchived={(result) => {
            const archivedId = confirmArchiveWorktree.id;
            setConfirmArchiveWorktree(null);
            refreshAll();
            if (activeSessionId === archivedId) void navigate('/new');
            if (result !== null) pushToast({ tone: result.tone === 'error' ? 'error' : 'info', text: result.text });
          }}
        />
      ) : null}
      {roomDraft !== null ? (
        <NewThreadRoomDialog threads={roomDraft} onClose={() => { setRoomDraft(null); }} />
      ) : null}
      {joiningRoom !== null && joiningRoom[0] !== undefined ? (
        <JoinRoomDialog
          session={joiningRoom[0]}
          threads={joiningRoom}
          onClose={() => { setJoiningRoom(null); }}
          onNewRoom={() => { setRoomDraft(joiningRoom); setJoiningRoom(null); }}
        />
      ) : null}
    </>
  );

  return {
    openSessionMenu,
    closeSessionMenu,
    menuSessionId: menu?.session.id ?? null,
    menuPortal,
  };
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { readDesktopPrefs } from '@kiki/session-core/settings';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { clampOverlayPosition } from '../lib/overlayPosition';
import { useSpacePreferencesFrame } from '../lib/spacePreferences';
import { spaceSettingsTargetOf } from '../lib/spaceSettings';
import { browsableRemote, connectionAddress, remoteSummaryView, useRemoteConnections } from '../lib/remoteConnections';
import { relativeTime } from '@kiki/session-core/util/time';
import {
  MAIN_SPACE_ID,
  currentSpace,
  currentSpaceId,
  enterSpace,
  launchWindowMode,
  otherSpacesPending,
  spaceRunState,
  spaceStatus,
  useSpaceStatuses,
  useSpaces,
  type SpaceListItem,
} from '../lib/spaces';
import { pushToast } from '../lib/toasts';
import { readHomeViewRoute } from '../lib/spaceViewState';
import type { PreparedScope } from '../lib/navScope';
import { registerOverlay } from '../lib/uiBusy';
import { useConnection } from '../state/connection';
import type { RemoteConnection } from '@kiki/protocol';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { RemoteStateChip } from './settings/remote/parts';
import { useRemoteSpaceEntry, useReturnToLocalSpace } from './settings/remote/useRemoteSpaceEntry';
import { Wordmark } from './Wordmark';

const MENU_WIDTH = 296;

/**
 * §6.4 / §9.4: the sidebar wordmark is the one space entry. It is always a
 * menu button, so a single-home user can discover "New space…" without an
 * extra row; the quiet chevron stays visible because touch has no hover.
 * Inside a space the wordmark is followed by the space's color and name. The
 * count is the other spaces' approvals and questions (this space's own are
 * already in Activity). Ctrl+Alt+1…9 opens the Nth space once there are two.
 */
export function SpaceSwitcher() {
  const { client, localClient, sshLabel, connectionId, activateLocal, restoreLocal, scopeAdapter, meta } = useConnection();
  const host = useHost();
  const navigate = useGuardedNavigate();
  const guard = useDirtyGuard();
  const { t, tp } = useI18n();
  const directoryClient = host.kind === 'tauri' ? localClient : null;
  const spaces = useSpaces(directoryClient);
  // Remote Kikis are read from the local control home, the same list the
  // settings page manages; a remote space itself is never asked for it.
  const remoteConnections = useRemoteConnections(directoryClient);
  const enterRemoteSpace = useRemoteSpaceEntry();
  const returnToLocal = useReturnToLocalSpace();
  // One read of the current space's preferences, which the appearance surfaces
  // and the portable settings bridge both consume from here on. It reads the
  // same connection the origin marks and the space detail read, so the three
  // never disagree about which server and home they are describing.
  useSpacePreferencesFrame(spaceSettingsTargetOf(client, meta));
  const statuses = useSpaceStatuses(host);
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  const here = currentSpace();
  /** This window is showing a Kiki other than its own (SSH or a broker connection). */
  const inRemoteScope = (typeof connectionId === 'string' && connectionId !== '') || (typeof sshLabel === 'string' && sshLabel.length > 0);
  const records = remoteConnections.data ?? [];
  // Only a connection whose purposes include browsing is a space; one kept for
  // thread messages is managed in Settings, never entered from here.
  const remoteItems = records.filter(browsableRemote);
  const currentRemote = typeof connectionId !== 'string' ? undefined : records.find((record) => record.id === connectionId);
  const items = spaces.data ?? [];
  const others = items.filter((item) => item.id !== MAIN_SPACE_ID);
  const ready = directoryClient !== null && !spaces.isPending;
  // Preserve the single-home fallback only after a real local connection exists.
  const mainItem = items.find((item) => item.id === MAIN_SPACE_ID) ?? ({ id: MAIN_SPACE_ID, name: MAIN_SPACE_ID } as SpaceListItem);
  const ordered = ready ? [mainItem, ...others] : [];
  // Local spaces first, remote spaces after: the shortcut numbering follows what
  // the menu shows.
  const entries = [
    ...ordered.map((space) => ({ kind: 'local' as const, space })),
    ...remoteItems.map((record) => ({ kind: 'remote' as const, record })),
  ];
  const multi = entries.length > 1;
  // Windows mode: each space window carries its own taskbar badge, and the
  // desktop cannot read other processes' counts (§9.4).
  const pending = mode === 'switch' ? otherSpacesPending(statuses.data) : 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);
  const currentName = here === null ? t('st.spaces.main') : (here.name ?? items.find((item) => item.id === here.homeId)?.name ?? here.homeId);
  const currentRemoteName = currentRemote?.label ?? t('sidebar.space.remoteKiki');

  const directoryRef = useRef(directoryClient);
  directoryRef.current = directoryClient;
  const enteringRef = useRef(false);
  const localView = () => readHomeViewRoute(currentSpaceId(), 'local') ?? '/new';
  const runAction = (action: (signal?: AbortSignal) => void | Promise<void>, target?: string) => {
    const result = guard?.runAction !== undefined ? guard.runAction(action, target)
      : Promise.resolve(action()).then(() => { if (target !== undefined) navigate(target); });
    void result?.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };
  const backToLocal = () => {
    setOpen(false);
    // A remote space was never a local home: leaving it is a scope switch back
    // to the space this window really belongs to, not a native home switch.
    if (typeof connectionId === 'string' && connectionId !== '') { returnToLocal(); return; }
    if (mode === 'switch') activateLocal();
    else runAction(restoreLocal, localView());
  };
  const openSettings = (target: string) => {
    setOpen(false);
    if (!inRemoteScope) { navigate(target); return; }
    const result = guard?.runAction !== undefined
      ? guard.runAction(restoreLocal, target)
      : restoreLocal().then(() => { navigate(target); });
    void result?.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };
  const enter = (space: SpaceListItem) => {
    setOpen(false);
    if (!ready || enteringRef.current || (!inRemoteScope && space.id === currentSpaceId())) return;
    if (host.kind !== 'tauri') return;
    const target = mode === 'windows' && inRemoteScope ? localView() : undefined;
    const open = async (signal = new AbortController().signal) => {
      if (directoryRef.current !== directoryClient || enteringRef.current) throw new DOMException('Space entry was superseded.', 'AbortError');
      enteringRef.current = true;
      setEntering(space.id);
      let prepared: PreparedScope | undefined;
      try {
        if (target !== undefined) {
          prepared = await scopeAdapter.prepare({ homeId: currentSpaceId(), scopeId: 'local' }, signal);
          await prepared.validate(target, signal);
        }
        signal.throwIfAborted();
        if (directoryRef.current !== directoryClient) throw new DOMException('The local space connection changed.', 'AbortError');
        if (mode !== 'windows' || space.id !== currentSpaceId()) await enterSpace(host, space.id, mode);
        // An opened native window is not compensated if this window cancels now.
        signal.throwIfAborted();
        await prepared?.commit();
      } catch (error) { await prepared?.dispose(); throw error; }
      finally { enteringRef.current = false; setEntering(null); }
    };
    const result = mode === 'switch' ? open() : guard?.runAction !== undefined ? guard.runAction(open, target)
      : open().then(() => { if (target !== undefined) navigate(target); });
    void result?.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      pushToast({ tone: 'error', text: t('st.spaces.switchFailed', { name: label(space) }) });
    });
  };
  const enterRef = useRef(enter);
  enterRef.current = enter;

  // Window-level shortcut, never a global hotkey: Ctrl+Alt+1…9 → Nth space.
  useEffect(() => {
    if (!multi) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      const target = entries[Number(digit) - 1];
      if (target === undefined) return;
      event.preventDefault();
      if (target.kind === 'local') enterRef.current(target.space);
      else enterRemoteSpace(target.record.id, target.record.label);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [multi, entries]);

  const title = pending > 0 ? `${t('sidebar.space.switcherAria')} · ${tp('sidebar.space.otherPending', pending)}` : t('sidebar.space.switcherAria');
  const enteringName = entering === null ? null : label(items.find((item) => item.id === entering) ?? { id: entering, name: entering } as SpaceListItem);
  const shownName = enteringName !== null ? t('sidebar.space.starting', { name: enteringName })
    : inRemoteScope ? (sshLabel ?? (currentRemote === undefined ? t('sidebar.space.remoteKiki') : currentRemote.label))
      : here === null ? null : currentName;

  return (
    <>
      <button ref={triggerRef} type="button" data-space-switcher={inRemoteScope ? undefined : currentSpaceId()} data-space-remote={inRemoteScope ? '' : undefined} aria-haspopup="menu" aria-expanded={open}
        aria-label={`kiki · ${inRemoteScope ? shownName ?? currentRemoteName : currentName} · ${title}`} title={title}
        onClick={() => { setOpen((value) => !value); }}
        className="group -ml-2 flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-ink transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink">
        <span aria-hidden className="shrink-0"><Wordmark /></span>
        {shownName !== null ? (
          <>
            {/* The space's dot doubles as the separator from the wordmark. */}
            {!inRemoteScope && here !== null ? <SpaceDot color={here.color} className="ml-1" /> : null}
            <span data-space-switcher-name title={shownName} className="min-w-0 truncate text-[13px] font-medium">{shownName}</span>
            {inRemoteScope ? (
              <span data-space-remote-tag className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 text-[11px] font-medium leading-[18px] text-ink-soft">{t('sidebar.space.remoteTag')}</span>
            ) : null}
          </>
        ) : null}
        {pending > 0 ? (
          <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] text-on-accent">{pending}</span>
        ) : null}
        <Icon name="chevron" size={12} className="shrink-0 rotate-90 text-ink-faint transition-transform group-hover:text-ink-soft group-aria-expanded:-rotate-90" />
      </button>
      {open ? (
        <SpaceMenu anchor={triggerRef.current} onClose={() => { setOpen(false); }}>
          {inRemoteScope ? (
            <>
              <p data-space-remote-note className="px-3 pt-2 pb-2 text-[12px] leading-[1.45] text-ink-soft">{t('sidebar.space.remoteBody', { name: sshLabel ?? currentRemoteName })}</p>
              <button type="button" role="menuitem" data-space-back-local
                onClick={backToLocal}
                className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
                <Icon name="chevron" size={12} className="shrink-0 rotate-180 text-ink-soft" />
                {t('sidebar.space.backToLocal')}
              </button>
              <div className="mx-1 my-1 border-t border-hairline" />
            </>
          ) : null}
          <p className="px-3 pt-2 pb-1 text-[12px] font-medium text-ink-faint">{t('sidebar.space.groupLocal')}</p>
          {!ready ? <p data-space-directory-pending role="status" className="px-3 pb-2 text-[12px] text-ink-soft">{t(host.kind === 'tauri' ? 'st.spaces.loading' : 'st.spaces.desktopOnly')}</p> : null}
          {ready && !multi ? <p data-space-single-hint className="px-3 pb-2 text-[12px] leading-[1.45] text-ink-soft">{t('sidebar.space.singleHint')}</p> : null}
          {ordered.map((space, index) => {
            const localRun = spaceRunState(space.id, statuses.data);
            const run = inRemoteScope && localRun === 'current' ? 'hot' : localRun;
            const count = spaceStatus(space.id, statuses.data)?.pendingCount ?? 0;
            const current = run === 'current';
            return (
              <button key={space.id} type="button" role="menuitem" data-space-switch-item={space.id} data-space-state={run}
                aria-current={current ? 'true' : undefined}
                onClick={() => { enter(space); }}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
                <SpaceDot color={space.id === MAIN_SPACE_ID ? 'var(--color-ink-faint)' : space.color} />
                <span className={`min-w-0 flex-1 truncate ${current ? 'font-medium' : ''}`}>{label(space)}</span>
                {current ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-ink-soft"><Icon name="check" size={12} />{t('st.spaces.current')}</span>
                ) : mode === 'switch' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-faint">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${run === 'hot' ? 'bg-success' : 'border border-ink-faint/70'}`} />
                    {t(run === 'hot' ? 'st.spaces.running' : 'st.spaces.notStarted')}
                  </span>
                ) : (
                  <span className="shrink-0 text-[11.5px] text-ink-faint">{t('sidebar.space.openWindow')}</span>
                )}
                {count > 0 && !current && mode === 'switch' ? (
                  <span className="shrink-0 rounded-full bg-attention-soft px-1.5 text-[11px] font-medium tabular-nums text-attention" aria-label={tp('st.spaces.pending', count)}>{count}</span>
                ) : null}
                {index < 9 && multi ? <kbd className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint md:inline">⌃⌥{index + 1}</kbd> : null}
              </button>
            );
          })}
          {remoteItems.length > 0 ? (
            <>
              <div className="mx-1 my-1 border-t border-hairline" />
              <p className="px-3 pt-1 pb-1 text-[12px] font-medium text-ink-faint">{t('sidebar.space.groupRemote')}</p>
              {remoteItems.map((record, index) => (
                <RemoteSpaceRow key={record.id} record={record} current={connectionId === record.id}
                  shortcut={ordered.length + index + 1} showShortcut={ordered.length + index < 9 && multi}
                  onEnter={() => { setOpen(false); enterRemoteSpace(record.id, record.label); }} />
              ))}
            </>
          ) : null}
          <div className="mx-1 my-1 border-t border-hairline" />
          {here === null ? (
            <button type="button" role="menuitem" data-space-new-entry
              onClick={() => { openSettings('/settings/spaces?new=1'); }}
              className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
              <Icon name="plus" size={14} className="shrink-0 text-ink-soft" />
              {t('sidebar.space.new')}
            </button>
          ) : null}
          <button type="button" role="menuitem" data-space-manage
            onClick={() => { openSettings('/settings/spaces'); }}
            className="flex h-9 w-full items-center rounded-md px-3 text-left text-[13px] text-ink-soft outline-none transition-colors hover:bg-paper hover:text-ink focus-visible:bg-paper">
            {t('sidebar.space.manage')}
          </button>
        </SpaceMenu>
      ) : null}
    </>
  );
}

/**
 * One remote Kiki in the menu: its own name and state lead, the address and the
 * last contact stay secondary, and a stale reading says when it was taken
 * instead of reading as a fresh zero.
 */
function RemoteSpaceRow({ record, current, shortcut, showShortcut, onEnter }: {
  record: RemoteConnection;
  current: boolean;
  shortcut: number;
  showShortcut: boolean;
  onEnter: () => void;
}) {
  const { t, locale } = useI18n();
  const summary = remoteSummaryView(record);
  const stale = summary !== null && summary.stale && summary.asOf !== undefined;
  const secondary = [
    connectionAddress(record.endpoint),
    stale && summary?.asOf !== undefined
      ? t('sidebar.space.remoteAsOf', { time: relativeTime(new Date(summary.asOf).toISOString(), locale) })
      : record.lastConnectedAt === undefined
        ? t('sidebar.space.remoteNever')
        : relativeTime(new Date(record.lastConnectedAt).toISOString(), locale),
  ].join(' · ');
  return (
    <button type="button" role="menuitem" data-space-remote-item={record.id} data-space-remote-state={record.state}
      data-space-remote-stale={stale ? '' : undefined}
      aria-current={current ? 'true' : undefined}
      onClick={onEnter}
      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-paper focus-visible:bg-paper">
      <Icon name="web" size={14} className="shrink-0 text-ink-faint" />
      {/* The name keeps its own line: a long one truncates rather than pushing
          the state, the counts or the shortcut out of the row. */}
      <span className="min-w-0 flex-1 py-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate ${current ? 'font-medium' : ''}`} title={record.label}>{record.label}</span>
          <RemoteStateChip state={record.state} className="text-[11px]" />
          {current ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-ink-soft"><Icon name="check" size={12} />{t('st.spaces.current')}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-faint" title={`${record.label} · ${record.endpoint}`}>{secondary}</span>
        {summary !== null && (summary.busy > 0 || summary.needsYou > 0) ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-faint">
            {summary.busy > 0 ? <span data-space-remote-busy className="tabular-nums">{t('sidebar.space.remoteBusy', { count: summary.busy })}</span> : null}
            {summary.needsYou > 0 ? (
              <span data-space-remote-needs className="tabular-nums text-attention">{t('sidebar.space.remoteNeedsYou', { count: summary.needsYou })}</span>
            ) : null}
          </span>
        ) : null}
      </span>
      {showShortcut ? <kbd className="hidden shrink-0 font-mono text-[10.5px] text-ink-faint md:inline">⌃⌥{shortcut}</kbd> : null}
    </button>
  );
}

function SpaceMenu({ anchor, onClose, children }: { anchor: HTMLElement | null; onClose: () => void; children: React.ReactNode }) {  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    setHeight(ref.current?.offsetHeight ?? 0);
    ref.current?.querySelector<HTMLButtonElement>('[aria-current="true"], button')?.focus();
  }, []);
  useEffect(() => {
    const unregister = registerOverlay('space-switcher-menu');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); anchor?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length]?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (ref.current?.contains(event.target) === true || anchor?.contains(event.target) === true) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor]);
  const rect = anchor?.getBoundingClientRect();
  const position = clampOverlayPosition(rect?.left ?? 8, (rect?.bottom ?? 0) + 4, { width: MENU_WIDTH, height }, { width: window.innerWidth, height: window.innerHeight });
  return createPortal(
    <div ref={ref} role="menu" aria-label={t('sidebar.space.menuTitle')} data-space-switcher-menu
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
      className="anim-enter fixed z-50 max-h-[min(72vh,480px)] overflow-y-auto rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
      {children}
    </div>,
    document.body,
  );
}

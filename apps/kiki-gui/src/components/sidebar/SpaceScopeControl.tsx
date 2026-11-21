/**
 * SpaceScopeControl — Zone 1 top-left control aligned on the `18px` keyline.
 *
 * Unifies the Kiki wordmark, multi-space scope (`全部空间` default vs focused
 * single space `● <SpaceName> ×`), and the space-switch popover/sheet.
 *
 * - Single-home setup with zero paired remotes: stays ultra-quiet (`kiki.` with
 *   hover chevron).
 * - Multi-space setup in `全部空间`: renders `kiki.` + compact `全部空间 ▾`
 *   capsule (plus a quiet dot with hover `title` if a paired remote is offline
 *   or stale — zero defensive text).
 * - Focused single space (`local:<id>` / `remote:<id>`): renders compact pill
 *   `● <SpaceName>` with an adjacent `×` button (`Ctrl+Alt+0`) returning to
 *   `全部空间` in one click.
 * - Opening the popover immediately triggers a background `refetch()` of
 *   paired remotes so newly paired peers appear without waiting for a timer.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { RemoteConnection } from '@kiki/protocol';
import { readDesktopPrefs, writeLayoutPreferences } from '@kiki/session-core/settings';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { appShellConnectUrl, isEmbeddedAndroidHost } from '../../lib/appShell';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { requestScopeNavigation, type PreparedScope } from '../../lib/navScope';
import { isLocalOwnerRequiredError } from '../../lib/peerAccess';
import {
  browsableRemote,
  connectionsApi,
  fingerprint,
  hasGuiPurpose,
  remoteConnectionKeys,
  remoteSpaceScope,
  useRemoteConnections,
} from '../../lib/remoteConnections';
import { useSpaceLocation } from '../../lib/spaceLocation';
import { useSpacePreferencesFrame } from '../../lib/spacePreferences';
import { spaceSettingsTargetOf } from '../../lib/spaceSettings';
import {
  MAIN_SPACE_ID,
  currentSpace,
  currentSpaceId,
  enterSpace,
  launchWindowMode,
  otherSpacesPending,
  useSpaceStatuses,
  useSpaces,
  type SpaceListItem,
} from '../../lib/spaces';
import { readHomeViewRoute } from '../../lib/spaceViewState';
import { pushToast, UNDO_TOAST_MS } from '../../lib/toasts';
import { threadBridgeKeys } from '../../lib/threadBridges';
import {
  ALL_SPACE_SCOPE,
  spaceKeyToScope,
  spaceScopeToKey,
  type MultiSpaceHealth,
} from '../../lib/useMultiSpaceSessions';
import { useConnection } from '../../state/connection';
import { useDirtyGuard, useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { PairSheet } from '../settings/remote/PairSheet';
import { useRemoteSpaceEntry, useReturnToLocalSpace } from '../settings/remote/useRemoteSpaceEntry';
import { SpaceDot } from '../settings/spaces/SpaceDot';
import { SpaceSwitchSheet, classifyRemoteSwitchError, type SpaceRowFailure } from '../SpaceSwitchSheet';
import { Wordmark } from '../Wordmark';

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

export interface SpaceScopeControlProps {
  /** Optional per-space health map from `useMultiSpaceSessions` for quiet stale/offline dot. */
  readonly healthBySpace?: ReadonlyMap<string, MultiSpaceHealth>;
}

export function SpaceScopeControl({ healthBySpace }: SpaceScopeControlProps = {}) {
  const {
    client,
    localClient,
    sshLabel,
    connectionId,
    connectionSource,
    activateLocal,
    restoreLocal,
    scopeAdapter,
    meta,
    localSpaceKey,
    localScopeId,
  } = useConnection();
  const host = useHost();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const guard = useDirtyGuard();
  const { t, tp, locale } = useI18n();
  const layoutPrefs = useLayoutPreferences();

  const [open, setOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<SpaceRowFailure | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const spaceScope = layoutPrefs.spaceScope ?? ALL_SPACE_SCOPE;
  const focusedKey = spaceScopeToKey(spaceScope);
  const inSshScope = typeof sshLabel === 'string' && sshLabel.length > 0;
  // Distinguish brokered remote/SSH scopes from a top-level Capacitor `app-shell`
  // host connection: on `app-shell`, `client` IS the connected host control client.
  const inBrokeredScope =
    (typeof connectionId === 'string' && connectionId !== '') ||
    inSshScope ||
    connectionSource === 'remote';
  const desktop = host.kind === 'tauri';

  const browserDirectoryClient = inSshScope
    ? null
    : (inBrokeredScope ? localClient : (localClient ?? client));
  const directoryClient = desktop ? localClient : (open ? browserDirectoryClient : null);
  const spaces = useSpaces(directoryClient);

  const remoteClient = desktop ? localClient : (localClient ?? (inBrokeredScope ? null : client));
  const hasRemoteConnectionsApi = remoteClient?.klient.rest?.connections !== undefined;
  const remoteConnections = useRemoteConnections(hasRemoteConnectionsApi ? remoteClient : null, {
    poll: open || spaceScope === ALL_SPACE_SCOPE,
  });
  const enterRemoteSpace = useRemoteSpaceEntry();
  const returnToLocal = useReturnToLocalSpace();

  useSpacePreferencesFrame(spaceSettingsTargetOf(client, meta));
  const statuses = useSpaceStatuses(host);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  const here = currentSpace();
  const records = remoteConnections.data ?? [];
  const remoteItems = records.filter(hasGuiPurpose);
  const shortcutRemoteItems = records.filter(browsableRemote);
  const items = spaces.data ?? [];
  const others = items.filter((item) => item.id !== MAIN_SPACE_ID);
  const localUnavailable = desktop && directoryClient === null;
  const localLoading = localUnavailable || (directoryClient !== null && spaces.isPending);
  const localError = directoryClient !== null && spaces.isError && !isLocalOwnerRequiredError(spaces.error);
  const ready = directoryClient !== null && !spaces.isPending && !spaces.isError;

  const mainItem = items.find((item) => item.id === MAIN_SPACE_ID) ?? ({ id: MAIN_SPACE_ID, name: MAIN_SPACE_ID } as SpaceListItem);
  const ordered: readonly SpaceListItem[] = ready
    ? [mainItem, ...others]
    : (!desktop && !inBrokeredScope && !localLoading && !localError ? [mainItem] : []);

  const entries = [
    ...(desktop ? ordered.map((space) => ({ kind: 'local' as const, space })) : []),
    ...shortcutRemoteItems.map((record) => ({ kind: 'remote' as const, record })),
  ];
  const multi = entries.length > 1;
  const hasMultipleSpaces = ordered.length > 1 || remoteItems.length > 0;
  const pending = mode === 'switch' ? otherSpacesPending(statuses.data) : 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);

  // If the user focused a remote space that was subsequently removed, return to All spaces.
  useEffect(() => {
    if (focusedKey === undefined || !focusedKey.startsWith('remote:')) return;
    if (!hasRemoteConnectionsApi || remoteConnections.isPending || remoteConnections.data === undefined) return;
    const targetId = focusedKey.slice('remote:'.length);
    if (connectionId === targetId) return;
    if (!remoteItems.some((r) => r.id === targetId)) {
      writeLayoutPreferences({ spaceScope: ALL_SPACE_SCOPE });
    }
  }, [focusedKey, hasRemoteConnectionsApi, remoteConnections.isPending, remoteConnections.data, remoteItems, connectionId]);

  const directoryRef = useRef(directoryClient);
  directoryRef.current = directoryClient;
  const enteringRef = useRef(false);
  const activeLocalHomeId = inBrokeredScope ? (localSpaceKey ?? MAIN_SPACE_ID) : currentSpaceId();
  const activeLocalScopeId = localScopeId ?? 'local';
  const localView = () => readHomeViewRoute(activeLocalHomeId, activeLocalScopeId) ?? '/new';

  const closePanel = () => {
    setOpen(false);
    setFailure(null);
  };

  const resetToAllSpaces = () => {
    writeLayoutPreferences({ spaceScope: ALL_SPACE_SCOPE });
    closePanel();
  };

  const runAction = (action: (signal?: AbortSignal) => void | Promise<void>, target?: string) => {
    const result = guard?.runAction !== undefined ? guard.runAction(action, target)
      : Promise.resolve(action()).then(() => { if (target !== undefined) void navigate(target); });
    void result?.catch((error: unknown) => {
      if (isAbortError(error)) return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };

  const backToLocal = () => {
    closePanel();
    if (typeof connectionId === 'string' && connectionId !== '') { returnToLocal(); return; }
    if (mode === 'switch') activateLocal();
    else runAction(restoreLocal, localView());
  };

  const openSettings = (target: string) => {
    closePanel();
    if (!inBrokeredScope) { void navigate(target); return; }
    const result = guard?.runAction !== undefined
      ? guard.runAction(restoreLocal, target)
      : restoreLocal().then(() => { void navigate(target); });
    void result?.catch((error: unknown) => {
      if (isAbortError(error)) return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };

  const enterLocalFromPanel = (space: SpaceListItem, fromShortcut = false, explicitRoute?: string) => {
    const nextScope = spaceKeyToScope(space.id);
    if (!inBrokeredScope && space.id === currentSpaceId()) {
      if (hasMultipleSpaces || explicitRoute === undefined) {
        writeLayoutPreferences({ spaceScope: nextScope });
      }
      if (explicitRoute !== undefined) void navigate(explicitRoute);
      if (!fromShortcut) closePanel();
      return;
    }
    if (!desktop) {
      if (inBrokeredScope && space.id === activeLocalHomeId) {
        writeLayoutPreferences({ spaceScope: nextScope });
        const rowKey = `local:${space.id}`;
        setFailure(null);
        setOpeningKey(rowKey);
        void requestScopeNavigation({
          homeId: activeLocalHomeId,
          scopeId: activeLocalScopeId,
          route: explicitRoute ?? localView(),
          inPlace: true,
        })
          .then(() => { if (!fromShortcut) closePanel(); })
          .catch((error: unknown) => {
            if (isAbortError(error)) {
              if (!fromShortcut) closePanel();
              return;
            }
            setFailure({ rowKey, kind: 'local-start', spaceName: label(space), spaceId: space.id });
          })
          .finally(() => { setOpeningKey(null); });
      }
      return;
    }
    if (!ready || enteringRef.current) return;
    const rowKey = `local:${space.id}`;
    setFailure(null);
    const target = explicitRoute ?? (mode === 'windows' && inBrokeredScope ? localView() : undefined);
    const openTarget = async (signal = new AbortController().signal) => {
      if (directoryRef.current !== directoryClient || enteringRef.current) throw new DOMException('Space entry was superseded.', 'AbortError');
      enteringRef.current = true;
      setEntering(space.id);
      if (!fromShortcut) setOpeningKey(rowKey);
      let prepared: PreparedScope | undefined;
      try {
        if (target !== undefined) {
          prepared = await scopeAdapter.prepare({ homeId: activeLocalHomeId, scopeId: activeLocalScopeId }, signal);
          await prepared.validate(target, signal);
        }
        signal.throwIfAborted();
        if (directoryRef.current !== directoryClient) throw new DOMException('The local space connection changed.', 'AbortError');
        if (mode !== 'windows' || space.id !== activeLocalHomeId) {
          await enterSpace(host, space.id, mode, { inPlace: !fromShortcut });
        }
        signal.throwIfAborted();
        await prepared?.commit();
        writeLayoutPreferences({ spaceScope: nextScope });
      } catch (error) {
        await prepared?.dispose();
        throw error;
      } finally {
        enteringRef.current = false;
        setEntering(null);
        setOpeningKey(null);
      }
    };
    let actionStarted = false;
    let guardCancelled = false;
    let result: Promise<unknown> | void;
    if (mode === 'switch' && explicitRoute === undefined) {
      actionStarted = true;
      result = openTarget();
    } else if (guard?.runAction !== undefined) {
      result = guard.runAction((signal) => { actionStarted = true; return openTarget(signal); }, target, () => { guardCancelled = true; });
    } else {
      actionStarted = true;
      result = openTarget().then(() => { if (target !== undefined) void navigate(target); });
    }

    if (!fromShortcut && !actionStarted) {
      closePanel();
    }

    void result
      ?.then(() => {
        if (!fromShortcut && !guardCancelled) closePanel();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          if (!fromShortcut) closePanel();
          return;
        }
        if (fromShortcut) {
          pushToast({ tone: 'error', text: t('st.spaces.switchFailed', { name: label(space) }) });
          return;
        }
        setFailure({
          rowKey,
          kind: 'local-start',
          spaceName: label(space),
          spaceId: space.id,
        });
      });
  };

  const enterRemoteFromPanel = (record: RemoteConnection, fromShortcut = false, explicitRoute?: string) => {
    const nextScope = `remote:${record.id}`;
    if (record.id === connectionId) {
      writeLayoutPreferences({ spaceScope: nextScope });
      if (explicitRoute !== undefined) void navigate(explicitRoute);
      if (!fromShortcut) closePanel();
      return;
    }
    if (fromShortcut && explicitRoute === undefined) {
      void enterRemoteSpace(record.id, record.label, { inPlace: true })
        .then(() => {
          writeLayoutPreferences({ spaceScope: nextScope });
        })
        .catch(() => undefined);
      return;
    }
    const rowKey = nextScope;
    setFailure(null);
    setOpeningKey(rowKey);
    const enterPromise = explicitRoute !== undefined
      ? requestScopeNavigation({ ...remoteSpaceScope(record.id), route: explicitRoute, inPlace: true })
      : enterRemoteSpace(record.id, record.label, { inPlace: true });
    void enterPromise
      .then(() => {
        if (explicitRoute === undefined) {
          writeLayoutPreferences({ spaceScope: nextScope });
        }
        closePanel();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          closePanel();
          return;
        }
        setFailure({
          rowKey,
          kind: classifyRemoteSwitchError(error),
          spaceName: record.label,
          recordId: record.id,
        });
      })
      .finally(() => {
        setOpeningKey(null);
      });
  };

  const handleTurnOnRemote = (recordId: string, record: RemoteConnection) => {
    if (remoteClient === null || actionBusy) return;
    setActionBusy(true);
    void connectionsApi(remoteClient)
      .setEnabled(recordId, true)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
        setActionBusy(false);
        enterRemoteFromPanel(record, false);
      })
      .catch((error: unknown) => {
        setActionBusy(false);
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      });
  };

  const handleRemoveRemote = (recordId: string) => {
    if (remoteClient === null || actionBusy) return;
    setActionBusy(true);
    void connectionsApi(remoteClient)
      .remove(recordId)
      .then(async () => {
        setFailure(null);
        await queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
      })
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setActionBusy(false);
      });
  };

  const enterLocalRef = useRef(enterLocalFromPanel);
  enterLocalRef.current = enterLocalFromPanel;
  const enterRemoteRef = useRef(enterRemoteFromPanel);
  enterRemoteRef.current = enterRemoteFromPanel;

  // Window-level shortcuts: Ctrl+Alt+0 → All spaces, Ctrl+Alt+1…9 → Nth space.
  useEffect(() => {
    if (!multi && spaceScope === ALL_SPACE_SCOPE) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
      if (event.code === 'Digit0') {
        event.preventDefault();
        writeLayoutPreferences({ spaceScope: ALL_SPACE_SCOPE });
        return;
      }
      if (!multi) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit === undefined) return;
      const target = entries[Number(digit) - 1];
      if (target === undefined) return;
      event.preventDefault();
      if (target.kind === 'local') enterLocalRef.current(target.space, true);
      else enterRemoteRef.current(target.record, true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [multi, entries, spaceScope]);

  const title = pending > 0 ? `${t('sidebar.space.switcherAria')} · ${tp('sidebar.space.otherPending', pending)}` : t('sidebar.space.switcherAria');
  const enteringName = entering === null ? null : label(items.find((item) => item.id === entering) ?? { id: entering, name: entering } as SpaceListItem);
  const location = useSpaceLocation({ openingSpaceName: enteringName, includeLocalMachine: open && !desktop });
  const isDefaultMain = !location.inRemoteScope && currentSpaceId() === MAIN_SPACE_ID && entering === null;
  const barSpaceName = location.spaceName;
  const barSubtitle = isDefaultMain
    ? (location.state === 'connected' ? '' : location.subtitle)
    : location.subtitle;
  const switchComputerUrl = isEmbeddedAndroidHost() ? null : appShellConnectUrl();

  // Resolve focused single-space pill metadata when user explicitly focused one space.
  const focusedRemote = focusedKey !== undefined && focusedKey.startsWith('remote:')
    ? remoteItems.find((item) => item.id === focusedKey.slice('remote:'.length))
    : undefined;
  const focusedLocal = focusedKey !== undefined && !focusedKey.startsWith('remote:')
    ? ordered.find((item) => item.id === focusedKey)
    : undefined;
  const showFocusedPill = !inSshScope && focusedKey !== undefined && hasMultipleSpaces;
  const focusedPillName = focusedRemote !== undefined
    ? focusedRemote.label
    : focusedLocal !== undefined
      ? label(focusedLocal)
      : (focusedKey === MAIN_SPACE_ID ? t('st.spaces.main') : barSpaceName);
  const focusedPillColor = focusedLocal !== undefined
    ? (focusedLocal.id === MAIN_SPACE_ID ? 'var(--color-ink-faint)' : focusedLocal.color)
    : focusedRemote !== undefined
      ? (focusedRemote.state === 'online' ? 'var(--color-success)' : 'var(--color-ink-faint)')
      : (location.spaceColor ?? 'var(--color-ink-faint)');

  // Show the compact `全部空间` scope capsule when multiple spaces exist and
  // the user is in `all` scope (not SSH, not an isolated non-main local home
  // with single-space identity expectation).
  const showAllSpacesCapsule =
    !inSshScope &&
    spaceScope === ALL_SPACE_SCOPE &&
    hasMultipleSpaces &&
    (isDefaultMain || (typeof connectionId === 'string' && connectionId !== '' && remoteItems.length > 0)) &&
    barSubtitle === '';

  // Quiet stale / offline indicator for `全部空间` capsule: dot only, details strictly in title/aria-label.
  const degradedRemoteTitle = (() => {
    if (!showAllSpacesCapsule) return undefined;
    if (healthBySpace !== undefined) {
      for (const health of healthBySpace.values()) {
        if (!health.isRemote) continue;
        if (health.state === 'offline') {
          return t('sidebar.space.remoteOfflineTitle', { name: health.spaceName });
        }
        if (health.state === 'stale' && health.lastSyncedAt !== undefined) {
          return `${health.spaceName} · ${t('sidebar.space.remoteStaleTitle', { time: relativeTime(new Date(health.lastSyncedAt).toISOString(), locale) })}`;
        }
      }
    }
    const offlineRecord = remoteItems.find((r) => r.enabled && r.state !== 'online');
    if (offlineRecord !== undefined) {
      return t('sidebar.space.remoteOfflineTitle', { name: offlineRecord.label });
    }
    return undefined;
  })();

  const handleToggleOpen = () => {
    setOpen((wasOpen) => {
      if (wasOpen) {
        setFailure(null);
        return false;
      }
      // 0-second discovery: trigger immediate background refresh when opened.
      if (hasRemoteConnectionsApi) void remoteConnections.refetch();
      if (directoryClient !== null) void spaces.refetch();
      return true;
    });
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-0.5">
        <button
          ref={triggerRef}
          type="button"
          data-space-switcher={location.inRemoteScope ? undefined : currentSpaceId()}
          data-space-remote={location.inRemoteScope ? '' : undefined}
          data-space-scope={spaceScope}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={
            showFocusedPill
              ? `kiki · ${focusedPillName} · ${title}`
              : showAllSpacesCapsule
                ? `kiki · ${t('sidebar.space.allSpaces')} · ${title}`
                : `kiki · ${barSpaceName}${barSubtitle !== '' ? ` · ${barSubtitle}` : ''} · ${title}`
          }
          title={degradedRemoteTitle ?? title}
          onClick={handleToggleOpen}
          className={`group -ml-2 flex h-11 min-w-0 flex-col justify-center rounded-md px-2 text-left text-ink transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink ${
            showFocusedPill || showAllSpacesCapsule
              ? 'max-w-full flex-1'
              : isDefaultMain && barSubtitle === ''
                ? 'w-fit max-w-[calc(100%+0.5rem)]'
                : 'w-[calc(100%+0.5rem)]'
          }`}
        >
          <span className={`flex min-w-0 items-center gap-1.5 leading-tight ${isDefaultMain && barSubtitle === '' && !showAllSpacesCapsule && !showFocusedPill ? '' : 'w-full'}`}>
            <span aria-hidden className="shrink-0"><Wordmark /></span>
            {showFocusedPill ? (
              <span
                data-space-scope-pill={spaceScope}
                className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-ink/[0.055] py-0.5 pr-1.5 pl-2 text-[12px] font-medium leading-[16px] text-ink"
              >
                <SpaceDot color={focusedPillColor} />
                <span data-space-switcher-name title={focusedPillName} className="min-w-0 flex-1 truncate">
                  {focusedPillName}
                </span>
              </span>
            ) : showAllSpacesCapsule ? (
              <span
                data-space-scope-pill="all"
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ink/[0.045] px-2 py-0.5 text-[11.5px] font-medium leading-[16px] text-ink-soft transition-colors group-hover:text-ink"
              >
                <span className="truncate">{t('sidebar.space.allSpaces')}</span>
                {degradedRemoteTitle !== undefined ? (
                  <span
                    data-space-scope-degraded
                    title={degradedRemoteTitle}
                    aria-label={degradedRemoteTitle}
                    className="h-1.5 w-1.5 shrink-0 rounded-full border border-ink-faint/80"
                  />
                ) : null}
                {pending > 0 ? (
                  <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1 text-[10px] font-semibold tabular-nums leading-[14px] text-on-accent">{pending}</span>
                ) : null}
                <Icon
                  name="chevron"
                  size={12}
                  className="shrink-0 rotate-90 text-ink-faint transition-transform group-aria-expanded:-rotate-90"
                />
              </span>
            ) : !isDefaultMain ? (
              <>
                <SpaceDot color={location.spaceColor ?? (location.inRemoteScope || here === null ? 'var(--color-ink-faint)' : undefined)} className="ml-0.5" />
                <span data-space-switcher-name title={barSpaceName} className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px]">{barSpaceName}</span>
              </>
            ) : pending > 0 && barSubtitle === '' ? (
              <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px] text-on-accent">{pending}</span>
            ) : null}
            {!showAllSpacesCapsule ? (
              <Icon
                name="chevron"
                size={12}
                className={`shrink-0 rotate-90 text-ink-faint transition-all group-hover:text-ink-soft group-aria-expanded:-rotate-90 ${
                  isDefaultMain && !showFocusedPill ? 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100' : ''
                }`}
              />
            ) : null}
          </span>
          {!showFocusedPill && !showAllSpacesCapsule && (barSubtitle !== '' || (!isDefaultMain && pending > 0)) ? (
            <span className={`flex w-full min-w-0 items-center gap-1.5 leading-tight ${isDefaultMain ? '' : 'pl-[42px]'}`}>
              <span data-space-switcher-subtitle title={barSubtitle || undefined} className="min-w-0 flex-1 truncate text-[11px] leading-[15px] text-ink-faint">
                {barSubtitle}
              </span>
              {pending > 0 ? (
                <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px] text-on-accent">{pending}</span>
              ) : null}
            </span>
          ) : null}
        </button>
        {showFocusedPill ? (
          <button
            type="button"
            data-space-scope-clear
            aria-label={t('sidebar.space.clearFocus')}
            title={t('sidebar.space.clearFocus')}
            onClick={resetToAllSpaces}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
      {open ? (
        <SpaceSwitchSheet
          anchorRef={triggerRef}
          onClose={closePanel}
          desktop={desktop}
          mode={mode}
          inRemoteScope={inBrokeredScope && location.inRemoteScope}
          localSpaceName={location.localSpaceName}
          localComputerName={location.localComputerName}
          localItems={ordered}
          localLoading={localLoading}
          localError={localError}
          onRetryLocal={() => { void spaces.refetch(); }}
          statuses={statuses.data}
          remoteItems={remoteItems}
          remoteLoading={hasRemoteConnectionsApi && remoteClient !== null && remoteConnections.isPending}
          remoteError={hasRemoteConnectionsApi && remoteClient !== null && remoteConnections.isError && !isLocalOwnerRequiredError(remoteConnections.error)}
          onRetryRemote={() => { void remoteConnections.refetch(); }}
          currentConnectionId={typeof connectionId === 'string' ? connectionId : null}
          spaceScope={spaceScope}
          onSelectAllSpaces={resetToAllSpaces}
          onNewSessionInLocal={(space) => { enterLocalFromPanel(space, false, '/new'); }}
          onNewSessionInRemote={(record) => { enterRemoteFromPanel(record, false, '/new'); }}
          multi={multi}
          openingKey={openingKey}
          failure={failure}
          actionBusy={actionBusy}
          switchComputerUrl={switchComputerUrl}
          onBackToLocal={inBrokeredScope ? backToLocal : undefined}
          onSelectLocal={(space) => { enterLocalFromPanel(space, false); }}
          onSelectRemote={(record) => { enterRemoteFromPanel(record, false); }}
          onTurnOnRemote={handleTurnOnRemote}
          onRemoveRemote={handleRemoveRemote}
          onPairAgain={() => {
            if (remoteClient !== null && hasRemoteConnectionsApi) {
              closePanel();
              setPairSheetOpen(true);
            } else {
              openSettings('/settings/spaces#st-card-remote-connections');
            }
          }}
          onViewLog={desktop && host.openDesktopLogDirectory !== undefined ? () => { void host.openDesktopLogDirectory?.(); } : undefined}
          onPairRemote={() => {
            if (remoteClient !== null && hasRemoteConnectionsApi) {
              closePanel();
              setPairSheetOpen(true);
            } else {
              openSettings('/settings/spaces#st-card-remote-connections');
            }
          }}
          onNewSpace={desktop && here === null ? () => { openSettings('/settings/spaces?new=1'); } : undefined}
          onManageSpaces={() => { openSettings('/settings/spaces'); }}
        />
      ) : null}
      {pairSheetOpen && remoteClient !== null ? (
        <PairSheet
          client={remoteClient}
          direction="outbound"
          allowInboundTab
          onClose={() => { setPairSheetOpen(false); }}
          onInvited={() => {
            void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
            void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
          }}
          onPaired={(record) => {
            setPairSheetOpen(false);
            void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
            void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
            void remoteConnections.refetch();
            pushToast({
              tone: 'success',
              text: record.fingerprintToVerify === undefined
                ? t('st.remote.added', { name: record.label })
                : t('st.remote.addedWithFingerprint', { name: record.label, fingerprint: fingerprint(record.fingerprintToVerify, 16, 8) }),
              durationMs: UNDO_TOAST_MS,
              action: browsableRemote(record)
                ? { label: t('st.remote.enter'), run: () => { void enterRemoteSpace(record.id, record.label, { inPlace: true }); } }
                : undefined,
            });
          }}
        />
      ) : null}
    </>
  );
}

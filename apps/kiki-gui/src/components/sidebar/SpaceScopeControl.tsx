/**
 * SpaceScopeControl — Zone 1 top-left control aligned on the `18px` keyline.
 *
 * Two-Tier model:
 *   - Window identity = local Kiki home (`主空间` or non-main local space such
 *     as `妮娅·私语酒馆`). Switching local spaces opens/focuses its window or
 *     switches local home in-place.
 *   - Computer filter (`所有电脑` | `这台电脑` | paired remote computer): pure
 *     0ms `layoutPrefs.spaceScope` view filter. Never hijacks the root window
 *     connection or mutates local storage.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { RemoteConnection } from '@kiki/protocol';
import { readDesktopPrefs, writeLayoutPreferences } from '@kiki/session-core/settings';
import { relativeTime } from '@kiki/session-core/util/time';

import { useHost } from '../../host';
import { isDesktopHost } from '../../host/host';
import { useI18n } from '../../i18n';
import { appShellConnectUrl, isEmbeddedAndroidHost } from '../../lib/appShell';
import { useLayoutPreferences } from '../../lib/layoutHooks';
import { type PreparedScope } from '../../lib/navScope';
import { isLocalOwnerRequiredError } from '../../lib/peerAccess';
import {
  connectionsApi,
  fingerprint,
  hasGuiPurpose,
  remoteConnectionKeys,
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
import { SpaceDot } from '../settings/spaces/SpaceDot';
import { SpaceSwitchSheet, type SpaceRowFailure } from '../SpaceSwitchSheet';
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
  const inBrokeredScope =
    (typeof connectionId === 'string' && connectionId !== '') ||
    inSshScope ||
    connectionSource === 'remote';
  const desktop = isDesktopHost(host);

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

  useSpacePreferencesFrame(spaceSettingsTargetOf(client, meta));
  const statuses = useSpaceStatuses(host);
  const mode = launchWindowMode(readDesktopPrefs().windowMode);
  const here = currentSpace();
  const localServerHomeId = !inBrokeredScope ? meta?.server_home_id : undefined;
  const records = remoteConnections.data ?? [];
  // Self-loop guard: never display a pairing that loops back to this local server.
  const remoteItems = records.filter(
    (record) => hasGuiPurpose(record) && (localServerHomeId === undefined || record.target.homeId !== localServerHomeId),
  );
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

  const hasRemoteComputers = remoteItems.length > 0;
  const pending = mode === 'switch' ? otherSpacesPending(statuses.data) : 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);

  // If the user focused a remote computer that was subsequently removed, return to All computers.
  useEffect(() => {
    if (focusedKey === undefined || !focusedKey.startsWith('remote:')) return;
    if (!hasRemoteConnectionsApi || remoteConnections.isPending || remoteConnections.data === undefined) return;
    const targetId = focusedKey.slice('remote:'.length);
    if (!remoteItems.some((r) => r.id === targetId)) {
      writeLayoutPreferences({ spaceScope: ALL_SPACE_SCOPE });
    }
  }, [focusedKey, hasRemoteConnectionsApi, remoteConnections.isPending, remoteConnections.data, remoteItems]);

  const directoryRef = useRef(directoryClient);
  directoryRef.current = directoryClient;
  const enteringRef = useRef(false);
  const activeLocalHomeId = inBrokeredScope
    ? (localSpaceKey ?? MAIN_SPACE_ID)
    : (here !== null && !here.homeId.startsWith('remote:') ? here.homeId : currentSpaceId());
  const activeLocalScopeId = localScopeId ?? 'local';
  const localView = () => readHomeViewRoute(activeLocalHomeId, activeLocalScopeId) ?? '/new';

  const closePanel = () => {
    setOpen(false);
    setFailure(null);
  };

  const selectAllComputers = () => {
    writeLayoutPreferences({ spaceScope: ALL_SPACE_SCOPE });
    closePanel();
  };

  const selectThisComputer = () => {
    writeLayoutPreferences({ spaceScope: spaceKeyToScope(activeLocalHomeId) });
    closePanel();
  };

  const selectRemoteComputer = (record: RemoteConnection) => {
    const rowKey = `remote:${record.id}`;
    if (!record.enabled || record.state === 'disabled') {
      setFailure({ rowKey, kind: 'remote-paused', spaceName: record.label, recordId: record.id });
      return;
    }
    if (record.state === 'identity_changed') {
      setFailure({ rowKey, kind: 'remote-identity-changed', spaceName: record.label, recordId: record.id });
      return;
    }
    if (record.state === 'authentication_required') {
      setFailure({ rowKey, kind: 'remote-not-approved', spaceName: record.label, recordId: record.id });
      return;
    }
    writeLayoutPreferences({ spaceScope: rowKey });
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
    if (mode === 'switch') activateLocal();
    else runAction(restoreLocal, localView());
  };

  const openSettings = (target: string) => {
    closePanel();
    if (!inSshScope) { void navigate(target); return; }
    const result = guard?.runAction !== undefined
      ? guard.runAction(restoreLocal, target)
      : restoreLocal().then(() => { void navigate(target); });
    void result?.catch((error: unknown) => {
      if (isAbortError(error)) return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };

  const selectLocalSpace = (space: SpaceListItem) => {
    if (!inSshScope && space.id === activeLocalHomeId) {
      closePanel();
      return;
    }
    if (!desktop) return;
    if (!ready || enteringRef.current) return;
    const rowKey = `local:${space.id}`;
    setFailure(null);
    const target = mode === 'windows' && inSshScope ? localView() : undefined;
    const openTarget = async (signal = new AbortController().signal) => {
      if (directoryRef.current !== directoryClient || enteringRef.current) {
        throw new DOMException('Space entry was superseded.', 'AbortError');
      }
      enteringRef.current = true;
      setEntering(space.id);
      setOpeningKey(rowKey);
      let prepared: PreparedScope | undefined;
      try {
        if (target !== undefined) {
          prepared = await scopeAdapter.prepare({ homeId: activeLocalHomeId, scopeId: activeLocalScopeId }, signal);
          await prepared.validate(target, signal);
        }
        signal.throwIfAborted();
        if (directoryRef.current !== directoryClient) {
          throw new DOMException('The local space connection changed.', 'AbortError');
        }
        if (mode !== 'windows' || space.id !== activeLocalHomeId) {
          await enterSpace(host, space.id, mode, { inPlace: true });
        }
        signal.throwIfAborted();
        await prepared?.commit();
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
    if (mode === 'switch') {
      actionStarted = true;
      result = openTarget();
    } else if (guard?.runAction !== undefined) {
      result = guard.runAction((signal) => { actionStarted = true; return openTarget(signal); }, target, () => { guardCancelled = true; });
    } else {
      actionStarted = true;
      result = openTarget().then(() => { if (target !== undefined) void navigate(target); });
    }

    if (!actionStarted) {
      closePanel();
    }

    void result
      ?.then(() => {
        if (!guardCancelled) closePanel();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          closePanel();
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

  const handleTurnOnRemote = (recordId: string, record: RemoteConnection) => {
    if (remoteClient === null || actionBusy) return;
    setActionBusy(true);
    void connectionsApi(remoteClient)
      .setEnabled(recordId, true)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
        setActionBusy(false);
        writeLayoutPreferences({ spaceScope: `remote:${record.id}` });
        closePanel();
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

  const title = pending > 0 ? `${t('sidebar.space.switcherAria')} · ${tp('sidebar.space.otherPending', pending)}` : t('sidebar.space.switcherAria');
  const enteringName = entering === null ? null : label(items.find((item) => item.id === entering) ?? { id: entering, name: entering } as SpaceListItem);
  const location = useSpaceLocation({ openingSpaceName: enteringName, includeLocalMachine: open && !desktop });
  const isDefaultMain = !inSshScope && activeLocalHomeId === MAIN_SPACE_ID && entering === null;
  const barSpaceName = inSshScope ? location.spaceName : location.localSpaceName;
  const barSubtitle = isDefaultMain
    ? (location.state === 'connected' ? '' : location.subtitle)
    : location.subtitle;
  const switchComputerUrl = isEmbeddedAndroidHost() ? null : appShellConnectUrl();

  // Resolve focused computer capsule when paired remote computers exist (or a filter is active).
  const focusedRemote = focusedKey !== undefined && focusedKey.startsWith('remote:')
    ? remoteItems.find((item) => item.id === focusedKey.slice('remote:'.length))
    : undefined;
  const isFocusedThisComputer = focusedKey !== undefined && !focusedKey.startsWith('remote:');
  const showFocusedPill = !inSshScope && (focusedRemote !== undefined || (isFocusedThisComputer && hasRemoteComputers));
  const focusedPillName = focusedRemote !== undefined
    ? focusedRemote.label
    : t('sidebar.space.thisComputer');
  const focusedPillOnline = focusedRemote !== undefined
    ? focusedRemote.state === 'online'
    : true;

  // Never hide `所有电脑 ▾` when `barSubtitle !== ''` so the top bar never jitters.
  const showAllComputersCapsule =
    !inSshScope &&
    spaceScope === ALL_SPACE_SCOPE &&
    hasRemoteComputers;

  // Quiet stale / offline indicator for `所有电脑` capsule: dot only, details strictly in title/aria-label.
  const degradedRemoteTitle = (() => {
    if (!showAllComputersCapsule) return undefined;
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
          data-space-switcher={inSshScope ? undefined : activeLocalHomeId}
          data-space-remote={inSshScope ? '' : undefined}
          data-space-scope={spaceScope}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={
            showFocusedPill
              ? `kiki · ${focusedPillName} · ${title}`
              : showAllComputersCapsule
                ? `kiki · ${t('sidebar.space.allSpaces')} · ${title}`
                : `kiki · ${barSpaceName}${barSubtitle !== '' ? ` · ${barSubtitle}` : ''} · ${title}`
          }
          title={degradedRemoteTitle ?? title}
          onClick={handleToggleOpen}
          className={`group -ml-2 flex h-11 min-w-0 flex-col justify-center rounded-md text-left text-ink transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink ${
            showFocusedPill || showAllComputersCapsule
              ? 'w-[calc(100%+0.5rem)] max-w-[calc(100%+0.5rem)] pl-2 pr-0.5'
              : isDefaultMain && barSubtitle === ''
                ? 'w-fit max-w-[calc(100%+0.5rem)] px-2'
                : 'w-[calc(100%+0.5rem)] px-2'
          }`}
        >
          <span className={`flex min-w-0 items-center gap-1 leading-tight ${isDefaultMain && barSubtitle === '' && !showAllComputersCapsule && !showFocusedPill ? '' : 'w-full'}`}>
            <span aria-hidden className="shrink-0"><Wordmark /></span>
            {!isDefaultMain && !inSshScope && (showFocusedPill || showAllComputersCapsule) ? (
              <span
                data-space-identity
                title={barSpaceName}
                className="inline-flex max-w-[6.5rem] shrink-0 items-center gap-1 truncate text-[12px] font-medium text-ink-soft"
              >
                <SpaceDot color={location.spaceColor} />
                <span className="truncate">{barSpaceName}</span>
              </span>
            ) : null}
            {showFocusedPill ? (
              <span
                data-space-scope-pill={spaceScope}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-ink/[0.055] py-0.5 pr-1 pl-1.5 text-[11.5px] font-medium leading-[16px] text-ink"
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${focusedPillOnline ? 'bg-success' : 'border border-ink-faint/75'}`}
                />
                <span data-space-switcher-name title={focusedPillName} className="min-w-0 truncate">
                  {focusedPillName}
                </span>
                <Icon
                  name="chevron"
                  size={12}
                  className="shrink-0 rotate-90 text-ink-faint transition-transform group-aria-expanded:-rotate-90"
                />
              </span>
            ) : showAllComputersCapsule ? (
              <span
                data-space-scope-pill="all"
                className="inline-flex min-w-0 items-center gap-1 rounded-full bg-ink/[0.045] py-0.5 pr-1 pl-1.5 text-[11.5px] font-medium leading-[16px] text-ink-soft transition-colors group-hover:text-ink"
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
                <SpaceDot color={location.spaceColor ?? (inSshScope || here === null ? 'var(--color-ink-faint)' : undefined)} className="ml-0.5" />
                <span data-space-switcher-name title={barSpaceName} className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px]">{barSpaceName}</span>
                <Icon
                  name="chevron"
                  size={12}
                  className="shrink-0 rotate-90 text-ink-faint transition-all group-hover:text-ink-soft group-aria-expanded:-rotate-90"
                />
              </>
            ) : (
              <>
                {pending > 0 && barSubtitle === '' ? (
                  <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px] text-on-accent">{pending}</span>
                ) : null}
                <Icon
                  name="chevron"
                  size={12}
                  className="shrink-0 rotate-90 text-ink-faint opacity-0 transition-all group-hover:text-ink-soft group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:-rotate-90 group-aria-expanded:opacity-100"
                />
              </>
            )}
          </span>
          {!showFocusedPill && !showAllComputersCapsule && (barSubtitle !== '' || (!isDefaultMain && pending > 0)) ? (
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
      </div>
      {open ? (
        <SpaceSwitchSheet
          anchorRef={triggerRef}
          onClose={closePanel}
          desktop={desktop}
          mode={mode}
          inSshScope={inSshScope}
          activeLocalHomeId={activeLocalHomeId}
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
          spaceScope={spaceScope}
          onSelectAllComputers={selectAllComputers}
          onSelectThisComputer={selectThisComputer}
          openingKey={openingKey}
          failure={failure}
          actionBusy={actionBusy}
          switchComputerUrl={switchComputerUrl}
          onBackToLocal={inSshScope ? backToLocal : undefined}
          onSelectLocalSpace={selectLocalSpace}
          onSelectRemoteComputer={selectRemoteComputer}
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
              action: {
                label: t('st.remote.enter'),
                run: () => { writeLayoutPreferences({ spaceScope: `remote:${record.id}` }); },
              },
            });
          }}
        />
      ) : null}
    </>
  );
}

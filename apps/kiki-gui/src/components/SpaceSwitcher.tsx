import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { readDesktopPrefs } from '@kiki/session-core/settings';
import type { RemoteConnection } from '@kiki/protocol';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { appShellConnectUrl } from '../lib/appShell';
import type { PreparedScope } from '../lib/navScope';
import { browsableRemote, connectionsApi, fingerprint, hasGuiPurpose, remoteConnectionKeys, useRemoteConnections } from '../lib/remoteConnections';
import { useSpaceLocation } from '../lib/spaceLocation';
import { useSpacePreferencesFrame } from '../lib/spacePreferences';
import { spaceSettingsTargetOf } from '../lib/spaceSettings';
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
} from '../lib/spaces';
import { readHomeViewRoute } from '../lib/spaceViewState';
import { pushToast, UNDO_TOAST_MS } from '../lib/toasts';
import { threadBridgeKeys } from '../lib/threadBridges';
import { useConnection } from '../state/connection';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { Icon } from './icons';
import { PairSheet } from './settings/remote/PairSheet';
import { useRemoteSpaceEntry, useReturnToLocalSpace } from './settings/remote/useRemoteSpaceEntry';
import { SpaceDot } from './settings/spaces/SpaceDot';
import { SpaceSwitchSheet, classifyRemoteSwitchError, type SpaceRowFailure } from './SpaceSwitchSheet';
import { Wordmark } from './Wordmark';

/**
 * §6.4 / §9.4: the sidebar position bar is the one space entry. It is always a
 * menu button, so a single-home user can discover "New space…" and remote
 * pairings without an extra row; the quiet chevron stays visible because touch
 * has no hover. Ctrl+Alt+1…9 opens the Nth space once there are two.
 */
export function SpaceSwitcher() {
  const { client, localClient, sshLabel, connectionId, activateLocal, restoreLocal, scopeAdapter, meta } = useConnection();
  const host = useHost();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const guard = useDirtyGuard();
  const { t, tp } = useI18n();

  const [open, setOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<SpaceRowFailure | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const inRemoteScope = (typeof connectionId === 'string' && connectionId !== '') || (typeof sshLabel === 'string' && sshLabel.length > 0);
  const desktop = host.kind === 'tauri';
  // Desktop always reads the local space directory for Ctrl+Alt+1…9 and pending
  // counts; a browser/phone client reads it on demand when the switch panel opens
  // (never from an SSH/remote server) so other local spaces on that server can be
  // shown disabled with an explanation.
  const browserDirectoryClient = typeof sshLabel === 'string' && sshLabel.length > 0
    ? null
    : (inRemoteScope ? localClient : (localClient ?? client));
  const directoryClient = desktop ? localClient : (open ? browserDirectoryClient : null);
  const spaces = useSpaces(directoryClient);

  // Remote pairings live in the local control home, never inside a remote space.
  const remoteClient = desktop ? localClient : (localClient ?? (inRemoteScope ? null : client));
  const hasRemoteConnectionsApi = remoteClient?.klient.rest?.connections !== undefined;
  const remoteConnections = useRemoteConnections(hasRemoteConnectionsApi ? remoteClient : null);
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
  const localError = directoryClient !== null && spaces.isError;
  const ready = directoryClient !== null && !spaces.isPending && !spaces.isError;

  const mainItem = items.find((item) => item.id === MAIN_SPACE_ID) ?? ({ id: MAIN_SPACE_ID, name: MAIN_SPACE_ID } as SpaceListItem);
  const ordered: readonly SpaceListItem[] = ready
    ? [mainItem, ...others]
    : (!desktop && !inRemoteScope && !localLoading && !localError ? [mainItem] : []);

  const entries = [
    ...(desktop ? ordered.map((space) => ({ kind: 'local' as const, space })) : []),
    ...shortcutRemoteItems.map((record) => ({ kind: 'remote' as const, record })),
  ];
  const multi = entries.length > 1;
  const pending = mode === 'switch' ? otherSpacesPending(statuses.data) : 0;

  const label = (space: SpaceListItem) => (space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name);

  const directoryRef = useRef(directoryClient);
  directoryRef.current = directoryClient;
  const enteringRef = useRef(false);
  const localView = () => readHomeViewRoute(currentSpaceId(), 'local') ?? '/new';

  const closePanel = () => {
    setOpen(false);
    setFailure(null);
  };

  const runAction = (action: (signal?: AbortSignal) => void | Promise<void>, target?: string) => {
    const result = guard?.runAction !== undefined ? guard.runAction(action, target)
      : Promise.resolve(action()).then(() => { if (target !== undefined) void navigate(target); });
    void result?.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
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
    if (!inRemoteScope) { void navigate(target); return; }
    const result = guard?.runAction !== undefined
      ? guard.runAction(restoreLocal, target)
      : restoreLocal().then(() => { void navigate(target); });
    void result?.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      pushToast({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    });
  };

  const enterLocalFromPanel = (space: SpaceListItem, fromShortcut = false) => {
    if (!ready || enteringRef.current || (!inRemoteScope && space.id === currentSpaceId())) {
      if (!fromShortcut && !inRemoteScope && space.id === currentSpaceId()) closePanel();
      return;
    }
    if (!desktop) return;
    const rowKey = `local:${space.id}`;
    setFailure(null);
    const target = mode === 'windows' && inRemoteScope ? localView() : undefined;
    const openTarget = async (signal = new AbortController().signal) => {
      if (directoryRef.current !== directoryClient || enteringRef.current) throw new DOMException('Space entry was superseded.', 'AbortError');
      enteringRef.current = true;
      setEntering(space.id);
      if (!fromShortcut) setOpeningKey(rowKey);
      let prepared: PreparedScope | undefined;
      try {
        if (target !== undefined) {
          prepared = await scopeAdapter.prepare({ homeId: currentSpaceId(), scopeId: 'local' }, signal);
          await prepared.validate(target, signal);
        }
        signal.throwIfAborted();
        if (directoryRef.current !== directoryClient) throw new DOMException('The local space connection changed.', 'AbortError');
        if (mode !== 'windows' || space.id !== currentSpaceId()) {
          await enterSpace(host, space.id, mode, { inPlace: !fromShortcut });
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
    const result = mode === 'switch'
      ? ((actionStarted = true), openTarget())
      : guard?.runAction !== undefined
        ? guard.runAction((signal) => { actionStarted = true; return openTarget(signal); }, target, () => { guardCancelled = true; })
        : ((actionStarted = true), openTarget().then(() => { if (target !== undefined) void navigate(target); }));

    if (!fromShortcut && !actionStarted) {
      closePanel();
    }

    void result
      ?.then(() => {
        if (!fromShortcut && !guardCancelled) closePanel();
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
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

  const enterRemoteFromPanel = (record: RemoteConnection, fromShortcut = false) => {
    if (record.id === connectionId) {
      if (!fromShortcut) closePanel();
      return;
    }
    if (fromShortcut) {
      void enterRemoteSpace(record.id, record.label);
      return;
    }
    const rowKey = `remote:${record.id}`;
    setFailure(null);
    setOpeningKey(rowKey);
    void enterRemoteSpace(record.id, record.label, { inPlace: true })
      .then(() => {
        closePanel();
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
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
      if (target.kind === 'local') enterLocalRef.current(target.space, true);
      else enterRemoteRef.current(target.record, true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [multi, entries]);

  const title = pending > 0 ? `${t('sidebar.space.switcherAria')} · ${tp('sidebar.space.otherPending', pending)}` : t('sidebar.space.switcherAria');
  const enteringName = entering === null ? null : label(items.find((item) => item.id === entering) ?? { id: entering, name: entering } as SpaceListItem);
  const location = useSpaceLocation({ openingSpaceName: enteringName, includeLocalMachine: open && !desktop });
  const barSpaceName = location.spaceName;
  const barSubtitle = location.subtitle;
  const switchComputerUrl = appShellConnectUrl();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-space-switcher={location.inRemoteScope ? undefined : currentSpaceId()}
        data-space-remote={location.inRemoteScope ? '' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`kiki · ${barSpaceName}${barSubtitle !== '' ? ` · ${barSubtitle}` : ''} · ${title}`}
        title={title}
        onClick={() => {
          setOpen((value) => {
            if (value) setFailure(null);
            return !value;
          });
        }}
        className="group -ml-2 flex h-11 w-[calc(100%+0.5rem)] min-w-0 flex-col justify-center rounded-md px-2 text-left text-ink transition-colors hover:bg-ink/[0.04] aria-expanded:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 leading-tight">
          <span aria-hidden className="shrink-0"><Wordmark /></span>
          <SpaceDot color={location.spaceColor ?? (location.inRemoteScope || here === null ? 'var(--color-ink-faint)' : undefined)} className="ml-0.5" />
          <span data-space-switcher-name title={barSpaceName} className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px]">{barSpaceName}</span>
          <Icon name="chevron" size={12} className="shrink-0 rotate-90 text-ink-faint transition-transform group-hover:text-ink-soft group-aria-expanded:-rotate-90" />
        </span>
        {barSubtitle !== '' || pending > 0 ? (
          <span className="flex w-full min-w-0 items-center gap-1.5 pl-[42px] leading-tight">
            <span data-space-switcher-subtitle title={barSubtitle || undefined} className="min-w-0 flex-1 truncate text-[11px] leading-[15px] text-ink-faint">
              {barSubtitle}
            </span>
            {pending > 0 ? (
              <span data-space-switcher-pending className="shrink-0 rounded-full bg-attention px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px] text-on-accent">{pending}</span>
            ) : null}
          </span>
        ) : null}
      </button>
      {open ? (
        <SpaceSwitchSheet
          anchorRef={triggerRef}
          onClose={closePanel}
          desktop={desktop}
          mode={mode}
          inRemoteScope={location.inRemoteScope}
          localSpaceName={location.localSpaceName}
          localComputerName={location.localComputerName}
          localItems={ordered}
          localLoading={localLoading}
          localError={localError}
          onRetryLocal={() => { void spaces.refetch(); }}
          statuses={statuses.data}
          remoteItems={remoteItems}
          remoteLoading={hasRemoteConnectionsApi && remoteClient !== null && remoteConnections.isPending}
          remoteError={hasRemoteConnectionsApi && remoteClient !== null && remoteConnections.isError}
          onRetryRemote={() => { void remoteConnections.refetch(); }}
          currentConnectionId={typeof connectionId === 'string' ? connectionId : null}
          multi={multi}
          openingKey={openingKey}
          failure={failure}
          actionBusy={actionBusy}
          switchComputerUrl={switchComputerUrl}
          onBackToLocal={backToLocal}
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
          onClose={() => { setPairSheetOpen(false); }}
          onPaired={(record) => {
            setPairSheetOpen(false);
            void queryClient.invalidateQueries({ queryKey: remoteConnectionKeys.all });
            void queryClient.invalidateQueries({ queryKey: threadBridgeKeys.all });
            pushToast({
              tone: 'success',
              text: record.fingerprintToVerify === undefined
                ? t('st.remote.added', { name: record.label })
                : t('st.remote.addedWithFingerprint', { name: record.label, fingerprint: fingerprint(record.fingerprintToVerify, 16, 8) }),
              durationMs: UNDO_TOAST_MS,
              action: browsableRemote(record)
                ? { label: t('st.remote.enter'), run: () => { void enterRemoteSpace(record.id, record.label); } }
                : undefined,
            });
          }}
        />
      ) : null}
    </>
  );
}

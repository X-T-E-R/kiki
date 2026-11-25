import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, IPC_EVENTS } from '#/shared/ipcChannels';
import type {
  DesktopAutostartStatus,
  DesktopLogInfo,
  DesktopNativePrefs,
  DesktopSpaceStatus,
  DesktopUpdateMutation,
  DesktopUpdateOffer,
  DesktopUpdateState,
  DesktopWindowMode,
  DiscoverConnectionEnvelope,
  ElectronBridge,
  HostFileDrop,
  HostNotification,
  HostSubscribeIntent,
  LocalConnection,
  NavScopeIdentity,
  NotificationNavigationIntent,
  PluginFocusIntent,
  ReadFilesResult,
  SelectedFileDescriptor,
  SpaceShortcutResult,
  SshProfile,
  SshResolvedConnection,
  UpdateChannel,
} from '#/shared/types';

function subscribeIpcEvent<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

interface PreloadDropEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly dataTransfer: { readonly files: ArrayLike<File> } | null;
}

interface PreloadWindowLike {
  addEventListener(type: 'drop', listener: (event: PreloadDropEvent) => void, capture?: boolean): void;
}

const fileDropListeners = new Set<(drop: HostFileDrop) => void>();
let fileDropListenerAttached = false;

function ensureDomFileDropListener(): void {
  const hostWindow = (globalThis as { window?: PreloadWindowLike }).window;
  if (fileDropListenerAttached || hostWindow === undefined) return;
  fileDropListenerAttached = true;
  hostWindow.addEventListener(
    'drop',
    (event) => {
      if (fileDropListeners.size === 0) return;
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (const file of Array.from(files)) {
        try {
          const resolved = webUtils.getPathForFile(file);
          if (resolved !== '') paths.push(resolved);
        } catch {
          continue;
        }
      }
      if (paths.length === 0) return;
      const drop: HostFileDrop = {
        paths,
        position: { x: event.clientX, y: event.clientY },
      };
      for (const listener of fileDropListeners) {
        listener(drop);
      }
    },
    true,
  );
}

const bridge: ElectronBridge = {
  discoverConnection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.discoverConnection) as Promise<
      LocalConnection | DiscoverConnectionEnvelope | null
    >,
  cancelStartup: () => ipcRenderer.invoke(IPC_CHANNELS.cancelStartup) as Promise<void>,
  onBackendStage: (cb) => subscribeIpcEvent<unknown>(IPC_EVENTS.backendStage, cb),

  ssh: {
    listProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.sshListProfiles) as Promise<SshProfile[]>,
    saveProfile: (profile) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshSaveProfile, { profile }) as Promise<SshProfile[]>,
    removeProfile: (id) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshRemoveProfile, { id }) as Promise<SshProfile[]>,
    connectProfile: (id, token) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshConnectProfile, { id, token }) as Promise<SshResolvedConnection>,
    prepareProfile: (id, token) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshPrepareProfile, { id, token }) as Promise<SshResolvedConnection>,
    resumeScopeConnection: (homeId, id, tunnelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshResumeScopeConnection, { homeId, id, tunnelId }) as Promise<{
        profile: SshProfile;
        connection: SshResolvedConnection;
      }>,
    commitScopeConnection: (homeId, id, tunnelId, reload) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshCommitScopeConnection, {
        homeId,
        id,
        tunnelId,
        reload,
      }) as Promise<void>,
    takeScopeConnection: () =>
      ipcRenderer.invoke(IPC_CHANNELS.sshTakeScopeConnection) as Promise<{
        profile: SshProfile;
        connection: SshResolvedConnection;
      } | null>,
    tunnelRunning: (id, tunnelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshTunnelRunning, { id, tunnelId }) as Promise<boolean>,
    disconnectProfile: (id, tunnelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.sshDisconnectProfile, { id, tunnelId }) as Promise<void>,
    setWorkspaceScope: (scope) => {
      void ipcRenderer.invoke(IPC_CHANNELS.sshSetWorkspaceScope, { scope });
    },
  },

  window: {
    showMainWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowShowMain) as Promise<void>,
    isVisibleAndFocused: () =>
      ipcRenderer.invoke(IPC_CHANNELS.windowIsVisibleAndFocused) as Promise<boolean>,
    setTheme: (theme) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowSetTheme, { theme }) as Promise<void>,
    setZoom: (factor) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowSetZoom, { factor }) as Promise<boolean>,
    getWindowMode: () =>
      ipcRenderer.invoke(IPC_CHANNELS.windowGetMode) as Promise<DesktopWindowMode | null>,
    openModeWindow: (presetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.windowOpenMode, { presetId }) as Promise<void>,
    onFocus: (cb) =>
      subscribeIpcEvent<void>(IPC_EVENTS.windowFocus, () => {
        cb();
      }),
  },

  pluginFocus: {
    read: () => ipcRenderer.invoke(IPC_CHANNELS.pluginFocusRead) as Promise<PluginFocusIntent | null>,
    ack: (homeId, requestId) =>
      ipcRenderer.invoke(IPC_CHANNELS.pluginFocusAck, { homeId, requestId }) as Promise<void>,
    remember: (homeId, requestId) =>
      ipcRenderer.invoke(IPC_CHANNELS.pluginFocusRemember, { homeId, requestId }) as Promise<void>,
  },

  notifications: {
    send: (options: HostNotification) =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsSend, options) as Promise<void>,
    acknowledge: (sessionId: string, scope: NavScopeIdentity, deliveryId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsAcknowledge, {
        sessionId,
        scope,
        deliveryId,
      }) as Promise<void>,
    onClick: (cb) =>
      subscribeIpcEvent<NotificationNavigationIntent>(IPC_EVENTS.notificationClick, (intent) => {
        cb(intent.route, intent.homeId, intent.scope);
        if (intent.navigationId !== undefined) {
          void ipcRenderer.invoke(IPC_CHANNELS.notificationsAckIntent, {
            navigationId: intent.navigationId,
          });
        }
      }),
    peekNavigationIntent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsPeekIntent) as Promise<
        NotificationNavigationIntent | { readonly connectionId: string } | null
      >,
    takeNavigationIntent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsTakeIntent) as Promise<
        NotificationNavigationIntent | { readonly connectionId: string } | null
      >,
    ackNavigationIntent: (navigationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsAckIntent, { navigationId }) as Promise<boolean>,
    setUnreadBadge: (count, homeId, scopeId, sessionIds) =>
      ipcRenderer.invoke(IPC_CHANNELS.notificationsSetUnreadBadge, {
        count,
        homeId,
        scopeId,
        sessionIds,
      }) as Promise<void>,
  },

  files: {
    openSaveSink: (filename) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesOpenSaveSink, { filename }) as Promise<{
        sinkId: string;
      } | null>,
    writeSaveSink: (sinkId, chunk) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesWriteSaveSink, { sinkId, chunk }) as Promise<void>,
    closeSaveSink: (sinkId) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesCloseSaveSink, { sinkId }) as Promise<boolean>,
    abortSaveSink: (sinkId) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesAbortSaveSink, { sinkId }) as Promise<void>,
    saveBlob: (bytes, filename) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesSaveBlob, { bytes, filename }) as Promise<boolean>,
    pickFilePath: () => ipcRenderer.invoke(IPC_CHANNELS.filesPickFilePath) as Promise<string | null>,
    pickFiles: () =>
      ipcRenderer.invoke(IPC_CHANNELS.filesPickFiles) as Promise<SelectedFileDescriptor[] | null>,
    readSelectedFile: (token) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesReadSelectedFile, { token }) as Promise<Uint8Array>,
    pickDirectory: () =>
      ipcRenderer.invoke(IPC_CHANNELS.filesPickDirectory) as Promise<string | null>,
    pickDirectories: () =>
      ipcRenderer.invoke(IPC_CHANNELS.filesPickDirectories) as Promise<readonly string[] | null>,
    readClipboardFiles: () =>
      ipcRenderer.invoke(IPC_CHANNELS.filesReadClipboardFiles) as Promise<ReadFilesResult | null>,
    readDroppedFiles: (paths) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesReadDroppedFiles, { paths }) as Promise<ReadFilesResult>,
    onFileDrop: (cb) => {
      ensureDomFileDropListener();
      fileDropListeners.add(cb);
      return () => {
        fileDropListeners.delete(cb);
      };
    },
    revealPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.filesRevealPath, { path }) as Promise<void>,
    openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.filesOpenPath, { path }) as Promise<void>,
    openExternalUrl: (url) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesOpenExternalUrl, { url }) as Promise<void>,
    writeFileText: (path, text) =>
      ipcRenderer.invoke(IPC_CHANNELS.filesWriteFileText, { path, text }) as Promise<void>,
  },

  desktop: {
    readPrefs: () =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopReadPrefs) as Promise<DesktopNativePrefs | null>,
    writePrefs: (prefs) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopWritePrefs, { prefs }) as Promise<void>,
    getAutostart: () =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopGetAutostart) as Promise<DesktopAutostartStatus | null>,
    setAutostart: (enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopSetAutostart, {
        enabled,
      }) as Promise<DesktopAutostartStatus>,
    activeSpace: () => ipcRenderer.invoke(IPC_CHANNELS.desktopActiveSpace) as Promise<unknown>,
    spaceStatuses: () =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopSpaceStatuses) as Promise<readonly DesktopSpaceStatus[]>,
    switchSpace: (homeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopSwitchSpace, { homeId }) as Promise<void>,
    prepareSpace: (homeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopPrepareSpace, { homeId }) as Promise<{
        readonly homeId: string;
      }>,
    openSpace: (homeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopOpenSpace, { homeId }) as Promise<void>,
    openRemoteSpace: (connectionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopOpenRemoteSpace, { connectionId }) as Promise<void>,
    createSpaceShortcut: (homeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopCreateSpaceShortcut, {
        homeId,
      }) as Promise<SpaceShortcutResult>,
    restartSpace: (homeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopRestartSpace, { homeId }) as Promise<void>,
    restartServer: () => ipcRenderer.invoke(IPC_CHANNELS.desktopRestartServer) as Promise<void>,
    logInfo: () => ipcRenderer.invoke(IPC_CHANNELS.desktopLogInfo) as Promise<DesktopLogInfo>,
    openLogDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.desktopOpenLogDirectory) as Promise<void>,
    supportsUpdates: () =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopSupportsUpdates) as Promise<boolean>,
    checkUpdate: (channel?: UpdateChannel) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopCheckUpdate, {
        channel,
      }) as Promise<DesktopUpdateOffer | null>,
    installUpdate: (expectedChannel?: UpdateChannel, expectedVersion?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopInstallUpdate, {
        expectedChannel,
        expectedVersion,
      }) as Promise<void>,
    mutateUpdateState: (mutation: DesktopUpdateMutation) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopMutateUpdateState, {
        mutation,
      }) as Promise<DesktopUpdateState>,
    onTrayNewSession: (cb) =>
      subscribeIpcEvent<void>(IPC_EVENTS.trayNewSession, () => {
        cb();
      }),
    peekSubscribeIntent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopPeekSubscribeIntent) as Promise<HostSubscribeIntent | null>,
    ackSubscribeIntent: (id) =>
      ipcRenderer.invoke(IPC_CHANNELS.desktopAckSubscribeIntent, { id }) as Promise<boolean>,
    onSubscribeIntent: (cb) =>
      subscribeIpcEvent<HostSubscribeIntent>(IPC_EVENTS.subscribeIntent, cb),
    onSubscribeUrl: (cb) => subscribeIpcEvent<string>(IPC_EVENTS.subscribeUrl, cb),
  },
};

contextBridge.exposeInMainWorld('__KIKI_ELECTRON__', bridge);

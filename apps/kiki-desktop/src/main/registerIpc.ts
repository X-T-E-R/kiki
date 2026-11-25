import { isValidRemoteConnectionId } from '#/main/launchArgs';
import { buildDesktopLogInfo } from '#/main/rotatingLog';
import type { DaemonSupervisor } from '#/main/daemonSupervisor';
import type { FileAndClipboardService } from '#/main/fileAndClipboardService';
import type { NotificationService } from '#/main/notificationService';
import type { PrefsAndUpdateService } from '#/main/prefsAndUpdateService';
import type { SpaceCatalog } from '#/main/spaceCatalog';
import type { SubscribeIntentQueue } from '#/main/subscribeIntent';
import type { WindowService } from '#/main/windowService';
import {
  IPC_CHANNELS,
  IPC_SCHEMAS,
  validateIpcPayload,
  type IpcChannel,
} from '#/shared/ipcChannels';
import type { SpaceWindowMode } from '#/shared/types';

export interface DesktopServices {
  readonly daemon: DaemonSupervisor;
  readonly windows: WindowService;
  readonly notifications: NotificationService;
  readonly files: FileAndClipboardService;
  readonly prefsAndUpdates: PrefsAndUpdateService;
  readonly subscribeQueue: SubscribeIntentQueue;
  readonly spaces: SpaceCatalog;
  readonly spaceWindowMode: SpaceWindowMode;
  readonly openLogDirectory: (dirPath: string) => Promise<void>;
}

export interface IpcRegistrar {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
}

export type IpcHandlerMap = Readonly<Record<IpcChannel, (payload: unknown) => unknown>>;

export function createIpcHandlers(services: DesktopServices): IpcHandlerMap {
  const { daemon, windows, notifications, files, prefsAndUpdates, subscribeQueue, spaces } = services;

  const prepareTargetSpace = async (homeId: string): Promise<{ readonly homeId: string }> => {
    const space = await spaces.findSpace(homeId);
    daemon.setTargetHome(space.path);
    await daemon.discoverConnection();
    spaces.setActiveSpace(space);
    return { homeId: space.homeId };
  };

  return {
    [IPC_CHANNELS.discoverConnection]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.discoverConnection], payload);
      return daemon.discoverConnection();
    },
    [IPC_CHANNELS.cancelStartup]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.cancelStartup], payload);
      await daemon.cancelStartup();
    },
    [IPC_CHANNELS.sshListProfiles]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshListProfiles], payload);
      return daemon.listSshProfiles();
    },
    [IPC_CHANNELS.sshSaveProfile]: async (payload) => {
      const { profile } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshSaveProfile], payload);
      return daemon.saveSshProfile(profile);
    },
    [IPC_CHANNELS.sshRemoveProfile]: async (payload) => {
      const { id } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshRemoveProfile], payload);
      return daemon.removeSshProfile(id);
    },
    [IPC_CHANNELS.sshConnectProfile]: async (payload) => {
      const { id, token } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshConnectProfile], payload);
      return daemon.connectSshProfile(id, token, false);
    },
    [IPC_CHANNELS.sshPrepareProfile]: async (payload) => {
      const { id, token } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshPrepareProfile], payload);
      return daemon.connectSshProfile(id, token, true);
    },
    [IPC_CHANNELS.sshResumeScopeConnection]: async (payload) => {
      const { homeId, id, tunnelId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.sshResumeScopeConnection],
        payload,
      );
      return daemon.resumeScopeConnection(homeId, id, tunnelId);
    },
    [IPC_CHANNELS.sshCommitScopeConnection]: async (payload) => {
      const { homeId, id, tunnelId, reload } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.sshCommitScopeConnection],
        payload,
      );
      await daemon.commitScopeConnection(homeId, id, tunnelId, reload);
    },
    [IPC_CHANNELS.sshTakeScopeConnection]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshTakeScopeConnection], payload);
      return daemon.takeScopeConnection();
    },
    [IPC_CHANNELS.sshTunnelRunning]: async (payload) => {
      const { id, tunnelId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshTunnelRunning], payload);
      return daemon.sshTunnelRunning(id, tunnelId);
    },
    [IPC_CHANNELS.sshDisconnectProfile]: async (payload) => {
      const { id, tunnelId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.sshDisconnectProfile],
        payload,
      );
      await daemon.disconnectSshProfile(id, tunnelId);
    },
    [IPC_CHANNELS.sshSetWorkspaceScope]: (payload) => {
      const { scope } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.sshSetWorkspaceScope], payload);
      files.setWorkspaceScope(scope);
    },
    [IPC_CHANNELS.windowShowMain]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.windowShowMain], payload);
      await windows.showMainWindow();
    },
    [IPC_CHANNELS.windowIsVisibleAndFocused]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.windowIsVisibleAndFocused], payload);
      return windows.isVisibleAndFocused();
    },
    [IPC_CHANNELS.windowSetTheme]: (payload) => {
      const { theme } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.windowSetTheme], payload);
      windows.setTheme(theme);
    },
    [IPC_CHANNELS.windowSetZoom]: (payload) => {
      const { factor } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.windowSetZoom], payload);
      return windows.setZoom(factor);
    },
    [IPC_CHANNELS.windowGetMode]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.windowGetMode], payload);
      return windows.getWindowMode();
    },
    [IPC_CHANNELS.pluginFocusRead]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.pluginFocusRead], payload);
      return daemon.readPluginFocus(spaces.getActiveSpace().homeId);
    },
    [IPC_CHANNELS.pluginFocusAck]: async (payload) => {
      const { homeId, requestId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.pluginFocusAck], payload);
      await daemon.ackPluginFocus(homeId, requestId);
    },
    [IPC_CHANNELS.pluginFocusRemember]: async (payload) => {
      const { homeId, requestId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.pluginFocusRemember],
        payload,
      );
      await daemon.rememberPluginFocus(homeId, requestId);
    },
    [IPC_CHANNELS.notificationsSend]: async (payload) => {
      const options = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.notificationsSend], payload);
      await notifications.send(options);
    },
    [IPC_CHANNELS.notificationsAcknowledge]: (payload) => {
      const { sessionId, scope, deliveryId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.notificationsAcknowledge],
        payload,
      );
      notifications.acknowledge(sessionId, scope, deliveryId);
    },
    [IPC_CHANNELS.notificationsTakeIntent]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.notificationsTakeIntent], payload);
      return notifications.takeNavigationIntent();
    },
    [IPC_CHANNELS.notificationsAckIntent]: (payload) => {
      const { navigationId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.notificationsAckIntent],
        payload,
      );
      return notifications.ackNavigationIntent(navigationId);
    },
    [IPC_CHANNELS.notificationsSetUnreadBadge]: (payload) => {
      const { count, homeId, scopeId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.notificationsSetUnreadBadge],
        payload,
      );
      notifications.setUnreadBadge(count, homeId, scopeId);
    },
    [IPC_CHANNELS.filesOpenSaveSink]: async (payload) => {
      const { filename } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesOpenSaveSink], payload);
      return files.openSaveSink(filename);
    },
    [IPC_CHANNELS.filesWriteSaveSink]: async (payload) => {
      const { sinkId, chunk } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.filesWriteSaveSink],
        payload,
      );
      await files.writeSaveSink(sinkId, chunk);
    },
    [IPC_CHANNELS.filesCloseSaveSink]: async (payload) => {
      const { sinkId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesCloseSaveSink], payload);
      return files.closeSaveSink(sinkId);
    },
    [IPC_CHANNELS.filesAbortSaveSink]: async (payload) => {
      const { sinkId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesAbortSaveSink], payload);
      await files.abortSaveSink(sinkId);
    },
    [IPC_CHANNELS.filesSaveBlob]: async (payload) => {
      const { bytes, filename } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesSaveBlob], payload);
      return files.saveBlob(bytes, filename);
    },
    [IPC_CHANNELS.filesPickFilePath]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesPickFilePath], payload);
      return files.pickFilePath();
    },
    [IPC_CHANNELS.filesPickFiles]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesPickFiles], payload);
      return files.pickFiles();
    },
    [IPC_CHANNELS.filesReadSelectedFile]: async (payload) => {
      const { token } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesReadSelectedFile], payload);
      return files.readSelectedFile(token);
    },
    [IPC_CHANNELS.filesPickDirectory]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesPickDirectory], payload);
      return files.pickDirectory();
    },
    [IPC_CHANNELS.filesPickDirectories]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesPickDirectories], payload);
      return files.pickDirectories();
    },
    [IPC_CHANNELS.filesReadClipboardFiles]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesReadClipboardFiles], payload);
      return files.readClipboardFiles();
    },
    [IPC_CHANNELS.filesReadDroppedFiles]: async (payload) => {
      const { paths } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesReadDroppedFiles], payload);
      return files.readDroppedFiles(paths);
    },
    [IPC_CHANNELS.filesRevealPath]: async (payload) => {
      const { path } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesRevealPath], payload);
      await files.revealPath(path);
    },
    [IPC_CHANNELS.filesOpenPath]: async (payload) => {
      const { path } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesOpenPath], payload);
      await files.openPath(path);
    },
    [IPC_CHANNELS.filesOpenExternalUrl]: async (payload) => {
      const { url } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesOpenExternalUrl], payload);
      await files.openExternalUrl(url);
    },
    [IPC_CHANNELS.filesWriteFileText]: async (payload) => {
      const { path, text } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.filesWriteFileText], payload);
      await files.writeFileText(path, text);
    },
    [IPC_CHANNELS.desktopReadPrefs]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopReadPrefs], payload);
      return prefsAndUpdates.readPrefs(spaces.getActiveSpace().path);
    },
    [IPC_CHANNELS.desktopWritePrefs]: async (payload) => {
      const { prefs } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopWritePrefs], payload);
      await prefsAndUpdates.writePrefs(
        prefs as Parameters<PrefsAndUpdateService['writePrefs']>[0],
        spaces.getActiveSpace().path,
      );
    },
    [IPC_CHANNELS.desktopGetAutostart]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopGetAutostart], payload);
      return prefsAndUpdates.getAutostart();
    },
    [IPC_CHANNELS.desktopSetAutostart]: (payload) => {
      const { enabled } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopSetAutostart], payload);
      return prefsAndUpdates.setAutostart(enabled);
    },
    [IPC_CHANNELS.desktopActiveSpace]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopActiveSpace], payload);
      return spaces.getActiveSpace();
    },
    [IPC_CHANNELS.desktopSpaceStatuses]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopSpaceStatuses], payload);
      try {
        const result = await daemon.listSpacesAndStatuses();
        return result.statuses;
      } catch {
        return [
          {
            homeId: spaces.getActiveSpace().homeId,
            active: true,
            hot: daemon.currentConnection !== null,
            pendingCount: 0,
            busyCount: 0,
          },
        ];
      }
    },
    [IPC_CHANNELS.desktopSwitchSpace]: async (payload) => {
      const { homeId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopSwitchSpace], payload);
      await prepareTargetSpace(homeId);
      await windows.reloadForSwitchedSpace();
    },
    [IPC_CHANNELS.desktopPrepareSpace]: async (payload) => {
      const { homeId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopPrepareSpace], payload);
      return prepareTargetSpace(homeId);
    },
    [IPC_CHANNELS.desktopOpenSpace]: async (payload) => {
      const { homeId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopOpenSpace], payload);
      if (services.spaceWindowMode === 'switch') {
        await prepareTargetSpace(homeId);
        await windows.reloadForSwitchedSpace();
        return;
      }
      const space = await spaces.findSpace(homeId);
      windows.openSpaceWindow(space.path);
    },
    [IPC_CHANNELS.desktopOpenRemoteSpace]: (payload) => {
      const { connectionId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.desktopOpenRemoteSpace],
        payload,
      );
      if (!isValidRemoteConnectionId(connectionId)) {
        throw new Error('Invalid remote connection id');
      }
      windows.openRemoteSpaceWindow(spaces.getActiveSpace().path, connectionId);
    },
    [IPC_CHANNELS.desktopCreateSpaceShortcut]: async (payload) => {
      const { homeId } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.desktopCreateSpaceShortcut],
        payload,
      );
      const space = await spaces.findSpace(homeId);
      return prefsAndUpdates.createSpaceShortcut(space.homeId, space.path, space.name);
    },
    [IPC_CHANNELS.desktopRestartSpace]: async (payload) => {
      const { homeId } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopRestartSpace], payload);
      const space = await spaces.findSpace(homeId);
      await daemon.restartSpace(space.path);
    },
    [IPC_CHANNELS.desktopRestartServer]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopRestartServer], payload);
      await daemon.restartServer();
    },
    [IPC_CHANNELS.desktopLogInfo]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopLogInfo], payload);
      const activePath = spaces.getActiveSpace().path;
      const prefs = await prefsAndUpdates.readPrefs(activePath);
      return buildDesktopLogInfo(activePath, prefs.logLevel ?? 'warn');
    },
    [IPC_CHANNELS.desktopOpenLogDirectory]: async (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopOpenLogDirectory], payload);
      const activePath = spaces.getActiveSpace().path;
      const prefs = await prefsAndUpdates.readPrefs(activePath);
      const info = buildDesktopLogInfo(activePath, prefs.logLevel ?? 'warn');
      await services.openLogDirectory(info.directory);
    },
    [IPC_CHANNELS.desktopSupportsUpdates]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopSupportsUpdates], payload);
      return prefsAndUpdates.supportsUpdates();
    },
    [IPC_CHANNELS.desktopCheckUpdate]: async (payload) => {
      const parsed = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopCheckUpdate], payload);
      return prefsAndUpdates.checkUpdate(parsed?.channel ?? 'stable');
    },
    [IPC_CHANNELS.desktopInstallUpdate]: async (payload) => {
      const parsed = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopInstallUpdate], payload);
      await prefsAndUpdates.installUpdate(parsed?.expectedChannel, parsed?.expectedVersion);
    },
    [IPC_CHANNELS.desktopMutateUpdateState]: async (payload) => {
      const { mutation } = validateIpcPayload(
        IPC_SCHEMAS[IPC_CHANNELS.desktopMutateUpdateState],
        payload,
      );
      return prefsAndUpdates.mutateUpdateState(mutation);
    },
    [IPC_CHANNELS.desktopPeekSubscribeIntent]: (payload) => {
      validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopPeekSubscribeIntent], payload);
      return subscribeQueue.peek();
    },
    [IPC_CHANNELS.desktopAckSubscribeIntent]: (payload) => {
      const { id } = validateIpcPayload(IPC_SCHEMAS[IPC_CHANNELS.desktopAckSubscribeIntent], payload);
      return subscribeQueue.ack(id);
    },
  };
}

export function registerDesktopIpc(ipcMain: IpcRegistrar, services: DesktopServices): IpcHandlerMap {
  const handlers = createIpcHandlers(services);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, payload) => handler(payload));
  }
  return handlers;
}

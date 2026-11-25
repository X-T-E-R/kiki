import {
  readSettings,
  type DesktopNativePrefs,
  type DesktopUpdateState,
  type UpdateChannel,
} from '@kiki/session-core/settings';

import { notificationIntent, notificationScope } from '../lib/notificationNavigation';
import type { NavScopeIdentity } from '../lib/navHistory';
import type { ResolvedTheme } from '../lib/theme';
import type { SshProfile } from '../state/connectionConfig';
import {
  clampUnreadBadgeCount,
  createDesktopConnectionCoordinator,
  createSubscribeIntentController,
  normalizeDesktopPrefsPatch,
  normalizeHostPath,
  parseDesktopWindowMode,
  parsePluginFocusIntent,
} from './desktopShared';
import type {
  DesktopAutostartStatus,
  DesktopLogInfo,
  DesktopSpaceStatus,
  DesktopUpdate,
  DesktopUpdateMutation,
  DesktopWindowMode,
  ElectronHostAdapter,
  HostFileDrop,
  HostNotification,
  HostPluginFocusIntent,
  HostSelectedFile,
  HostSubscribeIntent,
  LocalConnection,
  NotificationNavigationIntent,
  SshResolvedConnection,
} from './host';

export interface KikiElectronSelectedFile {
  readonly token: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface KikiElectronFileSelectionResult {
  readonly paths: readonly string[];
  readonly files: readonly KikiElectronSelectedFile[];
}

export interface KikiElectronBridge {
  discoverConnection(): Promise<LocalConnection | null>;
  cancelStartup(): Promise<void>;
  onBackendStage(cb: (payload: unknown) => void): () => void;
  readonly ssh: {
    listProfiles(): Promise<SshProfile[]>;
    saveProfile(profile: SshProfile): Promise<SshProfile[]>;
    removeProfile(id: string): Promise<SshProfile[]>;
    connectProfile(id: string, token: string): Promise<SshResolvedConnection>;
    prepareProfile(id: string, token: string): Promise<SshResolvedConnection>;
    resumeScopeConnection(
      homeId: string,
      id: string,
      tunnelId: string,
    ): Promise<{ profile: SshProfile; connection: SshResolvedConnection }>;
    commitScopeConnection(homeId: string, id: string, tunnelId: string, reload: boolean): Promise<void>;
    takeScopeConnection(): Promise<{ profile: SshProfile; connection: SshResolvedConnection } | null>;
    tunnelRunning(id: string, tunnelId: string): Promise<boolean>;
    disconnectProfile(id: string, tunnelId: string): Promise<void>;
    setWorkspaceScope(scope: 'local' | 'ssh'): void;
  };
  readonly window: {
    showMainWindow(): Promise<void>;
    isVisibleAndFocused(): Promise<boolean>;
    onFocus(cb: () => void): () => void;
    setTheme(theme: ResolvedTheme | 'system'): Promise<void>;
    setZoom(factor: number): Promise<boolean>;
    getWindowMode(): Promise<DesktopWindowMode | null>;
  };
  readonly pluginFocus: {
    read(): Promise<HostPluginFocusIntent | null>;
    ack(homeId: string, requestId: number): Promise<void>;
    remember(homeId: string, requestId: number): Promise<void>;
  };
  readonly notifications: {
    send(options: HostNotification): Promise<void>;
    acknowledge(sessionId: string, scope: NavScopeIdentity, deliveryId?: string): Promise<void>;
    onClick(cb: (route: string, homeId?: string, scope?: NavScopeIdentity) => void): () => void;
    takeNavigationIntent(): Promise<NotificationNavigationIntent | { readonly connectionId: string } | null>;
    setUnreadBadge(count: number, homeId?: string, scopeId?: string, sessionIds?: readonly string[]): Promise<void>;
  };
  readonly files: {
    openSaveSink(filename: string): Promise<{ sinkId: string } | null>;
    writeSaveSink(sinkId: string, chunk: Uint8Array): Promise<void>;
    closeSaveSink(sinkId: string): Promise<boolean>;
    abortSaveSink(sinkId: string): Promise<void>;
    saveBlob(bytes: Uint8Array, filename: string): Promise<boolean>;
    pickFilePath(): Promise<string | null>;
    pickFiles(): Promise<readonly KikiElectronSelectedFile[] | null>;
    readSelectedFile(token: string): Promise<Uint8Array>;
    pickDirectory(): Promise<string | null>;
    pickDirectories(): Promise<readonly string[] | null>;
    readClipboardFiles(): Promise<KikiElectronFileSelectionResult | null>;
    readDroppedFiles(paths: readonly string[]): Promise<KikiElectronFileSelectionResult>;
    onFileDrop(cb: (drop: HostFileDrop) => void): () => void;
    revealPath(path: string): Promise<void>;
    openPath(path: string): Promise<void>;
    openExternalUrl(url: string): Promise<void>;
    writeFileText(path: string, text: string): Promise<void>;
  };
  readonly desktop: {
    readPrefs(): Promise<DesktopNativePrefs | null>;
    writePrefs(prefs: Partial<DesktopNativePrefs>): Promise<void>;
    getAutostart(): Promise<DesktopAutostartStatus | null>;
    setAutostart(enabled: boolean): Promise<DesktopAutostartStatus>;
    activeSpace(): Promise<unknown>;
    spaceStatuses(): Promise<readonly DesktopSpaceStatus[]>;
    switchSpace(homeId: string): Promise<void>;
    prepareSpace(homeId: string): Promise<{ readonly homeId: string }>;
    openSpace(homeId: string): Promise<void>;
    openRemoteSpace(connectionId: string): Promise<void>;
    createSpaceShortcut(homeId: string): Promise<{ readonly homeId: string; readonly path: string }>;
    restartSpace(homeId: string): Promise<void>;
    restartServer(): Promise<void>;
    logInfo(): Promise<DesktopLogInfo>;
    openLogDirectory(): Promise<void>;
    supportsUpdates(): Promise<boolean>;
    checkUpdate(channel?: UpdateChannel): Promise<Omit<DesktopUpdate, 'install'> | null>;
    installUpdate(expectedChannel?: UpdateChannel, expectedVersion?: string): Promise<void>;
    mutateUpdateState(mutation: DesktopUpdateMutation): Promise<DesktopUpdateState>;
    onTrayNewSession(cb: () => void): () => void;
    peekSubscribeIntent(): Promise<HostSubscribeIntent | null>;
    ackSubscribeIntent(id: string): Promise<boolean>;
    onSubscribeIntent(cb: (intent: HostSubscribeIntent) => void): () => void;
    onSubscribeUrl(cb: (url: string) => void): () => void;
  };
}

declare global {
  var __KIKI_ELECTRON__: KikiElectronBridge | undefined;
}

export function getElectronBridge(): KikiElectronBridge | null {
  return '__KIKI_ELECTRON__' in globalThis && globalThis.__KIKI_ELECTRON__ != null
    ? globalThis.__KIKI_ELECTRON__
    : null;
}

export function isElectronHost(): boolean {
  return getElectronBridge() !== null;
}

function toSelectedFile(
  file: KikiElectronSelectedFile,
  readSelectedFile: (token: string) => Promise<Uint8Array>,
): HostSelectedFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    async read() {
      const bytes = await readSelectedFile(file.token);
      return new File([bytes as BlobPart], file.name, { type: file.type });
    },
  };
}

export function createElectronHost(bridge: KikiElectronBridge): ElectronHostAdapter {
  const coordinator = createDesktopConnectionCoordinator<LocalConnection | null>({
    discoverOnce: () => bridge.discoverConnection(),
    cancelOnce: () => bridge.cancelStartup(),
    onScopeChange: (scope) => {
      bridge.ssh.setWorkspaceScope(scope);
    },
  });

  const subscribeIntents = createSubscribeIntentController({
    peek: () => bridge.desktop.peekSubscribeIntent(),
    ack: (id) => bridge.desktop.ackSubscribeIntent(id),
    listenIntentWake: (onWake) => bridge.desktop.onSubscribeIntent(() => { onWake(); }),
    listenLegacyUrl: (onUrl) => bridge.desktop.onSubscribeUrl(onUrl),
  });

  return {
    kind: 'electron',
    connection: {
      discover: () => coordinator.discover(),
      listSshProfiles: async () => bridge.ssh.listProfiles(),
      saveSshProfile: async (profile) => bridge.ssh.saveProfile(profile),
      removeSshProfile: async (id) => bridge.ssh.removeProfile(id),
      connectSshProfile: async (id, token) => bridge.ssh.connectProfile(id, token),
      prepareSshProfile: async (id, token) => bridge.ssh.prepareProfile(id, token),
      resumeScopeConnection: async (homeId, id, tunnelId) => bridge.ssh.resumeScopeConnection(homeId, id, tunnelId),
      commitScopeConnection: async (homeId, id, tunnelId, reload) => bridge.ssh.commitScopeConnection(homeId, id, tunnelId, reload),
      takeScopeConnection: async () => bridge.ssh.takeScopeConnection(),
      sshTunnelRunning: async (id, tunnelId) => bridge.ssh.tunnelRunning(id, tunnelId),
      disconnectSshProfile: async (id, tunnelId) => bridge.ssh.disconnectProfile(id, tunnelId),
      setWorkspaceScope: (scope) => { coordinator.setWorkspaceScope(scope); },
      cancelStartup: () => coordinator.cancelStartup(),
      async onBackendStage(callback) {
        return bridge.onBackendStage(callback);
      },
    },
    async notify(options) {
      const scope = notificationScope(options.scope);
      await bridge.notifications.send({
        ...options,
        ...(scope !== undefined ? { scope } : { scope: undefined }),
      });
    },
    async acknowledgeNotifications(sessionId, scope, deliveryId) {
      await bridge.notifications.acknowledge(sessionId, notificationScope(scope) ?? scope, deliveryId);
    },
    onNotificationClick(callback) {
      let unsubscribed = false;
      let liveDelivered = false;
      const unlisten = bridge.notifications.onClick((route, homeId, scope) => {
        if (unsubscribed) return;
        liveDelivered = true;
        callback(route, homeId, scope);
      });
      void bridge.notifications.takeNavigationIntent().then((pending) => {
        if (unsubscribed || liveDelivered) return;
        const payload = notificationIntent(pending);
        if (payload === undefined) return;
        callback(payload.route, payload.homeId, payload.scope);
      }, () => undefined);
      return () => {
        unsubscribed = true;
        unlisten();
      };
    },
    takeNavigationIntent: async () => bridge.notifications.takeNavigationIntent(),
    async setUnreadBadge(count, homeId, scopeId, sessionIds) {
      try {
        await bridge.notifications.setUnreadBadge(clampUnreadBadgeCount(count), homeId, scopeId, sessionIds);
      } catch {
        return;
      }
    },
    openUrl: async (url) => bridge.files.openExternalUrl(url),
    showMainWindow: async () => bridge.window.showMainWindow(),
    async isWindowVisibleAndFocused() {
      try {
        return await bridge.window.isVisibleAndFocused();
      } catch {
        return true;
      }
    },
    onWindowFocus(callback) {
      let disposed = false;
      const unlisten = bridge.window.onFocus(() => {
        if (!disposed) callback();
      });
      return () => {
        disposed = true;
        unlisten();
      };
    },
    pluginFocus: {
      async read() {
        return parsePluginFocusIntent(await bridge.pluginFocus.read());
      },
      ack: async (homeId, requestId) => bridge.pluginFocus.ack(homeId, requestId),
      remember: async (homeId, requestId) => bridge.pluginFocus.remember(homeId, requestId),
    },
    async saveBlob(blob, filename) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return bridge.files.saveBlob(bytes, filename);
    },
    async openSaveSink(filename) {
      const opened = await bridge.files.openSaveSink(filename);
      if (opened === null) return null;
      let phase: 'writing' | 'closing' | 'failed' | 'closed' = 'writing';
      return {
        streaming: true,
        async write(chunk) {
          if (phase !== 'writing') throw new Error('The save stream is closed');
          await bridge.files.writeSaveSink(opened.sinkId, chunk);
        },
        async close() {
          if (phase !== 'writing') return false;
          phase = 'closing';
          try {
            const committed = await bridge.files.closeSaveSink(opened.sinkId);
            phase = 'closed';
            return committed;
          } catch (error) {
            phase = 'failed';
            throw error;
          }
        },
        async abort() {
          if (phase !== 'writing' && phase !== 'failed') return;
          phase = 'closed';
          await bridge.files.abortSaveSink(opened.sinkId);
        },
      };
    },
    async pickFilePath() {
      coordinator.requireLocalWorkspace();
      return bridge.files.pickFilePath();
    },
    async pickFiles() {
      const selected = await bridge.files.pickFiles();
      if (selected === null) return null;
      return selected.map((file) => toSelectedFile(file, bridge.files.readSelectedFile));
    },
    async readClipboardFiles() {
      const copied = await bridge.files.readClipboardFiles();
      if (copied === null) return null;
      return {
        paths: copied.paths,
        media: copied.files.map((file) => toSelectedFile(file, bridge.files.readSelectedFile)),
      };
    },
    async readDroppedFiles(paths) {
      const dropped = await bridge.files.readDroppedFiles(paths);
      return {
        paths: dropped.paths,
        media: dropped.files.map((file) => toSelectedFile(file, bridge.files.readSelectedFile)),
      };
    },
    onFileDrop(callback) {
      let disposed = false;
      const unlisten = bridge.files.onFileDrop((drop) => {
        if (!disposed) callback(drop);
      });
      return () => {
        disposed = true;
        unlisten();
      };
    },
    async pickDirectory() {
      coordinator.requireLocalWorkspace();
      return bridge.files.pickDirectory();
    },
    async pickDirectories() {
      coordinator.requireLocalWorkspace();
      return bridge.files.pickDirectories();
    },
    async revealPath(path) {
      coordinator.requireLocalWorkspace();
      await bridge.files.revealPath(normalizeHostPath(path));
    },
    async openPath(path) {
      coordinator.requireLocalWorkspace();
      await bridge.files.openPath(normalizeHostPath(path));
    },
    async writeFileText(path, text) {
      coordinator.requireLocalWorkspace();
      await bridge.files.writeFileText(normalizeHostPath(path), text);
    },
    async readDesktopPrefs() {
      try {
        return await bridge.desktop.readPrefs();
      } catch {
        return null;
      }
    },
    async writeDesktopPrefs(prefs) {
      await bridge.desktop.writePrefs(normalizeDesktopPrefsPatch(prefs));
    },
    async getDesktopAutostart() {
      try {
        return await bridge.desktop.getAutostart();
      } catch {
        return null;
      }
    },
    setDesktopAutostart: async (enabled) => bridge.desktop.setAutostart(enabled),
    activeSpace: async () => bridge.desktop.activeSpace(),
    async spaceStatuses() {
      try {
        return await bridge.desktop.spaceStatuses();
      } catch {
        return [];
      }
    },
    switchSpace: async (homeId) => bridge.desktop.switchSpace(homeId),
    prepareSpace: async (homeId) => bridge.desktop.prepareSpace(homeId),
    openSpace: async (homeId) => bridge.desktop.openSpace(homeId),
    openRemoteSpace: async (connectionId) => bridge.desktop.openRemoteSpace(connectionId),
    createSpaceShortcut: async (homeId) => bridge.desktop.createSpaceShortcut(homeId),
    restartSpace: async (homeId) => bridge.desktop.restartSpace(homeId),
    restartServer: async () => bridge.desktop.restartServer(),
    desktopLogInfo: async () => bridge.desktop.logInfo(),
    openDesktopLogDirectory: async () => bridge.desktop.openLogDirectory(),
    supportsDesktopUpdates: async () => bridge.desktop.supportsUpdates(),
    async checkDesktopUpdate(channel = 'stable'): Promise<DesktopUpdate | null> {
      const update = await bridge.desktop.checkUpdate(channel);
      if (update === null) return null;
      return {
        ...update,
        async install() {
          await bridge.desktop.installUpdate(channel, update.version);
        },
      };
    },
    mutateDesktopUpdateState: async (mutation) => bridge.desktop.mutateUpdateState(mutation),
    onTrayNewSession(callback) {
      let unsubscribed = false;
      const unlisten = bridge.desktop.onTrayNewSession(() => {
        if (!unsubscribed) callback();
      });
      return () => {
        unsubscribed = true;
        unlisten();
      };
    },
    peekSubscribeIntent: subscribeIntents.peekSubscribeIntent,
    ackSubscribeIntent: subscribeIntents.ackSubscribeIntent,
    onSubscribeIntent: subscribeIntents.onSubscribeIntent,
    onSubscribeUrl: subscribeIntents.onSubscribeUrl,
    async windowMode() {
      try {
        return parseDesktopWindowMode(await bridge.window.getWindowMode());
      } catch {
        return null;
      }
    },
    async setTheme(resolved) {
      try {
        await bridge.window.setTheme(readSettings().theme === 'system' ? 'system' : resolved);
      } catch {
        return;
      }
    },
    async setZoom(factor) {
      try {
        return await bridge.window.setZoom(factor);
      } catch {
        return false;
      }
    },
  };
}

function requireElectronBridge(): KikiElectronBridge {
  const bridge = getElectronBridge();
  if (bridge === null) {
    throw new Error('Electron host bridge is unavailable');
  }
  return bridge;
}

function lazyBridgeGroup<K extends 'ssh' | 'window' | 'pluginFocus' | 'notifications' | 'files' | 'desktop'>(
  group: K,
): KikiElectronBridge[K] {
  return new Proxy({} as KikiElectronBridge[K], {
    get(_target, prop) {
      const target = requireElectronBridge()[group] as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const lazyGlobalBridge: KikiElectronBridge = {
  discoverConnection: () => requireElectronBridge().discoverConnection(),
  cancelStartup: () => requireElectronBridge().cancelStartup(),
  onBackendStage: (cb) => requireElectronBridge().onBackendStage(cb),
  ssh: lazyBridgeGroup('ssh'),
  window: lazyBridgeGroup('window'),
  pluginFocus: lazyBridgeGroup('pluginFocus'),
  notifications: lazyBridgeGroup('notifications'),
  files: lazyBridgeGroup('files'),
  desktop: lazyBridgeGroup('desktop'),
};

export const electronHost: ElectronHostAdapter = createElectronHost(lazyGlobalBridge);

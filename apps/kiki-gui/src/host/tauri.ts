import { randomUuid } from '@kiki/session-core/util';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';

import type {
  DesktopAutostartStatus,
  DesktopLogInfo,
  DesktopSpaceStatus,
  DesktopUpdate,
  TauriHostAdapter,
  HostFileDrop,
  HostSelectedFile,
  LocalConnection,
} from './host';
import {
  clampUnreadBadgeCount,
  createDesktopConnectionCoordinator,
  createSubscribeIntentController,
  normalizeDesktopPrefsPatch,
  normalizeHostPath,
  parseDesktopWindowMode,
  parsePluginFocusIntent,
} from './desktopShared';
import { readSettings, type DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig } from '../state/connectionConfig';
import { pastedMediaType } from '../lib/pastedFiles';
import { notificationIntent, notificationScope } from '../lib/notificationNavigation';
import { NotificationPermissionNotAsked, type SystemNotificationPermission } from './notificationPermission';

const coordinator = createDesktopConnectionCoordinator<LocalConnection>({
  discoverOnce: () =>
    invoke<ConnectionConfig>('desktop_connection').then((config): LocalConnection => ({ config, persist: false })),
  cancelOnce: () => invoke<void>('cancel_desktop_startup'),
});

const subscribeIntents = createSubscribeIntentController({
  peek: () => invoke<unknown>('peek_subscribe_intent'),
  ack: (id) => invoke<boolean>('ack_subscribe_intent', { id }),
  listenIntentWake: (onWake) => listen<unknown>('kiki://subscribe-intent', () => { onWake(); }),
  listenLegacyUrl: (onUrl) => listen<unknown>('kiki://subscribe-url', (event) => {
    if (typeof event.payload === 'string') onUrl(event.payload);
  }),
});

const NATIVE_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * The system's answer so far. The plugin answers `null` while the system has
 * not been asked yet (desktop builds always report granted; mobile ones can be
 * unasked).
 */
export async function tauriNotificationPermission(): Promise<SystemNotificationPermission> {
  const granted: boolean | null = await isPermissionGranted();
  return granted === true ? 'granted' : granted === false ? 'denied' : 'default';
}

/** Ask the system; resolves to whether notifications are now allowed. */
export async function requestTauriPermission(): Promise<boolean> {
  return (await requestPermission()) === 'granted';
}

/**
 * Whether a notification may be shown. Asking is left to the person's own
 * click (the app's one-time question, or Settings), so an unasked system sends
 * nothing and says why.
 */
async function ensureNotificationPermission(): Promise<boolean> {
  const permission = await tauriNotificationPermission();
  if (permission === 'default') throw new NotificationPermissionNotAsked(requestTauriPermission);
  return permission === 'granted';
}

/** Subscribe before draining the boot queue; acknowledge only the delivered click. */
function onNotificationClick(callback: Parameters<NonNullable<TauriHostAdapter['onNotificationClick']>>[0]): () => void {
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  const delivered = new Set<string>();
  let latestClick = 0n;
  const deliver = (value: unknown) => {
    const payload = notificationIntent(value);
    if (unsubscribed || payload === undefined) return;
    if (payload.navigationId !== undefined) {
      if (delivered.has(payload.navigationId)) return;
      if (/^\d+$/.test(payload.navigationId)) {
        const click = BigInt(payload.navigationId);
        if (click <= latestClick) return;
        latestClick = click;
      }
      delivered.add(payload.navigationId);
      if (delivered.size > 64) delivered.delete(delivered.values().next().value!);
      void invoke('ack_navigation_intent', { navigationId: payload.navigationId });
    }
    callback(payload.route, payload.homeId, payload.scope);
  };
  void listen<unknown>('kiki://notification-click', (event) => { deliver(event.payload); }).then(async (fn) => {
    if (unsubscribed) { fn(); return; }
    unlisten = fn;
    deliver(await invoke('take_navigation_intent').catch(() => null));
  }, () => undefined);
  return () => {
    unsubscribed = true;
    unlisten?.();
  };
}

function onTrayNewSession(callback: () => void): () => void {
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  void listen('kiki://new-session', () => {
    if (!unsubscribed) callback();
  }).then((fn) => {
    if (unsubscribed) fn();
    else unlisten = fn;
  }, () => undefined);
  return () => {
    unsubscribed = true;
    unlisten?.();
  };
}

function onWindowFocus(callback: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void getCurrentWindow()
    .onFocusChanged(({ payload }) => {
      if (!disposed && payload) callback();
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }, () => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Tauri intercepts HTML5 drag-and-drop by default, so OS file drops arrive as
 * native window events with absolute paths. Only the `drop` phase carries
 * files; the position converts from physical to CSS pixels before delivery.
 */
function onFileDrop(callback: (drop: HostFileDrop) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const currentWindow = getCurrentWindow();
  const deliver = async (
    paths: readonly string[],
    position: { readonly x: number; readonly y: number },
  ): Promise<void> => {
    try {
      const factor = await currentWindow.scaleFactor();
      if (!disposed) {
        callback({ paths, position: { x: position.x / factor, y: position.y / factor } });
      }
    } catch {
      if (!disposed) callback({ paths });
    }
  };
  void currentWindow
    .onDragDropEvent((event) => {
      if (disposed || event.payload.type !== 'drop') return;
      void deliver(event.payload.paths, event.payload.position);
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }, () => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export const tauriHost: TauriHostAdapter = {
  kind: 'tauri',
  connection: {
    discover: () => coordinator.discover(),
    listSshProfiles: () => invoke('list_ssh_profiles'),
    saveSshProfile: (profile) => invoke('save_ssh_profile', { profile }),
    removeSshProfile: (id) => invoke('remove_ssh_profile', { id }),
    connectSshProfile: (id, token) => invoke('connect_ssh_profile', { id, token }),
    prepareSshProfile: (id, token) => invoke('prepare_ssh_profile', { id, token }),
    resumeScopeConnection: (homeId, id, tunnelId) => invoke('resume_scope_connection', { homeId, id, tunnelId }),
    commitScopeConnection: (homeId, id, tunnelId, reload) => invoke('commit_scope_connection', { homeId, id, tunnelId, reload }),
    takeScopeConnection: () => invoke('take_scope_connection'),
    sshTunnelRunning: (id, tunnelId) => invoke('ssh_tunnel_running', { id, tunnelId }),
    disconnectSshProfile: (id, tunnelId) => invoke('disconnect_ssh_profile', { id, tunnelId }),
    setWorkspaceScope: (scope) => { coordinator.setWorkspaceScope(scope); },
    cancelStartup: () => coordinator.cancelStartup(),
    async onBackendStage(callback) {
      return listen<unknown>('kiki://desktop-backend-stage', (event) => {
        callback(event.payload);
      });
    },
  },
  async notify(options) {
    if (!(await ensureNotificationPermission())) return;
    await invoke('send_desktop_notification', { title: options.title, body: options.body, route: options.route,
      scope: notificationScope(options.scope), sessionIds: options.sessionIds, deliveryId: options.deliveryId });
  },
  async acknowledgeNotifications(sessionId, scope, deliveryId) {
    await invoke('acknowledge_desktop_notifications', { sessionId, scope: notificationScope(scope), deliveryId });
  },
  onNotificationClick,
  async setUnreadBadge(count, homeId, scopeId, sessionIds) {
    try {
      await invoke('set_unread_count', { n: clampUnreadBadgeCount(count), homeId, scopeId, sessionIds });
    } catch {
      return;
    }
  },
  async showMainWindow() {
    await invoke('show_main_window');
  },
  async isWindowVisibleAndFocused() {
    try {
      const window = getCurrentWindow();
      const [visible, focused] = await Promise.all([window.isVisible(), window.isFocused()]);
      return visible && focused;
    } catch {
      return true;
    }
  },
  onWindowFocus,
  pluginFocus: {
    async read() {
      return parsePluginFocusIntent(await invoke<unknown>('read_plugin_focus'));
    },
    async ack(homeId, requestId) {
      await invoke('ack_plugin_focus', { homeId, requestId });
    },
    async remember(homeId, requestId) {
      await invoke('remember_plugin_focus', { homeId, requestId });
    },
  },
  async saveBlob(blob, filename) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({ defaultPath: filename });
    if (path === null) return false;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(path, bytes);
    return true;
  },
  async openSaveSink(filename) {
    const [{ save }, { open, mkdir, rename, copyFile, remove, BaseDirectory }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({ defaultPath: filename });
    if (target === null) return null;
    await mkdir('kiki-media-saves', { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const temporary = `kiki-media-saves/${randomUuid()}.part`;
    const file = await open(temporary, { baseDir: BaseDirectory.AppLocalData, write: true, createNew: true });
    let phase: 'writing' | 'committing' | 'closed' = 'writing';
    return {
      streaming: true,
      async write(chunk) {
        if (phase !== 'writing') throw new Error('The save stream is closed');
        if (chunk.byteLength > 64 * 1024) throw new Error('The save chunk exceeds 64 KiB');
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await file.write(chunk.subarray(offset));
          if (written <= 0) throw new Error('The file could not accept the next download chunk');
          offset += written;
        }
      },
      async close() {
        if (phase !== 'writing') return false;
        phase = 'committing';
        let fileClosed = false;
        try {
          await file.close();
          fileClosed = true;
          try {
            await rename(temporary, target, { oldPathBaseDir: BaseDirectory.AppLocalData });
          } catch (error) {
            if (!/EXDEV|cross[- ]device|different disk|os error (?:17|18)/iu.test(String(error))) throw error;
            try {
              await copyFile(temporary, target, { fromPathBaseDir: BaseDirectory.AppLocalData });
            } catch (cause) {
              throw new Error('Could not finish saving. The selected file may be incomplete.', { cause });
            }
          }
          return true;
        } finally {
          phase = 'closed';
          if (!fileClosed) await file.close().catch(() => {});
          await remove(temporary, { baseDir: BaseDirectory.AppLocalData }).catch(() => {});
        }
      },
      async abort() {
        if (phase !== 'writing') return;
        phase = 'closed';
        try { await file.close(); }
        finally { await remove(temporary, { baseDir: BaseDirectory.AppLocalData }); }
      },
    };
  },
  async pickFilePath(): Promise<string | null> {
    coordinator.requireLocalWorkspace();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: false, multiple: false });
    if (selected === null) return null;
    return typeof selected === 'string' ? selected : selected[0] ?? null;
  },
  async pickFiles(): Promise<HostSelectedFile[] | null> {
    const [{ open }, { readFile, stat }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const selected = await open({ multiple: true });
    if (selected === null) return null;
    const paths = typeof selected === 'string' ? [selected] : selected;
    return Promise.all(
      paths.map(async (path) => {
        const name = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
        const extension = name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : '';
        const type = NATIVE_IMAGE_MIMES[extension] ?? '';
        const info = await stat(path);
        return {
          name,
          size: info.size,
          type,
          async read() {
            const bytes = await readFile(path);
            return new File([bytes], name, { type });
          },
        };
      }),
    );
  },
  async readClipboardFiles() {
    const copied = await invoke<string[] | null>('read_clipboard_file_paths');
    if (copied === null) return null;
    return tauriHost.readDroppedFiles(copied);
  },
  async readDroppedFiles(copied: readonly string[]) {
    const paths: string[] = [];
    const media: HostSelectedFile[] = [];
    const { stat, readFile } = await import('@tauri-apps/plugin-fs');
    for (const path of copied) {
      const name = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
      const type = pastedMediaType({ name, type: '' });
      if (type === null) {
        paths.push(path);
        continue;
      }
      const info = await stat(path);
      if (info.isDirectory) {
        paths.push(path);
        continue;
      }
      media.push({ name, size: info.size, type, async read() {
        return new File([await readFile(path)], name, { type });
      } });
    }
    return { paths, media };
  },
  async pickDirectories() {
    coordinator.requireLocalWorkspace();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: true });
    if (selected === null) return null;
    return typeof selected === 'string' ? [selected] : selected;
  },
  async pickDirectory() {
    coordinator.requireLocalWorkspace();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (selected === null) return null;
    return typeof selected === 'string' ? selected : (selected[0] ?? null);
  },
  async revealPath(path) {
    coordinator.requireLocalWorkspace();
    await invoke('reveal_host_path', { path: normalizeHostPath(path) });
  },
  async openUrl(url) {
    await invoke('open_external_url', { url });
  },
  async openPath(path) {
    coordinator.requireLocalWorkspace();
    await invoke('open_host_path', { path: normalizeHostPath(path) });
  },
  async writeFileText(path, text) {
    coordinator.requireLocalWorkspace();
    await invoke('write_host_file_text', { path: normalizeHostPath(path), text });
  },
  async writeDesktopPrefs(prefs) {
    await invoke('write_desktop_prefs', { prefs: normalizeDesktopPrefsPatch(prefs) });
  },
  async readDesktopPrefs() {
    try {
      return await invoke<DesktopNativePrefs>('read_desktop_prefs');
    } catch {
      return null;
    }
  },
  async getDesktopAutostart() {
    try {
      return await invoke<DesktopAutostartStatus>('get_desktop_autostart');
    } catch {
      return null;
    }
  },
  async setDesktopAutostart(enabled) {
    return invoke<DesktopAutostartStatus>('set_desktop_autostart', { enabled });
  },
  async restartServer() {
    await invoke('restart_server');
  },
  desktopLogInfo: () => invoke<DesktopLogInfo>('desktop_log_info'),
  async openDesktopLogDirectory() {
    await invoke('open_desktop_log_directory');
  },
  async supportsDesktopUpdates() {
    return invoke<boolean>('supports_desktop_updates');
  },
  mutateDesktopUpdateState: (mutation) => invoke('mutate_desktop_update_state', { mutation }),
  async checkDesktopUpdate(channel = 'stable'): Promise<DesktopUpdate | null> {
    const update = await invoke<Omit<DesktopUpdate, 'install'> | null>('check_desktop_update', { channel });
    if (update === null) return null;
    return {
      ...update,
      async install() {
        await invoke('install_desktop_update', { channel, version: update.version });
      },
    };
  },
  onTrayNewSession,
  peekSubscribeIntent: subscribeIntents.peekSubscribeIntent,
  ackSubscribeIntent: subscribeIntents.ackSubscribeIntent,
  onSubscribeIntent: subscribeIntents.onSubscribeIntent,
  onSubscribeUrl: subscribeIntents.onSubscribeUrl,
  onFileDrop,
  /**
   * The desktop space this window belongs to. Older desktop builds have no
   * such command yet, so the rejection is the storage boot's signal to keep the
   * pre-space key names; it must not fail the launch.
   */
  activeSpace: () => invoke<unknown>('desktop_active_space'),
  // A build without work modes has no such command; that reads as "this
  // window has no mode of its own" rather than failing the boot.
  async windowMode() {
    try {
      // Native serializes WindowModeDescriptor in camelCase.
      return parseDesktopWindowMode(await invoke<unknown>('desktop_window_mode'));
    } catch {
      return null;
    }
  },
  takeNavigationIntent: () => invoke('take_navigation_intent'),
  async spaceStatuses() {
    try {
      return await invoke<DesktopSpaceStatus[]>('desktop_space_statuses');
    } catch {
      // A desktop build without spaces: every space reads as cold.
      return [];
    }
  },
  prepareSpace: (homeId) => invoke('prepare_space', { homeId }),
  async switchSpace(homeId) {
    await invoke('switch_space', { homeId });
  },
  async openSpace(homeId) {
    await invoke('open_space', { homeId });
  },
  async openRemoteSpace(connectionId) {
    await invoke('open_space', { connectionId });
  },
  createSpaceShortcut: (homeId) => invoke('create_space_shortcut', { homeId }),
  async restartSpace(homeId) {
    await invoke('restart_space', { homeId });
  },
  async setTheme(resolved) {
    // The native theme also decides what `prefers-color-scheme` reports to
    // this page (macOS sets it app-wide; Windows passes it to WebView2).
    // Pinning it under the `system` preference would freeze that query and
    // stop the app following the OS, so `system` hands it back with null.
    try {
      await getCurrentWindow().setTheme(readSettings().theme === 'system' ? null : resolved);
    } catch {
      return;
    }
  },
  async setZoom(factor) {
    try {
      await getCurrentWebview().setZoom(factor);
      return true;
    } catch {
      return false;
    }
  },
};

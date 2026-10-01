import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';

import type {
  DesktopLogInfo,
  DesktopSpaceStatus,
  DesktopUpdate,
  TauriHostAdapter,
  HostFileDrop,
  HostSelectedFile,
} from './host';
import type { DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig } from '../state/connectionConfig';

let remoteWorkspaceActive = false;

function requireLocalWorkspace(): void {
  if (remoteWorkspaceActive) {
    throw new Error('This is an SSH workspace. Use a remote server operation, not a local file or directory action.');
  }
}

const NATIVE_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

async function ensureNotificationPermission(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === 'granted';
  }
  return granted;
}

/** Native notification clicks forwarded by the desktop shell with `{ route }`. */
function onNotificationClick(callback: (route: string) => void): () => void {
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  void listen<unknown>('kiki://notification-click', (event) => {
    const payload = event.payload as { route?: unknown } | null;
    if (!unsubscribed && typeof payload?.route === 'string') callback(payload.route);
  }).then((fn) => {
    if (unsubscribed) fn();
    else unlisten = fn;
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
    async discover() {
      const config = await invoke<ConnectionConfig>('desktop_connection');
      return { config, persist: false };
    },
    listSshProfiles: () => invoke('list_ssh_profiles'),
    saveSshProfile: (profile) => invoke('save_ssh_profile', { profile }),
    removeSshProfile: (id) => invoke('remove_ssh_profile', { id }),
    connectSshProfile: (id, token) => invoke('connect_ssh_profile', { id, token }),
    sshTunnelRunning: (id, tunnelId) => invoke('ssh_tunnel_running', { id, tunnelId }),
    disconnectSshProfile: (id, tunnelId) => invoke('disconnect_ssh_profile', { id, tunnelId }),
    setWorkspaceScope: (scope) => { remoteWorkspaceActive = scope === 'ssh'; },
    async cancelStartup() {
      await invoke('cancel_desktop_startup');
    },
    async onBackendStage(callback) {
      return listen<unknown>('kiki://desktop-backend-stage', (event) => {
        callback(event.payload);
      });
    },
  },
  async notify(options) {
    if (!(await ensureNotificationPermission())) return;
    await invoke('send_desktop_notification', { title: options.title, body: options.body, route: options.route });
  },
  onNotificationClick,
  async setUnreadBadge(count) {
    try {
      await invoke('set_unread_count', { n: Math.max(0, Math.min(0xffffffff, Math.trunc(count))) });
    } catch {
      return;
    }
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
  async pickDirectories() {
    requireLocalWorkspace();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: true });
    if (selected === null) return null;
    return typeof selected === 'string' ? [selected] : selected;
  },
  async pickDirectory() {
    requireLocalWorkspace();
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (selected === null) return null;
    return typeof selected === 'string' ? selected : (selected[0] ?? null);
  },
  async revealPath(path) {
    requireLocalWorkspace();
    await invoke('reveal_host_path', { path: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path });
  },
  async openUrl(url) {
    await invoke('open_external_url', { url });
  },
  async openPath(path) {
    requireLocalWorkspace();
    await invoke('open_host_path', { path: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path });
  },
  async writeFileText(path, text) {
    requireLocalWorkspace();
    await invoke('write_host_file_text', { path, text });
  },
  async writeDesktopPrefs(prefs) {
    try {
      await invoke('write_desktop_prefs', { prefs });
    } catch {
      return;
    }
  },
  async readDesktopPrefs() {
    try {
      return await invoke<DesktopNativePrefs>('read_desktop_prefs');
    } catch {
      return null;
    }
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
  async checkDesktopUpdate(): Promise<DesktopUpdate | null> {
    const update = await invoke<Omit<DesktopUpdate, 'install'> | null>('check_desktop_update');
    if (update === null) return null;
    return {
      ...update,
      async install() {
        await invoke('prepare_for_update');
        await invoke('install_desktop_update');
      },
    };
  },
  onTrayNewSession,
  onFileDrop,
  /**
   * The desktop space this window belongs to. Older desktop builds have no
   * such command yet, so the rejection is the storage boot's signal to keep the
   * pre-space key names; it must not fail the launch.
   */
  activeSpace: () => invoke<unknown>('desktop_active_space'),
  async spaceStatuses() {
    try {
      return await invoke<DesktopSpaceStatus[]>('desktop_space_statuses');
    } catch {
      // A desktop build without spaces: every space reads as cold.
      return [];
    }
  },
  async switchSpace(homeId) {
    await invoke('switch_space', { homeId });
  },
  async openSpace(homeId) {
    await invoke('open_space', { homeId });
  },
  createSpaceShortcut: (homeId) => invoke('create_space_shortcut', { homeId }),
  async restartSpace(homeId) {
    await invoke('restart_space', { homeId });
  },
  async setTheme(resolved) {
    try {
      await getCurrentWindow().setTheme(resolved);
    } catch {
      return;
    }
  },
};

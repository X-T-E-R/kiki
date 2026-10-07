import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
} from '@tauri-apps/plugin-notification';

import type {
  DesktopLogInfo,
  DesktopWindowMode,
  DesktopSpaceStatus,
  DesktopUpdate,
  TauriHostAdapter,
  HostFileDrop,
  HostSelectedFile,
  LocalConnection,
} from './host';
import type { DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig } from '../state/connectionConfig';
import { pastedMediaType } from '../lib/pastedFiles';

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
function onNotificationClick(callback: (route: string, homeId?: string, scopeId?: string) => void): () => void {
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  void listen<unknown>('kiki://notification-click', (event) => {
    const payload = event.payload as { route?: unknown; homeId?: unknown; scopeId?: unknown } | null;
    if (!unsubscribed && typeof payload?.route === 'string') {
      void invoke('take_navigation_intent');
      callback(payload.route, typeof payload.homeId === 'string' ? payload.homeId : undefined,
        typeof payload.scopeId === 'string' ? payload.scopeId : undefined);
    }
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

let desktopDiscovery: Promise<LocalConnection> | null = null;
let desktopCancellation: Promise<void> | null = null;

async function discoverDesktop(): Promise<LocalConnection> {
  if (desktopCancellation !== null) await desktopCancellation;
  if (desktopDiscovery === null) {
    const flight = invoke<ConnectionConfig>('desktop_connection').then((config): LocalConnection => ({ config, persist: false }));
    desktopDiscovery = flight;
    const release = () => { if (desktopDiscovery === flight) desktopDiscovery = null; };
    void flight.then(release, release);
  }
  return desktopDiscovery;
}

export const tauriHost: TauriHostAdapter = {
  kind: 'tauri',
  connection: {
    discover: discoverDesktop,
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
    setWorkspaceScope: (scope) => { remoteWorkspaceActive = scope === 'ssh'; },
    async cancelStartup() {
      if (desktopCancellation !== null) return desktopCancellation;
      const pending = desktopDiscovery;
      const cancellation = invoke<void>('cancel_desktop_startup').then(async () => { await pending?.catch(() => undefined); });
      desktopCancellation = cancellation;
      try { await cancellation; }
      finally { if (desktopCancellation === cancellation) desktopCancellation = null; }
    },
    async onBackendStage(callback) {
      return listen<unknown>('kiki://desktop-backend-stage', (event) => {
        callback(event.payload);
      });
    },
  },
  async notify(options) {
    if (!(await ensureNotificationPermission())) return;
    await invoke('send_desktop_notification', { title: options.title, body: options.body, route: options.route,
      homeId: options.homeId, scopeId: options.scopeId });
  },
  onNotificationClick,
  async setUnreadBadge(count, homeId, scopeId, sessionIds) {
    try {
      await invoke('set_unread_count', { n: Math.max(0, Math.min(0xffffffff, Math.trunc(count))), homeId, scopeId, sessionIds });
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
  async openSaveSink(filename) {
    const [{ save }, { open, mkdir, rename, copyFile, remove, BaseDirectory }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({ defaultPath: filename });
    if (target === null) return null;
    await mkdir('kiki-media-saves', { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const temporary = `kiki-media-saves/${crypto.randomUUID()}.part`;
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
    // JSON drops undefined keys; an explicitly cleared record must reach native.
    const patch = Object.hasOwn(prefs, 'updateState') && prefs.updateState === undefined
      ? { ...prefs, updateState: {} }
      : prefs;
    await invoke('write_desktop_prefs', { prefs: patch });
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
      const mode = await invoke<{ preset_id?: unknown; window_id?: unknown }>('desktop_window_mode');
      if (typeof mode.preset_id !== 'string' || typeof mode.window_id !== 'string') return null;
      return { presetId: mode.preset_id, windowId: mode.window_id } satisfies DesktopWindowMode;
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
    try {
      await getCurrentWindow().setTheme(resolved);
    } catch {
      return;
    }
  },
};

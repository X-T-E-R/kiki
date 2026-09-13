import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

import type {
  CompatibilityMigrationResult,
  DesktopUpdate,
  TauriHostAdapter,
  HostSelectedFile,
  KimiConfigImportResult,
  KimiHomePaths,
  SessionsMigrationPlan,
} from './host';
import type { DesktopNativePrefs } from '@kiki/session-core/settings';
import type { ConnectionConfig } from '../state/connectionConfig';

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

export const tauriHost: TauriHostAdapter = {
  kind: 'tauri',
  connection: {
    async discover() {
      const config = await invoke<ConnectionConfig>('desktop_connection');
      return { config, persist: false };
    },
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
    sendNotification(options);
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
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: true });
    if (selected === null) return null;
    return typeof selected === 'string' ? [selected] : selected;
  },
  async pickDirectory() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (selected === null) return null;
    return typeof selected === 'string' ? selected : (selected[0] ?? null);
  },
  async revealPath(path) {
    await invoke('reveal_host_path', { path: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path });
  },
  async openPath(path) {
    await invoke('open_host_path', { path: /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path });
  },
  async writeFileText(path, text) {
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
  async writeCompatibilitySettings(compatibility) {
    await invoke('write_desktop_prefs', { prefs: { compatibility } });
  },
  async readKimiHomePaths() {
    try {
      return await invoke<KimiHomePaths>('read_kimi_home_paths');
    } catch {
      return null;
    }
  },
  async importKimiConfig() {
    const result = await invoke<KimiConfigImportResult>('import_kimi_config');
    if (result.status === 'imported' && result.restartError === null) window.location.reload();
    return result;
  },
  async migrateCompatibilityCategory(category) {
    const result = await invoke<CompatibilityMigrationResult>('migrate_compatibility_category', { category });
    if (result.status === 'copied' && result.restartError === null) window.location.reload();
    return result;
  },
  async dryRunSessionsMigration() {
    return invoke<SessionsMigrationPlan>('dry_run_sessions_migration');
  },
  async executeSessionsMigration() {
    const result = await invoke<SessionsMigrationPlan>('execute_sessions_migration');
    if (result.status === 'moved') window.location.reload();
    return result;
  },
  onTrayNewSession,
  async setTheme(resolved) {
    try {
      await getCurrentWindow().setTheme(resolved);
    } catch {
      return;
    }
  },
};

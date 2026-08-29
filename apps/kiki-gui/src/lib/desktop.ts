/**
 * Desktop-specific bridge — Tauri tray / notification helpers.
 *
 * All functions degrade gracefully in the browser build.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { CompatibilitySettings, DesktopNativePrefs } from './settings';

export function isDesktopRuntime(): boolean {
  return isTauri();
}

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === 'granted';
  }
  return granted;
}

export async function showDesktopNotification(options: NotificationOptions): Promise<void> {
  if (!isTauri()) return;
  const granted = await ensureNotificationPermission();
  if (!granted) return;
  sendNotification(options);
}

export async function focusMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('show_main_window');
  } catch {
    // ignore
  }
}

/**
 * Save a blob through the native save dialog (tauri-plugin-dialog) and write
 * it with tauri-plugin-fs. Resolves `false` when the user cancels the dialog.
 * Browser callers keep their blob-download path — this throws off-Tauri.
 */
export async function saveBlobNative(blob: Blob, filename: string): Promise<boolean> {
  if (!isTauri()) throw new Error('Native save requires the Kiki desktop app.');
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const path = await save({ defaultPath: filename });
  if (path === null) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, bytes);
  return true;
}

/**
 * Extensions the model accepts inline as images. Tauri's dialog hands back
 * paths, not `File`s, so the constructed `File` needs its media type spelled
 * out — without it every pick would fall through to the upload path.
 */
const NATIVE_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface NativeSelectedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  read(): Promise<File>;
}

/**
 * Pick files through the native desktop dialog and stat them without reading
 * their contents. The caller validates the metadata first, then invokes
 * `read()` only for accepted files. Resolves `null` when the user cancels.
 */
export async function selectFilesNative(): Promise<NativeSelectedFile[] | null> {
  if (!isTauri()) throw new Error('Native file selection requires the Kiki desktop app.');
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
}

/** Select one or more directories through the native desktop dialog. */
export async function selectDirectoriesNative(): Promise<readonly string[] | null> {
  if (!isTauri()) throw new Error('Native directory selection requires the Kiki desktop app.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: true });
  if (selected === null) return null;
  return typeof selected === 'string' ? [selected] : selected;
}

/**
 * Select a single directory through the native desktop dialog. Resolves `null`
 * when the user cancels.
 */
export async function selectDirectoryNative(): Promise<string | null> {
  if (!isTauri()) throw new Error('Native directory selection requires the Kiki desktop app.');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  if (selected === null) return null;
  return typeof selected === 'string' ? selected : (selected[0] ?? null);
}

export async function isMainWindowVisibleAndFocused(): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    const window = getCurrentWindow();
    const [visible, focused] = await Promise.all([window.isVisible(), window.isFocused()]);
    return visible && focused;
  } catch {
    return true;
  }
}

export async function writeNativeDesktopPrefs(prefs: Partial<DesktopNativePrefs>): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('write_desktop_prefs', { prefs });
  } catch {
    // ignore
  }
}

export async function readNativeDesktopPrefs(): Promise<DesktopNativePrefs | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<DesktopNativePrefs>('read_desktop_prefs');
  } catch {
    return null;
  }
}

export async function restartNativeServer(): Promise<void> {
  if (!isTauri()) throw new Error('Server restart requires the Kiki desktop app.');
  await invoke('restart_server');
}

export interface DesktopUpdate {
  readonly currentVersion: string;
  readonly version: string;
  readonly date?: string;
  readonly notes?: string;
  install(): Promise<void>;
}

interface DesktopUpdateInfo {
  readonly currentVersion: string;
  readonly version: string;
  readonly date?: string;
  readonly notes?: string;
}

export async function checkNativeDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (!isTauri()) return null;
  const update = await invoke<DesktopUpdateInfo | null>('check_desktop_update');
  if (update === null) return null;
  return {
    ...update,
    async install() {
      await invoke('prepare_for_update');
      await invoke('install_desktop_update');
    },
  };
}

export async function writeNativeCompatibilitySettings(
  compatibility: CompatibilitySettings,
): Promise<void> {
  if (!isTauri()) throw new Error('Compatibility settings require the Kiki desktop app.');
  await invoke('write_desktop_prefs', { prefs: { compatibility } });
}

export interface KimiHomePaths {
  readonly home: string;
  readonly credentialPath: string;
  readonly sourceConfigPath: string;
  readonly configPath: string;
}

export async function readNativeKimiHomePaths(): Promise<KimiHomePaths | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<KimiHomePaths>('read_kimi_home_paths');
  } catch {
    return null;
  }
}

export interface KimiConfigImportResult {
  readonly status: 'imported' | 'noop';
  readonly source: string;
  readonly target: string;
  readonly updatedCategories: readonly string[];
  readonly restartError: string | null;
}

export async function importNativeKimiConfig(): Promise<KimiConfigImportResult> {
  if (!isTauri()) throw new Error('Kimi config import requires the Kiki desktop app.');
  const result = await invoke<KimiConfigImportResult>('import_kimi_config');
  if (result.status === 'imported' && result.restartError === null) window.location.reload();
  return result;
}

export type CompatibilityMigrationCategory = 'userSkills';

export interface CompatibilityMigrationResult {
  readonly status: 'copied' | 'copiedActivationPending' | 'noop';
  readonly category: CompatibilityMigrationCategory;
  readonly source: string;
  readonly target: string;
  readonly files: number;
  readonly activationError: string | null;
  readonly restartError: string | null;
}

export async function migrateNativeCompatibilityCategory(
  category: CompatibilityMigrationCategory,
): Promise<CompatibilityMigrationResult> {
  if (!isTauri()) throw new Error('Compatibility migration requires the Kiki desktop app.');
  const result = await invoke<CompatibilityMigrationResult>('migrate_compatibility_category', { category });
  if (result.status === 'copied' && result.restartError === null) window.location.reload();
  return result;
}

export type SessionsMigrationStatus = 'ready' | 'noop' | 'blocked' | 'moved';

export interface SessionsMigrationMove {
  readonly entry: 'sessions' | 'workspaces.json';
  readonly source: string;
  readonly target: string;
}

export interface SessionsMigrationPlan {
  readonly status: SessionsMigrationStatus;
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly sessionCount: number;
  readonly totalBytes: number;
  readonly plannedMoves: readonly SessionsMigrationMove[];
  readonly targetConflict: boolean;
  readonly blocker: string | null;
  readonly execution: 'filesystemRename';
}

export async function dryRunNativeSessionsMigration(): Promise<SessionsMigrationPlan> {
  if (!isTauri()) throw new Error('Sessions migration requires the Kiki desktop app.');
  return invoke<SessionsMigrationPlan>('dry_run_sessions_migration');
}

export async function executeNativeSessionsMigration(): Promise<SessionsMigrationPlan> {
  if (!isTauri()) throw new Error('Sessions migration requires the Kiki desktop app.');
  const result = await invoke<SessionsMigrationPlan>('execute_sessions_migration');
  if (result.status === 'moved') window.location.reload();
  return result;
}

export function onTrayNewSession(callback: () => void): () => void {
  if (!isTauri()) return () => {};
  let unsubscribed = false;
  let unlisten: (() => void) | undefined;
  // Fire-and-forget: the unlisten fn arrives asynchronously; callers get the
  // synchronous guard via `unsubscribed` in the meantime.
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
